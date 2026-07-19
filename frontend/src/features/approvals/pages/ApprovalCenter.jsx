import { useState, useEffect, useRef } from "react";
import api from "@/services/api/client";
import "./ApprovalCenter.css";

const TYPE_META = {
  leave:            { bg: '#eef2ff', color: '#4338ca' },
  expense:          { bg: '#fef3c7', color: '#92400e' },
  travel:           { bg: '#f0fdf4', color: '#166534' },
  purchase:         { bg: '#fce7f3', color: '#9d174d' },
  purchase_request: { bg: '#fce7f3', color: '#9d174d' },
  payment:          { bg: '#dcfce7', color: '#15803d' },
  timesheet:        { bg: '#fed7aa', color: '#9a3412' },
  access:           { bg: '#f3e8ff', color: '#7e22ce' },
  recruitment:      { bg: '#cffafe', color: '#155e75' },
  discount:         { bg: '#fdf2f8', color: '#be185d' },
  regularization:   { bg: '#fff7ed', color: '#c2410c' },
  ot:               { bg: '#fef9c3', color: '#854d0e' },
  ecn:              { bg: '#f0f9ff', color: '#0369a1' },
  ncr:              { bg: '#fef2f2', color: '#dc2626' },
  capa:             { bg: '#fdf4ff', color: '#7e22ce' },
  // backend emits 'Payment' for payment_batches — alias
  payment_batches:  { bg: '#dcfce7', color: '#15803d' },
};
const typeMeta = t => TYPE_META[(t || '').toLowerCase()] || { bg: '#f3f4f6', color: '#374151' };

const PRIORITY_META = {
  high:   { bg: '#fee2e2', color: '#dc2626' },
  medium: { bg: '#fef3c7', color: '#92400e' },
  low:    { bg: '#f3f4f6', color: '#6b7280' },
};
const prioMeta = p => PRIORITY_META[(p || '').toLowerCase()] || PRIORITY_META.medium;

const fmt      = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const waitDays = d => d ? Math.floor((Date.now() - new Date(d)) / 86400000) : 0;
const waitHrs  = d => d ? Math.floor((Date.now() - new Date(d)) / 3600000)  : 0;

function rowClass(a) {
  const days = waitDays(a.request_date);
  if (days > 5) return 'row-overdue';
  if (days > 2) return 'row-warning';
  return 'row-new';
}

