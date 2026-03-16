import { useState, useEffect, useCallback } from 'react';
import { Search, X, CheckCircle, XCircle, Eye, Plane } from 'lucide-react';
import api from '@/services/api/client';
import './TravelApprovals.css';

const SAMPLE = [
  { id: 1, requestNo: 'TR-006', employee: 'Vikram Singh', department: 'Sales', purpose: 'Customer Visit', fromCity: 'Pune', toCity: 'Nagpur', travelDate: '2026-03-22', returnDate: '2026-03-23', mode: 'Train', estimatedBudget: 5200, advanceRequired: true, status: 'Pending' },
  { id: 2, requestNo: 'TR-007', employee: 'Meera Joshi', department: 'Engineering', purpose: 'Tech Conference', fromCity: 'Pune', toCity: 'Bengaluru', travelDate: '2026-03-28', returnDate: '2026-03-30', mode: 'Air', estimatedBudget: 20000, advanceRequired: true, status: 'Pending' },
  { id: 3, requestNo: 'TR-008', employee: 'Suresh Nair', department: 'Finance', purpose: 'Board Meeting', fromCity: 'Pune', toCity: 'Mumbai', travelDate: '2026-03-19', returnDate: '2026-03-19', mode: 'Car', estimatedBudget: 3000, advanceRequired: false, status: 'Approved' },
  { id: 4, requestNo: 'TR-009', employee: 'Anika Patel', department: 'HR', purpose: 'Recruitment Drive', fromCity: 'Pune', toCity: 'Delhi', travelDate: '2026-03-15', returnDate: '2026-03-16', mode: 'Air', estimatedBudget: 14000, advanceRequired: true, status: 'Rejected' },
  { id: 5, requestNo: 'TR-010', employee: 'Rohit Gupta', department: 'Operations', purpose: 'Site Inspection', fromCity: 'Pune', toCity: 'Kolkata', travelDate: '2026-04-05', returnDate: '2026-04-07', mode: 'Air', estimatedBudget: 25000, advanceRequired: true, status: 'Pending' },
];

const TABS = ['All', 'Pending', 'Approved', 'Rejected'];
const STATUS_COLORS = { Pending: '#fef3c7', Approved: '#dcfce7', Rejected: '#fee2e2' };
const STATUS_TEXT   = { Pending: '#92400e', Approved: '#15803d', Rejected: '#991b1b' };
const fmt = n => `₹${Number(n).toLocaleString('en-IN')}`;

