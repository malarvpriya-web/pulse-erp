/**
 * LeaveApprovals.jsx — Unified role-aware leave approval page
 *
 * Tabs:
 *  L1 — Manager     : manager role, pending L1 queue
 *  L2 — Dept Head   : department_head/l2_approver roles, L1-approved queue
 *  L3 — HR Final    : hr/hr_manager roles, L2-approved queue
 *  Team View        : all roles, team leave summary with filters
 *
 * Includes: bulk approve, approval history drawer, search, refresh
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  CheckCircle, XCircle, Clock, Search, RefreshCw,
  History, Users, ChevronRight, Filter, UserCheck
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';

const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const STATUS_COLOR = {
  approved: { bg:'#d1fae5', color:'#065f46' },
  rejected: { bg:'#fee2e2', color:'#991b1b' },
  pending:  { bg:'#fef3c7', color:'#92400e' },
  cancelled:{ bg:'#f3f4f6', color:'#6b7280' },
};
const sc = s => STATUS_COLOR[(s||'').toLowerCase()] || STATUS_COLOR.pending;

const ADMIN_ROLES = new Set(['admin','super_admin','hr','hr_manager','hr_exec','hr_admin']);

/* ── Queue definitions ───────────────────────────────────────────────────── */
const QUEUES = [
  {
    id: 'manager',
    label: 'L1 — Manager',
    description: 'Direct reports awaiting your first-level approval',
    roles: ['manager','admin','super_admin','hr_manager'],
    load: async (uid) => {
      const params = { manager_status:'pending', limit:200 };
      if (uid) params.manager_id = uid;
      const r = await api.get('/leaves/applications', { params });
      return Array.isArray(r.data) ? r.data : (r.data?.data || []);
    },
    approve: (id, comment) => api.post(`/leaves/approve/manager/${id}`, { comments: comment }),
    reject:  (id, comment) => api.post(`/leaves/reject/manager/${id}`,  { comments: comment }),
    bulkApprove: async (ids, comment) => {
      const settled = await Promise.allSettled(
        ids.map(id => api.post(`/leaves/approve/manager/${id}`, { comments: comment }))
      );
      return {
        data: {
          results: settled.map((r, i) => ({
            id: ids[i],
            status: r.status === 'fulfilled' ? 'approved' : 'error',
            error: r.reason?.response?.data?.error,
          })),
        },
      };
    },
    requiresComment: false,
  },
  {
    id: 'l2',
    label: 'L2 — Dept Head',
    description: 'L1 approved — awaiting department head decision',
    roles: ['department_head','l2_approver','admin','super_admin','hr_manager'],
    load: async () => {
      const r = await api.get('/leaves/applications', { params: { manager_status:'approved', limit:500 } });
      const all = Array.isArray(r.data) ? r.data : (r.data?.data || []);
      return all.filter(l => !l.l2_status || l.l2_status === 'pending');
    },
    approve: (id, comment) => api.post(`/leaves/approve/l2/${id}`, { comments: comment }),
    reject:  (id, comment) => api.post(`/leaves/reject/l2/${id}`,  { comments: comment }),
    requiresComment: false,
  },
  {
    id: 'hr',
    label: 'L3 — HR Final',
    description: 'L1 + L2 approved — final HR decision required',
    roles: ['hr','hr_manager','admin','super_admin'],
    load: async () => {
      const r = await api.get('/leaves/applications', { params: { manager_status:'approved', limit:500 } });
      const all = Array.isArray(r.data) ? r.data : (r.data?.data || []);
      return all.filter(l =>
        (l.l2_status === 'approved' || !l.l2_status) &&
        (!l.hr_status || l.hr_status === 'pending') &&
        l.status === 'pending'
      );
    },
    approve: (id, comment) => api.post(`/leaves/approve/hr/${id}`, { comments: comment }),
    reject:  (id, comment) => api.post(`/leaves/reject/hr/${id}`,  { comments: comment }),
    bulkApprove: (ids, comment) => api.post('/leaves/bulk-approve', { ids, comments: comment }),
    requiresComment: false,
  },
];

