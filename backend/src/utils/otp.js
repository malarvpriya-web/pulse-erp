import crypto from 'crypto';

/**
 * Generate a numeric one-time code using a CSPRNG.
 *
 * Math.random() is NOT usable here: V8's xorshift128+ state is recoverable from
 * a handful of observed outputs, so an attacker who can trigger OTP generation
 * (e.g. request a code to their own address) can predict subsequent codes issued
 * to other recipients. crypto.randomInt() draws from the OS entropy pool.
 *
 * Range matches auth.service.js (100000-999999): no leading zeros, so callers
 * and frontends that coerce the code to a number don't silently shorten it.
 *
 * @param {number} [digits=6] - code length
 * @returns {string} numeric code with no leading zero, e.g. '481203'
 */
export function generateOtp(digits = 6) {
  if (!Number.isInteger(digits) || digits < 4 || digits > 10) {
    throw new RangeError(`generateOtp: digits must be an integer 4-10, got ${digits}`);
  }
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  return String(crypto.randomInt(min, max)); // randomInt is max-exclusive
}
