import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer,
} from 'recharts';

const BAND_COLORS = ['#6366f1','#8b5cf6','#a78bfa','#c4b5fd','#ddd6fe','#e0e7ff'];

function fmtSalary(n) {
  if (!n) return '—';
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  return `₹${(n / 1000).toFixed(0)}K`;
}

export default function SalaryBandChart({ data = [], loading }) {
  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div style={{ fontSize:13, fontWeight:700, color:'#111827' }}>Salary Distribution</div>
        {total > 0 && <span style={{ fontSize:11, color:'#9ca3af' }}>{total} employees</span>}
      </div>
      {loading ? (
        <div style={{ height:180, background:'#f9fafb', borderRadius:8 }} />
      ) : data.length === 0 ? (
        <div style={{ height:180, display:'flex', alignItems:'center', justifyContent:'center', color:'#9ca3af', fontSize:13 }}>
          No salary data yet
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data} layout="vertical" margin={{ top:0, right:40, left:72, bottom:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
              <XAxis type="number" tick={{ fontSize:10, fill:'#9ca3af' }} allowDecimals={false} />
              <YAxis type="category" dataKey="band" tick={{ fontSize:10, fill:'#6b7280' }} width={70} />
              <Tooltip
                formatter={(v, _, { payload }) => [
                  `${v} employees · Avg ${fmtSalary(payload?.avgSalary)}`,
                  'Band',
                ]}
                contentStyle={{ fontSize:12, borderRadius:8, border:'1px solid #f0f0f4' }}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {data.map((_, i) => <Cell key={i} fill={BAND_COLORS[i % BAND_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ display:'flex', flexWrap:'wrap', gap:'6px 14px', marginTop:10 }}>
            {data.map((d, i) => (
              <div key={d.band} style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'#6b7280' }}>
                <span style={{ width:8, height:8, borderRadius:2, background:BAND_COLORS[i % BAND_COLORS.length], display:'inline-block' }} />
                {d.band} · {total > 0 ? Math.round((d.count / total) * 100) : 0}%
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
