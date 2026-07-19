/**
 * Audit logging tests
 *
 * Verifies AuditService behaviour and the correctness of the data it hands
 * to the repository for every critical action type:
 *
 *   1.  logAudit for create — populates newData, leaves oldData null
 *   2.  logAudit for update — captures both old and new snapshots
 *   3.  logAudit for delete — captures old snapshot, leaves newData null
 *   4.  logAudit for approve — records actor_id and approved_at in newData
 *   5.  logAudit for reject  — records actor_id and rejected_at in newData
 *   6.  logAudit for workflow_transition — records step context
 *   7.  Fire-and-forget: repository failure never throws to caller
 *   8.  IP / user-agent forwarded from req object
 *   9.  Null userId is accepted (unauthenticated or internal caller)
 *   10. recordId is always stored as a string
 *
 * Run:  npx vitest run src/__tests__/auditLog.test.js
 */

import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock for the audit repository ──────────────────────────────────────
const mockCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 1 }));

vi.mock('../modules/audit/repositories/audit.repository.js', () => ({
  default: { create: mockCreate },
}));

import { logAudit } from '../services/AuditService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flush the microtask queue so fire-and-forget `.then()` calls settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const makeReq = (ip = '127.0.0.1', ua = 'vitest-agent') => ({
  ip,
  get: (h) => (h === 'user-agent' ? ua : undefined),
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AuditService.logAudit', () => {
  beforeEach(() => mockCreate.mockReset().mockResolvedValue({ id: 1 }));

  // ── 1. Create ─────────────────────────────────────────────────────────────
  test('create: passes newData; oldData is null', async () => {
    const newData = { id: 10, leave_name: 'Sick Leave', annual_quota: 10 };

    logAudit({ userId: 1, module: 'leaves', recordId: 10, recordType: 'leave_type', action: 'create', newData });
    await flush();

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      user_id       : 1,
      module_name   : 'leaves',
      action_type   : 'create',
      reference_id  : '10',
      reference_type: 'leave_type',
      old_data_json : null,
      new_data_json : newData,
    }));
  });

  // ── 2. Update — old/new snapshots ─────────────────────────────────────────
  test('update: captures both old and new snapshots with correct field values', async () => {
    const oldData = { id: 42, status: 'pending', employee_id: 5 };
    const newData = { id: 42, status: 'approved', employee_id: 5 };

    logAudit({ userId: 7, module: 'leaves', recordId: 42, recordType: 'leave_application', action: 'update', oldData, newData });
    await flush();

    const call = mockCreate.mock.calls[0][0];
    expect(call.old_data_json).toEqual(oldData);
    expect(call.new_data_json).toEqual(newData);
    expect(call.action_type).toBe('update');
    expect(call.module_name).toBe('leaves');
    expect(call.reference_id).toBe('42');
  });

  // ── 3. Delete — old snapshot, no new data ────────────────────────────────
  test('delete: captures old snapshot and leaves newData null', async () => {
    const oldData = { id: 7, leave_name: 'Casual', is_active: true };

    logAudit({ userId: 2, module: 'leaves', recordId: 7, recordType: 'leave_type', action: 'delete', oldData });
    await flush();

    const call = mockCreate.mock.calls[0][0];
    expect(call.action_type).toBe('delete');
    expect(call.old_data_json).toEqual(oldData);
    expect(call.new_data_json).toBeNull();
  });

  // ── 4. Approve — actor and timestamp ─────────────────────────────────────
  test('approve: newData contains actor_id and approved_at timestamp', async () => {
    const approvedAt = new Date().toISOString();
    const newData = { id: 99, status: 'approved', actor_id: 10, actor_role: 'manager', approved_at: approvedAt };

    logAudit({ userId: 10, module: 'leaves', recordId: 99, recordType: 'leave_application', action: 'approve', oldData: { status: 'pending' }, newData });
    await flush();

    const call = mockCreate.mock.calls[0][0];
    expect(call.action_type).toBe('approve');
    expect(call.user_id).toBe(10);
    expect(call.new_data_json).toMatchObject({ status: 'approved', actor_id: 10, approved_at: approvedAt });
  });

  test('approve: actor_id in newData matches userId passed to logAudit', async () => {
    const actorId = 15;
    logAudit({
      userId: actorId,
      module: 'finance',
      recordId: 55,
      recordType: 'bill',
      action: 'approve',
      oldData: { status: 'pending' },
      newData: { status: 'approved', actor_id: actorId, approved_at: new Date().toISOString() },
    });
    await flush();

    const call = mockCreate.mock.calls[0][0];
    expect(call.user_id).toBe(actorId);
    expect(call.new_data_json.actor_id).toBe(actorId);
  });

  // ── 5. Reject ─────────────────────────────────────────────────────────────
  test('reject: newData contains actor_id and rejected_at', async () => {
    const rejectedAt = new Date().toISOString();

    logAudit({
      userId: 8,
      module: 'leaves',
      recordId: 33,
      recordType: 'leave_application',
      action: 'reject',
      oldData: { status: 'pending' },
      newData: { status: 'rejected', actor_id: 8, actor_role: 'hr', rejected_at: rejectedAt },
    });
    await flush();

    const call = mockCreate.mock.calls[0][0];
    expect(call.action_type).toBe('reject');
    expect(call.new_data_json).toMatchObject({ status: 'rejected', actor_id: 8, rejected_at: rejectedAt });
  });

  // ── 6. Workflow transition ────────────────────────────────────────────────
  test('workflow_transition: records step context in oldData and newData', async () => {
    logAudit({
      userId: 3,
      module: 'projects',
      recordId: 1,
      recordType: 'workflow_instance',
      action: 'workflow_transition',
      oldData: { step_id: 5, step_name: 'Manager Approval', status: 'in_progress' },
      newData: { action: 'approve', outcome: 'approved', to_step_id: null, new_status: 'approved', instance_id: 99 },
    });
    await flush();

    const call = mockCreate.mock.calls[0][0];
    expect(call.action_type).toBe('workflow_transition');
    expect(call.old_data_json.step_name).toBe('Manager Approval');
    expect(call.new_data_json.outcome).toBe('approved');
  });

  // ── 7. Fire-and-forget: repo failure never throws ────────────────────────
  test('repository failure is swallowed — caller never throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('DB down'));

    // Should not throw
    expect(() => {
      logAudit({ userId: 1, module: 'leaves', recordId: 1, recordType: 'leave_type', action: 'create', newData: {} });
    }).not.toThrow();

    await flush();
    // Error is logged to console.error but not rethrown
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // ── 8. IP / user-agent forwarding ─────────────────────────────────────────
  test('ip_address and user_agent are forwarded from req', async () => {
    const req = makeReq('10.0.0.1', 'Mozilla/5.0 Test');

    logAudit({ userId: 1, module: 'inventory', recordId: 5, recordType: 'inventory_item', action: 'create', newData: {}, req });
    await flush();

    const call = mockCreate.mock.calls[0][0];
    expect(call.ip_address).toBe('10.0.0.1');
    expect(call.user_agent).toBe('Mozilla/5.0 Test');
  });

  test('ip_address is null when req is omitted', async () => {
    logAudit({ userId: 1, module: 'inventory', recordId: 5, recordType: 'inventory_item', action: 'create', newData: {} });
    await flush();

    expect(mockCreate.mock.calls[0][0].ip_address).toBeNull();
  });

  // ── 9. Null userId accepted ────────────────────────────────────────────────
  test('null userId is accepted (internal / unauthenticated caller)', async () => {
    logAudit({ userId: null, module: 'service', recordId: 1, recordType: 'support_ticket', action: 'create', newData: {} });
    await flush();

    expect(mockCreate.mock.calls[0][0].user_id).toBeNull();
  });

  // ── 10. recordId always stored as string ─────────────────────────────────
  test('numeric recordId is stored as string', async () => {
    logAudit({ userId: 1, module: 'projects', recordId: 77, recordType: 'project', action: 'create', newData: {} });
    await flush();

    expect(typeof mockCreate.mock.calls[0][0].reference_id).toBe('string');
    expect(mockCreate.mock.calls[0][0].reference_id).toBe('77');
  });

  test('null recordId is stored as null (not the string "null")', async () => {
    logAudit({ userId: 1, module: 'projects', recordId: null, recordType: 'project', action: 'create', newData: {} });
    await flush();

    expect(mockCreate.mock.calls[0][0].reference_id).toBeNull();
  });
});
