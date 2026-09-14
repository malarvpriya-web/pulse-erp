/**
 * emailToCase.test.js
 *
 * Parsing and threading rules. These are the parts that decide whether a
 * customer's reply lands on their case or opens a duplicate — and whether an
 * out-of-office auto-reply starts an infinite loop with our own auto-reply.
 */
import { describe, test, expect, vi } from 'vitest';
import {
  extractCaseRef, normaliseSubject, stripQuotedReply, isAutoReply,
  parseMessageIds, findThread, outboundSubject, ingest,
} from '../modules/servicedesk/services/emailToCase.service.js';

describe('extractCaseRef()', () => {
  test('finds the token we put there', () => {
    expect(extractCaseRef('Re: [Case IPS-00042] Printer down')).toBe('IPS-00042');
    expect(extractCaseRef('[case ips-7] hello')).toBe('IPS-7');
  });

  test('ignores a bare number that merely looks like one', () => {
    // Matching an unbracketed number would thread any email quoting an invoice
    // or a part number into somebody's case.
    expect(extractCaseRef('About IPS-00042')).toBeNull();
    expect(extractCaseRef('Order 12345 delayed')).toBeNull();
    expect(extractCaseRef('')).toBeNull();
    expect(extractCaseRef(undefined)).toBeNull();
  });
});

describe('normaliseSubject()', () => {
  test('strips stacked reply and forward prefixes', () => {
    expect(normaliseSubject('RE: Re: Fwd: Printer down')).toBe('printer down');
    expect(normaliseSubject('AW: Drucker defekt')).toBe('drucker defekt');
    expect(normaliseSubject('RE[2]: Printer down')).toBe('printer down');
  });

  test('collapses whitespace so spacing does not fork a thread', () => {
    expect(normaliseSubject('  Printer   down  ')).toBe('printer down');
  });

  test('survives an empty or missing subject', () => {
    expect(normaliseSubject('')).toBe('');
    expect(normaliseSubject(null)).toBe('');
  });
});

describe('stripQuotedReply()', () => {
  test('cuts the quoted history off a reply', () => {
    const body = 'Still broken, thanks.\n\nOn 8 Sep 2026, Support wrote:\n> Have you tried restarting?';
    expect(stripQuotedReply(body)).toBe('Still broken, thanks.');
  });

  test('handles the Outlook separator', () => {
    expect(stripQuotedReply('Any update?\n\n-----Original Message-----\nFrom: Support'))
      .toBe('Any update?');
  });

  test('keeps the message when stripping would leave nothing', () => {
    // A reply that is ONLY quoted text still has to be filed — losing the
    // customer's message entirely is worse than keeping some quoting.
    const onlyQuote = '> Have you tried restarting?';
    expect(stripQuotedReply(onlyQuote)).toBe(onlyQuote);
  });

  test('does not cut a message that merely mentions "from"', () => {
    const body = 'The error comes from the label printer, not the server.';
    expect(stripQuotedReply(body)).toBe(body);
  });
});

describe('isAutoReply()', () => {
  test('detects RFC auto-submitted', () => {
    expect(isAutoReply({ 'Auto-Submitted': 'auto-replied' }, 'Re: hello')).toBe(true);
    expect(isAutoReply({ 'auto-submitted': 'no' }, 'Re: hello')).toBe(false);
  });

  test('detects out-of-office and bounces by subject', () => {
    expect(isAutoReply({}, 'Out of Office: Re: Printer down')).toBe(true);
    expect(isAutoReply({}, 'Undeliverable: Printer down')).toBe(true);
    expect(isAutoReply({}, 'Automatic reply: away')).toBe(true);
  });

  test('detects mailing lists', () => {
    expect(isAutoReply({ 'List-Unsubscribe': '<mailto:x>' }, 'Newsletter')).toBe(true);
    expect(isAutoReply({ Precedence: 'bulk' }, 'Offers')).toBe(true);
  });

  test('a genuine customer reply is NOT an auto-reply', () => {
    // The expensive false positive: silently ignoring a real customer.
    expect(isAutoReply({}, 'Re: Printer down')).toBe(false);
    expect(isAutoReply({ 'X-Mailer': 'Outlook' }, 'Still broken')).toBe(false);
  });
});

