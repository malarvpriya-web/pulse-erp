/**
 * Statistical demand forecasting — the component the audit found entirely absent.
 *
 * Pulse had exactly one forecasting engine, in sales, and it is a good one: it
 * forecasts REVENUE by opportunity, snapshot-based so that accuracy means
 * something. But MRP needs QUANTITY by SKU by date, and opportunities carry no
 * item lines, so nothing could be adapted. demand_forecasts existed as a table
 * behind a CRUD form and no engine ever wrote to it.
 *
 * WHY forecast_qty IS SEPARATE FROM quantity
 * -----------------------------------------
 * demand_forecasts.quantity is what the planning number IS — possibly overridden
 * by a human. forecast_qty is what the STATISTICS said. Keeping both is what
 * makes accuracy measurable and overrides visible: measuring a model against a
 * number a planner has since edited measures nothing.
 *
 * WHY consumed_qty NEEDED A REAL SOURCE
 * ------------------------------------
 * MRP nets demand as (quantity - consumed_qty), and consumed_qty was written
 * ONLY by a manual PUT. Someone had set it equal to quantity on every row, which
 * netted all demand to exactly zero and is the direct cause of fourteen MRP runs
 * producing zero planned orders. Forecast consumption is now a recorded event —
 * a sales order consuming forecast writes a row here, and consumed_qty is the
 * sum of those rows rather than a free-typed number.
 *
 * ACCURACY IS MEASURED AGAINST THE SNAPSHOT, never a recomputation, for the same
 * reason forecastEngine.js documents: recomputing a finished period returns
 * whatever happened, so "accuracy" measured that way is always ~100%.
 */

export async function up(knex) {
  // ── Forecast provenance on the existing table ──────────────────────────────
  const fcCols = [
    ['run_id',        'INTEGER'],
    ['method',        'VARCHAR(30)'],      // moving_average | exp_smoothing | holt | manual
    ['forecast_qty',  'NUMERIC(15,3)'],    // what the model said, before override
    ['actual_qty',    'NUMERIC(15,3)'],    // filled in once the period closes
    ['period_start',  'DATE'],
    ['period_end',    'DATE'],
    ['status',        "VARCHAR(16) DEFAULT 'draft'"],  // draft | approved | superseded
    ['version',       'INTEGER DEFAULT 1'],
    ['approved_by',   'INTEGER'],
    ['approved_by_name', 'VARCHAR(120)'],
    ['approved_at',   'TIMESTAMPTZ'],
    ['is_manual_override', 'BOOLEAN DEFAULT false'],
  ];
  for (const [n, t] of fcCols) {
    await knex.raw(`ALTER TABLE demand_forecasts ADD COLUMN IF NOT EXISTS ${n} ${t}`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_demand_forecasts_item ON demand_forecasts(item_id, forecast_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_demand_forecasts_run  ON demand_forecasts(run_id)`);

  // ── A forecast run ─────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS demand_forecast_runs (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      run_no            VARCHAR(40),
      method            VARCHAR(30),
      bucket_type       VARCHAR(10)  DEFAULT 'month',
      horizon_periods   INTEGER      DEFAULT 6,
      lookback_days     INTEGER      DEFAULT 730,
      params            JSONB,
      items_evaluated   INTEGER DEFAULT 0,
      items_forecast    INTEGER DEFAULT 0,
      items_skipped     INTEGER DEFAULT 0,
      avg_mape          NUMERIC(8,2),
      avg_mad           NUMERIC(15,3),
      avg_bias          NUMERIC(15,3),
      status            VARCHAR(16) DEFAULT 'completed',
      run_by            INTEGER,
      run_by_name       VARCHAR(120),
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_forecast_runs_company ON demand_forecast_runs(company_id, created_at DESC)`);

  // ── Per-item accuracy, measured on closed periods only ─────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS demand_forecast_accuracy (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      item_id         INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      item_code       VARCHAR(60),
      item_name       VARCHAR(200),
      method          VARCHAR(30),
      period_start    DATE,
      period_end      DATE,
      forecast_qty    NUMERIC(15,3),
      actual_qty      NUMERIC(15,3),
      abs_error       NUMERIC(15,3),
      pct_error       NUMERIC(10,2),
      bias            NUMERIC(15,3),
      measured_at     TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_item ON demand_forecast_accuracy(item_id, period_start DESC)`);

  // ── Forecast consumption: a recorded event, not a typed number ─────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS demand_forecast_consumption (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER,
      forecast_id         INTEGER REFERENCES demand_forecasts(id) ON DELETE CASCADE,
      item_id             INTEGER,
      qty                 NUMERIC(15,3) NOT NULL,
      source_type         VARCHAR(24) NOT NULL,   -- sales_order | manual
      source_id           INTEGER,
      source_ref          VARCHAR(60),
      consumed_at         TIMESTAMPTZ DEFAULT NOW(),
      created_by          INTEGER
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_forecast_consumption_fc ON demand_forecast_consumption(forecast_id)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_forecast_consumption_source
                    ON demand_forecast_consumption(forecast_id, source_type, source_id)
                  WHERE source_id IS NOT NULL`);

  // ── MPS provenance ─────────────────────────────────────────────────────────
  // MPS was hand-typed with no link to what generated it, and quantity_produced
  // was hand-typed too, so "MPS vs actual" could never be true. Both get a real
  // source: a forecast/order that generated the line, and a production order
  // whose completion reports back against it.
  await knex.raw(`ALTER TABLE master_production_schedule ADD COLUMN IF NOT EXISTS source_forecast_id  INTEGER`);
  await knex.raw(`ALTER TABLE master_production_schedule ADD COLUMN IF NOT EXISTS source_order_id     INTEGER`);
  await knex.raw(`ALTER TABLE master_production_schedule ADD COLUMN IF NOT EXISTS generated_by_run_id INTEGER`);
  await knex.raw(`ALTER TABLE master_production_schedule ADD COLUMN IF NOT EXISTS firmed_at           TIMESTAMPTZ`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mps_product ON master_production_schedule(product_id, due_date)`);

  // Production orders report their completion back to the MPS line they serve.
  await knex.raw(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS mps_id INTEGER`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_prod_orders_mps ON production_orders(mps_id) WHERE mps_id IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE production_orders DROP COLUMN IF EXISTS mps_id`);
  for (const c of ['firmed_at','generated_by_run_id','source_order_id','source_forecast_id']) {
    await knex.raw(`ALTER TABLE master_production_schedule DROP COLUMN IF EXISTS ${c}`);
  }
  await knex.raw(`DROP TABLE IF EXISTS demand_forecast_consumption`);
  await knex.raw(`DROP TABLE IF EXISTS demand_forecast_accuracy`);
  await knex.raw(`DROP TABLE IF EXISTS demand_forecast_runs`);
  for (const c of ['is_manual_override','approved_at','approved_by_name','approved_by','version','status',
    'period_end','period_start','actual_qty','forecast_qty','method','run_id']) {
    await knex.raw(`ALTER TABLE demand_forecasts DROP COLUMN IF EXISTS ${c}`);
  }
}
