/**
 * Migration: Procurement Module Hardening
 * - company_id on goods_receipt_notes
 * - Return-to-Vendor (RTV) tables
 * - Approved Vendor List (AVL) table
 * - Quality Inspection tables
 * - NCR (Non-Conformance Report) table
 * - Extra vendor fields (gstin, pan, lead_time_days, credit_limit, bank details)
 * - Multi-currency PO support columns
 * - procurement_settings extra fields
 */

export async function up(knex) {
  const safe = async (label, fn) => {
    const sp = `sp_${label.replace(/\W/g, '_')}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await fn();
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[migration] skipped (${label}): ${e.message}`);
    } finally {
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    }
  };

  // ── company_id on GRN ─────────────────────────────────────────────────────
  await safe('grn_company_id', () =>
    knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN company_id INTEGER REFERENCES companies(id)`)
  );
  await safe('grn_company_id_idx', () =>
    knex.raw(`CREATE INDEX IF NOT EXISTS idx_grn_company_id ON goods_receipt_notes(company_id)`)
  );
  await safe('grn_status_col', () =>
    knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN status VARCHAR(20) DEFAULT 'completed'`)
  );

  // ── Extra vendor fields ───────────────────────────────────────────────────
  await safe('vendor_gstin', () => knex.raw(`ALTER TABLE vendors ADD COLUMN gstin VARCHAR(20)`));
  await safe('vendor_pan', () => knex.raw(`ALTER TABLE vendors ADD COLUMN pan VARCHAR(15)`));
  await safe('vendor_bank_name', () => knex.raw(`ALTER TABLE vendors ADD COLUMN bank_name VARCHAR(100)`));
  await safe('vendor_account_number', () => knex.raw(`ALTER TABLE vendors ADD COLUMN account_number VARCHAR(30)`));
  await safe('vendor_ifsc', () => knex.raw(`ALTER TABLE vendors ADD COLUMN ifsc VARCHAR(15)`));
  await safe('vendor_lead_time_days', () => knex.raw(`ALTER TABLE vendors ADD COLUMN lead_time_days INTEGER DEFAULT 14`));
  await safe('vendor_credit_limit', () => knex.raw(`ALTER TABLE vendors ADD COLUMN credit_limit NUMERIC(15,2) DEFAULT 0`));
  await safe('vendor_payment_terms_days', () => knex.raw(`ALTER TABLE vendors ADD COLUMN payment_terms_days INTEGER DEFAULT 30`));
  await safe('vendor_on_time_pct', () => knex.raw(`ALTER TABLE vendors ADD COLUMN on_time_pct NUMERIC(5,2) DEFAULT 0`));
  await safe('vendor_defect_rate', () => knex.raw(`ALTER TABLE vendors ADD COLUMN defect_rate NUMERIC(5,2) DEFAULT 0`));

  // ── Multi-currency PO support ─────────────────────────────────────────────
  await safe('po_currency', () => knex.raw(`ALTER TABLE purchase_orders ADD COLUMN currency VARCHAR(3) DEFAULT 'INR'`));
  await safe('po_exchange_rate', () => knex.raw(`ALTER TABLE purchase_orders ADD COLUMN exchange_rate NUMERIC(10,4) DEFAULT 1`));
  await safe('po_amount_inr', () => knex.raw(`ALTER TABLE purchase_orders ADD COLUMN total_amount_inr NUMERIC(15,2)`));
  await safe('po_incoterm', () => knex.raw(`ALTER TABLE purchase_orders ADD COLUMN incoterm VARCHAR(10)`));
  await safe('po_freight', () => knex.raw(`ALTER TABLE purchase_orders ADD COLUMN freight_amount NUMERIC(15,2) DEFAULT 0`));
  await safe('po_customs_duty', () => knex.raw(`ALTER TABLE purchase_orders ADD COLUMN customs_duty NUMERIC(15,2) DEFAULT 0`));

  // ── Purchase Request: multi-line items ────────────────────────────────────
  await safe('pr_items_table', () =>
    knex.raw(`CREATE TABLE IF NOT EXISTS purchase_request_items (
      id SERIAL PRIMARY KEY,
      pr_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES inventory_items(id),
      item_description TEXT,
      quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
      unit VARCHAR(20) DEFAULT 'Nos',
      estimated_rate NUMERIC(15,2) DEFAULT 0,
      total_amount NUMERIC(15,2) GENERATED ALWAYS AS (quantity * estimated_rate) STORED,
      required_date DATE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
  );
  await safe('pr_items_idx', () =>
    knex.raw(`CREATE INDEX IF NOT EXISTS idx_pri_pr_id ON purchase_request_items(pr_id)`)
  );

  // ── Approved Vendor List (AVL) ────────────────────────────────────────────
  await safe('avl_table', () =>
    knex.raw(`CREATE TABLE IF NOT EXISTS approved_vendor_list (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      item_id INTEGER REFERENCES inventory_items(id),
      vendor_id INTEGER REFERENCES vendors(id),
      status VARCHAR(20) DEFAULT 'approved' CHECK (status IN ('approved','blocked','expired','pending')),
      approved_by_name VARCHAR(100),
      approved_date DATE,
      valid_from DATE,
      valid_to DATE,
      lead_time_days INTEGER,
      min_order_qty NUMERIC(10,2),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (company_id, item_id, vendor_id)
    )`)
  );
  await safe('avl_idx', () =>
    knex.raw(`CREATE INDEX IF NOT EXISTS idx_avl_item ON approved_vendor_list(item_id, company_id)`)
  );

  // ── Return to Vendor (RTV) ────────────────────────────────────────────────
  await safe('rtv_table', () =>
    knex.raw(`CREATE TABLE IF NOT EXISTS return_to_vendor (
      id SERIAL PRIMARY KEY,
      rtv_number VARCHAR(50) UNIQUE NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      grn_id INTEGER REFERENCES goods_receipt_notes(id),
      vendor_id INTEGER REFERENCES vendors(id),
      return_date DATE NOT NULL DEFAULT CURRENT_DATE,
      reason TEXT,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','dispatched','credited','closed')),
      created_by INTEGER,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
  );
  await safe('rtv_items_table', () =>
    knex.raw(`CREATE TABLE IF NOT EXISTS rtv_items (
      id SERIAL PRIMARY KEY,
      rtv_id INTEGER NOT NULL REFERENCES return_to_vendor(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES inventory_items(id),
      quantity_returned NUMERIC(10,2) NOT NULL,
      rate NUMERIC(15,2) DEFAULT 0,
      remarks TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
  );

  // ── Quality Inspection ────────────────────────────────────────────────────
  await safe('qi_table', () =>
    knex.raw(`CREATE TABLE IF NOT EXISTS quality_inspections (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      grn_id INTEGER REFERENCES goods_receipt_notes(id),
      inspector_id INTEGER,
      inspection_date DATE NOT NULL DEFAULT CURRENT_DATE,
      overall_result VARCHAR(20) DEFAULT 'pass' CHECK (overall_result IN ('pass','fail','conditional')),
      status VARCHAR(20) DEFAULT 'completed',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
  );
  await safe('qi_items_table', () =>
    knex.raw(`CREATE TABLE IF NOT EXISTS quality_inspection_items (
      id SERIAL PRIMARY KEY,
      inspection_id INTEGER NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES inventory_items(id),
      parameter VARCHAR(100),
      expected_value VARCHAR(100),
      actual_value VARCHAR(100),
      result VARCHAR(20) DEFAULT 'pass' CHECK (result IN ('pass','fail','na')),
      remarks TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
  );

  // ── Non-Conformance Report (NCR) ──────────────────────────────────────────
  await safe('ncr_table', () =>
    knex.raw(`CREATE TABLE IF NOT EXISTS non_conformance_reports (
      id SERIAL PRIMARY KEY,
      ncr_number VARCHAR(50) UNIQUE NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      grn_id INTEGER REFERENCES goods_receipt_notes(id),
      vendor_id INTEGER REFERENCES vendors(id),
      defect_description TEXT NOT NULL,
      quantity_affected NUMERIC(10,2) DEFAULT 1,
      severity VARCHAR(20) DEFAULT 'minor' CHECK (severity IN ('minor','major','critical')),
      disposition VARCHAR(30) DEFAULT 'return' CHECK (disposition IN ('return','rework','use_as_is','scrap')),
      status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','closed','waived')),
      capa_action TEXT,
      capa_due_date DATE,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
  );

  // ── Procurement Settings: extra fields ───────────────────────────────────
  await safe('proc_settings_quality', () =>
    knex.raw(`ALTER TABLE procurement_settings ADD COLUMN require_quality_inspection BOOLEAN DEFAULT false`)
  );
  await safe('proc_settings_avl', () =>
    knex.raw(`ALTER TABLE procurement_settings ADD COLUMN enforce_avl BOOLEAN DEFAULT false`)
  );
  await safe('proc_settings_rtv', () =>
    knex.raw(`ALTER TABLE procurement_settings ADD COLUMN auto_ncr_on_rejection BOOLEAN DEFAULT false`)
  );
  await safe('proc_settings_currency', () =>
    knex.raw(`ALTER TABLE procurement_settings ADD COLUMN default_currency VARCHAR(3) DEFAULT 'INR'`)
  );
  await safe('proc_settings_vendor_cats', () =>
    knex.raw(`ALTER TABLE procurement_settings ADD COLUMN vendor_categories TEXT DEFAULT '["Raw Materials","Electronic Components (Active)","Electronic Components (Passive)","IGBT/Power Modules","PCB Manufacturers","Magnetics","Contract Manufacturers","IT","Services","Logistics"]'`)
  );

  // ── Performance indexes ───────────────────────────────────────────────────
  await safe('idx_rtv_company', () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_rtv_company ON return_to_vendor(company_id)`));
  await safe('idx_ncr_company', () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_company ON non_conformance_reports(company_id)`));
  await safe('idx_qi_grn', () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_qi_grn ON quality_inspections(grn_id)`));
}

export async function down(knex) {
  // Intentionally minimal — additive migrations are safer to not auto-rollback
  await knex.raw(`DROP TABLE IF EXISTS non_conformance_reports CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS quality_inspection_items CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS quality_inspections CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS rtv_items CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS return_to_vendor CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS approved_vendor_list CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS purchase_request_items CASCADE`);
}
