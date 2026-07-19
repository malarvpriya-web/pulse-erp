import { useEffect, useState, useCallback, useMemo } from 'react';
import { usePagination } from '@/features/_shared/usePagination';
import Pagination from '@/features/_shared/Pagination';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import { fmtDate } from '@/utils/dateFormatter';
import { Download, FileText, ListChecks, History, MessageSquare } from 'lucide-react';

const fmt = (n) => (parseFloat(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const STATUS_COLOR = {
  planned:     { bg: '#fef9c3', color: '#854d0e' },
  released:    { bg: '#e0f2fe', color: '#0369a1' },
  in_progress: { bg: '#dbeafe', color: '#1e40af' },
  on_hold:     { bg: '#fef3c7', color: '#d97706' },
  completed:   { bg: '#dcfce7', color: '#166534' },
  cancelled:   { bg: '#fee2e2', color: '#991b1b' },
};
const PRIORITY_COLOR = {
  low:      { bg: '#f3f4f6', color: '#6b7280' },
  medium:   { bg: '#fef9c3', color: '#854d0e' },
  high:     { bg: '#fed7aa', color: '#9a3412' },
  critical: { bg: '#fee2e2', color: '#991b1b' },
};

const PRIORITIES = ['low', 'medium', 'high', 'critical'];

// Statuses that offer an Edit affordance. The server (execution.routes.js
// PUT /orders/:id) additionally restricts `released` to super_admin and rejects
// in_progress/completed outright — it returns the reason, so don't duplicate the
// role check here.
const EDITABLE_STATUSES = ['planned', 'released', 'on_hold'];

const emptyForm = {
  product_name: '', quantity_planned: '', priority: 'medium',
  planned_start_date: '', planned_end_date: '', bom_id: '', batch_number: '', notes: '',
};

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The batch year. There is no year column — it is derived, so it can never drift
// from the dates it is read off.
const orderYear = (o) => {
  const d = o.planned_start_date || o.created_at;
  return d ? String(d).slice(0, 4) : '';
};

// "Delayed" is NOT a status — it is derived. This mirrors isDelayedExpr in
// execution.routes.js so the grid and the dashboard's Delayed KPI cannot disagree.
const isDelayed = (o) =>
  !['completed', 'cancelled'].includes(o.status) &&
  !!o.planned_end_date &&
  String(o.planned_end_date).slice(0, 10) < todayISO();

// key === null → not sortable. `num` sorts numerically rather than lexically.
const COLUMNS = [
  { key: 'production_order_no', label: 'MPP ID' },
  { key: '_year',              label: 'Year' },
  { key: 'batch_number',       label: 'Batch No' },
  { key: 'product_name',       label: 'Product' },
  { key: 'quantity_planned',   label: 'Quantity',     num: true, right: true },
  { key: 'quantity_completed', label: 'Produced Qty', num: true, right: true },
  { key: 'work_centre_name',   label: 'Work Centre' },
  { key: 'planned_start_date', label: 'Start' },
  { key: 'planned_end_date',   label: 'End' },
  { key: 'notes',              label: 'Remarks' },
  { key: 'status',             label: 'Status' },
  { key: 'priority',           label: 'Priority' },
  { key: null,                 label: 'Actions' },
];

const sortValue = (o, key, col) => {
  if (key === '_year') return orderYear(o);
  const v = o[key];
  if (col?.num) return parseFloat(v) || 0;
  return v == null ? '' : String(v).toLowerCase();
};

function StatusBadge({ s }) {
  const c = STATUS_COLOR[s] || { bg: '#f3f4f6', color: '#374151' };
  return <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: c.bg, color: c.color }}>{(s || '').replace(/_/g, ' ')}</span>;
}
function PriorityBadge({ p }) {
  const c = PRIORITY_COLOR[p] || PRIORITY_COLOR.medium;
  return <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: c.bg, color: c.color }}>{p}</span>;
}
function DelayedBadge() {
  return <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>delayed</span>;
}

