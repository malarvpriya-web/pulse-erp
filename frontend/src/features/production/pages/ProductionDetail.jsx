import { useEffect, useState } from 'react';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import QualityTestsPanel from '@/features/quality/components/QualityTestsPanel';
import {
  getProductionOrder, releaseOrder,
  cancelOrder, holdOrder, resumeOrder,
  reserveMaterials, issueMaterial,
  startOperation, completeOperation, holdOperation,
  getTestRuns, createTestRun, getTestRun, addMeasurement, completeTestRun,
  downloadCertificate,
} from '../services/productionService';

const TAB_OVERVIEW    = 'overview';
const TAB_OPERATIONS  = 'operations';
const TAB_MATERIALS   = 'materials';
const TAB_TESTS       = 'tests';

const STATUS_COLORS = {
  completed:   ['#dcfce7', '#166534'],
  in_progress: ['#dbeafe', '#1e40af'],
  planned:     ['#fef9c3', '#854d0e'],
  released:    ['#e0f2fe', '#0369a1'],
  on_hold:     ['#f3f4f6', '#374151'],
  cancelled:   ['#fee2e2', '#991b1b'],
  pending:     ['#fef9c3', '#854d0e'],
  ready:       ['#e0f2fe', '#0369a1'],
  skipped:     ['#f3f4f6', '#6b7280'],
  pass:        ['#dcfce7', '#166534'],
  fail:        ['#fee2e2', '#991b1b'],
  hold:        ['#fef9c3', '#854d0e'],
  na:          ['#f3f4f6', '#374151'],
};

function StatusBadge({ s }) {
  const [bg, color] = STATUS_COLORS[s?.toLowerCase()] || ['#f3f4f6', '#374151'];
  return (
    <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: bg, color }}>
      {s || '—'}
    </span>
  );
}

// Standard SST/STATCOM electrical parameters for quick-pick
const SST_PARAMS = [
  { code: 'V_IN',   name: 'Input Voltage',        unit: 'V'     },
  { code: 'V_OUT',  name: 'Output Voltage',        unit: 'V'     },
  { code: 'I_IN',   name: 'Input Current',         unit: 'A'     },
  { code: 'I_OUT',  name: 'Output Current',        unit: 'A'     },
  { code: 'THD_I',  name: 'THD (Current)',         unit: '%'     },
  { code: 'THD_V',  name: 'THD (Voltage)',         unit: '%'     },
  { code: 'EFF',    name: 'Efficiency',            unit: '%'     },
  { code: 'PF',     name: 'Power Factor',          unit: ''      },
  { code: 'P_OUT',  name: 'Active Power Out',      unit: 'kW'    },
  { code: 'Q_OUT',  name: 'Reactive Power',        unit: 'kVAR'  },
  { code: 'T_RISE', name: 'Temperature Rise',      unit: '°C'    },
  { code: 'V_ISO',  name: 'Insulation Withstand',  unit: 'kV'    },
];

const emptyMeas = { parameter_code: '', parameter_name: '', unit: '', measured_value: '', min_limit: '', max_limit: '', target_value: '' };
const emptyRun  = { test_type: '', test_stage: 'FAT', serial_number: '', station_name: '', test_spec_revision: '' };

