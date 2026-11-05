import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Edit2, Trash2, Check, X, RefreshCw, SlidersHorizontal, Search, Power, RotateCcw } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
// ⚠ The HOUSE date format is DD Mon YY and it lives here. A local
// toLocaleDateString('en-GB', { month: 'short' }) is NOT the same thing —
// this ICU build renders September as "Sept", so a hand-rolled formatter
// printed "29 Sept 26" next to "29 Sep 26" everywhere else in the app.
import { fmtDate } from '@/utils/dateFormatter';
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

/** "8 employees, 3 requisitions" from the API's usage breakdown. */
const describeUsage = (item) =>
  (item?.usage || []).map(u => `${u.count} ${u.label}${u.count === 1 ? '' : 's'}`).join(', ')
  || `${item?.usage_count ?? 0} record${(item?.usage_count ?? 0) === 1 ? '' : 's'}`;

/**
 * How many records use this value.
 *
 * ⚠ The count is the answer to "is this safe to remove?", so it is on the row
 * itself rather than behind a click. The screen previously offered Rename and
 * Delete on a bare list of names — renaming a department rewrites the
 * vocabulary on every employee, report filter and job opening carrying it, and
 * nothing on screen said how many that was.
 */
/**
 * "Active · Used by 8 employees" — the row's state, in words.
 *
 * A badge reading "8 uses" made the reader work out both halves of the question
 * they are actually asking, which is "can I safely change this?". The status
 * and the count now sit together and say what they mean, so the available
 * actions beside them follow obviously.
 */
const StatusLine = ({ item }) => {
  const n = item.usage_count ?? 0;
  const active = item.is_active !== false;
  return (
    <span className="ms-status">
      <span className={`ms-status-dot ms-status-${active ? 'active' : 'inactive'}`} aria-hidden="true" />
      <span className={`ms-status-word${active ? '' : ' is-inactive'}`}>
        {active ? 'Active' : 'Inactive'}
      </span>
      <span className="ms-status-sep" aria-hidden="true">·</span>
      <span className={n ? 'ms-status-used' : 'ms-status-unused'} title={n ? describeUsage(item) : undefined}>
        {n ? `Used by ${describeUsage(item)}` : 'Not used anywhere'}
      </span>
    </span>
  );
};

/** Created / updated provenance, as a quiet second line. */
const Meta = ({ item }) => {
  // fmtDate returns the em-dash placeholder for an absent date, which is right
  // in a table cell and wrong in a sentence — so it is treated as "no date".
  const created = item.created_at ? fmtDate(item.created_at) : null;
  const updated = item.updated_at ? fmtDate(item.updated_at) : null;
  if (!created && !updated) return null;
  const bits = [];
  if (created) bits.push(`Added ${created}${item.created_by_name ? ` by ${item.created_by_name}` : ''}`);
  if (updated) bits.push(`updated ${updated}${item.updated_by_name ? ` by ${item.updated_by_name}` : ''}`);
  return <span className="ms-item-meta">{bits.join(' · ')}</span>;
};

