import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Clock, TrendingUp, Users } from 'lucide-react';

const barColor = pct => pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#ef4444';

export default function UtilizationReport() {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [period,  setPeriod]  = useState('month');

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (!isMounted.current) return;
    setLoading(true);
    api.get('/timesheets/utilization', { params: { period } })
      .then(r => {
        if (!isMounted.current) return;
        setData(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {
        if (!isMounted.current) return;
        setData([]);
      })
      .finally(() => { if (!isMounted.current) return; setLoading(false); });
  }, [period]);

  const avg  = data.length ? Math.round(data.reduce((s,d) => s + Number(d.utilization_pct || 0), 0) / data.length) : 0;
  const high = data.filter(d => Number(d.utilization_pct || 0) >= 80).length;

  // Neutral colour when there is no data yet — avoid alarming red for an empty state
  const avgColor = data.length === 0
    ? '#9ca3af'
    : barColor(avg);

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Utilization Report</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Billable hours vs capacity by employee</p>
        </div>
        <select value={period} onChange={e => setPeriod(e.target.value)}
          style={{ padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none' }}>
          {['week','month','quarter'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}
        </select>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:24 }}>
        {[
          { label:'Avg Utilization',  value:`${avg}%`,   icon:TrendingUp, color:avgColor  },
          { label:'High Utilization', value:high,         icon:Clock,      color:'#10b981' },
          { label:'Employees Tracked',value:data.length,  icon:Users,      color:'#6366f1' },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <div>
                <p style={{ fontSize:11, color:'#9ca3af', margin:'0 0 8px', fontWeight:500, textTransform:'uppercase' }}>{k.label}</p>
                <p style={{ fontSize:28, fontWeight:700, color:k.color, margin:0 }}>{loading?'..':k.value}</p>
              </div>
              <div style={{ background:k.color+'18', borderRadius:10, padding:10, height:'fit-content' }}>
                <k.icon size={20} color={k.color}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      {loading ? <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div> :
       data.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <Clock size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
          <p style={{ color:'#9ca3af' }}>No timesheet data available for this period</p>
        </div>
      ) : (
        <>
          <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:24, marginBottom:20 }}>
            <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:'0 0 20px' }}>Utilization by Employee</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data} margin={{ bottom:30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4"/>
                <XAxis dataKey="name" tick={{ fontSize:10 }} angle={-30} textAnchor="end" interval={0}/>
                <YAxis domain={[0,100]} tickFormatter={v=>`${v}%`} tick={{ fontSize:11 }}/>
                <Tooltip formatter={v=>[`${v}%`,'Utilization']}/>
                <Bar dataKey="utilization_pct" radius={[4,4,0,0]} name="Utilization %">
                  {data.map((d,i) => <Cell key={i} fill={barColor(d.utilization_pct||0)}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'#f9fafb' }}>
                  {['Employee','Logged Hours','Available Hours','Utilization','Status'].map(h => (
                    <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...data].sort((a,b)=>Number(b.utilization_pct||0)-Number(a.utilization_pct||0)).map((d,i) => {
                  const pct = Number(d.utilization_pct||0);
                  return (
                    <tr key={i} style={{ borderBottom:'1px solid #f9fafb' }}>
                      <td style={{ padding:'10px 16px', fontWeight:500, color:'#1f2937' }}>{d.name||d.employee_name||'—'}</td>
                      <td style={{ padding:'10px 16px', color:'#374151' }}>{d.logged_hours||0}h</td>
                      <td style={{ padding:'10px 16px', color:'#374151' }}>{d.total_hours||160}h</td>
                      <td style={{ padding:'10px 16px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <div style={{ flex:1, background:'#f3f4f6', borderRadius:4, height:8 }}>
                            <div style={{ width:`${Math.min(100,pct)}%`, height:'100%', background:barColor(pct), borderRadius:4 }}/>
                          </div>
                          <span style={{ fontSize:12, fontWeight:700, color:barColor(pct), minWidth:38 }}>{pct}%</span>
                        </div>
                      </td>
                      <td style={{ padding:'10px 16px' }}>
                        <span style={{ background:pct>=80?'#d1fae5':pct>=60?'#fef3c7':'#fee2e2', color:pct>=80?'#065f46':pct>=60?'#92400e':'#991b1b', padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>
                          {pct>=80?'On Track':pct>=60?'Moderate':'Under-utilized'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}