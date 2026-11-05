import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { CheckSquare } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { canRoleOpenPage } from '@/config/menuCatalog';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { runApprovalAction, actionError } from '../approvalActions';
import './ApprovalCenter.css';

/*
 * Approval Center — the single Approvals page.
 *
 *   My Pending Approvals  requests the originating module lets ME decide now
 *   My Requests           requests I submitted in any module, with status and current approver
 *   Approval History      decisions I made
 *
 * Requests are never created here: they are raised in their own module (Leave,
 * Attendance, Expense, Travel, Purchase, Recruitment, Engineering) and appear
 * here automatically. Every Approve/Reject/Delegate/Withdraw button runs the
 * originating module's own endpoint (see approvalActions.js).
 */

const TABS = [
  { id: 'pending',     label: 'My Pending Approvals', approverOnly: true },
  { id: 'my-requests', label: 'My Requests' },
  { id: 'history',     label: 'Approval History',     approverOnly: true },
];

// Where each kind of request is raised. Shown in My Requests' help text and
// empty state; each entry is shown only if the viewer can open that page.
const SUBMIT_IN = [
  { label: 'Leave',                      page: 'ApplyLeave' },
  { label: 'Attendance correction / OT', page: 'AttendanceDashboard' },
  { label: 'Expense claim',              page: 'ExpenseClaims' },
  { label: 'Travel request',             page: 'TravelRequests' },
  { label: 'Travel advance',             page: 'TravelAdvances' },
  { label: 'Purchase request',           page: 'PurchaseRequest' },
  { label: 'Job requisition / offer',    page: 'JobRequisitionPipeline' },
  { label: 'Engineering change',         page: 'ECNManagement' },
];

const TYPE_TONE = {
  leave: 'indigo', reg: 'amber', ot: 'violet', exp: 'violet', pr: 'pink', ecn: 'sky',
  pay: 'green', travel: 'green', adv: 'green', requisition: 'cyan', offer: 'cyan', appr: 'grey',
  ieval: 'amber', prob: 'indigo', gate: 'cyan',
};

// Review queues (intern evaluation, probation review) are completed on their
// own form, not approved/rejected: the row's only action is `open`.
const isForm = (r) => !!r?.actions?.open;
const STATUS_TONE = { Pending: 'violet', Approved: 'green', Rejected: 'red', 'Sent back': 'amber', Cancelled: 'grey' };

