import nodemailer from 'nodemailer';
import { buildPurchaseOrderPdf } from './purchaseOrderPdf.js';
import { resolveConfig } from '../modules/integrations/integrationConfig.js';

/**
 * Build a transporter for one tenant; null when SMTP is not configured.
 *
 * ── PULSE-01 remaining risk 3 ────────────────────────────────────────────────
 * This read `process.env.SMTP_*` directly. That was safe only by accident: the
 * integration config route used to EXPORT a tenant's SMTP credentials into
 * process.env, so whichever tenant saved last owned outbound mail for every
 * other tenant — payslips, invoices and offer letters included. Removing that
 * export closed the leak but left this function deployment-only, so a tenant's
 * own SMTP settings reached nothing.
 *
 * `companyId` is OPTIONAL and the default reproduces the previous behaviour
 * exactly, so all nine senders and their eleven callers keep working unchanged.
 * Pass it wherever a tenant is genuinely in hand; `resolveConfig` reads that
 * tenant's encrypted row and falls back to the deployment's env vars per field.
 *
 * ⚠ DO NOT pass a tenant for platform mail — password resets, and anything sent
 * before a session exists. Those must go out over the deployment's own server:
 * routing an account-recovery message through mail infrastructure that a tenant
 * administrator controls hands them the recovery channel. `sendPasswordResetOTP`
 * below is deliberately the one sender with no companyId parameter.
 */
async function createTransport(companyId = null) {
  const cfg = await resolveConfig(companyId, 'smtp');
  const host = cfg.SMTP_HOST;
  const port = parseInt(cfg.SMTP_PORT || '587', 10);
  const user = cfg.SMTP_USER;
  const pass = cfg.SMTP_PASS;
  const from = cfg.SMTP_FROM || user;

  if (!host || !user || !pass) return null;

  return {
    from,
    transport: nodemailer.createTransport({
      host,
      port,
      // SMTP_SECURE is an explicit tenant choice where it is set; port 465 is the
      // long-standing implicit default and stays the fallback.
      secure: cfg.SMTP_SECURE === 'ssl' || cfg.SMTP_SECURE === 'true' || port === 465,
      auth: { user, pass },
    }),
  };
}

/**
 * Is outbound mail configured for this tenant (or the deployment)?
 *
 * ⚠ ASYNC since PULSE-01 — it reads a row now. Every caller was updated; a
 * forgotten `await` returns a Promise, which is truthy, so a missed one would
 * make an unconfigured deployment look configured. `sourceParses` cannot catch
 * that, so the callers are listed in the PULSE-01 report.
 */
export async function isEmailConfigured(companyId = null) {
  const cfg = await resolveConfig(companyId, 'smtp');
  return !!(cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASS);
}

// Generic mirror of an in-app notification, used by notifications.repository.js
// when notification_rules says an event's channel includes 'email'. Unlike every
// other function in this file, it never throws in production — it's a
// fire-and-forget side effect of create(), same contract as the push mirror, and
// a delivery failure here must not affect the notification write.
export async function sendNotificationEmail(toEmail, { title, message, companyId = null }) {
  const mailer = await createTransport(companyId);
  if (!mailer) {
    console.log(`[mailer] SMTP not configured — notification email skipped for ${toEmail}: ${title}`);
    return { sent: false };
  }
  await mailer.transport.sendMail({
    from: mailer.from,
    to: toEmail,
    subject: title || 'Pulse ERP Notification',
    text: message || '',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
        <h2 style="color:#7c3aed;margin-bottom:4px">${title || 'Pulse ERP'}</h2>
        <p style="white-space:pre-wrap">${message || ''}</p>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">This is an automated message from Pulse ERP. Please do not reply.</p>
      </div>
    `,
  });
  return { sent: true };
}

export async function sendPayslipEmail(toEmail, { empName, month, year, periodLabel, gross, netPay, totalDeductions, companyId = null }) {
  const mailer = await createTransport(companyId);
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email service is not configured. Please contact your administrator.');
    }
    console.log(`[mailer] SMTP not configured — payslip email skipped for ${toEmail}`);
    return;
  }

  const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  await mailer.transport.sendMail({
    from:    mailer.from,
    to:      toEmail,
    subject: `Pulse ERP — Payslip for ${periodLabel}`,
    text: [
      `Dear ${empName},`,
      '',
      `Please find your payslip details for ${periodLabel} below.`,
      '',
      `  Gross Pay       : ${fmt(gross)}`,
      `  Total Deductions: ${fmt(totalDeductions)}`,
      `  Net Pay         : ${fmt(netPay)}`,
      '',
      'For the full breakdown, log in to Pulse ERP → Payroll → My Payslips.',
      '',
      'This is an automated message. Please do not reply.',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
        <h2 style="color:#7c3aed;margin-bottom:4px">Payslip — ${periodLabel}</h2>
        <p>Dear <strong>${empName}</strong>,</p>
        <p>Your payslip for <strong>${periodLabel}</strong> is ready.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#f5f3ff">
            <td style="padding:10px 14px;font-weight:600">Gross Pay</td>
            <td style="padding:10px 14px;text-align:right">${fmt(gross)}</td>
          </tr>
          <tr>
            <td style="padding:10px 14px">Total Deductions</td>
            <td style="padding:10px 14px;text-align:right">${fmt(totalDeductions)}</td>
          </tr>
          <tr style="background:#f0fdf4">
            <td style="padding:10px 14px;font-weight:700;color:#166534">Net Pay</td>
            <td style="padding:10px 14px;font-weight:700;color:#166534;text-align:right">${fmt(netPay)}</td>
          </tr>
        </table>
        <p style="color:#6b7280;font-size:13px">
          For the full breakdown, log in to
          <a href="#" style="color:#7c3aed">Pulse ERP → Payroll → My Payslips</a>.
        </p>
        <p style="color:#9ca3af;font-size:12px">This is an automated message. Please do not reply.</p>
      </div>
    `,
  });
}

