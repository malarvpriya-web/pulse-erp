import { describe, it, expect } from 'vitest';
import { computeTco, rankOptions, resolveParams, TCO_DEFAULTS } from '../modules/procurement/engines/tcoEngine.js';

// A deliberately inert parameter set: every rate zeroed so a test can switch ON
// exactly one cost driver and assert its arithmetic in isolation. Using the real
// defaults here would mean every assertion silently depends on eleven other rates.
const INERT = {
  ...TCO_DEFAULTS,
  cost_of_capital_pct: 0, inventory_carrying_pct: 0, ordering_cost_per_po: 0,
  inspection_cost_per_receipt: 0, expedite_cost_per_late_order: 0,
  rework_cost_pct: 0, default_freight_pct: 0, single_source_risk_pct: 0,
};

describe('computeTco — guard rails', () => {
  it('refuses to score an option with no price', () => {
    const r = computeTco({ quantity: 100 }, INERT);
    expect(r.computable).toBe(false);
    expect(r.reason).toBe('no_price');
    // The critical property: an unpriced vendor must NOT come back as 0 and win.
    expect(r.tco_total).toBeNull();
    expect(r.tco_per_unit).toBeNull();
  });

  it('refuses to score an option with no quantity', () => {
    expect(computeTco({ unit_price: 50, quantity: 0 }, INERT).computable).toBe(false);
  });

  it('treats a zero or negative price as unpriced, not as free', () => {
    expect(computeTco({ unit_price: 0, quantity: 10 }, INERT).reason).toBe('no_price');
    expect(computeTco({ unit_price: -5, quantity: 10 }, INERT).reason).toBe('no_price');
  });

  it('parses pg NUMERIC strings, which arrive as text not numbers', () => {
    const r = computeTco({ unit_price: '100.00', quantity: '10' }, INERT);
    expect(r.base_total).toBe(1000);
    expect(r.tco_total).toBe(1000);
  });

  it('with every rate zeroed, TCO collapses to the purchase price', () => {
    const r = computeTco({ unit_price: 100, quantity: 10 }, INERT);
    expect(r.tco_total).toBe(1000);
    expect(r.premium_over_price).toBe(0);
    expect(r.premium_pct).toBe(0);
  });
});

describe('computeTco — landed cost', () => {
  it('prefers a quoted freight amount over the company default rate', () => {
    const p = { ...INERT, default_freight_pct: 5 };
    const r = computeTco({ unit_price: 100, quantity: 10, freight_amount: 200 }, p);
    const freight = r.lines.find(l => l.label.startsWith('Freight'));
    expect(freight.amount).toBe(200);
    expect(freight.basis).toBe('quoted');
  });

  it('falls back to observed vendor freight before the company default', () => {
    const p = { ...INERT, default_freight_pct: 5 };
    const r = computeTco({ unit_price: 100, quantity: 10, freight_pct_observed: 3 }, p);
    const freight = r.lines.find(l => l.label.startsWith('Freight'));
    expect(freight.amount).toBe(30);              // 3% of 1000
    expect(freight.basis).toBe('observed');
  });

  it('labels a defaulted freight as assumed and says so in assumptions', () => {
    const p = { ...INERT, default_freight_pct: 2 };
    const r = computeTco({ unit_price: 100, quantity: 10 }, p);
    const freight = r.lines.find(l => l.label.startsWith('Freight'));
    expect(freight.basis).toBe('assumed');
    expect(r.assumptions.some(a => /Freight assumed/.test(a))).toBe(true);
  });

  it('adds NOTHING for tax when GST input credit is 100% — the default', () => {
    const r = computeTco({ unit_price: 100, quantity: 10, tax_pct: 18 }, INERT);
    expect(r.lines.find(l => l.label === 'Non-creditable tax')).toBeUndefined();
    expect(r.tco_total).toBe(1000);
  });

  it('charges only the non-creditable share of tax', () => {
    const p = { ...INERT, gst_input_credit_pct: 50 };
    const r = computeTco({ unit_price: 100, quantity: 10, tax_pct: 18 }, p);
    // 1000 goods x 18% = 180 tax, half of it stuck = 90
    expect(r.lines.find(l => l.label === 'Non-creditable tax').amount).toBe(90);
  });

  it('pro-rates an order-level freight quote onto the compared quantity when MOQ forces a bigger order', () => {
    // 1000 freight quoted on an order of 1000 units, but only 100 are needed:
    // charging the whole 1000 to a 100-unit comparison would be wrong.
    const r = computeTco({ unit_price: 10, quantity: 100, moq: 1000, freight_amount: 1000 }, INERT);
    expect(r.lines.find(l => l.label.startsWith('Freight')).amount).toBe(100);
  });
});

