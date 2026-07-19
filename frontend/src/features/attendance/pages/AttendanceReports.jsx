import { useState, useCallback, useEffect, useRef } from 'react';
import {
  FileText, Download, BarChart2, Users, Clock, AlertTriangle,
  Zap, Calendar, RefreshCw, Printer, CheckCircle, AlertCircle, TrendingUp,
  GitCompare, LogOut,
} from 'lucide-react';
import api from '@/services/api/client';

const P    = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };
const MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const REPORT_TYPES = [
  // Monthly Summary lives in the dedicated Monthly Report page (Attendance → Monthly Report)
  // which has Sync to Payroll, LOP computation, and richer per-employee columns.
  { id: 'absenteeism',          label: 'Absenteeism Report',        icon: AlertTriangle,  color: '#ef4444', desc: 'Chronic absenteeism trends — last 12 months' },
  { id: 'late_arrivals',        label: 'Late Arrivals Report',       icon: Clock,          color: '#f59e0b', desc: 'Late marks, grace violations, repeat offenders' },
  { id: 'overtime',             label: 'Overtime Report',            icon: Zap,            color: '#8b5cf6', desc: 'OT hours by department and approval status' },
  { id: 'department_wise',      label: 'Department-Wise',            icon: BarChart2,      color: '#10b981', desc: 'Attendance percentage by department' },
  { id: 'shift_efficiency',     label: 'Shift Efficiency',           icon: Users,          color: '#0369a1', desc: 'Shift fill rate, utilization, and average hours' },
  { id: 'leave_reconciliation', label: 'Leave Reconciliation',       icon: GitCompare,     color: '#dc2626', desc: 'Absences without leave approval + approved leave ignored' },
  { id: 'early_exit',           label: 'Early Exit Report',          icon: LogOut,         color: '#ea580c', desc: 'Employees who left before shift end time' },
];

// ── Shared micro-components ───────────────────────────────────────────────────

