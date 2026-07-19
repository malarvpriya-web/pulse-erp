export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_shift_assignments (
      id               SERIAL PRIMARY KEY,
      employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      shift_id         INTEGER NOT NULL REFERENCES hr_shifts(id) ON DELETE CASCADE,
      effective_from   DATE,
      note             TEXT,
      is_active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, shift_id, effective_from)
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_shift_rotations (
      id                SERIAL PRIMARY KEY,
      team              VARCHAR(120) NOT NULL,
      week_1_shift_id   INTEGER NOT NULL REFERENCES hr_shifts(id) ON DELETE CASCADE,
      week_2_shift_id   INTEGER NOT NULL REFERENCES hr_shifts(id) ON DELETE CASCADE,
      effective_from    DATE,
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_shift_rotation_weeks_diff CHECK (week_1_shift_id <> week_2_shift_id)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_hr_shift_assignments_employee ON hr_shift_assignments(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_hr_shift_assignments_shift ON hr_shift_assignments(shift_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_hr_shift_rotations_team ON hr_shift_rotations(team)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS hr_shift_rotations CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS hr_shift_assignments CASCADE`);
}

