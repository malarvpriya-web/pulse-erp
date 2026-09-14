// frontend/src/features/inventory/pages/WarehouseManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import { Package } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import QualityTestsPanel from '@/features/quality/components/QualityTestsPanel';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageLayout, PageHeader, ContentCard, PageHero, PageShell } from '@/components/pulse-ui';


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

  const lineStatusColor = (s) => s === 'completed' ? ['#d1fae5', '#16a34a'] : s === 'partial' ? ['#ede9fe', '#6d28d9'] : ['#f3f4f6', '#6b7280'];

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
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, background: '#ede9fe', color: '#6d28d9' }}>
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
                background: cc.status === 'completed' ? '#d1fae5' : '#ede9fe',
                color:      cc.status === 'completed' ? '#16a34a' : '#6d28d9',
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

/* ── TAB 0: Stores ──
   The warehouse master itself. Until this existed a store could only be created
   in the Inventory Setup Wizard and could never be renamed or retired, so ten
   pages read a list nothing could correct. */
const EMPTY_STORE = { warehouse_name: '', warehouse_code: '', warehouse_type: '', location: '', department: '', capacity: '' };

function StoresTab() {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [stores, setStores]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer]   = useState(null);   // null | { id? } — open form
  const [form, setForm]       = useState(EMPTY_STORE);
  const [saving, setSaving]   = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/inventory/warehouses');
      setStores(Array.isArray(res.data) ? res.data : (res.data?.warehouses ?? []));
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not load stores');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const openNew  = () => { setForm(EMPTY_STORE); setDrawer({}); };
  const openEdit = (s) => {
    setForm({
      warehouse_name: s.warehouse_name || s.name || '',
      warehouse_code: s.warehouse_code || '',
      warehouse_type: s.warehouse_type || '',
      location:       s.location || '',
      department:     s.department || '',
      capacity:       s.capacity ?? '',
    });
    setDrawer({ id: s.id });
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.warehouse_name.trim()) return toast.error('Store name is required');
    setSaving(true);
    try {
      if (drawer.id) await api.put(`/inventory/warehouses/${drawer.id}`, form);
      else           await api.post('/inventory/warehouses', form);
      toast.success(drawer.id ? 'Store updated' : 'Store created');
      setDrawer(null);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save the store');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    const id = pendingDelete;
    setPendingDelete(null);
    try {
      await api.delete(`/inventory/warehouses/${id}`);
      toast.success('Store retired');
      load();
    } catch (err) {
      // A 409 here means the store still holds stock — say so, don't just fail.
      toast.error(err?.response?.data?.error || 'Could not retire the store');
    }
  };

  const cell = { padding: '9px 12px', borderBottom: '1px solid #f0f0f4', fontSize: 13 };
  const input = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          {loading ? 'Loading…' : `${stores.length} store${stores.length === 1 ? '' : 's'}`}
        </div>
        {!readOnly && (
          <button type="button" onClick={openNew}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            Add Store
          </button>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#faf9fc', textAlign: 'left' }}>
              <th style={{ ...cell, fontWeight: 600, color: '#6b7280' }}>Name</th>
              <th style={{ ...cell, fontWeight: 600, color: '#6b7280' }}>Code</th>
              <th style={{ ...cell, fontWeight: 600, color: '#6b7280' }}>Type</th>
              <th style={{ ...cell, fontWeight: 600, color: '#6b7280' }}>Location</th>
              <th style={{ ...cell, fontWeight: 600, color: '#6b7280' }}>Department</th>
              <th style={{ ...cell, fontWeight: 600, color: '#6b7280', textAlign: 'right' }}>Capacity</th>
              {!readOnly && <th style={{ ...cell, fontWeight: 600, color: '#6b7280', width: 120 }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {stores.map(s => (
              <tr key={s.id}>
                <td style={{ ...cell, fontWeight: 600 }}>{s.warehouse_name || s.name}</td>
                <td style={cell}>{s.warehouse_code || '—'}</td>
                <td style={cell}>{s.warehouse_type || '—'}</td>
                <td style={cell}>{s.location || '—'}</td>
                <td style={cell}>{s.department || '—'}</td>
                <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.capacity ?? '—'}</td>
                {!readOnly && (
                  <td style={cell}>
                    <button type="button" onClick={() => openEdit(s)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B3FDB', fontWeight: 600, fontSize: 12, padding: 0, marginRight: 12 }}>
                      Edit
                    </button>
                    <button type="button" onClick={() => setPendingDelete(s.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontWeight: 600, fontSize: 12, padding: 0 }}>
                      Retire
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {!loading && stores.length === 0 && (
              <tr><td colSpan={7} style={{ padding: '32px 16px', textAlign: 'center', color: '#9ca3af' }}>No stores yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <form onSubmit={save} style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 16px', color: '#4c1d95', fontSize: 16 }}>{drawer.id ? 'Edit Store' : 'Add Store'}</h3>
            <div style={{ display: 'grid', gap: 12 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' }}>
                Name *
                <input value={form.warehouse_name} onChange={e => setForm(f => ({ ...f, warehouse_name: e.target.value }))} style={input} required />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' }}>
                Code
                <input value={form.warehouse_code} onChange={e => setForm(f => ({ ...f, warehouse_code: e.target.value }))} style={input} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' }}>
                Type
                <input value={form.warehouse_type} onChange={e => setForm(f => ({ ...f, warehouse_type: e.target.value }))} style={input} placeholder="Main / Transit / Scrap" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' }}>
                Location
                <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} style={input} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' }}>
                Department
                <input value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} style={input} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' }}>
                Capacity
                <input type="number" value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} style={input} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button type="submit" disabled={saving}
                style={{ flex: 1, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>
                {saving ? 'Saving…' : drawer.id ? 'Update' : 'Create'}
              </button>
              <button type="button" onClick={() => setDrawer(null)}
                style={{ flex: 1, background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Retire Store"
        message="Retire this store? It stays on historical stock records but disappears from every picker."
        confirmLabel="Retire"
        variant="danger"
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

/* ── TAB: Zones & Bins ──
   The zone and bin masters. The "Bin Locations" tab beside this one is a floor
   VISUALISER — a fixed row/shelf grid you assign stock into — and it has never
   been able to create the zones or bins it draws. Until this tab existed the
   only code that had ever inserted either was the development seed block in
   warehouse.routes.js, so adding a shelf meant writing SQL. */
const EMPTY_ZONE = { warehouse_id: '', name: '', zone_type: 'storage' };
const EMPTY_BIN  = { bin_code: '', row_no: '', shelf: '', level: '', max_weight_kg: '' };
const ZONE_TYPES = ['storage', 'receiving', 'dispatch', 'quarantine', 'staging'];

function ZonesBinsTab() {
  const toast = useToast();
  const { readOnly } = usePageAccess();

  const [stores, setStores]   = useState([]);
  const [zones, setZones]     = useState([]);
  const [bins, setBins]       = useState([]);
  const [selZone, setSelZone] = useState(null);
  const [loading, setLoading] = useState(true);
  const [binsLoading, setBinsLoading] = useState(false);

  const [zoneDrawer, setZoneDrawer] = useState(null);  // null | { id? }
  const [zoneForm, setZoneForm]     = useState(EMPTY_ZONE);
  const [binDrawer, setBinDrawer]   = useState(null);  // null | { id? }
  const [binForm, setBinForm]       = useState(EMPTY_BIN);
  const [saving, setSaving]         = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null); // { kind, id, label }

  const loadZones = useCallback(async () => {
    setLoading(true);
    try {
      const [zr, sr] = await Promise.all([
        api.get('/warehouse/zones'),
        api.get('/inventory/warehouses'),
      ]);
      const zoneRows = Array.isArray(zr.data) ? zr.data : [];
      setZones(zoneRows);
      setStores(Array.isArray(sr.data) ? sr.data : (sr.data?.warehouses ?? []));
      // Keep the current selection across a reload; fall back to the first zone
      // so the bin pane is never pointing at a zone that no longer exists.
      setSelZone(prev => zoneRows.find(z => z.id === prev?.id) || zoneRows[0] || null);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not load zones');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadZones(); }, [loadZones]);

  const loadBins = useCallback(async (zoneId) => {
    if (!zoneId) { setBins([]); return; }
    setBinsLoading(true);
    try {
      const res = await api.get('/warehouse/bins', { params: { zone_id: zoneId } });
      setBins(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not load bins');
      setBins([]);
    } finally {
      setBinsLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadBins(selZone?.id); }, [selZone?.id, loadBins]);

  /* ── zone actions ── */
  const openNewZone = () => {
    setZoneForm({ ...EMPTY_ZONE, warehouse_id: selZone?.warehouse_id || stores[0]?.id || '' });
    setZoneDrawer({});
  };
  const openEditZone = (z) => {
    setZoneForm({ warehouse_id: z.warehouse_id, name: z.name || '', zone_type: z.zone_type || 'storage' });
    setZoneDrawer({ id: z.id });
  };
  const saveZone = async (e) => {
    e.preventDefault();
    if (!zoneForm.name.trim()) return toast.error('Zone name is required');
    if (!zoneDrawer.id && !zoneForm.warehouse_id) return toast.error('Pick a store for this zone');
    setSaving(true);
    try {
      if (zoneDrawer.id) {
        // warehouse_id is not sent on edit — the server refuses to move a zone
        // between stores, because its bins carry stock.
        await api.put(`/warehouse/zones/${zoneDrawer.id}`, { name: zoneForm.name, zone_type: zoneForm.zone_type });
      } else {
        await api.post('/warehouse/zones', zoneForm);
      }
      toast.success(zoneDrawer.id ? 'Zone updated' : 'Zone created');
      setZoneDrawer(null);
      loadZones();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save the zone');
    } finally {
      setSaving(false);
    }
  };

  /* ── bin actions ── */
  const openNewBin = () => {
    if (!selZone) return toast.error('Pick a zone first');
    setBinForm(EMPTY_BIN);
    setBinDrawer({});
  };
  const openEditBin = (b) => {
    setBinForm({
      bin_code: b.bin_code || '', row_no: b.row_no || '', shelf: b.shelf || '',
      level: b.level || '', max_weight_kg: b.max_weight_kg ?? '',
    });
    setBinDrawer({ id: b.id });
  };
  const saveBin = async (e) => {
    e.preventDefault();
    if (!binForm.bin_code.trim()) return toast.error('Bin code is required');
    setSaving(true);
    try {
      if (binDrawer.id) await api.put(`/warehouse/bins/${binDrawer.id}`, binForm);
      else              await api.post('/warehouse/bins', { ...binForm, zone_id: selZone.id });
      toast.success(binDrawer.id ? 'Bin updated' : 'Bin created');
      setBinDrawer(null);
      loadBins(selZone.id);
      loadZones();          // bin_count on the zone row is now stale
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save the bin');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      if (target.kind === 'zone') {
        await api.delete(`/warehouse/zones/${target.id}`);
        toast.success('Zone deleted');
        setSelZone(null);
        loadZones();
      } else {
        await api.delete(`/warehouse/bins/${target.id}`);
        toast.success('Bin deleted');
        loadBins(selZone?.id);
        loadZones();
      }
    } catch (err) {
      // A 409 here names what is holding the record — stock in the bin, bins in
      // the zone, or a pick list referencing it. Show that, not a generic fail.
      toast.error(err?.response?.data?.error || `Could not delete the ${target.kind}`);
    }
  };

  const cell  = { padding: '9px 12px', borderBottom: '1px solid #f0f0f4', fontSize: 13 };
  const head  = { ...cell, fontWeight: 600, color: '#6b7280' };
  const input = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
  const label = { display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' };
  const linkBtn = (color) => ({ background: 'none', border: 'none', cursor: 'pointer', color, fontWeight: 600, fontSize: 12, padding: 0 });
  const storeName = (id) => {
    const s = stores.find(x => x.id === id);
    return s ? (s.warehouse_name || s.name) : '—';
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 22, alignItems: 'start' }}>
      {/* ── Zones ── */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#4c1d95' }}>
            Zones {loading ? '' : `(${zones.length})`}
          </div>
          {!readOnly && (
            <button type="button" onClick={openNewZone}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
              Add Zone
            </button>
          )}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#faf9fc', textAlign: 'left' }}>
                <th style={head}>Zone</th>
                <th style={head}>Store</th>
                <th style={head}>Type</th>
                <th style={{ ...head, textAlign: 'right' }}>Bins</th>
                {!readOnly && <th style={{ ...head, width: 110 }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {zones.map(z => (
                <tr key={z.id}
                    onClick={() => setSelZone(z)}
                    style={{ cursor: 'pointer', background: selZone?.id === z.id ? '#f5f3ff' : 'transparent' }}>
                  <td style={{ ...cell, fontWeight: 600 }}>{z.name}</td>
                  <td style={cell}>{z.warehouse_name || storeName(z.warehouse_id)}</td>
                  <td style={cell}>{z.zone_type || '—'}</td>
                  <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{z.bin_count ?? 0}</td>
                  {!readOnly && (
                    <td style={cell}>
                      <button type="button" onClick={(e) => { e.stopPropagation(); openEditZone(z); }}
                        style={{ ...linkBtn('#6B3FDB'), marginRight: 12 }}>Edit</button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setPendingDelete({ kind: 'zone', id: z.id, label: z.name }); }}
                        style={linkBtn('#dc2626')}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
              {!loading && zones.length === 0 && (
                <tr><td colSpan={5} style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af' }}>No zones yet</td></tr>
              )}
              {loading && (
                <tr><td colSpan={5} style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af' }}>Loading…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Bins in the selected zone ── */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#4c1d95' }}>
            {selZone ? `Bins in ${selZone.name}` : 'Bins'} {selZone && !binsLoading ? `(${bins.length})` : ''}
          </div>
          {!readOnly && selZone && (
            <button type="button" onClick={openNewBin}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
              Add Bin
            </button>
          )}
        </div>

        {!selZone ? (
          <div style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13, border: '1px dashed #e9e4ff', borderRadius: 10 }}>
            Pick a zone to see its bins
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#faf9fc', textAlign: 'left' }}>
                  <th style={head}>Bin code</th>
                  <th style={head}>Row</th>
                  <th style={head}>Shelf</th>
                  <th style={head}>Level</th>
                  <th style={head}>Contents</th>
                  {!readOnly && <th style={{ ...head, width: 110 }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {bins.map(b => (
                  <tr key={b.id}>
                    <td style={{ ...cell, fontWeight: 600 }}>{b.bin_code}</td>
                    <td style={cell}>{b.row_no || '—'}</td>
                    <td style={cell}>{b.shelf || '—'}</td>
                    <td style={cell}>{b.level || '—'}</td>
                    <td style={cell}>
                      {b.total_qty > 0
                        ? <span style={{ color: '#4c1d95', fontWeight: 600 }}>{b.item_count} item{b.item_count === 1 ? '' : 's'} · {b.total_qty}</span>
                        : <span style={{ color: '#9ca3af' }}>Empty</span>}
                    </td>
                    {!readOnly && (
                      <td style={cell}>
                        <button type="button" onClick={() => openEditBin(b)}
                          style={{ ...linkBtn('#6B3FDB'), marginRight: 12 }}>Edit</button>
                        <button type="button" onClick={() => setPendingDelete({ kind: 'bin', id: b.id, label: b.bin_code })}
                          style={linkBtn('#dc2626')}>Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
                {!binsLoading && bins.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af' }}>No bins in this zone yet</td></tr>
                )}
                {binsLoading && (
                  <tr><td colSpan={6} style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af' }}>Loading…</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Zone form ── */}
      {zoneDrawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <form onSubmit={saveZone} style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 16px', color: '#4c1d95', fontSize: 16 }}>{zoneDrawer.id ? 'Edit Zone' : 'Add Zone'}</h3>
            <div style={{ display: 'grid', gap: 12 }}>
              <label style={label}>
                Store *
                <select
                  value={zoneForm.warehouse_id}
                  onChange={e => setZoneForm(f => ({ ...f, warehouse_id: e.target.value }))}
                  style={input}
                  disabled={!!zoneDrawer.id}
                  required
                >
                  <option value="">Select a store…</option>
                  {stores.map(s => <option key={s.id} value={s.id}>{s.warehouse_name || s.name}</option>)}
                </select>
                {zoneDrawer.id && (
                  <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: 11 }}>
                    A zone cannot move between stores — its bins hold stock.
                  </span>
                )}
              </label>
              <label style={label}>
                Zone name *
                <input value={zoneForm.name} onChange={e => setZoneForm(f => ({ ...f, name: e.target.value }))} style={input} required />
              </label>
              <label style={label}>
                Type
                <select value={zoneForm.zone_type} onChange={e => setZoneForm(f => ({ ...f, zone_type: e.target.value }))} style={input}>
                  {ZONE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button type="button" onClick={() => setZoneDrawer(null)}
                style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                Cancel
              </button>
              <button type="submit" disabled={saving}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Bin form ── */}
      {binDrawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <form onSubmit={saveBin} style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 4px', color: '#4c1d95', fontSize: 16 }}>{binDrawer.id ? 'Edit Bin' : 'Add Bin'}</h3>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>in {selZone?.name}</div>
            <div style={{ display: 'grid', gap: 12 }}>
              <label style={label}>
                Bin code *
                <input value={binForm.bin_code} onChange={e => setBinForm(f => ({ ...f, bin_code: e.target.value }))} style={input} placeholder="R1-S2-L1" required />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <label style={label}>
                  Row
                  <input value={binForm.row_no} onChange={e => setBinForm(f => ({ ...f, row_no: e.target.value }))} style={input} placeholder="R1" />
                </label>
                <label style={label}>
                  Shelf
                  <input value={binForm.shelf} onChange={e => setBinForm(f => ({ ...f, shelf: e.target.value }))} style={input} placeholder="S2" />
                </label>
                <label style={label}>
                  Level
                  <input value={binForm.level} onChange={e => setBinForm(f => ({ ...f, level: e.target.value }))} style={input} placeholder="1" />
                </label>
              </div>
              <label style={label}>
                Max weight (kg)
                <input type="number" min="0" step="any" value={binForm.max_weight_kg}
                  onChange={e => setBinForm(f => ({ ...f, max_weight_kg: e.target.value }))} style={input} placeholder="500" />
              </label>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>
                Row, shelf and level are what the Bin Locations grid draws — a bin with
                a row of <b>R1</b> and a shelf of <b>S2</b> appears in that cell.
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button type="button" onClick={() => setBinDrawer(null)}
                style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                Cancel
              </button>
              <button type="submit" disabled={saving}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.kind === 'zone' ? 'Delete zone' : 'Delete bin'}
        message={
          pendingDelete?.kind === 'zone'
            ? `Delete "${pendingDelete?.label}"? This cannot be undone, and a zone that still has bins will be refused.`
            : `Delete bin "${pendingDelete?.label}"? This cannot be undone, and a bin holding stock will be refused.`
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

/* ── MAIN ── */
const TABS = ['Stores', 'Zones & Bins', 'Bin Locations', 'Pick-Pack-Ship', 'Inward QC', 'Cycle Count'];

export default function WarehouseManagement() {
  const { readOnly } = usePageAccess();
  const [tab, setTab] = useState('Stores');

  return (
    <PageShell dock={
      <>
        <PageHero
          icon={Package}
          eyebrow="Inventory"
          title="Warehouse Management"
          subtitle="Bin locations, pick-pack-ship, inward QC, and cycle counting"
        />
        <div className="plh-toolbar">
          {<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {TABS.map(t => (
              <button
                key={t}
                type="button"
                className={`pl-icon-btn${tab === t ? ' pl-active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>}
        </div>
      </>
    }>

      {readOnly && <ReadOnlyBanner />}
      <ContentCard>
        {tab === 'Stores'         && <StoresTab />}
        {tab === 'Zones & Bins'   && <ZonesBinsTab />}
        {tab === 'Bin Locations'  && <BinsTab />}
        {tab === 'Pick-Pack-Ship' && <PickPackTab />}
        {tab === 'Inward QC'      && <InwardQCTab />}
        {tab === 'Cycle Count'    && <CycleCountTab />}
      </ContentCard>
    </PageShell>
  );
}
