import { useState, useEffect } from 'react';
import api from '@/services/api/client';

const PRI_COLORS = {
  critical: '#7c3aed',
  high:     '#ef4444',
  medium:   '#f59e0b',
  low:      '#10b981',
};

const fmtD = d => d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
  : null;

const isOverdue = d => d && new Date(d) < new Date() && new Date(d).toDateString() !== new Date().toDateString();

export function MyTasksWidget({ data: propData }) {
  const [tasks,   setTasks]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (propData?.tasks?.length) {
      setTasks(propData.tasks);
      setLoading(false);
      return;
    }
    api.get('/tasks/my-tasks?status=open&limit=5')
      .then(r => {
        const d = r.data;
        setTasks(Array.isArray(d) ? d : (d?.tasks || []));
      })
      .catch(err => {
        setError(err?.response?.data?.error || 'Failed to load tasks');
      })
      .finally(() => setLoading(false));
  }, [propData]);


  if (error) return (
    <div className="widget-data">
      <p style={{ color: '#dc2626', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>{error}</p>
    </div>
  );

  const dueToday = tasks.filter(t => {
    if (!t.due_date) return false;
    return new Date(t.due_date).toDateString() === new Date().toDateString();
  }).length;
  const overdue = tasks.filter(t => isOverdue(t.due_date)).length;

  return (
    <div className="widget-data">
      {/* summary chips */}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:8 }}>
        {dueToday > 0 && (
          <span style={{
            fontSize:12, fontWeight:600, padding:'4px 10px', borderRadius:20,
            background:'#fef3c7', color:'#92400e',
          }}>{dueToday} Due Today</span>
        )}
        {overdue > 0 && (
          <span style={{
            fontSize:12, fontWeight:600, padding:'4px 10px', borderRadius:20,
            background:'#fee2e2', color:'#991b1b',
          }}>{overdue} Overdue</span>
        )}
        {!dueToday && !overdue && tasks.length > 0 && (
          <span style={{ fontSize:12, color:'#9ca3af' }}>All tasks on schedule ✓</span>
        )}
      </div>

      {tasks.length === 0 ? (
        <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'8px 0' }}>
          No open tasks 🎉
        </p>
      ) : (
        <div className="task-list" style={{ display:'flex', flexDirection:'column', gap:7 }}>
          {tasks.slice(0, 5).map((t, i) => {
            const pri   = (t.priority || 'medium').toLowerCase();
            const color = PRI_COLORS[pri] || '#9ca3af';
            const od    = isOverdue(t.due_date);
            const due   = fmtD(t.due_date);
            return (
              <div key={i} style={{
                display:'flex', alignItems:'center', gap:8,
                padding:'8px 10px', background:'#f9fafb',
                borderRadius:8, border:'1px solid #e5e7eb',
                borderLeft:`3px solid ${color}`,
              }}>
                <span style={{
                  fontSize:9, fontWeight:700, textTransform:'uppercase',
                  letterSpacing:'0.4px', padding:'2px 7px', borderRadius:4,
                  background:`${color}1a`, color, flexShrink:0,
                }}>{pri}</span>

                <span style={{
                  flex:1, minWidth:0, fontSize:12, color:'#374151',
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                }}>{t.task_title || t.title || t.name}</span>

                {due && (
                  <span style={{
                    fontSize:11, flexShrink:0,
                    color: od ? '#ef4444' : '#9ca3af',
                    fontWeight: od ? 600 : 400,
                  }}>{od ? '⚠ ' : ''}{due}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button className="btn-link" style={{ fontSize:13, padding:'6px 0', marginTop:4 }}>
        View All Tasks →
      </button>
    </div>
  );
}

export default MyTasksWidget;
