/**
 * 20261105000005 — every Full & Final calculation is kept (manual §253).
 *
 * A settlement could only be overwritten: exit_requests held one net figure, with no record
 * of how it was reached. Each compute now adds a version here with its lines, warnings,
 * inputs and the rules in force. Rows are never changed, so a figure shown to someone can
 * always be explained later. The application role has insert and read only
 * (APPEND_ONLY_TABLES in scripts/db/app-role-grants.mjs).
 *
 * down() drops the table and its calculations; exit_requests keeps its last net figure.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS fnf_settlements (
      id                 SERIAL PRIMARY KEY,
      exit_request_id    INTEGER NOT NULL REFERENCES exit_requests(id) ON DELETE CASCADE,
      employee_id        INTEGER NOT NULL,
      company_id         INTEGER,
      version            INTEGER NOT NULL,
      separation_type    VARCHAR(50),
      last_working_date  DATE NOT NULL,
      total_payable      NUMERIC(14,2) NOT NULL,
      total_recoverable  NUMERIC(14,2) NOT NULL,
      net_payable        NUMERIC(14,2) NOT NULL,
      lines              JSONB NOT NULL,
      warnings           JSONB NOT NULL DEFAULT '[]',
      inputs             JSONB NOT NULL DEFAULT '{}',
      rules              JSONB NOT NULL,
      rules_unconfirmed  JSONB NOT NULL DEFAULT '[]',
      computed_by        INTEGER,
      computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fnf_settlements_version_unique UNIQUE (exit_request_id, version)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_fnf_settlements_employee ON fnf_settlements (employee_id, computed_at DESC)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS fnf_settlements`);
}