// ── E-signature emails ──────────────────────────────────────────────────────

const APP_BASE = () =>
  (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

function esignShell(title, bodyHtml) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#7c3aed;margin-bottom:4px">${title}</h2>
      ${bodyHtml}
      <p style="color:#9ca3af;font-size:12px;margin-top:24px">
        Sent securely via Pulse ERP. This link is unique to you — please do not forward it.
      </p>
    </div>`;
}

/**
 * Invite a signer to sign a document via their unique public link.
 * Silently no-ops (dev) or throws (prod) when SMTP is unconfigured, matching
 * the rest of this module. Returns { sent: boolean, link } either way.
 */
export async function sendSigningInvite(toEmail, { signerName, documentTitle, token, message, expiryDate, companyId = null }) {
  const link   = `${APP_BASE()}/sign/${token}`;
  const mailer = await createTransport(companyId);
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email service is not configured. Please contact your administrator.');
    }
    console.log(`[mailer] SMTP not configured — signing link for ${toEmail}: ${link}`);
    return { sent: false, link };
  }

  await mailer.transport.sendMail({
    from: mailer.from,
    to: toEmail,
    subject: `Signature requested: ${documentTitle}`,
    text: [
      `Dear ${signerName || 'Signer'},`, '',
      `You have been requested to sign "${documentTitle}".`,
      message ? `\nMessage from sender: ${message}\n` : '',
      `Open your secure signing link:`, link, '',
      expiryDate ? `This request expires on ${expiryDate}.` : '',
      '', 'If you were not expecting this, you can ignore this email.',
    ].filter(Boolean).join('\n'),
    html: esignShell('Signature Requested', `
      <p>Dear <strong>${signerName || 'Signer'}</strong>,</p>
      <p>You have been requested to sign <strong>${documentTitle}</strong>.</p>
      ${message ? `<p style="background:#f5f3ff;padding:12px 16px;border-radius:8px;color:#4c1d95">${message}</p>` : ''}
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;display:inline-block">Review &amp; Sign</a>
      </p>
      ${expiryDate ? `<p style="color:#6b7280;font-size:13px">This request expires on <strong>${expiryDate}</strong>.</p>` : ''}
    `),
  });
  return { sent: true, link };
}

export async function sendSigningReminder(toEmail, { signerName, documentTitle, token, companyId = null }) {
  const link   = `${APP_BASE()}/sign/${token}`;
  const mailer = await createTransport(companyId);
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') throw new Error('Email service is not configured.');
    console.log(`[mailer] SMTP not configured — reminder link for ${toEmail}: ${link}`);
    return { sent: false, link };
  }
  await mailer.transport.sendMail({
    from: mailer.from, to: toEmail,
    subject: `Reminder: please sign "${documentTitle}"`,
    text: `Dear ${signerName || 'Signer'},\n\nThis is a reminder to sign "${documentTitle}".\n\n${link}\n`,
    html: esignShell('Reminder to Sign', `
      <p>Dear <strong>${signerName || 'Signer'}</strong>,</p>
      <p>This is a friendly reminder to sign <strong>${documentTitle}</strong>.</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;display:inline-block">Review &amp; Sign</a>
      </p>`),
  });
  return { sent: true, link };
}

export async function sendSignerOtp(toEmail, otp, { documentTitle, companyId = null } = {}) {
  const mailer = await createTransport(companyId);
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') throw new Error('Email service is not configured.');
    console.log(`[mailer] SMTP not configured — signing OTP for ${toEmail}: ${otp}`);
    return { sent: false };
  }
  await mailer.transport.sendMail({
    from: mailer.from, to: toEmail,
    subject: 'Your signing verification code',
    text: `Your verification code to sign ${documentTitle || 'the document'} is: ${otp}\n\nExpires in 10 minutes.`,
    html: esignShell('Verification Code', `
      <p>Use this code to verify your identity and sign ${documentTitle ? `<strong>${documentTitle}</strong>` : 'the document'}:</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#7c3aed;background:#f5f3ff;border-radius:8px;padding:16px 24px;text-align:center;margin:16px 0;font-family:monospace">${otp}</div>
      <p style="color:#6b7280;font-size:14px">This code expires in <strong>10 minutes</strong>.</p>`),
  });
  return { sent: true };
}

// ── Procurement ──────────────────────────────────────────────────────────────

// Automation Opportunity Audit §5.4 — approving a PO only ever notified the
// internal creator; the vendor learned about it by phone/email a human sent
// separately. Fire-and-forget like sendNotificationEmail() (never throws) —
// a delivery failure here must not undo a PO approval that already
// committed.
//
// The HTML summary below is what a person reads in their client. Since 2026-09-15
// it also carries the formal document as an ATTACHMENT (utils/purchaseOrderPdf.js)
// — the artefact a vendor files and quotes back in a dispute.
// ⚠ The attachment is best-effort BY DESIGN: if rendering fails the mail still
// goes, without it. Losing the PDF costs the vendor a nicety; losing the mail
// costs them the order. Note the PDF says `Rs.` where this body says `₹` — see
// that module's header, pdfkit's built-in fonts cannot encode U+20B9.
export async function sendPurchaseOrderToVendor(toEmail, { poNumber, vendorName, items, totalAmount, expectedDeliveryDate, termsConditions, companyId = null }) {
  const mailer = await createTransport(companyId);
  if (!mailer) {
    console.log(`[mailer] SMTP not configured — PO email skipped for ${toEmail}: ${poNumber}`);
    return { sent: false };
  }

  const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = (items || []).map((it) =>
    `  ${it.item_name || it.item_code || 'Item'} — Qty ${it.quantity} ${it.unit_of_measure || ''} @ ${fmt(it.rate)} = ${fmt(it.total_amount)}`
  ).join('\n');
  const htmlRows = (items || []).map((it) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${it.item_name || it.item_code || 'Item'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${it.quantity} ${it.unit_of_measure || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(it.rate)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(it.total_amount)}</td>
    </tr>`).join('');

  let attachments;
  try {
    const pdf = await buildPurchaseOrderPdf({
      poNumber, vendorName, items, totalAmount, expectedDeliveryDate, termsConditions,
    });
    attachments = [{
      filename: `PO_${String(poNumber || 'order').replace(/[^\w.-]+/g, '_')}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    }];
  } catch (err) {
    console.error(`[mailer] PO PDF render failed for ${poNumber}, sending without attachment:`, err.message);
  }

  await mailer.transport.sendMail({
    from: mailer.from,
    to: toEmail,
    ...(attachments ? { attachments } : {}),
    subject: `Purchase Order ${poNumber} — Approved`,
    text: [
      `Dear ${vendorName || 'Vendor'},`, '',
      `Purchase Order ${poNumber} has been approved and issued to you.`, '',
      rows, '',
      `Total: ${fmt(totalAmount)}`,
      expectedDeliveryDate ? `Expected delivery: ${expectedDeliveryDate}` : '',
      termsConditions ? `\nTerms: ${termsConditions}` : '',
      '', 'This is an automated message from Pulse ERP. Please do not reply.',
    ].filter(Boolean).join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
        <h2 style="color:#7c3aed;margin-bottom:4px">Purchase Order ${poNumber}</h2>
        <p>Dear <strong>${vendorName || 'Vendor'}</strong>,</p>
        <p>This Purchase Order has been approved and issued to you.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#f5f3ff">
            <td style="padding:8px 12px;font-weight:600">Item</td>
            <td style="padding:8px 12px;font-weight:600;text-align:right">Qty</td>
            <td style="padding:8px 12px;font-weight:600;text-align:right">Rate</td>
            <td style="padding:8px 12px;font-weight:600;text-align:right">Amount</td>
          </tr>
          ${htmlRows}
          <tr>
            <td colspan="3" style="padding:10px 12px;font-weight:700;text-align:right">Total</td>
            <td style="padding:10px 12px;font-weight:700;text-align:right">${fmt(totalAmount)}</td>
          </tr>
        </table>
        ${expectedDeliveryDate ? `<p>Expected delivery: <strong>${expectedDeliveryDate}</strong></p>` : ''}
        ${termsConditions ? `<p style="color:#6b7280;font-size:13px">Terms: ${termsConditions}</p>` : ''}
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">This is an automated message from Pulse ERP. Please do not reply.</p>
      </div>
    `,
  });
  return { sent: true };
}

