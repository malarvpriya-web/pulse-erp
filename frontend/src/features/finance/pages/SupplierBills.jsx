import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, Printer, Clock, FileText,
  Calendar, RefreshCw,
  ThumbsUp, ThumbsDown, CreditCard, AlertCircle, RotateCcw,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmt, fmtFull, today, addDays, GST_RATES, emptyItem, calcItem, statusColor } from '../financeUtils';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';
import './SupplierBills.css';

const PAYMENT_METHODS = ['Bank Transfer', 'NEFT', 'RTGS', 'Cheque', 'UPI', 'Cash'];

const TDS_SECTIONS = [
  { code: '194C',  label: '194C — Contractor',             ri: 1,   rc: 2   },
  { code: '194J',  label: '194J — Professional Fees',      ri: 10,  rc: 10  },
  { code: '194H',  label: '194H — Commission / Brokerage', ri: 5,   rc: 5   },
  { code: '194I',  label: '194I — Rent',                   ri: 10,  rc: 10  },
  { code: '194Q',  label: '194Q — Purchase of Goods',      ri: 0.1, rc: 0.1 },
  { code: '194R',  label: '194R — Benefit / Perquisite',   ri: 10,  rc: 10  },
  { code: '194M',  label: '194M — Contractor (Indiv)',      ri: 5,   rc: 5   },
  { code: '194IA', label: '194IA — Immovable Property',    ri: 1,   rc: 1   },
];

const fyDates = () => {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
};

const daysUntilDue = (due) => {
  if (!due) return null;
  return Math.ceil((new Date(due) - new Date()) / 86400000);
};

const normalizeStatus = (s) => (s || '').toLowerCase();

const fmtCell = (v) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const EMPTY_FORM = () => ({
  supplier_id: '', supplier_name: '',
  bill_number: '', bill_date: today(),
  due_date: addDays(today(), 30),
  payment_terms: 30, reference: '', notes: '',
  items: [emptyItem()],
  tds_applicable: false,
  tds_section: '', tds_payee_type: 'company',
  tds_rate: 0, pan_available: true,
});

