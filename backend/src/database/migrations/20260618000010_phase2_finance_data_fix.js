/**
 * 20260618000010_phase2_finance_data_fix.js
 *
 * Phase 2 Finance Data Layer fixes:
 *   A - bank_accounts: add missing columns (account_number_last4, opening_date,
 *       last_reconciled_at, is_primary, od_limit, swift_code, micr_code, company_id)
 *   B - Party backfill: create party records from invoice customer names and
 *       supplier_bill supplier names, then link invoices/bills back to parties
 *   C - debit_notes: alter to full schema needed by debitNotes.routes.js
 *       (adds party_id, party_name, party_gstin, debit_note_date, taxable_value,
 *        cgst, sgst, igst, cess, total_amount, journal_entry_id, created_by,
 *        company_id, deleted_at); creates debit_note_items
 *   D - fixed_assets: backfill company_id where null to the first active company
 *
 * Every ALTER uses SAVEPOINT so existing columns never abort the transaction.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (label, sql) => {
    const name = `sp_p2_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = err.message || '';
      if (!/already exists|does not exist|duplicate column|multiple primary|duplicate key/i.test(msg)) throw err;
      console.warn(`[phase2_finance] skip (${label}): ${msg.split('\n')[0]}`);
    }
  };

  // ══════════════════════════════════════════════════════
  // A — bank_accounts missing columns
  // ══════════════════════════════════════════════════════
  await safe('bank_accounts add account_number_last4',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number_last4 VARCHAR(4)`);
  await safe('bank_accounts add opening_date',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS opening_date DATE`);
  await safe('bank_accounts add last_reconciled_at',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMP`);
  await safe('bank_accounts add is_primary',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false`);
  await safe('bank_accounts add od_limit',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS od_limit NUMERIC(15,2)`);
  await safe('bank_accounts add swift_code',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS swift_code VARCHAR(20)`);
  await safe('bank_accounts add micr_code',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS micr_code VARCHAR(20)`);
  await safe('bank_accounts add company_id',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);

  // Backfill last4 from existing account_number values
  await safe('bank_accounts backfill last4', `
    UPDATE bank_accounts
    SET account_number_last4 = RIGHT(REGEXP_REPLACE(account_number, '\\D', '', 'g'), 4)
    WHERE account_number_last4 IS NULL
      AND account_number IS NOT NULL
      AND account_number != ''
  `);

  await safe('idx bank_accounts company_id',
    `CREATE INDEX IF NOT EXISTS idx_bank_accounts_company_id ON bank_accounts(company_id)`);

  // ══════════════════════════════════════════════════════
  // B — Party backfill from invoices
  // ══════════════════════════════════════════════════════

  // Step 1: Insert customer party records from invoices (unique by company+name)
  await safe('parties backfill from invoices', `
    INSERT INTO parties (company_id, party_type, name, email, phone, gstin, party_code, created_at)
    SELECT DISTINCT ON (i.company_id, LOWER(TRIM(i.customer_name)))
      i.company_id,
      'Customer'                                                    AS party_type,
      TRIM(i.customer_name)                                         AS name,
      i.customer_email                                              AS email,
      i.customer_phone                                              AS phone,
      i.customer_gstin                                              AS gstin,
      'CUST-' || LPAD(
        ROW_NUMBER() OVER (
          PARTITION BY i.company_id
          ORDER BY LOWER(TRIM(i.customer_name))
        )::TEXT, 4, '0')                                           AS party_code,
      NOW()                                                         AS created_at
    FROM invoices i
    WHERE i.customer_name IS NOT NULL
      AND TRIM(i.customer_name) != ''
      AND i.deleted_at IS NULL
    ON CONFLICT DO NOTHING
  `);

  // Step 2: Link invoices.party_id where still null
  await safe('invoices link party_id', `
    UPDATE invoices i
    SET party_id = p.id
    FROM parties p
    WHERE LOWER(TRIM(i.customer_name)) = LOWER(p.name)
      AND LOWER(p.party_type) = 'customer'
      AND (i.company_id = p.company_id OR (i.company_id IS NULL AND p.company_id IS NULL))
      AND i.party_id IS NULL
      AND i.deleted_at IS NULL
  `);

  // Step 3: Backfill suppliers from supplier_bills (if table exists)
  await safe('parties backfill from supplier_bills', `
    INSERT INTO parties (company_id, party_type, name, gstin, party_code, created_at)
    SELECT DISTINCT ON (sb.company_id, LOWER(TRIM(sb.supplier_name)))
      sb.company_id,
      'Supplier'                                                    AS party_type,
      TRIM(sb.supplier_name)                                        AS name,
      sb.supplier_gstin                                             AS gstin,
      'SUPP-' || LPAD(
        ROW_NUMBER() OVER (
          PARTITION BY sb.company_id
          ORDER BY LOWER(TRIM(sb.supplier_name))
        )::TEXT, 4, '0')                                           AS party_code,
      NOW()                                                         AS created_at
    FROM supplier_bills sb
    WHERE sb.supplier_name IS NOT NULL
      AND TRIM(sb.supplier_name) != ''
    ON CONFLICT DO NOTHING
  `);

  await safe('supplier_bills link party_id', `
    UPDATE supplier_bills sb
    SET party_id = p.id
    FROM parties p
    WHERE LOWER(TRIM(sb.supplier_name)) = LOWER(p.name)
      AND LOWER(p.party_type) = 'supplier'
      AND (sb.company_id = p.company_id OR (sb.company_id IS NULL AND p.company_id IS NULL))
      AND sb.party_id IS NULL
  `);

  // ══════════════════════════════════════════════════════
  // C — debit_notes full schema
  // ══════════════════════════════════════════════════════

  // Add columns that the new debitNotes.routes.js expects
  await safe('debit_notes add original_bill_id',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS original_bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL`);
  await safe('debit_notes add party_id',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL`);
  await safe('debit_notes add party_name',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS party_name VARCHAR(255)`);
  await safe('debit_notes add party_gstin',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS party_gstin VARCHAR(20)`);
  await safe('debit_notes add debit_note_date',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS debit_note_date DATE`);
  await safe('debit_notes add reason col',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS reason TEXT`);
  await safe('debit_notes add taxable_value',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS taxable_value NUMERIC(15,2) DEFAULT 0`);
  await safe('debit_notes add cgst',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS cgst NUMERIC(15,2) DEFAULT 0`);
  await safe('debit_notes add sgst',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS sgst NUMERIC(15,2) DEFAULT 0`);
  await safe('debit_notes add igst',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS igst NUMERIC(15,2) DEFAULT 0`);
  await safe('debit_notes add cess',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS cess NUMERIC(15,2) DEFAULT 0`);
  await safe('debit_notes add total_amount',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS total_amount NUMERIC(15,2) DEFAULT 0`);
  await safe('debit_notes add notes',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safe('debit_notes add journal_entry_id',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS journal_entry_id INTEGER`);
  await safe('debit_notes add created_by',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS created_by INTEGER`);
  await safe('debit_notes add company_id',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);
  await safe('debit_notes add deleted_at',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
  await safe('debit_notes add updated_at',
    `ALTER TABLE debit_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);

  // Drop NOT NULL from legacy required columns so new inserts (which omit them) succeed
  await safe('debit_notes drop not null supplier',
    `ALTER TABLE debit_notes ALTER COLUMN supplier DROP NOT NULL`);
  await safe('debit_notes drop not null date',
    `ALTER TABLE debit_notes ALTER COLUMN date DROP NOT NULL`);
  await safe('debit_notes drop not null amount',
    `ALTER TABLE debit_notes ALTER COLUMN amount DROP NOT NULL`);

  // Normalise status to lowercase for existing rows
  await safe('debit_notes normalise status', `
    UPDATE debit_notes SET status = LOWER(status)
    WHERE status ~ '[A-Z]'
  `);

  // Backfill debit_note_date from old 'date' column if it exists
  await safe('debit_notes backfill debit_note_date', `
    UPDATE debit_notes
    SET debit_note_date = date::date
    WHERE debit_note_date IS NULL
      AND date IS NOT NULL
  `);

  // debit_note_items table
  await safe('create debit_note_items', `
    CREATE TABLE IF NOT EXISTS debit_note_items (
      id                 SERIAL PRIMARY KEY,
      debit_note_id      INTEGER NOT NULL REFERENCES debit_notes(id) ON DELETE CASCADE,
      original_item_id   INTEGER,
      description        TEXT,
      hsn_code           VARCHAR(20),
      quantity           NUMERIC(12,3) DEFAULT 1,
      unit_price         NUMERIC(15,2) DEFAULT 0,
      taxable_value      NUMERIC(15,2) DEFAULT 0,
      gst_rate           NUMERIC(6,2)  DEFAULT 0,
      cgst_amount        NUMERIC(15,2) DEFAULT 0,
      sgst_amount        NUMERIC(15,2) DEFAULT 0,
      igst_amount        NUMERIC(15,2) DEFAULT 0,
      created_at         TIMESTAMP DEFAULT NOW()
    )
  `);

  await safe('idx debit_notes company_deleted',
    `CREATE INDEX IF NOT EXISTS idx_debit_notes_company_deleted ON debit_notes(company_id, deleted_at)`);
  await safe('idx debit_note_items note_id',
    `CREATE INDEX IF NOT EXISTS idx_debit_note_items_note_id ON debit_note_items(debit_note_id)`);

  // ══════════════════════════════════════════════════════
  // D — fixed_assets: backfill company_id where null
  // ══════════════════════════════════════════════════════
  await safe('fixed_assets backfill company_id', `
    UPDATE fixed_assets fa
    SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1)
    WHERE fa.company_id IS NULL
      AND EXISTS (SELECT 1 FROM companies LIMIT 1)
  `);
}

export async function down(knex) {
  // Non-destructive — we do not drop columns on rollback
}
