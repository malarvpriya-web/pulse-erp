import { useState, useEffect, useCallback, useRef } from 'react';
import { LayoutDashboard } from 'lucide-react';
import api from '@/services/api/client';
import useDashboardFilters from '@/hooks/useDashboardFilters';
import { DashboardFilterBar, PageHero, PageShell } from '@/components/pulse-ui';
import '@/components/dashboard/dashkit.css';
import './HRBenchmarkingDashboard.css';

/* ─────────────────────────────────────────────────────────────────────────────
 * HR Benchmarking Dashboard — single-viewport cockpit.
 *
 * LAYOUT. Three bands of `rail + 5 metric cards`, then a chart band, then the
 * benchmark strip; the page itself never scrolls. The five section headers this
 * page used to stack down the left are one shared RAIL COLUMN per band, so a
 * group label costs a column instead of a row — that is what buys the fit. The
 * contract lives in HRBenchmarkingDashboard.css; read the header there before
 * moving anything.
 *
 * ⚠ The 2026-08-20 hero codemod converted this page to `<PageShell>` WITHOUT
 * carrying the root class across, and separately dropped the stylesheet import
 * and re-expanded every class into an inline `style={{}}`. The sheet has been
 * dead ever since and the page reverted to a ~1,700px scroller. Both are
 * restored here: `className="hrb-root"` below is load-bearing, and so is the
 * import above. Deleting either silently un-styles the whole page — nothing in
 * esbuild, eslint or vitest can see it.
 *
 * LIVE DATA. Every figure comes from GET /analytics/hr-benchmarks; there are no
 * client-side constants except the industry benchmarks in BENCHMARKS, which are
 * labelled as such. The rule this page now keeps: a metric with no rows behind
 * it is UNMEASURED, and an unmeasured metric NEVER renders a benchmark verdict.
 * The API says which is which through its `*Available` flags — pass them as
 * `has`, and the card shows the reason instead of scoring a fabricated zero.
 * ────────────────────────────────────────────────────────────────────────── */

const PURPLE = '#6B3FDB';
const GREEN  = '#059669';
const AMBER  = '#6d28d9';
const RED    = '#dc2626';
const BLUE   = '#2563eb';
const TEAL   = '#0891b2';
const PINK   = '#db2777';
const GREY   = '#9ca3af';

/** Industry reference points. The ONLY hardcoded numbers on this page. */
const BENCHMARKS = {
  daysToHire: 30, timeToFill: 45, offerAcceptance: 70, offerDecline: 15,
  training: 70, turnover: 10, engagement: 75, acquisition: 15,
  compaRatio: 1.0, benefits: 80, female: 40, womenLeaders: 30,
};

const inr = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Render a live figure. Never called with null — `has` gates that upstream. */
function present(value, format) {
  const n = Number(value);
  switch (format) {
    case 'pct':  return `${n}%`;
    case 'days': return `${n} ${n === 1 ? 'day' : 'days'}`;
    case 'inr':  return inr(n);
    case 'ratio': return `${n.toFixed(2)}x`;
    default:     return n.toLocaleString('en-IN');
  }
}

/**
 * One metric card.
 *
 * @param {number|null} value the live figure
 * @param {boolean} has whether the API measured it at all. FALSE renders
 *   "Not measured" plus `noteWhenMissing` — and suppresses the benchmark line,
 *   because scoring an unmeasured metric is how this page used to report "0
 *   days to hire — Below target" on a company that had simply never linked a
 *   candidate record to a joiner.
 * @param {string} [noteWhenMissing] why it is unmeasured, in the user's terms
 * @param {'higher'|'lower'} [trend] which direction beats the benchmark
 */
