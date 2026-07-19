// backend/src/modules/hr/biometric.routes.js
import express from 'express';
import net from 'net';
import { createRequire } from 'module';
import pool from '../../config/db.js';

const router = express.Router();
const require = createRequire(import.meta.url);

// ── node-zklib SDK (installed: npm install node-zklib) ─────────────────────
let ZKLib;
try {
  ZKLib = require('node-zklib');
} catch {
  console.warn('[biometric] node-zklib not found — fingerprint sync disabled. Run: npm install node-zklib');
}

const cid = (req) => req.scope?.company_id ?? null;

/**
 * Quick TCP reachability test — no ZKTeco protocol, just raw socket.
 * Returns { connected: true, latency_ms } or { connected: false, error }.
 * Used both standalone (test button) and as a pre-flight before SDK sync.
 */
async function testZKDevice(ipAddress, port = 4370) {
  return new Promise((resolve) => {
    const socket    = new net.Socket();
    const startTime = Date.now();
    let resolved    = false;
    const done = (result) => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(result); }
    };
    socket.setTimeout(5000);
    socket.connect(parseInt(port) || 4370, ipAddress, () =>
      done({ connected: true, latency_ms: Date.now() - startTime })
    );
    socket.on('error',   (err) => done({ connected: false, error: err.message }));
    socket.on('timeout', ()    => done({ connected: false, error: 'Connection timed out (5s)' }));
  });
}

/**
 * Map a ZKTeco device userId string to a database employee id.
 * Strategy (in order):
 *   1. Exact match on employees.employee_id (display code) — most reliable
 *   2. Match on employees.biometric_user_id column (if it exists)
 *   3. Normalised name match against the device user name
 * Returns the database integer employee.id or null.
 */
async function resolveEmployeeId(deviceUserId, deviceUserName, companyId) {
  const cidClause = companyId != null ? `AND (e.company_id = ${parseInt(companyId)} OR e.company_id IS NULL)` : '';

  // 1. Match employee_id code (e.g. "EMP001" or numeric "1")
  const byCode = await pool.query(
    `SELECT id FROM employees WHERE LOWER(TRIM(employee_id)) = LOWER(TRIM($1)) ${cidClause} LIMIT 1`,
    [String(deviceUserId)]
  ).catch(() => ({ rows: [] }));
  if (byCode.rows[0]) return byCode.rows[0].id;

  // 2. Match biometric_user_id if column exists
  const byBiometric = await pool.query(
    `SELECT id FROM employees WHERE biometric_user_id = $1 ${cidClause} LIMIT 1`,
    [String(deviceUserId)]
  ).catch(() => ({ rows: [] }));
  if (byBiometric.rows[0]) return byBiometric.rows[0].id;

  // 3. Name match (device stores the registered name)
  if (deviceUserName) {
    const byName = await pool.query(
      `SELECT id FROM employees
        WHERE LOWER(TRIM(COALESCE(name, CONCAT(first_name,' ',COALESCE(last_name,''))))) = LOWER(TRIM($1))
          ${cidClause}
        LIMIT 1`,
      [String(deviceUserName)]
    ).catch(() => ({ rows: [] }));
    if (byName.rows[0]) return byName.rows[0].id;
  }

  return null;
}

/**
 * Full ZKTeco attendance sync using node-zklib SDK.
 * Connects via TCP, pulls attendance logs, writes to biometric_logs
 * and upserts attendance_records for each employee.
 *
 * inOutStatus values from ZKTeco protocol:
 *   0 = Check-In, 1 = Check-Out, 2 = Break-Out, 3 = Break-In,
 *   4 = Overtime-In, 5 = Overtime-Out
 */
