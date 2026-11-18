/**
 * 20261111000009_probation_review_cancel.js
 *
 * HR can withdraw an open probation review (requested or submitted), for
 * example when the employee resigns or moves before the review is decided.
 * The status 'cancelled' already exists (20261014000007); this adds who
 * cancelled it, when, and why. A cancelled row must carry all three.
 *
 * ROLLBACK refuses while any review is cancelled (the reason is an HR record).
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE probation_reviews
      ADD COLUMN IF NOT EXISTS cancelled_by_user_id INTEGER REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancel_reason       TEXT
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_probation_reviews_cancelled') THEN
        ALTER TABLE probation_reviews ADD CONSTRAINT chk_probation_reviews_cancelled
          CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL));
      END IF;
    END $$
  `);
}

export async function down(knex) {
  const { rows: [{ n }] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM probation_reviews WHERE status = 'cancelled'`);
  if (n > 0) {
    throw new Error(`Refusing to roll back 20261111000009: ${n} cancelled review(s) carry a reason.`);
  }
  await knex.raw(`ALTER TABLE probation_reviews DROP CONSTRAINT IF EXISTS chk_probation_reviews_cancelled`);
  await knex.raw(`
    ALTER TABLE probation_reviews
      DROP COLUMN IF EXISTS cancel_reason,
      DROP COLUMN IF EXISTS cancelled_at,
      DROP COLUMN IF EXISTS cancelled_by_user_id
  `);
}
