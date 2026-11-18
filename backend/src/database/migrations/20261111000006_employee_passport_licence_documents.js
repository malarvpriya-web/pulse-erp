/**
 * 20261111000006 — passport and driving licence on the employee record.
 *
 * Owner, 11 Nov 26: documents are collected on Add Employee and uploaded by HR
 * only; the separate Employee Documents register is not needed. Add Employee
 * had no passport or licence at all (the two number columns existed since
 * 20260612000002 but no form field wrote them), so this adds the scanned copy
 * and expiry date of each, alongside the other document columns.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() drops the four columns.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS passport_file          VARCHAR(500),
      ADD COLUMN IF NOT EXISTS passport_expiry        DATE,
      ADD COLUMN IF NOT EXISTS driving_license_file   VARCHAR(500),
      ADD COLUMN IF NOT EXISTS driving_license_expiry DATE
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE employees
      DROP COLUMN IF EXISTS passport_file,
      DROP COLUMN IF EXISTS passport_expiry,
      DROP COLUMN IF EXISTS driving_license_file,
      DROP COLUMN IF EXISTS driving_license_expiry
  `);
}
