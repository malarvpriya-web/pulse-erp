export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_offboarding_checklist_templates (
      id                 SERIAL PRIMARY KEY,
      category           VARCHAR(120) NOT NULL,
      item_label         VARCHAR(255) NOT NULL,
      default_assignee   VARCHAR(60) NOT NULL DEFAULT 'HR',
      default_offset_days INTEGER NOT NULL DEFAULT 0,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      is_active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (category, item_label)
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_offboarding_checklist_progress (
      id                 SERIAL PRIMARY KEY,
      employee_id        INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      category           VARCHAR(120) NOT NULL,
      item_label         VARCHAR(255) NOT NULL,
      done               BOOLEAN NOT NULL DEFAULT FALSE,
      assignee           VARCHAR(60) NOT NULL DEFAULT 'HR',
      due_date           DATE,
      handover_notes     TEXT,
      completed_at       TIMESTAMPTZ,
      updated_by         INTEGER,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, category, item_label)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_hr_offboarding_progress_emp ON hr_offboarding_checklist_progress(employee_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS hr_offboarding_checklist_progress CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS hr_offboarding_checklist_templates CASCADE`);
}

