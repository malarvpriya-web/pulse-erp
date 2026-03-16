import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, RefreshCw, CreditCard, Building2, FileText,
  ThumbsUp, ThumbsDown, Play, Clock, DollarSign,
  ChevronRight, Banknote, Smartphone, Receipt, Filter
} from 'lucide-react';
import api from '@/services/api/client';
import './PaymentBatch.css';

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
const genBatch = () => `PB-${new Date().getFullYear()}-${String(Math.floor(Math.random()*9000)+1000)}`;

const PAYMENT_METHODS = [
  { value:'neft',     label:'NEFT',          icon: Banknote },
  { value:'rtgs',     label:'RTGS',          icon: Banknote },
  { value:'imps',     label:'IMPS',          icon: Smartphone },
  { value:'upi',      label:'UPI',           icon: Smartphone },
  { value:'cheque',   label:'Cheque',        icon: Receipt },
  { value:'cash',     label:'Cash',          icon: DollarSign },
];

const SAMPLE_BATCHES = [
  {
    id:1, batch_number:'PB-2026-1001', batch_date:'2026-03-12',
    status:'processed', total_amount:84000, payment_count:3,
    bank_account:'HDFC Current A/c ••4521',
    processed_by:'Finance Manager', processed_at:'2026-03-12',
    items:[
      {supplier:'Office Supplies Pvt Ltd', bill_ref:'BILL-2026-020', amount:22000, method:'neft', utr:'HDFC26031200001'},
      {supplier:'Cloud Services Ltd',      bill_ref:'BILL-2026-015', amount:28000, method:'rtgs', utr:'HDFC26031200002'},
      {supplier:'IT Equipment Suppliers',  bill_ref:'BILL-2026-019', amount:34000, method:'rtgs', utr:'HDFC26031200003'},
    ]
  },
  {
    id:2, batch_number:'PB-2026-1002', batch_date:'2026-03-08',
    status:'approved', total_amount:45000, payment_count:1,
    bank_account:'ICICI Current A/c ••7823',
    items:[
      {supplier:'Marketing Agency Co', bill_ref:'BILL-2026-021', amount:45000, method:'neft', utr:''},
    ]
  },
  {
    id:3, batch_number:'PB-2026-1003', batch_date:'2026-03-05',
    status:'pending_approval', total_amount:56000, payment_count:2,
    bank_account:'HDFC Current A/c ••4521',
    items:[
      {supplier:'Cloud Services Ltd',  bill_ref:'BILL-2026-022', amount:28000, method:'neft',  utr:''},
      {supplier:'Legal Associates LLP',bill_ref:'BILL-2026-018', amount:28000, method:'cheque',utr:'CHQ-001234'},
    ]
  },
  {
    id:4, batch_number:'PB-2026-1004', batch_date:'2026-03-15',
    status:'draft', total_amount:28000, payment_count:1,
    bank_account:'HDFC Current A/c ••4521',
    items:[
      {supplier:'Office Supplies Pvt Ltd', bill_ref:'BILL-2026-023', amount:28000, method:'upi', utr:''},
    ]
  },
];

const SAMPLE_BANK_ACCOUNTS = [
  {id:1, account_name:'HDFC Current A/c',  account_number:'XXXX4521', balance:125000, bank:'HDFC Bank'},
  {id:2, account_name:'ICICI Current A/c', account_number:'XXXX7823', balance:87000,  bank:'ICICI Bank'},
  {id:3, account_name:'SBI Savings A/c',   account_number:'XXXX3190', balance:42000,  bank:'State Bank of India'},
];

const SAMPLE_SUPPLIERS = [
  {id:1, name:'Office Supplies Pvt Ltd', outstanding:28000,
   bills:[{id:1,bill_number:'BILL-2026-023',balance:28000}]},
  {id:2, name:'Cloud Services Ltd',      outstanding:56000,
   bills:[{id:2,bill_number:'BILL-2026-022',balance:28000},{id:5,bill_number:'BILL-2026-016',balance:28000}]},
  {id:3, name:'Marketing Agency Co',     outstanding:45000,
   bills:[{id:3,bill_number:'BILL-2026-021',balance:45000}]},
  {id:4, name:'IT Equipment Suppliers',  outstanding:0,     bills:[]},
  {id:5, name:'Legal Associates LLP',    outstanding:28000,
   bills:[{id:4,bill_number:'BILL-2026-018',balance:28000}]},
];

