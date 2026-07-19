import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { TrendingUp, Plane, IndianRupee, Users } from 'lucide-react';
import { fmt } from './travelUtils';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#3b82f6'];

export default function TravelAnalytics() {
  const [trend,   setTrend]   = useState([]);
  const [deptData,setDeptData]= useState([]);
  const [stats,   setStats]   = useState({});
  const [topTravelers, setTopTravelers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.allSettled([
      api.get('/travel/analytics/trend'),
      api.get('/travel/analytics/department'),
      api.get('/travel/analytics/stats'),
      api.get('/travel/analytics/travelers'),
    ]).then(([tRes, dRes, sRes, tvRes]) => {
      setTrend(tRes.status==='fulfilled'       ? (Array.isArray(tRes.value?.data)  ? tRes.value.data  : []) : []);
      setDeptData(dRes.status==='fulfilled'    ? (Array.isArray(dRes.value?.data)  ? dRes.value.data  : []) : []);
      setStats(sRes.status==='fulfilled'       ? (sRes.value?.data || {})           : {});
      setTopTravelers(tvRes.status==='fulfilled'? (Array.isArray(tvRes.value?.data) ? tvRes.value.data : []) : []);
    }).finally(() => setLoading(false));
  }, []);

  const kpis = [
    { label:'Trips This Month',  value: stats.trips_this_month  || 0,                    icon: Plane,       color:'#6366f1' },
    { label:'Spend This Month',  value: fmt(stats.spend_this_month  || 0),               icon: IndianRupee,  color:'#10b981', isText:true },
    { label:'Avg Trip Cost (All Time)', value: fmt(stats.avg_cost_per_trip || 0),         icon: TrendingUp,  color:'#f59e0b', isText:true },
    { label:'Active Travelers',  value: stats.active_travelers  || 0,                    icon: Users,       color:'#8b5cf6' },
  ];

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Travel Analytics</h1>
        <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Travel spend and trip analysis</p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:24 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <div>
                <p style={{ fontSize:11, color:'#9ca3af', margin:'0 0 8px', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.5px' }}>{k.label}</p>
                <p style={{ fontSize:k.isText?20:28, fontWeight:700, color:'#1f2937', margin:0 }}>{loading?'...':k.value}</p>
              </div>
              <div style={{ background:k.color+'18', borderRadius:10, padding:10, height:'fit-content' }}>
                <k.icon size={20} color={k.color}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:20 }}>
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:20 }}>
          <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:'0 0 16px' }}>Monthly Travel Spend</h2>
          {loading ? <div style={{ height:200, display:'flex', alignItems:'center', justifyContent:'center', color:'#9ca3af' }}>Loading...</div> :
           trend.length === 0 ? <div style={{ height:200, display:'flex', alignItems:'center', justifyContent:'center', color:'#9ca3af', fontSize:13 }}>No trend data yet</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4"/>
                <XAxis dataKey="month" tick={{ fontSize:11 }}/>
                <YAxis tickFormatter={v => fmt(v)} tick={{ fontSize:11 }}/>
                <Tooltip formatter={v=>[fmt(v),'Spend']}/>
                <Line type="monotone" dataKey="total_spend" stroke="#6B3FDB" strokeWidth={2} dot={{ r:3 }} name="Spend"/>
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:20 }}>
          <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:'0 0 16px' }}>Spend by Department</h2>
          {loading ? <div style={{ height:200, display:'flex', alignItems:'center', justifyContent:'center', color:'#9ca3af' }}>Loading...</div> :
           deptData.length === 0 ? <div style={{ height:200, display:'flex', alignItems:'center', justifyContent:'center', color:'#9ca3af', fontSize:13 }}>No data yet</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={deptData} dataKey="total_spend" nameKey="department" cx="50%" cy="50%" outerRadius={80} label={({name,percent})=>`${name} ${(percent*100).toFixed(0)}%`}>
                  {deptData.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Pie>
                <Tooltip formatter={v=>[fmt(v),'Spend']}/>
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {topTravelers.length > 0 && (
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
          <div style={{ padding:'16px 20px', borderBottom:'1px solid #f0f0f4' }}>
            <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:0 }}>Top Travelers</h2>
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Employee','Department','Trips','Total Spend','Avg Per Trip'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topTravelers.map((t,i) => (
                <tr key={i} style={{ borderBottom:'1px solid #f9fafb' }}>
                  <td style={{ padding:'10px 16px', fontWeight:500, color:'#1f2937' }}>{t.employee_name || '—'}</td>
                  <td style={{ padding:'10px 16px', color:'#6b7280' }}>{t.department || '—'}</td>
                  <td style={{ padding:'10px 16px', color:'#374151' }}>{t.trip_count || 0}</td>
                  <td style={{ padding:'10px 16px', fontWeight:600, color:'#1f2937' }}>{fmt(t.total_spend || 0)}</td>
                  <td style={{ padding:'10px 16px', color:'#374151' }}>{fmt(t.avg_spend || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}