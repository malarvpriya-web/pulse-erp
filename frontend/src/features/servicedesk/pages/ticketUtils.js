export const priorityColor = p => {
  const m = (p || '').toLowerCase();
  if (m === 'critical') return { bg: '#fef2f2', color: '#7f1d1d' };
  if (m === 'high')     return { bg: '#fee2e2', color: '#dc2626' };
  if (m === 'medium')   return { bg: '#fef3c7', color: '#92400e' };
  return { bg: '#f0fdf4', color: '#15803d' };
};

export const statusColor = s => {
  const m = (s || '').toLowerCase();
  if (m === 'open')        return { bg: '#eef2ff', color: '#4338ca' };
  if (m === 'in progress') return { bg: '#fef3c7', color: '#92400e' };
  if (m === 'resolved')    return { bg: '#f0fdf4', color: '#15803d' };
  if (m === 'pending')     return { bg: '#eff6ff', color: '#1d4ed8' };
  return { bg: '#f3f4f6', color: '#6b7280' };
};
