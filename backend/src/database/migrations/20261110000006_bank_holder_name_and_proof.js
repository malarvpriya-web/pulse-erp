/**
 * Bank details: account-holder name and proof on the change request (§267).
 *
 *   employees.account_holder_name                  the name the bank holds the
 *                                                  account in (was not recorded)
 *   employee_bank_change_requests
 *     .proposed_account_holder_name                part of the proposed set
 *     .proof_cheque_file / .proof_statement_file   the cancelled cheque / bank
 *                                                  statement for the PROPOSED
 *                                                  account. They stay on the
 *                                                  request until approval, then
 *                                                  are copied to the employee's
 *                                                  cancelled_cheque_file /
 *                                                  bank_statement_file — the
 *                                                  record never shows a cheque
 *                                                  for an account it does not hold.
 *
 * Nothing existing is rewritten. The runner is a pg shim: placeholders are $n.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS account_holder_name text`);
  await knex.raw(`
    ALTER TABLE employee_bank_change_requests
      ADD COLUMN IF NOT EXISTS proposed_account_holder_name text,
      ADD COLUMN IF NOT EXISTS proof_cheque_file text,
      ADD COLUMN IF NOT EXISTS proof_statement_file text`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE employee_bank_change_requests
      DROP COLUMN IF EXISTS proof_statement_file, DROP COLUMN IF EXISTS proof_cheque_file,
      DROP COLUMN IF EXISTS proposed_account_holder_name`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS account_holder_name`);
}
