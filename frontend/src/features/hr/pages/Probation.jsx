import { useState, useEffect, useCallback, useRef } from "react";
import LearningSnapshot from '@/features/hr/learning/LearningSnapshot';
import {
  RefreshCw, Search, Bell, Clock, AlertTriangle, CheckCircle,
  Users, ChevronDown, ChevronUp, Send, X, Star, History, ClipboardCheck, Download,
} from "lucide-react";
import api from "@/services/api/client";
import { useAuth } from "@/context/AuthContext";
import ResultDialog from "@/components/ResultDialog";
import "./Probation.css";
import ProbationReviewsPanel from "../components/ProbationReviewsPanel";
import { PageHero, PageShell, LoadError } from '@/components/pulse-ui';

/* ── helpers ── */
/*
 * Probation dates come from the SERVER. employees.probation_end_date is the one
 * canonical end date (backend shared/probationDates.js writes it). This page
 * only measures the days between stored dates; an employee with no stored end
 * date is shown as "No end date", never given a guessed one.
 *
 * ONE decision path (2026-11-11): HR requests a review → the department head
 * submits a rating and recommendation → HR records the decision here, and the
 * server applies it to the employee in the same transaction (confirmed →
 * Active + confirmation date; extended → new end date; not confirmed → an exit
 * request). The old "Record Decision" on reminder-log rows never reached the
 * employee and is gone; the log is now only a record of reminders sent.
 *
 * Department heads (who reviews each department) are set on their own page,
 * HR › Department Heads — they also decide gate-pass approvers and manager
 * access, so they are not a probation setting.
 */
