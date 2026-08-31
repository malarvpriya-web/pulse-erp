import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  BarChart2, Users, FileText, ShoppingCart, Package, IndianRupee,
  Clock, TrendingUp, Download, Play, Calendar, ChevronRight,
  ChevronLeft, RefreshCw, Search, Filter, AlertCircle, ShieldOff,
  Inbox, Bookmark, BookmarkCheck, Info, BarChart3,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import './Reports.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

/**
 * Report Builder.
 *
 * The catalog is fetched from `GET /reports/catalog` rather than hardcoded here.
 * It used to be a local array, and it drifted from what the backend actually
 * honoured: the Department input rendered on all 21 reports while 5 applied it,
 * and Project Cost advertised a date picker for a route that ignored dates
 * entirely. Users filtered, saw the number change nowhere, and trusted it.
 * Server-owned descriptors make that class of lie impossible — the page can only
 * render a control the report declares, and the API rejects anything else.
 */

const CATEGORY_STYLE = {
  'HR & People':           { icon: Users,         color: '#6366f1', bg: '#eef2ff' },
  'Payroll':               { icon: Clock,         color: '#db2777', bg: '#fdf2f8' },
  'Sales & Revenue':       { icon: TrendingUp,    color: '#10b981', bg: '#f0fdf4' },
  'Finance & Accounting':  { icon: IndianRupee,   color: '#7c5cf0', bg: '#f5f3ff' },
  'Procurement':           { icon: ShoppingCart,  color: '#6B3FDB', bg: '#f5f3ff' },
  'Inventory & Stock':     { icon: Package,       color: '#0ea5e9', bg: '#f0f9ff' },
};
const FALLBACK_STYLE = { icon: FileText, color: '#6B3FDB', bg: '#f5f3ff' };
const styleFor = c => CATEGORY_STYLE[c] || FALLBACK_STYLE;

const FILTER_LABEL = {
  start_date: 'From', end_date: 'To', department: 'Department',
  year: 'Year', month: 'Month', status: 'Status', employee_id: 'Employee ID',
};
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

/* ── value formatting ─────────────────────────────────────────────────────── */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONEY_HINT = /(amount|value|spend|revenue|salary|cost|rate|liability|gross|net|tds|deduction|budget|variance)/i;
const PCT_HINT = /(_pct|percentage)$/i;

