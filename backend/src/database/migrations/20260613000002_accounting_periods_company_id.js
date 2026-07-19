/**
 * Migration: Add company_id to accounting_periods
 * Fixes multi-tenant gap: without company_id, all companies share the same
 * accounting period calendar and can open/close each other's periods.
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT sp');
      console.warn(`[20260613000002] Skipped (${label}): ${e.message}`);
    }
  };

  await safe('add company_id column',
    `ALTER TABLE accounting_periods ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);

  await safe('backfill nulls', `UPDATE accounting_periods SET company_id = 1 WHERE company_id IS NULL`);

  await safe('set not null', `ALTER TABLE accounting_periods ALTER COLUMN company_id SET NOT NULL`);

  await safe('index per-company period lookups',
    `CREATE INDEX IF NOT EXISTS idx_accounting_periods_company_id ON accounting_periods (company_id, fiscal_year, period_number)`);

  await safe('unique company+dates',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_periods_company_period ON accounting_periods (company_id, start_date, end_date)`);
}

export async function down(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try { await knex.raw(sql); await knex.raw('RELEASE SAVEPOINT sp'); }
    catch (e) { await knex.raw('ROLLBACK TO SAVEPOINT sp'); console.warn(`[20260613000002 down] ${label}: ${e.message}`); }
  };
  await safe('drop unique idx', `DROP INDEX IF EXISTS idx_accounting_periods_company_period`);
  await safe('drop idx', `DROP INDEX IF EXISTS idx_accounting_periods_company_id`);
  await safe('drop col', `ALTER TABLE accounting_periods DROP COLUMN IF EXISTS company_id`);
}
