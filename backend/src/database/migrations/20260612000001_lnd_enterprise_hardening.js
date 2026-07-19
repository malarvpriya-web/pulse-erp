// 20260612000001_lnd_enterprise_hardening.js
// L&D Enterprise Hardening: training_costs, certifications, learning_paths,
// assessments, trainers, competencies, knowledge_docs + P0 constraint fixes

export async function up(knex) {

  // ── P0 FIX 1: training_costs (referenced in code but never created) ──────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS training_costs (
      id          SERIAL PRIMARY KEY,
      program_id  INTEGER REFERENCES training_programs(id) ON DELETE CASCADE,
      cost_type   VARCHAR(50) NOT NULL,   -- venue / trainer_fee / materials / travel / other
      amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
      description TEXT,
      company_id  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_training_costs_program ON training_costs(program_id)`);

  // ── P0 FIX 2: UNIQUE constraint on skill_matrix ─────────────────────────────
  await knex.raw(`
    ALTER TABLE skill_matrix
      ADD COLUMN IF NOT EXISTS company_id INTEGER,
      ADD COLUMN IF NOT EXISTS category   VARCHAR(100)
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_skill_matrix_emp_skill'
      ) THEN
        ALTER TABLE skill_matrix ADD CONSTRAINT uq_skill_matrix_emp_skill
          UNIQUE (employee_id, skill_name);
      END IF;
    END $$
  `);

  // ── P0 FIX 3: company_id on training_programs & training_enrollments ─────────
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS is_mandatory  BOOLEAN DEFAULT false`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS target_department VARCHAR(100)`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS target_role       VARCHAR(200)`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS online_link        TEXT`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS venue              VARCHAR(300)`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS attachment_url     TEXT`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS trainer_id         INTEGER`);
  await knex.raw(`ALTER TABLE training_programs    ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_tp_company ON training_programs(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_te_company ON training_enrollments(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sm_company ON skill_matrix(company_id)`);

  // ── TRAINERS ─────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS trainers (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(200) NOT NULL,
      trainer_type    VARCHAR(20)  DEFAULT 'internal', -- internal / external
      employee_id     INTEGER,
      email           VARCHAR(200),
      phone           VARCHAR(50),
      specialization  TEXT,
      rating          NUMERIC(3,2) DEFAULT 0,
      total_sessions  INTEGER DEFAULT 0,
      company_id      INTEGER,
      is_active       BOOLEAN DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_trainers_company ON trainers(company_id)`);

  // ── CERTIFICATIONS MASTER ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS certifications (
      id               SERIAL PRIMARY KEY,
      name             VARCHAR(300) NOT NULL,
      code             VARCHAR(100),
      issuing_body     VARCHAR(200),
      category         VARCHAR(100), -- Safety / Technical / Quality / Compliance / Leadership
      validity_months  INTEGER DEFAULT 12,
      is_mandatory     BOOLEAN DEFAULT false,
      description      TEXT,
      company_id       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_certs_company ON certifications(company_id)`);

  // ── EMPLOYEE CERTIFICATIONS ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_certifications (
      id                   SERIAL PRIMARY KEY,
      employee_id          INTEGER NOT NULL,
      certification_id     INTEGER REFERENCES certifications(id) ON DELETE CASCADE,
      certificate_number   VARCHAR(200),
      issue_date           DATE,
      expiry_date          DATE,
      renewal_date         DATE,
      certificate_url      TEXT,
      status               VARCHAR(20) DEFAULT 'active', -- active / expired / renewed / revoked
      issued_by            VARCHAR(200),
      notes                TEXT,
      company_id           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, certification_id, issue_date)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_certs_employee  ON employee_certifications(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_certs_expiry    ON employee_certifications(expiry_date) WHERE expiry_date IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_certs_status    ON employee_certifications(status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_certs_company   ON employee_certifications(company_id)`);

  // ── LEARNING PATHS ─────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS learning_paths (
      id                  SERIAL PRIMARY KEY,
      name                VARCHAR(300) NOT NULL,
      description         TEXT,
      path_type           VARCHAR(50) DEFAULT 'role',  -- role / department / certification / onboarding / manager
      target_role         VARCHAR(200),
      target_department   VARCHAR(200),
      estimated_hours     NUMERIC(8,2) DEFAULT 0,
      is_active           BOOLEAN DEFAULT true,
      thumbnail_url       TEXT,
      company_id          INTEGER,
      created_by          INTEGER,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_lp_company ON learning_paths(company_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS learning_path_items (
      id                   SERIAL PRIMARY KEY,
      path_id              INTEGER REFERENCES learning_paths(id) ON DELETE CASCADE,
      program_id           INTEGER REFERENCES training_programs(id) ON DELETE CASCADE,
      sequence_order       INTEGER DEFAULT 1,
      is_mandatory         BOOLEAN DEFAULT true,
      prerequisite_item_id INTEGER REFERENCES learning_path_items(id),
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_learning_paths (
      id            SERIAL PRIMARY KEY,
      employee_id   INTEGER NOT NULL,
      path_id       INTEGER REFERENCES learning_paths(id) ON DELETE CASCADE,
      assigned_by   INTEGER,
      assigned_date DATE DEFAULT CURRENT_DATE,
      due_date      DATE,
      status        VARCHAR(20) DEFAULT 'in_progress', -- in_progress / completed / overdue
      completed_at  TIMESTAMPTZ,
      company_id    INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, path_id)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_elp_employee ON employee_learning_paths(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_elp_company  ON employee_learning_paths(company_id)`);

  // ── ASSESSMENTS ───────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS assessments (
      id              SERIAL PRIMARY KEY,
      program_id      INTEGER REFERENCES training_programs(id) ON DELETE CASCADE,
      title           VARCHAR(300) NOT NULL,
      description     TEXT,
      pass_score      INTEGER DEFAULT 70,   -- percentage
      max_attempts    INTEGER DEFAULT 3,
      time_limit_mins INTEGER,              -- NULL = unlimited
      is_active       BOOLEAN DEFAULT true,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_assessments_program ON assessments(program_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS assessment_questions (
      id              SERIAL PRIMARY KEY,
      assessment_id   INTEGER REFERENCES assessments(id) ON DELETE CASCADE,
      question_text   TEXT NOT NULL,
      question_type   VARCHAR(20) DEFAULT 'mcq', -- mcq / true_false / short_answer
      options         JSONB DEFAULT '[]',         -- [{text, is_correct}]
      correct_answer  TEXT,
      marks           INTEGER DEFAULT 1,
      sequence_order  INTEGER DEFAULT 1,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aq_assessment ON assessment_questions(assessment_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS assessment_attempts (
      id              SERIAL PRIMARY KEY,
      assessment_id   INTEGER REFERENCES assessments(id) ON DELETE CASCADE,
      employee_id     INTEGER NOT NULL,
      enrollment_id   INTEGER REFERENCES training_enrollments(id),
      attempt_number  INTEGER DEFAULT 1,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      submitted_at    TIMESTAMPTZ,
      score           NUMERIC(5,2),
      max_score       NUMERIC(5,2),
      score_pct       NUMERIC(5,2),
      passed          BOOLEAN,
      answers         JSONB DEFAULT '{}',   -- {question_id: answer}
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aa_employee   ON assessment_attempts(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aa_assessment ON assessment_attempts(assessment_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aa_company    ON assessment_attempts(company_id)`);

  // ── COMPETENCY FRAMEWORK ──────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS competency_framework (
      id                  SERIAL PRIMARY KEY,
      name                VARCHAR(300) NOT NULL,
      category            VARCHAR(100), -- Technical / Behavioral / Leadership / Functional
      description         TEXT,
      level_1_descriptor  TEXT,
      level_2_descriptor  TEXT,
      level_3_descriptor  TEXT,
      level_4_descriptor  TEXT,
      level_5_descriptor  TEXT,
      company_id          INTEGER,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cf_company ON competency_framework(company_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS role_competencies (
      id              SERIAL PRIMARY KEY,
      role_title      VARCHAR(200) NOT NULL,
      department      VARCHAR(100),
      competency_id   INTEGER REFERENCES competency_framework(id) ON DELETE CASCADE,
      required_level  INTEGER DEFAULT 3 CHECK(required_level BETWEEN 1 AND 5),
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(role_title, competency_id)
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_competency_assessments (
      id              SERIAL PRIMARY KEY,
      employee_id     INTEGER NOT NULL,
      competency_id   INTEGER REFERENCES competency_framework(id) ON DELETE CASCADE,
      assessed_level  INTEGER DEFAULT 1 CHECK(assessed_level BETWEEN 1 AND 5),
      required_level  INTEGER DEFAULT 3,
      assessed_by     INTEGER,
      assessed_date   DATE DEFAULT CURRENT_DATE,
      notes           TEXT,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, competency_id)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_eca_employee  ON employee_competency_assessments(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_eca_company   ON employee_competency_assessments(company_id)`);

  // ── KNOWLEDGE DOCUMENTS (SOP / Manuals / Standards) ──────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id            SERIAL PRIMARY KEY,
      title         VARCHAR(400) NOT NULL,
      doc_type      VARCHAR(50)  DEFAULT 'sop', -- sop / manual / standard / policy / work_instruction / product_doc
      category      VARCHAR(100),               -- Safety / Technical / Quality / HR / Engineering
      department    VARCHAR(100),
      version       VARCHAR(20)  DEFAULT '1.0',
      content_url   TEXT,
      drive_url     TEXT,
      file_size_kb  INTEGER,
      is_active     BOOLEAN DEFAULT true,
      is_mandatory  BOOLEAN DEFAULT false,
      reviewed_at   DATE,
      reviewed_by   INTEGER,
      tags          TEXT[],
      company_id    INTEGER,
      created_by    INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kd_company  ON knowledge_documents(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kd_doctype  ON knowledge_documents(doc_type)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kd_title    ON knowledge_documents USING gin(to_tsvector('english', title))`);

  // ── TRAINING SESSIONS (multi-session support) ─────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS training_sessions (
      id            SERIAL PRIMARY KEY,
      program_id    INTEGER REFERENCES training_programs(id) ON DELETE CASCADE,
      session_date  DATE NOT NULL,
      start_time    TIME,
      end_time      TIME,
      venue         VARCHAR(300),
      online_link   TEXT,
      trainer_id    INTEGER REFERENCES trainers(id),
      status        VARCHAR(20) DEFAULT 'scheduled', -- scheduled / completed / cancelled
      notes         TEXT,
      company_id    INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ts_program ON training_sessions(program_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ts_date    ON training_sessions(session_date)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS training_attendance (
      id            SERIAL PRIMARY KEY,
      session_id    INTEGER REFERENCES training_sessions(id) ON DELETE CASCADE,
      employee_id   INTEGER NOT NULL,
      present       BOOLEAN DEFAULT false,
      check_in_time TIME,
      notes         TEXT,
      company_id    INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(session_id, employee_id)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ta_session  ON training_attendance(session_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ta_employee ON training_attendance(employee_id)`);

  // ── LND SETTINGS ─────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS lnd_settings (
      id                       SERIAL PRIMARY KEY,
      company_id               INTEGER NOT NULL UNIQUE,
      cert_reminder_days       INTEGER[] DEFAULT '{30,60,90}',
      mandatory_grace_days     INTEGER DEFAULT 7,
      pass_score_default       INTEGER DEFAULT 70,
      max_attempts_default     INTEGER DEFAULT 3,
      auto_update_skill_on_complete BOOLEAN DEFAULT true,
      notify_on_enrollment     BOOLEAN DEFAULT true,
      notify_on_completion     BOOLEAN DEFAULT true,
      notify_cert_expiry       BOOLEAN DEFAULT true,
      training_categories      TEXT[] DEFAULT ARRAY['Technical','Soft Skills','Compliance','Safety','Leadership','Quality','Product','Mandatory'],
      skill_categories         TEXT[] DEFAULT ARRAY['Technical','Soft Skills','Management','Domain','Tool'],
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function down(knex) {
  for (const t of [
    'lnd_settings','training_attendance','training_sessions',
    'employee_competency_assessments','role_competencies','competency_framework',
    'assessment_attempts','assessment_questions','assessments',
    'employee_learning_paths','learning_path_items','learning_paths',
    'employee_certifications','certifications','trainers',
    'training_costs',
  ]) {
    await knex.raw(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await knex.raw(`ALTER TABLE skill_matrix DROP CONSTRAINT IF EXISTS uq_skill_matrix_emp_skill`);
}
