import React, { useState } from 'react';

const RecentActivityWidget = ({ title = 'Recent Activity', data }) => {
  const [timeFilter, setTimeFilter] = useState('24h');

  const filterActivities = (activities) => {
    if (!activities || activities.length === 0) return [];
    
    const now = new Date();
    return activities.filter(activity => {
      const activityTime = parseActivityTime(activity.time, now);
      if (!activityTime) return true;
      
      const hoursDiff = (now - activityTime) / (1000 * 60 * 60);
      
      switch (timeFilter) {
        case '24h': return hoursDiff <= 24;
        case '48h': return hoursDiff <= 48;
        case '7d': return hoursDiff <= 168;
        default: return true;
      }
    });
  };

  const parseActivityTime = (timeStr, now) => {
    if (!timeStr) return null;
    
    const match = timeStr.match(/(\d+)([mhd])/);
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    const date = new Date(now);
    switch (unit) {
      case 'm': date.setMinutes(date.getMinutes() - value); break;
      case 'h': date.setHours(date.getHours() - value); break;
      case 'd': date.setDate(date.getDate() - value); break;
    }
    return date;
  };

  const getActivityIcon = (type) => {
    switch (type) {
      case 'user': return '👤';
      case 'document': return '📄';
      case 'payment': return '💰';
      case 'task': return '✓';
      default: return '•';
    }
  };

  const filteredActivities = data?.activities ? filterActivities(data.activities) : [];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 className="widget-title" style={{ margin: 0 }}>{title}</h3>
        <select 
          value={timeFilter} 
          onChange={(e) => setTimeFilter(e.target.value)}
          style={{
            padding: '6px 12px',
            fontSize: '13px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            background: 'white',
            color: '#374151',
            cursor: 'pointer',
            outline: 'none'
          }}
        >
          <option value="24h">Last 24 Hours</option>
          <option value="48h">Last 48 Hours</option>
          <option value="7d">Last 7 Days</option>
        </select>
      </div>
      
      {filteredActivities.length === 0 ? (
        <div className="widget-empty">No activity available</div>
      ) : (
        <div className="widget-scroll" style={{ flex: 1, overflowY: 'auto', paddingRight: '6px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {filteredActivities.map((activity, index) => (
              <div key={index} style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                background: '#f9fafb',
                borderRadius: '6px',
                border: '1px solid #e5e7eb',
                gap: '12px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: '16px', flexShrink: 0 }}>{getActivityIcon(activity.type)}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 500, color: '#1f2937', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {activity.action}
                    </div>
                    <div style={{ fontSize: '11px', color: '#6b7280' }}>{activity.user}</div>
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', whiteSpace: 'nowrap' }}>{activity.time}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
};

export default RecentActivityWidget;
