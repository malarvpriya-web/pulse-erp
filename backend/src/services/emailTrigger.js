import pool from '../config/db.js';
import nodemailer from 'nodemailer';

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
    if (!tmpl.rows.length) return;

    const template = tmpl.rows[0];
    let subject = template.subject || '';
    let body    = template.body_html || template.body || '';

    for (const [key, value] of Object.entries(recipientData)) {
      const rx = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      subject = subject.replace(rx, value ?? '');
      body    = body.replace(rx, value ?? '');
    }

    const to = recipientData.candidate_email || recipientData.email;
    if (!to) return;
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: `Manifest Technologies <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject,
      html: body,
    });
  } catch {
    // Non-fatal — email failure must never break the main request
  }
}
