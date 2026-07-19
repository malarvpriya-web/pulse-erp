export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS tally_config (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      tally_url     TEXT NOT NULL DEFAULT 'http://localhost:9000',
      company_name  VARCHAR(200),
      fy_start      DATE,
      fy_end        DATE,
      sync_ledgers  BOOLEAN DEFAULT TRUE,
      sync_invoices BOOLEAN DEFAULT TRUE,
      sync_payments BOOLEAN DEFAULT TRUE,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS tally_config_company_idx
    ON tally_config(company_id)
  `);
  // Add tally_synced column to invoices if not already present
  await knex.raw(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS tally_synced BOOLEAN DEFAULT FALSE
  `);
  // Add company_id scoping to tally_sync_log if missing
  await knex.raw(`
    ALTER TABLE tally_sync_log
    ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)
  `);
  await knex.raw(`
    ALTER TABLE tally_ledgers
    ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS tally_sync_log_company_idx
    ON tally_sync_log(company_id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS tally_ledgers_company_idx
    ON tally_ledgers(company_id)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS tally_config CASCADE`);
  await knex.raw(`ALTER TABLE tally_sync_log DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE tally_ledgers DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE invoices DROP COLUMN IF EXISTS tally_synced`);
}
