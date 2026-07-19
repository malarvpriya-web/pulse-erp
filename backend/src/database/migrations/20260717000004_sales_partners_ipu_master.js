/**
 * 20260717000004_sales_partners_ipu_master.js
 *
 * Turns `sales_partners` into a real Partner master (IPU) and gives it the
 * partner -> lead relationship the "View Leads" action needs.
 *
 * WHY THIS EXISTS AT ALL — sales_partners had no migration. It was created by a
 * fire-and-forget `CREATE TABLE IF NOT EXISTS` IIFE at the top level of
 * sales.routes.js, whose errors were swallowed into console.error. A SECOND and
 * conflicting definition sat in database/crm-sales-advanced-schema.sql with a
 * UUID pk and different column names (partner_name/partner_type/commission_rate).
 * The live table was the IIFE's (id:integer, name, type) — the .sql file has
 * never run. That file is now stale for this table; this migration is the source
 * of truth and the IIFE is deleted in the same change.
 *
 * SAFE TO RESHAPE: sales_partners held 0 rows at the time of writing, so the
 * `type` -> `association_type` rename needs no value migration. The guards below
 * are still written to be re-runnable.
 *
 * ASSOCIATION TYPES are 'System Integrator' and 'Partner', confirmed with the
 * business 2026-07-17. This settles a three-way disagreement: the UI offered
 * reseller/referral/distributor/technology, the dead .sql file's comment said
 * "Reseller, Distributor, Referral, SI", and accounts.account_type carries a
 * separate Capitalized 'Partner'. Not a DB CHECK constraint, mirroring
 * shared/projectTypes.js and migration 20260717000001 — the list is validated in
 * the route layer against shared/salesPartners.js so widening it later is not a
 * migration.
 *
 * GSTIN is deliberately NOT constrained to Karnataka ('29'). Partners can be
 * based in any state; the format+state-code check lives in the route layer
 * (utils/gst.js) and the State column is derived from the prefix, so a Karnataka
 * partner validates as '29' by consequence rather than by a rule that would
 * reject everyone else.
 *
 * company_id becomes NOT NULL DEFAULT 1. Nullable company_id is the documented
 * scoping bug in this codebase: NULL rows are invisible to scoped users and read
 * as 0 in KPIs. The table is empty, so this costs no backfill.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_ipu_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[sales_partners_ipu_master] skipped (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── 0. the table, if the route-level IIFE never got to run ──────────────────
  // Matches the shape the IIFE produced, so an existing install and a fresh one
  // converge on the same starting point before the ALTERs below.
  await safe('create_base', `
    CREATE TABLE IF NOT EXISTS sales_partners (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      name            TEXT NOT NULL,
      type            TEXT DEFAULT 'reseller',
      contact_name    TEXT,
      email           TEXT,
      phone           TEXT,
      region          TEXT,
      commission_pct  NUMERIC(5,2) DEFAULT 0,
      status          TEXT DEFAULT 'active',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 1. IPU numbering ────────────────────────────────────────────────────────
  // Fresh sequence — no IPU-prefixed number has ever been issued (verified: no
  // seq_ipu existed, and no column held one). Format IPU-00001, matching
  // seq_ips/IPS-00001 and seq_ipd/IPD-00001.
  await safe('seq_ipu', `CREATE SEQUENCE IF NOT EXISTS seq_ipu START WITH 1 INCREMENT BY 1 NO CYCLE`);

  // ── 2. identity + address + tax columns ─────────────────────────────────────
  await safe('add_columns', `
    ALTER TABLE sales_partners
      ADD COLUMN IF NOT EXISTS ipu_number  VARCHAR(20),
      ADD COLUMN IF NOT EXISTS website     VARCHAR(255),
      ADD COLUMN IF NOT EXISTS city        VARCHAR(120),
      ADD COLUMN IF NOT EXISTS state       VARCHAR(120),
      ADD COLUMN IF NOT EXISTS country     VARCHAR(120) DEFAULT 'India',
      ADD COLUMN IF NOT EXISTS gstin       VARCHAR(15),
      ADD COLUMN IF NOT EXISTS address     TEXT,
      ADD COLUMN IF NOT EXISTS notes       TEXT,
      ADD COLUMN IF NOT EXISTS created_by  INTEGER,
      ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ
  `);

  // IPU numbers are never reissued, so uniqueness is unconditional rather than
  // partial on deleted_at.
  await safe('uq_ipu_number', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_partners_ipu_number
      ON sales_partners(ipu_number) WHERE ipu_number IS NOT NULL
  `);

  // ── 3. type -> association_type ─────────────────────────────────────────────
  // A GUARDED rename, not add+drop: if `type` is still there, carry the column
  // (and any rows a later install picked up) across rather than dropping data.
  await safe('rename_type', `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='sales_partners'
                    AND column_name='type')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='sales_partners'
                    AND column_name='association_type')
      THEN
        ALTER TABLE sales_partners RENAME COLUMN type TO association_type;
      END IF;
    END $$;
  `);
  await safe('add_association_type', `
    ALTER TABLE sales_partners ADD COLUMN IF NOT EXISTS association_type VARCHAR(40)
  `);
  // The old default was 'reseller', which is no longer a valid value. Any row
  // that somehow predates this lands on 'Partner', the generic member of the new
  // list, rather than an unfilterable orphan value.
  await safe('retype_association_type', `
    ALTER TABLE sales_partners
      ALTER COLUMN association_type TYPE VARCHAR(40),
      ALTER COLUMN association_type SET DEFAULT 'Partner'
  `);
  await safe('backfill_association_type', `
    UPDATE sales_partners
       SET association_type = 'Partner'
     WHERE association_type IS NULL
        OR association_type NOT IN ('System Integrator', 'Partner')
  `);

  // ── 4. GSTIN uniqueness ─────────────────────────────────────────────────────
  // Scoped to the company, not global: a GSTIN identifies one entity in India,
  // but two tenants may each legitimately hold a record for the same partner.
  // Partial on deleted_at so an archived partner does not block re-registration.
  await safe('uq_gstin', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_partners_gstin
      ON sales_partners(company_id, UPPER(gstin))
      WHERE gstin IS NOT NULL AND gstin <> '' AND deleted_at IS NULL
  `);

  // ── 5. company scoping ──────────────────────────────────────────────────────
  await safe('backfill_company', `UPDATE sales_partners SET company_id = 1 WHERE company_id IS NULL`);
  await safe('company_not_null', `
    ALTER TABLE sales_partners
      ALTER COLUMN company_id SET DEFAULT 1,
      ALTER COLUMN company_id SET NOT NULL
  `);

  // ── 6. partner -> lead ──────────────────────────────────────────────────────
  // The relationship "View Leads" needs and that has never existed: leads had 21
  // columns and no partner_id, and the only trace of the idea was a COMMENTED-OUT
  // `ALTER TABLE opportunities ADD COLUMN partner_id` in the dead .sql file.
  // ON DELETE SET NULL: archiving a partner must not take its leads with it.
  await safe('leads_partner_id', `
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES sales_partners(id) ON DELETE SET NULL
  `);
  await safe('idx_leads_partner', `
    CREATE INDEX IF NOT EXISTS idx_leads_partner_id ON leads(partner_id) WHERE partner_id IS NOT NULL
  `);

  // Where a partner record was created BY converting a lead, remember which one.
  // Lets the grid show provenance and stops a second conversion of the same lead.
  await safe('converted_from_lead', `
    ALTER TABLE sales_partners
      ADD COLUMN IF NOT EXISTS converted_from_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL
  `);
  await safe('uq_converted_lead', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_partners_converted_lead
      ON sales_partners(converted_from_lead_id)
      WHERE converted_from_lead_id IS NOT NULL AND deleted_at IS NULL
  `);

  // ── 7. grid indexes ─────────────────────────────────────────────────────────
  await safe('idx_company',  `CREATE INDEX IF NOT EXISTS idx_sales_partners_company ON sales_partners(company_id)`);
  await safe('idx_assoc',    `CREATE INDEX IF NOT EXISTS idx_sales_partners_assoc   ON sales_partners(association_type)`);
  await safe('idx_status',   `CREATE INDEX IF NOT EXISTS idx_sales_partners_status  ON sales_partners(status)`);
  await safe('idx_state',    `CREATE INDEX IF NOT EXISTS idx_sales_partners_state   ON sales_partners(state)`);
  await safe('idx_created',  `CREATE INDEX IF NOT EXISTS idx_sales_partners_created ON sales_partners(created_at DESC)`);

  // ── 8. numbers for anything already there ───────────────────────────────────
  // Ordered by id so the issued numbers follow creation order.
  await safe('backfill_ipu', `
    UPDATE sales_partners s
       SET ipu_number = 'IPU-' || LPAD(nextval('seq_ipu')::text, 5, '0')
     WHERE s.ipu_number IS NULL
  `);

  console.log('[migration 20260717000004] sales_partners_ipu_master applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP INDEX IF EXISTS idx_leads_partner_id`);
  await safe(`ALTER TABLE leads DROP COLUMN IF EXISTS partner_id`);
  await safe(`ALTER TABLE sales_partners DROP COLUMN IF EXISTS converted_from_lead_id`);
  await safe(`ALTER TABLE sales_partners
                DROP COLUMN IF EXISTS ipu_number, DROP COLUMN IF EXISTS website,
                DROP COLUMN IF EXISTS city,       DROP COLUMN IF EXISTS state,
                DROP COLUMN IF EXISTS country,    DROP COLUMN IF EXISTS gstin,
                DROP COLUMN IF EXISTS address,    DROP COLUMN IF EXISTS notes,
                DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_at,
                DROP COLUMN IF EXISTS deleted_at`);
  await safe(`ALTER TABLE sales_partners RENAME COLUMN association_type TO type`);
  await safe(`DROP SEQUENCE IF EXISTS seq_ipu`);
}
