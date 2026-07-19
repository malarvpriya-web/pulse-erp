import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight, RefreshCw, Sun, Moon,
  X, Printer, ArrowRightLeft, AlertCircle, CheckCircle2,
  Edit3, Clock, Calendar,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';

// ── Constants ─────────────────────────────────────────────────────────────────
const P = '#6B3FDB';
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAY_FULL  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_STR_TO_DOW = {
  sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6,
};

const STATUS_META = {
  present:  { bg: '#dcfce7', dot: '#10b981', text: '#166534', label: 'Present'  },
  late:     { bg: '#fef3c7', dot: '#f59e0b', text: '#92400e', label: 'Late'     },
  absent:   { bg: '#fee2e2', dot: '#ef4444', text: '#991b1b', label: 'Absent'   },
  wfh:      { bg: '#dbeafe', dot: '#3b82f6', text: '#1e40af', label: 'WFH'      },
  leave:    { bg: '#ede9fe', dot: '#8b5cf6', text: '#5b21b6', label: 'Leave'    },
  on_leave: { bg: '#ede9fe', dot: '#8b5cf6', text: '#5b21b6', label: 'Leave'    },
  holiday:  { bg: '#fef9c3', dot: '#eab308', text: '#854d0e', label: 'Holiday'  },
};

const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 };

// ── Pure helpers ──────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function toYMD(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

function parseWeeklyOff(shift) {
  if (!shift) return [0, 6];
  let arr = shift.weekly_off;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr) || arr.length === 0) return [0, 6];
  return arr
    .map(d => (typeof d === 'number' ? d : (DAY_STR_TO_DOW[String(d).toLowerCase()] ?? -1)))
    .filter(d => d >= 0);
}

function calcShiftHours(shift) {
  if (!shift?.start_time || !shift?.end_time) return null;
  const [sh, sm] = shift.start_time.split(':').map(Number);
  const [eh, em] = shift.end_time.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m2 = mins % 60;
  return m2 === 0 ? `${h}h` : `${h}h ${m2}m`;
}

function shiftColor(shift) {
  const c = (shift?.color && /^#[0-9a-fA-F]{6}$/.test(shift.color)) ? shift.color : P;
  return { bg: c + '18', color: c };
}

function contrastColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 145 ? '#111827' : '#ffffff';
}

function nightShift(shift) {
  if (!shift?.start_time) return false;
  const h = parseInt(shift.start_time.split(':')[0], 10);
  return h >= 20 || h < 5;
}

