// frontend/src/features/hr/utils/successionUi.jsx
//
// One copy of what every Succession Center tab used to define for itself:
// the readiness / risk vocabularies and their colours (five files, with labels
// that disagreed: "1–2 Years" on one tab, "1-2 Yrs" on the next), the small
// badges, the flash message, the spinner, the inline style tokens, the
// employee picker list and the mentor form (written twice in Development Plans).
import React, { useCallback, useEffect, useState } from 'react';
import api from '@/services/api/client';

/* ── Vocabularies (the backend and its CHECK constraints hold the same lists) ── */
export const READY_LABELS = {
  'ready-now': 'Ready Now',
  '1-2-years': '1–2 Years',
  '3-5-years': '3–5 Years',
  'not_ready': 'Not Ready',
};
export const READY_COLORS = {
  'ready-now': '#16a34a', '1-2-years': '#6d28d9', '3-5-years': '#6b7280', 'not_ready': '#ef4444',
};
export const RISK_COLORS = { high: '#dc2626', medium: '#6d28d9', low: '#16a34a' };
export const UNRATED_LABEL = 'Not rated';

/* ── Style tokens ── */
export const INP = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px',
  border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, background: '#fff',
};
export const LBL = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };
export const BTN = (variant = 'primary', small = false) => ({
  border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
  fontSize: small ? 12 : 13, padding: small ? '4px 10px' : '8px 18px',
  background: { primary: '#6B3FDB', danger: '#ef4444', success: '#16a34a', ghost: 'none', outline: 'none', 'danger-outline': 'none' }[variant] ?? '#e9e4ff',
  color: { primary: '#fff', danger: '#fff', success: '#fff', ghost: '#6b7280', outline: '#6B3FDB', 'danger-outline': '#ef4444' }[variant] ?? '#6B3FDB',
  ...(variant === 'outline' ? { border: '1px solid #6B3FDB' } : {}),
  ...(variant === 'danger-outline' ? { border: '1px solid #ef4444' } : {}),
});

/* ── Small pieces ── */
export function Chip({ color, children, title }) {
  return (
    <span title={title} style={{ padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                 background: color + '20', color, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}
export function RiskBadge({ level }) {
  const c = RISK_COLORS[level] ?? '#6b7280';
  const label = level ? level.charAt(0).toUpperCase() + level.slice(1) : '—';
  return <Chip color={c}>{label} Risk</Chip>;
}
/** Readiness from the 9-box rating. Anything outside the vocabulary = Not rated. */
export function ReadyBadge({ level }) {
  const known = READY_LABELS[level];
  return (
    <Chip color={READY_COLORS[level] ?? '#9ca3af'}
          title={known ? 'From the 9-box rating' : 'No 9-box rating (or an unrecognised value): rate this person on the 9-Box Grid'}>
      {known ?? UNRATED_LABEL}
    </Chip>
  );
}
/** "Left" / "Serving notice" marker; nothing for someone still employed. */
export function PhaseBadge({ phase }) {
  if (phase === 'left') return <Chip color="#dc2626" title="Has left the company: not counted. Replace or remove.">Left</Chip>;
  if (phase === 'notice') return <Chip color="#b45309" title="Serving notice: still counted, plan a replacement">Serving notice</Chip>;
  return null;
}

export function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: 48 }} role="status" aria-label="Loading">
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'inline-block', width: 36, height: 36, border: '3px solid #e9e4ff',
                    borderTopColor: '#6B3FDB', borderRadius: '50%', animation: '_spin .75s linear infinite' }} />
    </div>
  );
}

export function Flash({ msg }) {
  if (!msg?.text) return null;
  const err = msg.type === 'error';
  return (
    <div role={err ? 'alert' : 'status'}
         style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14,
                  background: err ? '#fef2f2' : '#f0fdf4', color: err ? '#dc2626' : '#16a34a',
                  border: `1px solid ${err ? '#fecaca' : '#bbf7d0'}` }}>
      {msg.text}
    </div>
  );
}
/** A section that could not load says so, rather than looking empty. */
export function LoadError({ text, onRetry }) {
  if (!text) return null;
  return (
    <div role="alert" style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontSize: 13,
                               background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca',
                               display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
      <span>{text}</span>
      {onRetry && <button type="button" onClick={onRetry} style={BTN('danger-outline', true)}>Retry</button>}
    </div>
  );
}

