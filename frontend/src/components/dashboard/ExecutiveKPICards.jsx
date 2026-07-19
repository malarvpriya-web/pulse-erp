import React from 'react';
import './ExecutiveKPICards.css';

const fmt = (value, format) => {
  if (format === 'currency') {
    const v = parseFloat(value) || 0;
    if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
    if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
    if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
    return `₹${v.toFixed(0)}`;
  }
  return (value || 0).toLocaleString();
};

const ExecutiveKPICards = ({ data }) => {
  const kpis = [
    {
      title: 'Total Revenue',
      value: data?.revenue?.total || 0,
      trend: data?.revenue?.trend || 0,
      comparison: 'vs last month',
      format: 'currency'
    },
    {
      title: 'Active Projects',
      value: data?.projects?.active || 0,
      trend: data?.projects?.trend || 0,
      comparison: 'vs last month',
      format: 'number'
    },
    {
      title: 'Total Employees',
      value: data?.employees?.total || 0,
      trend: data?.employees?.trend || 0,
      comparison: 'vs last month',
      format: 'number'
    },
    {
      title: 'Pending Approvals',
      value: data?.approvals?.pending || 0,
      trend: data?.approvals?.trend || 0,
      comparison: 'vs last week',
      format: 'number'
    }
  ];

  return (
    <div className="executive-kpi-cards">
      {kpis.map((kpi, index) => (
        <div key={index} className="executive-kpi-card">
          <div className="kpi-title">{kpi.title}</div>
          <div className="kpi-main-value">{fmt(kpi.value, kpi.format)}</div>
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
