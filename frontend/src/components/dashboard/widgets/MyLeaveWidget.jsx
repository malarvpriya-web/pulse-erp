import { useState, useEffect } from 'react';
import api from '@/services/api/client';

const PALETTE = ['#6B3FDB','#10b981','#f59e0b','#3b82f6','#8b5cf6','#ef4444'];

export function MyLeaveWidget({ data: propData }) {
  const [leaves,  setLeaves]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (propData?.leaves?.length) {
      setLeaves(propData.leaves);
      setLoading(false);
      return;
    }
    api.get('/leaves/balance')
      .then(r => {
        const d = r.data;
        setLeaves(Array.isArray(d) ? d : (d?.balances || d?.leaves || []));
      })
      .catch(err => {
        setError(err?.response?.data?.error || 'Failed to load leave balance');
      })
      .finally(() => setLoading(false));
  }, [propData]);


  if (error) return (
    <div className="widget-data">
      <p style={{ color: '#dc2626', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>{error}</p>
    </div>
  );

  if (!leaves.length) return (
    <div className="widget-data">
      <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'12px 0' }}>
        No leave balance data
      </p>
      <button className="btn-primary" style={{ fontSize:13, padding:'9px 14px' }}>Apply Leave</button>
    </div>
  );

  return (
    <div className="widget-data">
      <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
        {leaves.map((l, i) => {
          const total = l.allocated_days ?? l.total ?? l.entitled ?? 0;
          const used  = l.used_days ?? l.used ?? 0;
          const bal   = l.balance != null ? l.balance : (total - used);
          const pct   = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
          const color = PALETTE[i % PALETTE.length];
          return (
            <div key={i}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
                <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>
                  {l.leave_name || l.type || l.leave_type || 'Leave'}
                </span>
                <span style={{ fontSize:13, fontWeight:700, color }}>
                  {bal} days left
                </span>
              </div>
              <div style={{ height:7, background:'#f3f4f6', borderRadius:4, overflow:'hidden' }}>
                <div style={{
                  height:'100%', width:`${pct}%`,
                  background: color, borderRadius:4,
                  transition:'width 0.5s ease',
                }}/>
              </div>
              <div style={{ fontSize:11, color:'#9ca3af', marginTop:3 }}>
                {used} / {total} days used
              </div>
            </div>
          );
        })}
      </div>

      <button className="btn-primary" style={{ fontSize:13, padding:'9px 14px', marginTop:6 }}>
        Apply Leave
      </button>
    </div>
  );
}

export default MyLeaveWidget;
