import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import api from "@/services/api/client";
import './EmployeesData.css';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { openEmployeeFile, downloadEmployeeFile, loadEmployeeImage, probeEmployeeFiles, isExternalUrl, EMPLOYEE_DOC_FIELDS } from '../shared/employeeFiles';
import PhotoLightbox from '../shared/PhotoLightbox';
// The same money/date/badge helpers the BGV pages use, so this summary cannot
// say something the BGV page contradicts.
import { badgeFor as bgvBadge, money as bgvMoney, shortDate as bgvDate, requiredProgressLabel as bgvProgress } from '../bgv';

const P      = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

// ⚠ 'Background Verification' is its OWN tab, not a section bolted onto
// Documents or Onboarding. The brief was explicit: "Do not overload the existing
// Overview/Personal/Job/Payroll/Documents/Assets/Onboarding/History/Notes tabs."
// It is also the right call on its merits — BGV reports are confidential in a way
// the general Documents tab is not, and this tab is a SUMMARY plus a way in, not
// a second place to do the work.
const BASE_TABS = ['Overview', 'Personal', 'Job', 'Payroll', 'Documents', 'Assets', 'Onboarding', 'Background Verification', 'History', 'Notes'];

// NOTE: InfoRow and Card are defined at module scope (not inside the component)
// so their identity is stable across renders. Defining them inline would make
// React remount the subtree on every keystroke, stealing focus from inputs
// like the Notes textarea.
const InfoRow = ({ label, value }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 0', borderBottom: `1px solid ${BORDER}` }}>
    <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
    <span style={{ fontSize: 14, color: '#111827', fontWeight: 500 }}>{value || '—'}</span>
  </div>
);

const Card = ({ title, children }) => (
  <div style={{
    background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
    padding: '20px 24px', display: 'flex', flexDirection: 'column',
  }}>
    <div style={{ fontSize: 13, fontWeight: 700, color: P, marginBottom: 8, paddingBottom: 10, borderBottom: `1px solid ${BORDER}` }}>{title}</div>
    {children}
  </div>
);

const EX_STATUSES = new Set(['left','terminated','resigned','inactive','ex-employee','notice','notice_period','notice period']);
function isExStatus(s) { return EX_STATUSES.has((s || '').toLowerCase()); }

const SEPARATION_OPTIONS = [
  { value: 'resignation',  label: 'Resignation' },
  { value: 'termination',  label: 'Termination' },
  { value: 'retirement',   label: 'Retirement' },
  { value: 'contract_end', label: 'Contract End' },
  { value: 'attrition',    label: 'Attrition' },
];

