import { useState, useEffect, useCallback, useMemo } from 'react';
import { ReceiptIndianRupee } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';
import { PageHero, PageShell } from '@/components/pulse-ui';

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

// Only Sales Return and Quantity Correction can give invoiced quantity back;
// every other reason credits price only (Phase 3H — the API and database
// enforce it). A Quantity Correction names the invoice lines it corrects.
const REASON_LABELS = {
  sales_return: 'Sales Return',
  quantity_correction: 'Quantity Correction (billed in error)',
  price_revision: 'Price Revision',
  deficiency_of_service: 'Service Deficiency',
  post_sale_discount: 'Post-Sale Discount',
  other: 'Other',
};

const STATUS_COLORS = {
  draft:     ['#ede9fe', '#6d28d9'],
  issued:    ['#dcfce7', '#15803d'],
  cancelled: ['#fee2e2', '#dc2626'],
};

/* The invoice lines a quantity correction corrects: pick the original
   invoice, then the quantity billed in error on each shipped-goods line. The
   credited quantity IS the quantity released to be invoiced again. */
function QuantityCorrectionLines({ invoiceId, onInvoice, qty, onQty }) {
  const [invoices, setInvoices] = useState([]);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/finance/invoices').then(r => {
      const list = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.invoices || []);
      setInvoices(list);
    }).catch(e => setError(e?.response?.data?.error || 'Could not load invoices'));
  }, []);
  useEffect(() => {
    if (!invoiceId) { setLines([]); return; }
    api.get(`/finance/invoices/${invoiceId}`).then(r => {
      setLines((r.data?.items || []).filter(l => l.pick_list_line_id != null));
    }).catch(e => setError(e?.response?.data?.error || 'Could not load the invoice'));
  }, [invoiceId]);
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Original invoice *</label>
      <select aria-label="Original invoice" value={invoiceId} onChange={e => onInvoice(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}>
        <option value="">Select the invoice that over-billed…</option>
        {invoices.map(i => <option key={i.id} value={i.id}>{i.invoice_number} — {i.party_name || i.customer_name || ''}</option>)}
      </select>
      {error && <div role="alert" style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{error}</div>}
      {invoiceId && !lines.length && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>This invoice has no shipped-goods lines, so there is no quantity to correct.</div>
      )}
      {lines.length > 0 && (
        <table style={{ width: '100%', fontSize: 12, marginTop: 10, borderCollapse: 'collapse' }}>
          <thead><tr style={{ color: '#6b7280', textAlign: 'left' }}><th>Line</th><th style={{ textAlign: 'right' }}>Billed</th><th>Billed in error</th></tr></thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id}>
                <td>{l.description || `Line ${l.id}`}</td>
                <td style={{ textAlign: 'right' }}>{Number(l.quantity)}</td>
                <td>
                  <input type="number" min={0} max={Number(l.quantity)} step="any" aria-label={`Quantity to correct, line ${l.id}`}
                    value={qty[l.id] ?? ''} onChange={e => onQty({ ...qty, [l.id]: e.target.value })}
                    style={{ width: 100, padding: '6px 8px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }} />
                </td>
              </tr>))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function CreditNotes({ setPage }) {
  const [notes, setNotes] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const { availableFYs, selectedFY } = useFY();
  const [fyFilter, setFyFilter] = useState(selectedFY);
  const [form, setForm] = useState({
    party_name: '', party_gstin: '', reason: 'sales_return',
    taxable_value: '', cgst: '', sgst: '', igst: '',
    total_amount: '', notes: '', credit_note_date: new Date().toISOString().split('T')[0],
  });
  const [submitting, setSubmitting] = useState(false);
  const [qcInvoice, setQcInvoice] = useState('');
  const [qcQty, setQcQty] = useState({});
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : '';
      const r = await api.get(`/finance/credit-notes${params}`);
      setNotes(r.data.data || []);
      setTotal(r.data.total || 0);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const visibleNotes = useMemo(() => {
    const f = availableFYs.find(x => x.fy === fyFilter);
    if (!f) return notes;
    return notes.filter(cn => {
      const d = (cn.credit_note_date || '').slice(0, 10);
      return d && d >= f.startStr && d <= f.endStr;
    });
  }, [notes, availableFYs, fyFilter]);

  const submit = async () => {
    if (!form.party_name || !form.taxable_value) {
      toast.error('Party name and taxable value are required'); return;
    }
    let body = form;
    if (form.reason === 'quantity_correction') {
      const entries = Object.entries(qcQty).filter(([, v]) => v !== '' && Number(v) > 0);
      if (!qcInvoice || !entries.length) {
        toast.error('Choose the original invoice and the quantity billed in error on at least one line'); return;
      }
      body = { ...form, original_invoice_id: Number(qcInvoice),
               items: entries.map(([id, v]) => ({ original_item_id: Number(id), quantity: Number(v), released_qty: Number(v) })) };
    }
    setSubmitting(true);
    try {
      await api.post('/finance/credit-notes', body);
      toast.success('Credit note created');
      setShowForm(false);
      setForm({ party_name: '', party_gstin: '', reason: 'sales_return', taxable_value: '', cgst: '', sgst: '', igst: '', total_amount: '', notes: '', credit_note_date: new Date().toISOString().split('T')[0] });
      setQcInvoice(''); setQcQty({});
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create');
    } finally { setSubmitting(false); }
  };

  const issue = async (id) => {
    try {
      await api.post(`/finance/credit-notes/${id}/issue`);
      toast.success('Credit note issued');
      await load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to issue'); }
  };

  // A draft cancels outright. An issued note not yet filed in GSTR-1 cancels
  // with a reason: the server posts a journal reversing its own and takes back
  // any quantity it released (refused if that quantity was invoiced again).
  const cancel = async (cn) => {
    let reason = '';
    if (cn.status === 'issued') {
      reason = (window.prompt(`Cancel issued credit note ${cn.credit_note_number}? Its journal will be reversed. Reason:`) || '').trim();
      if (!reason) return;
    } else if (!confirm('Cancel this credit note?')) return;
    try {
      await api.post(`/finance/credit-notes/${cn.id}/cancel`, reason ? { reason } : {});
      toast.success(cn.status === 'issued' ? 'Credit note cancelled and its journal reversed' : 'Credit note cancelled');
      await load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to cancel'); }
  };

  // Recording the GSTR-1 filing is one-way: a filed note can no longer be cancelled here.
  const markFiled = async (cn) => {
    if (!confirm(`Mark ${cn.credit_note_number} as filed in GSTR-1? It can no longer be cancelled afterwards.`)) return;
    try {
      await api.post(`/finance/credit-notes/${cn.id}/mark-gstr1-filed`);
      toast.success('Marked as filed in GSTR-1');
      await load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to mark as filed'); }
  };

  const fmt = v => v ? `₹${parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '₹0.00';
  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

  return (
    <PageShell dock={
      <PageHero
        icon={ReceiptIndianRupee}
        eyebrow="Finance"
        title="Credit Notes"
        actions={<button className="plh-cta"
          onClick={() => setShowForm(v => !v)}>{showForm ? '✕ Close' : '+ New Credit Note'}</button>}
      />
    }>

      {/* Create form */}
      {showForm && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, margin: '0 0 16px' }}>New Credit Note</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
            {[
              { key: 'party_name', label: 'Party Name *', ph: 'Customer name' },
              { key: 'party_gstin', label: 'GSTIN', ph: '27AAPFU0939F1ZV' },
              { key: 'credit_note_date', label: 'Date', type: 'date' },
              { key: 'taxable_value', label: 'Taxable Value (₹) *', type: 'number', ph: '0.00' },
              { key: 'cgst', label: 'CGST (₹)', type: 'number', ph: '0.00' },
              { key: 'sgst', label: 'SGST (₹)', type: 'number', ph: '0.00' },
              { key: 'igst', label: 'IGST (₹)', type: 'number', ph: '0.00' },
              { key: 'total_amount', label: 'Total Amount (₹)', type: 'number', ph: '0.00' },
            ].map(f => (
              <div key={f.key}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{f.label}</label>
                <input type={f.type || 'text'} value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.ph}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            ))}
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Reason *</label>
              <select value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}>
                {Object.entries(REASON_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {form.reason === 'quantity_correction' && (
              <QuantityCorrectionLines invoiceId={qcInvoice} onInvoice={(v) => { setQcInvoice(v); setQcQty({}); }}
                                       qty={qcQty} onQty={setQcQty} />
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Internal Notes</label>
              <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button onClick={submit} disabled={submitting}
              style={{ padding: '9px 24px', borderRadius: 7, background: submitting ? '#d1d5db' : PURPLE, color: '#fff', fontWeight: 700, fontSize: 13, border: 'none', cursor: submitting ? 'not-allowed' : 'pointer' }}>
              {submitting ? 'Creating…' : 'Create Credit Note'}
            </button>
            <button onClick={() => setShowForm(false)}
              style={{ padding: '9px 20px', borderRadius: 7, border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {['', 'draft', 'issued', 'cancelled'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            style={{ padding: '6px 14px', borderRadius: 7, border: `1px solid ${statusFilter === s ? PURPLE : BORDER}`, background: statusFilter === s ? LIGHT : '#fff', color: statusFilter === s ? PURPLE : '#6b7280', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
            {s ? s.charAt(0).toUpperCase() + s.slice(1) : 'All'}
          </button>
        ))}
        <select value={fyFilter} onChange={e => setFyFilter(e.target.value)}
          title="Filter by credit note Financial Year"
          style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
          <option value="all">All Financial Years</option>
          {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
        </select>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: LIGHT }}>
              {['CN Number', 'Party', 'Date', 'Reason', 'Taxable', 'Tax', 'Total', 'Status', 'Actions'].map(h => (
                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, color: '#374151', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading…</td></tr>
            ) : visibleNotes.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No credit notes found.</td></tr>
            ) : visibleNotes.map(cn => {
              const [bg, col] = STATUS_COLORS[cn.status] || ['#f3f4f6', '#6b7280'];
              return (
                <tr key={cn.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: PURPLE }}>{cn.credit_note_number}</td>
                  <td style={{ padding: '10px 12px' }}>{cn.party_name || '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{fmtDate(cn.credit_note_date)}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{REASON_LABELS[cn.reason] || cn.reason}</td>
                  <td style={{ padding: '10px 12px' }}>{fmt(cn.taxable_value)}</td>
                  <td style={{ padding: '10px 12px' }}>{fmt(parseFloat(cn.cgst || 0) + parseFloat(cn.sgst || 0) + parseFloat(cn.igst || 0))}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 700 }}>{fmt(cn.total_amount)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: bg, color: col }}>
                      {cn.status}
                    </span>
                    {cn.gstr1_filed && cn.status === 'issued' && (
                      <span style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: '#e0e7ff', color: '#3730a3' }}>
                        GSTR-1 filed
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {cn.status === 'draft' && (
                        <button onClick={() => issue(cn.id)} style={{ padding: '4px 10px', borderRadius: 6, background: '#dcfce7', color: '#15803d', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}>Issue</button>
                      )}
                      {/* A filed note is never cancelled here — that is a GSTR-1 amendment. */}
                      {cn.status === 'issued' && !cn.gstr1_filed && (
                        <button onClick={() => markFiled(cn)} style={{ padding: '4px 10px', borderRadius: 6, background: '#e0e7ff', color: '#3730a3', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}>Mark filed</button>
                      )}
                      {(cn.status === 'draft' || (cn.status === 'issued' && !cn.gstr1_filed)) && (
                        <button onClick={() => cancel(cn)} style={{ padding: '4px 10px', borderRadius: 6, background: '#fee2e2', color: '#dc2626', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}>Cancel</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PageShell>
  );
}
