import { Clock } from 'lucide-react';

export default function TimeToHireCard({ data = {}, loading }) {
  const { avgDays = 0, matched = 0, minDays = 0, maxDays = 0 } = data;

  const label = avgDays === 0 ? 'No data yet'
    : avgDays <= 20 ? 'Fast hiring'
    : avgDays <= 45 ? 'On track'
    : 'Needs improvement';

  const labelColor = avgDays === 0 ? '#9ca3af'
    : avgDays <= 20 ? '#166534'
    : avgDays <= 45 ? '#92400e'
    : '#991b1b';

  const labelBg = avgDays === 0 ? '#f3f4f6'
    : avgDays <= 20 ? '#f0fdf4'
    : avgDays <= 45 ? '#fffbeb'
    : '#fef2f2';

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <div style={{ background:'#fffbeb', borderRadius:8, padding:6 }}>
          <Clock size={14} color="#f59e0b" />
        </div>
        <span style={{ fontSize:12, color:'#6b7280', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em' }}>
          Time to Hire
        </span>
      </div>
      {loading ? (
        <div style={{ height:60, background:'#f9fafb', borderRadius:8 }} />
      ) : (
        <>
          <div style={{ fontSize:36, fontWeight:800, color:'#111827', marginBottom:2 }}>
            {avgDays > 0 ? `${avgDays}d` : '—'}
          </div>
          <div style={{ marginBottom:12 }}>
            <span style={{
              fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:6,
              background: labelBg, color: labelColor,
            }}>{label}</span>
          </div>
          {matched > 0 && (
            <div style={{ display:'flex', gap:16, paddingTop:10, borderTop:'1px solid #f3f4f6' }}>
              <div>
                <div style={{ fontSize:10, color:'#9ca3af' }}>Fastest</div>
                <div style={{ fontSize:13, fontWeight:700, color:'#10b981' }}>{minDays}d</div>
              </div>
              <div>
                <div style={{ fontSize:10, color:'#9ca3af' }}>Longest</div>
                <div style={{ fontSize:13, fontWeight:700, color:'#ef4444' }}>{maxDays}d</div>
              </div>
              <div>
                <div style={{ fontSize:10, color:'#9ca3af' }}>Sample</div>
                <div style={{ fontSize:13, fontWeight:700, color:'#6b7280' }}>{matched} hires</div>
              </div>
            </div>
          )}
          {matched === 0 && (
            <div style={{ fontSize:11, color:'#9ca3af' }}>
              Link candidates to employees to track this metric
            </div>
          )}
        </>
      )}
    </div>
  );
}
