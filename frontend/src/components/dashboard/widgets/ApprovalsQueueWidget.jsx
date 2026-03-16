import React from 'react';

const ApprovalsQueueWidget = ({ title = 'Pending Approvals', data }) => {
  if (!data || !data.items || data.items.length === 0) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No pending approvals</div>
      </>
    );
  }

  return (
    <>
      <h3 className="widget-title">{title} ({data.items.length})</h3>
      <div className="widget-scroll">
        {data.items.map((item, index) => (
          <div key={index} className="activity-item">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, color: '#1f2937', fontSize: '12px' }}>{item.type}</div>
              <div style={{ fontSize: '11px', color: '#6b7280' }}>{item.requester}</div>
            </div>
            <div className="activity-time">{item.date}</div>
          </div>
        ))}
      </div>
    </>
  );
};

export default ApprovalsQueueWidget;