export function useFlash() {
  const [msg, setMsg] = useState({ text: '', type: '' });
  useEffect(() => {
    if (!msg.text) return undefined;
    const t = setTimeout(() => setMsg({ text: '', type: '' }), msg.type === 'error' ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const flash = useCallback((text, type = 'success') => setMsg({ text, type }), []);
  return [msg, flash];
}
export const errText = (err, fallback) => err?.response?.data?.message || err?.response?.data?.error || fallback;

/**
 * Current employees for the pickers: active, probation and notice (someone
 * serving notice is still employed). People who have left are never offered.
 */
export function useCurrentEmployees() {
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.get('/employees', { params: { status: 'active,probation,notice' } })
      .then(r => { if (live) setEmployees(Array.isArray(r.data) ? r.data : (r.data?.data || [])); })
      .catch(err => { if (live) setError(errText(err, 'Could not load the employee list')); });
    return () => { live = false; };
  }, []);
  return [employees, error];
}
export const empLabel = (e) => `${e.name}${e.designation ? ` — ${e.designation}` : ''}`;

/* ── Mentor form (used in a plan and on the Mentoring tab) ── */
export const MENTOR_DEFAULT = {
  mentee_employee_id: '', mentor_employee_id: '', focus_area: '', start_date: '', end_date: '', notes: '',
};
/**
 * `fixedMentee` locks the mentee (a plan's employee). `onSubmit(form)` returns
 * a promise; the form stays open with its values when it rejects.
 */
export function MentorForm({ employees, initial, fixedMentee, saving, onSubmit, onCancel, title = 'New Mentoring Assignment' }) {
  const [form, setForm] = useState({ ...MENTOR_DEFAULT, ...initial });
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const mentee = employees.find(e => e.id === Number(form.mentee_employee_id));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}
      style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
      <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>{title}</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10 }}>
        <div>
          <label style={LBL} htmlFor="mf-mentee">Mentee *</label>
          {fixedMentee ? (
            <div style={{ ...INP, background: '#f9fafb', fontWeight: 600 }}>{mentee?.name || fixedMentee}</div>
          ) : (
            <select id="mf-mentee" required value={form.mentee_employee_id} onChange={set('mentee_employee_id')} style={INP}>
              <option value="">— Select mentee —</option>
              {employees.map(emp => <option key={emp.id} value={emp.id}>{empLabel(emp)}</option>)}
            </select>
          )}
        </div>
        <div>
          <label style={LBL} htmlFor="mf-mentor">Mentor *</label>
          <select id="mf-mentor" required value={form.mentor_employee_id} onChange={set('mentor_employee_id')} style={INP}>
            <option value="">— Select mentor —</option>
            {employees.filter(e => e.id !== Number(form.mentee_employee_id)).map(emp => (
              <option key={emp.id} value={emp.id}>{empLabel(emp)}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={LBL} htmlFor="mf-focus">Focus Area</label>
          <input id="mf-focus" value={form.focus_area} onChange={set('focus_area')} maxLength={200}
                 placeholder="e.g. Strategic Leadership" style={INP} />
        </div>
        <div>
          <label style={LBL} htmlFor="mf-start">Start Date</label>
          <input id="mf-start" type="date" value={form.start_date} onChange={set('start_date')} style={INP} />
        </div>
        <div>
          <label style={LBL} htmlFor="mf-end">End Date</label>
          <input id="mf-end" type="date" value={form.end_date} min={form.start_date || undefined} onChange={set('end_date')} style={INP} />
        </div>
        <div style={{ gridColumn: '1/-1' }}>
          <label style={LBL} htmlFor="mf-notes">Notes</label>
          <input id="mf-notes" value={form.notes} onChange={set('notes')} maxLength={2000}
                 placeholder="Cadence, expectations…" style={INP} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="submit" disabled={saving} style={BTN('primary', true)}>{saving ? 'Saving...' : 'Assign Mentor'}</button>
        <button type="button" onClick={onCancel} style={BTN('ghost', true)}>Cancel</button>
      </div>
    </form>
  );
}

/** Payload for POST /succession/mentoring from the form. */
export const mentorPayload = (form, extra = {}) => ({
  mentee_employee_id: Number(form.mentee_employee_id),
  mentor_employee_id: Number(form.mentor_employee_id),
  focus_area: form.focus_area || null,
  start_date: form.start_date || null,
  end_date:   form.end_date || null,
  notes:      form.notes || null,
  ...extra,
});
