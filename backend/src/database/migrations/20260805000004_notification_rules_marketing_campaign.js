/**
 * Adds one new notification_rules default row: 'marketing.campaign_close_out',
 * for the new campaignLifecycle.cron.js (Automation Opportunity Audit §4.1 —
 * campaigns past end_date that are still open get a daily close-out nudge).
 * Follows the same convention as 20260804000001_notification_rules_cron_events.js
 * so the cron's notifications.repository.js create() calls also reach email,
 * not just in-app+push.
 */
const NEW_RULE = {
  event_key: 'marketing.campaign_close_out',
  title: 'Campaign Needs Close-Out',
  channel: 'in_app,email',
  recipient_roles: ['admin', 'super_admin', 'manager', 'sales_manager'],
};

export async function up(knex) {
  const { rows: companies } = await knex.raw(`SELECT id FROM companies WHERE is_active = TRUE`);

  for (const company of companies) {
    await knex.raw(
      `INSERT INTO notification_rules
         (id, company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
       VALUES
         (gen_random_uuid(), ${company.id}, '${NEW_RULE.event_key}', '${NEW_RULE.title}', '${NEW_RULE.channel}',
          ARRAY[${NEW_RULE.recipient_roles.map((r) => `'${r}'`).join(',')}], TRUE, TRUE)
       ON CONFLICT (company_id, event_key) DO NOTHING`
    );
  }
}

export async function down(knex) {
  await knex.raw(
    `DELETE FROM notification_rules WHERE event_key = '${NEW_RULE.event_key}' AND is_system_default = TRUE`
  );
}
