/**
 * tcoEngine.js — Total Cost of Ownership for a component purchase.
 *
 * WHY THIS EXISTS
 * Every comparison surface in the app ranked vendors on `unit_price`: the RFQ
 * award modal badges "Lowest" off MIN(unit_price) and Component 360 sorts its
 * vendor table by `best_price`. Unit price is what you pay the vendor; it is not
 * what the part costs the company. The cheapest quote routinely loses once the
 * lead time, the reject rate, the MOQ you have to over-buy and the credit terms
 * you do (or do not) get are priced in. This engine puts a number on that so a
 * buyer can compare BEFORE raising the PO, not discover it in the variance
 * report six months later.
 *
 * THE MODEL — four cost groups, the way a buyer already thinks:
 *
 *   ACQUISITION  what the vendor invoices
 *                net price x qty, plus one-time tooling/NRE amortised over the
 *                horizon's volume.
 *
 *   LANDED       what it costs to get it through the gate
 *                freight, insurance, customs duty, packaging, other charges,
 *                and the NON-CREDITABLE share of tax. In India input GST is
 *                normally fully creditable, so at the 100%-credit default tax
 *                contributes ZERO to TCO — deliberately, because adding a
 *                recoverable tax to a comparison is the single most common way
 *                a landed-cost model lies.
 *
 *   OWNERSHIP    what it costs to hold and process
 *                pipeline (in-transit) carrying, cycle-stock carrying, safety
 *                stock carried because the lead time is long/unreliable,
 *                MOQ over-buy carrying, per-PO ordering cost, incoming
 *                inspection, scrap+rework on rejects, minus the financing
 *                BENEFIT of credit terms (a negative cost — 60-day terms are
 *                worth real money and no price-only comparison sees it).
 *
 *   RISK         what the exposure is worth
 *                expediting on the share of orders that arrive late, plus a
 *                single-source premium where the vendor is the only source.
 *
 * PROVENANCE IS PART OF THE OUTPUT. Every line carries `basis`:
 *   'quoted'    — the vendor gave us this number
 *   'observed'  — measured from our own GRN/PO history with this vendor
 *   'estimated' — modelled from company rates and vendor master data
 *   'assumed'   — nothing to go on; the company default was applied
 * A TCO whose provenance is invisible is worse than no TCO, because it looks
 * authoritative. `confidence` summarises how much of the number is real.
 *
 * Pure functions. No DB, no I/O — see tcoService.js for the data loading.
 */

