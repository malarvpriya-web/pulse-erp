import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const COLORS = ['#6366f1', '#ec4899', '#06b6d4'];

export default function GenderDistributionChart({ data = [], loading }) {
  const total = data.reduce((s, d) => s + (d.value || 0), 0);


  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ fontSize:13, fontWeight:700, color:'#111827', marginBottom:4 }}>Gender Distribution</div>
      <div style={{ fontSize:11, color:'#9ca3af', marginBottom:12 }}>Total: {total} employees</div>
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={45} outerRadius={65} paddingAngle={3} dataKey="value">
            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]}/>)}
          </Pie>
          <Tooltip formatter={(v, n) => [`${v} (${((v/total)*100).toFixed(0)}%)`, n]} contentStyle={{ fontSize:12, borderRadius:8 }}/>
          <Legend wrapperStyle={{ fontSize:11 }}/>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
