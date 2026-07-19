import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const REASON_LABELS = {
  sales_return: 'Sales Return',
  price_revision: 'Price Revision',
  deficiency_of_service: 'Service Deficiency',
  post_sale_discount: 'Post-Sale Discount',
  other: 'Other',
};

const STATUS_COLORS = {
  draft:     ['#fef3c7', '#b45309'],
  issued:    ['#dcfce7', '#15803d'],
  cancelled: ['#fee2e2', '#dc2626'],
};

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
    setSubmitting(true);
    try {
      await api.post('/finance/credit-notes', form);
      toast.success('Credit note created');
      setShowForm(false);
      setForm({ party_name: '', party_gstin: '', reason: 'sales_return', taxable_value: '', cgst: '', sgst: '', igst: '', total_amount: '', notes: '', credit_note_date: new Date().toISOString().split('T')[0] });
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
    } catch { toast.error('Failed to issue'); }
  };

  const cancel = async (id) => {
    if (!confirm('Cancel this credit note?')) return;
    try {
      await api.post(`/finance/credit-notes/${id}/cancel`);
      toast.success('Credit note cancelled');
      await load();
    } catch { toast.error('Failed to cancel'); }
  };

  const fmt = v => v ? `₹${parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '₹0.00';
  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontWeight: 800, fontSize: 22, color: '#1f2937', margin: 0 }}>Credit Notes</h2>
          <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>CDNR — credit notes issued to customers ({total} total)</p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          style={{ padding: '10px 20px', borderRadius: 8, background: PURPLE, color: '#fff', fontWeight: 700, fontSize: 14, border: 'none', cursor: 'pointer' }}
        >{showForm ? '✕ Close' : '+ New Credit Note'}</button>
      </div>

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
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {cn.status === 'draft' && (
                        <button onClick={() => issue(cn.id)} style={{ padding: '4px 10px', borderRadius: 6, background: '#dcfce7', color: '#15803d', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}>Issue</button>
                      )}
                      {cn.status !== 'cancelled' && (
                        <button onClick={() => cancel(cn.id)} style={{ padding: '4px 10px', borderRadius: 6, background: '#fee2e2', color: '#dc2626', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}>Cancel</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
