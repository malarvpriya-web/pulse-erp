import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';
import { Plus, X, RefreshCw, Package, AlertTriangle, TrendingDown, ArrowUp, ArrowDown, Download, History } from 'lucide-react';

const EMPTY_PART = {
  name: '', part_number: '', unit: 'Pcs', unit_cost: '',
  stock_quantity: 0, min_level: 0, max_level: 0,
  location: '', barcode: '', hsn_code: '', lead_time_days: 7,
  supplier_name: '',
};

const EMPTY_RECEIVE = { quantity: '', unit_cost: '', remarks: '' };
const EMPTY_ADJUST  = { quantity: '', remarks: '' };

const inputStyle = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

const MOVEMENT_COLOR = {
  receipt    : { bg: '#d1fae5', color: '#065f46' },
  issue      : { bg: '#fee2e2', color: '#991b1b' },
  return     : { bg: '#dbeafe', color: '#1e40af' },
  adjustment : { bg: '#fef3c7', color: '#92400e' },
  opening    : { bg: '#f3f4f6', color: '#374151' },
};

export default function StockManagement() {
  const [parts,      setParts]      = useState([]);
  const [movements,  setMovements]  = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [tab,        setTab]        = useState(0);
  const [showPart,   setShowPart]   = useState(false);
  const [showReceive,setShowReceive]= useState(null);
  const [showAdjust, setShowAdjust] = useState(null);
  const [showHistory,setShowHistory]= useState(null);
  const [partForm,   setPartForm]   = useState(EMPTY_PART);
  const [receiveForm,setReceiveForm]= useState(EMPTY_RECEIVE);
  const [adjustForm, setAdjustForm] = useState(EMPTY_ADJUST);
  const [saving,     setSaving]     = useState(false);
  const [search,     setSearch]     = useState('');
  const [movSearch,  setMovSearch]  = useState('');
  const [toast,      setToast]      = useState(null);
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadParts = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/maintenance/spare-parts', { params: { limit: 500 } });
      if (isMounted.current) setParts(Array.isArray(r.data) ? r.data : []);
    } catch { if (isMounted.current) setParts([]); }
    finally { if (isMounted.current) setLoading(false); }
  }, []);

  const loadMovements = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/maintenance/spare-parts/movements', { params: { limit: 200 } });
      if (isMounted.current) setMovements(Array.isArray(r.data) ? r.data : []);
    } catch { if (isMounted.current) setMovements([]); }
    finally { if (isMounted.current) setLoading(false); }
  }, []);

  const loadPartMovements = async (partId) => {
    try {
      const r = await api.get(`/maintenance/spare-parts/${partId}/movements`);
      setShowHistory({ partId, data: r.data || [] });
    } catch { showToast('Failed to load movement history', 'error'); }
  };

  useEffect(() => {
    if (tab === 0) loadParts();
    else loadMovements();
  }, [tab, loadParts, loadMovements]);

  const handleSavePart = async () => {
    if (!partForm.name) { showToast('Part name is required', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/maintenance/spare-parts', {
        ...partForm,
        unit_cost    : partForm.unit_cost ? Number(partForm.unit_cost) : 0,
        stock_quantity: Number(partForm.stock_quantity) || 0,
        min_level    : Number(partForm.min_level) || 0,
        max_level    : Number(partForm.max_level) || 0,
        lead_time_days: Number(partForm.lead_time_days) || 7,
      });
      showToast('Spare part added');
      setShowPart(false); setPartForm(EMPTY_PART); loadParts();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  const handleReceive = async () => {
    if (!receiveForm.quantity || Number(receiveForm.quantity) <= 0) { showToast('Quantity must be > 0', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/maintenance/spare-parts/receive', {
        part_id   : showReceive.id,
        quantity  : Number(receiveForm.quantity),
        unit_cost : receiveForm.unit_cost ? Number(receiveForm.unit_cost) : undefined,
        remarks   : receiveForm.remarks || undefined,
      });
      showToast(`Received ${receiveForm.quantity} units of ${showReceive.name}`);
      setShowReceive(null); setReceiveForm(EMPTY_RECEIVE); loadParts();
    } catch (e) { showToast(e.response?.data?.error || 'Receipt failed', 'error'); }
    finally { setSaving(false); }
  };

  const handleAdjust = async () => {
    if (!adjustForm.quantity) { showToast('Quantity is required', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/maintenance/spare-parts/adjust', {
        part_id  : showAdjust.id,
        quantity : Number(adjustForm.quantity),
        remarks  : adjustForm.remarks || undefined,
      });
      showToast(`Stock adjusted for ${showAdjust.name}`);
      setShowAdjust(null); setAdjustForm(EMPTY_ADJUST); loadParts();
    } catch (e) { showToast(e.response?.data?.error || 'Adjustment failed', 'error'); }
    finally { setSaving(false); }
  };

  const exportParts = () => {
    const cols = ['name','part_number','unit','stock_quantity','unit_cost','min_level','max_level','location','supplier_name','hsn_code'];
    const csv = [cols.join(','), ...parts.map(p => cols.map(c => String(p[c] ?? '').replace(/,/g, ';')).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `spare_parts_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const filteredParts = parts.filter(p =>
    !search || [p.name, p.part_number, p.location, p.supplier_name, p.barcode].some(s => (s || '').toLowerCase().includes(search.toLowerCase()))
  );
  const filteredMovements = movements.filter(m =>
    !movSearch || [m.part_name, m.movement_type, m.reference_type, m.remarks, m.done_by].some(s => (s || '').toLowerCase().includes(movSearch.toLowerCase()))
  );

  const lowStock   = parts.filter(p => p.min_level > 0 && Number(p.stock_quantity) <= Number(p.min_level)).length;
  const totalParts = parts.length;
  const totalValue = parts.reduce((s, p) => s + (Number(p.stock_quantity) * Number(p.unit_cost || 0)), 0);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 24, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', color: toast.type === 'error' ? '#dc2626' : '#15803d', boxShadow: '0 2px 8px rgba(0,0,0,.12)' }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Spare Parts & Stock</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Stock levels, receipts, adjustments, and movement audit trail</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={exportParts}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <Download size={14} /> Export
          </button>
          <button onClick={() => { setShowPart(true); setPartForm(EMPTY_PART); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> Add Part
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Total Parts', value: totalParts, icon: <Package size={18} color="#6366f1" />, bg: '#e0e7ff' },
          { label: 'Low Stock Alerts', value: lowStock, icon: <AlertTriangle size={18} color={lowStock > 0 ? '#ef4444' : '#10b981'} />, bg: lowStock > 0 ? '#fee2e2' : '#d1fae5' },
          { label: 'Inventory Value', value: `₹${totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, icon: <TrendingDown size={18} color="#10b981" />, bg: '#d1fae5' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ background: k.bg, borderRadius: 10, padding: 10 }}>{k.icon}</div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: '#f3f4f6', padding: 4, borderRadius: 10, marginBottom: 20, width: 'fit-content' }}>
        {['Parts Catalogue', 'Movement Audit'].map((t, i) => (
          <button key={i} onClick={() => setTab(i)}
            style={{ padding: '8px 20px', border: 'none', background: tab === i ? '#6B3FDB' : 'transparent', color: tab === i ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: tab === i ? 600 : 400, fontSize: 14 }}>
            {t}
          </button>
        ))}
      </div>

      {/* ── Parts Catalogue ── */}
      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search part name, number, location..."
              style={{ flex: 1, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }} />
            <button onClick={loadParts} style={{ padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>
              <RefreshCw size={14} color="#9ca3af" />
            </button>
          </div>

          {lowStock > 0 && (
            <div style={{ marginBottom: 16, padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <AlertTriangle size={16} color="#ef4444" />
              <span style={{ fontSize: 13, color: '#b91c1c', fontWeight: 600 }}>{lowStock} part{lowStock > 1 ? 's' : ''} below minimum stock level</span>
            </div>
          )}

          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
            ) : filteredParts.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
                <Package size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
                <p>No spare parts found</p>
                <button onClick={() => setShowPart(true)} style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, marginTop: 8 }}>Add First Part</button>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Part Name', 'Part #', 'Unit', 'Stock', 'Min/Max', 'Unit Cost', 'Value', 'Location', 'Supplier', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredParts.map((p, i) => {
                    const qty = Number(p.stock_quantity || 0);
                    const min = Number(p.min_level || 0);
                    const isLow = min > 0 && qty <= min;
                    const val = qty * Number(p.unit_cost || 0);
                    return (
                      <tr key={p.id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                          {p.name}
                          {p.barcode && <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace' }}>{p.barcode}</div>}
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{p.part_number || '—'}</td>
                        <td style={{ padding: '10px 12px', color: '#6b7280' }}>{p.unit}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ fontWeight: 700, color: isLow ? '#ef4444' : '#1f2937', fontSize: 15 }}>{qty}</span>
                          {isLow && <span style={{ marginLeft: 4, fontSize: 10, color: '#ef4444' }}>LOW</span>}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280' }}>{p.min_level}/{p.max_level}</td>
                        <td style={{ padding: '10px 12px', color: '#374151' }}>
                          {p.unit_cost > 0 ? `₹${Number(p.unit_cost).toLocaleString('en-IN')}` : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', fontWeight: 600, color: '#059669' }}>
                          {val > 0 ? `₹${val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>{p.location || '—'}</td>
                        <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>{p.supplier_name || '—'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={() => { setShowReceive(p); setReceiveForm(EMPTY_RECEIVE); }}
                              title="Receive stock"
                              style={{ padding: '3px 8px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                              <ArrowDown size={11} /> In
                            </button>
                            <button onClick={() => { setShowAdjust(p); setAdjustForm(EMPTY_ADJUST); }}
                              title="Adjust stock"
                              style={{ padding: '3px 8px', background: '#fef3c7', color: '#92400e', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Adjust</button>
                            <button onClick={() => loadPartMovements(p.id)}
                              title="View movement history"
                              style={{ padding: '3px 8px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                              <History size={11} />
                            </button>
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
      )}

      {/* ── Movement Audit ── */}
      {tab === 1 && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <input value={movSearch} onChange={e => setMovSearch(e.target.value)} placeholder="Search movements..."
              style={{ flex: 1, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }} />
            <button onClick={loadMovements} style={{ padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>
              <RefreshCw size={14} color="#9ca3af" />
            </button>
          </div>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
            ) : filteredMovements.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No movements recorded yet</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Date', 'Part', 'Type', 'Qty', 'Before', 'After', 'Ref', 'Unit Cost', 'Done By', 'Remarks'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredMovements.map((m, i) => {
                    const mc = MOVEMENT_COLOR[m.movement_type] || MOVEMENT_COLOR.adjustment;
                    return (
                      <tr key={m.id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '10px 12px', color: '#9ca3af', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {m.created_at ? new Date(m.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', fontWeight: 500 }}>{m.part_name || `Part #${m.part_id}`}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ background: mc.bg, color: mc.color, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, textTransform: 'capitalize' }}>
                            {m.movement_type}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', fontWeight: 700, color: ['receipt','return','opening'].includes(m.movement_type) ? '#10b981' : '#ef4444' }}>
                          {['receipt','return','opening'].includes(m.movement_type) ? '+' : ''}{m.quantity}
                        </td>
                        <td style={{ padding: '10px 12px', color: '#9ca3af' }}>{m.stock_before}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 600 }}>{m.stock_after}</td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#6366f1' }}>
                          {m.reference_type && <div>{m.reference_type}</div>}
                          {m.reference_id && <div>#{m.reference_id}</div>}
                        </td>
                        <td style={{ padding: '10px 12px', color: '#374151' }}>
                          {m.unit_cost > 0 ? `₹${Number(m.unit_cost).toLocaleString('en-IN')}` : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', color: '#6b7280' }}>{m.done_by || '—'}</td>
                        <td style={{ padding: '10px 12px', color: '#6b7280', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.remarks || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Add Part Modal ── */}
      {showPart && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 580, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Add Spare Part</h2>
              <button onClick={() => setShowPart(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Part Name *</label>
                <input value={partForm.name} onChange={e => setPartForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. IGBT Module 1200V" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Part Number</label>
                <input value={partForm.part_number} onChange={e => setPartForm(p => ({ ...p, part_number: e.target.value }))} placeholder="SKU / OEM part number" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Unit</label>
                <select value={partForm.unit} onChange={e => setPartForm(p => ({ ...p, unit: e.target.value }))} style={inputStyle}>
                  {['Pcs','Kg','Ltr','Mtr','Set','Box','Roll'].map(u => <option key={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Opening Stock Qty</label>
                <input type="number" value={partForm.stock_quantity} onChange={e => setPartForm(p => ({ ...p, stock_quantity: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Unit Cost (₹)</label>
                <input type="number" value={partForm.unit_cost} onChange={e => setPartForm(p => ({ ...p, unit_cost: e.target.value }))} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Min Level</label>
                <input type="number" value={partForm.min_level} onChange={e => setPartForm(p => ({ ...p, min_level: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Max Level</label>
                <input type="number" value={partForm.max_level} onChange={e => setPartForm(p => ({ ...p, max_level: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Location / Bin</label>
                <input value={partForm.location} onChange={e => setPartForm(p => ({ ...p, location: e.target.value }))} placeholder="Rack A-3" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Supplier Name</label>
                <input value={partForm.supplier_name} onChange={e => setPartForm(p => ({ ...p, supplier_name: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>HSN Code</label>
                <input value={partForm.hsn_code} onChange={e => setPartForm(p => ({ ...p, hsn_code: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Lead Time (days)</label>
                <input type="number" value={partForm.lead_time_days} onChange={e => setPartForm(p => ({ ...p, lead_time_days: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Barcode</label>
                <input value={partForm.barcode} onChange={e => setPartForm(p => ({ ...p, barcode: e.target.value }))} style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowPart(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSavePart} disabled={saving}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Adding...' : 'Add Part'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Receive Stock Modal ── */}
      {showReceive && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Receive Stock — {showReceive.name}</h2>
              <button onClick={() => setShowReceive(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ background: '#f0fdf4', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#065f46' }}>
              Current stock: <strong>{showReceive.stock_quantity} {showReceive.unit}</strong>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={labelStyle}>Quantity Received *</label>
                <input type="number" value={receiveForm.quantity} onChange={e => setReceiveForm(r => ({ ...r, quantity: e.target.value }))} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Unit Cost (₹)</label>
                <input type="number" value={receiveForm.unit_cost} onChange={e => setReceiveForm(r => ({ ...r, unit_cost: e.target.value }))} placeholder="Leave blank to keep current cost" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Remarks</label>
                <input value={receiveForm.remarks} onChange={e => setReceiveForm(r => ({ ...r, remarks: e.target.value }))} placeholder="PO#, Supplier, GRN#..." style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowReceive(null)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleReceive} disabled={saving}
                style={{ padding: '9px 18px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Receiving...' : 'Confirm Receipt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Adjust Stock Modal ── */}
      {showAdjust && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Adjust Stock — {showAdjust.name}</h2>
              <button onClick={() => setShowAdjust(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ background: '#fef3c7', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
              Current stock: <strong>{showAdjust.stock_quantity} {showAdjust.unit}</strong>. Enter new absolute quantity.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={labelStyle}>New Quantity (absolute) *</label>
                <input type="number" value={adjustForm.quantity} onChange={e => setAdjustForm(a => ({ ...a, quantity: e.target.value }))} placeholder="e.g. 25" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Reason / Remarks *</label>
                <textarea value={adjustForm.remarks} onChange={e => setAdjustForm(a => ({ ...a, remarks: e.target.value }))} rows={2}
                  placeholder="Physical count discrepancy, damage, expiry..." style={{ ...inputStyle, resize: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAdjust(null)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleAdjust} disabled={saving}
                style={{ padding: '9px 18px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Adjusting...' : 'Confirm Adjustment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Part Movement History Modal ── */}
      {showHistory && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 640, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Movement History</h2>
              <button onClick={() => setShowHistory(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            {showHistory.data.length === 0 ? (
              <p style={{ color: '#9ca3af', textAlign: 'center', padding: '24px 0' }}>No movements recorded for this part.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Date','Type','Qty','Before','After','Ref','Cost','By','Remarks'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {showHistory.data.map((m, i) => {
                    const mc = MOVEMENT_COLOR[m.movement_type] || MOVEMENT_COLOR.adjustment;
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                        <td style={{ padding: '8px 10px', fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                          {new Date(m.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ background: mc.bg, color: mc.color, padding: '2px 6px', borderRadius: 12, fontSize: 10, fontWeight: 600, textTransform: 'capitalize' }}>{m.movement_type}</span>
                        </td>
                        <td style={{ padding: '8px 10px', fontWeight: 700, color: ['receipt','return','opening'].includes(m.movement_type) ? '#10b981' : '#ef4444' }}>
                          {['receipt','return','opening'].includes(m.movement_type) ? '+' : ''}{m.quantity}
                        </td>
                        <td style={{ padding: '8px 10px', color: '#9ca3af' }}>{m.stock_before}</td>
                        <td style={{ padding: '8px 10px', fontWeight: 600 }}>{m.stock_after}</td>
                        <td style={{ padding: '8px 10px', fontSize: 11, color: '#6366f1' }}>{m.reference_type ? `${m.reference_type} #${m.reference_id || ''}` : '—'}</td>
                        <td style={{ padding: '8px 10px', color: '#374151' }}>{m.unit_cost > 0 ? `₹${m.unit_cost}` : '—'}</td>
                        <td style={{ padding: '8px 10px', color: '#6b7280' }}>{m.done_by || '—'}</td>
                        <td style={{ padding: '8px 10px', color: '#6b7280', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.remarks || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
