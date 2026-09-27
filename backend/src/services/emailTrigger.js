import pool from '../config/db.js';
import nodemailer from 'nodemailer';
import { resolveConfig } from '../modules/integrations/integrationConfig.js';

// One line per distinct problem per process, not one per send. These conditions
// are configuration-shaped — a missing template stays missing for every
// candidate — so logging each occurrence would bury the signal it exists to
// raise.
const _warned = new Set();
function warnOnce(key, payload) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'WARN', ...payload }));
}

// Looks up an email template by trigger event, substitutes variables, and sends.
// Fails silently — never throws — so callers can fire-and-forget.
export async function triggerEmail(triggerEvent, recipientData, companyId) {
  try {
    // Support both column name variants across migrations. `companyId` was
    // accepted here but never actually used in the query — with
    // company_id/module now real columns on email_templates (migration
    // 20260812000001), a company-scoped template could otherwise lose to an
    // arbitrary other tenant's row matching the same trigger under LIMIT 1.
    // Prefers this company's own template, falls back to an unscoped/legacy
    // one (company_id IS NULL) if it hasn't configured its own.
    const tmpl = await pool.query(
      `SELECT * FROM email_templates
       WHERE (stage_trigger = $1 OR category = $1)
         AND is_active = true
         AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
       ORDER BY company_id NULLS LAST
       LIMIT 1`,
      [triggerEvent, companyId ?? null]
    );
    if (!tmpl.rows.length) {
      // Silence here is what made three of the four recruitment triggers
      // undetectably dead: the code fired offer_sent / interview_rejected /
      // hired_welcome, no template row existed, and the function returned as if
      // it had sent. Every abandoned path now says so exactly once per event, so
      // a missing template shows up in the log instead of being discovered by a
      // candidate who never heard back.
      warnOnce(`no_template:${triggerEvent}`, {
        event: 'email_not_sent', reason: 'no_active_template',
        trigger: triggerEvent, companyId: companyId ?? null,
        message: `No active email template for trigger "${triggerEvent}" — nothing was sent. Create one in Recruitment → Email Templates.`,
      });
      return;
    }

    const template = tmpl.rows[0];
    let subject = template.subject || '';
    let body    = template.body_html || template.body || '';

    for (const [key, value] of Object.entries(recipientData)) {
      const rx = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      subject = subject.replace(rx, value ?? '');
      body    = body.replace(rx, value ?? '');
    }

    const to = recipientData.candidate_email || recipientData.email;
    if (!to) {
      warnOnce(`no_recipient:${triggerEvent}`, {
        event: 'email_not_sent', reason: 'no_recipient_address', trigger: triggerEvent,
        message: `Trigger "${triggerEvent}" fired with no candidate_email/email in its payload — nothing was sent.`,
      });
      return;
    }
    // PULSE-01 remaining risk 3. This read process.env.SMTP_* directly, which the
    // old integration config route populated from whichever tenant saved last — so
    // one tenant's mail server sent every tenant's offer letters and rejections.
    // `companyId` is already a parameter of this function; resolveConfig reads that
    // tenant's encrypted row and falls back to the deployment's env per field.
    const smtp = await resolveConfig(companyId ?? null, 'smtp');
    if (!smtp.SMTP_HOST || !smtp.SMTP_USER) {
      warnOnce('no_smtp', {
        event: 'email_not_sent', reason: 'smtp_not_configured', trigger: triggerEvent,
        companyId: companyId ?? null,
        message: 'No SMTP host/user for this company or the deployment — NO outbound email is being sent, including offer letters and candidate rejections. Set it under Integrations, or SMTP_HOST/SMTP_USER for the whole deployment.',
      });
      return;
    }

    const smtpPort = parseInt(smtp.SMTP_PORT || '587', 10);
    const transporter = nodemailer.createTransport({
      host: smtp.SMTP_HOST,
      port: smtpPort,
      secure: smtp.SMTP_SECURE === 'ssl' || smtp.SMTP_SECURE === 'true' || smtpPort === 465,
      auth: { user: smtp.SMTP_USER, pass: smtp.SMTP_PASS },
    });

    await transporter.sendMail({
      from: `Manifest Technologies <${smtp.SMTP_FROM || smtp.SMTP_USER}>`,
      to,
      subject,
      html: body,
    });
  } catch (err) {
    // Still non-fatal — an email failure must never break the main request —
    // but no longer invisible. A swallowed exception here meant a bounced or
    // rejected send looked identical to a successful one.
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN',
      event: 'email_send_failed', trigger: triggerEvent,
      companyId: companyId ?? null, message: err?.message || String(err),
    }));
  }
}
