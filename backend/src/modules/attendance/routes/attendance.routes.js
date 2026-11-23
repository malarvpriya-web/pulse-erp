import express from 'express';
import pool from '../../shared/db.js';
import attendanceRepository from '../repositories/attendance.repository.js';
import { clockRateLimit } from '../../../middlewares/attendanceRateLimit.js';
import { hasRole, can } from '../../../middlewares/auth.middleware.js';
import { dimension } from '../../../shared/dashboardFilters.js';
import { getWeekendDays, dayIsWeekend } from '../../../shared/weekend.js';
import { getFullDayHours, getAttendanceSwitches, getAttendanceSettingsRow, recordOvertime, notifyLateArrival } from '../../../shared/attendanceRules.js';
import { loadPunchProfile, assertCanSelfPunch, describePunchMode } from '../../../shared/punchMode.js';
import { parseTimeToMins, calcLateAndStatus, resolveEmployeeShift } from '../../../shared/shiftResolve.js';
import {
  requireAttendanceAdmin,
  makeRequireAttendanceApprover,
  requireAttendanceOperator,
  isAttendanceAdmin,
  isAttendanceOperator,
  assertSelfOrPrivileged,
  assertCanDecideFor,
  assertCanViewEmployee,
  attendanceViewClause,
  teamSql,
} from '../attendance.authz.js';
import { captureBefore } from '../../../middlewares/captureBefore.js';
import { toCsv } from '../../../shared/csv.js';
import { companyOf } from '../../../shared/scope.js';
import { normaliseRules, computePenalties, describeRule, loadPenaltyRules } from '../../../shared/attendancePenalties.js';
import { teamMonthlySummary } from '../../../shared/attendanceTeamSummary.js';
import { isCompOffEligible } from '../../../shared/compOff.js';

const router = express.Router();

// §278.2: reporting managers approve their team whatever their login role.
const requireAttendanceApprover = makeRequireAttendanceApprover(pool);

// §278.2: every attendance read is limited to the caller's own record and
// their team unless they are HR/admin. Returns the extra WHERE text for an
// employees alias, or null after sending 403 (login not linked).
function viewFilter(req, res, alias = 'e') {
  const clause = attendanceViewClause(req, alias);
  if (clause === null) {
    res.status(403).json({ error: 'Forbidden', code: 'EMPLOYEE_LINK_REQUIRED',
      message: 'Your login is not linked to an employee record. Ask HR to link it.' });
  }
  return clause;
}

// HR / admin only — company-wide records with no per-employee meaning to scope.
function adminOnly(req, res) {
  if (isAttendanceAdmin(req)) return true;
  res.status(403).json({ error: 'Forbidden', code: 'ATTENDANCE_ROLE_REQUIRED',
    message: 'Only HR and administrators can see this.' });
  return false;
}

// Request lists (regularization, shift change): own requests plus those of
// the people the caller decides for — direct reports and delegations — read
// from the reporting line, not the login role (a reporting manager holding
// only `employee` used to see none of their team's requests). `ownCol` is the
// request's employee column. Callers have already checked employee_id != null.
function requestScopeSql(req, ownCol, alias = 'e') {
  const me = Number.parseInt(req.user?.employee_id, 10);
  return ` AND (${ownCol} = ${me} OR ${teamSql(alias, me, { departmentHeads: false })})`;
}

// One employee's records: self, their manager / department head / delegate, or HR.
async function canView(req, res, employeeId) {
  const denied = await assertCanViewEmployee(pool, req, employeeId);
  if (denied) { res.status(denied.status).json(denied.body); return false; }
  return true;
}

function scopeCompanyId(req) {
  return req.scope?.company_id ?? null;
}

// getWeekendDays / dayIsWeekend / DOW_NAMES now live in shared/weekend.js so
// comp-off answers "is this a non-working day?" the same way attendance does.
// The local copies also looked the settings row up with `WHERE company_id = $1`,
// which never matches the global (company_id IS NULL) row — every tenant fell
// through to the hardcoded Sat/Sun default and Attendance Settings had no effect.

