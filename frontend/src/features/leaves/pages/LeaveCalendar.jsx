import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { ChevronLeft, ChevronRight, Users, Calendar, X, CalendarDays } from 'lucide-react';
import './LeaveCalendar.css';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { isWeeklyOff } from '../components/SaturdayOffPicker';
import { LeaveHistoryDialog, fmtDate, localISO } from '../components/leaveShared';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WEEKDAY_KEYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// Eight distinct colours; none is the holiday purple (#ede9fe / #7c5cf0).
const COLOR_PALETTE = ['#6366f1','#ef4444','#10b981','#f59e0b','#ec4899','#0891b2','#84cc16','#a16207'];
const colorForKey = (key) => {
  if (typeof key === 'number' && Number.isFinite(key)) return COLOR_PALETTE[Math.abs(key - 1) % COLOR_PALETTE.length];
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOR_PALETTE[h % COLOR_PALETTE.length];
};
// Colour and legend come from the leave rows themselves, not the active type
// list: a leave on a type switched off later still needs a colour and a row.
const typeKey  = (l) => (l?.leave_type_id != null ? Number(l.leave_type_id) : (l?.leave_name || l?.leave_type || 'Leave'));
const typeName = (l) => l?.leave_name || l?.leave_type || 'Leave';

// Who sees more than themself — the server decides the actual scope
// (calendarScopeOf: admins the company, department heads their department,
// managers their direct reports).
const ADMIN_ROLES = ['admin','super_admin','hr','hr_manager','hr_exec','manager','department_head','l2_approver'];

const FILTER_SELECT = {
  border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 10px',
  fontSize: 12, color: '#374151', background: '#fff', cursor: 'pointer',
};

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const dayOf = v => String(v || '').slice(0, 10);

function LeaveRow({ l, color, onOpen }) {
  const s = dayOf(l.start_date || l.from_date);
  const e = dayOf(l.end_date || l.to_date);
  const days = Number(l.number_of_days);
  const half = l.half_day ? ` · ½ day${l.half_day_session ? ` (${String(l.half_day_session).toUpperCase()})` : ''}` : '';
  return (
    <button type="button" className="lc-side-item lc-side-link" onClick={() => onOpen(l)}
      title="Open the approval history">
      <div className="lc-side-avatar">{String(l.employee_name || '?')[0].toUpperCase()}</div>
      <div style={{ minWidth: 0, textAlign: 'left' }}>
        <div className="lc-side-name">{l.employee_name || 'Unknown'}</div>
        <div className="lc-side-meta">
          <span className="lc-side-badge" style={{ background: color + '22', color }}>{typeName(l)}</span>
          {l.status === 'pending' && <span className="lc-side-status lc-status-pending">Pending</span>}
        </div>
        <div className="lc-side-dates">
          {s === e ? fmtDate(s) : `${fmtDate(s)} – ${fmtDate(e)}`}
          {Number.isFinite(days) && days > 0 ? ` · ${days} day${days === 1 ? '' : 's'}` : ''}{half}
        </div>
      </div>
    </button>
  );
}

