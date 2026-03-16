import { useState, useEffect, useCallback } from 'react';
import { Users, CheckSquare, Clock, Bell, TrendingUp, Calendar,
  FolderKanban, DollarSign, Briefcase, RefreshCw,
  ChevronRight, Gift, Megaphone } from 'lucide-react';
import api from '@/services/api/client';
import './Home.css';

const QUICK_LINKS = [
  { label: 'Employees',    page: 'EmployeesDashboard', icon: Users,        color: '#6366f1' },
  { label: 'Projects',     page: 'ProjectsDashboard',  icon: FolderKanban, color: '#3b82f6' },
  { label: 'Finance',      page: 'FinanceDashboardNew',icon: DollarSign,   color: '#10b981' },
  { label: 'CRM',          page: 'SalesDashboard',     icon: TrendingUp,   color: '#f59e0b' },
  { label: 'My Leaves',    page: 'MyLeaves',            icon: Calendar,     color: '#8b5cf6' },
  { label: 'Timesheets',   page: 'MyTimesheet',         icon: Clock,        color: '#ef4444' },
  { label: 'Approvals',    page: 'ApprovalCenter',      icon: Bell,         color: '#14b8a6' },
  { label: 'Recruitment',  page: 'RecruitmentDashboard',icon: Briefcase,    color: '#f97316' },
];

const SAMPLE_APPROVALS = [
  { id: 1, type: 'Leave',     from: 'Ravi Kumar',  detail: 'Annual Leave · 3 days',    ts: '2026-03-15T08:30:00' },
  { id: 2, type: 'Expense',   from: 'Priya Sharma',detail: 'Travel Expense · ₹4,200',  ts: '2026-03-15T07:50:00' },
  { id: 3, type: 'Timesheet', from: 'Anand Menon', detail: 'Week of Mar 9–15',          ts: '2026-03-14T18:00:00' },
];

const SAMPLE_TASKS = [
  { id: 1, title: 'Review API integration docs',  project: 'ERP Implementation', priority: 'High',   status: 'in_progress' },
  { id: 2, title: 'Update deployment checklist',  project: 'Cloud Migration',     priority: 'Medium', status: 'todo' },
  { id: 3, title: 'UAT sign-off meeting',         project: 'Data Analytics',      priority: 'High',   status: 'todo' },
];

const SAMPLE_CELEBRATIONS = [
  { name: 'Vijay Nair',    type: 'Birthday',         department: 'Marketing' },
  { name: 'Meena Raj',     type: 'Work Anniversary', department: 'HR', years: 3 },
];

const PRIORITY_COLORS = {
  High:   { bg: '#fee2e2', color: '#dc2626' },
  Medium: { bg: '#fef3c7', color: '#92400e' },
  Low:    { bg: '#f3f4f6', color: '#6b7280' },
};

