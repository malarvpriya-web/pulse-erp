/**
 * LeaveApprovals.jsx — the one place leave decisions are taken, level by level.
 *
 * Tabs:
 *  Manager (L1)     : the approver's direct reports (HR/admin: everyone's L1)
 *  Dept Head (L2)   : only leave types that need a department head
 *  HR (final)       : L1 done (and L2 where the type needs it)
 *  Team View        : every request of the approver's team, any status
 *
 * 2026-11-23 (Leaves review): the L2 and HR queues used to load the same
 * rows (every L1-approved leave showed in both); they are now built on the
 * server (`queue=l2|hr`). Each row shows what the approver needs to decide:
 * the applicant's balance after this leave, the attachment, and who else in
 * the department is off on those dates. HR and anyone allowed to approve sees
 * the Manager tab, so a leave whose employee has no manager is not stuck.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { CheckCircle, XCircle, Clock, Search, RefreshCw, History, Users, UserCheck, CalendarDays, Paperclip } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { ApprovalChain, StatusChip, LeaveHistoryDialog, fmtDate, AttachmentLink } from '../components/leaveShared';
import { useApproverStatus } from '@/features/approvals/approverStatus';

const ADMIN_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'hr_admin'];
const listOf = r => (Array.isArray(r.data) ? r.data : (r.data?.data || []));
const iso = d => String(d || '').slice(0, 10);

/* ── Queue definitions ───────────────────────────────────────────────────── */
const QUEUES = [
  {
    id: 'manager',
    label: 'Manager (L1)',
    // Mirrors the server's L1 rule: the reporting manager / delegate (anyone
    // holding leaves:approve), or HR/admin as override.
    roles: ['manager', 'admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec'],
    orPermission: true,
    load: async () => listOf(await api.get('/leaves/applications', { params: { manager_status: 'pending', status: 'pending', limit: 500 } })),
    approve: (id, c) => api.post(`/leaves/approve/manager/${id}`, { comments: c }),
    reject:  (id, c) => api.post(`/leaves/reject/manager/${id}`, { comments: c }),
    bulkApprove: async (ids, c) => {
      const settled = await Promise.allSettled(ids.map(id => api.post(`/leaves/approve/manager/${id}`, { comments: c })));
      return { data: { results: settled.map((r, i) => ({ id: ids[i], status: r.status === 'fulfilled' ? 'approved' : 'error', error: r.reason?.response?.data?.error })) } };
    },
    delegate: true,
  },
  {
    id: 'l2',
    label: 'Dept Head (L2)',
    roles: ['department_head', 'l2_approver', 'admin', 'super_admin', 'hr_manager'],
    load: async () => listOf(await api.get('/leaves/applications', { params: { queue: 'l2', limit: 500 } })),
    approve: (id, c) => api.post(`/leaves/approve/l2/${id}`, { comments: c }),
    reject:  (id, c) => api.post(`/leaves/reject/l2/${id}`, { comments: c }),
  },
  {
    id: 'hr',
    label: 'HR (final)',
    roles: ['hr', 'hr_manager', 'admin', 'super_admin'],
    load: async () => listOf(await api.get('/leaves/applications', { params: { queue: 'hr', limit: 500 } })),
    approve: (id, c) => api.post(`/leaves/approve/hr/${id}`, { comments: c }),
    reject:  (id, c) => api.post(`/leaves/reject/hr/${id}`, { comments: c }),
    bulkApprove: (ids, c) => api.post('/leaves/bulk-approve', { ids, comments: c }),
  },
];

