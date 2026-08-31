/**
 * CRM module data-integrity remediation (forensic audit 2026-08-19).
 *
 * The audit's root finding was that the CRM had no connected customer: the
 * commercial chain Lead → Opportunity → Account → Quotation → Order → Invoice
 * was severed at every hop. Everything here exists to reconnect it.
 *
 * 1. TWO CUSTOMER MASTERS.
 *    CRM wrote `accounts` (integer PK); Sales/Finance wrote `parties` (uuid PK).
 *    The bridge column `accounts.party_id` was populated on 1 of 7 rows and the
 *    two populations were otherwise disjoint. `parties` is made canonical — it
 *    is what quotations, sales_orders and invoices already FK — and `accounts`
 *    becomes a CRM-attribute extension that must carry a party_id. Deliberately
 *    NOT a third table and NOT a sync job: one identity, one id.
 *
 * 2. `opportunities.close_reason` never existed, but PATCH /opportunities/:id/stage
 *    splices it into the UPDATE whenever the Kanban's Won/Lost dialog sends a
 *    reason — 42703, 500, and the stage change rolls back. Which is why no
 *    opportunity had ever reached Won while 4 *leads* sat marked Won.
 *
 * 3. `crm_activities` never existed in any migration, yet the whole Activities
 *    UI (list/create/edit/delete) is built against it. The read path swallowed
 *    the error into an empty array, so it looked like "no activity logged yet".
 *
 * 4. `opportunities.account_id` was NULL on every live row, so no opportunity
 *    was reachable from a customer. Backfilled through the originating lead's
 *    company name.
 *
 * 5. `invoices.customer_id` was NULL on 32 of 35 rows. Backfilled by normalised
 *    name against `parties` (`invoices.party_name` is stored space-stripped,
 *    e.g. "TechCorpLtd" vs "TechCorp Ltd", so an exact join resolved only 12).
 *
 * 6. No duplicate prevention on accounts at all — one organisation with one
 *    email address created three account rows in live testing, and the
 *    application-level check was a check-then-insert race with no DB backstop.
 *
 * 7. `opportunity_stage_history` was empty, so sales cycle / time-in-stage /
 *    velocity were all unknowable. Seeded with an opening row per opportunity.
 */

/** Single-company installs can be backfilled unambiguously; multi-company ones must not guess. */
async function soleCompanyId(knex) {
  const { rows } = await knex.raw(`SELECT id FROM companies`);
  return rows.length === 1 ? rows[0].id : null;
}

