import nodemailer from 'nodemailer';

// Build a transporter from env vars; returns null if SMTP is not configured.
function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass) return null;

  return {
    from,
    transport: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    }),
  };
}

// Returns the configured transporter or null if SMTP env vars are absent.
export function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendPayslipEmail(toEmail, { empName, month, year, periodLabel, gross, netPay, totalDeductions }) {
  const mailer = createTransport();
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
export async function sendSigningInvite(toEmail, { signerName, documentTitle, token, message, expiryDate }) {
  const link   = `${APP_BASE()}/sign/${token}`;
  const mailer = createTransport();
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

export async function sendSigningReminder(toEmail, { signerName, documentTitle, token }) {
  const link   = `${APP_BASE()}/sign/${token}`;
  const mailer = createTransport();
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

export async function sendSignerOtp(toEmail, otp, { documentTitle } = {}) {
  const mailer = createTransport();
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

export async function sendPasswordResetOTP(toEmail, otp) {
  const mailer = createTransport();

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
