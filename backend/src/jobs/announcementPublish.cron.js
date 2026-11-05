/**
 * Announcement publish job — every 5 minutes.
 *
 * Notifies announcements that have become live since they were saved: a
 * Scheduled Publish time that has passed, or a From date that has arrived. A
 * save that is live immediately is notified by the save itself; this job only
 * catches up the rest. Idempotent — see announcement.publisher.js — so an
 * overlapping or repeated run sends nothing twice. Worst-case delay after the
 * scheduled time is one interval.
 */
import cron from 'node-cron';
import { scheduled } from './jobRun.js';
import { publishDue } from '../announcements/announcement.publisher.js';

export const runAnnouncementPublishNow = (opts = {}) => publishDue(opts);

export function startAnnouncementPublishCron() {
  cron.schedule('*/5 * * * *', scheduled('announcementPublish', () => publishDue()), {
    scheduled: true,
    timezone: 'Asia/Kolkata',
  });
  console.log('✅ Announcement publish cron scheduled — runs every 5 minutes');
}
