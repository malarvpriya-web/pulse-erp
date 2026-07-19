import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, Search, Bell, Clock, AlertTriangle, CheckCircle,
  Users, ChevronDown, ChevronUp, Send, X, Star, History,
} from "lucide-react";
import api from "@/services/api/client";
import ResultDialog from "@/components/ResultDialog";
import "./Probation.css";

/* ── helpers ── */
const DEFAULT_PROBATION_DAYS = 180;
const PROBATION_DAYS_BY_DESIGNATION = {
  intern: 90,
  trainee: 120,
  apprentice: 120,
};
function probationDaysForEmp(emp = {}) {
  const byContract = Number(emp.probation_days || emp.contract_probation_days || 0);
  if (byContract > 0) return byContract;
  const d = String(emp.designation || "").trim().toLowerCase();
  if (d && PROBATION_DAYS_BY_DESIGNATION[d]) return PROBATION_DAYS_BY_DESIGNATION[d];
  return DEFAULT_PROBATION_DAYS;
}

const AVATAR_PALETTE = [
  ['#6d28d9','#ede9fe'],['#0369a1','#e0f2fe'],['#047857','#d1fae5'],
  ['#b45309','#fef3c7'],['#be123c','#ffe4e6'],['#0f766e','#ccfbf1'],
  ['#7c2d12','#ffedd5'],['#1e40af','#dbeafe'],
];
function avatarColor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
function initials(f = '', l = '') {
  return ((f[0] || '') + (l[0] || '')).toUpperCase();
}

function calcProbation(joining_date, totalDays = DEFAULT_PROBATION_DAYS) {
  if (!joining_date) return null;
  const start   = new Date(joining_date);
  const end     = new Date(joining_date);
  end.setDate(end.getDate() + totalDays);
  const today   = new Date();
  today.setHours(0, 0, 0, 0);
  const elapsed = Math.floor((today - start) / 86400000);
  const remaining = totalDays - elapsed;
  const pct = Math.min(100, Math.max(0, (elapsed / totalDays) * 100));
  let status = "safe";
  if      (remaining < 0)   status = "overdue";
  else if (remaining <= 15) status = "critical";
  else if (remaining <= 30) status = "warning";
  return { start, end, elapsed, remaining, pct, status, totalDays };
}

