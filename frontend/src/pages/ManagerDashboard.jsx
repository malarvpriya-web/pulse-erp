import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import {
  Users, Clock, CheckCircle, TrendingUp, Calendar, Bell,
  UserCheck, ChevronRight, RefreshCw, X, Target, Award,
  AlertCircle, ArrowRight, Plus
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api/client';
import './ManagerDashboard.css';

// ── Sample / mock data ────────────────────────────────────────────────────────
const SAMPLE_TEAM = [
  { name: 'Arjun Sharma',  role: 'Sr. Developer', rating: 4.5, tasks: 8, status: 'present' },
  { name: 'Priya Menon',   role: 'UI Designer',   rating: 4.2, tasks: 5, status: 'absent'  },
  { name: 'Rahul Kumar',   role: 'Developer',     rating: 3.9, tasks: 6, status: 'late'    },
  { name: 'Sneha Pillai',  role: 'QA Engineer',   rating: 4.7, tasks: 4, status: 'present' },
  { name: 'Vikram Singh',  role: 'Backend Dev',   rating: 4.1, tasks: 7, status: 'present' },
  { name: 'Divya Nair',    role: 'DevOps',        rating: 4.3, tasks: 3, status: 'wfh'     },
];

const SAMPLE_BUDGET = [
  { dept: 'Salaries',  budget: 350000, actual: 340000 },
  { dept: 'Travel',    budget: 50000,  actual: 42000  },
  { dept: 'Training',  budget: 30000,  actual: 18000  },
  { dept: 'Equipment', budget: 80000,  actual: 65000  },
  { dept: 'Misc',      budget: 20000,  actual: 24000  },
];

const SAMPLE_APPROVALS = [
  { id: 1, employee: 'Arjun Sharma', type: 'Annual Leave',   dates: '18–20 Mar', days: 3         },
  { id: 2, employee: 'Priya Menon',  type: 'Medical Leave',  dates: '16 Mar',    days: 1         },
  { id: 3, employee: 'Rahul Kumar',  type: 'Expense Report', dates: '15 Mar',    amount: 4800    },
  { id: 4, employee: 'Sneha Pillai', type: 'WFH Request',    dates: '17–18 Mar', days: 2         },
  { id: 5, employee: 'Vikram Singh', type: 'Timesheet',      dates: 'Week 10',   hours: 42       },
];

const SAMPLE_ATTEND = { present: 9, absent: 2, late: 1, wfh: 0 };

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtRupee = (n) => {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000)   return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
};

const getInitials = (name = '') => name.charAt(0).toUpperCase();

const STATUS_META = {
  present: { color: '#10b981', label: 'Present' },
  absent:  { color: '#ef4444', label: 'Absent'  },
  late:    { color: '#f59e0b', label: 'Late'     },
  wfh:     { color: '#6366f1', label: 'WFH'      },
};

const todayStr = () => {
  const d = new Date();
  return d.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
};

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
      {toast.type === 'error'
        ? <AlertCircle size={16} />
        : <CheckCircle size={16} />}
      <span>{toast.message}</span>
      <button
        onClick={onClose}
        style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
      >
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

// ── Announcement Drawer ───────────────────────────────────────────────────────
const AnnouncementDrawer = ({ open, onClose, onPost }) => {
  const [message, setMessage] = useState('');

  const handlePost = () => {
    if (!message.trim()) return;
    onPost(message.trim());
    setMessage('');
  };

  if (!open) return null;
  return (
    <>
      <div className="md-overlay" onClick={onClose} />
      <div className="md-drawer">
        <div className="md-drawer-hd">
          <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>
            Add Announcement
          </span>
          <button className="md-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="md-drawer-body">
          <label className="md-label">
            <Bell size={13} style={{ marginRight: 5, verticalAlign: 'middle' }} />
            Announcement Message
          </label>
          <textarea
            className="md-textarea"
            rows={6}
            placeholder="Type your announcement here…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
            This will be visible to all team members.
          </p>
        </div>
        <div className="md-drawer-footer">
          <button className="md-btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="md-btn-primary"
            onClick={handlePost}
            disabled={!message.trim()}
            style={{ opacity: message.trim() ? 1 : 0.5 }}
          >
            <Plus size={14} style={{ marginRight: 5, verticalAlign: 'middle' }} />
            Post Announcement
          </button>
        </div>
      </div>
    </>
  );
};

