// Attendance → Configuration → Settings (§278, owner 2026-11-18).
//
// One page, one save, and every field on it is read by the attendance engine:
//   work week + hours   → weekend / working-day checks, full day, half day,
//                         default start/end when an employee has no shift
//   late arrival        → grace minutes and the in-app clock-in window
//   overtime / comp off → switches (OFF until the owner configures them) and
//                         the OT multipliers / caps
//   regularization      → monthly limit per employee, HR step after manager
//   auto check-out      → the nightly job
// Removed (nothing read them): attendance mode, geo / report / work-centre
// JSON settings, face-recognition settings, the separate Policies tab that
// repeated grace + OT here, and the approval-matrix editor. Punch-machine sync
// settings are on Attendance → Punch Machines.
import { useEffect, useState } from 'react';
import { Save, RefreshCw, CalendarDays, Clock, Zap, Gift, FileEdit, LogOut } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const label = (d) => d.charAt(0).toUpperCase() + d.slice(1, 3);
const CARD = { background: '#fff', border: '1px solid #ece9f8', borderRadius: 12, padding: 20, marginBottom: 16 };
const INPUT = { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, width: 120, boxSizing: 'border-box' };
const errText = (e) => e?.response?.data?.message || e?.response?.data?.error || 'Could not save settings';

function Section({ icon: Icon, title, hint, children }) {
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: hint ? 4 : 14 }}>
        <Icon size={16} color="#6B3FDB" />
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1f2937' }}>{title}</h3>
      </div>
      {hint && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>{hint}</div>}
      {children}
    </div>
  );
}

function Row({ label: l, desc, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderTop: '1px solid #f5f3ff', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 220, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{l}</div>
        {desc && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{desc}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled, id }) {
  return (
    <label htmlFor={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13 }}>
      <input id={id} type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16 }} />
      {checked ? 'On' : 'Off'}
    </label>
  );
}

