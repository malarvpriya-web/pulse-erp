// backend/src/modules/hr/onboarding.service.js
// Shared onboarding-checklist init logic, extracted from the manual
// POST /onboarding/progress/:employee_id/init route so employee-creation
// paths (direct Add Employee, recruitment hire, auto-creation trigger) can
// fire it automatically instead of depending on HR remembering to call it.

/**
 * Seeds hr_onboarding_checklist_progress rows from the active template set
 * for a newly created employee, with due-dates computed from joining_date.
 * Accepts a pg Pool or an in-transaction Client — either exposes .query().
 * Idempotent (ON CONFLICT DO NOTHING), so calling it twice for the same
 * employee (e.g. once automatically, once via a manual re-init) is safe.
 */
export async function initOnboardingChecklist(db, companyId, employeeId) {
  const { rows: templates } = await db.query(`
    SELECT * FROM hr_onboarding_checklist_templates
    WHERE is_active = true AND (company_id IS NULL OR company_id = $1)
  `, [companyId]);

  const { rows: [emp] } = await db.query(`SELECT joining_date FROM employees WHERE id=$1`, [employeeId]);
  const joining = emp?.joining_date ? new Date(emp.joining_date) : new Date();

  for (const t of templates) {
    const dueDate = new Date(joining);
    dueDate.setDate(dueDate.getDate() + (t.default_offset_days || 0));
    await db.query(`
      INSERT INTO hr_onboarding_checklist_progress
        (company_id, employee_id, category, item_label, assignee, due_date)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (employee_id, category, item_label) DO NOTHING
    `, [companyId, employeeId, t.category, t.item_label, t.default_assignee, dueDate.toISOString().split('T')[0]]);
  }

  return { items: templates.length };
}
