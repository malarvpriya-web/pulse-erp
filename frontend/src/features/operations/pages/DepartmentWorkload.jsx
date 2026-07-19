import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Users, AlertTriangle } from 'lucide-react';

export default function DepartmentWorkload() {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/operations/department-workload')
      .then(r => setData(Array.isArray(r.data) ? r.data : []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  const barColor = pct => pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Department Workload</h1>
        <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Workload distribution across all departments</p>
      </div>

      {loading ? <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div> : (
        <>
          {/* Overload alerts */}
          {(data?.filter(d => (d?.utilization_pct ?? 0) >= 90).length ?? 0) > 0 && (
            <div style={{ background:'#fee2e2', border:'1px solid #fca5a5', borderRadius:10, padding:'12px 16px', marginBottom:20, display:'flex', alignItems:'center', gap:10 }}>
              <AlertTriangle size={16} color="#991b1b"/>
              <span style={{ fontSize:13, color:'#991b1b', fontWeight:500 }}>
                {data.filter(d => (d?.utilization_pct ?? 0) >= 90).length} departments are overloaded (&gt;90% capacity)
              </span>
            </div>
          )}

          {data.length === 0 ? (
            <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
              <Users size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
              <p style={{ color:'#9ca3af' }}>No workload data available</p>
            </div>
          ) : (
            <>
              <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:24, marginBottom:20 }}>
                <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:'0 0 20px' }}>Utilization by Department</h2>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={data} margin={{ top:0, right:16, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4"/>
                    <XAxis dataKey="department" tick={{ fontSize:11 }}/>
                    <YAxis domain={[0,100]} tickFormatter={v=>`${v}%`} tick={{ fontSize:11 }}/>
                    <Tooltip formatter={v=>[`${v}%`,'Utilization']}/>
                    <Bar dataKey="utilization_pct" radius={[4,4,0,0]} name="Utilization %">
                      {data?.map((d,i) => <Cell key={d?.id ?? i} fill={barColor(d?.utilization_pct ?? 0)}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'#f9fafb' }}>
                      {['Department','Headcount','Active Tasks','Utilization','Status'].map(h => (
                        <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data?.map((d, i) => {
                      const pct = d?.utilization_pct ?? 0;
                      return (
                        <tr key={d?.id ?? i} style={{ borderBottom:'1px solid #f9fafb' }}>
                          <td style={{ padding:'10px 16px', fontWeight:500, color:'#1f2937' }}>{d?.department ?? '—'}</td>
                          <td style={{ padding:'10px 16px', color:'#374151' }}>{d?.employee_count ?? d?.headcount ?? '—'}</td>
                          <td style={{ padding:'10px 16px', color:'#374151' }}>{d?.active_tasks ?? d?.task_count ?? '—'}</td>
                          <td style={{ padding:'10px 16px' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                              <div style={{ flex:1, background:'#f3f4f6', borderRadius:4, height:8 }}>
                                <div style={{ width:`${Math.min(100,pct)}%`, height:'100%', background:barColor(pct), borderRadius:4 }}/>
                              </div>
                              <span style={{ fontSize:12, fontWeight:600, color:barColor(pct), minWidth:38 }}>{pct}%</span>
                            </div>
                          </td>
                          <td style={{ padding:'10px 16px' }}>
                            <span style={{
                              background: pct>=90?'#fee2e2':pct>=70?'#fef3c7':'#d1fae5',
                              color:      pct>=90?'#991b1b':pct>=70?'#92400e':'#065f46',
                              padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600
                            }}>{pct>=90?'Overloaded':pct>=70?'High':'Normal'}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}