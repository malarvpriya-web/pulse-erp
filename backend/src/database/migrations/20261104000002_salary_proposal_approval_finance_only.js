/**
 * 20261104000002 — PC-01 closure decision 1 (04 Nov 26): salary proposals are
 * approved by Finance (finance_manager) and the administrators only.
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §231.
 *
 * 20261104000001 granted salary_proposals:approve to hr_manager and
 * payroll_admin as well, carried over from the old PROPOSAL_APPROVERS role
 * list. Both also hold payroll:edit, which creates proposals, so an HR
 * preparer and a second HR user could complete a salary change with no Finance
 * involvement. Kept: super_admin, admin, finance_manager.
 *
 * CHANGED rows (module salary_proposals):
 *   hr_manager     can_approve  true → false
 *   payroll_admin  can_approve  true → false
 * Each change is made only if the row still holds the expected old value; if
 * not, the migration FAILS (it never overwrites an administrator's later edit).
 * No other row, and no employee, salary, payroll or proposal row, is touched.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() restores both values, under the same expected-value check.
 */
export const CHANGES = [
  ['hr_manager',    'salary_proposals', 'can_approve', true, false],
  ['payroll_admin', 'salary_proposals', 'can_approve', true, false],
];

async function setFlag(knex, role, module, column, from, to) {
  // module and column come from the constant above, never from input
  const { rows } = await knex.raw(
    `UPDATE role_permissions rp SET ${column} = $3
       FROM roles r
      WHERE r.id = rp.role_id AND LOWER(r.code) = $1 AND rp.module = $4 AND rp.${column} = $2
      RETURNING rp.id`,
    [role, from, to, module],
  );
  if (rows.length !== 1) {
    throw new Error(`${module}.${column} for role ${role} is not ${from} as expected (rows matched: ${rows.length}) — refusing to change the matrix`);
  }
}

export async function up(knex) {
  for (const [role, module, column, from, to] of CHANGES) await setFlag(knex, role, module, column, from, to);
}

export async function down(knex) {
  for (const [role, module, column, from, to] of CHANGES) await setFlag(knex, role, module, column, to, from);
}
