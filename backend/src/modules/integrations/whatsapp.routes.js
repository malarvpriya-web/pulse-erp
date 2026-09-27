// backend/src/modules/integrations/whatsapp.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';
import { resolveConfig } from './integrationConfig.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

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

// Automation Opportunity Audit §29.2 — this was a fully built, real send
// implementation with zero business-flow callers, all of it inlined in the
// route handler below. Extracted so a cron can call the same logic directly
// (fetch + whatsapp_log write included) instead of firing an HTTP request at
// its own server. Route handler is now a thin wrapper preserving the exact
// prior response shapes/status codes.
/**
 * @param {object} args
 * @param {number|null} [args.companyId]  the tenant whose WhatsApp account sends
 *   this message. Resolved through resolveConfig(), which reads that tenant's
 *   encrypted `company_integrations` row and falls back to the deployment's env
 *   vars for fields it has not set.
 *
 *   ⚠ Before PULSE-01 this read process.env directly, and the config route wrote
 *   a tenant's token INTO process.env — so whichever tenant saved last owned
 *   every other tenant's outbound WhatsApp. Pass the caller's company.
 *   Omitting it means "no tenant context" (a deployment-level send) and uses the
 *   env fallback alone; it never silently borrows another tenant's credentials.
 */
export async function sendWhatsAppMessage({ to, template_name, template_params = [], companyId = null }) {
  const cfg     = await resolveConfig(companyId, 'whatsapp');
  const token   = cfg.WHATSAPP_TOKEN;
  const phoneId = cfg.WHATSAPP_PHONE_ID;

  if (!token || !phoneId) {
    await pool.query(`INSERT INTO whatsapp_log (to_number,template_name,status,response_json) VALUES($1,$2,$3,$4)`,
      [to, template_name, 'skipped_no_config', JSON.stringify({ error: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_ID not set' })]).catch(() => {});
    return {
      success: false,
      simulated: true,
      message: 'WhatsApp not configured. Set the token and phone number ID under Integrations, or as WHATSAPP_TOKEN / WHATSAPP_PHONE_ID for the whole deployment.',
      would_send: { to, template_name, template_params },
    };
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
      return { success: false, message: 'WhatsApp API error', details: data, status: 502 };
    }
    return { success: true, message_id: data.messages?.[0]?.id, data };
  } catch (err) {
    return { success: false, message: err.message, status: 500 };
  }
}

/* ── POST /api/integrations/whatsapp/send ── */
router.post('/send', async (req, res) => {
  const { to, template_name, template_params = [] } = req.body;
  if (!to || !template_name) {
    return res.status(400).json({ success: false, message: 'to and template_name are required' });
  }

  const result = await sendWhatsAppMessage({ to, template_name, template_params, companyId: companyOf(req) });
  return res.status(result.status || 200).json(result);
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

          // Look up employee by phone.
          // `mobile` does not exist on employees (the columns are `phone` and
          // `company_phone`), so this threw 42703 on every inbound message. The
          // .catch() swallowed it, `employee` was always undefined, and the loop
          // below always hit `continue` — every WhatsApp message this webhook has
          // ever received was silently discarded. Log the failure rather than
          // treating "query blew up" and "nobody has that number" as the same thing.
          const { rows } = await pool.query(
            `SELECT id, name, department, company_id FROM employees
              WHERE (phone = $1 OR company_phone = $1) AND deleted_at IS NULL
              LIMIT 1`,
            [senderPhone]
          ).catch((e) => { console.error('[WhatsApp] employee lookup failed:', e.message); return { rows: [] }; });
          const employee = rows[0];

          if (!employee) continue;

          // Route by message content
          if (text.startsWith('leave') || text.includes('apply leave')) {
            // Format: "leave sick 2026-04-01 2026-04-02 reason"
            const parts = text.split(' ');
            const leaveType = parts[1] || 'casual';
            // This was the ONLY writer of leave_requests, and it wrote there while
            // the apply-for-leave path wrote leave_applications — so a leave filed
            // over WhatsApp landed in a table no approval screen reads, and simply
            // never surfaced. Write to the ledger, resolving the free-text type to
            // the leave_types FK the ledger uses; company_id comes from the
            // employee so the row is visible to company-scoped dashboards.
            const { rows: lt } = await pool.query(
              `SELECT id FROM leave_types
                WHERE LOWER(leave_name) LIKE $1 OR LOWER(leave_code) LIKE $1
                ORDER BY id LIMIT 1`,
              [`${leaveType}%`]
            ).catch(() => ({ rows: [] }));
            if (!lt[0]) {
              console.warn(`[WhatsApp] unknown leave type "${leaveType}" from ${senderPhone} — not filed`);
            } else {
              await pool.query(
                `INSERT INTO leave_applications
                   (employee_id, leave_type_id, start_date, end_date, number_of_days,
                    reason, status, manager_status, hr_status, company_id, created_at)
                 VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 1,
                    $3, 'pending', 'pending', 'pending', $4, NOW())`,
                [employee.id, lt[0].id, `Leave via WhatsApp from ${senderPhone}`, employee.company_id ?? null]
              ).catch((e) => console.error('[WhatsApp] leave insert failed:', e.message));
              console.log(`[WhatsApp] Leave request from ${employee.name} (${senderPhone})`);
            }
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
  // Deployment-level on purpose. Meta calls this endpoint unauthenticated, so
  // there is no tenant to resolve a per-tenant token against — the webhook URL
  // itself is one per deployment. Left on env deliberately, not an oversight.
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'pulse_erp_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

/* ── GET /api/integrations/whatsapp/status ── */
// ⚠ GATED AT settings:view, NOT LEFT OPEN. Found while reviewing the PULSE-01 gate:
// `IntegrationsHub.jsx` catches a 403 from `/integrations/config/all` and FALLS BACK
// to these per-provider status endpoints, so leaving them open routed straight around
// the gate — any authenticated employee could still enumerate which providers a tenant
// uses, and read the SMTP host and port and the SendGrid account email. That is the
// same reconnaissance the config read was gated for.
//
// `settings:view` (admin, super_admin, finance_manager, hr_manager) is the bar because
// these return non-secret operational status rather than credentials, and those are the
// roles that legitimately reach the integration pages.
router.get('/status', requirePermission('settings', 'view'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE) AS today,
           COUNT(*) AS total,
           MAX(sent_at) AS last_sent
    FROM whatsapp_log
  `).catch(() => ({ rows: [{ today: 0, total: 0, last_sent: null }] }));

  // Per-tenant, not process-wide: this endpoint used to report the environment,
  // which after a config save was whichever tenant wrote last (PULSE-01).
  const cfg = await resolveConfig(companyOf(req), 'whatsapp');

  res.json({
    configured: !!(cfg.WHATSAPP_TOKEN && cfg.WHATSAPP_PHONE_ID),
    token_set:    !!cfg.WHATSAPP_TOKEN,
    phone_id_set: !!cfg.WHATSAPP_PHONE_ID,
    messages_today: parseInt(rows[0]?.today || 0),
    messages_total: parseInt(rows[0]?.total || 0),
    last_sent:      rows[0]?.last_sent || null,
    supported_templates: ['leave_approved','payslip_ready','invoice_sent','payment_received','task_assigned'],
  });
});

export default router;
