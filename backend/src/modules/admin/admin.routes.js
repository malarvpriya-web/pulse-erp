import express from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../config/db.js';
import { allowRoles, hasRole } from '../../middlewares/auth.middleware.js';
import auditRepository from '../audit/repositories/audit.repository.js';
import { seedCompanyDefaults } from '../../seeds/defaultSeed.js';
import { getMenuOverrides, setMenuOverrides, getUserMenuOverrides, setUserMenuOverrides } from '../../services/PermissionService.js';
import { syncPrimaryRole } from '../../services/userRoles.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();

// ── helper: fire-and-forget audit log (never blocks the response) ─────────────
function logAudit(req, action, refId, refType, oldData, newData) {
  const userId = req.user?.userId ?? req.user?.id ?? null;
  auditRepository.create({
    user_id       : userId,
    module_name   : 'admin',
    action_type   : action,
    reference_id  : refId  ? String(refId) : null,
    reference_type: refType ?? null,
    old_data_json : oldData ?? null,
    new_data_json : newData ?? null,
    ip_address    : req.ip  ?? null,
    user_agent    : req.headers['user-agent'] ?? null,
  }).catch(err => console.error('[admin] audit log failed:', err.message));
}

// ── READ endpoints — accessible to admin, hr, manager ────────────────────────