const timeAgo = ts => {
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (d < 60) return `${d}m ago`;
  const h = Math.floor(d / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

const ROLE_LABEL = {
  super_admin: 'Super Administrator', admin: 'Administrator',
  manager: 'Manager', department_head: 'Department Head', employee: 'Employee',
};

export default function Home({ setPage }) {
  const [announcements,  setAnnouncements]  = useState([]);
  const [celebrations,   setCelebrations]   = useState([]);
  const [approvals,      setApprovals]      = useState([]);
  const [tasksToday,     setTasksToday]     = useState([]);
  const [kpis,           setKpis]           = useState({ attendance: 0, pendingApprovals: 0, openTasks: 0, totalEmployees: 0 });
  const [loading,        setLoading]        = useState(true);

  const user     = JSON.parse(localStorage.getItem('user') || '{}');
  const userName = user.name || user.username || 'there';
  const role     = user.role || localStorage.getItem('role') || 'employee';

  const load = useCallback(async () => {
    setLoading(true);
    const [annRes, celRes, apprRes, taskRes] = await Promise.allSettled([
      api.get('/home/announcements'),
      api.get('/home/celebrations'),
      api.get('/dashboard/approvals'),
      api.get('/projects/tasks', { params: { due_today: true } }),
    ]);

    const anns = annRes.status === 'fulfilled' ? (annRes.value.data || []) : [];
    setAnnouncements(anns);

    const cels = celRes.status === 'fulfilled' ? (celRes.value.data || []) : [];
    setCelebrations(cels.length ? cels : SAMPLE_CELEBRATIONS);

    const apprData = apprRes.status === 'fulfilled' ? apprRes.value.data : null;
    const apprList = apprData?.pending || [];
    setApprovals(apprList.length ? apprList.slice(0, 5) : SAMPLE_APPROVALS);
    setKpis(prev => ({ ...prev, pendingApprovals: apprData?.total || SAMPLE_APPROVALS.length }));

    const rawTasks = taskRes.status === 'fulfilled' ? (taskRes.value.data.tasks || taskRes.value.data) : [];
    setTasksToday(Array.isArray(rawTasks) && rawTasks.length ? rawTasks.slice(0, 5) : SAMPLE_TASKS);
    setKpis(prev => ({ ...prev, openTasks: rawTasks.length || SAMPLE_TASKS.length }));

    // Static-ish KPIs
    setKpis(prev => ({ ...prev, attendance: 94, totalEmployees: 42 }));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="hm-root">

      {/* welcome hero */}
      <div className="hm-hero">
        <div className="hm-hero-l">
          <p className="hm-greeting">{greeting()},</p>
          <h2 className="hm-name">{userName}</h2>
          <span className="hm-role-badge">{ROLE_LABEL[role] || 'Employee'}</span>
          <p className="hm-date">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="hm-hero-r">
          <div className="hm-hero-kpi">
            <span className="hm-hero-kpi-val">{kpis.attendance}%</span>
            <span className="hm-hero-kpi-label">Attendance Today</span>
          </div>
          <div className="hm-hero-kpi">
            <span className="hm-hero-kpi-val" style={{ color: kpis.pendingApprovals > 0 ? '#ef4444' : 'inherit' }}>
              {kpis.pendingApprovals}
            </span>
            <span className="hm-hero-kpi-label">Pending Approvals</span>
          </div>
          <div className="hm-hero-kpi">
            <span className="hm-hero-kpi-val">{kpis.openTasks}</span>
            <span className="hm-hero-kpi-label">Tasks Due Today</span>
          </div>
        </div>
      </div>

      {/* quick links */}
      <div className="hm-section">
        <div className="hm-section-hd">
          <span className="hm-section-title">Quick Access</span>
          <button className="hm-icon-btn" onClick={load}><RefreshCw size={13} /></button>
        </div>
        <div className="hm-quick-grid">
          {QUICK_LINKS.map(({ label, page, icon: Icon, color }) => (
            <button key={page} className="hm-quick-card" style={{ '--c': color }}
              onClick={() => setPage && setPage(page)}>
              <div className="hm-quick-icon"><Icon size={20} /></div>
              <span className="hm-quick-label">{label}</span>
              <ChevronRight size={13} className="hm-quick-arrow" />
            </button>
          ))}
        </div>
      </div>

      {/* main grid */}
      <div className="hm-grid">

        {/* My Tasks Today */}
        <div className="hm-card">
          <div className="hm-card-hd">
            <span className="hm-card-title"><CheckSquare size={14} style={{ marginRight: 6 }} />My Tasks Today</span>
            <button className="hm-text-btn" onClick={() => setPage && setPage('KanbanBoard')}>
              Board <ChevronRight size={12} />
            </button>
          </div>
          <div className="hm-card-body">
            {tasksToday.length === 0 ? (
              <p className="hm-empty">No tasks due today</p>
            ) : tasksToday.map((t, i) => {
              const pc = PRIORITY_COLORS[t.priority] || PRIORITY_COLORS.Low;
              return (
                <div key={t.id || i} className="hm-task-row">
                  <div className={`hm-task-dot hm-dot-${t.status}`} />
                  <div className="hm-task-info">
                    <span className="hm-task-title">{t.task_title || t.title}</span>
                    <span className="hm-task-proj">{t.project_name || t.project}</span>
                  </div>
                  <span className="hm-priority-badge" style={{ background: pc.bg, color: pc.color }}>
                    {t.priority}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="hm-card">
          <div className="hm-card-hd">
            <span className="hm-card-title"><Bell size={14} style={{ marginRight: 6 }} />Pending Approvals</span>
            <button className="hm-text-btn" onClick={() => setPage && setPage('ApprovalCenter')}>
              View All <ChevronRight size={12} />
            </button>
          </div>
          <div className="hm-card-body">
            {approvals.length === 0 ? (
              <p className="hm-empty">No pending approvals</p>
            ) : approvals.map((a, i) => (
              <div key={a.id || i} className="hm-appr-row">
                <div className="hm-appr-avatar">
                  {(a.from || a.employee_name || 'U').charAt(0)}
                </div>
                <div className="hm-appr-info">
                  <span className="hm-appr-from">{a.from || a.employee_name}</span>
                  <span className="hm-appr-detail">{a.detail || `${a.type}`}</span>
                </div>
                <div>
                  <span className="hm-type-badge">{a.type}</span>
                  <div className="hm-appr-time">{a.ts ? timeAgo(a.ts) : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Announcements */}
        <div className="hm-card">
          <div className="hm-card-hd">
            <span className="hm-card-title"><Megaphone size={14} style={{ marginRight: 6 }} />Announcements</span>
          </div>
          <div className="hm-card-body hm-scroll">
            {announcements.length === 0 ? (
              <p className="hm-empty">No recent announcements</p>
            ) : announcements.slice(0, 5).map(ann => (
              <div key={ann.id} className="hm-ann-row">
                <div className="hm-ann-title">{ann.title}</div>
                <div className="hm-ann-msg">{ann.message}</div>
                {ann.created_at && (
                  <div className="hm-ann-date">
                    {new Date(ann.created_at).toLocaleDateString('en-IN')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Today's Celebrations */}
        <div className="hm-card">
          <div className="hm-card-hd">
            <span className="hm-card-title"><span style={{ marginRight: 6 }}>🎉</span>Today's Celebrations</span>
          </div>
          <div className="hm-card-body">
            {celebrations.length === 0 ? (
              <p className="hm-empty">No celebrations today</p>
            ) : celebrations.map((c, i) => (
              <div key={i} className="hm-cel-row">
                <div className="hm-cel-icon">
                  {c.type === 'Birthday' ? '🎂' : '🎊'}
                </div>
                <div className="hm-cel-info">
                  <div className="hm-cel-name">{c.name}</div>
                  <div className="hm-cel-dept">{c.department}</div>
                </div>
                <div className="hm-cel-type">
                  {c.type}{c.years ? ` · ${c.years}y` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
