// PATH: frontend/src/features/employees/displayValue.js
/**
 * One answer to "this field has no value" for the employee register.
 *
 * ── Why a helper, and why it tests for the STRING 'null' ────────────────────
 * The Manager column rendered the literal text `null` for three employees. The
 * guard in place was `emp.reporting_manager ? … : '—'`, which is correct for a
 * real SQL NULL — and useless here, because the column does not contain NULL.
 * It contains the four-character string "null", written by an older revision of
 * the Add Employee form that stringified a null manager before POSTing it.
 * `'null'` is truthy, so every falsy-check in the app waved it straight through
 * to the screen. Live rows affected on 2026-09-28: employee ids 6, 12 and 46.
 *
 * A truthiness test cannot catch this class of bug; only an explicit list of
 * the sentinel spellings can. `backend/src/shared/nullish.js` holds the same
 * list and scrubs these values on write, so the two work as belt and braces —
 * this one fixes what is already stored, that one stops more arriving.
 */

/** The one em-dash the employee register uses for "no value". */
export const EMPTY = '—';

/**
 * Spellings that mean "no value" but are not falsy. Lower-cased comparison.
 * 'n/a' and '-' are included because they are what a human types into a CSV
 * import to mean the same thing, and they should not become data either.
 */
const NULLISH_TEXT = new Set(['null', 'undefined', 'nan', 'n/a', 'na', '-', '--', EMPTY]);

/** True when a value carries no information, however it is spelled. */
export function isBlank(value) {
  if (value == null) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  const s = String(value).trim();
  if (!s) return true;
  return NULLISH_TEXT.has(s.toLowerCase());
}

/**
 * The value to render, or the fallback. Use this for EVERY employee field the
 * table prints — the default arm of a `switch` on column key included, which is
 * where `emp[col.key] || '—'` let 'null' through for any column added later.
 */
export function display(value, fallback = EMPTY) {
  return isBlank(value) ? fallback : value;
}

/** For a label a person reads as an absence rather than a dash. */
export const notAssigned = (value) => display(value, 'Not assigned');

export default { EMPTY, isBlank, display, notAssigned };