// Users setup (employee-facing list — readable by hr/manager)
router.get('/users-setup', allowRoles('admin', 'super_admin', 'hr', 'manager'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.office_id AS emp_id, CONCAT(e.first_name,' ',e.last_name) AS name,
             e.designation, e.department, 'None' AS sub_department,
             'User' AS role, e.phone AS mobile, e.company_email AS email, e.joining_date AS doj,
             e.reporting_manager AS reporting_manager, e.id, e.company_email AS login,
             'ALL' AS company, e.company_email AS communication_mail,
             0 AS tsm, COALESCE(e.location,'Head Office') AS location,
             e.photo_url AS photo, COALESCE(e.dob, e.date_of_birth) AS dob,
             DATE_PART('year', AGE(COALESCE(e.dob, e.date_of_birth))) AS age,
             e.gender, e.blood_group,
             DATE_PART('year', AGE(e.joining_date)) AS no_of_years,
             0 AS pre_exp,
             DATE_PART('year', AGE(e.joining_date)) AS total_exp
      FROM employees e WHERE LOWER(e.status) IN ('active','probation')
      ORDER BY e.first_name`);
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

// System users list — admin only
router.get('/users', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(`
      SELECT id, name, email, role, department,
             CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status,
             last_login,
             COALESCE(two_fa_enabled, false) AS two_factor_enabled,
             created_at
      FROM users WHERE company_id=$1 ORDER BY created_at DESC`, [cid]);
    res.json(rows);
  } catch(e) {
    console.error('[admin] GET /users failed:', e.message);
    res.json([]);
  }
});

// Create user — admin only
router.post('/users', allowRoles('admin', 'super_admin'), async (req, res) => {
  const { name, email, password, role = 'employee', department = null } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  // Only super_admin may create another super_admin
  if (role === 'super_admin' && !hasRole(req, 'super_admin'))
    return res.status(403).json({ error: 'Only a super_admin can assign the super_admin role' });
  try {
    const cid  = req.scope?.company_id;
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, department, is_active, company_id)
       VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id,name,email,role,department`,
      [name, email, hash, role, department, cid]
    );
    const created = rows[0];
    // users.role is only the primary-role mirror — the junction is what grants
    // permissions, so it has to be written too or the account is powerless.
    await syncPrimaryRole(created.id, role, cid, req.user?.userId ?? null);
    logAudit(req, 'create', created.id, 'user',
      null,
      { id: created.id, name: created.name, email: created.email, role: created.role }
    );
    res.status(201).json({ user: created });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Bulk deactivate users — admin/super_admin only
router.post('/users/bulk-deactivate', allowRoles('admin', 'super_admin'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  const callerId = String(req.user?.userId ?? req.user?.id ?? '');
  const filteredIds = ids.filter(id => String(id) !== callerId);
  if (filteredIds.length === 0)
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  try {
    const cid = req.scope?.company_id;
    const placeholders = filteredIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rowCount } = await pool.query(
      `UPDATE users SET is_active = FALSE WHERE id IN (${placeholders}) AND is_active = TRUE AND company_id = $${filteredIds.length + 1}`,
      [...filteredIds, cid]
    );
    logAudit(req, 'bulk_deactivate', null, 'user', null, { ids: filteredIds, deactivated: rowCount });
    res.json({ success: true, deactivated: rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update user (status, role, department) — admin only
router.put('/users/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id;
  const { status, role, department } = req.body;
  // Only super_admin may promote someone to super_admin
  if (role === 'super_admin' && !hasRole(req, 'super_admin'))
    return res.status(403).json({ error: 'Only a super_admin can assign the super_admin role' });
  const updates = [], vals = [];
  if (status !== undefined) { vals.push(status === 'active'); updates.push(`is_active=$${vals.length}`); }
  if (role)       { vals.push(role);       updates.push(`role=$${vals.length}`); }
  if (department !== undefined) { vals.push(department); updates.push(`department=$${vals.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  const idParam  = vals.length;
  vals.push(cid);
  const cidParam = vals.length;
  try {
    const { rows: before } = await pool.query(
      `SELECT id, name, email, role, department, is_active FROM users WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!before.length) return res.status(404).json({ error: 'User not found' });
    await pool.query(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${idParam} AND company_id=$${cidParam}`,
      vals
    );
    // Changing the primary role here must promote the matching junction row,
    // or users.role and user_roles disagree and the grid shows a stale primary.
    if (role) await syncPrimaryRole(req.params.id, role, cid, req.user?.userId ?? null);
    logAudit(req, 'update', req.params.id, 'user', before[0], { status, role, department });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Deactivate (soft-delete) user — admin only
router.delete('/users/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id;
  try {
    const { rows: before } = await pool.query(
      `SELECT id, name, email, role, is_active FROM users WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!before.length) return res.status(404).json({ error: 'User not found' });
    if (!before[0].is_active) return res.status(409).json({ error: 'User is already inactive' });
    // Prevent self-deactivation
    const callerId = req.user?.userId ?? req.user?.id;
    if (String(callerId) === String(req.params.id))
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    await pool.query(`UPDATE users SET is_active=FALSE WHERE id=$1 AND company_id=$2`, [req.params.id, cid]);
    logAudit(req, 'delete', req.params.id, 'user',
      before[0],
      { action: 'deactivated' }
    );
    res.json({ success: true, message: `User ${before[0].email} deactivated` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reset password — admin only
router.post('/users/:id/reset-password', allowRoles('admin', 'super_admin'), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const cid  = req.scope?.company_id;
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 AND company_id=$3', [hash, req.params.id, cid]);
    logAudit(req, 'update', req.params.id, 'user',
      null,
      { action: 'password_reset', target_user_id: req.params.id }
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ROLES SETUP (user_roles assignments) ──────────────────────────────────────
// Roles are many-to-many. The grid is one row PER ASSIGNMENT, so a member
// holding three roles appears as three rows — that is the shape of the data,
// not a rendering choice.
//
// users.role is maintained alongside as the primary role. Every write here
// keeps the two in sync; see 20260716000009_user_roles_junction.js.

// Whitelisted sort keys → SQL. Never interpolate req.query into ORDER BY.
const ROLE_SORTS = {
  member_id: 'u.id',
  login:     'LOWER(u.email)',
  role:      'LOWER(r.code)',
  name:      'LOWER(COALESCE(u.name, \'\'))',
};

// Only a super_admin may grant or revoke these — an admin must not be able to
// escalate itself or a peer to full system access.
const PRIVILEGED_ROLES = new Set(['admin', 'super_admin']);

router.get('/roles-setup', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid    = req.scope?.company_id ?? null;
  const pg     = Math.max(1, parseInt(req.query.page,  10) || 1);
  const lim    = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (pg - 1) * lim;
  const q      = String(req.query.q || '').trim();
  const sortCol = ROLE_SORTS[String(req.query.sort || '')] || ROLE_SORTS.member_id;
  const dir     = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  // $1 company, $2 search (NULL = no filter)
  const where = `WHERE u.company_id = $1
                   AND ($2::text IS NULL OR
                        u.name  ILIKE '%' || $2 || '%' OR
                        u.email ILIKE '%' || $2 || '%' OR
                        r.code  ILIKE '%' || $2 || '%' OR
                        COALESCE(r.label, r.role_name, '') ILIKE '%' || $2 || '%')`;
  const search = q || null;

  try {
    const [countRes, dataRes, roleCountRes, rolesRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM user_roles ur
           JOIN users u ON u.id = ur.user_id
           JOIN roles r ON r.id = ur.role_id
         ${where}`,
        [cid, search]
      ),
      pool.query(
        `SELECT ur.id            AS assignment_id,
                u.id             AS member_id,
                u.name           AS name,
                u.email          AS login,
                u.is_active      AS is_active,
                u.last_login     AS last_login,
                r.code           AS role,
                COALESCE(NULLIF(r.label,''), NULLIF(r.role_name,''),
                         INITCAP(REPLACE(r.code,'_',' '))) AS role_label,
                ur.is_primary    AS is_primary,
                (SELECT COUNT(*) FROM user_roles x WHERE x.user_id = u.id) AS role_count
           FROM user_roles ur
           JOIN users u ON u.id = ur.user_id
           JOIN roles r ON r.id = ur.role_id
         ${where}
          ORDER BY ${sortCol} ${dir}, u.id, ur.is_primary DESC, LOWER(r.code)
          LIMIT $3 OFFSET $4`,
        [cid, search, lim, offset]
      ),
      // Chips: assignments per role across the whole company, not just this page.
      pool.query(
        `SELECT LOWER(r.code) AS role, COUNT(*) AS cnt
           FROM user_roles ur
           JOIN users u ON u.id = ur.user_id
           JOIN roles r ON r.id = ur.role_id
          WHERE u.company_id = $1
          GROUP BY LOWER(r.code)`,
        [cid]
      ),
      pool.query(
        `SELECT code,
                COALESCE(NULLIF(label,''), NULLIF(role_name,''),
                         INITCAP(REPLACE(code,'_',' '))) AS label
           FROM roles
          WHERE is_active = true AND (company_id = $1 OR company_id IS NULL)
          ORDER BY id`,
        [cid]
      ),
    ]);

    res.json({
      total:      parseInt(countRes.rows[0].count, 10),
      page:       pg,
      limit:      lim,
      data:       dataRes.rows,
      roleCounts: roleCountRes.rows.reduce((a, r) => { a[r.role] = parseInt(r.cnt, 10); return a; }, {}),
      roles:      rolesRes.rows,
    });
  } catch(e) {
    console.error('[admin] GET /roles-setup failed:', e.message);
    res.status(500).json({ error: 'Could not load role assignments' });
  }
});

// Member picker for the "New assignment" drawer.
router.get('/roles-setup/members', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users
        WHERE company_id = $1 AND is_active = true
        ORDER BY LOWER(COALESCE(name, email))`,
      [cid]
    );
    res.json(rows);
  } catch (e) {
    console.error('[admin] GET /roles-setup/members failed:', e.message);
    res.status(500).json({ error: 'Could not load members' });
  }
});

// Grant a role. Idempotent: re-granting an existing assignment is a no-op.
router.post('/roles-setup/assignments', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid       = req.scope?.company_id ?? null;
  const userId    = parseInt(req.body?.user_id, 10);
  const roleCode  = String(req.body?.role_code || '').trim().toLowerCase();
  const makePrimary = req.body?.is_primary === true;

  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'user_id is required' });
  if (!roleCode)                 return res.status(400).json({ error: 'role_code is required' });
  if (cid == null)               return res.status(400).json({ error: 'company scope not found in session' });
  if (PRIVILEGED_ROLES.has(roleCode) && !hasRole(req, 'super_admin'))
    return res.status(403).json({ error: `Only a super_admin can grant the ${roleCode} role` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Target must be inside the caller's company (BUG 1: no cross-company grants).
    const { rows: target } = await client.query(
      `SELECT id, role FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [userId, cid]
    );
    if (!target.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Member not found in this company' }); }

    const { rows: role } = await client.query(
      `SELECT id, code FROM roles
        WHERE LOWER(code) = $1 AND is_active = true AND (company_id = $2 OR company_id IS NULL)`,
      [roleCode, cid]
    );
    if (!role.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Unknown or inactive role: ${roleCode}` }); }

    // First role a user gets is automatically their primary.
    const { rows: existing } = await client.query(
      `SELECT COUNT(*)::int AS n FROM user_roles WHERE user_id = $1`, [userId]
    );
    const isPrimary = makePrimary || existing[0].n === 0;

    if (isPrimary) {
      await client.query(`UPDATE user_roles SET is_primary = FALSE WHERE user_id = $1`, [userId]);
    }
    const { rows: ins } = await client.query(
      `INSERT INTO user_roles (user_id, role_id, company_id, is_primary, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, role_id)
       DO UPDATE SET is_primary = user_roles.is_primary OR EXCLUDED.is_primary
       RETURNING id, is_primary`,
      [userId, role[0].id, cid, isPrimary, req.user?.userId ?? null]
    );
    if (ins[0].is_primary) {
      await client.query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [role[0].code, userId]);
    }

    await client.query('COMMIT');
    logAudit(req, 'create', ins[0].id, 'user_roles', null, { user_id: userId, role: roleCode, is_primary: ins[0].is_primary });
    res.status(201).json({ success: true, assignment_id: ins[0].id, is_primary: ins[0].is_primary });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin] POST /roles-setup/assignments failed:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Make an existing assignment the member's primary role (keeps users.role in sync).
router.put('/roles-setup/assignments/:id/primary', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const id  = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid assignment id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT ur.id, ur.user_id, r.code
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.id = $1 AND u.company_id = $2`,
      [id, cid]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Assignment not found' }); }
    if (PRIVILEGED_ROLES.has(rows[0].code.toLowerCase()) && !hasRole(req, 'super_admin')) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Only a super_admin can set ${rows[0].code} as primary` });
    }

    await client.query(`UPDATE user_roles SET is_primary = FALSE WHERE user_id = $1`, [rows[0].user_id]);
    await client.query(`UPDATE user_roles SET is_primary = TRUE  WHERE id = $1`, [id]);
    await client.query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [rows[0].code, rows[0].user_id]);
    await client.query('COMMIT');

    logAudit(req, 'update', id, 'user_roles', null, { user_id: rows[0].user_id, primary_role: rows[0].code });
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin] PUT /roles-setup/assignments/:id/primary failed:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Revoke a role assignment.
router.delete('/roles-setup/assignments/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const id  = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid assignment id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT ur.id, ur.user_id, ur.is_primary, r.code,
              (SELECT COUNT(*)::int FROM user_roles x WHERE x.user_id = ur.user_id) AS role_count
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.id = $1 AND u.company_id = $2`,
      [id, cid]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Assignment not found' }); }
    const a = rows[0];

    // A user with zero roles has no permissions and cannot be repaired from any
    // screen — refuse rather than create an unreachable account.
    if (a.role_count <= 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cannot remove a member\'s only role. Assign another role first.' });
    }
    if (PRIVILEGED_ROLES.has(a.code.toLowerCase()) && !hasRole(req, 'super_admin')) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Only a super_admin can revoke the ${a.code} role` });
    }
    // Self-lockout guard: don't let the last super_admin drop their own access.
    if (a.code.toLowerCase() === 'super_admin' && a.user_id === (req.user?.userId ?? null)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You cannot revoke your own super_admin role.' });
    }

    await client.query(`DELETE FROM user_roles WHERE id = $1`, [id]);

    // Removing the primary promotes the next remaining role so users.role and
    // the junction never disagree.
    if (a.is_primary) {
      const { rows: next } = await client.query(
        `SELECT ur.id, r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 ORDER BY ur.id LIMIT 1`,
        [a.user_id]
      );
      if (next.length) {
        await client.query(`UPDATE user_roles SET is_primary = TRUE WHERE id = $1`, [next[0].id]);
        await client.query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [next[0].code, a.user_id]);
      }
    }

    await client.query('COMMIT');
    logAudit(req, 'delete', id, 'user_roles', { user_id: a.user_id, role: a.code }, null);
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin] DELETE /roles-setup/assignments/:id failed:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── MENU / PAGE ACCESS CONTROL ────────────────────────────────────────────────
// Roles that can be configured on the Page Access screen. super_admin is
// intentionally excluded — it always has full access and can never be locked out.
const MANAGEABLE_ROLES = [
  { code: 'admin',    label: 'Admin',    description: 'Company administrator' },
  { code: 'manager',  label: 'Manager',  description: 'Team / department manager' },
  { code: 'hr',       label: 'HR',       description: 'Human resources' },
  { code: 'finance',  label: 'Finance',  description: 'Finance & accounts' },
  { code: 'engineer', label: 'Engineer', description: 'Design / production / service engineer' },
  { code: 'employee', label: 'Employee', description: 'Self-service staff' },
];
const MANAGEABLE_SET = new Set(MANAGEABLE_ROLES.map(r => r.code));

