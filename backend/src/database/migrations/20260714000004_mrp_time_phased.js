/**
 * MRP time-phased grid
 * --------------------
 * Upgrades MRP from bucketless (aggregate-per-item) to true time-phased planning.
 * Each row is one item × one time bucket of a run, holding the classic MRP grid:
 *   gross requirements, scheduled receipts, projected available balance (PAB),
 *   net requirements, and planned order receipts.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS mrp_time_phased (
      id                   SERIAL PRIMARY KEY,
      run_id               INTEGER NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
      company_id           INTEGER,
      item_id              INTEGER,
      item_code            VARCHAR(100),
      item_name            VARCHAR(250),
      low_level_code       INTEGER DEFAULT 0,
      bucket_index         INTEGER NOT NULL,
      bucket_start         DATE NOT NULL,
      bucket_end           DATE NOT NULL,
      gross_requirements   NUMERIC(14,3) DEFAULT 0,
      scheduled_receipts   NUMERIC(14,3) DEFAULT 0,
      planned_receipts     NUMERIC(14,3) DEFAULT 0,
      projected_available  NUMERIC(14,3) DEFAULT 0,
      net_requirements     NUMERIC(14,3) DEFAULT 0,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mrp_tp_run ON mrp_time_phased(run_id, low_level_code, item_id, bucket_index)`);

  // record the bucket size on the run for grid rendering
  await knex.raw(`ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS bucket_days INTEGER DEFAULT 7`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS mrp_time_phased CASCADE`);
  await knex.raw(`ALTER TABLE mrp_runs DROP COLUMN IF EXISTS bucket_days`);
}
