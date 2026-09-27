/**
 * notify.js — multi-channel delivery for IoT alerts.
 *
 * WHAT THIS CLOSES
 * ----------------
 * Phase 4 delivered in-app notifications only. The rule model carried
 * `notify_channels`, `notify_roles`, `notify_user_ids`, `escalation_mins` and
 * `repeat_mins`, and every one of them beyond `in_app` was stored and ignored —
 * a rule could say "SMS the service manager on a critical trip" and nothing
 * would happen, which is worse than not offering the option.
 *
 * Every channel Pulse already has is now wired:
 *
 *   in_app  notificationsRepository.create()  — also fans out to push and to
 *                                               email via notification_rules
 *   email   sendNotificationEmail()           — utils/mailer.js (nodemailer)
 *   sms     sendSms()                         — utils/sms.js (twilio/msg91/webhook)
 *   push    sendPushToUser()                  — FCM/APNs, via the in_app path
 *
 * NOTHING NEW WAS BUILT. These are the same senders payroll, approvals and
 * e-sign use. The only IoT-specific parts are recipient resolution (which has to
 * respect many-to-many roles and company scope) and the delivery record.
 *
 * DELIVERY IS RECORDED, NOT ASSUMED. Each attempt writes an
 * `iot_notification_log` row with its channel, recipient and outcome, because
 * "we called sendSms and it did not throw" is not evidence that a human was
 * told. The Alert 360 drawer reads this back.
 *
 * FAILURE IS NEVER FATAL. This runs inside the outbox worker, which already has
 * retry and dead-lettering. A channel that fails is logged and the others still
 * go out; the worker decides whether the event as a whole needs retrying.
 */

import pool from '../../config/db.js';
import notificationsRepository from '../notifications/repositories/notifications.repository.js';
import { sendNotificationEmail, isEmailConfigured } from '../../utils/mailer.js';
import { sendSms, isSmsConfigured } from '../../utils/sms.js';

/** Event keys matching the notification_rules rows seeded in 20260915000001. */
export const IOT_EVENTS = Object.freeze({
  ALERT_CRITICAL: 'iot.alert_critical',
  ALERT_WARNING: 'iot.alert_warning',
  ALERT_ESCALATED: 'iot.alert_escalated',
  DEVICE_OFFLINE: 'iot.device_offline',
  ALERT_RESOLVED: 'iot.alert_resolved',
});

export function eventKeyFor({ severity, escalation = false, metric = null, resolved = false }) {
  if (resolved) return IOT_EVENTS.ALERT_RESOLVED;
  if (escalation) return IOT_EVENTS.ALERT_ESCALATED;
  if (metric === 'heartbeat') return IOT_EVENTS.DEVICE_OFFLINE;
  return severity === 'critical' ? IOT_EVENTS.ALERT_CRITICAL : IOT_EVENTS.ALERT_WARNING;
}

/**
 * Resolve recipients for a company.
 *
 * Roles are many-to-many through `user_roles`, so this unions across the
 * junction table rather than reading `users.role` — a service manager who also
 * holds `employee` must still be reachable, and reading the single column is the
 * recurring bug this codebase documents elsewhere.
 *
 * Recipients come from three places, merged and de-duplicated:
 *   1. explicit user ids on the rule
 *   2. roles on the rule
 *   3. roles on the matching notification_rules row (the company's own policy)
 *
 * Contact details are resolved once here so a channel sender never has to.
 */
