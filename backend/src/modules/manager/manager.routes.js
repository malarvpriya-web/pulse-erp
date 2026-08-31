/**
 * manager.routes.js — aggregation endpoints for the Manager / Ops dashboard.
 *
 * WHY THIS EXISTS
 * ---------------
 * ManagerDashboard.jsx has always called `/manager/budget`, `/manager/team-capacity`
 * and `/manager/targets`, but no `/manager` router was ever mounted. Every call
 * 404'd, `Promise.allSettled` swallowed the rejection, and the three cards
 * rendered their empty states ("No budget data available", "No capacity data
 * available") forever. The panels were not empty because the company had no
 * data — `budgets`, `project_members` and `okr_key_results` are all populated —
 * they were empty because the endpoints did not exist.
 *
 * Scoping model
 *  - company_id always via companyOf(req); never req.user.company_id (fails OPEN).
 *  - "team" = the caller's direct reports. A manager whose reports are not
 *    modelled in the hierarchy falls back to their own department, which is the
 *    same roster the page's other widgets already use (`/employees?department=`).
 *  - /budget shows the whole company only for finance-grade roles. Everyone else
 *    is clamped to their own department rather than 403'd, so the card degrades
 *    to less data instead of to an error.
 */
import express from 'express';
import pool from '../shared/db.js';
import { companyOf, callerIdentity } from '../../shared/scope.js';
import { hasRole } from '../../middlewares/auth.middleware.js';
import { presenceOf } from '../../shared/presence.js';

const router = express.Router();

// Roles allowed to see every department's budget rather than just their own.
const COMPANY_BUDGET_ROLES = [
  'super_admin', 'admin', 'finance', 'finance_manager',
  'accounts_exec', 'payroll_admin', 'department_head',
];

// Callers whose remit is the whole company, so a company-wide roster is the
// right fallback when they have neither direct reports nor a department. These
// accounts have no employees row at all (superadmin@ / admin@), which is why
// every "my team" widget rendered empty for them.
const COMPANY_WIDE_ROLES = ['super_admin', 'admin', 'department_head'];

// employees.status is Capitalized in this schema ('Active', 'Probation',
// 'Notice', 'resigned') — compare lower-cased, and exclude rather than include,
// so a new status value keeps the employee on their manager's roster.
const INACTIVE_EMPLOYEE_STATUSES = ['inactive', 'resigned', 'terminated', 'exited', 'left'];

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round1 = (n) => Math.round(n * 10) / 10;
const ymd = (d) => d.toISOString().slice(0, 10);

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Period helpers ────────────────────────────────────────────────────────────

/** Indian financial year start (1 April) for a given date. */
function fyStart(now = new Date()) {
  const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return new Date(Date.UTC(y, 3, 1));
}

/** Monday-anchored week containing `now`. */
function weekBounds(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;            // Mon = 0
  const start = new Date(d); start.setUTCDate(d.getUTCDate() - dow);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}

function quarterBounds(now = new Date()) {
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0));
  return { start, end, label: 'Q' + (q + 1) + ' ' + now.getUTCFullYear() };
}

/**
 * Weekly capacity per head, from Attendance Settings.
 *
 * full_day_hours x working_days is the only live source for "available hours" in
 * this schema — hr_shifts stores start/end as free text and is not reliable
 * enough to divide by. Both seeded settings rows carry company_id NULL (the
 * known NULL-scoping gotcha), so prefer an exact company match, then a global
 * row, then a stable id order rather than letting the planner pick.
 */
