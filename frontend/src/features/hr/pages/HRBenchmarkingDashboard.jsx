import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import '@/components/dashboard/dashkit.css';

// ─── Shared primitives ────────────────────────────────────────────────────────

const PURPLE = '#6B3FDB';
const GREEN  = '#059669';
const AMBER  = '#d97706';
const RED    = '#dc2626';
const BLUE   = '#2563eb';
const TEAL   = '#0891b2';
const PINK   = '#db2777';

function Section({ title, icon, children, accent = PURPLE }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 }}>
        <span style={{ fontSize: 17 }}>{icon}</span>
        <h2 style={{ margin: 0, fontSize: 14.5, fontWeight: 800, color: '#111827' }}>{title}</h2>
        <div style={{ flex: 1, height: 1, background: '#e5e7eb', marginLeft: 8 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

function MetricCard({ label, value, unit = '', benchmark, benchmarkLabel, trend, accent = PURPLE, sub, loading, na, index = 0 }) {
  const numVal  = parseFloat(value) || 0;
  const numBench = parseFloat(benchmark);
  const isGood = benchmark == null ? null
    : trend === 'lower-is-better' ? numVal <= numBench
    : numVal >= numBench;
  const statusColor = benchmark == null || na ? '#6b7280'
    : isGood ? GREEN : numVal >= numBench * 0.85 ? AMBER : RED;

  return (
    <div className="dk-anim" style={{ background: '#fff', border: `1px solid #e5e7eb`, borderRadius: 11, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4, position: 'relative', overflow: 'hidden', '--dk-i': index }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: 3, height: '100%', background: accent, borderRadius: '11px 0 0 11px' }} />
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500, paddingLeft: 4 }}>{label}</div>
      {loading
        ? <div style={{ height: 27, width: 90, background: '#f3f4f6', borderRadius: 6 }} />
        : na
          ? <div style={{ fontSize: 20, fontWeight: 800, color: '#9ca3af', paddingLeft: 4 }}>N/A</div>
          : <div style={{ fontSize: 24, fontWeight: 800, color: accent, paddingLeft: 4 }}>
              {numVal > 0 ? (unit === '₹' ? `₹${numVal.toLocaleString('en-IN')}` : `${value}${unit}`) : '—'}
            </div>
      }
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', paddingLeft: 4 }}>{sub}</div>}
      {benchmark != null && !na && !loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>
            {isGood ? 'On target' : 'Below target'} — benchmark: {benchmarkLabel || benchmark}{unit}
          </span>
        </div>
      )}
    </div>
  );
}

