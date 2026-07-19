import { UserCheck, AlertCircle } from 'lucide-react';

const P = '#7c3aed';
const LIGHT = '#f5f3ff';
const BORDER = '#e9e4ff';

function daysLabel(n) {
  if (n === 0) return 'Today';
  if (n === 1) return '1 day ago';
  return `${n}d ago`;
}

function probationDaysLeft(probEnd) {
  if (!probEnd) return null;
  const days = Math.ceil((new Date(probEnd) - Date.now()) / 86400000);
  return days;
}

export default function OnboardingWidget({ data = {}, loading }) {
  const { total = 0, confirmingSoon = 0, joined30d = 0, joined7d = 0, recentHires = [] } = data;

  return (
    <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'18px 20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
        <UserCheck size={14} color={P} />
        <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>Onboarding Pipeline</span>
        {total > 0 && (
          <span style={{ marginLeft:'auto', fontSize:11, background:LIGHT, color:P, padding:'2px 8px', borderRadius:6, fontWeight:600 }}>
            {total} in progress
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[1,2,3].map(i => (
            <div key={i} style={{ height:14, background:'#f3f4f6', borderRadius:6, width: i===2?'60%':i===3?'40%':'100%' }} />
          ))}
        </div>
      ) : total === 0 ? (
        <div style={{ textAlign:'center', padding:'24px 0', color:'#9ca3af' }}>
          <UserCheck size={28} color="#d1d5db" style={{ margin:'0 auto 8px', display:'block' }} />
          <div style={{ fontSize:13 }}>No new hires in the last 90 days</div>
        </div>
      ) : (
        <>
          {/* Summary chips */}
          <div style={{ display:'flex', gap:10, marginBottom:14, flexWrap:'wrap' }}>
            {[
              { label:'This week',  value: joined7d,        color:'#10b981', bg:'#f0fdf4' },
              { label:'This month', value: joined30d,       color:'#6366f1', bg:'#eef2ff' },
              { label:'Confirming soon', value: confirmingSoon, color:'#d97706', bg:'#fffbeb' },
            ].map(c => (
              <div key={c.label} style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'6px 12px', background:c.bg, borderRadius:8, minWidth:70 }}>
                <span style={{ fontSize:18, fontWeight:800, color:c.color, lineHeight:1 }}>{c.value}</span>
                <span style={{ fontSize:10, color:'#6b7280', marginTop:2, whiteSpace:'nowrap' }}>{c.label}</span>
              </div>
            ))}
          </div>

          {/* Recent hires list */}
          {recentHires.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {recentHires.slice(0, 5).map(h => {
                const dLeft = probationDaysLeft(h.probationEnd);
                const urgent = dLeft !== null && dLeft <= 7 && dLeft >= 0;
                return (
                  <div key={h.id} style={{
                    display:'flex', alignItems:'center', gap:10,
                    padding:'7px 10px', borderRadius:8,
                    background: urgent ? '#fffbeb' : LIGHT,
                    border: `1px solid ${urgent ? '#fde68a' : BORDER}`,
                  }}>
                    <div style={{
                      width:30, height:30, borderRadius:'50%', background:P,
                      color:'#fff', display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:11, fontWeight:700, flexShrink:0,
                    }}>
                      {h.name.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, fontWeight:600, color:'#374151', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {h.name}
                      </div>
                      <div style={{ fontSize:11, color:'#9ca3af' }}>
                        {h.department} · {daysLabel(h.daysIn)}
                      </div>
                    </div>
                    {urgent && (
                      <AlertCircle size={13} color="#d97706" title={`Probation ends in ${dLeft} days`} />
                    )}
                    {dLeft !== null && !urgent && dLeft >= 0 && (
                      <span style={{ fontSize:10, color:'#9ca3af', whiteSpace:'nowrap' }}>
                        {dLeft}d left
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
