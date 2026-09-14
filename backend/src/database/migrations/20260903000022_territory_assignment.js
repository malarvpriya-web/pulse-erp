/**
 * 20260903000022_territory_assignment.js
 *
 * Makes territory management do something.
 *
 * WHY
 * ---
 * The Salesforce-parity audit (2026-09-03) checked the brief's explicit
 * requirement — "verify that territory rules actually influence lead/account/
 * opportunity assignment" — and found `sales_territories` referenced in exactly
 * five places, all of them inside sales.routes.js: the CREATE TABLE, a SELECT
 * for the grid, an INSERT, an UPDATE and a DELETE. Nothing read it when a lead
 * or an opportunity was assigned. leadAssignment.service.js implements rule,
 * round-robin and load-balanced assignment and does not mention territories at
 * all. The Territories page was a CRUD screen over a table with no consumer.
 *
 * WHAT A TERRITORY HAS TO MATCH ON
 * --------------------------------
 * The table could only express `region` (free text) and `states` (jsonb). The
 * data leads actually carry is `zone` (North/South/East/West/Central),
 * `location` (a city) and `industry` — so a territory could not be written that
 * matched any real lead. This adds the three dimensions that exist in the data,
 * plus an explicit `priority` so overlapping territories resolve deterministically
 * instead of by whatever order the planner returns.
 *
 * `territory_id` on leads and opportunities is what makes territory PERFORMANCE
 * measurable. Without it, "revenue by territory" can only be reconstructed by
 * re-running the matching rules over history, which silently rewrites the past
 * every time someone edits a territory.
 *
 * THE SEED ROWS
 * -------------
 * All five existing territories are seeder output — literally
 * `name = 'SEED Sales Territories 1'`, `states = ['SEED-1']`. They match no real
 * lead, so they were harmless while nothing read the table; the moment matching
 * goes live they become five rules of unknown intent sitting above the real ones.
 * They are ARCHIVED, not deleted: status='archived' takes them out of matching
 * and out of the active grid while leaving the rows recoverable, since removing
 * data the owner has not asked to lose is not this migration's call to make.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // -- dimensions a territory can match on ------------------------------------
  for (const col of ['zones', 'cities', 'industries']) {
    await knex.raw(`
      ALTER TABLE sales_territories
        ADD COLUMN IF NOT EXISTS ${col} JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
  }
  await knex.raw(`
    ALTER TABLE sales_territories
      ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100
  `);

  // -- where a record landed, recorded at the time ----------------------------
  await knex.raw(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS territory_id INTEGER
  `);
  await knex.raw(`
    ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS territory_id INTEGER
  `);
  // FKs added separately so a re-run over an existing column still gets them.
  await knex.raw(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_territory_id_fkey') THEN
        ALTER TABLE leads ADD CONSTRAINT leads_territory_id_fkey
          FOREIGN KEY (territory_id) REFERENCES sales_territories(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_territory_id_fkey') THEN
        ALTER TABLE opportunities ADD CONSTRAINT opportunities_territory_id_fkey
          FOREIGN KEY (territory_id) REFERENCES sales_territories(id) ON DELETE SET NULL;
      END IF;
    END
    $do$;
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_leads_territory ON leads (territory_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_opportunities_territory ON opportunities (territory_id)`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sales_territories_active
      ON sales_territories (company_id, priority)
     WHERE status = 'active'
  `);

  // -- take the seeder's placeholder territories out of matching ---------------
  const { rowCount } = await knex.raw(
    `UPDATE sales_territories
        SET status = 'archived'
      WHERE status = 'active'
        AND (name LIKE 'SEED %' OR region LIKE 'SEED %')`
  );
  console.log(`[territory_assignment] archived ${rowCount ?? 0} seeder placeholder territories`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_sales_territories_active`);
  await knex.raw(`DROP INDEX IF EXISTS idx_opportunities_territory`);
  await knex.raw(`DROP INDEX IF EXISTS idx_leads_territory`);
  await knex.raw(`ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_territory_id_fkey`);
  await knex.raw(`ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_territory_id_fkey`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS territory_id`);
  await knex.raw(`ALTER TABLE leads DROP COLUMN IF EXISTS territory_id`);
  await knex.raw(`ALTER TABLE sales_territories DROP COLUMN IF EXISTS priority`);
  for (const col of ['industries', 'cities', 'zones']) {
    await knex.raw(`ALTER TABLE sales_territories DROP COLUMN IF EXISTS ${col}`);
  }
  // The archived seeder rows are deliberately left archived — reactivating
  // placeholder data on a rollback would be worse than leaving it out.
}