function KpiCard({ label, value, color }) {
  return (
    <div style={{ background: `${color}0f`, border: `1px solid ${color}22`, borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function DeltaBadge({ cur, prev, lowerIsBetter = false }) {
  const d = Number(cur) - Number(prev);
  if (!d) return <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>→</span>;
  const better = lowerIsBetter ? d < 0 : d > 0;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: better ? '#10b981' : '#ef4444', marginLeft: 4 }}>
      {d > 0 ? '↑' : '↓'}{Math.abs(d)}
    </span>
  );
}

function EmptyState({ msg }) {
  return (
    <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
      <FileText size={36} color="#e5e7eb" style={{ display: 'block', margin: '0 auto 10px' }} />
      <div style={{ fontSize: 13 }}>{msg || 'No data available'}</div>
    </div>
  );
}

function TH({ children }) {
  return (
    <th style={{ padding: '9px 11px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AttendanceReports() {
  const now = new Date();

  // Primary filters
  const [reportType, setReportType] = useState('absenteeism');
  const [month,  setMonth]  = useState(now.getMonth() + 1);
  const [year,   setYear]   = useState(now.getFullYear());
  const [department, setDept] = useState('');
  const [departments, setDepts] = useState([]);

  // Compare period
  const [comparing, setComparing] = useState(false);
  const defaultCmpMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const defaultCmpYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const [cmpMonth, setCmpMonth] = useState(defaultCmpMonth);
  const [cmpYear,  setCmpYear]  = useState(defaultCmpYear);

  // Report state
  const [data,    setData]    = useState(null);
  const [cmpData, setCmpData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');

  // Payroll sync
  const [syncing, setSyncing] = useState(false);
  const [toast,   setToast]   = useState(null);

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  // Populate department dropdown from analytics endpoint on mount
  useEffect(() => {
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    api.get(`/attendance/analytics/department-absenteeism?month=${m}&year=${y}`)
      .then(r => {
        if (isMounted.current)
          setDepts((r.data || []).map(d => d.department).filter(Boolean).sort());
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 4000);
  };

  // ── Generate ────────────────────────────────────────────────────────────────

  const run = useCallback(async () => {
    setLoading(true); setErr(''); setData(null); setCmpData(null);

    const fetchOne = async (m, y) => {
      const qs = `month=${m}&year=${y}${department ? `&department=${encodeURIComponent(department)}` : ''}`;
      if (reportType === 'late_arrivals') {
        const res = await api.get(`/attendance/monthly-report?${qs}`);
        return { type: reportType, records: res.data.records || [], month: m, year: y };
      }
      if (reportType === 'absenteeism') {
        const res = await api.get('/attendance/analytics/absenteeism');
        return { type: reportType, trends: res.data || [], month: m, year: y };
      }
      if (reportType === 'overtime') {
        const res = await api.get(`/attendance/analytics/overtime-cost?${qs}`);
        return { type: reportType, deptData: res.data || [], month: m, year: y };
      }
      if (reportType === 'department_wise') {
        const res = await api.get(`/attendance/analytics/department-absenteeism?${qs}`);
        return { type: reportType, deptData: res.data || [], month: m, year: y };
      }
      if (reportType === 'shift_efficiency') {
        const res = await api.get(`/attendance/analytics/shift-efficiency?${qs}`);
        return { type: reportType, shifts: res.data || [], month: m, year: y };
      }
      if (reportType === 'leave_reconciliation') {
        const res = await api.get(`/attendance/reports/leave-reconciliation?${qs}`);
        return { type: reportType, ...res.data, month: m, year: y };
      }
      if (reportType === 'early_exit') {
        const res = await api.get(`/attendance/reports/early-exit?${qs}`);
        return { type: reportType, ...res.data, month: m, year: y };
      }
      return null;
    };

    try {
      const [main, cmp] = await Promise.all([
        fetchOne(month, year),
        comparing && reportType !== 'absenteeism' ? fetchOne(cmpMonth, cmpYear) : Promise.resolve(null),
      ]);
      if (isMounted.current) { setData(main); setCmpData(cmp); }
    } catch {
      if (isMounted.current) setErr('Failed to generate report. Check your connection and try again.');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [reportType, month, year, department, comparing, cmpMonth, cmpYear]);

  // ── Payroll sync ────────────────────────────────────────────────────────────

  const handlePayrollSync = async (records) => {
    if (!confirm(`Freeze attendance for ${MONTHS[month - 1]} ${year} and sync to payroll?`)) return;
    setSyncing(true);
    try {
      const res = await api.post('/attendance/payroll-sync', { month, year });
      showToast(`Synced ${res.data.records_synced ?? 0} records — attendance frozen`);
      run();
    } catch (e) {
      showToast(e.response?.data?.message || e.response?.data?.error || 'Sync failed', 'error');
    } finally {
      if (isMounted.current) setSyncing(false);
    }
  };

  // ── CSV export ──────────────────────────────────────────────────────────────

  const exportCSV = () => {
    if (!data) return;
    let headers = [], rows = [];

    if (data.type === 'monthly_summary') {
      headers = ['Employee','Department','Designation','Present','Absent','Late Days','WFH','Half Day','Late Count','Late Mins','Total Hours','OT Hours','Payroll'];
      rows = (data.records || []).map(r => [
        r.employee_name, r.department, r.designation || '',
        r.present_days, r.absent_days, r.late_days, r.wfh_days, r.half_days,
        r.late_arrivals, r.total_late_minutes,
        parseFloat(r.total_hours || 0).toFixed(1),
        parseFloat(r.total_ot_hours || 0).toFixed(1),
        r.payroll_synced ? 'Synced' : 'Pending',
      ]);
    } else if (data.type === 'late_arrivals') {
      const late = (data.records || []).filter(r => parseInt(r.late_days) > 0);
      headers = ['Employee','Department','Designation','Present','Absent','Late Days','Late Count','Total Late Mins','Avg Hours'];
      rows = late.map(r => [
        r.employee_name, r.department, r.designation || '',
        r.present_days, r.absent_days, r.late_days,
        r.late_arrivals, r.total_late_minutes,
        parseFloat(r.avg_hours || 0).toFixed(1),
      ]);
    } else if (data.type === 'absenteeism') {
      headers = ['Month','Year','Total Records','Absent','Present','Late','Unique Employees','Absenteeism %'];
      rows = (data.trends || []).map(r => [
        MONTHS_S[parseInt(r.month) - 1], r.year,
        r.total_records, r.absent_count, r.present_count, r.late_count,
        r.unique_employees,
        parseFloat(r.absenteeism_rate || 0).toFixed(2) + '%',
      ]);
    } else if (data.type === 'overtime') {
      headers = ['Department','Employees w/ OT','Total OT Hours','Approved','Pending','Rejected','Avg Multiplier'];
      rows = (data.deptData || []).map(r => [
        r.department || 'Unknown', r.employees_with_ot,
        parseFloat(r.total_ot_hours || 0).toFixed(1),
        r.approved_ot, r.pending_ot, r.rejected_ot,
        parseFloat(r.avg_multiplier || 1.5).toFixed(2) + 'x',
      ]);
    } else if (data.type === 'department_wise') {
      headers = ['Department','Employees','Present Days','Absent Days','Late Days','Total Hours','Absenteeism %'];
      rows = (data.deptData || []).map(r => [
        r.department || 'Unknown', r.total_employees,
        r.present_days, r.absent_days, r.late_days,
        parseFloat(r.total_hours || 0).toFixed(0),
        parseFloat(r.absenteeism_rate || 0).toFixed(2) + '%',
      ]);
    } else if (data.type === 'shift_efficiency') {
      headers = ['Shift','Start','End','Assigned','Present','Late Minutes','Avg Hours','Attendance %'];
      rows = (data.shifts || []).map(r => [
        r.shift_name,
        String(r.start_time || '').slice(0, 5),
        String(r.end_time   || '').slice(0, 5),
        r.assigned_employees, r.present_count,
        r.total_late_minutes || 0,
        r.avg_hours ? parseFloat(r.avg_hours).toFixed(1) : '—',
        parseFloat(r.attendance_rate || 0).toFixed(1) + '%',
      ]);
    } else if (data.type === 'leave_reconciliation') {
      headers = ['Employee', 'Department', 'Date', 'Attendance Status', 'Conflict Type', 'Leave Type'];
      rows = (data.conflicts || []).map(c => [
        c.employee_name, c.department || '', new Date(c.attendance_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }),
        c.attendance_status, c.conflict_type, c.leave_type || '',
      ]);
    } else if (data.type === 'early_exit') {
      headers = ['Employee', 'Department', 'Exit Count', 'Total Early (mins)', 'Max Early (mins)'];
      rows = (data.employees || []).map(e => [
        e.employee_name, e.department || '', e.exit_count, e.total_early_minutes, e.max_early_minutes,
      ]);
    }

    if (!rows.length) { showToast('No data to export', 'error'); return; }

    const csv  = [headers, ...rows].map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `attendance_${data.type}_${MONTHS[month - 1]}_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportToExcel = () => {
    if (!data) return;
    let headers = [], rows = [];

    if (data.type === 'late_arrivals') {
      const late = (data.records || []).filter(r => parseInt(r.late_days) > 0);
      headers = ['Employee', 'Department', 'Designation', 'Present', 'Absent', 'Late Days', 'Late Count', 'Total Late Mins', 'Avg Hours'];
      rows = late.map(r => [
        r.employee_name || '', r.department || '', r.designation || '',
        r.present_days || 0, r.absent_days || 0, r.late_days || 0,
        r.late_arrivals || 0, r.total_late_minutes || 0,
        parseFloat(r.avg_hours || 0).toFixed(1),
      ]);
    } else if (data.type === 'overtime') {
      headers = ['Department', 'Employees w/ OT', 'Total OT Hours', 'Approved', 'Pending', 'Rejected', 'Avg Multiplier'];
      rows = (data.deptData || []).map(r => [
        r.department || 'Unknown', r.employees_with_ot || 0,
        parseFloat(r.total_ot_hours || 0).toFixed(1),
        r.approved_ot || 0, r.pending_ot || 0, r.rejected_ot || 0,
        parseFloat(r.avg_multiplier || 1.5).toFixed(2) + 'x',
      ]);
    } else if (data.type === 'department_wise') {
      headers = ['Department', 'Employees', 'Present Days', 'Absent Days', 'Late Days', 'Total Hours', 'Absenteeism %'];
      rows = (data.deptData || []).map(r => [
        r.department || 'Unknown', r.total_employees || 0,
        r.present_days || 0, r.absent_days || 0, r.late_days || 0,
        parseFloat(r.total_hours || 0).toFixed(0),
        parseFloat(r.absenteeism_rate || 0).toFixed(2) + '%',
      ]);
    } else if (data.type === 'absenteeism') {
      headers = ['Month', 'Year', 'Total Records', 'Absent', 'Present', 'Late', 'Unique Employees', 'Absenteeism %'];
      rows = (data.trends || []).map(r => [
        MONTHS_S[parseInt(r.month) - 1], r.year,
        r.total_records || 0, r.absent_count || 0, r.present_count || 0, r.late_count || 0,
        r.unique_employees || 0,
        parseFloat(r.absenteeism_rate || 0).toFixed(2) + '%',
      ]);
    } else if (data.type === 'shift_efficiency') {
      headers = ['Shift', 'Start', 'End', 'Assigned', 'Present', 'Late Minutes', 'Avg Hours', 'Attendance %'];
      rows = (data.shifts || []).map(r => [
        r.shift_name || '',
        String(r.start_time || '').slice(0, 5),
        String(r.end_time || '').slice(0, 5),
        r.assigned_employees || 0, r.present_count || 0,
        r.total_late_minutes || 0,
        r.avg_hours ? parseFloat(r.avg_hours).toFixed(1) : '—',
        parseFloat(r.attendance_rate || 0).toFixed(1) + '%',
      ]);
    } else if (data.type === 'leave_reconciliation') {
      headers = ['Employee', 'Department', 'Date', 'Attendance Status', 'Conflict Type', 'Leave Type'];
      rows = (data.conflicts || []).map(c => [
        c.employee_name, c.department || '', new Date(c.attendance_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }),
        c.attendance_status, c.conflict_type, c.leave_type || '',
      ]);
    } else if (data.type === 'early_exit') {
      headers = ['Employee', 'Department', 'Exit Count', 'Total Early (mins)', 'Max Early (mins)'];
      rows = (data.employees || []).map(e => [
        e.employee_name, e.department || '', e.exit_count, e.total_early_minutes, e.max_early_minutes,
      ]);
    }

    if (!rows.length) { showToast('No data to export', 'error'); return; }

    const title = `${MONTHS[month - 1]} ${year} — ${(REPORT_TYPES.find(r => r.id === data.type) || {}).label || data.type}`;
    let table = `<table border="1" style="border-collapse:collapse">`;
    table += `<tr><th colspan="${headers.length}" style="background:#1e40af;color:white;padding:8px">${title}</th></tr>`;
    table += `<tr>${headers.map(h => `<th style="background:#dbeafe;padding:4px">${h}</th>`).join('')}</tr>`;
    rows.forEach(row => {
      table += `<tr>${row.map(v => `<td style="padding:4px">${v}</td>`).join('')}</tr>`;
    });
    table += `</table>`;

    const blob = new Blob([table], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_${data.type}_${MONTHS[month - 1]}_${year}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => window.print();

  // ── Report renders ───────────────────────────────────────────────────────────

  const renderMonthlySummary = () => {
    const records  = data.records || [];
    const cmpRecs  = cmpData?.records || [];
    const cmpMap   = {};
    cmpRecs.forEach(r => { cmpMap[r.employee_id] = r; });

    const sum = (arr, key) => arr.reduce((s, r) => s + parseFloat(r[key] || 0), 0);
    const totalPresent = sum(records, 'present_days');
    const totalAbsent  = sum(records, 'absent_days');
    const totalLate    = sum(records, 'late_arrivals');
    const totalOT      = sum(records, 'total_ot_hours');
    const totalHours   = sum(records, 'total_hours');
    const synced       = records.filter(r => r.payroll_synced).length;

    if (!records.length) return <EmptyState msg={`No attendance records for ${MONTHS[month - 1]} ${year}`} />;

    return (
      <div>
        {/* KPI bar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
          <KpiCard label="Employees"       value={records.length}                       color={P}        />
          <KpiCard label="Present (total)" value={totalPresent}                         color="#10b981"  />
          <KpiCard label="Absent (total)"  value={totalAbsent}                          color="#ef4444"  />
          <KpiCard label="Late (total)"    value={totalLate}                            color="#f59e0b"  />
          <KpiCard label="OT Hours"        value={`${totalOT.toFixed(1)}h`}            color="#8b5cf6"  />
        </div>

        {/* Payroll sync status */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, background: synced === records.length ? '#dcfce7' : '#fef3c7', border: `1px solid ${synced === records.length ? '#86efac' : '#fde68a'}`, color: synced === records.length ? '#166534' : '#92400e' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {synced === records.length ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
            {synced === records.length
              ? `All ${records.length} records synced and frozen`
              : `${records.length - synced} of ${records.length} records not yet synced`}
          </div>
          <button
            onClick={handlePayrollSync}
            disabled={syncing || synced === records.length}
            style={{ padding: '5px 13px', borderRadius: 7, border: 'none', background: synced === records.length ? '#d1d5db' : P, color: '#fff', fontWeight: 600, cursor: synced === records.length ? 'default' : 'pointer', fontSize: 12, opacity: syncing ? 0.7 : 1, flexShrink: 0 }}
          >
            {syncing ? 'Syncing…' : synced === records.length ? '✓ Synced' : 'Sync to Payroll'}
          </button>
        </div>

        {/* Compare summary bar */}
        {cmpData && cmpRecs.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            {[
              { label: `${MONTHS[month - 1]} ${year} (current)`,        recs: records,  bg: '#f5f3ff', border: P       },
              { label: `${MONTHS[cmpMonth - 1]} ${cmpYear} (compare)`,  recs: cmpRecs,  bg: '#f9fafb', border: '#e5e7eb' },
            ].map(p => (
              <div key={p.label} style={{ background: p.bg, border: `1px solid ${p.border}`, borderRadius: 9, padding: '9px 13px' }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#374151', marginBottom: 5 }}>{p.label}</div>
                <div style={{ display: 'flex', gap: 14, fontSize: 13 }}>
                  <span>Absent: <b style={{ color: '#ef4444' }}>{sum(p.recs, 'absent_days')}</b></span>
                  <span>Late: <b style={{ color: '#f59e0b' }}>{sum(p.recs, 'late_arrivals')}</b></span>
                  <span>OT: <b style={{ color: '#8b5cf6' }}>{sum(p.recs, 'total_ot_hours').toFixed(1)}h</b></span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
                <TH>Employee</TH><TH>Dept</TH><TH>Present</TH><TH>Absent</TH>
                <TH>Late Days</TH><TH>WFH</TH><TH>½ Day</TH><TH>Late Count</TH>
                <TH>Late Mins</TH><TH>Hours</TH><TH>OT Hrs</TH><TH>Payroll</TH>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => {
                const cmp = cmpMap[r.employee_id];
                return (
                  <tr key={r.employee_id || i} style={{ borderBottom: '1px solid #f9fafb' }}>
                    <td style={{ padding: '8px 11px' }}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{r.employee_name}</div>
                      {r.designation && <div style={{ fontSize: 10, color: '#9ca3af' }}>{r.designation}</div>}
                    </td>
                    <td style={{ padding: '8px 11px', color: '#6b7280' }}>{r.department}</td>
                    <td style={{ padding: '8px 11px', color: '#10b981', fontWeight: 600 }}>
                      {r.present_days}
                      {cmp && <DeltaBadge cur={r.present_days} prev={cmp.present_days} />}
                    </td>
                    <td style={{ padding: '8px 11px', color: parseInt(r.absent_days) > 3 ? '#ef4444' : '#374151', fontWeight: parseInt(r.absent_days) > 3 ? 700 : 400 }}>
                      {r.absent_days}
                      {cmp && <DeltaBadge cur={r.absent_days} prev={cmp.absent_days} lowerIsBetter />}
                    </td>
                    <td style={{ padding: '8px 11px', color: '#f59e0b' }}>
                      {r.late_days}
                      {cmp && <DeltaBadge cur={r.late_days} prev={cmp.late_days} lowerIsBetter />}
                    </td>
                    <td style={{ padding: '8px 11px', color: '#3b82f6' }}>{r.wfh_days}</td>
                    <td style={{ padding: '8px 11px' }}>{r.half_days}</td>
                    <td style={{ padding: '8px 11px', color: parseInt(r.late_arrivals) >= 3 ? '#ef4444' : '#374151' }}>{r.late_arrivals}</td>
                    <td style={{ padding: '8px 11px', fontSize: 11 }}>{parseInt(r.total_late_minutes || 0)}m</td>
                    <td style={{ padding: '8px 11px', fontWeight: 500 }}>{parseFloat(r.total_hours || 0).toFixed(1)}h</td>
                    <td style={{ padding: '8px 11px', color: parseFloat(r.total_ot_hours) > 0 ? P : '#9ca3af', fontWeight: parseFloat(r.total_ot_hours) > 0 ? 600 : 400 }}>
                      {parseFloat(r.total_ot_hours || 0).toFixed(1)}h
                    </td>
                    <td style={{ padding: '8px 11px' }}>
                      <span style={{ background: r.payroll_synced ? '#dcfce7' : '#f3f4f6', color: r.payroll_synced ? '#166534' : '#9ca3af', borderRadius: 99, padding: '2px 8px', fontSize: 10, fontWeight: 600 }}>
                        {r.payroll_synced ? 'Synced' : 'Pending'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f5f3ff', borderTop: '2px solid #e9e4ff' }}>
                <td colSpan={2} style={{ padding: '8px 11px', fontWeight: 700, color: P, fontSize: 11 }}>TOTAL</td>
                <td style={{ padding: '8px 11px', fontWeight: 700, color: '#10b981' }}>{totalPresent}</td>
                <td style={{ padding: '8px 11px', fontWeight: 700, color: '#ef4444' }}>{totalAbsent}</td>
                <td style={{ padding: '8px 11px', fontWeight: 700, color: '#f59e0b' }}>{sum(records, 'late_days').toFixed(0)}</td>
                <td style={{ padding: '8px 11px' }}>{sum(records, 'wfh_days').toFixed(0)}</td>
                <td style={{ padding: '8px 11px' }}>{sum(records, 'half_days').toFixed(0)}</td>
                <td style={{ padding: '8px 11px', fontWeight: 700, color: '#ef4444' }}>{totalLate}</td>
                <td style={{ padding: '8px 11px', fontWeight: 700 }}>{sum(records, 'total_late_minutes').toFixed(0)}m</td>
                <td style={{ padding: '8px 11px', fontWeight: 700 }}>{totalHours.toFixed(1)}h</td>
                <td style={{ padding: '8px 11px', fontWeight: 700, color: P }}>{totalOT.toFixed(1)}h</td>
                <td style={{ padding: '8px 11px', fontWeight: 700 }}>{synced}/{records.length}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    );
  };

  const renderAbsenteeism = () => {
    const trends = data.trends || [];
    if (!trends.length) return <EmptyState msg="No absenteeism data available" />;

    const rates   = trends.map(r => parseFloat(r.absenteeism_rate || 0));
    const maxRate = Math.max(...rates, 1);
    const avgRate = (rates.reduce((s, v) => s + v, 0) / rates.length).toFixed(1);
    const peak    = trends.reduce((a, b) => parseFloat(a.absenteeism_rate) > parseFloat(b.absenteeism_rate) ? a : b, trends[0]);
    const trendDir = trends.length >= 2
      ? (parseFloat(trends[0].absenteeism_rate) > parseFloat(trends[1].absenteeism_rate) ? 'Worsening ↑' : 'Improving ↓')
      : 'Stable →';
    const trendColor = trendDir.startsWith('W') ? '#ef4444' : trendDir.startsWith('I') ? '#10b981' : '#6b7280';

    return (
      <div>
        <div style={{ marginBottom: 8, padding: '7px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7, fontSize: 11, color: '#92400e' }}>
          This report always reflects the last 12 months — month/year filter does not apply here.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
          <KpiCard label="Avg Rate (12 months)" value={`${avgRate}%`}                                            color="#ef4444" />
          <KpiCard label="Peak Month"           value={peak ? `${MONTHS_S[parseInt(peak.month) - 1]} ${peak.year}` : '—'} color="#f59e0b" />
          <KpiCard label="Recent Trend"         value={trendDir}                                                  color={trendColor} />
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
              <TH>Month</TH><TH>Total Records</TH><TH>Absent</TH><TH>Present</TH>
              <TH>Late</TH><TH>Unique Employees</TH><TH>Absenteeism Rate</TH>
            </tr>
          </thead>
          <tbody>
            {trends.map((r, i) => {
              const rate = parseFloat(r.absenteeism_rate || 0);
              const pct  = maxRate > 0 ? Math.min((rate / maxRate) * 100, 100) : 0;
              const color = rate > 20 ? '#ef4444' : rate > 10 ? '#f59e0b' : '#10b981';
              return (
                <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                  <td style={{ padding: '10px 11px', fontWeight: 600, color: '#111827' }}>{MONTHS_S[parseInt(r.month) - 1]} {r.year}</td>
                  <td style={{ padding: '10px 11px' }}>{r.total_records}</td>
                  <td style={{ padding: '10px 11px', color: '#ef4444', fontWeight: 600 }}>{r.absent_count}</td>
                  <td style={{ padding: '10px 11px', color: '#10b981' }}>{r.present_count}</td>
                  <td style={{ padding: '10px 11px', color: '#f59e0b' }}>{r.late_count}</td>
                  <td style={{ padding: '10px 11px' }}>{r.unique_employees}</td>
                  <td style={{ padding: '10px 11px', minWidth: 160 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 8, background: '#f3f4f6', borderRadius: 99 }}>
                        <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: color, transition: 'width 0.3s' }} />
                      </div>
                      <span style={{ fontWeight: 700, color, minWidth: 40, fontSize: 12 }}>{rate.toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderLateArrivals = () => {
    const records  = data.records || [];
    const lateOnly = [...records]
      .filter(r => parseInt(r.late_days) > 0)
      .sort((a, b) => parseInt(b.late_arrivals) - parseInt(a.late_arrivals));

    if (!lateOnly.length) return <EmptyState msg={`No late arrivals recorded in ${MONTHS[month - 1]} ${year}`} />;

    const totalCount = lateOnly.reduce((s, r) => s + parseInt(r.late_arrivals || 0), 0);
    const totalMins  = lateOnly.reduce((s, r) => s + parseInt(r.total_late_minutes || 0), 0);

    // most-affected department
    const deptMap = {};
    lateOnly.forEach(r => { deptMap[r.department] = (deptMap[r.department] || 0) + parseInt(r.late_arrivals || 0); });
    const worstDept = Object.entries(deptMap).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
          <KpiCard label="Employees Late"    value={lateOnly.length}                                     color="#f59e0b" />
          <KpiCard label="Total Late Count"  value={totalCount}                                          color="#ef4444" />
          <KpiCard label="Total Late Time"   value={`${Math.floor(totalMins / 60)}h ${totalMins % 60}m`} color="#8b5cf6" />
          <KpiCard label="Most Affected Dept" value={worstDept}                                          color="#0369a1" />
        </div>

        <div style={{ marginBottom: 12, padding: '7px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7, fontSize: 11, color: '#92400e' }}>
          Monthly aggregates per employee. For per-day records with actual check-in times and severity — use <strong>Attendance → Late Arrivals</strong>.
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#fffbeb', borderBottom: '1px solid #f0f0f4' }}>
              <TH>#</TH><TH>Employee</TH><TH>Department</TH><TH>Present</TH>
              <TH>Absent</TH><TH>Late Days</TH><TH>Late Count</TH><TH>Total Late Time</TH>
              <TH>Avg Hours</TH><TH>Risk</TH>
            </tr>
          </thead>
          <tbody>
            {lateOnly.map((r, i) => {
              const count = parseInt(r.late_arrivals || 0);
              const mins  = parseInt(r.total_late_minutes || 0);
              const risk  = count >= 10 ? { label: 'High',   bg: '#fee2e2', color: '#991b1b' }
                          : count >= 5  ? { label: 'Medium', bg: '#fef3c7', color: '#92400e' }
                          :               { label: 'Low',    bg: '#dcfce7', color: '#166534' };
              return (
                <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                  <td style={{ padding: '8px 11px', color: '#9ca3af', fontSize: 11 }}>{i + 1}</td>
                  <td style={{ padding: '8px 11px', fontWeight: 600, color: '#111827' }}>{r.employee_name}</td>
                  <td style={{ padding: '8px 11px', color: '#6b7280' }}>{r.department}</td>
                  <td style={{ padding: '8px 11px', color: '#10b981' }}>{r.present_days}</td>
                  <td style={{ padding: '8px 11px', color: '#ef4444' }}>{r.absent_days}</td>
                  <td style={{ padding: '8px 11px', color: '#f59e0b', fontWeight: 700 }}>{r.late_days}</td>
                  <td style={{ padding: '8px 11px', color: count >= 5 ? '#ef4444' : '#374151', fontWeight: count >= 5 ? 700 : 400 }}>{count}×</td>
                  <td style={{ padding: '8px 11px' }}>{Math.floor(mins / 60)}h {mins % 60}m</td>
                  <td style={{ padding: '8px 11px' }}>{parseFloat(r.avg_hours || 0).toFixed(1)}h</td>
                  <td style={{ padding: '8px 11px' }}>
                    <span style={{ background: risk.bg, color: risk.color, borderRadius: 99, padding: '2px 8px', fontSize: 10, fontWeight: 700 }}>{risk.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderOvertime = () => {
    const depts = data.deptData || [];
    if (!depts.length) return <EmptyState msg={`No overtime records in ${MONTHS[month - 1]} ${year}`} />;

    const cmpDepts    = cmpData?.deptData || [];
    const totalOT     = depts.reduce((s, r) => s + parseFloat(r.total_ot_hours || 0), 0);
    const totalEmpOT  = depts.reduce((s, r) => s + parseInt(r.employees_with_ot || 0), 0);
    const totalPend   = depts.reduce((s, r) => s + parseInt(r.pending_ot  || 0), 0);
    const totalAppr   = depts.reduce((s, r) => s + parseInt(r.approved_ot || 0), 0);
    const totalRej    = depts.reduce((s, r) => s + parseInt(r.rejected_ot || 0), 0);
    const cmpTotalOT  = cmpDepts.reduce((s, r) => s + parseFloat(r.total_ot_hours || 0), 0);

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <KpiCard label="Total OT Hours"     value={`${totalOT.toFixed(1)}h`} color={P}        />
          <KpiCard label="Employees with OT"  value={totalEmpOT}               color="#10b981"  />
          <KpiCard label="Approved"           value={totalAppr}                color="#0369a1"  />
          <KpiCard label="Pending Approval"   value={totalPend}                color="#f59e0b"  />
        </div>

        {cmpData && cmpDepts.length > 0 && (
          <div style={{ padding: '8px 14px', marginBottom: 14, borderRadius: 8, background: '#f5f3ff', border: '1px solid #e9e4ff', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <TrendingUp size={14} color={P} />
            vs {MONTHS[cmpMonth - 1]} {cmpYear}: OT was <b style={{ margin: '0 4px' }}>{cmpTotalOT.toFixed(1)}h</b>
            {totalOT !== cmpTotalOT && (
              <span style={{ color: totalOT > cmpTotalOT ? '#ef4444' : '#10b981', fontWeight: 700 }}>
                ({totalOT > cmpTotalOT ? '+' : ''}{(totalOT - cmpTotalOT).toFixed(1)}h)
              </span>
            )}
          </div>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
              <TH>Department</TH><TH>Employees w/ OT</TH><TH>Total OT Hours</TH>
              <TH>Approved</TH><TH>Pending</TH><TH>Rejected</TH><TH>Avg Multiplier</TH>
            </tr>
          </thead>
          <tbody>
            {depts.map((d, i) => {
              const cmp = cmpDepts.find(c => c.department === d.department);
              return (
                <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                  <td style={{ padding: '10px 11px', fontWeight: 600, color: '#111827' }}>{d.department || 'Unknown'}</td>
                  <td style={{ padding: '10px 11px' }}>{d.employees_with_ot}</td>
                  <td style={{ padding: '10px 11px', fontWeight: 700, color: P }}>
                    {parseFloat(d.total_ot_hours || 0).toFixed(1)}h
                    {cmp && <DeltaBadge cur={parseFloat(d.total_ot_hours || 0).toFixed(1)} prev={parseFloat(cmp.total_ot_hours || 0).toFixed(1)} lowerIsBetter />}
                  </td>
                  <td style={{ padding: '10px 11px', color: '#10b981', fontWeight: 600 }}>{d.approved_ot}</td>
                  <td style={{ padding: '10px 11px', color: parseInt(d.pending_ot) > 0 ? '#f59e0b' : '#9ca3af', fontWeight: parseInt(d.pending_ot) > 0 ? 700 : 400 }}>{d.pending_ot}</td>
                  <td style={{ padding: '10px 11px', color: parseInt(d.rejected_ot) > 0 ? '#ef4444' : '#9ca3af' }}>{d.rejected_ot}</td>
                  <td style={{ padding: '10px 11px' }}>{parseFloat(d.avg_multiplier || 1.5).toFixed(2)}×</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: '#f5f3ff', borderTop: '2px solid #e9e4ff' }}>
              <td style={{ padding: '8px 11px', fontWeight: 700, color: P, fontSize: 11 }}>TOTAL</td>
              <td style={{ padding: '8px 11px', fontWeight: 700 }}>{totalEmpOT}</td>
              <td style={{ padding: '8px 11px', fontWeight: 700, color: P }}>{totalOT.toFixed(1)}h</td>
              <td style={{ padding: '8px 11px', fontWeight: 700, color: '#10b981' }}>{totalAppr}</td>
              <td style={{ padding: '8px 11px', fontWeight: 700, color: '#f59e0b' }}>{totalPend}</td>
              <td style={{ padding: '8px 11px', fontWeight: 700, color: '#ef4444' }}>{totalRej}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  const renderDeptWise = () => {
    const depts    = data.deptData || [];
    if (!depts.length) return <EmptyState msg="No department data available" />;

    const cmpDepts = cmpData?.deptData || [];
    const maxRate  = Math.max(...depts.map(d => parseFloat(d.absenteeism_rate || 0)), 1);

    return (
      <div>
        {/* Top 3 worst-absenteeism cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
          {depts.slice(0, 3).map((d, i) => {
            const rate  = parseFloat(d.absenteeism_rate || 0);
            const color = rate > 20 ? '#ef4444' : rate > 10 ? '#f59e0b' : '#10b981';
            return (
              <div key={i} style={{ border: `1px solid ${color}25`, borderRadius: 10, padding: 14, background: `${color}08` }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#374151' }}>{d.department || 'Unknown'}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 8 }}>{d.total_employees} employees</div>
                <div style={{ fontSize: 24, fontWeight: 700, color }}>{rate.toFixed(1)}%</div>
                <div style={{ fontSize: 10, color: '#9ca3af' }}>absenteeism rate</div>
              </div>
            );
          })}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
              <TH>Department</TH><TH>Employees</TH><TH>Present</TH><TH>Absent</TH>
              <TH>Late</TH><TH>Hours</TH><TH>Absenteeism %</TH>
            </tr>
          </thead>
          <tbody>
            {depts.map((d, i) => {
              const rate  = parseFloat(d.absenteeism_rate || 0);
              const pct   = maxRate > 0 ? (rate / maxRate) * 100 : 0;
              const color = rate > 20 ? '#ef4444' : rate > 10 ? '#f59e0b' : '#10b981';
              const cmp   = cmpDepts.find(c => c.department === d.department);
              return (
                <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                  <td style={{ padding: '10px 11px', fontWeight: 600, color: '#111827' }}>{d.department || 'Unknown'}</td>
                  <td style={{ padding: '10px 11px' }}>{d.total_employees}</td>
                  <td style={{ padding: '10px 11px', color: '#10b981', fontWeight: 600 }}>{d.present_days}</td>
                  <td style={{ padding: '10px 11px', color: '#ef4444' }}>
                    {d.absent_days}
                    {cmp && <DeltaBadge cur={d.absent_days} prev={cmp.absent_days} lowerIsBetter />}
                  </td>
                  <td style={{ padding: '10px 11px', color: '#f59e0b' }}>{d.late_days}</td>
                  <td style={{ padding: '10px 11px' }}>{parseFloat(d.total_hours || 0).toFixed(0)}h</td>
                  <td style={{ padding: '10px 11px', minWidth: 160 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 8, background: '#f3f4f6', borderRadius: 99 }}>
                        <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: color }} />
                      </div>
                      <span style={{ fontWeight: 700, color, minWidth: 42, fontSize: 12 }}>
                        {rate.toFixed(1)}%
                        {cmp && <DeltaBadge cur={rate.toFixed(1)} prev={parseFloat(cmp.absenteeism_rate || 0).toFixed(1)} lowerIsBetter />}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderShiftEfficiency = () => {
    const shifts = data.shifts || [];
    if (!shifts.length) return <EmptyState msg="No shift data available — ensure shifts are configured" />;

    const totalAssigned = shifts.reduce((s, r) => s + parseInt(r.assigned_employees || 0), 0);
    const totalPresent  = shifts.reduce((s, r) => s + parseInt(r.present_count || 0), 0);
    const avgRate       = shifts.length > 0
      ? (shifts.reduce((s, r) => s + parseFloat(r.attendance_rate || 0), 0) / shifts.length).toFixed(1)
      : 0;

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
          <KpiCard label="Total Shifts"        value={shifts.length}  color={P}        />
          <KpiCard label="Assigned Employees"  value={totalAssigned}  color="#10b981"  />
          <KpiCard label="Avg Fill Rate"        value={`${avgRate}%`}  color={parseFloat(avgRate) >= 80 ? '#10b981' : parseFloat(avgRate) >= 60 ? '#f59e0b' : '#ef4444'} />
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
              <TH>Shift Name</TH><TH>Timing</TH><TH>Assigned</TH><TH>Present</TH>
              <TH>Late Minutes</TH><TH>Avg Hours</TH><TH>Fill Rate</TH>
            </tr>
          </thead>
          <tbody>
            {shifts.map((s, i) => {
              const rate  = parseFloat(s.attendance_rate || 0);
              const color = rate >= 80 ? '#10b981' : rate >= 60 ? '#f59e0b' : '#ef4444';
              return (
                <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                  <td style={{ padding: '10px 11px', fontWeight: 600, color: '#111827' }}>{s.shift_name}</td>
                  <td style={{ padding: '10px 11px', color: '#6b7280', fontSize: 12 }}>
                    {String(s.start_time || '').slice(0, 5)} – {String(s.end_time || '').slice(0, 5)}
                  </td>
                  <td style={{ padding: '10px 11px' }}>{s.assigned_employees}</td>
                  <td style={{ padding: '10px 11px', color: '#10b981', fontWeight: 600 }}>{s.present_count}</td>
                  <td style={{ padding: '10px 11px', color: parseInt(s.total_late_minutes) > 0 ? '#f59e0b' : '#9ca3af' }}>
                    {s.total_late_minutes || 0}m
                  </td>
                  <td style={{ padding: '10px 11px' }}>
                    {s.avg_hours ? `${parseFloat(s.avg_hours).toFixed(1)}h` : '—'}
                  </td>
                  <td style={{ padding: '10px 11px', minWidth: 140 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 8, background: '#f3f4f6', borderRadius: 99 }}>
                        <div style={{ height: '100%', borderRadius: 99, width: `${Math.min(rate, 100)}%`, background: color }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 40 }}>{rate.toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: '#f5f3ff', borderTop: '2px solid #e9e4ff' }}>
              <td colSpan={2} style={{ padding: '8px 11px', fontWeight: 700, color: P, fontSize: 11 }}>TOTAL / AVG</td>
              <td style={{ padding: '8px 11px', fontWeight: 700 }}>{totalAssigned}</td>
              <td style={{ padding: '8px 11px', fontWeight: 700, color: '#10b981' }}>{totalPresent}</td>
              <td style={{ padding: '8px 11px', fontWeight: 700 }}>
                {shifts.reduce((s, r) => s + parseInt(r.total_late_minutes || 0), 0)}m
              </td>
              <td style={{ padding: '8px 11px' }}>—</td>
              <td style={{ padding: '8px 11px', fontWeight: 700 }}>{avgRate}%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  const renderLeaveReconciliation = () => {
    const conflicts = data.conflicts || [];
    if (!conflicts.length) return <EmptyState msg="No leave vs attendance conflicts found for this period." />;

    const CONFLICT_META = {
      absent_no_leave:       { label: 'Absent — No Leave',        bg: '#fef2f2', color: '#dc2626' },
      present_despite_leave: { label: 'Present — Leave Approved', bg: '#fffbeb', color: '#d97706' },
    };

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
          <KpiCard label="Total Conflicts"          value={data.total_conflicts}         color="#dc2626" />
          <KpiCard label="Absent Without Leave"     value={data.absent_no_leave}         color="#ef4444" />
          <KpiCard label="Present Despite Leave"    value={data.present_despite_leave}   color="#f59e0b" />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#fafafa', borderBottom: '2px solid #f0f0f4' }}>
                <TH>Employee</TH><TH>Department</TH><TH>Date</TH>
                <TH>Attendance</TH><TH>Conflict Type</TH><TH>Leave Type</TH>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c, i) => {
                const meta = CONFLICT_META[c.conflict_type] || { label: c.conflict_type, bg: '#f9fafb', color: '#6b7280' };
                return (
                  <tr key={i} style={{ borderBottom: '1px solid #f5f5f7' }}>
                    <td style={{ padding: '9px 11px', fontWeight: 600 }}>
                      {c.employee_name}
                      {c.designation && <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{c.designation}</div>}
                    </td>
                    <td style={{ padding: '9px 11px', color: '#6b7280', fontSize: 12 }}>{c.department || '—'}</td>
                    <td style={{ padding: '9px 11px', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                      {new Date(c.attendance_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                    </td>
                    <td style={{ padding: '9px 11px' }}>
                      <span style={{ background: '#f5f3ff', color: P, borderRadius: 8, padding: '2px 8px', fontSize: 11, fontWeight: 600, textTransform: 'capitalize' }}>
                        {c.attendance_status}
                      </span>
                    </td>
                    <td style={{ padding: '9px 11px' }}>
                      <span style={{ background: meta.bg, color: meta.color, borderRadius: 8, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
                        {meta.label}
                      </span>
                    </td>
                    <td style={{ padding: '9px 11px', color: '#6b7280', fontSize: 12 }}>{c.leave_type || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderEarlyExit = () => {
    const employees = data.employees || [];
    if (!employees.length) return <EmptyState msg="No early exit incidents found for this period." />;

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
          <KpiCard label="Total Incidents"      value={data.total_incidents}    color="#ea580c" />
          <KpiCard label="Employees Affected"   value={data.employees_affected} color="#f59e0b" />
          <KpiCard label="Min Early Threshold"  value={`${data.min_early_minutes}m`} color="#6b7280" />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#fafafa', borderBottom: '2px solid #f0f0f4' }}>
                <TH>Employee</TH><TH>Department</TH><TH>Exits</TH>
                <TH>Total Early (mins)</TH><TH>Worst Day</TH><TH>Sample Dates</TH>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f5f5f7' }}>
                  <td style={{ padding: '9px 11px', fontWeight: 600 }}>
                    {emp.employee_name}
                    {emp.designation && <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{emp.designation}</div>}
                  </td>
                  <td style={{ padding: '9px 11px', color: '#6b7280', fontSize: 12 }}>{emp.department || '—'}</td>
                  <td style={{ padding: '9px 11px', textAlign: 'center' }}>
                    <span style={{ background: emp.exit_count >= 5 ? '#fef2f2' : '#fffbeb', color: emp.exit_count >= 5 ? '#dc2626' : '#d97706', borderRadius: 8, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
                      {emp.exit_count}
                    </span>
                  </td>
                  <td style={{ padding: '9px 11px', fontWeight: 600, color: '#ea580c', fontVariantNumeric: 'tabular-nums' }}>
                    {emp.total_early_minutes}m
                  </td>
                  <td style={{ padding: '9px 11px', color: '#ef4444', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {emp.max_early_minutes}m early
                  </td>
                  <td style={{ padding: '9px 11px', fontSize: 11, color: '#6b7280' }}>
                    {(emp.dates || []).slice(0, 3).map(d => (
                      <span key={d.date} style={{ display: 'inline-block', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6, padding: '1px 6px', marginRight: 4, marginBottom: 2, whiteSpace: 'nowrap' }}>
                        {new Date(d.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        {' '}({d.early_by}m)
                      </span>
                    ))}
                    {(emp.dates || []).length > 3 && <span style={{ color: '#9ca3af' }}>+{emp.dates.length - 3} more</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderReport = () => {
    if (!data) return (
      <div style={{ textAlign: 'center', padding: 80, color: '#9ca3af' }}>
        <FileText size={44} color="#e5e7eb" style={{ display: 'block', margin: '0 auto 12px' }} />
        <div style={{ fontSize: 14, fontWeight: 500, color: '#6b7280', marginBottom: 4 }}>No report generated yet</div>
        <div style={{ fontSize: 12 }}>Select a report type and filters on the left, then click Generate</div>
      </div>
    );
    switch (data.type) {
      case 'absenteeism':          return renderAbsenteeism();
      case 'late_arrivals':        return renderLateArrivals();
      case 'overtime':             return renderOvertime();
      case 'department_wise':      return renderDeptWise();
      case 'shift_efficiency':     return renderShiftEfficiency();
      case 'leave_reconciliation': return renderLeaveReconciliation();
      case 'early_exit':           return renderEarlyExit();
      default:                     return <EmptyState msg="Unknown report type" />;
    }
  };

  const sel = REPORT_TYPES.find(r => r.id === reportType);

  // ── JSX ──────────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }} id="report-print-root">

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, padding: '12px 18px', borderRadius: 10, background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`, color: toast.type === 'error' ? '#991b1b' : '#166534', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,.1)' }}>
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle size={15} />} {toast.msg}
        </div>
      )}

      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Attendance Reports</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Generate, compare, and export attendance reports</p>
        </div>
        {data && (
          <div style={{ display: 'flex', gap: 8 }} className="no-print">
            <button onClick={exportCSV}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 9, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, cursor: 'pointer', color: P, fontWeight: 500 }}>
              <Download size={13} /> Export CSV
            </button>
            <button onClick={exportToExcel}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 9, border: '1px solid #bbf7d0', background: '#f0fdf4', fontSize: 13, cursor: 'pointer', color: '#15803d', fontWeight: 500 }}>
              <Download size={13} /> Export Excel
            </button>
            <button onClick={exportPDF}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 9, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151', fontWeight: 500 }}>
              <Printer size={13} /> Print / PDF
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'start' }} className="report-grid">

        {/* LEFT: config panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} className="no-print">

          {/* Report type selector */}
          <div style={CARD}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Report Type</div>
            {REPORT_TYPES.map(r => (
              <button key={r.id} onClick={() => { setReportType(r.id); setData(null); setCmpData(null); }}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '8px 10px', borderRadius: 8, border: 'none', background: reportType === r.id ? `${r.color}12` : 'transparent', cursor: 'pointer', marginBottom: 2, textAlign: 'left', outline: 'none' }}>
                <r.icon size={14} color={reportType === r.id ? r.color : '#9ca3af'} style={{ marginTop: 1, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: reportType === r.id ? 700 : 500, color: reportType === r.id ? r.color : '#374151' }}>{r.label}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af', lineHeight: 1.4 }}>{r.desc}</div>
                </div>
              </button>
            ))}
          </div>

          {/* Filters + generate */}
          <div style={CARD}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Period & Filters</div>

            <label style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 4 }}>MONTH</label>
            <select value={month} onChange={e => setMonth(parseInt(e.target.value))}
              style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, width: '100%', marginBottom: 10, outline: 'none' }}>
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>

            <label style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 4 }}>YEAR</label>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))}
              style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, width: '100%', marginBottom: 10, outline: 'none' }}>
              {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>

            <label style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 4 }}>DEPARTMENT</label>
            <select value={department} onChange={e => setDept(e.target.value)}
              style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, width: '100%', marginBottom: 14, outline: 'none' }}>
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>

            {/* Compare toggle */}
            <div style={{ borderTop: '1px solid #f0f0f4', paddingTop: 12, marginBottom: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: comparing ? P : '#6b7280', marginBottom: comparing ? 10 : 0 }}>
                <input type="checkbox" checked={comparing} onChange={e => { setComparing(e.target.checked); setCmpData(null); }} style={{ accentColor: P }} />
                Compare with period
              </label>
              {comparing && (
                <div>
                  {reportType === 'absenteeism' && (
                    <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 6 }}>Absenteeism always shows last 12 months — compare not applicable.</div>
                  )}
                  {reportType !== 'absenteeism' && (
                    <>
                      <label style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 4 }}>COMPARE MONTH</label>
                      <select value={cmpMonth} onChange={e => setCmpMonth(parseInt(e.target.value))}
                        style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '6px 10px', fontSize: 12, width: '100%', marginBottom: 6, outline: 'none' }}>
                        {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                      </select>
                      <label style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 4 }}>COMPARE YEAR</label>
                      <select value={cmpYear} onChange={e => setCmpYear(parseInt(e.target.value))}
                        style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '6px 10px', fontSize: 12, width: '100%', outline: 'none' }}>
                        {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </>
                  )}
                </div>
              )}
            </div>

            <button onClick={run} disabled={loading}
              style={{ width: '100%', padding: '11px', borderRadius: 8, border: 'none', background: sel?.color || P, color: '#fff', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {loading
                ? <><RefreshCw size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> Generating…</>
                : <><FileText size={14} /> Generate</>}
            </button>
          </div>
        </div>

        {/* RIGHT: report output */}
        <div style={CARD}>
          {/* Report header (visible in print too) */}
          {sel && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid #f0f0f4' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: `${sel.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <sel.icon size={18} color={sel.color} />
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>{sel.label}</h2>
                  <p style={{ margin: 0, fontSize: 12, color: '#9ca3af' }}>
                    {MONTHS[month - 1]} {year}{department ? ` · ${department}` : ' · All Departments'}
                    {comparing && cmpData ? ` vs ${MONTHS[cmpMonth - 1]} ${cmpYear}` : ''}
                  </p>
                </div>
              </div>
              {data && <div style={{ fontSize: 11, color: '#9ca3af' }}>{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>}
            </div>
          )}

          {err && (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', color: '#dc2626', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertCircle size={14} /> {err}
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', padding: 80, color: '#9ca3af' }}>
              <RefreshCw size={28} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px', animation: 'spin 0.8s linear infinite' }} />
              Generating report…
            </div>
          ) : renderReport()}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media print {
          .no-print  { display: none !important; }
          .report-grid { display: block !important; }
          #report-print-root { padding: 8px !important; }
          body { background: white !important; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}
