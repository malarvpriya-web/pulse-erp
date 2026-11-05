import { describe, it, expect } from 'vitest';
import { computeTco, rankOptions, resolveParams, parsePaymentTerms, TCO_DEFAULTS } from '../modules/procurement/engines/tcoEngine.js';

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

// ── §214 — spec fixtures and the defects they exposed ───────────────────────
// Expected values are worked by hand from the textbook formulas, not read back
// from the engine. Lines are apportioned to the compared lot; the horizon
// figure is lot amount x (horizon qty / lot qty).
const horizonTotal = (r, l) => l.amount * (r.horizon_qty / r.quantity);

describe('§214 spec fixtures — independently worked', () => {
  it('Test A: purchase cost = annual demand x unit price = Rs 6,000,000', () => {
    const r = computeTco({ unit_price: 500, quantity: 12000, annual_demand_qty: 12000, currency: 'INR' }, INERT);
    expect(r.lines.find(l => l.label === 'Purchase price').amount).toBe(6000000);
  });

  it('Test B: ordering = (12,000 / 1,000) x Rs 125 = 12 orders, Rs 1,500', () => {
    const r = computeTco({ unit_price: 500, quantity: 1000, annual_demand_qty: 12000 },
      { ...INERT, ordering_cost_per_po: 125 });
    expect(r.orders_in_horizon).toBe(12);
    const l = r.lines.find(x => x.label.startsWith('Ordering'));
    expect(horizonTotal(r, l)).toBe(1500);
  });

  it('Test C: cycle carrying = 1,000/2 x Rs 500 x 20% = Rs 50,000 a year', () => {
    const r = computeTco({ unit_price: 500, quantity: 1000, annual_demand_qty: 12000 },
      { ...INERT, inventory_carrying_pct: 20 });
    const l = r.lines.find(x => x.label === 'Cycle stock carrying');
    // Was 50,038.36: carrying ran on 12 x 30.44 = 365.28 days, credit on 365.
    expect(horizonTotal(r, l)).toBeCloseTo(50000, 1);
    expect(l.note).toMatch(/50000 over 12 months/);
  });

  it('the same Q/2 x v x h on a 360-day basis — the basis cancels out of carrying', () => {
    const r = computeTco({ unit_price: 500, quantity: 1000, annual_demand_qty: 12000 },
      { ...INERT, inventory_carrying_pct: 20, tco_day_count_basis: 360 });
    expect(horizonTotal(r, r.lines.find(x => x.label === 'Cycle stock carrying'))).toBeCloseTo(50000, 1);
  });
});

describe('§214 cycle stock', () => {
  it('is charged when one lot covers the whole year — 12,000/2 x 500 x 20% = Rs 600,000', () => {
    // The old guard (horizon > lot) dropped cycle stock entirely here.
    const r = computeTco({ unit_price: 500, quantity: 12000, annual_demand_qty: 12000 },
      { ...INERT, inventory_carrying_pct: 20 });
    expect(r.lines.find(x => x.label === 'Cycle stock carrying').amount).toBe(600000);
  });

  it('carries the requirement, not the MOQ-rounded order — the over-buy has its own line', () => {
    const p = { ...INERT, inventory_carrying_pct: 18 };
    const r = computeTco({ unit_price: 10, quantity: 100, moq: 5000, annual_demand_qty: 1200 }, p);
    // 100/2 x 10 x 18% x (100 / (1200/365)) / 365 = 50 x 10 x 0.18 x 30.4167/365 = 7.50
    expect(r.lines.find(x => x.label === 'Cycle stock carrying').amount).toBeCloseTo(7.5, 2);
    expect(r.lines.find(x => x.label.startsWith('MOQ'))).toBeDefined();
  });

  it('is not invented without a demand rate, and says so', () => {
    const r = computeTco({ unit_price: 10, quantity: 100 }, { ...INERT, inventory_carrying_pct: 18 });
    expect(r.lines.find(x => x.label === 'Cycle stock carrying')).toBeUndefined();
    expect(r.assumptions.some(a => /Cycle stock carrying not costed/.test(a))).toBe(true);
  });
});

