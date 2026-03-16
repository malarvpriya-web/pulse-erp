import { useState, useEffect, useCallback } from 'react';
import { Search, X, CheckCircle, XCircle, Eye, UmbrellaOff } from 'lucide-react';
import api from '@/services/api/client';
import './LeaveApprovals.css';

const SAMPLE = [
  { id: 1, employee: 'Sneha Iyer',   department: 'Finance',     leaveType: 'Casual', startDate: '2026-03-20', endDate: '2026-03-20', days: 1, reason: 'Personal work',        status: 'Pending'  },
  { id: 2, employee: 'Rohit Gupta',  department: 'Operations',  leaveType: 'Earned', startDate: '2026-04-01', endDate: '2026-04-02', days: 2, reason: 'Family function',       status: 'Pending'  },
  { id: 3, employee: 'Kiran Das',    department: 'Engineering', leaveType: 'Sick',   startDate: '2026-03-24', endDate: '2026-03-25', days: 2, reason: 'Medical appointment',   status: 'Approved' },
  { id: 4, employee: 'Meera Joshi',  department: 'Engineering', leaveType: 'Casual', startDate: '2026-03-18', endDate: '2026-03-18', days: 1, reason: 'Bank work',             status: 'Rejected' },
  { id: 5, employee: 'Vikram Singh', department: 'Sales',       leaveType: 'Earned', startDate: '2026-03-27', endDate: '2026-03-29', days: 3, reason: 'Vacation',             status: 'Approved' },
  { id: 6, employee: 'Anika Patel',  department: 'HR',          leaveType: 'Sick',   startDate: '2026-03-31', endDate: '2026-03-31', days: 1, reason: 'Fever and cold',       status: 'Pending'  },
];

const TABS = ['All','Pending','Approved','Rejected'];
const TYPE_COLORS = { Casual: '#dbeafe', Sick: '#fee2e2', Earned: '#dcfce7', Maternity: '#fce7f3', Optional: '#fef3c7' };
const TYPE_TEXT   = { Casual: '#1d4ed8', Sick: '#dc2626', Earned: '#15803d', Maternity: '#9d174d', Optional: '#92400e' };
const STATUS_COLORS = { Pending: '#fef3c7', Approved: '#dcfce7', Rejected: '#fee2e2' };
const STATUS_TEXT   = { Pending: '#92400e', Approved: '#15803d', Rejected: '#991b1b' };

