/**
 * The exit checklist — ONE list per leaver (owner decision 2026-11-17: merge
 * "Exit clearance" and "Offboarding checklist").
 *
 *   1. Automatic checks   assets returned, travel advances settled, logins
 *                         disabled — computed live (exit.routes.js
 *                         computeClearanceBlockers)
 *   2. Sign-offs          HR, Finance, reporting manager NOCs (exit_clearance)
 *   3. Company items      the company's own checklist (this module):
 *                         hr_offboarding_checklist_templates per company,
 *                         progress per employee in hr_offboarding_checklist_progress
 *
 * The F&F payment is refused until all three are done; paying it closes the exit
 * and moves the employee to Ex-Employees (there is no separate "complete" step).
 */

/**
 * The active checklist items of a company. A company with no list of its own
 * uses the shared default (company_id NULL) until it saves one (migration
 * 20261116000003).
 */
export async function offboardingTemplates(db, companyId) {
  const { rows } = await db.query(`
    SELECT category, item_label, default_assignee, default_offset_days, sort_order
      FROM hr_offboarding_checklist_templates
     WHERE is_active = TRUE
       AND company_id IS NOT DISTINCT FROM (
             CASE WHEN EXISTS (SELECT 1 FROM hr_offboarding_checklist_templates
                                WHERE is_active = TRUE AND company_id = $1::int)
                  THEN $1::int END)
     ORDER BY category ASC, sort_order ASC, id ASC`, [companyId]);
  return rows;
}

/** The employee's company items that are not done yet: [{ category, item_label, assignee }]. */
export async function openChecklistItems(db, employeeId) {
  const { rows: [emp] } = await db.query(`SELECT company_id FROM employees WHERE id = $1`, [employeeId]);
  if (!emp) return [];
  const templates = await offboardingTemplates(db, emp.company_id);
  if (!templates.length) return [];
  const { rows: progress } = await db.query(
    `SELECT category, item_label, done, assignee FROM hr_offboarding_checklist_progress WHERE employee_id = $1`, [employeeId]);
  const byKey = new Map(progress.map(p => [`${p.category}__${p.item_label}`, p]));
  return templates
    .map(t => ({ t, p: byKey.get(`${t.category}__${t.item_label}`) }))
    .filter(({ p }) => !p?.done)
    .map(({ t, p }) => ({ category: t.category, item_label: t.item_label, assignee: p?.assignee || t.default_assignee || 'HR' }));
}
