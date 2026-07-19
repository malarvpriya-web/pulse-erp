export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS lifecycle_instances (
      id                   SERIAL PRIMARY KEY,
      lifecycle_number     VARCHAR(60) UNIQUE NOT NULL,
      sales_order_id       INTEGER,
      production_order_id  INTEGER REFERENCES production_orders(id) ON DELETE SET NULL,
      project_id           INTEGER,
      customer_id          INTEGER,
      current_stage        VARCHAR(40) NOT NULL DEFAULT 'order',
      status               VARCHAR(20) NOT NULL DEFAULT 'active',
      stage_started_at     TIMESTAMPTZ DEFAULT NOW(),
      stage_completed_at   TIMESTAMPTZ,
      stage_notes          TEXT,
      created_by           INTEGER,
      created_by_name      VARCHAR(150),
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_lifecycle_instances_stage
        CHECK (current_stage IN ('order','design','procurement','production','testing','dispatch','installation','service','amc')),
      CONSTRAINT chk_lifecycle_instances_status
        CHECK (status IN ('active','completed','on_hold','cancelled'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS lifecycle_stage_history (
      id                     SERIAL PRIMARY KEY,
      lifecycle_instance_id  INTEGER NOT NULL REFERENCES lifecycle_instances(id) ON DELETE CASCADE,
      from_stage             VARCHAR(40),
      to_stage               VARCHAR(40) NOT NULL,
      action                 VARCHAR(20) NOT NULL DEFAULT 'advance',
      remarks                TEXT,
      actor_id               INTEGER,
      actor_name             VARCHAR(150),
      gate_snapshot          JSONB DEFAULT '{}',
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_lifecycle_stage_history_action
        CHECK (action IN ('advance','rollback','hold','resume','complete'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commissioning_reports (
      id                   SERIAL PRIMARY KEY,
      lifecycle_instance_id INTEGER REFERENCES lifecycle_instances(id) ON DELETE SET NULL,
      sales_order_id       INTEGER,
      site_name            VARCHAR(250),
      site_address         TEXT,
      commissioning_date   DATE,
      engineer_name        VARCHAR(150),
      status               VARCHAR(20) NOT NULL DEFAULT 'open',
      checklist            JSONB DEFAULT '[]',
      punch_points         JSONB DEFAULT '[]',
      remarks              TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_commissioning_reports_status
        CHECK (status IN ('open','in_progress','completed','failed'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS amc_contracts (
      id                   SERIAL PRIMARY KEY,
      lifecycle_instance_id INTEGER REFERENCES lifecycle_instances(id) ON DELETE SET NULL,
      sales_order_id       INTEGER,
      contract_number      VARCHAR(60) UNIQUE NOT NULL,
      start_date           DATE NOT NULL,
      end_date             DATE NOT NULL,
      sla_response_hours   INTEGER DEFAULT 24,
      preventive_visits_per_year INTEGER DEFAULT 4,
      status               VARCHAR(20) NOT NULL DEFAULT 'active',
      coverage_notes       TEXT,
      created_by           INTEGER,
      created_by_name      VARCHAR(150),
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_amc_contracts_status
        CHECK (status IN ('draft','active','expired','cancelled'))
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_lifecycle_instances_so ON lifecycle_instances(sales_order_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_lifecycle_instances_stage ON lifecycle_instances(current_stage)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_lifecycle_history_instance ON lifecycle_stage_history(lifecycle_instance_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS amc_contracts CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS commissioning_reports CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS lifecycle_stage_history CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS lifecycle_instances CASCADE`);
}