// getFullDayHours (the OT threshold) and isPeriodFrozen (the payroll freeze)
// now live in shared/attendanceRules.js, so the biometric sync and CSV import
// apply them too. Offline sync and the auto-checkout cron still hardcode 9 —
// see ATTENDANCE_DUPLICATION_FLOW_AUDIT.md §1b.

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
       WHERE LOWER(status) IN ('active','probation','notice')
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
    // ?date=YYYY-MM-DD shows a past day (§278: HR looks back at yesterday etc.);
    // default today. A future date is refused.
    const nowDay    = new Date().toLocaleDateString('en-CA');
    const qd        = String(req.query.date || '');
    if (qd && (!/^\d{4}-\d{2}-\d{2}$/.test(qd) || qd > nowDay)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD and not in the future' });
    }
    const today     = qd || nowDay;
    // §278.2: HR/admin see everyone; a manager / department head their team;
    // anyone else only themselves.
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const cidClause = (companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '') + viewClause;
    // Dashboard filter bar: ?department only. This is a LIVE view of today's
    // presence — a date range would contradict what the page is, so it renders
    // with showPeriod={false}.
    const department = dimension(req.query, 'department');

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
        WHERE LOWER(e.status) IN ('active','probation','notice') AND e.deleted_at IS NULL
          AND ($2::text IS NULL OR e.department = $2)
          ${clause}
      `, [today, department]);

    let presenceResult = await presenceQuery(cidClause);
    if (parseInt(presenceResult.rows[0]?.total_employees || 0) === 0 && companyId != null) {
      // Employees may not have company_id set — fall back to unscoped count
      const fallback = await presenceQuery(viewClause).catch(() => null);
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
          ${(companyId != null || viewClause) ? `AND EXISTS (SELECT 1 FROM employees e WHERE e.id = sa.employee_id ${companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : ''}${viewClause})` : ''}
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

    // Everyone expected today, with their status — the list HR filters
    // (department / status / name) on Live Workforce. §278.
    const { rows: people } = await pool.query(`
      SELECT e.id, e.office_id AS emp_code,
             COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS name,
             e.department, e.designation, e.is_field_employee,
             ar.check_in_time::text AS check_in, ar.check_out_time::text AS check_out,
             ar.late_minutes, ar.work_mode, ar.source, ar.total_hours,
             CASE
               WHEN ar.id IS NOT NULL AND LOWER(ar.status) IN ('present','late','half_day','wfh','on_leave','holiday','absent') THEN LOWER(ar.status)
               WHEN EXISTS (SELECT 1 FROM leave_applications la WHERE la.employee_id = e.id AND la.status = 'approved'
                             AND $1::date BETWEEN la.start_date AND la.end_date) THEN 'on_leave'
               WHEN ar.id IS NOT NULL THEN LOWER(COALESCE(ar.status, 'present'))
               ELSE 'not_punched'
             END AS today_status,
             (ar.check_in_time IS NOT NULL AND ar.check_out_time IS NULL) AS inside
        FROM employees e
        LEFT JOIN attendance_records ar
          ON ar.employee_id = e.id AND ar.attendance_date = $1 AND ar.deleted_at IS NULL
       WHERE LOWER(e.status) IN ('active','probation','notice') AND e.deleted_at IS NULL
         AND ($2::text IS NULL OR e.department = $2)
         ${cidClause}
       ORDER BY e.department NULLS LAST, name
       LIMIT 2000
    `, [today, department]).catch(() => ({ rows: [] }));

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
      is_weekly_off:   isWeekendToday,
      // §278.4: Settings → Late arrival → late bands ("above 10 / 15 / 30 min");
      // the page groups people[].late_minutes by these.
      late_bands:      settingsResponse(await getAttendanceSettingsRow(companyId)).late_bands,
      is_today:        today === nowDay,
      people:          people.map((r) => ({ ...r, today_status: isWeekendToday && r.today_status === 'not_punched' ? 'weekly_off' : r.today_status })),
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
    if (!(await canView(req, res, req.params.employee_id))) return;
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const records = await attendanceRepository.findByDate(
      req.params.date, { ...req.query, company_id: companyId, __viewClause: viewClause }
    );
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary/:employee_id', async (req, res) => {
  try {
    if (!(await canView(req, res, req.params.employee_id))) return;
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
    // §278: a manager / department head sees only THEIR team — the id in the
    // URL used to be taken as given, so anyone could read any team.
    if (!isAttendanceAdmin(req) && String(req.user?.employee_id ?? '') !== String(req.params.manager_id)) {
      return res.status(403).json({ error: 'Forbidden', message: 'You can only see your own team.' });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// 3b. PUNCH MODE — how (and whether) the caller may clock in from the app
// ─────────────────────────────────────────────────────────────────────────────
// Field employees punch in-app with a camera selfie + GPS; everyone else uses
// the office face / biometric device. The clock UI calls this on mount so it
// renders the right control instead of offering a button the server will 403.
// Reads its own employee id from the session — an id in the query is honoured
// only for privileged callers, so nobody can probe another employee's setup.
router.get('/punch-mode', async (req, res) => {
  try {
    const empId = isAttendanceOperator(req) && req.query.employee_id
      ? parseInt(req.query.employee_id)
      : (req.user?.employee_id ?? null);

    if (empId == null) {
      return res.json({
        employee_id: null,
        mode: 'device',
        is_field_employee: false,
        can_punch_in_app: false,
        selfie_required: false,
        location_required: false,
        reason: 'employee_not_linked',
        message: 'Your login is not linked to an employee record. Ask HR to link it before clocking in or out.',
      });
    }

    const profile = await loadPunchProfile(empId);
    res.json({ employee_id: empId, ...describePunchMode(profile) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/today/:employee_id', async (req, res) => {
  try {
    if (!(await canView(req, res, req.params.employee_id))) return;
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
            `SELECT 1 FROM employees WHERE id = $1 AND reporting_manager_id = $2 AND deleted_at IS NULL LIMIT 1`,
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

    // ── In-app punch gate (applies to BOTH directions) ───────────────────
    // Only employees flagged `is_field_employee` punch from the app, and only
    // with a camera selfie + GPS. Everyone else records attendance on the
    // office face / biometric terminal, which writes attendance_records through
    // hr/biometric.routes.js and never reaches this route. Admin/HR punching on
    // behalf of someone else is a correction, not a self punch, and is exempt.
    //
    // This replaces the old face_token gate: a field employee has no face-match
    // step to produce a token with, so the geotagged selfie enforced here is
    // their proof of presence. face_token is still accepted (and ignored) so an
    // older cached client does not break.
    const isSelfPunch  = !!callerEmpId && String(callerEmpId) === String(employee_id);
    const punchProfile = await loadPunchProfile(employee_id);
    const empDept      = punchProfile?.department || null;
    const isField      = punchProfile?.is_field_employee === true;

    if (isSelfPunch) {
      const denial = assertCanSelfPunch(punchProfile, { action, selfie_url, location });
      if (denial) {
        await writeAuditLog({
          companyId, employeeId: employee_id, action: 'clock_blocked_punch_mode',
          afterData: { reason: denial.body.error, punch: action, mode: denial.body.mode },
          performedBy: employee_id, req,
        }).catch(() => {});
        return res.status(denial.status).json(denial.body);
      }
    }

    if (action === 'in') {

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

      // Notify reporting manager of late arrival (fire-and-forget, non-blocking).
      // Through employees.reporting_manager_id — it matched the free-text
      // reporting_manager NAME before, which misses on any spelling difference.
      if (derivedStatus === 'late') notifyLateArrival(employee_id, lateMinutes, 'clocked in').catch(() => {});

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
      if (isSelfPunchOut && !isAttendanceAdmin(req) && prev.rows[0]?.check_in_time) {
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

      // Auto-calculate and record OT beyond the full on-site day (work + break)
      if (prev.rows[0]?.check_in_time && result.rows[0]) {
        // Hoisted out of the OT try/catch below. The comp-off auto-grant is a
        // SIBLING block that reads both of these, so it referenced them from
        // outside their scope and threw ReferenceError on every holiday
        // clock-out — swallowed whole by its own `catch {}`. Comp off has never
        // actually been auto-granted.
        let totalHours   = 0;
        // On-site hours that make a full day (work + break, Attendance Settings).
        const fullDayHours = await getFullDayHours(companyId);
        try {
          const hoursResult = await pool.query(
            `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS hours`,
            [time, String(prev.rows[0].check_in_time).slice(0, 5)]
          );
          // Cross-midnight shift: Postgres time subtraction goes negative — add 24h to correct
          const rawHours = parseFloat(hoursResult.rows[0]?.hours || 0);
          totalHours = rawHours < 0 ? rawHours + 24 : rawHours;
          const otHours    = Math.max(0, totalHours - fullDayHours);

          await pool.query(`
            UPDATE attendance_records
               SET total_hours = $3, ot_hours = $4
             WHERE employee_id = $1 AND attendance_date = $2
          `, [employee_id, today, Math.abs(totalHours).toFixed(2), otHours.toFixed(2)]);

          // Only OT-eligible shifts earn overtime; recordOvertime() does
          // nothing while overtime is switched off in Attendance Settings.
          const shiftEligible = await pool.query(
            'SELECT COALESCE(ot_eligible, TRUE) AS ot_eligible FROM hr_shifts WHERE id = (SELECT shift_id FROM hr_shift_assignments WHERE employee_id=$1 AND is_active=TRUE ORDER BY effective_from DESC LIMIT 1)',
            [employee_id]
          ).catch(() => ({ rows: [{ ot_eligible: true }] }));
          if (otHours >= 0.5 && (shiftEligible.rows[0]?.ot_eligible !== false)) {
            const { shift: otShift } = await resolveEmployeeShift(employee_id, today).catch(() => ({ shift: null }));
            await recordOvertime(pool, {
              companyId, employeeId: employee_id, date: today, otHours,
              isNightShift: !!otShift?.is_night_shift,
            });
          }
        } catch { /* non-blocking OT calc */ }

        // Auto-grant comp-off if employee worked on a holiday with sufficient hours
        // Comp off is switched off until the owner configures it (§278).
        try {
          const { compOffEnabled } = await getAttendanceSwitches(companyId);
          const weekendDaysComp = await getWeekendDays(companyId);
          const isWeekend2 = dayIsWeekend(today, weekendDaysComp);
          // §278.4: only employees chosen for comp off (Settings → Comp off).
          if (compOffEnabled && !isWeekend2 && await isCompOffEligible(pool, employee_id)) {
            const hQ = await pool.query(
              `SELECT id FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) LIMIT 1`,
              [today, companyId]
            );
            if (hQ.rows.length > 0 && totalHours >= fullDayHours) {
              const holidayId = hQ.rows[0].id;
              // WHERE NOT EXISTS, not ON CONFLICT: compensatory_off has no
              // unique index on (employee_id, work_date), so the ON CONFLICT
              // this used to carry raised 42P10 on every single holiday punch-out
              // and the surrounding `catch {}` ate it — comp off has never once
              // been auto-granted. A plain unique index is also the wrong fix
              // here: a rejected request must stay re-submittable for that date.
              //
              // expires_on is computed in SQL. Date#setMonth mutates in local
              // time while toISOString() reads back UTC, so the old expiry
              // landed a day early east of UTC, and 30 Nov + 3 months rolled
              // through Feb 30 into 2 Mar.
              await pool.query(`
                INSERT INTO compensatory_off
                  (employee_id, work_date, hours_worked, holiday_id, reason, expires_on, company_id, auto_granted)
                SELECT $1, $2::date, $3, $4, $5, ($2::date + INTERVAL '3 months')::date, $6, TRUE
                 WHERE NOT EXISTS (
                   SELECT 1 FROM compensatory_off
                    WHERE employee_id = $1 AND work_date = $2::date AND status <> 'rejected'
                 )
              `, [
                employee_id, today,
                parseFloat(totalHours).toFixed(2),
                holidayId,
                'Auto-granted: worked a full day on holiday',
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
        // §278.4: field staff with no shift assigned are measured against the
        // default end time in Settings, as machine punches are.
        const endTime = coShift2?.end_time || (await getAttendanceSettingsRow(companyId))?.work_end_time;
        if (endTime && !coShift2?.is_night_shift) {
          const scheduledEndMins = parseTimeToMins(endTime);
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
    if (!(await canView(req, res, req.params.employee_id))) return;
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE o.status = 'pending')                                         AS pending_count,
        COUNT(*) FILTER (WHERE o.status IN ('approved','auto_approved'))                     AS approved_count,
        COUNT(*) FILTER (WHERE o.status = 'rejected')                                        AS rejected_count,
        COUNT(*)                                                                              AS total_records,
        COALESCE(SUM(o.ot_hours), 0)                                                         AS total_ot_hours,
        COALESCE(SUM(o.ot_hours) FILTER (WHERE o.status IN ('approved','auto_approved')), 0) AS approved_hours,
        COALESCE(SUM(o.ot_hours) FILTER (WHERE o.status = 'pending'), 0)                     AS pending_hours
      FROM attendance_ot_records o
      JOIN employees e ON e.id = o.employee_id
      WHERE EXTRACT(MONTH FROM o.attendance_date) = $1
        AND EXTRACT(YEAR  FROM o.attendance_date) = $2
        AND ($3::integer IS NULL OR o.company_id = $3)
        ${viewClause}
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
    // §278.2: this list had no narrowing at all — every employee saw the
    // company's overtime. HR/admin: all; managers: their team; others: own.
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    q += viewClause;
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
    // Overtime is paid at twice the ordinary rate (Factories Act s.59 / OSH Code s.27).
    const OT_MULTIPLIERS = { weekday: 2.0, weekend: 2.0, holiday: 2.0, night: 2.0 };
    const multiplier = OT_MULTIPLIERS[safeType] ?? 2.0;
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

router.put('/overtime/:id/approve', requireAttendanceApprover, captureBefore('attendance_ot_records'), async (req, res) => {
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

router.put('/overtime/:id/reject', requireAttendanceApprover, captureBefore('attendance_ot_records'), async (req, res) => {
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
// Hours a regularisation asks for: check-out minus check-in (overnight-safe).
// With `ar` (the day's attendance row) an end the request leaves unchanged
// falls back to the recorded time, so "forgot to punch out" still shows hours.
const REG_HOURS_SQL = (r, ar = null) => {
  const cin = ar ? `COALESCE(${r}.check_in, ${ar}.check_in_time)` : `${r}.check_in`;
  const cout = ar ? `COALESCE(${r}.check_out, ${ar}.check_out_time)` : `${r}.check_out`;
  return `CASE WHEN ${cin} IS NOT NULL AND ${cout} IS NOT NULL THEN
  ROUND((EXTRACT(EPOCH FROM (${cout} - ${cin})) / 3600
         + CASE WHEN ${cout} < ${cin} THEN 24 ELSE 0 END)::numeric, 2) END`;
};
// Who decided: manager_id / hr_id hold users.id.
const REG_DECIDERS_SQL = (r) => `
  (SELECT COALESCE(ee.name, u.name, u.email) FROM users u LEFT JOIN employees ee ON ee.id = u.employee_id WHERE u.id = ${r}.manager_id) AS manager_name,
  (SELECT COALESCE(ee.name, u.name, u.email) FROM users u LEFT JOIN employees ee ON ee.id = u.employee_id WHERE u.id = ${r}.hr_id) AS hr_name`;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How many regularisations an employee has raised for the month of `date`
 * (pending + approved — a rejected one does not use up the allowance).
 * The limit is Attendance Settings → Regularization (default 3, §278).
 */
async function regularizationQuota(employeeId, date, companyId) {
  const { regularizationLimit } = await getAttendanceSwitches(companyId);
  const { rows: [u] } = await pool.query(`
    SELECT COUNT(*)::int AS used FROM attendance_regularization_requests
     WHERE employee_id = $1 AND status IN ('pending', 'approved')
       AND date_trunc('month', date) = date_trunc('month', $2::date)`, [employeeId, date]);
  return { limit: regularizationLimit, used: u?.used || 0, month: String(date).slice(0, 7) };
}

router.post('/regularize', async (req, res) => {
  try {
    const { employee_id, date, check_in, check_out, reason } = req.body;
    const companyId = scopeCompanyId(req);

    // §278.3 (owner, 2026-11-19): the EMPLOYEE asks, for their own record —
    // nobody raises one on someone else's behalf (HR corrects a record
    // directly with Team Attendance → Edit). The request then goes to the
    // reporting manager and, after them, HR.
    if (req.user?.employee_id == null || String(req.user.employee_id) !== String(employee_id)) {
      return res.status(403).json({ error: 'Forbidden', code: 'NOT_YOUR_RECORD',
        message: 'Only the employee can ask for an attendance correction, from My Attendance.' });
    }

    if (!employee_id || !YMD.test(String(date || ''))) {
      return res.status(400).json({ error: 'employee_id and date (YYYY-MM-DD) are required' });
    }
    // The business day (process clock pinned to APP_TIMEZONE), not the UTC date.
    const todayLocal = new Date().toLocaleDateString('en-CA');
    if (String(date) > todayLocal) {
      return res.status(400).json({ error: 'A regularization can only be raised for a past or current day' });
    }
    // Same day only by default (Settings → Regularization → days allowed).
    const regSettings = await getAttendanceSettingsRow(companyId);
    const windowDays = Math.max(0, Number(regSettings?.regularization_window_days ?? 0));
    const earliest = new Date(`${todayLocal}T00:00:00`);
    earliest.setDate(earliest.getDate() - windowDays);
    if (String(date) < earliest.toLocaleDateString('en-CA')) {
      return res.status(400).json({
        error: 'regularization_window',
        message: windowDays === 0
          ? 'A correction must be asked for on the same day.'
          : `A correction can be asked for up to ${windowDays} day${windowDays === 1 ? '' : 's'} later.`,
      });
    }
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'Give a reason for the correction' });
    if (!check_in && !check_out) return res.status(400).json({ error: 'Give the correct check-in and/or check-out time' });

    // One open request per day, and the monthly allowance.
    const { rows: dup } = await pool.query(`
      SELECT id FROM attendance_regularization_requests
       WHERE employee_id = $1 AND date = $2::date AND status = 'pending' LIMIT 1`, [employee_id, date]);
    if (dup.length) {
      return res.status(409).json({ error: 'duplicate_request', message: `A correction for ${date} is already waiting for approval.` });
    }
    const quota = await regularizationQuota(employee_id, date, companyId);
    if (quota.used >= quota.limit) {
      return res.status(409).json({
        error: 'regularization_limit',
        message: `Only ${quota.limit} attendance correction${quota.limit === 1 ? '' : 's'} can be raised per month; ${quota.used} already raised for ${quota.month}.`,
        ...quota,
      });
    }

    const result = await pool.query(`
      INSERT INTO attendance_regularization_requests
        (employee_id, date, check_in, check_out, reason, company_id, approval_level, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'manager', 'pending')
      RETURNING *, ${REG_HOURS_SQL('attendance_regularization_requests')} AS requested_hours
    `, [employee_id, date, check_in || null, check_out || null, String(reason).trim(), companyId]);
    await writeAuditLog({
      companyId, employeeId: employee_id, action: 'regularize_submit',
      afterData: { date, check_in, check_out, reason },
      performedBy: req.user?.userId, req,
    });
    res.json({ ...result.rows[0], quota: { ...quota, used: quota.used + 1 } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The employee's allowance for the month of ?date (default today): { limit, used, month }.
router.get('/regularize/quota/:employee_id', async (req, res) => {
  try {
    const ownership = assertSelfOrPrivileged(req, req.params.employee_id);
    if (ownership) return res.status(ownership.status).json(ownership.body);
    const date = YMD.test(String(req.query.date || '')) ? req.query.date : new Date().toLocaleDateString('en-CA');
    const s = await getAttendanceSettingsRow(scopeCompanyId(req));
    res.json({
      ...(await regularizationQuota(req.params.employee_id, date, scopeCompanyId(req))),
      // §278.3: how many days back a correction may be asked for (0 = same day).
      window_days: Math.max(0, Number(s?.regularization_window_days ?? 0)),
    });
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
      where += requestScopeSql(req, 'r.employee_id');
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
             e.office_id AS emp_code,
             ${REG_HOURS_SQL('r', 'ar')} AS requested_hours,
             ar.check_in_time::text AS recorded_check_in, ar.check_out_time::text AS recorded_check_out,
             ar.total_hours AS recorded_hours,
             ${REG_DECIDERS_SQL('r')}
        FROM attendance_regularization_requests r
        JOIN employees e ON e.id = r.employee_id
        LEFT JOIN attendance_records ar ON ar.employee_id = r.employee_id AND ar.attendance_date = r.date AND ar.deleted_at IS NULL
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
      q += requestScopeSql(req, 'r.employee_id');
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
             e.office_id AS emp_code,
             ${REG_HOURS_SQL('r', 'ar')} AS requested_hours,
             ar.check_in_time::text AS recorded_check_in, ar.check_out_time::text AS recorded_check_out,
             ar.total_hours AS recorded_hours,
             ${REG_DECIDERS_SQL('r')}
        FROM attendance_regularization_requests r
        JOIN employees e ON e.id = r.employee_id
        LEFT JOIN attendance_records ar ON ar.employee_id = r.employee_id AND ar.attendance_date = r.date AND ar.deleted_at IS NULL
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
      q += requestScopeSql(req, 'r.employee_id');
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
          `SELECT 1 FROM employees WHERE id = $1 AND reporting_manager_id = $2 LIMIT 1`,
          [req.params.employee_id, callerEmpId]
        ).catch(() => ({ rows: [] }));
        if (!managerCheck.rows.length) {
          return res.status(403).json({ error: 'Forbidden: you can only view your own regularization history' });
        }
      }
    }

    const result = await pool.query(`
      SELECT r.id, r.employee_id, r.date::text, r.check_in::text, r.check_out::text,
             r.reason, r.status, r.approval_level, r.manager_remarks, r.hr_remarks,
             r.manager_actioned_at, r.hr_actioned_at, r.created_at,
             ${REG_HOURS_SQL('r', 'ar')} AS requested_hours,
             ${REG_DECIDERS_SQL('r')}
        FROM attendance_regularization_requests r
        LEFT JOIN attendance_records ar ON ar.employee_id = r.employee_id AND ar.attendance_date = r.date AND ar.deleted_at IS NULL
       WHERE r.employee_id = $1
         AND ($2::integer IS NULL OR r.company_id = $2)
       ORDER BY r.created_at DESC
       LIMIT 30
    `, [req.params.employee_id, companyId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve — reporting manager, then HR when Attendance Settings say
// "Regularization needs HR after the manager". HR (and admin) may approve at
// any level. Who decided is kept: manager_id/manager_actioned_at for the
// manager step, hr_id/hr_actioned_at for HR (both users.id), shown as
// manager_name / hr_name on the lists.
router.put('/regularize/:id/approve', requireAttendanceApprover, async (req, res) => {
  try {
    const { remarks }  = req.body;
    const actorId      = req.user?.userId ?? null;
    const before       = (await pool.query(
      `SELECT * FROM attendance_regularization_requests WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!before) return res.status(404).json({ error: 'Request not found' });
    const scope = scopeCompanyId(req);
    if (scope != null && before.company_id != null && String(before.company_id) !== String(scope)) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (before.status !== 'pending') {
      return res.status(409).json({ error: 'not_pending', message: `This request is already ${before.status}.` });
    }
    if (req.user?.employee_id != null && String(req.user.employee_id) === String(before.employee_id)
        && !hasRole(req, 'admin', 'super_admin')) {
      return res.status(403).json({ error: 'Forbidden', message: 'You cannot approve your own attendance correction.' });
    }

    const currentLevel = before.approval_level || 'manager';
    // hasRole unions ALL roles held, not just the primary one.
    const isHR = hasRole(req, 'hr', 'hr_manager', 'admin', 'super_admin');

    let newLevel;
    if (currentLevel === 'hr') {
      if (!isHR) return res.status(403).json({ error: 'This regularization is pending HR approval' });
      newLevel = 'done';
    } else if (isHR) {
      newLevel = 'done';
    } else {
      const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'regularization');
      if (decide) return res.status(decide.status).json(decide.body);
      const { regularizationNeedsHr } = await getAttendanceSwitches(before.company_id);
      newLevel = regularizationNeedsHr ? 'hr' : 'done';
    }
    const applyCorrection = newLevel === 'done';
    // The manager columns are the reporting manager's step; HR (or admin)
    // deciding straight away is recorded once, as HR.
    const managerStep = currentLevel === 'manager' && !isHR;

    const updated = await pool.query(`
      UPDATE attendance_regularization_requests
         SET status              = $2,
             approval_level      = $3,
             manager_id          = CASE WHEN $4 THEN $5::int ELSE manager_id END,
             manager_remarks     = CASE WHEN $4 THEN $6 ELSE manager_remarks END,
             manager_actioned_at = CASE WHEN $4 THEN NOW() ELSE manager_actioned_at END,
             hr_id               = CASE WHEN $7 THEN $5::int ELSE hr_id END,
             hr_remarks          = CASE WHEN $7 THEN $6 ELSE hr_remarks END,
             hr_actioned_at      = CASE WHEN $7 THEN NOW() ELSE hr_actioned_at END
       WHERE id = $1 AND status = 'pending'
       RETURNING *
    `, [req.params.id, applyCorrection ? 'approved' : 'pending', newLevel,
        managerStep, actorId, remarks || null, isHR]);
    if (!updated.rows.length) return res.status(409).json({ error: 'not_pending', message: 'This request was decided by someone else just now.' });

    if (applyCorrection) {
      // Upsert attendance record — create if absent, correct times if already
      // exists. Approved leave/holiday is not overwritten by a time correction.
      await pool.query(`
        INSERT INTO attendance_records
          (employee_id, attendance_date, status, company_id, check_in_time, check_out_time, source, approved_by, remarks)
        VALUES ($1, $2, 'present', $3, $4::time, $5::time, 'regularization', $6, $7)
        ON CONFLICT (employee_id, attendance_date) DO UPDATE
          SET status         = CASE WHEN LOWER(attendance_records.status) IN ('on_leave','leave','holiday')
                                    THEN attendance_records.status ELSE 'present' END,
              check_in_time  = COALESCE($4::time, attendance_records.check_in_time),
              check_out_time = COALESCE($5::time, attendance_records.check_out_time),
              approved_by    = $6,
              remarks        = $7,
              updated_at     = NOW()
      `, [before.employee_id, before.date, before.company_id,
          before.check_in || null, before.check_out || null, actorId,
          `Regularized: ${String(before.reason || '').slice(0, 200)}`]);

      // Recompute hours (and request OT when overtime is on) from the final times.
      try {
        const { rows: [rec] } = await pool.query(`
          SELECT check_in_time, check_out_time FROM attendance_records
           WHERE employee_id = $1 AND attendance_date = $2`, [before.employee_id, before.date]);
        if (rec?.check_in_time && rec?.check_out_time) {
          const { rows: [h] } = await pool.query(
            `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS hours`,
            [rec.check_out_time, rec.check_in_time]);
          let totalHours = parseFloat(h?.hours || 0);
          if (totalHours < 0) totalHours += 24;
          const otHours = Math.max(0, totalHours - await getFullDayHours(before.company_id));
          await pool.query(
            `UPDATE attendance_records SET total_hours = $3, ot_hours = $4 WHERE employee_id = $1 AND attendance_date = $2`,
            [before.employee_id, before.date, totalHours.toFixed(2), otHours.toFixed(2)]);
          await recordOvertime(pool, {
            companyId: before.company_id, employeeId: before.employee_id,
            date: String(before.date instanceof Date ? before.date.toISOString() : before.date).slice(0, 10),
            otHours, status: 'pending',
          });
        }
      } catch { /* non-blocking hours / OT recalc */ }

      await notifyEmployee(before.employee_id, {
        title:   'Regularization Approved',
        message: `Your attendance correction for ${before.date} has been approved.`,
        refId:   before.id,
      });
    } else {
      // Escalated to HR — tell the HR users (roles are many-to-many: user_roles).
      await pool.query(`
        INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
        SELECT DISTINCT u.id, 'Regularization Awaiting HR Approval', $2, 'attendance', $3, 'regularization_hr'
          FROM users u
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON r.id = ur.role_id
         WHERE u.is_active AND LOWER(r.code) IN ('hr', 'hr_manager')
           AND ($1::integer IS NULL OR u.company_id = $1 OR u.company_id IS NULL)
         LIMIT 10
      `, [before.company_id, `Attendance correction for ${before.date} is awaiting HR approval.`, before.id]).catch(() => {});
    }

    await writeAuditLog({
      companyId: before.company_id, employeeId: before.employee_id,
      action: applyCorrection ? 'regularize_approved' : 'regularize_escalated_hr',
      beforeData: before, afterData: updated.rows[0],
      performedBy: actorId, reason: remarks, req,
    });
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject — records who rejected and why, notifies the employee.
router.put('/regularize/:id/reject', requireAttendanceApprover, captureBefore('attendance_regularization_requests'), async (req, res) => {
  try {
    const { remarks } = req.body;
    const actorId     = req.user?.userId ?? null;
    const before      = (await pool.query(
      `SELECT * FROM attendance_regularization_requests WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!before) return res.status(404).json({ error: 'Request not found' });
    const scope = scopeCompanyId(req);
    if (scope != null && before.company_id != null && String(before.company_id) !== String(scope)) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (before.status !== 'pending') {
      return res.status(409).json({ error: 'not_pending', message: `This request is already ${before.status}.` });
    }
    if (!String(remarks || '').trim()) return res.status(400).json({ error: 'Give a reason for rejecting' });

    const isHR = hasRole(req, 'hr', 'hr_manager', 'admin', 'super_admin');
    if (!isHR) {
      if ((before.approval_level || 'manager') === 'hr') {
        return res.status(403).json({ error: 'This regularization is pending HR approval' });
      }
      const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'regularization');
      if (decide) return res.status(decide.status).json(decide.body);
    }
    const hrStep = isHR;

    const result = await pool.query(`
      UPDATE attendance_regularization_requests
         SET status              = 'rejected',
             approval_level      = 'done',
             manager_id          = CASE WHEN $4 THEN manager_id ELSE $2::int END,
             manager_remarks     = CASE WHEN $4 THEN manager_remarks ELSE $3 END,
             manager_actioned_at = CASE WHEN $4 THEN manager_actioned_at ELSE NOW() END,
             hr_id               = CASE WHEN $4 THEN $2::int ELSE hr_id END,
             hr_remarks          = CASE WHEN $4 THEN $3 ELSE hr_remarks END,
             hr_actioned_at      = CASE WHEN $4 THEN NOW() ELSE hr_actioned_at END
       WHERE id = $1 AND status = 'pending'
       RETURNING *
    `, [req.params.id, actorId, String(remarks).trim(), hrStep]);
    if (!result.rows.length) return res.status(409).json({ error: 'not_pending', message: 'This request was decided by someone else just now.' });

    await notifyEmployee(before.employee_id, {
      title:   'Regularization Rejected',
      message: `Your attendance correction request for ${before.date} was rejected: ${String(remarks).trim()}`,
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

router.put('/policies/:id', requireAttendanceAdmin, captureBefore('attendance_policies'), async (req, res) => {
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

router.delete('/policies/:id', requireAttendanceAdmin, captureBefore('attendance_policies'), async (req, res) => {
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

router.put('/geo-rules/:id', requireAttendanceAdmin, captureBefore('attendance_geo_rules'), async (req, res) => {
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

router.delete('/geo-rules/:id', requireAttendanceAdmin, captureBefore('attendance_geo_rules'), async (req, res) => {
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const companyId = scopeCompanyId(req);
    const { month, year, department } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const pad2 = n => String(n).padStart(2, '0');
    const startDate = `${y}-${pad2(m)}-01`;
    const endDate   = `${y}-${pad2(m)}-${new Date(y, m, 0).getDate()}`;
    const cidClause = (companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '') + viewClause;
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
        AND LOWER(e.status) IN ('active','probation','notice')
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

// Absenteeism / attendance trend, one row per month (empty months included).
// ?period = 12m (default) | 24m | this_year | last_year | YYYY ; ?department.
// Holidays and weekly offs are not working days, so they are left out of the
// rate; late and half-day count as attended (shared/statusSets.js).
router.get('/analytics/absenteeism', async (req, res) => {
  try {
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const companyId = scopeCompanyId(req);
    const department = dimension(req.query, 'department');
    const now = new Date();
    const thisYear = now.getFullYear();
    const period = String(req.query.period || '12m');
    let from; let to;
    const monthStart = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
    if (period === '24m' || period === '12m') {
      const n = period === '24m' ? 24 : 12;
      const d = new Date(thisYear, now.getMonth() - (n - 1), 1);
      from = monthStart(d.getFullYear(), d.getMonth() + 1);
      to = monthStart(thisYear, now.getMonth() + 1);
    } else {
      const y = period === 'this_year' ? thisYear : period === 'last_year' ? thisYear - 1 : parseInt(period, 10);
      if (!Number.isInteger(y) || y < 2000 || y > thisYear) return res.status(400).json({ error: 'period must be 12m, 24m, this_year, last_year or a year' });
      from = monthStart(y, 1);
      to = monthStart(y, y === thisYear ? now.getMonth() + 1 : 12);
    }

    const { rows } = await pool.query(`
      WITH months AS (
        SELECT generate_series($1::date, $2::date, INTERVAL '1 month')::date AS m
      ), recs AS (
        SELECT date_trunc('month', ar.attendance_date)::date AS m, LOWER(ar.status) AS st, ar.employee_id, ar.late_minutes
          FROM attendance_records ar
          JOIN employees e ON e.id = ar.employee_id
         WHERE ar.attendance_date >= $1::date AND ar.attendance_date < ($2::date + INTERVAL '1 month')
           AND ar.deleted_at IS NULL
           AND ($3::int IS NULL OR e.company_id = $3) ${viewClause}
           AND ($4::text IS NULL OR e.department = $4)
      )
      SELECT EXTRACT(YEAR FROM mo.m)::int AS year, EXTRACT(MONTH FROM mo.m)::int AS month,
             COUNT(r.st) FILTER (WHERE r.st NOT IN ('holiday', 'weekend', 'week_off'))::int            AS total_records,
             COUNT(r.st) FILTER (WHERE r.st = 'absent')::int                                           AS absent_count,
             COUNT(r.st) FILTER (WHERE r.st IN ('present', 'wfh', 'work_from_home', 'on_duty'))::int  AS present_count,
             COUNT(r.st) FILTER (WHERE r.st = 'late')::int                                             AS late_count,
             COUNT(r.st) FILTER (WHERE r.st = 'half_day')::int                                         AS half_day_count,
             COUNT(r.st) FILTER (WHERE r.st IN ('on_leave', 'leave'))::int                             AS leave_count,
             COUNT(DISTINCT r.employee_id)::int                                                        AS unique_employees,
             ROUND(COUNT(r.st) FILTER (WHERE r.st = 'absent')::numeric
                   / NULLIF(COUNT(r.st) FILTER (WHERE r.st NOT IN ('holiday', 'weekend', 'week_off')), 0) * 100, 2) AS absenteeism_rate,
             ROUND(COUNT(r.st) FILTER (WHERE r.st IN ('present', 'late', 'half_day', 'wfh', 'work_from_home', 'on_duty'))::numeric
                   / NULLIF(COUNT(r.st) FILTER (WHERE r.st NOT IN ('holiday', 'weekend', 'week_off')), 0) * 100, 2) AS attendance_rate,
             ROUND(COUNT(r.st) FILTER (WHERE r.st = 'late')::numeric
                   / NULLIF(COUNT(r.st) FILTER (WHERE r.st NOT IN ('holiday', 'weekend', 'week_off')), 0) * 100, 2) AS late_rate
        FROM months mo
        LEFT JOIN recs r ON r.m = mo.m
       GROUP BY mo.m
       ORDER BY mo.m DESC
    `, [from, to, companyId, department]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Department absenteeism breakdown — with prev-month delta and department filter
router.get('/analytics/department-absenteeism', async (req, res) => {
  try {
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
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
          AND LOWER(e.status) IN ('active','probation','notice')
          AND ($3::integer IS NULL OR e.company_id = $3) ${viewClause}
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
          AND LOWER(e.status) IN ('active','probation','notice')
          AND ($3::integer IS NULL OR e.company_id = $3) ${viewClause}
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
// OT cost = hours × multiplier × Basic / 26 / 9 per department. A department
// with one OT earner gives that person's Basic back by division, so the two
// cost columns are salary data: payroll:view, as the Payroll Center (PC-01
// closure). Hours and approval counts stay as they were. A login with no
// company used to read every tenant's.
router.get('/analytics/overtime-cost', async (req, res) => {
  try {
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const companyId = scopeCompanyId(req);
    if (companyId == null && !req.scope?.isGlobal) return res.status(403).json({ error: 'No company context for this login' });
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
            * COALESCE(o.multiplier, 2)
            * COALESCE(e.basic_salary, 0)::numeric / 26.0 / 9.0
          ) FILTER (WHERE o.status IN ('approved','auto_approved')), 0
        )                                                                          AS approved_ot_cost,
        ROUND(
          SUM(
            o.ot_hours::numeric
            * COALESCE(o.multiplier, 2)
            * COALESCE(e.basic_salary, 0)::numeric / 26.0 / 9.0
          ), 0
        )                                                                          AS total_ot_cost
      FROM attendance_ot_records o
      JOIN employees e ON e.id = o.employee_id
      WHERE EXTRACT(MONTH FROM o.attendance_date) = $1
        AND EXTRACT(YEAR  FROM o.attendance_date) = $2
        AND ($3::integer IS NULL OR o.company_id = $3) ${viewClause}
      GROUP BY e.department
      ORDER BY total_ot_hours DESC
    `, [m, y, companyId]).catch(() => ({ rows: [] }));
    if (await can(req, 'payroll', 'view')) return res.json(rows);
    res.json(rows.map(r => ({ ...r, approved_ot_cost: null, total_ot_cost: null, cost_restricted: true })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shift efficiency
router.get('/analytics/shift-efficiency', async (req, res) => {
  try {
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const companyId = scopeCompanyId(req);
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const cidClause = (companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '') + viewClause;

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
         AND LOWER(status) IN ('active','probation','notice')
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
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
        AND LOWER(e.status) IN ('active','probation','notice')
        AND ($3::integer IS NULL OR e.company_id = $3) ${viewClause}
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
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
        AND LOWER(e.status) IN ('active','probation','notice')
        AND ($3::integer IS NULL OR e.company_id = $3) ${viewClause}
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
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
        AND ($1::integer IS NULL OR ar.company_id = $1) ${viewClause}
        AND EXTRACT(MONTH FROM ar.attendance_date) = $2
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $3
        AND ($4::text IS NULL OR e.department = $4)
        AND ar.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM leave_applications la
           WHERE la.employee_id = ar.employee_id
             AND la.status = 'approved'
             AND ar.attendance_date BETWEEN la.start_date AND la.end_date
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
        lt.leave_name AS leave_type
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      JOIN leave_applications la
        ON la.employee_id = ar.employee_id
       AND la.status = 'approved'
       AND ar.attendance_date BETWEEN la.start_date AND la.end_date
      LEFT JOIN leave_types lt ON lt.id = la.leave_type_id
      WHERE ar.status IN ('present','half_day','late')
        AND ($1::integer IS NULL OR ar.company_id = $1) ${viewClause}
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const companyId = scopeCompanyId(req);
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year)  || new Date().getFullYear();
    const department = req.query.department || null;
    // §278.5: the cut-off is Settings → Late arrival → "early exit counts from".
    const minEarlyMins = parseInt(req.query.min_early_minutes)
      || Number((await getAttendanceSettingsRow(scopeCompanyId(req)))?.early_exit_minutes) || 15;

    const { rows } = await pool.query(`
      SELECT
        ar.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        ar.attendance_date,
        ar.check_out_time AS check_out,
        s.name             AS shift_name,
        s.end_time         AS shift_end_time,
        ROUND(
          EXTRACT(EPOCH FROM (s.end_time::time - ar.check_out_time::time)) / 60
        )                  AS early_by_minutes
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      JOIN (
        SELECT DISTINCT ON (esa.employee_id) esa.employee_id, esa.shift_id
          FROM hr_shift_assignments esa
         ORDER BY esa.employee_id, esa.effective_from DESC
      ) best ON best.employee_id = ar.employee_id
      JOIN hr_shifts s ON s.id = best.shift_id
      WHERE ar.check_out_time IS NOT NULL
        AND s.end_time IS NOT NULL
        AND ($1::integer IS NULL OR ar.company_id = $1) ${viewClause}
        AND EXTRACT(MONTH FROM ar.attendance_date) = $2
        AND EXTRACT(YEAR  FROM ar.attendance_date) = $3
        AND ($4::text IS NULL OR e.department = $4)
        AND ar.deleted_at IS NULL
        AND NOT s.is_night_shift
        AND ar.check_out_time::time < s.end_time::time
        AND EXTRACT(EPOCH FROM (s.end_time::time - ar.check_out_time::time)) / 60 >= $5
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const companyId = scopeCompanyId(req);
    const { action, employee_id, from_date, to_date } = req.query;
    let q = `
      SELECT al.*,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             COALESCE(p.name, CONCAT(p.first_name,' ',p.last_name)) AS performed_by_name
        FROM attendance_audit_logs al
        LEFT JOIN employees e ON e.id = al.employee_id
        LEFT JOIN employees p ON p.id = al.performed_by
       WHERE ($1::integer IS NULL OR al.company_id = $1) ${viewClause}
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
    // Roles are many-to-many: any one of the user's roles may allow it.
    const roles = [req.user?.role, ...(req.user?.roles || [])].map(r => String(r || '').toLowerCase());
    if (!roles.some(r => ['admin', 'super_admin', 'hr_admin', 'hr_manager', 'hr', 'payroll_admin'].includes(r))) {
      return res.status(403).json({ error: 'Only HR, payroll or an administrator can sync attendance to payroll' });
    }

    const { month, year, force = false, employee_ids } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year required' });
    const m         = parseInt(month);
    const y         = parseInt(year);
    // One company, always (PAYROLL_DATA_FLOW_AUDIT.md Part 10). scopeCompanyId
    // returned null for a global super admin or a user with no company, and
    // every statement below then ran across ALL companies — freezing their
    // attendance and rewriting their draft payroll runs.
    const companyId = companyOf(req);
    if (companyId == null) {
      return res.status(400).json({ error: 'Company context required — payroll sync acts on one company' });
    }
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

    // Subtract company holidays from working days. Last month's holidays too:
    // absence after last month's cutoff is counted here (carried forward).
    const prevM = m === 1 ? 12 : m - 1, prevY = m === 1 ? y - 1 : y;
    const prevStart = `${prevY}-${pad2(prevM)}-01`;
    const prevEnd = `${prevY}-${pad2(prevM)}-${pad2(new Date(prevY, prevM, 0).getDate())}`;
    const holidayDates = new Set((await pool.query(`
      SELECT date::text AS d FROM holidays
       WHERE date BETWEEN $1 AND $2
         AND (company_id = $3 OR company_id IS NULL)
         AND EXTRACT(DOW FROM date) NOT IN (0, 6)
    `, [prevStart, endDate, companyId])).rows.map(r => r.d));
    workingDays = Math.max(0, workingDays - [...holidayDates].filter(d => d >= startDate).length);
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isoOf = (d) => (d == null ? null : (d instanceof Date ? d.toLocaleDateString('en-CA') : String(d).slice(0, 10)));
    const nextDay = (ds) => { const d = new Date(`${ds}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
    // Mon–Fri working days in [from, to], less company holidays.
    const countWorking = (from, to) => {
      let n = 0;
      for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        const dow = d.getUTCDay(), ds = d.toISOString().slice(0, 10);
        if (dow !== 0 && dow !== 6 && !holidayDates.has(ds)) n++;
      }
      return n;
    };
    // An employee's range inside [from, to]: never before joining or after exit.
    const clip = (from, to, joining, exit) => [[from, isoOf(joining)].filter(Boolean).sort().pop(), [to, isoOf(exit)].filter(Boolean).sort()[0]];
    // Loss of pay in [from, to]: working days not covered by attendance
    // (present / late / WFH, half days as half) or approved paid leave.
    const lopInRange = async (employeeId, from, to) => {
      if (from > to) return { lop: 0, working: 0, leave: 0 };
      const working = countWorking(from, to);
      const { rows: [a] } = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('present','late','wfh'))::int AS p,
               COUNT(*) FILTER (WHERE status = 'half_day')::int AS h
          FROM attendance_records WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3 AND deleted_at IS NULL`, [employeeId, from, to]);
      // Approved PAID leave: not loss-of-pay leave (the application's is_lop, or a
      // leave type that is unpaid or LOP); a half-day leave counts as half. The old
      // query read a column that does not exist (leave_type) and swallowed the
      // error, so approved leave was always 0 days — people on paid leave lost pay.
      const { rows: [l] } = await pool.query(`
        SELECT COALESCE(SUM(CASE WHEN la.half_day THEN 0.5
                                 ELSE LEAST(la.end_date, $3::date) - GREATEST(la.start_date, $2::date) + 1 END), 0)::numeric AS leave_days
          FROM leave_applications la
          LEFT JOIN leave_types lt ON lt.id = la.leave_type_id
         WHERE la.employee_id = $1 AND LOWER(la.status) = 'approved' AND la.deleted_at IS NULL
           AND NOT COALESCE(la.is_lop, false) AND COALESCE(lt.is_paid, true) AND NOT COALESCE(lt.is_lop_type, false)
           AND la.start_date <= $3::date AND la.end_date >= $2::date`, [employeeId, from, to]);
      const leave = Math.min(parseFloat(l.leave_days || 0), working);
      const lop = Math.max(0, Math.round((working - (a.p + a.h * 0.5 + leave)) * 2) / 2);
      return { lop, working, leave };
    };
    const { rows: existing } = await pool.query(
      `SELECT employee_id, month, year, counted_to::text AS counted_to, carried_to_next FROM payroll_attendance_summary
        WHERE ((month = $1 AND year = $2) OR (month = $3 AND year = $4)) AND company_id = $5`, [m, y, prevM, prevY, companyId]);
    const summaryOf = (empId, mm, yy) => existing.find(r => r.employee_id === empId && r.month === mm && r.year === yy);

    // Step 4 — aggregate per-employee attendance stats
    const { rows: empStats } = await pool.query(`
      SELECT
        e.id AS employee_id, e.joining_date, e.exit_date,
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
      WHERE LOWER(e.status) IN ('active','probation','notice')
        AND e.deleted_at IS NULL ${cidEmp}
        ${empFilter.replace(/AND employee_id/, 'AND e.id')}
      GROUP BY e.id, e.joining_date, e.exit_date
    `, [startDate, endDate]);

    // Late-coming penalties (§278.3, Settings → Late-coming penalties): extra
    // loss-of-pay days for the month so far, per the company's rules.
    const penalties = await computePenalties(companyId, empStats.map((r) => r.employee_id),
      startDate, [endDate, todayIso].sort()[0]);

    // Step 5 — upsert payroll_attendance_summary + patch pending payroll_runs
    const lopSummary = [];
    for (const row of empStats) {
      const presentDays = parseInt(row.present_days || 0);
      const wfhDays     = parseInt(row.wfh_days     || 0);
      const halfDays    = parseInt(row.half_days    || 0);
      const absentDays  = parseInt(row.absent_days  || 0);
      const lateCount   = parseInt(row.late_count   || 0);
      const otHours     = parseFloat(row.ot_hours   || 0);

      // This month: the employee's full working days (the value of a day of pay),
      // and absence counted up to today — or, when next month has already carried
      // this month's later days, only up to the day counted then.
      const mine = summaryOf(row.employee_id, m, y);
      const countedTo = mine?.carried_to_next && mine.counted_to ? mine.counted_to : [endDate, todayIso].sort()[0];
      const [fFrom, fTo] = clip(startDate, endDate, row.joining_date, row.exit_date);
      const empWorkingDays = fFrom > fTo ? 0 : countWorking(fFrom, fTo);
      const [cFrom, cTo] = clip(startDate, countedTo, row.joining_date, row.exit_date);
      const counted = await lopInRange(row.employee_id, cFrom, cTo);
      const pen = penalties.get(Number(row.employee_id)) || { days: 0, lines: [] };
      const lopDays = counted.lop + pen.days;
      const approvedLeaveDays = counted.leave;

      // Last month: days after the day its sync counted (e.g. after a cutoff on
      // the 20th) were paid in full; their absence is deducted this month, at
      // last month's per-day value, once.
      let carriedLop = 0, carriedBase = null;
      const prev = summaryOf(row.employee_id, prevM, prevY);
      if (prev?.counted_to && prev.counted_to < prevEnd) {
        const [gFrom, gTo] = clip(nextDay(prev.counted_to), prevEnd, row.joining_date, row.exit_date);
        carriedLop = (await lopInRange(row.employee_id, gFrom, gTo)).lop;
        const [pFrom, pTo] = clip(prevStart, prevEnd, row.joining_date, row.exit_date);
        carriedBase = pFrom > pTo ? null : countWorking(pFrom, pTo);
        await pool.query(`UPDATE payroll_attendance_summary SET carried_to_next = true
                            WHERE employee_id = $1 AND month = $2 AND year = $3`, [row.employee_id, prevM, prevY]);
      }

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

      // Night shifts go to the attendance summary, which payroll reads. Drafts are
      // NOT patched here: a figure changed without recomputing the money made a
      // draft show 5 LOP days while still paying the full month. Payroll's release
      // check finds drafts that no longer match and asks for a regenerate.
      lopSummary.push({ employee_id: row.employee_id, lop_days: lopDays, penalty_lop_days: pen.days, carried_lop_days: carriedLop, counted_to: countedTo });

      await pool.query(`
        INSERT INTO payroll_attendance_summary
          (company_id, employee_id, month, year, working_days, present_days,
           absent_days, late_count, ot_hours, lop_days, wfh_days, half_days,
           leave_days, synced_by, night_shift_days, counted_to, carried_lop_days, carried_base_days,
           penalty_lop_days, penalty_detail, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,NOW())
        ON CONFLICT (employee_id, month, year)
        DO UPDATE SET
          working_days = $5,  present_days = $6,  absent_days = $7,
          late_count   = $8,  ot_hours     = $9,  lop_days    = $10,
          wfh_days     = $11, half_days    = $12, leave_days  = $13,
          synced_by    = $14, night_shift_days = $15, counted_to = $16,
          carried_lop_days = $17, carried_base_days = $18,
          penalty_lop_days = $19, penalty_detail = $20::jsonb, synced_at = NOW()
      `, [companyId, row.employee_id, m, y, empWorkingDays,
          presentDays, absentDays, lateCount, otHours, lopDays,
          wfhDays, halfDays, approvedLeaveDays,
          req.user?.userId || null, nightShiftDays, countedTo, carriedLop, carriedBase,
          pen.days, JSON.stringify(pen.lines)]);

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
router.get('/shift-occupancy', requireAttendanceAdmin, async (req, res) => {  // §278.2: HR / admin only (no page calls it)
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

// Work centres are Production's master list (routing, MRP, scheduling read it).
// Owner, 2026-11-19: Attendance only picks from it — the create / edit / delete
// routes that lived here are removed; Production → Work Centre Planning
// (/bom/work-centres) is the one place to change them.

// Attendance logs for a given date
router.get('/work-centre', requireAttendanceOperator, async (req, res) => {  // §278.2: managers / HR only
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
router.delete('/work-centre/:id', requireAttendanceAdmin, captureBefore('work_centre_attendance'), async (req, res) => {
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
router.get('/work-centre/analytics', requireAttendanceOperator, async (req, res) => {  // §278.2: managers / HR only
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
           COALESCE(s.name,'Unassigned')                            AS shift_name,
           ROUND(COALESCE(SUM(wca.hours_worked),0)::numeric, 2)     AS total_hours,
           COALESCE(SUM(wca.units_produced),0)                      AS total_units,
           COUNT(DISTINCT wca.employee_id)                          AS unique_employees
         FROM work_centre_attendance wca
         LEFT JOIN hr_shifts s ON s.id = wca.shift_id
         WHERE ($1::integer IS NULL OR wca.company_id = $1)
           AND wca.attendance_date BETWEEN $2 AND $3
         GROUP BY s.name
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

router.get('/contract-labour/stats', requireAttendanceOperator, async (req, res) => {  // §278.2: managers / HR only
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

router.get('/contract-labour', requireAttendanceOperator, async (req, res) => {  // §278.2: managers / HR only
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

router.put('/contract-labour/:id', requireAttendanceAdmin, captureBefore('contract_labour'), async (req, res) => {
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

router.delete('/contract-labour/:id', requireAttendanceAdmin, captureBefore('contract_labour'), async (req, res) => {
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
         AND LOWER(status) IN ('active','probation','notice')
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const records   = await attendanceRepository.getLateArrivals({ ...req.query, company_id: companyId, __viewClause: viewClause });

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

    // Employee and department names are free text; the shared writer also
    // neutralises a leading = + - @ so the export cannot execute.
    // See shared/csv.js.
    const csv = toCsv(headers, csvRows);

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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    let q = `
      SELECT w.*,
             -- The warning keeps the name it was issued under; show the
             -- employee's CURRENT name and department (owner, 2026-11-19:
             -- a rename must show everywhere).
             COALESCE(e.name, w.employee_name) AS employee_name,
             COALESCE(e.department, w.department) AS department,
             COALESCE(i.name, CONCAT(i.first_name,' ',COALESCE(i.last_name,''))) AS issued_by_name
        FROM attendance_late_warnings w
        JOIN employees e ON e.id = w.employee_id
        LEFT JOIN employees i ON i.id = w.issued_by
       WHERE ($1::integer IS NULL OR w.company_id = $1) ${viewClause}
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

    // Notify the employee (fire-and-forget). employees has no user_id column —
    // this always returned zero rows, so the warning notification never sent.
    pool.query(
      `SELECT id AS user_id FROM users WHERE employee_id = $1`,
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
    const lateArrivals = await attendanceRepository.getLateArrivals({ ...req.query, company_id: companyId, __viewClause: viewClause });
    res.json(lateArrivals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/monthly-report', async (req, res) => {
  try {
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
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
    const cidClause = (companyId != null ? ` AND e.company_id = ${parseInt(companyId)}` : '') + viewClause;

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
        AND LOWER(e.status) IN ('active','probation','notice')
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

    // Late-coming penalty days (§278.3) — what Payroll Sync will add to LOP.
    const todayDay = new Date().toLocaleDateString('en-CA');
    const pen = await computePenalties(companyId, records.map((r) => r.employee_id), startDate, [endDate, todayDay].sort()[0]);
    for (const r of records) {
      const p = pen.get(Number(r.employee_id));
      r.penalty_days = p?.days || 0;
      r.penalty_lines = p?.lines?.map(({ text, occurrences, deduct_days }) => ({ text, occurrences, deduct_days })) || [];
    }

    res.json({ month: m, year: y, working_days: workingDays, start_date: startDate, end_date: endDate, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Comp off is given only to chosen employees (§278.4, owner 2026-11-19:
// production staff, not everyone). GET lists current employees with the
// choice; PUT { employee_ids } sets exactly those as eligible. HR/admin only.
router.get('/comp-off-eligibility', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { rows } = await pool.query(`
      SELECT e.id, e.office_id AS emp_code,
             COALESCE(e.name, CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS name,
             e.department, e.designation, e.comp_off_eligible
        FROM employees e
       WHERE e.deleted_at IS NULL AND LOWER(e.status) IN ('active','probation','notice')
         AND ($1::int IS NULL OR e.company_id = $1)
       ORDER BY e.department NULLS LAST, name`, [companyId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/comp-off-eligibility', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const ids = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids.map(Number).filter(Number.isFinite) : null;
    if (!ids) return res.status(400).json({ error: 'employee_ids must be a list' });
    const { rows: before } = await pool.query(
      `SELECT id FROM employees WHERE comp_off_eligible = TRUE AND ($1::int IS NULL OR company_id = $1)`, [companyId]);
    await pool.query(`
      UPDATE employees SET comp_off_eligible = (id = ANY($2::int[]))
       WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
         AND comp_off_eligible IS DISTINCT FROM (id = ANY($2::int[]))`, [companyId, ids]);
    await writeAuditLog({
      companyId, action: 'comp_off_eligibility_updated',
      beforeData: { employee_ids: before.map((r) => r.id) }, afterData: { employee_ids: ids },
      performedBy: req.user?.userId, req,
    });
    res.json({ employee_ids: ids });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /attendance/team-summary?month=&year= — one row per team member for the
// month: leaves, late (up to 15 / 15–30 / over 30 min), early exits, geo fence,
// penalty days (§278.3). HR/admin: everyone; a manager / department head:
// their team (not themselves); anyone else: an empty team.
router.get('/team-summary', async (req, res) => {
  try {
    const now = new Date();
    const m = parseInt(req.query.month) || now.getMonth() + 1;
    const y = parseInt(req.query.year) || now.getFullYear();
    let employeeWhere = '';
    if (!isAttendanceAdmin(req)) {
      const me = Number.parseInt(req.user?.employee_id, 10);
      if (!Number.isFinite(me)) return res.status(403).json({ error: 'Forbidden', code: 'EMPLOYEE_LINK_REQUIRED' });
      employeeWhere = ` AND e.id <> ${me} AND ${teamSql('e', me)}`;
    }
    const department = dimension(req.query, 'department');
    if (department) employeeWhere += ` AND e.department = '${String(department).replace(/'/g, "''")}'`;
    res.json(await teamMonthlySummary({ companyId: scopeCompanyId(req), month: m, year: y, employeeWhere }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/penalties/:employee_id?month=&year= — the late-coming
// penalties counted so far this month (§278.3), so the employee sees them
// before payroll does. Self, their manager / department head, or HR.
router.get('/penalties/:employee_id', async (req, res) => {
  try {
    if (!(await canView(req, res, req.params.employee_id))) return;
    const companyId = scopeCompanyId(req);
    const now = new Date();
    const m = parseInt(req.query.month) || now.getMonth() + 1;
    const y = parseInt(req.query.year) || now.getFullYear();
    const pad = (n) => String(n).padStart(2, '0');
    const from = `${y}-${pad(m)}-01`;
    const to = [`${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`, now.toLocaleDateString('en-CA')].sort()[0];
    const empId = Number(req.params.employee_id);
    const result = (await computePenalties(companyId, [empId], from, to)).get(empId) || { days: 0, lines: [] };
    const rules = (await loadPenaltyRules(companyId)).filter((r) => r.active !== false).map(describeRule);
    res.json({ month: m, year: y, penalty_days: result.days, lines: result.lines, rules });
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

// Shift create/edit/delete/assign is HR → /hr/shifts* (Attendance → Configuration →
// Shifts & Rotations). The attendance copies here duplicated it on the same
// tables with a hard DELETE and no company check; removed in §278.

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
// ATTENDANCE SETTINGS — one row per company (§278)
//
// Every field here is READ somewhere; settings that nothing read (geo, report,
// work-centre JSON, attendance mode, face) were removed from the screen and
// the API. Readers: shared/attendanceRules.js (full day, switches, limits),
// shared/weekend.js (weekend days), hr/biometric.routes.js dayRules (default
// start/end, timezone), jobs/attendance.cron.js (working days, auto check-out).
// ─────────────────────────────────────────────────────────────────────────────
const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SETTINGS_FIELDS = {
  working_days:                 'jsonb',
  timezone:                     'text',
  work_start_time:              'time',
  work_end_time:                'time',
  full_day_hours:               'num',
  break_duration:               'int',
  half_day_hours:               'num',
  auto_checkout:                'bool',
  auto_checkout_time:           'time',
  ot_enabled:                   'bool',
  comp_off_enabled:             'bool',
  regularization_monthly_limit: 'int',
  regularization_needs_hr:      'bool',
  device_settings:              'jsonb',
  // §278.3 (owner, 2026-11-19)
  regularization_window_days:   'int',
  punch_reminder_enabled:       'bool',
  punch_reminder_minutes:       'int',
  punch_out_reminder_enabled:   'bool',
  team_summary_enabled:         'bool',
  // §278.4
  late_bands:                   'jsonb',
  punctuality_bands:            'jsonb',
  // §278.5
  leave_rating_bands:           'jsonb',
  late_warning_count:           'int',
  early_exit_minutes:           'int',
};

// Leave rating: days off in the review period at most max_days = rating; the
// last band (max_days null) is "more than that".
function cleanLeaveBands(v) {
  const list = (Array.isArray(v) ? v : [])
    .map((b) => ({ max_days: b?.max_days === null || b?.max_days === '' ? null : Math.round(Number(b?.max_days)), rating: Math.round(Number(b?.rating)) }));
  const capped = list.filter((b) => b.max_days != null);
  if (!list.length || list.length > 10 || list.some((b) => !(b.rating >= 1 && b.rating <= 5))
      || capped.some((b) => !(b.max_days >= 0 && b.max_days <= 366))) {
    throw Object.assign(new Error('Each leave band needs days (0–366) and a rating (1–5)'), { status: 400 });
  }
  capped.sort((a, b) => a.max_days - b.max_days);
  const last = list.find((b) => b.max_days == null) || { max_days: null, rating: 1 };
  return [...capped, last];
}

// Late bands: 1–5 whole minutes, ascending ("above 10 / 15 / 30 min").
function cleanLateBands(v) {
  const list = [...new Set((Array.isArray(v) ? v : []).map((x) => Math.round(Number(x))))]
    .filter((x) => Number.isFinite(x) && x >= 1 && x <= 240).sort((a, b) => a - b);
  if (!list.length || list.length > 5) throw Object.assign(new Error('Give 1 to 5 late bands, in minutes (1–240)'), { status: 400 });
  return list;
}
// Punctuality → rating: on time on at least min_pct % of days present = rating.
function cleanPunctualityBands(v) {
  const list = (Array.isArray(v) ? v : []).map((b) => ({ min_pct: Math.round(Number(b?.min_pct)), rating: Math.round(Number(b?.rating)) }));
  if (!list.length || list.length > 10 || list.some((b) => !(b.min_pct >= 0 && b.min_pct <= 100) || !(b.rating >= 1 && b.rating <= 5))) {
    throw Object.assign(new Error('Each punctuality band needs a % (0–100) and a rating (1–5)'), { status: 400 });
  }
  list.sort((a, b) => b.min_pct - a.min_pct);
  if (list[list.length - 1].min_pct !== 0) list.push({ min_pct: 0, rating: 1 });
  return list;
}
const DEVICE_DEFAULTS = { auto_sync: true, sync_interval_minutes: 15 };

function settingsResponse(row, policies = {}) {
  const r = row || {};
  return {
    company_id:                   r.company_id ?? null,
    working_days:                 Array.isArray(r.working_days) ? r.working_days : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    weekend_days:                 Array.isArray(r.weekend_days) ? r.weekend_days : ['saturday', 'sunday'],
    timezone:                     r.timezone || 'Asia/Kolkata',
    work_start_time:              String(r.work_start_time || '09:00').slice(0, 5),
    work_end_time:                String(r.work_end_time || '18:00').slice(0, 5),
    full_day_hours:               r.full_day_hours != null ? Number(r.full_day_hours) : 8,
    break_duration:               r.break_duration != null ? Number(r.break_duration) : 30,
    half_day_hours:               r.half_day_hours != null ? Number(r.half_day_hours) : 4.5,
    auto_checkout:                r.auto_checkout === true,
    auto_checkout_time:           String(r.auto_checkout_time || '21:00').slice(0, 5),
    ot_enabled:                   r.ot_enabled === true,
    comp_off_enabled:             r.comp_off_enabled === true,
    regularization_monthly_limit: r.regularization_monthly_limit != null ? Number(r.regularization_monthly_limit) : 3,
    regularization_needs_hr:      r.regularization_needs_hr === true,
    regularization_window_days:   r.regularization_window_days != null ? Number(r.regularization_window_days) : 0,
    punch_reminder_enabled:       r.punch_reminder_enabled !== false,
    punch_reminder_minutes:       r.punch_reminder_minutes != null ? Number(r.punch_reminder_minutes) : 15,
    punch_out_reminder_enabled:   r.punch_out_reminder_enabled !== false,
    team_summary_enabled:         r.team_summary_enabled !== false,
    late_bands:                   Array.isArray(r.late_bands) && r.late_bands.length ? r.late_bands : [10, 15, 30],
    punctuality_bands:            Array.isArray(r.punctuality_bands) && r.punctuality_bands.length ? r.punctuality_bands
      : [{ min_pct: 95, rating: 5 }, { min_pct: 90, rating: 4 }, { min_pct: 80, rating: 3 }, { min_pct: 70, rating: 2 }, { min_pct: 0, rating: 1 }],
    leave_rating_bands:           Array.isArray(r.leave_rating_bands) && r.leave_rating_bands.length ? r.leave_rating_bands
      : [{ max_days: 6, rating: 5 }, { max_days: 12, rating: 4 }, { max_days: 18, rating: 3 }, { max_days: 24, rating: 2 }, { max_days: null, rating: 1 }],
    late_warning_count:           r.late_warning_count != null ? Number(r.late_warning_count) : 3,
    early_exit_minutes:           r.early_exit_minutes != null ? Number(r.early_exit_minutes) : 15,
    // Late-coming penalty rules (attendance_policies 'penalty'), §278.3.
    penalty_rules:                Array.isArray(policies.penalty?.rules) ? policies.penalty.rules : [],
    device_settings:              { ...DEVICE_DEFAULTS, ...(r.device_settings || {}) },
    // Late rules and overtime rules live in attendance_policies (the engine reads them there).
    grace_minutes:                Number(policies.late?.grace_minutes ?? 10),
    clock_window_early_minutes:   Number(policies.clock_window?.early_minutes ?? 15),
    clock_window_late_minutes:    Number(policies.clock_window?.late_minutes ?? 15),
    ot_requires_approval:         policies.overtime?.requires_approval !== false,
    ot_weekday_multiplier:        Number(policies.overtime?.weekday_multiplier ?? 2),
    ot_weekend_multiplier:        Number(policies.overtime?.weekend_multiplier ?? 2),
    ot_holiday_multiplier:        Number(policies.overtime?.holiday_multiplier ?? 2),
    ot_max_daily_hours:           Number(policies.overtime?.max_daily_ot_hours ?? 0),
    ot_max_monthly_hours:         Number(policies.overtime?.max_monthly_ot_hours ?? 0),
  };
}

async function loadPolicies(companyId) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (policy_type) policy_type, rules FROM attendance_policies
     WHERE is_active = true AND policy_type IN ('late', 'clock_window', 'overtime', 'penalty')
       AND (company_id = $1 OR company_id IS NULL)
     ORDER BY policy_type, company_id DESC NULLS LAST, id`, [companyId ?? null]).catch(() => ({ rows: [] }));
  return Object.fromEntries(rows.map((r) => [r.policy_type, r.rules || {}]));
}

// Merge rule values into the company's active policy of that type (created if missing).
async function savePolicyRules(companyId, type, name, patch, userId) {
  if (!Object.keys(patch).length) return;
  const { rows: [p] } = await pool.query(`
    SELECT id, company_id FROM attendance_policies
     WHERE policy_type = $1 AND is_active = true AND (company_id = $2 OR company_id IS NULL)
     ORDER BY company_id DESC NULLS LAST, id LIMIT 1`, [type, companyId ?? null]);
  if (p) {
    await pool.query(`UPDATE attendance_policies SET rules = COALESCE(rules, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [p.id, JSON.stringify(patch)]);
  } else {
    await pool.query(`INSERT INTO attendance_policies (company_id, policy_type, name, rules, is_active, created_by) VALUES ($1, $2, $3, $4, true, $5)`,
      [companyId ?? null, type, name, JSON.stringify(patch), userId ?? null]);
  }
}

/**
 * Write settings to the company's row (created from the global defaults the
 * first time), or to the single global row for a global-scope login. Unknown
 * keys are ignored; working_days also rewrites weekend_days so the two can
 * never disagree again.
 */
async function saveAttendanceSettings(companyId, body, userId) {
  const sets = []; const vals = [];
  for (const [k, kind] of Object.entries(SETTINGS_FIELDS)) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (k === 'working_days') {
      v = (Array.isArray(v) ? v : []).map((d) => String(d).toLowerCase()).filter((d) => ALL_DAYS.includes(d));
      if (!v.length) throw Object.assign(new Error('Choose at least one working day'), { status: 400 });
      vals.push(JSON.stringify(ALL_DAYS.filter((d) => !v.includes(d))));
      sets.push(`weekend_days = $${vals.length}::jsonb`);
    }
    if (k === 'device_settings') v = { ...DEVICE_DEFAULTS, ...(v || {}) };
    if (k === 'late_bands') v = cleanLateBands(v);
    if (k === 'punctuality_bands') v = cleanPunctualityBands(v);
    if (k === 'leave_rating_bands') v = cleanLeaveBands(v);
    if (k === 'late_warning_count' && !(Number(v) >= 1 && Number(v) <= 31)) {
      throw Object.assign(new Error('Late warning after: 1 to 31 late arrivals'), { status: 400 });
    }
    if (k === 'early_exit_minutes' && !(Number(v) >= 1 && Number(v) <= 240)) {
      throw Object.assign(new Error('Early exit counts from: 1 to 240 minutes'), { status: 400 });
    }
    if (kind === 'num' || kind === 'int') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0) throw Object.assign(new Error(`${k} must be a number`), { status: 400 });
      if (kind === 'int') v = Math.round(v);
    }
    if (kind === 'bool') v = v === true || v === 'true';
    vals.push(kind === 'jsonb' ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}${kind === 'jsonb' ? '::jsonb' : kind === 'time' ? '::time' : ''}`);
  }
  if (companyId != null) {
    await pool.query(`
      INSERT INTO attendance_general_settings
        (company_id, working_days, weekend_days, timezone, work_start_time, work_end_time, full_day_hours,
         break_duration, half_day_hours, auto_checkout, auto_checkout_time, device_settings)
      SELECT $1::int, working_days, weekend_days, timezone, work_start_time, work_end_time, full_day_hours,
             break_duration, half_day_hours, auto_checkout, auto_checkout_time, device_settings
        FROM attendance_general_settings WHERE company_id IS NULL
      UNION ALL
      SELECT $1::int, '["monday","tuesday","wednesday","thursday","friday"]'::jsonb, '["saturday","sunday"]'::jsonb,
             'Asia/Kolkata', '09:00'::time, '18:00'::time, 8, 30, 4.5, false, '21:00'::time, '{}'::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM attendance_general_settings WHERE company_id IS NULL)
      LIMIT 1
      ON CONFLICT (company_id) DO NOTHING`, [companyId]);
  } else {
    await pool.query(`
      INSERT INTO attendance_general_settings (company_id) SELECT NULL
       WHERE NOT EXISTS (SELECT 1 FROM attendance_general_settings WHERE company_id IS NULL)`);
  }
  if (sets.length) {
    vals.push(userId ?? null);
    sets.push(`updated_by = $${vals.length}`, 'updated_at = NOW()');
    vals.push(companyId ?? null);
    await pool.query(
      `UPDATE attendance_general_settings SET ${sets.join(', ')}
        WHERE ${companyId != null ? `company_id = $${vals.length}` : `company_id IS NULL AND $${vals.length}::int IS NULL`}`, vals);
  }

  // Rules that live in attendance_policies.
  const late = {}; const win = {}; const ot = {};
  if (body.grace_minutes != null) late.grace_minutes = Math.max(0, Math.round(Number(body.grace_minutes) || 0));
  if (body.clock_window_early_minutes != null) win.early_minutes = Math.max(0, Math.round(Number(body.clock_window_early_minutes) || 0));
  if (body.clock_window_late_minutes != null) win.late_minutes = Math.max(0, Math.round(Number(body.clock_window_late_minutes) || 0));
  if (body.ot_requires_approval != null) ot.requires_approval = body.ot_requires_approval === true || body.ot_requires_approval === 'true';
  for (const [src, dst] of [['ot_weekday_multiplier', 'weekday_multiplier'], ['ot_weekend_multiplier', 'weekend_multiplier'],
    ['ot_holiday_multiplier', 'holiday_multiplier'], ['ot_max_daily_hours', 'max_daily_ot_hours'], ['ot_max_monthly_hours', 'max_monthly_ot_hours']]) {
    if (body[src] == null) continue;
    const n = Number(body[src]);
    if (!Number.isFinite(n) || n < 0 || (dst.endsWith('multiplier') && n > 5)) {
      throw Object.assign(new Error(`${src} must be between 0 and ${dst.endsWith('multiplier') ? 5 : 'any positive number'}`), { status: 400 });
    }
    ot[dst] = n;
  }
  await savePolicyRules(companyId, 'late', 'Late arrival rules', late, userId);
  await savePolicyRules(companyId, 'clock_window', 'Clock-in window', win, userId);
  await savePolicyRules(companyId, 'overtime', 'Overtime rules', ot, userId);
  // Late-coming penalties (§278.3): the whole list is replaced on save.
  if (body.penalty_rules !== undefined) {
    await savePolicyRules(companyId, 'penalty', 'Late-coming penalties', { rules: normaliseRules(body.penalty_rules) }, userId);
  }
}

async function readAttendanceSettings(companyId) {
  return settingsResponse(await getAttendanceSettingsRow(companyId), await loadPolicies(companyId));
}

router.get('/general-settings', async (req, res) => {
  try {
    res.json(await readAttendanceSettings(scopeCompanyId(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/general-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const before = await readAttendanceSettings(companyId);
    await saveAttendanceSettings(companyId, req.body || {}, req.user?.userId);
    const after = await readAttendanceSettings(companyId);
    await writeAuditLog({ companyId, action: 'settings_updated', beforeData: before, afterData: after, performedBy: req.user?.userId, req });
    res.json(after);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, message: err.message });
  }
});

// Punch-machine sync settings (auto sync on/off, interval) — used by the
// device auto-sync job and shown on Attendance → Punch Machines.
router.get('/device-settings', async (req, res) => {
  try {
    res.json((await readAttendanceSettings(scopeCompanyId(req))).device_settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/device-settings', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const cur = (await readAttendanceSettings(companyId)).device_settings;
    const interval = Number(req.body?.sync_interval_minutes ?? cur.sync_interval_minutes);
    if (!Number.isFinite(interval) || interval < 5 || interval > 1440) {
      return res.status(400).json({ error: 'Sync interval must be between 5 and 1440 minutes' });
    }
    const next = { auto_sync: req.body?.auto_sync ?? cur.auto_sync, sync_interval_minutes: Math.round(interval) };
    await saveAttendanceSettings(companyId, { device_settings: next }, req.user?.userId);
    res.json((await readAttendanceSettings(companyId)).device_settings);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Setup Wizard step "Company timings" — same row, same saver.
router.get('/settings/company-timings', async (req, res) => {
  try {
    const s = await readAttendanceSettings(scopeCompanyId(req));
    res.json({
      work_start_time: s.work_start_time, work_end_time: s.work_end_time,
      break_duration: s.break_duration, min_working_hours: s.full_day_hours, weekend_days: s.weekend_days,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings/company-timings', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const b = req.body || {};
    const weekend = Array.isArray(b.weekend_days) ? b.weekend_days.map((d) => String(d).toLowerCase()) : null;
    await saveAttendanceSettings(companyId, {
      work_start_time: b.work_start_time, work_end_time: b.work_end_time,
      break_duration: b.break_duration, full_day_hours: b.min_working_hours,
      working_days: weekend ? ALL_DAYS.filter((d) => !weekend.includes(d)) : undefined,
    }, req.user?.userId);
    const s = await readAttendanceSettings(companyId);
    res.json({
      work_start_time: s.work_start_time, work_end_time: s.work_end_time,
      break_duration: s.break_duration, min_working_hours: s.full_day_hours, weekend_days: s.weekend_days,
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
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
        -- §278.2: HR/admin see every delegation; anyone else only the ones
        -- they gave or received.
        AND ($2::int IS NULL OR d.delegator_id = $2 OR d.delegate_id = $2)
      ORDER BY d.is_active DESC, d.from_date DESC
    `, [companyId, isAttendanceAdmin(req) ? null : (Number.parseInt(req.user?.employee_id, 10) || -1)]);
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
router.delete('/approval-delegations/:id', requireAttendanceAdmin, captureBefore('attendance_approval_delegations'), async (req, res) => {
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
// 17. SHIFT CHANGE REQUESTS
// ─────────────────────────────────────────────────────────────────────────────
// An employee asks (Shift Calendar) for another shift on one day ('day' → a
// date override on approval) or from a date onwards ('permanent' → their shift
// assignment). The reporting manager or HR decides it on Attendance →
// Approvals → Shift Change, or in the Approval Center (source `shift`). §278.

// The shift each day of a month actually resolves to, for one employee:
// override > assignment > rotation > default. Shift Calendar shows this.
router.get('/shift-calendar/:employee_id', async (req, res) => {
  try {
    const empId = req.params.employee_id;
    if (!isAttendanceOperator(req)) {
      const own = assertSelfOrPrivileged(req, empId);
      if (own) {
        const mgr = await pool.query(
          'SELECT 1 FROM employees WHERE id = $1 AND reporting_manager_id = $2 LIMIT 1',
          [empId, req.user?.employee_id ?? -1]);
        if (!mgr.rows.length) return res.status(own.status).json(own.body);
      }
    }
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year) || new Date().getFullYear();
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out = [];
    for (let d = 1; d <= days; d++) {
      const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const { shift, source } = await resolveEmployeeShift(empId, date);
      out.push({
        date, source,
        shift: shift ? { id: shift.id, name: shift.name, start_time: String(shift.start_time || '').slice(0, 5), end_time: String(shift.end_time || '').slice(0, 5), is_night_shift: !!shift.is_night_shift } : null,
      });
    }
    res.json({ employee_id: Number(empId), month: m, year: y, days: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List — employee: own; manager: own + direct reports; HR/admin: all.
router.get('/shift-change-requests', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { employee_id, status } = req.query;
    let q = `
      SELECT r.*, r.request_date::text AS request_date,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             e.department, e.designation, e.office_id AS emp_code,
             cs.name AS current_shift_name,
             rs.name AS requested_shift_name,
             rs.start_time::text AS requested_start, rs.end_time::text AS requested_end,
             (SELECT COALESCE(ee.name, u.name, u.email) FROM users u LEFT JOIN employees ee ON ee.id = u.employee_id
               WHERE u.id = r.reviewed_by) AS reviewed_by_name
        FROM shift_change_requests r
        JOIN employees e ON e.id = r.employee_id
        LEFT JOIN hr_shifts cs ON cs.id = r.current_shift_id
        LEFT JOIN hr_shifts rs ON rs.id = r.requested_shift_id
       WHERE ($1::int IS NULL OR r.company_id = $1)
    `;
    const params = [companyId];
    let n = 2;
    if (!isAttendanceAdmin(req)) {
      const me = req.user?.employee_id ?? null;
      if (me == null) return res.status(403).json({ error: 'Forbidden', code: 'EMPLOYEE_LINK_REQUIRED' });
      q += requestScopeSql(req, 'r.employee_id');
    }
    if (employee_id) { q += ` AND r.employee_id = $${n++}`; params.push(employee_id); }
    if (status)      { q += ` AND r.status = $${n++}`;      params.push(status); }
    q += ` ORDER BY r.created_at DESC LIMIT 200`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/shift-change-requests', async (req, res) => {
  try {
    const { employee_id, request_date, requested_shift_id, reason } = req.body;
    const changeType = req.body.change_type === 'permanent' ? 'permanent' : 'day';
    if (!employee_id || !YMD.test(String(request_date || '')) || !requested_shift_id) {
      return res.status(400).json({ error: 'employee_id, request_date (YYYY-MM-DD) and requested_shift_id are required' });
    }
    const own = assertSelfOrPrivileged(req, employee_id);
    if (own) return res.status(own.status).json(own.body);
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'Give a reason for the shift change' });
    const companyId = scopeCompanyId(req);
    const { rows: [sh] } = await pool.query(
      `SELECT id FROM hr_shifts WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
      [requested_shift_id, companyId]);
    if (!sh) return res.status(400).json({ error: 'That shift does not exist' });
    const { shift: current } = await resolveEmployeeShift(employee_id, request_date);
    if (current && String(current.id) === String(requested_shift_id)) {
      return res.status(400).json({ error: 'You are already on that shift for this date' });
    }
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM shift_change_requests WHERE employee_id = $1 AND request_date = $2 AND status = 'pending' LIMIT 1`,
      [employee_id, request_date]);
    if (dup.length) return res.status(409).json({ error: 'duplicate_request', message: `A shift change for ${request_date} is already waiting for approval.` });

    const result = await pool.query(`
      INSERT INTO shift_change_requests
        (company_id, employee_id, request_date, current_shift_id, requested_shift_id, reason, change_type, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
      RETURNING *
    `, [companyId, employee_id, request_date, current?.id || null, requested_shift_id, String(reason).trim(), changeType]);
    await writeAuditLog({
      companyId, employeeId: employee_id, action: 'shift_change_requested',
      afterData: result.rows[0], performedBy: req.user?.userId, req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function loadShiftRequestForDecision(req, res) {
  const reviewerId = req.user?.userId;   // never from the body
  if (!reviewerId) { res.status(401).json({ error: 'Authentication required' }); return null; }
  const before = (await pool.query(`SELECT * FROM shift_change_requests WHERE id=$1`, [req.params.id])).rows[0];
  const scope = scopeCompanyId(req);
  if (!before || (scope != null && before.company_id != null && String(before.company_id) !== String(scope))) {
    res.status(404).json({ error: 'Request not found' }); return null;
  }
  if (before.status !== 'pending') { res.status(409).json({ error: `Request is already ${before.status}` }); return null; }
  if (req.user?.employee_id != null && String(req.user.employee_id) === String(before.employee_id)
      && !hasRole(req, 'admin', 'super_admin')) {
    res.status(403).json({ error: 'You cannot decide your own shift change' }); return null;
  }
  const decide = await assertCanDecideFor(pool, req, before.employee_id, before.company_id, 'shift');
  if (decide) { res.status(decide.status).json(decide.body); return null; }
  return { before, reviewerId };
}

router.put('/shift-change-requests/:id/approve', requireAttendanceApprover, async (req, res) => {
  try {
    const ctx = await loadShiftRequestForDecision(req, res);
    if (!ctx) return;
    const { before, reviewerId } = ctx;
    const client = await pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE shift_change_requests
           SET status='approved', reviewed_by=$2, review_remarks=$3, reviewed_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status='pending' RETURNING *
      `, [req.params.id, reviewerId, req.body?.remarks || null]);
      row = result.rows[0];
      if (!row) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Request was already decided' }); }
      if (row.change_type === 'permanent') {
        // From request_date on: end the current assignment, start the new one.
        await client.query(`UPDATE hr_shift_assignments SET is_active=FALSE, updated_at=NOW() WHERE employee_id=$1 AND is_active=TRUE`, [row.employee_id]);
        await client.query(`
          INSERT INTO hr_shift_assignments (employee_id, shift_id, effective_from, is_active, created_by, company_id, note)
          VALUES ($1,$2,$3,TRUE,$4,$5,$6)
          ON CONFLICT (employee_id, shift_id, effective_from) DO UPDATE SET is_active=TRUE, updated_at=NOW()
        `, [row.employee_id, row.requested_shift_id, row.request_date, reviewerId, row.company_id, `Shift change request #${row.id}`]);
      } else {
        // One day only: a date override for request_date.
        await client.query(`UPDATE hr_shift_date_overrides SET is_active=FALSE WHERE employee_id=$1 AND override_date=$2 AND is_active=TRUE`,
          [row.employee_id, row.request_date]);
        await client.query(`
          INSERT INTO hr_shift_date_overrides (employee_id, shift_id, override_date, reason, is_active, company_id, created_by)
          VALUES ($1,$2,$3,$4,TRUE,$5,$6)
        `, [row.employee_id, row.requested_shift_id, row.request_date, `Shift change request #${row.id}: ${row.reason || ''}`.slice(0, 500), row.company_id, reviewerId]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await notifyEmployee(row.employee_id, {
      title: 'Shift Change Approved',
      message: `Your shift change for ${String(row.request_date).slice(0, 10)}${row.change_type === 'permanent' ? ' onwards' : ''} was approved.`,
      refId: row.id,
    });
    await writeAuditLog({
      companyId: row.company_id, employeeId: row.employee_id, action: 'shift_change_approved',
      beforeData: before, afterData: row, performedBy: reviewerId, reason: req.body?.remarks, req,
    });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/shift-change-requests/:id/reject', requireAttendanceApprover, captureBefore('shift_change_requests'), async (req, res) => {
  try {
    const ctx = await loadShiftRequestForDecision(req, res);
    if (!ctx) return;
    const { before, reviewerId } = ctx;
    const remarks = String(req.body?.remarks || '').trim();
    if (!remarks) return res.status(400).json({ error: 'Give a reason for rejecting' });
    const result = await pool.query(`
      UPDATE shift_change_requests
         SET status='rejected', reviewed_by=$2, review_remarks=$3, reviewed_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *
    `, [req.params.id, reviewerId, remarks]);
    if (!result.rows[0]) return res.status(409).json({ error: 'Request was already decided' });
    await notifyEmployee(before.employee_id, {
      title: 'Shift Change Rejected',
      message: `Your shift change for ${String(before.request_date).slice(0, 10)} was rejected: ${remarks}`,
      refId: before.id,
    });
    await writeAuditLog({
      companyId: before.company_id, employeeId: before.employee_id, action: 'shift_change_rejected',
      beforeData: before, afterData: result.rows[0], performedBy: reviewerId, reason: remarks, req,
    });
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
    const viewClause = viewFilter(req, res); if (viewClause === null) return;
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
         ${viewClause}
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
             COUNT(DISTINCT al.employee_id) AS employees_affected,
             COUNT(*) FILTER (WHERE DATE(al.performed_at) = CURRENT_DATE) AS today_violations
        FROM attendance_audit_logs al
        JOIN employees e ON e.id = al.employee_id
       WHERE al.action = 'clock_in_geo_blocked'
         AND ($1::integer IS NULL OR al.company_id = $1)
         AND DATE(al.performed_at) BETWEEN $2 AND $3
         ${viewClause}
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


// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT LABOUR ATTENDANCE (separate from regular attendance)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/contract-labour/attendance', requireAttendanceOperator, async (req, res) => {  // §278.2: managers / HR only
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

router.get('/contract-labour/attendance/monthly', requireAttendanceOperator, async (req, res) => {  // §278.2: managers / HR only
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

// Contract labour → Finance (§278.4, owner 2026-11-19: "contract labour daily
// attendance … has to be sent to Finance"). The month's attendance per
// contractor — workers, man-days (half day = 0.5), hours — is saved as a
// statement and every Finance user is notified, for the contractor's bill.
// Sending the same month again replaces that month's figures.
router.post('/contract-labour/send-to-finance', requireAttendanceAdmin, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const m = parseInt(req.body?.month); const y = parseInt(req.body?.year);
    if (!(m >= 1 && m <= 12) || !(y >= 2000)) return res.status(400).json({ error: 'month and year required' });
    const pad = (n) => String(n).padStart(2, '0');
    const start = `${y}-${pad(m)}-01`; const end = `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
    const { rows } = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(cl.contractor_company), ''), 'No contractor') AS contractor,
             cl.id, cl.employee_name, cl.employee_code,
             COUNT(*) FILTER (WHERE cla.status IN ('present','late'))  AS present_days,
             COUNT(*) FILTER (WHERE cla.status = 'half_day')           AS half_days,
             COUNT(*) FILTER (WHERE cla.status = 'absent')             AS absent_days,
             COALESCE(SUM(cla.hours_worked), 0)                        AS hours
        FROM contract_labour cl
        JOIN contract_labour_attendance cla ON cla.contract_id = cl.id AND cla.attendance_date BETWEEN $1 AND $2
       WHERE ($3::int IS NULL OR cl.company_id = $3)
       GROUP BY 1, cl.id, cl.employee_name, cl.employee_code
       ORDER BY 1, cl.employee_name`, [start, end, companyId]);
    if (!rows.length) return res.status(409).json({ error: 'no_attendance', message: 'No contract labour attendance is marked for that month.' });

    const byContractor = new Map();
    for (const r of rows) {
      const k = r.contractor;
      if (!byContractor.has(k)) byContractor.set(k, { contractor: k, workers: [], present_days: 0, hours: 0 });
      const c = byContractor.get(k);
      const days = Number(r.present_days) + Number(r.half_days) * 0.5;
      c.workers.push({ contract_id: r.id, name: r.employee_name, code: r.employee_code, man_days: days,
        half_days: Number(r.half_days), absent_days: Number(r.absent_days), hours: Number(r.hours) });
      c.present_days += days; c.hours += Number(r.hours);
    }
    const statements = [];
    for (const c of byContractor.values()) {
      const { rows: [s] } = await pool.query(`
        INSERT INTO contract_labour_finance_statements
          (company_id, month, year, contractor_company, workers, present_days, hours, detail, sent_by, sent_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NOW())
        ON CONFLICT (company_id, month, year, contractor_company) DO UPDATE SET
          workers = EXCLUDED.workers, present_days = EXCLUDED.present_days, hours = EXCLUDED.hours,
          detail = EXCLUDED.detail, sent_by = EXCLUDED.sent_by, sent_at = NOW()
        RETURNING *`,
      [companyId, m, y, c.contractor, c.workers.length, c.present_days, c.hours.toFixed(2), JSON.stringify(c.workers), req.user?.userId ?? null]);
      statements.push(s);
    }

    const label = new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const message = [`Contract labour attendance for ${label}:`,
      ...statements.map((s) => `${s.contractor_company}: ${s.workers} workers · ${Number(s.present_days)} man-days · ${Number(s.hours)} h`),
      'For the contractors’ bills.'].join('\n');
    const { rows: finance } = await pool.query(`
      SELECT DISTINCT u.id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE u.is_active = TRUE AND LOWER(r.code) IN ('finance', 'finance_manager', 'accounts_exec')
         AND ($1::int IS NULL OR u.company_id = $1 OR u.company_id IS NULL)`, [companyId]).catch(() => ({ rows: [] }));
    for (const u of finance) {
      await pool.query(`
        INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
        VALUES ($1, $2, $3, 'finance', $4, 'contract_labour_statement')`,
      [u.id, `Contract labour attendance — ${label}`, message, `${y}-${pad(m)}`]).catch(() => {});
    }
    await writeAuditLog({ companyId, action: 'contract_labour_sent_to_finance',
      afterData: { month: m, year: y, contractors: statements.length, finance_notified: finance.length }, performedBy: req.user?.userId, req });
    res.json({ month: m, year: y, statements, finance_notified: finance.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/contract-labour/finance-statements?month=&year= — what was sent.
router.get('/contract-labour/finance-statements', requireAttendanceOperator, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const m = parseInt(req.query.month); const y = parseInt(req.query.year);
    const { rows } = await pool.query(`
      SELECT s.*, COALESCE(u.name, u.email) AS sent_by_name FROM contract_labour_finance_statements s
        LEFT JOIN users u ON u.id = s.sent_by
       WHERE ($1::int IS NULL OR s.company_id = $1) AND ($2::int IS NULL OR s.month = $2) AND ($3::int IS NULL OR s.year = $3)
       ORDER BY s.year DESC, s.month DESC, s.contractor_company`, [companyId, Number.isFinite(m) ? m : null, Number.isFinite(y) ? y : null]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
