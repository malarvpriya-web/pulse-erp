import pool from '../../../config/db.js';
import { sendPushToUser, isPushConfigured } from '../services/pushSender.js';
import { sendNotificationEmail, isEmailConfigured } from '../../../utils/mailer.js';

// notification_rules (migrations/20260623000001_notification_rules_rebuild.js)
// declares a per-event `channel` CSV keyed by `event_key`, scoped by company —
// this is the only place anything reads it. event_key defaults to
// `${module_name}.${notification_type}` so every existing and future create()
// call is covered without per-call-site wiring, but a caller may pass an
// explicit `event_key` instead when its stored module_name/notification_type
// aren't themselves a meaningful key (e.g. WorkflowNotificationService.js's
// module_name is a human-readable label like 'Purchase Request', and its
// notification_type is a UI badge class like 'success' — neither is safe to
// change since both are already relied on elsewhere: module_name for existing
// notifications.findByUser filters, notification_type for the frontend's
// icon/colour mapping in NotificationDropdown.jsx / Topbar.jsx). A call whose
// resolved event_key has no enabled rule row just no-ops here, same as before
// this existed.
/**
 * `companyId` is a HINT from the caller. The authoritative tenant is the
 * RECIPIENT's own company — a notification email goes out over the mail server of
 * the company the person belongs to — so it is read from the users row below and
 * the hint is only a fallback for a user row that carries no company.
 */
async function dispatchRuleChannels(userId, eventKey, title, message, companyId = null) {
  const { rows } = await pool.query(
    `SELECT nr.channel
     FROM notification_rules nr
     JOIN users u ON u.company_id = nr.company_id
     WHERE u.id = $1 AND nr.event_key = $2 AND nr.enabled = true
     LIMIT 1`,
    [userId, eventKey]
  );
  const channels = (rows[0]?.channel || '').split(',').map((c) => c.trim());
  if (!channels.includes('email')) return;

  const { rows: userRows } = await pool.query(`SELECT email, company_id FROM users WHERE id = $1`, [userId]);
  const toEmail = userRows[0]?.email;
  if (!toEmail) return;

  await sendNotificationEmail(toEmail, {
    title, message, companyId: userRows[0]?.company_id ?? companyId,
  });
}

/**
 * Is the RECIPIENT of notification `n` a member of company `p` (a SQL
 * placeholder such as '$2')?
 *
 * A login belongs to a company by any of the three links the rest of the
 * application already trusts:
 *   - users.company_id                      (directly provisioned logins)
 *   - the linked employee's company_id      (employee logins; the same rule
 *                                            every tenant-scoped cron uses to
 *                                            pick recipients)
 *   - a user_scope row for that company     (what verifyToken builds
 *                                            req.scope from)
 *
 * This used to test `users.company_id` alone. Company 1's HR logins carry
 * users.company_id NULL — their company comes from user_scope and their
 * employee record — so the bell and the unread badge showed them 0 of the 21,
 * 21 and 16 notifications they had actually been sent, including every
 * probation reminder.
 *
 * The company is always the caller's own resolved scope (companyOf), never a
 * client-supplied value, and the recipient check (n.user_id = the caller) is
 * applied separately — this predicate only narrows, it never widens.
 */
const RECIPIENT_IN_COMPANY = (p) => `EXISTS (
        SELECT 1
          FROM users ru
          LEFT JOIN employees re ON re.id = ru.employee_id
         WHERE ru.id = n.user_id
           AND (ru.company_id = ${p}::int
                OR re.company_id = ${p}::int
                OR EXISTS (SELECT 1 FROM user_scope rs
                            WHERE rs.user_id = ru.id AND rs.company_id = ${p}::int))
      )`;

