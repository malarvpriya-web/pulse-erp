import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../config/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

import request  from 'supertest';
import pool     from '../config/db.js';
import employeeRoutes from '../employees/employee.routes.js';
import { buildApp }   from './helpers/testApp.js';
import { adminToken, hrToken, employeeToken } from './helpers/tokens.js';

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
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].first_name).toBe('Arun');
  });

  it('200 with HR token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })
      .mockResolvedValue({ rows: [mockEmployee] });

    const res = await request(app).get('/api/employees')
      .set('Authorization', `Bearer ${hrToken()}`);

    expect(res.status).toBe(200);
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
    pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] }); // verifyToken active-check

    // addEmployee uses pool.connect() for a transaction; wire up a mock client.
    const mockClient = {
      query:   vi.fn().mockResolvedValue({ rows: [mockEmployee] }),
      release: vi.fn(),
    };
    pool.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/employees')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        first_name: 'Arun', last_name: 'Kumar',
        department: 'Engineering', designation: 'Senior Developer',
        company_email: 'arun@manifest.in', joining_date: '2026-01-01',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
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

    const res = await request(app).put('/api/employees/42')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ designation: 'Lead' });

    expect(res.status).toBe(200);
    expect(res.body.designation).toBe('Lead');
  });
});
