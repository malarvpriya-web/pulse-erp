/**
 * Key credit settings by the party, not by an account that mostly does not exist.
 *
 * Sales > Fulfilment & Credit Control lists customers straight out of `parties`
 * (the customer master), so every row on that screen carries `parties.id` — a
 * uuid. Its "Set Limit" / "Block" buttons PATCH that uuid back, and the handler
 * wrote it into `customer_credit_settings.account_id`, an INTEGER. Every save
 * the application ever attempted died in the driver:
 *
 *   22P02  invalid input syntax for type integer: "dcef3036-53b7-4e37-…"
 *
 * surfacing as a 500 and the modal's "Save failed" toast. Reproduced live
 * against the dev database before this change. The five rows already in the
 * table are seed data; no row here was ever written by the application.
 *
 * Re-keying rather than translating uuid->account id, because the account leg
 * cannot cover the screen: 23 customer parties exist and only 9 of them have an
 * `accounts` row, so 14 customers on that list had no writable key at all. The
 * GET already reaches the table through `accounts` for exactly this reason and
 * carries a comment about the type mismatch — the join was fixed, the write
 * path was not.
 *
 * `account_id` is kept and back-filled where an account exists, but loses its
 * NOT NULL: a customer with no account row is now storable. The old
 * (company_id, account_id) unique key is kept too, so nothing that still writes
 * through the account leg changes behaviour.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE customer_credit_settings ADD COLUMN IF NOT EXISTS party_id UUID`);
  await knex.raw(`ALTER TABLE customer_credit_settings ALTER COLUMN account_id DROP NOT NULL`);

  await knex.raw(`ALTER TABLE customer_credit_settings DROP CONSTRAINT IF EXISTS customer_credit_settings_party_id_fkey`);
  await knex.raw(`
    ALTER TABLE customer_credit_settings
      ADD CONSTRAINT customer_credit_settings_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE
  `);

  // Back-fill through the account the row was filed under. accounts.party_id is
  // itself a uuid, so this is the mapping the read path was already making.
  const { rows: filled } = await knex.raw(`
    UPDATE customer_credit_settings ccs
       SET party_id = a.party_id
      FROM accounts a
     WHERE ccs.party_id IS NULL
       AND ccs.account_id = a.id
       AND a.party_id IS NOT NULL
    RETURNING ccs.id
  `);

  const { rows: [stranded] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM customer_credit_settings WHERE party_id IS NULL
  `);

  // Partial, so the rows that could not be attributed above do not collide.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_settings_company_party_key
      ON customer_credit_settings(company_id, party_id)
      WHERE party_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ccs_party ON customer_credit_settings(party_id)
  `);

  console.log(
    `[20260909000001] customer_credit_settings.party_id added; ${filled.length} row(s) attributed ` +
    `via their account, ${stranded.n} left unattributed.`
  );
  if (stranded.n > 0) {
    console.warn(
      `[20260909000001] ${stranded.n} credit setting(s) reference an account with no party and are ` +
      `unreachable from the Credit Control screen until a person re-files them.`
    );
  }
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_ccs_party`);
  await knex.raw(`DROP INDEX IF EXISTS customer_credit_settings_company_party_key`);
  await knex.raw(`ALTER TABLE customer_credit_settings DROP CONSTRAINT IF EXISTS customer_credit_settings_party_id_fkey`);
  await knex.raw(`ALTER TABLE customer_credit_settings DROP COLUMN IF EXISTS party_id`);
}
