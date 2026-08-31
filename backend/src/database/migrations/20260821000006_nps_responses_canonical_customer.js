/**
 * nps_responses: put it on the canonical customer id, and make its category
 * vocabulary enforceable.
 *
 * Two defects, both live, both found by re-auditing CRM against the running
 * system rather than by reading code.
 *
 * ── 1. customer_id was INTEGER against a uuid master ───────────────────────
 * `GET /crm/nps/responses` does
 *
 *     LEFT JOIN parties p ON p.id = nr.customer_id
 *
 * and `parties.id` is uuid while `nps_responses.customer_id` is integer, so the
 * endpoint returned
 *
 *     500  operator does not exist: uuid = integer
 *
 * on every call. The same uuid-vs-integer trap as the original accounts/parties
 * split, one table further out. The five existing rows hold ACCOUNT ids (1–5),
 * so they are mapped through `accounts.party_id` — the sanctioned resolution
 * path — and any that cannot be resolved are left NULL rather than guessed at.
 *
 * ── 2. category held values from outside its own vocabulary ────────────────
 * `npsCategory()` in customer360.routes.js classifies a score as
 * detractor (0–6) / passive (7–8) / promoter (9–10), and `/nps/summary` counts
 * by those three labels. The seeding sweep wrote 'Standard', 'General',
 * 'Primary' and 'Routine' — generic filler that matches none of them. All five
 * responses scored 10/10, so the NPS should read +100; because no row counted
 * as a promoter it read **-100**, the worst possible score. A KPI reporting the
 * exact inverse of the truth.
 *
 * `check:statuses` did not catch it: `nps_responses.category` is not one of the
 * columns statusSets.js declares. A CHECK constraint is the more direct fix —
 * it makes the column unable to hold a value the code cannot interpret, whoever
 * is writing.
 */

export async function up(knex) {
  // ── customer_id → uuid ────────────────────────────────────────────────────
  const { rows: col } = await knex.raw(`
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'nps_responses' AND column_name = 'customer_id'
  `);

  if (col[0]?.data_type !== 'uuid') {
    await knex.raw(`ALTER TABLE nps_responses ADD COLUMN IF NOT EXISTS customer_party_id uuid`);

    // The integers are account ids; accounts.party_id is the bridge to canonical.
    const { rows: mapped } = await knex.raw(`
      UPDATE nps_responses nr
         SET customer_party_id = a.party_id
        FROM accounts a
       WHERE a.id = nr.customer_id
       RETURNING nr.id
    `);

    const { rows: unresolved } = await knex.raw(`
      SELECT COUNT(*)::int AS n FROM nps_responses
       WHERE customer_id IS NOT NULL AND customer_party_id IS NULL
    `);
    console.log(`   ↳ nps_responses: ${mapped.length} mapped to a canonical party, ` +
                `${unresolved[0].n} left NULL (no resolvable account)`);

    await knex.raw(`ALTER TABLE nps_responses DROP COLUMN customer_id`);
    await knex.raw(`ALTER TABLE nps_responses RENAME COLUMN customer_party_id TO customer_id`);
    await knex.raw(`
      ALTER TABLE nps_responses
        ADD CONSTRAINT nps_responses_customer_id_fkey
        FOREIGN KEY (customer_id) REFERENCES parties(id) ON DELETE SET NULL
    `);
  }

  // ── category vocabulary ───────────────────────────────────────────────────
  // Recompute from score, which is the authoritative field — the same
  // thresholds npsCategory() applies.
  const { rows: fixed } = await knex.raw(`
    UPDATE nps_responses
       SET category = CASE WHEN score <= 6 THEN 'detractor'
                           WHEN score <= 8 THEN 'passive'
                           ELSE 'promoter' END
     WHERE category IS NULL OR category NOT IN ('detractor', 'passive', 'promoter')
     RETURNING id
  `);
  if (fixed.length) console.log(`   ↳ nps_responses: reclassified ${fixed.length} row(s) from score`);

  await knex.raw(`ALTER TABLE nps_responses DROP CONSTRAINT IF EXISTS nps_responses_category_check`);
  await knex.raw(`
    ALTER TABLE nps_responses
      ADD CONSTRAINT nps_responses_category_check
      CHECK (category IN ('detractor', 'passive', 'promoter'))
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE nps_responses DROP CONSTRAINT IF EXISTS nps_responses_category_check`);
  await knex.raw(`ALTER TABLE nps_responses DROP CONSTRAINT IF EXISTS nps_responses_customer_id_fkey`);
  await knex.raw(`ALTER TABLE nps_responses ADD COLUMN IF NOT EXISTS customer_account_id integer`);
  await knex.raw(`
    UPDATE nps_responses nr SET customer_account_id = a.id
      FROM accounts a WHERE a.party_id = nr.customer_id
  `);
  await knex.raw(`ALTER TABLE nps_responses DROP COLUMN customer_id`);
  await knex.raw(`ALTER TABLE nps_responses RENAME COLUMN customer_account_id TO customer_id`);
}
