export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_crm_settings_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist/.test(err.message || '')) throw err;
    }
  };

  await safe(`
    CREATE TABLE IF NOT EXISTS crm_settings (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id                  INTEGER NOT NULL UNIQUE REFERENCES companies(id),

      -- General
      default_currency            VARCHAR(10)  DEFAULT 'INR',
      deal_scoring_enabled        BOOLEAN      DEFAULT true,
      lead_lifetime_days          INTEGER      DEFAULT 90,
      auto_assign_owner           BOOLEAN      DEFAULT false,
      duplicate_detection         BOOLEAN      DEFAULT true,
      activity_reminders          BOOLEAN      DEFAULT true,

      -- Lead Config
      lead_sources                JSONB        DEFAULT '["Website","Referral","LinkedIn","Cold Call","Exhibition","Direct"]',
      lead_statuses               JSONB        DEFAULT '["New","Contacted","Qualified","Unqualified","Converted"]',
      default_lead_score          INTEGER      DEFAULT 0,
      auto_score_on_create        BOOLEAN      DEFAULT true,

      -- Pipeline & Deals
      fiscal_year_start           INTEGER      DEFAULT 4,
      deal_probability_auto_update BOOLEAN     DEFAULT true,
      show_lost_reasons           BOOLEAN      DEFAULT true,
      show_win_reasons            BOOLEAN      DEFAULT true,
      required_fields_to_close    JSONB        DEFAULT '["value","expected_close_date"]',

      -- Email & Comms
      email_tracking_enabled      BOOLEAN      DEFAULT false,
      email_open_tracking         BOOLEAN      DEFAULT false,
      email_click_tracking        BOOLEAN      DEFAULT false,
      bcc_crm_email               VARCHAR(255),

      -- Automation
      lead_assignment_method      VARCHAR(30)  DEFAULT 'manual',
      stale_lead_alert_days       INTEGER      DEFAULT 7,
      auto_close_lost_after_days  INTEGER      DEFAULT 0,

      -- Reports
      default_report_period       VARCHAR(20)  DEFAULT 'this_month',
      include_lost_in_pipeline    BOOLEAN      DEFAULT false,

      created_at                  TIMESTAMPTZ  DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  await safe(`
    INSERT INTO crm_settings (company_id)
    SELECT id FROM companies LIMIT 1
    ON CONFLICT (company_id) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS crm_settings');
}
