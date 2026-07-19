// backend/src/modules/integrations/whatsapp.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();


/* ── template builder ── */
function buildTemplate(template_name, params = []) {
  const components = [
    {
      type: 'body',
      parameters: params.map(p => ({ type: 'text', text: String(p) })),
    },
  ];

  const templates = {
    leave_approved:    { name: 'leave_approved',    language: { code: 'en' }, components },
    payslip_ready:     { name: 'payslip_ready',     language: { code: 'en' }, components },
    invoice_sent:      { name: 'invoice_sent',      language: { code: 'en' }, components },
    payment_received:  { name: 'payment_received',  language: { code: 'en' }, components },
    task_assigned:     { name: 'task_assigned',     language: { code: 'en' }, components },
  };

  return templates[template_name] || { name: template_name, language: { code: 'en' }, components };
}

/* ── POST /api/integrations/whatsapp/send ── */
router.post('/send', async (req, res) => {
  const { to, template_name, template_params = [] } = req.body;
  if (!to || !template_name) {
    return res.status(400).json({ success: false, message: 'to and template_name are required' });
  }

  const token   = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  if (!token || !phoneId) {
    // Log attempt even without config

    await pool.query(`INSERT INTO whatsapp_log (to_number,template_name,status,response_json) VALUES($1,$2,$3,$4)`,
      [to, template_name, 'skipped_no_config', JSON.stringify({ error: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_ID not set' })]).catch(() => {});
    return res.json({
      success: false,
      simulated: true,
      message: 'WhatsApp not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID env vars.',
      would_send: { to, template_name, template_params },
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: to.replace(/\D/g, ''),
    type: 'template',
    template: buildTemplate(template_name, template_params),
  };

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = await response.json();


    await pool.query(
      `INSERT INTO whatsapp_log (to_number,template_name,status,response_json) VALUES($1,$2,$3,$4)`,
      [to, template_name, response.ok ? 'sent' : 'failed', JSON.stringify(data)]
    ).catch(() => {});

    if (!response.ok) {
      return res.status(502).json({ success: false, message: 'WhatsApp API error', details: data });
    }
    return res.json({ success: true, message_id: data.messages?.[0]?.id, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ── POST /api/integrations/whatsapp/webhook ── */
router.post('/webhook', async (req, res) => {
  // Acknowledge webhook immediately
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const msgs = change.value?.messages || [];
        for (const msg of msgs) {
          const senderPhone = msg.from;
          const text = msg.text?.body?.toLowerCase() || '';

          // Look up employee by phone
          const { rows } = await pool.query(
            `SELECT id, name, department FROM employees WHERE phone = $1 OR mobile = $1 LIMIT 1`,
            [senderPhone]
          ).catch(() => ({ rows: [] }));
          const employee = rows[0];

          if (!employee) continue;

          // Route by message content
          if (text.startsWith('leave') || text.includes('apply leave')) {
            // Format: "leave sick 2026-04-01 2026-04-02 reason"
            const parts = text.split(' ');
            const leaveType = parts[1] || 'casual';
            await pool.query(
              `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, status, reason, created_at)
               VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 'pending', $3, NOW())`,
              [employee.id, leaveType, `Leave via WhatsApp from ${senderPhone}`]
            ).catch(() => {});
            console.log(`[WhatsApp] Leave request from ${employee.name} (${senderPhone})`);
          }

          if (text.startsWith('expense') || text.includes('claim')) {
            // Format: "expense 500 lunch"
            const parts = text.split(' ');
            const amount = parseFloat(parts[1]) || 0;
            const desc   = parts.slice(2).join(' ') || 'Expense via WhatsApp';
            console.log(`[WhatsApp] Expense ${amount} from ${employee.name}: ${desc}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp webhook]', err.message);
  }
});

/* ── GET /api/integrations/whatsapp/webhook (verification) ── */
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'pulse_erp_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

/* ── GET /api/integrations/whatsapp/status ── */
router.get('/status', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE) AS today,
           COUNT(*) AS total,
           MAX(sent_at) AS last_sent
    FROM whatsapp_log
  `).catch(() => ({ rows: [{ today: 0, total: 0, last_sent: null }] }));

  res.json({
    configured: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    token_set:    !!process.env.WHATSAPP_TOKEN,
    phone_id_set: !!process.env.WHATSAPP_PHONE_ID,
    messages_today: parseInt(rows[0]?.today || 0),
    messages_total: parseInt(rows[0]?.total || 0),
    last_sent:      rows[0]?.last_sent || null,
    supported_templates: ['leave_approved','payslip_ready','invoice_sent','payment_received','task_assigned'],
  });
});

export default router;
