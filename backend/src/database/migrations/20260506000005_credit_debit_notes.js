/**
 * 20260506000005_credit_debit_notes.js
 *
 * Compliance fix — creates credit_notes and debit_notes tables.
 *
 * Required for:
 *   - Sales returns / price revisions / post-sale discounts
 *   - GSTR-1 Table 9 (CDNR) and Table 10 (CDNUR)
 *   - Purchase returns (debit notes → supplier)
 *   - ITC reversal on purchase returns
 */

export async function up(knex) {

  // ── credit_notes (issued to customers — reduces sales tax liability) ──────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS credit_notes (
      id                   SERIAL PRIMARY KEY,
      credit_note_number   VARCHAR(50)  UNIQUE NOT NULL,
      original_invoice_id  INTEGER      REFERENCES invoices(id) ON DELETE SET NULL,
      party_id             INTEGER,
      party_name           VARCHAR(255),
      party_gstin          VARCHAR(15),
      credit_note_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
      reason               VARCHAR(100) NOT NULL
                             CHECK (reason IN ('sales_return','price_revision','deficiency_of_service','post_sale_discount','other')),
      supply_type          VARCHAR(20)  DEFAULT 'B2B',
      taxable_value        NUMERIC(15,2) NOT NULL DEFAULT 0,
      cgst                 NUMERIC(15,2) DEFAULT 0,
      sgst                 NUMERIC(15,2) DEFAULT 0,
      igst                 NUMERIC(15,2) DEFAULT 0,
      cess                 NUMERIC(15,2) DEFAULT 0,
      total_amount         NUMERIC(15,2) NOT NULL DEFAULT 0,
      status               VARCHAR(20)  DEFAULT 'draft'
                             CHECK (status IN ('draft','issued','cancelled')),
      gstr1_filed          BOOLEAN      DEFAULT FALSE,
      journal_entry_id     INTEGER,
      notes                TEXT,
      created_by           INTEGER,
      created_at           TIMESTAMPTZ  DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  DEFAULT NOW(),
      deleted_at           TIMESTAMPTZ
    )
  `);

  // ── credit_note_items ──────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS credit_note_items (
      id               SERIAL PRIMARY KEY,
      credit_note_id   INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
      original_item_id INTEGER,
      description      TEXT,
      hsn_code         VARCHAR(8),
      quantity         NUMERIC(10,2) DEFAULT 1,
      unit_price       NUMERIC(15,2) DEFAULT 0,
      taxable_value    NUMERIC(15,2) DEFAULT 0,
      gst_rate         NUMERIC(5,2)  DEFAULT 0,
      cgst_amount      NUMERIC(15,2) DEFAULT 0,
      sgst_amount      NUMERIC(15,2) DEFAULT 0,
      igst_amount      NUMERIC(15,2) DEFAULT 0,
      created_at       TIMESTAMPTZ   DEFAULT NOW()
    )
  `);

  // ── debit_notes (issued to suppliers — for purchase returns) ─────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS debit_notes (
      id                  SERIAL PRIMARY KEY,
      debit_note_number   VARCHAR(50)  UNIQUE NOT NULL,
      original_bill_id    INTEGER      REFERENCES bills(id) ON DELETE SET NULL,
      party_id            INTEGER,
      party_name          VARCHAR(255),
      party_gstin         VARCHAR(15),
      debit_note_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
      reason              VARCHAR(100) NOT NULL
                            CHECK (reason IN ('purchase_return','price_revision','short_supply','quality_rejection','other')),
      taxable_value       NUMERIC(15,2) NOT NULL DEFAULT 0,
      cgst                NUMERIC(15,2) DEFAULT 0,
      sgst                NUMERIC(15,2) DEFAULT 0,
      igst                NUMERIC(15,2) DEFAULT 0,
      cess                NUMERIC(15,2) DEFAULT 0,
      total_amount        NUMERIC(15,2) NOT NULL DEFAULT 0,
      itc_reversal        BOOLEAN      DEFAULT TRUE,
      status              VARCHAR(20)  DEFAULT 'draft'
                            CHECK (status IN ('draft','issued','cancelled')),
      journal_entry_id    INTEGER,
      notes               TEXT,
      created_by          INTEGER,
      created_at          TIMESTAMPTZ  DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  DEFAULT NOW(),
      deleted_at          TIMESTAMPTZ
    )
  `);

  // ── indexes ──────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_cn_party_id    ON credit_notes(party_id);
    CREATE INDEX IF NOT EXISTS idx_cn_date        ON credit_notes(credit_note_date);
    CREATE INDEX IF NOT EXISTS idx_cn_gstr1_filed ON credit_notes(gstr1_filed);
    CREATE INDEX IF NOT EXISTS idx_dn_party_id    ON debit_notes(party_id);
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS credit_note_items CASCADE');
  await knex.raw('DROP TABLE IF EXISTS credit_notes CASCADE');
  await knex.raw('DROP TABLE IF EXISTS debit_notes CASCADE');
}