export default function LeaveCalendar() {
  const now = new Date();
  const todayISO = localISO(now);
  // hasAnyRole, not the primary `role`: someone holding HR or manager as a
  // second role got the self-only view while the server sent everyone.
  const { hasAnyRole } = useAuth();
  const isAdmin = hasAnyRole(...ADMIN_ROLES);

  const [year,       setYear]       = useState(now.getFullYear());
  const [month,      setMonth]      = useState(now.getMonth());
  const [leaves,     setLeaves]     = useState([]);
  const [todayRows,  setTodayRows]  = useState([]);
  const [holidays,   setHolidays]   = useState([]);
  const [people,     setPeople]     = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [reload,     setReload]     = useState(0);
  const [selectedDay,setSelectedDay]= useState(null);
  const [filterDept, setFilterDept] = useState('');
  const [filterEmp,  setFilterEmp]  = useState('');
  const [historyId,  setHistoryId]  = useState(null);
  // Pending requests too, to plan cover before they are decided (2026-11-24).
  const [showPending, setShowPending] = useState(false);
  const abortRef = useRef(null);
  const [weekCfg, setWeekCfg] = useState(null);
  useEffect(() => { api.get('/leaves/settings').then(r => setWeekCfg(r.data || null)).catch(() => {}); }, []);

  // The people the filters may name — current staff, in the caller's scope.
  useEffect(() => {
    if (!isAdmin) return;
    api.get('/leaves/calendar/people')
      .then(r => setPeople(Array.isArray(r.data) ? r.data : []))
      .catch(() => setPeople([]));
  }, [isAdmin]);

  const departments = useMemo(
    () => [...new Set(people.map(p => p.department).filter(Boolean))].sort(), [people]);
  // A department narrows the employee list instead of clearing it.
  const employeeOptions = useMemo(
    () => (filterDept ? people.filter(p => p.department === filterDept) : people), [people, filterDept]);

  const onDeptChange = (v) => {
    setFilterDept(v);
    if (v && filterEmp && !people.some(p => String(p.id) === String(filterEmp) && p.department === v)) setFilterEmp('');
  };

  const baseParams = useMemo(() => {
    const p = {};
    if (filterEmp)   p.employee_id     = filterEmp;
    if (filterDept)  p.department      = filterDept;
    if (showPending) p.include_pending = 1;
    return p;
  }, [filterEmp, filterDept, showPending]);

  // Leaves + holidays for the month shown.
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const start = iso(year, month, 1);
    // Local date: toISOString() is UTC and gave the day before the month end in IST.
    const end   = iso(year, month, new Date(year, month + 1, 0).getDate());

    setLoading(true);
    setError(null);

    // The days off of the people shown: company-wide holidays + every zone
    // they sit in, or one picked employee's zone. (/holidays gave a non-HR
    // manager only their OWN zone, whatever zone the team was in.)
    const holParams = { year, ...(filterEmp ? { employee_id: filterEmp } : {}) };
    Promise.all([
      api.get('/leaves/calendar',          { params: { ...baseParams, start_date: start, end_date: end }, signal: ctrl.signal }),
      api.get('/leaves/calendar/holidays', { params: holParams, signal: ctrl.signal }),
    ])
      .then(([lRes, hRes]) => {
        if (ctrl.signal.aborted) return;
        setLeaves(Array.isArray(lRes.data) ? lRes.data : []);
        const allHols = Array.isArray(hRes.data) ? hRes.data : [];
        setHolidays(allHols.filter(h => dayOf(h.date).slice(0, 7) === `${year}-${pad(month + 1)}`));
      })
      .catch(err => {
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        setError('Failed to load calendar data.');
        setLeaves([]);
        setHolidays([]);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });

    return () => ctrl.abort();
  }, [year, month, baseParams, filterEmp, reload]);

  // "On leave today" stays right whichever month is on screen.
  useEffect(() => {
    const ctrl = new AbortController();
    api.get('/leaves/calendar', { params: { ...baseParams, start_date: todayISO, end_date: todayISO }, signal: ctrl.signal })
      .then(r => { if (!ctrl.signal.aborted) setTodayRows(Array.isArray(r.data) ? r.data : []); })
      .catch(() => {});
    return () => ctrl.abort();
  }, [baseParams, todayISO, reload]);

  // A day picked in one month means nothing in the next ("31 February").
  useEffect(() => { setSelectedDay(null); }, [year, month]);

  const colorFor = useCallback((l) => colorForKey(typeKey(l)), []);

  const leavesOnDay = useCallback((day) => {
    const d = iso(year, month, day);
    return leaves.filter(l => {
      const s = dayOf(l.start_date || l.from_date);
      const e = dayOf(l.end_date || l.to_date);
      return s && e && s <= d && e >= d;
    });
  }, [leaves, year, month]);

  const holidaysOnDay = useCallback((day) => {
    const d = iso(year, month, day);
    return holidays.filter(h => dayOf(h.date) === d);
  }, [holidays, year, month]);

  // Company weekly offs (incl. 2nd/4th-Saturday offs), not a fixed Sat + Sun.
  const isWeekend = useCallback((day) => isWeeklyOff(iso(year, month, day), weekCfg), [year, month, weekCfg]);

  // A holiday is a day off only for the zone it belongs to (none = everyone).
  const isOffFor = useCallback((l, day) => isWeekend(day) || holidaysOnDay(day).some(
    h => h.zone_id == null || l.zone_id == null || Number(h.zone_id) === Number(l.zone_id)), [isWeekend, holidaysOnDay]);

  // Leave days that fall in the month shown. A leave wholly inside the month
  // uses the server's own count (holidays, half days, sandwich rule); one
  // that crosses a month edge counts its working days inside this month.
  const daysInShownMonth = useCallback((l) => {
    const first = iso(year, month, 1);
    const lastD = new Date(year, month + 1, 0).getDate();
    const last  = iso(year, month, lastD);
    const s = dayOf(l.start_date || l.from_date);
    const e = dayOf(l.end_date || l.to_date);
    const n = Number(l.number_of_days);
    if (s >= first && e <= last && Number.isFinite(n)) return n;
    let c = 0;
    for (let d = 1; d <= lastD; d++) {
      const dd = iso(year, month, d);
      if (dd >= s && dd <= e && !isOffFor(l, d)) c++;
    }
    return l.half_day ? Math.min(c, 0.5) : c;
  }, [year, month, isOffFor]);

  // Per leave type: days + people, approved and pending kept apart.
  const monthlySummary = useMemo(() => {
    const map = new Map();
    leaves.forEach(l => {
      const k = typeKey(l);
      if (!map.has(k)) map.set(k, { key: k, name: typeName(l), days: 0, pendingDays: 0, people: new Set() });
      const row = map.get(k);
      const d = daysInShownMonth(l);
      if (l.status === 'pending') row.pendingDays += d; else { row.days += d; row.people.add(l.employee_id); }
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [leaves, daysInShownMonth]);

  const fmtDays = n => (Math.round(n * 10) / 10).toString();

  const prev = () => { if (month === 0) { setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11){ setMonth(0);  setYear(y => y + 1); } else setMonth(m => m + 1); };
  const goToday = () => { setYear(now.getFullYear()); setMonth(now.getMonth()); };
  const onCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++)    cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const zoneLabel = h => (h.zone_name && !filterEmp ? ` (${h.zone_name})` : '');
  const openLeave = l => l?.id && setHistoryId(l.id);

  return (
    <PageShell dock={
      <PageHero
        icon={CalendarDays}
        eyebrow="Leave"
        title="Leave Calendar"
        actions={isAdmin && (
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
            <select aria-label="Department" value={filterDept} onChange={e => onDeptChange(e.target.value)} style={FILTER_SELECT}>
              <option value="">All departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select aria-label="Employee" value={filterEmp} onChange={e => setFilterEmp(e.target.value)} style={FILTER_SELECT}>
              <option value="">All employees</option>
              {employeeOptions.map(p => (
                <option key={p.id} value={p.id}>{p.name}{p.office_id ? ` (${p.office_id})` : ''}</option>
              ))}
            </select>
            <label style={{ ...FILTER_SELECT, display:'flex', alignItems:'center', gap:5 }} title="Requests not yet approved, drawn hollow">
              <input type="checkbox" checked={showPending} onChange={e => setShowPending(e.target.checked)} /> Show pending
            </label>
            {(filterDept || filterEmp) && (
              <button className="plh-cta" aria-label="Clear filters" title="Clear filters"
                onClick={() => { setFilterDept(''); setFilterEmp(''); }}>
                <X size={13}/>
              </button>
            )}
          </div>
        )}
      />
    }>
      <div className="lc-layout">
        {/* ── Calendar card ── */}
        <div className="lc-cal-card">
          <div className="lc-nav">
            <button className="lc-nav-btn" onClick={prev} aria-label="Previous month"><ChevronLeft size={14}/></button>
            <span className="lc-month-lbl">{MONTHS[month]} {year}</span>
            <button className="lc-nav-btn" onClick={next} aria-label="Next month"><ChevronRight size={14}/></button>
            <button className="lc-today-btn" onClick={goToday} disabled={onCurrentMonth}>Today</button>
          </div>

          {loading && (
            <div style={{ textAlign:'center', padding:32, color:'#9ca3af', fontSize:13 }}>Loading…</div>
          )}
          {!loading && error && (
            <div style={{ textAlign:'center', padding:32, color:'#ef4444', fontSize:13 }}>
              {error}{' '}
              <button className="pulse-btn-secondary" style={{ marginLeft: 8 }} onClick={() => setReload(n => n + 1)}>Retry</button>
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="lc-day-hdrs">
                {DAYS.map((d, i) => (
                  <div
                    key={d}
                    className="lc-day-hdr"
                    // Red only for a day that is off every week (company settings).
                    style={{ color: (weekCfg?.weekend_days || ['saturday', 'sunday']).includes(WEEKDAY_KEYS[i]) ? '#f87171' : undefined }}
                  >
                    {d}
                  </div>
                ))}
              </div>

              <div className="lc-grid">
                {cells.map((day, i) => {
                  if (!day) return <div key={i} className="lc-cell lc-cell-empty"/>;

                  const dayLeaves  = leavesOnDay(day);
                  const dayHols    = holidaysOnDay(day);
                  const isToday    = onCurrentMonth && day === now.getDate();
                  const weekend    = isWeekend(day);
                  const isSelected = selectedDay === day;

                  return (
                    <div
                      key={i}
                      role="button"
                      tabIndex={0}
                      aria-label={`${day} ${MONTHS[month]}: ${dayLeaves.length} on leave`}
                      className={[
                        'lc-cell',
                        isToday    ? 'lc-cell-today' : '',
                        isSelected ? 'lc-cell-sel'   : '',
                        dayLeaves.length > 0 && !isSelected ? 'lc-cell-has' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ background: weekend && !isToday && !isSelected ? '#f9fafb' : undefined }}
                      onClick={() => setSelectedDay(isSelected ? null : day)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedDay(isSelected ? null : day); } }}
                    >
                      <span className="lc-day-num" style={{ color: weekend && !isToday ? '#9ca3af' : undefined }}>
                        {day}
                      </span>

                      {dayHols.map(h => (
                        <div key={h.id} className="lc-hol-chip" title={`${h.name}${zoneLabel(h)}`}>
                          {h.name}{zoneLabel(h)}
                        </div>
                      ))}

                      <div className="lc-dots">
                        {dayLeaves.slice(0, 5).map((l, li) => {
                          const off = isOffFor(l, day);
                          return (
                            <div
                              key={l.id ?? li}
                              className="lc-dot"
                              style={{
                                ...(l.status === 'pending'
                                  ? { background: 'transparent', border: `1.5px solid ${colorFor(l)}`, boxSizing: 'border-box' }
                                  : { background: colorFor(l) }),
                                opacity: off ? 0.35 : 1,
                              }}
                              title={`${l.employee_name ?? ''} – ${typeName(l)}${l.half_day ? ' (½ day)' : ''}${l.status === 'pending' ? ' (pending)' : ''}${off ? ' · day off' : ''}`}
                            />
                          );
                        })}
                        {dayLeaves.length > 5 && <span className="lc-dot-more">+{dayLeaves.length - 5}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Legend — the types actually on screen this month */}
              <div className="lc-legend">
                {monthlySummary.map(t => (
                  <div key={t.key} className="lc-legend-item">
                    <div className="lc-legend-dot" style={{ background: colorForKey(t.key) }}/>
                    {t.name}
                  </div>
                ))}
                {showPending && leaves.some(l => l.status === 'pending') && (
                  <div className="lc-legend-item">
                    <div className="lc-legend-dot" style={{ border: '1.5px solid #6b7280', boxSizing: 'border-box' }}/>
                    Pending (hollow)
                  </div>
                )}
                {holidays.length > 0 && (
                  <div className="lc-legend-item">
                    <div className="lc-legend-dot" style={{ background:'#ede9fe', border:'1px solid #7c5cf0' }}/>
                    Holiday
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="lc-side">
          {selectedDay && (
            <div className="lc-side-section">
              <div className="lc-side-hd">
                <Calendar size={13}/>
                {selectedDay} {MONTHS[month]} {year}
                <button
                  onClick={() => setSelectedDay(null)}
                  aria-label="Close day"
                  style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:'#9ca3af', padding:0, display:'flex' }}
                >
                  <X size={13}/>
                </button>
              </div>

              {holidaysOnDay(selectedDay).map(h => (
                <div key={h.id} className="lc-hol-row">{h.name}{zoneLabel(h)}</div>
              ))}

              {leavesOnDay(selectedDay).length === 0 && holidaysOnDay(selectedDay).length === 0 && (
                <p className="lc-side-empty">No leave or holiday on this day</p>
              )}

              {leavesOnDay(selectedDay).map((l, i) => (
                <LeaveRow key={l.id ?? i} l={l} color={colorFor(l)} onOpen={openLeave} />
              ))}
            </div>
          )}

          <div className="lc-side-section">
            <div className="lc-side-hd">
              <Users size={13}/>
              On leave today
            </div>
            {todayRows.length === 0
              ? <p className="lc-side-empty">No one on leave today</p>
              : todayRows.map((l, i) => <LeaveRow key={l.id ?? i} l={l} color={colorFor(l)} onOpen={openLeave} />)}
          </div>

          <div className="lc-side-section">
            <div className="lc-side-hd">{MONTHS[month]} summary</div>
            {monthlySummary.length === 0
              ? <p className="lc-side-empty">No {showPending ? '' : 'approved '}leave this month</p>
              : monthlySummary.map(t => (
                  <div key={t.key} className="lc-summary-row">
                    <div className="lc-legend-dot" style={{ background: colorForKey(t.key), flexShrink:0 }}/>
                    <span className="lc-summary-type">{t.name}</span>
                    <span className="lc-summary-cnt" title={`${t.people.size} ${t.people.size === 1 ? 'person' : 'people'} approved`}>
                      {fmtDays(t.days)} d
                    </span>
                    {t.pendingDays > 0 && (
                      <span className="lc-summary-pend" title="Pending days">+{fmtDays(t.pendingDays)} pending</span>
                    )}
                  </div>
                ))}
            {monthlySummary.length > 0 && (
              <p className="lc-side-note">Leave days in {MONTHS[month]}. Click a name for its approval history.</p>
            )}
          </div>
        </div>
      </div>

      {historyId && <LeaveHistoryDialog leaveId={historyId} onClose={() => setHistoryId(null)} />}
    </PageShell>
  );
}
