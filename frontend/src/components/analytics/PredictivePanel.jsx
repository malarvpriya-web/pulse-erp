// frontend/src/components/analytics/PredictivePanel.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import api from '@/services/api/client';

function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '₹0';
  if (num >= 10000000) return `₹${(num/10000000).toFixed(2)} Cr`;
  if (num >= 100000)   return `₹${(num/100000).toFixed(2)}L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}


const CARD = { background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:16 };

function CardHeader({ title, updated_at }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontWeight:700, color:'#4c1d95', fontSize:14 }}>{title}</div>
      {updated_at && <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>Updated {new Date(updated_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</div>}
    </div>
  );
}

/**
 * The backend answers this panel honestly: a query that fails comes back as
 * `error:'query_failed'`, a window too short to fit a line comes back as
 * `insufficient_history`, and a genuinely quiet metric comes back as an empty
 * `data` array. Each of those is a real answer and has to render as one --
 * previously all three fell through to a fabricated `SAMPLE` constant, so a
 * 401, a 403 from the `reports:view` check, or an expired token all painted
 * invented attrition percentages and stockout alerts that looked live down to
 * the "Updated HH:MM" stamp.
 */
function PanelNotice({ tone = 'neutral', children }) {
  const c = tone === 'error' ? { fg:'#b91c1c', bg:'#fef2f2', bd:'#fecaca' }
          : tone === 'warn'  ? { fg:'#92400e', bg:'#fffbeb', bd:'#fde68a' }
          :                    { fg:'#6b7280', bg:'#f9fafb', bd:'#e5e7eb' };
  return (
    <div style={{ padding:'18px 14px', borderRadius:8, background:c.bg, border:`1px solid ${c.bd}`,
                  color:c.fg, fontSize:12, lineHeight:1.5, textAlign:'center' }}>
      {children}
    </div>
  );
}

/** Returns a notice element when `data` cannot be plotted, else null. */
function panelState(data, { rows = null } = {}) {
  if (!data) return <PanelNotice>Not available.</PanelNotice>;
  if (data.error) {
    return <PanelNotice tone="error">{data.note || 'This prediction could not be computed.'}</PanelNotice>;
  }
  if (data.insufficient_history) {
    return <PanelNotice tone="warn">{data.note || 'Not enough history to forecast yet.'}</PanelNotice>;
  }
  if (rows !== null && rows === 0) {
    return <PanelNotice>No records match this metric right now.</PanelNotice>;
  }
  return null;
}

function RevenueForecast({ data }) {
  const notice = panelState(data, { rows: (data?.historical || []).length });
  if (notice) {
    return (
      <div style={CARD}>
        <CardHeader title={data?.title || 'Revenue Forecast — Next 3 Months'} updated_at={data?.updated_at}/>
        {notice}
      </div>
    );
  }
  const { historical=[], forecast=[], trend } = data;
  const chartData = [
    ...historical.map(d=>({name:d.month,actual:d.revenue})),
    ...forecast.map(d=>({name:d.month,predicted:d.predicted,low:d.low,high:d.high})),
  ];
  // The headline figure is the LAST forecast month. Its label used to be the
  // literal string "Jun", which was only ever correct because the sample data
  // happened to end in June -- against live data it mislabelled whichever month
  // the backend actually projected to.
  const last = forecast[forecast.length - 1];
  return (
    <div style={CARD}>
      <CardHeader title={data.title} updated_at={data.updated_at} />
      <div style={{ display:'flex',gap:12,marginBottom:10 }}>
        <span style={{ fontSize:12,color:'#6b7280' }}>
          Trend: <strong style={{ color:trend==='increasing'?'#16a34a':'#dc2626' }}>{trend==='increasing'?'▲ Upward':'▼ Downward'}</strong>
        </span>
        {last && (
          <span style={{ fontSize:12,color:'#6b7280' }}>
            {last.month} forecast: <strong style={{ color:'#7c3aed' }}>{formatINR(last.predicted)}</strong>
          </span>
        )}
      </div>
      <div style={{ height:200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{top:4,right:8,left:0,bottom:20}}>
            <defs>
              <linearGradient id="revG" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#7c3aed" stopOpacity={0.18}/>
                <stop offset="95%" stopColor="#7c3aed" stopOpacity={0.02}/>
              </linearGradient>
              <linearGradient id="bandG" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#c4b5fd" stopOpacity={0.25}/>
                <stop offset="95%" stopColor="#c4b5fd" stopOpacity={0.05}/>
              </linearGradient>
            </defs>
            <XAxis dataKey="name" tick={{fontSize:10}} angle={-35} textAnchor="end"/>
            <YAxis tick={{fontSize:10}} tickFormatter={v=>`₹${(v/100000).toFixed(0)}L`}/>
            <Tooltip formatter={(v,n)=>[formatINR(v), n==='actual'?'Actual':n==='predicted'?'Forecast':n==='high'?'Upper':n==='low'?'Lower':n]}/>
            <Area type="monotone" dataKey="high"      stroke="none" fill="url(#bandG)"/>
            <Area type="monotone" dataKey="low"       stroke="none" fill="#fff"/>
            <Area type="monotone" dataKey="actual"    stroke="#7c3aed" strokeWidth={2} fill="url(#revG)" dot={{r:3,fill:'#7c3aed'}}/>
            <Area type="monotone" dataKey="predicted" stroke="#a78bfa" strokeWidth={2} strokeDasharray="6 3" fill="none" dot={{r:4,fill:'#a78bfa'}}/>
            <ReferenceLine x={historical[historical.length-1]?.month} stroke="#d4c5f9" strokeDasharray="4 4"/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={{ display:'flex',gap:8,marginTop:10 }}>
        {forecast.map(f=>(
          <div key={f.month} style={{ flex:1,padding:'8px 6px',background:'#f5f3ff',borderRadius:8,textAlign:'center' }}>
            <div style={{ fontSize:10,color:'#6b7280' }}>{f.month}</div>
            <div style={{ fontSize:15,fontWeight:700,color:'#7c3aed' }}>{formatINR(f.predicted)}</div>
            <div style={{ fontSize:10,color:'#9ca3af' }}>{formatINR(f.low)} – {formatINR(f.high)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AttritionRisk({ data }) {
  const notice = panelState(data, { rows: (data?.data || []).length });
  if (notice) {
    return (
      <div style={CARD}>
        <CardHeader title={data?.title || 'Attrition Risk by Department'} updated_at={data?.updated_at}/>
        {notice}
      </div>
    );
  }
  const barData = data.data?.map(d=>({
    dept: d.department.slice(0,7),
    risk: d.risk_pct,
    fill: d.risk_pct>20?'#dc2626':d.risk_pct>12?'#6d28d9':'#16a34a',
  }));
  return (
    <div style={CARD}>
      <CardHeader title={data.title} updated_at={data.updated_at}/>
      <div style={{ height:180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={barData} layout="vertical" margin={{top:4,right:36,left:52,bottom:4}}>
            <XAxis type="number" domain={[0,40]} tick={{fontSize:10}} tickFormatter={v=>`${v}%`}/>
            <YAxis type="category" dataKey="dept" tick={{fontSize:11}} width={50}/>
            <Tooltip formatter={v=>[`${v}%`,'Attrition Risk']}/>
            <Bar dataKey="risk" radius={[0,4,4,0]} label={{position:'right',fontSize:10,formatter:v=>`${v}%`}}>
              {barData?.map((entry,i)=>(
                <rect key={i} x={0} y={0} fill={entry.fill}/>
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div style={{ display:'flex',gap:8,marginTop:8,flexWrap:'wrap' }}>
        {data.data?.filter(d=>d.risk_pct>20).map(d=>(
          <span key={d.department} style={{ fontSize:11,padding:'2px 8px',borderRadius:10,background:'#fee2e2',color:'#dc2626',fontWeight:600 }}>
            ⚠️ {d.department}: {d.risk_pct}% risk ({d.at_risk}/{d.total} staff)
          </span>
        ))}
      </div>
    </div>
  );
}

function StockoutRisk({ data, setPage }) {
  // Live data legitimately returns zero rows here (nothing below its reorder
  // point), which used to render as a bare table header with no explanation.
  const notice = panelState(data, { rows: (data?.data || []).length });
  if (notice) {
    return (
      <div style={CARD}>
        <CardHeader title={data?.title || 'Inventory Stockout Risk'} updated_at={data?.updated_at}/>
        {notice}
      </div>
    );
  }
  return (
    <div style={CARD}>
      <CardHeader title={data.title} updated_at={data.updated_at}/>
      <table style={{ width:'100%',borderCollapse:'collapse',fontSize:12 }}>
        <thead>
          <tr style={{ background:'#f5f3ff' }}>
            {['Item','Stock','Reorder','Days Left',''].map(h=>(
              <th key={h} style={{ padding:'6px 8px',textAlign:'left',borderBottom:'1px solid #e9e4ff',color:'#4c1d95',fontWeight:600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.data?.map((item,i)=>(
            <tr key={i} style={{ borderBottom:'1px solid #f0ebff' }}>
              <td style={{ padding:'7px 8px',fontWeight:500,maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{item.name}</td>
              <td style={{ padding:'7px 8px',color:'#6b7280' }}>{item.current_stock} {item.unit}</td>
              <td style={{ padding:'7px 8px',color:'#6b7280' }}>{item.reorder_point} {item.unit}</td>
              <td style={{ padding:'7px 8px' }}>
                <span style={{ fontWeight:700,color:item.days_remaining<=7?'#dc2626':item.days_remaining<=14?'#6d28d9':'#16a34a' }}>
                  {item.days_remaining??'?'}d
                </span>
              </td>
              <td style={{ padding:'7px 8px' }}>
                <button onClick={()=>setPage?.('Procurement')}
                  style={{ background:'#ede9fe',color:'#7c3aed',border:'none',borderRadius:6,padding:'3px 8px',cursor:'pointer',fontSize:11,fontWeight:600 }}>
                  Order
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadConversion({ data }) {
  const notice = panelState(data, { rows: (data?.data || []).length });
  if (notice) {
    return (
      <div style={CARD}>
        <CardHeader title={data?.title || 'Top Lead Conversion Prospects'} updated_at={data?.updated_at}/>
        {notice}
      </div>
    );
  }
  const sc = (s)=>s>=75?'#16a34a':s>=55?'#6d28d9':'#dc2626';
  return (
    <div style={CARD}>
      <CardHeader title={data.title} updated_at={data.updated_at}/>
      <div style={{ display:'flex',flexDirection:'column',gap:8 }}>
        {data.data?.map((lead,i)=>(
          <div key={i} style={{ display:'flex',alignItems:'center',gap:10,padding:'9px 10px',background:'#faf9ff',borderRadius:8,border:'1px solid #e9e4ff' }}>
            <div style={{ width:24,height:24,borderRadius:'50%',background:'#7c3aed',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,flexShrink:0 }}>{i+1}</div>
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontWeight:600,color:'#1f2937',fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{lead.company_name}</div>
              <div style={{ fontSize:11,color:'#6b7280' }}>{lead.stage} · {formatINR(lead.deal_value)}</div>
            </div>
            <div style={{ textAlign:'center',flexShrink:0 }}>
              <div style={{ fontSize:17,fontWeight:800,color:sc(lead.score) }}>{lead.score}</div>
              <div style={{ fontSize:9,color:'#9ca3af' }}>Score</div>
            </div>
            <div style={{ width:40,height:5,background:'#f0ebff',borderRadius:3,flexShrink:0 }}>
              <div style={{ width:`${Math.min(lead.score,100)}%`,height:'100%',borderRadius:3,background:sc(lead.score) }}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const GRID = { display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(360px,1fr))', gap:16 };

export default function PredictivePanel({ setPage }) {
  const [predictions, setPredictions] = useState(null);
  // `loading` was declared but never set true -- it initialised to false and the
  // only write was setLoading(false) in the finally block, so the panel had no
  // loading state at all and went straight from nothing to charts.
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/ai/predictions');
      setPredictions(res.data?.data || res.data || {});
    } catch (e) {
      // A failure here is reportable, not paintable. The reachable causes are an
      // expired token (401) and a role without `reports:view` (403); both used
      // to render fabricated figures rather than say anything.
      const status = e?.response?.status;
      setError(
        status === 401 ? 'Your session has expired. Sign in again to see predictions.'
      : status === 403 ? 'You do not have permission to view predictive analytics.'
      :                  'Predictions could not be loaded.'
      );
      setPredictions(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={GRID}>
        {['Revenue Forecast — Next 3 Months','Attrition Risk by Department','Inventory Stockout Risk','Top Lead Conversion Prospects'].map(t=>(
          <div key={t} style={CARD}>
            <CardHeader title={t}/>
            <PanelNotice>Loading…</PanelNotice>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={CARD}>
        <PanelNotice tone="error">
          <div style={{ marginBottom:10 }}>{error}</div>
          <button onClick={load}
            style={{ background:'#ede9fe',color:'#7c3aed',border:'none',borderRadius:6,
                     padding:'5px 12px',cursor:'pointer',fontSize:12,fontWeight:600 }}>
            Retry
          </button>
        </PanelNotice>
      </div>
    );
  }

  const p = predictions || {};
  return (
    <div style={GRID}>
      <RevenueForecast data={p.revenue_forecast}/>
      <AttritionRisk   data={p.attrition_risk}/>
      <StockoutRisk    data={p.stockout_risk} setPage={setPage}/>
      <LeadConversion  data={p.lead_conversion}/>
    </div>
  );
}
