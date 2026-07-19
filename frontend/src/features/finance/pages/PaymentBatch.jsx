import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, Building2, FileText,
  ThumbsUp, ThumbsDown, Play, Clock, IndianRupee,
  ChevronRight, Banknote, Smartphone, Receipt, AlertCircle, Calendar,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmt, fmtFull, today } from '../financeUtils';
import './PaymentBatch.css';

const PaymentGatewayPanel = lazy(() => import('@/components/finance/PaymentGatewayPanel'));
const BankAccountsPanel   = lazy(() => import('@/features/finance/pages/BankAccounts'));
const PDCPanel            = lazy(() => import('@/features/finance/pages/PDCManagement'));
const ForexPanel          = lazy(() => import('@/features/finance/pages/ForexManagement'));

// ── constants ─────────────────────────────────────────────────────────────────
const PAYMENT_METHODS = [
  { value: 'neft',   label: 'NEFT',   icon: Banknote   },
  { value: 'rtgs',   label: 'RTGS',   icon: Banknote   },
  { value: 'imps',   label: 'IMPS',   icon: Smartphone },
  { value: 'upi',    label: 'UPI',    icon: Smartphone },
  { value: 'cheque', label: 'Cheque', icon: Receipt     },
  { value: 'cash',   label: 'Cash',   icon: IndianRupee  },
];

const BANK_FILE_FORMATS = [
  { value: 'sbi',     label: 'SBI'         },
  { value: 'hdfc',    label: 'HDFC'        },
  { value: 'icici',   label: 'ICICI'       },
  { value: 'generic', label: 'Generic CSV' },
];

const PAGE_TABS = [
  { key: 'batches', label: 'AP Payment Batches' },
  { key: 'bank',    label: 'Bank Accounts'      },
  { key: 'pdc',     label: 'PDC Management'     },
  { key: 'gateway', label: 'Payment Collection' },
  { key: 'forex',   label: 'Forex'              },
];

const statusMeta = (s) => {
  const map = {
    draft:            { bg: '#f3f4f6', color: '#6b7280', label: 'Draft'            },
    pending_approval: { bg: '#fef3c7', color: '#92400e', label: 'Pending Approval' },
    approved:         { bg: '#dbeafe', color: '#1d4ed8', label: 'Approved'         },
    processed:        { bg: '#dcfce7', color: '#16a34a', label: 'Processed'        },
    rejected:         { bg: '#fee2e2', color: '#dc2626', label: 'Rejected'         },
  };
  return map[s] || map.draft;
};

const emptyItem = () => ({
  supplier_id: '', supplier_name: '', bill_id: '', bill_ref: '',
  amount: 0, method: 'neft', reference: '', notes: '',
});

const firstOfMonth = () => {
  const d = new Date(); d.setDate(1);
  return d.toISOString().split('T')[0];
};

const TabSuspense = ({ children }) => (
  <Suspense fallback={
    <div style={{ padding: 48, textAlign: 'center', color: '#6B3FDB', fontSize: 14 }}>
      Loading…
    </div>
  }>
    {children}
  </Suspense>
);

// ── Main component ────────────────────────────────────────────────────────────
const FINANCE_APPROVE_ROLES = ['finance_manager', 'cfo', 'admin', 'super_admin', 'finance'];

