import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import api from '@/services/api/client';

const PALETTE = ['#6B3FDB','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#14b8a6','#f97316'];
const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 100_000) return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)   return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

export function DeptSpendWidget({ data: propData }) {
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (propData?.departments?.length) {
      setItems(propData.departments);
      setLoading(false);
      return;
    }
    api.get('/finance/expenses/by-dept')
      .then(r => {
        const d = r.data;
        setItems(Array.isArray(d) ? d : (d?.departments || []));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [propData]);


  if (!items.length) return (
    <div className="widget-data">
      <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'16px 0' }}>No department spend data</p>
    </div>
  );

  const chartData = items.map(it => ({
    name:  it.department || it.name,
    value: parseFloat(it.amount || it.value) || 0,
  }));
  const total = chartData.reduce((s, x) => s + x.value, 0);

  return (
    <div className="widget-data">
      <ResponsiveContainer width="100%" height={140}>
        <PieChart>
          <Pie data={chartData} cx="50%" cy="50%" innerRadius={36} outerRadius={56}
            dataKey="value" paddingAngle={3}>
            {chartData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]}/>)}
          </Pie>
          <Tooltip
            formatter={v => [fmt(v), '']}
            contentStyle={{ borderRadius:8, border:'1px solid #e5e7eb', fontSize:12 }}
          />
        </PieChart>
      </ResponsiveContainer>

      <div style={{ display:'flex', flexDirection:'column', gap:5, marginTop:4 }}>
        {chartData.slice(0, 6).map((d, i) => (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ width:8, height:8, borderRadius:2, background:PALETTE[i % PALETTE.length], flexShrink:0 }}/>
            <span style={{ flex:1, fontSize:12, color:'#374151' }}>{d.name}</span>
            <span style={{ fontSize:12, fontWeight:600, color:'#1f2937' }}>{fmt(d.value)}</span>
            <span style={{ fontSize:10, color:'#9ca3af', minWidth:28, textAlign:'right' }}>
              {total ? Math.round(d.value / total * 100) : 0}%
            </span>
          </div>
        ))}
      </div>

      {total > 0 && (
        <div style={{ marginTop:8, paddingTop:8, borderTop:'1px solid #f3f4f6',
          display:'flex', justifyContent:'space-between', fontSize:12 }}>
          <span style={{ color:'#6b7280' }}>Total</span>
          <span style={{ fontWeight:700, color:'#1f2937' }}>{fmt(total)}</span>
        </div>
      )}
    </div>
  );
}

export default DeptSpendWidget;
