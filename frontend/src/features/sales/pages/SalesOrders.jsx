import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import {
  Plus, Search, ShoppingCart, X, Receipt, Users, RefreshCw,
  CheckCircle, Truck, PackageCheck, FileText, XCircle,
} from 'lucide-react';
import './SalesOrders.css';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';

const fmtAmt   = n => `₹${Number(n||0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtL     = n => {
  const v = Number(n || 0);
  return v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${v.toLocaleString('en-IN')}`;
};
const fmtDate  = d => {
  if (!d) return '—';
  const s = d.toString().slice(0, 10);
  return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const STATUS_COLOR = {
  draft:      { bg: '#f3f4f6', color: '#374151' },
  confirmed:  { bg: '#dbeafe', color: '#1e40af' },
  pending:    { bg: '#fef3c7', color: '#92400e' },
  dispatched: { bg: '#ede9fe', color: '#5b21b6' },
  delivered:  { bg: '#d1fae5', color: '#065f46' },
  invoiced:   { bg: '#ccfbf1', color: '#0f766e' },
  cancelled:  { bg: '#fee2e2', color: '#991b1b' },
};

const ALL_STATUSES = ['All', 'draft', 'confirmed', 'pending', 'dispatched', 'delivered', 'invoiced', 'cancelled'];
const BLANK_ITEM   = () => ({ item_description: '', quantity: 1, rate: 0, tax_percentage: 18 });

function StatusBadge({ status }) {
  const s = (status || 'draft').toLowerCase();
  const { bg, color } = STATUS_COLOR[s] || { bg: '#f3f4f6', color: '#374151' };
  return <span className="so-badge" style={{ background: bg, color, textTransform: 'capitalize' }}>{s}</span>;
}

function GstBreakdown({ items, supplyType }) {
  if (!items.length) return null;
  const isInter = supplyType === 'inter';
  const taxable = items.reduce((s, it) => s + (Number(it.quantity)||0) * (Number(it.rate)||0), 0);
  const slabs = {};
  items.forEach(it => {
    const pct = Number(it.tax_percentage || 0);
    if (!slabs[pct]) slabs[pct] = 0;
    slabs[pct] += Number(it.tax_amount || 0);
  });
  const totalTax = Object.values(slabs).reduce((s, v) => s + v, 0);
  const grand = taxable + totalTax;
  return (
    <div className="so-gst-box">
      <div className="so-gst-title">GST Breakdown ({isInter ? 'Inter-state — IGST' : 'Intra-state — CGST+SGST'})</div>
      <div className="so-gst-row"><span>Taxable Value</span><span>{fmtAmt(taxable)}</span></div>
      {Object.entries(slabs)
        .filter(([pct]) => Number(pct) > 0)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([pct, tax]) => (
          <div key={pct}>
            <div className="so-gst-row so-gst-slab"><span>GST @ {pct}%</span><span>{fmtAmt(tax)}</span></div>
            {isInter ? (
              <div className="so-gst-row so-gst-indent"><span>IGST @ {pct}%</span><span>{fmtAmt(tax)}</span></div>
            ) : (
              <>
                <div className="so-gst-row so-gst-indent"><span>CGST @ {Number(pct)/2}%</span><span>{fmtAmt(tax/2)}</span></div>
                <div className="so-gst-row so-gst-indent"><span>SGST @ {Number(pct)/2}%</span><span>{fmtAmt(tax/2)}</span></div>
              </>
            )}
          </div>
        ))
      }
      <div className="so-gst-row so-gst-total"><span>Grand Total</span><span>{fmtAmt(grand)}</span></div>
    </div>
  );
}

