/**
 * IEM — Inquiry/Enquiry Management master.
 *
 * The file keeps its name (and the `Leads` page key in routes.jsx) on purpose:
 * menu_permissions rows key off the `crm.leads` page id, so renaming the module
 * would orphan every per-role View/Edit grant already configured against it.
 * The sidebar label is what changed.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import {
  Search, Plus, RefreshCw, X, Users, ArrowUpRight, Edit2,
  Upload, UserCheck, Trash2, CheckSquare, Square, Filter, Download,
  ChevronUp, ChevronDown, MessageSquare, Handshake,
} from 'lucide-react';
import {
  getLeads, createLead, updateLead, deleteLead, convertLead,
  bulkAssignLeads, importLeads, getLeadsSummary, getLeadsFilters, getLeadAnalytics,
  exportLeads, getLeadActivities, addLeadActivity,
} from '../services/crmService';
import { getEmployees } from '@/services/employeeService';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import { fmtL } from '@/utils/format';
import { fmtDate } from '@/utils/dateFormatter';
import './Leads.css';

// Includes Direct / Phone / IndiaMart, which live enquiries already carry but the
// form never offered — the same drift as the status list below. Without them those
// enquiries render on a fallback badge and the value is unpickable when editing.
const SOURCES     = ['Website', 'LinkedIn', 'Referral', 'Campaign', 'Cold Call',
                     'Exhibition', 'Tender Portal', 'Direct', 'Phone', 'IndiaMart', 'Manual'];
const INDUSTRIES  = ['Technology', 'Manufacturing', 'Retail', 'Healthcare', 'Finance', 'Construction', 'Education', 'Logistics', 'Media', 'Consulting', 'Other'];

// Includes Won / Lost / Negotiation, which existed in the data but were missing
// from this list — 8 of 15 live enquiries carried one of them and were therefore
// unreachable through the status tabs. 'Shelved' is an enquiry parked for later:
// deliberately distinct from Lost, and counted separately in the summary.
const STATUSES = [
  'New', 'Contacted', 'Qualified', 'Negotiation',
  'Won', 'Lost', 'Shelved', 'Unqualified', 'Converted',
];

const STATUS_META = {
  new:         { bg: '#eef2ff', color: '#4338ca', label: 'New' },
  contacted:   { bg: '#fef3c7', color: '#92400e', label: 'Contacted' },
  qualified:   { bg: '#f0fdf4', color: '#15803d', label: 'Qualified' },
  negotiation: { bg: '#ffedd5', color: '#c2410c', label: 'Negotiation' },
  won:         { bg: '#dcfce7', color: '#15803d', label: 'Won' },
  lost:        { bg: '#fef2f2', color: '#dc2626', label: 'Lost' },
  shelved:     { bg: '#f1f5f9', color: '#475569', label: 'Shelved' },
  unqualified: { bg: '#fef2f2', color: '#dc2626', label: 'Unqualified' },
  converted:   { bg: '#d1fae5', color: '#065f46', label: 'Converted' },
};
const sm = s => STATUS_META[(s || '').toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280', label: s || '—' };

const SOURCE_META = {
  website:         { bg: '#dbeafe', color: '#1d4ed8' },
  linkedin:        { bg: '#e0e7ff', color: '#4338ca' },
  referral:        { bg: '#fce7f3', color: '#9d174d' },
  campaign:        { bg: '#fef3c7', color: '#92400e' },
  'cold call':     { bg: '#f3e8ff', color: '#6B3FDB' },
  exhibition:      { bg: '#ccfbf1', color: '#0f766e' },
  'tender portal': { bg: '#ffe4e6', color: '#be123c' },
  direct:          { bg: '#e0f2fe', color: '#075985' },
  phone:           { bg: '#fef9c3', color: '#854d0e' },
  indiamart:       { bg: '#ede9fe', color: '#5b21b6' },
  manual:          { bg: '#f3f4f6', color: '#6b7280' },
};
const srcm = s => SOURCE_META[(s || '').toLowerCase()] || SOURCE_META.manual;

// Zone hues match SalesDashboard exactly so a zone keeps one identity across the
// app. "Unassigned" stays neutral — it is an absence, not a region.
const ZONE_COLORS = {
  North: '#6B3FDB', South: '#d97706', East: '#0d9488',
  West: '#db2777', Central: '#0284c7', Unassigned: '#9ca3af',
};
const ZONES = ['North', 'South', 'East', 'West', 'Central'];
const BRAND = '#6B3FDB';
const GRID  = { strokeDasharray: '3 3', stroke: '#f0f0f4' };
const TICK  = { fontSize: 11, fill: '#6b7280' };

// Lakh-denominated, matching the reference's "Value (Lac)" columns.
const toLac = n => (parseFloat(n) || 0) / 100000;
const fmtLac = n => toLac(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const scoreColor = n => {
  if (n >= 81) return { text: '#15803d', bar: '#10b981' };
  if (n >= 61) return { text: '#4d7c0f', bar: '#84cc16' };
  if (n >= 31) return { text: '#92400e', bar: '#f59e0b' };
  return { text: '#dc2626', bar: '#ef4444' };
};

const PAGE_SIZES = [25, 50, 100, 200];

const COLUMNS = [
  { key: 'iem_no',         label: 'IEM ID',      align: 'left'  },
  { key: 'company_name',   label: 'Customer',    align: 'left'  },
  { key: 'partner_name',   label: 'Partner',     align: 'left'  },
  { key: 'contact_person', label: 'Contact',     align: 'left'  },
  { key: 'lead_source',    label: 'Source Type', align: 'left'  },
  { key: 'phone',          label: 'Phone',       align: 'left'  },
  { key: 'email',          label: 'Email',       align: 'left'  },
  { key: 'lead_value',     label: 'Value',       align: 'right', numeric: true },
  { key: 'probability',    label: 'Prob %',      align: 'right', numeric: true },
  { key: 'status',         label: 'Status',      align: 'left'  },
];

const emptyForm = () => ({
  company_name: '', contact_person: '', email: '', phone: '',
  lead_source: 'Website', industry: '', status: 'New',
  lead_score: 50, location: '', notes: '', assigned_to: '',
  zone: '', estimated_value: '', partner_id: '', probability: '',
});

const emptyFilters = () => ({ user: '', partner: '', zone: '', fy: '', minValue: '', maxValue: '', probFrom: '', probTo: '' });

export default function Leads({ setPage }) {
  const { readOnly } = usePageAccess();
  const [leads,      setLeads]      = useState([]);
  const [summary,    setSummary]    = useState({ conversion_rate: 0, rows: [] });
  const [an,         setAn]         = useState(null);
  const [opts,       setOpts]       = useState({ users: [], partners: [], zones: [], fiscal_years: [] });
  const [employees,  setEmployees]  = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [drawer,     setDrawer]     = useState(null);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [exporting,  setExporting]  = useState(false);

  // Applied vs draft filters. `applied` is what the grid reflects and what the
  // chips describe; `draft` is the panel's working copy. Keeping them apart is
  // what lets a chip mean "this is in effect" rather than "this is typed in".
  const [applied,    setApplied]    = useState(emptyFilters());
  const [draft,      setDraft]      = useState(emptyFilters());
  const [panelOpen,  setPanelOpen]  = useState(false);

  const [sort,       setSort]       = useState({ key: 'iem_no', dir: 'desc' });
  const [page,       setPage_]      = useState(1);
  const [pageSize,   setPageSize]   = useState(25);

  const [convertModal, setConvertModal] = useState(null);
  const [convertForm,  setConvertForm]  = useState({ opportunity_name: '', expected_value: '', stage: 'Qualification', probability_percentage: 50 });
  const [converting,   setConverting]   = useState(false);

  const [selected,   setSelected]   = useState(new Set());
  const [bulkModal,  setBulkModal]  = useState(null);
  const [bulkOwner,  setBulkOwner]  = useState('');
  const [bulkWorking, setBulkWorking] = useState(false);

  // Notes / activity trail for one enquiry.
  const [notesFor,     setNotesFor]     = useState(null);
  const [activities,   setActivities]   = useState([]);
  const [actLoading,   setActLoading]   = useState(false);
  const [actForm,      setActForm]      = useState({ activity_type: 'note', notes: '', next_followup_date: '' });
  const [actSaving,    setActSaving]    = useState(false);

  const fileRef = useRef(null);
  const [importing, setImporting] = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Server-side filter params derived from the APPLIED set only.
  const queryParams = useCallback(() => {
    const p = {};
    if (fStatus)          p.status      = fStatus;
    if (applied.user)     p.assigned_to = applied.user;
    if (applied.partner)  p.partner_id  = applied.partner;
    if (applied.zone)     p.zone        = applied.zone;
    if (applied.fy)       p.fy          = applied.fy;
    if (applied.minValue !== '') p.min_value = applied.minValue;
    if (applied.maxValue !== '') p.max_value = applied.maxValue;
    if (applied.probFrom !== '') p.prob_min  = applied.probFrom;
    if (applied.probTo   !== '') p.prob_max  = applied.probTo;
    return p;
  }, [fStatus, applied]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = queryParams();
      // /leads/stats is deliberately not called: it has no year parameter, so its
      // counts described all time while everything else on the page describes one
      // fiscal year. The summary and analytics payloads cover the same ground,
      // scoped correctly.
      const [leadsData, summaryData, anData, empData] = await Promise.all([
        getLeads(params),
        getLeadsSummary({ assigned_to: applied.user || undefined, fy: applied.fy || undefined }),
        getLeadAnalytics({ assigned_to: applied.user || undefined, fy: applied.fy || undefined }),
        employees.length ? Promise.resolve(employees) : getEmployees({ status: 'active' }),
      ]);
      setLeads(Array.isArray(leadsData) ? leadsData : []);
      setSummary(summaryData ?? { conversion_rate: 0, rows: [] });
      setAn(anData);
      if (!employees.length) setEmployees(Array.isArray(empData) ? empData : []);
    } catch {
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, [queryParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage_(1); }, [applied, fStatus, search, pageSize]);

  // The Year filter is always a definite FY, never "all".
  //
  // The widget row is FY-shaped by construction — /analytics/lead-dashboard resolves
  // a single fiscal year and buckets monthwise inside it; it cannot express "all
  // years". Leaving the grid unfiltered while the charts silently defaulted to the
  // current FY put two different populations on one screen: the grid read 15
  // enquiries while the zone pie totalled 4. One definite year drives the grid, the
  // summary and the charts together, and the chip says which year you are looking at.
  useEffect(() => {
    getLeadsFilters().then(o => {
      setOpts(o);
      const years = o.fiscal_years || [];
      if (!years.length) return;
      // Mirror the analytics endpoint's own choice: the current FY when it carries
      // enquiries, else the most recent one that does — otherwise the page opens
      // blank every time the fiscal year rolls over.
      const now  = new Date();
      const cur  = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
      const pick = years.some(y => y.value === cur) ? cur : years[0].value;
      setApplied(a => (a.fy === '' ? { ...a, fy: pick } : a));
      setDraft(d   => (d.fy === '' ? { ...d, fy: pick } : d));
    });
  }, []);

  // ── Filters ───────────────────────────────────────────────────────────────
  const applyFilters = () => { setApplied(draft); setPanelOpen(false); };
  // Year survives a clear — it is the page's frame of reference, not a filter you
  // can be without. Clearing it would leave the charts on one year and the grid on
  // all of them.
  const clearFilters = () => {
    const base = { ...emptyFilters(), fy: applied.fy };
    setDraft(base); setApplied(base);
  };

  const openPanel = () => { setDraft(applied); setPanelOpen(true); };

  const nameOf = (list, id, key = 'name') =>
    list.find(x => String(x.id) === String(id))?.[key] || id;

  // One chip per applied filter, each independently removable. Value and
  // probability collapse their From/To pair into a single chip — they read as one
  // constraint to the user, so they clear as one.
  const chips = useMemo(() => {
    const out = [];
    if (applied.user)    out.push({ k: 'user',    label: `User: ${nameOf(opts.users, applied.user)}` });
    if (applied.partner) out.push({ k: 'partner', label: `Partner: ${nameOf(opts.partners, applied.partner)}` });
    if (applied.zone)    out.push({ k: 'zone',    label: `Zone: ${applied.zone}` });
    // The Year chip is always present and is not removable — there is no
    // all-years state for this page to fall back to.
    if (applied.fy) {
      const y = opts.fiscal_years.find(f => String(f.value) === String(applied.fy));
      out.push({ k: 'fy', label: `Year: ${y?.label || applied.fy}`, fixed: true });
    }
    if (applied.minValue !== '' || applied.maxValue !== '') {
      const lo = applied.minValue !== '' ? `${applied.minValue}L` : '0';
      const hi = applied.maxValue !== '' ? `${applied.maxValue}L` : '∞';
      out.push({ k: 'value', label: `Value: ${lo} – ${hi}` });
    }
    if (applied.probFrom !== '' || applied.probTo !== '') {
      const lo = applied.probFrom !== '' ? applied.probFrom : '0';
      const hi = applied.probTo   !== '' ? applied.probTo   : '100';
      out.push({ k: 'prob', label: `Probability: ${lo}% – ${hi}%` });
    }
    return out;
  }, [applied, opts]);

  const removeChip = k => {
    const next = { ...applied };
    if (k === 'value')      { next.minValue = ''; next.maxValue = ''; }
    else if (k === 'prob')  { next.probFrom = ''; next.probTo = ''; }
    else                    { next[k] = ''; }
    setApplied(next);
    setDraft(next);
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const openCreate = () => { setForm(emptyForm()); setDrawer('create'); };
  const openEdit   = lead => { setForm({ ...emptyForm(), ...lead }); setDrawer(lead); };

  const handleSubmit = async () => {
    if (!form.company_name || !form.contact_person) return showToast('Company and contact required', 'error');
    setSubmitting(true);
    try {
      if (drawer === 'create') {
        await createLead(form);
        showToast('Enquiry created');
      } else {
        await updateLead(drawer.id, form);
        showToast('Enquiry updated');
      }
      setDrawer(null);
      load();
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Save failed';
      showToast(msg, 'error');
    } finally { setSubmitting(false); }
  };

  const openConvertModal = lead => {
    // The enquiry's own value and probability seed the form — the backend carries
    // them forward anyway, so showing blanks here would imply they were lost.
    setConvertForm({
      opportunity_name: `${lead.company_name} — Opportunity`,
      expected_value: lead.estimated_value ?? '',
      stage: 'Qualification',
      probability_percentage: lead.probability ?? 50,
    });
    setConvertModal(lead);
  };

  const handleConvert = async () => {
    if (!convertForm.opportunity_name.trim()) return showToast('Opportunity name is required', 'error');
    setConverting(true);
    try {
      await convertLead(convertModal.id, convertForm);
      showToast(`${convertModal.company_name} converted to opportunity`);
      setConvertModal(null);
      load();
      if (setPage) setPage('OpportunitiesKanban');
    } catch (err) {
      showToast(err.response?.data?.error || 'Conversion failed — please try again', 'error');
    } finally { setConverting(false); }
  };

  const handleExport = async () => {
    setExporting(true);
    try { await exportLeads(queryParams()); }
    catch { showToast('Export failed', 'error'); }
    finally { setExporting(false); }
  };

  // ── Notes / activity ──────────────────────────────────────────────────────
  const openNotes = async (lead) => {
    setNotesFor(lead);
    setActForm({ activity_type: 'note', notes: '', next_followup_date: '' });
    setActLoading(true);
    try { setActivities(await getLeadActivities(lead.id)); }
    finally { setActLoading(false); }
  };

  const handleAddActivity = async () => {
    if (!actForm.notes.trim()) return showToast('Write a note first', 'error');
    setActSaving(true);
    try {
      await addLeadActivity(notesFor.id, {
        ...actForm,
        next_followup_date: actForm.next_followup_date || null,
      });
      setActForm({ activity_type: 'note', notes: '', next_followup_date: '' });
      setActivities(await getLeadActivities(notesFor.id));
      showToast('Note added');
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not add note', 'error');
    } finally { setActSaving(false); }
  };

  // ── Bulk ──────────────────────────────────────────────────────────────────
  const toggleSelect = id => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBulkAssign = async () => {
    if (!bulkOwner) return showToast('Select an employee first', 'error');
    setBulkWorking(true);
    try {
      await bulkAssignLeads(Array.from(selected), parseInt(bulkOwner));
      showToast(`${selected.size} enquir${selected.size !== 1 ? 'ies' : 'y'} assigned`);
      setSelected(new Set());
      setBulkModal(null);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Bulk assign failed', 'error');
    } finally { setBulkWorking(false); }
  };

  const handleBulkDelete = async () => {
    setBulkWorking(true);
    try {
      await Promise.all(Array.from(selected).map(id => deleteLead(id)));
      showToast(`${selected.size} enquir${selected.size !== 1 ? 'ies' : 'y'} deleted`);
      setSelected(new Set());
      setBulkModal(null);
      load();
    } catch {
      showToast('Bulk delete failed', 'error');
    } finally { setBulkWorking(false); }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    try {
      const result = await importLeads(file);
      showToast(`${result.imported} imported, ${result.skipped} skipped`);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Import failed', 'error');
    } finally { setImporting(false); }
  };

  // ── Sort / page. Search stays client-side over the already-filtered set. ───
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter(l =>
      [l.iem_no, l.company_name, l.contact_person, l.email, l.phone, l.partner_name]
        .some(v => (v || '').toString().toLowerCase().includes(q))
    );
  }, [leads, search]);

  const sorted = useMemo(() => {
    const col = COLUMNS.find(c => c.key === sort.key);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...searched].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (col?.numeric) return ((parseFloat(av) || 0) - (parseFloat(bv) || 0)) * dir;
      return (av || '').toString().localeCompare((bv || '').toString(), undefined, { numeric: true }) * dir;
    });
  }, [searched, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows   = sorted.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = key =>
    setSort(s => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  const allSelected  = pageRows.length > 0 && pageRows.every(r => selected.has(r.id));
  const someSelected = selected.size > 0;

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(pageRows.map(l => l.id)));
  };

  // ── Chart data ────────────────────────────────────────────────────────────
  const monthly  = an?.monthly   || [];
  const byZone   = an?.by_zone   || [];
  const byStatus = an?.by_status || [];
  const hasMonthly  = monthly.some(m => m.count > 0);
  const hasZone     = byZone.some(z => z.count > 0);
  const hasStatus   = byStatus.some(s => s.count > 0);

  const Empty = ({ msg }) => (
    <div className="ld-chart-empty">{msg}</div>
  );

  return (
    <div className="ld-root">

      {toast && <div className={`ld-toast ld-toast-${toast.type}`}>{toast.msg}</div>}
      {readOnly && <ReadOnlyBanner />}

      {/* Header */}
      <div className="ld-header">
        <div>
          <h2 className="ld-title">IEM — Enquiry Management</h2>
          <p className="ld-sub">{sorted.length} enquir{sorted.length !== 1 ? 'ies' : 'y'}</p>
        </div>
        <div className="ld-header-r">
          <button className="ld-icon-btn" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
          {!readOnly && (
            <>
              <button className="ld-btn-outline" onClick={() => fileRef.current?.click()} disabled={importing}>
                <Upload size={13} /> {importing ? 'Importing…' : 'Import CSV'}
              </button>
              <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImport} />
              <button className="ld-btn-primary" onClick={openCreate}><Plus size={14} /> New Enquiry</button>
            </>
          )}
        </div>
      </div>

      {/* ── Toolbar: Set Filter + applied chips ─────────────────────────── */}
      <div className="ld-toolbar">
        <button className={`ld-btn-outline${panelOpen ? ' ld-btn-active' : ''}`} onClick={() => panelOpen ? setPanelOpen(false) : openPanel()}>
          <Filter size={13} /> Set Filter
        </button>
        {chips.map(c => (
          <span key={c.k} className={`ld-chip${c.fixed ? ' ld-chip-fixed' : ''}`}>
            {c.label}
            {!c.fixed && <button onClick={() => removeChip(c.k)} title="Remove"><X size={11} /></button>}
          </span>
        ))}
        {chips.some(c => !c.fixed) && (
          <button className="ld-chip-clear" onClick={clearFilters}>Clear all</button>
        )}
      </div>

      {panelOpen && (
        <div className="ld-filter-panel">
          <div className="ld-filter-grid">
            <div className="ld-field">
              <label>User</label>
              <select value={draft.user} onChange={e => setDraft(d => ({ ...d, user: e.target.value }))}>
                <option value="">All users</option>
                {opts.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="ld-field">
              <label>Partner</label>
              <select value={draft.partner} onChange={e => setDraft(d => ({ ...d, partner: e.target.value }))}>
                <option value="">All partners</option>
                {opts.partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="ld-field">
              <label>Zone</label>
              <select value={draft.zone} onChange={e => setDraft(d => ({ ...d, zone: e.target.value }))}>
                <option value="">All zones</option>
                {(opts.zones.length ? opts.zones : ZONES).map(z => <option key={z} value={z}>{z}</option>)}
              </select>
            </div>
            {/* No "All years": the widget row can only render one fiscal year, so an
                all-years grid would contradict the charts beside it. */}
            <div className="ld-field">
              <label>Year (FY)</label>
              <select value={draft.fy} onChange={e => setDraft(d => ({ ...d, fy: e.target.value }))}>
                {opts.fiscal_years.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
              </select>
            </div>
            <div className="ld-field">
              <label>Value from (Lac)</label>
              <input type="number" min="0" value={draft.minValue}
                onChange={e => setDraft(d => ({ ...d, minValue: e.target.value }))} placeholder="0" />
            </div>
            <div className="ld-field">
              <label>Value to (Lac)</label>
              <input type="number" min="0" value={draft.maxValue}
                onChange={e => setDraft(d => ({ ...d, maxValue: e.target.value }))} placeholder="Any" />
            </div>
            <div className="ld-field">
              <label>Probability from (%)</label>
              <input type="number" min="0" max="100" value={draft.probFrom}
                onChange={e => setDraft(d => ({ ...d, probFrom: e.target.value }))} placeholder="0" />
            </div>
            <div className="ld-field">
              <label>Probability to (%)</label>
              <input type="number" min="0" max="100" value={draft.probTo}
                onChange={e => setDraft(d => ({ ...d, probTo: e.target.value }))} placeholder="100" />
            </div>
          </div>
          <div className="ld-filter-ft">
            <button className="ld-btn-outline" onClick={() => setDraft(d => ({ ...emptyFilters(), fy: d.fy }))}>Reset</button>
            <button className="ld-btn-primary" onClick={applyFilters}>Apply Filter</button>
          </div>
        </div>
      )}

      {/* ── Summary widgets ─────────────────────────────────────────────── */}
      <div className="ld-widgets">
        <div className="ld-widget">
          <h4>IEM Monthwise</h4>
          {hasMonthly ? (
            <ResponsiveContainer width="100%" height={190}>
              <BarChart data={monthly} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="month" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} width={30} />
                <Tooltip formatter={v => [v, 'Enquiries']} />
                <Bar dataKey="count" fill={BRAND} radius={[3, 3, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty msg="No enquiries in this period" />}
        </div>

        <div className="ld-widget">
          <h4>IEM by Zone</h4>
          {/* Slice labels are not enough on their own: recharts drops them once the
              slices get thin, which left six unlabelled wedges and no way to tell
              which zone was which. The legend carries the mapping instead. */}
          {hasZone ? (
            <div className="ld-donut">
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={byZone} dataKey="count" nameKey="zone" cx="50%" cy="50%"
                    innerRadius={34} outerRadius={60} paddingAngle={2}>
                    {byZone.map(z => (
                      <Cell key={z.zone} fill={ZONE_COLORS[z.zone] || '#9ca3af'} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [`${v} enquiries`, n]} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="ld-legend">
                {byZone.map(z => (
                  <li key={z.zone}>
                    <span className="ld-legend-dot" style={{ background: ZONE_COLORS[z.zone] || '#9ca3af' }} />
                    {z.zone}<strong>{z.count}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : <Empty msg="No zone data" />}
        </div>

        <div className="ld-widget">
          <h4>IEM Status</h4>
          {hasStatus ? (
            <ResponsiveContainer width="100%" height={190}>
              <BarChart data={byStatus} layout="vertical" margin={{ top: 4, right: 40, left: 4, bottom: 4 }}>
                <CartesianGrid {...GRID} horizontal={false} />
                <XAxis type="number" tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="status" tick={TICK} axisLine={false} tickLine={false} width={78} />
                <Tooltip formatter={v => [v, 'Enquiries']} />
                <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={18}>
                  {byStatus.map(s => (
                    <Cell key={s.status} fill={sm(s.status).color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty msg="No status data" />}
        </div>

        {/* Value / Estimate summary. Value is the opportunity-revalued figure;
            Estimate is what the enquiry was judged to be worth at entry. */}
        <div className="ld-widget">
          <h4>Value Summary</h4>
          <div className="ld-conv">
            <span>Conversion rate</span>
            <strong>{summary.conversion_rate ?? 0}%</strong>
          </div>
          <table className="ld-summary-table">
            <thead>
              <tr>
                <th />
                <th className="num">Count</th>
                <th className="num">Value (Lac)</th>
                <th className="num">Estimate (Lac)</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map(r => (
                <tr key={r.key} className={r.key === 'total' ? 'ld-sum-total' : ''}>
                  <td>{r.label}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{fmtLac(r.value)}</td>
                  <td className="num">{fmtLac(r.estimate)}</td>
                </tr>
              ))}
              {!summary.rows.length && (
                <tr><td colSpan={4} className="ld-sum-empty">No data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Status tabs */}
      <div className="ld-filters">
        <div className="ld-search">
          <Search size={14} />
          <input placeholder="Search IEM ID, customer, contact, partner…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="ld-tabs">
          {/* Tab counts come from the FY-scoped analytics, not from /leads/stats —
              stats has no year parameter, so it counted all time and the tabs
              disagreed with the grid and charts beside them. */}
          <button className={`ld-tab${!fStatus ? ' ld-tab-active' : ''}`} onClick={() => setFStatus('')}>
            All <span className="ld-tab-count">{summary.rows.find(r => r.key === 'total')?.count ?? 0}</span>
          </button>
          {STATUSES.map(s => {
            const key = s.toLowerCase();
            const n   = byStatus.find(x => (x.status || '').toLowerCase() === key)?.count ?? 0;
            // Statuses with no enquiries this year are hidden rather than shown as
            // dead zeroes — nine tabs of mostly-zero is noise, not information.
            if (!n && fStatus !== key) return null;
            return (
              <button key={s} className={`ld-tab${fStatus === key ? ' ld-tab-active' : ''}`}
                onClick={() => setFStatus(key)}>
                {s} <span className="ld-tab-count">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Grid toolbar */}
      <div className="ld-grid-toolbar">
        {someSelected && !readOnly && (
          <div className="ld-bulk-inline">
            <span>{selected.size} selected</span>
            <button className="ld-btn-outline" onClick={() => setBulkModal('assign')}><UserCheck size={13} /> Assign</button>
            <button className="ld-btn-danger" onClick={() => setBulkModal('delete')}><Trash2 size={13} /> Delete</button>
            <button className="ld-icon-btn" onClick={() => setSelected(new Set())}><X size={13} /></button>
          </div>
        )}
        <div className="ld-spacer" />
        <div className="ld-rows-sel">
          Rows
          <select value={pageSize} onChange={e => setPageSize(parseInt(e.target.value))}>
            {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button className="ld-btn-outline" onClick={handleExport} disabled={exporting || !sorted.length}>
          <Download size={13} /> {exporting ? 'Exporting…' : 'Excel'}
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="ld-loading"><div className="ld-spinner" /></div>
      ) : pageRows.length === 0 ? (
        <div className="ld-empty">
          <Users size={40} color="#d1d5db" />
          <p>No enquiries found</p>
          {!readOnly && <button className="ld-btn-primary" onClick={openCreate}><Plus size={14} /> Add Enquiry</button>}
        </div>
      ) : (
        <>
        <div className="ld-table-wrap">
          <table className="ld-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <button className="ld-check-btn" onClick={toggleSelectAll}>
                    {allSelected ? <CheckSquare size={14} color="#4338ca" /> : <Square size={14} />}
                  </button>
                </th>
                {COLUMNS.map(c => {
                  const active = sort.key === c.key;
                  return (
                    <th key={c.key} onClick={() => toggleSort(c.key)}
                      className={`ld-th-sort${active ? ' ld-th-active' : ''}`}
                      style={{ textAlign: c.align }}>
                      {c.label}
                      {active && (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </th>
                  );
                })}
                <th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map(lead => {
                const sc    = sm(lead.status);
                const src   = srcm(lead.lead_source);
                const score = parseInt(lead.lead_score) || 0;
                const sc2   = scoreColor(score);
                return (
                  <tr key={lead.id} className={`ld-row${selected.has(lead.id) ? ' ld-row-selected' : ''}`}>
                    <td>
                      <button className="ld-check-btn" onClick={() => toggleSelect(lead.id)}>
                        {selected.has(lead.id) ? <CheckSquare size={14} color="#4338ca" /> : <Square size={14} />}
                      </button>
                    </td>

                    {/* IEM ID + quick actions */}
                    <td>
                      <button className="ld-iem-link" onClick={() => openEdit(lead)} title="Open enquiry">
                        {lead.iem_no || '—'}
                      </button>
                      {/* Quick actions. Only affordances with something behind
                          them are rendered — a permanently-disabled icon reads as
                          a broken feature rather than an absent one. */}
                      <div className="ld-quick">
                        {!readOnly && (
                          <>
                            <button title="Edit" onClick={() => openEdit(lead)}><Edit2 size={11} /></button>
                            <button title="Assign owner" onClick={() => { setSelected(new Set([lead.id])); setBulkModal('assign'); }}>
                              <UserCheck size={11} />
                            </button>
                          </>
                        )}
                        <button title="Notes & activity" onClick={() => openNotes(lead)}>
                          <MessageSquare size={11} />
                        </button>
                      </div>
                    </td>

                    <td>
                      <div className="ld-company-cell">
                        <div className="ld-avatar">{(lead.company_name || '?').charAt(0)}</div>
                        <div>
                          <span className="ld-company">{lead.company_name}</span>
                          {lead.location && <span className="ld-location">{lead.location}</span>}
                        </div>
                      </div>
                    </td>

                    {/* Partner -> Partner Details */}
                    <td>
                      {lead.partner_name ? (
                        <button className="ld-partner-link"
                          onClick={() => setPage && setPage('SalesPartners')}
                          title="Open Partner Details">
                          <Handshake size={11} /> {lead.partner_name}
                        </button>
                      ) : <span className="ld-muted">—</span>}
                    </td>

                    <td>
                      <span className="ld-contact-name">{lead.contact_person}</span>
                      <span className="ld-contact-sub" style={{ color: sc2.text }}>Score {score}</span>
                    </td>

                    <td>
                      <span className="ld-badge" style={{ background: src.bg, color: src.color }}>
                        {lead.lead_source || '—'}
                      </span>
                    </td>

                    <td><span className="ld-mono">{lead.phone || '—'}</span></td>
                    <td><span className="ld-email">{lead.email || '—'}</span></td>
                    <td className="ld-num ld-value">{fmtL(lead.lead_value)}</td>
                    <td className="ld-num">{lead.probability != null ? `${lead.probability}%` : '—'}</td>

                    <td>
                      <span className="ld-badge" style={{ background: sc.bg, color: sc.color }}>
                        {sc.label}
                      </span>
                    </td>

                    <td>
                      <div className="ld-row-actions">
                        {readOnly ? <span className="ld-muted">View only</span> : (
                          lead.status?.toLowerCase() !== 'converted' && (
                            <button className="ld-convert-btn" title="Convert to Opportunity"
                              onClick={() => openConvertModal(lead)}>
                              <ArrowUpRight size={13} /> Convert
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="ld-pager">
            <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} of {sorted.length}</span>
            <div>
              <button disabled={page === 1} onClick={() => setPage_(p => p - 1)}>Prev</button>
              <span>Page {page} / {totalPages}</span>
              <button disabled={page === totalPages} onClick={() => setPage_(p => p + 1)}>Next</button>
            </div>
          </div>
        )}
        </>
      )}

      {/* Bulk assign */}
      {bulkModal === 'assign' && (
        <div className="ld-overlay" onClick={() => !bulkWorking && setBulkModal(null)}>
          <div className="ld-drawer" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="ld-drawer-hd">
              <h3>Assign {selected.size} Enquir{selected.size !== 1 ? 'ies' : 'y'}</h3>
              <button className="ld-icon-btn" onClick={() => setBulkModal(null)}><X size={16} /></button>
            </div>
            <div className="ld-drawer-body">
              <div className="ld-field">
                <label>Assign To</label>
                <select value={bulkOwner} onChange={e => setBulkOwner(e.target.value)}>
                  <option value="">Select employee…</option>
                  {employees.map(e => (
                    <option key={e.id} value={e.id}>{e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="ld-drawer-ft">
              <button className="ld-btn-outline" onClick={() => setBulkModal(null)} disabled={bulkWorking}>Cancel</button>
              <button className="ld-btn-primary" onClick={handleBulkAssign} disabled={bulkWorking}>
                {bulkWorking ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk delete */}
      {bulkModal === 'delete' && (
        <div className="ld-overlay" onClick={() => !bulkWorking && setBulkModal(null)}>
          <div className="ld-drawer" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="ld-drawer-hd">
              <h3>Delete {selected.size} Enquir{selected.size !== 1 ? 'ies' : 'y'}?</h3>
              <button className="ld-icon-btn" onClick={() => setBulkModal(null)}><X size={16} /></button>
            </div>
            <div className="ld-drawer-body">
              <p className="ld-muted-p">This cannot be undone. Selected enquiries will be soft-deleted.</p>
            </div>
            <div className="ld-drawer-ft">
              <button className="ld-btn-outline" onClick={() => setBulkModal(null)} disabled={bulkWorking}>Cancel</button>
              <button className="ld-btn-danger" onClick={handleBulkDelete} disabled={bulkWorking}>
                {bulkWorking ? 'Deleting…' : `Delete ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notes / activity trail */}
      {notesFor && (
        <div className="ld-overlay" onClick={() => setNotesFor(null)}>
          <div className="ld-drawer" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="ld-drawer-hd">
              <h3>Notes — {notesFor.iem_no || notesFor.company_name}</h3>
              <button className="ld-icon-btn" onClick={() => setNotesFor(null)}><X size={16} /></button>
            </div>
            <div className="ld-drawer-body">
              {!readOnly && (
                <>
                  <div className="ld-row2">
                    <div className="ld-field">
                      <label>Type</label>
                      <select value={actForm.activity_type}
                        onChange={e => setActForm(f => ({ ...f, activity_type: e.target.value }))}>
                        {['note', 'call', 'email', 'meeting', 'site visit'].map(t => <option key={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="ld-field">
                      <label>Next follow-up</label>
                      <input type="date" value={actForm.next_followup_date}
                        onChange={e => setActForm(f => ({ ...f, next_followup_date: e.target.value }))} />
                    </div>
                  </div>
                  <div className="ld-field">
                    <label>Note</label>
                    <textarea rows={3} value={actForm.notes}
                      onChange={e => setActForm(f => ({ ...f, notes: e.target.value }))}
                      placeholder="What happened on this enquiry…" />
                  </div>
                  <button className="ld-btn-primary" onClick={handleAddActivity} disabled={actSaving}
                    style={{ marginBottom: 16 }}>
                    <Plus size={13} /> {actSaving ? 'Adding…' : 'Add Note'}
                  </button>
                </>
              )}

              <div className="ld-act-list">
                {actLoading ? (
                  <div className="ld-chart-empty">Loading…</div>
                ) : activities.length === 0 ? (
                  <div className="ld-chart-empty">No activity recorded yet</div>
                ) : activities.map(a => (
                  <div key={a.id} className="ld-act">
                    <div className="ld-act-hd">
                      <span className="ld-act-type">{a.activity_type}</span>
                      <span className="ld-act-date">{fmtDate(a.activity_date)}</span>
                    </div>
                    {a.notes && <p className="ld-act-notes">{a.notes}</p>}
                    <div className="ld-act-ft">
                      {a.created_by_name && <span>by {a.created_by_name}</span>}
                      {a.next_followup_date && <span>follow-up {fmtDate(a.next_followup_date)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Convert */}
      {convertModal && (
        <div className="ld-overlay" onClick={() => !converting && setConvertModal(null)}>
          <div className="ld-drawer" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="ld-drawer-hd">
              <h3>Convert to Opportunity</h3>
              <button className="ld-icon-btn" onClick={() => !converting && setConvertModal(null)}><X size={16} /></button>
            </div>
            <div className="ld-drawer-body">
              <p className="ld-muted-p">
                Creating an opportunity for <strong>{convertModal.company_name}</strong>. Zone, notes and the
                original estimate carry across automatically.
              </p>
              <div className="ld-field">
                <label>Opportunity Name *</label>
                <input value={convertForm.opportunity_name}
                  onChange={e => setConvertForm(f => ({ ...f, opportunity_name: e.target.value }))}
                  placeholder="Brief description of the deal…" />
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Expected Value (₹)</label>
                  <input type="number" min="0" value={convertForm.expected_value}
                    onChange={e => setConvertForm(f => ({ ...f, expected_value: e.target.value }))}
                    placeholder="Carried from enquiry" />
                </div>
                <div className="ld-field">
                  <label>Probability %</label>
                  <input type="number" min="0" max="100" value={convertForm.probability_percentage}
                    onChange={e => setConvertForm(f => ({ ...f, probability_percentage: e.target.value }))} />
                </div>
              </div>
              <div className="ld-field">
                <label>Pipeline Stage</label>
                <select value={convertForm.stage} onChange={e => setConvertForm(f => ({ ...f, stage: e.target.value }))}>
                  {['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won'].map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="ld-drawer-ft">
              <button className="ld-btn-outline" onClick={() => setConvertModal(null)} disabled={converting}>Cancel</button>
              <button className="ld-btn-primary" onClick={handleConvert} disabled={converting}>
                {converting ? 'Converting…' : 'Convert to Opportunity'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit */}
      {drawer !== null && (
        <div className="ld-overlay" onClick={() => setDrawer(null)}>
          <div className="ld-drawer" onClick={e => e.stopPropagation()}>
            <div className="ld-drawer-hd">
              <h3>{drawer === 'create' ? 'New Enquiry' : `Edit ${drawer.iem_no || 'Enquiry'}`}</h3>
              <button className="ld-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="ld-drawer-body">
              {drawer !== 'create' && drawer.iem_no && (
                <div className="ld-iem-badge">IEM ID · {drawer.iem_no}</div>
              )}
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Company Name *</label>
                  <input value={form.company_name}
                    onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))} placeholder="Company…" />
                </div>
                <div className="ld-field">
                  <label>Contact Person *</label>
                  <input value={form.contact_person}
                    onChange={e => setForm(f => ({ ...f, contact_person: e.target.value }))} placeholder="Full name…" />
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Email</label>
                  <input type="email" value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="email@…" />
                </div>
                <div className="ld-field">
                  <label>Phone</label>
                  <input value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+91…" />
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Source Type</label>
                  <select value={form.lead_source} onChange={e => setForm(f => ({ ...f, lead_source: e.target.value }))}>
                    {SOURCES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div className="ld-field">
                  <label>Partner</label>
                  <select value={form.partner_id || ''}
                    onChange={e => setForm(f => ({ ...f, partner_id: e.target.value }))}>
                    <option value="">None (direct)</option>
                    {opts.partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Industry</label>
                  <select value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))}>
                    <option value="">Select…</option>
                    {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
                  </select>
                </div>
                <div className="ld-field">
                  <label>Status</label>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    {STATUSES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Lead Score (0–100)</label>
                  <input type="number" min="0" max="100" value={form.lead_score}
                    onChange={e => setForm(f => ({ ...f, lead_score: e.target.value }))} />
                </div>
                <div className="ld-field">
                  <label>Probability (%)</label>
                  <input type="number" min="0" max="100" value={form.probability ?? ''}
                    onChange={e => setForm(f => ({ ...f, probability: e.target.value }))}
                    placeholder="Chance of winning" />
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Location</label>
                  <input value={form.location}
                    onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="City, State…" />
                </div>
                <div className="ld-field">
                  <label>Zone</label>
                  <select value={form.zone || ''} onChange={e => setForm(f => ({ ...f, zone: e.target.value }))}>
                    <option value="">Select…</option>
                    {ZONES.map(z => <option key={z}>{z}</option>)}
                  </select>
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Estimated Value (₹)</label>
                  <input type="number" min="0" step="1000" value={form.estimated_value ?? ''}
                    onChange={e => setForm(f => ({ ...f, estimated_value: e.target.value }))} placeholder="Deal size…" />
                </div>
                <div className="ld-field">
                  <label>Assign To</label>
                  <select value={form.assigned_to || ''}
                    onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}>
                    <option value="">Auto (me)</option>
                    {employees.map(e => (
                      <option key={e.id} value={e.id}>{e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="ld-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Any notes about this enquiry…" />
              </div>
            </div>
            <div className="ld-drawer-ft">
              <button className="ld-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="ld-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : drawer === 'create' ? 'Create Enquiry' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
