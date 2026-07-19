import { useState } from 'react';
import { Maximize2, X } from 'lucide-react';

export default function ChartCard({ title, children, color = '#6366f1', height = 260 }) {
  const [expanded, setExpanded] = useState(false);

  const header = (showClose = false) => (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 16px', borderBottom:`3px solid ${color}`, background:color+'10', flexShrink:0 }}>
      <span style={{ fontSize:13, fontWeight:700, color }}>{title}</span>
      <button
        onClick={() => showClose ? setExpanded(false) : setExpanded(true)}
        title={showClose ? "Close" : "Expand"}
        style={{ background:'none', border:'none', cursor:'pointer', padding:'2px 6px', borderRadius:4, color, display:'flex', alignItems:'center' }}
      >
        {showClose ? <X size={16} /> : <Maximize2 size={14} />}
      </button>
    </div>
  );

  return (
    <>
      <div style={{ background:'#fff', borderRadius:12, boxShadow:'0 1px 6px rgba(0,0,0,0.08)', overflow:'hidden', display:'flex', flexDirection:'column' }}>
        {header(false)}
        <div style={{ padding:'12px 4px 8px', height }}>{children}</div>
      </div>

      {expanded && (
        <div
          style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}
          onClick={() => setExpanded(false)}
        >
          <div
            style={{ background:'#fff', borderRadius:16, width:'90vw', maxWidth:1100, height:'80vh', display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'0 30px 80px rgba(0,0,0,0.3)' }}
            onClick={e => e.stopPropagation()}
          >
            {header(true)}
            <div style={{ flex:1, padding:'16px 12px', minHeight:0 }}>{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
