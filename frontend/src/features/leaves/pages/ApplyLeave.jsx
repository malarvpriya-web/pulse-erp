import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Calendar, Clock, FileText, CheckCircle, AlertTriangle,
  X, RefreshCw, Send, Info, Upload, User
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './ApplyLeave.css';

const ADMIN_ROLES = new Set(['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'hr_admin']);

function detectClubbingWarning(start, end) {
  if (!start || !end) return null;
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end   + 'T00:00:00');
  const DAY = 86400000;
  const dayBefore = new Date(s.getTime() - DAY);
  const dayAfter  = new Date(e.getTime() + DAY);
  const prevIsWeekend = dayBefore.getDay() === 0 || dayBefore.getDay() === 6;
  const nextIsWeekend = dayAfter.getDay()  === 0 || dayAfter.getDay()  === 6;
  if (s.getDay() === 1 && prevIsWeekend)
    return 'Leave starts Monday, adjacent to weekend. Clubbing policy may apply — manager pre-approval required.';
  if (e.getDay() === 5 && nextIsWeekend)
    return 'Leave ends Friday, adjacent to weekend. Clubbing policy may apply — manager pre-approval required.';
  if (prevIsWeekend && nextIsWeekend)
    return 'Leave sandwiches a weekend. Clubbing policy applies — manager approval required.';
  return null;
}

function getEmployeeStatus(user) {
  const s = (user?.employment_status || user?.status || user?.employee_status || '').toLowerCase();
  if (s === 'probation' || s === 'probationary') return 'probation';
  if (s === 'notice' || s === 'notice_period' || s === 'serving_notice') return 'notice';
  return null;
}

// Break a leave range into paid working days and "clubbed" LOP days.
//   workingDays    → weekdays that aren't holidays (deducted from paid balance)
//   clubbedLopDays → weekend/holiday days SANDWICHED between the first and last
//                    working leave day. These only exist when the employee
//                    bridges a weekend/holiday (clubbing) and are auto-charged
//                    as Loss of Pay.
// Leading/trailing weekends (e.g. a single Friday) are never charged — clubbing
// only materialises when a non-working day sits between two working leave days.
function calcBreakdown(start, end, holidays = []) {
  if (!start || !end) return { workingDays: 0, clubbedLopDays: 0 };
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end   + 'T00:00:00');
  if (e < s) return { workingDays: 0, clubbedLopDays: 0 };
  const holidaySet = new Set(holidays.map(h => String(h.date || '').slice(0, 10)));
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const isWorking = (d) => {
    const dow = d.getDay();
    return dow !== 0 && dow !== 6 && !holidaySet.has(fmt(d));
  };
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
  return { workingDays, clubbedLopDays };
}

const today = () => new Date().toISOString().slice(0, 10);

const ADVANCE_NOTICE_EXEMPT = new Set(['sick leave', 'medical leave', 'emergency leave', 'bereavement leave']);

