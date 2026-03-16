import pool from "../config/db.js";

export const addAnnouncement = async (title, message, fromDate, toDate, targetType, targetValue, isActive) => {
  const query = `INSERT INTO announcements (title, message, from_date, to_date, target_type, target_value, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
  const result = await pool.query(query, [title, message, fromDate, toDate, targetType, targetValue, isActive]);
  return result.rows[0];
};

export const getAnnouncements = async () => {
  const query = `SELECT * FROM announcements ORDER BY created_at DESC`;
  const result = await pool.query(query);
  return result.rows;
};

export const getActiveAnnouncements = async () => {
  const query = `SELECT * FROM announcements WHERE is_active = true AND from_date::date <= CURRENT_DATE AND to_date::date >= CURRENT_DATE ORDER BY created_at DESC`;
  const result = await pool.query(query);
  return result.rows;
};

export const updateAnnouncement = async (id, title, message, fromDate, toDate, targetType, targetValue, isActive) => {
  const query = `UPDATE announcements SET title = $1, message = $2, from_date = $3, to_date = $4, target_type = $5, target_value = $6, is_active = $7 WHERE id = $8 RETURNING *`;
  const result = await pool.query(query, [title, message, fromDate, toDate, targetType, targetValue, isActive, id]);
  return result.rows[0];
};

export const toggleAnnouncementStatus = async (id, isActive) => {
  const query = `UPDATE announcements SET is_active = $1 WHERE id = $2 RETURNING *`;
  const result = await pool.query(query, [isActive, id]);
  return result.rows[0];
};

export const deleteAnnouncement = async (id) => {
  await pool.query(`DELETE FROM announcements WHERE id = $1`, [id]);
};

export const deleteExpiredAnnouncements = async () => {
  await pool.query(`DELETE FROM announcements WHERE to_date::date < CURRENT_DATE`);
};
