/**
 * Verified-live P0: POST /marketing/campaigns (marketing.routes.js:142) has
 * never inserted a value into the legacy `campaign_name` column -- it only
 * writes `name` (added by 20260611000001_marketing_tables.js). campaign_name
 * kept its original NOT NULL with no default, so every campaign creation
 * attempt 500s on a not-null violation. campaign_name is otherwise dead: the
 * only remaining references are column-alias reuses of the string
 * "campaign_name" (e.g. `mc.name AS campaign_name`), not the column itself,
 * and the one real reader (campaigns.repository.js) is itself orphaned --
 * nothing imports it. Dropping the constraint (not the column, to avoid any
 * risk to historical rows) is the minimal fix; found while wiring
 * campaignLifecycle.cron.js (Automation Opportunity Audit §4.1), which needs
 * campaigns to actually be creatable to have anything to remind about.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE marketing_campaigns ALTER COLUMN campaign_name DROP NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`UPDATE marketing_campaigns SET campaign_name = COALESCE(campaign_name, name, 'Untitled Campaign') WHERE campaign_name IS NULL`);
  await knex.raw(`ALTER TABLE marketing_campaigns ALTER COLUMN campaign_name SET NOT NULL`);
}
