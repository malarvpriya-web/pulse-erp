import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/services/api/client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useToast } from '@/context/ToastContext';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const TODAY = new Date().toISOString().split('T')[0];

// ── Shared styles ────────────────────────────────────────────────────────────
const thS = {
  padding: '10px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12,
  color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4',
  whiteSpace: 'nowrap',
};
const tdS = { padding: '10px 14px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };
const cardS = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const tabS  = (a) => ({
  padding: '8px 20px', border: 'none',
  background: a ? '#6B3FDB' : 'transparent',
  color: a ? '#fff' : '#6b7280',
  cursor: 'pointer', borderRadius: 8,
  fontWeight: a ? 600 : 400, fontSize: 14,
});
const btnS = (bg, color) => ({
  padding: '5px 12px', border: 'none', borderRadius: 6,
  background: bg, color, cursor: 'pointer', fontSize: 12, fontWeight: 600,
});
const inputS = {
  width: '100%', padding: '9px 12px', border: '1px solid #e9e4ff',
  borderRadius: 8, fontSize: 13, boxSizing: 'border-box',
};

// ── Status badge config ──────────────────────────────────────────────────────
const STATUS_BADGE = {
  confirmed:  { bg: '#dbeafe', color: '#1e40af', label: 'Ready'      },
  pending:    { bg: '#fef3c7', color: '#92400e', label: 'Pending'    },
  dispatched: { bg: '#ede9fe', color: '#5b21b6', label: 'In Transit' },
};

function StatusBadge({ status, isOverdue }) {
  const cfg = STATUS_BADGE[status] || { bg: '#f3f4f6', color: '#374151', label: status };
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color }}>
        {cfg.label}
      </span>
      {isOverdue && (
        <span style={{ padding: '2px 7px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: '#fee2e2', color: '#dc2626' }}>
          OVERDUE
        </span>
      )}
    </span>
  );
}

