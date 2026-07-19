import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, RefreshCw, Search, X, ToggleLeft, ToggleRight } from 'lucide-react';
import api from '@/services/api/client';
import './MasterSetup.css';

// ──────────────────────────────────────────────────────────────────────────────
// SetupMaster — generic CRUD table for admin setup pages
//
// config shape:
//   title        : string
//   subtitle     : string
//   endpoint     : string  (base API path, e.g. '/admin/products')
//   fields       : [{ key, label, type:'text'|'number'|'select'|'textarea', required?, options?, placeholder? }]
//   columns      : [{ key, label, render?: (value, row) => string }]
//   toggleField  : string | undefined  (if set, show toggle button for that boolean field)
//   toggleEndpoint: string | undefined (e.g. endpoint + '/:id/toggle')
// ──────────────────────────────────────────────────────────────────────────────

const EMPTY = (fields) =>
  Object.fromEntries(fields.map(f => [f.key, f.defaultValue ?? '']));

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`ms-toast ms-toast-${toast.type}`}>{toast.msg}</div>
  );
}

function Field({ f, value, onChange }) {
  const base = { className: 'ms-input', value: value ?? '', onChange: e => onChange(f.key, e.target.value) };
  if (f.type === 'textarea')
    return <textarea {...base} rows={3} placeholder={f.placeholder ?? ''} style={{ resize: 'vertical', fontFamily: 'inherit' }} />;
  if (f.type === 'select')
    return (
      <select {...base}>
        <option value="">— select —</option>
        {(f.options || []).map(o => (
          <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
        ))}
      </select>
    );
  if (f.type === 'number')
    return <input {...base} type="number" min={0} placeholder={f.placeholder ?? ''} />;
  return <input {...base} type="text" placeholder={f.placeholder ?? ''} />;
}

