import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';

export default function AttritionTrendChart({ data = [], loading }) {

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ fontSize:13, fontWeight:700, color:'#111827', marginBottom:16 }}>Attrition Trend (6M)</div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top:4, right:8, bottom:0, left:-20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6"/>
          <XAxis dataKey="month" tick={{ fontSize:11, fill:'#9ca3af' }}/>
          <YAxis tick={{ fontSize:11, fill:'#9ca3af' }} domain={[0, 'auto']}/>
          <Tooltip formatter={v => [`${v}%`, 'Rate']} contentStyle={{ fontSize:12, borderRadius:8, border:'1px solid #f0f0f4' }}/>
          <ReferenceLine y={10} stroke="#f59e0b" strokeDasharray="4 4" label={{ value:'10%', fill:'#f59e0b', fontSize:10 }}/>
          <Line type="monotone" dataKey="rate" stroke="#6366f1" strokeWidth={2} dot={{ r:3 }} activeDot={{ r:5 }}/>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
