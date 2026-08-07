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
async function dispatchRuleChannels(userId, eventKey, title, message) {
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

  const { rows: userRows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
  const toEmail = userRows[0]?.email;
  if (!toEmail) return;

  await sendNotificationEmail(toEmail, { title, message });
}

const notificationsRepository = {
  async create(data) {
    const { user_id, title, message, module_name, reference_id, notification_type, event_key } = data;
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user_id, title, message, module_name, reference_id, notification_type]
    );
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
    if (isEmailConfigured() && user_id != null && resolvedEventKey) {
      dispatchRuleChannels(user_id, resolvedEventKey, title, message).catch(() => {});
    }
    return result.rows[0];
  },

  async findByUser(user_id, company_id = null, filters = {}) {
    let query = `
      SELECT n.* FROM notifications n
      JOIN users u ON n.user_id = u.id
      WHERE n.user_id = $1 AND n.deleted_at IS NULL
    `;
    const params = [user_id];
    let paramCount = 2;

    if (company_id != null) {
      query += ` AND u.company_id = $${paramCount}`;
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

  async getUnreadCount(user_id, company_id = null) {
    if (company_id != null) {
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM notifications n
         JOIN users u ON n.user_id = u.id
         WHERE n.user_id = $1 AND u.company_id = $2
           AND n.is_read = false AND n.deleted_at IS NULL`,
        [user_id, company_id]
      );
      return parseInt(result.rows[0].count);
    }
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM notifications
       WHERE user_id = $1 AND is_read = false AND deleted_at IS NULL`,
      [user_id]
    );
    return parseInt(result.rows[0].count);
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
