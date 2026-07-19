// backend/src/modules/production/mrpEngine.service.js
//
// Regenerative, multi-level, TIME-PHASED MRP II planning engine.
//
// Pipeline (classic MRP logic):
//   1. Load item planning master (on-hand, safety stock, lead time, lot rules).
//   2. Build the BOM graph and compute Low-Level Codes (LLC) so components are
//      always planned AFTER every parent that consumes them.
//   3. Collect independent demand: sales orders, MPS, forecasts (within horizon).
//   4. Collect DATED scheduled receipts: open POs and open production orders.
//   5. Process items in ascending LLC order. For each item, run the time-phased
//      record across buckets:
//        projected_available[b] = prev + scheduled + planned - gross
//        net[b] = max(0, safety + gross - prev - scheduled)
//        net>0 → planned order receipt (lot-sized) in bucket b, release offset by
//                lead time; make orders explode one BOM level → child demand at
//                the release date.
//   6. Emit planned orders + a persisted time-phased grid + exception messages.

import pool from '../../config/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Lot-sizing: turn a raw net requirement into an order quantity per item rules. */
function applyLotSizing(item, net) {
  let q = net;
  const rule = item.lot_sizing_rule || 'lot_for_lot';
  const lot = num(item.lot_size_qty);

  if (rule === 'fixed_qty' && lot > 0) {
    q = Math.ceil(net / lot) * lot;
  } else if (rule === 'min_max') {
    const target = num(item.max_order_qty) > 0 ? num(item.max_order_qty) : net;
    q = Math.max(net, target);
  } else if (rule === 'eoq' && lot > 0) {
    q = Math.ceil(net / lot) * lot;
  }
  if (num(item.min_order_qty) > 0) q = Math.max(q, num(item.min_order_qty));
  if (lot > 0 && rule !== 'fixed_qty' && rule !== 'eoq') q = Math.ceil(q / lot) * lot;
  return Math.round(q * 1000) / 1000;
}

/**
 * Run a regenerative, time-phased MRP pass and persist the result.
 * @returns {Promise<{run, plannedOrders, exceptions, unmatched, timePhased}>}
 */
