import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export default function HiringTrendChart({ data = [], loading }) {

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ fontSize:13, fontWeight:700, color:'#111827', marginBottom:16 }}>Hiring vs Departures (6M)</div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top:4, right:8, bottom:0, left:-20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6"/>
          <XAxis dataKey="month" tick={{ fontSize:11, fill:'#9ca3af' }}/>
          <YAxis tick={{ fontSize:11, fill:'#9ca3af' }}/>
          <Tooltip contentStyle={{ fontSize:12, borderRadius:8, border:'1px solid #f0f0f4' }}/>
          <Legend wrapperStyle={{ fontSize:11 }}/>
          <Bar dataKey="hired"    fill="#10b981" radius={[3,3,0,0]} name="Hired"/>
          <Bar dataKey="departed" fill="#f87171" radius={[3,3,0,0]} name="Departed"/>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
