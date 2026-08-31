/**
 * 20260812000003_brand_vault_visibility.js
 *
 * 'Letterhead Template' restricted to HR and Accounts/Finance roles —
 * everyone else no longer sees the tile, but HR/Accounts still can.
 * Adds `visible_roles TEXT[]` to company_documents: NULL (the default,
 * unchanged for every other row) means "visible to all roles"; a non-NULL
 * array means "only these roles (plus admin/super_admin, which always see
 * everything)". home.service.js's getCompanyDocuments() reads this column.
 *
 * ('PPT Template' was briefly soft-deleted by an earlier version of this
 * migration, then reinstated on user instruction the same session — see
 * MODULE_FEATURE_CONNECTION_MANUAL.md §101.1. This file no longer touches it.)
 */
export async function up(knex) {
  const { rows } = await knex.raw(`SELECT to_regclass('public.company_documents') AS t`);
  if (!rows[0].t) return;

  await knex.raw(`
    ALTER TABLE company_documents
      ADD COLUMN IF NOT EXISTS visible_roles TEXT[]
  `);

  await knex.raw(`
    UPDATE company_documents
       SET visible_roles = ARRAY['hr','hr_manager','hr_exec','finance','finance_manager','accounts_exec'],
           updated_at = NOW()
     WHERE category = 'brand_assets' AND title = 'Letterhead Template'
  `);
}

export async function down(knex) {
  const { rows } = await knex.raw(`SELECT to_regclass('public.company_documents') AS t`);
  if (!rows[0].t) return;

  await knex.raw(`
    UPDATE company_documents SET visible_roles = NULL, updated_at = NOW()
     WHERE category = 'brand_assets' AND title = 'Letterhead Template'
  `);
  await knex.raw(`ALTER TABLE company_documents DROP COLUMN IF EXISTS visible_roles`);
}
