/**
 * SalesPartners.jsx — the Partner (IPU) master grid.
 *
 * Reads /sales/partners (grid + filters + CRUD + leads + lead conversion).
 *
 * This page was a card wall backed by a table with no migration, no IPU number,
 * no address/tax columns and no lead relationship. It is now a real column-model
 * grid; see migration 20260717000004 and routes/partners.routes.js.
 *
 * STATE IS DERIVED FROM GSTIN, not typed: entering a GSTIN fills State from its
 * prefix and locks the field, so the grid can never disagree with the tax
 * treatment Finance derives from the same prefix. Any state is accepted —
 * Manifest is Karnataka ('29') but partners are based all over India.
 *
 * Rendered standalone at /SalesPartners and embedded as the Partners tab of
 * SalesMarket, which passes `embedded` to suppress the duplicate page header.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Plus, Pencil, Trash2, Download, FileText, Search, X, Columns3,
  ArrowUp, ArrowDown, AlertCircle, ChevronRight, ChevronDown,
  Users, ArrowRightLeft, ExternalLink, Check,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import { validateGSTIN, gstinToState } from '@/utils/gstinValidation';
import ConfirmDialog from '@/components/core/ConfirmDialog';

/**
 * Association type colour. Assigned explicitly rather than by indexing a series —
 * and every badge carries its text label, so identity never rests on colour.
 */
const ASSOC_COLOR = {
  'System Integrator': '#2563eb',
  'Partner':           '#6B3FDB',
};
const STATUS_COLOR = { active: '#10b981', inactive: '#9ca3af', suspended: '#ef4444' };

// `sl` is a row number over the current sort/page, so it is deliberately not
// sortable — sorting a display sequence by itself is meaningless.
const COLS = [
  { key: 'sl',               label: '#',                sortable: false, always: true },
  { key: 'ipu_number',       label: 'IPU ID',           always: true },
  { key: 'name',             label: 'Partner Name',     always: true },
  { key: 'association_type', label: 'Association Type' },
  { key: 'email',            label: 'Email' },
  { key: 'phone',            label: 'Contact' },
  { key: 'website',          label: 'Website' },
  { key: 'city',             label: 'City' },
  { key: 'state',            label: 'State' },
  { key: 'country',          label: 'Country' },
  { key: 'gstin',            label: 'GSTIN' },
  { key: 'status',           label: 'Status' },
];
const PAGE_SIZES = [10, 20, 50, 100];
const COLS_KEY = 'pulse.salesPartners.cols';

const BLANK_FILTER = { association_type: '', status: '', state: '', city: '' };
const emptyForm = () => ({
  name: '', association_type: 'Partner', email: '', phone: '', website: '',
  city: '', state: '', country: 'India', gstin: '', contact_name: '',
  region: '', commission_pct: '', address: '', notes: '', status: 'active',
});

