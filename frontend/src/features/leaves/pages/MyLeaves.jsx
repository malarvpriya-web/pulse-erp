import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { Calendar, Clock, CheckCircle, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

function ApprovalPipeline({ leave }) {
  const status = (leave.status || 'pending').toLowerCase();
  const mgr    = (leave.manager_status || 'pending').toLowerCase();
  const l2     = leave.l2_status ? leave.l2_status.toLowerCase() : null;
  const hr     = (leave.hr_status || 'pending').toLowerCase();

  if (status === 'cancelled') return <Chip bg="#f3f4f6" color="#6b7280">Cancelled</Chip>;
  if (status === 'approved')  return <Chip bg="#d1fae5" color="#166534">✓ Fully Approved</Chip>;
  if (status === 'rejected') {
    const who = hr === 'rejected' ? 'HR' : l2 === 'rejected' ? 'L2' : 'Manager';
    return <Chip bg="#fee2e2" color="#991b1b">Rejected by {who}</Chip>;
  }
  if (mgr === 'pending') return (
    <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap' }}>
      <Chip bg="#fed7aa" color="#9a3412">L1 Pending</Chip>
      <span style={{ color:'#d1d5db', fontSize:11 }}>→ L2 → HR</span>
    </div>
  );
  if (mgr === 'approved' && (!l2 || l2 === 'pending')) return (
    <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap' }}>
      <Chip bg="#d1fae5" color="#065f46">L1 ✓</Chip>
      <span style={{ color:'#d1d5db', fontSize:11 }}>→</span>
      <Chip bg="#dbeafe" color="#1d4ed8">L2 Pending</Chip>
      <span style={{ color:'#d1d5db', fontSize:11 }}>→ HR</span>
    </div>
  );
  if (l2 === 'approved' && hr === 'pending') return (
    <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap' }}>
      <Chip bg="#d1fae5" color="#065f46">L1 ✓</Chip>
      <span style={{ color:'#d1d5db', fontSize:11 }}>→</span>
      <Chip bg="#d1fae5" color="#065f46">L2 ✓</Chip>
      <span style={{ color:'#d1d5db', fontSize:11 }}>→</span>
      <Chip bg="#dbeafe" color="#1d4ed8">HR Pending</Chip>
    </div>
  );
  return <Chip bg="#fed7aa" color="#9a3412">Pending Review</Chip>;
}

function Chip({ bg, color, children }) {
  return (
    <span style={{ background:bg, color, padding:'2px 9px', borderRadius:20, fontSize:11, fontWeight:700, whiteSpace:'nowrap' }}>
      {children}
    </span>
  );
}

// Mobile card view for a single leave
function LeaveCard({ leave, onCancel, cancelling }) {
  const canCancelThis = ['pending','approved'].includes(leave.status) && new Date(leave.start_date) >= new Date(new Date().toDateString());
  const typeColor = { 'Sick Leave':'#ef4444', 'Casual Leave':'#f59e0b', 'Earned Leave':'#10b981', 'Annual Leave':'#10b981', 'Maternity Leave':'#ec4899', 'Paternity Leave':'#6366f1', 'Compensatory Leave':'#8b5cf6', 'Loss of Pay':'#9ca3af' };
  const tc = typeColor[leave.leave_name||leave.leave_type] || '#6366f1';

  return (
    <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', padding:'14px 16px', marginBottom:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:4, height:36, borderRadius:2, background:tc, flexShrink:0 }}/>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:'#1f2937' }}>{leave.leave_name || leave.leave_type}</div>
            <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>
              {leave.number_of_days || leave.days} day{(leave.number_of_days||1) !== 1 ? 's' : ''}
              {leave.half_day ? ' (Half Day)' : ''}
            </div>
          </div>
        </div>
        <ApprovalPipeline leave={leave} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, color:'#6b7280', marginBottom:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:5 }}>
          <Calendar size={12} color="#9ca3af"/>
          {fmt(leave.start_date)}
          {leave.start_date !== leave.end_date && ` → ${fmt(leave.end_date)}`}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:5 }}>
          <Clock size={12} color="#9ca3af"/>
          Applied: {fmt(leave.applied_at || leave.created_at)}
        </div>
      </div>
      {leave.reason && (
        <div style={{ fontSize:12, color:'#6b7280', marginBottom:8, padding:'6px 10px', background:'#f9fafb', borderRadius:6 }}>
          {leave.reason}
        </div>
      )}
      {(leave.manager_comments || leave.manager_comment) && (
        <div style={{ fontSize:12, color:'#374151', marginBottom:8, padding:'6px 10px', background:'#eff6ff', borderRadius:6, borderLeft:'3px solid #6366f1' }}>
          <span style={{ fontWeight:600, fontSize:11, color:'#6366f1' }}>Manager: </span>
          {leave.manager_comments || leave.manager_comment}
        </div>
      )}
      {leave.attachment_url && (
        <div style={{ fontSize:12, marginBottom:8 }}>
          <a href={leave.attachment_url} target="_blank" rel="noopener noreferrer"
            style={{ color:'#6366f1', textDecoration:'none', display:'flex', alignItems:'center', gap:4 }}>
            📎 View Attachment
          </a>
        </div>
      )}
      {canCancelThis && (
        <button onClick={() => onCancel(leave)} disabled={cancelling === leave.id}
          style={{ width:'100%', padding:'8px', background:'#fee2e2', color:'#991b1b', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:cancelling===leave.id?0.6:1 }}>
          {cancelling === leave.id ? 'Cancelling…' : 'Cancel Leave'}
        </button>
      )}
    </div>
  );
}

