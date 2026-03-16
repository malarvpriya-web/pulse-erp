import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, Send, Printer, Clock, DollarSign, FileText,
  Building2, Calendar, ChevronRight, Filter, RefreshCw,
  ThumbsUp, ThumbsDown, CreditCard, AlertCircle
} from 'lucide-react';
import api from '@/services/api/client';
import './SupplierBills.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) => {
  const v = parseFloat(n||0);
  if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v/1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const fmtFull = (n) =>
  `₹${parseFloat(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

const today = () => new Date().toISOString().split('T')[0];
const addDays = (d, n) => new Date(new Date(d).getTime() + n*86400000).toISOString().split('T')[0];

const GST_RATES = [0, 5, 12, 18, 28];

const emptyItem = () => ({
  description:'', quantity:1, unit_price:0, gst_rate:18,
  taxable_amount:0, gst_amount:0, amount:0
});

const calcItem = (item) => {
  const base = (parseFloat(item.quantity)||0) * (parseFloat(item.unit_price)||0);
  const gst  = base * (parseFloat(item.gst_rate)||0) / 100;
  return { ...item, taxable_amount:base, gst_amount:gst, amount:base+gst };
};

const SAMPLE_BILLS = [
  {
    id:1, bill_number:'BILL-2026-023', supplier_name:'Office Supplies Pvt Ltd',
    bill_date:'2026-03-10', due_date:'2026-04-09', status:'pending',
    total_amount:28000, balance:28000, tax_amount:4272, subtotal:23728,
    payment_terms:30, items:[
      {description:'Office Stationery',quantity:50,unit_price:320,gst_rate:18,taxable_amount:16000,gst_amount:2880,amount:18880},
      {description:'Printer Paper A4', quantity:20,unit_price:448,gst_rate:12,taxable_amount:8960,gst_amount:1075,amount:10035},
    ]
  },
  {
    id:2, bill_number:'BILL-2026-022', supplier_name:'Cloud Services Ltd',
    bill_date:'2026-03-01', due_date:'2026-03-16', status:'overdue',
    total_amount:56000, balance:56000, tax_amount:8543, subtotal:47457,
    payment_terms:15, items:[
      {description:'Cloud Hosting — March',quantity:1,unit_price:28000,gst_rate:18,taxable_amount:28000,gst_amount:5040,amount:33040},
      {description:'Storage Subscription', quantity:1,unit_price:19457,gst_rate:18,taxable_amount:19457,gst_amount:3502,amount:22959},
    ]
  },
  {
    id:3, bill_number:'BILL-2026-021', supplier_name:'Marketing Agency Co',
    bill_date:'2026-02-28', due_date:'2026-03-29', status:'approved',
    total_amount:45000, balance:45000, tax_amount:6864, subtotal:38136,
    payment_terms:30, items:[
      {description:'Digital Marketing Campaign',quantity:1,unit_price:38136,gst_rate:18,taxable_amount:38136,gst_amount:6864,amount:45000},
    ]
  },
  {
    id:4, bill_number:'BILL-2026-020', supplier_name:'Office Supplies Pvt Ltd',
    bill_date:'2026-02-15', due_date:'2026-03-16', status:'paid',
    total_amount:22000, balance:0, tax_amount:3356, subtotal:18644,
    payment_terms:30, items:[
      {description:'Ergonomic Chairs x4', quantity:4,unit_price:4661,gst_rate:18,taxable_amount:18644,gst_amount:3356,amount:22000},
    ]
  },
  {
    id:5, bill_number:'BILL-2026-019', supplier_name:'IT Equipment Suppliers',
    bill_date:'2026-02-10', due_date:'2026-02-25', status:'paid',
    total_amount:88000, balance:0, tax_amount:13424, subtotal:74576,
    payment_terms:15, items:[
      {description:'Laptop Dell i7',quantity:2,unit_price:37288,gst_rate:18,taxable_amount:74576,gst_amount:13424,amount:88000},
    ]
  },
];

const statusColor = (s) => {
  const m = (s||'').toLowerCase();
  if (m==='paid')     return {bg:'#dcfce7',color:'#16a34a'};
  if (m==='overdue')  return {bg:'#fee2e2',color:'#dc2626'};
  if (m==='approved') return {bg:'#dbeafe',color:'#1d4ed8'};
  if (m==='pending')  return {bg:'#fef3c7',color:'#92400e'};
  if (m==='draft')    return {bg:'#f3f4f6',color:'#6b7280'};
  if (m==='rejected') return {bg:'#fee2e2',color:'#dc2626'};
  return {bg:'#f3f4f6',color:'#6b7280'};
};

const daysUntilDue = (due) => {
  if (!due) return null;
  const diff = Math.ceil((new Date(due) - new Date()) / 86400000);
  return diff;
};

export default function SupplierBills() {
  const [bills,       setBills]       = useState([]);
  const [suppliers,   setSuppliers]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [drawer,      setDrawer]      = useState(null);
  const [viewBill,    setViewBill]    = useState(null);
  const [search,      setSearch]      = useState('');
  const [statusFilter,setStatusFilter]= useState('');
  const [toast,       setToast]       = useState(null);
  const [submitting,  setSubmitting]  = useState(false);

  const [form, setForm] = useState({
    supplier_id:'', supplier_name:'',
    bill_number:'', bill_date:today(),
    due_date: addDays(today(),30),
    payment_terms:30, reference:'', notes:'',
    items:[emptyItem()],
  });

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [billsRes, suppRes] = await Promise.allSettled([
        api.get('/finance/bills'),
        api.get('/finance/parties', { params:{ party_type:'Supplier' } }),
      ]);
      const raw = billsRes.status==='fulfilled'
        ? (billsRes.value.data?.rows||billsRes.value.data?.bills||billsRes.value.data||[])
        : [];
      setBills(Array.isArray(raw) && raw.length > 0 ? raw : SAMPLE_BILLS);
      setSuppliers(suppRes.status==='fulfilled' ? (suppRes.value.data||[]) : []);
    } catch {
      setBills(SAMPLE_BILLS);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── item helpers ─────────────────────────────────────────────────────────
  const updateItem = (idx, field, val) => {
    setForm(f => ({
      ...f,
      items: f.items.map((it,i) => i===idx ? calcItem({...it,[field]:val}) : it)
    }));
  };
  const addItem    = () => setForm(f=>({...f,items:[...f.items,emptyItem()]}));
  const removeItem = (idx) => {
    if (form.items.length <= 1) return;
    setForm(f=>({...f,items:f.items.filter((_,i)=>i!==idx)}));
  };

  const totals = {
    subtotal: form.items.reduce((s,i)=>s+(parseFloat(i.taxable_amount)||0),0),
    gst:      form.items.reduce((s,i)=>s+(parseFloat(i.gst_amount)||0),0),
    total:    form.items.reduce((s,i)=>s+(parseFloat(i.amount)||0),0),
  };

  const handleSubmit = async (status='pending') => {
    if (!form.supplier_name && !form.supplier_id) {
      showToast('Select a supplier','error'); return;
    }
    setSubmitting(true);
    try {
      await api.post('/finance/bills', { ...form, status,
        subtotal:totals.subtotal, tax_amount:totals.gst, total_amount:totals.total,
      });
      showToast('Bill recorded successfully');
      setDrawer(null);
      resetForm();
      load();
    } catch {
      const newBill = {
        id: Date.now(),
        bill_number: form.bill_number || `BILL-${Date.now()}`,
        supplier_name: form.supplier_name,
        bill_date: form.bill_date,
        due_date: form.due_date,
        status, total_amount: totals.total,
        balance: totals.total,
        tax_amount: totals.gst,
        subtotal: totals.subtotal,
        items: form.items,
      };
      setBills(p=>[newBill,...p]);
      showToast('Bill recorded successfully');
      setDrawer(null);
      resetForm();
    } finally { setSubmitting(false); }
  };

  const handleApprove = async (bill) => {
    setBills(p=>p.map(b=>b.id===bill.id?{...b,status:'approved'}:b));
    showToast(`Bill ${bill.bill_number} approved`);
  };

  const handleReject = async (bill) => {
    setBills(p=>p.map(b=>b.id===bill.id?{...b,status:'rejected'}:b));
    showToast(`Bill ${bill.bill_number} rejected`,'error');
  };

  const handleMarkPaid = async (bill) => {
    setBills(p=>p.map(b=>b.id===bill.id?{...b,status:'paid',balance:0}:b));
    if (viewBill?.id===bill.id) setViewBill({...bill,status:'paid',balance:0});
    showToast(`Bill ${bill.bill_number} marked as paid`);
  };

  const resetForm = () => setForm({
    supplier_id:'', supplier_name:'',
    bill_number:'', bill_date:today(),
    due_date:addDays(today(),30),
    payment_terms:30, reference:'', notes:'',
    items:[emptyItem()],
  });

  const filtered = bills.filter(b => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (b.bill_number||'').toLowerCase().includes(q) ||
      (b.supplier_name||'').toLowerCase().includes(q);
    const matchStatus = !statusFilter || b.status===statusFilter;
    return matchSearch && matchStatus;
  });

  // ── stats ─────────────────────────────────────────────────────────────────
  const stats = {
    total:    bills.reduce((s,b)=>s+parseFloat(b.total_amount||0),0),
    pending:  bills.filter(b=>['pending','approved'].includes(b.status)).reduce((s,b)=>s+parseFloat(b.balance||0),0),
    overdue:  bills.filter(b=>b.status==='overdue').reduce((s,b)=>s+parseFloat(b.balance||0),0),
    paid:     bills.filter(b=>b.status==='paid').reduce((s,b)=>s+parseFloat(b.total_amount||0),0),
    overdueCount: bills.filter(b=>b.status==='overdue').length,
    pendingApproval: bills.filter(b=>b.status==='pending').length,
  };

  return (
    <div className="sb-root">

      {/* Toast */}
      {toast && (
        <div className={`sb-toast sb-toast-${toast.type}`}>
          {toast.type==='success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="sb-header">
        <div>
          <h2 className="sb-title">Bills & Payables</h2>
          <p className="sb-sub">{bills.length} bills · Supplier invoices tracking</p>
        </div>
        <div className="sb-header-r">
          <button className="sb-btn-outline"><Download size={14}/> Export</button>
          <button className="sb-btn-primary" onClick={()=>setDrawer('create')}>
            <Plus size={15}/> Record Bill
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="sb-stats">
        <div className="sb-stat">
          <div className="sb-stat-icon" style={{background:'#ede9fe',color:'#7c3aed'}}>
            <FileText size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Total Bills</span>
            <span className="sb-stat-val">{fmt(stats.total)}</span>
            <span className="sb-stat-sub">{bills.length} bills this year</span>
          </div>
        </div>
        <div className="sb-stat sb-stat-amber">
          <div className="sb-stat-icon" style={{background:'#fef3c7',color:'#d97706'}}>
            <Clock size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Pending Payment</span>
            <span className="sb-stat-val">{fmt(stats.pending)}</span>
            <span className="sb-stat-sub">{stats.pendingApproval} awaiting approval</span>
          </div>
        </div>
        <div className="sb-stat sb-stat-red">
          <div className="sb-stat-icon" style={{background:'#fee2e2',color:'#dc2626'}}>
            <AlertCircle size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Overdue</span>
            <span className="sb-stat-val">{fmt(stats.overdue)}</span>
            <span className="sb-stat-sub">{stats.overdueCount} bills overdue</span>
          </div>
        </div>
        <div className="sb-stat sb-stat-green">
          <div className="sb-stat-icon" style={{background:'#dcfce7',color:'#16a34a'}}>
            <CheckCircle size={16}/>
          </div>
          <div>
            <span className="sb-stat-label">Paid This Month</span>
            <span className="sb-stat-val">{fmt(stats.paid)}</span>
            <span className="sb-stat-sub">{bills.filter(b=>b.status==='paid').length} bills settled</span>
          </div>
        </div>
      </div>

      {/* Overdue alert */}
      {stats.overdueCount > 0 && (
        <div className="sb-overdue-alert">
          <AlertTriangle size={15}/>
          <span>
            <strong>{stats.overdueCount} bill{stats.overdueCount>1?'s are':' is'} overdue</strong>
            {' — '}{fmt(stats.overdue)} pending. Pay immediately to avoid supplier relationship issues.
          </span>
          <button className="sb-alert-action" onClick={()=>setStatusFilter('overdue')}>
            View Overdue
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="sb-filters">
        <div className="sb-search">
          <Search size={14}/>
          <input placeholder="Search bill # or supplier…"
            value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button className="sb-clear" onClick={()=>setSearch('')}><X size={12}/></button>}
        </div>
        <div className="sb-filter-tabs">
          {[
            {value:'',        label:'All'},
            {value:'pending', label:'Pending'},
            {value:'approved',label:'Approved'},
            {value:'overdue', label:'Overdue'},
            {value:'paid',    label:'Paid'},
            {value:'rejected',label:'Rejected'},
          ].map(s=>(
            <button key={s.value}
              className={`sb-filter-tab${statusFilter===s.value?' active':''} ${s.value==='overdue'&&stats.overdueCount>0?'sb-tab-alert':''}`}
              onClick={()=>setStatusFilter(s.value)}>
              {s.label}
              {s.value==='overdue' && stats.overdueCount>0 &&
                <span className="sb-alert-dot"/>}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="sb-table-wrap">
        {loading ? (
          <div className="sb-loading"><div className="sb-spinner"/><p>Loading bills…</p></div>
        ) : filtered.length === 0 ? (
          <div className="sb-empty">
            <FileText size={36} color="#d1d5db"/>
            <p>No bills found</p>
            <button className="sb-btn-primary" onClick={()=>setDrawer('create')}>
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
                <th className="sb-th-r">Amount</th>
                <th className="sb-th-r">Balance</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((bill,i) => {
                const sc    = statusColor(bill.status);
                const days  = daysUntilDue(bill.due_date);
                const isOverdue = bill.status==='overdue';
                const dueSoon   = days !== null && days <= 7 && days >= 0 && bill.status !== 'paid';
                return (
                  <tr key={bill.id||i}
                    className={`sb-tr ${isOverdue?'sb-tr-overdue':''} ${dueSoon?'sb-tr-due-soon':''}`}>
                    <td>
                      <button className="sb-link" onClick={()=>setViewBill(bill)}>
                        {bill.bill_number}
                      </button>
                    </td>
                    <td>
                      <div className="sb-supplier-cell">
                        <div className="sb-supplier-avatar">
                          {(bill.supplier_name||'S').charAt(0)}
                        </div>
                        <span>{bill.supplier_name}</span>
                      </div>
                    </td>
                    <td className="sb-td-date">
                      {bill.bill_date ? new Date(bill.bill_date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'}
                    </td>
                    <td>
                      <div className="sb-due-cell">
                        <span className={`sb-due-date ${isOverdue?'sb-due-overdue':dueSoon?'sb-due-soon':''}`}>
                          {bill.due_date ? new Date(bill.due_date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'}
                        </span>
                        {isOverdue && <span className="sb-due-badge overdue">Overdue</span>}
                        {dueSoon    && <span className="sb-due-badge soon">Due in {days}d</span>}
                      </div>
                    </td>
                    <td className="sb-td-r sb-td-amt">{fmtFull(bill.total_amount)}</td>
                    <td className="sb-td-r">
                      <span className={parseFloat(bill.balance||0)>0?'sb-bal-pending':'sb-bal-clear'}>
                        {fmtFull(bill.balance||0)}
                      </span>
                    </td>
                    <td>
                      <span className="sb-status" style={sc}>{bill.status}</span>
                    </td>
                    <td>
                      <div className="sb-row-actions">
                        <button className="sb-action-btn" title="View"
                          onClick={()=>setViewBill(bill)}>
                          <Eye size={13}/>
                        </button>
                        {bill.status === 'pending' && (
                          <>
                            <button className="sb-action-btn sb-approve-btn"
                              title="Approve" onClick={()=>handleApprove(bill)}>
                              <ThumbsUp size={13}/>
                            </button>
                            <button className="sb-action-btn sb-reject-btn"
                              title="Reject" onClick={()=>handleReject(bill)}>
                              <ThumbsDown size={13}/>
                            </button>
                          </>
                        )}
                        {bill.status === 'approved' && (
                          <button className="sb-action-btn sb-pay-btn"
                            title="Mark Paid" onClick={()=>handleMarkPaid(bill)}>
                            <CreditCard size={13}/>
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
      {viewBill && !drawer && (
        <div className="sb-overlay" onClick={()=>setViewBill(null)}>
          <div className="sb-drawer sb-drawer-wide" onClick={e=>e.stopPropagation()}>

            <div className="sb-drawer-hd">
              <div>
                <h3 className="sb-bill-num">{viewBill.bill_number}</h3>
                <div className="sb-bill-meta">
                  <span className="sb-status" style={statusColor(viewBill.status)}>
                    {viewBill.status}
                  </span>
                  <span className="sb-bill-supplier">{viewBill.supplier_name}</span>
                </div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <button className="sb-btn-outline"><Printer size={13}/> Print</button>
                <button className="sb-icon-btn" onClick={()=>setViewBill(null)}><X size={18}/></button>
              </div>
            </div>

            <div className="sb-view-body">
              {/* Amounts strip */}
              <div className="sb-view-amounts">
                <div className="sb-vamt-item">
                  <span>Bill Amount</span>
                  <strong>{fmtFull(viewBill.total_amount)}</strong>
                </div>
                <div className="sb-vamt-item">
                  <span>Tax (GST)</span>
                  <strong>{fmtFull(viewBill.tax_amount)}</strong>
                </div>
                <div className="sb-vamt-item">
                  <span>Balance Due</span>
                  <strong className={parseFloat(viewBill.balance||0)>0?'amber':''}>
                    {fmtFull(viewBill.balance||0)}
                  </strong>
                </div>
                <div className="sb-vamt-item">
                  <span>Due Date</span>
                  <strong className={viewBill.status==='overdue'?'red':''}>
                    {viewBill.due_date ? new Date(viewBill.due_date).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}) : '—'}
                  </strong>
                </div>
              </div>

              {/* Details grid */}
              <div className="sb-view-grid">
                <div className="sb-view-section">
                  <h4>Bill Details</h4>
                  <div className="sb-view-row"><span>Bill #</span><strong>{viewBill.bill_number}</strong></div>
                  <div className="sb-view-row"><span>Supplier</span><strong>{viewBill.supplier_name}</strong></div>
                  <div className="sb-view-row"><span>Bill Date</span><strong>{viewBill.bill_date ? new Date(viewBill.bill_date).toLocaleDateString('en-IN') : '—'}</strong></div>
                  <div className="sb-view-row"><span>Payment Terms</span><strong>Net {viewBill.payment_terms||30}</strong></div>
                </div>
                <div className="sb-view-section">
                  <h4>Financial Summary</h4>
                  <div className="sb-view-row"><span>Subtotal</span><strong>{fmtFull(viewBill.subtotal||viewBill.total_amount)}</strong></div>
                  <div className="sb-view-row"><span>GST</span><strong>{fmtFull(viewBill.tax_amount||0)}</strong></div>
                  <div className="sb-view-row sb-row-total"><span>Total</span><strong>{fmtFull(viewBill.total_amount)}</strong></div>
                  <div className="sb-view-row"><span>Paid</span><strong className="green">{fmtFull(parseFloat(viewBill.total_amount||0)-parseFloat(viewBill.balance||0))}</strong></div>
                </div>
              </div>

              {/* Line items */}
              {(viewBill.items||[]).length > 0 && (
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
                      {(viewBill.items||[]).map((item,i)=>(
                        <tr key={i}>
                          <td>{item.description}</td>
                          <td className="sb-th-r">{item.quantity}</td>
                          <td className="sb-th-r">{fmtFull(item.unit_price)}</td>
                          <td className="sb-th-r">{item.gst_rate}%</td>
                          <td className="sb-th-r">{fmtFull(item.taxable_amount)}</td>
                          <td className="sb-th-r sb-item-total">{fmtFull(item.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Actions */}
              <div className="sb-view-actions">
                {viewBill.status === 'pending' && (
                  <>
                    <button className="sb-approve-full-btn" onClick={()=>handleApprove(viewBill)}>
                      <ThumbsUp size={14}/> Approve Bill
                    </button>
                    <button className="sb-reject-full-btn" onClick={()=>handleReject(viewBill)}>
                      <ThumbsDown size={14}/> Reject
                    </button>
                  </>
                )}
                {viewBill.status === 'approved' && parseFloat(viewBill.balance||0) > 0 && (
                  <button className="sb-pay-full-btn" onClick={()=>handleMarkPaid(viewBill)}>
                    <CreditCard size={14}/> Record Payment
                  </button>
                )}
                {viewBill.status === 'paid' && (
                  <div className="sb-paid-badge">
                    <CheckCircle size={16} color="#10b981"/> Bill fully paid
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Bill Drawer ─────────────────────────────────── */}
      {drawer === 'create' && (
        <div className="sb-overlay" onClick={()=>setDrawer(null)}>
          <div className="sb-drawer" onClick={e=>e.stopPropagation()}>

            <div className="sb-drawer-hd">
              <div>
                <h3>Record New Bill</h3>
                <p className="sb-drawer-sub">Enter supplier invoice details</p>
              </div>
              <button className="sb-icon-btn" onClick={()=>setDrawer(null)}><X size={18}/></button>
            </div>

            <div className="sb-form-body">

              {/* Row 1 */}
              <div className="sb-form-row">
                <div className="sb-field">
                  <label>Supplier *</label>
                  {suppliers.length > 0 ? (
                    <select value={form.supplier_id}
                      onChange={e=>{
                        const s = suppliers.find(x=>x.id===parseInt(e.target.value));
                        setForm(f=>({...f,supplier_id:e.target.value,supplier_name:s?.name||'',
                          payment_terms:s?.payment_terms||30,
                          due_date:addDays(f.bill_date,s?.payment_terms||30)}));
                      }}>
                      <option value="">— Select Supplier —</option>
                      {suppliers.map(s=>(
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={form.supplier_name}
                      onChange={e=>setForm(f=>({...f,supplier_name:e.target.value}))}
                      placeholder="Supplier name…"/>
                  )}
                </div>
                <div className="sb-field">
                  <label>Bill Number</label>
                  <input value={form.bill_number}
                    onChange={e=>setForm(f=>({...f,bill_number:e.target.value}))}
                    placeholder="Supplier's invoice #"/>
                </div>
                <div className="sb-field">
                  <label>Your Reference</label>
                  <input value={form.reference}
                    onChange={e=>setForm(f=>({...f,reference:e.target.value}))}
                    placeholder="PO # or reference…"/>
                </div>
              </div>

              {/* Row 2 */}
              <div className="sb-form-row">
                <div className="sb-field">
                  <label>Bill Date *</label>
                  <input type="date" value={form.bill_date}
                    onChange={e=>{
                      const d = e.target.value;
                      setForm(f=>({...f,bill_date:d,due_date:addDays(d,f.payment_terms)}));
                    }}/>
                </div>
                <div className="sb-field">
                  <label>Payment Terms</label>
                  <select value={form.payment_terms}
                    onChange={e=>{
                      const n = parseInt(e.target.value);
                      setForm(f=>({...f,payment_terms:n,due_date:addDays(f.bill_date,n)}));
                    }}>
                    {[0,7,15,30,45,60,90].map(n=>(
                      <option key={n} value={n}>{n===0?'Due on Receipt':`Net ${n}`}</option>
                    ))}
                  </select>
                </div>
                <div className="sb-field">
                  <label>Due Date</label>
                  <input type="date" value={form.due_date}
                    onChange={e=>setForm(f=>({...f,due_date:e.target.value}))}/>
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
                      <th style={{width:'35%'}}>Description</th>
                      <th style={{width:'8%'}}>Qty</th>
                      <th style={{width:'14%'}}>Unit Price (₹)</th>
                      <th style={{width:'10%'}}>GST %</th>
                      <th style={{width:'13%'}}>Taxable</th>
                      <th style={{width:'12%'}}>Total</th>
                      <th style={{width:'8%'}}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((item,idx)=>{
                      const c = calcItem(item);
                      return (
                        <tr key={idx}>
                          <td>
                            <input type="text" value={item.description}
                              onChange={e=>updateItem(idx,'description',e.target.value)}
                              placeholder="Item description…"/>
                          </td>
                          <td>
                            <input type="number" min="1" value={item.quantity}
                              onChange={e=>updateItem(idx,'quantity',e.target.value)}/>
                          </td>
                          <td>
                            <input type="number" min="0" step="0.01" value={item.unit_price}
                              onChange={e=>updateItem(idx,'unit_price',e.target.value)}/>
                          </td>
                          <td>
                            <select value={item.gst_rate}
                              onChange={e=>updateItem(idx,'gst_rate',e.target.value)}>
                              {GST_RATES.map(r=><option key={r} value={r}>{r}%</option>)}
                            </select>
                          </td>
                          <td className="sb-td-r sb-td-sm">
                            ₹{c.taxable_amount.toLocaleString('en-IN',{maximumFractionDigits:0})}
                          </td>
                          <td className="sb-td-r sb-td-bold">
                            ₹{c.amount.toLocaleString('en-IN',{maximumFractionDigits:0})}
                          </td>
                          <td>
                            {form.items.length > 1 && (
                              <button type="button" className="sb-remove-item"
                                onClick={()=>removeItem(idx)}>
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
                    <span>₹{totals.subtotal.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>
                  </div>
                  <div className="sb-total-row">
                    <span>GST</span>
                    <span>₹{totals.gst.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>
                  </div>
                  <div className="sb-total-row sb-total-final">
                    <span>Total Amount</span>
                    <span>{fmtFull(totals.total)}</span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div className="sb-field">
                <label>Notes</label>
                <textarea rows={2} value={form.notes}
                  onChange={e=>setForm(f=>({...f,notes:e.target.value}))}
                  placeholder="Internal notes about this bill…"/>
              </div>

              {/* Footer */}
              <div className="sb-form-footer">
                <button className="sb-btn-outline" onClick={()=>setDrawer(null)}>Cancel</button>
                <button className="sb-btn-outline"
                  onClick={()=>handleSubmit('draft')} disabled={submitting}>
                  Save Draft
                </button>
                <button className="sb-btn-primary"
                  onClick={()=>handleSubmit('pending')} disabled={submitting}>
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