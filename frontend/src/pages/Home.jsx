import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  CheckSquare, Clock, Bell,
  RefreshCw, Megaphone, PartyPopper, CheckCheck,
  FileText, Download, LogIn, LogOut, MapPin,
  ShieldCheck, Sparkles, AlertCircle, ExternalLink,
} from 'lucide-react';
import api from '@/services/api/client';
import { downloadHomeDocument } from './homeDocuments';
import { useAuth } from '@/context/AuthContext';
import CameraClockModal from '@/components/attendance/CameraClockModal';
import PunchModeNotice from '@/components/attendance/PunchModeNotice';
import { getLocationString } from '@/components/attendance/geo';
import usePunchMode from '@/hooks/usePunchMode';
import { announcementText } from '@/features/hr/announcementFeed';
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

const ROLE_LABEL = {
  super_admin: 'Super Admin', superadmin: 'Super Admin', admin: 'Administrator',
  manager: 'Manager', department_head: 'Department Head',
  hr: 'HR', hr_manager: 'HR Manager', hr_exec: 'HR Executive',
  finance: 'Finance', finance_manager: 'Finance Manager', accounts_exec: 'Accounts Executive',
  payroll_admin: 'Payroll Admin',
  executive: 'Executive', ceo: 'CEO', employee: 'Employee',
  project_manager: 'Project Manager',
  sales_manager: 'Sales Manager', sales_exec: 'Sales Executive',
  procurement_manager: 'Procurement Manager', procurement_exec: 'Procurement Executive',
  store_keeper: 'Store Keeper',
  production_manager: 'Production Manager', production_engineer: 'Production Engineer',
  qc_manager: 'QC Manager', qc_engineer: 'QC Engineer',
  design_engineer: 'Design Engineer',
  service_manager: 'Service Manager', service_engineer: 'Service Engineer',
  l2_approver: 'L2 Approver',
};

// Fallback for any role code not covered above (e.g. a future role added to
// role_permissions before this map is updated) — a readable title-case guess
// beats silently mislabeling the user as "Employee".
const humanizeRole = r => r.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

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

// One pending approval. Clicking opens it: a review (intern evaluation,
// probation review) on its own form, anything else in the Approval Center.
const ApprovalRow = ({ a, onOpen }) => {
  const initials = (a.requested_by || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className={`hm-appr-row${onOpen ? ' hm-appr-row--link' : ''}`}
      {...(onOpen ? {
        role: 'button', tabIndex: 0, title: 'Open',
        onClick: onOpen,
        onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } },
      } : {})}>
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

// Single-column tile — full-width row so the document title is never
// truncated; the card scrolls internally if the list runs long.
// Download goes through Pulse (homeDocuments.js), which returns the file
// itself: a Drive share link followed by the browser opens Drive's viewer, or
// Google's sign-in page for an org-restricted file.
const DocTile = ({ d, kind, onError }) => {
  const [busy, setBusy] = useState(false);
  const meta = [d.version, d.effective_date && `Effective ${fmtShortDate(d.effective_date)}`]
    .filter(Boolean).join(' · ');
  const onDownload = async () => {
    setBusy(true);
    const err = await downloadHomeDocument(kind, d);
    setBusy(false);
    if (err) onError(err);
  };
  return (
    <div className="hm-doctile" title={d.description || d.title}>
      <span className="hm-doctile-icon"><FileText size={14} /></span>
      <span className="hm-doctile-title">
        {d.title}
        {meta && <span className="hm-doctile-meta">{meta}</span>}
      </span>
      {d.download === 'file' ? (
        <button type="button" className="hm-doctile-dl" onClick={onDownload} disabled={busy}
                aria-label={`Download ${d.title}`}>
          <Download size={11} /> {busy ? 'Preparing…' : 'Download'}
        </button>
      ) : d.download === 'link' ? (
        <button type="button" className="hm-doctile-dl" onClick={onDownload}
                aria-label={`Open ${d.title}`}>
          <ExternalLink size={11} /> Open
        </button>
      ) : (
        <span className="hm-doctile-dl hm-doctile-dl--muted">Not linked yet</span>
      )}
    </div>
  );
};

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

