// frontend/src/features/hr/pages/SuccessionReports.jsx
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

const BTN = (v = 'primary', sm = false) => ({
  border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
  fontSize: sm ? 12 : 13, padding: sm ? '4px 10px' : '8px 18px',
  background: v === 'primary' ? '#6B3FDB' : v === 'success' ? '#16a34a' : v === 'ghost' ? 'none' : '#e9e4ff',
  color: v === 'primary' ? '#fff' : v === 'success' ? '#fff' : v === 'ghost' ? '#6b7280' : '#6B3FDB',
  ...(v === 'outline' ? { border: '1px solid #6B3FDB', background: 'none', color: '#6B3FDB' } : {}),
});

const RISK_COLORS  = { high: '#dc2626', medium: '#d97706', low: '#16a34a' };
const READY_LABELS = { 'ready-now': 'Ready Now', '1-2-years': '1-2 Yrs', '3-5-years': '3-5 Yrs', 'not_ready': 'Not Ready' };
const READY_COLORS = { 'ready-now': '#16a34a', '1-2-years': '#d97706', '3-5-years': '#6b7280', 'not_ready': '#ef4444' };

function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'inline-block', width: 36, height: 36, border: '3px solid #e9e4ff',
                    borderTopColor: '#6B3FDB', borderRadius: '50%', animation: '_spin .75s linear infinite' }} />
    </div>
  );
}

function RiskBadge({ level }) {
  const c = RISK_COLORS[level] || '#6b7280';
  return (
    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                   background: c + '20', color: c }}>
      {level ? level.charAt(0).toUpperCase() + level.slice(1) : '—'} Risk
    </span>
  );
}

function ReadyBadge({ level }) {
  const c = READY_COLORS[level] || '#6b7280';
  return (
    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                   background: c + '20', color: c }}>
      {READY_LABELS[level] || level}
    </span>
  );
}

