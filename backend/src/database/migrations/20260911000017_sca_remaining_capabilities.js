/**
 * The fifteen SCA components that were still missing after the first remediation.
 *
 * Four of them were described in that report as "needs external data or
 * hardware", which conflated two different things: the SOFTWARE capability, and
 * the DATA or DEVICE that makes its output meaningful. Those are separable, and
 * treating them as one thing is how a gap stays open indefinitely.
 *
 *   Causal forecasting  needs demand DRIVERS. The regression is ordinary
 *     software; what was missing was somewhere to put a driver series. Pulse
 *     already holds two genuine leading indicators for a panel builder — open
 *     opportunity value and the tender pipeline — so the drivers can be internal.
 *
 *   RFID  needs a READER. Resolving an EPC to an item, lot or serial, and
 *     recording where it was seen, is a database problem. Built now; a reader
 *     posts to it when one exists.
 *
 *   Supplier capacity  needs SUPPLIERS TO DECLARE IT. The model and the MRP
 *     consumption are buildable today; the declaration is an operational task.
 *
 *   Route planning  needs a distance/traffic API for true optimisation. Grouping
 *     shipments into routes and sequencing stops does not.
 *
 * Everything built here returns NULL or an explicit "not measured" when the data
 * behind it is absent. That is the whole point: a capability that fabricates a
 * number when it has no input is worse than one that is missing, because the
 * missing one is at least honest about it.
 */

