import React from 'react';
import './ManagementInsightBar.css';

const fmt = (value, format) => {
  const v = parseFloat(value) || 0;
  if (format === 'currency') {
    if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
    if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
    if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
    return `₹${v.toFixed(0)}`;
  }
  return v.toLocaleString();
};

const ManagementInsightBar = ({ data }) => {
  const insights = [
    {
      label: 'Revenue Today',
      value: data?.revenueToday || 0,
      format: 'currency',
      icon: '💰',
      color: '#10b981'
    },
    {
      label: 'Invoices Due',
      value: data?.invoicesDue || 0,
      format: 'number',
      icon: '📄',
      color: '#f59e0b'
    },
    {
      label: 'Open Tickets',
      value: data?.openTickets || 0,
      format: 'number',
      icon: '🎫',
      color: '#3b82f6'
    },
    {
      label: 'Stock Alerts',
      value: data?.stockAlerts || 0,
      format: 'number',
      icon: '📦',
      color: '#ef4444'
    }
  ];

  return (
    <div className="management-insight-bar">
      {insights.map((insight, index) => (
        <div key={index} className="insight-card" style={{ borderLeftColor: insight.color }}>
          <div className="insight-icon">{insight.icon}</div>
          <div className="insight-content">
            <div className="insight-label">{insight.label}</div>
            <div className="insight-value" style={{ color: insight.color }}>
              {fmt(insight.value, insight.format)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ManagementInsightBar;
