import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, Search, Filter, Download, Eye, Send, CheckCircle,
  AlertTriangle, Clock, X, ChevronDown, FileText, Printer, Paperclip
} from 'lucide-react';
import { getInvoices, createInvoice, updateInvoice, getParties } from '../services/financeService';
import { fmt, fmtFull, statusColor, GST_RATES, emptyItem, calcItem } from '../financeUtils';
import { currentFY } from '@/utils/format';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import api from '@/services/api/client';
import './Invoices.css';

const _fy = currentFY();

const _quickRanges = () => {
  const now   = new Date();
  const y     = now.getFullYear();
  const m     = now.getMonth();
  const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const monthEnd   = new Date(y, m + 1, 0).toISOString().split('T')[0];
  const lm    = m === 0 ? 11 : m - 1;
  const ly    = m === 0 ? y - 1 : y;
  const lmEnd = new Date(ly, lm + 1, 0).toISOString().split('T')[0];
  const lmStart = `${ly}-${String(lm + 1).padStart(2, '0')}-01`;
  const qStart = `${y}-${String(Math.floor(m / 3) * 3 + 1).padStart(2, '0')}-01`;
  const qEnd   = new Date(y, Math.floor(m / 3) * 3 + 3, 0).toISOString().split('T')[0];
  return [
    { label: 'This Month',   from: monthStart,    to: monthEnd },
    { label: 'Last Month',   from: lmStart,       to: lmEnd },
    { label: 'This Quarter', from: qStart,         to: qEnd },
    { label: 'This FY',      from: _fy.start,      to: _fy.end },
    { label: 'All Time',     from: '',             to: '' },
  ];
};

