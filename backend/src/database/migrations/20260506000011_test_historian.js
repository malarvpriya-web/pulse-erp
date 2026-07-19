export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id                   SERIAL PRIMARY KEY,
      run_number           VARCHAR(60) UNIQUE NOT NULL,
      production_order_id  INTEGER REFERENCES production_orders(id) ON DELETE SET NULL,
      product_id           INTEGER,
      product_name         VARCHAR(250),
      serial_number        VARCHAR(120),
      test_stage           VARCHAR(40) NOT NULL DEFAULT 'FAT',
      test_type            VARCHAR(80) NOT NULL,
      test_spec_revision   VARCHAR(80),
      station_name         VARCHAR(120),
      started_at           TIMESTAMPTZ,
      completed_at         TIMESTAMPTZ,
      overall_result       VARCHAR(20) NOT NULL DEFAULT 'in_progress',
      remarks              TEXT,
      executed_by          INTEGER,
      executed_by_name     VARCHAR(150),
      approved_by          INTEGER,
      approved_by_name     VARCHAR(150),
      approved_at          TIMESTAMPTZ,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_test_runs_stage CHECK (test_stage IN ('IQC','FAT','SAT','RMA','prototype')),
      CONSTRAINT chk_test_runs_result CHECK (overall_result IN ('in_progress','pass','fail','hold'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS test_run_measurements (
      id              SERIAL PRIMARY KEY,
      test_run_id     INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
      parameter_code  VARCHAR(60),
      parameter_name  VARCHAR(200) NOT NULL,
      unit            VARCHAR(40),
      measured_value  NUMERIC(18,6),
      min_limit       NUMERIC(18,6),
      max_limit       NUMERIC(18,6),
      target_value    NUMERIC(18,6),
      result          VARCHAR(20) NOT NULL DEFAULT 'pending',
      measurement_ts  TIMESTAMPTZ DEFAULT NOW(),
      channel_ref     VARCHAR(60),
      waveform_ref    TEXT,
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_test_run_measurements_result CHECK (result IN ('pending','pass','fail','na'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS test_run_attachments (
      id              SERIAL PRIMARY KEY,
      test_run_id     INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
      file_name       VARCHAR(300) NOT NULL,
      file_path       TEXT,
      file_type       VARCHAR(80),
      uploaded_by     INTEGER,
      uploaded_by_name VARCHAR(150),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_test_runs_order ON test_runs(production_order_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_test_runs_serial ON test_runs(serial_number)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_test_runs_stage_result ON test_runs(test_stage, overall_result)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_test_run_measurements_run ON test_run_measurements(test_run_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS test_run_attachments CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS test_run_measurements CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS test_runs CASCADE`);
}
