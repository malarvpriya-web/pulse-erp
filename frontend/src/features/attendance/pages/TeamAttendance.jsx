import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { Users, CheckCircle, Clock, XCircle, Search, Download, X, Calendar, FileEdit } from 'lucide-react';
import { useToast } from '@/context/ToastContext';

function getToday() { return new Date().toISOString().split('T')[0]; }
const TODAY = getToday();

const STATUS_CONFIG = {
  Present:    { bg: '#d1fae5', color: '#065f46', icon: CheckCircle },
  Absent:     { bg: '#fee2e2', color: '#991b1b', icon: XCircle },
  Late:       { bg: '#fef3c7', color: '#92400e', icon: Clock },
  'On Leave': { bg: '#dbeafe', color: '#1e40af', icon: Users },
  'Half Day': { bg: '#ede9fe', color: '#5b21b6', icon: Clock },
  WFH:        { bg: '#e0f2fe', color: '#075985', icon: Clock },
  Weekend:    { bg: '#f3f4f6', color: '#6b7280', icon: Clock },
  Pending:    { bg: '#f5f3ff', color: '#6B3FDB', icon: Clock },
  Unknown:    { bg: '#f3f4f6', color: '#374151', icon: Clock },
};

const ALL_STATUSES    = ['Present', 'Absent', 'Late', 'On Leave', 'Half Day', 'WFH'];
const FILTER_STATUSES = ['All', 'Present', 'Absent', 'Late', 'On Leave', 'Half Day', 'WFH', 'Weekend', 'Pending'];
const HOLIDAY_TYPES   = ['National', 'Optional', 'Restricted'];
const DAY_LABELS      = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function getWeekDates(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return Array.from({ length: 5 }, (_, i) => {
    const dt = new Date(mon);
    dt.setDate(mon.getDate() + i);
    return dt.toISOString().split('T')[0];
  });
}

