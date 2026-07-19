// Shared currency / number formatters — import { fmtL, fmt, fmtPct, fmtDays, fmtRatio, currentFY } from '@/utils/format'

export const fmtL = (n) => {
  const v = parseFloat(n ?? 0);
  if (isNaN(v)) return '—';
  if (Math.abs(v) >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)}Cr`;
  if (Math.abs(v) >= 100_000)    return `₹${(v / 100_000).toFixed(2)}L`;
  if (Math.abs(v) >= 1_000)      return `₹${(v / 1_000).toFixed(1)}K`;
  return `₹${v.toFixed(0)}`;
};

// Full rupee amount with Indian comma notation (no abbreviation)
export const fmt = (v) => `₹${Number(v ?? 0).toLocaleString('en-IN')}`;

export const fmtPct = (v) =>
  v != null && isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : 'N/A';

export const fmtDays = (v) => v != null ? `${v}d` : 'N/A';

export const fmtRatio = (v, suffix = 'x') =>
  v != null && isFinite(Number(v)) ? `${Number(v).toFixed(2)}${suffix}` : 'N/A';

export const fmtNum = (n, decimals = 0) => {
  const v = parseFloat(n);
  if (isNaN(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

// India financial year (April–March) — returns { start, end, label }
export const currentFY = () => {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const fy    = month >= 4 ? year : year - 1;
  return {
    start: `${fy}-04-01`,
    end:   `${fy + 1}-03-31`,
    label: `FY ${fy}-${String(fy + 1).slice(-2)}`,
  };
};
