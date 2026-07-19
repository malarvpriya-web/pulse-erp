// Shared utilities for Commission Management and Pricing Engine pages.
// Keep in sync: extracted from co-located duplicates in those two files.

export function formatINR(val) {
  const n = parseFloat(val) || 0;
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000)   return `₹${(n / 100000).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

const BADGE_COLORS = {
  purple: { bg: '#f5f3ff', text: '#6B3FDB', border: '#e9e4ff' },
  blue:   { bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe' },
  green:  { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
  amber:  { bg: '#fffbeb', text: '#d97706', border: '#fde68a' },
  red:    { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' },
  grey:   { bg: '#f9fafb', text: '#6b7280', border: '#e5e7eb' },
};

export function Badge({ children, color }) {
  const c = BADGE_COLORS[color] || BADGE_COLORS.grey;
  return (
    <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}
