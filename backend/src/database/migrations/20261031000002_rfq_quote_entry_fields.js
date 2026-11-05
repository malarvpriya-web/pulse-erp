/**
 * 20261031000002 — the fields the RFQ quote-entry dialog needs that rfq_quotes
 * did not hold. See MODULE_FEATURE_CONNECTION_MANUAL.md §219.
 *
 *   freight_per_unit     vendor-quoted freight per unit (the engine's existing
 *                        "quoted per unit" slot). Mutually exclusive with
 *                        freight_amount — a quote states one or the other.
 *   freight_currency     the currency the vendor quoted FREIGHT in, when it is not
 *                        the quote's own currency. Values are stored as entered;
 *                        conversion happens at comparison time with an approved
 *                        Finance rate (§215), never here.
 *   shipping_weight_uom  the unit the quoted weight per unit is per (kg per NOS,
 *                        kg per MTR). Required whenever a quoted weight is given.
 *   vendor_quote_ref     the vendor's own quotation number.
 *   quote_date           the date on the vendor's quotation.
 *
 * All nullable, no defaults, no backfill: the live quotes keep exactly what
 * they hold. Both new CHECKs hold for every live row (verified: no live quote
 * carries freight_amount or a quoted weight).
 * Rollback refuses while any of the five columns holds data.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE rfq_quotes
      ADD COLUMN IF NOT EXISTS freight_per_unit    NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS freight_currency    VARCHAR(3),
      ADD COLUMN IF NOT EXISTS shipping_weight_uom VARCHAR(20),
      ADD COLUMN IF NOT EXISTS vendor_quote_ref    VARCHAR(80),
      ADD COLUMN IF NOT EXISTS quote_date          DATE
  `);
  const check = (name, def) => knex.raw(`
    DO $$ BEGIN
      ALTER TABLE rfq_quotes ADD CONSTRAINT ${name} CHECK (${def});
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
  await check('rfq_quotes_freight_one_basis_chk', `freight_amount IS NULL OR freight_per_unit IS NULL`);
  await check('rfq_quotes_freight_per_unit_chk', `freight_per_unit IS NULL OR freight_per_unit >= 0`);
  await check('rfq_quotes_freight_currency_chk', `freight_currency IS NULL OR freight_currency ~ '^[A-Z]{3}$'`);
  await check('rfq_quotes_weight_uom_chk',
    `shipping_weight_kg_per_unit IS NULL OR (shipping_weight_uom IS NOT NULL AND btrim(shipping_weight_uom) <> '')`);
}

export async function down(knex) {
  const { rows: [r] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM rfq_quotes
     WHERE freight_per_unit IS NOT NULL OR freight_currency IS NOT NULL OR shipping_weight_uom IS NOT NULL
        OR vendor_quote_ref IS NOT NULL OR quote_date IS NOT NULL`);
  if (r.n > 0) throw new Error(`${r.n} quote(s) hold quote-entry data (freight per unit / freight currency / weight UOM / quote reference / quote date); export and clear it deliberately before rolling back.`);
  for (const c of ['rfq_quotes_freight_one_basis_chk', 'rfq_quotes_freight_per_unit_chk',
                   'rfq_quotes_freight_currency_chk', 'rfq_quotes_weight_uom_chk']) {
    await knex.raw(`ALTER TABLE rfq_quotes DROP CONSTRAINT IF EXISTS ${c}`);
  }
  await knex.raw(`ALTER TABLE rfq_quotes
    DROP COLUMN IF EXISTS freight_per_unit, DROP COLUMN IF EXISTS freight_currency,
    DROP COLUMN IF EXISTS shipping_weight_uom, DROP COLUMN IF EXISTS vendor_quote_ref,
    DROP COLUMN IF EXISTS quote_date`);
}
