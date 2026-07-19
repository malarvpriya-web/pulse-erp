/**
 * 20260714000002_delivery_tracker_link.js
 *
 * Builds the IPM (pursuit/opportunity) <-> IPP (production/project) bridge that
 * the Delivery Tracker reports on. Before this migration `projects` had no way
 * back to the originating `opportunities` row, so the two modules were islands.
 *
 * On `projects` (the IPP side):
 *   1. `opportunity_id`    — THE bridge. Nullable FK to opportunities(id); legacy
 *      projects with no originating pursuit simply show a blank IPM.
 *   2. `project_number`    — human ID in IPP-XXXXXX form. A STORED generated
 *      column off SERIAL `id` (IPP- + 6-digit pad), mirroring how IPM was added
 *      to opportunities in 20260714000001. No sequence to drift, no app code.
 *   3. `production_stage`  — design/procurement/fabrication/testing/dispatch/
 *      handover. Free VARCHAR(50) (like opportunities.stage); values come from
 *      the app + queries, so no enum migration is ever needed.
 *   4. `target_date`       — committed production/delivery target.
 *   5. `forecast_date`     — current best-estimate delivery date (may slip).
 *
 * On `opportunities` (the IPM side):
 *   6. `order_won_date`    — the ACTUAL won date. expected_closing_date is a
 *      forecast, not the won date, so the tracker's "Order won date" column had
 *      no backing field until now.
 *
 * Guarded company_id NULL->1 backfill on projects: scoped users (superadmin
 * resolves to company 1) can't see NULL-company rows, which would render the
 * tracker empty. Same fix as 20260706000003 / 20260714000001 on other tables.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_deltrk_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // ── projects: the IPP side ──────────────────────────────────────────────────
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS opportunity_id  INTEGER REFERENCES opportunities(id)`);
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_stage VARCHAR(50)`);
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS target_date     DATE`);
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS forecast_date   DATE`);

  // Generated IPP id. Wrapped in safe() because GENERATED columns can't take
  // IF NOT EXISTS on older PG — a re-run hits "column already exists" and is
  // swallowed by the savepoint guard.
  await safe(`
    ALTER TABLE projects
      ADD COLUMN project_number VARCHAR(20)
      GENERATED ALWAYS AS ('IPP-' || LPAD(id::text, 6, '0')) STORED
  `);

  // ── opportunities: the IPM side ─────────────────────────────────────────────
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS order_won_date DATE`);

  // ── company_id backfill (projects) ──────────────────────────────────────────
  // Only touch NULLs, and only when company 1 exists.
  await safe(`
    UPDATE projects
       SET company_id = 1
     WHERE company_id IS NULL
       AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM companies WHERE id = 1)
  `);

  // ── indexes ─────────────────────────────────────────────────────────────────
  await safe(`CREATE INDEX IF NOT EXISTS idx_projects_company_stage
    ON projects(company_id, production_stage)
    WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_projects_opportunity
    ON projects(opportunity_id)
    WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_projects_company_stage`);
  await knex.raw(`DROP INDEX IF EXISTS idx_projects_opportunity`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS project_number`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS forecast_date`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS target_date`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS production_stage`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS opportunity_id`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS order_won_date`);
}