export default function ApprovalCenter() {
  const [activeTab,           setActiveTab]           = useState('pending');
  const [approvals,           setApprovals]           = useState([]);
  const [history,             setHistory]             = useState([]);
  const [stats,               setStats]               = useState({});
  const [selectedApproval,    setSelectedApproval]    = useState(null);
  const [approvalChain,       setApprovalChain]       = useState([]);
  const [filters,             setFilters]             = useState({ type: '', priority: '', search: '' });
  const [selectedItems,       setSelectedItems]       = useState([]);

  // reject
  const [rejectComment,       setRejectComment]       = useState('');
  const [showRejectModal,     setShowRejectModal]     = useState(false);

  // bulk reject
  const [showBulkRejectModal, setShowBulkRejectModal] = useState(false);
  const [bulkRejectComment,   setBulkRejectComment]   = useState('');

  // delegation
  const [showDelegateModal,   setShowDelegateModal]   = useState(false);
  const [delegateUserId,      setDelegateUserId]      = useState('');
  const [delegateSearch,      setDelegateSearch]      = useState('');
  const [delegateUsers,       setDelegateUsers]       = useState([]);
  const [delegateScope,       setDelegateScope]       = useState('all'); // 'all' | 'selected'
  const [loadingDelegates,    setLoadingDelegates]    = useState(false);

  const [toast,               setToast]               = useState(null);
  const [loadingAppr,         setLoadingAppr]         = useState(false);
  const [loadingStats,        setLoadingStats]        = useState(false);
  const [loadingHistory,      setLoadingHistory]      = useState(false);
  const [actioning,           setActioning]           = useState(null); // id being approved/rejected

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  /* ── Data fetching ── */
  const fetchApprovals = async () => {
    setLoadingAppr(true);
    try {
      const res = await api.get('/approvals/pending');
      if (!isMounted.current) return;
      setApprovals(Array.isArray(res.data) ? res.data : []);
    } catch { if (isMounted.current) showToast('Could not load approvals', 'error'); }
    finally { if (isMounted.current) setLoadingAppr(false); }
  };

  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await api.get('/approvals/history');
      if (!isMounted.current) return;
      setHistory(Array.isArray(res.data) ? res.data : []);
    } catch { if (isMounted.current) showToast('Could not load history', 'error'); }
    finally { if (isMounted.current) setLoadingHistory(false); }
  };

  const fetchStats = async () => {
    setLoadingStats(true);
    try {
      const res = await api.get('/approvals/stats');
      if (!isMounted.current) return;
      setStats(res.data || {});
    } catch { /* Stats supplementary */ }
    finally { if (isMounted.current) setLoadingStats(false); }
  };

  const fetchChain = async (id) => {
    try {
      const res = await api.get(`/approvals/${id}/chain`);
      if (!isMounted.current) return;
      setApprovalChain(Array.isArray(res.data) ? res.data : []);
    } catch { if (isMounted.current) setApprovalChain([]); }
  };

  useEffect(() => { fetchApprovals(); fetchStats(); }, []);
  useEffect(() => { if (activeTab === 'history') fetchHistory(); }, [activeTab]);

  const fetchDelegateUsers = async (q = '') => {
    setLoadingDelegates(true);
    try {
      const res = await api.get('/approvals/delegates', { params: { q } });
      if (!isMounted.current) return;
      setDelegateUsers(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent */ }
    finally { if (isMounted.current) setLoadingDelegates(false); }
  };

  /* ── Actions ── */
  const openDetail = (a) => { setSelectedApproval(a); fetchChain(a.id); };

  // P1 fix: pass request_type so backend can fire module-specific side effects
  const handleApprove = async (id, requestType) => {
    if (actioning) return;
    setActioning(id);
    try {
      await api.post(`/approvals/${id}/approve`, { request_type: requestType });
      if (!isMounted.current) return;
      showToast('Request approved');
      setSelectedItems(prev => prev.filter(i => String(i) !== String(id)));
      setSelectedApproval(null);
      fetchApprovals(); fetchStats();
      window.dispatchEvent(new Event('pulse:approvals-updated'));
    } catch {
      if (isMounted.current) showToast('Failed to approve — try again', 'error');
    } finally {
      if (isMounted.current) setActioning(null);
    }
  };

  const handleReject = async (id) => {
    if (!rejectComment.trim()) return showToast('Please enter a rejection reason', 'error');
    if (actioning) return;
    setActioning(id);
    try {
      await api.post(`/approvals/${id}/reject`, {
        comment: rejectComment,
        request_type: selectedApproval?.request_type,
      });
      if (!isMounted.current) return;
      showToast('Request rejected');
      setSelectedItems(prev => prev.filter(i => String(i) !== String(id)));
      setSelectedApproval(null); setShowRejectModal(false); setRejectComment('');
      fetchApprovals(); fetchStats();
      window.dispatchEvent(new Event('pulse:approvals-updated'));
    } catch {
      if (isMounted.current) showToast('Failed to reject — try again', 'error');
    } finally {
      if (isMounted.current) setActioning(null);
    }
  };

  const handleBulkApprove = async () => {
    if (!selectedItems.length) return;
    try {
      await api.post('/approvals/bulk-approve', { ids: selectedItems });
      showToast(`${selectedItems.length} requests approved`);
      setSelectedItems([]);
      fetchApprovals(); fetchStats();
      window.dispatchEvent(new Event('pulse:approvals-updated'));
    } catch { showToast('Bulk approve failed', 'error'); }
  };

  const handleBulkReject = async () => {
    if (!bulkRejectComment.trim()) return showToast('Please enter a rejection reason', 'error');
    try {
      await api.post('/approvals/bulk-reject', { ids: selectedItems, comment: bulkRejectComment });
      showToast(`${selectedItems.length} requests rejected`);
      setSelectedItems([]); setShowBulkRejectModal(false); setBulkRejectComment('');
      fetchApprovals(); fetchStats();
      window.dispatchEvent(new Event('pulse:approvals-updated'));
    } catch { showToast('Bulk reject failed', 'error'); }
  };

  const handleEscalate = async (id) => {
    try {
      await api.post(`/approvals/${id}/escalate`);
      showToast('Escalated to next approver');
      fetchApprovals();
    } catch { showToast('Escalation failed', 'error'); }
  };

  const handleDelegate = async () => {
    if (!delegateUserId) return showToast('Select a person to delegate to', 'error');
    const ids = delegateScope === 'selected' ? selectedItems : approvals.map(a => a.id);
    if (!ids.length) return showToast('No approvals to delegate', 'error');
    const chosen = delegateUsers.find(u => String(u.id) === String(delegateUserId));
    try {
      await api.post('/approvals/delegate', { ids, delegate_to_user_id: delegateUserId });
      showToast(`${ids.length} approval(s) delegated to ${chosen?.name || 'delegate'}`);
      fetchApprovals();
      setShowDelegateModal(false); setDelegateUserId(''); setDelegateSearch(''); setDelegateUsers([]);
      if (delegateScope === 'selected') setSelectedItems([]);
    } catch { showToast('Delegation failed', 'error'); }
  };

  /* ── Filtering ── */
  const filtered = approvals.filter(a => {
    if (filters.type && (a.request_type || '').toLowerCase() !== filters.type.toLowerCase()) return false;
    if (filters.priority && (a.priority || '').toLowerCase() !== filters.priority.toLowerCase()) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!a.requested_by?.toLowerCase().includes(q) && !a.request_title?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const setF = (k, v) => setFilters(p => ({ ...p, [k]: v }));

  return (
    <div className="approval-center">

      {/* Toast */}
      {toast && (
        <div className={`ac-toast ${toast.type === 'error' ? 'ac-toast-error' : 'ac-toast-success'}`}>
          {toast.msg}
        </div>
      )}

      <h1>Approval Center</h1>

      {/* Stats — 5 cards */}
      <div className="stats-grid">
        {[
          { value: stats.pending ?? approvals.length, label: 'Pending',        cls: '' },
          { value: stats.approvedToday ?? 0,          label: 'Approved Today', cls: '' },
          { value: stats.rejectedToday ?? 0,          label: 'Rejected Today', cls: '' },
          { value: stats.overdue ?? 0,                label: 'Overdue (>48h)', cls: ' overdue' },
          { value: stats.slaCompliance != null ? `${stats.slaCompliance}%` : '—', label: 'SLA Compliance', cls: ' sla' },
        ].map(({ value, label, cls }) => (
          <div key={label} className={`stat-card${cls}`}>
            <span className="stat-value">
              {loadingStats ? <span className="stat-skeleton" /> : value}
            </span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab${activeTab === 'pending' ? ' active' : ''}`} onClick={() => setActiveTab('pending')}>
          Pending Approvals {approvals.length > 0 && `(${approvals.length})`}
        </button>
        <button className={`tab${activeTab === 'history' ? ' active' : ''}`} onClick={() => setActiveTab('history')}>
          My Approval History
        </button>
      </div>

      {activeTab === 'pending' && (
        <>
          <div className="filters-bar">
            <input
              className="search-input"
              placeholder="Search by name or request…"
              value={filters.search}
              onChange={e => setF('search', e.target.value)}
            />
            <select value={filters.type} onChange={e => setF('type', e.target.value)}>
              <option value="">All Types</option>
              {['Leave','Expense','Purchase','Payment','Regularization','OT','ECN']
                .map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={filters.priority} onChange={e => setF('priority', e.target.value)}>
              <option value="">All Priorities</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>

            <button className="btn-delegate" onClick={() => { setDelegateScope('all'); setShowDelegateModal(true); }}>
              Delegate
            </button>

            {selectedItems.length > 0 && (
              <>
                <button className="btn-bulk" onClick={handleBulkApprove}>
                  ✓ Approve {selectedItems.length}
                </button>
                <button className="btn-bulk-reject" onClick={() => setShowBulkRejectModal(true)}>
                  ✗ Reject {selectedItems.length}
                </button>
                <button className="btn-delegate-sel" onClick={() => { setDelegateScope('selected'); setShowDelegateModal(true); }}>
                  Delegate {selectedItems.length}
                </button>
              </>
            )}
          </div>

          <div className="approvals-table-container">
            {loadingAppr ? (
              <div className="ac-empty">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="ac-empty">No pending approvals ✅</div>
            ) : (
              <table className="approvals-table">
                <thead>
                  <tr>
                    <th>
                      <input type="checkbox" onChange={e =>
                        setSelectedItems(e.target.checked ? filtered.map(a => a.id) : [])
                      } />
                    </th>
                    <th>Type</th>
                    <th>Request</th>
                    <th>Requested By</th>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Priority</th>
                    <th>Waiting</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(a => {
                    const tm = typeMeta(a.request_type);
                    const pm = prioMeta(a.priority);
                    const overdue = waitHrs(a.request_date) > 48;
                    return (
                      <tr key={a.id} className={rowClass(a)}>
                        <td>
                          <input type="checkbox"
                            checked={selectedItems.includes(a.id)}
                            onChange={e => setSelectedItems(prev =>
                              e.target.checked ? [...prev, a.id] : prev.filter(i => i !== a.id)
                            )}
                          />
                        </td>
                        <td>
                          <span style={{ display:'inline-block', padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:600, background:tm.bg, color:tm.color }}>
                            {a.request_type}
                          </span>
                        </td>
                        <td style={{ maxWidth: 200 }}>
                          <span>{a.request_title}</span>
                          {overdue && <span className="badge-overdue">Overdue</span>}
                        </td>
                        <td>{a.requested_by}</td>
                        <td style={{ whiteSpace:'nowrap' }}>{fmt(a.request_date)}</td>
                        <td>{a.amount ? `₹${Number(a.amount).toLocaleString('en-IN')}` : '—'}</td>
                        <td>
                          <span style={{ display:'inline-block', padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:600, background:pm.bg, color:pm.color }}>
                            {a.priority}
                          </span>
                        </td>
                        <td style={{ whiteSpace:'nowrap' }}>{waitDays(a.request_date)}d</td>
                        <td className="action-cell">
                          <button className="btn-view"    onClick={() => openDetail(a)}>View</button>
                          <button className="btn-approve" onClick={() => handleApprove(a.id, a.request_type)} title="Approve" disabled={!!actioning} style={actioning === a.id ? { opacity: 0.6, cursor: 'not-allowed' } : {}}>✓</button>
                          <button className="btn-reject"  onClick={() => { setSelectedApproval(a); setShowRejectModal(true); }} title="Reject" disabled={!!actioning}>✗</button>
                          {overdue && (
                            <button className="btn-escalate" onClick={() => handleEscalate(a.id)} title="Escalate to next approver">↑</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {activeTab === 'history' && (
        <div className="history-table-container">
          {loadingHistory ? (
            <div className="ac-empty">Loading history…</div>
          ) : history.length === 0 ? (
            <div className="ac-empty">No approval history yet</div>
          ) : (
            <table className="approvals-table">
              <thead>
                <tr>
                  <th>Type</th><th>Request</th><th>Requested By</th>
                  <th>Decision</th><th>Date</th><th>Comments</th>
                </tr>
              </thead>
              <tbody>
                {history.map(item => {
                  const tm = typeMeta(item.request_type);
                  const dec = (item.status || item.decision || '').toLowerCase();
                  return (
                    <tr key={item.id}>
                      <td>
                        <span style={{ display:'inline-block', padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:600, background:tm.bg, color:tm.color }}>
                          {item.request_type}
                        </span>
                      </td>
                      <td>{item.request_title}</td>
                      <td>{item.requested_by}</td>
                      <td>
                        <span style={{
                          display:'inline-block', padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:600,
                          background: dec === 'approved' ? '#dcfce7' : '#fee2e2',
                          color:      dec === 'approved' ? '#15803d' : '#dc2626',
                        }}>
                          {item.status || item.decision}
                        </span>
                      </td>
                      <td style={{ whiteSpace:'nowrap' }}>{fmt(item.decision_date)}</td>
                      <td>{item.comments || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Detail side panel ── */}
      {selectedApproval && !showRejectModal && (
        <div className="side-panel">
          <div className="panel-overlay" onClick={() => setSelectedApproval(null)} />
          <div className="panel-content">
            <div className="panel-header">
              <h2>Approval Details</h2>
              <button className="close-btn" onClick={() => setSelectedApproval(null)}>×</button>
            </div>
            <div className="panel-body">
              <div className="detail-section">
                <h3>Requester</h3>
                <p><strong>Name:</strong> {selectedApproval.requested_by}</p>
                <p><strong>Department:</strong> {selectedApproval.department || '—'}</p>
                <p><strong>Email:</strong> {selectedApproval.requester_email || '—'}</p>
              </div>
              <div className="detail-section">
                <h3>Request Details</h3>
                <p><strong>Type:</strong> {selectedApproval.request_type}</p>
                <p><strong>Title:</strong> {selectedApproval.request_title}</p>
                <p><strong>Description:</strong> {selectedApproval.description || '—'}</p>
                <p><strong>Amount:</strong> {selectedApproval.amount ? `₹${Number(selectedApproval.amount).toLocaleString('en-IN')}` : 'N/A'}</p>
                <p><strong>Priority:</strong> {selectedApproval.priority}</p>
                <p><strong>Submitted:</strong> {fmt(selectedApproval.request_date)}</p>
                <p><strong>Waiting:</strong> {waitDays(selectedApproval.request_date)} day(s)</p>
              </div>

              {/* Approval chain visualization */}
              {approvalChain.length > 0 && (
                <div className="detail-section">
                  <h3>Approval Chain</h3>
                  <div className="approval-chain">
                    {approvalChain.map((step, i) => {
                      const s = (step.status || 'pending').toLowerCase();
                      return (
                        <div key={i} className={`chain-step chain-step-${s}`}>
                          <div className="chain-dot" />
                          <div className="chain-info">
                            <span className="chain-name">{step.approver_name || step.approver}</span>
                            <span className={`chain-status-badge chain-status-${s}`}>
                              {step.status || 'Pending'}
                            </span>
                            {step.decision_date && (
                              <span className="chain-date">{fmt(step.decision_date)}</span>
                            )}
                            {step.comment && (
                              <span className="chain-comment">"{step.comment}"</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedApproval.attachments && (
                <div className="detail-section">
                  <h3>Attachments</h3>
                  <p>{selectedApproval.attachments}</p>
                </div>
              )}
            </div>
            <div className="panel-footer">
              <button className="btn-approve-large" onClick={() => handleApprove(selectedApproval.id, selectedApproval.request_type)} disabled={!!actioning} style={actioning ? { opacity: 0.6, cursor: 'not-allowed' } : {}}>
                {actioning === selectedApproval.id ? 'Approving…' : '✓ Approve'}
              </button>
              <button className="btn-reject-large" onClick={() => setShowRejectModal(true)} disabled={!!actioning}>
                ✗ Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reject modal ── */}
      {showRejectModal && (
        <div className="modal">
          <div className="modal-overlay" onClick={() => setShowRejectModal(false)} />
          <div className="modal-content">
            <h2>Reject Request</h2>
            <p>Provide a reason for rejection (required):</p>
            <textarea
              rows={4}
              value={rejectComment}
              onChange={e => setRejectComment(e.target.value)}
              placeholder="Enter rejection reason…"
            />
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => { setShowRejectModal(false); setRejectComment(''); }} disabled={!!actioning}>Cancel</button>
              <button className="btn-reject-confirm" onClick={() => handleReject(selectedApproval?.id)} disabled={!!actioning} style={actioning ? { opacity: 0.6, cursor: 'not-allowed' } : {}}>
                {actioning ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk reject modal ── */}
      {showBulkRejectModal && (
        <div className="modal">
          <div className="modal-overlay" onClick={() => setShowBulkRejectModal(false)} />
          <div className="modal-content">
            <h2>Reject {selectedItems.length} Requests</h2>
            <p>This will reject all {selectedItems.length} selected requests. Provide a reason:</p>
            <textarea
              rows={4}
              value={bulkRejectComment}
              onChange={e => setBulkRejectComment(e.target.value)}
              placeholder="Enter rejection reason…"
            />
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => { setShowBulkRejectModal(false); setBulkRejectComment(''); }}>Cancel</button>
              <button className="btn-reject-confirm" onClick={handleBulkReject}>Confirm Reject All</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delegate modal ── */}
      {showDelegateModal && (
        <div className="modal">
          <div className="modal-overlay" onClick={() => { setShowDelegateModal(false); setDelegateUserId(''); setDelegateSearch(''); setDelegateUsers([]); }} />
          <div className="modal-content">
            <h2>Delegate Approvals</h2>
            <p>
              {delegateScope === 'selected'
                ? `Delegate ${selectedItems.length} selected approval(s) to a colleague.`
                : `Delegate all ${approvals.length} pending approval(s) to a colleague.`}
            </p>
            <label className="modal-label">Search colleague</label>
            <input
              className="modal-text-input"
              type="text"
              value={delegateSearch}
              onChange={e => { setDelegateSearch(e.target.value); setDelegateUserId(''); fetchDelegateUsers(e.target.value); }}
              placeholder="Type a name to search…"
              autoFocus
            />
            {loadingDelegates && <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0' }}>Searching…</p>}
            {delegateUsers.length > 0 && !delegateUserId && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 160, overflowY: 'auto', marginTop: 4 }}>
                {delegateUsers.map(u => (
                  <div
                    key={u.id}
                    onClick={() => { setDelegateUserId(u.id); setDelegateSearch(u.name); setDelegateUsers([]); }}
                    style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f5f3ff'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    <strong>{u.name}</strong>
                    {u.designation && <span style={{ color: '#6b7280', marginLeft: 6 }}>{u.designation}</span>}
                  </div>
                ))}
              </div>
            )}
            {delegateUserId && (
              <p style={{ fontSize: 12, color: '#059669', margin: '6px 0' }}>
                ✓ Selected: {delegateSearch}
              </p>
            )}
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => { setShowDelegateModal(false); setDelegateUserId(''); setDelegateSearch(''); setDelegateUsers([]); }}>Cancel</button>
              <button className="btn-delegate-confirm" onClick={handleDelegate} disabled={!delegateUserId}>Confirm Delegation</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}