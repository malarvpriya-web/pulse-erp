/**
 * 20260506000004_hsn_sac_codes.js
 *
 * Compliance fix — adds HSN/SAC codes to invoice_items and inventory_items.
 *
 * GST law requires:
 *   Turnover > ₹1.5 Cr  → 4-digit HSN on every invoice line
 *   Turnover > ₹5 Cr    → 6-digit HSN on every invoice line
 *
 * Also adds item-level GST rate and amount breakup so GSTR-1 Table 12
 * (HSN-wise summary) can be generated correctly.
 */

export async function up(knex) {

  // ── invoice_items ────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE invoice_items
      ADD COLUMN IF NOT EXISTS hsn_code     VARCHAR(8),
      ADD COLUMN IF NOT EXISTS sac_code     VARCHAR(6),
      ADD COLUMN IF NOT EXISTS gst_rate     NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cgst_rate    NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sgst_rate    NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS igst_rate    NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cgst_amount  NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sgst_amount  NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS igst_amount  NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS taxable_value NUMERIC(15,2)
  `);

  // Backfill taxable_value from existing amount column
  await knex.raw(`
    UPDATE invoice_items
    SET taxable_value = COALESCE(amount, quantity * unit_price)
    WHERE taxable_value IS NULL
  `);

  // Backfill gst_rate from tax_rate if it exists
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invoice_items' AND column_name = 'tax_rate'
      ) THEN
        UPDATE invoice_items SET gst_rate = COALESCE(tax_rate, 0) WHERE gst_rate = 0;
      END IF;
    END $$
  `);

  // ── bill_items (purchase side) ───────────────────────────────────────────────
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'bill_items'
      ) THEN
        ALTER TABLE bill_items
          ADD COLUMN IF NOT EXISTS hsn_code     VARCHAR(8),
          ADD COLUMN IF NOT EXISTS sac_code     VARCHAR(6),
          ADD COLUMN IF NOT EXISTS gst_rate     NUMERIC(5,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cgst_rate    NUMERIC(5,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS sgst_rate    NUMERIC(5,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS igst_rate    NUMERIC(5,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cgst_amount  NUMERIC(15,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS sgst_amount  NUMERIC(15,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS igst_amount  NUMERIC(15,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS taxable_value NUMERIC(15,2),
          ADD COLUMN IF NOT EXISTS itc_eligible  BOOLEAN DEFAULT true;
      END IF;
    END $$
  `);

  // ── inventory_items (item master HSN) ────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS hsn_code        VARCHAR(8),
      ADD COLUMN IF NOT EXISTS sac_code        VARCHAR(6),
      ADD COLUMN IF NOT EXISTS default_gst_rate NUMERIC(5,2) DEFAULT 18
  `);

  // ── index for HSN-wise summary report ────────────────────────────────────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_invoice_items_hsn ON invoice_items(hsn_code) WHERE hsn_code IS NOT NULL;
  `);
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'bill_items'
      ) THEN
        CREATE INDEX IF NOT EXISTS idx_bill_items_hsn ON bill_items(hsn_code) WHERE hsn_code IS NOT NULL;
      END IF;
    END $$
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE invoice_items
      DROP COLUMN IF EXISTS hsn_code,
      DROP COLUMN IF EXISTS sac_code,
      DROP COLUMN IF EXISTS gst_rate,
      DROP COLUMN IF EXISTS cgst_rate,
      DROP COLUMN IF EXISTS sgst_rate,
      DROP COLUMN IF EXISTS igst_rate,
      DROP COLUMN IF EXISTS cgst_amount,
      DROP COLUMN IF EXISTS sgst_amount,
      DROP COLUMN IF EXISTS igst_amount,
      DROP COLUMN IF EXISTS taxable_value
  `);
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP COLUMN IF EXISTS hsn_code,
      DROP COLUMN IF EXISTS sac_code,
      DROP COLUMN IF EXISTS default_gst_rate
  `);
}