function ProgressBar({ value }) {
  const color = value >= 80 ? '#16a34a' : value >= 40 ? '#d97706' : '#6B3FDB';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: '#e9e4ff', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value}%`, background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 700, minWidth: 30 }}>{value}%</span>
    </div>
  );
}

const REPORTS = [
  { id: 'bench-strength',       label: 'Bench Strength',        desc: 'Critical roles vs. successor coverage & readiness',           icon: 'B' },
  { id: 'talent-risk',          label: 'Talent Risk',           desc: 'Flight risk, readiness & classification by employee',         icon: 'T' },
  { id: 'nine-box-summary',     label: '9-Box Summary',         desc: 'All employees mapped to 9-box quadrant',                      icon: '9' },
  { id: 'development-progress', label: 'Development Progress',  desc: 'Active plans, action completion % by employee',               icon: 'D' },
  { id: 'readiness',            label: 'Readiness Distribution',desc: 'Who is ready now, 1-2 yrs, 3-5 yrs, not ready',              icon: 'R' },
  { id: 'pipeline',             label: 'Leadership Pipeline',   desc: 'Employee distribution across pipeline levels',                icon: 'L' },
];

export default function SuccessionReports() {
  const [activeReport, setActiveReport] = useState('bench-strength');
  const [data,         setData]         = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [msg,          setMsg]          = useState({ text: '', type: '' });

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 3500);
  };

  const loadReport = useCallback(async (id) => {
    setLoading(true);
    setData([]);
    try {
      const r = await api.get(`/succession/reports/${id}`);
      setData(r.data || []);
    } catch (err) {
      flash(err.response?.data?.message || 'Failed to load report', 'error');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadReport(activeReport); }, [activeReport, loadReport]);

  const exportCSV = async () => {
    try {
      const response = await api.get(`/succession/reports/${activeReport}?format=csv`, { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const a   = document.createElement('a');
      a.href = url;
      a.download = `${activeReport}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: client-side CSV from loaded data
      if (!data.length) return;
      const headers = Object.keys(data[0]);
      const escape  = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
      const csv = [headers.map(escape).join(','), ...data.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `${activeReport}.csv`;
      a.click(); URL.revokeObjectURL(url);
    }
  };

  const tabStyle = (id) => ({
    padding: '8px 16px', border: 'none', cursor: 'pointer', borderRadius: 8,
    fontWeight: 600, fontSize: 12, textAlign: 'left', transition: 'all .15s',
    background: activeReport === id ? '#6B3FDB' : 'transparent',
    color: activeReport === id ? '#fff' : '#6b7280',
  });

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Succession Reports</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          Downloadable reports for talent reviews and board presentations
        </p>
      </div>

      {msg.text && (
        <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14,
                      background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
                      color:      msg.type === 'error' ? '#dc2626' : '#16a34a',
                      border:     `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start' }}>

        {/* Sidebar */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 12 }}>
          {REPORTS.map(r => (
            <button key={r.id} style={tabStyle(r.id)} onClick={() => setActiveReport(r.id)}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0,
                               display: 'flex', alignItems: 'center', justifyContent: 'center',
                               background: activeReport === r.id ? 'rgba(255,255,255,0.2)' : '#f5f3ff',
                               color: activeReport === r.id ? '#fff' : '#6B3FDB', fontWeight: 800, fontSize: 12 }}>
                  {r.icon}
                </span>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{r.label}</div>
                  <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2, lineHeight: 1.3 }}>{r.desc}</div>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Report content */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h3 style={{ margin: 0, color: '#4c1d95' }}>
                {REPORTS.find(r => r.id === activeReport)?.label}
              </h3>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
                {data.length} row{data.length !== 1 ? 's' : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => loadReport(activeReport)} style={BTN('secondary', true)}>
                Refresh
              </button>
              <button onClick={exportCSV} disabled={!data.length} style={BTN('success', true)}>
                Export CSV
              </button>
            </div>
          </div>

          {loading ? <Spinner /> : data.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>-</div>
              <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 15 }}>No data for this report</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Add assessments, critical roles, and succession plans to generate reports.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              {/* ── Bench Strength ── */}
              {activeReport === 'bench-strength' && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Role', 'Dept', 'Current Holder', 'Risk', 'Successors', 'Ready Now', '1-2 Yrs', '3-5 Yrs', 'Status', 'Expected Vacancy'].map(h => (
                        <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff',
                                             color: '#4c1d95', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#1f2937' }}>
                          {row.role_title}
                          {row.knowledge_domain && (
                            <div style={{ fontSize: 10, color: '#6B3FDB', fontWeight: 400 }}>{row.knowledge_domain}</div>
                          )}
                        </td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department || '—'}</td>
                        <td style={{ padding: '9px 12px' }}>{row.current_holder || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Vacant</span>}</td>
                        <td style={{ padding: '9px 12px' }}><RiskBadge level={row.risk_level} /></td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', fontWeight: 700, color: row.successor_count > 0 ? '#6B3FDB' : '#ef4444' }}>
                          {row.successor_count}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', fontWeight: 700, color: '#16a34a' }}>{row.ready_now}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', color: '#d97706' }}>{row.ready_1_2yr}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', color: '#6b7280' }}>{row.ready_3_5yr}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                         background: row.coverage_status === 'NO SUCCESSOR' ? '#fee2e2' : '#d1fae5',
                                         color: row.coverage_status === 'NO SUCCESSOR' ? '#dc2626' : '#16a34a' }}>
                            {row.coverage_status}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', color: '#6b7280', fontSize: 12 }}>
                          {row.expected_vacancy_date ? new Date(row.expected_vacancy_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* ── Talent Risk ── */}
              {activeReport === 'talent-risk' && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Employee', 'Department', 'Designation', 'Perf', 'Potential', 'Flight Risk', 'Readiness', 'Classification', 'Succession Roles', 'Last Assessment'].map(h => (
                        <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff',
                                             color: '#4c1d95', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f0ebff',
                                           background: row.flight_risk === 'high' ? '#fff5f5' : 'transparent' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#1f2937' }}>{row.employee_name}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.designation}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>{row.performance_score}/5</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#6B3FDB' }}>{row.potential_score}/5</td>
                        <td style={{ padding: '9px 12px' }}><RiskBadge level={row.flight_risk} /></td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px' }}>
                          {row.talent_classification
                            ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8,
                                             background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 }}>
                                {row.talent_classification}
                              </span>
                            : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6B3FDB', maxWidth: 200 }}>
                          {row.successor_to_roles || <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#9ca3af' }}>
                          {row.assessment_date ? new Date(row.assessment_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* ── 9-Box Summary ── */}
              {activeReport === 'nine-box-summary' && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Employee', 'Department', 'Designation', 'Quadrant', 'Perf Score', 'Potential Score', 'Flight Risk', 'Readiness', 'Assessed'].map(h => (
                        <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff',
                                             color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 700 }}>{row.name}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.designation}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
                                         background: row.quadrant === 'Stars' ? '#ede9fe' : '#f5f3ff',
                                         color: row.quadrant === 'Stars' ? '#6B3FDB' : '#4c1d95' }}>
                            {row.quadrant}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>{row.performance_score}/5</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#6B3FDB' }}>{row.potential_score}/5</td>
                        <td style={{ padding: '9px 12px' }}><RiskBadge level={row.flight_risk} /></td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#9ca3af' }}>
                          {row.assessment_date ? new Date(row.assessment_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* ── Development Progress ── */}
              {activeReport === 'development-progress' && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Employee', 'Department', 'Plan', 'Target Role', 'Status', 'Progress', 'Actions', 'Mentors', 'Target Date'].map(h => (
                        <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff',
                                             color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row, i) => {
                      const statusColors = { active: '#6B3FDB', completed: '#16a34a', paused: '#d97706', cancelled: '#ef4444' };
                      const sc = statusColors[row.status] || '#6b7280';
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 700 }}>{row.employee_name}</td>
                          <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department}</td>
                          <td style={{ padding: '9px 12px', maxWidth: 200, color: '#1f2937' }}>{row.plan_title}</td>
                          <td style={{ padding: '9px 12px', color: '#6B3FDB', fontSize: 12 }}>{row.target_role || '—'}</td>
                          <td style={{ padding: '9px 12px' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
                                           background: sc + '20', color: sc }}>{row.status}</span>
                          </td>
                          <td style={{ padding: '9px 12px', minWidth: 140 }}>
                            <ProgressBar value={parseInt(row.overall_progress) || 0} />
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'center' }}>
                            <span style={{ color: '#6B3FDB', fontWeight: 700 }}>{row.completed_actions}</span>
                            <span style={{ color: '#9ca3af' }}>/{row.total_actions}</span>
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'center', color: row.active_mentors > 0 ? '#16a34a' : '#9ca3af', fontWeight: 600 }}>
                            {row.active_mentors}
                          </td>
                          <td style={{ padding: '9px 12px', fontSize: 11, color: '#6b7280' }}>
                            {row.target_date ? new Date(row.target_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* ── Readiness Distribution ── */}
              {activeReport === 'readiness' && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Employee', 'Dept', 'Designation', 'Perf', 'Potential', 'Leadership', 'Readiness', 'Classification', 'Mobility', 'Succession Roles', 'Active Plans'].map(h => (
                        <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff',
                                             color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 700 }}>{row.name}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.designation}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>{row.performance_score}/5</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#6B3FDB' }}>{row.potential_score}/5</td>
                        <td style={{ padding: '9px 12px', color: '#0891b2' }}>{row.leadership_score ? `${row.leadership_score}/5` : '—'}</td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px' }}>
                          {row.talent_classification
                            ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 }}>{row.talent_classification}</span>
                            : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6b7280' }}>
                          {row.mobility ? row.mobility.replace(/_/g,' ') : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6B3FDB', maxWidth: 180 }}>
                          {row.succession_roles || <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', fontWeight: 700, color: row.active_plans > 0 ? '#6B3FDB' : '#9ca3af' }}>
                          {row.active_plans}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* ── Pipeline ── */}
              {activeReport === 'pipeline' && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Employee', 'Department', 'Current Level', 'Target Level', 'Since', 'Target Date', 'Readiness', 'Perf', 'Potential', 'Status'].map(h => (
                        <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff',
                                             color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 700 }}>{row.name}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ fontWeight: 600, color: '#4c1d95' }}>{row.current_level}</span>
                        </td>
                        <td style={{ padding: '9px 12px', color: '#6B3FDB' }}>{row.target_level || '—'}</td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6b7280' }}>
                          {row.current_since ? new Date(row.current_since).toLocaleDateString('en-IN', { month:'short', year:'numeric' }) : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6b7280' }}>
                          {row.target_date ? new Date(row.target_date).toLocaleDateString('en-IN', { month:'short', year:'numeric' }) : '—'}
                        </td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>
                          {row.performance_score ? `${row.performance_score}/5` : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#6B3FDB' }}>
                          {row.potential_score ? `${row.potential_score}/5` : '—'}
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
                                         background: row.status === 'active' ? '#d1fae5' : '#f9fafb',
                                         color: row.status === 'active' ? '#16a34a' : '#6b7280' }}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
