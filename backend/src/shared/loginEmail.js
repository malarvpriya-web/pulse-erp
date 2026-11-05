/**
 * Login email — ONE normal form for every account write and every lookup.
 *
 * A login email is compared case-insensitively and without surrounding
 * whitespace. Every write stores `normalizeLoginEmail(x)`; every lookup compares
 * `LOGIN_EMAIL_KEY = $n` with a normalised parameter, which is also the exact
 * expression the unique indexes are built on (migration 20261012000002), so the
 * lookup is index-backed and the uniqueness rule and the lookup rule cannot
 * disagree.
 *
 * Existing rows may still hold mixed case (the migration did not rewrite them);
 * comparing the expression rather than the column is what keeps them working.
 *
 * Company email (employees.company_email) is NOT a login and does not use this.
 */

/** 'Asha@Acme.IN ' → 'asha@acme.in'; blank / non-string → null. */
export function normalizeLoginEmail(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return s || null;
}

/** The indexed comparison key. Use as `WHERE ${LOGIN_EMAIL_KEY} = $1`. */
export const LOGIN_EMAIL_KEY = 'LOWER(BTRIM(email))';

/** True for the Postgres unique violation raised by either login-email index. */
export function isLoginEmailConflict(err) {
  return err?.code === '23505'
    && /users_email|customer_portal_users_company_email|ux_portal_users_email/.test(String(err.constraint || err.detail || err.message || ''));
}
