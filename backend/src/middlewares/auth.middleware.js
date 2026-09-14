import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is not set. Add it to your .env file.");
}
if (process.env.NODE_ENV === "production" && JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters in production.");
}

// ── Role helpers ───────────────────────────────────────────────────────────────
// Roles are many-to-many (user_roles). `req.user.roles` is the authoritative
// list; `req.user.role` is the primary role, kept for legacy callers and for
// tokens minted before the junction table existed.
//
// Everything role-gated MUST go through rolesOf() rather than reading
// req.user.role directly, or a user's non-primary roles are silently ignored.
export const rolesOf = (req) => {
  const list = Array.isArray(req?.user?.roles) ? req.user.roles : null;
  if (list?.length) return list.map(r => String(r).toLowerCase());
  const single = String(req?.user?.role || '').toLowerCase();
  return single ? [single] : [];
};

export const hasRole = (req, ...codes) => {
  const want = codes.flat().map(c => String(c).toLowerCase());
  return rolesOf(req).some(r => want.includes(r));
};

const SUPER_CODES = ['super_admin', 'superadmin'];
const isSuper = (roles) => roles.some(r => SUPER_CODES.includes(r));

// ── Primary token middleware ───────────────────────────────────────────────────
// One DB roundtrip per request: active-check + logout_at revocation + scope + roles.
// Falls back to JWT-embedded scope/roles on transient DB errors so the app stays up.
export const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'WARN', event: 'auth_missing_header', path: req.path, ip: req.ip || req.headers['x-forwarded-for'] }));
    return res.status(401).json({ error: "Session expired" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // Single DB query: is_active + revocation (logout_at) + scope for old tokens.
    // Using LEFT JOIN means one row is always returned (or zero if user deleted).
    try {
      const pool = (await import("../config/db.js")).default;
      const { rows } = await pool.query(
        `SELECT u.is_active, u.logout_at, us.company_id, us.branch_id,
                (SELECT ARRAY_AGG(LOWER(r.code) ORDER BY ur.is_primary DESC, r.code)
                   FROM user_roles ur
                   JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id) AS roles
           FROM users u
           LEFT JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
          WHERE u.id = $1
          LIMIT 1`,
        [decoded.userId]
      );

      if (!rows.length || !rows[0].is_active) {
        console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'WARN', event: 'auth_inactive', userId: decoded.userId, path: req.path }));
        return res.status(401).json({ error: "Account inactive" });
      }

      // Token issued before explicit logout → treat as revoked
      if (rows[0].logout_at && decoded.iat * 1000 < new Date(rows[0].logout_at).getTime()) {
        console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'WARN', event: 'auth_revoked', userId: decoded.userId, path: req.path }));
        return res.status(401).json({ error: "Session expired" });
      }

      // Roles: the DB is authoritative, so a grant/revoke takes effect on the
      // next request instead of waiting for the token to be re-minted. Only
      // fall back to the token's own claim if the user has no user_roles rows
      // at all (pre-migration account that somehow escaped the backfill).
      req.user.roles = rows[0].roles?.length
        ? rows[0].roles
        : rolesOf(req);

      // Scope: prefer JWT fast-path (new tokens); fall back to DB row (old tokens)
      if (decoded.company_id != null) {
        req.scope = { company_id: decoded.company_id, branch_id: decoded.branch_id ?? null };
      } else if (rows[0].company_id != null) {
        req.scope = { company_id: rows[0].company_id, branch_id: rows[0].branch_id ?? null };
      } else if (isSuper(req.user.roles)) {
        // Super admin with no company assignment gets a global scope (null company = all companies)
        req.scope = { company_id: null, branch_id: null, isGlobal: true };
      } else {
        req.scope = null;
      }
    } catch {
      // DB transient error — don't block the request; use JWT scope/roles fast-path
      req.user.roles = rolesOf(req);
      if (decoded.company_id != null) {
        req.scope = { company_id: decoded.company_id, branch_id: decoded.branch_id ?? null };
      } else if (isSuper(req.user.roles)) {
        req.scope = { company_id: null, branch_id: null, isGlobal: true };
      } else {
        req.scope = null;
      }
    }

    next();
  } catch (err) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'WARN', event: 'auth_failure', reason: err.name, path: req.path, ip: req.ip || req.headers['x-forwarded-for'] }));
    return res.status(401).json({ error: "Session expired" });
  }
};

