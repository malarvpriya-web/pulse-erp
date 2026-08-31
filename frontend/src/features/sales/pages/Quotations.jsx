import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FileText, Plus, Download, X, ChevronRight, Package,
  History, GitBranch, TrendingUp, TrendingDown, RefreshCw,
  CheckCircle, Clock, BarChart2, ShoppingCart, Send,
  Search, SlidersHorizontal, RotateCcw,
} from 'lucide-react';
import api from '@/services/api/client';
import './Quotations.css';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import { PageHero, PageShell } from '@/components/pulse-ui';

// ── Constants ────────────────────────────────────────────────────────────────
const STATUS_META = {
  draft:     { label: 'Draft',     bg: '#f3f4f6', color: '#374151' },
  sent:      { label: 'Sent',      bg: '#dbeafe', color: '#1d4ed8' },
  accepted:  { label: 'Accepted',  bg: '#dcfce7', color: '#15803d' },
  rejected:  { label: 'Rejected',  bg: '#fee2e2', color: '#b91c1c' },
  expired:   { label: 'Expired',   bg: '#ede9fe', color: '#5b21b6' },
  revised:   { label: 'Revised',   bg: '#e0f2fe', color: '#0369a1' },
  converted: { label: 'Converted', bg: '#ede9fe', color: '#5b21b6' },
};

const FILTER_TABS = ['all', 'draft', 'sent', 'accepted', 'rejected', 'expired', 'revised', 'converted'];

// Client-side filter model. `/sales/quotations` returns the full unpaginated set,
// so every dimension below narrows rows already in memory — the same convention
// SalesOrders uses. Keeping them client-side is also what lets the chip counts,
// the KPI strip and the table describe the same window instead of three.
const DEFAULT_FILTERS = {
  customer:  'all',   // customer_name — COALESCE(parties.name, quotations.customer_name)
  from:      '',      // quotation_date >= from (YYYY-MM-DD, inclusive)
  to:        '',      // quotation_date <= to   (YYYY-MM-DD, inclusive)
  validity:  'all',   // all | valid | expiring | overdue
  minAmount: '',      // total_amount >= minAmount
  maxAmount: '',      // total_amount <= maxAmount
  discount:  'all',   // all | pending | approved | rejected | none
  revision:  'all',   // all | original | revised
};

const VALIDITY_OPTIONS = [
  { value: 'all',      label: 'Any validity' },
  { value: 'valid',    label: 'Still valid' },
  { value: 'expiring', label: 'Expiring in 7 days' },
  { value: 'overdue',  label: 'Past validity' },
];

// discount_approvals.status is pending | approved | rejected; a quotation that
// never needed an approval has no row at all, which is its own bucket.
const DISCOUNT_OPTIONS = [
  { value: 'all',      label: 'Any discount status' },
  { value: 'pending',  label: 'Approval pending' },
  { value: 'approved', label: 'Approval granted' },
  { value: 'rejected', label: 'Approval rejected' },
  { value: 'none',     label: 'No approval requested' },
];

const REVISION_OPTIONS = [
  { value: 'all',      label: 'All versions' },
  { value: 'original', label: 'Original only (v1)' },
  { value: 'revised',  label: 'Revised (v2+)' },
];

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

// ── Filter predicates ────────────────────────────────────────────────────────
// DATE columns come back from pg as 'YYYY-MM-DD' strings, so the date bounds
// compare lexicographically — no Date parsing, no timezone slide.
const dayKey   = (d) => (d ? String(d).slice(0, 10) : '');
const shiftKey = (key, days) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const validUntilOf = (q) => q.validity_date || q.valid_until;
// The same predicate the row's "Overdue" tag uses, so the filter and the tag
// can never disagree about which rows are past their validity date.
const isPastValidity = (q) =>
  isOverdue(validUntilOf(q)) && !['accepted', 'converted', 'rejected'].includes(q.status);

const matchesSearch = (q, term) => {
  const t = (term || '').trim().toLowerCase();
  if (!t) return true;
  return [q.quotation_number, q.customer_name, q.notes]
    .some(v => String(v ?? '').toLowerCase().includes(t));
};

const matchesStatus = (q, tab) => tab === 'all' || (q.status || 'draft') === tab;

