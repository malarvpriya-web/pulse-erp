import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, FileText, X, Search, CheckCircle, XCircle, Send } from 'lucide-react';

const fmt = n => n >= 100000 ? `₹${(n/100000).toFixed(1)}L` : `₹${Number(n||0).toLocaleString('en-IN')}`;

// DB valid statuses: draft | sent | accepted | declined | withdrawn
const STATUS_COLOR = {
  draft:     { bg:'#f3f4f6', color:'#374151' },
  sent:      { bg:'#fef3c7', color:'#92400e' },
  accepted:  { bg:'#d1fae5', color:'#065f46' },
  declined:  { bg:'#fee2e2', color:'#991b1b' },
  withdrawn: { bg:'#e5e7eb', color:'#6b7280' },
};

const EMPTY_FORM = {
  candidate_id: '',
  job_opening_id: '',
  offered_salary: '',
  joining_date: '',
  notes: '',
};

function CreateOfferDrawer({ candidates, openings, onClose, onSaved, showToast }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSave = async () => {
    if (!form.candidate_id)   return showToast('Select a candidate', 'error');
    if (!form.offered_salary) return showToast('Offered salary is required', 'error');
    setSaving(true);
    try {
      await api.post('/recruitment/offers', form);
      showToast('Offer created');
      onSaved();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to create offer', 'error');
    } finally {
      setSaving(false);
    }
  };

  const inp = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
  const lbl = { display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:'.04em' };

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.35)', zIndex:900 }} />
      <div style={{ position:'fixed', top:0, right:0, bottom:0, width:'min(520px,95vw)', background:'#fff', zIndex:901, display:'flex', flexDirection:'column', boxShadow:'-8px 0 40px rgba(0,0,0,.15)' }}>
        <div style={{ padding:'20px 24px', borderBottom:'1px solid #f0f0f8', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontSize:17, fontWeight:800, color:'#111827' }}>Create Offer Letter</div>
          <button onClick={onClose} style={{ background:'#f3f4f6', border:'none', borderRadius:8, padding:8, cursor:'pointer', display:'flex' }}><X size={15} color="#6b7280"/></button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:16 }}>
          <div>
            <label style={lbl}>Candidate *</label>
            <select style={inp} value={form.candidate_id} onChange={e => set('candidate_id', e.target.value)}>
              <option value="">Select candidate…</option>
              {candidates.map(c => <option key={c.id} value={c.id}>{c.full_name} ({c.email})</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Job Opening</label>
            <select style={inp} value={form.job_opening_id} onChange={e => set('job_opening_id', e.target.value)}>
              <option value="">Select opening…</option>
              {openings.map(o => <option key={o.id} value={o.id}>{o.job_title} — {o.department}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Offered Salary (Annual CTC) *</label>
            <input style={inp} type="number" min="0" placeholder="e.g. 600000" value={form.offered_salary} onChange={e => set('offered_salary', e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Joining Date</label>
            <input style={inp} type="date" value={form.joining_date} onChange={e => set('joining_date', e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Notes</label>
            <textarea style={{ ...inp, minHeight:80, resize:'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Any special notes…" />
          </div>
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid #f0f0f8', display:'flex', justifyContent:'flex-end', gap:10, background:'#fafafa' }}>
          <button onClick={onClose} style={{ padding:'8px 18px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f9fafb', color:'#374151', fontWeight:600, cursor:'pointer', fontSize:13 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ padding:'8px 22px', borderRadius:8, border:'none', background:'#4B2DCE', color:'#fff', fontWeight:700, cursor:'pointer', fontSize:13, opacity:saving?0.7:1 }}>
            {saving ? 'Creating…' : 'Create Offer'}
          </button>
        </div>
      </div>
    </>
  );
}

export default function OfferManagement() {
  const toast = useToast();
  const showToast = useCallback((msg, type = 'success') => toast({ message: msg, type }), [toast]);

  const [offers,    setOffers]    = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [openings,  setOpenings]  = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [search,    setSearch]    = useState('');
  const [status,    setStatus]    = useState('All');
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      api.get('/recruitment/offers'),
      api.get('/recruitment/candidates', { params: { overall_status: 'active' } }),
      api.get('/recruitment/openings', { params: { status: 'open' } }),
    ]).then(([offersRes, candsRes, openingsRes]) => {
      setOffers(offersRes.status === 'fulfilled' && Array.isArray(offersRes.value.data) ? offersRes.value.data : []);
      setCandidates(candsRes.status === 'fulfilled' && Array.isArray(candsRes.value.data) ? candsRes.value.data : []);
      setOpenings(openingsRes.status === 'fulfilled' && Array.isArray(openingsRes.value.data) ? openingsRes.value.data : []);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = offers.filter(o => {
    const matchStatus = status === 'All' || o.offer_status === status;
    const matchSearch = !search || [o.candidate_name, o.job_title, o.candidate_email].some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchSearch;
  });

  const updateStatus = async (id, newStatus) => {
    try {
      await api.put(`/recruitment/offers/${id}`, { offer_status: newStatus });
      load();
      showToast(`Offer ${newStatus}`);
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to update offer status.', 'error');
    }
  };

  // Dedicated accept endpoint — also marks candidate as hired and fills position
  const acceptOffer = async (id) => {
    try {
      await api.post(`/recruitment/offers/${id}/accept`);
      load();
      showToast('Offer accepted — candidate marked as hired');
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to accept offer', 'error');
    }
  };

  const STATUS_TABS = ['All', 'draft', 'sent', 'accepted', 'declined', 'withdrawn'];

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Offer Management</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>{filtered.length} offers</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          style={{ display:'flex', alignItems:'center', gap:7, padding:'9px 18px', background:'#4B2DCE', color:'#fff', border:'none', borderRadius:9, cursor:'pointer', fontWeight:700, fontSize:13 }}>
          <Plus size={14} /> New Offer
        </button>
      </div>

      {/* Stats — responsive grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:12, marginBottom:20 }}>
        {['draft','sent','accepted','declined','withdrawn'].map(s => {
          const count = offers.filter(o => o.offer_status === s).length;
          const sc = STATUS_COLOR[s];
          return (
            <div key={s} onClick={() => setStatus(s)} style={{ background:'#fff', borderRadius:10, padding:'14px 16px', border:`2px solid ${status===s?sc.color:'#f0f0f4'}`, cursor:'pointer' }}>
              <p style={{ fontSize:11, color:'#9ca3af', margin:'0 0 4px', textTransform:'capitalize', fontWeight:500 }}>{s}</p>
              <p style={{ fontSize:22, fontWeight:700, color:sc.color, margin:0 }}>{count}</p>
            </div>
          );
        })}
      </div>

      <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:180 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search candidate, position..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {STATUS_TABS.map(s => (
            <button key={s} onClick={() => setStatus(s)}
              style={{ padding:'7px 12px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500, cursor:'pointer', textTransform:'capitalize',
                borderColor:status===s?'#6B3FDB':'#e5e7eb', background:status===s?'#6B3FDB':'#fff', color:status===s?'#fff':'#374151' }}>
              {s === 'All' ? 'All' : s}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'auto' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>
            <FileText size={32} color="#d1d5db" style={{ display:'block', margin:'0 auto 8px' }}/>
            <p>No offers found</p>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Candidate','Position','Annual CTC','Offer Date','Joining Date','Status','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((o, i) => {
                const sc = STATUS_COLOR[o.offer_status] || STATUS_COLOR.draft;
                return (
                  <tr key={o.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 16px', fontWeight:500, color:'#1f2937' }}>{o.candidate_name || '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{o.job_title || '—'}</td>
                    <td style={{ padding:'10px 16px', fontWeight:600, color:'#1f2937' }}>{fmt(o.offered_salary || 0)}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{(o.offer_sent_date||o.created_at||'').slice(0,10)}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{(o.joining_date||'—').toString().slice(0,10)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600, textTransform:'capitalize' }}>{o.offer_status}</span>
                    </td>
                    <td style={{ padding:'10px 16px' }}>
                      <div style={{ display:'flex', gap:6 }}>
                        {o.offer_status === 'draft' && (
                          <button onClick={() => updateStatus(o.id, 'sent')}
                            title="Send offer to candidate"
                            style={{ padding:'4px 8px', background:'#dbeafe', color:'#1d4ed8', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600, display:'flex', alignItems:'center', gap:3 }}>
                            <Send size={11}/> Send
                          </button>
                        )}
                        {o.offer_status === 'sent' && (
                          <>
                            <button onClick={() => acceptOffer(o.id)}
                              style={{ padding:'4px 8px', background:'#d1fae5', color:'#065f46', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600, display:'flex', alignItems:'center', gap:3 }}>
                              <CheckCircle size={11}/> Accept
                            </button>
                            <button onClick={() => updateStatus(o.id, 'declined')}
                              style={{ padding:'4px 8px', background:'#fee2e2', color:'#991b1b', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600, display:'flex', alignItems:'center', gap:3 }}>
                              <XCircle size={11}/> Decline
                            </button>
                          </>
                        )}
                        {['draft','sent'].includes(o.offer_status) && (
                          <button onClick={() => updateStatus(o.id, 'withdrawn')}
                            style={{ padding:'4px 8px', background:'#f3f4f6', color:'#6b7280', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600 }}>
                            Withdraw
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <CreateOfferDrawer
          candidates={candidates}
          openings={openings}
          onClose={() => setCreateOpen(false)}
          onSaved={() => { setCreateOpen(false); load(); }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
