/**
 * rfxScoringEngine.js — weighted vendor scoring for an RFI, RFP or RFQ (1.7.5).
 *
 * WHY THIS EXISTS
 * The award modal ranked vendors on price, and §128 improved that to total cost
 * of ownership. Both answer "who is cheapest, properly measured". Neither
 * answers "who should we prefer", which is the question an RFI and an RFP are
 * for, and which weighs capability, quality record, delivery reliability and
 * compliance next to cost.
 *
 * THE MODEL — a weighted scorecard, 0-100 per criterion, weights summing to 100.
 * Different events ask different questions, so each RFx type has its own default
 * model (below), which a buyer can override per event.
 *
 * THE TWO THINGS THAT MAKE IT HONEST
 *
 *   1. AN UNSCORED CRITERION IS NOT A ZERO. Scores live in a table where a
 *      missing assessment is a missing ROW. The weighted total is computed over
 *      the weight that was actually scored, and `coverage_pct` says how much of
 *      the model that was. Averaging an unscored criterion in as zero would
 *      punish the vendor nobody has got round to assessing, which is exactly
 *      backwards.
 *
 *   2. A LEAD SMALLER THAN THE UNCERTAINTY IS NOT A LEAD. If 30% of the weight
 *      is unscored, the missing evidence could move a bid by up to 30 points,
 *      so a 4-point gap between first and second is noise. `rankBids` returns
 *      `too_close_to_call` in that case rather than naming a winner. A scoring
 *      model whose arithmetic always produces a recommendation is a machine for
 *      laundering coin flips into decisions, and it is worse than no model
 *      because it carries the authority of a number.
 *
 * BENCHMARKING. Cost and delivery are not opinions, so they are not left to
 * one. `benchmark()` turns the field of bids into 0-100 scores: best in field
 * scores 100, and the rest fall away in proportion to how far behind they are.
 * That is the "clear benchmark" a scoring model needs to stop being a vote.
 *
 * Pure functions. No DB, no I/O — see services/rfxScoring.service.js.
 */

