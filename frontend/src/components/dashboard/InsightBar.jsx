import React from 'react';
import './InsightBar.css';

const fmt = n => {
  const v = parseFloat(n) || 0;
  if (v >= 100_000) return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)   return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const InsightBar = ({ data }) => {
  const insights = [
    {
      label: 'Revenue Today',
      value: fmt(data?.revenueToday || 0),
      icon: '💰',
      color: '#6B3FDB',
      bg: '#f5f3ff',
      border: '#e9e4ff',
    },
    {
      label: 'Invoices Due',
      value: (data?.invoicesDue || 0).toLocaleString(),
      icon: '📄',
      color: '#f59e0b',
      bg: '#fffbeb',
      border: '#fde68a',
    },
    {
      label: 'Open Tickets',
      value: (data?.openTickets || 0).toLocaleString(),
      icon: '🎫',
      color: '#3b82f6',
      bg: '#eff6ff',
      border: '#bfdbfe',
    },
    {
      label: 'Stock Alerts',
      value: (data?.stockAlerts || 0).toLocaleString(),
      icon: '📦',
      color: '#ef4444',
      bg: '#fef2f2',
      border: '#fecaca',
    },
  ];

  return (
    <div className="insight-bar">
      {insights.map((item, i) => (
        <div
          key={i}
          className="insight-card"
          style={{ background: item.bg, border: `1px solid ${item.border}` }}
        >
          <span className="insight-icon">{item.icon}</span>
          <div className="insight-content">
            <div className="insight-label">{item.label}</div>
            <div className="insight-value" style={{ color: item.color }}>{item.value}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default InsightBar;
