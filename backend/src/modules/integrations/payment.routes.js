// backend/src/modules/integrations/payment.routes.js
import express from 'express';
import crypto  from 'crypto';
import pool    from '../../config/db.js';

const router = express.Router();

const getCompanyId = (req) => req.scope?.company_id ?? null;

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/payments/config-status
   Returns gateway mode without exposing env var names.
───────────────────────────────────────────────────────────────────────────── */
router.get('/config-status', async (req, res) => {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return res.json({ configured: false, mode: 'unconfigured' });
  }
  const mode = keyId.startsWith('rzp_live_') ? 'live' : 'test';
  return res.json({ configured: true, mode });
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/payments/unpaid-invoices
   Lists unpaid invoices scoped to the caller's company.
───────────────────────────────────────────────────────────────────────────── */
router.get('/unpaid-invoices', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { rows } = await pool.query(`
      SELECT
        i.id,
        i.invoice_number,
        COALESCE(p.name, i.party_name, '') AS client_name,
        p.email                            AS client_email,
        i.total_amount,
        COALESCE(i.paid_amount, 0)         AS paid_amount,
        i.due_date,
        i.status,
        COALESCE(i.currency, 'INR')        AS currency,
        pgo.payment_link_url,
        pgo.payment_link_status,
        pgo.razorpay_order_id,
        pgo.id                             AS pgo_id,
        GREATEST(0,
          EXTRACT(day FROM CURRENT_DATE - i.due_date)::integer
        )                                  AS days_overdue
      FROM invoices i
      LEFT JOIN parties   p   ON p.id  = i.customer_id
      LEFT JOIN payment_gateway_orders pgo ON pgo.invoice_id = i.id
      WHERE ($1::int IS NULL OR i.company_id = $1)
        AND lower(i.status) IN ('sent', 'overdue', 'partial')
        AND i.deleted_at IS NULL
        AND i.total_amount > COALESCE(i.paid_amount, 0)
      ORDER BY i.due_date ASC NULLS LAST
    `, [companyId]);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/payments/kpis
   Returns the 4 KPI card values for the payment gateway dashboard.
───────────────────────────────────────────────────────────────────────────── */
router.get('/kpis', async (req, res) => {
  const companyId  = getCompanyId(req);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  try {
    const [outstandingRes, collectedRes, overdueRes, linksRes] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)), 0) AS total
        FROM invoices
        WHERE ($1::int IS NULL OR company_id = $1)
          AND lower(status) IN ('sent', 'overdue', 'partial')
          AND deleted_at IS NULL
      `, [companyId]),

      pool.query(`
        SELECT COALESCE(SUM(pt.amount), 0) AS total
        FROM payment_transactions pt
        WHERE ($1::int IS NULL OR pt.company_id = $1)
          AND pt.paid_at >= $2
      `, [companyId, monthStart]),

      pool.query(`
        SELECT COUNT(*) AS count
        FROM invoices
        WHERE ($1::int IS NULL OR company_id = $1)
          AND (lower(status) = 'overdue'
               OR (due_date < CURRENT_DATE AND lower(status) NOT IN ('paid','cancelled')))
          AND deleted_at IS NULL
      `, [companyId]),

      pool.query(`
        SELECT COUNT(*) AS count
        FROM payment_gateway_orders pgo
        JOIN invoices i ON i.id = pgo.invoice_id
        WHERE ($1::int IS NULL OR i.company_id = $1)
          AND pgo.link_sent = true
          AND pgo.created_at >= $2
      `, [companyId, monthStart]),
    ]);

    res.json({
      success: true,
      data: {
        total_outstanding:   parseFloat(outstandingRes.rows[0].total  || 0),
        collected_this_month: parseFloat(collectedRes.rows[0].total   || 0),
        overdue_count:        parseInt(overdueRes.rows[0].count        || 0),
        links_sent:           parseInt(linksRes.rows[0].count          || 0),
      },
    });
  } catch (err) {
    // Graceful degradation — zeros rather than page crash
    res.json({
      success: true,
      data: { total_outstanding: 0, collected_this_month: 0, overdue_count: 0, links_sent: 0 },
    });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/payments/create-order  (Razorpay checkout modal)
───────────────────────────────────────────────────────────────────────────── */
router.post('/create-order', async (req, res) => {
  const { amount, currency = 'INR', invoice_id, description = '' } = req.body;
  if (!amount) return res.status(400).json({ success: false, message: 'amount is required' });

  const companyId = getCompanyId(req);
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        success: false,
        error:   'payment_gateway_not_configured',
        message: 'Payment gateway is in test mode. Contact your administrator to enable live payments.',
      });
    }
    // Dev: return a clearly labelled simulation
    const simId = `order_sim_${Date.now()}`;
    await pool.query(
      `INSERT INTO payment_gateway_orders
         (invoice_id, company_id, razorpay_order_id, amount, currency, status, description)
       VALUES ($1, $2, $3, $4, $5, 'simulated', $6)
       ON CONFLICT DO NOTHING`,
      [invoice_id || null, companyId, simId, amount, currency, description]
    ).catch(() => {});
    return res.json({
      success:   true,
      simulated: true,
      order_id:  simId,
      amount:    Math.round(parseFloat(amount) * 100),
      currency,
      key_id:    'rzp_test_sim_key',
    });
  }

  try {
    const Razorpay = (await import('razorpay')).default;
    const rzp   = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await rzp.orders.create({
      amount:  Math.round(parseFloat(amount) * 100),
      currency,
      receipt: `INV-${invoice_id || Date.now()}`,
      notes:   { invoice_id: String(invoice_id || ''), description },
    });

    await pool.query(
      `INSERT INTO payment_gateway_orders
         (invoice_id, company_id, razorpay_order_id, amount, currency, status, description, gateway_response)
       VALUES ($1, $2, $3, $4, $5, 'created', $6, $7)`,
      [invoice_id || null, companyId, order.id, amount, currency, description, JSON.stringify(order)]
    ).catch(() => {});

    res.json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency, key_id: keyId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/payments/create-link  (Razorpay Payment Link — send to client)
───────────────────────────────────────────────────────────────────────────── */
router.post('/create-link', async (req, res) => {
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ success: false, message: 'invoice_id is required' });

  const companyId = getCompanyId(req);
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  try {
    // Fetch invoice details
    const { rows: [inv] } = await pool.query(`
      SELECT i.id, i.invoice_number, i.total_amount, i.paid_amount,
             COALESCE(p.name, i.party_name, '') AS client_name,
             p.email AS client_email,
             COALESCE(i.currency, 'INR') AS currency
      FROM invoices i
      LEFT JOIN parties p ON p.id = i.customer_id
      WHERE i.id = $1
        AND ($2::int IS NULL OR i.company_id = $2)
    `, [invoice_id, companyId]);

    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const amountDue = parseFloat(inv.total_amount) - parseFloat(inv.paid_amount || 0);

    if (!keyId || !keySecret) {
      // Dev simulation
      const fakeUrl = `https://rzp.io/l/sim_${inv.invoice_number}_${Date.now()}`;
      await pool.query(`
        INSERT INTO payment_gateway_orders
          (invoice_id, company_id, payment_link_url, payment_link_status, amount, currency, status, link_sent, link_sent_at)
        VALUES ($1, $2, $3, 'sent', $4, $5, 'simulated', true, NOW())
        ON CONFLICT (invoice_id) DO UPDATE
          SET payment_link_url = EXCLUDED.payment_link_url,
              payment_link_status = 'sent',
              link_sent = true,
              link_sent_at = NOW(),
              updated_at = NOW()
      `, [invoice_id, companyId, fakeUrl, amountDue, inv.currency]).catch(() => {});
      return res.json({ success: true, simulated: true, url: fakeUrl });
    }

    const Razorpay = (await import('razorpay')).default;
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const linkPayload = {
      amount:      Math.round(amountDue * 100),
      currency:    inv.currency,
      description: `Payment for Invoice ${inv.invoice_number}`,
      reference_id: inv.invoice_number,
      reminder_enable: true,
      notes: { invoice_id: String(invoice_id) },
    };
    if (inv.client_email) {
      linkPayload.customer = { email: inv.client_email, name: inv.client_name };
      linkPayload.notify   = { email: true };
    }

    const link = await rzp.paymentLink.create(linkPayload);

    await pool.query(`
      INSERT INTO payment_gateway_orders
        (invoice_id, company_id, payment_link_id, payment_link_url, payment_link_status,
         amount, currency, status, link_sent, link_sent_at, gateway_response)
      VALUES ($1, $2, $3, $4, 'sent', $5, $6, 'link_created', true, NOW(), $7)
      ON CONFLICT (invoice_id) DO UPDATE
        SET payment_link_id     = EXCLUDED.payment_link_id,
            payment_link_url    = EXCLUDED.payment_link_url,
            payment_link_status = 'sent',
            link_sent           = true,
            link_sent_at        = NOW(),
            gateway_response    = EXCLUDED.gateway_response,
            updated_at          = NOW()
    `, [invoice_id, companyId, link.id, link.short_url, amountDue, inv.currency, JSON.stringify(link)]).catch(() => {});

    res.json({ success: true, url: link.short_url, link_id: link.id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/payments/verify  (HMAC signature verification after checkout)
───────────────────────────────────────────────────────────────────────────── */
router.post('/verify', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: 'order_id, payment_id, and signature are required' });
  }

  const companyId = getCompanyId(req);
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keySecret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, error: 'payment_gateway_not_configured' });
    }
    // Dev: allow simulated payments
    return res.json({ success: true, payment_id: razorpay_payment_id, simulated: true });
  }

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
  }

  try {
    const { rows: [pgo] } = await pool.query(
      `UPDATE payment_gateway_orders
       SET razorpay_payment_id = $1, status = 'paid', paid_at = NOW(),
           gateway_response = COALESCE(gateway_response, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE razorpay_order_id = $3
       RETURNING invoice_id, company_id, amount`,
      [razorpay_payment_id, JSON.stringify({ payment_id: razorpay_payment_id }), razorpay_order_id]
    ).catch(() => ({ rows: [] }));

    if (pgo?.invoice_id) {
      const cid = pgo.company_id ?? companyId;

      await pool.query(
        `UPDATE invoices SET status = 'Paid', paid_amount = total_amount, updated_at = NOW()
         WHERE id = $1`,
        [pgo.invoice_id]
      ).catch(() => {});

      await pool.query(
        `INSERT INTO payment_transactions
           (invoice_id, company_id, amount, payment_mode, transaction_id, razorpay_payment_id, paid_at, status)
         VALUES ($1, $2, $3, 'razorpay', $4, $4, NOW(), 'captured')`,
        [pgo.invoice_id, cid, pgo.amount, razorpay_payment_id]
      ).catch(() => {});
    }

    res.json({ success: true, payment_id: razorpay_payment_id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   PATCH /api/payments/mark-paid  (manual cash/cheque override)
───────────────────────────────────────────────────────────────────────────── */
router.patch('/mark-paid', async (req, res) => {
  const { invoice_id, payment_mode = 'cash', reference_number = '', paid_date } = req.body;
  if (!invoice_id) return res.status(400).json({ success: false, message: 'invoice_id is required' });

  const companyId = getCompanyId(req);

  try {
    const { rows: [inv] } = await pool.query(
      `SELECT id, total_amount, paid_amount, company_id FROM invoices WHERE id = $1`,
      [invoice_id]
    );
    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const amount = parseFloat(inv.total_amount) - parseFloat(inv.paid_amount || 0);
    const paidAt = paid_date ? new Date(paid_date).toISOString() : new Date().toISOString();

    await pool.query(
      `UPDATE invoices SET status = 'Paid', paid_amount = total_amount, updated_at = NOW() WHERE id = $1`,
      [invoice_id]
    );

    await pool.query(
      `INSERT INTO payment_transactions
         (invoice_id, company_id, amount, payment_mode, transaction_id, paid_at, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'captured', $7)`,
      [invoice_id, companyId, amount, payment_mode, reference_number || null, paidAt, `Manual: ${payment_mode}`]
    ).catch(() => {});

    res.json({ success: true, message: 'Invoice marked as paid' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/payments/history
   Payment transaction history scoped to company, with optional date range.
───────────────────────────────────────────────────────────────────────────── */
router.get('/history', async (req, res) => {
  const companyId = getCompanyId(req);
  const { from, to } = req.query;

  // Default: current month
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const fromDate   = from || monthStart;
  const toDate     = to   || new Date().toISOString();

  try {
    const { rows } = await pool.query(`
      SELECT
        i.invoice_number,
        COALESCE(p.name, i.party_name, '') AS party_name,
        pt.amount,
        pt.payment_mode,
        pt.transaction_id,
        pt.razorpay_payment_id,
        pt.paid_at,
        pt.status
      FROM payment_transactions pt
      JOIN invoices i ON i.id  = pt.invoice_id
      LEFT JOIN parties p ON p.id = i.customer_id
      WHERE ($1::int IS NULL OR pt.company_id = $1)
        AND pt.paid_at >= $2
        AND pt.paid_at <= $3
      ORDER BY pt.paid_at DESC
      LIMIT 200
    `, [companyId, fromDate, toDate]);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
