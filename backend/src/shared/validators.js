/**
 * Shared field validators.
 *
 * Indian mobile numbers are 10 digits starting 6-9. Input is normalized first
 * so the common human formats ("+91 98123 45678", "098123-45678") validate
 * instead of being rejected for punctuation.
 */

/** Strip punctuation and the +91 / 0 trunk prefixes. Returns digits only. */
export function normalizeIndianMobile(value) {
  if (value == null) return '';
  let d = String(value).replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);   // +91XXXXXXXXXX
  if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);   // 0XXXXXXXXXX
  return d;
}

export function isIndianMobile(value) {
  return /^[6-9][0-9]{9}$/.test(normalizeIndianMobile(value));
}

/**
 * Validate an optional mobile field.
 * @returns {{ ok: true, value: string|null } | { ok: false, error: string }}
 */
export function validateOptionalMobile(value) {
  if (value == null || String(value).trim() === '') return { ok: true, value: null };
  if (!isIndianMobile(value)) {
    return { ok: false, error: 'Mobile must be a 10-digit Indian number starting with 6-9.' };
  }
  return { ok: true, value: normalizeIndianMobile(value) };
}