export async function runMRP({ companyId, horizonDays = 90, bucketDays = 7, includeSalesOrders = true,
  includeMPS = true, includeForecast = true, actor = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const today = new Date(new Date().toISOString().slice(0, 10));
    const horizonEnd = addDays(today, horizonDays);
    bucketDays = Math.max(1, Math.min(31, parseInt(bucketDays, 10) || 7));
    const scope = (col = 'company_id') => companyId != null ? `(${col} = ${Number(companyId)} OR ${col} IS NULL)` : 'TRUE';

    // ── Time buckets ──
    const buckets = [];
    for (let i = 0, t = today.getTime(); t < horizonEnd.getTime(); i++, t += bucketDays * DAY_MS) {
      buckets.push({ index: i, start: new Date(t), end: new Date(Math.min(t + bucketDays * DAY_MS, horizonEnd.getTime())) });
    }
    const nB = buckets.length;
    const bucketIndexOf = (date) => {
      if (!date) return 0;
      const d = new Date(date);
      if (d < today) return 0;                                   // overdue → first bucket
      if (d >= horizonEnd) return -1;                            // beyond horizon
      return Math.min(nB - 1, Math.floor((d.getTime() - today.getTime()) / (bucketDays * DAY_MS)));
    };
    const leadBuckets = (leadDays) => Math.ceil(num(leadDays) / bucketDays);

    // ── 1. Item planning master ──────────────────────────────────────────────
    const { rows: itemRows } = await client.query(`
      SELECT id, item_code, item_name, unit_of_measure,
             COALESCE(current_stock,0)   AS current_stock,
             COALESCE(safety_stock,0)    AS safety_stock,
             COALESCE(lead_time_days,0)  AS lead_time_days,
             COALESCE(min_order_qty,0)   AS min_order_qty,
             COALESCE(max_order_qty,0)   AS max_order_qty,
             COALESCE(lot_size_qty,0)    AS lot_size_qty,
             COALESCE(lot_sizing_rule,'lot_for_lot') AS lot_sizing_rule,
             COALESCE(make_or_buy,'buy') AS make_or_buy,
             COALESCE(standard_cost,0)   AS standard_cost,
             preferred_vendor_id
        FROM inventory_items
       WHERE ${scope()} AND COALESCE(is_active,true) = true AND deleted_at IS NULL`);

    const items = new Map(), byCode = new Map(), byName = new Map();
    for (const r of itemRows) {
      const it = { ...r, current_stock: num(r.current_stock), safety_stock: num(r.safety_stock),
        lead_time_days: parseInt(r.lead_time_days, 10) || 0, standard_cost: num(r.standard_cost) };
      items.set(r.id, it);
      if (r.item_code) byCode.set(String(r.item_code).toLowerCase(), it);
      if (r.item_name) byName.set(String(r.item_name).toLowerCase(), it);
    }

    // ── 2. BOM graph + Low-Level Codes ───────────────────────────────────────
    const { rows: bomHeaders } = await client.query(
      `SELECT id, product_id FROM bom_headers WHERE ${scope()} AND status = 'active' AND product_id IS NOT NULL`);
    const bomByProduct = new Map();
    for (const b of bomHeaders) if (!bomByProduct.has(b.product_id)) bomByProduct.set(b.product_id, b.id);

    const { rows: bomLines } = await client.query(
      `SELECT bl.component_id, bl.component_name, bl.qty, bh.product_id
         FROM bom_lines bl JOIN bom_headers bh ON bh.id = bl.bom_id
        WHERE ${scope('bh.company_id')} AND bh.status = 'active'`);
    const childrenOf = new Map();
    for (const l of bomLines) {
      if (l.product_id == null) continue;
      if (!childrenOf.has(l.product_id)) childrenOf.set(l.product_id, []);
      childrenOf.get(l.product_id).push({ component_id: l.component_id, component_name: l.component_name, qtyPer: num(l.qty) });
    }
    // phantom assemblies: item ids whose active BOM is flagged phantom (blow-through, never planned)
    const phantomItems = new Set();
    try {
      const { rows } = await client.query(
        `SELECT product_id FROM bom_headers WHERE ${scope()} AND status = 'active' AND is_phantom = true AND product_id IS NOT NULL`);
      for (const r of rows) phantomItems.add(r.product_id);
    } catch (e) { /* column may not exist pre-migration */ }

    // co-/by-products: primary product_id -> [{item_id, qtyPer, type}]
    const coproductsOf = new Map();
    const coproductItems = new Set();
    try {
      const { rows } = await client.query(`
        SELECT bh.product_id, bo.item_id, bo.qty_per_parent, bo.output_type
          FROM bom_outputs bo JOIN bom_headers bh ON bh.id = bo.bom_id
         WHERE ${scope('bo.company_id')} AND bh.status = 'active' AND bh.product_id IS NOT NULL AND bo.item_id IS NOT NULL`);
      for (const r of rows) {
        if (!coproductsOf.has(r.product_id)) coproductsOf.set(r.product_id, []);
        coproductsOf.get(r.product_id).push({ item_id: r.item_id, qtyPer: num(r.qty_per_parent), type: r.output_type });
        coproductItems.add(r.item_id);
      }
    } catch (e) { /* table may not exist pre-migration */ }

    const llc = new Map();
    for (const id of items.keys()) llc.set(id, 0);
    const parents = [...childrenOf.keys()];
    for (let pass = 0; pass < 25; pass++) {
      let changed = false;
      for (const p of parents) {
        const pc = llc.get(p) ?? 0;
        for (const c of childrenOf.get(p)) {
          if (c.component_id == null) continue;
          const cur = llc.get(c.component_id) ?? 0;
          if (cur < pc + 1) { llc.set(c.component_id, pc + 1); changed = true; }
        }
      }
      // co-products must be planned AFTER their primary so co-product supply is known
      for (const [primary, cos] of coproductsOf) {
        const pc = llc.get(primary) ?? 0;
        for (const co of cos) {
          const cur = llc.get(co.item_id) ?? 0;
          if (cur < pc + 1) { llc.set(co.item_id, pc + 1); changed = true; }
        }
      }
      if (!changed) break;
    }
    const isMake = (item) => item && (item.make_or_buy === 'make' || bomByProduct.has(item.id));

    // Blow a component's demand through any phantom levels down to real (stocked) items.
    const explodeToChildren = (childId, childName, qty, date, parentName, depth = 0) => {
      if (depth > 15 || qty <= 0) return;
      const child = (childId && items.has(childId)) ? items.get(childId)
        : (childName && byName.get(String(childName).toLowerCase()));
      if (!child) return;
      if (phantomItems.has(child.id) && childrenOf.has(child.id)) {
        for (const k of childrenOf.get(child.id))
          explodeToChildren(k.component_id, k.component_name, k.qtyPer * qty, date, parentName, depth + 1);
      } else {
        pushDemand(child.id, qty, date, 'production', parentName);
      }
    };

    // demand accumulator: item_id -> [{qty, date, source, ref}]
    const demand = new Map();
    const pushDemand = (itemId, qty, date, source, ref) => {
      if (!itemId || qty <= 0) return;
      if (!demand.has(itemId)) demand.set(itemId, []);
      demand.get(itemId).push({ qty, date: date || today, source, ref });
    };
    const unmatched = [];

    // ── 3. Independent demand ────────────────────────────────────────────────
    if (includeSalesOrders) {
      const { rows } = await client.query(`
        SELECT soi.item_code, soi.description,
               (COALESCE(soi.quantity,0) - COALESCE(soi.fulfilled_qty,0)) AS qty,
               COALESCE(so.delivery_date, so.order_date) AS need_date, so.order_number
          FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.order_id
         WHERE ${scope('so.company_id')} AND so.deleted_at IS NULL
           AND LOWER(COALESCE(so.order_status,'')) NOT IN ('cancelled','completed','delivered','closed')
           AND (COALESCE(soi.quantity,0) - COALESCE(soi.fulfilled_qty,0)) > 0`);
      for (const r of rows) {
        const nd = r.need_date ? new Date(r.need_date) : today;
        if (nd > horizonEnd) continue;
        const it = (r.item_code && byCode.get(String(r.item_code).toLowerCase())) ||
                   (r.description && byName.get(String(r.description).toLowerCase()));
        if (it) pushDemand(it.id, num(r.qty), nd, 'sales_order', r.order_number);
        else unmatched.push({ item: r.item_code || r.description, qty: num(r.qty), source: 'sales_order', ref: r.order_number });
      }
    }
    if (includeMPS) {
      const { rows } = await client.query(`
        SELECT product_id, product_name, due_date, (COALESCE(quantity,0) - COALESCE(quantity_produced,0)) AS qty
          FROM master_production_schedule
         WHERE ${scope()} AND status IN ('firm','planned','released')
           AND (COALESCE(quantity,0) - COALESCE(quantity_produced,0)) > 0`);
      for (const r of rows) {
        const nd = r.due_date ? new Date(r.due_date) : today;
        if (nd > horizonEnd) continue;
        if (r.product_id && items.has(r.product_id)) pushDemand(r.product_id, num(r.qty), nd, 'mps', r.product_name);
        else unmatched.push({ item: r.product_name, qty: num(r.qty), source: 'mps', ref: null });
      }
    }
    if (includeForecast) {
      const { rows } = await client.query(`
        SELECT item_id, product_name, forecast_date, (COALESCE(quantity,0) - COALESCE(consumed_qty,0)) AS qty
          FROM demand_forecasts WHERE ${scope()} AND (COALESCE(quantity,0) - COALESCE(consumed_qty,0)) > 0`);
      for (const r of rows) {
        const nd = r.forecast_date ? new Date(r.forecast_date) : today;
        if (nd > horizonEnd) continue;
        if (r.item_id && items.has(r.item_id)) pushDemand(r.item_id, num(r.qty), nd, 'forecast', r.product_name);
        else unmatched.push({ item: r.product_name, qty: num(r.qty), source: 'forecast', ref: null });
      }
    }

    // ── 4. Dated scheduled receipts (open supply) ────────────────────────────
    const receipts = new Map(); // item_id -> [{date, qty}]
    const addReceipt = (id, qty, date) => {
      if (!id || qty <= 0) return;
      if (!receipts.has(id)) receipts.set(id, []);
      receipts.get(id).push({ qty, date: date ? new Date(date) : today });
    };
    try {
      const { rows } = await client.query(`
        SELECT poi.item_id, (COALESCE(poi.quantity,0) - COALESCE(poi.received_qty,0)) AS qty,
               COALESCE(po.expected_delivery_date, po.order_date) AS due
          FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
         WHERE ${scope('po.company_id')} AND po.deleted_at IS NULL
           AND LOWER(COALESCE(po.status,'')) NOT IN ('cancelled','closed','received','rejected')
           AND (COALESCE(poi.quantity,0) - COALESCE(poi.received_qty,0)) > 0`);
      for (const r of rows) addReceipt(r.item_id, num(r.qty), r.due);
    } catch (e) { /* PO tables optional */ }
    try {
      const { rows } = await client.query(`
        SELECT product_id, (COALESCE(quantity_planned,0) - COALESCE(quantity_completed,0) - COALESCE(quantity_scrapped,0)) AS qty,
               COALESCE(planned_end_date, planned_start_date) AS due
          FROM production_orders
         WHERE ${scope()} AND status IN ('planned','released','in_progress','on_hold')
           AND (COALESCE(quantity_planned,0) - COALESCE(quantity_completed,0) - COALESCE(quantity_scrapped,0)) > 0`);
      for (const r of rows) addReceipt(r.product_id, num(r.qty), r.due);
    } catch (e) { /* ignore */ }

    // ── 5. Time-phased netting by ascending LLC ──────────────────────────────
    const plannedOrders = [];
    const exceptions = [];
    const tpRows = [];
    const orderedIds = [...items.keys()].sort((a, b) => (llc.get(a) ?? 0) - (llc.get(b) ?? 0));

    for (const id of orderedIds) {
      if (phantomItems.has(id)) continue;          // phantom: blown through, never planned
      const item = items.get(id);
      const dem = demand.get(id) || [];
      const sched = receipts.get(id) || [];
      if (dem.length === 0 && sched.length === 0) continue;

      // bucketize gross + scheduled
      const gross = new Array(nB).fill(0);
      const grossPeg = Array.from({ length: nB }, () => []);
      for (const d of dem) {
        const bi = bucketIndexOf(d.date); if (bi < 0) continue;
        gross[bi] += d.qty; grossPeg[bi].push(d);
      }
      const schedArr = new Array(nB).fill(0);
      for (const s of sched) { const bi = bucketIndexOf(s.date); if (bi >= 0) schedArr[bi] += s.qty; }
      if (gross.every(g => g <= 0)) continue; // only supply, no requirement → nothing to plan

      const lb = leadBuckets(item.lead_time_days);
      let prev = item.current_stock;
      let anyPlanned = false;
      for (let b = 0; b < nB; b++) {
        const available = prev + schedArr[b];
        let plannedReceipt = 0;
        const net = gross[b] + item.safety_stock - available;
        if (net > 0.0001) {
          plannedReceipt = applyLotSizing(item, net);
          anyPlanned = true;
          const needBucket = buckets[b];
          const needDate = needBucket.start;
          const startDate = addDays(needDate, -item.lead_time_days);
          const releaseBucketIdx = Math.max(0, b - lb);
          const make = isMake(item);

          const po = {
            item_id: id, item_code: item.item_code, item_name: item.item_name,
            order_type: make ? 'make' : 'buy', low_level_code: llc.get(id) ?? 0,
            quantity: plannedReceipt, uom: item.unit_of_measure,
            need_date: needDate, start_date: startDate, bucket_index: b, release_bucket: releaseBucketIdx,
            lead_time_days: item.lead_time_days, gross_requirement: gross[b], on_hand: prev,
            scheduled_receipts: schedArr[b], safety_stock: item.safety_stock, net_requirement: net,
            lot_rule: item.lot_sizing_rule, unit_cost: item.standard_cost, est_value: plannedReceipt * item.standard_cost,
            bom_id: bomByProduct.get(id) || null, preferred_vendor_id: item.preferred_vendor_id || null,
            pegging: grossPeg[b].slice(0, 12).map(d => ({ source: d.source, ref: d.ref, qty: d.qty, date: isoDate(d.date) })),
          };
          plannedOrders.push(po);

          // exceptions
          if (startDate < today) exceptions.push({ item, type: 'past_due_release', severity: 'critical', need_date: needDate,
            message: `Release for ${item.item_name} must start ${isoDate(startDate)} — past due. Expedite.` });
          else if (b < lb) exceptions.push({ item, type: 'expedite', severity: 'warning', need_date: needDate,
            message: `${item.item_name} needed in bucket ${b} but lead time is ${lb} bucket(s). Expedite.` });
          if (make && !bomByProduct.has(id)) exceptions.push({ item, type: 'no_bom', severity: 'critical', need_date: needDate,
            message: `${item.item_name} is a make item with no active BOM.` });
          if (!make && !item.preferred_vendor_id) exceptions.push({ item, type: 'no_vendor', severity: 'info', need_date: needDate,
            message: `${item.item_name} has no preferred vendor set.` });

          // explode make planned order → dependent demand at release date
          // (phantom children are blown through to real components inside explodeToChildren)
          if (make && childrenOf.has(id)) {
            for (const c of childrenOf.get(id))
              explodeToChildren(c.component_id, c.component_name, c.qtyPer * plannedReceipt, startDate, item.item_name);
          }
          // co-/by-product yield from this make order → dated supply for those items
          // (they carry a higher LLC, so they are planned after this primary)
          if (make && coproductsOf.has(id)) {
            for (const co of coproductsOf.get(id))
              if (items.has(co.item_id)) addReceipt(co.item_id, co.qtyPer * plannedReceipt, needDate);
          }
        }
        const pab = available + plannedReceipt - gross[b];
        prev = pab;
        if (gross[b] > 0 || schedArr[b] > 0 || plannedReceipt > 0) {
          tpRows.push({ item, bucket: buckets[b], gross: gross[b], sched: schedArr[b],
            planned: plannedReceipt, pab, net: Math.max(0, net), llc: llc.get(id) ?? 0 });
        }
      }
      void anyPlanned;
    }

    // ── 6. Persist ───────────────────────────────────────────────────────────
    const makeCount = plannedOrders.filter(p => p.order_type === 'make').length;
    const buyCount = plannedOrders.length - makeCount;
    const buyValue = plannedOrders.filter(p => p.order_type === 'buy').reduce((s, p) => s + p.est_value, 0);
    const runNo = `MRP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;

    const { rows: [run] } = await client.query(`
      INSERT INTO mrp_runs (company_id, run_no, run_type, horizon_days, bucket_days, status, params,
        item_count, planned_order_count, planned_make_count, planned_buy_count, exception_count,
        total_purchase_value, run_by, run_by_name, completed_at)
      VALUES ($1,$2,'regenerative',$3,$4,'completed',$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) RETURNING *`,
      [companyId ?? null, runNo, horizonDays, bucketDays,
       JSON.stringify({ includeSalesOrders, includeMPS, includeForecast, bucketDays, unmatched_count: unmatched.length }),
       items.size, plannedOrders.length, makeCount, buyCount, exceptions.length,
       Math.round(buyValue * 100) / 100, actor.id ?? null, actor.name ?? 'System']);

    for (const p of plannedOrders) {
      const { rows: [saved] } = await client.query(`
        INSERT INTO mrp_planned_orders (run_id, company_id, item_id, item_code, item_name, order_type,
          low_level_code, quantity, uom, need_date, start_date, lead_time_days, gross_requirement,
          on_hand, scheduled_receipts, safety_stock, net_requirement, lot_rule, unit_cost, est_value,
          bom_id, preferred_vendor_id, pegging)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
        [run.id, companyId ?? null, p.item_id, p.item_code, p.item_name, p.order_type, p.low_level_code,
         p.quantity, p.uom, isoDate(p.need_date), isoDate(p.start_date), p.lead_time_days, p.gross_requirement,
         p.on_hand, p.scheduled_receipts, p.safety_stock, p.net_requirement, p.lot_rule, p.unit_cost,
         Math.round(p.est_value * 100) / 100, p.bom_id, p.preferred_vendor_id, JSON.stringify(p.pegging)]);
      p.id = saved.id;
    }
    for (const ex of exceptions) {
      await client.query(`
        INSERT INTO mrp_exceptions (run_id, company_id, item_id, item_code, item_name, exception_type, severity, message, need_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [run.id, companyId ?? null, ex.item.id, ex.item.item_code, ex.item.item_name, ex.type, ex.severity, ex.message, isoDate(ex.need_date)]);
    }
    for (const r of tpRows) {
      await client.query(`
        INSERT INTO mrp_time_phased (run_id, company_id, item_id, item_code, item_name, low_level_code,
          bucket_index, bucket_start, bucket_end, gross_requirements, scheduled_receipts, planned_receipts,
          projected_available, net_requirements)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [run.id, companyId ?? null, r.item.id, r.item.item_code, r.item.item_name, r.llc,
         r.bucket.index, isoDate(r.bucket.start), isoDate(r.bucket.end),
         Math.round(r.gross * 1000) / 1000, Math.round(r.sched * 1000) / 1000, Math.round(r.planned * 1000) / 1000,
         Math.round(r.pab * 1000) / 1000, Math.round(r.net * 1000) / 1000]);
    }

    await client.query('COMMIT');
    return { run, plannedOrders, exceptions, unmatched,
      buckets: buckets.map(b => ({ index: b.index, start: isoDate(b.start), end: isoDate(b.end) })),
      timePhased: tpRows.map(r => ({ item_id: r.item.id, item_name: r.item.item_name, low_level_code: r.llc,
        bucket_index: r.bucket.index, gross_requirements: r.gross, scheduled_receipts: r.sched,
        planned_receipts: r.planned, projected_available: r.pab, net_requirements: Math.max(0, r.net) })) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Available-to-Promise (ATP) for one item, time-phased.
 * Discrete ATP per bucket = supply(bucket) - committed sales demand before the
 * next bucket that has supply. Cumulative ATP is the running sum (never negative
 * cumulatively — shortfalls are surfaced). Uses only firm supply + committed
 * customer orders (not forecast/MPS), per ATP convention.
 */
export async function computeATP({ companyId, itemId, horizonDays = 90, bucketDays = 7 }) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const horizonEnd = addDays(today, horizonDays);
  bucketDays = Math.max(1, Math.min(31, parseInt(bucketDays, 10) || 7));
  const scope = (col) => companyId != null ? `(${col} = ${Number(companyId)} OR ${col} IS NULL)` : 'TRUE';

  const { rows: [item] } = await pool.query(
    `SELECT id, item_code, item_name, unit_of_measure, COALESCE(current_stock,0) current_stock FROM inventory_items WHERE id = $1`, [itemId]);
  if (!item) return null;

  const buckets = [];
  for (let i = 0, t = today.getTime(); t < horizonEnd.getTime(); i++, t += bucketDays * DAY_MS)
    buckets.push({ index: i, start: new Date(t), end: new Date(Math.min(t + bucketDays * DAY_MS, horizonEnd.getTime())) });
  const nB = buckets.length;
  const biOf = (date) => { if (!date) return 0; const d = new Date(date); if (d < today) return 0; if (d >= horizonEnd) return -1;
    return Math.min(nB - 1, Math.floor((d.getTime() - today.getTime()) / (bucketDays * DAY_MS))); };

  const supply = new Array(nB).fill(0);
  const committed = new Array(nB).fill(0);

  // firm supply: open POs + open production orders (dated)
  try {
    const { rows } = await pool.query(`
      SELECT (COALESCE(poi.quantity,0)-COALESCE(poi.received_qty,0)) qty, COALESCE(po.expected_delivery_date,po.order_date) due
        FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.po_id
       WHERE poi.item_id=$1 AND ${scope('po.company_id')} AND po.deleted_at IS NULL
         AND LOWER(COALESCE(po.status,'')) NOT IN ('cancelled','closed','received','rejected')
         AND (COALESCE(poi.quantity,0)-COALESCE(poi.received_qty,0))>0`, [itemId]);
    for (const r of rows) { const b = biOf(r.due); if (b >= 0) supply[b] += num(r.qty); }
  } catch (e) { /* */ }
  try {
    const { rows } = await pool.query(`
      SELECT (COALESCE(quantity_planned,0)-COALESCE(quantity_completed,0)-COALESCE(quantity_scrapped,0)) qty,
             COALESCE(planned_end_date,planned_start_date) due
        FROM production_orders WHERE product_id=$1 AND ${scope('company_id')}
         AND status IN ('planned','released','in_progress','on_hold')`, [itemId]);
    for (const r of rows) { const b = biOf(r.due); if (b >= 0) supply[b] += num(r.qty); }
  } catch (e) { /* */ }

  // committed customer demand: open sales orders for this item (by code/name)
  try {
    const { rows } = await pool.query(`
      SELECT (COALESCE(soi.quantity,0)-COALESCE(soi.fulfilled_qty,0)) qty, COALESCE(so.delivery_date,so.order_date) due
        FROM sales_order_items soi JOIN sales_orders so ON so.id=soi.order_id
       WHERE ${scope('so.company_id')} AND so.deleted_at IS NULL
         AND LOWER(COALESCE(so.order_status,'')) NOT IN ('cancelled','completed','delivered','closed')
         AND (LOWER(soi.item_code)=LOWER($2) OR LOWER(soi.description)=LOWER($3))
         AND (COALESCE(soi.quantity,0)-COALESCE(soi.fulfilled_qty,0))>0`,
      [itemId, (item.item_code || '').toLowerCase(), (item.item_name || '').toLowerCase()]);
    for (const r of rows) { const b = biOf(r.due); if (b >= 0) committed[b] += num(r.qty); }
  } catch (e) { /* */ }

  // supply buckets = buckets with supply (on-hand belongs to bucket 0)
  supply[0] += item.current_stock;
  const supplyBuckets = [];
  for (let b = 0; b < nB; b++) if (supply[b] > 0) supplyBuckets.push(b);

  // discrete ATP: for each supply bucket, subtract committed until next supply bucket
  const atp = new Array(nB).fill(0);
  for (let k = 0; k < supplyBuckets.length; k++) {
    const from = supplyBuckets[k];
    const to = k + 1 < supplyBuckets.length ? supplyBuckets[k + 1] : nB;
    let demandInWindow = 0;
    for (let b = from; b < to; b++) demandInWindow += committed[b];
    atp[from] = supply[from] - demandInWindow;
  }
  // cumulative ATP (running available to promise)
  let cum = 0;
  const grid = buckets.map(b => {
    cum += atp[b.index];
    return { bucket_index: b.index, bucket_start: isoDate(b.start), bucket_end: isoDate(b.end),
      supply: Math.round(supply[b.index] * 1000) / 1000, committed: Math.round(committed[b.index] * 1000) / 1000,
      atp: Math.round(atp[b.index] * 1000) / 1000, cumulative_atp: Math.round(cum * 1000) / 1000 };
  });
  const totalATP = Math.round(cum * 1000) / 1000;
  return { item: { id: item.id, item_code: item.item_code, item_name: item.item_name, uom: item.unit_of_measure, on_hand: item.current_stock }, grid, total_atp: totalATP };
}
