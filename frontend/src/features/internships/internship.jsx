/**
 * Display helpers for the Internships module.
 *
 * The vocabularies themselves (statuses, stipend frequencies, document types)
 * are NOT copied here — pages read them from GET /interns/meta, so the form and
 * the API cannot drift. This file only says how to SHOW things.
 */

/** Inclusive day count, the same arithmetic as the generated duration_days. */
export function inclusiveDays(start, end) {
  if (!start || !end) return null;
  const toUtc = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const days = Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1;
  return Number.isFinite(days) ? days : null;
}

/**
 * "15 days", "1 month", "6 months", "2 months 10 days".
 *
 * Calendar months, not days/30: 1 Jan – 30 Jun reads "6 months", which is what
 * HR wrote on the offer letter, where 181/30 would say "6 months 1 day".
 */
export function formatDuration(start, end) {
  const days = inclusiveDays(start, end);
  if (days == null || days < 1) return '—';
  if (days < 28) return `${days} day${days === 1 ? '' : 's'}`;
  const [sy, sm, sd] = String(start).slice(0, 10).split('-').map(Number);
  // The day after the end date: a span ending on the last day of a month is a
  // whole number of months.
  const after = new Date(Date.UTC(...String(end).slice(0, 10).split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))));
  after.setUTCDate(after.getUTCDate() + 1);
  let months = (after.getUTCFullYear() - sy) * 12 + (after.getUTCMonth() - (sm - 1));
  let anchor = new Date(Date.UTC(sy, sm - 1 + months, sd));
  if (anchor > after) { months -= 1; anchor = new Date(Date.UTC(sy, sm - 1 + months, sd)); }
  const rem = Math.round((after - anchor) / 86400000);
  const m = months > 0 ? `${months} month${months === 1 ? '' : 's'}` : '';
  const d = rem > 0 ? `${rem} day${rem === 1 ? '' : 's'}` : '';
  return [m, d].filter(Boolean).join(' ') || `${days} days`;
}

/** "6 months (181 days)"; just "26 days" when the wording already is the day count. */
export function durationLabel(start, end) {
  const words = formatDuration(start, end);
  const days = inclusiveDays(start, end);
  if (days == null || days < 1 || /^\d+ days?$/.test(words)) return words;
  return `${words} (${days} days)`;
}

export const STATUS_STYLE = {
  Applied:    { bg: '#f3f4f6', color: '#374151' },
  Selected:   { bg: '#ede9fe', color: '#5b21b6' },
  Onboarding: { bg: '#e0f2fe', color: '#075985' },
  Active:     { bg: '#dcfce7', color: '#166534' },
  Completed:  { bg: '#f0fdf4', color: '#15803d' },
  Cancelled:  { bg: '#f3f4f6', color: '#6b7280' },
  Terminated: { bg: '#fee2e2', color: '#991b1b' },
};

export function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.Applied;
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {status || '—'}
    </span>
  );
}

/**
 * Completion stage (derived by the API — COMPLETION_STAGE_SQL):
 * Active → Evaluation Requested → Evaluation Received → Completed → Certificate Issued,
 * or Evaluation Pending when the end date has passed with no evaluation in.
 */
export const STAGE_STYLE = {
  Active:                 { bg: '#dcfce7', color: '#166534' },
  'Evaluation Requested': { bg: '#e0f2fe', color: '#075985' },
  'Evaluation Received':  { bg: '#ede9fe', color: '#5b21b6' },
  'Evaluation Pending':   { bg: '#fef3c7', color: '#92400e' },
  Completed:              { bg: '#f0fdf4', color: '#15803d' },
  'Certificate Issued':   { bg: '#dbeafe', color: '#1e3a8a' },
};

export function StageBadge({ stage }) {
  if (!stage) return <span className="iv-muted">—</span>;
  const s = STAGE_STYLE[stage] || STATUS_STYLE[stage] || STATUS_STYLE.Applied;
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {stage}
    </span>
  );
}

/**
 * Open a PDF the API renders (certificate preview, evaluation letter) in a new
 * tab. Fetched with the JWT as a blob — these routes are authenticated, so a
 * plain link would 401. Returns an error message, or '' on success.
 */
export async function openApiPdf(api, url) {
  const win = window.open('', '_blank');
  try {
    const { data } = await api.get(url, { responseType: 'blob' });
    const href = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    if (win) win.location.href = href; else window.location.assign(href);
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    return '';
  } catch (e) {
    if (win) win.close();
    let msg = e?.message || 'Could not open the document.';
    const body = e?.response?.data;
    if (body instanceof Blob) { try { msg = JSON.parse(await body.text()).error || msg; } catch { /* not JSON */ } }
    return msg;
  }
}

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const money = (v) => (v == null || v === '' ? '—' : INR.format(Number(v)));

/** "₹10,000 / month", "Unpaid", "—" */
export function stipendLabel(amount, frequency) {
  if (frequency === 'Unpaid') return 'Unpaid';
  if (amount == null || amount === '') return '—';
  const per = { Monthly: ' / month', Weekly: ' / week', 'One-time': ' one-time' }[frequency] || '';
  return `${money(amount)}${per}`;
}

export const fmtDate = (d) => (d
  ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—');

export const fullName = (r) => [r?.first_name, r?.last_name].filter(Boolean).join(' ').trim();
