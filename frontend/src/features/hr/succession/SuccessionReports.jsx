// frontend/src/features/hr/succession/SuccessionReports.jsx
// Succession Center → Reports: on-screen tables with server-side CSV export.
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { fmtScore } from '@/utils/format';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import { downloadSuccessionCsv } from '../utils/successionCsv';
import { BTN, Chip, RiskBadge, ReadyBadge, PhaseBadge, Spinner, Flash, useFlash, errText } from '../utils/successionUi';

// Bench Strength coverage, the same three states as the Critical Roles tab.
const COVERAGE_STYLE = {
  'Ready Now':    { background: '#d1fae5', color: '#16a34a' },
  'Developing':   { background: '#ede9fe', color: '#6d28d9' },
  'No Successor': { background: '#fee2e2', color: '#dc2626' },
};
const RISK_RANK = { low: 1, medium: 2, high: 3 };

function ProgressBar({ value }) {
  const color = value >= 80 ? '#16a34a' : value >= 40 ? '#6d28d9' : '#6B3FDB';
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
  { id: 'readiness',            label: 'Readiness Distribution',desc: 'Who is ready now, 1–2 years, 3–5 years, not ready',          icon: 'R' },
  { id: 'pipeline',             label: 'Leadership Pipeline',   desc: 'Employee distribution across pipeline levels',                icon: 'L' },
];

