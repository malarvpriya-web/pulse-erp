/**
 * nullish — stop the STRING "null" from becoming data.
 *
 * `employees.reporting_manager` holds the literal text 'null' for three live
 * rows (ids 6, 12, 46). It got there because a caller serialised a null value
 * into a string before POSTing it, and nothing on the way in looked at the
 * content of the string — a VARCHAR accepts 'null' exactly as happily as it
 * accepts 'Malar Natesh'. Downstream, every `value ? value : '—'` guard in the
 * frontend passed it through, because 'null' is truthy, and the Manager column
 * rendered the word `null` to HR.
 *
 * The frontend mirror is `frontend/src/features/employees/displayValue.js`,
 * which handles the rows that already exist. This module handles every new
 * write, so the set of affected rows cannot grow.
 *
 * Applied at the service boundary, not in the SQL: a normaliser the database
 * enforces would also rewrite legitimate values in bulk migrations, and the
 * point is to reject nonsense at the door, not to silently rewrite history.
 */

/**
 * Spellings that mean "no value" but survive a truthiness test.
 * Compared case-insensitively after trimming.
 */
const NULLISH_TEXT = new Set(['null', 'undefined', 'nan', '—']);

/** True when a submitted value is a sentinel rather than real content. */
export function isNullishText(value) {
  if (typeof value !== 'string') return false;
  return NULLISH_TEXT.has(value.trim().toLowerCase());
}

/** `'null'` / `'undefined'` / `''` → null; everything else trimmed and kept. */
export function cleanText(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s || isNullishText(s)) return null;
  return s;
}

/**
 * Normalise every string field on an inbound payload.
 *
 * Returns a new object — mutating the caller's `req.body` would make the audit
 * log's `newData` disagree with what was actually submitted.
 */
export function cleanPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' ? cleanText(v) : v;
  }
  return out;
}

export default { isNullishText, cleanText, cleanPayload };
