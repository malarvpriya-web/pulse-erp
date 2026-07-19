/**
 * 20260709000002_fix_write_path_sequences.js
 *
 * DB write-path smoke test (2026-07-09) found three doc-number sequences that
 * break create endpoints:
 *   - seq_party_cust / seq_party_supp : referenced by docNumber.nextCust/SuppPartyCode
 *     (POST /finance/parties) but never created → "relation seq_party_cust does not exist".
 *   - seq_cmp : exists but stuck at last_value=1 while complaints already reach
 *     CMP-2026-0005, so nextComplaintNumber() (POST /complaints) collides on the
 *     unique complaint_number.
 *
 * This migration creates the two missing sequences and advances all three past
 * the highest existing code so freshly generated numbers never collide.
 * Idempotent: safe to re-run.
 */
export async function up(knex) {
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_party_cust`);
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_party_supp`);

  // Advance each sequence to GREATEST(current, max existing trailing number).
  // Use the LAST digit group so CMP-2026-0005 yields 5 (not 20260005).
  // setval(..., n, true) => next nextval() returns n+1.
  await knex.raw(`
    SELECT setval('seq_party_cust', GREATEST(
      (SELECT COALESCE(MAX((substring(party_code from '([0-9]+)$'))::int), 0)
         FROM parties WHERE party_code ~* '^CUST' AND party_code ~ '[0-9]'), 1), true)
  `);
  await knex.raw(`
    SELECT setval('seq_party_supp', GREATEST(
      (SELECT COALESCE(MAX((substring(party_code from '([0-9]+)$'))::int), 0)
         FROM parties WHERE party_code ~* '^SUPP' AND party_code ~ '[0-9]'), 1), true)
  `);
  await knex.raw(`
    SELECT setval('seq_cmp', GREATEST(
      (SELECT COALESCE(MAX((substring(complaint_number from '([0-9]+)$'))::int), 0)
         FROM complaints WHERE complaint_number ~ '[0-9]'), 1), true)
  `);
}

export async function down(knex) {
  // Non-destructive: leave sequences in place (dropping them would re-break creates).
  await knex.raw(`SELECT 1`);
}
