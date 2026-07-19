import { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { ShieldCheck, Download, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { fmt } from './travelUtils';

/**
 * Travel Audit — reconciles travel spend against Finance rather than restating
 * the travel module's own numbers.
 *
 * Each tab is a disagreement between two ledgers (claims / journal entries /
 * travel cost transactions) or an advance that was never squared off. An empty
 * tab is the good outcome, so empty states say "reconciled" rather than
 * "no data" — the two mean very different things here.
 */

const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const th = { padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' };
const td = { padding:'10px 12px', color:'#374151', whiteSpace:'nowrap' };

const TABS = [
  { key:'unposted',            label:'Not posted to Finance',
    hint:'Paid to the employee but no journal entry exists — the books are understated by this much.' },
  { key:'gst_unverified',      label:'GST unverified',
    hint:'GST claimed but never verified. Not recoverable until someone checks the bill.' },
  { key:'unsettled_advances',  label:'Unsettled advances',
    hint:'Money released against a trip that was never squared off with a claim.' },
  { key:'unlinked_claims',     label:'Unlinked claims',
    hint:'Expense claims with no travel request behind them — spend nobody authorised as travel.' },
  { key:'missing_cost_ledger', label:'Missing cost ledger',
    hint:'Paid claims the travel cost ledger never recorded. Only claims carrying a project or customer get posted, so anything else silently skips it.' },
];

const COLUMNS = {
  unposted: [
    ['claim_number', 'Claim'], ['employee_name', 'Name'], ['status', 'Status'],
    ['payment_date', 'Paid on', 'date'], ['payment_ref', 'Paid Ref'], ['total_amount', 'Total', 'money'],
  ],
  gst_unverified: [
    ['claim_number', 'Claim'], ['employee_name', 'Name'], ['vendor_name', 'Vendor'],
    ['bill_number', 'Bill No'], ['status', 'Status'], ['gst_amount', 'GST', 'money'], ['total_amount', 'Total', 'money'],
  ],
  unsettled_advances: [
    ['id', 'ID'], ['employee_name', 'Name'], ['request_number', 'Ref'], ['purpose', 'Purpose'],
    ['status', 'Status'], ['payment_date', 'Paid on', 'date'], ['payment_ref', 'Adv Ref'],
    ['amount', 'Advance', 'money'], ['settled_amount', 'Settled', 'money'], ['outstanding', 'Outstanding', 'money'],
  ],
  unlinked_claims: [
    ['claim_number', 'Claim'], ['employee_name', 'Name'], ['category', 'Category'],
    ['expense_type', 'Type'], ['expense_date', 'Date', 'date'], ['status', 'Status'], ['total_amount', 'Total', 'money'],
  ],
  missing_cost_ledger: [
    ['claim_number', 'Claim'], ['employee_name', 'Name'], ['cost_type', 'Cost Type'],
    ['payment_date', 'Paid on', 'date'], ['total_amount', 'Total', 'money'],
  ],
};

const Kpi = ({ label, value, tone = 'default', sub }) => {
  const colors = {
    default: { color:'#1f2937', bg:'#fff' },
    good:    { color:'#065f46', bg:'#fff' },
    warn:    { color:'#92400e', bg:'#fff' },
    bad:     { color:'#991b1b', bg:'#fff' },
  }[tone];
  return (
    <div style={{ background:colors.bg, border:'1px solid #f0f0f4', borderRadius:12, padding:'14px 16px', flex:'1 1 170px', minWidth:170 }}>
      <div style={{ fontSize:12, color:'#6b7280', fontWeight:600, marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:700, color:colors.color }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'#9ca3af', marginTop:4 }}>{sub}</div>}
    </div>
  );
};

export default function TravelAudit() {
  const toast = useToast();
  const [data, setData]       = useState(null);
  const [years, setYears]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('unposted');
  const [draft,   setDraft]   = useState({ year:'All' });
  const [applied, setApplied] = useState({ year:'All' });

  const load = useCallback((filters) => {
    setLoading(true); setError(null);
    api.get('/travel-audit', { params: { year: filters.year === 'All' ? undefined : filters.year } })
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.status === 403
        ? 'You do not have access to the travel audit.'
        : 'Could not load the audit. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(applied);
    api.get('/travel-audit/years').then(r => setYears(Array.isArray(r.data) ? r.data : [])).catch(() => setYears([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoad = () => { setApplied(draft); load(draft); };

  const s    = data?.summary ?? {};
  const rows = data?.exceptions?.[tab] ?? [];
  const cols = COLUMNS[tab] ?? [];
  const countOf = (k) => data?.exceptions?.[k]?.length ?? 0;
  const totalExceptions = TABS.reduce((n, t) => n + countOf(t.key), 0);

  const render = (row, key, kind) => {
    const v = row[key];
    if (kind === 'date')  return fmtDate(v);
    if (kind === 'money') return fmt(v);
    return v ?? '—';
  };

  const exportExcel = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    let sheets = 0;
    for (const t of TABS) {
      const list = data.exceptions?.[t.key] ?? [];
      if (!list.length) continue;
      const cs = COLUMNS[t.key];
      const out = list.map(r => Object.fromEntries(cs.map(([k, label, kind]) => [
        label, kind === 'money' ? Number(r[k] || 0) : kind === 'date' ? fmtDate(r[k]) : (r[k] ?? ''),
      ])));
      // Excel caps sheet names at 31 chars.
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), t.label.slice(0, 31));
      sheets++;
    }
    if (!sheets) { toast.error('Nothing to export — everything reconciles'); return; }
    XLSX.writeFile(wb, `travel_audit_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div style={{ padding:24, background:'var(--color-bg-page)', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, gap:16, flexWrap:'wrap' }}>
        <div>
          <h1 style={{ display:'flex', alignItems:'center', gap:8, fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>
            <ShieldCheck size={20} color="#6B3FDB"/> Travel Audit
          </h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
            Travel spend reconciled against Finance — claims, journal entries and the travel cost ledger.
          </p>
        </div>
        <div style={{ display:'flex', gap:12, alignItems:'flex-end' }}>
          <div style={{ minWidth:130 }}>
            <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Year</label>
            <select value={draft.year} onChange={e => setDraft({ year:e.target.value })} style={inputStyle}>
              <option value="All">All years</option>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button onClick={handleLoad} disabled={loading}
            style={{ padding:'9px 22px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:loading?'wait':'pointer', fontSize:13, fontWeight:600, opacity:loading?.6:1 }}>
            {loading ? 'Loading…' : 'Load'}
          </button>
          <button onClick={exportExcel} disabled={!data}
            style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#fff', color:'#374151', border:'1px solid #e5e7eb', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            <Download size={14}/> Excel
          </button>
        </div>
      </div>

      {loading && <div style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>Loading…</div>}

      {!loading && error && (
        <div style={{ background:'#fee2e2', borderRadius:12, padding:24, color:'#991b1b', textAlign:'center' }}>{error}</div>
      )}

      {!loading && !error && data && (
        <>
          <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap' }}>
            <Kpi label="Total travel spend" value={fmt(s.total_spend)} sub={`${s.claim_count ?? 0} claims`} />
            <Kpi label="Posted to Finance" value={`${s.posted_count ?? 0} / ${s.claim_count ?? 0}`}
                 tone={(s.claim_count ?? 0) > 0 && s.posted_count === s.claim_count ? 'good' : 'warn'}
                 sub={s.unposted_amount ? `${fmt(s.unposted_amount)} unposted` : 'all posted'} />
            <Kpi label="GST recoverable" value={fmt(s.gst_recoverable)} tone="good"
                 sub={`of ${fmt(s.total_gst)} claimed`} />
            <Kpi label="GST at risk" value={fmt(s.gst_at_risk)} tone={s.gst_at_risk ? 'bad' : 'good'}
                 sub="unverified" />
            <Kpi label="Unsettled advances" value={fmt(s.unsettled_amount)} tone={s.unsettled_amount ? 'warn' : 'good'} />
            <Kpi label="Exceptions" value={totalExceptions} tone={totalExceptions ? 'bad' : 'good'}
                 sub={totalExceptions ? 'need attention' : 'fully reconciled'} />
          </div>

          <div style={{ display:'flex', gap:6, marginBottom:16, flexWrap:'wrap' }}>
            {TABS.map(t => {
              const n = countOf(t.key);
              const active = tab === t.key;
              return (
                <button key={t.key} onClick={() => setTab(t.key)}
                  style={{
                    display:'inline-flex', alignItems:'center', gap:6, padding:'8px 14px',
                    background: active ? '#6B3FDB' : '#fff',
                    color: active ? '#fff' : '#374151',
                    border: `1px solid ${active ? '#6B3FDB' : '#e5e7eb'}`,
                    borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600,
                  }}>
                  {t.label}
                  <span style={{
                    background: active ? 'rgba(255,255,255,.25)' : (n ? '#fee2e2' : '#f3f4f6'),
                    color: active ? '#fff' : (n ? '#991b1b' : '#6b7280'),
                    borderRadius:20, padding:'1px 7px', fontSize:11, fontWeight:700,
                  }}>{n}</span>
                </button>
              );
            })}
          </div>

          <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
            <div style={{ padding:'12px 14px', borderBottom:'1px solid #f0f0f4', fontSize:12, color:'#6b7280', display:'flex', alignItems:'center', gap:6 }}>
              <AlertTriangle size={13} color="#9ca3af"/> {TABS.find(t => t.key === tab)?.hint}
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ background:'#f9fafb' }}>{cols.map(([, label]) => <th key={label} style={th}>{label}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={cols.length} style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
                        <CheckCircle2 size={36} color="#a7f3d0" style={{ display:'block', margin:'0 auto 12px' }}/>
                        Nothing to reconcile here — this check passes.
                      </td>
                    </tr>
                  ) : rows.map((r, i) => (
                    <tr key={r.id ?? i} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                      {cols.map(([key, label, kind]) => (
                        <td key={label} style={{
                          ...td,
                          fontWeight: kind === 'money' ? 600 : 400,
                          color: key === 'outstanding' || key === 'gst_amount' ? '#92400e' : td.color,
                        }}>
                          {render(r, key, kind)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 0 && (
              <div style={{ padding:'12px 14px', borderTop:'1px solid #f0f0f4', fontSize:13, color:'#6b7280' }}>
                Showing 1 to {rows.length} of {rows.length} entries
                {rows.length >= 200 && <span style={{ color:'#92400e' }}> · capped at 200 — narrow the year filter to see the rest</span>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
