/**
 * 20260529000003_approvals_schema_hardening.js
 * Adds missing columns to approvals table and creates approval_chain table.
 * Fixes P0 schema defects found in Phase 45C audit.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE approvals
      ADD COLUMN IF NOT EXISTS module_name    VARCHAR(100),
      ADD COLUMN IF NOT EXISTS reference_id   INTEGER,
      ADD COLUMN IF NOT EXISTS reference_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS requester_name VARCHAR(255);

    CREATE INDEX IF NOT EXISTS idx_approvals_module ON approvals(module_name, reference_id);

    CREATE TABLE IF NOT EXISTS approval_chain (
      id            SERIAL PRIMARY KEY,
      approval_id   INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
      step_order    INTEGER NOT NULL DEFAULT 1,
      approver_name VARCHAR(255),
      approver      VARCHAR(255),
      approver_id   INTEGER,
      status        VARCHAR(20) DEFAULT 'Pending',
      decision_date TIMESTAMP,
      comment       TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_approval_chain_approval ON approval_chain(approval_id);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS approval_chain;
    DROP INDEX IF EXISTS idx_approvals_module;
    ALTER TABLE approvals
      DROP COLUMN IF EXISTS module_name,
      DROP COLUMN IF EXISTS reference_id,
      DROP COLUMN IF EXISTS reference_type,
      DROP COLUMN IF EXISTS requester_name;
  `);
}
