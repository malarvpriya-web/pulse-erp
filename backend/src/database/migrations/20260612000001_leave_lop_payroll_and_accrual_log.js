/**
 * 20260612000001_leave_lop_payroll_and_accrual_log
 *
 * 1. payroll_runs.lop_days + payroll_runs.lop_amount — direct LOP posting columns
 * 2. leave_accrual_log — per-event audit trail for every accrual increment
 * 3. India national holidays seed (Republic Day, Independence Day, Gandhi Jayanti)
 * 4. leave_types.l2_required — make L2 approval mandatory per leave type
 */
export async function up(knex) {
  // 1. LOP columns on payroll_runs
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS lop_days   NUMERIC(6,2) DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS lop_amount NUMERIC(12,2) DEFAULT 0`);

  // 2. Leave accrual log table
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS leave_accrual_log (
      id             SERIAL PRIMARY KEY,
      employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type_id  INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
      year           INTEGER NOT NULL,
      month          INTEGER,
      days_accrued   NUMERIC(6,2) NOT NULL,
      accrual_type   VARCHAR(30) DEFAULT 'monthly',
      run_by         INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      run_mode       VARCHAR(20) DEFAULT 'cron',
      company_id     INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_accrual_log_emp_year ON leave_accrual_log(employee_id, year)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_accrual_log_company  ON leave_accrual_log(company_id)`);

  // 3. l2_required flag on leave_types
  await knex.raw(`ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS l2_required BOOLEAN DEFAULT false`);

  // 4. India national holidays (NULL company_id = global seed)
  const nationalHolidays = [
    { name: 'Republic Day',       date: '2026-01-26', type: 'National', description: '77th Republic Day of India' },
    { name: 'Independence Day',   date: '2026-08-15', type: 'National', description: '80th Independence Day of India' },
    { name: 'Gandhi Jayanti',     date: '2026-10-02', type: 'National', description: 'Birth anniversary of Mahatma Gandhi' },
    { name: 'Christmas Day',      date: '2026-12-25', type: 'Festival', description: 'Christmas' },
    { name: 'Republic Day',       date: '2027-01-26', type: 'National', description: '78th Republic Day of India' },
    { name: 'Independence Day',   date: '2027-08-15', type: 'National', description: '81st Independence Day of India' },
    { name: 'Gandhi Jayanti',     date: '2027-10-02', type: 'National', description: 'Birth anniversary of Mahatma Gandhi' },
    { name: 'Christmas Day',      date: '2027-12-25', type: 'Festival', description: 'Christmas' },
  ];

  for (const h of nationalHolidays) {
    await knex.raw(`
      INSERT INTO holidays (name, date, type, description, company_id)
      VALUES ($1, $2, $3, $4, NULL)
      ON CONFLICT DO NOTHING
    `, [h.name, h.date, h.type, h.description]).catch(() => {});
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS lop_days`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS lop_amount`);
  await knex.raw(`DROP TABLE IF EXISTS leave_accrual_log`);
  await knex.raw(`ALTER TABLE leave_types DROP COLUMN IF EXISTS l2_required`);
  await knex.raw(`DELETE FROM holidays WHERE company_id IS NULL AND name IN ('Republic Day','Independence Day','Gandhi Jayanti')`);
}
