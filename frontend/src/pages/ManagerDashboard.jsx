import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import {
  Users, Clock, CheckCircle, TrendingUp, Calendar, Bell,
  UserCheck, ChevronRight, RefreshCw, X, Target, Award,
  AlertCircle, ArrowRight, Plus, FileText, Plane,
  GitBranch, Activity, Video, Inbox, Zap, BarChart2,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '../services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './ManagerDashboard.css';

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtRupee = (n) => {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000)   return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
};

const fmtMetric = (v) =>
  typeof v === 'number' && v >= 1000 ? fmtRupee(v) : v;

const getInitials = (name = '') => name.charAt(0).toUpperCase();

const STATUS_META = {
  present: { color: '#10b981', label: 'Present' },
  absent:  { color: '#ef4444', label: 'Absent'  },
  late:    { color: '#f59e0b', label: 'Late'     },
  wfh:     { color: '#6366f1', label: 'WFH'      },
};

const todayStr = () => {
  const d = new Date();
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const capColor = (pct) => pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';

// ── Toast ─────────────────────────────────────────────────────────────────────
const Toast = ({ toast, onClose }) => {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  if (!toast) return null;
  return (
    <div className={`md-toast ${toast.type === 'error' ? 'md-toast-error' : 'md-toast-success'}`}>
      {toast.type === 'error' ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
      <span>{toast.message}</span>
      <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>
        <X size={14} />
      </button>
    </div>
  );
};

// ── KPI Card ──────────────────────────────────────────────────────────────────
const KpiCard = ({ icon: Icon, label, value, sub, color, onClick }) => (
  <div
    className="md-kpi"
    style={{ '--c': color }}
    onClick={onClick}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => e.key === 'Enter' && onClick && onClick()}
  >
    <div className="md-kpi-icon"><Icon size={20} /></div>
    <div style={{ flex: 1 }}>
      <p className="md-kpi-label">{label}</p>
      <p className="md-kpi-val">{value}</p>
      {sub && <p className="md-kpi-sub">{sub}</p>}
    </div>
    <ChevronRight size={16} className="md-kpi-arrow" />
  </div>
);

// ── Shimmer rows ──────────────────────────────────────────────────────────────
const ShimmerRows = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {[100, 70, 50].map((w, i) => (
      <div key={i} style={{
        height: 14, borderRadius: 6,
        background: 'linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%)',
        backgroundSize: '200% 100%',
        animation: 'md-shimmer 1.4s infinite',
        width: `${w}%`,
      }} />
    ))}
  </div>
);

// ── Empty State ───────────────────────────────────────────────────────────────
const EmptyState = ({ Icon: IconComponent = Inbox, message }) => (
  <div style={{
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    padding: '32px 16px', color: '#9ca3af', gap: 8,
  }}>
    <IconComponent size={28} color="#d1d5db" strokeWidth={1.5} />
    <p style={{ margin: 0, fontSize: 13 }}>{message}</p>
  </div>
);

// ── Announcement Drawer ───────────────────────────────────────────────────────
const AnnouncementDrawer = ({ open, onClose, onPost }) => {
  const [message, setMessage] = useState('');
  const handlePost = () => { if (!message.trim()) return; onPost(message.trim()); setMessage(''); };
  if (!open) return null;
  return (
    <>
      <div className="md-overlay" onClick={onClose} />
      <div className="md-drawer">
        <div className="md-drawer-hd">
          <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>Add Announcement</span>
          <button className="md-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="md-drawer-body">
          <label className="md-label">
            <Bell size={13} style={{ marginRight: 5, verticalAlign: 'middle' }} />
            Announcement Message
          </label>
          <textarea
            className="md-textarea" rows={6}
            placeholder="Type your announcement here…"
            value={message} onChange={(e) => setMessage(e.target.value)}
          />
          <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
            This will be visible to all team members.
          </p>
        </div>
        <div className="md-drawer-footer">
          <button className="md-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="md-btn-primary" onClick={handlePost} disabled={!message.trim()} style={{ opacity: message.trim() ? 1 : 0.5 }}>
            <Plus size={14} style={{ marginRight: 5, verticalAlign: 'middle' }} />
            Post Announcement
          </button>
        </div>
      </div>
    </>
  );
};

