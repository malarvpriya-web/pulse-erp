import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import {
  RefreshCw, ChevronDown, ChevronRight, Search, Download,
  ArrowUp, ArrowDown, Trophy, X, Filter,
} from 'lucide-react';
import { fmtDate } from '@/utils/dateFormatter';
import { fmtL } from '@/utils/format';
import { getWonLostLeads, getWonLostLeadsFilters, exportWonLostLeads } from '../services/crmService';

// Full ₹ with Indian thousands separators — e.g. ₹12,34,567 (per report spec).
// Kept local: this is the grid's own full-precision cell format, distinct from
// the shared compact fmtL used on the KPI tiles.
const fmtINR = (n) => '₹' + Math.round(parseFloat(n) || 0).toLocaleString('en-IN');

// Value-range dropdown (in lakhs) → {min,max} query params.
const VALUE_RANGES = [
  { value: '',        label: 'All Values',      min: undefined, max: undefined },
  { value: '0-10',    label: '0 – 10 L',        min: 0,   max: 10 },
  { value: '10-50',   label: '10 – 50 L',       min: 10,  max: 50 },
  { value: '50-100',  label: '50 L – 1 Cr',     min: 50,  max: 100 },
  { value: '100-500', label: '1 – 5 Cr',        min: 100, max: 500 },
  { value: '500+',    label: 'Above 5 Cr',      min: 500, max: undefined },
];