describe('parseMessageIds()', () => {
  test('strips angle brackets and splits a References chain', () => {
    expect(parseMessageIds('<a@x.com> <b@x.com>')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseMessageIds('<a@x.com>')).toEqual(['a@x.com']);
    expect(parseMessageIds('')).toEqual([]);
    expect(parseMessageIds(null)).toEqual([]);
  });
});

describe('findThread()', () => {
  const base = { companyId: 1, fromEmail: 'cust@example.com', subject: 'Printer down' };

  test('prefers the subject token over everything else', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 11 }] }) };
    const out = await findThread(pool, { ...base, subject: 'Re: [Case IPS-00011] Printer down' });
    expect(out).toEqual({ ticketId: 11, by: 'subject_token' });
    expect(pool.query).toHaveBeenCalledTimes(1);   // stopped at the reliable key
  });

  test('falls back to In-Reply-To naming a message we sent', async () => {
    // No token in the subject means the token query is never ISSUED, so the
    // In-Reply-To lookup is the FIRST query. Queueing a row for the skipped
    // query shifts everything and the answer silently comes back as a heuristic
    // match on an undefined id.
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ticket_id: 22 }] }) };
    const out = await findThread(pool, { ...base, inReplyTo: '<our-id@pulse>' });
    expect(out).toEqual({ ticketId: 22, by: 'in_reply_to' });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('the heuristic is BOUNDED by time and by open status', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await findThread(pool, base);
    const heuristic = String(pool.query.mock.calls.at(-1)[0]);
    // Without both bounds, two unrelated "Not working" emails from one customer
    // months apart become one case.
    expect(heuristic).toContain('created_at >=');
    expect(heuristic).toContain("NOT IN ('closed','resolved','cancelled')");
  });

  test('returns null rather than guessing when nothing matches', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await findThread(pool, base)).toBeNull();
  });
});

describe('ingest()', () => {
  const mailbox = { id: 1, company_id: 1, email_address: 'support@example.com',
                    default_priority: 'Medium' };
  const nextTicketNumber = async () => 'IPS-00099';

  test('a message with no sender is REJECTED and recorded', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    const out = await ingest(pool, { mailbox, message: { subject: 'hi' }, nextTicketNumber });
    expect(out.outcome).toBe('rejected');
    expect(out.reason).toBe('no_sender');
    // Recorded, not dropped: "the customer says they emailed us" has to be
    // answerable.
    expect(String(pool.query.mock.calls[0][0])).toContain('INSERT INTO inbound_emails');
  });

  test('an auto-reply is IGNORED and never opens a case', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    const out = await ingest(pool, {
      mailbox, nextTicketNumber,
      message: { from: 'cust@example.com', subject: 'Out of Office: Re: hi' },
    });
    expect(out.outcome).toBe('ignored');
    const sql = pool.query.mock.calls.map(c => String(c[0]));
    expect(sql.some(s => s.includes('INSERT INTO support_tickets'))).toBe(false);
  });

  test('a retried webhook delivery does NOT open a second case', async () => {
    // Providers retry. Without this, one customer email becomes three tickets.
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 5, ticket_id: 33, status: 'created_ticket' }] }) };
    const out = await ingest(pool, {
      mailbox, nextTicketNumber,
      message: { from: 'cust@example.com', subject: 'hi', message_id: '<dup@x>' },
    });
    expect(out.outcome).toBe('duplicate');
    expect(out.ticketId).toBe(33);
    expect(pool.query.mock.calls.map(c => String(c[0]))
      .some(s => s.includes('INSERT INTO support_tickets'))).toBe(false);
  });
});

describe('outboundSubject()', () => {
  test('adds the token so the reply threads back', () => {
    expect(outboundSubject('IPS-00042', 'Re: Printer down'))
      .toBe('[Case IPS-00042] Re: Printer down');
  });

  test('does not add it twice', () => {
    const s = '[Case IPS-00042] Re: Printer down';
    expect(outboundSubject('IPS-00042', s)).toBe(s);
  });
});
