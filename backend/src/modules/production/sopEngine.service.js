// backend/src/modules/production/sopEngine.service.js
//
// Rough-Cut Capacity Planning (RCCP) and Sales & Operations Planning (S&OP).
// Both are read-only aggregations over existing data — no persistence.
//
// RCCP: validate the MPS against critical work centres BEFORE full MRP, using each
//   product's routing as its bill-of-resources (hours/unit per work centre).
// S&OP: aggregate demand vs supply vs projected inventory per product over a
//   longer (monthly) horizon.

import pool from '../../config/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const workdayIndex = (d) => (d.getDay() + 6) % 7;

function workingDaysInBucket(start, end, daysPerWeek) {
  let n = 0;
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) if (workdayIndex(new Date(t)) < daysPerWeek) n++;
  return n;
}
function makeBuckets(today, horizonDays, bucketDays) {
  const end = addDays(today, horizonDays), out = [];
  for (let i = 0, t = today.getTime(); t < end.getTime(); i++, t += bucketDays * DAY_MS)
    out.push({ index: i, start: new Date(t), end: new Date(Math.min(t + bucketDays * DAY_MS, end.getTime())) });
  return out;
}
const scopeExpr = (companyId, col = 'company_id') => companyId != null ? `(${col} = ${Number(companyId)} OR ${col} IS NULL)` : 'TRUE';

/** RCCP — load MPS onto work centres via product routing (bill-of-resources). */
export async function runRCCP({ companyId, horizonDays = 168, bucketDays = 28 }) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const buckets = makeBuckets(today, horizonDays, bucketDays);
  const nB = buckets.length;
  const biOf = (date) => { if (!date) return 0; const d = new Date(date); if (d < today) return 0; if (d >= addDays(today, horizonDays)) return -1;
    return Math.min(nB - 1, Math.floor((d.getTime() - today.getTime()) / (bucketDays * DAY_MS))); };

  const { rows: wcRows } = await pool.query(`
    SELECT id, name, COALESCE(capacity_hours_per_day,8) capacity_hours_per_day, COALESCE(efficiency_pct,100) efficiency_pct,
           COALESCE(working_days_per_week,5) working_days_per_week, COALESCE(num_machines,1) num_machines
      FROM work_centres WHERE ${scopeExpr(companyId)} AND COALESCE(status,'active') <> 'inactive'`);

  // MPS lines
  const { rows: mps } = await pool.query(`
    SELECT product_id, product_name, due_date, (COALESCE(quantity,0) - COALESCE(quantity_produced,0)) qty
      FROM master_production_schedule WHERE ${scopeExpr(companyId)} AND status IN ('firm','planned','released')
       AND (COALESCE(quantity,0) - COALESCE(quantity_produced,0)) > 0`);

  // bill-of-resources: routing hours/unit per work centre, per product's active BOM
  const borCache = new Map(); // product_id -> [{work_centre_id, hoursPerUnit, setup}]
  async function borFor(productId) {
    if (borCache.has(productId)) return borCache.get(productId);
    let bor = [];
    if (productId) {
      const { rows } = await pool.query(`
        SELECT rs.work_centre_id, COALESCE(rs.std_time_hrs,0) hrs, COALESCE(rs.setup_time_hrs,0) setup
          FROM routing_steps rs JOIN bom_headers bh ON bh.id = rs.bom_id
         WHERE bh.product_id = $1 AND bh.status = 'active' AND rs.work_centre_id IS NOT NULL`, [productId]);
      bor = rows.map(r => ({ work_centre_id: r.work_centre_id, hoursPerUnit: num(r.hrs), setup: num(r.setup) }));
    }
    borCache.set(productId, bor);
    return bor;
  }

  const load = new Map(); // wcId -> Map(bucket -> {hours, contributors:[]})
  const cell = (wc, b) => { if (!load.has(wc)) load.set(wc, new Map()); const m = load.get(wc);
    if (!m.has(b)) m.set(b, { hours: 0, contributors: [] }); return m.get(b); };
  for (const line of mps) {
    const b = biOf(line.due_date); if (b < 0) continue;
    const bor = await borFor(line.product_id);
    for (const r of bor) {
      const hrs = r.setup + r.hoursPerUnit * num(line.qty);
      if (hrs <= 0) continue;
      const c = cell(r.work_centre_id, b); c.hours += hrs;
      if (c.contributors.length < 20) c.contributors.push({ product: line.product_name, hours: Math.round(hrs * 100) / 100 });
    }
  }

  const grid = [];
  let overloaded = 0, peak = 0;
  for (const wc of wcRows) {
    for (const b of buckets) {
      const wd = workingDaysInBucket(b.start, b.end, wc.working_days_per_week);
      const available = num(wc.capacity_hours_per_day) * wd * (num(wc.efficiency_pct) / 100) * (wc.num_machines || 1);
      const c = load.get(wc.id)?.get(b.index) || { hours: 0, contributors: [] };
      const required = c.hours;
      const pct = available > 0 ? (required / available) * 100 : (required > 0 ? 999 : 0);
      const over = required > available + 1e-6 && required > 0;
      if (over) overloaded++;
      if (pct > peak) peak = pct;
      grid.push({ work_centre_id: wc.id, work_centre_name: wc.name, bucket_index: b.index,
        bucket_start: isoDate(b.start), bucket_end: isoDate(b.end),
        available_hours: Math.round(available * 100) / 100, required_hours: Math.round(required * 100) / 100,
        load_pct: Math.round(pct * 10) / 10, is_overloaded: over, contributors: c.contributors });
    }
  }
  return { buckets: buckets.map(b => ({ index: b.index, start: isoDate(b.start), end: isoDate(b.end) })),
    work_centres: wcRows.map(w => ({ id: w.id, name: w.name })), load: grid,
    summary: { work_centres: wcRows.length, buckets: nB, overloaded_buckets: overloaded, peak_load_pct: Math.round(peak * 10) / 10, mps_lines: mps.length } };
}