const notificationsRepository = {
  async create(data) {
    const { user_id, title, message, module_name, reference_id, notification_type } = data;
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user_id, title, message, module_name, reference_id, notification_type]
    );
    await this.dispatchSideEffects(data);
    return result.rows[0];
  },

  /**
   * The channels that follow an in-app notification row: mobile push, and the
   * email a notification_rules row may ask for. Split out of create() so a
   * caller that writes notification rows inside its OWN transaction (the
   * probation reminder job, whose dedup ledger and notifications must commit
   * together) can fire these only after it commits — never for a row that was
   * rolled back. create() itself behaves exactly as before.
   */
  async dispatchSideEffects(data) {
    const { user_id, title, message, module_name, reference_id, notification_type, event_key, company_id = null } = data;
    // Mirror the in-app notification to the user's mobile devices. Fire-and-forget
    // and fully guarded — a push failure must never affect the notification write.
    if (isPushConfigured() && user_id != null) {
      sendPushToUser(user_id, {
        title: title || 'Pulse',
        body: message || '',
        data: { module: module_name, ref: reference_id, type: notification_type },
      }).catch(() => {});
    }
    const resolvedEventKey = event_key || (module_name && notification_type ? `${module_name}.${notification_type}` : null);
    // await: see mailer.isEmailConfigured — un-awaited it is a truthy Promise.
    if ((await isEmailConfigured(company_id)) && user_id != null && resolvedEventKey) {
      dispatchRuleChannels(user_id, resolvedEventKey, title, message, company_id).catch(() => {});
    }
  },

  async findByUser(user_id, company_id = null, filters = {}) {
    let query = `
      SELECT n.* FROM notifications n
      WHERE n.user_id = $1 AND n.deleted_at IS NULL
    `;
    const params = [user_id];
    let paramCount = 2;

    // Recipient isolation is n.user_id above: a caller only ever sees rows
    // addressed to them. With a company context, the recipient must also
    // belong to that company (see RECIPIENT_IN_COMPANY). With none (a
    // legitimate company-less login) it is still only their own rows — never
    // a wider set.
    if (company_id != null) {
      query += ` AND ${RECIPIENT_IN_COMPANY(`$${paramCount}`)}`;
      params.push(company_id);
      paramCount++;
    }

    if (filters.is_read !== undefined) {
      query += ` AND n.is_read = $${paramCount}`;
      params.push(filters.is_read);
      paramCount++;
    }

    if (filters.module_name) {
      query += ` AND n.module_name = $${paramCount}`;
      params.push(filters.module_name);
      paramCount++;
    }

    const limit = Math.min(parseInt(filters.limit) || 50, 100);
    query += ` ORDER BY n.created_at DESC LIMIT ${limit}`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async markAsRead(id, user_id) {
    const result = await pool.query(
      `UPDATE notifications SET is_read = true, read_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, user_id]
    );
    return result.rows[0];
  },

  async markAllAsRead(user_id) {
    await pool.query(
      `UPDATE notifications SET is_read = true, read_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND is_read = false`,
      [user_id]
    );
  },

  /** Same recipient + company rule as findByUser, so the badge and the list agree. */
  async getUnreadCount(user_id, company_id = null) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM notifications n
        WHERE n.user_id = $1 AND n.is_read = false AND n.deleted_at IS NULL
          ${company_id != null ? `AND ${RECIPIENT_IN_COMPANY('$2')}` : ''}`,
      company_id != null ? [user_id, company_id] : [user_id]
    );
    return result.rows[0].count;
  },

  async delete(id, user_id) {
    await pool.query(
      `UPDATE notifications SET deleted_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2`,
      [id, user_id]
    );
  },

  // Helper to create common notifications
  async notifyApprovalPending(user_id, module_name, reference_id, title) {
    return this.create({
      user_id,
      title,
      message: `You have a pending approval in ${module_name}`,
      module_name,
      reference_id,
      notification_type: 'approval'
    });
  },

  async notifyTaskAssigned(user_id, task_title, task_id) {
    return this.create({
      user_id,
      title: 'New Task Assigned',
      message: `You have been assigned to: ${task_title}`,
      module_name: 'projects',
      reference_id: task_id,
      notification_type: 'info'
    });
  }
};

export default notificationsRepository;
