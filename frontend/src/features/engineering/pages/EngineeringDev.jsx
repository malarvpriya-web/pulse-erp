/**
 * EngineeringDev.jsx — the Engineering Development (IPD) master grid.
 *
 * Reads /engineering/development (grid + filters + CRUD).
 *
 * This page previously rendered whatever columns the API happened to return
 * (Object.keys of row 0) against an endpoint that read a table which has never
 * existed — so in practice it only ever showed its error state. It now has a
 * real column model; see migration 20260717000001 for the rebuild.
 *
 * Product Type is INHERITED from the linked product line and is therefore chosen
 * by picking a product line, not typed — the catalogue master is product_lines,
 * owned by Product Setup.
 *
 * Category is LV/MV/HV (the electrical voltage class), NOT "LT/HT" — that
 * taxonomy exists nowhere in this system.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Pencil, Trash2, Download, FileText, Search, X,
  SlidersHorizontal, ArrowUp, ArrowDown, AlertCircle, Clock,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';

/**
 * Status colour is assigned EXPLICITLY rather than by indexing a series: green
 * marks `closed` (the good outcome) and red `cancelled`, which indexing would
 * get backwards. Every status also carries its text label in the cell, so
 * identity never rests on colour alone.
 */
const STATUS_COLOR = {
  design:      '#6B3FDB', // purple — starting point
  procurement: '#f59e0b', // amber  — waiting on parts
  assembly:    '#14b8a6', // teal   — being built
  testing:     '#2563eb', // blue   — under test
  validation:  '#db2777', // pink   — sign-off
  closed:      '#10b981', // green  — good outcome
  cancelled:   '#ef4444', // red    — dropped
};

// `id` is a row number over the current sort/page, so it is deliberately not
// sortable — sorting a display sequence by itself is meaningless.
const COLS = [
  { key: 'id',            label: 'ID',            sortable: false },
  { key: 'ipd_number',    label: 'IPD No' },
  { key: 'title',         label: 'Title' },
  { key: 'product_type',  label: 'Product Type' },
  { key: 'dev_type',      label: 'Dev Type' },
  { key: 'assembly_type', label: 'Assembly Type' },
  { key: 'category',      label: 'Category' },
  { key: 'status',        label: 'Status' },
  { key: 'started_date',  label: 'Started Date' },
  { key: 'closing_date',  label: 'Closing Date' },
  { key: 'ipp',           label: 'IPP' },
];
const PAGE_SIZES = [10, 20, 50, 100];
const BLANK_FILTER = { status: '', dev_type: '', assembly_type: '', category: '', product_line_id: '', project_id: '' };
const emptyForm = () => ({
  title: '', description: '', product_line_id: '', dev_type: '', assembly_type: '',
  category: '', status: 'design', priority: 'medium', owner_name: '',
  started_date: '', target_close_date: '', actual_close_date: '', project_id: '',
});

