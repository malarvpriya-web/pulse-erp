import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar, Clock, FileText, CheckCircle, AlertTriangle, X, RefreshCw,
  Send, Info, Upload, User, CalendarDays, GitBranch,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './ApplyLeave.css';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { localISO } from '../components/leaveShared';
import { isWeeklyOff } from '../components/SaturdayOffPicker';

const ADMIN_ROLES = new Set(['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'hr_admin']);

// (detectClubbingWarning removed 2026-11-24: it warned "Clubbing" for any
// leave that merely started on a Monday or ended on a Friday. Clubbing is a
// weekly off or holiday INSIDE the leave — calcBreakdown's clubbedLopDays —
// and only those days are charged. The server counts the days itself.)

function getEmployeeStatus(user) {
  const s = (user?.employment_status || user?.status || user?.employee_status || '').toLowerCase();
  if (s === 'probation' || s === 'probationary') return 'probation';
  if (s === 'notice' || s === 'notice_period' || s === 'serving_notice') return 'notice';
  return null;
}

// Break a leave range into paid working days and "clubbed" LOP days.
//   workingDays    → days that aren't a weekly off or holiday (deducted from balance)
//   clubbedLopDays → weekly offs / holidays SANDWICHED between the first and last
//                    working leave day, charged as Loss of Pay.
// Weekly offs are the company's (Attendance / Leave Settings: weekend days and
// which Saturdays are off), not a fixed Saturday + Sunday.
function calcBreakdown(start, end, holidays = [], weekCfg = null) {
  if (!start || !end) return { workingDays: 0, clubbedLopDays: 0, offDays: 0 };
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end   + 'T00:00:00');
  if (e < s) return { workingDays: 0, clubbedLopDays: 0, offDays: 0 };
  const holidaySet = new Set(holidays.map(h => String(h.date || '').slice(0, 10)));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const isWorking = (d) => !isWeeklyOff(fmt(d), weekCfg) && !holidaySet.has(fmt(d));
  const days = [];
  const cur = new Date(s);
  while (cur <= e) { days.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
  let workingDays = 0, firstWork = null, lastWork = null;
  days.forEach((d, i) => {
    if (isWorking(d)) { workingDays++; if (firstWork === null) firstWork = i; lastWork = i; }
  });
  let clubbedLopDays = 0;
  if (firstWork !== null) {
    for (let i = firstWork; i <= lastWork; i++) if (!isWorking(days[i])) clubbedLopDays++;
  }
  return { workingDays, clubbedLopDays, offDays: days.length - workingDays };
}

// Local calendar date. toISOString() is UTC: between 00:00 and 05:30 IST it
// returned yesterday, so "today" and the earliest allowed date were a day off.
const today = () => localISO();

// Same rule as the server: a type whose NAME contains one of these words needs
// no advance notice (Sick Leave, Medical Leave …).
const NOTICE_EXEMPT_WORDS = ['sick', 'medical', 'emergency', 'bereavement'];
const noticeExempt = (name) => NOTICE_EXEMPT_WORDS.some(w => String(name || '').toLowerCase().includes(w));

const fmtDate = (iso) => (iso
  ? new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
  : '');

// Card colours for the common types; anything else gets indigo.
const TYPE_COLOR = {
  'Sick Leave': '#ef4444', 'Casual Leave': '#7c5cf0', 'Earned Leave': '#10b981', 'Annual Leave': '#10b981',
  'Maternity Leave': '#ec4899', 'Paternity Leave': '#6366f1', 'Compensatory Off': '#8b5cf6',
  'Compensatory Leave': '#8b5cf6', 'Bereavement Leave': '#6b7280', 'Marriage Leave': '#7c5cf0',
};

const NO_STATUS = { in_probation: false, status_probation: false, probation_end: null, in_notice: false, last_working_date: null, approver: null };
const LOP_NAME = 'Loss of Pay';
const isLopName = (n) => /loss.of.pay/i.test(String(n || ''));

export default function ApplyLeave({ setPage }) {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the admin surface from anyone holding hr as a
  // secondary role. See AuthContext.
  const { user, hasAnyRole } = useAuth();
  const navigate = useNavigate();
  const goMyLeaves = () => (setPage ? setPage('MyLeaves') : navigate('/MyLeaves'));
  const isAdmin = hasAnyRole(...ADMIN_ROLES);
  const uid = user?.employee_id;

  const [balances,         setBalances]         = useState({});
  const [leaveTypes,       setLeaveTypes]       = useState([]);
  const [leaveTypesLoading,setLeaveTypesLoading]= useState(true);
  const [employees,        setEmployees]        = useState([]);
  const [holidays,    setHolidays]    = useState([]);
  const [weekCfg,     setWeekCfg]     = useState(null);   // { weekend_days, saturday_off_weeks }
  const [probation,   setProbation]   = useState(NO_STATUS);
  const [loading,     setLoading]     = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [toast,       setToast]       = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitted,   setSubmitted]   = useState(null);   // the request just sent
  const [reloadKey,   setReloadKey]   = useState(0);      // header refresh re-reads everything
  const fileRef = useRef(null);

  // ?from=YYYY-MM-DD (Leave Calendar → "Apply for leave from this day").
  // A past date only for HR; anyone else starts today.
  const initialFrom = (() => {
    try {
      const v = new URLSearchParams(window.location.search).get('from') || '';
      return /^\d{4}-\d{2}-\d{2}$/.test(v) && (isAdmin || v >= today()) ? v : today();
    } catch { return today(); }
  })();
  const [form, setForm] = useState({
    employee_id:   uid || '',
    leave_type:    '',
    leave_type_id: '',
    start_date:    initialFrom,
    end_date:      initialFrom,
    reason:        '',
    half_day:      false,
    half_day_session: 'AM',
    attachment_file: null,
  });

  const targetId = isAdmin ? form.employee_id : uid;
  const onBehalf = isAdmin && String(form.employee_id) !== String(uid);

  useEffect(() => {
    api.get('/leaves/settings').then(r => setWeekCfg(r.data || null)).catch(() => setWeekCfg(null));
  }, [reloadKey]);

  // Probation / notice come from the server (stored probation end date, status,
  // an open exit). Probation covers a leave that STARTS on or before the end
  // date, or any leave while the status is Probation — the rule /apply
  // enforces. A leave after the end date is paid again.
  const employeeStatus = useMemo(() => (onBehalf ? null : getEmployeeStatus(user)), [user, onBehalf]);
  const inProbation = !!(
    probation.status_probation || employeeStatus === 'probation'
    || (probation.probation_end && form.start_date && form.start_date <= probation.probation_end)
    || (probation.in_probation && !probation.probation_end)
  );
  const inNotice = !inProbation && (probation.in_notice || employeeStatus === 'notice');
  const isLOP = inProbation || inNotice;
  const effectiveLeaveType = isLOP ? LOP_NAME : form.leave_type;

  const selectedType = leaveTypes.find(t => t.key === effectiveLeaveType)
    || (isLopName(effectiveLeaveType) ? leaveTypes.find(t => t.isLOP || isLopName(t.key)) : undefined);
  const bal = balances[effectiveLeaveType] || { used: 0, pending: 0, available: 0, allocated: 0 };
  const lopType = leaveTypes.find(t => t.isLOP || isLopName(t.key));

  // Types this person can actually take: unpaid / negative-balance types, or a
  // type they hold days of (allocated or carried in). A paid type with no days
  // (e.g. Compensatory Off before any comp-off is earned) could never be
  // submitted — the server refuses it — so it is not offered.
  const applicableTypes = useMemo(() => leaveTypes.filter(t =>
    t.isLOP || t.allowNegative || (balances[t.key]?.allocated || 0) > 0
  ), [leaveTypes, balances]);

  const { workingDays, clubbedLopDays, offDays } = useMemo(
    // A half day counts only on a working day (the server refuses one on a
    // weekly off or holiday).
    () => form.half_day
      ? (calcBreakdown(form.start_date, form.start_date, holidays, weekCfg).workingDays > 0
          ? { workingDays: 0.5, clubbedLopDays: 0, offDays: 0 } : { workingDays: 0, clubbedLopDays: 0, offDays: 1 })
      : calcBreakdown(form.start_date, form.end_date, holidays, weekCfg),
    [form.start_date, form.end_date, form.half_day, holidays, weekCfg]
  );

  // During probation / notice the whole request is LOP; otherwise only the
  // sandwiched (clubbed) weekly offs / holidays are LOP and working days paid.
  const lopDays = isLOP ? workingDays : clubbedLopDays;
  const days = workingDays;  // counted against the selected leave type / balance
  const totalDays = isLOP ? workingDays : workingDays + clubbedLopDays;
  const countsBalance = !isLOP && !!selectedType && !selectedType.isLOP && !selectedType.allowNegative;
  const overBalance = countsBalance && days > bal.available;
  const overConsecutive = !!selectedType?.maxConsecutive && days > selectedType.maxConsecutive;

  // Supporting document: always for some types, or past N days (medical
  // certificate). The server refuses the request without it.
  const needsAttachment = !isLOP && !!selectedType && (selectedType.requiresAttachment
    || (selectedType.medicalCertDays > 0 && days > selectedType.medicalCertDays));
  const attachmentReason = selectedType?.requiresAttachment
    ? `${effectiveLeaveType} needs a supporting document — attach it below.`
    : `More than ${selectedType?.medicalCertDays} day(s) of ${effectiveLeaveType} needs a medical certificate — attach it below.`;

  // Advance notice (calendar days between today and the start, on dates).
  const advanceWarn = useMemo(() => {
    if (!selectedType || !form.start_date || !selectedType.minNoticeDays || noticeExempt(selectedType.key)) return null;
    const noticeDays = Math.round((Date.parse(`${form.start_date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000);
    return noticeDays < selectedType.minNoticeDays
      ? `${selectedType.key} needs ${selectedType.minNoticeDays} day(s) advance notice — this starts in ${Math.max(0, noticeDays)} day(s). Pick a later date.`
      : null;
  }, [form.start_date, selectedType]);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Balances are per calendar year: a leave next January is taken from next
  // year's days (the server checks the year the leave starts in).
  const balanceYear = Number(String(form.start_date || '').slice(0, 4)) || new Date().getFullYear();
  const thisYear = new Date().getFullYear();
  const loadBalance = useCallback(async (empId, year) => {
    if (!empId) { setBalances({}); return; }
    setLoading(true);
    try {
      const res = await api.get(`/leaves/balance/${empId}`, { params: { year } });
      const arr = Array.isArray(res.data) ? res.data : (res.data?.balances || []);
      const obj = {};
      arr.forEach(b => {
        obj[b.leave_name] = {
          used:      Number(b.used_days)      || 0,
          pending:   Number(b.pending_days)   || 0,
          available: Number(b.available_days) || 0,
          // The person's own entitlement this year (pro-rated for joiners,
          // plus days carried in) — not the type's default yearly quota.
          allocated: (Number(b.allocated_days) || 0) + (Number(b.carried_forward_days) || 0),
          encashed:  Number(b.encashed_days)  || 0,
        };
      });
      setBalances(obj);
    } catch {
      setBalances({});
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { loadBalance(targetId, balanceYear); }, [targetId, balanceYear, reloadKey, loadBalance]);

  // Types for the person the leave is for: gender-restricted ones they cannot
  // take (Maternity / Paternity) are left out by the server (2026-11-24).
  // Types switched off in Leave Settings never arrive.
  useEffect(() => {
    setLeaveTypesLoading(true);
    api.get('/leaves/types', { params: { applicable: 1, ...(targetId ? { for_employee: targetId } : {}) } })
      .then(res => {
        const raw = Array.isArray(res.data) ? res.data : [];
        setLeaveTypes(raw.map(t => ({
          id:           t.id,
          key:          t.leave_name,
          allowHalfDay: t.allow_half_day ?? true,
          requiresAttachment: t.requires_attachment ?? false,
          medicalCertDays: Number(t.requires_medical_cert_days) || 0,
          minNoticeDays: Number(t.min_notice_days) || 0,
          maxConsecutive: Number(t.max_consecutive_days) || null,
          isLOP:        t.is_lop_type ?? false,
          allowNegative: t.allow_negative_balance ?? false,
          l2Required:   t.l2_required ?? false,
        })));
      })
      .catch(() => { setLeaveTypes([]); })
      .finally(() => setLeaveTypesLoading(false));
  }, [targetId, reloadKey]);

  // Keep a valid type picked: the first one this person can take, once their
  // balance is known (and again after HR switches to another employee).
  useEffect(() => {
    if (!applicableTypes.length) return;
    if (form.leave_type && applicableTypes.some(t => t.key === form.leave_type)) return;
    const first = applicableTypes.find(t => !t.isLOP) || applicableTypes[0];
    setForm(f => ({ ...f, leave_type: first.key, leave_type_id: first.id }));
  }, [applicableTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  // A type that cannot be taken as a half day clears the half-day tick (it
  // stayed ticked and was sent anyway).
  useEffect(() => {
    if (form.half_day && selectedType && !selectedType.allowHalfDay) setForm(f => ({ ...f, half_day: false }));
  }, [selectedType, form.half_day]);

  // Holidays of every year the leave touches, to leave them out of the day
  // count: the leave-taker's own calendar (company-wide + their zone) — the
  // same days the server leaves out. HR applying on behalf asks for that person's.
  const holidayYears = useMemo(() => {
    const ys = new Set([thisYear]);
    [form.start_date, form.end_date].forEach(d => { const y = Number(String(d || '').slice(0, 4)); if (y) ys.add(y); });
    return [...ys].sort().join(',');
  }, [form.start_date, form.end_date, thisYear]);
  useEffect(() => {
    const forEmp = isAdmin && form.employee_id ? { employee_id: form.employee_id } : {};
    Promise.all(holidayYears.split(',').map(y => api.get('/holidays', { params: { year: y, ...forEmp } })
      .then(res => (Array.isArray(res.data) ? res.data : [])).catch(() => [])))
      .then(lists => setHolidays(lists.flat()));
  }, [holidayYears, isAdmin, form.employee_id, reloadKey]);
  const holidaysInRange = useMemo(() => {
    const end = form.half_day ? form.start_date : form.end_date;
    return holidays.filter(h => { const d = String(h.date || '').slice(0, 10); return d >= form.start_date && d <= end; });
  }, [holidays, form.start_date, form.end_date, form.half_day]);

  // Probation / notice and who approves, for the person the leave is for.
  useEffect(() => {
    if (!targetId) { setProbation(NO_STATUS); return; }
    api.get('/leaves/probation-status', { params: { employee_id: targetId } })
      .then(res => setProbation({ ...NO_STATUS, ...(res.data || {}) }))
      .catch(() => setProbation(NO_STATUS));
  }, [targetId, reloadKey]);

  // Employee picker (HR): current staff only — Active, Probation, Notice.
  // /employees also sent exited people under spellings the old filter missed
  // (inactive, resigned …).
  useEffect(() => {
    if (!isAdmin) return;
    api.get('/leaves/calendar/people')
      .then(res => setEmployees(Array.isArray(res.data) ? res.data : []))
      .catch(() => setEmployees([]));
  }, [isAdmin, reloadKey]);

  const setF = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    if (fieldErrors[k]) setFieldErrors(e => ({ ...e, [k]: undefined }));
  };
  const pickType = (key) => {
    const found = leaveTypes.find(t => t.key === key);
    setForm(f => ({ ...f, leave_type: key, leave_type_id: found?.id || '' }));
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('File must be under 5 MB', 'error'); e.target.value = ''; return; }
    setForm(f => ({ ...f, attachment_file: file }));
    if (fieldErrors.attachment) setFieldErrors(e2 => ({ ...e2, attachment: undefined }));
  };
  const clearFile = () => { setForm(f => ({ ...f, attachment_file: null })); if (fileRef.current) fileRef.current.value = ''; };

  const handleSubmit = async () => {
    const errs = {};
    if (isAdmin && !form.employee_id) errs.employee_id = 'Select an employee';
    if (!selectedType && !isLopName(effectiveLeaveType)) errs.leave_type = 'Select a leave type';
    if (!form.start_date) errs.start_date = 'Start date is required';
    if (!form.half_day && !form.end_date) errs.end_date = 'End date is required';
    if (!isAdmin && form.start_date && form.start_date < today())
      errs.start_date = 'Leave cannot start before today — ask HR to enter a past date.';
    if (!form.half_day && form.end_date && form.start_date && form.end_date < form.start_date)
      errs.end_date = 'End date must be on or after start date';
    // Each year has its own balance (2026-11-25): one request per year.
    else if (!form.half_day && form.end_date && form.start_date && form.end_date.slice(0, 4) !== form.start_date.slice(0, 4))
      errs.end_date = `A leave can't run past 31 Dec — apply up to 31 Dec ${form.start_date.slice(0, 4)}, then a second request from 1 Jan.`;
    if (!form.reason.trim()) errs.reason = 'Reason is required';
    if (!errs.start_date && !errs.end_date && days <= 0) errs[form.half_day ? 'start_date' : 'end_date'] = form.half_day
      ? 'A half day must be on a working day — this date is a weekly off or holiday'
      : 'Select at least one working day for leave';
    if (needsAttachment && !form.attachment_file) errs.attachment = attachmentReason;

    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      // A fixed-position toast too — inline errors can be scrolled out of view.
      const firstMsg = errs.employee_id || errs.leave_type || errs.start_date || errs.end_date || errs.reason || errs.attachment;
      showToast(firstMsg || 'Please fix the highlighted fields before submitting.', 'error');
      return;
    }
    setFieldErrors({});
    if (overBalance) return showToast(`Only ${bal.available} day(s) of ${effectiveLeaveType} left in ${balanceYear}`, 'error');
    if (overConsecutive) return showToast(`${selectedType.key} allows at most ${selectedType.maxConsecutive} day(s) at a time`, 'error');
    if (advanceWarn) return showToast(advanceWarn, 'error');

    setSubmitting(true);
    try {
      let attachmentUrl = null;
      // Upload the file first; a failed upload aborts the application, so a
      // medical certificate never looks attached when nothing was stored.
      if (form.attachment_file) {
        const fd = new FormData();
        fd.append('file', form.attachment_file);
        try {
          const uploadRes = await api.post('/leaves/attachment', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
          attachmentUrl = uploadRes.data?.attachment_url || null;
          if (!attachmentUrl) throw new Error('Upload returned no file location');
        } catch (err) {
          setSubmitting(false);
          return showToast(
            err?.response?.data?.error || 'Could not upload the attachment. Remove it or try again — the application was not submitted.',
            'error',
          );
        }
      }

      const endDate = form.half_day ? form.start_date : form.end_date;
      // The server counts the days, LOP and clubbing itself; these are only
      // the preview's figures.
      const res = await api.post('/leaves/apply', {
        employee_id:      targetId,
        leave_type_id:    selectedType?.id || form.leave_type_id || undefined,
        leave_type:       selectedType?.key || effectiveLeaveType,
        start_date:       form.start_date,
        end_date:         endDate,
        number_of_days:   days,
        lop_days:         lopDays,
        reason:           form.reason.trim(),
        is_lop:           isLOP || !!selectedType?.isLOP,
        clubbing_flag:    clubbedLopDays > 0,
        half_day:         form.half_day,
        half_day_session: form.half_day ? form.half_day_session : null,
        attachment_url:   attachmentUrl,
      });
      const saved = res?.data || {};
      setSubmitted({
        type: selectedType?.key || effectiveLeaveType,
        from: form.start_date, to: endDate,
        days: Number(saved.number_of_days ?? days),
        lop:  Number(saved.lop_days ?? lopDays) || 0,
        half: form.half_day ? form.half_day_session : null,
        who:  onBehalf ? (employees.find(e => String(e.id) === String(form.employee_id))?.name || 'the employee') : null,
      });
      setForm(f => ({ ...f, start_date: today(), end_date: today(), reason: '', attachment_file: null, half_day: false }));
      if (fileRef.current) fileRef.current.value = '';
      loadBalance(targetId, Number(String(form.start_date).slice(0, 4)));
    } catch (err) {
      const data = err?.response?.data;
      const validationMsg = Array.isArray(data?.errors)
        ? data.errors.map(e => e?.message).filter(Boolean).join('; ')
        : '';
      const msg = validationMsg || data?.error || data?.message || 'Submission failed. Please try again.';
      // Put the server's reason next to the field it is about, too.
      const fieldOf = {
        LEAVE_CROSSES_YEAR: 'end_date', BACKDATED_NOT_ALLOWED: 'start_date', INSUFFICIENT_NOTICE: 'start_date',
        LEAVE_OVERLAP: 'start_date', NO_WORKING_DAYS: 'end_date', ATTACHMENT_REQUIRED: 'attachment',
        MEDICAL_CERT_REQUIRED: 'attachment', ATTACHMENT_INVALID: 'attachment', HALF_DAY_NOT_ALLOWED: 'leave_type',
        GENDER_RESTRICTED: 'leave_type', LEAVE_TYPE_NOT_AVAILABLE: 'leave_type', MAX_CONSECUTIVE_EXCEEDED: 'end_date',
        INSUFFICIENT_BALANCE: 'leave_type', PROBATION_RESTRICTED: 'leave_type', NOTICE_RESTRICTED: 'leave_type',
      }[data?.code];
      if (fieldOf) setFieldErrors(e => ({ ...e, [fieldOf]: msg }));
      showToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Approval route for this request: reporting manager (or HR when there is
  // none with a login) → department head when the type needs L2 → HR.
  const approvalSteps = probation.approver
    ? [`${probation.approver.name} (manager)`, ...(selectedType?.l2Required ? ['Department head'] : []), 'HR (final)']
    : selectedType?.l2Required
      ? ['HR (no reporting manager with a login)', 'Department head', 'HR (final)']
      : ['HR — both steps (no reporting manager with a login)'];

  const endShown = form.half_day ? form.start_date : form.end_date;
  const errStyle = (k) => (fieldErrors[k] ? { borderColor: '#ef4444' } : {});
  const FieldError = ({ k }) => (fieldErrors[k]
    ? <span className="al-field-error" role="alert" style={{ color: '#ef4444', fontSize: 11, marginTop: 4, display: 'block' }}>{fieldErrors[k]}</span>
    : null);

  return (
    <PageShell dock={
      <PageHero
        icon={CalendarDays}
        eyebrow="Leave"
        title="Apply for Leave"
        subtitle={isAdmin ? 'Submit a leave request for yourself or, as HR, for an employee' : 'Submit a leave request for approval'}
        actions={<>
          <button className="plh-cta" onClick={goMyLeaves}>My Leaves</button>
          <button className="plh-cta" title="Reload balances, types and holidays" aria-label="Reload" onClick={() => setReloadKey(k => k + 1)}>
            <RefreshCw size={14} />
          </button>
        </>}
      />
    }>
      {toast && <div className={`al-toast al-toast-${toast.type}`} role="status">{toast.msg}</div>}

      <div className="al-body">

        {/* Just sent */}
        {submitted && (
          <div className="al-policy-banner" style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#065f46', marginBottom: 16 }}>
            <CheckCircle size={16} />
            <div style={{ flex: 1 }}>
              <strong>Leave request sent{submitted.who ? ` for ${submitted.who}` : ''}</strong>
              <p>
                {submitted.type} · {submitted.from === submitted.to ? fmtDate(submitted.from) : `${fmtDate(submitted.from)} → ${fmtDate(submitted.to)}`}
                {submitted.half ? ` (half day, ${submitted.half})` : ''} · {submitted.days} day{submitted.days !== 1 ? 's' : ''}
                {submitted.lop > 0 && submitted.lop < submitted.days ? ` (${submitted.lop} LOP)` : ''}. It now waits for approval — follow it in My Leaves.
              </p>
            </div>
            <button className="al-btn-primary" style={{ alignSelf: 'center' }} onClick={goMyLeaves}>View in My Leaves</button>
            <button aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#065f46', alignSelf: 'flex-start' }} onClick={() => setSubmitted(null)}>
              <X size={14} />
            </button>
          </div>
        )}

        {/* Admin — Employee picker */}
        {isAdmin && (
          <div className="al-form-card" style={{ marginBottom: 16 }}>
            <div className="al-form-hd"><User size={15} /><span>Applying for</span></div>
            <div className="al-form-body">
              <div className="al-field">
                <label htmlFor="al-emp">Employee <span className="al-req">*</span></label>
                <select id="al-emp" value={form.employee_id} onChange={e => setF('employee_id', e.target.value)} style={errStyle('employee_id')}>
                  <option value="">Select employee…</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}{emp.office_id ? ` (${emp.office_id})` : ''}{String(emp.id) === String(uid) ? ' — me' : ''}
                      {emp.department ? ` — ${emp.department}` : ''}
                    </option>
                  ))}
                </select>
                <FieldError k="employee_id" />
                {onBehalf && <span style={{ color: '#6b7280', fontSize: 11, marginTop: 4, display: 'block' }}>As HR you may enter a past date (a leave already taken).</span>}
              </div>
            </div>
          </div>
        )}

        {/* Probation / Notice LOP Banner */}
        {isLOP && (
          <div className="al-policy-banner al-policy-lop">
            <AlertTriangle size={16} />
            <div>
              <strong>{inProbation ? (onBehalf ? 'This employee is in probation' : 'You are in your Probation Period') : (onBehalf ? 'This employee is serving notice' : 'Notice Period')} — Paid Leave Not Available</strong>
              <p>
                {inProbation
                  ? `Paid leave cannot be taken during probation${probation.probation_end
                      ? ` (ends ${fmtDate(probation.probation_end)}${probation.status_probation || employeeStatus === 'probation'
                          ? ' — paid leave opens once HR confirms the employment'
                          : '; leave starting after that date is paid as usual'})`
                      : ''}. This request is Loss of Pay (unpaid).`
                  : `All leave during the notice period is Loss of Pay (unpaid)${probation.last_working_date ? ` — last working day ${fmtDate(probation.last_working_date)}` : ''}.`}
              </p>
            </div>
          </div>
        )}

        {/* Leave Balance Cards */}
        <span className="al-section-label">
          Leave balances {balanceYear !== thisYear ? `for ${balanceYear} (the year this leave starts)` : balanceYear} — click a type to select it
        </span>
        <div className="al-balance-strip">
          {loading && <div style={{ padding: '20px', color: '#9ca3af', fontSize: 13 }}>Loading balances…</div>}
          {!loading && !targetId && <div style={{ padding: '20px', color: '#9ca3af', fontSize: 13 }}>{isAdmin ? 'Select an employee to see their balances.' : 'Your login is not linked to an employee record — contact HR.'}</div>}
          {!loading && targetId && applicableTypes.filter(t => !t.isLOP && (balances[t.key]?.allocated || 0) > 0).map(lt => {
            const b  = balances[lt.key];
            const total = b.allocated;
            const pct = total ? Math.min(100, Math.round(((b.used + b.pending + (b.encashed || 0)) / total) * 100)) : 0;
            const isSelected = form.leave_type === lt.key && !isLOP;
            const color = TYPE_COLOR[lt.key] || '#6366f1';
            return (
              <button key={lt.key} type="button" className={`al-bal-card${isSelected ? ' al-bal-card-active' : ''}`} disabled={isLOP}
                aria-pressed={isSelected} style={{ '--c': color }} onClick={() => pickType(lt.key)}>
                <div className="al-bal-info">
                  <span className="al-bal-label">{lt.key}</span>
                  <span className="al-bal-av" style={{ color: b.available <= 0 ? '#ef4444' : undefined }}>
                    {b.available} / {total} days left
                  </span>
                  {b.pending > 0 && <span className="al-bal-pending">{b.pending}d pending</span>}
                </div>
                <div className="al-bal-track">
                  <div className="al-bal-fill" style={{ width: `${pct}%`, background: pct >= 100 ? '#ef4444' : color }} />
                </div>
              </button>
            );
          })}
          {/* LOP / Unpaid — offered only when the company has a Loss of Pay type */}
          {!isLOP && targetId && lopType && (
            <button type="button" className={`al-bal-card${form.leave_type === lopType.key ? ' al-bal-card-active' : ''}`}
              aria-pressed={form.leave_type === lopType.key} style={{ '--c': '#9ca3af' }} onClick={() => pickType(lopType.key)}>
              <div className="al-bal-info">
                <span className="al-bal-label">{lopType.key}</span>
                <span className="al-bal-av">Unpaid</span>
              </div>
            </button>
          )}
        </div>

        {/* Application Form */}
        <div className="al-form-card">
          <div className="al-form-hd">
            <FileText size={15} />
            <span>Leave Application</span>
          </div>

          <div className="al-form-body">
            {/* Leave Type */}
            <div className="al-row2">
              <div className="al-field">
                <label htmlFor="al-type">Leave Type {isLOP && <span className="al-lop-tag">LOP enforced</span>}</label>
                <select id="al-type" value={isLOP ? (lopType?.key || LOP_NAME) : form.leave_type} disabled={isLOP || leaveTypesLoading}
                  style={errStyle('leave_type')}
                  onChange={e => { pickType(e.target.value); setFieldErrors(x => ({ ...x, leave_type: undefined })); }}>
                  {leaveTypesLoading
                    ? <option value="">Loading…</option>
                    : applicableTypes.length === 0
                      ? <option value="">No leave balance yet</option>
                      : applicableTypes.map(t => (
                        <option key={t.key} value={t.key}>
                          {t.key}{t.isLOP ? ' (unpaid)' : balances[t.key] ? ` — ${balances[t.key].available} left` : ''}
                        </option>
                      ))}
                  {isLOP && !lopType && <option value={LOP_NAME}>{LOP_NAME} (unpaid)</option>}
                </select>
                <FieldError k="leave_type" />
              </div>

              {/* Half Day toggle */}
              {selectedType?.allowHalfDay && (
                <div className="al-field">
                  <label>Half Day</label>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                    <label className="al-inline" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={form.half_day} onChange={e => setF('half_day', e.target.checked)} />
                      Apply for half day
                    </label>
                    {form.half_day && (
                      <select value={form.half_day_session} onChange={e => setF('half_day_session', e.target.value)} aria-label="Half day session"
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 12 }}>
                        <option value="AM">Morning (AM)</option>
                        <option value="PM">Afternoon (PM)</option>
                      </select>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Dates */}
            <div className="al-row2">
              <div className="al-field">
                <label htmlFor="al-from">{form.half_day ? 'Date' : 'From Date'} <span className="al-req">*</span></label>
                <input id="al-from" type="date" value={form.start_date} min={isAdmin ? undefined : today()}
                  style={errStyle('start_date')}
                  onChange={e => {
                    const v = e.target.value;
                    setForm(f => ({ ...f, start_date: v, end_date: !f.end_date || f.end_date < v ? v : f.end_date }));
                    setFieldErrors(e2 => ({ ...e2, start_date: undefined, end_date: undefined }));
                  }} />
                <FieldError k="start_date" />
              </div>
              {!form.half_day && (
                <div className="al-field">
                  <label htmlFor="al-to">To Date <span className="al-req">*</span></label>
                  <input id="al-to" type="date" value={form.end_date}
                    min={form.start_date} max={form.start_date ? `${form.start_date.slice(0, 4)}-12-31` : undefined}
                    style={errStyle('end_date')}
                    onChange={e => setF('end_date', e.target.value)} />
                  <FieldError k="end_date" />
                </div>
              )}
            </div>

            {/* Duration */}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14, padding:'8px 12px', background:'#f0f9ff', borderRadius:8, fontSize:13, flexWrap:'wrap' }}>
              <Clock size={14} color="#0369a1" />
              <strong style={{ color:'#0369a1' }}>{totalDays} day{totalDays !== 1 ? 's' : ''}</strong>
              {isLOP && workingDays > 0 && <span style={{ color:'#4c1d95', fontWeight:600 }}>· all Loss of Pay (unpaid)</span>}
              {!isLOP && selectedType?.isLOP && workingDays > 0 && <span style={{ color:'#4c1d95', fontWeight:600 }}>· unpaid</span>}
              {workingDays > 0 && offDays - clubbedLopDays > 0 && (
                <span style={{ color:'#6b7280' }}>({offDays - clubbedLopDays} weekly off / holiday day{offDays - clubbedLopDays !== 1 ? 's' : ''} at the edges not counted)</span>
              )}
              {workingDays === 0 && form.start_date && (
                <span style={{ color:'#6d28d9', fontWeight:500 }}>⚠ No working days — the dates fall on weekly offs or holidays</span>
              )}
              {overBalance && workingDays > 0 && (
                <span style={{ color:'#ef4444', fontWeight:600 }}>⚠ Only {bal.available} day{bal.available !== 1 ? 's' : ''} left</span>
              )}
              {overConsecutive && (
                <span style={{ color:'#ef4444', fontWeight:600 }}>⚠ {selectedType.key} allows at most {selectedType.maxConsecutive} day(s) at a time</span>
              )}
            </div>
            {holidaysInRange.length > 0 && (
              <div style={{ color:'#6b7280', fontSize:12, margin:'-8px 0 12px' }}>
                Holiday{holidaysInRange.length > 1 ? 's' : ''} in these dates: {holidaysInRange.map(h => `${h.name || h.holiday_name || 'Holiday'} (${fmtDate(h.date)})`).join(', ')}
              </div>
            )}

            {/* Warnings */}
            {!isLOP && clubbedLopDays > 0 && (
              <div className="al-clubbing-warn" style={{ background:'#fff7ed', borderColor:'#ddd6fe', color:'#4c1d95' }}>
                <AlertTriangle size={14} />
                <span>
                  Clubbing — {clubbedLopDays} weekly off / holiday day{clubbedLopDays !== 1 ? 's' : ''} inside your leave: {days} paid + {clubbedLopDays} Loss of Pay. Clubbing needs your manager's approval; if approved, {clubbedLopDays === 1 ? 'that day is' : 'those days are'} charged as LOP automatically.
                </span>
              </div>
            )}
            {advanceWarn && (
              <div className="al-clubbing-warn" style={{ background:'#fff7ed', borderColor:'#ddd6fe', color:'#4c1d95' }}>
                <AlertTriangle size={14} /><span>{advanceWarn}</span>
              </div>
            )}
            {!isLOP && (selectedType?.requiresAttachment || selectedType?.medicalCertDays > 0) && (
              <div className="al-policy-banner" style={{ background:'#f5f3ff', borderColor:'#ddd6fe', color:'#4c1d95', padding:'10px 14px', borderRadius:8, display:'flex', gap:8, alignItems:'flex-start', marginBottom:12, fontSize:13 }}>
                <Info size={14} style={{ flexShrink:0, marginTop:1 }} />
                <span>
                  {selectedType.requiresAttachment
                    ? `${selectedType.key} needs a supporting document (upload below).`
                    : `More than ${selectedType.medicalCertDays} day(s) of ${selectedType.key} needs a medical certificate${needsAttachment ? ' — this request does, upload it below' : ''}.`}
                </span>
              </div>
            )}

            {/* Reason */}
            <div className="al-field">
              <label htmlFor="al-reason">Reason <span className="al-req">*</span></label>
              <textarea id="al-reason" rows={3} value={form.reason} maxLength={1000}
                onChange={e => setF('reason', e.target.value)}
                placeholder="Briefly describe the reason for your leave…"
                style={errStyle('reason')} />
              <FieldError k="reason" />
            </div>

            {/* Attachment */}
            <div className="al-field">
              <label>
                Attachment {needsAttachment
                  ? <span className="al-req">*</span>
                  : <span style={{ color:'#9ca3af', fontWeight:400, fontSize:11 }}> (optional)</span>}
              </label>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <label className="al-inline" style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', background:'#f9fafb', border:`1px solid ${fieldErrors.attachment ? '#ef4444' : '#e5e7eb'}`, borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:500 }}>
                  <Upload size={14} />
                  {form.attachment_file ? form.attachment_file.name : 'Choose file…'}
                  <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    style={{ display:'none' }} onChange={handleFileChange} />
                </label>
                {form.attachment_file && (
                  <button type="button" aria-label="Remove attachment" style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }} onClick={clearFile}>
                    <X size={14} />
                  </button>
                )}
              </div>
              <span style={{ color:'#9ca3af', fontSize:11, marginTop:4, display:'block' }}>PDF, JPG, PNG, DOC — max 5 MB</span>
              <FieldError k="attachment" />
            </div>

            {/* Approval route */}
            {targetId && (
              <div style={{ display:'flex', alignItems:'center', gap:8, color:'#4b5563', fontSize:12, marginTop:4, flexWrap:'wrap' }}>
                <GitBranch size={13} />
                <span>Goes to: {approvalSteps.join(' → ')}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="al-form-ft">
            <div className="al-summary">
              <Calendar size={13} />
              <span>{form.start_date === endShown ? fmtDate(form.start_date) : `${fmtDate(form.start_date)} → ${fmtDate(endShown)}`}</span>
              <strong>· {isLOP ? (lopType?.key || LOP_NAME) : effectiveLeaveType}</strong>
              {form.half_day && <span className="al-lop-tag">Half {form.half_day_session}</span>}
              {isLOP && <span className="al-lop-tag">LOP</span>}
              {!isLOP && clubbedLopDays > 0 && <span className="al-lop-tag">+{clubbedLopDays}d LOP</span>}
            </div>
            <button className="al-btn-primary" onClick={handleSubmit} disabled={submitting}>
              <Send size={14} />
              {submitting ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </div>

      </div>
    </PageShell>
  );
}
