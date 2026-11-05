/**
 * initialPassword.js — the initial password of an account nobody chose.
 *
 * Every path that creates a login without a person typing its password uses
 * this: employee logins (Add Employee and the recruitment hire, via
 * createEmployeeLogin) and admin bulk user import (the Setup Wizard's Users
 * step). One implementation, so the paths cannot drift back apart.
 *
 * WHY
 *   Those paths used to issue a SHARED default ('Welcome@123', or
 *   DEFAULT_EMPLOYEE_PASSWORD) — every new account opened with the same,
 *   widely-known password, so anyone who knew the convention could sign in as
 *   someone who had just been added. Bulk import did not even set
 *   must_change_password, so those accounts were never forced off it.
 *
 * WHAT
 *   32 bytes from the OS CSPRNG, base64url: unique per account, hashed, then
 *   discarded. It is never returned, logged or stored in plain text, so it
 *   cannot be used to sign in. The person sets their own password through
 *   "Forgot password?" on the sign-in page (an e-mailed one-time code), and
 *   callers set must_change_password = true as a second line of defence.
 *
 *   43 characters is well inside bcrypt's 72-byte input limit, so the whole
 *   secret is hashed rather than silently truncated.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

/** A fresh random secret. Callers hash it; nobody should ever see it. */
export function unrevealedInitialPassword() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * The bcrypt hash of a fresh random secret — the only form a caller needs.
 * The plaintext never leaves this function.
 */
export function unrevealedInitialPasswordHash() {
  return bcrypt.hash(unrevealedInitialPassword(), 10);
}
