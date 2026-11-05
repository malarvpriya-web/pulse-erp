// backend/src/modules/hr/biometric.routes.js
import express from 'express';
import net from 'net';
import { createRequire } from 'module';
import pool from '../../config/db.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { requirePermission, permissionFor, permissionColumn } from '../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../shared/scope.js';
import { CURRENT_STATUSES, sqlList } from '../../shared/employeeStatus.js';
import { LEAVE_APPROVED } from '../../shared/statusSets.js';
import { getWeekendDays, dayIsWeekend } from '../../shared/weekend.js';
import { getFullDayHours, isPeriodFrozen } from '../../shared/attendanceRules.js';
import { GP_APPROVER_JOIN, approverDecision } from '../../shared/gatePassApprover.js';

const router = express.Router();
const require = createRequire(import.meta.url);

/**
 * Authorization.
 *
 * server.js mounts this router behind `verifyToken` for the /biometric,
 * /gate-passes and /visitors prefixes, and that was the ONLY gate: not one of
 * the 20 routes below called requirePermission, so any authenticated user —
 * including a plain `employee` — could read and write gate passes and visitor
 * records, and reconfigure or delete biometric hardware.
 *
 * The module key per route follows the screen that consumes it, because
 * requirePermission FAILS CLOSED on a missing row and the wrong key 403s the
 * page's own users:
 *
 *   `attendance` — devices and punch logs. Consumed by DeviceManagement
 *     (Attendance → Configuration → Settings → Devices) as well as the HR page,
 *     and every role that reaches either holds an attendance row. Gating these
 *     on `hr` instead would 403 manager/department_head, who hold attendance but
 *     no hr grant at all.
 *
 *   `hr` — gate passes, visitors, and the employee↔device mapping. Consumed only
 *     by BiometricAccess, which lives in the HR menu section (hr, hr_manager,
 *     hr_exec, payroll_admin, admin, super_admin).
 *
 * ── READ vs WRITE on the attendance side ───────────────────────────────────
 *
 * ⚠⚠ Every attendance route here was originally gated on `attendanceAdmin`
 * (= attendance:EDIT), including the GETs, because this file defined no view
 * gate at all — `attendanceAdd`/`attendanceAdmin`/`attendanceDelete` were the
 * only three, and the reads took the closest one to hand. The effect was that
 * `payroll_admin` (attendance can_view=true, can_edit=false) was refused every
 * read on a page the HR menu lists it as a user of — contradicting the note
 * below, which says in so many words that it "gets a read-only page". It had no
 * page at all. `integration.biometricAuthz.test.js` asserts the documented
 * intent and was correct to fail.
 *
 * The five GETs that are pure reads of OUR OWN tables now take `biometricRead`
 * — `hr:view` OR `attendance:edit`, for the reason set out on
 * requireAnyPermission below. Each was confirmed tenant-scoped FIRST: loosening
 * a gate on an unscoped read widens who can reach another tenant's rows, so the
 * scope predicate is a precondition for the looser gate, not a separate
 * concern. (That check is what turned up the missing filter on
 * `/devices/:id/users`, fixed below.)
 *
 * `GET /biometric/devices/:id/users` deliberately stays on `attendanceAdmin`.
 * It is not a read of our data: it opens a TCP socket to the device's own IP and
 * asks the hardware to enumerate its enrolled fingerprints. No page calls it
 * (grep the frontend — nothing does); it belongs to the enrolment/mapping
 * workflow next to `POST /biometric/employees/map`, which is `hr:edit`. A
 * read-only dashboard user has no reason to dial a device, and a 10-second
 * connect timeout per call is not something to hand to a wider audience.
 *
 * Checked against the live matrix rather than assumed. Two consequences worth
 * knowing, both intended:
 *   · `payroll_admin` holds view only on both modules, so it gets a read-only
 *     page. Writes return 403, which BiometricAccess renders as an error toast
 *     (it reads err.response.data.message) — not a silent failure.
 *   · the gate-pass approve route takes `hr:edit`, NOT `hr:approve`. The `hr`
 *     role — the page's primary user — has can_approve=false on hr, so an
 *     approve gate would lock gate-pass approval away from the team that owns
 *     it. Narrowing approval to hr_manager is a policy change, not a security
 *     fix; left for whoever wants to make that call deliberately.
 */
const attendanceAdd    = requirePermission('attendance', 'add');
const attendanceAdmin  = requirePermission('attendance', 'edit');
const attendanceDelete = requirePermission('attendance', 'delete');
const hrView           = requirePermission('hr', 'view');
const hrAdd            = requirePermission('hr', 'add');
const hrEdit           = requirePermission('hr', 'edit');

/**
 * requireAnyPermission([[module, action], ...]) — allow if ANY grant holds.
 *
 * ⚠⚠ Why the biometric READS need this, and why `attendance:view` is the WRONG
 * answer even though the reads are reads. Measured, not assumed:
 *
 *   role             attendance v/a/e/d   hr v/a/e/d
 *   employee         Y/-/-/-              (no row)
 *   payroll_admin    Y/-/-/-              Y/-/-/-
 *
 * `employee` and `payroll_admin` hold IDENTICAL attendance permissions, so no
 * attendance action can separate them. Gating the device reads on
 * `attendance:view` — the obvious reading of "a read needs view" — hands every
 * employee the device inventory: names, IP addresses and ports. The two
 * audiences are only separable through `hr`:
 *
 *   · BiometricAccess (HR → Gate Pass & Visitors) — hr, hr_manager, hr_exec,
 *     payroll_admin, admin, super_admin. All hold `hr:view`.
 *   · DeviceManagement (Attendance → Configuration → Devices) — manager and
 *     department_head, which hold NO hr row at all but do hold `attendance:edit`.
 *
 * So the rule is "an HR-page user, OR an attendance administrator" — a union of
 * two grants, not one looser grant. `employee` (attendance view only, no hr) and
 * `sales_exec` (neither) fall outside it.
 *
 * Fails CLOSED: an unmatched or unconfigured grant denies, exactly like
 * requirePermission. It reuses `permissionFor`, so a user-level override still
 * wins and the per-request permission cache is shared.
 */
const requireAnyPermission = (grants) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    for (const [module, action] of grants) {
      const col = permissionColumn(action);
      if (!col) return res.status(400).json({ error: `Unknown permission action: ${action}` });
      const perm = await permissionFor(req, module);
      if (perm?.[col]) return next();
    }
    return res.status(403).json({
      error: 'Forbidden',
      code: 'PERMISSION_DENIED',
      // Named, so a denial is debuggable without opening this file.
      accepts: grants.map(([m, a]) => `${m}:${a}`),
      message: 'You do not have permission to perform this action.',
    });
  } catch (err) {
    console.error('[requireAnyPermission]', err.message);
    return res.status(500).json({ error: 'Permission check failed' });
  }
};

/**
 * The read tier for biometric data: devices, device stats, punch logs and the
 * dashboard. See requireAnyPermission above for why it is a union and not
 * `attendance:view`.
 */
const biometricRead = requireAnyPermission([['hr', 'view'], ['attendance', 'edit']]);

// ── node-zklib SDK (installed: npm install node-zklib) ─────────────────────
let ZKLib;
try {
  ZKLib = require('node-zklib');
} catch {
  console.warn('[biometric] node-zklib not found — fingerprint sync disabled. Run: npm install node-zklib');
}

/**
 * The hardware boundary, as one replaceable object.
 *
 * Everything that talks to a device goes through `deviceDriver.read()`, which
 * returns the raw logs and users the device handed over. Everything after that
 * — mapping device users to employees, de-duplication, attendance — is our
 * code and is what the tests exercise, by swapping `read` for a fake that
 * returns a fixed payload. That proves the PROCESSING; it proves nothing about
 * any physical device, and the tests say so. §197.
 */
export const deviceDriver = {
  available: () => !!ZKLib,
  async read(ipAddress, port) {
    const zk = new ZKLib(ipAddress, parseInt(port) || 4370, 10000, 4000);
    try {
      await zk.createSocket();
      const users = await zk.getUsers().catch(() => ({ data: [] }));
      const att   = await zk.getAttendances();
      return { users: users.data || [], logs: att.data || [] };
    } finally {
      try { await zk.disconnect(); } catch { /* ignore */ }
    }
  },
};

/** node-zklib rejects with a ZKError that has no `message`; dig one out. */
function deviceErrorText(err) {
  if (!err) return 'unknown device error';
  if (typeof err.toast === 'function') { try { return err.toast(); } catch { /* fall through */ } }
  return err.message || err.err?.message || String(err);
}

// The caller's tenant. companyOf() rather than `req.scope` alone: it carries
// the user-row fallback, so a scope-less request can never read as global.
const cid = (req) => companyOf(req);

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

/* ─── attendance-day rules: timezone, shift window, late grace ──────────────
 *
 * Read from the same rows Attendance Settings writes: the company row when
 * there is one, else the global row (company_id IS NULL) — the lookup
 * shared/weekend.js uses. The dashboard hardcoded `hour > 9` as late (which is
 * 10:00, not the configured 09:00 + 10 min grace) and `hour < 17` as early,
 * against a configured 18:00 end. */
const DEFAULT_TZ = 'Asia/Kolkata';

async function dayRules(companyId, db = pool) {
  const out = { tz: DEFAULT_TZ, workStart: '09:00:00', workEnd: '18:00:00', graceMinutes: 0 };
  try {
    const { rows: [s] } = await db.query(
      `SELECT timezone, work_start_time::text AS ws, work_end_time::text AS we
         FROM attendance_general_settings
        WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
        ORDER BY (company_id IS NULL), id LIMIT 1`,
      [companyId]
    );
    if (s?.ws) out.workStart = s.ws;
    if (s?.we) out.workEnd = s.we;
    if (s?.timezone) {
      // An unknown zone name would make every AT TIME ZONE below raise.
      const ok = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [s.timezone]);
      if (ok.rows.length) out.tz = s.timezone;
    }
    const { rows: [p] } = await db.query(
      `SELECT rules->>'grace_minutes' AS g FROM attendance_policies
        WHERE policy_type = 'late' AND is_active = true
          AND ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
        ORDER BY company_id DESC NULLS LAST LIMIT 1`,
      [companyId]
    );
    const g = parseInt(p?.g, 10);
    if (Number.isFinite(g) && g >= 0) out.graceMinutes = g;
  } catch { /* defaults */ }
  return out;
}

