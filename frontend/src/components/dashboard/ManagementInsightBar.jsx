import React from 'react';
import './ManagementInsightBar.css';

const ManagementInsightBar = ({ data }) => {
  const insights = [
    {
      label: 'Revenue Today',
      value: data?.revenueToday || 240000,
      format: 'currency',
      icon: '💰',
      color: '#10b981'
    },
    {
      label: 'Invoices Due',
      value: data?.invoicesDue || 14,
      format: 'number',
      icon: '📄',
      color: '#f59e0b'
    },
    {
      label: 'Open Tickets',
      value: data?.openTickets || 6,
      format: 'number',
      icon: '🎫',
      color: '#3b82f6'
    },
    {
      label: 'Stock Alerts',
      value: data?.stockAlerts || 3,
      format: 'number',
      icon: '📦',
      color: '#ef4444'
    }
  ];

  const formatValue = (value, format) => {
    if (format === 'currency') {
      return `₹${(value / 100000).toFixed(1)}L`;
    }
    return value.toLocaleString();
  };

  return (
    <div className="management-insight-bar">
      {insights.map((insight, index) => (
        <div key={index} className="insight-card" style={{ borderLeftColor: insight.color }}>
          <div className="insight-icon">{insight.icon}</div>
          <div className="insight-content">
            <div className="insight-label">{insight.label}</div>
            <div className="insight-value" style={{ color: insight.color }}>
              {formatValue(insight.value, insight.format)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ManagementInsightBar;
