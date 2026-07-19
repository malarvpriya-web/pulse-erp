import { vi, describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

vi.mock('../config/db.js', () => ({ default: { query: vi.fn() } }));

import request from 'supertest';
import pool    from '../config/db.js';
import authRoutes from '../auth/auth.routes.js';
import { buildApp } from './helpers/testApp.js';
import { adminToken } from './helpers/tokens.js';

const app = buildApp(['/api/auth', authRoutes]);

const HASH = bcrypt.hashSync('pass123', 10);
const activeUser = { id: 1, name: 'Admin', email: 'admin@test.com', role: 'admin', department: 'IT', password_hash: HASH, is_active: true };
const ACTIVE_USER = { is_active: true, logout_at: null, company_id: null, branch_id: null };

beforeEach(() => vi.resetAllMocks());

describe('POST /api/auth/login', () => {
  it('200 + token on valid credentials', async () => {
    pool.query.mockResolvedValue({ rows: [activeUser] });

    const res = await request(app).post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'pass123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user).not.toHaveProperty('password_hash');
  });

  it('401 on wrong password', async () => {
    pool.query.mockResolvedValue({ rows: [activeUser] });

    const res = await request(app).post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('401 when user not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'pass123' });

    expect(res.status).toBe(401);
  });

  it('403 when account is inactive', async () => {
    pool.query.mockResolvedValue({ rows: [{ ...activeUser, is_active: false }] });

    const res = await request(app).post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'pass123' });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/auth/permissions', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/api/auth/permissions');
    expect(res.status).toBe(401);
  });

  it('200 with valid token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })                          // verifyToken active-check
      .mockResolvedValue({ rows: [{ module: 'employees', can_view: true }] }); // permissions query

    const res = await request(app).get('/api/auth/permissions')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('permissions');
  });
});

describe('POST /api/auth/refresh', () => {
  it('401 without token', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('200 + fresh token with valid token', async () => {
    pool.query.mockResolvedValue({ rows: [activeUser] });

    const res = await request(app).post('/api/auth/refresh')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user).not.toHaveProperty('password_hash');
  });

  it('403 when account is inactive', async () => {
    pool.query.mockResolvedValue({ rows: [{ ...activeUser, is_active: false }] });

    const res = await request(app).post('/api/auth/refresh')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(403);
  });
});
