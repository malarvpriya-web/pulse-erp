import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  Plus, X, ChevronRight, RefreshCw, PauseCircle, PlayCircle,
  CheckCircle, AlertCircle, Network, Undo2, Ban, RotateCcw, Flag, Lock, ShieldOff,
} from 'lucide-react';
import { gateLabel, blockerText, lifecycleErrorMessage } from '@/features/projects/shared/projectStage';

// The production-lifecycle stage model comes from the backend
// (GET /lifecycle/stages, backend/src/shared/projectStages.js). This list is
// only the fallback until it loads, and mirrors it: Clearing and
// Pre-commissioning are reserved (never entered), and Service / AMC are not
// stages any more — they stay labelled below only so old history reads.
const FALLBACK_MODEL = {
  stages: [
    { key: 'order', label: 'Order / Handover' }, { key: 'design', label: 'Design / Engineering' },
    { key: 'procurement', label: 'Procurement' }, { key: 'production', label: 'Production' },
    { key: 'testing', label: 'Testing / FAT' }, { key: 'clearing', label: 'Clearing', reserved: true },
    { key: 'dispatch', label: 'Dispatch' }, { key: 'installation', label: 'Installation' },
    { key: 'pre_commissioning', label: 'Pre-commissioning', reserved: true },
    { key: 'commissioning', label: 'Commissioning' }, { key: 'sat', label: 'SAT (Site Acceptance)' },
    { key: 'closure', label: 'Closure' },
  ],
  final_stage: 'closure',
};
const LEGACY_LABELS = { service: 'Service (legacy)', amc: 'AMC (legacy)' };
const REASON_MIN = 5;

const STATUS_COLOR = {
  active:    { bg: '#d1fae5', color: '#065f46' },
  completed: { bg: '#dbeafe', color: '#1e40af' },
  on_hold:   { bg: '#ede9fe', color: '#5b21b6' },
  cancelled: { bg: '#fee2e2', color: '#991b1b' },
};
const HISTORY_ACTION = {
  rollback: 'Moved back', hold: 'Put on hold', resume: 'Resumed', cancel: 'Cancelled',
  reopen: 'Reopened', complete: 'Completed',
};

function GateBadge({ ok, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: ok ? '#065f46' : '#9ca3af' }}>
      {ok ? <CheckCircle size={12} color="#10b981" /> : <AlertCircle size={12} color="#d1d5db" />}
      {label}
    </div>
  );
}

function StagePipeline({ stages, current, labelOf }) {
  const path = stages.filter(s => !s.reserved || s.key === current);
  const idx = path.findIndex(s => s.key === current);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
      {path.map((s, i) => {
        const done = idx >= 0 && i < idx;
        const active = s.key === current;
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
            <div data-testid={`pipeline-stage-${s.key}`} style={{
              padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
              background: active ? '#6B3FDB' : done ? '#d1fae5' : '#f3f4f6',
              color: active ? '#fff' : done ? '#065f46' : '#9ca3af',
              border: active ? '2px solid #6B3FDB' : '2px solid transparent', whiteSpace: 'nowrap',
            }}>
              {s.label}
            </div>
            {i < path.length - 1 && <ChevronRight size={12} color={done ? '#10b981' : '#d1d5db'} />}
          </div>
        );
      })}
      {idx < 0 && current && (
        <span style={{ marginLeft: 8, fontSize: 11, color: '#9ca3af' }}>Current stage: {labelOf(current)}</span>
      )}
    </div>
  );
}