export default function SuccessionReports() {
  const { hasPermission } = useAuth();
  const canExport = hasPermission('succession', 'export');
  const [activeReport, setActiveReport] = useState('bench-strength');
  // Settings → Flight Risk Threshold: "highlight employees at or above this
  // risk level in reports". Talent Risk highlighted 'high' only, whatever was saved.
  const [riskThreshold, setRiskThreshold] = useState('high');
  useEffect(() => {
    api.get('/succession/settings')
      .then(r => { if (RISK_RANK[r.data?.flight_risk_threshold]) setRiskThreshold(r.data.flight_risk_threshold); })
      .catch(() => {});
  }, []);
  const flagged = (risk) => (RISK_RANK[risk] || 0) >= RISK_RANK[riskThreshold];
  const [data,         setData]         = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [msg, flash]                    = useFlash();

  const loadReport = useCallback(async (id) => {
    setLoading(true);
    setData([]);
    try {
      const r = await api.get(`/succession/reports/${id}`);
      setData(r.data || []);
    } catch (err) {
      flash(errText(err, 'Failed to load report'), 'error');
    } finally { setLoading(false); }
  }, [flash]);

  useEffect(() => { loadReport(activeReport); }, [activeReport, loadReport]);

  // Server only. The old fallback rebuilt the file in the browser whenever the
  // server refused, so a user without succession:export still got the CSV
  // (and without the formula guard). A refusal is now shown, not worked around.
  const exportCSV = async () => {
    try { await downloadSuccessionCsv(activeReport); }
    catch (err) { flash(err.message, 'error'); }
  };

  const tabStyle = (id) => ({
    padding: '8px 16px', border: 'none', cursor: 'pointer', borderRadius: 8,
    fontWeight: 600, fontSize: 12, textAlign: 'left', transition: 'all .15s',
    background: activeReport === id ? '#6B3FDB' : 'transparent',
    color: activeReport === id ? '#fff' : '#6b7280',
  });

  return (
    <div>
      <Flash msg={msg} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>

        {/* Sidebar */}
        <div role="tablist" aria-label="Reports" style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 12, display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px', maxWidth: 300 }}>
          {REPORTS.map(r => (
            <button key={r.id} type="button" role="tab" aria-selected={activeReport === r.id} style={tabStyle(r.id)} onClick={() => setActiveReport(r.id)}>
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
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 20, flex: '999 1 480px', minWidth: 0 }}>
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
              <button type="button" onClick={() => loadReport(activeReport)} style={BTN('secondary', true)}>
                Refresh
              </button>
              {canExport && (
                <button type="button" onClick={exportCSV} disabled={!data.length} style={BTN('success', true)}>
                  Export CSV
                </button>
              )}
            </div>
          </div>

          {loading ? <Spinner /> : data.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>-</div>
              <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 15 }}>No data for this report</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Add assessments, critical roles, and succession plans to generate reports. People who have left are not included.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              {/* ── Bench Strength ── */}
              {activeReport === 'bench-strength' && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff' }}>
                      {['Role', 'Dept', 'Current Holder', 'Risk', 'Successors', 'Ready Now', '1-2 Yrs', '3-5 Yrs', 'Not Ready', 'Not rated', 'Status', 'Expected Vacancy'].map(h => (
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
                        <td style={{ padding: '9px 12px' }}>
                          {row.current_holder
                            ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{row.current_holder} <PhaseBadge phase={row.holder_phase} /></span>
                            : <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Vacant</span>}
                        </td>
                        <td style={{ padding: '9px 12px' }}><RiskBadge level={row.risk_level} /></td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', fontWeight: 700, color: row.successor_count > 0 ? '#6B3FDB' : '#ef4444' }}>
                          {row.successor_count}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', fontWeight: 700, color: '#16a34a' }}>{row.ready_now}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', color: '#6d28d9' }}>{row.ready_1_2yr}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', color: '#6b7280' }}>{row.ready_3_5yr}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', color: '#ef4444' }}>{row.not_ready ?? 0}</td>
                        {/* Successors with no 9-box rating: counted in Successors,
                            in no readiness column. */}
                        <td style={{ padding: '9px 12px', textAlign: 'center', color: '#9ca3af' }}
                            title="Successors with no 9-box rating">{row.ready_unclassified ?? 0}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                         ...(COVERAGE_STYLE[row.coverage_status] || COVERAGE_STYLE['No Successor']) }}>
                            {row.coverage_status}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', color: '#6b7280', fontSize: 12 }}>
                          {fmtDate(row.expected_vacancy_date)}
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
                                           background: flagged(row.flight_risk) ? '#fff5f5' : 'transparent' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#1f2937' }}>{row.employee_name}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.designation}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>{fmtScore(row.performance_score, 5)}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#6B3FDB' }}>{row.potential_score}/5</td>
                        <td style={{ padding: '9px 12px' }}><RiskBadge level={row.flight_risk} /></td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px' }}>
                          {row.talent_classification
                            ? <Chip color="#1d4ed8">{row.talent_classification}</Chip>
                            : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6B3FDB', maxWidth: 200 }}>
                          {row.successor_to_roles || <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#9ca3af' }}>
                          {fmtDate(row.assessment_date)}
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
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>{fmtScore(row.performance_score, 5)}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#6B3FDB' }}>{row.potential_score}/5</td>
                        <td style={{ padding: '9px 12px' }}><RiskBadge level={row.flight_risk} /></td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#9ca3af' }}>
                          {fmtDate(row.assessment_date)}
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
                      const statusColors = { active: '#6B3FDB', completed: '#16a34a', paused: '#6d28d9', cancelled: '#ef4444' };
                      const sc = statusColors[row.status] || '#6b7280';
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 700 }}>
                            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{row.employee_name} <PhaseBadge phase={row.employment_phase} /></span>
                          </td>
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
                            {fmtDate(row.target_date)}
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
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>{fmtScore(row.performance_score, 5)}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#6B3FDB' }}>{row.potential_score}/5</td>
                        <td style={{ padding: '9px 12px', color: '#0891b2' }}>{row.leadership_score ? `${row.leadership_score}/5` : '—'}</td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px' }}>
                          {row.talent_classification
                            ? <Chip color="#1d4ed8">{row.talent_classification}</Chip>
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
                        <td style={{ padding: '9px 12px', fontWeight: 700 }}>
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{row.name} <PhaseBadge phase={row.employment_phase} /></span>
                        </td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{row.department}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ fontWeight: 600, color: '#4c1d95' }}>{row.current_level || '—'}</span>
                        </td>
                        <td style={{ padding: '9px 12px', color: '#6B3FDB' }}>{row.target_level || '—'}</td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6b7280' }}>
                          {fmtDate(row.current_since)}
                        </td>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: '#6b7280' }}>
                          {fmtDate(row.target_date)}
                        </td>
                        <td style={{ padding: '9px 12px' }}><ReadyBadge level={row.readiness} /></td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: '#16a34a' }}>
                          {fmtScore(row.performance_score, 5)}
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
