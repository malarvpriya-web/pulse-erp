/**
 * emailToCase.service.js
 *
 * Turns a genuinely-received email into a case, or threads it onto the case it
 * is replying to.
 *
 * ⚠ THIS SERVICE NEVER INVENTS MAIL. It is called with a message that a real
 * provider webhook or IMAP poller delivered. Nothing here polls a fake inbox or
 * synthesises activity — an unconfigured system ingests nothing and says so.
 */

/**
 * The token we put in outbound subjects so a reply threads reliably.
 *
 * Deliberately distinctive: matching a bare ticket number would thread any email
 * that happened to quote a number in that format.
 */
export const CASE_TOKEN = /\[Case[ #:-]*([A-Z]{2,6}-\d{1,10})\]/i;

export function extractCaseRef(subject) {
  const m = CASE_TOKEN.exec(String(subject || ''));
  return m ? m[1].toUpperCase() : null;
}

/**
 * Strip reply and forward prefixes, in the languages a subject actually arrives
 * in, and collapse whitespace — so "RE: RE: Fwd: Printer down" and
 * "Printer down" compare equal.
 */
export function normaliseSubject(subject) {
  let s = String(subject || '').trim();
  // Repeatedly, not once: mail clients stack prefixes.
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^\s*(re|aw|fwd?|tr|antwort|rif)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Pull the quoted history off a reply.
 *
 * Without this every reply appends the entire thread again, and a case that has
 * been round-tripped five times becomes unreadable. Conservative on purpose: it
 * only cuts at markers that unambiguously begin quoted text, because losing a
 * customer's actual words is far worse than keeping some quoted ones.
 */
export function stripQuotedReply(body) {
  const text = String(body || '');
  const markers = [
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^_{10,}/m,
    /^On .{10,120}\bwrote:\s*$/im,
    /^From:\s.+$/im,
    /^\s*>{1,}\s?.*$/m,
  ];
  let cut = text.length;
  for (const rx of markers) {
    const m = rx.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const trimmed = text.slice(0, cut).trim();
  // If stripping would leave nothing, the whole message WAS the quoted block —
  // keep the original rather than filing an empty reply.
  return trimmed.length ? trimmed : text.trim();
}

/** Bounces and auto-replies must not open cases or wake an agent. */
export function isAutoReply(headers = {}, subject = '') {
  const h = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v ?? '')]));
  if (h['auto-submitted'] && h['auto-submitted'].toLowerCase() !== 'no') return true;
  if (h['x-autoreply'] || h['x-autorespond']) return true;
  if (h['precedence'] && /bulk|auto_reply|junk|list/i.test(h['precedence'])) return true;
  if (h['x-auto-response-suppress']) return true;
  if (h['list-unsubscribe'] || h['list-id']) return true;
  return /^\s*(out of office|automatic reply|auto[- ]?reply|undeliverable|delivery status notification|mail delivery failed)/i
    .test(String(subject || ''));
}

const addr = (v) => {
  const s = String(v || '');
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
};
const displayName = (v) => {
  const s = String(v || '').trim();
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(s);
  return m ? m[1].trim() : null;
};

/** Message-ID values, normalised out of their angle brackets. */
export function parseMessageIds(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map(s => s.replace(/^</, '').replace(/>$/, '').trim())
    .filter(Boolean);
}

/**
 * Find the case this message belongs to.
 *
 * Returns { ticketId, by } or null. Tried in order of reliability — see the
 * migration header for why the heuristic is last and time-bounded.
 */
export async function findThread(pool, { companyId, subject, inReplyTo, references, fromEmail, now = new Date() }) {
  // 1. our own token in the subject
  const ref = extractCaseRef(subject);
  if (ref) {
    const { rows } = await pool.query(
      `SELECT id FROM support_tickets
        WHERE company_id = $1 AND UPPER(ticket_number) = $2 AND deleted_at IS NULL`,
      [companyId, ref]);
    if (rows.length) return { ticketId: rows[0].id, by: 'subject_token' };
  }

  // 2. In-Reply-To / References naming a message we sent
  const ids = [...parseMessageIds(inReplyTo), ...parseMessageIds(references)];
  if (ids.length) {
    const { rows } = await pool.query(
      `SELECT c.ticket_id
         FROM ticket_conversations c
         JOIN support_tickets t ON t.id = c.ticket_id
        WHERE c.message_id = ANY($1) AND t.company_id = $2 AND t.deleted_at IS NULL
        ORDER BY c.created_at DESC
        LIMIT 1`,
      [ids, companyId]);
    if (rows.length) return { ticketId: rows[0].ticket_id, by: 'in_reply_to' };
  }

  // 3. same sender, same normalised subject, recently, on a case still open.
  //    Bounded to 30 days and to open cases: without both, two unrelated
  //    "Not working" emails from one customer months apart become one case.
  if (fromEmail && subject) {
    const { rows } = await pool.query(
      `SELECT id FROM support_tickets
        WHERE company_id = $1
          AND LOWER(requester_email) = $2
          AND deleted_at IS NULL
          AND LOWER(status) NOT IN ('closed','resolved','cancelled')
          AND created_at >= $3
          AND REGEXP_REPLACE(
                REGEXP_REPLACE(LOWER(title), '^\\s*((re|aw|fwd?|tr)\\s*:\\s*)+', ''),
                '\\s+', ' ', 'g') = $4
        ORDER BY created_at DESC
        LIMIT 1`,
      [companyId, addr(fromEmail), new Date(now.getTime() - 30 * 86400000), normaliseSubject(subject)]);
    if (rows.length) return { ticketId: rows[0].id, by: 'heuristic' };
  }

  return null;
}

