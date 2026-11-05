import { useState, useEffect, useCallback, useRef } from "react";
import {
  RefreshCw, Search, Bell, Clock, AlertTriangle, CheckCircle,
  Users, ChevronDown, ChevronUp, Send, X, Star, History,
} from "lucide-react";
import api from "@/services/api/client";
import ResultDialog from "@/components/ResultDialog";
import "./Probation.css";
import DepartmentHeadsPanel from "../components/DepartmentHeadsPanel";
import ProbationReviewsPanel from "../components/ProbationReviewsPanel";
import { PageHero, PageShell } from '@/components/pulse-ui';

/* ── helpers ── */
/*
 * Probation dates come from the SERVER. employees.probation_end_date is the one
 * canonical end date (backend shared/probationDates.js writes it). This page
 * used to compute joining + 180 days (90 for interns, 120 for trainees) and
 * ignore the stored date entirely, so it disagreed with the dashboard, leave
 * and the reminder job about the same employee. It now only measures the days
 * between stored dates; an employee with no stored end date is shown as
 * "No end date", never given a guessed one.
 */
const DAY_MS = 86400000;
// After a send, the same employee's Notify button rests this long (guards a
// double send). It says why on hover; it used to just grey out.
const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
function utcDay(value) {
  if (!value) return null;
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}
function todayUtc() {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

const AVATAR_PALETTE = [
  ['#6d28d9','#ede9fe'],['#0369a1','#e0f2fe'],['#047857','#d1fae5'],
  ['#6d28d9','#ede9fe'],['#be123c','#ffe4e6'],['#0f766e','#ccfbf1'],
  ['#7c2d12','#ede9fe'],['#1e40af','#dbeafe'],
];
function avatarColor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
function initials(f = '', l = '') {
  return ((f[0] || '') + (l[0] || '')).toUpperCase();
}

/**
 * Where an employee stands against their STORED end date (inclusive: the end
 * date is their last day on probation, so 0 days remain on it). `attentionDays`
 * is the company's reminder lead time — the same window the reminder job uses.
 */
function calcProbation(emp = {}, attentionDays = 14) {
  const end = utcDay(emp.probation_end_date);
  if (end == null) return null;
  const start = utcDay(emp.joining_date);
  const today = todayUtc();
  const remaining = Math.round((end - today) / DAY_MS);
  const totalDays = start != null ? Math.round((end - start) / DAY_MS) + 1 : null;
  const elapsed = start != null ? Math.max(0, Math.round((today - start) / DAY_MS)) : null;
  const pct = totalDays ? Math.min(100, Math.max(0, (elapsed / totalDays) * 100)) : 0;
  let status = "safe";
  if      (remaining < 0)              status = "overdue";
  else if (remaining <= attentionDays) status = "critical";
  else if (remaining <= 30)            status = "warning";
  return { start, end, elapsed, remaining, pct, status, totalDays };
}

const STATUS_CFG = {
  safe     : { label: 'On Track',   color: '#15803d', bg: '#dcfce7', barColor: '#22c55e' },
  warning  : { label: 'Due Soon',   color: '#6d28d9', bg: '#ede9fe', barColor: '#7c5cf0' },
  critical : { label: 'Critical',   color: '#b91c1c', bg: '#fee2e2', barColor: '#ef4444' },
  overdue  : { label: 'Overdue',    color: '#9d174d', bg: '#fce7f3', barColor: '#ec4899' },
};

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}
function timeAgo(ts) {
  if (!ts) return null;
  const d = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (d < 1)    return 'just now';
  if (d < 60)   return `${d}m ago`;
  if (d < 1440) return `${Math.floor(d / 60)}h ago`;
  if (d < 10080) return `${Math.floor(d / 1440)}d ago`;
  return fmtDate(ts);
}