export async function up(knex) {
  // ── 0. Canonical org-name normalisation ───────────────────────────────────
  // Used by both the backfills and the duplicate-prevention indexes, so that
  // "ABC Engineering Pvt Ltd" / "ABC Engineering Private Limited" /
  // "ABC Engineering Pvt. Ltd." all collapse to one key. IMMUTABLE so it can be
  // indexed; not STRICT because the COALESCE has to run for NULL input.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION crm_norm_name(txt text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $fn$
      SELECT regexp_replace(
               regexp_replace(
                 lower(coalesce(txt, '')),
                 '\\m(private|pvt|limited|ltd|llp|inc|incorporated|corporation|corp|company|co)\\M',
                 '', 'g'),
               '[^a-z0-9]', '', 'g')
    $fn$;
  `);

  // ── 1. accounts → parties: create the missing parties, then link ───────────
  // Step A: every live account with no normalised match in `parties` gets one.
  // party_code continues the existing CUST-nnn series.
  await knex.raw(`
    WITH missing AS (
      SELECT a.id,
             COALESCE(a.name, a.account_name) AS nm,
             a.company_id, a.email, a.phone, a.website, a.industry,
             ROW_NUMBER() OVER (ORDER BY a.id) AS rn
        FROM accounts a
       WHERE a.deleted_at IS NULL
         AND a.party_id IS NULL
         AND NOT EXISTS (
               SELECT 1 FROM parties p
                WHERE p.company_id IS NOT DISTINCT FROM a.company_id
                  AND p.deleted_at IS NULL
                  AND crm_norm_name(p.name) = crm_norm_name(COALESCE(a.name, a.account_name))
             )
    ), base AS (
      SELECT COALESCE(MAX(NULLIF(regexp_replace(party_code, '\\D', '', 'g'), ''))::int, 0) AS mx
        FROM parties
    )
    INSERT INTO parties (party_code, party_type, name, email, phone, website, industry, company_id, is_active)
    SELECT 'CUST-' || LPAD((b.mx + m.rn)::text, 3, '0'),
           'Customer', m.nm, m.email, m.phone, m.website, m.industry, m.company_id, true
      FROM missing m CROSS JOIN base b;
  `);

  // Step B: link every account to its (now guaranteed) party.
  await knex.raw(`
    UPDATE accounts a
       SET party_id = p.id
      FROM parties p
     WHERE a.party_id IS NULL
       AND a.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND p.company_id IS NOT DISTINCT FROM a.company_id
       AND crm_norm_name(p.name) = crm_norm_name(COALESCE(a.name, a.account_name));
  `);

  // ── 2. invoices.customer_id backfill ──────────────────────────────────────
  // Same treatment: create the counterparties that only ever existed as a
  // denormalised string on the invoice, then resolve every orphan.
  await knex.raw(`
    WITH missing AS (
      SELECT DISTINCT ON (crm_norm_name(i.party_name), i.company_id)
             i.party_name AS nm, i.company_id
        FROM invoices i
       WHERE i.customer_id IS NULL
         AND COALESCE(i.party_name, '') <> ''
         AND NOT EXISTS (
               SELECT 1 FROM parties p
                WHERE p.company_id IS NOT DISTINCT FROM i.company_id
                  AND p.deleted_at IS NULL
                  AND crm_norm_name(p.name) = crm_norm_name(i.party_name)
             )
       ORDER BY crm_norm_name(i.party_name), i.company_id, i.id
    ), numbered AS (
      SELECT nm, company_id, ROW_NUMBER() OVER (ORDER BY nm) AS rn FROM missing
    ), base AS (
      SELECT COALESCE(MAX(NULLIF(regexp_replace(party_code, '\\D', '', 'g'), ''))::int, 0) AS mx
        FROM parties
    )
    INSERT INTO parties (party_code, party_type, name, company_id, is_active)
    SELECT 'CUST-' || LPAD((b.mx + n.rn)::text, 3, '0'), 'Customer', n.nm, n.company_id, true
      FROM numbered n CROSS JOIN base b;
  `);

  await knex.raw(`
    UPDATE invoices i
       SET customer_id = p.id
      FROM parties p
     WHERE i.customer_id IS NULL
       AND p.deleted_at IS NULL
       AND p.company_id IS NOT DISTINCT FROM i.company_id
       AND crm_norm_name(p.name) = crm_norm_name(i.party_name);
  `);

  // ── 3. opportunities.close_reason ─────────────────────────────────────────
  await knex.raw(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS close_reason text;`);

  // Carry forward whatever the legacy lost_reason column already held.
  await knex.raw(`
    UPDATE opportunities
       SET close_reason = lost_reason
     WHERE close_reason IS NULL AND lost_reason IS NOT NULL;
  `);

  // ── 4. crm_activities ─────────────────────────────────────────────────────
  // performed_by FKs employees, not users: the list query joins
  // `employees e ON e.id = ca.performed_by` for the display name, and writing a
  // users.id there is the stock_ledger.created_by bug in a new place.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS crm_activities (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      activity_type   VARCHAR(40) NOT NULL,
      subject         VARCHAR(255),
      description     TEXT,
      activity_date   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_mins   INTEGER,
      lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      opportunity_id  INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
      account_id      INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      performed_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      status          VARCHAR(30) NOT NULL DEFAULT 'completed',
      next_followup_date DATE,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    );
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_activities_company    ON crm_activities (company_id) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_activities_account    ON crm_activities (account_id, activity_date DESC) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_activities_lead       ON crm_activities (lead_id, activity_date DESC) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_activities_opp        ON crm_activities (opportunity_id, activity_date DESC) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_activities_followup   ON crm_activities (next_followup_date) WHERE next_followup_date IS NOT NULL AND deleted_at IS NULL;`);

  // ── 5. opportunities.account_id backfill via the originating lead ─────────
  // The lead carries the customer's name; conversion never turned that into an
  // account. Resolve to an existing account by normalised name where possible.
  await knex.raw(`
    UPDATE opportunities o
       SET account_id = a.id
      FROM leads l
      JOIN accounts a
        ON a.deleted_at IS NULL
       AND a.company_id IS NOT DISTINCT FROM l.company_id
       AND crm_norm_name(COALESCE(a.name, a.account_name)) = crm_norm_name(l.company_name)
     WHERE o.account_id IS NULL
       AND o.deleted_at IS NULL
       AND o.lead_id = l.id
       AND COALESCE(l.company_name, '') <> '';
  `);

  // Leads whose company has no account yet: create the account (+ its party),
  // then link. Done after the direct match so we never create a duplicate.
  await knex.raw(`
    WITH need AS (
      SELECT DISTINCT ON (crm_norm_name(l.company_name), l.company_id)
             l.company_name AS nm, l.company_id, l.email, l.phone, l.industry, l.location
        FROM opportunities o
        JOIN leads l ON l.id = o.lead_id
       WHERE o.account_id IS NULL
         AND o.deleted_at IS NULL
         AND COALESCE(l.company_name, '') <> ''
         AND NOT EXISTS (
               SELECT 1 FROM accounts a
                WHERE a.deleted_at IS NULL
                  AND a.company_id IS NOT DISTINCT FROM l.company_id
                  AND crm_norm_name(COALESCE(a.name, a.account_name)) = crm_norm_name(l.company_name)
             )
       ORDER BY crm_norm_name(l.company_name), l.company_id, l.id
    ), numbered AS (
      SELECT nm, company_id, email, phone, industry, ROW_NUMBER() OVER (ORDER BY nm) AS rn FROM need
    ), base AS (
      SELECT COALESCE(MAX(NULLIF(regexp_replace(party_code, '\\D', '', 'g'), ''))::int, 0) AS mx FROM parties
    ), newparty AS (
      INSERT INTO parties (party_code, party_type, name, email, phone, industry, company_id, is_active)
      SELECT 'CUST-' || LPAD((b.mx + n.rn)::text, 3, '0'), 'Customer', n.nm, n.email, n.phone, n.industry, n.company_id, true
        FROM numbered n CROSS JOIN base b
      RETURNING id, name, company_id
    )
    INSERT INTO accounts (name, account_name, email, phone, industry, company_id, account_type, status, party_id)
    SELECT np.name, np.name, n.email, n.phone, n.industry, np.company_id, 'Customer', 'Active', np.id
      FROM newparty np
      JOIN numbered n ON n.nm = np.name AND n.company_id IS NOT DISTINCT FROM np.company_id;
  `);

  await knex.raw(`
    UPDATE opportunities o
       SET account_id = a.id
      FROM leads l
      JOIN accounts a
        ON a.deleted_at IS NULL
       AND a.company_id IS NOT DISTINCT FROM l.company_id
       AND crm_norm_name(COALESCE(a.name, a.account_name)) = crm_norm_name(l.company_name)
     WHERE o.account_id IS NULL
       AND o.deleted_at IS NULL
       AND o.lead_id = l.id;
  `);

  // ── 6. Duplicate prevention ───────────────────────────────────────────────
  // Accounts had no unique constraint of any kind. Normalised name is the
  // business key; the email index is partial so blank emails stay unconstrained.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_company_normname_unique
      ON accounts (company_id, crm_norm_name(COALESCE(name, account_name)))
      WHERE deleted_at IS NULL;
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_company_email_unique
      ON accounts (company_id, lower(email))
      WHERE deleted_at IS NULL AND email IS NOT NULL AND email <> '';
  `);
  // Contacts: mobile is as identifying as email for Indian B2B, and was
  // completely unconstrained — the same person + mobile created two rows.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_mobile_unique
      ON contacts (company_id, regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g'))
      WHERE deleted_at IS NULL AND mobile IS NOT NULL AND regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g') <> '';
  `);

  // ── 7. accounts.party_id is now mandatory ─────────────────────────────────
  // Enforces "one customer, one canonical id" at write time rather than by
  // convention. Only applied when the backfill left nothing behind.
  const { rows: unlinked } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM accounts WHERE party_id IS NULL AND deleted_at IS NULL`
  );
  if ((unlinked[0]?.n ?? 0) === 0) {
    await knex.raw(`ALTER TABLE accounts ALTER COLUMN party_id SET NOT NULL;`);
  }

  // ── 8. Seed opportunity_stage_history ─────────────────────────────────────
  // Without an opening row, time-in-stage and sales-cycle have no t0 and every
  // velocity metric reads 0 forever.
  const cid = await soleCompanyId(knex);
  await knex.raw(
    `
    INSERT INTO opportunity_stage_history (opportunity_id, company_id, from_stage, to_stage, changed_by, notes, created_at)
    SELECT o.id, COALESCE(o.company_id, $1), NULL, o.stage, o.created_by,
           'Opening stage recorded during CRM integrity migration', o.created_at
      FROM opportunities o
     WHERE o.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM opportunity_stage_history h WHERE h.opportunity_id = o.id);
  `,
    [cid]
  );

  // ── 9. Housekeeping ───────────────────────────────────────────────────────
  // crm_deals: 0 rows, no reader anywhere in the codebase — the dead twin of
  // `opportunities` (see the crm_* duplicate-table family).
  await knex.raw(`DROP TABLE IF EXISTS crm_deals;`);

  // Redundant indexes fully subsumed by composites that already exist.
  await knex.raw(`DROP INDEX IF EXISTS idx_crm_leads_status;`);          // ⊂ idx_leads_company_status
  await knex.raw(`DROP INDEX IF EXISTS idx_leads_status;`);              // ⊂ idx_leads_company_status
  await knex.raw(`DROP INDEX IF EXISTS idx_opportunities_company_stage;`); // ⊂ idx_opportunities_company_stage_created

  // Supports the corrected Customer 360 invoice join.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations (customer_id);`);

  // ── 9b. Broken CRM email write paths ──────────────────────────────────────
  // Surfaced by the new INSERT/UPDATE-target pass added to
  // scripts/check-sql-references.mjs — the old checker validated only qualified
  // `alias.col` references and could not see unqualified INSERT column lists,
  // so these three had been 500-ing silently:
  //   • connecting an SMTP account wrote smtp_secure (TLS flag) — column absent
  //   • sending an email against an opportunity wrote opportunity_id — absent
  // Both are legitimately part of the feature, so the columns are added rather
  // than the writes removed.
  await knex.raw(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS smtp_secure boolean NOT NULL DEFAULT true;`);
  await knex.raw(`ALTER TABLE crm_emails ADD COLUMN IF NOT EXISTS opportunity_id integer REFERENCES opportunities(id) ON DELETE SET NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_emails_opportunity ON crm_emails (opportunity_id) WHERE opportunity_id IS NOT NULL;`);

  // ── 10. Quotation numbering ───────────────────────────────────────────────
  // Was COUNT(*)+1 against a UNIQUE column — races under concurrency and reuses
  // a number after any delete. Seed the sequence past the highest existing
  // QT-yyyy-nnnn suffix so it can never collide with history.
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS quotation_number_seq;`);
  await knex.raw(`
    SELECT setval(
      'quotation_number_seq',
      GREATEST(
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(quotation_number, '^.*-', '', 'g'), ''))::bigint, 0)
           FROM quotations
          WHERE quotation_number ~ '^QT-[0-9]{4}-[0-9]+$'),
        (SELECT COUNT(*) FROM quotations)
      ),
      true
    );
  `);
}

export async function down(knex) {
  await knex.raw(`DROP SEQUENCE IF EXISTS quotation_number_seq;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_quotations_customer;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_invoices_customer;`);
  await knex.raw(`ALTER TABLE accounts ALTER COLUMN party_id DROP NOT NULL;`);
  await knex.raw(`DROP INDEX IF EXISTS contacts_company_mobile_unique;`);
  await knex.raw(`DROP INDEX IF EXISTS accounts_company_email_unique;`);
  await knex.raw(`DROP INDEX IF EXISTS accounts_company_normname_unique;`);
  await knex.raw(`DROP TABLE IF EXISTS crm_activities;`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS close_reason;`);
  await knex.raw(`DROP FUNCTION IF EXISTS crm_norm_name(text);`);
  // Backfilled ids and generated parties are intentionally left in place: they
  // are now referenced by live transactions, and dropping them would re-orphan
  // invoices that this migration connected.
}
