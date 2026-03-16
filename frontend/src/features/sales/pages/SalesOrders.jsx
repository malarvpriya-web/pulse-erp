import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, X, ShoppingCart, Truck } from 'lucide-react';
import api from '@/services/api/client';
import './SalesOrders.css';

const SAMPLE = [
  { id: 1, orderNumber: 'SO-001', customerName: 'Wipro Technologies', orderDate: '2026-03-13', deliveryDate: '2026-03-28', totalAmount: 142000, quotationRef: 'QT-002', fulfillmentStatus: 'Partial', status: 'Confirmed' },
  { id: 2, orderNumber: 'SO-002', customerName: 'Mphasis Ltd', orderDate: '2026-03-16', deliveryDate: '2026-04-05', totalAmount: 376000, quotationRef: 'QT-005', fulfillmentStatus: 'Pending', status: 'Confirmed' },
  { id: 3, orderNumber: 'SO-003', customerName: 'Tech Mahindra', orderDate: '2026-02-20', deliveryDate: '2026-03-10', totalAmount: 218000, quotationRef: null, fulfillmentStatus: 'Complete', status: 'Delivered' },
  { id: 4, orderNumber: 'SO-004', customerName: 'L&T Infotech', orderDate: '2026-01-15', deliveryDate: '2026-02-15', totalAmount: 495000, quotationRef: null, fulfillmentStatus: 'Complete', status: 'Closed' },
  { id: 5, orderNumber: 'SO-005', customerName: 'Cognizant India', orderDate: '2026-03-17', deliveryDate: '2026-04-10', totalAmount: 320000, quotationRef: null, fulfillmentStatus: 'Pending', status: 'Draft' },
];

const SAMPLE_CUSTOMERS = [
  { id: 1, name: 'Infosys Ltd' }, { id: 2, name: 'Wipro Technologies' }, { id: 3, name: 'TCS India' },
  { id: 4, name: 'Tech Mahindra' }, { id: 5, name: 'Mphasis Ltd' }, { id: 6, name: 'Cognizant India' },
];

const TABS = ['All', 'Draft', 'Confirmed', 'Delivered', 'Closed', 'Cancelled'];
const STATUS_COLORS = { Draft: '#f3f4f6', Confirmed: '#dbeafe', Delivered: '#dcfce7', Closed: '#e0e7ff', Cancelled: '#fee2e2' };
const STATUS_TEXT   = { Draft: '#374151', Confirmed: '#1d4ed8', Delivered: '#15803d', Closed: '#4338ca', Cancelled: '#991b1b' };
const FULFILL_COLORS = { Pending: '#fef3c7', Partial: '#dbeafe', Complete: '#dcfce7' };
const FULFILL_TEXT   = { Pending: '#92400e', Partial: '#1d4ed8', Complete: '#15803d' };
const fmt = n => `₹${Number(n).toLocaleString('en-IN')}`;
const BLANK_LINE = { description: '', quantity: 1, unitPrice: '' };
const BLANK_FORM = { customerId: '', quotationRef: '', orderDate: new Date().toISOString().split('T')[0], deliveryDate: '', notes: '' };