export default function Invoices() {
  const { fyParams } = useFY();
  const [invoices,   setInvoices]   = useState([]);
  const [customers,  setCustomers]  = useState([]);
  const [editMode,    setEditMode]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [drawer,     setDrawer]     = useState(null); // null | 'create' | invoice object
  const [search,     setSearch]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom,   setDateFrom]   = useState(_fy.start);
  const [dateTo,     setDateTo]     = useState(_fy.end);
  const [toast,      setToast]      = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const [form, setForm] = useState({
    customer_id: '', invoice_date: new Date().toISOString().split('T')[0],
    due_date: '', notes: '', terms: 'Net 30',
    accounts_receivable_id: '', revenue_account_id: '', tax_account_id: '',
    items: [emptyItem()],
  });
  const [attachmentFile, setAttachmentFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [pendingMarkPaid, setPendingMarkPaid] = useState(null);
  const fileInputRef = useRef(null);

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { status: statusFilter || undefined };
      if (dateFrom) params.from_date = dateFrom;
      if (dateTo)   params.to_date   = dateTo;
      const [inv, cust] = await Promise.all([
        getInvoices(params),
        getParties({ party_type: 'Customer' }),
      ]);
      setInvoices(Array.isArray(inv) ? inv : []);
      setCustomers(Array.isArray(cust) ? cust : []);
    } catch(e) { console.error(e); showToast('Failed to load invoices. Please refresh.', 'error'); }
    finally { setLoading(false); }
  }, [statusFilter, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // Sync the date range whenever the global Financial Year changes
  useEffect(() => {
    setDateFrom(fyParams.fyStart);
    setDateTo(fyParams.fyEnd);
  }, [fyParams.fyStart, fyParams.fyEnd]);

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

  const handleSubmit = async (status = 'pending') => {
    if (!form.customer_id) { showToast('Select a customer', 'error'); return; }
    if (!form.due_date)    { showToast('Set a due date',    'error'); return; }
    setSubmitting(true);
    try {
      const totals = calcTotals();
      const payload = { ...form, status, subtotal: totals.taxable, tax_amount: totals.gst, total_amount: totals.total, items: totals.items };
      let invoice;
      if (editMode && drawer && drawer !== 'create') {
        invoice = await updateInvoice(drawer.id, payload);
        showToast('Invoice updated successfully');
      } else {
        invoice = await createInvoice(payload);
        showToast('Invoice created successfully');
      }
      if (attachmentFile && invoice?.id) {
        setUploading(true);
        try {
          const fd = new FormData();
          fd.append('file', attachmentFile);
          await api.patch(`/finance/invoices/${invoice.id}/attachment`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        } catch { /* attachment upload failure is non-fatal */ }
        setUploading(false);
      }
      setDrawer(null);
      setEditMode(false);
      setAttachmentFile(null);
      setForm({ customer_id:'', invoice_date:new Date().toISOString().split('T')[0],
        due_date:'', notes:'', terms:'Net 30',
        accounts_receivable_id:'', revenue_account_id:'', tax_account_id:'',
        items:[emptyItem()] });
      load();
    } catch(e) {
      showToast((editMode ? 'Failed to update' : 'Failed to create') + ' invoice: ' + (e.response?.data?.error||e.message), 'error');
    } finally { setSubmitting(false); setUploading(false); }
  };

  const handleSendToCustomer = async (inv) => {
    setActionLoading(true);
    try {
      await api.patch(`/finance/invoices/${inv.id}/send`);
      showToast('Invoice marked as sent');
      setDrawer(null);
      load();
    } catch(e) { showToast(e.response?.data?.error || 'Failed to send invoice', 'error'); }
    finally { setActionLoading(false); }
  };

  const handleMarkPaid = async () => {
    if (!pendingMarkPaid) return;
    const inv = pendingMarkPaid;
    setPendingMarkPaid(null);
    setActionLoading(true);
    try {
      await api.patch(`/finance/invoices/${inv.id}/mark-paid`);
      showToast('Invoice marked as paid');
      setDrawer(null);
      load();
    } catch(e) { showToast(e.response?.data?.error || 'Failed to mark paid', 'error'); }
    finally { setActionLoading(false); }
  };

  const exportCSV = () => {
    const rows = [
      ['Invoice #', 'Customer', 'Invoice Date', 'Due Date', 'Amount', 'Status'],
      ...filtered.map(inv => [
        inv.invoice_number,
        inv.party_name || inv.customer_name || '',
        inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '',
        inv.due_date    ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })    : '',
        parseFloat(inv.total_amount || 0).toFixed(2),
        inv.status || '',
      ])
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `invoices-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
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
      <ConfirmDialog
        open={!!pendingMarkPaid}
        title="Mark Invoice as Paid"
        message={pendingMarkPaid ? `Mark invoice ${pendingMarkPaid.invoice_number} as fully paid (₹${fmtFull(pendingMarkPaid.balance ?? pendingMarkPaid.total_amount)})?` : ''}
        confirmLabel="Mark Paid"
        variant="warning"
        onConfirm={handleMarkPaid}
        onCancel={() => setPendingMarkPaid(null)}
      />

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
          <p className="inv-sub">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''} · {dateFrom && dateTo ? `${dateFrom} – ${dateTo}` : 'All time'}</p>
        </div>
        <div className="inv-header-r">
          <FYSelector />
          <button className="inv-btn-outline" onClick={exportCSV}><Download size={14}/> Export</button>
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

      {/* Quick date range filters */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8, alignItems:'center' }}>
        {_quickRanges().map(qr => {
          const active = qr.from === dateFrom && qr.to === dateTo;
          return (
            <button key={qr.label}
              onClick={() => { setDateFrom(qr.from); setDateTo(qr.to); }}
              style={{
                padding:'4px 12px', borderRadius:20, border:'1px solid',
                fontSize:12, fontWeight:500, cursor:'pointer',
                background: active ? '#6366f1' : '#f3f4f6',
                color:      active ? '#fff'    : '#374151',
                borderColor:active ? '#6366f1' : '#e5e7eb',
              }}>
              {qr.label}
            </button>
          );
        })}
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          style={{ padding:'4px 8px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:12, color:'#374151' }}/>
        <span style={{ fontSize:12, color:'#9ca3af' }}>to</span>
        <input type="date" value={dateTo}   onChange={e => setDateTo(e.target.value)}
          style={{ padding:'4px 8px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:12, color:'#374151' }}/>
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
                    <td>{inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td>
                      <span className={isOverdue?'inv-overdue-date':''}>
                        {inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
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
                        <button className="inv-action-btn" title="Send" onClick={() => handleSendToCustomer(inv)}>
                          <Send size={14}/>
                        </button>
                        <button className="inv-action-btn" title="Print" onClick={() => { setDrawer(inv); setTimeout(() => window.print(), 400); }}>
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
        <div className="inv-drawer-overlay" onClick={()=>{ setDrawer(null); setEditMode(false); }}>
          <div className="inv-drawer" onClick={e=>e.stopPropagation()}>

            <div className="inv-drawer-hd">
              <h3>{drawer==='create' ? 'New Invoice' : editMode ? `Edit ${drawer.invoice_number}` : `Invoice ${drawer.invoice_number}`}</h3>
              <button className="inv-drawer-close" onClick={()=>{ setDrawer(null); setEditMode(false); }}>
                <X size={18}/>
              </button>
            </div>

            <div className="inv-drawer-body">

              {/* ── VIEW MODE ────────────────────────────────────── */}
              {drawer !== 'create' && !editMode && (
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
                    <div className="inv-view-field"><span>Invoice Date</span><strong>{drawer.invoice_date ? new Date(drawer.invoice_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</strong></div>
                    <div className="inv-view-field"><span>Due Date</span><strong className={(drawer.status||'').toLowerCase()==='overdue'?'red':''}>{drawer.due_date ? new Date(drawer.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</strong></div>
                    <div className="inv-view-field"><span>Total Amount</span><strong>{fmtFull(drawer.total_amount)}</strong></div>
                    <div className="inv-view-field"><span>Balance Due</span><strong>{fmtFull(drawer.balance??drawer.total_amount)}</strong></div>
                  </div>
                  {drawer.attachment_url && (
                    <div style={{ margin: '12px 0', padding: '8px 12px', background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <Paperclip size={14} color="#16a34a" />
                      <a href={drawer.attachment_url} target="_blank" rel="noopener noreferrer" style={{ color: '#16a34a', fontWeight: 600 }}>View Attachment</a>
                    </div>
                  )}
                  <div className="inv-view-actions">
                    {['draft','pending'].includes((drawer.status||'').toLowerCase()) && (
                      <button className="inv-btn-outline" onClick={() => {
                        setForm({
                          customer_id: drawer.customer_id || drawer.party_id || '',
                          invoice_date: drawer.invoice_date?.split('T')[0] || new Date().toISOString().split('T')[0],
                          due_date: drawer.due_date?.split('T')[0] || '',
                          notes: drawer.notes || '',
                          terms: drawer.terms || 'Net 30',
                          accounts_receivable_id: drawer.accounts_receivable_id || '',
                          revenue_account_id: drawer.revenue_account_id || '',
                          tax_account_id: drawer.tax_account_id || '',
                          items: drawer.items?.length ? drawer.items : [emptyItem()],
                        });
                        setEditMode(true);
                      }}>
                        Edit Invoice
                      </button>
                    )}
                    <button className="inv-btn-primary" onClick={() => handleSendToCustomer(drawer)} disabled={actionLoading}>
                      <Send size={14}/> Send to Customer
                    </button>
                    <button className="inv-btn-outline" onClick={() => window.print()}>
                      <Printer size={14}/> Print / PDF
                    </button>
                    {(drawer.status||'').toLowerCase()!=='paid' && (
                      <button className="inv-btn-green" onClick={() => setPendingMarkPaid(drawer)} disabled={actionLoading}>
                        <CheckCircle size={14}/> Mark as Paid
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── CREATE / EDIT MODE ───────────────────────────── */}
              {(drawer === 'create' || editMode) && (
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

                  {/* Attachment */}
                  <div className="inv-field">
                    <label><Paperclip size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />Attachment (optional)</label>
                    <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx"
                      onChange={e => setAttachmentFile(e.target.files[0] || null)}
                      style={{ fontSize: 13, padding: '6px 0' }} />
                    {attachmentFile && (
                      <div style={{ marginTop: 4, fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Paperclip size={11} /> {attachmentFile.name}
                        <button type="button" onClick={() => { setAttachmentFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 0 }}>
                          <X size={11} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Submit */}
                  <div className="inv-form-footer">
                    <button className="inv-btn-outline" onClick={()=>{ setDrawer(editMode ? drawer : null); setEditMode(false); }}>Cancel</button>
                    <button className="inv-btn-outline" onClick={()=>handleSubmit('draft')} disabled={submitting||uploading}>Save as Draft</button>
                    <button className="inv-btn-primary" onClick={()=>handleSubmit('pending')} disabled={submitting||uploading}>
                      {uploading ? 'Uploading…' : submitting ? (editMode ? 'Saving…' : 'Creating…') : (editMode ? 'Update Invoice' : 'Create Invoice')}
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