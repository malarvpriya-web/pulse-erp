// Returns string label e.g. "2025-2026" — kept for backward compatibility
export function currentFY() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

// Returns { start: Date, end: Date } for the current India FY (April–March)
export function currentFYDates() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month >= 4) {
    return { start: new Date(year, 3, 1), end: new Date(year + 1, 2, 31) };
  } else {
    return { start: new Date(year - 1, 3, 1), end: new Date(year, 2, 31) };
  }
}

// Returns human label e.g. "FY 2025-26"
export function fyLabel() {
  const { start } = currentFYDates();
  const y = start.getFullYear();
  return `FY ${y}-${String(y + 1).slice(2)}`;
}

// April 1 of the given calendar year (start of that India FY)
export function indiaFYStart(year) {
  return new Date(year, 3, 1);
}

export function fyOptions() {
  const now = new Date();
  const base = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return [base - 2, base - 1, base, base + 1].map(y => ({
    value: `${y}-${y + 1}`,
    label: `FY ${y}-${String(y + 1).slice(2)}`,
  }));
}

// SQL fragments for backend use (PostgreSQL)
// FY start: DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '3 months'
// FY end:   DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '15 months' - INTERVAL '1 day'
