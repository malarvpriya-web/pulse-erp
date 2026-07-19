/**
 * Phase 3 — Final Test Gate
 *
 * Test suites (all unit — mocked DB, no live connections required):
 *   P3-1  RBAC matrix: 7 modules × 6 actions + override priority + cache
 *   P3-2  Workflow service: disabled-flag paths + status / pending / cancel
 *   P3-3  Validation engine: boundary conditions + disabled flag + validateField
 *   P3-4  Rule engine: all 10 operators + disabled flag + getRulesForModule
 *   P3-5  Notification triggers: all 5 events + direction + disabled flag + missing userId
 *
 * Run:  npx vitest run src/__tests__/phase3.test.js
 */

import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockQuery  = vi.hoisted(() => vi.fn());
const mockClient = vi.hoisted(() => ({
  query:   vi.fn(),
  release: vi.fn(),
}));

/**
 * Mutable (not frozen) flags object so individual tests can flip flags without
 * reloading modules. The real flags object is frozen; this mock is not.
 */
const mockFlags = vi.hoisted(() => ({
  WORKFLOW_ENGINE_ENABLED:     true,
  RULE_ENGINE_ENABLED:         true,
  VALIDATION_ENGINE_ENABLED:   true,
  NOTIFICATION_ENGINE_ENABLED: true,
}));

const mockIncrement      = vi.hoisted(() => vi.fn());
const mockGetCorrelation = vi.hoisted(() => vi.fn().mockReturnValue('test-cid-phase3'));

vi.mock('../config/db.js', () => ({
  default: {
    query:   mockQuery,
    connect: vi.fn().mockResolvedValue(mockClient),
  },
}));
vi.mock('../config/featureFlags.js',       () => ({ flags: mockFlags }));
vi.mock('../config/metrics.js',            () => ({ increment: mockIncrement, snapshot: vi.fn().mockReturnValue({}) }));
vi.mock('../middlewares/correlationContext.js', () => ({ getCorrelationId: mockGetCorrelation }));

// ── Audit repository mock (used by WorkflowService via AuditService) ───────────
const mockAuditCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 1 }));
vi.mock('../modules/audit/repositories/audit.repository.js', () => ({
  default: { create: mockAuditCreate },
}));

// ── Static imports ────────────────────────────────────────────────────────────

import { requirePermission }    from '../middlewares/auth.middleware.js';
import {
  initiateWorkflow,
  advanceWorkflow,
  getWorkflowStatus,
  getPendingApprovals,
  cancelWorkflow,
  WorkflowClosedError,
  InvalidTransitionError,
  UnauthorizedTransitionError,
}                               from '../services/WorkflowService.js';
import { validate, validateField } from '../services/ValidationEngineService.js';
import { evaluateRules, getRulesForModule } from '../services/RuleEngineService.js';
import { notifyWorkflowEvent, EVENT_MAP } from '../services/WorkflowNotificationService.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

const makeReq = (userId = 1, role = 'manager') => ({ user: { userId, role } });
const makeRes = () => {
  const r = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json   = vi.fn().mockReturnValue(r);
  return r;
};
const qOnce  = (rows) => mockQuery.mockResolvedValueOnce({ rows });

/**
 * Flush setImmediate queue (used by notifyWorkflowEvent fire-and-forget).
 * One tick is enough because setImmediate fires after all I/O events in the
 * current event-loop iteration.
 */
const flushImmediate = () => new Promise(resolve => setImmediate(resolve));

// ── P3-1: RBAC Full Matrix ───────────────────────────────────────────────────
//
// Gaps that the existing permissions.test.js does NOT cover:
//   • export action (all 7 modules)
//   • approve action for the 5 modules not listed as finance/leaves
//   • user-level override edge cases
//   • 403 schema completeness for every field
//
// Full matrix (7 modules × 6 actions) is exercised via test.each below.
// ─────────────────────────────────────────────────────────────────────────────

const ALL_MODULES = ['leaves', 'projects', 'inventory', 'finance', 'service', 'crm', 'hr'];
const ALL_ACTIONS = ['view', 'add', 'edit', 'delete', 'approve', 'export'];

/** Simulate no user row, role row grants the column. */
const setupAllow = (col) => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ [col]: true }] });
};

/** Simulate no user row, role row denies. */
const setupDeny = (col) => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ [col]: false }] });
};

