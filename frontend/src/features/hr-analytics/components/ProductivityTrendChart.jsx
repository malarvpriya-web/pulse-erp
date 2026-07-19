import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function ProductivityTrendChart({ data = [], loading }) {

  const latest = data[data.length - 1]?.score || 0;
  const prev   = data[data.length - 2]?.score || 0;
  const delta  = latest - prev;

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:'#111827' }}>Productivity Score</div>
          <div style={{ fontSize:11, color:'#9ca3af' }}>6-month trend (0–100)</div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:22, fontWeight:800, color:'#111827' }}>{latest}</div>
          <div style={{ fontSize:12, color: delta >= 0 ? '#10b981' : '#ef4444', fontWeight:600 }}>
            {delta >= 0 ? '+' : ''}{delta} vs prev
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <AreaChart data={data} margin={{ top:4, right:8, bottom:0, left:-20 }}>
          <defs>
            <linearGradient id="prodGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.2}/>
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6"/>
          <XAxis dataKey="month" tick={{ fontSize:11, fill:'#9ca3af' }}/>
          <YAxis tick={{ fontSize:11, fill:'#9ca3af' }} domain={[50, 100]}/>
          <Tooltip formatter={v => [v, 'Score']} contentStyle={{ fontSize:12, borderRadius:8 }}/>
          <Area type="monotone" dataKey="score" stroke="#6366f1" strokeWidth={2} fill="url(#prodGrad)" dot={{ r:3 }}/>
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
