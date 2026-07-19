/**
 * Phase 2 — Workflow + Rule + Validation Engine Tests
 * Runner: Vitest (globals: true)
 *
 * Test groups:
 *  1. WorkflowService — initiate
 *  2. WorkflowService — advance (approve path, reject path, terminal step)
 *  3. WorkflowService — getWorkflowStatus
 *  4. WorkflowService — getPendingApprovals
 *  5. RuleEngineService — evaluateRules (triggered / not triggered)
 *  6. ValidationEngineService — validate (pass / fail single / fail multiple)
 *  7. ValidationEngineService — validateField
 *  8. Non-regression: all services exported correctly
 *
 * Run:  npx vitest run src/__tests__/phase2.test.js
 */

import { vi, describe, test, expect, beforeEach } from 'vitest';

// ── Hoisted mock ──────────────────────────────────────────────────────────────
const mockQuery  = vi.hoisted(() => vi.fn());
const mockClient = vi.hoisted(() => ({
  query:   vi.fn(),
  release: vi.fn(),
}));

vi.mock('../config/db.js', () => ({
  default: {
    query:   mockQuery,
    connect: vi.fn().mockResolvedValue(mockClient),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import {
  initiateWorkflow,
  advanceWorkflow,
  getWorkflowStatus,
  getPendingApprovals,
  cancelWorkflow,
} from '../services/WorkflowService.js';

import {
  evaluateRules,
  getRulesForModule,
} from '../services/RuleEngineService.js';

import {
  validate,
  validateField,
} from '../services/ValidationEngineService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const qOnce = (rows) => mockQuery.mockResolvedValueOnce({ rows });
const cOnce = (rows) => mockClient.query.mockResolvedValueOnce({ rows });

// ── 1. WorkflowService.initiateWorkflow ───────────────────────────────────────
describe('WorkflowService.initiateWorkflow', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
  });

  test('returns null when no workflow configured for module', async () => {
    qOnce([]); // no workflow found
    const result = await initiateWorkflow('leaves', 1, 'leave_request', 10);
    expect(result).toBeNull();
  });

  test('creates instance + first step when workflow exists', async () => {
    qOnce([{ workflow_id: 1, first_step_id: 5 }]); // workflow lookup
    qOnce([{ id: 99, workflow_id: 1, module: 'leaves', entity_id: 1, status: 'pending', current_step_id: 5 }]); // INSERT instance
    qOnce([]); // INSERT instance step (no return needed)
    const inst = await initiateWorkflow('leaves', 1, 'leave_request', 10);
    expect(inst).toMatchObject({ id: 99, status: 'pending', current_step_id: 5 });
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

// ── 2. WorkflowService.advanceWorkflow ───────────────────────────────────────
describe('WorkflowService.advanceWorkflow', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    // BEGIN / COMMIT return no rows
    mockClient.query.mockResolvedValue({ rows: [] });
  });

  const mockInstance = { id: 99, status: 'pending', current_step_id: 5, workflow_id: 1 };
  const mockTransToNext = { from_step_id: 5, to_step_id: 6, action: 'approve', outcome: 'in_progress' };
  const mockTransTerminal = { from_step_id: 5, to_step_id: null, action: 'approve', outcome: 'approved' };

  test('throws when instance not found', async () => {
    qOnce([]); // no instance
    await expect(advanceWorkflow(99, 'approve', 1)).rejects.toThrow('not found');
  });

  test('throws when instance already completed', async () => {
    qOnce([{ ...mockInstance, status: 'approved' }]);
    await expect(advanceWorkflow(99, 'approve', 1)).rejects.toThrow('already approved');
  });

  test('throws when no matching transition', async () => {
    qOnce([mockInstance]); // instance
    qOnce([]);             // no transition
    await expect(advanceWorkflow(99, 'approve', 1)).rejects.toThrow('No transition');
  });

  test('advance to next step — returns in_progress', async () => {
    qOnce([mockInstance]);       // pool.query: get instance
    qOnce([mockTransToNext]);    // pool.query: get transition
    // client.query calls: BEGIN, UPDATE step, INSERT next step, UPDATE instance, COMMIT
    cOnce([]); // BEGIN
    cOnce([]); // UPDATE workflow_instance_steps
    cOnce([]); // INSERT next step
    cOnce([]); // UPDATE workflow_instances
    cOnce([]); // COMMIT

    const result = await advanceWorkflow(99, 'approve', 1, 'looks good');
    expect(result.status).toBe('in_progress');
    expect(result.outcome).toBe('in_progress');
    expect(mockClient.release).toHaveBeenCalled();
  });

  test('terminal transition — returns approved', async () => {
    qOnce([mockInstance]);
    qOnce([mockTransTerminal]);
    cOnce([]); // BEGIN
    cOnce([]); // UPDATE step
    cOnce([]); // UPDATE instance (terminal)
    cOnce([]); // COMMIT

    const result = await advanceWorkflow(99, 'approve', 1);
    expect(result.status).toBe('approved');
    expect(result.outcome).toBe('approved');
  });

  test('rollback on error', async () => {
    qOnce([mockInstance]);
    qOnce([mockTransToNext]);
    cOnce([]);                           // BEGIN
    mockClient.query.mockRejectedValueOnce(new Error('DB failure')); // UPDATE throws

    await expect(advanceWorkflow(99, 'approve', 1)).rejects.toThrow('DB failure');
    // ROLLBACK must have been called
    const calls = mockClient.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('ROLLBACK');
  });
});

// ── 3. WorkflowService.getWorkflowStatus ─────────────────────────────────────
describe('WorkflowService.getWorkflowStatus', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns null when no instance exists', async () => {
    qOnce([]);
    expect(await getWorkflowStatus('leaves', 1)).toBeNull();
  });

  test('returns enriched instance row', async () => {
    const row = {
      id: 5, module: 'leaves', entity_id: 1, status: 'pending',
      current_step_name: 'Manager Approval', current_step_role: 'manager',
    };
    qOnce([row]);
    expect(await getWorkflowStatus('leaves', 1)).toEqual(row);
  });
});

