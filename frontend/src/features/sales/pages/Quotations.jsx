import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, X, Trash2, FileText, Download, ArrowRight } from 'lucide-react';
import api from '@/services/api/client';
import './Quotations.css';

const SAMPLE = [
  { id: 1, quotationNumber: 'QT-001', customerName: 'Infosys Ltd', quotationDate: '2026-03-10', validityDate: '2026-04-10', totalAmount: 285000, status: 'Sent' },
  { id: 2, quotationNumber: 'QT-002', customerName: 'Wipro Technologies', quotationDate: '2026-03-12', validityDate: '2026-04-12', totalAmount: 142000, status: 'Accepted' },
  { id: 3, quotationNumber: 'QT-003', customerName: 'TCS India', quotationDate: '2026-03-14', validityDate: '2026-04-14', totalAmount: 560000, status: 'Draft' },
  { id: 4, quotationNumber: 'QT-004', customerName: 'HCL Technologies', quotationDate: '2026-02-20', validityDate: '2026-03-20', totalAmount: 98000, status: 'Expired' },
  { id: 5, quotationNumber: 'QT-005', customerName: 'Mphasis Ltd', quotationDate: '2026-03-15', validityDate: '2026-04-15', totalAmount: 376000, status: 'Accepted' },
];

const SAMPLE_CUSTOMERS = [
  { id: 1, name: 'Infosys Ltd' }, { id: 2, name: 'Wipro Technologies' },
  { id: 3, name: 'TCS India' }, { id: 4, name: 'HCL Technologies' }, { id: 5, name: 'Mphasis Ltd' },
];

const TABS = ['All', 'Draft', 'Sent', 'Accepted', 'Expired'];
const STATUS_COLORS = { Draft: '#f3f4f6', Sent: '#dbeafe', Accepted: '#dcfce7', Expired: '#fef3c7', Rejected: '#fee2e2' };
const STATUS_TEXT   = { Draft: '#374151', Sent: '#1d4ed8', Accepted: '#15803d', Expired: '#92400e', Rejected: '#991b1b' };
const fmt = n => `₹${Number(n).toLocaleString('en-IN')}`;
const BLANK_LINE = { description: '', quantity: 1, unitPrice: '' };
const BLANK_FORM = { customerId: '', customerName: '', quotationDate: new Date().toISOString().split('T')[0], validityDate: '', discount: 0, taxRate: 18, notes: '' };