/**
 * Ingest one message.
 *
 * Every outcome is recorded in `inbound_emails`, including refusals — "why did
 * that customer's email never arrive" is the first question support asks, and a
 * silent drop makes it unanswerable.
 */
export async function ingest(pool, { mailbox, message, now = new Date(), nextTicketNumber }) {
  const companyId = mailbox.company_id;
  const fromEmail = addr(message.from);
  const subject = String(message.subject || '').trim();
  const headers = message.headers || {};
  const messageId = parseMessageIds(message.message_id)[0] || null;

  const record = async (status, extra = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO inbound_emails
         (company_id, mailbox_id, message_id, in_reply_to, references_hdr, from_email, from_name,
          to_email, subject, body_text, body_html, received_at, status, ticket_id, threaded_by,
          reject_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (company_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [companyId, mailbox.id, messageId, message.in_reply_to || null, message.references || null,
       fromEmail || null, displayName(message.from), addr(message.to) || mailbox.email_address,
       subject || null, message.text || null, message.html || null,
       message.received_at ? new Date(message.received_at) : now,
       status, extra.ticketId || null, extra.by || null, extra.reason || null]);
    return rows[0] || null;
  };

  if (!fromEmail) return { outcome: 'rejected', reason: 'no_sender', email: await record('rejected', { reason: 'Message had no usable From address' }) };

  // A bounce threaded onto a case reads as the customer replying, and an
  // out-of-office can ping-pong with an auto-reply for ever.
  if (isAutoReply(headers, subject)) {
    return { outcome: 'ignored', reason: 'auto_reply',
             email: await record('ignored', { reason: 'Automatic reply or bounce' }) };
  }

  // Idempotency: a provider retry must not open a second case.
  if (messageId) {
    const { rows } = await pool.query(
      `SELECT id, ticket_id, status FROM inbound_emails
        WHERE company_id = $1 AND message_id = $2`, [companyId, messageId]);
    if (rows.length) {
      return { outcome: 'duplicate', ticketId: rows[0].ticket_id, email: rows[0] };
    }
  }

  const thread = await findThread(pool, {
    companyId, subject, inReplyTo: message.in_reply_to,
    references: message.references, fromEmail, now,
  });

  const body = stripQuotedReply(message.text || message.html || '');

  if (thread) {
    const email = await record('appended', { ticketId: thread.ticketId, by: thread.by });
    await pool.query(
      `INSERT INTO ticket_conversations
         (ticket_id, message, is_internal, created_by_name, channel, message_id, in_reply_to,
          inbound_email_id)
       VALUES ($1,$2,false,$3,'email',$4,$5,$6)`,
      [thread.ticketId, body, displayName(message.from) || fromEmail, messageId,
       message.in_reply_to || null, email?.id || null]);

    // A customer replying to a resolved case reopens it. Leaving it resolved
    // means the reply is filed where nobody is looking.
    const { rows: [reopened] } = await pool.query(
      `UPDATE support_tickets
          SET status = CASE WHEN LOWER(status) IN ('resolved','closed') THEN 'Open' ELSE status END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, ticket_number, status`,
      [thread.ticketId]);

    return { outcome: 'appended', ticketId: thread.ticketId, by: thread.by, ticket: reopened, email };
  }

  // New case.
  const ticketNumber = await nextTicketNumber();
  const { rows: [ticket] } = await pool.query(
    `INSERT INTO support_tickets
       (ticket_number, title, description, status, priority, category, team,
        requester_email, requester_name, requester_name_raw, company_id, channel, created_at)
     VALUES ($1,$2,$3,'Open',$4,$5,$6,$7,$8,$9,$10,'email',NOW())
     RETURNING id, ticket_number, status`,
    [ticketNumber, subject || '(no subject)', body, mailbox.default_priority || 'Medium',
     mailbox.default_category || null, mailbox.default_team || null,
     fromEmail, displayName(message.from) || fromEmail, displayName(message.from),
     companyId]);

  const email = await record('created_ticket', { ticketId: ticket.id });
  await pool.query(
    `INSERT INTO ticket_conversations
       (ticket_id, message, is_internal, created_by_name, channel, message_id, inbound_email_id)
     VALUES ($1,$2,false,$3,'email',$4,$5)`,
    [ticket.id, body, displayName(message.from) || fromEmail, messageId, email?.id || null]);

  return { outcome: 'created_ticket', ticketId: ticket.id, ticket, email };
}

/** The subject line to send OUT, carrying the token that makes replies thread. */
export function outboundSubject(ticketNumber, subject) {
  const s = String(subject || '');
  return CASE_TOKEN.test(s) ? s : `[Case ${ticketNumber}] ${s}`;
}
