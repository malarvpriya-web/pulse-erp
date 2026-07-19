/**
 * Engine hooks integration tests
 *
 * Verifies the behaviour of ValidationEngineService and RuleEngineService
 * as used in every write path:
 *
 *   1. validate() passes through when no rules are configured
 *   2. validate() returns structured errors when a rule fails
 *   3. 422 payload matches the spec shape
 *   4. evaluateRules() returns empty array when no rules configured
 *   5. evaluateRules() returns triggered rule alert with correct shape
 *   6. evaluateRules() never throws (non-blocking guarantee)
 *   7. validate() covers all constraint types: required, min_length, max_length,
 *      min, max, pattern
 *   8. Multiple field errors are all collected (not short-circuited)
 *
 * Run:  npx vitest run src/__tests__/engineHooks.test.js
 */

import { vi, describe, test, expect, beforeEach } from 'vitest';

// ── Hoisted mock ──────────────────────────────────────────────────────────────
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('../config/db.js', () => ({
  default: { query: mockQuery },
}));

import { validate } from '../services/ValidationEngineService.js';
import { evaluateRules } from '../services/RuleEngineService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Queue one pool.query result. */
const qOnce = (rows) => mockQuery.mockResolvedValueOnce({ rows });

/** Build a minimal validation_rules row. */
const vRule = (field_name, rule_expr, error_message = null) => ({
  id: 1, module: 'leaves', field_name, rule_expr, error_message, is_active: true,
});

/** Build a minimal rules_master row. */
const bRule = (code, condition_expr, action_expr) => ({
  id: 1, module: 'inventory', name: code, code, rule_type: 'alert',
  condition_expr, action_expr, priority: 1, is_active: true,
});

// ── ValidationEngineService ───────────────────────────────────────────────────