export default function Quotations({ setPage }) {
  const [quotations, setQuotations] = useState(SAMPLE);
  const [customers, setCustomers]   = useState(SAMPLE_CUSTOMERS);
  const [loading, setLoading]       = useState(false);
  const [fTab, setFTab]             = useState('All');
  const [search, setSearch]         = useState('');
  const [drawer, setDrawer]         = useState(null);
  const [form, setForm]             = useState(BLANK_FORM);
  const [lines, setLines]           = useState([{ ...BLANK_LINE }]);
  const [saving, setSaving]         = useState(false);
  const [toast, setToast]           = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    const [q, c] = await Promise.allSettled([
      api.get('/sales/quotations', { params: fTab !== 'All' ? { status: fTab } : {} }),
      api.get('/finance/parties', { params: { type: 'customer' } }),
    ]);
    if (q.status === 'fulfilled') {
      const raw = q.value.data?.data ?? q.value.data;
      setQuotations(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } else setQuotations(SAMPLE);
    if (c.status === 'fulfilled') {
      const raw = c.value.data?.data ?? c.value.data;
      if (Array.isArray(raw) && raw.length) setCustomers(raw);
    }
    setLoading(false);
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const filtered = quotations.filter(q =>
    (fTab === 'All' || q.status === fTab) &&
    (q.quotationNumber?.toLowerCase().includes(search.toLowerCase()) ||
     q.customerName?.toLowerCase().includes(search.toLowerCase()))
  );

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? quotations.length : quotations.filter(q => q.status === t).length
  }), {});

  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.quantity || 0) * parseFloat(l.unitPrice || 0)), 0);
  const discountAmt = (subtotal * (parseFloat(form.discount) || 0)) / 100;
  const taxAmt = ((subtotal - discountAmt) * (parseFloat(form.taxRate) || 0)) / 100;
  const total = subtotal - discountAmt + taxAmt;

  const addLine = () => setLines(prev => [...prev, { ...BLANK_LINE }]);
  const removeLine = i => setLines(prev => prev.filter((_, idx) => idx !== i));
  const updateLine = (i, key, val) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, [key]: val } : l));

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/sales/quotations', { ...form, items: lines, subtotal, discountAmount: discountAmt, taxAmount: taxAmt, totalAmount: total });
      showToast('Quotation created!');
      load();
    } catch {
      const cust = customers.find(c => c.id === parseInt(form.customerId));
      const nq = { id: Date.now(), quotationNumber: `QT-${String(quotations.length + 1).padStart(3, '0')}`, customerName: cust?.name || form.customerName || 'Customer', quotationDate: form.quotationDate, validityDate: form.validityDate, totalAmount: total, status: 'Draft' };
      setQuotations(prev => [nq, ...prev]);
      showToast('Quotation saved (offline)');
    }
    setDrawer(null); setForm(BLANK_FORM); setLines([{ ...BLANK_LINE }]); setSaving(false);
  };

  const downloadPDF = async (q) => {
    try {
      const res = await api.get(`/sales/quotations/${q.id}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a'); a.href = url;
      a.setAttribute('download', `${q.quotationNumber}.pdf`); document.body.appendChild(a); a.click(); a.remove();
    } catch { showToast('PDF download not available', 'error'); }
  };

  const convertToSO = async (q) => {
    try {
      await api.post(`/sales/quotations/${q.id}/convert`);
      showToast('Converted to Sales Order!');
      if (setPage) setPage('SalesOrders');
    } catch {
      showToast('Convert failed — check Sales Orders manually', 'error');
    }
  };

  return (
    <div className="qt-root">
      {toast && <div className={`qt-toast qt-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="qt-header">
        <div>
          <h1 className="qt-title">Quotations</h1>
          <p className="qt-sub">Create and manage sales quotations</p>
        </div>
        <button className="qt-btn-primary" onClick={() => { setForm(BLANK_FORM); setLines([{ ...BLANK_LINE }]); setDrawer('create'); }}>
          <Plus size={15} /> New Quotation
        </button>
      </div>

      <div className="qt-filters">
        <div className="qt-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search quotations…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="qt-tabs">
          {TABS.map(t => (
            <button key={t} className={`qt-tab ${fTab === t ? 'qt-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="qt-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="qt-loading"><div className="qt-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="qt-empty"><FileText size={32} color="#d1d5db" /><p>No quotations found</p></div>
      ) : (
        <div className="qt-table-wrap">
          <table className="qt-table">
            <thead>
              <tr><th>Quotation #</th><th>Customer</th><th>Date</th><th>Valid Until</th><th>Total Amount</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map(q => (
                <tr key={q.id} className="qt-row">
                  <td><span className="qt-num">{q.quotationNumber}</span></td>
                  <td>{q.customerName}</td>
                  <td>{new Date(q.quotationDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td>{new Date(q.validityDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td><span className="qt-amount">{fmt(q.totalAmount)}</span></td>
                  <td><span className="qt-badge" style={{ background: STATUS_COLORS[q.status], color: STATUS_TEXT[q.status] }}>{q.status}</span></td>
                  <td>
                    <div className="qt-row-actions">
                      <button className="qt-action-btn" onClick={() => downloadPDF(q)} title="Download PDF"><Download size={13} /></button>
                      {q.status === 'Accepted' && (
                        <button className="qt-convert-btn" onClick={() => convertToSO(q)} title="Convert to SO">
                          <ArrowRight size={13} /> to SO
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="qt-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="qt-drawer">
            <div className="qt-drawer-hd">
              <h3>New Quotation</h3>
              <button className="qt-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="qt-drawer-body" onSubmit={handleSubmit}>
              <div className="qt-row2">
                <div className="qt-field">
                  <label>Customer <span className="qt-req">*</span></label>
                  <select value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))} required>
                    <option value="">Select customer</option>
                    {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="qt-field">
                  <label>Quotation Date <span className="qt-req">*</span></label>
                  <input type="date" value={form.quotationDate} onChange={e => setForm(f => ({ ...f, quotationDate: e.target.value }))} required />
                </div>
              </div>
              <div className="qt-field">
                <label>Validity Date <span className="qt-req">*</span></label>
                <input type="date" value={form.validityDate} onChange={e => setForm(f => ({ ...f, validityDate: e.target.value }))} required />
              </div>

              {/* Line items */}
              <div className="qt-items-section">
                <div className="qt-items-hd">
                  <span>Line Items</span>
                  <button type="button" className="qt-add-line-btn" onClick={addLine}><Plus size={12} /> Add Line</button>
                </div>
                <div className="qt-items-header-row">
                  <span>Description</span><span>Qty</span><span>Unit Price (₹)</span><span>Total</span><span />
                </div>
                {lines.map((line, i) => (
                  <div key={i} className="qt-line-row">
                    <input placeholder="Item/service description" value={line.description} onChange={e => updateLine(i, 'description', e.target.value)} />
                    <input type="number" min="1" placeholder="1" value={line.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)} />
                    <input type="number" min="0" placeholder="0" value={line.unitPrice} onChange={e => updateLine(i, 'unitPrice', e.target.value)} />
                    <span className="qt-line-total">{fmt((parseFloat(line.quantity || 0) * parseFloat(line.unitPrice || 0)).toFixed(0))}</span>
                    {lines.length > 1 && <button type="button" className="qt-remove-btn" onClick={() => removeLine(i)}><Trash2 size={12} /></button>}
                  </div>
                ))}
              </div>

              <div className="qt-totals">
                <div className="qt-total-row"><span>Subtotal</span><span>{fmt(subtotal.toFixed(0))}</span></div>
                <div className="qt-total-row">
                  <span>Discount <input type="number" min="0" max="100" className="qt-pct-input" value={form.discount} onChange={e => setForm(f => ({ ...f, discount: e.target.value }))} />%</span>
                  <span className="qt-red">−{fmt(discountAmt.toFixed(0))}</span>
                </div>
                <div className="qt-total-row">
                  <span>GST <input type="number" min="0" max="100" className="qt-pct-input" value={form.taxRate} onChange={e => setForm(f => ({ ...f, taxRate: e.target.value }))} />%</span>
                  <span>+{fmt(taxAmt.toFixed(0))}</span>
                </div>
                <div className="qt-total-row qt-grand-total"><span>Grand Total</span><span>{fmt(total.toFixed(0))}</span></div>
              </div>

              <div className="qt-field">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Terms and conditions, notes…" />
              </div>

              <div className="qt-drawer-ft">
                <button type="button" className="qt-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="qt-btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create Quotation'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
