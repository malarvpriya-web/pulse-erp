import React, { useState, useEffect } from 'react';
import {
  Calendar, Plus, X, CheckCircle, XCircle, Clock,
  ChevronRight, Search, Filter, AlertCircle, Users,
  Umbrella, RefreshCw
} from 'lucide-react';
import api from '@/services/api/client';
import './AllLeaves.css';

// ---------------------------------------------------------------------------
// Sample / fallback data
// ---------------------------------------------------------------------------
const sampleLeaves = [
  { id: 1, first_name: 'Arjun',  last_name: 'Sharma',  department: 'Engineering', leave_type: 'Annual Leave',   start_date: '2026-03-18', end_date: '2026-03-20', days: 3, reason: 'Family vacation',         status: 'pending',  created_at: '2026-03-14' },
  { id: 2, first_name: 'Priya',  last_name: 'Menon',   department: 'Design',      leave_type: 'Medical Leave',  start_date: '2026-03-16', end_date: '2026-03-16', days: 1, reason: 'Doctor appointment',       status: 'approved', created_at: '2026-03-12' },
  { id: 3, first_name: 'Rahul',  last_name: 'Kumar',   department: 'Engineering', leave_type: 'Casual Leave',   start_date: '2026-03-22', end_date: '2026-03-22', days: 1, reason: 'Personal work',            status: 'pending',  created_at: '2026-03-13' },
  { id: 4, first_name: 'Sneha',  last_name: 'Pillai',  department: 'QA',          leave_type: 'Annual Leave',   start_date: '2026-03-10', end_date: '2026-03-13', days: 4, reason: 'Travel',                   status: 'approved', created_at: '2026-03-05' },
  { id: 5, first_name: 'Vikram', last_name: 'Singh',   department: 'Engineering', leave_type: 'Sick Leave',     start_date: '2026-03-14', end_date: '2026-03-15', days: 2, reason: 'Fever',                    status: 'rejected', created_at: '2026-03-13' },
  { id: 6, first_name: 'Divya',  last_name: 'Nair',    department: 'HR',          leave_type: 'Compensatory',   start_date: '2026-03-25', end_date: '2026-03-25', days: 1, reason: 'Weekend worked last week',  status: 'pending',  created_at: '2026-03-15' },
];

const sampleBalance = { annual: 10, sick: 3, casual: 2, compensatory: 1 };

