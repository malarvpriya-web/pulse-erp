// ──────────────────────────────────────────────────────────────────────────────
// MasterSelect — a dropdown over a master list that can also ADD to it.
//
// The masters (departments, zones, designations, units, HSN/SAC) were only
// editable from Administration → Master Data Setup, so filling in an employee
// or an item meant leaving the form, adding the value, and coming back. This
// renders the ordinary <select> the host page already styles, plus one extra
// "+ Add new…" option; choosing it swaps the control for an inline add row and
// selects whatever gets created.
//
// ADD only. Rename and delete stay in Master Setup on purpose: renaming a
// department rewrites the vocabulary on every employee row, report filter and
// job opening that uses it, which is not an action that belongs behind a "+"
// in a data-entry form.
//
// The master write routes are admin-only (master.routes.js: ADMIN_ROLES, with
// zones additionally allowing hr), so the add option is hidden for anyone whose
// POST would come back 403 — see `addRoles`.
//
// ── Why every department picker must read from here ──────────────────────────
// This replaced hooks/useDepartments.js, which existed because three screens had
// each carried their OWN hardcoded array and the three disagreed:
//   AdminDashboard  9 names, plus an "Other → free text" box that wrote an
//                   arbitrary string onto the user record, minting a department
//                   nobody could ever see in Master Setup
//   Contacts        8 names
//   JobOpenings     8 DIFFERENT names ('Engineering'/'Product'/'Legal' — none of
//                   which the other two offered)
// Filtering a report by department cannot work when each screen writes from its
// own vocabulary. Never reintroduce a local list.
//
// ⚠ For departments use /master/departments, NOT /orgchart/departments. The
// master route unions the master list with the DISTINCT departments actually
// present on `employees`, so it is the superset; the orgchart one returns only
// the employees-derived subset AND wraps it in a { success, data } envelope
// rather than a bare array — a shape mismatch that silently yielded empty
// dropdowns. (rowsOf() below tolerates both shapes for exactly that reason.)
// ──────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';

// Sentinel option value. Anything a master could legitimately hold is a plain
// name or code, so this cannot collide with a real row.
const ADD_NEW = '__master_select_add_new__';

const rowsOf = (data) =>
  Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);

