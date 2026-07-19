/**
 * Production Module Hardening Migration
 * Adds: material_reservations, wip_transactions, production_scrap, production_order_costs
 * Fixes: NCR company_id, routing_steps inspection flag, production_orders cancel status
 */
export async function up(knex) {
  await knex.raw(`
    -- ── material_reservations ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS material_reservations (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL,
      production_order_id  INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      item_id              INTEGER,
      item_name            VARCHAR(255) NOT NULL,
      unit                 VARCHAR(50)  DEFAULT 'pcs',
      qty_required         NUMERIC(15,4) NOT NULL DEFAULT 0,
      qty_reserved         NUMERIC(15,4) NOT NULL DEFAULT 0,
      qty_issued           NUMERIC(15,4) NOT NULL DEFAULT 0,
      qty_consumed         NUMERIC(15,4) NOT NULL DEFAULT 0,
      status               VARCHAR(30)  DEFAULT 'pending'
                             CHECK (status IN ('pending','reserved','partially_issued','fully_issued','consumed','cancelled')),
      bom_line_id          INTEGER,
      reserved_at          TIMESTAMPTZ,
      reserved_by          INTEGER,
      reserved_by_name     VARCHAR(255),
      notes                TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mat_res_order    ON material_reservations(production_order_id);
    CREATE INDEX IF NOT EXISTS idx_mat_res_company  ON material_reservations(company_id);
    CREATE INDEX IF NOT EXISTS idx_mat_res_item     ON material_reservations(item_id);

    -- ── wip_transactions ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS wip_transactions (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL,
      production_order_id  INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      operation_id         INTEGER REFERENCES production_operations(id) ON DELETE SET NULL,
      transaction_type     VARCHAR(30) NOT NULL
                             CHECK (transaction_type IN ('issue','transfer','complete','scrap','reverse')),
      item_id              INTEGER,
      item_name            VARCHAR(255),
      quantity             NUMERIC(15,4) NOT NULL DEFAULT 0,
      unit                 VARCHAR(50)   DEFAULT 'pcs',
      unit_cost            NUMERIC(15,4) DEFAULT 0,
      total_cost           NUMERIC(15,4) DEFAULT 0,
      from_location        VARCHAR(255),
      to_location          VARCHAR(255),
      reservation_id       INTEGER REFERENCES material_reservations(id) ON DELETE SET NULL,
      actor_id             INTEGER,
      actor_name           VARCHAR(255),
      remarks              TEXT,
      transaction_at       TIMESTAMPTZ DEFAULT NOW(),
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_wip_order   ON wip_transactions(production_order_id);
    CREATE INDEX IF NOT EXISTS idx_wip_company ON wip_transactions(company_id);
    CREATE INDEX IF NOT EXISTS idx_wip_type    ON wip_transactions(transaction_type);

    -- ── production_scrap ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS production_scrap (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL,
      production_order_id  INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      operation_id         INTEGER REFERENCES production_operations(id) ON DELETE SET NULL,
      product_name         VARCHAR(255),
      item_id              INTEGER,
      item_name            VARCHAR(255),
      quantity             NUMERIC(15,4) NOT NULL DEFAULT 0,
      unit                 VARCHAR(50)   DEFAULT 'pcs',
      scrap_value          NUMERIC(15,4) DEFAULT 0,
      reason               VARCHAR(255),
      reason_code          VARCHAR(50),
      disposition          VARCHAR(50)   DEFAULT 'scrap'
                             CHECK (disposition IN ('scrap','rework','quarantine','return_to_vendor')),
      scrapped_by          INTEGER,
      scrapped_by_name     VARCHAR(255),
      scrapped_at          TIMESTAMPTZ DEFAULT NOW(),
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_scrap_order   ON production_scrap(production_order_id);
    CREATE INDEX IF NOT EXISTS idx_scrap_company ON production_scrap(company_id);
    CREATE INDEX IF NOT EXISTS idx_scrap_at      ON production_scrap(scrapped_at);

    -- ── production_order_costs ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS production_order_costs (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL,
      production_order_id  INTEGER NOT NULL UNIQUE REFERENCES production_orders(id) ON DELETE CASCADE,
      -- Standard costs (from BOM + routing at time of release)
      std_material_cost    NUMERIC(15,4) DEFAULT 0,
      std_labor_cost       NUMERIC(15,4) DEFAULT 0,
      std_machine_cost     NUMERIC(15,4) DEFAULT 0,
      std_overhead_cost    NUMERIC(15,4) DEFAULT 0,
      std_total_cost       NUMERIC(15,4) DEFAULT 0,
      -- Actual costs (updated during execution)
      actual_material_cost NUMERIC(15,4) DEFAULT 0,
      actual_labor_cost    NUMERIC(15,4) DEFAULT 0,
      actual_machine_cost  NUMERIC(15,4) DEFAULT 0,
      actual_overhead_cost NUMERIC(15,4) DEFAULT 0,
      actual_total_cost    NUMERIC(15,4) DEFAULT 0,
      -- Variance (actual - standard)
      material_variance    NUMERIC(15,4) DEFAULT 0,
      labor_variance       NUMERIC(15,4) DEFAULT 0,
      machine_variance     NUMERIC(15,4) DEFAULT 0,
      total_variance       NUMERIC(15,4) DEFAULT 0,
      quantity_produced    NUMERIC(15,4) DEFAULT 0,
      cost_per_unit        NUMERIC(15,4) DEFAULT 0,
      last_computed_at     TIMESTAMPTZ DEFAULT NOW(),
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_poc_company ON production_order_costs(company_id);

    -- ── Add inspection_step flag to routing_steps ─────────────────────────────
    ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS is_inspection BOOLEAN DEFAULT FALSE;
    ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS setup_time_hrs NUMERIC(10,2) DEFAULT 0;

    -- ── Fix NCR company_id (backfill NULL values to 0 for safety) ────────────
    ALTER TABLE ncr_reports ADD COLUMN IF NOT EXISTS company_id INTEGER;
    UPDATE ncr_reports SET company_id = 0 WHERE company_id IS NULL;

    -- ── production_orders: ensure 'cancelled' is valid but 'draft' never existed
    -- The delete guard was checking for 'draft' which doesn't exist — documented fix in routes

    -- ── material_issue_logs: track material issues per production order ────────
    CREATE TABLE IF NOT EXISTS material_issue_logs (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL,
      production_order_id  INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      reservation_id       INTEGER REFERENCES material_reservations(id) ON DELETE SET NULL,
      item_id              INTEGER,
      item_name            VARCHAR(255) NOT NULL,
      qty_issued           NUMERIC(15,4) NOT NULL DEFAULT 0,
      unit                 VARCHAR(50)  DEFAULT 'pcs',
      unit_cost            NUMERIC(15,4) DEFAULT 0,
      total_cost           NUMERIC(15,4) DEFAULT 0,
      issued_by            INTEGER,
      issued_by_name       VARCHAR(255),
      issued_at            TIMESTAMPTZ DEFAULT NOW(),
      notes                TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mil_order   ON material_issue_logs(production_order_id);
    CREATE INDEX IF NOT EXISTS idx_mil_company ON material_issue_logs(company_id);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS material_issue_logs CASCADE;
    DROP TABLE IF EXISTS production_order_costs CASCADE;
    DROP TABLE IF EXISTS production_scrap CASCADE;
    DROP TABLE IF EXISTS wip_transactions CASCADE;
    DROP TABLE IF EXISTS material_reservations CASCADE;
    ALTER TABLE routing_steps DROP COLUMN IF EXISTS is_inspection;
    ALTER TABLE routing_steps DROP COLUMN IF EXISTS setup_time_hrs;
  `);
}
