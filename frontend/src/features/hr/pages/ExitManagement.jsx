// frontend/src/features/hr/pages/ExitManagement.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Users } from 'lucide-react';
import api from '@/services/api/client';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';
import { PageHero, PageShell } from '@/components/pulse-ui';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import VocabSelect from '@/components/core/VocabSelect';
import { initiateHandOff } from '../exitHandOff';
import SettlementRulesPanel from './SettlementRulesPanel';
import { SEPARATION_OPTIONS, separationLabel } from '../separationTypes';
import { hasLeft, downloadExitLetter } from '../exitLetters';


const BLANK_INITIATE = { employee_id: '', separation_type: 'resignation', resignation_date: '', notice_period: '', last_working_date: '', reason: '' };
const inputStyle = { width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', background: '#fff' };
const labelStyle = { fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 };
const empLabel = (e) => `${[e.first_name, e.last_name].filter(Boolean).join(' ') || e.name || `#${e.id}`} (${e.office_id || e.id})`;

/** YYYY-MM-DD + n days, on the calendar (no time zone involved). */
function addDaysIso(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m || !Number.isFinite(Number(n))) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + Number(n)));
  return d.toISOString().slice(0, 10);
}
const daysBetweenIso = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const fmtDay = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '');

/**
 * The last day of full notice. The F&F engine counts BOTH the resignation day
 * and the last working day as served (settlementEngine.js daysBetween), so N
 * days of notice end on resignation date + N − 1. Keep the two in step, or the
 * screen promises "full notice" and F&F recovers a day.
 */
const fullNoticeEnd = (resignationDate, noticeDays) => addDaysIso(resignationDate, Math.max(0, Number(noticeDays) - 1));

/** An early release (last working day before full notice) is recovered by F&F unless waived there. */
function noticeNote(form, noticeDays) {
  if (!form.resignation_date || noticeDays == null) return null;
  const fullEnd = fullNoticeEnd(form.resignation_date, noticeDays);
  if (!form.last_working_date) return `Full notice of ${noticeDays} days ends ${fmtDay(fullEnd)}.`;
  const early = daysBetweenIso(form.last_working_date, fullEnd);
  if (early > 0) return `Released ${early} day${early === 1 ? '' : 's'} early (full notice ends ${fmtDay(fullEnd)}). F&F recovers the shortfall for a resignation unless you waive it in the F&F calculator.`;
  if (early < 0) return `Last working day is ${-early} day${early === -1 ? '' : 's'} after the ${noticeDays}-day notice ends (${fmtDay(fullEnd)}).`;
  return `Full ${noticeDays}-day notice served.`;
}

/**
 * The editable exit fields → request body; a blank optional field is null.
 * On Initiate a null notice period means "the employee's contractual notice".
 */
const exitPayload = (form) => ({
  separation_type: form.separation_type,
  last_working_date: form.last_working_date,
  resignation_date: form.resignation_date || null,
  notice_period: form.notice_period === '' || form.notice_period == null ? null : Number(form.notice_period),
  reason: String(form.reason ?? '').trim() || null,
});

// Exit reasons are the EXIT_REASON master (Settings → Master Data), stored by
// name since migration 20261117000001. This maps keys stored before that.
const REASON_LABELS = { better_opportunity: 'Better Opportunity', compensation: 'Compensation', work_environment: 'Work Environment', personal: 'Personal', relocation: 'Relocation', other: 'Other' };
const reasonLabel = (v) => REASON_LABELS[v] || v;
// No pre-filled scores: an untouched form used to save 4/4/4/3/4.
const BLANK_INTERVIEW = { reason_category: '', reason_detail: '', would_rejoin: '', rating_management: '', rating_culture: '', rating_work: '', rating_growth: '', overall_rating: '', interviewer_id: null };
const RATING_KEYS = ['rating_management', 'rating_culture', 'rating_work', 'rating_growth', 'overall_rating'];
const SEP_COLORS = { resignation: '#6B3FDB', termination: '#dc2626', retirement: '#059669', death: '#374151' };
const REASON_COLORS = ['#6B3FDB', '#4f46e5', '#0891b2', '#059669', '#6d28d9', '#dc2626'];

const fmt = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const tabStyle = (active) => ({ padding: '8px 20px', border: 'none', background: active ? '#6B3FDB' : 'transparent', color: active ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: active ? 600 : 400, fontSize: 14 });
const cardStyle = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 16px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };

/** The calculator's inputs, from the options saved with a settlement version (or blank). */
const numText = (v) => (v == null || Number(v) === 0 ? '' : String(v));
function optionsFrom(o) {
  return {
    lop_days: numText(o?.lop_days), waive_notice_days: numText(o?.waive_notice_days), waive_reason: o?.waive_reason || '',
    forfeit_gratuity_reason: o?.forfeit_gratuity_reason || '', bonus_disqualified_reason: o?.bonus_disqualified_reason || '',
    asset_recovery_amount: numText(o?.asset_recovery_amount), asset_recovery_reason: o?.asset_recovery_reason || '',
    si_decision: '', si_amount: '', si_reason: '',
  };
}

/** GET /exit/fnf/review → the same shape POST /exit/fnf/compute returns, marked `saved`. */
function fromSaved(review) {
  const s = review.settlement;
  return {
    id: review.exit.id, settlement_id: s.id, version: s.version, saved: true,
    status: review.payment ? 'paid' : review.approval ? 'approved' : 'draft',
    net_payable: s.net_payable, computed_at: s.computed_at, computed_by_name: s.computed_by_name,
    computation_details: {
      lines: s.lines || [], warnings: s.warnings || [], rules_unconfirmed: s.rules_unconfirmed || [],
      summary: { total_payable: s.total_payable, total_recoverable: s.total_recoverable, net_payable: s.net_payable },
      sales_incentive: s.sales_incentive,
    },
  };
}

