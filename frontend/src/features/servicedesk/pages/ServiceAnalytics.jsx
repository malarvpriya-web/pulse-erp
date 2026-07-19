import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { TrendingUp, Users, Clock, Star, Wrench, BarChart2 } from 'lucide-react';

const CARD = { background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'20px', marginBottom:16 };
const STAT = { textAlign:'center', padding:'16px 20px' };

const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;

export default function ServiceAnalytics() {
  const [engineers, setEngineers] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [selected, setSelected] = useState(null);
  const [engineerDetail, setEngineerDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState('90');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eng, dash] = await Promise.allSettled([
        api.get('/service-analytics/engineers'),
        api.get('/service-analytics/dashboard'),
      ]);
      if (eng.status === 'fulfilled') setEngineers(eng.value.data);
      if (dash.status === 'fulfilled') setDashboard(dash.value.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDetail = async (name) => {
    setSelected(name);
    try {
      const { data } = await api.get(`/service-analytics/engineers/${encodeURIComponent(name)}`);
      setEngineerDetail(data);
    } catch { setEngineerDetail(null); }
  };

  const kpis = dashboard?.kpis || {};

  const stars = (n) => {
    if (!n) return '—';
    const full = Math.round(n);
    return '⭐'.repeat(Math.min(full, 5)) + ` (${parseFloat(n).toFixed(1)})`;
  };

  const RatingBar = ({ value, max = 5 }) => (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ flex:1, height:6, background:'#f0f0f4', borderRadius:9999, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${(value / max) * 100}%`, background:value >= 4 ? '#059669' : value >= 3 ? '#d97706' : '#dc2626', borderRadius:9999 }} />
      </div>
      <span style={{ fontSize:12, fontWeight:600, color:'#374151', minWidth:24 }}>{parseFloat(value || 0).toFixed(1)}</span>
    </div>
  );

  return (
    <div style={{ padding:'24px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#111', margin:0 }}>Service Performance Analytics</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'4px 0 0' }}>Engineer-level metrics: tickets, closure time, first-fix %, ratings</p>
        </div>
        <button onClick={load} style={{ background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9e4ff', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer' }}>
          Refresh
        </button>
      </div>

      {/* Dashboard KPIs */}
      {dashboard && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12, marginBottom:20 }}>
          {[
            { label:'Total Tickets (30d)', value:kpis.total_tickets || 0, color:'#6B3FDB' },
            { label:'Open', value:kpis.open_tickets || 0, color:'#dc2626' },
            { label:'Closed', value:kpis.closed_tickets || 0, color:'#059669' },
            { label:'Avg Closure (hrs)', value:kpis.avg_closure_hrs ? `${kpis.avg_closure_hrs}h` : '—', color:'#d97706' },
            { label:'Avg CSAT', value:dashboard.csat?.avg_csat ? `${parseFloat(dashboard.csat.avg_csat).toFixed(1)}/5` : '—', color:'#6B3FDB' },
          ].map(s => (
            <div key={s.label} style={{ ...CARD, ...STAT, margin:0 }}>
              <div style={{ fontSize:24, fontWeight:800, color:s.color }}>{s.value}</div>
              <div style={{ fontSize:11, color:'#6b7280', marginTop:4, fontWeight:600 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Trend Chart (simple bar) */}
      {dashboard?.trend?.length > 0 && (
        <div style={{ ...CARD, marginBottom:20 }}>
          <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 14px', color:'#374151' }}>Daily Ticket Volume (Last 30 Days)</h3>
          <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:80 }}>
            {dashboard.trend.slice(-30).map((d, i) => {
              const maxVal = Math.max(...dashboard.trend.map(x => parseInt(x.created)), 1);
              const h = Math.max(4, (parseInt(d.created) / maxVal) * 70);
              return (
                <div key={i} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                  <div style={{ width:'100%', height:h, background:'#6B3FDB', borderRadius:'2px 2px 0 0', opacity:.8, minWidth:2 }} title={`${d.day}: ${d.created} created, ${d.closed} closed`} />
                </div>
              );
            })}
          </div>
          <div style={{ fontSize:11, color:'#9ca3af', textAlign:'right', marginTop:4 }}>Hover for day details</div>
        </div>
      )}

      {/* Engineer Performance Table */}
      <div style={CARD}>
        <h3 style={{ fontSize:15, fontWeight:700, margin:'0 0 16px', color:'#374151' }}>Engineer Performance Leaderboard</h3>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f9fafb' }}>
              {['#','Engineer','Zone','Total Tickets','Closed','Open','Avg Closure (hrs)','CSAT Rating','Commissioning','Action'].map(h => (
                <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {engineers.map((eng, i) => (
              <tr key={eng.engineer_id || i} style={{ borderTop:'1px solid #f3f4f6', cursor:'pointer', background:selected===eng.engineer_name?'#f5f3ff':'transparent' }}
                onClick={() => loadDetail(eng.engineer_name)}>
                <td style={{ padding:'10px 12px', fontWeight:700, color:'#9ca3af' }}>{i + 1}</td>
                <td style={{ padding:'10px 12px' }}>
                  <div style={{ fontWeight:700, color:'#111' }}>{eng.engineer_name}</div>
                  {eng.email && <div style={{ fontSize:11, color:'#9ca3af' }}>{eng.email}</div>}
                </td>
                <td style={{ padding:'10px 12px', color:'#6b7280' }}>{eng.zone || '—'}</td>
                <td style={{ padding:'10px 12px', fontWeight:700, color:'#6B3FDB', textAlign:'center' }}>{eng.total_tickets || 0}</td>
                <td style={{ padding:'10px 12px', color:'#059669', fontWeight:600, textAlign:'center' }}>{eng.closed_tickets || 0}</td>
                <td style={{ padding:'10px 12px', color:parseInt(eng.open_tickets)>5?'#dc2626':'#374151', fontWeight:600, textAlign:'center' }}>{eng.open_tickets || 0}</td>
                <td style={{ padding:'10px 12px', textAlign:'center' }}>
                  <span style={{ background:!eng.avg_closure_hrs?'#f3f4f6':parseFloat(eng.avg_closure_hrs)<=24?'#d1fae5':parseFloat(eng.avg_closure_hrs)<=48?'#fef3c7':'#fee2e2', color:!eng.avg_closure_hrs?'#6b7280':parseFloat(eng.avg_closure_hrs)<=24?'#065f46':parseFloat(eng.avg_closure_hrs)<=48?'#92400e':'#991b1b', padding:'2px 8px', borderRadius:9999, fontSize:12, fontWeight:700 }}>
                    {eng.avg_closure_hrs ? `${parseFloat(eng.avg_closure_hrs).toFixed(1)}h` : '—'}
                  </span>
                </td>
                <td style={{ padding:'10px 12px', minWidth:120 }}>
                  {eng.avg_rating ? <RatingBar value={parseFloat(eng.avg_rating)} /> : <span style={{ color:'#9ca3af', fontSize:12 }}>No ratings</span>}
                </td>
                <td style={{ padding:'10px 12px', textAlign:'center', color:'#374151' }}>
                  {eng.commissioning_total || 0} done
                  {eng.commissioning_rating && <div style={{ fontSize:11, color:'#d97706' }}>⭐ {parseFloat(eng.commissioning_rating).toFixed(1)}</div>}
                </td>
                <td style={{ padding:'10px 12px' }}>
                  <button onClick={e => { e.stopPropagation(); loadDetail(eng.engineer_name); }} style={{ background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9e4ff', borderRadius:6, padding:'4px 10px', fontSize:12, cursor:'pointer', fontWeight:600 }}>
                    Details
                  </button>
                </td>
              </tr>
            ))}
            {!engineers.length && (
              <tr><td colSpan={10} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No service engineer data yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Engineer Detail Panel */}
      {engineerDetail && (
        <div style={CARD}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <h3 style={{ fontSize:15, fontWeight:700, margin:0 }}>Deep Dive: {engineerDetail.engineer_name}</h3>
            <button onClick={() => { setEngineerDetail(null); setSelected(null); }} style={{ background:'none', border:'1px solid #e5e7eb', borderRadius:6, padding:'4px 10px', fontSize:12, cursor:'pointer' }}>
              Close
            </button>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
            {[
              ['Total Tickets', engineerDetail.ticket_stats?.total || 0, '#6B3FDB'],
              ['Closed', engineerDetail.ticket_stats?.closed || 0, '#059669'],
              ['Open', engineerDetail.ticket_stats?.open || 0, '#dc2626'],
              ['Avg Closure', engineerDetail.ticket_stats?.avg_closure_hrs ? `${parseFloat(engineerDetail.ticket_stats.avg_closure_hrs).toFixed(1)}h` : '—', '#d97706'],
            ].map(([l,v,c]) => (
              <div key={l} style={{ background:'#f9fafb', borderRadius:8, padding:'12px 16px', textAlign:'center' }}>
                <div style={{ fontSize:20, fontWeight:800, color:c }}>{v}</div>
                <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>{l}</div>
              </div>
            ))}
          </div>
          <h4 style={{ fontSize:13, fontWeight:700, marginBottom:8, color:'#374151' }}>Recent Tickets</h4>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead><tr style={{ background:'#f9fafb' }}>{['Ticket #','Subject','Status','Priority','CSAT','Opened','Resolved'].map(h=><th key={h} style={{ padding:'6px 10px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {(engineerDetail.recent_tickets || []).slice(0,10).map(t => (
                <tr key={t.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'6px 10px', fontWeight:700, color:'#6B3FDB' }}>{t.ticket_number}</td>
                  <td style={{ padding:'6px 10px', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.subject}</td>
                  <td style={{ padding:'6px 10px' }}>
                    <span style={{ background:{open:'#fef3c7',closed:'#d1fae5'}[t.status?.toLowerCase()]||'#f3f4f6', padding:'1px 6px', borderRadius:9999, fontSize:10, fontWeight:700, textTransform:'capitalize' }}>{t.status}</span>
                  </td>
                  <td style={{ padding:'6px 10px', color:'#374151' }}>{t.priority}</td>
                  <td style={{ padding:'6px 10px', color:'#d97706' }}>{t.csat_rating ? `⭐${t.csat_rating}` : '—'}</td>
                  <td style={{ padding:'6px 10px', color:'#9ca3af' }}>{t.created_at ? new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  <td style={{ padding:'6px 10px', color:'#9ca3af' }}>{t.resolved_at ? new Date(t.resolved_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                </tr>
              ))}
              {!(engineerDetail.recent_tickets || []).length && (
                <tr><td colSpan={7} style={{ textAlign:'center', padding:20, color:'#9ca3af' }}>No recent tickets</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
