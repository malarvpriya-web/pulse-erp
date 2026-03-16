import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, Filter, Download, Eye, Send, CheckCircle,
  AlertTriangle, Clock, X, ChevronDown, FileText, Printer
} from 'lucide-react';
import api from '@/services/api/client';
import { getInvoices, createInvoice, getParties, getAccounts } from '../services/financeService';
import './Invoices.css';

const fmt = (n) => {
  const num = parseFloat(n || 0);
  if (num >= 100000) return `₹${(num/100000).toFixed(1)}L`;
  if (num >= 1000)   return `₹${(num/1000).toFixed(0)}K`;
  return `₹${num.toFixed(0)}`;
};

const fmtFull = (n) => `₹${parseFloat(n||0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;

const statusColor = (s) => {
  const m = (s||'').toLowerCase();
  if (m==='paid')    return {bg:'#dcfce7',color:'#16a34a'};
  if (m==='overdue') return {bg:'#fee2e2',color:'#dc2626'};
  if (m==='pending'||m==='sent') return {bg:'#fef3c7',color:'#92400e'};
  return {bg:'#f3f4f6',color:'#6b7280'};
};

const GST_RATES = [0, 5, 12, 18, 28];

const emptyItem = () => ({ description:'', quantity:1, unit_price:0, gst_rate:18, amount:0 });

const calcItem = (item) => {
  const base = (parseFloat(item.quantity)||0) * (parseFloat(item.unit_price)||0);
  const gst  = base * (parseFloat(item.gst_rate)||0) / 100;
  return { ...item, taxable_amount: base, gst_amount: gst, amount: base + gst };
};

export default function Invoices() {
  const [invoices,   setInvoices]   = useState([]);
  const [customers,  setCustomers]  = useState([]);
  const [accounts,   setAccounts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [drawer,     setDrawer]     = useState(null); // null | 'create' | invoice object
  const [search,     setSearch]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [toast,      setToast]      = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    customer_id: '', invoice_date: new Date().toISOString().split('T')[0],
    due_date: '', notes: '', terms: 'Net 30',
    accounts_receivable_id: '', revenue_account_id: '', tax_account_id: '',
    items: [emptyItem()],
  });

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [inv, cust, acc] = await Promise.all([
        getInvoices({ status: statusFilter || undefined }),
        getParties({ party_type: 'Customer' }),
        getAccounts(),
      ]);
      setInvoices(Array.isArray(inv) ? inv : []);
      setCustomers(Array.isArray(cust) ? cust : []);
      setAccounts(Array.isArray(acc) ? acc : []);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  // computed totals
  const calcTotals = () => {
    const items = form.items.map(calcItem);
    const taxable = items.reduce((s,i) => s + i.taxable_amount, 0);
    const gst     = items.reduce((s,i) => s + i.gst_amount,     0);
    return { taxable, gst, total: taxable + gst, items };
  };

  const updateItem = (idx, field, val) => {
    const items = form.items.map((it, i) => i===idx ? calcItem({...it, [field]:val}) : it);
    setForm(f => ({...f, items}));
  };

  const addItem    = () => setForm(f => ({...f, items:[...f.items, emptyItem()]}));
  const removeItem = (idx) => setForm(f => ({...f, items: f.items.filter((_,i)=>i!==idx)}));

  const handleSubmit = async () => {
    if (!form.customer_id) { showToast('Select a customer', 'error'); return; }
    if (!form.due_date)    { showToast('Set a due date',    'error'); return; }
    setSubmitting(true);
    try {
      const totals = calcTotals();
      await createInvoice({
        ...form,
        subtotal:     totals.taxable,
        tax_amount:   totals.gst,
        total_amount: totals.total,
        items:        totals.items,
      });
      showToast('Invoice created successfully');
      setDrawer(null);
      setForm({ customer_id:'', invoice_date:new Date().toISOString().split('T')[0],
        due_date:'', notes:'', terms:'Net 30',
        accounts_receivable_id:'', revenue_account_id:'', tax_account_id:'',
        items:[emptyItem()] });
      load();
    } catch(e) {
      showToast('Failed to create invoice: ' + (e.response?.data?.error||e.message), 'error');
    } finally { setSubmitting(false); }
  };

  const filtered = invoices.filter(inv => {
    const q = search.toLowerCase();
    return !q ||
      (inv.invoice_number||'').toLowerCase().includes(q) ||
      (inv.party_name||inv.customer_name||'').toLowerCase().includes(q);
  });

  // Summary stats
  const stats = {
    total:   invoices.reduce((s,i) => s + parseFloat(i.total_amount||0), 0),
    paid:    invoices.filter(i=>(i.status||'').toLowerCase()==='paid').reduce((s,i)=>s+parseFloat(i.total_amount||0),0),
    overdue: invoices.filter(i=>(i.status||'').toLowerCase()==='overdue').reduce((s,i)=>s+parseFloat(i.total_amount||0),0),
    pending: invoices.filter(i=>['pending','sent','draft'].includes((i.status||'').toLowerCase())).length,
  };

  const totals = calcTotals();

  return (
    <div className="inv-root">

      {/* Toast */}
      {toast && (
        <div className={`inv-toast inv-toast-${toast.type}`}>
          {toast.type==='success' ? <CheckCircle size={15}/> : <AlertTriangle size={15}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="inv-header">
        <div>
          <h2 className="inv-title">Invoices</h2>
          <p className="inv-sub">{invoices.length} invoices · {new Date().toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</p>
        </div>
        <div className="inv-header-r">
          <button className="inv-btn-outline"><Download size={14}/> Export</button>
          <button className="inv-btn-primary" onClick={()=>setDrawer('create')}>
            <Plus size={15}/> New Invoice
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="inv-stats">
        <div className="inv-stat">
          <span className="inv-stat-label">Total Invoiced</span>
          <span className="inv-stat-val">{fmt(stats.total)}</span>
        </div>
        <div className="inv-stat green">
          <span className="inv-stat-label">Collected</span>
          <span className="inv-stat-val">{fmt(stats.paid)}</span>
        </div>
        <div className="inv-stat red">
          <span className="inv-stat-label">Overdue</span>
          <span className="inv-stat-val">{fmt(stats.overdue)}</span>
        </div>
        <div className="inv-stat amber">
          <span className="inv-stat-label">Pending</span>
          <span className="inv-stat-val">{stats.pending} invoices</span>
        </div>
      </div>

      {/* Filters */}
      <div className="inv-filters">
        <div className="inv-search">
          <Search size={14}/>
          <input placeholder="Search invoice # or customer…"
            value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
        <div className="inv-filter-tabs">
          {['','draft','pending','paid','overdue'].map(s=>(
            <button key={s}
              className={`inv-filter-tab${statusFilter===s?' active':''}`}
              onClick={()=>setStatusFilter(s)}>
              {s ? s.charAt(0).toUpperCase()+s.slice(1) : 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="inv-table-wrap">
        {loading ? (
          <div className="inv-loading"><div className="inv-spinner"/><p>Loading invoices…</p></div>
        ) : filtered.length === 0 ? (
          <div className="inv-empty">
            <FileText size={36} color="#d1d5db"/>
            <p>No invoices found</p>
            <button className="inv-btn-primary" onClick={()=>setDrawer('create')}>
              <Plus size={14}/> Create First Invoice
            </button>
          </div>
        ) : (
          <table className="inv-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Customer</th>
                <th>Invoice Date</th>
                <th>Due Date</th>
                <th>Amount</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv,i) => {
                const sc = statusColor(inv.status);
                const isOverdue = (inv.status||'').toLowerCase()==='overdue';
                return (
                  <tr key={inv.id||i} className={isOverdue?'inv-tr-overdue':''}>
                    <td>
                      <button className="inv-link" onClick={()=>setDrawer(inv)}>
                        {inv.invoice_number}
                      </button>
                    </td>
                    <td>{inv.party_name||inv.customer_name||'—'}</td>
                    <td>{inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-IN') : '—'}</td>
                    <td>
                      <span className={isOverdue?'inv-overdue-date':''}>
                        {inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-IN') : '—'}
                      </span>
                    </td>
                    <td className="inv-td-amt">{fmtFull(inv.total_amount)}</td>
                    <td className="inv-td-amt">{fmtFull(inv.balance??inv.total_amount)}</td>
                    <td>
                      <span className="inv-status" style={sc}>{inv.status||'Draft'}</span>
                    </td>
                    <td>
                      <div className="inv-actions">
                        <button className="inv-action-btn" title="View" onClick={()=>setDrawer(inv)}>
                          <Eye size={14}/>
                        </button>
                        <button className="inv-action-btn" title="Send">
                          <Send size={14}/>
                        </button>
                        <button className="inv-action-btn" title="Print">
                          <Printer size={14}/>
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

      {/* ── Create / View Drawer ──────────────────────────────────── */}
      {drawer && (
        <div className="inv-drawer-overlay" onClick={()=>setDrawer(null)}>
          <div className="inv-drawer" onClick={e=>e.stopPropagation()}>

            <div className="inv-drawer-hd">
              <h3>{drawer==='create' ? 'New Invoice' : `Invoice ${drawer.invoice_number}`}</h3>
              <button className="inv-drawer-close" onClick={()=>setDrawer(null)}>
                <X size={18}/>
              </button>
            </div>

            <div className="inv-drawer-body">

              {/* ── VIEW MODE ────────────────────────────────────── */}
              {drawer !== 'create' && (
                <div className="inv-view">
                  <div className="inv-view-header">
                    <div>
                      <div className="inv-view-num">{drawer.invoice_number}</div>
                      <div className="inv-view-party">{drawer.party_name||drawer.customer_name}</div>
                    </div>
                    <span className="inv-status inv-status-lg" style={statusColor(drawer.status)}>
                      {drawer.status}
                    </span>
                  </div>
                  <div className="inv-view-grid">
                    <div className="inv-view-field"><span>Invoice Date</span><strong>{drawer.invoice_date ? new Date(drawer.invoice_date).toLocaleDateString('en-IN') : '—'}</strong></div>
                    <div className="inv-view-field"><span>Due Date</span><strong className={(drawer.status||'').toLowerCase()==='overdue'?'red':''}>{drawer.due_date ? new Date(drawer.due_date).toLocaleDateString('en-IN') : '—'}</strong></div>
                    <div className="inv-view-field"><span>Total Amount</span><strong>{fmtFull(drawer.total_amount)}</strong></div>
                    <div className="inv-view-field"><span>Balance Due</span><strong>{fmtFull(drawer.balance??drawer.total_amount)}</strong></div>
                  </div>
                  <div className="inv-view-actions">
                    <button className="inv-btn-primary"><Send size={14}/> Send to Customer</button>
                    <button className="inv-btn-outline"><Printer size={14}/> Print / PDF</button>
                    {(drawer.status||'').toLowerCase()!=='paid' && (
                      <button className="inv-btn-green"><CheckCircle size={14}/> Mark as Paid</button>
                    )}
                  </div>
                </div>
              )}

              {/* ── CREATE MODE ───────────────────────────────────── */}
              {drawer === 'create' && (
                <div className="inv-form">
                  {/* Row 1 */}
                  <div className="inv-form-row">
                    <div className="inv-field">
                      <label>Customer *</label>
                      <select value={form.customer_id}
                        onChange={e=>setForm(f=>({...f,customer_id:e.target.value}))}>
                        <option value="">— Select Customer —</option>
                        {customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div className="inv-field">
                      <label>Invoice Date *</label>
                      <input type="date" value={form.invoice_date}
                        onChange={e=>setForm(f=>({...f,invoice_date:e.target.value}))}/>
                    </div>
                    <div className="inv-field">
                      <label>Due Date *</label>
                      <input type="date" value={form.due_date}
                        onChange={e=>setForm(f=>({...f,due_date:e.target.value}))}/>
                    </div>
                    <div className="inv-field">
                      <label>Terms</label>
                      <select value={form.terms}
                        onChange={e=>setForm(f=>({...f,terms:e.target.value}))}>
                        {['Net 7','Net 15','Net 30','Net 45','Net 60','Due on Receipt'].map(t=>(
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Line Items */}
                  <div className="inv-items-section">
                    <div className="inv-items-hd">
                      <span>Line Items</span>
                      <button type="button" className="inv-add-item" onClick={addItem}>
                        <Plus size={13}/> Add Item
                      </button>
                    </div>
                    <table className="inv-items-table">
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
                          const calc = calcItem(item);
                          return (
                            <tr key={idx}>
                              <td>
                                <input type="text" value={item.description}
                                  onChange={e=>updateItem(idx,'description',e.target.value)}
                                  placeholder="Description…"/>
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
                              <td className="inv-td-right">₹{calc.taxable_amount.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                              <td className="inv-td-right inv-td-bold">₹{calc.amount.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                              <td>
                                {form.items.length > 1 && (
                                  <button type="button" className="inv-remove-item"
                                    onClick={()=>removeItem(idx)}>
                                    <X size={13}/>
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
                  <div className="inv-totals">
                    <div className="inv-totals-box">
                      <div className="inv-total-row">
                        <span>Subtotal (Taxable)</span>
                        <span>₹{totals.taxable.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>
                      </div>
                      <div className="inv-total-row">
                        <span>GST</span>
                        <span>₹{totals.gst.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>
                      </div>
                      <div className="inv-total-row inv-total-final">
                        <span>Total Amount</span>
                        <span>{fmtFull(totals.total)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Notes */}
                  <div className="inv-field">
                    <label>Notes / Payment Instructions</label>
                    <textarea rows={3} value={form.notes}
                      onChange={e=>setForm(f=>({...f,notes:e.target.value}))}
                      placeholder="Thank you for your business…"/>
                  </div>

                  {/* Submit */}
                  <div className="inv-form-footer">
                    <button className="inv-btn-outline" onClick={()=>setDrawer(null)}>Cancel</button>
                    <button className="inv-btn-outline">Save as Draft</button>
                    <button className="inv-btn-primary" onClick={handleSubmit} disabled={submitting}>
                      {submitting ? 'Creating…' : 'Create Invoice'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}