/**
 * journeyEngine.test.js
 *
 * The rules that decide whether an email goes out, and what happens when it
 * doesn't. The most important assertions here are the negative ones: a journey
 * that cannot send must not LOOK like a journey that sent.
 */
import { describe, test, expect, vi } from 'vitest';
import {
  nextSendAt, buildContext, shouldSend, shouldExit,
  transportConfigured, runEnrollment, dueEnrollments, runDue,
} from '../modules/crm/services/journeyEngine.js';

const ENV_OFF = {};
const ENV_ON  = { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'bot@example.com' };

/** A client whose query() answers from a queue, so a transaction can be driven. */
function fakePool(results) {
  const queue = [...results];
  const query = vi.fn(async () => (queue.length ? queue.shift() : { rows: [] }));
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query }, query, client };
}

const enrolment = (over = {}) => ({
  id: 5, sequence_id: 2, company_id: 1, lead_id: 9, contact_id: null,
  status: 'active', current_step: 0, email: 'lead@example.com', enrolled_at: '2026-09-01',
  attempts: 0, ...over,
});

describe('nextSendAt()', () => {
  const base = new Date('2026-09-09T10:00:00Z');

  test('days and hours are additive', () => {
    expect(nextSendAt({ delay_days: 1, delay_hours: 2 }, base).toISOString())
      .toBe('2026-09-10T12:00:00.000Z');
  });

  test('a zero delay means now, not never', () => {
    expect(nextSendAt({ delay_days: 0, delay_hours: 0 }, base).getTime()).toBe(base.getTime());
  });

  test('a missing or non-numeric delay is treated as zero, not NaN', () => {
    // A NaN date silently becomes `Invalid Date`, which stores as NULL and drops
    // the enrolment out of the due query forever.
    expect(nextSendAt({}, base).getTime()).toBe(base.getTime());
    expect(nextSendAt({ delay_days: 'soon' }, base).getTime()).toBe(base.getTime());
  });

  test('measures from the moment passed in, not from now', () => {
    const old = new Date('2026-01-01T00:00:00Z');
    expect(nextSendAt({ delay_days: 3 }, old).toISOString()).toBe('2026-01-04T00:00:00.000Z');
  });
});

describe('transportConfigured()', () => {
  test('false when SMTP is unset', () => expect(transportConfigured(ENV_OFF)).toBe(false));
  test('false when only the host is set', () =>
    expect(transportConfigured({ SMTP_HOST: 'x' })).toBe(false));
  test('true when host and user are both set', () =>
    expect(transportConfigured(ENV_ON)).toBe(true));
});

describe('shouldSend()', () => {
  const ctx = buildContext({
    enrollment: enrolment(), lead: { status: 'new', email: 'a@b.com' },
    engagement: { sent: 2, opened: 0, clicked: 0, replied: 0, tracking_enabled: false },
  });

  test('no condition means send', () => {
    expect(shouldSend({}, ctx).send).toBe(true);
  });

  test('a met condition sends', () => {
    expect(shouldSend({ send_condition: { field: 'lead.status', op: 'equals', value: 'new' } }, ctx).send)
      .toBe(true);
  });

  test('an unmet condition does not send, and names why', () => {
    const out = shouldSend(
      { send_condition: { field: 'lead.status', op: 'equals', value: 'qualified' } }, ctx);
    expect(out.send).toBe(false);
    expect(out.reason).toBe('send_condition');
  });

  test('exposes whether open tracking was even ON', () => {
    // opened=0 means "not opened" OR "never tracked". Branching on "did not
    // open" with tracking disabled branches that way for EVERYONE, so the flag
    // has to be visible to the condition author.
    expect(ctx.engagement.tracking_enabled).toBe(false);
    expect(ctx.engagement.opened).toBe(0);
  });
});

describe('shouldExit()', () => {
  const replied = buildContext({
    enrollment: enrolment(), lead: {},
    engagement: { sent: 1, opened: 1, clicked: 0, replied: 1 },
  });
  const quiet = buildContext({
    enrollment: enrolment(), lead: {},
    engagement: { sent: 1, opened: 0, clicked: 0, replied: 0 },
  });

  test('a reply ends the journey when the sequence says so', () => {
    expect(shouldExit({ exit_on_reply: true }, {}, replied).exit).toBe(true);
    expect(shouldExit({ exit_on_reply: true }, {}, replied).event).toBe('exited_replied');
  });

  test('a reply does NOT end it when the sequence opts out', () => {
    expect(shouldExit({ exit_on_reply: false }, {}, replied).exit).toBe(false);
  });

  test('no reply and no exit condition keeps going', () => {
    expect(shouldExit({ exit_on_reply: true }, {}, quiet).exit).toBe(false);
  });
});