/* ─── punch ingestion: the one path from a punch to attendance ──────────────
 *
 * Both the device sync and the CSV import go through applyPunch(). Before,
 * the import wrote biometric_logs ONLY — an imported punch never reached
 * attendance_records, which is what the attendance reports and payroll read —
 * while the sync wrote attendance through `.catch(() => {})` on every
 * statement, counted the punch "processed" whether the write landed or not,
 * and dated it with `toISOString()` (UTC), so a punch between 00:00 and 05:30
 * IST landed on the previous day.
 *
 * Rules, in order:
 *   · the log row is written once — the unique indexes from migration
 *     20261028000012 make a repeated punch a `duplicate`, not a second row;
 *   · an unmatched punch is kept (it can be mapped later) and goes no further;
 *   · a month payroll has frozen (shared isPeriodFrozen) is `frozen`, and a
 *     day whose record is frozen or soft-deleted is `locked`: the punch is
 *     logged, processed=false, and attendance is NOT touched;
 *   · otherwise the day's record MERGES the punch — earliest in, latest out —
 *     and status is promoted from 'absent' only (the §103 contract: leave,
 *     holiday and every other status are never overwritten);
 *   · hours are recomputed only when out > in, with the shared OT threshold.
 */
const PUNCH_IN  = ['in', 'checkin', 'clockin', 'entry', '0', '3', '4'];
const PUNCH_OUT = ['out', 'checkout', 'clockout', 'exit', '1', '2', '5'];

export function normalisePunchType(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (PUNCH_IN.includes(s))  return 'in';
  if (PUNCH_OUT.includes(s)) return 'out';
  return null;
}

async function applyPunch(client, p, ctx) {
  const { employeeId, employeeCompanyId, deviceId, punchAt, punchType, raw } = p;
  const ins = await client.query(
    `INSERT INTO biometric_logs
       (employee_id, device_id, punch_time, punch_type, raw_data, company_id, processed)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     ON CONFLICT DO NOTHING
     RETURNING id,
               to_char(punch_time AT TIME ZONE $7, 'YYYY-MM-DD') AS day,
               to_char(punch_time AT TIME ZONE $7, 'HH24:MI:SS') AS t`,
    [employeeId, deviceId ?? null, punchAt, punchType, JSON.stringify(raw ?? {}),
     employeeCompanyId ?? ctx.companyId, ctx.tz]
  );
  if (!ins.rows.length) return 'duplicate';
  if (employeeId == null) return 'unmatched';

  const { id: logId, day, t } = ins.rows[0];
  const companyId = employeeCompanyId ?? ctx.companyId;

  const monthKey = `${companyId}:${day.slice(0, 7)}`;
  if (!ctx.frozenMonths.has(monthKey)) {
    ctx.frozenMonths.set(monthKey, await isPeriodFrozen(day, companyId, client));
  }
  if (ctx.frozenMonths.get(monthKey)) return 'frozen';

  const { rows: [existing] } = await client.query(
    `SELECT id, is_frozen, deleted_at FROM attendance_records
      WHERE employee_id = $1 AND attendance_date = $2 FOR UPDATE`,
    [employeeId, day]
  );
  if (existing && (existing.is_frozen || existing.deleted_at)) return 'locked';

  if (punchType === 'in') {
    await client.query(
      `INSERT INTO attendance_records
         (employee_id, attendance_date, check_in_time, status, company_id, source)
       VALUES ($1, $2, $3::time, 'present', $4, 'biometric')
       ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
         check_in_time = CASE
           WHEN attendance_records.check_in_time IS NULL OR $3::time < attendance_records.check_in_time
           THEN $3::time ELSE attendance_records.check_in_time END,
         status = CASE WHEN LOWER(attendance_records.status) = 'absent'
                       THEN 'present' ELSE attendance_records.status END,
         updated_at = NOW()`,
      [employeeId, day, t, companyId]
    );
  } else {
    await client.query(
      `INSERT INTO attendance_records
         (employee_id, attendance_date, check_out_time, status, company_id, source)
       VALUES ($1, $2, $3::time, 'present', $4, 'biometric')
       ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
         check_out_time = CASE
           WHEN attendance_records.check_out_time IS NULL OR $3::time > attendance_records.check_out_time
           THEN $3::time ELSE attendance_records.check_out_time END,
         status = CASE WHEN LOWER(attendance_records.status) = 'absent'
                       THEN 'present' ELSE attendance_records.status END,
         updated_at = NOW()`,
      [employeeId, day, t, companyId]
    );
  }

  if (!ctx.fullDayHours.has(companyId)) {
    ctx.fullDayHours.set(companyId, await getFullDayHours(companyId, client));
  }
  await client.query(
    `UPDATE attendance_records
        SET total_hours = ROUND((EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600)::numeric, 2),
            ot_hours    = ROUND(GREATEST(0, EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600 - $3)::numeric, 2)
      WHERE employee_id = $1 AND attendance_date = $2
        AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL
        AND check_out_time > check_in_time`,
    [employeeId, day, ctx.fullDayHours.get(companyId)]
  );
  await client.query(
    'UPDATE biometric_logs SET processed = true, processed_at = NOW() WHERE id = $1', [logId]);
  return 'applied';
}

const newIngestContext = (companyId, tz) => ({
  companyId, tz, frozenMonths: new Map(), fullDayHours: new Map(),
});

const OUTCOMES = ['applied', 'duplicate', 'unmatched', 'frozen', 'locked'];
const emptyTally = () => Object.fromEntries(OUTCOMES.map(k => [k, 0]));

/**
 * Map a ZKTeco device user to an employee of `companyId`.
 *
 *   1. employees.office_id (the employee code) — most reliable
 *   2. employees.biometric_user_id — set by POST /biometric/employees/map
 *   3. the registered name, ONLY when exactly one current employee has it.
 *      This used to take the first of any number of namesakes, which writes
 *      one person's punches onto another's attendance.
 *
 * ⚠ The company clause was `company_id = X OR company_id IS NULL`, so a
 * null-company employee matched every tenant's device. Scoped strictly now;
 * there are no null-company employees, so nothing that matched before stops.
 */
