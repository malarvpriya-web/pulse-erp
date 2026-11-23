import pool from '../../shared/db.js';
import { getWeekendDays, dayIsWeekend } from '../../../shared/weekend.js';

// The employee's own punctuality for the month (§278, owner 2026-11-18: an
// employee should see how many days they came on time, used the grace time,
// came late, and when they came). 'present' with late minutes = inside grace.
function punctuality(rows) {
  const worked = rows.filter(r => ['present', 'late', 'half_day'].includes(r.status) && r.check_in_time);
  const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const onTime = worked.filter(r => r.status !== 'late' && !(r.late_minutes > 0)).length;
  const inGrace = worked.filter(r => r.status !== 'late' && r.late_minutes > 0).length;
  const lateRows = worked.filter(r => r.status === 'late');
  const avgIn = worked.length ? Math.round(worked.reduce((t, r) => t + mins(r.check_in_time), 0) / worked.length) : null;
  const hrs = rows.filter(r => Number(r.total_hours) > 0);
  return {
    on_time: onTime,
    within_grace: inGrace,
    late_minutes_total: lateRows.reduce((t, r) => t + (r.late_minutes || 0), 0),
    grace_minutes_used: worked.filter(r => r.status !== 'late').reduce((t, r) => t + (r.late_minutes || 0), 0),
    early_exits: rows.filter(r => r.early_leave_minutes > 0).length,
    half_days: rows.filter(r => r.status === 'half_day').length,
    avg_check_in: avgIn == null ? null : `${String(Math.floor(avgIn / 60)).padStart(2, '0')}:${String(avgIn % 60).padStart(2, '0')}`,
    avg_hours: hrs.length ? Number((hrs.reduce((t, r) => t + Number(r.total_hours), 0) / hrs.length).toFixed(1)) : null,
  };
}

