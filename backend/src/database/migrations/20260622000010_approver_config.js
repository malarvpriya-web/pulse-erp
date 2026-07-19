/**
 * 20260622000010_approver_config.js
 *
 * Creates approver_config table and seeds initial rows that reflect the
 * two workflows already active in the `workflows` table:
 *   - Leave Approval       → manager (seq 1) → hr (seq 2)
 *   - Project Creation     → manager (seq 1)
 *
 * BACKWARD COMPAT: IF NOT EXISTS / ON CONFLICT everywhere.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS approver_config (
      id             SERIAL PRIMARY KEY,
      module         VARCHAR(100) NOT NULL,
      sequence       INTEGER      NOT NULL DEFAULT 1,
      approver_role  VARCHAR(100) NOT NULL,
      approver_email VARCHAR(255) DEFAULT '',
      is_active      BOOLEAN      DEFAULT TRUE,
      created_at     TIMESTAMPTZ  DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  DEFAULT NOW()
    );
    ALTER TABLE approver_config
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_approver_config_module ON approver_config(module);
    CREATE INDEX IF NOT EXISTS idx_approver_config_co    ON approver_config(company_id);
  `);

  /* Seed global (company_id = NULL) rows for the two built-in workflows.
     ON CONFLICT does nothing so re-running the migration is safe, but
     we key on (module, sequence, approver_role) to avoid duplicates. */
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM approver_config
        WHERE module = 'leave' AND sequence = 1 AND company_id IS NULL
      ) THEN
        INSERT INTO approver_config (module, sequence, approver_role)
        VALUES ('leave', 1, 'manager');
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM approver_config
        WHERE module = 'leave' AND sequence = 2 AND company_id IS NULL
      ) THEN
        INSERT INTO approver_config (module, sequence, approver_role)
        VALUES ('leave', 2, 'hr');
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM approver_config
        WHERE module = 'project_creation' AND sequence = 1 AND company_id IS NULL
      ) THEN
        INSERT INTO approver_config (module, sequence, approver_role)
        VALUES ('project_creation', 1, 'manager');
      END IF;
    END $$
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS approver_config CASCADE`);
}
