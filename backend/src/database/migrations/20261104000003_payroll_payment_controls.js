/**
 * 20261104000003 — PC-02a payroll payment controls (decisions PD-1, PD-2, PD-3,
 * 04 Nov 26). See PAYROLL_PC02_DECISION_REGISTER.md and
 * MODULE_FEATURE_CONNECTION_MANUAL.md §232.
 *
 * Permission matrix (each change only if the row still holds the expected old
 * value; otherwise the migration FAILS and changes nothing):
 *   payroll          payroll_admin  can_approve  true  → false   PD-2: HR prepares, Finance /
 *                                                                administrators approve
 *   payroll_payment  admin          can_approve  false → true    PD-3: administrators may record
 *   payroll_payment  super_admin    can_approve  false → true          payment, under maker-checker
 *
 * payroll_runs — the evidence of a payment, kept apart from reconciliation:
 *   paid_at, paid_by (users.id), value_date   who recorded it, when, bank value date
 *   reconciled_at                             set only by bank reconciliation (none yet);
 *                                             a UTR is evidence of a transfer, NOT of
 *                                             reconciliation (PD-1)
 *   ux_payroll_runs_payment_reference         one UTR, one run (case-insensitive)
 *
 * journal_entries — ux_journal_entries_payroll_reference: at most one live (not
 * deleted, not a reversal) entry per company + payroll reference, so neither the
 * approval accrual nor a salary clearing can be posted twice (PD-1, PD-15).
 *
 * No employee, salary, payroll-run value or journal row is changed.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() drops the two indexes and four columns and restores the
 * three permission values (same expected-value check).
 */
export const CHANGES = [
  ['payroll_admin', 'payroll',         'can_approve', true,  false],
  ['admin',         'payroll_payment', 'can_approve', false, true],
  ['super_admin',   'payroll_payment', 'can_approve', false, true],
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

  await knex.raw(`ALTER TABLE payroll_runs
    ADD COLUMN IF NOT EXISTS paid_at       timestamptz,
    ADD COLUMN IF NOT EXISTS paid_by       integer REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS value_date    date,
    ADD COLUMN IF NOT EXISTS reconciled_at timestamptz`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_runs_payment_reference
    ON payroll_runs (UPPER(payment_reference)) WHERE payment_reference IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_entries_payroll_reference
    ON journal_entries (company_id, reference_type, reference_id)
    WHERE reference_type IN ('payroll_run', 'salary_disbursement') AND deleted_at IS NULL AND reversal_of_id IS NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ux_journal_entries_payroll_reference`);
  await knex.raw(`DROP INDEX IF EXISTS ux_payroll_runs_payment_reference`);
  await knex.raw(`ALTER TABLE payroll_runs
    DROP COLUMN IF EXISTS reconciled_at, DROP COLUMN IF EXISTS value_date,
    DROP COLUMN IF EXISTS paid_by, DROP COLUMN IF EXISTS paid_at`);
  for (const [role, module, column, from, to] of CHANGES) await setFlag(knex, role, module, column, to, from);
}
