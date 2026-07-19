import pool from '../config/db.js';
import nodemailer from 'nodemailer';

// Looks up an email template by trigger event, substitutes variables, and sends.
// Fails silently — never throws — so callers can fire-and-forget.
export async function triggerEmail(triggerEvent, recipientData, companyId) {
  try {
    // Support both column name variants across migrations
    const tmpl = await pool.query(
      `SELECT * FROM email_templates
       WHERE (stage_trigger = $1 OR category = $1)
         AND is_active = true
       LIMIT 1`,
      [triggerEvent]
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
