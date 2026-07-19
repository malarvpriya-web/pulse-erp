/**
 * 20260717000002_iem_enquiry_master.js
 *
 * Gives `leads` the identity it needs to act as the IEM (Inquiry/Enquiry
 * Management) master: an enquiry number and a probability.
 *
 * 1. `leads.iem_no` — the enquiry number. It was never a column: crm.routes.js
 *    synthesized 'IEM/{fy}/{id}' inside the won-lost report query alone, so the
 *    number was unsearchable outside that one screen and unprintable on any
 *    document. The backfill below reproduces that exact expression, so numbers
 *    already exported to users keep reconciling.
 *
 *    Deliberately NOT a sequence (unlike seq_ips / seq_ipd / seq_ipu): the format
 *    already in users' hands embeds the lead id, and a sequence would renumber
 *    every existing enquiry. Generation stays derived from (id, created_at) in
 *    leads.repository.create.
 *
 * 2. `leads.probability` — the IEM toolbar filters enquiries by a probability
 *    From-To range. Probability previously existed only on `opportunities`
 *    (probability_percentage), i.e. only AFTER conversion, so open enquiries —
 *    the bulk of an IEM grid — could never be filtered by it. Carried forward
 *    into opportunities.probability_percentage on convert.
 *
 * SCOPE — this migration owns the enquiry's IDENTITY only. `leads.partner_id` and
 * the whole partner relationship belong to 20260717000004_sales_partners_ipu_master,
 * which is the source of truth for the Partner (IPU) master. An earlier draft of
 * this file also added partner_id and its own index; that duplicated 000004 and
 * left two indexes on one column, so it was removed rather than left to race.
 *
 * Status note: `leads.status` has no CHECK constraint (verified — the only
 * constraints are the PK and three FKs), so the new 'Shelved' status needs no
 * DDL. It is added to the app-level list in Leads.jsx.
 */

// The IEM number expression. Fiscal year (Apr-Mar) of creation + zero-padded id.
// Must stay character-identical to the report's original derivation.
const IEM_NO_SQL = `
  'IEM/' ||
    CASE WHEN EXTRACT(MONTH FROM l.created_at) >= 4
         THEN EXTRACT(YEAR FROM l.created_at)::int
         ELSE EXTRACT(YEAR FROM l.created_at)::int - 1 END
    || '/' || LPAD(l.id::text, 4, '0')`;

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS probability INTEGER,
      ADD COLUMN IF NOT EXISTS iem_no      VARCHAR(32)
  `);

  // ADD CONSTRAINT has no IF NOT EXISTS, so a re-run would throw 42710.
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'leads_probability_range'
      ) THEN
        ALTER TABLE leads
          ADD CONSTRAINT leads_probability_range
          CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100));
      END IF;
    END $$;
  `);

  // Backfill iem_no for every existing enquiry, including soft-deleted ones — a
  // deleted enquiry still has to keep its number for audit/export reconciliation.
  await knex.raw(`
    UPDATE leads l SET iem_no = (${IEM_NO_SQL})
     WHERE l.iem_no IS NULL
  `);

  // Unique per company. Partial (iem_no IS NOT NULL) so rows that somehow miss a
  // number don't collide with each other on NULL.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_iem_no_unique
      ON leads (company_id, iem_no) WHERE iem_no IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status)
      WHERE deleted_at IS NULL
  `);

  // Clean up after this migration's own earlier draft: it created a partner index
  // that 000004 owns as idx_leads_partner_id. Dropping the duplicate here keeps
  // an already-migrated database converged with a fresh one.
  await knex.raw(`DROP INDEX IF EXISTS idx_leads_partner`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS leads_iem_no_unique`);
  await knex.raw(`DROP INDEX IF EXISTS idx_leads_status`);
  await knex.raw(`ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_probability_range`);
  await knex.raw(`
    ALTER TABLE leads
      DROP COLUMN IF EXISTS probability,
      DROP COLUMN IF EXISTS iem_no
  `);
  // partner_id is 000004's to drop, not this migration's.
}