function Modal({ title, fields, form, onChange, onSave, onClose, saving }) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>{title}</span>
          <button style={S.iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {fields.map(f => (
            <div key={f.key}>
              <label style={S.label}>
                {f.label}
                {f.required && <span style={{ color: '#dc2626' }}> *</span>}
              </label>
              <Field f={f} value={form[f.key]} onChange={onChange} />
            </div>
          ))}
        </div>
        <div style={S.modalFoot}>
          <button className="ms-btn-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="ms-btn-save" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ message, onConfirm, onClose, busy }) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>Confirm Delete</span>
          <button style={S.iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '20px 24px', color: '#374151', fontSize: 14 }}>{message}</div>
        <div style={S.modalFoot}>
          <button className="ms-btn-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            style={{ padding: '7px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                     border: 'none', cursor: 'pointer', background: '#dc2626', color: '#fff' }}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SetupMaster({ config }) {
  const { title, subtitle, endpoint, fields, columns, toggleField, toggleEndpoint } = config;

  const [rows,     setRows]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [search,   setSearch]   = useState('');
  const [modal,    setModal]    = useState(null);   // null | 'add' | row-obj
  const [delRow,   setDelRow]   = useState(null);
  const [form,     setForm]     = useState({});
  const [saving,   setSaving]   = useState(false);
  const [delBusy,  setDelBusy]  = useState(false);
  const [toast,    setToast]    = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(endpoint);
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [endpoint]);

  useEffect(() => { load(); }, [load]);

  const setField = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const openAdd = () => {
    setForm(EMPTY(fields));
    setModal('add');
  };

  const openEdit = (row) => {
    setForm({ ...EMPTY(fields), ...row });
    setModal(row);
  };

  const handleSave = async () => {
    for (const f of fields) {
      if (f.required && !String(form[f.key] ?? '').trim())
        return showToast(`${f.label} is required`, 'error');
    }
    setSaving(true);
    try {
      if (modal === 'add') {
        await api.post(endpoint, form);
        showToast(`${title.replace(' Setup','').replace(' Config','')} added`);
      } else {
        await api.put(`${endpoint}/${modal.id}`, form);
        showToast('Updated successfully');
      }
      setModal(null);
      load();
    } catch(e) {
      showToast(e.response?.data?.error || 'Failed to save', 'error');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    setDelBusy(true);
    try {
      await api.delete(`${endpoint}/${delRow.id}`);
      showToast('Deleted successfully');
      setDelRow(null);
      load();
    } catch(e) {
      showToast(e.response?.data?.error || 'Failed to delete', 'error');
    } finally { setDelBusy(false); }
  };

  const handleToggle = async (row) => {
    try {
      const ep = toggleEndpoint
        ? toggleEndpoint.replace(':id', row.id)
        : `${endpoint}/${row.id}/toggle`;
      await api.patch(ep);
      load();
    } catch(e) {
      showToast(e.response?.data?.error || 'Toggle failed', 'error');
    }
  };

  const searchLower = search.toLowerCase();
  const displayed = searchLower
    ? rows.filter(r => columns.some(c => String(r[c.key] ?? '').toLowerCase().includes(searchLower)))
    : rows;

  return (
    <div style={S.root}>
      <Toast toast={toast} />

      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.pageTitle}>{title}</h1>
          {subtitle && <p style={S.pageSub}>{subtitle}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button style={S.iconBtn} onClick={load} title="Refresh"><RefreshCw size={15} /></button>
          <button style={S.btnPrimary} onClick={openAdd}>
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={S.toolbar}>
        <div style={S.searchWrap}>
          <Search size={14} style={{ color: '#9ca3af', flexShrink: 0 }} />
          <input
            style={S.searchInput}
            placeholder={`Search ${title.toLowerCase()}…`}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button style={S.clearBtn} onClick={() => setSearch('')}><X size={12} /></button>
          )}
        </div>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{displayed.length} record{displayed.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Table */}
      <div style={S.tableWrap}>
        {loading && (
          <div style={S.center}>Loading…</div>
        )}
        {!loading && displayed.length === 0 && (
          <div style={S.center}>
            No records found.
            <button style={{ marginLeft: 12, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }} onClick={openAdd}>
              + Add the first one
            </button>
          </div>
        )}
        {!loading && displayed.length > 0 && (
          <table style={S.table}>
            <thead>
              <tr style={S.thead}>
                {columns.map(c => (
                  <th key={c.key} style={S.th}>{c.label}</th>
                ))}
                {toggleField && <th style={{ ...S.th, width: 80 }}>Active</th>}
                <th style={{ ...S.th, width: 100, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((row, i) => (
                <tr key={row.id ?? i} style={S.tr}>
                  {columns.map(c => (
                    <td key={c.key} style={S.td}>
                      {c.render ? c.render(row[c.key], row) : (String(row[c.key] ?? '—'))}
                    </td>
                  ))}
                  {toggleField && (
                    <td style={{ ...S.td, textAlign: 'center' }}>
                      <button
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: row[toggleField] ? '#6B3FDB' : '#d1d5db' }}
                        title={row[toggleField] ? 'Deactivate' : 'Activate'}
                        onClick={() => handleToggle(row)}
                      >
                        {row[toggleField] ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                      </button>
                    </td>
                  )}
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <button className="ms-btn-edit" style={{ marginRight: 6 }} onClick={() => openEdit(row)}><Pencil size={11} /></button>
                    <button className="ms-btn-delete" onClick={() => setDelRow(row)}><Trash2 size={11} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit Modal */}
      {modal !== null && (
        <Modal
          title={modal === 'add' ? `Add ${title.replace(' Setup','').replace(' Config','')}` : 'Edit Record'}
          fields={fields}
          form={form}
          onChange={setField}
          onSave={handleSave}
          onClose={() => setModal(null)}
          saving={saving}
        />
      )}

      {/* Delete Confirm */}
      {delRow && (
        <ConfirmModal
          message={`Delete this record? This action cannot be undone.`}
          onConfirm={handleDelete}
          onClose={() => setDelRow(null)}
          busy={delBusy}
        />
      )}
    </div>
  );
}

// ── Inline styles ─────────────────────────────────────────────────────────────
const S = {
  root:       { padding: '28px 32px', minHeight: '100vh', background: '#f5f5fa', fontFamily: 'inherit' },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  pageTitle:  { fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' },
  pageSub:    { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  toolbar:    { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  searchWrap: { display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #e5e7eb',
                borderRadius: 8, padding: '6px 12px', flex: 1, maxWidth: 380 },
  searchInput:{ border: 'none', outline: 'none', fontSize: 13, flex: 1, background: 'transparent' },
  clearBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0, display: 'flex', alignItems: 'center' },
  tableWrap:  { background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' },
  table:      { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  thead:      { background: '#f9fafb' },
  th:         { padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151',
                borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' },
  tr:         { borderBottom: '1px solid #f3f4f6', transition: 'background .1s' },
  td:         { padding: '10px 14px', color: '#374151', verticalAlign: 'middle' },
  center:     { textAlign: 'center', padding: 48, color: '#9ca3af', fontSize: 14 },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', background: '#6B3FDB',
                color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  iconBtn:    { background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 8px',
                cursor: 'pointer', display: 'flex', alignItems: 'center', color: '#6b7280' },
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1200,
                display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal:      { background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, boxShadow: '0 20px 48px rgba(0,0,0,.18)', overflow: 'hidden' },
  modalHead:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '16px 20px', borderBottom: '1px solid #e5e7eb' },
  modalTitle: { fontWeight: 700, fontSize: 15, color: '#111827' },
  modalFoot:  { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #f3f4f6' },
  label:      { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.03em' },
};
