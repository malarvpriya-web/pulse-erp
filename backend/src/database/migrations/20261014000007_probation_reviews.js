/**
 * 20261014000007_probation_reviews.js
 *
 * One row per probation review CYCLE. The workflow (Task 3B) uses the request
 * and submission columns; the decision and extension columns exist now so the
 * record is complete, and stay NULL until the HR decision stage is built.
 *
 *   requested  HR asked the department head for a review
 *   submitted  the head gave a rating, comments and a recommendation
 *   decided    (later) HR recorded the final decision
 *   cancelled  (later) the review was withdrawn
 *
 * probation_notifications (the legacy log) is not touched — not read, not
 * migrated, not archived.
 *
 * CONSTRAINTS
 *   - one open review (requested/submitted) per employee — a partial unique
 *     index — so a repeated or concurrent "request review" cannot open a
 *     second one;
 *   - (employee, cycle_no) unique;
 *   - rating 1..5, recommendation in a fixed list, status in a fixed list;
 *   - a submitted/decided row must carry its rating, recommendation and
 *     submitted_at (CHECK), so "submitted" cannot exist without the data.
 *   - reviewer_notified_at records that the reviewer was notified, in the
 *     same transaction as the notification — the dedup key for retries.
 *
 * KEYS: company CASCADE; employee / reviewer / department / users RESTRICT
 * (history must not lose its subjects); department_head_id SET NULL (the
 * mapping row is history too, but the review keeps reviewer_employee_id).
 *
 * ROLLBACK refuses while any review exists (HR records), else drops the table.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS probation_reviews (
      id                      SERIAL PRIMARY KEY,
      company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id             INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      cycle_no                SMALLINT NOT NULL CHECK (cycle_no >= 1),
      period_start            DATE NOT NULL,
      original_end_date       DATE NOT NULL,

      requested_by_user_id    INTEGER REFERENCES users(id),
      requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      department_id           INTEGER REFERENCES master_departments(id) ON DELETE RESTRICT,
      department_head_id      INTEGER REFERENCES department_heads(id) ON DELETE SET NULL,
      reviewer_employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      reviewer_due_date       DATE NOT NULL,
      reviewer_notified_at    TIMESTAMPTZ,

      rating                  SMALLINT CHECK (rating BETWEEN 1 AND 5),
      comments                TEXT,
      recommendation          VARCHAR(20)
                              CHECK (recommendation IN ('confirm', 'extend', 'not_confirm')),
      submitted_by_user_id    INTEGER REFERENCES users(id),
      submitted_at            TIMESTAMPTZ,

      decision                VARCHAR(20)
                              CHECK (decision IN ('confirmed', 'extended', 'not_confirmed')),
      decision_notes          TEXT,
      decided_by_user_id      INTEGER REFERENCES users(id),
      decided_at              TIMESTAMPTZ,
      extension_months        SMALLINT CHECK (extension_months BETWEEN 1 AND 24),
      new_end_date            DATE,

      status                  VARCHAR(20) NOT NULL DEFAULT 'requested'
                              CHECK (status IN ('requested', 'submitted', 'decided', 'cancelled')),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_probation_reviews_cycle UNIQUE (employee_id, cycle_no),
      CONSTRAINT chk_probation_reviews_period CHECK (original_end_date >= period_start),
      CONSTRAINT chk_probation_reviews_submitted CHECK (
        status NOT IN ('submitted', 'decided')
        OR (rating IS NOT NULL AND recommendation IS NOT NULL AND submitted_at IS NOT NULL)
      ),
      CONSTRAINT chk_probation_reviews_not_self CHECK (reviewer_employee_id <> employee_id)
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_probation_reviews_open
      ON probation_reviews (employee_id) WHERE status IN ('requested', 'submitted')
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_probation_reviews_company_status
      ON probation_reviews (company_id, status, reviewer_due_date)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_probation_reviews_reviewer
      ON probation_reviews (reviewer_employee_id) WHERE status = 'requested'
  `);
}

export async function down(knex) {
  const { rows: [{ n }] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM probation_reviews`);
  if (n > 0) {
    throw new Error(
      `Refusing to roll back 20261014000007_probation_reviews: ${n} review(s) exist. ` +
      `They are HR records — export or remove them deliberately first.`);
  }
  await knex.raw(`DROP TABLE IF EXISTS probation_reviews`);
}
