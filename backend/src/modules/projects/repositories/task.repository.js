import pool from '../../shared/db.js';

const taskRepository = {
  async create(data) {
    const { project_id, task_title, task_description, assigned_to, priority, status, start_date, due_date, estimated_hours, created_by } = data;
    const result = await pool.query(
      `INSERT INTO tasks (project_id, task_title, task_description, assigned_to, priority, status, start_date, due_date, estimated_hours, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [project_id, task_title, task_description, assigned_to, priority, status, start_date, due_date, estimated_hours, created_by]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT t.*, 
        e.name as assigned_to_name,
        p.project_name
      FROM tasks t
      LEFT JOIN employees e ON t.assigned_to = e.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.project_id) {
      query += ` AND t.project_id = $${paramCount}`;
      params.push(filters.project_id);
      paramCount++;
    }

    if (filters.assigned_to) {
      query += ` AND t.assigned_to = $${paramCount}`;
      params.push(filters.assigned_to);
      paramCount++;
    }

    if (filters.status) {
      query += ` AND t.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ` ORDER BY t.due_date ASC NULLS LAST, t.priority DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT t.*, 
        e.name as assigned_to_name,
        p.project_name
       FROM tasks t
       LEFT JOIN employees e ON t.assigned_to = e.id
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getKanbanBoard(project_id) {
    const result = await pool.query(
      `SELECT t.*, e.name as assigned_to_name
       FROM tasks t
       LEFT JOIN employees e ON t.assigned_to = e.id
       WHERE t.project_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.priority DESC, t.created_at ASC`,
      [project_id]
    );

    const board = {
      todo: [],
      in_progress: [],
      review: [],
      done: []
    };

    result.rows.forEach(task => {
      if (board[task.status]) {
        board[task.status].push(task);
      }
    });

    return board;
  },

  async getOverdueTasks() {
    const result = await pool.query(
      `SELECT t.*, e.name as assigned_to_name, p.project_name
       FROM tasks t
       LEFT JOIN employees e ON t.assigned_to = e.id
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.due_date < CURRENT_DATE 
         AND t.status NOT IN ('done')
         AND t.deleted_at IS NULL
       ORDER BY t.due_date ASC`
    );
    return result.rows;
  }
};

export default taskRepository;