export default function SalesOrders() {
  const [orders, setOrders]       = useState(SAMPLE);
  const [customers, setCustomers] = useState(SAMPLE_CUSTOMERS);
  const [loading, setLoading]     = useState(false);
  const [fTab, setFTab]           = useState('All');
  const [search, setSearch]       = useState('');
  const [drawer, setDrawer]       = useState(null);
  const [form, setForm]           = useState(BLANK_FORM);
  const [lines, setLines]         = useState([{ ...BLANK_LINE }]);
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    const [o, c] = await Promise.allSettled([
      api.get('/sales/orders', { params: fTab !== 'All' ? { status: fTab } : {} }),
      api.get('/finance/parties', { params: { type: 'customer' } }),
    ]);
    if (o.status === 'fulfilled') {
      const raw = o.value.data?.data ?? o.value.data;
      setOrders(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } else setOrders(SAMPLE);
    if (c.status === 'fulfilled') {
      const raw = c.value.data?.data ?? c.value.data;
      if (Array.isArray(raw) && raw.length) setCustomers(raw);
    }
    setLoading(false);
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const filtered = orders.filter(o =>
    (fTab === 'All' || o.status === fTab) &&
    (o.orderNumber?.toLowerCase().includes(search.toLowerCase()) ||
     o.customerName?.toLowerCase().includes(search.toLowerCase()))
  );

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? orders.length : orders.filter(o => o.status === t).length
  }), {});

  const total = lines.reduce((s, l) => s + (parseFloat(l.quantity || 0) * parseFloat(l.unitPrice || 0)), 0);
  const addLine = () => setLines(prev => [...prev, { ...BLANK_LINE }]);
  const removeLine = i => setLines(prev => prev.filter((_, idx) => idx !== i));
  const updateLine = (i, k, v) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, [k]: v } : l));

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/sales/orders', { ...form, items: lines, totalAmount: total });
      showToast('Sales Order created!');
      load();
    } catch {
      const cust = customers.find(c => c.id === parseInt(form.customerId));
      const no = { id: Date.now(), orderNumber: `SO-${String(orders.length + 1).padStart(3,'0')}`, customerName: cust?.name || 'Customer', orderDate: form.orderDate, deliveryDate: form.deliveryDate, totalAmount: total, quotationRef: form.quotationRef || null, fulfillmentStatus: 'Pending', status: 'Draft' };
      setOrders(prev => [no, ...prev]);
      showToast('Sales Order saved (offline)');
    }
    setDrawer(null); setForm(BLANK_FORM); setLines([{ ...BLANK_LINE }]); setSaving(false);
  };

  const markDelivered = async (id) => {
    try { await api.put(`/sales/orders/${id}/status`, { status: 'Delivered' }); }
    catch { /* optimistic */ }
    setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'Delivered', fulfillmentStatus: 'Complete' } : o));
    showToast('Order marked as delivered!');
  };

  return (
    <div className="so-root">
      {toast && <div className={`so-toast so-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="so-header">
        <div>
          <h1 className="so-title">Sales Orders</h1>
          <p className="so-sub">Manage confirmed orders and fulfilment</p>
        </div>
        <button className="so-btn-primary" onClick={() => { setForm(BLANK_FORM); setLines([{ ...BLANK_LINE }]); setDrawer('create'); }}>
          <Plus size={15} /> New Order
        </button>
      </div>

      <div className="so-filters">
        <div className="so-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search orders…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="so-tabs">
          {TABS.map(t => (
            <button key={t} className={`so-tab ${fTab === t ? 'so-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="so-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="so-loading"><div className="so-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="so-empty"><ShoppingCart size={32} color="#d1d5db" /><p>No sales orders found</p></div>
      ) : (
        <div className="so-table-wrap">
          <table className="so-table">
            <thead>
              <tr><th>Order #</th><th>Customer</th><th>Order Date</th><th>Delivery Date</th><th>Quotation Ref</th><th>Amount</th><th>Fulfillment</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map(o => (
                <tr key={o.id} className="so-row">
                  <td><span className="so-num">{o.orderNumber}</span></td>
                  <td>{o.customerName}</td>
                  <td>{new Date(o.orderDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td>{new Date(o.deliveryDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td><span className="so-ref">{o.quotationRef || '—'}</span></td>
                  <td><span className="so-amount">{fmt(o.totalAmount)}</span></td>
                  <td><span className="so-badge" style={{ background: FULFILL_COLORS[o.fulfillmentStatus], color: FULFILL_TEXT[o.fulfillmentStatus] }}>{o.fulfillmentStatus}</span></td>
                  <td><span className="so-badge" style={{ background: STATUS_COLORS[o.status], color: STATUS_TEXT[o.status] }}>{o.status}</span></td>
                  <td>
                    {o.status === 'Confirmed' && (
                      <button className="so-deliver-btn" onClick={() => markDelivered(o.id)}><Truck size={13} /> Mark Delivered</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="so-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="so-drawer">
            <div className="so-drawer-hd">
              <h3>New Sales Order</h3>
              <button className="so-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="so-drawer-body" onSubmit={handleSubmit}>
              <div className="so-row2">
                <div className="so-field">
                  <label>Customer <span className="so-req">*</span></label>
                  <select value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))} required>
                    <option value="">Select customer</option>
                    {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="so-field">
                  <label>Quotation Ref</label>
                  <input value={form.quotationRef} onChange={e => setForm(f => ({ ...f, quotationRef: e.target.value }))} placeholder="e.g. QT-001" />
                </div>
              </div>
              <div className="so-row2">
                <div className="so-field">
                  <label>Order Date <span className="so-req">*</span></label>
                  <input type="date" value={form.orderDate} onChange={e => setForm(f => ({ ...f, orderDate: e.target.value }))} required />
                </div>
                <div className="so-field">
                  <label>Expected Delivery <span className="so-req">*</span></label>
                  <input type="date" value={form.deliveryDate} onChange={e => setForm(f => ({ ...f, deliveryDate: e.target.value }))} required />
                </div>
              </div>

              <div className="so-items-section">
                <div className="so-items-hd">
                  <span>Line Items</span>
                  <button type="button" className="so-add-line-btn" onClick={addLine}><Plus size={12} /> Add Line</button>
                </div>
                {lines.map((line, i) => (
                  <div key={i} className="so-line-row">
                    <input placeholder="Description" value={line.description} onChange={e => updateLine(i, 'description', e.target.value)} className="so-line-desc" />
                    <input type="number" min="1" placeholder="Qty" value={line.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)} className="so-line-qty" />
                    <input type="number" min="0" placeholder="₹ Unit Price" value={line.unitPrice} onChange={e => updateLine(i, 'unitPrice', e.target.value)} className="so-line-price" />
                    <span className="so-line-total">{fmt((parseFloat(line.quantity || 0) * parseFloat(line.unitPrice || 0)).toFixed(0))}</span>
                    {lines.length > 1 && <button type="button" className="so-remove-btn" onClick={() => removeLine(i)}><X size={12} /></button>}
                  </div>
                ))}
                <div className="so-items-total"><span>Total</span><strong>{fmt(total.toFixed(0))}</strong></div>
              </div>

              <div className="so-field">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional notes…" />
              </div>
              <div className="so-drawer-ft">
                <button type="button" className="so-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="so-btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create Order'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