// Generic list tab used for Departments, Zones, Designations, Grades, Bands
function SimpleListTab({ endpoint, label, sharedTable = false }) {
  const [items,         setItems]        = useState([]);
  const [newName,       setNewName]      = useState('');
  const [editId,        setEditId]       = useState(null);
  const [editVal,       setEditVal]      = useState('');
  const [loading,       setLoading]      = useState(false);
  const [loadErr,       setLoadErr]      = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [toast,         showToast]       = useToast();
  const [query,         setQuery]        = useState('');
  // Retired values are hidden by default even here: the common task is
  // managing the live list, and a retired value is not a mistake to be shown
  // by default. The toggle is what makes reactivation reachable at all —
  // before it, a deactivated value was invisible and gone for good.
  const [showRetired,   setShowRetired]  = useState(false);

  /**
   * ⚠ `include_inactive=1&usage=1` — the MANAGEMENT view.
   *
   * Every <MasterSelect> in the app calls the same endpoint with NO query
   * string and must keep getting active rows only, with no usage cost. Both
   * flags are opt-in on the API for exactly that reason; sending them from a
   * picker would put retired departments in the Add Employee dropdown.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const sep = endpoint.includes('?') ? '&' : '?';
      const res = await api.get(`${endpoint}${sep}include_inactive=1&usage=1`);
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
  // Rows with no owning company: seeded product defaults, readable by every
  // tenant and writable only by a globally scoped super admin.
  const sharedCount = items.filter(i => i.is_shared).length;
  const retiredCount = items.filter(i => i.is_active === false).length;

  // Search matches the NAME only, normalised the same way the duplicate guard
  // and the usage count normalise — so searching "engineering" finds
  // "Engineering", which is the whole point of having one normalisation rule.
  const needle = query.trim().toLowerCase();
  const visible = items.filter(i => {
    if (i.is_active === false && !showRetired) return false;
    return !needle || String(i.name ?? '').toLowerCase().includes(needle);
  });

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
    const { id, mode } = pendingDelete;
    setPendingDelete(null);
    if (id == null) return;
    const row = items.find(i => i.id === id);
    const used = (row?.usage_count ?? 0) > 0;
    try {
      // `?hard=1` ONLY for an explicit Delete on an unreferenced value. The API
      // refuses a hard delete of a used value anyway (409 naming the
      // references); this keeps the request honest about which action the user
      // actually chose rather than inferring it.
      const wantsHard = mode === 'delete' && !used;
      const res = await api.delete(`${endpoint}/${id}${wantsHard ? '?hard=1' : ''}`);
      await load();
      showToast(res.data?.deleted === 'permanently'
        ? `${label} deleted`
        : `${label} deactivated — existing records keep it`);
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to delete', 'error');
    }
  };

  /** Bring a retired value back. Can legitimately 409 if the name was re-used. */
  const handleReactivate = async (id) => {
    try {
      await api.post(`${endpoint}/${id}/reactivate`);
      await load();
      showToast(`${label} reactivated`);
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to reactivate', 'error');
    }
  };

  const pendingRow = items.find(i => i.id === pendingDelete?.id) || null;
  const pendingUsed = (pendingRow?.usage_count ?? 0) > 0;
  // What the user ASKED for, not what the usage count implies. The two can only
  // disagree if the count changed under them, which the API re-checks anyway.
  const pendingMode = pendingDelete?.mode ?? 'deactivate';

  return (
    <>
      {/*
        Delete vs deactivate, decided from the usage count and SAID OUT LOUD.
        A single "this cannot be undone" on a value 8 people are filed under is
        the wrong prompt for the wrong action — deactivation is what is wanted
        there, and it is reversible.
      */}
      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingMode === 'delete' ? `Delete ${label}` : `Deactivate ${label}`}
        message={pendingMode === 'delete'
          ? `Permanently delete "${pendingRow?.name}"? Nothing references it, so this cannot be undone.`
          : `"${pendingRow?.name}" will stop being offered on new records. ` +
            (pendingUsed
              ? `The ${describeUsage(pendingRow)} already using it keep it, `
              : 'Nothing uses it today, ') +
            `and you can reactivate it here later.`}
        confirmLabel={pendingMode === 'delete' ? 'Delete' : 'Deactivate'}
        variant={pendingMode === 'delete' ? 'danger' : 'primary'}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {toast && <div className={`ms-toast ms-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ms-card">
        <div className="ms-filter-row">
          <span className="ms-search">
            <Search size={13} className="ms-search-icon" />
            <input
              className="ms-input ms-search-input"
              type="search"
              aria-label={`Search ${label.toLowerCase()}s`}
              placeholder={`Search ${label.toLowerCase()}s…`}
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </span>
          {retiredCount > 0 && (
            <label className="ms-toggle">
              <input
                type="checkbox"
                checked={showRetired}
                onChange={e => setShowRetired(e.target.checked)}
              />
              Show retired ({retiredCount})
            </label>
          )}
          <span className="ms-count">
            {visible.length} of {items.length}
          </span>
        </div>

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

        {sharedTable && (
          <div className="ms-note ms-note-shared">
            <strong>Shared across all companies.</strong> {label}s live in one list for the whole
            deployment, so adding, renaming or retiring one here affects every company.
            Values already in use on your own employee records are shown too and are private to
            your company.
          </div>
        )}

        {sharedCount > 0 && (
          <div className="ms-note ms-note-builtin">
            <strong>{sharedCount} built-in value{sharedCount === 1 ? '' : 's'}.</strong>{' '}
            System values shipped with Pulse. They are available to every company automatically
            and cannot be renamed, deactivated or deleted. Add your own values above — they appear
            in the dropdowns alongside these and are fully manageable.
          </div>
        )}

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
        ) : visible.length === 0 ? (
          <div className="ms-empty">
            {items.length === 0
              ? `No ${label.toLowerCase()}s found. Add one above.`
              : `No ${label.toLowerCase()} matches "${query}".`}
          </div>
        ) : (
          <ul className="ms-list">
            {visible.map(item => (
              <li key={item.id ?? `unmanaged:${item.name}`}
                  className={`ms-item${item.is_shared ? ' ms-item-compact' : ''}`}>
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
                ) : item.is_shared ? (
                  // ⚠ A BUILT-IN value: owned by no company, shipped with
                  // Pulse, read by every tenant. The API refuses a rename or a
                  // retire from a company-scoped admin, so there is no action
                  // to offer — and a full-height card with an empty action area
                  // reads as "editable, but the buttons are missing". Rendered
                  // as a compact single line instead, with the explanation
                  // given ONCE above the list rather than on every row.
                  <span className="ms-item-name ms-item-builtin">
                    <span className="ms-item-title">{item.name}</span>
                    <span className="ms-badge-builtin">Built-in</span>
                  </span>
                ) : item.is_active === false ? (
                  // Retired. Shown only when "Show retired" is on, and the only
                  // action is to bring it back — renaming or re-deleting a value
                  // that is already switched off is not a thing anyone wants.
                  <>
                    <span className="ms-item-name ms-item-retired">
                      <span className="ms-item-title">{item.name}</span>
                      <StatusLine item={item} />
                      <Meta item={item} />
                    </span>
                    <button className="ms-btn-edit" onClick={() => { setEditId(item.id); setEditVal(item.name); }}>
                      <Edit2 size={11} style={{ marginRight: 3 }} />Edit
                    </button>
                    <button className="ms-btn-reactivate" onClick={() => handleReactivate(item.id)}
                            title={`Make "${item.name}" selectable on new records again`}>
                      <RotateCcw size={11} style={{ marginRight: 3 }} />Reactivate
                    </button>
                  </>
                ) : (
                  <>
                    <span className="ms-item-name">
                      <span className="ms-item-title">{item.name}</span>
                      <StatusLine item={item} />
                      <Meta item={item} />
                    </span>
                    <button className="ms-btn-edit" onClick={() => { setEditId(item.id); setEditVal(item.name); }}>
                      <Edit2 size={11} style={{ marginRight: 3 }} />Edit
                    </button>
                    {/*
                      ⚠ Delete and Deactivate are now SEPARATE buttons, and
                      Delete is DISABLED (not hidden) when the value is in use.
                      One button that silently became the other was the thing
                      the brief called out: a "Delete" that deactivates is a
                      lie, and hiding it instead leaves the user wondering
                      whether deletion exists at all. Disabled + a title that
                      explains why is the honest form.
                    */}
                    <button
                      className="ms-btn-delete"
                      disabled={(item.usage_count ?? 0) > 0}
                      title={(item.usage_count ?? 0) > 0
                        ? `This ${label.toLowerCase()} is currently used by ${describeUsage(item)}. Deactivate it instead.`
                        : `Permanently delete "${item.name}" — nothing references it`}
                      onClick={() => setPendingDelete({ id: item.id, mode: 'delete' })}
                    >
                      <Trash2 size={11} style={{ marginRight: 3 }} />Delete
                    </button>
                    <button
                      className="ms-btn-deactivate"
                      title={`Stop offering "${item.name}" on new records. Existing records keep it.`}
                      onClick={() => setPendingDelete({ id: item.id, mode: 'deactivate' })}
                    >
                      <Power size={11} style={{ marginRight: 3 }} />Deactivate
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

// ── A two-level vocabulary (expense type → expense category) ────────────────
//
// SimpleListTab cannot serve one: its Add box posts { name } alone and the API
// refuses a child with no parent, so the tab would render a flat list of 30
// names with no indication which type each belongs to, and every Add would come
// back 400. This groups the rows under their parent and makes the parent part
// of the add.
function ParentedListTab({ endpoint, label, parentLabel }) {
  const [groups,    setGroups]    = useState([]);
  const [parents,   setParents]   = useState([]);
  const [newName,   setNewName]   = useState('');
  const [newParent, setNewParent] = useState('');
  const [editId,    setEditId]    = useState(null);
  const [editVal,   setEditVal]   = useState('');
  const [loading,   setLoading]   = useState(false);
  const [loadErr,   setLoadErr]   = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [toast, showToast] = useToast();

  // The parent vocabulary is named by the registry, never guessed from the label.
  const parentEndpoint = `/master/v/${PARENT_KEY_OF[endpoint] ?? ''}`;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const [kids, tops] = await Promise.all([api.get(endpoint), api.get(parentEndpoint)]);
      const rows = Array.isArray(kids.data) ? kids.data : [];
      const top  = Array.isArray(tops.data) ? tops.data : [];
      setParents(top);
      // Grouped in the PARENT's own sort order, so this page reads the way the
      // cascading picker behaves rather than alphabetically across everything.
      setGroups(top
        .map(p => ({ parent: p.name, items: rows.filter(r => r.parent_name === p.name) }))
        .filter(g => g.items.length));
      setNewParent(prev => prev || top[0]?.name || '');
    } catch (err) {
      setGroups([]); setParents([]); setLoadErr(true);
      showToast(err?.message || `Failed to load ${label.toLowerCase()}`, 'error');
    } finally { setLoading(false); }
  }, [endpoint, parentEndpoint, label, showToast]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) { showToast(`Enter a ${label.toLowerCase()} name first`, 'error'); return; }
    if (!newParent) { showToast(`Choose a ${parentLabel.toLowerCase()} first`, 'error'); return; }
    try {
      await api.post(endpoint, { name, parent: newParent });
      setNewName('');
      await load();
      showToast(`${label} added under ${newParent}`);
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || `Failed to add ${label.toLowerCase()}`, 'error');
    }
  };

  const handleSave = async (id) => {
    const name = editVal.trim();
    if (!name) { showToast('Name cannot be empty', 'error'); return; }
    try {
      await api.put(`${endpoint}/${id}`, { name });
      setEditId(null);
      await load();
      showToast('Updated');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to update', 'error');
    }
  };

  const handleDelete = async () => {
    const id = pendingDelete;
    setPendingDelete(null);
    if (id == null) return;
    try {
      await api.delete(`${endpoint}/${id}`);
      await load();
      showToast('Removed');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to remove', 'error');
    }
  };

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <>
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Remove ${label}`}
        message={`Remove this ${label.toLowerCase()}? Records already using it keep their value.`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {toast && <div className={`ms-toast ms-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ms-card">
        <div className="ms-note">
          Every {label.toLowerCase()} belongs to one {parentLabel.toLowerCase()}. The claim form offers
          only the ones under the {parentLabel.toLowerCase()} already chosen, so one added without
          {' '}{article(parentLabel)} {parentLabel.toLowerCase()} would never appear again.
        </div>

        <div className="ms-add-row" style={{ flexWrap: 'wrap' }}>
          <select
            className="ms-input"
            value={newParent}
            onChange={e => setNewParent(e.target.value)}
            style={{ flex: '0 0 190px' }}
            aria-label={parentLabel}
          >
            {parents.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
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
          <button onClick={load} style={{ ...S.btn('#f3f4f6', '#6b7280'), padding: '8px 10px' }} title="Refresh" disabled={loading}>
            <RefreshCw size={13} />
          </button>
        </div>

        <p className="ms-count">
          {loading ? 'Loading…' : `${total} active across ${groups.length} ${parentLabel.toLowerCase()}s`}
        </p>

        {loadErr ? (
          <div className="ms-empty">
            <p>Could not load {label.toLowerCase()}.</p>
            <button className="ms-btn-cancel" onClick={load}>Try again</button>
          </div>
        ) : total === 0 && !loading ? (
          <div className="ms-empty"><p>No {label.toLowerCase()} yet. Add the first one above.</p></div>
        ) : groups.map(g => (
          <div key={g.parent} style={{ marginTop: 14 }}>
            <div className="ms-tabgroup-label" style={{ marginBottom: 6 }}>{g.parent}</div>
            <ul className="ms-list">
              {g.items.map(item => (
                <li key={item.id} className="ms-item">
                  {editId === item.id ? (
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
                  ) : item.is_shared ? (
                    <span className="ms-item-name">
                      {item.name}
                      <span className="ms-badge-unmanaged" title="Shared across all companies — add your own value instead">
                        built in
                      </span>
                    </span>
                  ) : (
                    <>
                      <span className="ms-item-name">{item.name}</span>
                      <button className="ms-btn-edit" onClick={() => { setEditId(item.id); setEditVal(item.name); }}>
                        <Edit2 size={11} style={{ marginRight: 3 }} />Rename
                      </button>
                      <button className="ms-btn-delete" onClick={() => setPendingDelete(item.id)}>
                        <Trash2 size={11} style={{ marginRight: 3 }} />Remove
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
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

/**
 * Branches / Locations — a POINTER, not a second editor.
 *
 * `employees.branch_id` is an FK to `branches`, a company-scoped ENTITY with a
 * code, an address, a type, contact details and an employee count. The other
 * tabs on this screen edit name-only vocabularies; rendering a branch here as
 * a bare name would offer a rename that silently drops everything else, and
 * two editors over one table is exactly the drift this module exists to stop.
 *
 * It earns a tab because the question "where do I manage Location?" is asked
 * here — a master-data screen that silently omits one of the masters is how
 * `branches` stayed invisible to HR in the first place.
 */
function BranchesPointer() {
  const navigate = useNavigate();
  return (
    <div className="ms-card">
      <div className="ms-empty" style={{ padding: '28px 20px', lineHeight: 1.6 }}>
        <p style={{ margin: 0, fontWeight: 600, color: '#374151' }}>
          Locations are managed as Branches.
        </p>
        <p style={{ margin: '6px 0 16px' }}>
          A branch carries a code, address, type and contact details as well as its
          name, and the Location field on an employee record points at it. That
          screen adds, edits, deactivates and reactivates them, and shows how many
          employees each one holds.
        </p>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: '#9ca3af' }}>
          Settings → Company Setup → Branch Management
        </p>
        <button className="ms-btn-add" onClick={() => navigate('/BranchManagement')}>
          Open Branch Management
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

// The masters that predate the vocabulary registry, each with its own table
// and its own route. They stay listed here because they are not interchangeable
// with the registry ones: UOM and HSN carry extra columns, grades/bands are
// company-scoped, and Leave Types is a pointer at another page.
/**
 * ⚠ `sharedTable: true` means the WHOLE TABLE is shared across every company —
 * `master_departments`, `master_designations` and `master_zones` have no
 * `company_id` column at all (verified against information_schema, not the
 * migrations). Adding "Facilities" adds it for every tenant on this
 * deployment.
 *
 * That is the established architecture and it was NOT changed: giving these
 * three tables a company_id means backfilling every existing row to a tenant,
 * re-scoping five API surfaces, and deciding what happens to the values two
 * tenants already share — a migration with real risk, done to remove a warning
 * rather than to fix a defect. The tenant boundary that matters is enforced
 * elsewhere and IS correct: the employees-derived half of these lists is
 * company-scoped, so one tenant's private department names never reach
 * another's dropdown, and only an admin can write the shared rows.
 *
 * What this flag buys is honesty on screen — an administrator renaming a
 * department is told it is not only theirs.
 */
const STATIC_TABS = [
  { key: 'departments',  label: 'Departments',  endpoint: '/master/departments', group: 'Organisation', sharedTable: true },
  { key: 'zones',        label: 'Zones',        endpoint: '/master/zones',       group: 'Organisation', sharedTable: true },
  { key: 'designations', label: 'Designations', endpoint: '/master/designations',group: 'Organisation', sharedTable: true },
  { key: 'grades',       label: 'Grades',       endpoint: '/master/grades',      group: 'Organisation' },
  { key: 'bands',        label: 'Bands',        endpoint: '/master/bands',       group: 'Organisation' },
  { key: 'uom',          label: 'Units (UOM)',  endpoint: '/master/uom',         group: 'Items & Tax' },
  { key: 'hsn',          label: 'HSN / SAC',    endpoint: '/master/hsn',         group: 'Items & Tax' },
  { key: 'leaveTypes',   label: 'Leave Types',  endpoint: null,                  group: 'Organisation' },
  // Branches are the LOCATION master. They are an entity, not a vocabulary —
  // company-scoped, with a code, an address, a type and contact details that
  // other modules join to — so this tab POINTS AT the Branches screen rather
  // than re-implementing a name-only editor over it. Two editors for one table
  // is the drift this whole module exists to prevent.
  { key: 'branches',     label: 'Branches / Locations', endpoint: null,           group: 'Organisation' },
];

// Group order. Anything a later registry entry introduces is appended rather
// than dropped, so adding a vocabulary in vocabularies.js needs no edit here.
const GROUP_ORDER = ['Organisation', 'Items & Tax', 'HR', 'CRM', 'Projects',
                     'Procurement', 'Finance', 'Travel'];

/** child endpoint → parent registry key. Filled from GET /master/v. */
const PARENT_KEY_OF = {};

/** "a expense type" reads as a typo to everyone who sees it. */
const article = (noun) => (/^[aeiou]/i.test(noun) ? 'an' : 'a');

const byGroup = (tabs) => {
  const seen = [...new Set(tabs.map(t => t.group))];
  const order = [...GROUP_ORDER.filter(g => seen.includes(g)),
                 ...seen.filter(g => !GROUP_ORDER.includes(g))];
  return order.map(g => [g, tabs.filter(t => t.group === g)]);
};

// Tabs whose rows carry more than a single name need the extra width.
const WIDE_TABS = new Set(['hsn', 'uom']);

/**
 * The employee-facing masters, in the order HR meets them on Add Employee.
 *
 * ⚠ This is a VIEW over the same screen, not a second implementation. The
 * Employees-area entry point renders this very component with `only` set —
 * same tabs, same SimpleListTab, same endpoints, same delete/deactivate rules.
 * A parallel master editor is exactly what modules/master/vocabularies.js
 * exists to prevent.
 */
export const EMPLOYEE_MASTER_TABS = [
  'departments', 'designations', 'grades', 'bands', 'zones',
  'v:employment-types', 'v:asset-types', 'v:banks',
  'v:qualifications', 'v:skill-types',
];

/**
 * @param {object=} urlParams  `?tab=` deep link target
 * @param {string[]=} only     restrict to these tab keys (Employee Masters)
 * @param {string[]=} exclude  hide these tab keys (Settings drops the employee
 *                             masters, which are managed from Employees)
 * @param {object=} hero       override the page hero for a scoped entry point
 * @param {object=} elsewhere  {label, page} — a pointer to the other entry point
 */
export default function MasterSetup({ urlParams, only, exclude, hero, elsewhere, setPage }) {
  /**
   * The tab to open, from `?tab=` when a "Manage X →" link sent the user here.
   *
   * ⚠ Seeded from the URL ONCE, as useState's initialiser — not synced in an
   * effect. A user who then clicks another tab must not be yanked back by a
   * stale query string still sitting in the address bar.
   *
   * The value is validated against the real tab list below before use, so a
   * hand-typed `?tab=nonsense` falls back to Departments rather than rendering
   * an empty page.
   */
  const [activeTab, setActiveTab] = useState(
    () => urlParams?.tab || (only?.[0] ?? (exclude?.includes('departments') ? 'uom' : 'departments')));
  // The module vocabularies come from GET /master/v — the same object the write
  // routes enforce — so a vocabulary added in vocabularies.js appears here with
  // no frontend change, and cannot appear here under a label the API does not
  // recognise. A failed fetch leaves the eight static tabs working.
  const [vocabTabs, setVocabTabs] = useState([]);

  useEffect(() => {
    let alive = true;
    api.get('/master/v')
      .then(res => {
        if (!alive) return;
        const list = Array.isArray(res.data) ? res.data : [];
        setVocabTabs(list.map(v => ({
          key: 'v:' + v.key, label: v.label, endpoint: v.endpoint, group: v.module,
          // Present only on a two-level vocabulary; picks which tab renders.
          parentOf: v.parentOf, parentLabel: v.parentLabel,
        })));
        // ParentedListTab holds only its own endpoint and needs its parent's,
        // so the mapping is recorded from the same registry response.
        for (const v of list) if (v.parentOf) PARENT_KEY_OF[v.endpoint] = v.parentOf;
      })
      .catch(() => { if (alive) setVocabTabs([]); });
    return () => { alive = false; };
  }, []);

  const ALL_TABS = [...STATIC_TABS, ...vocabTabs];
  // `only` preserves the caller's ORDER, not STATIC_TABS', so Employee Masters
  // lists departments/designations first — the order HR meets them in.
  // ⚠ ONE screen, two doors. `only` scopes it to the employee masters for
  // Employees → Manage Employee Masters; `exclude` drops those same tabs from
  // Settings so each master has exactly ONE place it is managed from. Both are
  // views over the same component, the same endpoints and the same rules —
  // there is no second implementation.
  const TABS = only
    ? only.map(k => ALL_TABS.find(t => t.key === k)).filter(Boolean)
    : exclude
      ? ALL_TABS.filter(t => !exclude.includes(t.key))
      : ALL_TABS;
  // A `?tab=v:banks` deep link arrives BEFORE GET /master/v resolves, so the
  // vocabulary tabs do not exist yet. Falling back to Departments while the
  // registry is still loading would make every vocabulary deep link flash the
  // wrong tab and stay there, so an unknown key is only replaced once the
  // registry has actually arrived.
  const registryLoaded = vocabTabs.length > 0;
  const tab = TABS.find(t => t.key === activeTab)
    ?? (registryLoaded ? TABS[0] : null);

  return (
    <PageShell dock={
      <PageHero
        icon={SlidersHorizontal}
        eyebrow={hero?.eyebrow ?? "Settings"}
        title={hero?.title ?? "Master Data Setup"}
        subtitle={hero?.subtitle ?? "The full lists behind the pickers — rename, retire and de-duplicate here. Adding a value is quicker from the form that needs it."}
      />
    }>

      <div style={{ maxWidth: WIDE_TABS.has(tab?.key) ? 1040 : 700, margin: '32px auto', padding: '0 16px' }}>
        {/*
          Where the masters that are NOT on this screen live. Without it,
          removing the employee tabs from Settings just makes them look missing.
        */}
        {elsewhere && (
          <div className="ms-note ms-note-elsewhere">
            <strong>{elsewhere.label}</strong> are managed with the people who use them —
            {' '}
            <button type="button" className="ms-link" onClick={() => setPage?.(elsewhere.page)}>
              {elsewhere.cta} &rarr;
            </button>
          </div>
        )}
        {byGroup(TABS).map(([group, tabs]) => (
          <div className="ms-tabgroup" key={group}>
            <span className="ms-tabgroup-label">{group}</span>
            <div className="ms-tabs">
              {tabs.map(t => (
                <button key={t.key} className={`ms-tab${tab?.key === t.key ? ' ms-tab-active' : ''}`} onClick={() => setActiveTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ))}

        {!tab ? null : tab.key.startsWith('v:') && tab.parentLabel ? (
          // A two-level vocabulary. SimpleListTab's Add posts { name } alone,
          // which the API refuses for a child, so it needs its own tab.
          <ParentedListTab endpoint={tab.endpoint} label={tab.label} parentLabel={tab.parentLabel} />
        ) : tab.key.startsWith('v:') ? (
          // The rest are single-name lists, so SimpleListTab serves them
          // unchanged. The registry label is ALREADY singular — SimpleListTab's
          // static callers pass a plural and slice the trailing 's' off, which
          // would turn "Industry" into "Industr".
          <SimpleListTab endpoint={tab.endpoint} label={tab.label} />
        ) : tab.key === 'branches' ? (
          <BranchesPointer />
        ) : tab.key === 'leaveTypes' ? (
          <LeaveTypesPointer />
        ) : tab.key === 'hsn' ? (
          <CodedListTab
            endpoint={tab.endpoint}
            label="HSN / SAC codes"
            fields={HSN_FIELDS}
            note="HSN classifies goods, SAC classifies services. The GST rate is capped at 100% — the same limit the database enforces."
          />
        ) : tab.key === 'uom' ? (
          <CodedListTab
            endpoint={tab.endpoint}
            label="Units of measure"
            fields={UOM_FIELDS}
            note="Codes are stored uppercase. Removing a unit deactivates it; items already using it are unaffected."
          />
        ) : (
          <SimpleListTab endpoint={tab.endpoint} label={tab.label.slice(0, -1)} sharedTable={tab.sharedTable} />
        )}
      </div>
    </PageShell>
  );
}
