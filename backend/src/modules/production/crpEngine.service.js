// backend/src/modules/production/crpEngine.service.js
//
// Capacity Requirements Planning (CRP) engine — the capacity half of MRP II.
//
// For each work centre, over a bucketed horizon:
//   available = capacity_hours_per_day * working_days_in_bucket * eff% * machines
//   required  = firm operation load (std_time_hrs * order qty)
//             + optional MRP planned make-order load (routing setup + std*qty)
//   load%     = required / available ; flag buckets where required > available.
//
// Load is placed in the bucket of the order's planned start date (firm) or the
// planned order's start date (MRP planned). This is start-anchored CRP; finer
// operation-level scheduling is a later refinement.
//
// NOTE: routing_steps.std_time_hrs (and the std_time_hrs copied onto
// production_operations) is PER-UNIT — it is multiplied by order quantity for
// both costing (execution.routes.js) and here.

import pool from '../../config/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
// Mon=0 … Sun=6
const workdayIndex = (d) => (d.getDay() + 6) % 7;

/** Count working days within [start, end) given days-per-week (5=Mon-Fri, 6=+Sat, 7=all). */
function workingDaysInBucket(start, end, daysPerWeek) {
  let n = 0;
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    if (workdayIndex(new Date(t)) < daysPerWeek) n++;
  }
  return n;
}