export default function SalesPartners({ embedded = false }) {
  const { hasPermission } = useAuth();
  const canAdd    = hasPermission('sales', 'add');
  const canEdit   = hasPermission('sales', 'edit');
  const canDelete = hasPermission('sales', 'delete');

  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [opts, setOpts]       = useState({ association_types: [], statuses: [], states: [], cities: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort]         = useState('created_at');
  const [dir, setDir]           = useState('desc');
  const [search, setSearch]     = useState('');
  const [applied, setApplied]   = useState(BLANK_FILTER);

  // Selected row drives the toolbar's Edit / View Leads. Expanded row is
  // independent of selection so a user can read one row while acting on it.
  const [selectedId, setSelectedId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  // Column visibility, remembered per browser — a user who hides six columns
  // should not have to hide them again next visit.
  const [visible, setVisible] = useState(() => {
    const base = Object.fromEntries(COLS.map(c => [c.key, true]));
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || '{}');
      return { ...base, ...saved };
    } catch { return base; }
  });
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef(null);

  const [drawer, setDrawer]       = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]           = useState(emptyForm());
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');
  const [gstinError, setGstinError] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);

  // View Leads panel
  const [leadsFor, setLeadsFor]   = useState(null);
  const [leads, setLeads]         = useState([]);
  const [leadsLoading, setLeadsLoading] = useState(false);

  // Convert to Partner
  const [convertOpen, setConvertOpen]     = useState(false);
  const [convertLeads, setConvertLeads]   = useState([]);
  const [convertLeadId, setConvertLeadId] = useState('');

  const [toast, setToast] = useState(null);
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3200); };

  useEffect(() => { try { localStorage.setItem(COLS_KEY, JSON.stringify(visible)); } catch { /* quota — not worth failing over */ } }, [visible]);

  // Close the column menu on an outside click; a menu that only closes via its
  // own button is a trap next to a wide scrolling grid.
  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e) => { if (colsRef.current && !colsRef.current.contains(e.target)) setColsOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colsOpen]);

  const params = useMemo(() => {
    const p = { page, page_size: pageSize, sort, dir };
    if (search) p.search = search;
    Object.entries(applied).forEach(([k, v]) => { if (v) p[k] = v; });
    return p;
  }, [page, pageSize, sort, dir, search, applied]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await api.get('/sales/partners', { params });
      setRows(Array.isArray(r.data?.data) ? r.data.data : []);
      setTotal(r.data?.total ?? 0);
    } catch (e) {
      setRows([]); setTotal(0);
      setError(e?.response?.data?.error || 'Could not load partners.');
    } finally { setLoading(false); }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/sales/partners/filters')
      .then(r => setOpts(r.data ?? {}))
      .catch(() => { /* filters degrade to empty selects */ });
  }, []);

  const shownCols = COLS.filter(c => visible[c.key] !== false);
  const selected  = rows.find(r => r.id === selectedId) ?? null;

  // ── sorting ────────────────────────────────────────────────────────────────
  const toggleSort = (c) => {
    if (c.sortable === false) return;
    if (sort === c.key) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(c.key); setDir('asc'); }
    setPage(1);
  };

  const applyFilter = (k, v) => { setApplied(a => ({ ...a, [k]: v })); setPage(1); };
  const activeFilters = Object.values(applied).filter(Boolean).length;

  // ── exports ────────────────────────────────────────────────────────────────
  // Exports the VISIBLE columns of the loaded page, matching what the user is
  // looking at rather than a fixed shape they did not choose.
  const cellText = (r, key, i) => {
    if (key === 'sl') return String((page - 1) * pageSize + i + 1);
    return String(r[key] ?? '');
  };
  const buildCsv = () => {
    const lines = [shownCols.map(c => c.label).join(',')];
    rows.forEach((r, i) => {
      lines.push(shownCols.map(c => {
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
    a.download = `Partners_IPU_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportExcel = () => download(buildCsv(), 'csv', 'text/csv;charset=utf-8;');
  const exportPdf = () => {
    const esc = (s) => String(s).replace(/</g, '&lt;');
    const th = shownCols.map(c => `<th>${esc(c.label)}</th>`).join('');
    const trs = rows.map((r, i) => `<tr>${shownCols.map(c =>
      `<td>${esc(cellText(r, c.key, i))}</td>`).join('')}</tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to export PDF', 'error'); return; }
    w.document.write(`<!doctype html><html><head><title>Partners (IPU)</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1f2937}
        h1{font-size:18px;margin:0 0 4px}p{font-size:12px;color:#6b7280;margin:0 0 16px}
        table{width:100%;border-collapse:collapse;font-size:10px}
        th,td{border:1px solid #e5e7eb;padding:5px 7px;text-align:left;white-space:nowrap}
        th{background:#f3f4f6}
      </style></head><body>
      <h1>Partners (IPU)</h1>
      <p>Partner master &middot; ${rows.length} of ${total} records &middot; ${fmtDate(new Date())}</p>
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
  };

  // ── new / edit ─────────────────────────────────────────────────────────────
  const fillFrom = (r) => ({
    name: r.name ?? '', association_type: r.association_type ?? 'Partner',
    email: r.email ?? '', phone: r.phone ?? '', website: r.website ?? '',
    city: r.city ?? '', state: r.state ?? '', country: r.country ?? 'India',
    gstin: r.gstin ?? '', contact_name: r.contact_name ?? '', region: r.region ?? '',
    commission_pct: r.commission_pct ?? '', address: r.address ?? '',
    notes: r.notes ?? '', status: r.status ?? 'active',
  });
  const openNew = () => {
    setEditingId(null); setConvertLeadId('');
    setForm(emptyForm()); setFormError(''); setGstinError(''); setDrawer(true);
  };
  const openEdit = (r) => {
    setEditingId(r.id); setConvertLeadId('');
    setForm(fillFrom(r)); setFormError(''); setGstinError(''); setDrawer(true);
  };

  // GSTIN drives State. Cleared GSTIN releases State back to free text rather
  // than stranding whatever the last prefix resolved to.
  const onGstinChange = (raw) => {
    const v = raw.toUpperCase();
    setForm(f => ({ ...f, gstin: v, state: v ? (gstinToState(v) || f.state) : f.state }));
    if (!v) { setGstinError(''); return; }
    const r = validateGSTIN(v);
    setGstinError(r.valid ? '' : r.error);
  };

  const save = async () => {
    if (!form.name.trim()) { setFormError('Partner name is required.'); return; }
    if (form.gstin && !validateGSTIN(form.gstin).valid) { setFormError('Fix the GSTIN before saving.'); return; }
    setSaving(true); setFormError('');
    const nn = (v) => (v === '' || v === undefined ? null : v);
    const payload = Object.fromEntries(Object.entries({ ...form, name: form.name.trim() }).map(([k, v]) => [k, nn(v)]));
    try {
      if (convertLeadId) {
        const r = await api.post('/sales/partners/convert-lead', { ...payload, lead_id: convertLeadId });
        showToast(`Lead converted to partner ${r.data?.ipu_number ?? ''}`);
      } else if (editingId) {
        await api.put(`/sales/partners/${editingId}`, payload);
        showToast('Partner updated');
      } else {
        await api.post('/sales/partners', payload);
        showToast('Partner created');
      }
      setDrawer(false); setConvertLeadId('');
      load();
    } catch (e) {
      setFormError(e?.response?.data?.error || 'Could not save the partner.');
    } finally { setSaving(false); }
  };

  const remove = async () => {
    const r = confirmDel; setConfirmDel(null);
    try {
      await api.delete(`/sales/partners/${r.id}`);
      if (selectedId === r.id) setSelectedId(null);
      showToast('Partner removed');
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || 'Could not remove the partner', 'error');
    }
  };

  // ── view leads ─────────────────────────────────────────────────────────────
  const openLeads = async (r) => {
    setLeadsFor(r); setLeads([]); setLeadsLoading(true);
    try {
      const res = await api.get(`/sales/partners/${r.id}/leads`);
      setLeads(Array.isArray(res.data?.data) ? res.data.data : []);
    } catch (e) {
      showToast(e?.response?.data?.error || 'Could not load leads', 'error');
      setLeadsFor(null);
    } finally { setLeadsLoading(false); }
  };

  // ── convert to partner ─────────────────────────────────────────────────────
  const openConvert = async () => {
    setConvertOpen(true); setConvertLeads([]);
    try {
      const r = await api.get('/sales/partners/convertible-leads');
      setConvertLeads(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      showToast(e?.response?.data?.error || 'Could not load leads', 'error');
      setConvertOpen(false);
    }
  };
  /**
   * Carries the lead's fields into the partner drawer instead of making the user
   * retype them. Leads hold no GSTIN/website/state, so those stay blank for the
   * user to complete — the drawer is where a conversion gets finished, not a
   * silent insert.
   */
  const pickConvertLead = (lead) => {
    setConvertOpen(false);
    setEditingId(null);
    setConvertLeadId(lead.id);
    setForm({
      ...emptyForm(),
      name:         lead.company_name   ?? '',
      contact_name: lead.contact_person ?? '',
      email:        lead.email          ?? '',
      phone:        lead.phone          ?? '',
      city:         lead.location       ?? '',
    });
    setFormError(''); setGstinError(''); setDrawer(true);
  };

  // ── styles (match Engineering Development / Service Master) ────────────────
  const inputStyle = { padding: '7px 12px', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 7, fontSize: 13, background: '#fff', outline: 'none' };
  const toolBtn    = { ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--color-text-secondary, #6b7280)' };
  const disBtn     = { ...toolBtn, opacity: 0.45, cursor: 'not-allowed' };
  const primaryBtn = { padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 };
  const fieldLbl   = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
  const fieldInput = { ...inputStyle, width: '100%', boxSizing: 'border-box' };
  const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', userSelect: 'none' };
  const td = { padding: '10px 12px', color: 'var(--color-text-secondary, #6b7280)' };
  const iconBtn = { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const cell = (r, key) => {
    switch (key) {
      case 'association_type': {
        const c = ASSOC_COLOR[r.association_type] ?? '#6b7280';
        return r.association_type
          ? <span style={{ background: `${c}18`, color: c, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{r.association_type}</span>
          : '—';
      }
      case 'status':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, fontSize: 11 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLOR[r.status] ?? '#9ca3af', flexShrink: 0 }} />
            {r.status ?? '—'}
          </span>
        );
      case 'email':
        return r.email ? <a href={`mailto:${r.email}`} onClick={e => e.stopPropagation()} style={{ color: '#6B3FDB', textDecoration: 'none' }}>{r.email}</a> : '—';
      case 'website': {
        if (!r.website) return '—';
        // Stored values may or may not carry a scheme; a bare host in href would
        // resolve relative to the app and 404.
        const href = /^https?:\/\//i.test(r.website) ? r.website : `https://${r.website}`;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
             style={{ color: '#6B3FDB', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {r.website}<ExternalLink size={11} />
          </a>
        );
      }
      case 'gstin':
        return r.gstin ? <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.gstin}</span> : '—';
      default:
        return r[key] ?? '—';
    }
  };

  return (
    <div className="pulse-page" style={{ padding: 24, background: 'var(--color-bg-page, #f8f9fc)', minHeight: embedded ? undefined : '100vh' }}>
      <ConfirmDialog
        open={!!confirmDel}
        title="Remove partner"
        message={`Remove ${confirmDel?.ipu_number ?? 'this partner'}? It is archived, not erased — the IPU number is never reissued and its leads keep their attribution.`}
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
      {!embedded && (
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Partners</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Partner master (IPU) &middot; {total} partner{total === 1 ? '' : 's'}
          </p>
        </div>
      )}

      {/* ── toolbar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {canAdd && <button onClick={openNew} style={primaryBtn}><Plus size={15} /> New</button>}

        <button
          onClick={() => selected && openEdit(selected)}
          disabled={!selected || !canEdit}
          title={selected ? `Edit ${selected.ipu_number}` : 'Select a row to edit'}
          style={!selected || !canEdit ? disBtn : toolBtn}>
          <Pencil size={14} /> Edit
        </button>

        <button
          onClick={() => selected && openLeads(selected)}
          disabled={!selected}
          title={
            !selected ? 'Select a row to view its leads'
              : selected.lead_count ? `${selected.lead_count} lead${selected.lead_count === 1 ? '' : 's'} for ${selected.name}`
                : `No leads are attributed to ${selected.name} yet`
          }
          style={!selected ? disBtn : toolBtn}>
          <Users size={14} /> View Leads
          {selected?.lead_count > 0 && (
            <span style={{ background: '#ede9fe', color: '#6B3FDB', borderRadius: 10, padding: '0 6px', fontSize: 11, fontWeight: 700 }}>
              {selected.lead_count}
            </span>
          )}
        </button>

        {canAdd && (
          <button onClick={openConvert} title="Graduate a lead into a full partner record" style={toolBtn}>
            <ArrowRightLeft size={14} /> Convert to Partner
          </button>
        )}

        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search IPU, name, email, GSTIN, city…"
            style={{ ...inputStyle, width: '100%', paddingLeft: 32, boxSizing: 'border-box' }}
          />
        </div>

        {/* column visibility */}
        <div style={{ position: 'relative' }} ref={colsRef}>
          <button onClick={() => setColsOpen(o => !o)} title="Show or hide columns" style={toolBtn}>
            <Columns3 size={14} /> Columns
          </button>
          {colsOpen && (
            <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 50, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 8, minWidth: 190, boxShadow: '0 10px 30px rgba(0,0,0,.12)' }}>
              {COLS.map(c => {
                const on = visible[c.key] !== false;
                // The identity columns stay: a grid with no IPU or name is not a
                // view of anything.
                const locked = c.always;
                return (
                  <button key={c.key}
                    onClick={() => !locked && setVisible(v => ({ ...v, [c.key]: !on }))}
                    disabled={locked}
                    title={locked ? 'Always shown' : undefined}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: 'none', background: 'none', cursor: locked ? 'default' : 'pointer', fontSize: 13, color: locked ? '#9ca3af' : '#374151', textAlign: 'left', borderRadius: 6 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, border: `1px solid ${on ? '#6B3FDB' : '#d1d5db'}`, background: on ? '#6B3FDB' : '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {on && <Check size={10} color="#fff" />}
                    </span>
                    {c.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button onClick={exportExcel} title="Export to Excel (CSV)" style={toolBtn}><Download size={14} /> Excel</button>
        <button onClick={exportPdf} title="Export to PDF" style={toolBtn}><FileText size={14} /> PDF</button>
        <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }} style={inputStyle}>
          {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>

      {/* ── filters ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          ['association_type', 'All association types', opts.association_types],
          ['status',           'All statuses',          opts.statuses],
          ['state',            'All states',            opts.states],
          ['city',             'All cities',            opts.cities],
        ].map(([key, all, list]) => (
          <select key={key} value={applied[key]} onChange={e => applyFilter(key, e.target.value)}
            style={{ ...inputStyle, borderColor: applied[key] ? '#6B3FDB' : undefined, color: applied[key] ? '#6B3FDB' : undefined }}>
            <option value="">{all}</option>
            {(list ?? []).map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        ))}
        {activeFilters > 0 && (
          <button onClick={() => { setApplied(BLANK_FILTER); setPage(1); }} style={toolBtn}>
            <X size={13} /> Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
          </button>
        )}
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
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No partners found</p>
            <p style={{ margin: 0, fontSize: 12 }}>
              {activeFilters || search ? 'Try clearing the filters.' : 'Create one with New, or graduate a lead with Convert to Partner.'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {shownCols.map(c => (
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
                {rows.map((r, i) => {
                  const on = selectedId === r.id;
                  const open = expandedId === r.id;
                  return (
                    <tr key={r.id}
                      onClick={() => setSelectedId(on ? null : r.id)}
                      style={{
                        borderBottom: '1px solid #f9fafb',
                        // Selection is marked by tint AND a left bar, so it survives
                        // the zebra striping instead of competing with it.
                        background: on ? '#f3efff' : i % 2 === 0 ? '#fff' : '#fafafa',
                        boxShadow: on ? 'inset 3px 0 0 #6B3FDB' : undefined,
                        cursor: 'pointer',
                      }}>
                      {shownCols.map(c => {
                        if (c.key === 'sl') return <td key={c.key} style={td}>{(page - 1) * pageSize + i + 1}</td>;
                        if (c.key === 'ipu_number') {
                          return (
                            <td key={c.key} style={{ ...td, whiteSpace: 'nowrap' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <button
                                  onClick={e => { e.stopPropagation(); setExpandedId(open ? null : r.id); }}
                                  title={open ? 'Collapse' : 'Expand'}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0, display: 'inline-flex' }}>
                                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </button>
                                <button
                                  onClick={e => { e.stopPropagation(); setSelectedId(r.id); setExpandedId(open ? null : r.id); }}
                                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, color: '#6B3FDB', fontSize: 13 }}>
                                  {r.ipu_number ?? '—'}
                                </button>
                                {/* row-level quick actions */}
                                <button onClick={e => { e.stopPropagation(); openLeads(r); }}
                                  title={r.lead_count ? `View ${r.lead_count} lead${r.lead_count === 1 ? '' : 's'}` : 'No leads attributed yet'}
                                  style={{ ...iconBtn, color: r.lead_count ? '#6B3FDB' : '#d1d5db', marginLeft: 2 }}>
                                  <Users size={11} />
                                </button>
                                {canEdit && (
                                  <button onClick={e => { e.stopPropagation(); openEdit(r); }} title="Edit"
                                    style={{ ...iconBtn, color: '#6B3FDB' }}>
                                    <Pencil size={11} />
                                  </button>
                                )}
                              </span>
                            </td>
                          );
                        }
                        if (c.key === 'name') {
                          return (
                            <td key={c.key} style={{ ...td, fontWeight: 600, color: '#1f2937', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name ?? ''}>
                              {r.name ?? '—'}
                            </td>
                          );
                        }
                        return <td key={c.key} style={{ ...td, whiteSpace: 'nowrap' }}>{cell(r, c.key)}</td>;
                      })}
                      {(canEdit || canDelete) && (
                        <td style={td}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {canEdit && (
                              <button onClick={e => { e.stopPropagation(); openEdit(r); }} title="Edit"
                                style={{ ...iconBtn, padding: '4px 8px', color: '#6B3FDB' }}>
                                <Pencil size={13} />
                              </button>
                            )}
                            {canDelete && (
                              <button onClick={e => { e.stopPropagation(); setConfirmDel(r); }} title="Delete"
                                style={{ ...iconBtn, padding: '4px 8px', color: '#ef4444' }}>
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {/* expanded detail rows are rendered as siblings so the grid keeps one <tr> per record */}
                {rows.map(r => expandedId === r.id && (
                  <tr key={`x-${r.id}`} style={{ background: '#faf9ff' }}>
                    <td colSpan={shownCols.length + ((canEdit || canDelete) ? 1 : 0)} style={{ padding: '12px 16px 14px 40px', borderBottom: '1px solid #f0f0f4' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12, fontSize: 12 }}>
                        {[
                          ['Contact person', r.contact_name],
                          ['Region',         r.region],
                          ['Commission',     r.commission_pct > 0 ? `${r.commission_pct}%` : null],
                          ['Leads',          r.lead_count ? `${r.lead_count} attributed` : 'None yet'],
                          ['Converted from', r.converted_from_lead_id ? `Lead #${r.converted_from_lead_id}` : null],
                          ['Address',        r.address],
                          ['Notes',          r.notes],
                          ['Created',        r.created_at ? fmtDate(r.created_at) : null],
                        ].filter(([, v]) => v).map(([k, v]) => (
                          <div key={k}>
                            <div style={{ color: '#9ca3af', fontWeight: 600, marginBottom: 2 }}>{k}</div>
                            <div style={{ color: '#374151' }}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </td>
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
          <span>Page {page} of {totalPages} &middot; {total} partner{total === 1 ? '' : 's'}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={{ ...toolBtn, opacity: page <= 1 ? 0.5 : 1 }}>Previous</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={{ ...toolBtn, opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
          </div>
        </div>
      )}

      {/* ── convert: lead picker ── */}
      {convertOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 26, width: 560, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>Convert a lead to a partner</h2>
              <button onClick={() => setConvertOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 16px' }}>
              The lead&rsquo;s name, contact, email, phone and city carry over. GSTIN and
              website are not held on a lead — you&rsquo;ll add those next.
            </p>
            {convertLeads.length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '30px 0' }}>
                No leads available to convert.
              </p>
            ) : convertLeads.map(l => (
              <button key={l.id} onClick={() => pickConvertLead(l)}
                style={{ width: '100%', textAlign: 'left', border: '1px solid #f0f0f4', borderRadius: 10, padding: '10px 14px', marginBottom: 8, background: '#fff', cursor: 'pointer' }}>
                <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 13 }}>{l.company_name ?? `Lead #${l.id}`}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  {[l.contact_person, l.email, l.location].filter(Boolean).join(' · ') || 'No contact details'}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {[l.status && `Status: ${l.status}`, l.lead_source && `Source: ${l.lead_source}`].filter(Boolean).join(' · ')}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── view leads ── */}
      {leadsFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 26, width: 760, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                  Leads &middot; {leadsFor.name}
                </h2>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '3px 0 0' }}>
                  {leadsFor.ipu_number} &middot; leads sourced through or associated with this partner
                </p>
              </div>
              <button onClick={() => setLeadsFor(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            {leadsLoading ? (
              <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
            ) : leads.length === 0 ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af' }}>
                <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No leads attributed to this partner</p>
                <p style={{ margin: 0, fontSize: 12 }}>Set a lead&rsquo;s Partner in the CRM to attribute it here.</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Company', 'Contact', 'Status', 'Source', 'Est. Value', 'Created'].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {leads.map(l => (
                    <tr key={l.id} style={{ borderBottom: '1px solid #f9fafb' }}>
                      <td style={{ ...td, fontWeight: 600, color: '#1f2937' }}>{l.company_name ?? '—'}</td>
                      <td style={td}>{l.contact_person ?? '—'}</td>
                      <td style={td}>{l.status ?? '—'}</td>
                      <td style={td}>{l.lead_source ?? '—'}</td>
                      <td style={td}>{l.estimated_value > 0 ? `₹${Number(l.estimated_value).toLocaleString('en-IN')}` : '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.created_at ? fmtDate(l.created_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── new / edit / convert drawer ── */}
      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 660, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                {convertLeadId ? 'Convert Lead to Partner' : editingId ? 'Edit Partner' : 'New Partner'}
              </h2>
              <button onClick={() => { setDrawer(false); setConvertLeadId(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            {convertLeadId && (
              <div style={{ background: '#ede9fe', color: '#5b21b6', padding: '9px 14px', borderRadius: 8, marginBottom: 14, fontSize: 12 }}>
                Pre-filled from the lead. Saving creates the partner and attributes the lead to it — the lead itself is not closed.
              </div>
            )}
            {formError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{formError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Partner Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={fieldInput} placeholder="Partner company name" />
              </div>

              <div>
                <label style={fieldLbl}>Association Type</label>
                <select value={form.association_type} onChange={e => setForm(f => ({ ...f, association_type: e.target.value }))} style={fieldInput}>
                  {(opts.association_types ?? ['System Integrator', 'Partner']).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLbl}>Status</label>
                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={fieldInput}>
                  {(opts.statuses ?? ['active', 'inactive', 'suspended']).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div>
                <label style={fieldLbl}>Contact Person</label>
                <input value={form.contact_name} onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))} style={fieldInput} placeholder="Primary contact" />
              </div>
              <div>
                <label style={fieldLbl}>Contact (Phone)</label>
                <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={fieldInput} placeholder="+91…" />
              </div>

              <div>
                <label style={fieldLbl}>Email</label>
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={fieldInput} placeholder="contact@partner.com" />
              </div>
              <div>
                <label style={fieldLbl}>Website</label>
                <input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} style={fieldInput} placeholder="partner.com" />
              </div>

              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>GSTIN</label>
                <input
                  value={form.gstin}
                  onChange={e => onGstinChange(e.target.value)}
                  maxLength={15}
                  style={{ ...fieldInput, fontFamily: 'monospace', borderColor: gstinError ? '#ef4444' : fieldInput.border }}
                  placeholder="29AAAAA0000A1Z5"
                />
                {gstinError
                  ? <p style={{ fontSize: 11, color: '#ef4444', margin: '4px 0 0' }}>{gstinError}</p>
                  : <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>
                      Optional. Any Indian state is accepted — State is filled from the first two digits.
                    </p>}
              </div>

              <div>
                <label style={fieldLbl}>City</label>
                <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} style={fieldInput} placeholder="Bengaluru" />
              </div>
              <div>
                <label style={fieldLbl}>State</label>
                <input
                  value={form.state}
                  onChange={e => setForm(f => ({ ...f, state: e.target.value }))}
                  readOnly={!!form.gstin && !gstinError}
                  style={{ ...fieldInput, background: (form.gstin && !gstinError) ? '#f9fafb' : '#fff', color: (form.gstin && !gstinError) ? '#6b7280' : undefined }}
                  placeholder="Karnataka"
                />
                {form.gstin && !gstinError && (
                  <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>From the GSTIN prefix.</p>
                )}
              </div>

              <div>
                <label style={fieldLbl}>Country</label>
                <input value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} style={fieldInput} />
              </div>
              <div>
                <label style={fieldLbl}>Commission %</label>
                <input type="number" min="0" max="100" step="0.01" value={form.commission_pct}
                  onChange={e => setForm(f => ({ ...f, commission_pct: e.target.value }))} style={fieldInput} placeholder="8" />
              </div>

              <div>
                <label style={fieldLbl}>Region</label>
                <input value={form.region} onChange={e => setForm(f => ({ ...f, region: e.target.value }))} style={fieldInput} placeholder="South India" />
              </div>
              <div />

              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Address</label>
                <textarea value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} rows={2} style={{ ...fieldInput, resize: 'vertical' }} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={fieldLbl}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...fieldInput, resize: 'vertical' }} />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={() => { setDrawer(false); setConvertLeadId(''); }} style={toolBtn}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : convertLeadId ? 'Convert to Partner' : editingId ? 'Save Changes' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
