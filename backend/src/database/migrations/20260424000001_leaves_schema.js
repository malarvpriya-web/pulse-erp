/**
 * Leaves module schema — leave_types, leave_balances (normalized),
 * leave_applications, leave_approval_history.
 *
 * Also adds a stored generated column `name` to employees so that
 * queries using `e.name` (e.g. leaves repository) work correctly
 * against the first_name / last_name schema.
 */

export async function up(knex) {
  // ── employees.name generated column ───────────────────────────────────────
  // The employees table stores first_name + last_name separately.
  // Many module queries use `e.name`; this stored column provides that alias.
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS name TEXT
        GENERATED ALWAYS AS (TRIM(first_name || ' ' || COALESCE(last_name, ''))) STORED
  `);

  // ── leave_types ────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS leave_types (
      id           SERIAL       PRIMARY KEY,
      leave_name   VARCHAR(100) NOT NULL UNIQUE,
      leave_code   VARCHAR(10)  NOT NULL UNIQUE,
      annual_quota INTEGER      NOT NULL DEFAULT 0,
      description  TEXT,
      is_active    BOOLEAN      NOT NULL DEFAULT true,
      deleted_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`
    INSERT INTO leave_types (leave_name, leave_code, annual_quota, description)
    VALUES
      ('Annual Leave',       'ANNUAL',     18,  'Paid annual leave'),
      ('Sick Leave',         'SICK',         6,  'Medical / sick leave'),
      ('Casual Leave',       'CASUAL',       4,  'Casual personal leave'),
      ('Compensatory Leave', 'COMP',         3,  'Leave in lieu of extra work'),
      ('Maternity Leave',    'MATERNITY',  180,  'Maternity leave'),
      ('Paternity Leave',    'PATERNITY',    5,  'Paternity leave')
    ON CONFLICT (leave_name) DO NOTHING
  `);

  // ── leave_balances (normalized) ────────────────────────────────────────────
  // Drop the old flat schema (annual_total / sick_total / casual_total columns)
  // if it exists without leave_type_id — it's incompatible with the routes.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'leave_balances'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'leave_balances'
           AND column_name  = 'leave_type_id'
      ) THEN
        DROP TABLE leave_balances;
      END IF;
    END
    $$
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS leave_balances (
      id             SERIAL        PRIMARY KEY,
      employee_id    INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type_id  INTEGER       NOT NULL REFERENCES leave_types(id),
      year           INTEGER       NOT NULL,
      allocated_days NUMERIC(6,2)  NOT NULL DEFAULT 0,
      used_days      NUMERIC(6,2)           DEFAULT 0,
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, leave_type_id, year)
    )
  `);

  // ── leave_applications ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS leave_applications (
      id                  SERIAL        PRIMARY KEY,
      employee_id         INTEGER       NOT NULL REFERENCES employees(id),
      leave_type_id       INTEGER       NOT NULL REFERENCES leave_types(id),
      start_date          DATE          NOT NULL,
      end_date            DATE          NOT NULL,
      number_of_days      NUMERIC(6,2)  NOT NULL DEFAULT 1,
      reason              TEXT,
      attachment_url      TEXT,
      manager_id          INTEGER       REFERENCES employees(id),
      manager_status      VARCHAR(20)   NOT NULL DEFAULT 'pending',
      manager_comments    TEXT,
      manager_approved_at TIMESTAMPTZ,
      hr_id               INTEGER       REFERENCES employees(id),
      hr_status           VARCHAR(20)   NOT NULL DEFAULT 'pending',
      hr_comments         TEXT,
      hr_approved_at      TIMESTAMPTZ,
      status              VARCHAR(20)   NOT NULL DEFAULT 'pending',
      applied_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      deleted_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  // ── leave_approval_history ─────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS leave_approval_history (
      id                   SERIAL      PRIMARY KEY,
      leave_application_id INTEGER     NOT NULL REFERENCES leave_applications(id) ON DELETE CASCADE,
      approver_id          INTEGER     REFERENCES employees(id),
      approval_level       INTEGER     NOT NULL,
      action               VARCHAR(20) NOT NULL,
      comments             TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS leave_approval_history CASCADE');
  await knex.raw('DROP TABLE IF EXISTS leave_applications     CASCADE');
  await knex.raw('DROP TABLE IF EXISTS leave_balances         CASCADE');
  await knex.raw('DROP TABLE IF EXISTS leave_types            CASCADE');
  await knex.raw('ALTER TABLE employees DROP COLUMN IF EXISTS name');
}
