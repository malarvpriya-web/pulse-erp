import React from 'react';

const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const CashPositionCard = ({ title = 'Cash Position', data }) => {
  if (!data) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No data available</div>
      </>
    );
  }

  return (
    <>
      <h3 className="widget-title">{title}</h3>
      <div className="widget-data">
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', color: '#6b7280', fontWeight: 500, marginBottom: '6px' }}>Cash Balance</div>
          <div style={{ fontSize: '22px', fontWeight: 700, color: '#1f2937' }}>{fmt(data.balance || 0)}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>Inflow</div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#10b981' }}>{fmt(data.inflow || 0)}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>Outflow</div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#ef4444' }}>{fmt(data.outflow || 0)}</div>
          </div>
        </div>
      </div>
    </>
  );
};

export default CashPositionCard;