export default function ProductionOrders({ setPage, setSelectedProduction }) {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [orders, setOrders]     = useState([]);
  const [stats,  setStats]      = useState({});
  const [loading, setLoading]   = useState(true);
  const [statusFilter, setFilter] = useState('');
  const [search,  setSearch]    = useState('');
  const [drawer,  setDrawer]    = useState(null);
  const [form,    setForm]      = useState(emptyForm);
  const [boms,    setBoms]      = useState([]);
  const [saving,  setSaving]    = useState(false);
  const [confirmModal, setConfirm] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [notesRow, setNotesRow] = useState(null);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search)       params.search = search;
      const [ordersRes, statsRes] = await Promise.all([
        api.get('/production/orders', { params }),
        api.get('/production/orders/stats'),
      ]);
      setOrders(Array.isArray(ordersRes.data) ? ordersRes.data : []);
      setStats(statsRes.data || {});
    } catch (e) {
      toast.error('Failed to load production orders');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => { load(); }, [load]);

  const toggleSort = (key) => {
    if (!key) return;
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  };

  const sorted = useMemo(() => {
    const { key, dir } = sort;
    const col = COLUMNS.find(c => c.key === key);
    return [...orders].sort((a, b) => {
      const va = sortValue(a, key, col);
      const vb = sortValue(b, key, col);
      const ea = va === '' || va == null;
      const eb = vb === '' || vb == null;
      if (ea && eb) return 0;
      if (ea) return 1;          // blanks always sort last, whichever direction
      if (eb) return -1;
      const c = col?.num ? va - vb : String(va).localeCompare(String(vb));
      return dir === 'asc' ? c : -c;
    });
  }, [orders, sort]);

  const { page, totalPages, slice, next, prev, goTo, pageSize, setPageSize, total } = usePagination(sorted, 20);

  const selected = orders.find(o => o.id === selectedId) || null;
  const canEditSelected = !!selected && EDITABLE_STATUSES.includes(selected.status);

  const openCreate = () => {
    setForm(emptyForm);
    setDrawer('create');
    api.get('/bom/bom').then(r => setBoms(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  };

  const openEdit = (o) => {
    setForm({
      product_name:       o.product_name || '',
      quantity_planned:   o.quantity_planned || '',
      priority:           o.priority || 'medium',
      planned_start_date: o.planned_start_date ? String(o.planned_start_date).slice(0, 10) : '',
      planned_end_date:   o.planned_end_date   ? String(o.planned_end_date).slice(0, 10)   : '',
      bom_id:             o.bom_id || '',
      batch_number:       o.batch_number || '',
      notes:              o.notes || '',
    });
    setDrawer(o);
    api.get('/bom/bom').then(r => setBoms(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  };

  const openDetail = (o, tab) => {
    if (!setSelectedProduction) return;
    setSelectedProduction(tab ? { ...o, _initialTab: tab } : o);
    setPage('ProductionDetail');
  };

  const handleSubmit = async () => {
    if (!form.product_name || !form.quantity_planned) return toast.error('Product name and quantity are required');
    setSaving(true);
    try {
      const payload = {
        ...form,
        bom_id:          form.bom_id ? form.bom_id : null,
        batch_number:    form.batch_number || null,
        quantity_planned: parseFloat(form.quantity_planned),
        planned_start_date: form.planned_start_date || null,
        planned_end_date:   form.planned_end_date   || null,
      };
      if (drawer === 'create') {
        await api.post('/production/orders', payload);
        toast.success('Production order created');
      } else {
        await api.put(`/production/orders/${drawer.id}`, payload);
        toast.success('Production order updated');
      }
      setDrawer(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to save order');
    } finally {
      setSaving(false);
    }
  };

  // PUT /orders/:id overwrites every column from the body — sending only `notes`
  // would null out product_name and the dates. Always send the whole record.
  const saveNotes = async (o, text) => {
    try {
      await api.put(`/production/orders/${o.id}`, {
        product_name:       o.product_name,
        quantity_planned:   o.quantity_planned,
        priority:           o.priority,
        planned_start_date: o.planned_start_date,
        planned_end_date:   o.planned_end_date,
        bom_id:             o.bom_id,
        serial_number:      o.serial_number,
        batch_number:       o.batch_number,
        customer_ref:       o.customer_ref,
        notes:              text,
      });
      toast.success('Remarks saved');
      setNotesRow(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to save remarks');
    }
  };

  const doAction = async (action, order, extra = {}) => {
    try {
      if (action === 'start') {
        await api.patch(`/production/orders/${order.id}/start`);
        toast.success(`Order ${order.production_order_no} started`);
      } else if (action === 'plan') {
        await api.patch(`/production/orders/${order.id}/plan`);
        toast.success(`Order ${order.production_order_no} planned`);
      } else if (action === 'complete') {
        await api.patch(`/production/orders/${order.id}/complete`, extra);
        toast.success(`Order ${order.production_order_no} completed`);
      } else if (action === 'issue-materials') {
        await api.patch(`/production/orders/${order.id}/issue-materials`);
        toast.success('Materials issued');
      } else if (action === 'release') {
        await api.post(`/production/orders/${order.id}/release`);
        toast.success(`Order released`);
      } else if (action === 'cancel') {
        await api.post(`/production/orders/${order.id}/cancel`, { reason: extra.reason || '' });
        toast.success('Order cancelled');
      } else if (action === 'resume') {
        await api.post(`/production/orders/${order.id}/resume`);
        toast.success('Order resumed');
      }
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || `Action failed: ${action}`);
    }
  };

  /* ── Exports — the sorted+filtered set the user is looking at, not just the page ── */
  const exportRows = () => sorted.map(o => ({
    'MPP ID':       o.production_order_no || '',
    'Year':         orderYear(o),
    'Batch No':     o.batch_number || '',
    'Product':      o.product_name || '',
    'Quantity':     o.quantity_planned ?? '',
    'Produced Qty': o.quantity_completed ?? '',
    'Work Centre':  o.work_centre_name || '',
    'Start':        o.planned_start_date ? fmtDate(o.planned_start_date) : '',
    'End':          o.planned_end_date ? fmtDate(o.planned_end_date) : '',
    'Remarks':      o.notes || '',
    'Status':       isDelayed(o) ? `${o.status} (delayed)` : (o.status || ''),
    'Priority':     o.priority || '',
  }));

  const download = (content, ext, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ModuleProductionBatches_${todayISO()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = () => {
    const rows = exportRows();
    if (!rows.length) return toast.error('Nothing to export');
    const heads = Object.keys(rows[0]);
    const esc = (v) => {
      const s = String(v ?? '').replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [heads.join(','), ...rows.map(r => heads.map(h => esc(r[h])).join(','))].join('\n');
    download(csv, 'csv', 'text/csv;charset=utf-8;');
  };

  const exportPdf = () => {
    const rows = exportRows();
    if (!rows.length) return toast.error('Nothing to export');
    const heads = Object.keys(rows[0]);
    const esc = (v) => String(v ?? '').replace(/</g, '&lt;');
    const thead = heads.map(h => `<th>${h}</th>`).join('');
    const tbody = rows.map(r => `<tr>${heads.map(h => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) { toast.error('Allow pop-ups to export PDF'); return; }
    w.document.write(`<!doctype html><html><head><title>Module Production Batches</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1f2937}
        h1{font-size:18px;margin:0 0 4px}p{font-size:12px;color:#6b7280;margin:0 0 16px}
        table{width:100%;border-collapse:collapse;font-size:10px}
        th,td{border:1px solid #e5e7eb;padding:5px 7px;text-align:left;white-space:nowrap}
        th{background:#f3f4f6}
      </style></head><body>
      <h1>Module Production Batches</h1>
      <p>${rows.length} batch${rows.length > 1 ? 'es' : ''} &middot; ${fmtDate(new Date())}</p>
      <table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
  };

  const kpiPills = [
    { label: 'All',         key: '',            val: stats.total      || 0, color: '#6366f1' },
    { label: 'Planned',     key: 'planned',     val: stats.planned    || 0, color: '#f59e0b' },
    { label: 'Released',    key: 'released',    val: stats.released   || 0, color: '#0ea5e9' },
    { label: 'In Progress', key: 'in_progress', val: stats.in_progress|| 0, color: '#8b5cf6' },
    { label: 'On Hold',     key: 'on_hold',     val: stats.on_hold    || 0, color: '#d97706' },
    { label: 'Completed',   key: 'completed',   val: stats.completed  || 0, color: '#10b981' },
    { label: 'Cancelled',   key: 'cancelled',   val: stats.cancelled  || 0, color: '#ef4444' },
  ];

  const tbBtn = (label, onClick, enabled, icon) => (
    <button key={label} onClick={onClick} disabled={!enabled}
      style={{
        padding: '7px 13px', borderRadius: 8, fontSize: 13, fontWeight: 600,
        border: '1px solid #e5e7eb', background: enabled ? '#fff' : '#f9fafb',
        color: enabled ? '#374151' : '#c0c4cc', cursor: enabled ? 'pointer' : 'not-allowed',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>{icon}{label}</button>
  );

  const th = { padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' };

  return (
    <div style={{ padding: 24 }}>
      {readOnly && <ReadOnlyBanner />}
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>Module Production Batches</h2>
          <p style={{ margin: 0, fontSize: 12.5, color: '#6b7280' }}>
            Each batch is one production order (MPP) · feeds the Advanced Production Dashboard
          </p>
        </div>
        <button onClick={load} style={{ padding: '8px 14px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>↻ Refresh</button>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {!readOnly && (
          <button onClick={openCreate}
            style={{ padding: '7px 14px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>+ New</button>
        )}
        {!readOnly && tbBtn('Edit', () => openEdit(selected), canEditSelected)}
        {tbBtn('Excel', exportExcel, sorted.length > 0, <Download size={14} />)}
        {tbBtn('PDF', exportPdf, sorted.length > 0, <FileText size={14} />)}
        {tbBtn('Open Requests', () => setPage('ProductionModuleRequests'), true)}
        <input
          placeholder="Search by MPP ID, batch no or product…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 220, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
        />
      </div>

      {/* Status Filter Pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {kpiPills.map(({ label, key, val, color }) => (
          <button key={key} onClick={() => setFilter(key)}
            style={{
              padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${color}30`,
              background: statusFilter === key ? color : '#fff',
              color: statusFilter === key ? '#fff' : color,
            }}>
            {label} <span style={{ fontWeight: 700, marginLeft: 4 }}>{val}</span>
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : slice.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
          {statusFilter || search ? 'No batches match the filter.' : 'No production batches yet. Create one to get started.'}
        </div>
      ) : (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ ...th, width: 36 }}></th>
                  {COLUMNS.map(c => {
                    const active = sort.key === c.key;
                    return (
                      <th key={c.label}
                        onClick={() => toggleSort(c.key)}
                        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        style={{
                          ...th,
                          textAlign: c.right ? 'right' : 'left',
                          cursor: c.key ? 'pointer' : 'default',
                          color: active ? '#6B3FDB' : '#6b7280',
                          userSelect: 'none',
                        }}>
                        {c.label}
                        {c.key && <span style={{ marginLeft: 4, opacity: active ? 1 : 0.25 }}>{active && sort.dir === 'desc' ? '▼' : '▲'}</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {slice.map(o => {
                  const isSel = o.id === selectedId;
                  const delayed = isDelayed(o);
                  return (
                    <tr key={o.id} onClick={() => setSelectedId(o.id)}
                      style={{ borderTop: '1px solid #f0f0f4', cursor: 'pointer', background: isSel ? '#f5f3ff' : '#fff' }}>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        <input type="radio" checked={isSel} readOnly aria-label={`Select ${o.production_order_no}`} />
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6B3FDB', fontWeight: 700, whiteSpace: 'nowrap' }}
                        onClick={() => openDetail(o)}>
                        {o.production_order_no || o.id}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{orderYear(o) || '—'}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: o.batch_number ? '#111827' : '#9ca3af', fontWeight: o.batch_number ? 600 : 400 }}>
                            {o.batch_number || '—'}
                          </span>
                          <IconBtn title="Operations checklist" onClick={() => openDetail(o, 'operations')}><ListChecks size={14} /></IconBtn>
                          <IconBtn title="Process timeline / history" onClick={() => openDetail(o, 'overview')}><History size={14} /></IconBtn>
                          <IconBtn title="Remarks" onClick={() => setNotesRow(o)}>
                            <MessageSquare size={14} />
                            {o.notes && <span style={{ position: 'absolute', top: 1, right: 1, width: 5, height: 5, borderRadius: '50%', background: '#6B3FDB' }} />}
                          </IconBtn>
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#111827', maxWidth: 200 }}>{o.product_name}</td>
                      <td style={{ padding: '10px 14px', color: '#374151', fontWeight: 600, textAlign: 'right' }}>{fmt(o.quantity_planned)}</td>
                      <td style={{ padding: '10px 14px', color: '#374151', textAlign: 'right' }}>{fmt(o.quantity_completed)}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{o.work_centre_name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {o.planned_start_date ? fmtDate(o.planned_start_date) : '—'}
                      </td>
                      <td style={{ padding: '10px 14px', color: delayed ? '#dc2626' : '#6b7280', whiteSpace: 'nowrap', fontWeight: delayed ? 600 : 400 }}>
                        {o.planned_end_date ? fmtDate(o.planned_end_date) : '—'}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={o.notes || ''}>
                        {o.notes || '—'}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <StatusBadge s={o.status} />
                          {delayed && <DelayedBadge />}
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px' }}><PriorityBadge p={o.priority} /></td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {readOnly ? (
                            <ActionBtn label="View Details" color="#6B3FDB" onClick={() => openDetail(o)} />
                          ) : (<>
                          {o.status === 'planned' && <>
                            <ActionBtn label="Start"     color="#8b5cf6" onClick={() => doAction('start', o)} />
                            <ActionBtn label="Release"   color="#0ea5e9" onClick={() => doAction('release', o)} />
                            <ActionBtn label="Edit"      color="#6b7280" onClick={() => openEdit(o)} />
                            <ActionBtn label="Cancel"    color="#ef4444" onClick={() => setConfirm({ action: 'cancel', order: o })} />
                          </>}
                          {o.status === 'released' && <>
                            <ActionBtn label="Start"           color="#8b5cf6" onClick={() => doAction('start', o)} />
                            <ActionBtn label="Issue Materials" color="#d97706" onClick={() => doAction('issue-materials', o)} />
                            <ActionBtn label="Edit"            color="#6b7280" onClick={() => openEdit(o)} />
                            <ActionBtn label="Cancel"          color="#ef4444" onClick={() => setConfirm({ action: 'cancel', order: o })} />
                          </>}
                          {o.status === 'in_progress' && <>
                            <ActionBtn label="Complete"        color="#10b981" onClick={() => setConfirm({ action: 'complete', order: o })} />
                            <ActionBtn label="Issue Materials" color="#d97706" onClick={() => doAction('issue-materials', o)} />
                          </>}
                          {o.status === 'on_hold' && <>
                            <ActionBtn label="Resume" color="#6366f1" onClick={() => doAction('resume', o)} />
                            <ActionBtn label="Edit"   color="#6b7280" onClick={() => openEdit(o)} />
                          </>}
                          {o.status === 'completed' && <>
                            <ActionBtn label="View Details" color="#6B3FDB" onClick={() => openDetail(o)} />
                          </>}
                          </>)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize}
            onNext={next} onPrev={prev} onGoTo={goTo} onPageSizeChange={setPageSize} />
        </div>
      )}

      {/* Remarks viewer / editor */}
      {notesRow && (
        <NotesModal
          order={notesRow}
          readOnly={readOnly || !EDITABLE_STATUSES.includes(notesRow.status)}
          onSave={(text) => saveNotes(notesRow, text)}
          onClose={() => setNotesRow(null)}
        />
      )}

      {/* Create/Edit Drawer */}
      {drawer !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
          onClick={() => setDrawer(null)}>
          <div style={{ width: 460, background: '#fff', height: '100%', overflowY: 'auto', padding: 24, boxShadow: '-4px 0 20px rgba(0,0,0,0.1)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
                {drawer === 'create' ? 'New Production Batch' : `Edit ${drawer.production_order_no || 'Batch'}`}
              </h3>
              <button onClick={() => setDrawer(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>

            {[
              { key: 'product_name', label: 'Product Name *', type: 'text', placeholder: 'e.g. HVDC Converter Unit' },
              { key: 'quantity_planned', label: 'Planned Quantity *', type: 'number', placeholder: '10' },
              { key: 'batch_number', label: 'Batch No', type: 'text', placeholder: 'e.g. B-2026-001' },
            ].map(({ key, label, type, placeholder }) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>{label}</label>
                <input type={type} placeholder={placeholder} value={form[key]}
                  onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            ))}

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>BOM (optional)</label>
              <select value={form.bom_id} onChange={e => setForm(p => ({ ...p, bom_id: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
                <option value="">— No BOM —</option>
                {boms.map(b => (
                  <option key={b.id} value={b.id}>{b.product_name} v{b.version}</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Priority</label>
              <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
                {PRIORITIES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              {[['planned_start_date','Planned Start'],['planned_end_date','Planned End']].map(([key,lbl]) => (
                <div key={key}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>{lbl}</label>
                  <input type="date" value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Remarks</label>
              <textarea rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDrawer(null)} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSubmit} disabled={saving || !form.product_name || !form.quantity_planned}
                style={{ padding: '8px 20px', background: saving ? '#c4b5fd' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8,
                  cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                {saving ? 'Saving…' : 'Save Batch'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Confirm Modal */}
      {confirmModal?.action === 'complete' && (
        <CompleteModal
          order={confirmModal.order}
          onConfirm={(produced_qty) => { doAction('complete', confirmModal.order, { produced_qty }); setConfirm(null); }}
          onClose={() => setConfirm(null)}
        />
      )}

      {/* Cancel Confirm Modal */}
      {confirmModal?.action === 'cancel' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px', color: '#dc2626', fontSize: 16 }}>Cancel Production Batch?</h3>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>
              Cancel <strong>{confirmModal.order.production_order_no}</strong> — {confirmModal.order.product_name}?
              All material reservations will be released and this cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirm(null)}
                style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Keep Batch
              </button>
              <button onClick={() => { doAction('cancel', confirmModal.order); setConfirm(null); }}
                style={{ padding: '8px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Cancel Batch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconBtn({ title, onClick, children }) {
  return (
    <button title={title} aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, padding: 0, border: '1px solid #e5e7eb', borderRadius: 6,
        background: '#fff', color: '#6b7280', cursor: 'pointer',
      }}>
      {children}
    </button>
  );
}

function ActionBtn({ label, color, onClick }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} style={{
      padding: '3px 10px', border: `1px solid ${color}40`, borderRadius: 6,
      background: '#fff', color, cursor: 'pointer', fontSize: 11, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </button>
  );
}

function NotesModal({ order, readOnly, onSave, onClose }) {
  const [text, setText] = useState(order.notes || '');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, padding: 24, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, color: '#1f2937' }}>Remarks</h3>
        <p style={{ fontSize: 12.5, color: '#6b7280', margin: '0 0 14px' }}>
          <strong>{order.production_order_no}</strong> — {order.product_name}
        </p>
        {readOnly ? (
          <div style={{ fontSize: 13, color: order.notes ? '#374151' : '#9ca3af', background: '#f9fafb',
            border: '1px solid #f0f0f4', borderRadius: 8, padding: 12, minHeight: 80, whiteSpace: 'pre-wrap' }}>
            {order.notes || 'No remarks.'}
          </div>
        ) : (
          <textarea rows={5} value={text} onChange={e => setText(e.target.value)} autoFocus
            placeholder="Add a remark…"
            style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
        )}
        {readOnly && !['completed', 'cancelled'].includes(order.status) && (
          <p style={{ fontSize: 11.5, color: '#9ca3af', margin: '8px 0 0' }}>
            Remarks are read-only once a batch is {order.status.replace(/_/g, ' ')}.
          </p>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Close</button>
          {!readOnly && (
            <button onClick={() => onSave(text)}
              style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CompleteModal({ order, onConfirm, onClose }) {
  const [qty, setQty] = useState(String(order.quantity_planned || ''));
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 360, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <h3 style={{ margin: '0 0 16px', color: '#1f2937', fontSize: 16 }}>Complete Batch</h3>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 14px' }}>
          <strong>{order.production_order_no}</strong> — {order.product_name}
        </p>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Produced Quantity</label>
        <input type="number" value={qty} onChange={e => setQty(e.target.value)} min={0}
          style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', marginBottom: 20 }} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={() => onConfirm(parseFloat(qty) || order.quantity_planned)}
            style={{ padding: '8px 20px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Mark Complete
          </button>
        </div>
      </div>
    </div>
  );
}
