/**
 * Rating values on the 1–5 performance scale.
 *
 * Review ratings carry decimals (final_rating / manager_rating numeric(3,1),
 * calibrated_rating numeric(3,2)), and talent_assessments.performance_score is
 * numeric(3,2) so a synced rating keeps them (§209). PostgreSQL ROUNDS a value
 * with more decimals than the column holds, silently — so a write checks the
 * precision first and refuses, never rounds.
 *
 * Returns a message describing what is wrong with `value`, or null when it is
 * acceptable. `value` may be a number or a numeric string.
 */
export function ratingProblem(value, { label, decimals, min = 1, max = 5 }) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return `${label} must be a number from ${min} to ${max}`;
  const n = Number(text);
  if (n < min || n > max) return `${label} must be from ${min} to ${max}`;
  const places = (text.split('.')[1] || '').replace(/0+$/, '').length;
  if (places > decimals) {
    return decimals === 0
      ? `${label} must be a whole number`
      : `${label} can have at most ${decimals} decimal place${decimals === 1 ? '' : 's'}`;
  }
  return null;
}
