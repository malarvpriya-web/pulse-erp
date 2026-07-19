/**
 * Migration: Forex Management tables
 * Creates company-scoped forex_rates, forex_rate_history, and forex_revaluations.
 * These are simpler than the UUID-based exchange_rates in enterprise-extensions-schema
 * and are purpose-built for the Forex Management UI (live rates, sparklines, revaluation).
 */

export async function up(knex) {
  const exec = (sql) => knex.raw(sql).catch(() => {});

  await exec(`
    CREATE TABLE IF NOT EXISTS forex_rates (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL,
      currency_code VARCHAR(3) NOT NULL,
      currency_name VARCHAR(100) NOT NULL DEFAULT '',
      rate_vs_inr   NUMERIC(15,6) NOT NULL,
      rate_date     DATE NOT NULL DEFAULT CURRENT_DATE,
      fetched_at    TIMESTAMPTZ DEFAULT NOW(),
      source        VARCHAR(20) NOT NULL DEFAULT 'manual',
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, currency_code)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS forex_rate_history (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL,
      currency_code VARCHAR(3) NOT NULL,
      rate_vs_inr   NUMERIC(15,6) NOT NULL,
      rate_date     DATE NOT NULL,
      source        VARCHAR(20) NOT NULL DEFAULT 'api',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, currency_code, rate_date)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS forex_revaluations (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL,
      revaluation_date DATE NOT NULL,
      period           VARCHAR(20),
      status           VARCHAR(20) NOT NULL DEFAULT 'draft',
      total_gain       NUMERIC(15,2) DEFAULT 0,
      total_loss       NUMERIC(15,2) DEFAULT 0,
      net_pgl          NUMERIC(15,2) DEFAULT 0,
      details          JSONB DEFAULT '[]',
      created_by       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await exec(`CREATE INDEX IF NOT EXISTS idx_forex_rates_company
    ON forex_rates(company_id, is_active)`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_forex_rate_history_lookup
    ON forex_rate_history(company_id, currency_code, rate_date DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_forex_revaluations_company
    ON forex_revaluations(company_id, revaluation_date DESC)`);
}

export async function down(knex) {
  const exec = (sql) => knex.raw(sql).catch(() => {});
  await exec(`DROP TABLE IF EXISTS forex_revaluations`);
  await exec(`DROP TABLE IF EXISTS forex_rate_history`);
  await exec(`DROP TABLE IF EXISTS forex_rates`);
}
