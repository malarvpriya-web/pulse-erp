// Edit Exit Details: a records correction for someone who has ALREADY left
// (PATCH /employees/ex/:id/exit-details, which refuses a current employee with
// USE_EXIT_MANAGEMENT: their exit is edited in Exit Management instead).
// One dialog for Ex-Employees and Employee Profile → Exit Details; each page had
// its own copy until 2026-11-17.
import { useState } from 'react';
import api from '@/services/api/client';
import { SEPARATION_OPTIONS } from '../separationTypes';

const BORDER = '#e5e7eb';
const inp = { padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' };
const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 };
const day = (v) => (v ? String(v).slice(0, 10) : '');

/**
 * employee  { id, first_name, last_name, office_id }
 * initial   { separation_type, last_working_date, exit_reason }
 */
export default function EditExitDetailsModal({ employee, initial = {}, onClose, onSaved }) {
  const known = SEPARATION_OPTIONS.some(o => o.value === initial.separation_type);
  const [form, setForm] = useState({
    separation_type: known ? initial.separation_type : '',
    last_working_date: day(initial.last_working_date),
    exit_reason: initial.exit_reason || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setSaving(true); setErr('');
    try {
      await api.patch(`/employees/ex/${employee.id}/exit-details`, {
        separation_type: form.separation_type || null,
        last_working_date: form.last_working_date || null,
        exit_date: form.last_working_date || null,
        exit_reason: form.exit_reason.trim() || null,
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="exit-edit-title"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 440, maxWidth: '100%', padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 id="exit-edit-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Edit Exit Details</h3>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
          {employee.first_name} {employee.last_name} · {employee.office_id}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label htmlFor="exit-edit-type" style={lbl}>Separation Type</label>
            <select id="exit-edit-type" value={form.separation_type} onChange={e => setForm(f => ({ ...f, separation_type: e.target.value }))} style={inp}>
              <option value="">— Not specified —</option>
              {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="exit-edit-lwd" style={lbl}>Last Working Date</label>
            <input id="exit-edit-lwd" type="date" value={form.last_working_date}
              onChange={e => setForm(f => ({ ...f, last_working_date: e.target.value }))} style={inp} />
          </div>
          <div>
            <label htmlFor="exit-edit-reason" style={lbl}>Exit Reason / Details</label>
            <textarea id="exit-edit-reason" rows={3} value={form.exit_reason}
              onChange={e => setForm(f => ({ ...f, exit_reason: e.target.value }))}
              placeholder="Reason for leaving…" style={{ ...inp, resize: 'vertical' }} />
          </div>
        </div>
        {err && <p role="alert" style={{ margin: '12px 0 0', color: '#b91c1c', fontSize: 12 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="pulse-btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
