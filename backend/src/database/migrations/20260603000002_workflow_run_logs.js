/**
 * 20260603000002_workflow_run_logs.js
 *
 * Adds workflow_run_logs table so every workflow trigger (manual Test or
 * automatic engine execution) is recorded with entity context and duration.
 * The trigger endpoint writes to this table; the GET /:id/runs route reads it.
 *
 * Safe to run multiple times — uses IF NOT EXISTS throughout.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_run_logs (
      id              SERIAL PRIMARY KEY,
      workflow_id     INTEGER      NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
      triggered_at    TIMESTAMPTZ  DEFAULT NOW(),
      status          VARCHAR(50)  DEFAULT 'completed',
      entity_id       INTEGER,
      entity_module   VARCHAR(100),
      duration_ms     INTEGER,
      trigger_data    JSONB        DEFAULT '{}',
      error_message   TEXT,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wrl_workflow_id   ON workflow_run_logs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_wrl_triggered_at  ON workflow_run_logs(triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wrl_entity        ON workflow_run_logs(entity_module, entity_id);
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS workflow_run_logs`);
}
