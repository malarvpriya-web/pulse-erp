/**
 * CRP — Capacity Requirements Planning
 * ------------------------------------
 * The capacity half of MRP II: loads the planned + firm production work onto
 * work centres, bucketed over a horizon, and compares against available
 * capacity to surface over/under-load.
 *
 *   available_hours(bucket) = capacity_hours_per_day * working_days_in_bucket
 *                             * efficiency_pct/100 * num_machines
 *   required_hours(bucket)  = Σ (operation std_time_hrs * order qty)   [firm]
 *                           + Σ (routing setup + std_time * planned qty) [MRP planned]
 *
 * Adds work-centre capacity attributes and two result tables (run header + the
 * per-work-centre-per-bucket load grid), mirroring the MRP run/planned-order shape.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE work_centres
      ADD COLUMN IF NOT EXISTS efficiency_pct        NUMERIC(6,2) DEFAULT 100,
      ADD COLUMN IF NOT EXISTS working_days_per_week  INTEGER     DEFAULT 5,
      ADD COLUMN IF NOT EXISTS num_machines           INTEGER     DEFAULT 1
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS crp_runs (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER,
      run_no              VARCHAR(40) UNIQUE,
      horizon_days        INTEGER NOT NULL DEFAULT 84,
      bucket_days         INTEGER NOT NULL DEFAULT 7,
      bucket_type         VARCHAR(12) NOT NULL DEFAULT 'week',
      status              VARCHAR(20) NOT NULL DEFAULT 'completed',
      include_planned     BOOLEAN DEFAULT TRUE,
      mrp_run_id          INTEGER,
      work_centre_count   INTEGER DEFAULT 0,
      bucket_count        INTEGER DEFAULT 0,
      overloaded_count    INTEGER DEFAULT 0,
      peak_load_pct       NUMERIC(8,2) DEFAULT 0,
      total_required_hrs  NUMERIC(14,2) DEFAULT 0,
      total_available_hrs NUMERIC(14,2) DEFAULT 0,
      params              JSONB DEFAULT '{}',
      run_by              INTEGER,
      run_by_name         VARCHAR(150),
      started_at          TIMESTAMPTZ DEFAULT NOW(),
      completed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crp_runs_company ON crp_runs(company_id, created_at DESC)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS crp_load (
      id                SERIAL PRIMARY KEY,
      run_id            INTEGER NOT NULL REFERENCES crp_runs(id) ON DELETE CASCADE,
      company_id        INTEGER,
      work_centre_id    INTEGER,
      work_centre_name  VARCHAR(150),
      bucket_index      INTEGER NOT NULL,
      bucket_start      DATE NOT NULL,
      bucket_end        DATE NOT NULL,
      available_hours   NUMERIC(14,2) DEFAULT 0,
      required_hours    NUMERIC(14,2) DEFAULT 0,
      firm_hours        NUMERIC(14,2) DEFAULT 0,
      planned_hours     NUMERIC(14,2) DEFAULT 0,
      load_pct          NUMERIC(8,2)  DEFAULT 0,
      order_count       INTEGER DEFAULT 0,
      is_overloaded     BOOLEAN DEFAULT FALSE,
      contributors      JSONB DEFAULT '[]',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crp_load_run ON crp_load(run_id, work_centre_id, bucket_index)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crp_load_overload ON crp_load(run_id, is_overloaded)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS crp_load CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS crp_runs CASCADE`);
  await knex.raw(`
    ALTER TABLE work_centres
      DROP COLUMN IF EXISTS efficiency_pct,
      DROP COLUMN IF EXISTS working_days_per_week,
      DROP COLUMN IF EXISTS num_machines
  `);
}
