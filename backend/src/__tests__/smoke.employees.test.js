import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../config/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));
// The database is mocked, so the matrix lookup behind can() would see no rows;
// these route tests are about the create contract, not the bank grant
// (integration.employeeBankDetails.test.js covers that against the real matrix).
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => ({ ...(await importOriginal()), can: async () => true }));

import request  from 'supertest';
import pool     from '../config/db.js';
import employeeRoutes from '../employees/employee.routes.js';
import { buildApp }   from './helpers/testApp.js';
import { adminToken, hrToken, employeeToken, makeToken } from './helpers/tokens.js';

// GET /employees refuses a caller whose company cannot be resolved (2026-10-20,
// shared/employeeAccess.js readScope) — only a super admin may read globally.
// A real admin/HR login carries its company, so these reads model that.
const scopedAdminToken = () => makeToken({ userId: 1, role: 'admin', company_id: 1 });
const scopedHrToken    = () => makeToken({ userId: 2, role: 'hr', employee_id: 2, company_id: 1 });

const app = buildApp(['/api/employees', employeeRoutes]);

const ACTIVE_USER = { is_active: true, logout_at: null, company_id: null, branch_id: null };

const mockEmployee = {
  id: 42, office_id: 'EMP042', first_name: 'Arun', last_name: 'Kumar',
  department: 'Engineering', designation: 'Senior Developer',
  company_email: 'arun@manifest.in', status: 'active',
};

beforeEach(() => vi.resetAllMocks());

