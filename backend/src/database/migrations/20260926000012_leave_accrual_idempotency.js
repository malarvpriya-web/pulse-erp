/**
 * 20260926000012_leave_accrual_idempotency.js
 *
 * Make "credit the same employee the same entitlement for the same period twice"
 * UNREPRESENTABLE.
 *
 * THE DEFECT
 * ----------
 * Two writers credit `leave_balances.allocated_days`:
 *
 *   1. POST /api/v1/leave-accrual/run   (leaves/routes/accrual.routes.js)
 *   2. leave.cron.js, `0 1 1 * *` — 1st of the month at 01:00 IST
 *
 * Both issue the same statement:
 *
 *     INSERT INTO leave_balances (...) VALUES (...)
 *     ON CONFLICT (employee_id, leave_type_id, year)
 *     DO UPDATE SET allocated_days = leave_balances.allocated_days + $4
 *
 * That ON CONFLICT reads as idempotent and is not. The conflict target is
 * (employee, leave_type, YEAR) — the row's identity, which says nothing about
 * WHICH PERIOD the increment is for — and the action is `+ $4`. So the statement
 * is idempotent about creating the balance ROW and purely ADDITIVE about the
 * days. Every re-run credits again:
 *
 *   - POST /leave-accrual/run twice for the same month → double credit. It takes
 *     `month`/`year` from the request body, so an HR user re-running a month
 *     "to be sure", or double-clicking, or retrying after a gateway timeout,
 *     silently grants every employee a second month of earned leave.
 *   - The cron firing, then HR running the same month by hand → double credit
 *     across a process boundary, with nothing in either path able to see the
 *     other's work.
 *   - A server restarted on the 1st between 01:00 and 01:01, or two app
 *     instances both running crons, → double credit.
 *
 * `leave_accrual_log` was built in 20260612000001 for exactly this — "per-event
 * audit trail for every accrual increment" — and then:
 *   - the CRON never wrote to it at all (0 of its increments are logged), and
 *   - the manual route wrote to it fire-and-forget, un-awaited, inside
 *     `.catch(() => {})`, so a failed log left the credit in place anyway.
 * It had no unique constraint, so even a complete log could not have prevented
 * anything. Live content: 5 rows, all 2026-08-20 seed fixtures crediting 100-200
 * days with `accrual_type` values ('Standard', 'General', 'Primary', 'Routine')
 * that no code path produces.
 *
 * THE FIX
 * -------
 * Promote `leave_accrual_log` from a trail that was written after the fact to the
 * LOCK that authorises the credit. The canonical service added in this batch
 * inserts the log row FIRST, `ON CONFLICT DO NOTHING RETURNING id`, in the same
 * transaction as the balance update: no row returned means this period is already
 * accrued, so the balance is not touched. Two concurrent runs therefore contend
 * on this index and exactly one wins — in-process, across processes, and across
 * the cron/manual boundary alike.
 *
 * THE KEY
 * -------
 * (employee_id, leave_type_id, year, COALESCE(month,0), COALESCE(accrual_type,'monthly'))
 *
 *   - `COALESCE(month, 0)` because `month` is nullable and NULL <> NULL in
 *     Postgres: a plain index on the raw column would let every year-scoped
 *     accrual (carry-forward) duplicate freely, which is the larger of the two
 *     credits. 0 is safe as the sentinel — `month` is 1-12 when set.
 *   - `COALESCE(accrual_type, 'monthly')` for the same reason; the column is
 *     nullable with a DEFAULT, so a caller that passes an explicit NULL would
 *     otherwise slip past.
 *   - `run_mode` is deliberately ABSENT. Including it would make 'cron' and
 *     'manual' distinct keys — the exact cross-writer double-credit this exists
 *     to stop. The key answers "was this period accrued", not "who accrued it".
 *   - `company_id` is deliberately ABSENT. An employee belongs to one company;
 *     including it would let a company re-stamp and re-credit.
 *
 * Verified before creating the index (2026-09-26): 0 duplicate groups under this
 * exact key across all 5 existing rows, so it is created without touching or
 * discarding any historical row.
 */

export async function up(knex) {
  // Refuse to create the constraint silently over data that violates it. A
  // CREATE UNIQUE INDEX failing here is the correct outcome on a database whose
  // history is not this one's — it says "you have double-credited leave, decide
  // what to do about it" rather than quietly not protecting anything.
  const { rows: dups } = await knex.raw(`
    SELECT employee_id, leave_type_id, year, COALESCE(month, 0) AS m,
           COALESCE(accrual_type, 'monthly') AS at, COUNT(*)::int AS n
      FROM leave_accrual_log
     GROUP BY employee_id, leave_type_id, year, COALESCE(month, 0),
              COALESCE(accrual_type, 'monthly')
    HAVING COUNT(*) > 1
  `);
  if (dups.length) {
    throw new Error(
      `[20260926000012] leave_accrual_log already holds ${dups.length} duplicate ` +
      `(employee, leave_type, year, month, accrual_type) group(s) — e.g. employee ` +
      `${dups[0].employee_id}/type ${dups[0].leave_type_id}/${dups[0].year}-${dups[0].m} ` +
      `x${dups[0].n}. These are real double-credits and must be reconciled against ` +
      `leave_balances by a human before the constraint can be added; this migration ` +
      `will not pick which row to discard.`);
  }

  const { rows: existing } = await knex.raw(
    `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_accrual_log_period'`);
  if (!existing.length) {
    await knex.raw(`
      CREATE UNIQUE INDEX uq_accrual_log_period
        ON leave_accrual_log (
             employee_id,
             leave_type_id,
             year,
             COALESCE(month, 0),
             COALESCE(accrual_type, 'monthly')
           )
    `);
  }

  // The service reads the log by period to report what it skipped; without this
  // the ON CONFLICT probe is served by uq_accrual_log_period but the "what did
  // this run already do" summary query is a seq scan per company per run.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_accrual_log_period_lookup
      ON leave_accrual_log (company_id, year, COALESCE(month, 0))
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS uq_accrual_log_period`);
  await knex.raw(`DROP INDEX IF EXISTS idx_accrual_log_period_lookup`);
}