function formatCell(col, value, isMeasure) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const s = String(value);
  if (MONTH_KEY.test(s)) return `${SHORT_MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
  if (ISO_DATE.test(s)) return fmtDate(s);
  if (isMeasure && !Number.isNaN(Number(s))) {
    const n = Number(s);
    if (PCT_HINT.test(col)) return `${n.toFixed(1)}%`;
    if (MONEY_HINT.test(col)) return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  return s;
}

const headerFor = c => c.replace(/_/g, ' ').replace(/\bpct\b/i, '%').replace(/\b\w/g, l => l.toUpperCase());

/* ── CSV export ───────────────────────────────────────────────────────────── */
/**
 * Values beginning =, +, - or @ are executed as formulas by Excel and Sheets
 * even inside quotes, so a crafted remark or item name in a report becomes code
 * on the reader's machine. Prefixing a tab neutralises it while displaying the
 * original text. The UTF-8 BOM keeps ₹ and non-ASCII names from mojibaking.
 */
function csvCell(v) {
  if (v === null || v === undefined) return '""';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = '\t' + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCSV(rows, filename) {
  if (!rows?.length) return;
  const cols = Object.keys(rows[0]);
  const body = rows.map(r => cols.map(c => csvCell(r[c])).join(','));
  const csv = '﻿' + [cols.map(csvCell).join(','), ...body].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Turn an axios failure into something the user can act on, and — critically —
 * never into an empty result. This module used to answer 200 with `[]` for any
 * database error, and the page rendered that as a green tick reading "No records
 * found", so eleven permanently-broken reports read as "the business has no
 * data in this area". Empty, Error and Forbidden are now three distinct states.
 */
function describeError(e) {
  const status = e?.response?.status;
  const data = e?.response?.data || {};
  if (status === 403) {
    return {
      kind: 'forbidden',
      title: data.code === 'SCOPE_UNRESOLVED' ? 'Your account has no company assigned' : 'You do not have access to this report',
      detail: data.error || 'Ask an administrator if you need this report.',
    };
  }
  if (status === 400) return { kind: 'filter', title: 'Check the filters', detail: data.error || 'One of the filters is not valid.' };
  if (status === 404) return { kind: 'error', title: 'Report not found', detail: data.error || 'This report is no longer available.' };
  if (status >= 500) return { kind: 'error', title: 'The report could not be generated', detail: data.error || 'The failure has been logged. Please report it if it persists.' };
  if (e?.code === 'ECONNABORTED') return { kind: 'error', title: 'The report timed out', detail: 'Try a narrower date range.' };
  return { kind: 'error', title: 'Could not reach the server', detail: e?.message || 'Check your connection and try again.' };
}

const PAGE_SIZE = 200;
const EXPORT_LIMIT = 5000;

export default function Reports() {
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [filters, setFilters] = useState({});
  const [result, setResult] = useState(null);      // {rows,total,limit,offset,measures}
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle|saving|saved|error

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  useEffect(() => {
    api.get('/reports/catalog')
      .then(r => { if (isMounted.current) setCatalog(r.data?.reports || []); })
      .catch(e => { if (isMounted.current) setCatalogError(describeError(e)); });
  }, []);

  const allReports = catalog || [];
  const categories = useMemo(() => {
    const seen = [];
    for (const r of allReports) if (!seen.includes(r.category)) seen.push(r.category);
    return seen;
  }, [allReports]);

  const matches = search.trim()
    ? allReports.filter(r =>
        `${r.label} ${r.desc} ${r.category}`.toLowerCase().includes(search.toLowerCase()))
    : null;

  /** Defaults are only ever set for filters the chosen report actually declares. */
  const selectReport = useCallback(r => {
    const f = {};
    if (r.filters.includes('start_date')) f.start_date = monthStart();
    if (r.filters.includes('end_date')) f.end_date = today();
    if (r.filters.includes('year')) f.year = String(new Date().getFullYear());
    setSelected(r); setFilters(f); setResult(null); setError(null); setSaveState('idle');
  }, []);

  const fetchPage = useCallback(async (offset = 0, limit = PAGE_SIZE) => {
    const params = { ...filters, limit, offset };
    for (const k of Object.keys(params)) if (params[k] === '' || params[k] == null) delete params[k];
    const res = await api.get(`/reports/${selected.id}`, { params });
    return res.data;
  }, [selected, filters]);

  const run = useCallback(async (offset = 0) => {
    if (!selected) return;
    setLoading(true); setError(null); setSaveState('idle');
    if (offset === 0) setResult(null);
    try {
      const data = await fetchPage(offset);
      if (!isMounted.current) return;
      setResult(data);
    } catch (e) {
      if (!isMounted.current) return;
      setError(describeError(e));
      setResult(null);
    } finally { if (isMounted.current) setLoading(false); }
  }, [selected, fetchPage]);

  /**
   * Export re-runs the query with the same filters at the export ceiling, so the
   * file matches the report the user configured rather than the page they happen
   * to be looking at. If the result is larger than the ceiling the user is told,
   * instead of silently receiving a truncated file.
   */
  const exportCSV = useCallback(async () => {
    if (!selected || !result) return;
    setExporting(true);
    try {
      const full = await fetchPage(0, EXPORT_LIMIT);
      if (!isMounted.current) return;
      downloadCSV(full.rows, `${selected.id.replace(/\//g, '-')}-${today()}.csv`);
      if (full.total > full.rows.length) {
        setError({
          kind: 'notice',
          title: `Exported the first ${full.rows.length.toLocaleString('en-IN')} of ${full.total.toLocaleString('en-IN')} rows`,
          detail: 'Narrow the filters to export the remainder.',
        });
      }
    } catch (e) {
      if (isMounted.current) setError(describeError(e));
    } finally { if (isMounted.current) setExporting(false); }
  }, [selected, result, fetchPage]);

  const saveReport = useCallback(async () => {
    if (!selected || !result?.rows?.length) return;
    setSaveState('saving');
    try {
      await api.post('/reports/saved', {
        name: `${selected.label} — ${fmtDate(today())}`,
        report_type: selected.id,
        filters,
        columns: Object.keys(result.rows[0] || {}),
      });
      if (isMounted.current) setSaveState('saved');
    } catch (e) {
      if (!isMounted.current) return;
      setSaveState('error');
      setError(describeError(e));
    }
  }, [selected, result, filters]);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const rows = result?.rows || [];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const measures = new Set(result?.measures || selected?.measures || []);
  const offset = result?.offset ?? 0;
  const limit = result?.limit ?? PAGE_SIZE;
  const total = result?.total ?? 0;

  /* ── catalog failed to load ── */
  if (catalogError) {
    return (
      <div className="rp-root">
        <div className="rp-body">
          <StateBlock {...catalogError} onRetry={() => window.location.reload()} />
        </div>
      </div>
    );
  }

  return (
    <PageShell dock={
      <PageHero
        icon={BarChart3}
        eyebrow="Reports"
        title="Reports & Analytics"
        subtitle="Generate, filter and export business reports"
      />
    }>

      <div className="rp-body">
        {!selected ? (
          <div className="rp-catalog">
            {!catalog ? (
              <div className="rp-prompt"><RefreshCw size={32} className="rp-spin" /><p>Loading report catalog…</p></div>
            ) : matches ? (
              matches.length ? (
                <div className="rp-cat-grid">
                  {matches.map(r => <ReportCard key={r.id} r={r} onSelect={selectReport} />)}
                </div>
              ) : (
                <div className="rp-empty"><Search size={32} /><p>No reports matching “{search}”</p></div>
              )
            ) : (
              categories.map(cat => {
                const st = styleFor(cat);
                return (
                  <div key={cat} className="rp-cat-section">
                    <div className="rp-cat-hd" style={{ color: st.color }}>
                      <st.icon size={16} /><span>{cat}</span>
                    </div>
                    <div className="rp-cat-grid">
                      {allReports.filter(r => r.category === cat)
                        .map(r => <ReportCard key={r.id} r={r} onSelect={selectReport} />)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="rp-runner">
            <div className="rp-runner-hd">
              <button className="rp-back-btn" onClick={() => { setSelected(null); setResult(null); setError(null); }}>
                ← Back
              </button>
              <div className="rp-runner-title">
                <span className="rp-runner-cat">{selected.category}</span>
                <h2>{selected.label}</h2>
                <p>{selected.desc}</p>
              </div>
            </div>

            <div className="rp-filters">
              <div className="rp-filter-icon"><Filter size={14} /></div>

              {selected.filters.length === 0 && (
                <span className="rp-filter-none">
                  <Info size={13} /> This report has no filters — it always shows the current position.
                </span>
              )}

              {selected.filters.map(key => (
                <div className="rp-filter-group" key={key}>
                  <label htmlFor={`f-${key}`}>{FILTER_LABEL[key] || key}</label>
                  {key === 'start_date' || key === 'end_date' ? (
                    <input id={`f-${key}`} type="date" value={filters[key] || ''}
                           min={key === 'end_date' ? filters.start_date || undefined : undefined}
                           onChange={e => setFilter(key, e.target.value)} />
                  ) : key === 'month' ? (
                    <select id="f-month" value={filters.month || ''} onChange={e => setFilter('month', e.target.value)}>
                      <option value="">All months</option>
                      {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                    </select>
                  ) : key === 'year' ? (
                    <input id="f-year" type="number" min="1970" max="2200" style={{ width: 88 }}
                           value={filters.year || ''} onChange={e => setFilter('year', e.target.value)} />
                  ) : (
                    <input id={`f-${key}`} placeholder="All" style={{ width: 130 }}
                           value={filters[key] || ''} onChange={e => setFilter(key, e.target.value)} />
                  )}
                </div>
              ))}

              <button className="rp-run-btn" onClick={() => run(0)} disabled={loading}>
                {loading ? <RefreshCw size={14} className="rp-spin" /> : <Play size={14} />}
                {loading ? 'Running…' : 'Run Report'}
              </button>

              {rows.length > 0 && (
                <>
                  <button className="rp-export-btn" onClick={exportCSV} disabled={exporting}>
                    {exporting ? <RefreshCw size={14} className="rp-spin" /> : <Download size={14} />}
                    {exporting ? 'Preparing…' : 'Export CSV'}
                  </button>
                  <button
                    className={`rp-export-btn${saveState === 'saved' ? ' rp-saved-btn' : ''}`}
                    onClick={saveReport}
                    disabled={saveState === 'saving' || saveState === 'saved'}
                  >
                    {saveState === 'saved'
                      ? <><BookmarkCheck size={14} /> Saved</>
                      : saveState === 'saving'
                        ? <><RefreshCw size={14} className="rp-spin" /> Saving…</>
                        : <><Bookmark size={14} /> Save Report</>}
                  </button>
                </>
              )}
            </div>

            {/* ── Four genuinely distinct states ── */}
            {error && <StateBlock {...error} onRetry={error.kind === 'error' ? () => run(offset) : undefined} />}

            {!error && !loading && result === null && (
              <div className="rp-prompt">
                <BarChart2 size={40} />
                <p>Set the filters above and choose <strong>Run Report</strong>.</p>
                {filters.start_date && filters.end_date && (
                  <p className="rp-prompt-sub">{fmtDate(filters.start_date)} – {fmtDate(filters.end_date)}</p>
                )}
              </div>
            )}

            {!error && !loading && result !== null && rows.length === 0 && (
              <div className="rp-prompt">
                <Inbox size={40} color="#9ca3af" />
                <p><strong>No matching records.</strong></p>
                <p className="rp-prompt-sub">
                  The report ran successfully — there is genuinely nothing in the database for these filters.
                </p>
              </div>
            )}

            {rows.length > 0 && (
              <div className="rp-table-wrap">
                <div className="rp-table-meta">
                  <span>
                    Showing <strong>{(offset + 1).toLocaleString('en-IN')}–{(offset + rows.length).toLocaleString('en-IN')}</strong>
                    {' of '}<strong>{total.toLocaleString('en-IN')}</strong> records
                  </span>
                  {filters.start_date && filters.end_date &&
                    <span>{fmtDate(filters.start_date)} – {fmtDate(filters.end_date)}</span>}
                  {total > limit && (
                    <span className="rp-pager">
                      <button disabled={offset === 0 || loading} onClick={() => run(Math.max(offset - limit, 0))}
                              aria-label="Previous page"><ChevronLeft size={14} /></button>
                      <button disabled={offset + rows.length >= total || loading} onClick={() => run(offset + limit)}
                              aria-label="Next page"><ChevronRight size={14} /></button>
                    </span>
                  )}
                </div>
                <div className="rp-table-scroll">
                  <table className="rp-table">
                    <thead>
                      <tr>
                        <th className="rp-th-num">#</th>
                        {cols.map(c => (
                          <th key={c} className={measures.has(c) ? 'rp-th-measure' : undefined}>{headerFor(c)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={i}>
                          <td className="rp-td-num">{offset + i + 1}</td>
                          {cols.map(c => {
                            const shown = formatCell(c, row[c], measures.has(c));
                            return (
                              <td key={c} className={measures.has(c) ? 'rp-td-measure' : undefined}>
                                {shown === null ? <span className="rp-nil" title="No value recorded">—</span> : shown}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}

function StateBlock({ kind, title, detail, onRetry }) {
  const Icon = kind === 'forbidden' ? ShieldOff : kind === 'notice' ? Info : AlertCircle;
  return (
    <div className={`rp-state rp-state-${kind}`} role={kind === 'notice' ? 'status' : 'alert'}>
      <Icon size={18} className="rp-state-icon" />
      <div>
        <div className="rp-state-title">{title}</div>
        {detail && <div className="rp-state-detail">{detail}</div>}
      </div>
      {onRetry && <button className="rp-state-retry" onClick={onRetry}>Try again</button>}
    </div>
  );
}

function ReportCard({ r, onSelect }) {
  const st = styleFor(r.category);
  return (
    <button className="rp-card" onClick={() => onSelect(r)}>
      <div className="rp-card-icon" style={{ background: st.bg, color: st.color }}>
        <st.icon size={18} />
      </div>
      <div className="rp-card-body">
        <div className="rp-card-label">{r.label}</div>
        <div className="rp-card-desc">{r.desc}</div>
        <div className="rp-card-tags">
          <span className="rp-tag" style={{ background: st.bg, color: st.color }}>{r.category}</span>
          {r.filters.includes('start_date') && <span className="rp-tag rp-tag-gray"><Calendar size={10} /> Date range</span>}
          {r.filters.includes('department') && <span className="rp-tag rp-tag-gray">Department</span>}
        </div>
      </div>
      <ChevronRight size={16} className="rp-card-arrow" />
    </button>
  );
}
