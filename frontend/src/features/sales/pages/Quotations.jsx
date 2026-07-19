import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileText, Plus, Download, X, ChevronRight, Package,
  History, GitBranch, TrendingUp, TrendingDown, RefreshCw,
  CheckCircle, Clock, BarChart2, ShoppingCart, Send,
} from 'lucide-react';
import api from '@/services/api/client';
import './Quotations.css';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';

// ── Constants ────────────────────────────────────────────────────────────────
const STATUS_META = {
  draft:     { label: 'Draft',     bg: '#f3f4f6', color: '#374151' },
  sent:      { label: 'Sent',      bg: '#dbeafe', color: '#1d4ed8' },
  accepted:  { label: 'Accepted',  bg: '#dcfce7', color: '#15803d' },
  rejected:  { label: 'Rejected',  bg: '#fee2e2', color: '#b91c1c' },
  expired:   { label: 'Expired',   bg: '#fef3c7', color: '#92400e' },
  revised:   { label: 'Revised',   bg: '#e0f2fe', color: '#0369a1' },
  converted: { label: 'Converted', bg: '#ede9fe', color: '#5b21b6' },
};

const FILTER_TABS = ['all', 'draft', 'sent', 'accepted', 'rejected', 'expired', 'revised', 'converted'];

const fmt     = (n) => parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtL    = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtPct  = (n) => `${parseFloat(n || 0).toFixed(1)}%`;
const fmtDate = (d) => {
  if (!d) return '—';
  try { return new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); }
  catch { return d || '—'; }
};
const fmtShort = (d) => {
  if (!d) return '—';
  try { return new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); }
  catch { return d || '—'; }
};
const isOverdue = (d) => d && new Date(String(d).slice(0, 10)) < new Date(new Date().toISOString().slice(0, 10));