const attendanceRepository = {
  async markAttendance(data) {
    const {
      employee_id, attendance_date, check_in_time, check_out_time,
      status, late_minutes, early_leave_minutes, remarks, company_id,
    } = data;

    const total_hours = check_in_time && check_out_time
      ? await this.calculateHours(check_in_time, check_out_time)
      : null;

    const result = await pool.query(
      `INSERT INTO attendance_records
         (employee_id, attendance_date, check_in_time, check_out_time, total_hours,
          status, late_minutes, early_leave_minutes, remarks, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (employee_id, attendance_date)
       DO UPDATE SET
         check_in_time       = COALESCE($3, attendance_records.check_in_time),
         check_out_time      = COALESCE($4, attendance_records.check_out_time),
         total_hours         = COALESCE($5, attendance_records.total_hours),
         status              = COALESCE($6, attendance_records.status),
         late_minutes        = COALESCE($7, attendance_records.late_minutes),
         early_leave_minutes = COALESCE($8, attendance_records.early_leave_minutes),
         remarks             = COALESCE($9, attendance_records.remarks),
         company_id          = COALESCE(attendance_records.company_id, $10),
         updated_at          = CURRENT_TIMESTAMP
       RETURNING *`,
      [employee_id, attendance_date, check_in_time, check_out_time, total_hours,
       status, late_minutes, early_leave_minutes, remarks, company_id ?? null]
    );
    return result.rows[0];
  },

  async calculateHours(check_in, check_out) {
    const result = await pool.query(
      `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 as hours`,
      [check_out, check_in]
    );
    return Math.abs(parseFloat(result.rows[0].hours).toFixed(2));
  },

  async findByEmployee(employee_id, filters = {}) {
    let query = `
      SELECT ar.*, e.name as employee_name
        FROM attendance_records ar
        JOIN employees e ON ar.employee_id = e.id
       WHERE ar.employee_id = $1 AND ar.deleted_at IS NULL
    `;
    const params = [employee_id];
    let paramCount = 2;

    if (filters.company_id != null) {
      query += ` AND e.company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

    if (filters.start_date && filters.end_date) {
      query += ` AND ar.attendance_date BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    if (filters.status) {
      query += ` AND ar.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ` ORDER BY ar.attendance_date DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findByDate(attendance_date, filters = {}) {
    // Employee-first LEFT JOIN so all active employees appear even with no record.
    // Weekend detection: DOW 0 (Sun) or 6 (Sat) with no record → 'Weekend', not 'Absent'.
    let query = `
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS employee_name,
        e.department,
        ar.check_in_time,
        ar.check_out_time,
        ar.total_hours,
        ar.late_minutes,
        ar.work_mode,
        CASE
          WHEN EXTRACT(DOW FROM $1::date) IN (0, 6) AND ar.id IS NULL THEN 'Weekend'
          WHEN ar.id IS NULL AND EXISTS (
            SELECT 1 FROM leave_applications la
            WHERE la.employee_id = e.id AND la.status = 'approved'
              AND $1::date BETWEEN la.start_date AND la.end_date
          ) THEN 'On Leave'
          WHEN ar.id IS NULL AND $1::date > CURRENT_DATE THEN 'Future'
          WHEN ar.id IS NULL AND $1::date = CURRENT_DATE THEN 'Pending'
          WHEN ar.id IS NULL THEN 'Absent'
          ELSE ar.status
        END AS status
      FROM employees e
      LEFT JOIN attendance_records ar
        ON ar.employee_id = e.id
        AND ar.attendance_date = $1
        AND ar.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active', 'probation', 'notice')
    `;
    const params = [attendance_date];
    let paramCount = 2;

    if (filters.company_id != null) {
      query += ` AND e.company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

    if (filters.department) {
      query += ` AND e.department = $${paramCount}`;
      params.push(filters.department);
      paramCount++;
    }

    // §278.2: team / self limit from attendance.authz.js attendanceViewClause()
    // (an inlined integer id). The route always sets this key AFTER spreading
    // req.query, so a caller cannot supply it.
    if (typeof filters.__viewClause === 'string') query += filters.__viewClause;

    query += ` ORDER BY e.name`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getEmployeeSummary(employee_id, month, year, companyId = null) {
    const result = await pool.query(`
      SELECT
        COUNT(*)                                          AS total_days,
        COUNT(*) FILTER (WHERE status = 'present')       AS present_days,
        COUNT(*) FILTER (WHERE status = 'absent')        AS absent_days,
        COUNT(*) FILTER (WHERE status = 'half_day')      AS half_days,
        COUNT(*) FILTER (WHERE status = 'wfh')           AS wfh_days,
        COUNT(*) FILTER (WHERE late_minutes > 0)         AS late_arrivals,
        SUM(late_minutes)                                AS total_late_minutes,
        SUM(total_hours)                                 AS total_hours_worked
      FROM attendance_records
      WHERE employee_id = $1
        AND EXTRACT(MONTH FROM attendance_date) = $2
        AND EXTRACT(YEAR  FROM attendance_date) = $3
        AND deleted_at IS NULL
        AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM employees e WHERE e.id = $1 AND e.company_id = $4))
    `, [employee_id, month, year, companyId]);
    return result.rows[0];
  },

  async getTeamSummary(manager_id, date, companyId = null) {
    const statusExpr = `
      CASE
        WHEN EXTRACT(DOW FROM $2::date) IN (0, 6) AND ar.id IS NULL THEN 'Weekend'
        WHEN ar.id IS NULL AND EXISTS (
          SELECT 1 FROM leave_applications la
          WHERE la.employee_id = e.id AND la.status = 'approved'
            AND $2::date BETWEEN la.start_date AND la.end_date
        ) THEN 'On Leave'
        WHEN ar.id IS NULL AND $2::date > CURRENT_DATE THEN 'Future'
        WHEN ar.id IS NULL AND $2::date = CURRENT_DATE THEN 'Pending'
        WHEN ar.id IS NULL THEN 'Absent'
        ELSE ar.status
      END AS status
    `;
    const cols = `
      e.id,
      COALESCE(e.name, CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS name,
      e.department,
      ${statusExpr},
      ar.check_in_time,
      ar.check_out_time,
      ar.total_hours,
      ar.late_minutes,
      ar.work_mode
    `;
    const scopeClause = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';

    try {
      const result = await pool.query(`
        SELECT ${cols}
          FROM employees e
          LEFT JOIN attendance_records ar
            ON e.id = ar.employee_id AND ar.attendance_date = $2 AND ar.deleted_at IS NULL
         WHERE e.id <> $1::int
           AND (
             -- direct reports
             EXISTS (SELECT 1 FROM org_relationships org WHERE org.employee_id = e.id AND org.manager_id = $1)
             OR e.reporting_manager_id = $1
             -- everyone in a department this person heads (§278: the page is
             -- the department head's view of their department)
             OR EXISTS (SELECT 1 FROM department_heads dh JOIN master_departments md ON md.id = dh.department_id
                         WHERE dh.head_employee_id = $1 AND dh.ended_at IS NULL
                           AND LOWER(TRIM(md.name)) = LOWER(TRIM(e.department)))
           )
           AND e.deleted_at IS NULL
           AND LOWER(e.status) IN ('active', 'probation', 'notice')
           ${scopeClause}
         ORDER BY e.name
      `, [manager_id, date]);
      return result.rows;
    } catch {
      const result = await pool.query(`
        SELECT ${cols}
          FROM employees e
          JOIN employees mgr ON mgr.id = $1
          LEFT JOIN attendance_records ar
            ON e.id = ar.employee_id AND ar.attendance_date = $2 AND ar.deleted_at IS NULL
         WHERE e.deleted_at IS NULL
           AND LOWER(e.status) IN ('active', 'probation', 'notice')
           ${scopeClause}
           AND LOWER(TRIM(COALESCE(e.reporting_manager, '')))
               = LOWER(TRIM(CONCAT(mgr.first_name, ' ', COALESCE(mgr.last_name, ''))))
         ORDER BY e.name
      `, [manager_id, date]);
      return result.rows;
    }
  },

  async bulkMarkAttendance(attendance_date, status, employee_ids = null, companyId = null) {
    let query, params;
    const scopeClause = companyId != null ? `AND company_id = ${parseInt(companyId)}` : '';

    if (employee_ids && employee_ids.length > 0) {
      query = `
        INSERT INTO attendance_records (employee_id, attendance_date, status, company_id)
        SELECT id, $1, $2, company_id FROM employees
         WHERE LOWER(status) IN ('active', 'probation', 'notice')
           AND deleted_at IS NULL
           AND id = ANY($3)
           ${scopeClause}
        ON CONFLICT (employee_id, attendance_date)
        DO UPDATE SET status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;
      params = [attendance_date, status, employee_ids];
    } else {
      query = `
        INSERT INTO attendance_records (employee_id, attendance_date, status, company_id)
        SELECT id, $1, $2, company_id FROM employees
         WHERE LOWER(status) IN ('active', 'probation', 'notice')
           AND deleted_at IS NULL
           ${scopeClause}
        ON CONFLICT (employee_id, attendance_date)
        DO UPDATE SET status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;
      params = [attendance_date, status];
    }
    const result = await pool.query(query, params);
    return { marked: result.rows.length };
  },

  async getLateArrivals(filters = {}) {
    const params = [];
    let p = 1;
    const conditions = [`ar.status = 'late'`, `ar.deleted_at IS NULL`];

    if (filters.company_id != null) {
      conditions.push(`e.company_id = $${p++}`);
      params.push(filters.company_id);
    }
    if (filters.start_date && filters.end_date) {
      conditions.push(`ar.attendance_date BETWEEN $${p} AND $${p + 1}`);
      params.push(filters.start_date, filters.end_date);
      p += 2;
    }
    if (filters.department) {
      conditions.push(`e.department = $${p++}`);
      params.push(filters.department);
    }
    // §278.2: team / self limit (see findByDate). Set by the route after req.query.
    if (typeof filters.__viewClause === 'string' && filters.__viewClause) {
      conditions.push(filters.__viewClause.replace(/^\s*AND\s+/, ''));
    }

    const whereClause = conditions.join(' AND ');

    // CTE applies all filters first, then window function computes monthly occurrence rank
    const result = await pool.query(`
      WITH late_in_range AS (
        SELECT
          ar.id,
          ar.employee_id,
          ar.attendance_date,
          ar.check_in_time,
          ar.status,
          ar.late_minutes,
          ar.work_mode,
          ar.company_id,
          COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS employee_name,
          e.department,
          COALESCE(s.start_time::text, '09:00:00') AS scheduled_time
        FROM attendance_records ar
        JOIN employees e ON ar.employee_id = e.id
        LEFT JOIN LATERAL (
          SELECT sa.shift_id
            FROM hr_shift_assignments sa
           WHERE sa.employee_id = ar.employee_id
             AND sa.is_active = true
           ORDER BY sa.effective_from DESC
           LIMIT 1
        ) latest_sa ON true
        LEFT JOIN hr_shifts s ON s.id = latest_sa.shift_id
        WHERE ${whereClause}
      )
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY employee_id ORDER BY attendance_date) AS occurrence_rank
      FROM late_in_range
      ORDER BY attendance_date DESC, late_minutes DESC
    `, params);

    return result.rows;
  },

  async getMonthlyTrend(employee_id, year, companyId = null) {
    const result = await pool.query(`
      SELECT
        EXTRACT(MONTH FROM attendance_date) AS month,
        COUNT(*) FILTER (WHERE status = 'present') AS present,
        COUNT(*) FILTER (WHERE status = 'absent')  AS absent,
        COUNT(*) FILTER (WHERE status = 'wfh')     AS wfh
      FROM attendance_records
      WHERE employee_id = $1
        AND EXTRACT(YEAR FROM attendance_date) = $2
        AND deleted_at IS NULL
        AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM employees e WHERE e.id = $1 AND e.company_id = $3))
      GROUP BY EXTRACT(MONTH FROM attendance_date)
      ORDER BY month
    `, [employee_id, year, companyId]);
    return result.rows;
  },

  async getEmployeeMonthlyData(employee_id, month, year, companyId = null) {
    const m = String(month).padStart(2, '0');
    const startDate = `${year}-${m}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;

    const recordsResult = await pool.query(`
      SELECT
        attendance_date AS date,
        status,
        check_in_time,
        check_out_time,
        total_hours,
        late_minutes,
        early_leave_minutes,
        work_mode,
        source
      FROM attendance_records
      WHERE employee_id = $1
        AND attendance_date BETWEEN $2 AND $3
        AND deleted_at IS NULL
        AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM employees e WHERE e.id = $1 AND e.company_id = $4))
      ORDER BY attendance_date
    `, [employee_id, startDate, endDate, companyId]);

    const rows = recordsResult.rows;
    const toYMD = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

    const recordMap = {};
    rows.forEach((r) => { recordMap[toYMD(r.date)] = r.status; });

    const present  = rows.filter(r => r.status === 'present').length;
    const absent   = rows.filter(r => r.status === 'absent').length;
    const late     = rows.filter(r => r.status === 'late').length;
    const leave    = rows.filter(r => ['on_leave', 'leave'].includes(r.status)).length;
    const holidays = rows.filter(r => r.status === 'holiday').length;

    // Attendance % = days attended / working days SO FAR (§278). It divided
    // by every Mon–Fri of the whole month — future days included — and left
    // late days out, so a perfect month to date read 62%. The work week is the
    // company's (shared/weekend.js) and declared holidays are not working days.
    const weekend = await getWeekendDays(companyId);
    const now0 = new Date();
    const isCurrent = now0.getFullYear() === year && now0.getMonth() + 1 === month;
    const upTo = isCurrent ? now0.getDate() : lastDay;
    const holidayDays = new Set(rows.filter(r => r.status === 'holiday').map(r => toYMD(r.date)));
    let workingDays = 0;
    for (let d = 1; d <= upTo; d++) {
      const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!dayIsWeekend(key, weekend) && !holidayDays.has(key)) workingDays++;
    }
    const halfDays = rows.filter(r => r.status === 'half_day').length;
    const attended = present + late + halfDays * 0.5;
    const percentage = workingDays > 0 ? Math.min(100, Math.round((attended / workingDays) * 100)) : 0;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    // Use IST offset (UTC+5:30) to get local hour for shift-end check
    const istHour = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
    const shiftEndedToday = istHour >= 19; // treat shift as ended after 19:00 IST
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0, 10);
      const dow = d.getDay();
      let status;
      if (recordMap[ymd]) {
        status = recordMap[ymd];
      } else if (dow === 0 || dow === 6) {
        status = 'weekend';
      } else if (ymd > todayStr) {
        status = 'future';
      } else if (ymd === todayStr && !shiftEndedToday) {
        status = 'pending'; // shift still in progress — not absent yet
      } else {
        status = 'absent';
      }
      last7Days.push({ date: ymd, status });
    }

    return {
      records: rows.map(r => ({
        date:        toYMD(r.date),
        status:      r.status,
        check_in:    r.check_in_time  ? String(r.check_in_time).slice(0, 5)  : null,
        check_out:   r.check_out_time ? String(r.check_out_time).slice(0, 5) : null,
        hours_worked: r.total_hours   ? Number(r.total_hours).toFixed(1)      : null,
        late_minutes: r.late_minutes  || 0,
        early_leave_minutes: r.early_leave_minutes || 0,
        work_mode:   r.work_mode      || null,
        source:      r.source         || null,
      })),
      summary:  { present, absent, late, leave, holidays, percentage, ...punctuality(rows) },
      last7Days,
    };
  },

  async getTodayStatus(employee_id, companyId = null) {
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query(`
      SELECT
        status,
        check_in_time  AS check_in,
        check_out_time AS check_out,
        total_hours    AS hours_worked
      FROM attendance_records
      WHERE employee_id = $1 AND attendance_date = $2 AND deleted_at IS NULL
        AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM employees e WHERE e.id = $1 AND e.company_id = $3))
      LIMIT 1
    `, [employee_id, today, companyId]);
    return result.rows[0] || null;
  },
};

export default attendanceRepository;
