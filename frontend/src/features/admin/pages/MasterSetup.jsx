import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Edit2, Trash2, Check, X, RefreshCw, SlidersHorizontal } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import './MasterSetup.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

const S = {
  input: {
    padding: '7px 11px', border: '1px solid #e5e7eb', borderRadius: 7,
    fontSize: 13, outline: 'none', fontFamily: 'inherit',
  },
  smInput: {
    padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7,
    fontSize: 13, outline: 'none', fontFamily: 'inherit', width: 70,
    textAlign: 'center',
  },
  btn: (bg, color = '#fff') => ({
    padding: '7px 16px', background: bg, color, border: 'none',
    borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  }),
};

function useToast() {
  const [toast, setToast] = useState(null);
  // The timer is held so a second toast cancels the first one's dismissal.
  // Without this, back-to-back messages share the earlier 3s deadline: a
  // validation error at T=0 followed by a success at T=2.5s showed the success
  // for 500ms and then blanked it, which reads as the save having done nothing.
  const timer = useRef(null);
  const show = useCallback((msg, type = 'success') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ msg, type });
    timer.current = setTimeout(() => { setToast(null); timer.current = null; }, 3000);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [toast, show];
}

// Generic list tab used for Departments, Zones, Designations, Grades, Bands
function SimpleListTab({ endpoint, label }) {
  const [items,         setItems]        = useState([]);
  const [newName,       setNewName]      = useState('');
  const [editId,        setEditId]       = useState(null);
  const [editVal,       setEditVal]      = useState('');
  const [loading,       setLoading]      = useState(false);
  const [loadErr,       setLoadErr]      = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [toast,         showToast]       = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const res = await api.get(endpoint);
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      setItems(list);
    } catch (err) {
      setItems([]);
      setLoadErr(true);
      showToast(err?.message || `Failed to load ${label.toLowerCase()}s`, 'error');
    } finally {
      setLoading(false);
    }
  }, [endpoint, label, showToast]);

  useEffect(() => { load(); }, [load]);

  // Rows the backend synthesised from employee records: they exist as free text
  // on employees but have no master row, hence no id.
  const unmanagedCount = items.filter(i => i.id == null).length;

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) { showToast(`Enter a ${label.toLowerCase()} name first`, 'error'); return; }
    try {
      await api.post(endpoint, { name });
      setNewName('');
      await load();
      showToast(`${label} added`);
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || `Failed to add ${label.toLowerCase()}`, 'error');
    }
  };

  // Promote a value that only exists on employee records into the master list,
  // which is what gives it an id and makes it renameable/deletable.
  const handleAdopt = async (name) => {
    try {
      await api.post(endpoint, { name });
      await load();
      showToast(`${label} added to the list`);
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || `Failed to add ${label.toLowerCase()}`, 'error');
    }
  };

  const handleSave = async (id) => {
    const name = editVal.trim();
    if (!name) { showToast('Name cannot be empty', 'error'); return; }
    if (id == null) { setEditId(null); return; }
    try {
      await api.put(`${endpoint}/${id}`, { name });
      setItems(prev => prev.map(i => i.id === id ? { ...i, name } : i));
      setEditId(null);
      showToast('Updated');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to update', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete;
    setPendingDelete(null);
    if (id == null) return;
    try {
      await api.delete(`${endpoint}/${id}`);
      setItems(prev => prev.filter(i => i.id !== id));
      showToast('Deleted');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to delete', 'error');
    }
  };

  return (
    <>
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete ${label}`}
        message={`Delete this ${label.toLowerCase()}? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {toast && <div className={`ms-toast ms-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ms-card">
        <div className="ms-add-row">
          <input
            className="ms-input"
            placeholder={`New ${label.toLowerCase()} name…`}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button className="ms-btn-add" onClick={handleAdd}>
            <Plus size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />Add
          </button>
          <button onClick={load} style={{ ...S.btn('#f3f4f6', '#6b7280'), padding: '8px 10px' }} title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>

        {unmanagedCount > 0 && (
          <div className="ms-note">
            {unmanagedCount} value{unmanagedCount === 1 ? ' is' : 's are'} in use on employee
            records but not in this list. Add {unmanagedCount === 1 ? 'it' : 'them'} to make
            {unmanagedCount === 1 ? ' it' : ' them'} renameable.
          </div>
        )}

        {loading ? (
          <div className="ms-empty">Loading…</div>
        ) : loadErr ? (
          <div className="ms-empty" style={{ color: '#dc2626' }}>
            Could not load data. Check your connection and try refreshing.
          </div>
        ) : items.length === 0 ? (
          <div className="ms-empty">No {label.toLowerCase()}s found. Add one above.</div>
        ) : (
          <ul className="ms-list">
            {items.map(item => (
              <li key={item.id ?? `unmanaged:${item.name}`} className="ms-item">
                {editId !== null && editId === item.id ? (
                  <>
                    <input
                      className="ms-input ms-input-inline"
                      value={editVal}
                      autoFocus
                      onChange={e => setEditVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSave(item.id);
                        if (e.key === 'Escape') setEditId(null);
                      }}
                    />
                    <button className="ms-btn-save" onClick={() => handleSave(item.id)}>
                      <Check size={12} style={{ marginRight: 3 }} />Save
                    </button>
                    <button className="ms-btn-cancel" onClick={() => setEditId(null)}>
                      <X size={12} style={{ marginRight: 3 }} />Cancel
                    </button>
                  </>
                ) : item.id == null ? (
                  <>
                    <span className="ms-item-name">
                      {item.name}
                      <span className="ms-badge-unmanaged">not in list</span>
                    </span>
                    <button className="ms-btn-edit" onClick={() => handleAdopt(item.name)} title={`Add "${item.name}" to the master list`}>
                      <Plus size={11} style={{ marginRight: 3 }} />Add to list
                    </button>
                  </>
                ) : (
                  <>
                    <span className="ms-item-name">{item.name}</span>
                    <button className="ms-btn-edit" onClick={() => { setEditId(item.id); setEditVal(item.name); }}>
                      <Edit2 size={11} style={{ marginRight: 3 }} />Rename
                    </button>
                    <button className="ms-btn-delete" onClick={() => setPendingDelete(item.id)}>
                      <Trash2 size={11} style={{ marginRight: 3 }} />Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

// ── Leave types live in Leave Settings ───────────────────────────────────────
// This page used to carry a full leave-type editor of its own. Leave Settings
// (features/leaves/pages/LeaveSettings.jsx) has the same CRUD plus Allocations,
// Policy Rules, Accrual & Carry Forward and its own Bulk Allocate — it is the
// strictly larger screen over the same `leave_types` table, so keeping a second
// editor here only meant two places to look and two ways to disagree.
function LeaveTypesPointer() {
  const navigate = useNavigate();
  return (
    <div className="ms-card">
      <div className="ms-empty" style={{ padding: '28px 20px', lineHeight: 1.6 }}>
        <p style={{ margin: 0, fontWeight: 600, color: '#374151' }}>
          Leave types are managed in Leave Settings.
        </p>
        <p style={{ margin: '6px 0 16px' }}>
          That screen adds the policy rules, allocations and accrual settings
          that go with each type.
        </p>
        <button className="ms-btn-add" onClick={() => navigate('/LeaveSettings')}>
          Open Leave Settings
        </button>
      </div>
    </div>
  );
}

// ── Multi-column master tab (HSN/SAC, UOM) ────────────────────────────────────
// SimpleListTab above assumes a row is just `{ id, name }`. HSN/SAC and UOM are
// code-keyed with three or four meaningful columns each, so they get their own
// tab driven by a field spec rather than four more near-copies of the same JSX.
//
// Both endpoints existed with full CRUD and had NO UI at all, which is why
// `master_hsn_sac` and `master_uom` sat empty — see MODULE_FEATURE_CONNECTION_MANUAL
// §157.1. Writes are admin-only on the server (`allowRoles(super_admin, admin)`),
// so a 403 here is a role problem, not a bug; it is surfaced as such.
function CodedListTab({ endpoint, label, fields, note }) {
  const blank = useCallback(
    () => Object.fromEntries(fields.map(f => [f.key, f.default ?? ''])),
    [fields]
  );

  const [items,         setItems]         = useState([]);
  const [draft,         setDraft]         = useState(blank);
  const [editId,        setEditId]        = useState(null);
  const [editDraft,     setEditDraft]     = useState({});
  const [loading,       setLoading]       = useState(false);
  const [loadErr,       setLoadErr]       = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [toast,         showToast]        = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const res = await api.get(endpoint);
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      setItems(list);
    } catch (err) {
      setItems([]);
      setLoadErr(true);
      showToast(err.response?.data?.error || err?.message || `Failed to load ${label}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [endpoint, label, showToast]);

  useEffect(() => { load(); }, [load]);

  // Returns an error string, or null when the row is good. Kept in one place so
  // the add form and the inline editor cannot disagree about what is valid.
  const validate = (row) => {
    for (const f of fields) {
      const raw = String(row[f.key] ?? '').trim();
      if (f.required && !raw) return `${f.label} is required`;
      if (raw && f.type === 'number') {
        const n = Number(raw);
        if (Number.isNaN(n)) return `${f.label} must be a number`;
        // The server carries a CHECK for this range. Enforcing it here too is
        // what stops the §146.2 defect recurring, where a GST rate of 899 was
        // stored and every invoice line computed tax at 899%.
        if (f.min != null && n < f.min) return `${f.label} cannot be below ${f.min}`;
        if (f.max != null && n > f.max) return `${f.label} cannot be above ${f.max}`;
      }
    }
    return null;
  };

  const failMsg = (err, verb) => {
    if (err.response?.status === 403) return `Only an administrator can ${verb} ${label}`;
    return err.response?.data?.error || err?.message || `Failed to ${verb} ${label}`;
  };

  const handleAdd = async () => {
    const bad = validate(draft);
    if (bad) { showToast(bad, 'error'); return; }
    try {
      await api.post(endpoint, draft);
      setDraft(blank());
      await load();
      showToast(`${label} added`);
    } catch (err) {
      showToast(failMsg(err, 'add'), 'error');
    }
  };

  const startEdit = (item) => {
    setEditId(item.id);
    setEditDraft(Object.fromEntries(fields.map(f => [f.key, item[f.key] ?? ''])));
  };

  const saveEdit = async () => {
    const bad = validate(editDraft);
    if (bad) { showToast(bad, 'error'); return; }
    try {
      await api.put(`${endpoint}/${editId}`, editDraft);
      setEditId(null);
      await load();
      showToast(`${label} updated`);
    } catch (err) {
      showToast(failMsg(err, 'update'), 'error');
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`${endpoint}/${id}`);
      setPendingDelete(null);
      await load();
      showToast(`${label} removed`);
    } catch (err) {
      setPendingDelete(null);
      showToast(failMsg(err, 'remove'), 'error');
    }
  };

  const renderInput = (f, value, onChange, keyPrefix) => {
    // `key` is passed explicitly, never inside the spread — React 19 warns on a
    // key that arrives via {...props} and drops it, which silently breaks
    // reconciliation for the row.
    const k = `${keyPrefix}-${f.key}`;
    const common = {
      value: value ?? '',
      onChange: e => onChange(f.key, e.target.value),
      style: { ...S.input, ...(f.grow ? { flex: 1, minWidth: 120 } : { width: f.width || 120 }) },
    };
    if (f.type === 'select') {
      return (
        <select key={k} {...common} aria-label={f.label}>
          {f.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    return (
      <input
        key={k}
        {...common}
        type={f.type === 'number' ? 'number' : 'text'}
        placeholder={f.placeholder || f.label}
        aria-label={f.label}
        {...(f.type === 'number' ? { min: f.min, max: f.max, step: f.step || 'any' } : {})}
        onKeyDown={e => { if (e.key === 'Enter' && keyPrefix === 'add') handleAdd(); }}
      />
    );
  };

  return (
    <>
      {toast && <div className={`ms-toast ms-toast-${toast.type}`}>{toast.msg}</div>}

      <ConfirmDialog
        open={pendingDelete != null}
        title={`Remove ${label}?`}
        message="It is deactivated, not erased — anything already referencing it keeps working."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => handleDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />

      <div className="ms-card">
        {note && <div className="ms-note">{note}</div>}

        {/* Add row — one input per field, then Add, then Refresh. Matches
            SimpleListTab: `.ms-header` is the PAGE header's purple gradient and
            must not be nested inside a card. */}
        <div className="ms-add-row" style={{ flexWrap: 'wrap' }}>
          {fields.map(f => renderInput(f, draft[f.key], (k, v) => setDraft(d => ({ ...d, [k]: v })), 'add'))}
          <button className="ms-btn-add" onClick={handleAdd}>
            <Plus size={13} style={{ marginRight: 4 }} />Add
          </button>
          <button onClick={load} style={{ ...S.btn('#f3f4f6', '#6b7280'), padding: '8px 10px' }} title="Refresh" disabled={loading}>
            <RefreshCw size={13} />
          </button>
        </div>

        <p className="ms-count">{loading ? 'Loading…' : `${items.length} active`}</p>

        {loadErr ? (
          <div className="ms-empty">
            <p>Could not load {label.toLowerCase()}.</p>
            <button className="ms-btn-cancel" onClick={load}>Try again</button>
          </div>
        ) : items.length === 0 && !loading ? (
          <div className="ms-empty">
            <p>No {label.toLowerCase()} yet. Add the first one above.</p>
          </div>
        ) : (
          <ul className="ms-list">
            {items.map(item => (
              <li key={item.id} className="ms-item" style={{ flexWrap: 'wrap' }}>
                {editId === item.id ? (
                  <>
                    {fields.map(f => renderInput(f, editDraft[f.key], (k, v) => setEditDraft(d => ({ ...d, [k]: v })), `e${item.id}`))}
                    <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                      <button className="ms-btn-save" onClick={saveEdit}>
                        <Check size={11} style={{ marginRight: 3 }} />Save
                      </button>
                      <button className="ms-btn-cancel" onClick={() => setEditId(null)}>
                        <X size={11} style={{ marginRight: 3 }} />Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {fields.map(f => (
                      <span
                        key={f.key}
                        style={{
                          fontSize: 13,
                          color: f.strong ? '#1f2937' : '#6b7280',
                          fontWeight: f.strong ? 600 : 400,
                          ...(f.grow ? { flex: 1, minWidth: 120 } : { width: f.width || 120 }),
                          ...(f.mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } : {}),
                        }}
                        title={f.label}
                      >
                        {f.render ? f.render(item[f.key]) : (item[f.key] ?? '—')}
                      </span>
                    ))}
                    <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                      <button className="ms-btn-edit" onClick={() => startEdit(item)}>
                        <Edit2 size={11} style={{ marginRight: 3 }} />Edit
                      </button>
                      <button className="ms-btn-delete" onClick={() => setPendingDelete(item.id)}>
                        <Trash2 size={11} style={{ marginRight: 3 }} />Remove
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

// Column specs for the two coded masters. `grow` takes the remaining width;
// everything else is fixed so the rows line up as a table would.
const HSN_FIELDS = [
  { key: 'code',        label: 'Code',        placeholder: '85044090', width: 120, required: true, strong: true, mono: true },
  { key: 'description', label: 'Description', placeholder: 'Static converters — other', grow: true, required: true },
  { key: 'gst_rate',    label: 'GST %',       placeholder: '18', type: 'number', width: 90, min: 0, max: 100,
    render: v => (v == null || v === '' ? '—' : `${parseFloat(v)}%`) },
  { key: 'type',        label: 'Type',        type: 'select', options: ['HSN', 'SAC'], width: 90, default: 'HSN' },
];

const UOM_FIELDS = [
  { key: 'code',     label: 'Code',     placeholder: 'NOS', width: 110, required: true, strong: true, mono: true },
  { key: 'name',     label: 'Name',     placeholder: 'Numbers', grow: true, required: true },
  { key: 'category', label: 'Category', placeholder: 'General', width: 150 },
];

const TABS = [
  { key: 'departments',  label: 'Departments',  endpoint: '/master/departments' },
  { key: 'zones',        label: 'Zones',        endpoint: '/master/zones' },
  { key: 'designations', label: 'Designations', endpoint: '/master/designations' },
  { key: 'grades',       label: 'Grades',       endpoint: '/master/grades' },
  { key: 'bands',        label: 'Bands',        endpoint: '/master/bands' },
  { key: 'uom',          label: 'Units (UOM)',  endpoint: '/master/uom' },
  { key: 'hsn',          label: 'HSN / SAC',    endpoint: '/master/hsn' },
  { key: 'leaveTypes',   label: 'Leave Types',  endpoint: null },
];

// Tabs whose rows carry more than a single name need the extra width.
const WIDE_TABS = new Set(['hsn', 'uom']);

export default function MasterSetup() {
  const [activeTab, setActiveTab] = useState('departments');

  const tab = TABS.find(t => t.key === activeTab);

  return (
    <PageShell dock={
      <PageHero
        icon={SlidersHorizontal}
        eyebrow="Administration"
        title="Master Data Setup"
        subtitle="The full lists behind the pickers — rename, retire and de-duplicate here. Adding a value is quicker from the form that needs it."
      />
    }>

      <div style={{ maxWidth: WIDE_TABS.has(activeTab) ? 1040 : 700, margin: '32px auto', padding: '0 16px' }}>
        <div className="ms-tabs" style={{ marginBottom: 16 }}>
          {TABS.map(t => (
            <button key={t.key} className={`ms-tab${activeTab === t.key ? ' ms-tab-active' : ''}`} onClick={() => setActiveTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'leaveTypes' ? (
          <LeaveTypesPointer />
        ) : activeTab === 'hsn' ? (
          <CodedListTab
            endpoint={tab.endpoint}
            label="HSN / SAC codes"
            fields={HSN_FIELDS}
            note="HSN classifies goods, SAC classifies services. The GST rate is capped at 100% — the same limit the database enforces."
          />
        ) : activeTab === 'uom' ? (
          <CodedListTab
            endpoint={tab.endpoint}
            label="Units of measure"
            fields={UOM_FIELDS}
            note="Codes are stored uppercase. Removing a unit deactivates it; items already using it are unaffected."
          />
        ) : (
          <SimpleListTab endpoint={tab.endpoint} label={tab.label.slice(0, -1)} />
        )}
      </div>
    </PageShell>
  );
}
