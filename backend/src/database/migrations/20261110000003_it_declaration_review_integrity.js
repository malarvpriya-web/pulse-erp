/**
 * IT declaration review integrity (§263).
 *
 * it_declarations had no constraint beyond NOT NULL: five seed rows carried
 * financial_year 'SEED finan', status 'active' and invented sections, which
 * neither payroll nor HR → IT Declaration Review could ever read.
 *
 *   claimed_amount  what the employee declared. `amount` is the figure payroll
 *                   uses; a reviewer may approve less than claimed (never more).
 *   metro_city      HRA only: the employee lives in a metro city, so the HRA
 *                   exemption uses 50% of Basic instead of 40%. Payroll never
 *                   had this fact and always used 40%.
 *   CHECKs          status, section, financial-year shape (consecutive years),
 *                   amount > 0, amount <= claimed_amount.
 *   FK              employee_id → employees(id).
 *
 * A database that still holds rows breaking a rule gets that constraint
 * NOT VALID (enforced for new writes, old rows left for review) instead of a
 * failed migration. The runner is a pg shim: placeholders are $n.
 */
const CONSTRAINTS = [
  ['it_declarations_status_chk', `CHECK (status IN ('submitted', 'approved', 'rejected'))`],
  ['it_declarations_type_chk', `CHECK (declaration_type IN ('80C', '80CCD', '80D', 'HOME_LOAN', 'HRA', 'LTA', 'other'))`],
  ['it_declarations_fy_chk', `CHECK (financial_year ~ '^[0-9]{4}-[0-9]{4}$'
      AND substring(financial_year, 6, 4)::int = substring(financial_year, 1, 4)::int + 1)`],
  ['it_declarations_amount_chk', `CHECK (amount > 0 AND amount <= claimed_amount)`],
  ['it_declarations_employee_fk', `FOREIGN KEY (employee_id) REFERENCES employees(id)`],
];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE it_declarations
      ADD COLUMN IF NOT EXISTS claimed_amount numeric(12,2),
      ADD COLUMN IF NOT EXISTS metro_city boolean NOT NULL DEFAULT false`);
  await knex.raw(`UPDATE it_declarations SET claimed_amount = amount WHERE claimed_amount IS NULL`);
  await knex.raw(`ALTER TABLE it_declarations ALTER COLUMN claimed_amount SET NOT NULL`);
  await knex.raw(`ALTER TABLE it_declarations ALTER COLUMN status SET DEFAULT 'submitted'`);
  await knex.raw(`UPDATE it_declarations SET status = 'submitted' WHERE status IS NULL`);
  await knex.raw(`ALTER TABLE it_declarations ALTER COLUMN status SET NOT NULL`);

  for (const [name, def] of CONSTRAINTS) {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) continue;
    await knex.raw(`ALTER TABLE it_declarations ADD CONSTRAINT ${name} ${def} NOT VALID`);
    // The runner wraps each migration in one transaction: a failed VALIDATE
    // must roll back to a savepoint, not abort the whole migration.
    await knex.raw(`SAVEPOINT it_decl_validate`);
    try {
      await knex.raw(`ALTER TABLE it_declarations VALIDATE CONSTRAINT ${name}`);
      await knex.raw(`RELEASE SAVEPOINT it_decl_validate`);
    } catch {
      // Old rows break it: keep it enforced for new writes only (see header).
      await knex.raw(`ROLLBACK TO SAVEPOINT it_decl_validate`);
    }
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_it_declarations_employee_fy ON it_declarations (employee_id, financial_year)`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ix_it_declarations_employee_fy`);
  for (const [name] of [...CONSTRAINTS].reverse()) {
    await knex.raw(`ALTER TABLE it_declarations DROP CONSTRAINT IF EXISTS ${name}`);
  }
  await knex.raw(`ALTER TABLE it_declarations ALTER COLUMN status DROP NOT NULL`);
  await knex.raw(`ALTER TABLE it_declarations DROP COLUMN IF EXISTS metro_city, DROP COLUMN IF EXISTS claimed_amount`);
}