export default function PaymentBatch() {
  const userRole = (() => { try { return localStorage.getItem('role') || ''; } catch { return ''; } })();
  const canApprove = FINANCE_APPROVE_ROLES.includes(userRole);

  const initialTab = (() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      return PAGE_TABS.some(p => p.key === t) ? t : 'batches';
    } catch { return 'batches'; }
  })();

  const [pageTab,          setPageTab]         = useState(initialTab);
  const [batches,          setBatches]         = useState([]);
  const [bankAccounts,     setBankAccounts]    = useState([]);
  const [suppliers,        setSuppliers]       = useState([]);
  const [billsBySupplier,  setBillsBySupplier] = useState({});
  const [kpis,             setKpis]            = useState(null);
  const [loading,          setLoading]         = useState(false);
  const [drawer,           setDrawer]          = useState(null);
  const [viewBatch,        setViewBatch]       = useState(null);
  const [search,           setSearch]          = useState('');
  const [statusFilter,     setStatusFilter]    = useState('');
  const [dateFrom,         setDateFrom]        = useState(firstOfMonth);
  const [dateTo,           setDateTo]          = useState(today);
  const [toast,            setToast]           = useState(null);
  const [submitting,       setSubmitting]      = useState(false);
  const [actioningId,      setActioningId]     = useState(null);
  const [bankFileBatch,    setBankFileBatch]   = useState(null);
  const [bankFileFormat,   setBankFileFormat]  = useState('generic');
  const [downloading,      setDownloading]     = useState(false);
  const abortRef = useRef(null);

  const [form, setForm] = useState({
    batch_number: '', batch_date: today(),
    bank_account_id: '', bank_account_name: '',
    payment_method_default: 'neft', notes: '',
    items: [emptyItem()],
  });

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search)       params.search = search;
      if (dateFrom)     params.from   = dateFrom;
      if (dateTo)       params.to     = dateTo;

      const [batchRes, bankRes, suppRes, kpiRes] = await Promise.allSettled([
        api.get('/finance/payment-batches', { params }),
        api.get('/finance/bank-accounts'),
        api.get('/finance/parties', { params: { party_type: 'Supplier' } }),
        api.get('/finance/payment-batches/summary'),
      ]);

      const raw = batchRes.status === 'fulfilled'
        ? (batchRes.value.data?.rows || batchRes.value.data?.batches || batchRes.value.data || [])
        : [];
      setBatches(Array.isArray(raw) ? raw : []);
      setBankAccounts(bankRes.status === 'fulfilled' ? (bankRes.value.data || []) : []);
      setSuppliers(suppRes.status   === 'fulfilled' ? (suppRes.value.data || []) : []);
      if (kpiRes.status === 'fulfilled') setKpis(kpiRes.value.data);
    } catch { setBatches([]); }
    finally  { setLoading(false); }
  }, [statusFilter, search, dateFrom, dateTo]);

  useEffect(() => { if (pageTab === 'batches') load(); }, [load, pageTab]);

  // ── item helpers ───────────────────────────────────────────────────────────
  const loadBillsForSupplier = async (supplierId) => {
    if (!supplierId || billsBySupplier[supplierId] !== undefined) return;
    try {
      const res  = await api.get('/finance/bills', { params: { supplier_id: supplierId, status: 'pending' } });
      const data = res.data?.rows || res.data?.bills || res.data || [];
      setBillsBySupplier(prev => ({ ...prev, [supplierId]: Array.isArray(data) ? data : [] }));
    } catch {
      setBillsBySupplier(prev => ({ ...prev, [supplierId]: [] }));
    }
  };

  const updateItem = (idx, field, val) => {
    setForm(f => ({
      ...f,
      items: f.items.map((it, i) => {
        if (i !== idx) return it;
        const upd = { ...it, [field]: val };
        if (field === 'supplier_id') {
          const sup = suppliers.find(s => String(s.id) === String(val));
          upd.supplier_name = sup?.name || sup?.party_name || '';
          upd.bill_id = ''; upd.bill_ref = ''; upd.amount = 0;
          loadBillsForSupplier(val);
        }
        if (field === 'bill_id') {
          const bill = (billsBySupplier[it.supplier_id] || []).find(b => String(b.id) === String(val));
          if (bill) {
            upd.bill_ref = bill.bill_number;
            upd.amount   = parseFloat(bill.balance || bill.outstanding || bill.amount || 0);
          }
        }
        return upd;
      }),
    }));
  };

  const addItem    = () => setForm(f => ({ ...f, items: [...f.items, emptyItem()] }));
  const removeItem = (idx) => {
    if (form.items.length <= 1) return;
    setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  };

  const batchTotal = form.items.reduce((s, i) => s + parseFloat(i.amount || 0), 0);

  const applyDefaultMethod = (method) => {
    setForm(f => ({
      ...f,
      payment_method_default: method,
      items: f.items.map(it => ({ ...it, method })),
    }));
  };

  const validateBatchPayments = () => {
    for (const it of form.items) {
      const amt = parseFloat(it.amount || 0);
      if (it.method === 'rtgs' && amt < 200000)
        return `RTGS min ₹2,00,000. ${it.supplier_name || 'A supplier'} has ₹${amt.toFixed(0)}.`;
      if (it.method === 'imps' && amt > 500000)
        return `IMPS max ₹5,00,000. ${it.supplier_name || 'A supplier'} has ₹${amt.toFixed(0)}.`;
    }
    return null;
  };

  // ── submit new batch ───────────────────────────────────────────────────────
  const handleSubmit = async (status = 'draft') => {
    if (!form.bank_account_id && !form.bank_account_name) {
      showToast('Select a bank account', 'error'); return;
    }
    if (form.items.some(i => !i.supplier_name || parseFloat(i.amount || 0) <= 0)) {
      showToast('Each payment needs a supplier and amount', 'error'); return;
    }
    const err = validateBatchPayments();
    if (err) { showToast(err, 'error'); return; }

    setSubmitting(true);
    try {
      await api.post('/finance/payment-batches', {
        ...form, status, total_amount: batchTotal,
        payment_count: form.items.length,
      });
      showToast(status === 'pending_approval' ? 'Batch submitted for approval' : 'Batch saved as draft');
      setDrawer(null);
      resetForm();
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to save batch', 'error');
    } finally { setSubmitting(false); }
  };

  // ── batch actions ──────────────────────────────────────────────────────────
  const handleAction = async (batch, action) => {
    if (actioningId) return;
    setActioningId(batch.id);
    const msgs = {
      submit:  'Batch submitted for approval',
      approve: 'Batch approved — ready to process',
      process: 'Batch processed — payments initiated',
      reject:  'Batch rejected',
    };
    try {
      await api.post(`/finance/payment-batches/${batch.id}/${action}`);
      showToast(msgs[action], action === 'reject' ? 'error' : 'success');
      load();
      if (viewBatch?.id === batch.id) setViewBatch(null);
    } catch (e) {
      showToast(e?.response?.data?.error || `Failed to ${action} batch`, 'error');
    } finally { setActioningId(null); }
  };

  // ── bank file download ─────────────────────────────────────────────────────
  const downloadBankFile = async (batch, format) => {
    setDownloading(true);
    try {
      const res = await api.get(`/finance/payment-batches/${batch.id}/bank-file`, {
        params: { format }, responseType: 'blob',
      });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a   = Object.assign(document.createElement('a'), {
        href: url, download: `batch-${batch.batch_number}-${format}.csv`,
      });
      a.click();
      URL.revokeObjectURL(url);
      setBankFileBatch(null);
    } catch (e) {
      let msg = 'Download failed';
      try {
        const text   = e?.response?.data instanceof Blob ? await e.response.data.text() : null;
        const parsed = text ? JSON.parse(text) : null;
        if (parsed?.missing_suppliers?.length)
          msg = `Missing bank details: ${parsed.missing_suppliers.join(', ')}`;
        else if (parsed?.error) msg = parsed.error;
      } catch { /* ignore parse error */ }
      showToast(msg, 'error');
    } finally { setDownloading(false); }
  };

  // ── payment advice PDF (print window) ─────────────────────────────────────
  const downloadPaymentAdvice = async (batch) => {
    try {
      const res  = await api.get(`/finance/payment-batches/${batch.id}`);
      const full = res.data;
      const items = full.items || [];
      const dateStr = full.batch_date
        ? new Date(full.batch_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
        : '';
      const totalFormatted = `₹${parseFloat(full.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Payment Advice — ${full.batch_number}</title>
<style>
  body{font-family:Arial,sans-serif;margin:0;padding:32px;color:#111;font-size:13px}
  .hd{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
  .brand{font-size:22px;font-weight:700;color:#6B3FDB}
  .title{font-size:18px;font-weight:700;margin:4px 0 2px}
  .sub{font-size:12px;color:#6b7280}
  .badge{display:inline-block;padding:2px 10px;border-radius:4px;font-size:11px;font-weight:600;background:#dcfce7;color:#16a34a}
  .meta{display:flex;gap:28px;margin-bottom:20px;background:#f9fafb;padding:14px 18px;border-radius:8px;flex-wrap:wrap}
  .meta-item label{display:block;font-size:10px;color:#6b7280;text-transform:uppercase;font-weight:600;margin-bottom:2px}
  .meta-item strong{font-size:14px;font-weight:700}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th{text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;padding:8px 10px;border-bottom:2px solid #e5e7eb}
  td{padding:10px;border-bottom:1px solid #f3f4f6;font-size:13px}
  .r{text-align:right;font-variant-numeric:tabular-nums}
  tfoot td{font-weight:700;font-size:14px;padding-top:14px;border-top:2px solid #111;border-bottom:none}
  .footer{margin-top:28px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px}
  @media print{body{padding:16px}}
</style>
</head>
<body>
<div class="hd">
  <div>
    <div class="brand">Pulse ERP</div>
    <div class="title">Payment Advice</div>
    <div class="sub">Batch ${full.batch_number} &middot; ${dateStr}</div>
  </div>
  <div style="text-align:right">
    <span class="badge">Processed</span><br>
    <span style="font-size:11px;color:#6b7280">Generated: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
  </div>
</div>
<div class="meta">
  <div class="meta-item"><label>Total Amount</label><strong>${totalFormatted}</strong></div>
  <div class="meta-item"><label>Payments</label><strong>${full.payment_count || items.length}</strong></div>
  <div class="meta-item"><label>Bank Account</label><strong>${full.bank_account || '—'}</strong></div>
  <div class="meta-item"><label>Mode</label><strong>${(full.payment_mode || '').toUpperCase() || '—'}</strong></div>
  ${full.notes ? `<div class="meta-item"><label>Notes</label><strong>${full.notes}</strong></div>` : ''}
</div>
<table>
  <thead><tr>
    <th>#</th><th>Supplier / Payee</th><th>Bill Reference</th>
    <th>Method</th><th>UTR / Reference</th><th class="r">Amount (₹)</th>
  </tr></thead>
  <tbody>
    ${items.map((it, i) => `<tr>
      <td>${i + 1}</td>
      <td>${it.supplier || it.supplier_name || it.party_name || '—'}</td>
      <td>${it.bill_ref || it.bill_number || '—'}</td>
      <td>${(it.method || it.payment_method || '').toUpperCase() || '—'}</td>
      <td>${it.utr || it.reference_number || '—'}</td>
      <td class="r">₹${parseFloat(it.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
    </tr>`).join('')}
  </tbody>
  <tfoot><tr><td colspan="5">Total</td><td class="r">${totalFormatted}</td></tr></tfoot>
</table>
<div class="footer">Computer-generated payment advice &mdash; Pulse ERP. Batch ${full.batch_number} processed on ${dateStr}.</div>
<script>window.onload=function(){window.print()}</script>
</body>
</html>`;
      const win = window.open('', '_blank', 'width=820,height=650');
      if (!win) { showToast('Allow pop-ups to download Payment Advice', 'error'); return; }
      win.document.write(html);
      win.document.close();
    } catch {
      showToast('Could not generate Payment Advice', 'error');
    }
  };

  // ── open view batch (fetches full detail with items) ───────────────────────
  const openViewBatch = async (batch) => {
    setViewBatch({ ...batch, items: null });
    try {
      const res = await api.get(`/finance/payment-batches/${batch.id}`);
      setViewBatch(res.data);
    } catch {
      setViewBatch(prev => ({ ...prev, items: [] }));
    }
  };

  // ── export batch list as CSV ───────────────────────────────────────────────
  const exportBatchList = () => {
    const header = 'Batch #,Date,Bank Account,Mode,Payments,Total Amount,Status\n';
    const body   = batches.map(b =>
      [b.batch_number, b.batch_date ? new Date(b.batch_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '',
       b.bank_account || '', b.payment_mode || '',
       b.payment_count || 0, b.total_amount || 0, b.status].join(',')
    ).join('\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([header + body], { type: 'text/csv' })),
      download: `payment-batches-${today()}.csv`,
    });
    a.click();
  };

  const resetForm = () => setForm({
    batch_number: '', batch_date: today(),
    bank_account_id: '', bank_account_name: '',
    payment_method_default: 'neft', notes: '', items: [emptyItem()],
  });

  useEffect(() => {
    if (drawer !== 'create') return;
    api.get('/finance/next-payment-batch-ref')
      .then(res => setForm(f => ({ ...f, batch_number: res.data.reference })))
      .catch(() => {
        setForm(f => ({
          ...f,
          batch_number: `PB-${new Date().getFullYear()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        }));
      });
  }, [drawer]);

  // ── derived stats ──────────────────────────────────────────────────────────
  const stats = kpis
    ? {
        totalProcessed:  kpis.processed_ytd,
        pendingApproval: kpis.pending_approval,
        approved:        kpis.approved_ready,
        draft:           kpis.draft_count,
        pendingCount:    kpis.pending_count,
        approvedCount:   kpis.approved_count,
        processedCount:  kpis.processed_ytd_count,
      }
    : {
        totalProcessed:  batches.filter(b => b.status === 'processed').reduce((s, b) => s + parseFloat(b.total_amount || 0), 0),
        pendingApproval: batches.filter(b => b.status === 'pending_approval').reduce((s, b) => s + parseFloat(b.total_amount || 0), 0),
        approved:        batches.filter(b => b.status === 'approved').reduce((s, b) => s + parseFloat(b.total_amount || 0), 0),
        draft:           batches.filter(b => b.status === 'draft').length,
        pendingCount:    batches.filter(b => b.status === 'pending_approval').length,
        approvedCount:   batches.filter(b => b.status === 'approved').length,
        processedCount:  batches.filter(b => b.status === 'processed').length,
      };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="pb-root">

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', paddingTop: 4, flexWrap: 'wrap' }}>
        {PAGE_TABS.map(t => (
          <button key={t.key} onClick={() => setPageTab(t.key)} style={{
            padding: '8px 20px', border: 'none', cursor: 'pointer',
            borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14,
            background: pageTab === t.key ? '#6B3FDB' : '#e9e4ff',
            color:      pageTab === t.key ? '#fff'    : '#6B3FDB',
          }}>{t.label}</button>
        ))}
      </div>

      {pageTab === 'bank'    && <TabSuspense><BankAccountsPanel /></TabSuspense>}
      {pageTab === 'pdc'     && <TabSuspense><PDCPanel /></TabSuspense>}
      {pageTab === 'forex'   && <TabSuspense><ForexPanel /></TabSuspense>}
      {pageTab === 'gateway' && <TabSuspense><PaymentGatewayPanel /></TabSuspense>}

      {/* ══════════════════════════════════════════════════════════════════════
          AP PAYMENT BATCHES TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {pageTab === 'batches' && (
        <div>

          {toast && (
            <div className={`pb-toast pb-toast-${toast.type}`}>
              {toast.type === 'success' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
              {toast.msg}
            </div>
          )}

          {/* Header */}
          <div className="pb-header">
            <div>
              <h2 className="pb-title">Payment Batches</h2>
              <p className="pb-sub">Bulk supplier payment scheduling &amp; processing</p>
            </div>
            <div className="pb-header-r">
              <button className="pb-btn-outline" onClick={exportBatchList}><Download size={14} /> Export CSV</button>
              <button className="pb-btn-primary" onClick={() => setDrawer('create')}>
                <Plus size={15} /> New Batch
              </button>
            </div>
          </div>

          {/* KPI cards */}
          <div className="pb-stats">
            <div className="pb-stat">
              <div className="pb-stat-icon" style={{ background: '#dcfce7', color: '#16a34a' }}><CheckCircle size={17} /></div>
              <div>
                <span className="pb-stat-label">Processed (YTD)</span>
                <span className="pb-stat-val">{fmt(stats.totalProcessed)}</span>
                <span className="pb-stat-sub">{stats.processedCount} batches</span>
              </div>
            </div>
            <div className="pb-stat pb-stat-amber">
              <div className="pb-stat-icon" style={{ background: '#fef3c7', color: '#d97706' }}><Clock size={17} /></div>
              <div>
                <span className="pb-stat-label">Pending Approval</span>
                <span className="pb-stat-val">{fmt(stats.pendingApproval)}</span>
                <span className="pb-stat-sub">{stats.pendingCount} batch{stats.pendingCount !== 1 ? 'es' : ''}</span>
              </div>
            </div>
            <div className="pb-stat pb-stat-blue">
              <div className="pb-stat-icon" style={{ background: '#dbeafe', color: '#1d4ed8' }}><Play size={17} /></div>
              <div>
                <span className="pb-stat-label">Approved — Ready</span>
                <span className="pb-stat-val">{fmt(stats.approved)}</span>
                <span className="pb-stat-sub">{stats.approvedCount} ready to process</span>
              </div>
            </div>
            <div className="pb-stat">
              <div className="pb-stat-icon" style={{ background: '#f3f4f6', color: '#6b7280' }}><FileText size={17} /></div>
              <div>
                <span className="pb-stat-label">Draft Batches</span>
                <span className="pb-stat-val">{stats.draft}</span>
                <span className="pb-stat-sub">Not submitted yet</span>
              </div>
            </div>
          </div>

          {/* Pending alert */}
          {stats.pendingCount > 0 && (
            <div className="pb-alert-banner">
              <Clock size={14} />
              <span>
                <strong>{stats.pendingCount} batch{stats.pendingCount > 1 ? 'es' : ''}</strong>
                {' '}awaiting approval — {fmt(stats.pendingApproval)} pending authorization
              </span>
              <button className="pb-alert-btn" onClick={() => setStatusFilter('pending_approval')}>
                Review Now <ChevronRight size={12} />
              </button>
            </div>
          )}

          {/* Filters */}
          <div className="pb-filters" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="pb-search">
              <Search size={14} />
              <input placeholder="Search batch # or bank…"
                value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button className="pb-clear" onClick={() => setSearch('')}><X size={12} /></button>}
            </div>

            {/* Date range */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Calendar size={14} color="#6B3FDB" />
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' }} />
              <span style={{ color: '#9ca3af', fontSize: 12 }}>to</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' }} />
              {(dateFrom !== firstOfMonth() || dateTo !== today()) && (
                <button onClick={() => { setDateFrom(firstOfMonth()); setDateTo(today()); }}
                  title="Reset to current month"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2 }}>
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="pb-filter-tabs">
              {[
                { value: '',                 label: 'All'       },
                { value: 'draft',            label: 'Draft'     },
                { value: 'pending_approval', label: 'Pending'   },
                { value: 'approved',         label: 'Approved'  },
                { value: 'processed',        label: 'Processed' },
                { value: 'rejected',         label: 'Rejected'  },
              ].map(s => (
                <button key={s.value}
                  className={`pb-filter-tab${statusFilter === s.value ? ' active' : ''}`}
                  onClick={() => setStatusFilter(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Batch cards */}
          {loading ? (
            <div className="pb-loading"><div className="pb-spinner" /><p>Loading batches…</p></div>
          ) : batches.length === 0 ? (
            <div className="pb-empty">
              <div style={{ fontSize: 40, color: '#d1d5db', lineHeight: 1 }}>⟳</div>
              <p>No payment batches found</p>
              <button className="pb-btn-primary" onClick={() => setDrawer('create')}>
                <Plus size={14} /> Create First Batch
              </button>
            </div>
          ) : (
            <div className="pb-cards">
              {batches.map((batch, i) => {
                const sm = statusMeta(batch.status);
                return (
                  <div key={batch.id || i} className="pb-card">
                    <div className="pb-card-hd">
                      <div className="pb-card-left">
                        <button className="pb-batch-num" onClick={() => openViewBatch(batch)}>
                          {batch.batch_number}
                        </button>
                        <span className="pb-batch-date">
                          {batch.batch_date
                            ? new Date(batch.batch_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                            : '—'}
                        </span>
                      </div>
                      <span className="pb-status-badge" style={{ background: sm.bg, color: sm.color }}>
                        {sm.label}
                      </span>
                    </div>

                    <div className="pb-card-body">
                      <div className="pb-card-meta">
                        <div className="pb-card-meta-item">
                          <FileText size={12} />
                          <span>{batch.payment_count || 0} payment{batch.payment_count !== 1 ? 's' : ''}</span>
                        </div>
                        {batch.bank_account && (
                          <div className="pb-card-meta-item">
                            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', background: '#f0f0f4', borderRadius: 4 }}>
                              {batch.bank_account}
                            </span>
                          </div>
                        )}
                        {batch.payment_mode && (
                          <span className="pb-method-pill">{batch.payment_mode.toUpperCase()}</span>
                        )}
                      </div>
                      <div className="pb-card-amount">{fmtFull(batch.total_amount)}</div>
                    </div>

                    <div className="pb-card-footer">
                      <button className="pb-card-view-btn" onClick={() => openViewBatch(batch)}>
                        <span style={{ fontSize: 11 }}>👁</span> View
                      </button>
                      <div className="pb-card-actions">
                        {batch.status === 'draft' && (
                          <button className="pb-action-submit" disabled={!!actioningId}
                            onClick={() => handleAction(batch, 'submit')}>
                            {actioningId === batch.id ? 'Submitting…' : 'Submit for Approval'}
                          </button>
                        )}
                        {batch.status === 'pending_approval' && canApprove && (
                          <>
                            <button className="pb-action-approve" disabled={!!actioningId}
                              onClick={() => handleAction(batch, 'approve')}>
                              <ThumbsUp size={12} /> {actioningId === batch.id ? 'Approving…' : 'Approve'}
                            </button>
                            <button className="pb-action-reject" disabled={!!actioningId}
                              onClick={() => handleAction(batch, 'reject')}>
                              <ThumbsDown size={12} /> Reject
                            </button>
                          </>
                        )}
                        {batch.status === 'approved' && canApprove && (
                          <>
                            <button className="pb-action-process" disabled={!!actioningId}
                              onClick={() => handleAction(batch, 'process')}>
                              <Play size={12} /> {actioningId === batch.id ? 'Processing…' : 'Process'}
                            </button>
                            <button className="pb-btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}
                              onClick={() => setBankFileBatch(batch)}>
                              <Download size={11} /> Bank File
                            </button>
                          </>
                        )}
                        {batch.status === 'processed' && (
                          <>
                            <button className="pb-btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}
                              onClick={() => setBankFileBatch(batch)}>
                              <Download size={11} /> Bank File
                            </button>
                            <button className="pb-btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}
                              onClick={() => downloadPaymentAdvice(batch)}>
                              <FileText size={11} /> Advice
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Bank File Format Picker ──────────────────────────────────── */}
          {bankFileBatch && (
            <div className="pb-overlay" onClick={() => setBankFileBatch(null)}>
              <div style={{
                background: '#fff', borderRadius: 14, width: 360, padding: 28,
                boxShadow: '0 20px 50px rgba(0,0,0,.2)',
              }} onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Download Bank File</h3>
                <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>
                  {bankFileBatch.batch_number} · {fmtFull(bankFileBatch.total_amount)}
                </p>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 8 }}>
                  Select bank format
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
                  {BANK_FILE_FORMATS.map(f => (
                    <button key={f.value} onClick={() => setBankFileFormat(f.value)} style={{
                      padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                      border: bankFileFormat === f.value ? '2px solid #6B3FDB' : '1px solid #d1d5db',
                      background: bankFileFormat === f.value ? '#f5f3ff' : '#fff',
                      color: bankFileFormat === f.value ? '#6B3FDB' : '#374151',
                    }}>{f.label}</button>
                  ))}
                </div>
                <p style={{ fontSize: 11, color: '#9ca3af', marginBottom: 16 }}>
                  Supplier bank details (account number + IFSC) must be saved in party records.
                </p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setBankFileBatch(null)}
                    style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                    Cancel
                  </button>
                  <button disabled={downloading}
                    onClick={() => downloadBankFile(bankFileBatch, bankFileFormat)}
                    style={{ padding: '8px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    {downloading ? 'Downloading…' : '⬇ Download CSV'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── View Batch Drawer ────────────────────────────────────────── */}
          {viewBatch && !drawer && (
            <div className="pb-overlay" onClick={() => setViewBatch(null)}>
              <div className="pb-drawer pb-drawer-wide" onClick={e => e.stopPropagation()}>
                <div className="pb-drawer-hd">
                  <div>
                    <h3 className="pb-drawer-title">{viewBatch.batch_number}</h3>
                    <div className="pb-drawer-meta">
                      <span className="pb-status-badge" style={statusMeta(viewBatch.status)}>
                        {statusMeta(viewBatch.status).label}
                      </span>
                      <span className="pb-drawer-date">
                        {viewBatch.batch_date
                          ? new Date(viewBatch.batch_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                          : ''}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {(viewBatch.status === 'approved' || viewBatch.status === 'processed') && (
                      <button className="pb-btn-outline"
                        onClick={() => { setViewBatch(null); setBankFileBatch(viewBatch); }}>
                        <Download size={13} /> Bank File
                      </button>
                    )}
                    {viewBatch.status === 'processed' && (
                      <button className="pb-btn-outline"
                        onClick={() => downloadPaymentAdvice(viewBatch)}>
                        <FileText size={13} /> Payment Advice
                      </button>
                    )}
                    <button className="pb-icon-btn" onClick={() => setViewBatch(null)}><span>✕</span></button>
                  </div>
                </div>

                <div className="pb-view-body">
                  <div className="pb-view-strip">
                    <div className="pb-vs-item"><span>Total Amount</span><strong>{fmtFull(viewBatch.total_amount)}</strong></div>
                    <div className="pb-vs-item"><span>Payments</span><strong>{viewBatch.payment_count || 0}</strong></div>
                    <div className="pb-vs-item"><span>Bank Account</span><strong>{viewBatch.bank_account || '—'}</strong></div>
                    <div className="pb-vs-item"><span>Date</span><strong>{viewBatch.batch_date ? new Date(viewBatch.batch_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</strong></div>
                    {viewBatch.payment_mode && (
                      <div className="pb-vs-item"><span>Mode</span><strong>{viewBatch.payment_mode.toUpperCase()}</strong></div>
                    )}
                  </div>

                  <div className="pb-workflow">
                    {[
                      { step: 'Created',   done: true },
                      { step: 'Submitted', done: ['pending_approval', 'approved', 'processed', 'rejected'].includes(viewBatch.status) },
                      { step: 'Approved',  done: ['approved', 'processed'].includes(viewBatch.status) },
                      { step: 'Processed', done: viewBatch.status === 'processed' },
                    ].map((w, i, arr) => (
                      <div key={i} className="pb-wf-step">
                        <div className={`pb-wf-dot ${w.done ? 'pb-wf-done' : ''}`}>
                          {w.done && <CheckCircle size={12} color="#fff" />}
                        </div>
                        <span className={`pb-wf-label ${w.done ? 'pb-wf-label-done' : ''}`}>{w.step}</span>
                        {i < arr.length - 1 && <div className={`pb-wf-line ${arr[i + 1].done ? 'pb-wf-line-done' : ''}`} />}
                      </div>
                    ))}
                  </div>

                  <div className="pb-view-items">
                    <h4>Payment Items</h4>
                    {viewBatch.items === null ? (
                      <p style={{ color: '#9ca3af', fontSize: 13 }}>Loading items…</p>
                    ) : (viewBatch.items || []).length === 0 ? (
                      <p style={{ color: '#9ca3af', fontSize: 13 }}>No items in this batch yet.</p>
                    ) : (
                      <table className="pb-items-table">
                        <thead>
                          <tr>
                            <th>Supplier</th><th>Bill Ref</th>
                            <th>Method</th><th>UTR / Ref</th>
                            <th className="pb-th-r">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(viewBatch.items || []).map((item, i) => (
                            <tr key={i}>
                              <td>
                                <div className="pb-item-sup-cell">
                                  <div className="pb-item-sup-av">
                                    {(item.supplier || item.supplier_name || item.party_name || 'S').charAt(0).toUpperCase()}
                                  </div>
                                  <span>{item.supplier || item.supplier_name || item.party_name || '—'}</span>
                                </div>
                              </td>
                              <td><span className="pb-bill-ref">{item.bill_ref || item.bill_number || '—'}</span></td>
                              <td><span className="pb-method-badge">{(item.method || item.payment_method || 'neft').toUpperCase()}</span></td>
                              <td>{item.utr ? <span className="pb-utr">{item.utr}</span> : <span className="pb-utr-pending">—</span>}</td>
                              <td className="pb-th-r pb-item-amt">{fmtFull(item.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={4}><strong>Total</strong></td>
                            <td className="pb-th-r"><strong>{fmtFull(viewBatch.total_amount)}</strong></td>
                          </tr>
                        </tfoot>
                      </table>
                    )}
                  </div>

                  <div className="pb-view-actions">
                    {viewBatch.status === 'draft' && (
                      <button className="pb-full-submit" onClick={() => handleAction(viewBatch, 'submit')}>
                        Submit for Approval
                      </button>
                    )}
                    {viewBatch.status === 'pending_approval' && canApprove && (
                      <>
                        <button className="pb-full-approve" onClick={() => handleAction(viewBatch, 'approve')}>
                          <ThumbsUp size={14} /> Approve Batch
                        </button>
                        <button className="pb-full-reject" onClick={() => handleAction(viewBatch, 'reject')}>
                          <ThumbsDown size={14} /> Reject
                        </button>
                      </>
                    )}
                    {viewBatch.status === 'approved' && canApprove && (
                      <button className="pb-full-process" onClick={() => handleAction(viewBatch, 'process')}>
                        <Play size={14} /> Process Payments
                      </button>
                    )}
                    {viewBatch.status === 'processed' && (
                      <>
                        <div className="pb-processed-badge">
                          <CheckCircle size={16} color="#10b981" />
                          All payments processed successfully
                        </div>
                        <button className="pb-btn-outline" style={{ marginTop: 10 }}
                          onClick={() => downloadPaymentAdvice(viewBatch)}>
                          <FileText size={14} /> Download Payment Advice
                        </button>
                      </>
                    )}
                    {viewBatch.status === 'rejected' && (
                      <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 16px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <AlertCircle size={16} />
                        Batch rejected{viewBatch.rejection_reason ? ` — ${viewBatch.rejection_reason}` : ''}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Create Batch Drawer ──────────────────────────────────────── */}
          {drawer === 'create' && (
            <div className="pb-overlay" onClick={() => setDrawer(null)}>
              <div className="pb-drawer" onClick={e => e.stopPropagation()}>
                <div className="pb-drawer-hd">
                  <div>
                    <h3>New Payment Batch</h3>
                    <p className="pb-drawer-sub">Group multiple supplier payments</p>
                  </div>
                  <button className="pb-icon-btn" onClick={() => setDrawer(null)}><span>✕</span></button>
                </div>

                <div className="pb-form-body">
                  <div className="pb-form-row">
                    <div className="pb-field">
                      <label>Batch Reference</label>
                      <input value={form.batch_number}
                        onChange={e => setForm(f => ({ ...f, batch_number: e.target.value }))} />
                    </div>
                    <div className="pb-field">
                      <label>Payment Date *</label>
                      <input type="date" value={form.batch_date}
                        onChange={e => setForm(f => ({ ...f, batch_date: e.target.value }))} />
                    </div>
                  </div>

                  <div className="pb-field">
                    <label>Paying From (Bank Account) *</label>
                    <div className="pb-bank-cards">
                      {bankAccounts.length === 0 && (
                        <p style={{ color: '#9ca3af', fontSize: 13, padding: '12px 0' }}>No bank accounts configured</p>
                      )}
                      {bankAccounts.map(ba => (
                        <div key={ba.id}
                          className={`pb-bank-card ${form.bank_account_id === String(ba.id) ? 'pb-bank-selected' : ''}`}
                          onClick={() => setForm(f => ({
                            ...f,
                            bank_account_id: String(ba.id),
                            bank_account_name: `${ba.account_name} ••${(ba.account_number || '').slice(-4)}`,
                          }))}>
                          <div className="pb-bank-icon"><Building2 size={16} /></div>
                          <div>
                            <p className="pb-bank-name">{ba.account_name}</p>
                            <p className="pb-bank-num">••{(ba.account_number || '').slice(-4)} · {ba.bank_name || ba.bank || ''}</p>
                            <p className="pb-bank-bal">Balance: {fmt(ba.current_balance || ba.balance)}</p>
                          </div>
                          {form.bank_account_id === String(ba.id) && (
                            <CheckCircle size={16} color="#6366f1" className="pb-bank-check" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="pb-field">
                    <label>Default Payment Method</label>
                    <div className="pb-method-row">
                      {PAYMENT_METHODS.map(m => (
                        <button key={m.value}
                          className={`pb-method-btn ${form.payment_method_default === m.value ? 'active' : ''}`}
                          onClick={() => applyDefaultMethod(m.value)}>
                          <m.icon size={13} /> {m.label}
                        </button>
                      ))}
                    </div>
                    {form.payment_method_default === 'rtgs' && (
                      <p style={{ fontSize: 11, color: '#d97706', marginTop: 4 }}>⚠ RTGS minimum ₹2,00,000 per payment</p>
                    )}
                    {form.payment_method_default === 'imps' && (
                      <p style={{ fontSize: 11, color: '#d97706', marginTop: 4 }}>⚠ IMPS maximum ₹5,00,000 per payment</p>
                    )}
                  </div>

                  <div className="pb-items-section">
                    <div className="pb-items-hd">
                      <span>Payment Items ({form.items.length})</span>
                      <button className="pb-add-item" onClick={addItem}><Plus size={12} /> Add Payment</button>
                    </div>

                    {form.items.map((item, idx) => (
                      <div key={idx} className="pb-item-row">
                        <div className="pb-item-num">{idx + 1}</div>
                        <div className="pb-item-fields">
                          <div className="pb-item-row-top">
                            <div className="pb-field pb-field-flex2">
                              <label>Supplier</label>
                              <select value={item.supplier_id}
                                onChange={e => updateItem(idx, 'supplier_id', e.target.value)}>
                                <option value="">— Select Supplier —</option>
                                {suppliers.map(s => (
                                  <option key={s.id} value={s.id}>
                                    {s.name || s.party_name}
                                    {s.outstanding > 0 ? ` (₹${parseInt(s.outstanding).toLocaleString('en-IN')})` : ''}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="pb-field pb-field-flex2">
                              <label>Bill / Invoice</label>
                              <select value={item.bill_id}
                                onChange={e => updateItem(idx, 'bill_id', e.target.value)}
                                disabled={!item.supplier_id}>
                                <option value="">— Select Bill —</option>
                                {(billsBySupplier[item.supplier_id] || []).map(b => (
                                  <option key={b.id} value={b.id}>
                                    {b.bill_number} — {fmt(b.balance || b.outstanding || b.amount || 0)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="pb-field pb-field-flex1">
                              <label>Amount (₹)</label>
                              <input type="number" min="0" step="0.01"
                                value={item.amount || ''}
                                onChange={e => updateItem(idx, 'amount', e.target.value)}
                                placeholder="0.00" />
                            </div>
                          </div>
                          <div className="pb-item-row-bot">
                            <div className="pb-field pb-field-flex1">
                              <label>Method</label>
                              <select value={item.method}
                                onChange={e => updateItem(idx, 'method', e.target.value)}>
                                {PAYMENT_METHODS.map(m => (
                                  <option key={m.value} value={m.value}>{m.label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="pb-field pb-field-flex2">
                              <label>Reference / UTR <span className="pb-opt">(optional)</span></label>
                              <input value={item.reference}
                                onChange={e => updateItem(idx, 'reference', e.target.value)}
                                placeholder="Cheque #, UTR, UPI ID…" />
                            </div>
                            <div className="pb-field pb-field-flex2">
                              <label>Notes <span className="pb-opt">(optional)</span></label>
                              <input value={item.notes}
                                onChange={e => updateItem(idx, 'notes', e.target.value)}
                                placeholder="Note…" />
                            </div>
                          </div>
                        </div>
                        <button className="pb-remove-item" onClick={() => removeItem(idx)}
                          disabled={form.items.length <= 1}><span>✕</span></button>
                      </div>
                    ))}

                    <div className="pb-batch-total">
                      <span>Batch Total ({form.items.length} payments)</span>
                      <strong>{fmtFull(batchTotal)}</strong>
                    </div>

                    {form.bank_account_id && (() => {
                      const ba  = bankAccounts.find(b => String(b.id) === String(form.bank_account_id));
                      const bal = parseFloat(ba?.current_balance || ba?.balance || 0);
                      return ba && batchTotal > bal ? (
                        <div className="pb-balance-warn">
                          <AlertTriangle size={13} />
                          <span>Batch total {fmt(batchTotal)} exceeds bank balance {fmt(bal)}</span>
                        </div>
                      ) : ba ? (
                        <div className="pb-balance-ok">
                          <CheckCircle size={13} />
                          <span>Sufficient balance — Remaining: {fmt(bal - batchTotal)}</span>
                        </div>
                      ) : null;
                    })()}
                  </div>

                  <div className="pb-field">
                    <label>Batch Notes</label>
                    <textarea rows={2} value={form.notes}
                      onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                      placeholder="Notes about this payment batch…" />
                  </div>

                  <div className="pb-form-footer">
                    <button className="pb-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                    <button className="pb-btn-outline" onClick={() => handleSubmit('draft')} disabled={submitting}>
                      Save Draft
                    </button>
                    <button className="pb-btn-primary" onClick={() => handleSubmit('pending_approval')} disabled={submitting}>
                      {submitting ? 'Submitting…' : 'Submit for Approval'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      )}{/* end batches tab */}

    </div>
  );
}
