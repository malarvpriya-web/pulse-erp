/**
 * Onboarding checklist — mirrors the offboarding checklist pattern.
 * Templates define what must be done; progress tracks per-employee completion.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_onboarding_checklist_templates (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER REFERENCES companies(id),
      category           VARCHAR(120) NOT NULL,
      item_label         VARCHAR(255) NOT NULL,
      default_assignee   VARCHAR(60) NOT NULL DEFAULT 'HR',
      default_offset_days INTEGER NOT NULL DEFAULT 0,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      is_active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, category, item_label)
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_onboarding_checklist_progress (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER REFERENCES companies(id),
      employee_id        INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      category           VARCHAR(120) NOT NULL,
      item_label         VARCHAR(255) NOT NULL,
      done               BOOLEAN NOT NULL DEFAULT FALSE,
      assignee           VARCHAR(60) NOT NULL DEFAULT 'HR',
      due_date           DATE,
      notes              TEXT,
      completed_at       TIMESTAMPTZ,
      completed_by       INTEGER REFERENCES employees(id),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, category, item_label)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_onboarding_progress_emp     ON hr_onboarding_checklist_progress(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_onboarding_progress_company ON hr_onboarding_checklist_progress(company_id)`);

  // Seed default onboarding template items
  await knex.raw(`
    INSERT INTO hr_onboarding_checklist_templates (category, item_label, default_assignee, default_offset_days, sort_order)
    VALUES
      ('Documentation',   'Collect and verify offer letter acceptance',   'HR',      0,   1),
      ('Documentation',   'Collect Aadhaar and PAN copies',               'HR',      0,   2),
      ('Documentation',   'Collect 10th/12th/degree certificates',        'HR',      0,   3),
      ('Documentation',   'Collect previous experience letters',          'HR',      0,   4),
      ('Documentation',   'Bank account details form',                    'HR',      1,   5),
      ('IT Setup',        'Create email and system accounts',             'IT',      0,   6),
      ('IT Setup',        'Assign laptop / workstation',                  'IT',      0,   7),
      ('IT Setup',        'Set up access cards / biometric enrollment',   'IT',      1,   8),
      ('IT Setup',        'Install required software tools',              'IT',      1,   9),
      ('Induction',       'Company orientation and values session',       'HR',      1,  10),
      ('Induction',       'HR policies walkthrough',                      'HR',      1,  11),
      ('Induction',       'Department introduction and team meeting',     'Manager', 2,  12),
      ('Induction',       'Safety and compliance training',               'HR',      3,  13),
      ('Payroll Setup',   'Add to payroll and verify salary structure',   'Payroll', 2,  14),
      ('Payroll Setup',   'ESI/PF enrollment',                           'Payroll', 2,  15),
      ('Payroll Setup',   'Submit IT declaration form',                   'HR',      7,  16),
      ('Probation',       'Set probation end date and review schedule',   'HR',      3,  17),
      ('Probation',       'Assign buddy / mentor',                        'Manager', 1,  18)
    ON CONFLICT DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS hr_onboarding_checklist_progress  CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS hr_onboarding_checklist_templates CASCADE`);
}