// Shown when /home/summary itself failed. Without it a dropped request looked
// exactly like "there is nothing here" — the Policies / Brand Vault panels
// reported "no documents yet" for what was really a network or DB error.
const Failed = ({ what, onRetry }) => (
  <div className="hm-empty-state">
    <AlertCircle size={28} color="#f59e0b" />
    <p>Couldn't load {what}.</p>
    <button type="button" className="hm-text-btn" onClick={onRetry}>
      <RefreshCw size={11} /> Retry
    </button>
  </div>
);

export default function Home({ setPage }) {
  const { user: authUser, role: authRole } = useAuth();
  const role = (authRole || 'employee').toLowerCase();
  const isEmployee = role === 'employee';
  const roleLabel = ROLE_LABEL[role] || humanizeRole(role);

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const ctrl = useRef(null);

  // ── attendance / quick clock-in ───────────────────────────────────────────
  const [attendance, setAttendance] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [clockLoading, setClockLoading] = useState(false);
  const [now, setNow]     = useState(new Date());
  const [toast, setToast] = useState(null);
  const empId = authUser?.employee_id;
  // Only field employees punch from the app; everyone else uses the office
  // face/biometric device and sees a notice instead of a button.
  const punch = usePunchMode(empId);

  // Anyone linked to an employee record punches in from Home — managers, HR and
  // finance staff clock in too. Employee logins that HR never linked still get
  // the strip, with a disabled button explaining why.
  const showClockStrip = isEmployee || !!empId;

  const showToast = (msg, kind = 'ok') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3200);
  };

  // One in-flight request at a time. The controller is captured in a local so a
  // superseded call (StrictMode's double effect, a refresh click, or a
  // `pulse:*-updated` event landing mid-load) can tell that it is no longer the
  // owner of the page state: without that check its `finally` flipped `loading`
  // to false while the newer request was still running, so every panel briefly
  // rendered its *empty* state — Policies and Brand Vault showed "No policy
  // documents yet." / "No templates yet." instead of the skeleton.
  const load = useCallback(async () => {
    ctrl.current?.abort();
    const myCtrl = new AbortController();
    ctrl.current = myCtrl;
    const isStale = () => myCtrl.signal.aborted || ctrl.current !== myCtrl;
    setLoading(true);
    setLoadError(false);
    try {
      const { data } = await api.get('/home/summary', { signal: myCtrl.signal });
      if (isStale()) return;
      setSummary(data);
      setAttendance(normalizeAttendance(data?.myAttendance));
    } catch (e) {
      if (isStale() || e?.code === 'ERR_CANCELED') return;
      // A failed fetch is NOT "you have no documents" — flag it so the panels
      // offer a retry instead of an empty state that reads like real data.
      setSummary(null);
      setLoadError(true);
    } finally {
      if (!isStale()) setLoading(false);
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

  const handleClockAction = useCallback(async (proof = null) => {
    if (!empId) {
      showToast('Your login is not linked to an employee record — ask HR to link it.', 'err');
      return;
    }
    setClockLoading(true);
    try {
      const isClockIn = !attendance?.check_in;
      const time = new Date().toTimeString().slice(0, 5); // "HH:MM"
      // Clock-in carries the selfie + GPS the camera modal just captured; a
      // clock-out re-reads GPS only (attendance_records holds ONE selfie_url,
      // so sending a second photo would overwrite the arrival proof).
      const location = proof?.location ?? (isClockIn ? await getLocationString() : null);
      const { data } = await api.post('/attendance/clock', {
        employee_id: empId,
        action: isClockIn ? 'in' : 'out',
        time,
        ...(location ? { location } : {}),
        ...(proof?.selfie_url ? { selfie_url: proof.selfie_url } : {}),
      });
      setAttendance(normalizeAttendance(data));
      showToast(isClockIn ? 'Clocked in successfully!' : 'Clocked out successfully!');
    } catch (error) {
      showToast(error?.response?.data?.message || error?.response?.data?.error || 'Failed to record attendance', 'err');
    } finally {
      setClockLoading(false);
    }
  }, [attendance, empId]);

  // Clock-in opens the camera (selfie + GPS are mandatory server-side for field
  // staff); clock-out punches directly — mirrors the EmployeeDashboard behaviour.
  const onClockClick = () => {
    if (clockedIn || !empId) handleClockAction();
    else setCameraOpen(true);
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

  // ── personal data — same for every role ──────────────────────────────────
  const myTasks     = summary?.myTasks || [];
  const myApprovals = summary?.myApprovals || { awaitingMyAction: [], awaitingOthers: [] };
  const announcements = summary?.announcements || [];
  const policies    = summary?.policies || [];
  const brandAssets = summary?.brandAssets || [];
  // Panels whose query failed server-side: the request itself was a 200, but
  // that slice came back empty because of a DB error, not because there is
  // nothing to show. Treated as a load failure, not as an empty list.
  const degraded    = summary?.degraded || [];

  // Full count of what waits on me; the card lists only the first few.
  const apprCount   = myApprovals.awaitingMyActionTotal ?? myApprovals.awaitingMyAction.length;
  const openTaskCt  = myTasks.length;

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
            {/* Personal counters — same for every role. To Action opens the
                Approval Center (what waits on me); My Requests opens the
                read-only My Requests page; My Tasks has no dedicated list
                view yet, so it stays inert. */}
            <button className="hm-kpi-card" onClick={() => go('ApprovalCenter')}>
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
          </div>
        </div>
      </div>

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
            {!clockedIn && !clockDone && punch.canPunch && (
              <span className="hm-att-geo"><MapPin size={11} /> selfie & location required</span>
            )}
            {clockDone ? (
              <span className="hm-att-done-badge"><CheckCheck size={14} /> Day complete</span>
            ) : punch.loading ? (
              <span className="hm-att-geo">Checking your attendance setup…</span>
            ) : !punch.canPunch ? (
              /* Non-field staff punch on the office face/biometric device — show
                 the reason rather than a button the server would reject. */
              <PunchModeNotice reason={punch.reason} message={punch.message} compact />
            ) : (
              <button
                className={`hm-att-btn ${clockedIn ? 'hm-att-btn--out' : 'hm-att-btn--in'}`}
                onClick={onClockClick}
                disabled={clockLoading}
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

          {/* Slot 1 — My Open Tasks (same for every role) */}
          <CardShell
            icon={<CheckSquare size={13} color="#6366f1" />} iconBg="hm-icon-bg--tasks"
            title="My Open Tasks"
          >
            {loading ? <Skeleton />
              : loadError ? <Failed what="your tasks" onRetry={load} />
              : myTasks.length === 0
                ? <Empty icon={<CheckCheck size={28} color="#d1d5db" />} text="All caught up!" />
                : myTasks.map((t, i) => <TaskRow key={t.id || i} t={t} />)}
          </CardShell>

          {/* Slot 2 — My Pending Approvals (same for every role) */}
          <CardShell
            icon={<Bell size={13} color="#f59e0b" />} iconBg="hm-icon-bg--approvals"
            title="My Pending Approvals"
            action={setPage && (
              <button type="button" className="hm-card-link" aria-label="View all approvals"
                onClick={() => setPage('ApprovalCenter')}>
                View all
              </button>
            )}
          >
            {/* A short preview of the Approval Center's My Pending Approvals —
                every module, intern evaluations and probation reviews included.
                "View all" opens the full list. */}
            {loading ? <Skeleton />
              : loadError ? <Failed what="your approvals" onRetry={load} />
              : myApprovals.awaitingMyAction.length === 0
                ? <Empty icon={<CheckCheck size={28} color="#d1d5db" />} text="Nothing needs your sign-off." />
                : (
                  <>
                    {myApprovals.awaitingMyAction.map((a, i) => (
                      <ApprovalRow key={a.id || i} a={a} onOpen={setPage && (() => (a.open
                        ? setPage(a.open.page, a.open.params || {})
                        : setPage('ApprovalCenter')))} />
                    ))}
                    {apprCount > myApprovals.awaitingMyAction.length && (
                      <div className="hm-sub-empty">
                        +{apprCount - myApprovals.awaitingMyAction.length} more in View all
                      </div>
                    )}
                  </>
                )}
          </CardShell>

          {/* Slot 3 — Announcements (all roles) */}
          <CardShell
            icon={<Megaphone size={13} color="#3b82f6" />} iconBg="hm-icon-bg--announcements"
            title="Announcements"
            // Shown for every role, even when the card is empty: My Announcements
            // is a personal page (PERSONAL_PAGES), so no role is gated out of it.
            action={setPage && (
              <button type="button" className="hm-card-link"
                onClick={() => setPage('MyAnnouncements')}>
                View all
              </button>
            )}
          >
            {loading ? <Skeleton />
              : loadError ? <Failed what="announcements" onRetry={load} />
              : announcements.length === 0
                ? <Empty icon={<Megaphone size={28} color="#d1d5db" />} text="No active announcements." />
                : announcements.map((ann, i) => (
                    // Opens the announcement in full on My Announcements — the
                    // same place the bell opens it, which also records the read.
                    <div key={ann.id || i} className="hm-ann-row hm-ann-row--link"
                      role="button" tabIndex={0} title="Open announcement"
                      onClick={() => setPage && setPage('MyAnnouncements', { ref: ann.id })}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setPage && setPage('MyAnnouncements', { ref: ann.id });
                        }
                      }}>
                      <div className="hm-ann-dot" />
                      <div className="hm-ann-body">
                        <div className="hm-ann-title">{ann.title}</div>
                        <div className="hm-ann-msg">{announcementText(ann.message)}</div>
                        {ann.created_at && <div className="hm-ann-date">{fmtLongDate(ann.created_at)}</div>}
                      </div>
                    </div>
                  ))}
          </CardShell>

          {/* Slot 4 — Policies (all roles). Sourced from hr_policies, maintained on
              the Policy Documents page (features/hr/pages/Policies.jsx): only
              active, company-wide policies, one tile per policy at its latest
              version. Internal HR/admin SOPs never reach this panel. */}
          <CardShell
            icon={<ShieldCheck size={13} color="#0ea5e9" />} iconBg="hm-icon-bg--announcements"
            title="Policies"
          >
            {loading ? <Skeleton />
              : (loadError || degraded.includes('policies')) ? <Failed what="policies" onRetry={load} />
              : policies.length === 0
                ? <Empty icon={<FileText size={28} color="#d1d5db" />} text="No policy documents yet." />
                : <div className="hm-doc-grid">{policies.map((d, i) => <DocTile key={d.id || i} d={d} kind="policy" onError={m => showToast(m, 'err')} />)}</div>}
          </CardShell>

          {/* Slot 5 — Brand Vault: templates & brand assets (ppt template, logo,
              colour codex, letterhead…). Same panel for every role. */}
          <CardShell
            icon={<Sparkles size={13} color="#a855f7" />} iconBg="hm-icon-bg--celebrations"
            title={BRAND_VAULT_LABEL}
          >
            {loading ? <Skeleton />
              : (loadError || degraded.includes('brandAssets')) ? <Failed what={BRAND_VAULT_LABEL.toLowerCase()} onRetry={load} />
              : brandAssets.length === 0
                ? <Empty icon={<FileText size={28} color="#d1d5db" />} text="No templates yet." />
                : <div className="hm-doc-grid">{brandAssets.map((d, i) => <DocTile key={d.id || i} d={d} kind="brand" onError={m => showToast(m, 'err')} />)}</div>}
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

      {/* Camera clock-in for field staff — selfie + GPS, both enforced server-side */}
      {cameraOpen && empId && punch.canPunch && (
        <CameraClockModal
          employeeId={empId}
          action={clockedIn ? 'out' : 'in'}
          onCaptured={(proof) => { setCameraOpen(false); handleClockAction(proof); }}
          onClose={() => setCameraOpen(false)}
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
