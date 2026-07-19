/**
 * Phase 1 — Platform Foundation Tests
 * Runner: Vitest (globals: true — see vitest.config.js)
 *
 * Test groups:
 *  1. requirePermission middleware (unit — with mock pool)
 *  2. enforceScope middleware
 *  3. applyFieldPermissions middleware
 *  4. PermissionService.getMergedPermissions
 *  5. PermissionService.checkAccess
 *  6. Migration smoke (skip if no DB env vars set)
 *  7. Non-regression: existing exports still present
 *
 * Run:  npx vitest run src/__tests__/phase1.test.js
 */

import { vi, describe, test, expect, beforeEach, beforeAll } from 'vitest';

// ── Hoist the mock query so the factory can reference it ──────────────────────
// vi.hoisted runs before vi.mock() factories, guaranteeing the reference exists.
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('../config/db.js', () => ({
  default: { query: mockQuery },
}));

// ── Static imports — these receive the mocked pool automatically ──────────────
import {
  verifyToken,
  allowRoles,
  checkPermission,
  requirePermission,
  enforceScope,
  applyFieldPermissions,
} from '../middlewares/auth.middleware.js';

import {
  getMergedPermissions,
  checkAccess,
} from '../services/PermissionService.js';

// ── Shared helpers ────────────────────────────────────────────────────────────
const makeReq = (userId = 1, role = 'manager') => ({
  user: { userId, role },
  headers: {},
});

const makeRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json   = vi.fn().mockReturnValue(res);
  return res;
};

// ── 1. requirePermission middleware ──────────────────────────────────────────
describe('requirePermission middleware', () => {
  beforeEach(() => mockQuery.mockReset());

  test('rejects unknown action with 400', async () => {
    const mw  = requirePermission('leaves', 'can_fly');
    const res = makeRes();
    await mw(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('user-level ALLOW: user row has can_add=true → calls next()', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ can_add: true }] });
    const next = vi.fn();
    await requirePermission('leaves', 'can_add')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('user-level DENY: user row has can_delete=false → 403', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ can_delete: false }] });
    const res = makeRes();
    await requirePermission('leaves', 'can_delete')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('role-level ALLOW: no user row, role row has can_view=true → next()', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ can_view: true }] });
    const next = vi.fn();
    await requirePermission('projects', 'can_view')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('role-level DENY: no user row, role row has can_delete=false → 403', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ can_delete: false }] });
    const res = makeRes();
    await requirePermission('finance', 'can_delete')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // Inverted 2026-07-19 — see H-2. An unconfigured module now denies rather
  // than passing through; the previous "backward compat" passthrough is what
  // left five modules open to every authenticated user.
  test('fail-closed: no user row, no role row → 403, next() NOT called', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const next = vi.fn();
    const res  = makeRes();
    await requirePermission('legacy_module', 'can_view')(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ── 2. enforceScope middleware ────────────────────────────────────────────────
describe('enforceScope middleware', () => {
  beforeEach(() => mockQuery.mockReset());

  test('attaches company_id / branch_id when scope row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ company_id: 5, branch_id: 3 }] });
    const req  = { user: { userId: 1 } };
    const next = vi.fn();
    await enforceScope()(req, {}, next);
    expect(req.scope).toEqual({ company_id: 5, branch_id: 3 });
    expect(next).toHaveBeenCalled();
  });

  test('sets req.scope = null when no user_scope row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const req  = { user: { userId: 99 } };
    const next = vi.fn();
    await enforceScope()(req, {}, next);
    expect(req.scope).toBeNull();
    expect(next).toHaveBeenCalled();
  });
});

// ── 3. applyFieldPermissions ─────────────────────────────────────────────────
describe('applyFieldPermissions middleware', () => {
  beforeEach(() => mockQuery.mockReset());

  test('strips hidden fields from a plain object response', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ field_name: 'pan_number' }, { field_name: 'basic_salary' }],
    });
    const req  = { user: { role: 'employee' } };
    let captured;
    const res  = { json: vi.fn(d => { captured = d; }) };
    const next = vi.fn();

    await applyFieldPermissions('employees')(req, res, next);
    expect(next).toHaveBeenCalled();

    // res.json is now wrapped — calling it should mask hidden fields
    res.json({ id: 1, name: 'Alice', pan_number: 'ABCDE1234F', basic_salary: 50000 });
    expect(captured).not.toHaveProperty('pan_number');
    expect(captured).not.toHaveProperty('basic_salary');
    expect(captured).toHaveProperty('name', 'Alice');
  });

  test('strips hidden fields from array response', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ field_name: 'account_number' }] });
    const req  = { user: { role: 'employee' } };
    let captured;
    const res  = { json: vi.fn(d => { captured = d; }) };
    await applyFieldPermissions('employees')(req, res, vi.fn());
    res.json([{ id: 1, name: 'Bob', account_number: '123456' }]);
    expect(captured[0]).not.toHaveProperty('account_number');
    expect(captured[0]).toHaveProperty('name', 'Bob');
  });
});

