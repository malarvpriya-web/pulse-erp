import { useState, useEffect, useCallback, useRef } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import { RefreshCw, Download, Zap, Activity, TrendingUp, CheckCircle, AlertTriangle, Wrench } from 'lucide-react';
import api from '@/services/api/client';

/* ── palette ── */
const P     = '#6B3FDB';
const LIGHT = '#f5f3ff';
const BD    = '#e9e4ff';
const CARD  = { background: '#fff', border: `1px solid ${BD}`, borderRadius: 12, padding: '18px 20px' };

const BAND_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'];
const LINE_COLORS = { thd_i: '#ef4444', thd_v: '#f59e0b', avg_pf: '#10b981', min_pf: '#94a3b8', max_pf: '#3b82f6' };

/* ── helpers ── */
const pct  = (n) => (n == null || isNaN(n) ? '—' : `${Number(n).toFixed(1)}%`);
const fix2 = (n) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2));
const fix3 = (n) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(3));

function KpiCard({ icon: Icon, label, value, color = P, sub }) {
  return (
    <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 46, height: 46, borderRadius: 11, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={20} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#111827', lineHeight: 1 }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function SectionCard({ title, sub, children, action }) {
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{title}</div>
          {sub && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Empty({ height = 180, msg = 'No data yet — run tests to populate analytics' }) {
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d1d5db', fontSize: 12, textAlign: 'center', flexDirection: 'column', gap: 6 }}>
      <Activity size={28} color="#e5e7eb" />
      {msg}
    </div>
  );
}

/* ── component ── */
export default function PowerQualityAnalytics() {
  const [loading,    setLoading]    = useState(false);
  const [kpis,       setKpis]       = useState(null);
  const [thdTrend,   setThdTrend]   = useState([]);
  const [pfData,     setPfData]     = useState({ trend: [], bands: [] });
  const [productKpis,setProductKpis]= useState([]);
  const [harmonics,  setHarmonics]  = useState([]);
  const [maint,      setMaint]      = useState(null);
  const [lastSync,   setLastSync]   = useState(null);
  const [exporting,  setExporting]  = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [k, thd, pf, prod, harm, m] = await Promise.allSettled([
      api.get('/analytics/pq/kpis'),
      api.get('/analytics/pq/thd-trend'),
      api.get('/analytics/pq/power-factor'),
      api.get('/analytics/pq/product-kpis'),
      api.get('/analytics/pq/harmonics'),
      api.get('/analytics/pq/maintenance'),
    ]);

    if (!isMounted.current) return;

    if (k.status   === 'fulfilled') setKpis(k.value?.data ?? k.value);
    if (thd.status === 'fulfilled') setThdTrend(Array.isArray(thd.value?.data ?? thd.value) ? (thd.value?.data ?? thd.value) : []);
    if (pf.status  === 'fulfilled') {
      const d = pf.value?.data ?? pf.value ?? {};
      setPfData({ trend: Array.isArray(d.trend) ? d.trend : [], bands: Array.isArray(d.bands) ? d.bands : [] });
    }
    if (prod.status === 'fulfilled') setProductKpis(Array.isArray(prod.value?.data ?? prod.value) ? (prod.value?.data ?? prod.value) : []);
    if (harm.status === 'fulfilled') setHarmonics(Array.isArray(harm.value?.data ?? harm.value) ? (harm.value?.data ?? harm.value) : []);
    if (m.status    === 'fulfilled') setMaint(m.value?.data ?? m.value ?? null);

    setLastSync(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ── CSV export ── */
  const handleExport = async (days = 90) => {
    setExporting(true);
    try {
      const res = await api.get(`/analytics/pq/export?days=${days}&format=csv`, { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href     = url;
      link.download = `pq-report-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      /* silent — export is best-effort */
    }
    setExporting(false);
  };

  const totalDone = (kpis?.passed ?? 0) + (kpis?.failed ?? 0);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Power Quality Analytics</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            THD · Power Factor · SST/HVDC Test KPIs · Maintenance
            {lastSync && <span style={{ marginLeft: 8, color: '#d1d5db' }}>· Synced {lastSync}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => handleExport(90)}
            disabled={exporting}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#fff', border: `1px solid ${BD}`, borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 600 }}
          >
            <Download size={14} />{exporting ? 'Exporting…' : 'Export CSV (90d)'}
          </button>
          <button
            onClick={load}
            disabled={loading}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: P, border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#fff', fontWeight: 600 }}
          >
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── KPI Strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiCard icon={CheckCircle} label="Total Tests (12M)"  value={loading ? '—' : (kpis?.total_tests ?? 0)}         color="#6B3FDB" />
        <KpiCard icon={TrendingUp}  label="First-Pass Rate"    value={loading ? '—' : pct(kpis?.first_pass_rate)}       color="#10b981" sub={`${kpis?.passed ?? 0} passed / ${kpis?.failed ?? 0} failed`} />
        <KpiCard icon={Zap}         label="Avg THD-I"          value={loading ? '—' : `${fix2(kpis?.avg_thd_i)} %`}    color="#ef4444" sub="Current harmonic distortion" />
        <KpiCard icon={Zap}         label="Avg THD-V"          value={loading ? '—' : `${fix2(kpis?.avg_thd_v)} %`}    color="#f59e0b" sub="Voltage harmonic distortion" />
        <KpiCard icon={Activity}    label="Avg Power Factor"   value={loading ? '—' : fix3(kpis?.avg_pf)}              color="#3b82f6" sub="Unity = 1.000" />
        <KpiCard icon={Wrench}      label="Open Breakdowns"    value={loading ? '—' : (maint?.open_breakdowns ?? 0)}    color="#ef4444" sub={`MTTR: ${fix2(maint?.mttr_hrs)} h`} />
      </div>

      {/* ── Row 1: THD Trend | Power Factor Trend ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <SectionCard title="THD Trend (6 Months)" sub="Monthly average THD-I and THD-V (%)">
          {thdTrend.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={thdTrend} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} unit="%" />
                  <Tooltip formatter={(v, n) => [`${Number(v).toFixed(2)}%`, n === 'thd_i' ? 'THD-I' : 'THD-V']} contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${BD}` }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="thd_i" stroke={LINE_COLORS.thd_i} strokeWidth={2} dot={{ r: 3 }} name="THD-I" />
                  <Line type="monotone" dataKey="thd_v" stroke={LINE_COLORS.thd_v} strokeWidth={2} dot={{ r: 3 }} name="THD-V" />
                </LineChart>
              </ResponsiveContainer>
            )}
        </SectionCard>

        <SectionCard title="Power Factor Trend (6 Months)" sub="Monthly avg / min / max PF">
          {pfData.trend.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={pfData.trend} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0.8, 1.0]} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v, n) => [Number(v).toFixed(3), n === 'avg_pf' ? 'Avg PF' : n === 'min_pf' ? 'Min PF' : 'Max PF']} contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${BD}` }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="avg_pf" stroke={LINE_COLORS.avg_pf} strokeWidth={2.5} dot={{ r: 3 }} name="Avg PF" />
                  <Line type="monotone" dataKey="min_pf" stroke={LINE_COLORS.min_pf} strokeWidth={1.5} strokeDasharray="4 2" dot={false} name="Min PF" />
                  <Line type="monotone" dataKey="max_pf" stroke={LINE_COLORS.max_pf} strokeWidth={1.5} strokeDasharray="4 2" dot={false} name="Max PF" />
                </LineChart>
              </ResponsiveContainer>
            )}
        </SectionCard>
      </div>

      {/* ── Row 2: PF Bands | Harmonics Failure Table ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <SectionCard title="Power Factor Distribution (12M)" sub="Count of tests by PF band">
          {pfData.bands.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={pfData.bands} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="band" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${BD}` }} />
                  <Bar dataKey="count" name="Tests" radius={[5, 5, 0, 0]}>
                    {pfData.bands.map((_, i) => <Cell key={i} fill={BAND_COLORS[i % BAND_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </SectionCard>

        <SectionCard title="Harmonic Parameter Failures (12M)" sub="By parameter code — pass vs. fail">
          {harmonics.length === 0
            ? <Empty />
            : (
              <div style={{ overflow: 'auto', maxHeight: 200 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: `2px solid ${BD}`, color: '#6b7280', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px', fontWeight: 600 }}>Parameter</th>
                      <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Total</th>
                      <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Failures</th>
                      <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Fail Rate</th>
                      <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Avg Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {harmonics.map((h, i) => {
                      const critical = h.failure_rate > 20;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid #f3f4f6`, background: critical ? '#fff5f5' : 'transparent' }}>
                          <td style={{ padding: '7px 8px', fontWeight: 600, color: '#374151' }}>
                            <span style={{ fontFamily: 'monospace', background: LIGHT, padding: '1px 6px', borderRadius: 4 }}>{h.parameter_code}</span>
                            <span style={{ marginLeft: 6, color: '#6b7280', fontWeight: 400 }}>{h.parameter_name}</span>
                          </td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: '#374151' }}>{h.total}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: h.failures > 0 ? '#dc2626' : '#374151', fontWeight: h.failures > 0 ? 700 : 400 }}>{h.failures}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right' }}>
                            <span style={{ color: critical ? '#dc2626' : h.failure_rate > 5 ? '#d97706' : '#16a34a', fontWeight: 700 }}>{pct(h.failure_rate)}</span>
                          </td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: '#6b7280', fontFamily: 'monospace' }}>{fix3(h.avg_value)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </SectionCard>
      </div>

      {/* ── Row 3: Product KPIs bar chart ── */}
      <SectionCard
        title="SST / HVDC Product KPIs (12 Months)"
        sub="First-pass rate and avg THD-I per product type"
        action={
          <span style={{ fontSize: 11, color: '#9ca3af', background: LIGHT, padding: '3px 8px', borderRadius: 6 }}>
            Top {productKpis.length} products
          </span>
        }
      >
        {productKpis.length === 0
          ? <Empty msg="No product test data yet" />
          : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>First-Pass Rate (%)</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={productKpis} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" />
                    <YAxis type="category" dataKey="product" width={120} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => [`${Number(v).toFixed(1)}%`, 'Pass Rate']} contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${BD}` }} />
                    <Bar dataKey="pass_rate" fill={P} radius={[0, 4, 4, 0]} name="Pass Rate" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>Avg THD-I (%)</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={productKpis} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} unit="%" />
                    <YAxis type="category" dataKey="product" width={120} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => [`${Number(v).toFixed(2)}%`, 'Avg THD-I']} contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${BD}` }} />
                    <Bar dataKey="avg_thd_i" fill="#ef4444" radius={[0, 4, 4, 0]} name="Avg THD-I" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
      </SectionCard>

      {/* ── Row 4: Maintenance KPIs ── */}
      {maint && (
        <div style={{ marginTop: 16, ...CARD }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wrench size={15} color={P} /> Maintenance KPIs (Live)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Assets Due (7 days)', value: maint.assets_due,      color: '#d97706', bg: '#fef3c7' },
              { label: 'Open Breakdowns',     value: maint.open_breakdowns,  color: '#dc2626', bg: '#fee2e2' },
              { label: 'MTTR (hrs)',           value: `${fix2(maint.mttr_hrs)} h`, color: '#6B3FDB', bg: LIGHT },
              { label: 'Maintenance Cost MTD', value: maint.cost_mtd > 0 ? `₹${Math.round(maint.cost_mtd).toLocaleString('en-IN')}` : '₹0', color: '#2563eb', bg: '#dbeafe' },
            ].map(({ label, value, color, bg }) => (
              <div key={label} style={{ padding: '12px 14px', background: bg, borderRadius: 10, textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color }}>{loading ? '—' : value}</div>
                <div style={{ fontSize: 11, color: '#374151', fontWeight: 600, marginTop: 3 }}>{label}</div>
              </div>
            ))}
          </div>
          {maint.open_breakdowns > 0 && (
            <div style={{ marginTop: 12, background: '#fee2e2', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#991b1b' }}>
              <AlertTriangle size={14} />
              {maint.open_breakdowns} open breakdown{maint.open_breakdowns > 1 ? 's' : ''} requiring attention — check Asset Maintenance for details.
            </div>
          )}
        </div>
      )}

      {/* ── Product detail table ── */}
      {productKpis.length > 0 && (
        <div style={{ marginTop: 16, ...CARD }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 14 }}>Detailed Product KPI Table</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${BD}`, color: '#6b7280', textAlign: 'right' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Product</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Total</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Passed</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Pass Rate</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Avg THD-I (%)</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Avg THD-V (%)</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Avg PF</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Avg P-Out (kW)</th>
                </tr>
              </thead>
              <tbody>
                {productKpis.map((p, i) => {
                  const rateColor = p.pass_rate >= 95 ? '#16a34a' : p.pass_rate >= 80 ? '#d97706' : '#dc2626';
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '9px 10px', fontWeight: 600, color: '#374151' }}>{p.product}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', color: '#374151' }}>{p.total}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>{p.passed}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', color: rateColor, fontWeight: 700 }}>{pct(p.pass_rate)}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace', color: p.avg_thd_i > 5 ? '#dc2626' : '#374151' }}>{fix2(p.avg_thd_i)}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace', color: p.avg_thd_v > 8 ? '#dc2626' : '#374151' }}>{fix2(p.avg_thd_v)}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace', color: p.avg_pf < 0.95 ? '#d97706' : '#16a34a', fontWeight: 600 }}>{fix3(p.avg_pf)}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace' }}>{fix2(p.avg_p_out)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
