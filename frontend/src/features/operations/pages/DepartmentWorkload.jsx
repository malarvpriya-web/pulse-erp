import { useState, useEffect, useCallback } from 'react';
import { Users, CheckSquare, Clock, TrendingUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import api from '@/services/api/client';
import './DepartmentWorkload.css';

const SAMPLE = [
  { id: 1, department: 'Engineering', headcount: 28, activeTasks: 47, completedTasks: 112, overdueTask: 5, avgCompletion: 70, capacity: 85 },
  { id: 2, department: 'Sales', headcount: 15, activeTasks: 32, completedTasks: 89, overdueTask: 3, avgCompletion: 85, capacity: 92 },
  { id: 3, department: 'Finance', headcount: 10, activeTasks: 18, completedTasks: 64, overdueTask: 1, avgCompletion: 90, capacity: 72 },
  { id: 4, department: 'HR', headcount: 8, activeTasks: 14, completedTasks: 43, overdueTask: 0, avgCompletion: 95, capacity: 65 },
  { id: 5, department: 'Operations', headcount: 12, activeTasks: 25, completedTasks: 78, overdueTask: 4, avgCompletion: 75, capacity: 88 },
  { id: 6, department: 'Marketing', headcount: 7, activeTasks: 11, completedTasks: 35, overdueTask: 2, avgCompletion: 80, capacity: 70 },
];

const SAMPLE_CHART = SAMPLE.map(d => ({
  dept: d.department.slice(0, 4),
  Active: d.activeTasks,
  Completed: d.completedTasks,
  Overdue: d.overdueTask,
}));

function getCapacityColor(c) {
  if (c >= 90) return '#ef4444';
  if (c >= 75) return '#f59e0b';
  return '#22c55e';
}

export default function DepartmentWorkload() {
  const [depts, setDepts]     = useState(SAMPLE);
  const [chart, setChart]     = useState(SAMPLE_CHART);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, c] = await Promise.allSettled([
      api.get('/operations/department-workload'),
      api.get('/operations/workload-chart'),
    ]);
    if (d.status === 'fulfilled') {
      const raw = d.value.data?.data ?? d.value.data;
      if (Array.isArray(raw) && raw.length) { setDepts(raw); setChart(raw.map(x => ({ dept: x.department.slice(0,4), Active: x.activeTasks, Completed: x.completedTasks, Overdue: x.overdueTask }))); }
    }
    if (c.status === 'fulfilled' && Array.isArray(c.value?.data) && c.value.data.length) setChart(c.value.data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalActive    = depts.reduce((s, d) => s + d.activeTasks, 0);
  const totalCompleted = depts.reduce((s, d) => s + d.completedTasks, 0);
  const totalOverdue   = depts.reduce((s, d) => s + d.overdueTask, 0);
  const totalHeadcount = depts.reduce((s, d) => s + d.headcount, 0);

  return (
    <div className="dw-root">
      <div className="dw-header">
        <div>
          <h1 className="dw-title">Department Workload</h1>
          <p className="dw-sub">Task distribution and capacity across departments</p>
        </div>
      </div>

      <div className="dw-stats">
        {[
          { icon: <Users size={18} />, num: totalHeadcount, lbl: 'Total Headcount', bg: '#eef2ff', cl: '#4338ca' },
          { icon: <CheckSquare size={18} />, num: totalActive, lbl: 'Active Tasks', bg: '#dbeafe', cl: '#1d4ed8' },
          { icon: <TrendingUp size={18} />, num: totalCompleted, lbl: 'Completed Tasks', bg: '#dcfce7', cl: '#15803d' },
          { icon: <Clock size={18} />, num: totalOverdue, lbl: 'Overdue Tasks', bg: '#fee2e2', cl: '#dc2626' },
        ].map((s, i) => (
          <div key={i} className="dw-stat">
            <div className="dw-stat-icon" style={{ background: s.bg, color: s.cl }}>{s.icon}</div>
            <div><div className="dw-stat-num">{s.num}</div><div className="dw-stat-lbl">{s.lbl}</div></div>
          </div>
        ))}
      </div>

      <div className="dw-chart-card">
        <div className="dw-card-title">Task Distribution by Department</div>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chart} margin={{ top: 5, right: 20, left: 0, bottom: 5 }} barGap={3}>
            <XAxis dataKey="dept" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Completed" stackId="a" fill="#86efac" radius={[0,0,0,0]} />
            <Bar dataKey="Active"    stackId="a" fill="#6366f1" />
            <Bar dataKey="Overdue"   stackId="a" fill="#ef4444" radius={[4,4,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {loading ? (
        <div className="dw-loading"><div className="dw-spinner" /></div>
      ) : (
        <div className="dw-grid">
          {depts.map(d => {
            const capColor = getCapacityColor(d.capacity);
            return (
              <div key={d.id} className={`dw-card ${selected === d.id ? 'dw-card-selected' : ''}`} onClick={() => setSelected(selected === d.id ? null : d.id)}>
                <div className="dw-card-hd">
                  <span className="dw-dept-name">{d.department}</span>
                  <span className="dw-headcount"><Users size={12} /> {d.headcount}</span>
                </div>

                <div className="dw-card-nums">
                  <div className="dw-num-item">
                    <span className="dw-num-val dw-blue">{d.activeTasks}</span>
                    <span className="dw-num-lbl">Active</span>
                  </div>
                  <div className="dw-num-item">
                    <span className="dw-num-val dw-green">{d.completedTasks}</span>
                    <span className="dw-num-lbl">Done</span>
                  </div>
                  <div className="dw-num-item">
                    <span className="dw-num-val" style={{ color: d.overdueTask > 0 ? '#ef4444' : '#9ca3af' }}>{d.overdueTask}</span>
                    <span className="dw-num-lbl">Overdue</span>
                  </div>
                  <div className="dw-num-item">
                    <span className="dw-num-val">{d.avgCompletion}%</span>
                    <span className="dw-num-lbl">Completion</span>
                  </div>
                </div>

                <div className="dw-capacity-row">
                  <span className="dw-cap-lbl">Capacity: {d.capacity}%</span>
                  <span className="dw-cap-badge" style={{ background: capColor + '22', color: capColor }}>
                    {d.capacity >= 90 ? 'Overloaded' : d.capacity >= 75 ? 'High' : 'Normal'}
                  </span>
                </div>
                <div className="dw-cap-track">
                  <div className="dw-cap-fill" style={{ width: `${Math.min(d.capacity, 100)}%`, background: capColor }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
