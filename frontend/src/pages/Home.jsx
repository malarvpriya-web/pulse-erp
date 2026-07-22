import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  CheckSquare, Clock, Bell,
  RefreshCw, Megaphone, PartyPopper, CheckCheck,
  FileText, Download, LogIn, LogOut, MapPin,
  Inbox, Send, ShieldCheck, Sparkles,
  Users, KeyRound, Lock, Activity, History,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { canRoleSeeSection } from '@/config/menuCatalog';
import { ProgressRing } from '@/components/charts/PulseViz';
import FaceClockModal, { getLocationString } from '@/components/attendance/FaceClockModal';
import './Home.css';

const CelebrationsBoard = lazy(() => import('@/components/dashboard/CelebrationsBoard'));

// Panel B name (chosen from the provided options) — brand assets & templates.
const BRAND_VAULT_LABEL = 'Brand Vault';

const PRIORITY_META = {
  critical: { bg: 'var(--color-danger-bg)',  color: 'var(--color-danger-text)',  label: 'Critical' },
  high:     { bg: 'var(--color-danger-bg)',  color: 'var(--color-danger-text)',  label: 'High'     },
  medium:   { bg: 'var(--color-warning-bg)', color: 'var(--color-warning-text)', label: 'Medium'   },
  low:      { bg: '#f3f4f6',                 color: 'var(--color-text-sec)',      label: 'Low'      },
};
const pm = p => PRIORITY_META[(p || '').toLowerCase()] || PRIORITY_META.low;

const STATUS_DOT = { in_progress: 'var(--color-warning)', todo: 'var(--color-text-muted)', done: 'var(--color-success)', review: '#3b82f6', blocked: 'var(--color-danger)' };

// Super Admin console — the 6 governance screens the role actually opens daily,
// surfaced on Home so they don't have to be found through the same flyouts as
// a data-entry role's ~300 pages.
const CONSOLE_LINKS = [
  { label: 'Access Control',  page: 'AccessControl', icon: ShieldCheck },
  { label: 'Users',           page: 'UserSetup',     icon: Users },
  { label: 'Roles',           page: 'RolesSetup',    icon: KeyRound },
  { label: 'Security Center', page: 'SecurityCenter',icon: Lock },
  { label: 'System Health',   page: 'SystemHealth',  icon: Activity },
  { label: 'Audit Logs',      page: 'AuditLogs',     icon: History },
];

const ROLE_LABEL = {
  super_admin: 'Super Admin', superadmin: 'Super Admin', admin: 'Administrator',
  manager: 'Manager', department_head: 'Department Head',
  hr: 'HR', hr_manager: 'HR Manager', finance: 'Finance',
  executive: 'Executive', ceo: 'CEO', employee: 'Employee',
};

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

const timeAgo = ts => {
  if (!ts) return '';
  const d = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (d < 1) return 'just now';
  if (d < 60) return `${d}m ago`;
  if (d < 1440) return `${Math.floor(d / 60)}h ago`;
  return `${Math.floor(d / 1440)}d ago`;
};

