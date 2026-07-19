import React from 'react';
import { IndianRupee, Briefcase, Users, Clock } from 'lucide-react';
import './KPISummary.css';

const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const KPISummary = ({ data }) => {
  const kpis = [
    {
      icon: IndianRupee,
      title: 'Total Revenue',
      value: fmt(data?.revenue?.total || 0),
      trend: data?.revenue?.trend || 0,
      sub: 'vs last month',
      gradient: 'linear-gradient(135deg, #6B3FDB 0%, #8B5CF6 100%)',
    },
    {
      icon: Briefcase,
      title: 'Active Projects',
      value: (data?.projects?.active || 0).toLocaleString(),
      trend: data?.projects?.trend || 0,
      sub: 'vs last month',
      gradient: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
    },
    {
      icon: Users,
      title: 'Total Employees',
      value: (data?.employees?.total || 0).toLocaleString(),
      trend: data?.employees?.trend || 0,
      sub: 'vs last month',
      gradient: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
    },
    {
      icon: Clock,
      title: 'Pending Approvals',
      value: (data?.approvals?.pending || 0).toLocaleString(),
      trend: data?.approvals?.trend || 0,
      sub: 'vs last week',
      gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
    },
  ];

  return (
    <div className="kpi-summary">
      {kpis.map((kpi, i) => (
        <div key={i} className="kpi-summary-card" style={{ background: kpi.gradient }}>
          <div className="kpi-summary-top">
            <div className="kpi-summary-icon-wrap">
              <kpi.icon size={17} color="#fff" />
            </div>
            <span className="kpi-summary-title">{kpi.title}</span>
          </div>
          <div className="kpi-summary-value">{kpi.value}</div>
          <div className="kpi-summary-trend">
            <span className={`kpi-trend-pill ${kpi.trend >= 0 ? 'up' : 'dn'}`}>
              {kpi.trend >= 0 ? '▲' : '▼'} {Math.abs(kpi.trend)}%
            </span>
            <span className="kpi-trend-label">{kpi.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default KPISummary;