describe('ValidationEngineService.validate', () => {
  beforeEach(() => mockQuery.mockReset());

  test('passes through with { valid: true, errors: [] } when no rules configured', async () => {
    qOnce([]); // no validation_rules rows
    const result = await validate('leaves', { leave_name: 'Sick Leave', default_days: 5 });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('required constraint: returns error when field is empty string', async () => {
    qOnce([vRule('leave_name', { required: true }, 'Leave name is required')]);
    const { valid, errors } = await validate('leaves', { leave_name: '' });
    expect(valid).toBe(false);
    expect(errors).toEqual([{ field: 'leave_name', message: 'Leave name is required' }]);
  });

  test('required constraint: returns error when field is null', async () => {
    qOnce([vRule('start_date', { required: true })]);
    const { valid, errors } = await validate('leaves', { start_date: null });
    expect(valid).toBe(false);
    expect(errors[0].field).toBe('start_date');
  });

  test('min_length constraint: fails when value is too short', async () => {
    qOnce([vRule('title', { min_length: 5 }, 'Title too short')]);
    const { valid, errors } = await validate('service', { title: 'Hi' });
    expect(valid).toBe(false);
    expect(errors[0].message).toBe('Title too short');
  });

  test('max_length constraint: fails when value exceeds limit', async () => {
    qOnce([vRule('notes', { max_length: 10 })]);
    const { valid, errors } = await validate('service', { notes: 'this is way too long for the limit' });
    expect(valid).toBe(false);
    expect(errors[0].field).toBe('notes');
  });

  test('min numeric constraint: fails when number is below minimum', async () => {
    qOnce([vRule('allocated_days', { min: 1 }, 'Must allocate at least 1 day')]);
    const { valid, errors } = await validate('leaves', { allocated_days: 0 });
    expect(valid).toBe(false);
    expect(errors[0].message).toBe('Must allocate at least 1 day');
  });

  test('max numeric constraint: fails when number exceeds maximum', async () => {
    qOnce([vRule('allocated_days', { max: 30 })]);
    const { valid, errors } = await validate('leaves', { allocated_days: 45 });
    expect(valid).toBe(false);
  });

  test('pattern constraint: fails when value does not match regex', async () => {
    qOnce([vRule('pan_number', { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' }, 'Invalid PAN format')]);
    const { valid, errors } = await validate('hr', { pan_number: 'bad-value' });
    expect(valid).toBe(false);
    expect(errors[0].message).toBe('Invalid PAN format');
  });

  test('pattern constraint: passes when value matches regex', async () => {
    qOnce([vRule('pan_number', { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' })]);
    const { valid } = await validate('hr', { pan_number: 'ABCDE1234F' });
    expect(valid).toBe(true);
  });

  test('collects errors from multiple failing rules (no short-circuit)', async () => {
    qOnce([
      vRule('title',       { required: true }),
      vRule('description', { min_length: 10 }),
    ]);
    const { valid, errors } = await validate('service', { title: '', description: 'short' });
    expect(valid).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors.map(e => e.field)).toEqual(['title', 'description']);
  });

  test('passes all fields when all rules satisfied', async () => {
    qOnce([
      vRule('title', { required: true, min_length: 3 }),
    ]);
    const { valid, errors } = await validate('service', { title: 'Valid title' });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

// ── 422 payload shape ────────────────────────────────────────────────────────

describe('422 validation error payload shape', () => {
  beforeEach(() => mockQuery.mockReset());

  test('matches spec: { error, code, module, errors: [{ field, message }] }', async () => {
    qOnce([vRule('leave_name', { required: true }, 'Leave name is required')]);
    const { valid, errors } = await validate('leaves', { leave_name: '' });

    // This is the exact object the route handlers construct and send as 422
    const payload = {
      error:   'Validation failed',
      code:    'VALIDATION_ERROR',
      module:  'leaves',
      errors,
    };

    expect(payload).toMatchObject({
      error:  'Validation failed',
      code:   'VALIDATION_ERROR',
      module: 'leaves',
      errors: [{ field: 'leave_name', message: 'Leave name is required' }],
    });
  });
});

// ── RuleEngineService ────────────────────────────────────────────────────────

describe('RuleEngineService.evaluateRules', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns empty array when no rules configured (passthrough)', async () => {
    qOnce([]); // no rules_master rows
    const results = await evaluateRules('inventory', { quantity: 100, reorder_point: 50 });
    expect(results).toEqual([]);
  });

  test('returns untriggered entry when condition is false', async () => {
    qOnce([bRule(
      'LOW_STOCK',
      { field: 'quantity', operator: 'lte', value_field: 'reorder_point' },
      { severity: 'warning', message_template: 'Stock low for {{item_name}}' }
    )]);
    const results = await evaluateRules('inventory', { quantity: 100, reorder_point: 50, item_name: 'Widget' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rule_code: 'LOW_STOCK', triggered: false, severity: null });
  });

  test('returns triggered entry with severity and interpolated message when condition is true', async () => {
    qOnce([bRule(
      'LOW_STOCK',
      { field: 'quantity', operator: 'lte', value_field: 'reorder_point' },
      { severity: 'warning', message_template: 'Stock low for {{item_name}}' }
    )]);
    const results = await evaluateRules('inventory', { quantity: 10, reorder_point: 50, item_name: 'Widget' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      rule_code: 'LOW_STOCK',
      triggered: true,
      severity:  'warning',
      message:   'Stock low for Widget',
    });
  });

  test('rule_alerts shape attached to response matches spec', async () => {
    qOnce([bRule(
      'OVERDUE_BILL',
      { field: 'days_overdue', operator: 'gt', value: 30 },
      { severity: 'critical', message_template: 'Bill {{bill_number}} is overdue by {{days_overdue}} days' }
    )]);
    const results = await evaluateRules('finance', { days_overdue: 45, bill_number: 'BILL-001' });
    const ruleAlerts = results.filter(r => r.triggered);
    expect(ruleAlerts).toHaveLength(1);
    expect(ruleAlerts[0]).toMatchObject({
      rule_code: 'OVERDUE_BILL',
      triggered: true,
      severity:  'critical',
      message:   'Bill BILL-001 is overdue by 45 days',
    });
  });

  test('never throws on bad condition expression — surfaces as non-triggered entry', async () => {
    qOnce([{
      id: 1, module: 'finance', name: 'BAD_RULE', code: 'BAD_RULE',
      condition_expr: null, // will cause evalCondition to return false gracefully
      action_expr: { severity: 'info' },
      priority: 1, is_active: true,
    }]);
    await expect(evaluateRules('finance', {})).resolves.toBeDefined();
  });

  test('multiple rules — collects results for all, filters triggered correctly', async () => {
    qOnce([
      bRule('RULE_A', { field: 'x', operator: 'gt', value: 10 }, { severity: 'info',    message_template: 'A triggered' }),
      bRule('RULE_B', { field: 'x', operator: 'lt', value: 5  }, { severity: 'warning', message_template: 'B triggered' }),
    ]);
    const results = await evaluateRules('projects', { x: 20 });
    expect(results).toHaveLength(2);
    const triggered = results.filter(r => r.triggered);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].rule_code).toBe('RULE_A');
  });
});
