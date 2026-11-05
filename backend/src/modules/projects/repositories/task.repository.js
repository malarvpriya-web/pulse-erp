import pool from '../../shared/db.js';
import { pickUpdatable } from '../../../shared/safeUpdate.js';

const taskRepository = {
  async create(data) {
    const {
      project_id, task_title, task_description, assigned_to, assignment_type,
      priority, status, start_date, due_date, estimated_hours, created_by,
      // Gantt-only fields (all optional — Task List's "Add Task" form never sends
      // these, so it keeps getting the same column defaults it always has).
      end_date, progress, dependencies, is_milestone, color, wbs_number,
      task_type, parent_task_id, schedule_status,
    } = data;
    const result = await pool.query(
      `INSERT INTO tasks (project_id, task_title, task_description, assigned_to, assignment_type,
         priority, status, start_date, due_date, estimated_hours, created_by,
         end_date, progress, dependencies, is_milestone, color, wbs_number,
         task_type, parent_task_id, schedule_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        project_id    || null,
        task_title,
        task_description || null,
        assigned_to   || null,
        assignment_type || 'all_employees',
        priority      || 'medium',
        status        || 'todo',
        start_date    || null,
        due_date      || null,
        estimated_hours ? parseFloat(estimated_hours) : null,
        created_by    || null,
        end_date      || null,
        progress ?? 0,
        dependencies || [],
        is_milestone ?? false,
        color || null,
        wbs_number || null,
        task_type || 'task',
        parent_task_id || null,
        schedule_status || 'on_track',
      ]
    );
    return result.rows[0];
  },

  async findAll(filters = {}, viewer = {}) {
    const cid = filters.company_id ?? null;
    let query = `
      SELECT t.*,
        CONCAT(e.first_name, ' ', e.last_name) as assigned_to_name,
        p.project_name
      FROM tasks t
      LEFT JOIN employees e ON t.assigned_to = e.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.deleted_at IS NULL
        AND ($1::int IS NULL OR p.company_id = $1)
    `;
    const params = [cid];
    let paramCount = 2;

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

    if (filters.due_date) {
      query += ` AND t.due_date = $${paramCount}`;
      params.push(filters.due_date);
      paramCount++;
    }

    if (filters.status) {
      query += ` AND t.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    // Visibility filter based on assignment_type
    // NULL assignment_type treated as 'all_employees' to surface legacy tasks
    const { role, id: userId } = viewer;
    const isManager = role === 'manager' || role === 'department_head' || role === 'admin' || role === 'super_admin';
    if (userId && !isManager) {
      query += ` AND (t.assignment_type IS NULL OR t.assignment_type = 'all_employees' OR (t.assignment_type = 'individual' AND t.assigned_to = $${paramCount}))`;
      params.push(userId);
      paramCount++;
    } else if (userId && isManager) {
      query += ` AND (t.assignment_type IS NULL OR t.assignment_type IN ('all_employees', 'managers') OR (t.assignment_type = 'individual' AND t.assigned_to = $${paramCount}))`;
      params.push(userId);
      paramCount++;
    }

    query += ` ORDER BY t.due_date ASC NULLS LAST, t.priority DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  /**
   * `tasks` has no company_id of its own — a task's tenant is its project's.
   * Every read/write below therefore scopes through `projects.company_id`, the
   * same predicate findAll() and getKanbanBoard() already use. Callers MUST
   * pass the caller's company (companyOf(req)); the null default is a genuinely
   * global super-admin scope, not "unknown".
   *
   * A task with no project_id is invisible to a scoped caller here, exactly as
   * it already is in findAll() — deliberately consistent rather than quietly
   * more permissive on the single-record path.
   */
  async findById(id, company_id = null) {
    const result = await pool.query(
      `SELECT t.*, 
        CONCAT(e.first_name, ' ', e.last_name) as assigned_to_name,
        p.project_name
       FROM tasks t
       LEFT JOIN employees e ON t.assigned_to = e.id
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.id = $1 AND t.deleted_at IS NULL
         AND ($2::int IS NULL OR p.company_id = $2)`,
      [id, company_id ?? null]
    );
    return result.rows[0];
  },

  async update(id, data, company_id = null) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    // The route calls update(req.params.id, req.body), and `key` is interpolated
    // into the SET clause below rather than bound — so unfiltered it allows both
    // mass assignment (company_id, created_by, deleted_at) and injection of extra
    // assignments. pickUpdatable validates every key against the live `tasks`
    // columns minus the protected set.
    const safe = await pickUpdatable('tasks', data);

    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });

    // Every key was rejected — don't emit `SET updated_at=…` alone, which would
    // report success for a write that changed nothing.
    if (!fields.length) return this.findById(id, company_id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    values.push(company_id ?? null);
    const idParam = paramCount;
    const cidParam = paramCount + 1;

    // Scoped by project ownership, not just id — the route used to pass a raw
    // path param straight through, so any authenticated user with projects.edit
    // could update ANY tenant's task by guessing its id.
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')}
        WHERE id = $${idParam} AND deleted_at IS NULL
          AND ($${cidParam}::int IS NULL OR EXISTS (
                SELECT 1 FROM projects p
                 WHERE p.id = tasks.project_id AND p.company_id = $${cidParam}))
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  /** Returns true when a row was actually soft-deleted, false when the id is
   *  absent, already deleted, or belongs to another tenant — the route needs to
   *  tell those apart to answer 404 instead of a false "deleted". */
  async delete(id, company_id = null) {
    const result = await pool.query(
      `UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::int IS NULL OR EXISTS (
                SELECT 1 FROM projects p
                 WHERE p.id = tasks.project_id AND p.company_id = $2))
        RETURNING id`,
      [id, company_id ?? null]
    );
    return result.rowCount > 0;
  },

  async getKanbanBoard(project_id, company_id = null) {
    const cid = company_id ?? null;
    const result = await pool.query(
      `SELECT t.*, CONCAT(e.first_name, ' ', e.last_name) as assigned_to_name
       FROM tasks t
       LEFT JOIN employees e ON t.assigned_to = e.id
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.project_id = $1 AND t.deleted_at IS NULL
         AND ($2::int IS NULL OR p.company_id = $2)
       ORDER BY t.priority DESC, t.created_at ASC`,
      [project_id, cid]
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

  async getOverdueTasks(company_id = null) {
    const cid = company_id ?? null;
    const result = await pool.query(
      `SELECT t.*, CONCAT(e.first_name, ' ', e.last_name) as assigned_to_name, p.project_name
       FROM tasks t
       LEFT JOIN employees e ON t.assigned_to = e.id
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.due_date < CURRENT_DATE
         AND t.status NOT IN ('done')
         AND t.deleted_at IS NULL
         AND ($1::int IS NULL OR p.company_id = $1)
       ORDER BY t.due_date ASC`,
      [cid]
    );
    return result.rows;
  },

  async getTodayTasks(company_id = null) {
    const cid = company_id ?? null;
    const result = await pool.query(
      `SELECT t.*, CONCAT(e.first_name, ' ', e.last_name) as assigned_to_name, p.project_name
       FROM tasks t
       LEFT JOIN employees e ON t.assigned_to = e.id
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.due_date = CURRENT_DATE
         AND t.deleted_at IS NULL
         AND ($1::int IS NULL OR p.company_id = $1)
       ORDER BY t.priority DESC, t.created_at ASC`,
      [cid]
    );
    return result.rows;
  }
};

export default taskRepository;
