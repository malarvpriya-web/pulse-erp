/**
 * 20260707000002_add_is_field_employee.js
 *
 * Field-employee flag for attendance policy exemptions.
 *
 * Clock-in policy (2026-07-07): office staff may clock in only within
 * ±15 minutes of their shift start and inside a mandatory geo-fence.
 * Employees flagged `is_field_employee` are exempt from both the shift
 * window and the geo-fence (they punch from customer sites at any hour);
 * face verification still applies to everyone.
 */
export async function up(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'employees' AND column_name = 'is_field_employee') THEN
        ALTER TABLE employees ADD COLUMN is_field_employee BOOLEAN NOT NULL DEFAULT FALSE;
      END IF;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS is_field_employee`);
}
