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
import { useState, useEffect, useCallback, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { measureMenu } from './menuPlacement';
import { masterAdminFor } from './masterAdminLinks';

// Sentinel option value. Anything a master could legitimately hold is a plain
// name or code, so this cannot collide with a real row.
const ADD_NEW = '__master_select_add_new__';

// Master endpoints in this codebase return three different shapes: a bare array
// (/master/*), a { data } envelope (/orgchart/*), and a named collection
// (/inventory/catalog/categories → { categories }). Taking the first array-valued
// property covers the third without this component needing a per-endpoint map —
// and a shape mismatch here does not throw, it silently empties the dropdown,
// which is why it is worth being liberal.
/**
 * Does this row carry the currently-selected value?
 *
 * Compared as STRINGS. Most masters key on `name`, where the two sides are both
 * strings and `===` was fine. A picker keyed on `optionValue="id"` is not: the
 * API returns `id: 1` (a number) while React form state, a <select>'s
 * `e.target.value` and anything that has been through a URL or FormData all
 * hold `'1'`. Under `===` the selected row matched nothing, so the control fell
 * through to its orphan branch and displayed the bare id `1` where the branch
 * name should be — and the next save wrote that back. The Location picker is
 * the first id-keyed caller, which is why this only surfaces now.
 */
const sameValue = (a, b) => String(a ?? '') === String(b ?? '');

const rowsOf = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (data && typeof data === 'object') {
    const first = Object.values(data).find(Array.isArray);
    if (first) return first;
  }
  return [];
};

/**
 * "Manage Departments →" — a real navigation control.
 *
 * ⚠ It is a <button>, not an <a>. The app navigates with `setPage`, and an <a
 * href> would full-page reload out of the SPA. It still gets a button's
 * keyboard behaviour (Enter AND Space) for free, which a <div onClick> would
 * not.
 *
 * ⚠ It is NOT rendered inside the option list. Edit/Delete controls beside
 * every dropdown value would put ERP-wide changes behind a data-entry form;
 * this is one link, shown after a create or at the foot of the menu, pointing
 * at the screen that owns those actions.
 */