describe('§214 currency', () => {
  it('refuses to score a foreign price with no exchange rate', () => {
    const r = computeTco({ unit_price: 10, currency: 'USD', quantity: 100 }, INERT);
    expect(r.computable).toBe(false);
    expect(r.reason).toBe('no_fx_rate');
    expect(r.tco_total).toBeNull();
  });

  it('converts every quoted amount, not just the unit price', () => {
    const r = computeTco({ unit_price: 10, freight_amount: 50, tooling_cost: 0, currency: 'usd', fx_rate: 84, quantity: 100 }, INERT);
    expect(r.base_total).toBe(84000);
    expect(r.lines.find(l => l.label.startsWith('Freight')).amount).toBe(4200);
    expect(r.currency).toBe('INR');
    expect(r.quoted_currency).toBe('USD');
  });

  it('never ranks USD 10 against INR 500 as raw numbers', () => {
    const ranked = rankOptions([
      { vendor_id: 1, unit_price: 10, currency: 'USD', quantity: 100 },
      { vendor_id: 2, unit_price: 500, currency: 'INR', quantity: 100 },
    ], INERT);
    // §217: the USD quote is not ranked AND — because it is an eligible bid the
    // comparison could not cost — no winner is crowned among the rest.
    expect(ranked.best_tco_id).toBeNull();
    expect(ranked.comparison_status).toBe('incomplete');
    expect(ranked.recommendation).toMatchObject({ status: 'withheld_incomplete' });
    expect(ranked.recommendation.incomplete).toEqual([expect.objectContaining({
      vendor_id: 1, reason: 'fx',
      missing: [expect.objectContaining({ input: 'fx', reason: 'no_approved_rate', currency: 'USD' })],
    })]);
    expect(ranked.recommendation.message).toMatch(/exchange rate missing/);
    expect(ranked.options.every(o => o.is_lowest_tco === false)).toBe(true);
  });

  it('§217: a STALE rate is named as stale, with its date', () => {
    const ranked = rankOptions([
      { vendor_id: 1, unit_price: 10, currency: 'USD', quantity: 100,
        fx_unavailable: { reason: 'stale', message: 'Latest approved USD rate is dated 2026-09-01', latest_rate_date: '2026-09-01' } },
      { vendor_id: 2, unit_price: 500, currency: 'INR', quantity: 100 },
    ], INERT);
    expect(ranked.recommendation.incomplete[0].missing[0]).toMatchObject({ reason: 'stale', latest_rate_date: '2026-09-01' });
  });

  it('§217: every quote converted → normal recommendation', () => {
    const ranked = rankOptions([
      { vendor_id: 1, unit_price: 5, currency: 'USD', fx_rate: 84, quantity: 100 },
      { vendor_id: 2, unit_price: 500, currency: 'INR', quantity: 100 },
    ], INERT);
    // 5 USD x 84 = Rs 420 per unit, cheaper than Rs 500 — converted and ranked.
    expect(ranked.best_tco_id).toBe(1);
    expect(ranked.comparison_status).not.toBe('incomplete');
  });

  it('§217: an UNPRICED quote (invited, no response) does not block a recommendation', () => {
    const ranked = rankOptions([
      { vendor_id: 1, unit_price: null, quantity: 100 },
      { vendor_id: 2, unit_price: 500, currency: 'INR', quantity: 100 },
    ], INERT);
    expect(ranked.best_tco_id).toBe(2);
    expect(ranked.comparison_status).not.toBe('incomplete');
  });

  it('carries the applied rate and its provenance into the breakdown (what an award freezes)', () => {
    const meta = { method: 'approved_rate', rate_id: 7, rate_date: '2026-10-29', source: 'rbi', approved_by_user_id: 3 };
    const r = computeTco({ unit_price: 10, currency: 'USD', fx_rate: 84.5, fx_meta: meta, quantity: 100 }, INERT);
    expect(r.fx).toEqual({ rate: 84.5, from: 'USD', to: 'INR', ...meta });
    expect(computeTco({ unit_price: 10, quantity: 1, currency: 'INR' }, INERT).fx).toBeNull();
  });

  it('says WHY a foreign price is not ranked', () => {
    const why = { reason: 'stale', message: 'Latest approved USD rate is 45 days old', latest_rate_date: '2026-09-15' };
    const r = computeTco({ unit_price: 10, currency: 'USD', quantity: 1, fx_unavailable: why }, INERT);
    expect(r).toMatchObject({ computable: false, reason: 'no_fx_rate', currency: 'USD', fx_detail: why });
  });

  it('states the assumption when a price carries no currency', () => {
    const r = computeTco({ unit_price: 100, quantity: 1 }, INERT);
    expect(r.assumptions.some(a => /Currency not stated/.test(a))).toBe(true);
  });
});

