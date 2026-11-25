/**
 * LeaveApprovals.jsx — the one place leave decisions are taken, level by level.
 *
 * Tabs (each with a live count):
 *  Manager (L1)     : my reporting line + leaves handed (delegated) to me
 *                     (HR/admin: everyone's L1)
 *  Dept Head (L2)   : only leave types that need a department head
 *  HR (final)       : L1 done (and L2 where the type needs it)
 *  Team View        : every request of the approver's team, any status
 *
 * 2026-11-23: L2 / HR queues are built on the server (`queue=l2|hr`). Each row
 * shows the balance after this leave, the attachment, who else in the
 * department is off, and (2026-11-25) how long it has waited at this step.
 *
 * 2026-11-25 (page audit): filters (type, department, dates, escalated /
 * overdue / starts-soon), sort, CSV, tab counts; reject asks for a reason in a
 * dialog; approving a leave that overdraws the balance asks first; bulk reject;
 * bulk select skips rows HR cannot decide yet; "punched in on leave days" and
 * "already started" flags; delegate shown on the row. The manager queue is now
 * the CURRENT reporting line + delegate on the server (it was apply-time
 * manager_id, so delegated leaves never reached the delegate).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CheckCircle, XCircle, Clock, Search, RefreshCw, History, Users, UserCheck, CalendarDays, Paperclip, Download, AlertTriangle, X } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { ApprovalChain, StatusChip, LeaveHistoryDialog, fmtDate, AttachmentLink, downloadCsv, localISO } from '../components/leaveShared';
import { useApproverStatus } from '@/features/approvals/approverStatus';

const ADMIN_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'hr_admin'];
const listOf = r => (Array.isArray(r.data) ? r.data : (r.data?.data || []));
const iso = d => String(d || '').slice(0, 10);
const DAY = 86400000;
const daysSince = ts => (ts ? Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / DAY)) : null);
const errOf = (e, fb) => e?.response?.data?.error || fb;

/* ── Shared look ─────────────────────────────────────────────────────────── */
const S = {
  input:  { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff', color: '#1f2937' },
  btn:    { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151', whiteSpace: 'nowrap' },
  th:     { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 },
  td:     { padding: '8px 12px', verticalAlign: 'top' },
  chip:   { background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' },
  flag:   (c) => ({ fontSize: 10, color: c, fontWeight: 600, marginTop: 3, whiteSpace: 'nowrap' }),
  card:   { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' },
  label:  { fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 },
};

/* ── Queue definitions ───────────────────────────────────────────────────── */
const QUEUES = [
  {
    id: 'manager',
    label: 'Manager (L1)',
    // Mirrors the server's L1 rule: the reporting manager / delegate, or
    // HR/admin as override.
    roles: ['manager', 'admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec'],
    orPermission: true,
    load: async () => listOf(await api.get('/leaves/applications', { params: { manager_status: 'pending', status: 'pending', limit: 500 } })),
    approve: (id, c) => api.post(`/leaves/approve/manager/${id}`, { comments: c }),
    reject:  (id, c) => api.post(`/leaves/reject/manager/${id}`, { comments: c }),
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
    // HR's batch route (needs L1 first, posts LOP to payroll, never self).
    bulkApproveRoute: (ids, c) => api.post('/leaves/bulk-approve', { ids, comments: c }),
  },
];

/* One by one, each result reported — for queues without a batch route. */
async function eachOf(ids, fn) {
  const settled = await Promise.allSettled(ids.map(fn));
  return settled.map((r, i) => ({ id: ids[i], ok: r.status === 'fulfilled', error: errOf(r.reason, null) }));
}
async function bulkApproveOf(queue, ids, c) {
  if (queue.bulkApproveRoute) {
    const res = await queue.bulkApproveRoute(ids, c);
    return (res.data?.results || []).map(r => ({ id: r.id, ok: r.status === 'approved', error: r.error }));
  }
  return eachOf(ids, id => queue.approve(id, c));
}

/* What an approver needs next to each request: balance and who else is off. */
function useDecisionContext(rows) {
  const [balances, setBalances] = useState({});   // employee_id → { leave_type_id → days left after }
  const [offs, setOffs] = useState([]);           // approved leave overlapping the queue's dates
  useEffect(() => {
    if (!rows.length) { setBalances({}); setOffs([]); return; }
    let live = true;
    const ids = [...new Set(rows.map(r => r.employee_id).filter(v => v != null))];
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

/* ── Centered dialog shell (no side drawers) ─────────────────────────────── */
function Dialog({ title, onClose, children, width = 440 }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width, maxWidth: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1f2937' }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex' }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* Approve (with an overdraw warning) or reject (reason required). */
function DecisionDialog({ decision, onCancel, onConfirm, busy }) {
  const { action, rows, warning, comment: initial } = decision;
  const [text, setText] = useState(initial || '');
  const reject = action === 'reject';
  const one = rows.length === 1 ? rows[0] : null;
  const ok = !reject || text.trim().length > 0;
  return (
    <Dialog title={reject ? (one ? 'Reject this leave' : `Reject ${rows.length} leaves`) : (one ? 'Approve this leave' : `Approve ${rows.length} leaves`)} onClose={onCancel}>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>
        {one
          ? <><strong>{one.employee_name}</strong> · {one.leave_name} · {fmtDate(one.start_date)}{iso(one.start_date) !== iso(one.end_date) ? ` → ${fmtDate(one.end_date)}` : ''} · {Number(one.number_of_days)} day(s)</>
          : rows.map(r => r.employee_name).filter(Boolean).slice(0, 6).join(', ') + (rows.length > 6 ? ` and ${rows.length - 6} more` : '')}
      </p>
      {warning && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 14, fontSize: 12, color: '#92400e' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{warning}</span>
        </div>
      )}
      <label style={{ ...S.label, fontSize: 12, color: '#374151' }}>
        {reject ? <>Reason for rejecting <span style={{ color: '#ef4444' }}>*</span></> : 'Comment (optional)'}
      </label>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={3} autoFocus
        placeholder={reject ? 'The employee sees this reason' : 'e.g. Approved — hand over the open work orders'}
        style={{ ...S.input, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', marginBottom: 14 }} />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} className="pulse-btn-secondary">Cancel</button>
        <button onClick={() => onConfirm(text.trim())} disabled={busy || !ok}
          style={{ padding: '8px 16px', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: busy || !ok ? 'not-allowed' : 'pointer', opacity: busy || !ok ? 0.6 : 1,
            background: reject ? '#dc2626' : '#16a34a', color: '#fff' }}>
          {busy ? 'Saving…' : reject ? 'Reject' : 'Approve'}
        </button>
      </div>
    </Dialog>
  );
}

/* ── Filter bar for a queue ──────────────────────────────────────────────── */
const EMPTY_FILTERS = { search: '', type: '', dept: '', from: '', to: '', only: '', sort: 'waiting' };

function FilterBar({ f, setF, types, depts, shown, total, onRefresh, onExport, escalationDays }) {
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const active = Object.entries(f).some(([k, v]) => k !== 'sort' && v);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', flex: '1 1 220px' }}>
        <label style={S.label}>Search</label>
        <Search size={13} style={{ position: 'absolute', left: 10, bottom: 10, color: '#9ca3af' }} />
        <input value={f.search} onChange={set('search')} placeholder="Search employee, code, department, reason…"
          style={{ ...S.input, width: '100%', paddingLeft: 30, boxSizing: 'border-box' }} />
      </div>
      <div><label style={S.label}>Leave type</label>
        <select value={f.type} onChange={set('type')} style={S.input} aria-label="Leave type">
          <option value="">All types</option>{types.map(t => <option key={t} value={t}>{t}</option>)}
        </select></div>
      <div><label style={S.label}>Department</label>
        <select value={f.dept} onChange={set('dept')} style={S.input} aria-label="Department">
          <option value="">All departments</option>{depts.map(d => <option key={d} value={d}>{d}</option>)}
        </select></div>
      <div><label style={S.label}>Leave between</label>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="date" value={f.from} onChange={set('from')} style={S.input} aria-label="From date" />
          <span style={{ color: '#9ca3af', fontSize: 12 }}>to</span>
          <input type="date" value={f.to} min={f.from || undefined} onChange={set('to')} style={S.input} aria-label="To date" />
        </div></div>
      <div><label style={S.label}>Show</label>
        <select value={f.only} onChange={set('only')} style={S.input} aria-label="Show">
          <option value="">Everything waiting</option>
          <option value="overdue">Waiting {escalationDays}+ days</option>
          <option value="escalated">Escalated</option>
          <option value="soon">Starts within 3 days / started</option>
          <option value="overdraw">Goes over balance</option>
          <option value="attachment">Has an attachment</option>
        </select></div>
      <div><label style={S.label}>Sort</label>
        <select value={f.sort} onChange={set('sort')} style={S.input} aria-label="Sort">
          <option value="waiting">Waiting longest</option>
          <option value="start">Leave starts soonest</option>
          <option value="applied">Applied newest</option>
          <option value="name">Employee A–Z</option>
          <option value="days">Most days</option>
        </select></div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
        <span style={{ fontSize: 13, color: '#6b7280', whiteSpace: 'nowrap' }}>{shown === total ? `${total} waiting` : `${shown} of ${total}`}</span>
        {active && <button onClick={() => setF(p => ({ ...EMPTY_FILTERS, sort: p.sort }))} style={S.btn}><X size={13} /> Clear</button>}
        <button onClick={onExport} disabled={!shown} style={{ ...S.btn, opacity: shown ? 1 : 0.5 }} title="Download what is shown as CSV"><Download size={13} /> CSV</button>
        <button onClick={onRefresh} style={S.btn}><RefreshCw size={13} /> Refresh</button>
      </div>
    </div>
  );
}

/* ── Single queue table ──────────────────────────────────────────────────── */
const STEP_OF = { manager: 'l1', l2: 'l2', hr: 'hr' };

function QueueTable({ queue, toast, me = null, isAdmin = false, focusId = null, escalationDays = 3, onChanged }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [acting, setActing] = useState(null);
  const [f, setF] = useState(EMPTY_FILTERS);
  const [comment, setComment] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [historyId, setHistoryId] = useState(null);
  const [decision, setDecision] = useState(null);     // { action, rows, warning, comment }
  const [delegateLeave, setDelegateLeave] = useState(null);
  const [delegateEmpId, setDelegateEmpId] = useState('');
  const [delegateNote, setDelegateNote] = useState('');
  const [people, setPeople] = useState([]);
  const [delegating, setDelegating] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(() => {
    setLoading(true); setLoadError('');
    setSelected(new Set());
    queue.load()
      .then(rows => { if (mounted.current) setData(rows); })
      .catch(e => { if (mounted.current) { setData([]); setLoadError(errOf(e, 'Could not load this queue')); } })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, [queue]);
  useEffect(() => { load(); }, [load]);
  const reload = () => { load(); onChanged?.(); };

  const { balances, othersOff } = useDecisionContext(data);
  const today = localISO();
  const soon = localISO(new Date(Date.now() + 3 * DAY));

  // HR / admin take the manager step only once it is escalated or there is no
  // manager who can act (server: authorizeL1).
  const isMe = id => me != null && id != null && String(id) === String(me);
  const waitsForManager = l => queue.id === 'manager' && isAdmin && l.hr_may_decide_l1 !== true
    && !isMe(l.manager_id) && !isMe(l.delegate_approver_id);
  const afterOf = l => balances[l.employee_id]?.[l.leave_type_id] ?? null;
  const overdraws = l => !l.is_lop && afterOf(l) != null && afterOf(l) < 0;
  const waitedOf = l => daysSince(l.step_since || l.applied_at);

  const types = useMemo(() => [...new Set(data.map(l => l.leave_name).filter(Boolean))].sort(), [data]);
  const depts = useMemo(() => [...new Set(data.map(l => l.department).filter(Boolean))].sort(), [data]);

  const filtered = useMemo(() => {
    const q = f.search.trim().toLowerCase();
    const rows = data.filter(l => {
      if (q && ![l.employee_name, l.employee_code, l.leave_name, l.reason, l.department, l.designation]
        .some(v => String(v || '').toLowerCase().includes(q))) return false;
      if (f.type && l.leave_name !== f.type) return false;
      if (f.dept && l.department !== f.dept) return false;
      if (f.from && iso(l.end_date) < f.from) return false;
      if (f.to && iso(l.start_date) > f.to) return false;
      if (f.only === 'overdue' && !(waitedOf(l) >= escalationDays)) return false;
      if (f.only === 'escalated' && l.escalation_step !== STEP_OF[queue.id]) return false;
      if (f.only === 'soon' && iso(l.start_date) > soon) return false;
      if (f.only === 'overdraw' && !overdraws(l)) return false;
      if (f.only === 'attachment' && !l.attachment_url) return false;
      return true;
    });
    const by = {
      waiting: (a, b) => String(a.step_since || a.applied_at || '').localeCompare(String(b.step_since || b.applied_at || '')),
      start:   (a, b) => iso(a.start_date).localeCompare(iso(b.start_date)),
      applied: (a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || '')),
      name:    (a, b) => String(a.employee_name || '').localeCompare(String(b.employee_name || '')),
      days:    (a, b) => Number(b.number_of_days) - Number(a.number_of_days),
    }[f.sort];
    return by ? [...rows].sort(by) : rows;
  }, [data, f, balances, escalationDays, queue.id, soon]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectable = filtered.filter(l => !waitsForManager(l));
  const selectedRows = data.filter(l => selected.has(l.id));

  /* Ask first: a rejection needs a reason; an approval that overdraws warns. */
  const ask = (action, rows) => {
    const over = action === 'approve' ? rows.filter(overdraws) : [];
    const warning = over.length === 0 ? null
      : rows.length === 1
        ? `This takes ${over[0].employee_name} to ${afterOf(over[0])} ${over[0].leave_name} day(s) — more than they have, once the other pending requests are counted.`
        : `${over.length} of these go over the employee's balance: ${over.map(l => l.employee_name).join(', ')}.`;
    const c = rows.length === 1 ? (comment[rows[0].id] || '') : '';
    if (action === 'approve' && !warning) { run('approve', rows, c); return; }
    setDecision({ action, rows, warning, comment: c });
  };

  const run = async (action, rows, c) => {
    const ids = rows.map(r => r.id);
    setActing(ids.length === 1 ? ids[0] : 'bulk');
    try {
      if (ids.length === 1) {
        await (action === 'approve' ? queue.approve(ids[0], c) : queue.reject(ids[0], c));
        toast.success(`Leave ${action === 'approve' ? 'approved' : 'rejected'}`);
      } else {
        const results = action === 'approve'
          ? await bulkApproveOf(queue, ids, c || 'Approved')
          : await eachOf(ids, id => queue.reject(id, c));
        const ok = results.filter(r => r.ok).length;
        const failed = results.filter(r => !r.ok);
        const verb = action === 'approve' ? 'approved' : 'rejected';
        if (failed.length) toast.error(`${ok} ${verb}, ${failed.length} not: ${failed[0].error || 'see each row'}`);
        else toast.success(`${ok} ${verb}`);
      }
      setComment(p => { const n = { ...p }; ids.forEach(id => delete n[id]); return n; });
      setDecision(null);
      reload();
    } catch (err) {
      toast.error(errOf(err, 'Action failed'));
    } finally { if (mounted.current) setActing(null); }
  };

  const openDelegate = (leave) => {
    setDelegateLeave(leave); setDelegateEmpId(''); setDelegateNote('');
    if (!people.length) {
      api.get('/employees', { params: { limit: 1000 } })
        .then(r => setPeople(listOf(r)
          .filter(e => !['left', 'terminated', 'resigned', 'inactive'].includes(String(e.status || '').toLowerCase()))
          .map(e => ({ ...e, _name: (e.name || `${e.first_name || ''} ${e.last_name || ''}`).trim() }))
          .sort((a, b) => a._name.localeCompare(b._name))))
        .catch(() => toast.error('Could not load the employee list'));
    }
  };
  const submitDelegate = async () => {
    if (!delegateEmpId) { toast.error('Choose who should decide instead'); return; }
    setDelegating(true);
    try {
      await api.post(`/leaves/delegate/${delegateLeave.id}`, { delegate_employee_id: delegateEmpId, comments: delegateNote || undefined });
      toast.success('Approval handed over'); setDelegateLeave(null); reload();
    } catch (e) { toast.error(errOf(e, 'Delegation failed')); }
    finally { setDelegating(false); }
  };

  const toggleSelect = id => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allPicked = selectable.length > 0 && selectable.every(l => selected.has(l.id));
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(selectable.map(l => l.id)));

  const exportCsv = () => downloadCsv(`leave-approvals-${queue.id}-${today}.csv`, [
    { label: 'Employee', key: 'employee_name' }, { label: 'Code', key: 'employee_code' },
    { label: 'Department', key: 'department' }, { label: 'Leave type', key: 'leave_name' },
    { label: 'From', value: l => iso(l.start_date) }, { label: 'To', value: l => iso(l.end_date) },
    { label: 'Days', value: l => Number(l.number_of_days) }, { label: 'Half day', value: l => (l.half_day ? l.half_day_session || 'Yes' : '') },
    { label: 'Balance after', value: l => (l.is_lop ? 'Unpaid' : afterOf(l) ?? '') },
    { label: 'Applied', value: l => iso(l.applied_at) }, { label: 'Waiting (days)', value: waitedOf },
    { label: 'Escalated', value: l => (l.escalation_step ? iso(l.escalated_at) : '') },
    { label: 'Delegated to', key: 'delegate_name' }, { label: 'Reason', key: 'reason' },
  ], filtered);

  return (
    <div>
      {historyId && <LeaveHistoryDialog leaveId={historyId} onClose={() => setHistoryId(null)} />}
      {decision && <DecisionDialog decision={decision} busy={acting != null}
        onCancel={() => setDecision(null)} onConfirm={c => run(decision.action, decision.rows, c)} />}

      {delegateLeave && (
        <Dialog title="Hand over this approval" onClose={() => setDelegateLeave(null)}>
          <p style={{ margin: '0 0 16px', fontSize: 12, color: '#6b7280' }}>
            Someone else decides <strong>{delegateLeave.employee_name}</strong>'s {delegateLeave.leave_name || 'leave'} at the manager step.
            {delegateLeave.delegate_name && <> It is with <strong>{delegateLeave.delegate_name}</strong> now.</>}
          </p>
          <label style={{ ...S.label, fontSize: 12, color: '#374151' }}>Decided by <span style={{ color: '#ef4444' }}>*</span></label>
          <select value={delegateEmpId} onChange={e => setDelegateEmpId(e.target.value)} aria-label="Decided by"
            style={{ ...S.input, width: '100%', marginBottom: 12 }}>
            <option value="">{people.length ? 'Select a person…' : 'Loading…'}</option>
            {people.filter(p => p.id !== delegateLeave.employee_id && p.id !== delegateLeave.delegate_approver_id).map(m => (
              <option key={m.id} value={m.id}>{m._name}{m.office_id ? ` (${m.office_id})` : ''}{m.designation ? ` — ${m.designation}` : ''}</option>
            ))}
          </select>
          <label style={{ ...S.label, fontSize: 12, color: '#374151' }}>Note (optional)</label>
          <input value={delegateNote} onChange={e => setDelegateNote(e.target.value)} placeholder="e.g. I am travelling till Friday"
            style={{ ...S.input, width: '100%', boxSizing: 'border-box', marginBottom: 14 }} />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setDelegateLeave(null)} className="pulse-btn-secondary">Cancel</button>
            <button onClick={submitDelegate} disabled={delegating || !delegateEmpId} className="pulse-btn-primary">{delegating ? 'Saving…' : 'Hand over'}</button>
          </div>
        </Dialog>
      )}

      <FilterBar f={f} setF={setF} types={types} depts={depts} shown={filtered.length} total={data.length}
        onRefresh={reload} onExport={exportCsv} escalationDays={escalationDays} />

      {selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#4B2DCE' }}>{selected.size} selected</span>
          <button onClick={() => ask('approve', selectedRows)} disabled={acting != null}
            style={{ padding: '7px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: acting ? 0.6 : 1 }}>
            {acting === 'bulk' ? 'Working…' : `Approve (${selected.size})`}
          </button>
          <button onClick={() => setDecision({ action: 'reject', rows: selectedRows, comment: '' })} disabled={acting != null}
            style={{ padding: '7px 16px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            Reject ({selected.size})
          </button>
          <button onClick={() => setSelected(new Set())} style={{ padding: '7px 12px', background: 'none', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>Clear</button>
        </div>
      )}

      <div style={S.card}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : loadError ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#b91c1c' }}>
            <p style={{ margin: '0 0 10px' }}>{loadError}</p>
            <button onClick={load} style={{ ...S.btn, margin: '0 auto' }}><RefreshCw size={13} /> Try again</button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
            <Clock size={32} color="#d1d5db" style={{ display: 'block', margin: '0 auto 10px' }} />
            <p style={{ margin: 0 }}>{data.length ? 'No request matches these filters' : 'Nothing waiting for you here'}</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1080 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ ...S.th, width: 36 }}>
                  <input type="checkbox" checked={allPicked} onChange={toggleAll} disabled={!selectable.length} aria-label="Select all" />
                </th>
                {['Employee', 'Leave', 'Dates', 'Days', 'Balance', 'Also off', 'Reason', 'Waiting', 'Approval', 'Comment', ''].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((l, i) => {
                const after = afterOf(l);
                const lop = l.is_lop ? Number(l.number_of_days) : Number(l.lop_days || 0);
                const others = othersOff(l);
                const waitMgr = waitsForManager(l);
                const waited = waitedOf(l);
                const started = iso(l.start_date) <= today;
                const focus = String(l.id) === String(focusId);
                const busy = acting === l.id || acting === 'bulk';
                return (
                  <tr key={l.id} ref={focus ? (el => el?.scrollIntoView({ block: 'center' })) : undefined}
                    style={{ borderBottom: '1px solid #f3f4f6', background: focus ? '#fef9c3' : selected.has(l.id) ? '#f5f3ff' : i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={S.td}>
                      <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)} disabled={waitMgr}
                        aria-label={`Select ${l.employee_name}`} title={waitMgr ? 'Waiting for the reporting manager' : undefined} />
                    </td>
                    <td style={S.td}>
                      <div style={{ fontWeight: 600 }}>{l.employee_name || '—'}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{[l.employee_code, l.department].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td style={S.td}>
                      <span style={S.chip}>{l.leave_name || '—'}</span>
                      {l.clubbing_flag && <div style={S.flag('#b45309')}>Clubbing</div>}
                      {l.escalation_step === STEP_OF[queue.id] && (
                        <div title="Waited longer than Leave Settings → escalate after N days" style={S.flag('#b91c1c')}>
                          Escalated {fmtDate(l.escalated_at)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...S.td, color: '#374151', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(l.start_date)}{iso(l.start_date) !== iso(l.end_date) ? ` → ${fmtDate(l.end_date)}` : ''}
                      {l.half_day && <div style={{ fontSize: 10, color: '#6b7280' }}>Half day {l.half_day_session}</div>}
                      {started && <div style={S.flag('#b45309')} title="The leave dates have begun and it is still not decided">{iso(l.start_date) === today ? 'Starts today' : 'Already started'}</div>}
                    </td>
                    <td style={{ ...S.td, fontWeight: 600, textAlign: 'center' }}>
                      {Number(l.number_of_days) || '—'}
                      {lop > 0 && <div style={S.flag('#b91c1c')}>{lop} LOP</div>}
                      {Number(l.worked_days) > 0 && <div style={S.flag('#b45309')} title="Attendance shows a punch-in on these leave days">Punched in {l.worked_days}d</div>}
                    </td>
                    <td style={{ ...S.td, fontSize: 12, whiteSpace: 'nowrap' }}>
                      {l.is_lop ? <span style={{ color: '#6b7280' }}>Unpaid</span>
                        : after == null ? <span style={{ color: '#d1d5db' }}>—</span>
                        : <span style={{ color: after < 0 ? '#dc2626' : '#065f46', fontWeight: 600 }} title="Days left once this and the other pending requests are approved">{after} left after</span>}
                    </td>
                    <td style={{ ...S.td, fontSize: 12 }}>
                      {others.length === 0 ? <span style={{ color: '#9ca3af' }}>No one</span>
                        : <span title={others.map(o => `${o.employee_name} (${o.leave_name}, ${fmtDate(o.start_date)}–${fmtDate(o.end_date)})`).join('\n')} style={{ color: '#b45309', fontWeight: 600, cursor: 'help' }}>
                            {others.length} in {l.department || 'team'}
                          </span>}
                    </td>
                    <td style={{ ...S.td, color: '#6b7280', maxWidth: 180, fontSize: 12 }}>
                      <span title={l.reason} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.reason || '—'}</span>
                      {l.attachment_url && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#6B3FDB' }}>
                          <Paperclip size={10} /><AttachmentLink url={l.attachment_url} />
                        </span>
                      )}
                    </td>
                    <td style={{ ...S.td, fontSize: 12, whiteSpace: 'nowrap' }} title={`Applied ${fmtDate(l.applied_at)}`}>
                      <span style={{ fontWeight: 600, color: waited >= escalationDays ? '#b91c1c' : '#374151' }}>
                        {waited == null ? '—' : waited === 0 ? 'Today' : `${waited} day${waited === 1 ? '' : 's'}`}
                      </span>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>Applied {fmtDate(l.applied_at)}</div>
                    </td>
                    <td style={S.td}>
                      <ApprovalChain leave={l} />
                      {l.delegate_name && queue.id === 'manager' && <div style={S.flag('#6B3FDB')}>Handed to {l.delegate_name}</div>}
                    </td>
                    <td style={S.td}>
                      <input value={comment[l.id] || ''} onChange={e => setComment(p => ({ ...p, [l.id]: e.target.value }))}
                        placeholder="Optional note" aria-label="Comment" disabled={waitMgr}
                        style={{ padding: '4px 7px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 11, width: 130 }} />
                    </td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                        title={waitMgr ? `Waiting for ${l.delegate_name || l.manager_name || 'the reporting manager'}. HR can decide once it is escalated.` : undefined}>
                        <button onClick={() => ask('approve', [l])} disabled={busy || waitMgr}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 6, cursor: busy || waitMgr ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600, opacity: busy || waitMgr ? 0.5 : 1 }}>
                          <CheckCircle size={11} />{acting === l.id ? '…' : 'Approve'}
                        </button>
                        <button onClick={() => ask('reject', [l])} disabled={busy || waitMgr}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 6, cursor: busy || waitMgr ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600, opacity: busy || waitMgr ? 0.5 : 1 }}>
                          <XCircle size={11} />Reject
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
  const [loadError, setLoadError] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [search, setSearch] = useState('');
  const [fMonth, setFMonth] = useState('');
  const [fYear, setFYear] = useState(String(YEAR));
  const [fType, setFType] = useState('');
  const [fDept, setFDept] = useState('');
  const [historyId, setHistoryId] = useState(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Status is filtered here, not on the server, so the chip counts stay true.
  const load = useCallback(() => {
    setLoading(true); setLoadError('');
    const params = { limit: 1000 };
    if (fMonth) params.month = fMonth;
    if (fYear) params.year = fYear;
    api.get('/leaves/team', { params })
      .then(r => { if (mounted.current) setData(listOf(r)); })
      .catch(e => { if (mounted.current) { setData([]); setLoadError(errOf(e, 'Could not load the team list')); } })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, [fMonth, fYear]);
  useEffect(() => { load(); }, [load]);

  const types = useMemo(() => [...new Set(data.map(l => l.leave_name).filter(Boolean))].sort(), [data]);
  const depts = useMemo(() => [...new Set(data.map(l => l.department).filter(Boolean))].sort(), [data]);
  const base = data.filter(l => {
    if (fType && l.leave_name !== fType) return false;
    if (fDept && l.department !== fDept) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return [l.employee_name, l.employee_code, l.department, l.leave_name, l.reason].some(v => String(v || '').toLowerCase().includes(q));
  });
  const displayed = fStatus ? base.filter(l => l.status === fStatus) : base;
  const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
  let approvedDays = 0;
  base.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; if (l.status === 'approved') approvedDays += Number(l.number_of_days) || 0; });

  const exportCsv = () => downloadCsv(`team-leave-${fYear || 'all'}${fMonth ? '-' + String(fMonth).padStart(2, '0') : ''}.csv`, [
    { label: 'Employee', key: 'employee_name' }, { label: 'Code', key: 'employee_code' }, { label: 'Department', key: 'department' },
    { label: 'Leave type', key: 'leave_name' }, { label: 'From', value: l => iso(l.start_date) }, { label: 'To', value: l => iso(l.end_date) },
    { label: 'Days', value: l => Number(l.number_of_days) }, { label: 'Status', key: 'status' },
    { label: 'Manager', key: 'manager_status' }, { label: 'HR', key: 'hr_status' },
    { label: 'Applied', value: l => iso(l.applied_at) }, { label: 'Reason', key: 'reason' },
  ], displayed);

  return (
    <div>
      {historyId && <LeaveHistoryDialog leaveId={historyId} onClose={() => setHistoryId(null)} />}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['', 'All', base.length], ['pending', 'Pending', counts.pending], ['approved', 'Approved', counts.approved], ['rejected', 'Rejected', counts.rejected], ['cancelled', 'Cancelled', counts.cancelled]].map(([v, lbl, cnt]) => (
          <button key={lbl} onClick={() => setFStatus(v)} aria-pressed={fStatus === v}
            style={{ padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${fStatus === v ? '#6B3FDB' : '#e5e7eb'}`, background: fStatus === v ? '#f5f3ff' : '#fff', color: fStatus === v ? '#6B3FDB' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {lbl} <strong>{cnt}</strong>
          </button>
        ))}
        <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 'auto' }}>{approvedDays} approved day(s) in this view</span>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 220px' }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employee, code, department…"
            style={{ ...S.input, width: '100%', paddingLeft: 30, boxSizing: 'border-box' }} />
        </div>
        <select value={fType} onChange={e => setFType(e.target.value)} style={S.input} aria-label="Leave type">
          <option value="">All types</option>{types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={fDept} onChange={e => setFDept(e.target.value)} style={S.input} aria-label="Department">
          <option value="">All departments</option>{depts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={fMonth} onChange={e => setFMonth(e.target.value)} style={S.input} aria-label="Month">
          <option value="">All months</option>{MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select value={fYear} onChange={e => setFYear(e.target.value)} style={S.input} aria-label="Year">
          {[YEAR + 1, YEAR, YEAR - 1, YEAR - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={exportCsv} disabled={!displayed.length} style={{ ...S.btn, opacity: displayed.length ? 1 : 0.5 }}><Download size={13} /> CSV</button>
        <button onClick={load} aria-label="Refresh" style={S.btn}><RefreshCw size={13} /></button>
      </div>
      <div style={S.card}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : loadError ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c' }}>{loadError}</div>
        ) : displayed.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}><Users size={32} color="#d1d5db" style={{ display: 'block', margin: '0 auto 10px' }} /><p style={{ margin: 0 }}>No leave requests found</p></div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 820 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Employee', 'Dept', 'Type', 'Dates', 'Days', 'Applied', 'Status', 'Approval', ''].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((l, i) => (
                <tr key={l.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                    {l.employee_name || '—'}
                    {l.employee_code && <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{l.employee_code}</div>}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>{l.department || '—'}</td>
                  <td style={{ padding: '10px 12px' }}><span style={S.chip}>{l.leave_name || '—'}</span></td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>
                    {fmtDate(l.start_date)}{iso(l.start_date) !== iso(l.end_date) ? ` → ${fmtDate(l.end_date)}` : ''}
                    {l.half_day && <div style={{ fontSize: 10, color: '#6b7280' }}>Half day {l.half_day_session}</div>}
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 700, textAlign: 'center' }}>
                    {Number(l.number_of_days) || '—'}
                    {(l.is_lop || Number(l.lop_days) > 0) && <div style={S.flag('#b91c1c')}>{l.is_lop ? Number(l.number_of_days) : Number(l.lop_days)} LOP</div>}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(l.applied_at)}</td>
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
export default function LeaveApprovals({ initialQueue: queueProp } = {}) {
  // ?queue=manager|l2|hr&leave=<id> — the Approval Center opens a leave here
  // (the one place leave is decided, 2026-11-24) on its queue, row highlighted.
  const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const initialQueue = queueProp || urlParams.get('queue') || undefined;
  const focusId = urlParams.get('leave');
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

  // Escalation threshold (Leave Settings) — "waiting N+ days" turns red.
  const [escalationDays, setEscalationDays] = useState(3);
  useEffect(() => {
    api.get('/leaves/settings').then(r => {
      const d = Number(r.data?.escalation_days);
      if (Number.isFinite(d) && d > 0) setEscalationDays(d);
    }).catch(() => {});
  }, []);

  // Live count on every queue tab; refreshed after each decision.
  const [counts, setCounts] = useState({});
  const visibleKey = visibleQueues.map(q => q.id).join(',');
  const loadCounts = useCallback(() => {
    visibleQueues.forEach(q => q.load()
      .then(rows => setCounts(c => ({ ...c, [q.id]: rows.length })))
      .catch(() => {}));
  }, [visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadCounts(); }, [loadCounts]);

  return (
    <PageShell dock={<PageHero icon={CalendarDays} eyebrow="Leave" title="Leave Approvals"
      subtitle="Manager → HR, with the department head in between for leave types that need one" />}>
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e5e7eb', overflowX: 'auto' }} role="tablist">
        {allTabs.map(q => (
          <button key={q.id} role="tab" aria-selected={activeTab === q.id} onClick={() => choose(q.id)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '9px 20px', fontWeight: activeTab === q.id ? 700 : 500, fontSize: 14,
            border: 'none', background: 'none', cursor: 'pointer',
            color: activeTab === q.id ? '#6B3FDB' : '#6b7280',
            borderBottom: activeTab === q.id ? '2px solid #6B3FDB' : '2px solid transparent',
            marginBottom: -2, whiteSpace: 'nowrap',
          }}>
            <span>{q.label}</span>
            {counts[q.id] > 0 && (
              <span aria-label={`${counts[q.id]} waiting`} style={{ minWidth: 18, padding: '1px 6px', borderRadius: 10, fontSize: 11, fontWeight: 700, textAlign: 'center',
                background: activeTab === q.id ? '#6B3FDB' : '#ede9fe', color: activeTab === q.id ? '#fff' : '#6B3FDB' }}>{counts[q.id]}</span>
            )}
          </button>
        ))}
      </div>
      {activeTab === 'team'
        ? <TeamView />
        : activeQueue && <QueueTable key={activeTab} queue={activeQueue} toast={toast} me={user?.employee_id ?? null}
            isAdmin={isAdmin} focusId={focusId} escalationDays={escalationDays} onChanged={loadCounts} />}
    </PageShell>
  );
}
