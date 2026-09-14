/**
 * reports.repository.js — SQL for the prebuilt report catalog.
 *
 * TWO RULES THIS FILE NOW ENFORCES
 * -------------------------------
 * 1. **Errors are never swallowed.** Every query used to run through a
 *    `safeQuery` helper that caught any database error and returned `[]`. The
 *    route then answered `200 []` and the page rendered "No records found for
 *    the selected filters" next to a green tick. Eleven of the twenty-one
 *    reports referenced columns that do not exist in this schema
 *    (`employees.employee_code`, `inventory_items.category`, `projects.name`,
 *    `payroll_runs.company_id`, `sales_targets.employee_id`, and a
 *    `parties.id uuid = purchase_orders.supplier_id integer` join), so they had
 *    never once returned a row — and every user who opened them was told, with
 *    a tick, that the business had no stock, no projects and no purchase orders.
 *    A broken report must fail loudly. `npm run check:schema` now covers this
 *    file so a reference that resolves to nothing fails CI instead of shipping.
 *
 * 2. **Tenant scope is a required argument, not an optional filter.** The old
 *    predicates were built as `if (company_id != null) query += ' AND ...'`, so
 *    a caller whose scope resolved to null — which is 7 of 37 active accounts,
 *    the ones with no `user_scope` row — silently queried every tenant. Scope is
 *    now always bound as `$1` with the `($1::int IS NULL OR col = $1)` form, and
 *    the route is responsible for guaranteeing that null reaches here only for a
 *    genuinely global super-admin scope.
 *
 * Status vocabularies come from `shared/statusSets.js`; month buckets are
 * emitted as `to_char(...)` strings rather than timestamps, because
 * `DATE_TRUNC('month', <date>)` returns `timestamptz` and the driver's DATE
 * parser does not cover it — July invoices were serialising to
 * "2026-06-30T18:30:00.000Z" and displaying as June.
 */
import pool from '../../shared/db.js';
import {
  sqlEmployeeActive, sqlEmployeeExited, sqlInvoiceOutstanding,
  sqlSalesOrderBooked, sqlPoOpen, sqlPoFulfilled, sqlPrOpen,
  sqlAttendancePresent, sqlAttendanceAbsent, sqlAttendanceLeave, sqlAttendanceOff,
  LEAVE_APPROVED, LEAVE_PENDING, isIn,
} from '../../../shared/statusSets.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../reportCatalog.js';

/**
 * Run a report body with pagination and an exact total.
 *
 * `count(*) OVER ()` gives the unpaginated row count in the same round trip, so
 * the UI can say "showing 500 of 12,043" instead of implying the page is the
 * whole answer. The `_total` column is stripped before the rows are returned.
 */
async function paginate(sql, params, { limit, offset }) {
  const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const off = Math.max(Number(offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT *, count(*) OVER () AS _total FROM (${sql}) q LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, lim, off]
  );
  const total = rows.length ? Number(rows[0]._total) : 0;
  for (const r of rows) delete r._total;
  return { rows, total, limit: lim, offset: off };
}

/** Display name for an employee row aliased `e`. */
const EMP_NAME = `COALESCE(NULLIF(TRIM(e.name), ''), NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''), 'Unnamed')`;

