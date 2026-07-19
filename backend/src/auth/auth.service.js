import pool from "../config/db.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendPasswordResetOTP } from "../utils/mailer.js";
import { syncPrimaryRole } from "../services/userRoles.js";

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error("JWT_SECRET environment variable is not set. Add it to your .env file.");
}


// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_FAILED = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Private helpers ───────────────────────────────────────────────────────────
// `role` stays in the payload as the primary role — dropping it would break
// every legacy consumer that reads req.user.role. `roles` is the full set;
// verifyToken re-reads it from user_roles on each request, so this claim is
// only a fallback for when that lookup can't run.
function makeToken(user, rememberMe, scope = {}) {
  return jwt.sign(
    {
      userId:      user.id,
      email:       user.email,
      role:        user.role,
      roles:       user.roles?.length ? user.roles : [user.role].filter(Boolean),
      company_id:  scope.company_id  ?? null,
      branch_id:   scope.branch_id   ?? null,
      employee_id: user.employee_id  ?? null,
    },
    SECRET,
    { expiresIn: rememberMe ? "30d" : "8h" }
  );
}

// Every role code the user holds, primary first. Falls back to users.role if
// the junction table has no rows for them (account that predates the backfill).
async function resolveRoles(user) {
  try {
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS code
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1
        ORDER BY ur.is_primary DESC, r.code`,
      [user.id]
    );
    if (rows.length) return rows.map(r => r.code);
  } catch (e) {
    console.warn('[auth] resolveRoles failed, falling back to users.role:', e.message);
  }
  return [String(user.role || '').toLowerCase()].filter(Boolean);
}

function userPayload(user, prevLastLogin) {
  return {
    id:          user.id,
    name:        user.name,
    email:       user.email,
    role:        user.role,
    roles:       user.roles?.length ? user.roles : [user.role].filter(Boolean),
    department:  user.department,
    last_login:  prevLastLogin ?? null,
    employee_id: user.employee_id ?? null,
    must_change_password: user.must_change_password ?? false,
  };
}

// Prefers the persisted users.employee_id link (set by addEmployee provisioning);
// only falls back to matching on company_email for legacy accounts that predate
// that link, since a user's login email doesn't always match employees.company_email.
async function resolveEmployeeId(user) {
  if (user.employee_id != null) return user.employee_id;
  const { rows } = await pool.query(
    `SELECT id FROM employees WHERE company_email = $1 AND deleted_at IS NULL LIMIT 1`,
    [user.email]
  );
  return rows[0]?.id ?? null;
}

function lockedError(lockedUntil) {
  const mins = Math.ceil((new Date(lockedUntil) - Date.now()) / 60000);
  const msg  = `Account locked. Try again in ${mins} minute${mins !== 1 ? "s" : ""}.`;
  return Object.assign(new Error(msg), { code: "ACCOUNT_LOCKED", locked_until: lockedUntil });
}

// ── Register ──────────────────────────────────────────────────────────────────
// Self-registration is restricted to safe roles only. Privileged roles
// (admin, super_admin) must be granted by an existing admin via the admin panel.
const SELF_REGISTER_ALLOWED_ROLES = new Set(['employee', 'manager', 'hr']);

export const registerUser = async (name, email, password, role = "employee", department = null) => {
  const safeRole = SELF_REGISTER_ALLOWED_ROLES.has(String(role).toLowerCase())
    ? String(role).toLowerCase()
    : 'employee';

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length) throw new Error("User already exists");

  const hash   = await bcrypt.hash(password, 10);
  const result = await pool.query(
    "INSERT INTO users (name, email, password_hash, role, department, is_active) VALUES ($1,$2,$3,$4,$5,true) RETURNING id,name,email,role,department",
    [name, email, hash, safeRole, department]
  );
  // users.role is the primary-role mirror; user_roles is what actually grants
  // permissions, so a self-registered account needs its junction row too.
  await syncPrimaryRole(result.rows[0].id, safeRole, null, null);
  return result.rows[0];
};

// Constant used to equalize response timing when the email doesn't exist, so an
// attacker can't distinguish "unknown email" from "wrong password" by latency.
// It's a well-formed bcrypt hash; comparison always fails but costs the same as a real one.
const DUMMY_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const GENERIC_LOGIN_ERROR = "Invalid email or password";

// ── Login (password) ──────────────────────────────────────────────────────────
export const loginUser = async (email, password, rememberMe = false) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

  // User enumeration guard: for an unknown email, still run a bcrypt comparison
  // (against a dummy hash) and return the same generic error as a wrong password.
  if (!rows.length) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw new Error(GENERIC_LOGIN_ERROR);
  }

  const user = rows[0];

  if (!user.is_active) throw new Error("Account is inactive");

  // Check if account is still locked from a previous burst
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw lockedError(user.locked_until);
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    const attempts   = (user.failed_attempts ?? 0) + 1;
    const shouldLock = attempts >= MAX_FAILED;
    const lockUntil  = shouldLock ? new Date(Date.now() + LOCKOUT_MS) : null;

    await pool.query(
      "UPDATE users SET failed_attempts = $1, locked_until = $2, updated_at = NOW() WHERE id = $3",
      [shouldLock ? 0 : attempts, lockUntil, user.id]
    );

    if (shouldLock) throw lockedError(lockUntil);

    // Generic message (no remaining-attempts count) so a valid email can't be
    // distinguished from an invalid one.
    throw new Error(GENERIC_LOGIN_ERROR);
  }

  // Success — reset counters and stamp last_login (return the previous value)
  const prevLastLogin = user.last_login;
  await pool.query(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = NOW(), updated_at = NOW() WHERE id = $1",
    [user.id]
  );

  const { rows: scopeRows } = await pool.query(
    `SELECT company_id, branch_id FROM user_scope WHERE user_id = $1 AND is_primary = true LIMIT 1`,
    [user.id]
  );
  const scope       = scopeRows[0] ?? {};
  const employee_id = await resolveEmployeeId(user);
  const roles       = await resolveRoles(user);
  const userExt     = { ...user, employee_id, roles };
  return { token: makeToken(userExt, rememberMe, scope), user: userPayload(userExt, prevLastLogin) };
};

export const refreshSession = async (userId) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  if (!rows.length) throw new Error("User not found");

  const user = rows[0];
  if (!user.is_active) throw new Error("Account is inactive");

  const { rows: scopeRows } = await pool.query(
    `SELECT company_id, branch_id FROM user_scope WHERE user_id = $1 AND is_primary = true LIMIT 1`,
    [user.id]
  );
  const scope       = scopeRows[0] ?? {};
  const employee_id = await resolveEmployeeId(user);
  const roles       = await resolveRoles(user);
  const userExt     = { ...user, employee_id, roles };
  return { token: makeToken(userExt, false, scope), user: userPayload(userExt, user.last_login) };
};

export const logoutUser = async (userId) => {
  // Stamp logout_at so any tokens issued before this timestamp are revoked
  await pool.query(
    "UPDATE users SET logout_at = NOW(), updated_at = NOW() WHERE id = $1",
    [userId]
  );
};

export const getUserPermissions = async (userId) => {
  const { rows } = await pool.query(
    "SELECT module, can_view, can_add, can_edit, can_delete, can_approve, can_export FROM permissions WHERE user_id = $1",
    [userId]
  );
  return rows;
};

// ── Password reset OTP ────────────────────────────────────────────────────────
export const requestPasswordReset = async (email) => {
  const { rows } = await pool.query(
    "SELECT id FROM users WHERE email = $1 AND is_active = true",
    [email]
  );
  // Always return success to prevent email enumeration
  if (!rows.length) return { sent: true };

  const userId    = rows[0].id;
  const otp       = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // Invalidate any previous pending OTPs
  await pool.query(
    "UPDATE password_reset_otps SET used = true WHERE user_id = $1 AND used = false",
    [userId]
  );
  await pool.query(
    "INSERT INTO password_reset_otps (user_id, otp, expires_at) VALUES ($1,$2,$3)",
    [userId, otp, expiresAt]
  );

  // Send OTP via email. In dev without SMTP, mailer logs to console and continues.
  // In production with SMTP unconfigured, this throws and the caller returns 500.
  await sendPasswordResetOTP(email, otp);

  return {
    sent: true,
    // Expose OTP only outside production so devs can test without SMTP
    ...(process.env.NODE_ENV !== "production" && { dev_otp: otp }),
  };
};

export const verifyResetOtp = async (email, otp) => {
  const { rows } = await pool.query(
    `SELECT o.id
       FROM password_reset_otps o
       JOIN users u ON u.id = o.user_id
      WHERE u.email = $1 AND o.otp = $2 AND o.used = false AND o.expires_at > NOW()
      ORDER BY o.created_at DESC LIMIT 1`,
    [email, otp]
  );
  if (!rows.length) throw new Error("Invalid or expired OTP.");
  return { valid: true };
};

export const resetPassword = async (email, otp, newPassword) => {
  const { rows } = await pool.query(
    `SELECT o.id AS otp_id, u.id AS user_id
       FROM password_reset_otps o
       JOIN users u ON u.id = o.user_id
      WHERE u.email = $1 AND o.otp = $2 AND o.used = false AND o.expires_at > NOW()
      ORDER BY o.created_at DESC LIMIT 1`,
    [email, otp]
  );
  if (!rows.length) throw new Error("Invalid or expired OTP.");

  const { otp_id, user_id } = rows[0];
  const hash = await bcrypt.hash(newPassword, 10);

  await pool.query(
    "UPDATE users SET password_hash = $1, failed_attempts = 0, locked_until = NULL, must_change_password = false, updated_at = NOW() WHERE id = $2",
    [hash, user_id]
  );
  await pool.query("UPDATE password_reset_otps SET used = true WHERE id = $1", [otp_id]);
  return { success: true };
};

// ── Google OAuth2 PKCE ────────────────────────────────────────────────────────
// The frontend sends the authorization code + code_verifier; this endpoint
// exchanges them with Google server-side so GOOGLE_CLIENT_SECRET never leaves
// the server.
export const loginWithGoogle = async (code, codeVerifier, redirectUri) => {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({}));
    throw new Error(body.error_description || "Failed to exchange Google authorization code.");
  }

  const { id_token } = await tokenRes.json();

  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
  const payload = await infoRes.json();

  if (payload.error)            throw new Error("Google token verification failed.");
  if (payload.aud !== clientId) throw new Error("Token audience mismatch.");
  if (!payload.email_verified)  throw new Error("Google account email is not verified.");

  const { rows } = await pool.query(
    "SELECT * FROM users WHERE google_id = $1 OR email = $2 LIMIT 1",
    [payload.sub, payload.email]
  );

  if (!rows.length) {
    throw new Error("No Pulse account is linked to this Google account. Contact your administrator.");
  }

  const user = rows[0];
  if (!user.is_active) throw new Error("Account is inactive.");

  // Auto-link google_id on the user's first Google sign-in
  if (!user.google_id) {
    await pool.query(
      "UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2",
      [payload.sub, user.id]
    );
  }

  const prevLastLogin = user.last_login;
  await pool.query(
    "UPDATE users SET last_login = NOW(), failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1",
    [user.id]
  );

  const { rows: scopeRows } = await pool.query(
    `SELECT company_id, branch_id FROM user_scope WHERE user_id = $1 AND is_primary = true LIMIT 1`,
    [user.id]
  );
  const scope       = scopeRows[0] ?? {};
  const employee_id = await resolveEmployeeId(user);
  const userExt     = { ...user, employee_id };
  return { token: makeToken(userExt, false, scope), user: userPayload(userExt, prevLastLogin) };
};
