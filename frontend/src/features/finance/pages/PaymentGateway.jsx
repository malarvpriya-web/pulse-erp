// frontend/src/features/finance/pages/PaymentGateway.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';

// ── helpers ──────────────────────────────────────────────────────────────────
function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '₹0';
  if (num >= 10000000) return `₹${(num / 10000000).toFixed(2)}Cr`;
  if (num >= 100000)   return `₹${(num / 100000).toFixed(2)}L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}

function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement('script');
    script.src     = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload  = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

const LINK_BADGE = {
  not_sent: { bg: '#f3f4f6', color: '#6b7280', label: 'Link Not Sent' },
  sent:     { bg: '#dbeafe', color: '#1d4ed8', label: 'Link Sent'     },
  viewed:   { bg: '#fef3c7', color: '#92400e', label: 'Link Opened'   },
  paid:     { bg: '#dcfce7', color: '#16a34a', label: 'Paid'          },
  failed:   { bg: '#fee2e2', color: '#dc2626', label: 'Failed'        },
};

const STATUS_BADGE = {
  sent:     { bg: '#dbeafe', color: '#2563eb' },
  overdue:  { bg: '#fee2e2', color: '#dc2626' },
  partial:  { bg: '#fef3c7', color: '#d97706' },
  paid:     { bg: '#dcfce7', color: '#16a34a' },
};

// ── component ─────────────────────────────────────────────────────────────────
export default function PaymentGateway() {
  const [invoices,    setInvoices]    = useState([]);
  const [history,     setHistory]     = useState([]);
  const [kpis,        setKpis]        = useState(null);
  const [gwMode,      setGwMode]      = useState(null);   // 'live' | 'test' | 'unconfigured' | null
  const [loading,     setLoading]     = useState(true);
  const [histLoading, setHistLoading] = useState(false);
  const [tab,         setTab]         = useState('collect');

  // action state
  const [sending,     setSending]     = useState(null);   // invoice id being link-sent
  const [paying,      setPaying]      = useState(null);   // invoice id in checkout
  const [marking,     setMarking]     = useState(null);   // invoice id being marked paid
  const [markModal,   setMarkModal]   = useState(null);   // invoice for mark-paid modal
  const [msg,         setMsg]         = useState({ text: '', type: '' });

  // filters (client-side)
  const [search,      setSearch]      = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dueFilter,   setDueFilter]   = useState('all');

  // history date range
  const [histFrom, setHistFrom] = useState('');
  const [histTo,   setHistTo]   = useState('');

  const abortRef = useRef(null);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 5000);
  };

  // ── load config-status (once) ──
  useEffect(() => {
    api.get('/payments/config-status')
      .then(r => setGwMode(r.data?.mode ?? 'unconfigured'))
      .catch(() => setGwMode('unconfigured'));
  }, []);

  // ── load invoices + kpis ──
  const loadCollect = useCallback(async () => {
    setLoading(true);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const [invRes, kpiRes] = await Promise.all([
        api.get('/payments/unpaid-invoices', { signal: ctrl.signal }).catch(() => null),
        api.get('/payments/kpis',            { signal: ctrl.signal }).catch(() => null),
      ]);
      setInvoices(invRes?.data?.data  || []);
      setKpis(kpiRes?.data?.data      || null);
    } catch (e) {
      if (e?.name !== 'AbortError' && e?.name !== 'CanceledError') {
        setInvoices([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // ── load payment history ──
  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    try {
      const params = {};
      if (histFrom) params.from = histFrom;
      if (histTo)   params.to   = histTo;
      const res = await api.get('/payments/history', { params }).catch(() => null);
      setHistory(res?.data?.data || []);
    } finally {
      setHistLoading(false);
    }
  }, [histFrom, histTo]);

  useEffect(() => { loadCollect(); }, [loadCollect]);
  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  // ── client-side filtering ──
  const filtered = invoices.filter(inv => {
    const q = search.toLowerCase();
    if (q && !inv.invoice_number?.toLowerCase().includes(q) && !inv.client_name?.toLowerCase().includes(q)) return false;
    if (statusFilter !== 'all' && inv.status?.toLowerCase() !== statusFilter) return false;
    if (dueFilter === 'overdue' && inv.days_overdue <= 0) return false;
    if (dueFilter === 'this_week') {
      const due = new Date(inv.due_date);
      const now = new Date();
      const week = new Date(now); week.setDate(now.getDate() + 7);
      if (due < now || due > week) return false;
    }
    return true;
  });

  // ── actions ──
  const sendLink = async (inv) => {
    setSending(inv.id);
    try {
      const res = await api.post('/payments/create-link', { invoice_id: inv.id });
      if (res.data?.url) {
        flash(`Payment link sent${res.data.simulated ? ' (demo)' : ''}: ${res.data.url}`);
        loadCollect();
      }
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to create payment link', 'error');
    } finally {
      setSending(null);
    }
  };

  const copyLink = (url) => {
    navigator.clipboard?.writeText(url).then(() => flash('Link copied to clipboard'));
  };

  const collectNow = async (inv) => {
    setPaying(inv.id);
    try {
      const orderRes = await api.post('/payments/create-order', {
        amount:      inv.total_amount,
        currency:    inv.currency || 'INR',
        invoice_id:  inv.id,
        description: `Invoice ${inv.invoice_number}`,
      });
      const { order_id, amount, currency, key_id, simulated } = orderRes.data;

      if (simulated) {
        flash(`Demo: Payment of ${formatINR(inv.total_amount)} simulated for ${inv.invoice_number}.`);
        setPaying(null);
        return;
      }

      const loaded = await loadRazorpayScript();
      if (!loaded) { flash('Failed to load Razorpay. Check internet connection.', 'error'); setPaying(null); return; }

      const options = {
        key: key_id,
        amount, currency,
        name:        'Pulse ERP',
        description: `Invoice ${inv.invoice_number}`,
        order_id,
        handler: async (response) => {
          try {
            await api.post('/payments/verify', {
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature:  response.razorpay_signature,
            });
            flash(`Payment of ${formatINR(inv.total_amount)} received from ${inv.client_name}!`);
            loadCollect();
          } catch {
            flash('Payment received but verification failed. Contact support.', 'error');
          }
        },
        prefill: { name: inv.client_name, email: inv.client_email || '' },
        theme:   { color: '#6B3FDB' },
        modal:   { ondismiss: () => setPaying(null) },
      };
      new window.Razorpay(options).open();
    } catch (e) {
      flash(e.response?.data?.message || 'Payment initiation failed', 'error');
    } finally {
      setPaying(null);
    }
  };

  const markPaid = async ({ invoice_id, payment_mode, reference_number, paid_date }) => {
    setMarking(invoice_id);
    try {
      await api.patch('/payments/mark-paid', { invoice_id, payment_mode, reference_number, paid_date });
      flash('Invoice marked as paid.');
      setMarkModal(null);
      loadCollect();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to mark as paid', 'error');
    } finally {
      setMarking(null);
    }
  };

  // ── CSV export for history ──
  const exportCSV = () => {
    if (!history.length) return;
    const hdr = 'Invoice,Client,Amount,Mode,Transaction ID,Paid At,Status';
    const rows = history.map(h =>
      [h.invoice_number, h.party_name, h.amount, h.payment_mode, h.transaction_id || h.razorpay_payment_id, h.paid_at ? new Date(h.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '', h.status]
        .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
    const blob = new Blob([[hdr, ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payment-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  // ── styles ────────────────────────────────────────────────────────────────
  const tabBtn = (t) => ({
    padding: '8px 20px', border: 'none', cursor: 'pointer',
    borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14,
    background: tab === t ? '#6B3FDB' : '#e9e4ff',
    color:      tab === t ? '#fff'    : '#6B3FDB',
  });

  const btn = (variant, small) => {
    const base = { border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: small ? 11 : 12, padding: small ? '4px 9px' : '5px 11px', whiteSpace: 'nowrap' };
    if (variant === 'primary')   return { ...base, background: '#6B3FDB', color: '#fff' };
    if (variant === 'secondary') return { ...base, background: '#e9e4ff', color: '#6B3FDB' };
    if (variant === 'success')   return { ...base, background: '#dcfce7', color: '#16a34a' };
    if (variant === 'danger')    return { ...base, background: '#fee2e2', color: '#dc2626' };
    return base;
  };

  const kpiCard = (label, value, sub, color) => (
    <div key={label} style={{ background: '#fff', border: `1px solid ${color}33`, borderRadius: 10, padding: '14px 18px', flex: '1 1 160px', minWidth: 150 }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );

  const linkBadge = (status) => {
    const m = LINK_BADGE[status] || LINK_BADGE.not_sent;
    return <span style={{ padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: m.bg, color: m.color }}>{m.label}</span>;
  };

  const statusBadge = (status, daysOverdue) => {
    const s = (status || '').toLowerCase();
    const m = STATUS_BADGE[s] || { bg: '#f3f4f6', color: '#6b7280' };
    return (
      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: m.bg, color: m.color }}>
        {s === 'overdue' ? `Overdue ${daysOverdue}d` : status}
      </span>
    );
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>

      {/* header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', color: '#4c1d95', fontSize: 22 }}>Payment Collection</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Collect payments via Razorpay — UPI, Cards, Net Banking, Wallets</p>
      </div>

      {/* gateway mode banner — generic, no env var names */}
      {gwMode === 'unconfigured' && (
        <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div style={{ fontSize: 13, color: '#92400e' }}>
            <strong>Test Mode:</strong> Payment gateway is in test mode. Contact your administrator to enable live payments.
          </div>
        </div>
      )}
      {gwMode === 'test' && (
        <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>🧪</span>
          <div style={{ fontSize: 13, color: '#92400e' }}>
            <strong>Razorpay Test Mode</strong> — Payments processed in test environment. Switch to live mode when ready.
          </div>
        </div>
      )}
      {gwMode === 'live' && (
        <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 8, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>✅</span>
          <div style={{ fontSize: 13, color: '#166534' }}>
            <strong>Razorpay Live Mode</strong> — Real payments active.
          </div>
        </div>
      )}

      {/* flash message */}
      {msg.text && (
        <div style={{
          marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 13,
          background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      msg.type === 'error' ? '#dc2626'  : '#16a34a',
          border:     `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>
          {msg.text}
        </div>
      )}

      {/* KPI cards */}
      {tab === 'collect' && kpis && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          {kpiCard('Total Outstanding',     formatINR(kpis.total_outstanding),    'across open invoices',   '#dc2626')}
          {kpiCard('Collected This Month',  formatINR(kpis.collected_this_month), 'via all payment modes',  '#16a34a')}
          {kpiCard('Overdue Invoices',      kpis.overdue_count,                   'past due date',          '#d97706')}
          {kpiCard('Payment Links Sent',    kpis.links_sent,                      'this month',             '#2563eb')}
        </div>
      )}

      {/* tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', marginBottom: 0 }}>
        <button style={tabBtn('collect')} onClick={() => setTab('collect')}>Collect Payment</button>
        <button style={tabBtn('history')} onClick={() => setTab('history')}>Payment History</button>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20 }}>

        {/* ── COLLECT TAB ── */}
        {tab === 'collect' && (
          <>
            {/* filters */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
              <input
                placeholder="Search invoice or client…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ flex: '1 1 180px', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
              />
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
                <option value="all">All Status</option>
                <option value="sent">Sent</option>
                <option value="overdue">Overdue</option>
                <option value="partial">Partial</option>
              </select>
              <select value={dueFilter} onChange={e => setDueFilter(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
                <option value="all">All Due Dates</option>
                <option value="this_week">Due This Week</option>
                <option value="overdue">Overdue Only</option>
              </select>
              <button onClick={loadCollect} style={{ ...btn('secondary'), padding: '6px 12px' }}>↻ Refresh</button>
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#6B3FDB' }}>Loading…</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Invoice', 'Client', 'Amount', 'Due Date', 'Status', 'Link Status', 'Actions'].map(h => (
                        <th key={h} style={{ padding: '9px 10px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(inv => {
                      const linkStatus = inv.payment_link_status || 'not_sent';
                      const hasLink    = !!inv.payment_link_url;
                      return (
                        <tr key={inv.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                          <td style={{ padding: '8px 10px', fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{inv.invoice_number}</td>
                          <td style={{ padding: '8px 10px' }}>{inv.client_name}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>{formatINR(inv.total_amount)}</td>
                          <td style={{ padding: '8px 10px', color: '#6b7280', whiteSpace: 'nowrap' }}>{inv.due_date?.split('T')[0]}</td>
                          <td style={{ padding: '8px 10px' }}>{statusBadge(inv.status, inv.days_overdue)}</td>
                          <td style={{ padding: '8px 10px' }}>{linkBadge(linkStatus)}</td>
                          <td style={{ padding: '8px 10px' }}>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {/* Send Link */}
                              {!hasLink && (
                                <button
                                  onClick={() => sendLink(inv)}
                                  disabled={sending === inv.id}
                                  style={{ ...btn('primary', true), opacity: sending === inv.id ? 0.6 : 1 }}
                                  title="Create and send Razorpay payment link to client"
                                >
                                  {sending === inv.id ? '…' : '🔗 Send Link'}
                                </button>
                              )}
                              {/* Copy Link */}
                              {hasLink && (
                                <button onClick={() => copyLink(inv.payment_link_url)} style={btn('secondary', true)} title="Copy link URL">
                                  📋 Copy Link
                                </button>
                              )}
                              {/* Collect Now */}
                              <button
                                onClick={() => collectNow(inv)}
                                disabled={paying === inv.id}
                                style={{ ...btn('primary', true), opacity: paying === inv.id ? 0.6 : 1 }}
                                title="Open Razorpay checkout for in-person collection"
                              >
                                {paying === inv.id ? 'Opening…' : '💳 Collect Now'}
                              </button>
                              {/* Mark as Paid */}
                              <button onClick={() => setMarkModal(inv)} style={btn('success', true)} title="Record manual payment (cash/cheque)">
                                ✓ Mark Paid
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>
                          {loading ? 'Loading…' : invoices.length === 0 ? 'No unpaid invoices found.' : 'No invoices match the current filters.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === 'history' && (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
              <label style={{ fontSize: 13, color: '#6b7280' }}>From:
                <input type="date" value={histFrom} onChange={e => setHistFrom(e.target.value)}
                  style={{ marginLeft: 6, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
              </label>
              <label style={{ fontSize: 13, color: '#6b7280' }}>To:
                <input type="date" value={histTo} onChange={e => setHistTo(e.target.value)}
                  style={{ marginLeft: 6, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
              </label>
              <button onClick={loadHistory} style={{ ...btn('secondary'), padding: '6px 12px' }}>↻ Refresh</button>
              <button onClick={exportCSV} disabled={!history.length}
                style={{ ...btn('primary'), padding: '6px 12px', opacity: history.length ? 1 : 0.5 }}>
                ⬇ Export CSV
              </button>
              <div style={{ marginLeft: 'auto', fontSize: 13, color: '#6b7280' }}>{history.length} records</div>
              {history.length > 0 && (
                <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a' }}>
                  Total: {formatINR(history.reduce((s, h) => s + parseFloat(h.amount || 0), 0))}
                </div>
              )}
            </div>

            {histLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#6B3FDB' }}>Loading…</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Invoice', 'Client', 'Amount', 'Mode', 'Transaction ID', 'Paid At', 'Status'].map(h => (
                        <th key={h} style={{ padding: '9px 10px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600, color: '#6B3FDB' }}>{p.invoice_number}</td>
                        <td style={{ padding: '8px 10px' }}>{p.party_name}</td>
                        <td style={{ padding: '8px 10px', fontWeight: 700 }}>{formatINR(p.amount)}</td>
                        <td style={{ padding: '8px 10px', textTransform: 'capitalize' }}>{p.payment_mode}</td>
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>
                          {p.transaction_id || p.razorpay_payment_id || '—'}
                        </td>
                        <td style={{ padding: '8px 10px', color: '#6b7280' }}>
                          {p.paid_at ? new Date(p.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: p.status === 'captured' ? '#d1fae5' : '#fef3c7', color: p.status === 'captured' ? '#16a34a' : '#d97706' }}>
                            {p.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {history.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>No payment transactions found for this period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Mark as Paid modal ── */}
      {markModal && (
        <MarkPaidModal
          invoice={markModal}
          onClose={() => setMarkModal(null)}
          onConfirm={markPaid}
          loading={marking === markModal?.id}
        />
      )}
    </div>
  );
}

// ── Mark as Paid modal ────────────────────────────────────────────────────────
function MarkPaidModal({ invoice, onClose, onConfirm, loading }) {
  const [mode, setMode]  = useState('cash');
  const [ref,  setRef]   = useState('');
  const [date, setDate]  = useState(new Date().toISOString().slice(0, 10));

  const submit = () => {
    onConfirm({ invoice_id: invoice.id, payment_mode: mode, reference_number: ref, paid_date: date });
  };

  const labelStyle = { fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 3 };
  const inputStyle = { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 360, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <h3 style={{ margin: '0 0 4px', color: '#4c1d95' }}>Mark as Paid</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
          {invoice.invoice_number} — {invoice.client_name} — <strong>{invoice.total_amount ? `₹${Number(invoice.total_amount).toLocaleString('en-IN')}` : ''}</strong>
        </p>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Payment Mode</label>
          <select value={mode} onChange={e => setMode(e.target.value)} style={inputStyle}>
            {['cash', 'cheque', 'bank_transfer', 'upi', 'neft', 'rtgs', 'other'].map(m => (
              <option key={m} value={m}>{m.replace('_', ' ').toUpperCase()}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Reference / Cheque Number (optional)</label>
          <input value={ref} onChange={e => setRef(e.target.value)} placeholder="CHQ-001 / UTR / Ref" style={inputStyle} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Payment Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={loading}
            style={{ padding: '8px 18px', border: 'none', borderRadius: 6, background: '#6B3FDB', color: '#fff', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
