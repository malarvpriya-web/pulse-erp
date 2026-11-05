/**
 * A master production schedule that is generated has to be able to say what
 * generated it.
 *
 * `master_production_schedule` already carried `source_order_id`,
 * `source_forecast_id` and `generated_by_run_id` - added in
 * 20260911000012_demand_forecasting - but nothing ever wrote them, because
 * nothing generated an MPS. Every row was typed by hand, which is why the whole
 * schedule netted to zero and MRP saw no demand for five weeks.
 *
 * This is the run those columns point at: one row per generation, so a planner
 * looking at an MPS line can ask "where did this come from" and get the demand
 * that caused it, the run that netted it, and what the run was netting against.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS mps_generation_runs (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER     NOT NULL,
      run_no            VARCHAR(32),
      horizon_days      INTEGER,
      demand_from_orders    NUMERIC(16,3) DEFAULT 0,
      demand_from_forecast  NUMERIC(16,3) DEFAULT 0,
      existing_supply       NUMERIC(16,3) DEFAULT 0,
      rows_created      INTEGER DEFAULT 0,
      rows_superseded   INTEGER DEFAULT 0,
      items_considered  INTEGER DEFAULT 0,
      status            VARCHAR(16) NOT NULL DEFAULT 'completed',
      run_by            INTEGER,
      run_by_name       VARCHAR(160),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mpsgen_co ON mps_generation_runs (company_id, created_at DESC)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS mps_generation_runs`);
}
