import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Shield, RefreshCw, Download, Filter, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const ACTION_STYLES = {
  clock_in:              { bg: '#dcfce7', color: '#166534', label: 'Clock In' },
  clock_out:             { bg: '#dbeafe', color: '#1e40af', label: 'Clock Out' },
  admin_mark:            { bg: '#fef3c7', color: '#92400e', label: 'Admin Mark' },
  bulk_mark:             { bg: '#f3e8ff', color: '#7e22ce', label: 'Bulk Mark' },
  regularize_submit:     { bg: '#e0f2fe', color: '#0369a1', label: 'Reg. Submit' },
  regularize_mgr_approve:{ bg: '#dcfce7', color: '#166534', label: 'Mgr Approved' },
  regularize_mgr_reject: { bg: '#fee2e2', color: '#991b1b', label: 'Mgr Rejected' },
  regularize_hr_approve: { bg: '#dcfce7', color: '#166534', label: 'HR Approved' },
  regularize_hr_reject:  { bg: '#fee2e2', color: '#991b1b', label: 'HR Rejected' },
  ot_approved:           { bg: '#dcfce7', color: '#166534', label: 'OT Approved' },
  ot_rejected:           { bg: '#fee2e2', color: '#991b1b', label: 'OT Rejected' },
  payroll_sync:          { bg: '#f5f3ff', color: '#5b21b6', label: 'Payroll Sync' },
};

const KNOWN_ACTIONS = Object.keys(ACTION_STYLES);

function LogRow({ log }) {
  const [expanded, setExpanded] = useState(false);
  const st = ACTION_STYLES[log.action] || { bg: '#f3f4f6', color: '#6b7280', label: log.action };

  const formatDate = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  };

  const hasDiff = log.before_data || log.after_data;

  return (
    <>
      <tr
        style={{ borderBottom: '1px solid #f0f0f4', cursor: hasDiff ? 'pointer' : 'default' }}
        onClick={() => hasDiff && setExpanded(e => !e)}
      >
        <td style={{ padding: '10px 14px', fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
          {formatDate(log.performed_at)}
        </td>
        <td style={{ padding: '10px 14px' }}>
          <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: st.bg, color: st.color }}>
            {st.label}
          </span>
        </td>
        <td style={{ padding: '10px 14px', fontWeight: 500, color: '#111827', fontSize: 14 }}>
          {log.employee_name || `Employee #${log.employee_id}` || '—'}
        </td>
        <td style={{ padding: '10px 14px', fontSize: 13, color: '#6b7280' }}>
          {log.performed_by_name || `User #${log.performed_by}` || '—'}
        </td>
        <td style={{ padding: '10px 14px', fontSize: 13, color: '#374151', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {log.reason || '—'}
        </td>
        <td style={{ padding: '10px 14px', fontSize: 11, color: '#9ca3af' }}>
          {log.ip_address || '—'}
        </td>
        <td style={{ padding: '10px 14px' }}>
          {hasDiff && (
            expanded
              ? <ChevronDown size={14} color="#9ca3af" />
              : <ChevronRight size={14} color="#9ca3af" />
          )}
        </td>
      </tr>
      {expanded && hasDiff && (
        <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
          <td colSpan={7} style={{ padding: '12px 14px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {log.before_data && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', marginBottom: 6, textTransform: 'uppercase' }}>Before</div>
                  <pre style={{ fontSize: 12, background: '#fff', border: '1px solid #f0f0f4', borderRadius: 6, padding: 10, margin: 0, overflow: 'auto', maxHeight: 150, color: '#374151' }}>
                    {JSON.stringify(typeof log.before_data === 'string' ? JSON.parse(log.before_data) : log.before_data, null, 2)}
                  </pre>
                </div>
              )}
              {log.after_data && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', marginBottom: 6, textTransform: 'uppercase' }}>After</div>
                  <pre style={{ fontSize: 12, background: '#fff', border: '1px solid #f0f0f4', borderRadius: 6, padding: 10, margin: 0, overflow: 'auto', maxHeight: 150, color: '#374151' }}>
                    {JSON.stringify(typeof log.after_data === 'string' ? JSON.parse(log.after_data) : log.after_data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function AttendanceAuditLogs() {
  const [logs, setLogs]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [fromDate, setFromDate]   = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate]       = useState(new Date().toISOString().slice(0, 10));
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (actionFilter) params.set('action', actionFilter);
      if (employeeFilter) params.set('employee_id', employeeFilter);
      const res = await api.get(`/attendance/audit-logs?${params}`);
      if (isMounted.current) setLogs(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (isMounted.current) setLogs([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [actionFilter, employeeFilter, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const downloadCSV = () => {
    const rows = [['Timestamp', 'Action', 'Employee', 'Performed By', 'Reason', 'IP Address']];
    logs.forEach(l => rows.push([
      l.performed_at, l.action,
      l.employee_name || l.employee_id,
      l.performed_by_name || l.performed_by,
      l.reason || '', l.ip_address || '',
    ]));
    const csv  = rows.map(r => r.map(v => `"${v || ''}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `attendance-audit-${fromDate}-${toDate}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const actionCounts = {};
  logs.forEach(l => { actionCounts[l.action] = (actionCounts[l.action] || 0) + 1; });

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>Attendance Audit Logs</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            Immutable audit trail — every attendance mutation is permanently recorded
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={downloadCSV} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <Download size={13} /> Export CSV
          </button>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}} /> Refresh
          </button>
        </div>
      </div>

      {/* Action summary chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <button
          onClick={() => setActionFilter('')}
          style={{
            padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 500, cursor: 'pointer',
            border: `1px solid ${!actionFilter ? P : '#e5e7eb'}`,
            background: !actionFilter ? P : '#fff', color: !actionFilter ? '#fff' : '#374151',
          }}
        >
          All ({logs.length})
        </button>
        {Object.entries(actionCounts).map(([action, count]) => {
          const st = ACTION_STYLES[action] || { bg: '#f3f4f6', color: '#6b7280', label: action };
          return (
            <button
              key={action}
              onClick={() => setActionFilter(action === actionFilter ? '' : action)}
              style={{
                padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                border: `1px solid ${actionFilter === action ? st.color : '#e5e7eb'}`,
                background: actionFilter === action ? st.bg : '#fff',
                color: actionFilter === action ? st.color : '#374151',
              }}
            >
              {st.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
          From:
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
          To:
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }} />
        </div>
        <input
          placeholder="Employee ID…"
          value={employeeFilter}
          onChange={e => setEmployeeFilter(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, width: 140 }}
        />
        <button
          onClick={load}
          style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
        >
          Apply
        </button>
      </div>

      {/* Notice */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px',
        background: '#f5f3ff', borderRadius: 8, border: '1px solid #e9e4ff',
        fontSize: 12, color: '#5b21b6', marginBottom: 20,
      }}>
        <Shield size={14} style={{ marginTop: 1, flexShrink: 0 }} />
        <span>Audit logs are immutable — no record can be edited or deleted. Every attendance mutation is permanently recorded with before/after state, performer identity, and IP address.</span>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading audit logs…</div>
      ) : logs.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <Shield size={36} color="#e5e7eb" style={{ marginBottom: 12 }} />
          <div>No audit logs found for the selected filters</div>
        </div>
      ) : (
        <div style={CARD}>
          <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>
            Showing {logs.length} records · Click any row to expand before/after data
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #f0f0f4' }}>
                  {['Timestamp', 'Action', 'Employee', 'Performed By', 'Reason', 'IP Address', ''].map(h => (
                    <th key={h} style={{ padding: '8px 14px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map(log => <LogRow key={log.id} log={log} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
