import { Router } from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { nextProdOrderNumber } from '../../shared/docNumber.js';
import { requirePermission, hasRole } from '../../middlewares/auth.middleware.js';
import { postStock } from './subcontracting.routes.js';
import prRepo from '../procurement/repositories/purchaseRequest.repository.js';
import { employeeOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { finiteSchedule, sequenceWorkCentre } from './productionScheduler.service.js';
import { reportProductionToMPS } from './mpsGeneration.service.js';

const router = Router();

const actor = (req) => ({
  id:   req.user?.userId || req.user?.id || null,
  name: req.user?.name   || req.user?.email || 'System',
});

/**
 * Audit finding 20 — "stock promised for a production order must not
 * accidentally be issued to another requirement".
 *
 * This is an ISSUE-time rule and it can only live here. A trigger on the
 * reservation tables cannot see WHICH requirement is drawing the stock, so the
 * first attempt at this (20260915000019-21) policed the promise instead and
 * refused any reservation larger than stock on hand — which forbade reserving
 * material before it arrives, the normal manufacturing case, and broke planning.
 *
 * The question that actually matters is asked at the moment of withdrawal:
 * after this issue, is enough left in the lot to honour what OTHER live
 * requirements are holding against this item? If not, the issue is taking
 * somebody else's stock, and it is refused with the orders that hold the claim
 * named — so the caller can go and get the promise released rather than guess.
 *
 * Quality-blocked lots are excluded from the supply side for the same reason
 * the issue path refuses them: stock nobody may issue cannot honour a promise.
 */
async function assertNotReservedElsewhere(client, { itemId, qty, reservationId, productionOrderId }) {
  const { rows: [supply] } = await client.query(`
    SELECT COALESCE(SUM(COALESCE(quantity_available,0)), 0) AS available
      FROM inventory_batches
     WHERE item_id = $1 AND deleted_at IS NULL
       AND LOWER(COALESCE(status,'available')) NOT IN ('rejected','quarantine','hold','blocked')`,
    [itemId]);

  const { rows: claims } = await client.query(`
    SELECT m.id, m.production_order_id, po.production_order_no,
           GREATEST(COALESCE(m.qty_reserved,0) - COALESCE(m.qty_issued,0), 0) AS outstanding
      FROM material_reservations m
      LEFT JOIN production_orders po ON po.id = m.production_order_id
     WHERE m.item_id = $1
       AND LOWER(COALESCE(m.status,'')) IN ('reserved','partially_issued')
       AND ($2::int IS NULL OR m.id <> $2)
       AND ($3::int IS NULL OR m.production_order_id IS DISTINCT FROM $3)
     ORDER BY m.id`, [itemId, reservationId ?? null, productionOrderId ?? null]);

  const othersHold = claims.reduce((t, c) => t + Number(c.outstanding || 0), 0);
  const available = Number(supply.available || 0);
  const remainingAfter = available - Number(qty || 0);

  if (othersHold > 0 && remainingAfter < othersHold) {
    const named = claims.filter(c => Number(c.outstanding) > 0)
      .map(c => c.production_order_no || `order ${c.production_order_id}`);
    return {
      blocked: true,
      available,
      othersHold,
      shortBy: Math.round((othersHold - remainingAfter) * 1000) / 1000,
      heldBy: named,
    };
  }
  return { blocked: false, available, othersHold };
}

/* ── Resolve the company an order should belong to ──
   Scoped users use their own company. A global super-admin (company_id = null)
   falls back to an explicit body company_id, else the sole/first company, so
   super-admin-created orders still adopt a real company and appear on the
   (company-filtered) Shop Floor. */
async function resolveCompanyId(client, scope, bodyCompanyId) {
  if (scope?.company_id != null) return scope.company_id;
  if (bodyCompanyId != null)     return bodyCompanyId;
  const { rows } = await client.query('SELECT id FROM companies ORDER BY id LIMIT 1');
  return rows[0]?.id ?? null;
}

/* ── Has this order got an open (non-closed) NCR against it, directly or via
   one of its operations? A QC stop-ship hold (holdProductionOrderOnQcFail in
   quality.routes.js) sets production_orders.status='on_hold' — every route
   that can clear on_hold must check this first, or it silently defeats the
   stop-ship the moment work resumes anywhere on the order. ── */
async function hasOpenNcr(client, orderId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::INT AS n FROM ncr_reports
     WHERE status NOT IN ('closed')
       AND ((reference_type='production_order' AND reference_id=$1)
         OR (reference_type='production_operation' AND reference_id IN
             (SELECT id FROM production_operations WHERE production_order_id=$1)))`,
    [orderId]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return (rows[0]?.n || 0) > 0;
}

async function logOpEvent(client, operationId, orderId, eventType, req, payload = {}) {
  const a = actor(req);
  await client.query(
    `INSERT INTO production_operation_logs
      (production_operation_id, production_order_id, event_type, quantity_delta, scrap_delta, remarks, actor_id, actor_name, event_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [operationId, orderId, eventType, payload.quantity_delta || 0, payload.scrap_delta || 0,
     payload.remarks || null, a.id, a.name, JSON.stringify(payload || {})]
  );
}

/* ── Overhead absorption rate: company-wide % of prime cost (material+labour+
   machine), stored in company_settings (module='production',
   settings.overhead_absorption_pct) — same table/pattern already used there
   for delay thresholds (see /dashboard) and allow_partial_issue (see
   /orders/:id/release). Defaults to 0 (no absorption) until a company sets it,
   so existing orders' totals don't jump on their own. ── */
async function getOverheadPct(client, companyId) {
  const { rows } = await client.query(
    `SELECT settings FROM company_settings WHERE company_id=$1 AND module='production' LIMIT 1`, [companyId]
  ).catch(() => ({ rows: [] }));
  const pct = Number(rows[0]?.settings?.overhead_absorption_pct);
  return Number.isFinite(pct) && pct >= 0 ? pct : 0;
}

/* ── Compute standard cost from BOM for a production order ──
   Labour mirrors machine cost exactly (std_time_hrs * a per-work-centre rate)
   using work_centres.labour_rate_per_hour alongside the existing cost_per_hour.
   Overhead is applied as a % of prime cost (material+labour+machine) — this
   used to only ever total material+machine; std_labor_cost/std_overhead_cost
   have existed on production_order_costs since 20260615000002 but nothing
   populated them. ── */
async function computeStdCost(client, bomId, quantity, companyId) {
  if (!bomId) return { material: 0, labour: 0, machine: 0, overhead: 0, total: 0 };

  const { rows: lines } = await client.query(
    `SELECT bl.qty, bl.unit_cost FROM bom_lines bl WHERE bl.bom_id = $1`, [bomId]
  );
  const material = lines.reduce((s, l) => s + parseFloat(l.qty || 0) * parseFloat(l.unit_cost || 0) * quantity, 0);

  const { rows: steps } = await client.query(
    `SELECT rs.std_time_hrs, COALESCE(wc.cost_per_hour, 0) AS cost_per_hour,
            COALESCE(wc.labour_rate_per_hour, 0) AS labour_rate_per_hour
     FROM routing_steps rs
     LEFT JOIN work_centres wc ON wc.id = rs.work_centre_id
     WHERE rs.bom_id = $1`, [bomId]
  );
  const machine = steps.reduce((s, r) => s + parseFloat(r.std_time_hrs || 0) * parseFloat(r.cost_per_hour || 0) * quantity, 0);
  const labour  = steps.reduce((s, r) => s + parseFloat(r.std_time_hrs || 0) * parseFloat(r.labour_rate_per_hour || 0) * quantity, 0);

  const overheadPct = await getOverheadPct(client, companyId);
  const overhead = (material + labour + machine) * overheadPct / 100;
  const total = material + labour + machine + overhead;

  return {
    material: parseFloat(material.toFixed(4)), labour: parseFloat(labour.toFixed(4)),
    machine: parseFloat(machine.toFixed(4)), overhead: parseFloat(overhead.toFixed(4)),
    total: parseFloat(total.toFixed(4)),
  };
}

/* ── Upsert production_order_costs ── */
async function upsertOrderCosts(client, orderId, companyId, bomId, quantity) {
  const c = await computeStdCost(client, bomId, quantity, companyId);
  await client.query(`
    INSERT INTO production_order_costs
      (production_order_id, company_id, std_material_cost, std_labor_cost, std_machine_cost, std_overhead_cost, std_total_cost,
       actual_material_cost, actual_labor_cost, actual_machine_cost, actual_overhead_cost, actual_total_cost, quantity_produced, last_computed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0,0,0,0,NOW())
    ON CONFLICT (production_order_id) DO UPDATE
      SET std_material_cost=$3, std_labor_cost=$4, std_machine_cost=$5, std_overhead_cost=$6, std_total_cost=$7,
          last_computed_at=NOW(), updated_at=NOW()
  `, [orderId, companyId, c.material, c.labour, c.machine, c.overhead, c.total]);
}

/* ── Recompute actual overhead + total + variances from current actual
   material/labour/machine cost. Overhead is a % of prime cost, so it's
   recomputed fresh from the current actuals each time one of the three
   changes, rather than incrementally accumulated — incremental += would
   compound overhead-on-overhead. Call after any actual_material_cost /
   actual_labor_cost / actual_machine_cost write. ── */
async function recomputeActualCosts(client, orderId, companyId, quantityProduced = null) {
  const pct = await getOverheadPct(client, companyId);
  const { rows: [c] } = await client.query(
    `SELECT actual_material_cost, actual_labor_cost, actual_machine_cost, quantity_produced
     FROM production_order_costs WHERE production_order_id=$1`, [orderId]
  );
  if (!c) return;
  const prime = parseFloat(c.actual_material_cost || 0) + parseFloat(c.actual_labor_cost || 0) + parseFloat(c.actual_machine_cost || 0);
  const overhead = prime * pct / 100;
  const total = prime + overhead;
  const qty = quantityProduced != null ? quantityProduced : parseFloat(c.quantity_produced || 0);
  await client.query(`
    UPDATE production_order_costs
    SET actual_overhead_cost=$1, actual_total_cost=$2,
        material_variance = actual_material_cost - std_material_cost,
        labor_variance    = actual_labor_cost - std_labor_cost,
        machine_variance  = actual_machine_cost - std_machine_cost,
        total_variance    = $2 - std_total_cost,
        cost_per_unit     = CASE WHEN $3 > 0 THEN $2 / $3 ELSE cost_per_unit END,
        quantity_produced = $3,
        updated_at = NOW()
    WHERE production_order_id=$4
  `, [overhead, total, qty, orderId]);
}

/* ── Auto-reserve BOM materials for a production order ── */
async function autoReserveMaterials(client, orderId, companyId, bomId, quantity, actorId, actorName) {
  if (!bomId) return;
  const { rows: lines } = await client.query(
    `SELECT bl.id, bl.component_id, bl.component_name, bl.qty, bl.unit
     FROM bom_lines bl WHERE bl.bom_id = $1`, [bomId]
  );
  for (const line of lines) {
    const required = parseFloat(line.qty || 0) * quantity;
    await client.query(`
      INSERT INTO material_reservations
        (company_id, production_order_id, item_id, item_name, unit, qty_required, qty_reserved, status,
         bom_line_id, reserved_at, reserved_by, reserved_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$6,'reserved',$7,NOW(),$8,$9)
      ON CONFLICT DO NOTHING
    `, [companyId, orderId, line.component_id, line.component_name, line.unit || 'pcs',
        required, line.id, actorId, actorName]);
  }
}

/* ── Backflush: consume reserved materials on operation complete ──
   actorId/actorName are the users.id/name shown in logs & audit trails.
   employeeId is separate: stock_ledger.created_by FKs employees(id), not
   users(id) (see postStock's stock_ledger insert) — passing actorId there
   FK-violates for any user whose id isn't coincidentally also a valid
   employees.id (e.g. every super_admin with employee_id NULL), silently
   aborting the transaction because postStock's caller wraps it in .catch(). */
async function backflushMaterials(client, orderId, companyId, operationId, actorId, actorName, employeeId) {
  const { rows: reservations } = await client.query(
    `SELECT * FROM material_reservations
     WHERE production_order_id = $1 AND company_id = $2 AND status IN ('reserved','partially_issued')`,
    [orderId, companyId]
  );
  for (const res of reservations) {
    const toConsume = parseFloat(res.qty_reserved) - parseFloat(res.qty_consumed);
    if (toConsume <= 0) continue;
    await client.query(`
      UPDATE material_reservations
      SET qty_consumed = qty_reserved, status='consumed', updated_at=NOW()
      WHERE id=$1`, [res.id]);
    await client.query(`
      INSERT INTO wip_transactions
        (company_id, production_order_id, operation_id, transaction_type, item_id, item_name, quantity, unit, reservation_id, actor_id, actor_name)
      VALUES ($1,$2,$3,'complete',$4,$5,$6,$7,$8,$9,$10)
    `, [companyId, orderId, operationId, res.item_id, res.item_name, toConsume, res.unit, res.id, actorId, actorName]);
    // Deduct from inventory — dual-written to stock_ledger (the ledger every
    // Inventory report/dashboard reads) and inventory_items.current_stock,
    // instead of only the raw column. Previously this only touched current_stock,
    // so production consumption was invisible to the ledger-driven Inventory
    // screens the moment any batch was backflushed.
    if (res.item_id) {
      await postStock(client, {
        itemId: res.item_id, outQty: toConsume, txnType: 'production_consumption',
        refType: 'production_order', refId: orderId,
        remarks: `Backflush consumption — order #${orderId}`,
        createdBy: employeeId ?? null, companyId,
      }).catch(() => {}); // non-fatal if inventory table differs
    }
  }
}

/* ── Record finished goods receipt into inventory ── */
async function receiveFG(client, order, actorId, actorName, employeeId) {
  // order.product_id is never actually populated by any live creation path --
  // the sales-order auto-bootstrap only resolves a bom_id (name-matched) and
  // product_name (free text), and the manual "Create Production Order" page
  // (ProductionOrders.jsx) has no product picker at all, only a free-text
  // product_name field. So this guard silently no-op'd FG receipt for every
  // production order in the system, regardless of how it was created. Falls
  // back to the same name-match convention already used for BOM matching
  // (autoBootstrapLifecycleOnOrderAccept) and component lookup (the GRN
  // shortage check above) rather than requiring a product_id nothing sets.
  let productId = order.product_id;
  if (!productId && order.product_name) {
    const { rows: [match] } = await client.query(
      `SELECT id FROM inventory_items
       WHERE item_name ILIKE $1 AND is_active = true
         AND ($2::int IS NULL OR company_id = $2)
       LIMIT 1`,
      [order.product_name, order.company_id || null]
    );
    productId = match?.id || null;
  }
  if (!productId) return;
  const fgQty = parseFloat(order.quantity_completed || order.quantity_planned);
  // Dual-written to stock_ledger + inventory_items.current_stock (see
  // backflushMaterials above) so finished-goods receipt is visible to the
  // same ledger-driven Inventory reports that raw-material consumption now is.
  await postStock(client, {
    itemId: productId, inQty: fgQty, txnType: 'production_receipt',
    refType: 'production_order', refId: order.id,
    remarks: `FG receipt — order #${order.id} (${order.product_name || ''})`,
    createdBy: employeeId ?? null, companyId: order.company_id,
  }).catch(() => {}); // non-fatal

  await client.query(`
    INSERT INTO wip_transactions
      (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, actor_id, actor_name, to_location)
    VALUES ($1,$2,'complete',$3,$4,$5,'pcs',$6,$7,'Finished Goods Store')
  `, [order.company_id, order.id, productId, order.product_name,
      fgQty, actorId, actorName]);

  // Update actual cost — labour + overhead included (see recomputeActualCosts).
  const qty = parseFloat(order.quantity_completed || order.quantity_planned) || 1;
  await recomputeActualCosts(client, order.id, order.company_id, qty);
}

/* ═══════════════════════════════════════════════════════════════════
   PRODUCTION ORDERS
═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════════════ */

router.get('/dashboard', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { from_date, to_date, status } = req.query;

    // ── Configurable delay thresholds (from company_settings, module='production') ──
    const { rows: setRows } = await pool.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'production' LIMIT 1`,
      [cid]
    ).catch(() => ({ rows: [] }));
    const cfg = setRows[0]?.settings || {};
    const criticalDays = Number(cfg.delay_critical_days) > 0 ? Number(cfg.delay_critical_days) : 7;
    const warningDays   = Number(cfg.delay_warning_days) >= 0 ? Number(cfg.delay_warning_days) : 3;

    // ── Shared production-order filter (company + optional date range + status) ──
    // A production order IS the production "batch" — one order tracks one build lot.
    const buildFilter = () => {
      const params = [cid];
      const f = ['po.company_id = $1'];
      if (from_date) { params.push(from_date); f.push(`COALESCE(po.planned_start_date, po.created_at::date) >= $${params.length}`); }
      if (to_date)   { params.push(to_date);   f.push(`COALESCE(po.planned_start_date, po.created_at::date) <= $${params.length}`); }
      if (status)    { params.push(status);    f.push(`po.status = $${params.length}`); }
      return { where: f.join(' AND '), params };
    };

    const isDelayedExpr = `po.status NOT IN ('completed','cancelled') AND po.planned_end_date IS NOT NULL AND po.planned_end_date < CURRENT_DATE`;
    const daysDelayedExpr = `CASE WHEN ${isDelayedExpr} THEN (CURRENT_DATE - po.planned_end_date) ELSE 0 END`;

    // KPI query — needs criticalDays appended
    const kpiF = buildFilter();
    kpiF.params.push(criticalDays);
    const cdIdx = kpiF.params.length;

    const [
      kpiRes, statusRes, delayedRes, moduleRes, dailyRes, ratingRes,
      capacityRes, linesRes, perfRes, qualRes, shortageRes, detailRes, recentRes,
    ] = await Promise.all([
      // ── 6 KPIs ──
      pool.query(`
        WITH base AS (
          SELECT po.status,
            (${isDelayedExpr}) AS is_delayed,
            ${daysDelayedExpr} AS days_delayed
          FROM production_orders po
          WHERE ${kpiF.where}
        )
        SELECT
          COUNT(*) FILTER (WHERE status != 'cancelled')                          AS total,
          COUNT(*) FILTER (WHERE status = 'in_progress')                         AS in_production,
          COUNT(*) FILTER (WHERE is_delayed)                                     AS delayed,
          COUNT(*) FILTER (WHERE is_delayed AND days_delayed > $${cdIdx})        AS critical,
          COUNT(*) FILTER (WHERE status = 'completed')                           AS completed,
          COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND NOT is_delayed) AS on_schedule
        FROM base
      `, kpiF.params),

      // ── Status distribution (donut) ──
      (() => { const f = buildFilter(); return pool.query(
        `SELECT po.status, COUNT(*) AS cnt FROM production_orders po WHERE ${f.where} GROUP BY po.status`,
        f.params); })(),

      // ── Delayed orders (alert banner + delay-analysis tab) ──
      (() => { const f = buildFilter(); return pool.query(`
        SELECT po.id, po.production_order_no, po.product_name, po.priority, po.status,
          po.planned_end_date, (CURRENT_DATE - po.planned_end_date) AS days_delayed
        FROM production_orders po
        WHERE ${f.where} AND ${isDelayedExpr}
        ORDER BY days_delayed DESC LIMIT 50`,
        f.params); })(),

      // ── Module / product-type output (bar) ──
      (() => { const f = buildFilter(); return pool.query(`
        SELECT COALESCE(NULLIF(po.product_name, ''), 'Unspecified') AS product_name,
          COUNT(*) AS orders,
          COALESCE(SUM(po.quantity_planned), 0)   AS qty_planned,
          COALESCE(SUM(po.quantity_completed), 0) AS qty_completed
        FROM production_orders po
        WHERE ${f.where}
        GROUP BY 1 ORDER BY orders DESC, qty_planned DESC LIMIT 12`,
        f.params); })(),

      // ── Daily production output (line) — genuine throughput from completion events ──
      pool.query(`
        SELECT to_char(DATE(l.created_at), 'YYYY-MM-DD') AS day,
          COALESCE(SUM(l.quantity_delta), 0)                    AS units,
          COUNT(*) FILTER (WHERE l.event_type = 'complete')     AS operations
        FROM production_operation_logs l
        JOIN production_orders po ON po.id = l.production_order_id
        WHERE po.company_id = $1 AND l.event_type = 'complete'
          AND l.created_at >= COALESCE($2::date, CURRENT_DATE - INTERVAL '29 days')
          AND l.created_at <  COALESCE($3::date, CURRENT_DATE) + INTERVAL '1 day'
        GROUP BY 1 ORDER BY 1`,
        [cid, from_date || null, to_date || null]),

      // ── Quality rating distribution (donut) — derived from real test pass-rates per order ──
      pool.query(`
        WITH per_order AS (
          SELECT qt.production_order_id,
            COUNT(*) FILTER (WHERE qt.result IN ('pass','fail')) AS tested,
            COUNT(*) FILTER (WHERE qt.result = 'pass')           AS passed
          FROM quality_tests qt
          JOIN production_orders po ON po.id = qt.production_order_id
          WHERE po.company_id = $1 AND qt.production_order_id IS NOT NULL
          GROUP BY qt.production_order_id
          HAVING COUNT(*) FILTER (WHERE qt.result IN ('pass','fail')) > 0
        )
        SELECT
          COUNT(*) FILTER (WHERE passed::float / tested = 1)                                  AS excellent,
          COUNT(*) FILTER (WHERE passed::float / tested >= 0.9  AND passed::float / tested < 1)    AS good,
          COUNT(*) FILTER (WHERE passed::float / tested >= 0.75 AND passed::float / tested < 0.9)  AS fair,
          COUNT(*) FILTER (WHERE passed::float / tested >= 0.5  AND passed::float / tested < 0.75) AS poor,
          COUNT(*) FILTER (WHERE passed::float / tested < 0.5)                                AS critical
        FROM per_order`,
        [cid]),

      // ── Resource / work-centre capacity utilization (horizontal bars) ──
      pool.query(`
        SELECT w.id, w.name,
          w.capacity_hours_per_day * 5 AS week_capacity,
          COALESCE(SUM(rs.std_time_hrs), 0) AS week_load
        FROM work_centres w
        LEFT JOIN routing_steps rs ON rs.work_centre_id = w.id
        LEFT JOIN bom_headers bh ON bh.id = rs.bom_id AND bh.status = 'active'
        WHERE (w.company_id = $1 OR w.company_id IS NULL) AND w.status = 'active'
        GROUP BY w.id, w.name, w.capacity_hours_per_day`,
        [cid]),

      // ── Production lines tab: live load per work centre ──
      pool.query(`
        SELECT w.id, w.name,
          (SELECT COUNT(*) FROM production_operations op WHERE op.work_centre_id = w.id AND op.status = 'in_progress')        AS active_ops,
          (SELECT COUNT(*) FROM production_operations op WHERE op.work_centre_id = w.id AND op.status IN ('pending','ready'))  AS queued_ops,
          (SELECT COUNT(*) FROM production_operations op WHERE op.work_centre_id = w.id AND op.status = 'completed')           AS done_ops
        FROM work_centres w
        WHERE (w.company_id = $1 OR w.company_id IS NULL) AND w.status = 'active'
        ORDER BY w.name`,
        [cid]),

      // ── Performance metrics (completed orders in range) ──
      (() => { const f = buildFilter(); return pool.query(`
        WITH comp AS (SELECT po.* FROM production_orders po WHERE ${f.where} AND po.status = 'completed')
        SELECT
          COUNT(*) AS completed_orders,
          COUNT(*) FILTER (WHERE actual_end_at IS NOT NULL AND planned_end_date IS NOT NULL AND actual_end_at::date <= planned_end_date) AS on_time,
          COALESCE(AVG(EXTRACT(EPOCH FROM (actual_end_at - actual_start_at)) / 3600)
            FILTER (WHERE actual_end_at IS NOT NULL AND actual_start_at IS NOT NULL), 0) AS avg_cycle_hrs,
          COALESCE(SUM(quantity_completed), 0) AS units_produced,
          COALESCE(SUM(quantity_scrapped), 0)  AS units_scrapped
        FROM comp`,
        f.params); })(),

      // ── Quality pass rate (all completed tests, company scope) ──
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE result IN ('pass','fail')) AS tested,
          COUNT(*) FILTER (WHERE result = 'pass')           AS passed
        FROM quality_tests WHERE company_id = $1`,
        [cid]),

      // ── Material shortage strip ──
      pool.query(`
        SELECT mr.item_name,
          SUM(mr.qty_required) AS qty_required,
          COALESCE(SUM(mr.qty_issued), 0) AS qty_issued
        FROM material_reservations mr
        JOIN production_orders po ON po.id = mr.production_order_id
        WHERE po.company_id = $1 AND mr.status IN ('reserved','partially_issued')
        GROUP BY mr.item_name
        ORDER BY (SUM(mr.qty_required) - COALESCE(SUM(mr.qty_issued), 0)) DESC
        LIMIT 10`,
        [cid]),

      // ── Detailed status list ──
      (() => { const f = buildFilter(); return pool.query(`
        SELECT po.id, po.production_order_no, po.product_name, po.status, po.priority,
          po.quantity_planned, po.quantity_completed, po.planned_start_date, po.planned_end_date,
          ${daysDelayedExpr} AS days_delayed,
          (SELECT COUNT(*) FROM production_operations op WHERE op.production_order_id = po.id) AS total_ops,
          (SELECT COUNT(*) FROM production_operations op WHERE op.production_order_id = po.id AND op.status = 'completed') AS done_ops
        FROM production_orders po
        WHERE ${f.where}
        ORDER BY po.created_at DESC LIMIT 200`,
        f.params); })(),

      // ── Recent orders (overview quick list) ──
      (() => { const f = buildFilter(); return pool.query(`
        SELECT po.id, po.production_order_no, po.product_name, po.status,
          po.quantity_planned, po.planned_end_date
        FROM production_orders po
        WHERE ${f.where}
        ORDER BY po.created_at DESC LIMIT 6`,
        f.params); })(),
    ]);

    const k = kpiRes.rows[0] || {};
    const total = parseInt(k.total) || 0;
    const completed = parseInt(k.completed) || 0;

    const capacity = capacityRes.rows.map(w => ({
      id: w.id, name: w.name,
      week_capacity: parseFloat(w.week_capacity) || 0,
      week_load: parseFloat(w.week_load) || 0,
      utilization_pct: parseFloat(w.week_capacity) > 0
        ? Math.min(100, Math.round((parseFloat(w.week_load) / parseFloat(w.week_capacity)) * 100))
        : 0,
    }));

    const r = ratingRes.rows[0] || {};
    const perf = perfRes.rows[0] || {};
    const q = qualRes.rows[0] || {};
    const perfCompleted = parseInt(perf.completed_orders) || 0;
    const perfProduced = parseFloat(perf.units_produced) || 0;
    const perfScrapped = parseFloat(perf.units_scrapped) || 0;
    const qTested = parseInt(q.tested) || 0;

    res.json({
      config: { critical_days: criticalDays, warning_days: warningDays },
      filters: { from_date: from_date || null, to_date: to_date || null, status: status || null },
      kpis: {
        total,
        in_production: parseInt(k.in_production) || 0,
        delayed:       parseInt(k.delayed) || 0,
        critical:      parseInt(k.critical) || 0,
        on_schedule:   parseInt(k.on_schedule) || 0,
        completed,
        completion_rate: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
      status_distribution: statusRes.rows.map(s => ({ status: s.status, count: parseInt(s.cnt) || 0 })),
      delayed_orders: delayedRes.rows.map(o => ({ ...o, days_delayed: parseInt(o.days_delayed) || 0 })),
      module_output: moduleRes.rows.map(m => ({
        product_name: m.product_name,
        orders: parseInt(m.orders) || 0,
        qty_planned: parseFloat(m.qty_planned) || 0,
        qty_completed: parseFloat(m.qty_completed) || 0,
      })),
      daily_output: dailyRes.rows.map(d => ({
        day: d.day, units: parseFloat(d.units) || 0, operations: parseInt(d.operations) || 0,
      })),
      rating_distribution: {
        excellent: parseInt(r.excellent) || 0,
        good:      parseInt(r.good) || 0,
        fair:      parseInt(r.fair) || 0,
        poor:      parseInt(r.poor) || 0,
        critical:  parseInt(r.critical) || 0,
      },
      capacity_utilization: capacity,
      production_lines: linesRes.rows.map(l => ({
        id: l.id, name: l.name,
        active_ops: parseInt(l.active_ops) || 0,
        queued_ops: parseInt(l.queued_ops) || 0,
        done_ops: parseInt(l.done_ops) || 0,
      })),
      performance: {
        completed_orders: perfCompleted,
        on_time: parseInt(perf.on_time) || 0,
        on_time_rate: perfCompleted > 0 ? Math.round(((parseInt(perf.on_time) || 0) / perfCompleted) * 100) : 0,
        avg_cycle_hrs: Math.round((parseFloat(perf.avg_cycle_hrs) || 0) * 10) / 10,
        units_produced: perfProduced,
        units_scrapped: perfScrapped,
        scrap_rate: (perfProduced + perfScrapped) > 0 ? Math.round((perfScrapped / (perfProduced + perfScrapped)) * 1000) / 10 : 0,
        yield_rate: (perfProduced + perfScrapped) > 0 ? Math.round((perfProduced / (perfProduced + perfScrapped)) * 1000) / 10 : 0,
        quality_pass_rate: qTested > 0 ? Math.round(((parseInt(q.passed) || 0) / qTested) * 1000) / 10 : null,
        quality_tested: qTested,
      },
      material_shortage: shortageRes.rows,
      detailed_status: detailRes.rows.map(o => ({ ...o, days_delayed: parseInt(o.days_delayed) || 0 })),
      recent_orders: recentRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   PRODUCTION ORDERS
═══════════════════════════════════════════════════════════════════ */

router.get('/orders/stats', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'planned')     AS planned,
        COUNT(*) FILTER (WHERE status = 'released')    AS released,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'on_hold')     AS on_hold,
        COUNT(*) FILTER (WHERE status = 'completed')   AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')   AS cancelled
      FROM production_orders WHERE company_id = $1
    `, [cid]);
    const r = rows[0] || {};
    res.json({
      total:       parseInt(r.total)       || 0,
      planned:     parseInt(r.planned)     || 0,
      released:    parseInt(r.released)    || 0,
      in_progress: parseInt(r.in_progress) || 0,
      on_hold:     parseInt(r.on_hold)     || 0,
      completed:   parseInt(r.completed)   || 0,
      cancelled:   parseInt(r.cancelled)   || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { status, search, project_id } = req.query;
    const params = [cid];
    let where = 'WHERE po.company_id = $1';
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        params.push(statuses[0]);
        where += ` AND po.status = $${params.length}`;
      } else if (statuses.length > 1) {
        params.push(statuses);
        where += ` AND po.status = ANY($${params.length}::text[])`;
      }
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (po.product_name ILIKE $${params.length} OR po.production_order_no ILIKE $${params.length} OR po.batch_number ILIKE $${params.length})`;
    }
    if (project_id) { params.push(project_id); where += ` AND po.project_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT po.*,
         (SELECT COUNT(*) FROM production_operations op WHERE op.production_order_id = po.id) AS total_operations,
         (SELECT COUNT(*) FROM production_operations op WHERE op.production_order_id = po.id AND op.status = 'completed') AS completed_operations,
         (SELECT COALESCE(SUM(op.std_time_hrs), 0) FROM production_operations op WHERE op.production_order_id = po.id) AS total_std_hrs,
         (SELECT wc.name FROM production_operations op2
          JOIN work_centres wc ON wc.id = op2.work_centre_id
          WHERE op2.production_order_id = po.id LIMIT 1) AS work_centre_name,
         poc.std_total_cost, poc.actual_total_cost, poc.cost_per_unit
       FROM production_orders po
       LEFT JOIN production_order_costs poc ON poc.production_order_id = po.id
       ${where}
       ORDER BY po.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/orders', requirePermission('production', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const {
      project_id, sales_order_id, bom_id, product_id, product_name,
      quantity_planned, priority = 'medium',
      planned_start_date, planned_end_date,
      notes, serial_number, batch_number, customer_ref, company_id,
    } = req.body;
    if (!product_name || !quantity_planned)
      return res.status(400).json({ error: 'product_name and quantity_planned are required' });

    await client.query('BEGIN');
    const cid = await resolveCompanyId(client, req.scope, company_id);
    // product_id references inventory_items (FK, migration 20261028000005); it
    // must also be this company's item — the FK cannot check that.
    if (product_id != null && product_id !== '') {
      const { rows: [it] } = await client.query(
        `SELECT id FROM inventory_items WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [product_id, cid]);
      if (!it) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: `Product ${product_id} is not an item of this company.`, code: 'PRODUCT_NOT_FOUND' });
      }
    }
    const no      = await nextProdOrderNumber(client);
    const creator = actor(req);

    const created = await client.query(
      `INSERT INTO production_orders
        (production_order_no, company_id, project_id, sales_order_id, bom_id, product_id, product_name,
         quantity_planned, priority, planned_start_date, planned_end_date, notes, created_by,
         serial_number, batch_number, customer_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [no, cid, project_id || null, sales_order_id || null, bom_id || null, product_id || null,
       product_name, quantity_planned, priority, planned_start_date || null, planned_end_date || null,
       notes || null, creator.id, serial_number || null, batch_number || null, customer_ref || null]
    );
    const order = created.rows[0];

    if (bom_id) {
      const steps = await client.query(
        `SELECT r.id, r.step_no, r.operation, r.work_centre_id, r.std_time_hrs, r.is_inspection,
                w.name AS work_centre_name
         FROM routing_steps r
         LEFT JOIN work_centres w ON w.id = r.work_centre_id
         WHERE r.bom_id = $1
         ORDER BY r.step_no, r.id`,
        [bom_id]
      );
      for (const s of steps.rows) {
        await client.query(
          // company_id from the parent order, in the statement — correct for every
          // caller and needs no extra parameter. A tenant-less operation row is
          // invisible to company-scoped shop-floor reads.
          `INSERT INTO production_operations
            (production_order_id, routing_step_id, step_no, operation, work_centre_id, work_centre_name, std_time_hrs, status, is_inspection, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,(SELECT company_id FROM production_orders WHERE id = $1))`,
          [order.id, s.id, s.step_no, s.operation, s.work_centre_id || null,
           s.work_centre_name || null, s.std_time_hrs || 0, s.is_inspection || false]
        );
      }
      // Compute standard cost
      await upsertOrderCosts(client, order.id, cid, bom_id, quantity_planned);
    }

    await client.query('COMMIT');
    logAudit({ userId: creator.id, module: 'production', recordId: order.id, recordType: 'production_order',
      action: 'create', newData: { production_order_no: order.production_order_no, product_name, quantity_planned, priority, bom_id: bom_id ?? null }, req });
    res.status(201).json(order);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── PATCH /orders/:id/plan — move new order to planned ── */
router.patch('/orders/:id/plan', requirePermission('production', 'edit'), captureBefore('production_orders'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    // A third unguarded way to clear an on_hold QC stop-ship — see hasOpenNcr's
    // comment. Its WHERE clause never excluded 'on_hold', so this could demote
    // a held order straight back to 'planned' with zero NCR check; worse,
    // /start's own guard only fires when the CURRENT status is 'on_hold', so
    // routing through here first ('on_hold' -> 'planned') let a second call to
    // /start bypass that gate entirely.
    const { rows: curRows } = await pool.query('SELECT status FROM production_orders WHERE id=$1', [req.params.id]);
    if (curRows[0]?.status === 'on_hold' && await hasOpenNcr(pool, req.params.id)) {
      return res.status(400).json({ error: 'Order is on hold with an open NCR — resolve/close it before re-planning' });
    }
    const { rows } = await pool.query(
      `UPDATE production_orders SET status = 'planned', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status NOT IN ('completed','cancelled','in_progress','released')
       RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found or cannot be planned in current state' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PATCH /orders/:id/start — directly start an order (in_progress) ── */
router.patch('/orders/:id/start', requirePermission('production', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);
    // This was a second, unguarded way to clear an on_hold QC stop-ship —
    // see hasOpenNcr's own comment. Only relevant when actually clearing a
    // hold; a 'planned'/'released' order with an unrelated open NCR elsewhere
    // shouldn't be blocked from starting.
    const { rows: curRows } = await pool.query('SELECT status FROM production_orders WHERE id=$1', [req.params.id]);
    if (curRows[0]?.status === 'on_hold' && await hasOpenNcr(pool, req.params.id)) {
      return res.status(400).json({ error: 'Order is on hold with an open NCR — resolve/close it before starting' });
    }
    const { rows } = await pool.query(
      `UPDATE production_orders
       SET status = 'in_progress',
           actual_start_at = COALESCE(actual_start_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND company_id = $2
         AND status IN ('planned','released','on_hold')
       RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found or not in a startable state' });
    logAudit({ userId: a.id, module: 'production', recordId: req.params.id,
      recordType: 'production_order', action: 'update',
      oldData: { status: 'planned' }, newData: { status: 'in_progress' }, req });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PATCH /orders/:id/complete — mark order completed + update inventory ── */
router.patch('/orders/:id/complete', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { produced_qty } = req.body;
    const a = actor(req);
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE production_orders
       SET status = 'completed',
           actual_end_at = COALESCE(actual_end_at, NOW()),
           quantity_completed = COALESCE($1::numeric, quantity_planned),
           updated_at = NOW()
       WHERE id = $2 AND company_id = $3
         AND status IN ('in_progress','released','planned')
       RETURNING *`,
      [produced_qty || null, req.params.id, cid]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found or cannot be completed' }); }
    const order = rows[0];
    const qty = parseFloat(produced_qty || order.quantity_planned);

    if (order.product_id) {
      // Dual-written to stock_ledger + inventory_items.current_stock (see
      // backflushMaterials/receiveFG above) — this order-level completion path
      // previously updated current_stock directly, bypassing the ledger.
      await postStock(client, {
        itemId: order.product_id, inQty: qty, txnType: 'production_receipt',
        refType: 'production_order', refId: order.id,
        remarks: `Order completion FG receipt — order #${order.id}`,
        createdBy: req.user?.employee_id ?? null, companyId: cid,
      }).catch(() => {});
    }
    await client.query(`
      INSERT INTO wip_transactions
        (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, actor_id, actor_name, to_location)
      VALUES ($1,$2,'complete',$3,$4,$5,'pcs',$6,$7,'Finished Goods Store')
    `, [cid, order.id, order.product_id, order.product_name, qty, a.id, a.name]).catch(() => {});

    // ── Report completion back to the master schedule ───────────────────────
    // master_production_schedule.quantity_produced was written ONLY by a manual
    // PUT, so "MPS vs actual production" compared a planned figure against a
    // hand-typed one and could never be true. Worse, somebody had typed it equal
    // to quantity on every row, which nets MPS demand to zero and is the direct
    // cause of fourteen MRP runs planning nothing.
    //
    // Completion now reports itself. An order linked to an MPS line updates that
    // line; an unlinked order falls back to the oldest open MPS line for the same
    // product, which is how a planner would attribute it by hand.
    try {
      let mpsId = order.mps_id;
      if (!mpsId && order.product_id) {
        const { rows: [open] } = await client.query(`
          SELECT id FROM master_production_schedule
           WHERE product_id = $1 AND ($2::int IS NULL OR company_id = $2)
             AND COALESCE(quantity,0) - COALESCE(quantity_produced,0) > 0
             AND LOWER(COALESCE(status,'')) NOT IN ('cancelled','closed')
           ORDER BY due_date NULLS LAST, id LIMIT 1`, [order.product_id, cid]);
        mpsId = open?.id ?? null;
      }
      if (mpsId) {
        await client.query(
          `UPDATE production_orders SET mps_id = $2 WHERE id = $1 AND mps_id IS NULL`, [order.id, mpsId]);
        // Recomputed from the linked orders rather than incremented. An
        // increment is right exactly once and wrong every time completion is
        // reported twice — and quantity_produced is the column whose drift
        // started this whole audit.
        await reportProductionToMPS({ productionOrderId: order.id, companyId: cid, client });
        await client.query(`
          UPDATE master_production_schedule
             SET status = CASE WHEN COALESCE(quantity_produced,0) >= COALESCE(quantity,0)
                               THEN 'closed' ELSE status END,
                 updated_at = NOW()
           WHERE id = $1`, [mpsId]);
      }
    } catch (e) { console.warn('[production/complete] MPS report-back skipped:', e.message); }

    // Co-/by-products: stock in the additional outputs of this BOM at completion.
    if (order.bom_id) {
      try {
        const { rows: outs } = await client.query(
          `SELECT item_id, item_name, uom, output_type, qty_per_parent FROM bom_outputs WHERE bom_id = $1`, [order.bom_id]);
        for (const o of outs) {
          const outQty = parseFloat(o.qty_per_parent || 0) * qty;
          if (outQty <= 0) continue;
          if (o.item_id) await postStock(client, {
            itemId: o.item_id, inQty: outQty, txnType: 'production_receipt',
            refType: 'production_order', refId: order.id,
            remarks: `Co/by-product receipt — order #${order.id}`,
            createdBy: req.user?.employee_id ?? null, companyId: cid,
          }).catch(() => {});
          await client.query(`
            INSERT INTO wip_transactions
              (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, actor_id, actor_name, to_location)
            VALUES ($1,$2,'complete',$3,$4,$5,$6,$7,$8,$9)`,
            [cid, order.id, o.item_id, `${o.item_name} (${o.output_type === 'by' ? 'by' : 'co'}-product)`, outQty, o.uom || 'pcs', a.id, a.name, 'Finished Goods Store']);
        }
      } catch (e) { /* bom_outputs optional pre-migration */ }
    }

    // Completion previously never reached back to the originating Sales Order —
    // dispatch had no signal production was actually done. Stamp the SO
    // (additive column, no existing order_status semantics touched) and notify
    // sales/dispatch so it isn't a silent handoff.
    if (order.sales_order_id) {
      const { rows: soRows } = await client.query(
        `UPDATE sales_orders SET production_completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING order_number, customer_name`,
        [order.sales_order_id]
      ).catch(() => ({ rows: [] }));
      const so = soRows[0];
      if (so) {
        const { rows: receivers } = await client.query(
          `SELECT id FROM users WHERE is_active = true
             AND LOWER(role) IN ('admin','super_admin','superadmin','manager','sales','sales_manager')`
        ).catch(() => ({ rows: [] }));
        for (const r of receivers) {
          await client.query(
            `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
             VALUES ($1,$2,$3,'sales',$4,'production_completed')`,
            [r.id, 'Production Completed — Ready to Dispatch',
             `Sales Order ${so.order_number}${so.customer_name ? ` (${so.customer_name})` : ''} — production order #${order.id} is complete.`,
             order.sales_order_id]
          ).catch(() => {});
        }
      }
    }

    await client.query('COMMIT');
    logAudit({ userId: a.id, module: 'production', recordId: req.params.id,
      recordType: 'production_order', action: 'update',
      oldData: { status: order.status }, newData: { status: 'completed', quantity_completed: qty }, req });
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── PATCH /orders/:id/issue-materials — issue all pending materials at once ── */
router.patch('/orders/:id/issue-materials', requirePermission('production', 'edit'), captureBefore('material_reservations'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);
    await client.query('BEGIN');

    const { rows: reservations } = await client.query(`
      SELECT * FROM material_reservations
      WHERE production_order_id = $1 AND company_id = $2
        AND status IN ('reserved','partially_issued')
    `, [req.params.id, cid]);

    for (const rsv of reservations) {
      const remaining = parseFloat(rsv.qty_required) - parseFloat(rsv.qty_issued || 0);
      if (remaining <= 0) continue;
      await client.query(
        `UPDATE material_reservations SET qty_issued = qty_required, status = 'fully_issued', updated_at = NOW() WHERE id = $1`,
        [rsv.id]
      );
      if (rsv.item_id) {
        // Dual-written to stock_ledger + inventory_items.current_stock (see
        // backflushMaterials above).
        await postStock(client, {
          itemId: rsv.item_id, outQty: remaining, txnType: 'production_issue',
          refType: 'production_order', refId: req.params.id,
          remarks: `Bulk material issue — order #${req.params.id}`,
          createdBy: req.user?.employee_id ?? null, companyId: cid,
        }).catch(() => {});
      }
      await client.query(`
        INSERT INTO wip_transactions
          (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, reservation_id, actor_id, actor_name, from_location, to_location)
        VALUES ($1,$2,'issue',$3,$4,$5,$6,$7,$8,$9,'Raw Materials Store','Shop Floor')
      `, [cid, req.params.id, rsv.item_id, rsv.item_name, remaining, rsv.unit, rsv.id, a.id, a.name]).catch(() => {});
    }

    await client.query('COMMIT');
    res.json({ success: true, issued_count: reservations.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// FIX: Lock edit when status is released/in_progress/completed unless supervisor
router.put('/orders/:id', requirePermission('production', 'edit'), captureBefore('production_orders'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;

    // Check current status — block edits on active/completed orders
    const { rows: [current] } = await pool.query(
      `SELECT status FROM production_orders WHERE id=$1 AND company_id=$2`, [req.params.id, cid]
    );
    if (!current) return res.status(404).json({ error: 'Production order not found' });
    if (['released', 'in_progress', 'completed'].includes(current.status)) {
      // Only super_admin can force-edit active orders (any role held, not just primary)
      if (!hasRole(req, 'super_admin'))
        return res.status(400).json({ error: `Cannot edit a ${current.status} production order. Contact administrator.` });
    }

    const {
      product_name, quantity_planned, priority,
      planned_start_date, planned_end_date, notes, bom_id,
      serial_number, batch_number, customer_ref,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE production_orders
       SET product_name=$1, quantity_planned=$2, priority=$3,
           planned_start_date=$4, planned_end_date=$5, notes=$6,
           bom_id=$7, serial_number=$8, batch_number=$9, customer_ref=$10,
           updated_at=NOW()
       WHERE id=$11 AND company_id=$12
       RETURNING *`,
      [product_name, quantity_planned, priority || 'medium',
       planned_start_date || null, planned_end_date || null, notes || null, bom_id || null,
       serial_number ?? null, batch_number ?? null, customer_ref ?? null, req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Production order not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FIXED: GRN gate + material reservation + std cost snapshot
router.post('/orders/:id/release', requirePermission('production', 'approve'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);

    // Fetch order
    const { rows: [order] } = await client.query(
      `SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`, [req.params.id, cid]
    );
    if (!order) return res.status(404).json({ error: 'Production order not found' });
    if (order.status !== 'planned')
      return res.status(400).json({ error: 'Only planned orders can be released' });

    // ── GRN Gate: check material availability ──────────────────────────────
    if (order.bom_id) {
      // Check allow_partial_issue setting
      // The canonical columns are module_name/settings_data (migration
      // 20260819000008); this read used module/settings, which never existed,
      // and the .catch() turned that into a silent false. Kept as a guarded
      // read because a missing settings row legitimately means "not configured".
      const { rows: [setting] } = await client.query(
        `SELECT settings_data FROM module_settings
          WHERE module_name='production' AND ($1::int IS NULL OR company_id=$1) LIMIT 1`,
        [cid]
      );
      const allowPartial = setting?.settings_data?.allow_partial_issue === true;

      if (!allowPartial) {
        const { rows: shortages } = await client.query(`
          SELECT
            bl.component_name AS item_name,
            bl.qty * $2 AS required_qty,
            COALESCE(
              (SELECT SUM(ii.current_stock) FROM inventory_items ii
               WHERE ii.id = bl.component_id OR ii.item_name ILIKE bl.component_name),
              0
            ) AS available_qty
          FROM bom_lines bl
          WHERE bl.bom_id = $1
            AND COALESCE(
              (SELECT SUM(ii.current_stock) FROM inventory_items ii
               WHERE ii.id = bl.component_id OR ii.item_name ILIKE bl.component_name),
              0
            ) < bl.qty * $2
        `, [order.bom_id, order.quantity_planned]);

        if (shortages.length > 0) {
          return res.status(400).json({
            error: 'Cannot release: insufficient material stock. Run MRP to generate purchase requests.',
            shortages: shortages.map(s => ({
              item: s.item_name,
              required: parseFloat(s.required_qty),
              available: parseFloat(s.available_qty),
              shortage: parseFloat(s.required_qty) - parseFloat(s.available_qty),
            })),
          });
        }
      }
    }

    await client.query('BEGIN');

    // Release order
    const { rows } = await client.query(
      `UPDATE production_orders
       SET status='released', released_by=$1, released_by_name=$2, updated_at=NOW()
       WHERE id=$3 AND company_id=$4
       RETURNING *`,
      [a.id, a.name, req.params.id, cid]
    );

    // Move operations to ready
    await client.query(
      `UPDATE production_operations SET status='ready', updated_at=NOW()
       WHERE production_order_id=$1 AND status='pending'`,
      [req.params.id]
    );

    // Auto-reserve materials
    await autoReserveMaterials(client, order.id, cid, order.bom_id, order.quantity_planned, a.id, a.name);

    // Compute and store standard cost
    if (order.bom_id) {
      await upsertOrderCosts(client, order.id, cid, order.bom_id, order.quantity_planned);
    }

    await client.query('COMMIT');
    logAudit({ userId: a.id, module: 'production', recordId: req.params.id, recordType: 'production_order',
      action: 'update', oldData: { status: 'planned' },
      newData: { status: 'released', released_by_name: a.name, production_order_no: rows[0].production_order_no }, req });
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// FIXED: Cancel production order endpoint
router.post('/orders/:id/cancel', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { reason } = req.body;
    const a = actor(req);

    const { rows: [order] } = await client.query(
      `SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`, [req.params.id, cid]
    );
    if (!order) return res.status(404).json({ error: 'Production order not found' });
    if (['completed', 'cancelled'].includes(order.status))
      return res.status(400).json({ error: `Cannot cancel a ${order.status} order` });

    await client.query('BEGIN');

    // Release material reservations
    await client.query(
      `UPDATE material_reservations SET status='cancelled', updated_at=NOW()
       WHERE production_order_id=$1 AND status IN ('pending','reserved','partially_issued')`,
      [req.params.id]
    );

    // Cancel all operations
    await client.query(
      `UPDATE production_operations SET status='skipped', updated_at=NOW()
       WHERE production_order_id=$1 AND status NOT IN ('completed','skipped')`,
      [req.params.id]
    );

    const { rows } = await client.query(
      `UPDATE production_orders
       SET status='cancelled', notes=COALESCE($1||' | '||COALESCE(notes,''), notes), updated_at=NOW()
       WHERE id=$2 AND company_id=$3
       RETURNING *`,
      [reason ? `Cancelled: ${reason}` : 'Cancelled', req.params.id, cid]
    );

    await client.query('COMMIT');
    logAudit({ userId: a.id, module: 'production', recordId: req.params.id, recordType: 'production_order',
      action: 'update', oldData: { status: order.status }, newData: { status: 'cancelled', reason }, req });
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// NEW: Order-level hold endpoint
router.post('/orders/:id/hold', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { reason } = req.body;
    const a = actor(req);

    const { rows: [order] } = await client.query(
      `SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`, [req.params.id, cid]
    );
    if (!order) return res.status(404).json({ error: 'Production order not found' });
    if (!['released', 'in_progress'].includes(order.status))
      return res.status(400).json({ error: 'Only released or in_progress orders can be put on hold' });

    await client.query('BEGIN');
    await client.query(
      `UPDATE production_operations SET status='on_hold', updated_at=NOW()
       WHERE production_order_id=$1 AND status IN ('ready','in_progress')`,
      [req.params.id]
    );
    const { rows } = await client.query(
      `UPDATE production_orders SET status='on_hold', notes=COALESCE($1||' | '||COALESCE(notes,''), notes), updated_at=NOW()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [reason ? `On Hold: ${reason}` : null, req.params.id, cid]
    );
    await client.query('COMMIT');
    logAudit({ userId: a.id, module: 'production', recordId: req.params.id, recordType: 'production_order',
      action: 'update', oldData: { status: order.status }, newData: { status: 'on_hold', reason }, req });
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// NEW: Resume order from hold
router.post('/orders/:id/resume', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);
    await client.query('BEGIN');
    // Second unguarded way to clear an on_hold QC stop-ship — see hasOpenNcr's comment.
    if (await hasOpenNcr(client, req.params.id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order is on hold with an open NCR — resolve/close it before resuming' });
    }
    await client.query(
      `UPDATE production_operations SET status='ready', updated_at=NOW()
       WHERE production_order_id=$1 AND status='on_hold'`,
      [req.params.id]
    );
    const { rows } = await client.query(
      `UPDATE production_orders SET status='released', updated_at=NOW()
       WHERE id=$1 AND status='on_hold' AND company_id=$2 RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Order is not on hold' }); }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/orders/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const [orderRes, opRes, logsRes, reservRes, costRes, scrapRes] = await Promise.all([
      pool.query(`SELECT po.*, poc.std_total_cost, poc.actual_total_cost, poc.cost_per_unit, poc.total_variance
                  FROM production_orders po
                  LEFT JOIN production_order_costs poc ON poc.production_order_id = po.id
                  WHERE po.id=$1 AND po.company_id=$2`, [req.params.id, cid]),
      pool.query(`SELECT * FROM production_operations WHERE production_order_id=$1 ORDER BY step_no,id`, [req.params.id]),
      pool.query(`SELECT * FROM production_operation_logs WHERE production_order_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.params.id]),
      pool.query(`SELECT * FROM material_reservations WHERE production_order_id=$1 ORDER BY id`, [req.params.id]),
      pool.query(`SELECT * FROM production_order_costs WHERE production_order_id=$1`, [req.params.id]),
      pool.query(`SELECT * FROM production_scrap WHERE production_order_id=$1 ORDER BY scrapped_at DESC`, [req.params.id]),
    ]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Production order not found' });
    res.json({
      ...orderRes.rows[0],
      operations:   opRes.rows,
      logs:         logsRes.rows,
      reservations: reservRes.rows,
      costs:        costRes.rows[0] || null,
      scrap:        scrapRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NEW: Reserve materials for a production order
router.post('/orders/:id/reserve-materials', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);
    const { rows: [order] } = await client.query(
      `SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`, [req.params.id, cid]
    );
    if (!order) return res.status(404).json({ error: 'Production order not found' });
    if (!order.bom_id) return res.status(400).json({ error: 'Production order has no BOM linked' });

    await client.query('BEGIN');
    // Clear existing reservations first.
    //
    // This deleted status='pending' — a status autoReserveMaterials never
    // writes; it writes 'reserved'. So the clear matched nothing and every
    // re-reservation ADDED a full set of lines on top of the last one. Three
    // calls on one order produced twelve reservations for a four-line BOM, and
    // each one holds stock that the availability check then treats as spoken
    // for. Nothing already issued or consumed is touched.
    await client.query(
      `DELETE FROM material_reservations
        WHERE production_order_id = $1
          AND LOWER(COALESCE(status,'')) IN ('pending','reserved')
          AND COALESCE(qty_issued,0) = 0
          AND COALESCE(qty_consumed,0) = 0`, [req.params.id]
    );
    await autoReserveMaterials(client, order.id, cid, order.bom_id, order.quantity_planned, a.id, a.name);
    await client.query('COMMIT');

    const { rows } = await pool.query(
      `SELECT * FROM material_reservations WHERE production_order_id=$1`, [req.params.id]
    );
    res.json({ success: true, reservations: rows });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// NEW: Issue material to shop floor
router.post('/orders/:id/issue-material', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { reservation_id, qty_issued, remarks } = req.body;
    const a = actor(req);
    if (!reservation_id || !qty_issued)
      return res.status(400).json({ error: 'reservation_id and qty_issued are required' });

    await client.query('BEGIN');
    const { rows: [res_row] } = await client.query(
      `SELECT * FROM material_reservations WHERE id=$1 AND production_order_id=$2 AND company_id=$3`,
      [reservation_id, req.params.id, cid]
    );
    if (!res_row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reservation not found' }); }

    const newIssued = parseFloat(res_row.qty_issued) + parseFloat(qty_issued);
    const newStatus = newIssued >= parseFloat(res_row.qty_required) ? 'fully_issued' : 'partially_issued';

    await client.query(
      `UPDATE material_reservations SET qty_issued=$1, status=$2, updated_at=NOW() WHERE id=$3`,
      [newIssued, newStatus, reservation_id]
    );

    // Get unit cost
    const { rows: [item] } = await client.query(
      `SELECT COALESCE(standard_cost, 0) AS unit_cost FROM inventory_items WHERE id=$1`, [res_row.item_id]
    ).catch(() => ({ rows: [{ unit_cost: 0 }] }));
    const unitCost = parseFloat(item?.unit_cost || 0);
    const totalCost = unitCost * qty_issued;

    // The project this order is building for, stamped onto every movement below.
    const { rows: [issueOrder] } = await client.query(
      `SELECT project_id FROM production_orders WHERE id = $1`, [req.params.id]);
    const issueOrderProjectId = issueOrder?.project_id ?? null;

    // ⚠ The ledger post used to happen HERE — before lot selection had run, for
    // the whole quantity, as a single row. Two consequences:
    //
    //   1. The lot could not possibly be on it. The batch is not chosen until
    //      forty lines below, so stock_ledger.batch_id was structurally
    //      unreachable on every production issue in the system.
    //   2. It was wrapped in `.catch(() => {})`. A failed ledger write was
    //      swallowed and the issue still committed and still answered 200 — the
    //      material left the store and the ledger never recorded it, silently.
    //
    // It now runs after lot selection, one row per lot, inside the transaction
    // with its errors propagating. See the loop below the issue log.

    // ── Lot selection: WHICH lot is leaving the store ───────────────────────
    // This is the link the whole traceability chain hangs from. Until
    // 20260911000010 there was no batch_id on the issue log, so the system
    // recorded that material left without recording which lot — and genealogy
    // had to guess by listing every batch of the item.
    //
    // An explicit batch_id is honoured; otherwise lots are drawn in FEFO order
    // where the item carries expiry dates and FIFO where it does not, which is
    // the correct default for both perishable and non-perishable stock. One
    // issue can legitimately span several lots, so each lot consumed is its own
    // log row — a single row averaging two lots would destroy the trace it
    // exists to record.
    const { batch_id, work_centre_id, operation_id, serial_id, serial_number,
            component_serial_id, component_serial_number,
            substitute_for_item_id, substitution_reason, deviation_reference } = req.body;

    // ── Substitution (finding 13) ───────────────────────────────────────────
    // A substitute fitted in place of the BOM part was previously
    // indistinguishable from the BOM part itself: nothing recorded that a swap
    // had happened, why, or who allowed it, so the as-built list quietly
    // asserted the original component. Recording the substitute WITHOUT the
    // approval would be the same failure one step removed — a deviation nobody
    // signed — so both are required together, and the database enforces it too.
    if (substitute_for_item_id) {
      if (!substitution_reason || !String(substitution_reason).trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'substitution_reason is required when fitting a substitute component',
          code: 'SUBSTITUTION_REASON_REQUIRED',
        });
      }
      const { rows: [orig] } = await client.query(
        `SELECT id FROM inventory_items WHERE id = $1 AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id = $2)`, [substitute_for_item_id, cid ?? null]);
      if (!orig) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'The item being substituted for was not found' });
      }
      if (String(substitute_for_item_id) === String(res_row.item_id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'An item cannot be a substitute for itself',
          code: 'SUBSTITUTION_SELF_REFERENCE',
        });
      }
    }
    let remainingToIssue = parseFloat(qty_issued);
    const lots = [];

    // ── Unit attribution: WHICH panel this material went into ───────────────
    // Optional, and left NULL when the caller does not say. An order that
    // builds one unit and an order that builds five are not the same problem:
    // without this, genealogy answered "which components are in panel 003?" by
    // listing everything issued to the order, giving every panel on the order
    // the same inflated as-built list. NULL here means "issued to the order,
    // not attributable to a unit", which is the truth for bulk material and is
    // reported as shared rather than silently folded into each panel.
    let attributedSerialId = null;
    if (serial_id || serial_number) {
      const { rows: [sn] } = await client.query(`
        SELECT id, serial_number, production_order_id FROM serial_numbers
         WHERE ($1::int IS NULL OR id = $1)
           AND ($2::text IS NULL OR serial_number = $2)
           AND deleted_at IS NULL
           AND ($3::int IS NULL OR company_id = $3 OR company_id IS NULL)
         LIMIT 1`, [serial_id || null, serial_number || null, cid]);
      if (!sn) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Serial ${serial_number || serial_id} not found` });
      }
      // A unit built by a different order cannot have consumed this issue.
      // Accepting it would write a genealogy that contradicts itself.
      if (String(sn.production_order_id) !== String(req.params.id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Serial ${sn.serial_number} belongs to a different production order`,
          code: 'SERIAL_ORDER_MISMATCH',
        });
      }
      attributedSerialId = sn.id;
    }

    // The specific serialised unit CONSUMED, where the component carries one.
    let componentSerialId = null;
    let componentSerialBatchId = null;
    if (component_serial_id || component_serial_number) {
      const { rows: [csn] } = await client.query(`
        SELECT id, serial_number, item_id, batch_id FROM serial_numbers
         WHERE ($1::int IS NULL OR id = $1)
           AND ($2::text IS NULL OR serial_number = $2)
           AND deleted_at IS NULL
           AND ($3::int IS NULL OR company_id = $3 OR company_id IS NULL)
         LIMIT 1`, [component_serial_id || null, component_serial_number || null, cid]);
      if (!csn) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Component serial ${component_serial_number || component_serial_id} not found` });
      }
      if (String(csn.item_id) !== String(res_row.item_id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Component serial ${csn.serial_number} is not a unit of the item being issued`,
          code: 'COMPONENT_SERIAL_ITEM_MISMATCH',
        });
      }

      // A physical unit is in one panel at a time. Nothing checked this: the
      // same component serial could be consumed into two panels, and both
      // as-built lists would claim it. uq_mil_component_serial_live now forbids
      // it at the database, which is the guarantee that actually holds; this
      // lookup exists so the floor gets a sentence naming the order that
      // already has the part, rather than a bare 23505.
      const { rows: [held] } = await client.query(`
        SELECT mil.production_order_id, po.production_order_no, sn.serial_number AS built_serial
          FROM material_issue_logs mil
          LEFT JOIN production_orders po ON po.id = mil.production_order_id
          LEFT JOIN serial_numbers    sn ON sn.id = mil.serial_id
         WHERE mil.component_serial_id = $1 AND mil.reversed_at IS NULL
         LIMIT 1`, [csn.id]);
      if (held) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Component serial ${csn.serial_number} is already installed in `
               + `${held.built_serial ? `panel ${held.built_serial}` : `order ${held.production_order_no || held.production_order_id}`}`
               + `. Record a rework removal before fitting it elsewhere.`,
          code: 'COMPONENT_SERIAL_ALREADY_INSTALLED',
          installed_in_production_order_id: held.production_order_id,
          installed_in_serial: held.built_serial || null,
        });
      }

      componentSerialId = csn.id;
      componentSerialBatchId = csn.batch_id;
    }

    if (batch_id) {
      const { rows: [b] } = await client.query(
        `SELECT id, batch_number, quantity_available, status FROM inventory_batches
          WHERE id = $1 AND item_id = $2 AND deleted_at IS NULL`, [batch_id, res_row.item_id]);
      if (!b) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Batch not found for this item' }); }
      lots.push(b);
    } else {
      const { rows } = await client.query(`
        SELECT id, batch_number, quantity_available, status, expiry_date
          FROM inventory_batches
         WHERE item_id = $1 AND deleted_at IS NULL
           AND COALESCE(quantity_available,0) > 0
           AND LOWER(COALESCE(status,'available')) NOT IN ('rejected','quarantine','hold','blocked')
         ORDER BY (expiry_date IS NULL), expiry_date ASC, received_date ASC, id ASC`,
        [res_row.item_id]);
      lots.push(...rows);
    }

    // Quality gate: a lot that failed inspection must not reach the shop floor.
    // Rejected and quarantined stock was previously issuable — the QC status was
    // recorded and then ignored at the point it mattered.
    const blocked = lots.find(b => ['rejected', 'quarantine', 'hold', 'blocked']
      .includes(String(b.status || '').toLowerCase()));
    if (blocked) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Lot ${blocked.batch_number || blocked.id} is ${blocked.status} and cannot be issued to production.`,
        code: 'QC_BLOCKED',
      });
    }

    // Somebody else's promised stock is not available to this order.
    const claim = await assertNotReservedElsewhere(client, {
      itemId: res_row.item_id,
      qty: parseFloat(qty_issued),
      reservationId: reservation_id,
      productionOrderId: req.params.id,
    });
    if (claim.blocked) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Issuing ${qty_issued} would leave ${Math.max(claim.available - parseFloat(qty_issued), 0)} `
             + `against ${claim.othersHold} already promised to ${claim.heldBy.join(', ')}. `
             + `Short by ${claim.shortBy}. Release or reduce that reservation first.`,
        code: 'RESERVED_FOR_ANOTHER_REQUIREMENT',
        available: claim.available,
        promised_elsewhere: claim.othersHold,
        held_by: claim.heldBy,
      });
    }

    const issuedLots = [];
    for (const b of lots) {
      if (remainingToIssue <= 0.000001) break;
      const take = Math.min(parseFloat(b.quantity_available || 0), remainingToIssue);
      if (take <= 0) continue;
      await client.query(`
        UPDATE inventory_batches
           SET quantity_available = COALESCE(quantity_available,0) - $2,
               quantity_consumed  = COALESCE(quantity_consumed,0)  + $2,
               updated_at = NOW()
         WHERE id = $1`, [b.id, take]);
      issuedLots.push({ batch_id: b.id, batch_number: b.batch_number, qty: take });
      remainingToIssue -= take;
    }

    // Whatever no lot could cover is still issued and still logged, with a NULL
    // batch_id that says plainly the lot is unknown. Refusing the issue would
    // block the shop floor over a stock-record gap; silently attributing it to
    // an arbitrary lot would corrupt the trace. Neither is acceptable.
    if (remainingToIssue > 0.000001) issuedLots.push({ batch_id: null, batch_number: null, qty: remainingToIssue });

    for (const lot of issuedLots) {
      // The panel applies to every lot row of this issue: all of it went into
      // that unit. A consumed component serial is one physical unit from one
      // lot, so it attaches only to the row for its own lot — stamping it on
      // each row of a multi-lot issue would claim the same unit was consumed
      // several times. When the issue resolves to a single lot the match is
      // unambiguous and the serial's own batch need not be recorded.
      const lotComponentSerialId =
        componentSerialId && (
          issuedLots.length === 1 ||
          componentSerialBatchId == null ||
          String(componentSerialBatchId) === String(lot.batch_id)
        ) ? componentSerialId : null;

      await client.query(`
        INSERT INTO material_issue_logs
          (company_id, production_order_id, reservation_id, item_id, item_name, batch_id,
           work_centre_id, operation_id, qty_issued, unit, unit_cost, total_cost,
           issued_by, issued_by_name, notes, serial_id, component_serial_id,
           substitute_for_item_id, substitution_reason, substitution_approved_by,
           substitution_approved_by_name, substitution_approved_at, deviation_reference)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18,$19,$20,$21,
                CASE WHEN $18::int IS NULL THEN NULL ELSE NOW() END, $22)
      `, [cid, req.params.id, reservation_id, res_row.item_id, res_row.item_name, lot.batch_id,
          work_centre_id ?? null, operation_id ?? null, lot.qty, res_row.unit, unitCost,
          unitCost * lot.qty, a.id, a.name,
          lot.batch_id ? (remarks || null) : `${remarks ? remarks + ' — ' : ''}lot not identified`,
          attributedSerialId, lotComponentSerialId,
          substitute_for_item_id ?? null,
          substitute_for_item_id ? String(substitution_reason).trim() : null,
          substitute_for_item_id ? a.id : null,
          substitute_for_item_id ? a.name : null,
          deviation_reference ?? null]);

      // The ledger row for this lot, carrying everything the issue log carries:
      // which lot left, which unit it was attributed to, which order consumed
      // it. One row per lot rather than one per issue, so a multi-lot issue
      // reconciles line-for-line against material_issue_logs instead of
      // presenting an average that matches neither lot.
      await postStock(client, {
        itemId: res_row.item_id,
        outQty: lot.qty,
        txnType: 'production_issue',
        refType: 'production_order',
        refId: req.params.id,
        rate: unitCost,
        remarks: remarks || `Material issue — order #${req.params.id}`,
        createdBy: req.user?.employee_id ?? null,
        companyId: cid,
        batchId: lot.batch_id,
        serialId: attributedSerialId,
        productionOrderId: req.params.id,
        // Finding 35: material issued for a project was attributable only by
        // walking back through its production order. The ledger column existed
        // and nothing wrote it, so project material cost could not be read from
        // movements at all. The order knows the project; the movement records it.
        projectId: issueOrderProjectId,
        reasonCode: 'production_issue',
      });
    }

    // WIP transaction
    await client.query(`
      INSERT INTO wip_transactions
        (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, unit_cost, total_cost, reservation_id, actor_id, actor_name, from_location, to_location)
      VALUES ($1,$2,'issue',$3,$4,$5,$6,$7,$8,$9,$10,$11,'Raw Materials Store','Shop Floor')
    `, [cid, req.params.id, res_row.item_id, res_row.item_name,
        qty_issued, res_row.unit, unitCost, totalCost, reservation_id, a.id, a.name]);

    // Update actual material cost — recompute overhead off the new total too
    // (overhead is a % of prime cost, so a material-only bump still moves it).
    await client.query(`
      INSERT INTO production_order_costs (production_order_id, company_id, actual_material_cost, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (production_order_id) DO UPDATE
        SET actual_material_cost = production_order_costs.actual_material_cost + $3, updated_at=NOW()
    `, [req.params.id, cid, totalCost]);
    await recomputeActualCosts(client, req.params.id, cid);

    await client.query('COMMIT');
    res.json({ success: true, qty_issued: newIssued, status: newStatus });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// NEW: Return unused issued material from shop floor back to stores.