const fmtShortDate = str => {
  if (!str) return '';
  return new Date(String(str).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};
const fmtLongDate = str => {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const fmtINR = (n) => {
  if (!n || isNaN(n)) return '₹0';
  const num = parseFloat(n);
  if (num >= 1e7) return `₹${(num / 1e7).toFixed(1)}Cr`;
  if (num >= 1e5) return `₹${(num / 1e5).toFixed(1)}L`;
  if (num >= 1000) return `₹${(num / 1000).toFixed(1)}K`;
  return `₹${Math.round(num)}`;
};

// "HH:MM" from a DB time string / timestamp
const fmtClock = t => {
  if (!t) return '';
  const s = String(t);
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : s.slice(0, 5);
};
const normalizeAttendance = r => r ? {
  ...r,
  check_in:  r.check_in  ?? r.check_in_time  ?? null,
  check_out: r.check_out ?? r.check_out_time ?? null,
} : null;

/* ── small reusable rows ─────────────────────────────────────────────────── */
const TaskRow = ({ t }) => {
  const p   = pm(t.priority);
  const dot = STATUS_DOT[(t.status || '').toLowerCase()] || '#9ca3af';
  return (
    <div className="hm-task-row">
      <span className="hm-task-dot" style={{ background: dot }} />
      <div className="hm-task-info">
        <span className="hm-task-title">{t.task_title || t.title}</span>
        <span className="hm-task-meta">
          {t.project_name && <span className="hm-tag hm-tag-proj">{t.project_name}</span>}
          {t.due_date && <span className="hm-tag hm-tag-due"><Clock size={9} /> {fmtShortDate(t.due_date)}</span>}
        </span>
      </div>
      <span className="hm-priority-badge" style={{ background: p.bg, color: p.color }}>{p.label}</span>
    </div>
  );
};

const ApprovalRow = ({ a }) => {
  const initials = (a.requested_by || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="hm-appr-row">
      <div className="hm-appr-avatar">{initials}</div>
      <div className="hm-appr-info">
        <span className="hm-appr-from">{a.requested_by || 'Unknown'}</span>
        <span className="hm-appr-detail">{a.request_title || a.title || ''}</span>
        <span className="hm-appr-time">{timeAgo(a.request_date || a.created_at)}</span>
      </div>
      <span className="hm-type-badge">{a.request_type || a.type || ''}</span>
    </div>
  );
};

const DocRow = ({ d }) => (
  <div className="hm-doc-row">
    <span className="hm-doc-icon"><FileText size={15} /></span>
    <div className="hm-doc-info">
      <span className="hm-doc-title">{d.title}</span>
      {d.description && <span className="hm-doc-desc">{d.description}</span>}
      {d.updated_at && <span className="hm-doc-date">Updated {fmtLongDate(d.updated_at)}</span>}
    </div>
    {d.file_url
      ? <a className="hm-doc-badge" href={d.file_url} target="_blank" rel="noopener noreferrer" title="View / download">
          <Download size={11} /> View
        </a>
      : <span className="hm-doc-badge hm-doc-badge--muted">Soon</span>}
  </div>
);

const CardShell = ({ icon, iconBg, title, action, children }) => (
  <div className="hm-card">
    <div className="hm-card-hd">
      <span className="hm-card-title">
        <span className={`hm-card-title-icon ${iconBg}`}>{icon}</span>
        {title}
      </span>
      {action}
    </div>
    <div className="hm-card-body">{children}</div>
  </div>
);

const Skeleton = () => <div className="hm-skeleton-list"><div className="hm-sk"/><div className="hm-sk"/><div className="hm-sk"/></div>;
const Empty = ({ icon, text }) => <div className="hm-empty-state">{icon}<p>{text}</p></div>;

export default function Home({ setPage }) {
  const { user: authUser, role: authRole } = useAuth();
  const role = (authRole || 'employee').toLowerCase();
  const isEmployee = role === 'employee';
  const isSuperAdmin = role === 'super_admin' || role === 'superadmin';
  const roleLabel = ROLE_LABEL[role] || 'Employee';
  // Same gate as the sidebar's Finance section — a role that can't reach
  // Finance from the menu must not get a Revenue tile that dead-ends on
  // Unauthorized when clicked (single source of truth: menuCatalog.js).
  const canSeeFinancials = canRoleSeeSection(role, 'Finance');

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const ctrl = useRef(null);

  // ── attendance / quick clock-in ───────────────────────────────────────────
  const [attendance, setAttendance] = useState(null);
  const [faceOpen, setFaceOpen]     = useState(false);
  const [clockLoading, setClockLoading] = useState(false);
  const [now, setNow]     = useState(new Date());
  const [toast, setToast] = useState(null);
  const empId = authUser?.employee_id;

  // Anyone linked to an employee record punches in from Home — managers, HR and
  // finance staff clock in too. Employee logins that HR never linked still get
  // the strip, with a disabled button explaining why.
  const showClockStrip = isEmployee || !!empId;

  const showToast = (msg, kind = 'ok') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3200);
  };

  const load = useCallback(async () => {
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    setLoading(true);
    try {
      const { data } = await api.get('/home/summary', { signal: ctrl.current.signal });
      setSummary(data);
      setAttendance(normalizeAttendance(data?.myAttendance));
    } catch (e) {
      if (e?.code !== 'ERR_CANCELED') setSummary(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => ctrl.current?.abort();
  }, [load]);

  // Live clock — updates the clock-in strip once a second (morning login aid).
  useEffect(() => {
    if (!showClockStrip) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [showClockStrip]);

  const clockedIn = !!attendance?.check_in && !attendance?.check_out;
  const clockDone = !!attendance?.check_in && !!attendance?.check_out;

  const handleClockAction = useCallback(async (faceData = null) => {
    if (!empId) {
      showToast('Your login is not linked to an employee record — ask HR to link it.', 'err');
      return;
    }
    setClockLoading(true);
    try {
      const isClockIn = !attendance?.check_in;
      const time = new Date().toTimeString().slice(0, 5); // "HH:MM"
      const location = isClockIn ? await getLocationString() : null;
      const { data } = await api.post('/attendance/clock', {
        employee_id: empId,
        action: isClockIn ? 'in' : 'out',
        time,
        ...(location ? { location } : {}),
        ...(faceData?.face_token ? { face_token: faceData.face_token } : {}),
      });
      setAttendance(normalizeAttendance(data));
      showToast(isClockIn ? 'Clocked in successfully!' : 'Clocked out successfully!');
    } catch (error) {
      showToast(error?.response?.data?.message || error?.response?.data?.error || 'Failed to record attendance', 'err');
    } finally {
      setClockLoading(false);
    }
  }, [attendance, empId]);

  // Clock-in runs the face flow (geo/shift policy enforced server-side); clock-out
  // punches directly — mirrors the EmployeeDashboard clock behaviour.
  const onClockClick = () => {
    if (clockedIn || !empId) handleClockAction();
    else setFaceOpen(true);
  };

  useEffect(() => {
    const refresh = () => load();
    window.addEventListener('pulse:tasks-updated', refresh);
    window.addEventListener('pulse:approvals-updated', refresh);
    return () => {
      window.removeEventListener('pulse:tasks-updated', refresh);
      window.removeEventListener('pulse:approvals-updated', refresh);
    };
  }, [load]);

  // ── identity (always visible) — name/email/role from the summary payload,
  //    falling back to the auth context so the bar never renders blank.
  const identity = summary?.identity;
  const idName  = identity?.name  || authUser?.name || authUser?.username || authUser?.email?.split('@')[0] || 'there';
  const idEmail = identity?.email || authUser?.email || '';
  const firstName = idName.split(' ')[0];

  const go = page => setPage && setPage(page);

  // ── role-shaped data ──────────────────────────────────────────────────────
  const mgmt        = summary?.management;
  const myTasks     = summary?.myTasks || [];
  const myApprovals = summary?.myApprovals || { awaitingMyAction: [], awaitingOthers: [] };
  const announcements = summary?.announcements || [];
  const policies    = summary?.policies || [];
  const brandAssets = summary?.brandAssets || [];

  // hero KPI values differ by role
  const attRate     = mgmt?.attendance?.rate ?? 0;
  const revenueMtd  = mgmt?.revenue?.mtd;
  const apprCount   = isEmployee ? myApprovals.awaitingMyAction.length : (mgmt?.pendingApprovalsCount ?? 0);
  const openTaskCt  = isEmployee ? myTasks.length : (mgmt?.openTasksCount ?? 0);

  return (
    <div className="hm-root">

      {/* ── Hero + Identity bar (always visible) ── */}
      <div className="hm-hero">
        <button className="hm-hero-refresh" onClick={load} title="Refresh" aria-label="Refresh">
          <RefreshCw size={15} />
        </button>
        <div className="hm-hero-inner">
          <div className="hm-hero-l">
            <p className="hm-greeting">{greeting()}</p>
            <div className="hm-name-row">
              <h1 className="hm-name">{firstName} 👋</h1>
              <span className="hm-role-badge">{roleLabel}</span>
              <span className="hm-date">
                {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' })}
              </span>
            </div>
            {/* Identity line: Name · email · Role */}
            <div className="hm-identity">
              <span className="hm-identity-name">{idName}</span>
              {idEmail && <><span className="hm-identity-sep">·</span><span className="hm-identity-email">{idEmail}</span></>}
              <span className="hm-identity-sep">·</span><span className="hm-identity-role">{roleLabel}</span>
            </div>
          </div>

          <div className="hm-hero-r">
            {/* Management: company attendance ring + clickable KPIs.
                Employee: personal counters — the two approval-related ones
                (To Action / My Requests) open the read-only My Requests page;
                My Tasks has no employee-facing task list yet, so it stays inert. */}
            {isEmployee ? (
              <>
                <button className="hm-kpi-card" onClick={() => go('MyRequests')}>
                  <span className="hm-kpi-val" style={{ color: apprCount > 0 ? '#fbbf24' : '#fff' }}>
                    {loading ? '—' : apprCount}
                  </span>
                  <span className="hm-kpi-label">To Action</span>
                </button>
                <div className="hm-kpi-card hm-kpi-ring">
                  <span className="hm-kpi-val">{loading ? '—' : openTaskCt}</span>
                  <span className="hm-kpi-label">My Tasks</span>
                </div>
                <button className="hm-kpi-card" onClick={() => go('MyRequests')}>
                  <span className="hm-kpi-val">{loading ? '—' : myApprovals.awaitingOthers.length}</span>
                  <span className="hm-kpi-label">My Requests</span>
                </button>
              </>
            ) : (
              <>
                <div className="hm-kpi-card hm-kpi-ring">
                  {loading
                    ? <span className="hm-kpi-val">—</span>
                    : <ProgressRing value={attRate} size={46} stroke={5}
                        color="#6ee7b7" track="rgba(255,255,255,.18)" textColor="#fff"
                        label={`${attRate}%`} />}
                  <span className="hm-kpi-label">Attendance</span>
                </div>
                <button className="hm-kpi-card" onClick={() => go('ApprovalCenter')}>
                  <span className="hm-kpi-val" style={{ color: apprCount > 0 ? '#fbbf24' : '#fff' }}>
                    {loading ? '—' : apprCount}
                  </span>
                  <span className="hm-kpi-label">Approvals</span>
                </button>
                <button className="hm-kpi-card" onClick={() => go('KanbanBoard')}>
                  <span className="hm-kpi-val">{loading ? '—' : openTaskCt}</span>
                  <span className="hm-kpi-label">Open Tasks</span>
                </button>
                {revenueMtd != null && canSeeFinancials && (
                  <button className="hm-kpi-card" onClick={() => go('FinanceDashboardNew')}>
                    <span className="hm-kpi-val" style={{ color: '#6ee7b7' }}>
                      {loading ? '—' : fmtINR(revenueMtd)}
                    </span>
                    <span className="hm-kpi-label">Revenue MTD</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Super Admin console — governance screens, not buried in the same
             flyouts as the other ~290 pages. ── */}
      {isSuperAdmin && (
        <nav className="hm-quick-strip" aria-label="Super Admin console">
          <span className="hm-console-label">Console</span>
          {CONSOLE_LINKS.map(({ label, page, icon: Icon }) => (
            <button key={page} className="hm-quick-chip" onClick={() => go(page)}>
              <Icon size={12} />{label}
            </button>
          ))}
        </nav>
      )}

      {/* ── Attendance / quick clock-in strip — put your punch in the moment you
             open the app, no navigation needed. ── */}
      {showClockStrip && (
        <div className="hm-att-strip">
          <div className="hm-att-left">
            <div className="hm-att-clock">
              <Clock size={16} />
              <span className="hm-att-time">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="hm-att-status">
              {clockDone ? (
                <>
                  <span className="hm-att-dot hm-att-dot--done" />
                  <span>Clocked out · <b>{fmtClock(attendance.check_in)}</b>–<b>{fmtClock(attendance.check_out)}</b>{attendance.hours_worked ? ` · ${attendance.hours_worked}h` : ''}</span>
                </>
              ) : clockedIn ? (
                <>
                  <span className="hm-att-dot hm-att-dot--in" />
                  <span>Clocked in at <b>{fmtClock(attendance.check_in)}</b></span>
                </>
              ) : (
                <>
                  <span className="hm-att-dot hm-att-dot--out" />
                  <span>Not clocked in yet</span>
                </>
              )}
            </div>
          </div>
          <div className="hm-att-right">
            {!clockedIn && !clockDone && (
              <span className="hm-att-geo"><MapPin size={11} /> location & face verified</span>
            )}
            {clockDone ? (
              <span className="hm-att-done-badge"><CheckCheck size={14} /> Day complete</span>
            ) : (
              <button
                className={`hm-att-btn ${clockedIn ? 'hm-att-btn--out' : 'hm-att-btn--in'}`}
                onClick={onClockClick}
                disabled={clockLoading || !empId}
                title={!empId ? 'Your login is not linked to an employee record' : undefined}
              >
                {clockedIn ? <LogOut size={15} /> : <LogIn size={15} />}
                {clockLoading ? 'Please wait…' : clockedIn ? 'Clock Out' : 'Clock In'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Body grid — same 6 slots for every role; content adapts ── */}
      <div className="hm-body">
        <div className="hm-grid">

          {/* Slot 1 — My Open Tasks */}
          <CardShell
            icon={<CheckSquare size={13} color="#6366f1" />} iconBg="hm-icon-bg--tasks"
            title={isEmployee ? 'My Open Tasks' : 'Open Tasks'}
            action={isEmployee ? null : <button className="hm-text-btn" onClick={() => go('KanbanBoard')}>Task Board</button>}
          >
            {loading ? <Skeleton />
              : (() => {
                  const list = isEmployee ? myTasks : (mgmt?.openTasks || []);
                  return list.length === 0
                    ? <Empty icon={<CheckCheck size={28} color="#d1d5db" />} text="All caught up!" />
                    : list.map((t, i) => <TaskRow key={t.id || i} t={t} />);
                })()}
          </CardShell>

          {/* Slot 2 — Approvals (employee: two labeled groups; else: queue) */}
          <CardShell
            icon={<Bell size={13} color="#f59e0b" />} iconBg="hm-icon-bg--approvals"
            title={isEmployee ? 'My Pending Approvals' : 'Pending Approvals'}
            action={isEmployee ? null : <button className="hm-text-btn" onClick={() => go('ApprovalCenter')}>View All</button>}
          >
            {loading ? <Skeleton />
              : isEmployee ? (
                <>
                  <div className="hm-sub-hd"><Inbox size={11} /> Awaiting my action</div>
                  {myApprovals.awaitingMyAction.length === 0
                    ? <div className="hm-sub-empty">Nothing needs your sign-off.</div>
                    : myApprovals.awaitingMyAction.map((a, i) => <ApprovalRow key={a.id || i} a={a} />)}
                  <div className="hm-sub-hd"><Send size={11} /> Awaiting others</div>
                  {myApprovals.awaitingOthers.length === 0
                    ? <div className="hm-sub-empty">You have no requests pending sign-off.</div>
                    : myApprovals.awaitingOthers.map((a, i) => <ApprovalRow key={a.id || i} a={a} />)}
                </>
              ) : (
                (mgmt?.approvalsQueue || []).length === 0
                  ? <Empty icon={<CheckCheck size={28} color="#d1d5db" />} text="No pending approvals." />
                  : mgmt.approvalsQueue.map((a, i) => <ApprovalRow key={a.id || i} a={a} />)
              )}
          </CardShell>

          {/* Slot 3 — Announcements (all roles) */}
          <CardShell
            icon={<Megaphone size={13} color="#3b82f6" />} iconBg="hm-icon-bg--announcements"
            title="Announcements"
            action={isEmployee ? null : <button className="hm-text-btn" onClick={() => go('Announcements')}>View All</button>}
          >
            {loading ? <Skeleton />
              : announcements.length === 0
                ? <Empty icon={<Megaphone size={28} color="#d1d5db" />} text="No active announcements." />
                : announcements.map((ann, i) => (
                    <div key={ann.id || i} className="hm-ann-row">
                      <div className="hm-ann-dot" />
                      <div className="hm-ann-body">
                        <div className="hm-ann-title">{ann.title}</div>
                        <div className="hm-ann-msg">{ann.message || ann.body || ann.content}</div>
                        {ann.created_at && <div className="hm-ann-date">{fmtLongDate(ann.created_at)}</div>}
                      </div>
                    </div>
                  ))}
          </CardShell>

          {/* Slot 4 — Policies (all roles; replaces the old Live Activity Feed) */}
          <CardShell
            icon={<ShieldCheck size={13} color="#0ea5e9" />} iconBg="hm-icon-bg--announcements"
            title="Policies"
          >
            {loading ? <Skeleton />
              : policies.length === 0
                ? <Empty icon={<FileText size={28} color="#d1d5db" />} text="No policy documents yet." />
                : policies.map((d, i) => <DocRow key={d.id || i} d={d} />)}
          </CardShell>

          {/* Slot 5 — Brand Vault: templates & brand assets (ppt template, logo,
              colour codex, letterhead…). Same panel for every role. */}
          <CardShell
            icon={<Sparkles size={13} color="#a855f7" />} iconBg="hm-icon-bg--celebrations"
            title={BRAND_VAULT_LABEL}
          >
            {loading ? <Skeleton />
              : brandAssets.length === 0
                ? <Empty icon={<FileText size={28} color="#d1d5db" />} text="No templates yet." />
                : brandAssets.map((d, i) => <DocRow key={d.id || i} d={d} />)}
          </CardShell>

          {/* Slot 6 — Today's Celebrations (all roles) */}
          <div className="hm-card">
            <div className="hm-card-hd">
              <span className="hm-card-title">
                <span className="hm-card-title-icon hm-icon-bg--celebrations">
                  <PartyPopper size={13} color="#a855f7" />
                </span>
                Today's Celebrations
              </span>
            </div>
            <div className="hm-card-body">
              <Suspense fallback={null}>
                <CelebrationsBoard />
              </Suspense>
            </div>
          </div>

        </div>
      </div>

      {/* Face-recognition clock-in (geo/shift policy enforced server-side) */}
      {faceOpen && empId && (
        <FaceClockModal
          employeeId={empId}
          action={clockedIn ? 'out' : 'in'}
          onVerified={(fd) => { setFaceOpen(false); handleClockAction(fd); }}
          onClose={() => setFaceOpen(false)}
        />
      )}

      {toast && (
        <div className={`hm-toast ${toast.kind === 'err' ? 'hm-toast--err' : 'hm-toast--ok'}`} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
