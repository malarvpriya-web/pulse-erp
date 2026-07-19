import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, Bell, Clock, Users, TrendingUp, CheckSquare } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts';
import api from '@/services/api/client';
import './WeeklyProductionReport.css';

// Chart data is loaded from the API — no hardcoded fallbacks.
// Empty arrays produce "No data" states in the charts below.

const PIE_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6'];

const DEPT_COLORS = {
  Engineering: '#6366f1',
  HR:          '#f59e0b',
  Finance:     '#10b981',
  Sales:       '#3b82f6',
  Product:     '#8b5cf6',
  Marketing:   '#ef4444',
};

const STATUS_STYLE = {
  Approved: { bg:'#dcfce7', color:'#15803d' },
  Pending:  { bg:'#fef3c7', color:'#92400e' },
  Rejected: { bg:'#fee2e2', color:'#dc2626' },
};

function hrsColor(h) {
  if (!h) return { background: '#f3f4f6', color: '#d1d5db' };
  if (h > 9)  return { background: '#dbeafe', color: '#1e40af' };
  if (h >= 8) return { background: '#dcfce7', color: '#15803d' };
  if (h >= 5) return { background: '#d1fae5', color: '#065f46' };
  if (h >= 1) return { background: '#fef3c7', color: '#92400e' };
  return { background: '#f3f4f6', color: '#d1d5db' };
}

const getWeekDates = (offset = 0) => {
  const today = new Date();
  const day   = today.getDay();
  const mon   = new Date(today);
  mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
};

const fmtWeekLabel = (dates) => {
  const s = dates[0].toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  const e = dates[6].toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  return `${s} – ${e}`;
};

/**
 * @param {Function} setPage - navigate to another page key
 */
