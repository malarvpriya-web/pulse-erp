/**
 * Phase 49C-21 — Vendor Module Dashboard
 * Main command centre: KPI cards, charts, quick nav, CEO traceability search.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line, Legend,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const RISK_COLORS = { Low: '#22c55e', Medium: '#f59e0b', High: '#ef4444', Critical: '#ec4899' };
const CLASS_COLORS = { Preferred: '#6B3FDB', Approved: '#3b82f6', Watchlist: '#f59e0b', Blocked: '#ef4444' };

function KPICard({ label, value, sub, color = '#6B3FDB', icon, index = 0 }) {
  return (
    <div className="dk-anim" style={{ ...styles.kpiCard, '--dk-i': index }}>
      <div style={{ fontSize: 21, marginBottom: 3 }}>{icon}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value ?? '—'}</div>
      <div style={{ fontSize: 12.5, color: '#374151', fontWeight: 600, marginTop: 3 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

export default function VendorDashboard({ setPage }) {
  const [stats, setStats] = useState(null);
  const [charts, setCharts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [traceQuery, setTraceQuery] = useState('');
  const [traceResult, setTraceResult] = useState(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState('');
  const [topVendors, setTopVendors] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, chartsRes, topRes] = await Promise.allSettled([
        api.get('/vendor-approval/dashboard/stats'),
        api.get('/vendor-approval/dashboard/charts'),
        api.get('/vendor-portal/scorecards/top'),
      ]);
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data);
      if (chartsRes.status === 'fulfilled') setCharts(chartsRes.value.data);
      if (topRes.status === 'fulfilled') setTopVendors(topRes.value.data || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runTraceability = async () => {
    if (!traceQuery.trim()) return;
    setTraceLoading(true);
    setTraceError('');
    setTraceResult(null);
    try {
      // Search vendor by name first
      const { data: vendorData } = await api.get('/procurement/vendors', { params: { search: traceQuery, limit: 1 } });
      const vendor = (vendorData.vendors || vendorData)[0];
      if (!vendor) { setTraceError(`No vendor found matching "${traceQuery}"`); setTraceLoading(false); return; }
      const { data } = await api.get(`/vendor-approval/vendors/${vendor.id}/traceability`);
      setTraceResult(data);
    } catch (err) {
      setTraceError(err.response?.data?.error || 'Traceability lookup failed');
    }
    setTraceLoading(false);
  };

  const nav = (page) => setPage && setPage(page);

  const distChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={charts.vendor_distribution.slice(0, 10)} layout="vertical" margin={{ left: 80, right: 16 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="category" tick={{ fontSize: 11 }} width={80} />
        <Tooltip />
        <Bar dataKey="count" fill="#6B3FDB" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );

  const riskChart = (h, inner, outer) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie data={charts.risk_distribution} dataKey="count" nameKey="risk_rating" cx="50%" cy="50%" innerRadius={inner} outerRadius={outer} paddingAngle={3}>
          {charts.risk_distribution.map((e, i) => (
            <Cell key={i} fill={RISK_COLORS[e.risk_rating] || '#9ca3af'} />
          ))}
        </Pie>
        <Tooltip formatter={(v, n) => [v, n]} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Vendor Management</h1>
          <p style={styles.subtitle}>Registration · Approval · Scorecard · Risk · Traceability</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => nav('VendorApprovalQueue')} style={styles.btnPrimary}>Approval Queue</button>
          <button onClick={() => nav('VendorManagement')} style={styles.btnSecondary}>All Vendors</button>
        </div>
      </div>

      {/* KPI cards */}
      <div style={styles.kpiRow}>
        <KPICard index={0} label="Total Vendors"       value={stats?.total_vendors}       icon="🏭" color="#6B3FDB" />
        <KPICard index={1} label="Pending Approvals"   value={stats?.pending_approvals}   icon="⏳" color="#d97706" sub="awaiting review" />
        <KPICard index={2} label="Preferred Vendors"   value={stats?.preferred_vendors}   icon="⭐" color="#16a34a" />
        <KPICard index={3} label="Blocked Vendors"     value={stats?.blocked_vendors}     icon="🚫" color="#dc2626" />
        <KPICard index={4} label="High Risk Vendors"   value={stats?.high_risk_vendors}   icon="⚠" color="#ef4444" />
        <KPICard index={5} label="Open Vendor NCR"     value={stats?.open_vendor_ncr}     icon="📋" color="#8b5cf6" />
      </div>

      {/* Quick nav tiles */}
      <div style={styles.navGrid}>
        {[
          { page: 'VendorApprovalQueue', label: 'Approval Queue',    icon: '✅', color: '#3b82f6', desc: 'SCM → Quality → Finance → Mgmt' },
          { page: 'VendorRiskDashboard', label: 'Risk Engine',        icon: '🔴', color: '#ef4444', desc: '5-dimension risk model' },
          { page: 'VendorScorecard',     label: 'Vendor Scorecard',   icon: '📊', color: '#8b5cf6', desc: 'Quality · Delivery · Cost' },
          { page: 'VendorManagement',    label: 'Vendor Master',      icon: '🏭', color: '#6B3FDB', desc: 'Contacts · Documents · Banks' },
          { page: 'Vendor360',           label: 'Vendor 360°',         icon: '🔭', color: '#10b981', desc: 'Full vendor intelligence' },
          { page: 'ProcurementReports',  label: 'Reports',            icon: '📄', color: '#f59e0b', desc: 'NCR · CAPA · Master · Risk' },
        ].map(item => (
          <div key={item.page} onClick={() => nav(item.page)} style={styles.navTile}>
            <div style={{ fontSize: 24, marginBottom: 5 }}>{item.icon}</div>
            <div style={{ fontWeight: 700, color: item.color, fontSize: 14, marginBottom: 2 }}>{item.label}</div>
            <div style={{ fontSize: 11.5, color: '#6b7280' }}>{item.desc}</div>
          </div>
        ))}
      </div>

      <div style={styles.chartRow}>
        {/* Vendor distribution by type */}
        {charts?.vendor_distribution?.length > 0 && (
          <div className="dk-anim" style={{ ...styles.chartCard, '--dk-i': 6 }}>
            <div style={styles.chartHead}>
              <div style={{ ...styles.sectionTitle, marginBottom: 0 }}>Vendor Distribution by Type</div>
              <ChartExpandButton title="Vendor Distribution by Type">{distChart(430)}</ChartExpandButton>
            </div>
            {distChart(185)}
          </div>
        )}

        {/* Risk distribution pie */}
        {charts?.risk_distribution?.length > 0 && (
          <div className="dk-anim" style={{ ...styles.chartCard, '--dk-i': 7 }}>
            <div style={styles.chartHead}>
              <div style={{ ...styles.sectionTitle, marginBottom: 0 }}>Risk Distribution</div>
              <ChartExpandButton title="Risk Distribution">{riskChart(430, 105, 165)}</ChartExpandButton>
            </div>
            {riskChart(185, 46, 74)}
          </div>
        )}

        {/* Top vendors scorecard */}
        {topVendors.length > 0 && (
          <div className="dk-anim" style={{ ...styles.chartCard, '--dk-i': 8 }}>
            <div style={styles.sectionTitle}>Top Vendors by Score</div>
            <div style={{ overflowY: 'auto', maxHeight: 185 }}>
              {topVendors.slice(0, 8).map((v, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ fontSize: 13, color: '#6B3FDB', fontWeight: 700, width: 20 }}>#{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{v.vendor_name}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>{v.category}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#16a34a' }}>{Number(v.avg_score).toFixed(0)}</div>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>score</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── CEO Traceability (49C-25) ─────────────────────────────────────── */}
      <div style={styles.traceCard}>
        <div style={styles.sectionTitle}>CEO Traceability</div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          Search any vendor to instantly answer: Who approved? Which projects? How much spend? NCRs? Payments outstanding?
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <input value={traceQuery} onChange={e => setTraceQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runTraceability()}
            placeholder="Enter vendor name…" style={styles.traceInput} />
          <button onClick={runTraceability} disabled={traceLoading} style={styles.btnPrimary}>
            {traceLoading ? '…' : 'Trace'}
          </button>
        </div>
        {traceError && <div style={styles.errorBox}>{traceError}</div>}
        {traceResult && <TraceabilityResult data={traceResult} />}
      </div>
    </div>
  );
}

function TraceabilityResult({ data }) {
  const { vendor, spend, ncr, capa, scorecard, risk, projects, payments, traceability_score } = data;

  const isPass = traceability_score === 'PASS';
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>{vendor?.vendor_name}</h3>
        <span style={{ padding: '3px 12px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: isPass ? '#dcfce7' : '#fee2e2', color: isPass ? '#16a34a' : '#dc2626' }}>
          {traceability_score}
        </span>
      </div>

      <div style={styles.traceGrid}>
        <TraceBox label="Approved By" value={vendor?.approved_by ? `User #${vendor.approved_by}` : '—'} icon="✅" />
        <TraceBox label="Approval Date" value={vendor?.approved_at ? new Date(vendor.approved_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'} icon="📅" />
        <TraceBox label="Total Spend" value={spend?.total ? `₹${Number(spend.total).toLocaleString('en-IN')}` : '₹0'} icon="💰" sub={`${spend?.po_count || 0} POs`} />
        <TraceBox label="NCR Count" value={ncr?.count || 0} icon="📋" sub={`${ncr?.open || 0} open`} bad={ncr?.count > 0} />
        <TraceBox label="CAPA Count" value={capa?.count || 0} icon="🔧" sub={`${capa?.open || 0} open`} bad={capa?.open > 0} />
        <TraceBox label="Quality Score" value={scorecard ? `${Number(scorecard.quality_score).toFixed(0)}/100` : '—'} icon="⭐" />
        <TraceBox label="Delivery Score" value={scorecard ? `${Number(scorecard.delivery_score).toFixed(0)}/100` : '—'} icon="🚚" />
        <TraceBox label="Outstanding Payments" value={payments?.outstanding_amount ? `₹${Number(payments.outstanding_amount).toLocaleString('en-IN')}` : '₹0'} icon="⏳" bad={Number(payments?.outstanding_amount || 0) > 0} />
        <TraceBox label="Risk Rating" value={risk?.risk_rating || vendor?.risk_rating || '—'} icon="⚠" bad={['High', 'Critical'].includes(risk?.risk_rating)} />
        <TraceBox label="Classification" value={vendor?.classification || '—'} icon="🏷" />
      </div>

      {projects?.length > 0 && (
        <div style={styles.traceProjects}>
          <div style={{ fontWeight: 600, color: '#374151', marginBottom: 8, fontSize: 13 }}>Projects ({projects.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {projects.map((p, i) => (
              <span key={i} style={{ padding: '3px 10px', background: '#eff6ff', color: '#1d4ed8', borderRadius: 6, fontSize: 12 }}>
                {p.project_number || `P-${p.id}`} · {p.project_name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TraceBox({ label, value, icon, sub, bad }) {
  return (
    <div style={{ ...styles.traceBox, ...(bad ? { borderColor: '#fecaca', background: '#fef2f2' } : {}) }}>
      <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: bad ? '#dc2626' : '#111827' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</div>}
    </div>
  );
}

const styles = {
  root: { minHeight: '100vh', background: '#f3f4f6', fontFamily: 'system-ui, sans-serif', paddingBottom: 20 },
  header: { background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '13px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 },
  subtitle: { color: '#6b7280', fontSize: 12.5, marginTop: 3 },
  kpiRow: { display: 'flex', gap: 10, padding: '14px 18px 12px', flexWrap: 'wrap' },
  kpiCard: { flex: '1 1 140px', background: '#fff', borderRadius: 10, padding: '11px 13px', border: '1px solid #e5e7eb', minWidth: 140 },
  navGrid: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, padding: '0 18px 12px' },
  navTile: { background: '#fff', borderRadius: 10, padding: '12px', border: '1px solid #e5e7eb', cursor: 'pointer', textAlign: 'center', transition: 'box-shadow .2s, transform .15s' },
  chartRow: { display: 'flex', gap: 12, padding: '0 18px 12px', flexWrap: 'wrap' },
  chartCard: { flex: '1 1 280px', background: '#fff', borderRadius: 10, padding: '13px 15px', border: '1px solid #e5e7eb' },
  chartHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 9 },
  traceCard: { background: '#fff', borderRadius: 10, margin: '0 18px', padding: '14px 16px', border: '1px solid #e5e7eb' },
  traceInput: { flex: 1, padding: '9px 13px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 },
  traceGrid: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 9, marginBottom: 12 },
  traceBox: { background: '#f9fafb', borderRadius: 8, padding: '9px', border: '1px solid #e5e7eb', textAlign: 'center' },
  traceProjects: { background: '#f9fafb', borderRadius: 8, padding: '10px 14px', border: '1px solid #e5e7eb' },
  btnPrimary: { padding: '8px 17px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13.5 },
  btnSecondary: { padding: '8px 17px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13.5 },
  errorBox: { marginTop: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '10px 14px', color: '#dc2626', fontSize: 14 },
};
