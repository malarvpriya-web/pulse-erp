/**
 * 20261111000002 — owner decision (11 Nov 26): ONLY the Finance Manager records
 * an employee's tax regime (old / new).
 *
 * PUT /payroll/tax-regime/:employeeId was gated on payroll:edit, which admin,
 * super_admin, hr, hr_manager and payroll_admin hold — and finance_manager did
 * NOT. The route now requires tax_regime:edit, a new matrix module seeded here:
 *   finance_manager  view + edit
 *   every other role a row with every flag false (fail closed, and visible in
 *                    Roles Setup so an administrator can see who holds it)
 * Reading the regime (Tax setup list, /my-tax-regime) is unchanged.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() removes the tax_regime rows (the route change is code).
 */
export const MODULE = 'tax_regime';
const COLS = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_export'];
export const GRANTED = { finance_manager: { can_view: true, can_edit: true } };

export async function up(knex) {
  const { rows: roles } = await knex.raw(`SELECT id, LOWER(code) AS code FROM roles`);
  for (const role of roles) {
    const g = GRANTED[role.code] || {};
    await knex.raw(
      `INSERT INTO role_permissions (role_id, module, ${COLS.join(', ')})
       VALUES ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (role_id, module) DO NOTHING`,
      [role.id, MODULE, ...COLS.map(c => !!g[c])],
    );
  }
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = $1`, [MODULE]);
}
