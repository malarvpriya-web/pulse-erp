/**
 * ServiceMasterIPS.jsx — the Service Master (IPS) grid.
 *
 * Phase 4 of the build in SERVICE_MASTER_IPS_AUDIT.md. Reads /servicedesk/ips
 * (grid + filters + widgets + issue-category taxonomy).
 *
 * Field-service tickets only (support_tickets.ticket_kind='service'). The
 * internal IT/HR helpdesk over the same table keeps its own grid, AllTickets.jsx.
 *
 * IPP / Sitename / Product Type are INHERITED from the linked project and are
 * therefore read-only here — they are set on the project, in Project Master.
 * Type and Region are per-ticket: an EPC project can raise a Commissioning ticket.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Pencil, Download, FileText, Search, X, Clock, SlidersHorizontal,
  Tags, ArrowUp, ArrowDown, Trash2, AlertCircle,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import { VizCard, Donut, DonutLegend, HBarList } from '@/components/charts/PulseViz';
import ConfirmDialog from '@/components/core/ConfirmDialog';

/**
 * Categorical order re-stepped off PULSE_SERIES so purple and blue are never
 * adjacent: the kit's default order puts #6B3FDB next to #2563eb, which measures
 * ΔE 3.2 under deuteranopia and 10.4 for NORMAL vision — below the 15 floor, i.e.
 * hard to tell apart even with full colour vision. This order passes the
 * lightness, chroma, CVD and normal-vision checks. Every chart below also carries
 * visible value labels, which is what the sub-3:1 contrast warning requires.
 * Colour follows the entity (a zone, a status), never its rank.
 */
const IPS_SERIES = ['#6B3FDB', '#10b981', '#f59e0b', '#2563eb', '#ef4444', '#14b8a6'];
const OPENED_COLOR = '#6B3FDB';
const CLOSED_COLOR = '#f59e0b';

// Lifecycle order — the status bar reads as a pipeline, so Open sits left of
// Closed regardless of volume. Mirrors TICKET_STATUSES in ips.routes.js.
const STATUS_ORDER = ['Open', 'Analysis', 'In Progress', 'Pending', 'Resolved', 'Closed'];

/**
 * Status colour is assigned EXPLICITLY, not by indexing IPS_SERIES: indexing put
 * red on "Resolved", and red reads as failure on what is the good outcome.
 * Green is the resolved state; red marks Pending (blocked, waiting on someone).
 *
 * This order passes the adjacent-pair checks (worst: #10b981↔#ef4444 ΔE 8.1
 * deutan, 24.9 normal). Under the stricter --pairs all it flags purple↔blue and
 * green↔teal as look-alikes — they are never adjacent in the bar, and every
 * segment carries a legend dot + name + count, so identity never rests on colour.
 */
const STATUS_COLOR = {
  'Open':        '#6B3FDB', // purple — new
  'Analysis':    '#f59e0b', // amber  — being worked out
  'In Progress': '#14b8a6', // teal   — active
  'Pending':     '#ef4444', // red    — blocked
  'Resolved':    '#10b981', // green  — good outcome
  'Closed':      '#2563eb', // blue   — terminal / archived
};

const COLS = [
  { key: 'ips_id',       label: 'IPS ID' },
  { key: 'sitename',     label: 'Sitename' },
  { key: 'description',  label: 'Description' },
  { key: 'status',       label: 'Status' },
  { key: 'region',       label: 'Region' },
  { key: 'days_open',    label: 'Days Open' },
  { key: 'ipp',          label: 'IPP' },
  { key: 'type',         label: 'Type' },
  { key: 'product_type', label: 'Product Type' },
];
const PAGE_SIZES = [10, 20, 50, 100];
const emptyForm = () => ({
  title: '', description: '', project_id: '', zone: '', service_type: '',
  issue_category_id: '', priority: 'Medium', status: 'Open', serial_number: '',
});