const reportsRepository = {
  /* ─── Saved reports ──────────────────────────────────────────────────────
     Column names below are the ones that exist: the live table is
     (name, report_type, filters, columns, created_by, is_shared, last_run,
     deleted_at, created_at, company_id). The previous code wrote report_name /
     module_name / filters_json / columns_json / is_public — six columns that
     have never existed — so every INSERT raised 42703, was swallowed, and the
     route answered 201 with a null body while the page rendered "✓ Saved".
     `saved_reports` held zero rows.

     `created_by` is a users.id. The column's FK pointed at employees(id), which
     is a different id space, so ownership matched the wrong person or nobody;
     the accompanying migration repoints it at users(id). */

  async createSavedReport({ name, report_type, filters, columns, created_by, is_shared, company_id }) {
    const { rows } = await pool.query(
      `INSERT INTO saved_reports (name, report_type, filters, columns, created_by, is_shared, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, report_type, filters, columns, created_by, is_shared, last_run, created_at, company_id`,
      [name, report_type, JSON.stringify(filters || {}), JSON.stringify(columns || []),
       created_by, is_shared ?? false, company_id]
    );
    return rows[0];
  },

  async findSavedReports(user_id, company_id) {
    const { rows } = await pool.query(
      `SELECT sr.id, sr.name, sr.report_type, sr.filters, sr.columns, sr.created_by,
              sr.is_shared, sr.last_run, sr.created_at, sr.company_id,
              COALESCE(u.name, u.email) AS created_by_name,
              (sr.created_by = $1) AS is_owner
         FROM saved_reports sr
         LEFT JOIN users u ON u.id = sr.created_by
        WHERE sr.deleted_at IS NULL
          AND ($2::int IS NULL OR sr.company_id = $2)
          AND (sr.created_by = $1 OR sr.is_shared = true)
        ORDER BY sr.created_at DESC`,
      [user_id, company_id]
    );
    return rows;
  },

  /** Scoped to owner and tenant: a saved report id alone must not be enough to delete one. */
  async deleteSavedReport(id, user_id, company_id) {
    const { rowCount } = await pool.query(
      `UPDATE saved_reports
          SET deleted_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
          AND created_by = $2
          AND ($3::int IS NULL OR company_id = $3)`,
      [id, user_id, company_id]
    );
    return rowCount > 0;
  },

  async touchSavedReport(id, user_id, company_id) {
    await pool.query(
      `UPDATE saved_reports SET last_run = NOW()
        WHERE id = $1 AND created_by = $2 AND ($3::int IS NULL OR company_id = $3)`,
      [id, user_id, company_id]
    );
  },

  /* ─── HR & People ────────────────────────────────────────────────────────── */

  /**
   * Attendance summary.
   *
   * Reads `attendance_records`. The previous version read the bare `attendance`
   * table, which has **no writers at all** — all nine live writers (the cron,
   * repository, routes, offline sync, biometric, holidays and leaves modules,
   * and the approvals controller) target `attendance_records`. It was showing
   * frozen seed data that no clock-in could ever change.
   *
   * The date predicate sits in the ON clause, not the WHERE. As a WHERE clause
   * it turned the LEFT JOIN into an inner join and dropped every employee with
   * no attendance in the window — 29 of 34 people vanished from the report.
   *
   * The buckets are exhaustive by construction: present + absent + leave +
   * non_working + unclassified always equals recorded_days, so the columns
   * reconcile to their own total. The old version counted Weekend and Late in
   * `total_days` and nowhere else, losing 11 days per employee, and reported a
   * `leave_days` of 0 that could never be anything else because the table has
   * no 'leave' status — leave lives in `leave_applications`. `unclassified_days`
   * exists so a status nobody anticipated shows up as unclassified rather than
   * silently unbalancing the row.
   */
  async getAttendanceReport({ start_date, end_date, department, company_id, limit, offset }) {
    const sql = `
      SELECT
        e.id                                   AS employee_id,
        e.office_id                            AS employee_code,
        ${EMP_NAME}                            AS employee_name,
        e.department, e.designation,
        COUNT(ar.id)::int                      AS recorded_days,
        COUNT(ar.id) FILTER (WHERE ${sqlAttendancePresent('ar.status')})::int AS present_days,
        COUNT(ar.id) FILTER (WHERE ${sqlAttendanceAbsent('ar.status')})::int  AS absent_days,
        COUNT(ar.id) FILTER (WHERE ${sqlAttendanceLeave('ar.status')})::int   AS leave_days,
        COUNT(ar.id) FILTER (WHERE ${sqlAttendanceOff('ar.status')})::int     AS non_working_days,
        COUNT(ar.id) FILTER (WHERE ar.status IS NOT NULL
          AND NOT (${sqlAttendancePresent('ar.status')})
          AND NOT (${sqlAttendanceAbsent('ar.status')})
          AND NOT (${sqlAttendanceLeave('ar.status')})
          AND NOT (${sqlAttendanceOff('ar.status')}))::int                    AS unclassified_days,
        ROUND(COALESCE(SUM(ar.total_hours), 0), 2)                            AS total_hours
      FROM employees e
      LEFT JOIN attendance_records ar
        ON ar.employee_id = e.id
       AND ar.deleted_at IS NULL
       AND ($2::date IS NULL OR ar.attendance_date >= $2)
       AND ($3::date IS NULL OR ar.attendance_date <= $3)
      WHERE e.deleted_at IS NULL
        AND ${sqlEmployeeActive('e.status')}
        AND ($1::int IS NULL OR e.company_id = $1)
        AND ($4::text IS NULL OR e.department = $4)
      GROUP BY e.id, e.office_id, e.name, e.first_name, e.last_name, e.department, e.designation
      ORDER BY employee_name`;
    return paginate(sql, [company_id, start_date || null, end_date || null, department || null], { limit, offset });
  },

  async getLeaveReport({ start_date, end_date, status, department, employee_id, company_id, limit, offset }) {
    const sql = `
      SELECT
        la.id, la.employee_id,
        e.office_id                AS employee_code,
        ${EMP_NAME}                AS employee_name,
        e.department, e.designation,
        lt.leave_name, lt.leave_code,
        la.start_date, la.end_date, la.number_of_days,
        la.reason, la.status, la.manager_status, la.l2_status, la.hr_status,
        la.manager_comments, la.hr_comments, la.applied_at
      FROM leave_applications la
      JOIN employees   e  ON e.id  = la.employee_id
      JOIN leave_types lt ON lt.id = la.leave_type_id
      WHERE la.deleted_at IS NULL
        AND ($1::int  IS NULL OR e.company_id = $1)
        AND ($2::date IS NULL OR la.start_date >= $2)
        AND ($3::date IS NULL OR la.end_date   <= $3)
        AND ($4::text IS NULL OR e.department  = $4)
        AND ($5::int  IS NULL OR la.employee_id = $5)
        AND ($6::text IS NULL OR LOWER(la.status) = LOWER($6))
      ORDER BY la.applied_at DESC NULLS LAST, la.id DESC`;
    return paginate(sql,
      [company_id, start_date || null, end_date || null, department || null,
       employee_id ? Number(employee_id) : null, status || null], { limit, offset });
  },

  async getLeaveSummaryReport({ year, department, company_id, limit, offset }) {
    const resolvedYear = Number(year) || new Date().getFullYear();
    // Only pairs the employee actually holds a balance for, or has applied
    // against. The previous CROSS JOIN emitted every employee × every leave type
    // — 612 rows here, ~10,000 at 500 employees — most of them 0 allocated and
    // 0 used, which is noise the reader has to filter by eye.
    const sql = `
      SELECT
        e.id            AS employee_id,
        e.office_id     AS employee_code,
        ${EMP_NAME}     AS employee_name,
        e.department, e.designation,
        lt.leave_name,
        COALESCE(lb.allocated_days, 0)                                              AS allocated_days,
        COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0) AS used_days,
        COALESCE(lb.allocated_days, 0)
          - COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0) AS remaining_days,
        COUNT(la.id) FILTER (WHERE ${isIn('la.status', LEAVE_PENDING)})::int        AS pending_count,
        COUNT(la.id) FILTER (WHERE LOWER(la.status) = 'rejected')::int              AS rejected_count
      FROM employees e
      JOIN leave_types lt
        ON lt.is_active = true AND lt.deleted_at IS NULL
      LEFT JOIN leave_balances lb
        ON lb.employee_id = e.id AND lb.leave_type_id = lt.id AND lb.year = $2
      LEFT JOIN leave_applications la
        ON la.employee_id = e.id AND la.leave_type_id = lt.id
       AND la.deleted_at IS NULL
       AND EXTRACT(YEAR FROM la.start_date) = $2
      WHERE e.deleted_at IS NULL
        AND ${sqlEmployeeActive('e.status')}
        AND ($1::int  IS NULL OR e.company_id = $1)
        AND ($3::text IS NULL OR e.department = $3)
        AND (lb.id IS NOT NULL OR la.id IS NOT NULL)
      GROUP BY e.id, e.office_id, e.name, e.first_name, e.last_name, e.department,
               e.designation, lt.leave_name, lb.allocated_days
      ORDER BY employee_name, lt.leave_name`;
    return paginate(sql, [company_id, resolvedYear, department || null], { limit, offset });
  },

  async getLeaveLiabilityReport({ year, company_id, limit, offset }) {
    const resolvedYear = Number(year) || new Date().getFullYear();
    const sql = `
      SELECT
        e.id        AS employee_id,
        e.office_id AS employee_code,
        ${EMP_NAME} AS employee_name,
        e.department, e.designation,
        lt.leave_name,
        COALESCE(lb.allocated_days, 0) AS allocated_days,
        COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0) AS used_days,
        GREATEST(COALESCE(lb.allocated_days, 0)
          - COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0), 0) AS balance_days,
        ROUND(COALESCE(e.basic_salary, 0) / 26.0, 2) AS daily_rate,
        ROUND(GREATEST(COALESCE(lb.allocated_days, 0)
          - COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0), 0)
          * (COALESCE(e.basic_salary, 0) / 26.0), 2) AS liability_amount
      FROM employees e
      JOIN leave_types lt ON lt.is_active = true AND lt.deleted_at IS NULL
      LEFT JOIN leave_balances lb
        ON lb.employee_id = e.id AND lb.leave_type_id = lt.id AND lb.year = $2
      LEFT JOIN leave_applications la
        ON la.employee_id = e.id AND la.leave_type_id = lt.id
       AND la.deleted_at IS NULL
       AND EXTRACT(YEAR FROM la.start_date) = $2
      WHERE e.deleted_at IS NULL
        AND ${sqlEmployeeActive('e.status')}
        AND ($1::int IS NULL OR e.company_id = $1)
        AND lb.id IS NOT NULL
      GROUP BY e.id, e.office_id, e.name, e.first_name, e.last_name, e.department,
               e.designation, e.basic_salary, lt.leave_name, lb.allocated_days
      HAVING GREATEST(COALESCE(lb.allocated_days, 0)
        - COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0), 0) > 0
      ORDER BY liability_amount DESC`;
    return paginate(sql, [company_id, resolvedYear], { limit, offset });
  },

  async getLOPReport({ month, year, company_id, limit, offset }) {
    const sql = `
      SELECT
        e.office_id AS employee_code,
        ${EMP_NAME} AS employee_name,
        e.department, e.designation,
        pas.month, pas.year, pas.working_days, pas.present_days, pas.absent_days, pas.lop_days,
        ROUND((COALESCE(e.basic_salary, 0) / NULLIF(pas.working_days, 0)) * pas.lop_days, 2) AS lop_amount
      FROM payroll_attendance_summary pas
      JOIN employees e ON e.id = pas.employee_id
      WHERE pas.lop_days > 0
        AND e.deleted_at IS NULL
        AND ($1::int IS NULL OR e.company_id = $1)
        AND ($2::int IS NULL OR pas.year  = $2)
        AND ($3::int IS NULL OR pas.month = $3)
      ORDER BY pas.year DESC, pas.month DESC, lop_amount DESC`;
    return paginate(sql,
      [company_id, year ? Number(year) : null, month ? Number(month) : null], { limit, offset });
  },

  async getDepartmentLeaveReport({ year, month, company_id, limit, offset }) {
    const resolvedYear = Number(year) || new Date().getFullYear();
    const sql = `
      SELECT
        COALESCE(e.department, 'Unassigned') AS department,
        COUNT(DISTINCT e.id)::int            AS total_employees,
        COUNT(la.id)::int                    AS total_applications,
        COUNT(la.id) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)})::int  AS approved,
        COUNT(la.id) FILTER (WHERE LOWER(la.status) = 'rejected')::int         AS rejected,
        COUNT(la.id) FILTER (WHERE ${isIn('la.status', LEAVE_PENDING)})::int   AS pending,
        COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0) AS total_days_taken,
        ROUND(COALESCE(SUM(la.number_of_days) FILTER (WHERE ${isIn('la.status', LEAVE_APPROVED)}), 0)
              / NULLIF(COUNT(DISTINCT e.id), 0), 2) AS avg_days_per_employee
      FROM employees e
      LEFT JOIN leave_applications la
        ON la.employee_id = e.id
       AND la.deleted_at IS NULL
       AND EXTRACT(YEAR FROM la.start_date) = $2
       AND ($3::int IS NULL OR EXTRACT(MONTH FROM la.start_date) = $3)
      WHERE e.deleted_at IS NULL
        AND ${sqlEmployeeActive('e.status')}
        AND ($1::int IS NULL OR e.company_id = $1)
      GROUP BY COALESCE(e.department, 'Unassigned')
      ORDER BY total_days_taken DESC, department`;
    return paginate(sql, [company_id, resolvedYear, month ? Number(month) : null], { limit, offset });
  },

  async getApprovalPerformanceReport({ start_date, end_date, company_id, limit, offset }) {
    const sql = `
      SELECT
        COALESCE(NULLIF(TRIM(m.name), ''), NULLIF(TRIM(CONCAT_WS(' ', m.first_name, m.last_name)), ''), 'Unknown') AS approver_name,
        m.department,
        lah.approval_level,
        COUNT(*)::int                                                  AS total_actions,
        COUNT(*) FILTER (WHERE LOWER(lah.action) = 'approved')::int    AS approved_count,
        COUNT(*) FILTER (WHERE LOWER(lah.action) = 'rejected')::int    AS rejected_count,
        ROUND(AVG(EXTRACT(EPOCH FROM (lah.created_at - la.applied_at)) / 3600.0)::numeric, 1) AS avg_response_hours
      FROM leave_approval_history lah
      JOIN leave_applications la ON la.id = lah.leave_application_id
      JOIN employees e  ON e.id = la.employee_id
      JOIN employees m  ON m.id = lah.approver_id
      WHERE la.deleted_at IS NULL
        AND ($1::int  IS NULL OR e.company_id = $1)
        AND ($2::date IS NULL OR lah.created_at >= $2::date)
        AND ($3::date IS NULL OR lah.created_at <  ($3::date + INTERVAL '1 day'))
      GROUP BY m.id, m.name, m.first_name, m.last_name, m.department, lah.approval_level
      ORDER BY avg_response_hours DESC NULLS LAST`;
    return paginate(sql, [company_id, start_date || null, end_date || null], { limit, offset });
  },

  /**
   * Headcount.
   *
   * Splits active from exited instead of counting every row that was never
   * soft-deleted. The old `COUNT(*)` returned 34 against 30 active people and
   * would have carried a terminated employee in the headcount forever.
   * `department` is normalised so 'HR' and 'Human Resources' stop being two
   * separate buckets, and NULL becomes an explicit 'Unassigned' rather than a
   * blank grouping row.
   */
  async getHeadcountReport({ department, company_id, limit, offset }) {
    const sql = `
      SELECT
        CASE
          WHEN e.department IS NULL OR TRIM(e.department) = '' THEN 'Unassigned'
          WHEN LOWER(TRIM(e.department)) IN ('hr', 'human resources') THEN 'Human Resources'
          ELSE TRIM(e.department)
        END                                                              AS department,
        COUNT(*) FILTER (WHERE ${sqlEmployeeActive('e.status')})::int     AS active_employees,
        COUNT(*) FILTER (WHERE ${sqlEmployeeExited('e.status')})::int     AS exited_employees,
        COUNT(*)::int                                                     AS total_records,
        COUNT(*) FILTER (WHERE ${sqlEmployeeActive('e.status')}
                           AND e.joining_date >= CURRENT_DATE - INTERVAL '12 months')::int AS joined_last_12m,
        MIN(e.joining_date) FILTER (WHERE ${sqlEmployeeActive('e.status')}) AS earliest_joining,
        MAX(e.joining_date) FILTER (WHERE ${sqlEmployeeActive('e.status')}) AS latest_joining
      FROM employees e
      WHERE e.deleted_at IS NULL
        AND ($1::int  IS NULL OR e.company_id = $1)
        AND ($2::text IS NULL OR e.department = $2)
      GROUP BY 1
      ORDER BY active_employees DESC, department`;
    return paginate(sql, [company_id, department || null], { limit, offset });
  },

  /* ─── Payroll ────────────────────────────────────────────────────────────── */

  /** `payroll_runs` has no company_id column — scope comes from the employee. */
  async getPayrollSummaryReport({ start_date, end_date, department, company_id, limit, offset }) {
    const sql = `
      SELECT
        pr.year, pr.month,
        to_char(MAKE_DATE(pr.year, pr.month, 1), 'YYYY-MM') AS period,
        COALESCE(e.department, 'Unassigned')                AS department,
        COUNT(*)::int                                       AS employee_count,
        COALESCE(SUM(pr.gross), 0)                          AS total_gross,
        COALESCE(SUM(pr.net_pay), 0)                        AS total_net,
        COALESCE(SUM(pr.tds), 0)                            AS total_tds,
        COALESCE(SUM(pr.total_deductions), 0)               AS total_deductions
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE e.deleted_at IS NULL
        AND ($1::int  IS NULL OR e.company_id = $1)
        AND ($2::date IS NULL OR MAKE_DATE(pr.year, pr.month, 1) >= DATE_TRUNC('month', $2::date))
        AND ($3::date IS NULL OR MAKE_DATE(pr.year, pr.month, 1) <= $3::date)
        AND ($4::text IS NULL OR e.department = $4)
      GROUP BY pr.year, pr.month, COALESCE(e.department, 'Unassigned')
      ORDER BY pr.year DESC, pr.month DESC, department`;
    return paginate(sql,
      [company_id, start_date || null, end_date || null, department || null], { limit, offset });
  },

  /* ─── Sales & Revenue ────────────────────────────────────────────────────── */

  /**
   * Booked order value by month.
   *
   * The old filter was `LOWER(order_status) = 'completed'`, a value nothing in
   * the sales module ever writes — live orders are 'confirmed' — so this report
   * returned ₹0 against real revenue. The predicate now comes from
   * `statusSets.sqlSalesOrderBooked`, expressed as an exclusion of
   * draft/cancelled/rejected so an unanticipated status lands in the total
   * rather than disappearing from it.
   */
  async getSalesReport({ start_date, end_date, company_id, limit, offset }) {
    const sql = `
      SELECT
        to_char(so.order_date, 'YYYY-MM')     AS month,
        COUNT(*)::int                         AS order_count,
        COALESCE(SUM(so.total_amount), 0)     AS total_revenue,
        ROUND(COALESCE(AVG(so.total_amount), 0), 2) AS avg_order_value
      FROM sales_orders so
      WHERE so.deleted_at IS NULL
        AND ${sqlSalesOrderBooked('so.order_status')}
        AND ($1::int  IS NULL OR so.company_id = $1)
        AND ($2::date IS NULL OR so.order_date >= $2)
        AND ($3::date IS NULL OR so.order_date <= $3)
      GROUP BY to_char(so.order_date, 'YYYY-MM')
      ORDER BY month DESC`;
    return paginate(sql, [company_id, start_date || null, end_date || null], { limit, offset });
  },

  /** `sales_targets` keys on owner_id (→ employees) and period_year/period_value. */
  async getSalesTargetsReport({ year, company_id, limit, offset }) {
    const sql = `
      SELECT
        st.period_type, st.period_year, st.period_value,
        COALESCE(NULLIF(TRIM(e.name), ''), NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''), st.team_name, 'Unassigned') AS owner_name,
        e.department, st.region, st.currency,
        COALESCE(st.target_amount, 0)   AS target_amount,
        COALESCE(st.achieved_amount, 0) AS actual_amount,
        CASE WHEN COALESCE(st.target_amount, 0) > 0
             THEN ROUND(COALESCE(st.achieved_amount, 0) / st.target_amount * 100, 2)
             ELSE NULL END              AS achievement_pct
      FROM sales_targets st
      LEFT JOIN employees e ON e.id = st.owner_id
      WHERE ($1::int IS NULL OR st.company_id = $1)
        AND ($2::int IS NULL OR st.period_year = $2)
      ORDER BY st.period_year DESC, st.period_value DESC, owner_name`;
    return paginate(sql, [company_id, year ? Number(year) : null], { limit, offset });
  },

  /* ─── Finance & Accounting ───────────────────────────────────────────────── */

  /**
   * Outstanding invoices.
   *
   * The old query aliased `total_amount` as `balance` — it never netted off any
   * payment, so receivables read ₹51,86,400 against an `invoices.balance` of
   * ₹10,80,000, a 4.8x overstatement under a column header that claimed to be a
   * balance.
   *
   * Outstanding is now derived: invoiced value less what has actually been
   * received, taking receipts allocated against the invoice as the primary
   * source and the denormalised `paid_amount` as the fallback. `data_quality`
   * flags rows where the stored `balance` disagrees with the derived figure, so
   * a stale denormalisation is visible in the report instead of quietly
   * changing the total. Rows that net to zero are excluded — an invoice still
   * marked 'pending' but fully receipted is not outstanding.
   */
  async getOutstandingInvoicesReport({ start_date, end_date, company_id, limit, offset }) {
    const sql = `
      WITH receipted AS (
        SELECT ra.invoice_id, SUM(ra.allocated_amount) AS allocated
          FROM receipt_allocations ra
         GROUP BY ra.invoice_id
      )
      SELECT
        inv.invoice_number,
        COALESCE(NULLIF(TRIM(inv.party_name), ''), p.name, 'Unknown') AS customer_name,
        inv.invoice_date, inv.due_date, inv.status,
        COALESCE(inv.total_amount, 0)                                   AS total_amount,
        GREATEST(COALESCE(r.allocated, inv.paid_amount, 0), 0)          AS paid_amount,
        ROUND(COALESCE(inv.total_amount, 0)
              - GREATEST(COALESCE(r.allocated, inv.paid_amount, 0), 0), 2) AS outstanding_amount,
        CASE WHEN inv.due_date IS NOT NULL AND CURRENT_DATE > inv.due_date
             THEN (CURRENT_DATE - inv.due_date)::int ELSE 0 END         AS days_overdue,
        CASE
          WHEN inv.due_date IS NULL                       THEN 'No Due Date'
          WHEN CURRENT_DATE <= inv.due_date               THEN 'Not Due'
          WHEN CURRENT_DATE - inv.due_date <= 30          THEN '1-30 Days'
          WHEN CURRENT_DATE - inv.due_date <= 60          THEN '31-60 Days'
          WHEN CURRENT_DATE - inv.due_date <= 90          THEN '61-90 Days'
          ELSE '90+ Days'
        END                                                             AS aging_bucket,
        CASE WHEN inv.balance IS NOT NULL
              AND ABS(inv.balance - (COALESCE(inv.total_amount, 0)
                  - GREATEST(COALESCE(r.allocated, inv.paid_amount, 0), 0))) > 0.01
             THEN 'stored balance disagrees with derived'
             ELSE NULL END                                              AS data_quality
      FROM invoices inv
      LEFT JOIN receipted r ON r.invoice_id = inv.id
      LEFT JOIN parties  p  ON p.id = inv.customer_id
      WHERE inv.deleted_at IS NULL
        AND ${sqlInvoiceOutstanding('inv.status')}
        AND ($1::int  IS NULL OR inv.company_id = $1)
        AND ($2::date IS NULL OR inv.invoice_date >= $2)
        AND ($3::date IS NULL OR inv.invoice_date <= $3)
        AND COALESCE(inv.total_amount, 0) - GREATEST(COALESCE(r.allocated, inv.paid_amount, 0), 0) > 0
      ORDER BY inv.due_date ASC NULLS LAST, inv.invoice_number`;
    return paginate(sql, [company_id, start_date || null, end_date || null], { limit, offset });
  },

  /**
   * GST summary.
   *
   * `COALESCE(SUM(subtotal), SUM(total_amount))` only falls back when the whole
   * sum is NULL, and 32 of 35 invoices carry subtotal = 0 — so the report showed
   * ₹5,60,000 taxable against ₹1,16,18,500 of gross invoicing, and ₹0 GST. The
   * COALESCE now sits inside the aggregate, per row, and the tax figure falls
   * back to the cgst/sgst/igst/cess components, which are populated on invoices
   * where `tax_amount` is not.
   */
  async getGSTReport({ start_date, end_date, company_id, limit, offset }) {
    const TAX = `COALESCE(NULLIF(inv.tax_amount, 0),
                          NULLIF(COALESCE(inv.cgst,0) + COALESCE(inv.sgst,0)
                               + COALESCE(inv.igst,0) + COALESCE(inv.cess,0), 0), 0)`;
    const sql = `
      SELECT
        to_char(inv.invoice_date, 'YYYY-MM')            AS month,
        COUNT(*)::int                                   AS invoice_count,
        ROUND(SUM(COALESCE(NULLIF(inv.subtotal, 0),
                           COALESCE(inv.total_amount, 0) - ${TAX})), 2) AS taxable_value,
        ROUND(SUM(${TAX}), 2)                           AS gst_collected,
        ROUND(SUM(COALESCE(inv.total_amount, 0)), 2)    AS gross_amount
      FROM invoices inv
      WHERE inv.deleted_at IS NULL
        AND LOWER(COALESCE(inv.status, '')) <> 'cancelled'
        AND inv.invoice_date IS NOT NULL
        AND ($1::int  IS NULL OR inv.company_id = $1)
        AND ($2::date IS NULL OR inv.invoice_date >= $2)
        AND ($3::date IS NULL OR inv.invoice_date <= $3)
      GROUP BY to_char(inv.invoice_date, 'YYYY-MM')
      ORDER BY month DESC`;
    return paginate(sql, [company_id, start_date || null, end_date || null], { limit, offset });
  },

  /**
   * Expense claims.
   *
   * Scope is applied to `expense_claims.company_id`, not to the LEFT-joined
   * employee. Filtering the joined table in the WHERE clause turned the LEFT
   * JOIN into an inner join, and every live claim has `employee_id IS NULL`, so
   * all eight rows and ₹1,09,700 were dropped. The claim's own denormalised
   * `employee_name` / `department` are used when the join finds nobody.
   */
  async getExpenseReport({ start_date, end_date, department, status, company_id, limit, offset }) {
    const sql = `
      SELECT
        ec.claim_number,
        COALESCE(NULLIF(TRIM(e.name), ''), NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''),
                 NULLIF(TRIM(ec.employee_name), ''), 'Unassigned')      AS employee_name,
        COALESCE(e.department, ec.department, 'Unassigned')             AS department,
        COALESCE(ec.expense_date, ec.claim_date, ec.created_at::date)   AS claim_date,
        COALESCE(NULLIF(ec.expense_category, ''), ec.category)          AS category,
        ec.status,
        ROUND(COALESCE(ec.total_amount, ec.amount, 0), 2)               AS total_amount
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      WHERE ec.deleted_at IS NULL
        AND ($1::int  IS NULL OR ec.company_id = $1)
        AND ($2::date IS NULL OR COALESCE(ec.expense_date, ec.claim_date, ec.created_at::date) >= $2)
        AND ($3::date IS NULL OR COALESCE(ec.expense_date, ec.claim_date, ec.created_at::date) <= $3)
        AND ($4::text IS NULL OR COALESCE(e.department, ec.department) = $4)
        AND ($5::text IS NULL OR LOWER(ec.status) = LOWER($5))
      ORDER BY claim_date DESC, ec.claim_number`;
    return paginate(sql,
      [company_id, start_date || null, end_date || null, department || null, status || null], { limit, offset });
  },

  /** `projects` has project_name / budget_amount / actual_cost — not name / total_budget / budget_used. */
  async getProjectCostReport({ status, company_id, limit, offset }) {
    const sql = `
      SELECT
        p.project_code,
        p.project_name,
        COALESCE(p.customer_name, p.client_name)                    AS customer_name,
        p.status,
        p.start_date, p.end_date,
        COALESCE(p.budget_amount, p.budget, 0)                      AS budget_amount,
        COALESCE(p.actual_cost, p.budget_spent, 0)                  AS actual_cost,
        ROUND(COALESCE(p.budget_amount, p.budget, 0)
              - COALESCE(p.actual_cost, p.budget_spent, 0), 2)      AS variance,
        CASE WHEN COALESCE(p.budget_amount, p.budget, 0) > 0
             THEN ROUND(COALESCE(p.actual_cost, p.budget_spent, 0)
                        / COALESCE(p.budget_amount, p.budget) * 100, 2)
             ELSE NULL END                                          AS utilisation_pct
      FROM projects p
      WHERE p.deleted_at IS NULL
        AND ($1::int  IS NULL OR p.company_id = $1)
        AND ($2::text IS NULL OR LOWER(p.status) = LOWER($2))
      ORDER BY p.project_code`;
    return paginate(sql, [company_id, status || null], { limit, offset });
  },

  /* ─── Procurement ────────────────────────────────────────────────────────── */

  /**
   * `purchase_orders.supplier_id` is an integer FK to `vendors.id`. The previous
   * join was `LEFT JOIN parties p ON po.supplier_id = p.id`, and `parties.id` is
   * a uuid — Postgres raised 42883 "operator does not exist: integer = uuid" on
   * every call, which the old error swallow turned into an empty report.
   */
  async getPurchaseOrdersReport({ start_date, end_date, status, company_id, limit, offset }) {
    const sql = `
      SELECT
        po.po_number,
        COALESCE(NULLIF(TRIM(v.vendor_name), ''), NULLIF(TRIM(v.name), ''), 'Unknown') AS supplier_name,
        po.order_date, po.expected_delivery_date, po.status,
        po.currency,
        COALESCE(po.subtotal, 0)     AS subtotal,
        COALESCE(po.tax_amount, 0)   AS tax_amount,
        COALESCE(po.total_amount, 0) AS total_amount
      FROM purchase_orders po
      LEFT JOIN vendors v ON v.id = po.supplier_id
      WHERE po.deleted_at IS NULL
        AND ($1::int  IS NULL OR po.company_id = $1)
        AND ($2::date IS NULL OR po.order_date >= $2)
        AND ($3::date IS NULL OR po.order_date <= $3)
        AND ($4::text IS NULL OR LOWER(po.status) = LOWER($4))
      ORDER BY po.order_date DESC NULLS LAST, po.po_number`;
    return paginate(sql,
      [company_id, start_date || null, end_date || null, status || null], { limit, offset });
  },

  async getVendorPerformanceReport({ start_date, end_date, company_id, limit, offset }) {
    const sql = `
      SELECT
        COALESCE(NULLIF(TRIM(v.vendor_name), ''), NULLIF(TRIM(v.name), ''), 'Unknown') AS vendor_name,
        COUNT(po.id)::int                                              AS total_orders,
        COALESCE(SUM(po.total_amount), 0)                              AS total_spend,
        COUNT(po.id) FILTER (WHERE ${sqlPoFulfilled('po.status')})::int AS fulfilled_orders,
        COUNT(po.id) FILTER (WHERE ${sqlPoOpen('po.status')})::int      AS open_orders,
        ROUND(COUNT(po.id) FILTER (WHERE ${sqlPoFulfilled('po.status')})::numeric
              / NULLIF(COUNT(po.id), 0) * 100, 2)                      AS fulfilment_rate_pct,
        MAX(po.order_date)                                             AS last_order_date
      FROM purchase_orders po
      LEFT JOIN vendors v ON v.id = po.supplier_id
      WHERE po.deleted_at IS NULL
        AND ($1::int  IS NULL OR po.company_id = $1)
        AND ($2::date IS NULL OR po.order_date >= $2)
        AND ($3::date IS NULL OR po.order_date <= $3)
      GROUP BY COALESCE(NULLIF(TRIM(v.vendor_name), ''), NULLIF(TRIM(v.name), ''), 'Unknown')
      ORDER BY total_spend DESC NULLS LAST`;
    return paginate(sql, [company_id, start_date || null, end_date || null], { limit, offset });
  },

  /**
   * Pending approvals across both procurement documents.
   *
   * A UNION, not two queries stitched together in JavaScript. The old shape ran
   * them separately so that "UNION can fail if one subquery references a missing
   * column" — and it did: the purchase-order half raised the uuid/integer join
   * error on every call, was swallowed, and the report returned only purchase
   * requests while presenting itself as the complete pending list.
   */
  async getPendingPOsReport({ start_date, end_date, company_id, limit, offset }) {
    const sql = `
      SELECT 'Purchase Order' AS document_type,
             po.po_number     AS reference_number,
             COALESCE(NULLIF(TRIM(v.vendor_name), ''), NULLIF(TRIM(v.name), ''), 'Unknown') AS party_name,
             po.order_date    AS document_date,
             po.status,
             COALESCE(po.total_amount, 0) AS total_amount
        FROM purchase_orders po
        LEFT JOIN vendors v ON v.id = po.supplier_id
       WHERE po.deleted_at IS NULL
         AND ${sqlPoOpen('po.status')}
         AND ($1::int  IS NULL OR po.company_id = $1)
         AND ($2::date IS NULL OR po.order_date >= $2)
         AND ($3::date IS NULL OR po.order_date <= $3)
      UNION ALL
      SELECT 'Purchase Request',
             COALESCE(pr.request_number, pr.pr_number, pr.id::text),
             NULL,
             COALESCE(pr.request_date, pr.created_at::date),
             pr.status,
             COALESCE(pr.total_amount, 0)
        FROM purchase_requests pr
       WHERE pr.deleted_at IS NULL
         AND ${sqlPrOpen('pr.status')}
         AND ($1::int  IS NULL OR pr.company_id = $1)
         AND ($2::date IS NULL OR COALESCE(pr.request_date, pr.created_at::date) >= $2)
         AND ($3::date IS NULL OR COALESCE(pr.request_date, pr.created_at::date) <= $3)
      ORDER BY document_date DESC NULLS LAST, reference_number`;
    return paginate(sql, [company_id, start_date || null, end_date || null], { limit, offset });
  },

  /* ─── Inventory & Stock ──────────────────────────────────────────────────── */

  /**
   * `inventory_items` has `category_id` (FK to item_categories) and
   * `unit_of_measure`. The old query selected `ii.category` and `ii.unit`,
   * neither of which exists — and its "safe" fallback query selected the same
   * two columns, so the safety net failed identically to the thing it guarded.
   *
   * Ledger movement is the authority for on-hand quantity where the ledger has
   * rows; `current_stock` is the fallback, per the standing rule that
   * `inventory_items.current_stock` is truth when no ledger exists.
   */
  async getStockReport({ company_id, limit, offset }) {
    const sql = `
      WITH ledger AS (
        SELECT sl.item_id, SUM(COALESCE(sl.quantity_in, 0) - COALESCE(sl.quantity_out, 0)) AS qty
          FROM stock_ledger sl
         GROUP BY sl.item_id
      )
      SELECT
        ii.item_code, ii.item_name,
        COALESCE(ic.name, 'Uncategorised')            AS category,
        ii.unit_of_measure                            AS unit,
        COALESCE(l.qty, ii.current_stock, 0)          AS current_stock,
        COALESCE(ii.reorder_level, 0)                 AS reorder_level,
        ROUND(COALESCE(l.qty, ii.current_stock, 0) * COALESCE(ii.standard_cost, 0), 2) AS stock_value,
        CASE WHEN COALESCE(l.qty, ii.current_stock, 0) <= COALESCE(ii.reorder_level, 0)
             THEN 'Low Stock' ELSE 'In Stock' END     AS stock_status
      FROM inventory_items ii
      LEFT JOIN ledger l          ON l.item_id = ii.id
      LEFT JOIN item_categories ic ON ic.id = ii.category_id
      WHERE ii.deleted_at IS NULL
        AND ($1::int IS NULL OR ii.company_id = $1)
      ORDER BY ii.item_name`;
    return paginate(sql, [company_id], { limit, offset });
  },

  async getLowStockReport({ company_id, limit, offset }) {
    const sql = `
      WITH ledger AS (
        SELECT sl.item_id, SUM(COALESCE(sl.quantity_in, 0) - COALESCE(sl.quantity_out, 0)) AS qty
          FROM stock_ledger sl
         GROUP BY sl.item_id
      )
      SELECT
        ii.item_code, ii.item_name,
        COALESCE(ic.name, 'Uncategorised')   AS category,
        ii.unit_of_measure                   AS unit,
        COALESCE(l.qty, ii.current_stock, 0) AS current_stock,
        COALESCE(ii.reorder_level, 0)        AS reorder_level,
        ROUND(COALESCE(ii.reorder_level, 0) - COALESCE(l.qty, ii.current_stock, 0), 2) AS shortage
      FROM inventory_items ii
      LEFT JOIN ledger l           ON l.item_id = ii.id
      LEFT JOIN item_categories ic ON ic.id = ii.category_id
      WHERE ii.deleted_at IS NULL
        AND ($1::int IS NULL OR ii.company_id = $1)
        AND COALESCE(l.qty, ii.current_stock, 0) <= COALESCE(ii.reorder_level, 0)
      ORDER BY shortage DESC, ii.item_name`;
    return paginate(sql, [company_id], { limit, offset });
  },

  async getStockMovementReport({ start_date, end_date, company_id, limit, offset }) {
    const sql = `
      SELECT
        sl.transaction_date, sl.transaction_type,
        ii.item_code, ii.item_name,
        COALESCE(ic.name, 'Uncategorised') AS category,
        COALESCE(sl.quantity_in, 0)        AS quantity_in,
        COALESCE(sl.quantity_out, 0)       AS quantity_out,
        sl.balance_qty, sl.rate, sl.value,
        sl.reference_type, sl.remarks
      FROM stock_ledger sl
      JOIN inventory_items ii      ON ii.id = sl.item_id
      LEFT JOIN item_categories ic ON ic.id = ii.category_id
      WHERE ii.deleted_at IS NULL
        AND ($1::int  IS NULL OR sl.company_id = $1)
        AND ($2::date IS NULL OR sl.transaction_date >= $2)
        AND ($3::date IS NULL OR sl.transaction_date <= $3)
      ORDER BY sl.transaction_date DESC, sl.id DESC`;
    return paginate(sql, [company_id, start_date || null, end_date || null], { limit, offset });
  },
};

export default reportsRepository;
