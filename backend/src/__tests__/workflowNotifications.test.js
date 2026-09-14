/**
 * workflowNotifications.test.js — delivery is best-effort, but never silent.
 *
 * notifyWorkflowEvent defers all its work into a setImmediate, which detaches it
 * from the request. Nothing downstream can catch a throw from there: every
 * caller invokes it fire-and-forget, so a rejection surfaced only as an
 * anonymous `[process] unhandledRejection` from server.js — no correlation id,
 * no user, no module, and no bump to the `notification_failures` counter that
 * healthMonitor.cron.js alerts on. These tests pin the three failure modes to
 * "counted and logged" instead.
 *
 * They assert on `unhandledRejection` directly rather than on log output,
 * because escaping the process is the actual defect — a swallowed-but-uncounted
 * failure and a crashed-out one look identical in a log grep.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../config/db.js', () => ({ default: { query: vi.fn() } }));
vi.mock('../modules/notifications/repositories/notifications.repository.js', () => ({
  default: { create: vi.fn() },
}));

import pool       from '../config/db.js';
import notifRepo  from '../modules/notifications/repositories/notifications.repository.js';
import { notifyWorkflowEvent } from '../services/WorkflowNotificationService.js';
import { snapshot } from '../config/metrics.js';

// The work is deferred into setImmediate; drain it plus any awaits inside.
const drain = () => new Promise(r => setTimeout(r, 50));

// Captures unhandled rejections for the duration of a test. Before this change
// each failure mode below produced one of these instead of a counted failure.
let unhandled = [];
const onUnhandled = (e) => unhandled.push(e);

beforeEach(() => {
  vi.resetAllMocks();
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => process.off('unhandledRejection', onUnhandled));

const fails = () => snapshot().notification_failures;

describe('notifyWorkflowEvent never escapes as an unhandled rejection', () => {
  it('a DB failure resolving a recipient is counted, not thrown', async () => {
    pool.query.mockRejectedValue(new Error('connection terminated'));
    const before = fails();

    notifyWorkflowEvent('approved', {
      module: 'Leave', recordId: 1, recipientIds: [4], context: {},
    });
    await drain();

    expect(unhandled).toEqual([]);
    expect(fails()).toBeGreaterThan(before);
    expect(notifRepo.create).not.toHaveBeenCalled(); // nobody resolved → nothing inserted
  });

  it('one unresolvable recipient no longer costs the others their notification', async () => {
    // Recipient 4 blows up, 5 resolves fine. Promise.all used to reject wholesale.
    pool.query
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValueOnce({ rows: [{ id: 99 }] });
    notifRepo.create.mockResolvedValue({ id: 1 });

    notifyWorkflowEvent('approved', {
      module: 'Leave', recordId: 1, recipientIds: [4, 5], context: {},
    });
    await drain();

    expect(unhandled).toEqual([]);
    expect(notifRepo.create).toHaveBeenCalledTimes(1);
    expect(notifRepo.create.mock.calls[0][0]).toMatchObject({ user_id: 99 });
  });

  it('an insert failure is counted, not thrown', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 99 }] });
    notifRepo.create.mockRejectedValue(new Error('deadlock detected'));
    const before = fails();

    notifyWorkflowEvent('approved', {
      module: 'Leave', recordId: 1, recipientIds: [4], context: {},
    });
    await drain();

    expect(unhandled).toEqual([]);
    expect(fails()).toBeGreaterThan(before);
  });

  it('a throwing message template is caught by the dispatch backstop', async () => {
    // 'approved' builds its message from ctx.recordId, so a throwing getter
    // there fires inside def.message(). Nothing outside the setImmediate could
    // ever catch that — it is the one failure mode _insert and
    // resolveEmployeeUserId's own guards do not cover.
    pool.query.mockResolvedValue({ rows: [{ id: 99 }] });
    notifRepo.create.mockResolvedValue({ id: 1 });
    const before = fails();

    notifyWorkflowEvent('approved', {
      module: 'Leave', recipientIds: [4], context: {},
      get recordId() { throw new Error('malformed ctx'); },
    });
    await drain();

    expect(unhandled).toEqual([]);
    expect(fails()).toBeGreaterThan(before);
  });

  it('the happy path still delivers', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 99 }] });
    notifRepo.create.mockResolvedValue({ id: 1 });

    notifyWorkflowEvent('approved', {
      module: 'Leave', recordId: 7, recipientIds: [4], context: {},
    });
    await drain();

    expect(unhandled).toEqual([]);
    expect(notifRepo.create).toHaveBeenCalledTimes(1);
    expect(notifRepo.create.mock.calls[0][0]).toMatchObject({
      user_id: 99, module_name: 'Leave', reference_id: 7,
    });
  });
});
