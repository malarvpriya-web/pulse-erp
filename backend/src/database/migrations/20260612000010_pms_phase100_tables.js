/**
 * PMS Phase 100 — Complete Performance Management Schema
 * Adds all tables required for: KRA framework, 360 feedback, calibration,
 * bell curve, increment planning, promotion planning, OKR management,
 * and review cycle management.
 */
export async function up(knex) {
  const raw = sql => knex.raw(sql);

  /* ── 1. review_cycles enhancements ──────────────────────────────────────── */
  await raw(`
    ALTER TABLE review_cycles
      ADD COLUMN IF NOT EXISTS company_id            INT REFERENCES companies(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS cycle_type            TEXT NOT NULL DEFAULT 'annual'
                                                     CHECK (cycle_type IN ('annual','half_yearly','quarterly','project','probation')),
      ADD COLUMN IF NOT EXISTS self_review_deadline  DATE,
      ADD COLUMN IF NOT EXISTS manager_review_deadline DATE,
      ADD COLUMN IF NOT EXISTS calibration_deadline  DATE,
      ADD COLUMN IF NOT EXISTS l2_review_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS hr_review_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS status                TEXT NOT NULL DEFAULT 'draft'
                                                     CHECK (status IN ('draft','active','calibration','closed')),
      ADD COLUMN IF NOT EXISTS financial_year        TEXT,
      ADD COLUMN IF NOT EXISTS description           TEXT
  `);

  await raw(`
    CREATE INDEX IF NOT EXISTS idx_review_cycles_company ON review_cycles(company_id)
  `);

  /* ── 2. performance_reviews enhancements ────────────────────────────────── */
  await raw(`
    ALTER TABLE performance_reviews
      ADD COLUMN IF NOT EXISTS calibrated_rating   NUMERIC(3,2),
      ADD COLUMN IF NOT EXISTS hr_comments         TEXT,
      ADD COLUMN IF NOT EXISTS hr_reviewer_id      INT REFERENCES employees(id),
      ADD COLUMN IF NOT EXISTS hr_submitted_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS pip_recommended     BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS l2_rating           NUMERIC(3,2),
      ADD COLUMN IF NOT EXISTS l2_comments         TEXT,
      ADD COLUMN IF NOT EXISTS l2_reviewer_id      INT REFERENCES employees(id),
      ADD COLUMN IF NOT EXISTS l2_submitted_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS evidence_urls       JSONB DEFAULT '[]'::jsonb
  `);

  /* ── 3. performance_goals enhancements ──────────────────────────────────── */
  await raw(`
    ALTER TABLE performance_goals
      ADD COLUMN IF NOT EXISTS goal_type      TEXT NOT NULL DEFAULT 'individual'
                                              CHECK (goal_type IN ('individual','department','company','okr_aligned')),
      ADD COLUMN IF NOT EXISTS parent_goal_id INT REFERENCES performance_goals(id),
      ADD COLUMN IF NOT EXISTS department_id  INT,
      ADD COLUMN IF NOT EXISTS cycle_id       INT REFERENCES review_cycles(id),
      ADD COLUMN IF NOT EXISTS unit           TEXT,
      ADD COLUMN IF NOT EXISTS company_id     INT REFERENCES companies(id)
  `);

  /* ── 4. competency_definitions (master library) ─────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS competency_definitions (
      id                  SERIAL PRIMARY KEY,
      company_id          INT REFERENCES companies(id) ON DELETE CASCADE,
      name                TEXT NOT NULL,
      description         TEXT,
      competency_type     TEXT NOT NULL DEFAULT 'behavioral'
                          CHECK (competency_type IN ('behavioral','technical','leadership','functional')),
      applicable_roles    JSONB DEFAULT '[]'::jsonb,
      applicable_grades   JSONB DEFAULT '[]'::jsonb,
      expected_score      NUMERIC(3,2) DEFAULT 3.0,
      is_active           BOOLEAN NOT NULL DEFAULT TRUE,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_competency_definitions_company ON competency_definitions(company_id)`);

  /* ── 5. performance_competencies enhancements ───────────────────────────── */
  // actual_score must exist before the GENERATED column that references it
  await raw(`
    ALTER TABLE performance_competencies
      ADD COLUMN IF NOT EXISTS company_id      INT REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS definition_id   INT REFERENCES competency_definitions(id),
      ADD COLUMN IF NOT EXISTS actual_score    NUMERIC(3,2),
      ADD COLUMN IF NOT EXISTS expected_score  NUMERIC(3,2)
  `);
  await raw(`
    ALTER TABLE performance_competencies
      ADD COLUMN IF NOT EXISTS gap NUMERIC(3,2) GENERATED ALWAYS AS (actual_score - expected_score) STORED
  `);

  /* ── 6. kra_definitions (KRA master table) ──────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS kra_definitions (
      id            SERIAL PRIMARY KEY,
      company_id    INT REFERENCES companies(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      description   TEXT,
      weightage     NUMERIC(5,2) NOT NULL DEFAULT 100,
      department    TEXT,
      role_level    TEXT,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_kra_definitions_company ON kra_definitions(company_id)`);

  /* ── 7. employee_kras (KRA assignments per review) ──────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS employee_kras (
      id             SERIAL PRIMARY KEY,
      employee_id    INT NOT NULL REFERENCES employees(id),
      kra_id         INT REFERENCES kra_definitions(id),
      review_id      INT REFERENCES performance_reviews(id),
      cycle_id       INT REFERENCES review_cycles(id),
      company_id     INT REFERENCES companies(id),
      custom_name    TEXT,
      description    TEXT,
      target         TEXT,
      weightage      NUMERIC(5,2) NOT NULL DEFAULT 25,
      self_score     NUMERIC(3,2),
      manager_score  NUMERIC(3,2),
      final_score    NUMERIC(3,2),
      evidence       TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_employee_kras_employee ON employee_kras(employee_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_employee_kras_review   ON employee_kras(review_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_employee_kras_company  ON employee_kras(company_id)`);

  /* ── 8. calibration_sessions ─────────────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS calibration_sessions (
      id              SERIAL PRIMARY KEY,
      company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      cycle_id        INT REFERENCES review_cycles(id),
      department      TEXT,
      session_name    TEXT NOT NULL,
      session_date    DATE,
      facilitator_id  INT REFERENCES employees(id),
      status          TEXT NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned','in_progress','completed')),
      notes           TEXT,
      bell_curve_target JSONB DEFAULT '{}'::jsonb,
      created_by      INT REFERENCES employees(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_calibration_sessions_company ON calibration_sessions(company_id)`);

  /* ── 9. calibration_adjustments ─────────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS calibration_adjustments (
      id              SERIAL PRIMARY KEY,
      session_id      INT NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
      review_id       INT NOT NULL REFERENCES performance_reviews(id),
      employee_id     INT NOT NULL REFERENCES employees(id),
      company_id      INT NOT NULL REFERENCES companies(id),
      original_rating NUMERIC(3,2),
      proposed_rating NUMERIC(3,2),
      final_rating    NUMERIC(3,2),
      justification   TEXT,
      adjusted_by     INT REFERENCES employees(id),
      adjusted_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_calibration_adj_session ON calibration_adjustments(session_id)`);

  /* ── 10. increment_bands (rating → % matrix) ────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS increment_bands (
      id              SERIAL PRIMARY KEY,
      company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      cycle_id        INT REFERENCES review_cycles(id),
      band_name       TEXT NOT NULL,
      rating_from     NUMERIC(3,2) NOT NULL,
      rating_to       NUMERIC(3,2) NOT NULL,
      increment_pct_min NUMERIC(5,2) NOT NULL DEFAULT 0,
      increment_pct_max NUMERIC(5,2) NOT NULL DEFAULT 0,
      increment_pct_default NUMERIC(5,2) NOT NULL DEFAULT 0,
      budget_pct      NUMERIC(5,2),
      is_active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_increment_bands_company ON increment_bands(company_id)`);

  /* ── 11. increment_recommendations ──────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS increment_recommendations (
      id                     SERIAL PRIMARY KEY,
      company_id             INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id            INT NOT NULL REFERENCES employees(id),
      review_id              INT REFERENCES performance_reviews(id),
      cycle_id               INT REFERENCES review_cycles(id),
      current_ctc            NUMERIC(15,2),
      recommended_increment_pct NUMERIC(5,2),
      recommended_new_ctc    NUMERIC(15,2),
      final_increment_pct    NUMERIC(5,2),
      final_new_ctc          NUMERIC(15,2),
      effective_date         DATE,
      justification          TEXT,
      status                 TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','submitted','approved','rejected','processed')),
      submitted_by           INT REFERENCES employees(id),
      approved_by            INT REFERENCES employees(id),
      approved_at            TIMESTAMPTZ,
      rejection_reason       TEXT,
      payroll_synced         BOOLEAN NOT NULL DEFAULT FALSE,
      payroll_synced_at      TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, cycle_id)
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_increment_reco_company  ON increment_recommendations(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_increment_reco_employee ON increment_recommendations(employee_id)`);

  /* ── 12. promotion_recommendations ──────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS promotion_recommendations (
      id                    SERIAL PRIMARY KEY,
      company_id            INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id           INT NOT NULL REFERENCES employees(id),
      review_id             INT REFERENCES performance_reviews(id),
      cycle_id              INT REFERENCES review_cycles(id),
      current_designation   TEXT,
      proposed_designation  TEXT NOT NULL,
      current_grade         TEXT,
      proposed_grade        TEXT,
      current_department    TEXT,
      proposed_department   TEXT,
      effective_date        DATE,
      justification         TEXT,
      performance_rating    NUMERIC(3,2),
      years_in_role         NUMERIC(4,1),
      status                TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','submitted','approved','rejected','processed')),
      submitted_by          INT REFERENCES employees(id),
      approved_by           INT REFERENCES employees(id),
      approved_at           TIMESTAMPTZ,
      rejection_reason      TEXT,
      grade_updated         BOOLEAN NOT NULL DEFAULT FALSE,
      grade_updated_at      TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_promotion_reco_company  ON promotion_recommendations(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_promotion_reco_employee ON promotion_recommendations(employee_id)`);

  /* ── 13. training_recommendations (PMS → L&D link) ──────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS performance_training_recommendations (
      id                  SERIAL PRIMARY KEY,
      company_id          INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id         INT NOT NULL REFERENCES employees(id),
      review_id           INT REFERENCES performance_reviews(id),
      cycle_id            INT REFERENCES review_cycles(id),
      competency_gap      TEXT,
      kra_gap             TEXT,
      training_type       TEXT NOT NULL DEFAULT 'skill_development'
                          CHECK (training_type IN ('skill_development','leadership','technical','behavioral','compliance')),
      recommended_program TEXT NOT NULL,
      priority            TEXT NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('critical','high','medium','low')),
      target_completion   DATE,
      status              TEXT NOT NULL DEFAULT 'recommended'
                          CHECK (status IN ('recommended','enrolled','completed','dropped')),
      nominated_by        INT REFERENCES employees(id),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_perf_training_company  ON performance_training_recommendations(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_perf_training_employee ON performance_training_recommendations(employee_id)`);

  /* ── 14. 360 feedback table (create if not yet exist, then fill gaps) ───── */
  await raw(`
    CREATE TABLE IF NOT EXISTS performance_feedback (
      id                   SERIAL PRIMARY KEY,
      employee_id          INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      feedback_provider_id INT REFERENCES employees(id),
      review_id            INT REFERENCES performance_reviews(id),
      cycle_id             INT REFERENCES review_cycles(id),
      company_id           INT REFERENCES companies(id),
      relationship         TEXT NOT NULL DEFAULT 'peer'
                           CHECK (relationship IN ('self','manager','peer','subordinate','skip_level','external')),
      is_anonymous         BOOLEAN NOT NULL DEFAULT FALSE,
      due_date             DATE,
      status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','submitted','declined')),
      overall_score        NUMERIC(3,2),
      feedback_text        TEXT,
      strengths            TEXT,
      improvements         TEXT,
      submitted_at         TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Idempotent column additions for databases where the table already exists
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS company_id    INT REFERENCES companies(id)`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS is_anonymous  BOOLEAN NOT NULL DEFAULT FALSE`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS due_date      DATE`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS cycle_id      INT REFERENCES review_cycles(id)`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS relationship  TEXT NOT NULL DEFAULT 'peer'`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS overall_score NUMERIC(3,2)`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS feedback_text TEXT`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS strengths     TEXT`);
  await raw(`ALTER TABLE performance_feedback ADD COLUMN IF NOT EXISTS improvements  TEXT`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_perf_feedback_company ON performance_feedback(company_id)`);

  /* ── 15. OKR objectives ─────────────────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS okr_objectives (
      id              SERIAL PRIMARY KEY,
      company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      owner_id        INT NOT NULL REFERENCES employees(id),
      parent_id       INT REFERENCES okr_objectives(id),
      cycle_id        INT REFERENCES review_cycles(id),
      title           TEXT NOT NULL,
      description     TEXT,
      level           TEXT NOT NULL DEFAULT 'individual'
                      CHECK (level IN ('company','department','team','individual')),
      department      TEXT,
      status          TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','active','completed','cancelled')),
      overall_progress NUMERIC(5,2) DEFAULT 0,
      start_date      DATE,
      end_date        DATE,
      created_by      INT REFERENCES employees(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_okr_objectives_company ON okr_objectives(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_okr_objectives_owner   ON okr_objectives(owner_id)`);

  /* ── 16. OKR key results ─────────────────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS okr_key_results (
      id              SERIAL PRIMARY KEY,
      objective_id    INT NOT NULL REFERENCES okr_objectives(id) ON DELETE CASCADE,
      company_id      INT NOT NULL REFERENCES companies(id),
      title           TEXT NOT NULL,
      description     TEXT,
      unit            TEXT,
      start_value     NUMERIC(15,4) DEFAULT 0,
      target_value    NUMERIC(15,4) NOT NULL,
      current_value   NUMERIC(15,4) DEFAULT 0,
      progress_pct    NUMERIC(5,2) GENERATED ALWAYS AS (
                        CASE WHEN target_value = start_value THEN 0
                             ELSE LEAST(100, GREATEST(0,
                               (current_value - start_value) * 100.0 / NULLIF(target_value - start_value, 0)
                             ))
                        END
                      ) STORED,
      kr_type         TEXT NOT NULL DEFAULT 'metric'
                      CHECK (kr_type IN ('metric','milestone','boolean')),
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','completed','at_risk','cancelled')),
      owner_id        INT REFERENCES employees(id),
      due_date        DATE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_okr_kr_objective ON okr_key_results(objective_id)`);

  /* ── 17. succession_perf_sync_log (if not exists from previous migration) ─ */
  await raw(`
    CREATE TABLE IF NOT EXISTS succession_perf_sync_log (
      id                SERIAL PRIMARY KEY,
      employee_id       INT NOT NULL REFERENCES employees(id),
      source            TEXT NOT NULL DEFAULT 'manual',
      performance_score NUMERIC(3,2),
      potential_score   NUMERIC(3,2),
      synced_by         INT REFERENCES employees(id),
      company_id        INT REFERENCES companies(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /* ── 18. Performance indexes ─────────────────────────────────────────────── */
  await raw(`CREATE INDEX IF NOT EXISTS idx_performance_reviews_cycle     ON performance_reviews(review_cycle_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_performance_reviews_status    ON performance_reviews(status)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_performance_reviews_company   ON performance_reviews(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_performance_goals_cycle       ON performance_goals(cycle_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_performance_goals_company     ON performance_goals(company_id)`);
}

export async function down(knex) {
  const raw = sql => knex.raw(sql);
  await raw('DROP TABLE IF EXISTS okr_key_results CASCADE');
  await raw('DROP TABLE IF EXISTS okr_objectives CASCADE');
  await raw('DROP TABLE IF EXISTS performance_training_recommendations CASCADE');
  await raw('DROP TABLE IF EXISTS promotion_recommendations CASCADE');
  await raw('DROP TABLE IF EXISTS increment_recommendations CASCADE');
  await raw('DROP TABLE IF EXISTS increment_bands CASCADE');
  await raw('DROP TABLE IF EXISTS calibration_adjustments CASCADE');
  await raw('DROP TABLE IF EXISTS calibration_sessions CASCADE');
  await raw('DROP TABLE IF EXISTS employee_kras CASCADE');
  await raw('DROP TABLE IF EXISTS kra_definitions CASCADE');
  await raw('DROP TABLE IF EXISTS competency_definitions CASCADE');
}
