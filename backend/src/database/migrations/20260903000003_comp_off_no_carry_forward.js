/**
 * 20260903000003_comp_off_no_carry_forward.js
 *
 * Turns carry-forward OFF for comp-off leave types.
 *
 * Comp off already carries its own validity window: compensatory_off.expires_on
 * is work_date + 3 months, and the nightly expiry job reverses the credit when
 * it lapses. carry_forward_allowed is a SECOND, contradictory lifetime policy
 * over the same days, and the two jobs key on different years — so they cannot
 * both be right:
 *
 *   1. Holiday worked Nov 2026 -> approved -> leave_balances(year=2026) += 1,
 *      expires_on = Feb 2027.
 *   2. 1 Jan 2027 02:00, runCarryForward() picks up EVERY leave type with
 *      carry_forward_allowed = true — comp off included — and copies up to
 *      max_carry_forward_days of the unused balance into the 2027 row.
 *   3. Feb 2027, the comp-off expiry sweep decrements
 *      `year = EXTRACT(year FROM work_date)` = 2026. It never sees the 2027 copy.
 *   4. carry_forward_expiry_months is NULL, so the carry-forward expiry job
 *      does not clear it either.
 *
 * Net: comp off earned in Q4 becomes a permanent, never-expiring leave day and
 * is double-counted across the year boundary. This was dormant only because
 * 20260903000002 was the first migration to make comp-off credits actually
 * reach leave_balances at all — before that the balance never moved, so there
 * was nothing to carry. Flipping is_comp_off_type without this is a bug.
 *
 * Scoped to is_comp_off_type rows so a company's ordinary leave types keep
 * whatever carry-forward policy HR set for them.
 */

export async function up(knex) {
  await knex.raw(`
    UPDATE leave_types
       SET carry_forward_allowed  = false,
           max_carry_forward_days = 0,
           updated_at             = NOW()
     WHERE is_comp_off_type = true
       AND deleted_at IS NULL
       AND carry_forward_allowed = true
  `);
}

export async function down(knex) {
  // Restores the shipped default for the seeded "Compensatory Off" type. The
  // conflict above comes back with it — this exists to make the migration
  // reversible, not because the previous state was correct.
  await knex.raw(`
    UPDATE leave_types
       SET carry_forward_allowed  = true,
           max_carry_forward_days = 5,
           updated_at             = NOW()
     WHERE is_comp_off_type = true
       AND deleted_at IS NULL
  `);
}
