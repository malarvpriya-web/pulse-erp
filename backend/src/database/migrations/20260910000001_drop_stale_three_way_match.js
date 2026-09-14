/**
 * 20260910000001_drop_stale_three_way_match.js
 *
 * Two three-way-match tables existed side by side.
 *
 * WHAT WAS THERE
 * --------------
 *   three_way_match   (singular) — string-keyed. po_number / invoice_number /
 *                     grn_number as VARCHAR, vendor_name as free text, no
 *                     company_id, no foreign key to anything. Nothing can be
 *                     joined from it; nothing can be scoped by it.
 *   three_way_matches (plural)   — po_id / grn_id / bill_id as real foreign
 *                     keys, company_id, the discrepancy fields the finance gate
 *                     reads, and the table the routes actually use.
 *
 * WHY THE SINGULAR GOES
 * ---------------------
 * Not one line of application code reads or writes it. It is referenced only by
 * the seeder's manifest, which is why it is not empty: its five rows are
 * `TWM-13484`-style placeholders written in a single millisecond on 20 Aug by
 * `scripts/seed`, not by any user action. A populated table proves nothing —
 * only rows the APPLICATION wrote count, and here there are none.
 *
 * A stale twin is a live source of drift: the next person to grep
 * "three_way_match" finds the string-keyed one first, writes against it, and
 * their feature silently never meets the finance gate. Dropping it is the fix;
 * leaving it and adding a comment is not.
 *
 * ⚠ DROP TABLE cascades to the indexes and the sequence that name it — that is
 * intended here, they belong to this table alone. Nothing else references it:
 * `pg_constraint WHERE confrelid = 'three_way_match'::regclass` returned zero
 * rows before this was written.
 *
 * The rows are copied into `three_way_match_archive` first rather than deleted
 * outright. They are synthetic, so this costs nothing and it means `down()` is
 * a real inverse instead of an apology.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // Nothing to do on a database that never had the stale twin (a fresh install
  // built from a baseline taken after this migration).
  const { rows } = await knex.raw(`SELECT to_regclass('public.three_way_match') AS t`);
  if (!rows[0]?.t) return;

  // Keep the rows addressable before the table stops existing.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS three_way_match_archive AS
      SELECT *, NOW() AS archived_at FROM three_way_match
  `);

  await knex.raw(`DROP TABLE three_way_match`);
}

export async function down(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS three_way_match (
      id              SERIAL PRIMARY KEY,
      po_number       VARCHAR(100),
      invoice_number  VARCHAR(100),
      grn_number      VARCHAR(100),
      vendor_name     VARCHAR(255),
      po_amount       NUMERIC(18,2),
      invoice_amount  NUMERIC(18,2),
      grn_value       NUMERIC(18,2),
      status          VARCHAR(50),
      resolved_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows } = await knex.raw(`SELECT to_regclass('public.three_way_match_archive') AS t`);
  if (rows[0]?.t) {
    await knex.raw(`
      INSERT INTO three_way_match (id, po_number, invoice_number, grn_number,
                                   vendor_name, po_amount, invoice_amount,
                                   grn_value, status, resolved_at, created_at)
      SELECT id, po_number, invoice_number, grn_number, vendor_name, po_amount,
             invoice_amount, grn_value, status, resolved_at, created_at
      FROM three_way_match_archive
      ON CONFLICT (id) DO NOTHING
    `);
    await knex.raw(`
      SELECT setval('three_way_match_id_seq',
                    GREATEST((SELECT COALESCE(MAX(id), 0) FROM three_way_match), 1))
    `);
  }
}
