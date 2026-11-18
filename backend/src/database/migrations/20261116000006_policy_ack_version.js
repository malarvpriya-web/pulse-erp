/**
 * 20261116000006_policy_ack_version.js — HR audit 2026-11-16, B6 (11-03 F-33) and F-34.
 *
 * 1. hr_policy_acknowledgements.policy_version: the version the employee
 *    accepted. A new version of a policy used to keep every old acknowledgement
 *    (UNIQUE (policy_id, employee_id) + ON CONFLICT DO NOTHING), so nobody was
 *    asked to accept it. Now an acknowledgement counts only for the version it
 *    names, and each version's acknowledgement is kept (they are the record).
 *    Existing rows are stamped with the policy's CURRENT version: they were
 *    given against it as far as the data can tell.
 *    UNIQUE (policy_id, employee_id) → UNIQUE NULLS NOT DISTINCT
 *    (policy_id, employee_id, policy_version). PostgreSQL 15+ (dev: 18).
 * 2. F-34: hr_policy_acknowledgements.employee_id and employee_documents.employee_id
 *    gain a foreign key to employees, NOT VALID — enforced for new and changed
 *    rows; existing rows (some on deleted employees) are left for the clean-up.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE hr_policy_acknowledgements ADD COLUMN IF NOT EXISTS policy_version VARCHAR(50)`);
  await knex.raw(`
    UPDATE hr_policy_acknowledgements a SET policy_version = p.version
      FROM hr_policies p WHERE p.id = a.policy_id AND a.policy_version IS NULL`);
  await knex.raw(`ALTER TABLE hr_policy_acknowledgements
                    DROP CONSTRAINT IF EXISTS hr_policy_acknowledgements_policy_id_employee_id_key`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_policy_ack_one_per_version') THEN
        ALTER TABLE hr_policy_acknowledgements ADD CONSTRAINT hr_policy_ack_one_per_version
          UNIQUE NULLS NOT DISTINCT (policy_id, employee_id, policy_version);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_policy_acknowledgements_employee_id_fkey') THEN
        ALTER TABLE hr_policy_acknowledgements ADD CONSTRAINT hr_policy_acknowledgements_employee_id_fkey
          FOREIGN KEY (employee_id) REFERENCES employees(id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_documents_employee_id_fkey') THEN
        ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_employee_id_fkey
          FOREIGN KEY (employee_id) REFERENCES employees(id) NOT VALID;
      END IF;
    END $$`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employee_documents DROP CONSTRAINT IF EXISTS employee_documents_employee_id_fkey`);
  await knex.raw(`ALTER TABLE hr_policy_acknowledgements DROP CONSTRAINT IF EXISTS hr_policy_acknowledgements_employee_id_fkey`);
  await knex.raw(`ALTER TABLE hr_policy_acknowledgements DROP CONSTRAINT IF EXISTS hr_policy_ack_one_per_version`);
  // Keep one row per (policy, employee) — the earliest — so the old key can return.
  await knex.raw(`
    DELETE FROM hr_policy_acknowledgements a USING hr_policy_acknowledgements b
     WHERE a.policy_id = b.policy_id AND a.employee_id = b.employee_id
       AND (a.acknowledged_at, a.id) > (b.acknowledged_at, b.id)`);
  await knex.raw(`ALTER TABLE hr_policy_acknowledgements
                    ADD CONSTRAINT hr_policy_acknowledgements_policy_id_employee_id_key UNIQUE (policy_id, employee_id)`);
  await knex.raw(`ALTER TABLE hr_policy_acknowledgements DROP COLUMN IF EXISTS policy_version`);
}
