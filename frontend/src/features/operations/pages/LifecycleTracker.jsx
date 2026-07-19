import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, ChevronRight, RefreshCw, PauseCircle, PlayCircle, CheckCircle, AlertCircle } from 'lucide-react';

const STAGES = ['order', 'design', 'procurement', 'production', 'testing', 'dispatch', 'installation', 'commissioning', 'sat', 'service', 'amc'];
const STAGE_LABELS = {
  order: 'Order', design: 'Design', procurement: 'Procurement',
  production: 'Production', testing: 'Testing / FAT', dispatch: 'Dispatch',
  installation: 'Installation', commissioning: 'Commissioning', sat: 'SAT',
  service: 'Service', amc: 'AMC',
};
const STATUS_COLOR = {
  active:    { bg: '#d1fae5', color: '#065f46' },
  completed: { bg: '#dbeafe', color: '#1e40af' },
  on_hold:   { bg: '#fef3c7', color: '#92400e' },
  cancelled: { bg: '#fee2e2', color: '#991b1b' },
};

function GateBadge({ ok, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: ok ? '#065f46' : '#9ca3af' }}>
      {ok ? <CheckCircle size={12} color="#10b981" /> : <AlertCircle size={12} color="#d1d5db" />}
      {label}
    </div>
  );
}

function StagePipeline({ current, status }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
      {STAGES.map((s, i) => {
        const idx = STAGES.indexOf(current);
        const done = i < idx;
        const active = s === current;
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{
              padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
              background: active ? '#6B3FDB' : done ? '#d1fae5' : '#f3f4f6',
              color: active ? '#fff' : done ? '#065f46' : '#9ca3af',
              border: active ? '2px solid #6B3FDB' : '2px solid transparent',
              whiteSpace: 'nowrap',
            }}>
              {STAGE_LABELS[s]}
            </div>
            {i < STAGES.length - 1 && <ChevronRight size={12} color={done ? '#10b981' : '#d1d5db'} />}
          </div>
        );
      })}
    </div>
  );
}

