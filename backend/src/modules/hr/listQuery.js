/**
 * listQuery.js — the request-parsing helpers shared by hr/biometric.routes.js
 * and hr/gateAccess.routes.js. Moved here unchanged from biometric.routes.js
 * when gate passes and visitors got their own router (§272).
 */

/**
 * '' / null / undefined / whitespace → null. Forms post '' for every field the
 * user left alone, and '' bound to a timestamptz or int column is not NULL —
 * Postgres rejects it outright.
 */
export const blank = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : v);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ?page / ?page_size, clamped. Lists are paged for real (25 by default). */
export function listPage(query, { size = 25, max = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(max, Math.max(1, parseInt(query.page_size, 10) || size));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * ?from / ?to as validated 'YYYY-MM-DD' strings. Returns { error } for a
 * malformed or backwards range rather than letting Postgres 500 on the cast.
 */
export function dateRange(query) {
  const out = {};
  for (const k of ['from', 'to']) {
    const v = blank(query[k]);
    if (v === null) continue;
    const s = String(v);
    const d = new Date(`${s}T00:00:00Z`);
    if (!ISO_DATE.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      return { error: `${k} must be a date in YYYY-MM-DD format` };
    }
    out[k] = s;
  }
  if (out.from && out.to && out.from > out.to) return { error: 'from must be on or before to' };
  return out;
}

/** A positive integer, null when blank, NaN when present but not one. */
export const positiveIntOrNull = (v) => {
  const s = blank(v);
  if (s === null) return null;
  return /^\d+$/.test(String(s).trim()) && Number(s) >= 1 ? Number(s) : NaN;
};