export default function SupplierBills() {
  const { fyParams } = useFY();
  const fy = fyDates();
  const [bills,          setBills]          = useState([]);
  const [suppliers,      setSuppliers]      = useState([]);
  const [apiStats,       setApiStats]       = useState(null);
  const [loading,        setLoading]        = useState(false);
  const [drawer,         setDrawer]         = useState(null);
  const [viewBill,       setViewBill]       = useState(null);
  const [payModal,       setPayModal]       = useState(null);
  const [approveModal,   setApproveModal]   = useState(null); // { bill, comment }
  const [rejectModal,    setRejectModal]    = useState(null); // { bill, reason }
  const [search,         setSearch]         = useState('');
  const [statusFilter,   setStatusFilter]   = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [dateFrom,       setDateFrom]       = useState(fy.from);
  const [dateTo,         setDateTo]         = useState(fy.to);
  const [toast,          setToast]          = useState(null);
  const [submitting,     setSubmitting]     = useState(false);

  const [form, setForm] = useState(EMPTY_FORM());

  const [payForm, setPayForm] = useState({
    amount: '', payment_date: today(),
    payment_method: 'Bank Transfer',
    reference_number: '', notes: '',
  });

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [billsRes, suppRes, statsRes] = await Promise.allSettled([
        api.get('/finance/bills', { params: { date_from: dateFrom, date_to: dateTo } }),
        api.get('/finance/parties', { params: { party_type: 'Supplier' } }),
        api.get('/finance/bills/stats'),
      ]);
      const raw = billsRes.status === 'fulfilled'
        ? (billsRes.value.data?.rows || billsRes.value.data?.bills || billsRes.value.data || [])
        : [];
      setBills(Array.isArray(raw) ? raw.map(b => ({ ...b, status: normalizeStatus(b.status) })) : []);
      setSuppliers(suppRes.status === 'fulfilled' ? (suppRes.value.data || []) : []);
      if (statsRes.status === 'fulfilled') setApiStats(statsRes.value.data);
    } catch (err) {
      setBills([]);
      showToast('Failed to load bills. Please refresh.', 'error');
      console.error('load bills failed:', err?.message);
    } finally { setLoading(false); }
  }, [dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // Sync the date range whenever the global Financial Year changes
  useEffect(() => {
    setDateFrom(fyParams.fyStart);
    setDateTo(fyParams.fyEnd);
  }, [fyParams.fyStart, fyParams.fyEnd]);

  // ── item helpers ─────────────────────────────────────────────────────────
  const updateItem = (idx, field, val) =>
    setForm(f => ({ ...f, items: f.items.map((it, i) => i === idx ? calcItem({ ...it, [field]: val }) : it) }));
  const addItem    = () => setForm(f => ({ ...f, items: [...f.items, emptyItem()] }));
  const removeItem = (idx) => {
    if (form.items.length <= 1) return;
    setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  };

  const totals = {
    subtotal: form.items.reduce((s, i) => s + (parseFloat(i.taxable_amount) || 0), 0),
    gst:      form.items.reduce((s, i) => s + (parseFloat(i.gst_amount) || 0), 0),
    total:    form.items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0),
  };

  // Auto-calculate TDS from form
  const tdsCalc = form.tds_applicable
    ? Math.round(totals.subtotal * (parseFloat(form.tds_rate) || 0) / 100 * 100) / 100
    : 0;
  const netPayable = totals.total - tdsCalc;

  // When TDS section changes, auto-fill rate
  const handleTdsSection = (code) => {
    const sec = TDS_SECTIONS.find(s => s.code === code);
    if (!sec) { setForm(f => ({ ...f, tds_section: code, tds_rate: 0 })); return; }
    let rate = form.tds_payee_type === 'individual' ? sec.ri : sec.rc;
    if (!form.pan_available) rate = Math.max((rate || 0) * 2, 20);
    setForm(f => ({ ...f, tds_section: code, tds_rate: rate }));
  };

  const handleTdsPayeeType = (ptype) => {
    const sec = TDS_SECTIONS.find(s => s.code === form.tds_section);
    if (!sec) { setForm(f => ({ ...f, tds_payee_type: ptype })); return; }
    let rate = ptype === 'individual' ? sec.ri : sec.rc;
    if (!form.pan_available) rate = Math.max((rate || 0) * 2, 20);
    setForm(f => ({ ...f, tds_payee_type: ptype, tds_rate: rate }));
  };

  const handleSubmit = async (status = 'pending') => {
    if (!form.supplier_name && !form.supplier_id) {
      showToast('Select a supplier', 'error'); return;
    }
    setSubmitting(true);
    try {
      await api.post('/finance/bills', {
        ...form, status,
        subtotal: totals.subtotal,
        tax_amount: totals.gst,
        total_amount: totals.total,
        tds_section:  form.tds_applicable ? form.tds_section || null : null,
        tds_rate:     form.tds_applicable ? parseFloat(form.tds_rate) || 0 : 0,
        tds_amount:   form.tds_applicable ? tdsCalc : 0,
        net_payable:  form.tds_applicable ? netPayable : totals.total,
      });
      showToast('Bill recorded successfully');
      setDrawer(null);
      setForm(EMPTY_FORM());
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to save bill', 'error');
    } finally { setSubmitting(false); }
  };

  const handleApprove = async () => {
    const { bill, comment } = approveModal;
    try {
      await api.post(`/finance/bills/${bill.id}/approve`, { comment });
      setBills(p => p.map(b => b.id === bill.id ? { ...b, status: 'approved' } : b));
      if (viewBill?.id === bill.id) setViewBill(v => ({ ...v, status: 'approved' }));
      setApproveModal(null);
      showToast(`Bill ${bill.bill_number} approved`);
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to approve bill', 'error');
    }
  };

  const handleReject = async () => {
    const { bill, reason } = rejectModal;
    try {
      await api.post(`/finance/bills/${bill.id}/reject`, { reason });
      setBills(p => p.map(b => b.id === bill.id ? { ...b, status: 'rejected' } : b));
      if (viewBill?.id === bill.id) setViewBill(v => ({ ...v, status: 'rejected' }));
      setRejectModal(null);
      showToast(`Bill ${bill.bill_number} rejected`, 'error');
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to reject bill', 'error');
    }
  };

  const handleResubmit = async (bill) => {
    try {
      await api.post(`/finance/bills/${bill.id}/resubmit`, {});
      setBills(p => p.map(b => b.id === bill.id ? { ...b, status: 'pending' } : b));
      if (viewBill?.id === bill.id) setViewBill(v => ({ ...v, status: 'pending' }));
      showToast(`Bill ${bill.bill_number} re-submitted for approval`);
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to re-submit bill', 'error');
    }
  };

  const openPayModal = (bill) => {
    setPayForm({
      amount: parseFloat(bill.balance || bill.net_payable || bill.total_amount || 0).toFixed(2),
      payment_date: today(),
      payment_method: 'Bank Transfer',
      reference_number: '', notes: '',
    });
    setPayModal(bill);
  };

  const handlePaySubmit = async () => {
    const bill = payModal;
    const amt = parseFloat(payForm.amount);
    if (!amt || amt <= 0) { showToast('Enter a valid amount', 'error'); return; }
    setSubmitting(true);
    try {
      await api.post('/finance/payments', {
        payment_date:     payForm.payment_date,
        payment_type:     'outward',
        party_id:         bill.supplier_id,
        amount:           amt,
        payment_method:   payForm.payment_method,
        reference_number: payForm.reference_number,
        notes:            payForm.notes,
        allocations:      [{ bill_id: bill.id, amount: amt }],
      });
      showToast(`Payment of ${fmt(amt)} recorded for ${bill.bill_number}`);
      setPayModal(null);
      setViewBill(null);
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to record payment', 'error');
    } finally { setSubmitting(false); }
  };

  const handleExport = () => {
    const headers = ['Bill #', 'Supplier', 'Bill Date', 'Due Date', 'Taxable', 'GST', 'TDS', 'Net Payable', 'Status'];
    const rows = filtered.map(b => [
      b.bill_number,
      b.supplier_name || '',
      b.bill_date ? new Date(b.bill_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '',
      b.due_date  ? new Date(b.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })  : '',
      parseFloat(b.subtotal    || 0).toFixed(2),
      parseFloat(b.tax_amount  || 0).toFixed(2),
      parseFloat(b.tds_amount  || 0).toFixed(2),
      parseFloat(b.net_payable ?? b.total_amount ?? 0).toFixed(2),
      b.status,
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `bills_${today()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const filtered = bills.filter(b => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (b.bill_number || '').toLowerCase().includes(q) ||
      (b.supplier_name || '').toLowerCase().includes(q);
    const matchStatus   = !statusFilter   || normalizeStatus(b.status) === statusFilter;
    const matchSupplier = !supplierFilter || String(b.supplier_id) === String(supplierFilter);
    return matchSearch && matchStatus && matchSupplier;
  });

  const stats = apiStats ? {
    total:           apiStats.totalAmountYtd,
    totalCount:      apiStats.totalBills,
    pending:         apiStats.pendingAmount,
    overdue:         apiStats.overdueAmount,
    paid:            apiStats.paidMonthAmount,
    overdueCount:    apiStats.overdueCount,
    pendingApproval: apiStats.awaitingApproval,
    paidMonthCount:  apiStats.paidMonthCount,
  } : {
    total:           bills.reduce((s, b) => s + parseFloat(b.total_amount || 0), 0),
    totalCount:      bills.length,
    pending:         bills.filter(b => ['pending', 'approved'].includes(normalizeStatus(b.status))).reduce((s, b) => s + parseFloat(b.balance || 0), 0),
    overdue:         bills.filter(b => normalizeStatus(b.status) === 'overdue').reduce((s, b) => s + parseFloat(b.balance || 0), 0),
    paid:            bills.filter(b => normalizeStatus(b.status) === 'paid').reduce((s, b) => s + parseFloat(b.total_amount || 0), 0),
    overdueCount:    bills.filter(b => normalizeStatus(b.status) === 'overdue').length,
    pendingApproval: bills.filter(b => normalizeStatus(b.status) === 'pending').length,
    paidMonthCount:  bills.filter(b => normalizeStatus(b.status) === 'paid').length,
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

  return (
    <div className="sb-root">

      {/* Toast */}
      {toast && (
        <div className={`sb-toast sb-toast-${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="sb-header">
        <div>
          <h2 className="sb-title">Bills &amp; Payables</h2>
          <p className="sb-sub">{stats.totalCount} bills · Supplier invoices tracking</p>
        </div>
        <div className="sb-header-r">
          <FYSelector />
          <button className="sb-btn-outline" onClick={load} title="Refresh"><RefreshCw size={13}/></button>
          <button className="sb-btn-outline" onClick={handleExport}><Download size={14}/> Export</button>
          <button className="sb-btn-primary" onClick={() => setDrawer('create')}>
            <Plus size={15}/> Record Bill
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="sb-stats">
        <div className="sb-stat">
          <div className="sb-stat-icon" style={{ background: '#ede9fe', color: '#6B3FDB' }}>
            <FileText size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Total Bills</span>
            <span className="sb-stat-val">{fmt(stats.total)}</span>
            <span className="sb-stat-sub">{stats.totalCount} bills this year</span>
          </div>
        </div>
        <div className="sb-stat sb-stat-amber">
          <div className="sb-stat-icon" style={{ background: '#fef3c7', color: '#d97706' }}>
            <Clock size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Pending Payment</span>
            <span className="sb-stat-val">{fmt(stats.pending)}</span>
            <span className="sb-stat-sub">{stats.pendingApproval} awaiting approval</span>
          </div>
        </div>
        <div className="sb-stat sb-stat-red">
          <div className="sb-stat-icon" style={{ background: '#fee2e2', color: '#dc2626' }}>
            <AlertCircle size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Overdue</span>
            <span className="sb-stat-val">{fmt(stats.overdue)}</span>
            <span className="sb-stat-sub">{stats.overdueCount} bills overdue</span>
          </div>
        </div>
        <div className="sb-stat sb-stat-green">
          <div className="sb-stat-icon" style={{ background: '#dcfce7', color: '#16a34a' }}>
            <CheckCircle size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Paid This Month</span>
            <span className="sb-stat-val">{fmt(stats.paid)}</span>
            <span className="sb-stat-sub">{stats.paidMonthCount} bills settled</span>
          </div>
        </div>
      </div>

      {/* Overdue alert */}
      {stats.overdueCount > 0 && (
        <div className="sb-overdue-alert">
          <AlertTriangle size={15}/>
          <span>
            <strong>{stats.overdueCount} bill{stats.overdueCount > 1 ? 's are' : ' is'} overdue</strong>
            {' — '}{fmt(stats.overdue)} pending. Pay immediately to avoid supplier issues.
          </span>
          <button className="sb-alert-action" onClick={() => setStatusFilter('overdue')}>
            View Overdue
          </button>
        </div>
      )}

      {/* Filter bar */}
      <div className="sb-filter-bar">
        <div className="sb-search">
          <Search size={14}/>
          <input placeholder="Search bill # or supplier…"
            value={search} onChange={e => setSearch(e.target.value)}/>
          {search && <button className="sb-clear" onClick={() => setSearch('')}><X size={12}/></button>}
        </div>

        <select className="sb-select-filter" value={supplierFilter}
          onChange={e => setSupplierFilter(e.target.value)}>
          <option value="">All Suppliers</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <div className="sb-date-range">
          <Calendar size={12}/>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}/>
          <span className="sb-date-sep">–</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}/>
        </div>
      </div>

      {/* Status tabs */}
      <div className="sb-filter-tabs-row">
        {[
          { value: '',         label: 'All' },
          { value: 'pending',  label: 'Pending' },
          { value: 'approved', label: 'Approved' },
          { value: 'overdue',  label: 'Overdue' },
          { value: 'paid',     label: 'Paid' },
          { value: 'rejected', label: 'Rejected' },
        ].map(s => (
          <button key={s.value}
            className={`sb-filter-tab${statusFilter === s.value ? ' active' : ''}${s.value === 'overdue' && stats.overdueCount > 0 ? ' sb-tab-alert' : ''}`}
            onClick={() => setStatusFilter(s.value)}>
            {s.label}
            {s.value === 'overdue' && stats.overdueCount > 0 && <span className="sb-alert-dot"/>}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="sb-table-wrap">
        {loading ? (
          <div className="sb-loading"><div className="sb-spinner"/><p>Loading bills…</p></div>
        ) : filtered.length === 0 ? (
          <div className="sb-empty">
            <FileText size={36} color="#d1d5db"/>
            <p>No bills found</p>
            <button className="sb-btn-primary" onClick={() => setDrawer('create')}>
              <Plus size={14}/> Record First Bill
            </button>
          </div>
        ) : (
          <table className="sb-table">
            <thead>
              <tr>
                <th>Bill #</th>
                <th>Supplier</th>
                <th>Bill Date</th>
                <th>Due Date</th>
                <th className="sb-th-r">Taxable</th>
                <th className="sb-th-r">GST</th>
                <th className="sb-th-r">TDS</th>
                <th className="sb-th-r">Net Payable</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((bill, i) => {
                const sc       = statusColor(normalizeStatus(bill.status));
                const days     = daysUntilDue(bill.due_date);
                const isOverdue = normalizeStatus(bill.status) === 'overdue';
                const dueSoon  = days !== null && days <= 7 && days >= 0 && normalizeStatus(bill.status) !== 'paid';
                const hasTDS   = parseFloat(bill.tds_amount ?? 0) > 0;
                const netPay   = parseFloat(bill.net_payable ?? bill.total_amount ?? 0);
                return (
                  <tr key={bill.id || i}
                    className={`sb-tr${isOverdue ? ' sb-tr-overdue' : ''}${dueSoon ? ' sb-tr-due-soon' : ''}`}>
                    <td>
                      <button className="sb-link" onClick={() => setViewBill(bill)}>
                        {bill.bill_number}
                      </button>
                    </td>
                    <td>
                      <div className="sb-supplier-cell">
                        <div className="sb-supplier-avatar">{(bill.supplier_name || 'S').charAt(0)}</div>
                        <span>{bill.supplier_name ?? '—'}</span>
                      </div>
                    </td>
                    <td className="sb-td-date">{fmtDate(bill.bill_date)}</td>
                    <td>
                      <div className="sb-due-cell">
                        <span className={`sb-due-date${isOverdue ? ' sb-due-overdue' : dueSoon ? ' sb-due-soon' : ''}`}>
                          {fmtDate(bill.due_date)}
                        </span>
                        {isOverdue && <span className="sb-due-badge overdue">Overdue</span>}
                        {dueSoon    && <span className="sb-due-badge soon">Due in {days}d</span>}
                      </div>
                    </td>
                    <td className="sb-td-r sb-td-sm">{fmtCell(bill.subtotal)}</td>
                    <td className="sb-td-r sb-td-sm">{fmtCell(bill.tax_amount)}</td>
                    <td className="sb-td-r sb-td-sm">
                      {hasTDS ? <span className="sb-tds-val">{fmtCell(bill.tds_amount)}</span> : <span className="sb-td-nil">—</span>}
                    </td>
                    <td className="sb-td-r sb-td-bold">
                      <span className={parseFloat(bill.balance ?? 0) > 0 ? 'sb-bal-pending' : 'sb-bal-clear'}>
                        {fmtCell(netPay)}
                      </span>
                    </td>
                    <td>
                      <span className="sb-status" style={sc}>{normalizeStatus(bill.status)}</span>
                    </td>
                    <td>
                      <div className="sb-row-actions">
                        <button className="sb-action-btn" title="View" onClick={() => setViewBill(bill)}>
                          <Eye size={13}/>
                        </button>
                        {normalizeStatus(bill.status) === 'pending' && (
                          <>
                            <button className="sb-action-btn sb-approve-btn" title="Approve"
                              onClick={() => setApproveModal({ bill, comment: '' })}>
                              <ThumbsUp size={13}/>
                            </button>
                            <button className="sb-action-btn sb-reject-btn" title="Reject"
                              onClick={() => setRejectModal({ bill, reason: '' })}>
                              <ThumbsDown size={13}/>
                            </button>
                          </>
                        )}
                        {normalizeStatus(bill.status) === 'approved' && (
                          <button className="sb-action-btn sb-pay-btn" title="Record Payment"
                            onClick={() => openPayModal(bill)}>
                            <CreditCard size={13}/>
                          </button>
                        )}
                        {normalizeStatus(bill.status) === 'rejected' && (
                          <button className="sb-action-btn sb-resubmit-btn" title="Re-submit"
                            onClick={() => handleResubmit(bill)}>
                            <RotateCcw size={13}/>
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

      {/* ── View Bill Drawer ──────────────────────────────────── */}
      {viewBill && !drawer && !payModal && !approveModal && !rejectModal && (
        <div className="sb-overlay" onClick={() => setViewBill(null)}>
          <div className="sb-drawer sb-drawer-wide" onClick={e => e.stopPropagation()}>
            <div className="sb-drawer-hd">
              <div>
                <h3 className="sb-bill-num">{viewBill.bill_number}</h3>
                <div className="sb-bill-meta">
                  <span className="sb-status" style={statusColor(normalizeStatus(viewBill.status))}>
                    {normalizeStatus(viewBill.status)}
                  </span>
                  <span className="sb-bill-supplier">{viewBill.supplier_name}</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="sb-btn-outline" onClick={() => window.print()}><Printer size={13}/> Print</button>
                <button className="sb-icon-btn" onClick={() => setViewBill(null)}><X size={18}/></button>
              </div>
            </div>

            <div className="sb-view-body">
              {/* Amounts strip */}
              <div className="sb-view-amounts">
                <div className="sb-vamt-item">
                  <span>Taxable</span>
                  <strong>{fmtFull(viewBill.subtotal || viewBill.total_amount)}</strong>
                </div>
                <div className="sb-vamt-item">
                  <span>GST</span>
                  <strong>{fmtFull(viewBill.tax_amount || 0)}</strong>
                </div>
                <div className="sb-vamt-item">
                  <span>TDS Deducted</span>
                  <strong className={parseFloat(viewBill.tds_amount ?? 0) > 0 ? 'amber' : ''}>
                    {parseFloat(viewBill.tds_amount ?? 0) > 0 ? fmtFull(viewBill.tds_amount) : '—'}
                  </strong>
                </div>
                <div className="sb-vamt-item">
                  <span>Net Payable</span>
                  <strong className={normalizeStatus(viewBill.status) === 'overdue' ? 'red' : ''}>
                    {fmtFull(viewBill.net_payable ?? viewBill.total_amount)}
                  </strong>
                </div>
              </div>

              {/* Details grid */}
              <div className="sb-view-grid">
                <div className="sb-view-section">
                  <h4>Bill Details</h4>
                  <div className="sb-view-row"><span>Bill #</span><strong>{viewBill.bill_number}</strong></div>
                  <div className="sb-view-row"><span>Supplier</span><strong>{viewBill.supplier_name}</strong></div>
                  <div className="sb-view-row"><span>Bill Date</span><strong>{fmtDate(viewBill.bill_date)}</strong></div>
                  <div className="sb-view-row"><span>Due Date</span>
                    <strong className={normalizeStatus(viewBill.status) === 'overdue' ? 'red' : ''}>
                      {fmtDate(viewBill.due_date)}
                    </strong>
                  </div>
                  <div className="sb-view-row"><span>Payment Terms</span><strong>Net {viewBill.payment_terms || 30}</strong></div>
                </div>
                <div className="sb-view-section">
                  <h4>Financial Summary</h4>
                  <div className="sb-view-row"><span>Subtotal (Taxable)</span><strong>{fmtFull(viewBill.subtotal || viewBill.total_amount)}</strong></div>
                  <div className="sb-view-row"><span>GST</span><strong>{fmtFull(viewBill.tax_amount || 0)}</strong></div>
                  <div className="sb-view-row sb-row-total"><span>Gross Total</span><strong>{fmtFull(viewBill.total_amount)}</strong></div>
                  {parseFloat(viewBill.tds_amount ?? 0) > 0 && (
                    <div className="sb-view-row">
                      <span>TDS ({viewBill.tds_section} @ {viewBill.tds_rate}%)</span>
                      <strong className="amber">– {fmtFull(viewBill.tds_amount)}</strong>
                    </div>
                  )}
                  <div className="sb-view-row"><span>Net Payable</span><strong>{fmtFull(viewBill.net_payable ?? viewBill.total_amount)}</strong></div>
                  <div className="sb-view-row"><span>Paid</span><strong className="green">{fmtFull(parseFloat(viewBill.paid_amount || 0))}</strong></div>
                </div>
              </div>

              {/* Line items */}
              {(viewBill.items || []).length > 0 && (
                <div className="sb-view-items">
                  <h4>Line Items</h4>
                  <table className="sb-items-view-table">
                    <thead>
                      <tr>
                        <th>Description</th>
                        <th className="sb-th-r">Qty</th>
                        <th className="sb-th-r">Unit Price</th>
                        <th className="sb-th-r">GST %</th>
                        <th className="sb-th-r">Taxable</th>
                        <th className="sb-th-r">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(viewBill.items || []).map((item, i) => (
                        <tr key={i}>
                          <td>{item.description}</td>
                          <td className="sb-th-r">{item.quantity}</td>
                          <td className="sb-th-r">{fmtFull(item.unit_price)}</td>
                          <td className="sb-th-r">{item.gst_rate ?? item.tax_rate}%</td>
                          <td className="sb-th-r">{fmtFull(item.taxable_amount ?? item.unit_price)}</td>
                          <td className="sb-th-r sb-item-total">{fmtFull(item.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Actions */}
              <div className="sb-view-actions">
                {normalizeStatus(viewBill.status) === 'pending' && (
                  <>
                    <button className="sb-approve-full-btn"
                      onClick={() => setApproveModal({ bill: viewBill, comment: '' })}>
                      <ThumbsUp size={14}/> Approve Bill
                    </button>
                    <button className="sb-reject-full-btn"
                      onClick={() => setRejectModal({ bill: viewBill, reason: '' })}>
                      <ThumbsDown size={14}/> Reject
                    </button>
                  </>
                )}
                {normalizeStatus(viewBill.status) === 'approved' && parseFloat(viewBill.balance ?? 0) > 0 && (
                  <button className="sb-pay-full-btn" onClick={() => openPayModal(viewBill)}>
                    <CreditCard size={14}/> Record Payment
                  </button>
                )}
                {normalizeStatus(viewBill.status) === 'rejected' && (
                  <button className="sb-resubmit-full-btn" onClick={() => handleResubmit(viewBill)}>
                    <RotateCcw size={14}/> Re-submit for Approval
                  </button>
                )}
                {normalizeStatus(viewBill.status) === 'paid' && (
                  <div className="sb-paid-badge">
                    <CheckCircle size={16} color="#10b981"/> Bill fully paid
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Approve Confirmation Modal ─────────────────────────── */}
      {approveModal && (
        <div className="sb-overlay sb-modal-center" onClick={() => setApproveModal(null)}>
          <div className="sb-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="sb-confirm-hd sb-confirm-approve">
              <ThumbsUp size={18}/>
              <h3>Approve Bill</h3>
            </div>
            <div className="sb-confirm-body">
              <p>
                <strong>{approveModal.bill.bill_number}</strong> · {approveModal.bill.supplier_name}<br/>
                <span className="sb-sub">Net Payable: {fmtFull(approveModal.bill.net_payable ?? approveModal.bill.total_amount)}</span>
              </p>
              <div className="sb-field">
                <label>Approval Comment (optional)</label>
                <textarea rows={2} placeholder="Add a comment…"
                  value={approveModal.comment}
                  onChange={e => setApproveModal(m => ({ ...m, comment: e.target.value }))}/>
              </div>
            </div>
            <div className="sb-confirm-footer">
              <button className="sb-btn-outline" onClick={() => setApproveModal(null)}>Cancel</button>
              <button className="sb-approve-full-btn" onClick={handleApprove}>
                <ThumbsUp size={13}/> Confirm Approve
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reject Confirmation Modal ──────────────────────────── */}
      {rejectModal && (
        <div className="sb-overlay sb-modal-center" onClick={() => setRejectModal(null)}>
          <div className="sb-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="sb-confirm-hd sb-confirm-reject">
              <ThumbsDown size={18}/>
              <h3>Reject Bill</h3>
            </div>
            <div className="sb-confirm-body">
              <p>
                <strong>{rejectModal.bill.bill_number}</strong> · {rejectModal.bill.supplier_name}
              </p>
              <div className="sb-field">
                <label>Rejection Reason *</label>
                <textarea rows={3} placeholder="Provide a reason for rejection…"
                  value={rejectModal.reason}
                  onChange={e => setRejectModal(m => ({ ...m, reason: e.target.value }))}/>
              </div>
            </div>
            <div className="sb-confirm-footer">
              <button className="sb-btn-outline" onClick={() => setRejectModal(null)}>Cancel</button>
              <button className="sb-reject-full-btn" onClick={handleReject}>
                <ThumbsDown size={13}/> Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Pay Bill Modal ────────────────────────────────────── */}
      {payModal && (
        <div className="sb-overlay" onClick={() => setPayModal(null)}>
          <div className="sb-drawer" onClick={e => e.stopPropagation()}>
            <div className="sb-drawer-hd">
              <div>
                <h3>Record Payment</h3>
                <p className="sb-drawer-sub">
                  {payModal.bill_number} · {payModal.supplier_name} · Net Payable {fmtFull(payModal.net_payable ?? payModal.balance ?? payModal.total_amount)}
                </p>
              </div>
              <button className="sb-icon-btn" onClick={() => setPayModal(null)}><X size={18}/></button>
            </div>
            <div className="sb-form-body">
              <div className="sb-form-row">
                <div className="sb-field">
                  <label>Amount *</label>
                  <input type="number" step="0.01" min="0.01"
                    value={payForm.amount}
                    onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}/>
                </div>
                <div className="sb-field">
                  <label>Payment Date *</label>
                  <input type="date" value={payForm.payment_date}
                    onChange={e => setPayForm(f => ({ ...f, payment_date: e.target.value }))}/>
                </div>
              </div>
              <div className="sb-form-row">
                <div className="sb-field">
                  <label>Payment Method</label>
                  <select value={payForm.payment_method}
                    onChange={e => setPayForm(f => ({ ...f, payment_method: e.target.value }))}>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="sb-field">
                  <label>Reference / UTR #</label>
                  <input value={payForm.reference_number}
                    onChange={e => setPayForm(f => ({ ...f, reference_number: e.target.value }))}
                    placeholder="UTR / Cheque # / Ref…"/>
                </div>
              </div>
              <div className="sb-field">
                <label>Notes</label>
                <textarea rows={2} value={payForm.notes}
                  onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Payment notes…"/>
              </div>
              <div className="sb-form-footer">
                <button className="sb-btn-outline" onClick={() => setPayModal(null)}>Cancel</button>
                <button className="sb-btn-primary" onClick={handlePaySubmit} disabled={submitting}>
                  {submitting ? 'Recording…' : 'Record Payment'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Bill Drawer ─────────────────────────────────── */}
      {drawer === 'create' && (
        <div className="sb-overlay" onClick={() => setDrawer(null)}>
          <div className="sb-drawer" onClick={e => e.stopPropagation()}>
            <div className="sb-drawer-hd">
              <div>
                <h3>Record New Bill</h3>
                <p className="sb-drawer-sub">Enter supplier invoice details</p>
              </div>
              <button className="sb-icon-btn" onClick={() => setDrawer(null)}><X size={18}/></button>
            </div>

            <div className="sb-form-body">

              {/* Row 1 — Supplier / Bill# / Ref */}
              <div className="sb-form-row">
                <div className="sb-field">
                  <label>Supplier *</label>
                  {suppliers.length > 0 ? (
                    <select value={form.supplier_id}
                      onChange={e => {
                        const s = suppliers.find(x => x.id === parseInt(e.target.value));
                        setForm(f => ({
                          ...f,
                          supplier_id: e.target.value,
                          supplier_name: s?.name || '',
                          payment_terms: s?.payment_terms || 30,
                          due_date: addDays(f.bill_date, s?.payment_terms || 30),
                        }));
                      }}>
                      <option value="">— Select Supplier —</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <input value={form.supplier_name}
                      onChange={e => setForm(f => ({ ...f, supplier_name: e.target.value }))}
                      placeholder="Supplier name…"/>
                  )}
                </div>
                <div className="sb-field">
                  <label>Bill Number</label>
                  <input value={form.bill_number}
                    onChange={e => setForm(f => ({ ...f, bill_number: e.target.value }))}
                    placeholder="Supplier's invoice #"/>
                </div>
                <div className="sb-field">
                  <label>Your Reference</label>
                  <input value={form.reference}
                    onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                    placeholder="PO # or reference…"/>
                </div>
              </div>

              {/* Row 2 — Dates */}
              <div className="sb-form-row">
                <div className="sb-field">
                  <label>Bill Date *</label>
                  <input type="date" value={form.bill_date}
                    onChange={e => {
                      const d = e.target.value;
                      setForm(f => ({ ...f, bill_date: d, due_date: addDays(d, f.payment_terms) }));
                    }}/>
                </div>
                <div className="sb-field">
                  <label>Payment Terms</label>
                  <select value={form.payment_terms}
                    onChange={e => {
                      const n = parseInt(e.target.value);
                      setForm(f => ({ ...f, payment_terms: n, due_date: addDays(f.bill_date, n) }));
                    }}>
                    {[0, 7, 15, 30, 45, 60, 90].map(n => (
                      <option key={n} value={n}>{n === 0 ? 'Due on Receipt' : `Net ${n}`}</option>
                    ))}
                  </select>
                </div>
                <div className="sb-field">
                  <label>Due Date</label>
                  <input type="date" value={form.due_date}
                    onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}/>
                </div>
              </div>

              {/* Line items */}
              <div className="sb-items-section">
                <div className="sb-items-hd">
                  <span>Line Items</span>
                  <button type="button" className="sb-add-item" onClick={addItem}>
                    <Plus size={12}/> Add Item
                  </button>
                </div>
                <table className="sb-items-table">
                  <thead>
                    <tr>
                      <th style={{ width: '35%' }}>Description</th>
                      <th style={{ width: '8%' }}>Qty</th>
                      <th style={{ width: '14%' }}>Unit Price (₹)</th>
                      <th style={{ width: '10%' }}>GST %</th>
                      <th style={{ width: '13%' }}>Taxable</th>
                      <th style={{ width: '12%' }}>Total</th>
                      <th style={{ width: '8%' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((item, idx) => {
                      const c = calcItem(item);
                      return (
                        <tr key={idx}>
                          <td>
                            <input type="text" value={item.description}
                              onChange={e => updateItem(idx, 'description', e.target.value)}
                              placeholder="Item description…"/>
                          </td>
                          <td>
                            <input type="number" min="1" value={item.quantity}
                              onChange={e => updateItem(idx, 'quantity', e.target.value)}/>
                          </td>
                          <td>
                            <input type="number" min="0" step="0.01" value={item.unit_price}
                              onChange={e => updateItem(idx, 'unit_price', e.target.value)}/>
                          </td>
                          <td>
                            <select value={item.gst_rate}
                              onChange={e => updateItem(idx, 'gst_rate', e.target.value)}>
                              {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                            </select>
                          </td>
                          <td className="sb-td-r sb-td-sm">
                            ₹{c.taxable_amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </td>
                          <td className="sb-td-r sb-td-bold">
                            ₹{c.amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </td>
                          <td>
                            {form.items.length > 1 && (
                              <button type="button" className="sb-remove-item" onClick={() => removeItem(idx)}>
                                <X size={12}/>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="sb-totals">
                <div className="sb-totals-box">
                  <div className="sb-total-row">
                    <span>Subtotal (Taxable)</span>
                    <span>₹{totals.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="sb-total-row">
                    <span>GST</span>
                    <span>₹{totals.gst.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="sb-total-row sb-total-final">
                    <span>Gross Total</span>
                    <span>{fmtFull(totals.total)}</span>
                  </div>
                  {form.tds_applicable && (
                    <>
                      <div className="sb-total-row sb-tds-deduct">
                        <span>TDS Deduction</span>
                        <span>– {fmtFull(tdsCalc)}</span>
                      </div>
                      <div className="sb-total-row sb-total-net">
                        <span>Net Payable</span>
                        <span>{fmtFull(netPayable)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* TDS Section */}
              <div className="sb-tds-section">
                <div className="sb-tds-hd">
                  <span>TDS Deduction</span>
                  <label className="sb-toggle">
                    <input type="checkbox" checked={form.tds_applicable}
                      onChange={e => setForm(f => ({ ...f, tds_applicable: e.target.checked, tds_section: '', tds_rate: 0 }))}/>
                    <span className="sb-toggle-slider"/>
                    <span className="sb-toggle-label">{form.tds_applicable ? 'Applicable' : 'Not Applicable'}</span>
                  </label>
                </div>

                {form.tds_applicable && (
                  <div className="sb-tds-fields">
                    <div className="sb-form-row sb-form-row-2">
                      <div className="sb-field">
                        <label>TDS Section</label>
                        <select value={form.tds_section} onChange={e => handleTdsSection(e.target.value)}>
                          <option value="">— Select Section —</option>
                          {TDS_SECTIONS.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
                        </select>
                      </div>
                      <div className="sb-field">
                        <label>Payee Type</label>
                        <select value={form.tds_payee_type} onChange={e => handleTdsPayeeType(e.target.value)}>
                          <option value="company">Company / LLP / Firm</option>
                          <option value="individual">Individual / HUF</option>
                        </select>
                      </div>
                    </div>
                    <div className="sb-form-row sb-form-row-3">
                      <div className="sb-field">
                        <label>PAN Available?</label>
                        <select value={form.pan_available ? 'yes' : 'no'}
                          onChange={e => {
                            const hasPan = e.target.value === 'yes';
                            const sec = TDS_SECTIONS.find(s => s.code === form.tds_section);
                            let rate = sec ? (form.tds_payee_type === 'individual' ? sec.ri : sec.rc) : parseFloat(form.tds_rate) || 0;
                            if (!hasPan) rate = Math.max(rate * 2, 20);
                            setForm(f => ({ ...f, pan_available: hasPan, tds_rate: rate }));
                          }}>
                          <option value="yes">Yes — Normal rate</option>
                          <option value="no">No — Sec 206AA (2× rate, min 20%)</option>
                        </select>
                      </div>
                      <div className="sb-field">
                        <label>TDS Rate (%)</label>
                        <input type="number" step="0.01" min="0" value={form.tds_rate}
                          onChange={e => setForm(f => ({ ...f, tds_rate: e.target.value }))}/>
                      </div>
                      <div className="sb-field">
                        <label>TDS Amount</label>
                        <div className="sb-tds-computed">{fmtFull(tdsCalc)}</div>
                      </div>
                    </div>
                    <div className="sb-tds-info">
                      Gross: {fmtFull(totals.subtotal)} × {form.tds_rate}% = TDS {fmtFull(tdsCalc)} · Net Payable = {fmtFull(netPayable)}
                    </div>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div className="sb-field">
                <label>Notes</label>
                <textarea rows={2} value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Internal notes about this bill…"/>
              </div>

              {/* Footer */}
              <div className="sb-form-footer">
                <button className="sb-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button className="sb-btn-outline"
                  onClick={() => handleSubmit('draft')} disabled={submitting}>
                  Save Draft
                </button>
                <button className="sb-btn-primary"
                  onClick={() => handleSubmit('pending')} disabled={submitting}>
                  {submitting ? 'Saving…' : 'Submit for Approval'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
