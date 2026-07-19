import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Download, RefreshCw, BarChart3, List, FileText,
  TrendingUp, AlertCircle, Users, X,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmt, fmtFull, today } from '../financeUtils';

// ── helpers ───────────────────────────────────────────────────────────────────

function fyStart() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const STATUS_STYLES = {
  paid:      { background: '#dcfce7', color: '#16a34a' },
  overdue:   { background: '#fee2e2', color: '#dc2626' },
  approved:  { background: '#dbeafe', color: '#1d4ed8' },
  pending:   { background: '#fef3c7', color: '#92400e' },
  draft:     { background: '#f3f4f6', color: '#6b7280' },
  rejected:  { background: '#fee2e2', color: '#991b1b' },
  cancelled: { background: '#f3f4f6', color: '#9ca3af' },
};

function StatusBadge({ status }) {
  const m = (status || '').toLowerCase();
  const st = STATUS_STYLES[m] || STATUS_STYLES.draft;
  return (
    <span style={{
      ...st,
      padding: '2px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, textTransform: 'capitalize',
      display: 'inline-block', whiteSpace: 'nowrap',
    }}>
      {m || '—'}
    </span>
  );
}

function exportCSV(rows, dateFrom, dateTo) {
  const hdrs = ['Bill No', 'Bill Date', 'Supplier', 'GSTIN', 'Taxable Amt', 'GST', 'Total Amt', 'Status', 'Due Date'];
  const body = rows.map(r => [
    r.bill_number   || '',
    fmtDate(r.bill_date),
    r.supplier_name || '',
    r.supplier_gstin || '',
    (+r.taxable_amount || 0).toFixed(2),
    (+r.gst_amount    || 0).toFixed(2),
    (+r.total_amount  || 0).toFixed(2),
    r.display_status || r.status || '',
    fmtDate(r.due_date),
  ]);
  const csv = [hdrs, ...body]
    .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `purchase_report_${dateFrom || 'all'}_to_${dateTo || 'all'}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

function buildSupplierSummary(rows) {
  const map = {};
  rows.forEach(r => {
    const key = r.supplier_name || 'Unknown';
    if (!map[key]) map[key] = { supplier: key, bills: 0, total: 0, gst: 0, outstanding: 0, last_bill: null };
    const s = map[key];
    s.bills++;
    s.total += +r.total_amount || 0;
    s.gst   += +r.gst_amount   || 0;
    if ((r.display_status || r.status || '').toLowerCase() !== 'paid') {
      s.outstanding += +r.balance || +r.total_amount || 0;
    }
    if (r.bill_date && (!s.last_bill || r.bill_date > s.last_bill)) s.last_bill = r.bill_date;
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

// ── styles ────────────────────────────────────────────────────────────────────

const S = {
  root:       { padding: 24, minHeight: '100vh', background: '#f9fafb' },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 },
  title:      { fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 },
  subtitle:   { color: '#6b7280', fontSize: 13, marginTop: 3, marginBottom: 0 },
  hdrBtns:    { display: 'flex', gap: 8, flexWrap: 'wrap' },
  btnOutline: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151', fontWeight: 500 },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 7, background: '#6366f1', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  kpiGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 },
  kpiCard:    { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,.08)', display: 'flex', gap: 14, alignItems: 'center' },
  kpiIcon:    { width: 44, height: 44, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  kpiLabel:   { fontSize: 12, color: '#6b7280', fontWeight: 500, marginBottom: 2 },
  kpiValue:   { fontSize: 20, fontWeight: 700, color: '#111827', lineHeight: 1.2 },
  filterCard: { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,.08)', marginBottom: 20 },
  filterRow:  { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' },
  fieldLabel: { display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' },
  input:      { padding: '7px 10px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, color: '#374151', outline: 'none' },
  select:     { padding: '7px 10px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, color: '#374151', minWidth: 150, outline: 'none' },
  tableWrap:  { background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' },
  overflowX:  { overflowX: 'auto' },
  table:      { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:         { padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12, background: '#f9fafb' },
  thR:        { padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12, background: '#f9fafb' },
  td:         { padding: '9px 14px', borderBottom: '1px solid #f3f4f6' },
  tdR:        { padding: '9px 14px', textAlign: 'right', borderBottom: '1px solid #f3f4f6', fontVariantNumeric: 'tabular-nums' },
  footTd:     { padding: '10px 14px', fontWeight: 700, color: '#374151', borderTop: '2px solid #e5e7eb', background: '#f9fafb' },
  footTdR:    { padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#374151', borderTop: '2px solid #e5e7eb', background: '#f9fafb', fontVariantNumeric: 'tabular-nums' },
  empty:      { padding: 60, textAlign: 'center' },
  loading:    { padding: 60, textAlign: 'center', color: '#9ca3af', fontSize: 14 },
};

// ── component ─────────────────────────────────────────────────────────────────

export default function ReportPurchase() {
  const [rows,       setRows]       = useState([]);
  const [summary,    setSummary]    = useState(null);
  const [suppliers,  setSuppliers]  = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [dateFrom,   setDateFrom]   = useState(fyStart());
  const [dateTo,     setDateTo]     = useState(today());
  const [supplierId, setSupplierId] = useState('');
  const [status,     setStatus]     = useState('');
  const [view,       setView]       = useState('transaction');
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    try {
      const params = {};
      if (dateFrom)   params.date_from   = dateFrom;
      if (dateTo)     params.date_to     = dateTo;
      if (supplierId) params.supplier_id = supplierId;
      if (status)     params.status      = status;
      const r = await api.get('/finance/report-purchase', { params, signal: abortRef.current.signal });
      setRows(r.data?.rows || []);
      setSummary(r.data?.summary || null);
    } catch (e) {
      if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED') return;
      setRows([]); setSummary(null);
    } finally { setLoading(false); }
  }, [dateFrom, dateTo, supplierId, status]);

  useEffect(() => {
    api.get('/finance/parties', { params: { party_type: 'Supplier' } })
      .then(r => setSuppliers(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleReset = () => {
    setDateFrom(fyStart()); setDateTo(today());
    setSupplierId(''); setStatus('');
  };

  // totals
  const totals = {
    taxable: rows.reduce((s, r) => s + (+r.taxable_amount || 0), 0),
    gst:     rows.reduce((s, r) => s + (+r.gst_amount    || 0), 0),
    total:   rows.reduce((s, r) => s + (+r.total_amount  || 0), 0),
  };

  const supplierRows = buildSupplierSummary(rows);
  const filtersApplied = !!(supplierId || status);

  const kpis = [
    {
      label: 'Total Bills', icon: FileText,
      value: summary?.total_bills != null ? +summary.total_bills : rows.length,
      format: 'count', color: '#6366f1', bg: '#ede9fe',
    },
    {
      label: 'Total Purchase Value', icon: TrendingUp,
      value: +(summary?.total_purchase_value ?? totals.total),
      format: 'money', color: '#0f766e', bg: '#ccfbf1',
    },
    {
      label: 'Total GST Paid', icon: TrendingUp,
      value: +(summary?.total_gst_paid ?? totals.gst),
      format: 'money', color: '#d97706', bg: '#fef3c7',
    },
    {
      label: 'Overdue Amount', icon: AlertCircle,
      value: +(summary?.overdue_amount ?? 0),
      format: 'money', color: '#dc2626', bg: '#fee2e2',
    },
  ];

  return (
    <div style={S.root}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={S.header}>
        <div>
          <h1 style={S.title}>Purchase Report</h1>
          <p style={S.subtitle}>Supplier bills &amp; purchase analytics · {rows.length} records</p>
        </div>
        <div style={S.hdrBtns}>
          <button
            style={S.btnOutline}
            onClick={() => setView(v => v === 'transaction' ? 'supplier' : 'transaction')}>
            {view === 'transaction'
              ? <><BarChart3 size={14}/> Supplier View</>
              : <><List size={14}/> Transaction View</>}
          </button>
          <button
            style={{ ...S.btnOutline, opacity: rows.length === 0 ? 0.5 : 1, cursor: rows.length === 0 ? 'not-allowed' : 'pointer' }}
            onClick={() => rows.length > 0 && exportCSV(rows, dateFrom, dateTo)}
            disabled={rows.length === 0}>
            <Download size={14}/> Export CSV
          </button>
        </div>
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────── */}
      <div style={S.kpiGrid}>
        {kpis.map(k => (
          <div key={k.label} style={S.kpiCard}>
            <div style={{ ...S.kpiIcon, background: k.bg }}>
              <k.icon size={18} color={k.color}/>
            </div>
            <div>
              <div style={S.kpiLabel}>{k.label}</div>
              <div style={S.kpiValue}>
                {k.format === 'count' ? k.value : fmt(k.value)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Filters ────────────────────────────────────────────── */}
      <div style={S.filterCard}>
        <div style={S.filterRow}>
          <div>
            <label style={S.fieldLabel}>From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={S.input}/>
          </div>
          <div>
            <label style={S.fieldLabel}>To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={S.input}/>
          </div>
          <div>
            <label style={S.fieldLabel}>Supplier</label>
            <select value={supplierId} onChange={e => setSupplierId(e.target.value)} style={S.select}>
              <option value="">All Suppliers</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label style={S.fieldLabel}>Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...S.select, minWidth: 130 }}>
              <option value="">All Statuses</option>
              <option value="draft">Draft</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="paid">Paid</option>
              <option value="overdue">Overdue</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={S.btnPrimary} onClick={load}>
              <RefreshCw size={13}/> Apply
            </button>
            {filtersApplied && (
              <button style={S.btnOutline} onClick={handleReset}>
                <X size={13}/> Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Table / Empty State ─────────────────────────────────── */}
      <div style={S.tableWrap}>
        {loading ? (
          <div style={S.loading}>Loading purchase data…</div>

        ) : rows.length === 0 ? (
          <div style={S.empty}>
            <FileText size={48} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }}/>
            {filtersApplied ? (
              <>
                <p style={{ color: '#6b7280', fontWeight: 500, margin: '0 0 10px' }}>
                  No bills match the selected filters.
                </p>
                <button style={S.btnPrimary} onClick={handleReset}>
                  Clear Filters
                </button>
              </>
            ) : (
              <>
                <p style={{ color: '#6b7280', fontWeight: 500, margin: '0 0 4px' }}>
                  No purchase bills recorded yet.
                </p>
                <p style={{ color: '#9ca3af', fontSize: 13, margin: '0 0 0' }}>
                  Add supplier bills under <strong>Finance → Supplier Bills</strong> to start tracking purchases.
                </p>
              </>
            )}
          </div>

        ) : view === 'transaction' ? (
          /* ── Transaction View ──────────────────────────────── */
          <div style={S.overflowX}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>BILL NO.</th>
                  <th style={S.th}>BILL DATE</th>
                  <th style={S.th}>SUPPLIER</th>
                  <th style={S.thR}>TAXABLE AMT</th>
                  <th style={S.thR}>GST</th>
                  <th style={S.thR}>TOTAL AMT</th>
                  <th style={S.th}>STATUS</th>
                  <th style={S.th}>DUE DATE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const ds = (r.display_status || r.status || '').toLowerCase();
                  return (
                    <tr key={r.id || i}>
                      <td style={{ ...S.td, fontWeight: 500, color: '#1d4ed8', whiteSpace: 'nowrap' }}>
                        {r.bill_number || '—'}
                      </td>
                      <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtDate(r.bill_date)}</td>
                      <td style={S.td}>{r.supplier_name || '—'}</td>
                      <td style={S.tdR}>{fmtFull(r.taxable_amount)}</td>
                      <td style={S.tdR}>{fmtFull(r.gst_amount)}</td>
                      <td style={{ ...S.tdR, fontWeight: 600 }}>{fmtFull(r.total_amount)}</td>
                      <td style={S.td}><StatusBadge status={ds}/></td>
                      <td style={{ ...S.td, whiteSpace: 'nowrap', color: ds === 'overdue' ? '#dc2626' : '#374151' }}>
                        {fmtDate(r.due_date)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={S.footTd}>
                    Total ({rows.length} bill{rows.length !== 1 ? 's' : ''})
                  </td>
                  <td style={S.footTdR}>{fmtFull(totals.taxable)}</td>
                  <td style={S.footTdR}>{fmtFull(totals.gst)}</td>
                  <td style={S.footTdR}>{fmtFull(totals.total)}</td>
                  <td style={{ ...S.footTd, borderTop: '2px solid #e5e7eb' }} colSpan={2}/>
                </tr>
              </tfoot>
            </table>
          </div>

        ) : (
          /* ── Supplier Summary View ─────────────────────────── */
          <div style={S.overflowX}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Users size={14} color="#6b7280"/>
              <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>
                {supplierRows.length} supplier{supplierRows.length !== 1 ? 's' : ''} · spend analysis
              </span>
            </div>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>SUPPLIER</th>
                  <th style={S.thR}>TOTAL BILLS</th>
                  <th style={S.thR}>TOTAL VALUE</th>
                  <th style={S.thR}>TOTAL GST</th>
                  <th style={S.thR}>OUTSTANDING</th>
                  <th style={S.th}>LAST BILL DATE</th>
                </tr>
              </thead>
              <tbody>
                {supplierRows.map((s, i) => (
                  <tr key={i}>
                    <td style={{ ...S.td, fontWeight: 500 }}>{s.supplier}</td>
                    <td style={S.tdR}>{s.bills}</td>
                    <td style={S.tdR}>{fmtFull(s.total)}</td>
                    <td style={S.tdR}>{fmtFull(s.gst)}</td>
                    <td style={{ ...S.tdR, color: s.outstanding > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                      {fmtFull(s.outstanding)}
                    </td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtDate(s.last_bill)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={S.footTd}>
                    Total ({supplierRows.length} supplier{supplierRows.length !== 1 ? 's' : ''})
                  </td>
                  <td style={S.footTdR}>{rows.length}</td>
                  <td style={S.footTdR}>{fmtFull(totals.total)}</td>
                  <td style={S.footTdR}>{fmtFull(totals.gst)}</td>
                  <td style={S.footTdR}>{fmtFull(supplierRows.reduce((s, r) => s + r.outstanding, 0))}</td>
                  <td style={{ ...S.footTd, borderTop: '2px solid #e5e7eb' }}/>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
