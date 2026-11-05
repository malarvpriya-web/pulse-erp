import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Shuffle, Archive, CalendarClock, Check, AlertTriangle } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { SUITABILITY_LABELS } from '../constants';
import './candidate-actions.css';

/**
 * The three decisions §2 exists to make possible, as dialogs.
 *
 * All three are reachable from the quick-view drawer, the candidate list's row
 * menu, the bulk bar and the full profile. One implementation each, in this file,
 * because the alternative — the same dialog written four times — is how the module
 * ended up with four copies of a stage enum that had drifted apart.
 *
 * Each one is deliberately SHORT. §42: "do not force recruiters to enter excessive
 * text." Every field beyond the one that carries the decision is optional, and
 * each dialog is one screen with no scrolling at 768px height.
 */

function Modal({ title, subtitle, icon: Icon, tone = 'route', onClose, children, footer }) {
  // Escape closes. Bound while open only, so it cannot swallow Escape from a
  // dialog that opened on top of this one.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="cad-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="cad" role="dialog" aria-modal="true" aria-label={title}>
        <header className={`cad-head cad-head--${tone}`}>
          <div className="cad-head-text">
            {Icon && <Icon size={16} className="cad-head-icon" />}
            <div>
              <h2 className="cad-title">{title}</h2>
              {subtitle && <p className="cad-sub">{subtitle}</p>}
            </div>
          </div>
          <button type="button" className="cad-x" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </header>
        <div className="cad-body">{children}</div>
        <footer className="cad-foot">{footer}</footer>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §16 — Consider for Other Roles
 * ═══════════════════════════════════════════════════════════════════════════
 * The brief calls this "a CRITICAL Manifest feature", and its instruction is
 * explicit: "Do NOT create a duplicate candidate. Create a candidate-to-role
 * suitability record."
 *
 * So this dialog writes to candidate_role_suitability, not to
 * candidate_applications — and the difference matters in practice rather than
 * only in the schema. An application needs an opening to exist. A suitability
 * says "this person suits Testing" and is recordable when Manifest has no Testing
 * vacancy posted, which is the normal case and precisely §16's scenario. When a
 * Testing role does open, the suitability converts into a real application in one
 * click (see the profile's "Put forward" action).
 *
 * `departments` comes from the company's own openings, requisitions and talent
 * pools rather than being hardcoded, so it reflects what Manifest actually has.
 */
export function ConsiderOtherRolesDialog({ candidate, departments = [], existing = [], onClose, onSaved }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);

  const already = useMemo(
    () => new Map(existing.map(e => [String(e.department).toLowerCase(), e])),
    [existing]
  );

  const [picked, setPicked] = useState(() => new Set());
  const [strength, setStrength] = useState({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // The candidate's CURRENT department is offered too, per §16 ("show current
  // department and all active departments") — a recruiter may well want to record
  // "strong fit for Electrical, just not this particular opening".
  const options = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const d of departments) {
      const key = String(d).toLowerCase();
      if (!d || seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }, [departments]);

  const toggle = (dept) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(dept)) next.delete(dept); else next.add(dept);
      return next;
    });
  };

  const save = async () => {
    if (!picked.size) return toast('Pick at least one department.', 'error');
    setSaving(true);
    try {
      const res = await api.post(`/recruitment/candidates/${candidate.id}/suitability`, {
        departments: [...picked].map(department => ({
          department,
          suitability: strength[department] || 'potential',
        })),
        reason: reason.trim() || null,
      });
      toast(res?.data?.message || 'Recorded');
      onSaved?.(res?.data);
      onClose?.();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Consider ${candidate?.full_name} for other roles`}
      subtitle="No duplicate candidate record is created. Their current application keeps its own stage and history."
      icon={Shuffle}
      tone="route"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cad-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="cad-btn cad-btn--primary" onClick={save} disabled={saving || !picked.size}>
            {saving ? 'Saving…' : `Record ${picked.size || ''} department${picked.size === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className="cad-empty">
          No departments found. Departments are taken from this company&rsquo;s job openings,
          requisitions and talent pools — create one of those first.
        </p>
      ) : (
        <div className="cad-dept-grid">
          {options.map((dept) => {
            const prior = already.get(String(dept).toLowerCase());
            const on = picked.has(dept);
            return (
              <div key={dept} className={`cad-dept${on ? ' is-on' : ''}`}>
                <label className="cad-dept-label" htmlFor={`cad-dept-${dept}`}>
                  <input
                    id={`cad-dept-${dept}`}
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(dept)}
                  />
                  <span className="cad-dept-name">{dept}</span>
                  {/* A department already recorded is shown with its existing
                      verdict rather than hidden. Re-picking it REPLACES that
                      opinion (the API upserts), and the recruiter needs to know
                      that is what they are doing. */}
                  {prior && (
                    <span className="cad-dept-prior">
                      already {SUITABILITY_LABELS[prior.suitability]?.toLowerCase()}
                    </span>
                  )}
                </label>
                {on && (
                  <select
                    className="cad-select cad-select--sm"
                    value={strength[dept] || 'potential'}
                    onChange={(e) => setStrength(s => ({ ...s, [dept]: e.target.value }))}
                    aria-label={`How strong a fit for ${dept}`}
                  >
                    <option value="strong">Strong fit</option>
                    <option value="potential">Potential</option>
                    <option value="not_suitable">Not suitable</option>
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}

      <label className="cad-label" htmlFor="cad-reason">
        Why these roles? <span className="cad-optional">optional, but this is what a colleague reads in eight months</span>
      </label>
      <textarea
        id="cad-reason"
        className="cad-textarea"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Strong electrical fundamentals. Limited product design experience. Better suited to testing/service."
      />
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §17 — Add to Talent Bank
 * ═══════════════════════════════════════════════════════════════════════════
 * Pools are grouped by their category so the twenty-three standard ones are
 * scannable rather than a flat list of twenty-three checkboxes. A candidate can
 * belong to several, which §17 asks for explicitly.
 */
/**
 * `onSubmit` lets the bulk path reuse this dialog without reusing its endpoint.
 *
 * The single-candidate path posts to /candidates/:id/talent-bank. The bulk path
 * must go through /candidates/bulk-action instead, so that N candidates are one
 * transaction and one audit entry each rather than N requests that can
 * half-succeed — and a half-applied bulk action is the worst outcome, because the
 * recruiter has no way to tell which half went through. Overriding the submit
 * rather than copying 120 lines of pool-picker keeps one implementation of the
 * picker with two callers.
 */
export function TalentBankDialog({ candidate, pools = [], onClose, onSaved, onSubmit = null, title, subtitle }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);

  const [picked, setPicked] = useState(() => new Set());
  const [tags, setTags] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const p of pools) {
      const key = p.category || 'other';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    // A stable, meaningful order rather than whatever the API happened to return.
    const ORDER = ['engineering', 'product', 'operations', 'commercial', 'corporate', 'pipeline', 'other'];
    return [...map.entries()].sort((a, b) => {
      const ia = ORDER.indexOf(a[0]); const ib = ORDER.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [pools]);

  const CATEGORY_LABELS = {
    engineering: 'Engineering', product: 'Product / Technology', operations: 'Operations',
    commercial: 'Commercial', corporate: 'Corporate', pipeline: 'Pipeline', other: 'Other',
  };

  const save = async () => {
    if (!picked.size) return toast('Pick at least one Talent Bank category.', 'error');
    const payload = {
      pool_ids: [...picked],
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      reason: reason.trim() || null,
    };
    setSaving(true);
    try {
      if (onSubmit) {
        await onSubmit(payload);
      } else {
        const res = await api.post(`/recruitment/candidates/${candidate.id}/talent-bank`, payload);
        toast(res?.data?.message || 'Kept in the Talent Bank');
        onSaved?.(res?.data);
      }
      onClose?.();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={title || `Keep ${candidate?.full_name} in the Talent Bank`}
      subtitle={subtitle || 'They stay searchable for every future opening in the categories you choose. Nothing is deleted.'}
      icon={Archive}
      tone="keep"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cad-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="cad-btn cad-btn--keep" onClick={save} disabled={saving || !picked.size}>
            {saving ? 'Saving…' : 'Add to Talent Bank'}
          </button>
        </>
      }
    >
      {pools.length === 0 ? (
        <p className="cad-empty">No talent pools found for this company.</p>
      ) : grouped.map(([category, list]) => (
        <div key={category} className="cad-pool-group">
          <h4 className="cad-pool-cat">{CATEGORY_LABELS[category] || category}</h4>
          <div className="cad-pool-chips">
            {list.map(p => {
              const on = picked.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`cad-pool-chip${on ? ' is-on' : ''}`}
                  onClick={() => setPicked(prev => {
                    const next = new Set(prev);
                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                    return next;
                  })}
                  aria-pressed={on}
                >
                  {on && <Check size={11} />}
                  {p.pool_name}
                  {p.member_count > 0 && <span className="cad-pool-count">{p.member_count}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <label className="cad-label" htmlFor="cad-tags">
        Tags <span className="cad-optional">comma separated — e.g. AHF, STATCOM, HV</span>
      </label>
      <input
        id="cad-tags"
        className="cad-input"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="AHF, STATCOM"
      />

      <label className="cad-label" htmlFor="cad-bank-reason">
        Why keep them? <span className="cad-optional">optional</span>
      </label>
      <textarea
        id="cad-bank-reason"
        className="cad-textarea"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Good fundamentals, no opening right now. Revisit when Testing expands."
      />
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §18 — Future Opportunity
 * ═══════════════════════════════════════════════════════════════════════════
 * The date is the only required field, and it is required for a reason: §18 asks
 * the system to "create a reminder/task for the recruiter", and a Future
 * Opportunity with no date is a label nobody is ever reminded about. The nightly
 * job reads exactly this column.
 */
const REASONS = [
  { value: 'not_ready_to_relocate', label: 'Cannot relocate right now' },
  { value: 'notice_period_long',    label: 'Notice period too long' },
  { value: 'pursuing_course',       label: 'Currently pursuing a course' },
  { value: 'wants_different_role',  label: 'Wants a different role' },
  { value: 'experience_later',      label: 'Experience will suit us later' },
  { value: 'no_opening',            label: 'No suitable opening right now' },
  { value: 'other',                 label: 'Other' },
];

export function FutureOpportunityDialog({ candidate, departments = [], onClose, onSaved }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);

  // Defaults to six months out — the common case for "check back later", and a
  // sensible starting point beats an empty date box the recruiter has to think
  // about. Composed from UTC parts rather than via toISOString() on a local date,
  // because toISOString() shifts an IST date back a day near midnight.
  const defaultDate = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 6);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }, []);

  const [on, setOn] = useState(defaultDate);
  const [reason, setReason] = useState('no_opening');
  const [note, setNote] = useState('');
  const [role, setRole] = useState('');
  const [dept, setDept] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);

  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const save = async () => {
    if (!on) return toast('Pick a date to come back to them.', 'error');
    if (on < today) return toast('Pick a date in the future.', 'error');
    setSaving(true);
    try {
      const res = await api.post(`/recruitment/candidates/${candidate.id}/recontact`, {
        recontact_on: on,
        reason,
        reason_note: note.trim() || null,
        potential_role: role.trim() || null,
        department: dept || null,
        preferred_location: location.trim() || null,
      });
      toast(res?.data?.message || 'Saved as a future opportunity');
      onSaved?.(res?.data);
      onClose?.();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${candidate?.full_name} — future opportunity`}
      subtitle="You will be reminded on the date you pick. The candidate stays in the system with all their history."
      icon={CalendarClock}
      tone="keep"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cad-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="cad-btn cad-btn--keep" onClick={save} disabled={saving || !on}>
            {saving ? 'Saving…' : 'Save and remind me'}
          </button>
        </>
      }
    >
      <div className="cad-grid2">
        <div>
          <label className="cad-label" htmlFor="cad-fo-date">Recontact on <span className="cad-req">required</span></label>
          <input
            id="cad-fo-date" type="date" className="cad-input"
            value={on} min={today} onChange={(e) => setOn(e.target.value)}
          />
        </div>
        <div>
          <label className="cad-label" htmlFor="cad-fo-reason">Reason</label>
          <select id="cad-fo-reason" className="cad-select" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div>
          <label className="cad-label" htmlFor="cad-fo-role">Potential role <span className="cad-optional">optional</span></label>
          <input
            id="cad-fo-role" className="cad-input" value={role}
            onChange={(e) => setRole(e.target.value)} placeholder="Power Electronics Engineer"
          />
        </div>
        <div>
          <label className="cad-label" htmlFor="cad-fo-dept">Department <span className="cad-optional">optional</span></label>
          <select id="cad-fo-dept" className="cad-select" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">—</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>

      <label className="cad-label" htmlFor="cad-fo-loc">
        Preferred location <span className="cad-optional">only what the candidate volunteered</span>
      </label>
      <input
        id="cad-fo-loc" className="cad-input" value={location}
        onChange={(e) => setLocation(e.target.value)} placeholder="Madurai"
      />

      <label className="cad-label" htmlFor="cad-fo-note">Note <span className="cad-optional">optional</span></label>
      <textarea
        id="cad-fo-note" className="cad-textarea" rows={2} value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Keen on Manifest but finishing an M.Tech. Asked us to call in March."
      />
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §22 — bulk confirmation
 * ═══════════════════════════════════════════════════════════════════════════
 * "Bulk actions must require confirmation for destructive operations." The API
 * refuses a destructive bulk action without an explicit `confirm` flag, so this
 * dialog is not the control — it is how the recruiter supplies the flag. Making
 * the API the enforcement point means a mis-wired button cannot reject forty
 * candidates by accident.
 */
export function BulkConfirmDialog({ count, actionLabel, destructive, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={destructive ? 'Confirm this change' : 'Apply to selected candidates'}
      icon={destructive ? AlertTriangle : Check}
      tone={destructive ? 'stop' : 'route'}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="cad-btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={`cad-btn ${destructive ? 'cad-btn--stop' : 'cad-btn--primary'}`}
            disabled={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
          >
            {busy ? 'Applying…' : `Yes, apply to ${count}`}
          </button>
        </>
      }
    >
      <p className="cad-confirm">
        <strong>{actionLabel}</strong> will be applied to <strong>{count}</strong>{' '}
        candidate{count === 1 ? '' : 's'}.
      </p>
      {destructive && (
        <p className="cad-warn">
          This is a negative outcome for every one of them. Their records are kept — nothing is
          deleted — but consider whether the Talent Bank or a Future Opportunity fits some of
          them better.
        </p>
      )}
    </Modal>
  );
}
