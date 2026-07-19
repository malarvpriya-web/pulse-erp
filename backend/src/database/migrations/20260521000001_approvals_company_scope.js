/**
 * 20260521000001_approvals_company_scope.js
 * Adds company_id + branch_id to the approvals table for multi-tenant scoping.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE approvals
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_approvals_company ON approvals(company_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_branch  ON approvals(branch_id);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_approvals_company;
    DROP INDEX IF EXISTS idx_approvals_branch;
    ALTER TABLE approvals
      DROP COLUMN IF EXISTS company_id,
      DROP COLUMN IF EXISTS branch_id;
  `);
}
