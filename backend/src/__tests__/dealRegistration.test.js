/**
 * dealRegistration.test.js
 *
 * Channel conflict rules. The assertions that matter most are the refusals:
 * a registration system that approves everything is a list, not a protection.
 */
import { describe, test, expect, vi } from 'vitest';
import {
  TRANSITIONS, APPROVAL_ROLES, canTransition, customerKey, expiryFrom,
  approve, transition, partnerPerformance,
} from '../modules/sales/services/dealRegistration.service.js';

function fakePool(results) {
  const queue = [...results];
  const query = vi.fn(async () => (queue.length ? queue.shift() : { rows: [] }));
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query }, query, client };
}

const reg = (over = {}) => ({
  id: 3, company_id: 1, partner_id: 7, customer_name: 'Acme Corp',
  status: 'submitted', protection_days: 90, submitted_by: 42, ...over,
});

describe('transition table', () => {
  test('every target names a known state', () => {
    const states = Object.keys(TRANSITIONS);
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) expect(states, `${from} → ${to}`).toContain(to);
    }
  });

  test('a submitted registration cannot jump to converted', () => {
    // Converting without approval would hand out protection nobody granted.
    expect(canTransition('submitted', 'converted')).toBe(false);
    expect(canTransition('approved', 'converted')).toBe(true);
  });

  test('only an approved registration can expire', () => {
    const sources = Object.entries(TRANSITIONS)
      .filter(([, t]) => t.includes('expired')).map(([f]) => f);
    expect(sources).toEqual(['approved']);
  });

  test('a rejected or expired registration can be resubmitted', () => {
    expect(canTransition('rejected', 'submitted')).toBe(true);
    expect(canTransition('expired', 'submitted')).toBe(true);
  });
});

describe('customerKey()', () => {
  test('case and surrounding whitespace do not create a second window', () => {
    expect(customerKey('  Acme Corp ')).toBe(customerKey('acme corp'));
  });

  test('a missing name does not become "undefined"', () => {
    expect(customerKey(undefined)).toBe('');
    expect(customerKey(null)).toBe('');
  });
});

describe('expiryFrom()', () => {
  test('measures from APPROVAL, not submission', () => {
    // A registration that waited three weeks in a queue still gets its full
    // window — otherwise a slow reviewer silently shortens the protection.
    expect(expiryFrom(new Date('2026-09-09T00:00:00Z'), 90).toISOString())
      .toBe('2026-12-08T00:00:00.000Z');
  });

  test('a nonsensical window yields null rather than an Invalid Date', () => {
    // An Invalid Date stores as NULL, which would mean "protected for ever".
    expect(expiryFrom(new Date(), 0)).toBeNull();
    expect(expiryFrom(new Date(), -5)).toBeNull();
    expect(expiryFrom(new Date(), 'ninety')).toBeNull();
  });
});

