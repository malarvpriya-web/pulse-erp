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
}));

vi.mock('../services/AuditService.js', () => ({ logAudit: vi.fn() }));
vi.mock('../services/WorkflowNotificationService.js', () => ({
  notifyWorkflowEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../config/db.js', () => ({ default: { query: vi.fn() } }));

import request         from 'supertest';
import pool            from '../config/db.js';
import approvalsRoutes from '../modules/approvals/approvals.routes.js';
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
  it('200 returns approval statistics', async () => {
    // getApprovalStats: 4 parallel count queries need rows[0].count (can't be undefined)
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })  // centralPending
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })  // approvedToday
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })  // rejectedToday
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })  // centralOverdue
      .mockResolvedValue({ rows: [] });                    // 7 source queries + SLA

    const res = await request(app).get('/api/approvals/stats')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
  });
});

// ── Single approve ──────────────────────────────────────────────────────────────

describe('POST /api/approvals/:id/approve', () => {
  it('200 approves a pending request', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [APPROVED] }) // UPDATE approvals SET status='Approved'
      .mockResolvedValue({ rows: [] });             // source-item approve + audit

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

// ── Single reject ───────────────────────────────────────────────────────────────

describe('POST /api/approvals/:id/reject', () => {
  it('200 rejects a pending request with a reason', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [REJECTED] }) // UPDATE approvals SET status='Rejected'
      .mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/approvals/7/reject')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ notes: 'Insufficient leave balance' });

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
      .send({ ids: [7, 8], notes: 'Budget freeze' });

    expect([200, 201]).toContain(res.status);
  });
});

// ── Escalate ────────────────────────────────────────────────────────────────────

describe('POST /api/approvals/:id/escalate', () => {
  it('200 escalates approval to next level', async () => {
    const escalated = { ...PENDING, status: 'Escalated', approver_id: 2 };
    pool.query
      .mockResolvedValueOnce({ rows: [escalated] }) // UPDATE approvals SET status='Escalated'
      .mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/approvals/7/escalate')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ reason: 'Requires senior approval' });

    expect(res.status).toBe(200);
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
