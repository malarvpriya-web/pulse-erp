// Shared pieces for HR → Biometric & Access Control (pages/BiometricAccess.jsx).
// See MODULE_FEATURE_CONNECTION_MANUAL.md §197.

import { fmtDate, formatDateTime, localDay } from '@/utils/dateFormatter';

// Dates use the app standard from utils/dateFormatter (05 Apr 26 / 05 Apr 26, 14:30),
// which now reads timestamps in local time (§198). These names stay so the tabs read
// the same; they are the shared formatter, not a second copy of it.
export const fmtStamp = (value, { time = true } = {}) =>
  (value ? (time ? formatDateTime(value) : fmtDate(value)) || '—' : '—');
export const fmtDay = (s) => fmtDate(s);
export { localDay };

export function relativeTime(iso) {
  if (!iso) return null;
  const diff = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diff < 2) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

/** The server's message for a failed request, never a bare "Failed". */
export const errText = (err, fallback) =>
  err?.response?.data?.message || err?.response?.data?.error || err?.message || fallback;

/** Same rule as the server's validateVisitor: 10–15 digits, + only leading. */
export function phoneProblem(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '').length;
  if (!/^\+?[0-9][0-9\s\-()]*$/.test(s) || digits < 10 || digits > 15) {
    return 'Enter a valid contact number (10–15 digits).';
  }
  return null;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Print one record in its own window. The Gate Pass "Print" button called
 * `window.print()`, which printed the whole page — every row, the tabs and the
 * sidebar — rather than the pass that was clicked.
 * Returns false when the browser blocked the window.
 */
export function printDocument(title, bodyHtml) {
  const w = window.open('', '_blank', 'width=720,height=640');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;margin:32px}
  .card{border:2px solid #6B3FDB;border-radius:12px;padding:24px;max-width:560px}
  h1{margin:0 0 4px;font-size:20px;color:#4c1d95}
  .sub{color:#6b7280;font-size:13px;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;font-size:14px}
  td{padding:6px 0;vertical-align:top}
  td:first-child{color:#6b7280;width:38%}
  .stamp{display:inline-block;margin-top:16px;padding:4px 12px;border-radius:999px;font-weight:700;font-size:13px}
  .ok{background:#dcfce7;color:#166534}.bad{background:#fee2e2;color:#991b1b}
  .sign{margin-top:40px;display:flex;justify-content:space-between;font-size:12px;color:#6b7280}
  @media print{body{margin:12mm}}
</style></head><body>${bodyHtml}<script>window.onload=function(){window.focus();window.print();}${'<'}/script></body></html>`);
  w.document.close();
  return true;
}

// ── shared styles, the page's existing look ─────────────────────────────────
export const S = {
  input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, background: '#fff' },
  label: { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 },
  th: { padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, whiteSpace: 'nowrap' },
  td: { padding: '8px 12px' },
  primary: { background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  secondary: { background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  small: (bg, fg = '#fff') => ({ background: bg, color: fg, border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 11, marginRight: 4, whiteSpace: 'nowrap' }),
  pill: (fg) => ({ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: `${fg}20`, color: fg, whiteSpace: 'nowrap' }),
  filterBar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginBottom: 12, padding: 12, background: '#faf8ff', border: '1px solid #f0ebff', borderRadius: 10 },
};
