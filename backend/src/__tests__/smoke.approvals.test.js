/**
 * Smoke tests — Approvals module
 *
 * The approvals routes.js has NO verifyToken. Auth guard lives in each controller
 * as `if (!req.user) return 401`. We mock auth.middleware.js so verifyToken sets
 * req.user (enforcing 401 on no-token) without hitting the real DB.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../middlewares/auth.middleware.js', () => ({
  verifyToken: (req, res, next) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    // `roles` (plural) is what rolesOf reads. Approval authorization unions every
    // role held, so a mock supplying only the legacy singular `role` leaves the
    // caller with no roles at all. super_admin here because these are smoke
    // tests of approval *routing*, not of who may approve — that is covered by
    // approvals.authz.manual.mjs against the real matrix.
    req.user = { userId: 1, id: 1, role: 'manager', roles: ['super_admin'], company_id: null };
    next();
  },
  requirePermission: () => (_req, _res, next) => next(),
  // approvals.authz.js imports rolesOf/hasRole. A partial mock omitting them
  // makes every gated route 500 with an opaque vitest error rather than a
  // routing failure — add new exports here when the middleware grows them.
  rolesOf: (req) => (Array.isArray(req?.user?.roles) ? req.user.roles : [req?.user?.role].filter(Boolean)),
  hasRole: (req, ...codes) => {
    const want = codes.flat().map(c => String(c).toLowerCase());
    const held = Array.isArray(req?.user?.roles) ? req.user.roles : [req?.user?.role].filter(Boolean);
    return held.map(r => String(r).toLowerCase()).some(r => want.includes(r));
  },
  allowRoles: () => (_req, _res, next) => next(),
  // approvals.sources.js mirrors module permission gates through permissionFor.
  permissionFor: async () => null,
}));

vi.mock('../services/AuditService.js', () => ({ logAudit: vi.fn() }));
vi.mock('../services/WorkflowNotificationService.js', () => ({
  notifyWorkflowEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../config/db.js', () => ({ default: { query: vi.fn() } }));

import request         from 'supertest';
import pool            from '../config/db.js';
import approvalsRoutes from '../modules/approvals/approvals.routes.js';
import * as approvalsController from '../modules/approvals/approvals.controller.js';
import { verifyToken } from '../middlewares/auth.middleware.js';
import { buildApp }    from './helpers/testApp.js';
import { adminToken, managerToken } from './helpers/tokens.js';

// Mount verifyToken so req.user is populated (mirrors server.js v1Router)
const app = buildApp(['/api/approvals', verifyToken, approvalsRoutes]);

const PENDING = {
  id: 7, module_name: null, reference_id: null,
  status: 'Pending', request_date: '2026-05-01T00:00:00Z',
  approver_id: 1, notes: null,
};
const APPROVED = { ...PENDING, status: 'Approved', decision_date: '2026-05-02T00:00:00Z' };
const REJECTED = { ...PENDING, status: 'Rejected', decision_date: '2026-05-02T00:00:00Z' };

beforeEach(() => vi.resetAllMocks());

// ── Auth gates ──────────────────────────────────────────────────────────────────

describe('Auth gates — approvals endpoints require JWT', () => {
  it('GET /pending returns 401 without token', async () => {
    const res = await request(app).get('/api/approvals/pending');
    expect(res.status).toBe(401);
  });

  it('POST /:id/approve returns 401 without token', async () => {
    const res = await request(app).post('/api/approvals/7/approve').send({});
    expect(res.status).toBe(401);
  });

  it('POST /:id/reject returns 401 without token', async () => {
    const res = await request(app).post('/api/approvals/7/reject').send({});
    expect(res.status).toBe(401);
  });
});

// ── Pending approvals ───────────────────────────────────────────────────────────

describe('GET /api/approvals/pending', () => {
  it('200 returns list of pending approvals for the caller', async () => {
    // getPendingApprovals makes 8 parallel safeQuery calls; all → []
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/approvals/pending')
      .set('Authorization', `Bearer ${managerToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('200 returns empty array when no pending approvals', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/approvals/pending')
      .set('Authorization', `Bearer ${managerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── Approval history ────────────────────────────────────────────────────────────

describe('GET /api/approvals/history', () => {
  it('200 returns decided approvals for the caller', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/approvals/history')
      .set('Authorization', `Bearer ${managerToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Stats ───────────────────────────────────────────────────────────────────────

describe('GET /api/approvals/stats', () => {
  it('200 returns approval statistics computed from the same rows as the tabs', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/approvals/stats')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pending: 0, overdue: 0, approvedToday: 0, rejectedToday: 0 });
    // No decisions in the window → no compliance figure, never a fake 100%.
    expect(res.body.slaCompliance).toBeNull();
    expect(res.body.sla.default_hours).toBe(48);
  });
});

// ── Single approve ──────────────────────────────────────────────────────────────

describe('POST /api/approvals/:id/approve', () => {
  it('200 approves a pending request', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ module_name: null, reference_id: null }] }) // SELECT the row
      .mockResolvedValueOnce({ rows: [APPROVED] }) // UPDATE approvals SET status='Approved'
      .mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/approvals/7/approve')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ notes: 'Approved — looks good' });

    expect(res.status).toBe(200);
  });

  it('404 or 409 when approval record does not exist', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // UPDATE returns 0 rows → 409

    const res = await request(app).post('/api/approvals/999/approve')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({});

    expect([400, 404, 409, 500]).toContain(res.status);
  });
});

// ── Module records are decided by their module ─────────────────────────────────
//
// The Approval Center used to re-implement every module's transition (leave
// skipped L2/HR and never deducted balance; OT/regularization re-guarded by hand;
// ECN ignored parallel approvers). It now refuses, pointing at the module's own
// endpoint, which GET /pending hands to the UI as `actions`.

describe('Approval Center — module records go to the module endpoint', () => {
  for (const id of ['ot:5', 'leave:12', 'exp:3', 'pr:8', 'reg:2', 'ecn:4', 'pay:1', 'travel:9', 'adv:1']) {
    it(`409 USE_MODULE_ENDPOINT for ${id} and nothing is written`, async () => {
      const res = await request(app).post(`/api/approvals/${id}/approve`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USE_MODULE_ENDPOINT');
      expect(pool.query).not.toHaveBeenCalled();
    });
  }

  it('reject without a reason is refused before anything is written', async () => {
    const res = await request(app).post('/api/approvals/requisition:5/reject')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── Single reject ───────────────────────────────────────────────────────────────

describe('POST /api/approvals/:id/reject', () => {
  it('200 rejects a pending request with a reason', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ module_name: null, reference_id: null }] }) // SELECT the row
      .mockResolvedValueOnce({ rows: [REJECTED] }) // UPDATE approvals SET status='Rejected'
      .mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/approvals/7/reject')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ comment: 'Insufficient leave balance' });

    expect(res.status).toBe(200);
  });
});

// ── Bulk approve ────────────────────────────────────────────────────────────────

describe('POST /api/approvals/bulk-approve', () => {
  it('200 approves multiple requests at once', async () => {
    // centralIds [7,8] → single bulk UPDATE WHERE id = ANY(...) → empty rows OK
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/approvals/bulk-approve')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ids: [7, 8], notes: 'Batch approval' });

    expect([200, 201]).toContain(res.status);
  });

  it('rejects empty id list gracefully', async () => {
    const res = await request(app).post('/api/approvals/bulk-approve')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ids: [] });

    expect([200, 400]).toContain(res.status);
  });
});

// ── Bulk reject ─────────────────────────────────────────────────────────────────

describe('POST /api/approvals/bulk-reject', () => {
  it('200 rejects multiple requests at once', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/approvals/bulk-reject')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ids: [7, 8], comment: 'Budget freeze' });

    expect([200, 201]).toContain(res.status);
  });
});

// ── Escalate ────────────────────────────────────────────────────────────────────

describe('POST /api/approvals/:id/escalate', () => {
  it('200 reassigns a central row to a named approver and keeps it Pending', async () => {
    const reassigned = { ...PENDING, approver_id: 2 };
    pool.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // target is an active user in the company
      .mockResolvedValueOnce({ rows: [reassigned] })        // UPDATE approvals SET approver_id
      .mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/approvals/7/escalate')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ approver_user_id: 2 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Pending');
    expect(pool.query.mock.calls[1][0]).not.toMatch(/'Escalated'/);
  });

  it('400 without a target — it no longer silently drops the request from every queue', async () => {
    const res = await request(app).post('/api/approvals/7/escalate')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('400 for a module record — those escalate automatically under the module SLA', async () => {
    const res = await request(app).post('/api/approvals/leave:3/escalate')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ approver_user_id: 2 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ESCALATION_IS_AUTOMATIC');
  });
});

// ── GET /api/approvals (getAllApprovals) — visibility scoping ──────────────────
//
// The shared verifyToken mock above hardcodes every caller as
// role: 'manager' (a supervisor), so the non-supervisor branch can't be
// exercised through the HTTP layer without changing that shared mock for
// every other test in this file. Call the controller directly instead.

describe('getAllApprovals — non-supervisor callers are scoped to their own approver_id', () => {
  const mockRes = () => {
    const res = {};
    res.status = vi.fn(() => res);
    res.json   = vi.fn(() => res);
    return res;
  };

  it('override role (admin) gets no approver_id filter (company-wide)', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const req = { user: { userId: 1, role: 'admin', roles: ['admin'] }, scope: { company_id: 5 }, query: {} };

    await approvalsController.getAllApprovals(req, mockRes());

    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/approver_id/);
  });

  it('manager/employee are filtered to approver_id = caller', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const req = { user: { userId: 4, role: 'manager', roles: ['manager'] }, scope: { company_id: 5 }, query: {} };

    await approvalsController.getAllApprovals(req, mockRes());

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/approver_id/);
    expect(params).toContain(4);
  });
});

// ── Approval chain ──────────────────────────────────────────────────────────────

describe('GET /api/approvals/:id/chain', () => {
  it('200 returns approval chain for a request', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/approvals/7/chain')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