/** The column name that requirePermission resolves each alias to. */
const COL = {
  view:    'can_view',
  add:     'can_add',
  edit:    'can_edit',
  delete:  'can_delete',
  approve: 'can_approve',
  export:  'can_export',
};

describe('P3-1 RBAC matrix — 7 modules × 6 actions', () => {
  beforeEach(() => mockQuery.mockReset());

  // Allow path — role grants the action
  describe.each(ALL_MODULES.map(m => [m]))('module: %s — allow paths', (module) => {
    test.each(ALL_ACTIONS.map(a => [a]))('action %s — allowed role calls next()', async (action) => {
      setupAllow(COL[action]);
      const next = vi.fn();
      await requirePermission(module, action)(makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });
  });

  // Deny path — role explicitly denies
  describe.each(ALL_MODULES.map(m => [m]))('module: %s — deny paths', (module) => {
    test.each(ALL_ACTIONS.map(a => [a]))('action %s — denied role returns 403', async (action) => {
      setupDeny(COL[action]);
      const res = makeRes();
      await requirePermission(module, action)(makeReq(), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  // export action: 403 body references can_export (not a shorthand alias previously tested)
  test.each(ALL_MODULES.map(m => [m]))('export denied on %s — body.action is "can_export"', async (module) => {
    setupDeny('can_export');
    const res = makeRes();
    await requirePermission(module, 'export')(makeReq(), res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ action: 'can_export' }));
  });
});

describe('P3-1 RBAC — user-level override priority', () => {
  beforeEach(() => mockQuery.mockReset());

  test('user-level deny overrides role-level allow — 403 returned, role not queried', async () => {
    // First query = user-level: can_export = false
    mockQuery.mockResolvedValueOnce({ rows: [{ can_export: false }] });
    const res = makeRes();
    await requirePermission('finance', 'export')(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    // Role query never issued (user override short-circuits)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('user-level allow overrides — next() called, role not queried', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ can_export: true }] });
    const next = vi.fn();
    await requirePermission('crm', 'export')(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // Inverted 2026-07-19 — see H-2. A module added without a matrix entry is now
  // denied, which is the whole point: `new_module` is exactly the scenario that
  // shipped maintenance/iot/rd/compliance/assets wide open.
  test('no config in either table → 403 (fail closed)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // user-level: no row
      .mockResolvedValueOnce({ rows: [] }); // role-level: no row
    const next = vi.fn();
    const res  = makeRes();
    await requirePermission('new_module', 'view')(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('P3-1 RBAC — 403 schema completeness', () => {
  beforeEach(() => mockQuery.mockReset());

  test.each(ALL_MODULES.map(m => [m]))('%s — 403 body has all required fields', async (module) => {
    setupDeny('can_delete');
    const res = makeRes();
    await requirePermission(module, 'delete')(makeReq(), res, vi.fn());
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      error:   expect.any(String),
      code:    'PERMISSION_DENIED',
      module,
      action:  'can_delete',
      message: expect.any(String),
    });
  });
});

describe('P3-1 RBAC — per-request cache', () => {
  beforeEach(() => mockQuery.mockReset());

  test('same req + same module: second call hits cache, zero extra DB queries', async () => {
    setupAllow('can_view');
    const req = makeReq();
    await requirePermission('inventory', 'view')(req, makeRes(), vi.fn());
    expect(mockQuery).toHaveBeenCalledTimes(2);   // cold: 2 queries

    mockQuery.mockReset();
    await requirePermission('inventory', 'view')(req, makeRes(), vi.fn());
    expect(mockQuery).not.toHaveBeenCalled();     // warm cache: 0 queries
  });

  test('same req + different modules: each module still queries separately', async () => {
    const req = makeReq();
    setupAllow('can_view');
    await requirePermission('crm', 'view')(req, makeRes(), vi.fn());
    expect(mockQuery).toHaveBeenCalledTimes(2);

    mockQuery.mockReset();
    setupAllow('can_view');
    await requirePermission('hr', 'view')(req, makeRes(), vi.fn());
    expect(mockQuery).toHaveBeenCalledTimes(2);  // separate module → fresh query
  });
});

// ── P3-2: Workflow Service ────────────────────────────────────────────────────

const WF_INST = {
  id: 99, status: 'pending', workflow_id: 1, module: 'leaves',
  entity_id: 42, entity_type: 'leave_request', initiated_by: 5,
  current_step_id: 5,
  current_step_role: 'manager',
  current_step_order: 1,
  current_step_name: 'Manager Approval',
};
const TRANS_NEXT     = { from_step_id: 5, to_step_id: 6, workflow_id: 1, action: 'approve', outcome: 'in_progress', to_step_order: 2 };
const TRANS_REJECT   = { from_step_id: 5, to_step_id: null, workflow_id: 1, action: 'reject', outcome: 'rejected', to_step_order: null };
const TRANS_TERMINAL = { from_step_id: 5, to_step_id: null, workflow_id: 1, action: 'approve', outcome: 'approved', to_step_order: null };

describe('P3-2 Workflow — disabled-flag short-circuits', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    mockFlags.WORKFLOW_ENGINE_ENABLED = false;
  });
  afterEach(() => { mockFlags.WORKFLOW_ENGINE_ENABLED = true; });

  test('initiateWorkflow returns null when engine disabled', async () => {
    const result = await initiateWorkflow('leaves', 1, 'leave_request', 10);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('getWorkflowStatus returns null when engine disabled', async () => {
    const result = await getWorkflowStatus('leaves', 1);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('getPendingApprovals returns [] when engine disabled', async () => {
    const result = await getPendingApprovals('manager');
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('cancelWorkflow returns false when engine disabled', async () => {
    const result = await cancelWorkflow('leaves', 1);
    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('advanceWorkflow returns passthrough object when engine disabled', async () => {
    const result = await advanceWorkflow(99, 'approve', 10, '', 'manager');
    expect(result).toMatchObject({ status: 'passthrough', outcome: 'passthrough' });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('P3-2 Workflow — getWorkflowStatus', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.WORKFLOW_ENGINE_ENABLED = true; });

  test('returns the most recent instance row for module+entity', async () => {
    qOnce([{ ...WF_INST, current_step_name: 'Manager Approval', current_step_role: 'manager', workflow_name: 'Leave Flow' }]);
    const result = await getWorkflowStatus('leaves', 42);
    expect(result).toMatchObject({ id: 99, status: 'pending', module: 'leaves' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('returns null when no instance exists', async () => {
    qOnce([]);
    const result = await getWorkflowStatus('leaves', 999);
    expect(result).toBeNull();
  });
});

describe('P3-2 Workflow — getPendingApprovals', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.WORKFLOW_ENGINE_ENABLED = true; });

  test('returns pending steps assigned to the given role', async () => {
    const rows = [
      { instance_step_id: 1, instance_id: 99, module: 'leaves', entity_id: 42, step_name: 'Manager Approval', assignee_role: 'manager' },
      { instance_step_id: 2, instance_id: 100, module: 'finance', entity_id: 7, step_name: 'CFO Review', assignee_role: 'manager' },
    ];
    qOnce(rows);
    const result = await getPendingApprovals('manager');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ module: 'leaves', assignee_role: 'manager' });
  });

  test('returns empty array when no pending items for role', async () => {
    qOnce([]);
    const result = await getPendingApprovals('employee');
    expect(result).toEqual([]);
  });
});

describe('P3-2 Workflow — cancelWorkflow', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.WORKFLOW_ENGINE_ENABLED = true; });

  test('returns true and cancels when an open instance exists', async () => {
    qOnce([{ id: 99 }]); // RETURNING id — 1 row updated
    const result = await cancelWorkflow('leaves', 42);
    expect(result).toBe(true);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE workflow_instances/);
    expect(sql).toMatch(/cancelled/);
  });

  test('returns false when no open instance to cancel (already terminal)', async () => {
    qOnce([]); // 0 rows updated
    const result = await cancelWorkflow('leaves', 42);
    expect(result).toBe(false);
  });
});

describe('P3-2 Workflow — advanceWorkflow additional paths', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    mockClient.query.mockResolvedValue({ rows: [] });
    mockFlags.WORKFLOW_ENGINE_ENABLED = true;
  });

  test('reject action — closes step with "rejected" status and returns rejected outcome', async () => {
    qOnce([WF_INST]);
    qOnce([TRANS_REJECT]);
    const result = await advanceWorkflow(99, 'reject', 10, 'Budget exceeded', 'manager');
    expect(result).toMatchObject({ status: 'rejected', outcome: 'rejected', instanceId: 99 });
    const sqls = mockClient.query.mock.calls.map(c => c[0]);
    const updateStep = sqls.find(s => typeof s === 'string' && s.includes('UPDATE workflow_instance_steps'));
    expect(updateStep).toBeDefined();
  });

  test('reject action — triggers "rejected" notification (fire-and-forget)', async () => {
    qOnce([WF_INST]);
    qOnce([TRANS_REJECT]);
    await advanceWorkflow(99, 'reject', 10, 'Too many days', 'manager');
    await flushImmediate();
    // Notification insert should have been called for the submitter
    const notifyCall = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(notifyCall).toBeDefined();
    // The notification should reference the leave entity
    expect(notifyCall[1]).toContain(WF_INST.initiated_by); // submitter user id
  });

  test('approve terminal — fires "approved" notification for submitter', async () => {
    qOnce([WF_INST]);
    qOnce([TRANS_TERMINAL]);
    await advanceWorkflow(99, 'approve', 10, '', 'manager');
    await flushImmediate();
    const notifyCall = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(notifyCall).toBeDefined();
  });

  test('audit log is written after a successful transition', async () => {
    mockAuditCreate.mockReset().mockResolvedValue({ id: 99 });
    qOnce([WF_INST]);
    qOnce([TRANS_NEXT]);
    await advanceWorkflow(99, 'approve', 10, '', 'manager');
    // AuditService is fire-and-forget too — flush microtasks
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockAuditCreate).toHaveBeenCalledOnce();
    const call = mockAuditCreate.mock.calls[0][0];
    expect(call.action_type).toBe('workflow_transition');
    expect(call.new_data_json).toMatchObject({ action: 'approve', outcome: 'in_progress' });
  });
});

// ── P3-3: Validation Engine ───────────────────────────────────────────────────

const vRule = (field_name, rule_expr, error_message = null) => ({
  id: 1, module: 'test', field_name, rule_expr, error_message, is_active: true,
});

describe('P3-3 Validation — disabled-flag passthrough', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFlags.VALIDATION_ENGINE_ENABLED = false;
  });
  afterEach(() => { mockFlags.VALIDATION_ENGINE_ENABLED = true; });

  test('validate returns { valid: true, errors: [] } without querying DB', async () => {
    const result = await validate('leaves', { leave_name: '' });
    expect(result).toEqual({ valid: true, errors: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('validateField returns { valid: true, errors: [] } without querying DB', async () => {
    const result = await validateField('leaves', 'leave_name', '');
    expect(result).toEqual({ valid: true, errors: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('P3-3 Validation — boundary conditions', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.VALIDATION_ENGINE_ENABLED = true; });

  test('min_length: passes when string length exactly equals min_length', async () => {
    qOnce([vRule('code', { min_length: 4 }, 'Too short')]);
    const { valid } = await validate('test', { code: 'ABCD' }); // length = 4
    expect(valid).toBe(true);
  });

  test('min_length: fails when string length is one below min_length', async () => {
    qOnce([vRule('code', { min_length: 4 }, 'Too short')]);
    const { valid, errors } = await validate('test', { code: 'ABC' }); // length = 3
    expect(valid).toBe(false);
    expect(errors[0].message).toBe('Too short');
  });

  test('max_length: passes when string length exactly equals max_length', async () => {
    qOnce([vRule('notes', { max_length: 5 })]);
    const { valid } = await validate('test', { notes: '12345' }); // length = 5
    expect(valid).toBe(true);
  });

  test('max_length: fails when string length is one above max_length', async () => {
    qOnce([vRule('notes', { max_length: 5 })]);
    const { valid } = await validate('test', { notes: '123456' }); // length = 6
    expect(valid).toBe(false);
  });

  test('min numeric: passes when value exactly equals min', async () => {
    qOnce([vRule('qty', { min: 1 })]);
    const { valid } = await validate('test', { qty: 1 });
    expect(valid).toBe(true);
  });

  test('max numeric: passes when value exactly equals max', async () => {
    qOnce([vRule('qty', { max: 30 })]);
    const { valid } = await validate('test', { qty: 30 });
    expect(valid).toBe(true);
  });

  test('required: fails on whitespace-only string', async () => {
    qOnce([vRule('name', { required: true }, 'Name required')]);
    const { valid, errors } = await validate('test', { name: '   ' });
    expect(valid).toBe(false);
    expect(errors[0].field).toBe('name');
  });

  test('invalid regex in DB is silently skipped — validation passes', async () => {
    qOnce([vRule('field', { pattern: '[invalid(' })]);
    const { valid } = await validate('test', { field: 'anything' });
    expect(valid).toBe(true); // invalid regex → rule skipped
  });

  test('multiple constraints on one field — all are evaluated independently', async () => {
    qOnce([
      vRule('email', { required: true },  'Email required'),
      vRule('email', { min_length: 5 },   'Email too short'),
      vRule('email', { pattern: '.+@.+' }, 'Invalid email'),
    ]);
    const { valid, errors } = await validate('test', { email: '' });
    expect(valid).toBe(false);
    // required fails; min_length fails (empty); pattern fails
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('P3-3 Validation — validateField', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.VALIDATION_ENGINE_ENABLED = true; });

  test('returns { valid: true, errors: [] } when rule passes', async () => {
    qOnce([vRule('pan', { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' })]);
    const result = await validateField('hr', 'pan', 'ABCDE1234F');
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('returns errors as plain strings, not { field, message } objects', async () => {
    qOnce([vRule('pan', { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' }, 'Invalid PAN')]);
    const { valid, errors } = await validateField('hr', 'pan', 'bad-value');
    expect(valid).toBe(false);
    expect(typeof errors[0]).toBe('string');
    expect(errors[0]).toBe('Invalid PAN');
  });

  test('multiple rules on one field — all error strings collected', async () => {
    qOnce([
      vRule('phone', { min_length: 10 }, 'Too short'),
      vRule('phone', { pattern: '^[0-9]+$' }, 'Digits only'),
    ]);
    const { errors } = await validateField('hr', 'phone', 'abc');
    expect(errors.length).toBe(2);
    expect(errors).toContain('Too short');
    expect(errors).toContain('Digits only');
  });
});

// ── P3-4: Rule Engine ────────────────────────────────────────────────────────

const bRule = (code, condition_expr, action_expr) => ({
  id: 1, module: 'test', name: code, code, rule_type: 'alert',
  condition_expr, action_expr, priority: 1, is_active: true,
});

describe('P3-4 Rule Engine — disabled-flag passthrough', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFlags.RULE_ENGINE_ENABLED = false;
  });
  afterEach(() => { mockFlags.RULE_ENGINE_ENABLED = true; });

  test('evaluateRules returns [] without querying DB', async () => {
    const result = await evaluateRules('inventory', { qty: 0 });
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('getRulesForModule returns [] without querying DB', async () => {
    const result = await getRulesForModule('inventory');
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('P3-4 Rule Engine — all 10 operators', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.RULE_ENGINE_ENABLED = true; });

  const ACTION = { severity: 'warning', message_template: 'Rule triggered' };

  test('lt — triggers when lhs < rhs', async () => {
    qOnce([bRule('R', { field: 'qty', operator: 'lt', value: 10 }, ACTION)]);
    const [r] = await evaluateRules('test', { qty: 5 });
    expect(r.triggered).toBe(true);
  });

  test('lt — does not trigger when lhs >= rhs', async () => {
    qOnce([bRule('R', { field: 'qty', operator: 'lt', value: 10 }, ACTION)]);
    const [r] = await evaluateRules('test', { qty: 10 });
    expect(r.triggered).toBe(false);
  });

  test('lte — triggers at exact boundary (lhs === rhs)', async () => {
    qOnce([bRule('R', { field: 'qty', operator: 'lte', value: 10 }, ACTION)]);
    const [r] = await evaluateRules('test', { qty: 10 });
    expect(r.triggered).toBe(true);
  });

  test('gt — triggers when lhs > rhs', async () => {
    qOnce([bRule('R', { field: 'overdue', operator: 'gt', value: 30 }, ACTION)]);
    const [r] = await evaluateRules('test', { overdue: 31 });
    expect(r.triggered).toBe(true);
  });

  test('gte — triggers at exact boundary (lhs === rhs)', async () => {
    qOnce([bRule('R', { field: 'score', operator: 'gte', value: 80 }, ACTION)]);
    const [r] = await evaluateRules('test', { score: 80 });
    expect(r.triggered).toBe(true);
  });

  test('eq — triggers on string equality', async () => {
    qOnce([bRule('R', { field: 'status', operator: 'eq', value: 'blocked' }, ACTION)]);
    const [r] = await evaluateRules('test', { status: 'blocked' });
    expect(r.triggered).toBe(true);
  });

  test('eq — does not trigger on mismatch', async () => {
    qOnce([bRule('R', { field: 'status', operator: 'eq', value: 'blocked' }, ACTION)]);
    const [r] = await evaluateRules('test', { status: 'active' });
    expect(r.triggered).toBe(false);
  });

  test('neq — triggers when values differ', async () => {
    qOnce([bRule('R', { field: 'status', operator: 'neq', value: 'active' }, ACTION)]);
    const [r] = await evaluateRules('test', { status: 'blocked' });
    expect(r.triggered).toBe(true);
  });

  test('in — triggers when lhs is in the array', async () => {
    qOnce([bRule('R', { field: 'type', operator: 'in', value: ['A', 'B', 'C'] }, ACTION)]);
    const [r] = await evaluateRules('test', { type: 'B' });
    expect(r.triggered).toBe(true);
  });

  test('in — does not trigger when lhs is outside the array', async () => {
    qOnce([bRule('R', { field: 'type', operator: 'in', value: ['A', 'B'] }, ACTION)]);
    const [r] = await evaluateRules('test', { type: 'Z' });
    expect(r.triggered).toBe(false);
  });

  test('nin — triggers when lhs is NOT in the array', async () => {
    qOnce([bRule('R', { field: 'region', operator: 'nin', value: ['EU', 'US'] }, ACTION)]);
    const [r] = await evaluateRules('test', { region: 'APAC' });
    expect(r.triggered).toBe(true);
  });

  test('nin — does not trigger when lhs is in the exclusion list', async () => {
    qOnce([bRule('R', { field: 'region', operator: 'nin', value: ['EU', 'US'] }, ACTION)]);
    const [r] = await evaluateRules('test', { region: 'EU' });
    expect(r.triggered).toBe(false);
  });

  test('null — triggers when field is undefined', async () => {
    qOnce([bRule('R', { field: 'deleted_at', operator: 'null' }, ACTION)]);
    const [r] = await evaluateRules('test', {}); // field not present
    expect(r.triggered).toBe(true);
  });

  test('null — does not trigger when field has a value', async () => {
    qOnce([bRule('R', { field: 'deleted_at', operator: 'null' }, ACTION)]);
    const [r] = await evaluateRules('test', { deleted_at: '2026-01-01' });
    expect(r.triggered).toBe(false);
  });

  test('notnull — triggers when field is present', async () => {
    qOnce([bRule('R', { field: 'manager_id', operator: 'notnull' }, ACTION)]);
    const [r] = await evaluateRules('test', { manager_id: 7 });
    expect(r.triggered).toBe(true);
  });

  test('notnull — does not trigger when field is null', async () => {
    qOnce([bRule('R', { field: 'manager_id', operator: 'notnull' }, ACTION)]);
    const [r] = await evaluateRules('test', { manager_id: null });
    expect(r.triggered).toBe(false);
  });
});

describe('P3-4 Rule Engine — value_field cross-field comparison', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.RULE_ENGINE_ENABLED = true; });

  const ACTION = { severity: 'warning', message_template: 'Stock low for {{item_name}}' };

  test('lte with value_field — triggers when qty <= reorder_point', async () => {
    qOnce([bRule('LOW_STOCK', { field: 'qty', operator: 'lte', value_field: 'reorder_point' }, ACTION)]);
    const [r] = await evaluateRules('inventory', { qty: 10, reorder_point: 50, item_name: 'Widget' });
    expect(r.triggered).toBe(true);
    expect(r.message).toBe('Stock low for Widget');
  });

  test('lte with value_field — does not trigger when qty > reorder_point', async () => {
    qOnce([bRule('LOW_STOCK', { field: 'qty', operator: 'lte', value_field: 'reorder_point' }, ACTION)]);
    const [r] = await evaluateRules('inventory', { qty: 100, reorder_point: 50, item_name: 'Widget' });
    expect(r.triggered).toBe(false);
    expect(r.message).toBeNull();
    expect(r.severity).toBeNull();
  });

  test('message interpolation fills all {{field}} placeholders', async () => {
    qOnce([bRule('OVERDUE', { field: 'days', operator: 'gt', value: 0 },
      { severity: 'error', message_template: 'Invoice {{inv_no}} overdue by {{days}} days' }
    )]);
    const [r] = await evaluateRules('finance', { days: 45, inv_no: 'INV-2026-001' });
    expect(r.triggered).toBe(true);
    expect(r.message).toBe('Invoice INV-2026-001 overdue by 45 days');
  });
});

describe('P3-4 Rule Engine — getRulesForModule', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.RULE_ENGINE_ENABLED = true; });

  test('returns active rules for a module', async () => {
    qOnce([
      { id: 1, name: 'LOW_STOCK', code: 'LOW_STOCK', rule_type: 'alert', priority: 1 },
      { id: 2, name: 'CRITICAL_STOCK', code: 'CRITICAL_STOCK', rule_type: 'alert', priority: 2 },
    ]);
    const rules = await getRulesForModule('inventory');
    expect(rules).toHaveLength(2);
    expect(rules[0].code).toBe('LOW_STOCK');
  });

  test('returns empty array when no rules configured', async () => {
    qOnce([]);
    const rules = await getRulesForModule('unknown_module');
    expect(rules).toEqual([]);
  });
});

// ── P3-5: Notification Triggers ───────────────────────────────────────────────
//
// WorkflowNotificationService — not covered by any existing test file.
// Tests verify EVENT_MAP correctness, notification direction, disabled-flag
// short-circuit, missing userId guard, and correct INSERT SQL parameters.
//
// notifyWorkflowEvent uses setImmediate (fire-and-forget) — use flushImmediate()
// to advance the event loop before asserting on pool.query calls.
// ─────────────────────────────────────────────────────────────────────────────

describe('P3-5 Notifications — EVENT_MAP structure', () => {
  test('EVENT_MAP has all 5 required event keys', () => {
    const keys = Object.keys(EVENT_MAP).sort();
    expect(keys).toEqual(expect.arrayContaining(['approved', 'escalated', 'overdue', 'rejected', 'submitted']));
  });

  test.each([
    ['submitted', 'submitter', 'approval'],
    ['approved',  'submitter', 'success'],
    ['rejected',  'submitter', 'warning'],
    ['escalated', 'approver',  'alert'],
    ['overdue',   'approver',  'warning'],
  ])('%s — notify="%s", type="%s"', (event, notify, type) => {
    expect(EVENT_MAP[event].notify).toBe(notify);
    expect(EVENT_MAP[event].notification_type).toBe(type);
  });

  test.each(['submitted', 'approved', 'rejected', 'escalated', 'overdue'])(
    '%s — title and message are functions of ctx',
    (event) => {
      const ctx = { module: 'Leave', recordId: 42 };
      expect(typeof EVENT_MAP[event].title(ctx)).toBe('string');
      expect(typeof EVENT_MAP[event].message(ctx)).toBe('string');
      expect(EVENT_MAP[event].title(ctx)).toContain('Leave');
    }
  );

  test('rejected message includes rejection reason when comments provided', () => {
    const ctx = { module: 'Leave', recordId: 7, comments: 'Quota exhausted' };
    const msg = EVENT_MAP.rejected.message(ctx);
    expect(msg).toContain('Quota exhausted');
  });

  test('rejected message is graceful when no comments provided', () => {
    const ctx = { module: 'Leave', recordId: 7 };
    const msg = EVENT_MAP.rejected.message(ctx);
    expect(msg).toBeTruthy();
    expect(msg).not.toContain('undefined');
  });
});

describe('P3-5 Notifications — notifyWorkflowEvent disabled flag', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFlags.NOTIFICATION_ENGINE_ENABLED = false;
  });
  afterEach(() => { mockFlags.NOTIFICATION_ENGINE_ENABLED = true; });

  test('returns immediately without scheduling setImmediate when flag is off', async () => {
    notifyWorkflowEvent('submitted', { module: 'Leave', recordId: 1, submitterUserId: 5 });
    await flushImmediate();
    const notifyCalls = mockQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(notifyCalls).toHaveLength(0);
  });
});

describe('P3-5 Notifications — unknown event is a no-op', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.NOTIFICATION_ENGINE_ENABLED = true; });

  test('unknown event type does not insert or throw', async () => {
    notifyWorkflowEvent('nonexistent_event', { module: 'Leave', recordId: 1, submitterUserId: 5 });
    await flushImmediate();
    const notifyCalls = mockQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(notifyCalls).toHaveLength(0);
  });
});

describe('P3-5 Notifications — missing target userId guard', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.NOTIFICATION_ENGINE_ENABLED = true; });

  test('submitted: no insert when submitterUserId is undefined', async () => {
    notifyWorkflowEvent('submitted', { module: 'Leave', recordId: 1 }); // no submitterUserId
    await flushImmediate();
    const notifyCalls = mockQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(notifyCalls).toHaveLength(0);
  });

  test('escalated: no insert when approverUserId is undefined', async () => {
    notifyWorkflowEvent('escalated', { module: 'Leave', recordId: 1 }); // no approverUserId
    await flushImmediate();
    const notifyCalls = mockQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(notifyCalls).toHaveLength(0);
  });

  test('overdue: no insert when approverUserId is undefined', async () => {
    notifyWorkflowEvent('overdue', { module: 'Leave', recordId: 1 });
    await flushImmediate();
    const notifyCalls = mockQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(notifyCalls).toHaveLength(0);
  });
});

describe('P3-5 Notifications — correct INSERT parameters', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.NOTIFICATION_ENGINE_ENABLED = true; });

  test('submitted — inserts for submitter with correct title/message/type', async () => {
    mockQuery.mockResolvedValue({ rows: [] }); // INSERT succeeds

    notifyWorkflowEvent('submitted', {
      module: 'Leave',
      recordId: 42,
      submitterUserId: 5,
    });
    await flushImmediate();

    const call = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(call).toBeDefined();
    const [, params] = call;
    expect(params[0]).toBe(5);                         // user_id = submitter
    expect(params[1]).toContain('Leave');              // title
    expect(params[2]).toContain('#42');                // message contains recordId
    expect(params[3]).toBe('Leave');                   // module_name
    expect(params[4]).toBe(42);                        // reference_id
    expect(params[5]).toBe('approval');                // notification_type
  });

  test('approved — inserts for submitter with type "success"', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    notifyWorkflowEvent('approved', { module: 'PO', recordId: 7, submitterUserId: 3 });
    await flushImmediate();

    const call = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    const [, params] = call;
    expect(params[0]).toBe(3);          // submitter receives it
    expect(params[5]).toBe('success');
  });

  test('rejected — inserts for submitter with type "warning" and reason in message', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    notifyWorkflowEvent('rejected', {
      module: 'Leave',
      recordId: 11,
      submitterUserId: 6,
      comments: 'Quota exhausted',
    });
    await flushImmediate();

    const call = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    const [, params] = call;
    expect(params[0]).toBe(6);                         // submitter
    expect(params[2]).toContain('Quota exhausted');    // reason in message
    expect(params[5]).toBe('warning');
  });

  test('escalated — inserts for approver (not submitter) with type "alert"', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    notifyWorkflowEvent('escalated', {
      module: 'Finance',
      recordId: 99,
      submitterUserId: 10,
      approverUserId: 20,
    });
    await flushImmediate();

    const call = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    const [, params] = call;
    expect(params[0]).toBe(20);   // approver receives escalation
    expect(params[5]).toBe('alert');
  });

  test('overdue — inserts for approver (not submitter) with type "warning"', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    notifyWorkflowEvent('overdue', {
      module: 'Leave',
      recordId: 88,
      submitterUserId: 15,
      approverUserId: 25,
    });
    await flushImmediate();

    const call = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    const [, params] = call;
    expect(params[0]).toBe(25);  // approver
    expect(params[5]).toBe('warning');
  });
});

describe('P3-5 Notifications — fire-and-forget guarantees', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFlags.NOTIFICATION_ENGINE_ENABLED = true; });

  test('notifyWorkflowEvent returns synchronously (does not return a Promise)', () => {
    const ret = notifyWorkflowEvent('submitted', { module: 'Leave', recordId: 1, submitterUserId: 5 });
    expect(ret).toBeUndefined(); // void — not awaitable
  });

  test('pool.query failure in _insert is swallowed — caller sees no error', async () => {
    mockQuery.mockRejectedValue(new Error('DB down'));
    // Should not throw or reject
    notifyWorkflowEvent('submitted', { module: 'Leave', recordId: 1, submitterUserId: 5 });
    await expect(flushImmediate()).resolves.toBeUndefined();
  });
});