// No path back into stock existed anywhere in the app for material issued to a
// production order but never consumed — this closes that gap using the same
// stock_ledger + inventory_items.current_stock dual-write as every other
// production stock movement (postStock, shared with subcontracting).
router.post('/orders/:id/return-material', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { reservation_id, qty_returned, remarks } = req.body;
    const a = actor(req);
    if (!reservation_id || !(qty_returned > 0))
      return res.status(400).json({ error: 'reservation_id and a positive qty_returned are required' });

    await client.query('BEGIN');
    const { rows: [rsv] } = await client.query(
      `SELECT * FROM material_reservations WHERE id=$1 AND production_order_id=$2 AND company_id=$3`,
      [reservation_id, req.params.id, cid]
    );
    if (!rsv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reservation not found' }); }
    if (!['partially_issued', 'fully_issued'].includes(rsv.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot return material for a reservation in "${rsv.status}" status` });
    }

    const returnable = Math.max(0, parseFloat(rsv.qty_issued) - parseFloat(rsv.qty_consumed || 0));
    if (qty_returned > returnable) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot return more than the unconsumed issued quantity (${returnable})` });
    }

    const newIssued = parseFloat(rsv.qty_issued) - qty_returned;
    const newStatus = newIssued <= 0 ? 'reserved'
      : newIssued < parseFloat(rsv.qty_required) ? 'partially_issued'
      : 'fully_issued';

    await client.query(
      `UPDATE material_reservations SET qty_issued=$1, status=$2, updated_at=NOW() WHERE id=$3`,
      [newIssued, newStatus, reservation_id]
    );

    // Unit cost — mirror issue-material's lookup so the cost booking reverses symmetrically.
    const { rows: [item] } = await client.query(
      `SELECT COALESCE(standard_cost, 0) AS unit_cost FROM inventory_items WHERE id=$1`, [rsv.item_id]
    ).catch(() => ({ rows: [{ unit_cost: 0 }] }));
    const unitCost = parseFloat(item?.unit_cost || 0);
    const totalCost = unitCost * qty_returned;

    if (rsv.item_id) {
      await postStock(client, {
        itemId: rsv.item_id, inQty: qty_returned, txnType: 'production_return',
        refType: 'production_order', refId: req.params.id, rate: unitCost,
        remarks: remarks || `Material return — order #${req.params.id}`,
        createdBy: req.user?.employee_id ?? null, companyId: cid,
      }).catch(() => {});
    }

    // Negative row on the issue log — nets out against the original issue so
    // genealogy's SUM(qty_issued) reflects material actually consumed, not returned.
    await client.query(`
      INSERT INTO material_issue_logs
        (company_id, production_order_id, reservation_id, item_id, item_name, qty_issued, unit, unit_cost, total_cost, issued_by, issued_by_name, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [cid, req.params.id, reservation_id, rsv.item_id, rsv.item_name,
        -qty_returned, rsv.unit, unitCost, -totalCost, a.id, a.name, remarks || 'Return to stores']);

    // 'reverse' is the wip_transactions transaction_type CHECK constraint's closest
    // fit — the constraint's allowed set (issue/transfer/complete/scrap/reverse) has
    // no dedicated 'return' value.
    await client.query(`
      INSERT INTO wip_transactions
        (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, unit_cost, total_cost, reservation_id, actor_id, actor_name, from_location, to_location)
      VALUES ($1,$2,'reverse',$3,$4,$5,$6,$7,$8,$9,$10,$11,'Shop Floor','Raw Materials Store')
    `, [cid, req.params.id, rsv.item_id, rsv.item_name, qty_returned, rsv.unit, unitCost, totalCost, reservation_id, a.id, a.name]);

    await client.query(`
      INSERT INTO production_order_costs (production_order_id, company_id, actual_material_cost, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (production_order_id) DO UPDATE
        SET actual_material_cost = production_order_costs.actual_material_cost - $3, updated_at=NOW()
    `, [req.params.id, cid, totalCost]);
    await recomputeActualCosts(client, req.params.id, cid);

    await client.query('COMMIT');
    logAudit({ userId: a.id, module: 'production', recordId: req.params.id, recordType: 'production_order',
      action: 'update', oldData: { qty_issued: rsv.qty_issued }, newData: { reservation_id, qty_returned, qty_issued: newIssued, status: newStatus }, req });
    res.json({ success: true, qty_issued: newIssued, status: newStatus });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   OPERATIONS
═══════════════════════════════════════════════════════════════════ */

router.post('/operations/:id/start', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { quantity_in = 0, remarks } = req.body;
    await client.query('BEGIN');

    // Check if previous operation is an inspection step that failed
    const op = await client.query(
      `SELECT po.*, prev.is_inspection, prev.status AS prev_status
       FROM production_operations po
       LEFT JOIN production_operations prev ON prev.production_order_id = po.production_order_id
         AND prev.step_no = po.step_no - 1
       WHERE po.id=$2
         AND po.production_order_id IN (SELECT id FROM production_orders WHERE company_id=$1)`,
      [cid, req.params.id]
    );
    if (!op.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Operation not found' }); }
    const opRow = op.rows[0];

    // Block start if previous step was inspection and NOT completed
    if (opRow.is_inspection && opRow.prev_status && !['completed','skipped'].includes(opRow.prev_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Previous inspection step must be completed before starting this operation' });
    }

    // A QC stop-ship hold (holdProductionOrderOnQcFail in quality.routes.js) put
    // the order on_hold, but starting ANY other operation on it used to
    // unconditionally flip on_hold -> in_progress with no check of why it was
    // held — silently clearing a stop-ship the moment work resumed anywhere on
    // the order. Block instead when an open (non-closed) NCR still exists.
    const { rows: orderRows } = await client.query(
      `SELECT status FROM production_orders WHERE id = $1`, [opRow.production_order_id]
    );
    if (orderRows[0]?.status === 'on_hold' && await hasOpenNcr(client, opRow.production_order_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order is on hold with an open NCR — resolve/close it before resuming operations' });
    }

    const updated = await client.query(
      `UPDATE production_operations
       SET status='in_progress',
           started_at=COALESCE(started_at, NOW()),
           quantity_in=CASE WHEN $1 > 0 THEN $1 ELSE quantity_in END,
           updated_at=NOW()
       WHERE id=$2
         AND production_order_id IN (SELECT id FROM production_orders WHERE company_id=$3)
       RETURNING *`,
      [quantity_in, req.params.id, cid]
    );
    const row = updated.rows[0];
    await client.query(
      `UPDATE production_orders
       SET status = CASE WHEN status IN ('released','planned','on_hold') THEN 'in_progress' ELSE status END,
           actual_start_at = COALESCE(actual_start_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [row.production_order_id]
    );

    // Real handoff to Quality: an inspection-flagged step previously had no
    // footprint in the Quality module at all — /operations/:id/complete only
    // ever checked the shop floor's own self-reported quantity_scrap, and
    // nothing dispatched into the quality_tests/checklist system GRN->IQC
    // already uses (quality_status rollup, QC worklist, auto-NCR-on-fail).
    // Create the checklist row here so QC actually has something to act on;
    // non-blocking, so it doesn't change existing shop-floor behavior.
    if (opRow.is_inspection) {
      const { rows: existingTest } = await client.query(
        `SELECT id FROM quality_tests WHERE operation_id=$1 LIMIT 1`, [row.id]
      );
      if (!existingTest.length) {
        const a = actor(req);
        await client.query(
          `INSERT INTO quality_tests
             (company_id, source_type, source_id, production_order_id, operation_id,
              stage, test_name, is_mandatory, created_by)
           VALUES ($1,'production_operation',$2,$3,$4,'IPQC',$5,true,$6)`,
          [cid, row.id, row.production_order_id, row.id, `In-process inspection — ${row.operation}`, a.id]
        ).catch(() => {});
      }
    }

    await logOpEvent(client, row.id, row.production_order_id, 'start', req, { quantity_delta: quantity_in, remarks: remarks || null });
    await client.query('COMMIT');
    res.json(row);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/operations/:id/complete', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { quantity_out = 0, quantity_scrap = 0, remarks, scrap_reason } = req.body;
    const a = actor(req);
    await client.query('BEGIN');

    // Same on_hold + open-NCR stop-ship guard /operations/:id/start already has
    // (see its comment) -- without it here, /complete was a second, unguarded
    // way to advance an operation on a QC-held order: it could mark an
    // operation 'completed' (bypassing /start's block entirely, including on
    // an operation never actually started) while the order itself stayed
    // on_hold with the NCR still open. hasOpenNcr's own downstream check below
    // still correctly kept material/FG movement blocked either way, but the
    // operation row itself shouldn't reach 'completed' while the hold stands.
    const { rows: preRows } = await client.query(
      `SELECT po.status AS order_status, o.production_order_id
       FROM production_operations o
       JOIN production_orders po ON po.id = o.production_order_id
       WHERE o.id=$1 AND po.company_id=$2`,
      [req.params.id, cid]
    );
    if (!preRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Operation not found' }); }
    if (preRows[0].order_status === 'on_hold' && await hasOpenNcr(client, preRows[0].production_order_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order is on hold with an open NCR — resolve/close it before completing operations' });
    }

    const opResult = await client.query(
      `UPDATE production_operations
       SET status='completed', completed_at=NOW(), quantity_out=$1, quantity_scrap=$2, updated_at=NOW()
       WHERE id=$3
         AND production_order_id IN (SELECT id FROM production_orders WHERE company_id=$4)
       RETURNING *`,
      [quantity_out, quantity_scrap, req.params.id, cid]
    );
    if (!opResult.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Operation not found' }); }
    const op = opResult.rows[0];

    await logOpEvent(client, op.id, op.production_order_id, 'complete', req, {
      quantity_delta: quantity_out, scrap_delta: quantity_scrap, remarks: remarks || null,
    });

    // Record scrap in production_scrap table
    if (quantity_scrap > 0) {
      const { rows: [order] } = await client.query(
        `SELECT * FROM production_orders WHERE id=$1`, [op.production_order_id]
      );
      await client.query(`
        INSERT INTO production_scrap
          (company_id, production_order_id, operation_id, product_name, quantity, reason, scrapped_by, scrapped_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [cid, op.production_order_id, op.id, order?.product_name || null,
          quantity_scrap, scrap_reason || remarks || null, a.id, a.name]);

      // Auto-create NCR if scrap on inspection step
      if (op.is_inspection && quantity_scrap > 0) {
        const ncrNo = `NCR-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
        await client.query(`
          INSERT INTO ncr_reports
            (company_id, title, description, ncr_number, detected_by, reference_type, reference_id, severity)
          VALUES ($1,$2,$3,$4,$5,'production_order',$6,'major')
        `, [cid,
            `Inspection Failure — ${order?.production_order_no || op.production_order_id}`,
            `Auto-raised: scrap quantity ${quantity_scrap} detected at inspection step "${op.operation}". Reason: ${scrap_reason || remarks || 'not specified'}`,
            ncrNo, a.id, op.production_order_id]);
        // A failed inspection used to only log an NCR — nothing stopped the
        // batch, and the order could still auto-complete and receive finished
        // goods below even when the very last step was the one that scrapped
        // material. Major/critical findings now actually hold the order; a
        // real stop-ship control instead of a record nobody has to act on.
        await client.query(
          `UPDATE production_orders SET status='on_hold', updated_at=NOW() WHERE id=$1`,
          [op.production_order_id]
        );
      }
    }

    // Update qty_completed / qty_scrapped on order
    await client.query(
      `UPDATE production_orders
       SET quantity_completed = COALESCE((
             SELECT MAX(quantity_out) FROM production_operations WHERE production_order_id=$1
           ),0),
           quantity_scrapped = COALESCE((
             SELECT SUM(quantity_scrap) FROM production_operations WHERE production_order_id=$1
           ),0),
           updated_at = NOW()
       WHERE id=$1`,
      [op.production_order_id]
    );

    // Compute actual machine cost for this operation, net of any on_hold time.
    // /operations/:id/hold logs a 'pause' event and /operations/:id/start logs
    // a 'start' event each time it's called (including re-starting after a
    // hold) without resetting started_at (it's COALESCE'd) — so raw wall-clock
    // from started_at to now previously counted idle hold time (e.g. a shift
    // change) as billable machine-hours. Net it out using the same log table
    // hold/resume already write to.
    let heldMs = 0;
    if (op.started_at) {
      const { rows: logRows } = await client.query(
        `SELECT event_type, created_at FROM production_operation_logs
         WHERE production_operation_id=$1 AND event_type IN ('pause','start')
         ORDER BY created_at ASC`,
        [op.id]
      );
      let pausedAt = null;
      for (const l of logRows) {
        if (l.event_type === 'pause') pausedAt = new Date(l.created_at).getTime();
        else if (l.event_type === 'start' && pausedAt) {
          heldMs += new Date(l.created_at).getTime() - pausedAt;
          pausedAt = null;
        }
      }
      if (pausedAt) heldMs += Date.now() - pausedAt;
    }
    const durationHrs = op.started_at
      ? Math.max(0, (Date.now() - new Date(op.started_at).getTime()) - heldMs) / 3600000
      : parseFloat(op.std_time_hrs || 0);
    const { rows: [wc] } = await client.query(
      `SELECT cost_per_hour, labour_rate_per_hour FROM work_centres WHERE id=$1`, [op.work_centre_id]
    ).catch(() => ({ rows: [null] }));
    const machineCost = durationHrs * parseFloat(wc?.cost_per_hour || 0);
    const labourCost  = durationHrs * parseFloat(wc?.labour_rate_per_hour || 0);
    if (machineCost > 0 || labourCost > 0) {
      await client.query(`
        INSERT INTO production_order_costs (production_order_id, company_id, actual_machine_cost, actual_labor_cost, updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (production_order_id) DO UPDATE
          SET actual_machine_cost = production_order_costs.actual_machine_cost + $3,
              actual_labor_cost   = production_order_costs.actual_labor_cost + $4,
              updated_at=NOW()
      `, [op.production_order_id, cid, machineCost, labourCost]);
      await recomputeActualCosts(client, op.production_order_id, cid);
    }

    // Check if all operations complete → close order. Gated on no open NCRs —
    // previously this fired purely on operation count, so an order could
    // auto-complete and receive finished goods even when its last inspection
    // step had just scrapped material and raised an NCR above.
    const pending = await client.query(
      `SELECT COUNT(*)::INT AS n FROM production_operations
       WHERE production_order_id=$1 AND status NOT IN ('completed','skipped')`,
      [op.production_order_id]
    );
    // Auto-NCRs from quality.routes.js's inspection/test-fail paths are raised
    // with reference_type='production_operation' (or 'grn'), not
    // 'production_order' — this gate used to only ever match the NCRs raised
    // directly above (scrap-at-inspection), so a quality-module NCR against
    // one of this order's operations never actually blocked completion.
    if ((pending.rows[0]?.n || 0) === 0 && !(await hasOpenNcr(client, op.production_order_id))) {
      // Backflush materials
      await backflushMaterials(client, op.production_order_id, cid, op.id, a.id, a.name, req.user?.employee_id ?? null);

      const { rows: [completedOrder] } = await client.query(
        `UPDATE production_orders
         SET status='completed', actual_end_at=NOW(), updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [op.production_order_id]
      );
      // Receive finished goods
      if (completedOrder) await receiveFG(client, completedOrder, a.id, a.name, req.user?.employee_id ?? null);
    }

    await client.query('COMMIT');
    res.json(op);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/operations/:id/hold', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { remarks } = req.body;
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE production_operations SET status='on_hold', notes=COALESCE($1, notes), updated_at=NOW()
       WHERE id=$2
         AND production_order_id IN (SELECT id FROM production_orders WHERE company_id=$3)
       RETURNING *`,
      [remarks || null, req.params.id, cid]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Operation not found' }); }
    const op = rows[0];
    await client.query(`UPDATE production_orders SET status='on_hold', updated_at=NOW() WHERE id=$1`, [op.production_order_id]);
    await logOpEvent(client, op.id, op.production_order_id, 'pause', req, { remarks: remarks || null });
    await client.query('COMMIT');
    res.json(op);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// FIXED: status check uses 'planned'/'cancelled' (not 'draft')
router.delete('/orders/:id', requirePermission('production', 'delete'), async (req, res) => {
  const client = await pool.connect();
  try {
    const cid = req.scope?.company_id;
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, status FROM production_orders WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (!['planned', 'cancelled'].includes(rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only planned or cancelled orders can be deleted' });
    }
    await client.query('DELETE FROM material_reservations WHERE production_order_id=$1', [req.params.id]);
    await client.query('DELETE FROM production_scrap WHERE production_order_id=$1', [req.params.id]);
    await client.query('DELETE FROM wip_transactions WHERE production_order_id=$1', [req.params.id]);
    await client.query('DELETE FROM production_order_costs WHERE production_order_id=$1', [req.params.id]);
    await client.query('DELETE FROM production_operations WHERE production_order_id=$1', [req.params.id]);
    await client.query('DELETE FROM production_orders WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// NEW: Record scrap
router.post('/orders/:id/scrap', requirePermission('production', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { quantity, reason, disposition = 'scrap', item_id, item_name } = req.body;
    const a = actor(req);
    const { rows: [order] } = await pool.query(
      `SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`, [req.params.id, cid]
    );
    if (!order) return res.status(404).json({ error: 'Production order not found' });
    const { rows } = await pool.query(`
      INSERT INTO production_scrap
        (company_id, production_order_id, product_name, item_id, item_name, quantity, reason, disposition, scrapped_by, scrapped_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [cid, req.params.id, order.product_name, item_id || null, item_name || order.product_name,
        quantity, reason, disposition, a.id, a.name]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shop floor: get my operations queue
router.get('/shop-floor', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { work_centre_id, status = 'ready,in_progress' } = req.query;
    const statuses = status.split(',').map(s => s.trim());
    const params = [cid];
    let where = 'AND po.company_id = $1';
    if (work_centre_id) { params.push(work_centre_id); where += ` AND op.work_centre_id = $${params.length}`; }
    params.push(statuses);
    const { rows } = await pool.query(`
      SELECT op.*,
             po.production_order_no, po.product_name, po.priority, po.planned_end_date,
             po.serial_number, po.batch_number, po.customer_ref,
             po.quantity_planned, po.status AS order_status
      FROM production_operations op
      JOIN production_orders po ON po.id = op.production_order_id
      WHERE op.status = ANY($${params.length}) ${where}
      ORDER BY
        CASE po.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        po.planned_end_date ASC NULLS LAST,
        op.step_no ASC
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WIP summary
router.get('/wip-summary', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(`
      SELECT po.id, po.production_order_no, po.product_name, po.priority, po.serial_number,
             po.quantity_planned, po.quantity_completed, po.quantity_scrapped,
             po.actual_start_at, po.planned_end_date,
             EXTRACT(EPOCH FROM (NOW() - po.actual_start_at))/3600 AS wip_hours,
             poc.std_total_cost, poc.actual_total_cost,
             COALESCE(poc.actual_total_cost, poc.std_total_cost, 0) AS wip_value,
             COUNT(op.id) FILTER (WHERE op.status='completed') AS ops_done,
             COUNT(op.id) AS ops_total
      FROM production_orders po
      LEFT JOIN production_order_costs poc ON poc.production_order_id = po.id
      LEFT JOIN production_operations op ON op.production_order_id = po.id
      WHERE po.company_id=$1 AND po.status='in_progress'
      GROUP BY po.id, poc.std_total_cost, poc.actual_total_cost
      ORDER BY po.priority DESC, po.planned_end_date ASC NULLS LAST
    `, [cid]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /work-centres/schedule ── */
router.get('/work-centres/schedule', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { from_date, to_date } = req.query;
    const startDate = from_date || new Date().toISOString().split('T')[0];
    const endDate   = to_date   || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const { rows: wcs } = await pool.query(`
      SELECT id, name, COALESCE(capacity_hours_per_day, 8) AS capacity_hours_per_day
      FROM work_centres
      WHERE (company_id = $1 OR company_id IS NULL) AND status = 'active'
      ORDER BY name
    `, [cid]);

    if (!wcs.length) return res.json([]);

    // Sum routing-step hours per work centre per order, within the date range
    const { rows: ops } = await pool.query(`
      SELECT op.work_centre_id,
             SUM(op.std_time_hrs) AS op_hrs,
             prod.planned_start_date::date AS start_date,
             prod.planned_end_date::date   AS end_date
      FROM production_operations op
      JOIN production_orders prod ON prod.id = op.production_order_id
      WHERE prod.company_id = $1
        AND prod.status IN ('planned','released','in_progress')
        AND op.work_centre_id IS NOT NULL
        AND prod.planned_start_date IS NOT NULL
        AND prod.planned_start_date::date <= $3::date
        AND (prod.planned_end_date IS NULL OR prod.planned_end_date::date >= $2::date)
      GROUP BY op.work_centre_id, prod.id, prod.planned_start_date, prod.planned_end_date
    `, [cid, startDate, endDate]);

    function bizDays(start, end) {
      const days = [];
      const d = new Date(start), e = new Date(end);
      while (d <= e) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) days.push(d.toISOString().split('T')[0]);
        d.setDate(d.getDate() + 1);
      }
      return days;
    }

    // Distribute op hours across business days that fall in the window
    const dayLoad = {};
    for (const op of ops) {
      const windowStart = op.start_date < startDate ? startDate : op.start_date;
      const windowEnd   = op.end_date && op.end_date < endDate ? op.end_date : endDate;
      const days = bizDays(windowStart, windowEnd);
      if (!days.length) continue;
      const hrsPerDay = parseFloat(op.op_hrs || 0) / days.length;
      for (const day of days) {
        const key = `${day}:${op.work_centre_id}`;
        dayLoad[key] = (dayLoad[key] || 0) + hrsPerDay;
      }
    }

    const allDays = bizDays(startDate, endDate);
    const result = [];
    for (const date of allDays) {
      for (const wc of wcs) {
        const planned  = dayLoad[`${date}:${wc.id}`] || 0;
        const capacity = parseFloat(wc.capacity_hours_per_day);
        result.push({
          date,
          work_centre_id:   wc.id,
          work_centre_name: wc.name,
          planned_hours:    parseFloat(planned.toFixed(2)),
          capacity_hours:   capacity,
          utilization_pct:  capacity > 0 ? Math.round((planned / capacity) * 100) : 0,
        });
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /mrp/requirements ── */
router.get('/mrp/requirements', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { from_date, to_date } = req.query;

    let whereClause = `WHERE po.company_id=$1 AND po.status IN ('planned','released','in_progress') AND po.bom_id IS NOT NULL`;
    const params = [cid];
    if (from_date) { params.push(from_date); whereClause += ` AND po.planned_start_date::date >= $${params.length}::date`; }
    if (to_date)   { params.push(to_date);   whereClause += ` AND (po.planned_start_date IS NULL OR po.planned_start_date::date <= $${params.length}::date)`; }

    const { rows: orders } = await pool.query(`SELECT * FROM production_orders po ${whereClause}`, params);
    if (!orders.length) {
      return res.json({ orders_count: 0, requirements: [], summary: { total_items: 0, shortage_items: 0, total_cost: 0 } });
    }

    // Aggregate BOM lines across all orders
    const agg = {};
    for (const order of orders) {
      const { rows: lines } = await pool.query(
        `SELECT component_name, qty, unit, COALESCE(unit_cost, 0) AS unit_cost FROM bom_lines WHERE bom_id=$1`,
        [order.bom_id]
      );
      for (const line of lines) {
        const required = parseFloat(line.qty) * parseFloat(order.quantity_planned);
        if (agg[line.component_name]) {
          agg[line.component_name].required_qty += required;
        } else {
          agg[line.component_name] = { item_name: line.component_name, unit: line.unit, unit_cost: parseFloat(line.unit_cost), required_qty: required };
        }
      }
    }

    // Compare with inventory stock
    const requirements = [];
    for (const item of Object.values(agg)) {
      let available = 0;
      try {
        const { rows: stock } = await pool.query(
          `SELECT COALESCE(SUM(current_stock), 0) AS qty FROM inventory_items WHERE item_name ILIKE $1 AND (company_id=$2 OR company_id IS NULL)`,
          [`%${item.item_name}%`, cid]
        );
        available = parseFloat(stock[0]?.qty || 0);
      } catch { available = 0; }
      const shortage = Math.max(0, item.required_qty - available);
      requirements.push({
        item_name:        item.item_name,
        unit:             item.unit,
        unit_cost:        item.unit_cost,
        required_qty:     parseFloat(item.required_qty.toFixed(2)),
        available_qty:    available,
        shortage_qty:     parseFloat(shortage.toFixed(2)),
        suggested_po_qty: shortage > 0 ? Math.ceil(shortage * 1.1) : 0,
      });
    }
    requirements.sort((a, b) => b.shortage_qty - a.shortage_qty);

    res.json({
      orders_count: orders.length,
      requirements,
      summary: {
        total_items:    requirements.length,
        shortage_items: requirements.filter(r => r.shortage_qty > 0).length,
        total_cost:     parseFloat(requirements.reduce((s, r) => s + r.required_qty * r.unit_cost, 0).toFixed(2)),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /mrp/requirements/generate-prs ── */
router.post('/mrp/requirements/generate-prs', requirePermission('production', 'add'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { requirements = [], from_date, to_date } = req.body;
    const a = actor(req);
    const shortages = requirements.filter(r => r.shortage_qty > 0);
    if (!shortages.length) return res.json({ created: 0, prs: [] });

    const prs = [];
    // Resolved once outside the loop — one DB round trip, not one per shortage.
    const requesterEmpId = await employeeOf(req, pool);
    for (const item of shortages) {
      try {
        // `a.id` is a users.id and requested_by_employee_id FKs employees(id):
        // this INSERT raised a foreign key violation for every account whose
        // users.id was not coincidentally a valid employees.id — 55 of the 62 in
        // this database — and the bare catch below swallowed it, so the action
        // reported success and raised nothing. employeeOf() returns the caller's
        // real employees.id, or NULL when they have no employee record.
        // It also minted no request_number, leaving the row blank in the register.
        const pr = await prRepo.createSystemRequest(pool, {
          company_id: cid,
          item_name: item.item_name,
          quantity: item.suggested_po_qty,
          unit: item.unit,
          estimated_cost: item.suggested_po_qty * item.unit_cost,
          requested_by_employee_id: requesterEmpId,
          notes: `MRP requirement: ${item.required_qty} ${item.unit} needed${from_date ? ` from ${from_date}` : ''}${to_date ? ` to ${to_date}` : ''}`,
        });
        prs.push({ pr_id: pr.id, item: item.item_name, qty: item.suggested_po_qty });
      } catch { /* non-fatal: skip item */ }
    }
    res.json({ created: prs.length, prs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── FREEZE THE BOM THIS ORDER IS BUILT AGAINST ─────────────────────────────
 *
 * Audit finding 12. production_orders stored only `bom_id`, a pointer to a
 * mutable row, so revising a BOM in place rewrote the apparent component list
 * of every panel ever built from it. Copying the lines at freeze time is what
 * makes the as-planned BOM immune to later edits — and gives the as-built list
 * something honest to be compared against.
 *
 * Idempotent by design: re-freezing REPLACES the snapshot rather than appending
 * to it. Appending would double every required quantity and make the variance
 * report show a 100% under-issue on every line.
 */
router.post('/orders/:id/freeze-bom', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);

    await client.query('BEGIN');
    const { rows: [order] } = await client.query(
      `SELECT id, bom_id, quantity_planned, bom_snapshot_at FROM production_orders
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [req.params.id, cid ?? null]);
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Production order not found' }); }

    const bomId = req.body?.bom_id ?? order.bom_id;
    if (!bomId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This order has no BOM. Pass bom_id, or set one on the order first.' });
    }

    const { rows: [bom] } = await client.query(
      `SELECT id, version, product_code, product_name FROM bom_headers
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`, [bomId, cid ?? null]);
    if (!bom) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'BOM not found' }); }

    const { rows: lines } = await client.query(`
      SELECT bl.id, bl.component_id, bl.component_name, bl.qty, bl.unit, bl.unit_cost, bl.level,
             ii.item_code
        FROM bom_lines bl
        LEFT JOIN inventory_items ii ON ii.id = bl.component_id
       WHERE bl.bom_id = $1
       ORDER BY bl.level NULLS FIRST, bl.id`, [bomId]);
    if (!lines.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That BOM has no component lines to freeze' });
    }

    // Replace, never append.
    await client.query('DELETE FROM production_order_bom_lines WHERE production_order_id = $1', [req.params.id]);

    const qtyPlanned = Number(order.quantity_planned) || 1;
    let lineNo = 0;
    for (const l of lines) {
      lineNo += 1;
      const perUnit = Number(l.qty) || 0;
      await client.query(`
        INSERT INTO production_order_bom_lines
          (company_id, production_order_id, bom_id, bom_version, line_no, component_id,
           component_code, component_name, qty_per_unit, qty_required, unit, unit_cost, level,
           snapshot_by, snapshot_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [cid, req.params.id, bomId, bom.version, lineNo, l.component_id,
         l.item_code, l.component_name, perUnit, perUnit * qtyPlanned,
         l.unit, l.unit_cost, l.level, a.id, a.name]);
    }

    await client.query(
      `UPDATE production_orders
          SET bom_id = $2, bom_version = $3, bom_snapshot_at = NOW(), bom_snapshot_by = $4, updated_at = NOW()
        WHERE id = $1`, [req.params.id, bomId, bom.version, a.id]);

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      production_order_id: Number(req.params.id),
      bom_id: bomId,
      bom_version: bom.version,
      lines_frozen: lineNo,
      refroze: Boolean(order.bom_snapshot_at),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── REWORK: remove a component from a built unit, optionally replace it ─────
 *
 * Audit finding 17. Until now nothing recorded a rework anywhere: genealogy
 * detected it by `notes ILIKE 'REWORK%'` and `qty_issued < 0`, neither of which
 * any code path ever wrote, so the Rework view was structurally always empty.
 *
 * THE RULE THIS ENDPOINT EXISTS TO KEEP: the original assembly history is never
 * overwritten. The original material_issue_logs row stays exactly as it is and
 * is STAMPED reversed_at — which simultaneously frees the removed serial to be
 * fitted elsewhere (uq_mil_component_serial_live is scoped to reversed_at IS
 * NULL) and preserves the record that it was once in this panel. Deleting or
 * editing that row would destroy precisely the genealogy this is for.
 *
 * Removal and replacement are separate: a panel legitimately sits with a part
 * removed and no replacement yet, and forcing both at once would push that
 * state into someone's notes.
 */
router.post('/orders/:id/rework', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);
    const {
      issue_log_id, serial_number, reason, defect_code, disposition,
      replacement_batch_id, replacement_component_serial_number, replacement_qty,
      notes,
    } = req.body || {};

    if (!issue_log_id) return res.status(400).json({ error: 'issue_log_id (the original installation) is required' });

    // The disposition column carries a CHECK constraint. Without this the route
    // accepts anything, the insert fails on the constraint, and the caller gets
    // a 500 naming "rework_disposition_chk" — a database identifier as an error
    // message, from which nobody can work out what the allowed values are.
    const REWORK_DISPOSITIONS = ['scrap', 'return_to_vendor', 'requarantine', 'reuse'];
    if (disposition != null && !REWORK_DISPOSITIONS.includes(String(disposition))) {
      return res.status(422).json({
        error: `disposition must be one of: ${REWORK_DISPOSITIONS.join(', ')}`,
        allowed: REWORK_DISPOSITIONS,
      });
    }
    if (!reason || !String(reason).trim()) {
      // A rework with no stated reason is an unexplained change to a built
      // panel. The whole point of the record is why.
      return res.status(400).json({ error: 'reason is required — a rework must say why the part came out' });
    }

    // ⚠ stock_ledger.created_by FKs employees(id), NOT users(id). actor().id is
    // a users.id, so passing it straight through violates the FK — the recurring
    // trap employeeOf() exists to prevent.
    const employeeId = await employeeOf(req, pool);

    await client.query('BEGIN');

    const { rows: [rwOrder] } = await client.query(
      `SELECT project_id FROM production_orders WHERE id = $1`, [req.params.id]);
    const reworkProjectId = rwOrder?.project_id ?? null;

    const { rows: [orig] } = await client.query(`
      SELECT mil.*, b.batch_number, cs.serial_number AS component_serial
        FROM material_issue_logs mil
        LEFT JOIN inventory_batches b ON b.id = mil.batch_id
        LEFT JOIN serial_numbers cs ON cs.id = mil.component_serial_id
       WHERE mil.id = $1 AND mil.production_order_id = $2
         AND ($3::int IS NULL OR mil.company_id = $3)`,
      [issue_log_id, req.params.id, cid ?? null]);
    if (!orig) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Installation record not found on this order' }); }
    if (orig.reversed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'That installation has already been reversed by an earlier rework',
        code: 'ALREADY_REVERSED',
      });
    }

    // Which unit was it in? Prefer the row's own attribution; fall back to an
    // explicitly named panel. Left NULL when neither says — the honest answer
    // for material that was issued to the order without naming a unit.
    let serialId = orig.serial_id ?? null;
    if (!serialId && serial_number) {
      const { rows: [sn] } = await client.query(
        `SELECT id FROM serial_numbers WHERE serial_number=$1 AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id=$2 OR company_id IS NULL) LIMIT 1`,
        [serial_number, cid ?? null]);
      if (!sn) { await client.query('ROLLBACK'); return res.status(404).json({ error: `Serial ${serial_number} not found` }); }
      serialId = sn.id;
    }

    // ── The removal. The original row is stamped, never altered otherwise. ──
    await client.query(
      `UPDATE material_issue_logs
          SET reversed_at = NOW(), reversed_by = $2, reversal_reason = $3
        WHERE id = $1`, [orig.id, a.id, String(reason).trim()]);

    // The assembly event is stamped too, for the same reason and in the same
    // way: the part is no longer IN the panel, but the record that it once was
    // has to survive — a recall must reach a panel that CONTAINED a defective
    // lot, not merely one that still does. Matched on the issue it came from,
    // or on the component serial where the installation named one.
    const { rows: removedInstalls } = await client.query(`
      UPDATE component_installations
         SET removed_at = NOW(), removed_by = $2, removal_reason = $3,
             status = 'removed', updated_at = NOW()
       WHERE removed_at IS NULL
         AND production_order_id = $4
         AND (issue_log_id = $1
              OR ($5::int IS NOT NULL AND component_serial_id = $5))
      RETURNING id`,
      [orig.id, a.id, String(reason).trim(), req.params.id, orig.component_serial_id ?? null]);

    // Removed material goes back to its lot only when it is fit to be reused.
    // Scrap, RTV and re-quarantine must NOT silently restore available stock —
    // that is how rejected material finds its way back onto the shop floor.
    if (disposition === 'reuse' && orig.batch_id) {
      await client.query(
        `UPDATE inventory_batches
            SET quantity_available = COALESCE(quantity_available,0) + $2,
                quantity_consumed  = GREATEST(COALESCE(quantity_consumed,0) - $2, 0),
                updated_at = NOW()
          WHERE id = $1`, [orig.batch_id, Number(orig.qty_issued) || 0]);
      await postStock(client, {
        itemId: orig.item_id, inQty: Number(orig.qty_issued) || 0,
        txnType: 'rework_return', refType: 'production_order', refId: req.params.id,
        rate: Number(orig.unit_cost) || 0, remarks: `Rework removal — ${reason}`,
        createdBy: employeeId, companyId: cid, batchId: orig.batch_id,
        serialId, productionOrderId: req.params.id, projectId: reworkProjectId,
        reasonCode: 'rework_removal',
      });
    }

    // ── The replacement, when one is fitted in the same action ──────────────
    let replacementLogId = null, replacementSerialId = null;
    if (replacement_batch_id || replacement_component_serial_number) {
      let replBatchId = replacement_batch_id ?? null;

      if (replacement_component_serial_number) {
        const { rows: [rs] } = await client.query(
          `SELECT id, item_id, batch_id FROM serial_numbers
            WHERE serial_number=$1 AND deleted_at IS NULL
              AND ($2::int IS NULL OR company_id=$2 OR company_id IS NULL) LIMIT 1`,
          [replacement_component_serial_number, cid ?? null]);
        if (!rs) { await client.query('ROLLBACK'); return res.status(404).json({ error: `Replacement serial ${replacement_component_serial_number} not found` }); }
        if (String(rs.item_id) !== String(orig.item_id)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `Replacement serial ${replacement_component_serial_number} is not a unit of the item being replaced`,
            code: 'REPLACEMENT_ITEM_MISMATCH',
          });
        }
        // The same live-installation rule as a first fit: a replacement part
        // cannot be one that is already inside another panel.
        const { rows: [held] } = await client.query(
          `SELECT production_order_id FROM material_issue_logs
            WHERE component_serial_id=$1 AND reversed_at IS NULL LIMIT 1`, [rs.id]);
        if (held) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `Replacement serial ${replacement_component_serial_number} is already installed in order ${held.production_order_id}`,
            code: 'COMPONENT_SERIAL_ALREADY_INSTALLED',
          });
        }
        replacementSerialId = rs.id;
        replBatchId = replBatchId ?? rs.batch_id ?? null;
      }

      const qty = Number(replacement_qty) > 0 ? Number(replacement_qty) : Number(orig.qty_issued) || 0;

      if (replBatchId) {
        const { rows: [rb] } = await client.query(
          `SELECT id, status, quantity_available FROM inventory_batches
            WHERE id=$1 AND item_id=$2 AND deleted_at IS NULL`, [replBatchId, orig.item_id]);
        if (!rb) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Replacement lot not found for this item' }); }
        if (['rejected','quarantine','hold','blocked'].includes(String(rb.status || '').toLowerCase())) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `Replacement lot is ${rb.status} and cannot be issued to production`, code: 'QC_BLOCKED',
          });
        }
        await client.query(
          `UPDATE inventory_batches
              SET quantity_available = COALESCE(quantity_available,0) - $2,
                  quantity_consumed  = COALESCE(quantity_consumed,0)  + $2,
                  updated_at = NOW()
            WHERE id = $1`, [replBatchId, qty]);
      }

      const { rows: [newLog] } = await client.query(`
        INSERT INTO material_issue_logs
          (company_id, production_order_id, reservation_id, item_id, item_name, batch_id,
           work_centre_id, operation_id, qty_issued, unit, unit_cost, total_cost,
           issued_by, issued_by_name, notes, serial_id, component_serial_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [cid, req.params.id, orig.reservation_id, orig.item_id, orig.item_name, replBatchId,
         orig.work_centre_id, orig.operation_id, qty, orig.unit, orig.unit_cost,
         (Number(orig.unit_cost) || 0) * qty, a.id, a.name,
         `REWORK replacement for issue #${orig.id} — ${reason}`, serialId, replacementSerialId]);
      replacementLogId = newLog.id;

      await postStock(client, {
        itemId: orig.item_id, outQty: qty, txnType: 'rework_issue',
        refType: 'production_order', refId: req.params.id,
        rate: Number(orig.unit_cost) || 0, remarks: `Rework replacement — ${reason}`,
        createdBy: employeeId, companyId: cid, batchId: replBatchId,
        serialId, productionOrderId: req.params.id, projectId: reworkProjectId,
        reasonCode: 'rework_replacement',
      });
    }

    const { rows: [rw] } = await client.query(`
      INSERT INTO rework_records
        (company_id, production_order_id, serial_id,
         removed_issue_log_id, removed_item_id, removed_batch_id, removed_component_serial_id,
         defect_code, reason, removed_by, removed_by_name, disposition,
         replacement_issue_log_id, replacement_item_id, replacement_batch_id,
         replacement_component_serial_id, replaced_by, replaced_by_name, replaced_at,
         retest_result, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
              CASE WHEN $13::int IS NULL THEN NULL ELSE NOW() END,
              CASE WHEN $13::int IS NULL THEN NULL ELSE 'pending' END,
              CASE WHEN $13::int IS NULL THEN 'removed' ELSE 'replaced' END, $19)
      RETURNING *`,
      [cid, req.params.id, serialId,
       orig.id, orig.item_id, orig.batch_id, orig.component_serial_id,
       defect_code ?? null, String(reason).trim(), a.id, a.name, disposition ?? null,
       replacementLogId, replacementLogId ? orig.item_id : null,
       replacementLogId ? (replacement_batch_id ?? null) : null,
       replacementSerialId, replacementLogId ? a.id : null, replacementLogId ? a.name : null,
       notes ?? null]);

    await client.query('COMMIT');
    res.status(201).json({ success: true, rework: rw, replacement_issue_log_id: replacementLogId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── Record the retest that proves a rework worked ───────────────────────── */
router.post('/rework/:reworkId/retest', requirePermission('production', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);
    const { result, reference, notes } = req.body || {};
    if (!['pass', 'fail', 'pending'].includes(String(result || ''))) {
      return res.status(400).json({ error: "result must be 'pass', 'fail' or 'pending'" });
    }
    const { rows: [rw] } = await pool.query(`
      UPDATE rework_records
         SET retest_result = $2, retested_by = $3, retested_by_name = $4,
             retested_at = NOW(), retest_reference = $5,
             notes = COALESCE($6, notes),
             -- A failed retest leaves the rework open: it is not closed until
             -- something passes. Marking it 'retested' either way would hide
             -- panels that are still broken.
             status = CASE WHEN $2 = 'pass' THEN 'closed' ELSE 'retested' END,
             updated_at = NOW()
       WHERE id = $1 AND ($7::int IS NULL OR company_id = $7)
       RETURNING *`,
      [req.params.reworkId, result, a.id, a.name, reference ?? null, notes ?? null, cid ?? null]);
    if (!rw) return res.status(404).json({ error: 'Rework record not found' });
    res.json({ success: true, rework: rw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /production/rework — the rework register.
 *
 * Rework could be RAISED and RETESTED but never listed: the records existed
 * only as rows reachable from one production order's genealogy. A quality
 * manager asking "what is in rework right now" had nowhere to look. */
router.get('/rework', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { status, production_order_id } = req.query;
    const vals = [cid];
    let where = `($1::int IS NULL OR rr.company_id = $1)`;
    if (status)              { vals.push(status);              where += ` AND LOWER(rr.status) = LOWER($${vals.length})`; }
    if (production_order_id) { vals.push(production_order_id); where += ` AND rr.production_order_id = $${vals.length}`; }

    const { rows } = await pool.query(`
      SELECT rr.*,
             p.production_order_no, p.product_name,
             ri.item_code  AS removed_item_code,  ri.item_name  AS removed_item_name,
             pi.item_code  AS replacement_item_code, pi.item_name AS replacement_item_name,
             sn.serial_number
        FROM rework_records rr
        LEFT JOIN production_orders p ON p.id = rr.production_order_id
        LEFT JOIN inventory_items  ri ON ri.id = rr.removed_item_id
        LEFT JOIN inventory_items  pi ON pi.id = rr.replacement_item_id
        LEFT JOIN serial_numbers   sn ON sn.id = rr.serial_id
       WHERE ${where}
       ORDER BY rr.removed_at DESC NULLS LAST, rr.id DESC
       LIMIT 500`, vals);

    const open = rows.filter(r => !['closed'].includes(String(r.status || '').toLowerCase()));
    res.json({
      rework: rows,
      summary: {
        total: rows.length,
        open: open.length,
        failed_retest: rows.filter(r => String(r.retest_result || '').toLowerCase() === 'fail').length,
        scrapped: rows.filter(r => String(r.disposition || '').toLowerCase() === 'scrap').length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// FINITE SCHEDULING
// ─────────────────────────────────────────────────────────────────────────────

/* POST /production/schedule/sequence — sequence every open operation onto its
 * work centre. See productionScheduler.service.js for what this does and,
 * more importantly, what it does not claim to do. */
/* ── ASSEMBLY: record a component being FITTED into a panel ──────────────────
 *
 * Audit finding 15 — the one requirement that was wholly absent, and the reason
 * findings 8, 9 and 14 were each capped at PARTIAL.
 *
 * The as-built list was reconstructed from `material_issue_logs`, which records
 * material LEAVING THE STORE for an order. That is a different event from a part
 * being fitted into a unit, and the difference is everything the requirement
 * asks for: the issue cannot say who assembled the panel, at which station, when,
 * against which BOM line, or under what work instruction.
 *
 * This writes the assembly event itself. It does not replace the issue log —
 * the two are linked by `issue_log_id` and kept apart on purpose, because
 * material issued but never installed is the normal signature of shrinkage or an
 * unrecorded rework, and collapsing them would define that gap out of existence.
 */
router.post('/orders/:id/install-component', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const a = actor(req);
    const {
      serial_number, panel_serial_id,
      item_id, component_serial_number, component_serial_id,
      batch_id, quantity, unit,
      issue_log_id, operation_id, work_centre_id, station_code,
      bom_line_id, work_instruction_ref, deviation_reference,
      started_at, completed_at, notes,
    } = req.body || {};

    const qty = Number(quantity);
    if (!(qty > 0)) return res.status(400).json({ error: 'A positive quantity is required' });

    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      `SELECT id, production_order_no, status, project_id FROM production_orders
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [req.params.id, cid ?? null]);
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Production order not found' }); }

    // ── Which panel ────────────────────────────────────────────────────────
    let serialId = panel_serial_id ?? null;
    if (!serialId && serial_number) {
      const { rows: [sn] } = await client.query(
        `SELECT id, serial_number, production_order_id FROM serial_numbers
          WHERE serial_number = $1 AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL) LIMIT 1`,
        [serial_number, cid ?? null]);
      if (!sn) { await client.query('ROLLBACK'); return res.status(404).json({ error: `Panel serial ${serial_number} not found` }); }
      // A unit built by a different order cannot be assembled on this one.
      // Accepting it would write a genealogy that contradicts itself.
      if (String(sn.production_order_id) !== String(req.params.id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Panel ${sn.serial_number} belongs to a different production order`,
          code: 'SERIAL_ORDER_MISMATCH',
        });
      }
      serialId = sn.id;
    }

    // ── Which component ────────────────────────────────────────────────────
    let itemId = item_id ?? null;
    let componentSerialId = component_serial_id ?? null;
    if (component_serial_number || componentSerialId) {
      const { rows: [cs] } = await client.query(
        `SELECT id, serial_number, item_id, batch_id FROM serial_numbers
          WHERE ($1::int IS NULL OR id = $1) AND ($2::text IS NULL OR serial_number = $2)
            AND deleted_at IS NULL
            AND ($3::int IS NULL OR company_id = $3 OR company_id IS NULL) LIMIT 1`,
        [componentSerialId, component_serial_number ?? null, cid ?? null]);
      if (!cs) { await client.query('ROLLBACK'); return res.status(404).json({ error: `Component serial ${component_serial_number || componentSerialId} not found` }); }
      if (itemId && String(itemId) !== String(cs.item_id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Component serial ${cs.serial_number} is not a unit of the item being installed`,
          code: 'COMPONENT_SERIAL_ITEM_MISMATCH',
        });
      }
      // One physical unit sits in one panel at a time. The unique index
      // enforces it; this lookup exists so the floor gets a sentence naming
      // where the part already is, instead of a bare 23505.
      const { rows: [held] } = await client.query(`
        SELECT ci.production_order_id, po.production_order_no, sn.serial_number AS panel
          FROM component_installations ci
          LEFT JOIN production_orders po ON po.id = ci.production_order_id
          LEFT JOIN serial_numbers    sn ON sn.id = ci.serial_id
         WHERE ci.component_serial_id = $1 AND ci.removed_at IS NULL LIMIT 1`, [cs.id]);
      if (held) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Component serial ${cs.serial_number} is already installed in `
               + `${held.panel ? `panel ${held.panel}` : `order ${held.production_order_no || held.production_order_id}`}`
               + `. Record a rework removal before fitting it elsewhere.`,
          code: 'COMPONENT_SERIAL_ALREADY_INSTALLED',
          installed_in_production_order_id: held.production_order_id,
          installed_in_serial: held.panel || null,
        });
      }
      componentSerialId = cs.id;
      itemId = itemId ?? cs.item_id;
    }
    if (!itemId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'item_id or a component serial is required' }); }

    // ── Which lot, and is it fit to fit ────────────────────────────────────
    let lotId = batch_id ?? null;
    if (lotId) {
      const { rows: [b] } = await client.query(
        `SELECT id, batch_number, status FROM inventory_batches
          WHERE id = $1 AND item_id = $2 AND deleted_at IS NULL`, [lotId, itemId]);
      if (!b) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lot not found for this item' }); }
      // The same quality gate the issue path applies. A lot that failed
      // inspection must not reach a panel by a different door.
      if (['rejected', 'quarantine', 'hold', 'blocked'].includes(String(b.status || '').toLowerCase())) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Lot ${b.batch_number || b.id} is ${b.status} and cannot be installed.`,
          code: 'QC_BLOCKED',
        });
      }
    }

    // ── The issue this material came from, if named ────────────────────────
    if (issue_log_id) {
      const { rows: [il] } = await client.query(
        `SELECT id, item_id, batch_id FROM material_issue_logs
          WHERE id = $1 AND production_order_id = $2`, [issue_log_id, req.params.id]);
      if (!il) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Issue record not found on this order' }); }
      if (String(il.item_id) !== String(itemId)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'That issue was for a different item', code: 'ISSUE_ITEM_MISMATCH',
        });
      }
      lotId = lotId ?? il.batch_id;
    }

    const { rows: [ci] } = await client.query(`
      INSERT INTO component_installations
        (company_id, production_order_id, serial_id, item_id, component_serial_id, batch_id,
         quantity, unit, issue_log_id, operation_id, work_centre_id, station_code,
         installed_by, installed_by_name, started_at, completed_at,
         bom_line_id, work_instruction_ref, deviation_reference, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *`,
      [cid, req.params.id, serialId, itemId, componentSerialId, lotId,
       qty, unit ?? null, issue_log_id ?? null, operation_id ?? null, work_centre_id ?? null,
       station_code ?? null, a.id, a.name, started_at ?? null, completed_at ?? null,
       bom_line_id ?? null, work_instruction_ref ?? null, deviation_reference ?? null, notes ?? null]);

    // The lot's disposition: material fitted into a unit has left WIP for a
    // panel. Tracked per lot so the forward question ("this lot of 100: where
    // did it go?") balances instead of only accounting for what reached a panel.
    if (lotId) {
      await client.query(
        `UPDATE inventory_batches
            SET quantity_in_wip = GREATEST(COALESCE(quantity_in_wip,0) - $2, 0), updated_at = NOW()
          WHERE id = $1`, [lotId, qty]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, installation: ci });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      return res.status(409).json({
        error: 'That component serial is already installed in a panel.',
        code: 'COMPONENT_SERIAL_ALREADY_INSTALLED',
      });
    }
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── What is actually fitted in one panel ─────────────────────────────────── */
router.get('/installations', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { serial_number, production_order_id, include_removed } = req.query;
    if (!serial_number && !production_order_id) {
      return res.status(400).json({ error: 'serial_number or production_order_id is required' });
    }
    let serialId = null;
    if (serial_number) {
      const { rows: [sn] } = await pool.query(
        `SELECT id FROM serial_numbers WHERE serial_number = $1 AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL) LIMIT 1`,
        [serial_number, cid]);
      if (!sn) return res.status(404).json({ error: `Serial ${serial_number} not found` });
      serialId = sn.id;
    }
    const { rows } = await pool.query(`
      SELECT ci.*, ii.item_code, ii.item_name, ii.manufacturer, ii.manufacturer_part_no,
             b.batch_number, b.supplier_batch_no, b.grn_id,
             cs.serial_number AS component_serial,
             sn.serial_number AS panel_serial,
             wc.name AS work_centre_name,
             op.operation AS operation_name
        FROM component_installations ci
        LEFT JOIN inventory_items   ii ON ii.id = ci.item_id
        LEFT JOIN inventory_batches b  ON b.id  = ci.batch_id
        LEFT JOIN serial_numbers    cs ON cs.id = ci.component_serial_id
        LEFT JOIN serial_numbers    sn ON sn.id = ci.serial_id
        LEFT JOIN work_centres      wc ON wc.id = ci.work_centre_id
        LEFT JOIN production_operations op ON op.id = ci.operation_id
       WHERE ($1::int IS NULL OR ci.company_id = $1)
         AND ($2::int IS NULL OR ci.serial_id = $2)
         AND ($3::int IS NULL OR ci.production_order_id = $3)
         AND ($4::boolean IS TRUE OR ci.removed_at IS NULL)
       ORDER BY ci.installed_at, ci.id`,
      [cid, serialId, production_order_id ? Number(production_order_id) : null,
       include_removed === 'true']);
    res.json({
      count: rows.length,
      installations: rows,
      fitted: rows.filter(r => !r.removed_at).length,
      removed: rows.filter(r => r.removed_at).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/schedule/sequence', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const out = await finiteSchedule({
      companyId:   req.scope?.company_id ?? null,
      horizonDays: Math.min(365, Math.max(1, Number(req.body?.horizon_days) || 60)),
      rule:        req.body?.rule || 'edd',
      actor:       actor(req),
      persist:     req.body?.preview !== true,
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /production/schedule — the current sequence, newest run first */
router.get('/schedule', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const [runs, ops] = await Promise.all([
      pool.query(`SELECT * FROM production_schedule_runs
                   WHERE ($1::int IS NULL OR company_id = $1)
                   ORDER BY id DESC LIMIT 20`, [cid]),
      pool.query(`
        SELECT o.id, o.production_order_id, o.operation, o.step_no, o.std_time_hrs,
               o.work_centre_id, o.work_centre_name, o.status,
               o.scheduled_seq, o.scheduled_start, o.scheduled_end,
               p.production_order_no, p.product_name, p.priority,
               COALESCE(p.planned_end_date, p.planned_start_date) AS due_date
          FROM production_operations o
          JOIN production_orders p ON p.id = o.production_order_id
         WHERE ($1::int IS NULL OR o.company_id = $1)
           AND o.scheduled_start IS NOT NULL
         ORDER BY o.work_centre_id, o.scheduled_seq
         LIMIT 1000`, [cid]),
    ]);
    const rows = ops.rows.map(r => ({
      ...r,
      late: r.scheduled_end && r.due_date ? new Date(r.scheduled_end) > new Date(r.due_date) : false,
    }));
    res.json({ runs: runs.rows, operations: rows, late_operations: rows.filter(r => r.late).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /production/schedule/work-centre/:id — one machine's queue */
router.get('/schedule/work-centre/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    const queue = await sequenceWorkCentre({
      workCentreId: Number(req.params.id),
      companyId: req.scope?.company_id ?? null,
    });
    res.json({ work_centre_id: Number(req.params.id), queue, late: queue.filter(q => q.late).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