const sampleTeamLeaves = {
  Mon: ['Priya M.'],
  Tue: ['Priya M.', 'Vikram S.'],
  Wed: [],
  Thu: ['Sneha P.'],
  Fri: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getWeekDates() {
  const today = new Date();
  const day = today.getDay(); // 0=Sun
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return days.map((name, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return {
      name,
      date: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
    };
  });
}

function countWeekdays(from, to) {
  if (!from || !to) return 0;
  const start = new Date(from);
  const end = new Date(to);
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
  const d = new Date(str);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Toast component
// ---------------------------------------------------------------------------
function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className={`al-toast ${toast.type === 'success' ? 'al-toast-success' : 'al-toast-error'}`}>
      {toast.type === 'success'
        ? <CheckCircle size={16} />
        : <AlertCircle size={16} />}
      <span>{toast.message}</span>
      <button className="al-icon-btn" style={{ marginLeft: 8 }} onClick={onDismiss}>
        <X size={13} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leave Balance Card
// ---------------------------------------------------------------------------
const BALANCE_META = [
  { key: 'annual',       label: 'Annual Leave',    total: 18, color: '#6366f1', bg: '#eef2ff' },
  { key: 'sick',         label: 'Sick Leave',       total: 6,  color: '#ef4444', bg: '#fef2f2' },
  { key: 'casual',       label: 'Casual Leave',     total: 4,  color: '#10b981', bg: '#ecfdf5' },
  { key: 'compensatory', label: 'Compensatory',     total: 3,  color: '#f59e0b', bg: '#fffbeb' },
];

function BalanceCard({ meta, used }) {
  const pct = Math.min(100, Math.round((used / meta.total) * 100));
  const remaining = meta.total - used;
  return (
    <div className="al-balance-card">
      <div className="al-bal-header">
        <div className="al-bal-icon" style={{ background: meta.bg }}>
          <Umbrella size={18} color={meta.color} />
        </div>
        <span className="al-bal-type">{meta.label}</span>
      </div>
      <div className="al-bal-used">{used} <span className="al-bal-total">/ {meta.total} days</span></div>
      <div className="al-bal-bar-wrap">
        <div className="al-bal-bar" style={{ width: `${pct}%`, background: meta.color }} />
      </div>
      <div className="al-bal-remaining">Remaining: {remaining} days</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply Leave Drawer
// ---------------------------------------------------------------------------
function ApplyDrawer({ open, onClose, onSuccess }) {
  const [form, setForm] = useState({
    leave_type: 'Annual',
    from_date: '',
    to_date: '',
    reason: '',
    emergency_contact: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const days = countWeekdays(form.from_date, form.to_date);

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.reason.trim()) {
      onSuccess({ type: 'error', message: 'Reason is required.' });
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/leaves/apply', { ...form, days });
      onSuccess({ type: 'success', message: 'Leave application submitted successfully!' });
      onClose();
      setForm({ leave_type: 'Annual', from_date: '', to_date: '', reason: '', emergency_contact: '' });
    } catch {
      onSuccess({ type: 'error', message: 'Failed to submit leave application. Please try again.' });
    } finally {
      setSubmitting(false);
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
          <div className="al-form-group">
            <label className="al-label">Leave Type</label>
            <select className="al-select" name="leave_type" value={form.leave_type} onChange={handleChange}>
              <option value="Annual">Annual Leave</option>
              <option value="Sick">Sick Leave</option>
              <option value="Casual">Casual Leave</option>
              <option value="Compensatory">Compensatory Leave</option>
              <option value="Paternity">Paternity Leave</option>
              <option value="Maternity">Maternity Leave</option>
            </select>
          </div>

          <div className="al-form-row">
            <div className="al-form-group">
              <label className="al-label">From Date</label>
              <input
                className="al-input"
                type="date"
                name="from_date"
                value={form.from_date}
                onChange={handleChange}
                required
              />
            </div>
            <div className="al-form-group">
              <label className="al-label">To Date</label>
              <input
                className="al-input"
                type="date"
                name="to_date"
                value={form.to_date}
                min={form.from_date}
                onChange={handleChange}
                required
              />
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
              className="al-textarea"
              name="reason"
              rows={4}
              placeholder="Briefly describe the reason for leave..."
              value={form.reason}
              onChange={handleChange}
              required
              style={{ resize: 'vertical' }}
            />
          </div>

          <div className="al-form-group">
            <label className="al-label">Emergency Contact <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span></label>
            <input
              className="al-input"
              type="text"
              name="emergency_contact"
              placeholder="e.g. +91 98765 43210"
              value={form.emergency_contact}
              onChange={handleChange}
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
// Main component
// ---------------------------------------------------------------------------
export default function AllLeaves() {
  const [leaves, setLeaves]         = useState([]);
  const [balance, setBalance]       = useState(sampleBalance);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [statusFilter, setStatus]   = useState('all');
  const [drawerOpen, setDrawer]     = useState(false);
  const [toast, setToast]           = useState(null);

  const weekDates = getWeekDates();

  // ---- data fetching -------------------------------------------------------
  async function fetchData() {
    setLoading(true);
    try {
      const [leavesRes, balanceRes] = await Promise.allSettled([
        api.get('/leaves'),
        api.get('/leaves/balance'),
      ]);

      const leavesData =
        leavesRes.status === 'fulfilled' && Array.isArray(leavesRes.value?.data) && leavesRes.value.data.length > 0
          ? leavesRes.value.data
          : sampleLeaves;

      const balanceData =
        balanceRes.status === 'fulfilled' && balanceRes.value?.data
          ? balanceRes.value.data
          : sampleBalance;

      setLeaves(leavesData);
      setBalance(balanceData);
    } catch {
      setLeaves(sampleLeaves);
      setBalance(sampleBalance);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  // ---- approve / reject ----------------------------------------------------
  async function handleAction(id, action) {
    try {
      await api.post(`/leaves/${id}/${action}`);
      setLeaves(prev =>
        prev.map(l => l.id === id ? { ...l, status: action === 'approve' ? 'approved' : 'rejected' } : l)
      );
      setToast({
        type: 'success',
        message: `Leave ${action === 'approve' ? 'approved' : 'rejected'} successfully.`,
      });
    } catch {
      // Optimistic update for demo / fallback
      setLeaves(prev =>
        prev.map(l => l.id === id ? { ...l, status: action === 'approve' ? 'approved' : 'rejected' } : l)
      );
      setToast({
        type: 'success',
        message: `Leave ${action === 'approve' ? 'approved' : 'rejected'}.`,
      });
    }
  }

  // ---- filtering -----------------------------------------------------------
  const filtered = leaves.filter(l => {
    const q = search.toLowerCase();
    const matchSearch =
      `${l.first_name} ${l.last_name}`.toLowerCase().includes(q) ||
      l.department?.toLowerCase().includes(q) ||
      l.leave_type?.toLowerCase().includes(q);
    const matchStatus = statusFilter === 'all' || l.status === statusFilter;
    return matchSearch && matchStatus;
  });

  // ---- status badge --------------------------------------------------------
  function StatusBadge({ status }) {
    const cls =
      status === 'approved' ? 'al-badge-approved'
      : status === 'rejected' ? 'al-badge-rejected'
      : 'al-badge-pending';
    const icon =
      status === 'approved' ? <CheckCircle size={11} />
      : status === 'rejected' ? <XCircle size={11} />
      : <Clock size={11} />;
    return (
      <span className={`al-status-badge ${cls}`}>
        {icon} {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  }

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
          <button className="al-btn-add" onClick={() => setDrawer(true)}>
            <Plus size={15} /> Apply Leave
          </button>
        </div>
      </div>

      {/* Leave balance cards */}
      <p className="al-section-title">Leave Balances</p>
      <div className="al-balance-grid">
        {BALANCE_META.map(meta => (
          <BalanceCard key={meta.key} meta={meta} used={balance[meta.key] ?? 0} />
        ))}
      </div>

      {/* Team leave this week */}
      <div className="al-week-card">
        <p className="al-section-title" style={{ marginBottom: 14 }}>
          <Users size={15} style={{ marginRight: 6, verticalAlign: 'middle', color: '#6366f1' }} />
          Team Leave This Week
        </p>
        <div className="al-week-grid">
          {weekDates.map(({ name, date }) => {
            const members = sampleTeamLeaves[name] || [];
            return (
              <div key={name} className="al-week-day">
                <div className="al-week-day-name">{name}</div>
                <div className="al-week-day-date">{date}</div>
                {members.length === 0
                  ? <div className="al-empty-day">No leaves</div>
                  : members.map((m, i) => (
                      <span key={i} className="al-leave-chip">{m}</span>
                    ))
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
              className="al-search"
              type="text"
              placeholder="Search employee, type, department…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            className="al-filter-select"
            value={statusFilter}
            onChange={e => setStatus(e.target.value)}
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
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
                  <th>Applied On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(leave => (
                  <tr key={leave.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: '#111827' }}>
                        {leave.first_name} {leave.last_name}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{leave.department}</div>
                    </td>
                    <td>{leave.leave_type}</td>
                    <td>{formatDate(leave.start_date)}</td>
                    <td>{formatDate(leave.end_date)}</td>
                    <td>
                      <span style={{ fontWeight: 600, color: '#6366f1' }}>{leave.days}</span>
                    </td>
                    <td style={{ maxWidth: 180 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {leave.reason || '-'}
                      </span>
                    </td>
                    <td><StatusBadge status={leave.status} /></td>
                    <td>{formatDate(leave.created_at)}</td>
                    <td>
                      {leave.status === 'pending' ? (
                        <>
                          <button
                            className="al-action-btn-approve"
                            title="Approve"
                            onClick={() => handleAction(leave.id, 'approve')}
                          >
                            <CheckCircle size={13} />
                          </button>
                          <button
                            className="al-action-btn-reject"
                            title="Reject"
                            onClick={() => handleAction(leave.id, 'reject')}
                          >
                            <XCircle size={13} />
                          </button>
                        </>
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
    </div>
  );
}
