/**
 * sms.js — provider-agnostic SMS sender.
 *
 * Configured via env (no SDK dependency — uses fetch):
 *   SMS_PROVIDER = twilio | msg91 | generic   (unset ⇒ disabled)
 *
 *   twilio:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *   msg91:   MSG91_AUTHKEY, MSG91_SENDER  (optional MSG91_ROUTE, default 4)
 *   generic: SMS_WEBHOOK_URL  (POST { to, body }; optional SMS_WEBHOOK_AUTH header)
 *
 * Mirrors mailer.js semantics: throws in production when unconfigured, logs and
 * no-ops in dev. Returns { sent: boolean }.
 */

export function isSmsConfigured() {
  const p = (process.env.SMS_PROVIDER || '').toLowerCase();
  if (p === 'twilio')  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  if (p === 'msg91')   return !!process.env.MSG91_AUTHKEY;
  if (p === 'generic') return !!process.env.SMS_WEBHOOK_URL;
  return false;
}

function normalize(to) {
  return String(to || '').replace(/[^\d+]/g, '');
}

export async function sendSms(to, body) {
  const provider = (process.env.SMS_PROVIDER || '').toLowerCase();
  const num = normalize(to);

  if (!isSmsConfigured() || !num) {
    if (process.env.NODE_ENV === 'production' && !num) {
      throw new Error('No phone number on file for SMS delivery.');
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMS service is not configured. Please contact your administrator.');
    }
    console.log(`[sms] not configured — would send to ${num || '(no number)'}: ${body}`);
    return { sent: false };
  }

  try {
    if (provider === 'twilio') {
      const sid  = process.env.TWILIO_ACCOUNT_SID;
      const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const params = new URLSearchParams({ To: num, From: process.env.TWILIO_FROM, Body: body });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return { sent: true };
    }

    if (provider === 'msg91') {
      const params = new URLSearchParams({
        authkey: process.env.MSG91_AUTHKEY,
        mobiles: num.replace('+', ''),
        message: body,
        sender:  process.env.MSG91_SENDER || 'PULSE',
        route:   process.env.MSG91_ROUTE || '4',
        country: process.env.MSG91_COUNTRY || '91',
      });
      const r = await fetch(`https://api.msg91.com/api/sendhttp.php?${params.toString()}`);
      if (!r.ok) throw new Error(`MSG91 ${r.status}`);
      return { sent: true };
    }

    // generic HTTP webhook
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SMS_WEBHOOK_AUTH) headers.Authorization = process.env.SMS_WEBHOOK_AUTH;
    const r = await fetch(process.env.SMS_WEBHOOK_URL, {
      method: 'POST', headers, body: JSON.stringify({ to: num, body }),
    });
    if (!r.ok) throw new Error(`SMS webhook ${r.status}`);
    return { sent: true };
  } catch (e) {
    console.error('[sms] send failed:', e.message);
    if (process.env.NODE_ENV === 'production') throw e;
    return { sent: false };
  }
}
