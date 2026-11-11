/**
 * GET /api/analytics/workforce is reachable through the app as server.js builds it.
 *
 * WHY THIS EXISTS (2026-10-13)
 * The Workforce Analytics page showed "Workforce analytics could not be
 * loaded." The request got 404 "Cannot GET /api/analytics/workforce" — an
 * Express HTML page — while /api/analytics/age-distribution answered 200 with
 * the same token. The dev backend was a plain `node server.js` started the
 * night before the route was written, with no file watcher: it was serving old
 * code. Restarting it fixed the page; nothing in the route was wrong.
 *
 * The existing workforce suites could not have noticed a mounting problem
 * either way: they mount analytics.routes.js on an app of their own. This suite
 * pins the REAL wiring instead —
 *   1. server.js mounts the router at /analytics behind verifyToken, then
 *      analyticsPolicy, and exposes v1Router at both /api and /api/v1 (the
 *      frontend calls /api/...); analytics.routes.js registers '/workforce'.
 *      Read from source: importing server.js starts its cron jobs.
 *   2. That exact chain — the REAL verifyToken with a real signed token, the
 *      real policy, the real router — answers JSON 200 for an HR user, 403 for
 *      a user without hr:view, 401 without a token, at both prefixes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }            = await import('../config/db.js');
const { verifyToken }              = await import('../middlewares/auth.middleware.js');
const { analyticsPolicy }          = await import('../shared/analyticsAuthz.js');
const { default: analyticsRoutes } = await import('../analytics/routes/analytics.routes.js');

const SERVER_SRC    = readFileSync(resolve(here, '../../server.js'), 'utf8');
const ANALYTICS_SRC = readFileSync(resolve(here, '../analytics/routes/analytics.routes.js'), 'utf8');

// ── 1. The wiring in server.js ────────────────────────────────────────────────
describe('server.js wiring', () => {
  it('imports the analytics router from analytics.routes.js', () => {
    expect(SERVER_SRC).toMatch(/import analyticsRoutes\s+from "\.\/src\/analytics\/routes\/analytics\.routes\.js"/);
  });

  it('mounts it at /analytics behind verifyToken, then analyticsPolicy, then the audit floor', () => {
    // auditMutations added 2026-11-10: PUT /workforce-settings is this router's
    // one write and must reach the audit trail.
    expect(SERVER_SRC).toMatch(
      /v1Router\.use\("\/analytics",\s*verifyToken,\s*analyticsPolicy,\s*auditMutations\('analytics'[^)]*\),\s*analyticsRoutes\)/);
  });

  it('serves v1Router at both /api/v1 and /api (the frontend calls /api/...)', () => {
    expect(SERVER_SRC).toMatch(/app\.use\("\/api\/v1",\s*v1Router\)/);
    expect(SERVER_SRC).toMatch(/app\.use\("\/api",\s*v1Router\)/);
  });

  it('the router registers GET /workforce', () => {
    expect(ANALYTICS_SRC).toMatch(/router\.get\('\/workforce',/);
  });
});

// ── 2. The same chain, end to end ─────────────────────────────────────────────
// Built exactly as server.js builds it (asserted above).
const v1Router = express.Router();
v1Router.use('/analytics', verifyToken, analyticsPolicy, analyticsRoutes);
const app = express();
app.use('/api/v1', v1Router);
app.use('/api', v1Router);

/** A token shaped like the login route's, for a real user (signed with this process's secret). */
async function tokenForRole(code) {
  const { rows: [u] } = await pool.query(
    `SELECT u.id, u.email, u.role, u.company_id, u.branch_id
       FROM users u
      WHERE u.is_active AND u.company_id = 1
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND LOWER(r.code) = $1)
        -- single-role and no user-level override, so the role matrix decides
        AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                         WHERE ur.user_id = u.id AND LOWER(r.code) <> $1)
        AND NOT EXISTS (SELECT 1 FROM permissions p WHERE p.user_id = u.id)
      ORDER BY u.id LIMIT 1`, [code]);
  if (!u) return null;
  return jwt.sign(
    { userId: u.id, email: u.email, role: u.role, company_id: u.company_id, branch_id: u.branch_id ?? null },
    process.env.JWT_SECRET, { expiresIn: '10m' });
}

let hrToken, employeeToken;
beforeAll(async () => {
  hrToken = await tokenForRole('hr');
  employeeToken = await tokenForRole('employee');
});

describe('GET /api/analytics/workforce through the real chain', () => {
  it.each(['/api', '/api/v1'])('%s: an HR user gets JSON 200 with the workforce payload', async (prefix) => {
    expect(hrToken, 'needs an active single-role hr user in company 1').toBeTruthy();
    const res = await request(app).get(`${prefix}/analytics/workforce`)
      .query({ period: 'all' }).set('Authorization', `Bearer ${hrToken}`);
    expect(res.status, res.text.slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.population).toEqual(expect.objectContaining({ basis: 'current', total: expect.any(Number) }));
    expect(res.body.breakdowns).toBeTruthy();
  });

  it('is not the "Cannot GET" 404 the page reported', async () => {
    const res = await request(app).get('/api/analytics/workforce').set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).not.toBe(404);
    expect(res.text).not.toMatch(/Cannot GET/);
  });

  it('a user without hr:view is refused (403) — the gate is still in the chain', async () => {
    expect(employeeToken, 'needs an active single-role employee user in company 1').toBeTruthy();
    const res = await request(app).get('/api/analytics/workforce').set('Authorization', `Bearer ${employeeToken}`);
    expect(res.status).toBe(403);
    expect(res.body.breakdowns).toBeUndefined();
  });

  it('no token is 401', async () => {
    const res = await request(app).get('/api/analytics/workforce');
    expect(res.status).toBe(401);
  });
});
