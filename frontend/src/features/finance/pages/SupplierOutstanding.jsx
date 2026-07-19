import { useState, useEffect, useCallback, Fragment } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';

const fmt = (v) => `₹${Number(v ?? 0).toLocaleString('en-IN')}`;
const dash = (v) => (Number(v ?? 0) > 0 ? fmt(v) : '—');
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const BUCKET_OPTIONS = [
  { value: 'all',         label: 'All Buckets' },
  { value: 'not_yet_due', label: 'Current (Not Due)' },
  { value: 'due_1_30',    label: '1–30 Days' },
  { value: 'due_31_60',   label: '31–60 Days' },
  { value: 'due_61_90',   label: '61–90 Days' },
  { value: 'due_90plus',  label: '90+ Days' },
];

const KPI_CARDS = [
  { key: 'balance',     label: 'Total Outstanding', color: '#6366f1', bg: '#eff6ff', bucket: 'all' },
  { key: 'not_yet_due', label: 'Current (Not Due)',  color: '#10b981', bg: '#f0fdf4', bucket: 'not_yet_due' },
  { key: 'due_1_30',    label: '1–30 Days',          color: '#f59e0b', bg: '#fefce8', bucket: 'due_1_30' },
  { key: 'due_31_60',   label: '31–60 Days',         color: '#f97316', bg: '#fff7ed', bucket: 'due_31_60' },
  { key: 'due_61_90',   label: '61–90 Days',         color: '#ef4444', bg: '#fef2f2', bucket: 'due_61_90' },
  { key: 'due_90plus',  label: '90+ Days',           color: '#7f1d1d', bg: '#fdf4ff', bucket: 'due_90plus' },
];

