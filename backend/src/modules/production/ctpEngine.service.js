// backend/src/modules/production/ctpEngine.service.js
//
// Capable-to-Promise (CTP) — ATP checked against capacity.
// Answers "can we promise `quantity` of an item by `needDate`?":
//   1. Material: available-to-promise by the need date (from computeATP).
//   2. Shortfall = requested − ATP must be PRODUCED (make items). Check whether the
//      product's routing work centres have enough FREE capacity (available − firm
//      load) by the need date; the binding work centre sets the capacity date.
//   3. Promise date = capacity-available bucket + production lead time, with the
//      limiting constraint reported.
// Buy items have no routing → CTP falls back to material + purchase lead time.

import pool from '../../config/db.js';
import { computeATP } from './mrpEngine.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const workdayIndex = (d) => (d.getDay() + 6) % 7;
const workingDays = (start, end, dpw) => {
  let n = 0;
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) if (workdayIndex(new Date(t)) < dpw) n++;
  return n;
};

export async function computeCTP({ companyId, itemId, quantity, needDate, horizonDays = 180, bucketDays = 7 }) {
  const qty = num(quantity);
  const today = new Date(new Date().toISOString().slice(0, 10));
  const horizonEnd = addDays(today, horizonDays);
  const need = needDate ? new Date(needDate) : horizonEnd;
  const scope = (col) => companyId != null ? `(${col} = ${Number(companyId)} OR ${col} IS NULL)` : 'TRUE';

  const { rows: [item] } = await pool.query(
    `SELECT id, item_code, item_name, unit_of_measure, COALESCE(current_stock,0) current_stock,
            COALESCE(lead_time_days,0) lead_time_days, COALESCE(make_or_buy,'buy') make_or_buy
       FROM inventory_items WHERE id = $1`, [itemId]);
  if (!item) return null;

  const buckets = [];
  for (let i = 0, t = today.getTime(); t < horizonEnd.getTime(); i++, t += bucketDays * DAY_MS)
    buckets.push({ index: i, start: new Date(t), end: new Date(Math.min(t + bucketDays * DAY_MS, horizonEnd.getTime())) });
  const nB = buckets.length;
  const biOf = (date) => {
    if (!date) return nB - 1;
    const d = new Date(date);
    if (d < today) return 0;
    if (d >= horizonEnd) return nB - 1;
    return Math.min(nB - 1, Math.floor((d.getTime() - today.getTime()) / (bucketDays * DAY_MS)));
  };
  const needBucket = biOf(need);

  // 1. Material availability (ATP)
  const atpResult = await computeATP({ companyId, itemId, horizonDays, bucketDays });
  const atpByNeed = Math.max(0, atpResult.grid[needBucket]?.cumulative_atp ?? 0);
  let atpDate = null;
  for (const g of atpResult.grid) if (g.cumulative_atp >= qty - 1e-6) { atpDate = g.bucket_start; break; }

  if (atpByNeed >= qty - 1e-6) {
    return { item: atpResult.item, requested_qty: qty, need_date: isoDate(need), capable: true,
      promise_qty: qty, promise_date: atpDate || isoDate(need), limiting_constraint: 'none', mode: 'ATP',
      atp_available_by_need: Math.round(atpByNeed * 1000) / 1000, shortfall_to_produce: 0, capacity: [],
      explanation: 'Fully promisable from available-to-promise material.' };
  }

  const shortfall = Math.round((qty - atpByNeed) * 1000) / 1000;
  const make = item.make_or_buy === 'make';

  // Buy item → promise on purchase lead time for the shortfall
  if (!make) {
    const supplyDate = addDays(today, item.lead_time_days);
    const capable = supplyDate <= need;
    return { item: atpResult.item, requested_qty: qty, need_date: isoDate(need), capable,
      promise_qty: qty, promise_date: isoDate(supplyDate > need ? supplyDate : need),
      limiting_constraint: capable ? 'material' : 'lead_time', mode: 'buy',
      atp_available_by_need: Math.round(atpByNeed * 1000) / 1000, shortfall_to_produce: shortfall, capacity: [],
      explanation: 'Buy item: ' + shortfall + ' short must be purchased (lead time ' + item.lead_time_days + 'd, ready ' + isoDate(supplyDate) + ').' };
  }

  // 2. Make item → capacity check on routing work centres
  const { rows: bor } = await pool.query(
    'SELECT rs.work_centre_id, wc.name work_centre_name, COALESCE(rs.std_time_hrs,0) hpu, COALESCE(rs.setup_time_hrs,0) setup, ' +
    'COALESCE(wc.capacity_hours_per_day,8) cap, COALESCE(wc.efficiency_pct,100) eff, ' +
    'COALESCE(wc.working_days_per_week,5) dpw, COALESCE(wc.num_machines,1) mach ' +
    'FROM routing_steps rs JOIN bom_headers bh ON bh.id = rs.bom_id ' +
    'LEFT JOIN work_centres wc ON wc.id = rs.work_centre_id ' +
    "WHERE bh.product_id = $1 AND bh.status = 'active' AND rs.work_centre_id IS NOT NULL", [itemId]);

  if (bor.length === 0) {
    const d = addDays(today, item.lead_time_days);
    return { item: atpResult.item, requested_qty: qty, need_date: isoDate(need), capable: d <= need,
      promise_qty: qty, promise_date: isoDate(d > need ? d : need), limiting_constraint: 'lead_time', mode: 'make-no-routing',
      atp_available_by_need: Math.round(atpByNeed * 1000) / 1000, shortfall_to_produce: shortfall, capacity: [],
      explanation: 'Make item with no active routing — promised on lead time only.' };
  }

  // firm load per work centre per bucket (open production operations, qty-weighted)
  const wcIds = [...new Set(bor.map(r => r.work_centre_id))];
  const firm = new Map();
  wcIds.forEach(id => firm.set(id, new Array(nB).fill(0)));
  try {
    const { rows: ops } = await pool.query(
      'SELECT op.work_centre_id, COALESCE(op.std_time_hrs,0) hrs, ' +
      '(COALESCE(po.quantity_planned,0)-COALESCE(po.quantity_completed,0)) rem, po.quantity_planned, ' +
      'COALESCE(op.started_at, po.planned_start_date) anchor ' +
      'FROM production_operations op JOIN production_orders po ON po.id = op.production_order_id ' +
      "WHERE " + scope('op.company_id') + " AND op.status NOT IN ('completed','skipped') " +
      "AND po.status NOT IN ('completed','cancelled') AND op.work_centre_id = ANY($1)", [wcIds]);
    for (const o of ops) {
      if (!firm.has(o.work_centre_id)) continue;
      const useQty = num(o.rem) > 0 ? num(o.rem) : num(o.quantity_planned);
      const h = num(o.hrs) * useQty;
      if (h <= 0) continue;
      firm.get(o.work_centre_id)[biOf(o.anchor)] += h;
    }
  } catch (e) { /* production tables optional */ }

  const capacity = [];
  let capacityBucket = 0;
  let capacityFeasible = true;
  for (const r of bor) {
    const required = num(r.setup) + num(r.hpu) * shortfall;
    const load = firm.get(r.work_centre_id) || new Array(nB).fill(0);
    let cumFree = 0, satBucket = -1;
    for (let b = 0; b < nB; b++) {
      const wd = workingDays(buckets[b].start, buckets[b].end, r.dpw);
      const avail = num(r.cap) * wd * (num(r.eff) / 100) * (r.mach || 1);
      cumFree += Math.max(0, avail - load[b]);
      if (cumFree >= required - 1e-6) { satBucket = b; break; }
    }
    if (satBucket < 0) { capacityFeasible = false; satBucket = nB - 1; }
    if (satBucket > capacityBucket) capacityBucket = satBucket;
    capacity.push({ work_centre_id: r.work_centre_id, work_centre_name: r.work_centre_name,
      required_hours: Math.round(required * 100) / 100, earliest_bucket: satBucket,
      earliest_date: isoDate(buckets[satBucket].start), feasible: capacityFeasible });
  }

  const promiseDate = addDays(buckets[capacityBucket].start, item.lead_time_days);
  const capable = capacityFeasible && promiseDate <= need;
  const limiting = !capacityFeasible ? 'capacity' : (promiseDate > need ? 'capacity' : 'material');

  return { item: atpResult.item, requested_qty: qty, need_date: isoDate(need), capable,
    promise_qty: qty, promise_date: isoDate(promiseDate), limiting_constraint: limiting, mode: 'make',
    atp_available_by_need: Math.round(atpByNeed * 1000) / 1000, shortfall_to_produce: shortfall, capacity,
    explanation: capable
      ? 'Promisable: ' + Math.round(atpByNeed) + ' from ATP + ' + shortfall + ' produced; capacity clears by ' + isoDate(buckets[capacityBucket].start) + ', ready ' + isoDate(promiseDate) + '.'
      : 'Not capable by ' + isoDate(need) + ' — ' + (limiting === 'capacity' ? 'work-centre capacity' : 'material') + ' constrained; earliest ' + isoDate(promiseDate) + '.' };
}
