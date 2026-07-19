// frontend/src/features/hr/pages/HRAnalyticsDashboard.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function Card({ title, children, style, expand, expandTitle, index = 0 }) {
  return (
    <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 11, padding: 14, '--dk-i': index, ...style }}>
      {title && (
        <div style={{ fontWeight: 700, fontSize: 13.5, color: '#374151', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          {title}
          {expand && (
            <span style={{ marginLeft: 'auto' }}>
              <ChartExpandButton title={expandTitle || (typeof title === 'string' ? title : 'Detail')}>{expand}</ChartExpandButton>
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function KPI({ label, value, sub, accent = '#6B3FDB', delta, loading, index = 0 }) {
  return (
    <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 11, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3, '--dk-i': index }}>
      <div style={{ fontSize: 11.5, color: '#6b7280', fontWeight: 500 }}>{label}</div>
      {loading
        ? <div style={{ height: 27, width: 80, background: '#f3f4f6', borderRadius: 6, animation: 'pulse 1.5s infinite' }} />
        : <div style={{ fontSize: 24, fontWeight: 800, color: accent }}>{value ?? '—'}</div>
      }
      {sub && <div style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</div>}
      {delta != null && (
        <div style={{ fontSize: 12, color: delta >= 0 ? '#059669' : '#dc2626', fontWeight: 600 }}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% vs last month
        </div>
      )}
    </div>
  );
}

// ─── Horizontal bar chart (pure CSS) ─────────────────────────────────────────

function BarChart({ data = [], labelKey = 'label', valueKey = 'count', max, accent = '#6B3FDB' }) {
  const peak = max || Math.max(...data.map(d => d[valueKey] || 0), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 120, fontSize: 12, color: '#4b5563', textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d[labelKey]}</div>
          <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 4, height: 16, position: 'relative' }}>
            <div style={{ width: `${Math.round((d[valueKey] / peak) * 100)}%`, background: accent, height: '100%', borderRadius: 4, transition: 'width 0.4s ease' }} />
          </div>
          <div style={{ width: 32, fontSize: 12, color: '#374151', fontWeight: 600 }}>{d[valueKey]}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Donut / pie segment (SVG) ─────────────────────────────────────────────────

const COLORS = ['#6B3FDB', '#059669', '#d97706', '#dc2626', '#2563eb', '#db2777', '#0891b2', '#65a30d'];

function DonutChart({ data = [], labelKey = 'label', valueKey = 'count', size = 140 }) {
  const total = data.reduce((s, d) => s + (d[valueKey] || 0), 0);
  if (!total) return <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: 20 }}>No data</div>;
  let offset = 0;
  const r = 50; const cx = 60; const cy = 60;
  const segments = data.map((d, i) => {
    const pct = d[valueKey] / total;
    const angle = pct * 360;
    const startRad = ((offset - 90) * Math.PI) / 180;
    const endRad   = ((offset + angle - 90) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const large = angle > 180 ? 1 : 0;
    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    offset += angle;
    return { path, color: COLORS[i % COLORS.length], label: d[labelKey], value: d[valueKey], pct: Math.round(pct * 100) };
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox="0 0 120 120">
        {segments.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke="#fff" strokeWidth={1.5} />)}
        <text x={60} y={64} textAnchor="middle" fontSize={12} fontWeight="bold" fill="#374151">{total}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {segments.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ color: '#374151' }}>{s.label}</span>
            <span style={{ color: '#9ca3af', marginLeft: 'auto' }}>{s.value} ({s.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Trend mini-sparkline ──────────────────────────────────────────────────────

function Sparkline({ data = [], accent = '#6B3FDB', width = 200, height = 50 }) {
  if (!data.length) return null;
  const values = data.map(d => d.count || 0);
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * width;
    const y = height - (v / max) * height;
    return `${x},${y}`;
  });
  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <polyline points={pts.join(' ')} fill="none" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((pt, i) => {
        const [x, y] = pt.split(',');
        return <circle key={i} cx={x} cy={y} r={3} fill={accent} />;
      })}
    </svg>
  );
}

// ─── Table component ───────────────────────────────────────────────────────────

function SimpleTable({ columns, rows, emptyMsg = 'No data', maxHeight = 240 }) {
  if (!rows?.length) return <div style={{ color: '#9ca3af', fontSize: 13, padding: '16px 0' }}>{emptyMsg}</div>;
  return (
    <div style={{ overflowX: 'auto', maxHeight, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
              {columns.map(c => (
                <td key={c.key} style={{ padding: '8px 12px', color: '#374151', whiteSpace: 'nowrap' }}>
                  {c.render ? c.render(r[c.key], r) : (r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  active:       { bg: '#d1fae5', color: '#065f46' },
  probation:    { bg: '#dbeafe', color: '#1e40af' },
  left:         { bg: '#fee2e2', color: '#991b1b' },
  resigned:     { bg: '#fef3c7', color: '#92400e' },
  terminated:   { bg: '#fee2e2', color: '#991b1b' },
  notice_period:{ bg: '#ede9fe', color: '#5b21b6' },
};
function StatusBadge({ status }) {
  const s = status?.toLowerCase().replace(' ', '_') || '';
  const c = STATUS_COLORS[s] || { bg: '#f3f4f6', color: '#6b7280' };
  return <span style={{ background: c.bg, color: c.color, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, textTransform: 'capitalize' }}>{status || '—'}</span>;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function HRAnalyticsDashboard() {
  const [kpis,         setKpis]         = useState(null);
  const [deptDist,     setDeptDist]     = useState([]);
  const [statusDist,   setStatusDist]   = useState([]);
  const [ageDist,      setAgeDist]      = useState([]);
  const [attrTrend,    setAttrTrend]    = useState([]);
  const [hireTrend,    setHireTrend]    = useState([]);
  const [pendingLeave, setPendingLeave] = useState(0);
  const [docExpiry,    setDocExpiry]    = useState([]);
  const [topDepts,     setTopDepts]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const abortRef = useRef(null);

  const loadAll = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError('');
    try {
      const [kpiRes, deptRes, statusRes, ageRes, attrRes, hireRes, pendRes, docRes] = await Promise.allSettled([
        api.get('/analytics/hr-kpis',                   { signal: ctrl.signal }),
        api.get('/analytics/department-distribution',   { signal: ctrl.signal }),
        api.get('/analytics/employee-status',           { signal: ctrl.signal }),
        api.get('/analytics/age-distribution',          { signal: ctrl.signal }),
        api.get('/analytics/attrition-trend',           { signal: ctrl.signal }),
        api.get('/analytics/hiring-trend',              { signal: ctrl.signal }),
        api.get('/analytics/pending-leaves',            { signal: ctrl.signal }),
        api.get('/analytics/employee-reports/doc-expiry', { signal: ctrl.signal }),
      ]);

      if (kpiRes.status === 'fulfilled') setKpis(kpiRes.value.data);
      if (deptRes.status === 'fulfilled') setDeptDist(deptRes.value.data?.departments || deptRes.value.data || []);
      if (statusRes.status === 'fulfilled') {
        const d = statusRes.value.data;
        setStatusDist(Array.isArray(d) ? d : d?.statuses || []);
      }
      if (ageRes.status === 'fulfilled') setAgeDist(ageRes.value.data?.brackets || ageRes.value.data || []);
      if (attrRes.status === 'fulfilled') setAttrTrend(attrRes.value.data?.trend || attrRes.value.data || []);
      if (hireRes.status === 'fulfilled') setHireTrend(hireRes.value.data?.trend || hireRes.value.data || []);
      if (pendRes.status === 'fulfilled') setPendingLeave(pendRes.value.data?.count ?? pendRes.value.data?.pending ?? 0);
      if (docRes.status === 'fulfilled') {
        const docs = docRes.value.data?.documents || docRes.value.data || [];
        setDocExpiry(Array.isArray(docs) ? docs.slice(0, 6) : []);
      }
      // Build top departments from dept distribution
      if (deptRes.status === 'fulfilled') {
        const arr = deptRes.value.data?.departments || deptRes.value.data || [];
        setTopDepts([...arr].sort((a, b) => (b.count || b.employee_count || 0) - (a.count || a.employee_count || 0)).slice(0, 8));
      }
    } catch (e) {
      if (e.name !== 'AbortError') setError('Failed to load analytics data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); return () => abortRef.current?.abort(); }, [loadAll]);

  const totalHeadcount = kpis?.total_employees ?? kpis?.headcount ?? '—';
  const activeCount    = kpis?.active_employees ?? kpis?.active    ?? '—';
  const onLeave        = kpis?.on_leave         ?? pendingLeave    ?? '—';
  const attritionRate  = kpis?.attrition_rate   ?? kpis?.attrition ?? '—';
  const avgTenure      = kpis?.avg_tenure_years  ?? kpis?.avg_tenure ?? '—';
  const probationCount = kpis?.probation_count   ?? kpis?.probation  ?? '—';

  return (
    <div style={{ padding: '16px 18px 20px', background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827' }}>HR Analytics Dashboard</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12.5, color: '#6b7280' }}>
            Live workforce intelligence — headcount, attrition, demographics and alerts
          </p>
        </div>
        <button onClick={loadAll} disabled={loading}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', color: '#991b1b', fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      {/* KPI Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 10, marginBottom: 14 }}>
        <KPI index={0} label="Total Headcount"   value={totalHeadcount} accent="#6B3FDB" loading={loading} sub="All statuses" />
        <KPI index={1} label="Active Employees"  value={activeCount}    accent="#059669" loading={loading} sub="Incl. probation" />
        <KPI index={2} label="On Probation"      value={probationCount} accent="#2563eb" loading={loading} sub="In review period" />
        <KPI index={3} label="On Leave Today"    value={onLeave}        accent="#d97706" loading={loading} sub="Pending / approved" />
        <KPI index={4} label="Attrition Rate"    value={attritionRate != null && attritionRate !== '—' ? `${attritionRate}%` : '—'} accent="#dc2626" loading={loading} sub="Last 12 months" />
        <KPI index={5} label="Avg Tenure (yrs)"  value={avgTenure != null && avgTenure !== '—' ? parseFloat(avgTenure).toFixed(1) : '—'} accent="#0891b2" loading={loading} />
      </div>

      {/* Row 2: Dept distribution + Status donut */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Card index={6} title="👥 Department Headcount" expandTitle="Department Headcount"
          expand={!loading && topDepts.length ? <BarChart data={topDepts} labelKey="department" valueKey="count" accent="#6B3FDB" /> : null}>
          {loading
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            : <BarChart data={topDepts} labelKey="department" valueKey="count" accent="#6B3FDB" />
          }
        </Card>

        <Card index={7} title="📊 Employment Status Breakdown" expandTitle="Employment Status Breakdown"
          expand={!loading && statusDist.length ? <DonutChart data={statusDist} labelKey="status" valueKey="count" size={260} /> : null}>
          {loading
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            : <DonutChart data={statusDist} labelKey="status" valueKey="count" />
          }
        </Card>
      </div>

      {/* Row 3: Age distribution + Attrition trend */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Card index={8} title="🎂 Age Distribution" expandTitle="Age Distribution"
          expand={!loading && ageDist.length ? <BarChart data={ageDist} labelKey="age_range" valueKey="count" accent="#059669" /> : null}>
          {loading
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            : ageDist.length
              ? <BarChart data={ageDist} labelKey="age_range" valueKey="count" accent="#059669" />
              : <div style={{ color: '#9ca3af', fontSize: 13 }}>No age data available — ensure employee date of birth is filled</div>
          }
        </Card>

        <Card index={9} title="📉 Attrition Trend (monthly)" expandTitle="Attrition Trend (monthly)"
          expand={!loading && attrTrend.length ? <Sparkline data={attrTrend} accent="#dc2626" width={760} height={300} /> : null}>
          {loading
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            : attrTrend.length
              ? (
                <div>
                  <Sparkline data={attrTrend} accent="#dc2626" width={280} height={55} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, overflowX: 'auto' }}>
                    {attrTrend.map((d, i) => (
                      <div key={i} style={{ textAlign: 'center', minWidth: 42 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#dc2626' }}>{d.count}</div>
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>{(d.month || d.period || '').slice(-5)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )
              : <div style={{ color: '#9ca3af', fontSize: 13 }}>No attrition trend data</div>
          }
        </Card>
      </div>

      {/* Row 4: Hiring trend + Doc expiry alerts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Card index={10} title="📈 New Hires Trend (monthly)" expandTitle="New Hires Trend (monthly)"
          expand={!loading && hireTrend.length ? <Sparkline data={hireTrend} accent="#059669" width={760} height={300} /> : null}>
          {loading
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            : hireTrend.length
              ? (
                <div>
                  <Sparkline data={hireTrend} accent="#059669" width={280} height={55} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, overflowX: 'auto' }}>
                    {hireTrend.map((d, i) => (
                      <div key={i} style={{ textAlign: 'center', minWidth: 42 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#059669' }}>{d.count}</div>
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>{(d.month || d.period || '').slice(-5)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )
              : <div style={{ color: '#9ca3af', fontSize: 13 }}>No hiring trend data</div>
          }
        </Card>

        <Card index={11} title="⚠️ Document Expiry Alerts" style={{ border: docExpiry.length ? '1px solid #fcd34d' : '1px solid #e5e7eb' }}>
          {loading
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            : docExpiry.length
              ? (
                <div>
                  <div style={{ fontSize: 12, color: '#92400e', marginBottom: 10, background: '#fef3c7', borderRadius: 6, padding: '6px 10px', fontWeight: 600 }}>
                    {docExpiry.length} document(s) expiring soon
                  </div>
                  <SimpleTable
                    columns={[
                      { key: 'employee_name', label: 'Employee' },
                      { key: 'document_type', label: 'Document' },
                      { key: 'expiry_date', label: 'Expires', render: v => v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—' },
                      { key: 'days_left', label: 'Days Left', render: v => <span style={{ color: v <= 7 ? '#dc2626' : v <= 30 ? '#d97706' : '#059669', fontWeight: 700 }}>{v}</span> },
                    ]}
                    rows={docExpiry}
                    emptyMsg="No expiring documents"
                  />
                </div>
              )
              : <div style={{ color: '#6b7280', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20 }}>✅</span> No documents expiring in the next 90 days
                </div>
          }
        </Card>
      </div>

      {/* Row 5: Tenure distribution from dept */}
      {!loading && deptDist.length > 0 && (
        <Card index={12} title="🏢 Full Department Breakdown">
          <SimpleTable
            columns={[
              { key: 'department', label: 'Department' },
              { key: 'count', label: 'Headcount', render: v => <strong style={{ color: '#6B3FDB' }}>{v}</strong> },
              { key: 'avg_tenure', label: 'Avg Tenure', render: v => v ? `${parseFloat(v).toFixed(1)} yrs` : '—' },
              { key: 'managers', label: 'Managers', render: v => v ?? '—' },
            ]}
            rows={deptDist}
            emptyMsg="No department data"
            maxHeight={300}
          />
        </Card>
      )}
    </div>
  );
}
