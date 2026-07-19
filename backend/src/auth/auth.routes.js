import express from "express";
import {
  login,
  refresh,
  logout,
  register,
  getPermissions,
  forgotPassword,
  verifyOtp,
  resetPassword,
  googleAuth,
  getProfile,
  updateProfile,
  changePassword,
  setInitialPassword,
  getPreferences,
  savePreferences,
} from "./auth.controller.js";
import { verifyToken, verifyTokenLax, allowRoles } from "../middlewares/auth.middleware.js";
import { dbRateLimit } from "../middlewares/rateLimit.js";
import pool from "../config/db.js";

// ── Schema bootstrap ──────────────────────────────────────────────────────────
// Ensures auth tables exist on first startup without a separate migration step.
(async () => {
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS logout_at TIMESTAMPTZ;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_audit_log (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INT REFERENCES users(id) ON DELETE SET NULL,
        event       VARCHAR(32) NOT NULL,
        ip          VARCHAR(64),
        metadata    JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_auth_audit_user
        ON auth_audit_log(user_id, created_at DESC);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_rate_limit (
        ip           VARCHAR(64) PRIMARY KEY,
        count        INT         NOT NULL DEFAULT 0,
        window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } catch (err) {
    console.warn("[auth] Schema bootstrap warning:", err.message);
  }
})();

// ── DB-backed rate limiter ────────────────────────────────────────────────────
// Shared across all process instances (no per-process state).
// Uses an atomic upsert so concurrent requests don't race.
const RL_WINDOW_MS  = parseInt(process.env.AUTH_RL_WINDOW_MS || String(15 * 60 * 1000));
const RL_MAX        = parseInt(process.env.AUTH_RL_MAX       || '15');

// Purge entries older than 2 windows to keep the table small
setInterval(async () => {
  try {
    await pool.query(
      `DELETE FROM auth_rate_limit WHERE window_start < NOW() - ($1 * INTERVAL '1 millisecond')`,
      [RL_WINDOW_MS * 2]
    );
  } catch { /* ignore — cleanup is best-effort */ }
}, RL_WINDOW_MS).unref();

// Was: keyed on `req.headers['x-forwarded-for']` read directly, which an attacker
// bypasses entirely by sending a different X-Forwarded-For on every request —
// each forged value gets its own counter. dbRateLimit keys on req.ip, which
// Express derives using `trust proxy` (set in server.js) so forged hops are
// discarded. Credential-spraying protection depends on that; see rateLimit.js.
const authRateLimit = dbRateLimit({
  windowMs: RL_WINDOW_MS,
  max:      RL_MAX,
  bucket:   'auth',
});

const router = express.Router();

router.post("/login",           authRateLimit, login);
// verifyTokenLax allows refresh of expired tokens (within 7-day grace window).
// verifyToken would reject expired tokens, making the refresh endpoint useless.
router.post("/refresh",         verifyTokenLax, refresh);
router.post("/logout",          verifyToken,    logout);
// User creation is an administrative action — not public self-registration.
// Only authenticated admins/super-admins may create accounts.
router.post("/register",        verifyToken, allowRoles('admin', 'super_admin'), register);
router.get( "/permissions",     verifyToken,   getPermissions);
router.post("/forgot-password", authRateLimit, forgotPassword);
router.post("/verify-otp",      authRateLimit, verifyOtp);
router.post("/reset-password",  authRateLimit, resetPassword);
router.post("/google",          authRateLimit, googleAuth);

// ── Personal profile (any authenticated user) ─────────────────────────────────
router.get( "/profile",          verifyToken, getProfile);
router.put( "/profile",          verifyToken, updateProfile);
router.put( "/profile/password", verifyToken, changePassword);
// First-login set (no current password) — self-guards on must_change_password.
router.post("/set-initial-password", verifyToken, setInitialPassword);

// ── User preferences (per-device sync across sessions) ────────────────────────
router.get( "/preferences",      verifyToken, getPreferences);
router.put( "/preferences",      verifyToken, savePreferences);

export default router;
