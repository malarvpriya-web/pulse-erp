import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../../shared/db.js';
import attendanceRepository from '../repositories/attendance.repository.js';
import { clockRateLimit } from '../../../middlewares/attendanceRateLimit.js';
import { hasRole } from '../../../middlewares/auth.middleware.js';
import {
  requireAttendanceAdmin,
  requireAttendanceApprover,
  requireAttendanceOperator,
  isAttendanceAdmin,
  isAttendanceOperator,
  assertSelfOrPrivileged,
  assertCanDecideFor,
} from '../attendance.authz.js';

const router = express.Router();

function scopeCompanyId(req) {
  return req.scope?.company_id ?? null;
}

const DOW_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

async function getWeekendDays(companyId) {
  try {
    const { rows } = await pool.query(
      'SELECT weekend_days FROM attendance_general_settings WHERE company_id=$1 LIMIT 1',
      [companyId]
    );
    return rows[0]?.weekend_days ?? ['saturday', 'sunday'];
  } catch {
    return ['saturday', 'sunday'];
  }
}

function dayIsWeekend(dateStr, weekendDays) {
  const dayName = DOW_NAMES[new Date(dateStr + 'T00:00:00').getDay()];
  return weekendDays.includes(dayName);
}

// Returns distance in metres between two GPS coords (Haversine)
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Parse "lat,lng" or {lat,lng} into [lat, lng] numbers, or null if unparseable
function parseLocation(loc) {
  if (!loc) return null;
  try {
    if (typeof loc === 'object') return [parseFloat(loc.lat), parseFloat(loc.lng)];
    const parts = String(loc).split(',');
    if (parts.length === 2) {
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lng)) return [lat, lng];
    }
  } catch { /* unparseable */ }
  return null;
}

// ── parseTimeToMins: "HH:MM", "HH:MM:SS", "H:MM AM/PM" → minutes since midnight
function parseTimeToMins(str) {
  if (!str) return null;
  const ampm = String(str).match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  const hr24  = String(str).match(/^(\d{1,2}):(\d{2})/);
  let h, m;
  if (ampm) {
    h = parseInt(ampm[1]); m = parseInt(ampm[2]);
    const ap = ampm[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
  } else if (hr24) {
    h = parseInt(hr24[1]); m = parseInt(hr24[2]);
  } else return null;
  return h * 60 + m;
}

// ── calcLateAndStatus: handles night-shifts crossing midnight (e.g. 21:00–06:00)
function calcLateAndStatus(arrivalTimeStr, shift, fallbackGrace = 10) {
  const arrivalMins  = parseTimeToMins(arrivalTimeStr);
  if (arrivalMins === null) return { lateMinutes: 0, derivedStatus: 'present' };
  const [sh, sm]      = shift.start_time.split(':').map(Number);
  const scheduledMins = sh * 60 + sm;
  let   arrival       = arrivalMins;
  // Night-shift: start ≥ 18:00 and employee arrives before 06:00 (crossed midnight)
  if (shift.is_night_shift && scheduledMins >= 18 * 60 && arrival < 6 * 60) {
    arrival += 1440;
  }
  const lateMinutes  = Math.max(0, arrival - scheduledMins);
  const grace        = parseInt(shift.grace_minutes ?? fallbackGrace);
  return { lateMinutes, derivedStatus: lateMinutes > grace ? 'late' : 'present' };
}

// ── resolveEmployeeShift: 4-level priority chain
// Returns { shift, source }. shift = { id, name, start_time, end_time,
//   grace_minutes, is_night_shift, half_day_hours } or null.
// Priority: date_override > assignment > dept_rotation > employee_default
async function resolveEmployeeShift(employee_id, date) {
  // 1 — single-date override
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.start_time, s.end_time,
             s.grace_minutes, s.is_night_shift, s.half_day_hours
        FROM hr_shift_date_overrides o
        JOIN hr_shifts s ON s.id = o.shift_id
       WHERE o.employee_id = $1 AND o.override_date = $2
         AND o.is_active = TRUE
         AND (s.deleted_at IS NULL OR s.deleted_at > NOW())
       LIMIT 1
    `, [employee_id, date]);
    if (r.rows.length) return { shift: r.rows[0], source: 'date_override' };
  } catch { /* table may not exist yet */ }

  // 2 — direct permanent assignment
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.start_time, s.end_time,
             s.grace_minutes, s.is_night_shift, s.half_day_hours
        FROM hr_shift_assignments sa
        JOIN hr_shifts s ON s.id = sa.shift_id
       WHERE sa.employee_id = $1 AND sa.is_active = TRUE
         AND (sa.effective_from IS NULL OR sa.effective_from <= $2)
         AND (s.deleted_at IS NULL OR s.deleted_at > NOW())
       ORDER BY sa.effective_from DESC NULLS LAST LIMIT 1
    `, [employee_id, date]);
    if (r.rows.length) return { shift: r.rows[0], source: 'assignment' };
  } catch { /* non-blocking */ }

  // 3 — department rotation (2-week or 4-week cycle from effective_from)
  try {
    const empRow = await pool.query(
      `SELECT department FROM employees WHERE id = $1 LIMIT 1`, [employee_id]
    );
    const dept = empRow.rows[0]?.department;
    if (dept) {
      const rot = await pool.query(`
        SELECT r.effective_from,
               s1.id AS w1_id, s1.name AS w1_name,
               s1.start_time AS w1_start, s1.end_time AS w1_end,
               s1.grace_minutes AS w1_grace, s1.is_night_shift AS w1_night,
               s1.half_day_hours AS w1_half,
               s2.id AS w2_id, s2.name AS w2_name,
               s2.start_time AS w2_start, s2.end_time AS w2_end,
               s2.grace_minutes AS w2_grace, s2.is_night_shift AS w2_night,
               s2.half_day_hours AS w2_half,
               s3.id AS w3_id, s3.name AS w3_name,
               s3.start_time AS w3_start, s3.end_time AS w3_end,
               s3.grace_minutes AS w3_grace, s3.is_night_shift AS w3_night,
               s3.half_day_hours AS w3_half,
               s4.id AS w4_id, s4.name AS w4_name,
               s4.start_time AS w4_start, s4.end_time AS w4_end,
               s4.grace_minutes AS w4_grace, s4.is_night_shift AS w4_night,
               s4.half_day_hours AS w4_half
          FROM hr_shift_rotations r
          JOIN hr_shifts s1 ON s1.id = r.week_1_shift_id
          JOIN hr_shifts s2 ON s2.id = r.week_2_shift_id
          LEFT JOIN hr_shifts s3 ON s3.id = r.week_3_shift_id
          LEFT JOIN hr_shifts s4 ON s4.id = r.week_4_shift_id
         WHERE r.team = $1 AND r.is_active = TRUE
           AND (r.effective_from IS NULL OR r.effective_from <= $2)
           AND (s1.deleted_at IS NULL OR s1.deleted_at > NOW())
           AND (s2.deleted_at IS NULL OR s2.deleted_at > NOW())
         ORDER BY r.effective_from DESC NULLS LAST LIMIT 1
      `, [dept, date]);
      if (rot.rows.length) {
        const row    = rot.rows[0];
        const refMs  = row.effective_from
          ? new Date(row.effective_from).setHours(0, 0, 0, 0)
          : 0;
        const weeks  = Math.floor((new Date(date).setHours(0, 0, 0, 0) - refMs) / (7 * 86400000));
        // 4-week cycle if week_3 and week_4 shifts are configured, else 2-week
        const is4Week = row.w3_id && row.w4_id;
        const cycle   = is4Week ? 4 : 2;
        const weekIdx = ((weeks % cycle) + cycle) % cycle; // 0-indexed, always positive
        const weekShifts = [
          row.w1_id ? { id: row.w1_id, name: row.w1_name, start_time: row.w1_start, end_time: row.w1_end, grace_minutes: row.w1_grace, is_night_shift: row.w1_night, half_day_hours: row.w1_half } : null,
          row.w2_id ? { id: row.w2_id, name: row.w2_name, start_time: row.w2_start, end_time: row.w2_end, grace_minutes: row.w2_grace, is_night_shift: row.w2_night, half_day_hours: row.w2_half } : null,
          row.w3_id ? { id: row.w3_id, name: row.w3_name, start_time: row.w3_start, end_time: row.w3_end, grace_minutes: row.w3_grace, is_night_shift: row.w3_night, half_day_hours: row.w3_half } : null,
          row.w4_id ? { id: row.w4_id, name: row.w4_name, start_time: row.w4_start, end_time: row.w4_end, grace_minutes: row.w4_grace, is_night_shift: row.w4_night, half_day_hours: row.w4_half } : null,
        ];
        const s = weekShifts[weekIdx] || weekShifts[0];
        if (s) return { shift: s, source: 'rotation' };
      }
    }
  } catch { /* non-blocking */ }

  // 4 — employee default shift
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.start_time, s.end_time,
             s.grace_minutes, s.is_night_shift, s.half_day_hours
        FROM employees e
        JOIN hr_shifts s ON s.id = e.default_shift_id
       WHERE e.id = $1 AND e.default_shift_id IS NOT NULL
         AND (s.deleted_at IS NULL OR s.deleted_at > NOW())
       LIMIT 1
    `, [employee_id]);
    if (r.rows.length) return { shift: r.rows[0], source: 'employee_default' };
  } catch { /* non-blocking */ }

  return { shift: null, source: 'none' };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT HELPER — write to attendance_audit_logs
// ─────────────────────────────────────────────────────────────────────────────
async function writeAuditLog({ companyId, employeeId, action, beforeData, afterData, performedBy, reason, req }) {
  try {
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
    await pool.query(`
      INSERT INTO attendance_audit_logs
        (company_id, employee_id, action, before_data, after_data, performed_by, ip_address, reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      companyId, employeeId, action,
      beforeData ? JSON.stringify(beforeData) : null,
      afterData  ? JSON.stringify(afterData)  : null,
      performedBy, ip, reason || null,
    ]);
  } catch { /* non-blocking */ }
}

