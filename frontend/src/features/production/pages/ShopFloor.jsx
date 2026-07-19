import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import { getShopFloor, startOperation, completeOperation, holdOperation } from '../services/productionService';

const PRIORITY_COLOR = {
  critical: ['#fee2e2', '#dc2626'],
  high:     ['#fef3c7', '#d97706'],
  medium:   ['#dbeafe', '#2563eb'],
  low:      ['#f3f4f6', '#6b7280'],
};

const STATUS_COLOR = {
  pending:     ['#fef9c3', '#854d0e'],
  ready:       ['#dbeafe', '#1e40af'],
  in_progress: ['#dcfce7', '#166534'],
  on_hold:     ['#fef3c7', '#92400e'],
  completed:   ['#f3f4f6', '#374151'],
  skipped:     ['#f3f4f6', '#9ca3af'],
};

function Badge({ label, colors }) {
  const [bg, col] = colors || ['#f3f4f6', '#374151'];
  return (
    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: bg, color: col }}>
      {label}
    </span>
  );
}

export default function ShopFloor({ setPage }) {
  const toast = useToast();
  const [ops,        setOps]        = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [wcFilter,   setWcFilter]   = useState('');
  const [modal,      setModal]      = useState(null); // { type: 'start'|'complete'|'hold', op }
  const [form,       setForm]       = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [view,       setView]       = useState('list'); // 'list' | 'board'

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getShopFloor({});
      setOps(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load shop floor data');
      setOps([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const workCentres = [...new Set(ops.map(o => o.work_centre_name).filter(Boolean))].sort();
  const filteredOps = wcFilter ? ops.filter(o => o.work_centre_name === wcFilter) : ops;

  const handleAction = async () => {
    if (!modal) return;
    setSubmitting(true);
    try {
      const { type, op } = modal;
      if (type === 'start')    await startOperation(op.id, form);
      if (type === 'complete') await completeOperation(op.id, form);
      if (type === 'hold')     await holdOperation(op.id, form);
      setModal(null);
      setForm({});
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Operation failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const actionLabel = modal?.type === 'complete' ? 'Complete Operation'
                    : modal?.type === 'hold'     ? 'Hold Operation'
                    : 'Start Operation';

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>🏭</div>
        Loading shop floor…
      </div>
    );
  }

  // Board view: group by work centre
  const byWC = {};
  filteredOps.forEach(op => {
    const k = op.work_centre_name || 'Unassigned';
    if (!byWC[k]) byWC[k] = [];
    byWC[k].push(op);
  });

  return (
    <div style={{ padding: 24, background: '#f8f7ff', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#1f2937' }}>Shop Floor</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            {filteredOps.length} pending operations · {filteredOps.filter(o => o.status === 'in_progress').length} in progress
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* View toggle */}
          <div style={{ display: 'flex', border: '1px solid #e9e4ff', borderRadius: 8, overflow: 'hidden' }}>
            {['list', 'board'].map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{ padding: '7px 16px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  background: view === v ? '#6B3FDB' : '#fff',
                  color:      view === v ? '#fff'    : '#6B3FDB' }}>
                {v === 'list' ? '≡ List' : '⊞ Board'}
              </button>
            ))}
          </div>
          {/* WC filter */}
          <select value={wcFilter} onChange={e => setWcFilter(e.target.value)}
            style={{ padding: '7px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, background: '#fff', color: '#374151' }}>
            <option value="">All Work Centres</option>
            {workCentres.map(wc => <option key={wc} value={wc}>{wc}</option>)}
          </select>
          <button onClick={load} style={{ padding: '7px 14px', border: '1px solid #e9e4ff', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#6B3FDB', fontWeight: 600 }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {filteredOps.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>No pending operations</div>
          <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>All work is complete or no orders have been released.</div>
          <button onClick={() => setPage('ProductionOrders')}
            style={{ marginTop: 16, padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Go to Production Orders →
          </button>
        </div>
      ) : view === 'list' ? (
        /* ── LIST VIEW ── */
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f5f3ff' }}>
                {['Priority', 'Order', 'Product', 'Step', 'Operation', 'Work Centre', 'Std Hrs', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#4c1d95', fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredOps.map(op => (
                <tr key={op.id} style={{ borderTop: '1px solid #f0ebff' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <Badge label={op.priority || 'normal'} colors={PRIORITY_COLOR[op.priority] || PRIORITY_COLOR.low} />
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6B3FDB', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {op.production_order_no}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#1f2937', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {op.product_name}
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 700, color: '#374151', textAlign: 'center' }}>
                    {op.step_no}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#1f2937' }}>{op.operation}</td>
                  <td style={{ padding: '10px 14px', color: '#6b7280' }}>{op.work_centre_name || '—'}</td>
                  <td style={{ padding: '10px 14px', color: '#374151' }}>{op.std_time_hrs ? `${op.std_time_hrs}h` : '—'}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <Badge label={op.status?.replace('_', ' ')} colors={STATUS_COLOR[op.status] || STATUS_COLOR.pending} />
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <ActionButtons op={op} setModal={setModal} setForm={setForm} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* ── BOARD VIEW ── */
        <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8 }}>
          {Object.entries(byWC).map(([wc, wcOps]) => (
            <div key={wc} style={{ minWidth: 300, background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', overflow: 'hidden', flexShrink: 0 }}>
              <div style={{ padding: '12px 16px', background: '#f5f3ff', borderBottom: '1px solid #e9e4ff' }}>
                <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14 }}>{wc}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{wcOps.length} operations</div>
              </div>
              <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                {wcOps.map(op => (
                  <div key={op.id} style={{ padding: '12px 16px', borderBottom: '1px solid #f0ebff' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#6B3FDB' }}>{op.production_order_no}</span>
                      <Badge label={op.priority || 'normal'} colors={PRIORITY_COLOR[op.priority] || PRIORITY_COLOR.low} />
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', marginBottom: 3 }}>
                      Step {op.step_no}: {op.operation}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                      {op.product_name}
                      {op.std_time_hrs ? ` · ${op.std_time_hrs}h` : ''}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Badge label={op.status?.replace('_', ' ')} colors={STATUS_COLOR[op.status] || STATUS_COLOR.pending} />
                      <ActionButtons op={op} setModal={setModal} setForm={setForm} small />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action Modal */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setModal(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 400, boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: '#1f2937' }}>{actionLabel}</h3>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#6b7280' }}>
              {modal.op.production_order_no} · Step {modal.op.step_no}: {modal.op.operation}
            </p>

            {modal.type === 'start' && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quantity In</label>
                <input type="number" value={form.quantity_in || ''} onChange={e => setForm(f => ({ ...f, quantity_in: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            )}
            {modal.type === 'complete' && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quantity Out</label>
                  <input type="number" value={form.quantity_out || ''} onChange={e => setForm(f => ({ ...f, quantity_out: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quantity Scrap</label>
                  <input type="number" value={form.quantity_scrap || ''} onChange={e => setForm(f => ({ ...f, quantity_scrap: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              </>
            )}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Remarks</label>
              <textarea rows={2} value={form.remarks || ''} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, resize: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={handleAction} disabled={submitting}
                style={{ padding: '8px 20px', background: submitting ? '#c4b5fd' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                {submitting ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionButtons({ op, setModal, setForm, small }) {
  const px = small ? '3px 8px' : '4px 12px';
  const fs  = small ? 11       : 12;

  if (op.status === 'completed' || op.status === 'skipped') {
    return <span style={{ fontSize: 11, color: '#9ca3af' }}>Done</span>;
  }

  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {(op.status === 'ready' || op.status === 'pending') && (
        <button onClick={() => { setModal({ type: 'start', op }); setForm({}); }}
          style={{ padding: px, background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: fs, fontWeight: 700 }}>
          Start
        </button>
      )}
      {op.status === 'on_hold' && (
        <button onClick={() => { setModal({ type: 'start', op }); setForm({}); }}
          style={{ padding: px, background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: fs, fontWeight: 700 }}>
          Resume
        </button>
      )}
      {op.status === 'in_progress' && (
        <>
          <button onClick={() => { setModal({ type: 'complete', op }); setForm({}); }}
            style={{ padding: px, background: '#dcfce7', color: '#166534', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: fs, fontWeight: 700 }}>
            Done
          </button>
          <button onClick={() => { setModal({ type: 'hold', op }); setForm({}); }}
            style={{ padding: px, background: '#fef3c7', color: '#92400e', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: fs, fontWeight: 700 }}>
            Hold
          </button>
        </>
      )}
    </div>
  );
}
