/**
 * Somewhere for the inventory maths to LAND.
 *
 * The audit's finding on EOQ, ROP, safety stock and ABC was not that they were
 * wrong — all four are textbook correct and driven by real 12-month consumption
 * — but that they were computed inside read-only report endpoints and discarded.
 * Nothing in the codebase wrote abc_class, safety_stock or reorder_level from a
 * calculation, so MRP read the hand-typed fields instead: safety_stock 0.00 on
 * every item, abc_class NULL on every item.
 *
 * These columns are the landing site. They are deliberately SEPARATE from the
 * hand-entered ones:
 *
 *   safety_stock          what the planner typed          (existing, respected)
 *   safety_stock_calculated  what the statistics say      (new)
 *   safety_stock_source   which of the two MRP should use (new: 'manual'|'calculated')
 *
 * Keeping both visible is the point. A planner who has overridden a figure must
 * be able to see what the system would have chosen and why, and an override must
 * survive the next recompute rather than being silently overwritten — the
 * failure mode that makes planners stop trusting a planning system. Same pattern
 * for the reorder point.
 *
 * demand_stddev and avg_daily_demand are stored because safety stock needs them
 * and because "demand variability" was itself a missing SCA component: no
 * standard deviation or coefficient of variation was computed anywhere in the
 * application.
 *
 * NULL means unmeasured and is never 0. An item nobody has consumed has NULL
 * annual demand, not a zero that would compute an EOQ of zero and read as a
 * deliberate "order nothing".
 */

export async function up(knex) {
  const cols = [
    // Demand statistics (inputs)
    ['annual_demand',            'NUMERIC(15,3)'],
    ['avg_daily_demand',         'NUMERIC(15,4)'],
    ['demand_stddev',            'NUMERIC(15,4)'],   // sigma of per-period demand
    ['demand_cv',                'NUMERIC(8,4)'],    // coefficient of variation
    ['demand_periods_observed',  'INTEGER'],
    // Computed policy (outputs)
    ['eoq',                      'NUMERIC(15,3)'],
    ['reorder_point_calculated', 'NUMERIC(15,3)'],
    ['safety_stock_calculated',  'NUMERIC(15,3)'],
    ['service_level_pct',        'NUMERIC(5,2)'],
    ['service_level_z',          'NUMERIC(6,3)'],
    ['abc_class_calculated',     'VARCHAR(1)'],
    ['annual_consumption_value', 'NUMERIC(18,2)'],
    // Which source MRP should honour
    ['safety_stock_source',      "VARCHAR(12) DEFAULT 'calculated'"],
    ['reorder_point_source',     "VARCHAR(12) DEFAULT 'calculated'"],
    ['planning_params_computed_at', 'TIMESTAMPTZ'],
  ];
  for (const [name, type] of cols) {
    await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  // A recompute is an event with a result, not a silent mutation — the same
  // reason mrp_runs exists. Without this there is no way to answer "why is the
  // safety stock on this part 40" three weeks later.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_planning_runs (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      run_no              VARCHAR(40),
      lookback_days       INTEGER,
      ordering_cost       NUMERIC(15,2),
      holding_cost_rate   NUMERIC(6,4),
      service_level_pct   NUMERIC(5,2),
      items_evaluated     INTEGER DEFAULT 0,
      items_updated       INTEGER DEFAULT 0,
      items_skipped       INTEGER DEFAULT 0,
      abc_a_count         INTEGER DEFAULT 0,
      abc_b_count         INTEGER DEFAULT 0,
      abc_c_count         INTEGER DEFAULT 0,
      total_annual_value  NUMERIC(18,2),
      params              JSONB,
      run_by              INTEGER,
      run_by_name         VARCHAR(120),
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      completed_at        TIMESTAMPTZ
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inv_planning_runs_company ON inventory_planning_runs(company_id, created_at DESC)`);

  // Per-item detail for one run: what each parameter was before and after, so a
  // change is inspectable rather than merely observed.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_planning_run_items (
      id                  SERIAL PRIMARY KEY,
      run_id              INTEGER REFERENCES inventory_planning_runs(id) ON DELETE CASCADE,
      company_id          INTEGER,
      item_id             INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      item_code           VARCHAR(60),
      item_name           VARCHAR(200),
      annual_demand       NUMERIC(15,3),
      avg_daily_demand    NUMERIC(15,4),
      demand_stddev       NUMERIC(15,4),
      unit_cost           NUMERIC(15,2),
      eoq                 NUMERIC(15,3),
      safety_stock        NUMERIC(15,3),
      reorder_point       NUMERIC(15,3),
      abc_class           VARCHAR(1),
      annual_consumption_value NUMERIC(18,2),
      applied              BOOLEAN DEFAULT true,
      skip_reason          VARCHAR(80),
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inv_planning_run_items ON inventory_planning_run_items(run_id)`);

  // Company-level planning policy. procurement_settings already holds a
  // service_level_z for the TCO engine; inventory needs its own, because the
  // two answer different questions and must be tunable apart.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_planning_settings (
      company_id          INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      ordering_cost       NUMERIC(15,2) NOT NULL DEFAULT 500,
      holding_cost_rate   NUMERIC(6,4)  NOT NULL DEFAULT 0.18,
      service_level_pct   NUMERIC(5,2)  NOT NULL DEFAULT 95,
      lookback_days       INTEGER       NOT NULL DEFAULT 365,
      min_periods_for_stats INTEGER     NOT NULL DEFAULT 3,
      auto_apply          BOOLEAN       NOT NULL DEFAULT true,
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS inventory_planning_settings`);
  await knex.raw(`DROP TABLE IF EXISTS inventory_planning_run_items`);
  await knex.raw(`DROP TABLE IF EXISTS inventory_planning_runs`);
  for (const c of ['planning_params_computed_at','reorder_point_source','safety_stock_source',
    'annual_consumption_value','abc_class_calculated','service_level_z','service_level_pct',
    'safety_stock_calculated','reorder_point_calculated','eoq','demand_periods_observed',
    'demand_cv','demand_stddev','avg_daily_demand','annual_demand']) {
    await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS ${c}`);
  }
}