const DAY_MS = 86400000;
// After a send, the same employee's reminder button rests this long (guards a
// double send). It says why on hover.
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
function todayIso() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function addDaysIso(isoDate, n) {
  const t = utcDay(isoDate);
  if (t == null) return null;
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
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

export const RECOMMENDATION_LABEL = { confirm: 'Confirm', extend: 'Extend', not_confirm: 'Do not confirm' };
export const DECISION_LABEL = { confirmed: 'Confirmed', extended: 'Extended', not_confirmed: 'Not confirmed' };
const RECOMMENDATION_TO_DECISION = { confirm: 'confirmed', extend: 'extended', not_confirm: 'not_confirmed' };

function fmtDate(d) {
  if (!d) return '—';
  const s = String(d);
  // A bare calendar date is read as that day, not UTC midnight shifted.
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  if (Number.isNaN(t.getTime())) return '—';
  return t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
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

const EMPTY_DECISION = { decision: '', effective_date: '', extension_months: '3', last_working_date: '', notice_days: '', notes: '' };

/* ── main component ── */
export default function Probation({ setPage } = {}) {
  const { hasPermission } = useAuth() || {};
  const canEdit = !!hasPermission?.('hr', 'edit');
  const canAdd = !!hasPermission?.('hr', 'add');

  const [employees,   setEmployees]   = useState([]);
  const [allEmps,     setAllEmps]     = useState([]);
  const [activeEmps,  setActiveEmps]  = useState([]);
  const [history,     setHistory]     = useState([]);
  const [loadFailed,  setLoadFailed]  = useState([]);   // parts of the page that did not load
  const [reviews,     setReviews]     = useState([]);
  const [awaiting,    setAwaiting]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);
  const [view,        setView]        = useState('current');   // current | reviews | history
  const [activeTab,   setActiveTab]   = useState('all');
  const [search,      setSearch]      = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [dialog,      setDialog]      = useState(null);
  const [panelKey,    setPanelKey]    = useState(0);
  const [requesting,  setRequesting]  = useState(null);        // employee id while a request is in flight

  /* reminder modal */
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

  /* HR decision modal (a SUBMITTED review) */
  const [decReview,   setDecReview]   = useState(null);
  const [decForm,     setDecForm]     = useState(EMPTY_DECISION);
  const [decPreview,  setDecPreview]  = useState(null);       // new end date for an extension
  const [decSaving,   setDecSaving]   = useState(false);
  /* company probation policy (Probation settings) */
  const [policy,        setPolicy]        = useState(null);
  const [policyEdit,    setPolicyEdit]    = useState(null);   // { months, days } while editing
  const [policySaving,  setPolicySaving]  = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true);
    try {
      const [empRes, histRes, activeRes, policyRes, reviewRes] = await Promise.allSettled([
        api.get('/employees', { params: { status: 'Probation' } }),
        api.get('/probation'),
        api.get('/employees', { params: { status: 'Active' } }),
        api.get('/probation/settings'),
        api.get('/probation-reviews'),
      ]);
      // A failed call used to read as "no one on probation" (HR audit
      // 2026-11-16, B5). Name each part that did not load; the banner says so.
      const failed = [
        [empRes, 'employees on probation'], [histRes, 'reminder log'], [activeRes, 'active employees'],
        [policyRes, 'probation settings'], [reviewRes, 'reviews'],
      ].filter(([r]) => r.status === 'rejected').map(([, label]) => label);
      setLoadFailed(failed);
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
      setHistory(Array.isArray(hist) ? hist : []);
      const rv = reviewRes.status === 'fulfilled' ? reviewRes.value.data : null;
      setReviews(Array.isArray(rv?.reviews) ? rv.reviews : []);
      setAwaiting(Array.isArray(rv?.awaiting_request) ? rv.awaiting_request : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const reloadAll = () => { load(true); setPanelKey(k => k + 1); };

  /* ── confirmation / extension letter (PDF) ── */
  const [letterBusy, setLetterBusy] = useState(null);
  const downloadLetter = async (r) => {
    setLetterBusy(r.id);
    try {
      const res = await api.get(`/probation-reviews/${r.id}/letter`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${r.decision === 'confirmed' ? 'Confirmation' : 'Probation_Extension'}_Letter_${r.office_id || r.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDialog({ type: 'error', title: 'Letter Not Ready', message: 'Could not prepare the letter. Please try again.' });
    } finally {
      setLetterBusy(null);
    }
  };

  /* ── opened from the Approval Center: ?review=<id> opens its decision ── */
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || !reviews.length) return;
    let wanted = null;
    try { wanted = new URLSearchParams(window.location.search).get('review'); } catch { /* no URL */ }
    if (!wanted) { deepLinkDone.current = true; return; }
    deepLinkDone.current = true;
    const r = reviews.find(x => String(x.id) === String(wanted));
    if (r?.status === 'submitted' && canEdit) openDecision(r);
    else if (r) setView(r.status === 'requested' ? 'reviews' : 'history');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviews, canEdit]);

  /* ── reviews, by employee ── */
  const openReviewByEmp = {};
  reviews.forEach(r => { if (r.status === 'requested' || r.status === 'submitted') openReviewByEmp[r.employee_id] = r; });
  const awaitingByEmp = {};
  awaiting.forEach(a => { awaitingByEmp[a.employee_id] = a; });
  const decided = reviews.filter(r => r.status === 'decided');
  // History = decided and cancelled, newest first (the server orders them so).
  const closed = reviews.filter(r => r.status === 'decided' || r.status === 'cancelled');
  const submittedCount = reviews.filter(r => r.status === 'submitted').length;
  const openCount = reviews.filter(r => r.status === 'requested' || r.status === 'submitted').length;
  const extensionsByEmp = {};
  decided.forEach(r => {
    if (r.decision === 'extended') (extensionsByEmp[r.employee_id] ||= []).push(r);
  });
  // Employees who cannot get a review because their department has no usable head.
  const blocked = awaiting.filter(a => a.blocked);

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

  /* ── last reminder per employee ── */
  const lastNotif = {};
  history.forEach(h => {
    if (!lastNotif[h.employee_id] || new Date(h.created_at) > new Date(lastNotif[h.employee_id].created_at)) {
      lastNotif[h.employee_id] = h;
    }
  });

  // Reminders come only from the daily job (backend jobs/probation.cron.js),
  // which keeps a durable once-per-end-date ledger. Opening this page sends nothing.

  /* ── autocomplete ── */
  // Focusing the field opens the list, typing narrows it.
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

  // A field that still holds a prefilled or picked name opens the whole list.
  const openNotifyList = () =>
    setSuggestions(matchEmployees(notifyTyped.current ? notifyTo : ''));

  /* ── send reminder ── */
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
      const message = data?.recipient_has_login === false
        ? `Recorded. ${notifyTo} has no Pulse login, so no in-app notification could be delivered to them.`
        : `${notifyTo} has been reminded about ${modalEmp.first_name}'s probation.`;
      setDialog({ type: data?.recipient_has_login === false ? 'warning' : 'success', title:'Reminder Sent', message, autoClose: 3500 });
      setModalEmp(null);
      setNotifyTo(''); setNotifyToId(null); setNotifyRemarks(''); notifyTyped.current = false; setSuggestions([]);
      load(true);
    } catch (err) {
      setDialog({ type:'error', title:'Failed to Send', message: err?.response?.data?.error || 'Could not send the reminder. Please try again.' });
    } finally {
      setSending(false);
    }
  };

  /* ── request a department-head review ── */
  const requestReview = async (emp) => {
    setRequesting(emp.id);
    try {
      const { data } = await api.post('/probation-reviews', { employee_id: emp.id });
      const reviewer = data?.review?.reviewer || 'the department head';
      setDialog(data?.created === false
        ? { type: 'info', title: 'Already Requested', message: `${emp.first_name}'s review is already with ${reviewer}.`, autoClose: 3000 }
        : { type: 'success', title: 'Review Requested', message: `${reviewer} has been asked to review ${emp.first_name} ${emp.last_name || ''}`.trim() + '.', autoClose: 3000 });
      reloadAll();
    } catch (err) {
      setDialog({ type: 'error', title: 'Review Not Requested', message: err?.response?.data?.error || 'Could not request the review.' });
    } finally {
      setRequesting(null);
    }
  };

  /* ── HR decision on a submitted review ── */
  const openDecision = (review) => {
    setDecReview(review);
    setDecPreview(null);
    setDecForm({ ...EMPTY_DECISION, decision: RECOMMENDATION_TO_DECISION[review.recommendation] || '' });
  };
  const closeDecision = () => { setDecReview(null); setDecForm(EMPTY_DECISION); setDecPreview(null); };

  // Extension preview: the server's own calendar rule (the day after the
  // current end date + N months), via the existing calculator.
  const decEmp = decReview ? employees.find(e => e.id === decReview.employee_id) : null;
  const decCurrentEnd = decEmp?.probation_end_date?.slice?.(0, 10) || decReview?.original_end_date || null;
  useEffect(() => {
    if (!decReview || decForm.decision !== 'extended' || !decCurrentEnd) { setDecPreview(null); return undefined; }
    const months = Number(decForm.extension_months);
    if (!Number.isInteger(months) || months < 1 || months > 24) { setDecPreview(null); return undefined; }
    let stale = false;
    api.get('/probation/calculate', { params: { joining_date: addDaysIso(decCurrentEnd, 1), months } })
      .then(({ data }) => { if (!stale) setDecPreview(data?.probation_end_date || null); })
      .catch(() => { if (!stale) setDecPreview(null); });
    return () => { stale = true; };
  }, [decReview, decForm.decision, decForm.extension_months, decCurrentEnd]);

  const saveDecision = async () => {
    const f = decForm;
    if (!f.decision) { setDialog({ type: 'warning', title: 'Required', message: 'Choose a decision.' }); return; }
    if (f.decision !== 'confirmed' && !f.notes.trim()) {
      setDialog({ type: 'warning', title: 'Required', message: 'Give a reason for this decision.' }); return;
    }
    if (f.decision === 'not_confirmed' && !f.last_working_date) {
      setDialog({ type: 'warning', title: 'Required', message: 'Enter the last working date.' }); return;
    }
    const body = { decision: f.decision, notes: f.notes.trim() };
    if (f.decision === 'confirmed' && f.effective_date) body.effective_date = f.effective_date;
    if (f.decision === 'extended') body.extension_months = Number(f.extension_months);
    if (f.decision === 'not_confirmed') {
      body.last_working_date = f.last_working_date;
      if (f.notice_days !== '') body.notice_days = Number(f.notice_days);
    }
    setDecSaving(true);
    try {
      const { data } = await api.post(`/probation-reviews/${decReview.id}/decide`, body);
      const who = decReview.employee;
      const message = f.decision === 'confirmed'
        ? `${who} is confirmed and now Active. The confirmation letter is under History.`
        : f.decision === 'extended'
          ? `${who}'s probation now ends on ${fmtDate(data?.new_end_date)}. The extension letter is under History.`
          : `An exit request was opened for ${who} (last working day ${fmtDate(f.last_working_date)}). Continue in Exit Management.`;
      setDialog({ type: 'success', title: 'Decision Recorded', message, autoClose: 4000 });
      closeDecision();
      reloadAll();
    } catch (err) {
      setDialog({ type: 'error', title: 'Decision Not Saved', message: err?.response?.data?.error || 'Could not save the decision.' });
    } finally {
      setDecSaving(false);
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

  const goDepartmentHeads = () => {
    if (setPage) setPage('DepartmentHeads');
    else window.location.assign('/DepartmentHeads');
  };

  /* ── render ── */
  return (
    <PageShell dock={
      <PageHero
        icon={Users}
        eyebrow="Human Resources"
        title="Probation Management"
        subtitle="Track probation periods, get each head's review, and record the outcome"
        actions={<>
          <button
            className="plh-cta plh-cta--ghost"
            onClick={() => reloadAll()}
            disabled={refreshing}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <button className="plh-cta" onClick={() => setShowHistory(v => !v)}>
            <History size={14} />
            Reminder Log
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </>}
      />
    }>
      {loadFailed.length > 0 && (
        <LoadError
          compact
          title="Part of this page did not load"
          message={`Could not load: ${loadFailed.join(', ')}. The lists below may be incomplete.`}
          onRetry={() => load()}
        />
      )}
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
          <div className="prob-kpi-icon" style={{ background: '#fef3c7' }}>
            <ClipboardCheck size={20} color="#b45309" />
          </div>
          <div className="prob-kpi-body">
            <div className="prob-kpi-val" style={{ color: '#b45309' }}>{submittedCount}</div>
            <div className="prob-kpi-label">Awaiting HR Decision</div>
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
              {canEdit && (
                <button className="prob-hist-action-btn"
                  onClick={() => setPolicyEdit({ months: policy.probation_months, days: policy.reminder_days })}>
                  Edit policy
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Who cannot be reviewed, and why — the fix is on Department Heads. */}
      {blocked.length > 0 && (
        <div className="prob-banner" role="status">
          <AlertTriangle size={14} />
          <div>
            <strong>{blocked.length} {blocked.length === 1 ? 'employee' : 'employees'} cannot be sent for review.</strong>
            <ul>
              {blocked.slice(0, 5).map(b => <li key={b.employee_id}>{b.employee}: {b.blocked}</li>)}
              {blocked.length > 5 && <li>…and {blocked.length - 5} more</li>}
            </ul>
          </div>
          <button type="button" className="prob-hist-action-btn" onClick={goDepartmentHeads}>Open Department Heads</button>
        </div>
      )}

      {/* Reminder log — what was sent, to whom. No decisions here any more. */}
      {showHistory && (
        <div className="prob-history">
          <div className="prob-history-head">
            <h3>Reminder Log</h3>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>{history.length} records</span>
          </div>
          {history.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No reminders sent yet
            </div>
          ) : (
            <>
              <div className="prob-hist-row prob-hist-row--log prob-hist-head-row">
                <span>Employee</span>
                <span>Sent To</span>
                <span>Type</span>
                <span>Date</span>
              </div>
              {history.slice(0, 20).map(h => (
                <div key={h.id} className="prob-hist-row prob-hist-row--log">
                  <div>
                    <div className="prob-hist-name">{h.first_name} {h.last_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{h.office_id}</div>
                  </div>
                  <div className="prob-hist-to">{h.notified_to && h.notified_to !== 'null' ? h.notified_to : '—'}</div>
                  <div>
                    <span className={`prob-hist-type prob-hist-type-${h.notification_type || 'approval'}`}>
                      {(h.notification_type || 'approval').replace('_', ' ')}
                    </span>
                  </div>
                  <div className="prob-hist-date">{timeAgo(h.created_at)}</div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Views */}
      <div className="prob-views" role="tablist" aria-label="Probation views">
        {[
          { key: 'current', label: 'Employees', count: kpi.total },
          { key: 'reviews', label: 'Open Reviews', count: openCount },
          { key: 'history', label: 'History', count: closed.length },
        ].map(v => (
          <button key={v.key} type="button" role="tab" aria-selected={view === v.key}
            className={`prob-view${view === v.key ? ' active' : ''}`} onClick={() => setView(v.key)}>
            {v.label} <span className="prob-tab-count">{v.count}</span>
          </button>
        ))}
      </div>

      {view === 'reviews' && (
        <ProbationReviewsPanel reloadKey={panelKey} onDecide={canEdit ? openDecision : undefined}
          onChanged={() => load(true)} />
      )}

      {view === 'history' && (
        <section className="prob-dh" aria-label="Probation history">
          <div className="prob-dh-body" style={{ paddingTop: 12 }}>
            {closed.length === 0 ? (
              <div className="prob-dh-help">No probation decisions recorded yet.</div>
            ) : (
              <table className="prob-dh-table">
                <thead>
                  <tr><th>Employee</th><th>Cycle</th><th>Head&apos;s review</th><th>Decision</th><th>Outcome</th><th>Decided</th><th aria-label="Letter" /></tr>
                </thead>
                <tbody>
                  {closed.map(r => r.status === 'cancelled' ? (
                    <tr key={r.id} data-history={r.id}>
                      <td>{r.employee} <span className="prob-dh-muted">{r.office_id}</span></td>
                      <td>{r.cycle_no}</td>
                      <td>
                        {r.recommendation ? `${RECOMMENDATION_LABEL[r.recommendation] || r.recommendation} · ${r.rating}/5` : 'Not submitted'}
                        <div className="prob-dh-muted">{r.reviewer}</div>
                      </td>
                      <td><span className="prob-hist-decision prob-hist-decision-pending">Cancelled</span></td>
                      <td>Review withdrawn<div className="prob-dh-muted">{r.cancel_reason}</div></td>
                      <td>{fmtDate(r.cancelled_at)}<div className="prob-dh-muted">{r.cancelled_by || '—'}</div></td>
                      <td />
                    </tr>
                  ) : (
                    <tr key={r.id} data-history={r.id}>
                      <td>{r.employee} <span className="prob-dh-muted">{r.office_id}</span></td>
                      <td>{r.cycle_no}</td>
                      <td>
                        {RECOMMENDATION_LABEL[r.recommendation] || '—'} · {r.rating}/5
                        <div className="prob-dh-muted">{r.reviewer}</div>
                      </td>
                      <td><span className={`prob-hist-decision prob-hist-decision-${r.decision}`}>{DECISION_LABEL[r.decision] || r.decision}</span></td>
                      <td>
                        {r.decision === 'extended' ? `New end date ${fmtDate(r.new_end_date)} (+${r.extension_months} mo)`
                          : r.decision === 'not_confirmed' ? 'Exit request opened'
                          : 'Status Active'}
                        {r.decision_notes && <div className="prob-dh-muted">{r.decision_notes}</div>}
                      </td>
                      <td>{fmtDate(r.decided_at)}<div className="prob-dh-muted">{r.decided_by || '—'}</div></td>
                      <td className="prob-dh-actions">
                        {(r.decision === 'confirmed' || r.decision === 'extended') && (
                          <button type="button" className="prob-hist-action-btn" disabled={letterBusy === r.id}
                            onClick={() => downloadLetter(r)}>
                            <Download size={12} /> {letterBusy === r.id ? 'Preparing…'
                              : r.decision === 'confirmed' ? 'Confirmation letter' : 'Extension letter'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {view === 'current' && <>
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
            const open = openReviewByEmp[emp.id];
            const wait = awaitingByEmp[emp.id];
            const extensions = extensionsByEmp[emp.id] || [];
            const btnClass =
              prob?.status === 'overdue' || prob?.status === 'critical'
                ? 'prob-notify-btn-danger'
                : prob?.status === 'warning'
                ? 'prob-notify-btn-warn'
                : 'prob-notify-btn-primary';
            const requestBlockedReason = !emp.probation_end_date
              ? 'Set a probation end date on the employee first.'
              : wait?.blocked || null;

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
                    <div className="prob-info-key">Reviewer</div>
                    <div className="prob-info-val">
                      {open ? open.reviewer : wait?.reviewer?.name || '—'}
                    </div>
                  </div>
                </div>

                {/* Review state */}
                <div className="prob-card-review">
                  {open?.status === 'submitted' ? (
                    <>
                      <span className="prob-review-chip is-submitted">
                        Head recommends: {RECOMMENDATION_LABEL[open.recommendation] || open.recommendation} · {open.rating}/5
                      </span>
                      {canEdit && (
                        <button type="button" className="prob-modal-send prob-card-cta" onClick={() => openDecision(open)}>
                          Record decision
                        </button>
                      )}
                    </>
                  ) : open?.status === 'requested' ? (
                    <span className={`prob-review-chip${open.is_overdue ? ' is-overdue' : ''}`}>
                      Review with {open.reviewer} · due {fmtDate(open.reviewer_due_date)}{open.is_overdue ? ' (overdue)' : ''}
                    </span>
                  ) : (
                    <>
                      <span className="prob-review-chip is-none">No review requested</span>
                      {canAdd && (
                        <button type="button" className="prob-modal-send prob-card-cta"
                          disabled={!!requestBlockedReason || requesting === emp.id}
                          title={requestBlockedReason || (wait?.reviewer ? `Ask ${wait.reviewer.name} to review` : undefined)}
                          onClick={() => requestReview(emp)}>
                          {requesting === emp.id ? 'Requesting…' : 'Request review'}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {requestBlockedReason && !open && (
                  <div className="prob-card-blocked">{requestBlockedReason}</div>
                )}

                {/* Footer */}
                <div className="prob-card-footer">
                  <div className="prob-last-notif">
                    {last
                      ? <>Last reminder <span>{timeAgo(last.created_at)}</span></>
                      : <span style={{ color: '#9ca3af' }}>No reminder sent</span>
                    }
                  </div>
                  {canAdd && (
                    <button
                      className={`prob-notify-btn ${btnClass}`}
                      disabled={coolingDown}
                      title={coolingDown
                        ? `Reminded ${timeAgo(last.created_at)} — you can remind again after ${new Date(new Date(last.created_at).getTime() + NOTIFY_COOLDOWN_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                        : 'Send a reminder to a colleague'}
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
                      Remind
                    </button>
                  )}
                </div>
                {extensions.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', borderTop: '1px dashed #e5e7eb', paddingTop: 8 }}>
                    Extended {extensions.length} {extensions.length === 1 ? 'time' : 'times'}: {extensions
                      .slice().sort((a, b) => new Date(a.decided_at) - new Date(b.decided_at))
                      .map(x => `+${x.extension_months} mo to ${fmtDate(x.new_end_date)}`)
                      .join('  •  ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>}

      {/* ── Reminder modal ── */}
      {modalEmp && (() => {
        const prob = calcProbation(modalEmp, attentionDays);
        const cfg  = prob ? STATUS_CFG[prob.status] : STATUS_CFG.safe;
        const [avatarBg] = avatarColor(`${modalEmp.first_name}${modalEmp.last_name}`);
        return (
          <div className="prob-modal-backdrop" onClick={() => setModalEmp(null)}>
            <div className="prob-modal" onClick={e => e.stopPropagation()}>
              <div className="prob-modal-head">
                <div>
                  <h2>Send Probation Reminder</h2>
                  <p>Remind a manager or HR colleague about this employee&apos;s probation. To get the formal review, use Request review.</p>
                </div>
                <button className="prob-modal-close" onClick={() => setModalEmp(null)}>
                  <X size={14} />
                </button>
              </div>

              <div className="prob-modal-body">
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

                <div className="prob-field">
                  <label>Send To *</label>
                  <div className="prob-field-autocomplete">
                    <input
                      placeholder="Select an employee — or type a name or ID"
                      value={notifyTo}
                      onChange={e => handleNotifyInput(e.target.value)}
                      onFocus={openNotifyList}
                      onBlur={() => setTimeout(() => setSuggestions([]), 160)}
                    />
                    {suggestions.length > 0 && (
                      // preventDefault keeps focus in the input, so a slow
                      // click or a scrollbar drag still picks someone.
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

                <div className="prob-field">
                  <label>Reminder Type</label>
                  <select value={notifyType} onChange={e => setNotifyType(e.target.value)}>
                    <option value="approval">General — Probation Review</option>
                    <option value="probation_warning">Warning — Probation Due Soon</option>
                    <option value="probation_due">Final — Probation End Date Reached</option>
                  </select>
                </div>

                <div className="prob-field">
                  <label>Remarks (optional)</label>
                  <textarea
                    placeholder="Add context for the recipient…"
                    value={notifyRemarks}
                    onChange={e => setNotifyRemarks(e.target.value)}
                  />
                </div>
              </div>

              <div className="prob-modal-footer">
                <button className="prob-modal-cancel" onClick={() => setModalEmp(null)}>Cancel</button>
                <button className="prob-modal-send" onClick={handleSend} disabled={sending}>
                  <Send size={13} />
                  {sending ? 'Sending…' : 'Send Reminder'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── HR decision modal ── */}
      {decReview && (
        <div className="prob-modal-backdrop" onClick={closeDecision}>
          <div className="prob-dec-modal" role="dialog" aria-label="Record probation decision" onClick={e => e.stopPropagation()}>
            <div className="prob-dec-head">
              <div>
                <h2>Record Probation Decision</h2>
                <p style={{ fontSize: 12, opacity: .8, margin: '3px 0 0' }}>
                  {decReview.employee} · {decReview.office_id} · probation ends {fmtDate(decCurrentEnd)}
                </p>
              </div>
              <button className="prob-modal-close" onClick={closeDecision} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <div className="prob-dec-body">
              <div className="prob-dec-summary">
                <div className="prob-dec-summary-head">
                  {decReview.reviewer}&apos;s review
                  <span className="prob-dh-muted"> · submitted {fmtDate(decReview.submitted_at)}</span>
                </div>
                <div className="prob-rating-row" aria-label={`Rating ${decReview.rating} of 5`}>
                  {[1,2,3,4,5].map(n => (
                    <Star key={n} size={15} fill={decReview.rating >= n ? '#7c5cf0' : 'none'} color={decReview.rating >= n ? '#7c5cf0' : '#d1d5db'} />
                  ))}
                  <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 6 }}>{decReview.rating}/5</span>
                </div>
                <div><strong>Recommends:</strong> {RECOMMENDATION_LABEL[decReview.recommendation] || decReview.recommendation}</div>
                {decReview.comments && <p className="prob-dec-comments">{decReview.comments}</p>}
              </div>

              <LearningSnapshot url={`/probation-reviews/${decReview.id}/learning`} />

              <div className="prob-field">
                <label htmlFor="prob-dec-decision">Decision *</label>
                <select id="prob-dec-decision" value={decForm.decision}
                  onChange={e => setDecForm(f => ({ ...f, decision: e.target.value }))}>
                  <option value="">— Select outcome —</option>
                  <option value="confirmed">Confirm — employee becomes Active</option>
                  <option value="extended">Extend — probation continues to a new end date</option>
                  <option value="not_confirmed">Do not confirm — open an exit</option>
                </select>
              </div>

              {decForm.decision === 'confirmed' && (
                <div className="prob-field">
                  <label htmlFor="prob-dec-effective">Confirmation date</label>
                  <input id="prob-dec-effective" type="date" max={todayIso()} value={decForm.effective_date}
                    onChange={e => setDecForm(f => ({ ...f, effective_date: e.target.value }))} />
                  <span className="prob-dh-muted">Leave empty for today.</span>
                </div>
              )}

              {decForm.decision === 'extended' && (
                <div className="prob-field">
                  <label htmlFor="prob-dec-months">Extend by (months) *</label>
                  <input id="prob-dec-months" type="number" min={1} max={24} value={decForm.extension_months}
                    onChange={e => setDecForm(f => ({ ...f, extension_months: e.target.value }))} />
                  <span className="prob-dh-muted">
                    {decPreview ? `New end date: ${fmtDate(decPreview)}` : 'The new end date is counted from the day after the current end date.'}
                  </span>
                </div>
              )}

              {decForm.decision === 'not_confirmed' && (
                <>
                  <div className="prob-field">
                    <label htmlFor="prob-dec-lwd">Last working date *</label>
                    <input id="prob-dec-lwd" type="date" min={todayIso()} value={decForm.last_working_date}
                      onChange={e => setDecForm(f => ({ ...f, last_working_date: e.target.value }))} />
                  </div>
                  <div className="prob-field">
                    <label htmlFor="prob-dec-notice">Notice period (days)</label>
                    <input id="prob-dec-notice" type="number" min={0} max={365} value={decForm.notice_days}
                      onChange={e => setDecForm(f => ({ ...f, notice_days: e.target.value }))} />
                    <span className="prob-dh-muted">The employee moves to Notice now; the exit continues in Exit Management.</span>
                  </div>
                </>
              )}

              <div className="prob-field">
                <label htmlFor="prob-dec-notes">{decForm.decision && decForm.decision !== 'confirmed' ? 'Reason *' : 'Notes'}</label>
                <textarea id="prob-dec-notes" maxLength={4000}
                  placeholder="Why this decision — kept with the employee's probation history"
                  value={decForm.notes}
                  onChange={e => setDecForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div className="prob-modal-footer">
              <button className="prob-modal-cancel" onClick={closeDecision}>Cancel</button>
              <button className="prob-modal-send" onClick={saveDecision} disabled={decSaving}>
                {decSaving ? 'Saving…' : 'Save Decision'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Last, so it paints over the modals (same z-index). */}
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />
    </PageShell>
  );
}
