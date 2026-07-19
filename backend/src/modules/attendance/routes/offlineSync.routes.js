/**
 * offlineSync.routes.js
 * Processes the attendance offline queue submitted by PWA background sync.
 * Employees clock in/out while offline; the service worker queues punches in
 * IndexedDB and replays them here when connectivity is restored.
 *
 * Routes:
 *   POST /attendance/offline/sync   — Submit batch of offline punches
 *   GET  /attendance/offline/status — Check pending queue count for caller
 */

import express from 'express';
import pool from '../../shared/db.js';

const router = express.Router();

function scopeCompanyId(req) {
  return req.scope?.company_id ?? null;
}

async function writeAuditLog({ companyId, employeeId, action, afterData, req }) {
  try {
    await pool.query(
      `INSERT INTO attendance_audit_logs (company_id, employee_id, action, after_data, ip_address, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, employeeId, action, JSON.stringify(afterData),
       req?.ip || null, employeeId]
    );
  } catch { /* non-blocking */ }
}

// ── Process a batch of offline punches from a single employee ──────────────
// Body: { punches: [{ action, punch_time, work_mode, location, device_id }] }
router.post('/sync', async (req, res) => {
  const { punches = [] } = req.body;
  const employeeId = req.user?.employee_id;
  const companyId  = scopeCompanyId(req);

  if (!employeeId) return res.status(401).json({ error: 'employee_id not in session' });
  if (!Array.isArray(punches) || punches.length === 0) {
    return res.status(400).json({ error: 'punches array is required' });
  }
  if (punches.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 punches per sync batch' });
  }

  const results = [];

  for (const punch of punches) {
    const { action, punch_time, work_mode = 'office', location, device_id } = punch;

    if (!action || !['in','out'].includes(action)) {
      results.push({ ...punch, status: 'error', error: 'invalid action' });
      continue;
    }
    if (!punch_time) {
      results.push({ ...punch, status: 'error', error: 'punch_time is required' });
      continue;
    }

    const punchDate = new Date(punch_time);
    if (isNaN(punchDate.getTime())) {
      results.push({ ...punch, status: 'error', error: 'invalid punch_time format' });
      continue;
    }

    // Reject punches older than 7 days
    const ageMs = Date.now() - punchDate.getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      results.push({ ...punch, status: 'error', error: 'punch older than 7 days cannot be synced' });
      continue;
    }

    const dateStr = punchDate.toISOString().split('T')[0];
    const timeStr = punchDate.toTimeString().slice(0, 5);

    try {
      // Check if this punch is inside a frozen period
      const frozenCheck = await pool.query(`
        SELECT 1 FROM attendance_records
         WHERE employee_id = $1 AND attendance_date = $2
           AND is_frozen = TRUE AND deleted_at IS NULL
        LIMIT 1
      `, [employeeId, dateStr]);

      if (frozenCheck.rows.length > 0) {
        results.push({ ...punch, status: 'skipped', reason: 'period_frozen' });
        continue;
      }

      // Check for duplicate — skip if same day + same action already exists
      const existing = await pool.query(`
        SELECT check_in_time, check_out_time FROM attendance_records
         WHERE employee_id = $1 AND attendance_date = $2 AND deleted_at IS NULL LIMIT 1
      `, [employeeId, dateStr]);

      const rec = existing.rows[0];
      if (action === 'in' && rec?.check_in_time) {
        results.push({ ...punch, status: 'skipped', reason: 'already_checked_in' });
        continue;
      }
      if (action === 'out' && rec?.check_out_time) {
        results.push({ ...punch, status: 'skipped', reason: 'already_checked_out' });
        continue;
      }

      if (action === 'in') {
        await pool.query(`
          INSERT INTO attendance_records
            (employee_id, attendance_date, check_in_time, status, work_mode, company_id, source)
          VALUES ($1,$2,$3::time,'present',$4,$5,'offline_sync')
          ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
            check_in_time = COALESCE(attendance_records.check_in_time, EXCLUDED.check_in_time),
            work_mode     = EXCLUDED.work_mode,
            status        = CASE WHEN attendance_records.status = 'absent' THEN 'present' ELSE attendance_records.status END,
            updated_at    = NOW()
        `, [employeeId, dateStr, timeStr, work_mode, companyId]);
      } else {
        // Clock out — compute hours
        const prevIn = await pool.query(
          `SELECT check_in_time FROM attendance_records WHERE employee_id=$1 AND attendance_date=$2 AND deleted_at IS NULL`,
          [employeeId, dateStr]
        );
        if (prevIn.rows[0]?.check_in_time) {
          const hoursRes = await pool.query(
            `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS hours`,
            [timeStr, String(prevIn.rows[0].check_in_time).slice(0,5)]
          ).catch(() => ({ rows: [{ hours: 0 }] }));
          const totalHours = Math.max(0, parseFloat(hoursRes.rows[0]?.hours || 0));
          const otHours    = Math.max(0, totalHours - 9);
          await pool.query(`
            UPDATE attendance_records
               SET check_out_time=$1::time, total_hours=$2, ot_hours=$3, updated_at=NOW()
             WHERE employee_id=$4 AND attendance_date=$5 AND check_out_time IS NULL
          `, [timeStr, totalHours.toFixed(2), otHours.toFixed(2), employeeId, dateStr]);
        } else {
          await pool.query(`
            INSERT INTO attendance_records
              (employee_id, attendance_date, check_out_time, status, company_id, source)
            VALUES ($1,$2,$3::time,'present',$4,'offline_sync')
            ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
              check_out_time = COALESCE(EXCLUDED.check_out_time, attendance_records.check_out_time),
              updated_at     = NOW()
          `, [employeeId, dateStr, timeStr, companyId]);
        }
      }

      // Log to biometric_logs if device_id provided
      if (device_id) {
        await pool.query(
          `INSERT INTO biometric_logs (employee_id, device_id, punch_time, punch_type, raw_data, company_id)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [employeeId, device_id, punchDate.toISOString(),
           action === 'in' ? 'in' : 'out',
           JSON.stringify({ source: 'offline_sync', work_mode, location }),
           companyId]
        ).catch(() => {});
      }

      await writeAuditLog({
        companyId, employeeId, action: `offline_clock_${action}`,
        afterData: { punch_time, work_mode, location, device_id, date: dateStr, time: timeStr },
        req,
      });

      results.push({ ...punch, status: 'processed', date: dateStr, time: timeStr });

    } catch (err) {
      results.push({ ...punch, status: 'error', error: err.message });
    }
  }

  const processed = results.filter(r => r.status === 'processed').length;
  const skipped   = results.filter(r => r.status === 'skipped').length;
  const errors    = results.filter(r => r.status === 'error').length;

  res.json({
    success: true,
    processed,
    skipped,
    errors,
    results,
  });
});

// ── Queue status — how many pending offline punches this employee has ───────
router.get('/status', async (req, res) => {
  const employeeId = req.user?.employee_id;
  const companyId  = scopeCompanyId(req);
  if (!employeeId) return res.status(401).json({ error: 'employee_id not in session' });

  // Return last 5 offline-synced records so the client can confirm sync success
  const { rows } = await pool.query(`
    SELECT attendance_date, check_in_time, check_out_time, status, source, updated_at
      FROM attendance_records
     WHERE employee_id = $1
       AND source IN ('offline_sync','manual')
       AND ($2::integer IS NULL OR company_id = $2)
     ORDER BY attendance_date DESC
     LIMIT 5
  `, [employeeId, companyId]).catch(() => ({ rows: [] }));

  res.json({ employee_id: employeeId, recent_synced: rows });
});

export default router;
