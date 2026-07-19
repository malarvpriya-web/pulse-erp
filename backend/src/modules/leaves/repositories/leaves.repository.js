import pool from '../../shared/db.js';

function workflowError(message, code) {
  return Object.assign(new Error(message), { code });
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const leavesRepository = {
  async getLeaveTypes(company_id = null) {
    const result = await pool.query(
      `SELECT * FROM leave_types
       WHERE deleted_at IS NULL AND is_active = true
         AND (company_id IS NULL OR company_id = $1)
       ORDER BY leave_name`,
      [company_id]
    );
    return result.rows;
  },

  // Returns balance per leave type, including pending days so frontend shows accurate available balance
  async getLeaveBalance(employee_id, year) {
    const resolvedYear = year || new Date().getFullYear();
    const result = await pool.query(`
      SELECT
        lb.id, lb.employee_id, lb.leave_type_id, lb.year,
        lb.allocated_days,
        COALESCE(lb.carried_forward_days, 0)       AS carried_forward_days,
        COALESCE(lb.encashed_days, 0)              AS encashed_days,
        COALESCE(
          (SELECT SUM(la.number_of_days)
           FROM leave_applications la
           WHERE la.employee_id = lb.employee_id
             AND la.leave_type_id = lb.leave_type_id
             AND la.status = 'approved'
             AND EXTRACT(YEAR FROM la.start_date) = lb.year
             AND la.deleted_at IS NULL
          ), 0
        ) AS used_days,
        COALESCE(
          (SELECT SUM(la2.number_of_days)
           FROM leave_applications la2
           WHERE la2.employee_id = lb.employee_id
             AND la2.leave_type_id = lb.leave_type_id
             AND la2.status = 'pending'
             AND EXTRACT(YEAR FROM la2.start_date) = lb.year
             AND la2.deleted_at IS NULL
          ), 0
        ) AS pending_days,
        lt.leave_name, lt.leave_code,
        COALESCE(lt.carry_forward_allowed, false) AS carry_forward_allowed,
        COALESCE(lt.is_encashable, false)          AS is_encashable,
        COALESCE(lt.allow_half_day, true)           AS allow_half_day
      FROM leave_balances lb
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lb.employee_id = $1 AND lb.year = $2
        AND lt.is_active = true AND lt.deleted_at IS NULL
      ORDER BY lt.leave_name
    `, [employee_id, resolvedYear]);
    return result.rows.map(r => ({
      ...r,
      available_days: Math.max(
        0,
        Number(r.allocated_days) + Number(r.carried_forward_days) - Number(r.used_days) - Number(r.pending_days) - Number(r.encashed_days)
      ),
    }));
  },

  async initializeLeaveBalance(employee_id, year, company_id = null) {
    const leaveTypes = await this.getLeaveTypes(company_id);
    for (const leaveType of leaveTypes) {
      await pool.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
        [employee_id, leaveType.id, year, leaveType.annual_quota]
      );
    }
  },

  async applyLeave(data) {
    const {
      employee_id, leave_type_id, start_date, end_date, number_of_days,
      reason, attachment_url, manager_id, is_lop, clubbing_flag, half_day, half_day_session,
      lop_days,
    } = data;

    const result = await pool.query(
      `INSERT INTO leave_applications
         (employee_id, leave_type_id, start_date, end_date, number_of_days, reason,
          attachment_url, manager_id, manager_status, hr_status, l2_status,
          is_lop, clubbing_flag, half_day, half_day_session, lop_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','pending',NULL,$9,$10,$11,$12,$13)
       RETURNING *`,
      [employee_id, leave_type_id, start_date, end_date, number_of_days, reason,
       attachment_url || null, manager_id || null,
       is_lop ?? false, clubbing_flag ?? false, half_day ?? false, half_day_session || null,
       Number(lop_days) || 0]
    );
    return result.rows[0];
  },

  async findApplications(filters = {}) {
    const params = [];
    let paramCount = 1;

    let cidClause = '';
    if (filters.company_id != null) {
      cidClause = ` AND e.company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

    let query = `
      SELECT la.*,
        COALESCE(e.name, CONCAT(e.first_name, ' ', e.last_name)) AS employee_name,
        e.first_name, e.last_name, e.department, e.designation, e.office_id AS employee_code,
        lt.leave_name, lt.leave_name AS leave_type, lt.leave_code,
        la.number_of_days AS days,
        COALESCE(m.name, CONCAT(m.first_name, ' ', m.last_name)) AS manager_name,
        COALESCE(h.name, CONCAT(h.first_name, ' ', h.last_name)) AS hr_name
      FROM leave_applications la
      JOIN employees e  ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      LEFT JOIN employees m ON la.manager_id = m.id
      LEFT JOIN employees h ON la.hr_id = h.id
      WHERE la.deleted_at IS NULL
        AND e.status IS DISTINCT FROM 'Left'${cidClause}
    `;

    if (filters.employee_id) {
      query += ` AND la.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }
    if (filters.manager_id) {
      query += ` AND la.manager_id = $${paramCount}`;
      params.push(filters.manager_id);
      paramCount++;
    }
    if (filters.status) {
      query += ` AND la.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }
    if (filters.manager_status) {
      query += ` AND la.manager_status = $${paramCount}`;
      params.push(filters.manager_status);
      paramCount++;
    }
    if (filters.hr_status) {
      query += ` AND la.hr_status = $${paramCount}`;
      params.push(filters.hr_status);
      paramCount++;
    }
    if (filters.department) {
      query += ` AND e.department = $${paramCount}`;
      params.push(filters.department);
      paramCount++;
    }
    if (filters.start_date && filters.end_date) {
      query += ` AND la.start_date >= $${paramCount} AND la.end_date <= $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }
    if (filters.month) {
      query += ` AND EXTRACT(MONTH FROM la.start_date) = $${paramCount}`;
      params.push(parseInt(filters.month, 10));
      paramCount++;
    }

    const limit = Math.min(Number(filters.limit) || 500, 1000);
    query += ` ORDER BY la.applied_at DESC LIMIT ${limit}`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT la.*,
        COALESCE(e.name, CONCAT(e.first_name, ' ', e.last_name)) AS employee_name,
        e.first_name, e.last_name, e.department, e.designation,
        lt.leave_name, lt.leave_name AS leave_type,
        la.number_of_days AS days,
        COALESCE(m.name, CONCAT(m.first_name, ' ', m.last_name)) AS manager_name,
        COALESCE(h.name, CONCAT(h.first_name, ' ', h.last_name)) AS hr_name
       FROM leave_applications la
       JOIN employees e  ON la.employee_id = e.id
       JOIN leave_types lt ON la.leave_type_id = lt.id
       LEFT JOIN employees m ON la.manager_id = m.id
       LEFT JOIN employees h ON la.hr_id = h.id
       WHERE la.id = $1 AND la.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  // L1 — Manager
  async approveByManager(id, manager_id, comments) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE leave_applications
         SET manager_status = 'approved', manager_id = COALESCE(manager_id, $3),
             manager_comments = $2, manager_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND deleted_at IS NULL AND status = 'pending' AND manager_status = 'pending'
         RETURNING *`,
        [id, comments || null, manager_id]
      );
      if (!result.rows.length) throw workflowError('Leave application not found, already manager-reviewed, or no longer pending', 'LEAVE_NOT_ACTIONABLE');
      await client.query(
        `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
         VALUES ($1, $2, 1, 'approved', $3)`,
        [id, manager_id, comments || null]
      );
      return result.rows[0];
    });
  },

  async rejectByManager(id, manager_id, comments) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE leave_applications
         SET manager_status = 'rejected', status = 'rejected',
             manager_id = COALESCE(manager_id, $3),
             manager_comments = $2, manager_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND deleted_at IS NULL AND status = 'pending'
         RETURNING *`,
        [id, comments || null, manager_id]
      );
      if (!result.rows.length) throw workflowError('Leave application not found or no longer pending', 'LEAVE_NOT_ACTIONABLE');
      await client.query(
        `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
         VALUES ($1, $2, 1, 'rejected', $3)`,
        [id, manager_id, comments || null]
      );
      return result.rows[0];
    });
  },

  // L2 — Dept Head (requires L1 approved; l2_status must be explicitly pending or null+first-time)
  async approveByL2(id, l2_approver_id, comments) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE leave_applications
         SET l2_approver_id = $3, l2_status = 'approved',
             l2_comments = $2, l2_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND deleted_at IS NULL
           AND status = 'pending'
           AND manager_status = 'approved'
           AND (l2_status IS NULL OR l2_status = 'pending')
         RETURNING *`,
        [id, comments || null, l2_approver_id]
      );
      if (!result.rows.length) throw workflowError('Leave not found, L1 not yet approved, or already L2-reviewed', 'LEAVE_NOT_ACTIONABLE');
      await client.query(
        `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
         VALUES ($1, $2, 2, 'approved', $3)`,
        [id, l2_approver_id, comments || null]
      );
      return result.rows[0];
    });
  },

  async rejectByL2(id, l2_approver_id, comments) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE leave_applications
         SET l2_approver_id = $3, l2_status = 'rejected', status = 'rejected',
             l2_comments = $2, l2_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND deleted_at IS NULL AND status = 'pending' AND manager_status = 'approved'
         RETURNING *`,
        [id, comments || null, l2_approver_id]
      );
      if (!result.rows.length) throw workflowError('Leave not found or not at L2 stage', 'LEAVE_NOT_ACTIONABLE');
      await client.query(
        `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
         VALUES ($1, $2, 2, 'rejected', $3)`,
        [id, l2_approver_id, comments || null]
      );
      return result.rows[0];
    });
  },

  // L3 — HR Final (requires both L1 approved AND l2_status = 'approved' explicitly)
  async approveByHR(id, hr_id, comments) {
    return withTransaction(async (client) => {
      // Enforce l2_required: if the leave type mandates L2, HR cannot approve before L2 acts
      const { rows: preRows } = await client.query(
        `SELECT la.l2_status, lt.l2_required
         FROM leave_applications la
         JOIN leave_types lt ON lt.id = la.leave_type_id
         WHERE la.id = $1 AND la.deleted_at IS NULL`,
        [id]
      );
      if (preRows.length && preRows[0].l2_required && preRows[0].l2_status !== 'approved') {
        throw workflowError('This leave type requires L2 (Dept Head) approval before HR can finalize', 'L2_REQUIRED');
      }

      const result = await client.query(
        `UPDATE leave_applications
         SET hr_status = 'approved', status = 'approved',
             hr_comments = $2, hr_id = $3, hr_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND manager_status = 'approved'
           AND (l2_status = 'approved' OR l2_status IS NULL)
           AND status <> 'approved'
           AND deleted_at IS NULL
         RETURNING *`,
        [id, comments || null, hr_id]
      );
      if (!result.rows.length) throw workflowError('Leave not found, already finalized, or awaiting L1/L2 approval', 'LEAVE_NOT_ACTIONABLE');
      const application = result.rows[0];
      await client.query(
        `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
         VALUES ($1, $2, 3, 'approved', $3)`,
        [id, hr_id, comments || null]
      );
      await this.incrementUsedBalance(client, application);
      return application;
    });
  },

  async rejectByHR(id, hr_id, comments) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE leave_applications
         SET hr_status = 'rejected', status = 'rejected',
             hr_comments = $2, hr_id = $3, hr_approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
         RETURNING *`,
        [id, comments || null, hr_id]
      );
      if (!result.rows.length) throw workflowError('Leave application not found or no longer pending', 'LEAVE_NOT_ACTIONABLE');
      await client.query(
        `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
         VALUES ($1, $2, 3, 'rejected', $3)`,
        [id, hr_id, comments || null]
      );
      return result.rows[0];
    });
  },

  async updateStatus(id, status, actor_id, comments = '') {
    const normalized = String(status || '').toLowerCase();
    return withTransaction(async (client) => {
      const { rows: before } = await client.query(
        `SELECT * FROM leave_applications WHERE id = $1 AND deleted_at IS NULL`, [id]
      );
      if (!before.length) throw workflowError('Leave application not found', 'LEAVE_NOT_ACTIONABLE');
      const prev = before[0];
      if (prev.status === normalized) throw workflowError('Leave already has requested status', 'LEAVE_NOT_ACTIONABLE');

      const result = await client.query(
        `UPDATE leave_applications
         SET status = $1,
             hr_status     = CASE WHEN $1 IN ('approved','rejected') THEN $1 ELSE hr_status END,
             l2_status     = CASE WHEN $1 IN ('approved','rejected') THEN $1 ELSE l2_status END,
             manager_status = CASE WHEN $1 IN ('approved','rejected') AND manager_status = 'pending' THEN $1 ELSE manager_status END,
             hr_id         = COALESCE(hr_id, $3),
             hr_comments   = COALESCE($4, hr_comments),
             hr_approved_at = CASE WHEN $1 IN ('approved','rejected') THEN CURRENT_TIMESTAMP ELSE hr_approved_at END,
             updated_at    = CURRENT_TIMESTAMP
         WHERE id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [normalized, id, actor_id, comments || null]
      );

      const application = result.rows[0];
      const level = normalized === 'cancelled' ? 0 : 3;
      await client.query(
        `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, actor_id, level, normalized, comments || null]
      );

      if (normalized === 'approved' && prev.status !== 'approved') {
        await this.incrementUsedBalance(client, application);
      } else if (normalized === 'cancelled' && prev.status === 'approved') {
        await this.decrementUsedBalance(client, application);
      }

      return application;
    });
  },

  async incrementUsedBalance(client, application) {
    const year = new Date(application.start_date).getFullYear();
    const { rows: [lt] } = await client.query(
      `SELECT annual_quota, is_comp_off_type FROM leave_types WHERE id = $1 LIMIT 1`, [application.leave_type_id]
    ).catch(() => ({ rows: [] }));
    const allocatedDays = lt?.annual_quota ?? 0;

    await client.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (employee_id, leave_type_id, year)
       DO UPDATE SET used_days = COALESCE(leave_balances.used_days, 0) + EXCLUDED.used_days,
                     updated_at = CURRENT_TIMESTAMP`,
      [application.employee_id, application.leave_type_id, year, allocatedDays, application.number_of_days || 0]
    );

    // Mark oldest comp-off records as 'used' (FIFO) when a comp-off leave type is consumed
    if (lt?.is_comp_off_type) {
      const daysToConsume = Math.ceil(Number(application.number_of_days) || 1);
      const { rows: available } = await client.query(
        `SELECT id FROM compensatory_off
         WHERE employee_id = $1 AND status = 'approved' AND credited = true
           AND expires_on >= CURRENT_DATE
         ORDER BY work_date ASC
         LIMIT $2`,
        [application.employee_id, daysToConsume]
      ).catch(() => ({ rows: [] }));
      if (available.length) {
        await client.query(
          `UPDATE compensatory_off SET status = 'used', updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1::int[])`,
          [available.map(r => r.id)]
        ).catch(() => {});
      }
    }
  },

  async decrementUsedBalance(client, application) {
    const year = new Date(application.start_date).getFullYear();
    await client.query(
      `UPDATE leave_balances
       SET used_days = GREATEST(COALESCE(used_days, 0) - $1, 0), updated_at = CURRENT_TIMESTAMP
       WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4`,
      [application.number_of_days || 0, application.employee_id, application.leave_type_id, year]
    );
  },

  async getLeaveCalendar(filters = {}) {
    const params = [];
    let paramCount = 1;

    let cidClause = '';
    if (filters.company_id != null) {
      cidClause = ` AND e.company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

    let query = `
      SELECT la.*,
        COALESCE(e.name, CONCAT(e.first_name, ' ', e.last_name)) AS employee_name,
        e.department,
        lt.leave_name, lt.leave_name AS leave_type
      FROM leave_applications la
      JOIN employees e  ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.status = 'approved' AND la.deleted_at IS NULL${cidClause}
    `;

    if (filters.start_date && filters.end_date) {
      query += ` AND la.start_date <= $${paramCount + 1} AND la.end_date >= $${paramCount}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }
    if (filters.employee_id) {
      query += ` AND la.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }
    if (filters.department) {
      query += ` AND e.department = $${paramCount}`;
      params.push(filters.department);
      paramCount++;
    }

    query += ` ORDER BY la.start_date`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async getLeaveAnalytics(filters = {}) {
    const params = [];
    let paramCount = 1;

    let cidJoin   = '';
    let cidClause = '';
    if (filters.company_id != null) {
      cidJoin   = `JOIN employees e ON la.employee_id = e.id`;
      cidClause = ` AND e.company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

    let query = `
      SELECT
        lt.leave_name,
        COUNT(la.id)                                                AS application_count,
        SUM(la.number_of_days)                                      AS total_days,
        COUNT(*) FILTER (WHERE la.status = 'approved')              AS approved_count,
        COUNT(*) FILTER (WHERE la.status = 'rejected')              AS rejected_count,
        COUNT(*) FILTER (WHERE la.status = 'pending')               AS pending_count,
        ROUND(AVG(la.number_of_days) FILTER (WHERE la.status = 'approved'), 1) AS avg_days
      FROM leave_applications la
      ${cidJoin}
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.deleted_at IS NULL${cidClause}
    `;

    if (filters.start_date && filters.end_date) {
      query += ` AND la.start_date >= $${paramCount} AND la.end_date <= $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
    }

    query += ` GROUP BY lt.leave_name ORDER BY total_days DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },
};

export default leavesRepository;
