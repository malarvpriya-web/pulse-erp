import { AlertCircle } from 'lucide-react';

export default function AbsenteeismCard({ data = {}, loading }) {
  const { rate = 0, avgDays = 0, chronic = 0 } = data;
  const color = rate > 4 ? '#ef4444' : rate > 2.5 ? '#f59e0b' : '#10b981';


  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <AlertCircle size={14} color={color}/>
        <span style={{ fontSize:12, color:'#6b7280', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em' }}>Absenteeism</span>
      </div>
      <div style={{ fontSize:36, fontWeight:800, color, marginBottom:4 }}>{rate.toFixed(1)}%</div>
      <div style={{ display:'flex', gap:16, marginTop:10 }}>
        <div><div style={{ fontSize:11, color:'#9ca3af' }}>Avg Days/Person</div><div style={{ fontSize:15, fontWeight:700, color:'#374151' }}>{avgDays}</div></div>
        <div><div style={{ fontSize:11, color:'#9ca3af' }}>Chronic Absentees</div><div style={{ fontSize:15, fontWeight:700, color:'#ef4444' }}>{chronic}</div></div>
      </div>
    </div>
  );
}