function MetricCard({
  label, value, has, format = 'num', benchmark, benchmarkFormat, trend = 'higher',
  accent = PURPLE, sub, noteWhenMissing, loading, index = 0,
}) {
  const measured = has && value != null && Number.isFinite(Number(value));
  const n = Number(value);
  const scored = measured && benchmark != null;
  const onTarget = scored && (trend === 'lower' ? n <= benchmark : n >= benchmark);
  const near = scored && !onTarget &&
    (trend === 'lower' ? n <= benchmark * 1.15 : n >= benchmark * 0.85);
  const statusColor = !scored ? GREY : onTarget ? GREEN : near ? AMBER : RED;
  const benchText = `benchmark ${present(benchmark, benchmarkFormat || format)}`;

  return (
    <div className="hrb-card dk-anim" style={{ '--dk-i': index }}>
      <span className="hrb-card-accent" style={{ background: measured ? accent : GREY }} />
      <div className="hrb-card-label" title={label}>{label}</div>

      {loading ? <div className="hrb-card-skel" />
        : measured
          ? <div className="hrb-card-val" style={{ color: accent }} title={present(n, format)}>
              {present(n, format)}
            </div>
          : <div className="hrb-card-val" style={{ color: GREY, fontSize: 14 }}>Not measured</div>}

      {!loading && (
        measured
          ? sub && <div className="hrb-card-sub" title={sub}>{sub}</div>
          : noteWhenMissing && <div className="hrb-card-sub" title={noteWhenMissing}>{noteWhenMissing}</div>
      )}

      {!loading && scored && (
        <div className="hrb-card-bm" style={{ color: statusColor }}>
          <span className="hrb-dot" style={{ background: statusColor }} />
          <span title={`${onTarget ? 'On target' : 'Below target'} — ${benchText}`}>
            {onTarget ? 'On target' : 'Below target'} · {benchText}
          </span>
        </div>
      )}
    </div>
  );
}

/** Section label column — replaces a full header row per group. */
function Rail({ icon, title, note, accent }) {
  return (
    <div className="hrb-rail" style={{ '--hrb-rail': accent }}>
      <span className="hrb-rail-ico">{icon}</span>
      <span className="hrb-rail-title">{title}</span>
      {note && <span className="hrb-rail-note" title={note}>{note}</span>}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div className="hrb-panel">
      <div className="hrb-panel-title" title={title}>{title}</div>
      <div className="hrb-panel-body">{children}</div>
    </div>
  );
}

const BAND_COLORS = {
  Exceptional: GREEN, Exceeds: BLUE, Meets: PURPLE, Below: AMBER, PIP: RED,
};

function DistributionBar({ data = [], total = 0, loading, scale }) {
  if (loading) return <div className="hrb-card-skel" style={{ width: '100%', height: 56 }} />;
  if (!total) {
    return <div className="hrb-muted">No appraisal ratings recorded in this period</div>;
  }
  return (
    <div>
      <div className="hrb-stack">
        {data.map((d, i) => (
          <div key={i} title={`${d.band}: ${d.count} of ${total}`}
            style={{ width: `${(d.count / total) * 100}%`, background: BAND_COLORS[d.band] || GREY }} />
        ))}
      </div>
      <div className="hrb-legends">
        {data.map((d, i) => (
          <span key={i} className="hrb-legend-item">
            <span className="hrb-swatch" style={{ background: BAND_COLORS[d.band] || GREY }} />
            {d.band} <span style={{ color: '#6b7280' }}>
              {d.count} · {Math.round((d.count / total) * 100)}%
            </span>
          </span>
        ))}
      </div>
      <div className="hrb-card-sub" style={{ marginTop: 6 }}
        title={`${total} reviews · ratings held on a ${scale}-point scale, banded as a percentage`}>
        {total} review{total === 1 ? '' : 's'} · {scale}-point scale
      </div>
    </div>
  );
}

/**
 * Gender split. `unknown` is drawn, not hidden — this page previously inferred
 * the male share as `100 − female`, which turns an unrecorded gender into a
 * man. Both shares are counted server-side now and the remainder is labelled.
 */
