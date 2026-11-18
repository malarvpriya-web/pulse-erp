/**
 * Mandatory training compliance and refresher due dates (2026-11-18).
 *
 * A training that repeats (every 3, 6, 12 months…) is a SERIES: the first
 * round and every "Schedule next round" copy share series_id (the first
 * round's id). Compliance is per series, not per round, so running the safety
 * drill again in March does not make everyone who did it in September
 * non-compliant overnight.
 *
 * For each active employee a mandatory series targets (target department /
 * role, blank = everyone):
 *   compliant  completed, and the refresher (if any) is not due within N days
 *   due_soon   completed, refresher due within N days
 *   overdue    completed, refresher date has passed
 *   not_done   never completed
 * `scheduled` says whether they are already enrolled in an upcoming round.
 */
import { ACTIVE_EMP, EMP_NAME } from './lndShared.js';

export async function computeCompliance(db, companyId, { department = null, seriesId = null, employeeId = null, category = null, dueSoonDays = 30 } = {}) {
  const { rows } = await db.query(
    `WITH rounds AS (
       SELECT tp.*, COALESCE(tp.series_id, tp.id) AS root
         FROM training_programs tp
        WHERE tp.deleted_at IS NULL AND tp.status <> 'cancelled'
          AND ($1::int IS NULL OR tp.company_id = $1)
     ),
     series AS (
       SELECT DISTINCT ON (root) root, title, category, target_department, target_role, refresher_months, is_mandatory
         FROM rounds ORDER BY root, scheduled_date DESC NULLS LAST, id DESC
     ),
     mand AS (SELECT * FROM series WHERE is_mandatory
                AND ($3::int IS NULL OR root = $3) AND ($5::text IS NULL OR category = $5)),
     emp AS (
       SELECT e.id, ${EMP_NAME} AS name, e.department, e.designation, e.office_id
         FROM employees e
        WHERE ${ACTIVE_EMP} AND ($1::int IS NULL OR e.company_id = $1)
          AND ($2::text IS NULL OR e.department = $2) AND ($4::int IS NULL OR e.id = $4)
     ),
     done AS (
       SELECT te.employee_id, r.root, MAX(te.completion_date) AS last_done
         FROM training_enrollments te JOIN rounds r ON r.id = te.program_id
        WHERE te.status = 'completed' GROUP BY 1, 2
     ),
     upcoming AS (
       SELECT DISTINCT te.employee_id, r.root, MIN(r.scheduled_date) AS next_date
         FROM training_enrollments te JOIN rounds r ON r.id = te.program_id
        WHERE te.status IN ('enrolled','in_progress') AND r.scheduled_date >= CURRENT_DATE GROUP BY 1, 2
     )
     SELECT emp.id AS employee_id, emp.name AS employee_name, emp.department, emp.designation, emp.office_id,
            m.root AS series_id, m.title, m.category, m.refresher_months,
            d.last_done::text AS last_completed,
            CASE WHEN d.last_done IS NOT NULL AND m.refresher_months IS NOT NULL
                 THEN (d.last_done + make_interval(months => m.refresher_months))::date::text END AS valid_until,
            u.next_date::text AS next_scheduled,
            CASE
              WHEN d.last_done IS NULL THEN 'not_done'
              WHEN m.refresher_months IS NULL THEN 'compliant'
              WHEN (d.last_done + make_interval(months => m.refresher_months))::date < CURRENT_DATE THEN 'overdue'
              WHEN (d.last_done + make_interval(months => m.refresher_months))::date <= CURRENT_DATE + $6::int THEN 'due_soon'
              ELSE 'compliant'
            END AS status
       FROM mand m
       JOIN emp ON (m.target_department IS NULL OR TRIM(m.target_department) = '' OR m.target_department = emp.department)
               AND (m.target_role IS NULL OR TRIM(m.target_role) = '' OR LOWER(m.target_role) = LOWER(emp.designation))
       LEFT JOIN done d ON d.employee_id = emp.id AND d.root = m.root
       LEFT JOIN upcoming u ON u.employee_id = emp.id AND u.root = m.root
      ORDER BY m.title, emp.name`,
    [companyId, department, seriesId, employeeId, category, dueSoonDays]);

  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.series_id)) {
      bySeries.set(r.series_id, { series_id: r.series_id, title: r.title, category: r.category, refresher_months: r.refresher_months,
        required: 0, compliant: 0, due_soon: 0, overdue: 0, not_done: 0, scheduled: 0 });
    }
    const s = bySeries.get(r.series_id);
    s.required++; s[r.status]++; if (r.next_scheduled) s.scheduled++;
  }
  const series = [...bySeries.values()].map(s => ({
    ...s, compliance_pct: s.required ? Math.round(100 * (s.compliant + s.due_soon) / s.required) : 100,
  }));
  const required = rows.length;
  const ok = rows.filter(r => r.status === 'compliant' || r.status === 'due_soon').length;
  return {
    rows, series,
    summary: {
      required, compliant: ok,
      due_soon: rows.filter(r => r.status === 'due_soon').length,
      overdue: rows.filter(r => r.status === 'overdue').length,
      not_done: rows.filter(r => r.status === 'not_done').length,
      compliance_pct: required ? Math.round(100 * ok / required) : 100,
    },
  };
}
