import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const REASON_LABELS = {
  purchase_return:   'Purchase Return',
  price_revision:    'Price Revision',
  short_supply:      'Short Supply',
  quality_rejection: 'Quality Rejection',
  other:             'Other',
};

const STATUS_COLORS = {
  draft:     ['#fef3c7', '#b45309'],
  issued:    ['#dcfce7', '#15803d'],
  cancelled: ['#fee2e2', '#dc2626'],
};

const fmt = v =>
  v != null && v !== ''
    ? `₹${parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    : '₹0.00';

const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

const today = () => new Date().toISOString().split('T')[0];

const emptyForm = () => ({
  party_name: '', party_gstin: '', reason: 'purchase_return',
  taxable_value: '', cgst: '', sgst: '', igst: '',
  total_amount: '', notes: '', debit_note_date: today(),
});

/* ── KPI card ─────────────────────────────────────────────────────────────── */
function KpiCard({ label, value, sub, color = '#6B3FDB' }) {
  return (
    <div style={{
      flex: '1 1 160px', minWidth: 140,
      background: '#fff', border: `1px solid ${BORDER}`,
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────────────────── */
export default function DebitNotes({ setPage }) {
  const [notes,       setNotes]       = useState([]);
  const [total,       setTotal]       = useState(0);
  const [kpis,        setKpis]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [showForm,    setShowForm]    = useState(false);
  const [submitting,  setSubmitting]  = useState(false);

  const [statusFilter,  setStatusFilter]  = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [fromDate,      setFromDate]      = useState('');
  const [toDate,        setToDate]        = useState('');

  const [form, setForm] = useState(emptyForm());
  const { availableFYs } = useFY();
  const fyValue = availableFYs.find(f => f.startStr === fromDate && f.endStr === toDate)?.fy || '';
  const toast = useToast();
  const abortRef = useRef(null);

  /* ── data loading ─────────────────────────────────────────────────────── */
  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const params = new URLSearchParams();
      if (statusFilter)   params.set('status',      statusFilter);
      if (supplierFilter) params.set('party_name',  supplierFilter);
      if (fromDate)       params.set('from',        fromDate);
      if (toDate)         params.set('to',          toDate);

      const qs = params.toString() ? `?${params}` : '';

      const [listRes, kpiRes] = await Promise.all([
        api.get(`/finance/debit-notes${qs}`,  { signal: controller.signal }),
        api.get('/finance/debit-notes/kpis',   { signal: controller.signal }),
      ]);

      setNotes(listRes.data.data ?? []);
      setTotal(listRes.data.total ?? 0);
      setKpis(kpiRes.data.data ?? null);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') {
        setError('Request timed out. Please try again.');
      } else {
        setError(err?.response?.data?.error ?? err?.message ?? 'Failed to load debit notes.');
      }
    } finally {
      setLoading(false);
      clearTimeout(timeout);
    }
  }, [statusFilter, supplierFilter, fromDate, toDate]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  /* ── create ───────────────────────────────────────────────────────────── */
  const submit = async () => {
    if (!form.party_name || !form.taxable_value) {
      toast.error('Supplier name and taxable value are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/finance/debit-notes', form);
      toast.success('Debit note created');
      setShowForm(false);
      setForm(emptyForm());
      load();
    } catch (err) {
      toast.error(err.response?.data?.error ?? 'Failed to create debit note');
    } finally {
      setSubmitting(false);
    }
  };

  const issue = async (id) => {
    try {
      await api.post(`/finance/debit-notes/${id}/issue`);
      toast.success('Debit note issued');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error ?? 'Failed to issue');
    }
  };

  const cancel = async (id) => {
    if (!confirm('Cancel this debit note?')) return;
    try {
      await api.post(`/finance/debit-notes/${id}/cancel`);
      toast.success('Debit note cancelled');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error ?? 'Failed to cancel');
    }
  };

  const resetFilters = () => {
    setStatusFilter('');
    setSupplierFilter('');
    setFromDate('');
    setToDate('');
  };

  /* ── render ───────────────────────────────────────────────────────────── */
  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontWeight: 800, fontSize: 22, color: '#1f2937', margin: 0 }}>Debit Notes</h2>
          <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
            Purchase returns and supplier corrections ({total} total)
          </p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          style={{ padding: '10px 20px', borderRadius: 8, background: PURPLE, color: '#fff', fontWeight: 700, fontSize: 14, border: 'none', cursor: 'pointer' }}
        >
          {showForm ? '✕ Close' : '+ New Debit Note'}
        </button>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <KpiCard label="Total Notes"   value={kpis ? parseInt(kpis.total_count)  : '—'} sub="excl. cancelled" />
        <KpiCard label="Issued"        value={kpis ? parseInt(kpis.issued_count) : '—'} sub={kpis ? fmt(kpis.issued_amount) : ''} color="#15803d" />
        <KpiCard label="Draft"         value={kpis ? parseInt(kpis.draft_count)  : '—'} sub="pending issue" color="#b45309" />
        <KpiCard label="Total Value"   value={kpis ? fmt(kpis.total_value)        : '—'} sub="issued + draft" color="#0369a1" />
      </div>

      {/* Create form */}
      {showForm && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, margin: '0 0 16px' }}>New Debit Note</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
            {[
              { key: 'party_name',      label: 'Supplier Name *',     ph: 'Vendor name' },
              { key: 'party_gstin',     label: 'GSTIN',               ph: '27AAPFU0939F1ZV' },
              { key: 'debit_note_date', label: 'Date',                type: 'date' },
              { key: 'taxable_value',   label: 'Taxable Value (₹) *', type: 'number', ph: '0.00' },
              { key: 'cgst',            label: 'CGST (₹)',            type: 'number', ph: '0.00' },
              { key: 'sgst',            label: 'SGST (₹)',            type: 'number', ph: '0.00' },
              { key: 'igst',            label: 'IGST (₹)',            type: 'number', ph: '0.00' },
              { key: 'total_amount',    label: 'Total Amount (₹)',    type: 'number', ph: '0.00' },
            ].map(f => (
              <div key={f.key}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{f.label}</label>
                <input
                  type={f.type || 'text'}
                  value={form[f.key]}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.ph}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13, boxSizing: 'border-box' }}
                />
              </div>
            ))}
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Reason *</label>
              <select
                value={form.reason}
                onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}
              >
                {Object.entries(REASON_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Internal Notes</label>
              <textarea
                value={form.notes}
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                rows={2}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              onClick={submit}
              disabled={submitting}
              style={{ padding: '9px 24px', borderRadius: 7, background: submitting ? '#d1d5db' : PURPLE, color: '#fff', fontWeight: 700, fontSize: 13, border: 'none', cursor: submitting ? 'not-allowed' : 'pointer' }}
            >
              {submitting ? 'Creating…' : 'Create Debit Note'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              style={{ padding: '9px 20px', borderRadius: 7, border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        {/* Status pills */}
        {['', 'draft', 'issued', 'cancelled'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${statusFilter === s ? PURPLE : BORDER}`,
              background: statusFilter === s ? LIGHT : '#fff',
              color: statusFilter === s ? PURPLE : '#6b7280',
            }}
          >
            {s ? s.charAt(0).toUpperCase() + s.slice(1) : 'All'}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: BORDER, margin: '0 4px' }} />

        {/* Supplier search */}
        <input
          type="text"
          placeholder="Search supplier…"
          value={supplierFilter}
          onChange={e => setSupplierFilter(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13, width: 160 }}
        />

        {/* Financial Year quick-pick */}
        <select
          value={fyValue}
          onChange={e => {
            const f = availableFYs.find(x => x.fy === e.target.value);
            if (f) { setFromDate(f.startStr); setToDate(f.endStr); }
            else   { setFromDate(''); setToDate(''); }
          }}
          title="Filter by Financial Year"
          style={{ padding: '6px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}
        >
          <option value="">All FY</option>
          {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
        </select>

        {/* Date range */}
        <input
          type="date"
          value={fromDate}
          onChange={e => setFromDate(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}
        />
        <span style={{ fontSize: 12, color: '#9ca3af' }}>to</span>
        <input
          type="date"
          value={toDate}
          onChange={e => setToDate(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}
        />

        {(statusFilter || supplierFilter || fromDate || toDate) && (
          <button
            onClick={resetFilters}
            style={{ padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`, background: '#fff', color: '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            ✕ Reset
          </button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div style={{ padding: '16px 20px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#dc2626', fontSize: 13, fontWeight: 600 }}>{error}</span>
          <button
            onClick={load}
            style={{ padding: '6px 16px', borderRadius: 7, background: '#dc2626', color: '#fff', fontWeight: 600, fontSize: 12, border: 'none', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: LIGHT }}>
              {['DN Number', 'Supplier', 'Date', 'Original Bill', 'Reason', 'Taxable', 'Tax', 'Total', 'Status', 'Actions'].map(h => (
                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, color: '#374151', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{ display: 'inline-block', width: 28, height: 28, border: `3px solid ${BORDER}`, borderTopColor: PURPLE, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </td>
              </tr>
            ) : !error && notes.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: 40, textAlign: 'center' }}>
                  {(statusFilter || supplierFilter || fromDate || toDate) ? (
                    <>
                      <p style={{ color: '#9ca3af', marginBottom: 8 }}>No debit notes match your filters.</p>
                      <button onClick={resetFilters} style={{ color: PURPLE, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>Clear Filters</button>
                    </>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 10 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>
                      <p style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>No debit notes yet</p>
                      <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 14 }}>Raise a debit note to record returns or corrections on supplier bills.</p>
                      <button onClick={() => setShowForm(true)} style={{ background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 500 }}>+ Create Debit Note</button>
                    </>
                  )}
                </td>
              </tr>
            ) : notes.map(dn => {
              const [bg, col] = STATUS_COLORS[dn.status] ?? ['#f3f4f6', '#6b7280'];
              const tax = parseFloat(dn.cgst || 0) + parseFloat(dn.sgst || 0) + parseFloat(dn.igst || 0);
              return (
                <tr key={dn.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: PURPLE, whiteSpace: 'nowrap' }}>{dn.debit_note_number}</td>
                  <td style={{ padding: '10px 12px' }}>{dn.party_name || '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(dn.debit_note_date)}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                    {dn.original_bill_number
                      ? <span style={{ color: PURPLE, fontWeight: 600 }}>{dn.original_bill_number}</span>
                      : <span style={{ color: '#d1d5db' }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{REASON_LABELS[dn.reason] ?? dn.reason}</td>
                  <td style={{ padding: '10px 12px' }}>{fmt(dn.taxable_value)}</td>
                  <td style={{ padding: '10px 12px' }}>{fmt(tax)}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 700 }}>{fmt(dn.total_amount)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: bg, color: col }}>
                      {dn.status}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {dn.status === 'draft' && (
                        <button
                          onClick={() => issue(dn.id)}
                          style={{ padding: '4px 10px', borderRadius: 6, background: '#dcfce7', color: '#15803d', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}
                        >
                          Issue
                        </button>
                      )}
                      {dn.status !== 'cancelled' && (
                        <button
                          onClick={() => cancel(dn.id)}
                          style={{ padding: '4px 10px', borderRadius: 6, background: '#fee2e2', color: '#dc2626', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
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