async function weeklyCapacityHours(companyId) {
  const FALLBACK = 40;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(full_day_hours, 8)::float                  AS full_day_hours,
              COALESCE(jsonb_array_length(working_days), 5)::int  AS working_days
         FROM attendance_general_settings
        WHERE $1::int IS NULL OR company_id = $1 OR company_id IS NULL
        ORDER BY (company_id = $1) DESC NULLS LAST, company_id NULLS LAST, id
        LIMIT 1`,
      [companyId]
    );
    if (!rows.length) return FALLBACK;
    const h = num(rows[0].full_day_hours) || 8;
    const d = num(rows[0].working_days) || 5;
    const wk = h * d;
    return wk > 0 ? wk : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// ── Team resolution ───────────────────────────────────────────────────────────

/**
 * Direct reports of `managerId`.
 *
 * Matches on reporting_manager_id first, then on the legacy free-text
 * `reporting_manager` name column for rows that predate the FK — only 4 of 34
 * employees carry the id, so name-matching is what makes this usable at all.
 */
async function directReportsOf(managerId, managerName, companyId) {
  if (!managerId) return [];
  const { rows } = await pool.query(
    `SELECT e.id,
            e.name,
            e.department,
            e.designation,
            (SELECT COUNT(*) FROM employees c
              WHERE c.reporting_manager_id = e.id
                AND c.id <> e.id
                AND c.deleted_at IS NULL)::int AS reports_count,
            ar.status       AS att_status,
            ar.work_mode    AS att_work_mode,
            ar.late_minutes AS att_late_minutes
       FROM employees e
       LEFT JOIN attendance_records ar
              ON ar.employee_id     = e.id
             AND ar.attendance_date = CURRENT_DATE
             AND ar.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND e.id <> $1
        AND LOWER(COALESCE(e.status, 'active')) <> ALL($3::text[])
        AND ($4::int IS NULL OR e.company_id = $4)
        AND ( e.reporting_manager_id = $1
              OR ( e.reporting_manager_id IS NULL
                   AND $2::text IS NOT NULL
                   AND LOWER(TRIM(e.reporting_manager)) = LOWER(TRIM($2::text)) ) )
      ORDER BY e.name`,
    [managerId, managerName || null, INACTIVE_EMPLOYEE_STATUSES, companyId]
  );
  return rows;
}

/** The caller's own identity (employee id when they have one, plus department). */
async function callerEmployee(req, companyId) {
  const who = await callerIdentity(req, pool, companyId);
  return { id: who.employee_id, name: who.name, department: who.department, source: who.source };
}

/**
 * The roster a manager's team widgets should cover: direct reports if the
 * hierarchy models any, otherwise their department. Returns { me, ids, source }.
 */
async function teamRoster(req, companyId) {
  const me = await callerEmployee(req, companyId);
  const reports = await directReportsOf(me.id, me.name, companyId);
  if (reports.length) return { me, ids: reports.map(r => r.id), source: 'direct_reports' };

  const dept = req.query.department || me.department || null;
  if (dept) {
    const ids = await rosterWhere(`department = $1`, [dept], me.id, companyId);
    if (ids.length) return { me, ids, source: 'department' };
  }

  // Admin / super_admin with no employee record and no usable department: their
  // remit is the company, so show the company. Anyone else gets nothing rather
  // than a roster they have no business seeing.
  if (hasRole(req, COMPANY_WIDE_ROLES)) {
    const ids = await rosterWhere('TRUE', [], me.id, companyId);
    if (ids.length) return { me, ids, source: 'company' };
  }

  return { me, ids: [], source: 'none' };
}

/** Active employee ids matching `predicate`, excluding the caller. */
async function rosterWhere(predicate, params, excludeId, companyId) {
  const n = params.length;
  const { rows } = await pool.query(
    `SELECT id FROM employees
      WHERE deleted_at IS NULL
        AND ${predicate}
        AND id <> COALESCE($${n + 1}::int, -1)
        AND LOWER(COALESCE(status, 'active')) <> ALL($${n + 2}::text[])
        AND ($${n + 3}::int IS NULL OR company_id = $${n + 3})
      ORDER BY name
      LIMIT 60`,
    [...params, excludeId, INACTIVE_EMPLOYEE_STATUSES, companyId]
  );
  return rows.map(r => r.id);
}

// ── GET /manager/budget ───────────────────────────────────────────────────────
/**
 * Department budget vs actual, pro-rated to the elapsed period.
 *
 * Comparing a full annual budget against part-year spend makes every department
 * look under budget, so the budget side is scaled by the fraction of the period
 * that has elapsed — `?period=fy` (default) uses months elapsed in the financial
 * year, `?period=month` uses one twelfth.
 *
 * budgets.financial_year is NOT filtered on: the column carries free text in
 * this database ('SEED finan' alongside '2026-2027'), so filtering on it drops
 * every real budget. Active (non-draft) budgets are the population; the date
 * window is applied to the actuals instead, which is where it belongs.
 */
router.get('/budget', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const now = new Date();
    const mode = req.query.period === 'month' ? 'month' : 'fy';

    let from, to, elapsedMonths, label;
    if (mode === 'month') {
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
      elapsedMonths = 1;
      label = MONTH_NAMES[from.getUTCMonth()] + ' ' + from.getUTCFullYear();
    } else {
      from = fyStart(now);
      to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
      elapsedMonths =
        (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
        (to.getUTCMonth() - from.getUTCMonth()) + 1;
      const fyY = from.getUTCFullYear();
      label = 'FY ' + fyY + '-' + String(fyY + 1).slice(2) + ' to date';
    }
    const proRate = Math.min(1, elapsedMonths / 12);

    // Own department only, unless the caller holds a finance-grade role.
    const me = await callerEmployee(req, companyId);
    const seesAll = hasRole(req, COMPANY_BUDGET_ROLES);
    const deptFilter = req.query.department || (seesAll ? null : (me.department || null));

    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(b.department), ''), 'Unassigned') AS dept,
              SUM(b.total_amount)::float                            AS annual_budget,
              COALESCE(SUM(a.actual), 0)::float                     AS actual
         FROM budgets b
         LEFT JOIN LATERAL (
              SELECT SUM(ba.actual_amount) AS actual
                FROM budget_actuals ba
               WHERE ba.budget_id = b.id
                 AND COALESCE(
                       ba.transaction_date,
                       ba.recorded_date,
                       CASE WHEN ba.year IS NOT NULL AND ba.month IS NOT NULL
                            THEN make_date(ba.year, ba.month, 1) END
                     ) BETWEEN $1::date AND $2::date
         ) a ON TRUE
        WHERE b.deleted_at IS NULL
          AND LOWER(COALESCE(b.status, '')) <> 'draft'
          AND ($3::int IS NULL OR b.company_id = $3)
          AND ($4::text IS NULL OR b.department = $4)
        GROUP BY 1
        ORDER BY annual_budget DESC
        LIMIT 12`,
      [ymd(from), ymd(to), companyId, deptFilter]
    );

    const categories = rows.map(r => {
      const budget = round1(num(r.annual_budget) * proRate);
      const actual = round1(num(r.actual));
      return {
        dept: r.dept,
        category: r.dept,        // XAxis reads `dept`; `category` kept for callers that group by it
        budget,
        actual,
        variance: round1(budget - actual),
        used_pct: budget > 0 ? Math.round((actual / budget) * 100) : 0,
      };
    });

    const totalBudget = categories.reduce((s, c) => s + c.budget, 0);
    const totalActual = categories.reduce((s, c) => s + c.actual, 0);

    res.json({
      period: { mode, from: ymd(from), to: ymd(to), label, prorated: true, elapsed_months: elapsedMonths },
      scope: { department: deptFilter, company_wide: !deptFilter },
      categories,
      summary: {
        budget: round1(totalBudget),
        actual: round1(totalActual),
        variance: round1(totalBudget - totalActual),
        used_pct: totalBudget > 0 ? Math.round((totalActual / totalBudget) * 100) : 0,
      },
    });
  } catch (err) {
    console.error('[GET /manager/budget]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /manager/team ───────────────────────────────────────────────
/**
 * The caller's team, with the two facts the dashboard's team cards claim to show
 * and previously invented: a performance rating and today's presence.
 *
 * Both cards read `/employees`, which carries NEITHER. `m.rating` was always
 * undefined, so every member rendered `(0).toFixed(1)` = "0.0" with an empty bar;
 * and `m.status` is the EMPLOYMENT status, so the presence dot fell through to a
 * default of green "Present" for the whole company. `performance_reviews` has had
 * real ratings all along.
 *
 * Rating precedence matches analytics.routes.js:
 * COALESCE(overall_rating, calibrated_rating, final_rating), most recent review.
 */
router.get('/team', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { ids, source } = await teamRoster(req, companyId);
    if (!ids.length) return res.json({ source, data: [] });

    const { rows } = await pool.query(
      `SELECT e.id,
              e.name,
              e.department,
              e.designation,
              e.status        AS employment_status,
              pr.rating,
              pr.review_period,
              ar.status       AS att_status,
              ar.work_mode    AS att_work_mode,
              COALESCE(ar.late_minutes, 0)::int AS att_late_minutes
         FROM employees e
         LEFT JOIN LATERAL (
              SELECT COALESCE(overall_rating, calibrated_rating, final_rating)::float AS rating,
                     review_period
                FROM performance_reviews
               WHERE employee_id = e.id
                 AND deleted_at IS NULL
                 AND COALESCE(overall_rating, calibrated_rating, final_rating) IS NOT NULL
               ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST, id DESC
               LIMIT 1
         ) pr ON TRUE
         LEFT JOIN attendance_records ar
                ON ar.employee_id     = e.id
               AND ar.attendance_date = CURRENT_DATE
               AND ar.deleted_at IS NULL
        WHERE e.id = ANY($1::int[])
          AND e.deleted_at IS NULL
        ORDER BY pr.rating DESC NULLS LAST, e.name`,
      [ids]
    );

    res.json({
      source,
      // Ratings here are on a 5-point scale. Sent explicitly because parts of
      // analytics/ treat the same columns as a 0-100 score, and the card divides
      // by 5 to size its bar — a 100-scale value would render a 2000%-wide bar.
      rating_scale: 5,
      data: rows.map(r => ({
        id:                r.id,
        name:              r.name,
        department:        r.department,
        designation:       r.designation,
        employment_status: r.employment_status,
        rating:            r.rating == null ? null : round1(num(r.rating)),
        review_period:     r.review_period || null,
        status:            presenceOf(r),
      })),
    });
  } catch (err) {
    console.error('[GET /manager/team]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /manager/team-capacity ────────────────────────────────────────────────
/**
 * Allocated vs available hours for the current week.
 *
 * Allocation comes from project_members.allocation_pct — an unambiguous
 * percentage of a person's week — rather than hours_allocated, which is not
 * qualified by a period anywhere in the schema. Memberships count only when
 * their [start_date, end_date] window overlaps this week.
 */
router.get('/team-capacity', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { ids, source } = await teamRoster(req, companyId);
    if (!ids.length) return res.json({ week: null, source, data: [] });

    const { start, end } = weekBounds();
    const capacity = await weeklyCapacityHours(companyId);

    const { rows } = await pool.query(
      `SELECT e.id,
              e.name,
              e.department,
              e.designation,
              COALESCE(SUM(pm.allocation_pct), 0)::float AS alloc_pct,
              COUNT(DISTINCT pm.project_id)::int         AS projects
         FROM employees e
         LEFT JOIN project_members pm
                ON pm.employee_id = e.id
               AND ($4::int IS NULL OR pm.company_id = $4)
               AND COALESCE(pm.start_date, $2::date) <= $3::date
               AND COALESCE(pm.end_date,   $3::date) >= $2::date
        WHERE e.id = ANY($1::int[])
          AND e.deleted_at IS NULL
        GROUP BY e.id, e.name, e.department, e.designation
        ORDER BY alloc_pct DESC, e.name`,
      [ids, ymd(start), ymd(end), companyId]
    );

    res.json({
      week: { start: ymd(start), end: ymd(end) },
      source,
      capacity_hours_per_week: capacity,
      data: rows.map(r => ({
        id: r.id,
        name: r.name,
        department: r.department,
        designation: r.designation,
        allocated_hours: round1((num(r.alloc_pct) / 100) * capacity),
        capacity_hours: capacity,
        allocation_pct: round1(num(r.alloc_pct)),
        projects: r.projects,
      })),
    });
  } catch (err) {
    console.error('[GET /manager/team-capacity]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /manager/targets ──────────────────────────────────────────────────────
/**
 * Team targets vs actuals for the current quarter, from the OKR key results
 * whose objective overlaps the quarter.
 *
 * Draft and cancelled objectives are excluded — a draft OKR is not a commitment.
 * An objective qualifies when it is company-level, sits in the caller's
 * department, or is owned by the caller or someone on their roster.
 */
router.get('/targets', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { me, ids } = await teamRoster(req, companyId);
    const owners = [...new Set([me.id, ...ids].filter(Boolean))];
    const dept = req.query.department || me.department || null;
    const { start, end, label } = quarterBounds();

    const { rows } = await pool.query(
      `SELECT kr.id,
              kr.title                AS metric,
              kr.unit,
              kr.target_value::float  AS target,
              kr.current_value::float AS actual,
              o.title                 AS objective,
              o.department,
              o.level
         FROM okr_key_results kr
         JOIN okr_objectives  o ON o.id = kr.objective_id
        WHERE ($1::int IS NULL OR o.company_id = $1)
          AND LOWER(COALESCE(o.status, '')) NOT IN ('draft', 'cancelled')
          AND COALESCE(o.start_date, $2::date) <= $3::date
          AND COALESCE(o.end_date,   $3::date) >= $2::date
          AND ( o.level = 'company'
                OR ($4::text IS NOT NULL AND o.department = $4)
                OR o.owner_id  = ANY($5::int[])
                OR kr.owner_id = ANY($5::int[]) )
        ORDER BY o.level, kr.id
        LIMIT 12`,
      [companyId, ymd(start), ymd(end), dept, owners]
    );

    res.json({
      quarter: { start: ymd(start), end: ymd(end), label },
      data: rows.map(r => ({
        metric: r.metric,
        unit: r.unit || null,
        target: round1(num(r.target)),
        actual: round1(num(r.actual)),
        objective: r.objective,
        department: r.department,
      })),
    });
  } catch (err) {
    console.error('[GET /manager/targets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
