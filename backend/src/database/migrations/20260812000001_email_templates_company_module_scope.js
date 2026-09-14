/**
 * 20260812000001_email_templates_company_module_scope.js
 *
 * email_templates is silently shared between Recruitment
 * (recruitment.repository.js — template_name/template_type columns) and CRM
 * (crm/routes/email.routes.js — name/category/stage_trigger columns), with no
 * company_id and no module discriminator at all — every template is globally
 * visible across every tenant and both modules, and (since the 2026-08-12
 * fix that made Recruitment's write path also populate stage_trigger/category
 * so triggerEmail() can actually find its templates) there is no longer any
 * reliable way to tell a Recruitment-authored template from a CRM-authored
 * one by column presence alone. Adds the two missing scope columns; each
 * module's repository/routes are updated in the same change to set and
 * filter by them going forward.
 *
 * Existing rows are backfilled by best-effort inference rather than left
 * NULL-and-guessed: template_type was, historically, only ever written by
 * Recruitment, so any row that has one is tagged 'recruitment'; any
 * remaining row with a category/stage_trigger but no template_type predates
 * this migration and was necessarily written by CRM's own path, tagged
 * 'crm'. company_id is left NULL for all pre-existing rows — there is no way
 * to recover which tenant created them — which is intentional and matches
 * this codebase's established convention elsewhere (companyOf()/cid()) of
 * treating a NULL company_id as "global scope," so old rows stay visible
 * rather than disappearing for every tenant.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE email_templates
      ADD COLUMN IF NOT EXISTS company_id INTEGER,
      ADD COLUMN IF NOT EXISTS module VARCHAR(50)
  `);

  await knex.raw(`
    UPDATE email_templates
       SET module = 'recruitment'
     WHERE module IS NULL
       AND template_type IS NOT NULL
  `);

  await knex.raw(`
    UPDATE email_templates
       SET module = 'crm'
     WHERE module IS NULL
       AND (category IS NOT NULL OR stage_trigger IS NOT NULL)
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE email_templates
      DROP COLUMN IF EXISTS company_id,
      DROP COLUMN IF EXISTS module
  `);
}
