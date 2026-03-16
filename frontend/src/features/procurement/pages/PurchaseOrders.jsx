import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, ShoppingCart, ChevronDown } from 'lucide-react';
import api from '@/services/api/client';
import './PurchaseOrders.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtFull = n =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const calcLine = line => {
  const base = (parseFloat(line.quantity) || 0) * (parseFloat(line.unit_price) || 0);
  const gst  = base * (parseFloat(line.gst_rate) || 0) / 100;
  return { ...line, taxable_amount: base, gst_amount: gst, amount: base + gst };
};

const STATUS_COLOR = {
  draft:    { bg: '#f3f4f6', color: '#6b7280' },
  sent:     { bg: '#eef2ff', color: '#4338ca' },
  partial:  { bg: '#fef3c7', color: '#92400e' },
  received: { bg: '#f0fdf4', color: '#15803d' },
  cancelled:{ bg: '#fef2f2', color: '#dc2626' },
};
const sc = s => STATUS_COLOR[(s || '').toLowerCase()] || STATUS_COLOR.draft;

const SAMPLE_POS = [
  { id: 1, po_number: 'PO-2024-001', supplier_name: 'Tata Steel Ltd',       order_date: '2024-11-01', expected_date: '2024-11-15', total_amount: 185000, status: 'Received', items_count: 3 },
  { id: 2, po_number: 'PO-2024-002', supplier_name: 'ABC Packaging Co',     order_date: '2024-11-10', expected_date: '2024-11-25', total_amount: 42000,  status: 'Sent',     items_count: 2 },
  { id: 3, po_number: 'PO-2024-003', supplier_name: 'National Electricals', order_date: '2024-11-20', expected_date: '2024-12-05', total_amount: 96500,  status: 'Partial',  items_count: 5 },
  { id: 4, po_number: 'PO-2024-004', supplier_name: 'Lubes & More Pvt Ltd', order_date: '2024-11-28', expected_date: '2024-12-10', total_amount: 18200,  status: 'Draft',    items_count: 1 },
];

const SAMPLE_SUPPLIERS = [
  { id: 1, name: 'Tata Steel Ltd' },
  { id: 2, name: 'ABC Packaging Co' },
  { id: 3, name: 'National Electricals' },
  { id: 4, name: 'Lubes & More Pvt Ltd' },
];

const SAMPLE_ITEMS = [
  { id: 1, name: 'Steel Rods 12mm',   sku: 'SKU-005', unit: 'kg' },
  { id: 2, name: 'Ball Bearings 20mm',sku: 'SKU-001', unit: 'pcs' },
  { id: 3, name: 'Packing Tape 48mm', sku: 'SKU-003', unit: 'rolls' },
];

const emptyLine = () => ({ item_id: '', item_name: '', quantity: 1, unit_price: '', gst_rate: 18, taxable_amount: 0, gst_amount: 0, amount: 0 });
const emptyForm = () => ({
  supplier_id: '', supplier_name: '', order_date: new Date().toISOString().slice(0, 10),
  expected_date: '', notes: '', lines: [emptyLine()],
});

