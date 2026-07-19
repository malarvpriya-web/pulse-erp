import React, { useState, useEffect, useRef, useCallback, createPortal } from 'react';
import {
  Zap, CheckCircle, X, Clock, AlertCircle, RefreshCw,
  Download, Plus, Users, ChevronDown,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';

const P     = '#6B3FDB';
const CARD  = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 };
const INPUT = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box',
};

const OT_TYPES = [
  { value: 'weekday', label: 'Weekday OT',  mult: '1.5×', color: '#6B3FDB', bg: '#f5f3ff' },
  { value: 'weekend', label: 'Weekend OT',  mult: '2×',   color: '#0369a1', bg: '#e0f2fe' },
  { value: 'holiday', label: 'Holiday OT',  mult: '2×',   color: '#dc2626', bg: '#fee2e2' },
  { value: 'night',   label: 'Night OT',    mult: '1.5×', color: '#4f46e5', bg: '#eef2ff' },
];
const OT_MAP = Object.fromEntries(OT_TYPES.map(t => [t.value, t]));

const STATUS_STYLE = {
  pending:       { bg: '#fef3c7', color: '#92400e' },
  approved:      { bg: '#dcfce7', color: '#166534' },
  rejected:      { bg: '#fee2e2', color: '#991b1b' },
  auto_approved: { bg: '#e0f2fe', color: '#0369a1' },
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const MANAGER_ROLES = new Set(['admin', 'hr', 'manager', 'super_admin', 'hr_manager']);

// ─── Portal Modal ─────────────────────────────────────────────────────────────
function Modal({ title, subtitle, onClose, children, wide }) {
  // Close on Escape
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, padding: 28,
          width: wide ? 520 : 460, maxWidth: '100%',
          maxHeight: '92vh', overflowY: 'auto',
          boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            style={{ border: 'none', background: '#f3f4f6', borderRadius: 8, padding: '5px 7px', cursor: 'pointer', color: '#374151', display: 'flex', alignItems: 'center' }}
          >
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

// ─── Shared button styles ─────────────────────────────────────────────────────
const Btn = ({ children, onClick, variant = 'primary', disabled, style: extra }) => {
  const base = {
    flex: 1, padding: '10px 16px', borderRadius: 8, fontSize: 14,
    fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.65 : 1, border: 'none', transition: 'opacity 0.15s',
  };
  const variants = {
    primary:  { background: P,         color: '#fff' },
    success:  { background: '#10b981', color: '#fff' },
    danger:   { background: '#ef4444', color: '#fff' },
    outline:  { background: '#fff',    color: '#374151', border: '1px solid #e5e7eb' },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...extra }}>
      {children}
    </button>
  );
};