describe('GET /api/employees', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(401);
  });

  it('200 + array with valid token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken active-check
      .mockResolvedValue({ rows: [mockEmployee] });    // SELECT employees

    const res = await request(app).get('/api/employees')
      .set('Authorization', `Bearer ${scopedAdminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].first_name).toBe('Arun');
  });

  it('200 with HR token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValue({ rows: [mockEmployee] });

    const res = await request(app).get('/api/employees')
      .set('Authorization', `Bearer ${scopedHrToken()}`);

    expect(res.status).toBe(200);
  });

  it('403 for an admin token with no company (not a global read)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });
    const res = await request(app).get('/api/employees')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/employees (create)', () => {
  it('401 without token', async () => {
    const res = await request(app).post('/api/employees')
      .send({ first_name: 'New', last_name: 'Hire' });
    expect(res.status).toBe(401);
  });

  it('403 when role is employee (not hr/admin)', async () => {
    const res = await request(app).post('/api/employees')
      .set('Authorization', `Bearer ${employeeToken()}`)
      .send({ first_name: 'New', last_name: 'Hire' });
    expect(res.status).toBe(403);
  });

  it('200 when admin creates employee', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken active-check
      // addEmployee's duplicate-company_email pre-check. Empty = not a duplicate;
      // the blanket mockResolvedValue below would otherwise hand it back
      // mockEmployee and turn this create into a 409.
      .mockResolvedValue({ rows: [] });

    // addEmployee uses pool.connect() for a transaction; wire up a mock client.
    // The generator's MAX() query reads rows[0].max_seq, so the mock has to carry
    // one — a bare `{ rows: [mockEmployee] }` makes Number(undefined) NaN and the
    // minted code 'EMPNaN', which the format check then rejects.
    const mockClient = {
      query: vi.fn().mockImplementation((sql) => {
        if (/max_seq/i.test(sql))     return Promise.resolve({ rows: [{ max_seq: '41' }] });
        if (/FROM employees\s+WHERE\s+LOWER\(office_id\)/i.test(sql)) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [mockEmployee] });
      }),
      release: vi.fn(),
    };
    pool.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/employees')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        first_name: 'Arun', last_name: 'Kumar',
        department: 'Engineering', designation: 'Senior Developer',
        // `status` is required on create as of 2026-09-28 — the employees.status
        // column DEFAULTs to 'Probation', so a create that omitted it silently
        // filed the new hire as a probationer. See REQUIRED_ON_CREATE.
        status: 'Active',
        company_email: 'arun@manifest.in', joining_date: '2026-01-01',
        account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
  });

  /**
   * The mandatory-field contract, at the ROUTE level.
   *
   * employeeCode.contract.test.js proves the service throws; these prove the
   * throw surfaces as a 400 with a usable message rather than as a 500. The
   * distinction matters — `respondError` only honours `statusCode` on the error,
   * and an untagged throw from this path would 500.
   */
  for (const field of ['department', 'designation', 'status', 'joining_date']) {
    it(`400 when ${field} is missing`, async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
        .mockResolvedValue({ rows: [] });

      const body = {
        first_name: 'Arun', last_name: 'Kumar',
        company_email: 'arun@manifest.in',
        department: 'Engineering', designation: 'Senior Developer', status: 'Active',
        // Present so the assertion below fails for the field under test rather
        // than for this one — otherwise every case in the loop passes for the
        // same wrong reason and the loop proves nothing.
        joining_date: '2026-01-01',
        account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street',
      };
      delete body[field];

      const res = await request(app).post('/api/employees')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send(body);

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/required/i);
    });
  }

  it('400 for a status outside the canonical write vocabulary', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/employees')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        first_name: 'Arun', last_name: 'Kumar', company_email: 'arun@manifest.in',
        department: 'Engineering', designation: 'Senior Developer',
        status: 'Inactive', // an EXITED status, and not writable
        joining_date: '2026-01-01',
        account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street',
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not a valid employment status/i);
  });
});

/**
 * PATCH /employees/:id/status took the body's `status` straight into an UPDATE
 * with no validation and — uniquely among the employee writes in this file — no
 * company filter at all.
 */
describe('PATCH /api/employees/:id/status', () => {
  it('400 for a status outside the canonical write vocabulary', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValue({ rows: [{ id: 42 }] });

    const res = await request(app).patch('/api/employees/42/status')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'totally-made-up' });

    expect(res.status).toBe(400);
    expect(res.body.allowed).toEqual(['Active', 'Probation', 'Notice', 'Left']);
  });

  it('normalises case instead of storing a new spelling', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValue({ rows: [{ ...mockEmployee, status: 'Notice' }] });

    const res = await request(app).patch('/api/employees/42/status')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'notice' });

    expect(res.status).toBe(200);
    // The UPDATE must carry the canonical 'Notice', not the caller's 'notice'.
    const update = pool.query.mock.calls.find(([sql]) => /UPDATE employees SET status/i.test(sql));
    expect(update).toBeDefined();
    expect(update[1][0]).toBe('Notice');
  });

  it('scopes the UPDATE by company so it cannot cross tenants', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValue({ rows: [mockEmployee] });

    await request(app).patch('/api/employees/42/status')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Active' });

    const update = pool.query.mock.calls.find(([sql]) => /UPDATE employees SET status/i.test(sql));
    expect(update).toBeDefined();
    expect(update[0]).toMatch(/company_id\s*=\s*\$3/);
  });
});

describe('GET /api/employees/:id', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/api/employees/42');
    expect(res.status).toBe(401);
  });

  it('200 returns employee when found', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken
      .mockResolvedValueOnce({ rows: [mockEmployee] }); // getEmployeeById

    const res = await request(app).get('/api/employees/42')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    expect(res.body.first_name).toBe('Arun');
  });

  it('404 when employee not found', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken
      .mockResolvedValueOnce({ rows: [] });            // getEmployeeById — not found

    const res = await request(app).get('/api/employees/999')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/employees/ex (ex-employees)', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/api/employees/ex');
    expect(res.status).toBe(401);
  });

  it('200 returns array of ex-employees', async () => {
    const exEmployee = { ...mockEmployee, status: 'left', effective_exit_date: '2025-01-01', separation_type: 'resignation' };
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken
      .mockResolvedValueOnce({ rows: [exEmployee] }); // getExEmployees query

    const res = await request(app).get('/api/employees/ex')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('200 accepts exit_date_from and exit_date_to filters', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/employees/ex?exit_date_from=2025-01-01&exit_date_to=2025-12-31')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('PUT /api/employees/:id (update)', () => {
  it('401 without token', async () => {
    const res = await request(app).put('/api/employees/42')
      .send({ designation: 'Lead' });
    expect(res.status).toBe(401);
  });

  it('200 when admin updates employee', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValue({ rows: [{ ...mockEmployee, designation: 'Lead' }] });
    // updateEmployee is one transaction on its own client.
    pool.connect.mockResolvedValueOnce({
      query: vi.fn().mockResolvedValue({ rows: [{ ...mockEmployee, designation: 'Lead' }] }),
      release: vi.fn(),
    });

    const res = await request(app).put('/api/employees/42')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ designation: 'Lead' });

    expect(res.status).toBe(200);
    expect(res.body.designation).toBe('Lead');
  });
});
