/**
 * 20261119000003 — Leave rating for performance, report numbers as settings
 * (§278.5, owner 2026-11-19).
 *
 * 1. attendance_general_settings.leave_rating_bands — the default rating a
 *    performance review shows for leave, like the punctuality rating: days off
 *    in the review period (approved leave + absent days) at most max_days =
 *    rating. Default: ≤6 → 5, ≤12 → 4, ≤18 → 3, ≤24 → 2, more → 1. Editable in
 *    Settings → Leave rating.
 * 2. late_warning_count — Late Arrivals offers a warning letter after this
 *    many late arrivals in a month (was a fixed 3 in the page).
 * 3. early_exit_minutes — the Early Exit report counts a day when the last
 *    punch was at least this many minutes before shift end (was a fixed 15).
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const LEAVE_BANDS = [
  { max_days: 6, rating: 5 }, { max_days: 12, rating: 4 }, { max_days: 18, rating: 3 },
  { max_days: 24, rating: 2 }, { max_days: null, rating: 1 },
];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE attendance_general_settings
      ADD COLUMN IF NOT EXISTS leave_rating_bands JSONB NOT NULL DEFAULT '${JSON.stringify(LEAVE_BANDS)}'::jsonb,
      ADD COLUMN IF NOT EXISTS late_warning_count INTEGER NOT NULL DEFAULT 3,
      ADD COLUMN IF NOT EXISTS early_exit_minutes INTEGER NOT NULL DEFAULT 15`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE attendance_general_settings
      DROP COLUMN IF EXISTS leave_rating_bands, DROP COLUMN IF EXISTS late_warning_count, DROP COLUMN IF EXISTS early_exit_minutes`);
}
