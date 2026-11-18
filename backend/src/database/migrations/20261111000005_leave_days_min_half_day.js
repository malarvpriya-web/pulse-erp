/**
 * 20261111000005 — a half-day leave could never be applied for.
 *
 * Validation rule `leave_days_min` (20260429000002) requires `days` ≥ 1, and
 * POST /leaves/apply validates days = number_of_days. Apply Leave offers
 * "Apply for half day", which sends 0.5 → every half-day request came back
 * 422 "Leave must be at least 1 day" (reproduced through the real page,
 * 11 Nov 26). The minimum is now half a day.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() restores the 1-day minimum.
 */
const CODE = 'leave_days_min';

const setMin = (knex, min, msg) => knex.raw(
  `UPDATE validation_rules SET rule_expr = $1, error_message = $2 WHERE code = $3`,
  [JSON.stringify({ min }), msg, CODE],
);

export async function up(knex) {
  await setMin(knex, 0.5, 'Leave must be at least half a day');
}

export async function down(knex) {
  await setMin(knex, 1, 'Leave must be at least 1 day');
}
