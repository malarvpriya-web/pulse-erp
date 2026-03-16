import React, { useState, useEffect, useCallback } from 'react';
import {
  Clock,
  CheckCircle,
  X,
  Calendar,
  LogIn,
  LogOut,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  FileEdit,
  RefreshCw
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './AttendanceDashboard.css';

// ─── helpers ────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

const formatTime12 = (date) => {
  let h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${pad(h)}:${pad(m)}:${pad(s)} ${ampm}`;
};

const formatTime12Short = (date) => {
  let h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${pad(h)}:${pad(m)} ${ampm}`;
};

const toYMD = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_COLORS = {
  present:  { bg: '#dcfce7', text: '#166534', dot: '#16a34a' },
  absent:   { bg: '#fee2e2', text: '#991b1b', dot: '#dc2626' },
  late:     { bg: '#fef3c7', text: '#92400e', dot: '#d97706' },
  leave:    { bg: '#dbeafe', text: '#1e40af', dot: '#3b82f6' },
  holiday:  { bg: '#ede9fe', text: '#5b21b6', dot: '#8b5cf6' },
  weekend:  { bg: '#f9fafb', text: '#9ca3af', dot: '#d1d5db' },
  future:   { bg: '#ffffff', text: '#d1d5db', dot: '#e5e7eb' },
};

const STATUS_ICON_COLOR = {
  present: '#10b981',
  absent:  '#ef4444',
  late:    '#f59e0b',
  leave:   '#3b82f6',
  holiday: '#8b5cf6',
  weekend: '#9ca3af',
};

// ─── sample / fallback data generators ──────────────────────────────────────

const buildSampleCalendar = (year, month) => {
  const result = {};
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayYMD = toYMD(today);

  // fixed holiday days (1-indexed)
  const holidays = [15, 26];

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const ymd = toYMD(date);
    const dow = date.getDay(); // 0=Sun, 6=Sat

    if (ymd > todayYMD) {
      result[ymd] = 'future';
      continue;
    }
    if (dow === 0 || dow === 6) {
      result[ymd] = 'weekend';
      continue;
    }
    if (holidays.includes(d)) {
      result[ymd] = 'holiday';
      continue;
    }

    // deterministic pseudo-random distribution
    const seed = d % 10;
    if (seed === 3) result[ymd] = 'absent';
    else if (seed === 7 || seed === 9) result[ymd] = 'late';
    else if (seed === 5) result[ymd] = 'leave';
    else result[ymd] = 'present';
  }
  return result;
};

const buildSampleLast7 = () => {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    let status = 'present';
    if (dow === 0 || dow === 6) status = 'weekend';
    else if (i === 5) status = 'late';
    else if (i === 3) status = 'absent';
    days.push({
      date: toYMD(d),
      status,
      check_in: status === 'present' ? '09:10 AM' : status === 'late' ? '10:22 AM' : null,
      check_out: (status === 'present' || status === 'late') ? '06:05 PM' : null,
    });
  }
  return days;
};

// ─── Toast helper ────────────────────────────────────────────────────────────

let _setToastGlobal = null;
const showToast = (message, type = 'success') => {
  if (_setToastGlobal) _setToastGlobal({ message, type, id: Date.now() });
};

// ─── Main component ──────────────────────────────────────────────────────────