function DetailDrawer({ order, items, invoice, loading, onClose, onAction, actioning, readOnly }) {
  const s = (order.status || order.order_status || 'draft').toLowerCase();

  return (
    <div className="so-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="so-drawer">
        <div className="so-drawer-hd">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3>{order.order_number || `SO-${String(order.id).padStart(4,'0')}`}</h3>
            <StatusBadge status={s} />
          </div>
          <button className="so-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="so-drawer-body">
          <div>
            <div className="so-detail-section">Order Details</div>
            <div className="so-detail-grid">
              <div className="so-detail-item"><span>Customer</span><strong>{order.customer_name || '—'}</strong></div>
              <div className="so-detail-item"><span>Order Value</span><strong style={{ color: '#6B3FDB' }}>{fmtL(order.total_amount)}</strong></div>
              <div className="so-detail-item"><span>Order Date</span><strong>{fmtDate(order.order_date)}</strong></div>
              <div className="so-detail-item"><span>Delivery Date</span><strong>{fmtDate(order.delivery_date)}</strong></div>
              {order.dispatched_at && (
                <div className="so-detail-item"><span>Dispatched</span><strong>{fmtDate(order.dispatched_at)}</strong></div>
              )}
              {order.delivered_at && (
                <div className="so-detail-item"><span>Delivered</span><strong>{fmtDate(order.delivered_at)}</strong></div>
              )}
              {order.tracking_number && (
                <div className="so-detail-item" style={{ gridColumn: '1/-1' }}>
                  <span>Tracking</span>
                  <strong>{order.carrier ? `${order.carrier} — ` : ''}{order.tracking_number}</strong>
                </div>
              )}
            </div>
            {order.notes && (
              <div style={{ marginTop: 10, fontSize: 13, color: '#374151', background: '#f9fafb', borderRadius: 6, padding: '8px 12px', lineHeight: 1.5 }}>
                {order.notes}
              </div>
            )}
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 20 }}><div className="so-spinner" /></div>
          ) : items.length > 0 ? (
            <div>
              <div className="so-detail-section">Line Items</div>
              <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8f9fb' }}>
                      {['Item', 'Qty', 'Rate', 'Tax%', 'Subtotal', 'Tax', 'Total'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => {
                      const sub = (Number(it.quantity)||0) * (Number(it.rate)||0);
                      return (
                        <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 10px', color: '#111827' }}>{it.item_description || '—'}</td>
                          <td style={{ padding: '8px 10px', color: '#374151' }}>{it.quantity}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>₹{Number(it.rate||0).toLocaleString('en-IN')}</td>
                          <td style={{ padding: '8px 10px', color: '#6b7280' }}>{it.tax_percentage}%</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>₹{sub.toLocaleString('en-IN')}</td>
                          <td style={{ padding: '8px 10px', color: '#d97706', whiteSpace: 'nowrap' }}>₹{Number(it.tax_amount||0).toLocaleString('en-IN')}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 700, color: '#111827', whiteSpace: 'nowrap' }}>₹{Number(it.total||0).toLocaleString('en-IN')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <GstBreakdown items={items} supplyType={order.supply_type || 'intra'} />
            </div>
          ) : (
            <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>No line items recorded.</div>
          )}

          <div>
            <div className="so-detail-section" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Receipt size={12} />Linked Invoice
            </div>
            {invoice ? (
              <div className="so-invoice-card">
                <div>
                  <div style={{ fontWeight: 700, color: '#111827', fontSize: 13 }}>{invoice.invoice_number}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    {fmtDate(invoice.created_at)} &middot; {fmtL(invoice.total_amount)}
                  </div>
                </div>
                <StatusBadge status={invoice.status} />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>No invoice linked yet.</div>
            )}
          </div>
        </div>

        {/* Action footer */}
        <div className="so-drawer-ft">
          {!readOnly && <>
          {s === 'draft' && (
            <>
              <button className="so-action-btn so-action-confirm" disabled={actioning} onClick={() => onAction('confirm')}>
                <CheckCircle size={13} /> Confirm
              </button>
              <button className="so-action-btn so-action-cancel" disabled={actioning} onClick={() => onAction('cancel')}>
                <XCircle size={13} /> Cancel
              </button>
            </>
          )}
          {s === 'confirmed' && (
            <>
              <button className="so-action-btn so-action-dispatch" disabled={actioning} onClick={() => onAction('dispatch')}>
                <Truck size={13} /> Dispatch
              </button>
              <button className="so-action-btn so-action-cancel" disabled={actioning} onClick={() => onAction('cancel')}>
                <XCircle size={13} /> Cancel
              </button>
            </>
          )}
          {s === 'dispatched' && (
            <button className="so-action-btn so-action-deliver" disabled={actioning} onClick={() => onAction('deliver')}>
              <PackageCheck size={13} /> Mark Delivered
            </button>
          )}
          {s === 'delivered' && !invoice && (
            <button className="so-action-btn so-action-invoice" disabled={actioning} onClick={() => onAction('invoice')}>
              <FileText size={13} /> Create Invoice
            </button>
          )}
          </>}
          {actioning && <span style={{ fontSize: 12, color: '#6b7280' }}>Processing…</span>}
        </div>
      </div>
    </div>
  );
}

