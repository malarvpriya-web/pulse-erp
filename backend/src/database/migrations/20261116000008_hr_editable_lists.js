/**
 * 20261116000008_hr_editable_lists.js — HR audit 2026-11-16 (§4 "fixed lists").
 *
 * Three business lists were constants in page files, so a company could not
 * add or retire a value. They become master_values vocabularies (the
 * /master/v/:vocab registry in modules/master/vocabularies.js), editable in
 * Settings → Master Data and from the pickers themselves:
 *
 *   ANNOUNCEMENT_CATEGORY  announcements.category   (Announcements.jsx CATEGORIES)
 *   HR_DOCUMENT_CATEGORY   hr_downloads.category    (Downloads.jsx CATEGORIES)
 *   SUCCESSION_POOL_TYPE   employee_talent_pools.pool_type
 *
 * The seeds are exactly the old lists, shared (company_id NULL), so nothing a
 * page offered disappears. Pool types are stored as their names from now on
 * ('High Potential', not 'hipo'): the CHECK chk_etp_type that held the six keys
 * is dropped, and the API validates against the master instead. Measured
 * 11-16: 0 pools exist in dev, so no stored value changes meaning; any row
 * elsewhere is renamed key → name below.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const SEEDS = {
  ANNOUNCEMENT_CATEGORY: ['General', 'HR Policy', 'Finance', 'IT', 'Operations', 'Legal', 'Urgent', 'Other'],
  HR_DOCUMENT_CATEGORY: ['Letters', 'Forms', 'Onboarding', 'Templates', 'Policies', 'Other'],
  SUCCESSION_POOL_TYPE: ['Leadership', 'Technical', 'High Potential', 'Project Leaders', 'Graduate', 'General'],
};
const POOL_RENAMES = {
  leadership: 'Leadership', technical: 'Technical', hipo: 'High Potential',
  project_leaders: 'Project Leaders', graduate: 'Graduate', general: 'General',
};

export async function up(knex) {
  for (const [type, values] of Object.entries(SEEDS)) {
    for (let i = 0; i < values.length; i++) {
      await knex.raw(
        `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
         VALUES ($1, $2, NULL, $3, NULL, true)
         ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
        [type, values[i], i + 1]);
    }
  }
  await knex.raw(`ALTER TABLE employee_talent_pools DROP CONSTRAINT IF EXISTS chk_etp_type`);
  for (const [key, name] of Object.entries(POOL_RENAMES)) {
    await knex.raw(`UPDATE employee_talent_pools SET pool_type = $2 WHERE pool_type = $1`, [key, name]);
  }
  await knex.raw(`ALTER TABLE employee_talent_pools ALTER COLUMN pool_type SET DEFAULT 'General'`);
}

export async function down(knex) {
  for (const [key, name] of Object.entries(POOL_RENAMES)) {
    await knex.raw(`UPDATE employee_talent_pools SET pool_type = $1 WHERE pool_type = $2`, [key, name]);
  }
  await knex.raw(`UPDATE employee_talent_pools SET pool_type = 'general'
                   WHERE pool_type NOT IN ('leadership','technical','hipo','project_leaders','graduate','general')`);
  await knex.raw(`ALTER TABLE employee_talent_pools ALTER COLUMN pool_type SET DEFAULT 'general'`);
  await knex.raw(`ALTER TABLE employee_talent_pools ADD CONSTRAINT chk_etp_type
                    CHECK (pool_type IN ('leadership','technical','hipo','project_leaders','graduate','general'))`);
  await knex.raw(`DELETE FROM master_values WHERE company_id IS NULL AND type = ANY($1::text[])`, [Object.keys(SEEDS)]);
}