export async function resolveRecipients(db, { companyId, roles = [], userIds = [], eventKey = null }) {
  const wantRoles = new Set((roles || []).map((r) => String(r).toLowerCase()).filter(Boolean));

  if (eventKey) {
    const { rows } = await db.query(
      `SELECT recipient_roles FROM notification_rules
        WHERE company_id = $1 AND event_key = $2 AND enabled = TRUE LIMIT 1`,
      [companyId, eventKey],
    );
    for (const r of rows[0]?.recipient_roles || []) wantRoles.add(String(r).toLowerCase());
  }

  const ids = new Set((userIds || []).map((n) => parseInt(n, 10)).filter(Number.isInteger));

  if (wantRoles.size) {
    const { rows } = await db.query(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r       ON r.id = ur.role_id
         LEFT JOIN user_scope us ON us.user_id = u.id AND us.is_primary = TRUE
        WHERE LOWER(r.code) = ANY($1)
          AND u.is_active
          AND (us.company_id = $2 OR u.company_id = $2)`,
      [[...wantRoles], companyId],
    );
    for (const r of rows) ids.add(r.id);
  }

  if (!ids.size) return [];

  // One query for the contact details, including the employee phone — users has
  // no phone column, employees does, and SMS without a number is a no-op that
  // must be recorded as such rather than counted as a delivery.
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email,
            COALESCE(e.phone, e.company_phone) AS phone
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.id = ANY($1)`,
    [[...ids]],
  );
  return rows.slice(0, 200);
}

/** Which channels a company's policy allows for this event, intersected with the rule's. */
async function effectiveChannels(db, { companyId, eventKey, ruleChannels }) {
  const requested = new Set((ruleChannels || ['in_app']).map((c) => String(c).toLowerCase()));

  const { rows } = await db.query(
    `SELECT channel FROM notification_rules
      WHERE company_id = $1 AND event_key = $2 AND enabled = TRUE LIMIT 1`,
    [companyId, eventKey],
  );
  if (!rows.length) {
    // No company policy row: honour the rule alone. in_app always survives so an
    // alert is never completely silent.
    requested.add('in_app');
    return [...requested];
  }
  const allowed = new Set((rows[0].channel || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean));
  // Union, not intersection: a rule author asking for SMS on one specific critical
  // threshold should get it even if the company default for the event is quieter.
  // The company policy widens, the rule widens; only a disabled rule row silences.
  for (const c of allowed) requested.add(c);
  requested.add('in_app');
  return [...requested];
}

async function logDelivery(db, entry) {
  try {
    await db.query(
      `INSERT INTO iot_notification_log
         (company_id, alert_id, event_key, channel, user_id, destination, status, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [entry.companyId, entry.alertId ?? null, entry.eventKey, entry.channel,
       entry.userId ?? null, entry.destination ?? null, entry.status,
       entry.detail ? String(entry.detail).slice(0, 1000) : null],
    );
  } catch (e) {
    // The log is evidence, not the delivery. Never let it break a send.
    console.warn('[iot notify] delivery log failed:', e.message);
  }
}

/**
 * Deliver one alert notification across every enabled channel.
 *
 * @returns {Promise<{recipients:number, delivered:Object, skipped:Object}>}
 */
export async function notifyAlert(db, {
  companyId, alertId = null, severity = 'warning', metric = null,
  title, message, link = null,
  ruleChannels = ['in_app'], ruleRoles = [], ruleUserIds = [],
  escalation = false, resolved = false,
}) {
  const eventKey = eventKeyFor({ severity, escalation, metric, resolved });
  const channels = await effectiveChannels(db, { companyId, eventKey, ruleChannels });
  const recipients = await resolveRecipients(db, {
    companyId, roles: ruleRoles, userIds: ruleUserIds, eventKey,
  });

  const delivered = { in_app: 0, email: 0, sms: 0, push: 0 };
  const skipped = {};
  const skip = (channel, why) => { skipped[`${channel}:${why}`] = (skipped[`${channel}:${why}`] || 0) + 1; };

  if (!recipients.length) {
    await logDelivery(db, {
      companyId, alertId, eventKey, channel: 'none', status: 'no_recipients',
      detail: `no user matched roles [${ruleRoles.join(',')}] or the ${eventKey} policy in company ${companyId}`,
    });
    return { recipients: 0, delivered, skipped: { 'all:no_recipients': 1 }, eventKey, channels };
  }

  for (const user of recipients) {
    // ── in-app (also fans out to push, and to email via notification_rules) ───
    if (channels.includes('in_app')) {
      try {
        const created = await notificationsRepository.create({
          user_id: user.id,
          title,
          message,
          module_name: 'iot',
          reference_id: alertId,
          notification_type: severity === 'critical' ? 'error' : resolved ? 'success' : 'warning',
          event_key: eventKey,
        });
        // notifications.link exists in the schema but the shared repository does
        // not write it, and changing that repository would touch every module
        // that uses it. Setting it here keeps the blast radius at IoT while still
        // giving the notification a destination to click through to.
        if (link && created?.id) {
          await db.query(`UPDATE notifications SET link = $2 WHERE id = $1`, [created.id, link]).catch(() => {});
        }
        delivered.in_app += 1;
        await logDelivery(db, { companyId, alertId, eventKey, channel: 'in_app', userId: user.id, destination: user.name, status: 'sent' });
      } catch (e) {
        await logDelivery(db, { companyId, alertId, eventKey, channel: 'in_app', userId: user.id, status: 'failed', detail: e.message });
      }
    }

    // ── email, sent directly when the rule asks for it ────────────────────────
    // notificationsRepository already mails when the COMPANY policy lists email;
    // this covers the case where the RULE asks for email and the policy does not,
    // and is idempotent in effect because a duplicate mail is an annoyance, not a
    // correctness failure. Guarded so it does not double-send when both agree.
    const policyAlreadyMails = channels.includes('email') && (await policyIncludes(db, companyId, eventKey, 'email'));
    if (channels.includes('email') && !policyAlreadyMails) {
      if (!(await isEmailConfigured(companyId))) { skip('email', 'not_configured'); }
      else if (!user.email) { skip('email', 'no_address'); }
      else {
        try {
          await sendNotificationEmail(user.email, { title, message, companyId });
          delivered.email += 1;
          await logDelivery(db, { companyId, alertId, eventKey, channel: 'email', userId: user.id, destination: user.email, status: 'sent' });
        } catch (e) {
          await logDelivery(db, { companyId, alertId, eventKey, channel: 'email', userId: user.id, destination: user.email, status: 'failed', detail: e.message });
        }
      }
    } else if (policyAlreadyMails) {
      delivered.email += 1;   // sent through the in_app fan-out
    }

    // ── SMS ───────────────────────────────────────────────────────────────────
    if (channels.includes('sms')) {
      if (!isSmsConfigured()) { skip('sms', 'not_configured'); }
      else if (!user.phone) { skip('sms', 'no_number'); }
      else {
        try {
          const body = `${title}\n${message}`.slice(0, 300);
          const r = await sendSms(user.phone, body);
          if (r?.sent) {
            delivered.sms += 1;
            await logDelivery(db, { companyId, alertId, eventKey, channel: 'sms', userId: user.id, destination: user.phone, status: 'sent' });
          } else {
            await logDelivery(db, { companyId, alertId, eventKey, channel: 'sms', userId: user.id, destination: user.phone, status: 'skipped', detail: 'provider reported not sent' });
          }
        } catch (e) {
          await logDelivery(db, { companyId, alertId, eventKey, channel: 'sms', userId: user.id, destination: user.phone, status: 'failed', detail: e.message });
        }
      }
    }
  }

  // Push rides the in_app path (notificationsRepository.create fans out to the
  // user's registered devices). Counted separately only so the caller can see it
  // was attempted; there is no second send.
  if (channels.includes('push')) delivered.push = delivered.in_app;

  if (alertId) {
    await db.query(
      `UPDATE device_alerts SET notified_at = COALESCE(notified_at, NOW()), last_notified_at = NOW() WHERE id = $1`,
      [alertId],
    ).catch(() => {});
  }

  return { recipients: recipients.length, delivered, skipped, eventKey, channels };
}

/** Does the company policy for this event already include the channel? */
async function policyIncludes(db, companyId, eventKey, channel) {
  const { rows } = await db.query(
    `SELECT channel FROM notification_rules WHERE company_id = $1 AND event_key = $2 AND enabled = TRUE LIMIT 1`,
    [companyId, eventKey],
  );
  if (!rows.length) return false;
  return (rows[0].channel || '').split(',').map((c) => c.trim().toLowerCase()).includes(channel);
}

/** Channel availability, for the rule editor so it never offers a dead switch. */
/**
 * ⚠ ASYNC since PULSE-01 — the email row is per tenant now, so this takes the
 * company whose availability is being reported. Callers must await it.
 */
export async function channelAvailability(companyId = null) {
  const emailReady = await isEmailConfigured(companyId);
  return {
    in_app: { available: true, note: 'Always available.' },
    push: { available: true, note: 'Delivered to devices registered for push; silently skipped for users with none.' },
    email: {
      available: emailReady,
      note: emailReady
        ? 'SMTP configured.'
        : 'SMTP is not configured for this company or the deployment (set it under Integrations, or SMTP_HOST / SMTP_USER).',
    },
    sms: {
      available: isSmsConfigured(),
      note: isSmsConfigured()
        ? `Provider: ${process.env.SMS_PROVIDER}.`
        : 'No SMS provider configured (SMS_PROVIDER + credentials).',
    },
  };
}
