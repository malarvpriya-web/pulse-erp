import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from 'recharts';

export default function DepartmentStrengthChart({ data = [], loading }) {

  const enriched = data.map(d => ({
    ...d,
    fill_pct: d.target ? Math.round((d.headcount / d.target) * 100) : 100,
  }));

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <span style={{ fontSize:13, fontWeight:700, color:'#111827' }}>Dept Headcount vs Target</span>
        <div style={{ display:'flex', gap:12, fontSize:11, color:'#9ca3af' }}>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:10, height:10, borderRadius:2, background:'#6366f1', display:'inline-block' }}/> Actual</span>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:10, height:10, borderRadius:2, background:'#e5e7eb', display:'inline-block' }}/> Target</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={enriched} layout="vertical" margin={{ top:0, right:10, bottom:0, left:60 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false}/>
          <XAxis type="number" tick={{ fontSize:10, fill:'#9ca3af' }}/>
          <YAxis dataKey="dept" type="category" tick={{ fontSize:11, fill:'#374151' }} width={60}/>
          <Tooltip contentStyle={{ fontSize:12, borderRadius:8 }}/>
          <Bar dataKey="target"    fill="#e5e7eb" radius={[0,3,3,0]} name="Target"/>
          <Bar dataKey="headcount" radius={[0,3,3,0]} name="Actual">
            {enriched.map((d, i) => (
              <Cell key={i} fill={d.fill_pct >= 90 ? '#10b981' : d.fill_pct >= 70 ? '#f59e0b' : '#ef4444'}/>
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