async function syncZKDevice(ipAddress, port, deviceId, companyId, attendanceDirection = 'both') {
  if (!ZKLib) {
    throw new Error('node-zklib SDK not installed. Run: npm install node-zklib in the backend directory.');
  }

  const zkInstance = new ZKLib(ipAddress, parseInt(port) || 4370, 10000, 4000);

  try {
    await zkInstance.createSocket();
    console.log(`[biometric] Connected to device ${deviceId} at ${ipAddress}:${port}`);

    // ── Fetch device users (deviceUserId → name mapping) ────────────────────
    const usersResult = await zkInstance.getUsers().catch(() => ({ data: [] }));
    const userMap = {};
    for (const u of (usersResult.data || [])) {
      userMap[String(u.userId || u.uid)] = u.name || '';
    }

    // ── Fetch attendance logs ───────────────────────────────────────────────
    const attResult = await zkInstance.getAttendances();
    const logs      = attResult.data || [];
    console.log(`[biometric] Device ${deviceId} returned ${logs.length} attendance records`);

    let processed   = 0;
    let unmatched   = 0;

    for (const log of logs) {
      const devUserId   = String(log.deviceUserId || log.userId || '');
      const punchTime   = log.attTime instanceof Date ? log.attTime : new Date(log.attTime);
      if (isNaN(punchTime.getTime())) continue;

      // Determine punch direction from device inOutStatus
      // 0,4 = in-type; 1,2,5 = out-type; 3 = break-in; others = ignore
      const inOutStatus  = parseInt(log.inOutStatus ?? 0);
      const isCheckIn    = [0, 3, 4].includes(inOutStatus);
      const isCheckOut   = [1, 2, 5].includes(inOutStatus);
      const punchType    = isCheckIn ? 'in' : (isCheckOut ? 'out' : null);
      if (!punchType) continue;

      // Respect device attendance_direction
      if (attendanceDirection === 'in'  && punchType !== 'in')  continue;
      if (attendanceDirection === 'out' && punchType !== 'out') continue;

      const dateStr   = punchTime.toISOString().split('T')[0];
      const timeStr   = punchTime.toTimeString().slice(0, 5);
      const devName   = userMap[devUserId] || '';

      // ── Map device user → database employee ──────────────────────────────
      const employeeId = await resolveEmployeeId(devUserId, devName, companyId);

      // ── Write to biometric_logs (always, even if employee not found) ─────
      await pool.query(`
        INSERT INTO biometric_logs
          (employee_id, device_id, punch_time, punch_type, raw_data, company_id, processed)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT DO NOTHING
      `, [
        employeeId,
        deviceId,
        punchTime.toISOString(),
        punchType,
        JSON.stringify({ devUserId, devName, inOutStatus, verifyType: log.verifyType }),
        companyId,
        employeeId != null,
      ]).catch(() => {});

      if (!employeeId) { unmatched++; continue; }

      // ── Upsert attendance_records ────────────────────────────────────────
      if (punchType === 'in') {
        await pool.query(`
          INSERT INTO attendance_records
            (employee_id, attendance_date, check_in_time, status, company_id, source)
          VALUES ($1,$2,$3::time,'present',$4,'biometric')
          ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
            check_in_time = CASE
              WHEN attendance_records.check_in_time IS NULL
                OR $3::time < attendance_records.check_in_time
              THEN $3::time
              ELSE attendance_records.check_in_time
            END,
            status = CASE
              WHEN attendance_records.status = 'absent' THEN 'present'
              ELSE attendance_records.status
            END,
            updated_at = NOW()
        `, [employeeId, dateStr, timeStr, companyId]).catch(() => {});
      } else {
        // Clock-out: pick the latest punch for the day
        await pool.query(`
          INSERT INTO attendance_records
            (employee_id, attendance_date, check_out_time, status, company_id, source)
          VALUES ($1,$2,$3::time,'present',$4,'biometric')
          ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
            check_out_time = CASE
              WHEN attendance_records.check_out_time IS NULL
                OR $3::time > attendance_records.check_out_time
              THEN $3::time
              ELSE attendance_records.check_out_time
            END,
            updated_at = NOW()
        `, [employeeId, dateStr, timeStr, companyId]).catch(() => {});

        // Recompute total_hours after updating checkout
        await pool.query(`
          UPDATE attendance_records
             SET total_hours = EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600,
                 ot_hours    = GREATEST(0,
                   EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600 - 9
                 )
           WHERE employee_id = $1 AND attendance_date = $2
             AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL
        `, [employeeId, dateStr]).catch(() => {});
      }

      processed++;
    }

    await zkInstance.disconnect();
    console.log(`[biometric] Device ${deviceId} sync complete — ${processed} processed, ${unmatched} unmatched`);

    return {
      synced:      true,
      total_logs:  logs.length,
      processed,
      unmatched,
      sdk_status:  'active',
    };

  } catch (err) {
    try { await zkInstance.disconnect(); } catch { /* ignore */ }
    throw err;
  }
}