// ── 4. PermissionService.getMergedPermissions ─────────────────────────────────
describe('PermissionService.getMergedPermissions', () => {
  beforeEach(() => mockQuery.mockReset());

  test('user-level override wins over role-level for same module', async () => {
    const userPerms = [{
      module: 'finance',
      can_view: true, can_add: false, can_edit: false,
      can_delete: false, can_approve: false, can_export: false,
    }];
    const rolePerms = [{
      module: 'finance',
      can_view: true, can_add: true, can_edit: true,
      can_delete: false, can_approve: true, can_export: true,
    }];
    mockQuery
      .mockResolvedValueOnce({ rows: userPerms })
      .mockResolvedValueOnce({ rows: rolePerms });

    const result = await getMergedPermissions(1, 'manager');
    // User-level wins: can_add should be false (user says false, role says true)
    expect(result['finance'].can_add).toBe(false);
    expect(result['finance'].source).toBe('user');
  });

  test('fills missing modules with deny-all', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getMergedPermissions(1, 'employee');
    expect(result['admin']).toMatchObject({ can_view: false, can_add: false, source: 'default' });
  });
});

// ── 5. PermissionService.checkAccess ─────────────────────────────────────────
describe('PermissionService.checkAccess', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns null for unconfigured module (no rows)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await checkAccess(1, 'employee', 'unknown_module', 'can_view');
    expect(result).toBeNull();
  });

  test('returns false for invalid action', async () => {
    // Invalid action short-circuits before any DB query
    const result = await checkAccess(1, 'admin', 'finance', 'can_fly');
    expect(result).toBe(false);
  });
});

// ── 6. Migration smoke (requires live DB — skip in unit mode) ─────────────────
// Always skipped when NODE_ENV=test (set by vitest setup.js).
// To run smoke tests against a real DB: NODE_ENV=development DATABASE_URL=<url> npx vitest run phase1
const SKIP_DB = process.env.NODE_ENV === 'test' || (!process.env.DATABASE_URL && !process.env.DB_NAME);

describe('Migration smoke tests', () => {
  // pool is only available in live-DB mode (SKIP_DB=false); otherwise tests are skipped.
  // NOTE: to run smoke tests, use a separate non-mocked test file or vitest workspace.
  let pool;

  beforeAll(async () => {
    if (SKIP_DB) return;
    // In live-DB mode, db.js is NOT mocked (vi.mock only applies when NODE_ENV=test).
    const mod = await import('../config/db.js');
    pool = mod.default;
  });

  const tableExists = async (name) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = 'public'`,
      [name]
    );
    return rows.length > 0;
  };

  const columnExists = async (table, col) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 AND table_schema = 'public'`,
      [table, col]
    );
    return rows.length > 0;
  };

  test.skipIf(SKIP_DB)('companies table exists', async () => {
    expect(await tableExists('companies')).toBe(true);
  });
  test.skipIf(SKIP_DB)('branches table exists', async () => {
    expect(await tableExists('branches')).toBe(true);
  });
  test.skipIf(SKIP_DB)('roles table exists and has 5 default rows', async () => {
    expect(await tableExists('roles')).toBe(true);
    const { rows } = await pool.query('SELECT count(*) FROM roles');
    expect(parseInt(rows[0].count)).toBeGreaterThanOrEqual(5);
  });
  test.skipIf(SKIP_DB)('role_permissions seeded for super_admin', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'super_admin'`
    );
    expect(parseInt(rows[0].count)).toBeGreaterThanOrEqual(20);
  });
  test.skipIf(SKIP_DB)('users.company_id column exists after migration 2', async () => {
    expect(await columnExists('users', 'company_id')).toBe(true);
  });
  test.skipIf(SKIP_DB)('employees.branch_id column exists after migration 2', async () => {
    expect(await columnExists('employees', 'branch_id')).toBe(true);
  });
  test.skipIf(SKIP_DB)('permissions table has correct shape', async () => {
    expect(await columnExists('permissions', 'can_approve')).toBe(true);
    expect(await columnExists('permissions', 'can_export')).toBe(true);
  });
  test.skipIf(SKIP_DB)('field_permissions seeded for employee role', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) FROM field_permissions fp JOIN roles r ON r.id = fp.role_id WHERE r.code = 'employee'`
    );
    expect(parseInt(rows[0].count)).toBeGreaterThanOrEqual(5);
  });
  test.skipIf(SKIP_DB)('master_values seeded with LEAVE_TYPE entries', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) FROM master_values WHERE type = 'LEAVE_TYPE'`
    );
    expect(parseInt(rows[0].count)).toBeGreaterThanOrEqual(4);
  });
});

// ── 7. Non-regression: existing exports still present ────────────────────────
describe('auth.middleware backward compat', () => {
  test('verifyToken, allowRoles, checkPermission still exported', () => {
    expect(typeof verifyToken).toBe('function');
    expect(typeof allowRoles).toBe('function');
    expect(typeof checkPermission).toBe('function');
    expect(typeof requirePermission).toBe('function');
    expect(typeof enforceScope).toBe('function');
    expect(typeof applyFieldPermissions).toBe('function');
  });
});
