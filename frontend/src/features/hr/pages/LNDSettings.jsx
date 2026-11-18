// frontend/src/features/hr/pages/LNDSettings.jsx
// L&D Setup (2026-11-18): Settings and Trainers as tabs of one page. Every
// setting here is read by the system — the page says where. Save used to fail.
import { lazy, useEffect, useState } from 'react';
import { SlidersHorizontal, Users } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { TabHub } from '@/components/pulse-ui';
import { Empty, errText, resetLndOptions } from '@/features/hr/learning/lndUi';

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="lnd-inline full" style={{ justifyContent: 'space-between', borderBottom: '1px solid #f3f0ff', paddingBottom: 8 }}>
      <span><strong style={{ fontSize: 13 }}>{label}</strong>{hint && <span className="hint" style={{ display: 'block' }}>{hint}</span>}</span>
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
    </label>
  );
}

export function SettingsPanel() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [cat, setCat] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/lnd-settings').then(r => setS(r.data)).catch(e => setErr(errText(e))); }, []);
  const set = (k, v) => setS(p => ({ ...p, [k]: v }));
  const num = (k) => (e) => set(k, e.target.value === '' ? '' : Number(e.target.value));
  const save = async () => {
    setBusy(true); setErr('');
    try { setS((await api.put('/lnd-settings', s)).data); resetLndOptions(); toast.success('Settings saved'); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  if (!s) return <div className="lnd">{err ? <div className="lnd-error">{err}</div> : <Empty>Loading…</Empty>}</div>;
  const addCat = () => {
    const c = cat.trim(); if (!c) return;
    if (s.training_categories.some(x => x.toLowerCase() === c.toLowerCase())) { toast.error('That category already exists'); return; }
    set('training_categories', [...s.training_categories, c]); setCat('');
  };
  return (
    <div className="lnd">
      {err && <div className="lnd-error">{err}</div>}
      <div className="lnd-grid lnd-grid-2">
        <div className="lnd-card">
          <h4 className="lnd-card-title"><span>Training categories</span></h4>
          <p className="lnd-muted" style={{ marginTop: 0 }}>Offered on every training and certification, and used by the Category filter everywhere.</p>
          <div className="lnd-actions" style={{ marginBottom: 10 }}>
            {s.training_categories.map(c => (
              <span key={c} className="lnd-pill is-brand">{c} <button type="button" className="lnd-link" aria-label={`Remove ${c}`} onClick={() => set('training_categories', s.training_categories.filter(x => x !== c))}>×</button></span>
            ))}
          </div>
          <div className="lnd-form"><label className="full">Add category
            <span style={{ display: 'flex', gap: 8 }}><input value={cat} onChange={e => setCat(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } }} />
              <button type="button" className="pulse-btn-secondary" onClick={addCat}>Add</button></span></label></div>
          <p className="lnd-muted">Skill categories are kept in Master Setup → Skill Categories.</p>
        </div>
        <div className="lnd-card">
          <h4 className="lnd-card-title"><span>Tests & repeat trainings</span></h4>
          <div className="lnd-form">
            <label>Default pass mark %<input type="number" min="1" max="100" value={s.default_pass_score} onChange={num('default_pass_score')} /><span className="hint">New tests start with this.</span></label>
            <label>Default attempts<input type="number" min="1" max="20" value={s.default_max_attempts} onChange={num('default_max_attempts')} /></label>
            <label className="full">Mandatory trainings repeat every (months)<input type="number" min="1" max="60" value={s.default_refresher_months} onChange={num('default_refresher_months')} />
              <span className="hint">Default for a new mandatory training — e.g. 3 or 6 for drills. Each training can override it.</span></label>
          </div>
        </div>
        <div className="lnd-card">
          <h4 className="lnd-card-title"><span>Enrolment & feedback</span></h4>
          <div className="lnd-form">
            <Toggle label="Employees can enrol themselves" hint="Self Service → My Learning → Open trainings" checked={s.allow_self_enrollment} onChange={v => set('allow_self_enrollment', v)} />
            <label>Open trainings per person<input type="number" min="1" max="50" value={s.max_concurrent_enrollments} onChange={num('max_concurrent_enrollments')} /><span className="hint">Limit for self-enrolment.</span></label>
            <Toggle label="Feedback needs a written comment" checked={s.feedback_required} onChange={v => set('feedback_required', v)} />
            {s.feedback_required && <label>Minimum characters<input type="number" min="0" max="2000" value={s.min_feedback_chars} onChange={num('min_feedback_chars')} /></label>}
          </div>
        </div>
        <div className="lnd-card">
          <h4 className="lnd-card-title"><span>Reminders</span></h4>
          <p className="lnd-muted" style={{ marginTop: 0 }}>Sent every morning at 09:20 as notifications in Pulse.</p>
          <div className="lnd-form">
            <label>Training reminder (days before)<input type="number" min="0" max="60" value={s.reminder_days_before} onChange={num('reminder_days_before')} /><span className="hint">0 = off</span></label>
            <label>Certificate expiry warning (days before)<input type="number" min="1" max="365" value={s.cert_expiry_reminder_days} onChange={num('cert_expiry_reminder_days')} /><span className="hint">Also 7 days and 1 day before.</span></label>
            <Toggle label="Also notify the reporting manager" hint="Expiring certificates and overdue learning paths of their team" checked={s.enable_manager_notifications} onChange={v => set('enable_manager_notifications', v)} />
            <Toggle label="Also send e-mail" hint="Only once an SMTP server is configured under Integrations" checked={s.enable_email_notifications} onChange={v => set('enable_email_notifications', v)} />
          </div>
        </div>
      </div>
      <div className="lnd-actions" style={{ marginTop: 14 }}><button type="button" className="pulse-btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button></div>
    </div>
  );
}

const Trainers = lazy(() => import('./TrainerManagement'));
const SettingsTab = (props) => <SettingsPanel {...props} />;

export const TABS = [
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal, page: 'LNDSettings', Component: SettingsTab },
  { id: 'trainers', label: 'Trainers', icon: Users, page: 'TrainerManagement', Component: Trainers },
];

export default function LNDSettings({ setPage }) {
  return <TabHub icon={SlidersHorizontal} eyebrow="Learning Center" title="L&D Setup" subtitle="Trainers, categories, defaults, enrolment rules and reminders" tabs={TABS} setPage={setPage} />;
}
