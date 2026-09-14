import { describe, it, expect } from 'vitest';
import {
  RFX_MODELS, RFX_TYPES, MIN_COVERAGE_PCT,
  resolveModel, benchmark, scoreBid, rankBids,
} from '../modules/procurement/engines/rfxScoringEngine.js';

const RFQ = resolveModel('RFQ');

/** Every criterion of a model scored at the same value — a clean baseline. */
const flat = (model, v) =>
  Object.fromEntries(model.criteria.map((c) => [c.key, { score: v, basis: 'assessed' }]));

describe('the models are well formed', () => {
  it('covers the three RFx stages', () => {
    expect(RFX_TYPES.sort()).toEqual(['RFI', 'RFP', 'RFQ']);
  });

  it('has weights summing to 100 in every default model', () => {
    for (const t of RFX_TYPES) {
      const total = RFX_MODELS[t].criteria.reduce((a, c) => a + c.weight, 0);
      expect(total, `${t} weights`).toBe(100);
    }
  });

  it('gives every criterion a key, label and help text', () => {
    for (const t of RFX_TYPES) {
      for (const c of RFX_MODELS[t].criteria) {
        expect(c.key).toBeTruthy();
        expect(c.label).toBeTruthy();
        expect(c.help, `${t}.${c.key}`).toBeTruthy();
      }
    }
  });

  it('leaves the judgement criteria for a human and marks the rest auto', () => {
    // The whole point: an RFI cannot compute capability, and must not pretend to.
    const rfi = RFX_MODELS.RFI.criteria;
    expect(rfi.find((c) => c.key === 'capability').auto).toBe(false);
    expect(rfi.find((c) => c.key === 'compliance').auto).toBe(true);
  });
});