// ── Dispatch modal ───────────────────────────────────────────────────────────
function DispatchModal({ order, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ courier_name: '', tracking_number: '', dispatch_date: TODAY });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.put(`/sales/orders/${order.id}/dispatch`, {
        carrier:          form.courier_name,
        tracking_number:  form.tracking_number,
        dispatch_date:    form.dispatch_date,
      });
      onDone();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Dispatch failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700 }}>Dispatch Order</h3>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>{order?.order_number} — {order?.customer_name}</p>

        {[
          { label: 'Courier Name', key: 'courier_name', placeholder: 'BlueDart / DTDC / FedEx…' },
          { label: 'Tracking Number', key: 'tracking_number', placeholder: 'BD123456789' },
        ].map(f => (
          <div key={f.key} style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
            <input
              value={form[f.key]}
              placeholder={f.placeholder}
              onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
              style={inputS}
            />
          </div>
        ))}

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Dispatch Date</label>
          <input
            type="date"
            value={form.dispatch_date}
            onChange={e => setForm(p => ({ ...p, dispatch_date: e.target.value }))}
            style={inputS}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={saving}
            style={{ ...btnS('#6B3FDB', '#fff'), flex: 1, padding: '10px', fontSize: 14 }}>
            {saving ? 'Dispatching…' : 'Dispatch'}
          </button>
          <button onClick={onClose}
            style={{ ...btnS('#f5f3ff', '#6b7280'), flex: 1, padding: '10px', fontSize: 14 }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Credit Limit modal ───────────────────────────────────────────────────────
function CreditLimitModal({ customer, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    credit_limit:      customer?.credit_limit ?? 0,
    credit_terms_days: customer?.credit_terms_days ?? 30,
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.patch(`/sales/fulfilment/credit-control/${customer.id}`, {
        credit_limit:      parseFloat(form.credit_limit) || 0,
        credit_terms_days: parseInt(form.credit_terms_days) || 30,
        is_blocked:        customer?.is_blocked ?? false,
        block_reason:      customer?.block_reason ?? null,
      });
      onDone();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700 }}>Set Credit Limit</h3>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>{customer?.customer}</p>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Credit Limit (₹)</label>
          <input type="number" value={form.credit_limit}
            onChange={e => setForm(p => ({ ...p, credit_limit: e.target.value }))}
            style={inputS} placeholder="500000" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Payment Terms (days)</label>
          <input type="number" value={form.credit_terms_days}
            onChange={e => setForm(p => ({ ...p, credit_terms_days: e.target.value }))}
            style={inputS} placeholder="30" />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={saving}
            style={{ ...btnS('#6B3FDB', '#fff'), flex: 1, padding: '10px', fontSize: 14 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose}
            style={{ ...btnS('#f5f3ff', '#6b7280'), flex: 1, padding: '10px', fontSize: 14 }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, color, sub }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function FulfilmentTracking() {
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState(0);
  const [orders,     setOrders]     = useState([]);
  const [stats,      setStats]      = useState(null);
  const [credit,     setCredit]     = useState([]);
  const [analytics,  setAnalytics]  = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);

  const [dispatchTarget, setDispatchTarget] = useState(null);
  const [creditTarget,   setCreditTarget]   = useState(null);

  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);

    const [r1, r2, r3, r4] = await Promise.allSettled([
      api.get('/sales/fulfilment/delivery-orders', { signal: ctrl.signal }),
      api.get('/sales/fulfilment/stats',           { signal: ctrl.signal }),
      api.get('/sales/fulfilment/credit-control',  { signal: ctrl.signal }),
      api.get('/sales/fulfilment/analytics',       { signal: ctrl.signal }),
    ]);

    if (!ctrl.signal.aborted) {
      setOrders(    r1.status === 'fulfilled' ? (r1.value?.data ?? []) : []);
      setStats(     r2.status === 'fulfilled' ? (r2.value?.data ?? null) : null);
      setCredit(    r3.status === 'fulfilled' ? (r3.value?.data ?? []) : []);
      setAnalytics( r4.status === 'fulfilled' ? (r4.value?.data ?? null) : null);
      if ([r1, r2, r3, r4].every(r => r.status === 'rejected')) {
        setError('Failed to load fulfilment data.');
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const markDelivered = async (id) => {
    try {
      await api.put(`/sales/orders/${id}/deliver`, {});
      toast.success('Order marked as delivered.');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to mark delivered.');
      load();
    }
  };

  const blockCustomer = async (cust, block) => {
    try {
      await api.patch(`/sales/fulfilment/credit-control/${cust.id}`, {
        credit_limit:      parseFloat(cust.credit_limit) || 0,
        credit_terms_days: parseInt(cust.credit_terms_days) || 30,
        is_blocked:        block,
        block_reason:      block ? 'Blocked by credit controller' : null,
      });
      toast.success(block ? 'Customer blocked.' : 'Customer unblocked.');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Action failed.');
      load();
    }
  };

  return (
    <div style={{ padding: '24px', background: '#f5f3ff', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>Fulfilment & Credit Control</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Delivery tracking, credit limits, fulfilment analytics</p>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Pending Dispatch"    value={stats?.pending_dispatch   ?? '—'} color="#1e40af" sub="Confirmed orders" />
        <KpiCard label="In Transit"          value={stats?.in_transit          ?? '—'} color="#5b21b6" sub="Dispatched orders" />
        <KpiCard label="Overdue"             value={stats?.overdue             ?? '—'} color={stats?.overdue > 0 ? '#dc2626' : '#059669'} sub="Past delivery date" />
        <KpiCard label="Delivered This Month" value={stats?.delivered_this_month ?? '—'} color="#059669" sub="Month to date" />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 20, width: 'fit-content' }}>
        {['Delivery Orders', 'Credit Control', 'Fulfilment Analytics'].map((t, i) => (
          <button key={i} style={tabS(tab === i)} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>}
      {error   && <div style={{ padding: 20, color: '#dc2626', background: '#fee2e2', borderRadius: 8, marginBottom: 16 }}>{error}</div>}

      {/* ── Tab 0: Delivery Orders ──────────────────────────────────────────── */}
      {!loading && tab === 0 && (
        <>
          {dispatchTarget && (
            <DispatchModal
              order={dispatchTarget}
              onClose={() => setDispatchTarget(null)}
              onDone={() => { setDispatchTarget(null); load(); }}
            />
          )}

          <div style={cardS}>
            {orders.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
                No confirmed or dispatched orders to display.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Order No', 'Customer', 'Items', 'Value', 'Delivery Date', 'Status', 'Tracking', 'Actions'].map(h => (
                      <th key={h} style={thS}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o, i) => (
                    <tr key={o.id} style={{
                      background: o.is_overdue ? '#fff5f5' : i % 2 === 0 ? '#fff' : '#fafafa',
                    }}>
                      <td style={{ ...tdS, fontWeight: 700, color: '#6B3FDB' }}>{o.order_number}</td>
                      <td style={tdS}>{o.customer_name || '—'}</td>
                      <td style={{ ...tdS, textAlign: 'center' }}>{o.item_count ?? '—'}</td>
                      <td style={tdS}>{fmtL(o.total_amount)}</td>
                      <td style={{ ...tdS, color: o.is_overdue ? '#dc2626' : '#374151' }}>
                        {fmtDate(o.delivery_date)}
                      </td>
                      <td style={tdS}>
                        <StatusBadge status={o.status} isOverdue={o.is_overdue} />
                      </td>
                      <td style={{ ...tdS, fontSize: 12 }}>
                        {o.carrier || o.tracking_number
                          ? <span style={{ color: '#6B3FDB' }}>{o.carrier}{o.carrier && o.tracking_number ? ' · ' : ''}{o.tracking_number}</span>
                          : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>
                      <td style={{ ...tdS }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {o.status === 'confirmed' && (
                            <button onClick={() => setDispatchTarget(o)}
                              style={btnS('#6B3FDB', '#fff')}>Dispatch</button>
                          )}
                          {o.status === 'dispatched' && (
                            <button onClick={() => markDelivered(o.id)}
                              style={btnS('#d1fae5', '#065f46')}>Mark Delivered</button>
                          )}
                          <button onClick={() => navigate('/SalesOrders')}
                            style={btnS('#f3f4f6', '#374151')}>
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── Tab 1: Credit Control ───────────────────────────────────────────── */}
      {!loading && tab === 1 && (
        <>
          {creditTarget && (
            <CreditLimitModal
              customer={creditTarget}
              onClose={() => setCreditTarget(null)}
              onDone={() => { setCreditTarget(null); load(); }}
            />
          )}

          <div style={cardS}>
            {credit.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
                No customers found.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Customer', 'Credit Limit', 'Open Orders', 'Outstanding Inv.', 'Available Credit', 'Status', 'Actions'].map(h => (
                      <th key={h} style={thS}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {credit.map((c, i) => {
                    const avail  = parseFloat(c.available_credit || 0);
                    const statusBadge = c.credit_status === 'exceeded'
                      ? { bg: '#fee2e2', color: '#dc2626', label: 'Exceeded' }
                      : c.credit_status === 'no_limit'
                      ? { bg: '#f3f4f6', color: '#6b7280', label: 'No Limit Set' }
                      : { bg: '#d1fae5', color: '#065f46', label: 'OK' };

                    return (
                      <tr key={c.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ ...tdS, fontWeight: 600 }}>
                          {c.customer}
                          {c.is_blocked && (
                            <span style={{ marginLeft: 6, padding: '1px 6px', background: '#fee2e2', color: '#dc2626', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>BLOCKED</span>
                          )}
                        </td>
                        <td style={tdS}>{c.credit_status === 'no_limit' ? '—' : fmtL(c.credit_limit)}</td>
                        <td style={tdS}>{fmtL(c.open_orders_value)}</td>
                        <td style={tdS}>{fmtL(c.outstanding_invoices)}</td>
                        <td style={{ ...tdS, fontWeight: 700, color: avail < 0 ? '#dc2626' : '#059669' }}>
                          {c.credit_status === 'no_limit' ? '—' : fmtL(avail)}
                        </td>
                        <td style={tdS}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: statusBadge.bg, color: statusBadge.color }}>
                            {statusBadge.label}
                          </span>
                        </td>
                        <td style={tdS}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => setCreditTarget(c)}
                              style={btnS('#ede9fe', '#5b21b6')}>
                              {c.credit_status === 'no_limit' ? 'Set Limit' : 'Edit Limit'}
                            </button>
                            {c.is_blocked
                              ? <button onClick={() => blockCustomer(c, false)}
                                  style={btnS('#d1fae5', '#065f46')}>Unblock</button>
                              : <button onClick={() => blockCustomer(c, true)}
                                  style={btnS('#fee2e2', '#dc2626')}>Block</button>
                            }
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── Tab 2: Fulfilment Analytics ─────────────────────────────────────── */}
      {!loading && tab === 2 && (
        <div>
          {/* KPI boxes */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Avg Dispatch Time"  value={`${analytics?.avg_dispatch_time_days ?? 0} days`} color="#6B3FDB" sub="Order created → dispatched" />
            <KpiCard label="Avg Delivery Time"  value={`${analytics?.avg_delivery_time_days ?? 0} days`} color="#0891b2" sub="Dispatched → delivered" />
            <KpiCard label="On-Time Delivery"   value={`${analytics?.on_time_delivery_rate ?? 0}%`}       color={parseFloat(analytics?.on_time_delivery_rate || 0) >= 85 ? '#059669' : '#d97706'} sub="Delivered on/before due date" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
            {/* Monthly bar chart */}
            <div style={{ ...cardS, padding: 20, marginBottom: 0 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Monthly Fulfilled Orders (12 months)</h3>
              {(analytics?.monthly_fulfilled?.length ?? 0) === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No delivery data yet.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={analytics.monthly_fulfilled} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#6B3FDB" radius={[4, 4, 0, 0]} name="Delivered" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Top customers */}
            <div style={{ ...cardS, padding: 20, marginBottom: 0 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Top 5 Customers by Orders</h3>
              {(analytics?.top_customers?.length ?? 0) === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>No data.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thS}>Customer</th>
                      <th style={{ ...thS, textAlign: 'right' }}>Orders</th>
                      <th style={{ ...thS, textAlign: 'right' }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.top_customers.map((c, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ ...tdS, fontWeight: 600 }}>{c.customer}</td>
                        <td style={{ ...tdS, textAlign: 'right' }}>{c.order_count}</td>
                        <td style={{ ...tdS, textAlign: 'right' }}>{fmtL(c.total_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