const S = {
  wrap:   { display: 'flex', flexDirection: 'column', gap: 6 },
  addRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  input: {
    padding: '7px 10px', border: '1px solid #d7d7e0', borderRadius: 7,
    fontSize: 13, outline: 'none', fontFamily: 'inherit', minWidth: 0, flex: '1 1 120px',
  },
  save: {
    padding: '7px 14px', background: '#6B3FDB', color: '#fff', border: 'none',
    borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  cancel: {
    padding: '7px 12px', background: '#f3f4f6', color: '#6b7280', border: 'none',
    borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  err:  { fontSize: 11, color: '#dc2626' },
  hint: { fontSize: 11, color: '#9ca3af' },
};

/**
 * @param {string}   endpoint     master route, e.g. '/master/departments'
 * @param {string}   label        singular noun for prompts, e.g. 'Department'
 * @param {*}        value        current value (matched against optionValue)
 * @param {Function} onChange     (nextValue, createdRow|null) => void
 * @param {string}   optionValue  row key stored on the record  (default 'name')
 * @param {Function} optionLabel  row => visible text           (default r.name)
 * @param {Array}    fields       add-form inputs, one per column the POST needs:
 *                                [{ key, label, placeholder, required, type,
 *                                   options, width, default }]
 * @param {string[]} addRoles     roles whose POST the backend accepts
 * @param {Function} onListChange (rows) => void, after every successful load
 */
export default function MasterSelect({
  endpoint,
  label,
  value,
  onChange,
  optionValue = 'name',
  optionLabel,
  fields,
  addRoles = ['super_admin', 'admin'],
  placeholder,
  disabled = false,
  required = false,
  id,
  onListChange,
  selectStyle,
}) {
  const { hasAnyRole } = useAuth();
  const canAdd = hasAnyRole(...addRoles);

  const addFields = fields?.length ? fields : [{ key: 'name', label, required: true }];
  const blank = () => Object.fromEntries(addFields.map(f => [f.key, f.default ?? '']));

  const [rows,   setRows]   = useState([]);
  const [adding, setAdding] = useState(false);
  const [draft,  setDraft]  = useState(blank);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');
  const firstInput = useRef(null);

  // onListChange is usually an inline arrow, so it is deliberately NOT a dep of
  // load() — a fresh identity every render would re-fetch the master on a loop.
  const notify = useRef(onListChange);
  useEffect(() => { notify.current = onListChange; }, [onListChange]);

  const load = useCallback(async () => {
    try {
      const res = await api.get(endpoint);
      const list = rowsOf(res.data);
      setRows(list);
      notify.current?.(list);
    } catch {
      setRows([]);
    }
  }, [endpoint]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (adding) firstInput.current?.focus(); }, [adding]);

  const textOf  = (r) => (optionLabel ? optionLabel(r) : r?.name ?? '');
  const valueOf = (r) => r?.[optionValue] ?? '';

  const handleSelect = (e) => {
    const next = e.target.value;
    if (next === ADD_NEW) {
      setDraft(blank());
      setError('');
      setAdding(true);
      return;
    }
    // The whole row goes with the value so a caller can copy the rest of it —
    // picking an HSN code fills the item's GST rate from the same master row
    // rather than leaving the two to be typed independently.
    onChange?.(next, rows.find(r => valueOf(r) === next) || null);
  };

  const handleCreate = async () => {
    const missing = addFields.find(f => f.required && !String(draft[f.key] ?? '').trim());
    if (missing) { setError(`${missing.label || missing.key} is required`); return; }

    const payload = {};
    for (const f of addFields) {
      const raw = draft[f.key];
      if (raw === '' || raw == null) continue;
      payload[f.key] = f.type === 'number' ? Number(raw) : String(raw).trim();
    }

    setSaving(true);
    setError('');
    try {
      const res = await api.post(endpoint, payload);
      // Routes vary: some echo the created row, some a { data } envelope, some
      // only a status. Fall back to the payload so the selection lands anyway.
      const created = res.data?.id ? res.data : (res.data?.data?.id ? res.data.data : payload);
      await load();
      setAdding(false);
      setDraft(blank());
      onChange?.(created[optionValue] ?? payload[optionValue] ?? '', created);
    } catch (err) {
      const status = err?.response?.status;
      setError(
        status === 403
          ? `You do not have permission to add a ${label.toLowerCase()}. Ask an admin, or use Master Data Setup.`
          : err?.response?.data?.error || err?.message || `Could not add the ${label.toLowerCase()}`
      );
    } finally {
      setSaving(false);
    }
  };

  const cancelAdd = () => { setAdding(false); setError(''); setDraft(blank()); };

  if (adding) {
    return (
      <div style={S.wrap}>
        <div style={S.addRow}>
          {addFields.map((f, i) => (
            f.type === 'select' ? (
              <select
                key={f.key}
                ref={i === 0 ? firstInput : null}
                value={draft[f.key] ?? ''}
                onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                style={{ ...S.input, flex: `0 0 ${f.width || 90}px` }}
              >
                {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                key={f.key}
                ref={i === 0 ? firstInput : null}
                type={f.type || 'text'}
                value={draft[f.key] ?? ''}
                placeholder={f.placeholder || f.label || f.key}
                title={f.label || f.key}
                onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleCreate(); }
                  if (e.key === 'Escape') cancelAdd();
                }}
                style={{ ...S.input, ...(f.width ? { flex: `0 0 ${f.width}px` } : {}) }}
              />
            )
          ))}
          <button type="button" style={S.save} onClick={handleCreate} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" style={S.cancel} onClick={cancelAdd} disabled={saving}>
            Cancel
          </button>
        </div>
        {error
          ? <span style={S.err}>{error}</span>
          : <span style={S.hint}>Adds to the {label.toLowerCase()} master — available everywhere.</span>}
      </div>
    );
  }

  // The bare <select> keeps whatever the host page's CSS already gives it.
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={handleSelect}
      disabled={disabled}
      required={required}
      style={selectStyle}
    >
      <option value="">{placeholder || `-- Select ${label} --`}</option>
      {/* A value already on the record but absent from the master (legacy free
          text, or a row since deactivated) would otherwise render blank and be
          silently wiped on the next save. */}
      {value && !rows.some(r => valueOf(r) === value) && (
        <option value={value}>{value}</option>
      )}
      {rows.map(r => (
        <option key={r.id ?? valueOf(r)} value={valueOf(r)}>{textOf(r)}</option>
      ))}
      {canAdd && <option value={ADD_NEW}>+ Add new {label.toLowerCase()}…</option>}
    </select>
  );
}
