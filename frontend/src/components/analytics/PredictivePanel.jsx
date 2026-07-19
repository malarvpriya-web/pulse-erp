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

const SAMPLE = {
  revenue_forecast:{
    title:'Revenue Forecast — Next 3 Months',
    historical:[
      {month:'Oct 25',revenue:4200000},{month:'Nov 25',revenue:5100000},{month:'Dec 25',revenue:6800000},
      {month:'Jan 26',revenue:5400000},{month:'Feb 26',revenue:6200000},{month:'Mar 26',revenue:7100000},
    ],
    forecast:[
      {month:'Apr 2026',predicted:7850000,low:6908000,high:8822000},
      {month:'May 2026',predicted:8340000,low:7339000,high:9341000},
      {month:'Jun 2026',predicted:9100000,low:8008000,high:10192000},
    ],
    trend:'increasing', updated_at:new Date().toISOString(),
  },
  attrition_risk:{
    title:'Attrition Risk by Department',
    data:[
      {department:'Sales',      total:28,at_risk:8, risk_pct:29},
      {department:'Engineering',total:42,at_risk:9, risk_pct:21},
      {department:'Operations', total:35,at_risk:6, risk_pct:17},
      {department:'Finance',    total:18,at_risk:2, risk_pct:11},
      {department:'HR',         total:12,at_risk:1, risk_pct:8 },
    ],
    updated_at:new Date().toISOString(),
  },
  stockout_risk:{
    title:'Inventory Stockout Risk',
    data:[
      {name:'Copper Wire 2.5mm',   current_stock:80,  reorder_point:200,unit:'mtrs',days_remaining:6 },
      {name:'Circuit Breaker 32A', current_stock:12,  reorder_point:50, unit:'pcs', days_remaining:9 },
      {name:'Steel Rods 10mm',     current_stock:150, reorder_point:500,unit:'kg',  days_remaining:14},
      {name:'PVC Conduit 25mm',    current_stock:320, reorder_point:800,unit:'mtrs',days_remaining:18},
    ],
    updated_at:new Date().toISOString(),
  },
  lead_conversion:{
    title:'Top Lead Conversion Prospects',
    data:[
      {id:1,company_name:'TechBridge Ltd',  deal_value:2400000,stage:'Negotiation',   score:82},
      {id:2,company_name:'Sunrise Motors',  deal_value:3200000,stage:'Negotiation',   score:82},
      {id:3,company_name:'Apex Infra',      deal_value:1800000,stage:'Proposal Sent', score:65},
      {id:4,company_name:'Blue Star Hotels',deal_value:950000, stage:'Demo Done',     score:55},
      {id:5,company_name:'Orbit Systems',   deal_value:1200000,stage:'Proposal Sent', score:65},
    ],
    updated_at:new Date().toISOString(),
  },
};

function CardHeader({ title, updated_at }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontWeight:700, color:'#4c1d95', fontSize:14 }}>{title}</div>
      {updated_at && <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>Updated {new Date(updated_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</div>}
    </div>
  );
}

function RevenueForecast({ data }) {
  if (!data) return null;
  const { historical=[], forecast=[], trend } = data;
  const chartData = [
    ...historical.map(d=>({name:d.month,actual:d.revenue})),
    ...forecast.map(d=>({name:d.month,predicted:d.predicted,low:d.low,high:d.high})),
  ];
  return (
    <div style={{ background:'#fff',border:'1px solid #e9e4ff',borderRadius:12,padding:16 }}>
      <CardHeader title={data.title} updated_at={data.updated_at} />
      <div style={{ display:'flex',gap:12,marginBottom:10 }}>
        <span style={{ fontSize:12,color:'#6b7280' }}>
          Trend: <strong style={{ color:trend==='increasing'?'#16a34a':'#dc2626' }}>{trend==='increasing'?'▲ Upward':'▼ Downward'}</strong>
        </span>
        <span style={{ fontSize:12,color:'#6b7280' }}>
          Jun forecast: <strong style={{ color:'#7c3aed' }}>{formatINR(forecast[2]?.predicted)}</strong>
        </span>
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
  if (!data) return null;
  const barData = data.data?.map(d=>({
    dept: d.department.slice(0,7),
    risk: d.risk_pct,
    fill: d.risk_pct>20?'#dc2626':d.risk_pct>12?'#d97706':'#16a34a',
  }));
  return (
    <div style={{ background:'#fff',border:'1px solid #e9e4ff',borderRadius:12,padding:16 }}>
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
  if (!data) return null;
  return (
    <div style={{ background:'#fff',border:'1px solid #e9e4ff',borderRadius:12,padding:16 }}>
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
                <span style={{ fontWeight:700,color:item.days_remaining<=7?'#dc2626':item.days_remaining<=14?'#d97706':'#16a34a' }}>
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
  if (!data) return null;
  const sc = (s)=>s>=75?'#16a34a':s>=55?'#d97706':'#dc2626';
  return (
    <div style={{ background:'#fff',border:'1px solid #e9e4ff',borderRadius:12,padding:16 }}>
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

export default function PredictivePanel({ setPage }) {
  const [predictions, setPredictions] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {

    try {
      const res = await api.get('/ai/predictions');
      setPredictions(res.data?.data || res.data || SAMPLE);
    } catch { setPredictions(SAMPLE); }
    finally  { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);


  const p = predictions || SAMPLE;
  return (
    <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(360px,1fr))',gap:16 }}>
      <RevenueForecast data={p.revenue_forecast}/>
      <AttritionRisk   data={p.attrition_risk}/>
      <StockoutRisk    data={p.stockout_risk} setPage={setPage}/>
      <LeadConversion  data={p.lead_conversion}/>
    </div>
  );
}
