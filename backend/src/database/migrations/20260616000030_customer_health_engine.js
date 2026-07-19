/**
 * Migration: Phase 49F — Customer Health Score Engine
 * Tables:
 *   customer_health_scores   — current score per customer (upserted on each run)
 *   customer_health_history  — monthly snapshots for 12-month trend (49F-13/24)
 *   customer_health_alerts   — early warning system (49F-14)
 */
export async function up(knex) {

  // ── customer_health_scores ─────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS customer_health_scores (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id      INTEGER NOT NULL,
      customer_name    TEXT,

      -- Composite score (0–100)
      health_score     INTEGER NOT NULL DEFAULT 0,
      health_status    TEXT NOT NULL DEFAULT 'Critical',   -- Excellent|Good|Watchlist|Critical
      segment          TEXT,                               -- Strategic|Key Account|Growth Account|Standard|At-Risk

      -- Dimension scores (sum = health_score)
      revenue_score    INTEGER NOT NULL DEFAULT 0,   -- /20
      collection_score INTEGER NOT NULL DEFAULT 0,   -- /20
      margin_score     INTEGER NOT NULL DEFAULT 0,   -- /15
      project_score    INTEGER NOT NULL DEFAULT 0,   -- /10
      quality_score    INTEGER NOT NULL DEFAULT 0,   -- /10
      service_score    INTEGER NOT NULL DEFAULT 0,   -- /10
      amc_score        INTEGER NOT NULL DEFAULT 0,   -- /5
      engagement_score INTEGER NOT NULL DEFAULT 0,   -- /5
      risk_score       INTEGER NOT NULL DEFAULT 0,   -- /5

      -- Risk flags (49F-15)
      revenue_loss_risk        TEXT DEFAULT 'low',   -- low|medium|high|critical
      payment_default_risk     TEXT DEFAULT 'low',
      project_escalation_risk  TEXT DEFAULT 'low',
      service_escalation_risk  TEXT DEFAULT 'low',
      amc_nonrenewal_risk      TEXT DEFAULT 'low',

      -- Manifest-specific (49F-23)
      fat_success_pct          NUMERIC(5,2),
      sat_success_pct          NUMERIC(5,2),
      commissioning_success_pct NUMERIC(5,2),
      warranty_claims_count    INTEGER DEFAULT 0,
      amc_renewal_pct          NUMERIC(5,2),

      calculated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (company_id, customer_id)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chs_company    ON customer_health_scores(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chs_customer   ON customer_health_scores(customer_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chs_status     ON customer_health_scores(health_status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chs_score      ON customer_health_scores(health_score DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chs_segment    ON customer_health_scores(segment)`);

  // ── customer_health_history ────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS customer_health_history (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id      INTEGER NOT NULL,
      snapshot_month   DATE NOT NULL,         -- first day of month (2026-05-01)

      health_score     INTEGER NOT NULL DEFAULT 0,
      health_status    TEXT NOT NULL DEFAULT 'Critical',
      revenue_score    INTEGER NOT NULL DEFAULT 0,
      collection_score INTEGER NOT NULL DEFAULT 0,
      margin_score     INTEGER NOT NULL DEFAULT 0,
      project_score    INTEGER NOT NULL DEFAULT 0,
      quality_score    INTEGER NOT NULL DEFAULT 0,
      service_score    INTEGER NOT NULL DEFAULT 0,
      amc_score        INTEGER NOT NULL DEFAULT 0,
      engagement_score INTEGER NOT NULL DEFAULT 0,
      risk_score       INTEGER NOT NULL DEFAULT 0,

      -- Trend deltas vs prior month
      score_delta      INTEGER,               -- +/- from previous snapshot
      trend_direction  TEXT,                  -- up|down|stable

      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (company_id, customer_id, snapshot_month)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chh_company    ON customer_health_history(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chh_customer   ON customer_health_history(customer_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chh_month      ON customer_health_history(snapshot_month DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_chh_compound   ON customer_health_history(company_id, customer_id, snapshot_month DESC)`);

  // ── customer_health_alerts ─────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS customer_health_alerts (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id      INTEGER NOT NULL,
      customer_name    TEXT,

      alert_type       TEXT NOT NULL,   -- revenue_drop|overdue_90|low_margin|repeated_ncr|repeated_delays|amc_expired|score_drop
      alert_severity   TEXT NOT NULL DEFAULT 'warning',  -- info|warning|critical
      alert_title      TEXT NOT NULL,
      alert_message    TEXT,
      metric_value     NUMERIC,         -- the triggering metric value
      threshold_value  NUMERIC,         -- the threshold that was breached

      is_read          BOOLEAN NOT NULL DEFAULT FALSE,
      is_resolved      BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at      TIMESTAMPTZ,
      resolved_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,

      triggered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cha_company    ON customer_health_alerts(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cha_customer   ON customer_health_alerts(customer_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cha_severity   ON customer_health_alerts(alert_severity)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cha_resolved   ON customer_health_alerts(is_resolved)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cha_triggered  ON customer_health_alerts(triggered_at DESC)`);

  console.log('✅ Migration 20260616000030_customer_health_engine complete');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS customer_health_alerts CASCADE');
  await knex.raw('DROP TABLE IF EXISTS customer_health_history CASCADE');
  await knex.raw('DROP TABLE IF EXISTS customer_health_scores CASCADE');
}
