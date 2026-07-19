/**
 * 20260618000004_production_engineering_company_id.js
 *
 * Adds company_id to production and engineering tables that were created
 * without multi-tenant scoping. Affects: work_centres, production_orders,
 * production_operations, production_materials, power_quality_logs.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (label, sql) => {
    const name = `sp_prodcid_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = err.message || '';
      if (!/already exists|does not exist|duplicate column|does not exist/i.test(msg)) throw err;
      console.warn(`[production_engineering_company_id] skip (${label}): ${msg.split('\n')[0]}`);
    }
  };

  const tables = [
    'work_centres',
    'production_orders',
    'production_operations',
    'production_materials',
    'power_quality_logs',
  ];

  for (const t of tables) {
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

  console.log('[migration 20260618000004] production_engineering_company_id applied.');
}

export async function down(knex) {
  // Destructive — left intentionally empty.
}
