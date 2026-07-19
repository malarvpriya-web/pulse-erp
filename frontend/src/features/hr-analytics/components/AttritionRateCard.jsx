export default function AttritionRateCard({ data = {}, loading }) {
  const { rate = 0, voluntary = 0, involuntary = 0, atRisk = 0 } = data;
  const color = rate > 15 ? '#ef4444' : rate > 10 ? '#f59e0b' : '#10b981';


  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ fontSize:12, color:'#6b7280', fontWeight:600, marginBottom:12, textTransform:'uppercase', letterSpacing:'0.04em' }}>Attrition Rate</div>
      <div style={{ fontSize:36, fontWeight:800, color, marginBottom:4 }}>{rate.toFixed(1)}%</div>
      <div style={{ display:'flex', gap:16, marginTop:10 }}>
        <div>
          <div style={{ fontSize:11, color:'#9ca3af' }}>Voluntary</div>
          <div style={{ fontSize:14, fontWeight:700, color:'#374151' }}>{voluntary.toFixed(1)}%</div>
        </div>
        <div>
          <div style={{ fontSize:11, color:'#9ca3af' }}>Involuntary</div>
          <div style={{ fontSize:14, fontWeight:700, color:'#374151' }}>{involuntary.toFixed(1)}%</div>
        </div>
        <div>
          <div style={{ fontSize:11, color:'#9ca3af' }}>At Risk</div>
          <div style={{ fontSize:14, fontWeight:700, color:'#ef4444' }}>{atRisk}</div>
        </div>
      </div>
      <div style={{ marginTop:10, height:4, background:'#f3f4f6', borderRadius:4 }}>
        <div style={{ width:`${Math.min(rate * 5, 100)}%`, height:'100%', background:color, borderRadius:4, transition:'width 0.4s' }}/>
      </div>
    </div>
  );
}
