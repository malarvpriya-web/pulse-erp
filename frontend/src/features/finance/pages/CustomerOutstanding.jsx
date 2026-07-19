import { useState, useEffect, useMemo } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';

const fmt = (n) =>
  `₹${(+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const BUCKET_STYLES = {
  current:  { bg: '#dcfce7', color: '#16a34a', label: 'Current' },
  '1-30':   { bg: '#fef9c3', color: '#a16207', label: '1–30 d' },
  '31-60':  { bg: '#fed7aa', color: '#c2410c', label: '31–60 d' },
  '61-90':  { bg: '#fecaca', color: '#dc2626', label: '61–90 d' },
  '90+':    { bg: '#f3e8ff', color: '#6B3FDB', label: '90+ d' },
};

function AgeingBadge({ bucket }) {
  const s = BUCKET_STYLES[bucket] ?? BUCKET_STYLES['current'];
  return (
    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

function getAgeingStyle(days) {
  const d = parseInt(days) || 0;
  if (d <= 0)  return { color: '#16a34a' };
  if (d <= 30) return { color: '#a16207' };
  if (d <= 60) return { color: '#c2410c' };
  return { color: '#dc2626', fontWeight: 600 };
}

const SUMMARY_CARDS = [
  { key: 'total',      label: 'Total Outstanding',  color: '#3b82f6', bg: '#eff6ff', bucket: 'all' },
  { key: 'current',    label: 'Current (Not Due)',   color: '#16a34a', bg: '#f0fdf4', bucket: 'current' },
  { key: 'days_1_30',  label: '1–30 Days',           color: '#a16207', bg: '#fefce8', bucket: '1-30' },
  { key: 'days_31_60', label: '31–60 Days',           color: '#c2410c', bg: '#fff7ed', bucket: '31-60' },
  { key: 'days_61_90', label: '61–90 Days',           color: '#dc2626', bg: '#fef2f2', bucket: '61-90' },
  { key: 'days_90plus',label: '90+ Days',             color: '#6B3FDB', bg: '#f5f3ff', bucket: '90+' },
];

const BUCKET_OPTIONS = [
  { value: 'all',    label: 'All Buckets' },
  { value: 'current',label: 'Current' },
  { value: '1-30',   label: '1–30 Days' },
  { value: '31-60',  label: '31–60 Days' },
  { value: '61-90',  label: '61–90 Days' },
  { value: '90+',    label: '90+ Days' },
];

const EMPTY_SUMMARY = { total: 0, current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90plus: 0 };

export default function CustomerOutstanding() {
  const today = new Date().toISOString().split('T')[0];

  const toast = useToast();
  const { availableFYs } = useFY();
  const [asOfDate,      setAsOfDate]      = useState(today);
  const [fyFilter,      setFyFilter]      = useState('all');
  const [allRows,       setAllRows]       = useState([]);
  const [summary,       setSummary]       = useState(EMPTY_SUMMARY);
  const [loading,       setLoading]       = useState(false);
  const [customerFilter,setCustomerFilter]= useState('');
  const [bucketFilter,  setBucketFilter]  = useState('all');
  const [view,          setView]          = useState('invoice');
  const [payModal,      setPayModal]      = useState(null);
  const [payForm,       setPayForm]       = useState({ amount: '', date: today, method: 'bank_transfer', reference: '' });
  const [paying,        setPaying]        = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const r = await api.get('/finance/customer-outstanding', { params: { as_of_date: asOfDate } });
      setAllRows(r.data?.rows ?? []);
      setSummary(r.data?.summary ?? EMPTY_SUMMARY);
    } catch {
      setAllRows([]);
      setSummary(EMPTY_SUMMARY);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fyRange = useMemo(
    () => availableFYs.find(f => f.fy === fyFilter) || null,
    [availableFYs, fyFilter],
  );

  const filteredRows = useMemo(() => {
    return allRows.filter(r => {
      if (customerFilter && !r.customer_name?.toLowerCase().includes(customerFilter.toLowerCase())) return false;
      if (bucketFilter !== 'all' && r.ageing_bucket !== bucketFilter) return false;
      if (fyRange) {
        const d = (r.invoice_date || '').slice(0, 10);
        if (!d || d < fyRange.startStr || d > fyRange.endStr) return false;
      }
      return true;
    });
  }, [allRows, customerFilter, bucketFilter, fyRange]);

  const totals = useMemo(() =>
    filteredRows.reduce((acc, r) => ({
      total_amount: acc.total_amount + (+r.total_amount || 0),
      paid_amount:  acc.paid_amount  + (+r.paid_amount  || 0),
      balance:      acc.balance      + (+r.balance      || 0),
    }), { total_amount: 0, paid_amount: 0, balance: 0 }),
  [filteredRows]);

  const customerSummary = useMemo(() => {
    const map = {};
    filteredRows.forEach(r => {
      const key = r.customer_name ?? 'Unknown';
      if (!map[key]) map[key] = { customer_name: key, invoice_count: 0, total: 0, current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90plus: 0 };
      const b = +r.balance || 0;
      const d = parseInt(r.ageing_days) || 0;
      map[key].invoice_count++;
      map[key].total += b;
      if      (d <= 0)  map[key].current     += b;
      else if (d <= 30) map[key].days_1_30   += b;
      else if (d <= 60) map[key].days_31_60  += b;
      else if (d <= 90) map[key].days_61_90  += b;
      else              map[key].days_90plus += b;
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [filteredRows]);

  const exportCSV = () => {
    const headers = ['Invoice Date','Invoice #','Customer','Total','Paid','Balance','Due Date','Ageing (Days)','Bucket'];
    const csvRows = filteredRows.map(r => [
      r.invoice_date, r.invoice_number, r.customer_name,
      r.total_amount, r.paid_amount, r.balance,
      r.due_date, r.ageing_days, r.ageing_bucket,
    ]);
    const csv = [headers, ...csvRows].map(row => row.map(v => `"${v ?? ''}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `AR_Ageing_${asOfDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openPayModal = (row) => {
    setPayForm({ amount: row.balance, date: today, method: 'bank_transfer', reference: '' });
    setPayModal(row);
  };

  const handlePay = async () => {
    if (!payModal || !payForm.amount) return;
    setPaying(true);
    try {
      await api.post('/finance/receipts', {
        receipt_date:     payForm.date,
        customer_id:      payModal.customer_id,
        amount:           +payForm.amount,
        payment_method:   payForm.method,
        reference_number: payForm.reference || null,
        allocations:      [{ invoice_id: payModal.id, allocated_amount: +payForm.amount }],
      });
      setPayModal(null);
      fetchData();
    } catch (e) {
      toast.error('Payment failed: ' + (e.response?.data?.error ?? e.message));
    } finally {
      setPaying(false);
    }
  };

  const th = (label, align = 'left') => (
    <th key={label} style={{ padding: '9px 14px', textAlign: align, fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12, background: '#f9fafb' }}>
      {label}
    </th>
  );

  const csumTotals = customerSummary.reduce((acc, c) => ({
    current:     acc.current     + c.current,
    days_1_30:   acc.days_1_30   + c.days_1_30,
    days_31_60:  acc.days_31_60  + c.days_31_60,
    days_61_90:  acc.days_61_90  + c.days_61_90,
    days_90plus: acc.days_90plus + c.days_90plus,
    total:       acc.total       + c.total,
  }), { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90plus: 0, total: 0 });

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>AR Ageing Report</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Accounts Receivable — Customer Outstanding</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>As of</span>
          <input
            type="date"
            value={asOfDate}
            onChange={e => setAsOfDate(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
          />
          <button
            onClick={fetchData}
            disabled={loading}
            style={{ padding: '7px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Summary Cards ──────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 16 }}>
        {SUMMARY_CARDS.map(c => (
          <div
            key={c.key}
            onClick={() => setBucketFilter(c.bucket)}
            style={{
              background: c.bg,
              border: `1.5px solid ${bucketFilter === c.bucket ? c.color : `${c.color}25`}`,
              borderRadius: 10,
              padding: '12px 14px',
              cursor: 'pointer',
              transition: 'border-color .15s',
            }}
          >
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500, marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: c.color }}>{fmt(summary[c.key] ?? 0)}</div>
          </div>
        ))}
      </div>

      {/* ── Filters + Actions ──────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderRadius: 10, padding: '12px 16px', marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,.06)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Filter by customer…"
          value={customerFilter}
          onChange={e => setCustomerFilter(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, minWidth: 200 }}
        />
        <select
          value={bucketFilter}
          onChange={e => setBucketFilter(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        >
          {BUCKET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={fyFilter}
          onChange={e => setFyFilter(e.target.value)}
          title="Filter by invoice Financial Year"
          style={{ padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        >
          <option value="all">All Financial Years</option>
          {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ background: '#f3f4f6', borderRadius: 6, display: 'flex', overflow: 'hidden' }}>
            {['invoice', 'customer'].map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{ padding: '6px 14px', border: 'none', background: view === v ? '#6366f1' : 'transparent', color: view === v ? '#fff' : '#374151', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}
              >
                {v === 'invoice' ? 'Invoice View' : 'Customer Summary'}
              </button>
            ))}
          </div>
          <button
            onClick={exportCSV}
            style={{ padding: '6px 14px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* ── Empty state ────────────────────────────────────────────────────── */}
      {!loading && allRows.length === 0 && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', color: '#dc2626', marginBottom: 14 }}>
          No outstanding invoices found for the selected date. Check company filter or invoice statuses.
        </div>
      )}

      {/* ── Invoice View ───────────────────────────────────────────────────── */}
      {view === 'invoice' && (
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,.06)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {th('Invoice Date')}
                  {th('Invoice #')}
                  {th('Customer')}
                  {th('Total', 'right')}
                  {th('Paid', 'right')}
                  {th('Balance', 'right')}
                  {th('Due Date')}
                  {th('Ageing')}
                  {th('Bucket')}
                  {th('Actions')}
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>
                      No data available
                    </td>
                  </tr>
                ) : filteredRows.map(r => {
                  const days = parseInt(r.ageing_days) || 0;
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '9px 14px', color: '#6b7280' }}>{fmtDate(r.invoice_date)}</td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', color: '#6366f1', fontSize: 12 }}>
                        {r.invoice_number ?? '—'}
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 500 }}>{r.customer_name ?? 'Unknown'}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', color: '#374151' }}>{fmt(r.total_amount)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', color: '#16a34a' }}>{fmt(r.paid_amount)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#111827' }}>{fmt(r.balance)}</td>
                      <td style={{ padding: '9px 14px', color: days > 0 ? '#dc2626' : '#374151' }}>{fmtDate(r.due_date)}</td>
                      <td style={{ padding: '9px 14px', ...getAgeingStyle(days) }}>
                        {days > 0
                          ? `${days}d overdue`
                          : days === 0
                          ? 'Due today'
                          : `${Math.abs(days)}d left`}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <AgeingBadge bucket={r.ageing_bucket} />
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <button
                          onClick={() => openPayModal(r)}
                          style={{ padding: '3px 10px', background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
                        >
                          Pay
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {filteredRows.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
                    <td colSpan={3} style={{ padding: '10px 14px', fontSize: 13 }}>
                      TOTAL — {filteredRows.length} invoice{filteredRows.length !== 1 ? 's' : ''}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmt(totals.total_amount)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#16a34a' }}>{fmt(totals.paid_amount)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626' }}>{fmt(totals.balance)}</td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* ── Customer Summary View ──────────────────────────────────────────── */}
      {view === 'customer' && (
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,.06)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {th('Customer')}
                  {th('Invoices')}
                  {th('Current', 'right')}
                  {th('1–30 Days', 'right')}
                  {th('31–60 Days', 'right')}
                  {th('61–90 Days', 'right')}
                  {th('90+ Days', 'right')}
                  {th('Total', 'right')}
                </tr>
              </thead>
              <tbody>
                {customerSummary.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No data available</td>
                  </tr>
                ) : customerSummary.map(c => (
                  <tr key={c.customer_name} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '9px 14px', fontWeight: 500 }}>{c.customer_name}</td>
                    <td style={{ padding: '9px 14px', color: '#6b7280' }}>{c.invoice_count}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', color: '#16a34a' }}>{c.current > 0 ? fmt(c.current) : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', color: '#a16207' }}>{c.days_1_30 > 0 ? fmt(c.days_1_30) : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', color: '#c2410c' }}>{c.days_31_60 > 0 ? fmt(c.days_31_60) : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', color: '#dc2626' }}>{c.days_61_90 > 0 ? fmt(c.days_61_90) : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', color: '#6B3FDB', fontWeight: c.days_90plus > 0 ? 600 : 400 }}>{c.days_90plus > 0 ? fmt(c.days_90plus) : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700 }}>{fmt(c.total)}</td>
                  </tr>
                ))}
              </tbody>
              {customerSummary.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
                    <td colSpan={2} style={{ padding: '10px 14px' }}>
                      TOTAL — {customerSummary.length} customer{customerSummary.length !== 1 ? 's' : ''}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#16a34a' }}>{fmt(csumTotals.current)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#a16207' }}>{fmt(csumTotals.days_1_30)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#c2410c' }}>{fmt(csumTotals.days_31_60)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626' }}>{fmt(csumTotals.days_61_90)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6B3FDB' }}>{fmt(csumTotals.days_90plus)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626' }}>{fmt(csumTotals.total)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* ── Quick-Pay Modal ────────────────────────────────────────────────── */}
      {payModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget) setPayModal(null); }}
        >
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 420, boxShadow: '0 24px 64px rgba(0,0,0,.18)' }}>
            <h3 style={{ margin: '0 0 2px', fontSize: 16, fontWeight: 700 }}>Record Payment</h3>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#6b7280' }}>
              {payModal.invoice_number} — {payModal.customer_name}
            </p>

            {[
              {
                label: `Amount  (Balance: ${fmt(payModal.balance)})`,
                field: 'amount',
                type: 'number',
                placeholder: '',
              },
              {
                label: 'Payment Date',
                field: 'date',
                type: 'date',
                placeholder: '',
              },
            ].map(({ label, field, type, placeholder }) => (
              <div key={field} style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 4 }}>{label}</label>
                <input
                  type={type}
                  value={payForm[field]}
                  placeholder={placeholder}
                  onChange={e => setPayForm(f => ({ ...f, [field]: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
            ))}

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 4 }}>Payment Mode</label>
              <select
                value={payForm.method}
                onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }}
              >
                <option value="bank_transfer">Bank Transfer (NEFT / RTGS)</option>
                <option value="upi">UPI</option>
                <option value="cheque">Cheque</option>
                <option value="cash">Cash</option>
              </select>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 4 }}>Reference (UTR / Cheque No.)</label>
              <input
                type="text"
                value={payForm.reference}
                placeholder="Optional"
                onChange={e => setPayForm(f => ({ ...f, reference: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setPayModal(null)}
                style={{ flex: 1, padding: 9, border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 14, cursor: 'pointer', color: '#374151' }}
              >
                Cancel
              </button>
              <button
                onClick={handlePay}
                disabled={paying || !payForm.amount}
                style={{ flex: 2, padding: 9, border: 'none', borderRadius: 6, background: '#6366f1', color: '#fff', fontSize: 14, fontWeight: 600, cursor: paying || !payForm.amount ? 'not-allowed' : 'pointer', opacity: paying || !payForm.amount ? 0.6 : 1 }}
              >
                {paying ? 'Recording…' : 'Record Payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