// ── Offboard Modal ────────────────────────────────────────────────────────────
function OffboardModal({ employee, onClose, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  const toast = useToast();
  const [form, setForm] = useState({
    separation_type: 'resignation',
    last_working_date: today,
    notice_period: '',
    reason: '',
  });
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  async function submit() {
    if (!form.last_working_date) { setErr('Last working date is required'); return; }
    setSaving(true); setErr('');
    try {
      await api.post(`/employees/${employee.id}/offboard`, {
        ...form,
        notice_period: form.notice_period ? Number(form.notice_period) : undefined,
      });
      onDone();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || 'Offboard failed');
    } finally { setSaving(false); }
  }

  const inp = {
    padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 7,
    fontSize: 13, width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, width: 460, padding: 28, boxShadow: '0 24px 64px rgba(0,0,0,.22)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Initiate Offboarding</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
        </div>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>
          <strong>{employee.first_name} {employee.last_name}</strong> · {employee.designation} · {employee.department}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Separation Type *</label>
            <select value={form.separation_type} onChange={e => setForm(f => ({ ...f, separation_type: e.target.value }))} style={inp}>
              {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Last Working Date *</label>
            <input type="date" value={form.last_working_date}
              onChange={e => setForm(f => ({ ...f, last_working_date: e.target.value }))}
              style={inp} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notice Period (days)</label>
            <input type="number" min="0" value={form.notice_period}
              onChange={e => setForm(f => ({ ...f, notice_period: e.target.value }))}
              placeholder="e.g. 60"
              style={inp} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Reason / Notes</label>
            <textarea rows={3} value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="Brief reason for separation…"
              style={{ ...inp, resize: 'vertical' }} />
          </div>
        </div>

        {err && <p style={{ margin: '10px 0 0', color: '#b91c1c', fontSize: 12 }}>{err}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            padding: '9px 18px', border: 'none', borderRadius: 8,
            background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700,
            cursor: saving ? 'default' : 'pointer', opacity: saving ? .7 : 1,
          }}>
            {saving ? 'Processing…' : 'Confirm Offboarding'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Manage Checklist ──────────────────────────────────────────────────────────
/**
 * HR/Admin editor for the onboarding checklist ITEMS (the templates), as
 * opposed to one employee's completion of them.
 *
 * Backed by `hr_onboarding_checklist_templates` — the same table the checklist
 * has always been generated from. There is no second onboarding system here.
 *
 * Two behaviours are the backend's, surfaced rather than reimplemented:
 *   - renaming an item carries its completion history with it, so nobody's
 *     ticked box disappears because HR fixed a typo;
 *   - deleting an item that employees have history against DEACTIVATES it
 *     instead, and the response says which happened.
 */
function ManageChecklistModal({ onClose, onChanged }) {
  const toast = useToast();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft]     = useState({ category: '', item_label: '', default_assignee: 'HR', default_offset_days: 0, sort_order: 0 });
  const [adding, setAdding]   = useState({ category: '', item_label: '', default_assignee: 'HR', default_offset_days: 0 });

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/onboarding/templates', { params: { include_inactive: true } });
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not load the checklist');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The categories already in use, offered as a datalist so HR reuses the
  // existing sections (Admin, Documentation, Finance, HR, Induction, IT, …)
  // instead of quietly creating a near-duplicate by typing "H R".
  const categories = [...new Set(rows.map(r => r.category).filter(Boolean))].sort();

  const after = async (msg) => { await load(); onChanged?.(); if (msg) toast.success(msg); };

  const add = async () => {
    const category = adding.category.trim(), item_label = adding.item_label.trim();
    if (!category || !item_label) { toast.error('Category and item are both required'); return; }
    setBusy(true);
    try {
      await api.post('/onboarding/templates', {
        category, item_label,
        default_assignee: adding.default_assignee.trim() || 'HR',
        default_offset_days: Number(adding.default_offset_days) || 0,
        // Put a new item at the end of its category rather than the top.
        sort_order: Math.max(0, ...rows.filter(r => r.category === category).map(r => r.sort_order || 0)) + 1,
      });
      setAdding({ category: '', item_label: '', default_assignee: 'HR', default_offset_days: 0 });
      await after('Checklist item added');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not add the item');
    } finally { setBusy(false); }
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setDraft({
      category: r.category, item_label: r.item_label,
      default_assignee: r.default_assignee || 'HR',
      default_offset_days: r.default_offset_days ?? 0,
      sort_order: r.sort_order ?? 0,
    });
  };

  const saveEdit = async () => {
    if (!draft.category.trim() || !draft.item_label.trim()) { toast.error('Category and item are both required'); return; }
    setBusy(true);
    try {
      await api.put(`/onboarding/templates/${editingId}`, {
        category: draft.category.trim(),
        item_label: draft.item_label.trim(),
        default_assignee: draft.default_assignee.trim() || 'HR',
        default_offset_days: Number(draft.default_offset_days) || 0,
        sort_order: Number(draft.sort_order) || 0,
      });
      setEditingId(null);
      await after('Checklist item updated');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not save the item');
    } finally { setBusy(false); }
  };

  const toggleActive = async (r) => {
    setBusy(true);
    try {
      await api.put(`/onboarding/templates/${r.id}`, { is_active: !r.is_active });
      await after(r.is_active ? 'Item deactivated' : 'Item reactivated');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not change the item');
    } finally { setBusy(false); }
  };

  const remove = async (r) => {
    const used = r.usage_count > 0;
    const question = used
      ? `"${r.item_label}" is on ${r.usage_count} employee record${r.usage_count === 1 ? '' : 's'}. It will be DEACTIVATED so that history is kept, not deleted. Continue?`
      : `Delete "${r.item_label}"? Nothing has been recorded against it.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const res = await api.delete(`/onboarding/templates/${r.id}`);
      await after(res.data?.message || 'Done');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not remove the item');
    } finally { setBusy(false); }
  };

  const inp = { padding: '6px 9px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 12.5, width: '100%', boxSizing: 'border-box' };
  const byCategory = rows.reduce((acc, r) => { (acc[r.category] ||= []).push(r); return acc; }, {});

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 2500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 880, maxWidth: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,.22)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px 12px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Manage Onboarding Checklist</h3>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
              Applies to every new employee. Changes here do not alter what anyone has already completed.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280', lineHeight: 1 }}>&times;</button>
        </div>

        {/* Add */}
        <div style={{ padding: '0 24px 14px' }}>
          <div style={{ background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr 130px 90px auto', gap: 10, alignItems: 'end' }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Category *
                <input list="zzve-ob-categories" value={adding.category} placeholder="e.g. IT Setup"
                  onChange={e => setAdding(a => ({ ...a, category: e.target.value }))} style={inp} />
                <datalist id="zzve-ob-categories">
                  {categories.map(c => <option key={c} value={c} />)}
                </datalist>
              </label>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Checklist item *
                <input value={adding.item_label} placeholder="e.g. Issue laptop and charger"
                  onChange={e => setAdding(a => ({ ...a, item_label: e.target.value }))} style={inp} />
              </label>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Owner
                <input value={adding.default_assignee}
                  onChange={e => setAdding(a => ({ ...a, default_assignee: e.target.value }))} style={inp} />
              </label>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Due (days)
                <input type="number" min="0" value={adding.default_offset_days}
                  onChange={e => setAdding(a => ({ ...a, default_offset_days: e.target.value }))} style={inp} />
              </label>
              <button onClick={add} disabled={busy} style={{ padding: '8px 18px', background: P, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? .6 : 1, whiteSpace: 'nowrap' }}>
                Add Item
              </button>
            </div>
          </div>
        </div>

        {/* List */}
        <div style={{ overflowY: 'auto', padding: '0 24px 20px', flex: 1 }}>
          {loading ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading checklist...</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No checklist items yet. Add the first one above.</div>
          ) : Object.entries(byCategory).map(([cat, items]) => (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: P, margin: '10px 0 6px' }}>{cat}</div>
              <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
                {items.map((r, i) => (
                  <div key={r.id} className="ob-tpl-row" data-item-label={r.item_label}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: i < items.length - 1 ? '1px solid #f3f4f6' : 'none', background: r.is_active ? '#fff' : '#fafafa' }}>
                    {editingId === r.id ? (
                      <>
                        <input value={draft.category} list="zzve-ob-categories" onChange={e => setDraft(d => ({ ...d, category: e.target.value }))} style={{ ...inp, width: 150 }} />
                        <input value={draft.item_label} onChange={e => setDraft(d => ({ ...d, item_label: e.target.value }))} style={{ ...inp, flex: 1 }} />
                        <input value={draft.default_assignee} onChange={e => setDraft(d => ({ ...d, default_assignee: e.target.value }))} style={{ ...inp, width: 100 }} />
                        <input type="number" min="0" value={draft.default_offset_days} onChange={e => setDraft(d => ({ ...d, default_offset_days: e.target.value }))} style={{ ...inp, width: 70 }} />
                        <button onClick={saveEdit} disabled={busy} style={{ padding: '5px 12px', background: P, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Save</button>
                        <button onClick={() => setEditingId(null)} style={{ padding: '5px 10px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 11.5, cursor: 'pointer' }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: r.is_active ? '#111827' : '#9ca3af', fontWeight: 500 }}>
                            {r.item_label}
                            {!r.is_active && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 10, padding: '1px 7px' }}>INACTIVE</span>}
                            {r.company_id == null && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#374151', background: '#f3f4f6', borderRadius: 10, padding: '1px 7px' }}>SHARED DEFAULT</span>}
                          </div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>
                            {r.default_assignee || 'HR'} &middot; due day {r.default_offset_days ?? 0}
                            {r.usage_count > 0 && ` \u00b7 on ${r.usage_count} employee record${r.usage_count === 1 ? '' : 's'}`}
                          </div>
                        </div>
                        {/* A shared default (company_id NULL) belongs to every
                            tenant, so this screen does not offer to edit it. */}
                        {r.company_id != null && (
                          <>
                            <button onClick={() => startEdit(r)} disabled={busy} style={{ padding: '4px 11px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 11.5, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>Edit</button>
                            <button onClick={() => toggleActive(r)} disabled={busy} style={{ padding: '4px 11px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 11.5, fontWeight: 600, color: r.is_active ? '#92400e' : '#15803d', cursor: 'pointer' }}>
                              {r.is_active ? 'Deactivate' : 'Reactivate'}
                            </button>
                            <button onClick={() => remove(r)} disabled={busy} style={{ padding: '4px 11px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 11.5, fontWeight: 600, color: '#b91c1c', cursor: 'pointer' }}>
                              {r.usage_count > 0 ? 'Retire' : 'Delete'}
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ borderTop: `1px solid ${BORDER}`, padding: '12px 24px', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 20px', background: P, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function EmployeeProfile({ employee: employeeProp, setPage, setSelectedEmployee: _setSelectedEmployee, urlParams }) {
  const toast = useToast();

  const [employee, setEmployee] = useState(employeeProp || null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const isMounted = useRef(true);

  // Deep-linkable tab, so callers can land on a specific section rather than
  // Overview — My Workbench's "Recently Hired" card links straight to Onboarding.
  // Validated against BASE_TABS: an unknown ?tab= would otherwise render a header
  // with no matching panel below it. 'Exit Details' is intentionally not reachable
  // this way, since it only exists for ex-employees and is added later, per-record.
  const [activeTab, setActiveTab] = useState(
    BASE_TABS.includes(urlParams?.tab) ? urlParams.tab : "Overview"
  );
  const [notesList, setNotesList] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [showOffboardModal, setShowOffboardModal] = useState(false);
  const [exitData, setExitData] = useState(null);
  const [clearanceData, setClearanceData] = useState(null);
  const [docRecords, setDocRecords] = useState([]);
  const [assetRecords, setAssetRecords] = useState([]);
  const [assetLoading, setAssetLoading] = useState(false);
  const [onboardingData, setOnboardingData] = useState(null);
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const [onboardingInit, setOnboardingInit] = useState(false);
  // True only when the progress API answered 403. Kept apart from "no items":
  // a refused viewer is not looking at an empty checklist, and must not be
  // offered Initialize as if they were.
  const [onboardingDenied, setOnboardingDenied] = useState(false);
  const [salaryRevisions, setSalaryRevisions] = useState([]);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [photoSrc, setPhotoSrc] = useState(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  // stored path -> file is present. `null` while the probe is in flight, so the
  // table can say "Checking..." rather than asserting either answer.
  const [filePresence, setFilePresence] = useState(null);
  // Background verification summary. `undefined` while unfetched, `null` when
  // the caller is not allowed to see it — the tab then says so instead of
  // rendering zeroes that read as "no checks run".
  const [bgv, setBgv] = useState(undefined);
  const [bgvDenied, setBgvDenied] = useState(false);
  const [manageChecklist, setManageChecklist] = useState(false);
  const [clearanceSaving, setClearanceSaving] = useState(false);
  const [showExitEdit, setShowExitEdit] = useState(false);
  const [exitEditForm, setExitEditForm] = useState({ separation_type: '', last_working_date: '', exit_reason: '' });
  const [savingExit,   setSavingExit]   = useState(false);
  const [exitEditErr,  setExitEditErr]  = useState('');

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (employee) return;
    // Fast path: full object already in sessionStorage (skip if URL param overrides)
    const urlId = urlParams?.id ? String(urlParams.id) : null;
    try {
      const stored = JSON.parse(sessionStorage.getItem('selectedEmployee') || 'null');
      if (stored?.id && (!urlId || String(stored.id) === urlId)) { setEmployee(stored); return; }
    } catch {}
    // Slow path: fetch from backend using URL param or sessionStorage id
    const empId = urlId || sessionStorage.getItem('selectedEmployeeId');
    if (!empId) return;
    setLoading(true);
    setFetchError(null);
    api.get(`/employees/${empId}`)
      .then(res => {
        if (!isMounted.current) return;
        const data = res.data?.employee || res.data;
        if (data?.id) setEmployee(data);
        else setFetchError('Employee not found');
      })
      .catch(() => { if (isMounted.current) setFetchError('Failed to load employee'); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, [employee]);

  const fetchNotes = async () => {
    setNotesLoading(true);
    try {
      const res = await api.get(`/notes/${employee.id}`);
      if (isMounted.current) setNotesList(Array.isArray(res.data) ? res.data : []);
    } catch {
      /* A notes read failure leaves the list as it was rather than blanking it. */
    } finally { if (isMounted.current) setNotesLoading(false); }
  };

  useEffect(() => {
    if (employee?.id) fetchNotes();
  }, [employee?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openExitEdit = () => {
    setExitEditForm({
      separation_type:   exitData?.separation_type || employee?.separation_type || '',
      last_working_date: exitData?.last_working_date
        ? exitData.last_working_date.slice(0, 10)
        : (employee?.exit_date ? String(employee.exit_date).slice(0, 10) : ''),
      exit_reason: exitData?.reason || employee?.exit_reason || '',
    });
    setExitEditErr('');
    setShowExitEdit(true);
  };

  const saveExitDetails = async () => {
    setSavingExit(true); setExitEditErr('');
    try {
      await api.patch(`/employees/ex/${employee.id}/exit-details`, {
        separation_type:   exitEditForm.separation_type   || null,
        last_working_date: exitEditForm.last_working_date || null,
        exit_date:         exitEditForm.last_working_date || null,
        exit_reason:       exitEditForm.exit_reason       || null,
      });
      const r = await api.get(`/exit/employee/${employee.id}`);
      if (isMounted.current) {
        setExitData(r.data?.exit_request ?? null);
        setClearanceData(r.data?.clearance ?? null);
      }
      setShowExitEdit(false);
    } catch (e) {
      setExitEditErr(e.response?.data?.error || 'Save failed');
    } finally { setSavingExit(false); }
  };

  // Load exit request + clearance data when viewing an ex-employee
  useEffect(() => {
    if (!employee?.id) return;
    if (!isExStatus(employee.status)) return;
    api.get(`/exit/employee/${employee.id}`)
      .then(r => {
        if (!isMounted.current) return;
        setExitData(r.data?.exit_request ?? null);
        setClearanceData(r.data?.clearance ?? null);
      })
      .catch(() => { if (isMounted.current) toast.error('Could not load exit data'); });
  }, [employee?.id, employee?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load supplemental document records from employee_documents table
  useEffect(() => {
    if (!employee?.id) return;
    api.get('/self-service/documents', { params: { employee_id: employee.id } })
      .then(r => {
        if (!isMounted.current) return;
        setDocRecords(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {});
  }, [employee?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the background-verification summary.
  //
  // Fetched from /bgv/employees/:id/summary, which is built from the SAME SQL
  // (CASE_SELECT) that the BGV list and the BGV page use — so this tab's
  // "3/5 checks" cannot disagree with the number the BGV page shows. It is not
  // recomputed here from the checks, because a second calculation is a second
  // answer waiting to drift.
  //
  // A 403 is a real state, not a failure: a role can reach View Employee and
  // legitimately hold no BGV grant. Recorded separately from an empty case so
  // the panel says "you cannot see this" rather than "no checks have been run".
  useEffect(() => {
    if (!employee?.id || activeTab !== 'Background Verification') return;
    api.get(`/bgv/employees/${employee.id}/summary`)
      .then(r => { if (isMounted.current) { setBgv(r.data || null); setBgvDenied(false); } })
      .catch(err => {
        if (!isMounted.current) return;
        if (err.response?.status === 403) { setBgvDenied(true); setBgv(null); }
        else setBgv(null);
      });
  }, [employee?.id, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load employee asset allocations
  useEffect(() => {
    if (!employee?.id || activeTab !== 'Assets') return;
    setAssetLoading(true);
    api.get('/employee-assets', { params: { employee_id: employee.id } })
      .then(r => {
        if (!isMounted.current) return;
        setAssetRecords(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {})
      .finally(() => { if (isMounted.current) setAssetLoading(false); });
  }, [employee?.id, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load onboarding checklist progress
  useEffect(() => {
    if (!employee?.id || activeTab !== 'Onboarding') return;
    setOnboardingLoading(true);
    setOnboardingDenied(false);
    api.get(`/onboarding/progress/${employee.id}`)
      .then(r => { if (isMounted.current) setOnboardingData(r.data); })
      .catch((err) => {
        // 403: the server decided this viewer may not see this checklist
        // (onboarding.routes.js — HR, self, or a manager of the employee). It
        // says nothing about whether one exists, and neither does this message.
        // Any other failure keeps the previous handling.
        if (isMounted.current && err?.response?.status === 403) {
          setOnboardingData(null);
          setOnboardingDenied(true);
        }
      })
      .finally(() => { if (isMounted.current) setOnboardingLoading(false); });
  }, [employee?.id, activeTab, onboardingInit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Confirm the listed documents actually exist before the tab calls them
  // "On file". These columns are stored paths, not evidence: EMP003 carries
  // five that point at files which are not on disk.
  useEffect(() => {
    if (!employee?.id || activeTab !== 'Documents') return;
    const paths = [
      ...EMPLOYEE_DOC_FIELDS.map(d => employee[d.key]),
      ...docRecords.map(d => d.drive_url || d.file_url),
    ].filter(Boolean);
    if (!paths.length) { setFilePresence({}); return; }
    let cancelled = false;
    setFilePresence(null);
    probeEmployeeFiles(paths).then(map => { if (!cancelled && isMounted.current) setFilePresence(map); });
    return () => { cancelled = true; };
  }, [employee?.id, activeTab, docRecords]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the employee photo. `employees.photo_url` holds a stored path such as
  // '/uploads/<name>'; the bytes come back through the authenticated file route
  // as a blob, because an <img src> cannot carry the JWT that route requires.
  // The object URL is revoked when the photo changes or the page unmounts.
  useEffect(() => {
    const stored = employee?.photo_url;
    if (!stored) { setPhotoSrc(null); return; }
    let objectUrl = null;
    let cancelled = false;
    loadEmployeeImage(stored).then(url => {
      if (cancelled) { if (url && !isExternalUrl(stored)) URL.revokeObjectURL(url); return; }
      objectUrl = isExternalUrl(stored) ? null : url;
      setPhotoSrc(url);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [employee?.photo_url]);

  // Load salary revisions for History tab
  useEffect(() => {
    if (!employee?.id || activeTab !== 'History') return;
    setSalaryLoading(true);
    api.get(`/employees/${employee.id}/salary-revisions`)
      .then(r => { if (isMounted.current) setSalaryRevisions(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setSalaryRevisions([]); })
      .finally(() => { if (isMounted.current) setSalaryLoading(false); });
  }, [employee?.id, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived from `employee`, which can be null while the record loads — hence
  // the optional chaining. Both of these sit ABOVE the early returns on
  // purpose: useMemo after a conditional return runs in a different order on
  // the loading render than on the loaded one, which is a hook-order violation
  // (eslint react-hooks/rules-of-hooks catches it; React fails at runtime).
  const initials = `${(employee?.first_name || '?').charAt(0)}${(employee?.last_name || '').charAt(0)}`.toUpperCase();

  // PageHero renders `icon` as a component (<Icon size={22} />), so the avatar
  // is supplied as one. It is memoised on its own inputs because a component
  // declared fresh on every render is a NEW TYPE every render, which makes
  // React unmount and remount the whole subtree — the exact bug that made
  // AddEmployee lose focus on every keystroke. Falls back to initials, which is
  // also what every employee without a photo gets.
  const employeeName = `${employee?.first_name || ''} ${employee?.last_name || ''}`.trim();
  const AvatarChip = useMemo(() => {
    // With a photo the chip is a button that opens the full-size viewer; with
    // no photo it stays a plain span, so the initials fallback cannot open an
    // empty lightbox.
    const Chip = () => (
      photoSrc
        ? <button
            type="button"
            onClick={() => setPhotoOpen(true)}
            title="View full-size photo"
            aria-label={`View ${employeeName || 'employee'}'s photo full size`}
            style={{ width: '100%', height: '100%', padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', display: 'block' }}
          >
            <img
              src={photoSrc}
              alt={employeeName || 'Employee photo'}
              style={{ width: '100%', height: '100%', borderRadius: 9, objectFit: 'cover', display: 'block' }}
            />
          </button>
        : <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '.02em' }}>{initials}</span>
    );
    return Chip;
  }, [photoSrc, initials, employeeName]);

  // Esc is handled inside PhotoLightbox, bound only while it is mounted.
  const closePhoto = useCallback(() => setPhotoOpen(false), []);

  // A photo that disappears (record reloaded, employee switched) must not leave
  // a lightbox open over nothing.
  useEffect(() => { if (!photoSrc) setPhotoOpen(false); }, [photoSrc]);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
        Loading employee data…
      </div>
    );
  }

  if (fetchError || !employee) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
        {fetchError || 'No employee selected.'}{' '}
        <button onClick={() => setPage('EmployeesData')} style={{ color: P, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Go back</button>
      </div>
    );
  }

  const isEx  = isExStatus(employee.status);
  const TABS  = isEx ? [...BASE_TABS, 'Exit Details'] : BASE_TABS;


  const fmtDate = (d) => d ? new Date(d.split('T')[0] + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
  const yearsFrom = (d) => d ? Math.floor((new Date() - new Date(d.split('T')[0] + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000)) : null;

  const STATUS_STYLE = {
    Active:    { bg: '#dcfce7', color: '#166534' },
    Probation: { bg: '#ede9fe', color: '#5b21b6' },
    Notice:    { bg: '#fee2e2', color: '#991b1b' },
    Left:      { bg: '#f3f4f6', color: '#6b7280' },
  };
  const ss = STATUS_STYLE[employee.status] || STATUS_STYLE.Active;

  return (
    <PageShell dock={
      <PageHero
        icon={AvatarChip}
        eyebrow="Employees"
        // `${first}${last}` with no separator — the header read "MalarNatesh".
        title={employeeName}
        subtitle={[employee.office_id, employee.designation, employee.department].filter(Boolean).join(' · ') || null}
        // NO page-level Back button here. Pulse's standard Back lives in the
        // Topbar and is on every page; this hero carried a second one ("← Back
        // to List"), so the screen offered two. Removing the page copy is what
        // makes this page match the rest of the app — the Topbar's own Back is
        // untouched, and no per-page suppression is involved.
        actions={<>
          {!isEx && (
              <button className="plh-cta plh-cta--ghost" onClick={() => setShowOffboardModal(true)}>
                🚪 Offboard
              </button>
            )}
          <button className="plh-cta" onClick={() => {
              sessionStorage.setItem('selectedEmployee', JSON.stringify(employee));
              sessionStorage.setItem('selectedEmployeeId', String(employee.id));
              setPage('EditEmployee');
            }}>
              ✏️ Edit Employee
            </button>
        </>}
      />
    }>

      {/* Edit Exit Details modal */}
      {showExitEdit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, width: 440, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Edit Exit Details</h3>
              <button onClick={() => setShowExitEdit(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
            </div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
              {employee.first_name} {employee.last_name} · {employee.office_id}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Separation Type</label>
                <select value={exitEditForm.separation_type}
                  onChange={e => setExitEditForm(f => ({ ...f, separation_type: e.target.value }))}
                  style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' }}>
                  <option value="">— Not specified —</option>
                  {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Last Working Date</label>
                <input type="date" value={exitEditForm.last_working_date}
                  onChange={e => setExitEditForm(f => ({ ...f, last_working_date: e.target.value }))}
                  style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Exit Reason / Details</label>
                <textarea rows={3} value={exitEditForm.exit_reason}
                  onChange={e => setExitEditForm(f => ({ ...f, exit_reason: e.target.value }))}
                  placeholder="Reason for leaving…"
                  style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
              </div>
            </div>
            {exitEditErr && <p style={{ margin: '12px 0 0', color: '#b91c1c', fontSize: 12 }}>{exitEditErr}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowExitEdit(false)} style={{ padding: '8px 16px', border: `1px solid ${BORDER}`, borderRadius: 7, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveExitDetails} disabled={savingExit} style={{ padding: '8px 16px', border: 'none', borderRadius: 7, background: P, color: '#fff', fontSize: 13, fontWeight: 600, cursor: savingExit ? 'default' : 'pointer', opacity: savingExit ? .7 : 1 }}>
                {savingExit ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full-size photo viewer — shared with View Intern (shared/PhotoLightbox). */}
      {photoOpen && photoSrc && (
        <PhotoLightbox
          src={photoSrc}
          name={employeeName}
          code={employee.office_id}
          onClose={closePhoto}
          onDownload={async () => { const err = await downloadEmployeeFile(employee.photo_url); if (err) toast.error(err); }}
        />
      )}

      {/* Manage Checklist (HR/Admin) */}
      {manageChecklist && (
        <ManageChecklistModal
          onClose={() => setManageChecklist(false)}
          // Re-fetch this employee's checklist after any template change, so an
          // added item appears and a retired one drops out without a reload.
          onChanged={() => setOnboardingInit(v => !v)}
        />
      )}

      {/* Offboard modal */}
      {showOffboardModal && (
        <OffboardModal
          employee={employee}
          onClose={() => setShowOffboardModal(false)}
          onDone={() => {
            // Reload employee so status badge and tabs update
            api.get(`/employees/${employee.id}`).then(r => {
              const data = r.data?.employee || r.data;
              if (data?.id) setEmployee(data);
            }).catch(() => {});
          }}
        />
      )}

      {/* ── Hero ── */}

      {/* ── Tabs ── */}
      <div className="emp-profile-tabs" style={{
        background:'#fff', borderBottom:`1px solid ${BORDER}`,
        padding:'0 32px', display:'flex', gap:0, overflowX:'auto',
        boxShadow:'0 1px 4px rgba(0,0,0,.04)',
      }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding:'14px 18px', border:'none', background:'none', cursor:'pointer',
              fontSize:13, fontWeight:600, whiteSpace:'nowrap',
              color: activeTab === tab ? P : '#6b7280',
              borderBottom: activeTab === tab ? `2px solid ${P}` : '2px solid transparent',
              transition:'color .15s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="emp-profile-content" style={{ padding:'24px 32px 40px' }}>

        {/* OVERVIEW */}
        {activeTab === 'Overview' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Personal">
              <InfoRow label="Full Name" value={`${employee.first_name || ''} ${employee.last_name || ''}`.trim()} />
              <InfoRow label="Gender" value={employee.gender} />
              <InfoRow label="Blood Group" value={employee.blood_group} />
              <InfoRow label="Marital Status" value={employee.marital_status} />
              <InfoRow label="Date of Birth" value={fmtDate(employee.dob)} />
              <InfoRow label="Age" value={yearsFrom(employee.dob) != null ? `${yearsFrom(employee.dob)} years` : null} />
            </Card>
            <Card title="Work">
              <InfoRow label="Department" value={employee.department} />
              <InfoRow label="Designation" value={employee.designation} />
              <InfoRow label="Reporting Manager" value={employee.reporting_manager} />
              <InfoRow label="Location" value={employee.location} />
              <InfoRow label="Employment Type" value={employee.employment_type} />
              <InfoRow label="Zone" value={employee.zone} />
            </Card>
            <Card title="Joining">
              <InfoRow label="Joining Date" value={fmtDate(employee.joining_date)} />
              <InfoRow label="Experience Here" value={yearsFrom(employee.joining_date) != null ? `${yearsFrom(employee.joining_date)} years` : null} />
              <InfoRow label="Total Experience" value={(() => {
                const here = yearsFrom(employee.joining_date) || 0;
                const prev = (employee.previous_years_1 || 0) + (employee.previous_years_2 || 0);
                return `${here + prev} years`;
              })()} />
              <InfoRow label="Skill Type" value={employee.skill_type} />
              {/* Set when this hire was converted from an internship; the intern
                  record is kept as history (internConversion.js). */}
              {employee.source_intern_id && (
                <InfoRow label="Previously an Intern" value={
                  <button type="button" className="ai-link" onClick={() => setPage('ViewIntern', { id: employee.source_intern_id })}>
                    {employee.source_intern_code || `Intern #${employee.source_intern_id}`}
                  </button>
                } />
              )}
            </Card>
          </div>
        )}

        {/* PERSONAL */}
        {activeTab === 'Personal' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Basic Info">
              <InfoRow label="Date of Birth" value={fmtDate(employee.dob)} />
              <InfoRow label="Gender" value={employee.gender} />
              <InfoRow label="Blood Group" value={employee.blood_group} />
              <InfoRow label="Marital Status" value={employee.marital_status} />
              <InfoRow label="Father's Name" value={employee.father_name} />
            </Card>
            <Card title="Contact">
              <InfoRow label="Mobile" value={employee.phone} />
              <InfoRow label="Company Email" value={employee.company_email} />
              <InfoRow label="Personal Email" value={employee.personal_email} />
              <InfoRow label="Current Address" value={employee.current_address} />
              <InfoRow label="Permanent Address" value={employee.permanent_address} />
            </Card>
            <Card title="Family">
              <InfoRow label="Mother's Name" value={employee.mother_name} />
              <InfoRow label="Spouse" value={employee.spouse_name} />
              <InfoRow label="Emergency Contact" value={employee.emergency_name} />
              <InfoRow label="Emergency Phone" value={employee.emergency_phone} />
              <InfoRow label="Relationship" value={employee.emergency_relationship} />
            </Card>
          </div>
        )}

        {/* JOB */}
        {activeTab === 'Job' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Position">
              <InfoRow label="Designation" value={employee.designation} />
              <InfoRow label="Department" value={employee.department} />
              <InfoRow label="Reporting Manager" value={employee.reporting_manager} />
              <InfoRow label="Location" value={employee.location} />
            </Card>
            <Card title="Employment">
              <InfoRow label="Employment Type" value={employee.employment_type} />
              <InfoRow label="Joining Date" value={fmtDate(employee.joining_date)} />
              <InfoRow label="Skill Type" value={employee.skill_type} />
              <InfoRow label="Zone" value={employee.zone} />
            </Card>
            <Card title="Previous Experience">
              <InfoRow label="Company 1" value={employee.previous_company_1} />
              <InfoRow label="Role" value={employee.previous_role_1} />
              <InfoRow label="Years" value={employee.previous_years_1 ? `${employee.previous_years_1} yr` : null} />
              <InfoRow label="Company 2" value={employee.previous_company_2} />
              <InfoRow label="Role" value={employee.previous_role_2} />
              <InfoRow label="Years" value={employee.previous_years_2 ? `${employee.previous_years_2} yr` : null} />
            </Card>
          </div>
        )}

        {/* PAYROLL */}
        {activeTab === 'Payroll' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Bank Details">
              <InfoRow label="Bank Name" value={employee.bank_name} />
              <InfoRow label="Branch" value={employee.branch_name} />
              <InfoRow label="Account Number" value={employee.account_number} />
              <InfoRow label="IFSC Code" value={employee.ifsc_code} />
              <InfoRow label="Nominee" value={employee.nominee_name} />
            </Card>
            <Card title="Government IDs">
              <InfoRow label="PAN Number" value={employee.pan_number} />
              <InfoRow label="Aadhaar Number" value={employee.aadhaar_number} />
              <InfoRow label="PF Number" value={employee.pf_number} />
              <InfoRow label="UAN Number" value={employee.uan_number} />
              <InfoRow label="ESIC Number" value={employee.esic_number} />
            </Card>
            <Card title="Education">
              <InfoRow label="Highest Qualification" value={employee.highest_qualification} />
              <InfoRow label="Basic Qualification" value={employee.basic_qualification} />
            </Card>
          </div>
        )}

        {/* DOCUMENTS — READ ONLY.
            Everything here was captured on Add / Edit Employee. This tab shows
            what is on file; it does not ask HR to upload the same document a
            second time. */}
        {activeTab === 'Documents' && (() => {
          // The seven file columns Add Employee writes, in the order that page
          // presents them. `photo_url` is the same column the header avatar
          // reads — one store, shown in two places, not two stores.
          const onFile = EMPLOYEE_DOC_FIELDS
            .map(d => ({ ...d, stored: employee[d.key] }))
            .filter(d => d.stored);

          const fileName = (stored) => {
            const raw = String(stored || '').split('/').pop() || '';
            // Stored as '<epoch>_<original name>'; show the name HR chose.
            return decodeURIComponent(raw.replace(/^\d+_/, '')) || raw;
          };

          const rows = [
            ...onFile.map(d => ({
              id: `emp:${d.key}`,
              type: d.label,
              name: fileName(d.stored),
              icon: d.icon,
              date: employee.updated_at || employee.created_at || null,
              source: 'Employee record',
              stored: d.stored,
            })),
            ...docRecords.map(doc => ({
              id: `rec:${doc.id}`,
              type: doc.document_type || doc.type || '\u2014',
              name: doc.document_name || doc.name || fileName(doc.file_url) || '\u2014',
              icon: '\uD83D\uDCCE',
              date: doc.uploaded_at || doc.created_at || null,
              expiry: doc.expiry_date || null,
              recordStatus: doc.status || (doc.verified ? 'verified' : 'pending'),
              source: doc.drive_url ? 'Drive' : 'HR record',
              stored: doc.drive_url || doc.file_url || null,
            })),
          ];

          const STATUS_C = { verified:'#15803d', pending:'#5b21b6', rejected:'#dc2626', active:'#15803d', 'On file':'#15803d', Missing:'#b91c1c', Checking:'#6b7280' };
          const STATUS_B = { verified:'#dcfce7', pending:'#ede9fe', rejected:'#fee2e2', active:'#dcfce7', 'On file':'#dcfce7', Missing:'#fee2e2', Checking:'#f3f4f6' };

          // "On file" is a claim about storage, so it is only made once the
          // probe has confirmed it. A record whose file is gone says so, and
          // says it where HR reads the row rather than only when they click.
          const statusOf = (r) => {
            if (!r.stored) return 'No file';
            if (filePresence === null) return 'Checking';
            if (filePresence[r.stored] === false) return 'Missing';
            return r.recordStatus || 'On file';
          };
          const missingCount = filePresence
            ? rows.filter(r => r.stored && filePresence[r.stored] === false).length
            : 0;

          return (
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', flexWrap:'wrap', gap:8 }}>
                <div style={{ fontSize:13, fontWeight:700, color:P }}>
                  Employee Documents
                  {rows.length > 0 && <span style={{ marginLeft:8, fontWeight:400, color:'#6b7280' }}>({rows.length})</span>}
                </div>
                <div style={{ fontSize:11, color:'#9ca3af' }}>
                  Uploaded on Add / Edit Employee. This tab is read-only.
                </div>
              </div>

              {missingCount > 0 && (
                <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:10, padding:'10px 14px', fontSize:12, color:'#991b1b' }}>
                  <strong>{missingCount} document{missingCount === 1 ? ' has' : 's have'} no file in storage.</strong>
                  {' '}The record still names a file, but nothing is stored against it — it needs to be uploaded again on Edit Employee.
                </div>
              )}

              {rows.length === 0 ? (
                <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'40px 24px', textAlign:'center' }}>
                  <div style={{ fontSize:34, marginBottom:10 }}>{'\uD83D\uDCC4'}</div>
                  <div style={{ fontWeight:700, color:'#374151', marginBottom:6 }}>No documents on file</div>
                  <div style={{ color:'#6b7280', fontSize:13 }}>
                    Documents are attached on <strong>Edit Employee &rarr; Upload Documents</strong>
                    {' '}(Photo, PAN, Aadhaar, Cheque, Bank Statement, Resume, Offer Letter).
                  </div>
                </div>
              ) : (
                <div className="emp-profile-table-wrap" style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, overflow:'hidden' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead>
                      <tr style={{ background:'#f9fafb', borderBottom:`1px solid ${BORDER}` }}>
                        {['Document Type','File','Source','Uploaded','Expiry','Status',''].map((h, i) => (
                          <th key={i} style={{ padding:'10px 14px', textAlign: i === 6 ? 'right' : 'left', fontSize:11, fontWeight:600, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'.04em', whiteSpace:'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id} style={{ borderBottom:'1px solid #f3f4f6' }}>
                          <td style={{ padding:'11px 14px', fontSize:13, fontWeight:600, color:'#111827', whiteSpace:'nowrap' }}>
                            <span style={{ marginRight:8 }}>{r.icon}</span>{r.type}
                          </td>
                          <td style={{ padding:'11px 14px', fontSize:12, color:'#6b7280', maxWidth:280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={r.name}>{r.name}</td>
                          <td style={{ padding:'11px 14px', fontSize:11, color:'#6b7280', whiteSpace:'nowrap' }}>{r.source}</td>
                          <td style={{ padding:'11px 14px', fontSize:12, color:'#6b7280', whiteSpace:'nowrap' }}>{fmtDate(r.date)}</td>
                          <td style={{ padding:'11px 14px', fontSize:12, color:'#6b7280', whiteSpace:'nowrap' }}>{r.expiry ? fmtDate(r.expiry) : '\u2014'}</td>
                          <td style={{ padding:'11px 14px' }}>
                            {(() => {
                              const st = statusOf(r);
                              return (
                                <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:20, whiteSpace:'nowrap', background: STATUS_B[st] || '#f3f4f6', color: STATUS_C[st] || '#6b7280' }}>
                                  {st.charAt(0).toUpperCase() + st.slice(1)}
                                </span>
                              );
                            })()}
                          </td>
                          <td style={{ padding:'11px 14px', textAlign:'right', whiteSpace:'nowrap' }}>
                            {/* No View/Download on a file we already know is not
                                there — offering the button only to answer with
                                an error is the behaviour this replaces. */}
                            {r.stored && statusOf(r) === 'Missing' ? (
                              <span style={{ fontSize:11, color:'#b91c1c' }}>File not in storage</span>
                            ) : r.stored ? (
                              <>
                                <button
                                  onClick={async () => { const e = await openEmployeeFile(r.stored); if (e) toast.error(e); }}
                                  style={{ border:`1px solid ${BORDER}`, background:'#fff', color:P, borderRadius:6, fontSize:11, fontWeight:700, padding:'4px 12px', cursor:'pointer' }}>
                                  View
                                </button>
                                {/* A Drive link is somebody else's page, not a
                                    file we hold — there is nothing to stream. */}
                                {!isExternalUrl(r.stored) && (
                                  <button
                                    onClick={async () => { const e = await downloadEmployeeFile(r.stored); if (e) toast.error(e); }}
                                    style={{ marginLeft:6, border:`1px solid ${BORDER}`, background:'#fff', color:'#374151', borderRadius:6, fontSize:11, fontWeight:600, padding:'4px 12px', cursor:'pointer' }}>
                                    Download
                                  </button>
                                )}
                              </>
                            ) : (
                              <span style={{ fontSize:11, color:'#9ca3af' }}>No file</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}

        {/* ASSETS */}
        {activeTab === 'Assets' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <div style={{ fontSize:13, fontWeight:700, color:P }}>
                Allocated Assets
                {assetRecords.length > 0 && <span style={{ marginLeft:8, fontWeight:400, color:'#6b7280' }}>({assetRecords.length} items)</span>}
              </div>
            </div>
            {assetLoading ? (
              <div style={{ padding:24, textAlign:'center', color:'#9ca3af' }}>Loading assets…</div>
            ) : assetRecords.length === 0 ? (
              <div style={{ padding:24, textAlign:'center', color:'#9ca3af', background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12 }}>
                No assets allocated to this employee.
              </div>
            ) : (
              <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'#f5f3ff', borderBottom:`2px solid ${BORDER}` }}>
                      {['Asset','Type','Tag / Serial','Allocated On','Condition','Status'].map(h => (
                        <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:700, color:P, fontSize:12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {assetRecords.map((a, i) => {
                      const statusColor = a.status === 'returned' ? '#6b7280' : a.status === 'allocated' ? '#16a34a' : '#6d28d9';
                      return (
                        <tr key={a.id} style={{ borderBottom:`1px solid #f0ebff`, background: i%2===0?'#fff':'#faf9ff' }}>
                          <td style={{ padding:'10px 14px', fontWeight:600, color:'#1f2937' }}>
                            {a.asset_name}
                            {a.brand && <div style={{ fontSize:11, color:'#9ca3af' }}>{a.brand}{a.model ? ` · ${a.model}` : ''}</div>}
                          </td>
                          <td style={{ padding:'10px 14px', color:'#374151' }}>{a.asset_type}</td>
                          <td style={{ padding:'10px 14px', fontFamily:'monospace', fontSize:12, color:'#6b7280' }}>
                            {a.asset_tag || '—'}{a.serial_number ? ` / ${a.serial_number}` : ''}
                          </td>
                          <td style={{ padding:'10px 14px', color:'#6b7280' }}>{a.allocated_date?.slice(0,10) || '—'}</td>
                          <td style={{ padding:'10px 14px', color:'#374151' }}>{a.condition_in || '—'}</td>
                          <td style={{ padding:'10px 14px' }}>
                            <span style={{ padding:'2px 10px', borderRadius:10, fontSize:12, fontWeight:600, background:statusColor+'20', color:statusColor }}>
                              {a.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ONBOARDING CHECKLIST */}
        {activeTab === 'Onboarding' && (
          <div>
            {/* Outside the loading/empty branches so the way in to Manage
                Checklist is there even when this employee has no checklist yet
                — which is exactly when HR is most likely to want to edit the
                items the checklist will be built from. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: P }}>Onboarding Checklist</span>
              <button
                onClick={() => setManageChecklist(true)}
                style={{ padding: '7px 16px', background: '#fff', color: P, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                &#9881; Manage Checklist
              </button>
            </div>
            {onboardingLoading ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Loading onboarding checklist…</div>
            ) : onboardingDenied ? (
              <div role="status" data-testid="onboarding-denied" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
                <div style={{ fontWeight: 700, color: '#374151', marginBottom: 6 }}>You don&rsquo;t have access to this onboarding checklist</div>
                <div style={{ color: '#6b7280', fontSize: 13 }}>Onboarding checklists are visible to HR, the employee, and the employee&rsquo;s managers.</div>
              </div>
            ) : !onboardingData?.items?.length ? (
              <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
                <div style={{ fontWeight: 700, color: '#374151', marginBottom: 6 }}>No onboarding checklist yet</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>Initialize to create a checklist from default templates</div>
                <button
                  onClick={async () => {
                    try {
                      await api.post(`/onboarding/progress/${employee.id}/init`);
                      setOnboardingInit(v => !v);
                    } catch (e) { toast.error(e.response?.data?.message || 'Failed to initialize'); }
                  }}
                  style={{ padding: '9px 20px', background: P, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  Initialize Onboarding Checklist
                </button>
              </div>
            ) : (
              <div>
                {/* Progress bar */}
                <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, color: '#374151', fontSize: 14 }}>Onboarding Progress</span>
                    <span style={{ fontWeight: 800, fontSize: 18, color: P }}>{onboardingData.pct}%</span>
                  </div>
                  <div style={{ background: '#f3f4f6', borderRadius: 8, height: 10 }}>
                    <div style={{ width: `${onboardingData.pct}%`, background: `linear-gradient(90deg, ${P}, #4f46e5)`, height: '100%', borderRadius: 8, transition: 'width 0.4s ease' }} />
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{onboardingData.done} of {onboardingData.total} items completed</div>
                </div>
                {/* Items grouped by category */}
                {Object.entries(
                  onboardingData.items.reduce((acc, item) => {
                    if (!acc[item.category]) acc[item.category] = [];
                    acc[item.category].push(item);
                    return acc;
                  }, {})
                ).map(([cat, items]) => (
                  <div key={cat} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: '#374151', fontSize: 13, marginBottom: 12 }}>{cat}</div>
                    {items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < items.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                        <button
                          onClick={async () => {
                            try {
                              await api.patch(`/onboarding/progress/${employee.id}/item`, {
                                category: item.category,
                                item_label: item.item_label,
                                done: !item.done,
                              });
                              setOnboardingInit(v => !v);
                            } catch (e) {
                              // Report what the API actually said. The bare
                              // "Failed to update checklist item" hid a 500 —
                              // completed_by's bind parameter was deduced as
                              // text against an integer column — for as long as
                              // the feature had existed.
                              toast.error(e.response?.data?.message || 'Failed to update checklist item');
                            }
                          }}
                          style={{ fontSize: 20, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                          title={item.done ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {item.done ? '✅' : '⬜'}
                        </button>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, color: item.done ? '#6b7280' : '#111827', textDecoration: item.done ? 'line-through' : 'none' }}>{item.item_label}</div>
                          {item.due_date && <div style={{ fontSize: 11, color: '#9ca3af' }}>Due: {new Date(item.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })} · {item.assignee}</div>}
                        </div>
                        {item.done && item.completed_at && (
                          <span style={{ fontSize: 11, color: '#059669', whiteSpace: 'nowrap' }}>✓ {new Date(item.completed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}

                {/* Completed items whose checklist entry has since been
                    retired. The progress row survives a deactivation — this is
                    where it stays visible, so retiring an item does not erase
                    what people actually did. Not counted in the percentage
                    above: it is history, not outstanding work. */}
                {onboardingData.archived?.length > 0 && (
                  <div style={{ background: '#fafafa', border: `1px dashed ${BORDER}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: '#6b7280', fontSize: 12, marginBottom: 10 }}>
                      Completed earlier &middot; item since retired ({onboardingData.archived.length})
                    </div>
                    {onboardingData.archived.map((item, i) => (
                      <div key={item.id || i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 12.5, color: '#6b7280' }}>
                        <span style={{ color: '#059669' }}>&#10003;</span>
                        <span style={{ flex: 1 }}>{item.category} &middot; {item.item_label}</span>
                        {item.completed_at && (
                          <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                            {new Date(item.completed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* HISTORY */}
        {activeTab === 'History' && (
          <div style={{ maxWidth: 980 }}>
            <Card title="Salary Revision History">
              {salaryLoading ? (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading salary history...</div>
              ) : salaryRevisions.length === 0 ? (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                  No salary revisions on record yet.
                </div>
              ) : (
                <>
                  {/*
                    The trend chart renders ONLY when there is more than one
                    revision. It used to render unconditionally, and because the
                    bars were scaled against the largest value in the set, a
                    single revision produced one full-height purple block: a
                    "trend" drawn from one point. Almost every employee in this
                    database has exactly one assignment, so that was the normal
                    case, not the edge case.
                  */}
                  {/*
                    A line chart, always rendered, scaled to the data.

                    The bar chart this replaces was scaled against the largest
                    value in the set, so ONE revision produced one full-height
                    block: a trend drawn from a single point. Almost every
                    employee here has exactly one assignment, so that was the
                    normal case. A line handles both honestly — with one
                    revision it is a single dot with its value beside it, and
                    nothing about the drawing implies a movement that is not in
                    the data.

                    Plots `basic_salary` plus `special_allowance`, both stored
                    columns; nothing here is derived or assumed. CTC is not on
                    this record, so it is not on this axis.
                  */}
                  {(() => {
                    const chrono = salaryRevisions.slice().reverse();          // oldest -> newest
                    const pts    = chrono.map(r => ({
                      basic: Number(r.basic_salary) || 0,
                      gross: (Number(r.basic_salary) || 0) + (Number(r.special_allowance) || 0),
                      date:  r.effective_from ? r.effective_from.split('T')[0] : null,
                    }));
                    const vals = pts.map(p => p.gross);
                    const max  = Math.max(...vals);
                    const min  = Math.min(...pts.map(p => p.basic));

                    // Geometry. A viewBox keeps the chart crisp at any width and
                    // lets the whole thing be one <svg> rather than positioned divs.
                    const W = 620, H = 170, padL = 58, padR = 16, padT = 22, padB = 30;
                    const plotW = W - padL - padR, plotH = H - padT - padB;

                    // Pad the value axis so a flat or near-flat series is not a
                    // line pinned to an edge. A single point sits in the middle.
                    const span  = max - min;
                    const lo    = span === 0 ? Math.max(0, max * 0.9) : Math.max(0, min - span * 0.35);
                    const hi    = span === 0 ? max * 1.1 || 1 : max + span * 0.2;
                    const y     = v => padT + plotH - ((v - lo) / ((hi - lo) || 1)) * plotH;
                    // Inset the series from the axis so the first point's value
                    // label clears the gridline labels on the left.
                    const inset = 16;
                    const x     = i => pts.length === 1
                      ? padL + plotW / 2
                      : padL + inset + (i / (pts.length - 1)) * (plotW - inset * 2);

                    const money = v => v >= 10000000 ? `\u20B9${(v / 10000000).toFixed(2)}Cr`
                                     : v >= 100000   ? `\u20B9${(v / 100000).toFixed(2)}L`
                                     : v >= 1000     ? `\u20B9${(v / 1000).toFixed(0)}k`
                                     : `\u20B9${v}`;
                    const label = d => d
                      ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
                      : '\u2014';

                    const line = (key) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

                    const first = vals[0], last = vals[vals.length - 1];
                    const pct = pts.length > 1 && first > 0 ? ((last - first) / first) * 100 : null;

                    return (
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>
                            Salary trend
                            <span style={{ marginLeft: 10, fontWeight: 500, color: '#9ca3af' }}>
                              <span style={{ color: P }}>&#9679;</span> Basic + Allowance
                              <span style={{ marginLeft: 10, color: '#a5b4fc' }}>&#9679;</span> Basic
                            </span>
                          </span>
                          {pct != null && (
                            <span style={{ fontSize: 12, fontWeight: 700, color: pct >= 0 ? '#15803d' : '#b91c1c' }}>
                              {pct >= 0 ? '\u25B2' : '\u25BC'} {Math.abs(pct).toFixed(1)}% across {pts.length} revisions
                            </span>
                          )}
                        </div>

                        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
                          aria-label={pts.length === 1
                            ? `One salary revision, ${money(vals[0])} effective ${label(pts[0].date)}`
                            : `Salary from ${money(first)} to ${money(last)} across ${pts.length} revisions`}
                          style={{ display: 'block', maxWidth: W }}>
                          {/* value gridlines */}
                          {[hi, (hi + lo) / 2, lo].map((v, i) => (
                            <g key={i}>
                              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#f1eefe" strokeWidth="1" />
                              <text x={padL - 8} y={y(v) + 3.5} textAnchor="end" fontSize="9.5" fill="#9ca3af">{money(Math.round(v))}</text>
                            </g>
                          ))}

                          {pts.length > 1 && (
                            <>
                              <path d={line('gross')} fill="none" stroke={P} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
                              <path d={line('basic')} fill="none" stroke="#a5b4fc" strokeWidth="1.8" strokeDasharray="4 3" strokeLinejoin="round" strokeLinecap="round" />
                            </>
                          )}

                          {pts.map((pt, i) => (
                            <g key={i}>
                              <circle cx={x(i)} cy={y(pt.basic)} r="3" fill="#fff" stroke="#a5b4fc" strokeWidth="1.8" />
                              <circle cx={x(i)} cy={y(pt.gross)} r="4" fill="#fff" stroke={P} strokeWidth="2.2" />
                              <text x={x(i)} y={y(pt.gross) - 10} textAnchor="middle" fontSize="10" fontWeight="700" fill="#374151">{money(pt.gross)}</text>
                              <text x={x(i)} y={H - 10} textAnchor="middle" fontSize="9.5" fill="#6b7280">{label(pt.date)}</text>
                            </g>
                          ))}
                        </svg>

                        {pts.length === 1 && (
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
                            One revision on record, shown as a single point. A trend line appears once there is a second.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* The record itself, newest first. This is the primary view. */}
                  <div className="emp-profile-table-wrap">
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                          {[
                            ['Effective Date', 'left'], ['Salary Structure', 'left'],
                            ['Basic Salary', 'right'], ['Special Allowance', 'right'],
                            ['Loan Deduction', 'right'], ['Advance Deduction', 'right'],
                            ['Basic + Allowance', 'right'],
                          ].map(([h, align]) => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: align, fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          // The revision IN FORCE today is the newest one whose
                          // effective date has already passed — not simply the
                          // newest row. Booking next April's increment now is
                          // the normal way to use a revision history, and until
                          // that date arrives the employee is still on the old
                          // figure. Calling the future row CURRENT would say the
                          // opposite of what payroll (correctly) pays.
                          const today = new Date().toISOString().slice(0, 10);
                          const inForceIdx = salaryRevisions.findIndex(
                            x => x.effective_from && x.effective_from.slice(0, 10) <= today);
                          return salaryRevisions.map((r, i) => {
                          const money = v => v == null ? '\u2014' : `\u20B9${Number(v).toLocaleString('en-IN')}`;
                          // Only the sum of the two figures printed on this row.
                          // Deliberately NOT labelled CTC: employer PF, gratuity
                          // and the rest of a CTC are not stored on this record,
                          // so calling it one would be inventing a number.
                          const gross = (r.basic_salary == null && r.special_allowance == null)
                            ? null
                            : (Number(r.basic_salary) || 0) + (Number(r.special_allowance) || 0);
                          const isCurrent  = i === inForceIdx;
                          const isUpcoming = !!r.effective_from && r.effective_from.slice(0, 10) > today;
                          return (
                            <tr key={r.id || i} style={{ borderBottom: '1px solid #f3f4f6', background: isCurrent ? LIGHT : 'transparent' }}>
                              <td style={{ padding: '9px 10px', color: '#374151', whiteSpace: 'nowrap' }}>
                                {r.effective_from ? new Date(r.effective_from.split('T')[0] + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '\u2014'}
                                {isCurrent && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: P, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '1px 7px' }}>CURRENT</span>}
                                {isUpcoming && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, padding: '1px 7px' }}>SCHEDULED</span>}
                              </td>
                              <td style={{ padding: '9px 10px', color: '#6b7280' }}>{r.structure_name || '\u2014'}</td>
                              <td style={{ padding: '9px 10px', fontWeight: 600, color: '#111827', textAlign: 'right' }}>{money(r.basic_salary)}</td>
                              <td style={{ padding: '9px 10px', color: '#6b7280', textAlign: 'right' }}>{money(r.special_allowance)}</td>
                              <td style={{ padding: '9px 10px', color: '#6b7280', textAlign: 'right' }}>{money(r.loan_deduction)}</td>
                              <td style={{ padding: '9px 10px', color: '#6b7280', textAlign: 'right' }}>{money(r.advance_deduction)}</td>
                              <td style={{ padding: '9px 10px', fontWeight: 600, color: '#374151', textAlign: 'right' }}>{money(gross)}</td>
                            </tr>
                          );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, lineHeight: 1.6 }}>
                    {salaryRevisions.length === 1
                      ? 'One revision on record.'
                      : `${salaryRevisions.length} revisions on record, newest first.`}
                    {' '}&ldquo;Basic + Allowance&rdquo; is the sum of the two columns shown; full CTC is not stored on this record.
                  </div>
                </>
              )}
            </Card>
          </div>
        )}

        {/* EXIT DETAILS — visible only for ex-employees */}
        {activeTab === 'Exit Details' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 16 }}>

            {/* Separation summary */}
            <Card title="Separation Summary">
              <InfoRow label="Separation Type"  value={exitData?.separation_type?.replace(/_/g,' ') || employee.exit_reason || '—'} />
              <InfoRow label="Last Working Date" value={exitData?.last_working_date ? new Date(exitData.last_working_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : (employee.exit_date ? new Date(employee.exit_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')} />
              <InfoRow label="Notice Period"     value={exitData?.notice_period ? `${exitData.notice_period} days` : '—'} />
              <InfoRow label="Reason"            value={exitData?.reason || employee.exit_reason || '—'} />
              <InfoRow label="Exit Request Status" value={exitData?.status || '—'} />
              <InfoRow label="Initiated On"      value={exitData?.created_at ? new Date(exitData.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button onClick={openExitEdit} style={{
                  padding: '6px 14px', background: P, color: '#fff', border: 'none',
                  borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>
                  Edit Exit Details
                </button>
              </div>
            </Card>

            {/* F&F Settlement */}
            <Card title="Full & Final Settlement">
              <InfoRow label="F&F Status"  value={exitData?.fnf_status || 'Pending'} />
              <InfoRow label="Net Payable" value={exitData?.net_payable != null ? `₹${Number(exitData.net_payable).toLocaleString('en-IN')}` : '—'} />
              <InfoRow label="Interview Done" value={exitData?.interview_done ? 'Yes' : 'No'} />
            </Card>

            {/* Clearance checklist */}
            <Card title="Exit Clearance">
              {(() => {
                const CLEARANCE_FIELDS = [
                  ['IT Assets Returned',    'it_assets_returned'],
                  ['System Access Revoked', 'access_revoked'],
                  ['Documents Collected',   'documents_collected'],
                  ['Exit Interview Done',   'exit_interview_done'],
                  ['NOC — IT',             'noc_it'],
                  ['NOC — Admin',          'noc_admin'],
                  ['NOC — Finance',        'noc_finance'],
                  ['NOC — HR',             'noc_hr'],
                  ['NOC — Manager',        'noc_manager'],
                ];
                const data = clearanceData || {};
                const toggleClearance = async (field, currentVal) => {
                  if (clearanceSaving) return;
                  setClearanceSaving(true);
                  const updated = { ...data, [field]: !currentVal };
                  try {
                    const r = await api.put(`/exit/clearance/${employee.id}`, updated);
                    if (isMounted.current) setClearanceData(r.data);
                  } catch { toast.error('Failed to update clearance'); }
                  finally { if (isMounted.current) setClearanceSaving(false); }
                };
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                    {CLEARANCE_FIELDS.map(([label, field]) => {
                      const done = data[field];
                      return (
                        <div key={field} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${BORDER}` }}>
                          <span style={{ fontSize: 13, color: '#374151' }}>{label}</span>
                          <button
                            onClick={() => toggleClearance(field, done)}
                            disabled={clearanceSaving}
                            style={{
                              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
                              background: done ? '#dcfce7' : '#ede9fe',
                              color: done ? '#166534' : '#5b21b6',
                              border: `1px solid ${done ? '#bbf7d0' : '#ddd6fe'}`,
                              opacity: clearanceSaving ? 0.6 : 1,
                            }}
                          >
                            {done ? '✓ Done' : 'Pending'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </Card>

          </div>
        )}

        {/* BACKGROUND VERIFICATION — a SUMMARY and a way in, not a second workspace.
            Every action lives on the BGV page; this tab exists so View Employee
            answers "has their background been verified?" without HR having to go
            looking, and so the answer is one click from the record. */}
        {activeTab === 'Background Verification' && (
          <div style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card title="Background Verification">
              {bgvDenied && (
                <div style={{ padding: '14px 0', color: '#9ca3af', fontSize: 13 }}>
                  Your role cannot view background verification records.
                </div>
              )}
              {!bgvDenied && bgv === undefined && (
                <div style={{ padding: '14px 0', color: '#9ca3af', fontSize: 13 }}>Loading…</div>
              )}
              {!bgvDenied && bgv === null && (
                <div style={{ padding: '14px 0', color: '#9ca3af', fontSize: 13 }}>
                  Background verification details could not be loaded.
                </div>
              )}
              {!bgvDenied && bgv && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                    <span style={{
                      display: 'inline-block', padding: '4px 12px', borderRadius: 999,
                      fontSize: 12, fontWeight: 700,
                      background: bgvBadge(bgv.bgv_status).bg, color: bgvBadge(bgv.bgv_status).color,
                    }}>{bgv.bgv_status}</span>
                    <span style={{ fontSize: 14, color: '#374151', fontWeight: 600 }}>{bgvProgress(bgv)}</span>
                    <span style={{ fontSize: 14, color: '#374151', fontWeight: 600 }}>
                      {bgvMoney(bgv.total_cost)} spent
                    </span>
                  </div>

                  {Number(bgv.checks_discrepancy) > 0 && (
                    <div style={{ marginTop: 12, fontSize: 13, color: '#991b1b', fontWeight: 600 }}>
                      {bgv.checks_discrepancy} check(s) came back with a discrepancy.
                    </div>
                  )}
                  {/* A completed case is not a cleared case. Said out loud here
                      because this one-line summary is exactly where the two
                      would otherwise be read as the same thing. */}
                  {bgv.bgv_status === 'Completed' && Number(bgv.checks_clear) < Number(bgv.applicable_total) && (
                    <div style={{ marginTop: 12, fontSize: 13, color: '#92400e', fontWeight: 600 }}>
                      All checks are finished, but only {bgv.checks_clear} of {bgv.applicable_total} applicable
                      checks came back Clear — open the case for the results.
                    </div>
                  )}
                  {/* ⚠ Counted against APPLICABLE checks, not every check. A
                      fresher with Employment Verification recorded as Not
                      Applicable would otherwise always look short of Clear. */}
                  {Number(bgv.not_applicable) > 0 && (
                    <div style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>
                      {bgv.not_applicable} check(s) recorded as <strong>Not Applicable</strong> — on file as a
                      decision, not counted as outstanding work.
                    </div>
                  )}
                  {Number(bgv.reports_missing) > 0 && (
                    <div style={{ marginTop: 12, fontSize: 13, color: '#92400e', fontWeight: 600 }}>
                      {bgv.reports_missing} check(s) have no report attached.
                    </div>
                  )}

                  <div style={{ marginTop: 16 }}>
                    <InfoRow label="Verification agency" value={bgv.primary_agency_name} />
                    <InfoRow label="Started" value={bgvDate(bgv.initiated_on || bgv.first_request_date)} />
                    <InfoRow label="Last check completed" value={bgvDate(bgv.last_completed_date)} />
                    <InfoRow label="Unpaid verification cost" value={bgvMoney(bgv.unpaid_cost)} />
                  </div>

                  <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${BORDER}` }}>
                    <button
                      onClick={() => setPage('EmployeeBGV', { employee_id: employee.id })}
                      style={{
                        background: P, color: '#fff', border: 'none', borderRadius: 8,
                        padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {bgv.case_id ? 'Open full BGV case →' : 'Start background verification →'}
                    </button>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 10 }}>
                      Checks, reports, contact history and costs are recorded on the
                      <strong> Background Verification</strong> page. This tab is read-only.
                    </div>
                  </div>
                </>
              )}
            </Card>
          </div>
        )}

        {/* NOTES — READ ONLY.
            The employee note is entered and edited on Edit Employee, which is
            the single writer. This tab used to carry its own Save Note box, so
            HR had two places to write a note and two stores behind them
            (`employees.notes`, edited on the form, and the `hr_notes` timeline
            written from here). The second write box is gone; the timeline is
            still displayed, because rows already exist in it and an HR note is
            not something to delete to tidy a screen. */}
        {activeTab === 'Notes' && (
          <div style={{ maxWidth:760, display:'flex', flexDirection:'column', gap:16 }}>

            <Card title="Employee Note">
              {employee.notes && String(employee.notes).trim() ? (
                <div style={{ fontSize:14, color:'#374151', lineHeight:1.6, whiteSpace:'pre-wrap', marginTop:6 }}>
                  {employee.notes}
                </div>
              ) : (
                <div style={{ padding:'14px 0', color:'#9ca3af', fontSize:13 }}>
                  No note recorded for this employee.
                </div>
              )}
              <div style={{ fontSize:11, color:'#9ca3af', marginTop:12, paddingTop:10, borderTop:`1px solid ${BORDER}` }}>
                Notes are added and edited on <strong>Edit Employee &rarr; Notes</strong>. This tab is read-only.
              </div>
            </Card>

            {/* Only rendered when the older timeline actually holds something,
                so an employee with no hr_notes rows sees one note panel rather
                than two and the "which box do I type in" question never arises. */}
            {(notesLoading || notesList.length > 0) && (
              <Card title={`Earlier HR Notes${notesList.length ? ` (${notesList.length})` : ''}`}>
                {notesLoading ? (
                  <div style={{ padding:'14px 0', color:'#9ca3af', fontSize:13 }}>Loading notes...</div>
                ) : (
                  <>
                    {/* Newest first — the API orders by created_at DESC and this
                        renders in the order it receives. */}
                    {notesList.map(note => (
                      <div key={note.id} style={{ padding:'12px 0', borderBottom:`1px solid ${BORDER}` }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:12, marginBottom:5 }}>
                          <span style={{ fontSize:12, fontWeight:700, color:'#374151' }}>
                            {note.created_by_name || 'HR'}
                          </span>
                          <span style={{ fontSize:11, color:'#9ca3af', fontWeight:600, whiteSpace:'nowrap' }}>
                            {note.created_at
                              ? new Date(note.created_at).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' })
                              : '\u2014'}
                          </span>
                        </div>
                        <div style={{ fontSize:14, color:'#374151', lineHeight:1.6, whiteSpace:'pre-wrap' }}>{note.note_text}</div>
                      </div>
                    ))}
                    <div style={{ fontSize:11, color:'#9ca3af', marginTop:10 }}>
                      Historical entries. New notes go on the employee record above.
                    </div>
                  </>
                )}
              </Card>
            )}
          </div>
        )}

      </div>
    </PageShell>
  );
}

/* Inject responsive tab/content overrides once */
if (typeof document !== 'undefined' && !document.getElementById('emp-profile-style')) {
  const _s = document.createElement('style');
  _s.id = 'emp-profile-style';
  _s.textContent = `
    @media (max-width: 768px) {
      .emp-profile-tabs {
        padding-left: 0 !important;
        padding-right: 0 !important;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .emp-profile-tabs::-webkit-scrollbar { display: none; }
      .emp-profile-content { padding: 16px 12px 32px !important; }
      .emp-profile-header-inner { flex-direction: column !important; align-items: flex-start !important; }
      .emp-profile-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .emp-profile-table-wrap table { min-width: 480px; }
    }
    @media (max-width: 480px) {
      .emp-profile-tabs button { padding: 10px 12px !important; font-size: 12px !important; }
    }
  `;
  document.head.appendChild(_s);
}
