/**
 * emailToCase.routes.js — inbound mail, mailbox configuration, and the log.
 *
 * TWO SURFACES, TWO AUTH MODELS:
 *   - /ingest is called by a mail provider's WEBHOOK, which has no ERP login. It
 *     authenticates with a per-mailbox shared secret. It is NOT open: a mailbox
 *     with no secret configured refuses ingestion outright, because an endpoint
 *     that creates tickets from arbitrary JSON is a spam relay with a database
 *     behind it.
 *   - everything else is normal ERP access, gated on `servicedesk`.
 *
 * ⚠ Nothing here fabricates mail. With no mailbox configured the endpoints
 * return empty and say so, rather than showing an inbox that was never connected.
 */

import express from 'express';
import crypto from 'crypto';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';
import { nextServiceTicketNumber } from '../../../shared/docNumber.js';
import { ingest, outboundSubject } from '../services/emailToCase.service.js';

/** Webhook surface — mounted WITHOUT verifyToken, secured by the mailbox secret. */
export const ingestRouter = express.Router();

/** Authenticated surface — mounted behind verifyToken. */
export const adminRouter = express.Router();

const canView = requirePermission('servicedesk', 'view');
const canEdit = requirePermission('servicedesk', 'edit');
const fail = (res, err) => res.status(500).json({ error: err.message });

/**
 * Constant-time secret comparison.
 *
 * A plain `===` on a secret leaks its length and prefix through timing. Cheap to
 * do correctly, and this endpoint is reachable without a login.
 */
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * POST /api/support-mail/ingest
 *
 * Body is one message as the provider delivers it. The mailbox is identified by
 * `to`, and the caller must present that mailbox's secret.
 */
ingestRouter.post('/ingest', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const to = String(body.to || '').replace(/.*<([^>]+)>.*/, '$1').trim().toLowerCase();
    if (!to) return res.status(400).json({ error: 'to is required to identify the mailbox' });

    const { rows: [mailbox] } = await pool.query(
      `SELECT * FROM support_mailboxes
        WHERE LOWER(email_address) = $1 AND is_active = true`, [to]);
    // The same answer for "no such mailbox" and "wrong secret": distinguishing
    // them tells an unauthenticated caller which addresses exist.
    const presented = req.get('x-ingest-secret') || body.secret;
    if (!mailbox || !mailbox.ingest_secret || !secretMatches(presented, mailbox.ingest_secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await ingest(pool, {
      mailbox,
      message: {
        from: body.from, to: body.to, subject: body.subject,
        text: body.text, html: body.html, headers: body.headers || {},
        message_id: body.message_id || body.messageId || body.headers?.['Message-ID'],
        in_reply_to: body.in_reply_to || body.headers?.['In-Reply-To'],
        references: body.references || body.headers?.References,
        received_at: body.received_at,
      },
      // Takes a client/pool, NOT a company id — the sequence is global.
      nextTicketNumber: () => nextServiceTicketNumber(pool),
    });

    if (result.ticketId) {
      logAudit({ userId: null, module: 'service', recordId: result.ticketId,
        recordType: 'support_ticket', action: result.outcome,
        newData: { channel: 'email', from: body.from, outcome: result.outcome }, req });
    }
    res.status(result.outcome === 'created_ticket' ? 201 : 200).json({
      outcome: result.outcome,
      ticket_id: result.ticketId || null,
      ticket_number: result.ticket?.ticket_number || null,
      threaded_by: result.by || null,
      reason: result.reason || null,
    });
  } catch (err) { fail(res, err); }
});

