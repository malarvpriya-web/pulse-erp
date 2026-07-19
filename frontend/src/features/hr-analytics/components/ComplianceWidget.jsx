import { ShieldAlert, ShieldCheck } from 'lucide-react';

const PRIORITY = {
  high:   { bg:'#fef2f2', border:'#fecaca', dot:'#dc2626', label:'Expires ≤ 14d' },
  medium: { bg:'#fffbeb', border:'#fde68a', dot:'#d97706', label:'Expires ≤ 30d' },
  low:    { bg:'#eff6ff', border:'#bfdbfe', dot:'#2563eb', label:'Expires ≤ 90d' },
};

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

export default function ComplianceWidget({ data = [], loading }) {
  const highCount = data.filter(d => d.priority === 'high').length;

  return (
    <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:'18px 20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
        <ShieldAlert size={14} color="#ef4444" />
        <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>Compliance Tracker</span>
        {highCount > 0 && (
          <span style={{ marginLeft:'auto', fontSize:11, background:'#fef2f2', color:'#dc2626', padding:'2px 8px', borderRadius:6, fontWeight:600 }}>
            {highCount} urgent
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[1,2,3].map(i => <div key={i} style={{ height:14, background:'#f3f4f6', borderRadius:6 }} />)}
        </div>
      ) : data.length === 0 ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'24px 0', color:'#9ca3af', gap:8 }}>
          <ShieldCheck size={28} color="#10b981" />
          <p style={{ margin:0, fontSize:13, color:'#374151', fontWeight:500 }}>All documents valid</p>
          <p style={{ margin:0, fontSize:11, color:'#9ca3af' }}>No documents expiring in the next 90 days</p>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
          {data.slice(0, 6).map(d => {
            const st = PRIORITY[d.priority];
            return (
              <div key={d.id} style={{
                display:'flex', alignItems:'flex-start', gap:9,
                padding:'8px 10px', borderRadius:8,
                background: st.bg, border: `1px solid ${st.border}`,
              }}>
                <span style={{ width:7, height:7, borderRadius:'50%', background:st.dot, flexShrink:0, marginTop:4 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'#374151' }}>
                    {d.employee}
                    <span style={{ fontWeight:400, color:'#9ca3af' }}> · {d.docType}</span>
                  </div>
                  <div style={{ fontSize:11, color:'#6b7280', marginTop:1 }}>
                    {d.department} · Expires {fmtDate(d.expiryDate)}
                    <span style={{ marginLeft:6, fontWeight:600, color: st.dot }}>
                      ({d.daysLeft}d left)
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
          {data.length > 6 && (
            <div style={{ fontSize:11, color:'#9ca3af', textAlign:'center', paddingTop:4 }}>
              +{data.length - 6} more documents expiring
            </div>
          )}
        </div>
      )}
    </div>
  );
}
