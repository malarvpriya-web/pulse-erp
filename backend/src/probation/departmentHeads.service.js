import pool from "../config/db.js";
import { isCurrentSql } from "../shared/employeeStatus.js";
import { ProbationError } from "./probation.service.js";

/**
 * Department heads — per-company, with history (20261014000006_department_heads).
 *
 * master_departments is GLOBAL and employees.department is free text matched to
 * it by name, so a mapping is (this company, a shared department id) → one of
 * this company's employees. Every function takes the caller's company id,
 * resolved by the controller from the login's own scope — never from the
 * request.
 *
 * A head must be, at the moment of assignment:
 *   - an employee of THIS company (another company's id is "not found");
 *   - current: not deleted and not in an exit status (shared/employeeStatus);
 *   - reachable: linked to an ACTIVE login (users.employee_id), because the
 *     probation review this mapping exists for has to be delivered to someone.
 *
 * Reassigning ends the current row and inserts the next in one transaction.
 * The partial unique index allows one active row per (company, department),
 * so a concurrent reassignment that loses the race gets a 409, never a second
 * active head. Rows are never deleted or rewritten here.
 */

const REASON_MAX = 500;

const positiveInt = (v) => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};
const cleanReason = (v) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, REASON_MAX) : null;
};

/** The calling login's users.id (assigned_by / ended_by), or null. */
export const actorOf = (req) => req?.user?.userId ?? req?.user?.id ?? null;

const HEAD_FIELDS = `
  e.id AS employee_id, e.office_id, e.first_name, e.last_name, e.department AS own_department,
  e.status, (e.deleted_at IS NULL AND ${isCurrentSql('e.status')}) AS is_current,
  EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.is_active = true) AS has_login`;

/**
 * Every active master department, with this company's current head (or none)
 * and how many current employees of this company sit in it, plus the list of
 * employees who may be chosen as a head.
 */
