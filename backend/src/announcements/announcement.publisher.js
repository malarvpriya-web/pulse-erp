/**
 * announcement.publisher.js — notify an announcement's audience, exactly once.
 *
 * Called after every save (create / update / toggle) and by the publish job
 * (jobs/announcementPublish.cron.js), so an announcement notifies when it
 * actually goes live: immediately if it is live on save, otherwise on the first
 * job run after its publish_at / from_date arrives, and never if it is archived,
 * hidden or expired first.
 *
 * Once only: the UPDATE that sets notified_at is also the claim. It matches only
 * while notified_at IS NULL, so a second caller — another job tick, a save
 * racing the job — blocks on the row lock, re-checks, and matches nothing. The
 * notification rows are inserted in the same transaction, so a failure leaves
 * notified_at NULL and the next run retries; either both commit or neither does.
 *
 * Delivery: the in-app rows are written here inside the claim transaction (they
 * have to commit with it); push and email then go through the shared
 * notificationsRepository.dispatchSideEffects after COMMIT, the same split the
 * probation reminder job uses. Email follows notification_rules for
 * event_key 'announcement.published' — no rule row, no email.
 *
 * An edit after notification does NOT re-notify (see the module manual).
 */
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { liveSql, populationFromSql } from './announcement.visibility.js';

export const EVENT_KEY = 'announcement.published';
export const MODULE_NAME = 'Announcements';
export const NOTIFICATION_TYPE = 'announcement';

/** Plain text for a notification body: tags dropped, entities decoded, trimmed to `max`. */
export function plainText(html, max = 280) {
  const text = String(html ?? '')
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Notify announcement `id` if it is live and not yet notified.
 * @returns {Promise<{ claimed: boolean, sent: number }>}
 */
export async function publishIfDue(id) {
  if (!/^\d+$/.test(String(id))) return { claimed: false, sent: 0 };
  const client = await pool.connect();
  let sent = [];
  let claimed = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE announcements a
          SET notified_at = NOW()
        WHERE a.id = $1
          AND a.notified_at IS NULL
          AND a.company_id IS NOT NULL
          AND ${liveSql('a')}
        RETURNING a.id, a.company_id, a.title, a.message, a.priority`,
      [Number(id)]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { claimed: false, sent: 0 };
    }
    claimed = rows[0];

    const { rows: recipients } = await client.query(
      `SELECT DISTINCT u.id AS user_id
         FROM announcements a
         CROSS JOIN LATERAL (SELECT u.id ${populationFromSql('a')}) u
        WHERE a.id = $1`,
      [claimed.id]);

    const payload = {
      title: `New announcement: ${claimed.title}`,
      message: plainText(claimed.message),
      module_name: MODULE_NAME,
      reference_id: claimed.id,
      notification_type: NOTIFICATION_TYPE,
      event_key: EVENT_KEY,
      company_id: claimed.company_id,
    };
    const userIds = recipients.map(r => r.user_id);
    if (userIds.length) {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
         SELECT uid, $2, $3, $4, $5, $6 FROM UNNEST($1::int[]) AS uid`,
        [userIds, payload.title, payload.message, payload.module_name, payload.reference_id, payload.notification_type]);
    }
    await client.query('COMMIT');
    sent = userIds.map(user_id => ({ ...payload, user_id }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const n of sent) {
    // Best effort, as everywhere else: the in-app row is the notification of record.
    try { await notificationsRepository.dispatchSideEffects(n); }
    catch (err) { console.error('[Announcements] notification side effects failed:', err.message); }
  }
  return { claimed: true, sent: sent.length };
}

/** Every live, un-notified announcement, oldest first. Used by the publish job. */
export async function publishDue({ companyId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id FROM announcements a
      WHERE a.notified_at IS NULL
        AND a.company_id IS NOT NULL
        AND ($1::int IS NULL OR a.company_id = $1::int)
        AND ${liveSql('a')}
      ORDER BY a.id`,
    [companyId]);
  let published = 0, notified = 0;
  for (const { id } of rows) {
    const r = await publishIfDue(id);
    if (r.claimed) { published += 1; notified += r.sent; }
  }
  return { due: rows.length, published, notified };
}
