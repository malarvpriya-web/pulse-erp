/**
 * 20260618000002_pulse_erp_eng_scope_fix.js
 *
 * Corrects what 20260618000001 missed because the Step-2 prompt used wrong
 * table names (engineering_projects, design_phases, etc.) that don't exist.
 *
 * This migration adds what was silently skipped:
 *   1. company_id on the real engineering tables:
 *        eng_rd_projects, eng_design_phases, eng_prototypes, eng_test_plans, bom_lines
 *   2. project_id on rm_issues (material consumption — NOT a view)
 *   3. company_id on contacts (multi-tenant scoping)
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (label, sql) => {
    const name = `sp_engfix_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = err.message || '';
      if (!/already exists|does not exist|duplicate column|multiple primary|duplicate key/i.test(msg)) throw err;
      console.warn(`[pulse_erp_eng_scope_fix] skip (${label}): ${msg.split('\n')[0]}`);
    }
  };

  // ─── Engineering tables: add company_id ──────────────────────────────────
  const engTables = [
    'eng_rd_projects',
    'eng_design_phases',
    'eng_prototypes',
    'eng_test_plans',
    'bom_lines',
  ];

  for (const t of engTables) {
    await safe(`${t} add company_id`, `
      ALTER TABLE ${t}
        ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
    `);
    await safe(`${t} backfill company_id`, `
      UPDATE ${t}
      SET company_id = (SELECT id FROM companies WHERE name = 'Manifest Technologies' LIMIT 1)
      WHERE company_id IS NULL
    `);
    await safe(`idx_${t}_company`,
      `CREATE INDEX IF NOT EXISTS idx_${t}_company ON ${t}(company_id)`);
  }

  // ─── rm_issues: project traceability ────────────────────────────────────
  await safe('rm_issues project_id',
    `ALTER TABLE rm_issues ADD COLUMN IF NOT EXISTS project_id INTEGER`);
  await safe('idx rm_issues project',
    `CREATE INDEX IF NOT EXISTS idx_rm_issues_project ON rm_issues(project_id) WHERE project_id IS NOT NULL`);

  // ─── contacts: company_id for multi-tenant scoping ───────────────────────
  await safe('contacts company_id',
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);
  await safe('contacts company_id backfill', `
    UPDATE contacts c
    SET company_id = (
      SELECT a.company_id
      FROM accounts a
      WHERE a.id = c.account_id
        AND a.company_id IS NOT NULL
      LIMIT 1
    )
    WHERE c.company_id IS NULL
      AND c.account_id IS NOT NULL
  `);
  await safe('idx contacts company',
    `CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id)`);

  console.log('[migration 20260618000002] pulse_erp_eng_scope_fix applied.');
}

export async function down(knex) {
  // Destructive — left intentionally empty.
}
