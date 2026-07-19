/**
 * CustomerComplaintsIPCS.jsx — the Customer Complaints (IPCS) grid.
 *
 * Phase 3 of the build in SERVICE_MASTER_IPCS_PLAN.md. Reads /complaints
 * (grid + filters), which is gated on the `servicedesk` permission module.
 *
 * Built from ServiceMasterIPS.jsx — same toolbar, same server-side sort/page
 * contract, same export idiom ("Excel" means CSV here, house-wide). The two
 * grids are the two halves of one loop, so they should feel like one screen.
 *
 * Site is INHERITED from the linked project (IPP) and is therefore read-only —
 * it is set on the project, in Project Master. Product and Serial are per
 * complaint: the customer reads the serial off the unit, and the complaint may
 * be raised before anyone knows which project the unit belongs to.
 *
 * The IPS column is the point of the screen. "No IPS" is a REAL state — the
 * complaint has not been escalated — not a broken link. Converting is offered
 * inline, and a complaint may be escalated more than once (a reopened complaint
 * can go back to the field), which is why the column renders a list.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Pencil, Download, FileText, Search, X, SlidersHorizontal,
  ArrowUp, ArrowDown, AlertCircle, ArrowUpRight,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const PAGE_SIZES = [10, 20, 50, 100];

/**
 * The 7 reference columns. `get` derives the display/export value so the table,
 * the CSV and the PDF can never disagree about what a cell says — the IPS column
 * in particular is an array, and stringifying it in three places would drift.
 * `key` doubles as the server-side sort key (SORTABLE in complaints.routes.js).
 */
const COLS = [
  { key: 'ipcs_id',       label: 'IPCS ID',       get: r => r.ipcs_id ?? '' },
  { key: 'site',          label: 'Site',          get: r => r.site ?? '' },
  { key: 'customer_name', label: 'Customer Name', get: r => r.customer_name ?? '' },
  { key: 'mobile',        label: 'Mobile',        get: r => r.mobile ?? '' },
  { key: 'product',       label: 'Product',       get: r => r.product ?? '' },
  { key: 'serial',        label: 'Serial',        get: r => r.serial ?? '' },
  { key: 'ips',           label: 'IPS',           get: r => (r.ips_count > 0 ? (r.ips_numbers ?? []).join(', ') : 'No IPS') },
];

const emptyForm = () => ({
  title: '', description: '', customer_name: '', customer_email: '',
  customer_mobile: '', category: '', priority: 'Medium',
  project_id: '', product_line_id: '', serial_number: '',
});

// Mirrors validateOptionalMobile on the server (shared/validators.js). The server
// stays the authority — this only spares the user a round-trip to learn it.
const normalizeMobile = (v) => {
  let d = String(v ?? '').replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};
const isValidMobile = (v) => /^[6-9][0-9]{9}$/.test(normalizeMobile(v));

/**
 * @param {Function} navigateTo - navigate to another page key. Deliberately NOT
 *   named `setPage` (the app's usual name for it): this grid already owns a
 *   `setPage` for pagination state, and the two would collide. routes.jsx maps
 *   `ctx.setPage` onto this prop.
 */