async function resolveDeviceUser(db, deviceUserId, deviceUserName, companyId) {
  const scope = `($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL`;
  const one = async (sql, value) => {
    const { rows } = await db.query(`SELECT id, company_id FROM employees WHERE ${sql} AND ${scope} LIMIT 2`, [value, companyId]);
    return rows.length === 1 ? rows[0] : null;
  };
  if (deviceUserId) {
    const byCode = await one('LOWER(TRIM(office_id)) = LOWER(TRIM($1))', String(deviceUserId));
    if (byCode) return byCode;
    const byBio = await one('biometric_user_id = $1', String(deviceUserId));
    if (byBio) return byBio;
  }
  if (deviceUserName && String(deviceUserName).trim()) {
    const byName = await one(
      `LOWER(TRIM(COALESCE(name, CONCAT(first_name,' ',COALESCE(last_name,''))))) = LOWER(TRIM($1))
       AND LOWER(status) IN (${sqlList(CURRENT_STATUSES)})`,
      String(deviceUserName));
    if (byName) return byName;
  }
  return null;
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

/* ─── dev-only: seed sample biometric devices ───
 * Inserted WITHOUT a status or last_sync. The original wrote 'online' and a
 * last_sync of "two hours ago" — a connection nobody had made — and the page
 * rendered it as a live device. These now read "never verified". */
if (process.env.NODE_ENV !== 'production') {
  (async () => {
    try {
      const { rows } = await pool.query('SELECT COUNT(*) FROM biometric_devices');
      if (parseInt(rows[0].count) === 0) {
        await pool.query(`
          INSERT INTO biometric_devices (device_name, device_type, location, ip_address, port, vendor, serial_number, attendance_direction) VALUES
          ('Main Gate - In',   'fingerprint',  'Main Entrance',     '192.168.1.101', 4370, 'ZKTeco',  'SN-101', 'in'),
          ('Main Gate - Out',  'fingerprint',  'Main Exit',         '192.168.1.102', 4370, 'ZKTeco',  'SN-102', 'out'),
          ('Server Room',      'face+finger',  'IT Block Room 201', '192.168.1.103', 4370, 'Suprema', 'SN-103', 'both'),
          ('Production Floor', 'fingerprint',  'Factory Entrance',  '192.168.1.104', 4370, 'eSSL',    'SN-104', 'both'),
          ('HR Office',        'card_reader',  'HR Block Entry',    '192.168.1.105', 4370, 'Matrix',  'SN-105', 'both')
        `);
      }
    } catch (e) { console.error('[biometric] seed error:', e.message); }
  })();
}

/* ─── GET /biometric/devices ─────────────────────────────────── */
router.get('/biometric/devices', biometricRead, async (req, res) => {
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

/* ─── GET /biometric/devices/stats ─── must be before /:id routes
 * `unverified` counts devices whose status no test or sync has ever set
 * (status_checked_at IS NULL) — those are excluded from online/offline/error,
 * which used to count a seeded 'online' as a working device. */
router.get('/biometric/devices/stats', biometricRead, async (req, res) => {
  const companyId = cid(req);
  try {
    const [statusRes, punchRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='online'  AND status_checked_at IS NOT NULL) AS online,
           COUNT(*) FILTER (WHERE status='offline' AND status_checked_at IS NOT NULL) AS offline,
           COUNT(*) FILTER (WHERE status='error'   AND status_checked_at IS NOT NULL) AS error_count,
           COUNT(*) FILTER (WHERE status_checked_at IS NULL)                          AS unverified
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
      unverified:    parseInt(s.unverified   || 0),
      punches_today: parseInt(punchRes.rows[0]?.punches_today || 0),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── device configuration: only the connection is required ──────
 *
 * Setting up a device needs just its address (§198): the IP (or host name)
 * and port — 4370 by default, the ZKTeco/eSSL standard. Everything else is
 * optional: the name defaults to "Device <ip>", direction to both, type to
 * fingerprint. A name used to be required, and nothing validated the address
 * or port, so a typo saved fine and failed only at the first sync.
 *
 * ⚠ The sync library (node-zklib 1.3.0) cannot send a device comm key, so the
 * device's comm key / communication password must be 0. There is deliberately
 * no comm-key field: storing a secret the sync can never use would read as
 * configured and silently not work. */
const DEVICE_TYPES = ['fingerprint', 'face', 'face+finger', 'card_reader', 'iris'];
const DIRECTIONS   = ['in', 'out', 'both'];
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function deviceAddress(body) {
  const errors = [];
  const ip = String(body.ip_address ?? '').trim();
  if (!ip) errors.push('ip_address is required');
  // A dotted number is an IPv4 address or nothing: '999.1.1.1' is also a
  // syntactically valid host name, and must not be accepted as one.
  else if (/^[\d.]+$/.test(ip) ? !IPV4.test(ip) : !HOSTNAME.test(ip)) {
    errors.push('ip_address must be an IPv4 address (e.g. 192.168.1.50) or a host name');
  }
  const rawPort = blank(body.port);
  const port = rawPort === null ? 4370 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port must be a whole number from 1 to 65535');
  return { errors, ip, port };
}

function normaliseDevice(body = {}) {
  const { errors, ip, port } = deviceAddress(body);
  const direction = blank(body.attendance_direction) ?? 'both';
  if (!DIRECTIONS.includes(direction)) errors.push('attendance_direction must be in, out or both');
  const type = blank(body.device_type) ?? 'fingerprint';
  if (!DEVICE_TYPES.includes(type)) errors.push(`device_type must be one of ${DEVICE_TYPES.join(', ')}`);
  const name = String(blank(body.device_name) ?? (ip ? `Device ${ip}` : '')).trim();
  if (name.length > 150) errors.push('device_name must be 150 characters or fewer');
  if (String(body.location ?? '').trim().length > 200) errors.push('location must be 200 characters or fewer');
  const opt = (k) => (blank(body[k]) === null ? null : String(body[k]).trim());
  return {
    errors,
    value: {
      device_name: name, device_type: type, location: opt('location'), ip_address: ip, port,
      vendor: opt('vendor'), serial_number: opt('serial_number'), attendance_direction: direction,
    },
  };
}

/* ─── POST /biometric/devices/probe ─── test an address BEFORE saving ──
 * The registration form's "Test connection": a TCP check of the address
 * typed, with nothing stored. Same gate as registering a device. */
router.post('/biometric/devices/probe', attendanceAdd, async (req, res) => {
  const { errors, ip, port } = deviceAddress(req.body ?? {});
  if (errors.length) return res.status(400).json({ message: errors[0], errors });
  const result = await testZKDevice(ip, port);
  res.json({
    ip_address: ip, port, connected: result.connected,
    latency_ms: result.latency_ms || null, error: result.error || null,
    message: result.connected
      ? `${ip}:${port} answered (${result.latency_ms} ms). This checks the network port only; Sync confirms the device protocol.`
      : `${ip}:${port} did not answer: ${result.error}`,
  });
});

/* ─── POST /biometric/devices ────────────────────────────────── */
router.post('/biometric/devices', attendanceAdd, async (req, res) => {
  const { errors, value: v } = normaliseDevice(req.body);
  if (errors.length) return res.status(400).json({ message: errors[0], errors });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO biometric_devices
         (device_name, device_type, location, ip_address, port, vendor, serial_number, attendance_direction, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [v.device_name, v.device_type, v.location, v.ip_address, v.port, v.vendor, v.serial_number, v.attendance_direction, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /biometric/devices/:id ─────────────────────────────── */
router.put('/biometric/devices/:id', attendanceAdmin, captureBefore('biometric_devices'), async (req, res) => {
  const { errors, value: v } = normaliseDevice(req.body);
  if (errors.length) return res.status(400).json({ message: errors[0], errors });
  const companyId = cid(req);
  try {
    // A changed address invalidates the last check: the status was about the
    // old address, so the device reads "Not verified" until tested again.
    const { rows } = await pool.query(
      `UPDATE biometric_devices
       SET device_name=$1, device_type=$2, location=$3, ip_address=$4::text, port=$5::int,
           vendor=$6, serial_number=$7, attendance_direction=$8, updated_at=NOW(),
           -- Explicit casts: $4/$5 appear both as assigned values and in a
           -- comparison, and Postgres refuses to infer two types for one parameter.
           status_checked_at = CASE WHEN ip_address IS DISTINCT FROM $4::text OR port IS DISTINCT FROM $5::int
                                    THEN NULL ELSE status_checked_at END
       WHERE id=$9 AND ($10::int IS NULL OR company_id = $10) RETURNING *`,
      [
        v.device_name, v.device_type, v.location, v.ip_address, v.port,
        v.vendor, v.serial_number, v.attendance_direction, req.params.id, companyId,
      ]
    );
    if (!rows.length) return res.status(404).json({ message: 'Device not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── DELETE /biometric/devices/:id ──────────────────────────── */
router.delete('/biometric/devices/:id', attendanceDelete, captureBefore('biometric_devices'), async (req, res) => {
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
router.post('/biometric/devices/:id/test', attendanceAdmin, async (req, res) => {
  try {
    // ⚠⚠ TENANT SCOPE. Same defect as /devices/:id/users, and worse: this
    // looked the device up on `WHERE id=$1` alone, then opened a socket to its
    // ip_address, UPDATEd its status, and returned ip_address and port in the
    // body. Scoped the lookup; the UPDATE below is keyed on an id this query
    // has already proven belongs to the caller.
    const scopeId = cid(req);
    const { rows: [device] } = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, scopeId]
    );
    if (!device) return res.status(404).json({ error: 'Device not found', message: 'Device not found' });
    if (!device.ip_address) {
      return res.status(422).json({ status: 'not_configured', message: 'This device has no IP address configured.' });
    }

    const result = await testZKDevice(device.ip_address, device.port);

    // ⚠ This UPDATE wrote `updated_at`, a column biometric_devices did not have
    // until migration 20261028000012, so a REACHABLE device answered 500.
    const newStatus = result.connected ? 'online' : 'offline';
    await pool.query(
      `UPDATE biometric_devices
          SET status=$1, status_checked_at=NOW(), last_error=$2, updated_at=NOW()
        WHERE id=$3`,
      [newStatus, result.connected ? null : result.error, device.id]
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
      message:     result.connected
        ? `${device.device_name} answered on ${device.ip_address}:${device.port} (${result.latency_ms} ms). This checks the network port only, not the attendance protocol.`
        : `${device.device_name} did not answer: ${result.error}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, message: err.message });
  }
});

/* ─── POST /biometric/devices/:id/sync ─── real ZKTeco SDK sync ─
 *
 * ⚠⚠ What this used to report. The final "mark online" UPDATE wrote
 * `updated_at`, which did not exist, so a sync that HAD pulled and written
 * punches threw at the end, answered 500 and tried to mark the device 'error'
 * (that UPDATE failed too, silently). And every write inside was
 * `.catch(() => {})`, so the counts it would have returned were counts of
 * attempts. Now: reach the device first; only if data came back, process it
 * in ONE transaction; the response counts what actually landed. An
 * unreachable device is a 502 with status 'offline' — never a success. */
router.post('/biometric/devices/:id/sync', attendanceAdmin, async (req, res) => {
  const scopeId = cid(req);
  let device;
  try {
    // ⚠⚠ TENANT SCOPE, and this one WRITES: a foreign id 404s before any
    // socket is opened (it used to sync another tenant's hardware into that
    // tenant's attendance).
    ({ rows: [device] } = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, scopeId]
    ));
  } catch (err) { return res.status(500).json({ error: err.message, message: err.message }); }
  if (!device) return res.status(404).json({ error: 'Device not found', message: 'Device not found' });

  if (!device.ip_address) {
    return res.status(422).json({
      synced: false, status: 'not_configured',
      message: `${device.device_name} has no IP address configured, so it cannot be synced.`,
    });
  }
  if (!deviceDriver.available()) {
    return res.status(503).json({
      synced: false, status: 'not_configured', code: 'SDK_NOT_INSTALLED',
      message: 'Device sync is not available on this server: the ZKTeco SDK (node-zklib) is not installed.',
    });
  }

  const companyId = device.company_id ?? scopeId;
  const direction = device.attendance_direction || 'both';

  let payload;
  try {
    payload = await deviceDriver.read(device.ip_address, device.port);
  } catch (err) {
    const why = deviceErrorText(err);
    await pool.query(
      `UPDATE biometric_devices
          SET status='offline', status_checked_at=NOW(), last_error=$1, updated_at=NOW()
        WHERE id=$2`,
      [why, device.id]
    ).catch(() => {});
    return res.status(502).json({
      synced: false, status: 'offline', error: why,
      message: `Could not read ${device.device_name} at ${device.ip_address}:${device.port} — ${why}. No punches were imported.`,
      hint: 'Check the device IP address, port and network connectivity.',
    });
  }

  const userMap = {};
  for (const u of payload.users || []) userMap[String(u.userId || u.uid)] = u.name || '';

  const client = await pool.connect();
  const tally = emptyTally();
  let skipped = 0;
  try {
    await client.query('BEGIN');
    const rules = await dayRules(companyId, client);
    const ctx = newIngestContext(companyId, rules.tz);
    const people = new Map();
    for (const log of payload.logs || []) {
      const devUserId = String(log.deviceUserId || log.userId || '');
      const punchAt   = log.attTime instanceof Date ? log.attTime : new Date(log.attTime);
      const punchType = normalisePunchType(log.inOutStatus ?? 0);
      if (isNaN(punchAt.getTime()) || !punchType
          || (direction === 'in' && punchType !== 'in')
          || (direction === 'out' && punchType !== 'out')) { skipped++; continue; }

      if (!people.has(devUserId)) {
        people.set(devUserId, await resolveDeviceUser(client, devUserId, userMap[devUserId], companyId));
      }
      const emp = people.get(devUserId);
      const outcome = await applyPunch(client, {
        employeeId: emp?.id ?? null, employeeCompanyId: emp?.company_id ?? companyId,
        deviceId: device.id, punchAt, punchType,
        raw: { source: 'device_sync', devUserId, devName: userMap[devUserId] || '', inOutStatus: log.inOutStatus, verifyType: log.verifyType },
      }, ctx);
      tally[outcome]++;
    }
    await client.query(
      `UPDATE biometric_devices
          SET last_sync=NOW(), status='online', status_checked_at=NOW(), last_error=NULL, updated_at=NOW()
        WHERE id=$1`,
      [device.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return res.status(500).json({
      synced: false, error: err.message,
      message: `Punches were read from ${device.device_name} but could not be saved — nothing was imported. ${err.message}`,
    });
  }
  client.release();

  const total = (payload.logs || []).length;
  res.json({
    device_id:    device.id,
    device_name:  device.device_name,
    synced:       true,
    status:       'online',
    total_logs:   total,
    imported:     total - skipped - tally.duplicate,
    processed:    tally.applied,
    duplicates:   tally.duplicate,
    unmatched:    tally.unmatched,
    locked:       tally.frozen + tally.locked,
    skipped,
    sdk_status:   'active',
    last_sync:    new Date().toISOString(),
    message: total === 0
      ? `${device.device_name} answered and returned no punches.`
      : `${device.device_name}: ${total} punch(es) received — ${tally.applied} applied to attendance, `
        + `${tally.duplicate} already imported, ${tally.unmatched} not matched to an employee`
        + (tally.frozen + tally.locked ? `, ${tally.frozen + tally.locked} in a locked/frozen period` : '')
        + (skipped ? `, ${skipped} skipped (invalid or filtered by direction)` : '') + '.',
  });
});

/* ─── GET /biometric/devices/:id/punches ─────────────────────── */
router.get('/biometric/devices/:id/punches', biometricRead, async (req, res) => {
  const companyId = cid(req);
  const { date, limit = 50, offset = 0 } = req.query;
  try {
    const devRes = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, companyId]
    );
    if (!devRes.rows.length) return res.status(404).json({ message: 'Device not found' });

    const params = [req.params.id];
    let q = `SELECT bl.*, e.name AS employee_name, e.office_id AS emp_code, e.department
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

/* ─── shared list-query helpers ──────────────────────────────── */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ?page / ?page_size, clamped. Lists here are paged for real (25 by default). */
function listPage(query, { size = 25, max = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(max, Math.max(1, parseInt(query.page_size, 10) || size));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * ?from / ?to as validated 'YYYY-MM-DD' strings. Returns { error } for a
 * malformed or backwards range rather than letting Postgres 500 on the cast.
 */
function dateRange(query) {
  const out = {};
  for (const k of ['from', 'to']) {
    const v = blank(query[k]);
    if (v === null) continue;
    const s = String(v);
    const d = new Date(`${s}T00:00:00Z`);
    if (!ISO_DATE.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      return { error: `${k} must be a date in YYYY-MM-DD format` };
    }
    out[k] = s;
  }
  if (out.from && out.to && out.from > out.to) return { error: 'from must be on or before to' };
  return out;
}

const positiveIntOrNull = (v) => {
  const s = blank(v);
  if (s === null) return null;
  return /^\d+$/.test(String(s).trim()) && Number(s) >= 1 ? Number(s) : NaN;
};

/* ─── GET /biometric/logs ─── the Recent Punch Log ─────────────
 *
 * Filters: from/to (punch date, company timezone; default today), q (employee
 * name or code), employee_id, department, device_id, punch_type; paged.
 *
 * Scope: the row's own company_id, else its employee's. It was the employee's
 * only, so an unmatched device punch (employee_id NULL) could never be seen —
 * the very rows someone needs to map. */
router.get('/biometric/logs', biometricRead, async (req, res) => {
  const companyId = cid(req);
  const range = dateRange(req.query);
  if (range.error) return res.status(400).json({ message: range.error });
  const employeeId = positiveIntOrNull(req.query.employee_id);
  const deviceId   = positiveIntOrNull(req.query.device_id);
  if (Number.isNaN(employeeId)) return res.status(400).json({ message: 'employee_id must be a positive integer' });
  if (Number.isNaN(deviceId))   return res.status(400).json({ message: 'device_id must be a positive integer' });
  const punchType = blank(req.query.punch_type);
  if (punchType !== null && !['in', 'out'].includes(String(punchType))) {
    return res.status(400).json({ message: "punch_type must be 'in' or 'out'" });
  }
  // The legacy ?date= and ?limit= (no paging) are still honoured.
  const legacyDate = blank(req.query.date);
  if (legacyDate !== null && !range.from && !range.to) {
    const r = dateRange({ from: legacyDate, to: legacyDate });
    if (r.error) return res.status(400).json({ message: 'date must be a date in YYYY-MM-DD format' });
    Object.assign(range, r);
  }
  const { page, pageSize, offset } = listPage(
    { page: req.query.page, page_size: req.query.page_size ?? req.query.limit }, { size: 50, max: 200 });

  try {
    const { tz } = await dayRules(companyId);
    const today = (await pool.query(`SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`, [tz])).rows[0].d;
    const from = range.from ?? (range.to ? null : today);
    const to   = range.to   ?? (range.from ? null : today);

    const where = ['($1::int IS NULL OR COALESCE(bl.company_id, e.company_id) = $1)'];
    const params = [companyId];
    const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
    // `from` or `to` is always set (both default to today), so the zone is
    // always referenced once bound.
    params.push(tz); const tzRef = `$${params.length}::text`;
    if (from)       add(`(bl.punch_time AT TIME ZONE ${tzRef})::date >= $?::date`, from);
    if (to)         add(`(bl.punch_time AT TIME ZONE ${tzRef})::date <= $?::date`, to);
    if (employeeId) add('bl.employee_id = $?', employeeId);
    if (deviceId)   add('bl.device_id = $?', deviceId);
    if (punchType)  add('bl.punch_type = $?', punchType);
    const dept = blank(req.query.department);
    if (dept !== null) add('e.department = $?', String(dept));
    const q = blank(req.query.q);
    if (q !== null) {
      add(`(e.name ILIKE $? OR e.office_id ILIKE $? OR bl.raw_data->>'devUserId' ILIKE $?)`, `%${String(q).trim()}%`);
    }
    const whereSql = where.join(' AND ');
    const from_ = `FROM biometric_logs bl
                   LEFT JOIN employees e ON e.id = bl.employee_id
                   LEFT JOIN biometric_devices d ON d.id = bl.device_id
                  WHERE ${whereSql}`;
    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT bl.id, bl.employee_id, bl.device_id, bl.punch_time, bl.punch_type, bl.processed,
                bl.raw_data->>'source' AS source, bl.raw_data->>'devUserId' AS device_user_id,
                e.name AS employee_name, e.office_id AS emp_code, e.department, d.device_name
           ${from_}
          ORDER BY bl.punch_time DESC, bl.id DESC
          LIMIT ${pageSize} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS n ${from_}`, params),
    ]);
    res.json({ rows: rowsRes.rows, total: countRes.rows[0].n, page, page_size: pageSize, from, to });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /biometric/logs/import ─── manual CSV import ──────────
 *
 * Body: { csv_data, device_id?, dry_run? }. `dry_run: true` runs the whole
 * import inside a transaction and ROLLS BACK, so the preview the page shows
 * (valid rows, duplicates, rows that would update attendance) is the exact
 * outcome of confirming, not an estimate.
 *
 * Columns (header row, any order, case-insensitive):
 *   employee_id   employee code (EMP001), mapped biometric user id, or the
 *                 internal id. Aliases: employee_code, emp_code.
 *   punch_time    ISO 8601 (with or without offset), 'YYYY-MM-DD HH:mm[:ss]'
 *                 or 'DD/MM/YYYY HH:mm[:ss]'. No offset = company timezone.
 *   punch_type    in / out (also check-in, check-out, 0/1 as devices export).
 *
 * ⚠ Before: `employee_id` had to be the INTERNAL numeric id, which no device
 * export carries; punch_type was optional and silently defaulted to 'in', so
 * an export without the column recorded every exit as an entry; a bad time
 * failed only inside `new Date(...).toISOString()`; and the punch never
 * reached attendance_records. Each is fixed here, and a value that matches two
 * DIFFERENT employees through different keys (code of one, biometric id of
 * another) is refused as ambiguous rather than guessed. */
const CSV_MAX_CHARS = 2_000_000;
const CSV_MAX_ROWS  = 10_000;
const HEADER_ALIASES = {
  employee_id: ['employee_id', 'employee_code', 'emp_code', 'employee code', 'emp id'],
  punch_time:  ['punch_time', 'punch time', 'datetime', 'timestamp'],
  punch_type:  ['punch_type', 'punch type', 'type', 'direction'],
};

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF/LF, a leading BOM. */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/**
 * A punch time → { text, hasOffset } in a form Postgres casts exactly, or
 * null. Calendar validity is checked here (31/02 is refused, not rolled over).
 */
export function normalisePunchTime(value) {
  const s = String(value ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  let y, mo, d, h, mi, se, off;
  if (m) { [, y, mo, d, h, mi, se, off] = m; }
  else {
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return null;
    [, d, mo, y, h, mi, se] = m;
  }
  const [Y, Mo, D, H, Mi, Se] = [y, mo, d, h, mi, se || '0'].map(Number);
  const probe = new Date(Date.UTC(Y, Mo - 1, D, H, Mi, Se));
  if (probe.getUTCFullYear() !== Y || probe.getUTCMonth() !== Mo - 1 || probe.getUTCDate() !== D
      || H > 23 || Mi > 59 || Se > 59) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  const base = `${Y}-${p2(Mo)}-${p2(D)} ${p2(H)}:${p2(Mi)}:${p2(Se)}`;
  return off ? { text: `${base}${off.toUpperCase() === 'Z' ? '+00:00' : off}`, hasOffset: true }
             : { text: base, hasOffset: false };
}

router.post('/biometric/logs/import', attendanceAdmin, async (req, res) => {
  const csv = req.body?.csv_data;
  const dryRun = req.body?.dry_run === true || req.body?.dry_run === 'true';
  if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ message: 'csv_data required' });
  if (csv.length > CSV_MAX_CHARS) {
    return res.status(413).json({ message: `The file is too large — the limit is ${CSV_MAX_CHARS / 1_000_000} MB.` });
  }

  // ⚠⚠ TENANT SCOPE. `employee_id` comes from the CSV and `device_id` from the
  // body; both are resolved against the caller's company below, so a row
  // naming a foreign employee is REPORTED, never written.
  const companyId = cid(req);
  const deviceIdRaw = blank(req.body.device_id);
  let deviceId = null;
  try {
    if (deviceIdRaw !== null) {
      const { rows } = await pool.query(
        'SELECT id FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
        [/^\d+$/.test(String(deviceIdRaw)) ? Number(deviceIdRaw) : -1, companyId]
      );
      if (!rows.length) return res.status(404).json({ message: 'Device not found' });
      deviceId = rows[0].id;
    }
  } catch (err) { return res.status(500).json({ message: err.message }); }

  const table = parseCsv(csv);
  if (table.length < 2) return res.status(400).json({ message: 'The file has a header row but no punches.' });
  const header = table[0].map(h => String(h).trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    col[key] = header.findIndex(h => aliases.includes(h));
  }
  const missing = Object.keys(HEADER_ALIASES).filter(k => col[k] === -1);
  if (missing.length) {
    return res.status(400).json({
      message: `CSV must have employee_id, punch_time and punch_type columns — missing: ${missing.join(', ')}`,
      missing_columns: missing,
    });
  }
  if (table.length - 1 > CSV_MAX_ROWS) {
    return res.status(413).json({ message: `The file has ${table.length - 1} rows — the limit is ${CSV_MAX_ROWS} per import.` });
  }

  const errors = [];          // "Row n: …" strings — the shape the page and older callers read
  const rowErrors = [];       // the same, structured
  const fail = (row, message) => { errors.push(`Row ${row}: ${message}`); rowErrors.push({ row, message }); };

  const parsed = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const empKey = String(cells[col.employee_id] ?? '').trim();
    const timeRaw = String(cells[col.punch_time] ?? '').trim();
    const typeRaw = String(cells[col.punch_type] ?? '').trim();
    if (!empKey)  { fail(i, 'employee_id is empty'); continue; }
    if (!timeRaw) { fail(i, 'punch_time is empty'); continue; }
    const time = normalisePunchTime(timeRaw);
    if (!time) { fail(i, `punch_time "${timeRaw}" is not a valid date/time`); continue; }
    const punchType = normalisePunchType(typeRaw);
    if (!punchType) { fail(i, `punch_type "${typeRaw}" must be in or out`); continue; }
    parsed.push({ row: i, empKey, time, punchType, timeRaw });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rules = await dayRules(companyId, client);

    // Resolve every employee key the file names, in one query, scoped.
    const keys = [...new Set(parsed.map(p => p.empKey))];
    const lower = keys.map(k => k.toLowerCase());
    const numeric = keys.filter(k => /^\d+$/.test(k) && k.length < 10).map(Number);
    const { rows: emps } = keys.length ? await client.query(
      `SELECT id, company_id, LOWER(TRIM(office_id)) AS code, biometric_user_id AS bio
         FROM employees
        WHERE ($1::int IS NULL OR company_id = $1) AND deleted_at IS NULL
          AND (LOWER(TRIM(office_id)) = ANY($2::text[]) OR biometric_user_id = ANY($3::text[]) OR id = ANY($4::int[]))`,
      [companyId, lower, keys, numeric]
    ) : { rows: [] };
    const resolve = (key) => {
      const k = key.toLowerCase();
      const hits = new Map();
      for (const e of emps) {
        if (e.code === k || e.bio === key || (/^\d+$/.test(key) && e.id === Number(key))) hits.set(e.id, e);
      }
      return [...hits.values()];
    };

    // Convert every time to an instant in one round trip, in the company zone.
    const times = parsed.length ? (await client.query(
      `SELECT x.i, CASE WHEN x.o THEN x.t::timestamptz ELSE x.t::timestamp AT TIME ZONE $4 END AS at
         FROM unnest($1::text[], $2::bool[], $3::int[]) AS x(t, o, i)`,
      [parsed.map(p => p.time.text), parsed.map(p => p.time.hasOffset), parsed.map((_, i) => i), rules.tz]
    )).rows : [];
    const instant = new Map(times.map(r => [r.i, r.at]));
    const ceiling = Date.now() + 5 * 60 * 1000;

    const ctx = newIngestContext(companyId, rules.tz);
    const tally = emptyTally();
    const seen = new Set();
    let duplicatesInFile = 0;
    let valid = 0;
    const preview = [];
    for (const [idx, p] of parsed.entries()) {
      const matches = resolve(p.empKey);
      if (!matches.length) { fail(p.row, `unknown employee ${p.empKey}`); continue; }
      if (matches.length > 1) { fail(p.row, `employee ${p.empKey} matches more than one employee — use the employee code`); continue; }
      const at = instant.get(idx);
      if (at.getTime() > ceiling) { fail(p.row, `punch_time ${p.timeRaw} is in the future`); continue; }
      const emp = matches[0];
      const key = `${emp.id}|${at.toISOString()}`;
      if (seen.has(key)) { duplicatesInFile++; fail(p.row, 'duplicate of an earlier row in this file'); continue; }
      seen.add(key);
      valid++;
      const outcome = await applyPunch(client, {
        employeeId: emp.id, employeeCompanyId: emp.company_id, deviceId, punchAt: at, punchType: p.punchType,
        raw: { source: 'csv_import', row: p.row, employee_key: p.empKey },
      }, ctx);
      tally[outcome]++;
      if (preview.length < 10) {
        preview.push({ row: p.row, employee_id: emp.id, employee_key: p.empKey, punch_time: at, punch_type: p.punchType, outcome });
      }
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    res.json({
      dry_run:            dryRun,
      total_rows:         table.length - 1,
      valid_rows:         valid,
      imported:           tally.applied + tally.frozen + tally.locked,
      attendance_updated: tally.applied,
      attendance_locked:  tally.frozen + tally.locked,
      duplicates:         tally.duplicate,
      duplicates_in_file: duplicatesInFile,
      invalid_rows:       rowErrors.length - duplicatesInFile,
      errors,
      row_errors:         rowErrors,
      preview,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: `Import failed and nothing was saved: ${err.message}` });
  } finally {
    client.release();
  }
});

/* ─── gate passes ─────────────────────────────────────────────────
 *
 * Lifecycle (stored `status`):  pending → approved → completed
 *                                  └──────────┴────→ cancelled
 * The page also shows two states that are NOT stored, because they are facts
 * about the clock rather than decisions anyone made:
 *   · expired — valid_to has passed and the pass was neither completed nor
 *     cancelled. The five SEED passes say 'active' with valid_to in Sep/Oct
 *     2026; stored status is left alone and they now READ as expired.
 *   · active  — approved and inside its window (or open-ended). 'approved' is
 *     shown only for an approved pass whose window has not opened yet.
 * Computed in SQL so the status filter and the counts agree with the rows. */
const GP_EFFECTIVE = `CASE
    WHEN gp.status = 'cancelled' THEN 'cancelled'
    WHEN gp.status = 'completed' THEN 'completed'
    WHEN gp.valid_to IS NOT NULL AND gp.valid_to < NOW() THEN 'expired'
    WHEN gp.status = 'pending' THEN 'pending'
    WHEN gp.valid_from IS NOT NULL AND gp.valid_from > NOW() THEN 'approved'
    ELSE 'active' END`;
const GP_STATUSES = ['pending', 'approved', 'active', 'expired', 'completed', 'cancelled'];

/* ─── GET /gate-passes ───────────────────────────────────────────
 * Filters: q (pass no., employee name/code, visitor name, reason), status
 * (effective), employee_id, from/to (validity window overlaps the range);
 * paged. `counts` is per effective status over the WHOLE company, unfiltered,
 * for the status chips. */
router.get('/gate-passes', hrView, async (req, res) => {
  const companyId = cid(req);
  const range = dateRange(req.query);
  if (range.error) return res.status(400).json({ message: range.error });
  const status = blank(req.query.status);
  if (status !== null && !GP_STATUSES.includes(String(status))) {
    return res.status(400).json({ message: `status must be one of ${GP_STATUSES.join(', ')}` });
  }
  const employeeId = positiveIntOrNull(req.query.employee_id);
  if (Number.isNaN(employeeId)) return res.status(400).json({ message: 'employee_id must be a positive integer' });
  const { page, pageSize, offset } = listPage(req.query);
  try {
    const params = [companyId];
    const where = ['($1::int IS NULL OR gp.company_id = $1)'];
    const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
    if (status)     add(`(${GP_EFFECTIVE}) = $?`, status);
    if (employeeId) add('gp.employee_id = $?', employeeId);
    if (range.from) add(`COALESCE(gp.valid_to, 'infinity'::timestamptz)::date >= $?::date`, range.from);
    if (range.to)   add(`COALESCE(gp.valid_from, gp.created_at)::date <= $?::date`, range.to);
    const q = blank(req.query.q);
    if (q !== null) {
      add(`(gp.pass_number ILIKE $? OR e.name ILIKE $? OR e.office_id ILIKE $? OR gp.visitor_name ILIKE $? OR gp.purpose ILIKE $?)`,
        `%${String(q).trim()}%`);
    }
    const from_ = `FROM gate_passes gp
                   LEFT JOIN employees e ON e.id = gp.employee_id AND e.company_id IS NOT DISTINCT FROM gp.company_id
                   LEFT JOIN employees a ON a.id = gp.approved_by
                  WHERE ${where.join(' AND ')}`;
    const [rowsRes, countRes, countsRes] = await Promise.all([
      pool.query(
        `SELECT gp.*, (${GP_EFFECTIVE}) AS effective_status,
                e.name AS employee_name, e.office_id AS emp_code, e.department,
                a.name AS approved_by_name,
                appr.approver_kind, appr.approver_employee_id, appr.approver_name
           ${from_.replace('WHERE', `${GP_APPROVER_JOIN}
                  WHERE`)}
          ORDER BY gp.created_at DESC, gp.id DESC
          LIMIT ${pageSize} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS n ${from_}`, params),
      pool.query(
        `SELECT (${GP_EFFECTIVE}) AS s, COUNT(*)::int AS n FROM gate_passes gp
          WHERE ($1::int IS NULL OR gp.company_id = $1) GROUP BY 1`, [companyId]),
    ]);
    const counts = Object.fromEntries(GP_STATUSES.map(s => [s, 0]));
    for (const r of countsRes.rows) counts[r.s] = r.n;
    // Per row: who is awaited, and whether THIS caller may approve or cancel
    // it — the same rule the approve/cancel routes enforce (§198).
    const callerEmployeeId = await employeeOf(req, pool);
    const hrEditCaller = !!(await permissionFor(req, 'hr'))?.[permissionColumn('edit')];
    const rows = rowsRes.rows.map((r) => {
      const d = approverDecision(r, { callerEmployeeId, hrEdit: hrEditCaller });
      const open = r.effective_status === 'pending';
      return {
        ...r,
        can_approve: open && d.ok,
        can_cancel: ['pending', 'approved', 'active'].includes(r.effective_status) && (hrEditCaller || (open && d.ok)),
        approver_note: open && !d.ok ? d.reason : null,
      };
    });
    res.json({ rows, total: countRes.rows[0].n, page, page_size: pageSize, counts });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * Validate a gate-pass payload. Returns a list of field-level messages, the
 * `validateProduct`/`validateProductLine` shape used in admin.routes.js.
 *
 * ⚠⚠ POST /gate-passes validated NOTHING. An empty body inserted a row whose
 * every business column was NULL and answered 201 — not a record of anything,
 * and it is how 114 of 119 rows in this table came to be debris.
 *
 *   · ONE OF `employee_id` / `visitor_name`: a pass must say who it is for.
 *   · `purpose`, `valid_from` and `valid_to` are optional, validated when
 *     supplied; a window must run forwards.
 *   · ⚠ A pass whose `valid_to` has already passed is refused: it would be
 *     created expired, a state no-one can act on. (§197)
 *   · `visitor_name` is varchar(200); over that length Postgres raises and the
 *     route answers 500. A 400 naming the field is the better answer.
 *
 * ⚠⚠ Everything is normalised through `blank()` first, because the form posts
 * '' for every field the user left alone, and '' bound to a timestamptz or int
 * column is not NULL — Postgres rejects it outright.
 */
const blank = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : v);

function validateGatePass(body) {
  const errors = [];
  const employeeId  = blank(body.employee_id);
  const visitorName = blank(body.visitor_name);
  const validFrom   = blank(body.valid_from);
  const validTo     = blank(body.valid_to);

  if (employeeId === null && visitorName === null) {
    errors.push('employee_id or visitor_name is required — a gate pass must identify who it is for');
  }
  // Digits only AND >= 1: `/^\d+$/` alone accepts "0".
  if (employeeId !== null
      && (!/^\d+$/.test(String(employeeId).trim()) || Number(String(employeeId).trim()) < 1)) {
    errors.push('employee_id must be a positive integer');
  }
  if (visitorName !== null && String(visitorName).length > 200) {
    errors.push('visitor_name must be 200 characters or fewer');
  }
  if (blank(body.purpose) !== null && String(body.purpose).length > 1000) {
    errors.push('purpose must be 1000 characters or fewer');
  }
  const parsed = {};
  for (const [field, value] of [['valid_from', validFrom], ['valid_to', validTo]]) {
    if (value === null) continue;
    const t = new Date(value);
    if (isNaN(t.getTime())) errors.push(`${field} must be a valid date/time`);
    else parsed[field] = t;
  }
  if (parsed.valid_from && parsed.valid_to && parsed.valid_to <= parsed.valid_from) {
    errors.push('valid_to must be after valid_from');
  } else if (parsed.valid_to && parsed.valid_to <= new Date()) {
    errors.push('valid_to is already in the past — the pass would be created expired');
  }
  return errors;
}

/* ─── POST /gate-passes ──────────────────────────────────────── */
router.post('/gate-passes', hrAdd, async (req, res) => {
  const errors = validateGatePass(req.body ?? {});
  // `message` carries the first error because BiometricAccess renders
  // `err.response?.data?.message`; `errors` carries the full list.
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  const employee_id  = blank(req.body.employee_id);
  const visitor_name = blank(req.body.visitor_name);
  const purpose      = blank(req.body.purpose);
  const valid_from   = blank(req.body.valid_from);
  const valid_to     = blank(req.body.valid_to);
  const companyId = cid(req);
  try {
    // ⚠ `employee_id` is a body FK: checked against the caller's company, so a
    // crafted id cannot read a foreign employee's name back through the list.
    // Nullable on purpose — a visitor-only pass names no employee.
    if (employee_id !== null) {
      const { rows } = await pool.query(
        'SELECT id FROM employees WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
        [employee_id, companyId]
      );
      if (!rows.length) return res.status(404).json({ message: 'Employee not found' });
    }
    const { rows } = await pool.query(
      `INSERT INTO gate_passes (employee_id, visitor_name, purpose, valid_from, valid_to, company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employee_id, visitor_name, purpose, valid_from, valid_to, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * A conditional transition: UPDATE only when the pass is in an allowed state,
 * and when it is not, say WHICH state it is in (409) — or 404 when it is not
 * the caller's. A plain `WHERE id=$1` UPDATE re-approved approved passes and
 * re-numbered them, and approved cancelled ones.
 */
async function transitionGatePass(req, res, { setSql, setParams, allowedSql, refuse }) {
  const companyId = cid(req);
  const id = positiveIntOrNull(req.params.id);
  if (!id) return res.status(404).json({ message: 'Gate pass not found' });
  try {
    const params = [id, companyId, ...setParams];
    const { rows } = await pool.query(
      `UPDATE gate_passes gp SET ${setSql}
        WHERE gp.id = $1 AND ($2::int IS NULL OR gp.company_id = $2) AND (${allowedSql})
        RETURNING gp.*, (${GP_EFFECTIVE}) AS effective_status`,
      params
    );
    if (rows.length) return res.json(rows[0]);
    const { rows: [cur] } = await pool.query(
      `SELECT (${GP_EFFECTIVE}) AS s FROM gate_passes gp
        WHERE gp.id = $1 AND ($2::int IS NULL OR gp.company_id = $2)`, [id, companyId]);
    if (!cur) return res.status(404).json({ message: 'Gate pass not found' });
    return res.status(409).json({ message: refuse(cur.s), current_status: cur.s });
  } catch (err) { return res.status(500).json({ message: err.message }); }
}

/**
 * Who may approve / cancel this pass (shared/gatePassApprover.js, §198).
 *
 * The approve route used to be `hr:edit` — any HR user, for any department.
 * The approver now comes from the pass holder's department: its head, else
 * the employee's reporting manager, else HR. Department heads and managers
 * hold no hr grant (they are not HR-page users), so these two routes are gated
 * on being signed in, and THIS check is the authorization.
 *
 *   approve — the designated approver only; never the pass holder.
 *   cancel  — HR (hr:edit) at any allowed stage; the designated approver too
 *             while the pass is pending, which is how they reject it.
 *
 * A foreign or missing id is 404 before anything else is said about it.
 */
async function gatePassActor(req, id) {
  const companyId = cid(req);
  const { rows: [row] } = await pool.query(
    `SELECT gp.id, gp.employee_id, gp.status, appr.*
       FROM gate_passes gp ${GP_APPROVER_JOIN}
      WHERE gp.id = $1 AND ($2::int IS NULL OR gp.company_id = $2)`,
    [id, companyId]
  );
  if (!row) return null;
  const callerEmployeeId = await employeeOf(req, pool);
  const hrEdit = !!(await permissionFor(req, 'hr'))?.[permissionColumn('edit')];
  return { row, callerEmployeeId, hrEdit, decision: approverDecision(row, { callerEmployeeId, hrEdit }) };
}

const signedIn = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Unauthorized' }));

/* ─── PUT /gate-passes/:id/approve ───────────────────────────────
 * pending, and not yet expired, only. The approver is the CALLER — it was
 * `approved_by` from the request body, so any value could be recorded. */
router.put('/gate-passes/:id/approve', signedIn, captureBefore('gate_passes'), async (req, res) => {
  const id = positiveIntOrNull(req.params.id);
  if (!id) return res.status(404).json({ message: 'Gate pass not found' });
  let actor;
  try { actor = await gatePassActor(req, id); } catch (err) { return res.status(500).json({ message: err.message }); }
  if (!actor) return res.status(404).json({ message: 'Gate pass not found' });
  if (!actor.decision.ok) {
    return res.status(403).json({
      code: 'NOT_THE_APPROVER', message: actor.decision.reason,
      approver: { kind: actor.row.approver_kind, employee_id: actor.row.approver_employee_id, name: actor.row.approver_name },
    });
  }
  const approver = actor.callerEmployeeId;
  const passNumber = `GP-${new Date().getFullYear()}-${String(req.params.id).padStart(4, '0')}`;
  return transitionGatePass(req, res, {
    setSql: `status = 'approved', approved_by = $3, approved_at = NOW(), pass_number = COALESCE(gp.pass_number, $4)`,
    setParams: [approver, passNumber],
    allowedSql: `gp.status = 'pending' AND (gp.valid_to IS NULL OR gp.valid_to > NOW())`,
    refuse: (s) => `This pass is ${s} and cannot be approved.`,
  });
});

/* ─── PUT /gate-passes/:id/cancel ─── pending or approved, not expired ── */
router.put('/gate-passes/:id/cancel', signedIn, captureBefore('gate_passes'), async (req, res) => {
  const id = positiveIntOrNull(req.params.id);
  if (!id) return res.status(404).json({ message: 'Gate pass not found' });
  let actor;
  try { actor = await gatePassActor(req, id); } catch (err) { return res.status(500).json({ message: err.message }); }
  if (!actor) return res.status(404).json({ message: 'Gate pass not found' });
  const approverRejecting = actor.row.status === 'pending' && actor.decision.ok;
  if (!actor.hrEdit && !approverRejecting) {
    return res.status(403).json({
      code: 'NOT_THE_APPROVER',
      message: actor.row.status === 'pending'
        ? actor.decision.reason
        : 'Only HR can cancel a gate pass once it is approved.',
    });
  }
  const reason = blank(req.body?.reason);
  if (reason === null) return res.status(400).json({ message: 'reason is required to cancel a gate pass' });
  if (String(reason).length > 500) return res.status(400).json({ message: 'reason must be 500 characters or fewer' });
  const by = actor.callerEmployeeId;
  return transitionGatePass(req, res, {
    setSql: `status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3, cancel_reason = $4`,
    setParams: [by, String(reason).trim()],
    allowedSql: `gp.status IN ('pending', 'approved', 'active') AND (gp.valid_to IS NULL OR gp.valid_to > NOW())`,
    refuse: (s) => `This pass is ${s} and cannot be cancelled.`,
  });
});

/* ─── PUT /gate-passes/:id/complete ───────────────────────────────
 * Marks the pass used/returned. Approved passes only, and not before the
 * window opens. An EXPIRED approved pass may be completed — a late return is
 * still a return, and completing it is how the record stops reading expired. */
router.put('/gate-passes/:id/complete', hrEdit, captureBefore('gate_passes'), async (req, res) => {
  const by = await employeeOf(req, pool);
  return transitionGatePass(req, res, {
    setSql: `status = 'completed', completed_at = NOW(), completed_by = $3`,
    setParams: [by],
    allowedSql: `gp.status IN ('approved', 'active') AND (gp.valid_from IS NULL OR gp.valid_from <= NOW())`,
    refuse: (s) => (s === 'approved'
      ? 'This pass has not started yet and cannot be completed.'
      : `This pass is ${s} and cannot be completed.`),
  });
});

/* ─── GET /visitors ──────────────────────────────────────────────
 * Filters: q (visitor name, company, phone), host_employee_id, status
 * (inside | checked_out), from/to (check-in date, company timezone), and the
 * legacy active_only=true; paged. `inside_total` is every open visit in the
 * company, unfiltered — the number the header and the dashboard card show. */
router.get('/visitors', hrView, async (req, res) => {
  const companyId = cid(req);
  const range = dateRange(req.query);
  if (range.error) return res.status(400).json({ message: range.error });
  let status = blank(req.query.status);
  if (req.query.active_only === 'true') status = 'inside';
  if (status !== null && !['inside', 'checked_out'].includes(String(status))) {
    return res.status(400).json({ message: "status must be 'inside' or 'checked_out'" });
  }
  const hostId = positiveIntOrNull(req.query.host_employee_id);
  if (Number.isNaN(hostId)) return res.status(400).json({ message: 'host_employee_id must be a positive integer' });
  const { page, pageSize, offset } = listPage(req.query);
  try {
    const { tz } = await dayRules(companyId);
    const params = [companyId];
    const where = ['($1::int IS NULL OR v.company_id = $1)'];
    const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
    if (status === 'inside')      where.push('v.check_out_time IS NULL');
    if (status === 'checked_out') where.push('v.check_out_time IS NOT NULL');
    if (hostId)     add('v.host_employee_id = $?', hostId);
    // The zone is bound only when a date filter uses it — an unreferenced $n
    // is a bind error in Postgres.
    if (range.from || range.to) {
      params.push(tz);
      const tzRef = `$${params.length}::text`;
      if (range.from) add(`(v.check_in_time AT TIME ZONE ${tzRef})::date >= $?::date`, range.from);
      if (range.to)   add(`(v.check_in_time AT TIME ZONE ${tzRef})::date <= $?::date`, range.to);
    }
    const q = blank(req.query.q);
    if (q !== null) add('(v.name ILIKE $? OR v.company ILIKE $? OR v.phone ILIKE $? OR e.name ILIKE $?)', `%${String(q).trim()}%`);
    const from_ = `FROM visitors v
                   LEFT JOIN employees e ON e.id = v.host_employee_id AND e.company_id IS NOT DISTINCT FROM v.company_id
                  WHERE ${where.join(' AND ')}`;
    const [rowsRes, countRes, insideRes] = await Promise.all([
      pool.query(
        `SELECT v.*, e.name AS host_name, e.office_id AS host_code, e.department AS host_department,
                (v.check_out_time IS NULL) AS inside
           ${from_}
          ORDER BY v.check_in_time DESC, v.id DESC
          LIMIT ${pageSize} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS n ${from_}`, params),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM visitors
          WHERE ($1::int IS NULL OR company_id = $1) AND check_out_time IS NULL`, [companyId]),
    ]);
    res.json({ rows: rowsRes.rows, total: countRes.rows[0].n, page, page_size: pageSize, inside_total: insideRes.rows[0].n });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * Validate a visitor payload. Same shape as validateGatePass above.
 *
 * ⚠⚠ `visitorForm` posts '' for every untouched field and `host_employee_id`
 * is an INTEGER column, so checking in without a host was a 500. Everything is
 * normalised through `blank()` first.
 *
 *   · `name` only is required (the form's one `required` input; NOT NULL).
 *   · Length caps are the column widths, checked FIRST so an over-long value
 *     answers with the length message.
 *   · `phone`, when given, must be a contact number: digits with optional
 *     spaces, dashes, brackets and a leading +, 10–15 digits. Nothing checked
 *     it, so "abc" was stored as a phone number. (§197)
 *   · `email` format is deliberately NOT checked server-side (type="email"
 *     covers the form; a varchar causes no 500).
 */
const VISITOR_MAX = { name: 200, company: 200, phone: 20, email: 200, id_type: 50, id_number: 100 };
const PHONE_SHAPE = /^\+?[0-9][0-9\s\-()]*$/;
const phoneDigits = (v) => String(v).replace(/\D/g, '');

function validateVisitor(body) {
  const errors = [];
  const name = blank(body.name);
  if (name === null) errors.push('name is required');

  for (const [field, max] of Object.entries(VISITOR_MAX)) {
    const v = blank(body[field]);
    if (v !== null && String(v).length > max) {
      errors.push(`${field} must be ${max} characters or fewer`);
    }
  }
  const phone = blank(body.phone);
  if (phone !== null && String(phone).length <= VISITOR_MAX.phone) {
    const digits = phoneDigits(phone).length;
    if (!PHONE_SHAPE.test(String(phone).trim()) || digits < 10 || digits > 15) {
      errors.push('phone must be a valid contact number (10–15 digits)');
    }
  }

  const host = blank(body.host_employee_id);
  if (host !== null
      && (!/^\d+$/.test(String(host).trim()) || Number(String(host).trim()) < 1)) {
    errors.push('host_employee_id must be a positive integer');
  }
  return errors;
}

/* ─── POST /visitors ─── check a visitor IN ──────────────────────
 * ⚠ A second check-in for someone already inside is refused (409): same
 * phone, or — when no phone is given — same name and company. A double-click
 * created two open visits for one person, and "visitors inside" counted both.
 * The check and the insert run under one advisory lock per person, so two
 * concurrent requests cannot both pass the check. */
router.post('/visitors', hrAdd, async (req, res) => {
  const errors = validateVisitor(req.body ?? {});
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  const name             = String(blank(req.body.name)).trim();
  const company          = blank(req.body.company) === null ? null : String(req.body.company).trim();
  const phone            = blank(req.body.phone) === null ? null : String(req.body.phone).trim();
  const email            = blank(req.body.email);
  const host_employee_id = blank(req.body.host_employee_id);
  const purpose          = blank(req.body.purpose);
  const id_type          = blank(req.body.id_type);
  const id_number        = blank(req.body.id_number);
  const companyId = cid(req);
  const client = await pool.connect();
  try {
    // ⚠ Same body-FK check as POST /gate-passes. Nullable — a walk-in may have
    // no host on record.
    if (host_employee_id !== null) {
      const { rows } = await client.query(
        'SELECT id FROM employees WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
        [host_employee_id, companyId]
      );
      if (!rows.length) return res.status(404).json({ message: 'Host employee not found' });
    }
    await client.query('BEGIN');
    const who = phone ? `p:${phoneDigits(phone).slice(-10)}` : `n:${name.toLowerCase()}|${(company || '').toLowerCase()}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`visitor:${companyId}:${who}`]);
    const { rows: open } = await client.query(
      `SELECT id, name, check_in_time FROM visitors
        WHERE ($1::int IS NULL OR company_id = $1) AND check_out_time IS NULL
          AND (CASE WHEN $2::text IS NOT NULL
                    THEN RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($2::text, 10)
                    ELSE phone IS NULL AND LOWER(name) = LOWER($3) AND LOWER(COALESCE(company, '')) = LOWER(COALESCE($4, ''))
               END)
        LIMIT 1`,
      [companyId, phone ? phoneDigits(phone) : null, name, company]
    );
    if (open.length) {
      await client.query('ROLLBACK');
      // Names the visit already open, which may be spelled differently from
      // what was just typed (same phone, other name).
      return res.status(409).json({
        message: `${open[0].name} is already checked in with ${phone ? 'this contact number' : 'this name and company'}. Check them out first.`,
        visitor_id: open[0].id,
        check_in_time: open[0].check_in_time,
      });
    }
    const { rows } = await client.query(
      `INSERT INTO visitors (name, company, phone, email, host_employee_id, purpose, id_type, id_number, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, company, phone, email, host_employee_id, purpose, id_type, id_number, companyId]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

/* ─── PUT /visitors/:id/checkout ─────────────────────────────────
 * ⚠ Once only. The UPDATE had no `check_out_time IS NULL` guard, so a second
 * click (or a stale page) silently moved an earlier check-out time. */
router.put('/visitors/:id/checkout', hrEdit, captureBefore('visitors'), async (req, res) => {
  const companyId = cid(req);
  const id = positiveIntOrNull(req.params.id);
  if (!id) return res.status(404).json({ message: 'Visitor not found' });
  try {
    const { rows } = await pool.query(
      `UPDATE visitors SET check_out_time = GREATEST(NOW(), check_in_time)
       WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) AND check_out_time IS NULL RETURNING *`,
      [id, companyId]
    );
    if (rows.length) return res.json(rows[0]);
    const { rows: [cur] } = await pool.query(
      'SELECT check_out_time FROM visitors WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)', [id, companyId]);
    if (!cur) return res.status(404).json({ message: 'Visitor not found' });
    return res.status(409).json({
      message: `This visitor already checked out at ${new Date(cur.check_out_time).toISOString()}.`,
      check_out_time: cur.check_out_time,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/badge ─── record that a badge was printed ──
 * The form's "Print Badge" button only flashed "Badge printed (demo)" and
 * badge_printed was written by nothing but the seed. The page now prints the
 * badge for a saved visitor and records it here. */
router.put('/visitors/:id/badge', hrEdit, captureBefore('visitors'), async (req, res) => {
  const companyId = cid(req);
  const id = positiveIntOrNull(req.params.id);
  if (!id) return res.status(404).json({ message: 'Visitor not found' });
  try {
    const { rows } = await pool.query(
      `UPDATE visitors SET badge_printed = true
        WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`, [id, companyId]);
    if (!rows.length) return res.status(404).json({ message: 'Visitor not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/dashboard ───────────────────────────────────
 *
 * Every card, and the population it is measured against:
 *   expected        current employees (shared CURRENT_STATUSES, not deleted)
 *                   minus those on approved leave today. It was COUNT(*) of
 *                   every employees row — Left and resigned included — so Not
 *                   Punched counted people who no longer work here.
 *   punched_in      expected employees with an 'in' punch today.
 *   not_yet_punched expected − punched_in; NULL on a weekend or a declared
 *                   holiday, when nobody is expected (the page says so).
 *   late_arrivals   first 'in' today later than work_start_time + late grace
 *                   (Attendance Settings + the late policy; was `hour > 9`).
 *   early_departures last punch today is an 'out' before work_end_time (was
 *                   any 'out' before 17:00, so a lunch break counted).
 *   visitors_inside every open visit (check_out_time IS NULL), any date — the
 *                   same number the Visitors tab shows. It counted only
 *                   today's check-ins, so the two disagreed.
 * "Today" is the company-timezone date. */
router.get('/biometric/dashboard', biometricRead, async (req, res) => {
  const companyId = cid(req);
  try {
    const rules = await dayRules(companyId);
    const { rows: [{ today }] } = await pool.query(
      `SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS today`, [rules.tz]);

    const holidayQ = pool.query(
      `SELECT name FROM holidays
        WHERE date = $1::date AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
        ORDER BY company_id NULLS LAST LIMIT 1`, [today, companyId]).catch(() => ({ rows: [] }));
    const weekendQ = getWeekendDays(companyId);

    const statsQ = pool.query(
      `WITH pop AS (
         SELECT e.id FROM employees e
          WHERE ($1::int IS NULL OR e.company_id = $1) AND e.deleted_at IS NULL
            AND LOWER(e.status) IN (${sqlList(CURRENT_STATUSES)})
       ),
       on_leave AS (
         SELECT DISTINCT la.employee_id AS id FROM leave_applications la
          WHERE la.employee_id IN (SELECT id FROM pop)
            AND LOWER(la.status) IN (${sqlList(LEAVE_APPROVED)})
            AND $2::date BETWEEN la.start_date AND la.end_date
       ),
       punches AS (
         SELECT bl.employee_id, bl.punch_type, (bl.punch_time AT TIME ZONE $3)::time AS t, bl.punch_time
           FROM biometric_logs bl
          WHERE bl.employee_id IN (SELECT id FROM pop)
            AND (bl.punch_time AT TIME ZONE $3)::date = $2::date
       ),
       per_emp AS (
         SELECT employee_id,
                MIN(t) FILTER (WHERE punch_type = 'in') AS first_in,
                (ARRAY_AGG(punch_type ORDER BY punch_time DESC))[1] AS last_type,
                (ARRAY_AGG(t ORDER BY punch_time DESC))[1] AS last_t
           FROM punches GROUP BY employee_id
       )
       SELECT
         (SELECT COUNT(*) FROM pop)::int                                                   AS total_employees,
         (SELECT COUNT(*) FROM on_leave)::int                                              AS on_leave,
         (SELECT COUNT(*) FROM per_emp WHERE first_in IS NOT NULL)::int                    AS punched_in,
         (SELECT COUNT(*) FROM per_emp WHERE first_in IS NOT NULL
             AND employee_id NOT IN (SELECT id FROM on_leave))::int                        AS punched_in_expected,
         (SELECT COUNT(*) FROM per_emp
           WHERE first_in > ($4::time + make_interval(mins => $5)))::int                   AS late_arrivals,
         (SELECT COUNT(*) FROM per_emp WHERE last_type = 'out' AND last_t < $6::time)::int AS early_departures`,
      [companyId, today, rules.tz, rules.workStart, rules.graceMinutes, rules.workEnd]
    );
    const visitorsQ = pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE (check_in_time AT TIME ZONE $2)::date < $3::date)::int AS overdue
         FROM visitors
        WHERE check_out_time IS NULL AND ($1::int IS NULL OR company_id = $1)`,
      [companyId, rules.tz, today]
    );

    const [holiday, weekendDays, stats, visitors] = await Promise.all([holidayQ, weekendQ, statsQ, visitorsQ]);
    const s = stats.rows[0];
    const holidayName = holiday.rows[0]?.name ?? null;
    const isWeekend = dayIsWeekend(today, weekendDays);
    const nonWorking = holidayName ? `Holiday — ${holidayName}` : (isWeekend ? 'Weekend' : null);
    const expected = s.total_employees - s.on_leave;
    res.json({
      date:              today,
      timezone:          rules.tz,
      non_working_day:   nonWorking,
      total_employees:   s.total_employees,
      on_leave:          s.on_leave,
      expected:          nonWorking ? 0 : expected,
      punched_in_today:  s.punched_in,
      not_yet_punched:   nonWorking ? null : Math.max(0, expected - s.punched_in_expected),
      late_arrivals:     s.late_arrivals,
      early_departures:  s.early_departures,
      visitors_inside:   visitors.rows[0].n,
      visitors_overdue:  visitors.rows[0].overdue,
      rules: { work_start: rules.workStart, work_end: rules.workEnd, grace_minutes: rules.graceMinutes },
      source: 'biometric_logs (device sync and CSV import); web/mobile clock-ins are not counted here',
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/devices/:id/users ─── list enrolled users on device ── */
router.get('/biometric/devices/:id/users', attendanceAdmin, async (req, res) => {
  try {
    // ⚠⚠ TENANT SCOPE. This lookup had no company filter, so any caller holding
    // attendance:edit could name another tenant's device id and have the server
    // open a socket to THAT tenant's hardware and read back its enrolled users.
    // The `$2::int IS NULL` arm preserves the global (super-admin) scope;
    // `cid()` returns null only for a caller resolved as global.
    const scopeId = cid(req);
    const { rows: [device] } = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, scopeId]
    );
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!ZKLib) return res.status(503).json({ error: 'node-zklib not installed', hint: 'npm install node-zklib' });

    const zk = new ZKLib(device.ip_address, parseInt(device.port) || 4370, 10000, 4000);
    await zk.createSocket();
    const result = await zk.getUsers().catch(() => ({ data: [] }));
    await zk.disconnect();

    const companyId = device.company_id ?? scopeId;

    // Enrich with matched employee info. ⚠ This selected `employee_id`, a
    // column employees does not have (it is office_id), so every call 500'd
    // after dialling the device. Same matching rules as the sync.
    const enriched = await Promise.all((result.data || []).map(async (u) => {
      const devUserId = String(u.userId || u.uid || '');
      const row = await pool.query(
        `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name, office_id AS emp_code, department
           FROM employees
          WHERE (LOWER(TRIM(office_id)) = LOWER(TRIM($1)) OR biometric_user_id = $1)
            AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL
          LIMIT 1`,
        [devUserId, companyId]
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
router.post('/biometric/employees/map', hrEdit, async (req, res) => {
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

/* ─── GET /biometric/employees/options ─── the page's employee pickers ──
 * Current employees of the caller's company: id, name, code, department.
 * The gate-pass form asked for a raw internal "Employee ID" number and the
 * visitor form for a "Host Employee ID" — numbers no-one in HR knows. */
router.get('/biometric/employees/options', hrView, async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name, office_id AS emp_code, department
         FROM employees
        WHERE ($1::int IS NULL OR company_id = $1) AND deleted_at IS NULL
          AND LOWER(status) IN (${sqlList(CURRENT_STATUSES)})
        ORDER BY 2`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/employees/unmapped ─── employees with no biometric ID ── */
router.get('/biometric/employees/unmapped', hrView, async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      // office_id, not employee_id — employees has no employee_id column.
      `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name,
              office_id AS emp_code, department, designation
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
