// Shared helpers for the Finance module — imported by all finance pages.

// ── Formatters ────────────────────────────────────────────────────────────────

/** Abbreviated: 84000 → ₹84K, 150000 → ₹1.5L, 15000000 → ₹1.50Cr */
export const fmt = (n) => {
  if (!n && n !== 0) return '₹0';
  const num = parseFloat(n);
  if (num >= 10000000) return `₹${(num / 10000000).toFixed(2)}Cr`;
  if (num >= 100000)   return `₹${(num / 100000).toFixed(1)}L`;
  if (num >= 1000)     return `₹${(num / 1000).toFixed(0)}K`;
  return `₹${num.toFixed(0)}`;
};

/** Full with 2 decimal places: ₹1,23,456.00 */
export const fmtFull = (n) =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Full with 0 decimal places, no ₹ prefix — for inline use: 1,23,456 */
export const fmtN = (n) =>
  parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

// ── Date helpers ──────────────────────────────────────────────────────────────

export const today = () => new Date().toISOString().split('T')[0];

export const addDays = (d, n) =>
  new Date(new Date(d).getTime() + n * 86400000).toISOString().split('T')[0];

// ── Invoice / Bill line-item helpers ─────────────────────────────────────────

export const GST_RATES = [0, 5, 12, 18, 28];

export const emptyItem = () => ({
  description: '', quantity: 1, unit_price: 0, gst_rate: 18, amount: 0,
});

export const calcItem = (item) => {
  const base = (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
  const gst  = base * (parseFloat(item.gst_rate) || 0) / 100;
  return { ...item, tax_rate: item.gst_rate, taxable_amount: base, gst_amount: gst, amount: base + gst };
};

// ── Status badge colour (returns { bg, color } style object) ─────────────────

export const statusColor = (s) => {
  const m = (s || '').toLowerCase();
  if (m === 'paid')                    return { bg: '#dcfce7', color: '#16a34a' };
  if (m === 'overdue')                 return { bg: '#fee2e2', color: '#dc2626' };
  if (m === 'approved')                return { bg: '#dbeafe', color: '#1d4ed8' };
  if (m === 'pending' || m === 'sent') return { bg: '#fef3c7', color: '#92400e' };
  if (m === 'draft')                   return { bg: '#f3f4f6', color: '#6b7280' };
  if (m === 'rejected')                return { bg: '#fee2e2', color: '#dc2626' };
  return { bg: '#f3f4f6', color: '#6b7280' };
};
