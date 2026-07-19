import { LineChart, Line, Tooltip, ResponsiveContainer } from 'recharts';
import { Smile } from 'lucide-react';

export default function SatisfactionCard({ data = {}, loading }) {
  const { score = 0, reviews = 0, satisfied = 0, atRisk = 0, trend = [] } = data;

  const pct = score > 0 ? score.toFixed(1) : '—';
  const engLabel = score >= 80 ? 'High Engagement'
    : score >= 60 ? 'Moderate'
    : score > 0   ? 'Needs Attention'
    : 'No reviews yet';

  const engColor = score >= 80 ? '#166534'
    : score >= 60 ? '#92400e'
    : score > 0   ? '#991b1b'
    : '#9ca3af';

  const engBg = score >= 80 ? '#f0fdf4'
    : score >= 60 ? '#fffbeb'
    : score > 0   ? '#fef2f2'
    : '#f3f4f6';

  return (
    <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:'20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <div style={{ background:'#f0fdf4', borderRadius:8, padding:6 }}>
          <Smile size={14} color="#10b981" />
        </div>
        <span style={{ fontSize:12, color:'#6b7280', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em' }}>
          Engagement Score
        </span>
      </div>
      {loading ? (
        <div style={{ height:80, background:'#f9fafb', borderRadius:8 }} />
      ) : (
        <>
          <div style={{ display:'flex', alignItems:'flex-end', gap:12 }}>
            <div>
              <div style={{ fontSize:36, fontWeight:800, color:'#111827', lineHeight:1 }}>{pct}</div>
              <div style={{ fontSize:10, color:'#9ca3af', marginTop:2 }}>/ 100 avg rating</div>
            </div>
            {trend.length > 1 && (
              <div style={{ flex:1, height:48 }}>
                <ResponsiveContainer width="100%" height={48}>
                  <LineChart data={trend}>
                    <Tooltip formatter={v => [`${v}`, 'Score']} contentStyle={{ fontSize:11, borderRadius:6 }} />
                    <Line type="monotone" dataKey="score" stroke="#10b981" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          <div style={{ marginTop:8, marginBottom:12 }}>
            <span style={{
              fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:6,
              background: engBg, color: engColor,
            }}>{engLabel}</span>
          </div>
          {reviews > 0 && (
            <div style={{ display:'flex', gap:16, paddingTop:10, borderTop:'1px solid #f3f4f6' }}>
              <div>
                <div style={{ fontSize:10, color:'#9ca3af' }}>Reviews</div>
                <div style={{ fontSize:13, fontWeight:700, color:'#6b7280' }}>{reviews}</div>
              </div>
              <div>
                <div style={{ fontSize:10, color:'#9ca3af' }}>Satisfied</div>
                <div style={{ fontSize:13, fontWeight:700, color:'#10b981' }}>{satisfied}</div>
              </div>
              <div>
                <div style={{ fontSize:10, color:'#9ca3af' }}>At Risk</div>
                <div style={{ fontSize:13, fontWeight:700, color:'#ef4444' }}>{atRisk}</div>
              </div>
            </div>
          )}
          {reviews === 0 && (
            <div style={{ fontSize:11, color:'#9ca3af' }}>
              Run performance reviews to track engagement
            </div>
          )}
        </>
      )}
    </div>
  );
}
