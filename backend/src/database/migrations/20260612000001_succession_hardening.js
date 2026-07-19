/**
 * 20260612000001_succession_hardening.js
 *
 * Comprehensive succession-planning schema hardening:
 *  - Assessment history (audit trail)
 *  - New columns on talent_assessments, critical_roles, succession_plans
 *  - leadership_pipeline_levels + leadership_pipeline_entries
 *  - development_plans + development_actions
 *  - mentoring_assignments
 *  - employee_talent_pools + employee_pool_members
 *  - succession_settings
 *  - Performance / L&D sync log
 *  - Indexes for all new tables
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sh_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!err.message?.match(/already exists|does not exist/i))
        throw err;
    }
  };

  // ── 1. ASSESSMENT HISTORY ──────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS talent_assessment_history (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER NOT NULL,
      assessed_by       INTEGER,
      assessment_date   DATE DEFAULT CURRENT_DATE,
      assessment_period VARCHAR(30),
      performance_score INTEGER CHECK(performance_score BETWEEN 1 AND 5),
      potential_score   INTEGER CHECK(potential_score BETWEEN 1 AND 5),
      flight_risk       VARCHAR(20) DEFAULT 'low',
      readiness         VARCHAR(30) DEFAULT '1-2-years',
      leadership_score  INTEGER CHECK(leadership_score BETWEEN 1 AND 5),
      mobility          VARCHAR(20) DEFAULT 'flexible',
      talent_classification VARCHAR(50),
      notes             TEXT,
      company_id        INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_tah_emp_period ON talent_assessment_history(employee_id, assessment_period)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_tah_company    ON talent_assessment_history(company_id, assessment_date DESC)`);

  // ── 2. EXTEND talent_assessments ──────────────────────────────────────────
  await safe(`ALTER TABLE talent_assessments ADD COLUMN IF NOT EXISTS leadership_score    INTEGER CHECK(leadership_score BETWEEN 1 AND 5)`);
  await safe(`ALTER TABLE talent_assessments ADD COLUMN IF NOT EXISTS mobility            VARCHAR(20) DEFAULT 'flexible'`);
  await safe(`ALTER TABLE talent_assessments ADD COLUMN IF NOT EXISTS talent_classification VARCHAR(50)`);
  await safe(`ALTER TABLE talent_assessments ADD COLUMN IF NOT EXISTS assessment_period   VARCHAR(30)`);

  // ── 3. EXTEND critical_roles ──────────────────────────────────────────────
  await safe(`ALTER TABLE critical_roles ADD COLUMN IF NOT EXISTS knowledge_domain         VARCHAR(150)`);
  await safe(`ALTER TABLE critical_roles ADD COLUMN IF NOT EXISTS vacancy_impact           TEXT`);
  await safe(`ALTER TABLE critical_roles ADD COLUMN IF NOT EXISTS expected_vacancy_date    DATE`);
  await safe(`ALTER TABLE critical_roles ADD COLUMN IF NOT EXISTS min_experience_years     INTEGER DEFAULT 0`);
  await safe(`ALTER TABLE critical_roles ADD COLUMN IF NOT EXISTS required_certifications  JSONB DEFAULT '[]'`);
  await safe(`ALTER TABLE critical_roles ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ DEFAULT NOW()`);

  // ── 4. EXTEND succession_plans ────────────────────────────────────────────
  await safe(`ALTER TABLE succession_plans ADD COLUMN IF NOT EXISTS is_emergency_successor BOOLEAN DEFAULT FALSE`);
  await safe(`ALTER TABLE succession_plans ADD COLUMN IF NOT EXISTS successor_type         VARCHAR(20) DEFAULT 'secondary'`);
  await safe(`ALTER TABLE succession_plans ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ DEFAULT NOW()`);

  // ── 5. LEADERSHIP PIPELINE ────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS leadership_pipeline_levels (
      id                      SERIAL PRIMARY KEY,
      level_name              VARCHAR(100) NOT NULL,
      level_order             INTEGER NOT NULL DEFAULT 0,
      description             TEXT,
      required_experience_yrs INTEGER DEFAULT 0,
      required_competencies   JSONB DEFAULT '[]',
      company_id              INTEGER,
      is_active               BOOLEAN DEFAULT TRUE,
      created_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lpl_order_company ON leadership_pipeline_levels(company_id, level_order)`);

  await safe(`
    CREATE TABLE IF NOT EXISTS leadership_pipeline_entries (
      id               SERIAL PRIMARY KEY,
      employee_id      INTEGER NOT NULL,
      current_level_id INTEGER REFERENCES leadership_pipeline_levels(id) ON DELETE SET NULL,
      target_level_id  INTEGER REFERENCES leadership_pipeline_levels(id) ON DELETE SET NULL,
      current_since    DATE DEFAULT CURRENT_DATE,
      target_date      DATE,
      readiness        VARCHAR(30) DEFAULT '1-2-years',
      status           VARCHAR(30) DEFAULT 'active',
      notes            TEXT,
      company_id       INTEGER,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, company_id)
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_lpe_company    ON leadership_pipeline_entries(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_lpe_level      ON leadership_pipeline_entries(current_level_id)`);

  // Seed default levels for existing companies (idempotent)
  await safe(`
    INSERT INTO leadership_pipeline_levels (level_name, level_order, description, required_experience_yrs, company_id)
    SELECT l.level_name, l.level_order, l.description, l.req_yrs, c.id
    FROM companies c
    CROSS JOIN (VALUES
      ('Individual Contributor', 1, 'Core technical/functional contributor',  0),
      ('Team Lead',              2, 'Leads a small team or technical area',   3),
      ('Manager',                3, 'Manages a team with P&L or OKR accountability', 5),
      ('Senior Manager',         4, 'Manages multiple teams or functions',    8),
      ('Director',               5, 'Leads a department, strategic decisions', 12),
      ('Executive / VP',         6, 'C-suite or VP-level leadership',         15)
    ) AS l(level_name, level_order, description, req_yrs)
    WHERE NOT EXISTS (
      SELECT 1 FROM leadership_pipeline_levels x
      WHERE x.company_id = c.id AND x.level_order = l.level_order
    )
  `);

  // ── 6. DEVELOPMENT PLANS ──────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS development_plans (
      id               SERIAL PRIMARY KEY,
      employee_id      INTEGER NOT NULL,
      critical_role_id INTEGER REFERENCES critical_roles(id) ON DELETE SET NULL,
      plan_title       VARCHAR(300) NOT NULL,
      plan_type        VARCHAR(50) DEFAULT 'succession',
      status           VARCHAR(30) DEFAULT 'active',
      start_date       DATE DEFAULT CURRENT_DATE,
      target_date      DATE,
      completion_date  DATE,
      overall_progress INTEGER DEFAULT 0 CHECK(overall_progress BETWEEN 0 AND 100),
      notes            TEXT,
      company_id       INTEGER,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_dp_employee  ON development_plans(employee_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_dp_company   ON development_plans(company_id, status)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_dp_role      ON development_plans(critical_role_id)`);

  await safe(`
    CREATE TABLE IF NOT EXISTS development_actions (
      id                  SERIAL PRIMARY KEY,
      plan_id             INTEGER NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
      action_type         VARCHAR(50) DEFAULT 'task',
      title               VARCHAR(300) NOT NULL,
      description         TEXT,
      due_date            DATE,
      status              VARCHAR(30) DEFAULT 'pending',
      completion_date     DATE,
      owner_employee_id   INTEGER,
      linked_training_id  INTEGER,
      linked_skill        VARCHAR(200),
      action_order        INTEGER DEFAULT 0,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_da_plan ON development_actions(plan_id, action_order)`);

  // ── 7. MENTORING ASSIGNMENTS ──────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS mentoring_assignments (
      id                   SERIAL PRIMARY KEY,
      mentee_employee_id   INTEGER NOT NULL,
      mentor_employee_id   INTEGER NOT NULL,
      development_plan_id  INTEGER REFERENCES development_plans(id) ON DELETE SET NULL,
      focus_area           VARCHAR(300),
      start_date           DATE DEFAULT CURRENT_DATE,
      end_date             DATE,
      status               VARCHAR(30) DEFAULT 'active',
      session_count        INTEGER DEFAULT 0,
      next_session_date    DATE,
      notes                TEXT,
      company_id           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_ma_mentee   ON mentoring_assignments(mentee_employee_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_ma_mentor   ON mentoring_assignments(mentor_employee_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_ma_company  ON mentoring_assignments(company_id, status)`);

  // ── 8. EMPLOYEE TALENT POOLS ──────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS employee_talent_pools (
      id          SERIAL PRIMARY KEY,
      pool_name   VARCHAR(200) NOT NULL,
      pool_type   VARCHAR(50)  DEFAULT 'general',
      description TEXT,
      department  VARCHAR(100),
      is_active   BOOLEAN DEFAULT TRUE,
      company_id  INTEGER,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_etp_company ON employee_talent_pools(company_id, is_active)`);

  await safe(`
    CREATE TABLE IF NOT EXISTS employee_pool_members (
      pool_id     INTEGER NOT NULL REFERENCES employee_talent_pools(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL,
      added_date  DATE DEFAULT CURRENT_DATE,
      notes       TEXT,
      added_by    INTEGER,
      PRIMARY KEY (pool_id, employee_id)
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_epm_pool     ON employee_pool_members(pool_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_epm_employee ON employee_pool_members(employee_id)`);

  // ── 9. SUCCESSION SETTINGS ────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS succession_settings (
      id                     SERIAL PRIMARY KEY,
      company_id             INTEGER UNIQUE,
      zero_successor_alert   BOOLEAN DEFAULT TRUE,
      single_successor_alert BOOLEAN DEFAULT TRUE,
      flight_risk_threshold  VARCHAR(20) DEFAULT 'high',
      review_frequency       VARCHAR(20) DEFAULT 'quarterly',
      notify_roles           JSONB DEFAULT '["chro","hr_admin","hr_manager"]',
      custom_readiness_labels JSONB DEFAULT '{}',
      hiPo_threshold_potential INTEGER DEFAULT 4,
      hiPo_threshold_performance INTEGER DEFAULT 3,
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 10. SUCCESSION NOTIFICATIONS ──────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS succession_alerts (
      id           SERIAL PRIMARY KEY,
      alert_type   VARCHAR(60) NOT NULL,
      role_id      INTEGER REFERENCES critical_roles(id) ON DELETE CASCADE,
      employee_id  INTEGER,
      message      TEXT,
      severity     VARCHAR(20) DEFAULT 'warning',
      is_read      BOOLEAN DEFAULT FALSE,
      company_id   INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_sa_company_read ON succession_alerts(company_id, is_read, created_at DESC)`);

  // ── 11. PERFORMANCE SYNC LOG ──────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS succession_perf_sync_log (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER NOT NULL,
      source            VARCHAR(50) DEFAULT 'manual',
      performance_score INTEGER,
      potential_score   INTEGER,
      synced_at         TIMESTAMPTZ DEFAULT NOW(),
      synced_by         INTEGER,
      company_id        INTEGER
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_spsl_employee ON succession_perf_sync_log(employee_id, synced_at DESC)`);
}

export async function down() {
  // Columns/tables intentionally not dropped to protect live data
}
