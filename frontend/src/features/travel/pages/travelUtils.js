export const STATUS_COLOR = {
  Pending:   { bg:'#fef3c7', color:'#92400e' },
  Approved:  { bg:'#d1fae5', color:'#065f46' },
  Rejected:  { bg:'#fee2e2', color:'#991b1b' },
  Completed: { bg:'#ede9fe', color:'#5b21b6' },
  Settled:   { bg:'#ede9fe', color:'#5b21b6' },
  Draft:     { bg:'#f3f4f6', color:'#374151' },
  Submitted: { bg:'#dbeafe', color:'#1e40af' },
  Paid:      { bg:'#ede9fe', color:'#5b21b6' },
  'Pending Finance':   { bg:'#fef3c7', color:'#92400e' },
  'Pending Manager':   { bg:'#dbeafe', color:'#1e40af' },
  'Finance Rejected':  { bg:'#fee2e2', color:'#991b1b' },
  Disbursed:           { bg:'#d1fae5', color:'#065f46' },
  'Partially Settled': { bg:'#e0e7ff', color:'#3730a3' },
};

// Lakh-abbreviated rupees. Sign is pulled out first so negatives render as
// "-₹2.0L" rather than "₹-2,00,000" — a large negative used to miss the lakh
// branch entirely and format inconsistently with its positive counterpart.
// Postgres returns NUMERIC as a string, so coerce before comparing.
export const fmt = (n) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '₹0';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  return abs >= 100000
    ? `${sign}₹${(abs / 100000).toFixed(1)}L`
    : `${sign}₹${abs.toLocaleString('en-IN')}`;
};
