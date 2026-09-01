/**
 * rfxScoring.service.js — feeds the RFx scoring engine, and writes the outcome.
 *
 * WHAT IS SCORED AUTOMATICALLY, AND WHAT IS NOT
 *
 * Cost and delivery are facts about the bids in front of us, so they are
 * benchmarked across the field rather than left to an opinion. Quality record,
 * compliance, financial standing and risk are facts about the VENDOR, so they
 * are taken from the §49G vendor health engine — our own receipts, NCRs and
 * documents — rather than from what the vendor says about itself.
 *
 * Capability, capacity, solution fit and technical merit cannot be computed
 * from anything this system holds. They are left deliberately unscored, they
 * show as outstanding in the scorecard, and the engine's coverage figure counts
 * them as missing. Guessing them would be the whole problem in miniature.
 *
 * ⚠ WHY A NULL HEALTH DIMENSION IS THE ONLY THING WE CHECK. §130 recorded that
 * the vendor health engine's "no data" defaults score near the BOTTOM of each
 * dimension, and that importing those anywhere marks an unmeasured supplier as
 * a bad one. That was fixed at source: `vendorHealthEngine` renormalises over
 * measured dimensions and its `dim()` helper writes **null**, not the default,
 * for any dimension with no evidence — and `vendorHealth.service` persists
 * exactly those values. So a non-null dimension score is real evidence and a
 * null one is an absence, per-dimension.
 *
 * That contract is what this file relies on, and it is why there is NO extra
 * row-level coverage floor here. An earlier draft discarded any dimension from
 * a vendor whose overall health coverage was thin, which threw away genuinely
 * measured compliance and financial scores because unrelated dimensions were
 * blank. `health_coverage_pct` still travels with every bid so the buyer can
 * see how broad the picture is — but it does not veto evidence that exists.
 *
 * No query here is wrapped in `.catch(() => [])`.
 */
import pool from '../../shared/db.js';
import { resolveModel, benchmark, rankBids, RFX_MODELS } from '../engines/rfxScoringEngine.js';
import { computeTco } from '../engines/tcoEngine.js';
import { loadTcoParams, loadAnnualDemand } from './tco.service.js';

const num = (v, fallback = null) => {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const round1 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 10) / 10);

/**
 * Reported alongside every bid so a buyer can see how much of the §49G health
 * picture is actually measured. It is context, not a filter — see the header
 * for why a row-level floor would discard real evidence.
 */
export const HEALTH_COVERAGE_IS_CONTEXT_ONLY = true;