/* ─── table migrations ───────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS company_id           INTEGER;
      ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS vendor               TEXT;
      ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS serial_number        TEXT;
      ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS attendance_direction TEXT DEFAULT 'both';
      ALTER TABLE gate_passes        ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE visitors           ADD COLUMN IF NOT EXISTS company_id INTEGER;
    `);
  } catch (e) { console.error('[biometric] migration error:', e.message); }
})();

/* ─── dev-only: seed sample biometric devices ─── */
if (process.env.NODE_ENV !== 'production') {
  (async () => {
    try {
      const { rows } = await pool.query('SELECT COUNT(*) FROM biometric_devices');
      if (parseInt(rows[0].count) === 0) {
        await pool.query(`
          INSERT INTO biometric_devices (device_name, device_type, location, ip_address, port, vendor, serial_number, attendance_direction, status, last_sync) VALUES
          ('Main Gate - In',   'fingerprint',  'Main Entrance',     '192.168.1.101', 4370, 'ZKTeco',  'SN-101', 'in',   'online',  NOW() - INTERVAL '2 hours'),
          ('Main Gate - Out',  'fingerprint',  'Main Exit',         '192.168.1.102', 4370, 'ZKTeco',  'SN-102', 'out',  'online',  NOW() - INTERVAL '2 hours'),
          ('Server Room',      'face+finger',  'IT Block Room 201', '192.168.1.103', 4370, 'Suprema', 'SN-103', 'both', 'online',  NOW() - INTERVAL '1 hour'),
          ('Production Floor', 'fingerprint',  'Factory Entrance',  '192.168.1.104', 4370, 'eSSL',    'SN-104', 'both', 'offline', NOW() - INTERVAL '3 days'),
          ('HR Office',        'card_reader',  'HR Block Entry',    '192.168.1.105', 4370, 'Matrix',  'SN-105', 'both', 'error',   NOW() - INTERVAL '6 hours')
        `);
      }
    } catch (e) { console.error('[biometric] seed error:', e.message); }
  })();
}