describe('runEnrollment()', () => {
  test('refuses an enrolment with no company and marks it failed', async () => {
    // An unscoped enrolment is a message to somebody whose tenant we cannot
    // establish. It must never be sent, and it must not sit "active" pretending
    // it will be.
    const { pool, query } = fakePool([
      { rows: [] },
      { rows: [enrolment({ company_id: null })] },
    ]);
    const out = await runEnrollment(pool, 5);
    expect(out.failed).toBe('unscoped');
    const sql = query.mock.calls.map(c => String(c[0]));
    expect(sql.some(s => s.includes("status='failed'"))).toBe(true);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  test('an enrolment that is not active is left alone', async () => {
    const { pool, query } = fakePool([{ rows: [] }, { rows: [enrolment({ status: 'paused' })] }]);
    expect((await runEnrollment(pool, 5)).skipped).toBe('paused');
    expect(query.mock.calls.map(c => String(c[0])).at(-1)).toBe('ROLLBACK');
  });

  test('running out of steps completes the journey', async () => {
    const { pool, query } = fakePool([
      { rows: [] },                                   // BEGIN
      { rows: [enrolment({ current_step: 3 })] },     // enrolment
      { rows: [{ id: 2, is_active: true }] },         // sequence
      { rows: [] },                                   // no step 4
    ]);
    expect((await runEnrollment(pool, 5)).completed).toBe(true);
    const sql = query.mock.calls.map(c => String(c[0]));
    expect(sql.some(s => s.includes("status='completed'"))).toBe(true);
  });

  test('an inactive sequence does not send', async () => {
    const { pool } = fakePool([
      { rows: [] }, { rows: [enrolment()] }, { rows: [{ id: 2, is_active: false }] },
    ]);
    expect((await runEnrollment(pool, 5)).skipped).toBe('sequence_inactive');
  });

  test('WITHOUT SMTP nothing is sent and the step is NOT advanced', async () => {
    // The heart of it. Advancing here would manufacture a delivery history for
    // email that never left the building.
    const prev = { ...process.env };
    delete process.env.SMTP_HOST; delete process.env.SMTP_USER;
    try {
      const { pool, query } = fakePool([
        { rows: [] },                                        // BEGIN
        { rows: [enrolment()] },                             // enrolment
        { rows: [{ id: 2, is_active: true, exit_on_reply: true, name: 'Nurture' }] },
        { rows: [{ step_order: 1, subject: 'Hi', body_html: '<p>Hi</p>', delay_days: 2 }] },
        // NOTE: contact_id is null, so NO contact query is issued — queueing a
        // row for it shifts every later answer by one and quietly feeds the
        // engagement result into the wrong variable.
        { rows: [{ id: 9, email: 'lead@example.com', status: 'new' }] },  // lead
        { rows: [{ sent: 0, opened: 0, clicked: 0, replied: 0 }] },       // engagement
        { rows: [{ enabled: false }] },                                   // crm_settings
      ]);
      const out = await runEnrollment(pool, 5);
      expect(out.failed).toBe('smtp_not_configured');

      const sql = query.mock.calls.map(c => String(c[0]));
      expect(sql.some(s => s.includes('INSERT INTO crm_emails'))).toBe(false);
      expect(sql.some(s => s.includes('current_step = $2'))).toBe(false);
      // The failure is recorded rather than swallowed — a stalled journey has to
      // be visible.
      expect(sql.some(s => s.includes('sequence_enrollment_events'))).toBe(true);
      expect(sql.some(s => s.includes('attempts'))).toBe(true);
    } finally { process.env = prev; }
  });

  test('an unmet send condition SKIPS the step but keeps the journey moving', async () => {
    const { pool, query } = fakePool([
      { rows: [] },
      { rows: [enrolment()] },
      { rows: [{ id: 2, is_active: true, exit_on_reply: true }] },
      { rows: [{ step_order: 1, delay_days: 1,
                 send_condition: { field: 'lead.status', op: 'equals', value: 'qualified' } }] },
      { rows: [{ id: 9, email: 'lead@example.com', status: 'new' }] },  // lead
      { rows: [{ sent: 0, opened: 0, clicked: 0, replied: 0 }] },       // engagement
      { rows: [{ enabled: false }] },                                   // crm_settings
    ]);
    const out = await runEnrollment(pool, 5);
    expect(out.skippedStep).toBe(1);
    const sql = query.mock.calls.map(c => String(c[0]));
    // Advanced, so step 2 still gets its chance — a skip must not silently end
    // the journey.
    expect(sql.some(s => s.includes('current_step = $2'))).toBe(true);
    expect(sql.some(s => s.includes('INSERT INTO crm_emails'))).toBe(false);
  });

  test('a reply exits the journey before anything else is sent', async () => {
    const { pool, query } = fakePool([
      { rows: [] },
      { rows: [enrolment()] },
      { rows: [{ id: 2, is_active: true, exit_on_reply: true }] },
      { rows: [{ step_order: 1, subject: 'Follow up' }] },
      { rows: [{ id: 9, email: 'lead@example.com' }] },                 // lead
      { rows: [{ sent: 1, opened: 1, clicked: 0, replied: 1 }] },       // engagement
      { rows: [{ enabled: true }] },                                    // crm_settings
    ]);
    expect((await runEnrollment(pool, 5)).exited).toBe('exited_replied');
    expect(query.mock.calls.map(c => String(c[0])).some(s => s.includes('INSERT INTO crm_emails')))
      .toBe(false);
  });

  test('schedules from the FOLLOWING step, not the one just sent', async () => {
    // The double-send bug, caught by a live run in §156: step 1 had
    // delay_days 0, so scheduling from it made step 2 due immediately and the
    // whole journey went out in one burst. A step's delay is the wait BEFORE
    // that step.
    const prev = { ...process.env };
    Object.assign(process.env, {
      SMTP_HOST: '127.0.0.1', SMTP_USER: 'x', SMTP_PASS: 'x', SMTP_PORT: '2525',
    });
    try {
      const { pool, query } = fakePool([
        { rows: [] },                                              // BEGIN
        { rows: [enrolment()] },                                   // enrolment
        { rows: [{ id: 2, is_active: true, exit_on_reply: true }] },
        // BOTH steps come back from one query: the one to send (delay 0) and
        // the one after it (delay 3), which is what schedules.
        { rows: [{ step_order: 1, delay_days: 0, subject: 'Welcome', body_html: '<p>hi</p>' },
                 { step_order: 2, delay_days: 3, subject: 'Follow up' }] },
        { rows: [{ id: 9, email: 'lead@example.com', status: 'new' }] },
        { rows: [{ sent: 0, opened: 0, clicked: 0, replied: 0 }] },
        { rows: [{ enabled: false }] },
        { rows: [{ id: 77 }] },                                    // crm_emails insert
      ]);
      // Transport is configured but unreachable, so the send throws — enough to
      // prove the SELECT asks for two steps without opening a socket.
      const out = await runEnrollment(pool, 5);

      const stepQuery = query.mock.calls
        .map(c => String(c[0]))
        .find(s => s.includes('crm_email_sequence_steps'));
      expect(stepQuery).toContain('LIMIT 2');
      expect(stepQuery).toContain('step_order > $2');
      // Gaps in step_order are real (the seeded sequences are numbered 2,4,3,5,1),
      // so an exact `= current_step + 1` would complete them at step 1.
      expect(stepQuery).not.toContain('step_order = $2');
      expect(out).toBeDefined();
    } finally { process.env = prev; }
  });

  test('the last step COMPLETES the journey instead of leaving it due for ever', async () => {
    // With no following step there is nothing left to schedule. Leaving it
    // active with next_send_at in the past means the runner wakes it every 15
    // minutes to discover there is nothing to do.
    const { pool, query } = fakePool([
      { rows: [] },
      { rows: [enrolment()] },
      { rows: [{ id: 2, is_active: true, exit_on_reply: true }] },
      { rows: [{ step_order: 1, delay_days: 0,
                 send_condition: { field: 'lead.status', op: 'equals', value: 'nope' } }] },
      { rows: [{ id: 9, email: 'lead@example.com', status: 'new' }] },
      { rows: [{ sent: 0, opened: 0, clicked: 0, replied: 0 }] },
      { rows: [{ enabled: false }] },
    ]);
    const out = await runEnrollment(pool, 5);
    expect(out.completed).toBe(true);
    const sql = query.mock.calls.map(c => String(c[0]));
    expect(sql.some(s => s.includes("status = 'completed'") && s.includes('next_send_at = NULL')))
      .toBe(true);
  });

  test('a thrown error rolls back and releases the client', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValue({ rows: [] });
    await expect(runEnrollment({ connect: async () => client }, 5)).rejects.toThrow('terminated');
    expect(client.query.mock.calls.map(c => String(c[0]))).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('dueEnrollments()', () => {
  test('excludes unscoped rows in the query itself', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    await dueEnrollments(pool, { companyId: 1 });
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain('e.company_id IS NOT NULL');
    expect(sql).toContain("e.status = 'active'");
    // An inactive sequence must not keep sending just because enrolments remain.
    expect(sql).toContain('COALESCE(s.is_active, true)');
  });
});

describe('runDue()', () => {
  test('reports sent, skipped and failed separately', async () => {
    // One number would let a run that delivered nothing report as a success —
    // which is how the workflow engine came to be a counter.
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const tally = await runDue(pool, { companyId: 1 });
    expect(tally).toMatchObject({ due: 0, sent: 0, skipped: 0, failed: 0 });
    expect(tally).toHaveProperty('errors');
  });
});