// ── mailbox configuration ────────────────────────────────────────────────────
adminRouter.get('/mailboxes', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, company_id, email_address, display_name, default_team, default_priority,
              default_category, auto_reply, is_active, created_at,
              -- The secret itself is never returned; only whether one is set.
              (ingest_secret IS NOT NULL) AS ingest_configured
         FROM support_mailboxes
        WHERE company_id = $1
        ORDER BY email_address`,
      [companyOf(req)]);
    res.json({
      data: rows,
      // Said plainly rather than shown as an empty inbox: nothing has been
      // connected, so nothing can arrive.
      status: rows.length
        ? undefined
        : 'No support mailbox is configured, so no email can be received. Add one and point your mail provider at POST /api/support-mail/ingest.',
    });
  } catch (err) { fail(res, err); }
});

adminRouter.post('/mailboxes', canEdit, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { email_address, display_name, default_team, default_priority,
            default_category, auto_reply } = req.body || {};
    if (!email_address) return res.status(400).json({ error: 'email_address is required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email_address)) {
      return res.status(400).json({ error: 'email_address is not a valid address' });
    }

    // Generated here, shown ONCE. A secret the user has to invent is a secret
    // that ends up being "support123".
    const secret = crypto.randomBytes(24).toString('base64url');
    const { rows: [mailbox] } = await pool.query(
      `INSERT INTO support_mailboxes
         (company_id, email_address, display_name, ingest_secret, default_team,
          default_priority, default_category, auto_reply)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'Medium'),$7,COALESCE($8,false))
       ON CONFLICT (company_id, email_address) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             default_team = EXCLUDED.default_team,
             default_priority = EXCLUDED.default_priority,
             default_category = EXCLUDED.default_category,
             auto_reply = EXCLUDED.auto_reply,
             is_active = true,
             updated_at = NOW()
       RETURNING id, email_address, display_name, default_team, default_priority, is_active,
                 (ingest_secret IS NOT NULL) AS ingest_configured,
                 -- xmax = 0 means this row was INSERTED, not updated. The
                 -- upsert deliberately leaves ingest_secret alone on conflict
                 -- (silently rotating it would break a working integration), so
                 -- this is how we know whether the secret above was stored.
                 (xmax = 0) AS was_created`,
      [companyId, String(email_address).toLowerCase(), display_name || null, secret,
       default_team || null, default_priority || null, default_category || null, auto_reply]);

    logAudit({ userId: req.user?.userId, module: 'service', recordId: mailbox.id,
      recordType: 'support_mailbox', action: mailbox.was_created ? 'create' : 'update',
      newData: { ...mailbox, ingest_secret: '[REDACTED]' }, req });

    // ⚠ Return the secret ONLY when it was actually stored. Handing back a
    // freshly generated secret after an update would give the caller a value
    // that authenticates nothing — every webhook using it would 401, and the
    // failure would look like a mail-provider problem.
    const { was_created, ...row } = mailbox;
    res.status(was_created ? 201 : 200).json({
      ...row,
      ingest_secret: was_created ? secret : undefined,
      notice: was_created
        ? 'Copy this secret now — it is not shown again. Your mail provider must send it as the X-Ingest-Secret header.'
        : 'Settings updated. The existing ingest secret is unchanged — use the rotate endpoint if you need a new one.',
    });
  } catch (err) { fail(res, err); }
});

/** Rotate a mailbox's secret. Returns the new one once. */
adminRouter.post('/mailboxes/:id/rotate-secret', canEdit, async (req, res) => {
  try {
    const secret = crypto.randomBytes(24).toString('base64url');
    const { rows } = await pool.query(
      `UPDATE support_mailboxes SET ingest_secret = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING id, email_address`,
      [secret, req.params.id, companyOf(req)]);
    if (!rows.length) return res.status(404).json({ error: 'Mailbox not found' });

    logAudit({ userId: req.user?.userId, module: 'service', recordId: rows[0].id,
      recordType: 'support_mailbox', action: 'rotate_secret', req });
    res.json({ ...rows[0], ingest_secret: secret,
      notice: 'The previous secret stopped working immediately. Update your mail provider now.' });
  } catch (err) { fail(res, err); }
});

adminRouter.delete('/mailboxes/:id', canEdit, async (req, res) => {
  try {
    // Deactivated, not deleted: inbound_emails references it, and the history of
    // what arrived where is worth keeping.
    const { rows } = await pool.query(
      `UPDATE support_mailboxes SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING id, email_address`,
      [req.params.id, companyOf(req)]);
    if (!rows.length) return res.status(404).json({ error: 'Mailbox not found' });
    res.json({ success: true, deactivated: rows[0] });
  } catch (err) { fail(res, err); }
});

// ── the log ──────────────────────────────────────────────────────────────────
/**
 * Every message received, including the ones that did NOT become a case.
 *
 * This is the answer to "the customer says they emailed us" — a rejection or an
 * auto-reply is visible here with the reason.
 */
adminRouter.get('/inbound', canView, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const params = [companyId];
    let where = 'e.company_id = $1';
    if (req.query.status) { params.push(req.query.status); where += ` AND e.status = $${params.length}`; }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT e.id, e.message_id, e.from_email, e.from_name, e.to_email, e.subject,
              e.received_at, e.status, e.threaded_by, e.reject_reason, e.ticket_id,
              t.ticket_number, t.status AS ticket_status
         FROM inbound_emails e
         LEFT JOIN support_tickets t ON t.id = e.ticket_id
        WHERE ${where}
        ORDER BY e.received_at DESC
        LIMIT $${params.length}`,
      params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

adminRouter.get('/inbound/summary', canView, async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'created_ticket')::int AS created,
              COUNT(*) FILTER (WHERE status = 'appended')::int       AS appended,
              COUNT(*) FILTER (WHERE status = 'ignored')::int        AS ignored,
              COUNT(*) FILTER (WHERE status = 'rejected')::int       AS rejected,
              COUNT(*) FILTER (WHERE threaded_by = 'heuristic')::int AS threaded_by_guess,
              COUNT(*)::int AS total,
              MAX(received_at) AS last_received
         FROM inbound_emails WHERE company_id = $1`,
      [companyOf(req)]);
    res.json(row);
  } catch (err) { fail(res, err); }
});

/** The subject a reply should carry, so the customer's answer threads back. */
adminRouter.get('/outbound-subject/:ticketId', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ticket_number, title FROM support_tickets
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [req.params.ticketId, companyOf(req)]);
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ subject: outboundSubject(rows[0].ticket_number, `Re: ${rows[0].title}`) });
  } catch (err) { fail(res, err); }
});

export default { ingestRouter, adminRouter };