const matchesFilters = (q, f, today) => {
  if (f.customer !== 'all' && (q.customer_name || '—') !== f.customer) return false;

  const qDate = dayKey(q.quotation_date);
  if (f.from && (!qDate || qDate < f.from)) return false;
  if (f.to   && (!qDate || qDate > f.to))   return false;

  if (f.validity !== 'all') {
    const vu = dayKey(validUntilOf(q));
    // No validity date means the question has no answer for this row — it
    // belongs to "Any validity" only, never to one of the three buckets.
    if (!vu) return false;
    if (f.validity === 'overdue'  && !isPastValidity(q)) return false;
    if (f.validity === 'valid'    && vu < today) return false;
    if (f.validity === 'expiring' && (vu < today || vu > shiftKey(today, 7))) return false;
  }

  // A half-typed bound parses to NaN; every comparison against it is false, so
  // the list stays put instead of emptying mid-keystroke.
  const amount = parseFloat(q.total_amount) || 0;
  if (f.minAmount !== '' && amount < parseFloat(f.minAmount)) return false;
  if (f.maxAmount !== '' && amount > parseFloat(f.maxAmount)) return false;

  if (f.discount !== 'all' && (q.discount_approval_status || 'none') !== f.discount) return false;

  if (f.revision !== 'all') {
    const ver = parseInt(q.version) || 1;
    if (f.revision === 'original' && ver !== 1) return false;
    if (f.revision === 'revised'  && ver <  2)  return false;
  }

  return true;
};

