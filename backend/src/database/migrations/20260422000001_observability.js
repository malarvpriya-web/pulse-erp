export async function up(knex) {
  // schema_migrations is created by the runner before any migration runs,
  // but ensure it here too so this file is self-contained.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      name        TEXT        NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INT
    )
  `);

  // Structured health-check history — one row per monitor tick
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS health_checks (
      id          SERIAL PRIMARY KEY,
      checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status      TEXT        NOT NULL,   -- 'ok' | 'error'
      db_ms       INT,
      uptime_s    INT,
      memory_mb   INT,
      error       TEXT
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_health_checks_time ON health_checks (checked_at DESC)
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS health_checks');
  // schema_migrations intentionally NOT dropped — the runner owns that table
}
