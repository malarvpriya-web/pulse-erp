/**
 * Payroll module schema — payroll_runs, payslips, salary_structures,
 * employee_salary_assignments, loan_advances.
 *
 * The seed script (runMigrations.js) creates these with CREATE TABLE IF NOT EXISTS,
 * but the migration-runner path does not run that script.  This migration ensures
 * the tables exist under the tracked migration system.
 */

export async function up(knex) {
  // ── payroll_runs ───────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id            SERIAL        PRIMARY KEY,
      period_label  VARCHAR(20)   NOT NULL UNIQUE,
      period_name   VARCHAR(100),
      period_start  DATE,
      period_end    DATE,
      status        VARCHAR(30)   NOT NULL DEFAULT 'draft',
      total_gross   NUMERIC(15,2) NOT NULL DEFAULT 0,
      total_net     NUMERIC(15,2) NOT NULL DEFAULT 0,
      processed_by  INTEGER       REFERENCES users(id),
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  // ── payslips ───────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payslips (
      id                   SERIAL        PRIMARY KEY,
      payroll_run_id       INTEGER       NOT NULL REFERENCES payroll_runs(id),
      employee_id          INTEGER       NOT NULL REFERENCES employees(id),
      basic_salary         NUMERIC(12,2) NOT NULL DEFAULT 0,
      hra                  NUMERIC(12,2)          DEFAULT 0,
      conveyance_allowance NUMERIC(12,2)          DEFAULT 0,
      medical_allowance    NUMERIC(12,2)          DEFAULT 0,
      special_allowance    NUMERIC(12,2)          DEFAULT 0,
      other_allowances     NUMERIC(12,2)          DEFAULT 0,
      gross_salary         NUMERIC(12,2) NOT NULL DEFAULT 0,
      pf_deduction         NUMERIC(12,2)          DEFAULT 0,
      esi_deduction        NUMERIC(12,2)          DEFAULT 0,
      professional_tax     NUMERIC(12,2)          DEFAULT 0,
      tds_deduction        NUMERIC(12,2)          DEFAULT 0,
      other_deductions     NUMERIC(12,2)          DEFAULT 0,
      total_deductions     NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_pay              NUMERIC(12,2) NOT NULL DEFAULT 0,
      status               VARCHAR(20)   NOT NULL DEFAULT 'pending',
      paid_on              DATE,
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (payroll_run_id, employee_id)
    )
  `);

  // ── salary_structures ──────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS salary_structures (
      id          SERIAL      PRIMARY KEY,
      name        VARCHAR(200),
      description TEXT,
      is_active   BOOLEAN     NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── employee_salary_assignments ────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_salary_assignments (
      id                  SERIAL        PRIMARY KEY,
      employee_id         INTEGER       REFERENCES employees(id),
      salary_structure_id INTEGER       REFERENCES salary_structures(id),
      effective_date      DATE,
      basic_salary        NUMERIC(12,2),
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  // ── loan_advances ──────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS loan_advances (
      id          SERIAL        PRIMARY KEY,
      employee_id INTEGER       REFERENCES employees(id),
      loan_type   VARCHAR(50),
      amount      NUMERIC(12,2),
      emi_amount  NUMERIC(12,2),
      total_emis  INTEGER,
      paid_emis   INTEGER       NOT NULL DEFAULT 0,
      status      VARCHAR(20)   NOT NULL DEFAULT 'active',
      approved_by INTEGER       REFERENCES users(id),
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS loan_advances                CASCADE');
  await knex.raw('DROP TABLE IF EXISTS employee_salary_assignments  CASCADE');
  await knex.raw('DROP TABLE IF EXISTS salary_structures            CASCADE');
  await knex.raw('DROP TABLE IF EXISTS payslips                     CASCADE');
  await knex.raw('DROP TABLE IF EXISTS payroll_runs                 CASCADE');
}
