import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShoppingCart, Search, RefreshCw, CheckCircle, XCircle,
  Clock, AlertTriangle, ChevronRight, Package, TrendingUp,
  Filter, Eye, Download, Send
} from 'lucide-react';
import api from '@/services/api/client';
import './PurchaseOrderManagement.css';

const fmt = n => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtD = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const STATUS_CFG = {
  draft:     { label: 'Draft',     bg: '#f3f4f6', color: '#6b7280' },
  sent:      { label: 'Sent',      bg: '#dbeafe', color: '#1d4ed8' },
  approved:  { label: 'Approved',  bg: '#dcfce7', color: '#15803d' },
  partial:   { label: 'Partial',   bg: '#fef9c3', color: '#a16207' },
  received:  { label: 'Received',  bg: '#d1fae5', color: '#065f46' },
  invoiced:  { label: 'Invoiced',  bg: '#ede9fe', color: '#6d28d9' },
  cancelled: { label: 'Cancelled', bg: '#fee2e2', color: '#dc2626' },
};
const sc = s => STATUS_CFG[(s || '').toLowerCase()] || STATUS_CFG.draft;

const WORKFLOW_STEPS = ['Draft', 'Sent', 'Approved', 'Partial', 'Received'];

// A PO is "reminder queued" if it was sent >7 days ago and still has status='sent'
const isReminderQueued = (createdAt, status) => {
  if (!createdAt) return false;
  if ((status || '').toLowerCase() !== 'sent') return false;
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  return new Date(createdAt) < sevenDaysAgo;
};