function DistributionBar({ data = [], loading }) {
  const total = data.reduce((s, d) => s + (d.count || 0), 0);
  const BAND_COLORS = {
    Exceptional: GREEN,
    Exceeds:     BLUE,
    Meets:       PURPLE,
    Below:       AMBER,
    PIP:         RED,
  };
  if (loading) return <div style={{ height: 80, background: '#f3f4f6', borderRadius: 8 }} />;
  if (!total) return <div style={{ color: '#9ca3af', fontSize: 13, padding: '12px 0' }}>No appraisal data for last 12 months</div>;
  return (
    <div>
      <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', marginBottom: 10 }}>
        {data.map((d, i) => (
          <div key={i} title={`${d.band}: ${d.count}`}
            style={{ width: `${(d.count / total) * 100}%`, background: BAND_COLORS[d.band] || '#9ca3af', transition: 'width 0.4s ease' }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: BAND_COLORS[d.band] || '#9ca3af', flexShrink: 0 }} />
            <span style={{ color: '#374151' }}>{d.band}</span>
            <span style={{ color: '#6b7280' }}>({d.count}, {total > 0 ? Math.round((d.count / total) * 100) : 0}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GenderBar({ femalePct, malePct, femaleLabel = 'Female', maleLabel = 'Male', loading }) {
  if (loading) return <div style={{ height: 40, background: '#f3f4f6', borderRadius: 8 }} />;
  const f = parseFloat(femalePct) || 0;
  const m = parseFloat(malePct) || 0;
  if (!f && !m) return <div style={{ color: '#9ca3af', fontSize: 13 }}>No gender data available</div>;
  return (
    <div>
      <div style={{ display: 'flex', height: 20, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ width: `${f}%`, background: PINK, transition: 'width 0.4s' }} />
        <div style={{ width: `${m}%`, background: BLUE, transition: 'width 0.4s' }} />
        <div style={{ flex: 1, background: '#e5e7eb' }} />
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: PINK }} />
          <span style={{ color: '#374151' }}>{femaleLabel} {f}%</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: BLUE }} />
          <span style={{ color: '#374151' }}>{maleLabel} {m}%</span>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children, span }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20,
      gridColumn: span ? `span ${span}` : undefined,
    }}>
      {title && <div style={{ fontWeight: 700, fontSize: 13, color: '#374151', marginBottom: 14 }}>{title}</div>}
      {children}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function HRBenchmarkingDashboard() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/analytics/hr-benchmarks', { signal: ctrl.signal });
      setData(res.data?.data || res.data);
    } catch (e) {
      if (e.name !== 'AbortError') setError('Failed to load benchmarking data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const R  = data?.recruitment   || {};
  const P  = data?.performance   || {};
  const RT = data?.retention     || {};
  const C  = data?.compensation  || {};
  const D  = data?.diversity     || {};

  const fmt = v => v != null && v !== 0 ? v : null;

  return (
    <div style={{ padding: '16px 18px 20px', background: '#f8f9fc', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827' }}>HR Benchmarking Dashboard</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Recruitment · Performance · Retention · Compensation · Diversity — live metrics vs industry benchmarks
          </p>
        </div>
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', color: '#991b1b', fontSize: 13, marginBottom: 20 }}>{error}</div>
      )}

      {/* ── 1. Recruitment & Hiring ───────────────────────────────────────── */}
      <Section title="Recruitment & Hiring Metrics" icon="🎯" accent={PURPLE}>
        <MetricCard
          label="Avg Days to Hire"
          value={fmt(R.avgDaysToHire)}
          unit=" days"
          benchmark={30}
          trend="lower-is-better"
          accent={PURPLE}
          sub="Candidate application → joining"
          loading={loading}
        />
        <MetricCard
          label="Time to Fill"
          value={R.timeToFill > 0 ? R.timeToFill : null}
          unit=" days"
          benchmark={45}
          trend="lower-is-better"
          accent={PURPLE}
          sub="Job opening → offer extended"
          loading={loading}
          na={!R.timeToFill}
        />
        <MetricCard
          label="Offer Acceptance Rate"
          value={R.offerAcceptanceRate}
          unit="%"
          benchmark={70}
          trend="higher-is-better"
          accent={GREEN}
          sub={`${R.totalAccepted || 0} accepted of ${R.totalOffered || 0} offers`}
          loading={loading}
        />
        <MetricCard
          label="Offer Exception Rate"
          value={R.offerExceptionRate}
          unit="%"
          benchmark={15}
          trend="lower-is-better"
          accent={AMBER}
          sub={`${R.totalDeclined || 0} declined / exceptions`}
          loading={loading}
        />
        <MetricCard
          label="Cost per Hire"
          value={R.costPerHire > 0 ? R.costPerHire : null}
          unit=""
          accent={TEAL}
          sub="From recruitment cost records"
          loading={loading}
          na={!R.costPerHire}
        />
      </Section>

      {/* ── 2. Performance & Productivity ────────────────────────────────── */}
      <Section title="Employee Performance & Productivity" icon="📈" accent={BLUE}>
        <MetricCard
          label="Revenue per Employee"
          value={P.revenuePerEmployee > 0 ? Math.round(P.revenuePerEmployee) : null}
          unit=""
          accent={BLUE}
          sub="Annual revenue ÷ active headcount"
          loading={loading}
          na={!P.revenuePerEmployee}
        />
        <MetricCard
          label="Training Effectiveness Score"
          value={P.trainingEffectivenessScore}
          unit="%"
          benchmark={70}
          trend="higher-is-better"
          accent={BLUE}
          sub={`${P.totalAssessments || 0} assessments · Pass rate ${P.trainingPassRate || 0}%`}
          loading={loading}
        />
      </Section>

      {/* Appraisal distribution — full-width card */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#374151', marginBottom: 14 }}>
            📊 Performance Appraisal Ratings Distribution (last 12 months)
          </div>
          <DistributionBar data={P.appraisalDistribution || []} loading={loading} />
        </div>
      </div>

      {/* ── 3. Retention & Engagement ─────────────────────────────────────── */}
      <Section title="Retention & Engagement Metrics" icon="🔄" accent={GREEN}>
        <MetricCard
          label="Employee Turnover Rate"
          value={RT.turnoverRate}
          unit="%"
          benchmark={10}
          trend="lower-is-better"
          accent={RED}
          sub={`${RT.departed || 0} exits in last 12 months`}
          loading={loading}
        />
        <MetricCard
          label="Employee Engagement Score"
          value={RT.engagementScore}
          unit="%"
          benchmark={75}
          trend="higher-is-better"
          accent={GREEN}
          sub={`${RT.engagedCount || 0} engaged employees`}
          loading={loading}
        />
        <MetricCard
          label="Acquisition Rate"
          value={RT.acquisitionRate}
          unit="%"
          benchmark={15}
          trend="higher-is-better"
          accent={TEAL}
          sub={`${RT.newHires || 0} new hires last 12 months`}
          loading={loading}
        />
      </Section>

      {/* ── 4. Compensation & Benefits ────────────────────────────────────── */}
      <Section title="Compensation & Benefits Metrics" icon="💰" accent={AMBER}>
        <MetricCard
          label="Compa-Ratio"
          value={C.compaRatio}
          unit="x"
          benchmark={1.0}
          trend="higher-is-better"
          accent={AMBER}
          sub={`Avg ÷ Median salary · ₹${(C.avgSalary||0).toLocaleString('en-IN')} avg`}
          loading={loading}
        />
        <MetricCard
          label="Median Salary"
          value={C.medianSalary > 0 ? `₹${(C.medianSalary||0).toLocaleString('en-IN')}` : null}
          accent={AMBER}
          sub={`P25: ₹${(C.p25Salary||0).toLocaleString('en-IN')} · P75: ₹${(C.p75Salary||0).toLocaleString('en-IN')}`}
          loading={loading}
          na={!C.medianSalary}
        />
        <MetricCard
          label="Benefits Utilization Rate"
          value={C.benefitsUtilizationRate}
          unit="%"
          benchmark={80}
          trend="higher-is-better"
          accent={GREEN}
          sub="Employees who used leave benefits"
          loading={loading}
        />
      </Section>

      {/* ── 5. Diversity & Inclusion ──────────────────────────────────────── */}
      <Section title="Diversity & Inclusion Metrics" icon="🌍" accent={PINK}>
        <MetricCard
          label="Gender Diversity Ratio (Female)"
          value={D.femalePct}
          unit="%"
          benchmark={40}
          trend="higher-is-better"
          accent={PINK}
          sub={`${D.female || 0} female of ${D.total || 0} total`}
          loading={loading}
        />
        <MetricCard
          label="Women in Leadership"
          value={D.leaderFemalePct}
          unit="%"
          benchmark={30}
          trend="higher-is-better"
          accent={PINK}
          sub={`${D.leaderFemale || 0} of ${D.leaderTotal || 0} leadership roles`}
          loading={loading}
        />
      </Section>

      {/* Gender distribution bars */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Card title="Overall Gender Distribution">
          <GenderBar femalePct={D.femalePct} malePct={D.malePct} loading={loading} />
        </Card>
        <Card title="Gender Representation in Leadership">
          <GenderBar
            femalePct={D.leaderFemalePct}
            malePct={D.leaderTotal > 0 ? parseFloat((100 - D.leaderFemalePct).toFixed(1)) : 0}
            femaleLabel="Female Leaders"
            maleLabel="Male Leaders"
            loading={loading}
          />
          {!loading && D.leaderTotal === 0 && (
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>
              No employees with Manager / Director / Head / VP designation found
            </div>
          )}
        </Card>
      </div>

      {/* Benchmark legend */}
      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '14px 18px', fontSize: 12, color: '#166534' }}>
        <strong>Benchmark reference:</strong> Days to hire &lt;30d · Offer acceptance &gt;70% · Turnover &lt;10% · Engagement &gt;75% · Compa-ratio ≥1.0 · Benefits utilization &gt;80% · Female representation &gt;40% · Women in leadership &gt;30%
      </div>
    </div>
  );
}
