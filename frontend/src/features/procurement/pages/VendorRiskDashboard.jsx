/**
 * Phase 49C-14 — Vendor Risk Engine Dashboard
 * Computes and displays risk across 5 dimensions: Financial, Quality, Delivery, Compliance, Dependency.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  ResponsiveContainer, Legend,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const RISK_COLORS = {
  Low:      { bg: '#dcfce7', color: '#16a34a', bar: '#22c55e' },
  Medium:   { bg: '#fef3c7', color: '#d97706', bar: '#f59e0b' },
  High:     { bg: '#fee2e2', color: '#dc2626', bar: '#ef4444' },
  Critical: { bg: '#fce7f3', color: '#9d174d', bar: '#ec4899' },
};

const RISK_DIMS = ['financial_risk', 'quality_risk', 'delivery_risk', 'compliance_risk', 'dependency_risk'];
const DIM_LABELS = { financial_risk: 'Financial', quality_risk: 'Quality', delivery_risk: 'Delivery', compliance_risk: 'Compliance', dependency_risk: 'Dependency' };

function RiskBadge({ rating }) {
  const s = RISK_COLORS[rating] || RISK_COLORS.Medium;
  return <span style={{ padding: '3px 12px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: s.bg, color: s.color }}>{rating}</span>;
}

function RiskMeter({ score, label }) {
  const color = score >= 70 ? '#ec4899' : score >= 50 ? '#ef4444' : score >= 30 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: '#374151' }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{score?.toFixed(0)}%</span>
      </div>
      <div style={{ height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score || 0}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .5s' }} />
      </div>
    </div>
  );
}

export default function VendorRiskDashboard() {
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [riskData, setRiskData] = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [newAssess, setNewAssess] = useState({
    financial_risk: 0, quality_risk: 0, delivery_risk: 0, compliance_risk: 0, dependency_risk: 0, notes: '',
  });
  const [showAssessForm, setShowAssessForm] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const loadVendors = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/procurement/vendors', {
        params: { risk_rating: filter === 'all' ? undefined : filter, search: search || undefined },
      });
      setVendors(data.vendors || data || []);
    } catch { setVendors([]); }
    setLoading(false);
  }, [filter, search]);

  useEffect(() => { loadVendors(); }, [loadVendors]);

  const openVendor = async (v) => {
    setSelected(v);
    setRiskData(null);
    setShowAssessForm(false);
    setRiskLoading(true);
    try {
      const { data } = await api.get(`/vendor-approval/vendors/${v.id}/risk`);
      setRiskData(data);
    } catch { setRiskData([]); }
    setRiskLoading(false);
  };

  const computeRisk = async () => {
    if (!selected) return;
    setComputing(true);
    try {
      const { data } = await api.post(`/vendor-approval/vendors/${selected.id}/risk`, newAssess);
      setRiskData(prev => [data, ...(Array.isArray(prev) ? prev : [])]);
      setSelected(s => ({ ...s, risk_score: data.overall_risk_score, risk_rating: data.risk_rating }));
      setShowAssessForm(false);
      loadVendors();
      showToast('Risk assessment saved');
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save assessment');
    }
    setComputing(false);
  };

  // Chart data for radar
  const latestRisk = Array.isArray(riskData) && riskData[0];
  const radarData = latestRisk ? RISK_DIMS.map(d => ({
    dimension: DIM_LABELS[d],
    score: Number(latestRisk[d] || 0),
  })) : [];

  // Bar chart: vendors by risk rating
  const riskDistData = Object.entries(
    (vendors).reduce((acc, v) => {
      const r = v.risk_rating || 'Medium';
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, count]) => ({ name, count, fill: RISK_COLORS[name]?.bar || '#9ca3af' }));

  const sorted = [...vendors].sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0));
  const filtered = search
    ? sorted.filter(v => v.vendor_name?.toLowerCase().includes(search.toLowerCase()))
    : sorted;

  const critical = vendors.filter(v => v.risk_rating === 'Critical').length;
  const high     = vendors.filter(v => v.risk_rating === 'High').length;
  const singleSource = vendors.filter(v => v.is_single_source).length;

  const riskDistChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={riskDistData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {riskDistData.map((e, i) => <Cell key={i} fill={e.fill} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const radarChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <RadarChart data={radarData} margin={{ top: 8, right: 20, bottom: 8, left: 20 }}>
        <PolarGrid />
        <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 12 }} />
        <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 10 }} />
        <Radar name="Risk" dataKey="score" stroke="#6B3FDB" fill="#6B3FDB" fillOpacity={0.3} />
      </RadarChart>
    </ResponsiveContainer>
  );

  return (
    <div style={styles.root}>
      {toast && <div style={styles.toast}>{toast}</div>}

      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Vendor Risk Engine</h1>
          <p style={styles.subtitle}>5-dimension risk model: Financial · Quality · Delivery · Compliance · Dependency</p>
        </div>
      </div>

      {/* Summary cards */}
      <div style={styles.cards}>
        <StatCard index={0} label="Critical Risk" value={critical} color="#ec4899" icon="⚠" />
        <StatCard index={1} label="High Risk" value={high} color="#ef4444" icon="▲" />
        <StatCard index={2} label="Single Source" value={singleSource} color="#f59e0b" icon="⛓" />
        <StatCard index={3} label="Total Assessed" value={vendors.length} color="#6B3FDB" icon="✓" />
      </div>

      {/* Risk distribution chart */}
      {riskDistData.length > 0 && (
        <div className="dk-anim" style={{ ...styles.chartCard, '--dk-i': 4 }}>
          <div style={styles.chartHead}>
            <div style={{ ...styles.sectionTitle, marginBottom: 0 }}>Vendor Risk Distribution</div>
            <ChartExpandButton title="Vendor Risk Distribution">{riskDistChart(430)}</ChartExpandButton>
          </div>
          {riskDistChart(150)}
        </div>
      )}

      <div style={styles.layout}>
        {/* Vendor list */}
        <div style={styles.listPanel}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6' }}>
            <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={styles.search} />
            <div style={styles.filterRow}>
              {['all', 'Low', 'Medium', 'High', 'Critical'].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ ...styles.filterBtn, ...(filter === f ? styles.filterActive : {}) }}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          {loading ? <div style={styles.center}>Loading…</div> : filtered.map(v => (
            <div key={v.id} onClick={() => openVendor(v)}
              style={{ ...styles.vendorRow, ...(selected?.id === v.id ? styles.vendorRowActive : {}) }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{v.vendor_name}</span>
                <RiskBadge rating={v.risk_rating || 'Medium'} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${v.risk_score || 0}%`, height: '100%', background: RISK_COLORS[v.risk_rating || 'Medium']?.bar || '#9ca3af' }} />
                </div>
                <span style={{ fontSize: 12, color: '#6b7280', width: 30 }}>{Number(v.risk_score || 0).toFixed(0)}</span>
              </div>
              {(v.is_critical_supplier || v.is_single_source || v.is_long_lead) && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  {v.is_critical_supplier && <span style={styles.tag}>Critical</span>}
                  {v.is_single_source && <span style={{ ...styles.tag, background: '#fef3c7', color: '#92400e' }}>Single Source</span>}
                  {v.is_long_lead && <span style={{ ...styles.tag, background: '#ede9fe', color: '#6d28d9' }}>Long Lead</span>}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Detail */}
        <div style={styles.detailPanel}>
          {!selected && <div style={styles.center}>Select a vendor to view risk profile</div>}
          {selected && (
            <div>
              <div style={styles.detailHeader}>
                <div>
                  <h2 style={styles.detailName}>{selected.vendor_name}</h2>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <RiskBadge rating={selected.risk_rating || 'Medium'} />
                    <span style={{ fontSize: 13, color: '#6b7280' }}>Score: {Number(selected.risk_score || 0).toFixed(1)}/100</span>
                  </div>
                </div>
                <button onClick={() => setShowAssessForm(s => !s)} style={styles.btnPrimary}>
                  {showAssessForm ? 'Cancel' : '+ New Assessment'}
                </button>
              </div>

              {/* New Assessment Form */}
              {showAssessForm && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Manual Risk Assessment</div>
                  {RISK_DIMS.map(d => (
                    <div key={d} style={{ marginBottom: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <label style={{ fontSize: 13, color: '#374151' }}>{DIM_LABELS[d]}</label>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{newAssess[d]}</span>
                      </div>
                      <input type="range" min={0} max={100} value={newAssess[d]}
                        onChange={e => setNewAssess(p => ({ ...p, [d]: Number(e.target.value) }))}
                        style={{ width: '100%', accentColor: '#6B3FDB' }} />
                    </div>
                  ))}
                  <textarea value={newAssess.notes} onChange={e => setNewAssess(p => ({ ...p, notes: e.target.value }))}
                    placeholder="Notes…" style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, height: 64, boxSizing: 'border-box' }} />
                  <button onClick={computeRisk} disabled={computing} style={{ ...styles.btnPrimary, marginTop: 12, width: '100%' }}>
                    {computing ? 'Saving…' : 'Save Assessment'}
                  </button>
                </div>
              )}

              {riskLoading && <div style={styles.center}>Loading risk data…</div>}

              {/* Radar chart */}
              {latestRisk && radarData.length > 0 && (
                <div style={styles.section}>
                  <div style={styles.chartHead}>
                    <div style={{ ...styles.sectionTitle, marginBottom: 0 }}>Risk Profile — {new Date(latestRisk.assessment_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>
                    <ChartExpandButton title="Risk Profile" subtitle={selected.vendor_name}>{radarChart(430)}</ChartExpandButton>
                  </div>
                  {radarChart(215)}
                  <div>
                    {RISK_DIMS.map(d => (
                      <RiskMeter key={d} label={DIM_LABELS[d]} score={Number(latestRisk[d] || 0)} />
                    ))}
                  </div>
                </div>
              )}

              {/* History */}
              {Array.isArray(riskData) && riskData.length > 0 && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Assessment History</div>
                  {riskData.map((r, i) => (
                    <div key={r.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontSize: 13, color: '#374151' }}>{new Date(r.assessment_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, color: '#374151' }}>{Number(r.overall_risk_score || 0).toFixed(1)}</span>
                        <RiskBadge rating={r.risk_rating} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* NCR info */}
              {latestRisk?.ncr_count_12m > 0 && (
                <div style={{ ...styles.section, background: '#fef2f2', borderColor: '#fecaca' }}>
                  <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 600 }}>
                    ⚠ {latestRisk.ncr_count_12m} NCR(s) in last 12 months · {latestRisk.late_delivery_pct?.toFixed(1)}% late deliveries
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color, icon, index = 0 }) {
  return (
    <div className="dk-anim" style={{ background: '#fff', borderRadius: 10, padding: '11px 14px', border: '1px solid #e5e7eb', flex: 1, '--dk-i': index }}>
      <div style={{ fontSize: 21, marginBottom: 2 }}>{icon}</div>
      <div style={{ fontSize: 23, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12.5, color: '#6b7280' }}>{label}</div>
    </div>
  );
}

const styles = {
  root: { minHeight: '100vh', background: '#f3f4f6', fontFamily: 'system-ui, sans-serif' },
  header: { background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '13px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 },
  subtitle: { color: '#6b7280', fontSize: 12.5, marginTop: 3 },
  cards: { display: 'flex', gap: 10, padding: '12px 18px' },
  chartCard: { background: '#fff', borderRadius: 10, margin: '0 18px 12px', padding: '13px 15px', border: '1px solid #e5e7eb' },
  chartHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 },
  layout: { display: 'flex', height: 'calc(100vh - 285px)', minHeight: 320, overflow: 'hidden', margin: '0 18px', gap: 12 },
  listPanel: { width: 300, background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', overflowY: 'auto', flexShrink: 0 },
  detailPanel: { flex: 1, overflowY: 'auto', background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', padding: 14 },
  search: { width: '100%', padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', marginBottom: 8 },
  filterRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  filterBtn: { padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 12, fontSize: 12, cursor: 'pointer', background: '#f3f4f6', color: '#374151' },
  filterActive: { background: '#ede9fe', color: '#6d28d9', borderColor: '#6B3FDB' },
  vendorRow: { padding: '10px 14px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
  vendorRowActive: { background: '#f5f3ff' },
  tag: { padding: '1px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: '#fee2e2', color: '#dc2626' },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  detailName: { fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 },
  section: { background: '#f9fafb', borderRadius: 8, padding: '11px 13px', marginBottom: 10, border: '1px solid #e5e7eb' },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 9 },
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#9ca3af', fontSize: 14 },
  btnPrimary: { padding: '8px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13 },
  toast: { position: 'fixed', bottom: 24, right: 24, background: '#111827', color: '#fff', padding: '12px 20px', borderRadius: 8, zIndex: 2000, fontSize: 14 },
};