/* ─── GET /biometric/devices ─────────────────────────────────── */
router.get('/biometric/devices', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT d.*,
              COUNT(bl.id) AS total_punches_today
       FROM biometric_devices d
       LEFT JOIN biometric_logs bl ON bl.device_id=d.id
         AND DATE(bl.punch_time)=CURRENT_DATE
       WHERE ($1::int IS NULL OR d.company_id = $1)
       GROUP BY d.id ORDER BY d.device_name`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/devices/stats ─── must be before /:id routes */
router.get('/biometric/devices/stats', async (req, res) => {
  const companyId = cid(req);
  try {
    const [statusRes, punchRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='online')  AS online,
           COUNT(*) FILTER (WHERE status='offline') AS offline,
           COUNT(*) FILTER (WHERE status='error')   AS error_count
         FROM biometric_devices
         WHERE ($1::int IS NULL OR company_id = $1)`,
        [companyId]
      ),
      pool.query(
        `SELECT COUNT(*) AS punches_today
         FROM biometric_logs bl
         LEFT JOIN biometric_devices d ON d.id=bl.device_id
         WHERE DATE(bl.punch_time)=CURRENT_DATE
           AND ($1::int IS NULL OR d.company_id = $1)`,
        [companyId]
      ),
    ]);
    const s = statusRes.rows[0];
    res.json({
      online:        parseInt(s.online       || 0),
      offline:       parseInt(s.offline      || 0),
      error:         parseInt(s.error_count  || 0),
      punches_today: parseInt(punchRes.rows[0]?.punches_today || 0),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /biometric/devices ────────────────────────────────── */
router.post('/biometric/devices', async (req, res) => {
  const {
    device_name, device_type = 'fingerprint', location, ip_address,
    port = 4370, vendor, serial_number, attendance_direction = 'both',
  } = req.body;
  if (!device_name || !ip_address) return res.status(400).json({ message: 'device_name and ip_address required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO biometric_devices
         (device_name, device_type, location, ip_address, port, vendor, serial_number, attendance_direction, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [device_name, device_type, location, ip_address, port, vendor || null, serial_number || null, attendance_direction, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /biometric/devices/:id ─────────────────────────────── */
router.put('/biometric/devices/:id', async (req, res) => {
  const { device_name, device_type, location, ip_address, port, vendor, serial_number, attendance_direction } = req.body;
  if (!device_name || !ip_address) return res.status(400).json({ message: 'device_name and ip_address required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE biometric_devices
       SET device_name=$1, device_type=$2, location=$3, ip_address=$4, port=$5,
           vendor=$6, serial_number=$7, attendance_direction=$8
       WHERE id=$9 AND ($10::int IS NULL OR company_id = $10) RETURNING *`,
      [
        device_name, device_type || 'fingerprint', location, ip_address,
        port || 4370, vendor || null, serial_number || null, attendance_direction || 'both',
        req.params.id, companyId,
      ]
    );
    if (!rows.length) return res.status(404).json({ message: 'Device not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── DELETE /biometric/devices/:id ──────────────────────────── */
router.delete('/biometric/devices/:id', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, companyId]
    );
    if (!rowCount) return res.status(404).json({ message: 'Device not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /biometric/devices/:id/test ─── real TCP socket test  */
router.post('/biometric/devices/:id/test', async (req, res) => {
  try {
    const { rows: [device] } = await pool.query('SELECT * FROM biometric_devices WHERE id=$1', [req.params.id]);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const result = await testZKDevice(device.ip_address, device.port);

    // Update device status based on real test
    const newStatus = result.connected ? 'online' : 'offline';
    await pool.query(
      'UPDATE biometric_devices SET status=$1, updated_at=NOW() WHERE id=$2',
      [newStatus, req.params.id]
    );

    res.json({
      device_id:   device.id,
      device_name: device.device_name,
      ip_address:  device.ip_address,
      port:        device.port,
      connected:   result.connected,
      latency_ms:  result.latency_ms || null,
      error:       result.error || null,
      status:      newStatus,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /biometric/devices/:id/sync ─── real ZKTeco SDK sync ─ */
router.post('/biometric/devices/:id/sync', async (req, res) => {
  try {
    const { rows: [device] } = await pool.query('SELECT * FROM biometric_devices WHERE id=$1', [req.params.id]);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const companyId = device.company_id ?? req.scope?.company_id ?? null;

    const syncResult = await syncZKDevice(
      device.ip_address,
      device.port,
      device.id,
      companyId,
      device.attendance_direction || 'both'
    );

    // Mark device online and update last_sync
    await pool.query(
      'UPDATE biometric_devices SET last_sync=NOW(), status=$1, updated_at=NOW() WHERE id=$2',
      ['online', req.params.id]
    );

    res.json({
      device_id:    device.id,
      device_name:  device.device_name,
      synced:       true,
      total_logs:   syncResult.total_logs,
      processed:    syncResult.processed,
      unmatched:    syncResult.unmatched,
      sdk_status:   syncResult.sdk_status,
      last_sync:    new Date().toISOString(),
    });
  } catch (err) {
    await pool.query(
      'UPDATE biometric_devices SET status=$1, updated_at=NOW() WHERE id=$2',
      ['error', req.params.id]
    ).catch(() => {});
    res.status(500).json({
      error:  err.message,
      synced: false,
      hint:   err.message.includes('node-zklib')
        ? 'Run: npm install node-zklib inside the backend directory'
        : 'Check device IP address, port, and network connectivity',
    });
  }
});

/* ─── GET /biometric/devices/:id/punches ─────────────────────── */
router.get('/biometric/devices/:id/punches', async (req, res) => {
  const companyId = cid(req);
  const { date, limit = 50, offset = 0 } = req.query;
  try {
    const devRes = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, companyId]
    );
    if (!devRes.rows.length) return res.status(404).json({ message: 'Device not found' });

    const params = [req.params.id];
    let q = `SELECT bl.*, e.name AS employee_name, e.employee_id AS emp_code, e.department
             FROM biometric_logs bl
             LEFT JOIN employees e ON e.id=bl.employee_id
             WHERE bl.device_id=$1`;
    if (date) { params.push(date); q += ` AND DATE(bl.punch_time)=$${params.length}`; }

    const countParams = [...params];
    const countQ = `SELECT COUNT(*) FROM biometric_logs WHERE device_id=$1${date ? ' AND DATE(punch_time)=$2' : ''}`;

    params.push(parseInt(limit), parseInt(offset));
    q += ` ORDER BY bl.punch_time DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const [punchRes, countRes] = await Promise.all([
      pool.query(q, params),
      pool.query(countQ, countParams),
    ]);
    res.json({ punches: punchRes.rows, total: parseInt(countRes.rows[0].count), device: devRes.rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/logs ────────────────────────────────────── */
router.get('/biometric/logs', async (req, res) => {
  const companyId = cid(req);
  const { date, device_id, employee_id, limit = 100 } = req.query;
  try {
    const params = [companyId];
    let q = `SELECT bl.*, e.name AS employee_name, e.department, d.device_name
             FROM biometric_logs bl
             LEFT JOIN employees e ON e.id=bl.employee_id
             LEFT JOIN biometric_devices d ON d.id=bl.device_id
             WHERE ($1::int IS NULL OR e.company_id = $1)`;
    if (date)        { params.push(date);        q += ` AND DATE(bl.punch_time)=$${params.length}`; }
    if (device_id)   { params.push(device_id);   q += ` AND bl.device_id=$${params.length}`; }
    if (employee_id) { params.push(employee_id); q += ` AND bl.employee_id=$${params.length}`; }
    params.push(parseInt(limit));
    q += ` ORDER BY bl.punch_time DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /biometric/logs/import ────────────────────────────── */
router.post('/biometric/logs/import', async (req, res) => {
  const { csv_data, device_id } = req.body;
  if (!csv_data) return res.status(400).json({ message: 'csv_data required' });
  try {
    const lines = csv_data.trim().split('\n');
    const header = lines[0].toLowerCase().split(',').map(h => h.trim());
    const eidIdx  = header.indexOf('employee_id');
    const timeIdx = header.indexOf('punch_time');
    const typeIdx = header.indexOf('punch_type');
    if (eidIdx === -1 || timeIdx === -1) return res.status(400).json({ message: 'CSV must have employee_id and punch_time columns' });
    let imported = 0; const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const empId = cols[eidIdx]; const pTime = cols[timeIdx]; const pType = typeIdx >= 0 ? cols[typeIdx] : 'in';
      if (!empId || !pTime) { errors.push(`Row ${i}: missing data`); continue; }
      try {
        await pool.query(
          `INSERT INTO biometric_logs (employee_id, device_id, punch_time, punch_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [empId, device_id, new Date(pTime).toISOString(), pType || 'in']
        );
        imported++;
      } catch (e) { errors.push(`Row ${i}: ${e.message}`); }
    }
    res.json({ imported, errors, total_rows: lines.length - 1 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /gate-passes ───────────────────────────────────────── */
router.get('/gate-passes', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `SELECT gp.*, e.name AS employee_name, a.name AS approved_by_name
       FROM gate_passes gp
       LEFT JOIN employees e ON e.id=gp.employee_id
       LEFT JOIN employees a ON a.id=gp.approved_by
       WHERE ($1::int IS NULL OR gp.company_id = $1)
       ORDER BY gp.created_at DESC LIMIT 100`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /gate-passes ──────────────────────────────────────── */
router.post('/gate-passes', async (req, res) => {
  const { employee_id, visitor_name, purpose, valid_from, valid_to } = req.body;
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO gate_passes (employee_id, visitor_name, purpose, valid_from, valid_to, company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employee_id, visitor_name, purpose, valid_from, valid_to, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /gate-passes/:id/approve ───────────────────────────── */
router.put('/gate-passes/:id/approve', async (req, res) => {
  const { approved_by } = req.body;
  const companyId = cid(req);
  const passNumber = `GP-${new Date().getFullYear()}-${String(req.params.id).padStart(4, '0')}`;
  try {
    const { rows } = await pool.query(
      `UPDATE gate_passes SET status='approved', approved_by=$1, pass_number=$2
       WHERE id=$3 AND ($4::int IS NULL OR company_id = $4) RETURNING *`,
      [approved_by, passNumber, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /visitors ──────────────────────────────────────────── */
router.get('/visitors', async (req, res) => {
  const companyId = cid(req);
  const { active_only } = req.query;
  try {
    const params = [companyId];
    let q = `SELECT v.*, e.name AS host_name, e.department AS host_department
             FROM visitors v LEFT JOIN employees e ON e.id=v.host_employee_id
             WHERE ($1::int IS NULL OR v.company_id = $1)`;
    if (active_only === 'true') q += ' AND v.check_out_time IS NULL';
    q += ' ORDER BY v.check_in_time DESC LIMIT 100';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /visitors ─────────────────────────────────────────── */
router.post('/visitors', async (req, res) => {
  const { name, company, phone, email, host_employee_id, purpose, id_type, id_number } = req.body;
  if (!name) return res.status(400).json({ message: 'name required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO visitors (name, company, phone, email, host_employee_id, purpose, id_type, id_number, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, company, phone, email, host_employee_id, purpose, id_type, id_number, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/checkout ─────────────────────────────── */
router.put('/visitors/:id/checkout', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE visitors SET check_out_time=NOW()
       WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Visitor not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/dashboard ───────────────────────────────── */
router.get('/biometric/dashboard', async (req, res) => {
  const companyId = cid(req);
  try {
    const [punchedRes, visitorsRes, empCountRes] = await Promise.allSettled([
      pool.query(
        `SELECT
          COUNT(DISTINCT bl.employee_id) FILTER (WHERE bl.punch_type='in') AS punched_in,
          COUNT(DISTINCT bl.employee_id) FILTER (WHERE bl.punch_type='out' AND DATE(bl.punch_time)=CURRENT_DATE AND EXTRACT(HOUR FROM bl.punch_time)<17) AS early_out,
          COUNT(DISTINCT bl.employee_id) FILTER (WHERE bl.punch_type='in'  AND DATE(bl.punch_time)=CURRENT_DATE AND EXTRACT(HOUR FROM bl.punch_time)>9)  AS late_arrivals
         FROM biometric_logs bl
         JOIN employees e ON e.id=bl.employee_id
         WHERE DATE(bl.punch_time)=CURRENT_DATE
           AND ($1::int IS NULL OR e.company_id = $1)`,
        [companyId]
      ),
      pool.query(
        `SELECT COUNT(*) FROM visitors
         WHERE check_out_time IS NULL AND DATE(check_in_time)=CURRENT_DATE
           AND ($1::int IS NULL OR company_id = $1)`,
        [companyId]
      ),
      pool.query(
        `SELECT COUNT(*) FROM employees WHERE ($1::int IS NULL OR company_id = $1)`,
        [companyId]
      ),
    ]);
    const stats  = punchedRes.value?.rows[0] || {};
    const total  = parseInt(empCountRes.value?.rows[0]?.count || 0);
    const pinned = parseInt(stats.punched_in || 0);
    res.json({
      punched_in_today : pinned,
      not_yet_punched  : Math.max(0, total - pinned),
      late_arrivals    : parseInt(stats.late_arrivals || 0),
      early_departures : parseInt(stats.early_out     || 0),
      visitors_inside  : parseInt(visitorsRes.value?.rows[0]?.count || 0),
      total_employees  : total,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/devices/:id/users ─── list enrolled users on device ── */
router.get('/biometric/devices/:id/users', async (req, res) => {
  try {
    const { rows: [device] } = await pool.query('SELECT * FROM biometric_devices WHERE id=$1', [req.params.id]);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!ZKLib) return res.status(503).json({ error: 'node-zklib not installed', hint: 'npm install node-zklib' });

    const zk = new ZKLib(device.ip_address, parseInt(device.port) || 4370, 10000, 4000);
    await zk.createSocket();
    const result = await zk.getUsers().catch(() => ({ data: [] }));
    await zk.disconnect();

    const companyId = device.company_id ?? req.scope?.company_id ?? null;
    const cidClause = companyId != null ? `AND (e.company_id = ${parseInt(companyId)} OR e.company_id IS NULL)` : '';

    // Enrich with matched employee info
    const enriched = await Promise.all((result.data || []).map(async (u) => {
      const devUserId = String(u.userId || u.uid || '');
      const row = await pool.query(
        `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name, employee_id AS emp_code, department
           FROM employees
          WHERE (LOWER(TRIM(employee_id)) = LOWER(TRIM($1)) OR biometric_user_id = $1) ${cidClause}
          LIMIT 1`,
        [devUserId]
      ).catch(() => ({ rows: [] }));
      return {
        device_user_id: devUserId,
        device_name:    u.name || '',
        role:           u.role,
        matched_employee: row.rows[0] || null,
      };
    }));

    res.json({ device_id: device.id, users: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /biometric/employees/map ─── assign biometric_user_id to employee ─ */
router.post('/biometric/employees/map', async (req, res) => {
  const { employee_id, biometric_user_id } = req.body;
  if (!employee_id || !biometric_user_id) {
    return res.status(400).json({ error: 'employee_id and biometric_user_id required' });
  }
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE employees SET biometric_user_id=$1
        WHERE id=$2 AND ($3::int IS NULL OR company_id = $3)
       RETURNING id, biometric_user_id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name`,
      [String(biometric_user_id), employee_id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    res.json({ success: true, employee: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /biometric/employees/unmapped ─── employees with no biometric ID ── */
router.get('/biometric/employees/unmapped', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name,
              employee_id AS emp_code, department, designation
         FROM employees
        WHERE (biometric_user_id IS NULL OR biometric_user_id = '')
          AND deleted_at IS NULL
          AND LOWER(status) IN ('active','probation')
          AND ($1::int IS NULL OR company_id = $1)
        ORDER BY department, name
        LIMIT 200`,
      [companyId]
    );
    res.json({ unmapped: rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
