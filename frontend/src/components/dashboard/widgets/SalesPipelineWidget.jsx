import React from 'react';

const OPEN_STAGES = new Set(['prospecting', 'qualification', 'proposal', 'negotiation']);

function deriveMetrics(data) {
  // Backend returns { stages: [{stage, count, value}] }; DashboardEngine stores the array directly.
  const stages = data?.stages || (Array.isArray(data) ? data : null);

  if (stages) {
    const wonRow  = stages.find(s => s.stage === 'closed_won')  || {};
    const lostRow = stages.find(s => s.stage === 'closed_lost') || {};
    const won   = wonRow.count  || 0;
    const lost  = lostRow.count || 0;
    const open  = stages.filter(s => OPEN_STAGES.has(s.stage)).reduce((acc, s) => acc + (s.count || 0), 0);
    const rate  = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : 0;
    return { openDeals: open, wonDeals: won, lostDeals: lost, winRate: rate };
  }

  // Legacy flat-object shape from older callers
  return {
    openDeals: data?.openDeals  ?? 0,
    wonDeals:  data?.wonDeals   ?? 0,
    lostDeals: data?.lostDeals  ?? 0,
    winRate:   data?.winRate    ?? 0,
  };
}

const SalesPipelineWidget = ({ title = 'Sales Pipeline', data }) => {
  if (!data) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No data available</div>
      </>
    );
  }

  const { openDeals, wonDeals, lostDeals, winRate } = deriveMetrics(data);

  return (
    <>
      <h3 className="widget-title">{title}</h3>
      <div className="widget-data">
        <div className="kpi-row">
          <div className="kpi-card">
            <span className="kpi-label">Open Deals</span>
            <span className="kpi-value">{openDeals}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Won This Month</span>
            <span className="kpi-value positive">{wonDeals}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Lost This Month</span>
            <span className="kpi-value negative">{lostDeals}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Win Rate</span>
            <span className="kpi-value">{winRate}%</span>
          </div>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${winRate}%` }}></div>
        </div>
        <p className="progress-label">Pipeline Health: {winRate}%</p>
      </div>
    </>
  );
};

export default SalesPipelineWidget;
