export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS production_orders (
      id                   SERIAL PRIMARY KEY,
      production_order_no  VARCHAR(50) UNIQUE NOT NULL,
      project_id           INTEGER,
      sales_order_id       INTEGER,
      bom_id               INTEGER REFERENCES bom_headers(id) ON DELETE SET NULL,
      product_id           INTEGER,
      product_name         VARCHAR(250) NOT NULL,
      quantity_planned     NUMERIC(14,3) NOT NULL,
      quantity_completed   NUMERIC(14,3) NOT NULL DEFAULT 0,
      quantity_scrapped    NUMERIC(14,3) NOT NULL DEFAULT 0,
      status               VARCHAR(30) NOT NULL DEFAULT 'planned',
      priority             VARCHAR(20) NOT NULL DEFAULT 'medium',
      planned_start_date   DATE,
      planned_end_date     DATE,
      actual_start_at      TIMESTAMPTZ,
      actual_end_at        TIMESTAMPTZ,
      released_by          INTEGER,
      released_by_name     VARCHAR(150),
      notes                TEXT,
      created_by           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_production_orders_status
        CHECK (status IN ('planned','released','in_progress','on_hold','completed','cancelled')),
      CONSTRAINT chk_production_orders_priority
        CHECK (priority IN ('low','medium','high','critical'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS production_operations (
      id                    SERIAL PRIMARY KEY,
      production_order_id   INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      routing_step_id       INTEGER REFERENCES routing_steps(id) ON DELETE SET NULL,
      step_no               INTEGER NOT NULL,
      operation             VARCHAR(250) NOT NULL,
      work_centre_id        INTEGER REFERENCES work_centres(id) ON DELETE SET NULL,
      work_centre_name      VARCHAR(150),
      std_time_hrs          NUMERIC(10,3) DEFAULT 0,
      status                VARCHAR(30) NOT NULL DEFAULT 'pending',
      quantity_in           NUMERIC(14,3) DEFAULT 0,
      quantity_out          NUMERIC(14,3) DEFAULT 0,
      quantity_scrap        NUMERIC(14,3) DEFAULT 0,
      started_at            TIMESTAMPTZ,
      completed_at          TIMESTAMPTZ,
      assigned_to           INTEGER,
      assigned_to_name      VARCHAR(150),
      notes                 TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_production_operations_status
        CHECK (status IN ('pending','ready','in_progress','on_hold','completed','skipped'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS production_operation_logs (
      id                    SERIAL PRIMARY KEY,
      production_operation_id INTEGER NOT NULL REFERENCES production_operations(id) ON DELETE CASCADE,
      production_order_id   INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      event_type            VARCHAR(40) NOT NULL,
      quantity_delta        NUMERIC(14,3) DEFAULT 0,
      scrap_delta           NUMERIC(14,3) DEFAULT 0,
      remarks               TEXT,
      actor_id              INTEGER,
      actor_name            VARCHAR(150),
      event_data            JSONB DEFAULT '{}',
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_production_operation_logs_event
        CHECK (event_type IN ('start','pause','resume','complete','scrap','rework','note','status_change'))
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_production_orders_status ON production_orders(status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_production_orders_project ON production_orders(project_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_production_operations_order ON production_operations(production_order_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_production_operations_status ON production_operations(status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_production_operation_logs_order ON production_operation_logs(production_order_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS production_operation_logs CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS production_operations CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS production_orders CASCADE`);
}