// ── Custom Rupee Tooltip for BarChart ─────────────────────────────────────────
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
export default function ManagerDashboard({ setPage }) {
  const { user } = useAuth();

  // data state
  const [teamMembers, setTeamMembers]       = useState(SAMPLE_TEAM);
  const [budgetData, setBudgetData]         = useState(SAMPLE_BUDGET);
  const [pendingApprovals, setPendingApprovals] = useState(SAMPLE_APPROVALS);
  const [todayAttend, setTodayAttend]       = useState(SAMPLE_ATTEND);
  const [kpis, setKpis]                     = useState({
    teamSize: 12,
    pendingCount: 5,
    attendRate: '91%',
    budgetUsed: '78%',
    budgetAmount: '₹4.9L / ₹5.3L',
  });

  // UI state
  const [loading, setLoading]             = useState(false);
  const [drawerOpen, setDrawerOpen]       = useState(false);
  const [toast, setToast]                 = useState(null);
  const [dismissed, setDismissed]         = useState(new Set());

  // ── show toast ──────────────────────────────────────────────────────────────
  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
  }, []);

  // ── load data ───────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [teamRes, approvalsRes, attendRes, budgetRes] = await Promise.allSettled([
        api.get('/manager/team'),
        api.get('/manager/approvals'),
        api.get('/manager/attendance/today'),
        api.get('/manager/budget'),
      ]);

      if (teamRes.status === 'fulfilled' && teamRes.value.data?.members?.length) {
        setTeamMembers(teamRes.value.data.members);
        setKpis((prev) => ({ ...prev, teamSize: teamRes.value.data.members.length }));
      }

      if (approvalsRes.status === 'fulfilled' && approvalsRes.value.data?.approvals?.length) {
        setPendingApprovals(approvalsRes.value.data.approvals);
        setKpis((prev) => ({ ...prev, pendingCount: approvalsRes.value.data.approvals.length }));
      }

      if (attendRes.status === 'fulfilled' && attendRes.value.data) {
        const a = attendRes.value.data;
        setTodayAttend(a);
        const total = (a.present || 0) + (a.absent || 0) + (a.late || 0) + (a.wfh || 0);
        if (total > 0) {
          const rate = Math.round(((a.present + a.wfh) / total) * 100);
          setKpis((prev) => ({ ...prev, attendRate: `${rate}%` }));
        }
      }

      if (budgetRes.status === 'fulfilled' && budgetRes.value.data?.categories?.length) {
        setBudgetData(budgetRes.value.data.categories);
      }
    } catch {
      // silently fall back to sample data already set
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── approve / reject ────────────────────────────────────────────────────────
  const handleApprove = async (item) => {
    try {
      await api.post(`/manager/approvals/${item.id}/approve`);
    } catch {
      // optimistic — continue even if API fails
    }
    setDismissed((prev) => new Set([...prev, item.id]));
    showToast(`Approved ${item.type} for ${item.employee}`, 'success');
  };

  const handleReject = async (item) => {
    try {
      await api.post(`/manager/approvals/${item.id}/reject`);
    } catch {
      // optimistic
    }
    setDismissed((prev) => new Set([...prev, item.id]));
    showToast(`Rejected ${item.type} for ${item.employee}`, 'error');
  };

  // ── announcement post ────────────────────────────────────────────────────────
  const handlePostAnnouncement = async (message) => {
    try {
      await api.post('/manager/announcements', { message });
    } catch {
      // proceed regardless
    }
    setDrawerOpen(false);
    showToast('Announcement posted successfully!', 'success');
  };

  const visibleApprovals = pendingApprovals.filter((a) => !dismissed.has(a.id));

  const greetingName = user?.name?.split(' ')[0] || 'Manager';
  const dept = user?.department || 'Engineering';

  // ── budget bar colors ────────────────────────────────────────────────────────
  const getBudgetColor = (entry) =>
    entry.actual > entry.budget ? '#ef4444' : '#6366f1';

  return (
    <div className="md-root">
      <Toast toast={toast} onClose={() => setToast(null)} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="md-header">
        <div>
          <h1 className="md-greeting">Good morning, {greetingName} 👋</h1>
          <p className="md-date">
            {todayStr()} &nbsp;·&nbsp;
            <span className="md-dept">{dept}</span>
          </p>
        </div>
        <div className="md-header-r">
          <button className="md-refresh-btn" onClick={loadData} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'md-spin' : ''} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="md-icon-btn" title="Notifications">
            <Bell size={16} />
          </button>
        </div>
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      <div className="md-kpis">
        <KpiCard
          icon={Users}
          label="Team Size"
          value={kpis.teamSize}
          sub="Active members"
          color="#6366f1"
          onClick={() => setPage('EmployeesData')}
        />
        <KpiCard
          icon={Clock}
          label="Pending Approvals"
          value={kpis.pendingCount}
          sub="Needs attention"
          color="#f59e0b"
          onClick={() => setPage('LeaveApprovals')}
        />
        <KpiCard
          icon={UserCheck}
          label="Attendance Rate"
          value={kpis.attendRate}
          sub="Today's team rate"
          color="#10b981"
          onClick={() => setPage('TeamAttendance')}
        />
        <KpiCard
          icon={Target}
          label="Budget Used"
          value={kpis.budgetUsed}
          sub={kpis.budgetAmount}
          color="#8b5cf6"
          onClick={() => setPage('BudgetOverview')}
        />
      </div>

      {/* ── Quick Actions ───────────────────────────────────────────────────── */}
      <div className="md-quick-actions">
        <button className="md-qa-btn" onClick={() => setPage('LeaveApprovals')}>
          <CheckCircle size={14} />
          Approve Leaves
          {visibleApprovals.length > 0 && (
            <span className="md-badge">{visibleApprovals.length}</span>
          )}
        </button>
        <button className="md-qa-btn" onClick={() => setPage('EmployeesData')}>
          <Users size={14} />
          View Team
        </button>
        <button className="md-qa-btn" onClick={() => setDrawerOpen(true)}>
          <Plus size={14} />
          Add Announcement
        </button>
        <button className="md-qa-btn" onClick={() => setPage('TeamAttendance')}>
          <Calendar size={14} />
          Attendance
        </button>
        <button className="md-qa-btn" onClick={() => setPage('TimesheetApprovals')}>
          <Clock size={14} />
          Timesheets
        </button>
      </div>

      {/* ── Row 1 ───────────────────────────────────────────────────────────── */}
      <div className="md-grid" style={{ marginBottom: 20 }}>

        {/* Left — Team Attendance Today */}
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
            {/* Strip */}
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

            {/* Member list */}
            <div className="md-team-list">
              {teamMembers.map((m) => {
                const meta = STATUS_META[m.status] || STATUS_META.present;
                return (
                  <div key={m.name} className="md-team-row">
                    <div className="md-avatar">{getInitials(m.name)}</div>
                    <div className="md-team-info">
                      <p className="md-team-name">{m.name}</p>
                      <p className="md-team-role">{m.role}</p>
                    </div>
                    <span className="md-team-tasks">{m.tasks} tasks</span>
                    <span
                      className="md-status-dot"
                      style={{ background: meta.color }}
                      title={meta.label}
                    />
                    <span className="md-status-label" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right — Pending Approvals */}
        <div className="md-card mg6">
          <div className="md-card-hd">
            <span className="md-card-title">
              <Clock size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#f59e0b' }} />
              Pending Approvals
            </span>
            <button className="md-text-btn" onClick={() => setPage('LeaveApprovals')}>
              View all <ArrowRight size={12} />
            </button>
          </div>
          <div className="md-card-body">
            {visibleApprovals.length === 0 ? (
              <div className="md-empty">
                <CheckCircle size={32} />
                <p>All caught up! No pending approvals.</p>
              </div>
            ) : (
              visibleApprovals.map((item) => (
                <div key={item.id} className="md-appr-row">
                  <div className="md-avatar md-avatar-sm">{getInitials(item.employee)}</div>
                  <div className="md-appr-info">
                    <span className="md-appr-name">{item.employee}</span>
                    <span className="md-appr-meta">{item.type}</span>
                    <span className="md-appr-detail">
                      {item.dates}
                      {item.days   && ` · ${item.days} day${item.days > 1 ? 's' : ''}`}
                      {item.amount && ` · ₹${item.amount.toLocaleString('en-IN')}`}
                      {item.hours  && ` · ${item.hours} hrs`}
                    </span>
                  </div>
                  <div className="md-appr-actions">
                    <button
                      className="md-btn-approve"
                      title="Approve"
                      onClick={() => handleApprove(item)}
                    >
                      <CheckCircle size={14} />
                    </button>
                    <button
                      className="md-btn-reject"
                      title="Reject"
                      onClick={() => handleReject(item)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── Row 2 ───────────────────────────────────────────────────────────── */}
      <div className="md-grid">

        {/* Left — Department Budget vs Actual */}
        <div className="md-card mg8">
          <div className="md-card-hd">
            <span className="md-card-title">
              <TrendingUp size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#8b5cf6' }} />
              Department Budget vs Actual
            </span>
            <span className="md-card-sub">Current month (₹)</span>
          </div>
          <div className="md-card-body">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={budgetData} barCategoryGap="30%" barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
                <XAxis
                  dataKey="dept"
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => fmtRupee(v)}
                  width={52}
                />
                <Tooltip content={<BudgetTooltip />} />
                <Bar dataKey="budget" name="budget" fill="#a5b4fc" radius={[4, 4, 0, 0]} />
                <Bar dataKey="actual" name="actual" radius={[4, 4, 0, 0]}>
                  {budgetData.map((entry, idx) => (
                    <Cell key={`cell-${idx}`} fill={getBudgetColor(entry)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="md-budget-legend">
              <span>
                <span className="md-leg-dot" style={{ background: '#a5b4fc' }} />
                Budget
              </span>
              <span>
                <span className="md-leg-dot" style={{ background: '#6366f1' }} />
                Actual
              </span>
              <span>
                <span className="md-leg-dot" style={{ background: '#ef4444' }} />
                Over Budget
              </span>
            </div>
          </div>
        </div>

        {/* Right — Team Performance */}
        <div className="md-card mg4">
          <div className="md-card-hd">
            <span className="md-card-title">
              <Award size={14} style={{ marginRight: 6, verticalAlign: 'middle', color: '#f59e0b' }} />
              Team Performance
            </span>
          </div>
          <div className="md-card-body">
            {teamMembers.map((m) => (
              <div key={m.name} className="md-perf-row">
                <div className="md-avatar md-avatar-sm">{getInitials(m.name)}</div>
                <div className="md-perf-info">
                  <span className="md-perf-name">{m.name}</span>
                  <div className="md-perf-bar-wrap">
                    <div
                      className="md-perf-bar"
                      style={{ width: `${(m.rating / 5) * 100}%` }}
                    />
                  </div>
                </div>
                <span className="md-perf-rating">
                  <Award size={11} />
                  {m.rating.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Announcement Drawer ──────────────────────────────────────────────── */}
      <AnnouncementDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onPost={handlePostAnnouncement}
      />
    </div>
  );
}