describe('§214 payment terms', () => {
  it.each([
    ['Net 30',                         { net_days: 30 }],
    ['Net 45',                         { net_days: 45 }],
    ['45 days from invoice',           { net_days: 45 }],
    ['2/10, net 30',                   { net_days: 30, discount_pct: 2, discount_days: 10 }],
    ['1/10 Net 30',                    { net_days: 30, discount_pct: 1, discount_days: 10 }],
    ['2% 10, Net 45',                  { net_days: 45, discount_pct: 2, discount_days: 10 }],
    ['COD',                            { net_days: 0 }],
    ['100% advance',                   { net_days: -1 }],
    ['Advance 15 days before dispatch', { net_days: -15 }],
  ])('parses %j', (text, expected) => {
    expect(parsePaymentTerms(text)).toEqual(expected);
  });

  it.each(['30% advance, balance 60 days', '', null, 'as agreed'])(
    'returns null for %j rather than inventing a day count', (text) => {
      expect(parsePaymentTerms(text)).toBeNull();
    });

  it('finances credit on what the vendor invoices — not customs duty or carrier freight', () => {
    const p = { ...INERT, cost_of_capital_pct: 12 };
    const r = computeTco({ unit_price: 100, quantity: 100, duty_amount: 3000, freight_pct_observed: 20,
      payment_terms_days: 60 }, p);
    // 10,000 goods only: 10,000 x 12% x 60/365 = 197.26 (was 295.89 on 15,000)
    expect(r.lines.find(l => l.label === 'Credit terms benefit').amount).toBeCloseTo(-197.26, 2);
  });

  it('includes freight the vendor quoted, because the vendor bills it', () => {
    const p = { ...INERT, cost_of_capital_pct: 12 };
    const r = computeTco({ unit_price: 100, quantity: 100, freight_amount: 2000, payment_terms_days: 60 }, p);
    // 12,000 x 12% x 60/365 = 236.71
    expect(r.lines.find(l => l.label === 'Credit terms benefit').amount).toBeCloseTo(-236.71, 2);
  });

  it('uses the configured day-count basis: 10,000 x 12% x 60/360 = 200', () => {
    const r = computeTco({ unit_price: 100, quantity: 100, payment_terms_days: 60 },
      { ...INERT, cost_of_capital_pct: 12, tco_day_count_basis: 360 });
    expect(r.lines.find(l => l.label === 'Credit terms benefit').amount).toBe(-200);
  });

  // 2/10 net 30 on Rs 100,000 at 12%, 365 days:
  //   discount D            = 2,000
  //   credit paying net     = 100,000 x 12% x 30/365 = 986.30
  //   credit taking it      =  98,000 x 12% x 10/365 = 322.19
  //   incremental financing = 986.30 - 322.19        = 664.11
  //   net benefit of taking = 2,000 - 664.11         = 1,335.89
  const terms = { unit_price: 1000, quantity: 100, payment_terms_days: 30, early_discount_pct: 2, early_discount_days: 10 };
  const P12 = { ...INERT, cost_of_capital_pct: 12 };

  it('takes a cash discount when it beats the credit given up, and carries ONE strategy', () => {
    const r = computeTco(terms, P12);
    expect(r.payment_terms.strategy).toBe('take_discount');
    expect(r.payment_terms.strategy_source).toBe('optimal');
    expect(r.payment_terms.discount_amount).toBe(2000);
    expect(r.payment_terms.incremental_financing_cost).toBeCloseTo(664.11, 2);
    expect(r.payment_terms.net_benefit_of_discount).toBeCloseTo(1335.89, 2);
    expect(r.lines.find(l => l.label === 'Early-payment discount').amount).toBe(-2000);
    expect(r.lines.find(l => l.label === 'Credit terms benefit').amount).toBeCloseTo(-322.19, 2);
    // Never the full discount AND the full 30-day credit.
    expect(r.tco_total).toBeCloseTo(100000 - 2000 - 322.19, 2);
  });

  it('reflects a selected pay-net strategy instead of the optimum', () => {
    const r = computeTco({ ...terms, payment_strategy: 'pay_net' }, P12);
    expect(r.payment_terms.strategy).toBe('pay_net');
    expect(r.payment_terms.strategy_source).toBe('selected');
    expect(r.lines.find(l => l.label === 'Early-payment discount')).toBeUndefined();
    expect(r.lines.find(l => l.label === 'Credit terms benefit').amount).toBeCloseTo(-986.3, 2);
  });

  it('declines the discount when capital is dearer than the discount is worth', () => {
    // 2/10 net 30 is worth ~37%/yr; at 50% cost of capital, paying net wins.
    const r = computeTco(terms, { ...INERT, cost_of_capital_pct: 50 });
    expect(r.payment_terms.strategy).toBe('pay_net');
    expect(r.payment_terms.net_benefit_of_discount).toBeLessThan(0);
  });
});

describe('resolveParams', () => {
  it('falls back to defaults for a company with no settings row', () => {
    expect(resolveParams({})).toEqual({ ...TCO_DEFAULTS, base_currency: 'INR', main_receiving_warehouse_id: null });
    expect(resolveParams(undefined)).toEqual({ ...TCO_DEFAULTS, base_currency: 'INR', main_receiving_warehouse_id: null });
  });

  it('accepts only a 360 or 365 day-count basis', () => {
    expect(resolveParams({ tco_day_count_basis: 360 }).tco_day_count_basis).toBe(360);
    expect(resolveParams({ tco_day_count_basis: 364 }).tco_day_count_basis).toBe(365);
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
