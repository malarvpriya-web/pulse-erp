import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

// Moved out of EmployeeProfile.jsx (owner 18 Nov 26): onboarding lives in one
// place, Recruitment → Offer & Onboarding → Onboarding, and the checklist is
// managed from there. The Employee Profile no longer has an Onboarding tab.
const P      = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

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
export default function ManageChecklistModal({ onClose, onChanged }) {
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
