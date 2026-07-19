export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS company_integrations (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER      NOT NULL DEFAULT 0,
      integration_key  VARCHAR(50)  NOT NULL,
      credentials_enc  TEXT         NOT NULL DEFAULT '',
      status           VARCHAR(20)  NOT NULL DEFAULT 'not_configured',
      last_tested_at   TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, integration_key)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_company_integrations_cid
      ON company_integrations(company_id)
  `);

  // If a legacy "integrations" table exists without company_id, add it safely.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'integrations'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'integrations' AND column_name = 'company_id'
      ) THEN
        ALTER TABLE integrations
          ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_integrations_company_id ON integrations(company_id);
      END IF;
    END$$
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS company_integrations`);
}
