import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FileEdit, CheckCircle, X, Clock, AlertCircle,
  RefreshCw, User, ChevronDown, Calendar, Filter,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 };

const STATUS_META = {
  pending:  { bg: '#fef3c7', color: '#92400e', label: 'Pending',  Icon: Clock },
  approved: { bg: '#dcfce7', color: '#166534', label: 'Approved', Icon: CheckCircle },
  rejected: { bg: '#fee2e2', color: '#991b1b', label: 'Rejected', Icon: X },
};

function fmt(t) { return t ? String(t).slice(0, 5) : '--'; }

// ─── Individual request card ───────────────────────────────────────────────

function RequestCard({ req, onApprove, onReject }) {
  const [expanded, setExpanded]   = useState(false);
  const [showModal, setShowModal] = useState(null); // 'approve' | 'reject'
  const [remarks, setRemarks]     = useState('');
  const [busy, setBusy]           = useState(false);

  const sm = STATUS_META[req.status] || STATUS_META.pending;

  const act = async (type) => {
    setBusy(true);
    try {
      await (type === 'approve' ? onApprove(req.id, remarks) : onReject(req.id, remarks));
      setShowModal(null);
      setRemarks('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...CARD, marginBottom: 10, padding: 0, overflow: 'hidden' }}>
      {/* ── Header row ── */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        {/* Avatar */}
        <div style={{
          width: 36, height: 36, borderRadius: 10, background: '#f5f3ff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <User size={16} color={P} />
        </div>

        {/* Name + dept */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>
            {req.employee_name}
            {req.emp_code && (
              <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6, fontWeight: 400 }}>
                #{req.emp_code}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {[req.department, req.designation].filter(Boolean).join(' · ')} &nbsp;·&nbsp; {req.date}
          </div>
        </div>

        {/* Times + status + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
            {fmt(req.check_in)} → {fmt(req.check_out)}
          </span>

          <span style={{
            padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600,
            background: sm.bg, color: sm.color,
          }}>
            {sm.label}
          </span>

          {req.status === 'pending' && (
            <>
              <button
                onClick={e => { e.stopPropagation(); setShowModal('approve'); }}
                style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#dcfce7', color: '#166534', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}
              >
                Approve
              </button>
              <button
                onClick={e => { e.stopPropagation(); setShowModal('reject'); }}
                style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#fee2e2', color: '#991b1b', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}
              >
                Reject
              </button>
            </>
          )}

          <ChevronDown
            size={14} color="#9ca3af"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
          />
        </div>
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div style={{ borderTop: '1px solid #f0f0f4', padding: '14px 18px', background: '#fafafa' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Requested In</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{fmt(req.check_in)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Requested Out</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{fmt(req.check_out)}</div>
            </div>
          </div>

          <div style={{ fontSize: 13, color: '#374151', marginBottom: 8 }}>
            <strong>Reason: </strong>{req.reason}
          </div>

          {req.manager_remarks && (
            <div style={{ fontSize: 13, color: '#374151', marginBottom: 6 }}>
              <strong>Remarks: </strong>{req.manager_remarks}
            </div>
          )}

          <div style={{ fontSize: 12, color: '#9ca3af' }}>
            Submitted: {new Date(req.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}

      {/* ── Action modal ── */}
      {showModal && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200 }}
            onClick={() => setShowModal(null)}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            background: '#fff', borderRadius: 16, padding: 28, zIndex: 201,
            width: 440, maxWidth: 'calc(100vw - 32px)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 4 }}>
              {showModal === 'approve' ? 'Approve Regularization' : 'Reject Regularization'}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
              <strong>{req.employee_name}</strong> &nbsp;·&nbsp; {req.date}
            </div>

            {/* Times summary */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, background: '#f9fafb', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>IN TIME</div>
                <div style={{ fontWeight: 700, color: '#111827', fontSize: 15 }}>{fmt(req.check_in)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>OUT TIME</div>
                <div style={{ fontWeight: 700, color: '#111827', fontSize: 15 }}>{fmt(req.check_out)}</div>
              </div>
            </div>

            {/* Employee's reason */}
            <div style={{ fontSize: 13, color: '#374151', background: '#f9fafb', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
              {req.reason}
            </div>

            <textarea
              autoFocus
              placeholder={showModal === 'reject' ? 'Rejection reason (required)…' : 'Remarks (optional)…'}
              value={remarks}
              onChange={e => setRemarks(e.target.value)}
              rows={3}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
            />

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                onClick={() => act(showModal)}
                disabled={busy || (showModal === 'reject' && !remarks.trim())}
                style={{
                  flex: 1, padding: 10, borderRadius: 8, border: 'none', fontWeight: 600,
                  cursor: busy || (showModal === 'reject' && !remarks.trim()) ? 'not-allowed' : 'pointer',
                  background: showModal === 'approve' ? '#10b981' : '#ef4444',
                  color: '#fff', fontSize: 14,
                  opacity: (busy || (showModal === 'reject' && !remarks.trim())) ? 0.6 : 1,
                }}
              >
                {busy ? 'Processing…' : (showModal === 'approve' ? 'Approve' : 'Reject')}
              </button>
              <button
                onClick={() => setShowModal(null)}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function RegularizationApprovals() {
  const { user, role } = useAuth();

  const [requests,  setRequests]  = useState([]);
  const [stats,     setStats]     = useState({ pending: 0, approved: 0, rejected: 0 });
  const [deptList,  setDeptList]  = useState([]);
  const [filter,    setFilter]    = useState('pending');
  const [dept,      setDept]      = useState('');
  const [fromDate,  setFromDate]  = useState('');
  const [toDate,    setToDate]    = useState('');
  const [loading,   setLoading]   = useState(true);
  const [toast,     setToast]     = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Stats are fetched independently — never affected by the list filter
  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/attendance/regularize/stats');
      if (isMounted.current) setStats(res.data || { pending: 0, approved: 0, rejected: 0 });
    } catch { /* non-blocking */ }
  }, []);

  const loadDepts = useCallback(async () => {
    try {
      const res = await api.get('/attendance/regularize/departments');
      if (isMounted.current) setDeptList(Array.isArray(res.data) ? res.data : []);
    } catch { /* non-blocking */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: filter });
      if (dept)     params.set('department', dept);
      if (fromDate) params.set('from', fromDate);
      if (toDate)   params.set('to', toDate);
      const res = await api.get(`/attendance/regularize/list?${params}`);
      if (isMounted.current) setRequests(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (isMounted.current) setRequests([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [filter, dept, fromDate, toDate]);

  // Load stats + departments once on mount
  useEffect(() => { loadStats(); loadDepts(); }, [loadStats, loadDepts]);
  // Reload list whenever filter or filter params change
  useEffect(() => { load(); }, [load]);

  const showMsg = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3500);
  };

  const handleApprove = async (id, remarks) => {
    await api.put(`/attendance/regularize/${id}/approve`, { remarks, actor_id: user?.employee_id });
    showMsg('Approved — attendance record corrected');
    load();
    loadStats();
  };

  const handleReject = async (id, remarks) => {
    await api.put(`/attendance/regularize/${id}/reject`, { remarks, actor_id: user?.employee_id });
    showMsg('Request rejected');
    load();
    loadStats();
  };

  const clearFilters = () => { setDept(''); setFromDate(''); setToDate(''); };
  const hasFilters   = dept || fromDate || toDate;

  const TABS = [
    { key: 'pending',  label: 'Pending',  count: stats.pending },
    { key: 'approved', label: 'Approved', count: stats.approved },
    { key: 'rejected', label: 'Rejected', count: stats.rejected },
  ];

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          padding: '12px 18px', borderRadius: 10,
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7',
          border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`,
          color: toast.type === 'error' ? '#991b1b' : '#166534',
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 500,
          boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
        }}>
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
          {toast.msg}
        </div>
      )}

      {/* ── Page header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>
            Regularization Approvals
          </h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            Review and action employee attendance correction requests
            {role === 'manager' && (
              <span style={{ marginLeft: 8, color: P, fontWeight: 500 }}>· Showing your direct reports only</span>
            )}
          </p>
        </div>
        <button
          onClick={() => { load(); loadStats(); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* ── KPI cards (clickable — act as tab shortcut) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
        {TABS.map(t => {
          const sm = STATUS_META[t.key];
          const active = filter === t.key;
          return (
            <div
              key={t.key}
              onClick={() => setFilter(t.key)}
              style={{
                ...CARD,
                display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer',
                borderColor: active ? P : '#f0f0f4',
                boxShadow: active ? `0 0 0 2px ${P}33` : 'none',
                transition: 'box-shadow 0.15s',
              }}
            >
              <div style={{ width: 44, height: 44, borderRadius: 10, background: sm.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <sm.Icon size={20} color={sm.color} />
              </div>
              <div>
                <div style={{ fontSize: 26, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{t.count}</div>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{t.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Filter bar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Status tabs */}
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            style={{
              padding: '7px 16px', borderRadius: 8, fontWeight: 500, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${filter === t.key ? P : '#e5e7eb'}`,
              background: filter === t.key ? P : '#fff',
              color: filter === t.key ? '#fff' : '#374151',
            }}
          >
            {t.label} ({t.count})
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {/* Department dropdown */}
        <select
          value={dept}
          onChange={e => setDept(e.target.value)}
          style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb',
            fontSize: 13, background: '#fff',
            color: dept ? '#111827' : '#9ca3af',
            minWidth: 170,
          }}
        >
          <option value="">All departments</option>
          {deptList.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        {/* Date range */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={14} color="#9ca3af" />
          <input
            type="date"
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
            title="From date"
            style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 12 }}
          />
          <span style={{ color: '#9ca3af', fontSize: 12 }}>–</span>
          <input
            type="date"
            value={toDate}
            onChange={e => setToDate(e.target.value)}
            title="To date"
            style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 12 }}
          />
        </div>

        {hasFilters && (
          <button
            onClick={clearFilters}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fff', color: '#ef4444', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}
          >
            <Filter size={12} /> Clear filters
          </button>
        )}
      </div>

      {/* ── List ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading requests…</div>
      ) : requests.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <FileEdit size={36} color="#e5e7eb" style={{ marginBottom: 12 }} />
          <div style={{ color: '#9ca3af', fontSize: 14 }}>
            No {filter} requests{hasFilters ? ' matching the selected filters' : ''}
          </div>
          {hasFilters && (
            <button
              onClick={clearFilters}
              style={{ marginTop: 14, padding: '7px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#6b7280' }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        requests.map(req => (
          <RequestCard
            key={req.id}
            req={req}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ))
      )}
    </div>
  );
}