/* ── main component ── */
export default function Probation() {
  const [employees,   setEmployees]   = useState([]);
  const [allEmps,     setAllEmps]     = useState([]);
  const [activeEmps,  setActiveEmps]  = useState([]);
  const [history,     setHistory]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);
  const [activeTab,   setActiveTab]   = useState('all');
  const [search,      setSearch]      = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [dialog,      setDialog]      = useState(null);

  /* notify modal */
  const [modalEmp,      setModalEmp]      = useState(null);
  const [notifyTo,      setNotifyTo]      = useState('');
  // The recipient is an EMPLOYEE ID of this company — the server resolves
  // their login. A typed name that was not picked from the list has no id.
  const [notifyToId,    setNotifyToId]    = useState(null);
  const [notifyType,    setNotifyType]    = useState('approval');
  const [notifyRemarks, setNotifyRemarks] = useState('');
  const [suggestions,   setSuggestions]   = useState([]);
  const notifyTyped = useRef(false);   // false = value was prefilled or picked, not typed
  const [sending,       setSending]       = useState(false);

  /* decision modal */
  const [decRecord,   setDecRecord]   = useState(null);
  const [decision,    setDecision]    = useState('');
  const [rating,      setRating]      = useState(0);
  const [comments,    setComments]    = useState('');
  const [decidingSending, setDecidingSending] = useState(false);
  /* company probation policy (Probation settings) */
  const [policy,        setPolicy]        = useState(null);
  const [policyEdit,    setPolicyEdit]    = useState(null);   // { months, days } while editing
  const [policySaving,  setPolicySaving]  = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true);
    try {
      const [empRes, histRes, activeRes, policyRes] = await Promise.allSettled([
        api.get('/employees', { params: { status: 'Probation' } }),
        api.get('/probation'),
        api.get('/employees', { params: { status: 'Active' } }),
        api.get('/probation/settings'),
      ]);
      if (policyRes.status === 'fulfilled') setPolicy(policyRes.value.data);
      const empsRaw = empRes.status === 'fulfilled' ? empRes.value.data : [];
      const hist = histRes.status === 'fulfilled' ? histRes.value.data : [];
      const EX = new Set(['left','terminated','resigned','inactive','ex-employee','notice_period','notice period']);
      const probation = (Array.isArray(empsRaw) ? empsRaw : []).filter(e => {
        const s = e.status?.toLowerCase() ?? '';
        return (s === 'probation' || e.employment_type?.toLowerCase() === 'probation') && !EX.has(s);
      });
      setEmployees(probation);
      setAllEmps((Array.isArray(empsRaw) ? empsRaw : []).filter(e => !EX.has(e.status?.toLowerCase() ?? '')));
      const activeRaw = activeRes.status === 'fulfilled' ? activeRes.value.data : [];
      setActiveEmps(Array.isArray(activeRaw) ? activeRaw : []);
      setHistory(hist);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ── KPI counts ── */
  const attentionDays = policy?.reminder_days ?? 14;
  const enriched = employees.map(e => ({ ...e, prob: calcProbation(e, attentionDays) }));
  const kpi = {
    total    : enriched.length,
    undated  : enriched.filter(e => !e.prob).length,
    critical : enriched.filter(e => e.prob?.status === 'critical').length,
    warning  : enriched.filter(e => e.prob?.status === 'warning').length,
    overdue  : enriched.filter(e => e.prob?.status === 'overdue').length,
    safe     : enriched.filter(e => e.prob?.status === 'safe').length,
  };

  /* ── filter ── */
  const filtered = enriched.filter(e => {
    const matchTab = activeTab === 'all'
      || (activeTab === 'undated' ? !e.prob : e.prob?.status === activeTab);
    const q = search.toLowerCase();
    const matchSearch = !q ||
      `${e.first_name} ${e.last_name}`.toLowerCase().includes(q) ||
      e.office_id?.toLowerCase().includes(q) ||
      e.department?.toLowerCase().includes(q);
    return matchTab && matchSearch;
  });

  /* ── last notification per employee ── */
  const lastNotif = {};
  history.forEach(h => {
    if (!lastNotif[h.employee_id] || new Date(h.created_at) > new Date(lastNotif[h.employee_id].created_at)) {
      lastNotif[h.employee_id] = h;
    }
  });
  const extensionHistoryByEmp = {};
  history.forEach(h => {
    if (String(h.decision || '').toLowerCase() === 'extended') {
      if (!extensionHistoryByEmp[h.employee_id]) extensionHistoryByEmp[h.employee_id] = [];
      extensionHistoryByEmp[h.employee_id].push(h);
    }
  });

  // The page used to POST a "probation_due" alert for every critical/overdue
  // employee on EVERY load, de-duplicated only in this browser's localStorage —
  // so each new browser, device or cleared cache re-sent all of them (146
  // pending log rows and 201 notifications for three employees). Reminders now
  // come only from the daily job (backend jobs/probation.cron.js), which keeps a
  // durable once-per-end-date ledger. Opening this page sends nothing.

  /* ── autocomplete ── */
  // Was type-to-reveal: with the field empty the list stayed hidden, so you had
  // to already know a name to notify anyone. It is a dropdown now — focusing the
  // field opens the list, typing narrows it.
  const notifyPool = () =>
    [...activeEmps, ...allEmps.filter(e => !activeEmps.some(a => a.id === e.id))];

  const matchEmployees = v => {
    const q = (v || '').trim().toLowerCase();
    const pool = notifyPool();
    if (!q) return pool.slice(0, 50);
    return pool.filter(e =>
      `${e.first_name} ${e.last_name}`.toLowerCase().includes(q) ||
      e.office_id?.toLowerCase().includes(q)
    ).slice(0, 50);
  };

  const handleNotifyInput = v => {
    notifyTyped.current = true;
    setNotifyTo(v);
    setNotifyToId(null);      // typing invalidates the picked person
    setSuggestions(matchEmployees(v));
  };

  // Focusing a field that still holds a prefilled or already-picked name should
  // open the whole list — filtering by that name would show one row and hide
  // everyone you might switch to.
  const openNotifyList = () =>
    setSuggestions(matchEmployees(notifyTyped.current ? notifyTo : ''));

  /* ── send notification ── */
  const handleSend = async () => {
    if (!notifyToId) {
      setDialog({ type:'warning', title:'Required', message:'Pick the person to notify from the list.' });
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post('/probation', {
        employee_id    : modalEmp.id,
        notified_to_employee_id: notifyToId,
        notified_role  : 'Manager',
        notification_type: notifyType,
        remarks        : notifyRemarks,
      });
      // Recorded either way; say plainly when the person has no login to receive it.
      const message = data?.recipient_has_login === false
        ? `Recorded. ${notifyTo} has no Pulse login, so no in-app notification could be delivered to them.`
        : `${notifyTo} has been notified about ${modalEmp.first_name}'s probation.`;
      setDialog({ type: data?.recipient_has_login === false ? 'warning' : 'success', title:'Notification Sent', message, autoClose: 3500 });
      setModalEmp(null);
      setNotifyTo(''); setNotifyToId(null); setNotifyRemarks(''); notifyTyped.current = false; setSuggestions([]);
      load(true);
    } catch (err) {
      setDialog({ type:'error', title:'Failed to Send', message: err?.response?.data?.error || 'Could not send notification. Please try again.' });
    } finally {
      setSending(false);
    }
  };

  /* ── company probation policy ── */
  const savePolicy = async () => {
    setPolicySaving(true);
    try {
      const { data } = await api.put('/probation/settings', {
        probation_months: policyEdit.months,
        reminder_days: policyEdit.days,
      });
      setPolicy(data);
      setPolicyEdit(null);
      setDialog({ type:'success', title:'Policy Saved', message:'New employees will use this probation period. Saved end dates are not changed.', autoClose: 2500 });
    } catch (err) {
      setDialog({ type:'error', title:'Not Saved', message: err?.response?.data?.error || 'Could not save the probation policy.' });
    } finally {
      setPolicySaving(false);
    }
  };

  /* ── save decision ── */
  const handleDecision = async () => {
    if (!decision) {
      setDialog({ type:'warning', title:'Required', message:'Please select a decision.' });
      return;
    }
    setDecidingSending(true);
    try {
      await api.put(`/probation/${decRecord.id}`, { decision, performance_rating: rating, comments });
      setDialog({ type:'success', title:'Decision Saved', message:'Probation outcome has been recorded.', autoClose: 2000 });
      setDecRecord(null); setDecision(''); setRating(0); setComments('');
      load(true);
    } catch {
      setDialog({ type:'error', title:'Failed', message:'Could not save decision.' });
    } finally {
      setDecidingSending(false);
    }
  };

  /* ── render ── */
  return (
    <PageShell dock={
      <PageHero
        icon={Users}
        eyebrow="Human Resources"
        title="Probation Management"
        subtitle="Track, notify, and close probation periods for all employees"
        actions={<>
          <button
            className="plh-cta plh-cta--ghost"
            onClick={() => load(true)}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <button className="plh-cta" onClick={() => setShowHistory(v => !v)}>
            <History size={14} />
            Notification Log
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </>}
      />
    }>
      {/* Header */}


      {/* KPI */}
      <div className="prob-kpi-row">
        <div className="prob-kpi">
          <div className="prob-kpi-icon" style={{ background: '#eff6ff' }}>
            <Users size={20} color="#1d4ed8" />
          </div>
          <div className="prob-kpi-body">
            <div className="prob-kpi-val" style={{ color: '#1d4ed8' }}>{kpi.total}</div>
            <div className="prob-kpi-label">On Probation</div>
          </div>
        </div>
        <div className="prob-kpi">
          <div className="prob-kpi-icon" style={{ background: '#fee2e2' }}>
            <AlertTriangle size={20} color="#dc2626" />
          </div>
          <div className="prob-kpi-body">
            <div className="prob-kpi-val" style={{ color: '#dc2626' }}>{kpi.critical + kpi.overdue}</div>
            <div className="prob-kpi-label">Needs Attention</div>
          </div>
        </div>
        <div className="prob-kpi">
          <div className="prob-kpi-icon" style={{ background: '#ede9fe' }}>
            <Clock size={20} color="#6d28d9" />
          </div>
          <div className="prob-kpi-body">
            <div className="prob-kpi-val" style={{ color: '#6d28d9' }}>{kpi.warning}</div>
            <div className="prob-kpi-label">Due in 30 Days</div>
          </div>
        </div>
        <div className="prob-kpi">
          <div className="prob-kpi-icon" style={{ background: '#dcfce7' }}>
            <CheckCircle size={20} color="#16a34a" />
          </div>
          <div className="prob-kpi-body">
            <div className="prob-kpi-val" style={{ color: '#16a34a' }}>{kpi.safe}</div>
            <div className="prob-kpi-label">On Track</div>
          </div>
        </div>
      </div>

      {/* Company probation policy — the period new hires get by default and
          how far ahead the daily reminder goes to HR. Changing it never
          rewrites an end date that is already saved. */}
      {policy && (
        <div className="prob-policy" role="group" aria-label="Probation policy">
          {policyEdit ? (
            <>
              <label>
                Default period
                <input type="number" min={1} max={24} value={policyEdit.months}
                  onChange={e => setPolicyEdit(p => ({ ...p, months: e.target.value }))} /> months
              </label>
              <label>
                Remind HR
                <input type="number" min={0} max={90} value={policyEdit.days}
                  onChange={e => setPolicyEdit(p => ({ ...p, days: e.target.value }))} /> days before the end date
              </label>
              <button className="prob-modal-send" onClick={savePolicy} disabled={policySaving}>
                {policySaving ? 'Saving…' : 'Save'}
              </button>
              <button className="prob-modal-cancel" onClick={() => setPolicyEdit(null)}>Cancel</button>
            </>
          ) : (
            <>
              <span>
                Default probation <strong>{policy.probation_months} months</strong>
                {policy.months_is_default ? ' (standard)' : ''}
                {' · '}HR is reminded <strong>{policy.reminder_days} days</strong> before the end date
                {policy.reminder_days_is_default ? ' (standard)' : ''}
              </span>
              <button className="prob-hist-action-btn"
                onClick={() => setPolicyEdit({ months: policy.probation_months, days: policy.reminder_days })}>
                Edit policy
              </button>
            </>
          )}
        </div>
      )}

      {/* Who reviews probations, per department. Its own permission checks:
          hr:view to read, hr:edit to change (enforced by the server). */}
      <DepartmentHeadsPanel />

      {/* Open reviews and whether each reviewer is still the eligible head;
          reassignment via the existing endpoint (hr:edit). */}
      <ProbationReviewsPanel />

      {/* Notification history panel */}
      {showHistory && (
        <div className="prob-history">
          <div className="prob-history-head">
            <h3>Notification History</h3>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>{history.length} records</span>
          </div>
          {history.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No notifications sent yet
            </div>
          ) : (
            <>
              <div className="prob-hist-row prob-hist-head-row">
                <span>Employee</span>
                <span>Notified To</span>
                <span>Type</span>
                <span>Date</span>
                <span>Action</span>
              </div>
              {history.slice(0, 20).map(h => {
                const [_c] = avatarColor(`${h.first_name}${h.last_name}`);
                const dec = h.decision || 'pending';
                return (
                  <div key={h.id} className="prob-hist-row">
                    <div>
                      <div className="prob-hist-name">{h.first_name} {h.last_name}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{h.office_id}</div>
                    </div>
                    <div className="prob-hist-to">{h.notified_to || '—'}</div>
                    <div>
                      <span className={`prob-hist-type prob-hist-type-${h.notification_type || 'approval'}`}>
                        {(h.notification_type || 'approval').replace('_', ' ')}
                      </span>
                    </div>
                    <div className="prob-hist-date">{timeAgo(h.created_at)}</div>
                    <div>
                      {dec === 'pending' ? (
                        <button
                          className="prob-hist-action-btn"
                          onClick={() => { setDecRecord(h); setDecision(''); setRating(0); setComments(''); }}
                        >
                          Record Decision
                        </button>
                      ) : (
                        <span className={`prob-hist-decision prob-hist-decision-${dec}`}>
                          {dec}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Filters + search */}
      <div className="prob-tabs">
        {[
          { key: 'all',      label: 'All',       count: kpi.total },
          { key: 'critical', label: 'Critical',  count: kpi.critical },
          { key: 'overdue',  label: 'Overdue',   count: kpi.overdue },
          { key: 'warning',  label: 'Due Soon',  count: kpi.warning },
          { key: 'safe',     label: 'On Track',  count: kpi.safe },
          { key: 'undated',  label: 'No End Date', count: kpi.undated },
        ].map(t => (
          <button
            key={t.key}
            className={`prob-tab${activeTab === t.key ? ' active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
            <span className="prob-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="prob-search-row">
        <div className="prob-search-wrap">
          <Search size={14} className="prob-search-icon" />
          <input
            className="prob-search"
            placeholder="Search by name, ID, or department…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Cards */}
      {loading ? (
        <div className="prob-empty">
          <div className="prob-empty-icon"><Clock size={26} /></div>
          <h3>Loading…</h3>
          <p>Fetching probation data</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="prob-empty">
          <div className="prob-empty-icon"><Users size={26} /></div>
          <h3>No employees found</h3>
          <p>{search ? 'Try a different search term' : 'No employees on probation in this category'}</p>
        </div>
      ) : (
        <div className="prob-cards">
          {filtered.map(emp => {
            const prob = emp.prob;
            const cfg  = prob ? STATUS_CFG[prob.status] : STATUS_CFG.safe;
            const [avatarBg] = avatarColor(`${emp.first_name}${emp.last_name}`);
            const last = lastNotif[emp.id];
            const coolingDown = !!last && (Date.now() - new Date(last.created_at).getTime()) < NOTIFY_COOLDOWN_MS;
            const btnClass =
              prob?.status === 'overdue' || prob?.status === 'critical'
                ? 'prob-notify-btn-danger'
                : prob?.status === 'warning'
                ? 'prob-notify-btn-warn'
                : 'prob-notify-btn-primary';

            return (
              <div key={emp.id} className="prob-card">
                {/* Top row */}
                <div className="prob-card-top">
                  <div className="prob-avatar" style={{ background: avatarBg }}>
                    {initials(emp.first_name, emp.last_name)}
                  </div>
                  <div className="prob-card-info">
                    <div className="prob-card-name">
                      {emp.first_name} {emp.last_name}
                    </div>
                    <div className="prob-card-sub">{emp.office_id || '—'}</div>
                    <div className="prob-card-badges">
                      {emp.department && <span className="prob-badge prob-badge-dept">{emp.department}</span>}
                      {emp.designation && <span className="prob-badge prob-badge-desig">{emp.designation}</span>}
                    </div>
                  </div>
                  {prob ? (
                    <span
                      className={`prob-status-pill prob-status-${prob.status}`}
                    >
                      {cfg.label}
                    </span>
                  ) : (
                    <span className="prob-status-pill prob-status-undated">No end date</span>
                  )}
                </div>

                {/* Timeline bar */}
                {prob && (
                  <div className="prob-timeline">
                    <div className="prob-timeline-header">
                      <span className="prob-timeline-label">
                        {prob.totalDays != null
                          ? `${Math.min(prob.elapsed, prob.totalDays)} / ${prob.totalDays} days elapsed`
                          : 'Joining date not recorded'}
                      </span>
                      <span
                        className="prob-days-chip"
                        style={{ background: cfg.bg, color: cfg.color }}
                      >
                        {prob.remaining > 0
                          ? `${prob.remaining}d left`
                          : prob.remaining === 0 ? 'Ends today'
                          : `${Math.abs(prob.remaining)}d overdue`}
                      </span>
                    </div>
                    <div className="prob-bar-track">
                      <div
                        className="prob-bar-fill"
                        style={{ width: `${prob.pct}%`, background: cfg.barColor }}
                      />
                    </div>
                  </div>
                )}

                {/* Info grid */}
                <div className="prob-info-row">
                  <div className="prob-info-item">
                    <div className="prob-info-key">Joined</div>
                    <div className="prob-info-val">{fmtDate(emp.joining_date)}</div>
                  </div>
                  <div className="prob-info-item">
                    <div className="prob-info-key">Probation Ends</div>
                    <div className="prob-info-val" style={{ color: prob ? cfg.color : '#9ca3af' }}>
                      {emp.probation_end_date ? fmtDate(emp.probation_end_date) : 'Not set — edit the employee'}
                    </div>
                  </div>
                  <div className="prob-info-item">
                    <div className="prob-info-key">Manager</div>
                    <div className="prob-info-val">{emp.reporting_manager || '—'}</div>
                  </div>
                  <div className="prob-info-item">
                    <div className="prob-info-key">Location</div>
                    <div className="prob-info-val">{emp.location || '—'}</div>
                  </div>
                </div>

                {/* Footer */}
                <div className="prob-card-footer">
                  <div className="prob-last-notif">
                    {last
                      ? <>Last notified <span>{timeAgo(last.created_at)}</span></>
                      : <span style={{ color: '#9ca3af' }}>Not notified yet</span>
                    }
                  </div>
                  {last && (Date.now() - new Date(last.created_at).getTime()) < (1000 * 60 * 60 * 24) && (
                    <span style={{ fontSize: 11, color: '#6d28d9', marginRight: 8 }}>Reminder sent today</span>
                  )}
                  <button
                    className={`prob-notify-btn ${btnClass}`}
                    disabled={coolingDown}
                    title={coolingDown
                      ? `Notified ${timeAgo(last.created_at)} — you can notify again after ${new Date(new Date(last.created_at).getTime() + NOTIFY_COOLDOWN_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : undefined}
                    onClick={() => {
                      setModalEmp(emp);
                      setNotifyTo(emp.reporting_manager_id ? (emp.reporting_manager || '') : '');
                      setNotifyToId(emp.reporting_manager_id || null);
                      setNotifyType(
                        prob?.status === 'overdue' || prob?.status === 'critical'
                          ? 'probation_due'
                          : prob?.status === 'warning'
                          ? 'probation_warning'
                          : 'approval'
                      );
                      setNotifyRemarks('');
                      notifyTyped.current = false;
                      setSuggestions([]);
                    }}
                  >
                    <Bell size={12} />
                    Notify
                  </button>
                </div>
                {extensionHistoryByEmp[emp.id]?.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', borderTop: '1px dashed #e5e7eb', paddingTop: 8 }}>
                    Extension timeline: {extensionHistoryByEmp[emp.id]
                      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                      .map((x, i) => `${i + 1}) ${fmtDate(x.created_at)}`)
                      .join('  •  ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Notify modal ── */}
      {modalEmp && (() => {
        const prob = calcProbation(modalEmp, attentionDays);
        const cfg  = prob ? STATUS_CFG[prob.status] : STATUS_CFG.safe;
        const [avatarBg] = avatarColor(`${modalEmp.first_name}${modalEmp.last_name}`);
        return (
          <div className="prob-modal-backdrop" onClick={() => setModalEmp(null)}>
            <div className="prob-modal" onClick={e => e.stopPropagation()}>
              <div className="prob-modal-head">
                <div>
                  <h2>Send Probation Notification</h2>
                  <p>Notify manager or HR about this employee's probation status</p>
                </div>
                <button className="prob-modal-close" onClick={() => setModalEmp(null)}>
                  <X size={14} />
                </button>
              </div>

              <div className="prob-modal-body">
                {/* Employee card */}
                <div className="prob-modal-emp">
                  <div className="prob-modal-emp-avatar" style={{ background: avatarBg }}>
                    {initials(modalEmp.first_name, modalEmp.last_name)}
                  </div>
                  <div>
                    <div className="prob-modal-emp-name">
                      {modalEmp.first_name} {modalEmp.last_name}
                    </div>
                    <div className="prob-modal-emp-meta">
                      {modalEmp.office_id}
                      {modalEmp.department ? ` · ${modalEmp.department}` : ''}
                      {modalEmp.designation ? ` · ${modalEmp.designation}` : ''}
                    </div>
                    {prob && (
                      <div className="prob-modal-bar" style={{ marginTop: 8 }}>
                        <div className="prob-bar-track" style={{ height: 5 }}>
                          <div
                            className="prob-bar-fill"
                            style={{ width: `${prob.pct}%`, background: cfg.barColor }}
                          />
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                          {prob.elapsed != null ? `${prob.elapsed} days elapsed · ` : ''}probation ends {fmtDate(modalEmp.probation_end_date)}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="prob-modal-emp-right">
                    <div className="prob-modal-emp-end">Days left</div>
                    <div
                      className="prob-modal-emp-days"
                      style={{ color: cfg.color }}
                    >
                      {prob
                        ? prob.remaining > 0 ? prob.remaining : `+${Math.abs(prob.remaining)}`
                        : '—'}
                    </div>
                  </div>
                </div>

                {/* Notify To */}
                <div className="prob-field">
                  <label>Notify To *</label>
                  <div className="prob-field-autocomplete">
                    <input
                      placeholder="Select an employee — or type a name or ID"
                      value={notifyTo}
                      onChange={e => handleNotifyInput(e.target.value)}
                      onFocus={openNotifyList}
                      onBlur={() => setTimeout(() => setSuggestions([]), 160)}
                    />
                    {suggestions.length > 0 && (
                      // preventDefault keeps focus in the input: otherwise pressing
                      // on the list blurred it, the blur timer closed the list, and
                      // a slow click or a scrollbar drag picked no one.
                      <div className="prob-suggestions" onMouseDown={e => e.preventDefault()}>
                        {suggestions.map(s => {
                          const [sb] = avatarColor(`${s.first_name}${s.last_name}`);
                          return (
                            <div
                              key={s.id}
                              className="prob-suggestion-item"
                              onClick={() => { notifyTyped.current = false; setNotifyTo(`${s.first_name} ${s.last_name}`); setNotifyToId(s.id); setSuggestions([]); }}
                            >
                              <div className="prob-suggestion-av" style={{ background: sb }}>
                                {initials(s.first_name, s.last_name)}
                              </div>
                              <div>
                                <div className="prob-suggestion-name">
                                  {s.first_name} {s.last_name}
                                </div>
                                <div className="prob-suggestion-sub">
                                  {s.office_id} · {s.designation || s.employee_role || 'Employee'}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Notification type */}
                <div className="prob-field">
                  <label>Notification Type</label>
                  <select value={notifyType} onChange={e => setNotifyType(e.target.value)}>
                    <option value="approval">General — Probation Review</option>
                    <option value="probation_warning">Warning — Probation Due Soon (15 days)</option>
                    <option value="probation_due">Final — Probation End Date Reached</option>
                  </select>
                </div>

                {/* Remarks */}
                <div className="prob-field">
                  <label>Remarks (optional)</label>
                  <textarea
                    placeholder="Add context or instructions for the reviewer…"
                    value={notifyRemarks}
                    onChange={e => setNotifyRemarks(e.target.value)}
                  />
                </div>
              </div>

              <div className="prob-modal-footer">
                <button className="prob-modal-cancel" onClick={() => setModalEmp(null)}>Cancel</button>
                <button className="prob-modal-send" onClick={handleSend} disabled={sending}>
                  <Send size={13} />
                  {sending ? 'Sending…' : 'Send Notification'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Decision modal ── */}
      {decRecord && (
        <div className="prob-modal-backdrop" onClick={() => setDecRecord(null)}>
          <div className="prob-dec-modal" onClick={e => e.stopPropagation()}>
            <div className="prob-dec-head">
              <div>
                <h2>Record Probation Decision</h2>
                <p style={{ fontSize: 12, opacity: .8, margin: '3px 0 0' }}>
                  {decRecord.first_name} {decRecord.last_name}
                </p>
              </div>
              <button className="prob-modal-close" onClick={() => setDecRecord(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="prob-dec-body">
              <div className="prob-field">
                <label>Decision *</label>
                <select value={decision} onChange={e => setDecision(e.target.value)}>
                  <option value="">— Select outcome —</option>
                  <option value="confirmed">Confirmed — Employee Retained</option>
                  <option value="extended">Extended — Probation Extended</option>
                  <option value="terminated">Terminated — Employment Ended</option>
                </select>
              </div>
              <div className="prob-field">
                <label>Performance Rating</label>
                <div className="prob-rating-row">
                  {[1,2,3,4,5].map(n => (
                    <button
                      key={n}
                      className={`prob-star${rating >= n ? ' active' : ''}`}
                      onClick={() => setRating(n)}
                    >
                      <Star size={16} fill={rating >= n ? '#7c5cf0' : 'none'} color={rating >= n ? '#7c5cf0' : '#d1d5db'} />
                    </button>
                  ))}
                  <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 6, alignSelf: 'center' }}>
                    {rating ? `${rating}/5` : 'Not rated'}
                  </span>
                </div>
              </div>
              <div className="prob-field">
                <label>Comments</label>
                <textarea
                  placeholder="Notes on performance, reason for decision…"
                  value={comments}
                  onChange={e => setComments(e.target.value)}
                />
              </div>
            </div>
            <div className="prob-modal-footer">
              <button className="prob-modal-cancel" onClick={() => setDecRecord(null)}>Cancel</button>
              <button
                className="prob-modal-send"
                style={{ background: '#6B3FDB' }}
                onClick={handleDecision}
                disabled={decidingSending}
              >
                {decidingSending ? 'Saving…' : 'Save Decision'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Last, so it paints over the notify/decision modals. It shares their
          z-index (10000), and while it sat above them in the tree every warning
          or error raised from inside a modal ("Pick the person to notify",
          "Failed to Send") rendered underneath it — Send looked dead. */}
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />
    </PageShell>
  );
}


