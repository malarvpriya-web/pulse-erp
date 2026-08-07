/**
 * Adds one new notification_rules default row: 'approval.submitted'.
 *
 * Follow-up to §39 (MODULE_FEATURE_CONNECTION_MANUAL.md), which gave
 * WorkflowNotificationService.js's 'approved'/'rejected' events email coverage
 * by reusing the two originally-seeded generic 'approval.approved'/
 * 'approval.rejected' rules. This migration extends coverage to three more of
 * that pathway's nine event types:
 *
 *   'submitted' -> this new 'approval.submitted' row (submitter-facing
 *                  confirmation; no existing rule matched -- 'approval.pending'
 *                  is approver-facing by title/recipient_roles, reusing it here
 *                  would have been a semantic mismatch)
 *   'escalated' -> reuses the existing 'approval.pending' row (approver-facing
 *                  "you have a pending approval" already covers escalation)
 *   'overdue'   -> reuses the existing 'approval.pending' row, same reasoning
 *
 * 'order_confirmed'/'dispatched'/'lifecycle_advanced'/'amc_created' stay
 * unmapped -- they're module-specific (Sales/AMC/lifecycle), not generic
 * cross-module workflow events, so forcing them onto 'approval.*' would be
 * the same kind of mismatch this migration avoids for 'submitted'.
 */
const NEW_RULE = {
  event_key: 'approval.submitted',
  title: 'Request Submitted',
  channel: 'in_app,email',
  recipient_roles: ['employee'],
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