export default function GeneralSettings({ embedded }) {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('attendance', 'edit');
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/attendance/general-settings');
      setS(data); setSaved(data); setMsg(null);
    } catch (e) { setMsg({ type: 'error', text: errText(e) }); }
  };
  useEffect(() => { load(); }, []);

  const set = (k, v) => setS((p) => ({ ...p, [k]: v }));
  const num = (k) => (e) => set(k, e.target.value === '' ? '' : Number(e.target.value));
  const dirty = s && saved && JSON.stringify(s) !== JSON.stringify(saved);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const { data } = await api.put('/attendance/general-settings', s);
      setS(data); setSaved(data);
      setMsg({ type: 'ok', text: 'Settings saved' });
    } catch (e) { setMsg({ type: 'error', text: errText(e) }); }
    finally { setBusy(false); }
  };

  if (!s) {
    return <div style={{ padding: 32, color: '#9ca3af' }}>{msg?.text || 'Loading settings…'}</div>;
  }

  const onSite = Number(s.full_day_hours || 0) + Number(s.break_duration || 0) / 60;
  const onSiteText = `${Math.floor(onSite)} h ${String(Math.round((onSite % 1) * 60)).padStart(2, '0')} min`;
  const dis = !canEdit;

  const body = (
    <div>
      {msg && (
        <div role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a',
          border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>
      )}

      <Section icon={CalendarDays} title="Work week & hours" hint="Office staff punch on the machine; field staff punch from My Attendance.">
        <Row label="Working days" desc="Days not ticked are weekly offs (no absence is marked on them)">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {DAYS.map((d) => {
              const on = (s.working_days || []).includes(d);
              return (
                <button key={d} type="button" disabled={dis} aria-pressed={on}
                  onClick={() => set('working_days', on ? s.working_days.filter((x) => x !== d) : DAYS.filter((x) => x === d || s.working_days.includes(x)))}
                  style={{ padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: dis ? 'not-allowed' : 'pointer',
                    border: `1px solid ${on ? '#6B3FDB' : '#e5e7eb'}`, background: on ? '#6B3FDB' : '#fff', color: on ? '#fff' : '#6b7280' }}>{label(d)}</button>
              );
            })}
          </div>
        </Row>
        <Row label="Work hours in a full day" desc="Hours of work, not counting the break">
          <input type="number" min="1" max="16" step="0.5" style={INPUT} disabled={dis} value={s.full_day_hours} onChange={num('full_day_hours')} />
        </Row>
        <Row label="Lunch / break (minutes)" desc={`Time on site for a full day: ${onSiteText}. Overtime starts after this.`}>
          <input type="number" min="0" max="240" step="5" style={INPUT} disabled={dis} value={s.break_duration} onChange={num('break_duration')} />
        </Row>
        <Row label="Half day below (hours)" desc="Fewer hours than this on a day count as a half day">
          <input type="number" min="1" max="12" step="0.5" style={INPUT} disabled={dis} value={s.half_day_hours} onChange={num('half_day_hours')} />
        </Row>
        <Row label="Default start / end" desc="Used for anyone who has no shift assigned">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="time" style={INPUT} disabled={dis} value={s.work_start_time} onChange={(e) => set('work_start_time', e.target.value)} />
            <span style={{ color: '#9ca3af' }}>–</span>
            <input type="time" style={INPUT} disabled={dis} value={s.work_end_time} onChange={(e) => set('work_end_time', e.target.value)} />
          </span>
        </Row>
      </Section>

      <Section icon={Clock} title="Late arrival">
        <Row label="Grace minutes" desc="Arriving later than shift start + this is marked Late">
          <input type="number" min="0" max="120" style={INPUT} disabled={dis} value={s.grace_minutes} onChange={num('grace_minutes')} />
        </Row>
        <Row label="Field staff clock-in window" desc="Field staff are exempt; this applies to in-app punches only (minutes before / after shift start)">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="number" min="0" max="240" style={{ ...INPUT, width: 80 }} disabled={dis} value={s.clock_window_early_minutes} onChange={num('clock_window_early_minutes')} />
            <span style={{ color: '#9ca3af', fontSize: 12 }}>before</span>
            <input type="number" min="0" max="240" style={{ ...INPUT, width: 80 }} disabled={dis} value={s.clock_window_late_minutes} onChange={num('clock_window_late_minutes')} />
            <span style={{ color: '#9ca3af', fontSize: 12 }}>after</span>
          </span>
        </Row>
      </Section>

      <Section icon={Zap} title="Overtime" hint="Keep this off until you use overtime. While off, no overtime request is made and payroll pays no overtime.">
        <Row label="Track overtime">
          <Toggle id="ot_enabled" checked={s.ot_enabled} disabled={dis} onChange={(v) => set('ot_enabled', v)} />
        </Row>
        {s.ot_enabled && (
          <>
            <Row label="Needs approval" desc="Off = overtime is approved automatically">
              <Toggle id="ot_req" checked={s.ot_requires_approval} disabled={dis} onChange={(v) => set('ot_requires_approval', v)} />
            </Row>
            <Row label="Pay rate (× normal hourly)" desc="Weekday · weekly off · holiday">
              <span style={{ display: 'inline-flex', gap: 6 }}>
                {['ot_weekday_multiplier', 'ot_weekend_multiplier', 'ot_holiday_multiplier'].map((k) => (
                  <input key={k} type="number" min="1" max="5" step="0.25" style={{ ...INPUT, width: 80 }} disabled={dis} value={s[k]} onChange={num(k)} aria-label={k} />
                ))}
              </span>
            </Row>
            <Row label="Caps (hours)" desc="Per day · per month (0 = no cap)">
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <input type="number" min="0" step="0.5" style={{ ...INPUT, width: 80 }} disabled={dis} value={s.ot_max_daily_hours} onChange={num('ot_max_daily_hours')} aria-label="Daily cap" />
                <input type="number" min="0" step="1" style={{ ...INPUT, width: 80 }} disabled={dis} value={s.ot_max_monthly_hours} onChange={num('ot_max_monthly_hours')} aria-label="Monthly cap" />
              </span>
            </Row>
          </>
        )}
      </Section>

      <Section icon={Gift} title="Comp off" hint="Keep this off until you use comp off. When on, a full day worked on a holiday earns one comp-off day.">
        <Row label="Grant comp off for holiday work">
          <Toggle id="comp_off" checked={s.comp_off_enabled} disabled={dis} onChange={(v) => set('comp_off_enabled', v)} />
        </Row>
      </Section>

      <Section icon={FileEdit} title="Regularization (attendance corrections)">
        <Row label="Requests per employee per month" desc="Pending and approved requests count; a rejected one does not">
          <input type="number" min="0" max="31" style={INPUT} disabled={dis} value={s.regularization_monthly_limit} onChange={num('regularization_monthly_limit')} />
        </Row>
        <Row label="HR approves after the manager" desc="Off = the reporting manager's approval is final">
          <Toggle id="reg_hr" checked={s.regularization_needs_hr} disabled={dis} onChange={(v) => set('regularization_needs_hr', v)} />
        </Row>
      </Section>

      <Section icon={LogOut} title="Auto check-out">
        <Row label="Check out anyone still inside at" desc="For days when someone forgets to punch out">
          <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
            <Toggle id="auto_co" checked={s.auto_checkout} disabled={dis} onChange={(v) => set('auto_checkout', v)} />
            <input type="time" style={INPUT} disabled={dis || !s.auto_checkout} value={s.auto_checkout_time} onChange={(e) => set('auto_checkout_time', e.target.value)} />
          </span>
        </Row>
      </Section>

      {canEdit && (
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--color-bg-page, #f8f9fc)' }}>
          <button className="pulse-btn-secondary" onClick={load} disabled={busy}><RefreshCw size={13} /> Discard changes</button>
          <button className="pulse-btn-primary" onClick={save} disabled={busy || !dirty}><Save size={13} /> {busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      )}
    </div>
  );

  if (embedded) return body;
  return (
    <PageShell dock={<PageHero icon={CalendarDays} eyebrow="Attendance" title="Attendance Settings" subtitle="Work week, hours, late, overtime, comp off and corrections" />}>
      {body}
    </PageShell>
  );
}
