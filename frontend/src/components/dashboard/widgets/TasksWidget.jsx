import React from 'react';

const TasksWidget = ({ title = 'My Tasks', data }) => {
  if (!data || !data.tasks || data.tasks.length === 0) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No tasks available</div>
      </>
    );
  }

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'high': return '#ef4444';
      case 'medium': return '#f59e0b';
      case 'low': return '#10b981';
      default: return '#6b7280';
    }
  };

  return (
    <>
      <h3 className="widget-title">{title} ({data.tasks.length})</h3>
      <div className="widget-scroll">
        {data.tasks.map((task, index) => (
          <div key={index} className="activity-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
              <div 
                style={{ 
                  width: '6px', 
                  height: '6px', 
                  borderRadius: '50%', 
                  background: getPriorityColor(task.priority),
                  flexShrink: 0
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#1f2937', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {task.title}
                </div>
                <div style={{ fontSize: '11px', color: '#6b7280' }}>{task.project}</div>
              </div>
            </div>
            <div className="activity-time">{task.dueDate}</div>
          </div>
        ))}
      </div>
    </>
  );
};

export default TasksWidget;