const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
function fmtAmount(r) {
  if (r.amount == null) return '—';
  if (r.amount_unit === 'days')  return `${Number(r.amount)} day${Number(r.amount) === 1 ? '' : 's'}`;
  if (r.amount_unit === 'hours') return `${Number(r.amount)} h`;
  return money(r.amount);
}
function fmtWaiting(h) {
  if (h == null) return '—';
  if (h < 1) return '<1h';
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const Badge = ({ tone = 'grey', children, title }) => (
  <span className={`ac-badge ac-tone-${tone}`} title={title}>{children}</span>
);

export default function ApprovalCenter({ initialTab } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { role, menuAccess } = useAuth();
  const canOpen = useCallback((page) => !!page && canRoleOpenPage(role, page, { menuAccess }), [role, menuAccess]);
  const open = (page, params) => {
    if (!page) return;
    const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    navigate(`/${page}${qs}`);
  };
  const openForm = (r) => open(r.actions.open.page, r.actions.open.params);

  const urlTab = new URLSearchParams(location.search).get('tab');
  const [tab, setTab] = useState(urlTab || initialTab || null);

  const [stats, setStats]       = useState(null);
  const [pending, setPending]   = useState([]);
  const [mine, setMine]         = useState([]);
  const [history, setHistory]   = useState([]);
  const [loading, setLoading]   = useState({ pending: false, mine: false, history: false, stats: true });
  const [errors, setErrors]     = useState({});
  const [toast, setToast]       = useState(null);
  const [busy, setBusy]         = useState(null);        // id (or 'bulk') being actioned
  const [selected, setSelected] = useState([]);
  const [detail, setDetail]     = useState(null);        // { row, kind: 'pending'|'mine'|'history' }
  const [chain, setChain]       = useState([]);
  const [modal, setModal]       = useState(null);        // { kind, rows, action }
  const [text, setText]         = useState('');
  const [filters, setFilters]   = useState({ q: '', type: '', status: '' });

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => mounted.current && setToast(null), 4500);
  };

  const load = useCallback(async (key, url, setter, pick = (d) => d) => {
    setLoading((l) => ({ ...l, [key]: true }));
    try {
      const res = await api.get(url);
      if (!mounted.current) return;
      setter(pick(res.data));
      setErrors((e) => ({ ...e, [key]: null }));
    } catch (err) {
      if (mounted.current) setErrors((e) => ({ ...e, [key]: actionError(err, 'Could not load.') }));
    } finally {
      if (mounted.current) setLoading((l) => ({ ...l, [key]: false }));
    }
  }, []);

  const loadStats   = useCallback(() => load('stats', '/approvals/stats', setStats), [load]);
  const loadPending = useCallback(() => load('pending', '/approvals/pending', (d) => setPending(Array.isArray(d) ? d : [])), [load]);
  const loadMine    = useCallback(() => load('mine', '/approvals/my-requests', (d) => setMine(Array.isArray(d?.submitted) ? d.submitted : [])), [load]);
  const loadHistory = useCallback(() => load('history', '/approvals/history', (d) => setHistory(Array.isArray(d) ? d : [])), [load]);

  useEffect(() => { loadStats(); loadMine(); }, [loadStats, loadMine]);

  const isApprover = !!stats?.isApprover;
  const visibleTabs = TABS.filter((t) => !t.approverOnly || isApprover);

  // Default tab once we know whether the viewer approves anything.
  useEffect(() => {
    if (!stats) return;
    if (!tab || !visibleTabs.some((t) => t.id === tab)) setTab(isApprover ? 'pending' : 'my-requests');
  }, [stats]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'pending' && isApprover) loadPending();
    if (tab === 'history' && isApprover) loadHistory();
    setSelected([]);
  }, [tab, isApprover, loadPending, loadHistory]);

  const switchTab = (id) => {
    setTab(id);
    const params = new URLSearchParams(location.search);
    params.set('tab', id);
    navigate({ pathname: location.pathname, search: `?${params}` }, { replace: true });
  };

  const refreshAfterDecision = () => {
    loadPending(); loadStats(); loadHistory();
    window.dispatchEvent(new Event('pulse:approvals-updated'));
  };

  /* ── decisions ─────────────────────────────────────────────────────────── */

  const decide = async (row, kind, comment) => {
    const action = row.actions?.[kind];
    if (!action) return showToast('This action is not available for this request.', 'error');
    setBusy(row.id);
    try {
      await runApprovalAction(action, { comment });
      if (!mounted.current) return;
      showToast(kind === 'approve' ? 'Approved' : `${action.label || 'Rejected'} — the requester has been notified`);
      setDetail(null); setModal(null); setText('');
      setSelected((s) => s.filter((id) => id !== row.id));
      refreshAfterDecision();
    } catch (err) {
      if (mounted.current) showToast(actionError(err, 'Could not complete the action.'), 'error');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const bulk = async (kind, comment) => {
    const rows = pending.filter((r) => selected.includes(r.id) && r.actions?.[kind]);
    if (!rows.length) return;
    setBusy('bulk');
    const failures = [];
    for (const row of rows) {
      try { await runApprovalAction(row.actions[kind], { comment }); }
      catch (err) { failures.push(`${row.request_title}: ${actionError(err)}`); }
    }
    if (!mounted.current) return;
    setBusy(null); setModal(null); setText(''); setSelected([]);
    const done = rows.length - failures.length;
    showToast(failures.length
      ? `${done} of ${rows.length} ${kind === 'approve' ? 'approved' : 'rejected'}. ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`
      : `${done} request${done === 1 ? '' : 's'} ${kind === 'approve' ? 'approved' : 'rejected'}`,
    failures.length ? 'error' : 'success');
    refreshAfterDecision();
  };

  const withdraw = async (row, reason) => {
    setBusy(row.id);
    try {
      await runApprovalAction(row.actions.withdraw, { comment: reason });
      if (!mounted.current) return;
      showToast('Request withdrawn');
      setModal(null); setText('');
      loadMine();
    } catch (err) {
      if (mounted.current) showToast(actionError(err, 'Could not withdraw.'), 'error');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  /* ── delegation ────────────────────────────────────────────────────────── */

  const [delegateQ, setDelegateQ] = useState('');
  const [delegates, setDelegates] = useState([]);
  const [delegatePick, setDelegatePick] = useState(null);
  useEffect(() => {
    if (modal?.kind !== 'delegate') return undefined;
    const t = setTimeout(async () => {
      try {
        const res = await api.get('/approvals/delegates', { params: { q: delegateQ } });
        if (mounted.current) setDelegates(Array.isArray(res.data) ? res.data : []);
      } catch { if (mounted.current) setDelegates([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [delegateQ, modal]);

  const delegate = async () => {
    const row = modal.rows[0];
    const action = row.actions.delegate;
    const id = action.delegateIdField === 'user_id' ? delegatePick.user_id : delegatePick.id;
    setBusy(row.id);
    try {
      await runApprovalAction(action, { delegateId: id });
      if (!mounted.current) return;
      showToast(`Delegated to ${delegatePick.name}`);
      setModal(null); setDelegatePick(null); setDelegateQ('');
      refreshAfterDecision();
    } catch (err) {
      if (mounted.current) showToast(actionError(err, 'Could not delegate.'), 'error');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  /* ── detail panel ──────────────────────────────────────────────────────── */

  const openDetail = async (row, kind) => {
    setDetail({ row, kind });
    setChain([]);
    if (/^(leave|exp|ecn):\d+$/.test(row.id) || /^\d+$/.test(row.id)) {
      try {
        const res = await api.get(`/approvals/${encodeURIComponent(row.id)}/chain`);
        if (mounted.current) setChain(Array.isArray(res.data) ? res.data : []);
      } catch { /* the trail is supplementary */ }
    }
  };

  /* ── filtering ─────────────────────────────────────────────────────────── */

  const matches = (r) => {
    const q = filters.q.trim().toLowerCase();
    if (filters.type && r.type !== filters.type) return false;
    if (filters.status && r.status !== filters.status && r.decision !== filters.status) return false;
    if (q && ![r.request_title, r.requested_by, r.request_type, r.current_approver]
      .some((v) => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  };
  const rowsFor = { pending, 'my-requests': mine, history };
  const current = (rowsFor[tab] || []).filter(matches);
  const typeOptions = useMemo(() => {
    const m = new Map();
    for (const r of rowsFor[tab] || []) m.set(r.type, r.request_type);
    return [...m.entries()];
  }, [tab, pending, mine, history]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitLinks = SUBMIT_IN.filter((s) => canOpen(s.page));
  const slaNote = stats?.sla
    ? [...(stats.sla.configured || []).map((c) => `${c.label} ${c.hours}h (configured)`),
       `others ${stats.sla.default_hours}h (default)`].join(' · ')
    : '';

  /* ── render ────────────────────────────────────────────────────────────── */

  return (
    <PageShell dock={<PageHero icon={CheckSquare} eyebrow="Approvals" title="Approval Center" />}>
      <div className="ac-page">
        {toast && <div className={`ac-toast ac-toast-${toast.type}`} role="status">{toast.msg}</div>}

        {isApprover && (
          <div className="ac-kpis">
            <Kpi label="Pending" value={stats.pending} hint="Awaiting your decision" />
            <Kpi label="Approved today" value={stats.approvedToday} />
            <Kpi label="Rejected today" value={stats.rejectedToday} />
            <Kpi label="Overdue" value={stats.overdue} tone={stats.overdue ? 'danger' : ''}
                 hint="Waiting longer than the SLA" title={`SLA: ${slaNote}`} />
            <Kpi label="SLA compliance"
                 value={stats.slaCompliance == null ? 'No data' : `${stats.slaCompliance}%`}
                 tone={stats.slaCompliance == null ? 'muted' : 'ok'}
                 hint={stats.slaCompliance == null ? 'No decisions in the last 30 days' : `${stats.slaDecisions} decision${stats.slaDecisions === 1 ? '' : 's'}, last 30 days`}
                 title={`Share of your decisions made within SLA. ${slaNote}`} />
          </div>
        )}

        <div className="ac-tabs" role="tablist">
          {visibleTabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id}
                    className={`ac-tab${tab === t.id ? ' is-active' : ''}`} onClick={() => switchTab(t.id)}>
              {t.label}
              {t.id === 'pending' && stats?.pending > 0 && <span className="ac-count">{stats.pending}</span>}
            </button>
          ))}
        </div>

        {tab === 'my-requests' && (
          <p className="ac-help">
            Requests are raised in their own modules and appear here automatically once submitted.
            {submitLinks.length > 0 && <> Submit new: {submitLinks.map((s, i) => (
              <span key={s.page}>{i > 0 && ' · '}<button type="button" className="ac-link" onClick={() => open(s.page)}>{s.label}</button></span>
            ))}</>}
          </p>
        )}

        {tab && (
          <div className="ac-filters">
            <input className="ac-search" placeholder={tab === 'my-requests' ? 'Search requests…' : 'Search by request or person…'}
                   value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
            <select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))} aria-label="Type">
              <option value="">All types</option>
              {typeOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {tab !== 'pending' && (
              <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} aria-label="Status">
                <option value="">All statuses</option>
                {(tab === 'history' ? ['Approved', 'Rejected'] : ['Pending', 'Approved', 'Rejected', 'Sent back', 'Cancelled'])
                  .map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            {tab === 'pending' && selected.length > 0 && (
              <div className="ac-bulk">
                <span>{selected.length} selected</span>
                <button className="ac-btn ac-btn-primary" disabled={busy === 'bulk'} onClick={() => bulk('approve')}>Approve selected</button>
                <button className="ac-btn ac-btn-danger" disabled={busy === 'bulk'} onClick={() => { setText(''); setModal({ kind: 'bulk-reject', rows: [] }); }}>Reject selected</button>
              </div>
            )}
          </div>
        )}

        {tab === 'pending' && (
          <Table loading={loading.pending} error={errors.pending} onRetry={loadPending} empty={filters.q || filters.type ? 'No pending requests match these filters.' : 'Nothing is waiting for your decision.'}
          rows={current} head={
            <tr>
              <th className="ac-check"><input type="checkbox" aria-label="Select all"
                checked={current.some((r) => !isForm(r)) && current.filter((r) => !isForm(r)).every((r) => selected.includes(r.id))}
                onChange={(e) => setSelected(e.target.checked ? current.filter((r) => !isForm(r)).map((r) => r.id) : [])} /></th>
              <th>Type</th><th>Request</th><th>Requested by</th><th>Stage</th><th>Submitted</th><th>Amount</th><th>Waiting</th><th>Actions</th>
            </tr>
          } render={(r) => (
            <tr key={r.id} className={r.overdue ? 'is-overdue' : ''}>
              <td className="ac-check">{!isForm(r) && <input type="checkbox" aria-label={`Select ${r.request_title}`}
                checked={selected.includes(r.id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)))} />}</td>
              <td><Badge tone={TYPE_TONE[r.type]}>{r.request_type}</Badge></td>
              <td className="ac-title">{r.request_title}</td>
              <td>{r.requested_by}</td>
              <td className="ac-muted">{r.stage}</td>
              <td className="ac-nowrap">{fmtDate(r.request_date)}</td>
              <td className="ac-nowrap">{fmtAmount(r)}</td>
              <td className="ac-nowrap">
                {fmtWaiting(r.waiting_hours)}
                {r.overdue && <Badge tone="red" title={`SLA ${r.sla_hours}h (${r.sla_source})`}>Overdue</Badge>}
              </td>
              <td className="ac-actions">
                <button className="ac-btn ac-btn-ghost" onClick={() => openDetail(r, 'pending')}>View</button>
                {isForm(r) ? (
                  <button className="ac-btn ac-btn-primary" onClick={() => openForm(r)}>Open</button>
                ) : (
                  <>
                    <button className="ac-btn ac-btn-ok" disabled={!!busy} onClick={() => decide(r, 'approve')}>Approve</button>
                    <button className="ac-btn ac-btn-no" disabled={!!busy}
                            onClick={() => { setText(''); setModal({ kind: 'reject', rows: [r], action: r.actions.reject }); }}>
                      {r.actions?.reject?.label || 'Reject'}
                    </button>
                  </>
                )}
                {r.actions?.delegate && (
                  <button className="ac-btn ac-btn-ghost" disabled={!!busy}
                          onClick={() => { setDelegatePick(null); setDelegateQ(''); setModal({ kind: 'delegate', rows: [r] }); }}>Delegate</button>
                )}
              </td>
            </tr>
          )} />
        )}

        {tab === 'my-requests' && (
          <Table loading={loading.mine} error={errors.mine} onRetry={loadMine} rows={current} empty={
            <div className="ac-empty-body">
              <p><strong>{mine.length ? 'No requests match these filters.' : 'You haven\'t submitted any requests yet.'}</strong></p>
              {!mine.length && <p>There is no form here — raise a request in its own module (for example Apply Leave, Expense Claims or Travel Requests) and it will appear in this list as soon as you submit it, with its status and who it is waiting on.</p>}
            </div>
          } head={
            <tr><th>Type</th><th>Request</th><th>Submitted</th><th>Amount</th><th>Status</th><th>Waiting on</th><th>Notes</th><th>Actions</th></tr>
          } render={(r) => (
            <tr key={r.id}>
              <td><Badge tone={TYPE_TONE[r.type]}>{r.request_type}</Badge></td>
              <td className="ac-title">{r.request_title}</td>
              <td className="ac-nowrap">{fmtDate(r.request_date)}</td>
              <td className="ac-nowrap">{fmtAmount(r)}</td>
              <td><Badge tone={STATUS_TONE[r.status]} title={r.status_detail}>{r.status}</Badge></td>
              <td>{r.current_approver || '—'}</td>
              <td className="ac-notes">{r.comments || '—'}</td>
              <td className="ac-actions">
                <button className="ac-btn ac-btn-ghost" onClick={() => openDetail(r, 'mine')}>View</button>
                {canOpen(r.link_page) && <button className="ac-btn ac-btn-ghost" onClick={() => open(r.link_page)}>Track</button>}
                {r.actions?.withdraw && (
                  <button className="ac-btn ac-btn-no" disabled={!!busy}
                          onClick={() => { setText(''); setModal({ kind: 'withdraw', rows: [r] }); }}>Withdraw</button>
                )}
                {r.actions?.resubmitPage && canOpen(r.actions.resubmitPage) && (
                  <button className="ac-btn ac-btn-primary" onClick={() => open(r.actions.resubmitPage)}>Revise &amp; resubmit</button>
                )}
              </td>
            </tr>
          )} />
        )}

        {tab === 'history' && (
          <Table loading={loading.history} error={errors.history} onRetry={loadHistory} rows={current}
                 empty="You haven't approved or rejected any requests yet."
                 head={<tr><th>Type</th><th>Request</th><th>Requested by</th><th>Level</th><th>Decision</th><th>Decided</th><th>Comments</th><th></th></tr>}
                 render={(r) => (
                   <tr key={r.key || r.id}>
                     <td><Badge tone={TYPE_TONE[r.type]}>{r.request_type}</Badge></td>
                     <td className="ac-title">{r.request_title}</td>
                     <td>{r.requested_by}</td>
                     <td className="ac-muted">{r.stage || '—'}</td>
                     <td><Badge tone={STATUS_TONE[r.decision]}>{r.decision}</Badge></td>
                     <td className="ac-nowrap">{fmtDate(r.decision_date)}</td>
                     <td className="ac-notes">{r.comments || '—'}</td>
                     <td className="ac-actions"><button className="ac-btn ac-btn-ghost" onClick={() => openDetail(r, 'history')}>View</button></td>
                   </tr>
                 )} />
        )}

        {detail && (
          <div className="ac-panel" role="dialog" aria-label="Request details">
            <div className="ac-panel-overlay" onClick={() => setDetail(null)} />
            <div className="ac-panel-body">
              <div className="ac-panel-head">
                <h2>{detail.row.request_title}</h2>
                <button className="ac-close" aria-label="Close" onClick={() => setDetail(null)}>×</button>
              </div>
              <dl className="ac-dl">
                <dt>Type</dt><dd>{detail.row.request_type}</dd>
                {detail.row.requested_by && <><dt>Requested by</dt><dd>{detail.row.requested_by}{detail.row.department ? ` · ${detail.row.department}` : ''}</dd></>}
                <dt>Submitted</dt><dd>{fmtDate(detail.row.request_date)}</dd>
                {detail.row.amount != null && <><dt>Amount</dt><dd>{fmtAmount(detail.row)}</dd></>}
                {detail.row.stage && <><dt>{detail.kind === 'history' ? 'Level' : 'Current stage'}</dt><dd>{detail.row.stage}</dd></>}
                {detail.row.status && <><dt>Status</dt><dd>{detail.row.status}</dd></>}
                {detail.kind === 'mine' && <><dt>Waiting on</dt><dd>{detail.row.current_approver || '—'}</dd></>}
                {detail.row.decision && <><dt>Your decision</dt><dd>{detail.row.decision} · {fmtDate(detail.row.decision_date)}</dd></>}
                {detail.kind === 'pending' && <><dt>SLA</dt><dd>{detail.row.sla_hours}h ({detail.row.sla_source}) · waiting {fmtWaiting(detail.row.waiting_hours)}</dd></>}
                {detail.row.description && <><dt>Details</dt><dd className="ac-pre">{detail.row.description}</dd></>}
                {detail.row.comments && <><dt>Comments</dt><dd className="ac-pre">{detail.row.comments}</dd></>}
              </dl>

              {chain.length > 0 && (
                <div className="ac-chain">
                  <h3>Approval trail</h3>
                  <ol>
                    {chain.map((s, i) => {
                      const st = String(s.status || 'pending').toLowerCase();
                      return (
                        <li key={i} className={`is-${st}`}>
                          <span className="ac-chain-step">{s.step}</span>
                          <span>{s.approver_name || s.approver || '—'}</span>
                          <Badge tone={STATUS_TONE[s.status] || (st === 'pending' ? 'violet' : 'grey')}>{s.status || 'Pending'}</Badge>
                          {s.decision_date && <span className="ac-muted">{fmtDate(s.decision_date)}</span>}
                          {s.comment && <span className="ac-muted">“{s.comment}”</span>}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}

              <div className="ac-panel-foot">
                {detail.kind === 'pending' && isForm(detail.row) ? (
                  <button className="ac-btn ac-btn-primary" onClick={() => openForm(detail.row)}>Open</button>
                ) : canOpen(detail.row.link_page) && (
                  <button className="ac-btn ac-btn-ghost" onClick={() => open(detail.row.link_page)}>Open in module</button>
                )}
                {detail.kind === 'pending' && !isForm(detail.row) && (
                  <>
                    <button className="ac-btn ac-btn-ok" disabled={!!busy} onClick={() => decide(detail.row, 'approve')}>Approve</button>
                    <button className="ac-btn ac-btn-no" disabled={!!busy}
                            onClick={() => { setText(''); setModal({ kind: 'reject', rows: [detail.row], action: detail.row.actions.reject }); }}>
                      {detail.row.actions?.reject?.label || 'Reject'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {modal && (
          <div className="ac-modal" role="dialog" aria-modal="true">
            <div className="ac-panel-overlay" onClick={() => !busy && setModal(null)} />
            <div className="ac-modal-body">
              {modal.kind === 'delegate' ? (
                <>
                  <h2>Delegate this approval</h2>
                  <p className="ac-muted">{modal.rows[0].request_title} — the colleague you choose will be able to decide it.</p>
                  <input className="ac-search" autoFocus placeholder="Search colleague by name or email…"
                         value={delegateQ} onChange={(e) => { setDelegateQ(e.target.value); setDelegatePick(null); }} />
                  <ul className="ac-picklist">
                    {delegates.map((u) => (
                      <li key={u.id}>
                        <button type="button" className={delegatePick?.id === u.id ? 'is-picked' : ''} onClick={() => setDelegatePick(u)}>
                          <strong>{u.name}</strong>{u.designation && <span className="ac-muted"> · {u.designation}</span>}
                        </button>
                      </li>
                    ))}
                    {!delegates.length && <li className="ac-muted">No matching colleagues with an active login.</li>}
                  </ul>
                  <div className="ac-modal-actions">
                    <button className="ac-btn ac-btn-ghost" onClick={() => setModal(null)} disabled={!!busy}>Cancel</button>
                    <button className="ac-btn ac-btn-primary" disabled={!delegatePick || !!busy} onClick={delegate}>Delegate</button>
                  </div>
                </>
              ) : (
                <>
                  <h2>{modal.kind === 'withdraw' ? 'Withdraw request'
                    : modal.kind === 'bulk-reject' ? `Reject ${selected.length} requests`
                    : `${modal.action?.label || 'Reject'} request`}</h2>
                  {modal.rows[0] && <p className="ac-muted">{modal.rows[0].request_title}</p>}
                  <label className="ac-label" htmlFor="ac-reason">
                    {modal.kind === 'withdraw' ? 'Reason for withdrawing' : 'Reason (shown to the requester)'} <span className="ac-req">*</span>
                  </label>
                  <textarea id="ac-reason" rows={4} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
                  <div className="ac-modal-actions">
                    <button className="ac-btn ac-btn-ghost" onClick={() => setModal(null)} disabled={!!busy}>Cancel</button>
                    <button className="ac-btn ac-btn-danger" disabled={!text.trim() || !!busy}
                            onClick={() => (modal.kind === 'withdraw' ? withdraw(modal.rows[0], text.trim())
                              : modal.kind === 'bulk-reject' ? bulk('reject', text.trim())
                              : decide(modal.rows[0], 'reject', text.trim()))}>
                      {busy ? 'Working…' : modal.kind === 'withdraw' ? 'Withdraw' : (modal.action?.label || 'Reject')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function Kpi({ label, value, hint, tone = '', title }) {
  return (
    <div className={`ac-kpi${tone ? ` ac-kpi-${tone}` : ''}`} title={title}>
      <span className="ac-kpi-value">{value ?? '—'}</span>
      <span className="ac-kpi-label">{label}</span>
      {hint && <span className="ac-kpi-hint">{hint}</span>}
    </div>
  );
}

function Table({ loading, error, onRetry, rows, head, render, empty }) {
  if (loading && !rows.length) return <div className="ac-empty">Loading…</div>;
  if (error) {
    return (
      <div className="ac-empty ac-error">
        {error} <button className="ac-link" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (!rows.length) return <div className="ac-empty">{empty}</div>;
  return (
    <div className="ac-table-wrap">
      <table className="ac-table">
        <thead>{head}</thead>
        <tbody>{rows.map(render)}</tbody>
      </table>
    </div>
  );
}