function ManageLink({ endpoint, label, onNavigate, prefix = 'Manage' }) {
  const target = masterAdminFor(endpoint, label);
  if (!target) return null;
  // ⚠ DEGRADES TO PROSE, never to nothing. A host that does not pass a
  // navigator still has to tell the user where the value is administered —
  // dropping the line because it cannot be clickable would hide the answer
  // from exactly the screens least likely to be obvious.
  if (!onNavigate) {
    return <span style={{ color: '#9ca3af' }}>{prefix} {target.plural} in {target.where}</span>;
  }
  return (
    <button
      type="button"
      style={S.manageLink}
      data-master-manage={target.page}
      data-master-manage-tab={target.tab || ''}
      title={target.where}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onNavigate(target.page, target.tab ? { tab: target.tab } : undefined);
      }}
    >
      {prefix} {target.plural} &rarr;
    </button>
  );
}

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
  ok:   { fontSize: 11, color: '#047857', fontWeight: 600 },

  // -- searchable mode -------------------------------------------------------
  //
  // /!\ EVERY layout-critical property here is set INLINE, including ones whose
  // value looks like the browser default (`display`, `whiteSpace`, `margin`).
  // That is not noise. A host page's stylesheet can reach any div this
  // component renders, and one of them did -- AddEmployee.css carried
  //
  //     .form-grid div > div { display: flex; gap: 16px; align-items: center; }
  //
  // written for a radio row, and that selector matches EVERY nested div under
  // .form-grid, this menu included. The popup became a horizontal flex strip:
  // options laid out side by side inside a ~230px box, ellipsis-clipped to two
  // or three letters each, with a horizontal scrollbar (arrow buttons and all)
  // underneath. A selector cannot override an inline `display`, so the menu now
  // states its own layout instead of inheriting whatever the page happens to
  // say. The portal below closes the same hole from the other side.
  combo:     { position: 'relative', width: '100%', display: 'block', padding: 0, margin: 0 },
  comboInput: {
    width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: 13,
    padding: '7px 26px 7px 10px', border: '1px solid #d7d7e0', borderRadius: 7,
    outline: 'none', background: '#fff', color: '#1f2937', cursor: 'pointer',
    display: 'block', textOverflow: 'ellipsis',
  },
  caret: {
    position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)',
    pointerEvents: 'none', fontSize: 9, color: '#9ca3af',
  },
  /**
   * The menu is `position: fixed` inside a PORTAL on <body>, not absolute beside
   * the input, and it is measured from the input's own bounding rect every time
   * it opens or the page moves under it.
   *
   * Absolute positioning made the menu a DESCENDANT of the field, which left
   * three separate ancestors able to break it -- two of which did:
   *   - `.accordion { overflow: hidden }`, the rounded-corner clip on every
   *     section of Add Employee, CUT THE MENU OFF at the section border for any
   *     field near the bottom of its section;
   *   - a `transform` or `filter` on any ancestor re-roots the containing block
   *     for fixed/absolute children and drags the menu off-target;
   *   - `z-index: 60` is a position within ONE stacking context -- it loses to
   *     any later sibling that opens a context of its own, whatever the number.
   * Rendered on <body>, none of the three can reach it.
   *
   * SIZING. `width: max-content`, floored at the field width and capped at the
   * room left to the viewport edge. The menu is therefore never narrower than
   * the control, never wider than the screen, and always wide enough for the
   * longest option -- which is what makes `overflowX: hidden` an assertion
   * rather than a way of hiding content. Options wrap rather than truncate, so
   * a name is never rendered as partial characters.
   */
  menu: (box) => ({
    position: 'fixed',
    zIndex: 4000,
    left: box.left,
    ...(box.flip ? { bottom: box.bottom } : { top: box.top }),
    minWidth: box.width,
    maxWidth: box.maxWidth,
    width: 'max-content',
    maxHeight: box.maxHeight,
    overflowY: 'auto',
    // Asserted, not merely expected: a horizontal scrollbar inside a select
    // menu is the defect this component was reported for.
    overflowX: 'hidden',
    overscrollBehavior: 'contain',
    display: 'block',
    boxSizing: 'border-box',
    background: '#fff',
    border: '1px solid #d7d7e0', borderRadius: 7,
    boxShadow: '0 10px 28px rgba(16,24,40,.16)', padding: 4,
    margin: 0,
    font: 'inherit',
    textAlign: 'left',
  }),
  opt: (active) => ({
    display: 'block',
    padding: '7px 9px', fontSize: 13, lineHeight: 1.35, borderRadius: 5, cursor: 'pointer',
    background: active ? '#f1ecfd' : 'transparent', color: '#1f2937',
    // Wrap, never truncate. `nowrap` + `textOverflow: ellipsis` is what reduced
    // long department names to two visible letters once the menu was squeezed.
    whiteSpace: 'normal', overflowWrap: 'anywhere', overflow: 'visible',
    margin: 0, width: 'auto',
  }),
  optAdd: (active) => ({
    display: 'block',
    padding: '7px 9px', fontSize: 13, lineHeight: 1.35, borderRadius: 5, cursor: 'pointer',
    background: active ? '#f1ecfd' : 'transparent', color: '#6B3FDB',
    fontWeight: 600, borderTop: '1px solid #f1f1f5', marginTop: 2,
    whiteSpace: 'normal', overflowWrap: 'anywhere', width: 'auto',
  }),
  none: { display: 'block', padding: '7px 9px', fontSize: 12, color: '#9ca3af', whiteSpace: 'normal' },

  /**
   * The "Manage Departments →" affordance.
   *
   * A real <button>, not prose. "Manage departments later in Administration →
   * Master Data" told the user where to go and then made them go there by
   * hand, through a menu, and pick the right one of 24 tabs. This lands on the
   * tab.
   */
  manageLink: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: 0, margin: 0, border: 'none', background: 'none',
    font: 'inherit', fontSize: 11, fontWeight: 600, color: '#5B35D5',
    cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2,
  },
  manageRow: { display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.5 },
  // Inside the dropdown, for a master managed on its own screen (branches).
  menuFooter: {
    display: 'block', padding: '7px 9px', marginTop: 2,
    borderTop: '1px solid #f1f1f5', fontSize: 11, color: '#9ca3af',
    whiteSpace: 'normal', lineHeight: 1.5,
  },

  // -- "+ Add new..." modal ---------------------------------------------------
  //
  // Portalled to <body> for the same reasons the menu is: it must not be
  // clipped by `.accordion { overflow: hidden }`, restyled by a host page's
  // descendant selectors, or trapped in an ancestor's stacking context. Every
  // layout property is inline for the same reason.
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 5000,
    background: 'rgba(17,24,39,.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, boxSizing: 'border-box',
  },
  modal: {
    display: 'block', width: '100%', maxWidth: 440, boxSizing: 'border-box',
    background: '#fff', borderRadius: 14, padding: '22px 24px 20px',
    boxShadow: '0 24px 64px rgba(16,24,40,.28)',
    font: 'inherit', textAlign: 'left', margin: 0,
    maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
  },
  modalTitle: {
    display: 'block', margin: '0 0 16px', padding: 0,
    fontSize: 16, fontWeight: 700, color: '#150F3D', letterSpacing: '-.2px',
  },
  modalReq: { color: '#dc2626', fontWeight: 800 },
  modalField: { display: 'block', marginBottom: 12 },
  modalLabel: {
    display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 700,
    color: '#374151', letterSpacing: '.03em', textTransform: 'uppercase',
  },
  modalInput: {
    display: 'block', width: '100%', boxSizing: 'border-box', font: 'inherit',
    fontSize: 13, padding: '9px 11px', border: '1.5px solid #e5e7eb',
    borderRadius: 8, outline: 'none', background: '#fafafa', color: '#111827',
  },
  modalActions: {
    display: 'flex', gap: 8, justifyContent: 'flex-end',
    marginTop: 18, paddingTop: 14, borderTop: '1px solid #f1f1f5',
  },
  // Where this value lives afterwards.
  //
  // Deliberately QUIET and BELOW the actions: a tinted, bordered panel above
  // the buttons competed with the form itself and made a two-field dialog look
  // like an admin screen. The modal's job is "add one value"; this is a
  // footnote, not a feature.
  modalWhere: {
    display: 'block', marginTop: 12, paddingTop: 10,
    borderTop: '1px solid #f4f4f7',
    fontSize: 11, color: '#9ca3af', lineHeight: 1.5, textAlign: 'center',
  },
};