/** "Net 45" → 45. Payment terms are free text on rfq_quotes. */
function parseTermsDays(v) {
  if (v == null) return null;
  const m = String(v).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── Loaders ───────────────────────────────────────────────────────────────────

async function loadEvent(companyId, rfqId) {
  const { rows } = await pool.query(
    `SELECT r.*, ic.name AS category_name
       FROM rfqs r
       LEFT JOIN item_categories ic ON ic.id = r.category_id
      WHERE r.id = $1
        AND ($2::int IS NULL OR r.company_id = $2)`,
    [rfqId, companyId ?? null]
  );
  return rows[0] || null;
}

async function loadItems(rfqId) {
  const { rows } = await pool.query(
    `SELECT ri.*, ii.item_code, ii.item_name AS master_item_name, ii.category_id,
            ii.gst_rate, ii.default_gst_rate, ii.holding_cost_pct, ii.min_order_qty
       FROM rfq_items ri
       LEFT JOIN inventory_items ii ON ii.id = ri.item_id
      WHERE ri.rfq_id = $1
      ORDER BY ri.id`,
    [rfqId]
  );
  return rows;
}

/**
 * The bids, with the vendor's own health row alongside.
 *
 * A quote row with no price is a vendor who was invited and has not answered —
 * `send-to-vendors` inserts a placeholder row. It stays in the list (the buyer
 * needs to see who has not replied) but nothing about it gets benchmarked.
 */
async function loadBids(companyId, rfqId) {
  const { rows } = await pool.query(
    `SELECT q.id AS quote_id, q.vendor_id, q.unit_price, q.total_amount, q.delivery_days,
            q.payment_terms, q.warranty_months, q.moq, q.currency, q.valid_until,
            q.freight_amount, q.insurance_amount, q.duty_amount, q.packaging_amount,
            q.other_charges, q.tooling_cost, q.tax_pct, q.is_winner,
            v.vendor_name, v.payment_terms_days AS master_terms_days, v.lead_time_days,
            COALESCE(v.is_critical_supplier, FALSE) AS is_critical_supplier,
            COALESCE(v.is_single_source, FALSE)     AS is_single_source,
            h.health_score, h.health_status, h.quality_score, h.delivery_score,
            h.compliance_score, h.financial_score, h.risk_score, h.dependency_score,
            h.otd_pct, h.pass_rate_pct, h.open_ncr_count,
            h.coverage_pct AS health_coverage_pct
       FROM rfq_quotes q
       JOIN vendors v ON v.id = q.vendor_id
       LEFT JOIN vendor_health_scores h ON h.vendor_id = v.id
      WHERE q.rfq_id = $1
        AND ($2::int IS NULL OR v.company_id = $2)
      ORDER BY v.vendor_name`,
    [rfqId, companyId ?? null]
  );
  return rows;
}

async function loadManualScores(rfqId) {
  const { rows } = await pool.query(
    `SELECT s.vendor_id, s.criterion_key, s.score, s.basis, s.note, s.updated_at,
            u.name AS scored_by_name
       FROM rfx_criteria_scores s
       LEFT JOIN users u ON u.id = s.scored_by_user_id
      WHERE s.rfq_id = $1`,
    [rfqId]
  );
  return rows;
}

async function loadSelections(rfqId) {
  const { rows } = await pool.query(
    `SELECT s.*, v.vendor_name, u.name AS selected_by_name
       FROM rfx_vendor_selections s
       LEFT JOIN vendors v ON v.id = s.vendor_id
       LEFT JOIN users u  ON u.id = s.selected_by_user_id
      WHERE s.rfq_id = $1
      ORDER BY s.created_at DESC`,
    [rfqId]
  );
  return rows;
}

// ── Automatic scoring ─────────────────────────────────────────────────────────

/**
 * The cost measure every bid is benchmarked on.
 *
 * Total cost of ownership where §128 can compute it — which needs the company
 * switch on AND a single-item RFQ, because item context (holding cost, demand,
 * GST) cannot be attributed across a mixed basket. Otherwise the quoted total,
 * normalised per unit. Which of the two was used travels back in `cost_basis`;
 * a comparison that will not say what it compared is not a comparison.
 */
async function costMeasures(companyId, event, items, bids, model) {
  const lineQty = items.reduce((s, i) => s + (num(i.quantity, 0) || 0), 0);
  const totalQty = lineQty > 0 ? lineQty : (num(event.quantity, 0) || 0) || 1;
  const singleItem = items.length === 1 && items[0].item_id ? items[0] : null;

  // An RFI has no cost criterion — it asks whether a supplier can do the work at
  // all, before anyone talks price. Costing the bids anyway would put "scored on
  // total cost of ownership" on a scorecard with no cost row in it, which reads
  // as a missing column rather than a stage that deliberately ignores price.
  const scoresCost = (model?.criteria || []).some((c) => c.key === 'cost' || c.key === 'commercial');
  if (!scoresCost) {
    return {
      measures: {}, detail: {}, quantity: totalQty,
      cost_basis: `${model?.label || 'This stage'} does not score price — qualification comes before commercials`,
      cost_basis_key: 'not_scored',
    };
  }

  const params = await loadTcoParams(companyId);
  const tcoUsable = params.tco_enabled && !!singleItem;

  const measures = {};
  const detail = {};

  if (tcoUsable) {
    const demand = await loadAnnualDemand(Number(singleItem.item_id), companyId);
    for (const b of bids) {
      const r = computeTco({
        unit_price: num(b.unit_price),
        quantity: totalQty,
        freight_amount: num(b.freight_amount),
        insurance_amount: num(b.insurance_amount),
        duty_amount: num(b.duty_amount),
        packaging_amount: num(b.packaging_amount),
        other_charges: num(b.other_charges),
        tooling_cost: num(b.tooling_cost),
        tax_pct: num(b.tax_pct),
        lead_time_days: num(b.delivery_days) ?? num(b.lead_time_days),
        payment_terms_days: parseTermsDays(b.payment_terms) ?? num(b.master_terms_days),
        moq: num(b.moq),
        warranty_months: num(b.warranty_months),
        holding_cost_pct: num(singleItem.holding_cost_pct),
        gst_rate: num(singleItem.gst_rate) ?? num(singleItem.default_gst_rate),
        annual_demand_qty: demand?.annual_demand_qty ?? null,
        is_single_source: b.is_single_source === true,
      }, params);
      measures[b.vendor_id] = r.computable ? r.tco_per_unit : null;
      detail[b.vendor_id] = r.computable
        ? { tco_per_unit: r.tco_per_unit, tco_total: r.tco_total, confidence: r.confidence }
        : { reason: r.reason };
    }
    return {
      measures, detail, quantity: totalQty,
      cost_basis: 'total cost of ownership per unit (§128)',
      cost_basis_key: 'tco',
    };
  }

  for (const b of bids) {
    const total = num(b.total_amount) ?? (num(b.unit_price) != null ? num(b.unit_price) * totalQty : null);
    measures[b.vendor_id] = total != null && total > 0 ? total / totalQty : null;
    detail[b.vendor_id] = { quoted_total: total };
  }
  return {
    measures, detail, quantity: totalQty,
    cost_basis: params.tco_enabled && !singleItem
      ? 'quoted price per unit — TCO needs a single-item RFQ to attribute item costs'
      : 'quoted price per unit — total cost of ownership is switched off in Procurement Settings',
    cost_basis_key: 'price',
  };
}

/**
 * Score the criteria the system can answer for itself.
 *
 * Returns { [vendorId]: { [criterionKey]: { score, basis, note } } }. A
 * criterion this function cannot answer is simply absent — never a zero.
 */
function autoScore(model, bids, cost) {
  const keys = new Set(model.criteria.filter((c) => c.auto).map((c) => c.key));
  const out = Object.fromEntries(bids.map((b) => [b.vendor_id, {}]));

  const put = (vendorId, key, score, basis, note) => {
    if (!keys.has(key) || score == null) return;
    out[vendorId][key] = { score: round1(Math.max(0, Math.min(100, score))), basis, note };
  };

  // A null dimension is the health engine saying it had no evidence; a number
  // is the health engine saying it did. Nothing else needs checking.
  const healthy = (b, field) => num(b[field]);
  const healthNote = (b) => {
    const cov = num(b.health_coverage_pct);
    return cov == null
      ? 'From the vendor health engine (§49G)'
      : `From vendor health, ${round1(cov)}% of that index measured (§49G)`;
  };

  // ── Cost / commercial: benchmarked across the field ────────────────────────
  const costScores = benchmark(cost.measures, { lowerIsBetter: true });
  for (const b of bids) {
    const s = costScores[b.vendor_id];
    const note = `${cost.cost_basis}: ${num(cost.measures[b.vendor_id]) == null ? 'not quoted' : Math.round(num(cost.measures[b.vendor_id])).toLocaleString('en-IN')}`;
    put(b.vendor_id, 'cost', s, 'benchmarked', note);
    put(b.vendor_id, 'commercial', s, 'benchmarked', note);
  }

  // ── Delivery: quoted lead time benchmarked, tempered by what they deliver ──
  const leadMeasures = Object.fromEntries(
    bids.map((b) => [b.vendor_id, num(b.delivery_days) ?? num(b.lead_time_days)])
  );
  const leadScores = benchmark(leadMeasures, { lowerIsBetter: true });
  for (const b of bids) {
    const quoted = leadScores[b.vendor_id];
    const otd = healthy(b, 'otd_pct');
    if (quoted == null && otd == null) continue;
    // A promise is worth what the promiser's record says it is: 70% the quoted
    // lead time, 30% their measured on-time rate — but only when we have one.
    const blended = quoted != null && otd != null ? quoted * 0.7 + otd * 0.3 : (quoted ?? otd);
    const note = quoted != null && otd != null
      ? `${leadMeasures[b.vendor_id]}-day quote, ${round1(otd)}% on-time delivered`
      : quoted != null
        ? `${leadMeasures[b.vendor_id]}-day quote; no delivered record yet`
        : `${round1(otd)}% on-time delivered; no lead time quoted`;
    put(b.vendor_id, 'delivery', blended, quoted != null ? 'benchmarked' : 'observed', note);
  }

  // ── Vendor-record criteria, straight from §49G where it is measured ────────
  for (const b of bids) {
    const q = healthy(b, 'quality_score');
    put(b.vendor_id, 'quality_record', q, 'observed', healthNote(b));
    put(b.vendor_id, 'quality_system', q, 'observed', healthNote(b));
    put(b.vendor_id, 'compliance', healthy(b, 'compliance_score'), 'observed', healthNote(b));
    put(b.vendor_id, 'financial_standing', healthy(b, 'financial_score'), 'observed', healthNote(b));

    // Risk is inverted: the health engine's risk_score counts UP with risk, and
    // every other criterion here counts up with goodness.
    const risk = healthy(b, 'risk_score');
    const dependency = healthy(b, 'dependency_score');
    const riskInputs = [risk == null ? null : 100 - risk, dependency == null ? null : 100 - dependency]
      .filter((x) => x != null);
    if (riskInputs.length) {
      const base = riskInputs.reduce((a, x) => a + x, 0) / riskInputs.length;
      // Being the only source is a dependency the scorecard should feel.
      const penalty = b.is_single_source ? 15 : 0;
      put(b.vendor_id, 'risk', base - penalty, 'observed',
        b.is_single_source ? `${healthNote(b)}; flagged single source` : healthNote(b));
    }
  }

  // ── Terms: credit days and warranty, benchmarked (more is better) ──────────
  const termsMeasures = Object.fromEntries(
    bids.map((b) => [b.vendor_id, parseTermsDays(b.payment_terms) ?? num(b.master_terms_days)])
  );
  const termScores = benchmark(termsMeasures, { lowerIsBetter: false });
  const warrantyMeasures = Object.fromEntries(bids.map((b) => [b.vendor_id, num(b.warranty_months)]));
  const warrantyScores = benchmark(warrantyMeasures, { lowerIsBetter: false });
  for (const b of bids) {
    const t = termScores[b.vendor_id];
    const w = warrantyScores[b.vendor_id];
    if (t == null && w == null) continue;
    const blended = t != null && w != null ? t * 0.6 + w * 0.4 : (t ?? w);
    const note = [
      termsMeasures[b.vendor_id] != null ? `${termsMeasures[b.vendor_id]} credit days` : null,
      warrantyMeasures[b.vendor_id] != null ? `${warrantyMeasures[b.vendor_id]}-month warranty` : null,
    ].filter(Boolean).join(', ');
    put(b.vendor_id, 'terms', blended, 'benchmarked', note);
  }

  return out;
}

// ── The scorecard ─────────────────────────────────────────────────────────────

/**
 * Everything the evaluation screen needs: the event, the model, every bid with
 * its per-criterion scores and provenance, and the engine's ranking.
 */
export async function getScorecard(companyId, rfqId) {
  const event = await loadEvent(companyId, rfqId);
  if (!event) return null;

  const [items, bids, manual, selections] = await Promise.all([
    loadItems(rfqId),
    loadBids(companyId, rfqId),
    loadManualScores(rfqId),
    loadSelections(rfqId),
  ]);

  const model = resolveModel(event.rfx_type, event.scoring_model?.criteria || null);
  const cost = await costMeasures(companyId, event, items, bids, model);
  const auto = autoScore(model, bids, cost);

  // A human assessment beats a computed one: the auto scores refresh with the
  // field every time this is opened, a judgement does not.
  const manualByVendor = new Map();
  for (const m of manual) {
    if (!manualByVendor.has(m.vendor_id)) manualByVendor.set(m.vendor_id, {});
    manualByVendor.get(m.vendor_id)[m.criterion_key] = {
      score: num(m.score),
      basis: m.basis || 'assessed',
      note: m.note,
      scored_by_name: m.scored_by_name,
      updated_at: m.updated_at,
    };
  }

  const engineBids = bids.map((b) => ({
    vendor_id: b.vendor_id,
    vendor_name: b.vendor_name,
    quote_id: b.quote_id,
    responded: num(b.unit_price) != null && num(b.unit_price) > 0,
    unit_price: num(b.unit_price),
    total_amount: num(b.total_amount),
    delivery_days: num(b.delivery_days),
    payment_terms: b.payment_terms,
    health_score: num(b.health_score),
    health_status: b.health_status || 'Unrated',
    health_coverage_pct: num(b.health_coverage_pct),
    is_single_source: b.is_single_source,
    is_critical_supplier: b.is_critical_supplier,
    cost_measure: num(cost.measures[b.vendor_id]),
    cost_detail: cost.detail[b.vendor_id] || null,
    scores: { ...(auto[b.vendor_id] || {}), ...(manualByVendor.get(b.vendor_id) || {}) },
  }));

  const ranking = rankBids(model, engineBids);

  return {
    event: {
      id: event.id,
      rfq_number: event.rfq_number,
      rfx_type: event.rfx_type,
      rfx_label: RFX_MODELS[event.rfx_type]?.label || event.rfx_type,
      purpose: RFX_MODELS[event.rfx_type]?.purpose || null,
      status: event.status,
      objective: event.objective,
      item_description: event.item_description,
      required_by: event.required_by,
      category_id: event.category_id,
      category_name: event.category_name,
      evaluated_at: event.evaluated_at,
    },
    basis: {
      compared_quantity: cost.quantity,
      cost_basis: cost.cost_basis,
      cost_basis_key: cost.cost_basis_key,
      health_note: 'A null vendor-health dimension means the health engine had no evidence; it is left unscored rather than scored zero.',
      invited: bids.length,
      responded: engineBids.filter((b) => b.responded).length,
    },
    items,
    model,
    ranking,
    selections,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Record (or update) one human assessment per criterion. */
export async function saveScores(companyId, rfqId, vendorId, scores = [], userId = null) {
  const model = resolveModel((await loadEvent(companyId, rfqId))?.rfx_type);
  const valid = new Set(model.criteria.map((c) => c.key));

  const written = [];
  for (const s of scores) {
    if (!s || !valid.has(s.criterion_key)) {
      const err = new Error(`'${s?.criterion_key}' is not a criterion of this scoring model`);
      err.status = 400;
      throw err;
    }
    const score = num(s.score);
    if (score == null || score < 0 || score > 100) {
      const err = new Error(`Score for '${s.criterion_key}' must be between 0 and 100`);
      err.status = 400;
      throw err;
    }
    const { rows } = await pool.query(
      `INSERT INTO rfx_criteria_scores
         (rfq_id, vendor_id, criterion_key, score, basis, note, scored_by_user_id, company_id, updated_at)
       VALUES ($1, $2, $3, $4, 'assessed', $5, $6, $7, NOW())
       ON CONFLICT (rfq_id, vendor_id, criterion_key)
       DO UPDATE SET score = EXCLUDED.score, basis = 'assessed', note = EXCLUDED.note,
                     scored_by_user_id = EXCLUDED.scored_by_user_id, updated_at = NOW()
       RETURNING *`,
      [rfqId, vendorId, s.criterion_key, score, s.note || null, userId, companyId ?? null]
    );
    written.push(rows[0]);
  }

  await pool.query(`UPDATE rfqs SET evaluated_at = NOW() WHERE id = $1`, [rfqId]);
  return written;
}

/**
 * Make a vendor the preferred source for what this event covered.
 *
 * This is the step the app never had. Awarding an RFQ closed a transaction;
 * this writes the outcome into the three places the rest of procurement
 * actually reads:
 *
 *   approved_vendor_list           — the AVL the PR/PO path checks
 *   item_vendor_prices.is_preferred — what the pricing surfaces badge
 *   inventory_items.preferred_vendor_id — what reorder and MRP default to
 *
 * Everything written is reported back in `applied_to`, because a selection that
 * silently touched nothing looks identical to one that worked.
 */
export async function selectPreferredVendor(companyId, rfqId, vendorId, payload = {}, userId = null) {
  const card = await getScorecard(companyId, rfqId);
  if (!card) {
    const err = new Error('RFx event not found');
    err.status = 404;
    throw err;
  }

  const bid = card.ranking.bids.find((b) => String(b.vendor_id) === String(vendorId));
  if (!bid) {
    const err = new Error('That vendor did not bid on this event');
    err.status = 400;
    throw err;
  }

  // The engine is allowed to disagree with the buyer. It is not allowed to be
  // silent about it afterwards.
  const rec = card.ranking.recommended_vendor_id;
  const followed = rec == null ? null : String(rec) === String(vendorId);

  if (card.ranking.decision !== 'recommended' && !payload.acknowledge_override) {
    const err = new Error(
      `${card.ranking.reason} Re-send with acknowledge_override to record the selection anyway.`
    );
    err.status = 409;
    throw err;
  }

  // The winning quote's full commercial terms — the scorecard carries only what
  // it scored, and the price row below needs the rest (MOQ, currency, validity).
  const { rows: quoteRows } = await pool.query(
    `SELECT * FROM rfq_quotes WHERE rfq_id = $1 AND vendor_id = $2 LIMIT 1`,
    [rfqId, vendorId]
  );
  const winningQuote = quoteRows[0] || null;
  const comparedQty = num(card.basis.compared_quantity, 0) || 0;

  const client = await pool.connect();
  const applied = { avl: [], prices: [], items: [] };
  try {
    await client.query('BEGIN');

    const itemIds = card.items.map((i) => i.item_id).filter((x) => x != null);

    for (const itemId of itemIds) {
      // AVL: one row per (item, vendor). No unique constraint exists on the
      // table, so this updates in place where a row is already there rather
      // than stacking duplicates the next reader would have to choose between.
      const { rows: existing } = await client.query(
        `SELECT id FROM approved_vendor_list
          WHERE item_id = $1 AND vendor_id = $2 AND ($3::int IS NULL OR company_id = $3)
          LIMIT 1`,
        [itemId, vendorId, companyId ?? null]
      );

      if (existing.length) {
        await client.query(
          `UPDATE approved_vendor_list
              SET status = 'approved', is_preferred = TRUE, source_rfq_id = $2,
                  approved_date = CURRENT_DATE, notes = $3, updated_at = NOW()
            WHERE id = $1`,
          [existing[0].id, rfqId, payload.rationale || `Selected from ${card.event.rfq_number}`]
        );
        applied.avl.push({ item_id: itemId, avl_id: existing[0].id, action: 'updated' });
      } else {
        const { rows: ins } = await client.query(
          `INSERT INTO approved_vendor_list
             (company_id, item_id, vendor_id, status, is_preferred, source_rfq_id,
              approved_date, valid_from, notes, lead_time_days)
           VALUES ($1, $2, $3, 'approved', TRUE, $4, CURRENT_DATE, CURRENT_DATE, $5, $6)
           RETURNING id`,
          [companyId ?? null, itemId, vendorId, rfqId,
           payload.rationale || `Selected from ${card.event.rfq_number}`,
           bid.delivery_days ?? null]
        );
        applied.avl.push({ item_id: itemId, avl_id: ins[0].id, action: 'inserted' });
      }

      // Exactly one preferred price per item — clear the rest first, or the
      // pricing surfaces end up badging two vendors as preferred at once.
      const { rowCount: cleared } = await client.query(
        `UPDATE item_vendor_prices SET is_preferred = FALSE, updated_at = NOW()
          WHERE item_id = $1 AND deleted_at IS NULL AND is_preferred = TRUE
            AND ($2::int IS NULL OR company_id = $2)`,
        [itemId, companyId ?? null]
      );
      let { rowCount: setPref } = await client.query(
        `UPDATE item_vendor_prices SET is_preferred = TRUE, updated_at = NOW()
          WHERE item_id = $1 AND vendor_id = $2 AND deleted_at IS NULL
            AND ($3::int IS NULL OR company_id = $3)`,
        [itemId, vendorId, companyId ?? null]
      );

      // The winner very often has no price row for the item — they were invited
      // to quote precisely because they were not already a source. Clearing the
      // old preferred flag and setting nothing would leave the item with NO
      // preferred price at all, so the pricing screens would show one fewer
      // preferred vendor than before the selection: a selection that made
      // things worse. Write the price the RFx just produced instead. It is the
      // freshest quote we have, and it is what §128 will cost the next PO on.
      let priceCreated = false;
      if (setPref === 0 && num(winningQuote?.unit_price) > 0) {
        await client.query(
          `INSERT INTO item_vendor_prices
             (item_id, vendor_id, unit_price, currency, moq, tax_pct, lead_time_days,
              last_quoted_date, valid_until, is_preferred, notes, company_id, created_by,
              freight_per_unit, tooling_cost, warranty_months)
           VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,TRUE,$9,$10,$11,$12,$13,$14)`,
          [
            itemId, vendorId,
            num(winningQuote.unit_price),
            winningQuote.currency || 'INR',
            num(winningQuote.moq, 0) || 0,
            num(winningQuote.tax_pct, 0) || 0,
            num(winningQuote.delivery_days),
            winningQuote.valid_until || null,
            `Preferred from ${card.event.rfq_number}`,
            companyId ?? null, userId,
            comparedQty > 0 && num(winningQuote.freight_amount) != null
              ? num(winningQuote.freight_amount) / comparedQty : null,
            num(winningQuote.tooling_cost),
            num(winningQuote.warranty_months),
          ]
        );
        setPref = 1;
        priceCreated = true;
      }
      applied.prices.push({ item_id: itemId, cleared, set_preferred: setPref, price_row_created: priceCreated });

      const { rowCount: itemUpdated } = await client.query(
        `UPDATE inventory_items SET preferred_vendor_id = $2, updated_at = NOW()
          WHERE id = $1 AND ($3::int IS NULL OR company_id = $3)`,
        [itemId, vendorId, companyId ?? null]
      );
      applied.items.push({ item_id: itemId, updated: itemUpdated });
    }

    // Other vendors on these items lose preferred standing but stay approved —
    // dropping them off the AVL entirely would quietly destroy the bench.
    if (itemIds.length) {
      await client.query(
        `UPDATE approved_vendor_list SET is_preferred = FALSE, updated_at = NOW()
          WHERE item_id = ANY($1::int[]) AND vendor_id <> $2 AND is_preferred = TRUE
            AND ($3::int IS NULL OR company_id = $3)`,
        [itemIds, vendorId, companyId ?? null]
      );
    }

    const { rows: sel } = await client.query(
      `INSERT INTO rfx_vendor_selections
         (rfq_id, vendor_id, company_id, engine_recommendation, followed_recommendation,
          total_score, coverage_pct, rank, runner_up_vendor_id, score_gap,
          scorecard_snapshot, model_snapshot, applied_to, rationale, selected_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        rfqId, vendorId, companyId ?? null,
        card.ranking.decision, followed,
        bid.total, bid.coverage_pct, bid.rank,
        card.ranking.runner_up?.vendor_id ?? null,
        card.ranking.gap,
        JSON.stringify(card.ranking.bids),
        JSON.stringify(card.model),
        JSON.stringify(applied),
        payload.rationale || null,
        userId,
      ]
    );

    await client.query(
      `UPDATE rfqs SET status = 'closed', evaluated_at = NOW() WHERE id = $1`,
      [rfqId]
    );

    await client.query('COMMIT');
    return { ...sel[0], applied_to: applied, no_items: itemIds.length === 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** RFx events, newest first — the list the evaluation screen opens from. */
export async function listEvents(companyId, { rfxType = null } = {}) {
  const { rows } = await pool.query(
    `SELECT r.id, r.rfq_number, r.rfx_type, r.status, r.item_description, r.required_by,
            r.category_id, r.evaluated_at, ic.name AS category_name,
            COUNT(q.id)::int                                        AS invited,
            COUNT(q.id) FILTER (WHERE q.unit_price > 0)::int        AS responded,
            COUNT(DISTINCT sc.vendor_id)::int                       AS vendors_scored,
            (SELECT v.vendor_name FROM rfx_vendor_selections s
               JOIN vendors v ON v.id = s.vendor_id
              WHERE s.rfq_id = r.id ORDER BY s.created_at DESC LIMIT 1) AS selected_vendor
       FROM rfqs r
       LEFT JOIN item_categories ic     ON ic.id = r.category_id
       LEFT JOIN rfq_quotes q           ON q.rfq_id = r.id
       LEFT JOIN rfx_criteria_scores sc ON sc.rfq_id = r.id
      WHERE ($1::int IS NULL OR r.company_id = $1)
        AND ($2::text IS NULL OR r.rfx_type = $2)
      GROUP BY r.id, ic.name
      ORDER BY r.created_at DESC
      LIMIT 200`,
    [companyId ?? null, rfxType]
  );
  return rows;
}

export default { getScorecard, saveScores, selectPreferredVendor, listEvents };
