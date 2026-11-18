/**
 * 20261118000003 — Learning Center consolidation (owner-approved 2026-11-18).
 *
 * The audit found two skill registers that never met, three places a
 * certification was recorded, two competency libraries, columns the reports
 * queried that did not exist and settings nothing read. This makes ONE of each:
 *
 *   Skills & competencies   competency_framework (library, category from
 *                           master_skill_categories) + employee_competency_
 *                           assessments (THE rating, 1–5, with its source).
 *                           skill_matrix, employee_skills and Performance's
 *                           competency_definitions are folded in and dropped.
 *   Certifications          employee_certifications only (the skill tables'
 *                           "certified" flags go with them).
 *   Trainings               training_programs gain end date, refresher interval
 *                           and a series (repeat rounds every 3/6/12 months),
 *                           a linked competency, audit columns; enrolments get
 *                           a fixed status vocabulary and who/how enrolled;
 *                           costs get a date.
 *   Settings                duplicate / dead columns of lnd_settings dropped.
 *
 * Rows already in the skill tables are carried into the rating table first, so
 * a database that still holds real skill data loses nothing.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const TPL = [
  ['lnd_enrolled', 'Training enrolment',
    'You are enrolled: {{program_title}}',
    '<p>Dear {{employee_name}},</p><p>You have been enrolled in <strong>{{program_title}}</strong> on {{scheduled_date}}{{venue_line}}.</p><p>See Self Service → My Learning for details.</p>'],
  ['lnd_training_reminder', 'Training reminder',
    'Reminder: {{program_title}} on {{scheduled_date}}',
    '<p>Dear {{employee_name}},</p><p>This is a reminder that <strong>{{program_title}}</strong> is scheduled on {{scheduled_date}}{{venue_line}}.</p>'],
  ['lnd_cert_expiry', 'Certificate expiry',
    'Certificate expiring: {{cert_name}}',
    '<p>Dear {{employee_name}},</p><p>Your certificate <strong>{{cert_name}}</strong> expires on {{expiry_date}}. Please arrange renewal with HR.</p>'],
];

export async function up(knex) {
  const q = (sql, b) => knex.raw(sql, b);

  /* ── 1. Competency library: one, shared with Performance ─────────────── */
  await q(`ALTER TABLE competency_framework
             ADD COLUMN IF NOT EXISTS expected_level SMALLINT NOT NULL DEFAULT 3,
             ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`DO $$ BEGIN
             ALTER TABLE competency_framework ADD CONSTRAINT competency_framework_expected_chk CHECK (expected_level BETWEEN 1 AND 5);
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* Rating table: source, experience, who/when. */
  await q(`ALTER TABLE employee_competency_assessments
             ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual',
             ADD COLUMN IF NOT EXISTS years_experience NUMERIC(4,1),
             ADD COLUMN IF NOT EXISTS assessed_by_user INTEGER,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  /* Carry the two old skill registers into the library + rating table. */
  for (const [tbl, levelSql] of [
    ['skill_matrix', 'GREATEST(1, LEAST(5, COALESCE(s.proficiency_level, 1)))'],
    ['employee_skills', `CASE LOWER(s.proficiency_level) WHEN 'expert' THEN 5 WHEN 'advanced' THEN 4 WHEN 'intermediate' THEN 3 ELSE 2 END`],
  ]) {
    const { rows: [ex] } = await q(`SELECT to_regclass($1) AS r`, [`public.${tbl}`]);
    if (!ex.r) continue;
    await q(`INSERT INTO competency_framework (name, category, company_id)
             SELECT DISTINCT ON (s.company_id, LOWER(TRIM(s.skill_name))) TRIM(s.skill_name), s.category, s.company_id
               FROM ${tbl} s
              WHERE s.skill_name IS NOT NULL AND TRIM(s.skill_name) <> ''
                AND NOT EXISTS (SELECT 1 FROM competency_framework cf
                                 WHERE cf.company_id IS NOT DISTINCT FROM s.company_id
                                   AND LOWER(cf.name) = LOWER(TRIM(s.skill_name)))`);
    await q(`INSERT INTO employee_competency_assessments (employee_id, competency_id, assessed_level, source, company_id)
             SELECT DISTINCT ON (s.employee_id, cf.id) s.employee_id, cf.id, ${levelSql}, 'manual', s.company_id
               FROM ${tbl} s
               JOIN employees e ON e.id = s.employee_id
               JOIN competency_framework cf ON cf.company_id IS NOT DISTINCT FROM s.company_id
                                          AND LOWER(cf.name) = LOWER(TRIM(s.skill_name))
             ON CONFLICT (employee_id, competency_id) DO NOTHING`);
    await q(`DROP TABLE ${tbl}`);
  }

  /* Performance's library had no UI and no rows; it reads competency_framework
     now. Its review scores keep their link, pointed at the shared library. */
  await q(`ALTER TABLE performance_competencies DROP CONSTRAINT IF EXISTS performance_competencies_definition_id_fkey`);
  await q(`UPDATE performance_competencies pc
              SET definition_id = (SELECT cf.id FROM competency_framework cf
                                    WHERE cf.company_id IS NOT DISTINCT FROM pc.company_id
                                      AND LOWER(cf.name) = LOWER(pc.competency_name) LIMIT 1)`);
  await q(`ALTER TABLE performance_competencies ADD CONSTRAINT performance_competencies_definition_id_fkey
             FOREIGN KEY (definition_id) REFERENCES competency_framework(id) ON DELETE SET NULL`);
  await q(`DROP TABLE IF EXISTS competency_definitions`);

  /* The required level comes from the role (role_competencies) or the library
     default at read time — a stored copy only went stale. */
  await q(`ALTER TABLE employee_competency_assessments DROP COLUMN IF EXISTS required_level`);
  await q(`DELETE FROM employee_competency_assessments eca WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = eca.employee_id)`);
  await q(`DO $$ BEGIN
             ALTER TABLE employee_competency_assessments ADD CONSTRAINT eca_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE employee_competency_assessments ADD CONSTRAINT eca_level_chk CHECK (assessed_level BETWEEN 1 AND 5);
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE employee_competency_assessments ADD CONSTRAINT eca_source_chk CHECK (source IN ('manual','training','assessment','certification','performance'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* Role requirements are per company. */
  await q(`ALTER TABLE role_competencies DROP CONSTRAINT IF EXISTS role_competencies_role_title_competency_id_key`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS role_competencies_company_role_comp_uq
             ON role_competencies (COALESCE(company_id, 0), LOWER(role_title), competency_id)`);
  await q(`DO $$ BEGIN
             ALTER TABLE role_competencies ADD CONSTRAINT role_competencies_level_chk CHECK (required_level BETWEEN 1 AND 5);
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* A library entry with ratings is deactivated, not deleted (the route
     enforces that); the FK stops a raw delete from erasing every rating. */
  await q(`ALTER TABLE employee_competency_assessments DROP CONSTRAINT IF EXISTS employee_competency_assessments_competency_id_fkey`);
  await q(`ALTER TABLE employee_competency_assessments ADD CONSTRAINT employee_competency_assessments_competency_id_fkey
             FOREIGN KEY (competency_id) REFERENCES competency_framework(id) ON DELETE RESTRICT`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS competency_framework_company_name_uq
             ON competency_framework (COALESCE(company_id, 0), LOWER(name))`);

  /* ── 2. Certifications: the one register ─────────────────────────────── */
  await q(`ALTER TABLE certifications
             ADD COLUMN IF NOT EXISTS competency_id INTEGER REFERENCES competency_framework(id) ON DELETE SET NULL,
             ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS certifications_company_name_uq
             ON certifications (COALESCE(company_id, 0), LOWER(name))`);
  await q(`ALTER TABLE employee_certifications
             ADD COLUMN IF NOT EXISTS renewed_from_id INTEGER REFERENCES employee_certifications(id) ON DELETE SET NULL,
             ADD COLUMN IF NOT EXISTS created_by INTEGER,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  /* Deleting a library entry used to cascade away every employee's certificate. */
  await q(`ALTER TABLE employee_certifications DROP CONSTRAINT IF EXISTS employee_certifications_certification_id_fkey`);
  await q(`ALTER TABLE employee_certifications ADD CONSTRAINT employee_certifications_certification_id_fkey
             FOREIGN KEY (certification_id) REFERENCES certifications(id) ON DELETE RESTRICT`);
  await q(`DELETE FROM employee_certifications ec WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = ec.employee_id)`);
  await q(`DO $$ BEGIN
             ALTER TABLE employee_certifications ADD CONSTRAINT employee_certifications_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`UPDATE employee_certifications SET status = 'expired' WHERE status = 'active' AND expiry_date < CURRENT_DATE`);
  await q(`UPDATE employee_certifications SET status = 'active' WHERE status NOT IN ('active','expired','renewed','revoked')`);
  await q(`DO $$ BEGIN
             ALTER TABLE employee_certifications ADD CONSTRAINT employee_certifications_status_chk CHECK (status IN ('active','expired','renewed','revoked'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* ── 3. Trainings ─────────────────────────────────────────────────────── */
  await q(`ALTER TABLE training_programs
             ADD COLUMN IF NOT EXISTS end_date DATE,
             ADD COLUMN IF NOT EXISTS refresher_months SMALLINT,
             ADD COLUMN IF NOT EXISTS series_id INTEGER REFERENCES training_programs(id) ON DELETE SET NULL,
             ADD COLUMN IF NOT EXISTS competency_id INTEGER REFERENCES competency_framework(id) ON DELETE SET NULL,
             ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
             ADD COLUMN IF NOT EXISTS created_by INTEGER,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`UPDATE training_programs SET status = 'planned' WHERE status IS NULL OR status NOT IN ('planned','ongoing','completed','cancelled')`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_programs ADD CONSTRAINT training_programs_status_chk CHECK (status IN ('planned','ongoing','completed','cancelled'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_programs ADD CONSTRAINT training_programs_mode_chk CHECK (mode IN ('offline','online','hybrid'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_programs ADD CONSTRAINT training_programs_refresher_chk CHECK (refresher_months IS NULL OR refresher_months BETWEEN 1 AND 60);
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_programs ADD CONSTRAINT training_programs_dates_chk CHECK (end_date IS NULL OR scheduled_date IS NULL OR end_date >= scheduled_date);
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_programs ADD CONSTRAINT training_programs_trainer_fk FOREIGN KEY (trainer_id) REFERENCES trainers(id) ON DELETE SET NULL;
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tp_company_date ON training_programs (company_id, scheduled_date) WHERE deleted_at IS NULL`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tp_series ON training_programs (series_id)`);

  await q(`ALTER TABLE training_enrollments
             ADD COLUMN IF NOT EXISTS enrolled_by INTEGER,
             ADD COLUMN IF NOT EXISTS enrolled_via VARCHAR(20) NOT NULL DEFAULT 'hr',
             ADD COLUMN IF NOT EXISTS completed_by INTEGER,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`UPDATE training_enrollments
              SET status = CASE WHEN completion_date IS NOT NULL THEN 'completed' ELSE 'enrolled' END
            WHERE status IS NULL OR status NOT IN ('enrolled','in_progress','completed','no_show','withdrawn')`);
  await q(`DELETE FROM training_enrollments te WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = te.employee_id)`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_enrollments ADD CONSTRAINT training_enrollments_status_chk CHECK (status IN ('enrolled','in_progress','completed','no_show','withdrawn'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_enrollments ADD CONSTRAINT training_enrollments_via_chk CHECK (enrolled_via IN ('hr','self','path','onboarding'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_enrollments ADD CONSTRAINT training_enrollments_score_chk CHECK (score IS NULL OR score BETWEEN 0 AND 100);
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_enrollments ADD CONSTRAINT training_enrollments_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`CREATE INDEX IF NOT EXISTS idx_te_employee ON training_enrollments (employee_id)`);

  await q(`ALTER TABLE training_costs
             ADD COLUMN IF NOT EXISTS cost_date DATE NOT NULL DEFAULT CURRENT_DATE,
             ADD COLUMN IF NOT EXISTS created_by INTEGER`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_costs ADD CONSTRAINT training_costs_amount_chk CHECK (amount >= 0);
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  await q(`UPDATE training_sessions SET status = 'scheduled' WHERE status IS NULL OR status NOT IN ('scheduled','completed','cancelled')`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_sessions ADD CONSTRAINT training_sessions_status_chk CHECK (status IN ('scheduled','completed','cancelled'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DELETE FROM training_attendance ta WHERE NOT EXISTS (SELECT 1 FROM training_sessions s WHERE s.id = ta.session_id)`);
  await q(`DO $$ BEGIN
             ALTER TABLE training_attendance ADD CONSTRAINT training_attendance_session_fk FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE;
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS training_attendance_session_emp_uq ON training_attendance (session_id, employee_id)`);

  /* Trainers: rating / total_sessions were never maintained — computed now. */
  await q(`ALTER TABLE trainers DROP COLUMN IF EXISTS rating, DROP COLUMN IF EXISTS total_sessions`);
  await q(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`UPDATE trainers SET trainer_type = 'external' WHERE trainer_type NOT IN ('internal','external')`);
  await q(`DO $$ BEGIN
             ALTER TABLE trainers ADD CONSTRAINT trainers_type_chk CHECK (trainer_type IN ('internal','external'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* ── 4. Learning paths ────────────────────────────────────────────────── */
  await q(`ALTER TABLE learning_paths
             ADD COLUMN IF NOT EXISTS auto_assign_on_join BOOLEAN NOT NULL DEFAULT false,
             ADD COLUMN IF NOT EXISTS due_days SMALLINT,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS learning_paths_company_name_active_uq
             ON learning_paths (COALESCE(company_id, 0), LOWER(name)) WHERE is_active`);
  /* Items are replaced as a set, so a prerequisite must name a programme, not an item id. */
  await q(`ALTER TABLE learning_path_items ADD COLUMN IF NOT EXISTS prerequisite_program_id INTEGER REFERENCES training_programs(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE learning_path_items DROP COLUMN IF EXISTS prerequisite_item_id`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS learning_path_items_path_program_uq ON learning_path_items (path_id, program_id)`);
  await q(`UPDATE employee_learning_paths SET status = 'in_progress' WHERE status IS NULL OR status NOT IN ('in_progress','completed','withdrawn')`);
  await q(`DO $$ BEGIN
             ALTER TABLE employee_learning_paths ADD CONSTRAINT employee_learning_paths_status_chk CHECK (status IN ('in_progress','completed','withdrawn'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`DELETE FROM employee_learning_paths x WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = x.employee_id)`);
  await q(`DO $$ BEGIN
             ALTER TABLE employee_learning_paths ADD CONSTRAINT employee_learning_paths_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* ── 5. Assessments: review of short answers, server-side timing ──────── */
  await q(`ALTER TABLE assessments
             ADD COLUMN IF NOT EXISTS created_by INTEGER,
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`UPDATE assessment_questions SET question_type = 'mcq' WHERE question_type NOT IN ('mcq','true_false','short_answer')`);
  await q(`DO $$ BEGIN
             ALTER TABLE assessment_questions ADD CONSTRAINT assessment_questions_type_chk CHECK (question_type IN ('mcq','true_false','short_answer'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`ALTER TABLE assessment_attempts
             ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) NOT NULL DEFAULT 'auto',
             ADD COLUMN IF NOT EXISTS question_marks JSONB NOT NULL DEFAULT '{}'::jsonb,
             ADD COLUMN IF NOT EXISTS time_exceeded BOOLEAN NOT NULL DEFAULT false,
             ADD COLUMN IF NOT EXISTS reviewed_by INTEGER,
             ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
  await q(`DO $$ BEGIN
             ALTER TABLE assessment_attempts ADD CONSTRAINT assessment_attempts_review_chk CHECK (review_status IN ('auto','pending_review','reviewed'));
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q(`ALTER TABLE assessment_attempts DROP CONSTRAINT IF EXISTS assessment_attempts_enrollment_id_fkey`);
  await q(`ALTER TABLE assessment_attempts ADD CONSTRAINT assessment_attempts_enrollment_id_fkey
             FOREIGN KEY (enrollment_id) REFERENCES training_enrollments(id) ON DELETE SET NULL`);
  await q(`DELETE FROM assessment_attempts x WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = x.employee_id)`);
  await q(`DO $$ BEGIN
             ALTER TABLE assessment_attempts ADD CONSTRAINT assessment_attempts_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
           EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* ── 6. Settings: one column per setting, every one read somewhere ────── */
  await q(`ALTER TABLE lnd_settings
             ADD COLUMN IF NOT EXISTS default_max_attempts SMALLINT NOT NULL DEFAULT 3,
             ADD COLUMN IF NOT EXISTS default_refresher_months SMALLINT NOT NULL DEFAULT 12`);
  await q(`DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lnd_settings' AND column_name='max_attempts_default') THEN
               UPDATE lnd_settings SET default_max_attempts = COALESCE(max_attempts_default, 3);
             END IF;
             IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lnd_settings' AND column_name='mandatory_training_freq_days') THEN
               UPDATE lnd_settings SET default_refresher_months = GREATEST(1, LEAST(60, ROUND(COALESCE(mandatory_training_freq_days, 365) / 30.0)));
             END IF;
           END $$`);
  await q(`ALTER TABLE lnd_settings
             DROP COLUMN IF EXISTS cert_reminder_days,
             DROP COLUMN IF EXISTS mandatory_grace_days,
             DROP COLUMN IF EXISTS pass_score_default,
             DROP COLUMN IF EXISTS max_attempts_default,
             DROP COLUMN IF EXISTS auto_update_skill_on_complete,
             DROP COLUMN IF EXISTS notify_on_enrollment,
             DROP COLUMN IF EXISTS notify_on_completion,
             DROP COLUMN IF EXISTS notify_cert_expiry,
             DROP COLUMN IF EXISTS skill_categories,
             DROP COLUMN IF EXISTS mandatory_training_freq_days`);

  /* ── 7. Mail templates for the reminder job (sent only when SMTP is set) ─ */
  for (const [trigger, name, subject, body] of TPL) {
    await q(`INSERT INTO email_templates (name, template_name, category, stage_trigger, module, subject, body_html, is_active, company_id, created_at, updated_at)
             SELECT $1::varchar, $1::text, $2::varchar, $2::varchar, 'training', $3::text, $4::text, true, NULL, NOW(), NOW()
              WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE stage_trigger = $2::varchar AND deleted_at IS NULL)`,
      [name, trigger, subject, body]);
  }
}

export async function down() {
  // Tables were dropped and columns folded together: not reversible without
  // data loss. Restore from the pre-migration backup instead.
  throw new Error('20261118000003 is not reversible — restore from backup.');
}
