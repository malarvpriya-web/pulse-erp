import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, BarChart2, Clock, Zap, Building,
  AlertTriangle, Download, ChevronDown, Star, Award,
} from 'lucide-react';
import api from '@/services/api/client';

const P    = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const STATUS_COLORS = {
  present:  '#10b981',
  absent:   '#ef4444',
  late:     '#f59e0b',
  wfh:      '#3b82f6',
  half_day: '#f97316',
  holiday:  '#8b5cf6',
  leave:    '#6366f1',
};

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Utilities ─────────────────────────────────────────────────────────────────

function exportCSV(filename, headers, rows) {
  const csv = [
    headers.join(','),
    ...rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')),
  ].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function fmtINR(n) {
  if (!n || Number(n) === 0) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ── Shared components ──────────────────────────────────────────────────────────

function DeltaBadge({ delta, invertGood = false }) {
  if (delta === null || delta === undefined || isNaN(delta)) return null;
  const abs   = Math.abs(delta).toFixed(1);
  const isUp  = delta >  0.1;
  const isDn  = delta < -0.1;
  // invertGood=false → UP is bad (absenteeism); invertGood=true → UP is good (attendance rate)
  const isGood = invertGood ? isUp : isDn;
  const isNeutral = !isUp && !isDn;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 99, marginLeft: 6,
      background: isNeutral ? '#f9fafb' : isGood ? '#f0fdf4' : '#fef2f2',
      color:      isNeutral ? '#9ca3af' : isGood ? '#10b981' : '#ef4444',
    }}>
      {isUp ? '↑' : isDn ? '↓' : '→'}{abs}%
    </span>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={{ textAlign: 'center', padding: 60 }}>
      <AlertTriangle size={36} style={{ color: '#f59e0b', marginBottom: 12 }} />
      <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>Failed to load data</div>
      <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 20 }}>{message}</div>
      <button
        onClick={onRetry}
        style={{ padding: '8px 20px', borderRadius: 8, border: `1px solid ${P}`, background: '#fff', color: P, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
      >
        Retry
      </button>
    </div>
  );
}