export default function ServiceMasterIPS() {
  const { hasPermission } = useAuth();
  const canAdd  = hasPermission('servicedesk', 'add');
  const canEdit = hasPermission('servicedesk', 'edit');

  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [widgets, setWidgets] = useState(null);
  const [opts, setOpts]       = useState({ statuses: [], zones: [], service_types: [], categories: [], projects: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort]         = useState('created_at');
  const [dir, setDir]           = useState('desc');
  const [search, setSearch]     = useState('');

  // Pending vs applied: the Filter panel only takes effect on Apply, so the grid
  // and its widgets never re-fetch on every keystroke.
  const [filterOpen, setFilterOpen] = useState(false);
  const [pending, setPending] = useState({ status: '', zone: '', service_type: '', category: '', project_id: '' });
  const [applied, setApplied] = useState({ status: '', zone: '', service_type: '', category: '', project_id: '' });

  const [drawer, setDrawer]       = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]           = useState(emptyForm());
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');

  const [catOpen, setCatOpen]   = useState(false);
  const [cats, setCats]         = useState([]);
  const [catForm, setCatForm]   = useState({ name: '', category_code: '', description: '' });
  const [catEditId, setCatEditId] = useState(null);
  const [catBusy, setCatBusy]   = useState(false);
  const [catError, setCatError] = useState('');
  const [confirmCat, setConfirmCat] = useState(null);

  const [toast, setToast] = useState(null);
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3200); };

  const params = useMemo(() => {
    const p = { page, page_size: pageSize, sort, dir };
    if (search) p.search = search;
    Object.entries(applied).forEach(([k, v]) => { if (v) p[k] = v; });
    return p;
  }, [page, pageSize, sort, dir, search, applied]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [g, w] = await Promise.all([
        api.get('/servicedesk/ips', { params }),
        api.get('/servicedesk/ips/widgets', { params }),
      ]);
      setRows(Array.isArray(g.data?.data) ? g.data.data : []);
      setTotal(g.data?.total ?? 0);
      setWidgets(w.data ?? null);
    } catch (e) {
      setRows([]); setTotal(0); setWidgets(null);
      setError(e?.response?.data?.error || 'Could not load service tickets.');
    } finally { setLoading(false); }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/servicedesk/ips/filters')
      .then(r => setOpts(r.data ?? {}))
      .catch(() => { /* filters degrade to empty selects */ });
  }, []);

  const loadCats = () => api.get('/servicedesk/ips/categories')
    .then(r => setCats(Array.isArray(r.data) ? r.data : []))
    .catch(() => setCats([]));

  // ── sorting ────────────────────────────────────────────────────────────────
  const toggleSort = (key) => {
    if (sort === key) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir('asc'); }
    setPage(1);
  };
  const recentUpdate = () => { setSort('created_at'); setDir('desc'); setPage(1); };

  const applyFilter = () => { setApplied(pending); setPage(1); setFilterOpen(false); };
  const clearFilter = () => {
    const blank = { status: '', zone: '', service_type: '', category: '', project_id: '' };
    setPending(blank); setApplied(blank); setPage(1);
  };
  const activeFilters = Object.values(applied).filter(Boolean).length;

  // ── exports ────────────────────────────────────────────────────────────────
  // Exports the loaded page, matching what the user is looking at.
  const buildCsv = () => {
    const lines = [COLS.map(c => c.label).join(',')];
    rows.forEach(r => {
      lines.push(COLS.map(c => {
        const s = String(r[c.key] ?? '').replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
      }).join(','));
    });
    return lines.join('\n');
  };
  const download = (content, ext, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ServiceMaster_IPS_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportExcel = () => download(buildCsv(), 'csv', 'text/csv;charset=utf-8;');
  const exportPdf = () => {
    const th = COLS.map(c => `<th>${c.label}</th>`).join('');
    const trs = rows.map(r => `<tr>${COLS.map(c =>
      `<td>${String(r[c.key] ?? '').replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to export PDF', 'error'); return; }
    w.document.write(`<!doctype html><html><head><title>Service Master (IPS)</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1f2937}
        h1{font-size:18px;margin:0 0 4px}p{font-size:12px;color:#6b7280;margin:0 0 16px}
        table{width:100%;border-collapse:collapse;font-size:10px}
        th,td{border:1px solid #e5e7eb;padding:5px 7px;text-align:left;white-space:nowrap}
        th{background:#f3f4f6}
      </style></head><body>
      <h1>Service Master (IPS)</h1>
      <p>Field service tickets &middot; ${rows.length} of ${total} records &middot; ${fmtDate(new Date())}</p>
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
  };

  // ── new / edit ─────────────────────────────────────────────────────────────
  const openNew = () => { setEditingId(null); setForm(emptyForm()); setFormError(''); setDrawer(true); };
  const openEdit = (r) => {
    setEditingId(r.id);
    setForm({
      title: r.title ?? '', description: r.description ?? '',
      project_id: r.project_id ?? '', zone: r.region ?? '', service_type: r.type ?? '',
      issue_category_id: '', priority: r.priority ?? 'Medium',
      status: r.status ?? 'Open', serial_number: '',
    });
    setFormError(''); setDrawer(true);
  };

  const save = async () => {
    if (!form.title.trim()) { setFormError('Title is required.'); return; }
    setSaving(true); setFormError('');
    const nn = (v) => (v === '' || v === undefined ? null : v);
    const payload = {
      ticket_kind: 'service',
      title: form.title.trim(),
      description: nn(form.description),
      project_id: nn(form.project_id),
      zone: nn(form.zone),
      service_type: nn(form.service_type),
      issue_category_id: nn(form.issue_category_id),
      priority: form.priority,
      serial_number: nn(form.serial_number),
    };
    try {
      if (editingId) await api.put(`/servicedesk/tickets/${editingId}`, { ...payload, status: form.status });
      else await api.post('/servicedesk/tickets', payload);
      showToast(editingId ? 'Ticket updated' : 'Ticket created');
      setDrawer(false);
      load();
    } catch (e) {
      setFormError(e?.response?.data?.error || 'Could not save the ticket.');
    } finally { setSaving(false); }
  };

  // ── categories ─────────────────────────────────────────────────────────────
  const openCats = () => { setCatOpen(true); setCatError(''); setCatForm({ name: '', category_code: '', description: '' }); setCatEditId(null); loadCats(); };
  const saveCat = async () => {
    if (!catForm.name.trim()) { setCatError('Name is required.'); return; }
    setCatBusy(true); setCatError('');
    try {
      if (catEditId) await api.put(`/servicedesk/ips/categories/${catEditId}`, catForm);
      else await api.post('/servicedesk/ips/categories', catForm);
      setCatForm({ name: '', category_code: '', description: '' });
      setCatEditId(null);
      loadCats();
    } catch (e) {
      setCatError(e?.response?.data?.error || 'Could not save the category.');
    } finally { setCatBusy(false); }
  };
  const removeCat = async () => {
    const c = confirmCat; setConfirmCat(null);
    try { await api.delete(`/servicedesk/ips/categories/${c.id}`); loadCats(); showToast('Category removed'); }
    catch { showToast('Could not remove the category', 'error'); }
  };

  // ── styles (match Project Master) ──────────────────────────────────────────
  const inputStyle = { padding: '7px 12px', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 7, fontSize: 13, background: '#fff', outline: 'none' };
  const toolBtn    = { ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--color-text-secondary, #6b7280)' };
  const primaryBtn = { padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 };
  const fieldLbl   = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
  const fieldInput = { ...inputStyle, width: '100%', boxSizing: 'border-box' };
  const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' };
  const td = { padding: '10px 12px', color: 'var(--color-text-secondary, #6b7280)' };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const statusTotal = (widgets?.by_status ?? []).reduce((s, d) => s + d.value, 0);

  return (
    <div className="pulse-page" style={{ padding: 24, background: 'var(--color-bg-page, #f8f9fc)', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!confirmCat}
        title="Remove category"
        message={`Remove "${confirmCat?.name ?? 'this category'}"?${confirmCat?.ticket_count ? ` ${confirmCat.ticket_count} ticket(s) reference it and will keep their history.` : ''}`}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={removeCat}
        onCancel={() => setConfirmCat(null)}
      />

      {toast && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13,
          background: toast.type === 'success' ? '#d1fae5' : '#fee2e2', color: toast.type === 'success' ? '#065f46' : '#991b1b' }}>
          {toast.msg}
        </div>
      )}

      {/* ── header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Service Master</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Field service tickets (IPS) &middot; {total} record{total === 1 ? '' : 's'}
          </p>
        </div>
        {canAdd && <button onClick={openNew} style={primaryBtn}><Plus size={15} /> New</button>}
      </div>

      {/* ── toolbar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => setFilterOpen(o => !o)} style={{ ...toolBtn, borderColor: activeFilters ? '#6B3FDB' : undefined, color: activeFilters ? '#6B3FDB' : toolBtn.color }}>
          <SlidersHorizontal size={14} /> Filter{activeFilters ? ` (${activeFilters})` : ''}
        </button>
        <button onClick={recentUpdate} title="Sort by most recently raised" style={toolBtn}><Clock size={14} /> Recent Update</button>
        <button onClick={openCats} style={toolBtn}><Tags size={14} /> Categories of Issues</button>

        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search IPS ID, site, description, IPP…"
            style={{ ...inputStyle, width: '100%', paddingLeft: 32, boxSizing: 'border-box' }}
          />
        </div>

        <button onClick={exportExcel} title="Export to Excel (CSV)" style={toolBtn}><Download size={14} /> Excel</button>
        <button onClick={exportPdf} title="Export to PDF" style={toolBtn}><FileText size={14} /> PDF</button>
        <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }} style={inputStyle}>
          {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>

      {/* ── filter panel ── */}
      {filterOpen && (
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 16, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, alignItems: 'end' }}>
          {[
            ['status', 'Status', opts.statuses],
            ['zone', 'Region', opts.zones],
            ['service_type', 'Type', opts.service_types],
            ['category', 'Category', opts.categories],
          ].map(([key, label, list]) => (
            <div key={key}>
              <label style={fieldLbl}>{label}</label>
              <select value={pending[key]} onChange={e => setPending(p => ({ ...p, [key]: e.target.value }))} style={fieldInput}>
                <option value="">All</option>
                {(list ?? []).map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          ))}
          <div>
            <label style={fieldLbl}>IPP</label>
            <select value={pending.project_id} onChange={e => setPending(p => ({ ...p, project_id: e.target.value }))} style={fieldInput}>
              <option value="">All</option>
              {(opts.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.project_number}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={applyFilter} style={primaryBtn}>Apply</button>
            <button onClick={clearFilter} style={toolBtn}>Clear</button>
          </div>
        </div>
      )}

      {/* ── widgets ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 16, marginBottom: 16 }}>
        <VizCard title="Issues progress" subtitle="Opened vs closed, last 12 months" loading={loading} empty={!widgets?.progress?.length}>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={widgets?.progress ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eceafb" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} width={32} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {/* Two co-equal series, so both are solid 2px and both are named in
                  the legend — identity is never carried by colour alone. */}
              <Line type="monotone" dataKey="opened" name="Opened" stroke={OPENED_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
              <Line type="monotone" dataKey="closed" name="Closed" stroke={CLOSED_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
            </LineChart>
          </ResponsiveContainer>
        </VizCard>

        <VizCard title="Issue by zone" subtitle="Regional split" loading={loading} empty={!widgets?.by_zone?.length}>
          <Donut data={widgets?.by_zone ?? []} height={168} centerLabel="tickets" colors={IPS_SERIES} />
          <DonutLegend data={widgets?.by_zone ?? []} colors={IPS_SERIES} />
        </VizCard>

        <VizCard title="Issue by category" subtitle="Ticket count" loading={loading} empty={!widgets?.by_category?.length}>
          <HBarList data={widgets?.by_category ?? []} max={6} />
        </VizCard>

        <VizCard title="Issue by status" subtitle="Pipeline" loading={loading} empty={!statusTotal}>
          <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden', gap: 2, marginTop: 4 }}>
            {(widgets?.by_status ?? []).map(d => (
              <div key={d.name}
                title={`${d.name}: ${d.value}`}
                style={{ width: `${(d.value / statusTotal) * 100}%`, background: STATUS_COLOR[d.name] ?? '#9ca3af' }} />
            ))}
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {(widgets?.by_status ?? []).map(d => (
              <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: STATUS_COLOR[d.name] ?? '#9ca3af', flexShrink: 0 }} />
                <span style={{ color: '#374151', flex: 1 }}>{d.name}</span>
                <span style={{ color: '#6b7280', fontWeight: 600 }}>{d.value}</span>
              </div>
            ))}
          </div>
        </VizCard>
      </div>

      {/* ── grid ── */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {error ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#991b1b' }}>
            <AlertCircle size={30} style={{ display: 'block', margin: '0 auto 10px' }} />
            <p style={{ margin: '0 0 10px', fontWeight: 600 }}>{error}</p>
            <button onClick={load} style={{ ...toolBtn, margin: '0 auto' }}>Retry</button>
          </div>
        ) : loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No service tickets found</p>
            <p style={{ margin: 0, fontSize: 12 }}>
              {activeFilters || search ? 'Try clearing the filters.' : 'Raise one with New.'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {COLS.map(c => (
                    <th key={c.key} style={th} onClick={() => toggleSort(c.key)} title={`Sort by ${c.label}`}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {c.label}
                        {sort === c.key && (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      </span>
                    </th>
                  ))}
                  {canEdit && <th style={{ ...th, cursor: 'default' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ ...td, fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{r.ips_id}</td>
                    <td style={td}>{r.sitename ?? '—'}</td>
                    <td style={{ ...td, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description ?? ''}>
                      {r.description ?? '—'}
                    </td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, fontSize: 11 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLOR[r.status] ?? '#9ca3af' }} />
                        {r.status}
                      </span>
                    </td>
                    <td style={td}>{r.region ?? '—'}</td>
                    <td style={{ ...td, fontWeight: 600, color: '#374151' }}>{r.days_open ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.ipp ?? '—'}</td>
                    <td style={td}>{r.type ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.product_type ?? '—'}</td>
                    {canEdit && (
                      <td style={td}>
                        <button onClick={() => openEdit(r)} title="Edit"
                          style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#6B3FDB' }}>
                          <Pencil size={13} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── pagination ── */}
      {!loading && !error && total > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 13, color: '#6b7280' }}>
          <span>Page {page} of {totalPages} &middot; {total} record{total === 1 ? '' : 's'}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={{ ...toolBtn, opacity: page <= 1 ? 0.5 : 1 }}>Previous</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={{ ...toolBtn, opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
          </div>
        </div>
      )}

      {/* ── new / edit drawer ── */}
      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 560, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>{editingId ? 'Edit Service Ticket' : 'New Service Ticket'}</h2>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            {formError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{formError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Title *</label>
                <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={fieldInput} placeholder="e.g. Erection support & Commissioning" />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Description</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2}
                  style={{ ...fieldInput, resize: 'vertical' }} />
              </div>
              <div>
                <label style={fieldLbl}>IPP (project)</label>
                <select value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={fieldInput}>
                  <option value="">— None —</option>
                  {(opts.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.project_number} — {p.project_name}</option>)}
                </select>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>Sitename and Product Type come from the project.</p>
              </div>
              <div>
                <label style={fieldLbl}>Type</label>
                <select value={form.service_type} onChange={e => setForm(f => ({ ...f, service_type: e.target.value }))} style={fieldInput}>
                  <option value="">— Select —</option>
                  {(opts.service_types ?? []).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLbl}>Region</label>
                <select value={form.zone} onChange={e => setForm(f => ({ ...f, zone: e.target.value }))} style={fieldInput}>
                  <option value="">— Select —</option>
                  {(opts.zones ?? []).map(z => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLbl}>Priority</label>
                <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} style={fieldInput}>
                  {['Low', 'Medium', 'High', 'Critical'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {editingId && (
                <div>
                  <label style={fieldLbl}>Status</label>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={fieldInput}>
                    {(opts.statuses ?? STATUS_ORDER).map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label style={fieldLbl}>Serial number</label>
                <input value={form.serial_number} onChange={e => setForm(f => ({ ...f, serial_number: e.target.value }))} style={fieldInput} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
              <button onClick={() => setDrawer(false)} style={toolBtn}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Ticket'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── categories of issues ── */}
      {catOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 560, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>Categories of Issues</h2>
              <button onClick={() => setCatOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 18px' }}>
              Your own issue taxonomy. Tickets keep any older free-text category until they are re-filed here.
            </p>
            {catError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{catError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 10, alignItems: 'end', marginBottom: 18 }}>
              <div>
                <label style={fieldLbl}>Name *</label>
                <input value={catForm.name} onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))} style={fieldInput} placeholder="e.g. Erection support" />
              </div>
              <div>
                <label style={fieldLbl}>Code</label>
                <input value={catForm.category_code} onChange={e => setCatForm(f => ({ ...f, category_code: e.target.value }))} style={fieldInput} placeholder="ERE" />
              </div>
              <button onClick={saveCat} disabled={catBusy} style={{ ...primaryBtn, opacity: catBusy ? 0.6 : 1 }}>
                {catEditId ? 'Save' : <><Plus size={14} /> Add</>}
              </button>
            </div>

            {cats.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: '#9ca3af', fontSize: 13, border: '1px dashed #e5e7eb', borderRadius: 10 }}>
                No categories yet — add the first one above.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Name', 'Code', 'Tickets', ''].map(h => (
                      <th key={h} style={{ ...th, cursor: 'default' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cats.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid #f9fafb' }}>
                      <td style={{ ...td, color: '#1f2937', fontWeight: 500 }}>{c.name}</td>
                      <td style={td}>{c.category_code ?? '—'}</td>
                      <td style={td}>{c.ticket_count}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <button onClick={() => { setCatEditId(c.id); setCatForm({ name: c.name, category_code: c.category_code ?? '', description: c.description ?? '' }); }}
                          title="Edit" style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 7px', cursor: 'pointer', color: '#6B3FDB', marginRight: 6 }}>
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => setConfirmCat(c)} title="Remove"
                          style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 7px', cursor: 'pointer', color: '#dc2626' }}>
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
