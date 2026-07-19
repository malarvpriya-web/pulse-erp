/**
 * 20260716000002_service_master_ips.js
 *
 * Phase 1 of the Service Master (IPS) build — see SERVICE_MASTER_IPS_AUDIT.md.
 *
 * `support_tickets` currently models an internal IT/HR helpdesk (categories are
 * Finance / Attendance / Payroll / HR / IT …). The IPS field-service grid needs
 * the same lifecycle plus a field-service dimension set. Rather than fork a
 * `service_tickets` twin — which would orphan the FK backbone already attached
 * to support_tickets (project_id, site_id, customer_id, complaint_id, and the
 * csat_responses -> ticket -> complaint loop closed by 20260716000001) — this
 * keeps ONE table and adds a discriminator:
 *
 *   ticket_kind  'helpdesk' (default, all 14 existing rows) | 'service' (IPS)
 *
 * The two kinds also number differently, off the SAME ticket_number column:
 *   helpdesk -> TKT-0001  (seq_tkt, unchanged)
 *   service  -> IPS-00001 (seq_ips, new)
 * One identifier per ticket. A second `ips_number` column was rejected: it would
 * give every service ticket two identities and make ticket_number search/export
 * ambiguous.
 *
 * New dimension columns (all nullable, all free-text pending the taxonomy):
 *   zone          field-service region. NOT sourced from projects.zone — a
 *                 ticket must stand alone when project_id is NULL (13/14 are).
 *   service_type  e.g. Commissioning. Taxonomy UNCONFIRMED — see note below.
 *   product_type  e.g. the Manifest product line. Taxonomy UNCONFIRMED.
 *
 * `service_issue_categories` is created as a managed master (mirroring
 * item_categories from 20260713000001) to replace the free-text
 * SELECT DISTINCT category the /filters endpoint does today.
 *
 * DELIBERATELY NOT SEEDED / NOT CONSTRAINED: the issue-category rows, and any
 * CHECK on service_type / product_type / status. The audit's four open questions
 * (real product-line naming, the full IPS status lifecycle incl. "Analysis",
 * whether Type is service_master.category or new, and the site model) are
 * unanswered. Columns are structure; the taxonomy is a follow-up migration once
 * the owner confirms. Guessing values here would bake fiction into a CHECK.
 *
 * Also backfills the single NULL company_id row (id=24, "Test", 2026-07-07),
 * which is invisible to scoped users and drags every widget count low — the
 * BUG 1 / NULL-scoping failure mode. Only one company exists (id=1, Manifest),
 * so the target is unambiguous.
 *
 * The migration runner's `knex` is a thin pg shim: bindings are $n, never `?`.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_ips_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate object/i.test(err.message || '')) throw err;
    }
  };

  // ── 1. discriminator ─────────────────────────────────────────────────────────
  // Default 'helpdesk' so every existing row and every existing POST (which does
  // not yet send a kind) keeps its current meaning. IPS rows opt in explicitly.
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ticket_kind VARCHAR(20) NOT NULL DEFAULT 'helpdesk'`);
  await safe(`ALTER TABLE support_tickets ADD CONSTRAINT chk_support_tickets_kind CHECK (ticket_kind IN ('helpdesk','service'))`);

  // ── 2. field-service dimensions ──────────────────────────────────────────────
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS zone         VARCHAR(80)`);
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS service_type VARCHAR(60)`);
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS product_type VARCHAR(80)`);

  // ── 3. issue-category master ─────────────────────────────────────────────────
  // Company-scoped + soft-deletable, matching item_categories. Left EMPTY: the
  // taxonomy is an open question, and the /filters DISTINCT-category read keeps
  // working until it is answered.
  await safe(`
    CREATE TABLE IF NOT EXISTS service_issue_categories (
      id            SERIAL PRIMARY KEY,
      category_code VARCHAR(30),
      name          VARCHAR(120) NOT NULL,
      parent_id     INTEGER REFERENCES service_issue_categories(id) ON DELETE SET NULL,
      description   TEXT,
      company_id    INTEGER,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_service_issue_categories_company ON service_issue_categories(company_id)`);

  // Nullable FK: tickets keep their free-text `category` until the master is
  // populated and rows are mapped across. The two coexist by design.
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS issue_category_id INTEGER`);
  await safe(`
    ALTER TABLE support_tickets
      ADD CONSTRAINT fk_support_tickets_issue_category
      FOREIGN KEY (issue_category_id) REFERENCES service_issue_categories(id) ON DELETE SET NULL
  `);

  // ── 4. IPS numbering ─────────────────────────────────────────────────────────
  // Fresh sequence — no IPS-prefixed number has ever been issued, so there is no
  // existing max to seed from (unlike 20260520000002, which sampled every table).
  await safe(`CREATE SEQUENCE IF NOT EXISTS seq_ips START WITH 1 INCREMENT BY 1 NO CYCLE`);

  // ── 5. BUG 1 backfill — NULL company_id is invisible to scoped users ─────────
  await safe(`UPDATE support_tickets SET company_id = 1 WHERE company_id IS NULL`);

  // ── 6. indexes for the IPS grid's filters ────────────────────────────────────
  await safe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_kind    ON support_tickets(ticket_kind)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_zone    ON support_tickets(zone)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_project ON support_tickets(project_id)`);
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP INDEX IF EXISTS idx_support_tickets_project`);
  await safe(`DROP INDEX IF EXISTS idx_support_tickets_zone`);
  await safe(`DROP INDEX IF EXISTS idx_support_tickets_kind`);
  await safe(`DROP SEQUENCE IF EXISTS seq_ips`);
  await safe(`ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS fk_support_tickets_issue_category`);
  await safe(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS issue_category_id`);
  await safe(`DROP INDEX IF EXISTS idx_service_issue_categories_company`);
  await safe(`DROP TABLE IF EXISTS service_issue_categories`);
  await safe(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS product_type`);
  await safe(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS service_type`);
  await safe(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS zone`);
  await safe(`ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS chk_support_tickets_kind`);
  await safe(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS ticket_kind`);
  // company_id backfill is intentionally NOT reverted — restoring NULL would
  // reintroduce the scoping bug, and the pre-migration value is not recoverable.
}
