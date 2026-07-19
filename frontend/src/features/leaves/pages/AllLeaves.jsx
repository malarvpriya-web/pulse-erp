import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Calendar, Plus, X, CheckCircle, XCircle, Clock,
  ChevronRight, Search, Filter, AlertCircle, Users,
  Umbrella, RefreshCw, Lock
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import WorkflowBadge from '@/features/_shared/WorkflowBadge';
import './AllLeaves.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getWeekDates() {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return days.map((name, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return { name, date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) };
  });
}

function countWeekdays(from, to) {
  if (!from || !to) return 0;
  const start = new Date(from);
  const end   = new Date(to);
  if (end < start) return 0;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function formatDate(str) {
  if (!str) return '-';
  return new Date(str).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

/** Extracts a user-friendly list of error strings from an Axios error response. */
function parseApiErrors(err) {
  const data = err?.response?.data;
  if (!data) return ['Something went wrong. Please try again.'];
  // Field-level validation errors array: [{ field, message }]
  if (Array.isArray(data.details))  return data.details.map(d => d.message || String(d));
  if (Array.isArray(data.errors))   return data.errors.map(e => e.message || String(e));
  // Single message string
  if (typeof data.error   === 'string') return [data.error];
  if (typeof data.message === 'string') return [data.message];
  return ['Something went wrong. Please try again.'];
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 3500);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className={`al-toast ${toast.type === 'success' ? 'al-toast-success' : 'al-toast-error'}`}>
      {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
      <span>{toast.message}</span>
      <button className="al-icon-btn" style={{ marginLeft: 8 }} onClick={onDismiss}><X size={13} /></button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation error block — shown inside forms
// ---------------------------------------------------------------------------
function ValidationErrors({ errors }) {
  if (!errors || errors.length === 0) return null;
  return (
    <div style={{
      background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
      padding: '10px 14px', marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: errors.length > 1 ? 6 : 0, color: '#b91c1c', fontWeight: 600, fontSize: 13 }}>
        <AlertCircle size={14} /> Please fix the following:
      </div>
      {errors.length > 1 && (
        <ul style={{ margin: 0, paddingLeft: 18, color: '#991b1b', fontSize: 12, lineHeight: 1.7 }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {errors.length === 1 && (
        <p style={{ margin: 0, color: '#991b1b', fontSize: 12 }}>{errors[0]}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leave Balance Card — fully dynamic, driven by live API data
// ---------------------------------------------------------------------------
// Palette cycles for types we don't have a specific colour for
const PALETTE = [
  { color: '#6366f1', bg: '#eef2ff' }, { color: '#ef4444', bg: '#fef2f2' },
  { color: '#10b981', bg: '#ecfdf5' }, { color: '#f59e0b', bg: '#fffbeb' },
  { color: '#8b5cf6', bg: '#f5f3ff' }, { color: '#0891b2', bg: '#e0f2fe' },
  { color: '#d97706', bg: '#fefce8' }, { color: '#dc2626', bg: '#fef2f2' },
];

function BalanceCard({ leaveType, index }) {
  const used      = Number(leaveType.used_days)      || 0;
  const pending   = Number(leaveType.pending_days)   || 0;
  const total     = Number(leaveType.allocated_days) || 0;
  const available = Math.max(0, total - used - pending);
  const pct       = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const { color, bg } = PALETTE[index % PALETTE.length];
  return (
    <div className="al-balance-card">
      <div className="al-bal-header">
        <div className="al-bal-icon" style={{ background: bg }}>
          <Umbrella size={18} color={color} />
        </div>
        <span className="al-bal-type" title={leaveType.leave_name}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>
          {leaveType.leave_name}
        </span>
      </div>
      <div className="al-bal-used">{used}{pending > 0 ? <span style={{ color: '#f59e0b', fontSize: 11 }}> +{pending}p</span> : null} <span className="al-bal-total">/ {total} days</span></div>
      <div className="al-bal-bar-wrap">
        <div className="al-bal-bar" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="al-bal-remaining">Available: <strong style={{ color }}>{available}</strong> days</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply Leave Drawer — with field-level validation error display
// ---------------------------------------------------------------------------
function ApplyDrawer({ open, onClose, onSuccess }) {
  const [form, setForm] = useState({
    leave_type: '', from_date: '', to_date: '', reason: '', emergency_contact: '',
  });
  const [submitting,       setSubmitting]       = useState(false);
  const [formErrors,       setFormErrors]       = useState([]);
  const [leaveTypes,       setLeaveTypes]       = useState([]);
  const [leaveTypesLoading,setLeaveTypesLoading]= useState(true);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    setLeaveTypesLoading(true);
    api.get('/leaves/types', { params: { applicable: 1 } })
      .then(r => {
        const raw = Array.isArray(r.data) ? r.data : [];
        if (!isMounted.current) return;
        setLeaveTypes(raw);
        if (raw.length) setForm(f => ({ ...f, leave_type: f.leave_type || raw[0].leave_name }));
      })
      .catch(() => { if (isMounted.current) setLeaveTypes([]); })
      .finally(() => { if (isMounted.current) setLeaveTypesLoading(false); });
  }, []);

  const days = countWeekdays(form.from_date, form.to_date);

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    // Clear errors as user types
    if (formErrors.length) setFormErrors([]);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Client-side guard
    if (!form.from_date) {
      setFormErrors(['From Date is required.']);
      return;
    }
    if (!form.to_date) {
      setFormErrors(['To Date is required.']);
      return;
    }
    if (form.to_date < form.from_date) {
      setFormErrors(['To Date must be on or after From Date.']);
      return;
    }
    if (!form.reason.trim()) {
      setFormErrors(['Reason is required.']);
      return;
    }
    setSubmitting(true);
    setFormErrors([]);
    try {
      await api.post('/leaves/apply', { ...form, days });
      if (!isMounted.current) return;
      onSuccess({ type: 'success', message: 'Leave application submitted successfully!' });
      onClose();
      setForm({ leave_type: leaveTypes[0]?.leave_name || '', from_date: '', to_date: '', reason: '', emergency_contact: '' });
    } catch (err) {
      if (!isMounted.current) return;
      setFormErrors(parseApiErrors(err));
    } finally {
      if (isMounted.current) setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="al-overlay" onClick={onClose} />
      <div className="al-drawer">
        <div className="al-drawer-hd">
          <span>Apply for Leave</span>
          <button className="al-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <form className="al-drawer-body" onSubmit={handleSubmit}>
          <ValidationErrors errors={formErrors} />

          <div className="al-form-group">
            <label className="al-label">Leave Type</label>
            <select className="al-select" name="leave_type" value={form.leave_type} onChange={handleChange}>
              {leaveTypesLoading
                ? <option value="">Loading leave types…</option>
                : leaveTypes.length === 0
                  ? <option value="">No leave types available</option>
                  : leaveTypes.map(t => (
                  <option key={t.id} value={t.leave_name}>{t.leave_name}</option>
                ))
              }
            </select>
          </div>

          <div className="al-form-row">
            <div className="al-form-group">
              <label className="al-label">From Date</label>
              <input className="al-input" type="date" name="from_date" value={form.from_date} onChange={handleChange} required />
            </div>
            <div className="al-form-group">
              <label className="al-label">To Date</label>
              <input className="al-input" type="date" name="to_date" value={form.to_date} min={form.from_date} onChange={handleChange} required />
            </div>
          </div>

          {form.from_date && form.to_date && (
            <div className="al-form-group">
              <label className="al-label">Working Days</label>
              <span className="al-days-calc">
                <Calendar size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                {days} working day{days !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          <div className="al-form-group">
            <label className="al-label">Reason <span style={{ color: '#ef4444' }}>*</span></label>
            <textarea
              className="al-textarea" name="reason" rows={4}
              placeholder="Briefly describe the reason for leave…"
              value={form.reason} onChange={handleChange} required
              style={{ resize: 'vertical' }}
            />
          </div>

          <div className="al-form-group">
            <label className="al-label">
              Emergency Contact <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              className="al-input" type="text" name="emergency_contact"
              placeholder="e.g. +91 98765 43210"
              value={form.emergency_contact} onChange={handleChange}
            />
          </div>

          <div className="al-drawer-footer" style={{ padding: 0, borderTop: 'none', marginTop: 8 }}>
            <button type="button" className="al-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="al-btn-primary" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit Application'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Leave approval chain badge — derived from leave record's own status fields
// shown when the workflow engine has no instance for this leave
// ---------------------------------------------------------------------------
const APPROVAL_STATUS_CFG = {
  approved: { bg: '#dcfce7', color: '#15803d' },
  rejected: { bg: '#fee2e2', color: '#b91c1c' },
  pending:  { bg: '#fef3c7', color: '#92400e' },
};
function LeaveApprovalBadge({ leave }) {
  const steps = [
    leave.manager_status && { label: 'L1', title: 'Manager',   status: leave.manager_status },
    leave.l2_status      && { label: 'L2', title: 'Dept Head', status: leave.l2_status      },
    leave.hr_status      && { label: 'HR', title: 'HR',        status: leave.hr_status       },
  ].filter(Boolean);

  if (!steps.length) return <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>;

  return (
    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
      {steps.map(s => {
        const cfg = APPROVAL_STATUS_CFG[s.status] || APPROVAL_STATUS_CFG.pending;
        return (
          <span key={s.label}
            title={`${s.title}: ${s.status}`}
            style={{
              fontSize: 10, fontWeight: 700,
              padding: '2px 6px', borderRadius: 10,
              background: cfg.bg, color: cfg.color,
            }}
          >
            {s.label}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge (leave status — separate from workflow engine status)
// ---------------------------------------------------------------------------
function StatusBadge({ status }) {
  const cls  = status === 'approved' ? 'al-badge-approved' : status === 'rejected' ? 'al-badge-rejected' : 'al-badge-pending';
  const icon = status === 'approved' ? <CheckCircle size={11} /> : status === 'rejected' ? <XCircle size={11} /> : <Clock size={11} />;
  return (
    <span className={`al-status-badge ${cls}`}>
      {icon} {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
const ADMIN_HR_ROLES_AL = new Set(['admin','super_admin','hr','hr_manager','hr_exec','hr_admin']);

export default function AllLeaves() {
  const { user, hasPermission, hasAnyRole } = useAuth();
  const uid = user?.employee_id;
  // hasAnyRole, NOT user.role: roles are many-to-many (user_roles) and `role` is
  // only the PRIMARY mirror. Gating on it alone sent an HR manager whose primary
  // role is `employee` down the manager approval path AND scoped the list to
  // their own leaves — this flag picks both the endpoint and the query params.
  const isAdminOrHR = hasAnyRole(...ADMIN_HR_ROLES_AL);

  const canAdd     = hasPermission('leaves', 'add');
  const canApprove = hasPermission('leaves', 'approve');

  const [leaves,           setLeaves]           = useState([]);
  const [balance,          setBalance]          = useState([]);
  const [loading,          setLoading]          = useState(false);
  const [wfStatuses,       setWfStatuses]       = useState({});  // { leaveId: workflowObj }
  const [wfLoading,        setWfLoading]        = useState(false);
  const [search,           setSearch]           = useState('');
  const [statusFilter,     setStatus]           = useState('all');
  const [drawerOpen,       setDrawer]           = useState(false);
  const [acting,           setActing]           = useState(null);
  const [toast,            setToast]            = useState(null);
  // Rejection reason, captured per row. The API requires a comment to reject and
  // this page had nowhere to type one, so Reject could only ever fail — see
  // rejectFor below.
  const [rejectFor,        setRejectFor]        = useState(null);  // leave being rejected
  const [rejectComment,    setRejectComment]    = useState('');

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const weekDates = getWeekDates();

  // ---- fetch workflow statuses (batch) after leaves load -------------------
  const fetchWorkflowStatuses = useCallback(async (leaveList) => {
    if (!leaveList.length) return;

    try {
      const ids = leaveList.map(l => l.id);
      const res = await api.post('/workflows/batch-status', { module: 'Leave', entity_ids: ids });
      if (!isMounted.current) return;
      setWfStatuses(res.data || {});
    } catch {
      // non-critical — workflow status is supplementary info
    } finally {
      if (isMounted.current) setWfLoading(false);
    }
  }, []);

  // ---- data fetching -------------------------------------------------------
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Employees see only their own applications; HR/Admin see all
      const appParams = isAdminOrHR ? {} : { employee_id: uid };
      const [leavesRes, balanceRes] = await Promise.allSettled([
        api.get('/leaves/applications', { params: appParams }),
        api.get('/leaves/balance/' + uid),
      ]);
      if (!isMounted.current) return;

      if (leavesRes.status === 'rejected') {
        throw leavesRes.reason;
      }
      const leavesData = Array.isArray(leavesRes.value?.data) ? leavesRes.value.data : [];

      // Balance response is an array of live leave balance rows per type.
      // Store the full array; cards render dynamically from it.
      const balArr = balanceRes.status === 'fulfilled' && Array.isArray(balanceRes.value?.data)
        ? balanceRes.value.data : [];

      setLeaves(leavesData);
      setBalance(balArr.filter(b => Number(b.allocated_days) > 0));
      setWfStatuses({});
      setWfLoading(true);
      fetchWorkflowStatuses(leavesData);
    } catch (err) {
      if (!isMounted.current) return;
      setToast({ type: 'error', message: `Failed to load leave data: ${err?.response?.data?.message || err.message}` });
      setLeaves([]);
      setBalance([]); // must be array — balance.map() is called in render
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [uid, fetchWorkflowStatuses]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ---- approve / reject — route to role-appropriate endpoint ---------------
  async function handleAction(id, action, comments = '') {
    setActing(`${id}:${action}`);
    try {
      if (action === 'approve') {
        if (isAdminOrHR) {
          await api.post(`/leaves/approve/hr/${id}`, { comments });
        } else {
          await api.post(`/leaves/approve/manager/${id}`, { comments });
        }
      } else {
        if (!comments.trim()) {
          setToast({ type: 'error', message: 'A rejection reason is required.' });
          setActing(null);
          return;
        }
        if (isAdminOrHR) {
          await api.post(`/leaves/reject/hr/${id}`, { comments });
        } else {
          await api.post(`/leaves/reject/manager/${id}`, { comments });
        }
      }
      if (!isMounted.current) return;
      await fetchData();
      setToast({ type: 'success', message: `Leave ${action === 'approve' ? 'approved' : 'rejected'} successfully.` });
    } catch (error) {
      if (isMounted.current) {
        setToast({ type: 'error', message: error.response?.data?.error || `Failed to ${action} leave.` });
      }
    } finally {
      if (isMounted.current) setActing(null);
    }
  }

  // ---- filtering -----------------------------------------------------------
  const filtered = leaves.filter(l => {
    const q = search.toLowerCase();
    const name = (l.employee_name || `${l.first_name ?? ''} ${l.last_name ?? ''}`).toLowerCase();
    return (name.includes(q) || l.department?.toLowerCase().includes(q) || (l.leave_name || l.leave_type || '').toLowerCase().includes(q))
        && (statusFilter === 'all' || l.status === statusFilter);
  });

  // --------------------------------------------------------------------------
  return (
    <div className="al-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* Page header */}
      <div className="al-header">
        <h1 className="al-title">Leave Management</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="al-icon-btn" onClick={fetchData} title="Refresh">
            <RefreshCw size={15} />
          </button>
          {canAdd ? (
            <button className="al-btn-add" onClick={() => setDrawer(true)}>
              <Plus size={15} /> Apply Leave
            </button>
          ) : (
            <button className="al-btn-add" disabled title="You don't have permission to apply for leave"
              style={{ opacity: 0.45, cursor: 'not-allowed' }}>
              <Lock size={13} /> Apply Leave
            </button>
          )}
        </div>
      </div>

      {/* Leave balance cards — dynamically rendered from live API data */}
      <p className="al-section-title">Leave Balances</p>
      <div className="al-balance-grid">
        {balance.length === 0 ? (
          <div style={{ gridColumn: '1/-1', color: '#9ca3af', fontSize: 13, padding: '10px 0' }}>
            No leave balances allocated yet for this year.
          </div>
        ) : (
          balance.map((lt, i) => <BalanceCard key={lt.leave_type_id || lt.leave_name} leaveType={lt} index={i} />)
        )}
      </div>

      {/* Team leave this week */}
      <div className="al-week-card">
        <p className="al-section-title" style={{ marginBottom: 14 }}>
          <Users size={15} style={{ marginRight: 6, verticalAlign: 'middle', color: '#6366f1' }} />
          Team Leave This Week
        </p>
        <div className="al-week-grid">
          {weekDates.map(({ name, date }) => {
            // Build ISO date string for this weekday cell to match against leave ranges
            const today = new Date();
            const dayIdx = today.getDay();
            const monday = new Date(today);
            monday.setDate(today.getDate() - (dayIdx === 0 ? 6 : dayIdx - 1));
            const dayNames = ['Mon','Tue','Wed','Thu','Fri'];
            const offset = dayNames.indexOf(name);
            const cellDate = new Date(monday);
            cellDate.setDate(monday.getDate() + offset);
            // Use local date getters — toISOString() converts to UTC which shifts the
            // date backward in UTC+ timezones (e.g. midnight IST = prior day in UTC).
            const iso = `${cellDate.getFullYear()}-${String(cellDate.getMonth()+1).padStart(2,'0')}-${String(cellDate.getDate()).padStart(2,'0')}`;
            const members = leaves
              .filter(l => l.status === 'approved' && l.start_date?.slice(0,10) <= iso && l.end_date?.slice(0,10) >= iso)
              .map(l => l.employee_name || `${l.first_name || ''} ${l.last_name || ''}`.trim());
            return (
              <div key={name} className="al-week-day">
                <div className="al-week-day-name">{name}</div>
                <div className="al-week-day-date">{date}</div>
                {members.length === 0
                  ? <div className="al-empty-day">No leaves</div>
                  : members.map((m, i) => <span key={i} className="al-leave-chip">{m}</span>)
                }
              </div>
            );
          })}
        </div>
      </div>

      {/* Leave history table */}
      <div className="al-table-section">
        <div className="al-table-controls">
          <div className="al-search-wrap">
            <Search size={14} className="al-search-icon" />
            <input
              className="al-search" type="text"
              placeholder="Search employee, type, department…"
              value={search} onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select className="al-filter-select" value={statusFilter} onChange={e => setStatus(e.target.value)}>
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
            {filtered.length} record{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {loading ? (
          <div className="al-empty">
            <RefreshCw size={28} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
            <span>Loading leave data…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="al-empty">
            <Calendar size={32} />
            <span>No leave applications found.</span>
          </div>
        ) : (
          <div className="al-table-wrap">
            <table className="al-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Leave Type</th>
                  <th>From Date</th>
                  <th>To Date</th>
                  <th>Days</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Workflow</th>
                  <th>Applied On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(leave => (
                  <tr key={leave.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: '#111827' }}>
                        {leave.employee_name || `${leave.first_name ?? ''} ${leave.last_name ?? ''}`.trim() || '—'}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{leave.department}</div>
                    </td>
                    <td>{leave.leave_name || leave.leave_type}</td>
                    <td>{formatDate(leave.start_date)}</td>
                    <td>{formatDate(leave.end_date)}</td>
                    <td>
                      <span style={{ fontWeight: 600, color: '#6366f1' }}>{leave.number_of_days ?? leave.days}</span>
                    </td>
                    <td style={{ maxWidth: 180 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {leave.reason || '-'}
                      </span>
                    </td>
                    <td><StatusBadge status={leave.status} /></td>

                    {/* ── Workflow status column ── */}
                    <td>
                      {wfStatuses[leave.id]
                        ? <WorkflowBadge workflow={wfStatuses[leave.id]} loading={wfLoading} />
                        : <LeaveApprovalBadge leave={leave} />
                      }
                    </td>

                    <td>{formatDate(leave.applied_at || leave.created_at)}</td>

                    {/* ── Action column — guarded by approve permission ── */}
                    <td>
                      {leave.status === 'pending' && canApprove ? (
                        <>
                          <button className="al-action-btn-approve" title="Approve" onClick={() => handleAction(leave.id, 'approve')} disabled={!!acting}>
                            {acting === `${leave.id}:approve` ? <Clock size={13} /> : <CheckCircle size={13} />}
                          </button>
                          <button className="al-action-btn-reject" title="Reject" onClick={() => { setRejectFor(leave); setRejectComment(''); }} disabled={!!acting}>
                            {acting === `${leave.id}:reject` ? <Clock size={13} /> : <XCircle size={13} />}
                          </button>
                        </>
                      ) : leave.status === 'pending' ? (
                        <span title="You don't have permission to approve leaves" style={{ color: '#d1d5db', cursor: 'default' }}>
                          <Lock size={13} />
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Apply Leave Drawer */}
      <ApplyDrawer
        open={drawerOpen}
        onClose={() => setDrawer(false)}
        onSuccess={msg => { setToast(msg); if (msg.type === 'success') fetchData(); }}
      />

      {/* Reject reason — the API rejects a comment-less reject, so ask for one
          rather than firing a call that is guaranteed to fail. */}
      {rejectFor && (
        <div className="al-modal-overlay" style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:14, padding:24, width:440, maxWidth:'92vw' }}>
            <h3 style={{ margin:'0 0 4px', fontSize:16, fontWeight:700, color:'#1f2937' }}>Reject leave</h3>
            <p style={{ margin:'0 0 14px', fontSize:12, color:'#6b7280' }}>
              {rejectFor.employee_name} · {rejectFor.leave_name || rejectFor.leave_type}
            </p>
            <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>
              Reason <span style={{ color:'#ef4444' }}>*</span>
            </label>
            <textarea
              className="al-textarea"
              rows={3}
              value={rejectComment}
              onChange={e => setRejectComment(e.target.value)}
              placeholder="Tell the applicant why this is being rejected"
              style={{ width:'100%', boxSizing:'border-box', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, resize:'vertical' }}
            />
            <div style={{ display:'flex', justifyContent:'flex-end', gap:10, marginTop:18 }}>
              <button
                onClick={() => setRejectFor(null)}
                style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>
                Cancel
              </button>
              <button
                onClick={async () => {
                  const leave = rejectFor;
                  setRejectFor(null);
                  await handleAction(leave.id, 'reject', rejectComment);
                }}
                disabled={!rejectComment.trim() || !!acting}
                style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#ef4444', color:'#fff', cursor: rejectComment.trim() ? 'pointer' : 'not-allowed', fontSize:13, fontWeight:600, opacity: rejectComment.trim() ? 1 : 0.5 }}>
                Reject Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
