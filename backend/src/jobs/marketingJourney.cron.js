/**
 * Marketing Journey Runner
 * ──────────────────────────────────────────────────────────────────────────────
 * `sequence_enrollments.next_send_at` has been written since the table shipped
 * and NOTHING EVER READ IT. Enrolling a lead created a row that sat at step 0
 * forever while the sequences screen counted it as an active enrolment. This is
 * the missing half — the same gap the workflow engine had in §153: a write path
 * with no execution path looks exactly like a working feature.
 *
 * Runs every 15 minutes rather than daily: journey delays are expressed in hours
 * as well as days, and a daily sweep would round every "2 hours later" step up
 * to the next morning.
 *
 * ⚠ Sends nothing when SMTP is unconfigured, and does not advance enrolments in
 * that case — an un-run journey must look un-run rather than accumulate a
 * fabricated send history.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import { runDue, transportConfigured } from '../modules/crm/services/journeyEngine.js';

export async function runMarketingJourneys() {
  const started = Date.now();
  try {
    const tally = await runDue(pool, { limit: 500 });
    if (tally.due === 0) return tally;

    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: tally.failed ? 'WARN' : 'INFO',
      event: 'marketing_journey_run',
      ...tally, ms: Date.now() - started,
      transport: transportConfigured() ? 'smtp' : 'none',
    }));
    return tally;
  } catch (err) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'ERROR',
      event: 'marketing_journey_run_failed', message: err.message,
    }));
    return { due: 0, failed: 1, errors: [{ reason: err.message }] };
  }
}

export function startMarketingJourneyCron() {
  if (!transportConfigured()) {
    // Said once at boot rather than every 15 minutes: without a transport the
    // runner would log a failure per due enrolment forever.
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN',
      event: 'marketing_journey_cron_idle',
      message: 'SMTP is not configured — the journey runner is scheduled but will not send. Set SMTP_HOST and SMTP_USER to enable it.',
    }));
  }
  cron.schedule('*/15 * * * *', runMarketingJourneys, { timezone: 'Asia/Kolkata' });
  console.log('📧 Marketing journey runner scheduled (every 15 min)');
}

export default { startMarketingJourneyCron, runMarketingJourneys };
