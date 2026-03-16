import React from 'react';

const OperationsWidget = ({ title = 'Operations', data }) => {
  if (!data) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No data available</div>
      </>
    );
  }

  const metrics = [
    { label: 'Active Projects', value: data.activeProjects || 0, icon: '📁' },
    { label: 'Overdue Tasks', value: data.overdueTasks || 0, icon: '⚠️' },
    { label: 'Low Stock Alerts', value: data.lowStockAlerts || 0, icon: '📦' }
  ];

  return (
    <>
      <h3 className="widget-title">{title}</h3>
      <div className="widget-data">
        <div style={{ display: 'grid', gap: '12px' }}>
          {metrics.map((metric, index) => (
            <div key={index} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              background: '#f9fafb',
              borderRadius: '8px',
              border: '1px solid #e5e7eb'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>{metric.icon}</span>
                <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: 500 }}>{metric.label}</span>
              </div>
              <span style={{ fontSize: '18px', fontWeight: 600, color: '#1f2937' }}>{metric.value}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export default OperationsWidget;
