import { Trophy } from 'lucide-react';

const RATING_COLOR = {
  Exceptional: { bg:'#fef3c7', text:'#92400e' },
  Exceeds:     { bg:'#dcfce7', text:'#15803d' },
  Meets:       { bg:'#f3f4f6', text:'#374151' },
};

export default function TopPerformersTable({ data = [], loading, onSelect }) {

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16 }}>
        <Trophy size={14} color="#f59e0b"/>
        <span style={{ fontSize:13, fontWeight:700, color:'#111827' }}>Top Performers</span>
      </div>
      {data.map((p, i) => {
        const rc = RATING_COLOR[p.rating] || RATING_COLOR['Meets'];
        return (
          <div key={p.id} style={{ display:'flex', alignItems:'center', gap:12, paddingBottom:10, borderBottom: i < data.length-1 ? '1px solid #f9fafb' : 'none', marginBottom: i < data.length-1 ? 10 : 0 }}>
            <div style={{ width:24, height:24, borderRadius:'50%', background: i===0?'#fef3c7':i===1?'#f3f4f6':'#fff7ed', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color: i===0?'#92400e':i===1?'#6b7280':'#c2410c', flexShrink:0 }}>
              {i+1}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <button onClick={() => onSelect && onSelect(p)} style={{ background:'none', border:'none', padding:0, cursor:'pointer', fontSize:13, fontWeight:600, color:'#111827', textAlign:'left', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'100%' }}>
                {p.name}
              </button>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{p.dept}</div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
              <span style={{ fontSize:11, padding:'2px 8px', borderRadius:10, background:rc.bg, color:rc.text, fontWeight:600 }}>{p.rating}</span>
              <span style={{ fontSize:14, fontWeight:700, color:'#374151' }}>{p.score}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