// ── Refresh-only token middleware ─────────────────────────────────────────────
// Same as verifyToken but ignores expiration. Used exclusively for POST /auth/refresh
// so users can renew an expired token without being kicked to login immediately.
// Grace window: 7 days after expiry. Revoked tokens (explicit logout) are still rejected.
export const verifyTokenLax = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Session expired" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });

    // Enforce a 7-day grace window after expiry — don't allow indefinite refresh
    const nowSec = Math.floor(Date.now() / 1000);
    if (decoded.exp && nowSec - decoded.exp > 7 * 24 * 60 * 60) {
      return res.status(401).json({ error: "Session too old to refresh. Please log in again." });
    }

    // Revocation check — a token used to refresh must not have been logged out
    try {
      const pool = (await import("../config/db.js")).default;
      const { rows } = await pool.query(
        'SELECT is_active, logout_at FROM users WHERE id = $1',
        [decoded.userId]
      );
      if (!rows.length || !rows[0].is_active) {
        return res.status(403).json({ error: "Account inactive" });
      }
      if (rows[0].logout_at && decoded.iat * 1000 < new Date(rows[0].logout_at).getTime()) {
        return res.status(401).json({ error: "Session expired" });
      }
    } catch {
      // DB error — allow through; refreshSession will re-validate is_active
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// Passes if ANY of the user's roles is in the allowed list. A member holding
// both `employee` and `project_manager` reaches project_manager routes — under
// the old single-string check their non-primary role was invisible.
export const allowRoles = (...roles) => {
  const allowed = roles.flat().map(role => String(role).toLowerCase());
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const held = rolesOf(req);
    if (!held.some(r => allowed.includes(r)))
      return res.status(403).json({ error: "Access denied" });

    next();
  };
};

// Legacy user-level-only check — kept so existing routes remain unbroken
export const checkPermission = (module, action) => {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    try {
      const pool = (await import("../config/db.js")).default;
      const result = await pool.query(
        `SELECT ${action} FROM permissions WHERE user_id = $1 AND module = $2`,
        [req.user.userId, module]
      );
      if (result.rows.length === 0 || !result.rows[0][action]) {
        return res.status(403).json({ error: "Access denied" });
      }
      next();
    } catch (err) {
      return res.status(500).json({ error: "Permission check failed" });
    }
  };
};

// ── Phase 1: new platform-layer middleware ────────────────────────────────────

// Shorthand aliases → DB column names
const ACTION_MAP = {
  view:    'can_view',
  add:     'can_add',
  edit:    'can_edit',
  delete:  'can_delete',
  approve: 'can_approve',
  export:  'can_export',
};
const VALID_ACTIONS = new Set([
  'can_view','can_add','can_edit','can_delete','can_approve','can_export',
]);
const MODULE_ALIASES = {
  leave: ['leave', 'leaves'],
  leaves: ['leaves', 'leave'],
};

/**
 * requirePermission(module, action)
 *
 * Priority: user-level override > role-level default > passthrough.
 * Per-request cache (req._permCache) avoids redundant DB hits.
 *
 * Roles are many-to-many, so the role-level default is the UNION of every role
 * the user holds: the most permissive grant wins (BOOL_OR). Someone who is both
 * `employee` and `sales_manager` gets sales_manager's rights on crm, not the
 * intersection — which would be the empty set and would lock them out.
 */
/**
 * Resolve the caller's effective permission row for a module, or null when the
 * matrix has no entry for it.
 *
 * Extracted from requirePermission so callers that need to COMBINE the matrix
 * with something else can consult it without re-implementing the user-override
 * -> role-union precedence (procurement does this: several of its routes are
 * legitimately reachable by roles that hold no procurement row at all, such as
 * finance on three-way-match approval). It performs the lookup and nothing
 * else — deciding what a null or a false means is the caller's job.
 */
