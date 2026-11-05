/**
 * iotOutbox.cron.js — the worker that turns committed alert events into service
 * tickets and notifications.
 *
 * Runs every 30 seconds. Claims a batch with FOR UPDATE SKIP LOCKED, so running
 * two backend instances is safe: each claims a disjoint set.
 *
 * Failure handling is the point of the whole design:
 *   attempt fails  → exponential backoff with jitter, status back to 'pending'
 *   attempts spent → status 'dead', visible on the IoT Health page, replayable
 *                    from /iot/ops/outbox/:id/replay once the cause is fixed
 *
 * An alert can therefore no longer lose its ticket silently, which is what
 * happened when ticket creation was a try/catch inside the ingest transaction.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import { claim, markDone, markFailed } from '../modules/iot/outbox.js';
import { HANDLERS } from '../modules/iot/alertActions.js';

const BATCH = parseInt(process.env.IOT_OUTBOX_BATCH || '25', 10);

export async function drainOutbox() {
  let processed = 0, failed = 0, dead = 0;
  const events = await claim(pool, BATCH);
  for (const ev of events) {
    const handler = HANDLERS[ev.topic];
    if (!handler) {
      // An unknown topic will never succeed; dead-letter it immediately rather
      // than burning eight retries on it.
      await pool.query(
        `UPDATE iot_outbox SET status='dead', last_error=$2, processed_at=NOW() WHERE id=$1`,
        [ev.id, `no handler registered for topic '${ev.topic}'`]);
      dead += 1;
      continue;
    }
    try {
      const result = await handler(pool, ev.payload || {});
      await markDone(pool, ev.id);
      processed += 1;
      console.log(JSON.stringify({
        ts: new Date().toISOString(), level: 'INFO', event: 'iot_outbox_processed',
        outbox_id: ev.id, topic: ev.topic, company_id: ev.company_id,
        alert_id: ev.payload?.alert_id ?? null, result,
      }));
    } catch (e) {
      const r = await markFailed(pool, ev, e.message);
      if (r.dead) dead += 1; else failed += 1;
      console.error(JSON.stringify({
        ts: new Date().toISOString(), level: r.dead ? 'ERROR' : 'WARN',
        event: r.dead ? 'iot_outbox_dead_letter' : 'iot_outbox_retry',
        outbox_id: ev.id, topic: ev.topic, attempts: ev.attempts,
        alert_id: ev.payload?.alert_id ?? null,
        retry_in_secs: r.retryInSecs, message: e.message,
      }));
    }
  }
  return { claimed: events.length, processed, failed, dead };
}

export function startIotOutboxCron() {
  cron.schedule('*/30 * * * * *', () => {
    drainOutbox().catch((e) => console.error('[iotOutbox] drain failed:', e.message));
  });
  console.log('📨 IoT outbox worker started — every 30s (alert → ticket / notification, with retry + dead-letter)');
}