describe('computeTco — ownership', () => {
  it('charges pipeline carrying for the lead time', () => {
    const p = { ...INERT, inventory_carrying_pct: 18 };
    const r = computeTco({ unit_price: 100, quantity: 100, lead_time_days: 365 }, p);
    // 10,000 landed x 18%/yr x 365/365 days = 1800
    expect(r.lines.find(l => l.label.startsWith('Pipeline')).amount).toBeCloseTo(1800, 0);
  });

  it('charges MOQ over-buy carrying, so a big-minimum vendor is not free', () => {
    const p = { ...INERT, inventory_carrying_pct: 18 };
    const need = computeTco({ unit_price: 10, quantity: 100, moq: 100, annual_demand_qty: 1200 }, p);
    const bulk = computeTco({ unit_price: 10, quantity: 100, moq: 5000, annual_demand_qty: 1200 }, p);
    expect(need.lines.find(l => l.label.startsWith('MOQ'))).toBeUndefined();
    expect(bulk.lines.find(l => l.label.startsWith('MOQ')).amount).toBeGreaterThan(0);
    expect(bulk.excess_qty).toBe(4900);
  });

  it('credits payment terms as a NEGATIVE cost — credit is worth money', () => {
    const p = { ...INERT, cost_of_capital_pct: 12 };
    const r = computeTco({ unit_price: 100, quantity: 100, payment_terms_days: 60 }, p);
    const terms = r.lines.find(l => l.label === 'Credit terms benefit');
    expect(terms.amount).toBeLessThan(0);
    // 10,000 x 12% x 60/365 = 197.26
    expect(terms.amount).toBeCloseTo(-197.26, 1);
    expect(r.tco_total).toBeLessThan(r.base_total);
  });

  it('charges advance payment as a positive cost', () => {
    const p = { ...INERT, cost_of_capital_pct: 12 };
    const r = computeTco({ unit_price: 100, quantity: 100, payment_terms_days: -30 }, p);
    const terms = r.lines.find(l => l.label === 'Advance payment cost');
    expect(terms.amount).toBeGreaterThan(0);
  });

  it('charges rejects at landed cost plus rework handling', () => {
    const p = { ...INERT, rework_cost_pct: 25 };
    const r = computeTco({ unit_price: 100, quantity: 100, reject_rate_pct: 2, reject_basis: 'observed' }, p);
    const q = r.lines.find(l => l.label.startsWith('Rejection'));
    // 2 units x 100 landed x 1.25 = 250
    expect(q.amount).toBe(250);
    expect(q.basis).toBe('observed');
  });

  it('does NOT invent a quality cost when no reject rate is on record, and says so', () => {
    const r = computeTco({ unit_price: 100, quantity: 100 }, INERT);
    expect(r.lines.find(l => l.label.startsWith('Rejection'))).toBeUndefined();
    expect(r.assumptions.some(a => /No reject rate/.test(a))).toBe(true);
  });
});

describe('computeTco — risk', () => {
  it('charges expediting proportional to the late share', () => {
    const p = { ...INERT, expedite_cost_per_late_order: 2500 };
    const good = computeTco({ unit_price: 100, quantity: 100, on_time_pct: 100 }, p);
    const bad  = computeTco({ unit_price: 100, quantity: 100, on_time_pct: 60 }, p);
    expect(good.lines.find(l => l.label.startsWith('Expediting'))).toBeUndefined();
    expect(bad.lines.find(l => l.label.startsWith('Expediting')).amount).toBe(1000); // 1 order x 40% x 2500
  });

  it('prices single-source exposure only when the flag is set', () => {
    const p = { ...INERT, single_source_risk_pct: 2 };
    expect(computeTco({ unit_price: 100, quantity: 100 }, p)
      .lines.find(l => l.label.startsWith('Single-source'))).toBeUndefined();
    expect(computeTco({ unit_price: 100, quantity: 100, is_single_source: true }, p)
      .lines.find(l => l.label.startsWith('Single-source')).amount).toBe(200);
  });
});

