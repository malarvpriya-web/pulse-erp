const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Standard date formatter — DD Mon YY (e.g. 24 Jun 26).
 * Handles YYYY-MM-DD date-only strings (avoids UTC offset shift)
 * and full ISO timestamps.
 */
export const fmtDate = (d) => {
  if (!d) return '—';
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, day] = s.slice(0, 10).split('-').map(Number);
    return `${String(day).padStart(2, '0')} ${MONTHS[m - 1]} ${String(y).slice(-2)}`;
  }
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth()]} ${String(dt.getFullYear()).slice(-2)}`;
};

// formatDate is a legacy alias — kept for existing imports, now emits the
// canonical DD Mon YY format (e.g. 05 Apr 26) but returns "" for empty input.
export const formatDate = (date) => {
  if (!date) return "";
  const out = fmtDate(date);
  return out === '—' ? "" : out;
};

export const formatDateTime = (date) => {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";

  const datePart = fmtDate(date);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  return `${datePart} ${hours}:${minutes}`;
};

export const formatTime = (date) => {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  
  return `${hours}:${minutes}`;
};