// List the roles available on the Page Access screen, plus any additional
// distinct roles already present in this company's user base.
router.get('/menu-roles', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT LOWER(role) AS role FROM users
        WHERE company_id = $1 AND role IS NOT NULL`,
      [cid]
    );
    const extras = rows
      .map(r => r.role)
      .filter(r => r && !MANAGEABLE_SET.has(r) && r !== 'super_admin')
      .map(r => ({ code: r, label: r.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), description: 'Custom role' }));
    res.json([...MANAGEABLE_ROLES, ...extras]);
  } catch (e) {
    console.error('[admin] GET /menu-roles failed:', e.message);
    res.json(MANAGEABLE_ROLES);
  }
});

// Get the configured page-access overrides for one role → { module_id: level }
router.get('/menu-permissions', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid  = req.scope?.company_id;
  const role = String(req.query.role || '').toLowerCase();
  if (!role) return res.status(400).json({ error: 'role query parameter is required' });
  if (role === 'super_admin')
    return res.status(400).json({ error: 'super_admin always has full access and cannot be restricted' });
  try {
    const overrides = await getMenuOverrides(cid, role);
    res.json({ role, overrides });
  } catch (e) {
    console.error('[admin] GET /menu-permissions failed:', e.message);
    res.json({ role, overrides: {} });
  }
});

// Replace the full page-access override set for one role
router.put('/menu-permissions', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid  = req.scope?.company_id;
  const role = String(req.body?.role || '').toLowerCase();
  const permissions = req.body?.permissions;
  if (!role) return res.status(400).json({ error: 'role is required' });
  if (role === 'super_admin')
    return res.status(403).json({ error: 'super_admin always has full access and cannot be restricted' });
  // A non-super_admin cannot edit the admin role's access (privilege-boundary guard)
  if (role === 'admin' && !hasRole(req, 'super_admin'))
    return res.status(403).json({ error: 'Only a super_admin can change the Admin role\'s page access' });
  if (!Array.isArray(permissions))
    return res.status(400).json({ error: 'permissions must be an array of { module_id, access_level }' });
  if (cid == null)
    return res.status(400).json({ error: 'company scope not found in session' });
  try {
    const updatedBy = req.user?.userId ?? req.user?.id ?? null;
    await setMenuOverrides(cid, role, permissions, updatedBy);
    logAudit(req, 'update', null, 'menu_permissions', { role }, { role, count: permissions.length });
    const overrides = await getMenuOverrides(cid, role);
    res.json({ success: true, role, overrides });
  } catch (e) {
    console.error('[admin] PUT /menu-permissions failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get per-employee overrides, plus the role baseline for display →
//   { user, role, roleOverrides, userOverrides }
router.get('/user-menu-permissions', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid    = req.scope?.company_id;
  const userId = parseInt(req.query.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'user_id query parameter is required' });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role FROM users WHERE id = $1 AND company_id = $2`,
      [userId, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    const role = String(user.role || '').toLowerCase();
    const [roleOverrides, userOverrides] = await Promise.all([
      role && role !== 'super_admin' ? getMenuOverrides(cid, role) : Promise.resolve({}),
      getUserMenuOverrides(cid, userId),
    ]);
    res.json({ user, role, roleOverrides, userOverrides });
  } catch (e) {
    console.error('[admin] GET /user-menu-permissions failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Replace the full per-employee override set for one user
router.put('/user-menu-permissions', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid    = req.scope?.company_id;
  const userId = parseInt(req.body?.user_id, 10);
  const permissions = req.body?.permissions;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  if (!Array.isArray(permissions))
    return res.status(400).json({ error: 'permissions must be an array of { module_id, access_level }' });
  if (cid == null) return res.status(400).json({ error: 'company scope not found in session' });
  try {
    const { rows } = await pool.query(
      `SELECT id, role FROM users WHERE id = $1 AND company_id = $2`,
      [userId, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    // Guard: a super_admin user is never restricted; only a super_admin may
    // override an admin user's access.
    const targetRole = String(rows[0].role || '').toLowerCase();
    if (targetRole === 'super_admin')
      return res.status(403).json({ error: 'super_admin users always have full access and cannot be restricted' });
    if (targetRole === 'admin' && !hasRole(req, 'super_admin'))
      return res.status(403).json({ error: 'Only a super_admin can override an Admin user\'s page access' });

    const updatedBy = req.user?.userId ?? req.user?.id ?? null;
    await setUserMenuOverrides(cid, userId, permissions, updatedBy);
    logAudit(req, 'update', userId, 'user_menu_permissions', null, { user_id: userId, count: permissions.length });
    const userOverrides = await getUserMenuOverrides(cid, userId);
    res.json({ success: true, user_id: userId, userOverrides });
  } catch (e) {
    console.error('[admin] PUT /user-menu-permissions failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DOCUMENT SETUP CRUD ───────────────────────────────────────────────────────

router.get('/document-setup', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, doc_type, doc_name, max_size_mb FROM document_types
       WHERE COALESCE(is_active, true) = true ORDER BY doc_name`
    );
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

router.post('/document-setup', allowRoles('admin', 'super_admin'), async (req, res) => {
  const { doc_type, doc_name, max_size_mb = 10 } = req.body;
  if (!doc_type?.trim() || !doc_name?.trim())
    return res.status(400).json({ error: 'doc_type and doc_name are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO document_types (doc_type, doc_name, max_size_mb)
       VALUES ($1,$2,$3) RETURNING *`,
      [doc_type.trim(), doc_name.trim(), parseFloat(max_size_mb) || 10]
    );
    logAudit(req, 'create', rows[0].id, 'document_type', null, rows[0]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/document-setup/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const { doc_type, doc_name, max_size_mb } = req.body;
  if (!doc_type?.trim() || !doc_name?.trim())
    return res.status(400).json({ error: 'doc_type and doc_name are required' });
  try {
    const { rows } = await pool.query(
      `UPDATE document_types SET doc_type=$1, doc_name=$2, max_size_mb=$3 WHERE id=$4 RETURNING *`,
      [doc_type.trim(), doc_name.trim(), parseFloat(max_size_mb) || 10, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'update', req.params.id, 'document_type', null, rows[0]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/document-setup/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE document_types SET is_active=FALSE WHERE id=$1`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'delete', req.params.id, 'document_type', null, { action: 'deactivated' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCTS CRUD ─────────────────────────────────────────────────────────────

const VALID_GST = new Set([0, 5, 12, 18, 28]);

function validateProduct(body) {
  const errors = [];
  if (!body.product_name?.trim())   errors.push('product_name is required');
  if (!body.product_family?.trim()) errors.push('product_family is required');
  const gst = parseFloat(body.gst_rate);
  if (body.gst_rate !== undefined && body.gst_rate !== '' && !VALID_GST.has(gst))
    errors.push('gst_rate must be one of 0, 5, 12, 18, 28');
  const wm = parseInt(body.warranty_months, 10);
  if (body.warranty_months !== undefined && body.warranty_months !== '' && (isNaN(wm) || wm < 0))
    errors.push('warranty_months must be a non-negative integer');
  return errors;
}

// ?show_all=1 → admin management view (all records); default → active only (for dropdowns)
router.get('/products', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const showAll = req.query.show_all === '1' || req.query.show_all === 'true';
    const where   = showAll ? '' : 'WHERE COALESCE(is_active, true) = true';
    const r = await pool.query(
      `SELECT id, product_name, product_family, model_sku, description,
              rating, voltage_class, phase, frequency, topology,
              cooling, ip_rating, bom_template, routing_template, test_plan_template,
              warranty_months, hsn_sac, gst_rate, is_active, created_at, updated_at
       FROM products ${where}
       ORDER BY product_family, product_name`
    );
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

router.post('/products', allowRoles('admin', 'super_admin'), async (req, res) => {
  const errors = validateProduct(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const {
    product_name, product_family, model_sku = '', description = '',
    rating = '', voltage_class = '', phase = '', frequency = '', topology = '',
    cooling = '', ip_rating = '', bom_template = '', routing_template = '',
    test_plan_template = '', warranty_months = 12, hsn_sac = '', gst_rate = 18,
    is_active = true,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO products (
         product_name, product_family, model_sku, description,
         rating, voltage_class, phase, frequency, topology,
         cooling, ip_rating, bom_template, routing_template, test_plan_template,
         warranty_months, hsn_sac, gst_rate, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        product_name.trim(), product_family.trim(), model_sku, description,
        rating, voltage_class, phase, frequency, topology,
        cooling, ip_rating, bom_template, routing_template, test_plan_template,
        parseInt(warranty_months, 10) || 12, hsn_sac, parseFloat(gst_rate) || 0,
        is_active !== false,
      ]
    );
    logAudit(req, 'create', rows[0].id, 'product', null, rows[0]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/products/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const errors = validateProduct(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const {
    product_name, product_family, model_sku = '', description = '',
    rating = '', voltage_class = '', phase = '', frequency = '', topology = '',
    cooling = '', ip_rating = '', bom_template = '', routing_template = '',
    test_plan_template = '', warranty_months = 12, hsn_sac = '', gst_rate = 18,
    is_active = true,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE products SET
         product_name=$1, product_family=$2, model_sku=$3, description=$4,
         rating=$5, voltage_class=$6, phase=$7, frequency=$8, topology=$9,
         cooling=$10, ip_rating=$11, bom_template=$12, routing_template=$13,
         test_plan_template=$14, warranty_months=$15, hsn_sac=$16, gst_rate=$17,
         is_active=$18, updated_at=NOW()
       WHERE id=$19 RETURNING *`,
      [
        product_name.trim(), product_family.trim(), model_sku, description,
        rating, voltage_class, phase, frequency, topology,
        cooling, ip_rating, bom_template, routing_template, test_plan_template,
        parseInt(warranty_months, 10) || 12, hsn_sac, parseFloat(gst_rate) || 0,
        is_active !== false,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'update', req.params.id, 'product', null, rows[0]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/products/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE products SET is_active=FALSE, updated_at=NOW() WHERE id=$1`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'delete', req.params.id, 'product', null, { action: 'deactivated' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCT MASTER — product_lines + product_ratings ──────────────────────────
// The master Product Setup manages, and the list every "Product" dropdown reads.
//
// Supersedes the /products endpoints above: their 17-column contract never
// matched the live `products` table (6 columns), so every read threw and was
// swallowed into an empty grid. See 20260716000007.
//
// Reads are gated on verifyToken alone (from the router's mount in server.js),
// deliberately NOT allowRoles('admin'): this is reference data that Project
// Master and other non-admin screens have to populate a dropdown from — the
// whole point of having one master. Writes stay admin-only.
//
// Read failures return 500, not an empty array. `catch { res.json([]) }` is what
// disguised a broken endpoint as an empty table for months.

const VOLTAGE_CLASSES = new Set(['LV', 'MV', 'HV']);

// '' and NULL are the same absence to a human but two distinct values to the
// unique index, which would then allow both an 'ACB'/'' and an 'ACB'/NULL row.
const nn = (v) => {
  const s = (v ?? '').toString().trim();
  return s === '' ? null : s;
};

function validateProductLine(body) {
  const errors = [];
  const name = nn(body.line_name);
  if (!name) errors.push('line_name is required');
  else if (name.length > 60) errors.push('line_name must be 60 characters or fewer');

  const voltage = nn(body.voltage);
  if (voltage && voltage.length > 20) errors.push('voltage must be 20 characters or fewer');

  const cls = nn(body.voltage_class);
  if (!cls) errors.push('voltage_class is required');
  else if (!VOLTAGE_CLASSES.has(cls.toUpperCase())) errors.push('voltage_class must be one of LV, MV, HV');

  return errors;
}

function validateRating(body) {
  const errors = [];
  const rating = nn(body.rating);
  if (!rating) errors.push('rating is required');
  else if (rating.length > 60) errors.push('rating must be 60 characters or fewer');
  return errors;
}

// A NULL company_id row is invisible to every company-scoped user, so a write
// must never leave it NULL. Global super_admins have no company of their own:
// fall back to the only company where there is exactly one, and make the caller
// name it where the answer would otherwise be a guess.
async function resolveCompanyId(req) {
  if (req.scope?.company_id != null) return req.scope.company_id;
  const fromBody = parseInt(req.body?.company_id, 10);
  if (!isNaN(fromBody)) return fromBody;
  const { rows } = await pool.query('SELECT id FROM companies ORDER BY id LIMIT 2');
  return rows.length === 1 ? rows[0].id : null;
}

// ?show_all=1 → admin grid (active + inactive); default → active only (dropdowns)
router.get('/product-lines', async (req, res) => {
  try {
    const showAll = req.query.show_all === '1' || req.query.show_all === 'true';
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `SELECT pl.id, pl.line_name, pl.voltage, pl.voltage_class, pl.display_name,
              pl.description, pl.company_id, pl.is_active,
              pl.created_at, pl.updated_at,
              COUNT(pr.id)::int AS rating_count
         FROM product_lines pl
         LEFT JOIN product_ratings pr
                ON pr.product_line_id = pl.id AND pr.deleted_at IS NULL
        WHERE pl.deleted_at IS NULL
          AND ($1::int IS NULL OR pl.company_id = $1)
          ${showAll ? '' : 'AND pl.is_active = TRUE'}
        GROUP BY pl.id
        ORDER BY pl.line_name, pl.voltage NULLS FIRST`,
      [cid]
    );
    res.json(rows);
  } catch(e) {
    console.error('[admin] GET /product-lines failed:', e.message);
    res.status(500).json({ error: 'Could not load the product master' });
  }
});

router.post('/product-lines', allowRoles('admin', 'super_admin'), async (req, res) => {
  const errors = validateProductLine(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  try {
    const company_id = await resolveCompanyId(req);
    if (company_id == null)
      return res.status(400).json({ error: 'company_id is required: your account is not scoped to a single company' });

    const { rows } = await pool.query(
      `INSERT INTO product_lines (line_name, voltage, voltage_class, description, company_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        nn(req.body.line_name), nn(req.body.voltage),
        nn(req.body.voltage_class).toUpperCase(), nn(req.body.description),
        company_id, req.body.is_active !== false,
      ]
    );
    logAudit(req, 'create', rows[0].id, 'product_line', null, rows[0]);
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That product line and voltage already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/product-lines/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const errors = validateProductLine(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `UPDATE product_lines
          SET line_name=$1, voltage=$2, voltage_class=$3, description=$4,
              is_active=$5, updated_at=NOW()
        WHERE id=$6 AND deleted_at IS NULL
          AND ($7::int IS NULL OR company_id = $7)
        RETURNING *`,
      [
        nn(req.body.line_name), nn(req.body.voltage),
        nn(req.body.voltage_class).toUpperCase(), nn(req.body.description),
        req.body.is_active !== false, req.params.id, cid,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'update', req.params.id, 'product_line', null, rows[0]);
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That product line and voltage already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Soft delete: projects.product_line_id keeps pointing at the row, so a delivered
// project does not lose what was built for it. The partial unique indexes ignore
// deleted rows, so the same code can be created again afterwards.
router.delete('/product-lines/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rowCount } = await pool.query(
      `UPDATE product_lines SET deleted_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'delete', req.params.id, 'product_line', null, { action: 'soft_deleted' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ratings (child of a product line) ────────────────────────────────────────

router.get('/product-lines/:id/ratings', async (req, res) => {
  try {
    const showAll = req.query.show_all === '1' || req.query.show_all === 'true';
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `SELECT pr.id, pr.product_line_id, pr.rating, pr.description,
              pr.is_active, pr.created_at, pr.updated_at,
              pl.display_name AS product
         FROM product_ratings pr
         JOIN product_lines pl ON pl.id = pr.product_line_id
        WHERE pr.product_line_id = $1
          AND pr.deleted_at IS NULL
          AND ($2::int IS NULL OR pr.company_id = $2)
          ${showAll ? '' : 'AND pr.is_active = TRUE'}
        ORDER BY pr.rating`,
      [req.params.id, cid]
    );
    res.json(rows);
  } catch(e) {
    console.error('[admin] GET /product-lines/:id/ratings failed:', e.message);
    res.status(500).json({ error: 'Could not load ratings' });
  }
});

router.post('/product-lines/:id/ratings', allowRoles('admin', 'super_admin'), async (req, res) => {
  const errors = validateRating(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  try {
    const cid = req.scope?.company_id ?? null;
    // The parent decides the child's company, so a rating can never be scoped
    // somewhere its product is not.
    const parent = await pool.query(
      `SELECT id, company_id FROM product_lines
        WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!parent.rows.length) return res.status(404).json({ error: 'Product not found' });

    const { rows } = await pool.query(
      `INSERT INTO product_ratings (product_line_id, rating, description, company_id, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        parent.rows[0].id, nn(req.body.rating), nn(req.body.description),
        parent.rows[0].company_id, req.body.is_active !== false,
      ]
    );
    logAudit(req, 'create', rows[0].id, 'product_rating', null, rows[0]);
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That rating already exists for this product' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/product-ratings/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const errors = validateRating(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `UPDATE product_ratings
          SET rating=$1, description=$2, is_active=$3, updated_at=NOW()
        WHERE id=$4 AND deleted_at IS NULL AND ($5::int IS NULL OR company_id = $5)
        RETURNING *`,
      [nn(req.body.rating), nn(req.body.description), req.body.is_active !== false, req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'update', req.params.id, 'product_rating', null, rows[0]);
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That rating already exists for this product' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/product-ratings/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rowCount } = await pool.query(
      `UPDATE product_ratings SET deleted_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'delete', req.params.id, 'product_rating', null, { action: 'soft_deleted' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Order-to-Delivery Cycle — Manifest Technologies manufacturing flow
router.get('/order-policy', allowRoles('admin', 'super_admin', 'manager', 'hr'), async (req, res) => {
  const stages = [
    { stage: 'Order Received',       sort_order: 1,  sla_days: 1,  escalate_after_days: 1,  description: 'Customer PO received and acknowledged' },
    { stage: 'Order Confirmation',   sort_order: 2,  sla_days: 2,  escalate_after_days: 2,  description: 'Technical and commercial review completed' },
    { stage: 'Design & Engineering', sort_order: 3,  sla_days: 7,  escalate_after_days: 8,  description: 'Drawings, BOM and BOQ finalised' },
    { stage: 'Procurement',          sort_order: 4,  sla_days: 14, escalate_after_days: 16, description: 'Materials and components sourced' },
    { stage: 'Production',           sort_order: 5,  sla_days: 21, escalate_after_days: 24, description: 'Assembly and manufacturing in progress' },
    { stage: 'Quality Check',        sort_order: 6,  sla_days: 3,  escalate_after_days: 4,  description: 'FAT and quality inspection completed' },
    { stage: 'Dispatch',             sort_order: 7,  sla_days: 2,  escalate_after_days: 3,  description: 'Goods packed and dispatched to site' },
    { stage: 'Installation',         sort_order: 8,  sla_days: 5,  escalate_after_days: 6,  description: 'On-site installation and erection' },
    { stage: 'Commissioning',        sort_order: 9,  sla_days: 3,  escalate_after_days: 4,  description: 'SAT and system commissioning sign-off' },
    { stage: 'Handover / Closure',   sort_order: 10, sla_days: 1,  escalate_after_days: 2,  description: 'As-built documents and warranty start' },
  ];
  res.json(stages);
});

// ── APPROVER CONFIG CRUD ──────────────────────────────────────────────────────

// company scope comes from req.scope (verifyToken resolves it, falling back to
// user_scope for tokens minted before the company_id claim existed) — NOT from
// req.user.company_id, which is only the raw JWT claim and is undefined on
// older tokens. BUG 1: approver chains must never cross companies.
router.get('/approver-setup', allowRoles('admin', 'super_admin', 'hr'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const r = await pool.query(
      `SELECT id, module, approver_role, approver_email, sequence, is_active
       FROM approver_config WHERE is_active = true AND company_id = $1
       ORDER BY module, sequence`,
      [cid]
    );
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

router.post('/approver-setup', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const { module, approver_role, approver_email = '', sequence = 1 } = req.body;
  if (!module?.trim() || !approver_role?.trim())
    return res.status(400).json({ error: 'module and approver_role are required' });
  if (cid == null)
    return res.status(400).json({ error: 'company scope not found in session' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO approver_config (company_id, module, approver_role, approver_email, sequence)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cid, module.trim(), approver_role.trim(), approver_email.trim(), parseInt(sequence) || 1]
    );
    logAudit(req, 'create', rows[0].id, 'approver_config', null, rows[0]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/approver-setup/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const { module, approver_role, approver_email, sequence } = req.body;
  if (!module?.trim() || !approver_role?.trim())
    return res.status(400).json({ error: 'module and approver_role are required' });
  try {
    const { rows } = await pool.query(
      `UPDATE approver_config
       SET module=$1, approver_role=$2, approver_email=$3, sequence=$4, updated_at=NOW()
       WHERE id=$5 AND company_id=$6 RETURNING *`,
      [module.trim(), approver_role.trim(), (approver_email ?? '').trim(), parseInt(sequence) || 1, req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'update', req.params.id, 'approver_config', null, rows[0]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/approver-setup/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const { rowCount } = await pool.query(
      `UPDATE approver_config SET is_active=FALSE WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'delete', req.params.id, 'approver_config', null, { action: 'deactivated' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── NOTIFICATION RULES CRUD ───────────────────────────────────────────────────

router.get('/notification-rules', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = companyOf(req);
  try {
    const r = await pool.query(
      `SELECT id, event_key, title, channel, recipient_roles, enabled, is_system_default
       FROM notification_rules
       WHERE company_id = $1
       ORDER BY event_key`,
      [cid]
    );
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

router.post('/notification-rules', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = companyOf(req);
  const { event_key, title, channel = 'in_app', recipient_roles = ['employee'], enabled = true } = req.body;
  if (!event_key?.trim()) return res.status(400).json({ error: 'event_key is required' });
  if (!title?.trim())     return res.status(400).json({ error: 'title is required' });
  const rolesArr = Array.isArray(recipient_roles) ? recipient_roles : ['employee'];
  try {
    const { rows } = await pool.query(
      `INSERT INTO notification_rules (company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE) RETURNING *`,
      [cid, event_key.trim(), title.trim(), String(channel), rolesArr, enabled]
    );
    logAudit(req, 'create', rows[0].id, 'notification_rule', null, rows[0]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/notification-rules/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = companyOf(req);
  const { event_key, title, channel, recipient_roles, enabled } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  const rolesArr = Array.isArray(recipient_roles) ? recipient_roles : ['employee'];
  try {
    // System defaults: only enabled may change; event_key and title are locked
    const { rows: cur } = await pool.query(
      `SELECT is_system_default, event_key, title FROM notification_rules WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!cur.length) return res.status(404).json({ error: 'Not found' });

    const isDefault = cur[0].is_system_default;
    const finalKey   = isDefault ? cur[0].event_key : (event_key?.trim() ?? cur[0].event_key);
    const finalTitle = isDefault ? cur[0].title      : title.trim();

    const { rows } = await pool.query(
      `UPDATE notification_rules
       SET event_key=$1, title=$2, channel=$3, recipient_roles=$4, enabled=$5
       WHERE id=$6 AND company_id=$7 RETURNING *`,
      [finalKey, finalTitle, String(channel ?? 'in_app'), rolesArr, enabled ?? true, req.params.id, cid]
    );
    logAudit(req, 'update', req.params.id, 'notification_rule', null, rows[0]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/notification-rules/:id/toggle', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = companyOf(req);
  try {
    const { rows } = await pool.query(
      `UPDATE notification_rules SET enabled = NOT enabled
       WHERE id=$1 AND company_id=$2 RETURNING id, enabled`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    logAudit(req, 'update', req.params.id, 'notification_rule', null, rows[0]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/notification-rules/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  const cid = companyOf(req);
  try {
    const { rows } = await pool.query(
      `SELECT is_system_default FROM notification_rules WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].is_system_default)
      return res.status(403).json({ error: 'System default rules cannot be deleted' });

    await pool.query(`DELETE FROM notification_rules WHERE id=$1 AND company_id=$2`, [req.params.id, cid]);
    logAudit(req, 'delete', req.params.id, 'notification_rule', null, { action: 'deleted' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Module activity — aggregated count per module for the current calendar month.
// Returns [{ module, count }] so the frontend bar chart renders correctly.
router.get('/module-activity', allowRoles('admin', 'super_admin', 'hr', 'manager'), async (req, res) => {
  try {
    const startDate = new Date();
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);
    const stats = await auditRepository.getStats({ start_date: startDate.toISOString() });
    res.json(stats.byModule);
  } catch(e) {
    console.error('[admin] GET /module-activity failed:', e.message);
    res.json([]);
  }
});

// POST /admin/seed-defaults — seed default registry data for the current company.
// Safe to run multiple times (all inserts use ON CONFLICT DO NOTHING).
router.post('/seed-defaults', allowRoles('super_admin'), async (req, res) => {
  const cid = req.scope?.company_id;
  if (!cid) return res.status(400).json({ error: 'company_id not found in session' });
  try {
    const result = await seedCompanyDefaults(cid, pool);
    logAudit(req, 'create', null, 'seed_defaults', null, { company_id: cid, failed: result?.failed ?? 0 });
    res.json({
      success: true,
      message: result?.failed
        ? `Seeded with ${result.failed} group(s) skipped — see groups for details.`
        : 'Default registry data seeded successfully.',
      groups: result?.groups ?? [],
      failed: result?.failed ?? 0,
    });
  } catch (err) {
    console.error('[admin] seed-defaults failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