export async function up(knex) {
  // ── Causal forecasting: demand drivers ─────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS forecast_drivers (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      driver_code   VARCHAR(40) NOT NULL,
      driver_name   VARCHAR(150) NOT NULL,
      description   TEXT,
      source_type   VARCHAR(24) NOT NULL DEFAULT 'manual',
      unit          VARCHAR(30),
      lag_periods   INTEGER NOT NULL DEFAULT 0,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_forecast_drivers_code
                    ON forecast_drivers(company_id, driver_code)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS forecast_driver_values (
      id            SERIAL PRIMARY KEY,
      driver_id     INTEGER REFERENCES forecast_drivers(id) ON DELETE CASCADE,
      company_id    INTEGER,
      period_start  DATE NOT NULL,
      value         NUMERIC(18,4) NOT NULL,
      is_actual     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_period
                    ON forecast_driver_values(driver_id, period_start)`);

  // Which drivers an item's demand is modelled against, and how well they fit.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS item_demand_drivers (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER,
      item_id       INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      driver_id     INTEGER REFERENCES forecast_drivers(id) ON DELETE CASCADE,
      coefficient   NUMERIC(18,6),
      r_squared     NUMERIC(8,5),
      fitted_at     TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_item_driver
                    ON item_demand_drivers(item_id, driver_id)`);

  // ── Supplier capacity ──────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS supplier_capacity (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      vendor_id       INTEGER REFERENCES vendors(id) ON DELETE CASCADE,
      item_id         INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      period_start    DATE NOT NULL,
      period_end      DATE NOT NULL,
      capacity_qty    NUMERIC(15,3) NOT NULL,
      committed_qty   NUMERIC(15,3) NOT NULL DEFAULT 0,
      uom             VARCHAR(20),
      source          VARCHAR(20) NOT NULL DEFAULT 'declared',
      declared_at     TIMESTAMPTZ,
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_supplier_capacity_lookup
                    ON supplier_capacity(item_id, period_start, period_end)`);

  // ── What-if / scenario planning ────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS planning_scenarios (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      name            VARCHAR(150) NOT NULL,
      description     TEXT,
      scenario_type   VARCHAR(24) NOT NULL DEFAULT 'what_if',
      baseline_mrp_run_id INTEGER,
      mrp_run_id      INTEGER,
      crp_run_id      INTEGER,
      adjustments     JSONB NOT NULL DEFAULT '{}'::jsonb,
      results         JSONB,
      status          VARCHAR(16) NOT NULL DEFAULT 'draft',
      created_by      INTEGER,
      created_by_name VARCHAR(120),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_scenarios_company
                    ON planning_scenarios(company_id, created_at DESC)`);

  // ── JIT / kanban ───────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS kanban_loops (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      loop_code       VARCHAR(40),
      item_id         INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      supply_source   VARCHAR(16) NOT NULL DEFAULT 'supplier',
      vendor_id       INTEGER,
      work_centre_id  INTEGER,
      consuming_location VARCHAR(80),
      supplying_location VARCHAR(80),
      container_qty   NUMERIC(15,3) NOT NULL,
      card_count      INTEGER NOT NULL,
      replenish_lead_hours NUMERIC(8,2),
      status          VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_kanban_loop_code
                    ON kanban_loops(company_id, loop_code)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id              SERIAL PRIMARY KEY,
      loop_id         INTEGER REFERENCES kanban_loops(id) ON DELETE CASCADE,
      company_id      INTEGER,
      card_no         VARCHAR(40),
      status          VARCHAR(16) NOT NULL DEFAULT 'full',
      quantity        NUMERIC(15,3),
      signalled_at    TIMESTAMPTZ,
      replenished_at  TIMESTAMPTZ,
      reference_type  VARCHAR(24),
      reference_id    INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kanban_cards_loop ON kanban_cards(loop_id, status)`);

  // ── Unit loads (pallets) ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS unit_loads (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      unit_load_no    VARCHAR(40),
      load_type       VARCHAR(24) NOT NULL DEFAULT 'pallet',
      sscc            VARCHAR(24),
      warehouse_id    INTEGER,
      bin_id          INTEGER,
      shipment_id     INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
      gross_weight_kg NUMERIC(12,3),
      height_cm       NUMERIC(10,2),
      status          VARCHAR(16) NOT NULL DEFAULT 'open',
      built_by_name   VARCHAR(120),
      built_at        TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_unit_load_no ON unit_loads(unit_load_no)`);
  await knex.raw(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS unit_load_id INTEGER`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'packages_unit_load_id_fkey') THEN
        ALTER TABLE packages ADD CONSTRAINT packages_unit_load_id_fkey
          FOREIGN KEY (unit_load_id) REFERENCES unit_loads(id) ON DELETE SET NULL;
      END IF;
    END $$;`);

  // ── Material-handling equipment ────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS mhe_equipment (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      equipment_code  VARCHAR(40),
      equipment_name  VARCHAR(150) NOT NULL,
      equipment_type  VARCHAR(30) NOT NULL DEFAULT 'forklift',
      warehouse_id    INTEGER,
      capacity_kg     NUMERIC(12,2),
      status          VARCHAR(16) NOT NULL DEFAULT 'available',
      asset_id        INTEGER,
      last_service_date DATE,
      next_service_date DATE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mhe_code ON mhe_equipment(company_id, equipment_code)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS mhe_assignments (
      id              SERIAL PRIMARY KEY,
      equipment_id    INTEGER REFERENCES mhe_equipment(id) ON DELETE CASCADE,
      company_id      INTEGER,
      task_type       VARCHAR(24) NOT NULL,
      reference_type  VARCHAR(24),
      reference_id    INTEGER,
      operator_name   VARCHAR(120),
      assigned_at     TIMESTAMPTZ DEFAULT NOW(),
      released_at     TIMESTAMPTZ,
      notes           TEXT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mhe_assign_open
                    ON mhe_assignments(equipment_id) WHERE released_at IS NULL`);

  // ── RFID ───────────────────────────────────────────────────────────────────
  // The tag is an identifier bound to something already traceable. Deliberately
  // nullable across item / batch / serial / unit load: a tag on a pallet and a
  // tag on a single serialised panel are both legitimate.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rfid_tags (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      epc             VARCHAR(64) NOT NULL,
      tag_type        VARCHAR(20) NOT NULL DEFAULT 'passive',
      item_id         INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      batch_id        INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
      serial_id       INTEGER REFERENCES serial_numbers(id) ON DELETE SET NULL,
      unit_load_id    INTEGER REFERENCES unit_loads(id) ON DELETE SET NULL,
      status          VARCHAR(16) NOT NULL DEFAULT 'active',
      commissioned_at TIMESTAMPTZ DEFAULT NOW(),
      decommissioned_at TIMESTAMPTZ
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rfid_epc ON rfid_tags(epc)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rfid_batch ON rfid_tags(batch_id) WHERE batch_id IS NOT NULL`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rfid_scans (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      tag_id          INTEGER REFERENCES rfid_tags(id) ON DELETE CASCADE,
      epc             VARCHAR(64) NOT NULL,
      reader_id       VARCHAR(60),
      location_code   VARCHAR(60),
      warehouse_id    INTEGER,
      bin_id          INTEGER,
      scan_type       VARCHAR(24),
      scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw             JSONB
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rfid_scans_tag ON rfid_scans(tag_id, scanned_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rfid_scans_epc ON rfid_scans(epc, scanned_at DESC)`);

  // ── Delivery routes ────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS delivery_routes (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      route_no        VARCHAR(40),
      route_name      VARCHAR(150),
      route_date      DATE NOT NULL,
      carrier_id      INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
      vehicle_ref     VARCHAR(60),
      driver_name     VARCHAR(120),
      region          VARCHAR(80),
      status          VARCHAR(16) NOT NULL DEFAULT 'planned',
      stop_count      INTEGER DEFAULT 0,
      total_weight_kg NUMERIC(12,3),
      planned_by_name VARCHAR(120),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_route_no ON delivery_routes(route_no)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS route_stops (
      id              SERIAL PRIMARY KEY,
      route_id        INTEGER REFERENCES delivery_routes(id) ON DELETE CASCADE,
      company_id      INTEGER,
      stop_seq        INTEGER NOT NULL,
      shipment_id     INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
      sales_order_id  INTEGER,
      customer_name   VARCHAR(200),
      address         TEXT,
      city            VARCHAR(100),
      promised_date   DATE,
      weight_kg       NUMERIC(12,3),
      status          VARCHAR(16) NOT NULL DEFAULT 'pending',
      arrived_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id, stop_seq)`);

  // ── Predictive maintenance -> capacity ─────────────────────────────────────
  // Planned downtime removes hours from a work centre. CRP computed available
  // hours from a static capacity figure, so a machine booked out for a service
  // still showed a full week of capacity.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS work_centre_downtime (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      work_centre_id  INTEGER REFERENCES work_centres(id) ON DELETE CASCADE,
      downtime_type   VARCHAR(24) NOT NULL DEFAULT 'planned_maintenance',
      start_at        TIMESTAMPTZ NOT NULL,
      end_at          TIMESTAMPTZ NOT NULL,
      hours_lost      NUMERIC(10,2),
      maintenance_id  INTEGER,
      probability_pct NUMERIC(5,2),
      reason          TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_wc_downtime_window
                    ON work_centre_downtime(work_centre_id, start_at, end_at)`);

  // ── Excess / obsolete policy ───────────────────────────────────────────────
  // Thresholds are configuration, not constants: "excess" means something
  // different for a 21-day-lead copper busbar than for a terminal block.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_policy_settings (
      company_id            INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      excess_cover_days     INTEGER NOT NULL DEFAULT 180,
      obsolete_no_movement_days INTEGER NOT NULL DEFAULT 365,
      slow_moving_turns     NUMERIC(6,2) NOT NULL DEFAULT 2.0,
      near_expiry_days      INTEGER NOT NULL DEFAULT 90,
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )`);

  // ── FIFO layer linkage on the ledger ───────────────────────────────────────
  await knex.raw(`ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS fifo_layer_id INTEGER`);
  await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS valuation_method VARCHAR(20)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS valuation_method`);
  await knex.raw(`ALTER TABLE stock_ledger DROP COLUMN IF EXISTS fifo_layer_id`);
  await knex.raw(`DROP TABLE IF EXISTS inventory_policy_settings`);
  await knex.raw(`DROP TABLE IF EXISTS work_centre_downtime`);
  await knex.raw(`DROP TABLE IF EXISTS route_stops`);
  await knex.raw(`DROP TABLE IF EXISTS delivery_routes`);
  await knex.raw(`DROP TABLE IF EXISTS rfid_scans`);
  await knex.raw(`DROP TABLE IF EXISTS rfid_tags`);
  await knex.raw(`DROP TABLE IF EXISTS mhe_assignments`);
  await knex.raw(`DROP TABLE IF EXISTS mhe_equipment`);
  await knex.raw(`ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_unit_load_id_fkey`);
  await knex.raw(`ALTER TABLE packages DROP COLUMN IF EXISTS unit_load_id`);
  await knex.raw(`DROP TABLE IF EXISTS unit_loads`);
  await knex.raw(`DROP TABLE IF EXISTS kanban_cards`);
  await knex.raw(`DROP TABLE IF EXISTS kanban_loops`);
  await knex.raw(`DROP TABLE IF EXISTS planning_scenarios`);
  await knex.raw(`DROP TABLE IF EXISTS supplier_capacity`);
  await knex.raw(`DROP TABLE IF EXISTS item_demand_drivers`);
  await knex.raw(`DROP TABLE IF EXISTS forecast_driver_values`);
  await knex.raw(`DROP TABLE IF EXISTS forecast_drivers`);
}