function exportCSV(rows, asOfDate) {
  const headers = ['Supplier Name', 'GSTIN', 'Current', '1-30d', '31-60d', '61-90d', '90+d', 'Total Outstanding'];
  const csvRows = [
    [`AP Ageing Report — As of ${asOfDate}`],
    headers,
    ...rows.map(r => [
      r.supplier_name,
      r.gstin || '',
      +r.not_yet_due || 0,
      +r.due_1_30    || 0,
      +r.due_31_60   || 0,
      +r.due_61_90   || 0,
      +r.due_90plus  || 0,
      +r.balance     || 0,
    ]),
  ];
  const csv = csvRows.map(row => row.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `AP_Ageing_${asOfDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const rowBg = (r) => {
  if (Number(r.due_90plus) > 0) return '#fff5f5';
  if (Number(r.due_61_90) > 0) return '#fffbeb';
  return 'transparent';
};

const TH = ({ children, align = 'left', color }) => (
  <th style={{
    padding: '10px 14px', textAlign: align, fontWeight: 600,
    color: color ?? '#374151', borderBottom: '1px solid #e5e7eb',
    whiteSpace: 'nowrap', background: '#f9fafb', fontSize: 12,
  }}>
    {children}
  </th>
);

export default function SupplierOutstanding() {
  const today = new Date().toISOString().split('T')[0];

  const toast = useToast();
  const { availableFYs } = useFY();
  const [date, setDate]                   = useState(today);
  const [fyAsOf, setFyAsOf]               = useState('');
  const [rows, setRows]                   = useState([]);
  const [summary, setSummary]             = useState(null);
  const [loading, setLoading]             = useState(false);
  const [suppliers, setSuppliers]         = useState([]);
  const [supplierFilter, setSupplierFilter] = useState('');
  const [bucketFilter, setBucketFilter]   = useState('all');
  const [expanded, setExpanded]           = useState({});
  const [drillRows, setDrillRows]         = useState({});
  const [drillLoading, setDrillLoading]   = useState({});
  const [payModal, setPayModal]           = useState(null);
  const [payForm, setPayForm]             = useState({ amount: '', date: today, method: 'bank_transfer', reference: '' });
  const [paying, setPaying]               = useState(false);

  useEffect(() => {
    api.get('/finance/parties', { params: { party_type: 'supplier' } })
      .then(r => setSuppliers(r.data ?? []))
      .catch(() => {});
  }, []);

  const fetchOutstanding = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/finance/supplier-outstanding', { params: { as_of_date: date } });
      setRows(r.data?.rows ?? []);
      setSummary(r.data?.summary ?? null);
    } catch {
      setRows([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { fetchOutstanding(); }, [fetchOutstanding]);

  const toggleExpand = async (supplierId) => {
    if (expanded[supplierId]) {
      setExpanded(e => ({ ...e, [supplierId]: false }));
      return;
    }
    setExpanded(e => ({ ...e, [supplierId]: true }));
    if (drillRows[supplierId]) return;
    setDrillLoading(l => ({ ...l, [supplierId]: true }));
    try {
      const r = await api.get('/finance/bills', { params: { supplier_id: supplierId } });
      const bills = (r.data ?? []).filter(
        b => !['Paid', 'paid', 'Cancelled', 'cancelled'].includes(b.status) && Number(b.balance) > 0
      );
      setDrillRows(d => ({ ...d, [supplierId]: bills }));
    } catch {
      setDrillRows(d => ({ ...d, [supplierId]: [] }));
    } finally {
      setDrillLoading(l => ({ ...l, [supplierId]: false }));
    }
  };

  const openPayModal = (row) => {
    setPayForm({ amount: row.balance, date: today, method: 'bank_transfer', reference: '' });
    setPayModal(row);
  };

  const handlePay = async () => {
    if (!payModal || !payForm.amount) return;
    setPaying(true);
    try {
      await api.post('/finance/payments', {
        payment_date:     payForm.date,
        supplier_id:      payModal.supplier_id,
        amount:           +payForm.amount,
        payment_method:   payForm.method,
        reference_number: payForm.reference || null,
      });
      setPayModal(null);
      setDrillRows(d => { const n = { ...d }; delete n[payModal.supplier_id]; return n; });
      fetchOutstanding();
    } catch (e) {
      toast.error('Payment failed: ' + (e.response?.data?.error ?? e.message));
    } finally {
      setPaying(false);
    }
  };

  const filtered = rows.filter(r => {
    const supplierMatch = !supplierFilter || String(r.supplier_id) === supplierFilter;
    const bucketMatch   = bucketFilter === 'all' || Number(r[bucketFilter] ?? 0) > 0;
    return supplierMatch && bucketMatch;
  });

  const totals = filtered.reduce(
    (acc, r) => ({
      not_yet_due: acc.not_yet_due + (+r.not_yet_due || 0),
      due_1_30:    acc.due_1_30    + (+r.due_1_30    || 0),
      due_31_60:   acc.due_31_60   + (+r.due_31_60   || 0),
      due_61_90:   acc.due_61_90   + (+r.due_61_90   || 0),
      due_90plus:  acc.due_90plus  + (+r.due_90plus  || 0),
      balance:     acc.balance     + (+r.balance     || 0),
    }),
    { not_yet_due: 0, due_1_30: 0, due_31_60: 0, due_61_90: 0, due_90plus: 0, balance: 0 }
  );

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>AP Ageing Report</h1>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
          Accounts Payable — Supplier Outstanding
          {summary ? ` · Total: ${fmt(summary.balance)} as of ${fmtDate(date)}` : ''}
        </p>
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 16 }}>
          {KPI_CARDS.map(c => (
            <div
              key={c.key}
              onClick={() => setBucketFilter(bucketFilter === c.bucket ? 'all' : c.bucket)}
              style={{
                background: c.bg,
                border: `1.5px solid ${bucketFilter === c.bucket ? c.color : `${c.color}30`}`,
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
      )}

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div style={{
        background: '#fff', borderRadius: 10, padding: '12px 16px', marginBottom: 14,
        boxShadow: '0 1px 3px rgba(0,0,0,.06)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end',
      }}>
        <div>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Financial Year</label>
          <select
            value={fyAsOf}
            onChange={e => {
              const v = e.target.value;
              setFyAsOf(v);
              const f = availableFYs.find(x => x.fy === v);
              if (f) setDate(f.endStr > today ? today : f.endStr);
            }}
            title="Snapshot as of the end of the selected Financial Year"
            style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: 170 }}
          >
            <option value="">Custom date</option>
            {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>As of Date</label>
          <input
            type="date"
            value={date}
            onChange={e => { setDate(e.target.value); setFyAsOf(''); }}
            style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: 170 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Supplier</label>
          <select
            value={supplierFilter}
            onChange={e => setSupplierFilter(e.target.value)}
            style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: 240 }}
          >
            <option value="">All Suppliers</option>
            {suppliers.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Ageing Bucket</label>
          <select
            value={bucketFilter}
            onChange={e => setBucketFilter(e.target.value)}
            style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: 200 }}
          >
            {BUCKET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button
          onClick={fetchOutstanding}
          disabled={loading}
          style={{
            padding: '7px 18px', background: '#6366f1', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Loading…' : 'Search'}
        </button>
        <button
          onClick={() => exportCSV(filtered, date)}
          disabled={filtered.length === 0}
          style={{
            padding: '7px 14px', background: '#fff', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13,
            cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
            opacity: filtered.length === 0 ? 0.5 : 1,
          }}
        >
          Export CSV
        </button>
        <button
          onClick={() => window.print()}
          style={{
            padding: '7px 14px', background: '#fff', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, cursor: 'pointer',
          }}
        >
          Export PDF
        </button>
      </div>

      {/* ── Empty state ────────────────────────────────────────────────────── */}
      {!loading && rows.length === 0 && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', color: '#dc2626', marginBottom: 14 }}>
          No outstanding supplier bills found for the selected date.
        </div>
      )}

      {/* ── Main Table ─────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,.06)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <TH> </TH>
                  <TH>Supplier</TH>
                  <TH>GSTIN</TH>
                  <TH align="right" color="#10b981">Current</TH>
                  <TH align="right" color="#f59e0b">1–30 Days</TH>
                  <TH align="right" color="#f97316">31–60 Days</TH>
                  <TH align="right" color="#ef4444">61–90 Days</TH>
                  <TH align="right" color="#7f1d1d">90+ Days</TH>
                  <TH align="right">Total</TH>
                  <TH align="center">Actions</TH>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>
                      No rows match the current filter.
                    </td>
                  </tr>
                ) : filtered.map(r => (
                  <Fragment key={r.supplier_id}>
                    <tr style={{ borderBottom: '1px solid #f3f4f6', background: rowBg(r) }}>
                      <td style={{ padding: '9px 14px', textAlign: 'center', width: 32 }}>
                        <button
                          onClick={() => toggleExpand(r.supplier_id)}
                          title={expanded[r.supplier_id] ? 'Collapse' : 'View Bills'}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#6b7280', padding: 0, lineHeight: 1 }}
                        >
                          {expanded[r.supplier_id] ? '▼' : '▶'}
                        </button>
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>{r.supplier_name ?? 'Unknown'}</td>
                      <td style={{ padding: '9px 14px', color: '#6b7280', fontSize: 11, fontFamily: 'monospace' }}>
                        {r.gstin || '—'}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', color: '#10b981' }}>
                        {dash(r.not_yet_due)}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', color: Number(r.due_1_30) > 0 ? '#f59e0b' : '#d1d5db' }}>
                        {dash(r.due_1_30)}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', color: Number(r.due_31_60) > 0 ? '#f97316' : '#d1d5db' }}>
                        {dash(r.due_31_60)}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', color: Number(r.due_61_90) > 0 ? '#ef4444' : '#d1d5db' }}>
                        {dash(r.due_61_90)}
                      </td>
                      <td style={{
                        padding: '9px 14px', textAlign: 'right',
                        color: Number(r.due_90plus) > 0 ? '#7f1d1d' : '#d1d5db',
                        fontWeight: Number(r.due_90plus) > 0 ? 700 : 400,
                      }}>
                        {dash(r.due_90plus)}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>
                        {fmt(r.balance)}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'center' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                          <button
                            onClick={() => toggleExpand(r.supplier_id)}
                            style={{
                              padding: '3px 10px', background: '#f0f9ff', color: '#0369a1',
                              border: '1px solid #bae6fd', borderRadius: 4, fontSize: 11,
                              cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
                            }}
                          >
                            View Bills
                          </button>
                          <button
                            onClick={() => openPayModal(r)}
                            style={{
                              padding: '3px 10px', background: '#f0fdf4', color: '#16a34a',
                              border: '1px solid #bbf7d0', borderRadius: 4, fontSize: 11,
                              cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
                            }}
                          >
                            Pay Now
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* ── Drill-down: individual bills ───────────────────── */}
                    {expanded[r.supplier_id] && (
                      <tr style={{ background: '#f8fafc' }}>
                        <td colSpan={10} style={{ padding: '0 0 0 46px', borderBottom: '1px solid #e5e7eb' }}>
                          {drillLoading[r.supplier_id] ? (
                            <div style={{ padding: '12px 0', color: '#6b7280', fontSize: 12 }}>Loading bills…</div>
                          ) : !(drillRows[r.supplier_id] ?? []).length ? (
                            <div style={{ padding: '12px 0', color: '#9ca3af', fontSize: 12 }}>No outstanding bills found.</div>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ color: '#6b7280' }}>
                                  {['Bill #', 'Bill Date', 'Due Date', 'Amount', 'Balance', 'Days Overdue', 'Status'].map(h => (
                                    <th key={h} style={{
                                      padding: '7px 14px', textAlign: ['Amount', 'Balance'].includes(h) ? 'right' : 'left',
                                      fontWeight: 600, borderBottom: '1px solid #e5e7eb',
                                    }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {(drillRows[r.supplier_id] ?? []).map(b => {
                                  const daysOverdue = b.due_date
                                    ? Math.floor((new Date(date) - new Date(b.due_date)) / 86400000)
                                    : 0;
                                  const dueColor = daysOverdue > 90 ? '#7f1d1d'
                                    : daysOverdue > 60 ? '#ef4444'
                                    : daysOverdue > 30 ? '#f97316'
                                    : daysOverdue > 0  ? '#f59e0b'
                                    : '#10b981';
                                  return (
                                    <tr key={b.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                      <td style={{ padding: '7px 14px', fontFamily: 'monospace', color: '#6366f1' }}>{b.bill_number ?? '—'}</td>
                                      <td style={{ padding: '7px 14px', color: '#6b7280' }}>{fmtDate(b.bill_date)}</td>
                                      <td style={{ padding: '7px 14px', color: daysOverdue > 0 ? '#dc2626' : '#374151' }}>{fmtDate(b.due_date)}</td>
                                      <td style={{ padding: '7px 14px', textAlign: 'right' }}>{fmt(b.total_amount)}</td>
                                      <td style={{ padding: '7px 14px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{fmt(b.balance)}</td>
                                      <td style={{ padding: '7px 14px', color: dueColor, fontWeight: daysOverdue > 60 ? 600 : 400 }}>
                                        {daysOverdue > 0
                                          ? `${daysOverdue}d overdue`
                                          : daysOverdue === 0
                                          ? 'Due today'
                                          : `${Math.abs(daysOverdue)}d left`}
                                      </td>
                                      <td style={{ padding: '7px 14px' }}>
                                        <span style={{
                                          padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                                          background: b.status?.toLowerCase() === 'partial' ? '#fef9c3' : '#fef2f2',
                                          color: b.status?.toLowerCase() === 'partial' ? '#a16207' : '#dc2626',
                                        }}>
                                          {b.status}
                                        </span>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
                    <td colSpan={3} style={{ padding: '10px 14px', fontSize: 13 }}>
                      Totals ({filtered.length} supplier{filtered.length !== 1 ? 's' : ''})
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#10b981' }}>{fmt(totals.not_yet_due)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#f59e0b' }}>{fmt(totals.due_1_30)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#f97316' }}>{fmt(totals.due_31_60)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#ef4444' }}>{fmt(totals.due_61_90)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#7f1d1d' }}>{fmt(totals.due_90plus)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626' }}>{fmt(totals.balance)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* ── Pay Now Modal ──────────────────────────────────────────────────── */}
      {payModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget) setPayModal(null); }}
        >
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 420, boxShadow: '0 24px 64px rgba(0,0,0,.18)' }}>
            <h3 style={{ margin: '0 0 2px', fontSize: 16, fontWeight: 700 }}>Record Payment</h3>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#6b7280' }}>
              {payModal.supplier_name} — Outstanding: {fmt(payModal.balance)}
            </p>

            {[
              { label: `Amount (Balance: ${fmt(payModal.balance)})`, field: 'amount', type: 'number' },
              { label: 'Payment Date', field: 'date', type: 'date' },
            ].map(({ label, field, type }) => (
              <div key={field} style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 4 }}>{label}</label>
                <input
                  type={type}
                  value={payForm[field]}
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
                style={{
                  flex: 2, padding: 9, border: 'none', borderRadius: 6, background: '#6366f1',
                  color: '#fff', fontSize: 14, fontWeight: 600,
                  cursor: paying || !payForm.amount ? 'not-allowed' : 'pointer',
                  opacity: paying || !payForm.amount ? 0.6 : 1,
                }}
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