/** S&OP — aggregate demand / supply / projected inventory per product over the horizon. */
export async function runSOP({ companyId, horizonDays = 168, bucketDays = 28 }) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const buckets = makeBuckets(today, horizonDays, bucketDays);
  const nB = buckets.length;
  const biOf = (date) => { if (!date) return 0; const d = new Date(date); if (d < today) return 0; if (d >= addDays(today, horizonDays)) return -1;
    return Math.min(nB - 1, Math.floor((d.getTime() - today.getTime()) / (bucketDays * DAY_MS))); };

  const products = new Map(); // item_id -> {name, on_hand, demand[], supply[]}
  const P = (id, name, onHand = 0) => { if (!products.has(id)) products.set(id, { id, name, on_hand: onHand, demand: new Array(nB).fill(0), supply: new Array(nB).fill(0) }); return products.get(id); };

  const { rows: itemRows } = await pool.query(
    `SELECT id, item_name, item_code, COALESCE(current_stock,0) current_stock FROM inventory_items WHERE ${scopeExpr(companyId)} AND deleted_at IS NULL AND COALESCE(is_active,true)`);
  const byCode = new Map(), byName = new Map();
  for (const r of itemRows) { if (r.item_code) byCode.set(String(r.item_code).toLowerCase(), r); if (r.item_name) byName.set(String(r.item_name).toLowerCase(), r); }

  // demand: MPS + forecast + sales orders
  const mps = (await pool.query(`SELECT product_id,product_name,due_date,(COALESCE(quantity,0)-COALESCE(quantity_produced,0)) qty FROM master_production_schedule WHERE ${scopeExpr(companyId)} AND status IN ('firm','planned','released') AND (COALESCE(quantity,0)-COALESCE(quantity_produced,0))>0`)).rows;
  for (const r of mps) { const b = biOf(r.due_date); if (b < 0 || !r.product_id) continue; const it = itemRows.find(x => x.id === r.product_id); P(r.product_id, r.product_name, num(it?.current_stock)).demand[b] += num(r.qty); }
  const fc = (await pool.query(`SELECT item_id,product_name,forecast_date,(COALESCE(quantity,0)-COALESCE(consumed_qty,0)) qty FROM demand_forecasts WHERE ${scopeExpr(companyId)} AND (COALESCE(quantity,0)-COALESCE(consumed_qty,0))>0`)).rows;
  for (const r of fc) { const b = biOf(r.forecast_date); if (b < 0 || !r.item_id) continue; const it = itemRows.find(x => x.id === r.item_id); P(r.item_id, r.product_name || it?.item_name, num(it?.current_stock)).demand[b] += num(r.qty); }
  const so = (await pool.query(`SELECT soi.item_code, soi.description, (COALESCE(soi.quantity,0)-COALESCE(soi.fulfilled_qty,0)) qty, COALESCE(so.delivery_date,so.order_date) due FROM sales_order_items soi JOIN sales_orders so ON so.id=soi.order_id WHERE ${scopeExpr(companyId, 'so.company_id')} AND so.deleted_at IS NULL AND LOWER(COALESCE(so.order_status,'')) NOT IN ('cancelled','completed','delivered','closed') AND (COALESCE(soi.quantity,0)-COALESCE(soi.fulfilled_qty,0))>0`)).rows;
  for (const r of so) { const b = biOf(r.due); if (b < 0) continue; const it = (r.item_code && byCode.get(String(r.item_code).toLowerCase())) || (r.description && byName.get(String(r.description).toLowerCase())); if (it) P(it.id, it.item_name, num(it.current_stock)).demand[b] += num(r.qty); }

  // supply: open production orders + latest MRP planned make orders
  const po = (await pool.query(`SELECT product_id,product_name,(COALESCE(quantity_planned,0)-COALESCE(quantity_completed,0)-COALESCE(quantity_scrapped,0)) qty, COALESCE(planned_end_date,planned_start_date) due FROM production_orders WHERE ${scopeExpr(companyId)} AND status IN ('planned','released','in_progress','on_hold') AND (COALESCE(quantity_planned,0)-COALESCE(quantity_completed,0)-COALESCE(quantity_scrapped,0))>0`)).rows;
  for (const r of po) { const b = biOf(r.due); if (b < 0 || !r.product_id) continue; const it = itemRows.find(x => x.id === r.product_id); P(r.product_id, r.product_name, num(it?.current_stock)).supply[b] += num(r.qty); }
  try {
    const { rows: [lastMrp] } = await pool.query(`SELECT id FROM mrp_runs WHERE ${scopeExpr(companyId)} ORDER BY created_at DESC LIMIT 1`);
    if (lastMrp) {
      const pl = (await pool.query(`SELECT item_id,item_name,quantity,need_date FROM mrp_planned_orders WHERE run_id=$1 AND order_type='make' AND status IN ('planned','firmed')`, [lastMrp.id])).rows;
      for (const r of pl) { const b = biOf(r.need_date); if (b < 0 || !r.item_id) continue; const it = itemRows.find(x => x.id === r.item_id); P(r.item_id, r.item_name, num(it?.current_stock)).supply[b] += num(r.quantity); }
    }
  } catch (e) { /* */ }

  const rows = [];
  for (const p of products.values()) {
    let inv = p.on_hand;
    const cells = buckets.map(b => {
      inv = inv + p.supply[b.index] - p.demand[b.index];
      return { bucket_index: b.index, demand: Math.round(p.demand[b.index] * 1000) / 1000,
        supply: Math.round(p.supply[b.index] * 1000) / 1000, projected_inventory: Math.round(inv * 1000) / 1000 };
    });
    rows.push({ item_id: p.id, item_name: p.name, on_hand: p.on_hand, cells,
      total_demand: Math.round(p.demand.reduce((s, x) => s + x, 0) * 1000) / 1000,
      total_supply: Math.round(p.supply.reduce((s, x) => s + x, 0) * 1000) / 1000 });
  }
  rows.sort((a, b) => b.total_demand - a.total_demand);
  return { buckets: buckets.map(b => ({ index: b.index, start: isoDate(b.start), end: isoDate(b.end) })), products: rows,
    summary: { products: rows.length } };
}
