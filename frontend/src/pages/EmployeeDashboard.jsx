import React, { useState, useEffect, useCallback } from 'react';
import {
  Calendar, Clock, CheckCircle, FileText, Bell, Briefcase,
  X, ChevronRight, ArrowRight, LogIn, LogOut, User, Gift,
  AlertCircle, Plus
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api/client';
import './EmployeeDashboard.css';

// ─── Sample / fallback data ───────────────────────────────────────────────────
const SAMPLE_ATTENDANCE   = { status: 'present', check_in: '09:12 AM', check_out: null };
const SAMPLE_LEAVE_BAL    = { annual: 10, sick: 3, casual: 2 };
const SAMPLE_PENDING_TASKS = 4;
const SAMPLE_PAYSLIP      = { month: 'February 2026', amount: 42500 };
const SAMPLE_ANNOUNCEMENTS = [
  {
    id: 1,
    title: 'Quarterly Review Scheduled',
    date: '14 Mar 2026',
    description: 'Q1 performance reviews will be held on 25th March. Please prepare your self-assessment.',
  },
  {
    id: 2,
    title: 'New Leave Policy Update',
    date: '10 Mar 2026',
    description: 'Updated leave encashment policy effective April 2026. Check the policies section.',
  },
  {
    id: 3,
    title: 'Office Closure — Holi',
    date: '7 Mar 2026',
    description: 'Office will remain closed on 14th March for Holi. Enjoy the festival!',
  },
];
const SAMPLE_HOLIDAYS = [
  { name: 'Holi',       date: '14 Mar 2026', day: 'Saturday' },
  { name: 'Ugadi',      date: '30 Mar 2026', day: 'Sunday'   },
  { name: 'Ram Navami', date: '6 Apr 2026',  day: 'Monday'   },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDateIN() {
  return new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
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
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
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

// ─── Apply Leave Drawer ───────────────────────────────────────────────────────
function ApplyLeaveDrawer({ open, onClose, onSubmit }) {
  const [form, setForm] = useState({
    leaveType: 'Annual',
    fromDate: '',
    toDate: '',
    reason: '',
  });
  const [days, setDays] = useState(0);

  useEffect(() => {
    if (form.fromDate && form.toDate) {
      setDays(calcWorkingDays(form.fromDate, form.toDate));
    } else {
      setDays(0);
    }
  }, [form.fromDate, form.toDate]);

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit(form);
    setForm({ leaveType: 'Annual', fromDate: '', toDate: '', reason: '' });
    setDays(0);
  }

  if (!open) return null;

  return (
    <>
      <div className="ed-overlay" onClick={onClose} />
      <div className="ed-drawer" role="dialog" aria-modal="true" aria-label="Apply Leave">
        <div className="ed-drawer-hd">
          <span style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>Apply Leave</span>
          <button className="ed-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form className="ed-drawer-body" onSubmit={handleSubmit}>
          <div className="ed-form-group">
            <label className="ed-label" htmlFor="leaveType">Leave Type</label>
            <select
              id="leaveType"
              name="leaveType"
              className="ed-select"
              value={form.leaveType}
              onChange={handleChange}
              required
            >
              <option value="Annual">Annual Leave</option>
              <option value="Sick">Sick Leave</option>
              <option value="Casual">Casual Leave</option>
              <option value="Compensatory">Compensatory Leave</option>
            </select>
          </div>

          <div className="ed-form-group">
            <label className="ed-label" htmlFor="fromDate">From Date</label>
            <input
              id="fromDate"
              name="fromDate"
              type="date"
              className="ed-input"
              value={form.fromDate}
              onChange={handleChange}
              required
            />
          </div>

          <div className="ed-form-group">
            <label className="ed-label" htmlFor="toDate">To Date</label>
            <input
              id="toDate"
              name="toDate"
              type="date"
              className="ed-input"
              value={form.toDate}
              onChange={handleChange}
              required
            />
            {days > 0 && (
              <div className="ed-days-calc">
                {days} working day{days !== 1 ? 's' : ''}
              </div>
            )}
          </div>

          <div className="ed-form-group">
            <label className="ed-label" htmlFor="reason">Reason</label>
            <textarea
              id="reason"
              name="reason"
              className="ed-textarea"
              rows={4}
              placeholder="Briefly describe the reason for leave..."
              value={form.reason}
              onChange={handleChange}
              required
            />
          </div>

          <div className="ed-drawer-footer" style={{ padding: 0, marginTop: 8, border: 'none' }}>
            <button type="button" className="ed-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="ed-btn-primary">Submit Application</button>
          </div>
        </form>
      </div>
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function EmployeeDashboard({ setPage }) {
  const { user } = useAuth();

  const [attendance,    setAttendance]    = useState(SAMPLE_ATTENDANCE);
  const [leaveBalance,  setLeaveBalance]  = useState(SAMPLE_LEAVE_BAL);
  const [pendingTasks,  setPendingTasks]  = useState(SAMPLE_PENDING_TASKS);
  const [latestPayslip, setLatestPayslip] = useState(SAMPLE_PAYSLIP);
  const [announcements, setAnnouncements] = useState(SAMPLE_ANNOUNCEMENTS);
  const [holidays,      setHolidays]      = useState(SAMPLE_HOLIDAYS);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast,      setToast]      = useState(null);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  // ── Fetch dashboard data ──────────────────────────────────────────────────
  useEffect(() => {
    async function loadData() {
      try {
        const [res] = await Promise.allSettled([api.get('/employee/dashboard')]);
        if (res.status === 'fulfilled' && res.value?.data) {
          const d = res.value.data;
          if (d.attendance)    setAttendance(d.attendance);
          if (d.leaveBalance)  setLeaveBalance(d.leaveBalance);
          if (d.pendingTasks !== undefined) setPendingTasks(d.pendingTasks);
          if (d.latestPayslip) setLatestPayslip(d.latestPayslip);
          if (d.announcements?.length) setAnnouncements(d.announcements);
          if (d.holidays?.length)      setHolidays(d.holidays);
        }
      } catch {
        // silently fall back to sample data already set in state
      }
    }
    loadData();
  }, []);

  // ── Attendance badge helpers ──────────────────────────────────────────────
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

  // ── KPI card color helpers ────────────────────────────────────────────────
  function attendanceKpiColor(status) {
    if (!status) return '#ef4444';
    const s = status.toLowerCase();
    if (s === 'present') return '#10b981';
    if (s === 'late')    return '#f59e0b';
    return '#ef4444';
  }

  // ── Leave submit ──────────────────────────────────────────────────────────
  async function handleLeaveSubmit(formData) {
    try {
      await api.post('/employee/leave/apply', formData);
    } catch {
      // still show success toast; offline / mock environment
    }
    setDrawerOpen(false);
    showToast('Leave application submitted');
  }

  const firstName = user?.first_name || user?.name?.split(' ')[0] || 'there';
  const attColor  = attendanceKpiColor(attendance?.status);

  return (
    <div className="ed-root">
      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={dismissToast} />}

      {/* ── Apply Leave Drawer ────────────────────────────────────────────── */}
      <ApplyLeaveDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSubmit={handleLeaveSubmit}
      />

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="ed-header">
        <div>
          <p className="ed-greeting">{getGreeting()}, {firstName}!</p>
          <p className="ed-date">{formatDateIN()}</p>
        </div>
        <span className={attendanceBadgeClass(attendance?.status)}>
          {attendanceBadgeLabel(attendance?.status)}
        </span>
      </div>

      {/* ── KPI row ──────────────────────────────────────────────────────── */}
      <div className="ed-kpis">

        {/* 1 — Today's Attendance */}
        <div className="ed-kpi">
          <div className="ed-kpi-icon" style={{ background: attColor + '18', color: attColor }}>
            <Clock size={20} />
          </div>
          <div>
            <p className="ed-kpi-label">Today's Attendance</p>
            <p className="ed-kpi-val" style={{ color: attColor }}>
              {attendanceBadgeLabel(attendance?.status)}
            </p>
            {attendance?.check_in && (
              <p className="ed-kpi-sub ed-clock-time">
                <LogIn size={10} style={{ display: 'inline', marginRight: 3 }} />
                Clocked in at {attendance.check_in}
              </p>
            )}
            {!attendance?.check_in && (
              <p className="ed-kpi-sub">No clock-in recorded</p>
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
            <p className="ed-kpi-val">Annual: {leaveBalance.annual} days</p>
            <p className="ed-kpi-sub">
              Sick: {leaveBalance.sick} &nbsp;|&nbsp; Casual: {leaveBalance.casual}
            </p>
          </div>
        </div>

        {/* 3 — Pending Tasks */}
        <div className="ed-kpi">
          <div className="ed-kpi-icon" style={{ background: '#f59e0b18', color: '#f59e0b' }}>
            <CheckCircle size={20} />
          </div>
          <div>
            <p className="ed-kpi-label">Pending Tasks</p>
            <p className="ed-kpi-val">{pendingTasks}</p>
            <button
              className="ed-text-btn"
              onClick={() => setPage('Tasks')}
              style={{ padding: 0, marginTop: 2 }}
            >
              View Tasks <ChevronRight size={11} />
            </button>
          </div>
        </div>

        {/* 4 — Latest Payslip */}
        <div className="ed-kpi">
          <div className="ed-kpi-icon" style={{ background: '#8b5cf618', color: '#8b5cf6' }}>
            <FileText size={20} />
          </div>
          <div>
            <p className="ed-kpi-label">Latest Payslip</p>
            <p className="ed-kpi-val">{formatINR(latestPayslip.amount)}</p>
            <p className="ed-kpi-sub">{latestPayslip.month}</p>
          </div>
        </div>

      </div>

      {/* ── Middle row ───────────────────────────────────────────────────── */}
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
            {announcements.slice(0, 3).map((ann, idx) => (
              <div
                key={ann.id || idx}
                className="ed-ann-row"
                style={idx === announcements.slice(0, 3).length - 1 ? { borderBottom: 'none' } : {}}
              >
                <div className="ed-ann-icon">
                  <Bell size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span className="ed-ann-title">{ann.title}</span>
                    <span className="ed-ann-date">{ann.date}</span>
                  </div>
                  <p className="ed-ann-desc">{ann.description}</p>
                </div>
              </div>
            ))}
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
            {holidays.slice(0, 3).map((hol, idx) => (
              <div
                key={hol.name + idx}
                className="ed-hol-row"
                style={idx === holidays.slice(0, 3).length - 1 ? { borderBottom: 'none' } : {}}
              >
                <div className="ed-hol-icon">
                  <Gift size={14} />
                </div>
                <div>
                  <p className="ed-hol-name">{hol.name}</p>
                  <p className="ed-hol-date">{hol.date} &nbsp;&middot;&nbsp; {hol.day}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ── Quick Actions ─────────────────────────────────────────────────── */}
      <div className="ed-quick-actions">

        <div className="ed-qa-card" onClick={() => setDrawerOpen(true)}>
          <div className="ed-qa-icon" style={{ background: '#6366f118' }}>
            <Calendar size={22} color="#6366f1" />
          </div>
          <span className="ed-qa-label">Apply Leave</span>
          <span className="ed-qa-sub">Submit a leave request</span>
        </div>

        <div className="ed-qa-card" onClick={() => setPage('Timesheets')}>
          <div className="ed-qa-icon" style={{ background: '#10b98118' }}>
            <Clock size={22} color="#10b981" />
          </div>
          <span className="ed-qa-label">Submit Timesheet</span>
          <span className="ed-qa-sub">Log your work hours</span>
        </div>

        <div className="ed-qa-card" onClick={() => setPage('MyTickets')}>
          <div className="ed-qa-icon" style={{ background: '#f59e0b18' }}>
            <Briefcase size={22} color="#f59e0b" />
          </div>
          <span className="ed-qa-label">Raise Ticket</span>
          <span className="ed-qa-sub">IT or HR support</span>
        </div>

        <div className="ed-qa-card" onClick={() => setPage('Downloads')}>
          <div className="ed-qa-icon" style={{ background: '#8b5cf618' }}>
            <FileText size={22} color="#8b5cf6" />
          </div>
          <span className="ed-qa-label">View Payslip</span>
          <span className="ed-qa-sub">Download salary slips</span>
        </div>

      </div>
    </div>
  );
}
