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

const DAYS_PER_MONTH = 30.44;

/** Company costing rates. Mirrors the procurement_settings TCO columns. */
export const TCO_DEFAULTS = Object.freeze({
  tco_enabled:                  true,
  cost_of_capital_pct:          12,    // annual — finances inventory and credit terms
  inventory_carrying_pct:       18,    // annual — capital + storage + insurance + obsolescence
  ordering_cost_per_po:         750,   // raise/approve/follow-up/3-way-match, per PO
  inspection_cost_per_receipt:  500,   // incoming QC, per receipt
  expedite_cost_per_late_order: 2500,  // chasing, part loads, line stoppage
  rework_cost_pct:              25,    // % of unit price to rework/replace a reject
  default_freight_pct:          2,     // only when neither quoted nor observed
  gst_input_credit_pct:         100,   // 100 = fully recoverable, so tax is not a cost
  single_source_risk_pct:       2,     // premium on spend with a sole source
  service_level_z:              1.65,  // ~95% service level for safety stock
  tco_horizon_months:           12,
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
  return p;
}

const BASIS_WEIGHT = { quoted: 1, observed: 1, estimated: 0.5, assumed: 0.15 };

function line(label, group, amount, basis, note) {
  return { label, group, amount: round2(amount || 0), basis, note: note || null };
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
 *     freight_pct_observed vendor's historical freight as % of order value
 *
 * Returns a breakdown with per-unit and total figures, `lines[]` with basis, a
 * `confidence` 0-100, and `assumptions[]` naming every modelled input.
 */
export function computeTco(option = {}, params = TCO_DEFAULTS) {
  const p = resolveParams(params);

  const unitPrice = num(option.unit_price);
  const qty       = Math.max(num(option.quantity, 0) || 0, 0);

  // No price means no TCO. Returning zeros would rank an unpriced vendor as the
  // cheapest option on the page — the exact failure this engine exists to stop.
  if (unitPrice == null || unitPrice <= 0 || qty <= 0) {
    return {
      computable: false,
      reason: unitPrice == null || unitPrice <= 0 ? 'no_price' : 'no_quantity',
      quantity: qty, unit_price: unitPrice,
      tco_total: null, tco_per_unit: null, base_total: null,
      premium_over_price: null, premium_pct: null,
      groups: null, lines: [], confidence: 0, assumptions: [],
    };
  }

  const assumptions = [];
  const lines = [];
  const assume = (what) => { if (!assumptions.includes(what)) assumptions.push(what); };

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
  // Freight: quoted order amount, then quoted per-unit, then observed history,
  // then the company rate.
  let freight, freightBasis, freightNote;
  if (num(option.freight_amount) != null) {
    freight = num(option.freight_amount) * orderShare;
    freightBasis = 'quoted'; freightNote = 'quoted on the order';
  } else if (num(option.freight_per_unit) != null) {
    freight = num(option.freight_per_unit) * qty;
    freightBasis = 'quoted'; freightNote = 'quoted per unit';
  } else if (num(option.freight_pct_observed) != null && num(option.freight_pct_observed) > 0) {
    freight = baseTotal * (num(option.freight_pct_observed) / 100);
    freightBasis = 'observed';
    freightNote = `${round2(num(option.freight_pct_observed))}% of value on this vendor's past POs`;
  } else {
    freight = baseTotal * (p.default_freight_pct / 100);
    freightBasis = 'assumed';
    freightNote = `company default ${p.default_freight_pct}% of value`;
    assume(`Freight assumed at ${p.default_freight_pct}% of order value - this vendor has not quoted freight and no past PO carried a freight amount.`);
  }
  if (freight > 0) lines.push(line('Freight / inbound logistics', 'landed', freight, freightBasis, freightNote));

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
  const dailyHold = (holdingPct / 100) / 365;

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

  // 2. Cycle stock - on average you hold half an order quantity between buys.
  //    Only meaningful when the horizon covers more than this one purchase.
  if (horizonQty > qty && ordersInHorizon > 0) {
    const cycleDays = (p.tco_horizon_months * DAYS_PER_MONTH) / ordersInHorizon;
    const cycleValue = (orderQty / 2) * landedPerUnit;
    // Held for cycleDays per order, ordersInHorizon times, then scaled back
    // from the horizon onto the compared quantity.
    const cycle = cycleValue * dailyHold * cycleDays * ordersInHorizon * horizonShare;
    lines.push(line('Cycle stock carrying', 'ownership', cycle, 'estimated',
      overHorizon(`avg ${round2(orderQty / 2)} units held between ${round2(ordersInHorizon)} orders`,
                  cycleValue * dailyHold * cycleDays * ordersInHorizon)));
  }

  // 3. MOQ over-buy - units bought only to clear the vendor's minimum sit in
  //    the store until demand catches up. This is where a "cheaper" vendor with
  //    a 5,000-piece MOQ against a 200-piece need loses.
  if (excessQty > 0) {
    const dailyDemand = horizonQty > 0 ? horizonQty / (p.tco_horizon_months * DAYS_PER_MONTH) : 0;
    const holdDays = dailyDemand > 0
      ? Math.min(excessQty / dailyDemand, 365 * 3)   // cap: 3 years of dead stock is the worst case worth pricing
      : p.tco_horizon_months * DAYS_PER_MONTH;
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
      const horizonDays = p.tco_horizon_months * DAYS_PER_MONTH;
      const dailyDemand = horizonQty > 0 ? horizonQty / horizonDays : qty / DAYS_PER_MONTH;
      const safetyQty = dailyDemand * coverDays;
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
  const termsDays = num(option.payment_terms_days);
  if (termsDays != null && termsDays !== 0) {
    const financing = -(landedValue * (p.cost_of_capital_pct / 100) * (termsDays / 365));
    lines.push(line(
      termsDays > 0 ? 'Credit terms benefit' : 'Advance payment cost',
      'ownership', financing, option.payment_terms_basis || 'estimated',
      `${Math.abs(termsDays)} days ${termsDays > 0 ? 'credit' : 'advance'} at ${p.cost_of_capital_pct}%/yr`));
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
  const bestPrice = computable.reduce((b, o) =>
    b == null || o.tco.unit_price < b.tco.unit_price ? o : b, null);
  const bestTco = computable.reduce((b, o) =>
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
    o.tco_vs_best_pct = bestTcoPerUnit > 0
      ? round2(((o.tco.tco_per_unit - bestTcoPerUnit) / bestTcoPerUnit) * 100) : null;
    o.price_vs_best_pct = bestPricePerUnit > 0
      ? round2(((o.tco.unit_price - bestPricePerUnit) / bestPricePerUnit) * 100) : null;
  }

  scored.sort((a, b) => {
    if (!a.tco.computable) return 1;
    if (!b.tco.computable) return -1;
    return a.tco.tco_per_unit - b.tco.tco_per_unit;
  });

  // The finding the page exists to surface: the cheapest quote is not the
  // cheapest option. Quantified in money over the compared quantity.
  let recommendation = null;
  if (bestTco && bestPrice && bestTco !== bestPrice) {
    const saving = round2(bestPrice.tco.tco_total - bestTco.tco.tco_total);
    recommendation = {
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
        ? 'The cheapest quote is not the cheapest option - awarding on total cost is the better buy.'
        : null,
    };
  } else if (bestTco) {
    recommendation = {
      differs: false,
      lowest_tco_label: bestTco.label ?? bestTco.vendor_name ?? null,
      lowest_tco_id:    bestTco.vendor_id ?? null,
      message: 'The cheapest quote is also the lowest total cost of ownership.',
    };
  }

  const confidences = computable.map((o) => o.tco.confidence);

  return {
    options: scored,
    best_tco_id:   bestTco?.vendor_id ?? null,
    best_price_id: bestPrice?.vendor_id ?? null,
    best_tco_per_unit:   bestTcoPerUnit,
    best_price_per_unit: bestPricePerUnit,
    // Spread on TCO, not on price - how much the sourcing decision is worth.
    tco_spread_pct: (() => {
      if (computable.length < 2 || !bestTcoPerUnit) return 0;
      const worst = Math.max(...computable.map((o) => o.tco.tco_per_unit));
      return round2(((worst - bestTcoPerUnit) / bestTcoPerUnit) * 100);
    })(),
    recommendation,
    confidence: confidences.length
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0,
  };
}

export default { computeTco, rankOptions, resolveParams, TCO_DEFAULTS, num };