function GenderBar({ femalePct, malePct, known, total, loading, femaleLabel = 'Female', maleLabel = 'Male' }) {
  if (loading) return <div className="hrb-card-skel" style={{ width: '100%', height: 40 }} />;
  if (!known) return <div className="hrb-muted">No gender recorded for any of the {total} employees in scope</div>;
  const f = Number(femalePct) || 0;
  const m = Number(malePct) || 0;
  const other = Math.max(0, 100 - f - m);
  const unknown = total - known;
  return (
    <div>
      <div className="hrb-stack">
        <div style={{ width: `${f}%`, background: PINK }} title={`${femaleLabel}: ${f}%`} />
        <div style={{ width: `${m}%`, background: BLUE }} title={`${maleLabel}: ${m}%`} />
        {other > 0 && <div style={{ width: `${other}%`, background: '#e5e7eb' }} title="Other / not stated" />}
      </div>
      <div className="hrb-legends">
        <span className="hrb-legend-item">
          <span className="hrb-swatch" style={{ background: PINK }} />{femaleLabel} {f}%
        </span>
        <span className="hrb-legend-item">
          <span className="hrb-swatch" style={{ background: BLUE }} />{maleLabel} {m}%
        </span>
      </div>
      <div className="hrb-card-sub" style={{ marginTop: 6 }}
        title={`Percentages are of the ${known} employees with a gender on file, out of ${total} in scope`}>
        Of {known} with gender on file{unknown > 0 ? ` · ${unknown} not recorded` : ''}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function HRBenchmarkingDashboard() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const abortRef = useRef(null);

  // Period drives every windowed metric server-side (resolveRange). The API
  // defaults to last12m, which is what the appraisal and turnover cards are
  // conventionally read over, so that is this page's default too.
  const filters = useDashboardFilters({
    defaultPeriod: 'last12m',
    storageKey: 'hr-benchmarking',
  });
  const { params } = filters;

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/analytics/hr-benchmarks', { params, signal: ctrl.signal });
      setData(res.data?.data || res.data);
    } catch (e) {
      /* ⚠ Axios rejects a cancelled request with its own `CanceledError`
       * (code `ERR_CANCELED`) — it NEVER throws a DOM `AbortError`. Testing for
       * `AbortError` therefore matched nothing, so every abort was reported as a
       * load failure. Under StrictMode the effect runs mount → cleanup → mount,
       * the cleanup aborts request #1, and request #2 succeeds: the page painted
       * a full set of correct benchmarks with "Failed to load benchmarking data"
       * sitting above them. Not dev-only either — `load()` aborts the previous
       * in-flight request, so a double-click on Refresh did the same in prod. */
      if (e?.name !== 'CanceledError' && e?.code !== 'ERR_CANCELED') {
        setError(e?.response?.data?.error || 'Failed to load benchmarking data');
      }
    } finally {
      // A superseded request must not clear the spinner the live one turned on.
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [params]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const R  = data?.recruitment  || {};
  const P  = data?.performance  || {};
  const RT = data?.retention    || {};
  const C  = data?.compensation || {};
  const D  = data?.diversity    || {};
  const windowLabel = data?.period_label || 'selected period';

  return (
    <PageShell className="hrb-root" dock={<>
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Human Resources"
        title="HR Benchmarking Dashboard"
        subtitle="Recruitment · Performance · Retention · Compensation · Diversity — live metrics against industry benchmarks"
      />
      <DashboardFilterBar
        filters={filters}
        actions={<button className="plh-cta" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>}
      />
    </>}>

      {error && <div className="hrb-error">{error}</div>}

      <div className="hrb-body">

        {/* ── 1. Recruitment & Hiring ─────────────────────────────────── */}
        <div className="hrb-band">
          <Rail icon="🎯" title="Recruitment & Hiring" note={windowLabel} accent={PURPLE} />
          <MetricCard
            label="Avg Days to Hire" index={0}
            value={R.avgDaysToHire} has={R.timeToHireAvailable} format="days"
            benchmark={BENCHMARKS.daysToHire} trend="lower" accent={PURPLE}
            sub={`Application → joining · ${plural(R.timeToHireSample || 0, 'hire', 'hires')} matched`}
            noteWhenMissing="No joiner linked back to a candidate record"
            loading={loading}
          />
          <MetricCard
            label="Time to Fill" index={1}
            value={R.timeToFill} has={R.timeToFillAvailable} format="days"
            benchmark={BENCHMARKS.timeToFill} trend="lower" accent={PURPLE}
            sub={`Opening → closed · ${plural(R.timeToFillSample || 0, 'requisition', 'requisitions')}`}
            noteWhenMissing="No requisition closed in this period"
            loading={loading}
          />
          <MetricCard
            label="Offer Acceptance Rate" index={2}
            value={R.offerAcceptanceRate} has={R.offerDataAvailable} format="pct"
            benchmark={BENCHMARKS.offerAcceptance} trend="higher" accent={GREEN}
            sub={`${R.totalAccepted || 0} accepted of ${R.totalOffered || 0} offers`}
            noteWhenMissing="No offers issued in this period"
            loading={loading}
          />
          <MetricCard
            label="Offer Decline Rate" index={3}
            value={R.offerDeclineRate} has={R.offerDataAvailable} format="pct"
            benchmark={BENCHMARKS.offerDecline} trend="lower" accent={AMBER}
            sub={`${R.totalDeclined || 0} declined of ${R.totalOffered || 0} offers`}
            noteWhenMissing="No offers issued in this period"
            loading={loading}
          />
          <MetricCard
            label="Cost per Hire" index={4}
            value={R.costPerHire} has={R.costPerHireAvailable} format="inr" accent={TEAL}
            sub="From the recruitment cost ledger"
            noteWhenMissing="No recruitment spend ledger exists yet"
            loading={loading}
          />
        </div>

        {/* ── 2. Performance & Retention ──────────────────────────────── */}
        <div className="hrb-band">
          <Rail icon="📈" title="Performance & Retention" note={`${P.headcount ?? '—'} active employees`} accent={BLUE} />
          <MetricCard
            label="Revenue per Employee" index={5}
            value={P.revenuePerEmployee} has={P.revenuePerEmployeeAvailable} format="inr" accent={BLUE}
            sub={`${P.revenueBasis || 'paid invoices'} ÷ ${P.headcount || 0} active`}
            noteWhenMissing="No paid invoices in this period"
            loading={loading}
          />
          <MetricCard
            label="Training Effectiveness" index={6}
            value={P.trainingEffectivenessScore} has={P.trainingDataAvailable} format="pct"
            benchmark={BENCHMARKS.training} trend="higher" accent={BLUE}
            sub={`${P.totalAssessments || 0} assessments · ${P.trainingPassRate ?? 0}% passed`}
            noteWhenMissing="No assessments submitted in this period"
            loading={loading}
          />
          <MetricCard
            label="Employee Turnover" index={7}
            value={RT.turnoverRate} has={RT.turnoverRate != null} format="pct"
            benchmark={BENCHMARKS.turnover} trend="lower" accent={RED}
            sub={`${plural(RT.departed || 0, 'exit', 'exits')} of ${RT.headcount || 0} active`}
            noteWhenMissing="No active headcount to measure against"
            loading={loading}
          />
          <MetricCard
            label="Engagement Score" index={8}
            value={RT.engagementScore} has={RT.engagementAvailable} format="pct"
            benchmark={BENCHMARKS.engagement} trend="higher" accent={GREEN}
            sub={`${RT.engagedCount || 0} of ${RT.engagementReviewed || 0} reviewed score ≥ 75%`}
            noteWhenMissing="No appraisal rating recorded in this period"
            loading={loading}
          />
          <MetricCard
            label="Acquisition Rate" index={9}
            value={RT.acquisitionRate} has={RT.acquisitionRate != null} format="pct"
            benchmark={BENCHMARKS.acquisition} trend="higher" accent={TEAL}
            sub={`${RT.newHires || 0} joined in ${windowLabel.toLowerCase()}`}
            noteWhenMissing="No active headcount to measure against"
            loading={loading}
          />
        </div>

        {/* ── 3. Compensation & Diversity ─────────────────────────────── */}
        <div className="hrb-band">
          <Rail
            icon="💰" title="Pay & Diversity"
            note={`pay on file for ${C.salaryCoveragePct ?? 0}% of staff`}
            accent={AMBER}
          />
          <MetricCard
            label="Compa-Ratio" index={10}
            value={C.compaRatio} has={C.salaryDataAvailable} format="ratio"
            benchmark={BENCHMARKS.compaRatio} benchmarkFormat="ratio" trend="higher" accent={AMBER}
            sub={`Mean ÷ median · mean ${C.avgSalary != null ? inr(C.avgSalary) : '—'}`}
            noteWhenMissing="No employee carries a basic salary"
            loading={loading}
          />
          <MetricCard
            label="Median Salary" index={11}
            value={C.medianSalary} has={C.salaryDataAvailable} format="inr" accent={AMBER}
            sub={C.p25Salary != null
              ? `P25 ${inr(C.p25Salary)} · P75 ${inr(C.p75Salary)} · n=${C.salarySample}`
              : ''}
            noteWhenMissing="No employee carries a basic salary"
            loading={loading}
          />
          <MetricCard
            label="Benefits Utilization" index={12}
            value={C.benefitsUtilizationRate} has={C.benefitsUtilizationRate != null} format="pct"
            benchmark={BENCHMARKS.benefits} trend="higher" accent={GREEN}
            sub={`${plural(C.benefitsUtilizers || 0, 'employee', 'employees')} applied for leave`}
            noteWhenMissing="No active headcount to measure against"
            loading={loading}
          />
          <MetricCard
            label="Female Representation" index={13}
            value={D.femalePct} has={D.genderDataAvailable} format="pct"
            benchmark={BENCHMARKS.female} trend="higher" accent={PINK}
            sub={`${D.female || 0} of ${D.genderKnown || 0} with gender on file (${D.genderCoveragePct ?? 0}% of staff)`}
            noteWhenMissing="Gender is not recorded for anyone on the roster"
            loading={loading}
          />
          <MetricCard
            label="Women in Leadership" index={14}
            value={D.leaderFemalePct} has={D.leaderDataAvailable} format="pct"
            benchmark={BENCHMARKS.womenLeaders} trend="higher" accent={PINK}
            sub={`${D.leaderFemale || 0} of ${D.leaderKnown || 0} leadership roles`}
            noteWhenMissing="No leadership role has a gender on file"
            loading={loading}
          />
        </div>

        {/* ── charts ──────────────────────────────────────────────────── */}
        <div className="hrb-band hrb-band--charts">
          <Rail icon="📊" title="Distributions" note={windowLabel} accent={GREEN} />
          <Panel title="Appraisal rating distribution">
            <DistributionBar
              data={P.appraisalDistribution || []}
              total={P.appraisalTotal || 0}
              scale={P.appraisalScale || 5}
              loading={loading}
            />
          </Panel>
          <Panel title="Gender split — all employees">
            <GenderBar
              femalePct={D.femalePct} malePct={D.malePct}
              known={D.genderKnown || 0} total={D.total || 0}
              loading={loading}
            />
          </Panel>
          <Panel title="Gender split — leadership">
            <GenderBar
              femalePct={D.leaderFemalePct} malePct={D.leaderMalePct}
              known={D.leaderKnown || 0} total={D.leaderTotal || 0}
              femaleLabel="Female leaders" maleLabel="Male leaders"
              loading={loading}
            />
          </Panel>
        </div>

        <div className="hrb-legend">
          <strong>Industry benchmarks:</strong> days to hire &lt;{BENCHMARKS.daysToHire}d ·
          time to fill &lt;{BENCHMARKS.timeToFill}d ·
          offer acceptance &gt;{BENCHMARKS.offerAcceptance}% ·
          turnover &lt;{BENCHMARKS.turnover}% ·
          engagement &gt;{BENCHMARKS.engagement}% ·
          compa-ratio ≥{BENCHMARKS.compaRatio.toFixed(1)}x ·
          benefits utilization &gt;{BENCHMARKS.benefits}% ·
          female representation &gt;{BENCHMARKS.female}% ·
          women in leadership &gt;{BENCHMARKS.womenLeaders}%.
          Cards marked <em>Not measured</em> have no source rows — they are not zeros.
        </div>
      </div>
    </PageShell>
  );
}
