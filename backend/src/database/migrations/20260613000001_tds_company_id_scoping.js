/**
 * Migration: Add company_id to tds_deductees and tds_transactions
 * Fixes P0 multi-tenant data isolation bug — without company_id, all tenants
 * share TDS data, threshold accumulators cross-contaminate, and Form 16A leaks.
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT sp');
      console.warn(`[20260613000001] Skipped (${label}): ${e.message}`);
    }
  };

  await safe('add company_id to tds_deductees',
    `ALTER TABLE tds_deductees ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);

  await safe('add company_id to tds_transactions',
    `ALTER TABLE tds_transactions ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);

  await safe('backfill tds_transactions from deductees',
    `UPDATE tds_transactions tt
     SET company_id = d.company_id
     FROM tds_deductees d
     WHERE tt.deductee_id = d.id AND tt.company_id IS NULL AND d.company_id IS NOT NULL`);

  await safe('backfill tds_deductees nulls', `UPDATE tds_deductees SET company_id = 1 WHERE company_id IS NULL`);
  await safe('backfill tds_transactions nulls', `UPDATE tds_transactions SET company_id = 1 WHERE company_id IS NULL`);

  await safe('not null tds_deductees', `ALTER TABLE tds_deductees ALTER COLUMN company_id SET NOT NULL`);
  await safe('not null tds_transactions', `ALTER TABLE tds_transactions ALTER COLUMN company_id SET NOT NULL`);

  await safe('idx tds_deductees company_id',
    `CREATE INDEX IF NOT EXISTS idx_tds_deductees_company_id ON tds_deductees (company_id)`);
  await safe('idx tds_transactions company_id',
    `CREATE INDEX IF NOT EXISTS idx_tds_transactions_company_id ON tds_transactions (company_id)`);
  await safe('idx tds_transactions fy company',
    `CREATE INDEX IF NOT EXISTS idx_tds_transactions_fy_company ON tds_transactions (financial_year, company_id)`);
}

export async function down(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try { await knex.raw(sql); await knex.raw('RELEASE SAVEPOINT sp'); }
    catch (e) { await knex.raw('ROLLBACK TO SAVEPOINT sp'); console.warn(`[20260613000001 down] ${label}: ${e.message}`); }
  };
  await safe('drop idx fy company', `DROP INDEX IF EXISTS idx_tds_transactions_fy_company`);
  await safe('drop idx transactions cid', `DROP INDEX IF EXISTS idx_tds_transactions_company_id`);
  await safe('drop idx deductees cid', `DROP INDEX IF EXISTS idx_tds_deductees_company_id`);
  await safe('drop col transactions', `ALTER TABLE tds_transactions DROP COLUMN IF EXISTS company_id`);
  await safe('drop col deductees', `ALTER TABLE tds_deductees DROP COLUMN IF EXISTS company_id`);
}
