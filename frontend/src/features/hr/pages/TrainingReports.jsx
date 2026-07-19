// frontend/src/features/hr/pages/TrainingReports.jsx
import { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell } from 'recharts';
import api from '@/services/api/client';

const REPORTS = [
  { id:'training-hours',         label:'Training Hours by Dept',   icon:'⏱' },
  { id:'completion-rates',       label:'Completion Rates',          icon:'✅' },
  { id:'certification-status',   label:'Certification Status',      icon:'📋' },
  { id:'skill-gap/department',   label:'Skill Gap by Department',   icon:'📊' },
  { id:'skill-gap/role',         label:'Skill Gap by Role',         icon:'🎯' },
  { id:'assessment-results',     label:'Assessment Results',        icon:'📝' },
  { id:'overdue-training',       label:'Overdue Training',          icon:'🔴' },
  { id:'budget-vs-actual',       label:'Budget vs Actual',          icon:'💰' },
  { id:'training-roi',           label:'Training ROI',              icon:'📈' },
  { id:'trainer-effectiveness',  label:'Trainer Effectiveness',     icon:'👨‍🏫' },
  { id:'mandatory-compliance',   label:'Mandatory Compliance',      icon:'🔒' },
  { id:'feedback-analysis',      label:'Feedback & Satisfaction',   icon:'⭐' },
  { id:'learning-path-completion', label:'Learning Path Completion', icon:'🛤️' },
  { id:'competency-gaps',        label:'Competency Gaps',           icon:'🧠' },
];

function exportCSV(data, filename) {
  if (!data?.length) return;
  const keys = Object.keys(data[0]);
  const rows = [keys.join(','), ...data.map(r => keys.map(k => JSON.stringify(r[k] ?? '')).join(','))];
  const blob = new Blob([rows.join('\n')], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename + '.csv'; a.click();
}

function DataTable({ data }) {
  if (!data?.length) return <p style={{ color:'#9ca3af', textAlign:'center', padding:'24px 0' }}>No data available</p>;
  const keys = Object.keys(data[0]);
  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
        <thead><tr style={{ background:'#f5f3ff' }}>
          {keys.map(k => <th key={k} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, whiteSpace:'nowrap' }}>{k.replace(/_/g,' ').toUpperCase()}</th>)}
        </tr></thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} style={{ borderBottom:'1px solid #f0ebff' }}>
              {keys.map(k => (
                <td key={k} style={{ padding:'7px 12px', color: typeof row[k] === 'number' ? '#6B3FDB' : '#374151', fontWeight: typeof row[k] === 'number' ? 700 : 400, whiteSpace:'nowrap' }}>
                  {row[k] === null || row[k] === undefined ? '—' : String(row[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TrainingReports() {
  const [activeReport, setActiveReport] = useState(REPORTS[0].id);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fyStart, setFyStart] = useState('');
  const [fyEnd, setFyEnd] = useState('');
  const [department, setDepartment] = useState('');
  const [deptList, setDeptList] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setData([]);
    try {
      let url = `/lnd-reports/${activeReport}`;
      const params = [];
      if (fyStart) params.push(`fy_start=${fyStart}`);
      if (fyEnd) params.push(`fy_end=${fyEnd}`);
      if (department && activeReport === 'skill-gap/department') params.push(`department=${encodeURIComponent(department)}`);
      if (params.length) url += '?' + params.join('&');
      const r = await api.get(url);
      setData(r.data || []);
    } catch { setData([]); }
    finally { setLoading(false); }
  }, [activeReport, fyStart, fyEnd, department]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const activeLabel = REPORTS.find(r => r.id === activeReport)?.label || '';

  // Determine best numeric key for chart
  const numericKeys = data.length ? Object.keys(data[0]).filter(k => typeof data[0][k] === 'number') : [];
  const chartKey = numericKeys[0];
  const labelKey = data.length ? Object.keys(data[0])[0] : null;

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh', display:'grid', gridTemplateColumns:'220px 1fr', gap:20 }}>
      {/* Sidebar */}
      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:16, alignSelf:'start', position:'sticky', top:24 }}>
        <h3 style={{ margin:'0 0 12px', color:'#4c1d95', fontSize:14 }}>L&D Reports</h3>
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          {REPORTS.map(r => (
            <button key={r.id} onClick={() => setActiveReport(r.id)}
              style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background: activeReport===r.id ? '#e9e4ff' : 'none', color: activeReport===r.id ? '#6B3FDB' : '#374141', border:'none', borderRadius:7, cursor:'pointer', fontWeight: activeReport===r.id ? 700 : 500, fontSize:12, textAlign:'left' }}>
              <span>{r.icon}</span> {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div>
        <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:20, marginBottom:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:10 }}>
            <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>{activeLabel}</h3>
            <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
              {(activeReport === 'budget-vs-actual' || activeReport === 'training-hours') && (
                <>
                  <input type="date" value={fyStart} onChange={e => setFyStart(e.target.value)} style={{ padding:'6px 10px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
                  <span style={{ fontSize:12, color:'#6b7280' }}>to</span>
                  <input type="date" value={fyEnd} onChange={e => setFyEnd(e.target.value)} style={{ padding:'6px 10px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
                </>
              )}
              {activeReport === 'skill-gap/department' && (
                <select value={department} onChange={e => setDepartment(e.target.value)} style={{ padding:'6px 10px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, width:180, background:'#fff' }}>
                  <option value="">All Departments</option>
                  {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
              <button onClick={load} style={{ padding:'6px 14px', background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>↻ Refresh</button>
              <button onClick={() => exportCSV(data, activeLabel.replace(/\s+/g,'_'))} disabled={!data.length} style={{ padding:'6px 14px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12, opacity: data.length ? 1 : 0.5 }}>⬇ CSV</button>
            </div>
          </div>
        </div>

        {loading && <div style={{ textAlign:'center', padding:'48px 0', color:'#6B3FDB', fontWeight:600 }}>Loading…</div>}

        {!loading && data.length > 0 && chartKey && labelKey && (
          <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:20, marginBottom:16 }}>
            <h4 style={{ margin:'0 0 12px', color:'#4c1d95', fontSize:13 }}>{chartKey.replace(/_/g,' ').toUpperCase()} Chart</h4>
            <div style={{ height:200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.slice(0,20)} margin={{ top:4, right:20, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                  <XAxis dataKey={labelKey} tick={{ fontSize:10 }} />
                  <YAxis tick={{ fontSize:10 }} />
                  <Tooltip />
                  <Bar dataKey={chartKey} radius={[4,4,0,0]}>
                    {data.slice(0,20).map((_, i) => <Cell key={i} fill={['#6B3FDB','#2563eb','#16a34a','#d97706','#dc2626'][i % 5]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {!loading && (
          <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:20 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <h4 style={{ margin:0, color:'#4c1d95', fontSize:13 }}>Data ({data.length} rows)</h4>
            </div>
            <DataTable data={data} />
          </div>
        )}
      </div>
    </div>
  );
}