export const permissionFor = async (req, module) => {
  if (!req.user) return null;
  const pool = (await import("../config/db.js")).default;
  const { userId } = req.user;
  const heldRoles  = rolesOf(req);
  const moduleNames = MODULE_ALIASES[module] || [module];

  if (!req._permCache) req._permCache = new Map();
  const cacheKey = `${userId}:${moduleNames.join('|')}`;
  if (req._permCache.has(cacheKey)) return req._permCache.get(cacheKey);

  const perm = await (async () => {
    const { rows: ur } = await pool.query(
      `SELECT can_view, can_add, can_edit, can_delete, can_approve, can_export
         FROM permissions
        WHERE user_id = $1 AND module = ANY($2)
        ORDER BY CASE WHEN module = $3 THEN 0 ELSE 1 END
        LIMIT 1`,
      [userId, moduleNames, module]
    );
    if (ur.length) return { source: 'user', ...ur[0] };
    if (!heldRoles.length) return null;
    // Pick the best-matching module name first (exact over alias), then
    // OR that module's flags across every role the user holds.
    const { rows: rr } = await pool.query(
      `WITH picked AS (
         SELECT rp.module
           FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
          WHERE LOWER(r.code) = ANY($1) AND rp.module = ANY($2)
          ORDER BY CASE WHEN rp.module = $3 THEN 0 ELSE 1 END
          LIMIT 1
       )
       SELECT BOOL_OR(rp.can_view)    AS can_view,
              BOOL_OR(rp.can_add)     AS can_add,
              BOOL_OR(rp.can_edit)    AS can_edit,
              BOOL_OR(rp.can_delete)  AS can_delete,
              BOOL_OR(rp.can_approve) AS can_approve,
              BOOL_OR(rp.can_export)  AS can_export
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE LOWER(r.code) = ANY($1)
          AND rp.module = (SELECT module FROM picked)
       HAVING COUNT(*) > 0`,
      [heldRoles, moduleNames, module]
    );
    return rr.length ? { source: 'role', ...rr[0] } : null;
  })();

  req._permCache.set(cacheKey, perm);
  return perm;
};

/** Map a shorthand action ('add') to its column ('can_add'); null if unknown. */
export const permissionColumn = (action) => {
  const col = ACTION_MAP[action] ?? action;
  return VALID_ACTIONS.has(col) ? col : null;
};

export const requirePermission = (module, action) => async (req, res, next) => {
  const col = ACTION_MAP[action] ?? action;
  if (!VALID_ACTIONS.has(col))
    return res.status(400).json({ error: `Unknown permission action: ${action}` });

  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const perm = await permissionFor(req, module);

    // No permission row configured for this (module, role). FAIL CLOSED.
    //
    // This used to fail OPEN unless PERMISSION_STRICT=true was set — a migration
    // aid from when the matrix was incomplete. The cost was that five modules
    // (maintenance, iot, rd, compliance, assets) shipped with no rows at all and
    // were therefore reachable by every authenticated user, which is how an
    // `employee` account came to be able to edit maintenance assets. See
    // SECURITY_AUDIT_2026-07-18.md H-2.
    //
    // The matrix has since been completed (migration 20260719000001) so the
    // default is now safe. Deliberately inverted rather than left to an env var:
    // an unset variable on a new deploy silently restored the vulnerability, and
    // "secure only if correctly configured" is how this happened the first time.
    //
    // PERMISSION_FAIL_OPEN=true is an emergency escape hatch — if a legitimately
    // unseeded module starts denying in production, it buys time to seed the row.
    // It is loud on purpose. The fix is always to add the row, never to leave
    // this set.
    if (perm === null) {
      if (String(process.env.PERMISSION_FAIL_OPEN).toLowerCase() === 'true') {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(), level: 'WARN',
          event: 'permission_fail_open',
          module, action: col, userId: req.user?.userId, path: req.path,
          message: 'PERMISSION_FAIL_OPEN is set — request allowed with NO permission row. Seed the matrix and unset this.',
        }));
        return next();
      }
      return res.status(403).json({
        error:   'Forbidden',
        code:    'PERMISSION_NOT_CONFIGURED',
        module,
        action:  col,
        message: 'No permission is configured for this action.',
      });
    }

    if (!perm[col]) {
      return res.status(403).json({
        error:   'Forbidden',
        code:    'PERMISSION_DENIED',
        module,
        action:  col,
        message: 'You do not have permission to perform this action.',
      });
    }
    next();
  } catch (err) {
    console.error("[requirePermission]", err.message);
    return res.status(500).json({ error: "Permission check failed" });
  }
};

/**
 * enforceScope()
 *
 * Attaches the user's primary company_id / branch_id to req.scope.
 * Fast-path: verifyToken already attached scope — this is a no-op in that case.
 */
