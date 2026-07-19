import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { Plus, X, Search, Package, CheckCircle, RefreshCw, Truck, AlertCircle, ChevronRight, ChevronLeft } from 'lucide-react';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import QualityTestsPanel from '@/features/quality/components/QualityTestsPanel';
import './GoodsReceipt.css';

const STATUS_CFG = {
  pending:  { bg: '#fef3c7', color: '#92400e', label: 'Pending'  },
  partial:  { bg: '#dbeafe', color: '#1e40af', label: 'Partial'  },
  received: { bg: '#d1fae5', color: '#065f46', label: 'Received' },
  rejected: { bg: '#fee2e2', color: '#991b1b', label: 'Rejected' },
};
const sc = s => STATUS_CFG[(s||'').toLowerCase()] || STATUS_CFG.pending;

const today = () => new Date().toISOString().slice(0, 10);

const emptyDetails = () => ({ received_date: today(), warehouse_id: '', notes: '' });

export default function GoodsReceipt() {
  const { readOnly } = usePageAccess();
  const [grns,       setGrns]       = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [showModal,  setShowModal]  = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [search,     setSearch]     = useState('');
  const [statusF,    setStatusF]    = useState('All');
  const [toast,      setToast]      = useState(null);
  const [qualityGrn, setQualityGrn] = useState(null);  // GRN whose quality tests are open

  /* ── wizard state ── */
  const [step,       setStep]       = useState(1);
  const [poList,     setPoList]     = useState([]);
  const [poSearch,   setPoSearch]   = useState('');
  const [poLoading,  setPoLoading]  = useState(false);
  const [selectedPO, setSelectedPO] = useState(null);
  const [poItems,    setPoItems]    = useState([]);
  const [itemRows,   setItemRows]   = useState({});
  const [warehouses, setWarehouses] = useState([]);
  const [details,    setDetails]    = useState(emptyDetails());

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3000);
  };

  const load = () => {
    setLoading(true);
    api.get('/procurement/grn', { params: { limit: 200 } })
      .then(r  => { if (isMounted.current) setGrns(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setGrns([]); })
      .finally(()=> { if (isMounted.current) setLoading(false); });
  };
  useEffect(() => { load(); }, []);

  /* ── open modal ── */
  const openModal = () => {
    setStep(1);
    setPoSearch('');
    setSelectedPO(null);
    setPoItems([]);
    setItemRows({});
    setDetails(emptyDetails());
    setShowModal(true);

    setPoLoading(true);
    Promise.allSettled([
      api.get('/procurement/purchase-orders'),
      api.get('/inventory/warehouses'),
    ]).then(([posR, whR]) => {
      if (!isMounted.current) return;
      const allPos = posR.status === 'fulfilled'
        ? (Array.isArray(posR.value.data) ? posR.value.data : posR.value.data?.orders || [])
        : [];
      setPoList(allPos.filter(p => p.status === 'approved' || p.status === 'partial' || p.status === 'sent'));
      const wh = whR.status === 'fulfilled' ? (whR.value.data || []) : [];
      setWarehouses(Array.isArray(wh) ? wh : []);
      setPoLoading(false);
    });
  };

  /* ── Step 1 → 2: select PO, fetch its items ── */
  const selectPO = async (po) => {
    setSelectedPO(po);
    try {
      const r = await api.get(`/procurement/purchase-orders/${po.id}`);
      if (!isMounted.current) return;
      const items = r.data.items || [];
      setPoItems(items);
      const rows = {};
      items.forEach(it => {
        const remaining = parseFloat(it.quantity || 0) - parseFloat(it.received_quantity || 0);
        rows[it.id] = { quantity_received: Math.max(0, remaining), quantity_rejected: 0, batch_number: '', expiry_date: '', remarks: '' };
      });
      setItemRows(rows);
      setStep(2);
    } catch {
      showToast('Failed to load PO items', 'error');
    }
  };

  const updateRow = (id, field, val) => {
    setItemRows(prev => {
      const row = { ...prev[id] };
      const item = poItems.find(i => i.id === id);
      const maxQty = parseFloat(item?.quantity || 0) - parseFloat(item?.received_quantity || 0);
      if (field === 'quantity_received') {
        const v = Math.min(Math.max(0, Number(val) || 0), maxQty);
        row.quantity_received = v;
        if (row.quantity_rejected > v) row.quantity_rejected = v;
      } else if (field === 'quantity_rejected') {
        row.quantity_rejected = Math.min(Math.max(0, Number(val) || 0), row.quantity_received);
      } else {
        row[field] = val;
      }
      return { ...prev, [id]: row };
    });
  };

  /* ── Submit ── */
  const handleSave = async () => {
    if (!details.received_date) return showToast('Received date is required', 'error');
    if (!details.warehouse_id)  return showToast('Please select a warehouse', 'error');
    setSaving(true);
    try {
      await api.post('/procurement/grn', {
        po_id:         selectedPO.id,
        received_date: details.received_date,
        warehouse_id:  details.warehouse_id,
        notes:         details.notes,
        items: poItems.map(it => ({
          po_item_id:        it.id,
          item_id:           it.item_id,
          quantity_received: itemRows[it.id]?.quantity_received ?? 0,
          quantity_rejected: itemRows[it.id]?.quantity_rejected ?? 0,
          batch_number:      itemRows[it.id]?.batch_number || '',
          expiry_date:       itemRows[it.id]?.expiry_date || null,
          rate:              parseFloat(it.rate || 0),
          remarks:           itemRows[it.id]?.remarks || '',
        })),
      });
      if (!isMounted.current) return;
      setShowModal(false);
      load();
      showToast('GRN created successfully');
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to create GRN', 'error');
    } finally {
      if (isMounted.current) setSaving(false);
    }
  };

  const handleConfirm = async (id) => {
    try {
      await api.put(`/procurement/grn/${id}`, { status: 'received' });
      if (!isMounted.current) return;
      load();
      showToast('GRN confirmed as received');
    } catch {
      if (!isMounted.current) return;
      showToast('Update failed', 'error');
    }
  };

  const filtered = grns.filter(g => {
    const q = search.toLowerCase();
    const matchSearch = !search ||
      [g.grn_number, g.supplier_name, g.po_number, g.vendor_name]
        .some(v => (v || '').toLowerCase().includes(q));
    const matchStatus = statusF === 'All' || g.status === statusF;
    return matchSearch && matchStatus;
  });

  const kpis = {
    total:    grns.length,
    pending:  grns.filter(g => g.status === 'pending').length,
    received: grns.filter(g => g.status === 'received').length,
    partial:  grns.filter(g => g.status === 'partial').length,
    rejected: grns.filter(g => g.status === 'rejected').length,
  };

  const filteredPOs = poList.filter(p => {
    const q = poSearch.toLowerCase();
    return !q || (p.po_number || '').toLowerCase().includes(q) || (p.supplier_name || '').toLowerCase().includes(q);
  });

  const step2Valid = poItems.length > 0 && poItems.some(it => (itemRows[it.id]?.quantity_received || 0) > 0);

  return (
    <div className="grn-root">
      {toast && <div className={`grn-toast grn-toast-${toast.type}`}>{toast.msg}</div>}

      {readOnly && <ReadOnlyBanner />}

      {/* Header */}
      <div className="grn-header">
        <div className="grn-header-left">
          <div className="grn-header-icon"><Truck size={20} /></div>
          <div>
            <h1 className="grn-title">Goods Receipt</h1>
            <p className="grn-sub">Track inward goods with GRN documentation</p>
          </div>
        </div>
        <div className="grn-header-actions">
          <button className="grn-icon-btn" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
          <button className="grn-icon-btn" title="Export CSV"
            onClick={() => window.open('/api/procurement/grn/export', '_blank')}>
            ↓ Export
          </button>
          {!readOnly && (
            <button className="grn-btn-primary" onClick={openModal}>
              <Plus size={14} /> New GRN
            </button>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="grn-kpis">
        <div className="grn-kpi">
          <div className="grn-kpi-icon" style={{ background: '#f5f3ff', color: '#6B3FDB' }}><Package size={18} /></div>
          <div><div className="grn-kpi-val">{kpis.total}</div><div className="grn-kpi-lbl">Total GRNs</div></div>
        </div>
        <div className="grn-kpi" onClick={() => setStatusF('pending')} style={{ cursor: 'pointer' }}>
          <div className="grn-kpi-icon" style={{ background: '#fffbeb', color: '#d97706' }}><AlertCircle size={18} /></div>
          <div><div className="grn-kpi-val">{kpis.pending}</div><div className="grn-kpi-lbl">Pending</div></div>
        </div>
        <div className="grn-kpi" onClick={() => setStatusF('partial')} style={{ cursor: 'pointer' }}>
          <div className="grn-kpi-icon" style={{ background: '#eff6ff', color: '#2563eb' }}><Truck size={18} /></div>
          <div><div className="grn-kpi-val">{kpis.partial}</div><div className="grn-kpi-lbl">Partial</div></div>
        </div>
        <div className="grn-kpi" onClick={() => setStatusF('received')} style={{ cursor: 'pointer' }}>
          <div className="grn-kpi-icon" style={{ background: '#f0fdf4', color: '#16a34a' }}><CheckCircle size={18} /></div>
          <div><div className="grn-kpi-val">{kpis.received}</div><div className="grn-kpi-lbl">Received</div></div>
        </div>
      </div>

      {/* Filters */}
      <div className="grn-filters">
        <div className="grn-search">
          <Search size={14} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search GRN number, supplier, PO…"
          />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="grn-status-tabs">
          {[
            { key: 'All',      label: `All (${kpis.total})`           },
            { key: 'pending',  label: `Pending (${kpis.pending})`     },
            { key: 'partial',  label: `Partial (${kpis.partial})`     },
            { key: 'received', label: `Received (${kpis.received})`   },
            { key: 'rejected', label: `Rejected (${kpis.rejected})`   },
          ].map(({ key, label }) => (
            <button
              key={key}
              className={`grn-status-tab${statusF === key ? ' active' : ''}`}
              onClick={() => setStatusF(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {statusF !== 'All' && (
          <button className="grn-clear" onClick={() => setStatusF('All')}>Clear</button>
        )}
      </div>

      {/* Table */}
      <div className="grn-table-wrap">
        {loading ? (
          <div className="grn-loading"><div className="grn-spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="grn-empty">
            <Package size={40} />
            <p>{search || statusF !== 'All' ? 'No receipts match your filters' : 'No goods receipts yet'}</p>
            {!search && statusF === 'All' && !readOnly && (
              <button className="grn-btn-primary" onClick={openModal}>
                <Plus size={14} /> Create First GRN
              </button>
            )}
          </div>
        ) : (
          <table className="grn-table">
            <thead>
              <tr>
                <th>GRN Number</th>
                <th>PO Reference</th>
                <th>Supplier</th>
                <th>Received Date</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g, i) => {
                const cfg = sc(g.status);
                return (
                  <tr key={g.id || i}>
                    <td className="grn-grn-num">
                      {g.grn_number || `GRN-${String(g.id || i + 1).padStart(4, '0')}`}
                    </td>
                    <td className="grn-ref">{g.po_number || g.purchase_order_number || '—'}</td>
                    <td className="grn-supplier">{g.supplier_name || g.vendor_name || '—'}</td>
                    <td className="grn-date">
                      {(g.received_date || g.grn_date || g.created_at || '').slice(0, 10) || '—'}
                    </td>
                    <td>
                      <span className="grn-badge" style={{ background: cfg.bg, color: cfg.color }}>
                        {cfg.label}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {g.status === 'pending' && (
                          <button className="grn-confirm-btn" onClick={() => handleConfirm(g.id)}>
                            <CheckCircle size={12} /> Confirm
                          </button>
                        )}
                        <button
                          onClick={() => setQualityGrn(g)}
                          title="Quality tests for this receipt"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                          🧪 Quality{g.quality_status && !['not_required', null].includes(g.quality_status) ? ` · ${g.quality_status}` : ''}
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

      {/* ── QUALITY TESTS MODAL ── */}
      {qualityGrn && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
             onClick={e => e.target === e.currentTarget && setQualityGrn(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 'min(880px, 96vw)', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Quality Tests — {qualityGrn.grn_number || `GRN #${qualityGrn.id}`}</h2>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>{qualityGrn.supplier_name || qualityGrn.vendor_name || ''} · Incoming material inspection</p>
              </div>
              <button onClick={() => setQualityGrn(null)}
                style={{ background: '#f3f4f6', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>Close</button>
            </div>
            <QualityTestsPanel
              source={{ grnId: qualityGrn.id }}
              title=""
              defaultStage="IQC"
              readOnly={readOnly}
              onChange={load}
            />
          </div>
        </div>
      )}

      {/* ── WIZARD MODAL ── */}
      {showModal && (
        <div className="grn-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="grn-modal">
            {/* Modal header */}
            <div className="grn-modal-hd">
              <div>
                <h2>New Goods Receipt Note</h2>
                <div className="grn-steps">
                  {['Select PO', 'Items & Quality', 'Details'].map((lbl, idx) => (
                    <div key={lbl} className={`grn-step${step === idx + 1 ? ' active' : step > idx + 1 ? ' done' : ''}`}>
                      <span className="grn-step-dot">{step > idx + 1 ? '✓' : idx + 1}</span>
                      <span className="grn-step-lbl">{lbl}</span>
                      {idx < 2 && <ChevronRight size={12} className="grn-step-arrow" />}
                    </div>
                  ))}
                </div>
              </div>
              <button className="grn-modal-close" onClick={() => setShowModal(false)}>
                <X size={18} />
              </button>
            </div>

            {/* ── STEP 1: Select PO ── */}
            {step === 1 && (
              <div className="grn-modal-body">
                <div className="grn-po-search">
                  <Search size={14} />
                  <input
                    autoFocus
                    value={poSearch}
                    onChange={e => setPoSearch(e.target.value)}
                    placeholder="Search PO number or supplier…"
                  />
                </div>
                {poLoading ? (
                  <div className="grn-loading" style={{ padding: '40px' }}><div className="grn-spinner" /></div>
                ) : filteredPOs.length === 0 ? (
                  <div className="grn-empty" style={{ padding: '40px 0' }}>
                    <Package size={32} />
                    <p>{poSearch ? 'No POs match your search' : 'No approved or partial POs available'}</p>
                  </div>
                ) : (
                  <div className="grn-po-list">
                    {filteredPOs.map(po => (
                      <button key={po.id} className="grn-po-item" onClick={() => selectPO(po)}>
                        <div className="grn-po-left">
                          <div className="grn-po-num">{po.po_number}</div>
                          <div className="grn-po-supplier">{po.supplier_name}</div>
                        </div>
                        <div className="grn-po-right">
                          <span className={`grn-po-status grn-po-status-${po.status}`}>
                            {po.status}
                          </span>
                          <span className="grn-po-date">{(po.order_date || '').slice(0, 10)}</span>
                        </div>
                        <ChevronRight size={14} className="grn-po-arrow" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── STEP 2: Items & Quality ── */}
            {step === 2 && (
              <div className="grn-modal-body">
                <div className="grn-po-banner">
                  <span className="grn-po-banner-num">{selectedPO?.po_number}</span>
                  <span className="grn-po-banner-sup">{selectedPO?.supplier_name}</span>
                </div>
                <div className="grn-items-wrap">
                  <table className="grn-items-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Pending Qty</th>
                        <th>Received</th>
                        <th>Rejected</th>
                        <th style={{ color: '#16a34a' }}>Accepted ↗</th>
                        <th>Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poItems.map(it => {
                        const row = itemRows[it.id] || { quantity_received: 0, quantity_rejected: 0, remarks: '' };
                        const maxQty = parseFloat(it.quantity || 0) - parseFloat(it.received_quantity || 0);
                        const accepted = Math.max(0, (row.quantity_received || 0) - (row.quantity_rejected || 0));
                        return (
                          <tr key={it.id}>
                            <td>
                              <div className="grn-item-name">{it.item_name}</div>
                              <div className="grn-item-code">{it.item_code} · {it.unit_of_measure}</div>
                            </td>
                            <td className="grn-qty-cell">{maxQty}</td>
                            <td className="grn-qty-cell">
                              <input
                                type="number"
                                className="grn-qty-input"
                                min={0}
                                max={maxQty}
                                value={row.quantity_received}
                                onChange={e => updateRow(it.id, 'quantity_received', e.target.value)}
                              />
                            </td>
                            <td className="grn-qty-cell">
                              <input
                                type="number"
                                className={`grn-qty-input${row.quantity_rejected > 0 ? ' rejected' : ''}`}
                                min={0}
                                max={row.quantity_received}
                                value={row.quantity_rejected}
                                onChange={e => updateRow(it.id, 'quantity_rejected', e.target.value)}
                              />
                            </td>
                            <td className="grn-qty-cell" style={{ fontWeight: 600, color: accepted > 0 ? '#16a34a' : '#9ca3af' }}>
                              {accepted}
                            </td>
                            <td>
                              <input
                                type="text"
                                className="grn-remarks-input"
                                value={row.remarks}
                                onChange={e => updateRow(it.id, 'remarks', e.target.value)}
                                placeholder="Optional"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── STEP 3: GRN Details ── */}
            {step === 3 && (
              <div className="grn-modal-body">
                <div className="grn-po-banner">
                  <span className="grn-po-banner-num">{selectedPO?.po_number}</span>
                  <span className="grn-po-banner-sup">{selectedPO?.supplier_name}</span>
                </div>
                <div className="grn-form-row">
                  <div className="grn-field">
                    <label>Received Date <span>*</span></label>
                    <input
                      type="date"
                      value={details.received_date}
                      onChange={e => setDetails(p => ({ ...p, received_date: e.target.value }))}
                    />
                  </div>
                  <div className="grn-field">
                    <label>Warehouse <span>*</span></label>
                    <select
                      value={details.warehouse_id}
                      onChange={e => setDetails(p => ({ ...p, warehouse_id: e.target.value }))}
                      className="grn-select"
                    >
                      <option value="">Select warehouse…</option>
                      {warehouses.map(w => (
                        <option key={w.id} value={w.id}>{w.warehouse_name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grn-field">
                  <label>Notes</label>
                  <textarea
                    rows={3}
                    value={details.notes}
                    onChange={e => setDetails(p => ({ ...p, notes: e.target.value }))}
                    placeholder="Any remarks or observations…"
                  />
                </div>
                {/* Summary */}
                <div className="grn-summary">
                  <div className="grn-summary-title">Items Summary</div>
                  {poItems.map(it => {
                    const row = itemRows[it.id] || {};
                    return (
                      <div key={it.id} className="grn-summary-row">
                        <span className="grn-summary-name">{it.item_name}</span>
                        <span className="grn-summary-qty">
                          Received: <strong>{row.quantity_received || 0}</strong>
                          {row.quantity_rejected > 0 && (
                            <> · Rejected: <strong className="text-red">{row.quantity_rejected}</strong></>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="grn-modal-ft">
              {step > 1 ? (
                <button className="grn-btn-cancel" onClick={() => setStep(s => s - 1)}>
                  <ChevronLeft size={14} /> Back
                </button>
              ) : (
                <button className="grn-btn-cancel" onClick={() => setShowModal(false)}>Cancel</button>
              )}
              {step < 3 ? (
                <button
                  className="grn-btn-primary"
                  disabled={step === 2 && !step2Valid}
                  onClick={() => setStep(s => s + 1)}
                >
                  Next <ChevronRight size={14} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="grn-btn-primary"
                  onClick={handleSave}
                  disabled={saving || !details.received_date || !details.warehouse_id}
                >
                  {saving ? 'Creating…' : 'Create GRN'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
