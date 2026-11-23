import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Shield, RefreshCw, Download, Filter, ChevronDown, ChevronRight,
  AlertCircle, CalendarClock,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { localDay, localDayOf } from '@/utils/dateFormatter';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const ACTION_STYLES = {
  clock_in:              { bg: '#dcfce7', color: '#166534', label: 'Clock In' },
  clock_out:             { bg: '#dbeafe', color: '#1e40af', label: 'Clock Out' },
  admin_mark:            { bg: '#ede9fe', color: '#5b21b6', label: 'Admin Mark' },
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

// Before / after as a readable table (owner, 2026-11-19: the raw JSON with
// ids like "id: 31" was not readable). Only the fields that changed are
// listed when both sides exist; ids and timestamps are left out.
const HIDDEN = new Set(['id', 'company_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at']);
const parse = (v) => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return { value: v }; } } return v; };
const label = (k) => k.replace(/_/g, ' ').replace(/\bot\b/g, 'OT').replace(/^\w/, (c) => c.toUpperCase());
function show(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object')) return v.join(', ') || '—';
    return `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${label(k)}: ${show(x)}`).join(' · ');
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s.slice(0, 5);
  return s;
}
function ChangeTable({ before, after }) {
  const b = parse(before) || {}; const a = parse(after) || {};
  const both = before != null && after != null;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !HIDDEN.has(k))
    .filter((k) => !both || JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  const cell = { padding: '6px 10px', borderBottom: '1px solid #f0f0f4', fontSize: 12, verticalAlign: 'top' };
  if (!keys.length) return <div style={{ fontSize: 12, color: '#9ca3af' }}>No field changed.</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #f0f0f4', borderRadius: 6 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#9ca3af', fontSize: 11, textTransform: 'uppercase' }}>
          <th style={cell}>Field</th>
          {both ? <><th style={cell}>Before</th><th style={cell}>After</th></> : <th style={cell}>{after != null ? 'Value' : 'Was'}</th>}
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k}>
            <td style={{ ...cell, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{label(k)}</td>
            {both
              ? <><td style={{ ...cell, color: '#9ca3af' }}>{show(b[k])}</td><td style={{ ...cell, color: '#6B3FDB', fontWeight: 600 }}>{show(a[k])}</td></>
              : <td style={cell}>{show(after != null ? a[k] : b[k])}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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
            <ChangeTable before={log.before_data} after={log.after_data} />
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
    return localDayOf(d);
  });
  const [toDate, setToDate]       = useState(localDay());
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
    <PageShell dock={
      <PageHero
        icon={CalendarClock}
        eyebrow="Attendance"
        title="Attendance Audit Logs"
        subtitle="Immutable audit trail — every attendance mutation is permanently recorded"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={downloadCSV}>
            <Download size={13} /> Export CSV
          </button>
          <button className="plh-cta" onClick={load}>
            <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}} /> Refresh
          </button>
        </>}
      />
    }>


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
    </PageShell>
  );
}
