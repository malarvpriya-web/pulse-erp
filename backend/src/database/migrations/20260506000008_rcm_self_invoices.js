// backend/src/database/migrations/20260506000008_rcm_self_invoices.js
// Self-invoices required under Section 31(3)(f) CGST Act for RCM purchases
// from unregistered suppliers. The buyer acts as both supplier (output tax) and
// recipient (ITC) and must issue this document to support the ITC claim.

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rcm_self_invoices (
      id                  SERIAL PRIMARY KEY,
      self_invoice_number VARCHAR(50) UNIQUE NOT NULL,
      bill_id             INT REFERENCES bills(id) ON DELETE SET NULL,
      invoice_date        DATE NOT NULL,
      supplier_name       VARCHAR(200),
      supplier_address    TEXT,
      supply_type         VARCHAR(20) DEFAULT 'intrastate' CHECK (supply_type IN ('intrastate','interstate')),
      taxable_value       NUMERIC(15,2) NOT NULL DEFAULT 0,
      gst_rate            NUMERIC(5,2) NOT NULL DEFAULT 18,
      cgst_amount         NUMERIC(15,2) NOT NULL DEFAULT 0,
      sgst_amount         NUMERIC(15,2) NOT NULL DEFAULT 0,
      igst_amount         NUMERIC(15,2) NOT NULL DEFAULT 0,
      total_gst           NUMERIC(15,2) NOT NULL DEFAULT 0,
      total_amount        NUMERIC(15,2) NOT NULL DEFAULT 0,
      journal_entry_id    INT,
      gstr3b_reported     BOOLEAN NOT NULL DEFAULT false,
      notes               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by          INT
    )
  `);

  // Mark bills that have a self-invoice generated
  await knex.raw(`
    ALTER TABLE bills
      ADD COLUMN IF NOT EXISTS rcm_self_invoice_id INT REFERENCES rcm_self_invoices(id) ON DELETE SET NULL
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE bills DROP COLUMN IF EXISTS rcm_self_invoice_id`);
  await knex.raw(`DROP TABLE IF EXISTS rcm_self_invoices`);
}