describe('approve()', () => {
  const roles = ['sales_manager'];
  // approve() sweeps lapsed registrations first, so every queue starts with the
  // UPDATE … RETURNING from expireLapsed.
  const sweep = { rows: [] };

  test('refuses an approver without an approval role', async () => {
    const { pool } = fakePool([sweep, { rows: [] }, { rows: [reg()] }]);
    const out = await approve(pool, { id: 3, companyId: 1, employeeId: 9, roles: ['sales_exec'] });
    expect(out.error).toBe('role_required');
    expect(out.roles).toEqual(APPROVAL_ROLES);
  });

  test('refuses self-approval', async () => {
    // The approval is the only independent check in the process.
    const { pool } = fakePool([sweep, { rows: [] }, { rows: [reg({ submitted_by: 9 })] }]);
    expect((await approve(pool, { id: 3, companyId: 1, employeeId: 9, roles })).error)
      .toBe('self_approval');
  });

  test('refuses when another partner already protects the customer', async () => {
    const { pool } = fakePool([
      sweep, { rows: [] }, { rows: [reg()] },
      { rows: [{ id: 9, partner_name: 'Other Partner', expires_at: '2026-12-01' }] },
    ]);
    const out = await approve(pool, { id: 3, companyId: 1, employeeId: 99, roles });
    expect(out.error).toBe('conflict');
    expect(out.conflict.partner_name).toBe('Other Partner');
  });

  test('refuses an already-approved registration', async () => {
    const { pool } = fakePool([sweep, { rows: [] }, { rows: [reg({ status: 'approved' })] }]);
    const out = await approve(pool, { id: 3, companyId: 1, employeeId: 99, roles });
    expect(out.error).toBe('illegal_transition');
    expect(out.allowed).toEqual(TRANSITIONS.approved);
  });

  test('a clean approval sets an expiry and records who decided', async () => {
    const now = new Date('2026-09-09T00:00:00Z');
    const { pool, query } = fakePool([
      sweep, { rows: [] }, { rows: [reg()] }, { rows: [] },
      { rows: [{ ...reg(), status: 'approved' }] }, { rows: [] }, { rows: [] },
    ]);
    const out = await approve(pool, { id: 3, companyId: 1, employeeId: 99, roles, now });
    expect(out.error).toBeUndefined();

    // Match on `approved_by`, not on "status = 'approved'": the conflict-check
    // SELECT contains that phrase too and is issued first.
    const update = query.mock.calls.find(c => String(c[0]).includes('approved_by = $3'));
    expect(update[1][2]).toBe(99);                                   // approved_by
    expect(update[1][4].toISOString()).toBe('2026-12-08T00:00:00.000Z'); // expires_at
    expect(query.mock.calls.map(c => String(c[0])).at(-1)).toBe('COMMIT');
  });

  test('a unique-index race is reported as a conflict, not a raw constraint error', async () => {
    // The check-then-insert loses a race; the partial unique index is what
    // actually holds. The caller must still get something readable.
    const client = { query: vi.fn(), release: vi.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })            // BEGIN
      .mockResolvedValueOnce({ rows: [reg()] })       // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })            // conflict check: clear
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'),
        { code: '23505', constraint: 'uq_deal_registration_live_customer' }))
      .mockResolvedValue({ rows: [] });
    const pool = { connect: async () => client, query: vi.fn().mockResolvedValue({ rows: [] }) };

    const out = await approve(pool, { id: 3, companyId: 1, employeeId: 99, roles });
    expect(out.error).toBe('conflict');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('transition()', () => {
  test('rejecting needs an approval role too', async () => {
    // Rejecting a partner's deal is as commercially consequential as approving.
    const { pool } = fakePool([{ rows: [] }, { rows: [reg()] }]);
    const out = await transition(pool, {
      id: 3, companyId: 1, to: 'rejected', employeeId: 9, roles: ['sales_exec'] });
    expect(out.error).toBe('role_required');
  });

  test('rejecting clears the approval fields', async () => {
    const { pool, query } = fakePool([
      { rows: [] }, { rows: [reg()] }, { rows: [reg({ status: 'rejected' })] },
      { rows: [] }, { rows: [] },
    ]);
    await transition(pool, { id: 3, companyId: 1, to: 'rejected', employeeId: 9,
                             roles: ['sales_manager'], reason: 'already direct' });
    const update = query.mock.calls.find(c => String(c[0]).includes('UPDATE partner_deal_registrations'));
    expect(String(update[0])).toContain('approved_at = NULL');
    expect(String(update[0])).toContain('expires_at = NULL');
  });

  test('a missing registration is not found rather than a crash', async () => {
    const { pool } = fakePool([{ rows: [] }, { rows: [] }]);
    expect((await transition(pool, { id: 99, companyId: 1, to: 'withdrawn' })).error)
      .toBe('not_found');
  });
});

describe('partnerPerformance()', () => {
  test('a partner with no closed deals is UNMEASURED, not 0% win rate', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [
      { partner_id: 1, win_rate: null, won: 0, lost: 0, protected_value: '0' },
      { partner_id: 2, win_rate: '66.7', won: 2, lost: 1, protected_value: '150000.00' },
    ] }) };
    const [unmeasured, measured] = await partnerPerformance(pool, { companyId: 1 });

    expect(unmeasured.win_rate).toBeNull();
    expect(unmeasured.measured).toBe(false);
    // 0% reads as "this partner loses everything" rather than "nothing has
    // closed yet" — the supplier on_time_pct mistake, again.
    expect(unmeasured.win_rate).not.toBe(0);

    expect(measured.measured).toBe(true);
    expect(measured.win_rate).toBe(66.7);
    // pg returns numeric as a string; leaving it makes any arithmetic upstream
    // string concatenation.
    expect(typeof measured.win_rate).toBe('number');
    expect(typeof measured.protected_value).toBe('number');
  });
});