export default function ExitManagement({ embedded = false }) {
  const [tab, setTab] = useState(0);
  const [activeExits, setActiveExits] = useState([]);
  const [interviews, setInterviews] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [fnfData, setFnfData] = useState(null);
  const [fnfOptions, setFnfOptions] = useState(() => optionsFrom(null));
  // The exit whose settlement is open in the F&F tab, and whether it is loading.
  const [fnfExit, setFnfExit] = useState(null);
  const [fnfLoading, setFnfLoading] = useState(false);
  const selectedEmployee = fnfExit?.employee_id ?? null;
  const [clearanceStatus, setClearanceStatus] = useState({});
  const [showInitiate, setShowInitiate] = useState(() => (typeof window !== 'undefined' && !!initiateHandOff(window.location.search)));
  const [showInterview, setShowInterview] = useState(null);
  // Read once, on mount: a hand-off from All Employees opens Initiate pre-filled.
  const [handOff] = useState(() => (typeof window !== 'undefined' ? initiateHandOff(window.location.search) : null));
  const [initiateForm, setInitiateForm] = useState({ ...BLANK_INITIATE, ...(handOff?.form || {}) });
  const [initiateError, setInitiateError] = useState('');
  // Current staff for the Initiate picker (people already serving notice have an exit).
  const [employees, setEmployees] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(BLANK_INITIATE);
  const [editError, setEditError] = useState('');
  const [interviewForm, setInterviewForm] = useState(BLANK_INTERVIEW);
  const [interviewError, setInterviewError] = useState('');
  const [notice, setNotice] = useState(null);
  const [actioning, setActioning] = useState(false);
  const [fnfError, setFnfError] = useState(null);
  const [withdrawTarget, setWithdrawTarget] = useState(null);

  const showNotice = (msg, type = 'success') => {
    setNotice({ msg, type });
    setTimeout(() => setNotice(null), 3500);
  };

  const load = useCallback(async () => {
    const [r1, r2, r3] = await Promise.allSettled([
      api.get('/exit/active'),
      api.get('/exit/interviews'),
      api.get('/exit/interviews/analytics')
    ]);
    setActiveExits(r1.status === 'fulfilled' ? (r1.value.data || []) : []);
    setInterviews(r2.status === 'fulfilled' ? (r2.value.data || []) : []);
    setAnalytics(r3.status === 'fulfilled' ? r3.value.data : null);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!showInitiate || employees) return;
    api.get('/employees?status=active,probation')
      .then((r) => setEmployees(r.data?.employees || r.data?.data || (Array.isArray(r.data) ? r.data : [])))
      .catch(() => setEmployees([]));
  }, [showInitiate, employees]);

  // Company default notice (Workforce Analytics → Settings), for employees whose record has none.
  const [companyNoticeDays, setCompanyNoticeDays] = useState(null);
  useEffect(() => {
    api.get('/analytics/workforce-settings')
      .then((r) => { const d = r?.data?.settings?.default_notice_period_days; if (Number.isInteger(d)) setCompanyNoticeDays(d); })
      .catch(() => {});
  }, []);

  const pickedEmployee = (employees || []).find((e) => String(e.id) === String(initiateForm.employee_id));
  const contractNotice = pickedEmployee?.notice_period_days ?? companyNoticeDays;
  const initiateNoticeDays = initiateForm.notice_period !== '' ? Number(initiateForm.notice_period) : contractNotice;
  // The last working day follows resignation date + notice until HR types one.
  const [lwdTouched, setLwdTouched] = useState(() => !!handOff?.form?.last_working_date);
  const setInitiateField = (key, value) => setInitiateForm((p) => {
    const next = { ...p, [key]: value };
    if (key === 'last_working_date') return next;
    if (!lwdTouched && next.resignation_date) {
      const n = next.notice_period !== '' ? Number(next.notice_period)
        : ((employees || []).find((e) => String(e.id) === String(next.employee_id))?.notice_period_days ?? companyNoticeDays);
      if (n != null && Number.isFinite(n)) next.last_working_date = fullNoticeEnd(next.resignation_date, n);
    }
    return next;
  });

  const initiateExit = async () => {
    if (actioning) return;
    if (!initiateForm.employee_id) { setInitiateError('Choose the employee who is leaving.'); return; }
    if (!initiateForm.last_working_date) { setInitiateError('Enter the last working day.'); return; }
    if (initiateForm.resignation_date && initiateForm.resignation_date > initiateForm.last_working_date) {
      setInitiateError('The resignation / notice date cannot be after the last working day.'); return;
    }
    setInitiateError('');
    setActioning(true);
    try {
      const { data } = await api.post('/exit/initiate', { employee_id: initiateForm.employee_id, ...exitPayload(initiateForm) });
      showNotice(data?.notified
        ? `Exit started. ${data.notified} manager${data.notified === 1 ? '' : 's'} notified.`
        : 'Exit started. No manager or department head with a login was found to notify.');
      setShowInitiate(false);
      setInitiateForm(BLANK_INITIATE);
      setLwdTouched(false);
      setEmployees(null);
      load();
    } catch (err) {
      setInitiateError(err?.response?.data?.error || 'Failed to start the exit. Please try again.');
    } finally { setActioning(false); }
  };

  const openEdit = (e) => {
    setEditError('');
    setEditTarget(e);
    setEditForm({
      employee_id: e.employee_id,
      separation_type: e.separation_type || 'resignation',
      resignation_date: e.resignation_date || '',
      notice_period: e.notice_period ?? '',
      last_working_date: e.last_working_date || '',
      reason: e.reason || '',
    });
  };

  const saveEdit = async () => {
    if (!editTarget || actioning) return;
    if (!editForm.last_working_date) { setEditError('Enter the last working day.'); return; }
    if (editForm.resignation_date && editForm.resignation_date > editForm.last_working_date) {
      setEditError('The resignation / notice date cannot be after the last working day.'); return;
    }
    setActioning(true);
    try {
      const { data } = await api.put(`/exit/requests/${editTarget.id}`, exitPayload(editForm));
      showNotice(data?.fnf_recompute_needed
        ? 'Exit updated. Open F&F and recalculate: the last settlement used the old details.'
        : 'Exit updated.');
      setEditTarget(null);
      load();
    } catch (err) {
      setEditError(err?.response?.data?.error || 'The exit could not be saved.');
    } finally { setActioning(false); }
  };

  const fnfLocked = (e) => ['approved', 'paid'].includes(String(e?.fnf_status || '').toLowerCase());

  // Opening a settlement shows the LATEST SAVED version (GET /exit/fnf/review).
  // It used to recompute on every view, which made the viewer its "computer"
  // and so the one person who could never approve it (HR audit 2026-11-16 N1).
  const openFnf = async (exitRow) => {
    setTab(1);
    setFnfExit(exitRow);
    setFnfData(null);
    setFnfError(null);
    if (!exitRow) return;
    loadClearanceStatus(exitRow.employee_id);
    setFnfLoading(true);
    try {
      const { data } = await api.get(`/exit/fnf/review/${exitRow.id}`);
      if (data?.settlement) {
        setFnfData(fromSaved(data));
        setFnfOptions(optionsFrom(data.settlement.options));
      } else {
        setFnfOptions(optionsFrom(null));
      }
    } catch (err) {
      setFnfError(err?.response?.data?.error || 'The settlement could not be loaded.');
    } finally { setFnfLoading(false); }
  };

  // Calculate = a new version from the exit record and the inputs below.
  const calculate = async () => {
    if (!fnfExit || actioning) return;
    setFnfError(null);
    setActioning(true);
    try {
      const res = await api.post(`/exit/fnf/compute/${fnfExit.employee_id}`, {
        lop_days: fnfOptions.lop_days === '' ? undefined : Number(fnfOptions.lop_days),
        waive_notice_days: fnfOptions.waive_notice_days === '' ? undefined : Number(fnfOptions.waive_notice_days),
        waive_reason: fnfOptions.waive_reason || undefined,
        forfeit_gratuity_reason: fnfOptions.forfeit_gratuity_reason || undefined,
        bonus_disqualified_reason: fnfOptions.bonus_disqualified_reason || undefined,
        asset_recovery_amount: fnfOptions.asset_recovery_amount === '' ? undefined : Number(fnfOptions.asset_recovery_amount),
        asset_recovery_reason: fnfOptions.asset_recovery_reason || undefined,
        // Sales incentive: sent only when HR makes or changes a decision; otherwise the
        // server keeps the one already on the settlement.
        ...(fnfOptions.si_decision ? {
          sales_incentive_decision: fnfOptions.si_decision,
          sales_incentive_amount: fnfOptions.si_decision === 'pay' ? Number(fnfOptions.si_amount) : undefined,
          sales_incentive_reason: fnfOptions.si_reason || undefined,
        } : {}),
      });
      setFnfData(res.data);
      setFnfOptions((o) => ({ ...o, si_decision: '' }));
      showNotice(`Settlement version ${res.data?.version ?? ''} saved. Finance approves it in Settlement Review.`);
      load();
    } catch (err) {
      // No figures when the computation fails. This used to show a made-up
      // settlement (net ₹1,45,200) labelled "estimated" — a number with no
      // source must never sit on a settlement screen (containment C1).
      setFnfError(err?.response?.data?.error || 'The F&F settlement could not be computed.');
    } finally { setActioning(false); }
  };

  // Cancels the exit request, resets clearance, restores the employee's status
  // and re-enables a login the exit had revoked — all server-side, one transaction.
  const withdrawExit = async () => {
    const target = withdrawTarget;
    setWithdrawTarget(null);
    if (!target || actioning) return;
    setActioning(true);
    try {
      const { data } = await api.post(`/exit/requests/${target.id}/withdraw`, { reason: 'Resignation withdrawn' });
      showNotice(`${target.employee_name} retained as ${data.employee_status}${data.login_reactivated ? ' — login re-enabled' : ''}`);
      load();
    } catch (err) {
      showNotice(err?.response?.data?.error || 'Failed to withdraw exit', 'error');
    } finally { setActioning(false); }
  };

  const openInterview = (employeeId) => { setInterviewForm(BLANK_INTERVIEW); setInterviewError(''); setShowInterview(employeeId); };
  const conductInterview = async () => {
    if (actioning) return;
    if (!interviewForm.reason_category) { setInterviewError('Choose the exit reason.'); return; }
    if (RATING_KEYS.some(k => interviewForm[k] === '')) { setInterviewError('Give all five ratings.'); return; }
    if (!interviewForm.would_rejoin) { setInterviewError('Say whether they would rejoin.'); return; }
    setInterviewError('');
    setActioning(true);
    try {
      await api.post('/exit/interview', {
        ...interviewForm,
        ...Object.fromEntries(RATING_KEYS.map(k => [k, Number(interviewForm[k])])),
        employee_id: showInterview,
      });
      showNotice('Exit interview recorded successfully');
      setShowInterview(null);
      load();
    } catch (e) {
      // The server says why (NO_EXIT, INTERVIEW_EXISTS, BAD_RATING, BAD_REASON).
      setInterviewError(e?.response?.data?.error || 'Failed to save exit interview');
    } finally { setActioning(false); }
  };

  const loadClearanceStatus = async (empId) => {
    try {
      const res = await api.get(`/exit/clearance/${empId}/status`);
      setClearanceStatus(p => ({ ...p, [empId]: res.data }));
    } catch (_) {
      setClearanceStatus(p => ({ ...p, [empId]: null }));
    }
  };

  // A failed save used to be swallowed (11-03 F-15): the tick stayed on screen
  // while the server still had it unticked. Now the tick is put back and the
  // reason is shown.


  const cd = fnfData?.computation_details;
  const fnfIsLocked = fnfLocked(fnfData) || fnfLocked(fnfExit);

  return (
    // Inside the Exit Management hub the hub's banner already names the page.
    <PageShell embedded={embedded} dock={embedded ? null :
      <PageHero
        icon={Users}
        eyebrow="Human Resources"
        title="Exit Management"
        subtitle="Full & Final settlement and exit interviews · clearance is on the Exit Checklist"
      />
    }>


      {notice && (
        <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 600, background: notice.type === 'error' ? '#fee2e2' : '#dcfce7', color: notice.type === 'error' ? '#dc2626' : '#15803d' }}>
          {notice.msg}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 24, width: 'fit-content' }}>
        {/* Clearance moved into the one Exit Checklist (next tab of this hub), owner decision 2026-11-17. */}
        {['Active Exits', 'F&F Calculator', 'Exit Interviews', 'Settlement Rules'].map((t, i) => (
          <button key={i} style={tabStyle(tab === i)} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => setShowInitiate(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              + Initiate Exit
            </button>
          </div>

          {showInitiate && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>Initiate Employee Separation</h3>
              {handOff && String(initiateForm.employee_id) === handOff.form.employee_id && (
                <div role="status" style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, background: '#f5f3ff', color: '#4c1d95', border: '1px solid #e9e4ff' }}>
                  Starting the exit of <strong>{handOff.name || `employee #${handOff.form.employee_id}`}</strong> from All Employees.
                  {handOff.typeMapped ? ' Check the details, then Initiate.' : ' Choose the separation type, then Initiate.'}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                <div style={{ gridColumn: 'span 2' }}>
                  <label htmlFor="ex-init-emp" style={labelStyle}>Employee *</label>
                  <select id="ex-init-emp" value={initiateForm.employee_id}
                    onChange={e => setInitiateField('employee_id', e.target.value)} style={inputStyle}>
                    <option value="">{employees === null ? 'Loading employees…' : '— Select employee —'}</option>
                    {/* A hand-off can name someone the list does not hold (e.g. already on notice); keep them selectable so the server can say why. */}
                    {handOff && initiateForm.employee_id === handOff.form.employee_id && employees && !pickedEmployee && (
                      <option value={handOff.form.employee_id}>{handOff.name || `#${handOff.form.employee_id}`} (#{handOff.form.employee_id})</option>
                    )}
                    {(employees || []).map(e => <option key={e.id} value={e.id}>{empLabel(e)}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="ex-init-type" style={labelStyle}>Exit type *</label>
                  <select id="ex-init-type" value={initiateForm.separation_type}
                    onChange={e => setInitiateForm(p => ({ ...p, separation_type: e.target.value }))} style={inputStyle}>
                    {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="ex-init-rd" style={labelStyle}>Resignation / notice date</label>
                  <input id="ex-init-rd" type="date" value={initiateForm.resignation_date}
                    onChange={e => setInitiateField('resignation_date', e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label htmlFor="ex-init-np" style={labelStyle}>Notice period (days)</label>
                  <input id="ex-init-np" type="number" min="0" max="365" value={initiateForm.notice_period}
                    placeholder={pickedEmployee?.notice_period_days != null ? `${pickedEmployee.notice_period_days} (contract)`
                      : companyNoticeDays != null ? `${companyNoticeDays} (company default)` : 'From contract'}
                    onChange={e => setInitiateField('notice_period', e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label htmlFor="ex-init-lwd" style={labelStyle}>Last working day *</label>
                  <input id="ex-init-lwd" type="date" value={initiateForm.last_working_date}
                    onChange={e => { setLwdTouched(true); setInitiateField('last_working_date', e.target.value); }} style={inputStyle} />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label htmlFor="ex-init-reason" style={labelStyle}>Reason</label>
                  <input id="ex-init-reason" type="text" value={initiateForm.reason}
                    onChange={e => setInitiateForm(p => ({ ...p, reason: e.target.value }))} style={inputStyle} />
                </div>
              </div>
              {noticeNote(initiateForm, initiateNoticeDays) && (
                <div role="status" style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#f5f3ff', color: '#4c1d95', border: '1px solid #e9e4ff' }}>
                  {noticeNote(initiateForm, initiateNoticeDays)}
                </div>
              )}
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
                Enter the date of the resignation email: the last working day is filled in from the notice period, and you can change it for an early release.
                Leave the notice period empty to use the employee's contract. The department head and reporting manager are notified.
              </div>
              {initiateError && (
                <div role="alert" style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#fee2e2', color: '#b91c1c' }}>{initiateError}</div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={initiateExit} disabled={actioning} style={{ padding: '8px 16px', background: actioning ? '#a78bfa' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: actioning ? 'not-allowed' : 'pointer', fontSize: 13 }}>{actioning ? 'Initiating…' : 'Initiate'}</button>
                <button onClick={() => { setShowInitiate(false); setInitiateError(''); }} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['Employee', 'Department', 'Type', 'Last Working Day', 'Days Left', 'Interview', 'F&F Status', 'Net Payable', 'Actions'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {activeExits.map((e, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600 }}>{e.employee_name}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{e.employee_code} · {e.designation}</div>
                    </td>
                    <td style={tdStyle}>{e.department}</td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: '#f0ebff', color: SEP_COLORS[e.separation_type] || '#6B3FDB' }}>
                        {separationLabel(e.separation_type)}
                      </span>
                    </td>
                    <td style={tdStyle}>{fmtDay(e.last_working_date) || '-'}</td>
                    <td style={tdStyle}>
                      {(() => {
                        // Same wording as All Employees' notice column: the last day is "today", not overdue.
                        const d = Number(e.days_remaining);
                        if (e.days_remaining == null || !Number.isFinite(d)) return '-';
                        const late = d < 0;
                        return (
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: late ? '#fee2e2' : d <= 7 ? '#ede9fe' : '#f0ebff', color: late ? '#dc2626' : d <= 7 ? '#5b21b6' : '#6B3FDB' }}>
                            {late ? `${-d}d overdue` : d === 0 ? 'Today' : `${d}d left`}
                          </span>
                        );
                      })()}
                    </td>
                    <td style={tdStyle}>
                      {/* Was the exit request's status ("active"), under an Interview heading. */}
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: e.interview_done ? '#d1fae5' : '#ede9fe', color: e.interview_done ? '#065f46' : '#5b21b6' }}>{e.interview_done ? 'Done' : 'Not done'}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: e.fnf_status === 'paid' ? '#d1fae5' : e.fnf_status === 'approved' ? '#dbeafe' : '#ede9fe', color: e.fnf_status === 'paid' ? '#065f46' : e.fnf_status === 'approved' ? '#1e40af' : '#5b21b6' }}>{e.fnf_status || 'draft'}</span>
                      {/* §276: final wages are due N working days after the last day */}
                      {e.fnf_status !== 'paid' && e.fnf_due_date && (
                        <div style={{ fontSize: 11, marginTop: 4, color: e.fnf_days_late > 0 ? '#b91c1c' : '#6b7280', fontWeight: e.fnf_days_late > 0 ? 600 : 400 }}
                          title={`Final wages due by ${fmtDay(e.fnf_due_date)}; gratuity by ${fmtDay(e.gratuity_due_date)}`}>
                          {e.fnf_days_late > 0 ? `${e.fnf_days_late} day${e.fnf_days_late === 1 ? '' : 's'} late` : `Due ${fmtDay(e.fnf_due_date)}`}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: '#6B3FDB' }}>{e.net_payable ? fmt(e.net_payable) : '-'}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      <button onClick={() => openEdit(e)} disabled={fnfLocked(e)}
                        title={fnfLocked(e) ? `F&F is ${e.fnf_status}; the exit details can no longer change` : 'Correct the exit type, dates, notice or reason'}
                        style={{ padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: fnfLocked(e) ? 'not-allowed' : 'pointer', fontSize: 12, marginRight: 4, opacity: fnfLocked(e) ? 0.5 : 1 }}>Edit</button>
                      {/* F&F (re)computes a new version. Once approved that would cancel the
                          approval silently, so it is refused here; Review opens the saved
                          version without recomputing (HR audit 2026-11-16). */}
                      <button onClick={() => openFnf(e)}
                        title={fnfLocked(e) ? `F&F is ${e.fnf_status}: view the saved settlement` : 'Open the settlement: view the saved version or calculate one'}
                        style={{ padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginRight: 4 }}>F&F</button>
                      {e.fnf_status && (
                        <a href={`/SettlementReview?exit=${e.id}`} title="Approve or record payment of the saved settlement"
                          style={{ display: 'inline-block', padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', borderRadius: 6, fontSize: 12, marginRight: 4, textDecoration: 'none' }}>Review</a>
                      )}
                      <button onClick={() => { setTab(2); openInterview(e.employee_id); }} disabled={!!e.interview_done}
                        title={e.interview_done ? 'The exit interview is already recorded (Exit Interviews tab)' : 'Record the exit interview'}
                        style={{ padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: e.interview_done ? 'not-allowed' : 'pointer', fontSize: 12, marginRight: 4, opacity: e.interview_done ? 0.5 : 1 }}>Interview</button>
                      {hasLeft(e) && (
                        <>
                          <button onClick={() => downloadExitLetter(e.employee_id, 'relieving', showNotice)} disabled={e.separation_type === 'absconding'}
                            title={e.separation_type === 'absconding' ? 'No relieving letter for an employee who absconded' : 'Relieving letter (PDF)'}
                            style={{ padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: e.separation_type === 'absconding' ? 'not-allowed' : 'pointer', fontSize: 12, marginRight: 4, opacity: e.separation_type === 'absconding' ? 0.5 : 1 }}>Relieving</button>
                          <button onClick={() => downloadExitLetter(e.employee_id, 'experience', showNotice)} title="Experience letter (PDF)"
                            style={{ padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginRight: 4 }}>Experience</button>
                        </>
                      )}
                      {e.fnf_status !== 'paid' && !hasLeft(e) && (
                        <button onClick={() => setWithdrawTarget(e)} disabled={actioning} style={{ padding: '4px 10px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: actioning ? 'not-allowed' : 'pointer', fontSize: 12 }}>Withdraw</button>
                      )}
                    </td>
                  </tr>
                ))}
                {activeExits.length === 0 && (
                  <tr><td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: '#6b7280', padding: 32 }}>No one is currently leaving. Use Initiate Exit to start one.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 3 && <SettlementRulesPanel />}

      {tab === 1 && (
        <div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="fnf-exit" style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Employee</label>
              <select id="fnf-exit" value={fnfExit?.id || ''} onChange={e => openFnf(activeExits.find(x => String(x.id) === e.target.value) || null)}
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, width: 300 }}>
                <option value="">-- Select Employee --</option>
                {activeExits.map(e => <option key={e.id} value={e.id}>{e.employee_name} ({e.employee_code})</option>)}
              </select>
            </div>
          </div>

          {fnfError && (
            <div role="alert" style={{ ...cardStyle, padding: 24, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca' }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>F&F settlement could not be computed</div>
              <div style={{ fontSize: 13 }}>{fnfError}</div>
            </div>
          )}
          {!fnfExit && <div style={{ ...cardStyle, padding: 40, textAlign: 'center', color: '#6b7280' }}>Select an employee to see or calculate their F&F settlement</div>}
          {fnfExit && fnfLoading && <div style={{ ...cardStyle, padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading the saved settlement…</div>}

          {fnfExit && !fnfLoading && (
            <div>
              {fnfData?.settlement_actions_suspended && (
                <div role="status" style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                  ⚠ Provisional figures — {fnfData.containment_notice}
                </div>
              )}
              {!fnfData && (
                <div role="status" style={{ ...cardStyle, padding: 16, color: '#4b5563', fontSize: 13 }}>
                  No settlement has been calculated for {fnfExit.employee_name} yet. Check the inputs, then Calculate.
                </div>
              )}
              <div style={{ ...cardStyle, padding: 16, marginBottom: 16 }}>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, color: '#111827' }}>Inputs</h3>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                  Notice started {fnfExit.resignation_date ? fmtDay(fnfExit.resignation_date) : 'on a date not recorded'}, last working day {fmtDay(fnfExit.last_working_date)}.
                  {' '}These come from the exit: change them with Edit on Active Exits.
                </div>
                <fieldset disabled={fnfIsLocked} style={{ border: 'none', padding: 0, margin: 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, fontSize: 13 }}>
                  <label>Loss of pay days, last month
                    <input type="number" min="0" max="31" value={fnfOptions.lop_days} onChange={(e) => setFnfOptions((o) => ({ ...o, lop_days: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                  </label>
                  <label>Notice days waived
                    <input type="number" min="0" value={fnfOptions.waive_notice_days} onChange={(e) => setFnfOptions((o) => ({ ...o, waive_notice_days: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                  </label>
                  <label style={{ gridColumn: 'span 2' }}>Reason for waiver
                    <input type="text" value={fnfOptions.waive_reason} onChange={(e) => setFnfOptions((o) => ({ ...o, waive_reason: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                  </label>
                  <label>Gratuity forfeited: reason
                    <input type="text" value={fnfOptions.forfeit_gratuity_reason} onChange={(e) => setFnfOptions((o) => ({ ...o, forfeit_gratuity_reason: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                  </label>
                  <label>Bonus disqualified: reason
                    <input type="text" value={fnfOptions.bonus_disqualified_reason} onChange={(e) => setFnfOptions((o) => ({ ...o, bonus_disqualified_reason: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                  </label>
                  <label>Asset value to recover
                    <input type="number" min="0" value={fnfOptions.asset_recovery_amount} onChange={(e) => setFnfOptions((o) => ({ ...o, asset_recovery_amount: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                  </label>
                  <label>Asset: reason
                    <input type="text" value={fnfOptions.asset_recovery_reason} onChange={(e) => setFnfOptions((o) => ({ ...o, asset_recovery_reason: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                  </label>
                </div>
                {cd?.sales_incentive && (() => {
                  const si = cd.sales_incentive;
                  const s = si.suggested;
                  const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
                  const current = si.decision === 'pay' ? `Pay ${rs(si.amount)} (${si.reason})` : si.decision === 'not_pay' ? `Not paid (${si.reason})` : 'Not decided yet';
                  const set = (patch) => setFnfOptions((o) => ({ ...o, ...patch }));
                  return (
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f3f4f6', fontSize: 13 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Sales incentive{s?.fy_label ? ` ${s.fy_label}` : ''}: HR decides, Finance is told</div>
                      <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 8 }}>
                        {s ? <>By the last working day: {s.pct}% of the {rs(s.target)} target achieved ({rs(s.achieved)}). The slabs give <strong>{rs(s.amount)}</strong>. {s.basis}</> : 'No sales target is on record for this year.'}
                        {' '}Current decision: <strong>{current}</strong>.
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
                        <label>Decision
                          <select aria-label="Sales incentive decision" value={fnfOptions.si_decision}
                            onChange={(e) => set({ si_decision: e.target.value, ...(e.target.value === 'pay' && fnfOptions.si_amount === '' ? { si_amount: String(si.decision === 'pay' ? si.amount : s?.amount ?? '') } : {}) })}
                            style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }}>
                            <option value="">Keep the current decision</option>
                            <option value="pay">Pay</option>
                            <option value="not_pay">Do not pay</option>
                            <option value="undecided">Clear the decision</option>
                          </select>
                        </label>
                        {fnfOptions.si_decision === 'pay' && (
                          <label>Amount to pay (₹)
                            <input type="number" min="1" step="1" value={fnfOptions.si_amount} onChange={(e) => set({ si_amount: e.target.value })} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                          </label>
                        )}
                        {(fnfOptions.si_decision === 'pay' || fnfOptions.si_decision === 'not_pay') && (
                          <label style={{ gridColumn: 'span 2' }}>Reason (Finance sees this)
                            <input type="text" value={fnfOptions.si_reason} onChange={(e) => set({ si_reason: e.target.value })} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })()}
                </fieldset>
                {fnfIsLocked ? (
                  <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
                    This settlement is {fnfData?.status || fnfExit.fnf_status}. It can no longer be recalculated: a new version would cancel the approval.
                  </div>
                ) : (
                  <button type="button" onClick={calculate} disabled={actioning}
                    style={{ marginTop: 12, padding: '8px 16px', background: actioning ? '#a78bfa' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: actioning ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
                    {actioning ? 'Calculating…' : fnfData ? 'Recalculate (new version)' : 'Calculate'}
                  </button>
                )}
              </div>

              {fnfData && cd && (
                <>
                  {cd.warnings?.length > 0 && (
                    <div role="alert" style={{ ...cardStyle, padding: 16, marginBottom: 16, background: '#fffbeb', border: '1px solid #fde68a' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#92400e', marginBottom: 8 }}>Check before relying on this</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#92400e' }}>
                        {cd.warnings.map((w) => <li key={w.code + w.message}>{w.message}</li>)}
                      </ul>
                    </div>
                  )}

                  <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
                    <h3 style={{ margin: '0 0 4px', fontSize: 15, color: '#111827' }}>
                      Settlement, version {fnfData.version}{fnfData.saved ? ' (saved)' : ''}
                    </h3>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                      {fnfData.saved
                        ? `Calculated ${fnfData.computed_at ? fmtDay(String(fnfData.computed_at).slice(0, 10)) : ''}${fnfData.computed_by_name ? ` by ${fnfData.computed_by_name}` : ''}. Recalculate to pick up changed salary, leave or rules.`
                        : `Service ${cd.service?.years} years ${cd.service?.months} months. Day rate ${fmt(cd.day_rate)}. Final wages are due within ${cd.wage_payment_days} working days.`}
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: '#6b7280', fontSize: 12 }}>
                          <th style={{ padding: '6px 8px' }}>Component</th>
                          <th style={{ padding: '6px 8px' }}>How it was worked out</th>
                          <th style={{ padding: '6px 8px' }}>Tax</th>
                          <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cd.lines?.map((l) => (
                          <tr key={l.code + l.label + (l.source_id ?? '')} style={{ borderTop: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '8px', fontWeight: 600 }}>{l.label}</td>
                            <td style={{ padding: '8px', fontSize: 12, color: '#4b5563' }}>{l.basis}</td>
                            <td style={{ padding: '8px', fontSize: 11, color: '#6b7280' }}>{l.tax}</td>
                            <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', color: Number(l.amount) === 0 ? '#6b7280' : l.direction === 'payable' ? '#059669' : '#dc2626' }}>
                              {l.direction === 'recoverable' && Number(l.amount) > 0 ? '− ' : ''}{fmt(l.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {cd.rules_unconfirmed?.length > 0 && (
                    <div style={{ ...cardStyle, padding: 16, marginBottom: 16, background: '#f9fafb' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#374151', marginBottom: 8 }}>Rules not yet confirmed by your adviser</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#4b5563' }}>
                        {cd.rules_unconfirmed.map((r) => <li key={r.key}>{r.key.replace('settlement.', '').replace('_', ' ')}: {r.source}</li>)}
                      </ul>
                    </div>
                  )}

                  {fnfData.status !== 'paid' && clearanceStatus[selectedEmployee] && !clearanceStatus[selectedEmployee].can_settle && (
                    <div style={{ ...cardStyle, padding: 16, marginBottom: 16, background: '#fef2f2', border: '1px solid #fecaca' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#991b1b', marginBottom: 8 }}>Payment waits for exit clearance (Exit Checklist tab)</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#991b1b' }}>
                        {clearanceStatus[selectedEmployee].blockers.filter(b => !b.cleared).map(b => (
                          <li key={b.key}>{b.label}{b.detail?.length ? `: ${b.detail.join(', ')}` : ''}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div style={{ ...cardStyle, padding: 24, background: 'linear-gradient(135deg, #6B3FDB 0%, #4f46e5 100%)', color: '#fff' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 14, opacity: 0.8 }}>Net Payable to Employee</div>
                        <div style={{ fontSize: 36, fontWeight: 800, marginTop: 4 }}>{fmt(fnfData.net_payable)}</div>
                        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Payable {fmt(cd.summary?.total_payable)} − Recoverable {fmt(cd.summary?.total_recoverable)} (tax on the settlement is one of the recoverable lines)</div>
                      </div>
                      {/* Approval and payment are Finance's, on Settlement Review: the
                          person who calculated a version may not approve it. */}
                      {fnfData.status === 'paid'
                        ? <span style={{ padding: '10px 20px', background: '#059669', borderRadius: 8, fontSize: 13, fontWeight: 700 }}>Paid</span>
                        : !fnfData.settlement_actions_suspended && (
                          <a href={`/SettlementReview?exit=${fnfData.id}`}
                            style={{ padding: '10px 20px', background: '#fff', color: '#6B3FDB', borderRadius: 8, fontWeight: 700, fontSize: 13, textDecoration: 'none' }}>
                            {fnfData.status === 'approved' ? 'Open Settlement Review to record payment' : 'Open Settlement Review for approval'}
                          </a>
                        )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 2 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
          <div>
            {showInterview && (
              <div style={{ ...cardStyle, padding: 20, marginBottom: 16, border: '2px solid #6B3FDB' }}>
                <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#6B3FDB' }}>Conduct Exit Interview</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Exit Reason *</label>
                    <VocabSelect vocab="exit-reasons" ariaLabel="Exit reason" value={interviewForm.reason_category}
                      selectStyle={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}
                      onChange={v => setInterviewForm(p => ({ ...p, reason_category: v || '' }))} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Would Rejoin? *</label>
                    <select aria-label="Would rejoin" value={interviewForm.would_rejoin} onChange={e => setInterviewForm(p => ({ ...p, would_rejoin: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                      <option value="">— Choose —</option>
                      {['yes', 'no', 'maybe'].map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Detailed Reason</label>
                  <textarea value={interviewForm.reason_detail} onChange={e => setInterviewForm(p => ({ ...p, reason_detail: e.target.value }))}
                    rows={3} style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
                </div>
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Ratings (1-5) *</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                    {[['Management', 'rating_management'], ['Culture', 'rating_culture'], ['Work', 'rating_work'], ['Growth', 'rating_growth'], ['Overall', 'overall_rating']].map(([label, key]) => (
                      <div key={key} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
                        <select aria-label={`${label} rating`} value={interviewForm[key]} onChange={e => setInterviewForm(p => ({ ...p, [key]: e.target.value }))}
                          style={{ width: '100%', padding: '4px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, textAlign: 'center' }}>
                          <option value="">—</option>
                          {[1, 2, 3, 4, 5].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
                {interviewError && <div role="alert" style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#fee2e2', color: '#b91c1c' }}>{interviewError}</div>}
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button onClick={conductInterview} disabled={actioning} style={{ padding: '8px 16px', background: actioning ? '#a78bfa' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: actioning ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>{actioning ? 'Saving…' : 'Submit Interview'}</button>
                  <button onClick={() => setShowInterview(null)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                </div>
              </div>
            )}

            <div style={cardStyle}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Employee', 'Department', 'Date', 'Reason', 'Overall Rating', 'Would Rejoin'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {interviews.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{r.employee_name}</td>
                      <td style={tdStyle}>{r.department}</td>
                      <td style={tdStyle}>{r.created_at ? fmtDay(String(r.created_at).slice(0, 10)) : '-'}</td>
                      <td style={tdStyle}>{r.reason_category ? reasonLabel(r.reason_category) : '-'}</td>
                      <td style={tdStyle}>{r.overall_rating ? '⭐'.repeat(r.overall_rating) : '-'}</td>
                      <td style={tdStyle}>{r.would_rejoin || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {analytics && (
            <div>
              <div style={{ ...cardStyle, padding: 16, marginBottom: 12 }}>
                <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Exit Reasons</h4>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={analytics.reasons.map(r => ({ name: reasonLabel(r.reason_category), value: parseInt(r.count) }))} cx="50%" cy="50%" outerRadius={70} dataKey="value" label={({ name: _name, value }) => `${value}`}>
                      {analytics.reasons.map((_, i) => <Cell key={i} fill={REASON_COLORS[i % REASON_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {analytics.reasons.map((r, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: REASON_COLORS[i] }} />
                      <span>{reasonLabel(r.reason_category)}: {r.count}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ ...cardStyle, padding: 16 }}>
                <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Avg Ratings</h4>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={[
                    { name: 'Mgmt', value: parseFloat(analytics.ratings.avg_management || 0).toFixed(1) },
                    { name: 'Culture', value: parseFloat(analytics.ratings.avg_culture || 0).toFixed(1) },
                    { name: 'Work', value: parseFloat(analytics.ratings.avg_work || 0).toFixed(1) },
                    { name: 'Growth', value: parseFloat(analytics.ratings.avg_growth || 0).toFixed(1) },
                    { name: 'Overall', value: parseFloat(analytics.ratings.avg_overall || 0).toFixed(1) }
                  ]} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 5]} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#6B3FDB" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {editTarget && (
        <div role="dialog" aria-modal="true" aria-labelledby="ex-edit-title"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: 520, maxWidth: '100%', padding: 24, boxShadow: '0 24px 64px rgba(0,0,0,.2)' }}>
            <h3 id="ex-edit-title" style={{ margin: '0 0 4px', fontSize: 16 }}>Edit exit</h3>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>{editTarget.employee_name} ({editTarget.employee_code})</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label htmlFor="ex-edit-type" style={labelStyle}>Exit type *</label>
                <select id="ex-edit-type" value={editForm.separation_type} onChange={e => setEditForm(f => ({ ...f, separation_type: e.target.value }))} style={inputStyle}>
                  {!SEPARATION_OPTIONS.some(o => o.value === editForm.separation_type) && (
                    <option value={editForm.separation_type} disabled>{separationLabel(editForm.separation_type)} (choose a current type)</option>
                  )}
                  {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ex-edit-lwd" style={labelStyle}>Last working day *</label>
                <input id="ex-edit-lwd" type="date" value={editForm.last_working_date} onChange={e => setEditForm(f => ({ ...f, last_working_date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label htmlFor="ex-edit-rd" style={labelStyle}>Resignation / notice date</label>
                <input id="ex-edit-rd" type="date" value={editForm.resignation_date} onChange={e => setEditForm(f => ({ ...f, resignation_date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label htmlFor="ex-edit-np" style={labelStyle}>Notice period (days)</label>
                <input id="ex-edit-np" type="number" min="0" max="365" value={editForm.notice_period}
                  placeholder={editTarget.employee_notice_period_days != null ? `${editTarget.employee_notice_period_days} (contract)` : ''}
                  onChange={e => setEditForm(f => ({ ...f, notice_period: e.target.value }))} style={inputStyle} />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label htmlFor="ex-edit-reason" style={labelStyle}>Reason</label>
                <input id="ex-edit-reason" type="text" value={editForm.reason} onChange={e => setEditForm(f => ({ ...f, reason: e.target.value }))} style={inputStyle} />
              </div>
            </div>
            {(() => {
              const n = editForm.notice_period !== '' && editForm.notice_period != null ? Number(editForm.notice_period)
                : (editTarget.employee_notice_period_days ?? companyNoticeDays);
              const note = noticeNote(editForm, n);
              return note ? <div role="status" style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#f5f3ff', color: '#4c1d95', border: '1px solid #e9e4ff' }}>{note}</div> : null;
            })()}
            {editError && <div role="alert" style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#fee2e2', color: '#b91c1c' }}>{editError}</div>}
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setEditTarget(null)} className="pulse-btn-secondary">Cancel</button>
              <button onClick={saveEdit} disabled={actioning} className="pulse-btn-primary">{actioning ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!withdrawTarget}
        title="Withdraw exit?"
        message={withdrawTarget ? `${withdrawTarget.employee_name} (${withdrawTarget.employee_code}) will stay employed. The exit request is cancelled, clearance is reset, and a login revoked during this exit is re-enabled.` : ''}
        confirmLabel="Withdraw exit"
        onConfirm={withdrawExit}
        onCancel={() => setWithdrawTarget(null)}
      />
    </PageShell>
  );
}
