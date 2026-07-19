import { useEffect, useState } from 'react';
import { GitBranch, ChevronRight } from 'lucide-react';
import api from '@/services/api/client';

const P = '#7c3aed';
const DEPT_COLORS = [
  '#7c3aed','#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4',
];

export default function OrgSummaryWidget({ setPage }) {
  const [depts, setDepts]   = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.get('/orgchart/departments')
      .then(r => { if (active) setDepts(r.data?.data || []); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const total = depts.reduce((s, d) => s + (d.count || 0), 0);

  return (
    <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:'18px 20px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <GitBranch size={14} color={P} />
          <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>Org Structure</span>
        </div>
        {setPage && (
          <button
            onClick={() => setPage('OrgChart')}
            style={{ background:'none', border:'none', cursor:'pointer', color:P, fontSize:11, display:'flex', alignItems:'center', gap:3 }}
          >
            Full Chart <ChevronRight size={11} />
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
          {[1,2,3,4].map(i => <div key={i} style={{ height:28, background:'#f3f4f6', borderRadius:6 }} />)}
        </div>
      ) : depts.length === 0 ? (
        <div style={{ textAlign:'center', padding:'24px 0', color:'#9ca3af', fontSize:13 }}>
          <GitBranch size={28} color="#d1d5db" style={{ margin:'0 auto 8px', display:'block' }} />
          No departments configured
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {depts.slice(0, 7).map((d, i) => {
            const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
            const color = DEPT_COLORS[i % DEPT_COLORS.length];
            return (
              <div key={d.department || d.name || i}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3, fontSize:12 }}>
                  <span style={{ color:'#374151', fontWeight:500 }}>{d.department || d.name}</span>
                  <span style={{ color:'#9ca3af' }}>{d.count} · {pct}%</span>
                </div>
                <div style={{ height:5, background:'#f3f4f6', borderRadius:4, overflow:'hidden' }}>
                  <div style={{ width:`${pct}%`, height:'100%', background:color, borderRadius:4, transition:'width 0.4s' }} />
                </div>
              </div>
            );
          })}
          {depts.length > 7 && (
            <div style={{ fontSize:11, color:'#9ca3af', textAlign:'center', paddingTop:2 }}>
              +{depts.length - 7} more departments
            </div>
          )}
          <div style={{ paddingTop:8, borderTop:'1px solid #f3f4f6', fontSize:11, color:'#9ca3af', display:'flex', justifyContent:'space-between' }}>
            <span>{depts.length} departments</span>
            <span>{total} total employees</span>
          </div>
        </div>
      )}
    </div>
  );
}