export default function ProductionDetail({ order: initialOrder, setPage, initialTab }) {
  const toast = useToast();
  const [order,         setOrder]         = useState(initialOrder);
  const [tab,           setTab]           = useState(initialTab || TAB_OVERVIEW);
  const [loading,       setLoading]       = useState(false);
  const [submitting,    setSubmitting]    = useState(false);
  const [issueModal,    setIssueModal]    = useState(null); // { resourceId, itemId, remaining }

  // Operations
  const [actionModal,   setActionModal]   = useState(null); // { type: 'start'|'complete'|'hold', op }
  const [actionForm,    setActionForm]    = useState({});

  // Test runs
  const [testRuns,      setTestRuns]      = useState([]);
  const [runsLoaded,    setRunsLoaded]    = useState(false);
  const [selectedRun,   setSelectedRun]   = useState(null);
  const [runModal,      setRunModal]      = useState(false);
  const [runForm,       setRunForm]       = useState(emptyRun);
  const [measModal,     setMeasModal]     = useState(false);
  const [measForm,      setMeasForm]      = useState(emptyMeas);
  const [pendingCancel, setPendingCancel] = useState(false);
  const [qualityOp,     setQualityOp]     = useState(null); // operation whose quality tests are open

  const loadOrder = async () => {
    if (!initialOrder?.id) return;
    setLoading(true);
    try {
      const full = await getProductionOrder(initialOrder.id);
      setOrder(full);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load order details');
    } finally {
      setLoading(false);
    }
  };

  const loadTestRuns = async () => {
    if (!initialOrder?.id) return;
    try {
      const runs = await getTestRuns(initialOrder.id);
      setTestRuns(runs);
      setRunsLoaded(true);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load test runs');
    }
  };

  useEffect(() => { loadOrder(); }, [initialOrder?.id]);

  useEffect(() => {
    if (tab === TAB_TESTS && !runsLoaded) loadTestRuns();
  }, [tab]);

  if (!initialOrder) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
        No order selected.{' '}
        <button onClick={() => setPage('ProductionOrders')}
          style={{ color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
          Back to Orders
        </button>
      </div>
    );
  }

  const ops  = order?.operations || [];
  const logs = order?.logs       || [];

  // -- Operation actions --
  const handleOpAction = async () => {
    if (!actionModal) return;
    setSubmitting(true);
    try {
      const { type, op } = actionModal;
      if (type === 'start')    await startOperation(op.id, actionForm);
      if (type === 'complete') await completeOperation(op.id, actionForm);
      if (type === 'hold')     await holdOperation(op.id, actionForm);
      setActionModal(null);
      setActionForm({});
      await loadOrder();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Operation failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRelease = async () => {
    setSubmitting(true);
    try {
      await releaseOrder(order.id);
      await loadOrder();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to release order. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!pendingCancel) return;
    setPendingCancel(false);
    setSubmitting(true);
    try {
      await cancelOrder(order.id, {});
      await loadOrder();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to cancel order.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleHold = async () => {
    setSubmitting(true);
    try {
      await holdOrder(order.id, {});
      await loadOrder();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to hold order.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResume = async () => {
    setSubmitting(true);
    try {
      await resumeOrder(order.id, {});
      await loadOrder();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to resume order.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleIssueMaterial = async (reservationId, itemId, qty) => {
    setSubmitting(true);
    try {
      await issueMaterial(order.id, { reservation_id: reservationId, item_id: itemId, qty_issued: qty });
      await loadOrder();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to issue material.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReserveMaterials = async () => {
    setSubmitting(true);
    try {
      await reserveMaterials(order.id);
      await loadOrder();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to reserve materials.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Test run actions ─────────────────────────────────────────────────────
  const handleCreateRun = async () => {
    if (!runForm.test_type) return;
    setSubmitting(true);
    try {
      const run = await createTestRun({
        ...runForm,
        production_order_id: order.id,
        product_name:        order.product_name,
      });
      setRunModal(false);
      setRunForm(emptyRun);
      await loadTestRuns();
      const full = await getTestRun(run.id);
      setSelectedRun(full);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to create test run. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectRun = async (run) => {
    try {
      const full = await getTestRun(run.id);
      setSelectedRun(full);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load test run details. Please try again.');
    }
  };

  const handleAddMeasurement = async () => {
    if (!measForm.parameter_name || !selectedRun) return;
    setSubmitting(true);
    try {
      await addMeasurement(selectedRun.id, measForm);
      setMeasModal(false);
      setMeasForm(emptyMeas);
      const updated = await getTestRun(selectedRun.id);
      setSelectedRun(updated);
      await loadTestRuns();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to add measurement. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCompleteRun = async (runId) => {
    setSubmitting(true);
    try {
      await completeTestRun(runId, {});
      await loadTestRuns();
      if (selectedRun?.id === runId) {
        const updated = await getTestRun(runId);
        setSelectedRun(updated);
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to finalise test run. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const reservations = order?.reservations || [];

  const TABS = [
    { key: TAB_OVERVIEW,   label: 'Overview'                                },
    { key: TAB_OPERATIONS, label: `Operations (${ops.length})`              },
    { key: TAB_MATERIALS,  label: `Materials (${reservations.length})`      },
    { key: TAB_TESTS,      label: `Test Runs (${testRuns.length})`          },
  ];

  const opActionLabel = actionModal?.type === 'complete' ? 'Complete Operation'
                      : actionModal?.type === 'hold'     ? 'Hold Operation'
                      : 'Start Operation';

  return (
    <div style={{ padding: 24 }}>
      <ConfirmDialog
        open={pendingCancel}
        title="Cancel Production Order"
        message="Cancel this production order? All material reservations will be released."
        confirmLabel="Cancel Order"
        variant="danger"
        onConfirm={handleCancel}
        onCancel={() => setPendingCancel(false)}
      />

      {qualityOp && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
             onClick={() => setQualityOp(null)}>
          <div onClick={e => e.stopPropagation()}
               style={{ background: '#fff', borderRadius: 12, padding: 24, width: 'min(860px, 96vw)', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Quality Tests — Step {qualityOp.step_no}: {qualityOp.operation}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>{order?.product_name} · {order?.production_order_no}</p>
              </div>
              <button onClick={() => setQualityOp(null)}
                style={{ background: '#f3f4f6', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>Close</button>
            </div>
            <QualityTestsPanel
              source={{ operationId: qualityOp.id, productionOrderId: order?.id, itemName: order?.product_name }}
              title=""
              defaultStage="IPQC"
              onChange={() => loadOrder()}
            />
          </div>
        </div>
      )}

      {issueModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700 }}>Issue Material</h3>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6b7280' }}>{issueModal.itemName} — remaining: {issueModal.remaining}</p>
            <input
              autoFocus
              type="number"
              min="0.001"
              max={issueModal.remaining}
              step="0.001"
              style={{ width: '100%', borderRadius: 8, border: '1px solid #d1d5db', padding: '8px 12px', fontSize: 13 }}
              value={issueModal.qty}
              onChange={e => setIssueModal(m => ({ ...m, qty: e.target.value }))}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const qty = parseFloat(issueModal.qty);
                  if (qty > 0) { handleIssueMaterial(issueModal.resourceId, issueModal.itemId, qty); setIssueModal(null); }
                }
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setIssueModal(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
              <button
                onClick={() => {
                  const qty = parseFloat(issueModal.qty);
                  if (qty > 0) { handleIssueMaterial(issueModal.resourceId, issueModal.itemId, qty); setIssueModal(null); }
                }}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#1e40af', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
                Issue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <button onClick={() => setPage('ProductionOrders')}
          style={{ padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
          ← Back
        </button>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>
            {order.production_order_no || order.id}
          </h2>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{order.product_name}</div>
        </div>
        <StatusBadge s={order.status} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {order.status === 'planned' && (
            <button onClick={handleRelease} disabled={submitting}
              style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Release Order
            </button>
          )}
          {order.status === 'in_progress' && (
            <button onClick={handleHold} disabled={submitting}
              style={{ padding: '7px 16px', background: '#d97706', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Hold Order
            </button>
          )}
          {order.status === 'on_hold' && (
            <button onClick={handleResume} disabled={submitting}
              style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Resume Order
            </button>
          )}
          {!['completed', 'cancelled'].includes(order.status) && (
            <button onClick={() => setPendingCancel(true)} disabled={submitting}
              style={{ padding: '7px 16px', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Cancel Order
            </button>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 14, fontWeight: tab === t.key ? 700 : 400,
              color: tab === t.key ? '#6366f1' : '#6b7280',
              borderBottom: tab === t.key ? '2px solid #6366f1' : '2px solid transparent',
              marginBottom: -2,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : (
        <>
          {/* ══ OVERVIEW ══════════════════════════════════════════════════ */}
          {tab === TAB_OVERVIEW && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, maxWidth: 900 }}>
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#374151', marginBottom: 12 }}>Order Details</div>
                {[
                  ['Order No.',          order.production_order_no || order.id],
                  ['Product',            order.product_name],
                  ['BOM ID',             order.bom_id || '—'],
                  ['Qty Planned',        order.quantity_planned],
                  ['Qty Completed',      order.quantity_completed  || 0],
                  ['Qty Scrapped',       order.quantity_scrapped   || 0],
                  ['Priority',           order.priority || '—'],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', padding: '8px 0', borderBottom: '1px solid #f9fafb' }}>
                    <div style={{ width: 160, fontSize: 13, fontWeight: 600, color: '#6b7280', flexShrink: 0 }}>{label}</div>
                    <div style={{ fontSize: 13, color: '#111827' }}>{value ?? '—'}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#374151', marginBottom: 12 }}>Timeline</div>
                {[
                  ['Planned Start', order.planned_start_date ? new Date(order.planned_start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'],
                  ['Planned End',   order.planned_end_date   ? new Date(order.planned_end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })   : '—'],
                  ['Actual Start',  order.actual_start_at    ? new Date(order.actual_start_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })        : '—'],
                  ['Actual End',    order.actual_end_at      ? new Date(order.actual_end_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })          : '—'],
                  ['Released By',   order.released_by_name   || '—'],
                  ['Created',       order.created_at         ? new Date(order.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })         : '—'],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', padding: '8px 0', borderBottom: '1px solid #f9fafb' }}>
                    <div style={{ width: 160, fontSize: 13, fontWeight: 600, color: '#6b7280', flexShrink: 0 }}>{label}</div>
                    <div style={{ fontSize: 13, color: '#111827' }}>{value}</div>
                  </div>
                ))}
                {order.notes && (
                  <div style={{ marginTop: 12, padding: 12, background: '#f9fafb', borderRadius: 8, fontSize: 13, color: '#374151' }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: '#6b7280' }}>Notes</div>
                    {order.notes}
                  </div>
                )}
              </div>

              {ops.length > 0 && (
                <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, gridColumn: '1 / -1' }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#374151', marginBottom: 12 }}>Operations Progress</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 99, height: 12, overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.round((ops.filter(o => o.status === 'completed').length / ops.length) * 100)}%`,
                        height: '100%', background: '#10b981', borderRadius: 99, transition: 'width 0.3s',
                      }} />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
                      {ops.filter(o => o.status === 'completed').length} / {ops.length} steps
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ OPERATIONS ════════════════════════════════════════════════ */}
          {tab === TAB_OPERATIONS && (
            <div>
              {ops.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4' }}>
                  No operations defined. Link a BOM with routing steps when creating the order to auto-generate work centre operations.
                </div>
              ) : (
                <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        {['Step', 'Operation', 'Work Centre', 'Std Hrs', 'Qty In', 'Qty Out', 'Scrap', 'Status', 'Started', 'Completed', 'Actions'].map(h => (
                          <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ops.map(op => (
                        <tr key={op.id} style={{ borderTop: '1px solid #f0f0f4' }}>
                          <td style={{ padding: '10px 12px', fontWeight: 700, color: '#374151' }}>{op.step_no}</td>
                          <td style={{ padding: '10px 12px', color: '#111827' }}>{op.operation}</td>
                          <td style={{ padding: '10px 12px', color: '#6b7280' }}>{op.work_centre_name || '—'}</td>
                          <td style={{ padding: '10px 12px', color: '#374151' }}>{op.std_time_hrs || '—'}</td>
                          <td style={{ padding: '10px 12px', color: '#374151' }}>{op.quantity_in   || 0}</td>
                          <td style={{ padding: '10px 12px', color: '#374151' }}>{op.quantity_out  || 0}</td>
                          <td style={{ padding: '10px 12px', color: '#ef4444' }}>{op.quantity_scrap || 0}</td>
                          <td style={{ padding: '10px 12px' }}><StatusBadge s={op.status} /></td>
                          <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                            {op.started_at ? new Date(op.started_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                            {op.completed_at ? new Date(op.completed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              {(op.status === 'ready' || op.status === 'pending') && (
                                <button onClick={() => { setActionModal({ type: 'start', op }); setActionForm({}); }}
                                  style={{ padding: '3px 10px', background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                                  Start
                                </button>
                              )}
                              {op.status === 'in_progress' && (
                                <>
                                  <button onClick={() => { setActionModal({ type: 'complete', op }); setActionForm({}); }}
                                    style={{ padding: '3px 10px', background: '#dcfce7', color: '#166534', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                                    Complete
                                  </button>
                                  <button onClick={() => { setActionModal({ type: 'hold', op }); setActionForm({}); }}
                                    style={{ padding: '3px 10px', background: '#fef9c3', color: '#854d0e', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                                    Hold
                                  </button>
                                </>
                              )}
                              {op.status === 'on_hold' && (
                                <button onClick={() => { setActionModal({ type: 'start', op }); setActionForm({}); }}
                                  style={{ padding: '3px 10px', background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                                  Resume
                                </button>
                              )}
                              <button onClick={() => setQualityOp(op)}
                                title="Quality tests for this operation"
                                style={{ padding: '3px 10px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                                🧪 Quality{op.quality_status && op.quality_status !== 'not_required' ? ` · ${op.quality_status}` : ''}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {logs.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#374151', marginBottom: 12 }}>Operation Log</div>
                  <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
                    {logs.slice(0, 20).map(l => (
                      <div key={l.id} style={{ display: 'flex', gap: 12, padding: '10px 16px', borderBottom: '1px solid #f9fafb', alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap', marginTop: 1 }}>
                          {l.created_at ? new Date(l.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#6366f1', textTransform: 'uppercase', minWidth: 80 }}>{l.event_type}</span>
                        <span style={{ fontSize: 13, color: '#374151' }}>{l.remarks || ''}</span>
                        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{l.actor_name || ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ MATERIALS ════════════════════════════════════════════════ */}
          {tab === TAB_MATERIALS && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#4c1d95' }}>Material Reservations & Issues</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={loadOrder} style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>↻</button>
                  {['released', 'in_progress'].includes(order.status) && reservations.length === 0 && (
                    <button onClick={handleReserveMaterials} disabled={submitting}
                      style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      Reserve Materials
                    </button>
                  )}
                </div>
              </div>

              {reservations.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff' }}>
                  {order.status === 'planned'
                    ? 'Materials will be reserved automatically when the order is released.'
                    : 'No material reservations found. Use "Reserve Materials" to reserve BOM components.'}
                </div>
              ) : (
                <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f5f3ff' }}>
                        {['Item', 'Required Qty', 'Reserved Qty', 'Issued Qty', 'Status', 'Action'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#4c1d95', fontSize: 12 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reservations.map(res => {
                        const statusColor = {
                          reserved:          ['#dbeafe', '#1e40af'],
                          partially_issued:  ['#fef3c7', '#92400e'],
                          fully_issued:      ['#dcfce7', '#166534'],
                          consumed:          ['#f3f4f6', '#374151'],
                          cancelled:         ['#fee2e2', '#991b1b'],
                          pending:           ['#fef9c3', '#854d0e'],
                        }[res.status] || ['#f3f4f6', '#374151'];
                        const canIssue = ['released', 'in_progress'].includes(order.status) &&
                          ['reserved', 'partially_issued'].includes(res.status);
                        const remaining = (res.qty_required || 0) - (res.qty_issued || 0);
                        return (
                          <tr key={res.id} style={{ borderTop: '1px solid #f0ebff' }}>
                            <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>{res.item_name || res.item_id}</td>
                            <td style={{ padding: '10px 14px', color: '#374151' }}>{res.qty_required} {res.unit || ''}</td>
                            <td style={{ padding: '10px 14px', color: '#374151' }}>{res.qty_reserved || 0}</td>
                            <td style={{ padding: '10px 14px', color: '#374151' }}>{res.qty_issued || 0}</td>
                            <td style={{ padding: '10px 14px' }}>
                              <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                background: statusColor[0], color: statusColor[1] }}>
                                {res.status?.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td style={{ padding: '10px 14px' }}>
                              {canIssue && remaining > 0 && (
                                <button
                                  onClick={() => setIssueModal({ resourceId: res.id, itemId: res.item_id, itemName: res.item_name || res.item_id, remaining, qty: String(remaining) })}
                                  disabled={submitting}
                                  style={{ padding: '4px 12px', background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                                  Issue
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Costs section */}
              {order.costs && (
                <div style={{ marginTop: 20, background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 20 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#4c1d95', marginBottom: 14 }}>Cost Summary</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                    {[
                      { label: 'Std Material', val: order.costs.std_material_cost,    color: '#6b7280' },
                      { label: 'Std Machine',  val: order.costs.std_machine_cost,     color: '#6b7280' },
                      { label: 'Act Material', val: order.costs.actual_material_cost, color: '#1e40af' },
                      { label: 'Act Machine',  val: order.costs.actual_machine_cost,  color: '#1e40af' },
                      { label: 'Total Std',    val: order.costs.std_total_cost,       color: '#374151' },
                      { label: 'Total Actual', val: order.costs.actual_total_cost,    color: '#374151' },
                      { label: 'Variance',     val: order.costs.total_variance,       color: (order.costs.total_variance || 0) > 0 ? '#dc2626' : '#16a34a' },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>{label}</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color }}>
                          {val != null ? `₹${new Intl.NumberFormat('en-IN').format(Math.round(val))}` : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ TEST RUNS ═════════════════════════════════════════════════ */}
          {tab === TAB_TESTS && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>Electrical Test Runs</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={loadTestRuns} style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>↻</button>
                  <button onClick={() => { setRunModal(true); setRunForm(emptyRun); }}
                    style={{ padding: '7px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    + New Test Run
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: selectedRun ? '340px 1fr' : '1fr', gap: 20 }}>
                {/* Run list */}
                <div>
                  {testRuns.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4' }}>
                      No test runs yet. Click "+ New Test Run" to begin electrical testing.
                    </div>
                  ) : (
                    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
                      {testRuns.map(run => {
                        const [rbg, rc] = STATUS_COLORS[run.overall_result] || ['#f3f4f6', '#374151'];
                        const isSelected = selectedRun?.id === run.id;
                        return (
                          <div key={run.id} onClick={() => handleSelectRun(run)}
                            style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f4', cursor: 'pointer', background: isSelected ? '#eef2ff' : '#fff' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>{run.run_number}</div>
                                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                                  {run.test_stage} · {run.test_type}
                                  {run.serial_number ? ` · S/N: ${run.serial_number}` : ''}
                                </div>
                                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                                  {run.measurement_count || 0} params
                                  {Number(run.fail_count) > 0 ? ` · ${run.fail_count} FAIL` : ''}
                                </div>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                                <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: rbg, color: rc }}>
                                  {run.overall_result}
                                </span>
                                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                                  {run.started_at ? new Date(run.started_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Run detail */}
                {selectedRun && (
                  <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{selectedRun.run_number}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                          {selectedRun.test_stage} · {selectedRun.test_type}
                          {selectedRun.serial_number ? ` · S/N: ${selectedRun.serial_number}` : ''}
                          {selectedRun.station_name ? ` · Station: ${selectedRun.station_name}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {selectedRun.overall_result === 'in_progress' && (
                          <>
                            <button onClick={() => { setMeasModal(true); setMeasForm(emptyMeas); }}
                              style={{ padding: '5px 12px', background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                              + Measurement
                            </button>
                            <button onClick={() => handleCompleteRun(selectedRun.id)} disabled={submitting}
                              style={{ padding: '5px 12px', background: '#dcfce7', color: '#166534', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                              Finalise
                            </button>
                          </>
                        )}
                        {(selectedRun.overall_result === 'pass' || selectedRun.overall_result === 'fail') && (
                          <button
                            onClick={() => downloadCertificate(selectedRun.id, selectedRun.run_number, selectedRun.test_stage)}
                            style={{ padding: '5px 12px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                            PDF Certificate
                          </button>
                        )}
                        <StatusBadge s={selectedRun.overall_result} />
                        <button onClick={() => setSelectedRun(null)}
                          style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#6b7280', lineHeight: 1 }}>×</button>
                      </div>
                    </div>

                    {!selectedRun.measurements?.length ? (
                      <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                        No measurements yet. Click "+ Measurement" to log electrical parameters.
                      </div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ background: '#f9fafb' }}>
                              {['Code', 'Parameter', 'Value', 'Unit', 'Min', 'Max', 'Target', 'Result'].map(h => (
                                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {selectedRun.measurements.map(m => {
                              const [rbg, rc] = STATUS_COLORS[m.result] || ['#f3f4f6', '#374151'];
                              return (
                                <tr key={m.id} style={{ borderTop: '1px solid #f0f0f4' }}>
                                  <td style={{ padding: '8px 12px', color: '#6b7280', fontFamily: 'monospace', fontSize: 11 }}>{m.parameter_code || '—'}</td>
                                  <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>{m.parameter_name}</td>
                                  <td style={{ padding: '8px 12px', fontWeight: m.result === 'fail' ? 700 : 400, color: m.result === 'fail' ? '#ef4444' : '#111827' }}>
                                    {m.measured_value !== null ? m.measured_value : '—'}
                                  </td>
                                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{m.unit || '—'}</td>
                                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{m.min_limit !== null ? m.min_limit : '—'}</td>
                                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{m.max_limit !== null ? m.max_limit : '—'}</td>
                                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{m.target_value !== null ? m.target_value : '—'}</td>
                                  <td style={{ padding: '8px 12px' }}>
                                    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: rbg, color: rc }}>{m.result}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ══ MODALS ════════════════════════════════════════════════════════ */}

      {/* Operation action modal */}
      {actionModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setActionModal(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 380, boxShadow: '0 8px 30px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>{opActionLabel}</h3>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
              Step {actionModal.op.step_no}: {actionModal.op.operation}
              {actionModal.op.work_centre_name ? ` — ${actionModal.op.work_centre_name}` : ''}
            </div>
            {actionModal.type === 'start' && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quantity In</label>
                <input type="number" value={actionForm.quantity_in || ''} onChange={e => setActionForm(f => ({ ...f, quantity_in: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            )}
            {actionModal.type === 'complete' && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quantity Out</label>
                  <input type="number" value={actionForm.quantity_out || ''} onChange={e => setActionForm(f => ({ ...f, quantity_out: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quantity Scrap</label>
                  <input type="number" value={actionForm.quantity_scrap || ''} onChange={e => setActionForm(f => ({ ...f, quantity_scrap: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              </>
            )}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Remarks</label>
              <textarea rows={2} value={actionForm.remarks || ''} onChange={e => setActionForm(f => ({ ...f, remarks: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, resize: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setActionModal(null)} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleOpAction} disabled={submitting}
                style={{ padding: '8px 20px', background: submitting ? '#c7d2fe' : '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                {submitting ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New test run modal */}
      {runModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setRunModal(false)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 440, boxShadow: '0 8px 30px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700 }}>New Test Run</h3>
            {[
              { label: 'Test Type *',    key: 'test_type',           placeholder: 'e.g. FAT Electrical, Power Quality, Insulation' },
              { label: 'Serial Number',  key: 'serial_number',       placeholder: '' },
              { label: 'Test Station',   key: 'station_name',        placeholder: '' },
              { label: 'Spec Revision',  key: 'test_spec_revision',  placeholder: '' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>{f.label}</label>
                <input value={runForm[f.key]} onChange={e => setRunForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            ))}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Test Stage</label>
              <select value={runForm.test_stage} onChange={e => setRunForm(p => ({ ...p, test_stage: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
                {['IQC', 'FAT', 'SAT', 'RMA', 'prototype'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setRunModal(false)} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleCreateRun} disabled={submitting || !runForm.test_type}
                style={{ padding: '8px 20px', background: submitting || !runForm.test_type ? '#c7d2fe' : '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                {submitting ? 'Creating…' : 'Create Run'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add measurement modal */}
      {measModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setMeasModal(false)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700 }}>Add Measurement</h3>

            {/* SST/STATCOM quick-pick */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>SST / STATCOM Quick-Pick</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SST_PARAMS.map(p => (
                  <button key={p.code}
                    onClick={() => setMeasForm(f => ({ ...f, parameter_code: p.code, parameter_name: p.name, unit: p.unit }))}
                    style={{
                      padding: '3px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                      background: measForm.parameter_code === p.code ? '#eef2ff' : '#f9fafb',
                      border: `1px solid ${measForm.parameter_code === p.code ? '#6366f1' : '#e5e7eb'}`,
                      color: measForm.parameter_code === p.code ? '#6366f1' : '#374151',
                    }}>
                    {p.code}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { label: 'Parameter Code', key: 'parameter_code',  type: 'text'   },
                { label: 'Parameter Name *', key: 'parameter_name', type: 'text'  },
                { label: 'Measured Value', key: 'measured_value',   type: 'number' },
                { label: 'Unit',           key: 'unit',             type: 'text'   },
                { label: 'Min Limit',      key: 'min_limit',        type: 'number' },
                { label: 'Max Limit',      key: 'max_limit',        type: 'number' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>{f.label}</label>
                  <input type={f.type} step="any" value={measForm[f.key]} onChange={e => setMeasForm(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              ))}
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Target Value</label>
                <input type="number" step="any" value={measForm.target_value} onChange={e => setMeasForm(p => ({ ...p, target_value: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setMeasModal(false)} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleAddMeasurement} disabled={submitting || !measForm.parameter_name}
                style={{ padding: '8px 20px', background: submitting || !measForm.parameter_name ? '#c7d2fe' : '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                {submitting ? 'Adding…' : 'Add Measurement'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