// pg returns NUMERIC as a string and NULL as null. `null` must survive as null
// so callers can render an em-dash instead of a misleading 0
// (project_pg_count_string_nan_bug).
export function num(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const clamp  = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** The currency every TCO is expressed in. Quotes in another currency need an
 *  explicit exchange rate; they are never ranked against INR as raw numbers. */
export const BASE_CURRENCY = 'INR';

/** Annual day-count conventions the engine accepts. */
export const DAY_COUNT_BASES = Object.freeze([360, 365]);

/** Company costing rates. Mirrors the procurement_settings TCO columns. */
export const TCO_DEFAULTS = Object.freeze({
  tco_enabled:                  true,
  cost_of_capital_pct:          12,    // annual — finances inventory and credit terms
  inventory_carrying_pct:       18,    // annual — capital + storage + insurance + obsolescence
  ordering_cost_per_po:         750,   // raise/approve/follow-up/3-way-match, per PO
  inspection_cost_per_receipt:  500,   // incoming QC, per receipt
  expedite_cost_per_late_order: 2500,  // chasing, part loads, line stoppage
  rework_cost_pct:              25,    // % of unit price to rework/replace a reject
  // "Assumed freight": the labelled last resort when freight is neither quoted,
  // modelled from weight x distance x rate, nor observed. Switchable (§216);
  // when off, an option with no freight is INCOMPLETE and never wins.
  tco_assumed_freight_enabled:  true,
  default_freight_pct:          2,
  gst_input_credit_pct:         100,   // 100 = fully recoverable, so tax is not a cost
  single_source_risk_pct:       2,     // premium on spend with a sole source
  service_level_z:              1.65,  // ~95% service level for safety stock
  tco_horizon_months:           12,
  // Days in a year for every time-based rate: carrying, credit terms, early-
  // payment financing. One basis for all of them — mixing 365 for financing
  // with 12 x 30.44 = 365.28 for carrying put Q/2 x v x h off by 0.08%.
  tco_day_count_basis:          365,
  // An approved exchange rate older than this (days, relative to the
  // comparison date) is stale and is not used — the quote shows "needs
  // exchange rate" instead of being converted at last month's number.
  tco_fx_max_age_days:          30,
});

/** Merge a procurement_settings row (or nothing) over the defaults. */
export function resolveParams(row = {}) {
  const p = { ...TCO_DEFAULTS };
  for (const k of Object.keys(TCO_DEFAULTS)) {
    if (row[k] == null) continue;
    p[k] = typeof TCO_DEFAULTS[k] === 'boolean' ? !!row[k] : num(row[k], TCO_DEFAULTS[k]);
  }
  // A settings row with 0 cost of capital is legitimate; a negative one is a
  // typo that would turn carrying cost into a rebate and invert the ranking.
  p.cost_of_capital_pct    = clamp(p.cost_of_capital_pct,    0, 100);
  p.inventory_carrying_pct = clamp(p.inventory_carrying_pct, 0, 100);
  p.gst_input_credit_pct   = clamp(p.gst_input_credit_pct,   0, 100);
  p.rework_cost_pct        = clamp(p.rework_cost_pct,        0, 500);
  p.tco_horizon_months     = clamp(Math.round(p.tco_horizon_months) || 12, 1, 120);
  if (!DAY_COUNT_BASES.includes(p.tco_day_count_basis)) p.tco_day_count_basis = TCO_DEFAULTS.tco_day_count_basis;
  p.tco_fx_max_age_days = clamp(Math.round(p.tco_fx_max_age_days) || TCO_DEFAULTS.tco_fx_max_age_days, 1, 366);
  // Not a settings column: the company's reporting currency. Callers may pass
  // it; everything else assumes INR.
  p.base_currency = String(row.base_currency || BASE_CURRENCY).trim().toUpperCase();
  // Not a rate: where freight lanes end when an RFQ/PO names no warehouse (§216).
  p.main_receiving_warehouse_id = row.main_receiving_warehouse_id == null ? null : Number(row.main_receiving_warehouse_id);
  return p;
}

// 'modelled' (§216): computed from recorded inputs — weight x distance x an
// approved rate — each of which carries its own provenance on the line.
const BASIS_WEIGHT = { quoted: 1, observed: 1, modelled: 0.75, estimated: 0.5, assumed: 0.15 };

/** Freight sources, in order of precedence. Never conflated. */
export const FREIGHT_SOURCES = Object.freeze(['quoted', 'modelled', 'observed', 'assumed']);

/**
 * modelFreight(model, base) — pure tonne-km freight.
 *
 *   freight = Σ over lines ( qty x kg-per-unit / 1000 ) x distance_km x rate_per_tonne_km
 *
 * `model` (built by tco.service.loadFreightInputs):
 *   { distance_km, distance_source, lane_id, transport_mode, service_level,
 *     lines: [{ item_id, item_label, quantity, quantity_uom,
 *               weight_kg_per_unit, weight_basis, weight_uom,
 *               freight_category, rate_per_tonne_km (BASE currency),
 *               rate_card_id, rate_currency, rate_fx, rate_source }],
 *     missing: [{ input, ... }]   // inputs the loader could not find }
 *
 * Returns { complete, amount|null, tonne_km, total_weight_kg, missing[], lines[] }.
 * A model with ANY missing input is not complete and has no amount — a partial
 * sum would read as a full freight bill for a lighter consignment.
 */
/** Note suffix for freight quoted in a currency other than the quote's (§219). */
function fxNoteOf(option) {
  const f = option.freight_fx;
  return f ? ` (vendor quoted ${f.as_quoted.freight_amount ?? f.as_quoted.freight_per_unit} ${f.from}${f.as_quoted.freight_per_unit != null ? ' per unit' : ''}; restated in ${f.to} at an approved rate)` : '';
}

export function modelFreight(model) {
  if (!model) return { complete: false, amount: null, missing: [{ input: 'freight_model', message: 'No freight inputs were loaded.' }], lines: [] };
  const missing = [...(model.missing || [])];
  const km = num(model.distance_km);
  if (km == null || km <= 0) {
    if (!missing.some(m => m.input === 'distance')) missing.push({ input: 'distance', message: 'No confirmed lane distance for this vendor and receiving point.' });
  }
  const lines = [];
  let weight = 0;
  let amount = 0;
  for (const l of model.lines || []) {
    const qty = num(l.quantity);
    const w = num(l.weight_kg_per_unit);
    const rate = num(l.rate_per_tonne_km);
    const label = l.item_label || (l.item_id ? `item #${l.item_id}` : 'an uncatalogued line');
    if (w == null || w <= 0) {
      missing.push({ input: 'weight', item_id: l.item_id ?? null, item_label: label, quantity: qty,
        message: `No shipping weight for ${label} (${qty ?? '?'} ${l.quantity_uom || 'units'}).` });
    } else if (l.weight_uom && l.quantity_uom && String(l.weight_uom).toUpperCase() !== String(l.quantity_uom).toUpperCase()) {
      missing.push({ input: 'weight_uom', item_id: l.item_id ?? null, item_label: label, quantity: qty,
        message: `${label}: weight is per ${l.weight_uom} but the quantity is in ${l.quantity_uom}; no conversion is recorded.` });
    }
    if (rate == null || rate <= 0) {
      if (!l.rate_missing_reported) {
        missing.push({ input: l.rate_unavailable?.reason === 'fx' ? 'fx' : 'rate', item_id: l.item_id ?? null, item_label: label,
          message: l.rate_unavailable?.message || `No approved ${model.transport_mode || ''} rate card for ${l.freight_category || 'this item\'s category'}.`.replace('  ', ' ') });
      }
    }
    const lineKg = qty != null && w != null ? qty * w : null;
    if (lineKg != null) weight += lineKg;
    const lineAmount = lineKg != null && km != null && rate != null ? (lineKg / 1000) * km * rate : null;
    if (lineAmount != null) amount += lineAmount;
    lines.push({ ...l, line_weight_kg: lineKg == null ? null : round4(lineKg), amount: lineAmount == null ? null : round2(lineAmount) });
  }
  if (!(model.lines || []).length && !missing.some(m => m.input === 'weight')) {
    missing.push({ input: 'weight', message: 'No catalogued item lines to weigh.' });
  }
  const complete = missing.length === 0;
  return {
    complete,
    amount: complete ? amount : null,
    total_weight_kg: round4(weight),
    tonne_km: km != null ? round4((weight / 1000) * km) : null,
    distance_km: km, distance_source: model.distance_source ?? null, lane_id: model.lane_id ?? null,
    lane_confirmed_by_user_id: model.lane_confirmed_by_user_id ?? null,
    receiving_warehouse_id: model.receiving_warehouse_id ?? null, receiving_warehouse: model.receiving_warehouse ?? null,
    transport_mode: model.transport_mode ?? null, service_level: model.service_level ?? null,
    missing, lines,
    formula: 'Σ (qty x kg per unit / 1000) x distance km x rate per tonne-km',
  };
}

function line(label, group, amount, basis, note) {
  return { label, group, amount: round2(amount || 0), basis, note: note || null };
}

/**
 * parsePaymentTerms(text) — free-text terms into { net_days, discount_pct,
 * discount_days }, or null when the text cannot be read.
 *
 *   "Net 45"            → { net_days: 45 }
 *   "2/10, net 30"      → { net_days: 30, discount_pct: 2, discount_days: 10 }
 *   "100% advance"      → { net_days: -1 }   (advance; exact days unknown)
 *   "COD" / "immediate" → { net_days: 0 }
 *
 * The old parser took the FIRST number in the string, so "2/10, net 30" read
 * as 2 days' credit and "30% advance, balance 60 days" as a 30-day advance.
 * A split advance/credit term has no single day count, so it returns null —
 * the engine then credits nothing and says so, instead of inventing a figure.
 */
export function parsePaymentTerms(text) {
  if (text == null) return null;
  const s = String(text).trim().toLowerCase();
  if (!s) return null;

  // a/b net c — cash discount a% if paid within b days, otherwise due in c.
  // Separator is "/" or "%": "2/10 net 30", "2%/10 n/30", "2% 10 days, net 45".
  const cash = s.match(/(\d+(?:\.\d+)?)\s*(?:%\s*\/?|\/)\s*(\d{1,3})\s*(?:days?)?\s*,?\s*(?:n|net)\s*\/?\s*(\d{1,3})/);
  if (cash) {
    const [pct, dDays, nDays] = [parseFloat(cash[1]), parseInt(cash[2], 10), parseInt(cash[3], 10)];
    if (pct > 0 && pct < 100 && dDays < nDays && nDays <= 365) {
      return { net_days: nDays, discount_pct: pct, discount_days: dDays };
    }
    return null;
  }

  const isAdvance = /\b(advance|prepaid|pia|payment in advance)\b/.test(s);
  if (isAdvance) {
    // "30% advance, balance 60 days" is two terms at once — not one number.
    const pct = s.match(/(\d{1,3})\s*%/);
    if (pct && parseInt(pct[1], 10) < 100) return null;
    const days = s.match(/(\d{1,3})\s*days?/);
    return { net_days: days ? -Math.abs(parseInt(days[1], 10)) : -1 };
  }
  if (/\b(cod|cash on delivery|immediate|against delivery)\b/.test(s)) return { net_days: 0 };

  if (/%/.test(s)) return null;
  const m = s.match(/(?:net\s*)?(\d{1,3})\s*(?:days?)?/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  return Number.isFinite(d) && d >= 0 && d <= 365 ? { net_days: d } : null;
}

/** Financing on an amount held for `days`: amount x annual rate x days / basis. */
export function financingAmount(amount, annualRatePct, days, dayBasis = TCO_DEFAULTS.tco_day_count_basis) {
  return amount * (annualRatePct / 100) * (days / dayBasis);
}

/**
 * computeTco(option, params)
 *
 * `option` — one purchasing choice (a vendor's quote, price-book entry, or last
 * PO rate) for ONE component:
 *
 *   REQUIRED
 *     unit_price          net price per unit, after discount, in company currency
 *     quantity            the quantity being compared (the RFQ/PR line qty)
 *
 *   QUOTED ADDERS (null = not quoted; the engine estimates and says so)
 *     freight_amount, insurance_amount, duty_amount, packaging_amount,
 *     other_charges       order-level amounts
 *     freight_per_unit, packaging_per_unit   per-unit alternatives
 *     tooling_cost        one-time NRE/tooling, amortised over horizon volume
 *     tax_pct             e.g. 18 for GST 18%
 *     duty_pct            import duty %, used when duty_amount is absent
 *
 *   SUPPLY TERMS
 *     lead_time_days      quoted delivery days, else the vendor/item lead time
 *     lead_time_basis     'quoted' | 'observed' | 'estimated' | 'assumed'
 *     moq, pack_size      minimum order / pack rounding
 *     payment_terms_days  credit days (>0 = we get credit, <0 = advance)
 *
 *   PERFORMANCE (observed beats master-data)
 *     reject_rate_pct     % rejected at GRN
 *     reject_basis        'observed' when measured from grn_items
 *     on_time_pct         % of receipts on time
 *     on_time_basis
 *     is_single_source
 *
 *   ITEM CONTEXT
 *     annual_demand_qty   for horizon volume and order frequency
 *     holding_cost_pct    item-level override of inventory_carrying_pct
 *     freight_pct_observed vendor's historical freight as % of order value,
 *                          measured over COSTED orders only (0 is a real
 *                          measurement: they deliver free. null is "no data")
 *     freight_sample_orders how many costed orders that ratio came from, named
 *                          in the line's note so a buyer can weigh it
 *
 * Returns a breakdown with per-unit and total figures, `lines[]` with basis, a
 * `confidence` 0-100, and `assumptions[]` naming every modelled input.
 */
export function computeTco(rawOption = {}, params = TCO_DEFAULTS) {
  const p = resolveParams(params);
  const dayBasis = p.tco_day_count_basis;

  const uncomputable = (reason, extra = {}) => ({
    computable: false, reason,
    quantity: Math.max(num(rawOption.quantity, 0) || 0, 0), unit_price: num(rawOption.unit_price),
    tco_total: null, tco_per_unit: null, base_total: null,
    premium_over_price: null, premium_pct: null,
    groups: null, lines: [], confidence: 0, assumptions: [], ...extra,
  });

  const assumptions = [];
  const lines = [];
  const assume = (what) => { if (!assumptions.includes(what)) assumptions.push(what); };

  // ── Currency: every amount must be in the base currency before anything is
  //    added up. A USD 10 quote ranked against an INR 500 quote as raw numbers
  //    "won" by a factor of 50. A foreign quote with no exchange rate is not
  //    scored at all — guessing a rate would decide the award.
  const currency = rawOption.currency ? String(rawOption.currency).trim().toUpperCase() : null;
  let option = rawOption;
  let fxRate = 1;
  if (currency && currency !== p.base_currency) {
    fxRate = num(rawOption.fx_rate);
    if (fxRate == null || fxRate <= 0) {
      // fx_unavailable says WHY (no approved rate, stale, not yet reviewed) so
      // the screen can tell Finance what to fix rather than show a bare dash.
      return uncomputable('no_fx_rate', {
        currency, base_currency: p.base_currency, fx_detail: rawOption.fx_unavailable ?? null,
      });
    }
    const AMOUNT_KEYS = ['unit_price', 'freight_amount', 'insurance_amount', 'duty_amount',
      'packaging_amount', 'other_charges', 'freight_per_unit', 'packaging_per_unit', 'tooling_cost'];
    option = { ...rawOption };
    for (const k of AMOUNT_KEYS) {
      const v = num(rawOption[k]);
      if (v != null) option[k] = v * fxRate;
    }
    assume(`Quoted in ${currency}; converted at ${fxRate} ${p.base_currency} per ${currency}${rawOption.fx_rate_source ? ` (${rawOption.fx_rate_source})` : ''}.`);
  } else if (!currency) {
    assume(`Currency not stated on this price - taken as ${p.base_currency}.`);
  }
  // §219: the vendor quoted freight in a currency with no usable approved rate.
  // That freight is real and quoted, so it is neither dropped nor replaced by a
  // modelled figure — the quote cannot be costed, and says why.
  if (rawOption.charges_fx_unavailable) {
    return uncomputable('no_fx_rate', {
      currency: rawOption.charges_fx_unavailable.currency, base_currency: p.base_currency,
      fx_detail: rawOption.charges_fx_unavailable,
    });
  }

  const unitPrice = num(option.unit_price);
  const qty       = Math.max(num(option.quantity, 0) || 0, 0);

  // No price means no TCO. Returning zeros would rank an unpriced vendor as the
  // cheapest option on the page — the exact failure this engine exists to stop.
  if (unitPrice == null || unitPrice <= 0 || qty <= 0) {
    return uncomputable(unitPrice == null || unitPrice <= 0 ? 'no_price' : 'no_quantity');
  }

  const baseTotal = unitPrice * qty;

  // ── Horizon volume: how much of this part we buy over the TCO window ──────
  // One-time costs (tooling) and per-order costs (ordering, inspection) only
  // become comparable once spread over the same volume for every vendor.
  const annualDemand = num(option.annual_demand_qty);
  const horizonQty = annualDemand != null && annualDemand > 0
    ? annualDemand * (p.tco_horizon_months / 12)
    : qty;
  if (annualDemand == null || annualDemand <= 0) {
    assume('Horizon volume taken as the compared quantity - no annual demand on the item, so one-time costs are not spread over repeat buys.');
  }
  // Scale factor from horizon-level costs back onto the compared quantity.
  const horizonShare = horizonQty > 0 ? qty / horizonQty : 1;

  // Horizon-level costs (ordering, inspection, tooling, safety stock) are
  // incurred across the whole horizon but only a share of them belongs to the
  // quantity being compared. The note must say both figures — quoting the
  // horizon total next to an apportioned amount reads as an arithmetic error
  // and destroys trust in the whole breakdown.
  const overHorizon = (basis, horizonAmount) =>
    horizonShare < 0.999
      ? `${basis}; ${round2(horizonAmount)} over ${p.tco_horizon_months} months, apportioned to these ${round2(qty)} units`
      : basis;

  // ── Order sizing: MOQ / pack rounding, and how many POs the horizon needs ─
  const moq      = num(option.moq, 0) || 0;
  const packSize = num(option.pack_size, 0) || 0;
  let orderQty = qty;
  if (moq > orderQty) orderQty = moq;
  if (packSize > 0) orderQty = Math.ceil(orderQty / packSize) * packSize;
  const excessQty = Math.max(0, orderQty - qty);

  // Share of one order that the compared quantity represents — order-level
  // quoted amounts (freight on the consignment, insurance) must be pro-rated
  // onto it, or a vendor with a big MOQ gets charged the whole freight bill
  // for a small requirement.
  const orderShare = orderQty > 0 ? qty / orderQty : 1;

  const ordersInHorizon = orderQty > 0 ? Math.max(1, horizonQty / orderQty) : 1;

  // ═══ ACQUISITION ════════════════════════════════════════════════════════
  lines.push(line('Purchase price', 'acquisition', baseTotal, 'quoted',
    `${qty} x ${round4(unitPrice)}`));

  // MOQ over-buy is NOT charged as price - you will eventually consume those
  // units. It is charged as carrying cost below, which is what it really is.
  const toolingCost = num(option.tooling_cost, 0) || 0;
  if (toolingCost > 0) {
    lines.push(line('Tooling / one-time setup', 'acquisition', toolingCost * horizonShare, 'quoted',
      `one-time ${round2(toolingCost)} amortised over ${round2(horizonQty)} units in the horizon`));
  }

  // ═══ LANDED ═════════════════════════════════════════════════════════════
  // Freight, in order (§216): quoted amount → quoted per unit → MODELLED
  // (weight x distance x approved rate) → observed history → "Assumed freight"
  // (only if the company keeps that fallback on) → none, which makes the
  // option INCOMPLETE. `freightSource` keeps the four kinds apart everywhere.
  let freight = 0, freightBasis = null, freightNote = null, freightSource = null;
  const model = option.freight_model ? modelFreight(option.freight_model) : null;
  if (num(option.freight_amount) != null) {
    freight = num(option.freight_amount) * orderShare;
    freightBasis = 'quoted'; freightSource = 'quoted'; freightNote = 'quoted on the order' + fxNoteOf(option);
  } else if (num(option.freight_per_unit) != null) {
    freight = num(option.freight_per_unit) * qty;
    freightBasis = 'quoted'; freightSource = 'quoted'; freightNote = 'quoted per unit' + fxNoteOf(option);
  } else if (model?.complete) {
    freight = model.amount;
    freightBasis = 'modelled'; freightSource = 'modelled';
    const rates = [...new Set(model.lines.map(l => round4(l.rate_per_tonne_km)))];
    freightNote = `${round4(model.total_weight_kg)} kg / 1000 x ${model.distance_km} km (${model.distance_source}) x `
      + `${rates.length === 1 ? `${rates[0]}` : 'line rates'} per tonne-km, ${model.transport_mode}${model.service_level ? ` ${model.service_level}` : ''}`;
  } else if (num(option.freight_pct_observed) != null && num(option.freight_pct_observed) >= 0) {
    freightSource = 'observed';
    // `>= 0`: a measured zero means this vendor delivers free, which is a real
    // advantage. Treating it as "no data" and charging them the assumed company
    // rate instead penalised the only vendor who does not bill for carriage.
    // The service only populates this field for vendors with at least one
    // COSTED order, so an absent measurement is still absent (null), never 0.
    const pct = num(option.freight_pct_observed);
    freight = baseTotal * (pct / 100);
    freightBasis = 'observed';
    const sample = num(option.freight_sample_orders);
    const over = sample != null && sample > 0
      ? ` across ${Math.round(sample)} costed order${Math.round(sample) === 1 ? '' : 's'}`
      : '';
    freightNote = pct === 0
      ? `carried free on this vendor's past POs${over}`
      : `${round2(pct)}% of value on this vendor's past POs${over}`;
  } else if (p.tco_assumed_freight_enabled) {
    freight = baseTotal * (p.default_freight_pct / 100);
    freightBasis = 'assumed'; freightSource = 'assumed';
    freightNote = `Assumed freight – ${p.default_freight_pct}% of value (not a verified landed cost)`;
    assume(`Freight assumed at ${p.default_freight_pct}% of order value - not quoted, not modelled${model ? ` (${model.missing.map(m => m.input).filter((v, i, a) => a.indexOf(v) === i).join(', ')} missing)` : ''}, and no past PO carried a freight amount.`);
  }
  // Same label, same group, whatever the source — the classification of the
  // cost line does not change; `freight_source` says where the number came from.
  if (freight > 0) lines.push({ ...line('Freight / inbound logistics', 'landed', freight, freightBasis, freightNote), freight_source: freightSource });

  // Completeness: does this TCO rest on freight anyone can stand behind?
  //   complete     freight quoted, modelled or observed
  //   provisional  assumed freight — shown, ranked, but not a verified landed cost
  //   incomplete   no freight at all — shown, but never ranked as the winner
  const completeness = freightSource == null ? 'incomplete' : freightSource === 'assumed' ? 'provisional' : 'complete';
  const freightDetail = {
    source: freightSource,
    amount: freightSource == null ? null : round2(freight),
    basis: freightBasis,
    // The modelled inputs travel even when the model was not used, so the
    // missing ones are named — and so an award snapshot freezes them.
    model: model ? {
      complete: model.complete, amount: model.amount == null ? null : round2(model.amount),
      total_weight_kg: model.total_weight_kg, tonne_km: model.tonne_km,
      distance_km: model.distance_km, distance_source: model.distance_source, lane_id: model.lane_id,
      lane_confirmed_by_user_id: model.lane_confirmed_by_user_id,
      receiving_warehouse_id: model.receiving_warehouse_id, receiving_warehouse: model.receiving_warehouse,
      transport_mode: model.transport_mode, service_level: model.service_level,
      lines: model.lines, formula: model.formula,
    } : null,
    missing: model ? model.missing : (freightSource ? [] : [{ input: 'freight_model', message: 'No freight inputs were loaded.' }]),
    assumed_pct: freightSource === 'assumed' ? p.default_freight_pct : null,
    // Freight quoted in its own currency (§219): what the vendor wrote, and the
    // approved rate it was restated at — frozen with the award.
    fx: freightSource === 'quoted' ? (option.freight_fx ?? null) : null,
  };

  const insurance = (num(option.insurance_amount, 0) || 0) * orderShare;
  if (insurance > 0) lines.push(line('Insurance', 'landed', insurance, 'quoted', null));

  const packaging = (num(option.packaging_amount, 0) || 0) * orderShare
                  + (num(option.packaging_per_unit, 0) || 0) * qty;
  if (packaging > 0) lines.push(line('Packaging', 'landed', packaging, 'quoted', null));

  // Duty: a quoted amount wins; otherwise a percentage of the goods value.
  let duty = num(option.duty_amount);
  if (duty != null) {
    duty *= orderShare;
    if (duty > 0) lines.push(line('Customs duty', 'landed', duty, 'quoted', null));
  } else if (num(option.duty_pct, 0) > 0) {
    duty = baseTotal * (num(option.duty_pct) / 100);
    lines.push(line('Customs duty', 'landed', duty, 'estimated',
      `${round2(num(option.duty_pct))}% of goods value`));
  } else {
    duty = 0;
  }

  const other = (num(option.other_charges, 0) || 0) * orderShare;
  if (other > 0) lines.push(line('Other charges', 'landed', other, 'quoted', null));

  // Non-creditable tax. Goods + freight + duty is the base, matching how GST is
  // actually levied on an inbound consignment.
  const taxPct = num(option.tax_pct, 0) || 0;
  const nonCreditablePct = 100 - p.gst_input_credit_pct;
  const taxBase = baseTotal + freight + duty + packaging + other;
  const stuckTax = taxPct > 0 && nonCreditablePct > 0
    ? taxBase * (taxPct / 100) * (nonCreditablePct / 100)
    : 0;
  if (stuckTax > 0) {
    lines.push(line('Non-creditable tax', 'landed', stuckTax, 'estimated',
      `${round2(taxPct)}% tax, ${round2(nonCreditablePct)}% of it not recoverable as input credit`));
  }

  const landedValue = baseTotal + freight + insurance + packaging + duty + other + stuckTax;
  const landedPerUnit = qty > 0 ? landedValue / qty : 0;

  // ═══ OWNERSHIP ══════════════════════════════════════════════════════════
  // Carrying rate: the item's own holding cost beats the company default - a
  // bearing and a bare PCB do not sit in the store at the same cost.
  const itemHolding = num(option.holding_cost_pct);
  const holdingPct  = itemHolding != null && itemHolding > 0 ? itemHolding : p.inventory_carrying_pct;
  const holdingBasis = itemHolding != null && itemHolding > 0 ? 'estimated' : 'assumed';
  if (holdingBasis === 'assumed') {
    assume(`Carrying cost at the company rate of ${p.inventory_carrying_pct}%/yr - no holding_cost_pct is set on this component.`);
  }
  const dailyHold = (holdingPct / 100) / dayBasis;
  const horizonDays = dayBasis * (p.tco_horizon_months / 12);
  // Consumption rate. Only real when the item carries an annual demand - with
  // none, horizonQty is just the compared quantity and "demand" would be invented.
  const dailyDemand = annualDemand != null && annualDemand > 0 ? horizonQty / horizonDays : null;

  // Lead time. A quoted delivery date is a commitment; the vendor master's
  // default is a guess - the label says which one this is.
  const leadDays  = num(option.lead_time_days);
  const leadBasis = option.lead_time_basis || (leadDays == null ? 'assumed' : 'estimated');
  if (leadDays == null) {
    assume('No lead time on the quote, the price book or the vendor master - pipeline and safety-stock carrying could not be costed, so a long-lead vendor is NOT penalised here.');
  }

  // 1. Pipeline stock - money tied up in transit for the whole lead time.
  if (leadDays != null && leadDays > 0) {
    const pipeline = landedValue * dailyHold * leadDays;
    lines.push(line('Pipeline stock (in transit)', 'ownership', pipeline, leadBasis,
      `${leadDays} days at ${round2(holdingPct)}%/yr`));
  }

  // 2. Cycle stock - the compared lot is drawn down from Q to zero at the
  //    demand rate, so on average Q/2 units sit in the store for the Q/d days
  //    it takes to consume. Over a year that is the textbook Q/2 x v x h.
  //
  //    Q is the REQUIREMENT, not the MOQ-rounded order: units bought above the
  //    requirement are carried on their own line below, and counting them here
  //    as well charged the over-buy twice. And it applies whatever the lot
  //    size - the old guard (horizon > lot) dropped cycle stock entirely when
  //    the compared lot was a full year's demand, which is exactly when it is
  //    largest (12,000 units bought once: Rs 6 lakh/yr of carrying went missing).
  if (dailyDemand != null && dailyDemand > 0) {
    const consumeDays = qty / dailyDemand;
    const cycle = (qty / 2) * landedPerUnit * dailyHold * consumeDays;
    lines.push(line('Cycle stock carrying', 'ownership', cycle, 'estimated',
      overHorizon(`avg ${round2(qty / 2)} units (Q/2) x ${round4(landedPerUnit)} landed x ${round2(holdingPct)}%/yr, held ${round2(consumeDays)} days while consumed`,
                  cycle / horizonShare)));
  } else {
    assume('Cycle stock carrying not costed - the item has no annual demand, so how long a lot sits in the store is unknown.');
  }

  // 3. MOQ over-buy - units bought only to clear the vendor's minimum sit in
  //    the store until demand catches up. This is where a "cheaper" vendor with
  //    a 5,000-piece MOQ against a 200-piece need loses.
  if (excessQty > 0) {
    const holdDays = dailyDemand != null && dailyDemand > 0
      ? Math.min(excessQty / dailyDemand, dayBasis * 3)   // cap: 3 years of dead stock is the worst case worth pricing
      : horizonDays;
    const excessCarry = excessQty * landedPerUnit * dailyHold * holdDays;
    lines.push(line('MOQ over-buy carrying', 'ownership', excessCarry, 'estimated',
      `${round2(excessQty)} units above the requirement, held ~${Math.round(holdDays)} days to clear MOQ ${round2(moq || orderQty)}`));
  }

  // 4. Safety stock driven by lead time and delivery reliability. An unreliable
  //    vendor forces cover you would not otherwise carry - a real, recurring
  //    cost of choosing them that never appears on their invoice.
  const onTime = num(option.on_time_pct);
  if (leadDays != null && leadDays > 0) {
    // Late share proxies lead-time variability: 100% OTD means no variance cover.
    const lateShare = onTime == null ? 0.15 : clamp((100 - onTime) / 100, 0, 1);
    if (onTime == null) {
      assume('Delivery reliability unknown - safety-stock cover modelled at a 15% late share.');
    }
    const sigmaDays = leadDays * lateShare;
    const coverDays = p.service_level_z * sigmaDays;
    if (coverDays > 0.5) {
      // No annual demand: the compared lot is spread over the horizon, as before.
      const ssDemand = dailyDemand ?? horizonQty / horizonDays;
      const safetyQty = ssDemand * coverDays;
      const safetyCarry = safetyQty * landedPerUnit * dailyHold * horizonDays * horizonShare;
      lines.push(line('Safety stock for lead-time risk', 'ownership', safetyCarry,
        option.on_time_basis || 'estimated',
        overHorizon(
          `${Math.round(coverDays)} days cover at z=${p.service_level_z} (${onTime == null ? 'assumed 15%' : `${round2(100 - onTime)}%`} late share on a ${leadDays}-day lead)`,
          safetyQty * landedPerUnit * dailyHold * horizonDays)));
    }
  }

  // 5. Ordering cost - raising, approving, chasing and 3-way-matching a PO
  //    costs the same whether the order is 50 units or 5,000. A low MOQ that
  //    forces monthly buys is not free.
  const orderingCost = p.ordering_cost_per_po * ordersInHorizon * horizonShare;
  if (orderingCost > 0) {
    lines.push(line('Ordering / PO processing', 'ownership', orderingCost, 'assumed',
      overHorizon(`${round2(ordersInHorizon)} orders x ${round2(p.ordering_cost_per_po)}`,
                  p.ordering_cost_per_po * ordersInHorizon)));
  }

  // 6. Incoming inspection - one receipt per order, unless the vendor is on a
  //    skip-lot / dock-to-stock arrangement.
  if (!option.inspection_waived && p.inspection_cost_per_receipt > 0) {
    const inspection = p.inspection_cost_per_receipt * ordersInHorizon * horizonShare;
    lines.push(line('Incoming inspection', 'ownership', inspection, 'assumed',
      overHorizon(`${round2(ordersInHorizon)} receipts x ${round2(p.inspection_cost_per_receipt)}`,
                  p.inspection_cost_per_receipt * ordersInHorizon)));
  }

  // 7. Quality cost. A rejected unit costs the landed price (you paid for it and
  //    cannot use it) plus rework/replacement handling. Observed GRN rejection
  //    beats the vendor master's defect_rate - the label says which was used.
  const rejectPct = num(option.reject_rate_pct);
  if (rejectPct != null && rejectPct > 0) {
    const rejectQty = qty * (rejectPct / 100);
    const quality = rejectQty * landedPerUnit * (1 + p.rework_cost_pct / 100);
    lines.push(line('Rejection, scrap & rework', 'ownership', quality,
      option.reject_basis || 'estimated',
      `${round2(rejectPct)}% reject rate x landed cost, +${p.rework_cost_pct}% handling`));
  } else if (rejectPct == null) {
    assume('No reject rate on record for this vendor - quality cost is NOT included, so a vendor with no receipt history looks better than one with a measured 1% reject rate.');
  }

  // 8. Payment terms - a BENEFIT, entered as a negative cost. 60-day credit on a
  //    10-lakh order at 12% is ~20k the price-only comparison never sees; an
  //    advance-payment vendor is genuinely dearer than their quote.
  //
  //    Financed on what the VENDOR invoices: goods, the charges they quoted and
  //    any tax that is not recoverable. Customs duty goes to customs at
  //    clearance and observed/assumed freight goes to a carrier - neither rides
  //    on the vendor's credit, and including them overstated the benefit (by
  //    50% on an order whose duty and freight were half its goods value).
  const termsDays = num(option.payment_terms_days);
  const termsBasis = option.payment_terms_basis || 'estimated';
  const vendorInvoiced = baseTotal + insurance + packaging + other + stuckTax
                       + (freightBasis === 'quoted' ? freight : 0);
  const rate = p.cost_of_capital_pct;
  const discPct  = num(option.early_discount_pct);
  const discDays = num(option.early_discount_days);
  let paymentTerms = null;

  if (termsDays != null && termsDays > 0 && discPct != null && discPct > 0
      && discDays != null && discDays >= 0 && discDays < termsDays) {
    // Cash discount (e.g. 2/10 net 30). The two strategies are mutually
    // exclusive cash flows, so the TCO carries ONE of them - never the full
    // discount AND the full credit benefit.
    //   pay net:  pay I at day N           → benefit I x r x N / basis
    //   take:     pay I - D at day d       → D + (I - D) x r x d / basis
    //   net benefit of taking = D - incremental financing cost, where the
    //   incremental cost is the credit given up by paying earlier.
    const discount = vendorInvoiced * (discPct / 100);
    const netCredit  = financingAmount(vendorInvoiced, rate, termsDays, dayBasis);
    const takeCredit = financingAmount(vendorInvoiced - discount, rate, discDays, dayBasis);
    const incrementalFinancing = netCredit - takeCredit;
    const netBenefit = discount - incrementalFinancing;
    const requested = option.payment_strategy;
    const strategy = requested === 'take_discount' || requested === 'pay_net'
      ? requested : (netBenefit > 0 ? 'take_discount' : 'pay_net');
    const chosenBy = requested === strategy ? 'selected' : 'cheaper of the two';
    const summary = `${discPct}/${discDays} net ${termsDays}: discount ${round2(discount)} vs ${round2(incrementalFinancing)} of credit given up at ${rate}%/yr - net benefit of taking it ${round2(netBenefit)}`;

    if (strategy === 'take_discount') {
      lines.push(line('Early-payment discount', 'acquisition', -discount, termsBasis,
        `${discPct}% of ${round2(vendorInvoiced)} invoiced, paid by day ${discDays} (${chosenBy}); ${summary}`));
      if (takeCredit > 0) {
        lines.push(line('Credit terms benefit', 'ownership', -takeCredit, termsBasis,
          `${discDays} days credit on ${round2(vendorInvoiced - discount)} at ${rate}%/yr`));
      }
    } else {
      lines.push(line('Credit terms benefit', 'ownership', -netCredit, termsBasis,
        `${termsDays} days credit on ${round2(vendorInvoiced)} at ${rate}%/yr; discount not taken (${chosenBy}). ${summary}`));
    }
    paymentTerms = {
      net_days: termsDays, discount_pct: discPct, discount_days: discDays, strategy,
      strategy_source: requested === strategy ? 'selected' : 'optimal',
      discount_amount: round2(discount), incremental_financing_cost: round2(incrementalFinancing),
      net_benefit_of_discount: round2(netBenefit),
    };
  } else if (termsDays != null && termsDays !== 0) {
    const financing = -financingAmount(vendorInvoiced, rate, termsDays, dayBasis);
    lines.push(line(
      termsDays > 0 ? 'Credit terms benefit' : 'Advance payment cost',
      'ownership', financing, termsBasis,
      `${Math.abs(termsDays)} days ${termsDays > 0 ? 'credit' : 'advance'} on ${round2(vendorInvoiced)} invoiced at ${rate}%/yr`));
    paymentTerms = { net_days: termsDays, strategy: termsDays > 0 ? 'pay_net' : 'advance' };
  } else if (termsDays == null) {
    assume('Payment terms unknown - no credit benefit is credited to this vendor.');
  }

  // ═══ RISK ═══════════════════════════════════════════════════════════════
  // 9. Expediting on the share of orders that arrive late.
  if (onTime != null && onTime < 100 && p.expedite_cost_per_late_order > 0) {
    const lateOrders = ordersInHorizon * ((100 - onTime) / 100);
    const expedite = lateOrders * p.expedite_cost_per_late_order * horizonShare;
    if (expedite > 0) {
      lines.push(line('Expediting on late deliveries', 'risk', expedite,
        option.on_time_basis || 'observed',
        overHorizon(`${round2(lateOrders)} late orders expected x ${round2(p.expedite_cost_per_late_order)}`,
                    lateOrders * p.expedite_cost_per_late_order)));
    }
  }

  // 10. Single-source premium - no alternative means no leverage and no recovery
  //     when they stop. Priced as a percentage of spend.
  if (option.is_single_source && p.single_source_risk_pct > 0) {
    lines.push(line('Single-source exposure', 'risk',
      landedValue * (p.single_source_risk_pct / 100), 'estimated',
      `${p.single_source_risk_pct}% of spend - this vendor is the only approved source`));
  }

  // ── Roll up ──────────────────────────────────────────────────────────────
  const groups = { acquisition: 0, landed: 0, ownership: 0, risk: 0 };
  for (const l of lines) groups[l.group] = round2((groups[l.group] || 0) + l.amount);

  const tcoTotal = round2(groups.acquisition + groups.landed + groups.ownership + groups.risk);
  const tcoPerUnit = round4(tcoTotal / qty);

  // Confidence: how much of the number rests on real data rather than a rate
  // card. Weighted by amount, so a large assumed line hurts more than a small
  // one. Sign-agnostic - the credit-terms benefit is a real, weighted line too.
  let weighted = 0, magnitude = 0;
  for (const l of lines) {
    const m = Math.abs(l.amount);
    magnitude += m;
    weighted  += m * (BASIS_WEIGHT[l.basis] ?? 0.5);
  }
  const confidence = magnitude > 0 ? Math.round((weighted / magnitude) * 100) : 0;

  return {
    computable: true,
    quantity: qty,
    unit_price: round4(unitPrice),
    base_total: round2(baseTotal),
    order_qty: round2(orderQty),
    excess_qty: round2(excessQty),
    orders_in_horizon: round2(ordersInHorizon),
    horizon_qty: round2(horizonQty),
    horizon_months: p.tco_horizon_months,
    day_count_basis: dayBasis,
    currency: p.base_currency,
    quoted_currency: currency || p.base_currency,
    fx_rate: fxRate,
    // Which rate, from where, approved by whom — frozen with the breakdown on
    // award, so a later rate change can never alter what the award said.
    fx: currency && currency !== p.base_currency
      ? { rate: fxRate, from: currency, to: p.base_currency, ...(rawOption.fx_meta || {}) }
      : null,
    payment_terms: paymentTerms,
    completeness,
    freight: freightDetail,
    landed_total: round2(landedValue),
    landed_per_unit: round4(landedPerUnit),
    tco_total: tcoTotal,
    tco_per_unit: tcoPerUnit,
    // The headline a buyer reads: how much more than the sticker price this
    // vendor actually costs.
    premium_over_price: round2(tcoTotal - baseTotal),
    premium_pct: baseTotal > 0 ? round2(((tcoTotal - baseTotal) / baseTotal) * 100) : null,
    groups,
    lines,
    confidence,
    assumptions,
  };
}

/**
 * rankOptions(options, params)
 *
 * Scores every option and returns them TCO-ascending with the comparison a
 * buyer needs: who wins on price, who wins on TCO, and - the whole point -
 * whether those are the same vendor.
 *
 * Uncomputable options (no price) sink to the bottom and never win.
 */
export function rankOptions(options = [], params = TCO_DEFAULTS) {
  const scored = options.map((o) => ({ ...o, tco: computeTco(o, params) }));

  const computable = scored.filter((o) => o.tco.computable);
  // §216: an option whose freight is missing altogether is shown, but it is not
  // in the race — its TCO is short by an unknown freight bill, so it would win
  // for the wrong reason. Provisional (assumed freight) options do compete, and
  // the result is labelled provisional.
  const rankable = computable.filter((o) => o.tco.completeness !== 'incomplete');
  // §217: a priced quote that could not be converted (no approved FX, stale,
  // base rate unusable) is an ELIGIBLE quote the comparison cannot cost. It was
  // simply left out and a winner crowned among the rest — but its total might
  // have been the lowest. Same rule as missing freight: the comparison is
  // incomplete and no recommendation is made. Unpriced quotes (no_price /
  // no_quantity) are not eligible bids and do not block anything.
  const fxExcluded = scored.filter((o) => !o.tco.computable && o.tco.reason === 'no_fx_rate');
  const incompleteOptions = [
    ...computable.filter((o) => o.tco.completeness === 'incomplete').map((o) => ({ o, reason: 'freight', missing: o.tco.freight?.missing ?? [] })),
    ...fxExcluded.map((o) => ({ o, reason: 'fx', missing: [{
      input: 'fx', reason: o.tco.fx_detail?.reason ?? 'no_approved_rate', currency: o.tco.currency ?? null,
      latest_rate_date: o.tco.fx_detail?.latest_rate_date ?? null,
      message: o.tco.fx_detail?.message || `Quoted in ${o.tco.currency}; no usable approved exchange rate to ${o.tco.base_currency}.`,
    }] })),
  ];
  const eligibleCount = computable.length + fxExcluded.length;
  const comparisonStatus = !eligibleCount ? null
    : incompleteOptions.length ? 'incomplete'
    : rankable.some((o) => o.tco.completeness === 'provisional') ? 'provisional'
    : 'complete';

  const bestPrice = computable.reduce((b, o) =>
    b == null || o.tco.unit_price < b.tco.unit_price ? o : b, null);
  // No lowest-TCO winner at all while the comparison is incomplete: crowning
  // the best of the vendors that happen to have freight would be a ranking the
  // missing inputs could overturn.
  const bestTco = comparisonStatus === 'incomplete' ? null : rankable.reduce((b, o) =>
    b == null || o.tco.tco_per_unit < b.tco.tco_per_unit ? o : b, null);

  const bestTcoPerUnit   = bestTco?.tco.tco_per_unit ?? null;
  const bestPricePerUnit = bestPrice?.tco.unit_price ?? null;

  for (const o of scored) {
    if (!o.tco.computable) {
      o.is_lowest_tco = false; o.is_lowest_price = false;
      o.tco_vs_best_pct = null; o.price_vs_best_pct = null;
      continue;
    }
    o.is_lowest_tco   = o === bestTco;
    o.is_lowest_price = o === bestPrice;
    o.tco_vs_best_pct = bestTcoPerUnit > 0 && o.tco.completeness !== 'incomplete'
      ? round2(((o.tco.tco_per_unit - bestTcoPerUnit) / bestTcoPerUnit) * 100) : null;
    o.price_vs_best_pct = bestPricePerUnit > 0
      ? round2(((o.tco.unit_price - bestPricePerUnit) / bestPricePerUnit) * 100) : null;
  }

  // Rankable first (by TCO), then incomplete, then uncomputable.
  const tier = (o) => (!o.tco.computable ? 2 : o.tco.completeness === 'incomplete' ? 1 : 0);
  scored.sort((a, b) => (tier(a) - tier(b)) || (tier(a) === 2 ? 0 : a.tco.tco_per_unit - b.tco.tco_per_unit));

  const provisionalNote = comparisonStatus === 'provisional'
    ? ' Provisional: at least one vendor is costed on assumed freight, so this is not a verified landed-cost comparison.'
    : '';

  // The finding the page exists to surface: the cheapest quote is not the
  // cheapest option. Quantified in money over the compared quantity.
  let recommendation = null;
  if (comparisonStatus === 'incomplete') {
    recommendation = {
      status: 'withheld_incomplete',
      differs: null,
      lowest_tco_label: null, lowest_tco_id: null,
      incomplete: incompleteOptions.map(({ o, reason, missing }) => ({
        vendor_id: o.vendor_id ?? null, label: o.label ?? o.vendor_name ?? null, reason, missing,
      })),
      message: `No recommendation: ${incompleteOptions.length} of ${eligibleCount} vendor${eligibleCount === 1 ? '' : 's'} cannot be fully costed (${[...new Set(incompleteOptions.map((x) => (x.reason === 'fx' ? 'exchange rate' : 'freight')))].join(' and ')} missing), so their total cost is not known.`,
    };
  } else if (bestTco && bestPrice && bestTco !== bestPrice) {
    const saving = round2(bestPrice.tco.tco_total - bestTco.tco.tco_total);
    recommendation = {
      status: comparisonStatus === 'provisional' ? 'provisional' : 'made',
      differs: true,
      lowest_price_label: bestPrice.label ?? bestPrice.vendor_name ?? null,
      lowest_price_id:    bestPrice.vendor_id ?? null,
      lowest_tco_label:   bestTco.label ?? bestTco.vendor_name ?? null,
      lowest_tco_id:      bestTco.vendor_id ?? null,
      // How much dearer the TCO winner looks on sticker price - the number the
      // buyer has to defend in the approval note.
      price_gap_pct: bestPrice.tco.unit_price > 0
        ? round2(((bestTco.tco.unit_price - bestPrice.tco.unit_price) / bestPrice.tco.unit_price) * 100)
        : null,
      tco_saving: saving,
      message: saving > 0
        ? `The cheapest quote is not the cheapest option - awarding on total cost is the better buy.${provisionalNote}`
        : (provisionalNote.trim() || null),
    };
  } else if (bestTco) {
    recommendation = {
      status: comparisonStatus === 'provisional' ? 'provisional' : 'made',
      differs: false,
      lowest_tco_label: bestTco.label ?? bestTco.vendor_name ?? null,
      lowest_tco_id:    bestTco.vendor_id ?? null,
      message: `The cheapest quote is also the lowest total cost of ownership.${provisionalNote}`,
    };
  }

  const confidences = computable.map((o) => o.tco.confidence);

  return {
    options: scored,
    best_tco_id:   bestTco?.vendor_id ?? null,
    best_price_id: bestPrice?.vendor_id ?? null,
    best_tco_per_unit:   bestTcoPerUnit,
    best_price_per_unit: bestPricePerUnit,
    comparison_status: comparisonStatus,
    // Spread on TCO, not on price - how much the sourcing decision is worth.
    tco_spread_pct: (() => {
      if (rankable.length < 2 || !bestTcoPerUnit) return 0;
      const worst = Math.max(...rankable.map((o) => o.tco.tco_per_unit));
      return round2(((worst - bestTcoPerUnit) / bestTcoPerUnit) * 100);
    })(),
    recommendation,
    confidence: confidences.length
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0,
  };
}

export default { computeTco, rankOptions, modelFreight, resolveParams, parsePaymentTerms, financingAmount, TCO_DEFAULTS, FREIGHT_SOURCES, num };
