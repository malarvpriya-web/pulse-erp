import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import {
  RefreshCw, Download, ChevronDown, ChevronRight, ArrowUp, ArrowDown, Truck,
  Plus, Pencil, FileText, HelpCircle, Activity, Clock, X, Lock,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import { getProject } from '../services/projectsService';

// Canonical Manifest SST/HVDC production pipeline, full lifecycle order. Mirrors
// PRODUCTION_STAGES in the backend deliveryTracker.routes.js and STAGES in
// ProjectPipelineBoard.jsx — keep all three in sync. Legacy values were
// remapped onto this set in migration 20260715000003.
const STAGES = ['created', 'handover', 'dr_approval', 'procurement', 'production', 'clearing', 'dispatched'];
// Manifest project-type categories (mirrors PROJECT_TYPES in the backend deliveryTracker.routes.js).
const PROJECT_TYPES = ['EPC', 'HVDC', 'STATCOM', 'SST', 'AMC', 'Installation', 'Commissioning', 'O&M', 'Supply', 'Turnkey'];
// Product Type is now the product_lines master ("ASTRA - 415V"), loaded from
// /projects/product-lines — not the bare LV/MV/HV class it used to be. The class
// still exists as product_lines.voltage_class and legacy projects fall back to it
// (the grid's product_type column COALESCEs the two). `projects` owns product
// line and the Service Master (IPS) grid inherits it via project_id, so this
// picker is the only place it is set.
const ZONES = ['North', 'South', 'East', 'West', 'Central'];
// Billing basis — persisted to projects.billing_type.
const BILLING_TYPES = [
  { v: 'fixed', l: 'Fixed' },
  { v: 'time_and_material', l: 'Time & Material' },
  { v: 'milestone', l: 'Milestone' },
  { v: 'unit_rate', l: 'Unit Rate' },
  { v: 'cost_plus', l: 'Cost Plus' },
];
const STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'];
const PAGE_SIZES = [10, 20, 50, 100];

const STAGE_COLORS = {
  created:     { bg: '#f3f4f6', color: '#6b7280' },
  handover:    { bg: '#dbeafe', color: '#2563eb' },
  dr_approval: { bg: '#ede9fe', color: '#7c3aed' },
  procurement: { bg: '#fef3c7', color: '#d97706' },
  production:  { bg: '#e0e7ff', color: '#4338ca' },
  clearing:    { bg: '#e0f2fe', color: '#0891b2' },
  dispatched:  { bg: '#d1fae5', color: '#16a34a' },
};
const STATUS_COLORS = {
  'Won':         { bg: '#dbeafe', color: '#2563eb' },
  'In Progress': { bg: '#fef3c7', color: '#d97706' },
  'Delivered':   { bg: '#d1fae5', color: '#16a34a' },
};

const cap = (s) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');

// DD/MM/YYYY — used only for the date-formatted ("Date Excel") export and PDF.
const fmtDMY = (d) => {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, dd] = s.split('-'); return `${dd}/${m}/${y}`; }
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

// Grid columns. `key` maps to the backend SORTABLE whitelist; `sortable:false`
// columns (the expand toggle) never reach the sort query.
const COLS = [
  { key: '_expand',            label: '',                 sortable: false },
  { key: 'ipp',                label: 'IPP' },
  { key: 'ipm',                label: 'IPM' },
  { key: 'description',        label: 'Description' },
  { key: 'customer_name',      label: 'Customer' },
  { key: 'project_type',       label: 'Project Type' },
  { key: 'product_type',       label: 'Product Type' },
  { key: 'zone',               label: 'Zone' },
  { key: 'production_stage',   label: 'Status' },
  { key: 'target_date',        label: 'Target Date' },
  { key: 'forecast_date',      label: 'Forecast Date' },
  { key: 'warranty_start_date', label: 'Warranty Start' },
  { key: 'order_won_date',     label: 'Order Won' },
  { key: 'status',             label: 'Delivery' },
];
const DATE_KEYS = new Set(['target_date', 'forecast_date', 'warranty_start_date', 'order_won_date']);
const EXPORT_COLS = COLS.filter(c => c.key !== '_expand');