function DispatchModal({ orderId, onDone, onClose }) {
  const [form, setForm]         = useState({ carrier: '', tracking_number: '', dispatch_date: new Date().toISOString().split('T')[0] });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr]           = useState('');

  const submit = async e => {
    e.preventDefault();
    setSubmitting(true); setErr('');
    try {
      await api.put(`/sales/orders/${orderId}/dispatch`, form);
      onDone();
    } catch (ex) {
      setErr(ex.response?.data?.error || ex.message);
    } finally { setSubmitting(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#fff', borderRadius: 14, width: 420, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,.2)', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>Dispatch Order</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
        </div>
        {err && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, color: '#dc2626', fontSize: 13 }}>{err}</div>}
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Courier / Carrier</label>
            <input value={form.carrier} onChange={e => setForm(p => ({ ...p, carrier: e.target.value }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }} placeholder="e.g. BlueDart, DTDC" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Tracking Number</label>
            <input value={form.tracking_number} onChange={e => setForm(p => ({ ...p, tracking_number: e.target.value }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }} placeholder="AWB / tracking ID" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Dispatch Date</label>
            <input type="date" value={form.dispatch_date} onChange={e => setForm(p => ({ ...p, dispatch_date: e.target.value }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
            <button type="button" onClick={onClose} className="so-btn-outline">Cancel</button>
            <button type="submit" disabled={submitting} className="so-btn-primary">
              <Truck size={13} /> {submitting ? 'Dispatching…' : 'Confirm Dispatch'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CancelModal({ orderId, onDone, onClose }) {
  const [reason, setReason]         = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr]               = useState('');

  const submit = async e => {
    e.preventDefault();
    if (!reason.trim()) { setErr('Reason is required.'); return; }
    setSubmitting(true); setErr('');
    try {
      await api.patch(`/sales/orders/${orderId}/cancel`, { reason });
      onDone();
    } catch (ex) {
      setErr(ex.response?.data?.error || ex.message);
    } finally { setSubmitting(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#fff', borderRadius: 14, width: 400, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,.2)', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>Cancel Order</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
        </div>
        {err && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, color: '#dc2626', fontSize: 13 }}>{err}</div>}
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Reason for cancellation <span style={{ color: '#ef4444' }}>*</span></label>
            <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" onClick={onClose} className="so-btn-outline">Back</button>
            <button type="submit" disabled={submitting} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? .5 : 1 }}>
              {submitting ? 'Cancelling…' : 'Cancel Order'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CustomerSummaryTab({ summary, loading }) {
  if (loading) return <div className="so-loading"><div className="so-spinner" /></div>;
  if (!summary.length) return (
    <div className="so-empty"><Users size={36} color="#d1d5db" /><p>No customer order data yet.</p></div>
  );
  const totalRev    = summary.reduce((s, c) => s + Number(c.total_value || 0), 0);
  const totalOrders = summary.reduce((s, c) => s + Number(c.total_orders || 0), 0);
  const totalGst    = summary.reduce((s, c) => s + Number(c.total_gst   || 0), 0);
  return (
    <div>
      <div className="so-cust-kpis">
        {[
          { label: 'Customers',     val: summary.length },
          { label: 'Total Revenue', val: fmtL(totalRev) },
          { label: 'Total Orders',  val: totalOrders },
          { label: 'Total GST',     val: fmtL(totalGst) },
        ].map(({ label, val }) => (
          <div key={label} className="so-cust-kpi">
            <div className="so-cust-kpi-val">{val}</div>
            <div className="so-cust-kpi-lbl">{label}</div>
          </div>
        ))}
      </div>
      <div className="so-table-wrap">
        <table className="so-table">
          <thead>
            <tr>
              <th>#</th><th>Customer</th><th>City</th><th>Orders</th>
              <th>Active</th><th>Total Revenue</th><th>Total GST</th><th>Last Order</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((c, i) => (
              <tr key={c.id || i} className="so-row">
                <td style={{ color: '#9ca3af', fontSize: 11 }}>{i + 1}</td>
                <td><span style={{ fontWeight: 700, color: '#111827' }}>{c.customer_name}</span></td>
                <td style={{ color: '#6b7280', fontSize: 12 }}>{c.city || '—'}</td>
                <td style={{ fontWeight: 600, textAlign: 'center' }}>{c.total_orders}</td>
                <td style={{ textAlign: 'center' }}>
                  {c.active_orders > 0
                    ? <span style={{ background: '#d1fae5', color: '#065f46', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{c.active_orders}</span>
                    : <span style={{ color: '#d1d5db' }}>—</span>}
                </td>
                <td className="so-amount">{fmtL(c.total_value)}</td>
                <td style={{ color: '#d97706', fontSize: 12 }}>{fmtL(c.total_gst)}</td>
                <td style={{ color: '#6b7280', fontSize: 12 }}>{fmtDate(c.last_order_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function SalesOrders() {
  const { readOnly } = usePageAccess();
  const [orders,           setOrders]          = useState([]);
  const [stats,            setStats]           = useState({ total: 0, total_value: 0, by_status: {} });
  const [loading,          setLoading]         = useState(false);
  const [search,           setSearch]          = useState('');
  const [statusFilter,     setStatusFilter]    = useState('All');
  const [showForm,         setShowForm]        = useState(false);
  const [customers,        setCustomers]       = useState([]);
  const [submitting,       setSubmitting]      = useState(false);
  const [formError,        setFormError]       = useState('');
  const [form,             setForm]            = useState({
    order_number: '', customer_id: '', customer_name: '',
    order_date: new Date().toISOString().split('T')[0],
    delivery_date: '', notes: '', order_status: 'draft',
  });
  const [items,            setItems]           = useState([BLANK_ITEM()]);
  const [activeTab,        setActiveTab]       = useState('orders');
  const [detailOrder,      setDetailOrder]     = useState(null);
  const [detailItems,      setDetailItems]     = useState([]);
  const [detailInvoice,    setDetailInvoice]   = useState(null);
  const [loadingDetail,    setLoadingDetail]   = useState(false);
  const [actioning,        setActioning]       = useState(false);
  const [customerSummary,  setCustomerSummary] = useState([]);
  const [loadingCustomers, setLoadingCustomers]= useState(false);
  const [showDispatch,     setShowDispatch]    = useState(false);
  const [showCancel,       setShowCancel]      = useState(false);
  const [toast,            setToast]           = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3500);
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/sales/orders'),
      api.get('/sales/orders/stats'),
    ])
      .then(([ordRes, statRes]) => {
        if (!isMounted.current) return;
        setOrders(ordRes.data?.data ?? []);
        setStats(statRes.data?.data ?? { total: 0, total_value: 0, by_status: {} });
      })
      .catch(() => { if (isMounted.current) showToast('Failed to load sales orders', 'error'); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadCustomerSummary = useCallback(() => {
    setLoadingCustomers(true);
    api.get('/sales/orders/customer-summary')
      .then(r => { if (isMounted.current) setCustomerSummary(r.data?.data ?? []); })
      .catch(() => { if (isMounted.current) setCustomerSummary([]); })
      .finally(() => { if (isMounted.current) setLoadingCustomers(false); });
  }, []);

  useEffect(() => {
    if (activeTab === 'customers' && customerSummary.length === 0) loadCustomerSummary();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDetail = async (order) => {
    setDetailOrder(order);
    setDetailItems([]);
    setDetailInvoice(null);
    setLoadingDetail(true);
    try {
      const [itemsRes, invoiceRes] = await Promise.all([
        api.get(`/sales/orders/${order.id}/items`).catch(() => ({ data: [] })),
        api.get(`/sales/orders/${order.id}/linked-invoice`).catch(() => ({ data: null })),
      ]);
      if (!isMounted.current) return;
      setDetailItems(Array.isArray(itemsRes.data) ? itemsRes.data : []);
      setDetailInvoice(invoiceRes.data || null);
    } finally {
      if (isMounted.current) setLoadingDetail(false);
    }
  };

  const handleAction = async (type) => {
    if (!detailOrder) return;
    if (type === 'dispatch') { setShowDispatch(true); return; }
    if (type === 'cancel')   { setShowCancel(true);   return; }

    setActioning(true);
    try {
      if (type === 'confirm') {
        await api.patch(`/sales/orders/${detailOrder.id}/confirm`);
        showToast('Order confirmed.');
      } else if (type === 'deliver') {
        await api.put(`/sales/orders/${detailOrder.id}/deliver`);
        showToast('Marked as delivered.');
      } else if (type === 'invoice') {
        const res = await api.patch(`/sales/orders/${detailOrder.id}/invoice`);
        const invId = res.data?.invoice_id;
        showToast(invId ? `Invoice created in Finance.` : 'Invoiced.');
      }
      setDetailOrder(null);
      load();
    } catch (ex) {
      showToast(ex.response?.data?.error || ex.message, 'error');
    } finally { if (isMounted.current) setActioning(false); }
  };

  const afterDispatch = () => {
    setShowDispatch(false);
    setDetailOrder(null);
    load();
    showToast('Order dispatched.');
  };

  const afterCancel = () => {
    setShowCancel(false);
    setDetailOrder(null);
    load();
    showToast('Order cancelled.');
  };

  const openNew = async () => {
    setFormError('');
    setItems([BLANK_ITEM()]);
    try {
      const r = await api.get('/sales/orders/next-number');
      if (!isMounted.current) return;
      setForm({
        order_number: r.data.number, customer_id: '', customer_name: '',
        order_date: new Date().toISOString().split('T')[0],
        delivery_date: '', notes: '', order_status: 'draft', supply_type: 'intra',
      });
    } catch {
      if (!isMounted.current) return;
      setForm({ order_number: '', customer_id: '', customer_name: '', order_date: new Date().toISOString().split('T')[0], delivery_date: '', notes: '', order_status: 'draft', supply_type: 'intra' });
    }
    if (customers.length === 0) {
      api.get('/finance/parties?type=customer')
        .then(r => { if (isMounted.current) setCustomers(r.data || []); })
        .catch(() => { if (isMounted.current) showToast('Failed to load customers', 'error'); });
    }
    if (!isMounted.current) return;
    setShowForm(true);
  };

  const addItem    = () => setItems(p => [...p, BLANK_ITEM()]);
  const removeItem = i  => setItems(p => p.filter((_, j) => j !== i));
  const updateItem = (i, field, val) => setItems(p => p.map((it, j) => j === i ? { ...it, [field]: val } : it));

  const itemSubtotal = items.reduce((s, it) => s + (parseFloat(it.quantity)||0) * (parseFloat(it.rate)||0), 0);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.customer_id && !form.customer_name) { setFormError('Please select a customer.'); return; }
    setSubmitting(true); setFormError('');
    try {
      const res = await api.post('/sales/orders', form);
      const id = res.data?.data?.id ?? res.data?.id;
      if (id) {
        await Promise.all(
          items.filter(it => it.item_description).map(it => api.post(`/sales/orders/${id}/items`, it))
        );
      }
      if (!isMounted.current) return;
      setShowForm(false);
      load();
      if (activeTab === 'customers') setCustomerSummary([]);
      showToast('Order created successfully.');
    } catch (err) {
      if (!isMounted.current) return;
      setFormError(err.response?.data?.error || err.message || 'Failed to create order.');
    } finally { if (isMounted.current) setSubmitting(false); }
  };

  const filtered = orders.filter(o => {
    const s = (o.status || o.order_status || '').toLowerCase();
    const matchStatus = statusFilter === 'All' || s === statusFilter;
    const matchSearch = !search || [o.order_number, o.customer_name]
      .some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchSearch;
  });

  const bs = stats.by_status || {};

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {readOnly && <ReadOnlyBanner />}
      {/* Toast */}
      {toast && (
        <div className={`so-toast so-toast-${toast.type}`}>{toast.msg}</div>
      )}

      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Sales Orders</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            {stats.total} orders &middot; {fmtL(stats.total_value)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="so-icon-btn" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
          {!readOnly && (
            <button onClick={openNew}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              <Plus size={15} /> New Order
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid #e5e7eb', paddingBottom: 0 }}>
        {[
          { key: 'orders',    label: 'Sales Orders', Icon: ShoppingCart },
          { key: 'customers', label: 'By Customer',  Icon: Users },
        ].map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setActiveTab(key)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              color: activeTab === key ? '#6B3FDB' : '#6b7280',
              borderBottom: activeTab === key ? '2px solid #6B3FDB' : '2px solid transparent',
              marginBottom: -2, transition: 'color .15s' }}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {/* ── Orders Tab ── */}
      {activeTab === 'orders' && (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <div className="so-search" style={{ flex: 1, minWidth: 200 }}>
              <Search size={14} color="#9ca3af" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search order, customer…" />
              {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
            </div>
            <div className="so-tabs">
              {ALL_STATUSES.map(s => {
                const count = s === 'All' ? stats.total : (bs[s.toLowerCase()] ?? 0);
                return (
                  <button key={s} onClick={() => setStatusFilter(s)}
                    className={`so-tab${statusFilter === s ? ' so-tab-active' : ''}`}
                    style={{ textTransform: s === 'All' ? 'none' : 'capitalize' }}>
                    {s}<span className="so-tab-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="so-table-wrap">
            {loading ? (
              <div className="so-loading"><div className="so-spinner" /></div>
            ) : filtered.length === 0 ? (
              <div className="so-empty">
                <ShoppingCart size={36} color="#d1d5db" />
                <p>{search || statusFilter !== 'All' ? 'No orders match your filters.' : 'No sales orders yet.'}</p>
              </div>
            ) : (
              <table className="so-table">
                <thead>
                  <tr>
                    <th>Order #</th><th>Customer</th><th>Items</th>
                    <th>Order Date</th><th>Delivery Date</th>
                    <th>Amount</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(o => {
                    const s = (o.status || o.order_status || 'draft').toLowerCase();
                    return (
                      <tr key={o.id} className="so-row" onClick={() => openDetail(o)} style={{ cursor: 'pointer' }}>
                        <td><span className="so-num">{o.order_number || `SO-${String(o.id).padStart(4,'0')}`}</span></td>
                        <td><span style={{ fontWeight: 600, color: '#111827' }}>{o.customer_name || '—'}</span></td>
                        <td style={{ color: '#6b7280', fontSize: 12, textAlign: 'center' }}>{o.item_count ?? '—'}</td>
                        <td style={{ color: '#374151', fontSize: 12 }}>{fmtDate(o.order_date || o.created_at)}</td>
                        <td style={{ color: '#374151', fontSize: 12 }}>{fmtDate(o.delivery_date)}</td>
                        <td className="so-amount">{fmtL(o.total_amount)}</td>
                        <td><StatusBadge status={s} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── Customer Summary Tab ── */}
      {activeTab === 'customers' && (
        <CustomerSummaryTab summary={customerSummary} loading={loadingCustomers} />
      )}

      {/* ── Detail Drawer ── */}
      {detailOrder && (
        <DetailDrawer
          order={detailOrder}
          items={detailItems}
          invoice={detailInvoice}
          loading={loadingDetail}
          onClose={() => setDetailOrder(null)}
          onAction={handleAction}
          actioning={actioning}
          readOnly={readOnly}
        />
      )}

      {/* ── Dispatch Modal ── */}
      {showDispatch && detailOrder && (
        <DispatchModal
          orderId={detailOrder.id}
          onDone={afterDispatch}
          onClose={() => setShowDispatch(false)}
        />
      )}

      {/* ── Cancel Modal ── */}
      {showCancel && detailOrder && (
        <CancelModal
          orderId={detailOrder.id}
          onDone={afterCancel}
          onClose={() => setShowCancel(false)}
        />
      )}

      {/* ── New Order Modal ── */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => e.target === e.currentTarget && setShowForm(false)}>
          <div style={{ background: '#fff', borderRadius: 16, width: 640, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #e9e4ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#1a1a2e' }}>New Sales Order</div>
                {form.order_number && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{form.order_number}</div>}
              </div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
            </div>

            <form onSubmit={handleSubmit} style={{ padding: 24 }}>
              {formError && (
                <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13 }}>{formError}</div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Customer *</label>
                  {customers.length > 0 ? (
                    <select value={form.customer_id}
                      onChange={e => {
                        const c = customers.find(x => String(x.id) === e.target.value);
                        setForm(p => ({ ...p, customer_id: e.target.value, customer_name: c?.name || '' }));
                      }}
                      required
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, background: '#fff', boxSizing: 'border-box' }}>
                      <option value="">Select customer…</option>
                      {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  ) : (
                    <input value={form.customer_name}
                      onChange={e => setForm(p => ({ ...p, customer_name: e.target.value }))}
                      placeholder="Customer name"
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
                  )}
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Order Date *</label>
                  <input type="date" value={form.order_date} onChange={e => setForm(p => ({ ...p, order_date: e.target.value }))} required
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Delivery Date</label>
                  <input type="date" value={form.delivery_date} onChange={e => setForm(p => ({ ...p, delivery_date: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>GST Type</label>
                  <select value={form.supply_type || 'intra'} onChange={e => setForm(p => ({ ...p, supply_type: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, background: '#fff', boxSizing: 'border-box' }}>
                    <option value="intra">Intra-state (CGST + SGST)</option>
                    <option value="inter">Inter-state (IGST)</option>
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Notes</label>
                  <textarea rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Line Items</span>
                  <button type="button" onClick={addItem} className="so-add-line-btn"><Plus size={12} /> Add Item</button>
                </div>
                <div style={{ border: '1px solid #f0f0f4', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#f5f3ff' }}>
                        {['Description', 'Qty', 'Rate (₹)', 'Tax %', 'Total', ''].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, color: '#6b7280' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #f0f0f4' }}>
                          <td style={{ padding: '6px 8px' }}>
                            <input value={it.item_description} onChange={e => updateItem(i, 'item_description', e.target.value)}
                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }} placeholder="Item description" />
                          </td>
                          <td style={{ padding: '6px 8px', width: 60 }}>
                            <input type="number" min="1" value={it.quantity} onChange={e => updateItem(i, 'quantity', e.target.value)}
                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12 }} />
                          </td>
                          <td style={{ padding: '6px 8px', width: 90 }}>
                            <input type="number" min="0" value={it.rate} onChange={e => updateItem(i, 'rate', e.target.value)}
                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12 }} />
                          </td>
                          <td style={{ padding: '6px 8px', width: 60 }}>
                            <input type="number" min="0" max="100" value={it.tax_percentage} onChange={e => updateItem(i, 'tax_percentage', e.target.value)}
                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12 }} />
                          </td>
                          <td style={{ padding: '6px 8px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
                            ₹{((parseFloat(it.quantity)||0) * (parseFloat(it.rate)||0)).toLocaleString('en-IN')}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {items.length > 1 && (
                              <button type="button" onClick={() => removeItem(i)} className="so-remove-btn"><X size={12} /></button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ textAlign: 'right', marginTop: 8, fontSize: 13, color: '#374151' }}>
                  Subtotal: <strong>₹{itemSubtotal.toLocaleString('en-IN')}</strong>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" onClick={() => setShowForm(false)} className="so-btn-outline">Cancel</button>
                <button type="submit" disabled={submitting} className="so-btn-primary">
                  {submitting ? 'Creating…' : 'Create Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