// ─── Record badge ─────────────────────────────────────────────────────────────
function OTBadge({ type, size = 'sm' }) {
  const t = OT_MAP[type] || OT_MAP.weekday;
  return (
    <span style={{
      padding: size === 'sm' ? '2px 8px' : '3px 10px',
      borderRadius: 99, fontSize: size === 'sm' ? 11 : 12,
      fontWeight: 600, background: t.bg, color: t.color,
    }}>
      {t.label}
    </span>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────
function OTRow({ record, selected, onToggleSelect, onApprove, onReject, isManager }) {
  const st = STATUS_STYLE[record.status] || STATUS_STYLE.pending;
  const isPending = record.status === 'pending';

  return (
    <tr style={{ borderBottom: '1px solid #f0f0f4', verticalAlign: 'middle' }}>
      {isManager && (
        <td style={{ padding: '10px 14px', width: 36 }}>
          {isPending && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              style={{ width: 16, height: 16, cursor: 'pointer', accentColor: P }}
            />
          )}
        </td>
      )}

      <td style={{ padding: '10px 14px' }}>
        <div style={{ fontWeight: 600, color: '#111827', fontSize: 14, lineHeight: 1.3 }}>
          {record.emp_name || record.employee_name}
        </div>
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{record.department}</div>
      </td>

      <td style={{ padding: '10px 14px', color: '#374151', fontSize: 13, whiteSpace: 'nowrap' }}>
        {record.attendance_date}
      </td>

      <td style={{ padding: '10px 14px' }}>
        <OTBadge type={record.ot_type} />
      </td>

      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: P }}>{record.ot_hours}h</span>
        {record.multiplier != null && (
          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>× {record.multiplier}x</span>
        )}
      </td>

      <td style={{ padding: '10px 14px' }}>
        <span style={{
          padding: '2px 10px', borderRadius: 99, fontSize: 11,
          fontWeight: 600, background: st.bg, color: st.color, textTransform: 'capitalize',
        }}>
          {record.status?.replace('_', ' ')}
        </span>
      </td>

      <td style={{ padding: '10px 14px', fontSize: 12, color: '#6b7280', maxWidth: 180 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {record.reason || '—'}
        </div>
      </td>

      <td style={{ padding: '10px 14px' }}>
        {isPending && isManager ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => onApprove(record)}
              style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#dcfce7', color: '#166534', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}
            >
              Approve
            </button>
            <button
              onClick={() => onReject(record)}
              style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#fee2e2', color: '#991b1b', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}
            >
              Reject
            </button>
          </div>
        ) : (record.status === 'approved' || record.status === 'auto_approved') && record.approver_name ? (
          <div style={{ fontSize: 11, color: '#6b7280' }}>by {record.approver_name}</div>
        ) : null}
      </td>
    </tr>
  );
}

