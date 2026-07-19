// Migration: add company_id to fixed_assets and asset_depreciation_log
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT fa_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT fa_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT fa_sp');
      if (!e.message.includes('already exists')) {
        console.warn(`[fixed_assets_company_id] skip (${label}): ${e.message.split('\n')[0]}`);
      }
    }
  };

  await safe('company_id on fixed_assets',
    `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);

  await safe('company_id on asset_depreciation_log',
    `ALTER TABLE asset_depreciation_log ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  await safe('idx fixed_assets company_id',
    `CREATE INDEX IF NOT EXISTS idx_fixed_assets_company_id ON fixed_assets(company_id)`);

  await safe('idx fixed_assets company_status',
    `CREATE INDEX IF NOT EXISTS idx_fixed_assets_company_status ON fixed_assets(company_id, status)`);

  await safe('idx fixed_assets warranty',
    `CREATE INDEX IF NOT EXISTS idx_fixed_assets_warranty ON fixed_assets(company_id, warranty_expiry) WHERE warranty_expiry IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_fixed_assets_warranty`).catch(() => {});
  await knex.raw(`DROP INDEX IF EXISTS idx_fixed_assets_company_status`).catch(() => {});
  await knex.raw(`DROP INDEX IF EXISTS idx_fixed_assets_company_id`).catch(() => {});
  await knex.raw(`ALTER TABLE asset_depreciation_log DROP COLUMN IF EXISTS company_id`).catch(() => {});
  await knex.raw(`ALTER TABLE fixed_assets DROP COLUMN IF EXISTS company_id`).catch(() => {});
}
