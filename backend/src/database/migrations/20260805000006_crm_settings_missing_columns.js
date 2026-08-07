/**
 * 20260805000006_crm_settings_missing_columns.js
 *
 * CRMSettings.jsx and PUT /crm/settings (crm.routes.js) both assume a ~25-column
 * crm_settings shape. The live table only ever had 12 of them. Every save from the
 * Settings page — any tab, not just Automation — has been throwing
 * "column ... does not exist" and 500ing, silently swallowed by the frontend as a
 * failed save. Discovered while wiring up §2.1 (lead/opportunity auto-assignment),
 * whose auto_assign_owner / lead_assignment_method toggle can't persist without
 * this fix either.
 *
 * A few of the route's expected names collide in spirit but not in name with
 * existing columns (lead_scoring_enabled vs. deal_scoring_enabled,
 * fiscal_year_start_month vs. fiscal_year_start, duplicate_detection_leads/
 * contacts/accounts vs. duplicate_detection) — those old columns are left alone
 * rather than renamed/reused: fiscal_year_start_month in particular is still read
 * live by pursuits.routes.js and crm.routes.js's own FY-revenue query, so
 * repointing it could silently change real reporting math. This migration is
 * purely additive.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE crm_settings
      ADD COLUMN IF NOT EXISTS deal_scoring_enabled         BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS lead_lifetime_days            INTEGER DEFAULT 90,
      ADD COLUMN IF NOT EXISTS auto_assign_owner             BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS duplicate_detection           BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS activity_reminders            BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS lead_sources                  TEXT[] DEFAULT ARRAY['Website','Referral','LinkedIn','Cold Call','Exhibition','Direct'],
      ADD COLUMN IF NOT EXISTS lead_statuses                 TEXT[] DEFAULT ARRAY['New','Contacted','Qualified','Unqualified','Converted'],
      ADD COLUMN IF NOT EXISTS default_lead_score            INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS auto_score_on_create          BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS fiscal_year_start             INTEGER DEFAULT 4,
      ADD COLUMN IF NOT EXISTS show_lost_reasons             BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS show_win_reasons              BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS required_fields_to_close      TEXT[] DEFAULT ARRAY['value','expected_close_date'],
      ADD COLUMN IF NOT EXISTS email_tracking_enabled        BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS email_click_tracking          BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS bcc_crm_email                 VARCHAR(255) DEFAULT '',
      ADD COLUMN IF NOT EXISTS lead_assignment_method        VARCHAR(20) DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS stale_lead_alert_days         INTEGER DEFAULT 7,
      ADD COLUMN IF NOT EXISTS auto_close_lost_after_days    INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS default_report_period         VARCHAR(20) DEFAULT 'this_month',
      ADD COLUMN IF NOT EXISTS include_lost_in_pipeline      BOOLEAN DEFAULT false
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE crm_settings
      DROP COLUMN IF EXISTS deal_scoring_enabled,
      DROP COLUMN IF EXISTS lead_lifetime_days,
      DROP COLUMN IF EXISTS auto_assign_owner,
      DROP COLUMN IF EXISTS duplicate_detection,
      DROP COLUMN IF EXISTS activity_reminders,
      DROP COLUMN IF EXISTS lead_sources,
      DROP COLUMN IF EXISTS lead_statuses,
      DROP COLUMN IF EXISTS default_lead_score,
      DROP COLUMN IF EXISTS auto_score_on_create,
      DROP COLUMN IF EXISTS fiscal_year_start,
      DROP COLUMN IF EXISTS show_lost_reasons,
      DROP COLUMN IF EXISTS show_win_reasons,
      DROP COLUMN IF EXISTS required_fields_to_close,
      DROP COLUMN IF EXISTS email_tracking_enabled,
      DROP COLUMN IF EXISTS email_click_tracking,
      DROP COLUMN IF EXISTS bcc_crm_email,
      DROP COLUMN IF EXISTS lead_assignment_method,
      DROP COLUMN IF EXISTS stale_lead_alert_days,
      DROP COLUMN IF EXISTS auto_close_lost_after_days,
      DROP COLUMN IF EXISTS default_report_period,
      DROP COLUMN IF EXISTS include_lost_in_pipeline
  `);
}