const activeFilterCount = (f) =>
  Object.keys(DEFAULT_FILTERS).filter(k => f[k] !== DEFAULT_FILTERS[k]).length;

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
const Quotations = ({ setPage, urlParams } = {}) => {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [quotations, setQuotations]   = useState([]);
  const [loading, setLoading]         = useState(false);
  const [activeTab, setActiveTab]     = useState('all');
  const [search, setSearch]           = useState('');
  const [filters, setFilters]         = useState(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
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

  // Arriving from "Create Quotation" on an Opportunity (OpportunitiesKanban.jsx) —
  // that action already created the real draft quotation server-side; land here
  // pre-filtered to it instead of a blank list.
  useEffect(() => {
    if (urlParams?.search) setSearch(urlParams.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // One unfiltered request. `/sales/quotations` has no LIMIT and the "All" tab
  // already pulled the whole set on mount, so filtering in memory costs nothing
  // and removes the refetch-per-keystroke the server-side search used to cause.
  // The former `/sales/quotations/stats` call is gone with it: it counted every
  // revision row while this table shows one row per family, so the KPI strip was
  // answering a different question than the table under it. The cards are now
  // derived from the rows in view.
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/sales/quotations');
      if (!isMounted.current) return;
      setQuotations(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (isMounted.current) setQuotations([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
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
  }, []);

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
        // formData.discount was always computed into totals client-side and
        // sent as `discount`, but quotations has no matching column, so the
        // number vanished on every save. Send it under the real column name
        // now that it's persisted (needed for the discount-approval gate).
        discount_pct: parseFloat(formData.discount || 0),
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

  // ── Filtering ──
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const setFilter = (key, value) => setFilters(f => ({ ...f, [key]: value }));
  const resetFilters = () => { setFilters(DEFAULT_FILTERS); setSearch(''); setActiveTab('all'); };

  // Options are derived from every loaded row, not from the filtered set, so
  // picking a customer never collapses the list you picked it out of.
  const customerOptions = useMemo(
    () => [...new Set(quotations.map(q => q.customer_name || '—'))].sort((a, b) => a.localeCompare(b)),
    [quotations]
  );

  // Everything except the status dimension, so the chip counts below are honest:
  // a chip never advertises rows the search or another control already removed.
  const preStatus = useMemo(
    () => quotations.filter(q => matchesSearch(q, search) && matchesFilters(q, filters, today)),
    [quotations, search, filters, today]
  );

  const statusCounts = useMemo(() => {
    const counts = Object.fromEntries(FILTER_TABS.map(t => [t, 0]));
    counts.all = preStatus.length;
    for (const q of preStatus) {
      const s = q.status || 'draft';
      if (s in counts && s !== 'all') counts[s] += 1;
    }
    return counts;
  }, [preStatus]);

  const filtered = useMemo(() => preStatus.filter(q => matchesStatus(q, activeTab)), [preStatus, activeTab]);

  const advancedCount = activeFilterCount(filters);
  const filterCount   = advancedCount + (search.trim() ? 1 : 0) + (activeTab !== 'all' ? 1 : 0);

  // ── KPI derivation (from the rows currently in view) ──
  const kpi = useMemo(() => {
    const total       = filtered.length;
    const accepted    = filtered.filter(q => q.status === 'accepted').length;
    const sentPending = filtered.filter(q => q.status === 'sent' || q.status === 'draft').length;
    const value       = filtered.reduce(
      (sum, q) => (['rejected', 'expired'].includes(q.status) ? sum : sum + (parseFloat(q.total_amount) || 0)),
      0
    );
    // No rows means no rate — 0.0% would read as "nothing was ever accepted".
    return { total, accepted, sentPending, value, rate: total ? (accepted / total) * 100 : null };
  }, [filtered]);

  const rateTone = kpi.rate == null ? '' : kpi.rate >= 50 ? 'sq-sum-green' : kpi.rate >= 30 ? 'sq-sum-orange' : 'sq-sum-red';

  return (
    <PageShell dock={
      <PageHero
        icon={FileText}
        eyebrow="Sales"
        title="Sales Quotations"
        subtitle="Manage, revise, and track customer quotations"
        actions={!readOnly && (
          <button className="plh-cta" onClick={handleNewQuotation}>
            <Plus size={14} /> New Quotation
          </button>
        )}
      />
    }>
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

      {/* ── KPI cards (derived from the filtered rows in view) ── */}
      <div className="sq-summary sq-summary-5">
        <div className="sq-sum-card">
          <span className="sq-sum-val">{kpi.total}</span>
          <span className="sq-sum-label">Total Quotations</span>
        </div>
        <div className="sq-sum-card">
          <span className="sq-sum-val sq-sum-green">{kpi.accepted}</span>
          <span className="sq-sum-label">Accepted</span>
        </div>
        <div className="sq-sum-card">
          <span className="sq-sum-val sq-sum-blue">{kpi.sentPending}</span>
          <span className="sq-sum-label">Sent / Pending</span>
        </div>
        <div className="sq-sum-card">
          <span className="sq-sum-val sq-sum-purple">{fmtL(kpi.value)}</span>
          <span className="sq-sum-label">Total Value</span>
        </div>
        <div className="sq-sum-card sq-sum-card-rate">
          <div className="sq-rate-row">
            <span className={`sq-sum-val ${rateTone}`}>
              {kpi.rate == null ? '—' : fmtPct(kpi.rate)}
            </span>
            <div className="sq-rate-bar-wrap">
              <div className="sq-rate-bar" style={{ width: `${Math.min(kpi.rate ?? 0, 100)}%`, background: kpi.rate == null ? '#e5e7eb' : kpi.rate >= 50 ? '#15803d' : kpi.rate >= 30 ? '#6d28d9' : '#b91c1c' }} />
            </div>
          </div>
          <span className="sq-sum-label">Acceptance Rate</span>
        </div>
      </div>

      {/* The cards above move with the filters, so say so rather than letting a
          narrowed total read as the company-wide one. */}
      {filterCount > 0 && (
        <div className="sq-filter-note">
          <SlidersHorizontal size={12} />
          <span>
            Showing <strong>{filtered.length}</strong> of <strong>{quotations.length}</strong> quotations
            {' — '}the cards above and the table below both reflect the active filters.
          </span>
          <button type="button" className="sq-filter-clear" onClick={resetFilters}>
            <RotateCcw size={11} /> Clear all
          </button>
        </div>
      )}

      {/* ── Status filter tabs ── */}
      <div className="sq-tabs">
        {FILTER_TABS.map(tab => (
          <button
            key={tab}
            className={`sq-tab-btn${activeTab === tab ? ' sq-tab-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'all' ? 'All' : STATUS_META[tab]?.label ?? tab}
            <span className="sq-tab-count">{statusCounts[tab] ?? 0}</span>
          </button>
        ))}
        <div className="sq-tab-search">
          <Search size={13} className="sq-search-icon" />
          <input
            type="text"
            aria-label="Search quotations"
            placeholder="Search quotation #, customer or notes…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" className="sq-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={11} />
            </button>
          )}
        </div>
        <button
          type="button"
          className={`sq-filter-toggle${showFilters ? ' sq-filter-toggle-on' : ''}`}
          onClick={() => setShowFilters(v => !v)}
          aria-expanded={showFilters}
        >
          <SlidersHorizontal size={13} /> Filters
          {advancedCount > 0 && <span className="sq-filter-badge">{advancedCount}</span>}
        </button>
      </div>

      {/* ── Advanced filters ── */}
      {showFilters && (
        <div className="sq-filters">
          <div className="sq-filters-grid">
            <div className="sq-field">
              <label htmlFor="sq-f-customer">Customer</label>
              <select id="sq-f-customer" value={filters.customer} onChange={e => setFilter('customer', e.target.value)}>
                <option value="all">All customers</option>
                {customerOptions.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
            <div className="sq-field">
              <label htmlFor="sq-f-from">Quoted from</label>
              <input id="sq-f-from" type="date" value={filters.from} max={filters.to || undefined}
                     onChange={e => setFilter('from', e.target.value)} />
            </div>
            <div className="sq-field">
              <label htmlFor="sq-f-to">Quoted to</label>
              <input id="sq-f-to" type="date" value={filters.to} min={filters.from || undefined}
                     onChange={e => setFilter('to', e.target.value)} />
            </div>
            <div className="sq-field">
              <label htmlFor="sq-f-validity">Validity</label>
              <select id="sq-f-validity" value={filters.validity} onChange={e => setFilter('validity', e.target.value)}>
                {VALIDITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="sq-field">
              <label htmlFor="sq-f-min">Min amount (₹)</label>
              <input id="sq-f-min" type="number" min="0" step="1000" placeholder="No minimum"
                     value={filters.minAmount} onChange={e => setFilter('minAmount', e.target.value)} />
            </div>
            <div className="sq-field">
              <label htmlFor="sq-f-max">Max amount (₹)</label>
              <input id="sq-f-max" type="number" min="0" step="1000" placeholder="No maximum"
                     value={filters.maxAmount} onChange={e => setFilter('maxAmount', e.target.value)} />
            </div>
            <div className="sq-field">
              <label htmlFor="sq-f-discount">Discount approval</label>
              <select id="sq-f-discount" value={filters.discount} onChange={e => setFilter('discount', e.target.value)}>
                {DISCOUNT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="sq-field">
              <label htmlFor="sq-f-revision">Version</label>
              <select id="sq-f-revision" value={filters.revision} onChange={e => setFilter('revision', e.target.value)}>
                {REVISION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="sq-filters-ft">
            <span className="sq-filters-hint">
              Dates read the quotation date; validity reads the valid-until date, matching the Overdue tag in the table.
            </span>
            <button type="button" className="sq-filter-clear" onClick={resetFilters} disabled={filterCount === 0}>
              <RotateCcw size={11} /> Clear all
            </button>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="sq-table-wrap">
        {loading ? (
          <div className="sq-empty"><RefreshCw size={28} className="sq-spin" color="#c4b5fd" /><p>Loading quotations…</p></div>
        ) : filtered.length === 0 ? (
          <div className="sq-empty">
            <FileText size={36} color="#c4b5fd" />
            {/* "nothing here" and "nothing matches" are different answers — a
                shared message is how a working filter looks broken. */}
            <p>{filterCount > 0 ? 'No quotations match your filters.' : 'No quotations yet.'}</p>
            {filterCount > 0 && (
              <button type="button" className="sq-filter-clear" onClick={resetFilters}>
                <RotateCcw size={11} /> Clear all filters
              </button>
            )}
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
              {filtered.map(q => {
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
                    <td>
                      <span className="sq-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                      {q.discount_approval_status === 'pending' && (
                        <div style={{ marginTop: 4 }}>
                          <span className="sq-badge" style={{ background: '#ede9fe', color: '#5b21b6', fontSize: 10 }} title="Discount exceeds the approval threshold; conversion is blocked until a sales manager decides">
                            Discount approval pending
                          </span>
                        </div>
                      )}
                      {q.discount_approval_status === 'rejected' && (
                        <div style={{ marginTop: 4 }}>
                          <span className="sq-badge" style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10 }} title="Discount request was rejected; adjust the discount or resubmit">
                            Discount rejected
                          </span>
                        </div>
                      )}
                    </td>
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
    </PageShell>
  );
};

export default Quotations;
