// eventReactions.js — Business Event Bus (Priority 8) listener registry.
//
// Where cross-module reactions to business events actually live. Emitters
// (commissioning.routes.js, jobs/warrantyExpiry.cron.js, ...) don't import
// this file or know it exists — they just emitEvent(). server.js imports
// registerEventReactions() once at startup so listeners are attached before
// anything can fire. Keep this file the single place new reactions get
// added, so "what happens when X occurs" has one obvious home instead of
// being scattered across whichever module happened to trigger it.
import pool from '../config/db.js';
import { onEvent } from './eventBus.js';
import { activateWarranty } from '../modules/servicedesk/routes/commissioning.routes.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

const AMC_SALES_ROLES = "('admin','super_admin','superadmin','manager','sales','sales_manager')";

export function registerEventReactions() {
  // Commissioning completed -> Activate warranty (Priority 8's first example).
  // Uses the same default term the manual endpoint defaults to (12 months);
  // a human can still call POST /:id/activate-warranty afterward with a
  // different value — activateWarranty() is idempotent on
  // commissioning_workflow_id, so that just updates the same row.
  onEvent('commissioning.certificate_issued', async ({ workflowId, companyId, actorUserId }) => {
    await activateWarranty(companyId, workflowId, 12, actorUserId);
  });

  // Warranty expiring -> Notify sales (Priority 8's fifth example). The cron
  // only detects the condition and emits; this reaction owns who gets told
  // and how — that's the decoupling the event bus is for.
  onEvent('warranty.expiring', async (warranty) => {
    const { rows: receivers } = await pool.query(
      `SELECT id FROM users WHERE is_active=true AND LOWER(role) IN ${AMC_SALES_ROLES}`
    );
    for (const r of receivers) {
      const dup = await pool.query(
        `SELECT 1 FROM notifications
          WHERE user_id=$1 AND module_name='warranty' AND reference_id=$2
            AND notification_type='warranty_expiring' AND created_at::date=CURRENT_DATE
          LIMIT 1`,
        [r.id, warranty.id]
      );
      if (dup.rows.length) continue;
      await notificationsRepository.create({
        user_id: r.id,
        title: 'Warranty Expiring Soon',
        message: `${warranty.product_name || 'Product'} (${warranty.warranty_number}) for ${warranty.customer_name || 'customer'} expires on ${warranty.warranty_end} — reach out about renewal/AMC.`,
        module_name: 'warranty',
        reference_id: warranty.id,
        notification_type: 'warranty_expiring',
      });
    }
  });

  console.log('🔧 Business Event Bus reactions registered (commissioning.certificate_issued, warranty.expiring)');
}
