import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import {
  RefreshCw, Plus, X, TrendingUp, SlidersHorizontal, Download,
  Star, Pencil, ChevronRight, ChevronDown, ChevronUp, Inbox, Search,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtL } from '@/utils/format';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './Pursuits.css';

// Value in whole rupees -> "12.50" lakh (bare number; the column header carries the unit).
const toLac = v => (Number(v || 0) / 100000).toFixed(2);

const BRAND = '#6B3FDB';

// Pipeline order drives the per-row stage-progress bar. Won completes it; Lost
// and Shelved are terminal off-ramps rendered as their own colour.
const STAGES = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won'];
const STAGE_META = {
  Prospecting:   { color: '#6366f1', bg: '#eef2ff' },
  Qualification: { color: '#3b82f6', bg: '#dbeafe' },
  Proposal:      { color: '#d97706', bg: '#fef3c7' },
  Negotiation:   { color: '#ef4444', bg: '#fee2e2' },
  Won:           { color: '#16a34a', bg: '#d1fae5' },
  Lost:          { color: '#dc2626', bg: '#fee2e2' },
  Shelved:       { color: '#6b7280', bg: '#f3f4f6' },
};
const ALL_STAGES = [...STAGES, 'Lost', 'Shelved'];
const sm = s => STAGE_META[s] || STAGE_META.Shelved;

const stageProgress = (stage) => {
  const i = STAGES.indexOf(stage);
  if (i >= 0) return Math.round((i / (STAGES.length - 1)) * 100);
  return 100; // Lost / Shelved are closed
};

// Stable categorical hues for whatever zone labels the data carries. Region
// names are configured elsewhere (Settings) — this only needs to keep a colour
// attached to a label consistently, and give a neutral to "Unassigned".
const ZONE_PALETTE = ['#6B3FDB', '#d97706', '#0d9488', '#db2777', '#0284c7', '#7c3aed', '#ca8a04', '#0891b2'];
const zoneColor = (zone, i) => (zone === 'Unassigned' ? '#9ca3af' : ZONE_PALETTE[i % ZONE_PALETTE.length]);

const GRID = { strokeDasharray: '3 3', stroke: '#f0f0f4' };
const TICK = { fontSize: 11, fill: '#6b7280' };
const axisLac = v => (v ? `${(v / 100000).toFixed(0)}L` : '0');
const fyLabel = y => `FY ${y}-${String(y + 1).slice(2)}`;
const fmtDMY = v => (v ? new Date(v).toLocaleDateString('en-GB') : '—'); // DD/MM/YYYY

// Value bands for the filter modal (min inclusive, max exclusive; rupees).
const VALUE_BANDS = [
  { key: 'all',   label: 'All',       min: null,     max: null },
  { key: '0-10',  label: '0–10 L',    min: 0,        max: 1000000 },
  { key: '10-25', label: '10–25 L',   min: 1000000,  max: 2500000 },
  { key: '25-50', label: '25–50 L',   min: 2500000,  max: 5000000 },
  { key: '50+',   label: '50 L +',    min: 5000000,  max: null },
];

const emptyForm = () => ({
  opportunity_name: '', lead_id: '', expected_value: '', estimate_value: '',
  probability_percentage: 50, stage: 'Prospecting', assigned_to: '', held_by: '',
  expected_closing_date: '', follow_up_date: '', notes: '',
});

const PAGE_SIZES = [10, 20, 50, 100];

