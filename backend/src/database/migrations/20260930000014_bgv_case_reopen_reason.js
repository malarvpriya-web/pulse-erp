/**
 * 20260930000014 — reopening a closed BGV case is recorded on the case.
 *
 * ── Why columns and not just the audit log ──────────────────────────────────
 * The audit entry is written too (and is the immutable record). But a reason
 * that lives ONLY in `audit_logs` cannot be shown on the case, and the person
 * who needs it most is the next HR user to open that record: "this was closed
 * and then reopened — why?" is a question the page should answer, not one that
 * needs an audit query.
 *
 * Three columns, not one, because "when" and "who" are as much of the answer as
 * "why", and deriving them from the latest audit row would be a second source of
 * truth for a fact the case can simply hold.
 *
 * ── Why the reason is mandatory in the API, not NOT NULL here ───────────────
 * A NOT NULL column would make every EXISTING row unwritable and would say the
 * wrong thing about a case that has never been reopened — NULL here means
 * "never reopened", which is the truth for almost every row. The mandate belongs
 * on the act, so the route refuses a reopen without a reason.
 *
 * ── Closing already had `closure_remarks`, and this is not it ───────────────
 * `closure_remarks` is why the case was CLOSED. Reusing it for the reopen reason
 * would overwrite the closing rationale with the reason for undoing it, and lose
 * the first one — the same conflation that makes a single status/result column
 * wrong.
 */
export async function up(knex) {
  // ⚠ pg shim, not knex: bindings are $1/$2.
  await knex.raw(`
    ALTER TABLE bgv_cases
      ADD COLUMN IF NOT EXISTS reopened_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reopened_by    INTEGER,
      ADD COLUMN IF NOT EXISTS reopen_reason  TEXT
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE bgv_cases
      DROP COLUMN IF EXISTS reopened_at,
      DROP COLUMN IF EXISTS reopened_by,
      DROP COLUMN IF EXISTS reopen_reason
  `);
}
