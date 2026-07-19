/**
 * 20260522000001_inventory_ddl.js
 *
 * Moves all inventory-related inline DDL out of route-module IIFEs into a
 * tracked migration:
 *
 *  From inventory.routes.js IIFE:
 *    stock_adjustments, stock_adjustment_items,
 *    stock_transfers, stock_transfer_items,
 *    warehouse_transfers, abc_analysis_cache, landed_costs
 *
 *  From advancedInventory.routes.js IIFE:
 *    v_stock_summary view, v_batch_stock view,
 *    v_material_consumption_by_project view,
 *    calculate_available_stock() function
 *
 *  Tables consumed by advancedInventory.routes.js that had no prior migration:
 *    inventory_batches, inventory_reservations,
 *    inventory_allocations, stock_alerts, purchase_suggestions
 */

export async function up(knex) {

  // ── TABLES FROM inventory.routes.js ──────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id                SERIAL PRIMARY KEY,
      adjustment_number VARCHAR(50) UNIQUE NOT NULL,
      warehouse_id      INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      adjustment_date   DATE NOT NULL,
      adjustment_type   VARCHAR(50) NOT NULL,
      reason            TEXT,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      deleted_at        TIMESTAMPTZ
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stock_adjustment_items (
      id            SERIAL PRIMARY KEY,
      adjustment_id INTEGER NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
      item_id       INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      quantity      NUMERIC(15,4) NOT NULL,
      remarks       TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id                SERIAL PRIMARY KEY,
      transfer_number   VARCHAR(50) UNIQUE NOT NULL,
      from_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      to_warehouse_id   INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      transfer_date     DATE NOT NULL,
      transferred_by    INTEGER,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      deleted_at        TIMESTAMPTZ
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id          SERIAL PRIMARY KEY,
      transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
      item_id     INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      quantity    NUMERIC(15,4) NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS warehouse_transfers (
      id                SERIAL PRIMARY KEY,
      transfer_number   VARCHAR(50) UNIQUE NOT NULL,
      from_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      to_warehouse_id   INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      items             JSONB    NOT NULL DEFAULT '[]',
      status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','in-transit','received','cancelled')),
      transfer_date     DATE,
      received_date     DATE,
      notes             TEXT,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      deleted_at        TIMESTAMPTZ
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS abc_analysis_cache (
      id          SERIAL PRIMARY KEY,
      computed_at TIMESTAMPTZ DEFAULT NOW(),
      stats       JSONB,
      items       JSONB
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS landed_costs (
      id                SERIAL PRIMARY KEY,
      po_id             INTEGER,
      freight_cost      NUMERIC(15,2) NOT NULL DEFAULT 0,
      customs_duty      NUMERIC(15,2) NOT NULL DEFAULT 0,
      insurance         NUMERIC(15,2) NOT NULL DEFAULT 0,
      other_charges     NUMERIC(15,2) NOT NULL DEFAULT 0,
      total_landed_cost NUMERIC(15,2) NOT NULL DEFAULT 0,
      allocation_method VARCHAR(20)   NOT NULL DEFAULT 'value'
                          CHECK (allocation_method IN ('value','qty','weight')),
      status            VARCHAR(20)   NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','allocated')),
      allocated_at      TIMESTAMPTZ,
      allocated_items   JSONB,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── TABLES FOR advancedInventory (previously had no migration) ────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_batches (
      id                  SERIAL PRIMARY KEY,
      item_id             INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id        INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      batch_number        VARCHAR(100) NOT NULL,
      received_date       DATE NOT NULL DEFAULT CURRENT_DATE,
      expiry_date         DATE,
      supplier_id         INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      grn_id              INTEGER,
      quantity_received   NUMERIC(15,4) NOT NULL DEFAULT 0,
      quantity_available  NUMERIC(15,4) NOT NULL DEFAULT 0,
      quantity_consumed   NUMERIC(15,4) NOT NULL DEFAULT 0,
      quantity_reserved   NUMERIC(15,4) NOT NULL DEFAULT 0,
      rate                NUMERIC(15,4) NOT NULL DEFAULT 0,
      status              VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','depleted','expired')),
      deleted_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inv_batches_item_wh ON inventory_batches(item_id, warehouse_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id                 SERIAL PRIMARY KEY,
      item_id            INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id       INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      batch_id           INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
      reservation_type   VARCHAR(50),
      reference_type     VARCHAR(50),
      reference_id       INTEGER,
      reference_number   VARCHAR(100),
      quantity_reserved  NUMERIC(15,4) NOT NULL DEFAULT 0,
      quantity_remaining NUMERIC(15,4) NOT NULL DEFAULT 0,
      quantity_consumed  NUMERIC(15,4) NOT NULL DEFAULT 0,
      reserved_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      expiry_date        DATE,
      reserved_by        INTEGER,
      notes              TEXT,
      status             VARCHAR(30) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','partially_consumed','fully_consumed','cancelled','expired')),
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_allocations (
      id              SERIAL PRIMARY KEY,
      item_id         INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      batch_id        INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
      warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      allocation_type VARCHAR(50),
      reference_type  VARCHAR(50),
      reference_id    INTEGER,
      quantity        NUMERIC(15,4) NOT NULL DEFAULT 0,
      rate            NUMERIC(15,4) NOT NULL DEFAULT 0,
      allocation_date DATE NOT NULL DEFAULT CURRENT_DATE,
      allocated_by    INTEGER,
      purpose         TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stock_alerts (
      id               SERIAL PRIMARY KEY,
      item_id          INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id     INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      alert_type       VARCHAR(50) NOT NULL DEFAULT 'low_stock'
                         CHECK (alert_type IN ('low_stock','out_of_stock','expiring_soon','overstock')),
      status           VARCHAR(30) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','acknowledged','resolved')),
      alert_date       DATE NOT NULL DEFAULT CURRENT_DATE,
      acknowledged_by  INTEGER,
      acknowledged_at  TIMESTAMPTZ,
      resolved_at      TIMESTAMPTZ,
      notes            TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS purchase_suggestions (
      id                  SERIAL PRIMARY KEY,
      item_id             INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id        INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      suggested_quantity  NUMERIC(15,4) NOT NULL DEFAULT 0,
      priority            VARCHAR(20) NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('high','medium','low')),
      status              VARCHAR(30) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','converted_to_pr','rejected')),
      generated_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      converted_to_pr_id  INTEGER,
      converted_at        TIMESTAMPTZ,
      rejected_by         INTEGER,
      rejected_at         TIMESTAMPTZ,
      rejection_reason    TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── NORMALIZE warehouses schema before views ──────────────────────────────
  // Some deployments use `name` (from extract_inline_ddl); views need `warehouse_name`.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'warehouses' AND column_name = 'name')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name = 'warehouses' AND column_name = 'warehouse_name')
      THEN
        ALTER TABLE warehouses ADD COLUMN warehouse_name VARCHAR(200);
        UPDATE warehouses SET warehouse_name = name;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'warehouses' AND column_name = 'deleted_at')
      THEN
        ALTER TABLE warehouses ADD COLUMN deleted_at TIMESTAMPTZ;
      END IF;
    END $$
  `);

  // ── VIEWS FROM advancedInventory.routes.js ────────────────────────────────

  await knex.raw(`
    CREATE OR REPLACE VIEW v_stock_summary AS
    SELECT
      ii.id,
      ii.item_code,
      ii.item_name,
      ii.item_type,
      ii.unit_of_measure,
      ii.reorder_level,
      w.id            AS warehouse_id,
      w.warehouse_name,
      COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)                      AS balance,
      COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)                      AS current_stock,
      COALESCE(AVG(NULLIF(sl.rate, 0)), 0)                                    AS avg_rate,
      CASE
        WHEN COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= 0              THEN 'out_of_stock'
        WHEN COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= ii.reorder_level THEN 'low_stock'
        ELSE 'in_stock'
      END AS stock_status
    FROM inventory_items ii
    CROSS JOIN warehouses w
    LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
    WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL
    GROUP BY ii.id, ii.item_code, ii.item_name, ii.item_type, ii.unit_of_measure,
             ii.reorder_level, w.id, w.warehouse_name
  `);

  await knex.raw(`
    CREATE OR REPLACE VIEW v_batch_stock AS
    SELECT
      ib.*,
      ii.item_code,
      ii.item_name,
      ii.unit_of_measure,
      w.warehouse_name,
      (CURRENT_DATE - ib.received_date::date)       AS age_days,
      (ib.quantity_available * ib.rate)              AS stock_value,
      CASE
        WHEN ib.quantity_available <= 0                                                      THEN 'depleted'
        WHEN ib.expiry_date IS NOT NULL AND ib.expiry_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
        ELSE 'active'
      END AS stock_status
    FROM inventory_batches ib
    JOIN inventory_items ii ON ib.item_id  = ii.id
    JOIN warehouses       w  ON ib.warehouse_id = w.id
    WHERE ib.deleted_at IS NULL
  `);

  // v_material_consumption_by_project depends on rm_issues and rm_issue_items
  // which may not exist in all deployments. Create it only when available.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rm_issues')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rm_issue_items')
      THEN
        EXECUTE $view$
          CREATE OR REPLACE VIEW v_material_consumption_by_project AS
          SELECT
            ri.department_id                                    AS project_id,
            d.name                                              AS project_name,
            ii.id                                               AS item_id,
            ii.item_code,
            ii.item_name,
            SUM(rii.quantity)                                   AS total_quantity,
            SUM(rii.quantity * rii.rate)                        AS total_value,
            COUNT(DISTINCT ri.id)                               AS issue_count,
            MAX(ri.issue_date)                                  AS last_issue_date
          FROM rm_issue_items rii
          JOIN rm_issues       ri  ON rii.issue_id = ri.id AND ri.deleted_at IS NULL
          JOIN inventory_items ii  ON rii.item_id  = ii.id
          LEFT JOIN master_departments d ON ri.department_id = d.id
          GROUP BY ri.department_id, d.name, ii.id, ii.item_code, ii.item_name
        $view$;
      END IF;
    END $$
  `);

  // ── FUNCTION FROM advancedInventory.routes.js ─────────────────────────────

  await knex.raw(`
    CREATE OR REPLACE FUNCTION calculate_available_stock(p_item_id INTEGER, p_warehouse_id INTEGER)
    RETURNS NUMERIC AS $$
    DECLARE
      v_total_stock NUMERIC;
      v_reserved    NUMERIC;
    BEGIN
      SELECT COALESCE(SUM(quantity_in - quantity_out), 0)
      INTO   v_total_stock
      FROM   stock_ledger
      WHERE  item_id = p_item_id AND warehouse_id = p_warehouse_id;

      SELECT COALESCE(SUM(quantity_remaining), 0)
      INTO   v_reserved
      FROM   inventory_reservations
      WHERE  item_id = p_item_id AND warehouse_id = p_warehouse_id AND status = 'active';

      RETURN GREATEST(0, v_total_stock - v_reserved);
    END;
    $$ LANGUAGE plpgsql
  `);
}

export async function down(knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS calculate_available_stock(INTEGER, INTEGER)`);
  await knex.raw(`DROP VIEW IF EXISTS v_material_consumption_by_project`);
  await knex.raw(`DROP VIEW IF EXISTS v_batch_stock`);
  await knex.raw(`DROP VIEW IF EXISTS v_stock_summary`);

  const tables = [
    'purchase_suggestions',
    'stock_alerts',
    'inventory_allocations',
    'inventory_reservations',
    'inventory_batches',
    'landed_costs',
    'abc_analysis_cache',
    'warehouse_transfers',
    'stock_transfer_items',
    'stock_transfers',
    'stock_adjustment_items',
    'stock_adjustments',
  ];
  for (const t of tables) {
    await knex.raw(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
