import { useEffect, useState, useCallback } from 'react';
import { usePagination } from '@/features/_shared/usePagination';
import Pagination from '@/features/_shared/Pagination';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import { formatDateTime } from '@/utils/dateFormatter';

const fmtQty = (n) => (parseFloat(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const STATUS_COLOR = {
  draft:              { bg: '#f3f4f6', color: '#374151' },
  submitted:          { bg: '#e0f2fe', color: '#0369a1' },
  partially_assigned: { bg: '#fef3c7', color: '#d97706' },
  completed:          { bg: '#dcfce7', color: '#166534' },
  cancelled:          { bg: '#fee2e2', color: '#991b1b' },
};

const emptyLine = { module_spec: '', unit: 'No.', requested_qty: '' };
const emptyForm = { project_id: '', notes: '', lines: [{ ...emptyLine }] };

function StatusBadge({ s }) {
  const c = STATUS_COLOR[s] || { bg: '#f3f4f6', color: '#374151' };
  return <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: c.bg, color: c.color }}>{(s || '').replace(/_/g, ' ')}</span>;
}

export default function ProductionModuleRequests() {
  const toast = useToast();
  const { readOnly } = usePageAccess();
  const [rows, setRows]           = useState([]);
  const [stats, setStats]         = useState({});
  const [loading, setLoading]     = useState(true);
  const [statusFilter, setFilter] = useState('');
  const [search, setSearch]       = useState('');
  const [selectedId, setSelected] = useState(null);
  const [drawer, setDrawer]       = useState(null); // 'create' | 'edit' | 'assign' | 'view'
  const [form, setForm]           = useState(emptyForm);
  const [detail, setDetail]       = useState(null);  // full record for assign/view/edit
  const [projects, setProjects]   = useState([]);
  const [orders, setOrders]       = useState([]);
  const [assignPO, setAssignPO]   = useState('');
  const [assignMap, setAssignMap] = useState({});    // { line_id: qty }
  const [saving, setSaving]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search)       params.search = search;
      const [listRes, statsRes] = await Promise.all([
        api.get('/imr', { params }),
        api.get('/imr/stats'),
      ]);
      setRows(Array.isArray(listRes.data) ? listRes.data : []);
      setStats(statsRes.data || {});
    } catch {
      toast.error('Failed to load module production requests');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => { load(); }, [load]);

  const selected = rows.find(r => r.id === selectedId) || null;

  const fetchProjects = () =>
    api.get('/projects/projects').then(r => setProjects(Array.isArray(r.data) ? r.data : (r.data?.data || []))).catch(() => {});

  // ── Toolbar actions ──────────────────────────────────────────────
  const openCreate = () => {
    setForm({ ...emptyForm, lines: [{ ...emptyLine }] });
    setDrawer('create');
    fetchProjects();
  };

  const openEdit = async () => {
    if (!selected) return;
    if (selected.status !== 'draft') return toast.error('Only draft requests can be edited');
    try {
      const { data } = await api.get(`/imr/${selected.id}`);
      setForm({
        project_id: data.project_id || '',
        notes:      data.notes || '',
        lines:      (data.lines || []).map(l => ({
          module_spec: l.module_spec || '', unit: l.unit || 'No.', requested_qty: l.requested_qty || '',
        })),
      });
      setDetail(data);
      setDrawer('edit');
      fetchProjects();
    } catch {
      toast.error('Failed to load request');
    }
  };

  const openAssign = async () => {
    if (!selected) return;
    if (!['submitted', 'partially_assigned'].includes(selected.status))
      return toast.error('Assign is available only for submitted or partially-assigned requests');
    try {
      const [{ data }, ordRes] = await Promise.all([
        api.get(`/imr/${selected.id}`),
        api.get('/production/orders'),
      ]);
      setDetail(data);
      setAssignPO(data.production_order_id || '');
      setAssignMap(Object.fromEntries((data.lines || []).map(l => [l.id, l.assigned_qty || 0])));
      setOrders(Array.isArray(ordRes.data) ? ordRes.data : []);
      setDrawer('assign');
    } catch {
      toast.error('Failed to load request');
    }
  };

  const openView = async () => {
    if (!selected) return;
    try {
      const { data } = await api.get(`/imr/${selected.id}`);
      setDetail(data);
      setDrawer('view');
    } catch {
      toast.error('Failed to load request');
    }
  };

  const doSubmit = async () => {
    if (!selected) return;
    if (selected.status !== 'draft') return toast.error('Only draft requests can be submitted');
    try { await api.post(`/imr/${selected.id}/submit`); toast.success(`${selected.imr_no} submitted`); load(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Submit failed'); }
  };

  const doComplete = async () => {
    if (!selected) return;
    if (!['submitted', 'partially_assigned'].includes(selected.status))
      return toast.error('Only submitted or partially-assigned requests can be completed');
    try { await api.post(`/imr/${selected.id}/complete`); toast.success(`${selected.imr_no} completed`); load(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Complete failed'); }
  };

  // ── Drawer form helpers ──────────────────────────────────────────
  const setLine = (i, patch) => setForm(f => ({ ...f, lines: f.lines.map((l, idx) => idx === i ? { ...l, ...patch } : l) }));
  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, { ...emptyLine }] }));
  const removeLine = (i) => setForm(f => ({ ...f, lines: f.lines.length > 1 ? f.lines.filter((_, idx) => idx !== i) : f.lines }));

  const formTotal = form.lines.reduce((s, l) => s + (parseFloat(l.requested_qty) || 0), 0);

  const saveForm = async () => {
    const clean = form.lines.filter(l => String(l.module_spec).trim());
    if (!clean.length) return toast.error('Add at least one requested module');
    setSaving(true);
    try {
      const payload = {
        project_id: form.project_id || null,
        notes: form.notes || null,
        lines: clean.map(l => ({
          module_spec: l.module_spec.trim(),
          unit: l.unit || 'No.',
          requested_qty: parseFloat(l.requested_qty) || 0,
        })),
      };
      if (drawer === 'create') { await api.post('/imr', payload); toast.success('Request created'); }
      else { await api.put(`/imr/${detail.id}`, payload); toast.success('Request updated'); }
      setDrawer(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to save request');
    } finally { setSaving(false); }
  };

  const saveAssign = async () => {
    setSaving(true);
    try {
      const assignments = (detail.lines || []).map(l => ({ line_id: l.id, assigned_qty: parseFloat(assignMap[l.id]) || 0 }));
      await api.post(`/imr/${detail.id}/assign`, { production_order_id: assignPO || null, assignments });
      toast.success('Quantities assigned');
      setDrawer(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to assign');
    } finally { setSaving(false); }
  };

  const { page, totalPages, slice, next, prev, goTo, pageSize, total } = usePagination(rows, 20);

  const pills = [
    { label: 'All',        key: '',                   val: stats.total || 0,              color: '#6366f1' },
    { label: 'Draft',      key: 'draft',              val: stats.draft || 0,              color: '#6b7280' },
    { label: 'Submitted',  key: 'submitted',          val: stats.submitted || 0,          color: '#0ea5e9' },
    { label: 'Partial',    key: 'partially_assigned', val: stats.partially_assigned || 0, color: '#d97706' },
    { label: 'Completed',  key: 'completed',          val: stats.completed || 0,          color: '#10b981' },
    { label: 'Cancelled',  key: 'cancelled',          val: stats.cancelled || 0,          color: '#ef4444' },
  ];

  const isDraft   = selected?.status === 'draft';
  const canAssign = selected && ['submitted', 'partially_assigned'].includes(selected.status);

  const tbBtn = (label, onClick, enabled) => (
    <button key={label} onClick={onClick} disabled={!enabled}
      style={{
        padding: '7px 13px', borderRadius: 8, fontSize: 13, fontWeight: 600,
        border: '1px solid #e5e7eb', background: enabled ? '#fff' : '#f9fafb',
        color: enabled ? '#374151' : '#c0c4cc', cursor: enabled ? 'pointer' : 'not-allowed',
      }}>{label}</button>
  );

  const th = { textAlign: 'left', padding: '10px 12px', fontSize: 12, fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
  const td = { padding: '10px 12px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' };

  return (
    <div style={{ padding: 24 }}>
      {readOnly && <ReadOnlyBanner />}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>Module Production Batch Requests</h2>
        <button onClick={load} style={{ padding: '8px 14px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>↻ Refresh</button>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {!readOnly && (
          <button onClick={openCreate}
            style={{ padding: '7px 14px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>+ New</button>
        )}
        {!readOnly && tbBtn('Edit', openEdit, !!selected && isDraft)}
        {!readOnly && tbBtn('Edit Request', openEdit, !!selected && isDraft)}
        {!readOnly && tbBtn('Submit', doSubmit, !!selected && isDraft)}
        {!readOnly && tbBtn('Assign Quantity', openAssign, !!canAssign)}
        {tbBtn('View Assigned Modules', openView, !!selected)}
        {!readOnly && tbBtn('Completed', doComplete, !!canAssign)}
        <input
          placeholder="Search IMR no / project…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
        />
      </div>

      {/* Status pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {pills.map(({ label, key, val, color }) => (
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

      {/* Grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : slice.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
          {statusFilter || search ? 'No requests match the filter.' : 'No module production requests yet. Create one to get started.'}
        </div>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 36 }}></th>
                  <th style={th}>IMR No</th>
                  <th style={th}>Company</th>
                  <th style={th}>Reference No</th>
                  <th style={th}>Requested Modules</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total Qty</th>
                  <th style={{ ...th, textAlign: 'right' }}>Assigned Qty</th>
                  <th style={th}>Status</th>
                  <th style={th}>Created On</th>
                </tr>
              </thead>
              <tbody>
                {slice.map(r => {
                  const isSel = r.id === selectedId;
                  return (
                    <tr key={r.id} onClick={() => setSelected(r.id)}
                      style={{ cursor: 'pointer', background: isSel ? '#f5f3ff' : '#fff' }}>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <input type="radio" checked={isSel} readOnly />
                      </td>
                      <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.imr_no}</td>
                      <td style={td}>{r.company_name || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {r.project_code ? <span>{r.project_code}{r.project_name ? ` · ${r.project_name}` : ''}</span> : '—'}
                      </td>
                      <td style={{ ...td, whiteSpace: 'pre-line', minWidth: 220 }}>{r.modules_text || '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtQty(r.total_quantity)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtQty(r.assigned_qty)}</td>
                      <td style={td}><StatusBadge s={r.status} /></td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatDateTime(r.created_at) || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onNext={next} onPrev={prev} onGoTo={goTo} pageSize={pageSize} total={total} />
        </div>
      )}

      {/* Create / Edit drawer */}
      {(drawer === 'create' || drawer === 'edit') && (
        <Drawer title={drawer === 'create' ? 'New Module Production Request' : `Edit ${detail?.imr_no || ''}`} onClose={() => setDrawer(null)}>
          <Field label="Reference (Project / IPP)">
            <select value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={inp}>
              <option value="">— None —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.project_code ? `${p.project_code} · ` : ''}{p.project_name}</option>)}
            </select>
          </Field>

          <div style={{ marginTop: 8, marginBottom: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>Requested Modules</div>
          {form.lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <input placeholder="Module spec (e.g. AHF 200A Rack Mount)" value={l.module_spec}
                onChange={e => setLine(i, { module_spec: e.target.value })} style={{ ...inp, flex: 1 }} />
              <input type="number" min="0" placeholder="Qty" value={l.requested_qty}
                onChange={e => setLine(i, { requested_qty: e.target.value })} style={{ ...inp, width: 72 }} />
              <input placeholder="Unit" value={l.unit}
                onChange={e => setLine(i, { unit: e.target.value })} style={{ ...inp, width: 60 }} />
              <button onClick={() => removeLine(i)} title="Remove"
                style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 6, width: 30, height: 34, cursor: 'pointer', color: '#ef4444' }}>×</button>
            </div>
          ))}
          <button onClick={addLine} style={{ marginTop: 2, border: '1px dashed #c4b5fd', background: '#faf5ff', color: '#6B3FDB', borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>+ Add module</button>

          <div style={{ marginTop: 10, textAlign: 'right', fontSize: 13, color: '#374151' }}>
            Total Quantity: <strong>{fmtQty(formTotal)}</strong>
          </div>

          <Field label="Notes">
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} style={{ ...inp, resize: 'vertical' }} />
          </Field>

          <DrawerFooter onCancel={() => setDrawer(null)} onSave={saveForm} saving={saving} />
        </Drawer>
      )}

      {/* Assign Quantity drawer */}
      {drawer === 'assign' && detail && (
        <Drawer title={`Assign Quantity · ${detail.imr_no}`} onClose={() => setDrawer(null)}>
          <Field label="Production Batch (Order)">
            <select value={assignPO} onChange={e => setAssignPO(e.target.value)} style={inp}>
              <option value="">— Select a production order —</option>
              {orders.map(o => <option key={o.id} value={o.id}>{o.production_order_no} · {o.product_name}</option>)}
            </select>
          </Field>
          <div style={{ marginTop: 8, marginBottom: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>Allocate per module</div>
          {(detail.lines || []).map(l => (
            <div key={l.id} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <div style={{ flex: 1, fontSize: 13 }}>{l.module_spec} <span style={{ color: '#9ca3af' }}>({fmtQty(l.requested_qty)} {l.unit})</span></div>
              <input type="number" min="0" max={l.requested_qty} value={assignMap[l.id] ?? 0}
                onChange={e => setAssignMap(m => ({ ...m, [l.id]: e.target.value }))} style={{ ...inp, width: 90 }} />
            </div>
          ))}
          <DrawerFooter onCancel={() => setDrawer(null)} onSave={saveAssign} saving={saving} saveLabel="Assign" />
        </Drawer>
      )}

      {/* View Assigned Modules drawer */}
      {drawer === 'view' && detail && (
        <Drawer title={`Assigned Modules · ${detail.imr_no}`} onClose={() => setDrawer(null)}>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>
            Status: <StatusBadge s={detail.status} />
            {detail.production_order_no && <> · Batch: <strong>{detail.production_order_no}</strong></>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Module</th>
                <th style={{ ...th, textAlign: 'right' }}>Requested</th>
                <th style={{ ...th, textAlign: 'right' }}>Assigned</th>
              </tr>
            </thead>
            <tbody>
              {(detail.lines || []).map(l => (
                <tr key={l.id}>
                  <td style={td}>{l.module_spec} <span style={{ color: '#9ca3af' }}>{l.unit}</span></td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtQty(l.requested_qty)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: parseFloat(l.assigned_qty) >= parseFloat(l.requested_qty) ? '#166534' : '#d97706' }}>{fmtQty(l.assigned_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 14, textAlign: 'right' }}>
            <button onClick={() => setDrawer(null)} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Close</button>
          </div>
        </Drawer>
      )}
    </div>
  );
}

const inp = { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' };

function Field({ label, children }) {
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

function Drawer({ title, onClose, children }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '95vw', height: '100%', background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', padding: 24, overflowY: 'auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>{title}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#9ca3af', lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DrawerFooter({ onCancel, onSave, saving, saveLabel = 'Save' }) {
  return (
    <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button onClick={onCancel} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
      <button onClick={onSave} disabled={saving}
        style={{ padding: '8px 18px', background: saving ? '#a78bda' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'default' : 'pointer', fontSize: 13, fontWeight: 600 }}>
        {saving ? 'Saving…' : saveLabel}
      </button>
    </div>
  );
}
