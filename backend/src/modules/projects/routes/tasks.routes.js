import express from 'express';
import pool from '../../shared/db.js';
import taskRepository from '../repositories/task.repository.js';

const router = express.Router();

router.get('/today', async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const tasks = await taskRepository.getTodayTasks(companyId);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Returns tasks visible to the authenticated user (used by the home-page widget)
router.get('/my-tasks', async (req, res) => {
  try {
    const authEmail = req.user?.email;
    const companyId = req.scope?.company_id ?? null;
    const { status, limit = 10 } = req.query;

    let empId = null;
    if (authEmail) {
      const empRow = await pool.query(
        'SELECT id FROM employees WHERE company_email = $1 LIMIT 1',
        [authEmail]
      );
      if (empRow.rows.length > 0) empId = empRow.rows[0].id;
    }

    const params = [companyId];
    let paramCount = 2;
    let where = `t.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1)`;

    if (status === 'open') {
      where += ` AND t.status != 'done'`;
    } else if (status) {
      where += ` AND t.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (empId) {
      where += ` AND (t.assignment_type IS NULL OR t.assignment_type = 'all_employees'
                   OR (t.assignment_type = 'individual' AND t.assigned_to = $${paramCount}))`;
      params.push(empId);
      paramCount++;
    }

    params.push(parseInt(limit, 10) || 10);

    const result = await pool.query(
      `SELECT t.*, CONCAT(e.first_name, ' ', e.last_name) AS assigned_to_name, p.project_name
         FROM tasks t
         LEFT JOIN employees e ON t.assigned_to = e.id
         LEFT JOIN projects  p ON t.project_id  = p.id
        WHERE ${where}
        ORDER BY t.due_date ASC NULLS LAST, t.priority DESC
        LIMIT $${paramCount}`,
      params
    );

    res.json({ tasks: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
