/**
 * 20261116000004_exit_interviews_employee_fk.js — HR audit 2026-11-16, B3.
 *
 * exit_interviews.employee_id had no foreign key, so rows survived for employee
 * ids that never existed (0, 2147483000 in dev). The key is added NOT VALID: it
 * holds for every new or changed row, and leaves the existing rows alone (they
 * are seed data awaiting the owner's clean-up decision; the list and analytics
 * already ignore any interview not tied to that employee's exit).
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exit_interviews_employee_id_fkey') THEN
        ALTER TABLE exit_interviews
          ADD CONSTRAINT exit_interviews_employee_id_fkey
          FOREIGN KEY (employee_id) REFERENCES employees(id) NOT VALID;
      END IF;
    END $$`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE exit_interviews DROP CONSTRAINT IF EXISTS exit_interviews_employee_id_fkey`);
}