export default function ApplyLeave({ setPage }) {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the admin surface from anyone holding hr as a
  // secondary role. See AuthContext.
  const { user, hasAnyRole } = useAuth();
  const isAdmin = hasAnyRole(...ADMIN_ROLES);
  const uid = user?.employee_id;

  const [balances,         setBalances]         = useState({});
  const [leaveTypes,       setLeaveTypes]       = useState([]);
  const [leaveTypesLoading,setLeaveTypesLoading]= useState(true);
  const [employees,        setEmployees]        = useState([]);
  const [holidays,    setHolidays]    = useState([]);
  const [probation,   setProbation]   = useState({ in_probation: false, probation_end: null });
  const [loading,     setLoading]     = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [toast,       setToast]       = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [advanceWarn, setAdvanceWarn] = useState(null);
  const fileRef = useRef(null);

  const [form, setForm] = useState({
    employee_id:   uid || '',
    leave_type:    '',
    leave_type_id: '',
    start_date:    today(),
    end_date:      today(),
    reason:        '',
    half_day:      false,
    half_day_session: 'AM',
    attachment_url: '',
    attachment_file: null,
  });

  // Probation is authoritative from the backend (joining_date / probation_end_date);
  // fall back to any status string carried on the auth user for the notice period.
  const employeeStatus = useMemo(() => getEmployeeStatus(user), [user]);
  const inProbation = probation.in_probation || employeeStatus === 'probation';
  const isLOP = inProbation || employeeStatus === 'notice';
  const effectiveLeaveType = isLOP ? 'Loss of Pay' : form.leave_type;

  const selectedType = leaveTypes.find(t => t.key === effectiveLeaveType);
  const bal = balances[effectiveLeaveType] || { used: 0, pending: 0, available: 0 };

  const { workingDays, clubbedLopDays } = useMemo(
    () => form.half_day ? { workingDays: 0.5, clubbedLopDays: 0 } : calcBreakdown(form.start_date, form.end_date, holidays),
    [form.start_date, form.end_date, form.half_day, holidays]
  );

  // During probation the whole request is LOP; otherwise only the sandwiched
  // (clubbed) weekend/holiday days are LOP and working days are paid.
  const lopDays = isLOP ? workingDays : clubbedLopDays;
  const paidDays = isLOP ? 0 : workingDays;
  const days = workingDays;  // count against the selected leave type / balance
  const totalDays = isLOP ? workingDays : workingDays + clubbedLopDays;

  const clubbingWarning = useMemo(
    () => detectClubbingWarning(form.start_date, form.end_date),
    [form.start_date, form.end_date]
  );

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadBalance = useCallback(async (empId) => {
    if (!empId) return;
    setLoading(true);
    try {
      const res = await api.get(`/leaves/balance/${empId}`);
      const arr = Array.isArray(res.data) ? res.data : (res.data?.balances || []);
      const obj = {};
      arr.forEach(b => {
        obj[b.leave_name] = {
          used:      Number(b.used_days)      || 0,
          pending:   Number(b.pending_days)   || 0,
          available: Number(b.available_days) || 0,
          allocated: Number(b.allocated_days) || 0,
        };
      });
      setBalances(obj);
    } catch {
      setBalances({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBalance(isAdmin ? form.employee_id : uid); }, [uid, isAdmin, form.employee_id, loadBalance]);

  useEffect(() => {
    setLeaveTypesLoading(true);
    api.get('/leaves/types', { params: { applicable: 1 } })
      .then(res => {
        const raw = Array.isArray(res.data) ? res.data : [];
        setLeaveTypes(raw.map(t => ({
          id:           t.id,
          key:          t.leave_name,
          total:        t.default_days ?? 0,
          allowHalfDay: t.allow_half_day ?? true,
          requiresAttachment: t.requires_attachment ?? false,
          requiresMedicalCert: t.requires_medical_cert_days > 0,
          medicalCertDays: t.requires_medical_cert_days || 0,
          minNoticeDays: t.min_notice_days || 0,
          maxConsecutive: t.max_consecutive_days || null,
          isLOP:        t.is_lop_type ?? false,
          isPaid:       t.is_paid ?? true,
          allowNegative: t.allow_negative_balance ?? false,
          sandwichRule: t.sandwich_rule ?? false,
        })));
        if (!form.leave_type && raw.length) setForm(f => ({ ...f, leave_type: raw[0].leave_name, leave_type_id: raw[0].id }));
      })
      .catch(() => { setLeaveTypes([]); })
      .finally(() => setLeaveTypesLoading(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch holidays for current year to exclude from day count
  useEffect(() => {
    api.get('/holidays', { params: { year: new Date().getFullYear() } })
      .then(res => setHolidays(Array.isArray(res.data) ? res.data : []))
      .catch(() => {});
  }, []);

  // Fetch probation status for the target employee (self, or the picked
  // employee when HR/Admin applies on behalf). Drives the LOP-only lockdown.
  useEffect(() => {
    const targetId = isAdmin ? form.employee_id : uid;
    if (!targetId) { setProbation({ in_probation: false, probation_end: null }); return; }
    api.get('/leaves/probation-status', { params: { employee_id: targetId } })
      .then(res => setProbation(res.data || { in_probation: false, probation_end: null }))
      .catch(() => setProbation({ in_probation: false, probation_end: null }));
  }, [isAdmin, form.employee_id, uid]);

  // Fetch employees list for admin employee picker
  useEffect(() => {
    if (!isAdmin) return;
    api.get('/employees')
      .then(res => setEmployees((Array.isArray(res.data) ? res.data : []).filter(e => !['left','terminated'].includes((e.status||'').toLowerCase()))))
      .catch(() => {});
  }, [isAdmin]);

  // Advance notice check
  useEffect(() => {
    if (!selectedType || !form.start_date) { setAdvanceWarn(null); return; }
    const exempt = ADVANCE_NOTICE_EXEMPT.has(effectiveLeaveType.toLowerCase());
    if (exempt || selectedType.minNoticeDays === 0) { setAdvanceWarn(null); return; }
    const startDate = new Date(form.start_date + 'T00:00:00');
    const todayDate = new Date(); todayDate.setHours(0,0,0,0);
    const noticeDays = Math.ceil((startDate - todayDate) / 86400000);
    setAdvanceWarn(noticeDays < selectedType.minNoticeDays
      ? `This leave type requires ${selectedType.minNoticeDays} day(s) advance notice. You have given ${noticeDays} day(s).`
      : null);
  }, [form.start_date, selectedType, effectiveLeaveType]);

  const setF = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    if (fieldErrors[k]) setFieldErrors(e => ({ ...e, [k]: undefined }));
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('File must be under 5 MB', 'error'); return; }
    setForm(f => ({ ...f, attachment_file: file, attachment_url: file.name }));
  };

  const handleSubmit = async () => {
    const errs = {};
    if (isAdmin && !form.employee_id) errs.employee_id = 'Select an employee';
    if (!form.start_date) errs.start_date = 'Start date is required';
    if (!form.end_date)   errs.end_date   = 'End date is required';
    if (form.end_date && form.start_date && form.end_date < form.start_date)
      errs.end_date = 'End date must be on or after start date';
    if (!form.reason.trim()) errs.reason = 'Reason is required';
    if (selectedType?.requiresAttachment && !form.attachment_file && !form.attachment_url)
      errs.attachment = 'An attachment is required for this leave type';

    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      // Surface a fixed-position toast too — inline errors can be scrolled out of
      // view (e.g. the admin employee picker sits above the Submit button), which
      // makes the click look like it did nothing.
      const firstMsg = errs.employee_id || errs.start_date || errs.end_date || errs.reason || errs.attachment;
      showToast(firstMsg || 'Please fix the highlighted fields before submitting.', 'error');
      return;
    }
    setFieldErrors({});

    // Client-side balance check (backend will also validate)
    if (!selectedType?.allowNegative && !selectedType?.isLOP && selectedType?.total > 0) {
      if (days > bal.available) {
        return showToast(`Only ${bal.available} day(s) available for ${effectiveLeaveType}`, 'error');
      }
    }

    setSubmitting(true);
    try {
      let attachmentUrl = form.attachment_url || null;

      // Upload file if present
      if (form.attachment_file) {
        try {
          const fd = new FormData();
          fd.append('file', form.attachment_file);
          const uploadRes = await api.post('/documents/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
          attachmentUrl = uploadRes.data?.url || uploadRes.data?.file_url || form.attachment_file.name;
        } catch {
          attachmentUrl = form.attachment_file.name; // fallback — store filename
        }
      }

      const empId = isAdmin ? form.employee_id : uid;
      await api.post('/leaves/apply', {
        employee_id:      empId,
        leave_type_id:    selectedType?.id || form.leave_type_id || undefined,
        leave_type:       effectiveLeaveType,
        start_date:       form.start_date,
        end_date:         form.half_day ? form.start_date : form.end_date,
        number_of_days:   days,
        lop_days:         lopDays,
        reason:           form.reason.trim(),
        is_lop:           isLOP || selectedType?.isLOP,
        clubbing_flag:    clubbedLopDays > 0 || !!clubbingWarning,
        half_day:         form.half_day,
        half_day_session: form.half_day ? form.half_day_session : null,
        attachment_url:   attachmentUrl,
      });
      showToast('Leave application submitted successfully!');
      setForm(f => ({ ...f, start_date: today(), end_date: today(), reason: '', attachment_url: '', attachment_file: null, half_day: false }));
      if (fileRef.current) fileRef.current.value = '';
      loadBalance(empId);
    } catch (err) {
      const data = err?.response?.data;
      showToast(data?.error || data?.message || 'Submission failed. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="al-root">
      {toast && <div className={`al-toast al-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="al-header">
        <div>
          <h2 className="al-title">Apply for Leave</h2>
          <p className="al-sub">Submit a leave request for manager approval</p>
        </div>
        <button className="al-icon-btn" onClick={() => loadBalance(isAdmin ? form.employee_id : uid)}>
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="al-body">

        {/* Admin — Employee picker */}
        {isAdmin && (
          <div className="al-form-card" style={{ marginBottom: 16 }}>
            <div className="al-form-hd"><User size={15} /><span>Applying on behalf of</span></div>
            <div className="al-form-body">
              <div className="al-field">
                <label>Employee <span className="al-req">*</span></label>
                <select
                  value={form.employee_id}
                  onChange={e => { setF('employee_id', e.target.value); loadBalance(e.target.value); }}
                  style={fieldErrors.employee_id ? { borderColor: '#ef4444' } : {}}
                >
                  <option value="">Select employee…</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim()}
                      {emp.department ? ` — ${emp.department}` : ''}
                    </option>
                  ))}
                </select>
                {fieldErrors.employee_id && <span className="al-field-error" role="alert" style={{ color: '#ef4444', fontSize: 11 }}>{fieldErrors.employee_id}</span>}
              </div>
            </div>
          </div>
        )}

        {/* Probation / Notice LOP Banner */}
        {isLOP && (
          <div className="al-policy-banner al-policy-lop">
            <AlertTriangle size={16} />
            <div>
              <strong>{inProbation ? 'You are in your Probation Period' : 'Notice Period'} — Paid Leave Not Available</strong>
              <p>
                {inProbation
                  ? `Paid leave cannot be applied during probation${probation.probation_end ? ` (ends ${new Date(probation.probation_end + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })})` : ''}. Only Loss of Pay (unpaid) leave is available and will be charged as LOP.`
                  : 'All leave during your notice period is automatically Loss of Pay (unpaid).'}
              </p>
            </div>
          </div>
        )}

        {/* Leave Balance Cards */}
        <span className="al-section-label">Leave Balances — click a type to select it</span>
        <div className="al-balance-strip">
          {loading && <div style={{ padding: '20px', color: '#9ca3af', fontSize: 13 }}>Loading balances…</div>}
          {!loading && leaveTypes.filter(t => t.total > 0).map(lt => {
            const b  = balances[lt.key] || { used: 0, pending: 0, available: 0, allocated: lt.total };
            const pct = lt.total ? Math.min(100, Math.round(((b.used + b.pending) / lt.total) * 100)) : 0;
            const isSelected = form.leave_type === lt.key && !isLOP;
            const colorMap = { 'Sick Leave':'#ef4444','Casual Leave':'#f59e0b','Earned Leave':'#10b981','Annual Leave':'#10b981','Maternity Leave':'#ec4899','Paternity Leave':'#6366f1','Compensatory Leave':'#8b5cf6','Bereavement Leave':'#6b7280','Marriage Leave':'#f97316' };
            const color = colorMap[lt.key] || '#6366f1';
            return (
              <button key={lt.key} className={`al-bal-card${isSelected ? ' al-bal-card-active' : ''}`}
                style={{ '--c': color }} onClick={() => { if (!isLOP) { setF('leave_type', lt.key); setF('leave_type_id', lt.id); } }}>
                <div className="al-bal-info">
                  <span className="al-bal-label">{lt.key}</span>
                  <span className="al-bal-av" style={{ color: b.available === 0 ? '#ef4444' : undefined }}>
                    {b.available} / {lt.total} days
                  </span>
                  {b.pending > 0 && <span className="al-bal-pending">{b.pending}d pending</span>}
                </div>
                <div className="al-bal-track">
                  <div className="al-bal-fill" style={{ width: `${pct}%`, background: pct >= 100 ? '#ef4444' : color }} />
                </div>
              </button>
            );
          })}
          {/* LOP / Unpaid */}
          {!isLOP && (
            <button className={`al-bal-card${form.leave_type === 'Loss of Pay' ? ' al-bal-card-active' : ''}`}
              style={{ '--c': '#9ca3af' }} onClick={() => {
                const lopType = leaveTypes.find(t => /loss.of.pay/i.test(t.key));
                setF('leave_type', 'Loss of Pay');
                setF('leave_type_id', lopType?.id || '');
              }}>
              <div className="al-bal-info">
                <span className="al-bal-label">Loss of Pay</span>
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
                <label>Leave Type {isLOP && <span className="al-lop-tag">LOP enforced</span>}</label>
                <select value={effectiveLeaveType} disabled={isLOP}
                  onChange={e => {
                    const found = leaveTypes.find(t => t.key === e.target.value);
                    setF('leave_type', e.target.value);
                    setF('leave_type_id', found?.id || '');
                  }}>
                  {leaveTypesLoading
                    ? <option value="">Loading…</option>
                    : leaveTypes.length === 0
                      ? <option value="">No leave types available</option>
                      : leaveTypes.map(t => <option key={t.key} value={t.key}>{t.key}</option>)}
                  <option value="Loss of Pay">Loss of Pay (Unpaid)</option>
                </select>
              </div>

              {/* Half Day toggle */}
              {selectedType?.allowHalfDay && (
                <div className="al-field">
                  <label>Half Day</label>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                      <input type="checkbox" checked={form.half_day} onChange={e => setF('half_day', e.target.checked)} />
                      Apply for half day
                    </label>
                    {form.half_day && (
                      <select value={form.half_day_session} onChange={e => setF('half_day_session', e.target.value)}
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
                <label>From Date <span className="al-req">*</span></label>
                <input type="date" value={form.start_date} min={isAdmin ? undefined : today()}
                  style={fieldErrors.start_date ? { borderColor: '#ef4444' } : {}}
                  onChange={e => {
                    const v = e.target.value;
                    setForm(f => ({ ...f, start_date: v, end_date: f.end_date < v ? v : f.end_date }));
                    setFieldErrors(e2 => ({ ...e2, start_date: undefined }));
                  }} />
                {fieldErrors.start_date && <span className="al-field-error" role="alert" style={{ color:'#ef4444', fontSize:11 }}>{fieldErrors.start_date}</span>}
              </div>
              <div className="al-field">
                <label>To Date {!form.half_day && <span className="al-req">*</span>}</label>
                <input type="date" value={form.half_day ? form.start_date : form.end_date}
                  min={form.start_date} disabled={form.half_day}
                  style={fieldErrors.end_date ? { borderColor: '#ef4444' } : {}}
                  onChange={e => setF('end_date', e.target.value)} />
                {fieldErrors.end_date && <span className="al-field-error" role="alert" style={{ color:'#ef4444', fontSize:11 }}>{fieldErrors.end_date}</span>}
              </div>
            </div>

            {/* Duration display */}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14, padding:'8px 12px', background:'#f0f9ff', borderRadius:8, fontSize:13, flexWrap:'wrap' }}>
              <Clock size={14} color="#0369a1" />
              <strong style={{ color:'#0369a1' }}>{totalDays} day{totalDays !== 1 ? 's' : ''}</strong>
              {isLOP && workingDays > 0 && (
                <span style={{ color:'#9a3412', fontWeight:600 }}>· all Loss of Pay (unpaid)</span>
              )}
              {!isLOP && clubbedLopDays > 0 && (
                <span style={{ color:'#9a3412', fontWeight:600 }}>
                  · {paidDays} paid + {clubbedLopDays} LOP (clubbed weekend/holiday)
                </span>
              )}
              {!isLOP && clubbedLopDays === 0 && holidays.length > 0 && workingDays > 0 && (
                <span style={{ color:'#6b7280' }}>(weekdays only, holidays excluded)</span>
              )}
              {!form.half_day && workingDays === 0 && form.start_date && (
                <span style={{ color:'#b45309', fontWeight:500 }}>⚠ No working days — selected dates fall on weekends or holidays</span>
              )}
              {bal.available > 0 && !selectedType?.isLOP && days > bal.available && (
                <span style={{ color:'#ef4444', fontWeight:600 }}>⚠ Exceeds available {bal.available}d</span>
              )}
            </div>

            {/* Warnings */}
            {!isLOP && clubbedLopDays > 0 && (
              <div className="al-clubbing-warn" style={{ background:'#fff7ed', borderColor:'#fed7aa', color:'#9a3412' }}>
                <AlertTriangle size={14} />
                <span>
                  Clubbing detected — {clubbedLopDays} weekend/holiday day{clubbedLopDays !== 1 ? 's' : ''} between your leave dates. Clubbing is not allowed without manager permission; if approved, {clubbedLopDays === 1 ? 'this day' : 'these days'} will be charged as Loss of Pay (LOP) automatically.
                </span>
              </div>
            )}
            {clubbingWarning && clubbedLopDays === 0 && (
              <div className="al-clubbing-warn">
                <Info size={14} /><span>{clubbingWarning} Clubbing is not allowed without manager permission — clubbed days become Loss of Pay.</span>
              </div>
            )}
            {advanceWarn && (
              <div className="al-clubbing-warn" style={{ background:'#fff7ed', borderColor:'#fed7aa', color:'#9a3412' }}>
                <AlertTriangle size={14} /><span>{advanceWarn}</span>
              </div>
            )}
            {selectedType?.requiresMedicalCert && (
              <div className="al-policy-banner" style={{ background:'#eff6ff', borderColor:'#bfdbfe', color:'#1e40af', padding:'10px 14px', borderRadius:8, display:'flex', gap:8, alignItems:'flex-start', marginBottom:12, fontSize:13 }}>
                <Info size={14} style={{ flexShrink:0, marginTop:1 }} />
                <span>Sick leave exceeding {selectedType.medicalCertDays} day(s) requires a medical certificate (upload below).</span>
              </div>
            )}

            {/* Reason */}
            <div className="al-field">
              <label>Reason <span className="al-req">*</span></label>
              <textarea rows={3} value={form.reason}
                onChange={e => setF('reason', e.target.value)}
                placeholder="Briefly describe the reason for your leave…"
                style={fieldErrors.reason ? { borderColor:'#ef4444' } : {}} />
              {fieldErrors.reason && (
                <span className="al-field-error" role="alert" style={{ color:'#ef4444', fontSize:12, marginTop:4, display:'flex', alignItems:'center', gap:4 }}>
                  ⚠ {fieldErrors.reason}
                </span>
              )}
            </div>

            {/* Attachment */}
            <div className="al-field">
              <label>
                Attachment {selectedType?.requiresAttachment && <span className="al-req">*</span>}
                {!selectedType?.requiresAttachment && <span style={{ color:'#9ca3af', fontWeight:400, fontSize:11 }}> (optional)</span>}
              </label>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <label style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', background:'#f9fafb', border:'1px solid #e5e7eb', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:500 }}>
                  <Upload size={14} />
                  {form.attachment_file ? form.attachment_file.name : 'Choose file…'}
                  <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    style={{ display:'none' }} onChange={handleFileChange} />
                </label>
                {form.attachment_file && (
                  <button style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}
                    onClick={() => { setForm(f=>({...f,attachment_file:null,attachment_url:''})); if(fileRef.current) fileRef.current.value=''; }}>
                    <X size={14} />
                  </button>
                )}
              </div>
              {fieldErrors.attachment && <span className="al-field-error" role="alert" style={{ color:'#ef4444', fontSize:11 }}>{fieldErrors.attachment}</span>}
              <span style={{ color:'#9ca3af', fontSize:11, marginTop:4, display:'block' }}>PDF, JPG, PNG, DOC — max 5 MB</span>
            </div>
          </div>

          {/* Footer */}
          <div className="al-form-ft">
            <div className="al-summary">
              <Calendar size={13} />
              <span>
                {form.start_date === (form.half_day ? form.start_date : form.end_date)
                  ? new Date(form.start_date+'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                  : `${new Date(form.start_date+'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })} → ${new Date(form.end_date+'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}`}
              </span>
              <strong>· {effectiveLeaveType}</strong>
              {form.half_day && <span className="al-lop-tag">Half {form.half_day_session}</span>}
              {isLOP && <span className="al-lop-tag">LOP</span>}
              {!isLOP && clubbedLopDays > 0 && <span className="al-lop-tag">+{clubbedLopDays}d LOP</span>}
              {(clubbingWarning || clubbedLopDays > 0) && <span className="al-clubbing-flag"><AlertTriangle size={11} /> Clubbing</span>}
            </div>
            <button className="al-btn-primary" onClick={handleSubmit}
              disabled={submitting}>
              <Send size={14} />
              {submitting ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