function Sparkline({ data, color }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const w = 120, h = 40;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`);
  return (
    <svg width={w} height={h} style={{ overflow: 'visible' }}>
      <polyline points={pts.join(' ')} fill="none" stroke={color || P} strokeWidth={2} />
      {data.map((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - (v / max) * h;
        return <circle key={i} cx={x} cy={y} r={3} fill={color || P} />;
      })}
    </svg>
  );
}

function PredictiveInsight({ data }) {
  if (!data || data.length < 4) return null;
  const rates = [...data].slice(0, 6).reverse().map(r => parseFloat(r.absenteeism_rate || 0));
  const n = rates.length;
  const sumX  = rates.reduce((a, _, i) => a + i, 0);
  const sumY  = rates.reduce((a, b) => a + b, 0);
  const sumXY = rates.reduce((a, r, i) => a + i * r, 0);
  const sumX2 = rates.reduce((a, _, i) => a + i * i, 0);
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const projected = Math.max(0, rates[n - 1] + slope).toFixed(1);
  const recent3 = rates.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, n);
  const prev3s  = rates.slice(0, n - 3);
  const prev3   = prev3s.length > 0 ? prev3s.reduce((a, b) => a + b, 0) / prev3s.length : recent3;
  const delta   = recent3 - prev3;
  const isRising  = delta >  0.5;
  const isFalling = delta < -0.5;
  const trendColor = isRising ? '#ef4444' : isFalling ? '#10b981' : '#6b7280';
  const trendWord  = isRising ? 'rising' : isFalling ? 'falling' : 'stable';

  return (
    <div style={{ ...CARD, background: 'linear-gradient(135deg,#faf5ff 0%,#ede9fe 100%)', borderColor: '#ddd6fe', marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Zap size={15} color={P} />
        <span style={{ fontWeight: 700, color: '#6d28d9', fontSize: 13 }}>AI Trend Insight</span>
        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>based on {n}-month linear trend</span>
      </div>
      <p style={{ fontSize: 13, color: '#374151', margin: 0, lineHeight: 1.7 }}>
        Absenteeism is{' '}
        <strong style={{ color: trendColor }}>{trendWord}</strong>
        {' '}({Math.abs(delta).toFixed(1)}% vs previous quarter).{' '}
        Projected next month: <strong style={{ color: trendColor }}>{projected}%</strong>.
        {isRising && '  Consider reviewing attendance policies and employee wellness programs.'}
        {isFalling && '  Keep up the current attendance management practices.'}
      </p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AttendanceAnalytics() {
  const [tab, setTab]                     = useState('heatmap');
  const [month, setMonth]                 = useState(new Date().getMonth() + 1);
  const [year, setYear]                   = useState(new Date().getFullYear());
  const [dept, setDept]                   = useState('');
  const [deptOpen, setDeptOpen]           = useState(false);
  const [departments, setDepartments]     = useState([]);

  // Per-tab data
  const [heatmapData, setHeatmapData]     = useState(null);
  const [absenteeism, setAbsenteeism]     = useState([]);
  const [topAbsentees, setTopAbsentees]   = useState([]);
  const [perfectAtt, setPerfectAtt]       = useState([]);
  const [deptBreakdown, setDeptBreakdown] = useState([]);
  const [otCost, setOtCost]               = useState([]);
  const [shiftEff, setShiftEff]           = useState([]);

  const [loading, setLoading]             = useState(false);
  const [errors, setErrors]               = useState({});

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  // Load department list once on mount
  useEffect(() => {
    api.get('/attendance/analytics/departments')
      .then(r => { if (isMounted.current) setDepartments(r.data || []); })
      .catch(() => {});
  }, []);

  // Close dept dropdown on outside click
  useEffect(() => {
    if (!deptOpen) return;
    const close = (e) => { setDeptOpen(false); };
    const timer = setTimeout(() => window.addEventListener('click', close), 0);
    return () => { clearTimeout(timer); window.removeEventListener('click', close); };
  }, [deptOpen]);

  // Lazy load — only fetch the active tab on mount/filter/tab change
  const load = useCallback(async () => {
    if (!isMounted.current) return;
    setLoading(true);
    setErrors(prev => ({ ...prev, [tab]: null }));
    const params = `?month=${month}&year=${year}${dept ? `&department=${encodeURIComponent(dept)}` : ''}`;
    try {
      if (tab === 'heatmap') {
        const r = await api.get(`/attendance/analytics/heatmap${params}`);
        if (isMounted.current) setHeatmapData(r.data);

      } else if (tab === 'absenteeism') {
        const [abRes, topRes, perfRes] = await Promise.allSettled([
          api.get('/attendance/analytics/absenteeism'),
          api.get(`/attendance/analytics/top-absentees${params}`),
          api.get(`/attendance/analytics/perfect-attendance${params}`),
        ]);
        if (!isMounted.current) return;
        if (abRes.status   === 'fulfilled') setAbsenteeism(abRes.value.data   || []);
        else setErrors(prev => ({ ...prev, absenteeism: abRes.reason?.response?.data?.error || abRes.reason?.message }));
        if (topRes.status  === 'fulfilled') setTopAbsentees(topRes.value.data  || []);
        if (perfRes.status === 'fulfilled') setPerfectAtt(perfRes.value.data   || []);

      } else if (tab === 'department') {
        const r = await api.get(`/attendance/analytics/department-absenteeism${params}`);
        if (isMounted.current) setDeptBreakdown(r.data || []);

      } else if (tab === 'overtime') {
        const r = await api.get(`/attendance/analytics/overtime-cost${params}`);
        if (isMounted.current) setOtCost(r.data || []);

      } else if (tab === 'shift') {
        const r = await api.get(`/attendance/analytics/shift-efficiency${params}`);
        if (isMounted.current) setShiftEff(r.data || []);
      }
    } catch (e) {
      if (isMounted.current) {
        setErrors(prev => ({
          ...prev,
          [tab]: e?.response?.data?.error || e.message || 'Failed to load',
        }));
      }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [tab, month, year, dept]);

  useEffect(() => { load(); }, [load]);

  // ── CSV exports ──────────────────────────────────────────────────────────────
  const handleExport = () => {
    if (tab === 'heatmap' && heatmapData?.employees?.length) {
      const days = new Date(year, month, 0).getDate();
      exportCSV(
        `heatmap-${MONTH_NAMES[month - 1]}-${year}.csv`,
        ['Employee', 'Department', ...Array.from({ length: days }, (_, i) => `Day ${i + 1}`), 'Att%'],
        heatmapData.employees.map(emp => {
          const map = {};
          (emp.records || []).forEach(r => { map[String(r.date).slice(8, 10)] = r.status; });
          const pct = Math.round(Object.values(map).filter(s => s === 'present' || s === 'late').length / days * 100);
          return [emp.employee_name, emp.department, ...Array.from({ length: days }, (_, i) => map[String(i + 1).padStart(2, '0')] || ''), `${pct}%`];
        })
      );
    } else if (tab === 'absenteeism' && absenteeism.length) {
      exportCSV(
        `absenteeism-12m.csv`,
        ['Month', 'Year', 'Total Records', 'Absent', 'Present', 'Late', 'Unique Employees', 'Absenteeism%'],
        absenteeism.map(r => [MONTH_NAMES[parseInt(r.month) - 1], r.year, r.total_records, r.absent_count, r.present_count, r.late_count, r.unique_employees, parseFloat(r.absenteeism_rate || 0).toFixed(1)])
      );
    } else if (tab === 'department' && deptBreakdown.length) {
      exportCSV(
        `dept-breakdown-${MONTH_NAMES[month - 1]}-${year}.csv`,
        ['Department', 'Employees', 'Present Days', 'Absent Days', 'Late Days', 'Total Hours', 'Absenteeism%', 'Prev Month%', 'Delta'],
        deptBreakdown.map(d => {
          const delta = d.prev_rate != null ? (parseFloat(d.absenteeism_rate || 0) - parseFloat(d.prev_rate)).toFixed(1) : '';
          return [d.department, d.total_employees, d.present_days, d.absent_days, d.late_days, parseFloat(d.total_hours || 0).toFixed(0), parseFloat(d.absenteeism_rate || 0).toFixed(1), d.prev_rate != null ? parseFloat(d.prev_rate).toFixed(1) : '', delta];
        })
      );
    } else if (tab === 'overtime' && otCost.length) {
      exportCSV(
        `overtime-${MONTH_NAMES[month - 1]}-${year}.csv`,
        ['Department', 'Employees w/ OT', 'Total OT Hrs', 'Approved', 'Pending', 'Rejected', 'Avg Mult.', 'Approved Cost (₹)', 'Total Cost (₹)'],
        otCost.map(d => [d.department, d.employees_with_ot, parseFloat(d.total_ot_hours || 0).toFixed(1), d.approved_ot, d.pending_ot, d.rejected_ot, parseFloat(d.avg_multiplier || 1.5).toFixed(2), d.approved_ot_cost || 0, d.total_ot_cost || 0])
      );
    }
  };

  // ── Absenteeism derived values ────────────────────────────────────────────────
  const absValues   = [...absenteeism].reverse().map(r => parseFloat(r.absenteeism_rate || 0));
  const maxAbsRate  = Math.max(...absenteeism.map(r => parseFloat(r.absenteeism_rate || 0)), 1);
  const getAbsDelta = (i) => {
    if (i >= absenteeism.length - 1) return null;
    return parseFloat(absenteeism[i].absenteeism_rate || 0) - parseFloat(absenteeism[i + 1].absenteeism_rate || 0);
  };
  const avgAbsRate = absenteeism.length > 0
    ? (absenteeism.reduce((s, r) => s + parseFloat(r.absenteeism_rate || 0), 0) / absenteeism.length).toFixed(1) + '%'
    : '—';
  const avgLateRate = absenteeism.length > 0
    ? (absenteeism.reduce((s, r) => s + (parseInt(r.late_count || 0) / Math.max(parseInt(r.total_records || 1), 1) * 100), 0) / absenteeism.length).toFixed(1) + '%'
    : '—';
  const peakEmployees = absenteeism.length > 0
    ? Math.max(...absenteeism.map(r => parseInt(r.unique_employees || 0)))
    : 0;

  const tabs = [
    { id: 'heatmap',     label: 'Attendance Heatmap' },
    { id: 'absenteeism', label: 'Absenteeism Trends' },
    { id: 'department',  label: 'Dept. Breakdown' },
    { id: 'overtime',    label: 'Overtime Summary' },
    { id: 'shift',       label: 'Shift Efficiency' },
  ];

  const hasExport = ['heatmap','absenteeism','department','overtime'].includes(tab);
  const cy = new Date().getFullYear();
  const yearOptions = [cy - 2, cy - 1, cy, cy + 1];

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 24, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>Attendance Analytics</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            Heatmaps · absenteeism trends · OT cost · shift efficiency — all live from DB
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Month */}
          <select value={month} onChange={e => setMonth(parseInt(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}>
            {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>

          {/* Year */}
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}>
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>

          {/* Department dropdown */}
          <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setDeptOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 12px', borderRadius: 8,
                border: `1px solid ${dept ? P : '#e5e7eb'}`,
                background: dept ? '#f5f3ff' : '#fff',
                cursor: 'pointer', fontSize: 13,
                color: dept ? P : '#374151', minWidth: 155,
              }}>
              <Building size={13} />
              <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dept || 'All Departments'}
              </span>
              <ChevronDown size={13} style={{ transform: deptOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
            </button>
            {deptOpen && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: '100%', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', zIndex: 200, maxHeight: 220, overflowY: 'auto' }}>
                {[{ label: 'All Departments', value: '' }, ...departments.map(d => ({ label: d, value: d }))].map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => { setDept(opt.value); setDeptOpen(false); }}
                    style={{
                      padding: '8px 14px', fontSize: 13, cursor: 'pointer',
                      color: dept === opt.value ? P : '#374151',
                      fontWeight: dept === opt.value ? 600 : 400,
                      background: dept === opt.value ? '#f5f3ff' : 'transparent',
                    }}>
                    {opt.label}
                  </div>
                ))}
                {departments.length === 0 && (
                  <div style={{ padding: '8px 14px', fontSize: 12, color: '#9ca3af' }}>No departments found</div>
                )}
              </div>
            )}
          </div>

          {/* Export CSV */}
          {hasExport && (
            <button onClick={handleExport}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>
              <Download size={13} /> Export CSV
            </button>
          )}

          {/* Refresh */}
          <button onClick={load}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}} /> Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid #f0f0f4' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 18px', border: 'none', cursor: 'pointer', background: 'transparent',
            fontSize: 14, fontWeight: 500, marginBottom: -1,
            color: tab === t.id ? P : '#6b7280',
            borderBottom: tab === t.id ? `2px solid ${P}` : '2px solid transparent',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading spinner */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 80, color: '#9ca3af' }}>
          <RefreshCw size={28} style={{ animation: 'spin 1s linear infinite', marginBottom: 12 }} />
          <div style={{ fontSize: 14 }}>Loading analytics…</div>
        </div>
      )}

      {!loading && (
        <>
          {/* ════════════ TAB: Attendance Heatmap ════════════ */}
          {tab === 'heatmap' && (
            errors.heatmap
              ? <ErrorState message={errors.heatmap} onRetry={load} />
              : (
                <div style={CARD}>
                  <div style={{ fontWeight: 600, color: '#111827', marginBottom: 16, fontSize: 16 }}>
                    Employee Attendance Heatmap — {MONTH_NAMES[month - 1]} {year}
                  </div>

                  {!heatmapData || !heatmapData.employees?.length ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 60 }}>
                      <BarChart2 size={36} style={{ marginBottom: 10, opacity: 0.25 }} />
                      <div>No employees found for this period</div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>Try a different month, year, or department filter</div>
                    </div>
                  ) : (
                    <>
                      {/* Legend */}
                      <div style={{ display: 'flex', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
                        {Object.entries(STATUS_COLORS).map(([s, c]) => (
                          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#6b7280' }}>
                            <div style={{ width: 12, height: 12, borderRadius: 2, background: c }} />
                            {s.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                          </div>
                        ))}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#6b7280' }}>
                          <div style={{ width: 12, height: 12, borderRadius: 2, background: '#f3f4f6' }} /> No record
                        </div>
                      </div>

                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr>
                              <th style={{ padding: '4px 8px', textAlign: 'left', color: '#6b7280', fontWeight: 500, minWidth: 160 }}>Employee</th>
                              <th style={{ padding: '4px 6px', color: '#6b7280', fontWeight: 500, textAlign: 'left', minWidth: 70 }}>Dept</th>
                              {Array.from({ length: new Date(year, month, 0).getDate() }, (_, i) => (
                                <th key={i} style={{ padding: '4px 2px', color: '#9ca3af', fontWeight: 400, textAlign: 'center', minWidth: 16 }}>{i + 1}</th>
                              ))}
                              <th style={{ padding: '4px 8px', color: '#6b7280', fontWeight: 500, textAlign: 'center' }}>Att%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(heatmapData.employees || []).slice(0, 50).map(emp => {
                              const map = {};
                              (emp.records || []).forEach(r => {
                                const d = r.date instanceof Object ? r.date : String(r.date);
                                map[d.slice(8, 10)] = r.status;
                              });
                              const daysInMonth = new Date(year, month, 0).getDate();
                              const presentCount = Object.values(map).filter(s => s === 'present' || s === 'late').length;
                              const pct = Math.round((presentCount / daysInMonth) * 100);
                              return (
                                <tr key={emp.employee_id} style={{ borderBottom: '1px solid #f9fafb' }}>
                                  <td style={{ padding: '4px 8px', fontWeight: 500, color: '#111827', whiteSpace: 'nowrap' }}>{emp.employee_name}</td>
                                  <td style={{ padding: '4px 6px', color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap', maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis' }}>{(emp.department || '').slice(0, 10)}</td>
                                  {Array.from({ length: daysInMonth }, (_, i) => {
                                    const day    = String(i + 1).padStart(2, '0');
                                    const status = map[day];
                                    const dow    = new Date(year, month - 1, i + 1).getDay();
                                    const isWE   = dow === 0 || dow === 6;
                                    return (
                                      <td key={i} style={{ padding: '2px' }}>
                                        <div
                                          title={`${emp.employee_name} · Day ${i + 1}: ${status || (isWE ? 'weekend' : 'no record')}`}
                                          style={{
                                            width: 14, height: 14, borderRadius: 3,
                                            background: status
                                              ? (STATUS_COLORS[status] || '#6b7280')
                                              : isWE ? '#f9fafb' : '#f3f4f6',
                                          }}
                                        />
                                      </td>
                                    );
                                  })}
                                  <td style={{ padding: '4px 8px', textAlign: 'center', fontWeight: 700, color: pct >= 90 ? '#10b981' : pct >= 70 ? '#f59e0b' : '#ef4444' }}>{pct}%</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {(heatmapData.employees || []).length > 50 && (
                        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
                          Showing top 50 of {heatmapData.employees.length} employees. Use the department filter to narrow results.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
          )}

          {/* ════════════ TAB: Absenteeism Trends ════════════ */}
          {tab === 'absenteeism' && (
            errors.absenteeism
              ? <ErrorState message={errors.absenteeism} onRetry={load} />
              : (
                <div>
                  {/* Row 1: Trend bars + stats sidebar */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, marginBottom: 20 }}>
                    <div style={CARD}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
                        <div style={{ fontWeight: 600, color: '#111827' }}>Monthly Absenteeism Rate</div>
                        <span style={{ fontSize: 11, color: '#9ca3af', background: '#f9fafb', padding: '2px 8px', borderRadius: 99 }}>
                          Rolling 12 months · not filtered by selected month
                        </span>
                      </div>
                      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 18 }}>
                        % of total records marked absent
                      </div>

                      {absenteeism.length === 0 ? (
                        <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>
                          No attendance records found in the past 12 months
                        </div>
                      ) : (
                        absenteeism.slice(0, 12).map((r, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f9fafb' }}>
                            <div style={{ width: 62, fontSize: 12, color: '#6b7280', flexShrink: 0 }}>
                              {MONTH_NAMES[parseInt(r.month) - 1]} {r.year}
                            </div>
                            <div style={{ flex: 1, height: 20, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                              <div style={{
                                height: '100%',
                                width: `${Math.min(parseFloat(r.absenteeism_rate || 0) / maxAbsRate * 100, 100)}%`,
                                background: parseFloat(r.absenteeism_rate) > 20 ? '#ef4444' : parseFloat(r.absenteeism_rate) > 10 ? '#f59e0b' : '#10b981',
                                borderRadius: 4, transition: 'width 0.3s',
                              }} />
                            </div>
                            <div style={{ width: 46, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
                              {parseFloat(r.absenteeism_rate || 0).toFixed(1)}%
                            </div>
                            <div style={{ width: 72, fontSize: 11, color: '#9ca3af' }}>
                              {r.absent_count}/{r.total_records}
                            </div>
                            <div style={{ width: 56, flexShrink: 0 }}>
                              <DeltaBadge delta={getAbsDelta(i)} />
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div style={CARD}>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>12-Month Sparkline</div>
                        <Sparkline data={absValues} color="#ef4444" />
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>Absenteeism %</div>
                      </div>
                      <div style={CARD}>
                        <div style={{ fontWeight: 600, color: '#111827', marginBottom: 12, fontSize: 14 }}>Summary</div>
                        {[
                          { label: 'Avg. absenteeism', value: avgAbsRate, color: '#ef4444' },
                          { label: 'Avg. late rate',   value: avgLateRate, color: '#f59e0b' },
                          { label: 'Peak employees',   value: peakEmployees || '—', color: P },
                        ].map(s => (
                          <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f9fafb', fontSize: 13 }}>
                            <span style={{ color: '#6b7280' }}>{s.label}</span>
                            <span style={{ fontWeight: 700, color: s.color }}>{s.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Predictive insight */}
                  <PredictiveInsight data={absenteeism} />

                  {/* Row 2: Top Absentees + Perfect Attendance */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}>
                    {/* Top Absentees */}
                    <div style={CARD}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                        <AlertTriangle size={15} color="#ef4444" />
                        <span style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>
                          Top Absentees
                        </span>
                        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                          {MONTH_NAMES[month - 1]} {year}
                        </span>
                      </div>
                      {topAbsentees.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 30 }}>
                          <Star size={28} color="#10b981" style={{ marginBottom: 8 }} />
                          <div style={{ color: '#10b981', fontWeight: 600, fontSize: 13 }}>No absences this month</div>
                        </div>
                      ) : (
                        topAbsentees.slice(0, 10).map((e, i) => (
                          <div key={e.employee_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f9fafb' }}>
                            <div style={{
                              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                              background: i < 3 ? '#fef2f2' : '#f9fafb',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 11, fontWeight: 700, color: i < 3 ? '#ef4444' : '#9ca3af',
                            }}>
                              {i + 1}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 500, color: '#111827', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.employee_name}</div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>{e.department}</div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ fontWeight: 700, color: '#ef4444', fontSize: 13 }}>{e.absent_days}d absent</div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>{parseFloat(e.absenteeism_rate || 0).toFixed(0)}% rate</div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Perfect Attendance */}
                    <div style={CARD}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                        <Award size={15} color="#f59e0b" />
                        <span style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>
                          Perfect Attendance
                        </span>
                        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                          {MONTH_NAMES[month - 1]} {year}
                        </span>
                      </div>
                      {perfectAtt.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af', fontSize: 13 }}>
                          No employees with perfect attendance yet
                        </div>
                      ) : (
                        <>
                          {perfectAtt.slice(0, 10).map((e, i) => (
                            <div key={e.employee_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f9fafb' }}>
                              <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#fef9c3', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Star size={11} color="#f59e0b" fill="#f59e0b" />
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 500, color: '#111827', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.employee_name}</div>
                                <div style={{ fontSize: 11, color: '#9ca3af' }}>{e.department}</div>
                              </div>
                              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                <div style={{ fontWeight: 700, color: '#10b981', fontSize: 13 }}>{e.days_tracked}d tracked</div>
                                {parseInt(e.late_days) > 0 && (
                                  <div style={{ fontSize: 11, color: '#f59e0b' }}>{e.late_days}d late</div>
                                )}
                              </div>
                            </div>
                          ))}
                          {perfectAtt.length > 10 && (
                            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 10, textAlign: 'center' }}>
                              +{perfectAtt.length - 10} more employees
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
          )}

          {/* ════════════ TAB: Dept. Breakdown ════════════ */}
          {tab === 'department' && (
            errors.department
              ? <ErrorState message={errors.department} onRetry={load} />
              : (
                <div style={CARD}>
                  <div style={{ fontWeight: 600, color: '#111827', marginBottom: 16, fontSize: 16 }}>
                    Department Breakdown — {MONTH_NAMES[month - 1]} {year}
                  </div>

                  {deptBreakdown.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>
                      No department data for this period
                    </div>
                  ) : (
                    <>
                      {/* Summary cards */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
                        {deptBreakdown.slice(0, 6).map((d, i) => {
                          const delta = d.prev_rate != null
                            ? parseFloat(d.absenteeism_rate || 0) - parseFloat(d.prev_rate || 0)
                            : null;
                          return (
                            <div key={i} style={{ border: '1px solid #f0f0f4', borderRadius: 10, padding: 14 }}>
                              <div style={{ fontWeight: 600, color: '#111827', fontSize: 13, marginBottom: 2 }}>{d.department || 'Unknown'}</div>
                              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>{d.total_employees} employees</div>
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                                <div style={{ fontSize: 20, fontWeight: 700, color: parseFloat(d.absenteeism_rate) > 20 ? '#ef4444' : '#10b981' }}>
                                  {parseFloat(d.absenteeism_rate || 0).toFixed(1)}%
                                </div>
                                <DeltaBadge delta={delta} />
                              </div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>absenteeism</div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Full table */}
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid #f0f0f4' }}>
                            {['Department', 'Employees', 'Present', 'Absent', 'Late', 'Total Hours', 'Absenteeism%', 'vs Last Month'].map(h => (
                              <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 12 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {deptBreakdown.map((d, i) => {
                            const delta = d.prev_rate != null
                              ? parseFloat(d.absenteeism_rate || 0) - parseFloat(d.prev_rate || 0)
                              : null;
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                                <td style={{ padding: '10px 12px', fontWeight: 500, color: '#111827' }}>{d.department || 'Unknown'}</td>
                                <td style={{ padding: '10px 12px' }}>{d.total_employees}</td>
                                <td style={{ padding: '10px 12px', color: '#10b981' }}>{d.present_days}</td>
                                <td style={{ padding: '10px 12px', color: '#ef4444' }}>{d.absent_days}</td>
                                <td style={{ padding: '10px 12px', color: '#f59e0b' }}>{d.late_days}</td>
                                <td style={{ padding: '10px 12px' }}>{parseFloat(d.total_hours || 0).toFixed(0)}h</td>
                                <td style={{ padding: '10px 12px' }}>
                                  <span style={{ fontWeight: 700, color: parseFloat(d.absenteeism_rate) > 20 ? '#ef4444' : parseFloat(d.absenteeism_rate) > 10 ? '#f59e0b' : '#10b981' }}>
                                    {parseFloat(d.absenteeism_rate || 0).toFixed(1)}%
                                  </span>
                                </td>
                                <td style={{ padding: '10px 12px' }}>
                                  {delta !== null ? (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <span style={{ fontSize: 12, color: '#9ca3af' }}>{parseFloat(d.prev_rate).toFixed(1)}%</span>
                                      <DeltaBadge delta={delta} />
                                    </span>
                                  ) : (
                                    <span style={{ fontSize: 12, color: '#d1d5db' }}>—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              )
          )}

          {/* ════════════ TAB: Overtime Summary ════════════ */}
          {tab === 'overtime' && (
            errors.overtime
              ? <ErrorState message={errors.overtime} onRetry={load} />
              : (
                <div style={CARD}>
                  <div style={{ fontWeight: 600, color: '#111827', marginBottom: 16, fontSize: 16 }}>
                    Overtime Summary — {MONTH_NAMES[month - 1]} {year}
                  </div>

                  {otCost.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>
                      No overtime records for this period
                    </div>
                  ) : (
                    <>
                      {/* KPI cards */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 24 }}>
                        {[
                          { label: 'Total OT Hours',     value: otCost.reduce((s, r) => s + parseFloat(r.total_ot_hours || 0), 0).toFixed(1) + 'h', color: P },
                          { label: 'Employees with OT',  value: otCost.reduce((s, r) => s + parseInt(r.employees_with_ot || 0), 0), color: '#10b981' },
                          { label: 'Pending Approvals',  value: otCost.reduce((s, r) => s + parseInt(r.pending_ot || 0), 0), color: '#f59e0b' },
                          { label: 'Approved OT Cost',   value: fmtINR(otCost.reduce((s, r) => s + parseFloat(r.approved_ot_cost || 0), 0)), color: '#ef4444' },
                          { label: 'Total Cost (if all approved)', value: fmtINR(otCost.reduce((s, r) => s + parseFloat(r.total_ot_cost || 0), 0)), color: '#6b7280' },
                        ].map(s => (
                          <div key={s.label} style={{ border: '1px solid #f0f0f4', borderRadius: 10, padding: 16 }}>
                            <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
                          </div>
                        ))}
                      </div>

                      <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12, padding: '8px 12px', background: '#f9fafb', borderRadius: 6 }}>
                        Cost = OT hours × multiplier × (basic_salary ÷ 26 working days ÷ 9 hrs/day).
                        Employees without a configured salary appear as ₹0.
                      </div>

                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid #f0f0f4' }}>
                            {['Department', 'Emp w/ OT', 'Total OT Hrs', 'Approved', 'Pending', 'Rejected', 'Avg Mult.', 'Approved Cost', 'Total Cost'].map(h => (
                              <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 12 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {otCost.map((d, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                              <td style={{ padding: '10px 12px', fontWeight: 500, color: '#111827' }}>{d.department || 'Unknown'}</td>
                              <td style={{ padding: '10px 12px' }}>{d.employees_with_ot}</td>
                              <td style={{ padding: '10px 12px', fontWeight: 700, color: P }}>{parseFloat(d.total_ot_hours || 0).toFixed(1)}h</td>
                              <td style={{ padding: '10px 12px', color: '#10b981' }}>{d.approved_ot}</td>
                              <td style={{ padding: '10px 12px', color: '#f59e0b' }}>{d.pending_ot}</td>
                              <td style={{ padding: '10px 12px', color: '#ef4444' }}>{d.rejected_ot}</td>
                              <td style={{ padding: '10px 12px' }}>{parseFloat(d.avg_multiplier || 1.5).toFixed(2)}×</td>
                              <td style={{ padding: '10px 12px', fontWeight: 600, color: '#10b981' }}>{fmtINR(d.approved_ot_cost)}</td>
                              <td style={{ padding: '10px 12px', color: '#6b7280' }}>{fmtINR(d.total_ot_cost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              )
          )}

          {/* ════════════ TAB: Shift Efficiency ════════════ */}
          {tab === 'shift' && (
            errors.shift
              ? <ErrorState message={errors.shift} onRetry={load} />
              : (
                <div style={CARD}>
                  <div style={{ fontWeight: 600, color: '#111827', marginBottom: 16, fontSize: 16 }}>
                    Shift Efficiency — {MONTH_NAMES[month - 1]} {year}
                  </div>

                  {shiftEff.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 60 }}>
                      <Clock size={36} style={{ marginBottom: 10, opacity: 0.25 }} />
                      <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>No shifts configured</div>
                      <div style={{ fontSize: 13 }}>
                        Go to Attendance → Shift Management to create shifts and assign employees.
                      </div>
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #f0f0f4' }}>
                          {['Shift', 'Timing', 'Assigned', 'Present', 'Late Minutes', 'Avg Hours', 'Attendance Rate'].map(h => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 12 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {shiftEff.map((s, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                            <td style={{ padding: '10px 12px', fontWeight: 600, color: '#111827' }}>{s.shift_name}</td>
                            <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                              {String(s.start_time || '').slice(0, 5)} – {String(s.end_time || '').slice(0, 5)}
                            </td>
                            <td style={{ padding: '10px 12px' }}>{s.assigned_employees}</td>
                            <td style={{ padding: '10px 12px', color: '#10b981', fontWeight: 600 }}>{s.present_count}</td>
                            <td style={{ padding: '10px 12px', color: '#f59e0b' }}>{s.total_late_minutes || 0} min</td>
                            <td style={{ padding: '10px 12px' }}>{s.avg_hours ? `${s.avg_hours}h` : '—'}</td>
                            <td style={{ padding: '10px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 99 }}>
                                  <div style={{
                                    height: '100%', borderRadius: 99,
                                    width: `${Math.min(parseFloat(s.attendance_rate || 0), 100)}%`,
                                    background: parseFloat(s.attendance_rate) >= 80 ? '#10b981' : parseFloat(s.attendance_rate) >= 60 ? '#f59e0b' : '#ef4444',
                                    transition: 'width 0.3s',
                                  }} />
                                </div>
                                <span style={{ fontSize: 12, fontWeight: 700, color: '#111827', minWidth: 38 }}>
                                  {parseFloat(s.attendance_rate || 0).toFixed(1)}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
          )}
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
