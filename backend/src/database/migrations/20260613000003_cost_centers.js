/**
 * Migration: Create cost_centers master table
 * Fixes audit gap: no cost center master existed — only free-text cost_centre VARCHAR.
 * Adds cost_center_id FK to journal_lines, budgets, and fixed_assets for proper reporting.
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT sp');
      console.warn(`[20260613000003] Skipped (${label}): ${e.message}`);
    }
  };

  await safe('create cost_centers table', `
    CREATE TABLE IF NOT EXISTS cost_centers (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code          VARCHAR(20) NOT NULL,
      name          VARCHAR(100) NOT NULL,
      description   TEXT,
      parent_id     INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, code)
    )
  `);

  await safe('idx cost_centers company_id',
    `CREATE INDEX IF NOT EXISTS idx_cost_centers_company_id ON cost_centers (company_id)`);
  await safe('idx cost_centers parent',
    `CREATE INDEX IF NOT EXISTS idx_cost_centers_parent ON cost_centers (parent_id)`);

  await safe('add cost_center_id to journal_lines',
    `ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS cost_center_id INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL`);
  await safe('idx journal_lines cost_center',
    `CREATE INDEX IF NOT EXISTS idx_journal_lines_cost_center ON journal_lines (cost_center_id)`);

  await safe('add cost_center_id to budgets',
    `ALTER TABLE budgets ADD COLUMN IF NOT EXISTS cost_center_id INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL`);
  await safe('idx budgets cost_center',
    `CREATE INDEX IF NOT EXISTS idx_budgets_cost_center ON budgets (cost_center_id)`);

  await safe('add cost_center_id to fixed_assets',
    `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS cost_center_id INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL`);
  await safe('idx fixed_assets cost_center',
    `CREATE INDEX IF NOT EXISTS idx_fixed_assets_cost_center ON fixed_assets (cost_center_id)`);

  await safe('seed default cost centers', `
    INSERT INTO cost_centers (company_id, code, name, description)
    SELECT
      c.id,
      cc.code,
      cc.name,
      cc.description
    FROM companies c
    CROSS JOIN (
      VALUES
        ('CC-ADM', 'Administration',  'General admin and overhead'),
        ('CC-SLS', 'Sales',           'Sales and business development'),
        ('CC-MFG', 'Manufacturing',   'Production and shop floor'),
        ('CC-R&D', 'Research & Dev',  'R&D and engineering'),
        ('CC-FIN', 'Finance',         'Finance and accounts'),
        ('CC-HR',  'Human Resources', 'HR and payroll')
    ) AS cc(code, name, description)
    ON CONFLICT (company_id, code) DO NOTHING
  `);
}

export async function down(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try { await knex.raw(sql); await knex.raw('RELEASE SAVEPOINT sp'); }
    catch (e) { await knex.raw('ROLLBACK TO SAVEPOINT sp'); console.warn(`[20260613000003 down] ${label}: ${e.message}`); }
  };
  await safe('drop fixed_assets col', `ALTER TABLE fixed_assets DROP COLUMN IF EXISTS cost_center_id`);
  await safe('drop budgets col', `ALTER TABLE budgets DROP COLUMN IF EXISTS cost_center_id`);
  await safe('drop journal_lines col', `ALTER TABLE journal_lines DROP COLUMN IF EXISTS cost_center_id`);
  await safe('drop cost_centers', `DROP TABLE IF EXISTS cost_centers`);
}
