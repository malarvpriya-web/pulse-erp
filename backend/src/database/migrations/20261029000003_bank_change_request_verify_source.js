/**
 * 20261029000003 — "verify as-is" bank-detail requests (§206).
 *
 * employee_bank_change_requests.source gains 'verify': a request to have the
 * bank details ALREADY on record checked by a second HR person, without
 * re-typing them. Its proposed_* columns hold the details on record at the
 * time of the request; an approval stamps bank_verified_at / _by only if the
 * record still holds exactly those details.
 *
 * Constraint change only (drop + re-add the CHECK with one more value). Every
 * existing row ('create' / 'edit') satisfies the new CHECK. No employee, bank
 * or request row is read or written.
 * Rollback: down() restores the two-value CHECK (fails if a 'verify' row
 * exists — remove those first).
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE employee_bank_change_requests DROP CONSTRAINT IF EXISTS chk_ebcr_source`);
  await knex.raw(`ALTER TABLE employee_bank_change_requests
                    ADD CONSTRAINT chk_ebcr_source CHECK (source IN ('create', 'edit', 'verify'))`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employee_bank_change_requests DROP CONSTRAINT IF EXISTS chk_ebcr_source`);
  await knex.raw(`ALTER TABLE employee_bank_change_requests
                    ADD CONSTRAINT chk_ebcr_source CHECK (source IN ('create', 'edit'))`);
}
