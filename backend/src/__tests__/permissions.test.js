/**
 * Action-level permission enforcement tests
 *
 * Covers all 7 protected modules: leaves, projects, inventory, finance,
 * service, crm, hr.
 *
 * Each module gets:
 *   - Positive: role allows → next() called
 *   - Negative deny tests for view, add, delete (≥1 per module)
 *   - Approve deny test for approval-bearing modules (finance, leaves)
 *
 * Additional suites:
 *   - Shorthand alias resolution (view→can_view, etc.)
 *   - Per-request cache (same req object → 0 extra DB queries)
 *   - 403 response schema shape
 *   - Backward compat: full column names still accepted
 *   - Passthrough when no permission row exists
 *
 * Runner: Vitest   |   npx vitest run src/__tests__/permissions.test.js
 */

import { vi, describe, test, expect, beforeEach } from 'vitest';

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('../config/db.js', () => ({ default: { query: mockQuery } }));

import { requirePermission } from '../middlewares/auth.middleware.js';

// ── Shared test utilities ─────────────────────────────────────────────────────

const makeReq = (userId = 1, role = 'manager') => ({
  user: { userId, role },
});

const makeRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json   = vi.fn().mockReturnValue(res);
  return res;
};

/** Simulate role-level ALLOW: no user row, role row grants the column. */
const setupAllow = (col) => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ [col]: true }] });
};

/** Simulate role-level DENY: no user row, role row explicitly denies. */
const setupDeny = (col) => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ [col]: false }] });
};

/** Simulate no permission config at all (passthrough). */
const setupPassthrough = () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
};

// ── Per-module: positive allow + deny tests ───────────────────────────────────

const MODULES = ['leaves', 'projects', 'inventory', 'finance', 'service', 'crm', 'hr'];

