/**
 * supplierDevelopmentEngine.js — when a supplier is worth developing, and at what.
 *
 * Pure. No DB calls, no clock of its own. Given one supplier's health detail as
 * `vendorHealthEngine.computeVendorHealth()` returns it, this decides whether to
 * RECOMMEND a development plan and says, in words a buyer can act on, why.
 *
 * ⚠ IT RECOMMENDS. IT DOES NOT CREATE.
 * Auto-opening a plan for every Critical supplier would fill the table with
 * records nobody agreed to, nobody owns and nobody works — a graveyard that
 * makes the feature look alive while the loop stays broken. A person opens the
 * plan; this only makes the case for it, and the case is stored on the plan as
 * `trigger_reason` so the decision stays auditable after everyone has moved on.
 *
 * ⚠ EVIDENCE, NOT ABSENCE.
 * Every trigger below is gated on its KPI being MEASURED. The scorecard reports
 * `null` for anything it could not measure, and a supplier nobody has ordered
 * from must not be recommended for a quality programme on the strength of a
 * pass rate that does not exist. This is the same discipline
 * `vendorHealthEngine` follows when it renormalises over measured weights —
 * see project_supplier_performance_index for what the alternative cost.
 *
 * The first four method keys mirror `sourcingStrategyEngine`'s
 * `supplier_development` strategy exactly, so the advisory panel and the plan
 * that answers it speak one vocabulary. `cost_reduction` is added here because
 * the scorecard measures PPV and a supplier programme that cannot target cost
 * would leave that KPI with no response.
 */

export const DEVELOPMENT_METHODS = {
  capability_build:     'Capability build programme',
  quality_programme:    'Quality improvement programme',
  lead_time_project:    'Lead time reduction project',
  capacity_reservation: 'Capacity reservation',
  cost_reduction:       'Cost reduction programme',
  other:                'Other',
};

/**
 * Thresholds. Deliberately the same numbers the health scorers band on, so a
 * recommendation cannot disagree with the score that produced it.
 */
const T = {
  capaClosurePct:         60,   // scoreQuality penalises below this
  otdPct:                 85,
  leadTimeAdherencePct:   70,
  fillRatePct:            90,
  ppvPct:                 10,   // paying >10% over standard
  passRatePct:            95,
  minCoveragePct:         40,   // below this we know too little to prescribe
};

const pct = (n) => `${Number(n).toFixed(1)}%`;

/**
 * @param {object} detail   the `detail` block from computeVendorHealth()
 * @param {object} summary  { health_score, health_status, coverage_pct }
 * @param {object} flags    { isSingleSource, isCriticalSupplier }
 * @returns {{recommend: boolean, reasons: Array, methods: Array, priority: string}}
 */
