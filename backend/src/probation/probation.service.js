import pool from "../config/db.js";

export const createNotification = async (data) => {
  const { employee_id, notified_to, notified_role } = data;
  const query = `
    INSERT INTO probation_notifications (employee_id, notified_to, notified_role)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
  const result = await pool.query(query, [employee_id, notified_to, notified_role]);
  return result.rows[0];
};

export const getNotifications = async () => {
  const query = `
    SELECT pn.*, e.first_name, e.last_name, e.office_id, e.department, e.designation, e.joining_date
    FROM probation_notifications pn
    JOIN employees e ON pn.employee_id = e.id
    ORDER BY pn.created_at DESC
  `;
  const result = await pool.query(query);
  return result.rows;
};

export const updateNotification = async (id, data) => {
  const { decision, performance_rating, comments } = data;
  const query = `
    UPDATE probation_notifications
    SET decision = $1, performance_rating = $2, comments = $3, status = 'completed', decided_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING *
  `;
  const result = await pool.query(query, [decision, performance_rating, comments, id]);
  return result.rows[0];
};
