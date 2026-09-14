/**
 * A real document number series for returns to vendor.
 *
 * `grn.service.createRTV()` minted `RTV-${Date.now()}` — a 13-digit epoch
 * stamp. That is not a document number:
 *   - nobody can read it out, quote it on a debit note or search for it;
 *   - it ignores the numbering prefix the company configures for every other
 *     procurement document;
 *   - two returns raised in the same millisecond collide on
 *     `return_to_vendor_rtv_number_key`, so a concurrent save 500s;
 *   - it sorts by clock rather than by series, so the register cannot be read
 *     in document order.
 *
 * Adds `seq_rtv` (the same mechanism every other procurement number uses) and
 * `procurement_settings.rtv_prefix` so the Numbering card can govern it like
 * the other four.
 *
 * The five existing rows carry seeded 'RTV-11007-SEED10007'-style numbers with
 * no numeric component in the new format's range, so the sequence starts at 1
 * without any risk of colliding with them. They are deliberately left as they
 * are: renumbering issued documents would break any external reference to them.
 */

export async function up(knex) {
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_rtv START WITH 1 INCREMENT BY 1 NO CYCLE`);

  // If a deployment already holds RTVs in the new format, start above them.
  const { rows: [mx] } = await knex.raw(`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(rtv_number, '\\D', '', 'g'), ''))::bigint, 0) AS n
      FROM return_to_vendor
     WHERE rtv_number ~ '^[A-Z]{2,10}[0-9]{4,}$'
  `);
  if (Number(mx.n) > 0) {
    await knex.raw(`SELECT setval('seq_rtv', $1, true)`, [Number(mx.n)]);
  }

  await knex.raw(`ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS rtv_prefix VARCHAR(10) DEFAULT 'RTV'`);
  await knex.raw(`UPDATE procurement_settings SET rtv_prefix = 'RTV' WHERE rtv_prefix IS NULL`);

  console.log(`[20260903000012] seq_rtv created (starting after ${mx.n}); procurement_settings.rtv_prefix added.`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE procurement_settings DROP COLUMN IF EXISTS rtv_prefix`);
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_rtv`);
}