export default function TravelApprovals() {
  const [approvals, setApprovals] = useState(SAMPLE);
  const [loading, setLoading]     = useState(false);
  const [fTab, setFTab]           = useState('Pending');
  const [search, setSearch]       = useState('');
  const [drawer, setDrawer]       = useState(null);
  const [comment, setComment]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fTab !== 'All') params.status = fTab;
      const res = await api.get('/travel/approvals', { params });
      const raw = res.data?.data ?? res.data;
      setApprovals(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setApprovals(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const counts = TABS.reduce((acc, t) => ({
    ...acc,
    [t]: t === 'All' ? approvals.length : approvals.filter(a => a.status === t).length
  }), {});

  const filtered = approvals.filter(a =>
    (fTab === 'All' || a.status === fTab) &&
    (a.employee?.toLowerCase().includes(search.toLowerCase()) ||
     a.purpose?.toLowerCase().includes(search.toLowerCase()) ||
     a.requestNo?.toLowerCase().includes(search.toLowerCase()))
  );

  const handleAction = async (action) => {
    if (action === 'Rejected' && !comment.trim()) { showToast('Comment required for rejection', 'error'); return; }
    setSaving(true);
    const id = drawer.id;
    try {
      await api.put(`/travel/requests/${id}/status`, { status: action, comment });
      showToast(`Request ${action === 'Approved' ? 'approved' : 'rejected'}!`);
    } catch {
      showToast(`Request ${action === 'Approved' ? 'approved' : 'rejected'} (offline)`);
    }
    setApprovals(prev => prev.map(a => a.id === id ? { ...a, status: action } : a));
    setDrawer(null);
    setComment('');
    setSaving(false);
  };

  return (
    <div className="tva-root">
      {toast && <div className={`tva-toast tva-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="tva-header">
        <div>
          <h1 className="tva-title">Travel Approvals</h1>
          <p className="tva-sub">Review and approve travel requests from your team</p>
        </div>
      </div>

      <div className="tva-filters">
        <div className="tva-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search by employee, purpose…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="tva-tabs">
          {TABS.map(t => (
            <button key={t} className={`tva-tab ${fTab === t ? 'tva-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="tva-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tva-loading"><div className="tva-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="tva-empty"><Plane size={32} color="#d1d5db" /><p>No requests to review</p></div>
      ) : (
        <div className="tva-table-wrap">
          <table className="tva-table">
            <thead>
              <tr><th>Request #</th><th>Employee</th><th>Department</th><th>Purpose</th><th>Route</th><th>Date</th><th>Budget</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="tva-row">
                  <td><span className="tva-num">{r.requestNo}</span></td>
                  <td><div className="tva-emp"><div className="tva-avatar">{r.employee.split(' ').map(w => w[0]).join('').slice(0,2)}</div>{r.employee}</div></td>
                  <td><span className="tva-dept">{r.department}</span></td>
                  <td>{r.purpose}</td>
                  <td>{r.fromCity} → {r.toCity}</td>
                  <td>{new Date(r.travelDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</td>
                  <td><span className="tva-amount">{fmt(r.estimatedBudget)}</span></td>
                  <td><span className="tva-badge" style={{ background: STATUS_COLORS[r.status], color: STATUS_TEXT[r.status] }}>{r.status}</span></td>
                  <td>
                    <div className="tva-row-actions">
                      <button className="tva-view-btn" onClick={() => { setDrawer(r); setComment(''); }} title="Review"><Eye size={14} /></button>
                      {r.status === 'Pending' && <>
                        <button className="tva-approve-btn" onClick={() => { setDrawer(r); setComment(''); }} title="Approve"><CheckCircle size={14} /></button>
                        <button className="tva-reject-btn"  onClick={() => { setDrawer(r); setComment(''); }} title="Reject"><XCircle size={14} /></button>
                      </>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="tva-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="tva-drawer">
            <div className="tva-drawer-hd">
              <h3>Review — {drawer.requestNo}</h3>
              <button className="tva-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="tva-drawer-body">
              <div className="tva-detail-grid">
                {[
                  ['Employee', drawer.employee], ['Department', drawer.department],
                  ['Purpose', drawer.purpose], ['Mode', drawer.mode],
                  ['From City', drawer.fromCity], ['To City', drawer.toCity],
                  ['Travel Date', new Date(drawer.travelDate).toLocaleDateString('en-IN')],
                  ['Return Date', drawer.returnDate ? new Date(drawer.returnDate).toLocaleDateString('en-IN') : '—'],
                  ['Budget', fmt(drawer.estimatedBudget)], ['Advance Required', drawer.advanceRequired ? 'Yes' : 'No'],
                ].map(([lbl, val]) => (
                  <div key={lbl} className="tva-detail-item">
                    <span className="tva-detail-lbl">{lbl}</span>
                    <span className="tva-detail-val">{val}</span>
                  </div>
                ))}
              </div>

              <div className="tva-field">
                <label>Status</label>
                <span className="tva-badge" style={{ background: STATUS_COLORS[drawer.status], color: STATUS_TEXT[drawer.status], width: 'fit-content' }}>{drawer.status}</span>
              </div>

              {drawer.status === 'Pending' && (
                <div className="tva-field">
                  <label>Comment {drawer.status === 'Pending' ? '' : ''}</label>
                  <textarea rows={3} value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment (required for rejection)…" />
                </div>
              )}
            </div>
            {drawer.status === 'Pending' && (
              <div className="tva-drawer-ft">
                <button className="tva-btn-outline" onClick={() => setDrawer(null)}>Close</button>
                <button className="tva-btn-reject" onClick={() => handleAction('Rejected')} disabled={saving}>Reject</button>
                <button className="tva-btn-approve" onClick={() => handleAction('Approved')} disabled={saving}>Approve</button>
              </div>
            )}
            {drawer.status !== 'Pending' && (
              <div className="tva-drawer-ft">
                <button className="tva-btn-outline" onClick={() => setDrawer(null)}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
