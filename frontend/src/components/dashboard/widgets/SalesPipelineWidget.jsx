import React from 'react';

const SalesPipelineWidget = ({ title = 'Sales Pipeline', data }) => {
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
        <div className="kpi-row">
          <div className="kpi-card">
            <span className="kpi-label">Open Deals</span>
            <span className="kpi-value">{data?.openDeals || 24}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Won This Month</span>
            <span className="kpi-value positive">{data?.wonDeals || 8}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Lost This Month</span>
            <span className="kpi-value negative">{data?.lostDeals || 2}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Win Rate</span>
            <span className="kpi-value">{data?.winRate || 80}%</span>
          </div>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${data?.winRate || 80}%` }}></div>
        </div>
        <p className="progress-label">Pipeline Health: {data?.winRate || 80}%</p>
      </div>
    </>
  );
};

export default SalesPipelineWidget;
