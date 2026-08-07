/**
 * Interview Reminder Cron
 * ──────────────────────────────────────────────────────────────────────────────
 * POST /interviews (recruitment.routes.js) already fires an immediate notify+email
 * at scheduling time, but nothing ever reminds anyone again before the interview
 * actually happens — a panelist or candidate who misses the original notification
 * gets no second nudge. This runs daily and reminds everyone with an
 * interview_schedules row dated tomorrow.
 *
 * Two different recipients, two different channels: the panelist is a system user
 * (or isn't — employees has no user_id column, same lookup POST /interviews already
 * uses to resolve one) and gets the normal in-app+push notification via
 * notificationsRepository.create(). The candidate has no login to notify in-app,
 * so they get a direct email via mailer.js's sendNotificationEmail — the same
 * generic sender notification_rules-driven email already uses, called directly
 * here since a candidate isn't a `users` row for that lookup to resolve.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { sendNotificationEmail, isEmailConfigured } from '../utils/mailer.js';

async function insertReminder(userId, { referenceId, title, message }) {
  const dup = await pool.query(
    `SELECT 1
       FROM notifications
      WHERE user_id = $1
        AND module_name = 'recruitment'
        AND reference_id = $2
        AND notification_type = 'interview_reminder'
        AND created_at::date = CURRENT_DATE
      LIMIT 1`,
    [userId, referenceId]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title,
    message,
    module_name: 'recruitment',
    reference_id: referenceId,
    notification_type: 'interview_reminder',
  });
}

async function runInterviewReminderCheck() {
  const { rows } = await pool.query(`
    SELECT s.id, s.candidate_id, s.interviewer_id, s.interview_date, s.interview_time,
           s.interview_mode, s.meeting_link,
           c.full_name AS candidate_name, c.email AS candidate_email
      FROM interview_schedules s
      JOIN candidates c ON c.id = s.candidate_id
     WHERE s.interview_date = CURRENT_DATE + INTERVAL '1 day'
       AND s.status = 'scheduled'
       AND s.deleted_at IS NULL
  `);

  for (const row of rows) {
    const when = row.interview_time
      ? `${row.interview_date} at ${row.interview_time}`
      : `${row.interview_date}`;

    if (row.interviewer_id) {
      const { rows: u } = await pool
        .query('SELECT id AS user_id FROM users WHERE employee_id = $1', [row.interviewer_id])
        .catch(() => ({ rows: [] }));
      const interviewerUserId = u[0]?.user_id;
      if (interviewerUserId) {
        // notifications.reference_id is integer — interview_schedules.id is a
        // UUID PK (see recruitment.routes.js's own top-of-file note on this),
        // so it can't be used here. candidate_id (integer) is the same
        // reference this module's other notify() calls use.
        await insertReminder(interviewerUserId, {
          referenceId: row.candidate_id,
          title: 'Interview Tomorrow',
          message: `Interview with ${row.candidate_name} is scheduled for ${when}`
            + `${row.interview_mode ? ` (${row.interview_mode})` : ''} — check your calendar.`,
        });
      }
    }

    if (row.candidate_email && isEmailConfigured()) {
      await sendNotificationEmail(row.candidate_email, {
        title: 'Interview Reminder',
        message: `This is a reminder that your interview is scheduled for ${when}`
          + `${row.meeting_link ? `. Meeting link: ${row.meeting_link}` : ''}.`,
      }).catch(() => {});
    }
  }
}

export function startInterviewReminderCron() {
  // Daily at 08:00 server local time — ahead of the workday and ahead of
  // interviews that are typically scheduled later in the day.
  cron.schedule('0 8 * * *', () => {
    runInterviewReminderCheck().catch((err) =>
      console.error('[interviewReminderCron] failed:', err.message)
    );
  });
  console.log('📅 Interview reminder cron started (daily 08:00)');
}

export { runInterviewReminderCheck as runInterviewReminderCheckNow };
