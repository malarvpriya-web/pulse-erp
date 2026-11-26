/**
 * 20261126000001 — Travel Desk fixes (audit 26 Nov 26).
 *
 *  travel_requests  who decided / when / why, and cancellation details — the
 *                   decision used to live only in the audit log, and a reject
 *                   carried no reason.
 *  travel_advances  the ledger postings (disbursement, refund of unspent
 *                   advance) and the refund itself.
 *  travel_bookings  who booked and why a booking was cancelled (bookings are
 *                   made by the travel desk only).
 *  visit_reports    the manager's review — a report used to be marked
 *                   "Completed" by its own author.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE travel_requests
      ADD COLUMN IF NOT EXISTS decided_by        INTEGER,
      ADD COLUMN IF NOT EXISTS decided_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS decision_comments TEXT,
      ADD COLUMN IF NOT EXISTS cancel_reason     TEXT,
      ADD COLUMN IF NOT EXISTS cancelled_by      INTEGER,
      ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ`);
  await knex.raw(`
    ALTER TABLE travel_advances
      ADD COLUMN IF NOT EXISTS journal_entry_id        UUID REFERENCES journal_entries(id),
      ADD COLUMN IF NOT EXISTS refund_amount           NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS refund_ref              VARCHAR(120),
      ADD COLUMN IF NOT EXISTS refund_date             DATE,
      ADD COLUMN IF NOT EXISTS refund_by               INTEGER,
      ADD COLUMN IF NOT EXISTS refund_journal_entry_id UUID REFERENCES journal_entries(id)`);
  await knex.raw(`
    ALTER TABLE travel_bookings
      ADD COLUMN IF NOT EXISTS booked_by     INTEGER,
      ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
  await knex.raw(`
    ALTER TABLE visit_reports
      ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reviewed_by    INTEGER,
      ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_remarks TEXT`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_travel_requests_employee ON travel_requests (employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_expense_claims_trip ON expense_claims (travel_request_id) WHERE travel_request_id IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_expense_claims_trip`);
  await knex.raw(`DROP INDEX IF EXISTS idx_travel_requests_employee`);
  await knex.raw(`ALTER TABLE visit_reports DROP COLUMN IF EXISTS review_remarks, DROP COLUMN IF EXISTS reviewed_at, DROP COLUMN IF EXISTS reviewed_by, DROP COLUMN IF EXISTS submitted_at`);
  await knex.raw(`ALTER TABLE travel_bookings DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS booked_by`);
  await knex.raw(`ALTER TABLE travel_advances DROP COLUMN IF EXISTS refund_journal_entry_id, DROP COLUMN IF EXISTS refund_by, DROP COLUMN IF EXISTS refund_date, DROP COLUMN IF EXISTS refund_ref, DROP COLUMN IF EXISTS refund_amount, DROP COLUMN IF EXISTS journal_entry_id`);
  await knex.raw(`ALTER TABLE travel_requests DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS decision_comments, DROP COLUMN IF EXISTS decided_at, DROP COLUMN IF EXISTS decided_by`);
}