export function num(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const round1 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const clamp  = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Below this share of the model scored, a ranking is reported but not
 * recommended from. Half the scorecard blank is a shortlist, not a decision.
 */
export const MIN_COVERAGE_PCT = 60;

/**
 * `auto` marks a criterion the service can fill without a human: it is either
 * benchmarked from the field of bids or observed from our own records. The rest
 * need somebody to actually assess them, and the UI shows them as outstanding.
 */
export const RFX_MODELS = Object.freeze({
  RFI: {
    type: 'RFI',
    label: 'Request for Information',
    purpose: 'Can this supplier do it at all? Qualification before anyone talks price.',
    criteria: [
      { key: 'capability',        label: 'Technical capability',      weight: 30, auto: false, help: 'Plant, process and people to make this to spec' },
      { key: 'capacity',          label: 'Capacity & scalability',    weight: 20, auto: false, help: 'Headroom at our volumes, and above them' },
      { key: 'quality_system',    label: 'Quality system',            weight: 20, auto: true,  help: 'Certification, and our own inspection record where one exists' },
      { key: 'financial_standing',label: 'Financial standing',        weight: 15, auto: true,  help: 'Can they fund the work and still be here next year' },
      { key: 'compliance',        label: 'Compliance & documentation',weight: 15, auto: true,  help: 'Statutory registration, valid documents on file' },
    ],
  },
  RFP: {
    type: 'RFP',
    label: 'Request for Proposal',
    purpose: 'Whose approach is best? Solution and commercial terms together.',
    criteria: [
      { key: 'solution_fit',      label: 'Solution fit',              weight: 25, auto: false, help: 'How well the proposal answers the requirement' },
      { key: 'technical_merit',   label: 'Technical merit',           weight: 20, auto: false, help: 'Engineering quality of what is proposed' },
      { key: 'commercial',        label: 'Commercial terms',          weight: 20, auto: true,  help: 'Price and payment terms, benchmarked across the field' },
      { key: 'delivery',          label: 'Delivery & lead time',      weight: 15, auto: true,  help: 'Quoted lead time, weighed against their delivered record' },
      { key: 'quality_record',    label: 'Quality record',            weight: 10, auto: true,  help: 'What our receipts and NCRs actually say about them' },
      { key: 'risk',              label: 'Risk & dependency',         weight: 10, auto: true,  help: 'Concentration, single-source exposure, supplier health' },
    ],
  },
  RFQ: {
    type: 'RFQ',
    label: 'Request for Quotation',
    purpose: 'Who gives the best deal on a defined spec? Price-led, but not price-only.',
    criteria: [
      { key: 'cost',              label: 'Cost',                      weight: 45, auto: true,  help: 'Total cost of ownership where enabled, unit price otherwise' },
      { key: 'delivery',          label: 'Delivery & lead time',      weight: 20, auto: true,  help: 'Quoted lead time, benchmarked across the field' },
      { key: 'quality_record',    label: 'Quality record',            weight: 20, auto: true,  help: 'Our own receipt and NCR history with this vendor' },
      { key: 'terms',             label: 'Payment & warranty terms',  weight: 10, auto: true,  help: 'Credit days and warranty offered' },
      { key: 'risk',              label: 'Risk & dependency',         weight: 5,  auto: true,  help: 'Supplier health and concentration exposure' },
    ],
  },
});

export const RFX_TYPES = Object.keys(RFX_MODELS);

/**
 * Resolve the model for an event: the type's default, with any per-event
 * override merged over it, and the weights renormalised to 100.
 *
 * Renormalising rather than rejecting is deliberate — a buyer who sets weights
 * summing to 90 means the proportions, not a broken form. But the fact that it
 * happened is reported, because silently rescaling somebody's numbers and
 * showing them a different result is its own kind of lie.
 */
export function resolveModel(rfxType, override = null) {
  const base = RFX_MODELS[String(rfxType || 'RFQ').toUpperCase()] || RFX_MODELS.RFQ;

  let criteria = base.criteria.map((c) => ({ ...c }));

  if (Array.isArray(override) && override.length) {
    const byKey = new Map(criteria.map((c) => [c.key, c]));
    criteria = override
      .filter((o) => o && o.key)
      .map((o) => {
        const known = byKey.get(o.key);
        return {
          key: o.key,
          label: o.label || known?.label || o.key,
          weight: num(o.weight, known?.weight ?? 0) ?? 0,
          auto: known?.auto ?? false,
          help: known?.help || o.help || null,
        };
      })
      .filter((c) => c.weight > 0);
    if (!criteria.length) criteria = base.criteria.map((c) => ({ ...c }));
  }

  const raw = criteria.reduce((a, c) => a + (num(c.weight, 0) || 0), 0);
  const renormalised = Math.abs(raw - 100) > 0.01;
  if (raw > 0 && renormalised) {
    criteria = criteria.map((c) => ({ ...c, weight: round2((num(c.weight, 0) / raw) * 100) }));
  }

  return {
    type: base.type,
    label: base.label,
    purpose: base.purpose,
    criteria,
    renormalised,
    original_weight_total: round2(raw),
  };
}

/**
 * Turn a raw measure into 0-100 across the field of bids.
 *
 * Best in field scores 100. The worst scores `floor` rather than 0, because a
 * vendor who is 8% more expensive than the best is not worthless on cost, and
 * a linear stretch to zero would say so. Values that are null are left null —
 * a bid that did not answer is unscored, not last.
 */
export function benchmark(values, { lowerIsBetter = true, floor = 30 } = {}) {
  const entries = Object.entries(values).map(([k, v]) => [k, num(v)]);
  const live = entries.filter(([, v]) => v != null && v > 0);
  const out = Object.fromEntries(entries.map(([k]) => [k, null]));
  if (!live.length) return out;

  const nums = live.map(([, v]) => v);
  const best  = lowerIsBetter ? Math.min(...nums) : Math.max(...nums);
  const worst = lowerIsBetter ? Math.max(...nums) : Math.min(...nums);

  for (const [k, v] of live) {
    if (best === worst) { out[k] = 100; continue; }
    // Distance from best as a share of the field's spread.
    const away = Math.abs(v - best) / Math.abs(worst - best);
    out[k] = round1(100 - away * (100 - floor));
  }
  return out;
}

/**
 * Weighted total for one bid over the criteria that were actually scored.
 *
 * `total` is on the SCORED weight, so it stays comparable to 100 rather than
 * shrinking as evidence goes missing; `coverage_pct` carries the shrinkage
 * instead, where it can be seen and reasoned about.
 */
export function scoreBid(model, scoresByKey = {}) {
  const lines = [];
  let scoredWeight = 0;
  let weighted = 0;

  for (const c of model.criteria) {
    const entry = scoresByKey[c.key];
    const raw = entry ? num(entry.score) : null;
    if (raw == null) {
      lines.push({ ...c, score: null, basis: 'unscored', note: entry?.note || null, contribution: null });
      continue;
    }
    const s = clamp(raw, 0, 100);
    scoredWeight += c.weight;
    weighted += s * c.weight;
    lines.push({
      ...c,
      score: round1(s),
      basis: entry.basis || 'assessed',
      note: entry.note || null,
      contribution: round2((s * c.weight) / 100),
    });
  }

  const totalWeight = model.criteria.reduce((a, c) => a + c.weight, 0) || 100;

  return {
    lines,
    total: scoredWeight > 0 ? round1(weighted / scoredWeight) : null,
    coverage_pct: round1((scoredWeight / totalWeight) * 100),
    unscored_weight_pct: round1(((totalWeight - scoredWeight) / totalWeight) * 100),
    scored_criteria: lines.filter((l) => l.score != null).length,
    total_criteria: model.criteria.length,
  };
}

/**
 * Rank a field of bids and say — honestly — whether it supports a decision.
 *
 * `decision` is one of:
 *   'recommended'        a clear leader on adequate evidence
 *   'too_close_to_call'  a leader exists but the gap is inside the uncertainty
 *                        created by unscored criteria
 *   'insufficient_evidence'  coverage too thin to rank from
 *   'insufficient_bids'  fewer than two scored bids — there is no comparison
 *
 * The uncertainty band is the unscored weight of the two leading bids: that is
 * the most the missing evidence could move them relative to each other. If the
 * gap does not clear it, the model does not get to pick.
 */
export function rankBids(model, bids = []) {
  const scored = bids
    .map((b) => ({ ...b, ...scoreBid(model, b.scores || {}) }))
    .sort((a, b) => {
      if (a.total == null && b.total == null) return 0;
      if (a.total == null) return 1;
      if (b.total == null) return -1;
      return b.total - a.total;
    })
    .map((b, i) => ({ ...b, rank: b.total == null ? null : i + 1 }));

  const ranked = scored.filter((b) => b.total != null);
  const leader = ranked[0] || null;
  const runnerUp = ranked[1] || null;

  let decision = 'recommended';
  let reason = null;
  let gap = null;
  let uncertainty = null;

  if (ranked.length < 2) {
    decision = 'insufficient_bids';
    reason = ranked.length === 1
      ? 'Only one bid has been scored. A single scored bid is not a comparison — score at least one more before selecting.'
      : 'No bid has been scored yet.';
  } else {
    gap = round1(leader.total - runnerUp.total);
    uncertainty = round1(Math.max(leader.unscored_weight_pct, runnerUp.unscored_weight_pct));

    if (leader.coverage_pct < MIN_COVERAGE_PCT) {
      decision = 'insufficient_evidence';
      reason = `Only ${leader.coverage_pct}% of the scoring model has been completed for the leading bid. Score the outstanding criteria before selecting.`;
    } else if (gap <= uncertainty) {
      decision = 'too_close_to_call';
      reason = `${leader.vendor_name || 'The leader'} is ${gap} points ahead, but ${uncertainty}% of the weight is still unscored — the missing evidence could move either bid by more than that. This is not yet a difference.`;
    }
  }

  return {
    model,
    bids: scored,
    leader: decision === 'insufficient_bids' ? null : leader,
    runner_up: runnerUp,
    gap,
    uncertainty_band: uncertainty,
    decision,
    reason,
    recommended_vendor_id: decision === 'recommended' ? leader.vendor_id : null,
  };
}

export default {
  RFX_MODELS, RFX_TYPES, MIN_COVERAGE_PCT,
  resolveModel, benchmark, scoreBid, rankBids, num,
};
