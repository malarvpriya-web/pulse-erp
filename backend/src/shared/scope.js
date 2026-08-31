/**
 * Tenant scoping helper.
 *
 * Always resolve the caller's company through `req.scope` first. The auth
 * middleware builds req.scope from the JWT claim, falling back to the user's DB
 * row for tokens minted before company_id was a claim, and to a global
 * (company_id: null) scope for super admins with no company assignment.
 *
 * Reading `req.user.company_id` directly skips that DB fallback: an older token
 * without the claim yields null, and null means "no company filter" in the
 * standard `($1::int IS NULL OR company_id = $1)` predicate — i.e. the query
 * fails OPEN across every tenant. Route everything through companyOf().
 *
 * Returns an integer company id, or null for a genuinely global scope.
 */
export function companyOf(req) {
  const raw = req?.scope?.company_id ?? req?.user?.company_id;
  if (raw == null || raw === '') return null;
  const v = parseInt(String(raw), 10);
  return isNaN(v) ? null : v;
}

/**
 * The caller's `employees.id`, or null when they have no employee record.
 *
 * Distinct from `req.user.id`, which is a `users.id`. Confusing the two is a
 * recurring bug in this codebase — `*_by` columns here point at employees
 * (candidate_stage_history.moved_by, stock_ledger.created_by,
 * job_requisitions.requested_by), so comparing a users.id against one silently
 * matches the wrong person or nobody at all.
 *
 * Most JWTs carry employee_id; legacy and demo logins don't, hence the DB
 * fallback. approvals.controller.js (myEmployeeId) and the travel routes
 * (ownEmployeeId) each grew their own copy of this before it lived here — they
 * are left alone deliberately, since changing an authorization helper those
 * modules depend on is a bigger blast radius than this note is worth. New
 * callers should use this one.
 */
export async function employeeOf(req, pool) {
  if (req?.user?.employee_id != null) return req.user.employee_id;
  const userId = req?.user?.userId ?? req?.user?.id ?? null;
  if (!userId || !pool) return null;
  try {
    const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.employee_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Who the caller is, for widgets that answer "my team".
 *
 * employeeOf() resolves only the `users.employee_id` link. Three groups fall
 * through it and every "my team" panel silently rendered empty for all of them:
 *
 *  - Admin / service accounts (superadmin@, admin@) have NO employees row at
 *    all. They still carry `users.department`, which is enough to scope a
 *    department roster.
 *  - Legacy logins predate the employee_id link but match an employees row on
 *    company_email — the same fallback auth.service.js already uses at login.
 *  - The JWT never carried `department`, so req.user.department is always
 *    undefined server-side however it looks in the browser.
 *
 * Returns { employee_id, name, department, source } where source is one of
 * 'employee_link' | 'company_email' | 'user_row' | 'unknown'. employee_id is
 * null when the caller genuinely has no employee record — callers must treat
 * that as "no hierarchy", never as "matches everyone".
 */
export async function callerIdentity(req, pool, companyId = null) {
  const empty = { employee_id: null, name: req?.user?.name ?? null, department: null, source: 'unknown' };
  if (!pool) return empty;

  const userId = req?.user?.userId ?? req?.user?.id ?? null;
  let empId = req?.user?.employee_id ?? null;
  let source = empId != null ? 'employee_link' : null;

  try {
    let userRow = null;
    if (userId) {
      const { rows } = await pool.query(
        'SELECT id, name, email, department, employee_id FROM users WHERE id = $1',
        [userId]
      );
      userRow = rows[0] ?? null;
    }
    if (empId == null && userRow?.employee_id != null) {
      empId = userRow.employee_id;
      source = 'employee_link';
    }
    if (empId == null && userRow?.email) {
      const { rows } = await pool.query(
        `SELECT id FROM employees WHERE company_email = $1 AND deleted_at IS NULL LIMIT 1`,
        [userRow.email]
      );
      if (rows[0]) { empId = rows[0].id; source = 'company_email'; }
    }

    if (empId != null) {
      const { rows } = await pool.query(
        `SELECT id, name, department FROM employees
          WHERE id = $1 AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2)`,
        [empId, companyId]
      );
      if (rows[0]) {
        return {
          employee_id: rows[0].id,
          name: rows[0].name ?? userRow?.name ?? null,
          department: rows[0].department ?? userRow?.department ?? null,
          source,
        };
      }
    }

    // No employee record — an admin or service account. The users row still
    // carries a department, which is all a department-scoped widget needs.
    return {
      employee_id: null,
      name: userRow?.name ?? req?.user?.name ?? null,
      department: userRow?.department ?? null,
      source: userRow ? 'user_row' : 'unknown',
    };
  } catch {
    return empty;
  }
}
