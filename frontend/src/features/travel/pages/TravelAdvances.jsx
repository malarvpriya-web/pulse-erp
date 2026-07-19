import { useState, useEffect, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { fmtDate } from '@/utils/dateFormatter';
import {
  Plus, X, Search, Wallet, FileText, RefreshCcw, Banknote,
  CheckCircle2, XCircle, Download, MessageSquare, SlidersHorizontal,
} from 'lucide-react';
import { STATUS_COLOR, fmt } from './travelUtils';

const EMPTY = { amount:'', purpose:'', required_by:'', travel_request_id:'', document_link:'' };
const FINANCE_ROLES = ['admin', 'super_admin', 'finance'];
const MANAGER_ROLES = ['admin', 'super_admin', 'manager', 'hr'];
const PAGE_SIZES = [10, 25, 50, 100];

const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const btnStyle = (bg, color='#fff') => ({ display:'inline-flex', alignItems:'center', gap:4, padding:'5px 10px', background:bg, color, border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 });
const th = { padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' };
const td = { padding:'10px 12px', color:'#374151', whiteSpace:'nowrap' };

export default function TravelAdvances() {
  const toast = useToast();
  const { user, hasAnyRole } = useAuth();
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the approve/disburse actions from anyone
  // holding finance/manager as a secondary role. See AuthContext.
  const isFinance = hasAnyRole(...FINANCE_ROLES);
  const isManager = hasAnyRole(...MANAGER_ROLES);
  const myId = user?.userId ?? user?.id;

  const [advances, setAdvances] = useState([]);
  const [requests, setRequests] = useState([]);
  const [statusOpts, setStatusOpts] = useState([]);
  const [yearOpts,   setYearOpts]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [resubmitId, setResubmitId] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [search,   setSearch]   = useState('');
  const [review,   setReview]   = useState(null);
  const [reviewComments, setReviewComments] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [remarksFor, setRemarksFor] = useState(null);

  // Draft filters are what the dropdowns hold; `applied` is what the last Load
  // actually fetched. Keeping them apart is what makes the Load button mean
  // something rather than being decorative.
  const [draft,   setDraft]   = useState({ status:'All', year:'All' });
  const [applied, setApplied] = useState({ status:'All', year:'All' });
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const load = useCallback((filters) => {
    setLoading(true);
    api.get('/travel/advances', { params: {
      status: filters.status === 'All' ? undefined : filters.status,
      year:   filters.year   === 'All' ? undefined : filters.year,
    } })
      .then(r => setAdvances(Array.isArray(r.data) ? r.data : []))
      .catch(() => setAdvances([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(applied);
    api.get('/travel/advances/statuses').then(r => setStatusOpts(Array.isArray(r.data) ? r.data : [])).catch(() => setStatusOpts([]));
    api.get('/travel/advances/years').then(r => setYearOpts(Array.isArray(r.data) ? r.data : [])).catch(() => setYearOpts([]));
    api.get('/travel/my-entries')
      .then(r => setRequests((Array.isArray(r.data) ? r.data : []).filter(t => t.status !== 'Rejected' && t.status !== 'Cancelled')))
      .catch(() => setRequests([]));
    // Intentionally mount-only: later fetches go through the Load button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoad = () => { setApplied(draft); setPage(1); load(draft); };

  const openNewForm = () => { setResubmitId(null); setForm(EMPTY); setShowForm(true); };
  const openResubmit = (a) => {
    setResubmitId(a.id);
    setForm({
      amount: a.amount || '', purpose: a.purpose || '',
      required_by: (a.required_by || '').toString().slice(0, 10),
      travel_request_id: a.travel_request_id || '',
      document_link: a.document_link || '',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.amount || !form.purpose) return;
    if (!resubmitId && !form.travel_request_id) {
      toast.error('Please select the travel request this advance is for');
      return;
    }
    setSaving(true);
    try {
      if (resubmitId) {
        await api.put(`/travel/advances/${resubmitId}/resubmit`, { ...form, amount: Number(form.amount) });
        toast.success('Advance resubmitted to Finance');
      } else {
        await api.post('/travel/advances', { ...form, amount: Number(form.amount) });
        toast.success('Advance request sent to Finance for review');
      }
      setShowForm(false); setForm(EMPTY); setResubmitId(null); load(applied);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Save failed. Please try again.');
    } finally { setSaving(false); }
  };

  const handleReview = async (decision) => {
    if (!review) return;
    if (review.step === 'finance' && decision === 'Rejected' && !reviewComments.trim()) {
      toast.error('Comments are required when rejecting');
      return;
    }
    setSaving(true);
    try {
      if (review.step === 'disburse') {
        await api.put(`/travel/advances/${review.advance.id}/disburse`, {
          payment_ref: paymentRef || null,
          payment_date: new Date().toISOString().slice(0, 10),
        });
        toast.success('Advance released');
      } else {
        await api.put(`/travel/advances/${review.advance.id}/${review.step}-review`, {
          status: decision, comments: reviewComments || null,
        });
        toast.success(decision === 'Approved'
          ? (review.step === 'finance' ? 'Approved — forwarded to Manager' : 'Advance approved')
          : 'Advance rejected');
      }
      setReview(null); setReviewComments(''); setPaymentRef(''); load(applied);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Action failed');
    } finally { setSaving(false); }
  };

  const filtered = useMemo(() => advances.filter(a =>
    !search || [a?.purpose, a?.employee_name, a?.request_number].some(v => (v||'').toLowerCase().includes(search.toLowerCase()))
  ), [advances, search]);

  // Reset to page 1 whenever the search shrinks the set below the current page.
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [filtered.length, pageSize, page]);

  const total = filtered.length;
  const from  = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to    = Math.min(page * pageSize, total);
  const pageRows = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  // Title names whose entries are on screen: one distinct employee → that name;
  // several → "All employees". Beats hardcoding the logged-in user, who often
  // isn't the person being looked at.
  const whose = useMemo(() => {
    const names = [...new Set(advances.map(a => a?.employee_name).filter(Boolean))];
    if (names.length === 1) return names[0];
    if (names.length === 0) return user?.name || 'you';
    return 'all employees';
  }, [advances, user]);

  const pendingStatuses = ['Pending Finance', 'Pending Manager'];
  const totalPending = advances.filter(a => pendingStatuses.includes(a?.status)).reduce((s,a) => s+Number(a?.amount||0), 0);
  const totalOutstanding = advances
    .filter(a => ['Disbursed','Partially Settled'].includes(a?.status))
    .reduce((s,a) => s + (Number(a?.amount||0) - Number(a?.settled_amount||0)), 0);

  const commentsOf = (a) => (a.status === 'Finance Rejected' || a.status === 'Pending Manager')
    ? a.finance_comments
    : (a.manager_comments || a.finance_comments);

  // The expense split rolls up claims filed against the trip. With no claims
  // yet every figure is a legitimate 0 — rendering "—" keeps "nothing claimed"
  // visually distinct from "claimed, and it came to zero".
  const hasClaims = (a) => Number(a?.total_expense || 0) > 0;
  // Payable still means something with no claims: an advance paid against a trip
  // nobody has claimed for is a recovery owed back, and shows negative.
  const hasPayable = (a) => hasClaims(a) || Number(a?.advance_paid_trip || 0) > 0;

  const exportExcel = () => {
    if (!filtered.length) { toast.error('Nothing to export'); return; }
    const rowsOut = filtered.map(a => ({
      ID:              a.id,
      Name:            a.employee_name || '',
      Start:           fmtDate(a.travel_from),
      End:             fmtDate(a.travel_to),
      Days:            a.days ?? '',
      Status:          a.status || '',
      Purpose:         a.purpose || '',
      Type:            a.travel_type || '',
      Ref:             a.request_number || '',
      Total:           Number(a.total_expense || 0),
      Payable:         Number(a.payable || 0),
      Company:         Number(a.company_expense || 0),
      Personal:        Number(a.personal_expense || 0),
      'Adv Requested': Number(a.amount || 0),
      'Adv Paid':      a.payment_date ? Number(a.amount || 0) : 0,
      'Adv Paid on':   fmtDate(a.payment_date),
      'Adv Ref':       a.payment_ref || '',
      Settled:         Number(a.settled_amount || 0),
      Outstanding:     Number(a.amount || 0) - Number(a.settled_amount || 0),
      Comments:        commentsOf(a) || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rowsOut);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Advances');
    XLSX.writeFile(wb, `travel_advances_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const actionsFor = (a) => {
    const acts = [];
    if (isFinance && a.status === 'Pending Finance')
      acts.push(<button key="fr" onClick={() => setReview({ advance:a, step:'finance' })} style={btnStyle('#6B3FDB')}><CheckCircle2 size={12}/> Finance Review</button>);
    if (isManager && a.status === 'Pending Manager')
      acts.push(<button key="mr" onClick={() => setReview({ advance:a, step:'manager' })} style={btnStyle('#6B3FDB')}><CheckCircle2 size={12}/> Manager Review</button>);
    if (isFinance && a.status === 'Approved')
      acts.push(<button key="db" onClick={() => setReview({ advance:a, step:'disburse' })} style={btnStyle('#065f46')}><Banknote size={12}/> Release Advance</button>);
    if (a.status === 'Finance Rejected' && (a.employee_id === myId || a.created_by === myId))
      acts.push(<button key="rs" onClick={() => openResubmit(a)} style={btnStyle('#92400e')}><RefreshCcw size={12}/> Resubmit</button>);
    if (commentsOf(a))
      acts.push(<button key="rm" onClick={() => setRemarksFor(a)} style={btnStyle('#f3f4f6', '#374151')}><MessageSquare size={12}/> Remarks</button>);
    return acts.length ? acts : <span style={{ color:'#9ca3af' }}>—</span>;
  };

  const COLS = ['ID','Name','Start','End','Days','Status','Purpose','Type','Ref',
    'Total','Payable','Company','Personal',
    'Adv Requested','Adv Paid','Adv Paid on','Adv Ref','Settled','Outstanding','Actions'];

  return (
    <div style={{ padding:24, background:'var(--color-bg-page)', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>
            Travel entries of {whose}
          </h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
            {advances.filter(a => pendingStatuses.includes(a.status)).length} in approval · {fmt(totalPending)} pending · {fmt(totalOutstanding)} released &amp; unsettled
          </p>
        </div>
        <button onClick={openNewForm}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> Request Advance
        </button>
      </div>

      {/* Filter panel */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:16, marginBottom:16, display:'flex', gap:14, alignItems:'flex-end', flexWrap:'wrap' }}>
        <div style={{ minWidth:180 }}>
          <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>
            <SlidersHorizontal size={12}/> Status
          </label>
          <select value={draft.status} onChange={e => setDraft(p => ({ ...p, status:e.target.value }))} style={inputStyle}>
            <option value="All">All statuses</option>
            {statusOpts.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ minWidth:140 }}>
          <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Year</label>
          <select value={draft.year} onChange={e => setDraft(p => ({ ...p, year:e.target.value }))} style={inputStyle}>
            <option value="All">All years</option>
            {yearOpts.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button onClick={handleLoad} disabled={loading}
          style={{ padding:'9px 22px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:loading?'wait':'pointer', fontSize:13, fontWeight:600, opacity:loading?.6:1 }}>
          {loading ? 'Loading…' : 'Load'}
        </button>
        <div style={{ flex:1 }}/>
        <div style={{ position:'relative', minWidth:260 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search purpose, employee, TR number..."
            style={{ ...inputStyle, paddingLeft:32 }}/>
        </div>
        <button onClick={exportExcel}
          style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#fff', color:'#374151', border:'1px solid #e5e7eb', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Download size={14}/> Excel
        </button>
      </div>

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div> : (
          <>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ background:'#f9fafb' }}>
                    {COLS.map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={COLS.length} style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
                        <Wallet size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
                        No data available in table
                      </td>
                    </tr>
                  ) : pageRows.map((a, i) => {
                    const sc = STATUS_COLOR[a.status] || STATUS_COLOR.Pending;
                    const outstanding = Number(a.amount||0) - Number(a.settled_amount||0);
                    return (
                      <tr key={a.id||i} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                        <td style={{ ...td, color:'#6b7280' }}>{a.id}</td>
                        <td style={{ ...td, fontWeight:500, color:'#1f2937' }}>{a.employee_name||'—'}</td>
                        <td style={td}>{fmtDate(a.travel_from)}</td>
                        <td style={td}>{fmtDate(a.travel_to)}</td>
                        <td style={{ ...td, textAlign:'center' }}>{a.days ?? '—'}</td>
                        <td style={td}>
                          <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{a.status||'Pending'}</span>
                          {Number(a.resubmission_count) > 0 && <span style={{ marginLeft:6, fontSize:11, color:'#6b7280' }}>(×{a.resubmission_count})</span>}
                        </td>
                        <td style={{ ...td, maxWidth:160, overflow:'hidden', textOverflow:'ellipsis' }} title={a.purpose||''}>{a.purpose||'—'}</td>
                        <td style={td}>{a.travel_type||'—'}</td>
                        <td style={td} title={a.destination||''}>
                          {a.request_number ? `${a.request_number}${a.destination ? ` · ${a.destination}` : ''}` : '—'}
                        </td>
                        <td style={{ ...td, fontWeight:600, color:'#1f2937' }}>{hasClaims(a) ? fmt(a.total_expense) : '—'}</td>
                        <td style={{ ...td, fontWeight:600, color: Number(a.payable) < 0 ? '#991b1b' : '#065f46' }}
                            title={Number(a.payable) < 0 ? 'Advance exceeds company-borne spend — recovery due from employee' : ''}>
                          {hasPayable(a) ? fmt(a.payable) : '—'}
                        </td>
                        <td style={td}>{hasClaims(a) ? fmt(a.company_expense) : '—'}</td>
                        <td style={{ ...td, color: Number(a.personal_expense) > 0 ? '#92400e' : td.color }}>
                          {hasClaims(a) ? fmt(a.personal_expense) : '—'}
                        </td>
                        <td style={{ ...td, fontWeight:600, color:'#1f2937' }}>{fmt(a.amount)}</td>
                        <td style={td}>{a.payment_date ? fmt(a.amount) : '—'}</td>
                        <td style={td}>{fmtDate(a.payment_date)}</td>
                        <td style={td}>
                          {a.payment_ref || '—'}
                          {a.document_link && (
                            <a href={a.document_link} target="_blank" rel="noreferrer" style={{ color:'#6B3FDB', marginLeft:6, display:'inline-flex', verticalAlign:'middle' }} title="Supporting document">
                              <FileText size={13}/>
                            </a>
                          )}
                        </td>
                        <td style={td}>{a.settled_amount ? fmt(a.settled_amount) : '—'}</td>
                        <td style={{ ...td, fontWeight:600, color: outstanding > 0 ? '#92400e' : '#374151' }}>
                          {['Disbursed','Partially Settled'].includes(a.status) && outstanding > 0 ? fmt(outstanding) : '—'}
                        </td>
                        <td style={{ ...td, display:'flex', gap:6 }}>{actionsFor(a)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', borderTop:'1px solid #f0f0f4', flexWrap:'wrap', gap:10 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, color:'#6b7280' }}>
                <span>Show</span>
                <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                  style={{ ...inputStyle, width:'auto', padding:'5px 8px' }}>
                  {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <span>entries</span>
              </div>
              <div style={{ fontSize:13, color:'#6b7280' }}>
                Showing {from} to {to} of {total} entries
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  style={{ padding:'6px 14px', border:'1px solid #e5e7eb', borderRadius:6, background:'#fff', cursor:page<=1?'not-allowed':'pointer', fontSize:13, opacity:page<=1?.5:1 }}>
                  Previous
                </button>
                <button onClick={() => setPage(p => (p * pageSize >= total ? p : p + 1))} disabled={to >= total}
                  style={{ padding:'6px 14px', border:'1px solid #e5e7eb', borderRadius:6, background:'#fff', cursor:to>=total?'not-allowed':'pointer', fontSize:13, opacity:to>=total?.5:1 }}>
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* New / Resubmit form */}
      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:460, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>
                {resubmitId ? 'Resubmit Travel Advance' : 'Request Travel Advance'}
              </h2>
              <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            {resubmitId && (
              <div style={{ background:'#fee2e2', color:'#991b1b', borderRadius:8, padding:'10px 12px', fontSize:12, marginBottom:14 }}>
                <strong>Finance comments:</strong> {advances.find(a => a.id === resubmitId)?.finance_comments || '—'}
              </div>
            )}
            <div style={{ display:'grid', gap:14 }}>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Travel Request *</label>
                <select value={form.travel_request_id} disabled={!!resubmitId}
                  onChange={e => setForm(p=>({...p, travel_request_id:e.target.value}))}
                  style={{ ...inputStyle, background: resubmitId ? '#f3f4f6' : '#fff' }}>
                  <option value="">Select a travel request...</option>
                  {requests.map(t => (
                    <option key={t.id} value={t.id}>
                      TR-{String(t.id).padStart(3,'0')} · {t.purpose || 'Travel'} ({t.status})
                    </option>
                  ))}
                </select>
              </div>
              {[
                { label:'Amount (₹) *',  key:'amount', type:'number', placeholder:'0' },
                { label:'Purpose *',     key:'purpose', placeholder:'Reason for advance' },
                { label:'Required By',   key:'required_by', type:'date' },
                { label:'Supporting Document Link', key:'document_link', placeholder:'https://drive.google.com/...' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>{f.label}</label>
                  <input type={f.type||'text'} value={form[f.key]} onChange={e => setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.placeholder}
                    style={inputStyle}/>
                </div>
              ))}
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving||!form.amount||!form.purpose}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:(saving||!form.amount||!form.purpose)?.6:1 }}>
                {saving ? 'Submitting...' : resubmitId ? 'Resubmit to Finance' : 'Submit to Finance'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remarks viewer */}
      {remarksFor && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}
             onClick={() => setRemarksFor(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:16, padding:28, width:420, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <h2 style={{ fontSize:16, fontWeight:700, color:'#1f2937', margin:0 }}>Remarks</h2>
              <button onClick={() => setRemarksFor(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={18}/></button>
            </div>
            <div style={{ fontSize:13, color:'#374151' }}>
              <div style={{ marginBottom:10, color:'#6b7280' }}>
                {remarksFor.employee_name} · {remarksFor.request_number || 'No TR'} · {fmt(remarksFor.amount)}
              </div>
              {remarksFor.finance_comments && (
                <p style={{ margin:'0 0 10px' }}><strong>Finance:</strong> {remarksFor.finance_comments}</p>
              )}
              {remarksFor.manager_comments && (
                <p style={{ margin:0 }}><strong>Manager:</strong> {remarksFor.manager_comments}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Review / Release modal */}
      {review && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:440, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>
                {review.step === 'finance' ? 'Finance Review' : review.step === 'manager' ? 'Manager Review' : 'Release Advance'}
              </h2>
              <button onClick={() => { setReview(null); setReviewComments(''); setPaymentRef(''); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ background:'#f9fafb', borderRadius:8, padding:'12px 14px', fontSize:13, marginBottom:16, color:'#374151' }}>
              <div><strong>{review.advance.employee_name || '—'}</strong> · {review.advance.request_number || 'No TR'}</div>
              <div style={{ marginTop:4 }}>{review.advance.purpose}</div>
              <div style={{ marginTop:4, fontWeight:700 }}>{fmt(review.advance.amount)}</div>
              {review.step === 'manager' && review.advance.finance_comments && (
                <div style={{ marginTop:6, fontSize:12, color:'#6b7280' }}>Finance: {review.advance.finance_comments}</div>
              )}
              {review.advance.document_link && (
                <a href={review.advance.document_link} target="_blank" rel="noreferrer" style={{ color:'#6B3FDB', fontSize:12, display:'inline-flex', alignItems:'center', gap:4, marginTop:6 }}>
                  <FileText size={12}/> Supporting document
                </a>
              )}
            </div>
            {review.step === 'disburse' ? (
              <>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Payment Reference</label>
                <input value={paymentRef} onChange={e => setPaymentRef(e.target.value)} placeholder="UTR / cheque no."
                  style={{ ...inputStyle, marginBottom:16 }}/>
                <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                  <button onClick={() => setReview(null)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
                  <button onClick={() => handleReview()} disabled={saving}
                    style={{ padding:'9px 18px', background:'#065f46', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                    {saving ? 'Posting...' : 'Confirm Release'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>
                  Comments {review.step === 'finance' && <span style={{ fontWeight:400, color:'#9ca3af' }}>(required if rejecting)</span>}
                </label>
                <textarea value={reviewComments} onChange={e => setReviewComments(e.target.value)} rows={3}
                  placeholder={review.step === 'finance' ? 'e.g. Please attach the approved travel itinerary' : 'Optional remarks'}
                  style={{ ...inputStyle, resize:'vertical', marginBottom:16 }}/>
                <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                  <button onClick={() => handleReview('Rejected')} disabled={saving}
                    style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#fee2e2', color:'#991b1b', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                    <XCircle size={14}/> Reject
                  </button>
                  <button onClick={() => handleReview('Approved')} disabled={saving}
                    style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                    <CheckCircle2 size={14}/> {review.step === 'finance' ? 'Approve → Manager' : 'Approve'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
