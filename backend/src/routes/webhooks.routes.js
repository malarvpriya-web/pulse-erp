// backend/src/routes/webhooks.routes.js
// Public webhook endpoints — mounted BEFORE verifyToken in server.js (no JWT auth)
import { Router } from 'express';
import crypto from 'crypto';
import pool from '../modules/shared/db.js';
import { auditMutations } from '../middlewares/auditMutations.js';
import { resolveConfig } from '../modules/integrations/integrationConfig.js';

/*
 * The audit floor is mounted PER ROUTE here, not on the router, because the
 * two handlers belong to different modules: zoho-sign settles a signature and
 * razorpay settles money. Labelling both the same would file a payment under
 * `documents` and break every audit query that trusts the label — §8c's rule
 * that a wrong module label is worse than no label at all.
 *
 * These run without a JWT (a payment provider has no ERP login), so the floor
 * records userId null. That is the honest actor: the row still carries the
 * route, the payload and the resulting status, which is what makes an
 * externally-triggered change reconstructable at all. Request bodies pass
 * through the middleware's redact(), so a provider signature in the payload
 * is stored as [REDACTED].
 */

const router = Router();

/**
 * ── Webhook signature verification: FAIL CLOSED ──────────────────────────────
 *
 * PULSE-01 remaining risk 4 was "webhook secrets are env-only". Closing it
 * surfaced two worse problems in the checks themselves:
 *
 *  1. `/zoho-sign` verified only `if (secret) { if (incomingSig) { ... } }`.
 *     A caller who simply OMITTED the signature header skipped verification
 *     entirely — so anyone could POST a forged REQUEST_COMPLETED and mark any
 *     document signed, with a secret correctly configured.
 *  2. BOTH handlers skipped verification when no secret was configured at all.
 *     A deployment that had not set RAZORPAY_WEBHOOK_SECRET would accept any
 *     forged `payment.captured` and mark invoices paid — unauthenticated
 *     financial fraud, reachable by anyone who knows the URL.
 *
 * Now: a missing signature is a rejection, and a missing SECRET is a rejection in
 * production. Development still allows an unsigned call so a provider sandbox can
 * be wired up locally, but it says so loudly every time.
 *
 * ⚠ The tenant is selected from UNVERIFIED payload data (the request/order id) —
 * deliberately, and it is safe: it only chooses WHICH secret the HMAC is checked
 * against, and the HMAC still has to pass. Pointing a forged call at another
 * tenant's row does not help an attacker who does not hold that tenant's secret.
 */
const SIGNATURE_ALGO = 'sha256';

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself an answer.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
function verifyWebhook({ provider, secret, signature, rawBody, res: _res }) {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!secret) {
    if (isProduction) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(), level: 'ERROR', event: 'webhook_secret_missing',
        provider,
        message: `No webhook secret is configured for ${provider}. The request was REJECTED rather than trusted. ` +
                 'Set it under Integrations for the tenant, or in the server environment.',
      }));
      return { ok: false, status: 503, error: 'webhook_not_configured' };
    }
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'webhook_unverified',
      provider,
      message: `No webhook secret configured for ${provider} — accepting an UNVERIFIED payload because this is not production. ` +
               'This would be rejected in production.',
    }));
    return { ok: true, unverified: true };
  }

  if (!signature) {
    console.warn(`[Webhook/${provider}] No signature header — rejected`);
    return { ok: false, status: 401, error: 'Missing webhook signature' };
  }

  const expected = crypto.createHmac(SIGNATURE_ALGO, secret).update(rawBody).digest('hex');
  if (!timingSafeEqualHex(signature, expected)) {
    console.warn(`[Webhook/${provider}] Signature mismatch — rejected`);
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true };
}