/* What an approver needs next to each request: balance and who else is off. */
function useDecisionContext(rows) {
  const [balances, setBalances] = useState({});   // employee_id → { leave_type_id → available }
  const [offs, setOffs] = useState([]);           // approved leave overlapping the queue's dates
  useEffect(() => {
    if (!rows.length) { setBalances({}); setOffs([]); return; }
    let live = true;
    const ids = [...new Set(rows.map(r => r.employee_id))];
    Promise.allSettled(ids.map(id => api.get(`/leaves/balance/${id}`))).then(res => {
      if (!live) return;
      const map = {};
      res.forEach((r, i) => {
        if (r.status !== 'fulfilled') return;
        // Days left once everything pending (this request included) is approved.
        // Not available_days: that one is floored at 0 and would hide an overdraw.
        map[ids[i]] = Object.fromEntries((Array.isArray(r.value.data) ? r.value.data : [])
          .map(b => [b.leave_type_id, Number(b.allocated_days) + Number(b.carried_forward_days || 0)
            - Number(b.used_days || 0) - Number(b.pending_days || 0) - Number(b.encashed_days || 0)]));
      });
      setBalances(map);
    });
    const start = rows.map(r => iso(r.start_date)).sort()[0];
    const end = rows.map(r => iso(r.end_date)).sort().slice(-1)[0];
    api.get('/leaves/calendar', { params: { start_date: start, end_date: end } })
      .then(r => { if (live) setOffs(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (live) setOffs([]); });
    return () => { live = false; };
  }, [rows]);
  const othersOff = l => offs.filter(o => o.employee_id !== l.employee_id
    && (!l.department || o.department === l.department)
    && iso(o.start_date) <= iso(l.end_date) && iso(o.end_date) >= iso(l.start_date));
  return { balances, othersOff };
}

/* ── Single queue table ──────────────────────────────────────────────────── */
const STEP_OF = { manager: 'l1', l2: 'l2', hr: 'hr' };

function QueueTable({ queue, toast, me = null, isAdmin = false }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(null);
  const [search, setSearch] = useState('');
  const [comment, setComment] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [bulkComment, setBulkComment] = useState('');
  const [historyId, setHistoryId] = useState(null);
  const [bulkActing, setBulkActing] = useState(false);
  const [delegateLeave, setDelegateLeave] = useState(null);
  const [delegateEmpId, setDelegateEmpId] = useState('');
  const [people, setPeople] = useState([]);
  const [delegating, setDelegating] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(() => {
    setLoading(true);
    setSelected(new Set());
    queue.load()
      .then(rows => { if (mounted.current) setData(rows); })
      .catch(() => { if (mounted.current) setData([]); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, [queue]);
  useEffect(() => { load(); }, [load]);

  const { balances, othersOff } = useDecisionContext(data);

  const act = async (id, action) => {
    const c = comment[id] || '';
    if (action === 'reject' && !c.trim()) { toast.error('Type the reason for rejecting in the Comment box'); return; }
    setActing(id);
    try {
      await (action === 'approve' ? queue.approve(id, c) : queue.reject(id, c));
      toast.success(`Leave ${action === 'approve' ? 'approved' : 'rejected'}`);
      setComment(p => { const n = { ...p }; delete n[id]; return n; });
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Action failed');
    } finally { if (mounted.current) setActing(null); }
  };

  const bulkApprove = async () => {
    if (!queue.bulkApprove || selected.size === 0) return;
    setBulkActing(true);
    try {
      const res = await queue.bulkApprove([...selected], bulkComment || 'Bulk approved');
      const results = res.data?.results || [];
      const ok = results.filter(r => r.status === 'approved').length;
      const failed = results.filter(r => r.status === 'error');
      if (failed.length) toast.error(`${ok} approved, ${failed.length} not: ${failed[0].error || 'see each row'}`);
      else toast.success(`${ok} approved`);
      setSelected(new Set()); setBulkComment(''); load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Bulk approve failed');
    } finally { if (mounted.current) setBulkActing(false); }
  };

  const openDelegate = (leave) => {
    setDelegateLeave(leave); setDelegateEmpId('');
    if (!people.length) {
      api.get('/employees')
        .then(r => setPeople((Array.isArray(r.data) ? r.data : [])
          .filter(e => !['left', 'terminated', 'resigned'].includes(String(e.status || '').toLowerCase()))))
        .catch(() => {});
    }
  };
  const submitDelegate = async () => {
    if (!delegateEmpId) { toast.error('Choose who should decide instead'); return; }
    setDelegating(true);
    try {
      await api.post(`/leaves/delegate/${delegateLeave.id}`, { delegate_employee_id: delegateEmpId });
      toast.success('Approval handed over'); setDelegateLeave(null); load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Delegation failed'); }
    finally { setDelegating(false); }
  };

  const filtered = data.filter(l => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [l.employee_name, l.leave_name, l.reason, l.department].some(v => (v || '').toLowerCase().includes(q));
  });
  const toggleSelect = id => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(l => l.id)));

  return (
    <div>
      {historyId && <LeaveHistoryDialog leaveId={historyId} onClose={() => setHistoryId(null)} />}

      {delegateLeave && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setDelegateLeave(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 420, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#1f2937' }}>Hand over this approval</h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: '#6b7280' }}>
              Someone else decides <strong>{delegateLeave.employee_name}</strong>'s {delegateLeave.leave_name || 'leave'} at the manager step.
            </p>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 5, color: '#374151' }}>Decided by <span style={{ color: '#ef4444' }}>*</span></label>
            <select value={delegateEmpId} onChange={e => setDelegateEmpId(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, marginBottom: 14 }}>
              <option value="">Select a person…</option>
              {people.filter(p => p.id !== delegateLeave.employee_id).map(m => (
                <option key={m.id} value={m.id}>{(m.name || `${m.first_name || ''} ${m.last_name || ''}`).trim()}{m.designation ? ` — ${m.designation}` : ''}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDelegateLeave(null)} className="pulse-btn-secondary">Cancel</button>
              <button onClick={submitDelegate} disabled={delegating} className="pulse-btn-primary">{delegating ? 'Saving…' : 'Hand over'}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px' }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employee, department, type…"
            style={{ width: '100%', padding: '8px 12px 8px 30px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <span style={{ fontSize: 13, color: '#6b7280', whiteSpace: 'nowrap' }}>{filtered.length} waiting</span>
        <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer' }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {queue.bulkApprove && selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#15803d' }}>{selected.size} selected</span>
          <input value={bulkComment} onChange={e => setBulkComment(e.target.value)} placeholder="Optional comment for all…"
            style={{ flex: 1, minWidth: 160, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 }} />
          <button onClick={bulkApprove} disabled={bulkActing}
            style={{ padding: '7px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: bulkActing ? 0.6 : 1 }}>
            {bulkActing ? 'Approving…' : `Approve all (${selected.size})`}
          </button>
          <button onClick={() => setSelected(new Set())} style={{ padding: '7px 12px', background: 'none', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>Clear</button>
        </div>
      )}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
            <Clock size={32} color="#d1d5db" style={{ display: 'block', margin: '0 auto 10px' }} />
            <p style={{ margin: 0 }}>Nothing waiting for you here</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 980 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {queue.bulkApprove && (
                  <th style={{ padding: '10px 12px', width: 36 }}>
                    <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} aria-label="Select all" />
                  </th>
                )}
                {['Employee', 'Leave', 'Dates', 'Days', 'Balance', 'Also off', 'Reason', 'Approval', 'Comment', ''].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((l, i) => {
                const after = balances[l.employee_id]?.[l.leave_type_id] ?? null;
                const lop = l.is_lop ? Number(l.number_of_days) : Number(l.lop_days || 0);
                const others = othersOff(l);
                // HR / admin take the manager step only once it is escalated or
                // there is no manager who can act (server: authorizeL1).
                const waitMgr = queue.id === 'manager' && isAdmin && !l.hr_may_decide_l1
                  && String(l.manager_id) !== String(me) && String(l.delegate_approver_id) !== String(me);
                return (
                  <tr key={l.id} style={{ borderBottom: '1px solid #f9fafb', background: selected.has(l.id) ? '#f0fdf4' : i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    {queue.bulkApprove && (
                      <td style={{ padding: '8px 12px' }}><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)} aria-label={`Select ${l.employee_name}`} /></td>
                    )}
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ fontWeight: 600 }}>{l.employee_name || '—'}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{l.department || ''}</div>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{l.leave_name || '—'}</span>
                      {l.clubbing_flag && <div style={{ fontSize: 10, color: '#b45309', marginTop: 3 }}>Clubbing</div>}
                      {l.escalation_step === STEP_OF[queue.id] && (
                        <div title="Waited longer than Leave Settings → escalate after N days" style={{ fontSize: 10, color: '#b91c1c', fontWeight: 700, marginTop: 3 }}>
                          Escalated {fmtDate(l.escalated_at)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px', color: '#374151', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(l.start_date)}{iso(l.start_date) !== iso(l.end_date) ? ` → ${fmtDate(l.end_date)}` : ''}
                      {l.half_day && <div style={{ fontSize: 10, color: '#6b7280' }}>Half day {l.half_day_session}</div>}
                    </td>
                    <td style={{ padding: '8px 12px', fontWeight: 600, textAlign: 'center' }}>
                      {Number(l.number_of_days) || '—'}
                      {lop > 0 && <div style={{ fontSize: 10, color: '#b91c1c' }}>{lop} LOP</div>}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {l.is_lop ? <span style={{ color: '#6b7280' }}>Unpaid</span>
                        : after == null ? <span style={{ color: '#d1d5db' }}>—</span>
                        : <span style={{ color: after < 0 ? '#dc2626' : '#065f46', fontWeight: 600 }} title="Days left once this and the other pending requests are approved">{after} left after</span>}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 12 }}>
                      {others.length === 0 ? <span style={{ color: '#9ca3af' }}>No one</span>
                        : <span title={others.map(o => `${o.employee_name} (${o.leave_name})`).join(', ')} style={{ color: '#b45309', fontWeight: 600 }}>
                            {others.length} in {l.department || 'team'}
                          </span>}
                    </td>
                    <td style={{ padding: '8px 12px', color: '#6b7280', maxWidth: 160, fontSize: 12 }}>
                      <span title={l.reason} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.reason || '—'}</span>
                      {l.attachment_url && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#6B3FDB' }}>
                          <Paperclip size={10} /><AttachmentLink url={l.attachment_url} />
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px' }}><ApprovalChain leave={l} /></td>
                    <td style={{ padding: '8px 12px' }}>
                      <input value={comment[l.id] || ''} onChange={e => setComment(p => ({ ...p, [l.id]: e.target.value }))}
                        placeholder="Needed to reject" aria-label="Comment"
                        style={{ padding: '4px 7px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 11, width: 130 }} />
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                        title={waitMgr ? `Waiting for ${l.manager_name || 'the reporting manager'}. HR can decide once it is escalated.` : undefined}>
                        <button onClick={() => act(l.id, 'approve')} disabled={acting === l.id || waitMgr}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: acting === l.id ? 0.5 : 1 }}>
                          <CheckCircle size={11} />{acting === l.id ? '…' : 'Approve'}
                        </button>
                        <button onClick={() => act(l.id, 'reject')} disabled={acting === l.id || waitMgr}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: acting === l.id ? 0.5 : 1 }}>
                          <XCircle size={11} />{acting === l.id ? '…' : 'Reject'}
                        </button>
                        <button onClick={() => setHistoryId(l.id)} title="Approval history" aria-label="Approval history"
                          style={{ padding: '4px 6px', background: '#f3f4f6', border: 'none', borderRadius: 6, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center' }}>
                          <History size={11} />
                        </button>
                        {queue.delegate && !waitMgr && (
                          <button onClick={() => openDelegate(l)} title="Hand over to someone else" aria-label="Hand over"
                            style={{ padding: '4px 6px', background: '#f5f3ff', border: 'none', borderRadius: 6, cursor: 'pointer', color: '#6B3FDB', display: 'flex', alignItems: 'center' }}>
                            <UserCheck size={11} />
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
    </div>
  );
}

/* ── Team View Tab ───────────────────────────────────────────────────────── */
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEAR = new Date().getFullYear();

function TeamView() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fStatus, setFStatus] = useState('');
  const [search, setSearch] = useState('');
  const [fMonth, setFMonth] = useState('');
  const [fYear, setFYear] = useState(String(YEAR));
  const [historyId, setHistoryId] = useState(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (fStatus) params.status = fStatus;
    if (fMonth) params.month = fMonth;
    if (fYear) params.year = fYear;
    api.get('/leaves/team', { params })
      .then(r => { if (mounted.current) setData(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (mounted.current) setData([]); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, [fStatus, fMonth, fYear]);
  useEffect(() => { load(); }, [load]);

  const displayed = data.filter(l => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [l.employee_name, l.department, l.leave_name, l.reason].some(v => (v || '').toLowerCase().includes(q));
  });
  const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
  data.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });

  return (
    <div>
      {historyId && <LeaveHistoryDialog leaveId={historyId} onClose={() => setHistoryId(null)} />}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {[['', 'All', data.length], ['pending', 'Pending', counts.pending], ['approved', 'Approved', counts.approved], ['rejected', 'Rejected', counts.rejected], ['cancelled', 'Cancelled', counts.cancelled]].map(([v, lbl, cnt]) => (
          <button key={lbl} onClick={() => setFStatus(v)}
            style={{ padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${fStatus === v ? '#6B3FDB' : '#e5e7eb'}`, background: fStatus === v ? '#f5f3ff' : '#fff', color: fStatus === v ? '#6B3FDB' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {lbl} <strong>{fStatus === v || !fStatus ? cnt : ''}</strong>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 220px' }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employee, department…"
            style={{ width: '100%', padding: '7px 12px 7px 30px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <select value={fMonth} onChange={e => setFMonth(e.target.value)} style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          <option value="">All months</option>{MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select value={fYear} onChange={e => setFYear(e.target.value)} style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          {[YEAR + 1, YEAR, YEAR - 1, YEAR - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={load} aria-label="Refresh" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer' }}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : displayed.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}><Users size={32} color="#d1d5db" style={{ display: 'block', margin: '0 auto 10px' }} /><p style={{ margin: 0 }}>No leave requests found</p></div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 700 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Employee', 'Dept', 'Type', 'Dates', 'Days', 'Status', 'Approval', ''].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((l, i) => (
                <tr key={l.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 500 }}>{l.employee_name || '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>{l.department || '—'}</td>
                  <td style={{ padding: '10px 12px' }}><span style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{l.leave_name || '—'}</span></td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>{fmtDate(l.start_date)}{iso(l.start_date) !== iso(l.end_date) ? ` → ${fmtDate(l.end_date)}` : ''}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 700, textAlign: 'center' }}>{Number(l.number_of_days) || '—'}</td>
                  <td style={{ padding: '10px 12px' }}><StatusChip status={l.status} /></td>
                  <td style={{ padding: '10px 12px' }}><ApprovalChain leave={l} /></td>
                  <td style={{ padding: '10px 12px' }}>
                    <button onClick={() => setHistoryId(l.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#f3f4f6', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#374151' }}>
                      <History size={12} /> History
                    </button>
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

/* ── Main page ─────────────────────────────────────────────────────────────── */
export default function LeaveApprovals({ initialQueue } = {}) {
  // hasAnyRole, not user.role: roles are many-to-many; `role` is only the primary.
  const { hasAnyRole, hasPermission, user } = useAuth();
  const toast = useToast();
  const canApprove = typeof hasPermission === 'function' && hasPermission('leaves', 'approve');
  const isAdmin = hasAnyRole(...ADMIN_ROLES);
  // A reporting manager decides the L1 step by the reporting line alone — no
  // manager role or leaves:approve grant needed (2026-11-24).
  const hasReports = useApproverStatus(true).has_direct_reports === true;

  // A user who matches no queue sees no approval tabs (never all of them);
  // Team View is always there, so the page never renders empty.
  const visibleQueues = QUEUES.filter(q => hasAnyRole(...q.roles) || (q.orPermission && (hasReports || (canApprove && !isAdmin))));
  const allTabs = [...visibleQueues, { id: 'team', label: 'Team View' }];
  const defaultTab = initialQueue && allTabs.find(t => t.id === initialQueue) ? initialQueue : allTabs[0]?.id || 'team';
  const [activeTab, setActiveTab] = useState(defaultTab);
  // The reporting-line answer arrives after the first render; open the Manager
  // tab then, unless the caller asked for a queue or already picked a tab.
  const picked = useRef(false);
  useEffect(() => {
    if (!picked.current && !initialQueue && hasReports && activeTab === 'team') setActiveTab('manager');
  }, [hasReports]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (id) => { picked.current = true; setActiveTab(id); };
  const activeQueue = QUEUES.find(q => q.id === activeTab);

  return (
    <PageShell dock={<PageHero icon={CalendarDays} eyebrow="Leave" title="Leave Approvals"
      subtitle="Manager → HR, with the department head in between for leave types that need one" />}>
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e5e7eb', overflowX: 'auto' }} role="tablist">
        {allTabs.map(q => (
          <button key={q.id} role="tab" aria-selected={activeTab === q.id} onClick={() => choose(q.id)} style={{
            padding: '9px 20px', fontWeight: activeTab === q.id ? 700 : 500, fontSize: 14,
            border: 'none', background: 'none', cursor: 'pointer',
            color: activeTab === q.id ? '#6B3FDB' : '#6b7280',
            borderBottom: activeTab === q.id ? '2px solid #6B3FDB' : '2px solid transparent',
            marginBottom: -2, whiteSpace: 'nowrap',
          }}>{q.label}</button>
        ))}
      </div>
      {activeTab === 'team'
        ? <TeamView />
        : activeQueue && <QueueTable key={activeTab} queue={activeQueue} toast={toast} me={user?.employee_id ?? null} isAdmin={isAdmin} />}
    </PageShell>
  );
}
