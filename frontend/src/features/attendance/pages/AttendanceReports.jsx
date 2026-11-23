import { useState, useCallback, useEffect, useRef } from 'react';
import {
  FileText, Download, BarChart2, Users, Clock, AlertTriangle, Zap,
  Calendar, RefreshCw, Printer, CheckCircle, AlertCircle, TrendingUp,
  GitCompare, LogOut, BarChart3,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, Stat } from '@/components/pulse-ui';

const P    = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };
const MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// §278: only the reports no other Reports tab has. Absenteeism, late
// arrivals, overtime, department-wise and shift efficiency were repeats of the
// Analytics / Late Arrivals tabs one click away, on the same endpoints.
const REPORT_TYPES = [
  { id: 'leave_reconciliation', label: 'Leave Reconciliation', icon: GitCompare, color: '#dc2626', desc: 'Absences without leave approval + approved leave ignored' },
  { id: 'early_exit',           label: 'Early Exit Report',    icon: LogOut,     color: '#6d28d9', desc: 'Employees who left before shift end time' },
];

// ── Shared micro-components ───────────────────────────────────────────────────

function KpiCard({ label, value, color }) {
  // Delegates to the design-system card so this page's KPIs match every other
  // page's. Signature unchanged, so no call site needed editing.
  return <Stat label={label} value={value} color={color} />;
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
  const [reportType, setReportType] = useState('leave_reconciliation');
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

  // Toast
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

  // Payroll sync lives on Attendance → Payroll Sync only (§278).

  // ── CSV export ──────────────────────────────────────────────────────────────

  const exportCSV = () => {
    if (!data) return;
    let headers = [], rows = [];

    if (data.type === 'leave_reconciliation') {
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

    if (data.type === 'leave_reconciliation') {
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
    table += `<tr><th colspan="${headers.length}" style="background:#6B3FDB;color:white;padding:8px">${title}</th></tr>`;
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

  const renderLeaveReconciliation = () => {
    const conflicts = data.conflicts || [];
    if (!conflicts.length) return <EmptyState msg="No leave vs attendance conflicts found for this period." />;

    const CONFLICT_META = {
      absent_no_leave:       { label: 'Absent — No Leave',        bg: '#fef2f2', color: '#dc2626' },
      present_despite_leave: { label: 'Present — Leave Approved', bg: '#f5f3ff', color: '#6d28d9' },
    };

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
          <KpiCard label="Total Conflicts"          value={data.total_conflicts}         color="#dc2626" />
          <KpiCard label="Absent Without Leave"     value={data.absent_no_leave}         color="#ef4444" />
          <KpiCard label="Present Despite Leave"    value={data.present_despite_leave}   color="#7c5cf0" />
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
          <KpiCard label="Total Incidents"      value={data.total_incidents}    color="#6d28d9" />
          <KpiCard label="Employees Affected"   value={data.employees_affected} color="#7c5cf0" />
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
                    <span style={{ background: emp.exit_count >= 5 ? '#fef2f2' : '#f5f3ff', color: emp.exit_count >= 5 ? '#dc2626' : '#6d28d9', borderRadius: 8, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
                      {emp.exit_count}
                    </span>
                  </td>
                  <td style={{ padding: '9px 11px', fontWeight: 600, color: '#6d28d9', fontVariantNumeric: 'tabular-nums' }}>
                    {emp.total_early_minutes}m
                  </td>
                  <td style={{ padding: '9px 11px', color: '#ef4444', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {emp.max_early_minutes}m early
                  </td>
                  <td style={{ padding: '9px 11px', fontSize: 11, color: '#6b7280' }}>
                    {(emp.dates || []).slice(0, 3).map(d => (
                      <span key={d.date} style={{ display: 'inline-block', background: '#fff7ed', border: '1px solid #ddd6fe', borderRadius: 6, padding: '1px 6px', marginRight: 4, marginBottom: 2, whiteSpace: 'nowrap' }}>
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
      case 'leave_reconciliation': return renderLeaveReconciliation();
      case 'early_exit':           return renderEarlyExit();
      default:                     return <EmptyState msg="Unknown report type" />;
    }
  };

  const sel = REPORT_TYPES.find(r => r.id === reportType);

  // ── JSX ──────────────────────────────────────────────────────────────────────

  return (
    <PageShell dock={
      <PageHero
        icon={BarChart3}
        eyebrow="Attendance"
        title="Attendance Reports"
        subtitle="Generate, compare, and export attendance reports"
        actions={data && (
          <div style={{ display: 'flex', gap: 8 }} className="no-print">
            <button className="plh-cta" onClick={exportCSV}>
              <Download size={13} /> Export CSV
            </button>
            <button className="plh-cta" onClick={exportToExcel}>
              <Download size={13} /> Export Excel
            </button>
            <button className="plh-cta" onClick={exportPDF}>
              <Printer size={13} /> Print / PDF
            </button>
          </div>
        )}
      />
    }>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, padding: '12px 18px', borderRadius: 10, background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`, color: toast.type === 'error' ? '#991b1b' : '#166534', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,.1)' }}>
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle size={15} />} {toast.msg}
        </div>
      )}

      {/* Page header */}


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
    </PageShell>
  );
}
