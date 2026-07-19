import * as authService from "./auth.service.js";
import { getMergedPermissions, getUserScope, getEffectiveMenuOverrides } from "../services/PermissionService.js";
import { rolesOf } from "../middlewares/auth.middleware.js";
import { logAudit } from "../services/AuditService.js";
import pool from "../config/db.js";
import bcrypt from "bcryptjs";
import { companyOf } from '../shared/scope.js';

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(userId, event, req, meta = {}) {
  try {
    const pool = (await import("../config/db.js")).default;
    const ip   = (req.headers['x-forwarded-for'] || req.ip || null)?.split(',')[0]?.trim() ?? null;
    await pool.query(
      `INSERT INTO auth_audit_log (user_id, event, ip, metadata) VALUES ($1,$2,$3,$4)`,
      [userId, event, ip, Object.keys(meta).length ? JSON.stringify(meta) : null]
    );
  } catch { /* audit must never break the main flow */ }
}

// ── Security event helper — writes to security_events for the Security Center ─
const SEV_MAP = {
  login_success:          'low',
  login_failed:           'medium',
  login_locked:           'high',
  logout:                 'low',
  password_changed:       'low',
  password_reset_complete:'low',
  login_google:           'low',
};

function logSecEvent(userId, event_type, req, detail) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || null)?.split(',')[0]?.trim() ?? null;
  pool.query(
    `INSERT INTO security_events (event_type, severity, user_id, ip_address, user_agent, path, detail, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [
      event_type,
      SEV_MAP[event_type] ?? 'low',
      userId ?? null,
      ip,
      req.headers['user-agent'] ?? null,
      req.path ?? null,
      detail ? JSON.stringify(detail) : null,
    ]
  ).catch(() => {});
}

export const register = async (req, res) => {
  try {
    const user = await authService.registerUser(
      req.body.name,
      req.body.email,
      req.body.password,
      req.body.role,
      req.body.department
    );
    res.json({ message: "User created successfully", user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const login = async (req, res) => {
  try {
    const data = await authService.loginUser(
      req.body.email,
      req.body.password,
      !!req.body.rememberMe
    );
    await audit(data.user.id, 'login_success', req, { rememberMe: !!req.body.rememberMe });
    logSecEvent(data.user.id, 'login_success', req);
    // Also write to main audit_logs so the Audit Logs page shows LOGIN events
    logAudit({
      userId     : data.user.id,
      company_id : data.user.company_id ?? null,
      module     : 'system',
      action     : 'LOGIN',
      recordType : 'user_session',
      req,
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    if (err.code === "ACCOUNT_LOCKED") {
      await audit(err.userId ?? null, 'login_locked', req, { email: req.body.email });
      logSecEvent(err.userId ?? null, 'login_locked', req, { email: req.body.email });
      return res.status(423).json({
        error:        err.message,
        locked_until: err.locked_until,
        code:         "ACCOUNT_LOCKED",
      });
    }
    await audit(null, 'login_failed', req, { email: req.body.email });
    logSecEvent(null, 'login_failed', req, { email: req.body.email });
    const status = err.message.includes("inactive") ? 403 : 401;
    res.status(status).json({ error: err.message });
  }
};

export const refresh = async (req, res) => {
  try {
    const data = await authService.refreshSession(req.user.userId);
    res.json(data);
  } catch (err) {
    console.error(err);
    const status = err.message.includes("inactive") ? 403 : 401;
    res.status(status).json({ error: err.message });
  }
};

export const logout = async (req, res) => {
  try {
    await authService.logoutUser(req.user.userId);
    await audit(req.user.userId, 'logout', req);
    logSecEvent(req.user.userId, 'logout', req);
    logAudit({
      userId     : req.user.userId ?? req.user.id ?? null,
      company_id : req.scope?.company_id ?? null,
      module     : 'system',
      action     : 'LOGOUT',
      recordType : 'user_session',
      req,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    // Even on error, treat logout as successful from the client's perspective
    res.json({ success: true });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const result = await authService.requestPasswordReset(req.body.email);
    await audit(null, 'password_reset_requested', req, { email: req.body.email });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const verifyOtp = async (req, res) => {
  try {
    const result = await authService.verifyResetOtp(req.body.email, req.body.otp);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const result = await authService.resetPassword(
      req.body.email,
      req.body.otp,
      req.body.password
    );
    await audit(null, 'password_reset_complete', req, { email: req.body.email });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const googleAuth = async (req, res) => {
  try {
    const { code, code_verifier, redirect_uri } = req.body;
    const data = await authService.loginWithGoogle(code, code_verifier, redirect_uri);
    await audit(data.user.id, 'login_google', req);
    logSecEvent(data.user.id, 'login_google', req);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: err.message });
  }
};

export const getPermissions = async (req, res) => {
  try {
    const { userId, role } = req.user;
    const companyId = req.scope?.company_id ?? companyOf(req);
    // Every role held — permissions and menu overlays union across all of them,
    // not just the primary role. verifyToken populates this from user_roles.
    const roles = rolesOf(req);

    const [mergedPermissions, scope, legacy, menuOverrides] = await Promise.all([
      getMergedPermissions(userId, roles),
      getUserScope(userId),
      authService.getUserPermissions(userId),
      getEffectiveMenuOverrides(companyId, roles, userId),
    ]);

    // getMergedPermissions returns a { module: {...} } map; the frontend auth
    // context expects an array (Array.isArray gate + .find(p => p.module)).
    const permissions = Object.values(mergedPermissions);

    res.json({ role, roles, permissions, scope, legacy, menuOverrides });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getProfile = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, department, last_login, preferences, employee_id
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { name, preferences } = req.body;
    const setClauses = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      setClauses.push(`name = $${idx++}`);
      values.push(name.trim());
    }
    if (preferences !== undefined) {
      setClauses.push(`preferences = COALESCE(preferences, '{}'::jsonb) || $${idx++}::jsonb`);
      values.push(JSON.stringify(preferences));
    }

    if (setClauses.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.user.userId);
    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} RETURNING id, name, email, role, department, preferences`,
      values
    );
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// First-login password set — no current password required, but ONLY permitted
// while the account is flagged must_change_password (i.e. still on the shared
// default). This keeps the no-current-password path from being usable to reset
// an ordinary user's password from a hijacked session.
export const setInitialPassword = async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password) return res.status(400).json({ error: 'new_password is required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const { rows } = await pool.query(
      `SELECT must_change_password FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    if (rows[0].must_change_password !== true) {
      return res.status(403).json({ error: 'Password change not required. Use the standard change-password flow.' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = false, failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $2`,
      [hash, req.user.userId]
    );

    await audit(req.user.userId, 'password_changed', req, { forced: true });
    logSecEvent(req.user.userId, 'password_changed', req, { forced: true });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getPreferences = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT preferences FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ preferences: rows[0].preferences ?? {} });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const savePreferences = async (req, res) => {
  try {
    const prefs = req.body;
    if (typeof prefs !== 'object' || Array.isArray(prefs) || prefs === null) {
      return res.status(400).json({ error: 'preferences must be a JSON object' });
    }
    const { rows } = await pool.query(
      `UPDATE users SET preferences = $1::jsonb, updated_at = NOW()
       WHERE id = $2 RETURNING preferences`,
      [JSON.stringify(prefs), req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ preferences: rows[0].preferences });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const { rows } = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW(), failed_attempts = 0, locked_until = NULL, must_change_password = false WHERE id = $2`,
      [hash, req.user.userId]
    );

    await audit(req.user.userId, 'password_changed', req);
    logSecEvent(req.user.userId, 'password_changed', req);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