/* ── Approval History Drawer ────────────────────────────────────────────── */
function HistoryDrawer({ leaveId, onClose }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/leaves/applications/${leaveId}/history`)
      .then(r => setHistory(Array.isArray(r.data) ? r.data : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [leaveId]);

  const levelLabel = lvl => ({ 1:'L1 Manager', 2:'L2 Dept Head', 3:'L3 HR', 0:'System' }[lvl] || `Level ${lvl}`);

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:9999, display:'flex', alignItems:'flex-end', justifyContent:'flex-end' }}
      onClick={onClose}>
      <div style={{ width:420, height:'100%', background:'#fff', boxShadow:'-4px 0 20px rgba(0,0,0,0.12)', overflow:'auto', padding:24 }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h3 style={{ margin:0, fontSize:16, fontWeight:700, color:'#1f2937' }}>Approval History</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280', fontSize:20 }}>×</button>
        </div>
        {loading ? (
          <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading…</div>
        ) : history.length === 0 ? (
          <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No approval history yet</div>
        ) : (
          <div style={{ position:'relative' }}>
            {history.map((h, i) => {
              const col = h.action === 'approved' ? '#10b981' : h.action === 'rejected' ? '#ef4444' : '#f59e0b';
              return (
                <div key={h.id} style={{ display:'flex', gap:12, marginBottom:20 }}>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
                    <div style={{ width:32, height:32, borderRadius:'50%', background: col+'22', border:`2px solid ${col}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      {h.action==='approved' ? <CheckCircle size={14} color={col}/> : <XCircle size={14} color={col}/>}
                    </div>
                    {i < history.length - 1 && <div style={{ width:2, flex:1, background:'#e5e7eb', marginTop:4 }}/>}
                  </div>
                  <div style={{ flex:1, paddingBottom:12 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div>
                        <span style={{ fontWeight:600, fontSize:13, color:'#1f2937' }}>{levelLabel(h.approval_level)}</span>
                        <span style={{ marginLeft:8, padding:'1px 8px', borderRadius:20, fontSize:11, fontWeight:600, background:col+'22', color:col }}>
                          {h.action}
                        </span>
                      </div>
                      <span style={{ fontSize:11, color:'#9ca3af', whiteSpace:'nowrap' }}>
                        {fmt(h.created_at)}
                      </span>
                    </div>
                    {h.approver_name && (
                      <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>
                        by {h.approver_name}{h.approver_designation ? ` · ${h.approver_designation}` : ''}
                      </div>
                    )}
                    {h.comments && (
                      <div style={{ marginTop:6, padding:'6px 10px', background:'#f9fafb', borderRadius:6, fontSize:12, color:'#374151', borderLeft:'3px solid #e5e7eb' }}>
                        {h.comments}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Single queue table ──────────────────────────────────────────────────── */
function QueueTable({ queue, uid, toast }) {
  const [data,         setData]         = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [acting,       setActing]       = useState(null);
  const [search,       setSearch]       = useState('');
  const [comment,      setComment]      = useState({});
  const [selected,     setSelected]     = useState(new Set());
  const [bulkComment,  setBulkComment]  = useState('');
  const [historyId,    setHistoryId]    = useState(null);
  const [bulkActing,   setBulkActing]   = useState(false);
  const [delegateLeave,setDelegateLeave]= useState(null); // leave object being delegated
  const [delegateEmpId,setDelegateEmpId]= useState('');
  const [managers,     setManagers]     = useState([]);
  const [delegating,   setDelegating]   = useState(false);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(() => {
    setLoading(true);
    setSelected(new Set());
    queue.load(uid)
      .then(rows => { if (mounted.current) setData(rows); })
      .catch(() => { if (mounted.current) setData([]); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, [uid, queue]);

  useEffect(() => { load(); }, [load]);

  const act = async (id, action) => {
    const c = comment[id] || '';
    if (action === 'reject' && !c.trim()) {
      toast.error('A rejection reason is required');
      return;
    }
    setActing(id);
    try {
      await (action === 'approve' ? queue.approve(id, c) : queue.reject(id, c));
      toast.success(`Leave ${action === 'approve' ? 'approved' : 'rejected'}`);
      setComment(p => { const n = { ...p }; delete n[id]; return n; });
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Action failed');
    } finally {
      if (mounted.current) setActing(null);
    }
  };

  const bulkApprove = async () => {
    if (!queue.bulkApprove || selected.size === 0) return;
    setBulkActing(true);
    try {
      const res = await queue.bulkApprove([...selected], bulkComment || 'Bulk approved');
      const results = res.data?.results || [];
      const ok = results.filter(r => r.status === 'approved').length;
      const err = results.filter(r => r.status === 'error').length;
      toast.success(`${ok} approved${err ? `, ${err} failed` : ''}`);
      setSelected(new Set());
      setBulkComment('');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Bulk approve failed');
    } finally {
      if (mounted.current) setBulkActing(false);
    }
  };

  const openDelegate = async (leave) => {
    setDelegateLeave(leave);
    setDelegateEmpId('');
    if (!managers.length) {
      api.get('/employees', { params: { role: 'manager', status: 'active' } })
        .then(r => setManagers(Array.isArray(r.data) ? r.data : []))
        .catch(() => {});
    }
  };

  const submitDelegate = async () => {
    if (!delegateEmpId) { toast.error('Select a delegate approver'); return; }
    setDelegating(true);
    try {
      await api.post(`/leaves/delegate/${delegateLeave.id}`, { delegate_employee_id: delegateEmpId });
      toast.success('Approval delegated');
      setDelegateLeave(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Delegation failed');
    } finally { setDelegating(false); }
  };

  const toggleSelect = id => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(prev =>
    prev.size === filtered.length ? new Set() : new Set(filtered.map(l => l.id))
  );

  const filtered = data.filter(l => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [l.employee_name, l.leave_name, l.leave_type, l.reason, l.department].some(v => (v||'').toLowerCase().includes(q));
  });

  return (
    <div>
      {historyId && <HistoryDrawer leaveId={historyId} onClose={() => setHistoryId(null)} />}

      {/* Delegate Modal */}
      {delegateLeave && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setDelegateLeave(null)}>
          <div style={{ background:'#fff', borderRadius:12, padding:24, width:400, maxWidth:'90vw', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin:'0 0 4px', fontSize:15, fontWeight:700, color:'#1f2937' }}>Delegate Approval</h3>
            <p style={{ margin:'0 0 16px', fontSize:12, color:'#6b7280' }}>
              Delegate approval of <strong>{delegateLeave.employee_name}</strong>'s {delegateLeave.leave_name || 'leave'} to another manager.
            </p>
            <div style={{ marginBottom:14 }}>
              <label style={{ fontSize:12, fontWeight:600, display:'block', marginBottom:5, color:'#374151' }}>Delegate Approver <span style={{ color:'#ef4444' }}>*</span></label>
              <select value={delegateEmpId} onChange={e => setDelegateEmpId(e.target.value)}
                style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13 }}>
                <option value="">Select a manager…</option>
                {managers.map(m => (
                  <option key={m.id} value={m.id}>
                    {(m.name || `${m.first_name || ''} ${m.last_name || ''}`).trim()} {m.designation ? `— ${m.designation}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button onClick={() => setDelegateLeave(null)}
                style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', fontSize:13, cursor:'pointer', color:'#6b7280' }}>
                Cancel
              </button>
              <button onClick={submitDelegate} disabled={delegating}
                style={{ padding:'8px 16px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer', opacity:delegating?0.6:1 }}>
                {delegating ? 'Delegating…' : 'Delegate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:16, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:'1 1 240px' }}>
          <Search size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search employee, department, type…"
            style={{ width:'100%', padding:'8px 12px 8px 30px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }} />
        </div>
        <span style={{ fontSize:13, color:'#6b7280', whiteSpace:'nowrap' }}>{filtered.length} request{filtered.length!==1?'s':''}</span>
        <button onClick={load} style={{ display:'flex', alignItems:'center', gap:5, padding:'7px 12px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', fontSize:13, cursor:'pointer' }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Bulk approve bar */}
      {queue.bulkApprove && selected.size > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:10, marginBottom:14, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, fontWeight:600, color:'#15803d' }}>{selected.size} selected</span>
          <input value={bulkComment} onChange={e => setBulkComment(e.target.value)}
            placeholder="Optional comment for all…"
            style={{ flex:1, minWidth:160, padding:'6px 10px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:12 }} />
          <button onClick={bulkApprove} disabled={bulkActing}
            style={{ padding:'7px 16px', background:'#16a34a', color:'#fff', border:'none', borderRadius:7, fontWeight:600, fontSize:13, cursor:'pointer', opacity:bulkActing?0.6:1 }}>
            {bulkActing ? 'Approving…' : `Approve All (${selected.size})`}
          </button>
          <button onClick={() => setSelected(new Set())}
            style={{ padding:'7px 12px', background:'none', color:'#6b7280', border:'1px solid #e5e7eb', borderRadius:7, fontSize:12, cursor:'pointer' }}>
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'auto' }}>
        {loading ? (
          <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>
            <Clock size={32} color="#d1d5db" style={{ display:'block', margin:'0 auto 10px' }} />
            <p style={{ margin:0 }}>No pending requests in this queue</p>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, minWidth:700 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {queue.bulkApprove && (
                  <th style={{ padding:'10px 12px', width:36 }}>
                    <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0}
                      onChange={toggleAll} />
                  </th>
                )}
                {['Employee','Dept','Leave Type','Dates','Days','Reason','Approval Chain','Comment','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap', fontSize:12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((l, i) => (
                <tr key={l.id} style={{ borderBottom:'1px solid #f9fafb', background: selected.has(l.id) ? '#f0fdf4' : i%2===0?'#fff':'#fafafa' }}>
                  {queue.bulkApprove && (
                    <td style={{ padding:'8px 12px' }}>
                      <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)} />
                    </td>
                  )}
                  <td style={{ padding:'8px 12px', fontWeight:500 }}>{l.employee_name||'—'}</td>
                  <td style={{ padding:'8px 12px', color:'#6b7280', fontSize:12 }}>{l.department||'—'}</td>
                  <td style={{ padding:'8px 12px' }}>
                    <span style={{ background:'#eef2ff', color:'#4338ca', padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600 }}>
                      {l.leave_name||l.leave_type||'—'}
                    </span>
                  </td>
                  <td style={{ padding:'8px 12px', color:'#374151', fontSize:12 }}>
                    {fmt(l.start_date)} {l.start_date !== l.end_date ? `→ ${fmt(l.end_date)}` : ''}
                  </td>
                  <td style={{ padding:'8px 12px', fontWeight:600, textAlign:'center' }}>{l.number_of_days||l.days||'—'}</td>
                  <td style={{ padding:'8px 12px', color:'#6b7280', maxWidth:130, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:12 }}
                    title={l.reason}>{l.reason||'—'}</td>
                  <td style={{ padding:'8px 12px' }}>
                    <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                      {[['L1', l.manager_status], ['L2', l.l2_status||'—'], ['HR', l.hr_status]].map(([lbl, st]) => {
                        const s = sc(st||'pending');
                        return <span key={lbl} style={{ ...s, padding:'1px 6px', borderRadius:20, fontSize:10, fontWeight:700 }}>{lbl} {(st||'?')}</span>;
                      })}
                    </div>
                  </td>
                  <td style={{ padding:'8px 12px' }}>
                    <input value={comment[l.id]||''} onChange={e => setComment(p => ({...p,[l.id]:e.target.value}))}
                      placeholder="Comment…"
                      style={{ padding:'4px 7px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:11, width:120 }} />
                  </td>
                  <td style={{ padding:'8px 12px' }}>
                    <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                      <button onClick={() => act(l.id,'approve')} disabled={acting===l.id}
                        style={{ display:'flex', alignItems:'center', gap:3, padding:'4px 8px', background:'#d1fae5', color:'#065f46', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600, opacity:acting===l.id?0.5:1 }}>
                        <CheckCircle size={11}/>{acting===l.id?'…':'Approve'}
                      </button>
                      <button onClick={() => act(l.id,'reject')} disabled={acting===l.id}
                        style={{ display:'flex', alignItems:'center', gap:3, padding:'4px 8px', background:'#fee2e2', color:'#991b1b', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600, opacity:acting===l.id?0.5:1 }}>
                        <XCircle size={11}/>{acting===l.id?'…':'Reject'}
                      </button>
                      <button onClick={() => setHistoryId(l.id)} title="View approval history"
                        style={{ padding:'4px 6px', background:'#f3f4f6', border:'none', borderRadius:6, cursor:'pointer', color:'#6b7280', display:'flex', alignItems:'center' }}>
                        <History size={11}/>
                      </button>
                      <button onClick={() => openDelegate(l)} title="Delegate to another approver"
                        style={{ padding:'4px 6px', background:'#eff6ff', border:'none', borderRadius:6, cursor:'pointer', color:'#2563eb', display:'flex', alignItems:'center' }}>
                        <UserCheck size={11}/>
                      </button>
                    </div>
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

/* ── Team View Tab ───────────────────────────────────────────────────────── */
function TeamView({ uid, toast }) {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [fStatus, setFStatus] = useState('');
  const [search,  setSearch]  = useState('');
  const [fMonth,  setFMonth]  = useState('');
  const [historyId, setHistoryId] = useState(null);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const MONTHS = [
    {v:'',l:'All Months'},{v:'1',l:'Jan'},{v:'2',l:'Feb'},{v:'3',l:'Mar'},{v:'4',l:'Apr'},
    {v:'5',l:'May'},{v:'6',l:'Jun'},{v:'7',l:'Jul'},{v:'8',l:'Aug'},
    {v:'9',l:'Sep'},{v:'10',l:'Oct'},{v:'11',l:'Nov'},{v:'12',l:'Dec'},
  ];

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (fStatus) params.status = fStatus;
    if (fMonth)  params.month  = fMonth;
    api.get('/leaves/team', { params })
      .then(r => { if (mounted.current) setData(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (mounted.current) setData([]); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, [fStatus, fMonth]);

  useEffect(() => { load(); }, [load]);

  const displayed = data.filter(l => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [l.employee_name, l.department, l.leave_name, l.leave_type, l.reason].some(v => (v||'').toLowerCase().includes(q));
  });

  const statCounts = { pending:0, approved:0, rejected:0, cancelled:0 };
  data.forEach(l => { if (statCounts[l.status] !== undefined) statCounts[l.status]++; });

  return (
    <div>
      {historyId && <HistoryDrawer leaveId={historyId} onClose={() => setHistoryId(null)} />}

      {/* Summary pills */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        {[['All', data.length,'#6366f1'],['Pending',statCounts.pending,'#f59e0b'],['Approved',statCounts.approved,'#10b981'],['Rejected',statCounts.rejected,'#ef4444']].map(([lbl,cnt,color]) => (
          <button key={lbl}
            onClick={() => setFStatus(lbl === 'All' ? '' : lbl.toLowerCase())}
            style={{ padding:'6px 14px', borderRadius:20, border:`1.5px solid ${fStatus===(lbl==='All'?'':lbl.toLowerCase())?color:'#e5e7eb'}`, background:fStatus===(lbl==='All'?'':lbl.toLowerCase())?color+'15':'#fff', color:fStatus===(lbl==='All'?'':lbl.toLowerCase())?color:'#6b7280', fontSize:12, fontWeight:600, cursor:'pointer' }}>
            {lbl} <strong>{cnt}</strong>
          </button>
        ))}
      </div>

      <div style={{ display:'flex', gap:10, marginBottom:14, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:'1 1 220px' }}>
          <Search size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search employee, department…"
            style={{ width:'100%', padding:'7px 12px 7px 30px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        <select value={fMonth} onChange={e => setFMonth(e.target.value)}
          style={{ padding:'7px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13 }}>
          {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
        </select>
        <button onClick={load} style={{ display:'flex', alignItems:'center', gap:5, padding:'7px 12px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', fontSize:13, cursor:'pointer' }}>
          <RefreshCw size={13}/>
        </button>
      </div>

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'auto' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
        ) : displayed.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}><Users size={32} color="#d1d5db" style={{ display:'block', margin:'0 auto 10px' }}/><p style={{ margin:0 }}>No leave requests found</p></div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, minWidth:600 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Employee','Dept','Type','Dates','Days','Status','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap', fontSize:12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((l, i) => {
                const s = sc(l.status);
                return (
                  <tr key={l.id} style={{ borderBottom:'1px solid #f9fafb', background: i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 12px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:30, height:30, borderRadius:'50%', background:'#eef2ff', color:'#6366f1', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:12, flexShrink:0 }}>
                          {(l.employee_name||'?').charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontWeight:500 }}>{l.employee_name||'—'}</span>
                      </div>
                    </td>
                    <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12 }}>{l.department||'—'}</td>
                    <td style={{ padding:'10px 12px' }}>
                      <span style={{ background:'#eef2ff', color:'#4338ca', padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600 }}>{l.leave_name||l.leave_type||'—'}</span>
                    </td>
                    <td style={{ padding:'10px 12px', fontSize:12, color:'#374151' }}>
                      {fmt(l.start_date)}{l.start_date !== l.end_date ? ` → ${fmt(l.end_date)}` : ''}
                    </td>
                    <td style={{ padding:'10px 12px', fontWeight:700, textAlign:'center' }}>{l.number_of_days||l.days||'—'}</td>
                    <td style={{ padding:'10px 12px' }}>
                      <span style={{ ...s, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700 }}>
                        {(l.status||'pending').charAt(0).toUpperCase()+(l.status||'pending').slice(1)}
                      </span>
                    </td>
                    <td style={{ padding:'10px 12px' }}>
                      <button onClick={() => setHistoryId(l.id)}
                        style={{ display:'flex', alignItems:'center', gap:4, padding:'4px 10px', background:'#f3f4f6', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, color:'#374151' }}>
                        <History size={12}/> History
                      </button>
                    </td>
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

/* ── Main page ─────────────────────────────────────────────────────────────── */
export default function LeaveApprovals({ initialQueue } = {}) {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set. isAdmin decides whether the queue is company-wide or self-scoped, and
  // the queue list decides which approval tabs exist at all — so gating on the
  // primary role alone showed an hr_manager-as-secondary the wrong tabs against
  // the wrong scope. See AuthContext.
  const { user, hasAnyRole } = useAuth();
  const toast    = useToast();
  const isAdmin  = hasAnyRole(...ADMIN_ROLES);
  const uid      = isAdmin ? null : (user?.employee_id ?? user?.userId ?? user?.id);

  // No fallback to QUEUES when nothing matches. This used to read
  //   visibleQueues.length > 0 ? visibleQueues : QUEUES
  // which failed OPEN: a user who matched NO queue role — a plain employee — was
  // shown EVERY approval queue (L1 Manager, L2, HR) rather than none. The API
  // still 403'd the actions, so it surfaced as tabs full of other people's leave
  // that could not be actioned. Matching no queue now correctly means no approval
  // tabs; Team View is appended unconditionally, so there is always one tab left
  // and the page never renders empty.
  const visibleQueues = QUEUES.filter(q => hasAnyRole(...q.roles));
  const allTabs = [...visibleQueues, { id:'team', label:'Team View', description:'All team leave requests' }];
  const defaultTab = initialQueue && allTabs.find(t => t.id === initialQueue)
    ? initialQueue
    : allTabs[0]?.id || 'manager';
  const [activeTab, setActiveTab] = useState(defaultTab);
  const activeQueue = QUEUES.find(q => q.id === activeTab);

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ marginBottom:20 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Leave Approvals</h1>
        <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
          {activeQueue?.description || 'Team leave overview'}
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:'2px solid #e5e7eb', overflowX:'auto' }}>
        {allTabs.map(q => (
          <button key={q.id} onClick={() => setActiveTab(q.id)} style={{
            padding:'9px 20px', fontWeight:activeTab===q.id?700:500, fontSize:14,
            border:'none', background:'none', cursor:'pointer',
            color:     activeTab===q.id ? '#6B3FDB' : '#6b7280',
            borderBottom: activeTab===q.id ? '2px solid #6B3FDB' : '2px solid transparent',
            marginBottom: -2, whiteSpace:'nowrap',
          }}>{q.label}</button>
        ))}
      </div>

      {activeTab === 'team'
        ? <TeamView uid={uid} toast={toast} />
        : activeQueue && <QueueTable key={activeTab} queue={activeQueue} uid={uid} toast={toast} />
      }
    </div>
  );
}