// ── Meeting Scheduler Drawer ──────────────────────────────────────────────────
const BLANK_MEETING = { title: '', date: '', time: '10:00', attendees: [], notes: '' };

const MeetingDrawer = ({ open, onClose, teamMembers, onSchedule }) => {
  const [form, setForm] = useState(BLANK_MEETING);

  const toggle = (id) =>
    setForm(prev => ({
      ...prev,
      attendees: prev.attendees.includes(id)
        ? prev.attendees.filter(a => a !== id)
        : [...prev.attendees, id],
    }));

  const handleSubmit = () => {
    if (!form.title.trim() || !form.date) return;
    onSchedule(form);
    setForm(BLANK_MEETING);
  };

  if (!open) return null;
  return (
    <>
      <div className="md-overlay" onClick={onClose} />
      <div className="md-drawer">
        <div className="md-drawer-hd">
          <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>Schedule Team Meeting</span>
          <button className="md-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="md-drawer-body">
          <label className="md-label">Meeting Title *</label>
          <input
            className="md-input"
            placeholder="e.g. Weekly Sync"
            value={form.title}
            onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
            <div>
              <label className="md-label">Date *</label>
              <input
                className="md-input" type="date"
                value={form.date}
                onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
              />
            </div>
            <div>
              <label className="md-label">Time</label>
              <input
                className="md-input" type="time"
                value={form.time}
                onChange={e => setForm(p => ({ ...p, time: e.target.value }))}
              />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <label className="md-label">
              Attendees
              {form.attendees.length > 0 && (
                <span style={{ marginLeft: 6, fontWeight: 400, color: '#6B3FDB' }}>
                  ({form.attendees.length} selected)
                </span>
              )}
            </label>
            <div className="md-attendee-list">
              {teamMembers.map(m => {
                const id  = m.id || m.name;
                const name = m.name || `${m.first_name} ${m.last_name}`;
                const sel  = form.attendees.includes(id);
                return (
                  <label key={id} className={`md-attendee-item${sel ? ' md-attendee-selected' : ''}`}>
                    <input type="checkbox" checked={sel} onChange={() => toggle(id)} style={{ display: 'none' }} />
                    <div className="md-avatar md-avatar-sm">{getInitials(name)}</div>
                    <span style={{ fontSize: 12, flex: 1 }}>{name}</span>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>{m.role || m.designation || ''}</span>
                    {sel && <CheckCircle size={14} style={{ color: '#6B3FDB', flexShrink: 0, marginLeft: 6 }} />}
                  </label>
                );
              })}
              {teamMembers.length === 0 && (
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '8px 0' }}>No team members loaded.</p>
              )}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <label className="md-label">Agenda / Notes</label>
            <textarea
              className="md-textarea" rows={3}
              placeholder="Meeting agenda…"
              value={form.notes}
              onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
            />
          </div>
        </div>
        <div className="md-drawer-footer">
          <button className="md-btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="md-btn-primary" onClick={handleSubmit}
            disabled={!form.title.trim() || !form.date}
            style={{ opacity: form.title.trim() && form.date ? 1 : 0.5 }}
          >
            <Video size={14} style={{ marginRight: 5, verticalAlign: 'middle' }} />
            Schedule Meeting
          </button>
        </div>
      </div>
    </>
  );
};

