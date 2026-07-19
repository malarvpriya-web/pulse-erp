import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BarChart2, Download, RefreshCw, CheckCircle, X,
  Clock, AlertCircle, Users, TrendingUp, Lock, Info, Printer,
} from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const P    = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 };

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function SummaryCard({ icon: Icon, label, value, color, bg }) {
  return (
    <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 44, height: 44, borderRadius: 10, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={20} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>{value}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
      </div>
    </div>
  );
}

export default function MonthlyAttendanceReport() {
  const now = new Date();
  const [month, setMonth]           = useState(now.getMonth() + 1);
  const [year, setYear]             = useState(now.getFullYear());
  const [dept, setDept]             = useState('');
  const [search, setSearch]         = useState('');
  const [data, setData]             = useState(null);
  const [error, setError]           = useState(null);
  const [loading, setLoading]       = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [deptOptions, setDeptOptions] = useState([]);
  const [sortBy, setSortBy]         = useState('lop_days');
  const [sortDir, setSortDir]       = useState('desc');
  const [freezing, setFreezing]     = useState(false);
  const [toast, setToast]           = useState(null);
  const [pendingPayrollSync, setPendingPayrollSync] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ month, year });
      if (dept) params.set('department', dept);

      const [reportRes, syncRes] = await Promise.all([
        api.get(`/attendance/monthly-report?${params}`),
        api.get(`/attendance/sync-status?month=${month}&year=${year}`).catch(() => ({ data: null })),
      ]);

      if (isMounted.current) {
        setData(reportRes.data || null);
        setSyncStatus(syncRes.data || null);
        const depts = [
          ...new Set((reportRes.data?.records || []).map(r => r.department).filter(Boolean)),
        ].sort();
        setDeptOptions(depts);
      }
    } catch (err) {
      if (isMounted.current) {
        setError(err.response?.data?.error || 'Failed to load report. Check your connection and try again.');
        setData(null);
      }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [month, year, dept]);

  useEffect(() => { load(); }, [load]);

  const showMsg = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 4000);
  };

  const handlePayrollSync = async () => {
    if (!pendingPayrollSync) return;
    setPendingPayrollSync(false);

    setFreezing(true);
    try {
      const res = await api.post('/attendance/payroll-sync', { month, year });
      showMsg(
        `Synced ${res.data.employees_processed} employees · ${res.data.working_days} working days · attendance frozen`
      );
      await load();
    } catch (e) {
      const status = e.response?.status;
      if (status === 409) {
        const d = e.response.data;
        showMsg(`Already synced: ${d.synced_count} records frozen. Contact Admin to re-sync.`, 'error');
      } else if (status === 403) {
        showMsg('Permission denied: Only HR Admin can sync attendance to payroll.', 'error');
      } else {
        showMsg(e.response?.data?.error || 'Sync failed', 'error');
      }
    } finally {
      if (isMounted.current) setFreezing(false);
    }
  };

  const exportToExcel = () => {
    if (!sorted.length) return;
    const headers = ['Employee', 'Department', 'Designation', 'Present', 'Absent', 'Late', 'WFH', 'Half Day', 'OT Hours', 'LOP Days', 'Attendance %'];
    const rows = sorted.map(r => [
      r.employee_name || '',
      r.department || '',
      r.designation || '',
      r.present_days || 0,
      r.absent_days || 0,
      r.late_days || 0,
      r.wfh_days || 0,
      r.half_days || 0,
      parseFloat(r.total_ot_hours || 0).toFixed(1),
      parseFloat(r.lop_days || 0).toFixed(1),
      `${r.attendance_pct || 0}%`,
    ]);

    let table = `<table border="1" style="border-collapse:collapse">`;
    table += `<tr><th colspan="${headers.length}" style="background:#1e40af;color:white;padding:8px">Attendance Report — ${MONTH_NAMES[month - 1]} ${year}</th></tr>`;
    table += `<tr>${headers.map(h => `<th style="background:#dbeafe;padding:4px">${h}</th>`).join('')}</tr>`;
    rows.forEach(row => {
      table += `<tr>${row.map(v => `<td style="padding:4px">${v}</td>`).join('')}</tr>`;
    });
    table += `</table>`;

    const blob = new Blob([table], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${month}-${year}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Export uses sorted (filtered) rows, not raw data.records
  const downloadCSV = () => {
    if (!sorted.length) return;
    const rows = [[
      'Employee', 'Department', 'Designation',
      'Working Days', 'Present', 'LOP Days', 'Absent (Marked)', 'Late Days',
      'Half Day', 'WFH', 'Late Count', 'Total Late Min',
      'Total Hours', 'OT Hours', 'Avg Hours', 'Attendance %', 'Payroll Synced',
    ]];
    sorted.forEach(r => rows.push([
      r.employee_name, r.department, r.designation,
      r.working_days, r.present_days, r.lop_days, r.absent_days, r.late_days,
      r.half_days, r.wfh_days, r.late_arrivals, r.total_late_minutes,
      parseFloat(r.total_hours    || 0).toFixed(1),
      parseFloat(r.total_ot_hours || 0).toFixed(1),
      r.avg_hours, r.attendance_pct,
      r.payroll_synced ? 'Yes' : 'No',
    ]));
    const csv  = rows.map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `attendance-report-${MONTH_NAMES[month - 1]}-${year}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const records = (data?.records || []).filter(r =>
    !search ||
    r.employee_name?.toLowerCase().includes(search.toLowerCase()) ||
    r.department?.toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...records].sort((a, b) => {
    const av = parseFloat(a[sortBy] ?? 0);
    const bv = parseFloat(b[sortBy] ?? 0);
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  const handleSort = col => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const totalPresent = records.reduce((s, r) => s + parseInt(r.present_days   || 0), 0);
  const totalLOP     = records.reduce((s, r) => s + parseFloat(r.lop_days     || 0), 0);
  const totalLate    = records.reduce((s, r) => s + parseInt(r.late_arrivals  || 0), 0);
  const totalHours   = records.reduce((s, r) => s + parseFloat(r.total_hours  || 0), 0);
  const totalOT      = records.reduce((s, r) => s + parseFloat(r.total_ot_hours || 0), 0);
  const synced       = records.filter(r => r.payroll_synced).length;
  const allSynced    = records.length > 0 && synced === records.length;

  const ColHeader = ({ label, col, title }) => (
    <th
      onClick={() => handleSort(col)}
      title={title}
      style={{
        padding: '8px 10px', textAlign: 'left', cursor: 'pointer', userSelect: 'none',
        whiteSpace: 'nowrap', fontSize: 11, fontWeight: 500,
        color: sortBy === col ? P : '#6b7280',
      }}
    >
      {label}{sortBy === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  );

  const renderSyncBanner = () => {
    if (!data || records.length === 0) return null;
    if (syncStatus?.synced) {
      const ts = new Date(syncStatus.synced_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
      return (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
          borderRadius: 8, marginBottom: 16, fontSize: 13,
          background: '#dcfce7', border: '1px solid #86efac', color: '#166534',
        }}>
          <Lock size={14} />
          <span>
            <strong>Attendance frozen &amp; synced to payroll</strong>
            {' '}· {syncStatus.employees_processed} employees
            {' '}· {syncStatus.working_days} working days
            {' '}· Last synced {ts} by {syncStatus.synced_by_name}
          </span>
        </div>
      );
    }
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderRadius: 8, marginBottom: 16, fontSize: 13,
        background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e',
      }}>
        <Info size={14} />
        <span>
          {synced > 0
            ? `${records.length - synced} of ${records.length} records not yet synced to payroll`
            : 'Not yet synced — click "Sync to Payroll" to freeze attendance and compute LOP days'}
        </span>
      </div>
    );
  };

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      <ConfirmDialog
        open={pendingPayrollSync}
        title="Sync Attendance to Payroll"
        message={`Sync ${MONTH_NAMES[month - 1]} ${year} attendance to payroll? This will freeze all attendance records and update pending payslips with LOP days. Employees: ${records?.length || 0}.`}
        confirmLabel="Sync"
        variant="warning"
        onConfirm={handlePayrollSync}
        onCancel={() => setPendingPayrollSync(false)}
      />
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          padding: '12px 18px', borderRadius: 10,
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7',
          border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`,
          color:  toast.type === 'error' ? '#991b1b' : '#166534',
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 14, boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
        }}>
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>Monthly Attendance Report</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            {data
              ? `${MONTH_NAMES[month - 1]} ${year} · ${records.length} employees · ${data.working_days} working days`
              : `${MONTH_NAMES[month - 1]} ${year}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            onClick={() => setPendingPayrollSync(true)}
            disabled={freezing || !data || records.length === 0}
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: allSynced ? '#d1d5db' : P,
              color: '#fff', fontWeight: 600,
              cursor: (freezing || !data || records.length === 0) ? 'not-allowed' : 'pointer',
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
              opacity: (!data || records.length === 0) ? 0.5 : 1,
            }}
            title={allSynced ? 'All records already synced' : 'Freeze attendance and compute LOP for payroll'}
          >
            {allSynced && <Lock size={13} />}
            {freezing ? 'Syncing…' : allSynced ? 'Synced' : 'Sync to Payroll'}
          </button>
          <button
            onClick={exportToExcel}
            disabled={!sorted.length}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
              borderRadius: 8, border: '1px solid #bbf7d0', background: '#f0fdf4',
              cursor: sorted.length ? 'pointer' : 'not-allowed',
              fontSize: 13, color: '#15803d', opacity: sorted.length ? 1 : 0.5,
            }}
          >
            <Download size={13} /> Export Excel
          </button>
          <button
            onClick={downloadCSV}
            disabled={!sorted.length}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
              borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff',
              cursor: sorted.length ? 'pointer' : 'not-allowed',
              fontSize: 13, color: '#374151', opacity: sorted.length ? 1 : 0.5,
            }}
          >
            <Download size={13} /> Export CSV
          </button>
          <button
            onClick={() => window.print()}
            disabled={!sorted.length}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
              borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff',
              cursor: sorted.length ? 'pointer' : 'not-allowed',
              fontSize: 13, color: '#374151', opacity: sorted.length ? 1 : 0.5,
            }}
          >
            <Printer size={13} /> Print / PDF
          </button>
          <button
            onClick={load}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
              borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff',
              cursor: 'pointer', fontSize: 13, color: '#374151',
            }}
          >
            <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={month}
          onChange={e => setMonth(parseInt(e.target.value))}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}
        >
          {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select
          value={year}
          onChange={e => setYear(parseInt(e.target.value))}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}
        >
          {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select
          value={dept}
          onChange={e => setDept(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, minWidth: 180 }}
        >
          <option value="">All Departments</option>
          {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <input
          placeholder="Search employee…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, width: 200 }}
        />
      </div>

      {/* Summary KPIs */}
      {data && records.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 14, marginBottom: 20 }}>
          <SummaryCard icon={Users}       label="Employees"    value={records.length}              color={P}       bg="#f5f3ff" />
          <SummaryCard icon={CheckCircle} label="Present Days" value={totalPresent}                 color="#10b981" bg="#dcfce7" />
          <SummaryCard icon={X}           label="LOP Days"     value={totalLOP.toFixed(1)}           color="#ef4444" bg="#fee2e2" />
          <SummaryCard icon={Clock}       label="Late Arrivals" value={totalLate}                   color="#f59e0b" bg="#fef3c7" />
          <SummaryCard icon={TrendingUp}  label="Total Hours"  value={`${totalHours.toFixed(0)}h`}  color="#0369a1" bg="#e0f2fe" />
          <SummaryCard icon={BarChart2}   label="OT Hours"     value={`${totalOT.toFixed(1)}h`}     color="#8b5cf6" bg="#ede9fe" />
        </div>
      )}

      {/* Sync status banner */}
      {renderSyncBanner()}

      {/* Body */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 80, color: '#9ca3af' }}>
          <RefreshCw size={24} color="#e5e7eb" style={{ marginBottom: 12, animation: 'spin 1s linear infinite' }} />
          <div>Generating report…</div>
        </div>
      ) : error ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <AlertCircle size={36} color="#fca5a5" style={{ marginBottom: 12 }} />
          <div style={{ color: '#dc2626', fontWeight: 600, marginBottom: 8 }}>Failed to load report</div>
          <div style={{ color: '#9ca3af', fontSize: 13, marginBottom: 20 }}>{error}</div>
          <button
            onClick={load}
            style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', cursor: 'pointer', fontWeight: 600 }}
          >
            Retry
          </button>
        </div>
      ) : !data || records.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <BarChart2 size={36} color="#e5e7eb" style={{ marginBottom: 12 }} />
          <div style={{ fontWeight: 500, marginBottom: 6 }}>
            {data ? `No employees found for ${MONTH_NAMES[month - 1]} ${year}` : 'No records found'}
          </div>
          <div style={{ fontSize: 12 }}>
            {dept
              ? `No records in "${dept}" — try All Departments`
              : 'No active employees have attendance records for this period.'}
          </div>
        </div>
      ) : (
        <div style={CARD}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #f0f0f4', background: '#fafafa' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 11 }}>Employee</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 11 }}>Department</th>
                  <ColHeader label="Working Days" col="working_days"    title="Calendar Mon–Fri days in month" />
                  <ColHeader label="Present"      col="present_days" />
                  <ColHeader label="LOP Days"     col="lop_days"        title="Loss of Pay = Working Days − (Present + WFH + Half×0.5)" />
                  <ColHeader label="Absent"       col="absent_days"     title="Explicitly marked Absent" />
                  <ColHeader label="Late Days"    col="late_days" />
                  <ColHeader label="WFH"          col="wfh_days" />
                  <ColHeader label="Half Day"     col="half_days" />
                  <ColHeader label="Late Count"   col="late_arrivals" />
                  <ColHeader label="Late Min"     col="total_late_minutes" />
                  <ColHeader label="Hours"        col="total_hours" />
                  <ColHeader label="OT Hours"     col="total_ot_hours" />
                  <ColHeader label="Att %"        col="attendance_pct"  title="Effective attendance percentage" />
                  <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 11 }}>Payroll</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const lopVal = parseFloat(r.lop_days || 0);
                  const attPct = parseInt(r.attendance_pct || 0);
                  return (
                    <tr
                      key={r.employee_id || i}
                      style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}
                    >
                      <td style={{ padding: '10px 10px' }}>
                        <div style={{ fontWeight: 500, color: '#111827' }}>{r.employee_name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.designation}</div>
                      </td>
                      <td style={{ padding: '10px 10px', color: '#6b7280', fontSize: 12 }}>{r.department}</td>
                      <td style={{ padding: '10px 10px', color: '#374151', fontWeight: 500 }}>{r.working_days}</td>
                      <td style={{ padding: '10px 10px', color: '#10b981', fontWeight: 600 }}>{r.present_days}</td>
                      <td style={{
                        padding: '10px 10px', fontWeight: lopVal > 0 ? 700 : 400,
                        color: lopVal > 2 ? '#ef4444' : lopVal > 0 ? '#f59e0b' : '#10b981',
                      }}>
                        {lopVal > 0 ? lopVal : '—'}
                      </td>
                      <td style={{ padding: '10px 10px', color: parseInt(r.absent_days) > 3 ? '#ef4444' : '#374151', fontWeight: parseInt(r.absent_days) > 3 ? 700 : 400 }}>
                        {r.absent_days}
                      </td>
                      <td style={{ padding: '10px 10px', color: '#f59e0b' }}>{r.late_days}</td>
                      <td style={{ padding: '10px 10px', color: '#3b82f6' }}>{r.wfh_days}</td>
                      <td style={{ padding: '10px 10px' }}>{r.half_days}</td>
                      <td style={{ padding: '10px 10px', color: parseInt(r.late_arrivals) >= 3 ? '#ef4444' : '#374151' }}>
                        {r.late_arrivals}
                      </td>
                      <td style={{ padding: '10px 10px', fontSize: 12 }}>{parseInt(r.total_late_minutes || 0)} min</td>
                      <td style={{ padding: '10px 10px', fontWeight: 500 }}>{parseFloat(r.total_hours || 0).toFixed(1)}h</td>
                      <td style={{ padding: '10px 10px', color: P, fontWeight: 600 }}>{parseFloat(r.total_ot_hours || 0).toFixed(1)}h</td>
                      <td style={{ padding: '10px 10px' }}>
                        <span style={{
                          display: 'inline-block', padding: '2px 7px', borderRadius: 99,
                          fontSize: 11, fontWeight: 700,
                          background: attPct >= 90 ? '#dcfce7' : attPct >= 75 ? '#fef3c7' : '#fee2e2',
                          color:      attPct >= 90 ? '#166534' : attPct >= 75 ? '#92400e' : '#991b1b',
                        }}>
                          {attPct}%
                        </span>
                      </td>
                      <td style={{ padding: '10px 10px' }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600,
                          background: r.payroll_synced ? '#dcfce7' : '#f3f4f6',
                          color:      r.payroll_synced ? '#166534' : '#9ca3af',
                        }}>
                          {r.payroll_synced ? 'Synced' : 'Pending'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f5f3ff', borderTop: '2px solid #e9e4ff' }}>
                  <td colSpan={2} style={{ padding: '10px 10px', fontWeight: 700, color: P }}>TOTAL / AVG</td>
                  <td style={{ padding: '10px 10px', fontWeight: 600, color: '#374151' }}>{data?.working_days ?? '—'}</td>
                  <td style={{ padding: '10px 10px', fontWeight: 700, color: '#10b981' }}>{totalPresent}</td>
                  <td style={{ padding: '10px 10px', fontWeight: 700, color: '#ef4444' }}>{totalLOP.toFixed(1)}</td>
                  <td style={{ padding: '10px 10px', fontWeight: 700, color: '#ef4444' }}>
                    {records.reduce((s, r) => s + parseInt(r.absent_days || 0), 0)}
                  </td>
                  <td style={{ padding: '10px 10px', fontWeight: 700, color: '#f59e0b' }}>
                    {records.reduce((s, r) => s + parseInt(r.late_days || 0), 0)}
                  </td>
                  <td style={{ padding: '10px 10px' }}>{records.reduce((s, r) => s + parseInt(r.wfh_days || 0), 0)}</td>
                  <td style={{ padding: '10px 10px' }}>{records.reduce((s, r) => s + parseInt(r.half_days || 0), 0)}</td>
                  <td style={{ padding: '10px 10px', fontWeight: 700, color: '#ef4444' }}>{totalLate}</td>
                  <td style={{ padding: '10px 10px', fontWeight: 700 }}>
                    {records.reduce((s, r) => s + parseInt(r.total_late_minutes || 0), 0)} min
                  </td>
                  <td style={{ padding: '10px 10px', fontWeight: 700 }}>{totalHours.toFixed(1)}h</td>
                  <td style={{ padding: '10px 10px', fontWeight: 700, color: P }}>{totalOT.toFixed(1)}h</td>
                  <td style={{ padding: '10px 10px', fontWeight: 700 }}>
                    {records.length > 0
                      ? Math.round(records.reduce((s, r) => s + parseInt(r.attendance_pct || 0), 0) / records.length)
                      : 0}%
                  </td>
                  <td style={{ padding: '10px 10px', fontWeight: 700 }}>{synced}/{records.length}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}
