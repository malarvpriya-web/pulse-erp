import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  UserCircle, Calendar, CalendarClock, Clock, FileText, Briefcase, Gift, Users,
  ShieldCheck, LogOut, AlertTriangle, ArrowRight, RefreshCw, Package,
  LifeBuoy, Star, Inbox, Plus,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '../services/api/client';
import { PageShell, PageHero, StatBand, Stat, SectionTitle, ContentCard } from '@/components/pulse-ui';
import MyPayslipsWidget from '@/components/dashboard/widgets/MyPayslipsWidget';
import { MERGED_ROUTES as ROUTES } from '@/config/autoRouter';
import { canRenderPage } from '@/config/menuCatalog';
import './EmployeeDashboard.css';

/*
 * HR > Self Service > My Dashboard — the signed-in employee's OWN HR record.
 *
 * Not repeated here, because Home already shows them: clock-in, open tasks,
 * pending approvals, announcements, policies, Brand Vault, celebrations.
 * Each fact on this page appears ONCE:
 *   stat band        leave available · leave requests pending · present / absent this month
 *   Employment       designation, department, manager, type, grade, joining date, status
 *   Probation        ONLY while on probation (hidden once confirmed)
 *   Resignation      ONLY once an exit is in progress — notice period, last day, clearance
 *   Leave            balance per type · my recent requests
 *   Holidays / Team  upcoming holidays · my team on leave today
 *   Pay / Time       released payslips · recent timesheet entries
 *   Sales Target     ONLY with a yearly target: month-by-month target vs achieved,
 *                    days left, incentive so far (/home/my-sales-target)
 *
 * Every link is offered only when canRenderPage() — Layout's own gate — would
 * open it for this role, so nothing here lands on Access Denied.
 *
 * Sources (all the caller's own): /home/my-employment, /leaves/balance,
 * /leaves/my, /holidays, /timesheets/timesheets, /payroll/my-payslips (widget).
 */

const REFRESH_INTERVAL = 5 * 60 * 1000;
// Leave codes kept off the Leave Balance card (see balanceRows below).
const DASHBOARD_HIDDEN_LEAVE_CODES = new Set(['MRG', 'PATERNITY']);

// ─── Helpers ──────────────────────────────────────────────────────────────────
// DD Mon YY. A bare YYYY-MM-DD is read as a LOCAL date (new Date('Y-M-D') is UTC
// midnight and shows the previous day west of UTC).
function fmtDate(v) {
  if (!v) return '';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}