const AttendanceDashboard = () => {
  const { user } = useAuth();

  // ── state ──────────────────────────────────────────────────────────────────
  const [currentDate, setCurrentDate]       = useState(new Date());
  const [attendanceData, setAttendanceData] = useState({});
  const [todayStatus, setTodayStatus]       = useState(null);
  const [monthlySummary, setMonthlySummary] = useState(null);
  const [last7Days, setLast7Days]           = useState([]);
  const [showRegForm, setShowRegForm]       = useState(false);
  const [regForm, setRegForm]               = useState({ date: '', reason: '', check_in: '', check_out: '' });
  const [clocking, setClocking]             = useState(false);
  const [loading, setLoading]               = useState(false);
  const [liveTime, setLiveTime]             = useState(new Date());
  const [toast, setToast]                   = useState(null);

  _setToastGlobal = setToast;

  // ── live clock ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setLiveTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── auto-dismiss toast ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ── data loading ───────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);

    const month = currentDate.getMonth() + 1;
    const year  = currentDate.getFullYear();

    const [monthRes, todayRes] = await Promise.allSettled([
      api.get(`/attendance/employee/${user.id}?month=${month}&year=${year}`),
      api.get(`/attendance/today/${user.id}`),
    ]);

    // ── today status ───────────────────────────────────────────────────────
    if (todayRes.status === 'fulfilled' && todayRes.value?.data) {
      setTodayStatus(todayRes.value.data);
    } else {
      setTodayStatus({ status: 'present', check_in: '09:08 AM', check_out: null, hours_worked: null });
    }

    // ── monthly data ───────────────────────────────────────────────────────
    if (monthRes.status === 'fulfilled' && monthRes.value?.data) {
      const raw = monthRes.value.data;

      // build attendanceData map
      const map = {};
      (raw.records || []).forEach((r) => {
        map[r.date] = r.status;
      });
      setAttendanceData(map);

      // summary
      if (raw.summary) {
        setMonthlySummary(raw.summary);
      } else {
        setMonthlySummary({ present: 14, absent: 1, late: 2, leave: 1, holidays: 2, percentage: 87.5 });
      }

      // last 7 days
      if (raw.last7Days) {
        setLast7Days(raw.last7Days);
      } else {
        setLast7Days(buildSampleLast7());
      }
    } else {
      // full sample fallback
      setAttendanceData(buildSampleCalendar(year, currentDate.getMonth()));
      setMonthlySummary({ present: 14, absent: 1, late: 2, leave: 1, holidays: 2, percentage: 87.5 });
      setLast7Days(buildSampleLast7());
    }

    setLoading(false);
  }, [user?.id, currentDate]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── month navigation ───────────────────────────────────────────────────────
  const prevMonth = () => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  };
  const nextMonth = () => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  };

  // ── clock in / out ─────────────────────────────────────────────────────────
  const handleClockAction = async () => {
    if (clocking) return;
    setClocking(true);

    const isIn = !todayStatus?.check_in;
    const timeStr = formatTime12Short(new Date());

    // optimistic update
    setTodayStatus((prev) => ({
      ...prev,
      status: 'present',
      check_in: isIn ? timeStr : prev?.check_in,
      check_out: !isIn ? timeStr : prev?.check_out,
    }));

    try {
      await api.post('/attendance/clock', {
        employee_id: user?.id,
        action: isIn ? 'in' : 'out',
        time: timeStr,
      });
      showToast(isIn ? `Clocked in at ${timeStr}` : `Clocked out at ${timeStr}`, 'success');
    } catch {
      showToast('Failed to record. Showing local time.', 'error');
    }
    setClocking(false);
  };

  // ── regularisation submit ──────────────────────────────────────────────────
  const handleRegSubmit = async (e) => {
    e.preventDefault();
    if (!regForm.reason.trim()) {
      showToast('Please enter a reason.', 'error');
      return;
    }
    try {
      await api.post('/attendance/regularize', {
        employee_id: user?.id,
        ...regForm,
      });
      showToast('Regularization request submitted.', 'success');
      setShowRegForm(false);
      setRegForm({ date: '', reason: '', check_in: '', check_out: '' });
    } catch {
      showToast('Failed to submit. Please try again.', 'error');
    }
  };

  const openRegDrawer = (dateStr) => {
    setRegForm({ date: dateStr, reason: '', check_in: '', check_out: '' });
    setShowRegForm(true);
  };

  // ── calendar grid building ─────────────────────────────────────────────────
  const buildCalendarCells = () => {
    const year  = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayYMD = toYMD(new Date());
    const cells = [];

    for (let i = 0; i < firstDow; i++) cells.push(null);

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const ymd  = toYMD(date);
      const status = attendanceData[ymd] || (ymd > todayYMD ? 'future' : 'absent');
      cells.push({ day: d, ymd, status, isToday: ymd === todayYMD });
    }
    return cells;
  };

  const calCells = buildCalendarCells();

  // ── derived today info ─────────────────────────────────────────────────────
  const todayCIN  = todayStatus?.check_in  || '--';
  const todayCOUT = todayStatus?.check_out || '--';
  const todayHrs  = (() => {
    if (todayStatus?.hours_worked) return `${todayStatus.hours_worked}h`;
    if (todayStatus?.check_in && todayStatus?.check_out) {
      const parseT = (str) => {
        const [time, ampm] = str.split(' ');
        let [h, m] = time.split(':').map(Number);
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + m;
      };
      const diff = parseT(todayStatus.check_out) - parseT(todayStatus.check_in);
      if (diff > 0) return `${Math.floor(diff / 60)}h ${diff % 60}m`;
    }
    return '--';
  })();

  const todayStatusKey = todayStatus?.status || 'absent';
  const statusLabels = {
    present: 'Present',
    absent:  'Absent',
    late:    'Late Arrival',
    leave:   'On Leave',
    holiday: 'Holiday',
    weekend: 'Weekend',
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="atd-root">

      {/* ── Toast ── */}
      {toast && (
        <div
          className="atd-toast"
          style={toast.type === 'error' ? { borderLeftColor: '#ef4444', color: '#991b1b' } : {}}
        >
          {toast.type === 'error'
            ? <AlertCircle size={16} color="#ef4444" />
            : <CheckCircle size={16} color="#10b981" />}
          <span>{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginLeft: 8, display: 'flex' }}
          >
            <X size={14} color="#9ca3af" />
          </button>
        </div>
      )}

      {/* ── Header ── */}
      <div className="atd-header">
        <h1 className="atd-title">My Attendance</h1>

        <div className="atd-nav">
          <button className="atd-nav-btn" onClick={prevMonth} title="Previous month">
            <ChevronLeft size={16} />
          </button>
          <span className="atd-month">
            {MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}
          </span>
          <button className="atd-nav-btn" onClick={nextMonth} title="Next month">
            <ChevronRight size={16} />
          </button>
          <button
            className="atd-icon-btn"
            onClick={loadData}
            title="Refresh"
            style={loading ? { opacity: 0.5 } : {}}
            disabled={loading}
          >
            <RefreshCw size={15} style={loading ? { animation: 'atd-spin 1s linear infinite' } : {}} />
          </button>
        </div>
      </div>

      {/* ── Top row: Clock card + Summary ── */}
      <div className="atd-top-row">

        {/* Clock In/Out card */}
        <div className="atd-card">
          <div className="atd-card-hd">
            <span className="atd-card-title">Today&apos;s Attendance</span>
            <Clock size={16} color="#9ca3af" />
          </div>
          <div className="atd-card-body">
            <div className="atd-clock-time">{formatTime12(liveTime)}</div>
            <div className="atd-clock-date">
              {liveTime.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </div>

            {/* status badge */}
            <div
              className="atd-status-big"
              style={{
                background: STATUS_COLORS[todayStatusKey]?.bg || '#f3f4f6',
                color:      STATUS_COLORS[todayStatusKey]?.text || '#374151',
              }}
            >
              {todayStatusKey === 'present' && <CheckCircle size={15} />}
              {todayStatusKey === 'absent'  && <AlertCircle size={15} />}
              {todayStatusKey === 'late'    && <Clock size={15} />}
              {todayStatusKey === 'leave'   && <Calendar size={15} />}
              {statusLabels[todayStatusKey] || todayStatusKey}
            </div>

            {/* check-in / check-out / hours */}
            <div className="atd-time-row">
              <div className="atd-time-item">
                <span className="atd-time-label">Check In</span>
                <span className="atd-time-val">{todayCIN}</span>
              </div>
              <div className="atd-time-item">
                <span className="atd-time-label">Check Out</span>
                <span className="atd-time-val">{todayCOUT}</span>
              </div>
              <div className="atd-time-item">
                <span className="atd-time-label">Hours</span>
                <span className="atd-time-val">{todayHrs}</span>
              </div>
            </div>

            {/* clock button */}
            {!todayStatus?.check_in ? (
              <button
                className="atd-clock-btn atd-clock-btn-in"
                onClick={handleClockAction}
                disabled={clocking}
              >
                <LogIn size={16} />
                {clocking ? 'Processing…' : 'Clock In'}
              </button>
            ) : !todayStatus?.check_out ? (
              <button
                className="atd-clock-btn atd-clock-btn-out"
                onClick={handleClockAction}
                disabled={clocking}
              >
                <LogOut size={16} />
                {clocking ? 'Processing…' : 'Clock Out'}
              </button>
            ) : (
              <button className="atd-clock-btn" style={{ background: '#f3f4f6', color: '#9ca3af', cursor: 'default' }} disabled>
                <CheckCircle size={16} />
                Day Complete
              </button>
            )}
          </div>
        </div>

        {/* Monthly summary */}
        <div className="atd-card">
          <div className="atd-card-hd">
            <span className="atd-card-title">
              Monthly Summary — {MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}
            </span>
            <Calendar size={16} color="#9ca3af" />
          </div>
          <div className="atd-card-body">
            {monthlySummary ? (
              <div className="atd-summary-grid">
                {/* Present */}
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#dcfce7' }}>
                    <CheckCircle size={17} color="#10b981" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.present ?? 0}</div>
                    <div className="atd-stat-lbl">Present</div>
                  </div>
                </div>
                {/* Absent */}
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#fee2e2' }}>
                    <AlertCircle size={17} color="#ef4444" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.absent ?? 0}</div>
                    <div className="atd-stat-lbl">Absent</div>
                  </div>
                </div>
                {/* Late */}
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#fef3c7' }}>
                    <Clock size={17} color="#f59e0b" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.late ?? 0}</div>
                    <div className="atd-stat-lbl">Late</div>
                  </div>
                </div>
                {/* On Leave */}
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#dbeafe' }}>
                    <Calendar size={17} color="#3b82f6" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.leave ?? 0}</div>
                    <div className="atd-stat-lbl">On Leave</div>
                  </div>
                </div>
                {/* Holidays */}
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#ede9fe' }}>
                    <X size={17} color="#8b5cf6" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.holidays ?? 0}</div>
                    <div className="atd-stat-lbl">Holidays</div>
                  </div>
                </div>
                {/* Attendance % */}
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#ecfdf5' }}>
                    <CheckCircle size={17} color="#059669" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.percentage ?? 0}%</div>
                    <div className="atd-stat-lbl">Attendance %</div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ color: '#9ca3af', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                Loading summary…
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Monthly Calendar ── */}
      <div className="atd-cal-card">
        <div className="atd-card-hd">
          <span className="atd-card-title">Monthly Calendar</span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>Click a past date to request regularization</span>
        </div>

        {/* Day headers */}
        <div className="atd-cal-header">
          {DAY_NAMES.map((d) => (
            <div key={d} className="atd-cal-day-header">{d}</div>
          ))}
        </div>

        {/* Day cells */}
        <div className="atd-cal-grid">
          {calCells.map((cell, idx) => {
            if (!cell) {
              return <div key={`empty-${idx}`} className="atd-cal-day atd-cal-empty" />;
            }
            const { day, ymd, status, isToday } = cell;
            const colors = STATUS_COLORS[status] || STATUS_COLORS.future;
            const isPast = ymd <= toYMD(new Date()) && status !== 'future';
            const isWeekendOrHoliday = status === 'weekend' || status === 'holiday' || status === 'future';

            return (
              <div
                key={ymd}
                className={`atd-cal-day${isToday ? ' atd-cal-today' : ''}`}
                style={{ background: colors.bg, color: colors.text }}
                onClick={() => {
                  if (isPast && !isWeekendOrHoliday) openRegDrawer(ymd);
                }}
                title={isPast && !isWeekendOrHoliday ? `Regularize ${ymd}` : undefined}
              >
                <span style={{ fontWeight: isToday ? 700 : 500 }}>{day}</span>
                {status !== 'future' && (
                  <span
                    style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: colors.dot, marginTop: 2,
                      display: 'inline-block'
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="atd-cal-legend">
          {Object.entries(STATUS_COLORS)
            .filter(([k]) => k !== 'future')
            .map(([key, val]) => (
              <div key={key} className="atd-legend-item">
                <span className="atd-legend-dot" style={{ background: val.dot }} />
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </div>
            ))}
        </div>
      </div>

      {/* ── Last 7 Days ── */}
      <div className="atd-card" style={{ marginBottom: 20 }}>
        <div className="atd-card-hd">
          <span className="atd-card-title">Last 7 Days</span>
        </div>
        <div className="atd-card-body">
          <div className="atd-7days">
            {last7Days.map((item) => {
              const d    = new Date(item.date + 'T00:00:00');
              const colors = STATUS_COLORS[item.status] || STATUS_COLORS.future;
              return (
                <div
                  key={item.date}
                  className="atd-day-card"
                  onClick={() => {
                    const skip = item.status === 'weekend' || item.status === 'holiday';
                    if (!skip) openRegDrawer(item.date);
                  }}
                >
                  <div className="atd-day-name">{DAY_NAMES[d.getDay()]}</div>
                  <div className="atd-day-num">{d.getDate()}</div>
                  <span
                    className="atd-day-badge"
                    style={{ background: colors.bg, color: colors.text }}
                  >
                    {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Regularization Drawer ── */}
      {showRegForm && (
        <>
          <div className="atd-overlay" onClick={() => setShowRegForm(false)} />
          <div className="atd-drawer">
            <div className="atd-drawer-hd">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <FileEdit size={18} color="#6366f1" />
                <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>
                  Regularization Request
                </span>
              </div>
              <button className="atd-icon-btn" onClick={() => setShowRegForm(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="atd-drawer-body">
              <form id="reg-form" onSubmit={handleRegSubmit}>
                <div className="atd-form-group">
                  <label className="atd-label">Date</label>
                  <input
                    className="atd-input"
                    type="date"
                    value={regForm.date}
                    readOnly
                    style={{ background: '#f9fafb', color: '#6b7280', cursor: 'default' }}
                  />
                </div>

                <div className="atd-form-group">
                  <label className="atd-label">Check In Time</label>
                  <input
                    className="atd-input"
                    type="time"
                    value={regForm.check_in}
                    onChange={(e) => setRegForm({ ...regForm, check_in: e.target.value })}
                    placeholder="HH:MM"
                  />
                </div>

                <div className="atd-form-group">
                  <label className="atd-label">Check Out Time</label>
                  <input
                    className="atd-input"
                    type="time"
                    value={regForm.check_out}
                    onChange={(e) => setRegForm({ ...regForm, check_out: e.target.value })}
                    placeholder="HH:MM"
                  />
                </div>

                <div className="atd-form-group">
                  <label className="atd-label">Reason <span style={{ color: '#ef4444' }}>*</span></label>
                  <textarea
                    className="atd-textarea"
                    rows={4}
                    value={regForm.reason}
                    onChange={(e) => setRegForm({ ...regForm, reason: e.target.value })}
                    placeholder="Explain why you need to regularize attendance for this date…"
                    required
                  />
                </div>

                <div
                  style={{
                    background: '#fffbeb', border: '1px solid #fde68a',
                    borderRadius: 8, padding: '10px 14px',
                    fontSize: 12, color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start'
                  }}
                >
                  <AlertCircle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span>
                    Regularization requests are subject to manager approval.
                    You will be notified once reviewed.
                  </span>
                </div>
              </form>
            </div>

            <div className="atd-drawer-footer">
              <button className="atd-btn-ghost" onClick={() => setShowRegForm(false)}>
                Cancel
              </button>
              <button className="atd-btn-primary" type="submit" form="reg-form">
                Submit Request
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default AttendanceDashboard;