// ── ShiftBadge ────────────────────────────────────────────────────────────────
function ShiftBadge({ shift }) {
  if (!shift) return null;
  const { bg, color } = shiftColor(shift);
  const name = shift.name || '';
  return (
    <div style={{
      background: bg, color, borderRadius: 5,
      padding: '2px 6px', fontSize: 10, fontWeight: 600,
      marginTop: 2, lineHeight: 1.3,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>
      {name.length > 8 ? name.slice(0, 7) + '…' : name}
    </div>
  );
}

// ── Shared style objects ──────────────────────────────────────────────────────
const btnStyle = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 8,
  border: '1px solid #e5e7eb', background: '#fff',
  cursor: 'pointer', fontSize: 13, color: '#374151',
};
const navBtnStyle = {
  border: 'none', background: '#f3f4f6',
  borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const labelStyle = {
  fontSize: 12, fontWeight: 600, color: '#374151',
  display: 'block', marginBottom: 5,
};
const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #e5e7eb', fontSize: 14, boxSizing: 'border-box',
};

// ── Main component ────────────────────────────────────────────────────────────
export default function ShiftCalendar() {
  const { user, role } = useAuth();
  const isAdminRole = ['super_admin', 'admin', 'hr'].includes(role);

  const [currentDate, setCurrentDate]       = useState(new Date());
  const [myShift, setMyShift]               = useState(null);
  const [shifts, setShifts]                 = useState([]);
  const [attendanceMap, setAttendanceMap]   = useState({});
  const [holidayMap, setHolidayMap]         = useState({});
  const [loading, setLoading]               = useState(true);
  const [loadError, setLoadError]           = useState(null);
  const [selectedCell, setSelectedCell]     = useState(null);
  const [showSCR, setShowSCR]               = useState(false);
  const [scrForm, setScrForm]               = useState({ date: '', shift_id: '', reason: '' });
  const [scrLoading, setScrLoading]         = useState(false);
  const [scrSuccess, setScrSuccess]         = useState(false);
  // Admin-only: employee selector
  const [employees, setEmployees]           = useState([]);
  const [viewEmpId, setViewEmpId]           = useState(null);

  // Effective employee_id: admin uses viewEmpId; employees use their own
  const effectiveEmpId = isAdminRole ? viewEmpId : (user?.employee_id ?? null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // ── Data loading ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!isAdminRole && !user?.employee_id) return;
    setLoading(true);
    setLoadError(null);

    const month = currentDate.getMonth() + 1;
    const year  = currentDate.getFullYear();

    const baseCalls = [
      api.get(isAdminRole ? '/hr/shifts' : '/attendance/shifts'),
      api.get(isAdminRole ? '/hr/shift-assignments' : '/attendance/my-shift-assignment'),
      api.get('/holidays'),
      isAdminRole ? api.get('/employees') : Promise.resolve(null),
    ];

    const attCall = effectiveEmpId
      ? api.get(`/attendance/employee/${effectiveEmpId}?month=${month}&year=${year}`)
      : Promise.resolve(null);

    const [shiftRes, assignRes, holRes, empRes, attRes] = await Promise.allSettled(
      [...baseCalls, attCall]
    );

    if (!isMounted.current) return;

    const shiftList  = shiftRes.status  === 'fulfilled' ? (shiftRes.value.data  || []) : [];
    const assignList = assignRes.status === 'fulfilled' ? (assignRes.value.data || []) : [];

    setShifts(shiftList);

    if (isAdminRole && empRes.status === 'fulfilled' && empRes.value) {
      const raw = empRes.value.data;
      const list = Array.isArray(raw) ? raw : (raw?.employees || raw?.data || []);
      setEmployees(list);
    }

    const targetId = effectiveEmpId;
    const myAssign = targetId
      ? assignList.find(a => String(a.employee_id) === String(targetId) && a.is_active)
      : null;
    setMyShift(myAssign ? (shiftList.find(s => s.id === myAssign.shift_id) || null) : null);

    if (attRes.status === 'fulfilled' && attRes.value?.data?.records) {
      const map = {};
      attRes.value.data.records.forEach(r => { map[r.date] = r; });
      setAttendanceMap(map);
    } else {
      setAttendanceMap({});
      if (attRes.status === 'rejected') setLoadError('Attendance data unavailable — check API connection.');
    }

    if (holRes.status === 'fulfilled' && Array.isArray(holRes.value.data)) {
      const hmap = {};
      holRes.value.data.forEach(h => {
        const d = h.date?.slice(0, 10);
        if (d) hmap[d] = h.name;
      });
      setHolidayMap(hmap);
    }

    setLoading(false);
  }, [isAdminRole, user?.employee_id, effectiveEmpId, currentDate]);

  useEffect(() => { load(); }, [load]);

  // ── Calendar geometry ───────────────────────────────────────────────────────
  const year        = currentDate.getFullYear();
  const month       = currentDate.getMonth();
  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayYMD    = toYMD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
  const offDows     = parseWeeklyOff(myShift);

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay();
    const ymd = toYMD(year, month + 1, d);
    cells.push({
      d, ymd, dow,
      isOff:       offDows.includes(dow),
      isHoliday:   !!holidayMap[ymd],
      holidayName: holidayMap[ymd] || null,
      att:         attendanceMap[ymd] || null,
      isToday:     ymd === todayYMD,
      isFuture:    ymd > todayYMD,
    });
  }

  // ── KPI calculations ─────────────────────────────────────────────────────────
  const attValues    = Object.values(attendanceMap);
  const kpiPresent   = attValues.filter(r => r.status === 'present').length;
  const kpiLate      = attValues.filter(r => r.status === 'late').length;
  const kpiWFH       = attValues.filter(r => r.status === 'wfh').length;
  const kpiLeave     = attValues.filter(r => ['on_leave','leave'].includes(r.status)).length;
  const pastWorkDays = cells.filter(c => c && !c.isOff && !c.isHoliday && !c.isFuture).length;
  const kpiAbsent    = Math.max(0, pastWorkDays - kpiPresent - kpiLate - kpiWFH - kpiLeave);

  // ── Banner values ─────────────────────────────────────────────────────────────
  const bannerBg    = (myShift?.color && /^#[0-9a-fA-F]{6}$/.test(myShift.color)) ? myShift.color : P;
  const bannerText  = contrastColor(bannerBg);
  const shiftHours  = calcShiftHours(myShift);
  const weeklyOffStr = parseWeeklyOff(myShift).map(d => DAY_NAMES[d]).join(', ') || 'None';
  const shiftTimeStr = myShift
    ? `${(myShift.start_time || '').slice(0, 5)} – ${(myShift.end_time || '').slice(0, 5)}`
    : '—';

  // ── Shift change request helpers ─────────────────────────────────────────────
  const openSCR = (date = todayYMD) => {
    setScrForm({ date, shift_id: '', reason: '' });
    setScrSuccess(false);
    setShowSCR(true);
  };
  const closeSCR = () => {
    setShowSCR(false);
    setScrSuccess(false);
    setScrForm({ date: '', shift_id: '', reason: '' });
  };
  const submitSCR = async () => {
    if (!scrForm.shift_id || !scrForm.date || !scrForm.reason.trim()) return;
    setScrLoading(true);
    try {
      await api.post('/attendance/shift-change-requests', {
        employee_id:        user.employee_id,
        request_date:       scrForm.date,
        current_shift_id:   myShift?.id || null,
        requested_shift_id: parseInt(scrForm.shift_id, 10),
        reason:             scrForm.reason,
      });
      setScrSuccess(true);
      setTimeout(closeSCR, 2000);
    } catch { /* keep modal open for retry */ }
    setScrLoading(false);
  };

  // ── Guard: only block non-admin users who have no employee profile ──────────
  if (!isAdminRole && !user?.employee_id) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: '#6b7280' }}>
        <AlertCircle size={40} color="#ef4444" style={{ margin: '0 auto 12px', display: 'block' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>Employee profile not linked</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          Contact HR to link your account to an employee profile.
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 24, margin: '0 auto' }} id="shift-calendar-root">

      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }} className="no-print">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>
            {isAdminRole ? 'Shift Calendar' : 'My Shift Calendar'}
          </h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            {isAdminRole
              ? 'Select an employee to view their shift schedule and attendance'
              : 'View your shift schedule, working days, and attendance status'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => window.print()} style={btnStyle}>
            <Printer size={13} /> Print
          </button>
          {effectiveEmpId && (
            <button onClick={() => openSCR()} style={btnStyle}>
              <ArrowRightLeft size={13} /> Request Shift Change
            </button>
          )}
          <button onClick={load} style={btnStyle}>
            <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
            Refresh
          </button>
        </div>
      </div>

      {/* Admin employee selector */}
      {isAdminRole && (
        <div style={{ ...CARD, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12 }} className="no-print">
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
            View employee:
          </span>
          <select
            value={viewEmpId ?? ''}
            onChange={e => setViewEmpId(e.target.value ? Number(e.target.value) : null)}
            style={{ ...inputStyle, maxWidth: 320 }}
          >
            <option value="">— Select an employee —</option>
            {employees.map(emp => {
              const name = emp.name || [emp.first_name, emp.last_name].filter(Boolean).join(' ') || `Employee #${emp.id}`;
              return (
                <option key={emp.id} value={emp.id}>
                  {name}{emp.department ? ` · ${emp.department}` : ''}
                </option>
              );
            })}
          </select>
          {viewEmpId && (
            <button
              onClick={() => setViewEmpId(null)}
              style={{ ...btnStyle, padding: '8px 10px', color: '#6b7280' }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {/* Error banner */}
      {loadError && (
        <div style={{ padding: '10px 14px', background: '#fee2e2', color: '#991b1b', borderRadius: 8, fontSize: 13, marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <AlertCircle size={14} /> {loadError}
        </div>
      )}

      {/* Admin: prompt to select an employee when none is chosen */}
      {isAdminRole && !viewEmpId && (
        <div style={{ ...CARD, marginBottom: 20, textAlign: 'center', padding: '32px 24px', color: '#6b7280' }}>
          <Calendar size={36} style={{ margin: '0 auto 12px', display: 'block', color: '#c4b5fd' }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: '#374151' }}>Select an employee above</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            The calendar will show their shift schedule, attendance, and leave overlay.
          </div>
        </div>
      )}

      {/* Shift banner */}
      {(!isAdminRole || viewEmpId) && (
      <div style={{ ...CARD, marginBottom: 20, background: bannerBg, color: bannerText, border: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, flexShrink: 0,
            background: 'rgba(255,255,255,0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {nightShift(myShift) ? <Moon size={24} color={bannerText} /> : <Sun size={24} color={bannerText} />}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {isAdminRole ? 'Assigned Shift' : 'My Assigned Shift'}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>
              {myShift?.name || 'No shift assigned'}
            </div>
            <div style={{ fontSize: 14, opacity: 0.88, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{shiftTimeStr}</span>
              {shiftHours && (
                <span style={{ fontSize: 12, opacity: 0.78, background: 'rgba(255,255,255,0.15)', padding: '1px 8px', borderRadius: 99 }}>
                  {shiftHours} working
                </span>
              )}
              {myShift?.grace_minutes > 0 && (
                <span style={{ fontSize: 12, opacity: 0.72 }}>· {myShift.grace_minutes} min grace</span>
              )}
              {myShift?.break_duration > 0 && (
                <span style={{ fontSize: 12, opacity: 0.72 }}>· {myShift.break_duration} min break</span>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>Weekly Off</div>
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{weeklyOffStr}</div>
            {myShift?.ot_eligible && (
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>OT eligible</div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* All shifts legend */}
      {shifts.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }} className="no-print">
          <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, letterSpacing: 0.3 }}>SHIFTS:</span>
          {shifts.map(s => {
            const { bg, color } = shiftColor(s);
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 99, background: bg, border: `1px solid ${color}30` }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
                <span style={{ color, fontWeight: 600, fontSize: 11 }}>{s.name}</span>
                <span style={{ color: '#9ca3af', fontSize: 11 }}>
                  {(s.start_time || '').slice(0, 5)}&ndash;{(s.end_time || '').slice(0, 5)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Status legend */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20, padding: '10px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #f0f0f4', alignItems: 'center' }}>
        {[
          { dot: '#10b981', label: 'Present'   },
          { dot: '#f59e0b', label: 'Late'      },
          { dot: '#ef4444', label: 'Absent'    },
          { dot: '#3b82f6', label: 'WFH'       },
          { dot: '#8b5cf6', label: 'Leave'     },
          { dot: '#eab308', label: 'Holiday 🏖' },
        ].map(({ dot, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#374151' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
            {label}
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#9ca3af' }}>
          <span style={{ fontWeight: 700, fontSize: 11 }}>OFF</span> Weekly Off
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }} className="no-print">
          Click any day for details
        </div>
      </div>

      {/* Calendar */}
      <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>

        {/* Month navigation */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #f0f0f4' }}>
          <button
            onClick={() => setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
            style={navBtnStyle}
          >
            <ChevronLeft size={16} color="#6b7280" />
          </button>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>
            {MONTH_NAMES[month]} {year}
          </span>
          <button
            onClick={() => setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
            style={navBtnStyle}
          >
            <ChevronRight size={16} color="#6b7280" />
          </button>
        </div>

        {/* Day-of-week headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: '1px solid #f0f0f4' }}>
          {DAY_NAMES.map(d => (
            <div key={d} style={{ padding: '10px 0', textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#9ca3af' }}>
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
          {cells.map((cell, idx) => {
            if (!cell) return (
              <div key={`e-${idx}`} style={{ padding: '12px 8px', minHeight: 70, background: '#fafafa', borderRight: '1px solid #f9fafb', borderBottom: '1px solid #f9fafb' }} />
            );

            const { d, ymd, isOff, isHoliday, holidayName, att, isToday, isFuture } = cell;
            const meta = att ? STATUS_META[att.status] : null;

            let bg = '#fff';
            if      (isHoliday) bg = STATUS_META.holiday.bg;
            else if (isOff)     bg = '#f9fafb';
            else if (meta)      bg = meta.bg;

            return (
              <div
                key={ymd}
                onClick={() => setSelectedCell(cell)}
                style={{
                  padding: '8px 6px', minHeight: 70, background: bg,
                  borderRight: '1px solid #f9fafb', borderBottom: '1px solid #f9fafb',
                  outline: isToday ? `2px solid ${P}` : 'none',
                  outlineOffset: -2,
                  cursor: 'pointer',
                  transition: 'filter 0.1s',
                }}
                onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(0.96)'; }}
                onMouseLeave={e => { e.currentTarget.style.filter = 'none'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 13, fontWeight: isToday ? 800 : 500, color: isOff ? '#d1d5db' : isToday ? P : '#374151' }}>
                    {d}
                  </span>
                  {meta && !isHoliday && (
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: meta.dot, marginTop: 2 }} />
                  )}
                </div>

                {isHoliday ? (
                  <div style={{ fontSize: 9, color: STATUS_META.holiday.text, marginTop: 2, fontWeight: 600, lineHeight: 1.3 }}>
                    {'🏖'} {holidayName && holidayName.length > 8 ? holidayName.slice(0, 7) + '…' : holidayName}
                  </div>
                ) : isOff ? (
                  <div style={{ fontSize: 9, color: '#d1d5db', marginTop: 2, fontWeight: 600 }}>OFF</div>
                ) : myShift ? (
                  <ShiftBadge shift={myShift} />
                ) : null}

                {!isFuture && att && (
                  <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2, lineHeight: 1.4 }}>
                    {att.check_in  && `↑ ${att.check_in}`}
                    {att.check_out && ` ↓ ${att.check_out}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginTop: 20 }}>
        {[
          { label: 'Present', value: kpiPresent, color: '#10b981', sub: 'days on time'        },
          { label: 'Late',    value: kpiLate,    color: '#f59e0b', sub: 'days late in'        },
          { label: 'Absent',  value: kpiAbsent,  color: '#ef4444', sub: 'working days missed' },
          { label: 'WFH',     value: kpiWFH,     color: '#3b82f6', sub: 'days remote'         },
          { label: 'Leave',   value: kpiLeave,   color: '#8b5cf6', sub: 'days on leave'       },
        ].map(s => (
          <div key={s.label} style={{ ...CARD, textAlign: 'center', padding: '14px 10px' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginTop: 4 }}>{s.label}</div>
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Month summary line */}
      <div style={{ textAlign: 'center', marginTop: 10, fontSize: 12, color: '#9ca3af' }}>
        {MONTH_NAMES[month]} {year}
        {' · '}
        {pastWorkDays} working {pastWorkDays === 1 ? 'day' : 'days'} elapsed
        {' (excl. '}
        {cells.filter(c => c && c.isOff && !c.isFuture).length} off
        {(() => {
          const hCount = cells.filter(c => c && c.isHoliday && !c.isFuture).length;
          return hCount > 0 ? ` + ${hCount} holiday${hCount > 1 ? 's' : ''}` : '';
        })()}
        {')'}
      </div>

      {/* Day detail modal */}
      {selectedCell && (
        <DayDetailModal
          cell={selectedCell}
          myShift={myShift}
          onClose={() => setSelectedCell(null)}
          onShiftChange={date => { setSelectedCell(null); openSCR(date); }}
        />
      )}

      {/* Shift change request modal */}
      {showSCR && (
        <ShiftChangeModal
          shifts={shifts}
          myShift={myShift}
          form={scrForm}
          setForm={setScrForm}
          loading={scrLoading}
          success={scrSuccess}
          onSubmit={submitSCR}
          onClose={closeSCR}
        />
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media print {
          .no-print { display: none !important; }
          #shift-calendar-root { padding: 0 !important; max-width: 100% !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}

// ── Day Detail Modal ──────────────────────────────────────────────────────────
function DayDetailModal({ cell, myShift, onClose, onShiftChange }) {
  const { d, ymd, dow, isOff, isHoliday, holidayName, att, isToday, isFuture } = cell;
  const [yr, mo] = ymd.split('-');
  const dateLabel  = `${DAY_FULL[dow]}, ${MONTH_NAMES[parseInt(mo, 10) - 1]} ${d}, ${yr}`;
  const meta       = att ? STATUS_META[att.status] : null;
  const canRegularize = !isFuture && !isOff && !isHoliday && (!att?.check_in || !att?.check_out);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: '#fff', borderRadius: 16, width: 380, maxWidth: '90vw', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{dateLabel}</div>
            {isToday && (
              <span style={{ fontSize: 11, color: P, fontWeight: 600, background: P + '15', padding: '1px 8px', borderRadius: 99, marginTop: 4, display: 'inline-block' }}>
                TODAY
              </span>
            )}
          </div>
          <button onClick={onClose} style={{ border: 'none', background: '#f3f4f6', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex' }}>
            <X size={14} color="#6b7280" />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20 }}>
          {isHoliday ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>{'🏖'}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#854d0e' }}>{holidayName}</div>
              <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>Public Holiday — office closed</div>
            </div>

          ) : isOff ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>{'😴'}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#6b7280' }}>Weekly Off</div>
              {myShift && <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>Shift: {myShift.name}</div>}
            </div>

          ) : isFuture ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>{'📅'}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>Upcoming Working Day</div>
              {myShift && (
                <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>
                  {myShift.name} {'·'} {(myShift.start_time || '').slice(0, 5)} {'–'} {(myShift.end_time || '').slice(0, 5)}
                </div>
              )}
            </div>

          ) : (
            <>
              {/* Status badge */}
              {meta ? (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, background: meta.bg, marginBottom: 16 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: meta.dot }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: meta.text }}>{meta.label}</span>
                </div>
              ) : (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, background: '#fee2e2', marginBottom: 16 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#991b1b' }}>No Record</span>
                </div>
              )}

              {/* Detail grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { icon: <Clock size={11} />,    label: 'Clock In',    value: att?.check_in  || '—' },
                  { icon: <Clock size={11} />,    label: 'Clock Out',   value: att?.check_out || '—' },
                  { icon: <Calendar size={11} />, label: 'Hours Worked',value: att?.hours_worked ? `${att.hours_worked}h` : '—' },
                  { icon: null,                   label: 'Late By',     value: att?.late_minutes > 0 ? `${att.late_minutes} min` : '—' },
                ].map(({ icon, label, value }) => (
                  <div key={label} style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {icon}{label}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 3 }}>{value}</div>
                  </div>
                ))}
              </div>

              {att?.work_mode && att.work_mode !== 'office' && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#1e40af', background: '#dbeafe', padding: '5px 10px', borderRadius: 6, display: 'inline-block' }}>
                  Work mode: {att.work_mode.toUpperCase()}
                </div>
              )}

              {canRegularize && (
                <div style={{ marginTop: 14, padding: '10px 12px', background: '#fef3c7', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
                  Missing {!att?.check_in ? 'clock-in' : 'clock-out'} record — submit a regularization request to correct this.
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer actions */}
        {!isHoliday && !isOff && (
          <div style={{ padding: '12px 20px', borderTop: '1px solid #f0f0f4', display: 'flex', gap: 8 }}>
            {canRegularize && (
              <a
                href="/attendance/regularize"
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, background: '#fff', border: '1px solid #e5e7eb', color: '#374151', fontSize: 13, fontWeight: 500, textAlign: 'center', textDecoration: 'none', display: 'block' }}
              >
                <Edit3 size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                Regularize
              </a>
            )}
            <button
              onClick={() => onShiftChange(ymd)}
              style={{ flex: 1, padding: '9px 0', borderRadius: 8, background: P, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              <ArrowRightLeft size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
              Shift Change
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shift Change Request Modal ────────────────────────────────────────────────
function ShiftChangeModal({ shifts, myShift, form, setForm, loading, success, onSubmit, onClose }) {
  const available = shifts.filter(s => s.id !== myShift?.id);
  const canSubmit = form.shift_id && form.date && form.reason.trim();

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: '#fff', borderRadius: 16, width: 440, maxWidth: '92vw', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>Request Shift Change</div>
          <button onClick={onClose} style={{ border: 'none', background: '#f3f4f6', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex' }}>
            <X size={14} color="#6b7280" />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {success ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <CheckCircle2 size={44} color="#10b981" style={{ margin: '0 auto 12px', display: 'block' }} />
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Request Submitted</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>Your manager will review it shortly.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelStyle}>For Date *</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Current Shift</label>
                <div style={{ ...inputStyle, background: '#f9fafb', color: '#6b7280' }}>
                  {myShift
                    ? `${myShift.name}  (${(myShift.start_time || '').slice(0, 5)} – ${(myShift.end_time || '').slice(0, 5)})`
                    : 'No shift assigned'}
                </div>
              </div>
              <div>
                <label style={labelStyle}>Requested Shift *</label>
                {available.length === 0 ? (
                  <div style={{ ...inputStyle, background: '#f9fafb', color: '#9ca3af' }}>
                    No other shifts available — create shifts in HR {'→'} Shift Management
                  </div>
                ) : (
                  <select
                    value={form.shift_id}
                    onChange={e => setForm(f => ({ ...f, shift_id: e.target.value }))}
                    style={{ ...inputStyle, background: '#fff' }}
                  >
                    <option value="">— Select a shift —</option>
                    {available.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name}  ({(s.start_time || '').slice(0, 5)} {'–'} {(s.end_time || '').slice(0, 5)})
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label style={labelStyle}>Reason *</label>
                <textarea
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  rows={3}
                  placeholder="Explain why you need this shift change…"
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={onClose}
                  style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={onSubmit}
                  disabled={loading || !canSubmit}
                  style={{
                    flex: 1, padding: '10px 0', borderRadius: 8, border: 'none',
                    background: canSubmit ? P : '#c4b5fd',
                    color: '#fff', fontSize: 14, fontWeight: 600,
                    cursor: canSubmit ? 'pointer' : 'not-allowed',
                    transition: 'background 0.15s',
                  }}
                >
                  {loading ? 'Submitting…' : 'Submit Request'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
