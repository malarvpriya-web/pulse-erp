import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { TrendingUp, TrendingDown, Target, Users, FileText, ShoppingCart, BarChart2 } from 'lucide-react';

const fmtL = v => {
  const n = Number(v||0);
  if (n >= 10000000) return `₹${(n/10000000).toFixed(2)}Cr`;
  if (n >= 100000)   return `₹${(n/100000).toFixed(1)}L`;
  if (n >= 1000)     return `₹${(n/1000).toFixed(0)}K`;
  return `₹${n.toLocaleString('en-IN')}`;
};
const pct = v => `${Number(v||0).toFixed(1)}%`;

const FUNNEL_STAGES = [
  { key:'enquiries',    label:'Enquiries',    icon: Users,       color:'#6366f1' },
  { key:'leads',        label:'Leads',        icon: Target,      color:'#8b5cf6' },
  { key:'opportunities',label:'Opportunities',icon: TrendingUp,  color:'#06b6d4' },
  { key:'quotations',   label:'Quotations',   icon: FileText,    color:'#f59e0b' },
  { key:'orders',       label:'Orders',       icon: ShoppingCart,color:'#10b981' },
];

const RATIO_LABELS = {
  enquiry_to_lead:          'Enquiry → Lead',
  lead_to_opportunity:      'Lead → Opportunity',
  opportunity_to_quotation: 'Opportunity → Quotation',
  quotation_to_order:       'Quotation → Order',
  enquiry_to_order:         'Overall Conversion',
};

const getFYStart = () => {
  const m = new Date().getMonth() + 1;
  return m >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1;
};

