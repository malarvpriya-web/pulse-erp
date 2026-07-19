/**
 * Phase 49G-13/20/21/23 — VendorRiskHeatmap
 *
 * Full-page supplier risk heatmap + procurement dashboard.
 * Shows: health distribution cards, risk heatmap table,
 *        CEO Command Center, early warnings.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import api from '@/services/api/client';

// ── Design ─────────────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  Preferred: { color: '#16a34a', bg: '#dcfce7', icon: '★', rank: 1 },
  Approved:  { color: '#2563eb', bg: '#dbeafe', icon: '✓', rank: 2 },
  Watchlist: { color: '#d97706', bg: '#fef3c7', icon: '⚠', rank: 3 },
  Critical:  { color: '#dc2626', bg: '#fee2e2', icon: '✕', rank: 4 },
};

const WARN_SEVERITY_COLOR = { Critical: '#dc2626', High: '#ea580c', Medium: '#d97706', Low: '#6b7280' };

const CATEGORY_LABELS = {
  'IGBT Suppliers':           'IGBT',
  'Transformer Suppliers':    'Transformers',
  'Capacitor Suppliers':      'Capacitors',
  'Semiconductor Suppliers':  'Semiconductors',
  'Control System Suppliers': 'Control Systems',
  'Fabrication Vendors':      'Fabrication',
  'Testing Vendors':          'Testing',
  'Logistics Vendors':        'Logistics',
};

function fmtINR(n) {
  const v = parseFloat(n || 0);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)} Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
}

function ScorePill({ score, status }) {
  const cfg = STATUS_CONFIG[status] || { color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px',
      borderRadius: 12, fontSize: 12, fontWeight: 700, color: cfg.color, background: cfg.bg,
    }}>
      {score?.toFixed(1)}
    </span>
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || { color: '#6b7280', bg: '#f3f4f6', icon: '?' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px',
      borderRadius: 12, fontSize: 11, fontWeight: 700, color: cfg.color, background: cfg.bg,
    }}>
      {cfg.icon} {status}
    </span>
  );
}

function SummaryCard({ label, value, color, icon, sub }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12,
      padding: '16px 20px', borderTop: `4px solid ${color}`, flex: 1, minWidth: 120,
    }}>
      <div style={{ fontSize: 28, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 30, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: '#374151', fontWeight: 600, marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function VendorRiskHeatmap({ setPage }) {
  const [dash,     setDash]     = useState(null);
  const [heatmap,  setHeatmap]  = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [ceo,      setCeo]      = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [activeTab, setActiveTab] = useState('heatmap');
  const [filter, setFilter]    = useState('all');
  const [recalcAll, setRecalcAll] = useState(false);
  const [search, setSearch]    = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dashRes, hmRes, warnRes, ceoRes] = await Promise.allSettled([
        api.get('/vendor-health/dashboard'),
        api.get('/vendor-health/heatmap'),
        api.get('/vendor-health/early-warnings'),
        api.get('/vendor-health/ceo-command-center'),
      ]);
      if (dashRes.status === 'fulfilled') setDash(dashRes.value.data);
      if (hmRes.status === 'fulfilled')   setHeatmap(hmRes.value.data || []);
      if (warnRes.status === 'fulfilled') setWarnings(warnRes.value.data || []);
      if (ceoRes.status === 'fulfilled')  setCeo(ceoRes.value.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRecalcAll = async () => {
    setRecalcAll(true);
    try {
      await api.post('/vendor-health/recalculate-all');
      await load();
    } catch { /* silent */ }
    setRecalcAll(false);
  };

  const acknowledgeWarning = async (id) => {
    try {
      await api.patch(`/vendor-health/warnings/${id}/acknowledge`);
      setWarnings(w => w.filter(x => x.id !== id));
    } catch { /* silent */ }
  };

  // Heatmap filter + search
  const filteredHeatmap = heatmap.filter(v => {
    if (filter !== 'all' && v.health_status !== filter) return false;
    if (search && !v.vendor_name?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const cards = dash?.cards || {};
  const dist  = dash?.charts?.distribution || [];

  const PIE_COLORS = { Preferred: '#16a34a', Approved: '#2563eb', Watchlist: '#d97706', Critical: '#dc2626' };

  const tabs = [
    { key: 'heatmap', label: 'Risk Heatmap' },
    { key: 'warnings', label: `Early Warnings${warnings.length ? ` (${warnings.length})` : ''}` },
    { key: 'ceo', label: 'CEO Command Center' },
  ];

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center',
                  height: 300, color: '#9ca3af', fontSize: 14 }}>
      Loading supplier health data…
    </div>
  );

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>
            Supplier Health Intelligence
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Real-time vendor health scores · Risk heatmap · Early warning system
          </p>
        </div>
        <button onClick={handleRecalcAll} disabled={recalcAll} style={{
          padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none',
          borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: recalcAll ? 'not-allowed' : 'pointer',
          opacity: recalcAll ? 0.7 : 1,
        }}>
          {recalcAll ? 'Recalculating…' : 'Recalculate All'}
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <SummaryCard label="Preferred Vendors"  value={cards.preferred || 0} color="#16a34a" icon="★"
          sub="Score 90–100" />
        <SummaryCard label="Approved Vendors"   value={cards.approved  || 0} color="#2563eb" icon="✓"
          sub="Score 75–89" />
        <SummaryCard label="Watchlist Vendors"  value={cards.watchlist || 0} color="#d97706" icon="⚠"
          sub="Score 50–74" />
        <SummaryCard label="Critical Vendors"   value={cards.critical  || 0} color="#dc2626" icon="✕"
          sub="Score 0–49" />
        <SummaryCard label="Avg Health Score"   value={`${cards.avg_score || 0}`} color="#6B3FDB" icon="◉"
          sub={`${cards.total || 0} vendors scored`} />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, marginBottom: 24 }}>
        {/* Pie */}
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
            Health Distribution
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={dist} dataKey="value" nameKey="name" cx="50%" cy="50%"
                outerRadius={70} label={({ name, value }) => value > 0 ? `${value}` : ''} labelLine={false}>
                {dist.map(d => (
                  <Cell key={d.name} fill={PIE_COLORS[d.name] || '#94a3b8'} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [v, n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Early warning bar */}
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
            Top At-Risk Vendors (by Health Score)
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={heatmap.slice(0, 8)} layout="vertical" margin={{ left: 80 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="vendor_name" tick={{ fontSize: 10 }}
                width={78} />
              <Tooltip formatter={(v) => [`${v.toFixed(1)}`, 'Health Score']} />
              <Bar dataKey="health_score" radius={4}>
                {heatmap.slice(0, 8).map((v, i) => (
                  <Cell key={i} fill={PIE_COLORS[v.health_status] || '#94a3b8'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #f0f0f4', marginBottom: 20 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
            padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 600,
            color: activeTab === t.key ? '#6B3FDB' : '#6b7280',
            borderBottom: activeTab === t.key ? '2px solid #6B3FDB' : '2px solid transparent',
            marginBottom: -2,
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Risk Heatmap tab ── */}
      {activeTab === 'heatmap' && (
        <div>
          {/* Filter bar */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search vendor…" style={{
                padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
                fontSize: 13, width: 220, outline: 'none',
              }} />
            {['all', 'Critical', 'Watchlist', 'Approved', 'Preferred'].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                border: filter === f ? 'none' : '1px solid #e5e7eb',
                background: filter === f
                  ? (PIE_COLORS[f] || '#6B3FDB')
                  : '#fff',
                color: filter === f ? '#fff' : '#374151',
                cursor: 'pointer',
              }}>
                {f === 'all' ? 'All' : f}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
              {filteredHeatmap.length} vendors
            </span>
          </div>

          {/* Heatmap table */}
          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['Vendor', 'Category', 'Health Score', 'Status', 'Quality', 'Delivery',
                      'Compliance', 'Dependency', 'Open NCRs', 'OTD %',
                      'Projects', 'Revenue at Risk', 'Flags'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700,
                                           color: '#6b7280', textAlign: 'left',
                                           borderBottom: '1px solid #f0f0f4',
                                           textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredHeatmap.map((v, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f8f8fc', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: '#111827',
                                   whiteSpace: 'nowrap' }}>
                        {v.vendor_name}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#6b7280' }}>
                        {CATEGORY_LABELS[v.vendor_category] || v.vendor_category || '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <ScorePill score={v.health_score} status={v.health_status} />
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <StatusBadge status={v.health_status} />
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#374151', textAlign: 'center' }}>
                        {parseFloat(v.quality_score || 0).toFixed(0)}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#374151', textAlign: 'center' }}>
                        {parseFloat(v.delivery_score || 0).toFixed(0)}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#374151', textAlign: 'center' }}>
                        {parseFloat(v.compliance_score || 0).toFixed(0)}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#374151', textAlign: 'center' }}>
                        {parseFloat(v.dependency_score || 0).toFixed(0)}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        {Number(v.open_ncr_count) > 0
                          ? <span style={{ fontWeight: 700, color: '#dc2626' }}>{v.open_ncr_count}</span>
                          : <span style={{ color: '#9ca3af' }}>0</span>}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        <span style={{
                          fontWeight: 600,
                          color: parseFloat(v.otd_pct) >= 90 ? '#16a34a'
                               : parseFloat(v.otd_pct) >= 75 ? '#d97706' : '#dc2626',
                        }}>
                          {parseFloat(v.otd_pct || 0).toFixed(1)}%
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, textAlign: 'center', color: '#6B3FDB', fontWeight: 600 }}>
                        {v.projects_impacted || 0}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: '#6B3FDB' }}>
                        {Number(v.revenue_at_risk) > 0 ? fmtINR(v.revenue_at_risk) : '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {v.is_single_source    && <span style={{ background: '#dc2626', color: '#fff', borderRadius: 4, fontSize: 9, fontWeight: 700, padding: '2px 6px' }}>SS</span>}
                          {v.is_critical_supplier && <span style={{ background: '#ea580c', color: '#fff', borderRadius: 4, fontSize: 9, fontWeight: 700, padding: '2px 6px' }}>CR</span>}
                          {v.is_long_lead        && <span style={{ background: '#d97706', color: '#fff', borderRadius: 4, fontSize: 9, fontWeight: 700, padding: '2px 6px' }}>LL</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredHeatmap.length === 0 && (
                    <tr>
                      <td colSpan={13} style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                        No vendors match the current filter. Run Recalculate All to populate scores.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
            SS = Single Source · CR = Critical Supplier · LL = Long Lead
          </div>
        </div>
      )}

      {/* ── Early Warnings tab ── */}
      {activeTab === 'warnings' && (
        <div>
          {warnings.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>✅</div>
              No active early warnings
            </div>
          ) : (
            warnings.map(w => (
              <div key={w.id} style={{
                background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10,
                padding: 16, marginBottom: 12, display: 'flex', gap: 16, alignItems: 'flex-start',
                borderLeft: `4px solid ${WARN_SEVERITY_COLOR[w.severity] || '#6b7280'}`,
              }}>
                <span style={{ fontSize: 22, flexShrink: 0 }}>
                  {w.severity === 'Critical' ? '🔴' : w.severity === 'High' ? '🟠' : '🟡'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
                      {w.vendor_name}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: WARN_SEVERITY_COLOR[w.severity],
                                   background: WARN_SEVERITY_COLOR[w.severity] + '22',
                                   padding: '2px 8px', borderRadius: 10 }}>
                      {w.severity}
                    </span>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>
                      {w.warning_type?.replace(/_/g, ' ')}
                    </span>
                    {w.health_score != null && (
                      <ScorePill score={w.health_score} status={w.health_status} />
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: '#374151' }}>{w.message}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                    {new Date(w.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                  </div>
                </div>
                <button onClick={() => acknowledgeWarning(w.id)} style={{
                  padding: '6px 14px', background: '#fff', border: '1px solid #e5e7eb',
                  borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#374151',
                  cursor: 'pointer', flexShrink: 0,
                }}>
                  Acknowledge
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── CEO Command Center tab ── */}
      {activeTab === 'ceo' && ceo && (
        <div>
          {/* CEO summary KPIs */}
          <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Scored',   value: ceo.summary?.total,         color: '#374151' },
              { label: 'Avg Score',      value: ceo.summary?.avg_score,     color: '#6B3FDB' },
              { label: 'Avg Quality',    value: ceo.summary?.avg_quality,   color: '#16a34a' },
              { label: 'Avg Delivery',   value: ceo.summary?.avg_delivery,  color: '#2563eb' },
              { label: 'Avg Compliance', value: ceo.summary?.avg_compliance, color: '#d97706' },
            ].map(k => (
              <div key={k.label} style={{
                flex: 1, minWidth: 100, background: '#fff', border: '1px solid #f0f0f4',
                borderRadius: 10, padding: '12px 16px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: k.color }}>{k.value ?? '—'}</div>
                <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600,
                              textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 }}>
                  {k.label}
                </div>
              </div>
            ))}
          </div>

          {/* 5 CEO lists */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {[
              { title: 'Highest Spend Suppliers', data: ceo.top_spend,     cols: ['vendor_name', 'total_spend', 'health_score', 'health_status'], fmtMap: { total_spend: fmtINR } },
              { title: 'Highest Risk Suppliers',  data: ceo.top_risk,      cols: ['vendor_name', 'health_score', 'health_status', 'open_ncr_count', 'otd_pct'] },
              { title: 'Most Reliable Suppliers', data: ceo.most_reliable, cols: ['vendor_name', 'health_score', 'health_status', 'otd_pct'] },
              { title: 'Most NCRs',               data: ceo.most_ncr,      cols: ['vendor_name', 'ncr_count', 'open_ncr', 'critical_ncr', 'health_status'] },
              { title: 'Most Delayed',            data: ceo.most_delayed,  cols: ['vendor_name', 'delayed_count', 'total_grns', 'otd_pct', 'health_status'] },
            ].map(list => (
              <div key={list.title} style={{
                background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, overflow: 'hidden',
              }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f4',
                              fontSize: 13, fontWeight: 700, color: '#374151' }}>
                  {list.title}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {(list.data || []).slice(0, 8).map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f8f8fc' }}>
                          <td style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600,
                                       color: '#111827', maxWidth: 160, overflow: 'hidden',
                                       textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {i + 1}. {row.vendor_name}
                          </td>
                          {list.cols.slice(1).map(col => (
                            <td key={col} style={{ padding: '8px 10px', fontSize: 12,
                                                   color: col === 'health_status' ? undefined : '#374151',
                                                   textAlign: 'right' }}>
                              {col === 'health_status'
                                ? <StatusBadge status={row[col]} />
                                : list.fmtMap?.[col]
                                  ? list.fmtMap[col](row[col])
                                  : col.includes('pct') || col === 'otd_pct'
                                    ? `${parseFloat(row[col] || 0).toFixed(1)}%`
                                    : col.includes('score')
                                      ? parseFloat(row[col] || 0).toFixed(1)
                                      : row[col] ?? '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!(list.data?.length) && (
                        <tr>
                          <td colSpan={list.cols.length} style={{ padding: 24, textAlign: 'center',
                                                                    color: '#9ca3af', fontSize: 12 }}>
                            No data available
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
