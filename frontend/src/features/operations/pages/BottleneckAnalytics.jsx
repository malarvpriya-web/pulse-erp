import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { AlertTriangle, TrendingDown, Clock, CheckCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const SEV_COLOR = {
  critical: { bg:'#fee2e2', color:'#991b1b' },
  high:     { bg:'#fde68a', color:'#92400e' },
  medium:   { bg:'#fef3c7', color:'#92400e' },
  low:      { bg:'#d1fae5', color:'#065f46' },
};

export default function BottleneckAnalytics() {
  const [bottlenecks, setBottlenecks] = useState([]);
  const [chart,       setChart]       = useState([]);
  const [loading,     setLoading]     = useState(false);

  useEffect(() => {
    Promise.allSettled([
      api.get('/operations/bottlenecks'),
      api.get('/operations/workload-chart'),
    ]).then(([bRes, cRes]) => {
      setBottlenecks(bRes.status==='fulfilled' ? (Array.isArray(bRes.value?.data) ? bRes.value.data : []) : []);
      setChart(cRes.status==='fulfilled'       ? (Array.isArray(cRes.value?.data) ? cRes.value.data : []) : []);
    }).finally(() => setLoading(false));
  }, []);

  const critical = bottlenecks.filter(b => b.severity === 'critical').length;
  const medium   = bottlenecks.filter(b => b.severity === 'medium').length;

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Bottleneck Analytics</h1>
        <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Identify and resolve operational bottlenecks</p>
      </div>

      {/* KPIs */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:24 }}>
        {[
          { label:'Critical Bottlenecks', value:critical,           color:'#ef4444', icon:AlertTriangle },
          { label:'Medium Issues',        value:medium,            color:'#f59e0b', icon:TrendingDown },
          { label:'Total Identified',     value:bottlenecks.length,color:'#6366f1', icon:Clock },
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

      {chart.length > 0 && (
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:24, marginBottom:20 }}>
          <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:'0 0 20px' }}>Process Delay Analysis</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4"/>
              <XAxis dataKey="process" tick={{ fontSize:11 }}/>
              <YAxis tick={{ fontSize:11 }}/>
              <Tooltip/>
              <Bar dataKey="avg_delay_hours" fill="#ef4444" radius={[4,4,0,0]} name="Avg Delay (hrs)"/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid #f0f0f4' }}>
          <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:0 }}>Identified Bottlenecks</h2>
        </div>
        {loading ? <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div> :
         bottlenecks.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>
            <CheckCircle size={32} color="#10b981" style={{ display:'block', margin:'0 auto 8px' }}/>
            <p>No bottlenecks detected — operations running smoothly!</p>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column' }}>
            {bottlenecks?.map((b, i) => {
              const sc = SEV_COLOR[b?.severity] || SEV_COLOR.medium;
              return (
                <div key={b?.id ?? i} style={{ padding:'16px 20px', borderBottom:'1px solid #f9fafb', display:'flex', alignItems:'flex-start', gap:14 }}>
                  <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, flexShrink:0, textTransform:'uppercase' }}>{b?.severity ?? 'low'}</span>
                  <div style={{ flex:1 }}>
                    <strong style={{ fontSize:14, fontWeight:600, color:'#1f2937', display:'block', marginBottom:4 }}>{b?.title ?? 'Untitled Issue'}</strong>
                    <p style={{ fontSize:12, color:'#6b7280', margin:'0 0 6px' }}>{b?.description ?? 'No description available'}</p>
                    <span style={{ fontSize:11, color:'#6b7280' }}>
                      {b?.affected_dept ?? '—'}
                      {b?.owner ? ` · ${b.owner}` : ' · Unassigned'}
                    </span>
                  </div>
                  {b?.avg_delay_hours != null && (
                    <span style={{ fontSize:13, fontWeight:700, color:'#ef4444', flexShrink:0 }}>{b.avg_delay_hours}h avg delay</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}