// ── Revision History Drawer ──────────────────────────────────────────────────
function RevisionDrawer({ open, onClose, quotationId, onRevise }) {
  const toast = useToast();
  const [revisions, setRevisions] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [revising, setRevising]   = useState(false);
  const [error, setError]         = useState('');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!quotationId) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/sales/quotations/${quotationId}/revisions`);
      if (!isMounted.current) return;
      setRevisions(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      if (!isMounted.current) return;
      setError(e.response?.data?.error || 'Failed to load revision history');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [quotationId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const latest = revisions[revisions.length - 1];
  const canRevise = latest && !['revised', 'accepted', 'converted'].includes(latest.status);

  async function handleRevise() {
    if (!latest) return;
    setRevising(true);
    try {
      await api.post(`/sales/quotations/${latest.id}/revise`);
      if (!isMounted.current) return;
      await load();
      onRevise();
    } catch (e) {
      if (!isMounted.current) return;
      setError(e.response?.data?.error || 'Failed to create revision');
    } finally {
      if (isMounted.current) setRevising(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="sq-rev-overlay" onClick={onClose} />
      <div className="sq-rev-drawer">
        <div className="sq-rev-hd">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="sq-rev-hd-icon"><History size={16} /></div>
            <div>
              <div className="sq-rev-hd-title">Revision History</div>
              <div className="sq-rev-hd-sub">
                {revisions.length > 0
                  ? `${revisions[0].quotation_number?.replace(/-v\d+$/, '')} · ${revisions.length} version${revisions.length !== 1 ? 's' : ''}`
                  : 'Loading…'}
              </div>
            </div>
          </div>
          <button className="sq-close-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="sq-rev-body">
          {loading && (
            <div className="sq-rev-loading"><RefreshCw size={18} className="sq-spin" /> Loading revision history…</div>
          )}
          {error && <div className="sq-rev-error">{error}</div>}
          {!loading && revisions.length === 0 && !error && (
            <div className="sq-rev-empty"><GitBranch size={28} strokeWidth={1.5} /><p>No revision history found</p></div>
          )}

          {!loading && revisions.length > 0 && (
            <>
              {revisions.length > 1 && (
                <div className="sq-rev-compare">
                  <div className="sq-rev-compare-title"><BarChart2 size={12} /> Price Progression</div>
                  <div className="sq-rev-compare-grid">
                    {revisions.map((r, i) => {
                      const prev  = revisions[i - 1];
                      const delta = prev ? parseFloat(r.total_amount || 0) - parseFloat(prev.total_amount || 0) : 0;
                      const pct   = prev && parseFloat(prev.total_amount)
                        ? ((delta / parseFloat(prev.total_amount)) * 100).toFixed(1) : null;
                      return (
                        <div key={r.id} className="sq-rev-compare-item">
                          <div className="sq-rev-ver-badge">v{r.version || 1}</div>
                          <div className="sq-rev-compare-amt">₹{fmt(r.total_amount)}</div>
                          {pct !== null && (
                            <div className={`sq-rev-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
                              {delta > 0 ? <TrendingUp size={10} /> : delta < 0 ? <TrendingDown size={10} /> : null}
                              {delta !== 0 ? `${delta > 0 ? '+' : ''}${pct}%` : 'same'}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="sq-rev-timeline">
                {revisions.map((r, i) => {
                  const s = STATUS_META[r.status] || STATUS_META.draft;
                  const isLatest = i === revisions.length - 1;
                  const ver = r.version || 1;
                  return (
                    <div key={r.id} className="sq-rev-item">
                      <div className="sq-rev-track">
                        <div className={`sq-rev-dot ${isLatest ? 'latest' : ''}`}><span>{ver}</span></div>
                        {i < revisions.length - 1 && <div className="sq-rev-line" />}
                      </div>
                      <div className="sq-rev-content">
                        <div className="sq-rev-content-hd">
                          <div>
                            <span className="sq-rev-qnum">{r.quotation_number}</span>
                            {isLatest && <span className="sq-rev-latest-badge">Latest</span>}
                          </div>
                          <span className="sq-badge" style={{ background: s.bg, color: s.color, fontSize: 10, padding: '2px 8px' }}>{s.label}</span>
                        </div>
                        <div className="sq-rev-meta">
                          <span>{fmtShort(r.quotation_date)}</span>
                          <span className="sq-rev-amt">₹{fmt(r.total_amount)}</span>
                          {r.status === 'accepted' && (
                            <span className="sq-rev-accepted-tag"><CheckCircle size={10} /> Accepted Price</span>
                          )}
                        </div>
                        {r.notes && <div className="sq-rev-notes">{r.notes}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="sq-rev-ft">
          {canRevise && (
            <button className="sq-submit-btn" onClick={handleRevise} disabled={revising}>
              {revising
                ? <><RefreshCw size={13} className="sq-spin" /> Creating…</>
                : <><GitBranch size={13} /> Create Revision v{(latest?.version || 1) + 1}</>
              }
            </button>
          )}
          <button className="sq-cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
const Quotations = ({ setPage } = {}) => {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [quotations, setQuotations]   = useState([]);
  const [stats, setStats]             = useState({});
  const [loading, setLoading]         = useState(false);
  const [activeTab, setActiveTab]     = useState('all');
  const [search, setSearch]           = useState('');
  const [showForm, setShowForm]       = useState(false);
  const [customers, setCustomers]     = useState([]);
  const [products, setProducts]       = useState([]);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [submitting, setSubmitting]   = useState(false);
  const [formError, setFormError]     = useState('');
  const [pdfError, setPdfError]       = useState('');
  const [revisingId, setRevisingId]   = useState(null);
  const [convertingId, setConvertingId] = useState(null);
  const [historyDrawer, setHistoryDrawer] = useState({ open: false, quotationId: null });
  const [pendingSalesOrderNav, setPendingSalesOrderNav] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const [formData, setFormData] = useState({
    quotation_number: '',
    customer_id: '',
    quotation_date: new Date().toISOString().split('T')[0],
    validity_date: '',
    status: 'draft',
    notes: '',
    tax_rate: 18,
    discount: 0,
  });

  // ── Data fetching ──
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (activeTab !== 'all') params.status = activeTab;
      if (search.trim()) params.search = search.trim();

      const [qRes, sRes] = await Promise.allSettled([
        api.get('/sales/quotations', { params }),
        api.get('/sales/quotations/stats'),
      ]);

      if (!isMounted.current) return;

      if (qRes.status === 'fulfilled') {
        const data = qRes.value.data;
        setQuotations(Array.isArray(data) ? data : []);
      } else {
        setQuotations([]);
      }

      if (sRes.status === 'fulfilled') {
        setStats(sRes.value.data?.data ?? sRes.value.data ?? {});
      }
    } catch {
      if (isMounted.current) setQuotations([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [activeTab, search]);

  useEffect(() => {
    fetchData();
    const loadLookups = async () => {
      try {
        const [cRes, pRes] = await Promise.allSettled([
          api.get('/finance/parties?type=customer'),
          api.get('/inventory/items'),
        ]);
        if (!isMounted.current) return;
        if (cRes.status === 'fulfilled') setCustomers(cRes.value.data || []);
        if (pRes.status === 'fulfilled') setProducts(pRes.value.data || []);
      } catch { /* non-critical */ }
    };
    loadLookups();
  }, [fetchData]);

  const handleNewQuotation = async () => {
    try {
      const res = await api.get('/sales/quotations/next-number');
      if (!isMounted.current) return;
      setFormData({
        quotation_number: res.data.number || '',
        customer_id: '',
        quotation_date: new Date().toISOString().split('T')[0],
        validity_date: (() => {
          const d = new Date(); d.setDate(d.getDate() + 30);
          return d.toISOString().split('T')[0];
        })(),
        status: 'draft',
        notes: '',
        tax_rate: 18,
        discount: 0,
      });
    } catch {
      if (!isMounted.current) return;
      setFormData(f => ({ ...f, quotation_number: '' }));
    }
    if (!isMounted.current) return;
    setSelectedProducts([]);
    setFormError('');
    setShowForm(true);
  };

  const addProduct    = () => setSelectedProducts(p => [...p, { product_id: '', quantity: 1, unit_price: 0, item_description: '' }]);
  const removeProduct = (i) => setSelectedProducts(p => p.filter((_, idx) => idx !== i));

  const updateProduct = (index, field, value) => {
    setSelectedProducts(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === 'product_id') {
        const p = products.find(p => String(p.id) === String(value));
        if (p) {
          updated[index].unit_price = p.unit_price || p.rate || 0;
          updated[index].item_description = p.item_name || p.name || '';
        }
      }
      return updated;
    });
  };

  const calculateTotals = () => {
    const subtotal = selectedProducts.reduce((s, i) => s + (parseFloat(i.quantity || 0) * parseFloat(i.unit_price || 0)), 0);
    const discount = (subtotal * parseFloat(formData.discount || 0)) / 100;
    const taxable  = subtotal - discount;
    const tax      = (taxable * parseFloat(formData.tax_rate || 0)) / 100;
    return { subtotal, discount, tax, total: taxable + tax };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError('');
    try {
      const totals = calculateTotals();
      const quotation = await api.post('/sales/quotations', {
        ...formData,
        subtotal:     totals.subtotal,
        tax_amount:   totals.tax,
        total_amount: totals.total,
      });
      if (!isMounted.current) return;
      const qId = quotation.data.id;
      await Promise.all(
        selectedProducts
          .filter(it => it.product_id || it.item_description)
          .map(it => api.post(`/sales/quotations/${qId}/items`, {
            item_description: it.item_description || '',
            quantity:         parseFloat(it.quantity || 1),
            rate:             parseFloat(it.unit_price || 0),
            tax_percentage:   parseFloat(formData.tax_rate || 18),
            tax_amount:       parseFloat(it.quantity || 1) * parseFloat(it.unit_price || 0) * parseFloat(formData.tax_rate || 18) / 100,
            total:            parseFloat(it.quantity || 1) * parseFloat(it.unit_price || 0) * (1 + parseFloat(formData.tax_rate || 18) / 100),
          }))
      );
      if (!isMounted.current) return;
      setShowForm(false);
      fetchData();
    } catch (err) {
      if (!isMounted.current) return;
      setFormError(err.response?.data?.error || err.message || 'Error creating quotation.');
    } finally {
      if (isMounted.current) setSubmitting(false);
    }
  };

  const updateStatus = async (id, newStatus) => {
    try {
      await api.put(`/sales/quotations/${id}`, { status: newStatus });
      if (!isMounted.current) return;
      fetchData();
    } catch (err) {
      if (!isMounted.current) return;
      toast.error(err?.response?.data?.error || err.message || 'Status update failed');
    }
  };

  const sendQuotation = async (id) => {
    try {
      await api.patch(`/sales/quotations/${id}/send`);
      if (!isMounted.current) return;
      toast.success('Quotation sent successfully');
      fetchData();
    } catch (err) {
      if (!isMounted.current) return;
      toast.error(err?.response?.data?.error || err.message || 'Failed to send quotation');
    }
  };

  const handleRevise = async (id) => {
    setRevisingId(id);
    try {
      const res = await api.post(`/sales/quotations/${id}/revise`);
      if (!isMounted.current) return;
      await fetchData();
      setHistoryDrawer({ open: true, quotationId: res.data?.id || id });
    } catch (e) {
      if (!isMounted.current) return;
      toast.error(e.response?.data?.error || 'Failed to create revision');
    } finally {
      if (isMounted.current) setRevisingId(null);
    }
  };

  const convertToOrder = async (id) => {
    setConvertingId(id);
    try {
      const res = await api.patch(`/sales/quotations/${id}/convert-to-order`);
      if (!isMounted.current) return;
      await fetchData();
      const orderNum = res.data?.order_number || '';
      if (typeof setPage === 'function') {
        setPendingSalesOrderNav({ orderNum, title: `Sales Order ${orderNum} created` });
      } else {
        toast.success(`Converted to Sales Order ${orderNum}`);
      }
    } catch (e) {
      if (!isMounted.current) return;
      toast.error(e.response?.data?.error || 'Failed to convert to order');
    } finally {
      if (isMounted.current) setConvertingId(null);
    }
  };

  const handleWonConvert = async (id) => {
    setConvertingId(id);
    try {
      // Single atomic endpoint: marks accepted + creates order in one transaction
      const res = await api.patch(`/sales/quotations/${id}/accept-and-convert`);
      if (!isMounted.current) return;
      await fetchData();
      const orderNum = res.data?.order_number || '';
      if (typeof setPage === 'function') {
        setPendingSalesOrderNav({ orderNum, title: `Quotation Won. Sales Order ${orderNum} created` });
      } else {
        toast.success(`Quotation marked as Won. Sales Order ${orderNum} created.`);
      }
    } catch (e) {
      if (!isMounted.current) return;
      toast.error(e.response?.data?.error || 'Failed to convert quotation to Sales Order');
    } finally {
      if (isMounted.current) setConvertingId(null);
    }
  };

  const downloadPDF = async (id) => {
    setPdfError('');
    try {
      const res = await api.get(`/sales/quotations/${id}/pdf`, { responseType: 'blob' });
      if (!isMounted.current) return;
      // Server returns HTML with window.print() embedded — open in new tab so
      // the browser triggers the print dialog (user saves as PDF from there).
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/html' }));
      const w = window.open(url, '_blank');
      setTimeout(() => window.URL.revokeObjectURL(url), 15000);
      if (!w) setPdfError('Popup blocked. Please allow popups for this site to print the quotation.');
    } catch (err) {
      if (!isMounted.current) return;
      setPdfError(err.response?.data?.error || err.message || 'PDF not available for this quotation.');
    }
  };

  const totals = calculateTotals();

  // ── KPI derivation (from stats endpoint — real DB data) ──
  const kpiTotal       = parseInt(stats?.total ?? 0);
  const kpiAccepted    = parseInt(stats?.accepted ?? 0);
  const kpiSentPending = parseInt(stats?.sent_pending ?? 0);
  const kpiValue       = parseFloat(stats?.total_value ?? 0);
  const kpiRate        = parseFloat(stats?.acceptance_rate ?? 0);

  return (
    <div className="sq-root">
      <ConfirmDialog
        open={!!pendingSalesOrderNav}
        title={pendingSalesOrderNav?.title || 'Open Sales Orders?'}
        message="Open Sales Orders now?"
        confirmLabel="Open Sales Orders"
        variant="info"
        onConfirm={() => { setPendingSalesOrderNav(null); if (typeof setPage === 'function') setPage('SalesOrders'); }}
        onCancel={() => setPendingSalesOrderNav(null)}
      />

      {pdfError && (
        <div style={{ margin: '0 0 16px', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13 }}>
          {pdfError} <button onClick={() => setPdfError('')} style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontWeight: 700 }}>×</button>
        </div>
      )}

      {readOnly && <ReadOnlyBanner />}

      {/* ── Header ── */}
      <div className="sq-header">
        <div className="sq-header-l">
          <div className="sq-header-icon"><FileText size={18} /></div>
          <div>
            <h1 className="sq-title">Sales Quotations</h1>
            <p className="sq-sub">Manage, revise, and track customer quotations</p>
          </div>
        </div>
        {!readOnly && (
          <button className="sq-new-btn" onClick={handleNewQuotation}>
            <Plus size={14} /> New Quotation
          </button>
        )}
      </div>

      {/* ── KPI cards (from stats endpoint) ── */}
      <div className="sq-summary sq-summary-5">
        <div className="sq-sum-card">
          <span className="sq-sum-val">{kpiTotal}</span>
          <span className="sq-sum-label">Total Quotations</span>
        </div>
        <div className="sq-sum-card">
          <span className="sq-sum-val sq-sum-green">{kpiAccepted}</span>
          <span className="sq-sum-label">Accepted</span>
        </div>
        <div className="sq-sum-card">
          <span className="sq-sum-val sq-sum-blue">{kpiSentPending}</span>
          <span className="sq-sum-label">Sent / Pending</span>
        </div>
        <div className="sq-sum-card">
          <span className="sq-sum-val sq-sum-purple">{fmtL(kpiValue)}</span>
          <span className="sq-sum-label">Total Value</span>
        </div>
        <div className="sq-sum-card sq-sum-card-rate">
          <div className="sq-rate-row">
            <span className={`sq-sum-val ${kpiRate >= 50 ? 'sq-sum-green' : kpiRate >= 30 ? 'sq-sum-orange' : 'sq-sum-red'}`}>
              {fmtPct(kpiRate)}
            </span>
            <div className="sq-rate-bar-wrap">
              <div className="sq-rate-bar" style={{ width: `${Math.min(kpiRate, 100)}%`, background: kpiRate >= 50 ? '#15803d' : kpiRate >= 30 ? '#d97706' : '#b91c1c' }} />
            </div>
          </div>
          <span className="sq-sum-label">Acceptance Rate</span>
        </div>
      </div>

      {/* ── Status filter tabs ── */}
      <div className="sq-tabs">
        {FILTER_TABS.map(tab => (
          <button
            key={tab}
            className={`sq-tab-btn${activeTab === tab ? ' sq-tab-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'all' ? 'All' : STATUS_META[tab]?.label ?? tab}
          </button>
        ))}
        <div className="sq-tab-search">
          <input
            type="text"
            placeholder="Search quotation # or customer…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchData()}
          />
        </div>
      </div>

      {/* ── Table ── */}
      <div className="sq-table-wrap">
        {loading ? (
          <div className="sq-empty"><RefreshCw size={28} className="sq-spin" color="#c4b5fd" /><p>Loading quotations…</p></div>
        ) : quotations.length === 0 ? (
          <div className="sq-empty">
            <FileText size={36} color="#c4b5fd" />
            <p>No quotations{activeTab !== 'all' ? ` with status "${STATUS_META[activeTab]?.label ?? activeTab}"` : ''} yet.</p>
          </div>
        ) : (
          <table className="sq-table">
            <thead>
              <tr>
                <th>Quotation #</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Valid Until</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {quotations.map(q => {
                const s        = STATUS_META[q.status] || STATUS_META.draft;
                const ver      = parseInt(q.version) || 1;
                const revCount = parseInt(q.total_revisions) || 1;
                const validUntil = q.validity_date || q.valid_until;
                const overdue  = isOverdue(validUntil) && !['accepted', 'converted', 'rejected'].includes(q.status);
                return (
                  <tr key={q.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="sq-quot-num">{q.quotation_number}</span>
                        {ver > 1 && <span className="sq-ver-badge">v{ver}</span>}
                        {revCount > 1 && (
                          <button className="sq-rev-count-btn" onClick={() => setHistoryDrawer({ open: true, quotationId: q.id })} title="View revision history">
                            <GitBranch size={9} /> {revCount} revisions
                          </button>
                        )}
                      </div>
                    </td>
                    <td>{q.customer_name || '—'}</td>
                    <td>{fmtDate(q.quotation_date)}</td>
                    <td style={{ color: overdue ? '#b91c1c' : undefined, fontWeight: overdue ? 600 : undefined }}>
                      {fmtDate(validUntil)}
                      {overdue && <span style={{ fontSize: 10, marginLeft: 4 }}>Overdue</span>}
                    </td>
                    <td><strong>₹{fmt(q.total_amount)}</strong></td>
                    <td><span className="sq-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                        {!readOnly && (
                        <>
                        {q.status === 'draft' && (
                          <>
                            <button className="sq-act-btn sq-act-blue" onClick={() => sendQuotation(q.id)} title="Mark as Sent">
                              <Send size={10} /> Send
                            </button>
                            <button className="sq-act-btn sq-act-red" onClick={() => updateStatus(q.id, 'rejected')} title="Reject">
                              <X size={10} /> Reject
                            </button>
                          </>
                        )}
                        {q.status === 'sent' && (
                          <>
                            <button
                              className="sq-act-btn sq-act-purple"
                              onClick={() => handleWonConvert(q.id)}
                              disabled={convertingId === q.id}
                              title="Mark as Won and create Sales Order"
                            >
                              {convertingId === q.id ? <RefreshCw size={10} className="sq-spin" /> : <ShoppingCart size={10} />}
                              Won → SO
                            </button>
                            <button className="sq-act-btn sq-act-green" onClick={() => updateStatus(q.id, 'accepted')} title="Mark Accepted">
                              <CheckCircle size={10} /> Accept
                            </button>
                            <button className="sq-act-btn sq-act-red" onClick={() => updateStatus(q.id, 'rejected')} title="Mark Rejected">
                              <X size={10} /> Reject
                            </button>
                          </>
                        )}
                        {q.status === 'accepted' && (
                          <button
                            className="sq-act-btn sq-act-purple"
                            onClick={() => convertToOrder(q.id)}
                            disabled={convertingId === q.id}
                            title="Convert to Sales Order"
                          >
                            {convertingId === q.id
                              ? <RefreshCw size={10} className="sq-spin" />
                              : <ShoppingCart size={10} />
                            }
                            Convert to Order
                          </button>
                        )}
                        {['draft', 'sent', 'rejected'].includes(q.status) && (
                          <button
                            className="sq-act-btn sq-act-purple"
                            onClick={() => handleRevise(q.id)}
                            disabled={revisingId === q.id}
                            title="Create a new revision"
                          >
                            {revisingId === q.id ? <RefreshCw size={10} className="sq-spin" /> : <GitBranch size={10} />}
                            Revise
                          </button>
                        )}
                        </>
                        )}
                        <button className="sq-act-btn sq-act-ghost" onClick={() => setHistoryDrawer({ open: true, quotationId: q.id })} title="View revision history">
                          <History size={10} /> History
                        </button>
                        <button className="sq-pdf-btn" onClick={() => downloadPDF(q.id)} title="Download PDF">
                          <Download size={12} /> PDF
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

      {/* ── Revision History Drawer ── */}
      <RevisionDrawer
        open={historyDrawer.open}
        quotationId={historyDrawer.quotationId}
        onClose={() => setHistoryDrawer({ open: false, quotationId: null })}
        onRevise={fetchData}
      />

      {/* ── Create Quotation Modal ── */}
      {showForm && (
        <div className="sq-overlay" onClick={(e) => e.target.className === 'sq-overlay' && setShowForm(false)}>
          <div className="sq-modal">
            <div className="sq-modal-hd">
              <div className="sq-modal-hd-l">
                <div className="sq-modal-icon"><FileText size={16} /></div>
                <div>
                  <div className="sq-modal-title">New Quotation</div>
                  <div className="sq-modal-sub">{formData.quotation_number}</div>
                </div>
              </div>
              <button className="sq-close-btn" onClick={() => { setShowForm(false); setFormError(''); }}><X size={16} /></button>
            </div>

            <div className="sq-modal-body">
              <form onSubmit={handleSubmit}>
                {formError && (
                  <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13 }}>
                    {formError}
                  </div>
                )}

                <div className="sq-section">
                  <div className="sq-section-title">Customer Details</div>
                  <div className="sq-form-grid">
                    <div className="sq-field sq-field-full">
                      <label>Customer *</label>
                      <select value={formData.customer_id} onChange={e => setFormData({ ...formData, customer_id: e.target.value })} required>
                        <option value="">Select customer…</option>
                        {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div className="sq-field">
                      <label>Quotation Date *</label>
                      <input type="date" value={formData.quotation_date} onChange={e => setFormData({ ...formData, quotation_date: e.target.value })} required />
                    </div>
                    <div className="sq-field">
                      <label>Valid Until *</label>
                      <input type="date" value={formData.validity_date} onChange={e => setFormData({ ...formData, validity_date: e.target.value })} required />
                    </div>
                    <div className="sq-field sq-field-full">
                      <label>Notes</label>
                      <textarea rows={2} value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} placeholder="Any special terms or notes…" />
                    </div>
                  </div>
                </div>

                <div className="sq-section">
                  <div className="sq-section-hd">
                    <div className="sq-section-title"><Package size={13} /> Products</div>
                    <button type="button" className="sq-add-item-btn" onClick={addProduct}><Plus size={12} /> Add Item</button>
                  </div>
                  {selectedProducts.length === 0 && (
                    <div className="sq-no-items">No items added yet. Click "Add Item" to begin.</div>
                  )}
                  {selectedProducts.map((item, idx) => (
                    <div key={idx} className="sq-item-row">
                      <div className="sq-item-num">{idx + 1}</div>
                      <div className="sq-item-fields">
                        <div className="sq-field">
                          <label>Product / Description</label>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <select value={item.product_id} onChange={e => updateProduct(idx, 'product_id', e.target.value)} style={{ flex: 1 }}>
                              <option value="">Select product…</option>
                              {products.map(p => <option key={p.id} value={p.id}>{p.item_name || p.name}</option>)}
                            </select>
                          </div>
                          <input
                            type="text"
                            placeholder="Or type description…"
                            value={item.item_description}
                            onChange={e => updateProduct(idx, 'item_description', e.target.value)}
                            style={{ marginTop: 4 }}
                          />
                        </div>
                        <div className="sq-field sq-field-sm">
                          <label>Qty</label>
                          <input type="number" min="0.001" step="0.001" value={item.quantity} onChange={e => updateProduct(idx, 'quantity', e.target.value)} />
                        </div>
                        <div className="sq-field sq-field-sm">
                          <label>Unit Price (₹)</label>
                          <input type="number" min="0" step="0.01" value={item.unit_price} onChange={e => updateProduct(idx, 'unit_price', e.target.value)} />
                        </div>
                        <div className="sq-item-line">
                          <span className="sq-item-line-label">Line Total</span>
                          <span className="sq-item-line-val">₹{fmt(parseFloat(item.quantity || 0) * parseFloat(item.unit_price || 0))}</span>
                        </div>
                      </div>
                      <button type="button" className="sq-remove-btn" onClick={() => removeProduct(idx)}><X size={13} /></button>
                    </div>
                  ))}
                </div>

                <div className="sq-section">
                  <div className="sq-section-title">Summary</div>
                  <div className="sq-totals">
                    <div className="sq-totals-inputs">
                      <div className="sq-field">
                        <label>Discount %</label>
                        <input type="number" min="0" max="100" step="0.01" value={formData.discount} onChange={e => setFormData({ ...formData, discount: e.target.value })} />
                      </div>
                      <div className="sq-field">
                        <label>GST %</label>
                        <input type="number" min="0" max="100" step="0.01" value={formData.tax_rate} onChange={e => setFormData({ ...formData, tax_rate: e.target.value })} />
                      </div>
                    </div>
                    <div className="sq-totals-box">
                      <div className="sq-total-row"><span>Subtotal</span><span>₹{fmt(totals.subtotal)}</span></div>
                      <div className="sq-total-row sq-total-disc"><span>Discount ({formData.discount}%)</span><span>− ₹{fmt(totals.discount)}</span></div>
                      <div className="sq-total-row"><span>GST ({formData.tax_rate}%)</span><span>₹{fmt(totals.tax)}</span></div>
                      <div className="sq-total-row sq-grand-total"><span>Total</span><span>₹{fmt(totals.total)}</span></div>
                    </div>
                  </div>
                </div>

                <div className="sq-modal-actions">
                  <button type="button" className="sq-cancel-btn" onClick={() => { setShowForm(false); setFormError(''); }}>Cancel</button>
                  <button type="submit" className="sq-submit-btn" disabled={submitting}>
                    {submitting ? 'Creating…' : <><ChevronRight size={14} /> Create Quotation</>}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Quotations;