// RFQ's "send to vendors" only ever wrote rfq_quotes rows and flipped the RFQ
// to 'sent' — no vendor ever actually received anything, same gap PO approval
// had before sendPurchaseOrderToVendor above. Same fire-and-forget/never-throw
// contract: a delivery failure must not undo an RFQ that already recorded
// which vendors it was sent to.
export async function sendRfqToVendor(toEmail, { rfqNumber, vendorName, items, requiredBy, companyId = null }) {
  const mailer = await createTransport(companyId);
  if (!mailer) {
    console.log(`[mailer] SMTP not configured — RFQ email skipped for ${toEmail}: ${rfqNumber}`);
    return { sent: false };
  }

  const rows = (items || []).map((it) =>
    `  ${it.item_name || 'Item'} — Qty ${it.quantity} ${it.unit || ''}${it.remarks ? ` (${it.remarks})` : ''}`
  ).join('\n');
  const htmlRows = (items || []).map((it) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${it.item_name || 'Item'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${it.quantity} ${it.unit || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${it.remarks || ''}</td>
    </tr>`).join('');

  await mailer.transport.sendMail({
    from: mailer.from,
    to: toEmail,
    subject: `Request for Quotation ${rfqNumber}`,
    text: [
      `Dear ${vendorName || 'Vendor'},`, '',
      `We would like to request your quotation for RFQ ${rfqNumber}.`, '',
      rows, '',
      requiredBy ? `Required by: ${requiredBy}` : '',
      '', 'Please respond with your best pricing and delivery terms.',
      '', 'This is an automated message from Pulse ERP. Please do not reply.',
    ].filter(Boolean).join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
        <h2 style="color:#7c3aed;margin-bottom:4px">Request for Quotation ${rfqNumber}</h2>
        <p>Dear <strong>${vendorName || 'Vendor'}</strong>,</p>
        <p>We would like to request your quotation for the items below.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#f5f3ff">
            <td style="padding:8px 12px;font-weight:600">Item</td>
            <td style="padding:8px 12px;font-weight:600;text-align:right">Qty</td>
            <td style="padding:8px 12px;font-weight:600">Remarks</td>
          </tr>
          ${htmlRows}
        </table>
        ${requiredBy ? `<p>Required by: <strong>${requiredBy}</strong></p>` : ''}
        <p>Please respond with your best pricing and delivery terms.</p>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">This is an automated message from Pulse ERP. Please do not reply.</p>
      </div>
    `,
  });
  return { sent: true };
}

export async function sendPasswordResetOTP(toEmail, otp) {
  // NO companyId, deliberately — see the note on createTransport(). Account
  // recovery must not travel over mail infrastructure a tenant admin controls.
  const mailer = await createTransport(null);

  if (!mailer) {
    // In production this is a hard error — the admin must configure SMTP.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Email service is not configured. Please contact your administrator.'
      );
    }
    // Dev: log and return without throwing so the flow still works
    console.log(`[mailer] SMTP not configured — OTP for ${toEmail}: ${otp}`);
    return;
  }

  await mailer.transport.sendMail({
    from:    mailer.from,
    to:      toEmail,
    subject: 'Pulse ERP — Password Reset Code',
    text:    [
      'Your Pulse ERP password reset code is:',
      '',
      `  ${otp}`,
      '',
      'This code expires in 10 minutes. Do not share it with anyone.',
      '',
      'If you did not request a password reset, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#7c3aed">Password Reset</h2>
        <p>Your Pulse ERP password reset code is:</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#7c3aed;
                    background:#f5f3ff;border-radius:8px;padding:16px 24px;
                    text-align:center;margin:16px 0;font-family:monospace">
          ${otp}
        </div>
        <p style="color:#6b7280;font-size:14px">
          This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
        </p>
        <p style="color:#9ca3af;font-size:12px">
          If you did not request this, you can safely ignore this email.
        </p>
      </div>
    `,
  });
}