// ─── Approve modal ────────────────────────────────────────────────────────────
function ApproveModal({ record, onConfirm, onClose, loading }) {
  const [remarks, setRemarks] = useState('');
  const ot = OT_MAP[record.ot_type] || OT_MAP.weekday;
  return (
    <Modal
      title="Approve Overtime"
      subtitle={`${record.emp_name} · ${record.attendance_date}`}
      onClose={onClose}
    >
      <div style={{ padding: '10px 14px', background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0', marginBottom: 18, fontSize: 13 }}>
        <OTBadge type={record.ot_type} size="md" />
        <span style={{ marginLeft: 8, fontWeight: 700, color: P }}>{record.ot_hours}h</span>
        <span style={{ marginLeft: 4, color: '#6b7280' }}>× {record.multiplier}x multiplier</span>
        {record.reason && <div style={{ marginTop: 6, color: '#374151' }}>Reason: {record.reason}</div>}
      </div>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Remarks (optional)</label>
      <textarea
        value={remarks}
        onChange={e => setRemarks(e.target.value)}
        rows={3}
        placeholder="Add an approval note…"
        style={{ ...INPUT, marginTop: 6, marginBottom: 18, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn variant="success" onClick={() => onConfirm(remarks)} disabled={loading}>
          {loading ? 'Approving…' : 'Approve OT'}
        </Btn>
        <Btn variant="outline" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

// ─── Reject modal ─────────────────────────────────────────────────────────────
function RejectModal({ record, onConfirm, onClose, loading }) {
  const [remarks, setRemarks] = useState('');
  const [err, setErr]         = useState('');

  const submit = () => {
    if (!remarks.trim()) { setErr('Rejection reason is required'); return; }
    onConfirm(remarks);
  };

  return (
    <Modal
      title="Reject Overtime"
      subtitle={`${record.emp_name} · ${record.attendance_date}`}
      onClose={onClose}
    >
      <div style={{ padding: '10px 14px', background: '#fff7ed', borderRadius: 8, border: '1px solid #fed7aa', marginBottom: 18, fontSize: 13 }}>
        <OTBadge type={record.ot_type} size="md" />
        <span style={{ marginLeft: 8, fontWeight: 700, color: P }}>{record.ot_hours}h</span>
        {record.reason && <div style={{ marginTop: 6, color: '#374151' }}>Reason: {record.reason}</div>}
      </div>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
        Rejection Reason <span style={{ color: '#ef4444' }}>*</span>
      </label>
      <textarea
        value={remarks}
        onChange={e => { setRemarks(e.target.value); if (err) setErr(''); }}
        rows={3}
        placeholder="Explain why this OT is being rejected…"
        style={{ ...INPUT, marginTop: 6, border: `1px solid ${err ? '#ef4444' : '#e5e7eb'}`, resize: 'vertical' }}
      />
      {err && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 4 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <Btn variant="danger" onClick={submit} disabled={loading}>
          {loading ? 'Rejecting…' : 'Reject OT'}
        </Btn>
        <Btn variant="outline" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

// ─── Bulk approve modal ───────────────────────────────────────────────────────
function BulkApproveModal({ count, onConfirm, onClose, loading }) {
  const [remarks, setRemarks] = useState('');
  return (
    <Modal title={`Bulk Approve ${count} OT Request${count !== 1 ? 's' : ''}`} onClose={onClose}>
      <div style={{ padding: '10px 14px', background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0', marginBottom: 18, fontSize: 13 }}>
        You are about to approve <strong>{count}</strong> pending overtime
        request{count !== 1 ? 's' : ''}. Approved hours will be included in the next payroll run.
      </div>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Remarks (optional)</label>
      <textarea
        value={remarks}
        onChange={e => setRemarks(e.target.value)}
        rows={2}
        placeholder="Bulk approval note…"
        style={{ ...INPUT, marginTop: 6, marginBottom: 18, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn variant="success" onClick={() => onConfirm(remarks)} disabled={loading}>
          {loading ? 'Approving…' : `Approve ${count}`}
        </Btn>
        <Btn variant="outline" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

// ─── Request OT modal ─────────────────────────────────────────────────────────
function RequestOTModal({ isManager, employees, myEmployeeId, onSubmit, onClose, loading }) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({
    employee_id:     isManager ? '' : String(myEmployeeId || ''),
    attendance_date: today,
    ot_hours:        '',
    ot_type:         'weekday',
    reason:          '',
  });
  const [err, setErr] = useState('');

  const set = patch => setForm(prev => ({ ...prev, ...patch }));

  const submit = () => {
    const empId = form.employee_id || myEmployeeId;
    if (!empId)              { setErr('Please select an employee'); return; }
    if (!form.attendance_date) { setErr('Date is required'); return; }
    const hrs = parseFloat(form.ot_hours);
    if (!hrs || hrs <= 0 || hrs > 16) { setErr('Enter valid OT hours (0.5 – 16)'); return; }
    setErr('');
    onSubmit({ ...form, employee_id: empId, ot_hours: hrs });
  };

  return (
    <Modal
      title={isManager ? 'Log OT for Employee' : 'Request Overtime'}
      subtitle="Creates a pending OT record for manager approval"
      onClose={onClose}
      wide
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {isManager && (
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
              Employee <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <select
              value={form.employee_id}
              onChange={e => set({ employee_id: e.target.value })}
              style={INPUT}
            >
              <option value="">— Select employee —</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>
                  {e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}
                  {e.department ? ` — ${e.department}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
            Date <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            type="date"
            value={form.attendance_date}
            max={today}
            onChange={e => set({ attendance_date: e.target.value })}
            style={INPUT}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
              OT Hours <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="number"
              min="0.5"
              max="16"
              step="0.5"
              placeholder="e.g. 2.5"
              value={form.ot_hours}
              onChange={e => set({ ot_hours: e.target.value })}
              style={INPUT}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
              OT Type
            </label>
            <select value={form.ot_type} onChange={e => set({ ot_type: e.target.value })} style={INPUT}>
              {OT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label} ({t.mult})</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
            Reason
          </label>
          <textarea
            placeholder="Why was overtime worked? (e.g. month-end closing, urgent delivery…)"
            value={form.reason}
            onChange={e => set({ reason: e.target.value })}
            rows={3}
            style={{ ...INPUT, resize: 'vertical' }}
          />
        </div>

        {err && (
          <div style={{ color: '#ef4444', fontSize: 12, padding: '8px 12px', background: '#fee2e2', borderRadius: 6 }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <Btn onClick={submit} disabled={loading}>
            {loading ? 'Submitting…' : 'Submit OT Request'}
          </Btn>
          <Btn variant="outline" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ msg, type }) {
  const isErr = type === 'error';
  return createPortal(
    <div style={{
      position: 'fixed', top: 20, right: 20, zIndex: 2000,
      padding: '12px 18px', borderRadius: 10,
      background: isErr ? '#fee2e2' : '#dcfce7',
      border: `1px solid ${isErr ? '#fca5a5' : '#86efac'}`,
      color: isErr ? '#991b1b' : '#166534',
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 14, boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
      maxWidth: 360,
    }}>
      {isErr ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
      {msg}
    </div>,
    document.body
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function OvertimeApprovals() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the approval queue from anyone holding
  // manager/hr as a secondary role. See AuthContext.
  const { user, hasAnyRole } = useAuth();
  const isManager   = hasAnyRole(...MANAGER_ROLES);
  const myEmpId     = user?.employee_id || user?.employeeId;
  const currentYear = new Date().getFullYear();

  const [records,  setRecords]  = useState([]);
  const [stats,    setStats]    = useState(null);
  const [employees,setEmployees]= useState([]);
  const [loading,  setLoading]  = useState(true);
  const [filter,   setFilter]   = useState('pending');
  const [month,    setMonth]    = useState(new Date().getMonth() + 1);
  const [year,     setYear]     = useState(currentYear);
  const [toast,    setToast]    = useState(null);
  const [selected, setSelected] = useState(new Set());

  // Modal states — null = closed, value = context data
  const [approveTarget, setApproveTarget] = useState(null);
  const [rejectTarget,  setRejectTarget]  = useState(null);
  const [showBulk,      setShowBulk]      = useState(false);
  const [showRequest,   setShowRequest]   = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [reqLoading,    setReqLoading]    = useState(false);

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const flash = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3500);
  };

  // ── Fetch cross-status KPI stats (independent of filter tab) ───────────────
  const loadStats = useCallback(async () => {
    try {
      const res = await api.get(`/attendance/overtime/stats?month=${month}&year=${year}`);
      if (isMounted.current) setStats(res.data);
    } catch { if (isMounted.current) setStats(null); }
  }, [month, year]);

  // ── Fetch filtered record list ─────────────────────────────────────────────
  const loadRecords = useCallback(async () => {
    setLoading(true);
    setSelected(new Set());
    try {
      const p = new URLSearchParams({ month, year });
      if (filter !== 'all') p.set('status', filter);
      const res = await api.get(`/attendance/overtime?${p}`);
      if (isMounted.current) setRecords(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (isMounted.current) setRecords([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [filter, month, year]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRecords(); }, [loadRecords]);

  // ── Fetch employee list for manager OT logging ─────────────────────────────
  useEffect(() => {
    if (!isManager) return;
    api.get('/employees?status=active&limit=500')
      .then(r => {
        if (!isMounted.current) return;
        const list = Array.isArray(r.data?.data) ? r.data.data
                   : Array.isArray(r.data)        ? r.data
                   : [];
        setEmployees(list);
      })
      .catch(() => {});
  }, [isManager]);

  const reload = () => { loadStats(); loadRecords(); };

  // ── Approve single ─────────────────────────────────────────────────────────
  const handleApprove = async (remarks) => {
    setActionLoading(true);
    try {
      await api.put(`/attendance/overtime/${approveTarget.id}/approve`, { remarks });
      flash('OT approved successfully');
      setApproveTarget(null);
      reload();
    } catch (e) {
      flash(e.response?.data?.error || 'Approve failed', 'error');
    } finally { setActionLoading(false); }
  };

  // ── Reject single ──────────────────────────────────────────────────────────
  const handleReject = async (remarks) => {
    setActionLoading(true);
    try {
      await api.put(`/attendance/overtime/${rejectTarget.id}/reject`, { remarks });
      flash('OT rejected');
      setRejectTarget(null);
      reload();
    } catch (e) {
      flash(e.response?.data?.error || 'Reject failed', 'error');
    } finally { setActionLoading(false); }
  };

  // ── Bulk approve ───────────────────────────────────────────────────────────
  const handleBulkApprove = async (remarks) => {
    setActionLoading(true);
    try {
      const res = await api.post('/attendance/overtime/bulk-approve', {
        ids: [...selected], remarks,
      });
      flash(`${res.data.approved} OT record${res.data.approved !== 1 ? 's' : ''} approved`);
      setShowBulk(false);
      setSelected(new Set());
      reload();
    } catch (e) {
      flash(e.response?.data?.error || 'Bulk approve failed', 'error');
    } finally { setActionLoading(false); }
  };

  // ── Submit OT request ──────────────────────────────────────────────────────
  const handleRequestOT = async (formData) => {
    setReqLoading(true);
    try {
      await api.post('/attendance/overtime', formData);
      flash('OT request submitted — pending manager approval');
      setShowRequest(false);
      reload();
    } catch (e) {
      flash(e.response?.data?.error || 'Failed to submit OT request', 'error');
    } finally { setReqLoading(false); }
  };

  // ── Selection helpers ──────────────────────────────────────────────────────
  const pendingRows = records.filter(r => r.status === 'pending');
  const allSelected = pendingRows.length > 0 && pendingRows.every(r => selected.has(r.id));

  const toggleRow = id => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAll = () => {
    if (allSelected) { setSelected(new Set()); }
    else { setSelected(new Set(pendingRows.map(r => r.id))); }
  };

  // ── CSV Export ─────────────────────────────────────────────────────────────
  const exportCSV = () => {
    const header = ['Employee', 'Department', 'Date', 'OT Type', 'OT Hours', 'Multiplier', 'Status', 'Reason', 'Approved By'];
    const body   = records.map(r => [
      r.emp_name || r.employee_name,
      r.department,
      r.attendance_date,
      r.ot_type,
      r.ot_hours,
      r.multiplier,
      r.status,
      r.reason || '',
      r.approver_name || '',
    ]);
    const csv  = [header, ...body]
      .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `overtime-${MONTHS[month - 1]}-${year}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const kpis = [
    { label: 'Pending Approvals', value: stats?.pending_count ?? '—',                       icon: Clock,        color: '#f59e0b', bg: '#fef3c7' },
    { label: 'Total OT Hours',    value: stats ? `${stats.total_ot_hours.toFixed(1)}h` : '—', icon: Zap,         color: P,         bg: '#f5f3ff' },
    { label: 'Approved OT Hours', value: stats ? `${stats.approved_hours.toFixed(1)}h` : '—', icon: CheckCircle, color: '#10b981', bg: '#dcfce7' },
    { label: 'Total Records',     value: stats?.total_records ?? '—',                       icon: AlertCircle,  color: '#6b7280', bg: '#f3f4f6' },
  ];

  const yearOpts = [currentYear - 1, currentYear, currentYear + 1];

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>

      {toast && <Toast msg={toast.msg} type={toast.type} />}

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>Overtime Approvals</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            Review, approve and track employee overtime records
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={exportCSV}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}
          >
            <Download size={13} /> Export CSV
          </button>
          <button
            onClick={reload}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}
          >
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            onClick={() => setShowRequest(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 'none', background: P, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
          >
            <Plus size={13} /> {isManager ? 'Log OT' : 'Request OT'}
          </button>
        </div>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: k.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <k.icon size={20} color={k.color} />
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{k.value}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>

        {/* Status tabs */}
        {[
          { key: 'pending',  label: 'Pending',  badge: stats?.pending_count },
          { key: 'approved', label: 'Approved', badge: stats?.approved_count },
          { key: 'rejected', label: 'Rejected', badge: stats?.rejected_count },
          { key: 'all',      label: 'All',      badge: stats?.total_records },
        ].map(({ key, label, badge }) => {
          const active = filter === key;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 8,
                border: `1px solid ${active ? P : '#e5e7eb'}`,
                background: active ? P : '#fff',
                color: active ? '#fff' : '#374151',
                fontWeight: 500, cursor: 'pointer', fontSize: 13,
              }}
            >
              {label}
              {badge > 0 && (
                <span style={{
                  background: active ? 'rgba(255,255,255,0.25)' : '#f3f4f6',
                  color: active ? '#fff' : '#374151',
                  borderRadius: 99, padding: '1px 7px', fontSize: 11, fontWeight: 700,
                }}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}

        {/* Bulk approve button (appears when rows are selected) */}
        {isManager && selected.size > 0 && (
          <button
            onClick={() => setShowBulk(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8, border: 'none',
              background: '#10b981', color: '#fff', fontWeight: 600,
              cursor: 'pointer', fontSize: 13,
            }}
          >
            <CheckCircle size={13} /> Approve {selected.size} Selected
          </button>
        )}

        {/* Month / Year selectors */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <select
            value={month}
            onChange={e => setMonth(parseInt(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, cursor: 'pointer' }}
          >
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <select
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, cursor: 'pointer' }}
          >
            {yearOpts.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 14 }}>
          Loading overtime records…
        </div>
      ) : records.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <Zap size={40} color="#e5e7eb" style={{ marginBottom: 14 }} />
          <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>No overtime records found</div>
          <div style={{ fontSize: 13, color: '#9ca3af' }}>
            {filter === 'pending'
              ? 'No pending OT requests for this period.'
              : `No ${filter === 'all' ? '' : filter + ' '}OT records for ${MONTHS[month - 1]} ${year}.`}
          </div>
        </div>
      ) : (
        <div style={CARD}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #f0f0f4' }}>
                {isManager && (
                  <th style={{ padding: '10px 14px', width: 36 }}>
                    {filter === 'pending' && pendingRows.length > 0 && (
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        title="Select all pending"
                        style={{ width: 16, height: 16, cursor: 'pointer', accentColor: P }}
                      />
                    )}
                  </th>
                )}
                {['Employee', 'Date', 'OT Type', 'Hours', 'Status', 'Reason', 'Action'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 12 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <OTRow
                  key={r.id}
                  record={r}
                  selected={selected.has(r.id)}
                  onToggleSelect={() => toggleRow(r.id)}
                  onApprove={rec => setApproveTarget(rec)}
                  onReject={rec  => setRejectTarget(rec)}
                  isManager={isManager}
                />
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTop: '1px solid #f0f0f4' }}>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              {records.length} record{records.length !== 1 ? 's' : ''} · {MONTHS[month - 1]} {year}
            </span>
            {isManager && selected.size > 0 && (
              <span style={{ fontSize: 12, color: P, fontWeight: 600 }}>
                {selected.size} row{selected.size !== 1 ? 's' : ''} selected
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Modals (rendered via portals, never inside table DOM) ────────── */}

      {approveTarget && (
        <ApproveModal
          record={approveTarget}
          onConfirm={handleApprove}
          onClose={() => setApproveTarget(null)}
          loading={actionLoading}
        />
      )}

      {rejectTarget && (
        <RejectModal
          record={rejectTarget}
          onConfirm={handleReject}
          onClose={() => setRejectTarget(null)}
          loading={actionLoading}
        />
      )}

      {showBulk && (
        <BulkApproveModal
          count={selected.size}
          onConfirm={handleBulkApprove}
          onClose={() => setShowBulk(false)}
          loading={actionLoading}
        />
      )}

      {showRequest && (
        <RequestOTModal
          isManager={isManager}
          employees={employees}
          myEmployeeId={myEmpId}
          onSubmit={handleRequestOT}
          onClose={() => setShowRequest(false)}
          loading={reqLoading}
        />
      )}
    </div>
  );
}
