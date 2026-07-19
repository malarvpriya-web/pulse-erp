import { vi, describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Mock DB before importing the middleware so the dynamic import inside
// verifyToken/checkPermission picks up the stub.
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('../config/db.js', () => ({ default: { query: mockQuery } }));

// setup.js sets JWT_SECRET before this import
const { verifyToken, allowRoles, requirePermission, checkPermission } =
  await import('../middlewares/auth.middleware.js');

const SECRET   = process.env.JWT_SECRET;
const validToken = jwt.sign({ userId: 1, role: 'admin' }, SECRET, { expiresIn: '1h' });

const mockRes = () => {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = (body) => { res.body = body; return res; };
  return res;
};

// ── verifyToken ───────────────────────────────────────────────────────────────

describe('verifyToken', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // Default: active user, no revocation, no scope in DB (JWT fast-path used)
    mockQuery.mockResolvedValue({
      rows: [{ is_active: true, logout_at: null, company_id: null, branch_id: null }],
    });
  });

  it('calls next() for a valid Bearer token', async () => {
    const req  = { headers: { authorization: `Bearer ${validToken}` } };
    const res  = mockRes();
    let called = false;
    await verifyToken(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.user.userId).toBe(1);
    expect(req.user.role).toBe('admin');
  });

  it('returns 401 when no Authorization header', async () => {
    const req = { headers: {} };
    const res = mockRes();
    await verifyToken(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Session expired');
  });

  it('returns 401 for an expired token', async () => {
    const expired = jwt.sign({ userId: 2 }, SECRET, { expiresIn: '-1s' });
    const req = { headers: { authorization: `Bearer ${expired}` } };
    const res = mockRes();
    await verifyToken(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const bad = jwt.sign({ userId: 3 }, 'wrong-secret');
    const req = { headers: { authorization: `Bearer ${bad}` } };
    const res = mockRes();
    await verifyToken(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a malformed token', async () => {
    const req = { headers: { authorization: 'Bearer not.a.token' } };
    const res = mockRes();
    await verifyToken(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when user is inactive in DB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ is_active: false, logout_at: null }] });
    const req = { headers: { authorization: `Bearer ${validToken}` } };
    const res = mockRes();
    await verifyToken(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Account inactive');
  });

  it('returns 401 when token predates explicit logout', async () => {
    // logout_at is in the future relative to iat (token issued at epoch+X, logout after)
    const futureLogout = new Date(Date.now() + 10_000).toISOString();
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_active: true, logout_at: futureLogout, company_id: null, branch_id: null }],
    });
    const req = { headers: { authorization: `Bearer ${validToken}` } };
    const res = mockRes();
    await verifyToken(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Session expired');
  });
});

// ── allowRoles ────────────────────────────────────────────────────────────────

describe('allowRoles', () => {
  it('calls next() when role is in the allowed list', () => {
    const req  = { user: { role: 'hr' } };
    const res  = mockRes();
    let called = false;
    allowRoles('admin', 'hr')(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('returns 403 when role is not in the allowed list', () => {
    const req = { user: { role: 'employee' } };
    const res = mockRes();
    allowRoles('admin', 'hr')(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Access denied');
  });

  it('returns 401 when req.user is missing', () => {
    const req = { headers: {} };
    const res = mockRes();
    allowRoles('admin')(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });
});

// ── checkPermission ───────────────────────────────────────────────────────────

describe('checkPermission', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns 401 when req.user is missing', async () => {
    const req = {};
    const res = mockRes();
    await checkPermission('leaves', 'can_view')(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('calls next() when permission row grants access', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ can_view: true }] });
    const req  = { user: { userId: 5, role: 'manager' } };
    const res  = mockRes();
    const next = vi.fn();
    await checkPermission('leaves', 'can_view')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 when permission row denies access', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ can_view: false }] });
    const req = { user: { userId: 5, role: 'manager' } };
    const res = mockRes();
    await checkPermission('leaves', 'can_view')(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('returns 500 on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const req = { user: { userId: 5, role: 'manager' } };
    const res = mockRes();
    await checkPermission('leaves', 'can_view')(req, res, () => {});
    expect(res.statusCode).toBe(500);
  });
});

// ── requirePermission — missing req.user ──────────────────────────────────────

describe('requirePermission — missing req.user', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns 401 instead of 500 when req.user is undefined', async () => {
    const req = {};
    const res = mockRes();
    await requirePermission('leaves', 'view')(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 401 instead of 500 when req.user is null', async () => {
    const req = { user: null };
    const res = mockRes();
    await requirePermission('finance', 'add')(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
