/**
 * freight.service.js — the ONE loader of tonne-km freight inputs (§216).
 *
 * Every TCO caller (RFQ comparison + award snapshot, Component 360, the PO
 * advisory, RFx cost scoring, the portfolio rollup) builds its freight model
 * here and hands it to tcoEngine.modelFreight() through computeTco(). Nothing
 * else computes freight.
 *
 *   lane      freight_lanes (company, vendor, receiving warehouse). RFQs and POs
 *             carry no receiving location, so the warehouse is the company's
 *             designated main receiving point (procurement_settings).
 *   mode      the quote's transport_mode, else the lane's default.
 *   weight    per line: a vendor-quoted kg/unit (single-line RFQ only), else the
 *             item master's shipping_weight_kg — with its basis and the unit it
 *             is per. Never defaulted; never inferred from value.
 *   rate      the most specific APPROVED freight_rate_cards row in force on the
 *             comparison date: same mode; exact service level beats "any";
 *             exact freight category beats "all categories"; then the latest
 *             effective_from. A foreign-currency card is converted with the
 *             approved FX resolver (§215) or the line is missing 'fx'.
 *
 * Missing anything → it is named in `missing` (with item and quantity for a
 * weight), and modelFreight() refuses to produce an amount.
 *
 * No query is wrapped in .catch(): a missing table must surface, not become
 * "no lanes" and a quietly assumed freight.
 */
import pool from '../../shared/db.js';
import { resolveFxRates, normCurrency } from '../../finance/services/fxRate.service.js';

export const TRANSPORT_MODES = Object.freeze(['road', 'rail', 'air', 'ship']);
export const SERVICE_LEVELS  = Object.freeze(['FTL', 'LTL', 'FCL', 'LCL']);
export const DISTANCE_SOURCES = Object.freeze(['quoted', 'observed', 'estimated', 'manual']);
export const WEIGHT_BASES = Object.freeze(['quoted', 'observed', 'estimated', 'assumed']);

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const norm = (s) => (s == null ? null : String(s).trim().toLowerCase());

/** Pick the most specific approved card for (mode, service level, category). */
export function pickRateCard(cards, { mode, serviceLevel, category }) {
  const m = norm(mode); const sl = serviceLevel ? String(serviceLevel).toUpperCase() : null; const cat = norm(category);
  const fits = cards.filter((c) => norm(c.transport_mode) === m
    && (c.service_level == null || (sl != null && c.service_level === sl))
    && (c.freight_category == null || (cat != null && norm(c.freight_category) === cat)));
  const score = (c) => (c.service_level != null ? 2 : 0) + (c.freight_category != null ? 1 : 0);
  fits.sort((a, b) => (score(b) - score(a)) || (String(b.effective_from) > String(a.effective_from) ? 1 : -1) || (b.id - a.id));
  return fits[0] ?? null;
}

/**
 * loadFreightInputs(companyId, params, { vendorIds, lines, quoteOverrides })
 *   lines:  [{ item_id, item_label?, quantity, quantity_uom? }]  — the consignment
 *   quoteOverrides: Map(vendorId → { weight_kg_per_unit, transport_mode, service_level })
 * Returns Map(vendorId → freight_model) for tcoEngine.modelFreight().
 */
