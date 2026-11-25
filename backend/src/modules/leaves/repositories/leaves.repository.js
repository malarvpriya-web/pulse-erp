import pool from '../../shared/db.js';
import { openingAllocation } from '../services/leaveAccrual.service.js';
import { isExitedSql } from '../../../shared/employeeStatus.js';

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

/**
 * Leave Calendar visibility as SQL on `employees e` (2026-11-25). `scope`
 * comes from calendarScopeOf() in leaves.routes.js:
 *   null → no restriction (leave admins: the whole company)
 *   { kind: 'self' | 'manager' | 'department', me }
 * Pushes its one parameter onto `params` and returns " AND (...)" or "".
 */
export function scopeClause(scope, params) {
  if (!scope || !scope.kind) return '';
  params.push(scope.me ?? -1);
  const me = `$${params.length}`;
  if (scope.kind === 'manager') return ` AND (e.id = ${me} OR e.reporting_manager_id = ${me})`;
  if (scope.kind === 'department') {
    return ` AND (e.id = ${me} OR e.reporting_manager_id = ${me}
              OR e.department = (SELECT department FROM employees WHERE id = ${me} AND department IS NOT NULL))`;
  }
  return ` AND e.id = ${me}`;   // 'self', and anything unknown
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
        COALESCE(lt.allow_half_day, true)           AS allow_half_day,
        COALESCE(lt.is_lop_type, false)             AS is_lop_type
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
    const { rows: [emp] } = await pool.query(
      `SELECT to_char(joining_date, 'YYYY-MM-DD') AS joining_date FROM employees WHERE id = $1`, [employee_id]);
    for (const leaveType of leaveTypes) {
      await pool.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
        [employee_id, leaveType.id, year, openingAllocation(leaveType, emp?.joining_date, Number(year))]
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
      // company_id is derived from the employee rather than left to the caller.
      // It was not set at all before, so every new application landed with a NULL
      // tenant — and the company-scoped dashboard counts (`company_id = $1`) match
      // NULL against nothing, so a freshly applied leave was invisible to every
      // approval queue that scopes by company. Nullable rows also slip past the
      // composite unique indexes that lead with company_id.
      `INSERT INTO leave_applications
         (employee_id, leave_type_id, start_date, end_date, number_of_days, reason,
          attachment_url, manager_id, manager_status, hr_status, l2_status,
          is_lop, clubbing_flag, half_day, half_day_session, lop_days, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','pending',NULL,$9,$10,$11,$12,$13,
          (SELECT company_id FROM employees WHERE id = $1))
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
        COALESCE(lt.l2_required, false) AS l2_required,
        la.number_of_days AS days,
        COALESCE(m.name, CONCAT(m.first_name, ' ', m.last_name)) AS manager_name,
        COALESCE(h.name, CONCAT(h.first_name, ' ', h.last_name)) AS hr_name,
        COALESCE(l2.name, CONCAT(l2.first_name, ' ', l2.last_name)) AS l2_name,
        NULLIF(TRIM(COALESCE(dl.name, CONCAT(dl.first_name, ' ', dl.last_name))), '') AS delegate_name,
        -- When the request reached the step it waits at ("waiting N days").
        CASE WHEN la.status <> 'pending' THEN NULL
             WHEN la.manager_status = 'pending' THEN la.applied_at
             ELSE COALESCE(la.l2_approved_at, la.manager_approved_at, la.applied_at) END AS step_since,
        -- Days of this (full-day) leave the person punched in on (2026-11-24).
        -- Attendance keeps the punch, so payroll pays the day as worked, but
        -- the leave still uses balance: HR sees it and cancels or corrects.
        CASE WHEN la.half_day THEN 0 ELSE (
          SELECT COUNT(*)::int FROM attendance_records ar
           WHERE ar.employee_id = la.employee_id AND ar.deleted_at IS NULL
             AND ar.attendance_date BETWEEN la.start_date AND la.end_date
             AND ar.status IN ('present', 'late')) END AS worked_days,
        -- HR / admin may take the manager step: it was escalated, or there is
        -- no manager who can act (none, left, or no active login) — the same
        -- rule leaves.routes.js authorizeL1 applies (2026-11-24).
        (COALESCE(la.escalation_step = 'l1', false) OR NOT EXISTS (
           SELECT 1 FROM employees rm JOIN users ru ON ru.employee_id = rm.id AND ru.is_active = TRUE
            WHERE rm.id = e.reporting_manager_id AND rm.id <> e.id AND rm.deleted_at IS NULL
              AND NOT (${isExitedSql('rm.status')})
        )) AS hr_may_decide_l1
      FROM leave_applications la
      JOIN employees e  ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      LEFT JOIN employees m ON la.manager_id = m.id
      LEFT JOIN employees h ON la.hr_id = h.id
      LEFT JOIN employees l2 ON la.l2_approver_id = l2.id
      LEFT JOIN employees dl ON la.delegate_approver_id = dl.id
      WHERE la.deleted_at IS NULL
        AND e.status IS DISTINCT FROM 'Left'${cidClause}
    `;

    // Approval queues, decided here so the L2 and HR tabs never list the same
    // leave: L2 only for types that need a department head; HR once L1 (and,
    // where required, L2) has approved.
    if (filters.queue === 'l2') {
      query += ` AND la.status = 'pending' AND la.manager_status = 'approved'
                 AND COALESCE(lt.l2_required, false) = true
                 AND (la.l2_status IS NULL OR la.l2_status = 'pending')`;
    } else if (filters.queue === 'hr') {
      query += ` AND la.status = 'pending' AND la.manager_status = 'approved'
                 AND (COALESCE(lt.l2_required, false) = false OR la.l2_status = 'approved')`;
    }
    if (filters.leave_type_id) {
      query += ` AND la.leave_type_id = $${paramCount}`;
      params.push(parseInt(filters.leave_type_id, 10));
      paramCount++;
    }
    if (filters.year) {
      query += ` AND EXTRACT(YEAR FROM la.start_date) = $${paramCount}`;
      params.push(parseInt(filters.year, 10));
      paramCount++;
    }
    // Overlap window (any leave touching [from, to]) — the register's date filter.
    if (filters.from && filters.to) {
      query += ` AND la.start_date <= $${paramCount + 1}::date AND la.end_date >= $${paramCount}::date`;
      params.push(filters.from, filters.to);
      paramCount += 2;
    }

    if (filters.employee_id) {
      query += ` AND la.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }
    // The manager step's own queue (2026-11-25): whoever the server lets
    // decide L1 — the CURRENT reporting manager, or the assigned delegate
    // (authorizeManagerApproval). la.manager_id is a snapshot from apply
    // time, so a delegate, or a manager who took over the team, never saw
    // the leaves they were allowed to decide.
    if (filters.l1_for) {
      query += ` AND (e.reporting_manager_id = $${paramCount} OR la.delegate_approver_id = $${paramCount})`;
      params.push(filters.l1_for);
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
      // FOR UPDATE: two decisions on the same leave serialise here, and the
      // second sees the first one's result instead of deciding it again.
      const { rows: before } = await client.query(
        `SELECT * FROM leave_applications WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]
      );
      if (!before.length) throw workflowError('Leave application not found', 'LEAVE_NOT_ACTIONABLE');
      const prev = before[0];
      if (prev.status === normalized) throw workflowError('Leave already has requested status', 'LEAVE_NOT_ACTIONABLE');
      // Only real transitions. A decided leave used to be re-openable to
      // 'pending' (no balance reversal) and then approved again — deducting the
      // balance twice — and a rejected or cancelled one could be approved.
      const ALLOWED = { pending: ['approved', 'rejected', 'cancelled'], approved: ['cancelled'] };
      if (!(ALLOWED[prev.status] || []).includes(normalized)) {
        throw workflowError(`A leave that is ${prev.status} cannot be set to ${normalized}`, 'LEAVE_NOT_ACTIONABLE');
      }

      const result = await client.query(
        `UPDATE leave_applications
         -- $1 is cast everywhere: bare in SET it deduces varchar, inside the
         -- CASE/IN it deduces text, and Postgres refuses the statement
         -- ("inconsistent types deduced for parameter $1") — which made
         -- cancel, withdraw, HR bulk-approve and status update all 500.
         SET status = $1::varchar,
             hr_status     = CASE WHEN $1::varchar IN ('approved','rejected') THEN $1::varchar ELSE hr_status END,
             l2_status     = CASE WHEN $1::varchar IN ('approved','rejected') THEN $1::varchar ELSE l2_status END,
             manager_status = CASE WHEN $1::varchar IN ('approved','rejected') AND manager_status = 'pending' THEN $1::varchar ELSE manager_status END,
             -- The applicant cancelling their own leave is not "HR": it stamped
             -- their own id as hr_id and (withdraw) their reason as HR's comment.
             hr_id         = CASE WHEN $1::varchar = 'cancelled' AND $3::int IS NOT DISTINCT FROM employee_id THEN hr_id ELSE COALESCE(hr_id, $3::int) END,
             hr_comments   = CASE WHEN $1::varchar = 'cancelled' AND $3::int IS NOT DISTINCT FROM employee_id THEN hr_comments ELSE COALESCE($4, hr_comments) END,
             hr_approved_at = CASE WHEN $1::varchar IN ('approved','rejected') THEN CURRENT_TIMESTAMP ELSE hr_approved_at END,
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
      `SELECT lt.annual_quota, lt.accrual_type, lt.is_comp_off_type, to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date
         FROM leave_types lt LEFT JOIN employees e ON e.id = $2 WHERE lt.id = $1 LIMIT 1`, [application.leave_type_id, application.employee_id]
    ).catch(() => ({ rows: [] }));
    // Only used when no balance row exists yet: the same opening figure as everywhere else.
    const allocatedDays = lt ? openingAllocation(lt, lt.joining_date, year) : 0;

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

    // Comp Off (2026-11-25): approving consumed the oldest credits (marked
    // 'used', FIFO, above); cancelling left them 'used', so the days came back
    // to the balance but their credits could never expire. Hand back as many
    // credits as were taken — the most recently used, never one the expiry job
    // closed. A credit already past expires_on is expired again by the next
    // leave.cron run, which also takes its days off the balance.
    const { rows: [lt] } = await client.query(
      'SELECT is_comp_off_type FROM leave_types WHERE id = $1', [application.leave_type_id]);
    if (lt?.is_comp_off_type) {
      await client.query(
        `UPDATE compensatory_off SET status = 'approved', updated_at = CURRENT_TIMESTAMP
          WHERE id IN (
            SELECT id FROM compensatory_off
             WHERE employee_id = $1 AND status = 'used' AND credited = true
               AND COALESCE(comments, '') NOT LIKE '%Expired%'
             ORDER BY updated_at DESC, work_date DESC
             LIMIT $2)`,
        [application.employee_id, Math.ceil(Number(application.number_of_days) || 1)]);
    }
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

    // Who the caller may see (calendarScopeOf in leaves.routes.js).
    cidClause += scopeClause(filters.scope, params);
    paramCount = params.length + 1;

    // Only what the calendar draws (2026-11-25). `la.*` also sent the reason,
    // the attachment URL and every approver's comments to each viewer.
    let query = `
      SELECT la.id, la.employee_id, la.leave_type_id, la.start_date, la.end_date,
        la.number_of_days, la.half_day, la.half_day_session, la.status,
        COALESCE(NULLIF(TRIM(e.name), ''), TRIM(CONCAT(e.first_name, ' ', e.last_name))) AS employee_name,
        e.department, e.zone_id,
        lt.leave_name, lt.leave_name AS leave_type
      FROM leave_applications la
      JOIN employees e  ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE ${['1', 'true'].includes(String(filters.include_pending || '')) ? "la.status IN ('approved', 'pending')" : "la.status = 'approved'"}
        AND la.deleted_at IS NULL${cidClause}
    `;
    // include_pending=1 (Leave Calendar → "Show pending"): requests not yet
    // decided too, so cover can be planned before they are approved. Without
    // it approved only — Leave Approvals' "also off" relies on that.

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

    query += ` ORDER BY la.start_date, employee_name`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  /** The current staff the Leave Calendar filters may name — same scope as getLeaveCalendar. */
  async getLeaveCalendarPeople({ company_id = null, scope = null, currentSql }) {
    const params = [company_id];
    const where = `($1::int IS NULL OR e.company_id = $1) AND ${currentSql}${scopeClause(scope, params)}`;
    const { rows } = await pool.query(
      `SELECT e.id, e.office_id, e.department, e.zone_id,
              COALESCE(NULLIF(TRIM(e.name), ''), TRIM(CONCAT(e.first_name, ' ', e.last_name))) AS name
         FROM employees e
        WHERE ${where}
        ORDER BY name`, params);
    return rows;
  },

  /**
   * Holidays for the Leave Calendar (2026-11-25): the company-wide ones plus
   * those of every zone the caller's people sit in, or of one employee's
   * zone. GET /holidays gives a non-HR viewer only THEIR zone, so a manager
   * with a team in another zone saw the wrong days off.
   */
  async getLeaveCalendarHolidays({ company_id = null, scope = null, year, employee_id = null, currentSql }) {
    const params = [company_id, Number(year)];
    let empWhere = `($1::int IS NULL OR e.company_id = $1) AND ${currentSql}${scopeClause(scope, params)}`;
    if (employee_id != null) { params.push(Number(employee_id)); empWhere += ` AND e.id = $${params.length}`; }
    const { rows } = await pool.query(
      `WITH people AS (SELECT e.zone_id FROM employees e WHERE ${empWhere})
       SELECT h.id, h.name, h.date, h.type, h.zone_id, mz.name AS zone_name
         FROM holidays h
         LEFT JOIN master_zones mz ON mz.id = h.zone_id
        WHERE ($1::int IS NULL OR h.company_id = $1 OR h.company_id IS NULL)
          AND EXTRACT(year FROM h.date) = $2
          AND EXISTS (SELECT 1 FROM people)
          AND (h.zone_id IS NULL OR h.zone_id IN (SELECT zone_id FROM people WHERE zone_id IS NOT NULL))
        ORDER BY h.date`, params);
    return rows;
  },

  /** Who is on approved leave on the business "today", within the caller's scope. */
  async getOnLeaveToday({ company_id = null, scope = null, department = null }) {
    const params = [company_id];
    let where = `($1::int IS NULL OR e.company_id = $1)${scopeClause(scope, params)}`;
    if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
    // CURRENT_DATE is the business date (timezone.js pins the session zone);
    // toISOString() was UTC, i.e. yesterday until 05:30 IST.
    const { rows } = await pool.query(
      `SELECT DISTINCT
              la.id AS leave_id, la.employee_id,
              COALESCE(NULLIF(TRIM(e.name), ''), TRIM(CONCAT(e.first_name, ' ', e.last_name))) AS employee_name,
              e.department, e.designation, lt.leave_name,
              la.start_date, la.end_date, la.number_of_days, la.half_day, la.half_day_session
         FROM leave_applications la
         JOIN employees e  ON la.employee_id = e.id
         JOIN leave_types lt ON la.leave_type_id = lt.id
        WHERE la.status = 'approved' AND la.deleted_at IS NULL
          AND la.start_date <= CURRENT_DATE AND la.end_date >= CURRENT_DATE
          AND ${where}
        ORDER BY e.department, employee_name`, params);
    return rows;
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
