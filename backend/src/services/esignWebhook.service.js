/**
 * esignWebhook.service.js — outbound e-signature event webhooks.
 *
 * Companies register endpoint URLs (esign_webhooks). On signing lifecycle events
 * we POST a JSON payload signed with HMAC-SHA256 (X-Pulse-Signature header) so
 * receivers can verify authenticity. Deliveries are logged and never block the
 * signing flow (fire-and-forget).
 *
 * Events: request.sent, signer.signed, request.completed, request.declined,
 *         signer.delegated, request.viewed
 */

import crypto from 'crypto';
import pool from '../config/db.js';

const TIMEOUT_MS = 8000;

function sign(secret, body) {
  return crypto.createHmac('sha256', secret || '').update(body).digest('hex');
}

async function deliver(webhook, event, signingId, payload) {
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let status = null, ok = false, errMsg = null;
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pulse-Event': event,
        'X-Pulse-Signature': sign(webhook.secret, body),
      },
      body,
      signal: controller.signal,
    });
    status = res.status;
    ok = res.ok;
  } catch (e) {
    errMsg = e.name === 'AbortError' ? 'timeout' : e.message;
  } finally {
    clearTimeout(timer);
  }

  await pool.query(
    `INSERT INTO esign_webhook_deliveries (webhook_id, event, signing_id, response_status, success, error)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [webhook.id, event, signingId, status, ok, errMsg]
  ).catch(() => {});

  await pool.query(
    `UPDATE esign_webhooks
        SET last_status = $2, last_delivered_at = NOW(),
            failure_count = CASE WHEN $3 THEN 0 ELSE failure_count + 1 END,
            updated_at = NOW()
      WHERE id = $1`,
    [webhook.id, status, ok]
  ).catch(() => {});
}

/**
 * Emit an e-sign event to every active, subscribed webhook for the signing's
 * company. Non-blocking — call without await from route handlers.
 */
export async function emitEsignEvent(signingId, event, extra = {}) {
  try {
    const { rows: [signing] } = await pool.query(
      `SELECT id, title, doc_type, status, company_id, signed_count, total_signers,
              document_hash, completed_at, bulk_batch_id
         FROM document_signings WHERE id = $1`,
      [signingId]
    );
    if (!signing) return;

    const { rows: hooks } = await pool.query(
      `SELECT * FROM esign_webhooks
        WHERE active = TRUE
          AND (company_id = $1 OR company_id IS NULL)
          AND (events @> '["all"]'::jsonb OR events @> $2::jsonb)`,
      [signing.company_id, JSON.stringify([event])]
    );
    if (!hooks.length) return;

    const payload = {
      event,
      occurred_at: new Date().toISOString(),
      data: {
        signing_id: signing.id,
        title: signing.title,
        doc_type: signing.doc_type,
        status: signing.status,
        signed_count: signing.signed_count,
        total_signers: signing.total_signers,
        document_hash: signing.document_hash,
        completed_at: signing.completed_at,
        bulk_batch_id: signing.bulk_batch_id,
        ...extra,
      },
    };

    await Promise.allSettled(hooks.map(h => deliver(h, event, signing.id, payload)));
  } catch (e) {
    console.error('[esignWebhook] emit failed:', e.message);
  }
}
