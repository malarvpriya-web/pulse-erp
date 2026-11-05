/**
 * outbox.js — the transactional outbox that separates telemetry from its
 * consequences.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 * -------------------------------
 * alertActions.createServiceTicket() ran its INSERT INTO support_tickets INSIDE
 * the ingest transaction, wrapped in try/catch, with the comment "never throws —
 * a ticket failure must not roll back the telemetry write". That comment
 * describes an intention Postgres does not honour: once a statement inside a
 * transaction raises, the transaction is ABORTED, and every subsequent statement
 * fails with 25P02 (current transaction is aborted). So a ticket failure took the
 * whole batch down — the opposite of the stated goal — and the handler's own
 * catch then issued ROLLBACK on an already-aborted transaction.
 *
 * The fix is the standard one: the ingest transaction writes telemetry AND an
 * outbox row and commits. A worker picks the row up afterwards. A ticket failure
 * now retries on its own schedule and can never touch telemetry.
 *
 *   Telemetry txn → [telemetry rows + outbox event] → COMMIT
 *                                                       ↓
 *                                             worker → service ticket / notification
 *
 * Delivery is at-least-once, so every handler must be idempotent. `dedupe_key` is
 * the enqueue-side guard (one event per incident per topic); the handlers add a
 * second guard by checking for the artefact they would create.
 */

/**
 * Enqueue an event. Safe to call with a transaction client — that is the point.
 *
 * @param {object} db      pool or transaction client
 * @param {object} e
 * @param {number} e.companyId
 * @param {string} e.topic       'alert.opened' | 'alert.resolved' | 'alert.escalate' | 'notification'
 * @param {string} e.dedupeKey   stable per logical event
 * @param {object} e.payload
 * @returns {Promise<{enqueued: boolean, id: number|null}>}
 */
export async function enqueue(db, { companyId, topic, dedupeKey, payload, maxAttempts = 8 }) {
  const { rows } = await db.query(
    `INSERT INTO iot_outbox (company_id, topic, dedupe_key, payload, max_attempts)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [companyId, topic, dedupeKey, JSON.stringify(payload ?? {}), maxAttempts],
  );
  return { enqueued: rows.length > 0, id: rows[0]?.id ?? null };
}

/**
 * Claim up to `limit` due events for processing.
 *
 * FOR UPDATE SKIP LOCKED is what makes two worker instances safe: each claims a
 * disjoint set rather than both processing the same row.
 */
export async function claim(db, limit = 25) {
  const { rows } = await db.query(
    `UPDATE iot_outbox o
        SET status = 'processing', attempts = o.attempts + 1
       FROM (
         SELECT id FROM iot_outbox
          WHERE status = 'pending' AND next_attempt_at <= NOW()
          ORDER BY next_attempt_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) d
      WHERE o.id = d.id
      RETURNING o.*`,
    [limit],
  );
  return rows;
}

export async function markDone(db, id) {
  await db.query(
    `UPDATE iot_outbox SET status = 'done', processed_at = NOW(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

/**
 * Record a failure and schedule the retry.
 *
 * Exponential backoff with jitter, capped at 30 minutes; past max_attempts the
 * row becomes 'dead' and stays visible — a dead-letter an operator can see and
 * replay, not a silently dropped ticket.
 */
export async function markFailed(db, row, error) {
  const attempts = row.attempts;
  const max = row.max_attempts ?? 8;
  if (attempts >= max) {
    await db.query(
      `UPDATE iot_outbox SET status = 'dead', last_error = $2, processed_at = NOW() WHERE id = $1`,
      [row.id, String(error).slice(0, 2000)],
    );
    return { dead: true, retryInSecs: null };
  }
  const base = Math.min(30 * 60, Math.pow(2, attempts) * 5);   // 10s, 20s, 40s … 30m
  const secs = Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% jitter
  await db.query(
    `UPDATE iot_outbox
        SET status = 'pending',
            next_attempt_at = NOW() + ($2 || ' seconds')::interval,
            last_error = $3
      WHERE id = $1`,
    [row.id, String(secs), String(error).slice(0, 2000)],
  );
  return { dead: false, retryInSecs: secs };
}

/** Requeue a dead event (operator action after fixing the cause). */
export async function replayDead(db, id) {
  const { rowCount } = await db.query(
    `UPDATE iot_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL, processed_at = NULL
      WHERE id = $1 AND status = 'dead'`,
    [id],
  );
  return rowCount > 0;
}
