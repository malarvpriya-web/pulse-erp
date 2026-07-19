import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../modules/shared/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

import request      from 'supertest';
import pool         from '../modules/shared/db.js';
import payrollRoutes from '../modules/payroll/payroll.routes.js';
import { buildApp }  from './helpers/testApp.js';
import { adminToken, hrToken, employeeToken } from './helpers/tokens.js';

const app = buildApp(['/api/payroll', payrollRoutes]);

// Minimal employee row the payroll engine needs
const empRow = {
  id: 1, first_name: 'Arun', last_name: 'Kumar', department: 'Engineering',
  designation: 'Senior Developer', basic_salary: 60000,
  years_of_service: 3, office_id: 'EMP001',
};

beforeEach(() => vi.resetAllMocks());

describe('GET /api/payroll — list', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/api/payroll');
    expect(res.status).toBe(401);
  });

  it('200 returns payroll list', async () => {
    pool.query.mockResolvedValue({ rows: [empRow] });

    const res = await request(app).get('/api/payroll?month=4&year=2026')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/payroll/summary', () => {
  it('200 returns summary object', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })        // no saved payroll_runs
      .mockResolvedValueOnce({ rows: [empRow] });  // fallback employees query

    const res = await request(app).get('/api/payroll/summary?month=4&year=2026')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('total_employees');
  });
});

describe('POST /api/payroll/generate — run payroll', () => {
  it('401 without token', async () => {
    const res = await request(app).post('/api/payroll/generate')
      .send({ month: 4, year: 2026 });
    expect(res.status).toBe(401);
  });

  it('403 for employee role (not hr/admin)', async () => {
    const res = await request(app).post('/api/payroll/generate')
      .set('Authorization', `Bearer ${employeeToken()}`)
      .send({ month: 4, year: 2026 });
    expect(res.status).toBe(403);
  });

  it('400 when month is missing', async () => {
    const res = await request(app).post('/api/payroll/generate')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ year: 2026 });
    expect(res.status).toBe(400);
  });

  it('200 HR generates payroll successfully', async () => {
    const mockClient = {
      query:   vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    // Query order inside generatePayroll:
    //   1. fetchPayrollSettings   → empty → DEFAULT_PAYROLL_SETTINGS used
    //   2. employees SELECT       → [empRow]
    //   3-6. OT/LOP/loans/IT decl → [] (via .catch stubs, must stay empty to avoid
    //        d.declaration_type.toLowerCase() on empRow which has no declaration_type)
    pool.query
      .mockResolvedValueOnce({ rows: [] })       // fetchPayrollSettings
      .mockResolvedValueOnce({ rows: [empRow] }) // employees SELECT
      .mockResolvedValue({ rows: [] });           // OT / LOP / loans / IT declarations
    pool.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/payroll/generate')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ month: 4, year: 2026 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('count');
  });
});

describe('GET /api/payroll/trend', () => {
  it('200 returns 6-month trend', async () => {
    const trendRows = Array.from({ length: 6 }, (_, i) => ({
      month: ['Nov','Dec','Jan','Feb','Mar','Apr'][i],
      gross: 100000, net: 85000,
    }));
    pool.query.mockResolvedValue({ rows: trendRows });

    const res = await request(app).get('/api/payroll/trend')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(6);
  });
});
