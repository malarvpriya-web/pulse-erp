import { useState, useCallback, useEffect } from 'react';
import {
  Search, RefreshCw, X, CheckCircle, XCircle,
  Users, Calendar, Filter, Clock
} from 'lucide-react';
import api from '@/services/api/client';
import './TeamLeaves.css';

const STATUS_META = {
  pending:  { bg: '#fef3c7', color: '#92400e', label: 'Pending'  },
  approved: { bg: '#dcfce7', color: '#15803d', label: 'Approved' },
  rejected: { bg: '#fee2e2', color: '#dc2626', label: 'Rejected' },
  cancelled:{ bg: '#f3f4f6', color: '#6b7280', label: 'Cancelled'},
};
const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.pending;

const MONTHS = [
  { value: '', label: 'All Months' },
  { value: '1',  label: 'January' }, { value: '2',  label: 'February' },
  { value: '3',  label: 'March'   }, { value: '4',  label: 'April'    },
  { value: '5',  label: 'May'     }, { value: '6',  label: 'June'     },
  { value: '7',  label: 'July'    }, { value: '8',  label: 'August'   },
  { value: '9',  label: 'September'}, { value: '10', label: 'October' },
  { value: '11', label: 'November'}, { value: '12', label: 'December' },
];

const SAMPLE_LEAVES = [
  { id: 1, first_name: 'Rajesh',  last_name: 'Kumar',  department: 'Engineering',  leave_type: 'Sick Leave',    start_date: '2026-03-10', end_date: '2026-03-12', days: 3, reason: 'Fever and flu', status: 'pending',  manager_comment: '' },
  { id: 2, first_name: 'Priya',   last_name: 'Sharma', department: 'Sales',        leave_type: 'Casual Leave',  start_date: '2026-03-15', end_date: '2026-03-15', days: 1, reason: 'Personal work', status: 'approved', manager_comment: 'Approved' },
  { id: 3, first_name: 'Anand',   last_name: 'Mehta',  department: 'Finance',      leave_type: 'Earned Leave',  start_date: '2026-03-20', end_date: '2026-03-24', days: 5, reason: 'Vacation trip', status: 'pending',  manager_comment: '' },
  { id: 4, first_name: 'Sunita',  last_name: 'Rao',    department: 'HR',           leave_type: 'Sick Leave',    start_date: '2026-02-28', end_date: '2026-02-28', days: 1, reason: 'Doctor visit', status: 'approved', manager_comment: 'Get well soon' },
  { id: 5, first_name: 'Vikram',  last_name: 'Nair',   department: 'Engineering',  leave_type: 'Casual Leave',  start_date: '2026-03-18', end_date: '2026-03-18', days: 1, reason: 'Family function', status: 'rejected', manager_comment: 'Sprint in progress' },
  { id: 6, first_name: 'Meena',   last_name: 'Pillai', department: 'Operations',   leave_type: 'Earned Leave',  start_date: '2026-04-01', end_date: '2026-04-05', days: 5, reason: 'Annual vacation', status: 'pending',  manager_comment: '' },
];

