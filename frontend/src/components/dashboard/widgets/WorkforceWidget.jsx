import React from 'react';

const WorkforceWidget = ({ title = 'Workforce Metrics', data }) => {
  if (!data) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No data available</div>
      </>
    );
  }

  const metrics = [
    { label: 'New Hires', value: data.newHires || 0, icon: '👥' },
    { label: 'Attrition', value: data.attrition || 0, icon: '📉' },
    { label: 'Attendance Rate', value: `${data.attendanceRate || 0}%`, icon: '✓' }
  ];

  return (
    <>
      <h3 className="widget-title">{title}</h3>
      <div className="widget-data">
        <div style={{ display: 'grid', gap: '16px' }}>
          {metrics.map((metric, index) => (
            <div key={index} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              background: '#f9fafb',
              borderRadius: '8px',
              border: '1px solid #e5e7eb'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '20px' }}>{metric.icon}</span>
                <span style={{ fontSize: '14px', color: '#6b7280', fontWeight: 500 }}>{metric.label}</span>
              </div>
              <span style={{ fontSize: '20px', fontWeight: 600, color: '#1f2937' }}>{metric.value}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export default WorkforceWidget;