export default function PurchaseOrderManagement() {
  const [orders,  setOrders]  = useState([]);
  const [stats,   setStats]   = useState({ pending: 0, approved: 0, received: 0, follow_up: 0, total_value: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [search,  setSearch]  = useState('');
  const [fStatus, setFStatus] = useState('');
  const [selected,setSelected]= useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [toast,   setToast]   = useState(null);
  const [onlyReminderQueued, setOnlyReminderQueued] = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  };

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/procurement/purchase-orders/stats');
      if (!isMounted.current) return;
      setStats(res.data || {});
    } catch {
      // stats are non-critical; keep last value
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fStatus) params.status = fStatus;
      if (onlyReminderQueued) params.reminder_queued = 'true';
      const res = await api.get('/procurement/purchase-orders', { params });
      if (!isMounted.current) return;
      const raw = res.data?.orders || res.data?.rows || res.data || [];
      setOrders(Array.isArray(raw) ? raw : []);
    } catch {
      if (!isMounted.current) return;
      setOrders([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [fStatus, onlyReminderQueued]);

  useEffect(() => { load(); loadStats(); }, [load, loadStats]);

  const patchStatus = async (id, endpoint, label) => {
    setUpdatingId(id);
    try {
      await api.patch(`/procurement/purchase-orders/${id}/${endpoint}`);
      if (!isMounted.current) return;
      showToast(`PO ${label}`);
      load();
      loadStats();
      if (selected?.id === id) setSelected(o => ({ ...o, status: endpoint === 'send' ? 'sent' : endpoint === 'approve' ? 'approved' : 'cancelled' }));
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Update failed', 'error');
    } finally {
      if (isMounted.current) setUpdatingId(null);
    }
  };

  const updateStatus = async (id, status) => {
    setUpdatingId(id);
    try {
      await api.put(`/procurement/purchase-orders/${id}/status`, { status });
      if (!isMounted.current) return;
      showToast(`PO marked as ${status}`);
      load();
      loadStats();
      if (selected?.id === id) setSelected(o => ({ ...o, status }));
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Update failed', 'error');
    } finally {
      if (isMounted.current) setUpdatingId(null);
    }
  };

  const exportCSV = async () => {
    try {
      const params = {};
      if (fStatus) params.status = fStatus;
      const res = await api.get('/procurement/purchase-orders/export', { params, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `purchase-orders-${Date.now()}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast('Export failed', 'error');
    }
  };

  const displayed = orders.filter(o => {
    const q = search.toLowerCase();
    return (!q || (o.po_number || '').toLowerCase().includes(q) || (o.supplier_name || o.vendor_name || '').toLowerCase().includes(q));
  });

  return (
    <div className="pom-root">
      {toast && <div className={`pom-toast pom-toast-${toast.type}`}>{toast.msg}</div>}

      {/* Header */}
      <div className="pom-header">
        <div className="pom-header-left">
          <div className="pom-header-icon"><ShoppingCart size={20} /></div>
          <div>
            <h1 className="pom-title">PO Management</h1>
            <p className="pom-sub">Track and approve purchase orders</p>
          </div>
        </div>
        <div className="pom-header-actions">
          <button className="pom-icon-btn" onClick={() => { load(); loadStats(); }}><RefreshCw size={14} /></button>
          <button className="pom-export-btn" onClick={exportCSV}><Download size={14} /> Export</button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="pom-kpis">
        <KpiCard icon={ShoppingCart}  label="Total POs"          value={stats.total}       color="#6366f1" bg="#eef2ff" />
        <KpiCard icon={Clock}         label="Pending"             value={stats.pending}     color="#f59e0b" bg="#fffbeb" onClick={() => setFStatus('sent')} />
        <KpiCard icon={CheckCircle}   label="Approved"            value={stats.approved}    color="#10b981" bg="#f0fdf4" onClick={() => setFStatus('approved')} />
        <KpiCard icon={Package}       label="Received"            value={stats.received}    color="#0ea5e9" bg="#f0f9ff" onClick={() => setFStatus('received')} />
        <KpiCard icon={AlertTriangle} label="Follow-up (7 Days)"  value={stats.follow_up}   color="#dc2626" bg="#fef2f2" onClick={() => setOnlyReminderQueued(true)} />
        <KpiCard icon={TrendingUp}    label="Total Value"         value={fmt(stats.total_value)} color="#6B3FDB" bg="#f5f3ff" />
      </div>

      {/* Workflow legend */}
      <div className="pom-workflow">
        {WORKFLOW_STEPS.map((step, i) => {
          const cfg = sc(step);
          return (
            <div key={step} className="pom-wf-step">
              <div className="pom-wf-dot" style={{ background: cfg.color }} />
              <span style={{ color: cfg.color }}>{step}</span>
              {i < WORKFLOW_STEPS.length - 1 && <ChevronRight size={12} color="#d1d5db" />}
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="pom-filters">
        <div className="pom-search">
          <Search size={14} />
          <input
            placeholder="Search PO number or supplier…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="pom-filter-group">
          <Filter size={13} />
          <select value={fStatus} onChange={e => setFStatus(e.target.value)}>
            <option value="">All Status</option>
            {Object.keys(STATUS_CFG).map(s => (
              <option key={s} value={s}>{STATUS_CFG[s].label}</option>
            ))}
          </select>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
          <input
            type="checkbox"
            checked={onlyReminderQueued}
            onChange={e => setOnlyReminderQueued(e.target.checked)}
          />
          Show only Reminder queued
        </label>
        {(search || fStatus || onlyReminderQueued) && (
          <button className="pom-clear" onClick={() => { setSearch(''); setFStatus(''); setOnlyReminderQueued(false); }}>
            Clear filters
          </button>
        )}
        <span className="pom-count">{displayed.length} result{displayed.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="pom-layout">
        {/* Table */}
        <div className="pom-table-wrap">
          {loading ? (
            <div className="pom-loading"><div className="pom-spinner" /></div>
          ) : displayed.length === 0 ? (
            <div className="pom-empty">
              <ShoppingCart size={40} />
              <p>{search || fStatus ? 'No orders match your filters' : 'No purchase orders yet'}</p>
            </div>
          ) : (
            <table className="pom-table">
              <thead>
                <tr>
                  <th>PO Number</th>
                  <th>Supplier</th>
                  <th>Order Date</th>
                  <th>Expected</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(o => {
                  const cfg = sc(o.status);
                  const isLate = o.expected_delivery_date && o.status !== 'received' && new Date(o.expected_delivery_date + 'T00:00:00') < new Date();
                  const reminderQueued = isReminderQueued(o.created_at, o.status);
                  return (
                    <tr
                      key={o.id}
                      className={selected?.id === o.id ? 'pom-tr-active' : ''}
                      onClick={() => setSelected(o)}
                    >
                      <td>
                        <div className="pom-po-num">{o.po_number || '—'}</div>
                        {isLate && <span className="pom-late-tag"><AlertTriangle size={10} /> Overdue</span>}
                      </td>
                      <td>{o.supplier_name || o.vendor_name || '—'}</td>
                      <td className="pom-date">{fmtD(o.order_date)}</td>
                      <td className="pom-date" style={{ color: isLate ? '#dc2626' : undefined }}>
                        {fmtD(o.expected_delivery_date)}
                        {reminderQueued && (
                          <span style={{
                            marginLeft: 8,
                            display: 'inline-block',
                            fontSize: 11,
                            fontWeight: 600,
                            color: '#7c2d12',
                            background: '#ffedd5',
                            border: '1px solid #fed7aa',
                            borderRadius: 999,
                            padding: '2px 7px'
                          }}>
                            Reminder queued
                          </span>
                        )}
                      </td>
                      <td className="pom-amount">{fmt(o.total_amount)}</td>
                      <td>
                        <span className="pom-badge" style={{ background: cfg.bg, color: cfg.color }}>
                          {cfg.label}
                        </span>
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div className="pom-actions">
                          <button className="pom-action-view" onClick={() => setSelected(o)}>
                            <Eye size={13} />
                          </button>
                          {o.status?.toLowerCase() === 'draft' && (
                            <button
                              className="pom-action-send"
                              disabled={updatingId === o.id}
                              onClick={() => patchStatus(o.id, 'send', 'sent')}
                            >
                              <Send size={13} /> Send
                            </button>
                          )}
                          {o.status?.toLowerCase() === 'sent' && (
                            <button
                              className="pom-action-approve"
                              disabled={updatingId === o.id}
                              onClick={() => patchStatus(o.id, 'approve', 'approved')}
                            >
                              <CheckCircle size={13} /> Approve
                            </button>
                          )}
                          {o.status?.toLowerCase() === 'approved' && (
                            <button
                              className="pom-action-receive"
                              disabled={updatingId === o.id}
                              onClick={() => updateStatus(o.id, 'received')}
                            >
                              <Package size={13} /> Receive
                            </button>
                          )}
                          {['draft', 'sent'].includes(o.status?.toLowerCase()) && (
                            <button
                              className="pom-action-cancel"
                              disabled={updatingId === o.id}
                              onClick={() => patchStatus(o.id, 'cancel', 'cancelled')}
                            >
                              <XCircle size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="pom-detail">
            <div className="pom-detail-hd">
              <div>
                <div className="pom-detail-num">{selected.po_number}</div>
                <span className="pom-badge" style={{ background: sc(selected.status).bg, color: sc(selected.status).color }}>
                  {sc(selected.status).label}
                </span>
              </div>
              <button className="pom-icon-btn" onClick={() => setSelected(null)}>✕</button>
            </div>

            <div className="pom-detail-body">
              <DetailRow label="Supplier" value={selected.supplier_name || selected.vendor_name || '—'} />
              <DetailRow label="Order Date" value={fmtD(selected.order_date)} />
              <DetailRow label="Expected Delivery" value={fmtD(selected.expected_delivery_date)} />
              <DetailRow label="Total Amount" value={fmt(selected.total_amount)} bold />
              {selected.notes && <DetailRow label="Notes" value={selected.notes} />}
            </div>

            {/* Progress timeline */}
            <div className="pom-timeline">
              {WORKFLOW_STEPS.map(step => {
                const idx = WORKFLOW_STEPS.indexOf(step);
                const curIdx = WORKFLOW_STEPS.findIndex(s => s.toLowerCase() === selected.status?.toLowerCase());
                const done = idx <= curIdx;
                const active = idx === curIdx;
                return (
                  <div key={step} className={`pom-tl-item${done ? ' pom-tl-done' : ''}${active ? ' pom-tl-active' : ''}`}>
                    <div className="pom-tl-dot" />
                    <span>{step}</span>
                  </div>
                );
              })}
            </div>

            {/* Quick actions */}
            <div className="pom-detail-actions">
              {selected.status?.toLowerCase() === 'draft' && (
                <button className="pom-da-send" onClick={() => patchStatus(selected.id, 'send', 'sent')}>
                  <Send size={14} /> Send PO
                </button>
              )}
              {selected.status?.toLowerCase() === 'sent' && (
                <button className="pom-da-approve" onClick={() => patchStatus(selected.id, 'approve', 'approved')}>
                  <CheckCircle size={14} /> Approve PO
                </button>
              )}
              {selected.status?.toLowerCase() === 'approved' && (
                <button className="pom-da-receive" onClick={() => updateStatus(selected.id, 'received')}>
                  <Package size={14} /> Mark Received
                </button>
              )}
              {['draft', 'sent'].includes(selected.status?.toLowerCase()) && (
                <button className="pom-da-cancel" onClick={() => patchStatus(selected.id, 'cancel', 'cancelled')}>
                  <XCircle size={14} /> Cancel PO
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, color, bg, onClick }) {
  return (
    <div className="pom-kpi" style={{ cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
      <div className="pom-kpi-icon" style={{ background: bg, color }}><Icon size={18} /></div>
      <div>
        <div className="pom-kpi-val">{value}</div>
        <div className="pom-kpi-label">{label}</div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, bold }) {
  return (
    <div className="pom-dr">
      <span className="pom-dr-label">{label}</span>
      <span className="pom-dr-val" style={{ fontWeight: bold ? 700 : 400 }}>{value}</span>
    </div>
  );
}
