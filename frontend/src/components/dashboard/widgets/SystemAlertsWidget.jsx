import React from 'react';

const SystemAlertsWidget = ({ title = 'System Alerts', data }) => {
  if (!data || !data.alerts || data.alerts.length === 0) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No alerts</div>
      </>
    );
  }

  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'critical': return '#ef4444';
      case 'warning': return '#f59e0b';
      case 'info': return '#3b82f6';
      default: return '#6b7280';
    }
  };

  return (
    <>
      <h3 className="widget-title">{title} ({data.alerts.length})</h3>
      <div className="widget-scroll">
        {data.alerts.map((alert, index) => (
          <div key={index} className="activity-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
              <div 
                style={{ 
                  width: '6px', 
                  height: '6px', 
                  borderRadius: '50%', 
                  background: getSeverityColor(alert.severity),
                  flexShrink: 0
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#1f2937', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {alert.message}
                </div>
                <div style={{ fontSize: '10px', color: '#6b7280' }}>{alert.module}</div>
              </div>
            </div>
            <div className="activity-time">{alert.time}</div>
          </div>
        ))}
      </div>
    </>
  );
};

export default SystemAlertsWidget;