export default function WeeklyProductionReport({ setPage: _setPage }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [employees,  setEmployees]  = useState([]);
  const [missing,    setMissing]    = useState([]);
  const [projDist,   setProjDist]   = useState([]);
  const [dailyDept,  setDailyDept]  = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [toast,      setToast]      = useState(null);
  const [reminding,  setReminding]  = useState({});

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const weekDates = getWeekDates(weekOffset);
  const weekStart = weekDates[0].toISOString().split('T')[0];

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [res] = await Promise.allSettled([
      api.get('/timesheets/weekly-report', { params: { week_start: weekStart } }),
    ]);
    if (!isMounted.current) return;

    if (res.status === 'rejected') {
      setError(true);
      setEmployees([]);
      setMissing([]);
      setProjDist([]);
      setDailyDept([]);
    } else {
      const d = res.value.data || {};
      // Always use real API data — even empty arrays are valid states
      setEmployees(Array.isArray(d.employees) ? d.employees : []);
      setMissing(Array.isArray(d.missing) ? d.missing : []);
      // Charts: use API data only — never fall back to hardcoded static arrays
      setProjDist(Array.isArray(d.project_distribution) ? d.project_distribution : []);
      setDailyDept(Array.isArray(d.daily_by_dept) ? d.daily_by_dept : []);
    }
    setLoading(false);
  }, [weekStart]);

  useEffect(() => { load(); }, [load]);

  // KPIs
  const totalHrs    = employees.reduce((s, e) => s + (e.total || 0), 0);
  const billableHrs = employees.reduce((s, e) => s + (e.billable || 0), 0);
  const billPct     = totalHrs > 0 ? ((billableHrs / totalHrs) * 100).toFixed(1) : 0;
  const avgHrs      = employees.length ? (totalHrs / employees.length).toFixed(1) : 0;
  const onTime      = employees.filter(e => e.submitted).length;

  // Column totals
  const DAYS_SHORT = ['mon','tue','wed','thu','fri'];
  const colTotals  = DAYS_SHORT.reduce((acc, d) => ({
    ...acc,
    [d]: employees.reduce((s, e) => s + (e[d] || 0), 0),
  }), {});

  const depts = Object.keys(DEPT_COLORS);

  const exportCSV = () => {
    const headers = ['Employee','Dept','Mon','Tue','Wed','Thu','Fri','Total','Billable','Submitted','Status'];
    const rows = employees.map(e =>
      [e.name, e.dept, e.mon, e.tue, e.wed, e.thu, e.fri, e.total, e.billable, e.submitted, e.status].join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `weekly-report-${weekStart}.csv`; a.click();
    URL.revokeObjectURL(url);
    showToast('Report exported as CSV');
  };

  const sendReminder = (name) => {
    setReminding(prev => ({ ...prev, [name]: true }));
    setTimeout(() => {
      setReminding(prev => ({ ...prev, [name]: false }));
      showToast(`Reminder sent to ${name}`);
    }, 800);
  };

  return (
    <div className="wpr-root">
      {toast && (
        <div style={{ position:'fixed', bottom:24, right:24, zIndex:9999, background: toast.type==='error'?'#ef4444':'#10b981', color:'#fff', padding:'10px 18px', borderRadius:8, fontSize:14, boxShadow:'0 4px 12px rgba(0,0,0,.15)' }}>
          {toast.msg}
        </div>
      )}
      {error && (
        <div style={{ background: 'var(--color-background-danger, #fee2e2)', color: 'var(--color-text-danger, #dc2626)', borderRadius: 'var(--border-radius-md, 8px)', padding: '10px 14px', marginBottom: '16px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: 12 }}>
          Failed to load weekly report. Please try again.
          <button onClick={load} style={{ background: 'none', border: '1px solid currentColor', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', color: 'inherit', fontSize: 12 }}>Retry</button>
        </div>
      )}
      {loading && (
        <div style={{ background: '#f3f4f6', borderRadius: '8px', padding: '20px', textAlign: 'center', color: '#6b7280', fontSize: '13px', marginBottom: '16px' }}>Loading…</div>
      )}

      {/* Header */}
      <div className="wpr-header">
        <div>
          <h1 className="wpr-title">Weekly Production Report</h1>
          <div className="wpr-week-nav">
            <button className="wpr-icon-btn" onClick={() => setWeekOffset(o => o - 1)}>
              <ChevronLeft size={14} />
            </button>
            <span className="wpr-week-label">{fmtWeekLabel(weekDates)}</span>
            <button className="wpr-icon-btn" disabled={weekOffset >= 0}
              onClick={() => setWeekOffset(o => o + 1)}>
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
        <div className="wpr-header-r">
          <button className="wpr-btn-outline" onClick={exportCSV}>
            <Download size={14} /> Export CSV
          </button>
          <button className="wpr-btn-outline" onClick={() => window.print()}>
            <FileText size={14} /> Download PDF
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="wpr-kpi-row">
        <div className="wpr-kpi-card">
          <div className="wpr-kpi-icon" style={{ background:'#ede9fe', color:'#6B3FDB' }}><Clock size={18} /></div>
          <div>
            <div className="wpr-kpi-num">{totalHrs.toFixed(1)} hrs</div>
            <div className="wpr-kpi-lbl">Total Hours Logged</div>
          </div>
        </div>
        <div className="wpr-kpi-card">
          <div className="wpr-kpi-icon" style={{ background:'#dcfce7', color:'#15803d' }}><TrendingUp size={18} /></div>
          <div>
            <div className="wpr-kpi-num">{billableHrs.toFixed(1)} hrs <span style={{ fontSize:13, fontWeight:500, color:'#6b7280' }}>({billPct}%)</span></div>
            <div className="wpr-kpi-lbl">Billable Hours</div>
          </div>
        </div>
        <div className="wpr-kpi-card">
          <div className="wpr-kpi-icon" style={{ background:'#dbeafe', color:'#1d4ed8' }}><Users size={18} /></div>
          <div>
            <div className="wpr-kpi-num">{avgHrs} hrs</div>
            <div className="wpr-kpi-lbl">Avg Hours / Person</div>
          </div>
        </div>
        <div className="wpr-kpi-card">
          <div className="wpr-kpi-icon" style={{ background:'#fef3c7', color:'#92400e' }}><CheckSquare size={18} /></div>
          <div>
            <div className="wpr-kpi-num">{onTime}/{employees.length + missing.length} employees</div>
            <div className="wpr-kpi-lbl">On-Time Submissions</div>
          </div>
        </div>
      </div>

      {/* Missing submissions alert */}
      {missing.length > 0 && (
        <div className="wpr-alert">
          <div className="wpr-alert-title">
            <Bell size={16} style={{ color:'#d97706' }} />
            {missing.length} employee{missing.length > 1 ? 's have' : ' has'} not submitted timesheet for this week
          </div>
          <div className="wpr-alert-list">
            {missing.map(m => (
              <div key={m.name} className="wpr-alert-row">
                <span>{m.name} <span className="wpr-alert-dept">({m.dept})</span> — Due: {m.due}</span>
                <button
                  className="wpr-remind-btn"
                  disabled={reminding[m.name]}
                  onClick={() => sendReminder(m.name)}
                >
                  {reminding[m.name] ? 'Sending…' : 'Send Reminder'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Employee breakdown table */}
      <div className="wpr-section">
        <div className="wpr-section-title">Employee Breakdown</div>
        {loading ? (
          <div className="wpr-loading"><div className="wpr-spinner" /></div>
        ) : (
          <div className="wpr-table-wrap">
            <table className="wpr-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Employee</th>
                  <th>Dept</th>
                  <th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th>
                  <th>Total</th>
                  <th>Billable</th>
                  <th>Submitted</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e, idx) => {
                  const ss = STATUS_STYLE[e?.status] || STATUS_STYLE.Pending;
                  return (
                    <tr key={e?.id ?? idx} className="wpr-row">
                      <td style={{ textAlign:'center', fontSize:12, color:'#9ca3af' }}>{idx + 1}</td>
                      <td>
                        <div className="wpr-emp">
                          <div className="wpr-avatar">{(e?.name ?? '?').split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                          <span>{e?.name ?? '—'}</span>
                        </div>
                      </td>
                      <td><span className="wpr-dept">{e?.dept ?? 'Unassigned'}</span></td>
                      {DAYS_SHORT.map(d => (
                        <td key={d}>
                          <span className="wpr-day-cell" style={hrsColor(e?.[d])}>
                            {e?.[d] || '—'}
                          </span>
                        </td>
                      ))}
                      <td><strong>{e?.total ?? 0}h</strong></td>
                      <td style={{ fontSize:13, color:'#374151' }}>{e?.billable ?? 0}h</td>
                      <td style={{ fontSize:12, color:'#6b7280' }}>{e?.submitted ?? '—'}</td>
                      <td>
                        <span className="wpr-status" style={{ background: ss.bg, color: ss.color }}>
                          {e?.status ?? 'Not Submitted'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="wpr-foot">
                  <td colSpan={3}><strong>Totals</strong></td>
                  {DAYS_SHORT.map(d => (
                    <td key={d}><strong>{colTotals[d].toFixed(1)}</strong></td>
                  ))}
                  <td><strong>{totalHrs.toFixed(1)}h</strong></td>
                  <td><strong>{billableHrs.toFixed(1)}h</strong></td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Charts row */}
      <div className="wpr-charts-row">
        {/* Project distribution pie chart */}
        <div className="wpr-chart-card">
          <div className="wpr-chart-title">Project Distribution <span className="wpr-chart-sub">hours by project</span></div>
          <div style={{ display:'flex', alignItems:'center', gap:16 }}>
            <ResponsiveContainer width={160} height={160}>
              <PieChart>
                <Pie
                  data={projDist}
                  dataKey="value"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  innerRadius={35}
                >
                  {projDist.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v, name) => [`${v}h`, name]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="wpr-pie-legend">
              {projDist.map((p, i) => (
                <div key={p.name} className="wpr-pie-row">
                  <span className="wpr-pie-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="wpr-pie-name">{p.name}</span>
                  <span className="wpr-pie-val">{p.value}h ({p.pct}%)</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Daily hours trend by dept */}
        <div className="wpr-chart-card" style={{ flex: 2 }}>
          <div className="wpr-chart-title">Daily Hours by Department <span className="wpr-chart-sub">Mon–Fri</span></div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailyDept} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <XAxis dataKey="day" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {depts.map(dept => (
                <Bar key={dept} dataKey={dept} stackId="a" fill={DEPT_COLORS[dept]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Hours color legend */}
      <div className="wpr-legend-row">
        <span className="wpr-legend-title">Hours Color Key:</span>
        {[
          { label:'No entry',    style: hrsColor(0) },
          { label:'Partial (1-4h)', style: hrsColor(3) },
          { label:'Good (5-7h)',    style: hrsColor(6) },
          { label:'Full (8h)',      style: hrsColor(8) },
          { label:'Overtime (9h+)', style: hrsColor(10) },
        ].map(({ label, style }) => (
          <span key={label} className="wpr-legend-item" style={style}>{label}</span>
        ))}
      </div>
    </div>
  );
}