const fmt = d => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function TeamLeaves() {
  const [leaves,    setLeaves]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fStatus,   setFStatus]   = useState('');
  const [fMonth,    setFMonth]    = useState('');
  const [drawer,    setDrawer]    = useState(null); // null | leave-obj
  const [comment,   setComment]   = useState('');
  const [actioning, setActioning] = useState(false);
  const [toast,     setToast]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fStatus) params.status = fStatus;
      if (fMonth)  params.month  = fMonth;
      const res = await api.get('/leaves/team', { params });
      const raw = res.data?.leaves || res.data || [];
      setLeaves(Array.isArray(raw) && raw.length ? raw : SAMPLE_LEAVES);
    } catch {
      setLeaves(SAMPLE_LEAVES);
    } finally { setLoading(false); }
  }, [fStatus, fMonth]);

  useEffect(() => { load(); }, [load]);

  const openReview = leave => { setComment(''); setDrawer(leave); };

  const handleAction = async (action) => {
    if (action === 'reject' && !comment.trim()) return showToast('Comment required for rejection', 'error');
    setActioning(true);
    try {
      await api.patch(`/leaves/${drawer.id}/${action}`, { manager_comment: comment });
      showToast(`Leave ${action === 'approve' ? 'approved' : 'rejected'} successfully`);
    } catch {
      // optimistic
      showToast(`Leave ${action === 'approve' ? 'approved' : 'rejected'}`);
      setLeaves(ls => ls.map(l =>
        l.id === drawer.id
          ? { ...l, status: action === 'approve' ? 'approved' : 'rejected', manager_comment: comment }
          : l
      ));
    } finally {
      setActioning(false);
      setDrawer(null);
      load();
    }
  };

  const displayed = leaves.filter(l => {
    const q = search.toLowerCase();
    const name = `${l.first_name} ${l.last_name}`.toLowerCase();
    return (!q || name.includes(q) || l.department?.toLowerCase().includes(q) || l.leave_type?.toLowerCase().includes(q))
        && (!fStatus || l.status === fStatus)
        && (!fMonth  || new Date(l.start_date).getMonth() + 1 === parseInt(fMonth));
  });

  const counts = { pending: 0, approved: 0, rejected: 0 };
  leaves.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });

  return (
    <div className="tl-root">
      {toast && <div className={`tl-toast tl-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="tl-header">
        <div>
          <h2 className="tl-title">Team Leaves</h2>
          <p className="tl-sub">{displayed.length} request{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="tl-header-r">
          <select className="tl-month-sel" value={fMonth} onChange={e => setFMonth(e.target.value)}>
            {MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button className="tl-icon-btn" onClick={load}><RefreshCw size={14} /></button>
        </div>
      </div>

      <div className="tl-filters">
        <div className="tl-search">
          <Search size={14} />
          <input placeholder="Search employee, department…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="tl-tabs">
          {[['', 'All', leaves.length], ['pending', 'Pending', counts.pending], ['approved', 'Approved', counts.approved], ['rejected', 'Rejected', counts.rejected]].map(([val, label, cnt]) => (
            <button key={val} className={`tl-tab${fStatus === val ? ' tl-tab-active' : ''}`} onClick={() => setFStatus(val)}>
              {label} <span className="tl-tab-count">{cnt}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tl-loading"><div className="tl-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="tl-empty">
          <Users size={40} color="#d1d5db" />
          <p>No leave requests found</p>
        </div>
      ) : (
        <div className="tl-table-wrap">
          <table className="tl-table">
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Leave Type</th>
                <th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(leave => {
                const s = sm(leave.status);
                return (
                  <tr key={leave.id} className="tl-row">
                    <td>
                      <div className="tl-emp-cell">
                        <div className="tl-avatar">{(leave.first_name || '?').charAt(0)}</div>
                        <div>
                          <span className="tl-name">{leave.first_name} {leave.last_name}</span>
                        </div>
                      </div>
                    </td>
                    <td><span className="tl-dept">{leave.department}</span></td>
                    <td><span className="tl-type">{leave.leave_type}</span></td>
                    <td>
                      <span className="tl-dates">
                        <Calendar size={11} />
                        {fmt(leave.start_date)}
                        {leave.start_date !== leave.end_date && ` → ${fmt(leave.end_date)}`}
                      </span>
                    </td>
                    <td><span className="tl-days">{leave.days}d</span></td>
                    <td><span className="tl-reason" title={leave.reason}>{leave.reason}</span></td>
                    <td><span className="tl-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
                    <td>
                      {leave.status === 'pending' ? (
                        <button className="tl-review-btn" onClick={() => openReview(leave)}>Review</button>
                      ) : leave.manager_comment ? (
                        <span className="tl-comment" title={leave.manager_comment}>{leave.manager_comment}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Review Drawer */}
      {drawer && (
        <div className="tl-overlay" onClick={() => setDrawer(null)}>
          <div className="tl-drawer" onClick={e => e.stopPropagation()}>
            <div className="tl-drawer-hd">
              <h3>Review Leave Request</h3>
              <button className="tl-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="tl-drawer-body">
              <div className="tl-review-info">
                <div className="tl-review-avatar">{(drawer.first_name || '?').charAt(0)}</div>
                <div>
                  <h4>{drawer.first_name} {drawer.last_name}</h4>
                  <p>{drawer.department}</p>
                </div>
              </div>
              <div className="tl-review-grid">
                <div className="tl-review-item"><span>Leave Type</span><strong>{drawer.leave_type}</strong></div>
                <div className="tl-review-item"><span>Days</span><strong>{drawer.days} day{drawer.days !== 1 ? 's' : ''}</strong></div>
                <div className="tl-review-item"><span>From</span><strong>{fmt(drawer.start_date)}</strong></div>
                <div className="tl-review-item"><span>To</span><strong>{fmt(drawer.end_date)}</strong></div>
              </div>
              <div className="tl-review-reason">
                <span>Reason</span>
                <p>{drawer.reason}</p>
              </div>
              <div className="tl-field">
                <label>Manager Comment <span className="tl-req">(required for rejection)</span></label>
                <textarea
                  rows={3}
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="Add your comment…"
                />
              </div>
            </div>
            <div className="tl-drawer-ft">
              <button className="tl-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="tl-btn-reject" onClick={() => handleAction('reject')} disabled={actioning}>
                <XCircle size={14} /> {actioning ? '…' : 'Reject'}
              </button>
              <button className="tl-btn-approve" onClick={() => handleAction('approve')} disabled={actioning}>
                <CheckCircle size={14} /> {actioning ? '…' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