function fmt12(t) {
  if (!t) return '—';
  const parts = String(t).split(':');
  const h = parseInt(parts[0], 10);
  const m = parts[1] ? String(parts[1]).padStart(2, '0') : '00';
  if (isNaN(h)) return String(t).slice(0, 5);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${m} ${ampm}`;
}

const STATUS_NORM_MAP = {
  present: 'Present', absent: 'Absent', late: 'Late',
  on_leave: 'On Leave', 'on leave': 'On Leave',
  half_day: 'Half Day', 'half day': 'Half Day',
  wfh: 'WFH', weekend: 'Weekend', pending: 'Pending',
  holiday: 'Holiday',
};

function normalizeStatus(s) {
  if (!s) return 'Unknown';
  return STATUS_NORM_MAP[String(s).toLowerCase()] ?? s;
}

function normalizeRecord(r) {
  return {
    employee_id:    r.employee_id || r.id,
    employee_name:  r.employee_name || r.name || '—',
    department:     r.department || '—',
    check_in_time:  r.check_in_time  || null,
    check_out_time: r.check_out_time || null,
    total_hours:    r.total_hours    || null,
    status:         normalizeStatus(r.status),
    work_mode:      r.work_mode      || null,
  };
}

function downloadCSV(rows, filename) {
  const csv = rows
    .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportDailyCSV(records, date) {
  const header = ['Employee', 'Department', 'Check In', 'Check Out', 'Hours', 'Status', 'Work Mode'];
  const rows = records.map(r => [
    r.employee_name, r.department,
    fmt12(r.check_in_time), fmt12(r.check_out_time),
    r.total_hours ? Number(r.total_hours).toFixed(1) : '',
    r.status, r.work_mode || '',
  ]);
  downloadCSV([header, ...rows], `attendance_${date}.csv`);
}

function exportWeeklyCSV(weekData, weekDates) {
  const header = ['Employee', 'Department', ...weekDates.map((d, i) => `${DAY_LABELS[i]} ${d.slice(5)}`)];
  const empMap = new Map();
  weekDates.forEach(d =>
    (weekData[d] || []).forEach(r => {
      if (!empMap.has(r.employee_id))
        empMap.set(r.employee_id, { name: r.employee_name, dept: r.department });
    })
  );
  const rows = [...empMap.entries()].map(([id, emp]) => [
    emp.name, emp.dept,
    ...weekDates.map(d => (weekData[d] || []).find(r => r.employee_id === id)?.status ?? ''),
  ]);
  downloadCSV([header, ...rows], `attendance_week_${weekDates[0]}_to_${weekDates[4]}.csv`);
}

export default function TeamAttendance() {
  const { user, role } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const userId  = user?.employee_id;
  const isAdmin = role === 'super_admin' || role === 'admin' || role === 'hr';

  // Employees have no team — redirect to My Attendance
  useEffect(() => {
    if (role === 'employee') navigate('/AttendanceDashboard', { replace: true });
  }, [role, navigate]);

  // ── Core state ──────────────────────────────────────────────────────────────
  const [records, setRecords]           = useState([]);
  const [loading, setLoading]           = useState(false);
  const [date, setDate]                 = useState(getToday);
  const [search, setSearch]             = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [deptFilter, setDeptFilter]     = useState('');
  const [departments, setDepartments]   = useState([]);
  const [viewMode, setViewMode]         = useState('daily');
  const [weekData, setWeekData]         = useState({});
  const [weekLoading, setWeekLoading]   = useState(false);

  // ── Bulk mark ───────────────────────────────────────────────────────────────
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkDate, setBulkDate]           = useState(getToday);
  const [bulkStatus, setBulkStatus]       = useState('On Leave');
  const [bulkLoading, setBulkLoading]     = useState(false);

  // ── Row status override ─────────────────────────────────────────────────────
  const [editingRow, setEditingRow] = useState(null);
  const [editStatus, setEditStatus] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // ── Mark Holiday ────────────────────────────────────────────────────────────
  const [showHolidayModal, setShowHolidayModal] = useState(false);
  const [holidayName, setHolidayName]           = useState('');
  const [holidayType, setHolidayType]           = useState('National');
  const [holidayDesc, setHolidayDesc]           = useState('');
  const [holidaySaving, setHolidaySaving]       = useState(false);

  // ── Regularize ──────────────────────────────────────────────────────────────
  const [regRow, setRegRow]           = useState(null);
  const [regCheckIn, setRegCheckIn]   = useState('');
  const [regCheckOut, setRegCheckOut] = useState('');
  const [regReason, setRegReason]     = useState('');
  const [regSaving, setRegSaving]     = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api.get('/admin/config/departments')
      .then(res => {
        if (isMounted.current)
          setDepartments(Array.isArray(res.data) ? res.data.map(d => d.name || d) : []);
      })
      .catch(() => {});
  }, [isAdmin]);

  const buildEndpoint = useCallback((d) => {
    if (isAdmin) {
      const q = deptFilter ? `?department=${encodeURIComponent(deptFilter)}` : '';
      return `/attendance/date/${d}${q}`;
    }
    return `/attendance/team/${userId}?date=${d}`;
  }, [isAdmin, deptFilter, userId]);

  const fetchDaily = useCallback(() => {
    if (!userId && !isAdmin) return;
    setLoading(true);
    api.get(buildEndpoint(date))
      .then(r => {
        if (isMounted.current)
          setRecords((Array.isArray(r.data) ? r.data : []).map(normalizeRecord));
      })
      .catch(() => { if (isMounted.current) setRecords([]); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, [date, buildEndpoint, isAdmin, userId]);

  const fetchWeekly = useCallback(() => {
    if (!userId && !isAdmin) return;
    setWeekLoading(true);
    const dates = getWeekDates(date);
    const today = getToday();
    Promise.all(
      dates.map(d =>
        d > today
          ? Promise.resolve({ date: d, records: [] })
          : api.get(buildEndpoint(d))
              .then(r => ({ date: d, records: (Array.isArray(r.data) ? r.data : []).map(normalizeRecord) }))
              .catch(() => ({ date: d, records: [] }))
      )
    ).then(results => {
      if (!isMounted.current) return;
      const map = {};
      results.forEach(({ date: d, records: recs }) => { map[d] = recs; });
      setWeekData(map);
    }).finally(() => { if (isMounted.current) setWeekLoading(false); });
  }, [date, buildEndpoint, isAdmin, userId]);

  useEffect(() => {
    if (viewMode === 'daily') fetchDaily();
  }, [fetchDaily, viewMode]);

  useEffect(() => {
    if (viewMode === 'weekly') fetchWeekly();
  }, [fetchWeekly, viewMode]);

  const filtered = records.filter(r => {
    if (statusFilter !== 'All' && r.status !== statusFilter) return false;
    if (search && ![r.employee_name, r.department].some(v =>
      v.toLowerCase().includes(search.toLowerCase())
    )) return false;
    return true;
  });

  const stats = {
    total:   records.length,
    present: records.filter(r => r.status === 'Present').length,
    absent:  records.filter(r => r.status === 'Absent').length,
    late:    records.filter(r => r.status === 'Late').length,
    leave:   records.filter(r => r.status === 'On Leave').length,
    wfh:     records.filter(r => r.work_mode === 'WFH' || r.status === 'WFH').length,
    weekend: records.filter(r => r.status === 'Weekend').length,
    pending: records.filter(r => r.status === 'Pending').length,
  };

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleBulkMark() {
    setBulkLoading(true);
    try {
      await api.post('/attendance/bulk-mark', { attendance_date: bulkDate, status: bulkStatus });
      toast.success(`Bulk marked as ${bulkStatus} for ${bulkDate}`);
      setShowBulkModal(false);
      if (bulkDate === date) viewMode === 'daily' ? fetchDaily() : fetchWeekly();
    } catch (e) {
      toast.error('Bulk mark failed: ' + (e?.response?.data?.error || e.message));
    } finally {
      if (isMounted.current) setBulkLoading(false);
    }
  }

  async function saveRowStatus(r) {
    setEditSaving(true);
    try {
      await api.post('/attendance/mark', {
        employee_id: r.employee_id,
        attendance_date: date,
        status: editStatus,
      });
      setRecords(prev =>
        prev.map(rec => rec.employee_id === r.employee_id ? { ...rec, status: editStatus } : rec)
      );
      setEditingRow(null);
    } catch (e) {
      toast.error('Failed to update: ' + (e?.response?.data?.error || e.message));
    } finally {
      if (isMounted.current) setEditSaving(false);
    }
  }

  async function handleMarkHoliday() {
    if (!holidayName.trim()) { toast.error('Holiday name is required'); return; }
    setHolidaySaving(true);
    try {
      await api.post('/holidays', {
        name: holidayName.trim(),
        date,
        type: holidayType,
        description: holidayDesc.trim(),
      });
      toast.success(`${holidayName.trim()} marked as holiday on ${date}`);
      setShowHolidayModal(false);
      setHolidayName(''); setHolidayDesc(''); setHolidayType('National');
      fetchDaily();
    } catch (e) {
      toast.error('Failed to mark holiday: ' + (e?.response?.data?.error || e.message));
    } finally {
      if (isMounted.current) setHolidaySaving(false);
    }
  }

  async function handleRegularize() {
    if (!regReason.trim()) { toast.error('Reason is required'); return; }
    setRegSaving(true);
    try {
      await api.post('/attendance/regularize', {
        employee_id: regRow.employee_id,
        date,
        check_in:  regCheckIn  || null,
        check_out: regCheckOut || null,
        reason: regReason.trim(),
      });
      toast.success('Regularization request submitted');
      setRegRow(null); setRegCheckIn(''); setRegCheckOut(''); setRegReason('');
    } catch (e) {
      toast.error('Regularization failed: ' + (e?.response?.data?.error || e.message));
    } finally {
      if (isMounted.current) setRegSaving(false);
    }
  }

  function getWeekEmployees() {
    const map = new Map();
    Object.values(weekData).flat().forEach(r => {
      if (!map.has(r.employee_id))
        map.set(r.employee_id, { employee_id: r.employee_id, employee_name: r.employee_name, department: r.department });
    });
    return [...map.values()].sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  }

  const weekDates = getWeekDates(date);

  if (role === 'employee') return null;

  // ── Shared input/label styles ────────────────────────────────────────────────
  const inputStyle = { width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Team Attendance</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            {isAdmin ? 'Company-wide attendance view' : "Your team's attendance"}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>

          {/* View toggle */}
          <div style={{ display: 'flex', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            {['daily', 'weekly'].map(v => (
              <button key={v} onClick={() => setViewMode(v)}
                style={{ padding: '7px 16px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
                  background: viewMode === v ? '#6366f1' : 'transparent',
                  color: viewMode === v ? '#fff' : '#6b7280' }}>
                {v}
              </button>
            ))}
          </div>

          {/* Department filter — admin only */}
          {isAdmin && departments.length > 0 && (
            <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)}
              style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff', outline: 'none' }}>
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}

          <input type="date" value={date} max={TODAY} onChange={e => setDate(e.target.value)}
            style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', color: '#374151', background: '#fff' }} />

          {/* Mark Holiday — admin only */}
          {isAdmin && (
            <button onClick={() => setShowHolidayModal(true)}
              style={{ padding: '7px 14px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
              <Calendar size={13} /> Mark Holiday
            </button>
          )}

          {/* Bulk mark — admin only */}
          {isAdmin && (
            <button onClick={() => { setBulkDate(date); setShowBulkModal(true); }}
              style={{ padding: '7px 14px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Bulk Mark
            </button>
          )}

          {/* CSV export */}
          <button
            onClick={() => viewMode === 'daily' ? exportDailyCSV(filtered, date) : exportWeeklyCSV(weekData, weekDates)}
            style={{ padding: '7px 14px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Download size={13} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── Stats (daily only) ── */}
      {viewMode === 'daily' && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${6 + (stats.weekend > 0 ? 1 : 0) + (stats.pending > 0 ? 1 : 0)}, 1fr)`, gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Total',    value: stats.total,   color: '#6366f1' },
            { label: 'Present',  value: stats.present, color: '#10b981' },
            { label: 'Absent',   value: stats.absent,  color: '#ef4444' },
            { label: 'Late',     value: stats.late,    color: '#f59e0b' },
            { label: 'On Leave', value: stats.leave,   color: '#3b82f6' },
            { label: 'WFH',      value: stats.wfh,     color: '#0ea5e9' },
            ...(stats.weekend > 0 ? [{ label: 'Weekend', value: stats.weekend, color: '#6b7280' }] : []),
            ...(stats.pending > 0 ? [{ label: 'Pending', value: stats.pending, color: '#6B3FDB' }] : []),
          ].map(s => (
            <div key={s.label}
              onClick={() => setStatusFilter(s.label === 'Total' ? 'All' : s.label)}
              style={{ background: '#fff', borderRadius: 10, padding: '14px 16px', border: `1px solid ${statusFilter === (s.label === 'Total' ? 'All' : s.label) ? s.color : '#f0f0f4'}`, textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s' }}>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 4px', fontWeight: 500, textTransform: 'uppercase' }}>{s.label}</p>
              <p style={{ fontSize: 24, fontWeight: 700, color: s.color, margin: 0 }}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters row (daily only) ── */}
      {viewMode === 'daily' && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Search */}
          <div style={{ position: 'relative', flex: '0 0 280px' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search employee, department..."
              style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          {/* Status filter */}
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff', outline: 'none' }}>
            {FILTER_STATUSES.map(s => <option key={s} value={s}>{s === 'All' ? 'All Statuses' : s}</option>)}
          </select>
          {/* Active filter chip */}
          {(search || statusFilter !== 'All') && (
            <button onClick={() => { setSearch(''); setStatusFilter('All'); }}
              style={{ padding: '6px 12px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <X size={12} /> Clear filters
            </button>
          )}
          <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
            {filtered.length} of {records.length} employees
          </span>
        </div>
      )}

      {/* ── Daily table ── */}
      {viewMode === 'daily' && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No records for this date.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Employee', 'Department', 'Check In', 'Check Out', 'Hours', 'WFH', 'Status', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const sc = STATUS_CONFIG[r.status] || STATUS_CONFIG.Unknown;
                  const isEditing = isAdmin && editingRow === r.employee_id;
                  return (
                    <tr key={r.employee_id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '10px 16px', fontWeight: 500, color: '#1f2937', whiteSpace: 'nowrap' }}>{r.employee_name}</td>
                      <td style={{ padding: '10px 16px', color: '#6b7280' }}>{r.department}</td>
                      <td style={{ padding: '10px 16px', color: '#374151', whiteSpace: 'nowrap' }}>{fmt12(r.check_in_time)}</td>
                      <td style={{ padding: '10px 16px', color: '#374151', whiteSpace: 'nowrap' }}>{fmt12(r.check_out_time)}</td>
                      <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1f2937' }}>
                        {r.total_hours ? `${Number(r.total_hours).toFixed(1)}h` : '—'}
                      </td>
                      <td style={{ padding: '10px 16px', color: '#6b7280', textAlign: 'center' }}>
                        {r.work_mode === 'WFH'
                          ? <span style={{ color: '#0ea5e9', fontWeight: 600, fontSize: 11 }}>WFH</span>
                          : '—'}
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                          {r.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        {isEditing ? (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <select value={editStatus} onChange={e => setEditStatus(e.target.value)}
                              style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid #e5e7eb', outline: 'none' }}>
                              {ALL_STATUSES.map(s => <option key={s}>{s}</option>)}
                            </select>
                            <button onClick={() => saveRowStatus(r)} disabled={editSaving}
                              style={{ fontSize: 11, padding: '3px 8px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                              {editSaving ? '…' : 'Save'}
                            </button>
                            <button onClick={() => setEditingRow(null)}
                              style={{ fontSize: 11, padding: '3px 8px', background: '#e5e7eb', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 6 }}>
                            {isAdmin && (
                              <button onClick={() => { setEditingRow(r.employee_id); setEditStatus(r.status); }}
                                style={{ fontSize: 11, padding: '3px 10px', background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>
                                Edit
                              </button>
                            )}
                            {(isAdmin || role === 'manager') && r.status !== 'Weekend' && (
                              <button
                                onClick={() => {
                                  setRegRow(r);
                                  setRegCheckIn(r.check_in_time ? String(r.check_in_time).slice(0, 5) : '');
                                  setRegCheckOut(r.check_out_time ? String(r.check_out_time).slice(0, 5) : '');
                                  setRegReason('');
                                }}
                                style={{ fontSize: 11, padding: '3px 10px', background: '#ede9fe', color: '#5b21b6', border: '1px solid #ddd6fe', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                                <FileEdit size={11} /> Regularize
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Weekly table ── */}
      {viewMode === 'weekly' && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
          {weekLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading week data…</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', minWidth: 160 }}>Employee</th>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', minWidth: 110 }}>Department</th>
                  {weekDates.map((d, i) => (
                    <th key={d} style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 600,
                      color: d === TODAY ? '#6366f1' : '#374151',
                      borderBottom: '1px solid #f0f0f4', minWidth: 90 }}>
                      <div>{DAY_LABELS[i]}</div>
                      <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>{d.slice(5)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {getWeekEmployees().length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No data for this week.</td>
                  </tr>
                ) : getWeekEmployees().map((emp, i) => (
                  <tr key={emp.employee_id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 500, color: '#1f2937', whiteSpace: 'nowrap' }}>{emp.employee_name}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280', fontSize: 12 }}>{emp.department}</td>
                    {weekDates.map(d => {
                      const rec = (weekData[d] || []).find(r => r.employee_id === emp.employee_id);
                      const sc  = rec ? (STATUS_CONFIG[rec.status] || STATUS_CONFIG.Unknown) : null;
                      return (
                        <td key={d} style={{ padding: '10px 16px', textAlign: 'center' }}>
                          {rec ? (
                            <span style={{ background: sc.bg, color: sc.color, padding: '3px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {rec.status}
                            </span>
                          ) : (
                            <span style={{ color: '#d1d5db' }}>—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ═══════════════════════════════ MODALS ═══════════════════════════════ */}

      {/* ── Bulk Mark Modal ── */}
      {showBulkModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', margin: 0 }}>Bulk Mark Attendance</h2>
              <button onClick={() => setShowBulkModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}><X size={18} /></button>
            </div>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 18 }}>
              Mark all active employees for the selected date. Existing records will be overwritten.
            </p>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Date</label>
              <input type="date" value={bulkDate} max={TODAY} onChange={e => setBulkDate(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ marginBottom: 22 }}>
              <label style={labelStyle}>Status</label>
              <select value={bulkStatus} onChange={e => setBulkStatus(e.target.value)} style={inputStyle}>
                {ALL_STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowBulkModal(false)}
                style={{ flex: 1, padding: '9px 0', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleBulkMark} disabled={bulkLoading}
                style={{ flex: 1, padding: '9px 0', background: bulkLoading ? '#fbbf24' : '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: bulkLoading ? 'not-allowed' : 'pointer' }}>
                {bulkLoading ? 'Marking…' : 'Mark All Employees'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mark Holiday Modal ── */}
      {showHolidayModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', margin: 0 }}>Mark Holiday</h2>
              <button onClick={() => setShowHolidayModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}><X size={18} /></button>
            </div>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 18 }}>
              Mark <strong>{date}</strong> as a company holiday. This will be visible in the Holiday Calendar.
            </p>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Holiday Name *</label>
              <input value={holidayName} onChange={e => setHolidayName(e.target.value)}
                placeholder="e.g. Republic Day"
                style={inputStyle} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Type</label>
              <select value={holidayType} onChange={e => setHolidayType(e.target.value)} style={inputStyle}>
                {HOLIDAY_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 22 }}>
              <label style={labelStyle}>Description (optional)</label>
              <input value={holidayDesc} onChange={e => setHolidayDesc(e.target.value)}
                placeholder="Additional notes"
                style={inputStyle} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowHolidayModal(false)}
                style={{ flex: 1, padding: '9px 0', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleMarkHoliday} disabled={holidaySaving}
                style={{ flex: 1, padding: '9px 0', background: holidaySaving ? '#a78bfa' : '#8b5cf6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: holidaySaving ? 'not-allowed' : 'pointer' }}>
                {holidaySaving ? 'Saving…' : 'Mark as Holiday'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Regularize Modal ── */}
      {regRow && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', margin: 0 }}>Regularize Attendance</h2>
              <button onClick={() => setRegRow(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ background: '#f5f3ff', borderRadius: 8, padding: '10px 14px', marginBottom: 18 }}>
              <p style={{ margin: 0, fontSize: 13, color: '#5b21b6', fontWeight: 600 }}>{regRow.employee_name}</p>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6B3FDB' }}>{regRow.department} · {date}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Check In Time</label>
                <input type="time" value={regCheckIn} onChange={e => setRegCheckIn(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Check Out Time</label>
                <input type="time" value={regCheckOut} onChange={e => setRegCheckOut(e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div style={{ marginBottom: 22 }}>
              <label style={labelStyle}>Reason *</label>
              <input value={regReason} onChange={e => setRegReason(e.target.value)}
                placeholder="Reason for regularization"
                style={inputStyle} />
            </div>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: '-14px 0 16px' }}>
              This request will go through the standard approval workflow.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setRegRow(null)}
                style={{ flex: 1, padding: '9px 0', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleRegularize} disabled={regSaving}
                style={{ flex: 1, padding: '9px 0', background: regSaving ? '#a78bfa' : '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: regSaving ? 'not-allowed' : 'pointer' }}>
                {regSaving ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
