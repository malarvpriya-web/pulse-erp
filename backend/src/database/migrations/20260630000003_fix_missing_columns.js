/**
 * 20260630000003_fix_missing_columns.js
 * Adds missing columns that runtime queries expect but were omitted from prior migrations.
 *
 * 1. routing_steps.work_centre_id  — production dashboard JOIN fails without it
 * 2. payment_batches.total_amount  — approvals/pending query references this column
 */
export async function up(knex) {
  const safe = (sql) => knex.raw(sql).catch(() => {});

  // routing_steps was created by IF NOT EXISTS; if it existed earlier without this column, add it now
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS work_centre_id INTEGER REFERENCES work_centres(id) ON DELETE SET NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_routing_steps_wc ON routing_steps(work_centre_id)`);

  // payment_batches total_amount — sum of all items in the batch
  await safe(`ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) DEFAULT 0`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON payment_batches(status)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE routing_steps DROP COLUMN IF EXISTS work_centre_id`).catch(() => {});
  await knex.raw(`ALTER TABLE payment_batches DROP COLUMN IF EXISTS total_amount`).catch(() => {});
}
