import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { CheckCircle, XCircle, Clock, Search } from 'lucide-react';

const fmt = n => `₹${Number(n||0).toLocaleString('en-IN')}`;

export default function TravelApprovals() {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [filter,   setFilter]   = useState('Pending');
  const [search,   setSearch]   = useState('');
  const [acting,   setActing]   = useState(null);
  const [toast,    setToast]    = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = () => {
    setLoading(true);
    api.get('/travel/approvals', { params: { status: filter === 'All' ? undefined : filter } })
      .then(r => setRequests(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filter]);

  const act = async (id, status) => {
    setActing(id);
    try {
      await api.put(`/travel/requests/${id}/status`, { status });
      load();
      showToast(`Travel request ${status.toLowerCase()} successfully`);
    } catch (err) {
      showToast(err?.response?.data?.error || 'Action failed. Please try again.', 'error');
    } finally { setActing(null); }
  };

  const filtered = requests.filter(r =>
    !search || [r.employee, r.destination, r.purpose].some(v => (v||'').toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      {toast && (
        <div style={{ position:'fixed', top:16, right:16, zIndex:9999, padding:'10px 18px', borderRadius:8, fontWeight:600, fontSize:13,
          background: toast.type === 'success' ? '#d1fae5' : '#fee2e2',
          color:      toast.type === 'success' ? '#065f46' : '#991b1b' }}>
          {toast.msg}
        </div>
      )}
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Travel Approvals</h1>
        <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Review and action travel requests</p>
      </div>

      <div style={{ display:'flex', gap:12, marginBottom:20 }}>
        <div style={{ position:'relative', flex:1 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        {['Pending','Approved','Rejected','All'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            style={{ padding:'7px 14px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500, cursor:'pointer',
              borderColor: filter===s ? '#6B3FDB':'#e5e7eb',
              background:  filter===s ? '#6B3FDB':'#fff',
              color:       filter===s ? '#fff'   :'#374151' }}>{s}</button>
        ))}
      </div>

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No requests found.</div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Request #','Employee','Destination','Purpose','Dates','Budget','Status','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                  <td style={{ padding:'10px 16px', fontWeight:600, color:'#6B3FDB' }}>{r.requestNo || `TR-${String(r.id).padStart(3,'0')}`}</td>
                  <td style={{ padding:'10px 16px', color:'#1f2937', fontWeight:500 }}>{r.employee || r.employee_name || '—'}</td>
                  <td style={{ padding:'10px 16px', color:'#374151' }}>{r.destination || r.toCity || '—'}</td>
                  <td style={{ padding:'10px 16px', color:'#6b7280', maxWidth:140, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.purpose || '—'}</td>
                  <td style={{ padding:'10px 16px', color:'#374151', whiteSpace:'nowrap' }}>
                    {(r.from_date || r.travelDate || '').slice(0,10)} → {(r.to_date || r.returnDate || '').slice(0,10)}
                  </td>
                  <td style={{ padding:'10px 16px', color:'#374151' }}>{fmt(r.budget || r.estimatedBudget)}</td>
                  <td style={{ padding:'10px 16px' }}>
                    <span style={{
                      background: r.status==='Pending'?'#fef3c7':r.status==='Approved'?'#d1fae5':'#fee2e2',
                      color:      r.status==='Pending'?'#92400e':r.status==='Approved'?'#065f46':'#991b1b',
                      padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600
                    }}>{r.status}</span>
                  </td>
                  <td style={{ padding:'10px 16px' }}>
                    {r.status === 'Pending' && (
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => act(r.id, 'Approved')} disabled={acting===r.id}
                          style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#d1fae5', color:'#065f46', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>
                          <CheckCircle size={13}/> Approve
                        </button>
                        <button onClick={() => act(r.id, 'Rejected')} disabled={acting===r.id}
                          style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#fee2e2', color:'#991b1b', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>
                          <XCircle size={13}/> Reject
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}