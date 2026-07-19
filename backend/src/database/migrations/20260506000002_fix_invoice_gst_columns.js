/**
 * 20260506000002_fix_invoice_gst_columns.js
 *
 * Compliance fix — standardizes GST column names on invoices and bills.
 *
 * Problem: invoices was created with (tax_amount) by initDb.js,
 * or with (cgst_amount / sgst_amount / igst_amount) by runMigrations.js,
 * while gst.routes.js queries use (cgst / sgst / igst).  Bills had only
 * gst_amount (no split). Both caused GSTR-1 and GSTR-3B to return zeros.
 *
 * Changes:
 *   invoices — add canonical cgst, sgst, igst, cess, place_of_supply,
 *              supply_type, is_rcm, party_id (INT FK)
 *   bills    — add canonical cgst, sgst, igst, cess, place_of_supply,
 *              supply_type, is_rcm, party_id (INT FK)
 *   Both     — backfill from old column names where data exists
 */

export async function up(knex) {

  // ── invoices ─────────────────────────────────────────────────────────────────

  await knex.raw(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS cgst            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sgst            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS igst            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cess            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(50),
      ADD COLUMN IF NOT EXISTS supply_type     VARCHAR(20)   DEFAULT 'B2B',
      ADD COLUMN IF NOT EXISTS is_rcm          BOOLEAN       DEFAULT false,
      ADD COLUMN IF NOT EXISTS party_id        INTEGER,
      ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ
  `);

  // Backfill cgst/sgst/igst from cgst_amount/sgst_amount/igst_amount if those columns exist
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invoices' AND column_name = 'cgst_amount'
      ) THEN
        UPDATE invoices
        SET cgst = COALESCE(cgst_amount, 0),
            sgst = COALESCE(sgst_amount, 0),
            igst = COALESCE(igst_amount, 0)
        WHERE cgst = 0 AND sgst = 0 AND igst = 0;
      END IF;
    END $$
  `);

  // Backfill party_id from customer_id cast (UUID → INT not possible directly;
  // only set if an integer-style party_id column already present via runMigrations)
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invoices' AND column_name = 'customer_id'
          AND data_type = 'integer'
      ) THEN
        UPDATE invoices SET party_id = customer_id
        WHERE party_id IS NULL AND customer_id IS NOT NULL;
      END IF;
    END $$
  `);

  // ── bills ─────────────────────────────────────────────────────────────────────

  await knex.raw(`
    ALTER TABLE bills
      ADD COLUMN IF NOT EXISTS cgst            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sgst            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS igst            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cess            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(50),
      ADD COLUMN IF NOT EXISTS supply_type     VARCHAR(20)   DEFAULT 'B2B',
      ADD COLUMN IF NOT EXISTS is_rcm          BOOLEAN       DEFAULT false,
      ADD COLUMN IF NOT EXISTS party_id        INTEGER,
      ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ
  `);

  // Backfill: bills previously stored gst_amount (undivided). Assume intra-state
  // split 50/50 as a safe default — accountant can correct inter-state ones.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bills' AND column_name = 'gst_amount'
      ) THEN
        UPDATE bills
        SET cgst = ROUND(COALESCE(gst_amount, 0) / 2, 2),
            sgst = ROUND(COALESCE(gst_amount, 0) / 2, 2)
        WHERE cgst = 0 AND sgst = 0 AND igst = 0
          AND COALESCE(gst_amount, 0) > 0;
      END IF;
    END $$
  `);

  // ── indexes ──────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_invoices_party_id    ON invoices(party_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date ON invoices(invoice_date);
    CREATE INDEX IF NOT EXISTS idx_bills_party_id       ON bills(party_id);
    CREATE INDEX IF NOT EXISTS idx_bills_bill_date      ON bills(bill_date);
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS cgst,
      DROP COLUMN IF EXISTS sgst,
      DROP COLUMN IF EXISTS igst,
      DROP COLUMN IF EXISTS cess,
      DROP COLUMN IF EXISTS place_of_supply,
      DROP COLUMN IF EXISTS supply_type,
      DROP COLUMN IF EXISTS is_rcm,
      DROP COLUMN IF EXISTS party_id,
      DROP COLUMN IF EXISTS deleted_at
  `);
  await knex.raw(`
    ALTER TABLE bills
      DROP COLUMN IF EXISTS cgst,
      DROP COLUMN IF EXISTS sgst,
      DROP COLUMN IF EXISTS igst,
      DROP COLUMN IF EXISTS cess,
      DROP COLUMN IF EXISTS place_of_supply,
      DROP COLUMN IF EXISTS supply_type,
      DROP COLUMN IF EXISTS is_rcm,
      DROP COLUMN IF EXISTS party_id,
      DROP COLUMN IF EXISTS deleted_at
  `);
}
