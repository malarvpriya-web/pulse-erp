/**
 * notification_rules gets its first consumer in this pass:
 * notifications.repository.js's create() now derives event_key as
 * `${module_name}.${notification_type}` and looks up this table to decide
 * whether to also send email (see MODULE_FEATURE_CONNECTION_MANUAL.md §26).
 * Without rows here, the six cron/event-reaction sites fixed in §25
 * (amcRenewal, overdueReminders x2, deliveryFollowup, subscriptionRenewal,
 * attendance's freeze reminder, warranty.expiring) would keep firing
 * in-app+push only, since their event_keys don't match any of the 22 rules
 * seeded by 20260623000001_notification_rules_rebuild.js.
 *
 * channel = 'in_app,email' for all eight, matching that migration's own
 * convention for finance/operational reminders. recipient_roles mirrors each
 * cron's own getReceivers() role list for admin-UI/documentation purposes
 * only -- notifications.repository.js reads channel + enabled, not
 * recipient_roles; each cron still resolves its own recipients.
 */
const NEW_RULES = [
  { event_key: 'service.amc_renewal',           title: 'AMC Renewal Due',           channel: 'in_app,email', recipient_roles: ['admin', 'super_admin', 'manager', 'service_manager'] },
  { event_key: 'service.amc_contract_renewal',  title: 'AMC Contract Renewal Due',  channel: 'in_app,email', recipient_roles: ['admin', 'super_admin', 'manager', 'service_manager'] },
  { event_key: 'finance.ar_overdue',            title: 'Receivable Overdue',        channel: 'in_app,email', recipient_roles: ['admin', 'super_admin', 'finance', 'finance_manager'] },
  { event_key: 'finance.ap_overdue',             title: 'Payable Overdue',           channel: 'in_app,email', recipient_roles: ['admin', 'super_admin', 'finance', 'finance_manager'] },
  { event_key: 'procurement.delivery_followup', title: 'PO Delivery Follow-up Due', channel: 'in_app,email', recipient_roles: ['admin', 'super_admin', 'manager', 'procurement'] },
  { event_key: 'sales.subscription_renewal',    title: 'Subscription Renewal Due',  channel: 'in_app,email', recipient_roles: ['admin', 'super_admin', 'manager', 'sales_manager', 'finance'] },
  { event_key: 'attendance.system_reminder',    title: 'Attendance Freeze Reminder', channel: 'in_app,email', recipient_roles: ['hr', 'hr_admin', 'hr_manager', 'admin'] },
  { event_key: 'warranty.warranty_expiring',    title: 'Warranty Expiring Soon',    channel: 'in_app,email', recipient_roles: ['admin', 'super_admin', 'manager', 'sales', 'sales_manager'] },
];

export async function up(knex) {
  const { rows: companies } = await knex.raw(`SELECT id FROM companies WHERE is_active = TRUE`);

  for (const company of companies) {
    const values = NEW_RULES.map((r) =>
      `(gen_random_uuid(), ${company.id}, '${r.event_key}', '${r.title}', '${r.channel}', ARRAY[${r.recipient_roles.map((x) => `'${x}'`).join(',')}], TRUE, TRUE)`
    ).join(',\n      ');

    await knex.raw(`
      INSERT INTO notification_rules
        (id, company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
      VALUES
        ${values}
      ON CONFLICT (company_id, event_key) DO NOTHING
    `);
  }
}

export async function down(knex) {
  const keys = NEW_RULES.map((r) => `'${r.event_key}'`).join(',');
  await knex.raw(`DELETE FROM notification_rules WHERE event_key IN (${keys}) AND is_system_default = TRUE`);
}
