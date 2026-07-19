// backend/src/routes/webhooks.routes.js
// Public webhook endpoints — mounted BEFORE verifyToken in server.js (no JWT auth)
import { Router } from 'express';
import crypto from 'crypto';
import pool from '../modules/shared/db.js';

const router = Router();

// ── POST /webhooks/zoho-sign ──────────────────────────────────────────────────
// Receives status events from Zoho Sign and updates document_signings table.
// Configure in Zoho Sign dashboard: Settings → Notifications → Webhook URL
// Set URL to: https://yourapp.com/api/webhooks/zoho-sign
//
// Optional: set ZOHO_SIGN_WEBHOOK_SECRET env var to the "Notification Secret"
// from Zoho Sign — enables HMAC-SHA256 signature verification.
router.post('/zoho-sign', async (req, res) => {
  try {
    const secret = process.env.ZOHO_SIGN_WEBHOOK_SECRET;
    if (secret) {
      const incomingSig = req.headers['x-zoho-sign-hmac'] || req.headers['x-zs-webhook-token'] || '';
      if (incomingSig) {
        const computed = crypto
          .createHmac('sha256', secret)
          .update(JSON.stringify(req.body))
          .digest('hex');
        if (incomingSig !== computed) {
          console.warn('[Webhook/ZohoSign] Signature mismatch — rejected');
          return res.status(401).json({ error: 'Invalid webhook signature' });
        }
      }
    }

    const { requests: zsReq, notifications } = req.body || {};
    const requestId   = zsReq?.request_id;
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
router.post('/razorpay', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Verify HMAC signature when secret is configured
    if (webhookSecret) {
      const signature = req.headers['x-razorpay-signature'] || '';
      const rawBody   = req.rawBody || JSON.stringify(req.body);
      const expected  = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');
      if (signature !== expected) {
        console.warn('[Webhook/Razorpay] Signature mismatch — rejected');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

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
            `UPDATE invoices SET status = 'Paid', paid_amount = total_amount, updated_at = NOW()
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
              `UPDATE invoices SET status = 'Paid', paid_amount = total_amount, updated_at = NOW() WHERE id = $1`,
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
