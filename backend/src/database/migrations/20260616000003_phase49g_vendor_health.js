/**
 * Phase 49G — Vendor Health Score Engine
 *
 * Creates: vendor_health_scores, vendor_health_timeline,
 *          vendor_strategic_flags, vendor_early_warnings
 */
export async function up(knex) {
  const raw = sql => knex.raw(sql);

  // ── 1. vendor_health_scores ──────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_health_scores (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER NOT NULL,
      vendor_id         INTEGER NOT NULL,
      health_score      NUMERIC(5,2) DEFAULT 0,
      health_status     VARCHAR(20)  DEFAULT 'Watchlist',
      quality_score     NUMERIC(5,2) DEFAULT 0,
      delivery_score    NUMERIC(5,2) DEFAULT 0,
      cost_score        NUMERIC(5,2) DEFAULT 0,
      support_score     NUMERIC(5,2) DEFAULT 0,
      compliance_score  NUMERIC(5,2) DEFAULT 0,
      financial_score   NUMERIC(5,2) DEFAULT 0,
      dependency_score  NUMERIC(5,2) DEFAULT 0,
      risk_score        NUMERIC(5,2) DEFAULT 0,
      otd_pct           NUMERIC(5,2) DEFAULT 0,
      pass_rate_pct     NUMERIC(5,2) DEFAULT 0,
      open_ncr_count    INTEGER      DEFAULT 0,
      capa_closure_pct  NUMERIC(5,2) DEFAULT 0,
      calculated_at     TIMESTAMPTZ  DEFAULT NOW(),
      created_at        TIMESTAMPTZ  DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (company_id, vendor_id)
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vhs_company_id    ON vendor_health_scores(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vhs_vendor_id     ON vendor_health_scores(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vhs_health_status ON vendor_health_scores(health_status)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vhs_health_score  ON vendor_health_scores(health_score DESC)`);

  // ── 2. vendor_health_timeline (monthly snapshots) ────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_health_timeline (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL,
      vendor_id      INTEGER NOT NULL,
      snapshot_month DATE    NOT NULL,
      health_score   NUMERIC(5,2) DEFAULT 0,
      health_status  VARCHAR(20)  DEFAULT 'Watchlist',
      quality_score  NUMERIC(5,2) DEFAULT 0,
      delivery_score NUMERIC(5,2) DEFAULT 0,
      cost_score     NUMERIC(5,2) DEFAULT 0,
      compliance_score NUMERIC(5,2) DEFAULT 0,
      notes          TEXT,
      created_at     TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (company_id, vendor_id, snapshot_month)
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vht_vendor_id     ON vendor_health_timeline(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vht_company_id    ON vendor_health_timeline(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vht_snapshot_month ON vendor_health_timeline(snapshot_month DESC)`);

  // ── 3. vendor_strategic_flags ────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_strategic_flags (
      id                    SERIAL PRIMARY KEY,
      company_id            INTEGER NOT NULL,
      vendor_id             INTEGER NOT NULL UNIQUE,
      is_critical_supplier  BOOLEAN DEFAULT FALSE,
      is_single_source      BOOLEAN DEFAULT FALSE,
      is_long_lead          BOOLEAN DEFAULT FALSE,
      is_high_spend         BOOLEAN DEFAULT FALSE,
      is_project_critical   BOOLEAN DEFAULT FALSE,
      high_spend_threshold  NUMERIC(18,2),
      notes                 TEXT,
      flagged_by            INTEGER,
      flagged_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vsf_company_id ON vendor_strategic_flags(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vsf_vendor_id  ON vendor_strategic_flags(vendor_id)`);

  // ── 4. vendor_early_warnings ─────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_early_warnings (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL,
      vendor_id       INTEGER NOT NULL,
      warning_type    VARCHAR(50) NOT NULL,
      severity        VARCHAR(20) DEFAULT 'Medium',
      message         TEXT        NOT NULL,
      metric_value    NUMERIC(10,2),
      threshold_value NUMERIC(10,2),
      is_active       BOOLEAN     DEFAULT TRUE,
      acknowledged_by INTEGER,
      acknowledged_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vew_company_id    ON vendor_early_warnings(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vew_vendor_id     ON vendor_early_warnings(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vew_warning_type  ON vendor_early_warnings(warning_type)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vew_is_active     ON vendor_early_warnings(is_active) WHERE is_active = TRUE`);
}

export async function down(knex) {
  const raw = sql => knex.raw(sql);
  await raw(`DROP TABLE IF EXISTS vendor_early_warnings`);
  await raw(`DROP TABLE IF EXISTS vendor_strategic_flags`);
  await raw(`DROP TABLE IF EXISTS vendor_health_timeline`);
  await raw(`DROP TABLE IF EXISTS vendor_health_scores`);
}