export default function SalesFunnel() {
  const [monthly, setMonthly] = useState([]);
  const [ratios, setRatios] = useState(null);
  const [performance, setPerformance] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('funnel'); // 'funnel' | 'monthly' | 'salesperson'
  const [fyYear, setFyYear] = useState(getFYStart());

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      api.get('/sales-funnel/monthly', { params: { months: 12 } }),
      api.get('/sales-funnel/conversion-ratios'),
      api.get('/sales-funnel/salesperson-performance', { params: { fy_year: fyYear } }),
    ]).then(([mRes, rRes, pRes]) => {
      setMonthly(mRes.status==='fulfilled' ? (mRes.value?.data||[]) : []);
      setRatios(rRes.status==='fulfilled' ? rRes.value?.data : null);
      setPerformance(pRes.status==='fulfilled' ? (pRes.value?.data||[]) : []);
    }).finally(() => setLoading(false));
  }, [fyYear]);

  const funnel = ratios?.funnel || {};
  const maxFunnel = Math.max(...Object.values(funnel).map(Number), 1);

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ marginBottom:20 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Sales Funnel & Conversion</h1>
        <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Enquiry → Lead → Opportunity → Quotation → Order conversion analytics</p>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:20, background:'#fff', borderRadius:10, padding:4, border:'1px solid #f0f0f4', width:'fit-content' }}>
        {[['funnel','Funnel Overview'],['monthly','Monthly Trend'],['salesperson','Salesperson']].map(([t,lbl]) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding:'7px 18px', borderRadius:7, border:'none', cursor:'pointer', fontSize:13, fontWeight:500,
              background: tab===t ? '#6B3FDB' : 'transparent',
              color: tab===t ? '#fff' : '#6b7280' }}>
            {lbl}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>Loading...</div>
      ) : (
        <>
          {/* ── Funnel Overview ─────────────────────────────────────── */}
          {tab === 'funnel' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
              {/* Funnel visual */}
              <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:24 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'#374151', marginBottom:20 }}>Pipeline Funnel</div>
                {FUNNEL_STAGES.map((stage, i) => {
                  const val = funnel[stage.key] || 0;
                  const width = maxFunnel > 0 ? (val / maxFunnel) * 100 : 0;
                  return (
                    <div key={stage.key} style={{ marginBottom:12 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, fontSize:13 }}>
                        <span style={{ color:'#374151', fontWeight:500 }}>{stage.label}</span>
                        <span style={{ fontWeight:700, color:stage.color }}>{val.toLocaleString('en-IN')}</span>
                      </div>
                      <div style={{ height:32, background:'#f9fafb', borderRadius:6, overflow:'hidden', position:'relative' }}>
                        <div style={{
                          height:'100%', width:`${Math.max(width, 4)}%`,
                          background:`linear-gradient(90deg, ${stage.color}cc, ${stage.color})`,
                          borderRadius:6, transition:'width 0.4s',
                          display:'flex', alignItems:'center',
                        }}/>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Conversion ratios */}
              <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:24 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'#374151', marginBottom:20 }}>Conversion Ratios</div>
                {ratios?.ratios && Object.entries(RATIO_LABELS).map(([key, label]) => {
                  const val = ratios.ratios[key] || 0;
                  const good = val >= 30;
                  return (
                    <div key={key} style={{ marginBottom:14 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, fontSize:13 }}>
                        <span style={{ color:'#6b7280' }}>{label}</span>
                        <span style={{ fontWeight:700, color: good ? '#10b981' : val >= 15 ? '#f59e0b' : '#ef4444' }}>{pct(val)}</span>
                      </div>
                      <div style={{ height:6, background:'#f0f0f4', borderRadius:3, overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${Math.min(val,100)}%`, background: good ? '#10b981' : val >= 15 ? '#f59e0b' : '#ef4444', borderRadius:3 }}/>
                      </div>
                    </div>
                  );
                })}

                {/* KPI summary */}
                <div style={{ marginTop:20, padding:'12px 14px', background:'#f5f3ff', borderRadius:8 }}>
                  <div style={{ fontSize:11, color:'#6B3FDB', fontWeight:700, marginBottom:8 }}>COMPANY CONVERSION SUMMARY</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {FUNNEL_STAGES.map(s => (
                      <div key={s.key} style={{ fontSize:13 }}>
                        <span style={{ color:'#9ca3af' }}>{s.label}: </span>
                        <span style={{ fontWeight:600, color:s.color }}>{(funnel[s.key]||0).toLocaleString('en-IN')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Monthly Trend ────────────────────────────────────────── */}
          {tab === 'monthly' && (
            <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
              <div style={{ padding:'16px 20px', borderBottom:'1px solid #f0f0f4', fontSize:14, fontWeight:700, color:'#374151' }}>
                Monthly Funnel (last 12 months)
              </div>
              {monthly.length === 0 ? (
                <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No data available</div>
              ) : (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'#f9fafb' }}>
                      {['Month','Enquiries','Leads','Opportunities','Quotations','Orders','Revenue'].map(h => (
                        <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map((m, i) => (
                      <tr key={m.month} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                        <td style={{ padding:'10px 16px', fontWeight:600, color:'#1f2937' }}>{m.month}</td>
                        <td style={{ padding:'10px 16px', color:'#6366f1' }}>{m.enquiries}</td>
                        <td style={{ padding:'10px 16px', color:'#8b5cf6' }}>{m.leads}</td>
                        <td style={{ padding:'10px 16px', color:'#06b6d4' }}>{m.opportunities}</td>
                        <td style={{ padding:'10px 16px', color:'#f59e0b' }}>{m.quotations}</td>
                        <td style={{ padding:'10px 16px', color:'#10b981', fontWeight:600 }}>{m.orders}</td>
                        <td style={{ padding:'10px 16px', fontWeight:600, color:'#1f2937' }}>{fmtL(m.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── Salesperson Performance ──────────────────────────────── */}
          {tab === 'salesperson' && (
            <div>
              <div style={{ display:'flex', gap:12, marginBottom:16, alignItems:'center' }}>
                <span style={{ fontSize:13, color:'#374151', fontWeight:500 }}>Financial Year:</span>
                <select value={fyYear} onChange={e => setFyYear(Number(e.target.value))}
                  style={{ padding:'7px 14px', borderRadius:8, border:'1px solid #e5e7eb', fontSize:13, outline:'none' }}>
                  {[getFYStart()+1, getFYStart(), getFYStart()-1].map(y => (
                    <option key={y} value={y}>FY {y}-{String(y+1).slice(2)}</option>
                  ))}
                </select>
              </div>

              <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
                {performance.length === 0 ? (
                  <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No targets set for this FY. Set annual targets first.</div>
                ) : (
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <thead>
                      <tr style={{ background:'#f9fafb' }}>
                        {['Salesperson','Target','Achieved','Achievement %','Orders Won','Commission %','Commission Earned'].map(h => (
                          <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {performance.map((p, i) => {
                        const ach = Number(p.achievement_pct||0);
                        const color = ach >= 100 ? '#10b981' : ach >= 70 ? '#f59e0b' : '#ef4444';
                        return (
                          <tr key={i} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                            <td style={{ padding:'10px 14px', fontWeight:600, color:'#1f2937' }}>{p.salesperson_name}</td>
                            <td style={{ padding:'10px 14px', color:'#6b7280' }}>{fmtL(p.annual_target)}</td>
                            <td style={{ padding:'10px 14px', color:'#374151', fontWeight:500 }}>{fmtL(p.achieved)}</td>
                            <td style={{ padding:'10px 14px' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                <span style={{ fontWeight:700, color }}>{ach.toFixed(1)}%</span>
                                <div style={{ flex:1, height:6, background:'#f0f0f4', borderRadius:3, overflow:'hidden', minWidth:60 }}>
                                  <div style={{ height:'100%', width:`${Math.min(ach,100)}%`, background:color, borderRadius:3 }}/>
                                </div>
                              </div>
                            </td>
                            <td style={{ padding:'10px 14px', color:'#374151' }}>{p.orders_won}</td>
                            <td style={{ padding:'10px 14px', color:'#9ca3af' }}>{Number(p.commission_rate||0).toFixed(1)}%</td>
                            <td style={{ padding:'10px 14px', fontWeight:600, color:'#6B3FDB' }}>{fmtL(p.commission_earned)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