export default function MyLeaves({ setPage }) {
  const { user }  = useAuth();
  const toast     = useToast();
  const navigate  = useNavigate();
  const [leaves,    setLeaves]    = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [cancelling,setCancelling]= useState(null);
  const [pendingHandleCancel, setPendingHandleCancel] = useState(null);
  const [fStatus,   setFStatus]   = useState('');
  const [view,      setView]      = useState('cards'); // 'cards' | 'table'
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const fetchMyLeaves = async () => {
    setLoading(true);
    try {
      const params = {};
      if (fStatus) params.status = fStatus;
      const response = await api.get('/leaves/my', { params });
      if (!isMounted.current) return;
      const raw = Array.isArray(response.data) ? response.data : (response.data?.data || response.data?.applications || []);
      setLeaves(raw);
    } catch { if (isMounted.current) setLeaves([]); }
    finally { if (isMounted.current) setLoading(false); }
  };

  useEffect(() => { fetchMyLeaves(); }, [fStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = async () => {
    if (!pendingHandleCancel) return;
    const leave = pendingHandleCancel;
    setPendingHandleCancel(null);
    setCancelling(leave.id);
    try {
      await api.put(`/leaves/${leave.id}/cancel`);
      toast.success('Leave cancelled. Balance restored if it was approved.');
      fetchMyLeaves();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to cancel leave');
    } finally { if (isMounted.current) setCancelling(null); }
  };

  const stats = leaves.reduce((acc, l) => { acc[l.status] = (acc[l.status]||0)+1; return acc; }, {});

  return (
    <div style={{ padding:'20px 16px', maxWidth:900, margin:'0 auto' }}>
      <ConfirmDialog
        open={!!pendingHandleCancel}
        title="Cancel Leave"
        message={pendingHandleCancel ? `Cancel your ${pendingHandleCancel.leave_name || pendingHandleCancel.leave_type} from ${fmt(pendingHandleCancel.start_date)}? If already approved, days will be returned to your balance.` : ''}
        confirmLabel="Cancel Leave"
        variant="warning"
        onConfirm={handleCancel}
        onCancel={() => setPendingHandleCancel(null)}
      />
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20, flexWrap:'wrap', gap:10 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>My Leave Applications</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'4px 0 0' }}>Your complete leave history and status</p>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button onClick={fetchMyLeaves} style={{ display:'flex',alignItems:'center',gap:5,padding:'7px 12px',border:'1px solid #e5e7eb',borderRadius:8,background:'#fff',fontSize:13,cursor:'pointer' }}>
            <RefreshCw size={13}/>
          </button>
          <button onClick={() => setPage ? setPage('ApplyLeave') : navigate('/leaves/apply')}
            style={{ padding:'8px 18px',background:'#6366f1',color:'#fff',border:'none',borderRadius:8,fontWeight:600,fontSize:13,cursor:'pointer' }}>
            + Apply Leave
          </button>
        </div>
      </div>

      {/* Summary pills */}
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
        {[['','All',leaves.length,'#6b7280'],['pending','Pending',stats.pending||0,'#f59e0b'],['approved','Approved',stats.approved||0,'#10b981'],['rejected','Rejected',stats.rejected||0,'#ef4444'],['cancelled','Cancelled',stats.cancelled||0,'#9ca3af']].map(([v,l,cnt,color]) => (
          <button key={v} onClick={() => setFStatus(v)}
            style={{ padding:'6px 14px', borderRadius:20, border:`1.5px solid ${fStatus===v?color:'#e5e7eb'}`, background:fStatus===v?color+'18':'#fff', color:fStatus===v?color:'#6b7280', fontSize:12, fontWeight:600, cursor:'pointer' }}>
            {l} <strong>{cnt}</strong>
          </button>
        ))}
      </div>

      {/* Approval chain explainer */}
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16, padding:'8px 14px', background:'#f0f9ff', borderRadius:8, border:'1px solid #bae6fd', fontSize:12, flexWrap:'wrap' }}>
        <strong style={{ color:'#0369a1' }}>Approval Flow:</strong>
        <Chip bg="#fef3c7" color="#92400e">L1 Manager</Chip>
        <span style={{ color:'#9ca3af' }}>→</span>
        <Chip bg="#dbeafe" color="#1d4ed8">L2 Dept Head</Chip>
        <span style={{ color:'#9ca3af' }}>→</span>
        <Chip bg="#ede9fe" color="#5b21b6">L3 HR</Chip>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>
          <div style={{ width:32,height:32,border:'3px solid #e5e7eb',borderTopColor:'#6366f1',borderRadius:'50%',margin:'0 auto 12px',animation:'spin 0.8s linear infinite' }}/>
          Loading…
        </div>
      ) : leaves.length === 0 ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>
          <Calendar size={48} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
          <p style={{ margin:'0 0 16px', fontSize:15 }}>No leave applications found</p>
          {setPage && (
            <button onClick={() => setPage('ApplyLeave')}
              style={{ padding:'9px 22px', background:'#6366f1', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>
              Apply for Leave
            </button>
          )}
        </div>
      ) : (
        <div>
          {/* Mobile: cards; Desktop: cards (always readable) */}
          {leaves.map(leave => (
            <LeaveCard key={leave.id} leave={leave} onCancel={setPendingHandleCancel} cancelling={cancelling} />
          ))}
        </div>
      )}
    </div>
  );
}
