import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Plus, CheckCircle, XCircle, RefreshCw, Clock, AlertTriangle, X,
  CalendarDays,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';

const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const STATUS_COLOR = {
  pending:  { bg:'#ede9fe', color:'#5b21b6' },
  approved: { bg:'#d1fae5', color:'#065f46' },
  rejected: { bg:'#fee2e2', color:'#991b1b' },
  used:     { bg:'#f3f4f6', color:'#6b7280' },
};
const sc = s => STATUS_COLOR[(s||'').toLowerCase()] || STATUS_COLOR.pending;

const ADMIN_ROLES = new Set(['admin','super_admin','hr','hr_manager','hr_exec']);

// Mirrors creditDaysFor() in backend/src/shared/compOff.js — 8h+ a full day,
// 4h+ a half day, under 4h nothing. The old preview claimed half a day for any
// stint under 8h, so a 1h entry advertised a credit the server would refuse.
const creditDaysFor = h => {
  const n = Number(h);
  if (!Number.isFinite(n) || n < 4) return 0;
  return n >= 8 ? 1 : 0.5;
};

function RequestModal({ holidays, projects, onSave, onClose }) {
  const [form, setForm]     = useState({ work_date: '', hours_worked: 8, holiday_id: '', reason: '', project_id: '' });
  const [err, setErr]       = useState('');
  const [saving, setSaving] = useState(false);
  // Eligibility comes from the server so the rule lives in one place: the
  // company's configured weekend days plus its holiday calendar. Checking here
  // means the employee sees "Wednesday is a working day" while picking the
  // date, instead of filling the form out and losing it to a 422 on submit.
  const [elig, setElig] = useState(null);
  const [checking, setChecking] = useState(false);

  const today = new Date().toLocaleDateString('en-CA');

  useEffect(() => {
    const date = form.work_date;
    if (!date) { setElig(null); return; }
    let alive = true;
    setChecking(true);
    const t = setTimeout(() => {
      api.get('/comp-off/eligibility', { params: { date } })
        .then(r => { if (alive) setElig(r.data); })
        // A failed probe must not block submission — let the server decide.
        .catch(() => { if (alive) setElig(null); })
        .finally(() => { if (alive) setChecking(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [form.work_date]);

  const credit    = creditDaysFor(form.hours_worked);
  const blocked   = elig?.eligible === false || credit === 0;

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

        <div style={{ background:'#ede9fe',border:'1px solid #ddd6fe',borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:12,color:'#4c1d95',display:'flex',gap:8,alignItems:'flex-start' }}>
          <AlertTriangle size={14} style={{ flexShrink:0,marginTop:1 }}/>
          <span>Submit this form for days you worked during a holiday or weekend. Your manager will approve and the comp off will be credited to your leave balance automatically.</span>
        </div>

        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Date Worked *</label>
          {/* max=today: comp off is claimed for work already done. */}
          <input type="date" max={today} style={inp} value={form.work_date}
            onChange={e=>setForm(p=>({...p, work_date:e.target.value, holiday_id:'' }))} />
          {form.work_date && (
            <div style={{ marginTop:6, fontSize:11.5, fontWeight:600,
              color: checking ? '#9ca3af' : elig?.eligible === false ? '#b91c1c' : elig?.eligible ? '#047857' : '#9ca3af' }}>
              {checking ? 'Checking…' : elig?.reason || ''}
            </div>
          )}
        </div>

        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Hours Worked</label>
          <input type="number" min={1} max={24} placeholder="8" style={inp} value={form.hours_worked}
            onChange={e=>setForm(p=>({...p,hours_worked:e.target.value}))} />
          <div style={{ marginTop:6, fontSize:11.5, fontWeight:600, color: credit === 0 ? '#b91c1c' : '#4c1d95' }}>
            {credit === 0 ? 'Under 4 hours earns no comp off.' : `Earns ${credit} day${credit === 1 ? '' : 's'} of comp off.`}
          </div>
        </div>

        {holidays.length > 0 && (
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Link to Holiday (optional)</label>
            {/* Picking a holiday fills the date too — otherwise the two fields
                could disagree and the server would judge the date, not the link. */}
            <select value={form.holiday_id} style={inp}
              onChange={e=>{
                const h = holidays.find(x => String(x.id) === e.target.value);
                setForm(p => ({ ...p, holiday_id: e.target.value, work_date: h ? String(h.date).slice(0,10) : p.work_date }));
              }}>
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
          <button onClick={handleSave} disabled={saving || blocked}
            title={blocked ? (elig?.reason || 'Under 4 hours earns no comp off.') : undefined}
            style={{ padding:'8px 18px',background:'#6366f1',color:'#fff',border:'none',borderRadius:8,fontWeight:600,fontSize:13,cursor:(saving||blocked)?'not-allowed':'pointer',opacity:(saving||blocked)?0.5:1 }}>
            {saving ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CompOffPage() {
  const { hasAnyRole } = useAuth();
  const toast    = useToast();
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set. These flags drive the Employee column and the Actions column, so gating
  // on it alone stripped both from a secondary-role approver. See AuthContext.
  const isAdmin  = hasAnyRole(...ADMIN_ROLES);
  const isManager = isAdmin || hasAnyRole('manager', 'department_head', 'l2_approver');

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
      // /comp-off/summary, not /balance/:employee_id — the strip must describe
      // the same rows as the table below it. Keyed on one employee, it read
      // "Pending Requests 0" above a chip reading "Pending (2)" for any admin
      // whose login has no employees row (superadmin@ has none).
      const [recs, bal] = await Promise.allSettled([
        api.get('/comp-off', { params: fStatus ? { status:fStatus } : {} }),
        api.get('/comp-off/summary'),
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
  }, [fStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Comp off is claimed for work ALREADY DONE, so the holidays worth listing
    // are the ones behind us. This asked for `upcoming:'1'` (date >= today), so
    // the only holidays the dropdown ever offered were ones nobody could have
    // worked yet — you could never link a claim to the Independence Day you
    // actually worked. Load this year and last, and keep the past ones.
    const yr = new Date().getFullYear();
    Promise.all([
      api.get('/holidays', { params:{ year: yr } }).catch(() => ({ data: [] })),
      api.get('/holidays', { params:{ year: yr - 1 } }).catch(() => ({ data: [] })),
    ]).then(([a, b]) => {
      const all = [...(Array.isArray(a.data) ? a.data : []), ...(Array.isArray(b.data) ? b.data : [])];
      const today = new Date().toLocaleDateString('en-CA');
      setHolidays(
        all.filter(h => String(h.date).slice(0, 10) <= today)
           .sort((x, y) => String(y.date).localeCompare(String(x.date)))
      );
    }).catch(() => {});
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
    <PageShell dock={
      <PageHero
        icon={CalendarDays}
        eyebrow="Leave"
        title="Compensatory Off"
        subtitle="Earn comp off for working on holidays and weekends"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={load}>
            <RefreshCw size={13}/> Refresh
          </button>
          <button className="plh-cta" onClick={() => setShowModal(true)}>
            <Plus size={14}/> Request Comp Off
          </button>
        </>}
      />
    }>
      {showModal && <RequestModal holidays={holidays} projects={projects} onSave={submitRequest} onClose={() => setShowModal(false)} />}

      {/* Header */}


      {/* Balance cards */}
      {balance && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:14, marginBottom:24 }}>
          {/* The prefix says whose numbers these are, so a company-wide total is
              never mistaken for the viewer's own balance. */}
          {(() => {
            const p = balance.scope === 'company' ? 'Company ' : balance.scope === 'team' ? 'Team ' : '';
            return [
            { label:`${p}Available Days`, value:Number(balance.available_days||0).toFixed(1), color:'#10b981', bg:'#d1fae5' },
            { label:`${p}Pending Requests`, value:balance.pending_requests||0, color:'#7c5cf0', bg:'#ede9fe' },
            { label:`${p}Earned Credits`, value:balance.available_credits||0, color:'#6366f1', bg:'#eef2ff' },
            { label:`${p}Expired`, value:balance.expired_credits||0, color:'#ef4444', bg:'#fee2e2' },
          ]; })().map(({ label, value, color, bg }) => (
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
                const creditDays = creditDaysFor(r.hours_worked ?? 8);
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
    </PageShell>
  );
}
