const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Standard date formatter — DD Mon YY (e.g. 24 Jun 26). The app-wide standard;
 * date + time is "24 Jun 26, 14:30" (formatDateTime).
 *
 * A bare date ('YYYY-MM-DD', a DATE column) is formatted as written, with no
 * timezone shift. Anything with a time part is a moment and is shown in the
 * viewer's local time.
 *
 * ⚠ This used to take the first ten characters of ANY string that began with a
 * date, which for an ISO timestamp is the UTC date: a punch, check-in or
 * approval at 01:30 IST ('…T20:00:00Z' the evening before) read as the previous
 * day everywhere this formatter is used. §198.
 */
export const fmtDate = (d) => {
  if (!d) return '—';
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, day] = s.split('-').map(Number);
    return `${pad2(day)} ${MONTHS[m - 1]} ${String(y).slice(-2)}`;
  }
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return `${pad2(dt.getDate())} ${MONTHS[dt.getMonth()]} ${String(dt.getFullYear()).slice(-2)}`;
};

// formatDate is a legacy alias — kept for existing imports, now emits the
// canonical DD Mon YY format (e.g. 05 Apr 26) but returns "" for empty input.
export const formatDate = (date) => {
  if (!date) return "";
  const out = fmtDate(date);
  return out === '—' ? "" : out;
};

/** DD Mon YY, HH:mm in local time — the standard date + time form. */
export const formatDateTime = (date) => {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return `${fmtDate(d)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export const formatTime = (date) => {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * Today (or today ± offsetDays) as a local 'YYYY-MM-DD', for date inputs and
 * date filters. `new Date().toISOString().slice(0, 10)` is the UTC date, a day
 * behind IST between 00:00 and 05:30.
 */
export const localDay = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return localDayOf(d);
};

/**
 * A Date's LOCAL calendar day as 'YYYY-MM-DD'. Use this, not
 * `d.toISOString().slice(0, 10)`, for a date built from local parts: local
 * midnight in IST is 18:30 UTC the day before, so toISOString() names the
 * previous day.
 */
export const localDayOf = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
