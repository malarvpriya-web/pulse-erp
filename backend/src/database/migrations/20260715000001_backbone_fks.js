/**
 * 20260715000001_backbone_fks.js
 *
 * Data-integrity audit follow-up (Sales -> Production -> Service backbone).
 * The audit found three load-bearing links held together by bare integers or
 * nothing at all. This migration promotes them to real, tenant-safe-by-app,
 * ON DELETE SET NULL foreign keys. All changes are additive and reversible;
 * no rows are deleted, orphaned references are simply nulled.
 *
 *   1. production_orders.project_id -> projects(id)
 *      Was a bare INTEGER (index only, no FK). The Sales->Production handoff.
 *      Existing rows pointing at a missing project are nulled first so the
 *      constraint can validate.
 *
 *   2. support_tickets.project_id    -> projects(id)      (NEW nullable col)
 *      support_tickets.complaint_id  -> complaints(id)    (NEW nullable col)
 *      The Production->Service and Complaint->Service links, which did not
 *      exist at all. New columns are NULL for every existing ticket, so there
 *      is nothing to reconcile.
 *
 *   3. csat_responses.ticket_id -> support_tickets(id)
 *      Feedback was linked to tickets by a bare INTEGER, so orphaned reviews
 *      were possible. csat_responses is created at server start by the
 *      servicedesk route module (not a migration), so this step is GUARDED:
 *      on a fresh DB the table may not exist yet at migrate time and is simply
 *      skipped -- the inline REFERENCES added to that module's CREATE TABLE
 *      covers the fresh-install case.
 *
 * Cross-company note: a PG FK validates only that the target row exists, never
 * that company_id matches. Same-tenant enforcement continues to live in the
 * app's WHERE company_id = $1 filters; these FKs do not weaken that, they add
 * referential integrity on top of it.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_backbone_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate object/i.test(err.message || '')) throw err;
    }
  };

  // ── 1. production_orders.project_id -> projects ─────────────────────────────
  // Null out orphans first, or ADD CONSTRAINT would fail validating them.
  await knex.raw(`
    UPDATE production_orders
       SET project_id = NULL
     WHERE project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = production_orders.project_id)
  `);
  await safe(`
    ALTER TABLE production_orders
      ADD CONSTRAINT fk_production_orders_project
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
  `);
  // idx_production_orders_project already exists (20260506000010).

  // ── 2. support_tickets.project_id / complaint_id ────────────────────────────
  // Add the columns plainly (project_id can already exist from earlier schema
  // drift — an inline REFERENCES on ADD COLUMN IF NOT EXISTS is silently skipped
  // when the column is already there), then attach the FK with an explicit named
  // constraint. Null any pre-existing orphans first so validation passes.
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS project_id   INTEGER`);
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS complaint_id INTEGER`);
  await knex.raw(`
    UPDATE support_tickets SET project_id = NULL
     WHERE project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = support_tickets.project_id)
  `);
  await knex.raw(`
    UPDATE support_tickets SET complaint_id = NULL
     WHERE complaint_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.id = support_tickets.complaint_id)
  `);
  await safe(`ALTER TABLE support_tickets ADD CONSTRAINT fk_support_tickets_project
      FOREIGN KEY (project_id)   REFERENCES projects(id)   ON DELETE SET NULL`);
  await safe(`ALTER TABLE support_tickets ADD CONSTRAINT fk_support_tickets_complaint
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE SET NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_project   ON support_tickets(project_id)   WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_complaint ON support_tickets(complaint_id) WHERE deleted_at IS NULL`);

  // ── 3. csat_responses.ticket_id -> support_tickets (guarded; runtime table) ──
  // Null orphans, then add the constraint. Both are wrapped so a not-yet-created
  // table on a fresh DB is skipped rather than aborting the migration.
  await safe(`
    UPDATE csat_responses
       SET ticket_id = NULL
     WHERE ticket_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM support_tickets t WHERE t.id = csat_responses.ticket_id)
  `);
  await safe(`
    ALTER TABLE csat_responses
      ADD CONSTRAINT fk_csat_responses_ticket
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE SET NULL
  `);
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`ALTER TABLE csat_responses     DROP CONSTRAINT IF EXISTS fk_csat_responses_ticket`);
  await safe(`DROP INDEX IF EXISTS idx_support_tickets_complaint`);
  await safe(`DROP INDEX IF EXISTS idx_support_tickets_project`);
  await safe(`ALTER TABLE support_tickets    DROP COLUMN IF EXISTS complaint_id`);
  await safe(`ALTER TABLE support_tickets    DROP COLUMN IF EXISTS project_id`);
  await safe(`ALTER TABLE production_orders  DROP CONSTRAINT IF EXISTS fk_production_orders_project`);
}