export default function EngineeringDev() {
  const { hasPermission } = useAuth();
  const canAdd    = hasPermission('engineering', 'add');
  const canEdit   = hasPermission('engineering', 'edit');
  const canDelete = hasPermission('engineering', 'delete');

  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [opts, setOpts]       = useState({ statuses: [], dev_types: [], assembly_types: [], categories: [], priorities: [], product_lines: [], projects: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort]         = useState('created_at');
  const [dir, setDir]           = useState('desc');
  const [search, setSearch]     = useState('');

  // Pending vs applied: the panel only takes effect on Apply, so the grid never
  // re-fetches on every keystroke.
  const [filterOpen, setFilterOpen] = useState(false);
  const [pending, setPending] = useState(BLANK_FILTER);
  const [applied, setApplied] = useState(BLANK_FILTER);

  const [drawer, setDrawer]       = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]           = useState(emptyForm());
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);

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
      const r = await api.get('/engineering/development', { params });
      setRows(Array.isArray(r.data?.data) ? r.data.data : []);
      setTotal(r.data?.total ?? 0);
    } catch (e) {
      setRows([]); setTotal(0);
      setError(e?.response?.data?.error || 'Could not load development records.');
    } finally { setLoading(false); }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/engineering/development/filters')
      .then(r => setOpts(r.data ?? {}))
      .catch(() => { /* filters degrade to empty selects */ });
  }, []);

  // ── sorting ────────────────────────────────────────────────────────────────
  const toggleSort = (c) => {
    if (c.sortable === false) return;
    if (sort === c.key) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(c.key); setDir('asc'); }
    setPage(1);
  };
  const recentUpdate = () => { setSort('created_at'); setDir('desc'); setPage(1); };

  const applyFilter = () => { setApplied(pending); setPage(1); setFilterOpen(false); };
  const clearFilter = () => { setPending(BLANK_FILTER); setApplied(BLANK_FILTER); setPage(1); };
  const activeFilters = Object.values(applied).filter(Boolean).length;

  // ── exports ────────────────────────────────────────────────────────────────
  // Exports the loaded page, matching what the user is looking at. Dates go
  // through fmtDate so an export reads the same as the screen.
  const cellText = (r, key, i) => {
    if (key === 'id') return String((page - 1) * pageSize + i + 1);
    if (key === 'started_date' || key === 'closing_date') return r[key] ? fmtDate(r[key]) : '';
    return String(r[key] ?? '');
  };
  const buildCsv = () => {
    const lines = [COLS.map(c => c.label).join(',')];
    rows.forEach((r, i) => {
      lines.push(COLS.map(c => {
        const s = cellText(r, c.key, i).replace(/"/g, '""');
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
    a.download = `Engineering_Development_IPD_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportExcel = () => download(buildCsv(), 'csv', 'text/csv;charset=utf-8;');
  const exportPdf = () => {
    const th = COLS.map(c => `<th>${c.label}</th>`).join('');
    const trs = rows.map((r, i) => `<tr>${COLS.map(c =>
      `<td>${cellText(r, c.key, i).replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to export PDF', 'error'); return; }
    w.document.write(`<!doctype html><html><head><title>Engineering Development (IPD)</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1f2937}
        h1{font-size:18px;margin:0 0 4px}p{font-size:12px;color:#6b7280;margin:0 0 16px}
        table{width:100%;border-collapse:collapse;font-size:10px}
        th,td{border:1px solid #e5e7eb;padding:5px 7px;text-align:left;white-space:nowrap}
        th{background:#f3f4f6}
      </style></head><body>
      <h1>Engineering Development (IPD)</h1>
      <p>Development records &middot; ${rows.length} of ${total} records &middot; ${fmtDate(new Date())}</p>
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
  };

  // ── new / edit / delete ────────────────────────────────────────────────────
  const openNew = () => { setEditingId(null); setForm(emptyForm()); setFormError(''); setDrawer(true); };
  const openEdit = (r) => {
    setEditingId(r.id);
    setForm({
      title: r.title ?? '', description: r.description ?? '',
      product_line_id: r.product_line_id ?? '', dev_type: r.dev_type ?? '',
      assembly_type: r.assembly_type ?? '', category: r.category ?? '',
      status: r.status ?? 'design', priority: r.priority ?? 'medium',
      owner_name: r.owner_name ?? '',
      started_date: r.started_date ?? '', target_close_date: r.target_close_date ?? '',
      actual_close_date: r.actual_close_date ?? '', project_id: r.project_id ?? '',
    });
    setFormError(''); setDrawer(true);
  };

  const save = async () => {
    if (!form.title.trim()) { setFormError('Title is required.'); return; }
    setSaving(true); setFormError('');
    const nn = (v) => (v === '' || v === undefined ? null : v);
    const payload = { ...form, title: form.title.trim() };
    Object.keys(payload).forEach(k => { payload[k] = nn(payload[k]); });
    try {
      if (editingId) await api.put(`/engineering/development/${editingId}`, payload);
      else await api.post('/engineering/development', payload);
      showToast(editingId ? 'Development record updated' : 'Development record created');
      setDrawer(false);
      load();
    } catch (e) {
      setFormError(e?.response?.data?.error || 'Could not save the record.');
    } finally { setSaving(false); }
  };

  const remove = async () => {
    const r = confirmDel; setConfirmDel(null);
    try {
      await api.delete(`/engineering/development/${r.id}`);
      showToast('Development record removed');
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || 'Could not remove the record', 'error');
    }
  };

  // ── styles (match Service Master / Project Master) ─────────────────────────
  const inputStyle = { padding: '7px 12px', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 7, fontSize: 13, background: '#fff', outline: 'none' };
  const toolBtn    = { ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--color-text-secondary, #6b7280)' };
  const primaryBtn = { padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 };
  const fieldLbl   = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
  const fieldInput = { ...inputStyle, width: '100%', boxSizing: 'border-box' };
  const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', userSelect: 'none' };
  const td = { padding: '10px 12px', color: 'var(--color-text-secondary, #6b7280)' };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="pulse-page" style={{ padding: 24, background: 'var(--color-bg-page, #f8f9fc)', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!confirmDel}
        title="Remove development record"
        message={`Remove ${confirmDel?.ipd_number ?? 'this record'}? It is archived, not erased — the IPD number is never reissued.`}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={remove}
        onCancel={() => setConfirmDel(null)}
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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Engineering Development</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Development records (IPD) &middot; {total} record{total === 1 ? '' : 's'}
          </p>
        </div>
        {canAdd && <button onClick={openNew} style={primaryBtn}><Plus size={15} /> New</button>}
      </div>

      {/* ── toolbar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => setFilterOpen(o => !o)} style={{ ...toolBtn, borderColor: activeFilters ? '#6B3FDB' : undefined, color: activeFilters ? '#6B3FDB' : toolBtn.color }}>
          <SlidersHorizontal size={14} /> Filter{activeFilters ? ` (${activeFilters})` : ''}
        </button>
        <button onClick={recentUpdate} title="Sort by most recently created" style={toolBtn}><Clock size={14} /> Recent Update</button>

        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search IPD No, title, owner, IPP, product…"
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
            ['dev_type', 'Dev Type', opts.dev_types],
            ['assembly_type', 'Assembly Type', opts.assembly_types],
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
            <label style={fieldLbl}>Product Type</label>
            <select value={pending.product_line_id} onChange={e => setPending(p => ({ ...p, product_line_id: e.target.value }))} style={fieldInput}>
              <option value="">All</option>
              {(opts.product_lines ?? []).map(l => <option key={l.id} value={l.id}>{l.display_name}</option>)}
            </select>
          </div>
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
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No development records found</p>
            <p style={{ margin: 0, fontSize: 12 }}>
              {activeFilters || search ? 'Try clearing the filters.' : 'Create one with New.'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {COLS.map(c => (
                    <th key={c.key}
                      style={{ ...th, cursor: c.sortable === false ? 'default' : 'pointer' }}
                      onClick={() => toggleSort(c)}
                      title={c.sortable === false ? 'Row number' : `Sort by ${c.label}`}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {c.label}
                        {sort === c.key && (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      </span>
                    </th>
                  ))}
                  {(canEdit || canDelete) && <th style={th}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={td}>{(page - 1) * pageSize + i + 1}</td>
                    <td style={{ ...td, fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{r.ipd_number ?? '—'}</td>
                    <td style={{ ...td, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.title ?? ''}>
                      {r.title ?? '—'}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.product_type ?? '—'}</td>
                    <td style={td}>{r.dev_type ?? '—'}</td>
                    <td style={td}>{r.assembly_type ?? '—'}</td>
                    <td style={td}>{r.category ?? '—'}</td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, fontSize: 11 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLOR[r.status] ?? '#9ca3af', flexShrink: 0 }} />
                        {r.status ?? '—'}
                      </span>
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.started_date ? fmtDate(r.started_date) : '—'}</td>
                    {/* A target date is never shown as though it were the actual close. */}
                    <td style={{ ...td, whiteSpace: 'nowrap' }}
                      title={r.closing_date ? (r.closing_is_actual ? 'Actual close date' : 'Target close date — not yet closed') : ''}>
                      {r.closing_date ? fmtDate(r.closing_date) : '—'}
                      {r.closing_date && !r.closing_is_actual && (
                        <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 4 }}>(target)</span>
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }} title={r.ipp_name ?? ''}>{r.ipp ?? '—'}</td>
                    {(canEdit || canDelete) && (
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {canEdit && (
                            <button onClick={() => openEdit(r)} title="Edit"
                              style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#6B3FDB' }}>
                              <Pencil size={13} />
                            </button>
                          )}
                          {canDelete && (
                            <button onClick={() => setConfirmDel(r)} title="Delete"
                              style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#ef4444' }}>
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
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
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 620, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                {editingId ? 'Edit Development Record' : 'New Development Record'}
              </h2>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            {formError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{formError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Title *</label>
                <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={fieldInput} placeholder="e.g. ASTRA 415V rack module — thermal rework" />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Description</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} style={{ ...fieldInput, resize: 'vertical' }} />
              </div>

              <div>
                <label style={fieldLbl}>Product Type</label>
                <select value={form.product_line_id} onChange={e => setForm(f => ({ ...f, product_line_id: e.target.value }))} style={fieldInput}>
                  <option value="">— None —</option>
                  {(opts.product_lines ?? []).map(l => <option key={l.id} value={l.id}>{l.display_name}</option>)}
                </select>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>From the product catalogue (Product Setup).</p>
              </div>
              <div>
                <label style={fieldLbl}>Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={fieldInput}>
                  <option value="">— Select —</option>
                  {(opts.categories ?? []).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>Voltage class.</p>
              </div>

              <div>
                <label style={fieldLbl}>Dev Type</label>
                <select value={form.dev_type} onChange={e => setForm(f => ({ ...f, dev_type: e.target.value }))} style={fieldInput}>
                  <option value="">— Select —</option>
                  {(opts.dev_types ?? []).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLbl}>Assembly Type</label>
                <select value={form.assembly_type} onChange={e => setForm(f => ({ ...f, assembly_type: e.target.value }))} style={fieldInput}>
                  <option value="">— Select —</option>
                  {(opts.assembly_types ?? []).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div>
                <label style={fieldLbl}>Status</label>
                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={fieldInput}>
                  {(opts.statuses ?? []).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLbl}>Priority</label>
                <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} style={fieldInput}>
                  {(opts.priorities ?? []).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>

              <div>
                <label style={fieldLbl}>Started Date</label>
                <input type="date" value={form.started_date ?? ''} onChange={e => setForm(f => ({ ...f, started_date: e.target.value }))} style={fieldInput} />
              </div>
              <div>
                <label style={fieldLbl}>Target Close Date</label>
                <input type="date" value={form.target_close_date ?? ''} onChange={e => setForm(f => ({ ...f, target_close_date: e.target.value }))} style={fieldInput} />
              </div>
              <div>
                <label style={fieldLbl}>Actual Close Date</label>
                <input type="date" value={form.actual_close_date ?? ''} onChange={e => setForm(f => ({ ...f, actual_close_date: e.target.value }))} style={fieldInput} />
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>Set automatically when status becomes closed.</p>
              </div>
              <div>
                <label style={fieldLbl}>Owner</label>
                <input value={form.owner_name} onChange={e => setForm(f => ({ ...f, owner_name: e.target.value }))} style={fieldInput} placeholder="e.g. R. Kumar" />
              </div>

              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>IPP (project)</label>
                <select value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={fieldInput}>
                  <option value="">— Not yet in production —</option>
                  {(opts.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.project_number} — {p.project_name}</option>)}
                </select>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>Link once the developed product moves into production.</p>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={() => setDrawer(false)} style={toolBtn}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