export async function runCRP({ companyId, horizonDays = 84, bucketDays = 7,
  includePlanned = true, actor = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const today = new Date(new Date().toISOString().slice(0, 10));
    const horizonEnd = addDays(today, horizonDays);
    const scope = (col = 'company_id') => companyId != null ? `(${col} = ${Number(companyId)} OR ${col} IS NULL)` : 'TRUE';

    // ── Buckets ──
    const buckets = [];
    for (let i = 0, t = today.getTime(); t < horizonEnd.getTime(); i++, t += bucketDays * DAY_MS) {
      const bStart = new Date(t);
      const bEnd = new Date(Math.min(t + bucketDays * DAY_MS, horizonEnd.getTime()));
      buckets.push({ index: i, start: bStart, end: bEnd });
    }
    const bucketOf = (date) => {
      if (!date) return buckets[0];
      const d = new Date(date);
      if (d < today) return buckets[0];               // overdue -> first bucket
      if (d >= horizonEnd) return null;               // beyond horizon -> ignore
      const i = Math.floor((d.getTime() - today.getTime()) / (bucketDays * DAY_MS));
      return buckets[i] || null;
    };

    // ── Work centres ──
    const { rows: wcRows } = await client.query(`
      SELECT id, name, COALESCE(capacity_hours_per_day,8) capacity_hours_per_day,
             COALESCE(efficiency_pct,100) efficiency_pct,
             COALESCE(working_days_per_week,5) working_days_per_week,
             COALESCE(num_machines,1) num_machines
        FROM work_centres WHERE ${scope()} AND COALESCE(status,'active') <> 'inactive'`);

    // load[wcId][bucketIndex] = { firm, planned, orders:Set, contributors:[] }
    const load = new Map();
    const cell = (wcId, bi) => {
      if (!load.has(wcId)) load.set(wcId, new Map());
      const m = load.get(wcId);
      if (!m.has(bi)) m.set(bi, { firm: 0, planned: 0, orders: new Set(), contributors: [] });
      return m.get(bi);
    };

    // ── Firm load: open production operations, qty-weighted by their order ──
    const { rows: ops } = await client.query(`
      SELECT op.id, op.operation, op.work_centre_id, op.std_time_hrs, op.status,
             po.id AS order_id, po.production_order_no,
             (COALESCE(po.quantity_planned,0) - COALESCE(po.quantity_completed,0)) AS remaining_qty,
             po.quantity_planned, po.planned_start_date, op.started_at
        FROM production_operations op
        JOIN production_orders po ON po.id = op.production_order_id
       WHERE ${scope('op.company_id')}
         AND op.status NOT IN ('completed','skipped')
         AND po.status NOT IN ('completed','cancelled')
         AND op.work_centre_id IS NOT NULL`);
    for (const o of ops) {
      const qty = Math.max(num(o.remaining_qty) > 0 ? num(o.remaining_qty) : num(o.quantity_planned), 0);
      const hrs = num(o.std_time_hrs) * qty;
      if (hrs <= 0) continue;
      const anchor = o.started_at || o.planned_start_date;
      const b = bucketOf(anchor);
      if (!b) continue;
      const c = cell(o.work_centre_id, b.index);
      c.firm += hrs;
      c.orders.add(o.order_id);
      if (c.contributors.length < 20)
        c.contributors.push({ type: 'firm', ref: o.production_order_no, op: o.operation, hours: Math.round(hrs * 100) / 100 });
    }

    // ── Planned load: latest MRP run's make planned-orders, via routing ──
    let mrpRunId = null;
    if (includePlanned) {
      const { rows: [lastMrp] } = await client.query(
        `SELECT id FROM mrp_runs WHERE ${scope()} ORDER BY created_at DESC LIMIT 1`);
      if (lastMrp) {
        mrpRunId = lastMrp.id;
        const { rows: planned } = await client.query(`
          SELECT po.id, po.item_name, po.quantity, po.start_date, po.bom_id
            FROM mrp_planned_orders po
           WHERE po.run_id = $1 AND po.order_type = 'make' AND po.status IN ('planned','firmed')
             AND po.bom_id IS NOT NULL`, [lastMrp.id]);
        for (const p of planned) {
          const b = bucketOf(p.start_date);
          if (!b) continue;
          const { rows: steps } = await client.query(
            `SELECT work_centre_id, COALESCE(std_time_hrs,0) std_time_hrs, COALESCE(setup_time_hrs,0) setup_time_hrs, operation
               FROM routing_steps WHERE bom_id = $1 AND work_centre_id IS NOT NULL`, [p.bom_id]);
          for (const s of steps) {
            const hrs = num(s.setup_time_hrs) + num(s.std_time_hrs) * num(p.quantity);
            if (hrs <= 0) continue;
            const c = cell(s.work_centre_id, b.index);
            c.planned += hrs;
            c.orders.add(`P${p.id}`);
            if (c.contributors.length < 20)
              c.contributors.push({ type: 'planned', ref: p.item_name, op: s.operation, hours: Math.round(hrs * 100) / 100 });
          }
        }
      }
    }

    // ── Assemble load grid + KPIs ──
    const rows = [];
    let overloaded = 0, peak = 0, totReq = 0, totAvail = 0;
    for (const wc of wcRows) {
      for (const b of buckets) {
        const wd = workingDaysInBucket(b.start, b.end, wc.working_days_per_week);
        const available = num(wc.capacity_hours_per_day) * wd * (num(wc.efficiency_pct) / 100) * (wc.num_machines || 1);
        const c = load.get(wc.id)?.get(b.index) || { firm: 0, planned: 0, orders: new Set(), contributors: [] };
        const required = c.firm + c.planned;
        const loadPct = available > 0 ? (required / available) * 100 : (required > 0 ? 999 : 0);
        const over = required > available + 1e-6 && required > 0;
        if (over) overloaded++;
        if (loadPct > peak) peak = loadPct;
        totReq += required; totAvail += available;
        rows.push({
          work_centre_id: wc.id, work_centre_name: wc.name, bucket_index: b.index,
          bucket_start: b.start, bucket_end: b.end,
          available_hours: Math.round(available * 100) / 100,
          firm_hours: Math.round(c.firm * 100) / 100,
          planned_hours: Math.round(c.planned * 100) / 100,
          required_hours: Math.round(required * 100) / 100,
          load_pct: Math.round(loadPct * 10) / 10,
          order_count: c.orders.size, is_overloaded: over, contributors: c.contributors,
        });
      }
    }

    // ── Persist ──
    const runNo = `CRP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const { rows: [run] } = await client.query(`
      INSERT INTO crp_runs (company_id, run_no, horizon_days, bucket_days, bucket_type, include_planned,
        mrp_run_id, work_centre_count, bucket_count, overloaded_count, peak_load_pct,
        total_required_hrs, total_available_hrs, params, run_by, run_by_name, completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW()) RETURNING *`,
      [companyId ?? null, runNo, horizonDays, bucketDays, bucketDays === 7 ? 'week' : (bucketDays === 1 ? 'day' : 'custom'),
       includePlanned, mrpRunId, wcRows.length, buckets.length, overloaded,
       Math.round(peak * 10) / 10, Math.round(totReq * 100) / 100, Math.round(totAvail * 100) / 100,
       JSON.stringify({ bucketDays, includePlanned }), actor.id ?? null, actor.name ?? 'System']);

    for (const r of rows) {
      await client.query(`
        INSERT INTO crp_load (run_id, company_id, work_centre_id, work_centre_name, bucket_index,
          bucket_start, bucket_end, available_hours, required_hours, firm_hours, planned_hours,
          load_pct, order_count, is_overloaded, contributors)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [run.id, companyId ?? null, r.work_centre_id, r.work_centre_name, r.bucket_index,
         isoDate(r.bucket_start), isoDate(r.bucket_end), r.available_hours, r.required_hours,
         r.firm_hours, r.planned_hours, r.load_pct, r.order_count, r.is_overloaded,
         JSON.stringify(r.contributors)]);
    }

    await client.query('COMMIT');
    return { run, load: rows, buckets: buckets.map(b => ({ index: b.index, start: isoDate(b.start), end: isoDate(b.end) })), workCentres: wcRows };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