const statusMeta = (s) => {
  const map = {
    draft:            {bg:'#f3f4f6',color:'#6b7280',label:'Draft'},
    pending_approval: {bg:'#fef3c7',color:'#92400e',label:'Pending Approval'},
    approved:         {bg:'#dbeafe',color:'#1d4ed8',label:'Approved'},
    processed:        {bg:'#dcfce7',color:'#16a34a',label:'Processed'},
    rejected:         {bg:'#fee2e2',color:'#dc2626',label:'Rejected'},
  };
  return map[s] || map.draft;
};

const emptyItem = () => ({
  supplier_id:'', supplier_name:'', bill_id:'', bill_ref:'',
  amount:0, method:'neft', reference:'', notes:''
});

export default function PaymentBatch() {
  const [batches,      setBatches]      = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [suppliers,    setSuppliers]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [drawer,       setDrawer]       = useState(null);
  const [viewBatch,    setViewBatch]    = useState(null);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [toast,        setToast]        = useState(null);
  const [submitting,   setSubmitting]   = useState(false);
  const [form,         setForm]         = useState({
    batch_number: genBatch(),
    batch_date:   today(),
    bank_account_id: '',
    bank_account_name: '',
    payment_method_default: 'neft',
    notes: '',
    items: [emptyItem()],
  });

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(()=>setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [batchRes, bankRes, suppRes] = await Promise.allSettled([
        api.get('/finance/payment-batches'),
        api.get('/finance/bank-accounts'),
        api.get('/finance/parties', {params:{party_type:'Supplier'}}),
      ]);
      const raw = batchRes.status==='fulfilled'
        ? (batchRes.value.data?.rows||batchRes.value.data?.batches||batchRes.value.data||[])
        : [];
      setBatches(Array.isArray(raw) && raw.length>0 ? raw : SAMPLE_BATCHES);
      setBankAccounts(bankRes.status==='fulfilled' ? (bankRes.value.data||[]) : SAMPLE_BANK_ACCOUNTS);
      setSuppliers(suppRes.status==='fulfilled' ? (suppRes.value.data||[]) : SAMPLE_SUPPLIERS);
    } catch {
      setBatches(SAMPLE_BATCHES);
      setBankAccounts(SAMPLE_BANK_ACCOUNTS);
      setSuppliers(SAMPLE_SUPPLIERS);
    } finally { setLoading(false); }
  }, []);

  useEffect(()=>{ load(); },[load]);

  // ── Item helpers ──────────────────────────────────────────────────────────
  const updateItem = (idx, field, val) => {
    setForm(f => ({
      ...f,
      items: f.items.map((it,i) => {
        if (i !== idx) return it;
        const updated = {...it, [field]:val};
        if (field==='supplier_id') {
          const sup = SAMPLE_SUPPLIERS.find(s=>s.id===parseInt(val));
          updated.supplier_name = sup?.name||'';
          updated.bill_id = '';
          updated.bill_ref = '';
          updated.amount = 0;
        }
        if (field==='bill_id') {
          const sup = SAMPLE_SUPPLIERS.find(s=>s.id===parseInt(it.supplier_id));
          const bill = sup?.bills?.find(b=>b.id===parseInt(val));
          if (bill) {
            updated.bill_ref = bill.bill_number;
            updated.amount   = bill.balance;
          }
        }
        return updated;
      })
    }));
  };

  const addItem    = () => setForm(f=>({...f,items:[...f.items,emptyItem()]}));
  const removeItem = (idx) => {
    if (form.items.length <= 1) return;
    setForm(f=>({...f,items:f.items.filter((_,i)=>i!==idx)}));
  };

  const batchTotal = form.items.reduce((s,i)=>s+parseFloat(i.amount||0),0);

  // ── Auto-fill payment method for all items ────────────────────────────────
  const applyDefaultMethod = (method) => {
    setForm(f=>({
      ...f,
      payment_method_default: method,
      items: f.items.map(it=>({...it,method}))
    }));
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (status='draft') => {
    if (!form.bank_account_id && !form.bank_account_name) {
      showToast('Select a bank account','error'); return;
    }
    if (form.items.some(i=>!i.supplier_name||parseFloat(i.amount||0)<=0)) {
      showToast('Each payment needs a supplier and amount','error'); return;
    }
    setSubmitting(true);
    try {
      await api.post('/finance/payment-batches', {
        ...form, status, total_amount:batchTotal,
        payment_count: form.items.length,
      });
      showToast(`Batch ${status==='pending_approval'?'submitted for approval':'saved as draft'}`);
      setDrawer(null);
      load();
    } catch {
      const newBatch = {
        id: Date.now(),
        batch_number: form.batch_number,
        batch_date: form.batch_date,
        status, total_amount: batchTotal,
        payment_count: form.items.length,
        bank_account: form.bank_account_name || 'Selected Bank Account',
        items: form.items,
      };
      setBatches(p=>[newBatch,...p]);
      showToast(`Batch ${status==='pending_approval'?'submitted for approval':'saved as draft'}`);
      setDrawer(null);
      resetForm();
    } finally { setSubmitting(false); }
  };

  const handleAction = async (batch, action) => {
    const statusMap = {
      submit:  'pending_approval',
      approve: 'approved',
      process: 'processed',
      reject:  'rejected',
    };
    const newStatus = statusMap[action];
    try {
      await api.post(`/finance/payment-batches/${batch.id}/${action}`);
    } finally {
      setBatches(p=>p.map(b=>b.id===batch.id?{...b,status:newStatus}:b));
      if (viewBatch?.id===batch.id) setViewBatch({...batch,status:newStatus});
      const msgs = {
        submit: 'Batch submitted for approval',
        approve:'Batch approved — ready to process',
        process:'Batch processed — payments initiated',
        reject: 'Batch rejected',
      };
      showToast(msgs[action], action==='reject'?'error':'success');
    }
  };

  const resetForm = () => setForm({
    batch_number: genBatch(), batch_date:today(),
    bank_account_id:'', bank_account_name:'',
    payment_method_default:'neft', notes:'',
    items:[emptyItem()],
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = {
    totalProcessed:  batches.filter(b=>b.status==='processed').reduce((s,b)=>s+parseFloat(b.total_amount||0),0),
    pendingApproval: batches.filter(b=>b.status==='pending_approval').reduce((s,b)=>s+parseFloat(b.total_amount||0),0),
    approved:        batches.filter(b=>b.status==='approved').reduce((s,b)=>s+parseFloat(b.total_amount||0),0),
    draft:           batches.filter(b=>b.status==='draft').length,
    pendingCount:    batches.filter(b=>b.status==='pending_approval').length,
    approvedCount:   batches.filter(b=>b.status==='approved').length,
  };

  const filtered = batches.filter(b => {
    const q = search.toLowerCase();
    const ms = !q ||
      (b.batch_number||'').toLowerCase().includes(q) ||
      (b.bank_account||'').toLowerCase().includes(q);
    const mf = !statusFilter || b.status===statusFilter;
    return ms && mf;
  });

  return (
    <div className="pb-root">

      {/* Toast */}
      {toast && (
        <div className={`pb-toast pb-toast-${toast.type}`}>
          {toast.type==='success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="pb-header">
        <div>
          <h2 className="pb-title">Payment Batches</h2>
          <p className="pb-sub">Bulk supplier payment scheduling & processing</p>
        </div>
        <div className="pb-header-r">
          <button className="pb-btn-outline"><Download size={14}/> Export</button>
          <button className="pb-btn-primary" onClick={()=>setDrawer('create')}>
            <Plus size={15}/> New Batch
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="pb-stats">
        <div className="pb-stat">
          <div className="pb-stat-icon" style={{background:'#dcfce7',color:'#16a34a'}}><CheckCircle size={17}/></div>
          <div>
            <span className="pb-stat-label">Processed (YTD)</span>
            <span className="pb-stat-val">{fmt(stats.totalProcessed)}</span>
            <span className="pb-stat-sub">{batches.filter(b=>b.status==='processed').length} batches</span>
          </div>
        </div>
        <div className="pb-stat pb-stat-amber">
          <div className="pb-stat-icon" style={{background:'#fef3c7',color:'#d97706'}}><Clock size={17}/></div>
          <div>
            <span className="pb-stat-label">Pending Approval</span>
            <span className="pb-stat-val">{fmt(stats.pendingApproval)}</span>
            <span className="pb-stat-sub">{stats.pendingCount} batch{stats.pendingCount!==1?'es':''}</span>
          </div>
        </div>
        <div className="pb-stat pb-stat-blue">
          <div className="pb-stat-icon" style={{background:'#dbeafe',color:'#1d4ed8'}}><Play size={17}/></div>
          <div>
            <span className="pb-stat-label">Approved — Ready</span>
            <span className="pb-stat-val">{fmt(stats.approved)}</span>
            <span className="pb-stat-sub">{stats.approvedCount} ready to process</span>
          </div>
        </div>
        <div className="pb-stat">
          <div className="pb-stat-icon" style={{background:'#f3f4f6',color:'#6b7280'}}><FileText size={17}/></div>
          <div>
            <span className="pb-stat-label">Draft Batches</span>
            <span className="pb-stat-val">{stats.draft}</span>
            <span className="pb-stat-sub">Not submitted yet</span>
          </div>
        </div>
      </div>

      {/* Pending approval alert */}
      {stats.pendingCount > 0 && (
        <div className="pb-alert-banner">
          <Clock size={14}/>
          <span>
            <strong>{stats.pendingCount} batch{stats.pendingCount>1?'es':''}</strong>
            {' '}awaiting approval — {fmt(stats.pendingApproval)} pending authorization
          </span>
          <button className="pb-alert-btn" onClick={()=>setStatusFilter('pending_approval')}>
            Review Now <ChevronRight size={12}/>
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="pb-filters">
        <div className="pb-search">
          <Search size={14}/>
          <input placeholder="Search batch # or bank account…"
            value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button className="pb-clear" onClick={()=>setSearch('')}><X size={12}/></button>}
        </div>
        <div className="pb-filter-tabs">
          {[
            {value:'',               label:'All'},
            {value:'draft',          label:'Draft'},
            {value:'pending_approval',label:'Pending'},
            {value:'approved',       label:'Approved'},
            {value:'processed',      label:'Processed'},
            {value:'rejected',       label:'Rejected'},
          ].map(s=>(
            <button key={s.value}
              className={`pb-filter-tab${statusFilter===s.value?' active':''}`}
              onClick={()=>setStatusFilter(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Batch cards */}
      {loading ? (
        <div className="pb-loading"><div className="pb-spinner"/><p>Loading batches…</p></div>
      ) : filtered.length === 0 ? (
        <div className="pb-empty">
          <CreditCard size={36} color="#d1d5db"/>
          <p>No payment batches found</p>
          <button className="pb-btn-primary" onClick={()=>setDrawer('create')}>
            <Plus size={14}/> Create First Batch
          </button>
        </div>
      ) : (
        <div className="pb-cards">
          {filtered.map((batch,i) => {
            const sm = statusMeta(batch.status);
            return (
              <div key={batch.id||i} className="pb-card">
                <div className="pb-card-hd">
                  <div className="pb-card-left">
                    <button className="pb-batch-num" onClick={()=>setViewBatch(batch)}>
                      {batch.batch_number}
                    </button>
                    <span className="pb-batch-date">
                      {batch.batch_date ? new Date(batch.batch_date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'}
                    </span>
                  </div>
                  <span className="pb-status-badge" style={{background:sm.bg,color:sm.color}}>
                    {sm.label}
                  </span>
                </div>

                <div className="pb-card-body">
                  <div className="pb-card-meta">
                    <div className="pb-card-meta-item">
                      <Building2 size={12}/>
                      <span>{batch.bank_account || 'Bank Account'}</span>
                    </div>
                    <div className="pb-card-meta-item">
                      <FileText size={12}/>
                      <span>{batch.payment_count} payment{batch.payment_count!==1?'s':''}</span>
                    </div>
                  </div>

                  <div className="pb-card-amount">{fmtFull(batch.total_amount)}</div>

                  {/* Payment items preview */}
                  {(batch.items||[]).slice(0,3).map((item,j)=>(
                    <div key={j} className="pb-item-preview">
                      <div className="pb-item-preview-avatar">
                        {(item.supplier||'S').charAt(0)}
                      </div>
                      <span className="pb-item-supplier">{item.supplier}</span>
                      <span className="pb-item-bill">{item.bill_ref}</span>
                      <span className="pb-method-pill">
                        {(item.method||'neft').toUpperCase()}
                      </span>
                      <span className="pb-item-amount">{fmt(item.amount)}</span>
                    </div>
                  ))}
                  {(batch.items||[]).length > 3 && (
                    <div className="pb-more-items">
                      +{(batch.items||[]).length-3} more payments
                    </div>
                  )}
                </div>

                <div className="pb-card-footer">
                  <button className="pb-card-view-btn" onClick={()=>setViewBatch(batch)}>
                    <Eye size={13}/> View Details
                  </button>
                  <div className="pb-card-actions">
                    {batch.status === 'draft' && (
                      <button className="pb-action-submit"
                        onClick={()=>handleAction(batch,'submit')}>
                        Submit for Approval
                      </button>
                    )}
                    {batch.status === 'pending_approval' && (
                      <>
                        <button className="pb-action-approve"
                          onClick={()=>handleAction(batch,'approve')}>
                          <ThumbsUp size={12}/> Approve
                        </button>
                        <button className="pb-action-reject"
                          onClick={()=>handleAction(batch,'reject')}>
                          <ThumbsDown size={12}/> Reject
                        </button>
                      </>
                    )}
                    {batch.status === 'approved' && (
                      <button className="pb-action-process"
                        onClick={()=>handleAction(batch,'process')}>
                        <Play size={12}/> Process Payments
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── View Batch Drawer ─────────────────────────────────── */}
      {viewBatch && !drawer && (
        <div className="pb-overlay" onClick={()=>setViewBatch(null)}>
          <div className="pb-drawer pb-drawer-wide" onClick={e=>e.stopPropagation()}>
            <div className="pb-drawer-hd">
              <div>
                <h3 className="pb-drawer-title">{viewBatch.batch_number}</h3>
                <div className="pb-drawer-meta">
                  <span className="pb-status-badge"
                    style={statusMeta(viewBatch.status)}>
                    {statusMeta(viewBatch.status).label}
                  </span>
                  <span className="pb-drawer-date">
                    {viewBatch.batch_date ? new Date(viewBatch.batch_date).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}) : ''}
                  </span>
                </div>
              </div>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <button className="pb-btn-outline"><Download size={13}/> Export</button>
                <button className="pb-icon-btn" onClick={()=>setViewBatch(null)}><X size={18}/></button>
              </div>
            </div>

            <div className="pb-view-body">
              {/* Summary strip */}
              <div className="pb-view-strip">
                <div className="pb-vs-item">
                  <span>Total Amount</span>
                  <strong>{fmtFull(viewBatch.total_amount)}</strong>
                </div>
                <div className="pb-vs-item">
                  <span>Payments</span>
                  <strong>{viewBatch.payment_count}</strong>
                </div>
                <div className="pb-vs-item">
                  <span>Bank Account</span>
                  <strong>{viewBatch.bank_account||'—'}</strong>
                </div>
                <div className="pb-vs-item">
                  <span>Batch Date</span>
                  <strong>{viewBatch.batch_date ? new Date(viewBatch.batch_date).toLocaleDateString('en-IN') : '—'}</strong>
                </div>
              </div>

              {/* Workflow timeline */}
              <div className="pb-workflow">
                {[
                  {step:'Created',  done:true},
                  {step:'Submitted',done:['pending_approval','approved','processed'].includes(viewBatch.status)},
                  {step:'Approved', done:['approved','processed'].includes(viewBatch.status)},
                  {step:'Processed',done:viewBatch.status==='processed'},
                ].map((w,i,arr)=>(
                  <div key={i} className="pb-wf-step">
                    <div className={`pb-wf-dot ${w.done?'pb-wf-done':''}`}>
                      {w.done && <CheckCircle size={12} color="#fff"/>}
                    </div>
                    <span className={`pb-wf-label ${w.done?'pb-wf-label-done':''}`}>{w.step}</span>
                    {i < arr.length-1 && <div className={`pb-wf-line ${arr[i+1].done?'pb-wf-line-done':''}`}/>}
                  </div>
                ))}
              </div>

              {/* Payment items */}
              <div className="pb-view-items">
                <h4>Payment Items</h4>
                <table className="pb-items-table">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th>Bill Reference</th>
                      <th>Method</th>
                      <th>UTR / Ref #</th>
                      <th className="pb-th-r">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewBatch.items||[]).map((item,i)=>(
                      <tr key={i}>
                        <td>
                          <div className="pb-item-sup-cell">
                            <div className="pb-item-sup-av">{(item.supplier||'S').charAt(0)}</div>
                            <span>{item.supplier}</span>
                          </div>
                        </td>
                        <td><span className="pb-bill-ref">{item.bill_ref||'—'}</span></td>
                        <td>
                          <span className="pb-method-badge">
                            {(item.method||'neft').toUpperCase()}
                          </span>
                        </td>
                        <td>
                          {item.utr
                            ? <span className="pb-utr">{item.utr}</span>
                            : <span className="pb-utr-pending">—</span>}
                        </td>
                        <td className="pb-th-r pb-item-amt">{fmtFull(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}><strong>Total</strong></td>
                      <td className="pb-th-r">
                        <strong>{fmtFull(viewBatch.total_amount)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Actions */}
              <div className="pb-view-actions">
                {viewBatch.status==='draft' && (
                  <button className="pb-full-submit"
                    onClick={()=>handleAction(viewBatch,'submit')}>
                    Submit for Approval
                  </button>
                )}
                {viewBatch.status==='pending_approval' && (
                  <>
                    <button className="pb-full-approve"
                      onClick={()=>handleAction(viewBatch,'approve')}>
                      <ThumbsUp size={14}/> Approve Batch
                    </button>
                    <button className="pb-full-reject"
                      onClick={()=>handleAction(viewBatch,'reject')}>
                      <ThumbsDown size={14}/> Reject
                    </button>
                  </>
                )}
                {viewBatch.status==='approved' && (
                  <button className="pb-full-process"
                    onClick={()=>handleAction(viewBatch,'process')}>
                    <Play size={14}/> Process Payments
                  </button>
                )}
                {viewBatch.status==='processed' && (
                  <div className="pb-processed-badge">
                    <CheckCircle size={16} color="#10b981"/>
                    All payments processed successfully
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Batch Drawer ───────────────────────────────── */}
      {drawer === 'create' && (
        <div className="pb-overlay" onClick={()=>setDrawer(null)}>
          <div className="pb-drawer" onClick={e=>e.stopPropagation()}>
            <div className="pb-drawer-hd">
              <div>
                <h3>New Payment Batch</h3>
                <p className="pb-drawer-sub">Group multiple supplier payments</p>
              </div>
              <button className="pb-icon-btn" onClick={()=>setDrawer(null)}><X size={18}/></button>
            </div>

            <div className="pb-form-body">

              {/* Meta */}
              <div className="pb-form-row">
                <div className="pb-field">
                  <label>Batch Reference</label>
                  <input value={form.batch_number}
                    onChange={e=>setForm(f=>({...f,batch_number:e.target.value}))}/>
                </div>
                <div className="pb-field">
                  <label>Payment Date *</label>
                  <input type="date" value={form.batch_date}
                    onChange={e=>setForm(f=>({...f,batch_date:e.target.value}))}/>
                </div>
              </div>

              {/* Bank account */}
              <div className="pb-field">
                <label>Paying From (Bank Account) *</label>
                <div className="pb-bank-cards">
                  {(bankAccounts.length>0 ? bankAccounts : SAMPLE_BANK_ACCOUNTS).map(ba=>(
                    <div key={ba.id}
                      className={`pb-bank-card ${form.bank_account_id===String(ba.id)?'pb-bank-selected':''}`}
                      onClick={()=>setForm(f=>({...f,bank_account_id:String(ba.id),bank_account_name:`${ba.account_name} ••${ba.account_number.slice(-4)}`}))}>
                      <div className="pb-bank-icon"><Building2 size={16}/></div>
                      <div>
                        <p className="pb-bank-name">{ba.account_name}</p>
                        <p className="pb-bank-num">••{ba.account_number?.slice(-4)} · {ba.bank||''}</p>
                        <p className="pb-bank-bal">Balance: {fmt(ba.balance)}</p>
                      </div>
                      {form.bank_account_id===String(ba.id) && (
                        <CheckCircle size={16} color="#6366f1" className="pb-bank-check"/>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Default payment method */}
              <div className="pb-field">
                <label>Default Payment Method</label>
                <div className="pb-method-row">
                  {PAYMENT_METHODS.map(m=>(
                    <button key={m.value}
                      className={`pb-method-btn ${form.payment_method_default===m.value?'active':''}`}
                      onClick={()=>applyDefaultMethod(m.value)}>
                      <m.icon size={13}/>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Payment items */}
              <div className="pb-items-section">
                <div className="pb-items-hd">
                  <span>Payment Items ({form.items.length})</span>
                  <button className="pb-add-item" onClick={addItem}>
                    <Plus size={12}/> Add Payment
                  </button>
                </div>

                {form.items.map((item,idx)=>(
                  <div key={idx} className="pb-item-row">
                    <div className="pb-item-num">{idx+1}</div>
                    <div className="pb-item-fields">
                      <div className="pb-item-row-top">
                        <div className="pb-field pb-field-flex2">
                          <label>Supplier</label>
                          <select value={item.supplier_id}
                            onChange={e=>updateItem(idx,'supplier_id',e.target.value)}>
                            <option value="">— Select Supplier —</option>
                            {(suppliers.length>0?suppliers:SAMPLE_SUPPLIERS).map(s=>(
                              <option key={s.id} value={s.id}>
                                {s.name} {s.outstanding>0?`(Outstanding: ${fmt(s.outstanding)})` :''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="pb-field pb-field-flex2">
                          <label>Bill / Invoice</label>
                          <select value={item.bill_id}
                            onChange={e=>updateItem(idx,'bill_id',e.target.value)}
                            disabled={!item.supplier_id}>
                            <option value="">— Select Bill —</option>
                            {(SAMPLE_SUPPLIERS.find(s=>s.id===parseInt(item.supplier_id))?.bills||[]).map(b=>(
                              <option key={b.id} value={b.id}>
                                {b.bill_number} — {fmt(b.balance)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="pb-field pb-field-flex1">
                          <label>Amount (₹)</label>
                          <input type="number" min="0" step="0.01"
                            value={item.amount||''}
                            onChange={e=>updateItem(idx,'amount',e.target.value)}
                            placeholder="0.00"/>
                        </div>
                      </div>
                      <div className="pb-item-row-bot">
                        <div className="pb-field pb-field-flex1">
                          <label>Method</label>
                          <select value={item.method}
                            onChange={e=>updateItem(idx,'method',e.target.value)}>
                            {PAYMENT_METHODS.map(m=>(
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="pb-field pb-field-flex2">
                          <label>Reference / UTR <span className="pb-opt">(optional)</span></label>
                          <input value={item.reference}
                            onChange={e=>updateItem(idx,'reference',e.target.value)}
                            placeholder="Cheque #, UTR, UPI ID…"/>
                        </div>
                        <div className="pb-field pb-field-flex2">
                          <label>Notes <span className="pb-opt">(optional)</span></label>
                          <input value={item.notes}
                            onChange={e=>updateItem(idx,'notes',e.target.value)}
                            placeholder="Note…"/>
                        </div>
                      </div>
                    </div>
                    <button className="pb-remove-item" onClick={()=>removeItem(idx)}
                      disabled={form.items.length<=1}>
                      <X size={13}/>
                    </button>
                  </div>
                ))}

                {/* Total */}
                <div className="pb-batch-total">
                  <span>Batch Total ({form.items.length} payments)</span>
                  <strong>{fmtFull(batchTotal)}</strong>
                </div>

                {/* Balance check */}
                {form.bank_account_id && (() => {
                  const ba = SAMPLE_BANK_ACCOUNTS.find(b=>b.id===parseInt(form.bank_account_id));
                  const suf = ba && batchTotal > ba.balance;
                  return suf ? (
                    <div className="pb-balance-warn">
                      <AlertTriangle size={13}/>
                      <span>Batch total {fmt(batchTotal)} exceeds bank balance {fmt(ba.balance)}</span>
                    </div>
                  ) : ba ? (
                    <div className="pb-balance-ok">
                      <CheckCircle size={13}/>
                      <span>Sufficient balance — Remaining after payment: {fmt(ba.balance - batchTotal)}</span>
                    </div>
                  ) : null;
                })()}
              </div>

              {/* Notes */}
              <div className="pb-field">
                <label>Batch Notes</label>
                <textarea rows={2} value={form.notes}
                  onChange={e=>setForm(f=>({...f,notes:e.target.value}))}
                  placeholder="Notes about this payment batch…"/>
              </div>

              {/* Footer */}
              <div className="pb-form-footer">
                <button className="pb-btn-outline" onClick={()=>setDrawer(null)}>Cancel</button>
                <button className="pb-btn-outline"
                  onClick={()=>handleSubmit('draft')} disabled={submitting}>
                  Save Draft
                </button>
                <button className="pb-btn-primary"
                  onClick={()=>handleSubmit('pending_approval')} disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit for Approval'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}