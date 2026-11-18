/**
 * idMask.js — visitor ID numbers are stored MASKED (§272): the last 4 letters
 * or digits stay, everything else becomes X. The full number is never written.
 * Migration 20261112000003 carries its own frozen copy of this rule.
 */
export function maskIdNumber(value) {
  if (value == null) return null;
  const s = String(value).replace(/[\s-]/g, '').toUpperCase();
  if (!s) return null;
  if (/^X+[A-Z0-9]{0,4}$/.test(s)) return s;            // already masked
  const keep = Math.min(4, Math.max(0, s.length - 2));
  return 'X'.repeat(s.length - keep) + s.slice(s.length - keep);
}
