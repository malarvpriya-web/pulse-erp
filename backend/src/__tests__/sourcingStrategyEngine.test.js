import { describe, it, expect } from 'vitest';
import {
  assessFiveForces, positionOnChessboard, recommendMethods, analyseCategory,
  allMethods, findMethod, topPlays, band, CHESSBOARD, MIN_COVERAGE_PCT,
} from '../modules/procurement/engines/sourcingStrategyEngine.js';

// A category that is genuinely captive: one dominant supplier, no bench, tooled
// parts, long lead times, nobody else bidding. Used wherever a test needs the
// supply side to hold the power.
const CAPTIVE = {
  spend_12m: 4_000_000, hhi: 0.82, supplier_count: 1, top_supplier_share_pct: 92,
  single_source_item_pct: 85, avg_approved_vendors_per_item: 0.5, avg_lead_time_days: 120,
  tooled_item_pct: 70, avg_quotes_per_rfq: 1, price_spread_pct: 2,
  new_qualified_vendors_12m: 0, share_of_total_spend_pct: 2, make_option_item_pct: 0,
  avg_priced_vendors_per_item: 1, item_count: 30, po_count: 8, avg_po_value: 500_000,
};

// The mirror image: a fragmented, contested market where we are a big buyer.
const CONTESTED = {
  spend_12m: 12_000_000, hhi: 0.12, supplier_count: 11, top_supplier_share_pct: 22,
  single_source_item_pct: 0, avg_approved_vendors_per_item: 4, avg_lead_time_days: 10,
  tooled_item_pct: 0, avg_quotes_per_rfq: 6, price_spread_pct: 30,
  new_qualified_vendors_12m: 6, share_of_total_spend_pct: 35, make_option_item_pct: 40,
  avg_priced_vendors_per_item: 5, item_count: 12, po_count: 40, avg_po_value: 300_000,
};

describe('the taxonomy is the shape the framework claims', () => {
  it('is 4 quadrants x 4 levers x 4 methods', () => {
    const all = allMethods();
    expect(Object.keys(CHESSBOARD)).toHaveLength(4);
    expect(new Set(all.map((m) => m.lever_key)).size).toBe(16);
    expect(all).toHaveLength(64);
  });

  it('has no duplicate method keys — a duplicate would silently overwrite a saved strategy', () => {
    const keys = allMethods().map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every method a requirement, so nothing is proposed without saying what it needs', () => {
    for (const m of allMethods()) {
      expect(m.requires, `${m.key} has no requires`).toBeTruthy();
      expect(m.signal, `${m.key} has no signal`).toBeTruthy();
    }
  });

  it('resolves a method to its own lever and quadrant', () => {
    expect(findMethod('reverse_auction')).toMatchObject({
      lever_key: 'tendering', quadrant_key: 'leverage_competition',
    });
    expect(findMethod('does_not_exist')).toBeNull();
  });
});

describe('an unmeasured force is unrated, never neutral', () => {
  it('returns null scores and 0% coverage for a category with no data at all', () => {
    const a = assessFiveForces({});
    expect(a.coverage_pct).toBe(0);
    for (const f of a.forces) {
      expect(f.score).toBeNull();
      expect(f.basis).toBe('unrated');
      expect(f.band).toBe('Unrated');
    }
  });

  it('refuses to place an unmeasured category on the board', () => {
    // The defect this guards: defaulting an unknown force to 3 lands every
    // empty category dead-centre, which reads as a considered position.
    const p = positionOnChessboard(assessFiveForces({}));
    expect(p.quadrant_key).toBeNull();
    expect(p.demand_power).toBeNull();
    expect(p.supply_power).toBeNull();
    expect(p.provisional).toBe(true);
  });

  it('recommends nothing when there is no position to recommend against', () => {
    expect(recommendMethods(positionOnChessboard(assessFiveForces({})), {})).toEqual([]);
  });

  it('scores a force from the signals that exist and ignores the ones that do not', () => {
    const only = assessFiveForces({ hhi: 0.9 });
    const supplier = only.forces.find((f) => f.force === 'supplier_power');
    expect(supplier.score).not.toBeNull();
    expect(supplier.drivers).toHaveLength(1);
    // Nothing about competition was supplied beyond the one shared input.
    expect(only.coverage_pct).toBeLessThan(100);
  });

  it('lets the weakest provenance govern the force', () => {
    // avg_lead_time_days is master data ('estimated'); hhi is measured
    // ('observed'). A force built from both must not claim to be observed.
    const a = assessFiveForces({ hhi: 0.5, avg_lead_time_days: 60 });
    expect(a.forces.find((f) => f.force === 'supplier_power').basis).toBe('estimated');
  });
});

