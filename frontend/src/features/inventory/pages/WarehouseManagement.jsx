// frontend/src/features/inventory/pages/WarehouseManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import QualityTestsPanel from '@/features/quality/components/QualityTestsPanel';


/* ── TAB 1: Bin Locations ── */
function BinsTab() {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [bins, setBins]         = useState([]);
  const [selected, setSelBin]   = useState(null);
  const [showAssign, setAssign] = useState(false);
  const [assForm, setAssForm]   = useState({ item_name: '', qty: '', unit: 'pcs' });
  const [rows, setRows]         = useState([]);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/warehouse/bins');
      if (Array.isArray(res.data) && res.data.length) {
        setBins(res.data);
        const uniqueRows = [...new Set(res.data.map(b => b.row_no))].sort();
        setRows(uniqueRows.length ? uniqueRows : ['R1', 'R2', 'R3']);
      } else {
        setRows(['R1', 'R2', 'R3']);
      }
    } catch {
      setRows(['R1', 'R2', 'R3']);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const allRows = rows.length ? rows : ['R1', 'R2', 'R3'];
  const shelves = ['S1', 'S2', 'S3', 'S4'];

  const getBin = (row, shelf) => bins.find(b => b.row_no === row && b.shelf === shelf);

  const occupancyStyle = (occ) => {
    if (occ === 'full')    return { background: '#6B3FDB', color: '#fff' };
    if (occ === 'partial') return { background: '#dbeafe', color: '#1e40af' };
    return { background: '#f3f4f6', color: '#9ca3af' };
  };

  const assign = async () => {
    if (!selected || !assForm.item_name || !assForm.qty) return;
    try {
      await api.post('/warehouse/bins/assign', { bin_id: selected.id, ...assForm });
      setAssign(false);
      setAssForm({ item_name: '', qty: '', unit: 'pcs' });
      const refreshed = await api.get('/warehouse/bins');
      if (Array.isArray(refreshed.data)) {
        setBins(refreshed.data);
        setSelBin(refreshed.data.find(b => b.id === selected.id) || null);
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to assign item to bin');
    }
  };

  const clearBin = async () => {
    if (!selected) return;
    setClearing(true);
    try {
      const res = await api.put(`/warehouse/bins/${selected.id}/clear`);
      const cleared = res.data;
      setBins(prev => prev.map(b => b.id === cleared.id ? cleared : b));
      setSelBin(cleared);
      toast.success('Bin cleared');
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to clear bin');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 20 }}>
      {/* Grid */}
      <div style={{ flex: 1 }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ padding: '6px 10px', color: '#9ca3af', fontSize: 11 }}>Row</th>
                {shelves.map(s => (
                  <th key={s} style={{ padding: '6px 16px', color: '#4c1d95', fontWeight: 700, fontSize: 12 }}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allRows.map(row => (
                <tr key={row}>
                  <td style={{ padding: '6px 10px', fontWeight: 700, color: '#4c1d95', fontSize: 12 }}>{row}</td>
                  {shelves.map(shelf => {
                    const bin = getBin(row, shelf);
                    const occ = bin?.occupancy || 'empty';
                    const style = occupancyStyle(occ);
                    const items = Array.isArray(bin?.current_items) ? bin.current_items : [];
                    const firstItem = items[0];
                    return (
                      <td key={shelf} style={{ padding: 4 }}>
                        <div
                          onClick={() => bin && setSelBin(bin)}
                          style={{
                            width: 80, height: 54, borderRadius: 6,
                            cursor: bin ? 'pointer' : 'default',
                            display: 'flex', flexDirection: 'column',
                            alignItems: 'center', justifyContent: 'center',
                            border: '1px solid #e9e4ff', ...style,
                            outline: selected?.id === bin?.id ? '2px solid #6B3FDB' : 'none',
                            padding: '2px 4px', textAlign: 'center',
                          }}
                        >
                          {bin ? (
                            occ !== 'empty' && firstItem ? (
                              <>
                                <div style={{ fontSize: 9, fontWeight: 700, lineHeight: 1.2, overflow: 'hidden', maxWidth: 72, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                                  {firstItem.item}
                                </div>
                                <div style={{ fontSize: 9, marginTop: 1 }}>
                                  {firstItem.qty} {firstItem.unit}
                                </div>
                              </>
                            ) : (
                              <>
                                <div style={{ fontSize: 9, fontWeight: 700 }}>{bin.bin_code?.split('-').slice(0, 2).join('-')}</div>
                                <div style={{ fontSize: 9 }}>Empty</div>
                              </>
                            )
                          ) : (
                            <div style={{ fontSize: 9 }}>—</div>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          {[['full', '#6B3FDB', 'Full'], ['partial', '#dbeafe', 'Partial'], ['empty', '#f3f4f6', 'Empty']].map(([occ, bg, label]) => (
            <div key={occ} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 16, height: 16, borderRadius: 4, background: bg, border: '1px solid #e9e4ff' }} />
              <span style={{ fontSize: 11, color: '#6b7280' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      <div style={{ width: 270, flexShrink: 0 }}>
        {selected ? (
          <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 16 }}>
            <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14, marginBottom: 2 }}>{selected.bin_code}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>{selected.zone_name}</div>

            {/* Items in bin */}
            {(Array.isArray(selected.current_items) ? selected.current_items : []).length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: '12px 0', marginBottom: 10 }}>
                Empty bin
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {(selected.current_items || []).map((item, i) => (
                  <div key={i} style={{ padding: '7px 10px', background: '#f5f3ff', borderRadius: 7 }}>
                    <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 12 }}>{item.item}</div>
                    <div style={{ fontSize: 11, color: '#6B3FDB', fontWeight: 700 }}>{item.qty} {item.unit}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {!readOnly && <button
                onClick={() => setAssign(v => !v)}
                style={{ width: '100%', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                Assign Item
              </button>}
              {!readOnly && (Array.isArray(selected.current_items) ? selected.current_items : []).length > 0 && (
                <button
                  onClick={clearBin}
                  disabled={clearing}
                  style={{ width: '100%', background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 8, padding: '7px', cursor: clearing ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13 }}
                >
                  {clearing ? 'Clearing…' : 'Clear Bin'}
                </button>
              )}
            </div>

            {showAssign && (
              <div style={{ marginTop: 10 }}>
                <input
                  value={assForm.item_name}
                  onChange={e => setAssForm(f => ({ ...f, item_name: e.target.value }))}
                  placeholder="Item name"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12, marginBottom: 6 }}
                />
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <input
                    type="number" value={assForm.qty}
                    onChange={e => setAssForm(f => ({ ...f, qty: e.target.value }))}
                    placeholder="Qty"
                    style={{ flex: 1, padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12 }}
                  />
                  <select
                    value={assForm.unit}
                    onChange={e => setAssForm(f => ({ ...f, unit: e.target.value }))}
                    style={{ padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12 }}
                  >
                    {['pcs', 'mtrs', 'kg', 'ltrs'].map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={assign} style={{ flex: 1, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '6px', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>Save</button>
                  <button onClick={() => setAssign(false)} style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 30, textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>📦</div>
            <p style={{ fontSize: 12 }}>Click a bin to view contents</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── TAB 2: Pick-Pack-Ship ── */
function PickPackTab() {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [pickLists, setPL]   = useState([]);
  const [selected, setSel]   = useState(null);
  const [picking, setPicking] = useState({});
  const [shipStep, setShip]  = useState(false);
  const [shipForm, setShipForm] = useState({ courier: '', tracking_number: '', carton_count: 1, weight_kg: '' });
  const [saving, setSaving]  = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/warehouse/pick-lists');
      if (Array.isArray(res.data)) setPL(res.data);
    } catch { setPL([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const savePick = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const lines = selected.lines.map(l => ({
        line_id: l.id,
        picked_qty: parseFloat(picking[l.id] ?? l.picked_qty ?? 0),
        item_name: l.item_name,
        bin_location_id: l.bin_location_id,
        item_id: l.item_id,
      }));
      await api.put(`/warehouse/pick-lists/${selected.id}/pick`, { lines });
      toast.success('Pick quantities saved');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to save pick quantities');
    } finally {
      setSaving(false);
    }
  };

  const markPacked = async () => {
    if (!selected) return;
    try {
      await api.patch(`/warehouse/pick-lists/${selected.id}/status`, { status: 'packed' });
      toast.success('Marked as packed');
      setSel(prev => prev ? { ...prev, status: 'packed' } : null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to mark as packed');
    }
  };

  const dispatch = async () => {
    if (!selected) return;
    try {
      await api.post('/warehouse/dispatch', { pick_list_id: selected.id, ...shipForm });
      toast.success('Dispatched successfully');
      setShip(false);
      setSel(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Dispatch failed');
    }
  };

  const statusBadge = (s) => {
    const map = {
      'in-progress': ['#dbeafe', '#2563eb'],
      completed:     ['#d1fae5', '#16a34a'],
      packed:        ['#f5f3ff', '#6B3FDB'],
      dispatched:    ['#f0fdf4', '#15803d'],
    };
    const [bg, color] = map[s] || ['#f3f4f6', '#6b7280'];
    return (
      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 8, background: bg, color }}>
        {s}
      </span>
    );
  };

  const lineStatusColor = (s) => s === 'completed' ? ['#d1fae5', '#16a34a'] : s === 'partial' ? ['#fef3c7', '#d97706'] : ['#f3f4f6', '#6b7280'];

  return (
    <div>
      <div style={{ display: 'flex', gap: 16 }}>
        {/* Pick list sidebar */}
        <div style={{ width: 280, flexShrink: 0 }}>
          {pickLists.length === 0 && (
            <div style={{ color: '#9ca3af', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
              No pick lists found.
            </div>
          )}
          {pickLists.map(pl => (
            <div
              key={pl.id}
              onClick={() => { setSel(pl); setPicking({}); setShip(false); }}
              style={{
                padding: '12px 14px', border: `1px solid ${selected?.id === pl.id ? '#a78bfa' : '#e9e4ff'}`,
                borderRadius: 10, marginBottom: 8, cursor: 'pointer',
                background: selected?.id === pl.id ? '#faf5ff' : '#fff',
              }}
            >
              <div style={{ fontWeight: 700, color: '#6B3FDB', fontSize: 13 }}>{pl.sales_order_ref}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{pl.total_lines} lines · {pl.completed_lines} picked</div>
              <div style={{ marginTop: 4 }}>{statusBadge(pl.status)}</div>
            </div>
          ))}
        </div>

        {/* Detail */}
        {selected && (
          <div style={{ flex: 1, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #e9e4ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <span style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14 }}>{selected.sales_order_ref}</span>
                <span style={{ marginLeft: 10 }}>{statusBadge(selected.status)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!readOnly && <>
                {!['completed', 'packed', 'dispatched'].includes(selected.status) && (
                  <button onClick={savePick} disabled={saving}
                    style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 12 }}>
                    {saving ? 'Saving…' : 'Save Pick'}
                  </button>
                )}
                {selected.status === 'completed' && (
                  <button onClick={markPacked}
                    style={{ background: '#6d28d9', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                    📦 Mark Packed
                  </button>
                )}
                {['packed', 'completed'].includes(selected.status) && (
                  <button onClick={() => setShip(v => !v)}
                    style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                    🚚 Mark Shipped
                  </button>
                )}
                </>}
              </div>
            </div>

            {/* Lines table */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Item', 'Bin', 'Required', 'Picked', 'Status'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(selected.lines || []).map(l => {
                  const [bg, color] = lineStatusColor(l.status);
                  return (
                    <tr key={l.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 600 }}>{l.item_name}</td>
                      <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{l.bin_code}</td>
                      <td style={{ padding: '9px 12px' }}>{l.required_qty}</td>
                      <td style={{ padding: '9px 12px' }}>
                        <input
                          type="number" min={0} max={l.required_qty}
                          defaultValue={l.picked_qty ?? 0}
                          onChange={e => setPicking(p => ({ ...p, [l.id]: e.target.value }))}
                          style={{ width: 60, padding: '4px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13 }}
                        />
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 700, background: bg, color }}>{l.status || 'pending'}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Ship form */}
            {shipStep && (
              <div style={{ padding: 16, borderTop: '1px solid #e9e4ff', background: '#f5f3ff' }}>
                <div style={{ fontWeight: 700, color: '#4c1d95', marginBottom: 10, fontSize: 13 }}>🚚 Dispatch Details</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8 }}>
                  {[
                    { label: 'Courier Partner',   key: 'courier',          placeholder: 'Delhivery, BlueDart…' },
                    { label: 'Tracking Number',   key: 'tracking_number',  placeholder: 'AWB Number' },
                    { label: 'No. of Cartons',    key: 'carton_count',     placeholder: '1',  type: 'number' },
                    { label: 'Total Weight (kg)', key: 'weight_kg',        placeholder: '10', type: 'number' },
                  ].map(f => (
                    <div key={f.key}>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>{f.label}</label>
                      <input
                        type={f.type || 'text'} value={shipForm[f.key]}
                        onChange={e => setShipForm(s => ({ ...s, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13 }}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={dispatch}
                    style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 20px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                    Confirm Dispatch
                  </button>
                  <button onClick={() => setShip(false)}
                    style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 14px', cursor: 'pointer', fontSize: 13 }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── TAB 3: Inward QC ── */
function InwardQCTab() {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [grs, setGRs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [inspecting, setInsp] = useState(null);
  const [qtGrn, setQtGrn]   = useState(null);   // GRN id whose quality-tests panel is open
  const [sending, setSending] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/warehouse/inward-qc');
      setGRs(Array.isArray(res.data) ? res.data : []);
    } catch {
      setGRs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const doInspect = async (gr, outcome) => {
    const newStatus = outcome === 'pass' ? 'stored' : 'quarantine';
    try {
      await Promise.all([
        api.post('/warehouse/inward', {
          gr_number: gr.gr_number,
          supplier: gr.supplier,
          items: Array.isArray(gr.items) ? gr.items : [],
          inspection_required: false,
        }),
        api.patch(`/warehouse/inward-qc/${gr.id}`, { status: newStatus }),
      ]);
      setGRs(prev => prev.filter(g => g.id !== gr.id));
      toast.success(outcome === 'pass' ? 'Items moved to storage' : 'Items moved to quarantine');
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Inspection update failed');
    }
    setInsp(null);
  };

  const sendToQuality = async (gr) => {
    setSending(gr.id);
    try {
      const r = await api.post(`/warehouse/inward-qc/${gr.id}/send-to-quality`, {});
      toast.success(`Sent to Quality — ${r.data?.tests_created ?? 0} test(s) created`);
      setQtGrn(gr.id);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not send to Quality');
    } finally { setSending(null); }
  };

  if (loading) {
    return <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading GRNs…</div>;
  }

  if (grs.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
        <div style={{ fontSize: 13 }}>No GRNs pending quality inspection.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {grs.map(gr => (
        <div key={gr.id} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700, color: '#6B3FDB', fontSize: 13 }}>{gr.grn_number}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {gr.supplier} · {gr.date ? new Date(gr.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
              </div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, background: '#fef3c7', color: '#d97706' }}>
              Pending QC
            </span>
          </div>

          {/* Items */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {(Array.isArray(gr.items) ? gr.items : []).map((item, i) => (
              <span key={i} style={{ fontSize: 11, background: '#f5f3ff', color: '#6b7280', padding: '2px 9px', borderRadius: 8 }}>
                {item.name} × {item.qty} {item.unit}
              </span>
            ))}
          </div>

          {inspecting === gr.id ? (
            <div style={{ background: '#f5f3ff', borderRadius: 8, padding: 12 }}>
              <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 10px' }}>Inspection result for {gr.grn_number}:</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => doInspect(gr, 'pass')}
                  style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                  ✓ Pass — Move to Storage
                </button>
                <button onClick={() => doInspect(gr, 'fail')}
                  style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                  ✗ Fail — Quarantine
                </button>
                <button onClick={() => setInsp(null)}
                  style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : readOnly ? null : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setInsp(gr.id)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                🔍 Start Inspection
              </button>
              <button onClick={() => sendToQuality(gr)} disabled={sending === gr.id}
                style={{ background: '#ede9fe', color: '#6B3FDB', border: '1px solid #ddd6fe', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                {sending === gr.id ? 'Sending…' : '🧪 Send to Quality'}
              </button>
              <button onClick={() => setQtGrn(qtGrn === gr.id ? null : gr.id)}
                style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                {qtGrn === gr.id ? 'Hide tests' : 'Manage tests'}
              </button>
            </div>
          )}

          {qtGrn === gr.id && (
            <div style={{ marginTop: 12, borderTop: '1px solid #eef0f4', paddingTop: 12 }}>
              <QualityTestsPanel
                source={{ grnId: gr.id, itemName: (Array.isArray(gr.items) && gr.items[0]?.name) || null }}
                title={`Quality tests — ${gr.grn_number}`}
                defaultStage="IQC"
                readOnly={readOnly}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── TAB 4: Cycle Count ── */
function CycleCountTab() {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [counts, setCounts]     = useState([]);
  const [zones, setZones]       = useState([]);
  const [selected, setSelected] = useState(null);
  const [lines, setLines]       = useState([]);
  const [linesLoading, setLL]   = useState(false);
  const [counted, setCounted]   = useState({});
  const [showSchedule, setSched] = useState(false);
  const [form, setForm]         = useState({ zone_id: '', scheduled_date: '', counted_by: '' });
  const [submitting, setSubmit] = useState(false);

  const loadCounts = useCallback(async () => {
    try {
      const res = await api.get('/warehouse/cycle-count');
      if (Array.isArray(res.data)) setCounts(res.data);
    } catch { setCounts([]); }
  }, []);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  useEffect(() => {
    api.get('/warehouse/zones')
      .then(r => setZones(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, []);

  // Load real lines when a count is selected
  useEffect(() => {
    if (!selected) { setLines([]); setCounted({}); return; }
    setLL(true);
    setCounted({});
    api.get(`/warehouse/cycle-count/${selected.id}/lines`)
      .then(r => setLines(Array.isArray(r.data) ? r.data : []))
      .catch(() => setLines([]))
      .finally(() => setLL(false));
  }, [selected]);

  const scheduleCount = async () => {
    if (!form.zone_id) { toast.error('Please select a zone'); return; }
    try {
      const res = await api.post('/warehouse/cycle-count', {
        zone_id: form.zone_id,
        scheduled_date: form.scheduled_date || new Date().toISOString().split('T')[0],
        counted_by: form.counted_by,
      });
      const zoneName = zones.find(z => z.id === form.zone_id)?.name || 'Zone';
      setCounts(p => [{
        id: res.data.id,
        zone_name: zoneName,
        scheduled_date: form.scheduled_date,
        counted_by: form.counted_by,
        status: 'scheduled',
        total_lines: 0,
        counted_lines: 0,
      }, ...p]);
      setSched(false);
      setForm({ zone_id: '', scheduled_date: '', counted_by: '' });
      toast.success('Cycle count scheduled');
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to schedule cycle count');
    }
  };

  const submitCount = async () => {
    setSubmit(true);
    try {
      const payload = lines.map(l => ({
        line_id: l.id,
        counted_qty: parseFloat(counted[l.id] ?? l.system_qty ?? 0),
        system_qty: l.system_qty,
      }));
      await api.post(`/warehouse/cycle-count/${selected.id}/submit`, { lines: payload });
      setCounts(prev => prev.map(c => c.id === selected.id ? { ...c, status: 'completed', counted_lines: lines.length } : c));
      setSelected(null);
      toast.success('Cycle count submitted and stock adjusted');
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to submit cycle count');
    } finally {
      setSubmit(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        {!readOnly && (
          <button onClick={() => setSched(true)}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            + Schedule Count
          </button>
        )}
      </div>

      {/* Schedule form */}
      {showSchedule && (
        <div style={{ background: '#faf5ff', border: '1px solid #a78bfa', borderRadius: 10, padding: 16, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginBottom: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Zone</label>
              <select
                value={form.zone_id}
                onChange={e => setForm(f => ({ ...f, zone_id: e.target.value }))}
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, background: '#fff' }}
              >
                <option value="">Select zone…</option>
                {zones.map(z => <option key={z.id} value={z.id}>{z.name} ({z.warehouse_name})</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Scheduled Date</label>
              <input
                type="date" value={form.scheduled_date}
                onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Counted By</label>
              <input
                value={form.counted_by}
                onChange={e => setForm(f => ({ ...f, counted_by: e.target.value }))}
                placeholder="Technician name"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={scheduleCount}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
              Schedule
            </button>
            <button onClick={() => setSched(false)}
              style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Active count detail */}
      {selected ? (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h4 style={{ margin: 0, color: '#4c1d95' }}>Counting: {selected.zone_name}</h4>
            <div style={{ display: 'flex', gap: 8 }}>
              {!readOnly && (
                <button onClick={submitCount} disabled={submitting}
                  style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}>
                  {submitting ? 'Submitting…' : 'Submit Count'}
                </button>
              )}
              <button onClick={() => setSelected(null)}
                style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>
                Back
              </button>
            </div>
          </div>

          {linesLoading && <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Loading items…</div>}

          {!linesLoading && lines.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No items found for this zone.
            </div>
          )}

          {!linesLoading && lines.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Item', 'Bin', 'System Qty', 'Counted Qty', 'Variance'].map(h => (
                    <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const cnt = parseFloat(counted[l.id] ?? '');
                  const variance = !isNaN(cnt) ? cnt - parseFloat(l.system_qty || 0) : null;
                  return (
                    <tr key={l.id} style={{ borderBottom: '1px solid #f0ebff', background: (variance !== null && variance !== 0) ? '#fff5f5' : '#fff' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 600 }}>{l.item_name}</td>
                      <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{l.bin_code}</td>
                      <td style={{ padding: '9px 12px' }}>{l.system_qty}</td>
                      <td style={{ padding: '9px 12px' }}>
                        <input
                          type="number" min={0} placeholder="Enter count"
                          value={counted[l.id] ?? ''}
                          onChange={e => setCounted(c => ({ ...c, [l.id]: e.target.value }))}
                          style={{ width: 80, padding: '5px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13 }}
                        />
                      </td>
                      <td style={{ padding: '9px 12px', fontWeight: 700, color: variance === 0 ? '#16a34a' : variance !== null ? '#dc2626' : '#9ca3af' }}>
                        {variance !== null ? (variance > 0 ? `+${variance}` : variance) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {counts.length === 0 && !showSchedule && (
            <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No cycle counts yet. Click + Schedule Count to begin.
            </div>
          )}
          {counts.map(cc => (
            <div key={cc.id} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: '#1f2937', fontSize: 13 }}>{cc.zone_name}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  Scheduled: {cc.scheduled_date ? new Date(cc.scheduled_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'} · By: {cc.counted_by || '—'}
                  {cc.status === 'completed' && ` · Variance: ${cc.total_variance || 0} units`}
                </div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10,
                background: cc.status === 'completed' ? '#d1fae5' : '#fef3c7',
                color:      cc.status === 'completed' ? '#16a34a' : '#d97706',
              }}>
                {cc.status}
              </span>
              {cc.status !== 'completed' && (
                <button onClick={() => setSelected(cc)}
                  style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                  Start Count
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── MAIN ── */
const TABS = ['Bin Locations', 'Pick-Pack-Ship', 'Inward QC', 'Cycle Count'];

export default function WarehouseManagement() {
  const { readOnly } = usePageAccess();
  const [tab, setTab] = useState('Bin Locations');

  const tabStyle = (t) => ({
    padding: '9px 18px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
    background:   tab === t ? '#6B3FDB' : 'transparent',
    color:        tab === t ? '#fff'    : '#6B3FDB',
    borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent',
  });

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', color: '#4c1d95', fontSize: 22 }}>🏬 Warehouse Management</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Bin locations, pick-pack-ship, inward QC, and cycle counting</p>
      </div>
      {readOnly && <ReadOnlyBanner />}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e9e4ff', background: '#fff', borderRadius: '10px 10px 0 0', padding: '0 8px', flexWrap: 'wrap' }}>
        {TABS.map(t => <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 0 10px 10px', padding: 20 }}>
        {tab === 'Bin Locations'  && <BinsTab />}
        {tab === 'Pick-Pack-Ship' && <PickPackTab />}
        {tab === 'Inward QC'      && <InwardQCTab />}
        {tab === 'Cycle Count'    && <CycleCountTab />}
      </div>
    </div>
  );
}
