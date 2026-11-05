/**
 * tcoFreight.test.js — §216 tonne-km freight in the shared TCO engine.
 * Hand-worked: freight = Σ (qty x kg per unit / 1000) x km x rate per tonne-km.
 */
import { describe, it, expect } from 'vitest';
import { computeTco, rankOptions, modelFreight, TCO_DEFAULTS } from '../modules/procurement/engines/tcoEngine.js';
import { pickRateCard } from '../modules/procurement/services/freight.service.js';

const INERT = {
  ...TCO_DEFAULTS,
  cost_of_capital_pct: 0, inventory_carrying_pct: 0, ordering_cost_per_po: 0,
  inspection_cost_per_receipt: 0, expedite_cost_per_late_order: 0,
  rework_cost_pct: 0, default_freight_pct: 0, single_source_risk_pct: 0,
};
const NOASSUME = { ...INERT, tco_assumed_freight_enabled: false };

const lane = (over = {}) => ({ distance_km: 400, distance_source: 'observed', lane_id: 1, transport_mode: 'road', lines: [], missing: [], ...over });
const ln = (over = {}) => ({ item_id: 1, item_label: 'ITM-1', quantity: 100, quantity_uom: 'NOS',
  weight_kg_per_unit: 2.5, weight_basis: 'observed', weight_uom: 'NOS', rate_per_tonne_km: 3, rate_card_id: 9, ...over });

describe('modelFreight', () => {
  it('100 x 2.5 kg = 250 kg; 0.25 t x 400 km x Rs 3 = Rs 300', () => {
    const m = modelFreight(lane({ lines: [ln()] }));
    expect(m).toMatchObject({ complete: true, amount: 300, total_weight_kg: 250, tonne_km: 100 });
  });

  it('multi-line: TOTAL weight, each line at its own category rate', () => {
    // A: 100 x 2 kg = 0.2 t x 200 x 3 = 120;  B: 50 x 10 kg = 0.5 t x 200 x 5 = 500
    const m = modelFreight(lane({ distance_km: 200, lines: [
      ln({ item_id: 1, weight_kg_per_unit: 2, rate_per_tonne_km: 3 }),
      ln({ item_id: 2, quantity: 50, weight_kg_per_unit: 10, rate_per_tonne_km: 5 }),
    ] }));
    expect(m.amount).toBe(620);
    expect(m.total_weight_kg).toBe(700);
  });

  it('a missing line weight names the item and quantity, and gives NO amount', () => {
    const m = modelFreight(lane({ lines: [ln(), ln({ item_id: 2, item_label: 'ITM-2', quantity: 40, weight_kg_per_unit: null })] }));
    expect(m.complete).toBe(false);
    expect(m.amount).toBeNull();
    expect(m.missing).toContainEqual(expect.objectContaining({ input: 'weight', item_id: 2, item_label: 'ITM-2', quantity: 40 }));
  });

  it('respects the weight unit: kg per MTR cannot weigh a quantity in NOS', () => {
    const m = modelFreight(lane({ lines: [ln({ weight_uom: 'MTR' })] }));
    expect(m.complete).toBe(false);
    expect(m.missing[0].input).toBe('weight_uom');
  });

  it('missing distance and missing rate are each named', () => {
    const m = modelFreight(lane({ distance_km: null, lines: [ln({ rate_per_tonne_km: null })] }));
    expect(m.missing.map(x => x.input).sort()).toEqual(['distance', 'rate']);
  });

  it('an FX-blocked rate card is reported as fx, not as a missing rate', () => {
    const m = modelFreight(lane({ lines: [ln({ rate_per_tonne_km: null, rate_unavailable: { reason: 'fx', message: 'no USD rate' } })] }));
    expect(m.missing[0]).toMatchObject({ input: 'fx', message: 'no USD rate' });
  });

  it('no lines at all is not a complete zero-weight consignment', () => {
    const m = modelFreight(lane({ lines: [] }));
    expect(m.complete).toBe(false);
    expect(m.amount).toBeNull();
  });
});