describe.each(MODULES.map(m => [m]))('%s module', (module) => {
  beforeEach(() => mockQuery.mockReset());

  test('view — allowed role calls next()', async () => {
    setupAllow('can_view');
    const next = vi.fn();
    await requirePermission(module, 'view')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('view — denied role returns 403', async () => {
    setupDeny('can_view');
    const res = makeRes();
    await requirePermission(module, 'view')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('add — denied role returns 403', async () => {
    setupDeny('can_add');
    const res = makeRes();
    await requirePermission(module, 'add')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('edit — allowed role calls next()', async () => {
    setupAllow('can_edit');
    const next = vi.fn();
    await requirePermission(module, 'edit')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('delete — denied role returns 403', async () => {
    setupDeny('can_delete');
    const res = makeRes();
    await requirePermission(module, 'delete')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ── Approval endpoint tests (finance & leaves) ────────────────────────────────

describe.each([['finance'], ['leaves']])('%s approve endpoint', (module) => {
  beforeEach(() => mockQuery.mockReset());

  test('approve — allowed calls next()', async () => {
    setupAllow('can_approve');
    const next = vi.fn();
    await requirePermission(module, 'approve')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('approve — denied returns 403 with PERMISSION_DENIED code', async () => {
    setupDeny('can_approve');
    const res = makeRes();
    await requirePermission(module, 'approve')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PERMISSION_DENIED', action: 'can_approve' })
    );
  });
});

// ── Shorthand alias resolution ────────────────────────────────────────────────

describe('shorthand action aliases', () => {
  beforeEach(() => mockQuery.mockReset());

  test.each([
    ['view',    'can_view'],
    ['add',     'can_add'],
    ['edit',    'can_edit'],
    ['delete',  'can_delete'],
    ['approve', 'can_approve'],
  ])('alias "%s" maps to column "%s" and allows when true', async (alias, col) => {
    setupAllow(col);
    const next = vi.fn();
    await requirePermission('finance', alias)(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('full column name "can_edit" still accepted (backward compat)', async () => {
    setupAllow('can_edit');
    const next = vi.fn();
    await requirePermission('projects', 'can_edit')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('unknown action returns 400', async () => {
    const res = makeRes();
    await requirePermission('leaves', 'can_fly')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── 403 response schema ───────────────────────────────────────────────────────

describe('403 response schema', () => {
  beforeEach(() => mockQuery.mockReset());

  test('body matches exact structured schema', async () => {
    setupDeny('can_edit');
    const res = makeRes();
    await requirePermission('hr', 'edit')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error:   'Forbidden',
      code:    'PERMISSION_DENIED',
      module:  'hr',
      action:  'can_edit',
      message: 'You do not have permission to perform this action.',
    });
  });

  test('403 body contains module and resolved column name, not alias', async () => {
    setupDeny('can_delete');
    const res = makeRes();
    await requirePermission('crm', 'delete')(makeReq(), res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'crm', action: 'can_delete' })
    );
  });
});

// ── Per-request permission cache ──────────────────────────────────────────────

describe('per-request permission cache', () => {
  beforeEach(() => mockQuery.mockReset());

  test('second guard for same module uses cached row — no extra DB queries', async () => {
    setupAllow('can_view');
    const req  = makeReq();
    const next = vi.fn();

    // First call: cold cache → 2 DB queries (user-level + role-level)
    await requirePermission('inventory', 'view')(req, makeRes(), next);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Second call on same req: warm cache → 0 additional DB queries
    mockQuery.mockReset();
    await requirePermission('inventory', 'view')(req, makeRes(), next);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('cache is per-module: different modules still query separately', async () => {
    const req  = makeReq();

    setupAllow('can_view');
    await requirePermission('crm', 'view')(req, makeRes(), vi.fn());
    expect(mockQuery).toHaveBeenCalledTimes(2);

    mockQuery.mockReset();
    setupAllow('can_view');
    await requirePermission('hr', 'view')(req, makeRes(), vi.fn());
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

// ── User-level override ───────────────────────────────────────────────────────

describe('user-level override takes precedence over role-level', () => {
  beforeEach(() => mockQuery.mockReset());

  test('user row deny blocks even when role would allow', async () => {
    // User-level row: can_add = false
    mockQuery.mockResolvedValueOnce({ rows: [{ can_add: false }] });
    // Role-level row would allow, but should never be reached
    const res = makeRes();
    await requirePermission('finance', 'add')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    // Role query should NOT have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('user row allow grants access without checking role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ can_delete: true }] });
    const next = vi.fn();
    await requirePermission('inventory', 'delete')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

// ── Fail-closed when no config exists ─────────────────────────────────────────
// Inverted 2026-07-19. These previously asserted passthrough "for backward
// compat", which is precisely what left maintenance/iot/rd/compliance/assets
// open to every authenticated user — they had no rows at all. See H-2.

describe('fail-closed when no permission config exists', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    delete process.env.PERMISSION_FAIL_OPEN;
  });

  test('module with no rows in either table → 403, next() NOT called', async () => {
    setupPassthrough();
    const next = vi.fn();
    const res  = makeRes();
    await requirePermission('legacy_module', 'view')(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PERMISSION_NOT_CONFIGURED', module: 'legacy_module' })
    );
  });

  test('PERMISSION_FAIL_OPEN=true reopens it as an emergency hatch', async () => {
    process.env.PERMISSION_FAIL_OPEN = 'true';
    setupPassthrough();
    const next = vi.fn();
    await requirePermission('legacy_module', 'view')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
    delete process.env.PERMISSION_FAIL_OPEN;
  });

  test('PERMISSION_STRICT is no longer consulted — strict is the default', async () => {
    process.env.PERMISSION_STRICT = 'false';   // must NOT reopen access
    setupPassthrough();
    const next = vi.fn();
    const res  = makeRes();
    await requirePermission('legacy_module', 'view')(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    delete process.env.PERMISSION_STRICT;
  });
});