describe('computeTco — provenance and confidence', () => {
  it('reports high confidence when every driver is quoted or observed', () => {
    const r = computeTco({
      unit_price: 100, quantity: 100, freight_amount: 500, tax_pct: 0,
      reject_rate_pct: 1, reject_basis: 'observed',
      on_time_pct: 95, on_time_basis: 'observed',
      lead_time_days: 20, lead_time_basis: 'quoted',
      payment_terms_days: 45, payment_terms_basis: 'quoted',
    }, INERT);
    expect(r.confidence).toBeGreaterThan(90);
  });

  it('reports low confidence when the number is mostly rate card', () => {
    const p = { ...TCO_DEFAULTS };   // real defaults: ordering + inspection are 'assumed'
    const r = computeTco({ unit_price: 10, quantity: 10 }, p);
    expect(r.confidence).toBeLessThan(70);
    expect(r.assumptions.length).toBeGreaterThan(2);
  });
});

describe('rankOptions — the decision', () => {
  // The scenario this whole feature exists for: vendor B quotes 4% cheaper but
  // has a 90-day lead, a 3% reject rate, 50% on-time and demands advance payment.
  const A = {
    vendor_id: 1, vendor_name: 'Reliable Components',
    unit_price: 104, quantity: 1000, lead_time_days: 15,
    reject_rate_pct: 0.2, reject_basis: 'observed',
    on_time_pct: 98, on_time_basis: 'observed',
    payment_terms_days: 60, annual_demand_qty: 12000,
  };
  const B = {
    vendor_id: 2, vendor_name: 'Cheap Imports',
    unit_price: 100, quantity: 1000, lead_time_days: 90,
    reject_rate_pct: 3, reject_basis: 'observed',
    on_time_pct: 50, on_time_basis: 'observed',
    payment_terms_days: -30, annual_demand_qty: 12000,
  };

  it('ranks by TCO, not by unit price', () => {
    const r = rankOptions([A, B], TCO_DEFAULTS);
    expect(r.best_price_id).toBe(2);            // B is the cheaper quote
    expect(r.best_tco_id).toBe(1);              // A is the cheaper buy
    expect(r.options[0].vendor_id).toBe(1);     // sorted TCO-ascending
  });

  it('flags that the cheapest quote is not the cheapest option, with the money', () => {
    const r = rankOptions([A, B], TCO_DEFAULTS);
    expect(r.recommendation.differs).toBe(true);
    expect(r.recommendation.lowest_price_label).toBe('Cheap Imports');
    expect(r.recommendation.lowest_tco_label).toBe('Reliable Components');
    expect(r.recommendation.tco_saving).toBeGreaterThan(0);
    // The premium the buyer has to justify: A's quote is 4% above B's.
    expect(r.recommendation.price_gap_pct).toBeCloseTo(4, 1);
  });

  it('says so plainly when the cheapest quote IS the best buy', () => {
    const r = rankOptions([A, { ...B, unit_price: 60 }], TCO_DEFAULTS);
    expect(r.best_tco_id).toBe(2);
    expect(r.recommendation.differs).toBe(false);
  });

  it('sinks unpriced options to the bottom and never lets one win', () => {
    const r = rankOptions([{ vendor_id: 9, vendor_name: 'No Quote', quantity: 1000 }, A], TCO_DEFAULTS);
    expect(r.best_tco_id).toBe(1);
    expect(r.options[r.options.length - 1].vendor_id).toBe(9);
    expect(r.options[r.options.length - 1].is_lowest_tco).toBe(false);
  });

  it('handles an empty list without throwing', () => {
    const r = rankOptions([], TCO_DEFAULTS);
    expect(r.options).toEqual([]);
    expect(r.best_tco_id).toBeNull();
    expect(r.recommendation).toBeNull();
    expect(r.tco_spread_pct).toBe(0);
  });

  it('reports the TCO spread — how much the sourcing decision is worth', () => {
    const r = rankOptions([A, B], TCO_DEFAULTS);
    expect(r.tco_spread_pct).toBeGreaterThan(0);
  });
});

describe('resolveParams', () => {
  it('falls back to defaults for a company with no settings row', () => {
    expect(resolveParams({})).toEqual(TCO_DEFAULTS);
    expect(resolveParams(undefined)).toEqual(TCO_DEFAULTS);
  });

  it('accepts pg NUMERIC strings from the settings row', () => {
    expect(resolveParams({ cost_of_capital_pct: '9.500' }).cost_of_capital_pct).toBe(9.5);
  });

  it('clamps a negative rate — it would turn carrying cost into a rebate and invert every ranking', () => {
    expect(resolveParams({ inventory_carrying_pct: -20 }).inventory_carrying_pct).toBe(0);
    expect(resolveParams({ cost_of_capital_pct: 900 }).cost_of_capital_pct).toBe(100);
  });

  it('keeps a legitimate zero rate rather than treating it as absent', () => {
    expect(resolveParams({ cost_of_capital_pct: 0 }).cost_of_capital_pct).toBe(0);
  });
});