describe('freight precedence and completeness in computeTco', () => {
  const opt = (over = {}) => ({ unit_price: 100, quantity: 100, freight_model: lane({ lines: [ln()] }), ...over });
  const fl = (r) => r.lines.find(l => l.label.startsWith('Freight'));

  it('modelled freight is used, labelled, and the TCO is complete', () => {
    const r = computeTco(opt(), NOASSUME);
    expect(fl(r)).toMatchObject({ amount: 300, basis: 'modelled', freight_source: 'modelled', group: 'landed' });
    expect(r.completeness).toBe('complete');
    expect(r.freight).toMatchObject({ source: 'modelled', amount: 300 });
    expect(r.freight.model).toMatchObject({ distance_km: 400, distance_source: 'observed', transport_mode: 'road' });
  });

  it('a quoted freight beats the model', () => {
    expect(fl(computeTco(opt({ freight_amount: 50 }), NOASSUME))).toMatchObject({ amount: 50, freight_source: 'quoted' });
  });

  it('the model beats observed history', () => {
    expect(fl(computeTco(opt({ freight_pct_observed: 10 }), NOASSUME)).freight_source).toBe('modelled');
  });

  it('incomplete model → observed history, complete, but the gap is still reported', () => {
    const r = computeTco(opt({ freight_model: lane({ distance_km: null, lines: [ln()] }), freight_pct_observed: 4 }), NOASSUME);
    expect(fl(r)).toMatchObject({ amount: 400, freight_source: 'observed' });
    expect(r.completeness).toBe('complete');
    expect(r.freight.missing[0].input).toBe('distance');
  });

  it('incomplete model + fallback ON → labelled "Assumed freight", PROVISIONAL', () => {
    const r = computeTco(opt({ freight_model: lane({ distance_km: null, lines: [ln()] }) }), { ...INERT, default_freight_pct: 2 });
    expect(fl(r)).toMatchObject({ amount: 200, basis: 'assumed', freight_source: 'assumed' });
    expect(fl(r).note).toMatch(/Assumed freight – 2%.*not a verified landed cost/);
    expect(r.completeness).toBe('provisional');
  });

  it('no freight at all with the fallback OFF → INCOMPLETE, never a silent zero', () => {
    const r = computeTco(opt({ freight_model: lane({ distance_km: null, lines: [ln()] }) }), NOASSUME);
    expect(fl(r)).toBeUndefined();
    expect(r.completeness).toBe('incomplete');
    expect(r.freight).toMatchObject({ source: null, amount: null });
  });

  it('modelled freight goes to a carrier, so it is NOT financed on vendor credit', () => {
    const r = computeTco(opt({ payment_terms_days: 60 }), { ...NOASSUME, cost_of_capital_pct: 12 });
    // 10,000 goods only: 10,000 x 12% x 60/365 = 197.26
    expect(r.lines.find(l => l.label === 'Credit terms benefit').amount).toBeCloseTo(-197.26, 2);
  });

  it('a foreign-currency quote does not re-convert a base-currency freight rate', () => {
    const r = computeTco(opt({ currency: 'USD', fx_rate: 84, unit_price: 1 }), NOASSUME);
    expect(fl(r).amount).toBe(300);
  });
});

describe('ranking with incomplete and provisional freight', () => {
  const full = (id, price) => ({ vendor_id: id, vendor_name: `V${id}`, unit_price: price, quantity: 100, freight_model: lane({ lines: [ln()] }) });
  const noFreight = (id, price) => ({ vendor_id: id, vendor_name: `V${id}`, unit_price: price, quantity: 100, freight_model: lane({ distance_km: null, lines: [ln()] }) });

  it('an incomplete vendor never wins, and the recommendation is withheld', () => {
    const r = rankOptions([noFreight(1, 50), full(2, 100)], NOASSUME);
    expect(r.comparison_status).toBe('incomplete');
    expect(r.best_tco_id).toBeNull();
    expect(r.options.every(o => o.is_lowest_tco === false)).toBe(true);
    expect(r.recommendation).toMatchObject({ status: 'withheld_incomplete', differs: null });
    expect(r.recommendation.incomplete[0]).toMatchObject({ vendor_id: 1 });
    expect(r.options[r.options.length - 1].vendor_id).toBe(1);
  });

  it('assumed freight ranks, but comparison and recommendation are provisional', () => {
    const r = rankOptions([noFreight(1, 50), full(2, 100)], { ...INERT, default_freight_pct: 2 });
    expect(r.comparison_status).toBe('provisional');
    expect(r.best_tco_id).toBe(1);
    expect(r.recommendation.status).toBe('provisional');
    expect(r.recommendation.message).toMatch(/not a verified landed-cost comparison/);
  });

  it('all freight known → complete, recommendation made', () => {
    const r = rankOptions([full(1, 100), full(2, 90)], NOASSUME);
    expect(r).toMatchObject({ comparison_status: 'complete', best_tco_id: 2 });
    expect(r.recommendation.status).toBe('made');
  });
});

describe('pickRateCard — most specific approved card in force', () => {
  const cards = [
    { id: 1, transport_mode: 'road', service_level: null,  freight_category: null,        effective_from: '2026-01-01' },
    { id: 2, transport_mode: 'road', service_level: 'FTL', freight_category: null,        effective_from: '2026-01-01' },
    { id: 3, transport_mode: 'road', service_level: 'FTL', freight_category: 'Hazardous', effective_from: '2026-01-01' },
    { id: 4, transport_mode: 'road', service_level: null,  freight_category: null,        effective_from: '2026-06-01' },
    { id: 5, transport_mode: 'air',  service_level: null,  freight_category: null,        effective_from: '2026-01-01' },
  ];
  it('exact service level and category win', () => {
    expect(pickRateCard(cards, { mode: 'road', serviceLevel: 'FTL', category: 'hazardous' }).id).toBe(3);
  });
  it('service level beats category-less generic', () => {
    expect(pickRateCard(cards, { mode: 'road', serviceLevel: 'FTL', category: 'General' }).id).toBe(2);
  });
  it('among equally specific cards, the latest version wins', () => {
    expect(pickRateCard(cards, { mode: 'road', serviceLevel: null, category: null }).id).toBe(4);
  });
  it('a card for another mode never applies', () => {
    expect(pickRateCard(cards, { mode: 'rail' })).toBeNull();
  });
  it('a category-specific card never applies to a different category', () => {
    expect(pickRateCard([cards[2]], { mode: 'road', serviceLevel: 'FTL', category: 'Fragile' })).toBeNull();
  });
});