export default function CustomerComplaintsIPCS({ navigateTo }) {
  const { hasPermission } = useAuth();
  const canAdd  = hasPermission('servicedesk', 'add');
  const canEdit = hasPermission('servicedesk', 'edit');

  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [opts, setOpts]       = useState({ statuses: [], priorities: [], categories: [], projects: [], product_lines: [] });
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
  const blankFilter = { status: '', priority: '', category: '', project_id: '', product_line_id: '', has_ips: '' };
  const [pending, setPending] = useState(blankFilter);
  const [applied, setApplied] = useState(blankFilter);

  const [drawer, setDrawer]       = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]           = useState(emptyForm());
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');

  const [confirmConvert, setConfirmConvert] = useState(null);
  const [converting, setConverting] = useState(false);

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
      const r = await api.get('/complaints', { params });
      setRows(Array.isArray(r.data?.data) ? r.data.data : []);
      setTotal(r.data?.pagination?.total ?? 0);
    } catch (e) {
      setRows([]); setTotal(0);
      setError(e?.response?.data?.error || 'Could not load complaints.');
    } finally { setLoading(false); }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/complaints/filters')
      .then(r => setOpts(r.data?.data ?? {}))
      .catch(() => { /* filters degrade to empty selects */ });
  }, []);

  // ── sorting ────────────────────────────────────────────────────────────────
  const toggleSort = (key) => {
    if (sort === key) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir('asc'); }
    setPage(1);
  };

  const applyFilter = () => { setApplied(pending); setPage(1); setFilterOpen(false); };
  const clearFilter = () => { setPending(blankFilter); setApplied(blankFilter); setPage(1); };
  const activeFilters = Object.values(applied).filter(Boolean).length;

  // ── exports ────────────────────────────────────────────────────────────────
  // Exports the loaded page, matching what the user is looking at.
  const buildCsv = () => {
    const lines = [COLS.map(c => c.label).join(',')];
    rows.forEach(r => {
      lines.push(COLS.map(c => {
        const s = String(c.get(r)).replace(/"/g, '""');
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
    a.download = `CustomerComplaints_IPCS_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportExcel = () => download(buildCsv(), 'csv', 'text/csv;charset=utf-8;');
  const exportPdf = () => {
    const th_ = COLS.map(c => `<th>${c.label}</th>`).join('');
    const trs = rows.map(r => `<tr>${COLS.map(c =>
      `<td>${String(c.get(r)).replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to export PDF', 'error'); return; }
    w.document.write(`<!doctype html><html><head><title>Customer Complaints (IPCS)</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1f2937}
        h1{font-size:18px;margin:0 0 4px}p{font-size:12px;color:#6b7280;margin:0 0 16px}
        table{width:100%;border-collapse:collapse;font-size:10px}
        th,td{border:1px solid #e5e7eb;padding:5px 7px;text-align:left;white-space:nowrap}
        th{background:#f3f4f6}
      </style></head><body>
      <h1>Customer Complaints (IPCS)</h1>
      <p>${rows.length} of ${total} records &middot; ${fmtDate(new Date())}</p>
      <table><thead><tr>${th_}</tr></thead><tbody>${trs}</tbody></table>
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
      customer_name: r.customer_name ?? '', customer_email: r.customer_email ?? '',
      // Binds to customer_mobile, NOT the coalesced `mobile` shown in the grid:
      // `mobile` falls back to legacy customer_phone, which may be formatted or a
      // landline, and prefilling that would make an unrelated edit unsavable.
      customer_mobile: r.customer_mobile ?? '', category: r.category ?? '',
      priority: r.priority ?? 'Medium',
      project_id: r.project_id ?? '', product_line_id: r.product_line_id ?? '',
      serial_number: r.serial ?? '',
    });
    setFormError(''); setDrawer(true);
  };

  const save = async () => {
    if (!form.title.trim())         { setFormError('Title is required.'); return; }
    if (!form.customer_name.trim()) { setFormError('Customer name is required.'); return; }
    if (form.customer_mobile && !isValidMobile(form.customer_mobile)) {
      setFormError('Mobile must be a 10-digit Indian number starting with 6-9.'); return;
    }
    setSaving(true); setFormError('');
    const nn = (v) => (v === '' || v === undefined ? null : v);
    const payload = {
      title: form.title.trim(),
      description: nn(form.description),
      customer_name: form.customer_name.trim(),
      customer_email: nn(form.customer_email),
      customer_mobile: nn(form.customer_mobile),
      category: form.category || 'General',
      priority: form.priority,
      project_id: nn(form.project_id),
      product_line_id: nn(form.product_line_id),
      serial_number: nn(form.serial_number),
    };
    try {
      if (editingId) await api.put(`/complaints/${editingId}`, payload);
      else await api.post('/complaints', payload);
      showToast(editingId ? 'Complaint updated' : 'Complaint registered');
      setDrawer(false);
      load();
    } catch (e) {
      setFormError(e?.response?.data?.error || 'Could not save the complaint.');
    } finally { setSaving(false); }
  };

  /**
   * Drill through to the complaint's detail view. That page — not this grid — owns
   * the status transition machine, the history trail and comments; the drawer here
   * deliberately edits fields only. ComplaintDetail reads the id from sessionStorage
   * as well as urlParams, so both are set (matching how the retired AllComplaints
   * grid opened it).
   */
  const openDetail = (r) => {
    if (!navigateTo) return;
    sessionStorage.setItem('selectedComplaintId', r.id);
    sessionStorage.setItem('selectedComplaint', JSON.stringify(r));
    navigateTo('ComplaintDetail', { id: r.id });
  };

  // ── convert to IPS ─────────────────────────────────────────────────────────
  const doConvert = async () => {
    const c = confirmConvert;
    setConverting(true);
    try {
      const r = await api.post(`/complaints/${c.id}/convert-to-ips`, {});
      showToast(`Raised ${r.data?.data?.ticket_number ?? 'service ticket'}`);
      setConfirmConvert(null);
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || 'Could not raise the service ticket', 'error');
      setConfirmConvert(null);
    } finally { setConverting(false); }
  };

  // ── styles (match Service Master / Project Master) ─────────────────────────
  const inputStyle = { padding: '7px 12px', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 7, fontSize: 13, background: '#fff', outline: 'none' };
  const toolBtn    = { ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--color-text-secondary, #6b7280)' };
  const primaryBtn = { padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 };
  const fieldLbl   = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
  const fieldInput = { ...inputStyle, width: '100%', boxSizing: 'border-box' };
  const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' };
  const td = { padding: '10px 12px', color: 'var(--color-text-secondary, #6b7280)' };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="pulse-page" style={{ padding: 24, background: 'var(--color-bg-page, #f8f9fc)', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!confirmConvert}
        title="Raise a service ticket"
        message={
          confirmConvert
            ? `Escalate ${confirmConvert.ipcs_id} to a field-service (IPS) ticket?` +
              ` Customer, product, serial and the linked project carry over automatically.` +
              (confirmConvert.ips_count > 0
                ? ` This complaint already has ${confirmConvert.ips_count} ticket(s); this raises another.`
                : '') +
              (!confirmConvert.project_id
                ? ` Note: no project (IPP) is linked, so the ticket will have no site.`
                : '')
            : ''
        }
        confirmLabel={converting ? 'Raising…' : 'Raise IPS'}
        onConfirm={doConvert}
        onCancel={() => setConfirmConvert(null)}
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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Customer Complaints</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Complaint register (IPCS) &middot; {total} record{total === 1 ? '' : 's'}
          </p>
        </div>
        {canAdd && <button onClick={openNew} style={primaryBtn}><Plus size={15} /> New</button>}
      </div>

      {/* ── toolbar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => setFilterOpen(o => !o)} style={{ ...toolBtn, borderColor: activeFilters ? '#6B3FDB' : undefined, color: activeFilters ? '#6B3FDB' : toolBtn.color }}>
          <SlidersHorizontal size={14} /> Filter{activeFilters ? ` (${activeFilters})` : ''}
        </button>

        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search IPCS ID, customer, mobile, serial, site, product…"
            style={{ ...inputStyle, width: '100%', paddingLeft: 32, boxSizing: 'border-box' }}
          />
        </div>

        <button onClick={exportExcel} title="Export to Excel (CSV)" style={toolBtn}><Download size={14} /> Excel</button>
        <button onClick={exportPdf} title="Export to PDF" style={toolBtn}><FileText size={14} /> PDF</button>
        <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }} style={inputStyle} aria-label="Rows per page">
          {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>

      {/* ── filter panel ── */}
      {filterOpen && (
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 16, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, alignItems: 'end' }}>
          {[
            ['status', 'Status', opts.statuses],
            ['priority', 'Priority', opts.priorities],
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
          <div>
            <label style={fieldLbl}>Product</label>
            <select value={pending.product_line_id} onChange={e => setPending(p => ({ ...p, product_line_id: e.target.value }))} style={fieldInput}>
              <option value="">All</option>
              {(opts.product_lines ?? []).map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
          </div>
          {/* "No IPS" is a real state, so it is a real filter: which complaints
              were never escalated? */}
          <div>
            <label style={fieldLbl}>IPS raised</label>
            <select value={pending.has_ips} onChange={e => setPending(p => ({ ...p, has_ips: e.target.value }))} style={fieldInput}>
              <option value="">All</option>
              <option value="true">Escalated</option>
              <option value="false">No IPS</option>
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
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No complaints found</p>
            <p style={{ margin: 0, fontSize: 12 }}>
              {activeFilters || search ? 'Try clearing the filters.' : 'Register one with New.'}
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
                  {(canEdit || canAdd) && <th style={{ ...th, cursor: 'default' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button onClick={() => openDetail(r)} title="Open complaint — status, history, comments"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 600, color: '#6B3FDB' }}>
                        {r.ipcs_id}
                      </button>
                    </td>
                    {/* Site is blank, not "—", when no project is linked: the
                        reference calls for blank until it is linked. */}
                    <td style={td}>{r.site ?? ''}</td>
                    <td style={{ ...td, color: '#1f2937', fontWeight: 500 }}>{r.customer_name ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{r.mobile ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.product ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.serial ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {r.ips_count > 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#1f2937' }}>
                          {r.ips_numbers[0]}
                          {r.ips_count > 1 && (
                            <span title={r.ips_numbers.join(', ')}
                              style={{ fontSize: 11, fontWeight: 600, color: '#6B3FDB', background: '#f3f0fd', borderRadius: 4, padding: '1px 5px' }}>
                              +{r.ips_count - 1}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No IPS</span>
                      )}
                    </td>
                    {(canEdit || canAdd) && (
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <button onClick={() => openEdit(r)} title="Edit"
                            style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#6B3FDB', marginRight: 6 }}>
                            <Pencil size={13} />
                          </button>
                        )}
                        {canAdd && (
                          <button onClick={() => setConfirmConvert(r)}
                            title={r.ips_count > 0 ? 'Raise another service ticket' : 'Raise a service ticket'}
                            style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#6b7280' }}>
                            <ArrowUpRight size={13} />
                          </button>
                        )}
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
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 600, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>{editingId ? 'Edit Complaint' : 'New Complaint'}</h2>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            {formError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{formError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Title *</label>
                <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={fieldInput} placeholder="e.g. Harmonic distortion above spec" />
              </div>
              <div>
                <label style={fieldLbl}>Customer name *</label>
                <input value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))} style={fieldInput} />
              </div>
              <div>
                <label style={fieldLbl}>Mobile</label>
                <input value={form.customer_mobile} onChange={e => setForm(f => ({ ...f, customer_mobile: e.target.value }))} style={fieldInput} placeholder="9876543210" />
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>10-digit Indian mobile.</p>
              </div>
              <div>
                <label style={fieldLbl}>Email</label>
                <input type="email" value={form.customer_email} onChange={e => setForm(f => ({ ...f, customer_email: e.target.value }))} style={fieldInput} />
              </div>
              <div>
                <label style={fieldLbl}>Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={fieldInput}>
                  <option value="">— Select —</option>
                  {(opts.categories ?? []).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLbl}>IPP (project)</label>
                <select value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={fieldInput}>
                  <option value="">— None —</option>
                  {(opts.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.project_number} — {p.project_name}</option>)}
                </select>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>Site comes from the project.</p>
              </div>
              <div>
                <label style={fieldLbl}>Product</label>
                <select value={form.product_line_id} onChange={e => setForm(f => ({ ...f, product_line_id: e.target.value }))} style={fieldInput}>
                  <option value="">— None —</option>
                  {(opts.product_lines ?? []).map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLbl}>Serial number</label>
                <input value={form.serial_number} onChange={e => setForm(f => ({ ...f, serial_number: e.target.value }))} style={fieldInput} placeholder="as printed on the unit" />
              </div>
              <div>
                <label style={fieldLbl}>Priority</label>
                <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} style={fieldInput}>
                  {['Low', 'Medium', 'High', 'Critical'].map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Description</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3}
                  style={{ ...fieldInput, resize: 'vertical' }} placeholder="What the customer reported — dates, symptoms, conditions…" />
              </div>
            </div>

            {/* Status is deliberately absent: it has a transition machine and a
                history trail (PUT /complaints/:id/status), which a free-form
                select here would bypass. */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
              <button onClick={() => setDrawer(false)} style={toolBtn}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Register Complaint'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
