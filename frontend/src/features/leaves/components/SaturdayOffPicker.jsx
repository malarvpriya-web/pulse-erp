/**
 * Which Saturdays are weekly off (owner, 2026-11-23): every Saturday, or only
 * some — e.g. the 2nd and/or 4th. One setting (attendance_general_settings:
 * working_days + saturday_off_weeks) used by attendance, payroll sync, leave
 * day counts and timesheets. Shown in Attendance → Settings and in Leave
 * Settings → Leave rules; both save the same fields.
 */
const WEEKS = [1, 2, 3, 4, 5];
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

export function saturdayText(workingDays = [], weeks = []) {
  if (!workingDays.includes('saturday')) return 'Every Saturday off';
  if (!weeks?.length) return 'Every Saturday working';
  return `${weeks.map(w => ORD[w]).join(' & ')} Saturday off`;
}

export default function SaturdayOffPicker({ workingDays = [], weeks = [], onChange, disabled = false }) {
  const everyOff = !workingDays.includes('saturday');
  const withSat = (on) => (on
    ? [...new Set([...workingDays, 'saturday'])]
    : workingDays.filter(d => d !== 'saturday'));
  const chip = (active) => ({
    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
    border: `1px solid ${active ? '#6B3FDB' : '#e5e7eb'}`, background: active ? '#6B3FDB' : '#fff', color: active ? '#fff' : '#6b7280',
  });
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <button type="button" disabled={disabled} aria-pressed={everyOff} style={chip(everyOff)}
          onClick={() => onChange({ working_days: withSat(false), saturday_off_weeks: [] })}>Every Saturday off</button>
        <button type="button" disabled={disabled} aria-pressed={!everyOff && !weeks.length} style={chip(!everyOff && !weeks.length)}
          onClick={() => onChange({ working_days: withSat(true), saturday_off_weeks: [] })}>Every Saturday working</button>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
        <span style={{ color: '#6b7280' }}>Or only these Saturdays off:</span>
        {WEEKS.map(w => {
          const on = !everyOff && weeks.includes(w);
          return (
            <label key={w} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'not-allowed' : 'pointer' }}>
              <input type="checkbox" disabled={disabled} checked={on}
                onChange={() => {
                  const next = on ? weeks.filter(x => x !== w) : [...new Set([...(everyOff ? [] : weeks), w])].sort();
                  onChange({ working_days: withSat(true), saturday_off_weeks: next });
                }} />
              {ORD[w]}
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
        Now: <strong>{saturdayText(workingDays, weeks)}</strong>. A Saturday that is off is not counted as a leave day or a working day in payroll.
      </div>
    </div>
  );
}

/** Is this YYYY-MM-DD a weekly off? `cfg` = { weekend_days, saturday_off_weeks } from GET /leaves/settings. */
export function isWeeklyOff(dateStr, cfg) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  const name = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()];
  const weekend = cfg?.weekend_days || ['saturday', 'sunday'];
  if (weekend.includes(name)) return true;
  return name === 'saturday' && (cfg?.saturday_off_weeks || []).includes(Math.ceil(d.getDate() / 7));
}
