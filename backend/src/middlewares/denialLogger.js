/**
 * Records authorization denials (401/403) to `access_denials`.
 *
 * `auditLogger` writes only on 2xx, so a refused request currently leaves no
 * trace. That makes the pilot's central RBAC question — "does the seeded matrix
 * match how people actually work?" — unanswerable, because every piece of
 * evidence is a 403 nobody kept.
 *
 * Each row is one of exactly two things, and only a human who knows the job can
 * say which:
 *
 *   • the boundary working  — someone reached for something outside their role
 *   • a matrix error        — someone was blocked from their own daily work
 *
 * The point of collecting them is to make that triage possible at all.
 *
 * Fire-and-forget: a failure to record a denial must never turn a clean 403 into
 * a 500. Wrapped in res.json rather than res.on('finish') so the response body
 * is available — the `code` field is what distinguishes PERMISSION_DENIED
 * (matrix says no) from PERMISSION_NOT_CONFIGURED (matrix has no opinion), and
 * those two want opposite fixes.
 */
import pool from '../config/db.js';
import { rolesOf } from './auth.middleware.js';

// Auth endpoints 401 constantly by design (wrong password, expired token) and
// would drown the signal. Login failures are already covered by security_events.
const SKIP = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/forgot-password'];

export const denialLogger = (req, res, next) => {
  const origJson = res.json.bind(res);

  res.json = (body) => {
    const status = res.statusCode;
    if ((status === 401 || status === 403) && !SKIP.some(p => (req.path || '').startsWith(p))) {
      // Never let telemetry break the response.
      queueMicrotask(() => {
        pool.query(
          `INSERT INTO access_denials
             (user_id, roles, method, path, module, action, code, status, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            req.user?.userId ?? null,
            (() => { try { return rolesOf(req); } catch { return null; } })(),
            req.method,
            (req.originalUrl || req.path || '').slice(0, 500),
            body?.module ?? null,
            body?.action ?? null,
            body?.code ?? null,
            status,
            req.scope?.company_id ?? null,
          ]
        ).catch(() => {});
      });
    }
    return origJson(body);
  };

  next();
};
