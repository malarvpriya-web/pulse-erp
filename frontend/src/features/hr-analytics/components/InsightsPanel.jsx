import { AlertCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react';

const TYPE_CONFIG = {
  danger:  { icon: AlertCircle,   bg:'#fee2e2', border:'#fca5a5', text:'#991b1b', iconColor:'#ef4444' },
  warning: { icon: AlertTriangle, bg:'#fef3c7', border:'#fcd34d', text:'#92400e', iconColor:'#f59e0b' },
  success: { icon: CheckCircle,   bg:'#dcfce7', border:'#86efac', text:'#15803d', iconColor:'#10b981' },
  info:    { icon: Info,          bg:'#dbeafe', border:'#93c5fd', text:'#1d4ed8', iconColor:'#3b82f6' },
};

export default function InsightsPanel({ insights = [], loading }) {

  if (!insights.length) return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ fontSize:13, fontWeight:700, color:'#111827', marginBottom:12 }}>HR Insights</div>
      <div style={{ textAlign:'center', padding:'20px 0', color:'#9ca3af', fontSize:13 }}>All metrics healthy — no alerts.</div>
    </div>
  );

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ fontSize:13, fontWeight:700, color:'#111827', marginBottom:12 }}>HR Insights</div>
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {insights.map((ins, i) => {
          const cfg = TYPE_CONFIG[ins.type] || TYPE_CONFIG.info;
          const Icon = cfg.icon;
          return (
            <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', background:cfg.bg, border:`1px solid ${cfg.border}`, borderRadius:8, padding:'10px 12px' }}>
              <Icon size={14} color={cfg.iconColor} style={{ flexShrink:0, marginTop:1 }}/>
              <span style={{ fontSize:12, color:cfg.text, lineHeight:1.5 }}>{ins.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