const STATUS_OPTIONS = [
  { value: '',     label: 'All' },
  { value: 'won',  label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

const PAGE_SIZES = [10, 25, 50, 100];

const STATUS_COLORS = {
  Won:  { bg: '#d1fae5', color: '#16a34a' },
  Lost: { bg: '#fee2e2', color: '#dc2626' },
};

// Phone field may hold several numbers separated by / , or ; — normalise to " / ".
const fmtPhone = (p) => {
  if (!p) return 'NA';
  const parts = String(p).split(/[/,;]+/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts.join(' / ') : 'NA';
};

const inputStyle = {
  appearance: 'none', padding: '7px 30px 7px 10px', border: '0.5px solid var(--color-border-tertiary)',
  borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)',
  color: 'var(--color-text-primary)', cursor: 'pointer', minWidth: 140,
};

function Select({ value, onChange, children, width }) {
  return (
    <div style={{ position: 'relative' }}>
      <select value={value} onChange={onChange} style={{ ...inputStyle, minWidth: width || 140 }}>
        {children}
      </select>
      <ChevronDown size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--color-text-secondary)' }} />
    </div>
  );
}

const COLUMNS = [
  { key: 'iem_no',     label: 'IEM No',     sortType: 'string', align: 'left' },
  { key: 'customer',   label: 'Customer',   sortType: 'string', align: 'left' },
  { key: 'created_at', label: 'Created On', sortType: 'date',   align: 'left' },
  { key: 'status',     label: 'Status',     sortType: 'string', align: 'left' },
  { key: 'value',      label: 'Value',      sortType: 'number', align: 'right' },
  { key: 'contact',    label: 'Contact',    sortType: 'string', align: 'left' },
  { key: 'phone',      label: 'Phone',      sortType: 'string', align: 'left' },
  { key: 'email',      label: 'Email',      sortType: 'string', align: 'left' },
  { key: 'channel',    label: 'Channel',    sortType: 'string', align: 'left' },
];

export default function WonLostLeads() {
  // Draft filter state (applied on Load)
  const [dUser,   setDUser]   = useState('');
  const [dStatus, setDStatus] = useState('');
  const [dRange,  setDRange]  = useState('');
  const [dFy,     setDFy]     = useState('');

  const [rows,    setRows]    = useState([]);
  const [totals,  setTotals]  = useState({ total_value: 0, won_count: 0, lost_count: 0, count: 0 });
  const [opts,    setOpts]    = useState({ users: [], fiscal_years: [] });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Grid state (client-side)
  const [search,   setSearch]   = useState('');
  const [sort,     setSort]     = useState({ key: 'created_at', dir: 'desc' });
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expanded, setExpanded] = useState(new Set());

  const rangeParams = (v) => {
    const r = VALUE_RANGES.find(x => x.value === v);
    const p = {};
    if (r?.min !== undefined) p.min_value = r.min;
    if (r?.max !== undefined) p.max_value = r.max;
    return p;
  };

  const currentParams = useCallback(() => ({
    ...(dUser   ? { user: dUser }     : {}),
    ...(dStatus ? { status: dStatus } : {}),
    ...(dFy     ? { fy: dFy }         : {}),
    ...rangeParams(dRange),
  }), [dUser, dStatus, dFy, dRange]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getWonLostLeads(currentParams());
      setRows(Array.isArray(res.data) ? res.data : []);
      setTotals({
        total_value: res.total_value || 0,
        won_count:   res.won_count   || 0,
        lost_count:  res.lost_count  || 0,
        count:       res.count       || 0,
      });
      setPage(1);
      setExpanded(new Set());
    } finally {
      setLoading(false);
    }
  }, [currentParams]);

  // Initial load + filter options
  useEffect(() => {
    getWonLostLeadsFilters().then(setOpts);
    load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Search (client-side) ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      [r.iem_no, r.customer, r.contact, r.email, r.phone, r.channel]
        .some(f => (f || '').toString().toLowerCase().includes(q))
    );
  }, [rows, search]);

  // ── Sort (client-side) ────────────────────────────────────────────────────
  const sorted = useMemo(() => {
    const col = COLUMNS.find(c => c.key === sort.key);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av = a[sort.key], bv = b[sort.key];
      if (col?.sortType === 'number') { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; return (av - bv) * dir; }
      if (col?.sortType === 'date')   { av = av ? new Date(av).getTime() : 0; bv = bv ? new Date(bv).getTime() : 0; return (av - bv) * dir; }
      return (av || '').toString().localeCompare((bv || '').toString()) * dir;
    });
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows   = sorted.slice((page - 1) * pageSize, page * pageSize);

  // Footer total sums the Value column across ALL filtered rows (recalculates on
  // search/filter change — not just the visible page).
  const footerTotal = useMemo(
    () => filtered.reduce((s, r) => s + (parseFloat(r.value) || 0), 0),
    [filtered]
  );

  const toggleSort = (key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'value' || key === 'created_at' ? 'desc' : 'asc' });
  };
  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleExport = async () => {
    setExporting(true);
    try { await exportWonLostLeads(currentParams()); }
    finally { setExporting(false); }
  };

  const resetFilters = () => { setDUser(''); setDStatus(''); setDRange(''); setDFy(''); };

  const KPIS = [
    { label: 'Total Closed', value: totals.count,             color: 'var(--color-text-primary)' },
    { label: 'Won',          value: totals.won_count,         color: '#16a34a' },
    { label: 'Lost',         value: totals.lost_count,        color: '#dc2626' },
    { label: 'Total Value',  value: fmtL(totals.total_value), color: 'var(--color-primary)' },
  ];

  return (
    <div style={{ padding: 24, background: 'var(--color-bg-page)', minHeight: '100%' }}>
      <style>{`@keyframes wl-pulse { 0%,100%{opacity:1} 50%{opacity:.4} } @keyframes wl-spin { to { transform: rotate(360deg) } } .wl-spin { animation: wl-spin 0.8s linear infinite; }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>IEM Won / Lost Leads</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Closed enquiries — won and lost — with value, contact and channel.</p>
        </div>
      </div>

      {/* Filter panel */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 16px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600, marginRight: 4 }}>
          <Filter size={14} /> Filters
        </div>
        <FilterField label="User">
          <Select value={dUser} onChange={e => setDUser(e.target.value)} width={160}>
            <option value="">All Users</option>
            {opts.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </FilterField>
        <FilterField label="Status">
          <Select value={dStatus} onChange={e => setDStatus(e.target.value)} width={110}>
            {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </FilterField>
        <FilterField label="Value (Lakhs)">
          <Select value={dRange} onChange={e => setDRange(e.target.value)} width={150}>
            {VALUE_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        </FilterField>
        <FilterField label="Year (FY)">
          <Select value={dFy} onChange={e => setDFy(e.target.value)} width={140}>
            <option value="">All Years</option>
            {opts.fiscal_years.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
          </Select>
        </FilterField>
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 18px', border: 'none', borderRadius: 7, background: 'var(--color-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} className={loading ? 'wl-spin' : ''} /> Load
        </button>
        {(dUser || dStatus || dRange || dFy) && (
          <button onClick={resetFilters}
            style={{ padding: '8px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-primary)', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
            <X size={13} /> Clear
          </button>
        )}
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14, marginBottom: 18 }}>
        {KPIS.map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 500, marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color }}>
              {loading ? <div style={{ height: 22, width: 60, background: 'var(--color-border-tertiary)', borderRadius: 4, animation: 'wl-pulse 1.5s ease-in-out infinite' }} /> : value}
            </div>
          </div>
        ))}
      </div>

      {/* Grid toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-secondary)' }} />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search IEM, customer, contact…"
            style={{ width: '100%', padding: '8px 12px 8px 32px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Rows
          <Select value={pageSize} onChange={e => { setPageSize(parseInt(e.target.value)); setPage(1); }} width={72}>
            {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
        <button onClick={handleExport} disabled={exporting || !rows.length}
          style={{ padding: '8px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: rows.length ? 'pointer' : 'not-allowed', opacity: rows.length ? 1 : 0.5, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600 }}>
          <Download size={14} /> {exporting ? 'Exporting…' : 'Export Excel'}
        </button>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--color-background-secondary)' }}>
                <th style={{ width: 34, borderBottom: '0.5px solid var(--color-border-tertiary)' }} />
                {COLUMNS.map(c => {
                  const active = sort.key === c.key;
                  return (
                    <th key={c.key} onClick={() => toggleSort(c.key)}
                      style={{ padding: '10px 14px', textAlign: c.align, fontWeight: 600, color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexDirection: c.align === 'right' ? 'row-reverse' : 'row' }}>
                        {c.label}
                        {active && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [1, 2, 3, 4, 5].map(i => (
                  <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <td colSpan={COLUMNS.length + 1} style={{ padding: '12px 16px' }}>
                      <div style={{ height: 14, width: '80%', background: 'var(--color-background-secondary)', borderRadius: 4, animation: 'wl-pulse 1.5s ease-in-out infinite' }} />
                    </td>
                  </tr>
                ))
              ) : pageRows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length + 1} style={{ padding: 0 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '52px 24px', textAlign: 'center' }}>
                      <Trophy size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
                      <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No closed leads</p>
                      <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>Won or lost enquiries will appear here once leads close.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                pageRows.map(r => {
                  const sc = STATUS_COLORS[r.status] || { bg: '#f3f4f6', color: '#6b7280' };
                  const isOpen = expanded.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr style={{ borderBottom: isOpen ? 'none' : '0.5px solid var(--color-border-tertiary)', background: r.status === 'Won' ? 'rgba(22,163,74,0.03)' : 'rgba(220,38,38,0.03)' }}>
                        <td style={{ padding: '10px 6px 10px 12px', textAlign: 'center' }}>
                          <button onClick={() => toggleExpand(r.id)} title="Expand"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', display: 'inline-flex', padding: 2 }}>
                            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                          <button onClick={() => toggleExpand(r.id)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-primary)', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                            {r.iem_no}
                          </button>
                        </td>
                        <td style={{ padding: '10px 14px', color: 'var(--color-text-primary)', fontWeight: 500 }}>{r.customer || '—'}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: sc.bg, color: sc.color }}>{r.status}</span>
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>{fmtINR(r.value)}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--color-text-primary)' }}>{r.contact || 'NA'}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtPhone(r.phone)}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.email || 'NA'}</td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '0.5px solid var(--color-border-tertiary)' }}>{r.channel || '—'}</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>
                          <td />
                          <td colSpan={COLUMNS.length} style={{ padding: '10px 14px 14px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
                              <Detail label="Industry"    value={r.industry} />
                              <Detail label="Location"    value={r.location} />
                              <Detail label="Zone"        value={r.zone} />
                              <Detail label="Lead Score"  value={r.lead_score != null ? String(r.lead_score) : null} />
                              <Detail label="Owner"       value={r.assigned_to_name} />
                              <Detail label="Closed On"   value={r.closed_date ? fmtDate(r.closed_date) : null} />
                              <Detail label="Notes"       value={r.notes} wide />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
            {!loading && filtered.length > 0 && (
              <tfoot>
                <tr style={{ background: 'var(--color-background-secondary)', borderTop: '1.5px solid var(--color-border-tertiary)' }}>
                  <td colSpan={5} style={{ padding: '12px 14px', fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'right' }}>
                    Total ({filtered.length} lead{filtered.length !== 1 ? 's' : ''})
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 800, color: 'var(--color-primary)', whiteSpace: 'nowrap' }}>{fmtINR(footerTotal)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Pagination */}
      {!loading && sorted.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <span>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} of {sorted.length}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === 1 ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === 1 ? 0.5 : 1, fontSize: 13 }}>Prev</button>
            <span style={{ padding: '5px 4px' }}>Page {page} of {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === totalPages ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === totalPages ? 0.5 : 1, fontSize: 13 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterField({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{label}</label>
      {children}
    </div>
  );
}

function Detail({ label, value, wide }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : 'auto' }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{value || 'NA'}</div>
    </div>
  );
}
