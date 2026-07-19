import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { ChevronLeft, ChevronRight, Users, Calendar, X } from 'lucide-react';
import './LeaveCalendar.css';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const COLOR_PALETTE = ['#6366f1','#ef4444','#f59e0b','#ec4899','#3b82f6','#8b5cf6','#10b981','#f97316'];
const colorForId = (id) => COLOR_PALETTE[((id ?? 1) - 1) % COLOR_PALETTE.length];

const ADMIN_ROLES = ['admin','super_admin','hr','hr_manager','hr_exec','manager','team_lead','department_head','l2_approver'];

const FILTER_SELECT = {
  border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 10px',
  fontSize: 12, color: '#374151', background: '#fff', cursor: 'pointer',
};

export default function LeaveCalendar() {
  const now = new Date();
  const { user, role } = useAuth();
  const isAdmin = ADMIN_ROLES.includes((role || '').toLowerCase());

  const [year,       setYear]       = useState(now.getFullYear());
  const [month,      setMonth]      = useState(now.getMonth());
  const [leaves,     setLeaves]     = useState([]);
  const [holidays,   setHolidays]   = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [employees,  setEmployees]  = useState([]);
  const [departments,setDepartments]= useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [selectedDay,setSelectedDay]= useState(null);
  const [filterDept, setFilterDept] = useState('');
  const [filterEmp,  setFilterEmp]  = useState('');
  const abortRef = useRef(null);

  // Fetch leave types once for legend + color map
  useEffect(() => {
    api.get('/leaves/types', { params: { applicable: 1 } })
      .then(r => setLeaveTypes(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, []);

  // Fetch employees list for admin filter dropdowns
  useEffect(() => {
    if (!isAdmin) return;
    api.get('/employees')
      .then(r => {
        const list = Array.isArray(r.data) ? r.data : [];
        setEmployees(list);
        const depts = [...new Set(list.map(e => e.department).filter(Boolean))].sort();
        setDepartments(depts);
      })
      .catch(() => {});
  }, [isAdmin]);

  // Fetch leaves + holidays whenever month/year/filters change
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const pad = n => String(n).padStart(2, '0');
    const start = `${year}-${pad(month + 1)}-01`;
    const end   = new Date(year, month + 1, 0).toISOString().slice(0, 10);

    setLoading(true);
    setError(null);

    const leavesParams = { start_date: start, end_date: end };
    if (!isAdmin)       leavesParams.employee_id = user?.employee_id;
    if (filterEmp)      leavesParams.employee_id = filterEmp;
    if (filterDept)     leavesParams.department  = filterDept;

    Promise.all([
      api.get('/leaves/calendar', { params: leavesParams,                  signal: ctrl.signal }),
      api.get('/holidays',        { params: { company_id: user?.company_id }, signal: ctrl.signal }),
    ])
      .then(([lRes, hRes]) => {
        if (ctrl.signal.aborted) return;
        setLeaves(Array.isArray(lRes.data) ? lRes.data : []);
        // Filter holidays to the displayed month on the frontend
        const allHols = Array.isArray(hRes.data) ? hRes.data : [];
        setHolidays(allHols.filter(h => {
          const d = String(h.date || '').slice(0, 7); // yyyy-mm
          return d === `${year}-${pad(month + 1)}`;
        }));
      })
      .catch(err => {
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        setError('Failed to load calendar data. Please try again.');
        setLeaves([]);
        setHolidays([]);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });

    return () => ctrl.abort();
  }, [year, month, isAdmin, user?.employee_id, user?.company_id, filterDept, filterEmp]);

  // type name → color lookup
  const typeColorMap = useMemo(() => {
    const m = {};
    leaveTypes.forEach(lt => { m[lt.leave_name] = colorForId(lt.id); });
    return m;
  }, [leaveTypes]);

  const colorFor = useCallback((leave) => {
    const name = leave?.leave_name || leave?.leave_type || '';
    return typeColorMap[name] || '#6366f1';
  }, [typeColorMap]);

  // Returns leaves that overlap a given day number
  const leavesOnDay = useCallback((day) => {
    const d = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return leaves.filter(l => {
      const s = String(l.start_date || l.from_date || '').slice(0, 10);
      const e = String(l.end_date   || l.to_date   || '').slice(0, 10);
      return s && e && s <= d && e >= d;
    });
  }, [leaves, year, month]);

  // Returns holidays on a given day number
  const holidaysOnDay = useCallback((day) => {
    const d = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return holidays.filter(h => String(h.date || '').slice(0, 10) === d);
  }, [holidays, year, month]);

  // Leaves today (only relevant when viewing the current month)
  const todayLeaves = useMemo(() => {
    if (year !== now.getFullYear() || month !== now.getMonth()) return [];
    return leavesOnDay(now.getDate());
  }, [leavesOnDay, year, month]);

  // Month summary counts per leave type
  const monthlySummary = useMemo(() => {
    const counts = {};
    leaves.forEach(l => {
      const name = l.leave_name || l.leave_type || 'Other';
      counts[name] = (counts[name] || 0) + 1;
    });
    return counts;
  }, [leaves]);

  const isWeekend = (day) => {
    const dow = new Date(year, month, day).getDay();
    return dow === 0 || dow === 6;
  };

  const prev = () => { if (month === 0) { setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11){ setMonth(0);  setYear(y => y + 1); } else setMonth(m => m + 1); };

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++)    cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="lc-root">
      {/* ── Header ── */}
      <div className="lc-header">
        <div>
          <h1 className="lc-title">Leave Calendar</h1>
          <p className="lc-sub">{isAdmin ? 'Team leave overview' : 'Your approved leaves'}</p>
        </div>

        {/* Admin: filter controls */}
        {isAdmin && (
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
            <select value={filterDept} onChange={e => { setFilterDept(e.target.value); setFilterEmp(''); }} style={FILTER_SELECT}>
              <option value="">All departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={filterEmp} onChange={e => { setFilterEmp(e.target.value); setFilterDept(''); }} style={FILTER_SELECT}>
              <option value="">All employees</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>
                  {e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}
                </option>
              ))}
            </select>
            {(filterDept || filterEmp) && (
              <button
                onClick={() => { setFilterDept(''); setFilterEmp(''); }}
                style={{ ...FILTER_SELECT, color:'#6b7280', padding:'6px 8px' }}
              >
                <X size={13}/>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="lc-layout">
        {/* ── Calendar card ── */}
        <div className="lc-cal-card">
          <div className="lc-nav">
            <button className="lc-nav-btn" onClick={prev}><ChevronLeft size={14}/></button>
            <span className="lc-month-lbl">{MONTHS[month]} {year}</span>
            <button className="lc-nav-btn" onClick={next}><ChevronRight size={14}/></button>
          </div>

          {loading && (
            <div style={{ textAlign:'center', padding:32, color:'#9ca3af', fontSize:13 }}>Loading…</div>
          )}
          {!loading && error && (
            <div style={{ textAlign:'center', padding:32, color:'#ef4444', fontSize:13 }}>{error}</div>
          )}

          {!loading && !error && (
            <>
              {/* Day-of-week headers */}
              <div className="lc-day-hdrs">
                {DAYS.map((d, i) => (
                  <div
                    key={d}
                    className="lc-day-hdr"
                    style={{ color: (i === 0 || i === 6) ? '#f87171' : undefined }}
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Calendar grid */}
              <div className="lc-grid">
                {cells.map((day, i) => {
                  if (!day) return <div key={i} className="lc-cell lc-cell-empty"/>;

                  const dayLeaves  = leavesOnDay(day);
                  const dayHols    = holidaysOnDay(day);
                  const isToday    = year === now.getFullYear() && month === now.getMonth() && day === now.getDate();
                  const weekend    = isWeekend(day);
                  const isSelected = selectedDay === day;

                  return (
                    <div
                      key={i}
                      className={[
                        'lc-cell',
                        isToday    ? 'lc-cell-today' : '',
                        isSelected ? 'lc-cell-sel'   : '',
                        dayLeaves.length > 0 && !isSelected ? 'lc-cell-has' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ background: weekend && !isToday && !isSelected ? '#f9fafb' : undefined }}
                      onClick={() => setSelectedDay(isSelected ? null : day)}
                    >
                      <span
                        className="lc-day-num"
                        style={{ color: weekend && !isToday ? '#9ca3af' : undefined }}
                      >
                        {day}
                      </span>

                      {/* Holiday chips */}
                      {dayHols.map(h => (
                        <div
                          key={h.id}
                          style={{
                            fontSize:9, background:'#fef3c7', color:'#92400e',
                            borderRadius:3, padding:'1px 4px',
                            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                          }}
                          title={h.name}
                        >
                          {h.name}
                        </div>
                      ))}

                      {/* Leave dots */}
                      <div className="lc-dots">
                        {dayLeaves.slice(0, 5).map((l, li) => (
                          <div
                            key={li}
                            className="lc-dot"
                            style={{ background: colorFor(l) }}
                            title={`${l.employee_name ?? ''} – ${l.leave_name || l.leave_type || ''}`}
                          />
                        ))}
                        {dayLeaves.length > 5 && (
                          <span className="lc-dot-more">+{dayLeaves.length - 5}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Legend — built from DB leave types */}
              <div className="lc-legend">
                {leaveTypes.map(lt => (
                  <div key={lt.id} className="lc-legend-item">
                    <div className="lc-legend-dot" style={{ background: colorForId(lt.id) }}/>
                    {lt.leave_name}
                  </div>
                ))}
                {holidays.length > 0 && (
                  <div className="lc-legend-item">
                    <div className="lc-legend-dot" style={{ background:'#fef3c7', border:'1px solid #f59e0b' }}/>
                    Holiday
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="lc-side">
          {/* Day detail panel (shown when a day is clicked) */}
          {selectedDay && (
            <div className="lc-side-section">
              <div className="lc-side-hd">
                <Calendar size={13}/>
                {selectedDay} {MONTHS[month]}
                <button
                  onClick={() => setSelectedDay(null)}
                  style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:'#9ca3af', padding:0, display:'flex' }}
                >
                  <X size={13}/>
                </button>
              </div>

              {holidaysOnDay(selectedDay).map(h => (
                <div
                  key={h.id}
                  style={{ fontSize:11, color:'#92400e', background:'#fef3c7', borderRadius:5, padding:'4px 8px', marginBottom:4 }}
                >
                  {h.name}
                </div>
              ))}

              {leavesOnDay(selectedDay).length === 0 && holidaysOnDay(selectedDay).length === 0 && (
                <p className="lc-side-empty">No leave or holiday on this day</p>
              )}

              {leavesOnDay(selectedDay).map((l, i) => (
                <div key={i} className="lc-side-item">
                  <div className="lc-side-avatar">
                    {String(l.employee_name || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ minWidth:0 }}>
                    <div className="lc-side-name">{l.employee_name || 'Unknown'}</div>
                    <div className="lc-side-meta">
                      <span
                        className="lc-side-badge"
                        style={{ background: colorFor(l) + '22', color: colorFor(l) }}
                      >
                        {l.leave_name || l.leave_type || 'Leave'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* On leave today */}
          <div className="lc-side-section">
            <div className="lc-side-hd">
              <Users size={13}/>
              On leave today
            </div>
            {todayLeaves.length === 0
              ? <p className="lc-side-empty">No one on leave today</p>
              : todayLeaves.map((l, i) => (
                  <div key={i} className="lc-side-item">
                    <div className="lc-side-avatar">
                      {String(l.employee_name || '?')[0].toUpperCase()}
                    </div>
                    <div style={{ minWidth:0 }}>
                      <div className="lc-side-name">{l.employee_name || 'Unknown'}</div>
                      <div className="lc-side-meta">
                        <span
                          className="lc-side-badge"
                          style={{ background: colorFor(l) + '22', color: colorFor(l) }}
                        >
                          {l.leave_name || l.leave_type || 'Leave'}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
            }
          </div>

          {/* Month summary */}
          <div className="lc-side-section">
            <div className="lc-side-hd">
              {MONTHS[month]} summary
            </div>
            {Object.keys(monthlySummary).length === 0
              ? <p className="lc-side-empty">No approved leaves this month</p>
              : leaveTypes
                  .filter(lt => monthlySummary[lt.leave_name])
                  .map(lt => (
                    <div key={lt.id} className="lc-summary-row">
                      <div className="lc-legend-dot" style={{ background: colorForId(lt.id), flexShrink:0 }}/>
                      <span className="lc-summary-type">{lt.leave_name}</span>
                      <span className="lc-summary-cnt">{monthlySummary[lt.leave_name]}</span>
                    </div>
                  ))
            }
          </div>
        </div>
      </div>
    </div>
  );
}