const emptyForm = () => ({
  project_code: '', project_name: '', description: '', customer_name: '',
  opportunity_id: '', project_type: 'EPC', product_line_id: '', zone: '', billing_type: 'fixed',
  production_stage: '', status: 'planning', target_date: '', forecast_date: '',
  start_date: new Date().toISOString().slice(0, 10), end_date: '',
  budget_amount: '', project_manager_id: '',
});

export default function ProductionDeliveryTracker({ setPage }) {
  const { hasPermission } = useAuth();
  const canAdd  = hasPermission('projects', 'add');
  const canEdit = hasPermission('projects', 'edit');

  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [toast, setToast]     = useState(null);

  // Pending filter (edited in the panel) vs. applied filter (used by the query).
  // The reference spec wants an explicit Load, not auto-refresh on change.
  const [pendingStages, setPendingStages] = useState([]);
  const [appliedStages, setAppliedStages] = useState([]);
  const [pendingType, setPendingType]     = useState('');
  const [appliedType, setAppliedType]     = useState('');
  const [stageOpen, setStageOpen] = useState(false);

  const [search, setSearch]   = useState('');
  const [sort, setSort]       = useState('order_won_date');
  const [dir, setDir]         = useState('desc');
  const [page, setPage_]      = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [activeRow, setActiveRow] = useState(null);   // project_id of the selected row (Edit/Activity target)
  const [expandedId, setExpandedId] = useState(null); // project_id of the row-expanded row

  // Reference lists for the New/Edit drawer.
  const [opportunities, setOpportunities] = useState([]);
  const [employees, setEmployees]         = useState([]);
  const [productLines, setProductLines]   = useState([]);

  // Drawer (New / Edit).
  const [drawer, setDrawer]     = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]         = useState(emptyForm());
  const [saving, setSaving]     = useState(false);
  const [formError, setFormError] = useState('');

  // Help + Activity modals.
  const [helpOpen, setHelpOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityLogs, setActivityLogs] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');

  const stageBoxRef = useRef(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3200); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, page_size: pageSize, sort, dir };
      if (appliedStages.length) params.status = appliedStages.join(',');
      if (appliedType) params.project_type = appliedType;
      const res = await api.get('/delivery-tracker', { params });
      setRows(Array.isArray(res.data?.data) ? res.data.data : []);
      setTotal(res.data?.total ?? 0);
    } catch { setRows([]); setTotal(0); }
    finally { setLoading(false); }
  }, [appliedStages, appliedType, page, pageSize, sort, dir]);

  useEffect(() => { load(); }, [load]);

  // Reference data for the drawer — fetched once, degrade gracefully on 403.
  useEffect(() => {
    api.get('/projects/employees')
      .then(r => setEmployees(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEmployees([]));
    api.get('/crm/opportunities')
      .then(r => {
        const d = r.data;
        setOpportunities(Array.isArray(d) ? d : Array.isArray(d?.opportunities) ? d.opportunities : Array.isArray(d?.data) ? d.data : []);
      })
      .catch(() => setOpportunities([]));
    api.get('/projects/product-lines')
      .then(r => setProductLines(Array.isArray(r.data) ? r.data : []))
      .catch(() => setProductLines([]));
  }, []);

  // Close the multi-select on outside click.
  useEffect(() => {
    const onClick = (e) => { if (stageBoxRef.current && !stageBoxRef.current.contains(e.target)) setStageOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const toggleStage = (s) =>
    setPendingStages(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);

  const applyFilter = () => {
    setAppliedStages(pendingStages);
    setAppliedType(pendingType);
    setPage_(1);
    setStageOpen(false);
  };

  const recentUpdate = () => { setSort('recent_update'); setDir('desc'); setPage_(1); };

  const toggleSort = (col) => {
    if (!col.sortable && col.sortable !== undefined) return;
    if (col.key === '_expand') return;
    if (sort === col.key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(col.key); setDir('asc'); }
    setPage_(1);
  };

  // Client-side search over the loaded page (server already scoped + paginated).
  const shown = rows.filter(r =>
    !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase())
  );
  const activeRowData = shown.find(r => (r.project_id ?? null) === activeRow) || null;

  // ── Exports ────────────────────────────────────────────────────────────────
  const buildCsv = (dateFmt) => {
    const header = EXPORT_COLS.map(c => c.label);
    const lines = [header.join(',')];
    shown.forEach(r => {
      const cells = EXPORT_COLS.map(c => {
        let v = r[c.key] ?? '';
        if (DATE_KEYS.has(c.key)) v = dateFmt(r[c.key]);
        else if (c.key === 'production_stage') v = cap(r[c.key]);
        const s = String(v).replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
      });
      lines.push(cells.join(','));
    });
    return lines.join('\n');
  };

  const download = (content, ext, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ProjectMaster_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // "Excel" — ISO dates (yyyy-mm-dd). "Date Excel" — DD/MM/YYYY formatted dates.
  const exportExcel     = () => download(buildCsv(d => (d ? String(d).slice(0, 10) : '')), 'csv', 'text/csv;charset=utf-8;');
  const exportDateExcel = () => download(buildCsv(fmtDMY), 'csv', 'text/csv;charset=utf-8;');

  const exportPdf = () => {
    const th = EXPORT_COLS.map(c => `<th>${c.label}</th>`).join('');
    const trs = shown.map(r => {
      const tds = EXPORT_COLS.map(c => {
        let v = r[c.key] ?? '';
        if (DATE_KEYS.has(c.key)) v = fmtDMY(r[c.key]);
        else if (c.key === 'production_stage') v = cap(r[c.key]);
        return `<td>${String(v).replace(/</g, '&lt;')}</td>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to export PDF', 'error'); return; }
    w.document.write(`<!doctype html><html><head><title>Project Master</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1f2937}
        h1{font-size:18px;margin:0 0 4px}p{font-size:12px;color:#6b7280;margin:0 0 16px}
        table{width:100%;border-collapse:collapse;font-size:10px}
        th,td{border:1px solid #e5e7eb;padding:5px 7px;text-align:left;white-space:nowrap}
        th{background:#f3f4f6}
      </style></head><body>
      <h1>Project Master</h1>
      <p>Pursuit (IPM) &rarr; Production (IPP) &middot; ${shown.length} records &middot; ${fmtDMY(new Date())}</p>
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
  };

  // ── New / Edit drawer ───────────────────────────────────────────────────────
  const openNew = async () => {
    const f = emptyForm();
    try { const r = await api.get('/projects/projects/next-code'); f.project_code = r.data?.code || ''; } catch { /* leave blank */ }
    setForm(f);
    setEditingId(null);
    setFormError('');
    setDrawer(true);
  };

  const openEdit = async (row) => {
    if (!row) return;
    setFormError('');
    setEditingId(row.project_id);
    // Prefill from the grid row, then hydrate the fields the grid doesn't carry.
    setForm({
      ...emptyForm(),
      project_code: row.project_code || '',
      project_name: '', description: row.description || '',
      customer_name: row.customer_name || '',
      opportunity_id: row.opportunity_id || '',
      project_type: row.project_type || 'EPC',
      // row.product_type is the resolved display string ("ASTRA - 415V"); the
      // picker binds to the id the grid now returns alongside it.
      product_line_id: row.product_line_id ?? '',
      zone: row.zone || '',
      billing_type: 'fixed',
      production_stage: row.production_stage || '',
      target_date: row.target_date ? String(row.target_date).slice(0, 10) : '',
      forecast_date: row.forecast_date ? String(row.forecast_date).slice(0, 10) : '',
    });
    setDrawer(true);
    try {
      const p = await getProject(row.project_id);
      if (p) setForm(f => ({
        ...f,
        project_name: p.project_name || '',
        status: p.status || 'planning',
        start_date: p.start_date ? String(p.start_date).slice(0, 10) : f.start_date,
        end_date: p.end_date ? String(p.end_date).slice(0, 10) : '',
        budget_amount: p.budget_amount ?? '',
        project_manager_id: p.project_manager_id ?? '',
        description: p.description ?? f.description,
        customer_name: p.customer_name ?? f.customer_name,
        opportunity_id: p.opportunity_id ?? f.opportunity_id,
        project_type: p.project_type ?? f.project_type,
        product_line_id: p.product_line_id ?? f.product_line_id,
        zone: p.zone ?? f.zone,
        billing_type: p.billing_type ?? f.billing_type,
        production_stage: p.production_stage ?? f.production_stage,
        target_date: p.target_date ? String(p.target_date).slice(0, 10) : f.target_date,
        forecast_date: p.forecast_date ? String(p.forecast_date).slice(0, 10) : f.forecast_date,
      }));
    } catch { /* keep the row-derived prefill */ }
  };

  const setF = (k, v) => { setForm(f => ({ ...f, [k]: v })); if (formError) setFormError(''); };

  const buildPayload = () => {
    const nn = (v) => (v === '' || v === undefined ? null : v);
    const p = {
      project_name: form.project_name.trim(),
      description: nn(form.description),
      customer_name: nn(form.customer_name),
      opportunity_id: nn(form.opportunity_id),
      project_type: nn(form.project_type),
      // product_line_id supersedes the legacy product_type class; reads COALESCE
      // the two, so nothing writes product_type from here any more.
      product_line_id: nn(form.product_line_id),
      zone: nn(form.zone),
      billing_type: nn(form.billing_type),
      production_stage: nn(form.production_stage),
      status: form.status || 'planning',
      target_date: nn(form.target_date),
      forecast_date: nn(form.forecast_date),
      start_date: nn(form.start_date),
      end_date: nn(form.end_date),
      budget_amount: nn(form.budget_amount),
      project_manager_id: nn(form.project_manager_id),
    };
    if (!editingId) p.project_code = form.project_code; // create only
    return p;
  };

  const handleSubmit = async () => {
    if (!form.project_name.trim()) { setFormError('Project name is required.'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (editingId) await api.put(`/projects/projects/${editingId}`, buildPayload());
      else           await api.post('/projects/projects', buildPayload());
      setDrawer(false);
      showToast(editingId ? 'Project updated' : 'Project created');
      load();
    } catch (err) {
      const d = err?.response?.data;
      setFormError(d?.errors?.[0]?.message || d?.error || d?.message || 'Save failed. Please try again.');
    } finally { setSaving(false); }
  };

  // ── Activity log ────────────────────────────────────────────────────────────
  const openActivity = async () => {
    if (!activeRowData) return;
    setActivityOpen(true);
    setActivityLoading(true);
    setActivityError('');
    setActivityLogs([]);
    try {
      const r = await api.get(`/audit/reference/${activeRow}/project`);
      const logs = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.logs) ? r.data.logs : [];
      setActivityLogs(logs);
    } catch (err) {
      setActivityError(err?.response?.status === 403
        ? 'Activity log is limited to admin, HR and manager roles.'
        : (err?.response?.data?.error || 'Could not load activity.'));
    } finally { setActivityLoading(false); }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const linkStyle = { color: '#6B3FDB', fontWeight: 600, cursor: 'pointer', textDecoration: 'none' };
  const inputStyle = { padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' };
  const toolBtn = { ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--color-text-secondary)' };
  const primaryBtn = { padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 };
  const disBtn = (base) => ({ ...base, opacity: 0.45, cursor: 'not-allowed' });

  const fieldLbl = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 };
  const fieldInput = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' };

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} } @keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {toast && (
        <div style={{ position: 'fixed', top: 18, right: 18, zIndex: 60, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,0.16)', background: toast.type === 'error' ? '#dc2626' : '#16a34a' }}>
          {toast.msg}
        </div>
      )}

      {/* Header + primary actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Project Master</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Pursuit (IPM) to production (IPP) — single source of truth for the delivery record</p>
        </div>

        {canAdd
          ? <button onClick={openNew} style={primaryBtn}><Plus size={14} /> New</button>
          : <button disabled title="You don't have permission to create projects" style={disBtn(primaryBtn)}><Lock size={13} /> New</button>}
        {canEdit
          ? <button onClick={() => openEdit(activeRowData)} disabled={!activeRowData} title={activeRowData ? 'Edit selected project' : 'Select a row to edit'} style={activeRowData ? { ...primaryBtn, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', border: '0.5px solid var(--color-border-tertiary)' } : disBtn(toolBtn)}><Pencil size={14} /> Edit</button>
          : <button disabled title="You don't have permission to edit projects" style={disBtn(toolBtn)}><Lock size={13} /> Edit</button>}
        <button onClick={openActivity} disabled={!activeRowData} title={activeRowData ? 'View activity log' : 'Select a row to view activity'} style={activeRowData ? toolBtn : disBtn(toolBtn)}><Activity size={14} /> Activity</button>
        <button onClick={() => setHelpOpen(true)} title="Help" style={toolBtn}><HelpCircle size={14} /> Help</button>
      </div>

      {/* Filter panel */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {/* Status multi-select */}
        <div ref={stageBoxRef} style={{ position: 'relative' }}>
          <button onClick={() => setStageOpen(o => !o)} style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 150 }}>
            <span style={{ flex: 1, textAlign: 'left' }}>{pendingStages.length ? `${pendingStages.length} selected` : 'All Statuses'}</span>
            <ChevronDown size={14} />
          </button>
          {stageOpen && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 30, minWidth: 190, padding: 6 }}>
              {STAGES.map(s => (
                <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 13, cursor: 'pointer', borderRadius: 6, color: 'var(--color-text-primary)' }}>
                  <input type="checkbox" checked={pendingStages.includes(s)} onChange={() => toggleStage(s)} />
                  {cap(s)}
                </label>
              ))}
              {pendingStages.length > 0 && (
                <button onClick={() => setPendingStages([])} style={{ width: '100%', marginTop: 4, padding: '5px 0', border: 'none', background: 'none', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' }}>Clear</button>
              )}
            </div>
          )}
        </div>

        {/* Project type */}
        <select value={pendingType} onChange={e => setPendingType(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="">All Project Types</option>
          {PROJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <button onClick={applyFilter} style={{ ...primaryBtn, padding: '7px 18px' }}>Load</button>
        <button onClick={recentUpdate} title="Sort by most recently updated" style={toolBtn}><Clock size={14} /> Recent Update</button>

        <div style={{ flex: 1 }} />

        {/* Grid toolbar */}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" style={{ ...inputStyle, width: 150 }} />
        <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage_(1); }} style={inputStyle}>
          {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <button onClick={exportDateExcel} title="Export with DD/MM/YYYY dates" style={toolBtn}><Download size={14} /> Date Excel</button>
        <button onClick={exportExcel} title="Export to Excel (CSV)" style={toolBtn}><Download size={14} /> Excel</button>
        <button onClick={exportPdf} title="Export to PDF" style={toolBtn}><FileText size={14} /> PDF</button>
        <button onClick={load} title="Refresh" style={toolBtn}><RefreshCw size={14} /></button>
      </div>

      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          [1, 2, 3, 4].map(i => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
              {[30, 80, 80, 140, 110, 80, 70, 70, 90, 80, 80, 80].map((w, j) => (
                <div key={j} style={{ height: 14, width: w, background: 'var(--color-background-secondary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ))
        ) : shown.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '56px 24px', textAlign: 'center' }}>
            <Truck size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
            <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No projects to show</p>
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>Create a project, or link one to a pursuit to see it here.</p>
            {canAdd && <button onClick={openNew} style={primaryBtn}><Plus size={14} /> New</button>}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--color-background-secondary)' }}>
                  {COLS.map(c => (
                    <th key={c.key} onClick={() => toggleSort(c)}
                      style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap', cursor: c.key === '_expand' ? 'default' : 'pointer', userSelect: 'none' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {c.label}
                        {sort === c.key && (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const id = r.project_id ?? i;
                  const isActive = activeRow === id;
                  const isOpen = expandedId === id;
                  const stg = STAGE_COLORS[r.production_stage] || {};
                  const stc = STATUS_COLORS[r.status] || {};
                  return (
                    <Fragment key={id}>
                      <tr onClick={() => setActiveRow(id)}
                        style={{ borderBottom: isOpen ? 'none' : '0.5px solid var(--color-border-tertiary)', background: isActive ? 'rgba(107,63,219,0.06)' : 'transparent', cursor: 'pointer' }}>
                        <td style={{ padding: '10px 8px 10px 12px' }}>
                          <button onClick={(e) => { e.stopPropagation(); setExpandedId(isOpen ? null : id); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', padding: 0 }} title={isOpen ? 'Collapse' : 'Expand'}>
                            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                          {r.ipp
                            ? <a style={linkStyle} onClick={(e) => { e.stopPropagation(); setPage && setPage('ProjectDetail', { id: r.project_id }); }}>{r.ipp}</a>
                            : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}
                        </td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                          {r.ipm
                            ? <a style={linkStyle} onClick={(e) => { e.stopPropagation(); setPage && setPage('OpportunitiesKanban', { id: r.opportunity_id }); }}>{r.ipm}</a>
                            : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-primary)', fontWeight: 500, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description || ''}>{r.description || '—'}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-primary)' }}>{r.customer_name || '—'}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{r.project_type || '—'}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{r.product_type || '—'}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{r.zone || '—'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          {r.production_stage
                            ? <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: stg.bg, color: stg.color }}>{cap(r.production_stage)}</span>
                            : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(r.target_date)}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(r.forecast_date)}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(r.warranty_start_date)}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(r.order_won_date)}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: stc.bg, color: stc.color, whiteSpace: 'nowrap' }}>{r.status || '—'}</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>
                          <td colSpan={COLS.length} style={{ padding: '12px 20px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px 24px', fontSize: 12.5 }}>
                              <Detail label="Project Code" value={r.project_code} />
                              <Detail label="IPP" value={r.ipp} />
                              <Detail label="IPM (Pursuit)" value={r.ipm} />
                              <Detail label="Description" value={r.description} />
                              <Detail label="Customer" value={r.customer_name} />
                              <Detail label="Project Type" value={r.project_type} />
                              <Detail label="Product Type" value={r.product_type} />
                              <Detail label="Zone" value={r.zone} />
                              <Detail label="Production Stage" value={cap(r.production_stage)} />
                              <Detail label="Target Date" value={fmtDate(r.target_date)} />
                              <Detail label="Forecast Date" value={fmtDate(r.forecast_date)} />
                              <Detail label="Warranty Start" value={fmtDate(r.warranty_start_date)} />
                              <Detail label="Order Won Date" value={fmtDate(r.order_won_date)} />
                              <Detail label="Last Updated" value={fmtDate(r.updated_at)} />
                            </div>
                            {canEdit && (
                              <button onClick={(e) => { e.stopPropagation(); setActiveRow(id); openEdit(r); }} style={{ ...primaryBtn, marginTop: 12, padding: '6px 14px', fontSize: 12 }}><Pencil size={12} /> Edit this project</button>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <span>{total} records · Page {page} of {totalPages}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage_(p => Math.max(1, p - 1))} disabled={page === 1}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === 1 ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === 1 ? 0.5 : 1, fontSize: 13 }}>Prev</button>
            <button onClick={() => setPage_(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === totalPages ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === totalPages ? 0.5 : 1, fontSize: 13 }}>Next</button>
          </div>
        </div>
      )}

      {/* New / Edit drawer */}
      {drawer && (
        <>
          <div onClick={() => setDrawer(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 460, maxWidth: '92vw', background: 'var(--color-background-primary)', borderLeft: '0.5px solid var(--color-border-tertiary)', zIndex: 50, padding: 24, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <h3 style={{ margin: 0, color: 'var(--color-text-primary)', fontSize: 17 }}>{editingId ? 'Edit Project' : 'New Project'}</h3>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={20} /></button>
            </div>

            {formError && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: '#b91c1c', fontSize: 12.5 }}>{formError}</div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={fieldLbl}>Project Code</label>
                <input value={form.project_code} readOnly style={{ ...fieldInput, background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)' }} />
              </div>
              <div>
                <label style={fieldLbl}>Project Name *</label>
                <input value={form.project_name} onChange={e => setF('project_name', e.target.value)} placeholder="Project name…" style={fieldInput} />
              </div>
              <div>
                <label style={fieldLbl}>Description (product code)</label>
                <input value={form.description} onChange={e => setF('description', e.target.value)} placeholder="e.g. ASTRA-60A-415V" style={fieldInput} />
              </div>
              <div>
                <label style={fieldLbl}>IPM (Pursuit)</label>
                <select value={form.opportunity_id} onChange={e => setF('opportunity_id', e.target.value)} style={fieldInput}>
                  <option value="">— None —</option>
                  {opportunities.map(o => (
                    <option key={o.id} value={o.id}>{o.opportunity_number ? `${o.opportunity_number} — ` : ''}{o.opportunity_name || o.name || `Opportunity ${o.id}`}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={fieldLbl}>Customer</label>
                  <input value={form.customer_name} onChange={e => setF('customer_name', e.target.value)} placeholder="Customer…" style={fieldInput} />
                </div>
                <div>
                  <label style={fieldLbl}>Project Type</label>
                  <select value={form.project_type} onChange={e => setF('project_type', e.target.value)} style={fieldInput}>
                    {PROJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={fieldLbl}>Product Type</label>
                  <select value={form.product_line_id} onChange={e => setF('product_line_id', e.target.value)} style={fieldInput}>
                    <option value="">— Select —</option>
                    {productLines.map(pl => (
                      <option key={pl.id} value={pl.id}>{pl.display_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={fieldLbl}>Zone</label>
                  <select value={form.zone} onChange={e => setF('zone', e.target.value)} style={fieldInput}>
                    <option value="">— Select —</option>
                    {ZONES.map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label style={fieldLbl}>Billing Type</label>
                <select value={form.billing_type} onChange={e => setF('billing_type', e.target.value)} style={fieldInput}>
                  {BILLING_TYPES.map(b => <option key={b.v} value={b.v}>{b.l}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={fieldLbl}>Production Stage</label>
                  <select value={form.production_stage} onChange={e => setF('production_stage', e.target.value)} style={fieldInput}>
                    <option value="">— Select —</option>
                    {STAGES.map(s => <option key={s} value={s}>{cap(s)}</option>)}
                  </select>
                </div>
                <div>
                  <label style={fieldLbl}>Status</label>
                  <select value={form.status} onChange={e => setF('status', e.target.value)} style={fieldInput}>
                    {STATUSES.map(s => <option key={s} value={s}>{cap(s)}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={fieldLbl}>Target Date</label>
                  <input type="date" value={form.target_date} onChange={e => setF('target_date', e.target.value)} style={fieldInput} />
                </div>
                <div>
                  <label style={fieldLbl}>Forecast Date</label>
                  <input type="date" value={form.forecast_date} onChange={e => setF('forecast_date', e.target.value)} style={fieldInput} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={fieldLbl}>Start Date</label>
                  <input type="date" value={form.start_date} onChange={e => setF('start_date', e.target.value)} style={fieldInput} />
                </div>
                <div>
                  <label style={fieldLbl}>End Date</label>
                  <input type="date" value={form.end_date} onChange={e => setF('end_date', e.target.value)} style={fieldInput} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={fieldLbl}>Budget (₹)</label>
                  <input type="number" value={form.budget_amount} onChange={e => setF('budget_amount', e.target.value)} placeholder="0" style={fieldInput} />
                </div>
                <div>
                  <label style={fieldLbl}>Project Manager</label>
                  <select value={form.project_manager_id} onChange={e => setF('project_manager_id', e.target.value)} style={fieldInput}>
                    <option value="">— Select —</option>
                    {employees.map(emp => <option key={emp.id} value={emp.id}>{`${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.name || `#${emp.id}`}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button onClick={handleSubmit} disabled={saving} style={{ ...primaryBtn, flex: 1, justifyContent: 'center' }}>{saving ? 'Saving…' : (editingId ? 'Save Changes' : 'Create Project')}</button>
              <button onClick={() => setDrawer(false)} style={{ flex: 1, padding: '9px 0', background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        </>
      )}

      {/* Help modal */}
      {helpOpen && (
        <>
          <div onClick={() => setHelpOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 24, zIndex: 50, width: 480, maxWidth: '92vw', maxHeight: '82vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Project Master — Help</h3>
              <button onClick={() => setHelpOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={18} /></button>
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 10px' }}>This grid is the single source of truth for the production/delivery record. Each row is an <b>IPP</b> project, optionally linked back to the originating <b>IPM</b> pursuit.</p>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                <li><b>Status</b> multi-select + <b>Project Type</b> filter the grid; press <b>Load</b> to apply.</li>
                <li><b>Recent Update</b> orders by the most recently changed project.</li>
                <li><b>New</b> / <b>Edit</b> create and maintain the project record. Select a row first to Edit.</li>
                <li><b>Activity</b> shows the audit trail for the selected project (admin/HR/manager).</li>
                <li><b>Date Excel</b> exports with DD/MM/YYYY dates; <b>Excel</b> uses ISO dates; <b>PDF</b> prints the grid.</li>
                <li>Click the <b>chevron</b> to expand a row for the full record.</li>
              </ul>
              <p style={{ margin: 0 }}>Production stages: {STAGES.map(cap).join(' → ')}.</p>
            </div>
          </div>
        </>
      )}

      {/* Activity modal */}
      {activityOpen && (
        <>
          <div onClick={() => setActivityOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 24, zIndex: 50, width: 520, maxWidth: '92vw', maxHeight: '82vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Activity — {activeRowData?.ipp || 'Project'}</h3>
              <button onClick={() => setActivityOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={18} /></button>
            </div>
            {activityLoading ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--color-text-secondary)' }}><RefreshCw size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
            ) : activityError ? (
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>{activityError}</p>
            ) : activityLogs.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>No activity recorded for this project yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activityLogs.map((l, i) => (
                  <div key={l.id ?? i} style={{ display: 'flex', gap: 10, paddingBottom: 10, borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: '#6B3FDB', marginTop: 5, flexShrink: 0 }} />
                    <div style={{ fontSize: 12.5 }}>
                      <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{cap(l.action_type || l.action || 'update')} {l.user_name ? `· ${l.user_name}` : ''}</div>
                      <div style={{ color: 'var(--color-text-secondary)' }}>{formatWhen(l.created_at || l.timestamp)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{label}</div>
      <div style={{ color: 'var(--color-text-primary)' }}>{value || '—'}</div>
    </div>
  );
}

function formatWhen(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return `${fmtDate(d)} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}