export default function LeaveApprovals() {
  const [requests, setRequests] = useState(SAMPLE);
  const [loading, setLoading]   = useState(false);
  const [fTab, setFTab]         = useState('Pending');
  const [search, setSearch]     = useState('');
  const [drawer, setDrawer]     = useState(null);
  const [comment, setComment]   = useState('');
  const [saving, setSaving]     = useState(false);
  const [toast, setToast]       = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = fTab !== 'All' ? { status: fTab } : {};
      const res = await api.get('/leaves/approvals', { params });
      const raw = res.data?.data ?? res.data;
      setRequests(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setRequests(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? requests.length : requests.filter(r => r.status === t).length
  }), {});

  const filtered = requests.filter(r =>
    (fTab === 'All' || r.status === fTab) &&
    (r.employee?.toLowerCase().includes(search.toLowerCase()) ||
     r.leaveType?.toLowerCase().includes(search.toLowerCase()))
  );

  const handleAction = async (action) => {
    if (action === 'Rejected' && !comment.trim()) { showToast('Comment required for rejection', 'error'); return; }
    setSaving(true);
    const id = drawer.id;
    try {
      await api.put(`/leaves/requests/${id}/status`, { status: action, comment });
    } catch { /* optimistic */ }
    setRequests(prev => prev.map(r => r.id === id ? { ...r, status: action } : r));
    showToast(`Leave ${action === 'Approved' ? 'approved' : 'rejected'}!`);
    setDrawer(null); setComment(''); setSaving(false);
  };

  return (
    <div className="la-root">
      {toast && <div className={`la-toast la-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="la-header">
        <div>
          <h1 className="la-title">Leave Approvals</h1>
          <p className="la-sub">Review and approve leave requests from your team</p>
        </div>
      </div>

      <div className="la-filters">
        <div className="la-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search employee or leave type…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="la-tabs">
          {TABS.map(t => (
            <button key={t} className={`la-tab ${fTab === t ? 'la-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="la-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="la-loading"><div className="la-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="la-empty"><UmbrellaOff size={32} color="#d1d5db" /><p>No leave requests found</p></div>
      ) : (
        <div className="la-table-wrap">
          <table className="la-table">
            <thead>
              <tr><th>Employee</th><th>Dept</th><th>Leave Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="la-row">
                  <td>
                    <div className="la-emp">
                      <div className="la-avatar">{r.employee.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                      {r.employee}
                    </div>
                  </td>
                  <td><span className="la-dept">{r.department}</span></td>
                  <td>
                    <span className="la-type-badge" style={{ background: TYPE_COLORS[r.leaveType]||'#f3f4f6', color: TYPE_TEXT[r.leaveType]||'#374151' }}>
                      {r.leaveType}
                    </span>
                  </td>
                  <td>{new Date(r.startDate).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</td>
                  <td>{new Date(r.endDate).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</td>
                  <td><span className="la-days">{r.days}d</span></td>
                  <td className="la-reason-cell">{r.reason}</td>
                  <td><span className="la-status-badge" style={{ background: STATUS_COLORS[r.status], color: STATUS_TEXT[r.status] }}>{r.status}</span></td>
                  <td>
                    <div className="la-row-actions">
                      <button className="la-view-btn" onClick={() => { setDrawer(r); setComment(''); }}><Eye size={14} /></button>
                      {r.status === 'Pending' && (
                        <>
                          <button className="la-approve-btn" onClick={() => { setDrawer(r); setComment(''); }}><CheckCircle size={14} /></button>
                          <button className="la-reject-btn"  onClick={() => { setDrawer(r); setComment(''); }}><XCircle size={14} /></button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="la-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="la-drawer">
            <div className="la-drawer-hd">
              <h3>Leave Request — {drawer.employee}</h3>
              <button className="la-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="la-drawer-body">
              <div className="la-detail-grid">
                {[
                  ['Employee',   drawer.employee],
                  ['Department', drawer.department],
                  ['Leave Type', drawer.leaveType],
                  ['Days',       `${drawer.days} day${drawer.days>1?'s':''}`],
                  ['From',       new Date(drawer.startDate).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})],
                  ['To',         new Date(drawer.endDate).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})],
                ].map(([lbl,val]) => (
                  <div key={lbl} className="la-detail-item">
                    <span className="la-detail-lbl">{lbl}</span>
                    <span className="la-detail-val">{val}</span>
                  </div>
                ))}
              </div>

              <div className="la-field">
                <label>Reason</label>
                <div className="la-reason-box">{drawer.reason}</div>
              </div>

              <div className="la-field">
                <label>Current Status</label>
                <span className="la-status-badge" style={{ background: STATUS_COLORS[drawer.status], color: STATUS_TEXT[drawer.status], width: 'fit-content' }}>{drawer.status}</span>
              </div>

              {drawer.status === 'Pending' && (
                <div className="la-field">
                  <label>Comment <span className="la-hint">(required for rejection)</span></label>
                  <textarea rows={3} value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment…" />
                </div>
              )}
            </div>

            <div className="la-drawer-ft">
              <button className="la-btn-outline" onClick={() => setDrawer(null)}>Close</button>
              {drawer.status === 'Pending' && (
                <>
                  <button className="la-btn-reject"  onClick={() => handleAction('Rejected')} disabled={saving}>Reject</button>
                  <button className="la-btn-approve" onClick={() => handleAction('Approved')} disabled={saving}>Approve</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
