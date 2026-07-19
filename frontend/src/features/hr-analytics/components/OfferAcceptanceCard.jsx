export default function OfferAcceptanceCard({ data = {}, loading }) {
  const { rate = 0, offered = 0, accepted = 0, declined = 0 } = data;
  const color = rate >= 80 ? '#10b981' : rate >= 70 ? '#f59e0b' : '#ef4444';


  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ fontSize:12, color:'#6b7280', fontWeight:600, marginBottom:12, textTransform:'uppercase', letterSpacing:'0.04em' }}>Offer Acceptance</div>
      <div style={{ fontSize:36, fontWeight:800, color, marginBottom:4 }}>{rate}%</div>
      <div style={{ marginTop:8, height:4, background:'#f3f4f6', borderRadius:4 }}>
        <div style={{ width:`${rate}%`, height:'100%', background:color, borderRadius:4 }}/>
      </div>
      <div style={{ display:'flex', gap:16, marginTop:12 }}>
        <div><div style={{ fontSize:11, color:'#9ca3af' }}>Offered</div><div style={{ fontSize:15, fontWeight:700, color:'#374151' }}>{offered}</div></div>
        <div><div style={{ fontSize:11, color:'#9ca3af' }}>Accepted</div><div style={{ fontSize:15, fontWeight:700, color:'#10b981' }}>{accepted}</div></div>
        <div><div style={{ fontSize:11, color:'#9ca3af' }}>Declined</div><div style={{ fontSize:15, fontWeight:700, color:'#ef4444' }}>{declined}</div></div>
      </div>
    </div>
  );
}
