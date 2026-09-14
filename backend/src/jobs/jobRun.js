/**
 * jobRun.js — one shape for what a scheduled job reports about itself.
 *
 * WHY
 * ---
 * The procurement crons logged a start-up banner when the process booted and,
 * beyond that, only failures — and only the `err.message` of a failure that
 * escaped all the way to the scheduler callback. From the outside there was no
 * way to answer any of:
 *
 *   - did the 09:15 alerts job run at all this morning?
 *   - how long did it take, and is it getting slower?
 *   - how many purchase orders did it actually look at? how many notified?
 *   - it failed — at which company, on which record, with what stack?
 *
 * A job that only speaks when it crashes is indistinguishable from a job that
 * has silently stopped being scheduled. reorderPr in particular can create
 * purchase requisitions, so "did it run and what did it do" is an auditable
 * question, not a curiosity.
 *
 * WHAT IT LOGS
 * ------------
 *   [job:<name>] start
 *   [job:<name>] ok   in 412ms — { companies: 2, overdue_pos: 7, notified: 14 }
 *   [job:<name>] FAIL in 88ms  — <message>   (+ the stack, once)
 *
 * The counters are whatever the job returns; they are integers and record ids,
 * never row content. Nothing here formats a vendor name, an amount, an email or
 * a document body into a log line — a log is a place data leaks from, and a
 * count answers the operational question without carrying any of that.
 */

/**
 * @param {string} name    stable job identifier, e.g. 'procurementAlerts'
 * @param {() => Promise<object|void>} fn  the job. Anything it returns is
 *   logged as its counters, so return `{ processed, notified, skipped }`.
 * @returns {Promise<{ok: boolean, ms: number, counters: object, error?: Error}>}
 *   Always resolves — a scheduled job must not produce an unhandled rejection —
 *   so callers that need to know can inspect `.ok`. Tests call the exported
 *   `run*Now()` functions directly and get the counters back.
 */
export async function runJob(name, fn) {
  const t0 = Date.now();
  console.info(`[job:${name}] start`);
  try {
    const counters = (await fn()) ?? {};
    const ms = Date.now() - t0;
    const summary = Object.entries(counters)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.info(`[job:${name}] ok in ${ms}ms${summary ? ' — ' + summary : ''}`);
    return { ok: true, ms, counters };
  } catch (error) {
    const ms = Date.now() - t0;
    // Message AND stack: a bare `err.message` on a SQL failure says
    // 'column "x" does not exist' with no indication of which query, which is
    // not enough to fix anything at 3am.
    console.error(`[job:${name}] FAIL in ${ms}ms — ${error.message}`);
    if (error.stack) console.error(error.stack);
    return { ok: false, ms, counters: {}, error };
  }
}

/**
 * Wrap a job for node-cron. The scheduler gets a function that never rejects,
 * so a thrown error can never take the process down or vanish unlogged.
 */
export const scheduled = (name, fn) => () => { runJob(name, fn); };

export default { runJob, scheduled };