const dayKey = v => String(v || '').slice(0, 10);
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function weekday(v) {
  const d = new Date(`${dayKey(v)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short' });
}
function tenureOf(doj) {
  if (!doj) return '';
  const yrs = (Date.now() - new Date(`${dayKey(doj)}T00:00:00`).getTime()) / (365.25 * 86400000);
  if (!(yrs >= 0)) return '';
  return yrs >= 1 ? `${yrs.toFixed(1)} yr${yrs >= 2 ? 's' : ''}` : `${Math.max(0, Math.round(yrs * 12))} mo`;
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const fmtDays = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const titleCase = s => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const asList = raw => (Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : []);

// Probation state → what the employee reads.
function probationView(p) {
  if (!p) return null;
  switch (p.state) {
    case 'confirmed':
      return { tone: 'ok', label: 'Confirmed' };
    case 'on_probation':
      return { tone: p.days_left <= 30 ? 'warn' : 'info', label: `On probation · ${plural(p.days_left, 'day')} left` };
    case 'decision_pending':
      return { tone: 'warn', label: 'Probation ended · confirmation pending with HR' };
    default:
      return { tone: 'muted', label: 'Not recorded — check with HR' };
  }
}
const REVIEW_STATUS = {
  requested: 'Requested from your reviewer',
  submitted: 'Submitted by your reviewer · awaiting HR decision',
};
const DECISION_LABEL = { confirm: 'Confirmed', extend: 'Probation extended', not_confirm: 'Not confirmed' };
const LEAVE_STATUS_TONE = { approved: 'ok', pending: 'warn', rejected: 'bad', cancelled: 'muted', withdrawn: 'muted' };

// ─── Small pieces ─────────────────────────────────────────────────────────────
function InfoRow({ label, value, hint, tone }) {
  return (
    <div className="mhr-row">
      <span className="mhr-row-label">{label}</span>
      <span className={`mhr-row-val${tone ? ` is-${tone}` : ''}`}>
        {value || <span className="mhr-missing">{hint || 'Not recorded'}</span>}
      </span>
    </div>
  );
}
function Skeleton({ rows = 3 }) {
  return <div className="mhr-skel">{Array.from({ length: rows }, (_, i) => <span key={i} />)}</div>;
}
function Empty({ children }) {
  return <div className="mhr-empty">{children}</div>;
}
function CardLink({ label, onClick }) {
  if (!onClick) return null;
  return (
    <button type="button" className="mhr-link" onClick={onClick}>
      {label} <ArrowRight size={12} />
    </button>
  );
}

// ─── My sales target ──────────────────────────────────────────────────────────
// The yearly target split by month, what the person achieved (from their own
// sales orders), the days left, and the incentive on the sales so far.
const rupees = n => `₹${Math.round(num(n)).toLocaleString('en-IN')}`;
function MySalesTarget({ t }) {
  const pct = t.pct ?? 0;
  const inc = t.incentive || {};
  const tone = p => (p == null ? 'muted' : p >= 100 ? 'ok' : p >= 80 ? 'info' : 'warn');
  return (
    <>
      <SectionTitle rule>Sales Target · {t.fy_label}</SectionTitle>
      <div className="mhr-grid">
        <ContentCard title={<span className="mhr-title"><Star size={14} /> My Year</span>}>
          <InfoRow label="Yearly target" value={rupees(t.annual_target)} />
          <InfoRow label="Achieved so far" value={`${rupees(t.achieved)} · ${t.pct == null ? '—' : `${t.pct}%`}`} tone={tone(t.pct)} />
          <InfoRow label="Still to achieve" value={t.remaining > 0 ? rupees(t.remaining) : 'Target reached'} tone={t.remaining > 0 ? undefined : 'ok'} />
          <InfoRow label="Days left in the year" value={plural(t.days_left_in_year, 'day')} />
          <InfoRow label="Days left this month" value={plural(t.days_left_in_month, 'day')} />
          <div className="mhr-track" aria-label={`${pct}% of the yearly target`}>
            <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
          </div>
          <InfoRow
            label={inc.final ? 'Incentive for the year' : 'Incentive on sales so far'}
            value={!inc.slabs_set ? null : rupees(inc.amount_so_far)}
            hint="Incentive slabs not set yet" />
          {inc.slabs_set && <div className="mhr-note">{inc.basis} Paid once a year, after 31 March.</div>}
        </ContentCard>
        <ContentCard title={<span className="mhr-title"><Calendar size={14} /> Month by Month</span>}>
          <table className="mhr-table">
            <thead><tr><th>Month</th><th>Target</th><th>Achieved</th><th>%</th><th>Days left</th></tr></thead>
            <tbody>
              {t.months.map(m => (
                <tr key={`${m.year}-${m.month}`} className={m.state === 'current' ? 'is-current' : undefined}>
                  <td>{m.label}</td>
                  <td>{rupees(m.target)}</td>
                  <td className="is-strong">{m.state === 'future' ? '—' : rupees(m.achieved)}</td>
                  <td><span className={`mhr-pill is-${m.state === 'future' ? 'muted' : tone(m.pct)}`}>{m.state === 'future' || m.pct == null ? '—' : `${m.pct}%`}</span></td>
                  <td>{m.state === 'past' ? 'Done' : m.days_left}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ContentCard>
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function EmployeeDashboard({ setPage }) {
  const { user, role, hasPermission, menuAccess } = useAuth();

  const [employment,   setEmployment]   = useState(null);
  const [employmentErr,setEmploymentErr]= useState(false);
  const [balances,     setBalances]     = useState(null);   // null = failed / not loaded
  const [myLeaves,     setMyLeaves]     = useState([]);
  const [holidays,     setHolidays]     = useState([]);
  const [timesheets,   setTimesheets]   = useState(null);   // null = not available to this role
  // The company assets issued to me (HR audit 2026-11-16): the page showed only
  // a count. GET /employee-assets?employee_id=<own> is the own-record read.
  const [myAssets,     setMyAssets]     = useState(null);   // null = not loaded / failed
  // HR Documents meant for everyone (audience 'all'): employees had no way to
  // reach a company form (HR audit 2026-11-16). The Employee Records hub stays
  // HR-only (owner, 11 Nov), so the forms are listed here.
  const [forms,        setForms]        = useState(null);
  const [salesTarget,  setSalesTarget]  = useState(null);   // shown only when has_target
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const isInitial = useRef(true);

  // A link is offered only if Layout would render the target for this role.
  const canOpen = useCallback(page => canRenderPage(role, page, {
    route: ROUTES[page], menuAccess, hasPermission,
  }), [role, menuAccess, hasPermission]);
  const linkTo = useCallback((page, params) => (
    typeof setPage === 'function' && canOpen(page)
      ? () => (params ? setPage(page, params) : setPage(page))
      : null
  ), [setPage, canOpen]);

  const showTimesheets = canOpen('MyTimesheet');

  const loadData = useCallback(async () => {
    if (isInitial.current) setLoading(true); else setRefreshing(true);
    const [empRes, balRes, myLeavesRes, holRes, tsRes, stRes, assetRes, formRes] = await Promise.allSettled([
      api.get('/home/my-employment'),
      api.get('/leaves/balance'),
      api.get('/leaves/my'),
      api.get('/holidays'),
      showTimesheets && user?.employee_id
        ? api.get('/timesheets/timesheets', { params: { employee_id: user.employee_id } })
        : Promise.resolve(null),
      api.get('/home/my-sales-target'),
      user?.employee_id
        ? api.get('/employee-assets', { params: { employee_id: user.employee_id } })
        : Promise.resolve({ data: [] }),
      api.get('/hr/downloads'),
    ]);
    setForms(formRes.status === 'fulfilled' ? asList(formRes.value?.data) : null);
    setMyAssets(assetRes.status === 'fulfilled'
      ? asList(assetRes.value?.data).filter(a => !['returned', 'disposed'].includes(String(a.status || '').toLowerCase()))
      : null);
    setSalesTarget(stRes.status === 'fulfilled' && stRes.value?.data?.has_target ? stRes.value.data : null);

    if (empRes.status === 'fulfilled' && empRes.value?.data) { setEmployment(empRes.value.data); setEmploymentErr(false); }
    else setEmploymentErr(true);

    setBalances(balRes.status === 'fulfilled' ? asList(balRes.value?.data) : null);
    if (myLeavesRes.status === 'fulfilled') setMyLeaves(asList(myLeavesRes.value?.data));
    if (holRes.status === 'fulfilled') setHolidays(asList(holRes.value?.data));
    setTimesheets(tsRes.status === 'fulfilled' && tsRes.value ? asList(tsRes.value.data) : (showTimesheets ? [] : null));

    isInitial.current = false;
    setLoading(false);
    setRefreshing(false);
  }, [user?.employee_id, showTimesheets]);

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [loadData]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const linked    = employment?.linked === true;
  const emp       = employment?.employee || {};
  const probation = employment?.probation;
  const exit      = employment?.exit;
  const att       = employment?.attendance;
  const attention = employment?.attention || {};
  const degraded  = employment?.degraded || [];
  const team      = employment?.team_on_leave_today || [];
  const pv        = probationView(probation);
  // Shown only while probation runs, or has ended with no decision recorded.
  const showProbation = linked && ['on_probation', 'decision_pending'].includes(probation?.state);
  const noticeDays    = exit ? (exit.notice_period_days || emp.notice_period_days) : null;
  const tenure    = tenureOf(emp.joining_date);
  const name      = emp.name || user?.name || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'My HR Summary';

  // Leave types with something allocated or used; zero-everything types are noise.
  // Marriage and Paternity are once-in-an-event leaves, not a running balance:
  // left out here (owner's instruction, 2026-11-11) so they neither show as
  // cards nor inflate the "available" total. My Leaves / Apply Leave still list them.
  const balanceRows = (balances || [])
    .filter(b => !DASHBOARD_HIDDEN_LEAVE_CODES.has(String(b.leave_code || '').toUpperCase()))
    .map(b => ({
      name: b.leave_name || b.leave_type || b.leave_code || 'Leave',
      available: num(b.available_days ?? (num(b.allocated_days) + num(b.carried_forward_days) - num(b.used_days) - num(b.pending_days))),
      used: num(b.used_days),
      pending: num(b.pending_days),
    }))
    .filter(b => b.available > 0 || b.used > 0 || b.pending > 0);
  const totalAvailable = balanceRows.reduce((s, b) => s + b.available, 0);

  const pendingLeave = attention.pending_leave_requests ?? 0;
  const recentLeaves = [...myLeaves]
    .sort((a, b) => dayKey(b.start_date || b.applied_at).localeCompare(dayKey(a.start_date || a.applied_at)))
    .slice(0, 5);

  const today = todayKey();
  const upcomingHolidays = holidays
    .filter(h => dayKey(h.date) >= today)
    .sort((a, b) => dayKey(a.date).localeCompare(dayKey(b.date)))
    .slice(0, 5);

  const recentTimesheets = (timesheets || []).slice(0, 5);

  // Only what isn't already on a card: expiring documents, assets to return.
  const alerts = [
    attention.expiring_documents > 0 && {
      key: 'docs', Icon: FileText,
      text: `${plural(attention.expiring_documents, 'document')} on your record expire${attention.expiring_documents === 1 ? 's' : ''} in the next 30 days — please send HR the renewed copy.`,
      // HR keeps employees' documents (no self-service vault since 2026-11-11), so no link.
    },
    exit && attention.assets_held > 0 && {
      key: 'assets', Icon: Package,
      text: `${plural(attention.assets_held, 'company asset')} still to be returned before your last working day.`,
    },
  ].filter(Boolean);

  const quickLinks = [
    { page: 'MyTickets',          label: 'Raise a ticket',      sub: 'IT or HR support',          Icon: LifeBuoy },
    { page: 'PerformanceReviews', label: 'My reviews',          sub: 'Performance & goals',       Icon: Star },
    { page: 'MyRequests',         label: 'My requests',         sub: 'Everything you have raised', Icon: Inbox },
  ].map(q => ({ ...q, onClick: linkTo(q.page) })).filter(q => q.onClick);

  const applyLeave = linkTo('ApplyLeave');
  // Designation / department / code are on the My Employment card — not repeated here.
  const heroSub = 'Your own employment, leave, attendance and pay record';

  return (
    <PageShell dock={
      <PageHero
        icon={UserCircle}
        eyebrow="My Dashboard"
        title={name}
        subtitle={heroSub}
        actions={<>
          <button type="button" className="plh-cta plh-cta--ghost" onClick={loadData} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'mhr-spin' : undefined} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {applyLeave && (
            <button type="button" className="plh-cta" onClick={applyLeave}>
              <Plus size={14} /> Apply Leave
            </button>
          )}
        </>}
      />
    }>
      <div className="mhr-root">

        {!loading && employmentErr && (
          <div className="mhr-banner is-warn" role="status">
            <AlertTriangle size={15} /> Couldn't load your employment details.
            <button type="button" className="mhr-link" onClick={loadData}>Retry</button>
          </div>
        )}
        {!loading && employment && !linked && (
          <div className="mhr-banner is-warn" role="status">
            <AlertTriangle size={15} />
            Your login is not linked to an employee record, so there is no HR record to show. Ask HR to link your account.
          </div>
        )}

        {/* ── Key figures — each appears only here ── */}
        <StatBand cols={4}>
          <Stat index={0} icon={Calendar} label="Leave available" tone="primary" loading={loading}
            value={balances === null ? '—' : `${fmtDays(totalAvailable)} days`}
            sub={balances === null ? "Couldn't load balance" : `${plural(balanceRows.length, 'leave type')}`}
            onClick={linkTo('MyLeaves') || undefined} />
          <Stat index={1} icon={CalendarClock} label="Leave requests pending" tone={pendingLeave ? 'warning' : 'neutral'} loading={loading}
            value={degraded.includes('pendingLeave') ? '—' : pendingLeave}
            sub={pendingLeave ? 'Awaiting approval' : 'Nothing awaiting approval'}
            onClick={linkTo('MyLeaves') || undefined} />
          <Stat index={2} icon={Clock} label="Present this month" tone="success" loading={loading}
            value={!att || degraded.includes('attendance') ? '—' : att.present}
            sub={att ? `${att.leave} on leave${att.half_day ? ` · ${att.half_day} half-day` : ''}${att.late_days ? ` · ${att.late_days} late` : ''}` : ''} />
          <Stat index={3} icon={AlertTriangle} label="Absent this month" tone={att?.absent ? 'danger' : 'neutral'} loading={loading}
            value={!att || degraded.includes('attendance') ? '—' : att.absent}
            warn={!!att?.absent}
            sub={att?.absent ? 'Tell your manager if this is wrong' : 'No absences recorded'} />
        </StatBand>

        {alerts.length > 0 && (
          <div className="mhr-alerts">
            {alerts.map(({ key, Icon, text, onClick }) => (
              <div key={key} className="mhr-alert">
                <Icon size={14} /> <span>{text}</span>
                <CardLink label="Open" onClick={onClick} />
              </div>
            ))}
          </div>
        )}

        {/* ── Employment ── */}
        <SectionTitle rule>Employment</SectionTitle>
        <div className={showProbation || exit ? 'mhr-grid' : ''}>
          <ContentCard className={showProbation || exit ? '' : 'mhr-card--wide'}
            title={<span className="mhr-title"><Briefcase size={14} /> My Employment</span>}
            headerActions={<CardLink label="All my details" onClick={linkTo('MyEmployeeRecord')} />}>
            {loading ? <Skeleton rows={6} /> : !linked ? <Empty>No employee record linked</Empty> : (
              <>
                <InfoRow label="Employee code"     value={emp.office_id} />
                <InfoRow label="Designation"       value={emp.designation} />
                <InfoRow label="Department"        value={emp.department} />
                <InfoRow label="Reporting manager" value={emp.reporting_manager} />
                <InfoRow label="Employment type"   value={emp.employment_type} />
                <InfoRow label="Grade"             value={emp.grade} />
                <InfoRow label="Date of joining"   value={emp.joining_date && `${fmtDate(emp.joining_date)}${tenure ? ` · ${tenure}` : ''}`} />
                <InfoRow label="Status"            value={emp.status} />
              </>
            )}
          </ContentCard>

          {/* Probation: only while it runs (or has ended without a decision).
              Once confirmed there is nothing to show. */}
          {showProbation && (
            <ContentCard title={<span className="mhr-title"><ShieldCheck size={14} /> Probation</span>}>
              <InfoRow label="Status" value={pv?.label} tone={pv?.tone} />
              <InfoRow label="Probation end date" value={fmtDate(probation?.probation_end_date)} />
              {probation?.state === 'on_probation' && (
                <InfoRow label="Days remaining" value={plural(probation.days_left, 'day')} />
              )}
              {probation?.review && (
                <InfoRow label="Probation review"
                  value={probation.review.decision
                    ? `${DECISION_LABEL[probation.review.decision] || titleCase(probation.review.decision)}${probation.review.new_end_date ? ` · new end ${fmtDate(probation.review.new_end_date)}` : ''}`
                    : (REVIEW_STATUS[probation.review.status] || titleCase(probation.review.status))} />
              )}
            </ContentCard>
          )}

          {/* Notice period: only once a resignation / exit is in progress. */}
          {exit && (
            <ContentCard title={<span className="mhr-title"><LogOut size={14} /> Resignation &amp; Notice</span>}>
              <div className="mhr-exit" role="status">
                <LogOut size={15} />
                <div>
                  <strong>Serving notice{exit.separation_type ? ` · ${titleCase(exit.separation_type)}` : ''}</strong>
                  <div className="mhr-exit-sub">
                    {exit.last_working_date
                      ? <>Last working day <b>{fmtDate(exit.last_working_date)}</b>{exit.days_left >= 0 ? ` · ${plural(exit.days_left, 'day')} left` : ''}</>
                      : 'Last working day not set yet'}
                  </div>
                </div>
              </div>
              <InfoRow label="Notice period" value={noticeDays ? `${noticeDays} days` : null}
                hint="Not recorded — ask HR" />
              <InfoRow label="Resignation submitted" value={fmtDate(exit.submitted_on)} />
              <InfoRow label="Last working day"      value={fmtDate(exit.last_working_date)} hint="Not set yet" />
              <InfoRow label="Exit status"           value={titleCase(exit.status)} />
              <InfoRow label="Exit clearance"        value={`${exit.clearance_done} of ${exit.clearance_total} done`} />
            </ContentCard>
          )}
        </div>

        {/* ── Sales target: only for someone with a yearly target ── */}
        {salesTarget && <MySalesTarget t={salesTarget} />}

        {/* ── Leave ── */}
        <SectionTitle rule>Leave</SectionTitle>
        <div className="mhr-grid">
          <ContentCard
            title={<span className="mhr-title"><Calendar size={14} /> Leave Balance</span>}
            headerActions={<CardLink label="My Leaves" onClick={linkTo('MyLeaves')} />}>
            {loading ? <Skeleton rows={4} /> : balances === null ? <Empty>Couldn't load your leave balance.</Empty>
              : balanceRows.length === 0 ? <Empty>No leave allocated to you yet.</Empty> : (
                <table className="mhr-table">
                  <thead><tr><th>Type</th><th>Available</th><th>Used</th><th>Pending</th></tr></thead>
                  <tbody>
                    {balanceRows.map(b => (
                      <tr key={b.name}>
                        <td>{b.name}</td>
                        <td className="is-strong">{fmtDays(b.available)}</td>
                        <td>{fmtDays(b.used)}</td>
                        <td>{fmtDays(b.pending)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </ContentCard>

          <ContentCard
            title={<span className="mhr-title"><CalendarClock size={14} /> My Recent Leave Requests</span>}
            headerActions={<CardLink label="View all" onClick={linkTo('MyLeaves')} />}>
            {loading ? <Skeleton rows={4} /> : recentLeaves.length === 0 ? <Empty>You haven't applied for leave yet.</Empty> : (
              recentLeaves.map((l, i) => {
                const st = String(l.status || '').toLowerCase();
                const days = num(l.days ?? l.number_of_days);
                return (
                  <div key={l.id || i} className="mhr-line">
                    <div className="mhr-line-main">
                      <span className="mhr-line-title">{l.leave_name || l.leave_type || 'Leave'}</span>
                      <span className="mhr-line-sub">
                        {fmtDate(l.start_date)}{dayKey(l.end_date) !== dayKey(l.start_date) ? ` – ${fmtDate(l.end_date)}` : ''}
                        {days ? ` · ${plural(days, 'day')}` : ''}
                      </span>
                    </div>
                    <span className={`mhr-pill is-${LEAVE_STATUS_TONE[st] || 'muted'}`}>{titleCase(st || 'unknown')}</span>
                  </div>
                );
              })
            )}
          </ContentCard>
        </div>

        {/* ── Company assets with me ── */}
        <SectionTitle rule>Company Assets</SectionTitle>
        <div className="mhr-grid">
          <ContentCard title={<span className="mhr-title"><Package size={14} /> Assets Issued to You</span>}>
            {loading ? <Skeleton rows={3} /> : myAssets === null ? <Empty>Couldn't load your assets.</Empty>
              : myAssets.length === 0 ? <Empty>No company assets are issued to you.</Empty> : (
                <table className="mhr-table">
                  <thead><tr><th>Asset</th><th>Tag / Serial</th><th>Issued</th><th>Status</th></tr></thead>
                  <tbody>
                    {myAssets.map(a => (
                      <tr key={a.id}>
                        <td className="is-strong">{a.asset_name}{a.asset_type ? <span className="mhr-line-sub"> · {a.asset_type}</span> : null}</td>
                        <td>{[a.asset_tag, a.serial_number].filter(Boolean).join(' / ') || '—'}</td>
                        <td>{fmtDate(a.allocated_date)}</td>
                        <td>{titleCase(String(a.status || '').replace(/_/g, ' '))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            {myAssets?.length > 0 && (
              <p className="mhr-line-sub" style={{ margin: '8px 0 0' }}>Something wrong or missing? Tell HR; they keep this register.</p>
            )}
          </ContentCard>

          <ContentCard title={<span className="mhr-title"><FileText size={14} /> Company Forms &amp; Documents</span>}>
            {loading ? <Skeleton rows={3} /> : forms === null ? <Empty>Couldn't load the company forms.</Empty>
              : forms.length === 0 ? <Empty>HR has not published any forms yet.</Empty> : (
                forms.slice(0, 12).map(d => (
                  <div key={d.id} className="mhr-line">
                    <div className="mhr-line-main">
                      <span className="mhr-line-title">{d.title}</span>
                      <span className="mhr-line-sub">{[d.category, d.file_type].filter(Boolean).join(' · ')}</span>
                    </div>
                    {d.file_url
                      ? <a className="mhr-pill is-info" href={d.file_url} target="_blank" rel="noopener noreferrer">Open</a>
                      : <span className="mhr-pill is-muted">No file</span>}
                  </div>
                ))
              )}
          </ContentCard>
        </div>

        {/* ── Holidays & team ── */}
        <SectionTitle rule>Calendar &amp; Team</SectionTitle>
        <div className="mhr-grid">
          <ContentCard
            title={<span className="mhr-title"><Gift size={14} /> Upcoming Holidays</span>}
            headerActions={<CardLink label="Holiday calendar" onClick={linkTo('HolidayCalendar')} />}>
            {loading ? <Skeleton rows={4} /> : upcomingHolidays.length === 0 ? <Empty>No more holidays on the calendar.</Empty> : (
              upcomingHolidays.map(h => (
                <div key={h.id || h.name + h.date} className="mhr-line">
                  <div className="mhr-date-chip">
                    <b>{dayKey(h.date).slice(8, 10)}</b>
                    <span>{new Date(`${dayKey(h.date)}T00:00:00`).toLocaleDateString('en-GB', { month: 'short' })}</span>
                  </div>
                  <div className="mhr-line-main">
                    <span className="mhr-line-title">{h.name}</span>
                    <span className="mhr-line-sub">{weekday(h.date)}{dayKey(h.date).slice(0, 4) !== today.slice(0, 4) ? ` · ${dayKey(h.date).slice(0, 4)}` : ''}{h.type ? ` · ${h.type}` : ''}</span>
                  </div>
                </div>
              ))
            )}
          </ContentCard>

          <ContentCard title={<span className="mhr-title"><Users size={14} /> My Team on Leave Today</span>}>
            {loading ? <Skeleton rows={3} /> : degraded.includes('teamOnLeave') ? <Empty>Couldn't load your team.</Empty>
              : team.length === 0 ? <Empty>Everyone in your team is in today.</Empty> : (
                team.map((m, i) => (
                  <div key={i} className="mhr-line">
                    <div className="mhr-avatar">{(m.name || '?')[0].toUpperCase()}</div>
                    <div className="mhr-line-main">
                      <span className="mhr-line-title">{m.name}</span>
                      <span className="mhr-line-sub">{[m.designation, m.back_after && `back after ${fmtDate(m.back_after)}`].filter(Boolean).join(' · ')}</span>
                    </div>
                  </div>
                ))
              )}
          </ContentCard>
        </div>

        {/* ── Pay & time ── */}
        <SectionTitle rule>Pay &amp; Time</SectionTitle>
        <div className={showTimesheets ? 'mhr-grid' : ''}>
          <ContentCard
            title={<span className="mhr-title"><FileText size={14} /> My Payslips</span>}
            headerActions={<CardLink label="Open My Payslip" onClick={linkTo('PayslipViewer')} />}>
            <MyPayslipsWidget />
          </ContentCard>

          {showTimesheets && (
            <ContentCard
              title={<span className="mhr-title"><Clock size={14} /> My Recent Timesheet Entries</span>}
              headerActions={<CardLink label="Log hours" onClick={linkTo('MyTimesheet')} />}>
              {loading ? <Skeleton rows={4} /> : recentTimesheets.length === 0 ? <Empty>No timesheet entries yet.</Empty> : (
                recentTimesheets.map((t, i) => {
                  const st = String(t.status || 'draft').toLowerCase();
                  return (
                    <div key={t.id || i} className="mhr-line">
                      <div className="mhr-line-main">
                        <span className="mhr-line-title">{t.project_name || t.task_title || t.task_description || t.description || 'Timesheet entry'}</span>
                        <span className="mhr-line-sub">
                          {fmtDate(t.work_date || t.entry_date)} · {num(t.hours_worked ?? t.hours)}h
                          {t.task_title && t.project_name ? ` · ${t.task_title}` : ''}
                        </span>
                      </div>
                      <span className={`mhr-pill is-${st === 'approved' ? 'ok' : st === 'rejected' ? 'bad' : 'warn'}`}>{titleCase(st)}</span>
                    </div>
                  );
                })
              )}
            </ContentCard>
          )}
        </div>

        {/* ── Other self-service pages (not already linked above) ── */}
        {quickLinks.length > 0 && (
          <>
            <SectionTitle rule>More for you</SectionTitle>
            <div className="mhr-quick">
              {quickLinks.map(({ page, label, sub, Icon, onClick }) => (
                <button key={page} type="button" className="mhr-quick-card" onClick={onClick}>
                  <span className="mhr-quick-ico"><Icon size={18} /></span>
                  <span className="mhr-quick-txt">
                    <span className="mhr-quick-label">{label}</span>
                    <span className="mhr-quick-sub">{sub}</span>
                  </span>
                  <ArrowRight size={14} className="mhr-quick-arrow" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