describe('positioning', () => {
  it('puts a captive category in Change Nature of Demand', () => {
    const p = positionOnChessboard(assessFiveForces(CAPTIVE));
    expect(p.quadrant_key).toBe('change_nature_of_demand');
    expect(p.supply_power).toBeGreaterThanOrEqual(3);
    expect(p.demand_power).toBeLessThan(3);
  });

  it('puts a contested category where we are big into Leverage Competition', () => {
    const p = positionOnChessboard(assessFiveForces(CONTESTED));
    expect(p.quadrant_key).toBe('leverage_competition');
    expect(p.supply_power).toBeLessThan(3);
    expect(p.demand_power).toBeGreaterThanOrEqual(3);
  });

  it('nets supplier power against the forces that erode it', () => {
    // Same dominant incumbent in both, but the second has five other qualified
    // vendors actively quoting. Supply power must fall, or the 2x2 is just
    // supplier count with extra steps.
    const alone = positionOnChessboard(assessFiveForces({
      hhi: 0.8, supplier_count: 1, avg_quotes_per_rfq: 1, new_qualified_vendors_12m: 0,
      avg_priced_vendors_per_item: 1, share_of_total_spend_pct: 5, spend_12m: 1_000_000,
    }));
    const contested = positionOnChessboard(assessFiveForces({
      hhi: 0.8, supplier_count: 1, avg_quotes_per_rfq: 6, new_qualified_vendors_12m: 5,
      avg_priced_vendors_per_item: 4, share_of_total_spend_pct: 5, spend_12m: 1_000_000,
    }));
    expect(contested.supply_power).toBeLessThan(alone.supply_power);
  });

  it('flags a thinly-evidenced position as provisional', () => {
    // Two of five forces: lead time feeds only supplier power, spend share only
    // buyer power. Both axes exist, so the category IS placeable — but on 40%
    // of the evidence, which is what `provisional` is for.
    const thin = positionOnChessboard(assessFiveForces({
      avg_lead_time_days: 90, share_of_total_spend_pct: 40,
    }));
    expect(thin.quadrant_key).not.toBeNull();
    expect(thin.coverage_pct).toBeLessThan(MIN_COVERAGE_PCT);
    expect(thin.provisional).toBe(true);
    expect(thin.reason).toMatch(/hypothesis/i);
  });

  it('flags a position sitting on the centre lines as borderline', () => {
    const p = positionOnChessboard({
      coverage_pct: 100,
      forces: [
        { force: 'supplier_power',   score: 3.0 },
        { force: 'buyer_power_ours', score: 3.0 },
        { force: 'rivalry',          score: 3.0 },
        { force: 'new_entrants',     score: 3.0 },
        { force: 'substitutes',      score: 3.0 },
      ],
    });
    expect(p.margin).toBe(0);
    expect(p.borderline).toBe(true);
  });
});

describe('recommendations are evidence-led', () => {
  it('only proposes methods from the category’s own quadrant', () => {
    const a = analyseCategory(CAPTIVE);
    expect(a.recommendations).toHaveLength(16);
    for (const r of a.recommendations) expect(r.quadrant_key).toBe(a.position.quadrant_key);
  });

  it('states the fact behind every evidenced play and nothing behind the rest', () => {
    for (const r of analyseCategory(CAPTIVE).recommendations) {
      if (r.evidenced) expect(r.why).toBeTruthy();
      else expect(r.why).toBeNull();
    }
  });

  it('does not fire a signal off a missing fact', () => {
    // single_source_item_pct absent — "qualify a second source" must not claim
    // sole sourcing as its evidence.
    const { single_source_item_pct, ...noSole } = CAPTIVE;
    const rec = analyseCategory(noSole).recommendations.find((r) => r.method_key === 'dual_source_qual');
    expect(rec.evidenced).toBe(false);
    expect(rec.why).toBeNull();
  });

  it('discounts fit when the position is provisional', () => {
    const solid = analyseCategory(CAPTIVE);
    const thin  = analyseCategory({ hhi: CAPTIVE.hhi, single_source_item_pct: 85, supplier_count: 1 });
    const pick = (a, k) => a.recommendations.find((r) => r.method_key === k);
    if (thin.position.quadrant_key === solid.position.quadrant_key) {
      expect(pick(thin, 'dual_source_qual').fit).toBeLessThan(pick(solid, 'dual_source_qual').fit);
    }
  });

  it('spreads the shortlist across levers instead of returning one lever four times', () => {
    const plays = topPlays(analyseCategory(CAPTIVE).recommendations, 4);
    expect(new Set(plays.map((p) => p.lever_key)).size).toBe(plays.length);
  });
});

describe('band', () => {
  it('names an absent score rather than calling it low', () => {
    expect(band(null)).toBe('Unrated');
    expect(band(1.2)).toBe('Very Low');
    expect(band(4.5)).toBe('Very High');
  });
});
