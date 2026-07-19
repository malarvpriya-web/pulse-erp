import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Calendar, Clock, CheckCircle, FileText, Bell, Briefcase,
  X, ChevronRight, ArrowRight, LogIn, LogOut, Gift,
  Star, RefreshCw, Users, ListChecks, AlertTriangle, Camera,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '../services/api/client';
import MyPayslipsWidget from '@/components/dashboard/widgets/MyPayslipsWidget';
import FaceClockModal, { getLocationString } from '@/components/attendance/FaceClockModal';
import { VizCard, Donut, DonutLegend, ProgressRing, RoundBars } from '@/components/charts/PulseViz';
import CelebrationsBoard from '@/components/dashboard/CelebrationsBoard';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './EmployeeDashboard.css';

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDateIN() {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function calcWorkingDays(from, to) {
  if (!from || !to) return 0;
  const start = new Date(from);
  const end   = new Date(to);
  if (end < start) return 0;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function formatINR(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(amount);
}

function weatherEmoji(desc) {
  const d = (desc || '').toLowerCase();
  if (d.includes('sunny') || d.includes('clear')) return '☀️';
  if (d.includes('partly cloudy')) return '⛅';
  if (d.includes('overcast') || d.includes('cloudy')) return '☁️';
  if (d.includes('rain') || d.includes('drizzle') || d.includes('shower')) return '🌧️';
  if (d.includes('thunder') || d.includes('storm')) return '⛈️';
  if (d.includes('snow') || d.includes('blizzard')) return '❄️';
  if (d.includes('fog') || d.includes('mist') || d.includes('haze')) return '🌫️';
  return '🌡️';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ message, type = 'success', onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className={`ed-toast ed-toast-${type}`}>
      <CheckCircle size={16} />
      <span>{message}</span>
      <button className="ed-icon-btn" style={{ marginLeft: 8 }} onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

// ─── Leave conflict checker ───────────────────────────────────────────────────
function checkLeaveConflict(form, existingLeaves, holidays) {
  if (!form.fromDate || !form.toDate) return null;
  const from = new Date(form.fromDate);
  const to   = new Date(form.toDate);
  if (to < from) return 'End date must be on or after start date';

  for (const leave of existingLeaves) {
    const st = (leave.status || '').toLowerCase();
    if (!['approved', 'pending'].includes(st)) continue;
    const lFrom = new Date(leave.from_date || leave.start_date || leave.fromDate);
    const lTo   = new Date(leave.to_date   || leave.end_date   || leave.toDate);
    if (from <= lTo && to >= lFrom) {
      const type  = leave.leave_type || leave.leaveType || '';
      const label = type ? `${type} leave` : `a ${st} leave`;
      return `Overlaps with ${label} (${leave.from_date || leave.start_date} → ${leave.to_date || leave.end_date})`;
    }
  }

  const holidaySet = new Map((holidays || []).map(h => [h.date, h.name]));
  const cur = new Date(from);
  while (cur <= to) {
    const dow     = cur.getDay();
    const dateStr = cur.toISOString().split('T')[0];
    if (dow !== 0 && dow !== 6 && holidaySet.has(dateStr)) {
      return `${holidaySet.get(dateStr)} is a public holiday within this range`;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}

// ─── Apply Leave Drawer ───────────────────────────────────────────────────────
function ApplyLeaveDrawer({ open, onClose, onSubmit, submitting = false, existingLeaves = [], holidays = [] }) {
  const [form, setForm] = useState({
    leaveType: 'Annual', fromDate: '', toDate: '', reason: '',
  });
  const [days,     setDays]     = useState(0);
  const [conflict, setConflict] = useState(null);

  useEffect(() => {
    setDays(form.fromDate && form.toDate ? calcWorkingDays(form.fromDate, form.toDate) : 0);
    setConflict(checkLeaveConflict(form, existingLeaves, holidays));
  }, [form.fromDate, form.toDate, existingLeaves, holidays]);

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (conflict) return;
    onSubmit(form);
  }

  if (!open) return null;

  return (
    <>
      <div className="ed-overlay" onClick={onClose} />
      <div className="ed-drawer" role="dialog" aria-modal="true" aria-label="Apply Leave">
        <div className="ed-drawer-hd">
          <span style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>Apply Leave</span>
          <button className="ed-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <form className="ed-drawer-body" onSubmit={handleSubmit}>
          <div className="ed-form-group">
            <label className="ed-label" htmlFor="leaveType">Leave Type</label>
            <select id="leaveType" name="leaveType" className="ed-select"
              value={form.leaveType} onChange={handleChange} required>
              <option value="Annual">Annual Leave</option>
              <option value="Sick">Sick Leave</option>
              <option value="Casual">Casual Leave</option>
              <option value="Compensatory">Compensatory Leave</option>
            </select>
          </div>
          <div className="ed-form-group">
            <label className="ed-label" htmlFor="fromDate">From Date</label>
            <input id="fromDate" name="fromDate" type="date" className="ed-input"
              value={form.fromDate} onChange={handleChange} required />
          </div>
          <div className="ed-form-group">
            <label className="ed-label" htmlFor="toDate">To Date</label>
            <input id="toDate" name="toDate" type="date" className="ed-input"
              value={form.toDate} onChange={handleChange} required />
            {days > 0 && !conflict && (
              <div className="ed-days-calc">{days} working day{days !== 1 ? 's' : ''}</div>
            )}
            {conflict && (
              <div className="ed-conflict-error">
                <AlertTriangle size={13} />
                {conflict}
              </div>
            )}
          </div>
          <div className="ed-form-group">
            <label className="ed-label" htmlFor="reason">Reason</label>
            <textarea id="reason" name="reason" className="ed-textarea" rows={4}
              placeholder="Briefly describe the reason for leave..."
              value={form.reason} onChange={handleChange} required />
          </div>
          <div className="ed-drawer-footer" style={{ padding: 0, marginTop: 8, border: 'none' }}>
            <button type="button" className="ed-btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="ed-btn-primary" disabled={!!conflict || submitting}
              title={conflict || undefined}>
              {submitting ? 'Submitting...' : 'Submit Application'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────
function Shimmer({ width = '100%' }) {
  return (
    <div style={{
      height: 14, borderRadius: 6, width,
      background: 'linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%)',
      backgroundSize: '200% 100%',
      animation: 'ed-shimmer 1.4s infinite',
    }} />
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({ icon, message }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 16px', color: '#9ca3af', gap: 8,
    }}>
      <span style={{ fontSize: 28 }}>{icon}</span>
      <p style={{ margin: 0, fontSize: 13 }}>{message}</p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function EmployeeDashboard({ setPage }) {
  const { user, hasPermission, role } = useAuth();

  const [attendance,    setAttendance]    = useState(null);
  const [empProfile,    setEmpProfile]    = useState(null);
  const [leaveBalance,  setLeaveBalance]  = useState(null);
  const [pendingTasks,  setPendingTasks]  = useState(0);
  const [todayTasks,    setTodayTasks]    = useState([]);
  const [latestPayslip, setLatestPayslip] = useState(null);
  const [announcements, setAnnouncements] = useState([]);
  const [holidays,      setHolidays]      = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [refreshing,    setRefreshing]    = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // New feature state
  const [teamOnLeave,  setTeamOnLeave]  = useState([]);
  const [notifCount,   setNotifCount]   = useState(0);
  const [weather,      setWeather]      = useState(null);
  const [clockLoading,      setClockLoading]      = useState(false);
  const [currentTime,       setCurrentTime]       = useState(new Date());
  const [myLeaves,          setMyLeaves]          = useState([]);
  const [recentTimesheets,  setRecentTimesheets]  = useState([]);
  const [leaveSubmitting,   setLeaveSubmitting]   = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [faceOpen,   setFaceOpen]   = useState(false);
  const [toast,      setToast]      = useState(null);

  const isInitial = useRef(true);

  // Live clock — ticks every second
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const showToast    = useCallback((message, type = 'success') => setToast({ message, type }), []);
  const dismissToast = useCallback(() => setToast(null), []);

  const canAddLeave = hasPermission('leaves', 'add') || hasPermission('leave', 'add') || role === 'employee';

  function normalizeAttendance(record) {
    if (!record) return null;
    return {
      ...record,
      check_in: record.check_in ?? record.check_in_time ?? null,
      check_out: record.check_out ?? record.check_out_time ?? null,
    };
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (isInitial.current) setLoading(true); else setRefreshing(true);

    const empId = user?.employee_id;
    const [
      attendRes, leaveRes, tasksRes, annRes, holRes,
      payRes, teamLeaveRes, notifRes, weatherRes,
      myLeavesRes, tsRes, empRes,
    ] = await Promise.allSettled([
      empId ? api.get(`/attendance/today/${empId}`) : Promise.resolve(null),
      api.get('/leaves/balance'),
      api.get('/tasks/today'),
      api.get('/announcements/active'),
      api.get('/holidays'),
      empId ? api.get(`/payroll/employee/${empId}`) : Promise.resolve(null),
      api.get('/leaves/team'),
      api.get('/notifications/unread-count'),
      fetch('https://wttr.in/?format=j1').then(r => r.json()),
      empId ? api.get('/leaves/applications', { params: { employee_id: empId } }) : Promise.resolve(null),
      empId ? api.get('/timesheets/timesheets', { params: { employee_id: empId, limit: 5 } }) : Promise.resolve(null),
      empId ? api.get(`/employees/${empId}`) : Promise.resolve(null),
    ]);

    // Employee profile — department, designation, date of joining
    if (empRes.status === 'fulfilled' && empRes.value?.data) {
      const raw = empRes.value.data?.employee || empRes.value.data;
      if (raw && typeof raw === 'object') setEmpProfile(raw);
    }

    // Attendance
    if (attendRes.status === 'fulfilled' && attendRes.value?.data) {
      const data = attendRes.value.data;
      const myRecord = Array.isArray(data)
        ? (data.find(r => r.user_id === empId || r.employee_id === empId) ?? null)
        : data;
      setAttendance(normalizeAttendance(myRecord));
    }

    if (leaveRes.status === 'fulfilled' && leaveRes.value?.data)
      setLeaveBalance(leaveRes.value.data);

    // /tasks/today returns {success:true, data:[...tasks]}
    if (tasksRes.status === 'fulfilled') {
      const raw = tasksRes.value?.data;
      const taskArray = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
      setTodayTasks(taskArray);
      setPendingTasks(taskArray.filter(t => t.status !== 'done' && t.status !== 'completed').length);
    }

    if (annRes.status === 'fulfilled' && Array.isArray(annRes.value?.data))
      setAnnouncements(annRes.value.data);

    if (holRes.status === 'fulfilled' && Array.isArray(holRes.value?.data))
      setHolidays(holRes.value.data);

    if (payRes.status === 'fulfilled' && payRes.value?.data)
      setLatestPayslip(payRes.value.data);

    // Team leaves — filter for today's date range
    if (teamLeaveRes.status === 'fulfilled') {
      const raw = teamLeaveRes.value?.data;
      const allLeaves = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
      const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
      const onLeave = allLeaves.filter(l => {
        const from = new Date(l.from_date); from.setHours(0, 0, 0, 0);
        const to   = new Date(l.to_date);   to.setHours(0, 0, 0, 0);
        return todayDate >= from && todayDate <= to
          && ['approved', 'active'].includes((l.status || '').toLowerCase());
      });
      setTeamOnLeave(onLeave);
    }

    // Notification unread count
    if (notifRes.status === 'fulfilled')
      setNotifCount(notifRes.value?.data?.count ?? 0);

    // Weather — native fetch, value is the parsed JSON (no .data wrapper)
    if (weatherRes.status === 'fulfilled' && weatherRes.value?.current_condition) {
      const cond = weatherRes.value.current_condition[0];
      const area = weatherRes.value.nearest_area?.[0];
      setWeather({
        temp:     cond.temp_C,
        feelsLike: cond.FeelsLikeC,
        desc:     cond.weatherDesc?.[0]?.value || '',
        humidity: cond.humidity,
        city:     area?.areaName?.[0]?.value || '',
      });
    }

    // My leaves (for conflict detection in leave drawer)
    if (myLeavesRes.status === 'fulfilled' && myLeavesRes.value?.data) {
      const raw = myLeavesRes.value.data;
      setMyLeaves(Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []));
    }

    // Recent timesheets
    if (tsRes.status === 'fulfilled' && tsRes.value?.data) {
      const raw = tsRes.value.data;
      setRecentTimesheets(Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []));
    }

    isInitial.current = false;
    setLoading(false);
    setRefreshing(false);
    setLastRefreshed(new Date());
  }, [user]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    loadData();
    const id = setInterval(loadData, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [loadData]);

  // ── Clock-in / Clock-out ──────────────────────────────────────────────────
  async function handleClockAction(faceData = null) {
    if (!user?.employee_id) {
      showToast('Your login is not linked to an employee record — ask HR to link your account to an employee profile.', 'error');
      return;
    }
    setClockLoading(true);
    try {
      const now = new Date().toTimeString().slice(0, 5); // "HH:MM"
      const isClockIn = !attendance?.check_in;
      // Location is server-enforced for clock-in when a mandatory geo-fence exists
      const location = isClockIn ? await getLocationString() : null;
      const { data } = await api.post('/attendance/clock', {
        employee_id:     user?.employee_id,
        action:          isClockIn ? 'in' : 'out',
        time:            now,
        ...(location ? { location } : {}),
        ...(faceData?.face_token ? { face_token: faceData.face_token } : {}),
      });
      setAttendance(normalizeAttendance(data));
      showToast(isClockIn ? 'Clocked in successfully!' : 'Clocked out successfully!');
      loadData();
    } catch (error) {
      console.error('[EmployeeDashboard] Attendance action failed', error);
      showToast(error.response?.data?.message || error.response?.data?.error || 'Failed to record attendance', 'error');
    } finally {
      setClockLoading(false);
    }
  }

  // ── Permission-gated quick actions ────────────────────────────────────────
  const quickActions = [
    {
      id:     'leave',
      label:  'Apply Leave',
      sub:    'Submit a leave request',
      color:  '#6366f1',
      Icon:   Calendar,
      show:   () => canAddLeave,
      action: () => setDrawerOpen(true),
    },
    {
      id:     'timesheet',
      label:  'Submit Timesheet',
      sub:    'Log your work hours',
      color:  '#10b981',
      Icon:   Clock,
      show:   () => hasPermission('timesheets', 'add'),
      action: () => setPage('MyTimesheet'),
    },
    {
      id:     'ticket',
      label:  'Raise Ticket',
      sub:    'IT or HR support',
      color:  '#f59e0b',
      Icon:   Briefcase,
      show:   () => true,
      action: () => setPage('MyTickets'),
    },
    {
      id:     'payslip',
      label:  'View Payslip',
      sub:    'Download salary slips',
      color:  '#8b5cf6',
      Icon:   FileText,
      show:   () => hasPermission('hr', 'view') || role === 'employee' || role === 'super_admin' || role === 'admin',
      action: () => setPage('PayslipViewer'),
    },
    {
      id:     'performance',
      label:  'My Reviews',
      sub:    'Performance & goals',
      color:  '#ec4899',
      Icon:   Star,
      show:   () => hasPermission('performance', 'view'),
      action: () => setPage('PerformanceReviews'),
    },
    {
      id:     'attendance',
      label:  'My Attendance',
      sub:    'View attendance log',
      color:  '#06b6d4',
      Icon:   CheckCircle,
      show:   () => hasPermission('attendance', 'view'),
      action: () => setPage('AttendanceDashboard'),
    },
  ].filter(a => a.show());

  // ── Badge helpers ─────────────────────────────────────────────────────────
  function attendanceBadgeClass(status) {
    if (!status) return 'ed-status-badge ed-status-absent';
    const s = status.toLowerCase();
    if (s === 'present') return 'ed-status-badge ed-status-present';
    if (s === 'late')    return 'ed-status-badge ed-status-late';
    return 'ed-status-badge ed-status-absent';
  }

  function attendanceBadgeLabel(status) {
    if (!status) return 'Not Marked';
    const s = status.toLowerCase();
    if (s === 'present') return 'Present';
    if (s === 'late')    return 'Late';
    return 'Absent';
  }

  function attendanceKpiColor(status) {
    if (!status) return '#ef4444';
    const s = status.toLowerCase();
    if (s === 'present') return '#10b981';
    if (s === 'late')    return '#f59e0b';
    return '#ef4444';
  }

  // ── Leave submit ──────────────────────────────────────────────────────────
  async function handleLeaveSubmit(formData) {
    setLeaveSubmitting(true);
    try {
      if (!user?.employee_id) throw new Error('Missing employee id for leave application');
      await api.post('/leaves/apply', {
        employee_id:    user.employee_id,
        leave_type:     formData.leaveType,
        start_date:     formData.fromDate,
        end_date:       formData.toDate,
        number_of_days: calcWorkingDays(formData.fromDate, formData.toDate),
        reason:         formData.reason,
      });
      setDrawerOpen(false);
      showToast('Leave application submitted');
      loadData();
    } catch (error) {
      console.error('[EmployeeDashboard] Leave application failed', error);
      showToast(error.response?.data?.error || 'Failed to submit leave application', 'error');
    } finally {
      setLeaveSubmitting(false);
    }
  }

  const firstName  = user?.first_name || user?.name?.split(' ')[0] || 'there';

  // Department / designation / date-of-joining for the header identity strip
  // Human-readable employee code (EMP001), falling back to the internal id only
  // if the office code isn't available yet.
  const empCode  = empProfile?.office_id || empProfile?.employee_code
                 || user?.office_id || empProfile?.employee_id || user?.employee_id || '';
  const empDept  = empProfile?.department || '';
  const empDesig = empProfile?.designation || empProfile?.job_title || '';
  const empDoj   = empProfile?.joining_date || empProfile?.date_of_joining || null;
  const dojLabel = empDoj
    ? new Date(empDoj).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
    : '';
  const tenure   = empDoj ? (() => {
    const yrs = (Date.now() - new Date(empDoj).getTime()) / (365.25 * 86400000);
    if (yrs < 0) return '';
    return yrs >= 1 ? `${yrs.toFixed(1)} yr${yrs >= 2 ? 's' : ''}` : `${Math.max(0, Math.round(yrs * 12))} mo`;
  })() : '';

  const attColor   = attendanceKpiColor(attendance?.status);
  const clockedOut = !!(attendance?.check_in && attendance?.check_out);
  const clockedIn  = !!(attendance?.check_in && !attendance?.check_out);

  // ── My Insights derivations (all from already-fetched data) ──
  const LEAVE_BALANCE_KEYS = ['annual', 'sick', 'casual', 'earned', 'privilege', 'compoff', 'maternity', 'paternity'];
  const leaveDonut = leaveBalance
    ? LEAVE_BALANCE_KEYS
        .filter(k => parseFloat(leaveBalance[k]) > 0)
        .map(k => ({ name: k[0].toUpperCase() + k.slice(1), value: parseFloat(leaveBalance[k]) }))
    : [];
  const totalLeaveLeft = leaveDonut.reduce((s, d) => s + d.value, 0);

  const doneTasks = todayTasks.filter(t => ['done', 'completed'].includes((t.status || '').toLowerCase())).length;
  const taskPct   = todayTasks.length ? Math.round((doneTasks / todayTasks.length) * 100) : 0;

  const leaveUsage = (() => {
    const yr = new Date().getFullYear();
    const counts = {};
    for (const l of myLeaves) {
      if ((l.status || '').toLowerCase() !== 'approved') continue;
      const from = new Date(l.from_date || l.start_date || l.fromDate);
      if (isNaN(from) || from.getFullYear() !== yr) continue;
      const type = l.leave_type || l.leaveType || 'Other';
      const days = parseFloat(l.days || l.total_days || l.no_of_days) || 1;
      counts[type] = (counts[type] || 0) + days;
    }
    return Object.entries(counts).map(([label, value]) => ({ label, value }));
  })();

  return (
    <div className="ed-root">
      <style>{`
        @keyframes ed-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes ed-spin { to { transform: rotate(360deg); } }
      `}</style>

      {toast && <Toast message={toast.message} type={toast.type} onClose={dismissToast} />}
      <ApplyLeaveDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSubmit={handleLeaveSubmit}
        submitting={leaveSubmitting}
        existingLeaves={myLeaves}
        holidays={holidays}
      />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="ed-header">
        <div>
          <p className="ed-greeting">{getGreeting()}, {firstName}!</p>
          <p className="ed-date">{formatDateIN()}</p>
          {(empCode || empDesig || empDept || dojLabel) && (
            <p className="ed-emp-meta" style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {empCode  && <span style={{ fontWeight: 700, color: '#4c1d95' }}>{empCode}</span>}
              {empDesig && <span>· {empDesig}</span>}
              {empDept  && <span>· <strong style={{ color: '#374151' }}>{empDept}</strong></span>}
              {dojLabel && <span>· Joined {dojLabel}{tenure ? ` · ${tenure}` : ''}</span>}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>

          {/* Weather chip */}
          {weather && (
            <div className="ed-weather-chip" title={`${weather.desc} · Feels like ${weather.feelsLike}°C · Humidity ${weather.humidity}%`}>
              <span style={{ fontSize: 16 }}>{weatherEmoji(weather.desc)}</span>
              <span className="ed-weather-temp">{weather.temp}°C</span>
              {weather.city && <span className="ed-weather-city">{weather.city}</span>}
            </div>
          )}

          {/* Notification bell with badge */}
          <button
            className="ed-notif-bell"
            onClick={() => typeof setPage === 'function' && setPage('NotificationCenter')}
            title={notifCount ? `${notifCount} unread notification${notifCount !== 1 ? 's' : ''}` : 'Notifications'}
          >
            <Bell size={18} />
            {notifCount > 0 && (
              <span className="ed-notif-badge">{notifCount > 99 ? '99+' : notifCount}</span>
            )}
          </button>

          {/* Refresh button */}
          <button
            onClick={loadData}
            disabled={refreshing}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'none', border: '1px solid #e9e4ff',
              borderRadius: 8, padding: '5px 10px', cursor: refreshing ? 'default' : 'pointer',
              fontSize: 11, color: '#7c3aed', fontFamily: 'inherit',
            }}
            title={lastRefreshed ? `Last refreshed ${lastRefreshed.toLocaleTimeString('en-IN')}` : 'Refresh'}
          >
            <RefreshCw size={12} style={{ animation: refreshing ? 'ed-spin 1s linear infinite' : 'none' }} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>

          <span className={attendanceBadgeClass(attendance?.status)}>
            {attendanceBadgeLabel(attendance?.status)}
          </span>
        </div>
      </div>

      {/* ── Clock-in / Clock-out banner ─────────────────────────────────────── */}
      {!loading && (
        <div className={`ed-clock-banner${clockedOut ? ' ed-clock-done' : ''}`}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
              {clockedOut
                ? `Clocked out at ${attendance.check_out} ✓`
                : clockedIn
                ? `Clocked in at ${attendance.check_in}`
                : 'Not clocked in yet today'}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {currentTime.toLocaleTimeString('en-IN')}
            </div>
          </div>
          {!clockedOut && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => setFaceOpen(true)}
                disabled={clockLoading}
                title="Clock in/out with face recognition"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: '#fff', color: '#7c3aed',
                  border: '1px solid #ddd6fe', borderRadius: 8,
                  padding: '7px 12px', fontSize: 13, fontWeight: 600,
                  cursor: clockLoading ? 'default' : 'pointer', fontFamily: 'inherit',
                }}
              >
                <Camera size={14} /> Face
              </button>
              <button
                className={clockedIn ? 'ed-clock-btn-out' : 'ed-clock-btn-in'}
                onClick={() => (clockedIn || !user?.employee_id ? handleClockAction() : setFaceOpen(true))}
                disabled={clockLoading}
              >
                {clockLoading
                  ? 'Recording…'
                  : clockedIn
                    ? <><LogOut size={14} /> Clock Out</>
                    : <><LogIn size={14} /> Clock In</>
                }
              </button>
            </div>
          )}
        </div>
      )}

      {/* Face recognition clock-in/out */}
      {faceOpen && user?.employee_id && (
        <FaceClockModal
          employeeId={user.employee_id}
          action={clockedIn ? 'out' : 'in'}
          onVerified={(fd) => { setFaceOpen(false); handleClockAction(fd); }}
          onClose={() => setFaceOpen(false)}
        />
      )}

      {/* ── KPI row ────────────────────────────────────────────────────────── */}
      <div className="ed-kpis">

        {/* 1 — Today's Attendance */}
        <div className="ed-kpi">
          <div className="ed-kpi-icon" style={{ background: attColor + '18', color: attColor }}>
            <Clock size={20} />
          </div>
          <div>
            <p className="ed-kpi-label">Today's Attendance</p>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <Shimmer width="80px" /><Shimmer width="110px" />
              </div>
            ) : (
              <>
                <p className="ed-kpi-val" style={{ color: attColor }}>
                  {attendanceBadgeLabel(attendance?.status)}
                </p>
                {attendance?.check_in ? (
                  <p className="ed-kpi-sub ed-clock-time">
                    <LogIn size={10} style={{ display: 'inline', marginRight: 3 }} />
                    Clocked in at {attendance.check_in}
                  </p>
                ) : (
                  <p className="ed-kpi-sub">No clock-in recorded</p>
                )}
              </>
            )}
          </div>
        </div>

        {/* 2 — Leave Balance */}
        <div className="ed-kpi">
          <div className="ed-kpi-icon" style={{ background: '#6366f118', color: '#6366f1' }}>
            <Calendar size={20} />
          </div>
          <div>
            <p className="ed-kpi-label">Leave Balance</p>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <Shimmer width="100px" /><Shimmer width="130px" />
              </div>
            ) : leaveBalance ? (
              <>
                <p className="ed-kpi-val">Annual: {leaveBalance.annual ?? '—'} days</p>
                <p className="ed-kpi-sub">
                  Sick: {leaveBalance.sick ?? '—'} &nbsp;|&nbsp; Casual: {leaveBalance.casual ?? '—'}
                </p>
              </>
            ) : (
              <p className="ed-kpi-sub" style={{ marginTop: 4 }}>No balance data</p>
            )}
          </div>
        </div>

        {/* 3 — Pending Tasks */}
        <div className="ed-kpi">
          <div className="ed-kpi-icon" style={{ background: '#f59e0b18', color: '#f59e0b' }}>
            <CheckCircle size={20} />
          </div>
          <div>
            <p className="ed-kpi-label">Today's Pending Tasks</p>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <Shimmer width="40px" /><Shimmer width="70px" />
              </div>
            ) : (
              <>
                <p className="ed-kpi-val">{pendingTasks}</p>
                <button
                  className="ed-text-btn"
                  onClick={() => setPage('KanbanBoard')}
                  style={{ padding: 0, marginTop: 2 }}
                >
                  View Tasks <ChevronRight size={11} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* 4 — Latest Payslip (clickable) */}
        <div
          className="ed-kpi"
          style={{ cursor: 'pointer' }}
          onClick={() => setPage('PayslipViewer')}
          title="View payslips"
        >
          <div className="ed-kpi-icon" style={{ background: '#8b5cf618', color: '#8b5cf6' }}>
            <FileText size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <p className="ed-kpi-label">Latest Payslip</p>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <Shimmer width="90px" /><Shimmer width="110px" />
              </div>
            ) : latestPayslip ? (
              <>
                <p className="ed-kpi-val">{formatINR(latestPayslip.amount)}</p>
                <p className="ed-kpi-sub">{latestPayslip.month}</p>
              </>
            ) : (
              <p className="ed-kpi-sub" style={{ marginTop: 4 }}>No payslip yet</p>
            )}
          </div>
          <ArrowRight size={14} color="#8b5cf6" style={{ flexShrink: 0, marginTop: 2 }} />
        </div>

      </div>

      {/* ── My Insights — personal graphics ── */}
      <div className="ed-viz-row">
        <VizCard
          title="Leave Balance"
          subtitle="Days remaining by type"
          icon={<Calendar size={15} />}
          loading={loading}
          empty={!loading && leaveDonut.length === 0}
          emptyText="No balance data yet"
          action={leaveDonut.length > 0 && (
            <ChartExpandButton title="Leave Balance" subtitle="Days remaining by type"
              onViewAll={() => setPage && setPage('MyLeaves')} viewAllLabel="My Leaves">
              <Donut data={leaveDonut} height={360} centerLabel="Days left" centerValue={totalLeaveLeft} />
              <DonutLegend data={leaveDonut} max={8} />
            </ChartExpandButton>
          )}
        >
          <Donut data={leaveDonut} height={140} centerLabel="Days left" centerValue={totalLeaveLeft} />
          <DonutLegend data={leaveDonut} max={4} />
        </VizCard>

        <VizCard
          title="Today's Task Progress"
          subtitle={todayTasks.length ? `${doneTasks} of ${todayTasks.length} done` : 'No tasks scheduled today'}
          icon={<CheckCircle size={15} />}
          loading={loading}
          empty={!loading && todayTasks.length === 0}
          emptyText="Nothing on your plate today 🎉"
        >
          <div className="ed-viz-ring-wrap">
            <ProgressRing value={taskPct} size={110} stroke={11} color="#10b981" sublabel="Done" />
            <div className="ed-viz-ring-stats">
              <div className="ed-viz-stat">
                <span className="ed-viz-stat-dot" style={{ background: '#10b981' }} />
                <b>{doneTasks}</b>&nbsp;completed
              </div>
              <div className="ed-viz-stat">
                <span className="ed-viz-stat-dot" style={{ background: '#f59e0b' }} />
                <b>{pendingTasks}</b>&nbsp;pending
              </div>
            </div>
          </div>
        </VizCard>

        <VizCard
          title="My Leaves This Year"
          subtitle="Approved days by type"
          icon={<Briefcase size={15} />}
          loading={loading}
          empty={!loading && leaveUsage.length === 0}
          emptyText="No leaves taken this year"
          action={leaveUsage.length > 0 && (
            <ChartExpandButton title="My Leaves This Year" subtitle="Approved days by type"
              onViewAll={() => setPage && setPage('MyLeaves')} viewAllLabel="My Leaves">
              <RoundBars data={leaveUsage} height={420} multiColor name="Days" />
            </ChartExpandButton>
          )}
        >
          <RoundBars data={leaveUsage} height={170} multiColor name="Days" />
        </VizCard>
      </div>

      {/* ── Celebrations wall — react & wish colleagues ── */}
      <div className="ed-card" style={{ marginBottom: 12 }}>
        <div className="ed-card-hd">
          <span className="ed-card-title">
            <Gift size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#a855f7' }} />
            Today's Celebrations
          </span>
        </div>
        <div className="ed-card-body" style={{ maxHeight: 480, overflowY: 'auto' }}>
          <CelebrationsBoard />
        </div>
      </div>

      {/* ── Middle row — Announcements + Holidays ───────────────────────────── */}
      <div className="ed-mid-row">

        {/* Announcements */}
        <div className="ed-card">
          <div className="ed-card-hd">
            <span className="ed-card-title">
              <Bell size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#6366f1' }} />
              Company Announcements
            </span>
            <button className="ed-text-btn" onClick={() => setPage('Announcements')}>
              View All <ArrowRight size={12} />
            </button>
          </div>
          <div className="ed-card-body">
            {loading ? (
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3].map(i => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Shimmer width={i === 3 ? '50%' : '90%'} /><Shimmer width="70%" />
                  </div>
                ))}
              </div>
            ) : announcements.length === 0 ? (
              <EmptyState icon="📢" message="No announcements" />
            ) : (
              announcements.slice(0, 3).map((ann, idx) => (
                <div
                  key={ann.id || idx}
                  className="ed-ann-row"
                  style={idx === Math.min(announcements.length, 3) - 1 ? { borderBottom: 'none' } : {}}
                >
                  <div className="ed-ann-icon"><Bell size={14} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span className="ed-ann-title">{ann.title}</span>
                      <span className="ed-ann-date">{ann.date}</span>
                    </div>
                    <p className="ed-ann-desc">{ann.description}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Holidays */}
        <div className="ed-card">
          <div className="ed-card-hd">
            <span className="ed-card-title">
              <Gift size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#f59e0b' }} />
              Upcoming Holidays
            </span>
            <button className="ed-text-btn" onClick={() => setPage('HolidayCalendar')}>
              View Calendar <ArrowRight size={12} />
            </button>
          </div>
          <div className="ed-card-body">
            {loading ? (
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3].map(i => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Shimmer width="60%" /><Shimmer width="40%" />
                  </div>
                ))}
              </div>
            ) : holidays.length === 0 ? (
              <EmptyState icon="📅" message="No upcoming holidays" />
            ) : (
              holidays.slice(0, 3).map((hol, idx) => (
                <div
                  key={hol.name + idx}
                  className="ed-hol-row"
                  style={idx === Math.min(holidays.length, 3) - 1 ? { borderBottom: 'none' } : {}}
                >
                  <div className="ed-hol-icon"><Gift size={14} /></div>
                  <div>
                    <p className="ed-hol-name">{hol.name}</p>
                    <p className="ed-hol-date">{hol.date} &nbsp;&middot;&nbsp; {hol.day}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

      {/* ── Second row — Team on Leave + Today's Tasks ───────────────────────── */}
      <div className="ed-second-row">

        {/* Team on Leave Today */}
        <div className="ed-card">
          <div className="ed-card-hd">
            <span className="ed-card-title">
              <Users size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#ec4899' }} />
              Team on Leave Today
            </span>
            <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}>
              {teamOnLeave.length} member{teamOnLeave.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="ed-card-body">
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3].map(i => <Shimmer key={i} width={i === 3 ? '60%' : '85%'} />)}
              </div>
            ) : teamOnLeave.length === 0 ? (
              <EmptyState icon="👥" message="No team members on leave today" />
            ) : (
              <div className="ed-leave-pills">
                {teamOnLeave.slice(0, 6).map((l, i) => {
                  const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.name || 'Unknown';
                  const initial = name[0].toUpperCase();
                  return (
                    <div key={i} className="ed-member-pill">
                      <div className="ed-member-avatar">{initial}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {name}
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>
                          {l.department || l.designation || l.leave_type || 'On Leave'}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {teamOnLeave.length > 6 && (
                  <div style={{ fontSize: 11, color: '#9ca3af', paddingTop: 4 }}>
                    +{teamOnLeave.length - 6} more
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Today's Tasks */}
        <div className="ed-card">
          <div className="ed-card-hd">
            <span className="ed-card-title">
              <ListChecks size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#10b981' }} />
              Today's Tasks
            </span>
            <button className="ed-text-btn" onClick={() => setPage('KanbanBoard')}>
              View All <ArrowRight size={12} />
            </button>
          </div>
          <div className="ed-card-body">
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3, 4].map(i => <Shimmer key={i} width={i % 2 === 0 ? '70%' : '90%'} />)}
              </div>
            ) : todayTasks.length === 0 ? (
              <EmptyState icon="✅" message="No tasks due today" />
            ) : (
              todayTasks.slice(0, 5).map((task, i) => {
                const done = task.status === 'done' || task.status === 'completed';
                const priority = (task.priority || 'medium').toLowerCase();
                return (
                  <div
                    key={task.id || i}
                    className="ed-event-item"
                    style={i === Math.min(todayTasks.length, 5) - 1 ? { borderBottom: 'none' } : {}}
                  >
                    <div className={`ed-event-dot ed-priority-${priority}`} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 500, color: done ? '#9ca3af' : '#111827',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        textDecoration: done ? 'line-through' : 'none',
                      }}>
                        {task.title || task.name}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
                        {task.project_name || task.project || ''}
                        {task.status ? ` · ${task.status}` : ''}
                      </div>
                    </div>
                    {done && <CheckCircle size={14} color="#10b981" style={{ flexShrink: 0 }} />}
                  </div>
                );
              })
            )}
          </div>
        </div>

      </div>

      {/* ── Third row — My Payslips + My Timesheets ─────────────────────────── */}
      <div className="ed-third-row">

        {/* My Payslips */}
        <div className="ed-card">
          <div className="ed-card-hd">
            <span className="ed-card-title">
              <FileText size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#8b5cf6' }} />
              My Payslips
            </span>
            <button className="ed-text-btn" onClick={() => setPage('PayslipViewer')}>
              View All <ArrowRight size={12} />
            </button>
          </div>
          <MyPayslipsWidget />
        </div>

        {/* My Timesheets */}
        <div className="ed-card">
          <div className="ed-card-hd">
            <span className="ed-card-title">
              <Clock size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#10b981' }} />
              My Timesheets
            </span>
            <button className="ed-text-btn" onClick={() => setPage('MyTimesheet')}>
              Log Hours <ArrowRight size={12} />
            </button>
          </div>
          <div className="ed-card-body">
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3].map(i => <Shimmer key={i} width={i === 3 ? '60%' : '85%'} />)}
              </div>
            ) : recentTimesheets.length === 0 ? (
              <EmptyState icon="⏱️" message="No timesheet entries yet" />
            ) : (
              recentTimesheets.slice(0, 5).map((ts, i) => {
                const st = (ts.status || 'draft').toLowerCase();
                const statusColor =
                  st === 'approved' ? '#10b981' :
                  st === 'rejected' ? '#ef4444' : '#f59e0b';
                const isLast = i === Math.min(recentTimesheets.length, 5) - 1;
                return (
                  <div
                    key={ts.id || i}
                    className="ed-event-item"
                    style={isLast ? { borderBottom: 'none' } : {}}
                  >
                    <div className="ed-event-dot" style={{ background: statusColor }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 500, color: '#111827',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {ts.task_description || ts.project_name || ts.project || 'Timesheet Entry'}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
                        {ts.date || ts.work_date} &nbsp;&middot;&nbsp; {ts.hours_worked || ts.hours || 0}h
                      </div>
                    </div>
                    <span className={`ed-ts-badge ed-ts-${st}`}>{st}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

      </div>

      {/* ── Quick Actions ────────────────────────────────────────────────────── */}
      {quickActions.length > 0 && (
        <div className="ed-quick-actions">
          {quickActions.map(({ id, label, sub, color, Icon, action }) => (
            <div key={id} className="ed-qa-card" onClick={action}>
              <div className="ed-qa-icon" style={{ background: color + '18' }}>
                <Icon size={22} color={color} />
              </div>
              <span className="ed-qa-label">{label}</span>
              <span className="ed-qa-sub">{sub}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

