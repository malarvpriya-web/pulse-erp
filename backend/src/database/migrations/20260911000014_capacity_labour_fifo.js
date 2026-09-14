/**
 * Labour capacity, FIFO layers, and the flags that let capacity constrain a plan.
 *
 * CAPACITY
 * --------
 * crpEngine.service.js computed available hours as
 *   capacity_hours_per_day * working_days * efficiency * num_machines
 * which is MACHINE capacity only. work_centre_attendance existed as a table that
 * nothing read, so "labour capacity" was a named SCA component with no
 * implementation. A work centre with four machines and one operator was reported
 * as having four machines' worth of capacity.
 *
 * Effective capacity is now the LESSER of the machine and labour constraints,
 * which is what a bottleneck actually is.
 *
 * FIFO
 * ----
 * stockLedger.repository.js carried the comment "FIFO requires a FIFO-layer
 * table (not yet implemented)" and then silently returned WEIGHTED AVERAGE for a
 * caller who asked for FIFO — a wrong number presented as the requested method,
 * which is worse than an error. inventory_fifo_layers is that table. FEFO uses
 * the same layers ordered by expiry instead of receipt, which is why expiry_date
 * is carried on the layer.
 *
 * MRP FEEDBACK
 * ------------
 * mrp_planned_orders gains capacity and reschedule columns so the engine can say
 * a release is infeasible or must move, rather than emitting an infinite-capacity
 * plan with no comment. Reschedule-in/out were listed as MRP exception types the
 * engine never had.
 */

export async function up(knex) {
  // ── Labour capacity on the work centre ─────────────────────────────────────
  await knex.raw(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS num_operators              INTEGER`);
  await knex.raw(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS labour_hours_per_operator  NUMERIC(6,2)`);
  await knex.raw(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS labour_efficiency_pct      NUMERIC(6,2)`);
  await knex.raw(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS is_bottleneck              BOOLEAN DEFAULT false`);

  // ── Labour on the load grid ────────────────────────────────────────────────
  const loadCols = [
    ['machine_available_hours', 'NUMERIC(12,2)'],
    ['labour_available_hours',  'NUMERIC(12,2)'],
    ['constraint_type',         'VARCHAR(10)'],   // machine | labour
    ['labour_load_pct',         'NUMERIC(8,1)'],
  ];
  for (const [n, t] of loadCols) {
    await knex.raw(`ALTER TABLE crp_load ADD COLUMN IF NOT EXISTS ${n} ${t}`);
  }
  await knex.raw(`ALTER TABLE crp_runs ADD COLUMN IF NOT EXISTS labour_constrained_count INTEGER DEFAULT 0`);

  // ── Capacity + reschedule feedback on planned orders ───────────────────────
  const poCols = [
    ['capacity_status',      'VARCHAR(16)'],   // ok | overloaded | no_capacity_data
    ['capacity_load_pct',    'NUMERIC(8,1)'],
    ['work_centre_id',       'INTEGER'],
    ['reschedule_action',    'VARCHAR(12)'],   // in | out
    ['reschedule_to_date',   'DATE'],
    ['reschedule_reason',    'VARCHAR(120)'],
    ['supply_ref_type',      'VARCHAR(24)'],
    ['supply_ref_id',        'INTEGER'],
  ];
  for (const [n, t] of poCols) {
    await knex.raw(`ALTER TABLE mrp_planned_orders ADD COLUMN IF NOT EXISTS ${n} ${t}`);
  }
  await knex.raw(`ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS capacity_checked          BOOLEAN DEFAULT false`);
  await knex.raw(`ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS capacity_infeasible_count INTEGER DEFAULT 0`);
  await knex.raw(`ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS crp_run_id                INTEGER`);

  // ── FIFO / FEFO layers ─────────────────────────────────────────────────────
  // One layer per receipt at a cost. Consumption depletes layers in order, which
  // is what makes FIFO a valuation method rather than a label.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_fifo_layers (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER,
      item_id           INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id      INTEGER,
      batch_id          INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
      received_date     DATE NOT NULL,
      expiry_date       DATE,
      qty_received      NUMERIC(15,3) NOT NULL,
      qty_remaining     NUMERIC(15,3) NOT NULL,
      unit_cost         NUMERIC(15,4) NOT NULL DEFAULT 0,
      source_type       VARCHAR(24),
      source_id         INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      depleted_at       TIMESTAMPTZ
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_fifo_layers_open
                    ON inventory_fifo_layers(item_id, warehouse_id, received_date)
                  WHERE qty_remaining > 0`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_fifo_layers_expiry
                    ON inventory_fifo_layers(item_id, expiry_date)
                  WHERE qty_remaining > 0 AND expiry_date IS NOT NULL`);

  // How a layer was consumed — the audit trail behind a COGS figure.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_fifo_consumption (
      id                SERIAL PRIMARY KEY,
      layer_id          INTEGER REFERENCES inventory_fifo_layers(id) ON DELETE CASCADE,
      company_id        INTEGER,
      item_id           INTEGER,
      qty               NUMERIC(15,3) NOT NULL,
      unit_cost         NUMERIC(15,4) NOT NULL,
      value             NUMERIC(18,4) NOT NULL,
      reference_type    VARCHAR(24),
      reference_id      INTEGER,
      consumed_at       TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_fifo_consumption_layer ON inventory_fifo_consumption(layer_id)`);

  // ── Put-away ───────────────────────────────────────────────────────────────
  // Goods receipt posted straight to a warehouse with no bin step; there was no
  // put-away anywhere in the codebase.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS putaway_tasks (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      task_no           VARCHAR(40),
      grn_id            INTEGER,
      batch_id          INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
      item_id           INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name         VARCHAR(200),
      quantity          NUMERIC(15,3) NOT NULL,
      from_zone_id      INTEGER,
      to_bin_id         INTEGER,
      to_bin_code       VARCHAR(40),
      status            VARCHAR(16) DEFAULT 'pending',
      assigned_to       INTEGER,
      completed_by      INTEGER,
      completed_by_name VARCHAR(120),
      completed_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_putaway_open ON putaway_tasks(company_id, status) WHERE status <> 'completed'`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS putaway_tasks`);
  await knex.raw(`DROP TABLE IF EXISTS inventory_fifo_consumption`);
  await knex.raw(`DROP TABLE IF EXISTS inventory_fifo_layers`);
  for (const c of ['crp_run_id','capacity_infeasible_count','capacity_checked']) {
    await knex.raw(`ALTER TABLE mrp_runs DROP COLUMN IF EXISTS ${c}`);
  }
  for (const c of ['supply_ref_id','supply_ref_type','reschedule_reason','reschedule_to_date','reschedule_action','work_centre_id','capacity_load_pct','capacity_status']) {
    await knex.raw(`ALTER TABLE mrp_planned_orders DROP COLUMN IF EXISTS ${c}`);
  }
  await knex.raw(`ALTER TABLE crp_runs DROP COLUMN IF EXISTS labour_constrained_count`);
  for (const c of ['labour_load_pct','constraint_type','labour_available_hours','machine_available_hours']) {
    await knex.raw(`ALTER TABLE crp_load DROP COLUMN IF EXISTS ${c}`);
  }
  for (const c of ['is_bottleneck','labour_efficiency_pct','labour_hours_per_operator','num_operators']) {
    await knex.raw(`ALTER TABLE work_centres DROP COLUMN IF EXISTS ${c}`);
  }
}