export default function PurchaseOrders() {
  const [pos,       setPos]       = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [invItems,  setInvItems]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fStatus,   setFStatus]   = useState('');
  const [drawer,    setDrawer]    = useState(null);   // null | 'create' | po-obj
  const [detail,    setDetail]    = useState(null);
  const [form,      setForm]      = useState(emptyForm());
  const [submitting,setSubmitting]= useState(false);
  const [toast,     setToast]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (fStatus) params.status = fStatus;
    if (search)  params.search = search;
    const [posRes, suppRes, itemsRes] = await Promise.allSettled([
      api.get('/procurement/purchase-orders', { params }),
      api.get('/procurement/purchase-orders/suppliers').catch(() => api.get('/inventory/items')),
      api.get('/inventory/items'),
    ]);
    const rawPos  = posRes.status  === 'fulfilled' ? (posRes.value.data.orders || posRes.value.data) : [];
    setPos(Array.isArray(rawPos) && rawPos.length ? rawPos : SAMPLE_POS);

    const rawSupp = suppRes.status === 'fulfilled' ? (suppRes.value.data.suppliers || suppRes.value.data) : [];
    setSuppliers(Array.isArray(rawSupp) && rawSupp.length ? rawSupp : SAMPLE_SUPPLIERS);

    const rawItems= itemsRes.status=== 'fulfilled' ? (itemsRes.value.data.items || itemsRes.value.data) : [];
    setInvItems(Array.isArray(rawItems) && rawItems.length ? rawItems : SAMPLE_ITEMS);

    setLoading(false);
  }, [fStatus, search]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async po => {
    try {
      const r = await api.get(`/procurement/purchase-orders/${po.id}`);
      setDetail(r.data.order || r.data);
    } catch { setDetail(po); }
    setDrawer('detail');
  };

  const updateLine = (idx, field, value) => {
    setForm(f => {
      const lines = f.lines.map((l, i) => i === idx ? calcLine({ ...l, [field]: value }) : l);
      return { ...f, lines };
    });
  };

  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }));
  const removeLine = idx => setForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }));

  const totals = form.lines.reduce((acc, l) => ({
    taxable: acc.taxable + (l.taxable_amount || 0),
    gst:     acc.gst     + (l.gst_amount || 0),
    total:   acc.total   + (l.amount || 0),
  }), { taxable: 0, gst: 0, total: 0 });

  const handleCreate = async () => {
    if (!form.supplier_id && !form.supplier_name) return showToast('Select a supplier', 'error');
    setSubmitting(true);
    try {
      await api.post('/procurement/purchase-orders', { ...form, total_amount: totals.total });
      showToast('Purchase order created');
      setDrawer(null);
      setForm(emptyForm());
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to create PO', 'error');
    } finally { setSubmitting(false); }
  };

  const handleReceive = async po => {
    try {
      await api.put(`/procurement/purchase-orders/${po.id}/status`, { status: 'Received' });
      showToast('PO marked as Received');
      setDrawer(null);
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to update', 'error');
    }
  };

  const displayed = pos.filter(p => {
    const q = search.toLowerCase();
    return (!q || p.po_number?.toLowerCase().includes(q) || p.supplier_name?.toLowerCase().includes(q))
        && (!fStatus || p.status?.toLowerCase() === fStatus.toLowerCase());
  });

  return (
    <div className="po-root">

      {toast && <div className={`po-toast po-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="po-header">
        <div>
          <h2 className="po-title">Purchase Orders</h2>
          <p className="po-sub">{displayed.length} PO{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="po-header-r">
          <button className="po-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="po-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer('create'); }}>
            <Plus size={14} /> New PO
          </button>
        </div>
      </div>

      {/* filters */}
      <div className="po-filters">
        <div className="po-search">
          <Search size={14} />
          <input placeholder="Search PO number or supplier…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="po-select" value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">All Status</option>
          {['Draft','Sent','Partial','Received','Cancelled'].map(s => <option key={s}>{s}</option>)}
        </select>
        {(search || fStatus) && (
          <button className="po-clear-btn" onClick={() => { setSearch(''); setFStatus(''); }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* table */}
      {loading ? (
        <div className="po-loading"><div className="po-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="po-empty">
          <ShoppingCart size={40} color="#d1d5db" />
          <p>No purchase orders found</p>
        </div>
      ) : (
        <div className="po-table-wrap">
          <table className="po-table">
            <thead>
              <tr>
                <th>PO #</th><th>Supplier</th><th>Order Date</th>
                <th>Expected</th><th>Amount</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(po => {
                const c = sc(po.status);
                return (
                  <tr key={po.id} className="po-row" onClick={() => openDetail(po)}>
                    <td className="po-mono">{po.po_number}</td>
                    <td className="po-supplier">{po.supplier_name}</td>
                    <td>{po.order_date ? new Date(po.order_date).toLocaleDateString('en-IN') : '—'}</td>
                    <td>{po.expected_date ? new Date(po.expected_date).toLocaleDateString('en-IN') : '—'}</td>
                    <td className="po-amount">{fmtFull(po.total_amount)}</td>
                    <td><span className="po-badge" style={{ background: c.bg, color: c.color }}>{po.status}</span></td>
                    <td onClick={e => e.stopPropagation()}>
                      {(po.status === 'Sent' || po.status === 'Partial') && (
                        <button className="po-recv-btn" onClick={() => handleReceive(po)}>Receive</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create PO Drawer ── */}
      {drawer === 'create' && (
        <div className="po-overlay" onClick={() => setDrawer(null)}>
          <div className="po-drawer po-drawer-wide" onClick={e => e.stopPropagation()}>
            <div className="po-drawer-hd">
              <h3>New Purchase Order</h3>
              <button className="po-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="po-drawer-body">
              {/* supplier + dates */}
              <div className="po-row2">
                <div className="po-field">
                  <label>Supplier *</label>
                  <select value={form.supplier_id}
                    onChange={e => {
                      const sup = suppliers.find(s => String(s.id) === e.target.value);
                      setForm(f => ({ ...f, supplier_id: e.target.value, supplier_name: sup?.name || '' }));
                    }}>
                    <option value="">Select supplier…</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="po-field">
                  <label>Order Date</label>
                  <input type="date" value={form.order_date} onChange={e => setForm(f => ({ ...f, order_date: e.target.value }))} />
                </div>
              </div>
              <div className="po-row2">
                <div className="po-field">
                  <label>Expected Delivery</label>
                  <input type="date" value={form.expected_date} onChange={e => setForm(f => ({ ...f, expected_date: e.target.value }))} />
                </div>
                <div className="po-field">
                  <label>Notes</label>
                  <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
                </div>
              </div>

              {/* line items */}
              <div className="po-lines-hd">
                <span>Line Items</span>
                <button className="po-add-line-btn" onClick={addLine}><Plus size={13} /> Add Line</button>
              </div>
              <div className="po-lines-wrap">
                <table className="po-lines-table">
                  <thead>
                    <tr>
                      <th>Item</th><th>Qty</th><th>Rate (₹)</th><th>GST %</th>
                      <th>Taxable</th><th>GST Amt</th><th>Total</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((line, idx) => (
                      <tr key={idx}>
                        <td>
                          <select value={line.item_id}
                            onChange={e => {
                              const it = invItems.find(i => String(i.id) === e.target.value);
                              updateLine(idx, 'item_id', e.target.value);
                              if (it) updateLine(idx, 'item_name', it.name);
                            }}
                            style={{ width: 150, padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 }}>
                            <option value="">Select…</option>
                            {invItems.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                          </select>
                        </td>
                        <td><input type="number" min="1" value={line.quantity} onChange={e => updateLine(idx, 'quantity', e.target.value)} className="po-line-input" style={{ width: 60 }} /></td>
                        <td><input type="number" min="0" step="0.01" value={line.unit_price} onChange={e => updateLine(idx, 'unit_price', e.target.value)} className="po-line-input" style={{ width: 80 }} /></td>
                        <td>
                          <select value={line.gst_rate} onChange={e => updateLine(idx, 'gst_rate', e.target.value)} className="po-line-select">
                            {[0,5,12,18,28].map(r => <option key={r}>{r}</option>)}
                          </select>
                        </td>
                        <td className="po-line-amt">{fmtFull(line.taxable_amount)}</td>
                        <td className="po-line-amt">{fmtFull(line.gst_amount)}</td>
                        <td className="po-line-amt po-line-total">{fmtFull(line.amount)}</td>
                        <td>
                          {form.lines.length > 1 && (
                            <button onClick={() => removeLine(idx)} className="po-del-line"><X size={12} /></button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* totals */}
              <div className="po-totals">
                <div className="po-total-row"><span>Taxable Amount</span><span>{fmtFull(totals.taxable)}</span></div>
                <div className="po-total-row"><span>GST</span><span>{fmtFull(totals.gst)}</span></div>
                <div className="po-total-row po-grand-total"><span>Total</span><span>{fmtFull(totals.total)}</span></div>
              </div>
            </div>
            <div className="po-drawer-ft">
              <button className="po-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="po-btn-primary" onClick={handleCreate} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create PO'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail Drawer ── */}
      {drawer === 'detail' && detail && (
        <div className="po-overlay" onClick={() => { setDrawer(null); setDetail(null); }}>
          <div className="po-drawer po-drawer-wide" onClick={e => e.stopPropagation()}>
            <div className="po-drawer-hd">
              <div>
                <span className="po-mono">{detail.po_number}</span>
                <h3 style={{ margin: '4px 0 0', fontSize: 16 }}>{detail.supplier_name}</h3>
              </div>
              <button className="po-icon-btn" onClick={() => { setDrawer(null); setDetail(null); }}><X size={16} /></button>
            </div>
            <div className="po-drawer-body">
              <div className="po-detail-meta-row">
                <span className="po-badge" style={{ background: sc(detail.status).bg, color: sc(detail.status).color }}>{detail.status}</span>
                <span className="po-meta-item">Order: {detail.order_date ? new Date(detail.order_date).toLocaleDateString('en-IN') : '—'}</span>
                <span className="po-meta-item">Expected: {detail.expected_date ? new Date(detail.expected_date).toLocaleDateString('en-IN') : '—'}</span>
              </div>
              {detail.notes && <p className="po-detail-notes">{detail.notes}</p>}

              {(detail.lines || detail.items || []).length > 0 && (
                <div className="po-lines-wrap">
                  <table className="po-lines-table">
                    <thead>
                      <tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST%</th><th>Total</th></tr>
                    </thead>
                    <tbody>
                      {(detail.lines || detail.items || []).map((l, i) => (
                        <tr key={i}>
                          <td>{l.item_name || l.name}</td>
                          <td>{l.quantity}</td>
                          <td>{fmtFull(l.unit_price)}</td>
                          <td>{l.gst_rate}%</td>
                          <td className="po-line-total">{fmtFull(l.amount || l.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="po-totals">
                <div className="po-grand-total po-total-row">
                  <span>Total Amount</span><span>{fmtFull(detail.total_amount)}</span>
                </div>
              </div>
            </div>
            <div className="po-drawer-ft">
              {(detail.status === 'Sent' || detail.status === 'Partial') && (
                <button className="po-btn-primary" onClick={() => handleReceive(detail)}>
                  Mark as Received
                </button>
              )}
              <button className="po-btn-outline" onClick={() => { setDrawer(null); setDetail(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