export async function loadFreightInputs(companyId, params, { vendorIds = [], lines = [], quoteOverrides = new Map(), db = pool } = {}) {
  const out = new Map();
  const vids = [...new Set(vendorIds.map(Number).filter(Number.isFinite))];
  if (!vids.length) return out;
  const warehouseId = params.main_receiving_warehouse_id ?? null;
  const itemIds = [...new Set(lines.map((l) => Number(l.item_id)).filter(Number.isFinite))];

  const [itemsRes, lanesRes, cardsRes, whRes] = await Promise.all([
    itemIds.length && companyId != null
      ? db.query(
        `SELECT id, item_code, item_name, unit_of_measure, shipping_weight_kg, shipping_weight_basis,
                shipping_weight_uom, freight_category
           FROM inventory_items WHERE id = ANY($1::int[]) AND company_id = $2`, [itemIds, companyId])
      : { rows: [] },
    warehouseId != null && companyId != null
      ? db.query(
        `SELECT id, vendor_id, warehouse_id, distance_km, distance_source, default_transport_mode,
                default_service_level, confirmed_by_user_id, confirmed_at
           FROM freight_lanes WHERE company_id = $1 AND warehouse_id = $2 AND vendor_id = ANY($3::int[])`,
        [companyId, warehouseId, vids])
      : { rows: [] },
    companyId != null
      ? db.query(
        `SELECT id, transport_mode, service_level, freight_category, rate_per_tonne_km, currency,
                effective_from::text AS effective_from, source, approved_by_user_id, approved_at
           FROM freight_rate_cards
          WHERE company_id = $1 AND status = 'approved' AND effective_from <= CURRENT_DATE`, [companyId])
      : { rows: [] },
    warehouseId != null && companyId != null
      ? db.query(`SELECT id, COALESCE(warehouse_name, name) AS name FROM warehouses WHERE id = $1 AND company_id = $2`, [warehouseId, companyId])
      : { rows: [] },
  ]);
  const items = new Map(itemsRes.rows.map((r) => [Number(r.id), r]));
  const lanes = new Map(lanesRes.rows.map((r) => [Number(r.vendor_id), r]));
  const cards = cardsRes.rows;
  const receivingPoint = whRes.rows[0] ?? null;

  const base = params.base_currency || 'INR';
  const fx = await resolveFxRates(companyId, cards.map((c) => c.currency), {
    baseCurrency: base, maxAgeDays: params.tco_fx_max_age_days, db,
  });

  for (const vid of vids) {
    const lane = lanes.get(vid) ?? null;
    const ov = quoteOverrides.get(vid) ?? {};
    const missing = [];
    if (warehouseId == null || !receivingPoint) {
      missing.push({ input: 'distance', message: 'No main receiving point is designated in Procurement Settings → Freight, so no lane applies.' });
    } else if (!lane) {
      missing.push({ input: 'distance', message: `No confirmed freight lane from this vendor to ${receivingPoint.name}.` });
    }
    const mode = ov.transport_mode || lane?.default_transport_mode || null;
    const serviceLevel = ov.service_level || lane?.default_service_level || null;
    if (!mode) missing.push({ input: 'transport_mode', message: 'No transport mode on the quote or the lane, so no rate card can be chosen.' });

    const modelLines = lines.map((l) => {
      const it = l.item_id != null ? items.get(Number(l.item_id)) : null;
      const label = l.item_label || (it ? `${it.item_code} — ${it.item_name}` : null);
      const qtyUom = l.quantity_uom || it?.unit_of_measure || null;
      const quoted = lines.length === 1 && num(ov.weight_kg_per_unit) != null;
      const weight = quoted ? num(ov.weight_kg_per_unit) : num(it?.shipping_weight_kg);
      const weightBasis = quoted ? 'quoted' : (it?.shipping_weight_basis ?? null);
      // A quoted weight is per the quote's (= the line's) unit.
      // A quoted weight is per the unit the vendor stated (§219), else per the
      // line's unit as before; a mismatch is reported, never converted.
      const weightUom = quoted ? (ov.weight_uom || qtyUom) : (it?.shipping_weight_uom ?? null);
      const category = it?.freight_category ?? null;

      let rate = null; let rateUnavailable = null; let card = null; let rateFx = null;
      if (mode) {
        card = pickRateCard(cards, { mode, serviceLevel, category });
        if (!card) {
          rateUnavailable = { reason: 'rate', message: `No approved ${mode}${serviceLevel ? ` ${serviceLevel}` : ''} rate card for ${category || 'uncategorised items'} in force today.` };
        } else {
          const cur = normCurrency(card.currency) || base;
          if (cur === base) {
            rate = num(card.rate_per_tonne_km);
          } else {
            const r = fx.get(cur);
            if (r?.ok) {
              rate = num(card.rate_per_tonne_km) * r.rate;
              rateFx = { rate: r.rate, from: cur, to: base, method: r.method, rate_id: r.rate_id, rate_date: r.rate_date, source: r.source };
            } else {
              rateUnavailable = { reason: 'fx', message: `Rate card #${card.id} is in ${cur}: ${r?.message || 'no approved exchange rate'}` };
            }
          }
        }
      }
      return {
        item_id: l.item_id ?? null, item_label: label, quantity: num(l.quantity), quantity_uom: qtyUom,
        weight_kg_per_unit: weight, weight_basis: weightBasis, weight_uom: weightUom, freight_category: category,
        rate_per_tonne_km: rate, rate_card_id: card?.id ?? null,
        rate_card: card ? { id: card.id, rate_per_tonne_km: num(card.rate_per_tonne_km), currency: card.currency,
          effective_from: card.effective_from, transport_mode: card.transport_mode, service_level: card.service_level,
          freight_category: card.freight_category, source: card.source, approved_by_user_id: card.approved_by_user_id } : null,
        rate_fx: rateFx, rate_unavailable: rateUnavailable,
        // The mode itself is missing: reported once above, not once per line.
        rate_missing_reported: !mode,
      };
    });

    out.set(vid, {
      distance_km: lane ? num(lane.distance_km) : null,
      distance_source: lane?.distance_source ?? null,
      lane_id: lane?.id ?? null,
      lane_confirmed_by_user_id: lane?.confirmed_by_user_id ?? null,
      receiving_warehouse_id: receivingPoint?.id ?? null,
      receiving_warehouse: receivingPoint?.name ?? null,
      transport_mode: mode, service_level: serviceLevel,
      lines: modelLines, missing,
    });
  }
  return out;
}

export default { loadFreightInputs, pickRateCard, TRANSPORT_MODES, SERVICE_LEVELS, DISTANCE_SOURCES, WEIGHT_BASES };