/** A confirm dialog for an authorised action, with a required reason when asked. */
function ActionDialog({ dialog, onClose, onConfirm, busy }) {
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState(dialog.targets?.[dialog.targets.length - 1]?.key || '');
  const needsReason = dialog.reasonLabel != null;
  const ok = !needsReason || reason.trim().length >= REASON_MIN;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-label={dialog.title} style={{ background: '#fff', borderRadius: 16, padding: 28, width: 460, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>{dialog.title}</h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
        </div>
        <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 14px' }}>{dialog.message}</p>
        {dialog.blockers?.length > 0 && (
          <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 13, color: '#b91c1c' }}>
            {dialog.blockers.map(b => <li key={b.type}>{blockerText(b)}</li>)}
          </ul>
        )}
        {dialog.targets && (
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 12 }}>
            Move back to
            <select value={target} onChange={e => setTarget(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
              {dialog.targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
        )}
        {needsReason && (
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151' }}>
            {dialog.reasonLabel}
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
              placeholder={`Required — at least ${REASON_MIN} characters`}
              style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
          </label>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Back</button>
          <button onClick={() => onConfirm({ reason: reason.trim(), to_stage: target })} disabled={!ok || busy}
            style={{ padding: '9px 18px', background: dialog.danger ? '#dc2626' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: ok && !busy ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 600, opacity: ok && !busy ? 1 : 0.5 }}>
            {busy ? 'Working…' : dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LifecycleTracker({ pageParams } = {}) {
  const { hasPermission } = useAuth();
  const canView    = hasPermission('servicedesk', 'view');
  const canEdit    = hasPermission('servicedesk', 'edit');
  const canApprove = hasPermission('servicedesk', 'approve');
  // Set when the server refuses the list (403): shown as Access denied, never
  // as an empty list that looks like "no lifecycles".
  const [denied, setDenied] = useState(false);

  const [model, setModel]       = useState(FALLBACK_MODEL);
  const [instances, setInstances] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail]     = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [remarks, setRemarks]   = useState('');
  const [blocked, setBlocked]   = useState(null);     // { message, failing, details } from a refused advance
  const [dialog, setDialog]     = useState(null);     // the open ActionDialog
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ sales_order_id: '', project_id: '', stage_notes: '' });
  const [creating, setCreating] = useState(false);
  const [stageFilter, setStageFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const labelOf = (key) => model.stages.find(s => s.key === key)?.label || LEGACY_LABELS[key] || key || '—';

  useEffect(() => {
    if (!canView) return;
    api.get('/lifecycle/stages')
      .then(r => { if (isMounted.current && Array.isArray(r.data?.stages)) setModel(r.data); })
      .catch(() => { /* keep the fallback model */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = () => {
    if (!canView) return;
    setLoading(true);
    const params = {};
    if (stageFilter !== 'All') params.current_stage = stageFilter;
    if (statusFilter !== 'All') params.status = statusFilter;
    api.get('/lifecycle/instances', { params })
      .then(r => { if (isMounted.current) { setDenied(false); setInstances(Array.isArray(r.data) ? r.data : []); } })
      .catch((e) => {
        if (!isMounted.current) return;
        setInstances([]);
        if (e?.response?.status === 403) setDenied(true);
        else toast.error(lifecycleErrorMessage(e, 'load lifecycles'));
      })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };

  useEffect(() => { load(); }, [stageFilter, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = (id) => {
    setSelected(id); setDetailLoading(true); setDetail(null); setBlocked(null);
    api.get(`/lifecycle/instances/${id}`)
      .then(r => { if (isMounted.current) setDetail(r.data); })
      .catch((e) => { if (isMounted.current) toast.error(lifecycleErrorMessage(e, 'view this lifecycle')); })
      .finally(() => { if (isMounted.current) setDetailLoading(false); });
  };

  // Opened from Project Master / Pipeline ("Open lifecycle"): show that lifecycle.
  useEffect(() => {
    if (canView && pageParams?.lifecycleId) loadDetail(pageParams.lifecycleId);
  }, [pageParams?.lifecycleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = (id) => { loadDetail(id); load(); };

  const advance = async () => {
    if (!detail) return;
    setBusy(true);
    setBlocked(null);
    try {
      const r = await api.post(`/lifecycle/instances/${detail.id}/advance`, { remarks, to_stage: detail.next_stage });
      toast.success(`Advanced to ${labelOf(r.data.current_stage)}`);
      setRemarks('');
      refresh(detail.id);
    } catch (e) {
      const d = e.response?.data || {};
      const message = lifecycleErrorMessage(e, 'advance lifecycles');
      toast.error(message);
      if (d.code === 'GATE_NOT_SATISFIED' && isMounted.current) {
        setBlocked({ message, failing: d.failing || [], details: d.gate_details || {} });
        if (d.gates) setDetail(dd => (dd ? { ...dd, gates: d.gates } : dd));
      }
    } finally { if (isMounted.current) setBusy(false); }
  };

  const simple = async (action, done) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.post(`/lifecycle/instances/${detail.id}/${action}`, { remarks });
      toast.success(done);
      setRemarks('');
      refresh(detail.id);
    } catch (e) {
      toast.error(lifecycleErrorMessage(e, `${action} lifecycles`));
    } finally { if (isMounted.current) setBusy(false); }
  };

  // Authorised actions go through a confirm dialog; the server checks them again.
  const runDialog = async ({ reason, to_stage }) => {
    if (!detail || !dialog) return;
    const { action } = dialog;
    const body = action === 'rollback' ? { reason, to_stage }
      : action === 'complete' ? (dialog.blockers?.length ? { override_reason: reason } : {})
        : { reason };
    setBusy(true);
    try {
      await api.post(`/lifecycle/instances/${detail.id}/${action}`, body);
      toast.success(dialog.doneMessage);
      setDialog(null);
      refresh(detail.id);
    } catch (e) {
      const d = e.response?.data || {};
      if (action === 'complete' && d.code === 'CLOSURE_BLOCKED' && isMounted.current) {
        // Show what blocks closure and ask for an override reason instead.
        setDialog({
          ...dialog, blockers: d.blockers || [],
          message: 'The project still has open work. Completing anyway needs a written override reason, recorded with these blockers.',
          reasonLabel: 'Override reason', confirmLabel: 'Complete with override',
        });
      } else {
        toast.error(lifecycleErrorMessage(e, `${action} lifecycles`));
      }
    } finally { if (isMounted.current) setBusy(false); }
  };

  const openRollback = () => {
    const path = model.stages.filter(s => !s.reserved).map(s => s.key);
    const i = path.indexOf(detail.current_stage);
    const targets = (i > 0 ? path.slice(0, i) : []).map(k => ({ key: k, label: labelOf(k) }));
    if (!targets.length) { toast.error('There is no earlier stage to move back to.'); return; }
    setDialog({ action: 'rollback', title: 'Move lifecycle back', danger: false,
      message: `Move ${detail.lifecycle_number || 'this lifecycle'} back from ${labelOf(detail.current_stage)}. The move is recorded with your reason.`,
      targets, reasonLabel: 'Reason', confirmLabel: 'Move back', doneMessage: 'Lifecycle moved back' });
  };
  const openCancel = () => setDialog({ action: 'cancel', title: 'Cancel lifecycle', danger: true,
    message: 'Cancelling stops this lifecycle. Its history is kept, and an approver can reopen it later.',
    reasonLabel: 'Reason', confirmLabel: 'Cancel lifecycle', doneMessage: 'Lifecycle cancelled' });
  const openReopen = () => setDialog({ action: 'reopen', title: 'Reopen lifecycle', danger: false,
    message: `Reopen this ${detail.status} lifecycle at ${labelOf(detail.current_stage)}.`,
    reasonLabel: 'Reason', confirmLabel: 'Reopen', doneMessage: 'Lifecycle reopened' });
  const openComplete = () => setDialog({ action: 'complete', title: 'Complete lifecycle', danger: false,
    message: 'Complete the lifecycle at Closure. Open tasks, unbilled billing milestones or pending timesheets will block it.',
    reasonLabel: null, confirmLabel: 'Complete', doneMessage: 'Lifecycle completed' });

  const handleCreate = async () => {
    if (!createForm.sales_order_id && !createForm.project_id) {
      toast.error('Enter a project ID or a confirmed sales order ID — a lifecycle belongs to one of them.');
      return;
    }
    setCreating(true);
    try {
      await api.post('/lifecycle/instances', {
        sales_order_id: createForm.sales_order_id ? Number(createForm.sales_order_id) : null,
        project_id: createForm.project_id ? Number(createForm.project_id) : null,
        stage_notes: createForm.stage_notes || 'Lifecycle created manually',
      });
      toast.success('Lifecycle instance created');
      setShowCreate(false);
      setCreateForm({ sales_order_id: '', project_id: '', stage_notes: '' });
      load();
    } catch (e) {
      toast.error(lifecycleErrorMessage(e, 'create lifecycles'));
    } finally { if (isMounted.current) setCreating(false); }
  };

  const status = detail?.status;
  const isActive = status === 'active';
  const isOnHold = status === 'on_hold';
  const isClosed = status === 'completed' || status === 'cancelled';
  const atFinal = detail?.current_stage === (model.final_stage || 'closure');
  const nextStageName = detail?.next_stage ? labelOf(detail.next_stage) : null;
  const filterStages = model.stages.filter(s => !s.reserved);
  const lockTitle = (what) => `You don't have permission to ${what}`;

  if (!canView || denied) {
    return (
      <PageShell dock={<PageHero icon={Network} eyebrow="Operations" title="Lifecycle Tracker" />}>
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '72px 24px', textAlign: 'center', width: '100%' }}>
          <ShieldOff size={36} color="#9ca3af" style={{ marginBottom: 12 }} />
          <p style={{ fontWeight: 600, fontSize: 15, color: '#1f2937', margin: '0 0 4px' }}>Access denied</p>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0, maxWidth: 420 }}>
            Viewing production lifecycles needs Service Desk view access. Ask an administrator if you need it.
          </p>
        </div>
      </PageShell>
    );
  }

  const btn = (color, border, bg) => ({ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', border: `1px solid ${border}`, borderRadius: 8, background: bg, cursor: 'pointer', fontSize: 12, fontWeight: 600, color });

  return (
    <PageShell dock={
      <PageHero icon={Network} eyebrow="Operations" title="Lifecycle Tracker"
        subtitle="Production stages, gates and the audited history of every move" />
    }>
      {/* Left panel */}
      <div style={{ width: 380, borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #f0f0f4' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>{instances.length} instances</p>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={load} aria-label="Refresh" style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7, background: '#fff', cursor: 'pointer', color: '#6b7280' }}>
                <RefreshCw size={14} />
              </button>
              {canEdit && (
                <button onClick={() => setShowCreate(true)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  <Plus size={13} /> New
                </button>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <select aria-label="Stage filter" value={stageFilter} onChange={e => setStageFilter(e.target.value)}
              style={{ flex: 1, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, outline: 'none' }}>
              <option value="All">All Stages</option>
              {filterStages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <select aria-label="Status filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              style={{ flex: 1, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, outline: 'none' }}>
              <option value="All">All Status</option>
              <option value="active">Active</option>
              <option value="on_hold">On Hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading lifecycles…</div>
          ) : (instances?.length ?? 0) === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No lifecycle instances found</div>
          ) : instances?.map(inst => {
            const sc = STATUS_COLOR[inst?.status ?? 'active'] || STATUS_COLOR.active;
            return (
              <div key={inst?.id} onClick={() => loadDetail(inst?.id)}
                style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f4', cursor: 'pointer',
                  background: selected === inst?.id ? '#f5f3ff' : '#fff',
                  borderLeft: selected === inst?.id ? '3px solid #6B3FDB' : '3px solid transparent' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#6B3FDB' }}>{inst?.lifecycle_number ?? `LC-${inst?.id}`}</span>
                  <span style={{ background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600 }}>{inst?.status ?? 'unknown'}</span>
                </div>
                <div style={{ fontSize: 12, color: '#374151', marginBottom: 4 }}>
                  {inst?.order_number ? `SO: ${inst.order_number}` : 'No sales order'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6B3FDB', fontWeight: 600 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#6B3FDB' }} />
                  {labelOf(inst?.current_stage)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — detail */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {!selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>
            <RefreshCw size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
            <p style={{ fontSize: 14 }}>Select a lifecycle instance to view details</p>
          </div>
        ) : detailLoading ? (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 60, fontSize: 13 }}>Loading details...</div>
        ) : detail ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1f2937', margin: 0 }}>{detail.lifecycle_number || `LC-${detail.id}`}</h2>
                <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
                  {labelOf(detail.current_stage)} · {status}{detail.order_number ? ` · Sales Order ${detail.order_number}` : ''}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {isActive && (canEdit
                  ? <button onClick={() => simple('hold', 'Put on hold')} disabled={busy} style={btn('#5b21b6', '#e5e7eb', '#fff')}><PauseCircle size={13} /> Hold</button>
                  : <button disabled title={lockTitle('put lifecycles on hold')} style={btn('#9ca3af', '#e5e7eb', '#fff')}><Lock size={12} /> Hold</button>)}
                {isOnHold && (canEdit
                  ? <button onClick={() => simple('resume', 'Resumed')} disabled={busy} style={btn('#065f46', '#10b981', '#d1fae5')}><PlayCircle size={13} /> Resume</button>
                  : <button disabled title={lockTitle('resume lifecycles')} style={btn('#9ca3af', '#e5e7eb', '#fff')}><Lock size={12} /> Resume</button>)}
                {canApprove && isActive && (
                  <button onClick={openRollback} disabled={busy} style={btn('#92400e', '#fcd34d', '#fffbeb')}><Undo2 size={13} /> Roll back</button>
                )}
                {canApprove && isActive && atFinal && (
                  <button onClick={openComplete} disabled={busy} style={btn('#1e40af', '#93c5fd', '#eff6ff')}><Flag size={13} /> Complete</button>
                )}
                {canApprove && (isActive || isOnHold) && (
                  <button onClick={openCancel} disabled={busy} style={btn('#991b1b', '#fca5a5', '#fff')}><Ban size={13} /> Cancel</button>
                )}
                {canApprove && isClosed && (
                  <button onClick={openReopen} disabled={busy} style={btn('#065f46', '#10b981', '#fff')}><RotateCcw size={13} /> Reopen</button>
                )}
                {!canApprove && (isActive || isOnHold || isClosed) && (
                  <span title={lockTitle('move back, cancel, reopen or complete lifecycles')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9ca3af' }}>
                    <Lock size={11} /> Rollback, cancel, reopen and complete need approver access
                  </span>
                )}
              </div>
            </div>

            {/* Stage Pipeline */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, marginBottom: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 14px' }}>Stage Pipeline</h3>
              <StagePipeline stages={model.stages} current={detail.current_stage} labelOf={labelOf} />
            </div>

            {/* Gates */}
            {detail.gates && (
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 12px' }}>Gate Status</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                  {Object.entries(detail.gates).map(([k, v]) => <GateBadge key={k} ok={v} label={gateLabel(k)} />)}
                </div>
              </div>
            )}

            {/* Advance */}
            {isActive && nextStageName && (
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 12px' }}>Advance to Next Stage</h3>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
                  {labelOf(detail.current_stage)} → <strong>{nextStageName}</strong>
                </p>
                {(detail.next_stage_gates || []).length > 0 && (
                  <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12, color: '#4b5563' }}>
                    {detail.next_stage_gates.map(g => (
                      <li key={g} style={{ color: detail.gates?.[g] ? '#065f46' : '#b45309' }}>
                        {detail.gates?.[g] ? '✓' : '○'} {gateLabel(g)}
                      </li>
                    ))}
                  </ul>
                )}
                {blocked && (
                  <div role="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12.5, color: '#b91c1c' }}>
                    <strong>Not ready:</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {blocked.failing.map(g => (
                        <li key={g}>{gateLabel(g)}{blocked.details?.[g]?.reason ? ` — ${blocked.details[g].reason}` : ''}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {canEdit ? (
                  <>
                    <input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Remarks (optional)"
                      style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', marginBottom: 10, boxSizing: 'border-box' }} />
                    <button onClick={advance} disabled={busy}
                      style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
                      {busy ? 'Advancing...' : `Advance to ${nextStageName}`}
                    </button>
                  </>
                ) : (
                  <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9ca3af', margin: 0 }}>
                    <Lock size={12} /> {lockTitle('advance lifecycles')}.
                  </p>
                )}
              </div>
            )}
            {isActive && atFinal && (
              <div style={{ background: '#eff6ff', borderRadius: 12, padding: 16, marginBottom: 20, fontSize: 13, color: '#1e40af' }}>
                At Closure — the lifecycle is completed by an approver (Complete), not advanced.
              </div>
            )}
            {status === 'completed' && (
              <div style={{ background: '#d1fae5', borderRadius: 12, padding: 16, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
                <CheckCircle size={18} color="#059669" />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#065f46' }}>Lifecycle completed</span>
              </div>
            )}

            {/* Stage History */}
            {detail.history && detail.history.length > 0 && (
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 14px' }}>Stage History</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {detail.history.map((h, i) => (
                    <div key={h.id || i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', paddingBottom: 8, borderBottom: i < detail.history.length - 1 ? '1px solid #f0f0f4' : 'none' }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#6B3FDB', marginTop: 4, flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#1f2937' }}>
                          {h.action === 'advance' || h.action === 'rollback'
                            ? `${h.action === 'rollback' ? 'Moved back: ' : ''}${h.from_stage ? labelOf(h.from_stage) : '—'} → ${labelOf(h.to_stage)}`
                            : `${HISTORY_ACTION[h.action] || h.action} at ${labelOf(h.to_stage)}`}
                        </div>
                        {h.remarks && <div style={{ fontSize: 11, color: '#6b7280' }}>{h.remarks}</div>}
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{h.actor_name} · {new Date(h.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>

      {dialog && (
        <ActionDialog key={`${dialog.action}-${dialog.blockers?.length || 0}`} dialog={dialog} busy={busy}
          onClose={() => setDialog(null)} onConfirm={runDialog} />
      )}

      {/* Create Modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>New Lifecycle Instance</h2>
              <button onClick={() => setShowCreate(false)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px' }}>A lifecycle belongs to a project, or to a confirmed sales order (its project is created if it has none). It starts at Order.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[['project_id', 'Project ID'], ['sales_order_id', 'Sales Order ID (confirmed)'], ['stage_notes', 'Stage Notes']].map(([k, l]) => (
                <label key={k} style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151' }}>
                  {l}
                  <input value={createForm[k]} onChange={e => setCreateForm(p => ({ ...p, [k]: e.target.value }))}
                    style={{ display: 'block', width: '100%', marginTop: 4, padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowCreate(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleCreate} disabled={creating}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: creating ? 0.6 : 1 }}>
                {creating ? 'Creating...' : 'Create Lifecycle'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