export default function LifecycleTracker() {
  const [instances, setInstances] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail]     = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [remarks, setRemarks]   = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ sales_order_id: '', stage_notes: '' });
  const [creating, setCreating] = useState(false);
  const [stageFilter, setStageFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = () => {
    setLoading(true);
    const params = {};
    if (stageFilter !== 'All') params.current_stage = stageFilter;
    if (statusFilter !== 'All') params.status = statusFilter;
    api.get('/lifecycle/instances', { params })
      .then(r => { if (isMounted.current) setInstances(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setInstances([]); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };

  useEffect(() => { load(); }, [stageFilter, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = (id) => {
    setSelected(id); setDetailLoading(true); setDetail(null);
    api.get(`/lifecycle/instances/${id}`)
      .then(r => { if (isMounted.current) setDetail(r.data); })
      .catch(() => { if (isMounted.current) toast.error('Failed to load lifecycle details'); })
      .finally(() => { if (isMounted.current) setDetailLoading(false); });
  };

  const advance = async () => {
    if (!detail) return;
    setAdvancing(true);
    try {
      const r = await api.post(`/lifecycle/instances/${detail.id}/advance`, { remarks });
      toast.success(`Advanced to ${STAGE_LABELS[r.data.current_stage]}`);
      setRemarks('');
      loadDetail(detail.id);
      load();
    } catch (e) {
      const msg = e.response?.data?.error || 'Cannot advance stage';
      const gates = e.response?.data?.gates;
      toast.error(msg + (gates ? ' — check gate requirements' : ''));
      if (gates && isMounted.current) setDetail(d => d ? { ...d, gates } : d);
    } finally { if (isMounted.current) setAdvancing(false); }
  };

  const holdResume = async (action) => {
    if (!detail) return;
    try {
      await api.post(`/lifecycle/instances/${detail.id}/${action}`, { remarks });
      toast.success(action === 'hold' ? 'Put on hold' : 'Resumed');
      setRemarks('');
      loadDetail(detail.id);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Action failed');
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.post('/lifecycle/instances', {
        sales_order_id: createForm.sales_order_id ? Number(createForm.sales_order_id) : null,
        stage_notes: createForm.stage_notes || 'Lifecycle created manually',
      });
      toast.success('Lifecycle instance created');
      setShowCreate(false);
      setCreateForm({ sales_order_id: '', stage_notes: '' });
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Create failed');
    } finally { if (isMounted.current) setCreating(false); }
  };

  const gateLabels = {
    engineering_ready:   'Engineering Ready',
    bom_materials_received: 'BOM Materials Received',
    production_ready:    'Production Ready',
    fat_passed:          'FAT Passed',
    dispatch_recorded:   'Dispatch Recorded',
    commissioning_done:  'Commissioning Done',
    sat_completed:       'SAT Completed',
    amc_created:         'AMC Created',
  };

  const nextStageName = detail ? STAGE_LABELS[STAGES[STAGES.indexOf(detail.current_stage) + 1]] : null;
  const isCompleted = detail?.status === 'completed';
  const isOnHold = detail?.status === 'on_hold';

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', background: '#f9fafb', overflow: 'hidden' }}>
      {/* Left panel */}
      <div style={{ width: 380, borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #f0f0f4' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Lifecycle Tracker</h1>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>{instances.length} instances</p>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={load} style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7, background: '#fff', cursor: 'pointer', color: '#6b7280' }}>
                <RefreshCw size={14} />
              </button>
              <button onClick={() => setShowCreate(true)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                <Plus size={13} /> New
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={stageFilter} onChange={e => setStageFilter(e.target.value)}
              style={{ flex: 1, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, outline: 'none' }}>
              <option value="All">All Stages</option>
              {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
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
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading...</div>
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
                  {STAGE_LABELS[inst?.current_stage ?? 'order'] ?? (inst?.current_stage ?? 'unknown')}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                  {detail.lifecycle_number || `LC-${detail.id}`}
                </h2>
                {detail.order_number && <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Sales Order: {detail.order_number}</p>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!isCompleted && !isOnHold && (
                  <button onClick={() => holdResume('hold')} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#92400e' }}>
                    <PauseCircle size={13} /> Hold
                  </button>
                )}
                {isOnHold && (
                  <button onClick={() => holdResume('resume')} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', border: '1px solid #10b981', borderRadius: 8, background: '#d1fae5', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#065f46' }}>
                    <PlayCircle size={13} /> Resume
                  </button>
                )}
              </div>
            </div>

            {/* Stage Pipeline */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, marginBottom: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 14px' }}>Stage Pipeline</h3>
              <StagePipeline current={detail.current_stage} status={detail.status} />
            </div>

            {/* Gates */}
            {detail.gates && (
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 12px' }}>Gate Status</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  {Object.entries(detail.gates).map(([k, v]) => (
                    <GateBadge key={k} ok={v} label={gateLabels[k] || k} />
                  ))}
                </div>
              </div>
            )}

            {/* Advance Stage */}
            {!isCompleted && !isOnHold && nextStageName && (
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 12px' }}>Advance to Next Stage</h3>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
                  Ready to advance from <strong>{STAGE_LABELS[detail.current_stage]}</strong> → <strong>{nextStageName}</strong>?
                </p>
                <input value={remarks} onChange={e => setRemarks(e.target.value)}
                  placeholder="Remarks (optional)"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', marginBottom: 10, boxSizing: 'border-box' }} />
                <button onClick={advance} disabled={advancing}
                  style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: advancing ? 0.6 : 1 }}>
                  {advancing ? 'Advancing...' : `Advance to ${nextStageName}`}
                </button>
              </div>
            )}
            {isCompleted && (
              <div style={{ background: '#d1fae5', borderRadius: 12, padding: 16, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
                <CheckCircle size={18} color="#059669" />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#065f46' }}>Lifecycle completed — all stages done</span>
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
                          {h.action === 'advance' ? `${STAGE_LABELS[h.from_stage] || h.from_stage || '—'} → ${STAGE_LABELS[h.to_stage] || h.to_stage}` : h.action}
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

      {/* Create Modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>New Lifecycle Instance</h2>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Sales Order ID (optional)</label>
                <input value={createForm.sales_order_id} onChange={e => setCreateForm(p => ({ ...p, sales_order_id: e.target.value }))}
                  placeholder="e.g. 42"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Stage Notes</label>
                <input value={createForm.stage_notes} onChange={e => setCreateForm(p => ({ ...p, stage_notes: e.target.value }))}
                  placeholder="Initial notes..."
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
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
    </div>
  );
}
