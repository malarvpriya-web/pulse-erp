import { useState, useEffect, useCallback } from 'react';
import { Search, X, CheckCircle, XCircle, Eye, Clock } from 'lucide-react';
import api from '@/services/api/client';
import './TimesheetApprovals.css';

const SAMPLE = [
  { id: 1, employee: 'Sneha Iyer',   department: 'Finance',     weekOf: '2026-03-10', totalHours: 42, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Budget Review',    hours: 8 },
      { day: 'Tue', project: 'Invoice Processing', hours: 9 },
      { day: 'Wed', project: 'Budget Review',    hours: 8 },
      { day: 'Thu', project: 'Team Meeting',     hours: 7 },
      { day: 'Fri', project: 'Reporting',        hours: 10 },
    ]
  },
  { id: 2, employee: 'Rohit Gupta',  department: 'Operations',  weekOf: '2026-03-10', totalHours: 40, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Ops Planning',     hours: 8 },
      { day: 'Tue', project: 'Vendor Calls',     hours: 8 },
      { day: 'Wed', project: 'Ops Planning',     hours: 8 },
      { day: 'Thu', project: 'Process Review',   hours: 8 },
      { day: 'Fri', project: 'Documentation',    hours: 8 },
    ]
  },
  { id: 3, employee: 'Kiran Das',    department: 'Engineering', weekOf: '2026-03-10', totalHours: 45, status: 'Approved',
    breakdown: [
      { day: 'Mon', project: 'Feature Dev',      hours: 9 },
      { day: 'Tue', project: 'Feature Dev',      hours: 9 },
      { day: 'Wed', project: 'Code Review',      hours: 9 },
      { day: 'Thu', project: 'Feature Dev',      hours: 9 },
      { day: 'Fri', project: 'Bug Fixes',        hours: 9 },
    ]
  },
  { id: 4, employee: 'Meera Joshi',  department: 'Engineering', weekOf: '2026-03-03', totalHours: 38, status: 'Rejected',
    breakdown: [
      { day: 'Mon', project: 'Backend API',      hours: 8 },
      { day: 'Tue', project: 'Backend API',      hours: 7 },
      { day: 'Wed', project: 'Testing',          hours: 8 },
      { day: 'Thu', project: 'Testing',          hours: 7 },
      { day: 'Fri', project: 'Deployment',       hours: 8 },
    ]
  },
  { id: 5, employee: 'Vikram Singh', department: 'Sales',       weekOf: '2026-03-10', totalHours: 41, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Client Calls',     hours: 8 },
      { day: 'Tue', project: 'Proposal Writing', hours: 9 },
      { day: 'Wed', project: 'Client Calls',     hours: 8 },
      { day: 'Thu', project: 'Pipeline Review',  hours: 8 },
      { day: 'Fri', project: 'CRM Update',       hours: 8 },
    ]
  },
  { id: 6, employee: 'Anika Patel',  department: 'HR',          weekOf: '2026-03-10', totalHours: 40, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Recruitment',      hours: 8 },
      { day: 'Tue', project: 'Onboarding',       hours: 8 },
      { day: 'Wed', project: 'Recruitment',      hours: 8 },
      { day: 'Thu', project: 'Payroll',          hours: 8 },
      { day: 'Fri', project: 'HR Meetings',      hours: 8 },
    ]
  },
];

const TABS = ['All', 'Pending', 'Approved', 'Rejected'];
const STATUS_COLORS = { Pending: '#fef3c7', Approved: '#dcfce7', Rejected: '#fee2e2' };
const STATUS_TEXT   = { Pending: '#92400e', Approved: '#15803d', Rejected: '#991b1b' };

function fmtWeek(dateStr) {
  const d = new Date(dateStr);
  const end = new Date(d); end.setDate(d.getDate() + 4);
  const fmt = dt => dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  return `${fmt(d)} – ${fmt(end)}`;
}