describe('resolveModel', () => {
  it('renormalises overridden weights to 100 and says that it did', () => {
    const m = resolveModel('RFQ', [
      { key: 'cost', weight: 30 },
      { key: 'delivery', weight: 30 },
    ]);
    expect(m.renormalised).toBe(true);
    expect(m.original_weight_total).toBe(60);
    expect(m.criteria.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(100, 1);
  });

  it('leaves a valid model alone', () => {
    expect(resolveModel('RFP').renormalised).toBe(false);
  });

  it('falls back to the default rather than accepting an empty override', () => {
    expect(resolveModel('RFQ', []).criteria).toHaveLength(RFX_MODELS.RFQ.criteria.length);
    expect(resolveModel('RFQ', [{ key: 'x', weight: 0 }]).criteria.length).toBeGreaterThan(0);
  });

  it('treats an unknown type as an RFQ rather than throwing', () => {
    expect(resolveModel('NONSENSE').type).toBe('RFQ');
  });
});

describe('benchmark', () => {
  it('gives the best in field 100 and never drops the worst to zero', () => {
    const r = benchmark({ a: 100, b: 200 }, { lowerIsBetter: true });
    expect(r.a).toBe(100);
    // 8% dearer is not worthless; the floor keeps the scale honest.
    expect(r.b).toBe(30);
    expect(r.b).toBeGreaterThan(0);
  });

  it('inverts for measures where more is better', () => {
    const r = benchmark({ a: 30, b: 60 }, { lowerIsBetter: false });
    expect(r.b).toBe(100);
    expect(r.a).toBe(30);
  });

  it('scores an unquoted bid as null, not as last place', () => {
    const r = benchmark({ a: 100, b: null, c: 0 }, { lowerIsBetter: true });
    expect(r.b).toBeNull();
    expect(r.c).toBeNull(); // a zero price is a non-answer, not a free part
  });

  it('gives every bid 100 when the field is identical', () => {
    const r = benchmark({ a: 50, b: 50 });
    expect(r).toEqual({ a: 100, b: 100 });
  });

  it('returns all nulls when nothing was quoted', () => {
    expect(benchmark({ a: null, b: null })).toEqual({ a: null, b: null });
  });
});

describe('scoreBid — an unscored criterion is not a zero', () => {
  it('scores on the weight that was actually assessed', () => {
    // Only cost (45 of 100) scored, at 80. The total must be 80 — not 36, which
    // is what averaging the unscored criteria in as zero would produce.
    const r = scoreBid(RFQ, { cost: { score: 80, basis: 'benchmarked' } });
    expect(r.total).toBe(80);
    expect(r.coverage_pct).toBe(45);
    expect(r.unscored_weight_pct).toBe(55);
    expect(r.scored_criteria).toBe(1);
  });

  it('marks the missing criteria unscored rather than filling them', () => {
    const r = scoreBid(RFQ, { cost: { score: 80 } });
    const delivery = r.lines.find((l) => l.key === 'delivery');
    expect(delivery.score).toBeNull();
    expect(delivery.basis).toBe('unscored');
    expect(delivery.contribution).toBeNull();
  });

  it('returns a null total when nothing at all was scored', () => {
    const r = scoreBid(RFQ, {});
    expect(r.total).toBeNull();
    expect(r.coverage_pct).toBe(0);
  });

  it('clamps a score outside 0-100 instead of letting it skew the total', () => {
    expect(scoreBid(RFQ, flat(RFQ, 140)).total).toBe(100);
    expect(scoreBid(RFQ, flat(RFQ, -20)).total).toBe(0);
  });

  it('weights criteria by their weight, not equally', () => {
    // cost is 45, risk is 5. A great cost score must beat a great risk score.
    const costHeavy = scoreBid(RFQ, { cost: { score: 100 }, risk: { score: 0 } });
    const riskHeavy = scoreBid(RFQ, { cost: { score: 0 }, risk: { score: 100 } });
    expect(costHeavy.total).toBeGreaterThan(riskHeavy.total);
  });
});

describe('rankBids — the model does not get to launder a coin flip', () => {
  const bid = (vendor_id, vendor_name, scores) => ({ vendor_id, vendor_name, scores });

  it('recommends a clear leader on complete evidence', () => {
    const r = rankBids(RFQ, [
      bid(1, 'Alpha', flat(RFQ, 90)),
      bid(2, 'Beta', flat(RFQ, 40)),
    ]);
    expect(r.decision).toBe('recommended');
    expect(r.recommended_vendor_id).toBe(1);
    expect(r.gap).toBe(50);
    expect(r.uncertainty_band).toBe(0);
  });

  it('refuses to pick when the gap is inside the unscored uncertainty', () => {
    // Both scored on cost + delivery only (65% of the weight), 4 points apart.
    // The missing 35% could move either bid further than the gap between them.
    const partial = (v) => ({ cost: { score: v }, delivery: { score: v } });
    const r = rankBids(RFQ, [
      bid(1, 'Alpha', partial(72)),
      bid(2, 'Beta', partial(68)),
    ]);
    expect(r.gap).toBe(4);
    expect(r.uncertainty_band).toBe(35);
    expect(r.decision).toBe('too_close_to_call');
    expect(r.recommended_vendor_id).toBeNull();
    expect(r.reason).toMatch(/not yet a difference/i);
  });

  it('still names the leader for the buyer to see, even when it will not recommend', () => {
    const partial = (v) => ({ cost: { score: v }, delivery: { score: v } });
    const r = rankBids(RFQ, [bid(1, 'Alpha', partial(72)), bid(2, 'Beta', partial(68))]);
    expect(r.leader.vendor_id).toBe(1);
    expect(r.runner_up.vendor_id).toBe(2);
  });

  it('blocks on thin evidence before it even considers the gap', () => {
    // Cost alone is 45% — below the 60% floor — even with a huge lead.
    const r = rankBids(RFQ, [
      bid(1, 'Alpha', { cost: { score: 100 } }),
      bid(2, 'Beta', { cost: { score: 10 } }),
    ]);
    expect(r.leader.coverage_pct).toBeLessThan(MIN_COVERAGE_PCT);
    expect(r.decision).toBe('insufficient_evidence');
    expect(r.recommended_vendor_id).toBeNull();
  });

  it('will not call a one-horse race a comparison', () => {
    const r = rankBids(RFQ, [bid(1, 'Alpha', flat(RFQ, 90))]);
    expect(r.decision).toBe('insufficient_bids');
    expect(r.leader).toBeNull();
    expect(r.reason).toMatch(/not a comparison/i);
  });

  it('handles a field where nobody has been scored', () => {
    const r = rankBids(RFQ, [bid(1, 'Alpha', {}), bid(2, 'Beta', {})]);
    expect(r.decision).toBe('insufficient_bids');
    expect(r.bids.every((b) => b.total === null)).toBe(true);
  });

  it('sorts unscored bids to the bottom without ranking them', () => {
    const r = rankBids(RFQ, [
      bid(1, 'Unscored', {}),
      bid(2, 'Scored', flat(RFQ, 70)),
      bid(3, 'Also scored', flat(RFQ, 90)),
    ]);
    expect(r.bids[0].vendor_id).toBe(3);
    expect(r.bids[2].vendor_id).toBe(1);
    expect(r.bids[2].rank).toBeNull();
  });
});
