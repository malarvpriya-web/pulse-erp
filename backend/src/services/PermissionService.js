/**
 * PermissionService — Phase 1 platform layer
 *
 * Priority order:  user-level override > role-level default > null (passthrough)
 * All queries are lightweight (indexed lookup).
 *
 * Roles are many-to-many (user_roles). Every `roleCode` parameter below accepts
 * either a single code or an array of them. With several roles the role-level
 * layer is the UNION — the most permissive grant wins, matching
 * requirePermission's BOOL_OR in auth.middleware.js. Intersecting instead would
 * mean adding a role could take access away, which is never what an admin means
 * by "also make them a project manager".
 */

import pool from '../config/db.js';

// Normalise a role code or list of them into a lowercase array.
const roleList = (roleCode) =>
  (Array.isArray(roleCode) ? roleCode : [roleCode])
    .filter(Boolean)
    .map(r => String(r).toLowerCase());

const PERM_FLAGS = ['can_view','can_add','can_edit','can_delete','can_approve','can_export'];

// Most-permissive merge of two permission rows.
const mergePerm = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const f of PERM_FLAGS) out[f] = !!a[f] || !!b[f];
  return out;
};

// Menu access levels, most permissive last.
const MENU_RANK = { hidden: 0, view: 1, edit: 2 };

const KNOWN_MODULES = [
  'leaves','employees','projects','finance','payroll',
  'inventory','procurement','sales','crm','hr',
  'reports','admin','dashboard','announcements','notifications',
  'attendance','timesheets','performance','recruitment',
  'approvals','documents','audit','service',
];

// ── Single module lookup ──────────────────────────────────────────────────────
/**
 * Returns the effective permission row for one user+module pair.
 * @returns {{ can_view, can_add, can_edit, can_delete, can_approve, can_export, source } | null}
 */
export async function getModulePermissions(userId, roleCode, module) {
  // 1. User-level override (highest priority)
  const { rows: ur } = await pool.query(
    `SELECT can_view, can_add, can_edit, can_delete, can_approve, can_export
       FROM permissions WHERE user_id = $1 AND module = $2`,
    [userId, module]
  );
  if (ur.length) return { ...ur[0], source: 'user' };

  // 2. Role-level default — union across every role held
  const codes = roleList(roleCode);
  if (!codes.length) return null;
  const { rows: rr } = await pool.query(
    `SELECT BOOL_OR(rp.can_view)    AS can_view,
            BOOL_OR(rp.can_add)     AS can_add,
            BOOL_OR(rp.can_edit)    AS can_edit,
            BOOL_OR(rp.can_delete)  AS can_delete,
            BOOL_OR(rp.can_approve) AS can_approve,
            BOOL_OR(rp.can_export)  AS can_export
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
      WHERE LOWER(r.code) = ANY($1) AND rp.module = $2
     HAVING COUNT(*) > 0`,
    [codes, module]
  );
  if (rr.length) return { ...rr[0], source: 'role' };

  return null; // No config — caller decides (allow by default for backward compat)
}

// ── Full permission map for auth context ─────────────────────────────────────
/**
 * Returns the merged permission map { module: { can_view, ... } } for a user.
 * Used by GET /auth/permissions to populate frontend auth context.
 */
