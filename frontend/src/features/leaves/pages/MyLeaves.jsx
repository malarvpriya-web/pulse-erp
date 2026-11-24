/**
 * My Leaves — the employee's own leave: balance, every request and where it
 * stands, every approver's comment, and cancel before the leave starts.
 *
 * 2026-11-23 (Leaves review): balance summary added (it was only on Apply
 * Leave); year filter; the approval chain now shows the department-head step
 * only for types that have one (it always said "L2 Pending"); comments from
 * the department head and HR are shown too — a rejection by HR used to arrive
 * with no visible reason.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { Calendar, Clock, RefreshCw, CalendarDays, Paperclip, History } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { ApprovalChain, StatusChip, LeaveHistoryDialog, fmtDate, localISO, AttachmentLink } from '../components/leaveShared';

const YEAR = new Date().getFullYear();

function Comment({ who, text }) {
  if (!text) return null;
  return (
    <div style={{ fontSize: 12, color: '#374151', marginBottom: 6, padding: '6px 10px', background: '#f5f3ff', borderRadius: 6, borderLeft: '3px solid #6B3FDB' }}>
      <span style={{ fontWeight: 600, fontSize: 11, color: '#6B3FDB' }}>{who}: </span>{text}
    </div>
  );
}

function LeaveCard({ leave, onCancel, cancelling, onHistory }) {
  const canCancel = ['pending', 'approved'].includes(leave.status) && String(leave.start_date).slice(0, 10) >= localISO();
  const lop = leave.is_lop ? Number(leave.number_of_days) : Number(leave.lop_days || 0);
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>{leave.leave_name}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {Number(leave.number_of_days)} day{Number(leave.number_of_days) !== 1 ? 's' : ''}
            {leave.half_day ? ` (half day, ${leave.half_day_session === 'PM' ? 'afternoon' : 'morning'})` : ''}
            {lop > 0 && <span style={{ color: '#b91c1c', fontWeight: 600 }}> · {lop} day{lop !== 1 ? 's' : ''} Loss of Pay</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatusChip status={leave.status} />
          <ApprovalChain leave={leave} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 18, fontSize: 12, color: '#6b7280', marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Calendar size={12} color="#9ca3af" />
          {fmtDate(leave.start_date)}{String(leave.start_date).slice(0, 10) !== String(leave.end_date).slice(0, 10) && ` → ${fmtDate(leave.end_date)}`}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><Clock size={12} color="#9ca3af" /> Applied {fmtDate(leave.applied_at || leave.created_at)}</span>
      </div>
      {leave.reason && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>{leave.reason}</div>}
      <Comment who={leave.manager_name ? `Manager (${leave.manager_name})` : 'Manager'} text={leave.manager_comments || leave.manager_comment} />
      <Comment who={leave.l2_name ? `Department head (${leave.l2_name})` : 'Department head'} text={leave.l2_comments} />
      <Comment who={leave.hr_name ? `HR (${leave.hr_name})` : 'HR'} text={leave.hr_comments} />
      <Comment who="Withdrawn because" text={leave.withdrawal_reason} />
      {leave.status === 'pending' && leave.escalated_at && (
        <div style={{ fontSize: 11, color: '#b45309', marginBottom: 8 }}>
          Waited long for {({ l1: 'your manager', l2: 'the department head', hr: 'HR' })[leave.escalation_step] || 'a decision'} — escalated on {fmtDate(leave.escalated_at)}.
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {leave.attachment_url && (
          <span style={{ color: '#6B3FDB', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Paperclip size={12} /><AttachmentLink url={leave.attachment_url} label="View attachment" style={{ fontSize: 12 }} />
          </span>
        )}
        <button onClick={() => onHistory(leave.id)} className="pulse-btn-secondary" style={{ fontSize: 12, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <History size={12} /> History
        </button>
        {canCancel && (
          <button onClick={() => onCancel(leave)} disabled={cancelling === leave.id}
            style={{ marginLeft: 'auto', padding: '6px 14px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: cancelling === leave.id ? 0.6 : 1 }}>
            {cancelling === leave.id ? 'Cancelling…' : 'Cancel leave'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function MyLeaves({ setPage }) {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [leaves, setLeaves] = useState([]);
  const [balance, setBalance] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [pendingCancel, setPendingCancel] = useState(null);
  const [fStatus, setFStatus] = useState('');
  const [fYear, setFYear] = useState(String(YEAR));
  const [historyId, setHistoryId] = useState(null);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const goApply = () => (setPage ? setPage('ApplyLeave') : navigate('/ApplyLeave'));

  const fetchMine = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fYear) params.year = fYear;
      const [apps, bal] = await Promise.allSettled([
        api.get('/leaves/my', { params }),
        user?.employee_id ? api.get(`/leaves/balance/${user.employee_id}`, { params: { year: fYear || YEAR } }) : Promise.resolve({ data: [] }),
      ]);
      if (!isMounted.current) return;
      setLeaves(apps.status === 'fulfilled' && Array.isArray(apps.value.data) ? apps.value.data : []);
      setBalance(bal.status === 'fulfilled' && Array.isArray(bal.value.data)
        ? bal.value.data.filter(b => Number(b.allocated_days) + Number(b.carried_forward_days || 0) > 0 || Number(b.used_days) > 0) : []);
    } finally { if (isMounted.current) setLoading(false); }
  }, [fYear, user?.employee_id]);
  useEffect(() => { fetchMine(); }, [fetchMine]);

  const handleCancel = async () => {
    if (!pendingCancel) return;
    const leave = pendingCancel;
    setPendingCancel(null);
    setCancelling(leave.id);
    try {
      await api.put(`/leaves/${leave.id}/cancel`);
      toast.success(leave.status === 'approved' ? 'Leave cancelled. The days are back in your balance.' : 'Leave request cancelled.');
      fetchMine();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to cancel leave');
    } finally { if (isMounted.current) setCancelling(null); }
  };

  const stats = leaves.reduce((acc, l) => { acc[l.status] = (acc[l.status] || 0) + 1; return acc; }, {});
  const shown = fStatus ? leaves.filter(l => l.status === fStatus) : leaves;

  return (
    <PageShell dock={
      <PageHero
        icon={CalendarDays}
        eyebrow="Leave"
        title="My Leaves"
        subtitle="Your balance, every request and where it stands"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={fetchMine} aria-label="Refresh"><RefreshCw size={13} /></button>
          <button className="plh-cta" onClick={goApply}>+ Apply Leave</button>
        </>}
      />
    }>
      <ConfirmDialog
        open={!!pendingCancel}
        title="Cancel leave"
        message={pendingCancel ? `Cancel your ${pendingCancel.leave_name} from ${fmtDate(pendingCancel.start_date)}?${pendingCancel.status === 'approved' ? ' The days go back to your balance.' : ''}` : ''}
        confirmLabel="Cancel leave"
        variant="warning"
        onConfirm={handleCancel}
        onCancel={() => setPendingCancel(null)}
      />
      {historyId && <LeaveHistoryDialog leaveId={historyId} onClose={() => setHistoryId(null)} />}

      {/* Balance */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 10, marginBottom: 18 }}>
        {balance.length === 0 && !loading && (
          <div style={{ gridColumn: '1/-1', fontSize: 13, color: '#9ca3af' }}>No leave balance for {fYear || YEAR} yet — HR sets it up in Leave Settings.</div>
        )}
        {balance.map(b => {
          const total = Number(b.allocated_days) + Number(b.carried_forward_days || 0);
          const used = Number(b.used_days || 0);
          const pending = Number(b.pending_days || 0);
          const pct = total > 0 ? Math.min(100, Math.round(((used + pending) / total) * 100)) : 0;
          return (
            <div key={b.leave_type_id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{b.leave_name}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: Number(b.available_days) > 0 ? '#6B3FDB' : '#dc2626' }}>
                {Number(b.available_days)} <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}>of {total} left</span>
              </div>
              <div style={{ height: 4, background: '#f3f4f6', borderRadius: 2, margin: '6px 0' }}>
                <div style={{ width: `${pct}%`, height: 4, borderRadius: 2, background: '#6B3FDB' }} />
              </div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                {used} taken{pending ? ` · ${pending} pending` : ''}{Number(b.encashed_days) ? ` · ${Number(b.encashed_days)} encashed` : ''}{Number(b.carried_forward_days) ? ` · ${Number(b.carried_forward_days)} carried in` : ''}
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['', 'All', leaves.length], ['pending', 'Pending', stats.pending || 0], ['approved', 'Approved', stats.approved || 0], ['rejected', 'Rejected', stats.rejected || 0], ['cancelled', 'Cancelled', stats.cancelled || 0]].map(([v, l, cnt]) => (
          <button key={v} onClick={() => setFStatus(v)}
            style={{ padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${fStatus === v ? '#6B3FDB' : '#e5e7eb'}`, background: fStatus === v ? '#f5f3ff' : '#fff', color: fStatus === v ? '#6B3FDB' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {l} <strong>{cnt}</strong>
          </button>
        ))}
        <select value={fYear} onChange={e => setFYear(e.target.value)} aria-label="Year"
          style={{ marginLeft: 'auto', padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          {[YEAR + 1, YEAR, YEAR - 1, YEAR - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>
      ) : shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <Calendar size={48} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
          <p style={{ margin: '0 0 16px', fontSize: 15 }}>No leave requests{fStatus ? ` that are ${fStatus}` : ''} in {fYear || 'any year'}</p>
          <button onClick={goApply} className="pulse-btn-primary">Apply for leave</button>
        </div>
      ) : (
        shown.map(leave => (
          <LeaveCard key={leave.id} leave={leave} onCancel={setPendingCancel} cancelling={cancelling} onHistory={setHistoryId} />
        ))
      )}
    </PageShell>
  );
}
