import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

export default function HeadcountTrendChart({ data = [], loading }) {
  const last = data[data.length - 1]?.headcount ?? 0;
  const first = data[0]?.headcount ?? 0;
  const growth = first > 0 ? (((last - first) / first) * 100).toFixed(1) : 0;

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 }}>
        <div style={{ fontSize:13, fontWeight:700, color:'#111827' }}>Headcount Trend (12M)</div>
        {data.length > 0 && (
          <span style={{
            fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:6,
            background: growth >= 0 ? '#f0fdf4' : '#fef2f2',
            color: growth >= 0 ? '#166534' : '#991b1b',
          }}>
            {growth >= 0 ? '+' : ''}{growth}% YoY
          </span>
        )}
      </div>
      {loading ? (
        <div style={{ height:180, background:'#f9fafb', borderRadius:8, marginTop:12 }} />
      ) : data.length === 0 ? (
        <div style={{ height:180, display:'flex', alignItems:'center', justifyContent:'center', color:'#9ca3af', fontSize:13 }}>
          No headcount data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={data} margin={{ top:8, right:8, bottom:0, left:-20 }}>
            <defs>
              <linearGradient id="hcGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.18} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="month" tick={{ fontSize:10, fill:'#9ca3af' }} />
            <YAxis tick={{ fontSize:10, fill:'#9ca3af' }} allowDecimals={false} />
            <Tooltip
              formatter={v => [v, 'Headcount']}
              contentStyle={{ fontSize:12, borderRadius:8, border:'1px solid #f0f0f4' }}
            />
            <Area
              type="monotone" dataKey="headcount" stroke="#6366f1" strokeWidth={2}
              fill="url(#hcGrad)" dot={{ r:3 }} activeDot={{ r:5 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