// ── POST /webhooks/zoho-sign ──────────────────────────────────────────────────
// Receives status events from Zoho Sign and updates document_signings table.
// Configure in Zoho Sign dashboard: Settings → Notifications → Webhook URL
// Set URL to: https://yourapp.com/api/webhooks/zoho-sign
//
// Optional: set ZOHO_SIGN_WEBHOOK_SECRET env var to the "Notification Secret"
// from Zoho Sign — enables HMAC-SHA256 signature verification.
router.post('/zoho-sign', auditMutations('documents'), async (req, res) => {
  try {
    const { requests: zsReq, notifications } = req.body || {};
    const requestId   = zsReq?.request_id;

    // Which tenant owns the referenced document? Unverified input, used ONLY to
    // pick the secret — the HMAC still has to pass. See verifyWebhook.
    let webhookCompanyId = null;
    if (requestId) {
      const { rows } = await pool.query(
        `SELECT company_id FROM document_signings WHERE sign_token = $1 LIMIT 1`, [requestId]
      ).catch(() => ({ rows: [] }));
      webhookCompanyId = rows[0]?.company_id ?? null;
    }
    // Per tenant where one is stored, deployment env otherwise — resolveConfig does
    // that fallback. ZOHO_SIGN_WEBHOOK_SECRET is not an allowlisted tenant field
    // today, so this reads the deployment value and starts honouring a tenant one
    // the moment it is added to INTEGRATION_FIELDS.
    const { ZOHO_SIGN_WEBHOOK_SECRET: tenantWebhookSecret } =
      await resolveConfig(webhookCompanyId, 'zoho-sign').catch(() => ({}));
    const verdict = verifyWebhook({
      provider: 'ZohoSign',
      secret: tenantWebhookSecret || process.env.ZOHO_SIGN_WEBHOOK_SECRET,
      signature: req.headers['x-zoho-sign-hmac'] || req.headers['x-zs-webhook-token'] || '',
      rawBody: req.rawBody || JSON.stringify(req.body),
    });
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    const eventType   = notifications?.event_type   || '';
    const reqStatus   = (zsReq?.request_status || '').toLowerCase();
    const performedBy = notifications?.performed_by_email || '';

    console.log(`[Webhook/ZohoSign] event=${eventType} requestId=${requestId} status=${reqStatus}`);

    if (!requestId) return res.json({ status: 'ok', note: 'no request_id' });

    let newStatus  = null;
    let signedDate = null;

    if (eventType === 'REQUEST_COMPLETED' || reqStatus === 'completed') {
      newStatus  = 'signed';
      signedDate = new Date().toISOString().slice(0, 10);
    } else if (
      ['REQUEST_DECLINED', 'REQUEST_RECALLED'].includes(eventType) ||
      ['declined', 'recalled', 'revoked'].includes(reqStatus)
    ) {
      newStatus = 'declined';
    } else if (eventType === 'REQUEST_EXPIRED' || reqStatus === 'expired') {
      newStatus = 'expired';
    }
    // DOCUMENT_OPENED / DOCUMENT_SIGNED events don't change status — just log them

    if (newStatus) {
      const { rowCount } = await pool.query(
        `UPDATE document_signings
         SET status = $1, signed_date = $2, updated_at = NOW()
         WHERE sign_token = $3`,
        [newStatus, signedDate, requestId]
      );
      console.log(`[Webhook/ZohoSign] Updated ${rowCount} record(s) → ${newStatus}`);
    }

    res.json({
      status: 'ok',
      event:     eventType || reqStatus,
      processed: !!newStatus,
      performed_by: performedBy || undefined,
    });
  } catch (e) {
    console.error('[Webhook/ZohoSign]', e.message);
    // Always return 200 to Zoho so it doesn't keep retrying transient errors
    res.json({ status: 'error', message: e.message });
  }
});

