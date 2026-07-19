import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, CheckCircle, XCircle, RefreshCw, Clock, AlertTriangle, X } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';

const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const STATUS_COLOR = {
  pending:  { bg:'#fef3c7', color:'#92400e' },
  approved: { bg:'#d1fae5', color:'#065f46' },
  rejected: { bg:'#fee2e2', color:'#991b1b' },
  used:     { bg:'#f3f4f6', color:'#6b7280' },
};
const sc = s => STATUS_COLOR[(s||'').toLowerCase()] || STATUS_COLOR.pending;

const ADMIN_ROLES = new Set(['admin','super_admin','hr','hr_manager','hr_exec']);

function RequestModal({ holidays, projects, onSave, onClose }) {
  const [form, setForm]     = useState({ work_date: '', hours_worked: 8, holiday_id: '', reason: '', project_id: '' });
  const [err, setErr]       = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.work_date) { setErr('Work date is required'); return; }
    if (!form.reason.trim()) { setErr('Reason is required'); return; }
    setSaving(true); setErr('');
    try {
      await onSave(form);
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || 'Failed to submit');
    } finally { setSaving(false); }
  };

  const inp = { width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, outline:'none', boxSizing:'border-box' };

  return (
    <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center' }}
      onClick={onClose}>
      <div style={{ background:'#fff',borderRadius:14,padding:28,width:480,maxWidth:'95vw' }} onClick={e=>e.stopPropagation()}>
        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20 }}>
          <h3 style={{ margin:0,fontSize:16,fontWeight:700,color:'#1f2937' }}>Request Comp Off</h3>
          <button onClick={onClose} style={{ background:'none',border:'none',cursor:'pointer',color:'#6b7280',fontSize:20 }}>×</button>
        </div>

        <div style={{ background:'#fef9c3',border:'1px solid #fde68a',borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:12,color:'#713f12',display:'flex',gap:8,alignItems:'flex-start' }}>
          <AlertTriangle size={14} style={{ flexShrink:0,marginTop:1 }}/>
          <span>Submit this form for days you worked during a holiday or weekend. Your manager will approve and the comp off will be credited to your leave balance automatically.</span>
        </div>

        {[
          { label:'Date Worked *', key:'work_date', type:'date' },
          { label:'Hours Worked', key:'hours_worked', type:'number', min:1, max:24, placeholder:'8' },
        ].map(f => (
          <div key={f.key} style={{ marginBottom:14 }}>
            <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>{f.label}</label>
            <input {...f} style={inp} value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} />
          </div>
        ))}

        {holidays.length > 0 && (
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Link to Holiday (optional)</label>
            <select value={form.holiday_id} onChange={e=>setForm(p=>({...p,holiday_id:e.target.value}))} style={inp}>
              <option value="">None (weekend / ad-hoc work)</option>
              {holidays.map(h => <option key={h.id} value={h.id}>{h.name} — {fmt(h.date)}</option>)}
            </select>
          </div>
        )}

        {projects.length > 0 && (
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Project (optional)</label>
            <select value={form.project_id} onChange={e=>setForm(p=>({...p,project_id:e.target.value}))} style={inp}>
              <option value="">None</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name || p.project_name}</option>)}
            </select>
          </div>
        )}

        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Reason / Nature of Work *</label>
          <textarea rows={3} value={form.reason} onChange={e=>setForm(p=>({...p,reason:e.target.value}))}
            placeholder="Describe what you worked on…"
            style={{ ...inp, resize:'vertical' }}/>
        </div>

        {err && <div style={{ color:'#ef4444',fontSize:12,marginBottom:12 }}>{err}</div>}

        <div style={{ display:'flex',gap:10,justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'8px 18px',border:'1px solid #e5e7eb',borderRadius:8,background:'#fff',fontSize:13,cursor:'pointer',color:'#6b7280' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding:'8px 18px',background:'#6366f1',color:'#fff',border:'none',borderRadius:8,fontWeight:600,fontSize:13,cursor:'pointer',opacity:saving?0.6:1 }}>
            {saving ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CompOffPage() {
  const { user, hasAnyRole } = useAuth();
  const toast    = useToast();
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set. These flags drive the Employee column and the Actions column, so gating
  // on it alone stripped both from a secondary-role approver. See AuthContext.
  const isAdmin  = hasAnyRole(...ADMIN_ROLES);
  const isManager = isAdmin || hasAnyRole('manager', 'team_lead', 'department_head', 'l2_approver');

  const [records,  setRecords]  = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [projects, setProjects] = useState([]);
  const [balance,  setBalance]  = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [acting,   setActing]   = useState(null);
  const [comment,  setComment]  = useState({});
  const [showModal, setShowModal] = useState(false);
  const [fStatus,  setFStatus]  = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true; return ()=>{ mounted.current=false; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [recs, bal] = await Promise.allSettled([
        api.get('/comp-off', { params: fStatus ? { status:fStatus } : {} }),
        api.get(`/comp-off/balance/${user?.employee_id}`),
      ]);
      if (mounted.current) {
        setRecords(recs.status==='fulfilled' ? (Array.isArray(recs.value.data)?recs.value.data:[]) : []);
        setBalance(bal.status==='fulfilled' ? bal.value.data : null);
      }
    } catch {
      if (mounted.current) setRecords([]);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user?.employee_id, fStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/holidays', { params:{ year:new Date().getFullYear(), upcoming:'1' } })
      .then(r => setHolidays(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
    api.get('/projects', { params:{ status:'active', limit:200 } })
      .then(r => setProjects(Array.isArray(r.data) ? r.data : (r.data?.data || [])))
      .catch(() => {});
  }, []);

  const submitRequest = async (form) => {
    await api.post('/comp-off', {
      work_date:    form.work_date,
      hours_worked: Number(form.hours_worked) || 8,
      holiday_id:   form.holiday_id || null,
      reason:       form.reason.trim(),
      project_id:   form.project_id || null,
    });
    toast.success('Comp off request submitted');
    load();
  };

  const act = async (id, action) => {
    const c = comment[id] || '';
    if (action === 'reject' && !c.trim()) { toast.error('Rejection reason is required'); return; }
    setActing(id);
    try {
      await api.post(`/comp-off/${action}/${id}`, { comments: c });
      toast.success(action === 'approve' ? 'Comp off approved — balance credited' : 'Request rejected');
      setComment(p => { const n={...p}; delete n[id]; return n; });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Action failed');
    } finally {
      if (mounted.current) setActing(null);
    }
  };

  const pendingCount = records.filter(r => r.status === 'pending').length;

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      {showModal && <RequestModal holidays={holidays} projects={projects} onSave={submitRequest} onClose={() => setShowModal(false)} />}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Compensatory Off</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Earn comp off for working on holidays and weekends</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={load} style={{ display:'flex',alignItems:'center',gap:5,padding:'8px 14px',border:'1px solid #e5e7eb',borderRadius:8,background:'#fff',fontSize:13,cursor:'pointer' }}>
            <RefreshCw size={13}/> Refresh
          </button>
          <button onClick={() => setShowModal(true)}
            style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 18px',background:'#6366f1',color:'#fff',border:'none',borderRadius:8,fontWeight:600,fontSize:13,cursor:'pointer' }}>
            <Plus size={14}/> Request Comp Off
          </button>
        </div>
      </div>

      {/* Balance cards */}
      {balance && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:14, marginBottom:24 }}>
          {[
            { label:'Available Days', value:Number(balance.available_days||0).toFixed(1), color:'#10b981', bg:'#d1fae5' },
            { label:'Pending Requests', value:balance.pending_requests||0, color:'#f59e0b', bg:'#fef9c3' },
            { label:'Earned Credits', value:balance.available_credits||0, color:'#6366f1', bg:'#eef2ff' },
            { label:'Expired', value:balance.expired_credits||0, color:'#ef4444', bg:'#fee2e2' },
          ].map(({ label, value, color, bg }) => (
            <div key={label} style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', padding:'16px 18px' }}>
              <div style={{ fontSize:12, color:'#6b7280', fontWeight:600, marginBottom:6 }}>{label}</div>
              <div style={{ fontSize:28, fontWeight:800, color }}>{value}</div>
              <div style={{ height:4, background:bg, borderRadius:2, marginTop:8 }}/>
            </div>
          ))}
        </div>
      )}

      {/* Status filter */}
      <div style={{ display:'flex', gap:8, marginBottom:16 }}>
        {[['','All'],['pending','Pending'],['approved','Approved'],['rejected','Rejected'],['used','Used/Expired']].map(([v,l]) => (
          <button key={v} onClick={() => setFStatus(v)}
            style={{ padding:'6px 14px', borderRadius:20, border:`1.5px solid ${fStatus===v?'#6366f1':'#e5e7eb'}`, background:fStatus===v?'#eef2ff':'#fff', color:fStatus===v?'#6366f1':'#6b7280', fontSize:12, fontWeight:600, cursor:'pointer' }}>
            {l}{v==='pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', overflow:'auto' }}>
        {loading ? (
          <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
        ) : records.length === 0 ? (
          <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>
            <Clock size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p style={{ margin:0 }}>No comp off records found</p>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {[isAdmin&&'Employee', 'Work Date', 'Hours', 'Holiday', 'Reason', 'Expires On', 'Status', isManager&&'Actions'].filter(Boolean).map(h => (
                  <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap', fontSize:12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => {
                const s = sc(r.status);
                const creditDays = Number(r.hours_worked||8) >= 8 ? 1 : 0.5;
                const isExpiringSoon = r.expires_on && new Date(r.expires_on) < new Date(Date.now() + 14*86400000);
                return (
                  <tr key={r.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    {isAdmin && <td style={{ padding:'10px 14px', fontWeight:500 }}>{r.employee_name||'—'}<br/><span style={{ color:'#9ca3af',fontSize:11 }}>{r.department||''}</span></td>}
                    <td style={{ padding:'10px 14px' }}>{fmt(r.work_date)}</td>
                    <td style={{ padding:'10px 14px', textAlign:'center' }}>
                      {r.hours_worked}h
                      <br/><span style={{ fontSize:10, color:'#6366f1', fontWeight:600 }}>+{creditDays}d</span>
                    </td>
                    <td style={{ padding:'10px 14px', fontSize:12, color:'#6b7280' }}>{r.holiday_name||'—'}</td>
                    <td style={{ padding:'10px 14px', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'#6b7280', fontSize:12 }} title={r.reason}>{r.reason||'—'}</td>
                    <td style={{ padding:'10px 14px' }}>
                      {r.expires_on ? (
                        <span style={{ color:isExpiringSoon?'#ef4444':'#6b7280', fontWeight:isExpiringSoon?700:400, fontSize:12 }}>
                          {fmt(r.expires_on)}{isExpiringSoon ? ' ⚠' : ''}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      <span style={{ ...s, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700 }}>
                        {(r.status||'pending').charAt(0).toUpperCase()+(r.status||'pending').slice(1)}
                      </span>
                    </td>
                    {isManager && (
                      <td style={{ padding:'10px 14px' }}>
                        {r.status === 'pending' ? (
                          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                            <input value={comment[r.id]||''} onChange={e=>setComment(p=>({...p,[r.id]:e.target.value}))}
                              placeholder="Comment…"
                              style={{ padding:'4px 8px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:11, width:110 }}/>
                            <button onClick={() => act(r.id,'approve')} disabled={acting===r.id}
                              style={{ display:'flex',alignItems:'center',gap:3,padding:'4px 8px',background:'#d1fae5',color:'#065f46',border:'none',borderRadius:6,cursor:'pointer',fontSize:11,fontWeight:600,opacity:acting===r.id?0.5:1 }}>
                              <CheckCircle size={11}/> {acting===r.id?'…':'Approve'}
                            </button>
                            <button onClick={() => act(r.id,'reject')} disabled={acting===r.id}
                              style={{ display:'flex',alignItems:'center',gap:3,padding:'4px 8px',background:'#fee2e2',color:'#991b1b',border:'none',borderRadius:6,cursor:'pointer',fontSize:11,fontWeight:600,opacity:acting===r.id?0.5:1 }}>
                              <XCircle size={11}/> {acting===r.id?'…':'Reject'}
                            </button>
                          </div>
                        ) : (
                          <span style={{ color:'#9ca3af', fontSize:12 }}>{r.approved_by_name ? `By ${r.approved_by_name}` : '—'}</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