// ── 4. WorkflowService.getPendingApprovals ───────────────────────────────────
describe('WorkflowService.getPendingApprovals', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns empty array when nothing pending', async () => {
    qOnce([]);
    expect(await getPendingApprovals('manager')).toEqual([]);
  });

  test('returns pending items for the role', async () => {
    const rows = [
      { instance_id: 1, module: 'leaves', entity_id: 10, assignee_role: 'manager' },
      { instance_id: 2, module: 'leaves', entity_id: 11, assignee_role: 'manager' },
    ];
    qOnce(rows);
    const result = await getPendingApprovals('manager');
    expect(result).toHaveLength(2);
    expect(result[0].module).toBe('leaves');
  });
});

// ── 5. RuleEngineService.evaluateRules ────────────────────────────────────────
describe('RuleEngineService.evaluateRules', () => {
  beforeEach(() => mockQuery.mockReset());

  const lowStockRule = {
    code: 'inventory_low_stock',
    name: 'Inventory Low Stock Alert',
    condition_expr: { field: 'current_quantity', operator: 'lte', value_field: 'reorder_point' },
    action_expr: { type: 'notify', severity: 'warning', message_template: 'Item {{item_name}} is low' },
    priority: 10,
  };

  test('rule NOT triggered when condition is false', async () => {
    qOnce([lowStockRule]);
    const results = await evaluateRules('inventory', { current_quantity: 100, reorder_point: 10, item_name: 'Bolt' });
    expect(results[0].triggered).toBe(false);
    expect(results[0].message).toBeNull();
  });

  test('rule triggered when current_quantity <= reorder_point', async () => {
    qOnce([lowStockRule]);
    const results = await evaluateRules('inventory', { current_quantity: 5, reorder_point: 10, item_name: 'Bolt' });
    expect(results[0].triggered).toBe(true);
    expect(results[0].severity).toBe('warning');
    expect(results[0].message).toContain('Bolt');
  });

  test('handles value comparison (absolute number)', async () => {
    qOnce([{
      code: 'out_of_stock',
      name: 'Out of Stock',
      condition_expr: { field: 'current_quantity', operator: 'lte', value: 0 },
      action_expr: { severity: 'critical', message_template: '{{item_name}} out of stock' },
      priority: 1,
    }]);
    const results = await evaluateRules('inventory', { current_quantity: 0, item_name: 'Widget' });
    expect(results[0].triggered).toBe(true);
    expect(results[0].severity).toBe('critical');
  });

  test('returns empty array when no rules configured', async () => {
    qOnce([]);
    const results = await evaluateRules('unknown_module', {});
    expect(results).toEqual([]);
  });
});