export const enforceScope = () => async (req, res, next) => {
  if (req.scope !== undefined) return next();
  if (!req.user) { req.scope = null; return next(); }
  try {
    const pool = (await import("../config/db.js")).default;
    const { rows } = await pool.query(
      `SELECT company_id, branch_id
         FROM user_scope
        WHERE user_id = $1 AND is_primary = true
        LIMIT 1`,
      [req.user.userId]
    );
    req.scope = rows.length
      ? { company_id: rows[0].company_id, branch_id: rows[0].branch_id }
      : null;
    next();
  } catch {
    req.scope = null;
    next();
  }
};

/**
 * applyFieldPermissions(module)
 *
 * Field-level permissions, in both directions: invisible fields are stripped
 * from the RESPONSE, and non-editable fields are stripped from the REQUEST BODY
 * before a handler can write them.
 *
 * ⚠ This existed and was mounted NOWHERE. `field_permissions` held ten rules —
 * an `employee` may not see aadhaar_number, pan_number, bank details, basic
 * salary, gross or net_pay — and none of them had ever been enforced, because
 * nothing in server.js called this. The rules were correct; the wiring was
 * missing (2026-09-04).
 *
 * MULTI-ROLE UNION, matching requirePermission: a field is restricted only when
 * EVERY role the user holds explicitly restricts it. A role with no rule has no
 * opinion, which defaults to permitted — so holding one unrestricted role is
 * enough to see the field. That is what stops a manager who also holds
 * `employee` from losing access to their team's data.
 *
 * FAIL-OPEN ON ERROR IS DELIBERATE HERE and narrow: this middleware runs after
 * requirePermission, so the caller is already authorised for the module. A
 * database blip must not turn an authorised read into a 500, and the worst case
 * is that a field the caller is already entitled to reach is not masked. The
 * failure is logged rather than swallowed.
 */
export const applyFieldPermissions = (module) => async (req, res, next) => {
  try {
    const pool = (await import("../config/db.js")).default;
    const heldRoles = rolesOf(req);
    if (!heldRoles.length) return next();

    const { rows } = await pool.query(
      `SELECT fp.field_name,
              BOOL_OR(fp.is_visible)  AS any_visible,
              BOOL_OR(fp.is_editable) AS any_editable,
              COUNT(DISTINCT LOWER(r.code))::int AS rules_for_held_roles
         FROM field_permissions fp
         JOIN roles r ON r.id = fp.role_id
        WHERE LOWER(r.code) = ANY($1) AND fp.module = $2
        GROUP BY fp.field_name`,
      [heldRoles, module]
    );

    // Restricted only when every held role has a rule AND none of them allows it.
    const covered = (r) => r.rules_for_held_roles === heldRoles.length;
    const hidden   = rows.filter(r => covered(r) && r.any_visible  === false).map(r => r.field_name);
    const readOnly = rows.filter(r => covered(r) && r.any_editable === false).map(r => r.field_name);

    if (readOnly.length && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      // Stripped, not rejected: a form that posts the whole record back should
      // still save the fields the caller may change. Rejecting the request would
      // make an ordinary edit fail because of a field the user never touched.
      const blocked = readOnly.filter(f => Object.prototype.hasOwnProperty.call(req.body, f));
      for (const f of blocked) delete req.body[f];
      if (blocked.length) {
        req._fieldsStripped = blocked;
        console.warn(JSON.stringify({
          ts: new Date().toISOString(), level: "WARN", event: "field_permission_write_blocked",
          module, userId: req.user?.userId, fields: blocked, path: req.originalUrl,
        }));
      }
    }

    if (hidden.length) {
      const origJson = res.json.bind(res);
      res.json = (data) => origJson(_maskFields(data, hidden));
    }
    next();
  } catch (err) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: "WARN", event: "field_permissions_unavailable",
      module, message: err.message,
    }));
    next();
  }
};

/**
 * Strip `hidden` keys from a payload of any shape.
 *
 * The first version only walked arrays and top-level objects, so a field hidden
 * inside `{ data: [...] }`, `{ rows: [...] }` or a nested `employee: {...}`
 * survived untouched — and most of this API answers in exactly those shapes.
 * Depth-limited because an audit payload can hold a deeply nested snapshot and a
 * masking pass is not worth unbounded recursion.
 */
function _maskFields(data, hidden, depth = 0) {
  if (depth > 6 || data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(item => _maskFields(item, hidden, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (hidden.includes(k)) continue;
    out[k] = _maskFields(v, hidden, depth + 1);
  }
  return out;
}
