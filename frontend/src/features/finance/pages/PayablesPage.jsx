import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import NotesList from '@/components/finance/NotesList';
import SupplierBills from './SupplierBills';
import SupplierOutstanding from './SupplierOutstanding';
import ReportPurchase from './ReportPurchase';

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const TABS = [
  { id: 'bills',       label: 'Supplier Bills' },
  { id: 'outstanding', label: 'Supplier Outstanding' },
  { id: 'debit-notes', label: 'Debit Notes' },
  { id: 'purchase-report', label: 'Purchase Report' },
];

const REASON_LABELS = {
  purchase_return:   'Purchase Return',
  price_revision:    'Price Revision',
  short_supply:      'Short Supply',
  quality_rejection: 'Quality Rejection',
  other:             'Other',
};

const emptyForm = () => ({
  party_name: '', party_gstin: '', reason: 'purchase_return',
  taxable_value: '', cgst: '', sgst: '', igst: '',
  total_amount: '', notes: '',
  debit_note_date: new Date().toISOString().split('T')[0],
});

/* ── Debit Notes tab ──────────────────────────────────────────────────────── */
function DebitNotesTab() {
  const [notes,          setNotes]          = useState([]);
  const [total,          setTotal]          = useState(0);
  const [kpis,           setKpis]           = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  const [showForm,       setShowForm]       = useState(false);
  const [submitting,     setSubmitting]     = useState(false);
  const [statusFilter,   setStatusFilter]   = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [fromDate,       setFromDate]       = useState('');
  const [toDate,         setToDate]         = useState('');
  const [form,           setForm]           = useState(emptyForm());
  const abortRef = useRef(null);
  const toast = useToast();

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const params = new URLSearchParams();
      if (statusFilter)   params.set('status',     statusFilter);
      if (supplierFilter) params.set('party_name', supplierFilter);
      if (fromDate)       params.set('from',       fromDate);
      if (toDate)         params.set('to',         toDate);
      const qs = params.toString() ? `?${params}` : '';
      const [listRes, kpiRes] = await Promise.all([
        api.get(`/finance/debit-notes${qs}`,  { signal: controller.signal }),
        api.get('/finance/debit-notes/kpis',  { signal: controller.signal }),
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

  const handleIssue = async (id) => {
    try {
      await api.post(`/finance/debit-notes/${id}/issue`);
      toast.success('Debit note issued');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error ?? 'Failed to issue');
    }
  };

  const handleCancel = async (id) => {
    if (!confirm('Cancel this debit note?')) return;
    try {
      await api.post(`/finance/debit-notes/${id}/cancel`);
      toast.success('Debit note cancelled');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error ?? 'Failed to cancel');
    }
  };

  const handleSubmit = async () => {
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

  const resetFilters = () => {
    setStatusFilter('');
    setSupplierFilter('');
    setFromDate('');
    setToDate('');
  };

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>
          Purchase returns and supplier corrections ({total} total)
        </p>
        <button
          onClick={() => setShowForm(v => !v)}
          style={{ padding: '8px 18px', borderRadius: 8, background: PURPLE, color: '#fff', fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer' }}
        >
          {showForm ? '✕ Close' : '+ New Debit Note'}
        </button>
      </div>

      {/* Inline create form */}
      {showForm && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, margin: '0 0 14px' }}>New Debit Note</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
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
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{ padding: '9px 22px', borderRadius: 7, background: submitting ? '#d1d5db' : PURPLE, color: '#fff', fontWeight: 700, fontSize: 13, border: 'none', cursor: submitting ? 'not-allowed' : 'pointer' }}
            >
              {submitting ? 'Creating…' : 'Create Debit Note'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              style={{ padding: '9px 18px', borderRadius: 7, border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Shared table + KPIs + filters */}
      <NotesList
        type="debit"
        side="AP"
        data={notes}
        total={total}
        kpis={kpis}
        loading={loading}
        error={error}
        onRetry={load}
        statusFilter={statusFilter}
        onStatus={setStatusFilter}
        supplierFilter={supplierFilter}
        onSupplier={setSupplierFilter}
        fromDate={fromDate}
        onFrom={setFromDate}
        toDate={toDate}
        onTo={setToDate}
        onResetFilters={resetFilters}
        onIssue={handleIssue}
        onCancel={handleCancel}
      />
    </div>
  );
}

/* ── PayablesPage ─────────────────────────────────────────────────────────── */
export default function PayablesPage({ setPage, initialTab }) {
  const [activeTab, setActiveTab] = useState(initialTab ?? 'bills');

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontWeight: 800, fontSize: 22, color: '#1f2937', margin: 0 }}>Payables</h2>
        <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          Supplier bills, outstanding balances, debit notes and purchase reporting
        </p>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 2, borderBottom: `2px solid ${BORDER}`,
        marginBottom: 24, overflowX: 'auto',
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 20px', fontWeight: 700, fontSize: 13,
              border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
              background: 'none', borderRadius: '6px 6px 0 0',
              color: activeTab === tab.id ? PURPLE : '#6b7280',
              borderBottom: activeTab === tab.id ? `2px solid ${PURPLE}` : '2px solid transparent',
              marginBottom: -2,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'bills'           && <SupplierBills />}
      {activeTab === 'outstanding'     && <SupplierOutstanding />}
      {activeTab === 'debit-notes'     && <DebitNotesTab />}
      {activeTab === 'purchase-report' && <ReportPurchase />}
    </div>
  );
}
