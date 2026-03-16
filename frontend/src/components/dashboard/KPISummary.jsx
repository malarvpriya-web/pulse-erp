import React from 'react';
import './KPISummary.css';

const KPISummary = ({ data }) => {
  const kpis = [
    {
      title: 'Total Revenue',
      value: data?.revenue?.total || 450000,
      trend: data?.revenue?.trend || 8,
      comparison: 'vs last month',
      format: 'currency'
    },
    {
      title: 'Active Projects',
      value: data?.projects?.active || 24,
      trend: data?.projects?.trend || 12,
      comparison: 'vs last month',
      format: 'number'
    },
    {
      title: 'Employees',
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
      return `$${(value / 1000).toFixed(0)}K`;
    }
    return value.toLocaleString();
  };

  return (
    <div className="kpi-summary">
      {kpis.map((kpi, index) => (
        <div key={index} className="kpi-summary-card">
          <div className="kpi-summary-title">{kpi.title}</div>
          <div className="kpi-summary-value">{formatValue(kpi.value, kpi.format)}</div>
          <div className="kpi-summary-trend">
            <span className={`trend-indicator ${kpi.trend >= 0 ? 'positive' : 'negative'}`}>
              {kpi.trend >= 0 ? '▲' : '▼'} {Math.abs(kpi.trend)}%
            </span>
            <span className="trend-comparison">{kpi.comparison}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default KPISummary;
