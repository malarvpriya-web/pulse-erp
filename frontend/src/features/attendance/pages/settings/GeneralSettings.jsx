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
import { Save, RefreshCw, CalendarDays, Clock, Zap, Gift, FileEdit, LogOut, ChevronDown, AlertTriangle, Bell, Plus, Trash2, Star } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import SaturdayOffPicker, { saturdayText } from '@/features/leaves/components/SaturdayOffPicker';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const label = (d) => d.charAt(0).toUpperCase() + d.slice(1, 3);
const CARD = { background: '#fff', border: '1px solid #ece9f8', borderRadius: 12, padding: 20, marginBottom: 16 };
const INPUT = { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, width: 120, boxSizing: 'border-box' };
const errText = (e) => e?.response?.data?.message || e?.response?.data?.error || 'Could not save settings';

// Collapsed by default (owner, 2026-11-19): the page shows one line per
// section with what is set now; clicking a line opens it for editing.
function Section({ icon: Icon, title, hint, summary, open, onToggle, children }) {
  return (
    <div style={{ ...CARD, padding: 0, marginBottom: 10 }}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 20px', background: 'none',
          border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <Icon size={16} color="#6B3FDB" />
        <span style={{ fontSize: 15, fontWeight: 700, color: '#1f2937' }}>{title}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        <ChevronDown size={16} color="#6B3FDB" style={{ flexShrink: 0, transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <div style={{ padding: '0 20px 14px' }}>
          {hint && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>{hint}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

// Late-coming penalty rules (§278.3) — same wording the server uses.
const RULE_KINDS = [
  { id: 'late_count', label: 'Late arrivals — every N times', each: false },
  { id: 'late_each', label: 'Late arrival — each time', each: true },
  { id: 'early_count', label: 'Leaving early — every N times', each: false },
  { id: 'early_each', label: 'Leaving early — each time', each: true },
];
const isEach = (kind) => kind.endsWith('_each');
function ruleText(r) {
  const cut = Number(r.deduct_days) === 1 ? 'a full day' : 'half a day';
  const late = r.kind.startsWith('late');
  if (isEach(r.kind)) return `${late ? `Late by more than ${r.minutes} min` : `Leaving more than ${r.minutes} min early`} → cut ${cut} each time`;
  return `Every ${r.count} ${late ? 'late arrivals' : 'early exits'} of more than ${r.minutes} min in a month → cut ${cut}`;
}
const newRule = () => ({ id: `r${Date.now().toString(36)}`, kind: 'late_count', count: 3, minutes: 15, deduct_days: 0.5, active: true });

// Rating tables for performance (§278.5): every row editable, rows can be
// added or removed; the last row is the catch-all ("anything lower" for %,
// "more than that" for days) and only its rating changes.
//   kind 'pct'  → rows { min_pct, rating }, highest % first, last min_pct 0
//   kind 'days' → rows { max_days, rating }, fewest days first, last max_days null
function BandEditor({ kind, rows, onChange, disabled }) {
  const pct = kind === 'pct';
  const key = pct ? 'min_pct' : 'max_days';
  const body = rows.slice(0, -1);
  const last = rows[rows.length - 1] || (pct ? { min_pct: 0, rating: 1 } : { max_days: null, rating: 1 });
  const emit = (b, l) => onChange([...b, l]);
  const upd = (i, patch) => emit(body.map((r, j) => (j === i ? { ...r, ...patch } : r)), last);
  const ratingSelect = (value, onSel, label) => (
    <select aria-label={label} disabled={disabled} value={value} onChange={(e) => onSel(Number(e.target.value))} style={{ ...INPUT, width: 80 }}>
      {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
  return (
    <div data-testid={`band-editor-${kind}`}>
      {body.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #f5f3ff', fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
          {pct ? 'On time on at least' : 'Days off at most'}
          <input type="number" min="0" max={pct ? 100 : 366} disabled={disabled} aria-label={pct ? 'Percent' : 'Days'} value={r[key] ?? ''}
            onChange={(e) => upd(i, { [key]: e.target.value === '' ? '' : Number(e.target.value) })} style={{ ...INPUT, width: 70 }} />
          {pct ? '% of days present' : 'days'} → rating
          {ratingSelect(r.rating, (v) => upd(i, { rating: v }), 'Rating')}
          {!disabled && (
            <button type="button" aria-label="Remove row" onClick={() => emit(body.filter((_, j) => j !== i), last)}
              style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 6, padding: '6px 8px', cursor: 'pointer', display: 'inline-flex' }}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #f5f3ff', fontSize: 12, color: '#6b7280' }}>
        {pct ? 'Anything lower' : 'More than that'} → rating
        {ratingSelect(last.rating, (v) => emit(body, { ...last, rating: v }), 'Rating for the rest')}
      </div>
      {!disabled && body.length < 9 && (
        <button type="button" className="pulse-btn-secondary" style={{ marginTop: 6 }}
          onClick={() => emit([...body, pct ? { min_pct: 60, rating: 2 } : { max_days: 30, rating: 2 }], last)}>
          <Plus size={13} /> Add row
        </button>
      )}
    </div>
  );
}

// Who gets comp off (owner, 2026-11-19: production staff, not everyone).
function CompOffChooser({ list, setList, disabled }) {
  const [q, setQ] = useState('');
  if (!list) return <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>Only HR and administrators can choose who gets comp off.</div>;
  const depts = [...new Set(list.map((e) => e.department || '—'))];
  const toggle = (ids, on) => setList(list.map((e) => (ids.includes(e.id) ? { ...e, comp_off_eligible: on } : e)));
  const shown = list.filter((e) => !q || `${e.name} ${e.emp_code} ${e.department}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ borderTop: '1px solid #f5f3ff', paddingTop: 10 }} data-testid="comp-off-chooser">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Employees who get comp off</span>
        <input placeholder="Search name, code, department" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...INPUT, width: 220 }} />
        {!disabled && depts.map((d) => {
          const ids = list.filter((e) => (e.department || '—') === d).map((e) => e.id);
          const all = ids.every((id) => list.find((e) => e.id === id)?.comp_off_eligible);
          return (
            <button key={d} type="button" onClick={() => toggle(ids, !all)}
              style={{ padding: '4px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${all ? '#6B3FDB' : '#e5e7eb'}`, background: all ? '#6B3FDB' : '#fff', color: all ? '#fff' : '#6b7280' }}>
              {all ? '✓ ' : ''}{d}
            </button>
          );
        })}
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #f0f0f4', borderRadius: 8 }}>
        {shown.map((e) => (
          <label key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid #f8f7fc', fontSize: 13, cursor: disabled ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={!!e.comp_off_eligible} disabled={disabled} onChange={(ev) => toggle([e.id], ev.target.checked)} />
            <span style={{ fontWeight: 600, color: '#1f2937' }}>{e.name}</span>
            <span style={{ color: '#9ca3af', fontSize: 12 }}>{e.emp_code} · {e.department || '—'}</span>
          </label>
        ))}
        {!shown.length && <div style={{ padding: 10, fontSize: 12, color: '#9ca3af' }}>Nobody matches.</div>}
      </div>
    </div>
  );
}

const onOff = (v) => (v ? 'On' : 'Off');
const hhmm = (t) => String(t || '').slice(0, 5);
function workWeekText(days = []) {
  const idx = DAYS.map((d) => days.includes(d));
  const n = idx.filter(Boolean).length;
  const first = idx.indexOf(true);
  const contiguous = n > 0 && idx.slice(first, first + n).every(Boolean);
  return contiguous && n > 1 ? `${label(DAYS[first])}–${label(DAYS[first + n - 1])}` : days.map(label).join(', ') || 'No days';
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
  const [openKey, setOpenKey] = useState(null);
  const sec = (key) => ({ open: openKey === key, onToggle: () => setOpenKey((k) => (k === key ? null : key)) });

  // Who gets comp off (HR/admin only; null for anyone else).
  const [compOff, setCompOff] = useState(null);
  const [compOffSaved, setCompOffSaved] = useState(null);
  const eligibleIds = (l) => (l || []).filter((e) => e.comp_off_eligible).map((e) => e.id).sort((a, b) => a - b).join(',');

  const load = async () => {
    try {
      const { data } = await api.get('/attendance/general-settings');
      setS(data); setSaved(data); setMsg(null);
    } catch (e) { setMsg({ type: 'error', text: errText(e) }); }
    api.get('/attendance/comp-off-eligibility')
      .then((r) => { setCompOff(r.data); setCompOffSaved(r.data); })
      .catch(() => { setCompOff(null); setCompOffSaved(null); });
  };
  useEffect(() => { load(); }, []);

  const set = (k, v) => setS((p) => ({ ...p, [k]: v }));
  const num = (k) => (e) => set(k, e.target.value === '' ? '' : Number(e.target.value));
  const compOffDirty = compOff && compOffSaved && eligibleIds(compOff) !== eligibleIds(compOffSaved);
  const dirty = (s && saved && JSON.stringify(s) !== JSON.stringify(saved)) || compOffDirty;

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      // The late-band box is typed as "10, 15, 30".
      const body = { ...s, late_bands: Array.isArray(s.late_bands) ? s.late_bands : String(s.late_bands || '').split(/[ ,]+/).map(Number).filter((n) => n > 0) };
      const { data } = await api.put('/attendance/general-settings', body);
      setS(data); setSaved(data);
      if (compOffDirty) {
        await api.put('/attendance/comp-off-eligibility', { employee_ids: compOff.filter((e) => e.comp_off_eligible).map((e) => e.id) });
        setCompOffSaved(compOff);
      }
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

      <Section icon={CalendarDays} title="Work week & hours" hint="Office staff punch on the machine; field staff punch from My Attendance."
        summary={`${workWeekText(s.working_days)}${(s.saturday_off_weeks || []).length ? ` (${saturdayText(s.working_days, s.saturday_off_weeks)})` : ""} · ${s.full_day_hours} h work + ${s.break_duration} min break · half day below ${s.half_day_hours} h · ${hhmm(s.work_start_time)}–${hhmm(s.work_end_time)}`}
        {...sec('week')}>
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
        <Row label="Saturdays" desc="Every Saturday off, every Saturday working, or only some (e.g. 2nd and 4th) off">
          <SaturdayOffPicker workingDays={s.working_days || []} weeks={s.saturday_off_weeks || []} disabled={dis}
            onChange={(v) => setS((p) => ({ ...p, ...v }))} />
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

      <Section icon={Clock} title="Late arrival"
        summary={`Grace ${s.grace_minutes} min · warning after ${s.late_warning_count} lates · early exit from ${s.early_exit_minutes} min · field staff window ${s.clock_window_early_minutes}/${s.clock_window_late_minutes} min`}
        {...sec('late')}>
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
        <Row label="Warning letter after" desc="Late Arrivals highlights an employee and offers a warning letter after this many late arrivals in a month">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#6b7280' }}>
            <input type="number" min="1" max="31" style={{ ...INPUT, width: 70 }} disabled={dis} value={s.late_warning_count} onChange={num('late_warning_count')} /> late arrivals
          </span>
        </Row>
        <Row label="Early exit counts from" desc="The Early Exit report counts a day when the last punch was at least this many minutes before shift end">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#6b7280' }}>
            <input type="number" min="1" max="240" style={{ ...INPUT, width: 70 }} disabled={dis} value={s.early_exit_minutes} onChange={num('early_exit_minutes')} /> min before shift end
          </span>
        </Row>
        <Row label="Late bands on Live Workforce" desc="Live Workforce shows who came in late above each of these minutes (up to 5), e.g. 10, 15, 30">
          <input type="text" style={{ ...INPUT, width: 180 }} disabled={dis} aria-label="Late bands"
            value={Array.isArray(s.late_bands) ? s.late_bands.join(', ') : s.late_bands}
            onChange={(e) => set('late_bands', e.target.value)}
            onBlur={(e) => set('late_bands', e.target.value.split(/[ ,]+/).map(Number).filter((n) => n > 0))} />
        </Row>
      </Section>

      <Section icon={Star} title="Punctuality rating (performance)"
        summary={(s.punctuality_bands || []).map((b) => `≥${b.min_pct}% → ${b.rating}`).join(' · ')}
        hint="Every performance review shows this rating automatically: the share of days present the employee came on time. The reviewer still gives their own ratings."
        {...sec('punct')}>
        <BandEditor kind="pct" rows={s.punctuality_bands || []} disabled={dis} onChange={(v) => set('punctuality_bands', v)} />
      </Section>

      <Section icon={Star} title="Leave rating (performance)"
        summary={(s.leave_rating_bands || []).map((b) => (b.max_days == null ? `more → ${b.rating}` : `≤${b.max_days} days → ${b.rating}`)).join(' · ')}
        hint="Every performance review shows this rating automatically: days off in the review period (approved leave, not counting weekly offs, plus absent days). The reviewer still gives their own ratings."
        {...sec('leave')}>
        <BandEditor kind="days" rows={s.leave_rating_bands || []} disabled={dis} onChange={(v) => set('leave_rating_bands', v)} />
      </Section>

      <Section icon={AlertTriangle} title="Late-coming penalties"
        summary={(() => {
          const on = (s.penalty_rules || []).filter((r) => r.active !== false).length;
          return on ? `${on} rule${on === 1 ? '' : 's'} on` : 'No rules';
        })()}
        hint="Applied when HR runs Payroll Sync: the days are added to loss of pay. Employees see them in My Attendance. Only days the employee was present count; a day caught by a “each time” rule is not counted again by an “every N times” rule."
        {...sec('penalty')}>
        {(s.penalty_rules || []).length === 0 && (
          <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>No rules yet.</div>
        )}
        {(s.penalty_rules || []).map((r, i) => {
          const upd = (patch) => set('penalty_rules', s.penalty_rules.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={r.id} data-testid="penalty-rule" style={{ borderTop: '1px solid #f5f3ff', padding: '10px 0' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select disabled={dis} value={r.kind} aria-label="Rule type"
                  onChange={(e) => upd({ kind: e.target.value, count: isEach(e.target.value) ? 1 : (r.count > 1 ? r.count : 3) })}
                  style={{ ...INPUT, width: 230 }}>
                  {RULE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                </select>
                {!isEach(r.kind) && (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#6b7280' }}>
                    every <input type="number" min="1" max="31" disabled={dis} aria-label="Times" value={r.count}
                      onChange={(e) => upd({ count: e.target.value === '' ? '' : Number(e.target.value) })} style={{ ...INPUT, width: 64 }} /> times
                  </span>
                )}
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#6b7280' }}>
                  more than <input type="number" min="1" max="600" disabled={dis} aria-label="Minutes" value={r.minutes}
                    onChange={(e) => upd({ minutes: e.target.value === '' ? '' : Number(e.target.value) })} style={{ ...INPUT, width: 70 }} /> min
                </span>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#6b7280' }}>
                  → cut
                  <select disabled={dis} aria-label="Cut" value={r.deduct_days} onChange={(e) => upd({ deduct_days: Number(e.target.value) })} style={{ ...INPUT, width: 110 }}>
                    <option value={0.5}>half a day</option>
                    <option value={1}>a full day</option>
                  </select>
                </span>
                <Toggle id={`pen_${r.id}`} checked={r.active !== false} disabled={dis} onChange={(v) => upd({ active: v })} />
                {!dis && (
                  <button type="button" aria-label="Remove rule" onClick={() => set('penalty_rules', s.penalty_rules.filter((_, j) => j !== i))}
                    style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 6, padding: '6px 8px', cursor: 'pointer', display: 'inline-flex' }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#6B3FDB', marginTop: 4 }}>{ruleText(r)}</div>
            </div>
          );
        })}
        {!dis && (
          <button type="button" className="pulse-btn-secondary" style={{ marginTop: 8 }}
            onClick={() => set('penalty_rules', [...(s.penalty_rules || []), newRule()])}>
            <Plus size={13} /> Add rule
          </button>
        )}
      </Section>

      <Section icon={Bell} title="Reminders"
        summary={[
          s.punch_reminder_enabled ? `punch-in ${s.punch_reminder_minutes} min before start` : null,
          s.punch_out_reminder_enabled ? 'punch-out at shift end' : null,
          s.team_summary_enabled ? 'monthly team summary to managers' : null,
        ].filter(Boolean).join(' · ') || 'Off'}
        hint="Punch reminders go to FIELD staff only (office staff punch on the machine), in-app (the bell). Nobody is reminded on a weekly off, a holiday or a day on approved leave, or once they have punched."
        {...sec('remind')}>
        <Row label="Remind field staff to punch in" desc="Minutes before their shift starts">
          <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
            <Toggle id="rem_in" checked={s.punch_reminder_enabled} disabled={dis} onChange={(v) => set('punch_reminder_enabled', v)} />
            <input type="number" min="5" max="120" step="5" style={{ ...INPUT, width: 80 }} disabled={dis || !s.punch_reminder_enabled}
              value={s.punch_reminder_minutes} onChange={num('punch_reminder_minutes')} aria-label="Minutes before start" />
          </span>
        </Row>
        <Row label="Remind field staff to punch out" desc="At shift end, if they punched in and have not punched out">
          <Toggle id="rem_out" checked={s.punch_out_reminder_enabled} disabled={dis} onChange={(v) => set('punch_out_reminder_enabled', v)} />
        </Row>
        <Row label="Monthly team summary to managers" desc="On the 1st: each manager gets last month's leaves, late arrivals (up to 15 min, 15–30 min, over 30 min), early exits and geo-fence results for their team">
          <Toggle id="team_sum" checked={s.team_summary_enabled} disabled={dis} onChange={(v) => set('team_summary_enabled', v)} />
        </Row>
      </Section>

      <Section icon={Zap} title="Overtime" hint="Keep this off until you use overtime. While off, no overtime request is made and payroll pays no overtime."
        summary={s.ot_enabled ? `On · ${s.ot_requires_approval ? 'needs approval' : 'auto-approved'} · ${s.ot_weekday_multiplier}× weekday` : 'Off'}
        {...sec('ot')}>
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

      <Section icon={Gift} title="Comp off" hint="When on, a full day worked on a holiday earns one comp-off day — only for the employees ticked below (e.g. production). Requests are decided in Attendance → Approvals → Comp Off."
        summary={`${onOff(s.comp_off_enabled)} · ${compOff ? `${compOff.filter((e) => e.comp_off_eligible).length} employees chosen` : '…'}`} {...sec('comp')}>
        <Row label="Grant comp off for holiday work">
          <Toggle id="comp_off" checked={s.comp_off_enabled} disabled={dis} onChange={(v) => set('comp_off_enabled', v)} />
        </Row>
        <CompOffChooser list={compOff} setList={setCompOff} disabled={dis} />
      </Section>

      <Section icon={FileEdit} title="Regularization (attendance corrections)"
        summary={`${s.regularization_monthly_limit} per employee a month · ${Number(s.regularization_window_days) === 0 ? 'same day only' : `up to ${s.regularization_window_days} days later`} · ${s.regularization_needs_hr ? 'manager, then HR' : 'manager decides'}`}
        hint="Only the employee asks, from My Attendance."
        {...sec('reg')}>
        <Row label="Requests per employee per month" desc="Pending and approved requests count; a rejected one does not">
          <input type="number" min="0" max="31" style={INPUT} disabled={dis} value={s.regularization_monthly_limit} onChange={num('regularization_monthly_limit')} />
        </Row>
        <Row label="Days allowed after the day" desc="0 = the employee must ask on the same day">
          <input type="number" min="0" max="31" style={INPUT} disabled={dis} value={s.regularization_window_days} onChange={num('regularization_window_days')} />
        </Row>
        <Row label="HR approves after the manager" desc="Off = the reporting manager's approval is final">
          <Toggle id="reg_hr" checked={s.regularization_needs_hr} disabled={dis} onChange={(v) => set('regularization_needs_hr', v)} />
        </Row>
      </Section>

      <Section icon={LogOut} title="Auto check-out"
        summary={s.auto_checkout ? `On · at ${hhmm(s.auto_checkout_time)}` : 'Off'} {...sec('auto')}>
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
