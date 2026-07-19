/**
 * MRP II Planning Layer
 * ---------------------
 * Adds the formal *planning* half of MRP II on top of the existing execution
 * layer (BOM/routing/production orders/backflush/costing). Introduces:
 *
 *   - Item-master planning attributes (lot sizing, min/max, make-or-buy, reorder point)
 *   - master_production_schedule (MPS)  — independent demand for finished goods
 *   - demand_forecasts                  — statistical / manual forecast demand
 *   - mrp_runs (rebuilt)                — regenerative run header + params + KPIs
 *   - mrp_planned_orders               — planned make/buy orders with pegging
 *   - mrp_exceptions                   — expedite / past-due / no-BOM messages
 *
 * The prior `mrp_runs` table was an empty (0-row) vestige referenced nowhere in
 * code, so it is dropped and rebuilt with a proper planning schema.
 */
export async function up(knex) {
  // ── Item-master planning attributes (several already exist: safety_stock,
  //    lead_time_days, preferred_vendor_id, abc_class, holding_cost_pct) ──
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS reorder_point    NUMERIC(14,3) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS min_order_qty    NUMERIC(14,3) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_order_qty    NUMERIC(14,3) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lot_size_qty     NUMERIC(14,3) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lot_sizing_rule  VARCHAR(20)  DEFAULT 'lot_for_lot',
      ADD COLUMN IF NOT EXISTS make_or_buy      VARCHAR(10)  DEFAULT 'buy'
  `);

  // ── Master Production Schedule (independent demand for planned products) ──
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS master_production_schedule (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER,
      product_id         INTEGER,
      product_name       VARCHAR(250) NOT NULL,
      due_date           DATE NOT NULL,
      quantity           NUMERIC(14,3) NOT NULL,
      quantity_produced  NUMERIC(14,3) NOT NULL DEFAULT 0,
      status             VARCHAR(20) NOT NULL DEFAULT 'firm',
      demand_source      VARCHAR(40) DEFAULT 'manual',
      notes              TEXT,
      created_by         INTEGER,
      created_by_name    VARCHAR(150),
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_mps_status CHECK (status IN ('firm','planned','released','closed','cancelled'))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mps_company ON master_production_schedule(company_id, status, due_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mps_product ON master_production_schedule(product_id)`);

  // ── Demand forecasts (period-bucketed independent demand) ──
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS demand_forecasts (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      item_id         INTEGER,
      product_name    VARCHAR(250),
      forecast_date   DATE NOT NULL,
      quantity        NUMERIC(14,3) NOT NULL,
      consumed_qty    NUMERIC(14,3) NOT NULL DEFAULT 0,
      uom             VARCHAR(30),
      source          VARCHAR(40) DEFAULT 'manual',
      notes           TEXT,
      created_by      INTEGER,
      created_by_name VARCHAR(150),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_forecast_company ON demand_forecasts(company_id, forecast_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_forecast_item ON demand_forecasts(item_id)`);

  // ── Rebuild mrp_runs (drop empty legacy vestige) ──
  await knex.raw(`DROP TABLE IF EXISTS mrp_runs CASCADE`);
  await knex.raw(`
    CREATE TABLE mrp_runs (
      id                    SERIAL PRIMARY KEY,
      company_id            INTEGER,
      run_no                VARCHAR(40) UNIQUE,
      run_type              VARCHAR(20) NOT NULL DEFAULT 'regenerative',
      horizon_days          INTEGER NOT NULL DEFAULT 90,
      status                VARCHAR(20) NOT NULL DEFAULT 'completed',
      params                JSONB DEFAULT '{}',
      item_count            INTEGER DEFAULT 0,
      planned_order_count   INTEGER DEFAULT 0,
      planned_make_count    INTEGER DEFAULT 0,
      planned_buy_count     INTEGER DEFAULT 0,
      exception_count       INTEGER DEFAULT 0,
      total_purchase_value  NUMERIC(16,2) DEFAULT 0,
      run_by                INTEGER,
      run_by_name           VARCHAR(150),
      started_at            TIMESTAMPTZ DEFAULT NOW(),
      completed_at          TIMESTAMPTZ,
      error_message         TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mrp_runs_company ON mrp_runs(company_id, created_at DESC)`);

  // ── Planned orders (make + buy) with pegging + net calc snapshot ──
  await knex.raw(`
    CREATE TABLE mrp_planned_orders (
      id                  SERIAL PRIMARY KEY,
      run_id              INTEGER NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
      company_id          INTEGER,
      item_id             INTEGER,
      item_code           VARCHAR(100),
      item_name           VARCHAR(250) NOT NULL,
      order_type          VARCHAR(10) NOT NULL DEFAULT 'buy',
      low_level_code      INTEGER DEFAULT 0,
      quantity            NUMERIC(14,3) NOT NULL,
      uom                 VARCHAR(30),
      need_date           DATE,
      start_date          DATE,
      lead_time_days      INTEGER DEFAULT 0,
      gross_requirement   NUMERIC(14,3) DEFAULT 0,
      on_hand             NUMERIC(14,3) DEFAULT 0,
      scheduled_receipts  NUMERIC(14,3) DEFAULT 0,
      safety_stock        NUMERIC(14,3) DEFAULT 0,
      net_requirement     NUMERIC(14,3) DEFAULT 0,
      lot_rule            VARCHAR(20),
      unit_cost           NUMERIC(14,2) DEFAULT 0,
      est_value           NUMERIC(16,2) DEFAULT 0,
      bom_id              INTEGER,
      preferred_vendor_id INTEGER,
      pegging             JSONB DEFAULT '[]',
      status              VARCHAR(20) NOT NULL DEFAULT 'planned',
      converted_ref       VARCHAR(80),
      converted_id        INTEGER,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_planned_type   CHECK (order_type IN ('make','buy')),
      CONSTRAINT chk_planned_status CHECK (status IN ('planned','firmed','converted','ignored'))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_planned_run ON mrp_planned_orders(run_id, low_level_code)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_planned_item ON mrp_planned_orders(item_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_planned_status ON mrp_planned_orders(status)`);

  // ── Exception messages ──
  await knex.raw(`
    CREATE TABLE mrp_exceptions (
      id                SERIAL PRIMARY KEY,
      run_id            INTEGER NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
      company_id        INTEGER,
      item_id           INTEGER,
      item_code         VARCHAR(100),
      item_name         VARCHAR(250),
      exception_type    VARCHAR(40) NOT NULL,
      severity          VARCHAR(10) NOT NULL DEFAULT 'warning',
      message           TEXT,
      need_date         DATE,
      planned_order_id  INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mrp_exc_run ON mrp_exceptions(run_id, severity)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS mrp_exceptions CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS mrp_planned_orders CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS mrp_runs CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS demand_forecasts CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS master_production_schedule CASCADE`);
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP COLUMN IF EXISTS reorder_point,
      DROP COLUMN IF EXISTS min_order_qty,
      DROP COLUMN IF EXISTS max_order_qty,
      DROP COLUMN IF EXISTS lot_size_qty,
      DROP COLUMN IF EXISTS lot_sizing_rule,
      DROP COLUMN IF EXISTS make_or_buy
  `);
}