export default function Pursuits() {
  const { readOnly } = usePageAccess();

  const [rows,      setRows]      = useState([]);
  const [an,        setAn]        = useState(null);
  const [forecast,  setForecast]  = useState(null);
  const [employees, setEmployees] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [anError,   setAnError]   = useState(false);

  // filters
  const [fy,       setFy]       = useState(null);   // null => server picks
  const [owner,    setOwner]    = useState('');
  const [valBand,  setValBand]  = useState('all');
  const [showFilter, setShowFilter] = useState(false);

  // grid controls
  const [search,   setSearch]   = useState('');
  const [sort,     setSort]     = useState('id');
  const [dir,      setDir]      = useState('desc');
  const [pageSize, setPageSize] = useState(20);
  const [page,     setPage]     = useState(1);
  const [ratingMode, setRatingMode] = useState(false);
  const [expanded, setExpanded] = useState(null);

  // forecast panel + form drawer
  const [showForecast, setShowForecast] = useState(false);
  const [drawer, setDrawer] = useState(null);   // null | 'create' | row
  const [form,   setForm]   = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [toast,  setToast]  = useState(null);

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const band = VALUE_BANDS.find(b => b.key === valBand) || VALUE_BANDS[0];

  const gridParams = useCallback(() => {
    const p = { sort, dir };
    if (owner)          p.assigned_to = owner;
    if (band.min != null) p.value_min = band.min;
    if (band.max != null) p.value_max = band.max;
    return p;
  }, [sort, dir, owner, band]);

  const anParams = useCallback(() => {
    const p = {};
    if (fy != null)     p.fy = fy;
    if (owner)          p.assigned_to = owner;
    if (band.min != null) p.value_min = band.min;
    if (band.max != null) p.value_max = band.max;
    return p;
  }, [fy, owner, band]);

  const load = useCallback(async () => {
    setLoading(true);
    setAnError(false);
    const [gridRes, anRes, empRes] = await Promise.allSettled([
      api.get('/crm/opportunities', { params: gridParams() }),
      api.get('/crm/pursuits/analytics', { params: anParams() }),
      employees.length ? Promise.resolve({ data: employees }) : api.get('/employees'),
    ]);
    if (!mounted.current) return;

    setRows(gridRes.status === 'fulfilled' && Array.isArray(gridRes.value.data) ? gridRes.value.data : []);

    if (anRes.status === 'fulfilled') setAn(anRes.value.data || null);
    else { setAn(null); setAnError(true); }

    if (!employees.length) {
      const ed = empRes.status === 'fulfilled' ? empRes.value.data : null;
      setEmployees(Array.isArray(ed) ? ed : Array.isArray(ed?.employees) ? ed.employees : []);
    }
    setLoading(false);
  }, [gridParams, anParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, pageSize, owner, valBand, fy, sort, dir]);

  const loadForecast = useCallback(async () => {
    try {
      const res = await api.get('/crm/pursuits/forecast', { params: anParams() });
      if (mounted.current) setForecast(res.data || null);
    } catch { if (mounted.current) setForecast(null); }
  }, [anParams]);

  const openForecast = () => { setShowForecast(true); loadForecast(); };

  // ── grid derived state ──────────────────────────────────────────────────────
  const selectedFy = fy ?? an?.fy ?? '';
  const fyChoices = useMemo(() => {
    const set = new Set(an?.fy_options || []);
    if (an?.current_fy) set.add(an.current_fy);
    if (fy != null) set.add(fy);
    return [...set].sort((a, b) => b - a);
  }, [an, fy]);
  const owners = an?.owners || [];

  // FY scoping of the grid is client-side (the grid endpoint isn't FY-aware).
  const inFy = (r) => {
    if (selectedFy === '' || selectedFy == null) return true;
    const startM = (an?.fiscal_year_start_month || 4) - 1;
    const d = r.created_at ? new Date(r.created_at) : null;
    if (!d) return true;
    const rowFy = d.getMonth() >= startM ? d.getFullYear() : d.getFullYear() - 1;
    return rowFy === Number(selectedFy);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => inFy(r) && (!q ||
      (r.opportunity_number || '').toLowerCase().includes(q) ||
      (r.opportunity_name || '').toLowerCase().includes(q) ||
      (r.company_name || '').toLowerCase().includes(q) ||
      (r.assigned_to_name || '').toLowerCase().includes(q)));
  }, [rows, search, selectedFy]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  const setSortCol = (col) => {
    if (sort === col) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(col); setDir('asc'); }
  };
  const toggleRating = () => {
    const next = !ratingMode;
    setRatingMode(next);
    if (next) { setSort('probability_percentage'); setDir('desc'); }
  };

  const exportExcel = async () => {
    try {
      const res = await api.get('/crm/pursuits/export', { params: gridParams(), responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `pursuits_${Date.now()}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { showToast('Export failed', 'error'); }
  };

  // ── form ────────────────────────────────────────────────────────────────────
  const openCreate = () => { setForm(emptyForm()); setDrawer('create'); };
  const openEdit = (r) => {
    setForm({
      opportunity_name: r.opportunity_name || '',
      lead_id: r.lead_id || '',
      expected_value: r.expected_value ?? '',
      estimate_value: r.estimate_value ?? '',
      probability_percentage: r.probability_percentage ?? 50,
      stage: r.stage || 'Prospecting',
      assigned_to: r.assigned_to || '',
      held_by: r.held_by || '',
      expected_closing_date: r.expected_closing_date ? String(r.expected_closing_date).slice(0, 10) : '',
      follow_up_date: r.follow_up_date ? String(r.follow_up_date).slice(0, 10) : '',
      notes: r.notes || '',
    });
    setDrawer(r);
  };
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.opportunity_name.trim()) return showToast('Pursuit name is required', 'error');
    setSaving(true);
    try {
      if (drawer === 'create') { await api.post('/crm/opportunities', form); showToast('Pursuit created'); }
      else { await api.put(`/crm/opportunities/${drawer.id}`, form); showToast('Pursuit updated'); }
      setDrawer(null);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Save failed', 'error');
    } finally { setSaving(false); }
  };

  const empName = id => {
    const e = employees.find(e => String(e.id) === String(id));
    return e ? (e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()) : '';
  };

  // ── widget data ─────────────────────────────────────────────────────────────
  const monthly  = an?.monthly   || [];
  const byZone   = an?.by_zone    || [];
  const byStatus = an?.by_status  || [];
  const summary  = an?.summary    || null;
  const zoneData = byZone.filter(z => z.value > 0 || z.count > 0);

  const SUMMARY_ROWS = summary ? [
    { label: 'Conversion rate', pct: summary.conversion_rate, cell: null },
    { label: 'Total pursuits',  cell: summary.total },
    { label: 'Total won',       cell: summary.won },
    { label: 'Total lost',      cell: summary.lost },
    { label: 'Total shelved',   cell: summary.shelved },
  ] : [];

  const filterChip = `Owner: ${owner ? empName(owner) || '—' : 'All'} · Value: ${band.label} · Year: ${selectedFy ? fyLabel(selectedFy) : 'All'}`;

  const Th = ({ col, children, align = 'left' }) => (
    <th
      className="pu-th pu-th-sort"
      style={{ textAlign: align }}
      onClick={() => setSortCol(col)}
    >
      <span className="pu-th-inner" style={{ justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
        {children}
        {sort === col && (dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </span>
    </th>
  );

  return (
    <div className="pu-root">
      {toast && <div className={`pu-toast pu-toast-${toast.type}`}>{toast.msg}</div>}
      {readOnly && <ReadOnlyBanner />}

      {/* ── Toolbar ── */}
      <div className="pu-header">
        <div>
          <h2 className="pu-title">Pursuits</h2>
          <p className="pu-sub">Opportunity pipeline · {filtered.length} pursuits</p>
        </div>
        <div className="pu-header-r">
          <button className="pu-btn-outline" onClick={openForecast}><TrendingUp size={14} /> Forecast</button>
          <button className="pu-btn-outline" onClick={() => setShowFilter(true)}><SlidersHorizontal size={14} /> Set Filter</button>
          <button className="pu-icon-btn" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
        </div>
      </div>

      {/* applied-filter chip */}
      <div className="pu-chip-row">
        <span className="pu-chip">Filter applied: {filterChip}</span>
        {(owner || valBand !== 'all' || fy != null) && (
          <button className="pu-chip-clear" onClick={() => { setOwner(''); setValBand('all'); setFy(null); }}>Reset</button>
        )}
      </div>

      {/* ── Summary widgets row ── */}
      <div className="pu-widgets">
        <div className="pu-card pu-span4">
          <div className="pu-card-hd"><span className="pu-card-title">Pursuits by Month</span></div>
          <div className="pu-card-body">
            {anError ? <Empty title="Couldn't load analytics" />
              : monthly.some(m => m.count > 0)
                ? <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={monthly} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                      <CartesianGrid {...GRID} vertical={false} />
                      <XAxis dataKey="month" tick={{ ...TICK, fontSize: 10 }} />
                      <YAxis tick={TICK} allowDecimals={false} />
                      <Tooltip cursor={{ fill: 'rgba(107,63,219,0.05)' }} />
                      <Bar dataKey="count" name="Pursuits" fill={BRAND} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    </BarChart>
                  </ResponsiveContainer>
                : <Empty title="No pursuits this year" />}
          </div>
        </div>

        <div className="pu-card pu-span4">
          <div className="pu-card-hd"><span className="pu-card-title">Pursuits by Zone</span></div>
          <div className="pu-card-body">
            {zoneData.length
              ? <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={zoneData} dataKey="count" nameKey="zone" cx="50%" cy="50%"
                      innerRadius={46} outerRadius={74} paddingAngle={2} stroke="#fff" strokeWidth={2} labelLine={false}>
                      {zoneData.map((z, i) => <Cell key={z.zone} fill={zoneColor(z.zone, i)} />)}
                    </Pie>
                    <Tooltip />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              : <Empty title="No zone data" />}
          </div>
        </div>

        <div className="pu-card pu-span4">
          <div className="pu-card-hd"><span className="pu-card-title">Pursuits by Status</span></div>
          <div className="pu-card-body">
            {byStatus.some(s => s.count > 0)
              ? <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={byStatus} layout="vertical" margin={{ top: 4, right: 30, left: 4, bottom: 4 }}>
                    <CartesianGrid {...GRID} horizontal={false} />
                    <XAxis type="number" tick={TICK} allowDecimals={false} />
                    <YAxis type="category" dataKey="stage" tick={{ ...TICK, fontSize: 11 }} width={86} />
                    <Tooltip cursor={{ fill: 'rgba(107,63,219,0.05)' }} />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={16}>
                      {byStatus.map(s => <Cell key={s.stage} fill={sm(s.stage).color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              : <Empty title="No status data" />}
          </div>
        </div>

        {/* Value / Estimate summary table */}
        <div className="pu-card pu-span12">
          <div className="pu-card-hd"><span className="pu-card-title">Value &amp; Estimate Summary</span></div>
          <div className="pu-card-body" style={{ overflowX: 'auto' }}>
            {summary ? (
              <table className="pu-summary">
                <thead>
                  <tr><th>Metric</th><th className="pu-num">Count</th><th className="pu-num">Value (Lac)</th><th className="pu-num">Estimate (Lac)</th></tr>
                </thead>
                <tbody>
                  {SUMMARY_ROWS.map(r => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      {r.pct != null ? (
                        <><td className="pu-num pu-strong">{r.pct}%</td><td className="pu-num">—</td><td className="pu-num">—</td></>
                      ) : (
                        <>
                          <td className="pu-num">{r.cell?.count ?? 0}</td>
                          <td className="pu-num">{toLac(r.cell?.value)}</td>
                          <td className="pu-num">{toLac(r.cell?.estimate)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty title="No summary data" />}
          </div>
        </div>
      </div>

      {/* ── Data grid toolbar ── */}
      <div className="pu-grid-toolbar">
        <div className="pu-search">
          <Search size={14} />
          <input placeholder="Search ID, pursuit, customer, owner…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="pu-grid-toolbar-r">
          {!readOnly && <button className="pu-btn-primary" onClick={openCreate}><Plus size={14} /> New</button>}
          <button className={`pu-btn-outline${ratingMode ? ' pu-btn-on' : ''}`} onClick={toggleRating}><Star size={14} /> Rating</button>
          <button className="pu-btn-outline" onClick={exportExcel}><Download size={14} /> Excel</button>
          <select className="pu-select-sm" value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
      </div>

      {/* ── Data grid ── */}
      <div className="pu-table-wrap">
        <table className="pu-table">
          <thead>
            <tr>
              <th className="pu-th" style={{ width: 30 }} />
              <Th col="opportunity_number">ID</Th>
              <Th col="opportunity_name">Pursuit</Th>
              <Th col="company_name">Customer</Th>
              <Th col="expected_value" align="right">Value (Lac)</Th>
              <Th col="probability_percentage" align="right">Prob %</Th>
              <Th col="estimate_value" align="right">Estimate (Lac)</Th>
              <Th col="stage">Status</Th>
              <th className="pu-th">Held by</th>
              <Th col="follow_up_date">Follow-up</Th>
              {!readOnly && <th className="pu-th" style={{ width: 40 }} />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} className="pu-loading">Loading…</td></tr>
            ) : paged.length === 0 ? (
              <tr><td colSpan={11}><Empty title="No pursuits found" hint="Adjust filters, or add a new pursuit." /></td></tr>
            ) : paged.map(r => {
              const st = sm(r.stage);
              const prob = parseInt(r.probability_percentage) || 0;
              const stars = Math.round(prob / 20);
              const isOpen = expanded === r.id;
              return (
                <Fragment key={r.id}>
                  <tr className="pu-row">
                    <td className="pu-td">
                      <button className="pu-expand" onClick={() => setExpanded(isOpen ? null : r.id)} title="Quick actions">
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="pu-td">
                      <div className="pu-id">{r.opportunity_number || `IPM-${String(r.id).padStart(6, '0')}`}</div>
                      <div className="pu-progress-track" title={`${stageProgress(r.stage)}% through pipeline`}>
                        <div className="pu-progress-bar" style={{ width: `${stageProgress(r.stage)}%`, background: st.color }} />
                      </div>
                    </td>
                    <td className="pu-td pu-strong">{r.opportunity_name}</td>
                    <td className="pu-td">{r.company_name || '—'}</td>
                    <td className="pu-td pu-num pu-strong">{toLac(r.expected_value)}</td>
                    <td className="pu-td pu-num">
                      {ratingMode
                        ? <span className="pu-stars" title={`${prob}%`}>{'★'.repeat(stars)}{'☆'.repeat(5 - stars)}</span>
                        : `${prob}%`}
                    </td>
                    <td className="pu-td pu-num">{toLac(r.estimate_value)}</td>
                    <td className="pu-td"><span className="pu-badge" style={{ background: st.bg, color: st.color }}>{r.stage}</span></td>
                    <td className="pu-td">{r.held_by_name || '—'}</td>
                    <td className="pu-td">{fmtDMY(r.follow_up_date)}</td>
                    {!readOnly && (
                      <td className="pu-td">
                        <button className="pu-action" title="Edit" onClick={() => openEdit(r)}><Pencil size={13} /></button>
                      </td>
                    )}
                  </tr>
                  {isOpen && (
                    <tr className="pu-row-detail">
                      <td colSpan={11}>
                        <div className="pu-detail">
                          <div><span className="pu-detail-lbl">Owner</span>{r.assigned_to_name || 'Unassigned'}</div>
                          <div><span className="pu-detail-lbl">Close date</span>{fmtDMY(r.expected_closing_date)}</div>
                          <div><span className="pu-detail-lbl">Value</span>{fmtL(r.expected_value)}</div>
                          <div><span className="pu-detail-lbl">Estimate</span>{fmtL(r.estimate_value)}</div>
                          {r.notes && <div className="pu-detail-notes"><span className="pu-detail-lbl">Notes</span>{r.notes}</div>}
                          {!readOnly && <button className="pu-btn-outline pu-detail-edit" onClick={() => openEdit(r)}><Pencil size={13} /> Edit</button>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && totalPages > 1 && (
        <div className="pu-pager">
          <span>{filtered.length} records · Page {page} of {totalPages}</span>
          <div className="pu-pager-btns">
            <button disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</button>
            <button disabled={page === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</button>
          </div>
        </div>
      )}

      {/* ── Filter modal ── */}
      {showFilter && (
        <div className="pu-overlay" onClick={() => setShowFilter(false)}>
          <div className="pu-modal" onClick={e => e.stopPropagation()}>
            <div className="pu-modal-hd"><h3>Set Filter</h3><button className="pu-icon-btn" onClick={() => setShowFilter(false)}><X size={16} /></button></div>
            <div className="pu-modal-body">
              <div className="pu-field">
                <label>Owner</label>
                <select value={owner} onChange={e => setOwner(e.target.value)}>
                  <option value="">All owners</option>
                  {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="pu-field">
                <label>Value</label>
                <select value={valBand} onChange={e => setValBand(e.target.value)}>
                  {VALUE_BANDS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
                </select>
              </div>
              <div className="pu-field">
                <label>Financial Year</label>
                <select value={selectedFy} onChange={e => setFy(Number(e.target.value))}>
                  {fyChoices.length === 0 && <option value="">—</option>}
                  {fyChoices.map(y => <option key={y} value={y}>{fyLabel(y)}{y === an?.current_fy ? ' (current)' : ''}</option>)}
                </select>
              </div>
            </div>
            <div className="pu-modal-ft">
              <button className="pu-btn-outline" onClick={() => { setOwner(''); setValBand('all'); setFy(null); }}>Reset</button>
              <button className="pu-btn-primary" onClick={() => setShowFilter(false)}>Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Forecast panel ── */}
      {showForecast && (
        <div className="pu-overlay" onClick={() => setShowForecast(false)}>
          <div className="pu-modal pu-modal-lg" onClick={e => e.stopPropagation()}>
            <div className="pu-modal-hd"><h3>Forecast · {selectedFy ? fyLabel(selectedFy) : ''}</h3><button className="pu-icon-btn" onClick={() => setShowForecast(false)}><X size={16} /></button></div>
            <div className="pu-modal-body">
              <div className="pu-fc-kpis">
                <div className="pu-fc-kpi"><span>Committed (Won)</span><b style={{ color: '#16a34a' }}>{fmtL(forecast?.committed_total)}</b></div>
                <div className="pu-fc-kpi"><span>Weighted pipeline</span><b style={{ color: BRAND }}>{fmtL(forecast?.weighted_total)}</b></div>
                <div className="pu-fc-kpi"><span>Best case (open)</span><b style={{ color: '#3b82f6' }}>{fmtL(forecast?.best_case_total)}</b></div>
              </div>
              {forecast?.monthly?.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={forecast.monthly} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                    <CartesianGrid {...GRID} vertical={false} />
                    <XAxis dataKey="month" tick={{ ...TICK, fontSize: 10 }} />
                    <YAxis tick={TICK} tickFormatter={axisLac} />
                    <Tooltip formatter={v => fmtL(v)} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="committed" name="Committed" stackId="a" fill="#16a34a" radius={[0, 0, 0, 0]} maxBarSize={30} />
                    <Bar dataKey="weighted"  name="Weighted"  stackId="a" fill={BRAND} radius={[3, 3, 0, 0]} maxBarSize={30} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <Empty title="No forecast data for this year" />}
            </div>
          </div>
        </div>
      )}

      {/* ── Create / Edit drawer ── */}
      {drawer !== null && (
        <div className="pu-overlay" onClick={() => setDrawer(null)}>
          <div className="pu-drawer" onClick={e => e.stopPropagation()}>
            <div className="pu-modal-hd">
              <h3>{drawer === 'create' ? 'New Pursuit' : `Edit ${drawer.opportunity_number || 'Pursuit'}`}</h3>
              <button className="pu-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="pu-modal-body" onSubmit={submit}>
              <div className="pu-field">
                <label>Pursuit Name *</label>
                <input value={form.opportunity_name} onChange={e => setF('opportunity_name', e.target.value)} placeholder="Deal / project name…" />
              </div>
              <div className="pu-row2">
                <div className="pu-field"><label>Value (₹)</label>
                  <input type="number" min="0" value={form.expected_value} onChange={e => setF('expected_value', e.target.value)} placeholder="0" /></div>
                <div className="pu-field"><label>Estimate (₹)</label>
                  <input type="number" min="0" value={form.estimate_value} onChange={e => setF('estimate_value', e.target.value)} placeholder="0" /></div>
              </div>
              <div className="pu-row2">
                <div className="pu-field"><label>Probability %</label>
                  <input type="number" min="0" max="100" value={form.probability_percentage} onChange={e => setF('probability_percentage', e.target.value)} /></div>
                <div className="pu-field"><label>Status</label>
                  <select value={form.stage} onChange={e => setF('stage', e.target.value)}>
                    {ALL_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select></div>
              </div>
              <div className="pu-row2">
                <div className="pu-field"><label>Owner</label>
                  <select value={form.assigned_to} onChange={e => setF('assigned_to', e.target.value)}>
                    <option value="">— Select —</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}</option>)}
                  </select></div>
                <div className="pu-field"><label>Held By</label>
                  <select value={form.held_by} onChange={e => setF('held_by', e.target.value)}>
                    <option value="">— Select —</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}</option>)}
                  </select></div>
              </div>
              <div className="pu-row2">
                <div className="pu-field"><label>Follow-up Date</label>
                  <input type="date" value={form.follow_up_date} onChange={e => setF('follow_up_date', e.target.value)} /></div>
                <div className="pu-field"><label>Expected Close</label>
                  <input type="date" value={form.expected_closing_date} onChange={e => setF('expected_closing_date', e.target.value)} /></div>
              </div>
              <div className="pu-field"><label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setF('notes', e.target.value)} /></div>
              <div className="pu-modal-ft">
                <button type="button" className="pu-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="pu-btn-primary" disabled={saving}>{saving ? 'Saving…' : drawer === 'create' ? 'Create' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ title, hint }) {
  return (
    <div className="pu-empty">
      <Inbox size={28} strokeWidth={1.2} color="#d1d5db" />
      <p className="pu-empty-t">{title}</p>
      {hint && <p className="pu-empty-h">{hint}</p>}
    </div>
  );
}
