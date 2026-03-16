import React from 'react';
import './ExecutiveKPICards.css';

const ExecutiveKPICards = ({ data }) => {
  const kpis = [
    {
      title: 'Total Revenue',
      value: data?.revenue?.total || 4200000,
      trend: data?.revenue?.trend || 12,
      comparison: 'vs last month',
      format: 'currency'
    },
    {
      title: 'Active Projects',
      value: data?.projects?.active || 24,
      trend: data?.projects?.trend || 8,
      comparison: 'vs last month',
      format: 'number'
    },
    {
      title: 'Total Employees',
      value: data?.employees?.total || 150,
      trend: data?.employees?.trend || 3,
      comparison: 'vs last month',
      format: 'number'
    },
    {
      title: 'Pending Approvals',
      value: data?.approvals?.pending || 8,
      trend: data?.approvals?.trend || -15,
      comparison: 'vs last week',
      format: 'number'
    }
  ];

  const formatValue = (value, format) => {
    if (format === 'currency') {
      return `₹${(value / 1000000).toFixed(1)}M`;
    }
    return value.toLocaleString();
  };

  return (
    <div className="executive-kpi-cards">
      {kpis.map((kpi, index) => (
        <div key={index} className="executive-kpi-card">
          <div className="kpi-title">{kpi.title}</div>
          <div className="kpi-main-value">{formatValue(kpi.value, kpi.format)}</div>
          <div className="kpi-trend-row">
            <span className={`kpi-trend ${kpi.trend >= 0 ? 'positive' : 'negative'}`}>
              {kpi.trend >= 0 ? '▲' : '▼'} {Math.abs(kpi.trend)}%
            </span>
            <span className="kpi-comparison">{kpi.comparison}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ExecutiveKPICards;
