import { Users } from 'lucide-react';

export default function HeadcountCard({ data = {}, loading }) {
  const { total = 0, active = 0, onLeave = 0, probation = 0, newHires = 0, departures = 0, growth = 0 } = data;


  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <div style={{ background:'#eef2ff', borderRadius:8, padding:6 }}><Users size={14} color="#6366f1"/></div>
        <span style={{ fontSize:12, color:'#6b7280', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em' }}>Headcount</span>
      </div>
      <div style={{ fontSize:36, fontWeight:800, color:'#111827', marginBottom:4 }}>{total}</div>
      <div style={{ fontSize:12, color: growth >= 0 ? '#10b981' : '#ef4444', fontWeight:600, marginBottom:12 }}>
        {growth >= 0 ? '+' : ''}{growth.toFixed(1)}% vs last month
      </div>
      <div style={{ display:'flex', gap:14 }}>
        {[['Active', active, '#10b981'], ['On Leave', onLeave, '#f59e0b'], ['Probation', probation, '#6366f1']].map(([label, val, clr]) => (
          <div key={label}>
            <div style={{ fontSize:11, color:'#9ca3af' }}>{label}</div>
            <div style={{ fontSize:15, fontWeight:700, color: clr }}>{val}</div>
          </div>
        ))}
      </div>
      <div style={{ display:'flex', gap:16, marginTop:10, paddingTop:10, borderTop:'1px solid #f3f4f6' }}>
        <div style={{ fontSize:12, color:'#6b7280' }}>↑ {newHires} hired</div>
        <div style={{ fontSize:12, color:'#6b7280' }}>↓ {departures} departed</div>
      </div>
    </div>
  );
}
