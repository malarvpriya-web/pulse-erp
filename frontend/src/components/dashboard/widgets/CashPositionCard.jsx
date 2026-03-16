import React from 'react';

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
          <div style={{ fontSize: '22px', fontWeight: 700, color: '#1f2937' }}>₹{data?.balance?.toLocaleString() || '250,000'}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>Inflow</div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#10b981' }}>₹{data?.inflow?.toLocaleString() || '12,000'}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>Outflow</div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#ef4444' }}>₹{data?.outflow?.toLocaleString() || '8,500'}</div>
          </div>
        </div>
      </div>
    </>
  );
};

export default CashPositionCard;
