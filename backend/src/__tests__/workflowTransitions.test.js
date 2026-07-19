/**
 * Workflow transition integrity tests
 *
 * Covers:
 *   1. Valid transition — correct role + valid edge → success
 *   2. Closed/cancelled instance → WorkflowClosedError (409)
 *   3. Invalid transition — no matching edge → InvalidTransitionError (400)
 *   4. Skip-step — transition goes backward in sequence_order → InvalidTransitionError (400)
 *   5. Wrong role — actor role ≠ step assignee_role → UnauthorizedTransitionError (403)
 *   6. SLA timestamps — end_time on closed step, start_time on opened step
 *   7. Terminal transition — completed_at set, no next step inserted
 *   8. Backward-compat — no actorRole passed → role check skipped
 *
 * Run:  npx vitest run src/__tests__/workflowTransitions.test.js
 */

import { vi, describe, test, expect, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
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

import {
  advanceWorkflow,
  InvalidTransitionError,
  UnauthorizedTransitionError,
  WorkflowClosedError,
} from '../services/WorkflowService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const qOnce = (rows) => mockQuery.mockResolvedValueOnce({ rows });

/** A fully-populated workflow instance row (includes step details via JOIN). */
const INST = {
  id: 99,
  status: 'pending',
  workflow_id: 1,
  current_step_id: 5,
  current_step_role: 'manager',
  current_step_order: 1,
  current_step_name: 'Manager Approval',
};

/** Normal non-terminal transition: step 1 → step 2. */
const TRANS_NEXT = {
  from_step_id: 5,
  to_step_id: 6,
  workflow_id: 1,
  action: 'approve',
  outcome: 'in_progress',
  to_step_order: 2,
};

/** Terminal transition: step 1 → null (completion). */
const TRANS_TERMINAL = {
  from_step_id: 5,
  to_step_id: null,
  workflow_id: 1,
  action: 'approve',
  outcome: 'approved',
  to_step_order: null,
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('advanceWorkflow — transition integrity & role enforcement', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    // All client queries return empty rows unless overridden
    mockClient.query.mockResolvedValue({ rows: [] });
  });

  // ── 1. Valid transition ─────────────────────────────────────────────────────
  test('valid transition: matching role + valid edge → returns in_progress', async () => {
    qOnce([INST]);
    qOnce([TRANS_NEXT]);

    const result = await advanceWorkflow(99, 'approve', 10, 'Approved', 'manager');

    expect(result).toMatchObject({ status: 'in_progress', instanceId: 99, outcome: 'in_progress' });
    expect(mockClient.release).toHaveBeenCalled();
  });

  // ── 2. Closed / cancelled instance ─────────────────────────────────────────
  test.each([['approved'], ['rejected'], ['cancelled']])(
    'throws WorkflowClosedError when instance status is "%s"',
    async (status) => {
      qOnce([{ ...INST, status }]);

      await expect(advanceWorkflow(99, 'approve', 10, '', 'manager'))
        .rejects.toMatchObject({
          name:       'WorkflowClosedError',
          code:       'WORKFLOW_CLOSED',
          statusHint: 409,
        });

      // Transition query must NOT be reached after closure check
      expect(mockQuery).toHaveBeenCalledTimes(1);
    }
  );

  // ── 3. No matching transition edge ─────────────────────────────────────────
  test('throws InvalidTransitionError when no edge exists for action', async () => {
    qOnce([INST]);
    qOnce([]); // no transition row

    await expect(advanceWorkflow(99, 'approve', 10, '', 'manager'))
      .rejects.toMatchObject({
        name:       'InvalidTransitionError',
        code:       'INVALID_TRANSITION',
        statusHint: 400,
        message:    expect.stringContaining('No transition'),
      });

    // Must not have opened a DB transaction
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  // ── 4. Skip-step — backward / same-level sequence jump ─────────────────────
  describe('sequence integrity (no backward jumps)', () => {
    test('throws InvalidTransitionError when to_step_order equals from_step_order (circular)', async () => {
      qOnce([INST]); // current_step_order = 1
      qOnce([{ ...TRANS_NEXT, to_step_order: 1 }]); // same level → invalid

      await expect(advanceWorkflow(99, 'approve', 10, '', 'manager'))
        .rejects.toMatchObject({
          name: 'InvalidTransitionError',
          code: 'INVALID_TRANSITION',
        });
    });

    test('throws InvalidTransitionError when to_step_order is less than from_step_order (backward jump)', async () => {
      qOnce([{ ...INST, current_step_order: 3 }]); // at step 3
      qOnce([{ ...TRANS_NEXT, to_step_order: 2 }]); // to step 2 → backward

      await expect(advanceWorkflow(99, 'approve', 10, '', 'manager'))
        .rejects.toMatchObject({ name: 'InvalidTransitionError' });
    });

    test('allows forward skip (e.g. reject bypasses approval to terminal)', async () => {
      // from order=1, to order=4 (rejection terminal) — legitimate skip-forward
      qOnce([INST]); // order=1
      qOnce([{ ...TRANS_NEXT, to_step_order: 4 }]);

      const result = await advanceWorkflow(99, 'approve', 10, '', 'manager');
      expect(result.status).toBe('in_progress');
    });
  });

  // ── 5. Wrong role ───────────────────────────────────────────────────────────
  test('throws UnauthorizedTransitionError when actor role does not match step role', async () => {
    qOnce([INST]); // step requires 'manager'
    qOnce([TRANS_NEXT]);

    await expect(advanceWorkflow(99, 'approve', 10, '', 'employee'))
      .rejects.toMatchObject({
        name:       'UnauthorizedTransitionError',
        code:       'UNAUTHORIZED_TRANSITION',
        statusHint: 403,
        message:    expect.stringContaining("requires role 'manager'"),
      });

    expect(mockClient.query).not.toHaveBeenCalled();
  });

  test('wrong-role error message identifies the bad actor role', async () => {
    qOnce([INST]);
    qOnce([TRANS_NEXT]);

    const err = await advanceWorkflow(99, 'approve', 10, '', 'employee')
      .catch(e => e);

    expect(err.message).toContain("actor has role 'employee'");
  });

  // ── 6. SLA timestamps ───────────────────────────────────────────────────────
  describe('SLA timestamp recording', () => {
    test('sets end_time on the closed step', async () => {
      qOnce([INST]);
      qOnce([TRANS_NEXT]);

      await advanceWorkflow(99, 'approve', 10, '', 'manager');

      const sqls = mockClient.query.mock.calls.map(c => c[0]);
      const updateStep = sqls.find(s => typeof s === 'string' && s.includes('UPDATE workflow_instance_steps'));
      expect(updateStep).toMatch(/end_time/);
    });

    test('sets start_time on the newly opened step', async () => {
      qOnce([INST]);
      qOnce([TRANS_NEXT]);

      await advanceWorkflow(99, 'approve', 10, '', 'manager');

      const sqls = mockClient.query.mock.calls.map(c => c[0]);
      const insertStep = sqls.find(s => typeof s === 'string' && s.includes('INSERT INTO workflow_instance_steps'));
      expect(insertStep).toMatch(/start_time/);
    });

    test('sets end_time even on a terminal transition (no next step)', async () => {
      qOnce([INST]);
      qOnce([TRANS_TERMINAL]);

      await advanceWorkflow(99, 'approve', 10, '', 'manager');

      const sqls = mockClient.query.mock.calls.map(c => c[0]);
      const updateStep = sqls.find(s => typeof s === 'string' && s.includes('UPDATE workflow_instance_steps'));
      expect(updateStep).toMatch(/end_time/);

      // No INSERT for a next step on terminal
      const insertStep = sqls.find(s => typeof s === 'string' && s.includes('INSERT INTO workflow_instance_steps'));
      expect(insertStep).toBeUndefined();
    });
  });

  // ── 7. Terminal transition ─────────────────────────────────────────────────
  test('terminal transition: sets completed_at on instance and returns approved', async () => {
    qOnce([INST]);
    qOnce([TRANS_TERMINAL]);

    const result = await advanceWorkflow(99, 'approve', 10, '', 'manager');

    expect(result).toMatchObject({ status: 'approved', outcome: 'approved', instanceId: 99 });

    const sqls = mockClient.query.mock.calls.map(c => c[0]);
    const updateInst = sqls.find(s => typeof s === 'string' && s.includes('UPDATE workflow_instances'));
    expect(updateInst).toMatch(/completed_at/);
  });

  // ── 8. Backward compatibility — no actorRole ────────────────────────────────
  test('skips role check when actorRole is omitted (default null)', async () => {
    qOnce([INST]); // step requires 'manager'
    qOnce([TRANS_NEXT]);

    // Passing no actorRole — should succeed despite step requiring 'manager'
    const result = await advanceWorkflow(99, 'approve', 10);
    expect(result.status).toBe('in_progress');
  });

  test('skips role check when actorRole is null explicitly', async () => {
    qOnce([INST]);
    qOnce([TRANS_NEXT]);

    const result = await advanceWorkflow(99, 'approve', 10, 'notes', null);
    expect(result.status).toBe('in_progress');
  });

  // ── Rollback on DB error ────────────────────────────────────────────────────
  test('rolls back transaction on DB error inside transaction', async () => {
    qOnce([INST]);
    qOnce([TRANS_NEXT]);

    // BEGIN succeeds, UPDATE step throws
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })           // BEGIN
      .mockRejectedValueOnce(new Error('DB failure')); // UPDATE step

    await expect(advanceWorkflow(99, 'approve', 10, '', 'manager'))
      .rejects.toThrow('DB failure');

    const sqls = mockClient.query.mock.calls.map(c => c[0]);
    expect(sqls).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
