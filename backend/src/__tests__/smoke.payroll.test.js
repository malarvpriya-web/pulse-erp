/**
 * Payroll route guards (mocked DB). Successful runs, approval, payment and the
 * statutory outputs are exercised against the real database in
 * integration.payrollEndToEnd.test.js — a mocked pool cannot model the
 * eligibility / revision / structure joins that decide who is paid, which is
 * how the old "200 returns payroll list" cases stayed green while Run Payroll
 * showed 0 employees.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../modules/shared/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));
// The payroll routes are gated by the permission matrix (PC-01), which lives in
// the database this suite does not have. Model the one fact it needs — the
// `employee` role holds no payroll grant, admin and hr do. The real matrix is
// exercised in integration.pc01PayrollAccess.test.js.
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requirePermission: () => (req, res, next) => (req.user?.role === 'employee'
    ? res.status(403).json({ error: 'Forbidden', code: 'PERMISSION_DENIED' })
    : next()),
}));

import request      from 'supertest';
import pool         from '../modules/shared/db.js';
import payrollRoutes from '../modules/payroll/payroll.routes.js';
import { buildApp }  from './helpers/testApp.js';
import { adminToken, hrToken, employeeToken } from './helpers/tokens.js';

const app = buildApp(['/api/payroll', payrollRoutes]);

beforeEach(() => { vi.resetAllMocks(); pool.query.mockResolvedValue({ rows: [] }); });

describe('payroll route guards', () => {
  it('401 without token', async () => {
    expect((await request(app).get('/api/payroll')).status).toBe(401);
    expect((await request(app).post('/api/payroll/generate').send({ month: 4, year: 2026 })).status).toBe(401);
  });

  it('403 for the employee role on HR endpoints', async () => {
    const res = await request(app).post('/api/payroll/generate')
      .set('Authorization', `Bearer ${employeeToken()}`).send({ month: 4, year: 2026 });
    expect(res.status).toBe(403);
  });

  it('400 when month is missing', async () => {
    const res = await request(app).post('/api/payroll/generate')
      .set('Authorization', `Bearer ${hrToken()}`).send({ year: 2026 });
    expect(res.status).toBe(400);
  });

  // Payroll is per company. A caller with no company context used to read and
  // generate across EVERY tenant (`company_id == null` meant "no filter").
  it.each([
    ['get', '/api/payroll?month=9&year=2026'],
    ['get', '/api/payroll/summary?month=9&year=2026'],
    ['get', '/api/payroll/trend'],
    ['get', '/api/payroll/eligibility?month=9&year=2026'],
    ['post', '/api/payroll/generate'],
    ['post', '/api/payroll/approve'],
  ])('%s %s fails closed without a company (400)', async (method, path) => {
    const res = await request(app)[method](path)
      .set('Authorization', `Bearer ${adminToken()}`).send({ month: 9, year: 2026 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/per company/);
  });
});
