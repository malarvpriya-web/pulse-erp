/**
 * All Leaves — the company-wide leave register (HR / admin).
 *
 * Reworked 2026-11-23 (Leaves review). Removed, because each repeated another
 * page and did it worse:
 *   - its own "Apply Leave" side drawer (no half day, holidays, LOP, clubbing or
 *     attachment) → the header button opens Apply Leave, which HR can use on
 *     behalf of anyone;
 *   - balance cards that showed the LOGGED-IN admin's own balance;
 *   - "Team leave this week" → Leave Calendar;
 *   - approve / reject buttons that jumped straight to the HR step →
 *     Leave Approvals (the one place decisions are taken, level by level).
 * Added: department / leave type / date range / year filters, totals, CSV
 * export, the approval history of every request.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CalendarDays, Plus, RefreshCw, Search, Download, History, ClipboardCheck, XCircle } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { ApprovalChain, StatusChip, LeaveHistoryDialog, downloadCsv, fmtDate, AttachmentLink } from '../components/leaveShared';
import './AllLeaves.css';

const YEAR = new Date().getFullYear();
const inp = { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' };
const PAGE = 50;
// Who may cancel anyone's leave (mirrors the server's isAdminOrHR).
const CANCEL_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'hr_admin'];

// HR cancels a pending or approved leave, with the reason (2026-11-24: there
// was no screen for it — My Leaves cancels only your own, before it starts).
function CancelDialog({ leave, onDone, onClose }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const { data } = await api.put(`/leaves/${leave.id}/cancel`, { reason: reason.trim() });
      if (data?.warning) toast.warning(data.warning);
      else toast.success(leave.status === 'approved' ? 'Leave cancelled — the days are back in the balance.' : 'Leave request cancelled.');
      onDone();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not cancel the leave'); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 440, maxWidth: '100%' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: '#1f2937' }}>Cancel leave</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>
          {leave.employee_name} · {leave.leave_name} · {fmtDate(leave.start_date)}{String(leave.start_date).slice(0, 10) !== String(leave.end_date).slice(0, 10) ? ` → ${fmtDate(leave.end_date)}` : ''} · {Number(leave.number_of_days)} day(s) · {leave.status}
        </p>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Reason <span style={{ color: '#ef4444' }}>*</span></label>
        <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why it is cancelled — the employee sees this"
          style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} className="pulse-btn-secondary">Back</button>
          <button onClick={submit} disabled={busy || !reason.trim()}
            style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: '#ef4444', color: '#fff', fontWeight: 600, fontSize: 13, cursor: reason.trim() ? 'pointer' : 'not-allowed', opacity: busy || !reason.trim() ? 0.6 : 1 }}>
            {busy ? 'Cancelling…' : 'Cancel leave'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AllLeaves({ setPage }) {
  const { hasPermission, hasAnyRole } = useAuth();
  const canAdd = hasPermission('leaves', 'add');
  const canCancel = hasAnyRole(...CANCEL_ROLES);
  const [cancelFor, setCancelFor] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [types, setTypes] = useState([]);
  const [depts, setDepts] = useState([]);
  const [f, setF] = useState({ year: String(YEAR), status: '', department: '', leave_type_id: '', from: '', to: '', q: '' });
  const [historyId, setHistoryId] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    api.get('/leaves/types', { params: { applicable: 1 } }).then(r => setTypes(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    api.get('/admin/config/departments')
      .then(r => setDepts(Array.isArray(r.data) ? r.data.map(d => d.name || d).filter(Boolean) : []))
      .catch(() => setDepts([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = { limit: 1000 };
      if (f.status) params.status = f.status;
      if (f.department) params.department = f.department;
      if (f.leave_type_id) params.leave_type_id = f.leave_type_id;
      if (f.from && f.to) { params.from = f.from; params.to = f.to; } else if (f.year) params.year = f.year;
      const r = await api.get('/leaves/applications', { params });
      if (mounted.current) { setRows(Array.isArray(r.data) ? r.data : []); setShown(PAGE); }
    } catch (e) {
      if (mounted.current) { setRows([]); setError(e?.response?.data?.error || 'Could not load leave applications.'); }
    } finally { if (mounted.current) setLoading(false); }
  }, [f.status, f.department, f.leave_type_id, f.from, f.to, f.year]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const base = f.worked ? rows.filter(l => l.status === 'approved' && Number(l.worked_days) > 0) : rows;
    if (!q) return base;
    return base.filter(l => [l.employee_name, l.employee_code, l.department, l.leave_name, l.reason]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }, [rows, f.q, f.worked]);

  const totals = useMemo(() => {
    const t = { pending: 0, approved: 0, rejected: 0, cancelled: 0, days: 0, lop: 0 };
    filtered.forEach(l => {
      if (t[l.status] !== undefined) t[l.status]++;
      if (l.status === 'approved') {
        t.days += Number(l.number_of_days || 0);
        t.lop += l.is_lop ? Number(l.number_of_days || 0) : Number(l.lop_days || 0);
      }
    });
    return t;
  }, [filtered]);

  const exportCsv = () => downloadCsv(`leave-register-${f.from && f.to ? `${f.from}_${f.to}` : f.year || 'all'}.csv`, [
    { label: 'Employee', key: 'employee_name' }, { label: 'Code', key: 'employee_code' },
    { label: 'Department', key: 'department' }, { label: 'Leave type', key: 'leave_name' },
    { label: 'From', value: r => String(r.start_date || '').slice(0, 10) }, { label: 'To', value: r => String(r.end_date || '').slice(0, 10) },
    { label: 'Days', key: 'number_of_days' }, { label: 'LOP days', value: r => (r.is_lop ? r.number_of_days : r.lop_days) || 0 },
    { label: 'Half day', value: r => (r.half_day ? (r.half_day_session || 'Yes') : '') },
    { label: 'Status', key: 'status' }, { label: 'Manager', value: r => r.manager_status || '' },
    { label: 'Dept head', value: r => (r.l2_required ? (r.l2_status || 'pending') : 'not needed') },
    { label: 'HR', value: r => r.hr_status || '' },
    { label: 'Reason', key: 'reason' }, { label: 'Applied on', value: r => String(r.applied_at || r.created_at || '').slice(0, 10) },
  ], filtered);

  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const anyFilter = f.status || f.department || f.leave_type_id || f.from || f.to || f.q || f.worked || f.year !== String(YEAR);

  return (
    <PageShell dock={
      <PageHero
        icon={CalendarDays}
        eyebrow="Leave"
        title="All Leaves"
        subtitle="Every leave request in the company — filter, export, and see where each one stands"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
          {setPage && <button className="plh-cta plh-cta--ghost" onClick={() => setPage('LeaveApprovals')}><ClipboardCheck size={15} /> Leave Approvals</button>}
          {canAdd && setPage && <button className="plh-cta" onClick={() => setPage('ApplyLeave')}><Plus size={15} /> Apply on behalf</button>}
        </>}
      />
    }>
      {/* Totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 10, marginBottom: 16 }}>
        {[
          ['Requests', filtered.length, '#6B3FDB'], ['Pending', totals.pending, '#5b21b6'],
          ['Approved', totals.approved, '#059669'], ['Rejected', totals.rejected, '#dc2626'],
          ['Cancelled', totals.cancelled, '#6b7280'], ['Days taken', totals.days, '#065f46'], ['LOP days', totals.lop, '#b91c1c'],
        ].map(([l, v, c]) => (
          <div key={l} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: c }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="al-table-section">
        <div className="al-table-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="al-search-wrap">
            <Search size={14} className="al-search-icon" />
            <input className="al-search" placeholder="Search employee, code, type, reason…" value={f.q} onChange={e => set('q', e.target.value)} />
          </div>
          <select style={inp} value={f.status} onChange={e => set('status', e.target.value)}>
            <option value="">All status</option><option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option><option value="cancelled">Cancelled</option>
          </select>
          <select style={inp} value={f.department} onChange={e => set('department', e.target.value)}>
            <option value="">All departments</option>{depts.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select style={inp} value={f.leave_type_id} onChange={e => set('leave_type_id', e.target.value)}>
            <option value="">All leave types</option>{types.map(t => <option key={t.id} value={t.id}>{t.leave_name}</option>)}
          </select>
          <select style={inp} value={f.year} onChange={e => set('year', e.target.value)} disabled={!!(f.from && f.to)} title={f.from && f.to ? 'The date range is used instead' : ''}>
            <option value="">All years</option>{[YEAR + 1, YEAR, YEAR - 1, YEAR - 2].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
            From <input type="date" style={inp} value={f.from} onChange={e => set('from', e.target.value)} />
          </label>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
            To <input type="date" style={inp} value={f.to} min={f.from || undefined} onChange={e => set('to', e.target.value)} />
          </label>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }} title="Approved leave on days the person punched in">
            <input type="checkbox" checked={!!f.worked} onChange={e => set('worked', e.target.checked)} /> Punched in on leave
          </label>
          {anyFilter && <button className="al-btn-ghost" onClick={() => setF({ year: String(YEAR), status: '', department: '', leave_type_id: '', from: '', to: '', q: '', worked: false })}>Clear</button>}
          <button className="al-btn-ghost" onClick={exportCsv} disabled={!filtered.length} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Download size={13} /> Export CSV
          </button>
        </div>

        {loading ? (
          <div className="al-empty"><RefreshCw size={26} style={{ color: '#6B3FDB' }} /><span>Loading…</span></div>
        ) : error ? (
          <div className="al-empty" style={{ color: '#dc2626' }}>{error}</div>
        ) : filtered.length === 0 ? (
          <div className="al-empty"><CalendarDays size={30} /><span>No leave requests match these filters.</span></div>
        ) : (
          <div className="al-table-wrap">
            <table className="al-table">
              <thead>
                <tr>
                  <th>Employee</th><th>Leave type</th><th>From</th><th>To</th><th>Days</th>
                  <th>Reason</th><th>Status</th><th>Approval</th><th>Applied</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, shown).map(l => {
                  const lop = l.is_lop ? Number(l.number_of_days) : Number(l.lop_days || 0);
                  return (
                    <tr key={l.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: '#111827' }}>{l.employee_name || '—'}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{[l.employee_code, l.department].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>{l.leave_name}</td>
                      <td>{fmtDate(l.start_date)}</td>
                      <td>{fmtDate(l.end_date)}</td>
                      <td>
                        <span style={{ fontWeight: 600, color: '#6B3FDB' }}>{Number(l.number_of_days)}</span>
                        {l.half_day && <span style={{ fontSize: 10, color: '#6b7280' }}> ½ {l.half_day_session}</span>}
                        {lop > 0 && <div style={{ fontSize: 10, color: '#b91c1c', fontWeight: 600 }}>{lop} LOP</div>}
                        {l.status === 'approved' && Number(l.worked_days) > 0 && (
                          <div title="Attendance has a punch on these leave days. Payroll pays them as worked; the leave still uses balance — cancel or correct it."
                            style={{ fontSize: 10, color: '#b45309', fontWeight: 600 }}>Punched in on {Number(l.worked_days)} day{Number(l.worked_days) !== 1 ? 's' : ''}</div>
                        )}
                      </td>
                      <td style={{ maxWidth: 200 }}>
                        <span title={l.reason} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.reason || '—'}</span>
                        <AttachmentLink url={l.attachment_url} />
                      </td>
                      <td><StatusChip status={l.status} /></td>
                      <td><ApprovalChain leave={l} /></td>
                      <td>{fmtDate(l.applied_at || l.created_at)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="al-btn-ghost" title="Approval history" onClick={() => setHistoryId(l.id)}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}>
                            <History size={12} /> History
                          </button>
                          {canCancel && ['pending', 'approved'].includes(l.status) && (
                            <button className="al-btn-ghost" title="Cancel this leave" onClick={() => setCancelFor(l)}
                              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', color: '#b91c1c' }}>
                              <XCircle size={12} /> Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length > shown && (
              <div style={{ textAlign: 'center', padding: 12 }}>
                <button className="al-btn-ghost" onClick={() => setShown(s => s + PAGE)}>Show more ({filtered.length - shown} left)</button>
              </div>
            )}
          </div>
        )}
      </div>

      {historyId && <LeaveHistoryDialog leaveId={historyId} onClose={() => setHistoryId(null)} />}
      {cancelFor && <CancelDialog leave={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); load(); }} />}
    </PageShell>
  );
}
