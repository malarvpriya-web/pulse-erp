/**
 * GET/POST /settings/:module — a failed database read is NOT "nothing saved".
 *
 * GET used to answer 200 {} when its query threw, which a settings screen
 * cannot tell from an empty configuration: it showed its defaults as the
 * company's settings, and saving them overwrote the real ones. POST swallowed
 * its before-image read the same way, so a payroll save was merged onto {}
 * and dropped every key the request did not resend. (manual §200)
 *
 * The pool is mocked — no real database is touched. Permission checks are
 * passed through; they are covered by the route-gate suites.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../config/db.js', () => ({ default: { query: db.query, connect: vi.fn() } }));
vi.mock('../middlewares/auth.middleware.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
vi.mock('../services/AuditService.js', () => ({ logAudit: vi.fn() }));

const { default: settingsRouter } = await import('../modules/admin/settings-status.routes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, company_id: 1, role: 'admin' }; next(); });
app.use('/api/settings', settingsRouter);

const SELECT_SETTINGS = /SELECT settings FROM company_settings/;
const writes = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO company_settings/.test(sql));

beforeEach(() => {
  db.query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /settings/:module', () => {
  it('no saved row → 200 {} (a genuinely empty configuration)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const r = await request(app).get('/api/settings/payroll');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  it('saved row → 200 with the stored settings', async () => {
    db.query.mockResolvedValue({ rows: [{ settings: { pay_day: 1, pt_enabled: true } }] });
    const r = await request(app).get('/api/settings/payroll');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pay_day: 1, pt_enabled: true });
  });

  it.each(['payroll', 'performance', 'compliance'])('a failed read of %s → 500 SETTINGS_READ_FAILED, never 200 {}', async (module) => {
    db.query.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const r = await request(app).get(`/api/settings/${module}`);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ success: false, code: 'SETTINGS_READ_FAILED' });
    // The driver's message is logged, not sent.
    expect(JSON.stringify(r.body)).not.toMatch(/connection terminated/);
  });
});

describe('POST /settings/:module', () => {
  it('a failed before-image read refuses the save and writes nothing', async () => {
    db.query.mockImplementation((sql) => (SELECT_SETTINGS.test(sql)
      ? Promise.reject(new Error('connection terminated unexpectedly'))
      : Promise.resolve({ rows: [] })));
    const r = await request(app).post('/api/settings/payroll').send({ round_net_pay: '10' });
    expect(r.status).toBe(500);
    expect(writes()).toHaveLength(0);
  });

  it('a successful read merges onto the saved payroll blob (keys not resent are kept)', async () => {
    db.query.mockImplementation((sql) => (SELECT_SETTINGS.test(sql)
      ? Promise.resolve({ rows: [{ settings: { statutory_state: 'Tamil Nadu', round_net_pay: '1' } }] })
      : Promise.resolve({ rows: [] })));
    const r = await request(app).post('/api/settings/payroll').send({ round_net_pay: '10' });
    expect(r.status).toBe(200);
    expect(writes()).toHaveLength(1);
    const saved = JSON.parse(writes()[0][1][2]);
    expect(saved).toMatchObject({ statutory_state: 'Tamil Nadu', round_net_pay: '10' });
  });
});
