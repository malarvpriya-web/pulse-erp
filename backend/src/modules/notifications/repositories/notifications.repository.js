import pool from '../../shared/db.js';

const notificationsRepository = {
  async create(data) {
    const { user_id, title, message, module_name, reference_id, notification_type } = data;
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user_id, title, message, module_name, reference_id, notification_type]
    );
    return result.rows[0];
  },

  async findByUser(user_id, filters = {}) {
    let query = `
      SELECT * FROM notifications
      WHERE user_id = $1 AND deleted_at IS NULL
    `;
    const params = [user_id];
    let paramCount = 2;

    if (filters.is_read !== undefined) {
      query += ` AND is_read = $${paramCount}`;
      params.push(filters.is_read);
      paramCount++;
    }

    if (filters.module_name) {
      query += ` AND module_name = $${paramCount}`;
      params.push(filters.module_name);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;

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

  async getUnreadCount(user_id) {
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