export async function getMergedPermissions(userId, roleCode) {
  const codes = roleList(roleCode);
  const [{ rows: userPerms }, { rows: rolePerms }] = await Promise.all([
    pool.query(
      `SELECT module, can_view, can_add, can_edit, can_delete, can_approve, can_export
         FROM permissions WHERE user_id = $1`,
      [userId]
    ),
    codes.length
      ? pool.query(
          `SELECT rp.module, rp.can_view, rp.can_add, rp.can_edit,
                  rp.can_delete, rp.can_approve, rp.can_export
             FROM role_permissions rp
             JOIN roles r ON r.id = rp.role_id
            WHERE LOWER(r.code) = ANY($1)`,
          [codes]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const result = {};

  // Role defaults, OR-merged across every role held (a module can appear once
  // per role, so the same module_id arrives multiple times here).
  for (const rp of rolePerms) {
    result[rp.module] = { ...mergePerm(result[rp.module], rp), module: rp.module, source: 'role' };
  }

  // User overrides take precedence
  for (const up of userPerms) result[up.module] = { ...up, source: 'user' };

  // Fill remaining known modules with deny-all so the frontend can rely on presence
  for (const mod of KNOWN_MODULES) {
    if (!result[mod]) {
      result[mod] = {
        module: mod,
        can_view: false, can_add: false, can_edit: false,
        can_delete: false, can_approve: false, can_export: false,
        source: 'default',
      };
    }
  }

  return result;
}

// ── Field permissions ─────────────────────────────────────────────────────────
/**
 * Returns { field_name: { is_visible, is_editable } } for a role+module.
 */
export async function getFieldPermissions(roleCode, module) {
  const codes = roleList(roleCode);
  if (!codes.length) return {};
  // Union across roles: visible/editable if ANY role held allows it.
  const { rows } = await pool.query(
    `SELECT fp.field_name,
            BOOL_OR(fp.is_visible)  AS is_visible,
            BOOL_OR(fp.is_editable) AS is_editable
       FROM field_permissions fp
       JOIN roles r ON r.id = fp.role_id
      WHERE LOWER(r.code) = ANY($1) AND fp.module = $2
      GROUP BY fp.field_name`,
    [codes, module]
  );
  return Object.fromEntries(rows.map(r => [r.field_name, { is_visible: r.is_visible, is_editable: r.is_editable }]));
}

// ── User scope ────────────────────────────────────────────────────────────────
/**
 * Returns the primary scope for a user, plus all scopes.
 * @returns {{ company_id, branch_id, all: [] } | null}
 */
export async function getUserScope(userId) {
  const { rows } = await pool.query(
    `SELECT company_id, branch_id, is_primary
       FROM user_scope WHERE user_id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const primary = rows.find(r => r.is_primary) || rows[0];
  return { company_id: primary.company_id, branch_id: primary.branch_id, all: rows };
}

// ── Menu / page access overrides ──────────────────────────────────────────────
/**
 * Returns the menu access overrides for one company+role as a plain map
 *   { [module_id]: 'hidden' | 'view' | 'edit' }
 * Only rows explicitly configured by an admin are returned; everything else
 * falls back to the built-in module-registry defaults on the client.
 */
export async function getMenuOverrides(companyId, roleCode) {
  const codes = roleList(roleCode);
  if (companyId == null || !codes.length) return {};
  const { rows } = await pool.query(
    `SELECT module_id, access_level
       FROM menu_permissions
      WHERE company_id = $1 AND LOWER(role_code) = ANY($2)`,
    [companyId, codes]
  );
  // With several roles the same module can carry conflicting levels; the most
  // permissive wins (edit > view > hidden) so a second role never removes
  // access. Single-role callers (the Page Access config screen) are unaffected.
  const out = {};
  for (const r of rows) {
    const cur = out[r.module_id];
    if (cur == null || (MENU_RANK[r.access_level] ?? -1) > (MENU_RANK[cur] ?? -1)) {
      out[r.module_id] = r.access_level;
    }
  }
  return out;
}

/**
 * Replaces the full override set for one company+role in a single transaction.
 * `entries` is an array of { module_id, access_level }. Entries whose
 * access_level is 'default' (or falsy) are removed so the module reverts to the
 * built-in registry defaults.
 */
export async function setMenuOverrides(companyId, roleCode, entries, updatedBy = null) {
  if (companyId == null || !roleCode) throw new Error('companyId and roleCode are required');
  const valid = new Set(['hidden', 'view', 'edit']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      const moduleId = String(e?.module_id ?? '').trim();
      if (!moduleId) continue;
      const level = String(e?.access_level ?? '').toLowerCase();
      if (!valid.has(level)) {
        // 'default' / anything else → clear the override for this module
        await client.query(
          `DELETE FROM menu_permissions
            WHERE company_id = $1 AND LOWER(role_code) = LOWER($2) AND module_id = $3`,
          [companyId, roleCode, moduleId]
        );
        continue;
      }
      await client.query(
        `INSERT INTO menu_permissions (company_id, role_code, module_id, access_level, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (company_id, role_code, module_id)
         DO UPDATE SET access_level = EXCLUDED.access_level,
                       updated_by   = EXCLUDED.updated_by,
                       updated_at   = NOW()`,
        [companyId, roleCode, moduleId, level, updatedBy]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Per-user menu overrides ───────────────────────────────────────────────────
/**
 * Returns the per-user menu access overrides as { [module_id]: level }.
 */
export async function getUserMenuOverrides(companyId, userId) {
  if (companyId == null || userId == null) return {};
  const { rows } = await pool.query(
    `SELECT module_id, access_level
       FROM user_menu_permissions
      WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId]
  );
  return Object.fromEntries(rows.map(r => [r.module_id, r.access_level]));
}

/**
 * Replaces the full per-user override set. Entries with access_level not in
 * (hidden|view|edit) — e.g. 'inherit'/'default' — are removed so the section
 * falls back to the role-level setting.
 */
export async function setUserMenuOverrides(companyId, userId, entries, updatedBy = null) {
  if (companyId == null || userId == null) throw new Error('companyId and userId are required');
  const valid = new Set(['hidden', 'view', 'edit']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      const moduleId = String(e?.module_id ?? '').trim();
      if (!moduleId) continue;
      const level = String(e?.access_level ?? '').toLowerCase();
      if (!valid.has(level)) {
        await client.query(
          `DELETE FROM user_menu_permissions
            WHERE company_id = $1 AND user_id = $2 AND module_id = $3`,
          [companyId, userId, moduleId]
        );
        continue;
      }
      await client.query(
        `INSERT INTO user_menu_permissions (company_id, user_id, module_id, access_level, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (company_id, user_id, module_id)
         DO UPDATE SET access_level = EXCLUDED.access_level,
                       updated_by   = EXCLUDED.updated_by,
                       updated_at   = NOW()`,
        [companyId, userId, moduleId, level, updatedBy]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Effective menu overrides for a logged-in user: role-level defaults with any
 * per-user overrides applied on top. Used by GET /auth/permissions so the live
 * sidebar/route gate reflects both layers.
 */
export async function getEffectiveMenuOverrides(companyId, roleCode, userId) {
  const [roleOv, userOv] = await Promise.all([
    getMenuOverrides(companyId, roleCode),
    getUserMenuOverrides(companyId, userId),
  ]);
  return { ...roleOv, ...userOv };
}

// ── Batch check (used by middleware) ─────────────────────────────────────────
/**
 * Fast single-query check for one module+action.
 * Returns true = allow, false = deny, null = no-config (passthrough).
 */
export async function checkAccess(userId, roleCode, module, action) {
  const allowed = ['can_view','can_add','can_edit','can_delete','can_approve','can_export'];
  if (!allowed.includes(action)) return false;

  const perm = await getModulePermissions(userId, roleCode, module);
  if (perm === null) return null;
  return !!perm[action];
}