// Non-blocking in-app notification to the employee who owns a regularization request
async function notifyEmployee(employeeId, { title, message, refId }) {
  try {
    await pool.query(`
      INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
      SELECT u.id, $2, $3, 'attendance', $4::text, 'regularization'
        FROM users u
       WHERE u.employee_id = $1
       LIMIT 1
    `, [employeeId, title, message, refId]);
  } catch { /* non-blocking */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TODAY SUMMARY — used by Home page KPI bar
// ─────────────────────────────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  try {
    const today     = new Date().toISOString().split('T')[0];
    const companyId = scopeCompanyId(req);

    const summaryResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(ar.status) IN ('present','p')) AS present,
        COUNT(*) FILTER (WHERE LOWER(ar.status) IN ('absent','a'))  AS absent,
        COUNT(*) FILTER (WHERE LOWER(ar.status) = 'late')           AS late,
        COUNT(*) FILTER (WHERE ar.work_mode = 'wfh')                AS wfh,
        COUNT(*) FILTER (WHERE ar.ot_hours > 0)                     AS on_overtime,
        COUNT(*) AS total_marked
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      WHERE ar.attendance_date = $1
        AND ($2::integer IS NULL OR e.company_id = $2)
        AND ar.deleted_at IS NULL
    `, [today, companyId]);

    const empRow = await pool.query(`
      SELECT COUNT(*) AS total FROM employees
       WHERE LOWER(status) IN ('active','probation')
         AND deleted_at IS NULL
         AND ($1::integer IS NULL OR company_id = $1)
    `, [companyId]);

    const s            = summaryResult.rows[0];
    const totalEmployees = parseInt(empRow.rows[0]?.total || 0);
    const present      = parseInt(s?.present   || 0);
    const absent       = parseInt(s?.absent    || 0);
    const late         = parseInt(s?.late      || 0);
    const wfh          = parseInt(s?.wfh       || 0);
    const on_overtime  = parseInt(s?.on_overtime || 0);
    const percentage   = totalEmployees > 0 ? Math.round((present / totalEmployees) * 100) : 0;

    res.json({ summary: { total_employees: totalEmployees, present, absent, late, wfh, on_overtime, percentage } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIVE WORKFORCE DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/live-dashboard', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const today     = new Date().toISOString().split('T')[0];
    const cidClause = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';

    // Workforce presence — if scoped query returns 0 employees, fall back to unscoped
    // (handles fresh installs where employees don't yet have company_id assigned)
    const presenceQuery = async (clause) => pool.query(`
        SELECT
          COUNT(e.id)                                                           AS total_employees,
          COUNT(*) FILTER (WHERE LOWER(ar.status) IN ('present','late'))        AS present,
          COUNT(*) FILTER (WHERE LOWER(ar.status) = 'absent' OR ar.id IS NULL)  AS absent,
          COUNT(*) FILTER (WHERE LOWER(ar.status) = 'late')                     AS late,
          COUNT(*) FILTER (WHERE ar.work_mode = 'wfh')                          AS wfh,
          COUNT(*) FILTER (WHERE ar.work_mode = 'field')                        AS field,
          COUNT(*) FILTER (WHERE ar.ot_hours > 0)                               AS on_overtime,
          COUNT(*) FILTER (WHERE ar.check_in_time IS NOT NULL AND ar.check_out_time IS NULL) AS still_inside
        FROM employees e
        LEFT JOIN attendance_records ar
          ON ar.employee_id = e.id AND ar.attendance_date = $1 AND ar.deleted_at IS NULL
        WHERE LOWER(e.status) IN ('active','probation') AND e.deleted_at IS NULL
          ${clause}
      `, [today]);

    let presenceResult = await presenceQuery(cidClause);
    if (parseInt(presenceResult.rows[0]?.total_employees || 0) === 0 && companyId != null) {
      // Employees may not have company_id set — fall back to unscoped count
      const fallback = await presenceQuery('').catch(() => null);
      if (fallback && parseInt(fallback.rows[0]?.total_employees || 0) > 0) {
        presenceResult = fallback;
      }
    }

    const [shiftOccupancy, fieldEngineers, latestPunches] = await Promise.all([

      pool.query(`
        SELECT
          s.name AS shift_name,
          s.start_time, s.end_time,
          COUNT(DISTINCT sa.employee_id) AS capacity,
          COUNT(DISTINCT ar.employee_id) FILTER (WHERE LOWER(ar.status) IN ('present','late')) AS present,
          COUNT(DISTINCT ar.employee_id) FILTER (WHERE LOWER(ar.status) = 'absent' OR ar.id IS NULL) AS absent
        FROM hr_shifts s
        LEFT JOIN hr_shift_assignments sa ON sa.shift_id = s.id AND sa.is_active = true
        LEFT JOIN attendance_records ar
          ON ar.employee_id = sa.employee_id AND ar.attendance_date = $1 AND ar.deleted_at IS NULL
        WHERE s.deleted_at IS NULL
          ${companyId != null ? `AND EXISTS (SELECT 1 FROM employees e WHERE e.id = sa.employee_id AND e.company_id = ${parseInt(companyId)})` : ''}
        GROUP BY s.id, s.name, s.start_time, s.end_time
        ORDER BY s.start_time
        LIMIT 10
      `, [today]).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT
          e.id, COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS name,
          e.department, e.designation,
          ar.check_in_time, ar.check_in_location, ar.work_mode
        FROM employees e
        JOIN attendance_records ar ON ar.employee_id = e.id
          AND ar.attendance_date = $1
          AND ar.work_mode = 'field'
          AND ar.deleted_at IS NULL
        WHERE LOWER(e.status) IN ('active','probation','notice')
          AND e.deleted_at IS NULL ${cidClause}
        ORDER BY ar.check_in_time DESC
        LIMIT 20
      `, [today]).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT
          e.id, COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS name,
          e.department,
          ar.check_in_time, ar.check_out_time, ar.status, ar.work_mode,
          ar.late_minutes
        FROM attendance_records ar
        JOIN employees e ON e.id = ar.employee_id
        WHERE ar.attendance_date = $1 AND ar.deleted_at IS NULL
          ${cidClause}
        ORDER BY ar.updated_at DESC
        LIMIT 25
      `, [today]).catch(() => ({ rows: [] })),
    ]);

    const p = presenceResult.rows[0] || {};
    const weekendDays    = await getWeekendDays(companyId);
    const isWeekendToday = dayIsWeekend(today, weekendDays);

    res.json({
      date: today,
      presence: {
        total_employees: parseInt(p.total_employees || 0),
        present:         parseInt(p.present         || 0),
        absent:          isWeekendToday ? 0 : parseInt(p.absent || 0),
        late:            parseInt(p.late            || 0),
        wfh:             parseInt(p.wfh             || 0),
        field:           parseInt(p.field           || 0),
        on_overtime:     parseInt(p.on_overtime     || 0),
        still_inside:    parseInt(p.still_inside    || 0),
      },
      shift_occupancy: shiftOccupancy.rows.map(r => ({
        shift_name:  r.shift_name,
        start_time:  r.start_time,
        end_time:    r.end_time,
        capacity:    parseInt(r.capacity  || 0),
        present:     parseInt(r.present   || 0),
        absent:      isWeekendToday ? 0 : parseInt(r.absent || 0),
        utilization: parseInt(r.capacity) > 0
          ? Math.round((parseInt(r.present) / parseInt(r.capacity)) * 100) : 0,
      })),
      field_engineers: fieldEngineers.rows,
      latest_punches:  latestPunches.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. MARK / BULK MARK / EMPLOYEE / DATE / SUMMARY / TEAM / TODAY-STATUS
// ─────────────────────────────────────────────────────────────────────────────
router.post('/mark', requireAttendanceOperator, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    if (req.body.attendance_date) {
      const dateStr = req.body.attendance_date;
      // Block future dates
      if (dateStr > new Date().toISOString().slice(0, 10)) {
        return res.status(400).json({ error: 'Cannot mark attendance for a future date' });
      }
      // Block weekends (use company weekend_days config)
      if (companyId) {
        const weekendDaysMark = await getWeekendDays(companyId);
        if (dayIsWeekend(dateStr, weekendDaysMark)) {
          return res.status(400).json({ error: 'Cannot mark attendance on a weekend day' });
        }
      }
    }
    // Enforce freeze: non-admins cannot edit frozen (payroll-synced) months
    if (req.body.attendance_date) {
      const d = new Date(req.body.attendance_date);
      const frozenCheck = await pool.query(`
        SELECT 1 FROM attendance_records
         WHERE EXTRACT(MONTH FROM attendance_date) = $1
           AND EXTRACT(YEAR  FROM attendance_date) = $2
           AND is_frozen = true AND deleted_at IS NULL
           ${companyId != null ? `AND company_id = ${parseInt(companyId)}` : ''}
         LIMIT 1
      `, [d.getMonth() + 1, d.getFullYear()]);
      if (frozenCheck.rows.length > 0 && !hasRole(req, 'admin', 'super_admin')) {
        return res.status(423).json({
          error: 'attendance_frozen',
          message: 'Attendance for this period is frozen (synced to payroll). Only Admin can modify frozen records.',
        });
      }
    }
    const before = req.body.employee_id
      ? (await pool.query(`SELECT * FROM attendance_records WHERE employee_id=$1 AND attendance_date=$2`,
          [req.body.employee_id, req.body.attendance_date])).rows[0]
      : null;
    const attendance = await attendanceRepository.markAttendance({ ...req.body, company_id: companyId });
    await writeAuditLog({
      companyId, employeeId: req.body.employee_id,
      action: 'admin_mark', beforeData: before, afterData: attendance,
      performedBy: req.user?.userId, reason: req.body.remarks, req,
    });
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-mark', requireAttendanceOperator, async (req, res) => {
  try {
    const { attendance_date, status, employee_ids } = req.body;
    if (!attendance_date || !status) return res.status(400).json({ error: 'attendance_date and status required' });
    const companyId = scopeCompanyId(req);
    // Block future dates
    if (attendance_date > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'Cannot bulk-mark attendance for a future date' });
    }
    // Block weekends (use company weekend_days config)
    if (companyId) {
      const weekendDaysBulk = await getWeekendDays(companyId);
      if (dayIsWeekend(attendance_date, weekendDaysBulk)) {
        return res.status(400).json({ error: 'Cannot bulk-mark attendance on a weekend day' });
      }
    }
    // Enforce freeze: non-admins cannot bulk-edit frozen months
    const d = new Date(attendance_date);
    const frozenCheck = await pool.query(`
      SELECT 1 FROM attendance_records
       WHERE EXTRACT(MONTH FROM attendance_date) = $1
         AND EXTRACT(YEAR  FROM attendance_date) = $2
         AND is_frozen = true AND deleted_at IS NULL
         ${companyId != null ? `AND company_id = ${parseInt(companyId)}` : ''}
       LIMIT 1
    `, [d.getMonth() + 1, d.getFullYear()]);
    const role = (req.user?.role || '').toLowerCase();
    if (frozenCheck.rows.length > 0 && !['admin', 'super_admin'].includes(role)) {
      return res.status(423).json({
        error: 'attendance_frozen',
        message: 'Attendance for this period is frozen (synced to payroll). Only Admin can bulk-edit frozen records.',
      });
    }
    const result = await attendanceRepository.bulkMarkAttendance(attendance_date, status, employee_ids || null, companyId);
    await writeAuditLog({
      companyId, action: 'bulk_mark',
      afterData: { attendance_date, status, count: result.marked, employee_ids },
      performedBy: req.user?.userId, req,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/employee/:employee_id', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year } = req.query;
    if (month && year) {
      const data = await attendanceRepository.getEmployeeMonthlyData(
        req.params.employee_id, parseInt(month), parseInt(year), companyId
      );
      return res.json(data);
    }
    const records = await attendanceRepository.findByEmployee(
      req.params.employee_id, { ...req.query, company_id: companyId }
    );
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/date/:date', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const records = await attendanceRepository.findByDate(
      req.params.date, { ...req.query, company_id: companyId }
    );
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary/:employee_id', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year } = req.query;
    const summary = await attendanceRepository.getEmployeeSummary(
      req.params.employee_id,
      month || new Date().getMonth() + 1,
      year  || new Date().getFullYear(),
      companyId
    );
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/team/:manager_id', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { date } = req.query;
    const team = await attendanceRepository.getTeamSummary(
      req.params.manager_id,
      date || new Date().toISOString().split('T')[0],
      companyId
    );
    res.json(team);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/today/:employee_id', async (req, res) => {
  try {
    const data = await attendanceRepository.getTodayStatus(req.params.employee_id, scopeCompanyId(req));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CLOCK IN / CLOCK OUT — with policy evaluation + audit
// ─────────────────────────────────────────────────────────────────────────────
router.post('/clock', clockRateLimit, async (req, res) => {
  try {
    const { action, time, work_mode, location, selfie_url } = req.body;
    const employee_id = req.body.employee_id || req.user?.employee_id;
    if (!employee_id) {
      return res.status(400).json({
        error: 'employee_not_linked',
        message: 'Your login is not linked to an employee record. Ask HR to link your user account to an employee profile before using clock in/out.',
      });
    }
    const today     = new Date().toISOString().slice(0, 10);
    const companyId = scopeCompanyId(req);

    // Enforce ownership: employees clock only themselves; managers only their
    // direct reports. Admin/HR may clock anyone.
    //
    // Previously keyed on req.user.role (primary role only, so a user holding
    // both `employee` and `manager` lost their manager rights) and skipped the
    // whole check when callerEmpId was null (an unlinked login could clock
    // anybody). Both fixed via rolesOf()-backed helpers that fail closed.
    const callerEmpId = req.user?.employee_id ?? null;
    if (!isAttendanceAdmin(req)) {
      if (callerEmpId == null) {
        return res.status(403).json({
          error: 'Forbidden',
          code: 'EMPLOYEE_LINK_REQUIRED',
          message: 'Your login is not linked to an employee record. Ask HR to link it before clocking in or out.',
        });
      }
      if (String(callerEmpId) !== String(employee_id)) {
        if (hasRole(req, 'manager', 'department_head')) {
          const directReportCheck = await pool.query(
            `SELECT 1 FROM employees WHERE id = $1 AND reporting_to = $2 AND deleted_at IS NULL LIMIT 1`,
            [employee_id, callerEmpId]
          ).catch(() => ({ rows: [] }));
          if (!directReportCheck.rows.length) {
            return res.status(403).json({ error: 'Forbidden: you can only clock in/out your direct reports' });
          }
        } else {
          return res.status(403).json({ error: 'Forbidden: you can only clock in/out for yourself' });
        }
      }
    }

    // Fetch active late policy for this company
    const policyRow = await pool.query(`
      SELECT rules FROM attendance_policies
       WHERE policy_type = 'late' AND is_active = true
         AND (company_id = $1 OR company_id IS NULL)
       ORDER BY company_id DESC NULLS LAST
       LIMIT 1
    `, [companyId]).catch(() => ({ rows: [] }));

    const lateRules = policyRow.rows[0]?.rules || {
      grace_minutes: 10, half_late_minutes: 30, late_mark_minutes: 60,
    };

    let lateMinutes = 0;
    let derivedStatus = 'present';

    if (action === 'in') {
      // Employee meta drives the policy gates below: field staff punch from
      // customer sites, so they skip the shift window and geo-fence.
      const empMeta = await pool.query(
        `SELECT department, COALESCE(is_field_employee, FALSE) AS is_field_employee
           FROM employees WHERE id = $1 LIMIT 1`,
        [employee_id]
      ).catch(() => ({ rows: [] }));
      const empDept     = empMeta.rows[0]?.department || null;
      const isField     = empMeta.rows[0]?.is_field_employee === true;
      const isSelfPunch = !!callerEmpId && String(callerEmpId) === String(employee_id);

      // ── Face-verification gate (self punches; all employees incl. field) ──
      // /attendance/face/verify issues a 3-minute face_token on a successful
      // match; a self clock-in without one is rejected. Admin/HR corrections
      // on behalf of others are exempt, as is a company that disabled face
      // attendance in settings.
      if (isSelfPunch) {
        const faceCfg = await loadFaceSettings(companyId);
        if (faceCfg.enabled !== false) {
          let faceOk = false;
          if (req.body.face_token) {
            try {
              const dec = jwt.verify(req.body.face_token, process.env.JWT_SECRET);
              faceOk = dec?.typ === 'face_verify' && String(dec.employee_id) === String(employee_id);
            } catch { faceOk = false; }
          }
          if (!faceOk) {
            return res.status(403).json({
              error: 'face_verification_required',
              message: 'Face verification is required to clock in. Use the face clock-in and verify your face first.',
            });
          }
        }
      }

      // Resolve shift via 4-level priority chain (date_override > assignment > rotation > default)
      const { shift: resolvedShift } = await resolveEmployeeShift(employee_id, today);

      // ── Shift-window gate: clock-in only within ±N min of shift start ─────
      // Window is configurable via attendance_policies (policy_type='clock_window',
      // rules {early_minutes, late_minutes}); defaults to 15/15. Field employees
      // may clock in at any time.
      if (isSelfPunch && !isField && resolvedShift?.start_time) {
        const winRow = await pool.query(`
          SELECT rules FROM attendance_policies
           WHERE policy_type = 'clock_window' AND is_active = true
             AND (company_id = $1 OR company_id IS NULL)
           ORDER BY company_id DESC NULLS LAST
           LIMIT 1
        `, [companyId]).catch(() => ({ rows: [] }));
        const win        = winRow.rows[0]?.rules || {};
        const earlyMin   = parseInt(win.early_minutes ?? 15);
        const lateMin    = parseInt(win.late_minutes ?? 15);
        const startMins  = parseTimeToMins(resolvedShift.start_time);
        let   arrival    = parseTimeToMins(time);
        if (startMins !== null && arrival !== null) {
          if (resolvedShift.is_night_shift && startMins >= 18 * 60 && arrival < 6 * 60) arrival += 1440;
          if (arrival < startMins - earlyMin || arrival > startMins + lateMin) {
            const fmt = (m) => {
              const mm = ((m % 1440) + 1440) % 1440;
              return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
            };
            await writeAuditLog({
              companyId, employeeId: employee_id, action: 'clock_in_window_blocked',
              afterData: { time, shift: resolvedShift.name, window_start: fmt(startMins - earlyMin), window_end: fmt(startMins + lateMin) },
              performedBy: employee_id, req,
            }).catch(() => {});
            return res.status(403).json({
              error: 'outside_shift_window',
              message: `Clock-in is allowed only between ${fmt(startMins - earlyMin)} and ${fmt(startMins + lateMin)} (shift "${resolvedShift.name}" starts at ${fmt(startMins)}). Contact HR to regularize.`,
              window_start: fmt(startMins - earlyMin),
              window_end:   fmt(startMins + lateMin),
            });
          }
        }
      }

      if (resolvedShift) {
        const { lateMinutes: lm, derivedStatus: ds } =
          calcLateAndStatus(time, resolvedShift, lateRules.grace_minutes);
        lateMinutes   = lm;
        derivedStatus = ds;
      }

      // ── Geo-fence enforcement ──────────────────────────────────────────────
      // When mandatory fences apply, a self clock-in must come from inside at
      // least one of them — and must include GPS coordinates at all. Field
      // employees are exempt (location still recorded when provided).
      let geoViolation = null;
      const coords = parseLocation(location);
      {
        const geoRules = await pool.query(`
          SELECT id, name, location_name, lat, lng, radius_meters, rule_type,
                 is_mandatory, applicable_to, applicable_department
            FROM attendance_geo_rules
           WHERE is_active = true
             AND ($1::integer IS NULL OR company_id = $1)
             AND (
               applicable_to = 'all'
               OR (applicable_to = 'department' AND applicable_department = $2)
             )
           ORDER BY is_mandatory DESC
        `, [companyId, empDept]).catch(() => ({ rows: [] }));

        const mandatory = geoRules.rows.filter(r => r.is_mandatory);
        const enforceGeo = mandatory.length > 0 && !isField;

        if (enforceGeo && isSelfPunch && !coords) {
          return res.status(403).json({
            error: 'location_required',
            message: 'Clock-in requires your location. Enable GPS/location access in your browser and try again.',
          });
        }

        if (coords) {
          const [empLat, empLng] = coords;
          let insideMandatory = mandatory.length === 0;
          let nearest = null;
          for (const rule of mandatory) {
            const dist = haversineMeters(empLat, empLng, parseFloat(rule.lat), parseFloat(rule.lng));
            if (dist <= parseFloat(rule.radius_meters)) { insideMandatory = true; break; }
            if (!nearest || dist < nearest.dist) nearest = { rule, dist };
          }
          if (enforceGeo && !insideMandatory && nearest) {
            const { rule, dist } = nearest;
            await writeAuditLog({
              companyId, employeeId: employee_id, action: 'clock_in_geo_blocked',
              afterData: { rule_name: rule.name, distance_m: Math.round(dist), radius_m: rule.radius_meters, location },
              performedBy: employee_id, req,
            });
            return res.status(403).json({
              error: 'geo_fence_violation',
              message: `Clock-in blocked: you are ${Math.round(dist)}m away from "${rule.location_name || rule.name}" (allowed radius: ${rule.radius_meters}m). Move closer to your designated work location.`,
              rule_name: rule.name,
              distance_m: Math.round(dist),
              radius_m: parseFloat(rule.radius_meters),
            });
          }
          // Non-mandatory fences: allow but flag the punch for review
          for (const rule of geoRules.rows) {
            if (rule.is_mandatory) continue;
            const dist = haversineMeters(empLat, empLng, parseFloat(rule.lat), parseFloat(rule.lng));
            if (dist > parseFloat(rule.radius_meters)) {
              geoViolation = { rule_name: rule.name, distance_m: Math.round(dist) };
            }
          }
        }
      }
      // ── End geo-fence enforcement ──────────────────────────────────────────

      const result = await pool.query(`
        INSERT INTO attendance_records
          (employee_id, attendance_date, check_in_time, status, work_mode,
           check_in_location, company_id, late_minutes, selfie_url)
        VALUES ($1, $2, $3::time, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (employee_id, attendance_date)
        DO UPDATE SET
          check_in_time      = $3::time,
          status             = COALESCE(NULLIF(attendance_records.status,'absent'), $4),
          work_mode          = $5,
          check_in_location  = $6,
          company_id         = COALESCE(attendance_records.company_id, $7),
          late_minutes       = $8,
          selfie_url         = COALESCE($9, attendance_records.selfie_url),
          updated_at         = CURRENT_TIMESTAMP
        RETURNING status, check_in_time AS check_in, check_out_time AS check_out,
                  work_mode, late_minutes
      `, [employee_id, today, time, derivedStatus, work_mode || 'office', location || null, companyId, lateMinutes, selfie_url || null]);

      await writeAuditLog({
        companyId, employeeId: employee_id, action: 'clock_in',
        afterData: { time, work_mode, late_minutes: lateMinutes, status: derivedStatus, geo_violation: geoViolation },
        performedBy: employee_id, req,
      });

      // Notify reporting manager of late arrival (fire-and-forget, non-blocking)
      if (derivedStatus === 'late') {
        pool.query(`
          SELECT
            COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS emp_name,
            e.reporting_manager,
            m.user_id AS mgr_user_id
          FROM employees e
          LEFT JOIN employees m
            ON LOWER(TRIM(COALESCE(m.name, CONCAT(m.first_name,' ',COALESCE(m.last_name,'')))))
               = LOWER(TRIM(e.reporting_manager))
            AND m.user_id IS NOT NULL
            AND (m.company_id = $2 OR $2::integer IS NULL)
          WHERE e.id = $1
          LIMIT 1
        `, [employee_id, companyId])
          .then(r => {
            const row = r.rows[0];
            if (!row?.mgr_user_id) return;
            const delayMsg = lateMinutes > 0
              ? `${lateMinutes} minute${lateMinutes !== 1 ? 's' : ''} late`
              : 'late (within grace)';
            return pool.query(`
              INSERT INTO notifications
                (user_id, title, message, module_name, reference_id, notification_type)
              VALUES ($1, $2, $3, 'attendance', $4, 'late_arrival')
            `, [
              row.mgr_user_id,
              'Late Arrival Alert',
              `${row.emp_name} clocked in ${delayMsg} today.`,
              employee_id,
            ]);
          })
          .catch(() => {});
      }

      return res.json({ ...(result.rows[0] || {}), geo_warning: geoViolation });
    } else {
      // Clock out — calculate OT
      const prev = await pool.query(`
        SELECT check_in_time FROM attendance_records
         WHERE employee_id=$1 AND attendance_date=$2 AND deleted_at IS NULL
      `, [employee_id, today]);

      // ── Minimum-shift-duration gate ─────────────────────────────────────
      // A self clock-out must complete at least the assigned shift's full
      // duration (fallback 8.5h when no shift is resolved) before it's
      // accepted. Admin/HR corrections on behalf of others bypass this —
      // same exemption pattern as the clock-in shift-window gate above.
      const isSelfPunchOut = !!callerEmpId && String(callerEmpId) === String(employee_id);
      if (isSelfPunchOut && !isAdminOrHR && prev.rows[0]?.check_in_time) {
        const { shift: outShift } = await resolveEmployeeShift(employee_id, today);
        let requiredHours = 8.5;
        if (outShift?.start_time && outShift?.end_time) {
          const startMins = parseTimeToMins(outShift.start_time);
          let   endMins   = parseTimeToMins(outShift.end_time);
          if (startMins !== null && endMins !== null) {
            if (endMins <= startMins) endMins += 1440; // overnight shift
            requiredHours = (endMins - startMins) / 60;
          }
        }
        const hoursRow = await pool.query(
          `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS hours`,
          [time, String(prev.rows[0].check_in_time).slice(0, 5)]
        );
        let workedHours = parseFloat(hoursRow.rows[0]?.hours || 0);
        if (workedHours < 0) workedHours += 24; // cross-midnight shift
        if (workedHours < requiredHours) {
          const remainingMins = Math.round((requiredHours - workedHours) * 60);
          await writeAuditLog({
            companyId, employeeId: employee_id, action: 'clock_out_early_blocked',
            afterData: { time, worked_hours: workedHours.toFixed(2), required_hours: requiredHours },
            performedBy: employee_id, req,
          }).catch(() => {});
          return res.status(403).json({
            error: 'shift_not_complete',
            message: `You've worked ${workedHours.toFixed(1)}h so far — your shift requires ${requiredHours}h before clocking out. Try again in about ${remainingMins} minute${remainingMins !== 1 ? 's' : ''}, or ask HR for an early-leave regularization.`,
            worked_hours: parseFloat(workedHours.toFixed(2)),
            required_hours: requiredHours,
          });
        }
      }

      const result = await pool.query(`
        UPDATE attendance_records
           SET check_out_time = $3::time, updated_at = CURRENT_TIMESTAMP
         WHERE employee_id = $1 AND attendance_date = $2
         RETURNING status, check_in_time AS check_in, check_out_time AS check_out, total_hours
      `, [employee_id, today, time]);

      // Auto-calculate and record OT if > 9 hours
      if (prev.rows[0]?.check_in_time && result.rows[0]) {
        try {
          const hoursResult = await pool.query(
            `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS hours`,
            [time, String(prev.rows[0].check_in_time).slice(0, 5)]
          );
          // Cross-midnight shift: Postgres time subtraction goes negative — add 24h to correct
          const rawHours   = parseFloat(hoursResult.rows[0]?.hours || 0);
          const totalHours = rawHours < 0 ? rawHours + 24 : rawHours;
          // Read OT threshold from general settings (default 9h)
          let fullDayHours = 9;
          try {
            const settingsRow = await pool.query(
              'SELECT full_day_hours FROM attendance_general_settings WHERE company_id=$1 LIMIT 1',
              [companyId]
            );
            if (settingsRow.rows[0]?.full_day_hours) fullDayHours = parseFloat(settingsRow.rows[0].full_day_hours);
          } catch { /* use default */ }
          const otHours    = Math.max(0, totalHours - fullDayHours);

          await pool.query(`
            UPDATE attendance_records
               SET total_hours = $3, ot_hours = $4
             WHERE employee_id = $1 AND attendance_date = $2
          `, [employee_id, today, Math.abs(totalHours).toFixed(2), otHours.toFixed(2)]);

          // Only create OT records for OT-eligible shifts
          const shiftEligible = await pool.query(
            'SELECT COALESCE(ot_eligible, TRUE) AS ot_eligible FROM hr_shifts WHERE id = (SELECT shift_id FROM hr_shift_assignments WHERE employee_id=$1 AND is_active=TRUE ORDER BY effective_from DESC LIMIT 1)',
            [employee_id]
          ).catch(() => ({ rows: [{ ot_eligible: true }] }));
          if (otHours >= 0.5 && (shiftEligible.rows[0]?.ot_eligible !== false)) {
            const otPolicy = await pool.query(`
              SELECT rules FROM attendance_policies
               WHERE policy_type = 'overtime' AND is_active = true
                 AND (company_id = $1 OR company_id IS NULL)
               ORDER BY company_id DESC NULLS LAST LIMIT 1
            `, [companyId]).catch(() => ({ rows: [] }));

            const otRules  = otPolicy.rows[0]?.rules || { requires_approval: true, weekday_multiplier: 1.5 };
            const autoApprove = !otRules.requires_approval;

            // Apply OT caps (daily and monthly) from policy rules
            const maxDailyOt = parseFloat(otRules.max_daily_ot_hours || 0); // 0 = no cap
            let effectiveOtHours = maxDailyOt > 0 ? Math.min(otHours, maxDailyOt) : otHours;

            if (otRules.max_monthly_ot_hours) {
              try {
                const monthStart = today.slice(0, 8) + '01';
                const monthlyQ = await pool.query(
                  `SELECT COALESCE(SUM(ot_hours),0) AS used FROM attendance_ot_records
                    WHERE employee_id=$1 AND attendance_date >= $2 AND attendance_date < $3
                      AND status IN ('approved','auto_approved')`,
                  [employee_id, monthStart, today]
                );
                const monthlyUsed = parseFloat(monthlyQ.rows[0]?.used || 0);
                const maxMonthly  = parseFloat(otRules.max_monthly_ot_hours);
                effectiveOtHours  = Math.min(effectiveOtHours, Math.max(0, maxMonthly - monthlyUsed));
              } catch { /* non-blocking */ }
            }
            if (effectiveOtHours < 0.5) {
              // Below minimum threshold after cap — skip OT record
              throw new Error('ot_capped'); // caught by outer try/catch which is non-blocking
            }

            const weekendDaysOt = await getWeekendDays(companyId);
            const isWeekend = dayIsWeekend(today, weekendDaysOt);
            // Check if today is a holiday
            const holidayCheck = await pool.query(
              'SELECT 1 FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) LIMIT 1',
              [today, companyId]
            ).catch(() => ({ rows: [] }));
            const isHoliday = holidayCheck.rows.length > 0;
            // Check if employee is on a night shift
            let isNightShift = false;
            try {
              const { shift: otShift } = await resolveEmployeeShift(employee_id, today);
              isNightShift = !!otShift?.is_night_shift;
            } catch { /* non-blocking */ }
            let otType = 'weekday';
            let otMultiplier = parseFloat(otRules.weekday_multiplier || 1.5);
            if (isHoliday) { otType = 'holiday'; otMultiplier = parseFloat(otRules.holiday_multiplier || 2.0); }
            else if (isWeekend) { otType = 'weekend'; otMultiplier = parseFloat(otRules.weekend_multiplier || 2.0); }
            else if (isNightShift) { otType = 'night'; otMultiplier = parseFloat(otRules.night_multiplier || 1.5); }

            await pool.query(`
              INSERT INTO attendance_ot_records
                (company_id, employee_id, attendance_date, ot_hours, ot_type, multiplier, status)
              VALUES ($1,$2,$3,$4,$5,$6,$7)
              ON CONFLICT (employee_id, attendance_date)
              DO UPDATE SET ot_hours=$4, ot_type=$5, multiplier=$6, status=$7, updated_at=NOW()
            `, [
              companyId, employee_id, today,
              effectiveOtHours.toFixed(2),
              otType,
              otMultiplier,
              autoApprove ? 'auto_approved' : 'pending',
            ]);
          }
        } catch { /* non-blocking OT calc */ }

        // Auto-grant comp-off if employee worked on a holiday with sufficient hours
        try {
          const weekendDaysComp = await getWeekendDays(companyId);
          const isWeekend2 = dayIsWeekend(today, weekendDaysComp);
          if (!isWeekend2) {
            const hQ = await pool.query(
              `SELECT id FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) LIMIT 1`,
              [today, companyId]
            );
            if (hQ.rows.length > 0 && totalHours >= fullDayHours) {
              const holidayId = hQ.rows[0].id;
              const expiry    = new Date(today);
              expiry.setMonth(expiry.getMonth() + 3);
              await pool.query(`
                INSERT INTO compensatory_off
                  (employee_id, work_date, hours_worked, holiday_id, reason, expires_on, company_id, auto_granted)
                VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
                ON CONFLICT (employee_id, work_date) DO NOTHING
              `, [
                employee_id, today,
                parseFloat(totalHours).toFixed(2),
                holidayId,
                'Auto-granted: worked a full day on holiday',
                expiry.toISOString().slice(0, 10),
                companyId,
              ]);
            }
          }
        } catch { /* non-blocking comp-off auto-grant */ }
      }

      // Half-day detection: compare total_hours against shift's half_day_hours threshold
      try {
        const prevIn = await pool.query(
          `SELECT check_in_time FROM attendance_records
            WHERE employee_id=$1 AND attendance_date=$2 AND deleted_at IS NULL`,
          [employee_id, today]
        );
        if (prevIn.rows[0]?.check_in_time) {
          const hoursRes = await pool.query(
            `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS hours`,
            [time, String(prevIn.rows[0].check_in_time).slice(0, 5)]
          );
          const workedHours = parseFloat(hoursRes.rows[0]?.hours || 0);
          if (workedHours > 0) {
            const { shift: coShift } = await resolveEmployeeShift(employee_id, today);
            const halfDayThreshold   = parseFloat(coShift?.half_day_hours ?? 4);
            if (workedHours < halfDayThreshold) {
              await pool.query(
                `UPDATE attendance_records SET status = 'half_day'
                  WHERE employee_id=$1 AND attendance_date=$2
                    AND status NOT IN ('absent','half_day')`,
                [employee_id, today]
              );
            }
          }
        }
      } catch { /* non-blocking half-day check */ }

      // Detect early exit
      try {
        const { shift: coShift2 } = await resolveEmployeeShift(employee_id, today);
        if (coShift2 && coShift2.end_time) {
          const scheduledEndMins = parseTimeToMins(coShift2.end_time);
          const actualCheckoutMins = parseTimeToMins(time);
          if (scheduledEndMins && actualCheckoutMins && actualCheckoutMins < scheduledEndMins) {
            const earlyMins = scheduledEndMins - actualCheckoutMins;
            if (earlyMins > 0) {
              await pool.query(
                'UPDATE attendance_records SET early_leave_minutes=$1 WHERE employee_id=$2 AND attendance_date=$3',
                [earlyMins, employee_id, today]
              ).catch(() => {});
              await writeAuditLog({
                companyId, employeeId: employee_id, action: 'early_exit',
                afterData: { scheduled_end: coShift2.end_time, actual_checkout: time, early_minutes: earlyMins },
                performedBy: employee_id, req,
              });
            }
          }
        }
      } catch { /* non-blocking */ }

      await writeAuditLog({
        companyId, employeeId: employee_id, action: 'clock_out',
        afterData: { time }, performedBy: employee_id, req,
      });

      return res.json(result.rows[0] || {});
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. BREAK TRACKING
// ─────────────────────────────────────────────────────────────────────────────
router.post('/break/start', async (req, res) => {
  try {
    const { employee_id, break_type } = req.body;
    const today     = new Date().toISOString().slice(0, 10);
    const now       = new Date().toTimeString().slice(0, 5);
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      INSERT INTO attendance_break_records
        (company_id, employee_id, attendance_date, break_type, break_start, is_active)
      VALUES ($1,$2,$3,$4,$5,true)
      RETURNING *
    `, [companyId, employee_id, today, break_type || 'lunch', now]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/break/end', async (req, res) => {
  try {
    const { employee_id } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const now   = new Date().toTimeString().slice(0, 5);
    const result = await pool.query(`
      UPDATE attendance_break_records
         SET break_end = $3::time,
             duration_minutes = EXTRACT(EPOCH FROM ($3::time - break_start)) / 60,
             is_active = false
       WHERE employee_id = $1 AND attendance_date = $2 AND is_active = true
       RETURNING *
    `, [employee_id, today, now]);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/breaks/:employee_id', async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const result = await pool.query(`
      SELECT * FROM attendance_break_records
       WHERE employee_id = $1 AND attendance_date = $2
       ORDER BY break_start
    `, [req.params.employee_id, targetDate]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. OVERTIME RECORDS + APPROVAL
// ─────────────────────────────────────────────────────────────────────────────

// Cross-status KPI stats — independent of tab filter so UI cards always show
// totals for the full month regardless of which status tab is active.
router.get('/overtime/stats', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year)  || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')                                       AS pending_count,
        COUNT(*) FILTER (WHERE status IN ('approved','auto_approved'))                   AS approved_count,
        COUNT(*) FILTER (WHERE status = 'rejected')                                      AS rejected_count,
        COUNT(*)                                                                          AS total_records,
        COALESCE(SUM(ot_hours), 0)                                                       AS total_ot_hours,
        COALESCE(SUM(ot_hours) FILTER (WHERE status IN ('approved','auto_approved')), 0) AS approved_hours,
        COALESCE(SUM(ot_hours) FILTER (WHERE status = 'pending'), 0)                     AS pending_hours
      FROM attendance_ot_records
      WHERE EXTRACT(MONTH FROM attendance_date) = $1
        AND EXTRACT(YEAR  FROM attendance_date) = $2
        AND ($3::integer IS NULL OR company_id = $3)
    `, [m, y, companyId]);
    const s = rows[0] || {};
    res.json({
      pending_count:  parseInt(s.pending_count  || 0),
      approved_count: parseInt(s.approved_count || 0),
      rejected_count: parseInt(s.rejected_count || 0),
      total_records:  parseInt(s.total_records  || 0),
      total_ot_hours: parseFloat(s.total_ot_hours || 0),
      approved_hours: parseFloat(s.approved_hours || 0),
      pending_hours:  parseFloat(s.pending_hours  || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk approve multiple pending OT records in a single call
router.post('/overtime/bulk-approve', requireAttendanceApprover, async (req, res) => {
  try {
    const { ids, remarks } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids array is required' });
    const approvedBy = req.user?.userId;
    if (!approvedBy) return res.status(401).json({ error: 'Authentication required' });
    const approved = [];
    const skipped  = [];
    for (const id of ids) {
      const before = (await pool.query(`SELECT * FROM attendance_ot_records WHERE id=$1`, [id])).rows[0];
      if (!before || before.status !== 'pending') { skipped.push(id); continue; }

      // Per-record manager/delegate check, matching the singular approve route.
      // Without it this endpoint approved in bulk precisely what /overtime/:id/approve
      // refused one at a time — the bulk variant was the way around the guard.
      const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'overtime');
      if (decide) { skipped.push(id); continue; }

      const result = await pool.query(`
        UPDATE attendance_ot_records
           SET status='approved', approved_by=$2, approved_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status='pending' RETURNING *
      `, [id, approvedBy]);
      if (result.rows[0]) {
        approved.push(result.rows[0]);
        await writeAuditLog({
          companyId: result.rows[0].company_id, employeeId: result.rows[0].employee_id,
          action: 'ot_approved', beforeData: before, afterData: result.rows[0],
          performedBy: approvedBy, reason: remarks || 'Bulk approved', req,
        });
      }
    }
    res.json({
      approved: approved.length,
      records:  approved,
      ...(skipped.length ? {
        skipped,
        message: 'Some records were skipped: already decided, or not your direct reports.',
      } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/overtime', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { status, department, month, year, employee_id } = req.query;
    let q = `
      SELECT o.*, e.name AS employee_name,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS emp_name,
             e.department, e.designation,
             a.name AS approver_name
        FROM attendance_ot_records o
        JOIN employees e ON e.id = o.employee_id
        LEFT JOIN employees a ON a.id = o.approved_by
       WHERE ($1::integer IS NULL OR o.company_id = $1)
    `;
    const params = [companyId];
    let n = 2;
    if (status)       { q += ` AND o.status = $${n++}`;                  params.push(status); }
    if (employee_id)  { q += ` AND o.employee_id = $${n++}`;              params.push(employee_id); }
    if (department)   { q += ` AND e.department = $${n++}`;               params.push(department); }
    if (month && year){ q += ` AND EXTRACT(MONTH FROM o.attendance_date) = $${n++} AND EXTRACT(YEAR FROM o.attendance_date) = $${n++}`; params.push(parseInt(month), parseInt(year)); }
    q += ` ORDER BY o.attendance_date DESC LIMIT 200`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/overtime', async (req, res) => {
  try {
    const { employee_id, attendance_date, ot_hours, ot_type, reason } = req.body;
    if (!employee_id || !attendance_date || !ot_hours)
      return res.status(400).json({ error: 'employee_id, attendance_date and ot_hours are required' });
    if (parseFloat(ot_hours) <= 0 || parseFloat(ot_hours) > 16)
      return res.status(400).json({ error: 'ot_hours must be between 0.5 and 16' });
    const companyId = scopeCompanyId(req);
    const safeType = ot_type || 'weekday';
    const OT_MULTIPLIERS = { weekday: 1.5, weekend: 2.0, holiday: 2.0, night: 1.5 };
    const multiplier = OT_MULTIPLIERS[safeType] ?? 1.5;
    const result = await pool.query(`
      INSERT INTO attendance_ot_records
        (company_id, employee_id, attendance_date, ot_hours, ot_type, multiplier, reason, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
      ON CONFLICT (employee_id, attendance_date)
      DO UPDATE SET ot_hours=$4, ot_type=$5, multiplier=$6, reason=$7, status='pending', updated_at=NOW()
      RETURNING *
    `, [companyId, employee_id, attendance_date, ot_hours, safeType, multiplier, reason]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/overtime/:id/approve', requireAttendanceApprover, async (req, res) => {
  try {
    const { remarks } = req.body;
    const approvedBy     = req.user?.userId;
    if (!approvedBy) return res.status(401).json({ error: 'Authentication required' });
    const before = (await pool.query(`SELECT * FROM attendance_ot_records WHERE id=$1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'OT record not found' });
    if (before.status !== 'pending') return res.status(409).json({ error: `OT record is already ${before.status}` });

    // Actor must be HR/admin, the employee's direct manager, or an active delegate.
    // Was inline and guarded by `&& actorEmpId`, which skipped the whole check
    // for a login with no linked employee record. assertCanDecideFor fails closed.
    const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'overtime');
    if (decide) return res.status(decide.status).json(decide.body);

    const result = await pool.query(`
      UPDATE attendance_ot_records
         SET status='approved', approved_by=$2, approved_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *
    `, [req.params.id, approvedBy]);
    await writeAuditLog({
      companyId: result.rows[0].company_id, employeeId: result.rows[0].employee_id,
      action: 'ot_approved', beforeData: before, afterData: result.rows[0],
      performedBy: approvedBy, reason: remarks, req,
    });
    // Notify employee of OT approval
    await notifyEmployee(result.rows[0].employee_id, {
      title: 'Overtime Approved',
      message: `Your ${result.rows[0].ot_hours}h overtime on ${result.rows[0].attendance_date} has been approved.`,
      refId: result.rows[0].id,
    }).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/overtime/:id/reject', requireAttendanceApprover, async (req, res) => {
  try {
    const { remarks } = req.body;
    if (!remarks || !String(remarks).trim())
      return res.status(400).json({ error: 'Rejection remarks are required' });
    const rejectedBy = req.user?.userId;
    if (!rejectedBy) return res.status(401).json({ error: 'Authentication required' });
    const before = (await pool.query(`SELECT * FROM attendance_ot_records WHERE id=$1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'OT record not found' });
    if (before.status !== 'pending') return res.status(409).json({ error: `OT record is already ${before.status}` });

    // Same manager/delegate rule as the approve route. Rejecting someone else's
    // overtime is as consequential as approving it — it was previously unchecked.
    const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'overtime');
    if (decide) return res.status(decide.status).json(decide.body);

    const result = await pool.query(`
      UPDATE attendance_ot_records
         SET status='rejected', rejection_remarks=$2, updated_at=NOW()
       WHERE id=$1 RETURNING *
    `, [req.params.id, remarks]);
    await writeAuditLog({
      companyId: result.rows[0].company_id, employeeId: result.rows[0].employee_id,
      action: 'ot_rejected', beforeData: before, afterData: result.rows[0],
      performedBy: rejectedBy, reason: remarks, req,
    });
    // Notify employee of OT rejection
    await notifyEmployee(result.rows[0].employee_id, {
      title: 'Overtime Rejected',
      message: `Your overtime request for ${result.rows[0].attendance_date} was rejected${remarks ? ': ' + remarks : '.'}`,
      refId: result.rows[0].id,
    }).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. REGULARIZATION ENGINE — submit + approve/reject
// ─────────────────────────────────────────────────────────────────────────────

// Submit a regularization request (employee-facing)
router.post('/regularize', async (req, res) => {
  try {
    const { employee_id, date, check_in, check_out, reason } = req.body;
    const companyId = scopeCompanyId(req);

    // Ownership: employees may only submit for themselves; privileged roles may submit on behalf
    const ownership = assertSelfOrPrivileged(req, employee_id);
    if (ownership) return res.status(ownership.status).json(ownership.body);

    const result = await pool.query(`
      INSERT INTO attendance_regularization_requests
        (employee_id, date, check_in, check_out, reason, company_id, approval_level)
      VALUES ($1, $2, $3, $4, $5, $6, 'manager')
      RETURNING *
    `, [employee_id, date, check_in || null, check_out || null, reason, companyId]);
    await writeAuditLog({
      companyId, employeeId: employee_id, action: 'regularize_submit',
      afterData: { date, check_in, check_out, reason },
      performedBy: employee_id, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aggregate counts — Pending / Approved / Rejected (role-scoped)
router.get('/regularize/stats', async (req, res) => {
  try {
    const companyId  = scopeCompanyId(req);
    const actorEmpId = req.user?.employee_id ?? null;

    let where = `WHERE ($1::integer IS NULL OR r.company_id = $1)`;
    const params = [companyId];

    // Narrowing was previously applied only when the PRIMARY role was exactly
    // 'manager'. Every other caller — including a plain employee — fell through
    // to unfiltered company-wide stats. Invert it: admin/HR see everything,
    // managers see their reports, everyone else sees only themselves.
    if (!isAttendanceAdmin(req)) {
      if (actorEmpId == null) {
        return res.status(403).json({
          error: 'Forbidden',
          code: 'EMPLOYEE_LINK_REQUIRED',
          message: 'Your login is not linked to an employee record.',
        });
      }
      if (hasRole(req, 'manager', 'department_head')) {
        where += ` AND e.reporting_to = $2`;
      } else {
        where += ` AND r.employee_id = $2`;
      }
      params.push(actorEmpId);
    }

    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE r.status = 'pending')  AS pending,
        COUNT(*) FILTER (WHERE r.status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE r.status = 'rejected') AS rejected
        FROM attendance_regularization_requests r
        JOIN employees e ON e.id = r.employee_id
       ${where}
    `, params);

    const row = result.rows[0] || {};
    res.json({
      pending:  parseInt(row.pending  || 0),
      approved: parseInt(row.approved || 0),
      rejected: parseInt(row.rejected || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unified list — supports all statuses, department filter, date range, role scoping
router.get('/regularize/list', async (req, res) => {
  try {
    const companyId  = scopeCompanyId(req);

    const actorEmpId = req.user?.employee_id ?? null;
    const { status = 'pending', department, from, to } = req.query;

    const allowed = ['pending', 'approved', 'rejected'];
    const safeStatus = allowed.includes(status) ? status : 'pending';

    let q = `
      SELECT r.*,
             r.date::text      AS date,
             r.check_in::text  AS check_in,
             r.check_out::text AS check_out,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation,
             e.office_id AS emp_code
        FROM attendance_regularization_requests r
        JOIN employees e ON e.id = r.employee_id
       WHERE r.status = $1
         AND ($2::integer IS NULL OR r.company_id = $2)
    `;
    const params = [safeStatus, companyId];
    let n = 3;

    // Admin/HR see all; managers see their direct reports; everyone else sees
    // only their own. Previously the narrowing applied only when the PRIMARY
    // role was exactly 'manager', so every other caller — including a plain
    // employee — received every request in the company, with names, departments
    // and designations attached.
    if (!isAttendanceAdmin(req)) {
      if (actorEmpId == null) {
        return res.status(403).json({
          error: 'Forbidden',
          code: 'EMPLOYEE_LINK_REQUIRED',
          message: 'Your login is not linked to an employee record.',
        });
      }
      q += hasRole(req, 'manager', 'department_head')
        ? ` AND e.reporting_to = $${n++}`
        : ` AND r.employee_id = $${n++}`;
      params.push(actorEmpId);
    }
    if (department) { q += ` AND e.department = $${n++}`;  params.push(department); }
    if (from)       { q += ` AND r.date >= $${n++}`;       params.push(from); }
    if (to)         { q += ` AND r.date <= $${n++}`;       params.push(to); }

    q += ` ORDER BY r.created_at DESC LIMIT 200`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: err.message });
  }
});

// Distinct departments that have ever filed regularization requests (for dropdown)
router.get('/regularize/departments', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      SELECT DISTINCT e.department
        FROM attendance_regularization_requests r
        JOIN employees e ON e.id = r.employee_id
       WHERE e.department IS NOT NULL
         AND ($1::integer IS NULL OR r.company_id = $1)
       ORDER BY e.department
    `, [companyId]);
    res.json(result.rows.map(r => r.department));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy pending list — kept for Approval Center backend compatibility
router.get('/regularize/pending', async (req, res) => {
  try {
    const companyId  = scopeCompanyId(req);

    const actorEmpId = req.user?.employee_id;
    const { department } = req.query;

    let q = `
      SELECT r.*,
             r.date::text      AS date,
             r.check_in::text  AS check_in,
             r.check_out::text AS check_out,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation,
             e.office_id AS emp_code
        FROM attendance_regularization_requests r
        JOIN employees e ON e.id = r.employee_id
       WHERE r.status = 'pending'
         AND ($1::integer IS NULL OR r.company_id = $1)
    `;
    const params = [companyId];
    let n = 2;
    // Same tiering as /regularize/list — see the comment there.
    if (!isAttendanceAdmin(req)) {
      if (actorEmpId == null) {
        return res.status(403).json({
          error: 'Forbidden',
          code: 'EMPLOYEE_LINK_REQUIRED',
          message: 'Your login is not linked to an employee record.',
        });
      }
      q += hasRole(req, 'manager', 'department_head')
        ? ` AND e.reporting_to = $${n++}`
        : ` AND r.employee_id = $${n++}`;
      params.push(actorEmpId);
    }
    if (department) { q += ` AND e.department = $${n++}`; params.push(department); }
    q += ` ORDER BY r.created_at DESC LIMIT 100`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee's own regularization history (used by My Attendance calendar)
router.get('/regularize/:employee_id', async (req, res) => {
  try {
    const companyId   = scopeCompanyId(req);
    const callerEmpId = req.user?.employee_id ?? null;

    if (!isAttendanceAdmin(req)) {
      if (callerEmpId == null) {
        return res.status(403).json({
          error: 'Forbidden',
          code: 'EMPLOYEE_LINK_REQUIRED',
          message: 'Your login is not linked to an employee record.',
        });
      }
      if (String(callerEmpId) !== String(req.params.employee_id)) {
        // Managers may view their direct reports' history
        const managerCheck = await pool.query(
          `SELECT 1 FROM employees WHERE id = $1 AND reporting_to = $2 LIMIT 1`,
          [req.params.employee_id, callerEmpId]
        ).catch(() => ({ rows: [] }));
        if (!managerCheck.rows.length) {
          return res.status(403).json({ error: 'Forbidden: you can only view your own regularization history' });
        }
      }
    }

    const result = await pool.query(`
      SELECT id, employee_id, date::text, check_in::text, check_out::text,
             reason, status, approval_level, manager_remarks, hr_remarks,
             manager_actioned_at, hr_actioned_at, created_at
        FROM attendance_regularization_requests
       WHERE employee_id = $1
         AND ($2::integer IS NULL OR company_id = $2)
       ORDER BY created_at DESC
       LIMIT 30
    `, [req.params.employee_id, companyId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve — 2-level: manager L1 → HR L2 (if configured), applies attendance correction on final approval
router.put('/regularize/:id/approve', requireAttendanceApprover, async (req, res) => {
  try {
    const { remarks }  = req.body;
    const actorId      = req.user?.userId || req.body.actor_id;
    const before       = (await pool.query(
      `SELECT * FROM attendance_regularization_requests WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!before) return res.status(404).json({ error: 'Request not found' });

    // Determine if this needs HR escalation based on approval_level
    const currentLevel = before.approval_level || 'manager';
    // hasRole unions ALL roles held, not just the primary one — an approver
    // holding `hr` as a secondary role was previously treated as a line manager,
    // so their approval escalated instead of completing.
    const isHR = hasRole(req, 'hr', 'hr_manager', 'admin', 'super_admin');

    let newStatus = 'pending';
    let newLevel = 'manager';
    let applyCorrection = false;

    if (currentLevel === 'manager' && isHR) {
      // HR can approve at any level
      newStatus = 'approved'; newLevel = 'done'; applyCorrection = true;
    } else if (currentLevel === 'manager' && !isHR) {
      // Manager L1 approval — actor must be the direct manager or an active delegate.
      // Was guarded by `if (actorEmpId)`, skipping the check for unlinked logins.
      {
        const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'regularization');
        if (decide) return res.status(decide.status).json(decide.body);
      }
      // Escalate to HR if HR approval required
      const wfConfig = await pool.query(
        "SELECT levels FROM attendance_workflow_config WHERE workflow_type='regularization' AND (company_id=$1 OR company_id IS NULL) ORDER BY company_id DESC NULLS LAST LIMIT 1",
        [before.company_id]
      ).catch(() => ({ rows: [] }));
      const levels = wfConfig.rows[0]?.levels || [];
      const needsHR = Array.isArray(levels) && levels.some(l => l.role === 'hr' || l.role === 'hr_manager');
      if (needsHR) {
        newStatus = 'pending'; newLevel = 'hr'; applyCorrection = false;
      } else {
        newStatus = 'approved'; newLevel = 'done'; applyCorrection = true;
      }
    } else if (currentLevel === 'hr' && isHR) {
      newStatus = 'approved'; newLevel = 'done'; applyCorrection = true;
    } else if (currentLevel === 'hr' && !isHR) {
      return res.status(403).json({ error: 'This regularization is pending HR approval' });
    }

    const updated = await pool.query(`
      UPDATE attendance_regularization_requests
         SET status=$2, manager_id=$3, manager_remarks=$4, manager_actioned_at=NOW(),
             approval_level=$5, hr_id=$6, hr_actioned_at=$7
       WHERE id=$1 RETURNING *
    `, [req.params.id, newStatus, actorId, remarks || null, newLevel,
        (newLevel === 'done' && isHR) ? actorId : null,
        (newLevel === 'done' && isHR) ? 'NOW()' : null]);

    if (applyCorrection) {
      // Upsert attendance record — create if absent, correct times if already exists
      await pool.query(`
        INSERT INTO attendance_records
          (employee_id, attendance_date, status, company_id)
        VALUES ($1, $2, 'present', $3)
        ON CONFLICT (employee_id, attendance_date) DO UPDATE
          SET status         = 'present',
              check_in_time  = COALESCE($4::time, attendance_records.check_in_time),
              check_out_time = COALESCE($5::time, attendance_records.check_out_time),
              updated_at     = NOW()
      `, [before.employee_id, before.date, before.company_id,
          before.check_in || null, before.check_out || null]);

      // Recalculate OT if both check_in and check_out times were corrected
      if (before.check_in && before.check_out) {
        try {
          const hoursRes = await pool.query(
            `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS hours`,
            [before.check_out, before.check_in]
          );
          const totalHours = parseFloat(hoursRes.rows[0]?.hours || 0);
          let fullDayHours = 9;
          try {
            const sRow = await pool.query(
              'SELECT full_day_hours FROM attendance_general_settings WHERE company_id=$1 LIMIT 1',
              [before.company_id]
            );
            if (sRow.rows[0]?.full_day_hours) fullDayHours = parseFloat(sRow.rows[0].full_day_hours);
          } catch { /* use default */ }
          const otHours = Math.max(0, totalHours - fullDayHours);
          await pool.query(
            `UPDATE attendance_records SET total_hours=$3, ot_hours=$4 WHERE employee_id=$1 AND attendance_date=$2`,
            [before.employee_id, before.date, totalHours.toFixed(2), otHours.toFixed(2)]
          );
          if (otHours >= 0.5) {
            const otPol = await pool.query(
              `SELECT rules FROM attendance_policies WHERE policy_type='overtime' AND is_active=true AND (company_id=$1 OR company_id IS NULL) ORDER BY company_id DESC NULLS LAST LIMIT 1`,
              [before.company_id]
            ).catch(() => ({ rows: [] }));
            const otRules = otPol.rows[0]?.rules || { requires_approval: true, weekday_multiplier: 1.5 };
            const weekendDaysRec = await getWeekendDays(before.company_id);
            const isWknd   = dayIsWeekend(before.date, weekendDaysRec);
            const holCheck = await pool.query(
              'SELECT 1 FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) LIMIT 1',
              [before.date, before.company_id]
            ).catch(() => ({ rows: [] }));
            let otType = 'weekday';
            let otMult = parseFloat(otRules.weekday_multiplier || 1.5);
            if (holCheck.rows.length > 0) { otType = 'holiday'; otMult = parseFloat(otRules.holiday_multiplier || 2.0); }
            else if (isWknd) { otType = 'weekend'; otMult = parseFloat(otRules.weekend_multiplier || 2.0); }
            await pool.query(`
              INSERT INTO attendance_ot_records
                (company_id, employee_id, attendance_date, ot_hours, ot_type, multiplier, status)
              VALUES ($1,$2,$3,$4,$5,$6,'pending')
              ON CONFLICT (employee_id, attendance_date)
              DO UPDATE SET ot_hours=$4, ot_type=$5, multiplier=$6, status='pending', updated_at=NOW()
            `, [before.company_id, before.employee_id, before.date, otHours.toFixed(2), otType, otMult]);
          }
        } catch { /* non-blocking OT recalc */ }
      }

      await notifyEmployee(before.employee_id, {
        title:   'Regularization Approved',
        message: `Your attendance correction for ${before.date} has been approved.`,
        refId:   before.id,
      });
    }

    // Notify HR users if escalated
    if (newLevel === 'hr') {
      await pool.query(`
        INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
        SELECT u.id, 'Regularization Awaiting HR Approval', $2, 'attendance', $3, 'regularization_hr'
        FROM employees e JOIN users u ON u.employee_id = e.id
        WHERE LOWER(e.status) IN ('active') AND LOWER(COALESCE(e.department,'')) != ''
          AND LOWER(COALESCE(u.role,'')) IN ('hr','hr_admin','hr_manager')
          AND (e.company_id = $1 OR $1::integer IS NULL)
        LIMIT 5
      `, [before.company_id, `Regularization from ${before.date} is awaiting HR approval.`, before.id]).catch(() => {});
    }

    await writeAuditLog({
      companyId: before.company_id, employeeId: before.employee_id,
      action: 'regularize_approved', beforeData: before, afterData: updated.rows[0],
      performedBy: actorId, reason: remarks, req,
    });
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject — records reason, notifies employee
router.put('/regularize/:id/reject', requireAttendanceApprover, async (req, res) => {
  try {
    const { remarks } = req.body;
    const actorId     = req.user?.userId || req.body.actor_id;
    const before      = (await pool.query(
      `SELECT * FROM attendance_regularization_requests WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!before) return res.status(404).json({ error: 'Request not found' });

    // Authorization: same check as approve — HR/admin always allowed; manager must own the reporting line
    // hasRole unions ALL roles held, not just the primary one — an approver
    // holding `hr` as a secondary role was previously treated as a line manager,
    // so their approval escalated instead of completing.
    const isHR = hasRole(req, 'hr', 'hr_manager', 'admin', 'super_admin');
    if (!isHR) {
      // Was guarded by `if (actorEmpId)`, skipping the check for unlinked logins.
      {
        const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'regularization');
        if (decide) return res.status(decide.status).json(decide.body);
      }
    }

    const result = await pool.query(`
      UPDATE attendance_regularization_requests
         SET status              = 'rejected',
             manager_id          = $2,
             manager_remarks     = $3,
             manager_actioned_at = NOW()
       WHERE id = $1
       RETURNING *
    `, [req.params.id, actorId, remarks || null]);

    await notifyEmployee(before.employee_id, {
      title:   'Regularization Rejected',
      message: `Your attendance correction request for ${before.date} was rejected${remarks ? ': ' + remarks : '.'}`,
      refId:   before.id,
    });

    await writeAuditLog({
      companyId: before.company_id, employeeId: before.employee_id,
      action: 'regularize_rejected', beforeData: before, afterData: result.rows[0],
      performedBy: actorId, reason: remarks, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ATTENDANCE POLICIES CRUD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/policies', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      SELECT * FROM attendance_policies
       WHERE (company_id = $1 OR company_id IS NULL)
       ORDER BY company_id DESC NULLS LAST, policy_type, name
    `, [companyId]).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/policies', requireAttendanceAdmin, async (req, res) => {
  try {
    const { policy_type, name, rules } = req.body;
    if (!policy_type || !name) return res.status(400).json({ error: 'policy_type and name required' });
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      INSERT INTO attendance_policies (company_id, policy_type, name, rules, created_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [companyId, policy_type, name, JSON.stringify(rules || {}), req.user?.userId]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/policies/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const { name, rules, is_active } = req.body;
    const result = await pool.query(`
      UPDATE attendance_policies
         SET name=$2, rules=$3, is_active=$4, updated_at=NOW()
       WHERE id=$1 RETURNING *
    `, [req.params.id, name, JSON.stringify(rules || {}), is_active !== false]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Policy not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/policies/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM attendance_policies WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/policies/type/:type — fetch active policy for a type (used by calculations)
router.get('/policies/type/:type', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { type }  = req.params;
    const result = await pool.query(`
      SELECT * FROM attendance_policies
       WHERE policy_type = $1 AND is_active = true
         AND (company_id = $2 OR company_id IS NULL)
       ORDER BY company_id DESC NULLS LAST
       LIMIT 1
    `, [type, companyId]).catch(() => ({ rows: [] }));
    if (!result.rows[0]) return res.status(404).json({ error: 'No active policy of this type' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. GEO-FENCING RULES
// ─────────────────────────────────────────────────────────────────────────────
router.get('/geo-rules', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      SELECT * FROM attendance_geo_rules
       WHERE ($1::integer IS NULL OR company_id = $1)
       ORDER BY rule_type, name
    `, [companyId]).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/geo-rules', requireAttendanceAdmin, async (req, res) => {
  try {
    const { name, location_name, lat, lng, radius_meters, rule_type, is_mandatory,
            applicable_to, applicable_department } = req.body;
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      INSERT INTO attendance_geo_rules
        (company_id, name, location_name, lat, lng, radius_meters, rule_type, is_mandatory,
         applicable_to, applicable_department, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [
      companyId, name, location_name, lat, lng,
      radius_meters || 200, rule_type || 'office', is_mandatory || false,
      applicable_to || 'all',
      applicable_to === 'department' ? (applicable_department || null) : null,
      req.user?.userId,
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/geo-rules/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const { name, location_name, lat, lng, radius_meters, rule_type, is_mandatory, is_active,
            applicable_to, applicable_department } = req.body;
    const result = await pool.query(`
      UPDATE attendance_geo_rules
         SET name=$2, location_name=$3, lat=$4, lng=$5, radius_meters=$6,
             rule_type=$7, is_mandatory=$8, is_active=$9,
             applicable_to=$10, applicable_department=$11, updated_at=NOW()
       WHERE id=$1 RETURNING *
    `, [
      req.params.id, name, location_name, lat, lng, radius_meters,
      rule_type, is_mandatory, is_active !== false,
      applicable_to || 'all',
      applicable_to === 'department' ? (applicable_department || null) : null,
    ]);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/geo-rules/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM attendance_geo_rules WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

// Heatmap — per-employee attendance matrix for a month
router.get('/analytics/heatmap', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year, department } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const pad2 = n => String(n).padStart(2, '0');
    const startDate = `${y}-${pad2(m)}-01`;
    const endDate   = `${y}-${pad2(m)}-${new Date(y, m, 0).getDate()}`;
    const cidClause = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';
    const deptClause = department ? `AND e.department = '${department.replace(/'/g,"''")}'` : '';

    const { rows } = await pool.query(`
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'date', ar.attendance_date,
            'status', ar.status,
            'late_minutes', ar.late_minutes,
            'hours', ar.total_hours
          ) ORDER BY ar.attendance_date
        ) FILTER (WHERE ar.id IS NOT NULL) AS records
      FROM employees e
      LEFT JOIN attendance_records ar
        ON ar.employee_id = e.id
        AND ar.attendance_date BETWEEN $1 AND $2
        AND ar.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active','probation')
        ${cidClause} ${deptClause}
      GROUP BY e.id, e.name, e.first_name, e.last_name, e.department
      ORDER BY e.department, e.name
      LIMIT 100
    `, [startDate, endDate]);

    res.json({ month: m, year: y, start_date: startDate, end_date: endDate, employees: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Absenteeism trends — monthly absenteeism rate for past 12 months
router.get('/analytics/absenteeism', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cidClause = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';

    const { rows } = await pool.query(`
      SELECT
        EXTRACT(YEAR  FROM ar.attendance_date) AS year,
        EXTRACT(MONTH FROM ar.attendance_date) AS month,
        COUNT(*)                                              AS total_records,
        COUNT(*) FILTER (WHERE ar.status = 'absent')          AS absent_count,
        COUNT(*) FILTER (WHERE ar.status = 'present')         AS present_count,
        COUNT(*) FILTER (WHERE ar.status = 'late')            AS late_count,
        COUNT(DISTINCT ar.employee_id)                        AS unique_employees,
        ROUND(
          COUNT(*) FILTER (WHERE ar.status = 'absent')::numeric
          / NULLIF(COUNT(*),0) * 100, 2
        )                                                     AS absenteeism_rate
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      WHERE ar.attendance_date >= NOW() - INTERVAL '12 months'
        AND ar.deleted_at IS NULL
        ${cidClause}
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Department absenteeism breakdown — with prev-month delta and department filter
router.get('/analytics/department-absenteeism', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year, department } = req.query;
    const m      = parseInt(month) || new Date().getMonth() + 1;
    const y      = parseInt(year)  || new Date().getFullYear();
    const prevM  = m === 1 ? 12 : m - 1;
    const prevY  = m === 1 ? y - 1 : y;
    const deptParam = department || null;

    const { rows } = await pool.query(`
      WITH curr AS (
        SELECT
          e.department,
          COUNT(DISTINCT e.id)                              AS total_employees,
          COUNT(*) FILTER (WHERE ar.status = 'present')     AS present_days,
          COUNT(*) FILTER (WHERE ar.status = 'absent')      AS absent_days,
          COUNT(*) FILTER (WHERE ar.status = 'late')        AS late_days,
          COALESCE(SUM(ar.total_hours), 0)                  AS total_hours,
          ROUND(
            COUNT(*) FILTER (WHERE ar.status = 'absent')::numeric
            / NULLIF(COUNT(*), 0) * 100, 2
          ) AS absenteeism_rate
        FROM employees e
        LEFT JOIN attendance_records ar
          ON ar.employee_id = e.id
          AND EXTRACT(MONTH FROM ar.attendance_date) = $1
          AND EXTRACT(YEAR  FROM ar.attendance_date) = $2
          AND ar.deleted_at IS NULL
        WHERE e.deleted_at IS NULL
          AND LOWER(e.status) IN ('active','probation')
          AND ($3::integer IS NULL OR e.company_id = $3)
          AND ($6::text IS NULL OR e.department = $6)
        GROUP BY e.department
      ),
      prev AS (
        SELECT
          e.department,
          ROUND(
            COUNT(*) FILTER (WHERE ar.status = 'absent')::numeric
            / NULLIF(COUNT(*), 0) * 100, 2
          ) AS prev_rate
        FROM employees e
        LEFT JOIN attendance_records ar
          ON ar.employee_id = e.id
          AND EXTRACT(MONTH FROM ar.attendance_date) = $4
          AND EXTRACT(YEAR  FROM ar.attendance_date) = $5
          AND ar.deleted_at IS NULL
        WHERE e.deleted_at IS NULL
          AND LOWER(e.status) IN ('active','probation')
          AND ($3::integer IS NULL OR e.company_id = $3)
          AND ($6::text IS NULL OR e.department = $6)
        GROUP BY e.department
      )
      SELECT c.*, p.prev_rate
      FROM curr c
      LEFT JOIN prev p ON p.department = c.department
      ORDER BY c.absenteeism_rate DESC NULLS LAST
    `, [m, y, companyId, prevM, prevY, deptParam]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Overtime cost analytics
router.get('/analytics/overtime-cost', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();

    const { rows } = await pool.query(`
      SELECT
        e.department,
        COUNT(DISTINCT o.employee_id)                                             AS employees_with_ot,
        ROUND(SUM(o.ot_hours)::numeric, 2)                                        AS total_ot_hours,
        COUNT(*) FILTER (WHERE o.status IN ('approved','auto_approved'))           AS approved_ot,
        COUNT(*) FILTER (WHERE o.status = 'pending')                              AS pending_ot,
        COUNT(*) FILTER (WHERE o.status = 'rejected')                             AS rejected_ot,
        ROUND(AVG(o.multiplier)::numeric, 2)                                      AS avg_multiplier,
        ROUND(
          SUM(
            o.ot_hours::numeric
            * COALESCE(o.multiplier, 1.5)
            * COALESCE(e.basic_salary, 0)::numeric / 26.0 / 9.0
          ) FILTER (WHERE o.status IN ('approved','auto_approved')), 0
        )                                                                          AS approved_ot_cost,
        ROUND(
          SUM(
            o.ot_hours::numeric
            * COALESCE(o.multiplier, 1.5)
            * COALESCE(e.basic_salary, 0)::numeric / 26.0 / 9.0
          ), 0
        )                                                                          AS total_ot_cost
      FROM attendance_ot_records o
      JOIN employees e ON e.id = o.employee_id
      WHERE EXTRACT(MONTH FROM o.attendance_date) = $1
        AND EXTRACT(YEAR  FROM o.attendance_date) = $2
        AND ($3::integer IS NULL OR o.company_id = $3)
      GROUP BY e.department
      ORDER BY total_ot_hours DESC
    `, [m, y, companyId]).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shift efficiency
router.get('/analytics/shift-efficiency', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const cidClause = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';

    const { rows } = await pool.query(`
      SELECT
        s.name AS shift_name, s.start_time, s.end_time,
        COUNT(DISTINCT sa.employee_id) AS assigned_employees,
        COUNT(*) FILTER (WHERE ar.status IN ('present','late')) AS present_count,
        SUM(ar.late_minutes) AS total_late_minutes,
        ROUND(AVG(ar.total_hours) FILTER (WHERE ar.total_hours > 0), 2) AS avg_hours,
        ROUND(
          COUNT(*) FILTER (WHERE ar.status IN ('present','late'))::numeric
          / NULLIF(
              COUNT(DISTINCT sa.employee_id)::numeric
              * EXTRACT(DAY FROM (
                  DATE_TRUNC('month', make_date($2::int, $1::int, 1))
                  + INTERVAL '1 month' - INTERVAL '1 day'
                ))::int,
              0
            ) * 100, 1
        ) AS attendance_rate
      FROM hr_shifts s
      LEFT JOIN hr_shift_assignments sa ON sa.shift_id = s.id AND sa.is_active = true
      LEFT JOIN attendance_records ar
        ON ar.employee_id = sa.employee_id
        AND EXTRACT(MONTH FROM ar.attendance_date) = $1
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $2
        AND ar.deleted_at IS NULL
      LEFT JOIN employees e ON e.id = sa.employee_id
      WHERE s.deleted_at IS NULL ${cidClause}
      GROUP BY s.id, s.name, s.start_time, s.end_time
      ORDER BY attendance_rate DESC NULLS LAST
    `, [m, y]).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distinct department list — used by the analytics department filter dropdown
router.get('/analytics/departments', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      SELECT DISTINCT department
        FROM employees
       WHERE deleted_at IS NULL
         AND department IS NOT NULL AND department <> ''
         AND LOWER(status) IN ('active','probation')
         AND ($1::integer IS NULL OR company_id = $1)
       ORDER BY department
    `, [companyId]);
    res.json(rows.map(r => r.department));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top absentees for the selected month
router.get('/analytics/top-absentees', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year, department, limit } = req.query;
    const m   = parseInt(month) || new Date().getMonth() + 1;
    const y   = parseInt(year)  || new Date().getFullYear();
    const lim = Math.min(parseInt(limit) || 10, 50);
    const params = [m, y, companyId];
    let deptClause = '';
    if (department) { deptClause = `AND e.department = $4`; params.push(department); }

    const { rows } = await pool.query(`
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        COUNT(*) FILTER (WHERE ar.status = 'absent')  AS absent_days,
        COUNT(*) FILTER (WHERE ar.status = 'late')    AS late_days,
        COUNT(*) FILTER (WHERE ar.status = 'present') AS present_days,
        COUNT(ar.id)                                  AS total_records,
        ROUND(
          COUNT(*) FILTER (WHERE ar.status = 'absent')::numeric
          / NULLIF(COUNT(ar.id), 0) * 100, 1
        ) AS absenteeism_rate
      FROM employees e
      LEFT JOIN attendance_records ar
        ON ar.employee_id = e.id
        AND EXTRACT(MONTH FROM ar.attendance_date) = $1
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $2
        AND ar.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active','probation')
        AND ($3::integer IS NULL OR e.company_id = $3)
        ${deptClause}
      GROUP BY e.id, e.name, e.first_name, e.last_name, e.department, e.designation
      HAVING COUNT(*) FILTER (WHERE ar.status = 'absent') > 0
      ORDER BY absent_days DESC, absenteeism_rate DESC
      LIMIT ${lim}
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Perfect attendance — employees with zero absences in the selected month (min 10 days tracked)
router.get('/analytics/perfect-attendance', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year, department } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const params = [m, y, companyId];
    let deptClause = '';
    if (department) { deptClause = `AND e.department = $4`; params.push(department); }

    const { rows } = await pool.query(`
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        COUNT(ar.id)                              AS days_tracked,
        ROUND(COALESCE(SUM(ar.total_hours)::numeric, 0), 1) AS total_hours,
        COUNT(*) FILTER (WHERE ar.status = 'late') AS late_days
      FROM employees e
      JOIN attendance_records ar
        ON ar.employee_id = e.id
        AND EXTRACT(MONTH FROM ar.attendance_date) = $1
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $2
        AND ar.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active','probation')
        AND ($3::integer IS NULL OR e.company_id = $3)
        ${deptClause}
      GROUP BY e.id, e.name, e.first_name, e.last_name, e.department, e.designation
      HAVING COUNT(*) FILTER (WHERE ar.status = 'absent') = 0
         AND COUNT(ar.id) >= 10
      ORDER BY total_hours DESC, days_tracked DESC
      LIMIT 20
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave vs Attendance Reconciliation — GET /attendance/reports/leave-reconciliation
router.get('/reports/leave-reconciliation', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year)  || new Date().getFullYear();
    const department = req.query.department || null;

    // Employees absent in attendance_records but with NO approved leave
    const unapprovedAbsenceQ = await pool.query(`
      SELECT
        ar.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        ar.attendance_date,
        ar.status AS attendance_status,
        'absent_no_leave'                                        AS conflict_type,
        NULL::text                                               AS leave_type
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      WHERE ar.status = 'absent'
        AND ($1::integer IS NULL OR ar.company_id = $1)
        AND EXTRACT(MONTH FROM ar.attendance_date) = $2
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $3
        AND ($4::text IS NULL OR e.department = $4)
        AND ar.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM leave_applications la
           WHERE la.employee_id = ar.employee_id
             AND la.status = 'approved'
             AND ar.attendance_date BETWEEN la.from_date AND la.to_date
        )
      ORDER BY ar.attendance_date, e.department`,
      [companyId, m, y, department]
    );

    // Employees marked present but have approved leave for that date
    const leaveButPresentQ = await pool.query(`
      SELECT
        ar.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        ar.attendance_date,
        ar.status AS attendance_status,
        'present_despite_leave'                                  AS conflict_type,
        la.leave_type
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      JOIN leave_applications la
        ON la.employee_id = ar.employee_id
       AND la.status = 'approved'
       AND ar.attendance_date BETWEEN la.from_date AND la.to_date
      WHERE ar.status IN ('present','half_day','late')
        AND ($1::integer IS NULL OR ar.company_id = $1)
        AND EXTRACT(MONTH FROM ar.attendance_date) = $2
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $3
        AND ($4::text IS NULL OR e.department = $4)
        AND ar.deleted_at IS NULL
      ORDER BY ar.attendance_date, e.department`,
      [companyId, m, y, department]
    );

    const conflicts = [...unapprovedAbsenceQ.rows, ...leaveButPresentQ.rows]
      .sort((a, b) => new Date(a.attendance_date) - new Date(b.attendance_date));

    res.json({
      month: m, year: y,
      total_conflicts: conflicts.length,
      absent_no_leave: unapprovedAbsenceQ.rows.length,
      present_despite_leave: leaveButPresentQ.rows.length,
      conflicts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Early Exit Report — GET /attendance/reports/early-exit
router.get('/reports/early-exit', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year)  || new Date().getFullYear();
    const department = req.query.department || null;
    const minEarlyMins = parseInt(req.query.min_early_minutes) || 15;

    const { rows } = await pool.query(`
      SELECT
        ar.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        ar.attendance_date,
        ar.check_out,
        s.name             AS shift_name,
        s.end_time         AS shift_end_time,
        ROUND(
          EXTRACT(EPOCH FROM (s.end_time::time - ar.check_out::time)) / 60
        )                  AS early_by_minutes
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      JOIN (
        SELECT DISTINCT ON (esa.employee_id) esa.employee_id, esa.shift_id
          FROM hr_shift_assignments esa
         ORDER BY esa.employee_id, esa.effective_from DESC
      ) best ON best.employee_id = ar.employee_id
      JOIN hr_shifts s ON s.id = best.shift_id
      WHERE ar.check_out IS NOT NULL
        AND s.end_time IS NOT NULL
        AND ($1::integer IS NULL OR ar.company_id = $1)
        AND EXTRACT(MONTH FROM ar.attendance_date) = $2
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $3
        AND ($4::text IS NULL OR e.department = $4)
        AND ar.deleted_at IS NULL
        AND NOT s.is_night_shift
        AND ar.check_out::time < s.end_time::time
        AND EXTRACT(EPOCH FROM (s.end_time::time - ar.check_out::time)) / 60 >= $5
      ORDER BY early_by_minutes DESC, ar.attendance_date`,
      [companyId, m, y, department, minEarlyMins]
    );

    const empMap = {};
    rows.forEach(r => {
      if (!empMap[r.employee_id]) {
        empMap[r.employee_id] = {
          employee_id: r.employee_id, employee_name: r.employee_name,
          department: r.department, designation: r.designation,
          exit_count: 0, total_early_minutes: 0, max_early_minutes: 0, dates: [],
        };
      }
      const e = empMap[r.employee_id];
      e.exit_count++;
      e.total_early_minutes += parseInt(r.early_by_minutes) || 0;
      e.max_early_minutes = Math.max(e.max_early_minutes, parseInt(r.early_by_minutes) || 0);
      e.dates.push({ date: r.attendance_date, check_out: r.check_out, shift_end: r.shift_end_time, early_by: r.early_by_minutes, shift_name: r.shift_name });
    });

    const employees = Object.values(empMap).sort((a, b) => b.total_early_minutes - a.total_early_minutes);

    res.json({
      month: m, year: y, min_early_minutes: minEarlyMins,
      total_incidents: rows.length,
      employees_affected: employees.length,
      employees,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/audit-logs', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { action, employee_id, from_date, to_date } = req.query;
    let q = `
      SELECT al.*,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             COALESCE(p.name, CONCAT(p.first_name,' ',p.last_name)) AS performed_by_name
        FROM attendance_audit_logs al
        LEFT JOIN employees e ON e.id = al.employee_id
        LEFT JOIN employees p ON p.id = al.performed_by
       WHERE ($1::integer IS NULL OR al.company_id = $1)
    `;
    const params = [companyId];
    let n = 2;
    if (action)      { q += ` AND al.action = $${n++}`;                   params.push(action); }
    if (employee_id) { q += ` AND al.employee_id = $${n++}`;              params.push(employee_id); }
    if (from_date)   { q += ` AND al.performed_at >= $${n++}`;            params.push(from_date); }
    if (to_date)     { q += ` AND al.performed_at <= $${n++}`;            params.push(to_date + ' 23:59:59'); }
    q += ` ORDER BY al.performed_at DESC LIMIT 500`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. PAYROLL SYNC — freeze attendance, compute LOP per employee, push to payroll
// ─────────────────────────────────────────────────────────────────────────────
router.post('/payroll-sync', requireAttendanceAdmin, async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    if (!['admin', 'super_admin', 'hr_admin', 'hr_manager', 'hr'].includes(role)) {
      return res.status(403).json({ error: 'Only HR Admin or Admin can sync attendance to payroll' });
    }

    const { month, year, force = false, employee_ids } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year required' });
    const m         = parseInt(month);
    const y         = parseInt(year);
    const companyId = scopeCompanyId(req);
    // Optional scoping to specific employees (subset sync)
    const empFilter = Array.isArray(employee_ids) && employee_ids.length > 0
      ? `AND employee_id = ANY(ARRAY[${employee_ids.map(Number).join(',')}]::int[])`
      : '';

    const cidClause = companyId != null ? `AND company_id = ${parseInt(companyId)}` : '';
    const cidEmp    = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';

    if (!force) {
      const already = await pool.query(`
        SELECT COUNT(*) AS cnt FROM attendance_records
         WHERE EXTRACT(MONTH FROM attendance_date) = $1
           AND EXTRACT(YEAR  FROM attendance_date) = $2
           AND payroll_synced = true AND deleted_at IS NULL ${cidClause}
      `, [m, y]);
      const cnt = parseInt(already.rows[0]?.cnt || 0);
      if (cnt > 0) {
        return res.status(409).json({
          error: 'already_synced',
          message: `${cnt} records for ${m}/${y} are already frozen. Pass force:true to re-sync (Admin only).`,
          synced_count: cnt,
        });
      }
    }

    // Step 1 — freeze attendance records (scoped to employee_ids if provided)
    const freezeResult = await pool.query(`
      UPDATE attendance_records
         SET payroll_synced = true, payroll_month = $1, payroll_year = $2,
             is_frozen = true, updated_at = NOW()
       WHERE EXTRACT(MONTH FROM attendance_date) = $1
         AND EXTRACT(YEAR  FROM attendance_date) = $2
         AND deleted_at IS NULL ${cidClause} ${empFilter}
       RETURNING id
    `, [m, y]);

    // Step 2 — freeze approved OT records (same scope)
    await pool.query(`
      UPDATE attendance_ot_records
         SET payroll_synced = true, payroll_month = $1, payroll_year = $2, updated_at = NOW()
       WHERE EXTRACT(MONTH FROM attendance_date) = $1
         AND EXTRACT(YEAR  FROM attendance_date) = $2
         AND status IN ('approved','auto_approved')
         ${companyId != null ? `AND company_id = ${parseInt(companyId)}` : ''}
         ${empFilter}
    `, [m, y]);

    // Step 3 — compute calendar working days (Mon–Fri) for the month
    const daysInMonth = new Date(y, m, 0).getDate();
    let workingDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow !== 0 && dow !== 6) workingDays++;
    }
    const pad2 = n => String(n).padStart(2, '0');
    const startDate = `${y}-${pad2(m)}-01`;
    const endDate   = `${y}-${pad2(m)}-${daysInMonth}`;

    // Subtract company holidays from working days
    const holidayCount = await pool.query(`
      SELECT COUNT(*) AS cnt FROM holidays
       WHERE date BETWEEN $1 AND $2
         AND (company_id = $3 OR company_id IS NULL)
         AND EXTRACT(DOW FROM date) NOT IN (0, 6)
    `, [startDate, endDate, companyId]).then(r => parseInt(r.rows[0]?.cnt || 0)).catch(() => 0);
    workingDays = Math.max(0, workingDays - holidayCount);

    // Step 4 — aggregate per-employee attendance stats
    const { rows: empStats } = await pool.query(`
      SELECT
        e.id AS employee_id,
        COUNT(*) FILTER (WHERE ar.status IN ('present','late')) AS present_days,
        COUNT(*) FILTER (WHERE ar.status = 'absent')           AS absent_days,
        COUNT(*) FILTER (WHERE ar.status = 'wfh')              AS wfh_days,
        COUNT(*) FILTER (WHERE ar.status = 'half_day')         AS half_days,
        COUNT(*) FILTER (WHERE ar.late_minutes > 0)            AS late_count,
        COALESCE(SUM(ar.ot_hours), 0)                          AS ot_hours
      FROM employees e
      LEFT JOIN attendance_records ar
        ON ar.employee_id = e.id
        AND ar.attendance_date BETWEEN $1 AND $2
        AND ar.deleted_at IS NULL
      WHERE LOWER(e.status) IN ('active','probation')
        AND e.deleted_at IS NULL ${cidEmp}
        ${empFilter.replace(/AND employee_id/, 'AND e.id')}
      GROUP BY e.id
    `, [startDate, endDate]);

    // Step 5 — upsert payroll_attendance_summary + patch pending payroll_runs
    const lopSummary = [];
    for (const row of empStats) {
      const presentDays = parseInt(row.present_days || 0);
      const wfhDays     = parseInt(row.wfh_days     || 0);
      const halfDays    = parseInt(row.half_days    || 0);
      const absentDays  = parseInt(row.absent_days  || 0);
      const lateCount   = parseInt(row.late_count   || 0);
      const otHours     = parseFloat(row.ot_hours   || 0);

      // Count approved PAID leave days (exclude LOP leave type — LOP is already absence)
      // leave_applications stores dates as start_date/end_date (not from_date/to_date)
      const approvedLeaveRows = await pool.query(`
        SELECT COALESCE(SUM(
          LEAST(end_date, $3::date) - GREATEST(start_date, $2::date) + 1
        ), 0) AS leave_days
        FROM leave_applications
        WHERE employee_id = $1
          AND status = 'approved'
          AND COALESCE(leave_type, '') NOT IN ('lop', 'loss_of_pay', 'unpaid')
          AND start_date <= $3::date
          AND end_date >= $2::date
      `, [row.employee_id, startDate, endDate]).catch(() => ({ rows: [{ leave_days: 0 }] }));
      const approvedLeaveDays = Math.min(
        parseFloat(approvedLeaveRows.rows[0]?.leave_days || 0),
        workingDays
      );

      // LOP = working days not covered by present + WFH + half-days + approved leave
      const effectivePresent = presentDays + wfhDays + halfDays * 0.5 + approvedLeaveDays;
      const lopDays = Math.max(0, Math.round((workingDays - effectivePresent) * 2) / 2);

      // Night shift allowance: count nights worked this month
      let nightShiftDays = 0;
      try {
        const nightQ = await pool.query(`
          SELECT COUNT(*) AS cnt FROM attendance_records ar
          JOIN hr_shift_assignments sa ON sa.employee_id = ar.employee_id AND sa.is_active=TRUE
          JOIN hr_shifts s ON s.id = sa.shift_id AND s.is_night_shift = TRUE
          WHERE ar.employee_id = $1 AND ar.attendance_date BETWEEN $2 AND $3
            AND ar.status IN ('present','late') AND ar.deleted_at IS NULL
        `, [row.employee_id, startDate, endDate]);
        nightShiftDays = parseInt(nightQ.rows[0]?.cnt || 0);
      } catch { /* non-blocking */ }

      // Post night shift allowance to payroll_runs if any nights worked
      if (nightShiftDays > 0) {
        await pool.query(`
          UPDATE payroll_runs SET night_shift_days = $2, updated_at = NOW()
           WHERE employee_id = $1 AND month = $3 AND year = $4 AND status != 'paid'
        `, [row.employee_id, nightShiftDays, m, y]).catch(() => {});
      }

      lopSummary.push({ employee_id: row.employee_id, lop_days: lopDays });

      await pool.query(`
        INSERT INTO payroll_attendance_summary
          (company_id, employee_id, month, year, working_days, present_days,
           absent_days, late_count, ot_hours, lop_days, wfh_days, half_days,
           leave_days, synced_by, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
        ON CONFLICT (employee_id, month, year)
        DO UPDATE SET
          working_days = $5,  present_days = $6,  absent_days = $7,
          late_count   = $8,  ot_hours     = $9,  lop_days    = $10,
          wfh_days     = $11, half_days    = $12, leave_days  = $13,
          synced_by    = $14, synced_at    = NOW()
      `, [companyId, row.employee_id, m, y, workingDays,
          presentDays, absentDays, lateCount, otHours, lopDays,
          wfhDays, halfDays, approvedLeaveDays,
          req.user?.userId || null]);

      await pool.query(`
        UPDATE payroll_runs SET lop_days = $2, updated_at = NOW()
         WHERE employee_id = $1 AND month = $3 AND year = $4 AND status != 'paid'
      `, [row.employee_id, lopDays, m, y]);
    }

    await writeAuditLog({
      companyId, action: 'payroll_sync',
      afterData: {
        month: m, year: y,
        records_synced:      freezeResult.rows.length,
        employees_processed: empStats.length,
        working_days:        workingDays,
      },
      performedBy: req.user?.userId, req,
    });

    res.json({
      success:             true,
      records_synced:      freezeResult.rows.length,
      employees_processed: empStats.length,
      working_days:        workingDays,
      month: m, year: y,
      lop_summary:         lopSummary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/sync-status?month=&year= — last payroll sync details for the period
router.get('/sync-status', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year)  || new Date().getFullYear();

    const { rows } = await pool.query(`
      SELECT al.performed_at, al.after_data,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS synced_by_name
        FROM attendance_audit_logs al
        LEFT JOIN employees e ON e.id = al.performed_by
       WHERE al.action = 'payroll_sync'
         AND ($1::integer IS NULL OR al.company_id = $1)
         AND (al.after_data->>'month')::int = $2
         AND (al.after_data->>'year')::int  = $3
       ORDER BY al.performed_at DESC
       LIMIT 1
    `, [companyId, m, y]).catch(() => ({ rows: [] }));

    if (!rows.length) return res.json({ synced: false, month: m, year: y });

    const r = rows[0];
    res.json({
      synced:              true,
      month:               m,
      year:                y,
      synced_at:           r.performed_at,
      synced_by_name:      r.synced_by_name || 'Admin',
      records_synced:      r.after_data?.records_synced      || 0,
      employees_processed: r.after_data?.employees_processed || 0,
      working_days:        r.after_data?.working_days        || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. SHIFT OCCUPANCY — real-time shift fill rate
// ─────────────────────────────────────────────────────────────────────────────
router.get('/shift-occupancy', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const cidClause = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';

    const result = await pool.query(`
      SELECT
        s.id AS shift_id, s.name AS shift_name,
        s.start_time, s.end_time, s.color,
        COUNT(DISTINCT sa.employee_id)                                             AS capacity,
        COUNT(DISTINCT ar.employee_id) FILTER (WHERE LOWER(ar.status) IN ('present','late')) AS present,
        COUNT(DISTINCT ar.employee_id) FILTER (WHERE LOWER(ar.status) = 'absent')  AS absent,
        ROUND(
          COUNT(DISTINCT ar.employee_id) FILTER (WHERE LOWER(ar.status) IN ('present','late'))::numeric
          / NULLIF(COUNT(DISTINCT sa.employee_id), 0) * 100, 1
        ) AS utilization_pct
      FROM hr_shifts s
      LEFT JOIN hr_shift_assignments sa ON sa.shift_id = s.id AND sa.is_active = true
      LEFT JOIN employees e ON e.id = sa.employee_id AND e.deleted_at IS NULL ${cidClause}
      LEFT JOIN attendance_records ar ON ar.employee_id = sa.employee_id
        AND ar.attendance_date = $1 AND ar.deleted_at IS NULL
      WHERE s.deleted_at IS NULL
      GROUP BY s.id, s.name, s.start_time, s.end_time, s.color
      ORDER BY s.start_time
    `, [targetDate]).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. WORK-CENTRE ATTENDANCE (Manufacturing)
// ─────────────────────────────────────────────────────────────────────────────

function wcTimeToMins(t) {
  if (!t) return -1;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

async function calcWcHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const hr = await pool.query(`
    SELECT CASE
      WHEN $1::time >= $2::time
        THEN EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600
      ELSE (86400 + EXTRACT(EPOCH FROM ($1::time - $2::time))) / 3600
    END AS hours
  `, [checkOut, checkIn]);
  return parseFloat(hr.rows[0]?.hours || 0).toFixed(2);
}

// List active work centres for the attendance dropdown
router.get('/work-centres', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      SELECT id, name, capacity_hours_per_day, cost_per_hour, department, status
        FROM work_centres
       WHERE status = 'active'
         AND (company_id = $1 OR company_id IS NULL)
       ORDER BY name
    `, [companyId]).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a work centre from the attendance UI
router.post('/work-centres', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { name, capacity_hours_per_day = 8, cost_per_hour = 0, department } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO work_centres (company_id, name, capacity_hours_per_day, cost_per_hour, department)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [companyId, String(name).trim(), capacity_hours_per_day, cost_per_hour, department || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /attendance/work-centres/:id — edit work centre definition
router.put('/work-centres/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const { name, capacity_hours_per_day, cost_per_hour, department } = req.body;
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(
      `UPDATE work_centres SET name=$1, capacity_hours_per_day=$2, cost_per_hour=$3, department=$4, updated_at=NOW()
        WHERE id=$5 AND (company_id=$6 OR company_id IS NULL) RETURNING *`,
      [name, capacity_hours_per_day || 8, cost_per_hour || 0, department || null, req.params.id, companyId]
    ).catch(() => ({ rows: [] }));
    if (!rows[0]) return res.status(404).json({ error: 'Work centre not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Soft-delete a work centre
router.delete('/work-centres/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    await pool.query(
      `UPDATE work_centres SET status='inactive'
        WHERE id=$1 AND (company_id=$2 OR company_id IS NULL)`,
      [req.params.id, companyId]
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attendance logs for a given date
router.get('/work-centre', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { date, work_centre_id } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    let q = `
      SELECT wca.*,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation,
             s.name AS shift_name
        FROM work_centre_attendance wca
        JOIN employees e ON e.id = wca.employee_id
        LEFT JOIN hr_shifts s ON s.id = wca.shift_id
       WHERE wca.attendance_date = $1
         AND ($2::integer IS NULL OR wca.company_id = $2)
    `;
    const params = [targetDate, companyId];
    let n = 3;
    if (work_centre_id) { q += ` AND wca.work_centre_id = $${n++}`; params.push(work_centre_id); }
    q += ` ORDER BY wca.work_centre_name, e.name`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log work-centre attendance and sync presence to attendance_records for payroll
router.post('/work-centre', requireAttendanceAdmin, async (req, res) => {
  try {
    const { employee_id, work_centre_id, work_centre_name, production_order_id,
            shift_id, date, check_in, check_out, units_produced, remarks } = req.body;

    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    if (!work_centre_name && !work_centre_id) return res.status(400).json({ error: 'work_centre is required' });
    if (units_produced != null && Number(units_produced) < 0) {
      return res.status(400).json({ error: 'units_produced cannot be negative' });
    }
    if (check_in && check_out) {
      const diff = wcTimeToMins(check_out) - wcTimeToMins(check_in);
      if (diff < 0 && Math.abs(diff) < 720) {
        return res.status(400).json({ error: 'Check-out must be after check-in' });
      }
    }

    const companyId  = scopeCompanyId(req);
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const hoursWorked = await calcWcHours(check_in, check_out);

    let wcName = work_centre_name || null;
    if (!wcName && work_centre_id) {
      const wc = await pool.query('SELECT name FROM work_centres WHERE id=$1', [work_centre_id])
        .catch(() => ({ rows: [] }));
      wcName = wc.rows[0]?.name || null;
    }

    const result = await pool.query(`
      INSERT INTO work_centre_attendance
        (company_id, employee_id, work_centre_id, work_centre_name, production_order_id,
         shift_id, attendance_date, check_in, check_out, hours_worked, units_produced, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [companyId, employee_id, work_centre_id || null, wcName, production_order_id || null,
        shift_id || null, targetDate, check_in || null, check_out || null,
        hoursWorked, parseInt(units_produced) || 0, remarks || null]);

    await pool.query(`
      INSERT INTO attendance_records
        (company_id, employee_id, attendance_date, check_in_time, check_out_time,
         total_hours, status, work_mode)
      VALUES ($1,$2,$3,$4,$5,$6,'present','factory')
      ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
        status         = 'present',
        work_mode      = 'factory',
        check_in_time  = COALESCE(attendance_records.check_in_time,  EXCLUDED.check_in_time),
        check_out_time = COALESCE(EXCLUDED.check_out_time, attendance_records.check_out_time),
        total_hours    = COALESCE(EXCLUDED.total_hours,    attendance_records.total_hours),
        updated_at     = NOW()
    `, [companyId, employee_id, targetDate,
        check_in || null, check_out || null,
        hoursWorked ? parseFloat(hoursWorked) : null]).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a work-centre attendance record
router.put('/work-centre/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const { work_centre_id, work_centre_name, shift_id,
            check_in, check_out, units_produced, remarks } = req.body;

    if (units_produced != null && Number(units_produced) < 0) {
      return res.status(400).json({ error: 'units_produced cannot be negative' });
    }
    if (check_in && check_out) {
      const diff = wcTimeToMins(check_out) - wcTimeToMins(check_in);
      if (diff < 0 && Math.abs(diff) < 720) {
        return res.status(400).json({ error: 'Check-out must be after check-in' });
      }
    }

    const companyId   = scopeCompanyId(req);
    const hoursWorked = await calcWcHours(check_in, check_out);

    const result = await pool.query(`
      UPDATE work_centre_attendance SET
        work_centre_id   = $1,
        work_centre_name = $2,
        shift_id         = $3,
        check_in         = $4,
        check_out        = $5,
        hours_worked     = $6,
        units_produced   = $7,
        remarks          = $8,
        updated_at       = NOW()
      WHERE id = $9 AND ($10::integer IS NULL OR company_id = $10)
      RETURNING *
    `, [work_centre_id || null, work_centre_name || null, shift_id || null,
        check_in || null, check_out || null, hoursWorked,
        parseInt(units_produced) || 0, remarks || null,
        req.params.id, companyId]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Record not found' });

    const rec = result.rows[0];
    if (rec.check_in || rec.check_out) {
      await pool.query(`
        UPDATE attendance_records SET
          check_in_time  = COALESCE($1, check_in_time),
          check_out_time = COALESCE($2, check_out_time),
          total_hours    = COALESCE($3, total_hours),
          updated_at     = NOW()
        WHERE employee_id = $4 AND attendance_date = $5
          AND ($6::integer IS NULL OR company_id = $6)
      `, [rec.check_in || null, rec.check_out || null,
          hoursWorked ? parseFloat(hoursWorked) : null,
          rec.employee_id, rec.attendance_date, companyId]).catch(() => {});
    }

    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a work-centre attendance record
router.delete('/work-centre/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const result = await pool.query(
      `DELETE FROM work_centre_attendance
        WHERE id = $1 AND ($2::integer IS NULL OR company_id = $2)
       RETURNING id`,
      [req.params.id, companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Record not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Work Centre Analytics — GET /attendance/work-centre/analytics
router.get('/work-centre/analytics', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const today    = new Date().toISOString().slice(0, 10);
    const sevenAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const fromDate = req.query.from_date || sevenAgo;
    const toDate   = req.query.to_date   || today;

    const [wcRes, shiftRes, topRes] = await Promise.all([
      pool.query(
        `SELECT
           wca.work_centre_id,
           wca.work_centre_name,
           COUNT(DISTINCT wca.attendance_date)                                          AS active_days,
           ROUND(COALESCE(SUM(wca.hours_worked),0)::numeric, 2)                        AS total_hours,
           COALESCE(SUM(wca.units_produced),0)                                         AS total_units,
           COUNT(DISTINCT wca.employee_id)                                             AS unique_employees,
           CASE WHEN SUM(wca.hours_worked) > 0
                THEN ROUND((SUM(wca.units_produced)/SUM(wca.hours_worked))::numeric, 2)
                ELSE 0 END                                                             AS units_per_hour,
           COALESCE(MAX(wc.capacity_hours_per_day),8)                                  AS capacity_hours_per_day,
           COALESCE(MAX(wc.cost_per_hour),0)                                           AS cost_per_hour
         FROM work_centre_attendance wca
         LEFT JOIN work_centres wc ON wc.id = wca.work_centre_id
         WHERE ($1::integer IS NULL OR wca.company_id = $1)
           AND wca.attendance_date BETWEEN $2 AND $3
         GROUP BY wca.work_centre_id, wca.work_centre_name
         ORDER BY total_units DESC NULLS LAST`,
        [companyId, fromDate, toDate]
      ),
      pool.query(
        `SELECT
           COALESCE(shift_name,'Unassigned')                      AS shift_name,
           ROUND(COALESCE(SUM(hours_worked),0)::numeric, 2)       AS total_hours,
           COALESCE(SUM(units_produced),0)                        AS total_units,
           COUNT(DISTINCT employee_id)                            AS unique_employees
         FROM work_centre_attendance
         WHERE ($1::integer IS NULL OR company_id = $1)
           AND attendance_date BETWEEN $2 AND $3
         GROUP BY shift_name
         ORDER BY total_hours DESC NULLS LAST`,
        [companyId, fromDate, toDate]
      ),
      pool.query(
        `SELECT
           COALESCE(e.name, e.first_name||' '||e.last_name)      AS employee_name,
           e.designation,
           COALESCE(SUM(wca.units_produced),0)                    AS total_units,
           ROUND(COALESCE(SUM(wca.hours_worked),0)::numeric, 2)   AS total_hours
         FROM work_centre_attendance wca
         JOIN employees e ON e.id = wca.employee_id
         WHERE ($1::integer IS NULL OR wca.company_id = $1)
           AND wca.attendance_date BETWEEN $2 AND $3
           AND wca.units_produced > 0
         GROUP BY wca.employee_id, e.name, e.first_name, e.last_name, e.designation
         ORDER BY total_units DESC
         LIMIT 10`,
        [companyId, fromDate, toDate]
      ),
    ]);

    const workCentres = wcRes.rows.map(r => {
      const activeDays    = parseInt(r.active_days)  || 1;
      const capHours      = parseFloat(r.capacity_hours_per_day) || 8;
      const uniqueEmp     = parseInt(r.unique_employees) || 1;
      const totalCapacity = activeDays * capHours * uniqueEmp;
      const totalHours    = parseFloat(r.total_hours) || 0;
      const utilization   = totalCapacity > 0 ? Math.min(100, Math.round((totalHours / totalCapacity) * 100)) : 0;
      const costPerHr     = parseFloat(r.cost_per_hour) || 0;
      const totalUnits    = parseInt(r.total_units) || 0;
      const laborCostPerUnit = costPerHr > 0 && totalUnits > 0
        ? Math.round((costPerHr * totalHours) / totalUnits)
        : null;
      return { ...r, utilization_pct: utilization, labor_cost_per_unit: laborCostPerUnit };
    });

    const summary = {
      total_units:          workCentres.reduce((s,r) => s + parseInt(r.total_units||0), 0),
      total_hours:          workCentres.reduce((s,r) => s + parseFloat(r.total_hours||0), 0).toFixed(2),
      avg_utilization:      workCentres.length
        ? Math.round(workCentres.reduce((s,r) => s + r.utilization_pct, 0) / workCentres.length) : 0,
      active_work_centres:  workCentres.length,
    };

    res.json({ from_date: fromDate, to_date: toDate, summary, work_centres: workCentres, shifts: shiftRes.rows, top_performers: topRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. CONTRACT LABOUR
// ─────────────────────────────────────────────────────────────────────────────

// Derived status: inactive → expired → expiring (≤30d) → active
const CL_STATUS = `
  CASE
    WHEN NOT cl.is_active                                                          THEN 'inactive'
    WHEN cl.contract_expiry IS NOT NULL AND cl.contract_expiry < CURRENT_DATE     THEN 'expired'
    WHEN cl.contract_expiry IS NOT NULL
         AND cl.contract_expiry <= CURRENT_DATE + INTERVAL '30 days'              THEN 'expiring'
    ELSE 'active'
  END
`;

// compliance_ok: active + contract valid + safety cert valid
const CL_COMPLIANCE = `(
  cl.is_active
  AND (cl.contract_expiry IS NULL OR cl.contract_expiry >= CURRENT_DATE)
  AND cl.safety_certified
  AND (cl.safety_cert_expiry IS NULL OR cl.safety_cert_expiry >= CURRENT_DATE)
)`;

router.get('/contract-labour/stats', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active
          AND (contract_expiry IS NULL OR contract_expiry > CURRENT_DATE + INTERVAL '30 days'))         AS active,
        COUNT(*) FILTER (WHERE is_active
          AND contract_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days')               AS expiring,
        COUNT(*) FILTER (WHERE contract_expiry < CURRENT_DATE)                                          AS expired,
        COUNT(*) FILTER (WHERE NOT safety_certified
          OR (safety_cert_expiry IS NOT NULL AND safety_cert_expiry < CURRENT_DATE))                    AS no_safety_cert,
        COUNT(*) FILTER (WHERE NOT COALESCE(pf_member,  false))                                         AS no_pf,
        COUNT(*) FILTER (WHERE NOT COALESCE(esi_covered, false))                                        AS no_esi,
        COUNT(*)                                                                                         AS total
      FROM contract_labour
      WHERE ($1::integer IS NULL OR company_id = $1)
    `, [companyId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/contract-labour', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { status, search } = req.query;
    const params = [companyId];
    let extraWhere = '';

    if (status && status !== 'all') {
      if (status === 'active') {
        extraWhere += ` AND cl.is_active = true AND (cl.contract_expiry IS NULL OR cl.contract_expiry > CURRENT_DATE + INTERVAL '30 days')`;
      } else if (status === 'expiring') {
        extraWhere += ` AND cl.is_active = true AND cl.contract_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`;
      } else if (status === 'expired') {
        extraWhere += ` AND cl.contract_expiry < CURRENT_DATE`;
      } else if (status === 'inactive') {
        extraWhere += ` AND cl.is_active = false`;
      }
    }

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      extraWhere += ` AND (cl.employee_name ILIKE $${n} OR cl.contractor_company ILIKE $${n} OR cl.designation ILIKE $${n} OR COALESCE(cl.branch,'') ILIKE $${n})`;
    }

    const result = await pool.query(`
      SELECT cl.id, cl.company_id, cl.contractor_company, cl.employee_name, cl.employee_code,
             CASE WHEN cl.aadhar_number IS NOT NULL
                  THEN CONCAT('XXXX-XXXX-', RIGHT(REGEXP_REPLACE(cl.aadhar_number, '[^0-9]','','g'), 4))
                  ELSE NULL END AS aadhar_number,
             cl.designation, cl.branch, cl.shift_id, cl.contract_start, cl.contract_expiry,
             cl.safety_certified, cl.safety_cert_expiry, cl.pf_member, cl.esi_covered,
             cl.contact_phone, cl.notes, cl.is_active, cl.created_at, cl.updated_at,
             s.name AS shift_name,
             ${CL_STATUS}     AS status,
             ${CL_COMPLIANCE} AS compliance_ok
        FROM contract_labour cl
        LEFT JOIN hr_shifts s ON s.id = cl.shift_id
       WHERE ($1::integer IS NULL OR cl.company_id = $1)${extraWhere}
       ORDER BY cl.contractor_company, cl.employee_name
    `, params).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/contract-labour', requireAttendanceAdmin, async (req, res) => {
  try {
    const {
      contractor_company, employee_name, employee_code, aadhar_number,
      designation, branch, shift_id, contract_start, contract_expiry,
      safety_certified, safety_cert_expiry, pf_member, esi_covered,
      contact_phone, notes,
    } = req.body;
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      INSERT INTO contract_labour
        (company_id, contractor_company, employee_name, employee_code, aadhar_number,
         designation, branch, shift_id, contract_start, contract_expiry,
         safety_certified, safety_cert_expiry, pf_member, esi_covered,
         contact_phone, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
    `, [
      companyId, contractor_company, employee_name,
      employee_code || null, aadhar_number || null,
      designation || null, branch || null,
      shift_id || null, contract_start || null, contract_expiry || null,
      safety_certified || false, safety_cert_expiry || null,
      pf_member || false, esi_covered || false,
      contact_phone || null, notes || null,
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/contract-labour/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const {
      contractor_company, employee_name, employee_code, aadhar_number,
      designation, branch, shift_id, contract_start, contract_expiry,
      safety_certified, safety_cert_expiry, pf_member, esi_covered,
      is_active, contact_phone, notes,
    } = req.body;
    const result = await pool.query(`
      UPDATE contract_labour
         SET contractor_company=$2,   employee_name=$3,       employee_code=$4,
             aadhar_number=$5,        designation=$6,         branch=$7,
             shift_id=$8,             contract_start=$9,      contract_expiry=$10,
             safety_certified=$11,    safety_cert_expiry=$12,
             pf_member=$13,           esi_covered=$14,
             is_active=$15,           contact_phone=$16,      notes=$17,
             updated_at=NOW()
       WHERE id=$1 RETURNING *
    `, [
      req.params.id,
      contractor_company, employee_name,
      employee_code || null, aadhar_number || null,
      designation || null, branch || null,
      shift_id || null, contract_start || null, contract_expiry || null,
      safety_certified || false, safety_cert_expiry || null,
      pf_member || false, esi_covered || false,
      is_active !== false, contact_phone || null, notes || null,
    ]);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/contract-labour/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM contract_labour WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. MONTHLY REPORT + LATE ARRIVALS + TRENDS
// ─────────────────────────────────────────────────────────────────────────────

// GET /attendance/departments — distinct department list for filter dropdowns
router.get('/departments', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      SELECT DISTINCT department
        FROM employees
       WHERE department IS NOT NULL
         AND deleted_at IS NULL
         AND LOWER(status) IN ('active','probation')
         AND ($1::integer IS NULL OR company_id = $1)
       ORDER BY department
    `, [companyId]);
    res.json(rows.map(r => r.department));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/late-arrivals/export — server-side CSV (honours all filters)
router.get('/late-arrivals/export', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const records   = await attendanceRepository.getLateArrivals({ ...req.query, company_id: companyId });

    const headers = ['Employee', 'Department', 'Date', 'Scheduled In', 'Actual Check-in', 'Delay (mins)', 'Occurrence #'];
    const csvRows = records.map(r => [
      r.employee_name || '',
      r.department || '',
      String(r.attendance_date || '').slice(0, 10),
      String(r.scheduled_time || '09:00').slice(0, 5),
      r.check_in_time ? String(r.check_in_time).slice(0, 5) : '',
      r.late_minutes || 0,
      r.occurrence_rank || '',
    ]);

    const csv = [headers, ...csvRows]
      .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
      `attachment; filename="late-arrivals-${req.query.start_date || 'report'}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/late-arrivals/warnings — warnings issued for a given month
router.get('/late-arrivals/warnings', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, employee_id } = req.query;
    let q = `
      SELECT w.*,
             COALESCE(i.name, CONCAT(i.first_name,' ',COALESCE(i.last_name,''))) AS issued_by_name
        FROM attendance_late_warnings w
        LEFT JOIN employees i ON i.id = w.issued_by
       WHERE ($1::integer IS NULL OR w.company_id = $1)
    `;
    const params = [companyId];
    let n = 2;
    if (month)       { q += ` AND w.month = $${n++}`;       params.push(month); }
    if (employee_id) { q += ` AND w.employee_id = $${n++}`; params.push(employee_id); }
    q += ` ORDER BY w.created_at DESC LIMIT 200`;
    const { rows } = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /attendance/late-arrivals/warning — issue a formal late-arrival warning
router.post('/late-arrivals/warning', requireAttendanceOperator, async (req, res) => {
  try {
    const { employee_id, employee_name, department, month, late_count, warning_text } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const companyId = scopeCompanyId(req);
    const issuedBy  = req.user?.userId;

    const { rows: [warning] } = await pool.query(`
      INSERT INTO attendance_late_warnings
        (company_id, employee_id, employee_name, department, issued_by, month, late_count, warning_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [companyId, employee_id, employee_name, department, issuedBy, month, late_count, warning_text]);

    // Notify the employee (fire-and-forget)
    pool.query(
      `SELECT user_id FROM employees WHERE id = $1 AND user_id IS NOT NULL`,
      [employee_id]
    ).then(r => {
      if (!r.rows[0]?.user_id) return;
      return pool.query(`
        INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
        VALUES ($1,$2,$3,'attendance',$4,'warning_issued')
      `, [
        r.rows[0].user_id,
        'Attendance Warning Issued',
        `A formal warning has been issued for ${late_count} late arrival(s) in ${month}.`,
        employee_id,
      ]);
    }).catch(() => {});

    res.status(201).json(warning);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/late-arrivals', async (req, res) => {
  try {
    const companyId  = scopeCompanyId(req);
    const lateArrivals = await attendanceRepository.getLateArrivals({ ...req.query, company_id: companyId });
    res.json(lateArrivals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/monthly-report', async (req, res) => {
  try {
    const companyId  = scopeCompanyId(req);
    const { month, year, department } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const pad2 = n => String(n).padStart(2, '0');
    const daysInMonth = new Date(y, m, 0).getDate();
    const startDate = `${y}-${pad2(m)}-01`;
    const endDate   = `${y}-${pad2(m)}-${daysInMonth}`;

    // Calendar working days (Mon–Fri) for the month — same for all employees
    let workingDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow !== 0 && dow !== 6) workingDays++;
    }

    const params = [startDate, endDate];
    let deptClause = '';
    if (department) { deptClause = ` AND e.department = $3`; params.push(department); }
    const cidClause = companyId != null ? ` AND e.company_id = ${parseInt(companyId)}` : '';

    const { rows } = await pool.query(`
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        e.joining_date,
        COUNT(*) FILTER (WHERE ar.status IN ('present','late')) AS present_days,
        COUNT(*) FILTER (WHERE ar.status = 'absent')           AS absent_days,
        COUNT(*) FILTER (WHERE ar.status = 'late')             AS late_days,
        COUNT(*) FILTER (WHERE ar.status = 'half_day')         AS half_days,
        COUNT(*) FILTER (WHERE ar.status = 'wfh')              AS wfh_days,
        COUNT(*) FILTER (WHERE ar.late_minutes > 0)            AS late_arrivals,
        COALESCE(SUM(ar.late_minutes), 0)                      AS total_late_minutes,
        COALESCE(SUM(ar.total_hours), 0)                       AS total_hours,
        COALESCE(SUM(ar.ot_hours), 0)                          AS total_ot_hours,
        ROUND(COALESCE(AVG(ar.total_hours) FILTER (WHERE ar.total_hours IS NOT NULL), 0)::numeric, 1) AS avg_hours,
        MIN(ar.check_in_time)::text                            AS earliest_checkin,
        MAX(ar.check_in_time)::text                            AS latest_checkin,
        BOOL_OR(ar.payroll_synced)                             AS payroll_synced
      FROM employees e
      LEFT JOIN attendance_records ar
        ON ar.employee_id = e.id
        AND ar.attendance_date BETWEEN $1 AND $2
        AND ar.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active','probation')
        ${deptClause}${cidClause}
      GROUP BY e.id, e.name, e.first_name, e.last_name, e.department, e.designation, e.joining_date
      ORDER BY late_arrivals DESC, total_late_minutes DESC
    `, params);

    // Enrich each row with working_days, lop_days, attendance_pct, and mid-month joiner proration
    const records = rows.map(r => {
      // Proration for mid-month joiners
      let effectiveWorkingDays = workingDays;
      let isMidMonthJoiner     = false;
      if (r.joining_date) {
        const jd = new Date(r.joining_date);
        if (jd.getFullYear() === y && jd.getMonth() + 1 === m && jd.getDate() > 1) {
          isMidMonthJoiner = true;
          // Count working days from joining date to end of month
          let proratedDays = 0;
          for (let d = jd.getDate(); d <= daysInMonth; d++) {
            const dow = new Date(y, m - 1, d).getDay();
            if (dow !== 0 && dow !== 6) proratedDays++;
          }
          effectiveWorkingDays = proratedDays;
        }
      }
      const present   = parseInt(r.present_days || 0);
      const wfh       = parseInt(r.wfh_days     || 0);
      const half      = parseInt(r.half_days    || 0);
      const effective = present + wfh + half * 0.5;
      const lopDays   = Math.max(0, Math.round((effectiveWorkingDays - effective) * 2) / 2);
      const attPct    = effectiveWorkingDays > 0 ? Math.round((effective / effectiveWorkingDays) * 100) : 0;
      return {
        ...r,
        working_days: workingDays,
        prorated_working_days: effectiveWorkingDays,
        is_mid_month_joiner: isMidMonthJoiner,
        lop_days: lopDays,
        attendance_pct: attPct,
      };
    });

    res.json({ month: m, year: y, working_days: workingDays, start_date: startDate, end_date: endDate, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trend/:employee_id', async (req, res) => {
  try {
    // Ownership guard: employees can only view their own trend
    const reqEmpId = req.params.employee_id;
    const ownership = assertSelfOrPrivileged(req, reqEmpId);
    if (ownership) return res.status(ownership.status).json(ownership.body);
    const { year } = req.query;
    const trend = await attendanceRepository.getMonthlyTrend(
      reqEmpId,
      year || new Date().getFullYear(),
      scopeCompanyId(req)
    );
    res.json(trend);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SHIFT MANAGEMENT — attendance-module-owned shift CRUD + employee assignment
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS ot_eligible        BOOLEAN        DEFAULT TRUE;
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS weekly_off         JSONB          DEFAULT '["Sat","Sun"]';
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS capacity           INTEGER        DEFAULT 0;
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS is_night_shift     BOOLEAN        DEFAULT FALSE;
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS break_duration     INTEGER        DEFAULT 30;
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS company_id         INTEGER;
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ;
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS half_day_hours     NUMERIC(4,2)   DEFAULT 4;
      ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS role_grace_minutes JSONB          DEFAULT '{}';
      ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS selfie_url TEXT;
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS geo_settings        JSONB DEFAULT '{}';
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS device_settings     JSONB DEFAULT '{}';
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS report_settings     JSONB DEFAULT '{}';
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS workcentre_settings JSONB DEFAULT '{}';
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS work_start_time     TIME DEFAULT '09:00';
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS work_end_time       TIME DEFAULT '18:00';
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS break_duration      INTEGER DEFAULT 60;
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS min_working_hours   NUMERIC(4,2) DEFAULT 9.0;
      ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS weekend_days        JSONB DEFAULT '["saturday","sunday"]';
      ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS wfh_days   INTEGER     NOT NULL DEFAULT 0;
      ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS half_days  INTEGER     NOT NULL DEFAULT 0;
      ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS leave_days NUMERIC(5,1) NOT NULL DEFAULT 0;
      ALTER TABLE hr_shift_rotations ADD COLUMN IF NOT EXISTS week_3_shift_id INTEGER REFERENCES hr_shifts(id);
      ALTER TABLE hr_shift_rotations ADD COLUMN IF NOT EXISTS week_4_shift_id INTEGER REFERENCES hr_shifts(id);
      ALTER TABLE compensatory_off ADD COLUMN IF NOT EXISTS auto_granted BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE TABLE IF NOT EXISTS attendance_approval_delegations (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER,
        delegator_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        delegate_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        from_date    DATE NOT NULL,
        to_date      DATE NOT NULL,
        delegation_type TEXT NOT NULL DEFAULT 'all',
        reason       TEXT,
        is_active    BOOLEAN NOT NULL DEFAULT TRUE,
        created_by   INTEGER,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (delegator_id, from_date, to_date)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_face_settings (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER,
        settings    JSONB NOT NULL DEFAULT '{}',
        updated_by  INTEGER,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payroll_attendance_summary (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER,
        employee_id  INTEGER NOT NULL,
        month        INTEGER NOT NULL,
        year         INTEGER NOT NULL,
        working_days INTEGER NOT NULL DEFAULT 0,
        present_days INTEGER NOT NULL DEFAULT 0,
        absent_days  INTEGER NOT NULL DEFAULT 0,
        late_count   INTEGER NOT NULL DEFAULT 0,
        ot_hours     NUMERIC(8,2) NOT NULL DEFAULT 0,
        lop_days     NUMERIC(5,1) NOT NULL DEFAULT 0,
        wfh_days     INTEGER NOT NULL DEFAULT 0,
        half_days    INTEGER NOT NULL DEFAULT 0,
        leave_days   NUMERIC(5,1) NOT NULL DEFAULT 0,
        synced_by    INTEGER,
        synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(employee_id, month, year)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS face_templates (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL DEFAULT 0,
        employee_id INTEGER NOT NULL,
        enrolled_by INTEGER,
        enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        notes       TEXT,
        UNIQUE (company_id, employee_id)
      )
    `);
    // descriptor = 128-float face embedding (from browser face-api). Nullable so
    // legacy HR "flag-only" enrollments keep working; real recognition needs it.
    await pool.query(`ALTER TABLE face_templates ADD COLUMN IF NOT EXISTS descriptor JSONB`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS face_locked_accounts (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL DEFAULT 0,
        employee_id  INTEGER NOT NULL,
        fail_count   INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        last_attempt TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (company_id, employee_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_workflow_config (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER,
        workflow_type   VARCHAR(60) NOT NULL,
        levels          JSONB NOT NULL DEFAULT '[]',
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by      INTEGER,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, workflow_type)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_general_settings (
        id                SERIAL PRIMARY KEY,
        company_id        INTEGER UNIQUE,
        working_days      JSONB   DEFAULT '["monday","tuesday","wednesday","thursday","friday"]',
        timezone          VARCHAR(80) DEFAULT 'Asia/Kolkata',
        attendance_mode   VARCHAR(30) DEFAULT 'manual',
        auto_checkout     BOOLEAN DEFAULT FALSE,
        auto_checkout_time TIME DEFAULT '21:00',
        half_day_hours    NUMERIC(4,2) DEFAULT 4.5,
        full_day_hours    NUMERIC(4,2) DEFAULT 9.0,
        updated_by        INTEGER,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch { /* already exists */ }

  // Late-arrival warnings table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_late_warnings (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER,
        employee_id   INTEGER NOT NULL,
        employee_name VARCHAR(200),
        department    VARCHAR(100),
        issued_by     INTEGER,
        month         VARCHAR(7),
        late_count    INTEGER,
        warning_text  TEXT,
        status        VARCHAR(20) NOT NULL DEFAULT 'issued',
        acknowledged_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_late_warnings_emp_month
        ON attendance_late_warnings (employee_id, month);
    `);
  } catch { /* already exists */ }

  // Shift change requests table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shift_change_requests (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER,
        employee_id         INTEGER NOT NULL,
        request_date        DATE NOT NULL,
        current_shift_id    INTEGER,
        requested_shift_id  INTEGER NOT NULL,
        reason              TEXT,
        status              VARCHAR(20) NOT NULL DEFAULT 'pending',
        reviewed_by         INTEGER,
        review_remarks      TEXT,
        reviewed_at         TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch { /* already exists */ }
})();

// ── List shifts (attendance module view with employee counts) ──────────────
router.get('/shifts', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cidWhere  = companyId != null ? `AND (s.company_id = ${parseInt(companyId)} OR s.company_id IS NULL)` : '';
    const { rows } = await pool.query(`
      SELECT s.*,
             COUNT(DISTINCT sa.employee_id) FILTER (WHERE sa.is_active = TRUE) AS employee_count
        FROM hr_shifts s
        LEFT JOIN hr_shift_assignments sa ON sa.shift_id = s.id
       WHERE s.deleted_at IS NULL ${cidWhere}
       GROUP BY s.id
       ORDER BY s.name ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create shift ──────────────────────────────────────────────────────────
router.post('/shifts', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const {
      name, start_time, end_time, grace_minutes = 15, color = '#7c3aed',
      departments = [], ot_eligible = true, weekly_off = ['sunday'],
      capacity = 0, is_night_shift = false, break_duration = 30,
    } = req.body;
    if (!name || !start_time || !end_time)
      return res.status(400).json({ error: 'name, start_time, end_time required' });
    const { rows } = await pool.query(`
      INSERT INTO hr_shifts
        (name, start_time, end_time, grace_minutes, color, departments,
         ot_eligible, weekly_off, capacity, is_night_shift, break_duration, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [name, start_time, end_time, grace_minutes, color, JSON.stringify(departments),
        ot_eligible, JSON.stringify(weekly_off), capacity, is_night_shift, break_duration, companyId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update shift ──────────────────────────────────────────────────────────
router.put('/shifts/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, start_time, end_time, grace_minutes, color,
      departments, ot_eligible, weekly_off, capacity, is_night_shift, break_duration,
    } = req.body;
    const { rows } = await pool.query(`
      UPDATE hr_shifts
         SET name=$1, start_time=$2, end_time=$3, grace_minutes=$4, color=$5,
             departments=$6, ot_eligible=$7, weekly_off=$8, capacity=$9,
             is_night_shift=$10, break_duration=$11
       WHERE id=$12
      RETURNING *
    `, [name, start_time, end_time, grace_minutes, color,
        JSON.stringify(departments || []), ot_eligible, JSON.stringify(weekly_off || []),
        capacity, is_night_shift, break_duration, id]);
    if (!rows.length) return res.status(404).json({ error: 'Shift not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete shift ──────────────────────────────────────────────────────────
router.delete('/shifts/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM hr_shifts WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shift not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get assignments for a shift ───────────────────────────────────────────
router.get('/shifts/:id/assignments', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sa.*, COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation, e.office_id AS emp_code
        FROM hr_shift_assignments sa
        JOIN employees e ON e.id = sa.employee_id
       WHERE sa.shift_id = $1 AND sa.is_active = TRUE
       ORDER BY e.name, e.first_name
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Assign employees to a shift ───────────────────────────────────────────
router.post('/shifts/:id/assign', requireAttendanceAdmin, async (req, res) => {
  try {
    const shiftId = req.params.id;
    const { employee_ids = [], effective_from } = req.body;
    const results = [];
    for (const empId of employee_ids) {
      const { rows } = await pool.query(`
        INSERT INTO hr_shift_assignments (employee_id, shift_id, effective_from, created_by, is_active)
        VALUES ($1,$2,$3,$4,TRUE)
        ON CONFLICT (employee_id, shift_id, effective_from) DO UPDATE SET is_active=TRUE
        RETURNING *
      `, [empId, shiftId, effective_from || new Date().toISOString().split('T')[0], req.user?.userId]);
      results.push(rows[0]);
    }
    res.status(201).json({ assigned: results.length, records: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Remove employee from shift ────────────────────────────────────────────
router.delete('/shifts/assign/:assignmentId', requireAttendanceAdmin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE hr_shift_assignments SET is_active=FALSE, updated_at=NOW() WHERE id=$1',
      [req.params.assignmentId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── My shift assignment — returns the calling user's active assignment ─────────
// No HR permission required; any authenticated user can fetch their own record.
router.get('/my-shift-assignment', async (req, res) => {
  try {
    const employeeId = req.user?.employee_id;
    if (!employeeId) return res.json([]);
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      SELECT sa.*
        FROM hr_shift_assignments sa
        JOIN employees e ON e.id = sa.employee_id
       WHERE sa.employee_id = $1
         AND sa.is_active = TRUE
         AND ($2::int IS NULL OR e.company_id = $2)
       ORDER BY sa.effective_from DESC
       LIMIT 1
    `, [employeeId, companyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FACE ATTENDANCE SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/face-settings', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(
      'SELECT * FROM attendance_face_settings WHERE company_id=$1 OR company_id IS NULL LIMIT 1',
      [companyId]
    );
    res.json(rows[0]?.settings || {
      enabled: false,
      selfie_required: false,
      anti_spoof: true,
      anti_spoof_threshold: 0.7,
      confidence_threshold: 0.85,
      allowed_devices: 'all',
      max_attempts: 3,
      lock_duration_minutes: 15,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/face-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      INSERT INTO attendance_face_settings (company_id, settings, updated_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (company_id) DO UPDATE
        SET settings=$2, updated_by=$3, updated_at=NOW()
      RETURNING *
    `, [companyId, JSON.stringify(req.body), req.user?.userId]);
    res.json(rows[0].settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FACE ATTENDANCE — STATS, ENROLLMENT, VALIDATE, ATTEMPTS
// ─────────────────────────────────────────────────────────────────────────────

async function incrementFailCount(companyId, employeeId, settings) {
  try {
    const cid = companyId ?? 0;
    const result = await pool.query(`
      INSERT INTO face_locked_accounts (company_id, employee_id, fail_count, last_attempt)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (company_id, employee_id)
      DO UPDATE SET fail_count = face_locked_accounts.fail_count + 1, last_attempt = NOW()
      RETURNING fail_count
    `, [cid, employeeId]);
    const failCount  = parseInt(result.rows[0]?.fail_count || 0);
    const maxAttempts = parseInt(settings.max_attempts || 3);
    if (failCount >= maxAttempts) {
      const lockMins = parseInt(settings.lock_duration_minutes || 15);
      await pool.query(`
        UPDATE face_locked_accounts
           SET locked_until = NOW() + ($3 * INTERVAL '1 minute'), fail_count = 0
         WHERE company_id = $1 AND employee_id = $2
      `, [cid, employeeId, lockMins]);
    }
  } catch { /* non-blocking */ }
}

// GET /attendance/face-stats — real KPI counts for today
router.get('/face-stats', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const today = new Date().toISOString().split('T')[0];
    const [statsRes, lockedRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE action = 'face_success')                  AS successful_today,
          COUNT(*) FILTER (WHERE action IN ('face_failed', 'face_spoof'))   AS failed_today,
          COUNT(*) FILTER (WHERE action = 'face_spoof')                    AS spoof_attempts
        FROM attendance_audit_logs
        WHERE ($1::integer IS NULL OR company_id = $1)
          AND DATE(performed_at) = $2
      `, [companyId, today]),
      pool.query(`
        SELECT COUNT(*) AS locked_accounts
        FROM face_locked_accounts
        WHERE company_id = COALESCE($1, 0)
          AND locked_until > NOW()
      `, [companyId]),
    ]);
    const s = statsRes.rows[0] || {};
    res.json({
      successful_today: parseInt(s.successful_today || 0),
      failed_today:     parseInt(s.failed_today     || 0),
      spoof_attempts:   parseInt(s.spoof_attempts   || 0),
      locked_accounts:  parseInt(lockedRes.rows[0]?.locked_accounts || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/face-attempts — suspicious attempts with filters
router.get('/face-attempts', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { from_date, to_date, employee_id, action } = req.query;
    let q = `
      SELECT al.*,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department
        FROM attendance_audit_logs al
        LEFT JOIN employees e ON e.id = al.employee_id
       WHERE ($1::integer IS NULL OR al.company_id = $1)
         AND al.action IN ('face_failed', 'face_spoof', 'face_locked')
    `;
    const params = [companyId];
    let n = 2;
    if (employee_id) { q += ` AND al.employee_id = $${n++}`;                    params.push(employee_id); }
    if (from_date)   { q += ` AND al.performed_at >= $${n++}`;                  params.push(from_date); }
    if (to_date)     { q += ` AND al.performed_at <= $${n++}`;                  params.push(to_date + ' 23:59:59'); }
    if (action)      { q += ` AND al.action = $${n++}`;                         params.push(action); }
    q += ` ORDER BY al.performed_at DESC LIMIT 200`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/face-enrollment — enrollment status per employee
router.get('/face-enrollment', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cid = companyId ?? 0;
    const { status } = req.query; // 'enrolled' | 'unenrolled'
    let q = `
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation, e.email,
        ft.id AS template_id,
        ft.enrolled_at,
        COALESCE(eb.name, CONCAT(eb.first_name,' ',eb.last_name)) AS enrolled_by_name,
        CASE WHEN ft.id IS NOT NULL THEN 'enrolled' ELSE 'unenrolled' END AS enrollment_status
      FROM employees e
      LEFT JOIN face_templates ft
        ON ft.employee_id = e.id AND ft.company_id = $1 AND ft.is_active = TRUE
      LEFT JOIN employees eb ON eb.id = ft.enrolled_by
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active','probation')
        AND ($2::integer IS NULL OR e.company_id = $2)
    `;
    const params = [cid, companyId];
    if (status === 'enrolled')   q += ` AND ft.id IS NOT NULL`;
    if (status === 'unenrolled') q += ` AND ft.id IS NULL`;
    q += ` ORDER BY enrollment_status DESC, e.department, e.name`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    const total    = result.rows.length;
    const enrolled = result.rows.filter(r => r.enrollment_status === 'enrolled').length;
    res.json({
      total,
      enrolled,
      unenrolled: total - enrolled,
      enrollment_pct: total > 0 ? Math.round((enrolled / total) * 100) : 0,
      employees: result.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /attendance/face-enroll — HR marks an employee as enrolled
router.post('/face-enroll', requireAttendanceAdmin, async (req, res) => {
  try {
    const { employee_id, notes } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const companyId = scopeCompanyId(req);
    const cid = companyId ?? 0;
    const enrolledBy = req.user?.userId ?? null;
    const { rows } = await pool.query(`
      INSERT INTO face_templates (company_id, employee_id, enrolled_by, notes, is_active)
      VALUES ($1, $2, $3, $4, TRUE)
      ON CONFLICT (company_id, employee_id)
      DO UPDATE SET is_active = TRUE, enrolled_by = $3, enrolled_at = NOW(), notes = COALESCE($4, face_templates.notes)
      RETURNING *
    `, [cid, employee_id, enrolledBy, notes || null]);
    await writeAuditLog({
      companyId, employeeId: parseInt(employee_id),
      action: 'face_enrolled',
      afterData: { enrolled_by: enrolledBy, notes },
      performedBy: enrolledBy, req,
    });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Browser face-recognition (self-service, descriptor-based) ────────────────
// Euclidean distance between two 128-float face descriptors. Lower = more alike.
// face-api convention: distance <= 0.5 is a confident same-person match.
function faceDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

// Only the signed-in employee may enroll / verify their own face (HR uses the
// separate /face-enroll flag route). Managers/admins are allowed through too.
function faceSelfEmployeeId(req, bodyEmpId) {
  const self = req.user?.employee_id ?? null;

  // Privileged callers may enrol/verify on behalf of a named employee.
  if (isAttendanceOperator(req) && bodyEmpId) return parseInt(bodyEmpId);

  // Everyone else is pinned to their own employee record. The previous version
  // fell back to `bodyEmpId` when `self` was null, so a login not linked to an
  // employee could enrol ITS OWN FACE against any employee_id it named — i.e.
  // register itself as another person for face-recognition clock-in. Returning
  // null instead makes callers fail closed; they already handle a null id by
  // returning the "login not linked" error.
  return self != null ? parseInt(self) : null;
}

async function loadFaceSettings(companyId) {
  const row = await pool.query(
    `SELECT settings FROM attendance_face_settings WHERE company_id=$1 OR company_id IS NULL LIMIT 1`,
    [companyId]
  ).catch(() => ({ rows: [] }));
  return {
    enabled: true, match_threshold: 0.5,
    anti_spoof: true, anti_spoof_threshold: 0.7,
    max_attempts: 3, lock_duration_minutes: 15,
    ...(row.rows[0]?.settings || {}),
  };
}

// GET /attendance/face/status — is the caller (or ?employee_id=) enrolled with a descriptor?
router.get('/face/status', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cid = companyId ?? 0;
    const empId = faceSelfEmployeeId(req, req.query.employee_id);
    if (!empId) return res.status(400).json({ error: 'employee_id required' });
    const { rows } = await pool.query(
      `SELECT id, (descriptor IS NOT NULL) AS has_descriptor, enrolled_at
         FROM face_templates
        WHERE company_id=$1 AND employee_id=$2 AND is_active=TRUE`,
      [cid, empId]
    );
    const cfg = await loadFaceSettings(companyId);
    res.json({
      enrolled: !!(rows[0]?.has_descriptor),
      flagged:  rows.length > 0,
      enabled:  cfg.enabled !== false,
      enrolled_at: rows[0]?.enrolled_at || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /attendance/face/self-enroll — store the caller's 128-float descriptor
router.post('/face/self-enroll', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cid = companyId ?? 0;
    const empId = faceSelfEmployeeId(req, req.body.employee_id);
    if (!empId) return res.status(400).json({ error: 'employee_id required' });
    const descriptor = req.body.descriptor;
    if (!Array.isArray(descriptor) || descriptor.length < 64) {
      return res.status(400).json({ error: 'invalid_descriptor', message: 'A valid face descriptor is required' });
    }
    const enrolledBy = req.user?.userId ?? null;
    const { rows } = await pool.query(`
      INSERT INTO face_templates (company_id, employee_id, enrolled_by, descriptor, is_active)
      VALUES ($1, $2, $3, $4, TRUE)
      ON CONFLICT (company_id, employee_id)
      DO UPDATE SET descriptor = $4, is_active = TRUE, enrolled_at = NOW(), enrolled_by = $3
      RETURNING id, enrolled_at
    `, [cid, empId, enrolledBy, JSON.stringify(descriptor)]);
    await writeAuditLog({
      companyId, employeeId: empId, action: 'face_enrolled',
      afterData: { self_enrolled: true, dims: descriptor.length },
      performedBy: enrolledBy, req,
    }).catch(() => {});
    res.json({ success: true, enrolled_at: rows[0]?.enrolled_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /attendance/face/verify — match a live descriptor against the enrolled one.
// On success the client then calls /attendance/clock (reuses geo/shift/late logic).
router.post('/face/verify', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cid = companyId ?? 0;
    const empId = faceSelfEmployeeId(req, req.body.employee_id);
    if (!empId) return res.status(400).json({ error: 'employee_id required' });
    const { descriptor, liveness_score } = req.body;
    if (!Array.isArray(descriptor) || descriptor.length < 64) {
      return res.status(400).json({ error: 'invalid_descriptor' });
    }

    const cfg = await loadFaceSettings(companyId);
    if (cfg.enabled === false) return res.status(403).json({ error: 'face_attendance_disabled' });

    // Lockout gate
    const lockRow = await pool.query(
      `SELECT locked_until FROM face_locked_accounts WHERE company_id=$1 AND employee_id=$2 AND locked_until > NOW()`,
      [cid, empId]
    );
    if (lockRow.rows.length) {
      return res.status(423).json({ error: 'account_locked', locked_until: lockRow.rows[0].locked_until });
    }

    // Load enrolled descriptor
    const tpl = await pool.query(
      `SELECT descriptor FROM face_templates WHERE company_id=$1 AND employee_id=$2 AND is_active=TRUE`,
      [cid, empId]
    );
    const enrolled = tpl.rows[0]?.descriptor;
    if (!enrolled) {
      return res.status(403).json({ error: 'employee_not_enrolled', message: 'No enrolled face — please enroll first' });
    }

    // Liveness (client-supplied score; anti-spoof settings honoured)
    const liveness = liveness_score !== undefined ? parseFloat(liveness_score) : null;
    if (cfg.anti_spoof && liveness !== null && liveness < parseFloat(cfg.anti_spoof_threshold)) {
      await writeAuditLog({
        companyId, employeeId: empId, action: 'face_spoof',
        afterData: { liveness_score: liveness, reason: 'liveness_check_failed' }, performedBy: null, req,
      }).catch(() => {});
      await incrementFailCount(companyId, empId, cfg);
      return res.status(403).json({ error: 'spoof_detected', liveness_score: liveness });
    }

    const distance   = faceDistance(descriptor, Array.isArray(enrolled) ? enrolled : []);
    const threshold  = parseFloat(cfg.match_threshold ?? 0.5);
    const confidence = Math.max(0, Math.min(1, 1 - distance));

    if (distance > threshold) {
      await writeAuditLog({
        companyId, employeeId: empId, action: 'face_failed',
        afterData: { distance, confidence, reason: 'no_match' }, performedBy: null, req,
      }).catch(() => {});
      await incrementFailCount(companyId, empId, cfg);
      return res.status(403).json({ error: 'no_match', distance, confidence, threshold });
    }

    // SUCCESS — clear fail counter and log
    await pool.query(
      `UPDATE face_locked_accounts SET fail_count=0, last_attempt=NOW() WHERE company_id=$1 AND employee_id=$2`,
      [cid, empId]
    ).catch(() => {});
    await writeAuditLog({
      companyId, employeeId: empId, action: 'face_success',
      afterData: { distance, confidence }, performedBy: empId, req,
    }).catch(() => {});

    // Short-lived proof-of-face for /attendance/clock — the clock endpoint
    // rejects self clock-ins that don't carry a valid face_token.
    const faceToken = jwt.sign(
      { typ: 'face_verify', employee_id: empId, company_id: cid },
      process.env.JWT_SECRET,
      { expiresIn: '3m' }
    );
    res.json({ match: true, distance, confidence, employee_id: empId, face_token: faceToken });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /attendance/face-data/:employee_id — GDPR biometric data deletion
router.delete('/face-data/:employee_id', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cid = companyId ?? 0;
    const empId = parseInt(req.params.employee_id);
    await pool.query(
      `UPDATE face_templates SET is_active = FALSE WHERE employee_id = $1 AND company_id = $2`,
      [empId, cid]
    );
    await pool.query(
      `DELETE FROM face_locked_accounts WHERE employee_id = $1 AND company_id = $2`,
      [empId, cid]
    );
    await writeAuditLog({
      companyId, employeeId: empId,
      action: 'face_data_deleted',
      afterData: { deleted_by: req.user?.userId },
      performedBy: req.user?.userId ?? null, req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /attendance/face-validate — inbound punch from biometric device
router.post('/face-validate', async (req, res) => {
  try {
    const { device_id, employee_id, confidence, liveness_score, timestamp } = req.body;
    if (!employee_id)         return res.status(400).json({ error: 'employee_id required' });
    if (confidence === undefined) return res.status(400).json({ error: 'confidence required' });
    const companyId = scopeCompanyId(req);
    const cid = companyId ?? 0;
    const punchTime = timestamp ? new Date(timestamp) : new Date();

    // Load settings
    const settingsRow = await pool.query(
      `SELECT settings FROM attendance_face_settings WHERE company_id=$1 OR company_id IS NULL LIMIT 1`,
      [companyId]
    );
    const cfg = {
      enabled: true, confidence_threshold: 0.85,
      anti_spoof: true, anti_spoof_threshold: 0.7,
      max_attempts: 3, lock_duration_minutes: 15,
      ...( settingsRow.rows[0]?.settings || {} ),
    };

    if (!cfg.enabled) return res.status(403).json({ error: 'face_attendance_disabled' });

    // Check lockout
    const lockRow = await pool.query(
      `SELECT locked_until FROM face_locked_accounts WHERE company_id=$1 AND employee_id=$2 AND locked_until > NOW()`,
      [cid, employee_id]
    );
    if (lockRow.rows.length) {
      return res.status(423).json({
        error: 'account_locked',
        message: `Account locked until ${lockRow.rows[0].locked_until}`,
        locked_until: lockRow.rows[0].locked_until,
      });
    }

    // Enrollment check
    const enrolled = await pool.query(
      `SELECT id FROM face_templates WHERE company_id=$1 AND employee_id=$2 AND is_active=TRUE`,
      [cid, employee_id]
    );
    if (!enrolled.rows.length) {
      return res.status(403).json({ error: 'employee_not_enrolled', message: 'Employee face not enrolled in this company' });
    }

    const conf     = parseFloat(confidence);
    const liveness = liveness_score !== undefined ? parseFloat(liveness_score) : null;

    // Spoof check
    if (cfg.anti_spoof && liveness !== null && liveness < parseFloat(cfg.anti_spoof_threshold)) {
      await writeAuditLog({
        companyId, employeeId: parseInt(employee_id), action: 'face_spoof',
        afterData: { confidence: conf, liveness_score: liveness, device_id, reason: 'liveness_check_failed' },
        performedBy: null, req,
      });
      await incrementFailCount(companyId, employee_id, cfg);
      return res.status(403).json({ error: 'spoof_detected', confidence: conf, liveness_score: liveness });
    }

    // Confidence check
    if (conf < parseFloat(cfg.confidence_threshold)) {
      await writeAuditLog({
        companyId, employeeId: parseInt(employee_id), action: 'face_failed',
        afterData: { confidence: conf, liveness_score: liveness, device_id, reason: 'low_confidence' },
        performedBy: null, req,
      });
      await incrementFailCount(companyId, employee_id, cfg);
      return res.status(403).json({ error: 'low_confidence', confidence: conf, threshold: cfg.confidence_threshold });
    }

    // SUCCESS — reset fail counter
    await pool.query(
      `UPDATE face_locked_accounts SET fail_count=0, last_attempt=NOW() WHERE company_id=$1 AND employee_id=$2`,
      [cid, employee_id]
    ).catch(() => {});

    // Mark attendance
    const today   = punchTime.toISOString().slice(0, 10);
    const timeStr = punchTime.toTimeString().slice(0, 5);
    await pool.query(`
      INSERT INTO attendance_records
        (employee_id, attendance_date, check_in_time, status, company_id, work_mode)
      VALUES ($1, $2, $3::time, 'present', $4, 'office')
      ON CONFLICT (employee_id, attendance_date)
      DO UPDATE SET
        check_in_time = CASE WHEN attendance_records.check_in_time IS NULL THEN $3::time ELSE attendance_records.check_in_time END,
        status = COALESCE(NULLIF(attendance_records.status,'absent'), 'present'),
        updated_at = NOW()
    `, [employee_id, today, timeStr, companyId]).catch(() => {});

    if (device_id) {
      await pool.query(
        `INSERT INTO biometric_logs (employee_id, device_id, punch_time, punch_type, raw_data)
         VALUES ($1, $2, $3, 'in', $4) ON CONFLICT DO NOTHING`,
        [employee_id, device_id, punchTime.toISOString(),
         JSON.stringify({ confidence: conf, liveness_score: liveness, source: 'face' })]
      ).catch(() => {});
    }

    await writeAuditLog({
      companyId, employeeId: parseInt(employee_id), action: 'face_success',
      afterData: { confidence: conf, liveness_score: liveness, device_id, punch_time: punchTime },
      performedBy: null, req,
    });

    res.json({ success: true, employee_id, punch_time: punchTime, confidence: conf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOW CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
router.get('/workflow-config', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(
      'SELECT * FROM attendance_workflow_config WHERE company_id=$1 ORDER BY workflow_type',
      [companyId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/workflow-config/:type', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { type } = req.params;
    const { levels, is_active = true } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO attendance_workflow_config (company_id, workflow_type, levels, is_active, updated_by)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (company_id, workflow_type) DO UPDATE
        SET levels=$3, is_active=$4, updated_by=$5, updated_at=NOW()
      RETURNING *
    `, [companyId, type, JSON.stringify(levels || []), is_active, req.user?.userId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL ATTENDANCE SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/general-settings', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(
      'SELECT * FROM attendance_general_settings WHERE company_id=$1 LIMIT 1',
      [companyId]
    );
    if (rows[0]) {
      // Merge late-policy grace_minutes into the response as default_grace_minutes
      const policyRow = await pool.query(`
        SELECT rules->>'grace_minutes' AS grace_minutes,
               rules->>'ot_multiplier' AS ot_multiplier
          FROM attendance_policies
         WHERE policy_type = 'late' AND is_active = true
           AND (company_id = $1 OR company_id IS NULL)
         ORDER BY company_id DESC NULLS LAST LIMIT 1
      `, [scopeCompanyId(req)]).catch(() => ({ rows: [] }));
      const p = policyRow.rows[0];
      res.json({
        ...rows[0],
        default_grace_minutes: rows[0].default_grace_minutes ?? parseInt(p?.grace_minutes ?? 10),
        ot_multiplier: rows[0].ot_multiplier ?? parseFloat(p?.ot_multiplier ?? 1.5),
      });
    } else {
      res.json({
        working_days: ['monday','tuesday','wednesday','thursday','friday'],
        timezone: 'Asia/Kolkata',
        attendance_mode: 'manual',
        auto_checkout: false,
        auto_checkout_time: '21:00',
        half_day_hours: 4.5,
        full_day_hours: 9.0,
        default_grace_minutes: 10,
        ot_multiplier: 1.5,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/general-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const {
      working_days, timezone, attendance_mode, auto_checkout, auto_checkout_time,
      half_day_hours, full_day_hours, default_grace_minutes, ot_multiplier,
    } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO attendance_general_settings
        (company_id, working_days, timezone, attendance_mode, auto_checkout, auto_checkout_time,
         half_day_hours, full_day_hours, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (company_id) DO UPDATE
        SET working_days=$2, timezone=$3, attendance_mode=$4, auto_checkout=$5,
            auto_checkout_time=$6, half_day_hours=$7, full_day_hours=$8, updated_by=$9, updated_at=NOW()
      RETURNING *
    `, [companyId, JSON.stringify(working_days), timezone, attendance_mode, auto_checkout,
        auto_checkout_time, half_day_hours, full_day_hours, req.user?.userId]);
    // Save grace_minutes + ot_multiplier to late attendance policy if provided
    if (default_grace_minutes != null || ot_multiplier != null) {
      await pool.query(`
        UPDATE attendance_policies
           SET rules = rules
               || jsonb_build_object(
                    'grace_minutes', $2::text,
                    'ot_multiplier', $3::text
                  ),
               updated_at = NOW()
         WHERE policy_type = 'late' AND is_active = true
           AND (company_id = $1 OR company_id IS NULL)
      `, [companyId, String(default_grace_minutes ?? 10), String(ot_multiplier ?? 1.5)]).catch(() => {});
    }
    res.json({
      ...rows[0],
      default_grace_minutes: default_grace_minutes ?? 10,
      ot_multiplier: ot_multiplier ?? 1.5,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GEO / DEVICE / REPORT / WORK-CENTRE MODULE SETTINGS
// Each setting group is stored as a JSONB column on attendance_general_settings
// ─────────────────────────────────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
  geo: { geo_mandatory: false, default_radius: 200, block_outside: true },
  device: { auto_sync: true, sync_interval_minutes: 15, duplicate_window_minutes: 5, offline_sync: true },
  report: { auto_monthly_report: true, report_email: '', export_format: 'xlsx', include_photos: false },
  workcentre: { track_work_centres: false, require_wc_for_factory: true, units_produced_tracking: false, include_in_reports: true },
};

async function getModuleSetting(companyId, key) {
  const { rows } = await pool.query(
    `SELECT ${key}_settings AS val FROM attendance_general_settings WHERE company_id=$1 LIMIT 1`,
    [companyId]
  ).catch(() => ({ rows: [] }));
  return rows[0]?.val || SETTINGS_DEFAULTS[key] || {};
}

async function putModuleSetting(companyId, key, value, userId) {
  await pool.query(`
    INSERT INTO attendance_general_settings (company_id, ${key}_settings, updated_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (company_id) DO UPDATE SET ${key}_settings = $2, updated_by = $3, updated_at = NOW()
  `, [companyId, JSON.stringify(value), userId || null]);
}

router.get('/geo-settings', async (req, res) => {
  try {
    res.json(await getModuleSetting(scopeCompanyId(req), 'geo'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/geo-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    await putModuleSetting(scopeCompanyId(req), 'geo', req.body, req.user?.userId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/device-settings', async (req, res) => {
  try {
    res.json(await getModuleSetting(scopeCompanyId(req), 'device'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/device-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    await putModuleSetting(scopeCompanyId(req), 'device', req.body, req.user?.userId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/report-settings', async (req, res) => {
  try {
    res.json(await getModuleSetting(scopeCompanyId(req), 'report'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/report-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    await putModuleSetting(scopeCompanyId(req), 'report', req.body, req.user?.userId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/workcentre-settings', async (req, res) => {
  try {
    res.json(await getModuleSetting(scopeCompanyId(req), 'workcentre'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/workcentre-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    await putModuleSetting(scopeCompanyId(req), 'workcentre', req.body, req.user?.userId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY TIMINGS — wizard step 1, source of truth for weekend detection
// ─────────────────────────────────────────────────────────────────────────────
router.get('/settings/company-timings', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(
      `SELECT work_start_time, work_end_time, break_duration, min_working_hours, weekend_days
         FROM attendance_general_settings WHERE company_id=$1 LIMIT 1`,
      [companyId]
    );
    res.json(rows[0] ?? {
      work_start_time: '09:00',
      work_end_time: '18:00',
      break_duration: 60,
      min_working_hours: 9.0,
      weekend_days: ['saturday', 'sunday'],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings/company-timings', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const {
      work_start_time  = '09:00',
      work_end_time    = '18:00',
      break_duration   = 60,
      min_working_hours = 9.0,
      weekend_days     = ['saturday', 'sunday'],
    } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO attendance_general_settings
        (company_id, work_start_time, work_end_time, break_duration, min_working_hours, weekend_days, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (company_id) DO UPDATE
        SET work_start_time=$2, work_end_time=$3, break_duration=$4,
            min_working_hours=$5, weekend_days=$6, updated_by=$7, updated_at=NOW()
      RETURNING work_start_time, work_end_time, break_duration, min_working_hours, weekend_days
    `, [companyId, work_start_time, work_end_time, break_duration,
        min_working_hours, JSON.stringify(weekend_days), req.user?.userId]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL DELEGATION
// ─────────────────────────────────────────────────────────────────────────────

// GET /attendance/approval-delegations
router.get('/approval-delegations', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      SELECT
        d.*,
        COALESCE(dor.name, CONCAT(dor.first_name,' ',dor.last_name)) AS delegator_name,
        dor.designation AS delegator_designation,
        COALESCE(del.name, CONCAT(del.first_name,' ',del.last_name)) AS delegate_name,
        del.designation AS delegate_designation
      FROM attendance_approval_delegations d
      JOIN employees dor ON dor.id = d.delegator_id
      JOIN employees del ON del.id = d.delegate_id
      WHERE ($1::integer IS NULL OR d.company_id = $1)
      ORDER BY d.is_active DESC, d.from_date DESC
    `, [companyId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /attendance/approval-delegations
router.post('/approval-delegations', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { delegator_id, delegate_id, from_date, to_date, delegation_type, reason } = req.body;
    if (!delegator_id || !delegate_id || !from_date || !to_date)
      return res.status(400).json({ error: 'delegator_id, delegate_id, from_date, to_date are required' });
    if (String(delegator_id) === String(delegate_id))
      return res.status(400).json({ error: 'Delegator and delegate cannot be the same person' });
    const { rows } = await pool.query(`
      INSERT INTO attendance_approval_delegations
        (company_id, delegator_id, delegate_id, from_date, to_date, delegation_type, reason, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (delegator_id, from_date, to_date) DO UPDATE
        SET delegate_id=$3, delegation_type=$6, reason=$7, is_active=TRUE, updated_at=NOW()
      RETURNING *
    `, [companyId, delegator_id, delegate_id, from_date, to_date, delegation_type || 'all', reason || null, req.user?.employee_id]);
    await writeAuditLog({
      companyId,
      employeeId: req.user?.employee_id || rows[0].delegator_id,
      action: 'approval_delegation_create',
      beforeData: null,
      afterData: rows[0],
      performedBy: req.user?.employee_id,
      reason: rows[0].reason || null,
      req,
    });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /attendance/approval-delegations/:id
router.delete('/approval-delegations/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      UPDATE attendance_approval_delegations
      SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1 AND ($2::integer IS NULL OR company_id = $2)
      RETURNING id
    `, [req.params.id, companyId]);
    if (!rows.length) return res.status(404).json({ error: 'Delegation not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// QR ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

/* ── POST /attendance/qr/generate — create a QR code for a shift/site ── */
router.post('/qr/generate', requireAttendanceAdmin, async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    if (!['admin', 'super_admin', 'manager'].includes(role)) {
      return res.status(403).json({ error: 'Only admin or manager can generate QR codes' });
    }
    const { location, shift_id, valid_from, valid_until, scan_type = 'both' } = req.body;
    if (!valid_from || !valid_until) {
      return res.status(400).json({ error: 'valid_from and valid_until are required' });
    }
    const companyId = scopeCompanyId(req);
    const { randomBytes } = await import('crypto');
    const code_token = randomBytes(24).toString('hex');

    const { rows: [code] } = await pool.query(
      `INSERT INTO qr_attendance_codes
         (code_token, location, shift_id, valid_from, valid_until, scan_type, is_active, created_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING *`,
      [code_token, location || null, shift_id || null, valid_from, valid_until, scan_type,
       req.user?.userId ?? null, companyId]
    );
    res.status(201).json({ success: true, data: code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /attendance/qr/codes — list QR codes for admin ── */
router.get('/qr/codes', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(
      `SELECT qc.*, s.name AS shift_name
       FROM qr_attendance_codes qc
       LEFT JOIN hr_shifts s ON s.id = qc.shift_id
       WHERE qc.is_active = true
         ${companyId ? 'AND qc.company_id = $1' : ''}
       ORDER BY qc.valid_until DESC LIMIT 100`,
      companyId ? [companyId] : []
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /attendance/qr/scan — employee scans QR code to mark attendance ── */
router.post('/qr/scan', async (req, res) => {
  try {
    const { code_token, scan_type = 'in', latitude, longitude } = req.body;
    if (!code_token) return res.status(400).json({ error: 'code_token is required' });

    const employeeId = req.user?.employeeId ?? req.user?.employee_id ?? null;
    if (!employeeId) return res.status(401).json({ error: 'Employee ID not found in session' });

    // Validate QR code — scoped to caller's company to prevent cross-company token reuse
    const companyId = scopeCompanyId(req);
    const { rows: [code] } = await pool.query(
      `SELECT * FROM qr_attendance_codes WHERE code_token=$1 AND is_active=true
       ${companyId ? 'AND company_id=$2' : ''}`,
      companyId ? [code_token, companyId] : [code_token]
    );
    if (!code) return res.status(404).json({ error: 'QR code not found or inactive' });

    const now = new Date();
    if (now < new Date(code.valid_from) || now > new Date(code.valid_until)) {
      return res.status(400).json({ error: 'QR code is expired or not yet valid', status: 'expired' });
    }

    // Prevent duplicate scans within 30 seconds
    const { rows: [recent] } = await pool.query(
      `SELECT id FROM qr_attendance_scans
       WHERE employee_id=$1 AND qr_code_id=$2 AND scan_type=$3
         AND scan_time > NOW() - INTERVAL '30 seconds'`,
      [employeeId, code.id, scan_type]
    );
    if (recent) {
      return res.status(409).json({ error: 'Duplicate scan detected', status: 'duplicate' });
    }

    const { rows: [scan] } = await pool.query(
      `INSERT INTO qr_attendance_scans
         (qr_code_id, employee_id, scan_time, scan_type, latitude, longitude, device_info, status, company_id)
       VALUES ($1,$2,NOW(),$3,$4,$5,$6,'valid',$7) RETURNING *`,
      [code.id, employeeId, scan_type,
       latitude ? parseFloat(latitude) : null,
       longitude ? parseFloat(longitude) : null,
       req.headers['user-agent'] || null,
       code.company_id]
    );

    // Auto-mark attendance record
    await pool.query(
      `INSERT INTO attendance_records (employee_id, attendance_date, check_in_time, status, company_id, source)
       VALUES ($1, CURRENT_DATE, NOW(), 'present', $2, 'qr')
       ON CONFLICT (employee_id, attendance_date) DO UPDATE
         SET check_in_time  = CASE WHEN $3 = 'in' AND attendance_records.check_in_time IS NULL THEN NOW() ELSE attendance_records.check_in_time END,
             check_out_time = CASE WHEN $3 = 'out' THEN NOW() ELSE attendance_records.check_out_time END,
             status = 'present'`,
      [employeeId, code.company_id, scan_type]
    );

    res.json({ success: true, data: scan, message: `Attendance marked as ${scan_type}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /attendance/qr/scans — admin view all scans for a QR code ── */
router.get('/qr/scans', async (req, res) => {
  try {
    const { qr_code_id, date, employee_id } = req.query;
    const companyId = scopeCompanyId(req);
    const params = [];
    let idx = 1;
    let where = 'WHERE 1=1';

    if (companyId)   { where += ` AND qs.company_id = $${idx++}`; params.push(companyId); }
    if (qr_code_id)  { where += ` AND qs.qr_code_id = $${idx++}`; params.push(qr_code_id); }
    if (employee_id) { where += ` AND qs.employee_id = $${idx++}`; params.push(employee_id); }
    if (date)        { where += ` AND DATE(qs.scan_time) = $${idx++}`; params.push(date); }

    const { rows } = await pool.query(
      `SELECT qs.*, e.name AS employee_name, e.department, qc.location AS qr_location
       FROM qr_attendance_scans qs
       JOIN employees e ON e.id = qs.employee_id
       JOIN qr_attendance_codes qc ON qc.id = qs.qr_code_id
       ${where}
       ORDER BY qs.scan_time DESC LIMIT 200`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /attendance/qr/codes/:id — deactivate a QR code ── */
router.delete('/qr/codes/:id', requireAttendanceAdmin, async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    if (!['admin', 'super_admin', 'manager'].includes(role)) {
      return res.status(403).json({ error: 'Only admin or manager can deactivate QR codes' });
    }
    const companyId = scopeCompanyId(req);
    const { rowCount } = await pool.query(
      `UPDATE qr_attendance_codes SET is_active=false
       WHERE id=$1 ${companyId ? 'AND company_id=$2' : ''}`,
      companyId ? [req.params.id, companyId] : [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'QR code not found' });
    res.json({ success: true, message: 'QR code deactivated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. SHIFT CHANGE REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

// List — employee sees own; hr/admin sees all
router.get('/shift-change-requests', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { employee_id, status } = req.query;
    let q = `
      SELECT r.*,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation,
             cs.name AS current_shift_name,
             rs.name AS requested_shift_name
        FROM shift_change_requests r
        JOIN employees e ON e.id = r.employee_id
        LEFT JOIN hr_shifts cs ON cs.id = r.current_shift_id
        LEFT JOIN hr_shifts rs ON rs.id = r.requested_shift_id
       WHERE ($1::int IS NULL OR r.company_id = $1)
    `;
    const params = [companyId];
    let n = 2;
    if (employee_id) { q += ` AND r.employee_id = $${n++}`; params.push(employee_id); }
    if (status)      { q += ` AND r.status = $${n++}`;      params.push(status); }
    q += ` ORDER BY r.created_at DESC LIMIT 100`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/shift-change-requests', async (req, res) => {
  try {
    const { employee_id, request_date, current_shift_id, requested_shift_id, reason } = req.body;
    if (!employee_id || !request_date || !requested_shift_id)
      return res.status(400).json({ error: 'employee_id, request_date, requested_shift_id required' });
    const companyId = scopeCompanyId(req);
    const result = await pool.query(`
      INSERT INTO shift_change_requests
        (company_id, employee_id, request_date, current_shift_id, requested_shift_id, reason)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [companyId, employee_id, request_date, current_shift_id || null, requested_shift_id, reason || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/shift-change-requests/:id/approve', requireAttendanceApprover, async (req, res) => {
  try {
    const { remarks } = req.body;
    // reviewed_by was previously accepted from the request body as a fallback,
    // letting a caller attribute the decision to someone else. The token is the
    // only acceptable source of the reviewer's identity.
    const reviewerId = req.user?.userId;
    if (!reviewerId) return res.status(401).json({ error: 'Authentication required' });

    // Fetch → authorize → update. This route previously updated FIRST and never
    // checked who was asking, so any approver-role user could approve any
    // employee's shift change (and re-decide an already-decided one).
    const before = (await pool.query(
      `SELECT * FROM shift_change_requests WHERE id=$1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'Request not found' });
    if (before.status !== 'pending')
      return res.status(409).json({ error: `Request is already ${before.status}` });

    const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'shift');
    if (decide) return res.status(decide.status).json(decide.body);

    const result = await pool.query(`
      UPDATE shift_change_requests
         SET status='approved', reviewed_by=$2, review_remarks=$3, reviewed_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *
    `, [req.params.id, reviewerId, remarks || null]);
    if (!result.rows[0]) return res.status(409).json({ error: 'Request was already decided' });

    // Apply: update the employee's active shift assignment to the requested shift
    const r = result.rows[0];
    await pool.query(`
      UPDATE hr_shift_assignments SET is_active=FALSE, updated_at=NOW()
       WHERE employee_id=$1 AND is_active=TRUE
    `, [r.employee_id]).catch(() => {});
    await pool.query(`
      INSERT INTO hr_shift_assignments (employee_id, shift_id, effective_from, is_active)
      VALUES ($1,$2,$3,TRUE)
      ON CONFLICT (employee_id, shift_id, effective_from) DO UPDATE SET is_active=TRUE
    `, [r.employee_id, r.requested_shift_id, r.request_date]).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/shift-change-requests/:id/reject', requireAttendanceApprover, async (req, res) => {
  try {
    const { remarks } = req.body;
    const reviewerId = req.user?.userId;   // never from the body — see approve route
    if (!reviewerId) return res.status(401).json({ error: 'Authentication required' });

    const before = (await pool.query(
      `SELECT * FROM shift_change_requests WHERE id=$1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'Request not found' });
    if (before.status !== 'pending')
      return res.status(409).json({ error: `Request is already ${before.status}` });

    const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'shift');
    if (decide) return res.status(decide.status).json(decide.body);

    const result = await pool.query(`
      UPDATE shift_change_requests
         SET status='rejected', reviewed_by=$2, review_remarks=$3, reviewed_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *
    `, [req.params.id, reviewerId, remarks || null]);
    if (!result.rows[0]) return res.status(409).json({ error: 'Request was already decided' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/geo-violations — dedicated geo violation report
router.get('/geo-violations', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { from_date, to_date, employee_id, department } = req.query;
    const fromDate = from_date || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const toDate   = to_date   || new Date().toISOString().split('T')[0];
    let q = `
      SELECT al.employee_id,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation,
             COUNT(*) AS violation_count,
             MAX(al.performed_at) AS last_violation,
             JSON_AGG(JSON_BUILD_OBJECT(
               'date', DATE(al.performed_at),
               'rule', al.after_data->>'rule_name',
               'distance_m', (al.after_data->>'distance_m')::int,
               'radius_m', (al.after_data->>'radius_m')::int,
               'location', al.after_data->>'location',
               'performed_at', al.performed_at
             ) ORDER BY al.performed_at DESC) AS violations
        FROM attendance_audit_logs al
        JOIN employees e ON e.id = al.employee_id
       WHERE al.action = 'clock_in_geo_blocked'
         AND ($1::integer IS NULL OR al.company_id = $1)
         AND DATE(al.performed_at) BETWEEN $2 AND $3
    `;
    const params = [companyId, fromDate, toDate];
    let n = 4;
    if (employee_id) { q += ` AND al.employee_id = $${n++}`; params.push(employee_id); }
    if (department)  { q += ` AND e.department = $${n++}`;   params.push(department); }
    q += ` GROUP BY al.employee_id, e.name, e.first_name, e.last_name, e.department, e.designation ORDER BY violation_count DESC LIMIT 100`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    // Also get summary counts
    const summaryQ = await pool.query(`
      SELECT COUNT(*) AS total_violations,
             COUNT(DISTINCT employee_id) AS employees_affected,
             COUNT(*) FILTER (WHERE DATE(performed_at) = CURRENT_DATE) AS today_violations
        FROM attendance_audit_logs
       WHERE action = 'clock_in_geo_blocked'
         AND ($1::integer IS NULL OR company_id = $1)
         AND DATE(performed_at) BETWEEN $2 AND $3
    `, [companyId, fromDate, toDate]).catch(() => ({ rows: [{}] }));
    const s = summaryQ.rows[0] || {};
    res.json({
      from_date: fromDate, to_date: toDate,
      summary: {
        total_violations: parseInt(s.total_violations || 0),
        employees_affected: parseInt(s.employees_affected || 0),
        today_violations: parseInt(s.today_violations || 0),
      },
      employees: result.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/early-exits — early exit report
router.get('/early-exits', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { from_date, to_date, department, month, year } = req.query;
    let startDate, endDate;
    if (month && year) {
      const m = parseInt(month), y = parseInt(year);
      const pad2 = n => String(n).padStart(2,'0');
      startDate = `${y}-${pad2(m)}-01`;
      endDate   = `${y}-${pad2(m)}-${new Date(y,m,0).getDate()}`;
    } else {
      startDate = from_date || new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
      endDate   = to_date   || new Date().toISOString().split('T')[0];
    }
    let q = `
      SELECT ar.employee_id,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation,
             ar.attendance_date, ar.check_out_time, ar.early_leave_minutes,
             COALESCE(s.name,'Unknown') AS shift_name, s.end_time AS scheduled_end
        FROM attendance_records ar
        JOIN employees e ON e.id = ar.employee_id
        LEFT JOIN LATERAL (
          SELECT sa.shift_id FROM hr_shift_assignments sa
           WHERE sa.employee_id = ar.employee_id AND sa.is_active = TRUE
           ORDER BY sa.effective_from DESC LIMIT 1
        ) latest_sa ON TRUE
        LEFT JOIN hr_shifts s ON s.id = latest_sa.shift_id
       WHERE ar.early_leave_minutes > 0
         AND ar.attendance_date BETWEEN $1 AND $2
         AND ar.deleted_at IS NULL
         AND ($3::integer IS NULL OR e.company_id = $3)
    `;
    const params = [startDate, endDate, companyId];
    if (department) { q += ` AND e.department = $4`; params.push(department); }
    q += ` ORDER BY ar.attendance_date DESC, ar.early_leave_minutes DESC LIMIT 500`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json({
      from_date: startDate, to_date: endDate,
      records: result.rows,
      total: result.rows.length,
      total_early_minutes: result.rows.reduce((a,r) => a + (parseInt(r.early_leave_minutes)||0), 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT LABOUR ATTENDANCE (separate from regular attendance)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/contract-labour/attendance', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { date, contract_id, work_centre_id } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    let q = `
      SELECT cla.*,
             cl.employee_name, cl.contractor_company, cl.designation, cl.employee_code,
             cl.safety_certified, cl.compliance_ok,
             s.name AS shift_name
        FROM contract_labour_attendance cla
        JOIN contract_labour cl ON cl.id = cla.contract_id
        LEFT JOIN hr_shifts s ON s.id = cl.shift_id
       WHERE ($1::integer IS NULL OR cla.company_id = $1)
         AND cla.attendance_date = $2
    `;
    const params = [companyId, targetDate];
    let n = 3;
    if (contract_id)    { q += ` AND cla.contract_id = $${n++}`;     params.push(contract_id); }
    if (work_centre_id) { q += ` AND cla.work_centre_id = $${n++}`;  params.push(work_centre_id); }
    q += ` ORDER BY cl.contractor_company, cl.employee_name`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/contract-labour/attendance/monthly', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { month, year, contract_id } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const pad = n => String(n).padStart(2,'0');
    const start = `${y}-${pad(m)}-01`;
    const end   = `${y}-${pad(m)}-${new Date(y,m,0).getDate()}`;
    let q = `
      SELECT cl.id AS contract_id,
             cl.employee_name, cl.contractor_company, cl.designation, cl.employee_code,
             COUNT(*) FILTER (WHERE cla.status IN ('present','late')) AS present_days,
             COUNT(*) FILTER (WHERE cla.status = 'absent')            AS absent_days,
             COUNT(*) FILTER (WHERE cla.status = 'half_day')          AS half_days,
             COUNT(cla.id)                                             AS total_records,
             COALESCE(SUM(cla.hours_worked), 0)                        AS total_hours
        FROM contract_labour cl
        LEFT JOIN contract_labour_attendance cla
          ON cla.contract_id = cl.id
          AND cla.attendance_date BETWEEN $1 AND $2
       WHERE cl.is_active = TRUE
         AND ($3::integer IS NULL OR cl.company_id = $3)
    `;
    const params = [start, end, companyId];
    if (contract_id) { q += ` AND cl.id = $4`; params.push(contract_id); }
    q += ` GROUP BY cl.id, cl.employee_name, cl.contractor_company, cl.designation, cl.employee_code ORDER BY cl.contractor_company, cl.employee_name`;
    const result = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json({ month: m, year: y, records: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/contract-labour/attendance', requireAttendanceOperator, async (req, res) => {
  try {
    const { contract_id, date, check_in, check_out, status, work_centre_id, gate_pass_id, remarks } = req.body;
    if (!contract_id) return res.status(400).json({ error: 'contract_id is required' });
    const companyId = scopeCompanyId(req);
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Verify contract worker belongs to this company
    const clRow = await pool.query('SELECT * FROM contract_labour WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)', [contract_id, companyId]).catch(() => ({ rows: [] }));
    if (!clRow.rows[0]) return res.status(404).json({ error: 'Contract worker not found' });

    // Compute hours if both times provided
    let hoursWorked = null;
    if (check_in && check_out) {
      const hr = await pool.query(`SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS h`, [check_out, check_in]).catch(() => ({ rows: [{ h: 0 }] }));
      hoursWorked = Math.abs(parseFloat(hr.rows[0]?.h || 0)).toFixed(2);
    }

    const result = await pool.query(`
      INSERT INTO contract_labour_attendance
        (company_id, contract_id, attendance_date, check_in, check_out, hours_worked, status, work_centre_id, gate_pass_id, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (contract_id, attendance_date) DO UPDATE SET
        check_in = COALESCE($4, contract_labour_attendance.check_in),
        check_out = COALESCE($5, contract_labour_attendance.check_out),
        hours_worked = COALESCE($6, contract_labour_attendance.hours_worked),
        status = COALESCE($7, contract_labour_attendance.status),
        work_centre_id = COALESCE($8, contract_labour_attendance.work_centre_id),
        gate_pass_id = COALESCE($9, contract_labour_attendance.gate_pass_id),
        remarks = COALESCE($10, contract_labour_attendance.remarks),
        updated_at = NOW()
      RETURNING *
    `, [companyId, contract_id, targetDate, check_in || null, check_out || null, hoursWorked,
        status || 'present', work_centre_id || null, gate_pass_id || null, remarks || null]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/contract-labour/bulk-mark', requireAttendanceOperator, async (req, res) => {
  try {
    const { date, status, contract_ids } = req.body;
    if (!date || !status) return res.status(400).json({ error: 'date and status required' });
    const companyId = scopeCompanyId(req);
    const targetDate = date;

    let query, params;
    if (contract_ids && contract_ids.length > 0) {
      query = `
        INSERT INTO contract_labour_attendance (company_id, contract_id, attendance_date, status)
        SELECT $1, id, $2, $3 FROM contract_labour WHERE id = ANY($4) AND ($1::int IS NULL OR company_id=$1)
        ON CONFLICT (contract_id, attendance_date) DO UPDATE SET status=$3, updated_at=NOW()
        RETURNING id
      `;
      params = [companyId, targetDate, status, contract_ids];
    } else {
      query = `
        INSERT INTO contract_labour_attendance (company_id, contract_id, attendance_date, status)
        SELECT company_id, id, $2, $3 FROM contract_labour WHERE is_active=TRUE AND ($1::int IS NULL OR company_id=$1)
        ON CONFLICT (contract_id, attendance_date) DO UPDATE SET status=$3, updated_at=NOW()
        RETURNING id
      `;
      params = [companyId, targetDate, status];
    }
    const result = await pool.query(query, params).catch(() => ({ rows: [] }));
    res.json({ marked: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
