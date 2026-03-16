import pool from "../config/db.js";

export const addNote = async (employeeId, noteText) => {
  const query = `INSERT INTO hr_notes (employee_id, note_text) VALUES ($1, $2) RETURNING *`;
  const result = await pool.query(query, [employeeId, noteText]);
  return result.rows[0];
};

export const getNotesByEmployee = async (employeeId) => {
  const query = `SELECT * FROM hr_notes WHERE employee_id = $1 ORDER BY created_at DESC`;
  const result = await pool.query(query, [employeeId]);
  return result.rows;
};