// Above this many options a native <select> stops being scannable, so the
// searchable combobox takes over. `searchable` overrides it either way.
const SEARCH_THRESHOLD = 12;

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
 * @param {boolean=} searchable   force the combobox on/off. Left undefined it
 *                                turns itself on past SEARCH_THRESHOLD options.
 * @param {object=}  createExtra  fields merged into the POST body that are not
 *                                form inputs — the parent of a two-level
 *                                vocabulary, for instance. They are not shown
 *                                in the add row because the user has already
 *                                answered them in the field above.
 * @param {boolean}  allowAdd     false on FILTER pickers. A filter narrows what
 *                                is already there; offering "+ Add new…" from
 *                                one invites minting a master value that
 *                                matches no record, and the filter then shows
 *                                an empty grid with no explanation.
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
  searchable,
  allowAdd = true,
  createExtra,
  ariaLabel,
  /**
   * `(page, params) => void` — the host page's navigator (Layout's `setPage`).
   *
   * Supplied, the picker can offer "Manage Departments →" and land on the right
   * Master Data tab. Absent, the link is simply not rendered: a dead link that
   * says where to go and does not go there is worse than prose.
   */
  onNavigate,
  /**
   * Text for a stored value that is not in the loaded list (deactivated,
   * typically). Without it the raw value is shown — fine for a name-keyed
   * picker, but an id-keyed one would display a bare number like "17".
   */
  orphanLabel,
}) {
  const { hasAnyRole } = useAuth();
  const canAdd = allowAdd && hasAnyRole(...addRoles);
  // Where this master is administered, if anywhere. Used for the "Manage X"
  // link and for the menu footer shown when creation is not offered here.
  const manageTarget = masterAdminFor(endpoint, label);

  /**
   * The fields the Add modal asks for.
   *
   * Default: the name, plus an optional CODE for the masters that actually have
   * a `code` column — which is `master_values` (every module vocabulary) and
   * nothing else.
   *
   * ⚠ `master_departments`, `master_designations` and `master_zones` have NO
   * code column (id, name, is_active, created_at + the audit columns added
   * 2026-09-29 — verified against information_schema, not the migrations). A
   * Code box on those would post a field the API drops on the floor, which is
   * worse than not offering it: the user types a cost-centre code, sees it
   * accepted, and it is never stored. Adding the column is a product decision
   * that needs a consumer first — see [[project_empty_table_seed_probe_10_tables]]
   * for what a column nothing reads turns into.
   */
  const supportsCode = String(endpoint).startsWith('/master/v/');
  const addFields = fields?.length
    ? fields
    : supportsCode
      ? [{ key: 'name', label: `${label} Name`, required: true },
         { key: 'code', label: `${label} Code`, required: false,
           placeholder: 'Optional short code' }]
      : [{ key: 'name', label: `${label} Name`, required: true }];
  const blank = () => Object.fromEntries(addFields.map(f => [f.key, f.default ?? '']));

  const [rows,   setRows]   = useState([]);
  const [adding, setAdding] = useState(false);
  const [draft,  setDraft]  = useState(blank);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');
  const [created, setCreated] = useState('');   // success line after an add
  const firstInput = useRef(null);

  // ── searchable-mode state ──────────────────────────────────────────────────
  const [open,   setOpen]   = useState(false);
  const [query,  setQuery]  = useState('');
  const [cursor, setCursor] = useState(0);
  // Whether what is in the input box is something the user TYPED or the
  // selected value echoed back. Focusing a field that already holds a value
  // must show the whole list again rather than filter it down to the one row
  // already chosen — otherwise the only way to browse is to clear the box first.
  const typed = useRef(false);
  const boxRef  = useRef(null);
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  // Where the portalled menu is drawn. null while closed, so nothing is
  // measured or rendered for a picker nobody has opened.
  const [box, setBox] = useState(null);
  // Stable ids for the label association and for aria-activedescendant, which
  // is how a screen reader is told which option the arrow keys are on.
  const autoId = useId();
  const inputId = id || `ms-${autoId}`;
  const listId  = `${inputId}-listbox`;
  const optId   = (i) => `${inputId}-opt-${i}`;

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

  // -- opening, closing and staying put --------------------------------------
  //
  // A fixed-position menu is measured from the anchor, so anything that moves
  // the anchor after it opened leaves the menu stranded beside empty space.
  // Three things move it on this page: the window resizing, the page scrolling,
  // and an accordion section above it opening or closing. The first two are
  // listened for below (scroll in CAPTURE phase, so a scroll inside any
  // ancestor container counts, not only the document's); the third is covered
  // because opening a section blurs the field, which closes the menu.
  const reposition = useCallback(() => {
    if (boxRef.current) setBox(measureMenu(boxRef.current));
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    if (boxRef.current) setBox(measureMenu(boxRef.current));
    setOpen(true);
    setCursor(0);
  }, [disabled]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setBox(null);
    setQuery('');
    typed.current = false;
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener('resize', reposition);
    // capture: true -- a scroll event does not bubble, so a listener on window
    // without it would miss a scroll inside the page's own scrolling div, which
    // is exactly where this form lives.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  // Keep the highlighted option inside the scrolled menu. Without this, arrowing
  // past the tenth designation moves a cursor nobody can see.
  const cursorRef = useRef(null);
  useEffect(() => {
    // Feature-detected, not assumed. jsdom does not implement
    // scrollIntoView, and neither do some embedded webviews — an unguarded
    // call there is a TypeError thrown from a passive effect on every arrow
    // key, which takes the whole picker down rather than just the scrolling.
    const el = cursorRef.current;
    if (open && typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [open, cursor]);


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
    onChange?.(next, rows.find(r => sameValue(valueOf(r), next)) || null);
  };

  const handleCreate = async () => {
    const missing = addFields.find(f => f.required && !String(draft[f.key] ?? '').trim());
    if (missing) { setError(`${missing.label || missing.key} is required`); return; }

    const payload = { ...(createExtra || {}) };
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
      const row = res.data?.id ? res.data : (res.data?.data?.id ? res.data.data : payload);
      await load();
      setAdding(false);
      setDraft(blank());
      setQuery('');
      typed.current = false;
      const next = row[optionValue] ?? payload[optionValue] ?? '';
      onChange?.(next, row);
      // "Facilities added successfully." — names the value, not the mechanism.
      // The previous wording explained the plumbing ("added to the department
      // master and selected"), which is the one thing the user can already see.
      setCreated(`${row.name ?? next} added successfully.`);
    } catch (err) {
      const status = err?.response?.status;
      const server = err?.response?.data?.error;
      setError(
        status === 403
          ? `You do not have permission to add a ${label.toLowerCase()}. Ask an admin, or use Master Data Setup.`
          // 409 already carries a written-out duplicate message from the master
          // routes ("Technology" is already an industry.) — showing it verbatim
          // beats a generic "could not save" that hides which value collided.
          : server || err?.message || `Could not add the ${label.toLowerCase()}`
      );
    } finally {
      setSaving(false);
    }
  };

  const cancelAdd = () => { setAdding(false); setError(''); setDraft(blank()); };

  // The success line is a one-shot: any later interaction clears it, so it can
  // never sit under a field describing a save two edits ago.
  const clearCreated = () => { if (created) setCreated(''); };

  /**
   * The "+ Add new..." modal.
   *
   * ⚠ Rendered ALONGSIDE the picker, not instead of it. The previous version
   * was `if (adding) return <addRow/>`, which swapped the control out of the
   * form: the Department field literally disappeared while you were adding a
   * department, taking its label and its required marker with it, and a
   * validation run at that moment reported the field as blank.
   *
   * Portalled to <body>, like the menu, so `.accordion { overflow: hidden }`
   * cannot clip it and no host-page selector can reach it.
   *
   * Everything it saves goes to the SAME canonical endpoint the list is read
   * from, so the value is visible in Administration -> Master Data immediately.
   * `modalWhere` below says so on screen, which is the difference between a
   * convenience and a way of minting master data nobody can find later.
   */
  /**
   * "Facilities added successfully." plus the way to manage it.
   *
   * Two lines on purpose. The first confirms what happened in the user's own
   * words (the value they typed); the second answers the question a create
   * inside a data-entry form always raises — where does this live now? — with
   * a control rather than a sentence.
   */
  const createdNotice = created ? (
    <span style={S.ok} data-master-created={endpoint}>
      {created}
      <span style={S.manageRow}>
        <ManageLink endpoint={endpoint} label={label} onNavigate={onNavigate} />
      </span>
    </span>
  ) : null;

  const addModal = adding ? createPortal(
    <div
      style={S.backdrop}
      data-master-modal={endpoint}
      // A click on the backdrop itself cancels; a click inside the card must
      // not, so the target is checked rather than relying on stopPropagation
      // (which would also swallow the card's own events).
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) cancelAdd(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        // Matches the VISIBLE title exactly. An accessible name that differs
        // from the heading on screen makes the two describe different things
        // to sighted and screen-reader users.
        aria-label={`Add ${label}`}
        style={S.modal}
        data-master-adding="true"
        data-master={endpoint}
        data-master-label={label}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); if (!saving) cancelAdd(); }
          // Enter saves from any field. A <form> would submit the PAGE's form
          // instead — this component is used inside Add Employee's <form>, and
          // a nested form is invalid HTML that React renders anyway.
          if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); handleCreate(); }
        }}
      >
        <strong style={S.modalTitle}>Add {label}</strong>

        {addFields.map((f, i) => (
          <label key={f.key} style={S.modalField}>
            <span style={S.modalLabel}>
              {f.label || f.key}{f.required ? <span style={S.modalReq} aria-hidden="true"> *</span> : null}
            </span>
            {f.type === 'select' ? (
              <select
                ref={i === 0 ? firstInput : null}
                value={draft[f.key] ?? ''}
                onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                style={S.modalInput}
              >
                {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                ref={i === 0 ? firstInput : null}
                type={f.type || 'text'}
                value={draft[f.key] ?? ''}
                placeholder={f.placeholder || ''}
                autoComplete="off"
                required={f.required}
                onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                style={S.modalInput}
              />
            )}
          </label>
        ))}

        {error && <span style={{ ...S.err, display: 'block', marginTop: 2 }} role="alert">{error}</span>}

        <div style={S.modalActions}>
          <button type="button" style={S.cancel} onClick={cancelAdd} disabled={saving}>
            Cancel
          </button>
          <button type="button" style={S.save} onClick={handleCreate} disabled={saving}>
            {saving ? 'Adding…' : `Add ${label}`}
          </button>
        </div>

        {/*
          A SUBTLE secondary line, below the actions and deliberately quiet.
          This form's job is to pick a value, or add one when HR needs one — it
          is not a master-data administration screen, so there are no Edit or
          Delete controls here and no list of existing values. This one line is
          the entire answer to "where does this live afterwards?", which is the
          question an inline create has to answer or it mints orphans.
        */}
        <span style={S.modalWhere}>
          <ManageLink endpoint={endpoint} label={label} onNavigate={onNavigate} />
        </span>
      </div>
    </div>,
    document.body,
  ) : null;

  // A value already on the record but absent from the master (legacy free text,
  // or a row since deactivated) would otherwise render blank and be silently
  // wiped on the next save. Both render paths offer it back as its own option.
  const orphan = value && !rows.some(r => sameValue(valueOf(r), value)) ? value : null;

  const useSearch = searchable ?? (rows.length > SEARCH_THRESHOLD);

  // A stable hook for tests and for support, on BOTH render paths. Which path a
  // picker takes depends on how many rows the master happens to hold, so a test
  // that located it as a <select> would start failing the day someone adds a
  // thirteenth industry — which is exactly the thing this component exists to
  // make easy. Keyed on the endpoint, not the label: the label is prose.
  const hook = { 'data-master': endpoint, 'data-master-label': label };

  if (!useSearch) {
    // The bare <select> keeps whatever the host page's CSS already gives it.
    const select = (
      <select
        id={inputId}
        {...hook}
        value={value ?? ''}
        onChange={(e) => { clearCreated(); handleSelect(e); }}
        disabled={disabled}
        required={required}
        style={selectStyle}
      >
        <option value="">{placeholder || `-- Select ${label} --`}</option>
        {orphan && <option value={orphan}>{orphanLabel || orphan}</option>}
        {rows.map(r => (
          <option key={r.id ?? valueOf(r)} value={valueOf(r)}>{textOf(r)}</option>
        ))}
        {canAdd && <option value={ADD_NEW}>+ Add new {label.toLowerCase()}…</option>}
      </select>
    );
    // Wrapping unconditionally would put a flex column around every existing
    // caller's <select> and change its layout, so the wrapper appears only for
    // the one render that has something extra to say. A FRAGMENT carries the
    // modal without adding a DOM node, so the host page's CSS still sees the
    // <select> exactly where it expects it.
    return (
      <>
        {created ? <div style={S.wrap}>{select}{createdNotice}</div> : select}
        {addModal}
      </>
    );
  }

  // ── Searchable combobox ────────────────────────────────────────────────────
  // Click or focus opens the WHOLE list; typing narrows it. Re-opening a field
  // that already holds a value shows everything again rather than the one row
  // matching it — a picker you cannot browse is only usable by someone who
  // already knows what is in it.
  const selectedRow   = rows.find(r => sameValue(valueOf(r), value)) || null;
  const selectedLabel = (orphan && (orphanLabel || orphan)) || (selectedRow ? textOf(selectedRow) : '');
  const needle = typed.current ? query.trim().toLowerCase() : '';
  const matches = needle
    ? rows.filter(r => `${textOf(r)} ${valueOf(r)}`.toLowerCase().includes(needle))
    : rows;
  const optionCount = matches.length + (canAdd ? 1 : 0);

  const commit = (i) => {
    clearCreated();
    if (canAdd && i === matches.length) {
      closeMenu();
      setDraft(blank()); setError(''); setAdding(true);
      return;
    }
    const r = matches[i];
    if (!r) return;
    closeMenu();
    onChange?.(valueOf(r), r);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openMenu(); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor(c => (optionCount ? (c + step + optionCount) % optionCount : 0));
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!open) return;
      e.preventDefault();
      setCursor(e.key === 'Home' ? 0 : Math.max(0, optionCount - 1));
    } else if (e.key === 'Enter') {
      // Only swallow Enter when the menu is open. On a closed picker Enter must
      // reach the <form>, which is how this page has always been submitted.
      if (open) { e.preventDefault(); commit(cursor); }
    } else if (e.key === 'Escape') {
      // stopPropagation so Escape closes THIS menu and not, additionally, the
      // dialog or drawer the form may be sitting inside.
      if (open) { e.stopPropagation(); }
      closeMenu();
    } else if (e.key === 'Tab') {
      // Tab moves on; it must not leave an orphaned menu floating on <body>.
      closeMenu();
    }
  };

  return (
    <div style={S.wrap}>
      <div
        style={S.combo}
        ref={boxRef}
        // Blur fires before a click on a menu row registers, so closing has to
        // wait until focus has actually left the whole control. The menu is
        // portalled to <body> and is therefore NOT a DOM descendant of boxRef,
        // so it has to be asked separately -- without the second test, focusing
        // anything inside the menu would close the menu.
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (boxRef.current?.contains(to) || menuRef.current?.contains(to)) return;
          closeMenu();
        }}
      >
        <input
          id={inputId}
          ref={inputRef}
          {...hook}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-activedescendant={open && optionCount ? optId(cursor) : undefined}
          aria-label={ariaLabel || label}
          autoComplete="off"
          disabled={disabled}
          required={required && !value}
          placeholder={placeholder || `Select ${label.toLowerCase()}...`}
          value={typed.current ? query : selectedLabel}
          style={{ ...S.comboInput, ...(selectStyle || {}) }}
          onFocus={openMenu}
          onClick={openMenu}
          onChange={(e) => { clearCreated(); typed.current = true; setQuery(e.target.value); openMenu(); setCursor(0); }}
          onKeyDown={onKeyDown}
        />
        <span style={S.caret} aria-hidden="true">{'\u25bc'}</span>
      </div>

      {/*
        Portalled to <body>. See the S.menu comment: on this page the menu's
        former parent chain carried both `overflow: hidden` (which clipped it)
        and a `display: flex` rule broad enough to match it (which laid its
        options out sideways). Neither can reach a child of <body>.
      */}
      {open && box && createPortal(
        <div
          ref={menuRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel || label}
          style={S.menu(box)}
          data-master-menu={endpoint}
          // Keep focus on the input so the menu never steals it from the field
          // the arrow keys are driving.
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.length === 0 && (
            <div style={S.none} role="presentation">
              No {label.toLowerCase()} matches "{query}".
            </div>
          )}
          {matches.map((r, i) => (
            <div
              key={r.id ?? valueOf(r)}
              id={optId(i)}
              role="option"
              aria-selected={sameValue(valueOf(r), value)}
              style={S.opt(i === cursor)}
              data-master-option={valueOf(r)}
              ref={i === cursor ? cursorRef : null}
              onMouseEnter={() => setCursor(i)}
              // onMouseDown, not onClick: the input's blur would otherwise close
              // the menu before the click landed.
              onMouseDown={(e) => { e.preventDefault(); commit(i); }}
            >
              {textOf(r)}
            </div>
          ))}
          {/*
            A master that is NOT creatable from here still has to say where it
            IS managed — otherwise the Location picker is a dead end for anyone
            whose branch is missing. Not an option row: it is not selectable,
            so giving it role="option" would make the arrow keys land on
            something that cannot be chosen.
          */}
          {!canAdd && manageTarget && (
            <div style={S.menuFooter} data-master-manage-footer={endpoint}>
              <ManageLink endpoint={endpoint} label={label} onNavigate={onNavigate} />
            </div>
          )}
          {canAdd && (
            <div
              id={optId(matches.length)}
              role="option"
              aria-selected={false}
              style={S.optAdd(cursor === matches.length)}
              data-master-add={endpoint}
              ref={cursor === matches.length ? cursorRef : null}
              onMouseEnter={() => setCursor(matches.length)}
              onMouseDown={(e) => { e.preventDefault(); commit(matches.length); }}
            >
              + Add new {label.toLowerCase()}...
            </div>
          )}
        </div>,
        document.body,
      )}
      {createdNotice}
      {addModal}
    </div>
  );
}