export async function listDepartmentHeads(companyId) {
  const { rows: departments } = await pool.query(
    `SELECT md.id AS department_id, md.name AS department,
            (SELECT COUNT(*)::int FROM employees x
              WHERE x.company_id = $1 AND x.deleted_at IS NULL AND ${isCurrentSql('x.status')}
                AND LOWER(BTRIM(x.department)) = LOWER(BTRIM(md.name))) AS employee_count,
            dh.id AS assignment_id, dh.assigned_at,
            ${HEAD_FIELDS.replace(/\be\./g, 'h.')}
       FROM master_departments md
       LEFT JOIN department_heads dh
              ON dh.department_id = md.id AND dh.company_id = $1 AND dh.ended_at IS NULL
       LEFT JOIN employees h ON h.id = dh.head_employee_id
      WHERE md.is_active = true
      ORDER BY md.name`,
    [companyId],
  );
  const { rows: eligible } = await pool.query(
    `SELECT ${HEAD_FIELDS}
       FROM employees e
      WHERE e.company_id = $1 AND e.deleted_at IS NULL AND ${isCurrentSql('e.status')}
        AND EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.is_active = true)
      ORDER BY e.first_name, e.last_name, e.id`,
    [companyId],
  );
  return {
    departments: departments.map((d) => ({
      department_id: d.department_id,
      department: d.department,
      employee_count: d.employee_count,
      head: d.assignment_id == null ? null : {
        assignment_id: d.assignment_id,
        assigned_at: d.assigned_at,
        employee_id: d.employee_id,
        office_id: d.office_id,
        name: `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim(),
        own_department: d.own_department,
        status: d.status,
        // Flags, not errors: a head who has since exited or lost their login
        // stays mapped until HR reassigns — this pass changes nothing on its own.
        is_current: d.is_current,
        has_login: d.has_login,
      },
    })),
    eligible_heads: eligible.map((e) => ({
      employee_id: e.employee_id,
      office_id: e.office_id,
      name: `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim(),
      department: e.own_department,
    })),
  };
}

/** A department of the shared master. Active only, unless history is being read. */
async function department(db, departmentId, { activeOnly = true } = {}) {
  const id = positiveInt(departmentId);
  if (!id) throw new ProbationError(400, 'Invalid department id.');
  const { rows } = await db.query(
    `SELECT id, name, is_active FROM master_departments WHERE id = $1`, [id]);
  if (!rows[0]) throw new ProbationError(404, 'Department not found.');
  if (activeOnly && !rows[0].is_active) {
    throw new ProbationError(400, `Department "${rows[0].name}" is inactive in Master Data.`);
  }
  return rows[0];
}

/** Assignment history for one department in this company, newest first. */
export async function departmentHistory(companyId, departmentId) {
  const dept = await department(pool, departmentId, { activeOnly: false });
  const { rows } = await pool.query(
    `SELECT dh.id AS assignment_id, dh.assigned_at, dh.ended_at, dh.end_reason,
            h.id AS employee_id, h.office_id,
            TRIM(COALESCE(h.first_name,'') || ' ' || COALESCE(h.last_name,'')) AS head_name,
            ab.name AS assigned_by, eb.name AS ended_by
       FROM department_heads dh
       JOIN employees h  ON h.id = dh.head_employee_id
       LEFT JOIN users ab ON ab.id = dh.assigned_by_user_id
       LEFT JOIN users eb ON eb.id = dh.ended_by_user_id
      WHERE dh.company_id = $1 AND dh.department_id = $2
      ORDER BY dh.assigned_at DESC, dh.id DESC`,
    [companyId, dept.id],
  );
  return { department_id: dept.id, department: dept.name, history: rows };
}

/** The head candidate, checked against every eligibility rule, or a 400. */
async function eligibleHead(db, companyId, employeeId) {
  const id = positiveInt(employeeId);
  if (!id) throw new ProbationError(400, 'head_employee_id is required.');
  const { rows } = await db.query(
    `SELECT ${HEAD_FIELDS} FROM employees e WHERE e.id = $1 AND e.company_id = $2`,
    [id, companyId],
  );
  const h = rows[0];
  if (!h) throw new ProbationError(400, 'The selected head is not an employee of this company.');
  const name = `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() || `#${h.employee_id}`;
  if (!h.is_current) throw new ProbationError(400, `${name} is not a current employee and cannot be a department head.`);
  if (!h.has_login) throw new ProbationError(400, `${name} has no active Pulse login, so probation reviews could not reach them.`);
  return h;
}

/**
 * Assign or reassign. Same head → no change (200, no history row). A different
 * head when one is already assigned → a reason is required; the current row is
 * ended with it and the new row inserted, atomically.
 */
export async function assignDepartmentHead(companyId, departmentId, body = {}, actorUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dept = await department(client, departmentId);
    const head = await eligibleHead(client, companyId, body.head_employee_id);

    const { rows: [current] } = await client.query(
      `SELECT id, head_employee_id FROM department_heads
        WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL
        FOR UPDATE`,
      [companyId, dept.id],
    );
    if (current && current.head_employee_id === head.employee_id) {
      await client.query('ROLLBACK');
      return { changed: false, department_id: dept.id, assignment_id: current.id, head_employee_id: head.employee_id };
    }
    if (current) {
      const reason = cleanReason(body.reason);
      if (!reason) throw new ProbationError(400, 'A reason is required to change a department head.');
      await client.query(
        `UPDATE department_heads
            SET ended_at = NOW(), ended_by_user_id = $2, end_reason = $3
          WHERE id = $1`,
        [current.id, actorUserId, reason],
      );
    }
    const { rows: [created] } = await client.query(
      `INSERT INTO department_heads (company_id, department_id, head_employee_id, assigned_by_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, assigned_at`,
      [companyId, dept.id, head.employee_id, actorUserId],
    );
    await client.query('COMMIT');
    return {
      changed: true, department_id: dept.id, assignment_id: created.id,
      head_employee_id: head.employee_id, replaced_assignment_id: current?.id ?? null,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      throw new ProbationError(409, 'This department head was changed by someone else at the same time. Reload and try again.');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** End the current assignment (no new head). A reason is required. */
export async function endDepartmentHead(companyId, departmentId, body = {}, actorUserId) {
  const reason = cleanReason(body.reason);
  if (!reason) throw new ProbationError(400, 'A reason is required to remove a department head.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dept = await department(client, departmentId, { activeOnly: false });
    const { rows: [ended] } = await client.query(
      `UPDATE department_heads
          SET ended_at = NOW(), ended_by_user_id = $3, end_reason = $4
        WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL
        RETURNING id`,
      [companyId, dept.id, actorUserId, reason],
    );
    if (!ended) throw new ProbationError(404, `"${dept.name}" has no department head assigned.`);
    await client.query('COMMIT');
    return { ended: true, department_id: dept.id, assignment_id: ended.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
