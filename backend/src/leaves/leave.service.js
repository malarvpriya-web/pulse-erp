import pool from "../config/db.js";

export const createLeave = async (employeeId, leaveData) => {
  const { leave_type, start_date, end_date, days, reason } = leaveData;
  
  const result = await pool.query(
    `INSERT INTO leaves (employee_id, leave_type, start_date, end_date, days, reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING *`,
    [employeeId, leave_type, start_date, end_date, days, reason]
  );
  
  return result.rows[0];
};

export const getMyLeaves = async (employeeId) => {
  const result = await pool.query(
    `SELECT l.*, e.first_name, e.last_name, e.department, e.designation
     FROM leaves l
     JOIN employees e ON l.employee_id = e.id
     WHERE l.employee_id = $1
     ORDER BY l.created_at DESC`,
    [employeeId]
  );
  
  return result.rows;
};

export const getTeamLeaves = async (managerId) => {
  const result = await pool.query(
    `SELECT l.*, e.first_name, e.last_name, e.department, e.designation, e.reporting_manager
     FROM leaves l
     JOIN employees e ON l.employee_id = e.id
     WHERE e.reporting_manager = (SELECT CONCAT(first_name, ' ', last_name) FROM employees WHERE id = $1)
     ORDER BY l.created_at DESC`,
    [managerId]
  );
  
  return result.rows;
};

export const getAllLeaves = async () => {
  const result = await pool.query(
    `SELECT l.*, e.first_name, e.last_name, e.department, e.designation
     FROM leaves l
     JOIN employees e ON l.employee_id = e.id
     ORDER BY l.created_at DESC`
  );
  
  return result.rows;
};

export const approveLeave = async (leaveId, managerComment) => {
  const result = await pool.query(
    `UPDATE leaves 
     SET status = 'approved', manager_comment = $2
     WHERE id = $1
     RETURNING *`,
    [leaveId, managerComment]
  );
  
  return result.rows[0];
};

export const rejectLeave = async (leaveId, managerComment) => {
  const result = await pool.query(
    `UPDATE leaves 
     SET status = 'rejected', manager_comment = $2
     WHERE id = $1
     RETURNING *`,
    [leaveId, managerComment]
  );
  
  return result.rows[0];
};

export const getLeaveById = async (leaveId) => {
  const result = await pool.query(
    `SELECT l.*, e.first_name, e.last_name, e.department, e.designation
     FROM leaves l
     JOIN employees e ON l.employee_id = e.id
     WHERE l.id = $1`,
    [leaveId]
  );
  
  return result.rows[0];
};