// ── POST /webhooks/razorpay ───────────────────────────────────────────────────
// Handles real-time payment status updates from Razorpay.
// Configure webhook URL in Razorpay Dashboard → Settings → Webhooks.
// Set RAZORPAY_WEBHOOK_SECRET env var to the secret shown in dashboard.
//
// Events handled:
//   payment.captured     → mark invoice paid, record transaction
//   payment.failed       → update order status to failed
//   payment.link.paid    → mark invoice paid via payment link
//   refund.created       → log refund (future: create credit note)
router.post('/razorpay', auditMutations('finance'), async (req, res) => {
  try {
    // The order row names the tenant whose Razorpay account this payment belongs
    // to, and therefore whose webhook secret must sign it. Unverified input, used
    // ONLY to pick the secret — the HMAC still has to pass. See verifyWebhook.
    const orderIdForTenant =
      req.body?.payload?.payment?.entity?.order_id ||
      req.body?.payload?.payment_link?.entity?.payment?.order_id || null;
    let webhookCompanyId = null;
    if (orderIdForTenant) {
      const { rows } = await pool.query(
        `SELECT company_id FROM payment_gateway_orders WHERE razorpay_order_id = $1 LIMIT 1`,
        [orderIdForTenant]
      ).catch(() => ({ rows: [] }));
      webhookCompanyId = rows[0]?.company_id ?? null;
    }
    const { RAZORPAY_WEBHOOK_SECRET: tenantWebhookSecret } =
      await resolveConfig(webhookCompanyId, 'razorpay').catch(() => ({}));
    const verdict = verifyWebhook({
      provider: 'Razorpay',
      secret: tenantWebhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET,
      signature: req.headers['x-razorpay-signature'] || '',
      rawBody: req.rawBody || JSON.stringify(req.body),
    });
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    const event   = req.body?.event   || '';
    const payload = req.body?.payload || {};

    console.log(`[Webhook/Razorpay] event=${event}`);

    if (event === 'payment.captured' || event === 'payment.link.paid') {
      const paymentEntity = payload?.payment?.entity || payload?.payment_link?.entity?.payment || {};
      const razorpay_payment_id = paymentEntity.id;
      const razorpay_order_id   = paymentEntity.order_id;
      const amountPaise         = paymentEntity.amount || 0;
      const amount              = amountPaise / 100;

      if (razorpay_order_id) {
        const { rows: [pgo] } = await pool.query(
          `UPDATE payment_gateway_orders
           SET razorpay_payment_id = $1, status = 'paid', paid_at = NOW(),
               payment_link_status = CASE WHEN payment_link_id IS NOT NULL THEN 'paid' ELSE payment_link_status END,
               updated_at = NOW()
           WHERE razorpay_order_id = $2
           RETURNING invoice_id, company_id`,
          [razorpay_payment_id, razorpay_order_id]
        ).catch(() => ({ rows: [] }));

        if (pgo?.invoice_id) {
          await pool.query(
            `UPDATE invoices SET status = 'paid', paid_amount = total_amount, updated_at = NOW()
             WHERE id = $1`,
            [pgo.invoice_id]
          ).catch(() => {});

          await pool.query(
            `INSERT INTO payment_transactions
               (invoice_id, company_id, amount, payment_mode, transaction_id, razorpay_payment_id, paid_at, status)
             VALUES ($1, $2, $3, 'razorpay', $4, $4, NOW(), 'captured')
             ON CONFLICT DO NOTHING`,
            [pgo.invoice_id, pgo.company_id, amount, razorpay_payment_id]
          ).catch(() => {});
        }
      } else if (event === 'payment.link.paid') {
        // Payment link without order — look up by payment_link_id
        const linkId = payload?.payment_link?.entity?.id;
        if (linkId) {
          const { rows: [pgo] } = await pool.query(
            `UPDATE payment_gateway_orders
             SET razorpay_payment_id = $1, status = 'paid', paid_at = NOW(),
                 payment_link_status = 'paid', updated_at = NOW()
             WHERE payment_link_id = $2
             RETURNING invoice_id, company_id`,
            [razorpay_payment_id, linkId]
          ).catch(() => ({ rows: [] }));

          if (pgo?.invoice_id) {
            await pool.query(
              `UPDATE invoices SET status = 'paid', paid_amount = total_amount, updated_at = NOW() WHERE id = $1`,
              [pgo.invoice_id]
            ).catch(() => {});
            await pool.query(
              `INSERT INTO payment_transactions
                 (invoice_id, company_id, amount, payment_mode, transaction_id, razorpay_payment_id, paid_at, status)
               VALUES ($1, $2, $3, 'razorpay_link', $4, $4, NOW(), 'captured')
               ON CONFLICT DO NOTHING`,
              [pgo.invoice_id, pgo.company_id, amount, razorpay_payment_id]
            ).catch(() => {});
          }
        }
      }
    } else if (event === 'payment.failed') {
      const orderId = payload?.payment?.entity?.order_id;
      if (orderId) {
        await pool.query(
          `UPDATE payment_gateway_orders SET status = 'failed', updated_at = NOW()
           WHERE razorpay_order_id = $1`,
          [orderId]
        ).catch(() => {});
      }
    } else if (event === 'payment.link.viewed') {
      const linkId = payload?.payment_link?.entity?.id;
      if (linkId) {
        await pool.query(
          `UPDATE payment_gateway_orders SET payment_link_status = 'viewed', updated_at = NOW()
           WHERE payment_link_id = $1 AND payment_link_status = 'sent'`,
          [linkId]
        ).catch(() => {});
      }
    } else if (event === 'refund.created') {
      const refund = payload?.refund?.entity || {};
      console.log(`[Webhook/Razorpay] refund.created amount=${refund.amount / 100} id=${refund.id}`);
    }

    // Always return 200 to prevent Razorpay retry storms
    res.json({ status: 'ok', event });
  } catch (e) {
    console.error('[Webhook/Razorpay]', e.message);
    res.json({ status: 'error', message: e.message });
  }
});

export default router;
