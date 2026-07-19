/**
 * CRM Hardening — Phase 100 (score 83→100)
 * 1. accounts.party_id FK → parties(id)            — fixes CRM↔Finance isolation
 * 2. crm_activities.account_id, contact_id columns — fixes "no account_id" bug
 * 3. opportunity_stage_history table               — enables stage audit trail
 * 4. quotation_items: hsn_code, cgst/sgst/igst     — GST compliance
 * 5. sales_order_items: same GST columns
 * 6. opportunities: tender tracking fields          — industrial readiness
 */
export async function up(knex) {
  // ── 1. accounts.party_id FK ──────────────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='accounts')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='parties')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='party_id')
      THEN
        ALTER TABLE accounts ADD COLUMN party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_accounts_party_id ON accounts(party_id);
      END IF;
    END $$;
  `);

  // Backfill — safe skip if columns are missing
  await knex.raw(`
    DO $$ BEGIN
      UPDATE accounts a
      SET party_id = (
        SELECT p.id FROM parties p
        WHERE p.company_id = a.company_id
          AND (
            (a.gstin IS NOT NULL AND a.gstin <> '' AND p.gstin = a.gstin)
            OR LOWER(p.name) = LOWER(COALESCE(a.name, a.account_name))
          )
        ORDER BY (a.gstin IS NOT NULL AND a.gstin <> '' AND p.gstin = a.gstin) DESC
        LIMIT 1
      )
      WHERE a.party_id IS NULL AND a.deleted_at IS NULL;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END $$;
  `);

  // ── 2. crm_activities schema improvements ────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_activities' AND column_name='account_id')
      THEN
        ALTER TABLE crm_activities ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_crm_activities_account_id ON crm_activities(account_id);
      END IF;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_activities' AND column_name='contact_id')
      THEN
        ALTER TABLE crm_activities ADD COLUMN contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_crm_activities_contact_id ON crm_activities(contact_id);
      END IF;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_activities' AND column_name='opportunity_id')
      THEN
        ALTER TABLE crm_activities ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_crm_activities_opportunity_id ON crm_activities(opportunity_id);
      END IF;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_activities' AND column_name='company_id')
      THEN
        ALTER TABLE crm_activities ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_crm_activities_company_id ON crm_activities(company_id);
      END IF;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_activities' AND column_name='subject')
      THEN
        ALTER TABLE crm_activities ADD COLUMN subject TEXT;
      END IF;
    END $$;
  `);

  // ── 3. opportunity_stage_history table ──────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='opportunities') THEN
        CREATE TABLE IF NOT EXISTS opportunity_stage_history (
          id            SERIAL PRIMARY KEY,
          opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
          company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL,
          from_stage    TEXT,
          to_stage      TEXT NOT NULL,
          changed_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
          notes         TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_opp_stage_history_opp ON opportunity_stage_history(opportunity_id);
        CREATE INDEX IF NOT EXISTS idx_opp_stage_history_co  ON opportunity_stage_history(company_id);
      END IF;
    END $$;
  `);

  // ── 4. quotation_items GST columns ──────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='quotation_items')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quotation_items' AND column_name='hsn_code')
      THEN
        ALTER TABLE quotation_items ADD COLUMN hsn_code      VARCHAR(20);
        ALTER TABLE quotation_items ADD COLUMN cgst_rate     NUMERIC(5,2)  DEFAULT 0;
        ALTER TABLE quotation_items ADD COLUMN sgst_rate     NUMERIC(5,2)  DEFAULT 0;
        ALTER TABLE quotation_items ADD COLUMN igst_rate     NUMERIC(5,2)  DEFAULT 0;
        ALTER TABLE quotation_items ADD COLUMN cgst_amount   NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE quotation_items ADD COLUMN sgst_amount   NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE quotation_items ADD COLUMN igst_amount   NUMERIC(15,2) DEFAULT 0;
      END IF;
    END $$;
  `);

  // ── 5. sales_order_items GST columns ────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='sales_order_items')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_order_items' AND column_name='hsn_code')
      THEN
        ALTER TABLE sales_order_items ADD COLUMN hsn_code      VARCHAR(20);
        ALTER TABLE sales_order_items ADD COLUMN cgst_rate     NUMERIC(5,2)  DEFAULT 0;
        ALTER TABLE sales_order_items ADD COLUMN sgst_rate     NUMERIC(5,2)  DEFAULT 0;
        ALTER TABLE sales_order_items ADD COLUMN igst_rate     NUMERIC(5,2)  DEFAULT 0;
        ALTER TABLE sales_order_items ADD COLUMN cgst_amount   NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE sales_order_items ADD COLUMN sgst_amount   NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE sales_order_items ADD COLUMN igst_amount   NUMERIC(15,2) DEFAULT 0;
      END IF;
    END $$;
  `);

  // ── 6. opportunities: tender tracking fields ─────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='opportunities')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='opportunities' AND column_name='tender_number')
      THEN
        ALTER TABLE opportunities ADD COLUMN tender_number       VARCHAR(100);
        ALTER TABLE opportunities ADD COLUMN tender_source       VARCHAR(100);
        ALTER TABLE opportunities ADD COLUMN submission_deadline DATE;
        ALTER TABLE opportunities ADD COLUMN bid_type           VARCHAR(50);
        ALTER TABLE opportunities ADD COLUMN emd_amount         NUMERIC(15,2);
        ALTER TABLE opportunities ADD COLUMN emd_status         VARCHAR(50);
        ALTER TABLE opportunities ADD COLUMN loa_received       BOOLEAN DEFAULT FALSE;
        ALTER TABLE opportunities ADD COLUMN loa_date           DATE;
        ALTER TABLE opportunities ADD COLUMN loa_amount         NUMERIC(15,2);
        ALTER TABLE opportunities ADD COLUMN product_category   VARCHAR(100);
        ALTER TABLE opportunities ADD COLUMN next_step          TEXT;
        ALTER TABLE opportunities ADD COLUMN competitors        TEXT[];
        CREATE INDEX IF NOT EXISTS idx_opp_tender_number ON opportunities(tender_number) WHERE tender_number IS NOT NULL;
      END IF;
    END $$;
  `);

  // ── 7. crm_emails: account_id column ────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_emails')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_emails' AND column_name='account_id')
      THEN
        ALTER TABLE crm_emails ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_crm_emails_account_id ON crm_emails(account_id);
      END IF;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS opportunity_stage_history CASCADE`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='accounts') THEN
        ALTER TABLE accounts DROP COLUMN IF EXISTS party_id;
      END IF;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities') THEN
        ALTER TABLE crm_activities DROP COLUMN IF EXISTS account_id, DROP COLUMN IF EXISTS contact_id, DROP COLUMN IF EXISTS opportunity_id, DROP COLUMN IF EXISTS company_id, DROP COLUMN IF EXISTS subject;
      END IF;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='quotation_items') THEN
        ALTER TABLE quotation_items DROP COLUMN IF EXISTS hsn_code, DROP COLUMN IF EXISTS cgst_rate, DROP COLUMN IF EXISTS sgst_rate, DROP COLUMN IF EXISTS igst_rate, DROP COLUMN IF EXISTS cgst_amount, DROP COLUMN IF EXISTS sgst_amount, DROP COLUMN IF EXISTS igst_amount;
      END IF;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='sales_order_items') THEN
        ALTER TABLE sales_order_items DROP COLUMN IF EXISTS hsn_code, DROP COLUMN IF EXISTS cgst_rate, DROP COLUMN IF EXISTS sgst_rate, DROP COLUMN IF EXISTS igst_rate, DROP COLUMN IF EXISTS cgst_amount, DROP COLUMN IF EXISTS sgst_amount, DROP COLUMN IF EXISTS igst_amount;
      END IF;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='opportunities') THEN
        ALTER TABLE opportunities DROP COLUMN IF EXISTS tender_number, DROP COLUMN IF EXISTS tender_source, DROP COLUMN IF EXISTS submission_deadline, DROP COLUMN IF EXISTS bid_type, DROP COLUMN IF EXISTS emd_amount, DROP COLUMN IF EXISTS emd_status, DROP COLUMN IF EXISTS loa_received, DROP COLUMN IF EXISTS loa_date, DROP COLUMN IF EXISTS loa_amount, DROP COLUMN IF EXISTS product_category, DROP COLUMN IF EXISTS next_step, DROP COLUMN IF EXISTS competitors;
      END IF;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_emails') THEN
        ALTER TABLE crm_emails DROP COLUMN IF EXISTS account_id;
      END IF;
    END $$;
  `);
}
