import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../config/db.js', () => ({ default: { query: vi.fn() } }));

vi.mock('../modules/leaves/repositories/leaves.repository.js', () => ({
  default: {
    applyLeave:       vi.fn(),
    findApplications: vi.fn(),
    updateStatus:     vi.fn(),
  },
}));
vi.mock('../services/ValidationEngineService.js', () => ({
  validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
}));
vi.mock('../services/RuleEngineService.js', () => ({
  evaluateRules: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/AuditService.js', () => ({
  logAudit: vi.fn(),
}));

import request       from 'supertest';
import pool          from '../config/db.js';
import leavesRepo    from '../modules/leaves/repositories/leaves.repository.js';
import leaveRoutes   from '../modules/leaves/routes/leaves.routes.js';
import { validate }      from '../services/ValidationEngineService.js';
import { evaluateRules } from '../services/RuleEngineService.js';
import { buildApp }  from './helpers/testApp.js';
import { verifyToken } from '../middlewares/auth.middleware.js';
import { adminToken, hrToken, employeeToken } from './helpers/tokens.js';

const app = buildApp(['/api/leaves', verifyToken, leaveRoutes]);

const pendingLeave = {
  id: 10, employee_id: 4, leave_type_id: 1, leave_type: 'casual',
  start_date: '2026-05-01', end_date: '2026-05-02', number_of_days: 2,
  reason: 'Personal work', status: 'pending', created_at: new Date().toISOString(),
};

const FULL_PERMISSION = {
  can_view: true, can_add: true, can_edit: true,
  can_delete: true, can_approve: true, can_export: true,
};

const ACTIVE_USER = { is_active: true, logout_at: null, company_id: null, branch_id: null };

// Grants an explicit full-permission role row. Previously this returned empty
// rows and relied on requirePermission failing OPEN — so these tests passed
// because authorization was effectively off. It now fails closed by default.
const mockAuthWithFullPermission = () => {
  pool.query
    .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken active-check
    .mockResolvedValueOnce({ rows: [] })             // requirePermission: user-level lookup
    .mockResolvedValueOnce({ rows: [FULL_PERMISSION] });            // requirePermission: role-level lookup
};

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks wipes the resolved values set in the vi.mock factories above,
  // so re-establish the service mock implementations each test.
  validate.mockResolvedValue({ valid: true, errors: [] });
  evaluateRules.mockResolvedValue([]);
});

// ── Submit leave request ────────────────────────────────────────────────────────

describe('POST /api/leaves — submit leave request', () => {
  it('401 without token', async () => {
    const res = await request(app).post('/api/leaves')
      .send({ leave_type: 'casual', start_date: '2026-05-01', end_date: '2026-05-02', days: 2, reason: 'Test' });
    expect(res.status).toBe(401);
  });

  it('201 employee submits leave request', async () => {
    mockAuthWithFullPermission();
    // Post-permission queries (balance, policy, overlap) default to empty so the
    // happy path proceeds to applyLeave. leave_type_id is supplied so the
    // leave-type resolution query is skipped.
    pool.query.mockResolvedValue({ rows: [] });
    leavesRepo.applyLeave.mockResolvedValue(pendingLeave);

    const res = await request(app).post('/api/leaves')
      .set('Authorization', `Bearer ${employeeToken()}`)
      .send({ leave_type_id: 1, leave_type: 'casual', start_date: '2026-05-01', end_date: '2026-05-02', days: 2, reason: 'Personal work' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('400 when leave type does not exist', async () => {
    mockAuthWithFullPermission();
    // resolveLeaveTypeId (and any subsequent lookup) returns no rows → 400.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/leaves')
      .set('Authorization', `Bearer ${employeeToken()}`)
      .send({ leave_type: 'nonexistent', start_date: '2026-05-01', end_date: '2026-05-02', days: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ── Approve leave ───────────────────────────────────────────────────────────────

describe('PATCH /api/leaves/:id/approve — approval flow', () => {
  it('401 without token', async () => {
    const res = await request(app).patch('/api/leaves/10/approve');
    expect(res.status).toBe(401);
  });

  it('200 HR approves leave', async () => {
    mockAuthWithFullPermission();
    const approved = { ...pendingLeave, status: 'approved' };
    leavesRepo.updateStatus.mockResolvedValue(approved);

    const res = await request(app).patch('/api/leaves/10/approve')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ comments: 'OK' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── Reject leave ────────────────────────────────────────────────────────────────

describe('PATCH /api/leaves/:id/reject — rejection flow', () => {
  it('200 HR rejects leave with reason', async () => {
    mockAuthWithFullPermission();
    const rejected = { ...pendingLeave, status: 'rejected' };
    leavesRepo.updateStatus.mockResolvedValue(rejected);

    const res = await request(app).patch('/api/leaves/10/reject')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ comments: 'Busy period' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── List all leaves ─────────────────────────────────────────────────────────────

describe('GET /api/leaves', () => {
  it('200 returns all leaves for admin', async () => {
    mockAuthWithFullPermission();
    leavesRepo.findApplications.mockResolvedValue([pendingLeave]);

    const res = await request(app).get('/api/leaves')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── My leaves ───────────────────────────────────────────────────────────────────

describe('GET /api/leaves/my', () => {
  it('200 returns current user leaves', async () => {
    mockAuthWithFullPermission();
    leavesRepo.findApplications.mockResolvedValue([pendingLeave]);

    const res = await request(app).get('/api/leaves/my')
      .set('Authorization', `Bearer ${employeeToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