export function recommendDevelopment({ detail = {}, summary = {}, flags = {} } = {}) {
  const q = detail.quality  || {};
  const d = detail.delivery || {};
  const c = detail.cost     || {};

  const coverage = Number(summary.coverage_pct ?? 0);
  const reasons = [];

  // ⚠ Nothing is prescribed on thin evidence. An 'Unrated' supplier needs
  // ORDERS placed with it before it needs a development programme, and a
  // recommendation made on 40% coverage is mostly a recommendation about our
  // own record-keeping.
  if (coverage < T.minCoveragePct || summary.health_status === 'Unrated') {
    return {
      recommend: false,
      reasons: [],
      methods: [],
      priority: 'none',
      withheld: 'insufficient_evidence',
      coveragePct: coverage,
    };
  }

  // ── Quality ────────────────────────────────────────────────────────────────
  if (q.capaMeasured && q.capaClosurePct < T.capaClosurePct) {
    reasons.push({
      method: 'quality_programme',
      metric: 'capa_closure_pct',
      severity: 'high',
      detail: `CAPA closure is ${pct(q.capaClosurePct)}, below the ${T.capaClosurePct}% the scorecard penalises. Corrective actions are being raised and not finished.`,
    });
  }
  if (q.passRateMeasured && q.passRate < T.passRatePct) {
    reasons.push({
      method: 'quality_programme',
      metric: 'pass_rate_pct',
      severity: q.passRate < 90 ? 'high' : 'medium',
      detail: `Incoming inspection pass rate is ${pct(q.passRate)}, below ${T.passRatePct}%.`,
    });
  }
  // A repeat is the same defect coming back. That is a process problem at the
  // supplier, which is precisely what a development programme is for — a
  // one-off is not.
  if ((q.repeatNCR ?? 0) > 0) {
    reasons.push({
      method: 'quality_programme',
      metric: 'open_ncr_count',
      severity: 'high',
      detail: `${q.repeatNCR} repeat non-conformance(s) of a defect type already raised. The same failure is recurring.`,
    });
  }

  // ── Delivery ───────────────────────────────────────────────────────────────
  // ⚠ Only against a date the supplier COMMITTED to. Judging delivery on
  // order_date + our own lead-time master data and then prescribing a lead-time
  // project would be prescribing against our own assumption.
  if (d.otdMeasured && ['promised', 'mixed'].includes(d.otdBasis) && d.otdPct < T.otdPct) {
    reasons.push({
      method: 'lead_time_project',
      metric: 'otd_pct',
      severity: d.otdPct < 70 ? 'high' : 'medium',
      detail: `On-time delivery is ${pct(d.otdPct)} against dates the supplier committed to (${pct(d.promisedCoveragePct)} of receipts), below ${T.otdPct}%.`,
    });
  }
  if (d.leadTimeMeasured && d.leadTimeAdherencePct < T.leadTimeAdherencePct) {
    reasons.push({
      method: 'lead_time_project',
      metric: 'lead_time_adherence_pct',
      severity: 'medium',
      detail: `Only ${pct(d.leadTimeAdherencePct)} of receipts land within 3 days of the promised date (average variance ${d.avgLeadTimeVarianceDays ?? '?'} days). The lead time is unpredictable, not merely long.`,
    });
  }
  if (d.fillRateMeasured && d.fillRatePct < T.fillRatePct) {
    reasons.push({
      method: 'capacity_reservation',
      metric: 'fill_rate_pct',
      severity: d.fillRatePct < 80 ? 'high' : 'medium',
      detail: `Fill rate is ${pct(d.fillRatePct)} — ordered quantity is not arriving in full, which is a capacity or allocation problem rather than a scheduling one.`,
    });
  }

  // ── Cost ───────────────────────────────────────────────────────────────────
  if (c.ppvMeasured && c.ppvPct > T.ppvPct) {
    reasons.push({
      method: 'cost_reduction',
      metric: 'ppv_pct',
      severity: c.ppvPct > 25 ? 'high' : 'medium',
      detail: `Paying ${pct(c.ppvPct)} above standard cost. Sustained, that is a cost base to work on with the supplier, not a negotiation to reopen every quarter.`,
    });
  }

  // ── Dependency ─────────────────────────────────────────────────────────────
  // Developing a weak single source is often cheaper than qualifying a second —
  // but only say so when there is a real weakness to develop.
  if ((flags.isSingleSource || flags.isCriticalSupplier) && reasons.length > 0) {
    reasons.push({
      method: 'capability_build',
      metric: 'health_score',
      severity: 'high',
      detail: flags.isSingleSource
        ? 'Single-sourced, so the weaknesses above cannot be routed around by moving volume elsewhere.'
        : 'Flagged critical, so its performance is felt directly downstream.',
    });
  }

  if (reasons.length === 0) {
    return { recommend: false, reasons: [], methods: [], priority: 'none',
             withheld: 'no_finding', coveragePct: coverage };
  }

  // Methods in the order their strongest reason argues for them.
  const methods = [...new Set(reasons.map((r) => r.method))];
  const priority = reasons.some((r) => r.severity === 'high') ? 'high' : 'medium';

  return { recommend: true, reasons, methods, priority, coveragePct: coverage };
}

/**
 * Did the plan work?
 *
 * Compares the metric the plan named, at open and at close. Derived, never
 * typed: a development programme that grades its own homework is not evidence.
 *
 * ⚠ Direction is per-metric. For most KPIs up is better; for `ppv_pct`,
 * `open_ncr_count` and `avg_lead_time_variance_days` down is better. Getting
 * this backwards would report a supplier that halved its defects as having got
 * worse.
 */
const LOWER_IS_BETTER = new Set(['ppv_pct', 'open_ncr_count', 'avg_lead_time_variance_days']);

export function assessEffectiveness({ targetMetric, baselineValue, outcomeValue, tolerance = 0.5 } = {}) {
  const a = baselineValue == null ? null : Number(baselineValue);
  const b = outcomeValue  == null ? null : Number(outcomeValue);
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
    // Unmeasured is not "no change" — it is not knowing, and it must read that way.
    return { effectiveness: 'unmeasured', delta: null, improved: null };
  }
  const rawDelta = b - a;
  const delta = LOWER_IS_BETTER.has(targetMetric) ? -rawDelta : rawDelta;
  if (Math.abs(rawDelta) < tolerance) return { effectiveness: 'no_change', delta: rawDelta, improved: false };
  return {
    effectiveness: delta > 0 ? 'improved' : 'worsened',
    delta: rawDelta,
    improved: delta > 0,
  };
}

export default { recommendDevelopment, assessEffectiveness, DEVELOPMENT_METHODS };
