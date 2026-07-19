import pool from '../config/db.js';

/**
 * user_roles ⇄ users.role synchronisation.
 *
 * Roles are many-to-many (see 20260716000009_user_roles_junction.js), but
 * `users.role` survives as the PRIMARY role: old JWTs, mint-token.js and a long
 * tail of reporting queries still read it. The invariant both sides depend on:
 *
 *     users.role == the code of the user_roles row with is_primary = true
 *
 * Any code path that writes users.role must call syncPrimaryRole() so the two
 * can't drift. Drift here is not cosmetic — rolesOf() reads the junction, so a
 * user whose junction row is missing loses every permission the role grants.
 */

/**
 * Make `roleCode` the user's primary role, creating the assignment if needed.
 * Existing non-primary roles are preserved — this promotes, it does not replace.
 *
 * Pass `db` (a transaction client) to enlist in a caller's transaction;
 * defaults to the pool.
 *
 * Returns true when the junction was updated, false when the role code matches
 * no registry row (the caller's users.role write is then unbacked — logged loudly).
 */
export async function syncPrimaryRole(userId, roleCode, companyId = null, createdBy = null, db = pool) {
  const code = String(roleCode || '').trim().toLowerCase();
  if (!userId || !code) return false;

  const { rows } = await db.query(
    `SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`,
    [code]
  );
  if (!rows.length) {
    console.warn(`[userRoles] users.role='${code}' (user ${userId}) matches no roles.code — no user_roles row written. This user will hold no effective permissions for that role.`);
    return false;
  }

  await db.query(`UPDATE user_roles SET is_primary = FALSE WHERE user_id = $1`, [userId]);
  await db.query(
    `INSERT INTO user_roles (user_id, role_id, company_id, is_primary, created_by)
     VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT (user_id, role_id) DO UPDATE SET is_primary = TRUE`,
    [userId, rows[0].id, companyId, createdBy]
  );
  return true;
}

/** Every role code a user holds, primary first. */
export async function getUserRoles(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT LOWER(r.code) AS code
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY ur.is_primary DESC, r.code`,
    [userId]
  );
  return rows.map(r => r.code);
}