// ── 6. ValidationEngineService.validate ──────────────────────────────────────
describe('ValidationEngineService.validate', () => {
  beforeEach(() => mockQuery.mockReset());

  test('passes when all rules satisfied', async () => {
    qOnce([
      { field_name: 'reason', rule_expr: { required: true, min_length: 3 }, error_message: 'Reason required' },
      { field_name: 'days',   rule_expr: { min: 1 },                        error_message: 'Min 1 day' },
    ]);
    const result = await validate('leaves', { reason: 'Family emergency', days: 2 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('fails with error on missing required field', async () => {
    qOnce([{ field_name: 'reason', rule_expr: { required: true }, error_message: 'Reason is required' }]);
    const result = await validate('leaves', { reason: '' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ field: 'reason', message: 'Reason is required' });
  });

  test('fails min_length check', async () => {
    qOnce([{ field_name: 'reason', rule_expr: { required: true, min_length: 10 }, error_message: 'Too short' }]);
    const result = await validate('leaves', { reason: 'Short' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toBe('Too short');
  });

  test('collects multiple field errors', async () => {
    qOnce([
      { field_name: 'reason', rule_expr: { required: true },  error_message: 'Reason required' },
      { field_name: 'days',   rule_expr: { min: 1 },          error_message: 'Min 1 day' },
    ]);
    const result = await validate('leaves', { reason: '', days: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  test('passes when no rules configured (passthrough)', async () => {
    qOnce([]);
    const result = await validate('leaves', { anything: 'value' });
    expect(result.valid).toBe(true);
  });
});

// ── 7. ValidationEngineService.validateField ─────────────────────────────────
describe('ValidationEngineService.validateField', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns valid for passing value', async () => {
    qOnce([{ field_name: 'days', rule_expr: { min: 1, max: 90 }, error_message: 'Invalid days' }]);
    const result = await validateField('leaves', 'days', 5);
    expect(result.valid).toBe(true);
  });

  test('returns error for out-of-range value', async () => {
    qOnce([{ field_name: 'days', rule_expr: { max: 90 }, error_message: 'Max 90 days' }]);
    const result = await validateField('leaves', 'days', 100);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Max 90 days');
  });

  test('validates regex pattern', async () => {
    const RULE = [{
      field_name: 'pan_number',
      rule_expr: { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' },
      error_message: 'Invalid PAN format',
    }];

    qOnce(RULE);
    const bad = await validateField('employees', 'pan_number', 'INVALID');
    expect(bad.valid).toBe(false);
    expect(bad.errors).toContain('Invalid PAN format');

    qOnce(RULE);
    const good = await validateField('employees', 'pan_number', 'ABCDE1234F');
    expect(good.valid).toBe(true);
  });
});

// ── 8. Non-regression: service exports ───────────────────────────────────────
describe('Phase 2 service exports', () => {
  test('WorkflowService exports all expected functions', () => {
    expect(typeof initiateWorkflow).toBe('function');
    expect(typeof advanceWorkflow).toBe('function');
    expect(typeof getWorkflowStatus).toBe('function');
    expect(typeof getPendingApprovals).toBe('function');
    expect(typeof cancelWorkflow).toBe('function');
  });

  test('RuleEngineService exports all expected functions', () => {
    expect(typeof evaluateRules).toBe('function');
    expect(typeof getRulesForModule).toBe('function');
  });

  test('ValidationEngineService exports all expected functions', () => {
    expect(typeof validate).toBe('function');
    expect(typeof validateField).toBe('function');
  });
});