const STATUS_CFG = {
  safe     : { label: 'On Track',   color: '#15803d', bg: '#dcfce7', barColor: '#22c55e' },
  warning  : { label: 'Due Soon',   color: '#b45309', bg: '#fef3c7', barColor: '#f59e0b' },
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
  const [notifyType,    setNotifyType]    = useState('approval');
  const [notifyRemarks, setNotifyRemarks] = useState('');
  const [suggestions,   setSuggestions]   = useState([]);
  const [sending,       setSending]       = useState(false);

  /* decision modal */
  const [decRecord,   setDecRecord]   = useState(null);
  const [decision,    setDecision]    = useState('');
  const [rating,      setRating]      = useState(0);
  const [comments,    setComments]    = useState('');
  const [decidingSending, setDecidingSending] = useState(false);
  const [autoAlerting, setAutoAlerting] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true);
    try {
      const [empRes, histRes, activeRes] = await Promise.allSettled([
        api.get('/employees', { params: { status: 'Probation' } }),
        api.get('/probation'),
        api.get('/employees', { params: { status: 'Active' } }),
      ]);
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
  const enriched = employees.map(e => ({ ...e, prob: calcProbation(e.joining_date, probationDaysForEmp(e)) }));
  const kpi = {
    total    : enriched.length,
    critical : enriched.filter(e => e.prob?.status === 'critical').length,
    warning  : enriched.filter(e => e.prob?.status === 'warning').length,
    overdue  : enriched.filter(e => e.prob?.status === 'overdue').length,
    safe     : enriched.filter(e => e.prob?.status === 'safe').length,
  };

  /* ── filter ── */
  const filtered = enriched.filter(e => {
    const matchTab = activeTab === 'all' || e.prob?.status === activeTab;
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

  useEffect(() => {
    if (autoAlerting || !enriched.length) return;
    const critical = enriched.filter(e => e.prob?.status === 'critical' || e.prob?.status === 'overdue');
    if (!critical.length) return;
    const run = async () => {
      setAutoAlerting(true);
      try {
        for (const emp of critical) {
          const key = `probation_auto_alert_${emp.id}_${fmtDate(emp.prob?.end)}`;
          if (localStorage.getItem(key) === '1') continue;
          try {
            await api.post('/probation', {
              employee_id: emp.id,
              notified_to: emp.reporting_manager || 'HR',
              notified_role: 'Manager',
              notification_type: 'probation_due',
              module_name: 'Probation',
              remarks: `Auto-alert: ${emp.first_name} ${emp.last_name} is in ${emp.prob.status} phase.`,
            });
            localStorage.setItem(key, '1');
          } catch {
            // best-effort trigger; do not block UI
          }
        }
      } finally {
        setAutoAlerting(false);
      }
    };
    run();
  }, [enriched, autoAlerting]);

  /* ── autocomplete ── */
  const handleNotifyInput = v => {
    setNotifyTo(v);
    if (v.length > 0) {
      const pool = [...activeEmps, ...allEmps.filter(e => !activeEmps.some(a => a.id === e.id))];
      setSuggestions(
        pool.filter(e =>
          `${e.first_name} ${e.last_name}`.toLowerCase().includes(v.toLowerCase()) ||
          e.office_id?.toLowerCase().includes(v.toLowerCase())
        ).slice(0, 6)
      );
    } else {
      setSuggestions([]);
    }
  };

  /* ── send notification ── */
  const handleSend = async () => {
    if (!notifyTo.trim()) {
      setDialog({ type:'warning', title:'Required', message:'Please select who to notify.' });
      return;
    }
    setSending(true);
    try {
      await api.post('/probation', {
        employee_id    : modalEmp.id,
        notified_to    : notifyTo,
        notified_role  : 'Manager',
        notification_type: notifyType,
        module_name    : 'Probation',
        remarks        : notifyRemarks,
      });
      setDialog({ type:'success', title:'Notification Sent', message:`${notifyTo} has been notified about ${modalEmp.first_name}'s probation.`, autoClose: 2500 });
      setModalEmp(null);
      setNotifyTo(''); setNotifyRemarks(''); setSuggestions([]);
      load(true);
    } catch {
      setDialog({ type:'error', title:'Failed to Send', message:'Could not send notification. Please try again.' });
    } finally {
      setSending(false);
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
    <div className="prob-page">
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />

      {/* Header */}
      <div className="prob-header">
        <div className="prob-header-left">
          <h1>Probation Management</h1>
          <p>Track, notify, and close probation periods for all employees</p>
        </div>
        <div className="prob-header-right">
          <button
            className={`prob-refresh-btn${refreshing ? ' spinning' : ''}`}
            onClick={() => load(true)}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button className="prob-hist-toggle" onClick={() => setShowHistory(v => !v)}>
            <History size={14} />
            Notification Log
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

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
          <div className="prob-kpi-icon" style={{ background: '#fef3c7' }}>
            <Clock size={20} color="#d97706" />
          </div>
          <div className="prob-kpi-body">
            <div className="prob-kpi-val" style={{ color: '#d97706' }}>{kpi.warning}</div>
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
                  {prob && (
                    <span
                      className={`prob-status-pill prob-status-${prob.status}`}
                    >
                      {cfg.label}
                    </span>
                  )}
                </div>

                {/* Timeline bar */}
                {prob && (
                  <div className="prob-timeline">
                    <div className="prob-timeline-header">
                      <span className="prob-timeline-label">
                        {prob.elapsed} / {prob.totalDays} days elapsed
                      </span>
                      <span
                        className="prob-days-chip"
                        style={{ background: cfg.bg, color: cfg.color }}
                      >
                        {prob.remaining > 0
                          ? `${prob.remaining}d left`
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
                    <div className="prob-info-val" style={{ color: cfg.color }}>
                      {prob ? fmtDate(prob.end) : '—'}
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
                    <span style={{ fontSize: 11, color: '#b45309', marginRight: 8 }}>Reminder sent today</span>
                  )}
                  <button
                    className={`prob-notify-btn ${btnClass}`}
                    disabled={last && (Date.now() - new Date(last.created_at).getTime()) < (1000 * 60 * 60)}
                    onClick={() => {
                      setModalEmp(emp);
                      setNotifyTo(emp.reporting_manager || '');
                      setNotifyType(
                        prob?.status === 'overdue' || prob?.status === 'critical'
                          ? 'probation_due'
                          : prob?.status === 'warning'
                          ? 'probation_warning'
                          : 'approval'
                      );
                      setNotifyRemarks('');
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
        const prob = calcProbation(modalEmp.joining_date);
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
                          {prob.elapsed} days elapsed · probation ends {fmtDate(prob.end)}
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
                      placeholder="Search employee name or ID…"
                      value={notifyTo}
                      onChange={e => handleNotifyInput(e.target.value)}
                    />
                    {suggestions.length > 0 && (
                      <div className="prob-suggestions">
                        {suggestions.map(s => {
                          const [sb] = avatarColor(`${s.first_name}${s.last_name}`);
                          return (
                            <div
                              key={s.id}
                              className="prob-suggestion-item"
                              onClick={() => { setNotifyTo(`${s.first_name} ${s.last_name}`); setSuggestions([]); }}
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
                      <Star size={16} fill={rating >= n ? '#f59e0b' : 'none'} color={rating >= n ? '#f59e0b' : '#d1d5db'} />
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
    </div>
  );
}