// ── Budget Tooltip ────────────────────────────────────────────────────────────
const BudgetTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#fff', border: '1px solid #f0f0f4', borderRadius: 8,
      padding: '10px 14px', fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
    }}>
      <p style={{ fontWeight: 600, color: '#111827', marginBottom: 6 }}>{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color, margin: '2px 0' }}>
          {p.name === 'budget' ? 'Budget' : 'Actual'}: {fmtRupee(p.value)}
        </p>
      ))}
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────
export default function ManagerDashboard({ setPage, hideHeader = false }) {
  const { user } = useAuth();
  const dept = user?.department || '';

  // ── data state ───────────────────────────────────────────────────────────────
  const [teamMembers,       setTeamMembers]       = useState([]);
  const [budgetData,        setBudgetData]        = useState([]);
  const [pendingLeaves,     setPendingLeaves]     = useState([]);
  const [pendingTimesheets, setPendingTimesheets] = useState([]);
  const [pendingTravel,     setPendingTravel]     = useState([]);
  const [todayAttend,       setTodayAttend]       = useState({ present: 0, absent: 0, late: 0, wfh: 0 });
  const [onLeaveToday,      setOnLeaveToday]      = useState([]);
  const [directReports,     setDirectReports]     = useState([]);
  const [teamCapacity,      setTeamCapacity]      = useState([]);
  const [targetsData,       setTargetsData]       = useState([]);
  const [kpis,              setKpis]              = useState({
    teamSize: 0, pendingCount: 0, attendRate: '0%', budgetUsed: '0%', budgetAmount: '—',
  });

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [loading,      setLoading]      = useState(false);
  const [drawerOpen,   setDrawerOpen]   = useState(false);
  const [meetingOpen,  setMeetingOpen]  = useState(false);
  const [toast,        setToast]        = useState(null);
  const [approvalTab,  setApprovalTab]  = useState('leave');
  const [dismissed,    setDismissed]    = useState(new Set());

  const showToast = useCallback((message, type = 'success') => setToast({ message, type }), []);

  // ── load data ─────────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {

    const deptParam = dept ? { department: dept } : {};

    const [
      teamRes, leavesRes, timesheetsRes, travelRes,
      attendRes, budgetRes, onLeaveRes,
      drRes, capacityRes, targetsRes,
    ] = await Promise.allSettled([
      api.get('/employees', { params: deptParam }),
      api.get('/leaves/team', { params: { status: 'pending' } }),
      api.get('/timesheets/timesheets', { params: { status: 'Submitted', limit: 100 } }),
      api.get('/travel/requests', { params: { status: 'pending' } }),
      api.get('/attendance/today'),
      api.get('/manager/budget'),
      api.get('/attendance/on-leave-today', { params: deptParam }),
      api.get('/employees/direct-reports'),
      api.get('/manager/team-capacity'),
      api.get('/manager/targets'),
    ]);

    if (teamRes.status === 'fulfilled') {
      const members = Array.isArray(teamRes.value.data)
        ? teamRes.value.data
        : (teamRes.value.data?.members || teamRes.value.data?.employees || []);
      setTeamMembers(members);
      setKpis(prev => ({ ...prev, teamSize: members.length }));
    }

    let leaveCount = 0;
    if (leavesRes.status === 'fulfilled') {
      const raw = leavesRes.value.data;
      const list = Array.isArray(raw) ? raw : (raw?.data || raw?.leaves || []);
      setPendingLeaves(list.map(l => ({ ...l, _type: 'leave' })));
      leaveCount = list.length;
    }

    let tsCount = 0;
    if (timesheetsRes.status === 'fulfilled') {
      const raw = timesheetsRes.value.data;
      const list = Array.isArray(raw) ? raw : (raw?.data || raw?.timesheets || []);
      setPendingTimesheets(list.map(t => ({ ...t, _type: 'timesheet' })));
      tsCount = list.length;
    }

    let travelCount = 0;
    if (travelRes.status === 'fulfilled') {
      const raw = travelRes.value.data;
      const list = Array.isArray(raw) ? raw : (raw?.data || raw?.requests || []);
      setPendingTravel(list.map(t => ({ ...t, _type: 'travel' })));
      travelCount = list.length;
    }

    setKpis(prev => ({ ...prev, pendingCount: leaveCount + tsCount + travelCount }));

    if (attendRes.status === 'fulfilled' && attendRes.value.data) {
      const raw = attendRes.value.data;
      const a = raw.summary || raw;
      setTodayAttend({
        present: a.present || 0,
        absent:  a.absent  || 0,
        late:    a.late    || 0,
        wfh:     a.wfh     || 0,
      });
      const total = (a.present || 0) + (a.absent || 0) + (a.late || 0) + (a.wfh || 0);
      if (total > 0) {
        const rate = Math.round(((a.present + (a.wfh || 0)) / total) * 100);
        setKpis(prev => ({ ...prev, attendRate: `${rate}%` }));
      }
    }

    if (budgetRes.status === 'fulfilled' && Array.isArray(budgetRes.value.data?.categories)) {
      setBudgetData(budgetRes.value.data.categories);
    }

    if (onLeaveRes.status === 'fulfilled') {
      const raw = onLeaveRes.value.data;
      setOnLeaveToday(Array.isArray(raw) ? raw : (raw?.employees || raw?.data || []));
    }

    if (drRes.status === 'fulfilled') {
      const raw = drRes.value.data;
      setDirectReports(Array.isArray(raw) ? raw : (raw?.data || raw?.employees || []));
    }

    if (capacityRes.status === 'fulfilled') {
      const raw = capacityRes.value.data;
      setTeamCapacity(Array.isArray(raw) ? raw : (raw?.data || raw?.employees || []));
    }

    if (targetsRes.status === 'fulfilled') {
      const raw = targetsRes.value.data;
      setTargetsData(Array.isArray(raw) ? raw : (raw?.data || raw?.targets || []));
    }

    setLoading(false);
  }, [dept]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── approve / reject — type-aware, correct endpoints ────────────────────────
  const doApprove = async (item) => {
    if (item._type === 'timesheet') {
      await api.post('/timesheets/timesheets/approve', { ids: [item.id], approved_by: user?.userId });
    } else if (item._type === 'travel') {
      await api.put(`/travel/requests/${item.id}/status`, { status: 'approved' });
    } else {
      await api.put(`/leaves/${item.id}/approve`);
    }
  };

  const doReject = async (item) => {
    if (item._type === 'timesheet') {
      await api.post('/timesheets/timesheets/reject', { ids: [item.id], approved_by: user?.userId });
    } else if (item._type === 'travel') {
      await api.put(`/travel/requests/${item.id}/status`, { status: 'rejected' });
    } else {
      await api.put(`/leaves/${item.id}/reject`);
    }
  };

  const handleApprove = async (item) => {
    try {
      await doApprove(item);
      setDismissed(prev => new Set([...prev, item.id]));
      showToast(`Approved ${item._type} for ${item.employee || item.employee_name || item.name}`, 'success');
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Approval failed';
      showToast(msg, 'error');
    }
  };

  const handleReject = async (item) => {
    try {
      await doReject(item);
      setDismissed(prev => new Set([...prev, item.id]));
      showToast(`Rejected ${item._type} for ${item.employee || item.employee_name || item.name}`, 'error');
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Rejection failed';
      showToast(msg, 'error');
    }
  };

  const handlePostAnnouncement = async (message) => {
    try {
      await api.post('/announcements', { title: 'Team Announcement', message, body: message });
      setDrawerOpen(false);
      showToast('Announcement posted successfully!', 'success');
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Failed to post announcement';
      showToast(msg, 'error');
    }
  };

  const handleScheduleMeeting = async (form) => {
    try {
      await api.post('/meetings', {
        title:        form.title,
        date:         form.date,
        time:         form.time,
        attendee_ids: form.attendees,
        notes:        form.notes,
      });
      setMeetingOpen(false);
      showToast('Meeting scheduled successfully!', 'success');
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to schedule meeting';
      showToast(msg, 'error');
    }
  };

  // ── derived ───────────────────────────────────────────────────────────────────
  const visibleLeaves     = pendingLeaves.filter(a => !dismissed.has(a.id));
  const visibleTimesheets = pendingTimesheets.filter(a => !dismissed.has(a.id));
  const visibleTravel     = pendingTravel.filter(a => !dismissed.has(a.id));
  const totalPending      = visibleLeaves.length + visibleTimesheets.length + visibleTravel.length;

  const activeApprItems =
    approvalTab === 'timesheet' ? visibleTimesheets :
    approvalTab === 'travel'    ? visibleTravel     :
    visibleLeaves;

  const greetingName = user?.name?.split(' ')[0] || 'Manager';
  const deptLabel    = dept || 'Engineering';
  const getBudgetColor = (e) => e.actual > e.budget ? '#ef4444' : '#6366f1';

  const apprTabs = [
    { key: 'leave',     label: 'Leave',     count: visibleLeaves.length,     Icon: Calendar },
    { key: 'timesheet', label: 'Timesheet', count: visibleTimesheets.length, Icon: FileText },
    { key: 'travel',    label: 'Travel',    count: visibleTravel.length,     Icon: Plane    },
  ];

  const budgetChart = (h = 220) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={budgetData} barCategoryGap="30%" barGap={4}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
        <XAxis dataKey="dept" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} tickFormatter={fmtRupee} width={52} />
        <Tooltip content={<BudgetTooltip />} />
        <Bar dataKey="budget" name="budget" fill="#a5b4fc" radius={[4, 4, 0, 0]} />
        <Bar dataKey="actual" name="actual" radius={[4, 4, 0, 0]}>
          {budgetData.map((e, i) => <Cell key={i} fill={getBudgetColor(e)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <div className="md-root">
      <style>{`@keyframes md-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <Toast toast={toast} onClose={() => setToast(null)} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      {!hideHeader && <div className="md-header">
        <div>
          <h1 className="md-greeting">Good morning, {greetingName} 👋</h1>
          <p className="md-date">
            {todayStr()} &nbsp;·&nbsp;
            <span className="md-dept">{deptLabel}</span>
          </p>
        </div>
        <div className="md-header-r">
          <button className="md-refresh-btn" onClick={loadData} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'md-spin' : ''} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="md-icon-btn" title="Notifications"><Bell size={16} /></button>
        </div>
      </div>}

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      <div className="md-kpis">
        <KpiCard icon={Users}     label="Team Size"         value={kpis.teamSize}     sub="Active members"         color="#6366f1" onClick={() => setPage('EmployeesData')} />
        <KpiCard icon={Clock}     label="Pending Approvals" value={kpis.pendingCount} sub="Leave · Sheet · Travel"  color="#f59e0b" onClick={() => setPage('LeaveApprovals')} />
        <KpiCard icon={UserCheck} label="Attendance Rate"   value={kpis.attendRate}   sub="Today's team rate"       color="#10b981" onClick={() => setPage('TeamAttendance')} />
        <KpiCard icon={Target}    label="Budget Used"       value={kpis.budgetUsed}   sub={kpis.budgetAmount}       color="#8b5cf6" onClick={() => setPage('BudgetManagement')} />
      </div>

      {/* ── Quick Actions ───────────────────────────────────────────────────── */}
      <div className="md-quick-actions">
        <button className="md-qa-btn" onClick={() => setPage('LeaveApprovals')}>
          <CheckCircle size={14} />
          Approve Leaves
          {visibleLeaves.length > 0 && <span className="md-badge">{visibleLeaves.length}</span>}
        </button>
        <button className="md-qa-btn" onClick={() => setPage('TimesheetApprovals')}>
          <FileText size={14} />
          Timesheets
          {visibleTimesheets.length > 0 && <span className="md-badge">{visibleTimesheets.length}</span>}
        </button>
        <button className="md-qa-btn" onClick={() => setMeetingOpen(true)}>
          <Video size={14} />
          Schedule Meeting
        </button>
        <button className="md-qa-btn" onClick={() => setPage('EmployeesData')}>
          <Users size={14} />
          View Team
        </button>
        <button className="md-qa-btn" onClick={() => setDrawerOpen(true)}>
          <Plus size={14} />
          Announcement
        </button>
        <button className="md-qa-btn" onClick={() => setPage('TeamAttendance')}>
          <Calendar size={14} />
          Attendance
        </button>
      </div>

      {/* ── Row 1: Attendance + Pending Approvals ───────────────────────────── */}
      <div className="md-grid" style={{ marginBottom: 12 }}>

        {/* Team Attendance */}
        <div className="md-card mg6">
          <div className="md-card-hd">
            <span className="md-card-title">
              <UserCheck size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#10b981' }} />
              Team Attendance — Today
            </span>
            <button className="md-text-btn" onClick={() => setPage('TeamAttendance')}>
              View all <ArrowRight size={12} />
            </button>
          </div>
          <div className="md-card-body">
            <div className="md-attend-strip">
              {[
                { key: 'present', label: 'Present', color: '#10b981' },
                { key: 'absent',  label: 'Absent',  color: '#ef4444' },
                { key: 'late',    label: 'Late',     color: '#f59e0b' },
                { key: 'wfh',     label: 'WFH',      color: '#6366f1' },
              ].map(({ key, label, color }) => (
                <div key={key} className="md-attend-item" style={{ '--ac': color }}>
                  <span className="md-attend-val">{todayAttend[key]}</span>
                  <span className="md-attend-lbl">{label}</span>
                </div>
              ))}
            </div>

            {onLeaveToday.length > 0 && (
              <div className="md-on-leave">
                <span className="md-on-leave-label">On leave today</span>
                <div className="md-on-leave-pills">
                  {onLeaveToday.slice(0, 5).map((emp, i) => (
                    <span key={i} className="md-leave-pill">
                      {emp.name || emp.employee_name || '—'}
                    </span>
                  ))}
                  {onLeaveToday.length > 5 && (
                    <span className="md-leave-pill md-leave-pill-more">+{onLeaveToday.length - 5} more</span>
                  )}
                </div>
              </div>
            )}

            <div className="md-team-list">
              {loading ? <ShimmerRows /> : teamMembers.length === 0 ? (
                <EmptyState Icon={Users} message="No team members found" />
              ) : (
                teamMembers.map((m) => {
                  const meta = STATUS_META[m.status] || STATUS_META.present;
                  return (
                    <div key={m.id || m.name} className="md-team-row">
                      <div className="md-avatar">{getInitials(m.name || m.first_name)}</div>
                      <div className="md-team-info">
                        <p className="md-team-name">{m.name || `${m.first_name} ${m.last_name}`}</p>
                        <p className="md-team-role">{m.role || m.designation}</p>
                      </div>
                      <span className="md-team-tasks">{m.tasks ?? '—'} tasks</span>
                      <span className="md-status-dot" style={{ background: meta.color }} title={meta.label} />
                      <span className="md-status-label" style={{ color: meta.color }}>{meta.label}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Pending Approvals — tabbed */}
        <div className="md-card mg6">
          <div className="md-card-hd">
            <span className="md-card-title">
              <Clock size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#f59e0b' }} />
              Pending Approvals
              {totalPending > 0 && <span className="md-badge" style={{ marginLeft: 8 }}>{totalPending}</span>}
            </span>
            <button className="md-text-btn" onClick={() => setPage('LeaveApprovals')}>
              View all <ArrowRight size={12} />
            </button>
          </div>
          <div className="md-appr-tabs">
            {apprTabs.map(({ key, label, count, Icon }) => (
              <button
                key={key}
                className={`md-appr-tab${approvalTab === key ? ' md-appr-tab-active' : ''}`}
                onClick={() => setApprovalTab(key)}
              >
                <Icon size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                {label}
                {count > 0 && <span className="md-tab-count">{count}</span>}
              </button>
            ))}
          </div>
          <div className="md-card-body">
            {loading ? <ShimmerRows /> : activeApprItems.length === 0 ? (
              <div className="md-empty">
                <CheckCircle size={32} />
                <p>No pending {approvalTab} approvals.</p>
              </div>
            ) : (
              activeApprItems.map((item) => {
                const name = item.employee || item.employee_name || item.name || '—';
                return (
                  <div key={item.id} className="md-appr-row">
                    <div className="md-avatar md-avatar-sm">{getInitials(name)}</div>
                    <div className="md-appr-info">
                      <span className="md-appr-name">{name}</span>
                      {approvalTab === 'leave' && (
                        <>
                          <span className="md-appr-meta">{item.type || item.leave_type}</span>
                          <span className="md-appr-detail">
                            {item.dates || item.start_date}
                            {item.days && ` · ${item.days} day${item.days > 1 ? 's' : ''}`}
                          </span>
                        </>
                      )}
                      {approvalTab === 'timesheet' && (
                        <>
                          <span className="md-appr-meta">Timesheet</span>
                          <span className="md-appr-detail">
                            {item.period || item.week || item.start_date}
                            {item.hours && ` · ${item.hours} hrs`}
                          </span>
                        </>
                      )}
                      {approvalTab === 'travel' && (
                        <>
                          <span className="md-appr-meta">{item.destination || 'Travel Request'}</span>
                          <span className="md-appr-detail">
                            {item.dates || item.start_date}
                            {item.amount && ` · ₹${item.amount.toLocaleString('en-IN')}`}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="md-appr-actions">
                      <button className="md-btn-approve" title="Approve" onClick={() => handleApprove(item)}>
                        <CheckCircle size={14} />
                      </button>
                      <button className="md-btn-reject" title="Reject" onClick={() => handleReject(item)}>
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Row 2: Budget Chart + Team Performance ──────────────────────────── */}
      <div className="md-grid" style={{ marginBottom: 12 }}>
        <div className="md-card mg8">
          <div className="md-card-hd">
            <span className="md-card-title">
              <TrendingUp size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#8b5cf6' }} />
              Department Budget vs Actual
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="md-card-sub">Current month (₹)</span>
              {budgetData.length > 0 && (
                <ChartExpandButton title="Department Budget vs Actual" subtitle="Current month (₹)">
                  {budgetChart(440)}
                </ChartExpandButton>
              )}
            </span>
          </div>
          <div className="md-card-body">
            {budgetData.length === 0 ? (
              <EmptyState Icon={BarChart2} message="No budget data available" />
            ) : (
              <>
                {budgetChart(190)}
                <div className="md-budget-legend">
                  <span><span className="md-leg-dot" style={{ background: '#a5b4fc' }} />Budget</span>
                  <span><span className="md-leg-dot" style={{ background: '#6366f1' }} />Actual</span>
                  <span><span className="md-leg-dot" style={{ background: '#ef4444' }} />Over Budget</span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="md-card mg4">
          <div className="md-card-hd">
            <span className="md-card-title">
              <Award size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#f59e0b' }} />
              Team Performance
            </span>
          </div>
          <div className="md-card-body">
            {teamMembers.length === 0 ? (
              <EmptyState Icon={Users} message="No team data available" />
            ) : (
              teamMembers.map((m) => (
                <div key={m.id || m.name} className="md-perf-row">
                  <div className="md-avatar md-avatar-sm">{getInitials(m.name || m.first_name)}</div>
                  <div className="md-perf-info">
                    <span className="md-perf-name">{m.name || `${m.first_name} ${m.last_name}`}</span>
                    <div className="md-perf-bar-wrap">
                      <div className="md-perf-bar" style={{ width: `${((m.rating || 0) / 5) * 100}%` }} />
                    </div>
                  </div>
                  <span className="md-perf-rating">
                    <Award size={11} />
                    {(m.rating || 0).toFixed(1)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── Row 3: Direct Reports + Team Capacity ───────────────────────────── */}
      <div className="md-grid" style={{ marginBottom: 12 }}>

        {/* Direct Reports Hierarchy */}
        <div className="md-card mg5">
          <div className="md-card-hd">
            <span className="md-card-title">
              <GitBranch size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#6366f1' }} />
              Direct Reports
            </span>
            <span className="md-card-sub">{directReports.length} report{directReports.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="md-card-body">
            {loading ? <ShimmerRows /> : directReports.length === 0 ? (
              <EmptyState Icon={GitBranch} message="No direct reports found" />
            ) : (
              directReports.map((m) => {
                const name = m.name || `${m.first_name || ''} ${m.last_name || ''}`.trim();
                const meta = STATUS_META[m.status] || STATUS_META.present;
                return (
                  <div key={m.id || name} className="md-dr-row">
                    <div className="md-avatar">{getInitials(name)}</div>
                    <div className="md-team-info">
                      <p className="md-team-name">{name}</p>
                      <p className="md-team-role">{m.role || m.designation || m.department}</p>
                    </div>
                    {(m.reports_count > 0) && (
                      <span className="md-dr-badge">
                        <Users size={10} style={{ marginRight: 3 }} />
                        {m.reports_count}
                      </span>
                    )}
                    <span className="md-status-dot" style={{ background: meta.color }} title={meta.label} />
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Team Capacity */}
        <div className="md-card mg7">
          <div className="md-card-hd">
            <span className="md-card-title">
              <Activity size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#06b6d4' }} />
              Team Capacity — This Week
            </span>
            <span className="md-card-sub">Allocated vs available hours</span>
          </div>
          <div className="md-card-body">
            {loading ? <ShimmerRows /> : teamCapacity.length === 0 ? (
              <EmptyState Icon={Zap} message="No capacity data available" />
            ) : (
              teamCapacity.map((m) => {
                const name = m.name || m.employee_name || '—';
                const pct  = m.capacity_hours > 0
                  ? Math.min(100, Math.round((m.allocated_hours / m.capacity_hours) * 100))
                  : 0;
                const cc = capColor(pct);
                return (
                  <div key={m.id || name} className="md-cap-row">
                    <div className="md-avatar md-avatar-sm">{getInitials(name)}</div>
                    <div className="md-cap-info">
                      <div className="md-cap-header">
                        <span className="md-perf-name">{name}</span>
                        <span className="md-cap-pct" style={{ color: cc }}>{pct}%</span>
                      </div>
                      <div className="md-perf-bar-wrap">
                        <div className="md-perf-bar" style={{ width: `${pct}%`, background: cc }} />
                      </div>
                      <span className="md-cap-sub">
                        {m.allocated_hours ?? 0}h / {m.capacity_hours ?? 40}h
                        {m.projects > 0 && ` · ${m.projects} project${m.projects > 1 ? 's' : ''}`}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Row 4: Team Targets vs Actuals (shown only when data exists) ─────── */}
      {targetsData.length > 0 && (
        <div className="md-grid" style={{ marginBottom: 12 }}>
          <div className="md-card mg12">
            <div className="md-card-hd">
              <span className="md-card-title">
                <TrendingUp size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#10b981' }} />
                Team Targets vs Actuals
              </span>
              <span className="md-card-sub">Current quarter</span>
            </div>
            <div className="md-card-body">
              <div className="md-targets-grid">
                {targetsData.map((t, i) => {
                  const pct  = t.target > 0 ? Math.min(120, Math.round((t.actual / t.target) * 100)) : 0;
                  const over = t.actual >= t.target;
                  return (
                    <div key={i} className="md-target-item">
                      <div className="md-target-header">
                        <span className="md-target-label">{t.metric}</span>
                        <span className="md-target-pct" style={{ color: over ? '#10b981' : '#6b7280' }}>
                          {pct}%
                        </span>
                      </div>
                      <div className="md-perf-bar-wrap" style={{ height: 6 }}>
                        <div
                          className="md-perf-bar"
                          style={{
                            width: `${Math.min(100, pct)}%`,
                            background: over ? '#10b981' : '#6366f1',
                            height: 6,
                          }}
                        />
                      </div>
                      <div className="md-target-foot">
                        <span>Actual: <strong>{fmtMetric(t.actual)}</strong></span>
                        <span>Target: {fmtMetric(t.target)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Drawers ──────────────────────────────────────────────────────────── */}
      <AnnouncementDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onPost={handlePostAnnouncement}
      />
      <MeetingDrawer
        open={meetingOpen}
        onClose={() => setMeetingOpen(false)}
        teamMembers={teamMembers}
        onSchedule={handleScheduleMeeting}
      />
    </div>
  );
}