export default function TimesheetApprovals() {
  const [sheets, setSheets]   = useState(SAMPLE);
  const [loading, setLoading] = useState(false);
  const [fTab, setFTab]       = useState('Pending');
  const [search, setSearch]   = useState('');
  const [drawer, setDrawer]   = useState(null);
  const [comment, setComment] = useState('');
  const [saving, setSaving]   = useState(false);
  const [toast, setToast]     = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = fTab !== 'All' ? { status: fTab } : {};
      const res = await api.get('/timesheets/approvals', { params });
      const raw = res.data?.data ?? res.data;
      setSheets(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setSheets(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? sheets.length : sheets.filter(s => s.status === t).length
  }), {});

  const filtered = sheets.filter(s =>
    (fTab === 'All' || s.status === fTab) &&
    (s.employee?.toLowerCase().includes(search.toLowerCase()) ||
     s.department?.toLowerCase().includes(search.toLowerCase()))
  );

  const handleAction = async (action) => {
    if (action === 'Rejected' && !comment.trim()) { showToast('Comment required for rejection', 'error'); return; }
    setSaving(true);
    const id = drawer.id;
    try {
      await api.put(`/timesheets/${id}/status`, { status: action, comment });
    } catch { /* optimistic */ }
    setSheets(prev => prev.map(s => s.id === id ? { ...s, status: action } : s));
    showToast(`Timesheet ${action === 'Approved' ? 'approved' : 'rejected'}!`);
    setDrawer(null); setComment(''); setSaving(false);
  };

  return (
    <div className="tsa-root">
      {toast && <div className={`tsa-toast tsa-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="tsa-header">
        <div>
          <h1 className="tsa-title">Timesheet Approvals</h1>
          <p className="tsa-sub">Review and approve submitted timesheets from your team</p>
        </div>
      </div>

      <div className="tsa-filters">
        <div className="tsa-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search employee or department…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="tsa-tabs">
          {TABS.map(t => (
            <button key={t} className={`tsa-tab ${fTab === t ? 'tsa-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="tsa-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tsa-loading"><div className="tsa-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="tsa-empty"><Clock size={32} color="#d1d5db" /><p>No timesheets found</p></div>
      ) : (
        <div className="tsa-table-wrap">
          <table className="tsa-table">
            <thead>
              <tr><th>Employee</th><th>Department</th><th>Week Of</th><th>Total Hours</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id} className="tsa-row">
                  <td>
                    <div className="tsa-emp">
                      <div className="tsa-avatar">{s.employee.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                      {s.employee}
                    </div>
                  </td>
                  <td><span className="tsa-dept">{s.department}</span></td>
                  <td className="tsa-week">{fmtWeek(s.weekOf)}</td>
                  <td>
                    <span className={`tsa-hours ${s.totalHours > 44 ? 'tsa-hours-over' : ''}`}>
                      {s.totalHours}h
                    </span>
                  </td>
                  <td>
                    <span className="tsa-status-badge" style={{ background: STATUS_COLORS[s.status], color: STATUS_TEXT[s.status] }}>
                      {s.status}
                    </span>
                  </td>
                  <td>
                    <div className="tsa-row-actions">
                      <button className="tsa-view-btn" onClick={() => { setDrawer(s); setComment(''); }}><Eye size={14} /></button>
                      {s.status === 'Pending' && (
                        <>
                          <button className="tsa-approve-btn" onClick={() => { setDrawer(s); setComment(''); }}><CheckCircle size={14} /></button>
                          <button className="tsa-reject-btn"  onClick={() => { setDrawer(s); setComment(''); }}><XCircle size={14} /></button>
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
        <div className="tsa-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="tsa-drawer">
            <div className="tsa-drawer-hd">
              <h3>Timesheet — {drawer.employee}</h3>
              <button className="tsa-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="tsa-drawer-body">
              <div className="tsa-detail-grid">
                {[
                  ['Employee',   drawer.employee],
                  ['Department', drawer.department],
                  ['Week',       fmtWeek(drawer.weekOf)],
                  ['Total Hours', `${drawer.totalHours}h`],
                ].map(([lbl, val]) => (
                  <div key={lbl} className="tsa-detail-item">
                    <span className="tsa-detail-lbl">{lbl}</span>
                    <span className="tsa-detail-val">{val}</span>
                  </div>
                ))}
              </div>

              <div className="tsa-section-lbl">Weekly Breakdown</div>
              <div className="tsa-breakdown">
                <table className="tsa-break-table">
                  <thead>
                    <tr><th>Day</th><th>Project / Task</th><th>Hours</th></tr>
                  </thead>
                  <tbody>
                    {drawer.breakdown?.map((row, i) => (
                      <tr key={i}>
                        <td className="tsa-break-day">{row.day}</td>
                        <td className="tsa-break-proj">{row.project}</td>
                        <td className="tsa-break-hrs">{row.hours}h</td>
                      </tr>
                    ))}
                    <tr className="tsa-break-total">
                      <td colSpan={2}>Total</td>
                      <td>{drawer.totalHours}h</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="tsa-field">
                <label>Current Status</label>
                <span className="tsa-status-badge" style={{ background: STATUS_COLORS[drawer.status], color: STATUS_TEXT[drawer.status], width: 'fit-content' }}>
                  {drawer.status}
                </span>
              </div>

              {drawer.status === 'Pending' && (
                <div className="tsa-field">
                  <label>Comment <span className="tsa-hint">(required for rejection)</span></label>
                  <textarea rows={3} value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment…" />
                </div>
              )}
            </div>

            <div className="tsa-drawer-ft">
              <button className="tsa-btn-outline" onClick={() => setDrawer(null)}>Close</button>
              {drawer.status === 'Pending' && (
                <>
                  <button className="tsa-btn-reject"  onClick={() => handleAction('Rejected')} disabled={saving}>Reject</button>
                  <button className="tsa-btn-approve" onClick={() => handleAction('Approved')} disabled={saving}>Approve</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
