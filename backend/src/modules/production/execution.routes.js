import { Router } from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { nextProdOrderNumber } from '../../shared/docNumber.js';
import { requirePermission, hasRole } from '../../middlewares/auth.middleware.js';

const router = Router();

const actor = (req) => ({
  id:   req.user?.userId || req.user?.id || null,
  name: req.user?.name   || req.user?.email || 'System',
});

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

/* ── Compute standard cost from BOM for a production order ── */
async function computeStdCost(client, bomId, quantity) {
  if (!bomId) return { material: 0, machine: 0, total: 0 };

  const { rows: lines } = await client.query(
    `SELECT bl.qty, bl.unit_cost FROM bom_lines bl WHERE bl.bom_id = $1`, [bomId]
  );
  const material = lines.reduce((s, l) => s + parseFloat(l.qty || 0) * parseFloat(l.unit_cost || 0) * quantity, 0);

  const { rows: steps } = await client.query(
    `SELECT rs.std_time_hrs, COALESCE(wc.cost_per_hour, 0) AS cost_per_hour
     FROM routing_steps rs
     LEFT JOIN work_centres wc ON wc.id = rs.work_centre_id
     WHERE rs.bom_id = $1`, [bomId]
  );
  const machine = steps.reduce((s, r) => s + parseFloat(r.std_time_hrs || 0) * parseFloat(r.cost_per_hour || 0) * quantity, 0);

  return { material: parseFloat(material.toFixed(4)), machine: parseFloat(machine.toFixed(4)), total: parseFloat((material + machine).toFixed(4)) };
}

/* ── Upsert production_order_costs ── */
async function upsertOrderCosts(client, orderId, companyId, bomId, quantity) {
  const c = await computeStdCost(client, bomId, quantity);
  await client.query(`
    INSERT INTO production_order_costs
      (production_order_id, company_id, std_material_cost, std_machine_cost, std_total_cost,
       actual_material_cost, actual_machine_cost, actual_total_cost, quantity_produced, last_computed_at)
    VALUES ($1,$2,$3,$4,$5,0,0,0,0,NOW())
    ON CONFLICT (production_order_id) DO UPDATE
      SET std_material_cost=$3, std_machine_cost=$4, std_total_cost=$5,
          last_computed_at=NOW(), updated_at=NOW()
  `, [orderId, companyId, c.material, c.machine, c.total]);
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

/* ── Backflush: consume reserved materials on operation complete ── */
async function backflushMaterials(client, orderId, companyId, operationId, actorId, actorName) {
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
    // Deduct from inventory_items if possible
    if (res.item_id) {
      await client.query(
        `UPDATE inventory_items SET current_stock = GREATEST(0, current_stock - $1), updated_at=NOW() WHERE id=$2`,
        [toConsume, res.item_id]
      ).catch(() => {}); // non-fatal if inventory table differs
    }
  }
}

/* ── Record finished goods receipt into inventory ── */
async function receiveFG(client, order, actorId, actorName) {
  if (!order.product_id) return;
  await client.query(
    `UPDATE inventory_items
     SET current_stock = current_stock + $1, updated_at=NOW()
     WHERE id=$2`,
    [parseFloat(order.quantity_completed || order.quantity_planned), order.product_id]
  ).catch(() => {}); // non-fatal

  await client.query(`
    INSERT INTO wip_transactions
      (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, actor_id, actor_name, to_location)
    VALUES ($1,$2,'complete',$3,$4,$5,'pcs',$6,$7,'Finished Goods Store')
  `, [order.company_id, order.id, order.product_id, order.product_name,
      parseFloat(order.quantity_completed || order.quantity_planned), actorId, actorName]);

  // Update actual cost
  const { rows: [costRow] } = await client.query(
    `SELECT actual_material_cost, actual_machine_cost FROM production_order_costs WHERE production_order_id=$1`, [order.id]
  );
  if (costRow) {
    const total = parseFloat(costRow.actual_material_cost || 0) + parseFloat(costRow.actual_machine_cost || 0);
    const qty   = parseFloat(order.quantity_completed || order.quantity_planned) || 1;
    await client.query(`
      UPDATE production_order_costs
      SET actual_total_cost=$1, cost_per_unit=$2,
          material_variance=actual_material_cost-std_material_cost,
          machine_variance=actual_machine_cost-std_machine_cost,
          total_variance=(actual_material_cost+actual_machine_cost)-std_total_cost,
          quantity_produced=$3, updated_at=NOW()
      WHERE production_order_id=$4
    `, [total, total / qty, qty, order.id]);
  }
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
          `INSERT INTO production_operations
            (production_order_id, routing_step_id, step_no, operation, work_centre_id, work_centre_name, std_time_hrs, status, is_inspection)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
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
router.patch('/orders/:id/plan', requirePermission('production', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
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
      await client.query(
        `UPDATE inventory_items SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2`,
        [qty, order.product_id]
      ).catch(() => {});
    }
    await client.query(`
      INSERT INTO wip_transactions
        (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, actor_id, actor_name, to_location)
      VALUES ($1,$2,'complete',$3,$4,$5,'pcs',$6,$7,'Finished Goods Store')
    `, [cid, order.id, order.product_id, order.product_name, qty, a.id, a.name]).catch(() => {});

    // Co-/by-products: stock in the additional outputs of this BOM at completion.
    if (order.bom_id) {
      try {
        const { rows: outs } = await client.query(
          `SELECT item_id, item_name, uom, output_type, qty_per_parent FROM bom_outputs WHERE bom_id = $1`, [order.bom_id]);
        for (const o of outs) {
          const outQty = parseFloat(o.qty_per_parent || 0) * qty;
          if (outQty <= 0) continue;
          if (o.item_id) await client.query(
            `UPDATE inventory_items SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2`, [outQty, o.item_id]);
          await client.query(`
            INSERT INTO wip_transactions
              (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, actor_id, actor_name, to_location)
            VALUES ($1,$2,'complete',$3,$4,$5,$6,$7,$8,$9)`,
            [cid, order.id, o.item_id, `${o.item_name} (${o.output_type === 'by' ? 'by' : 'co'}-product)`, outQty, o.uom || 'pcs', a.id, a.name, 'Finished Goods Store']);
        }
      } catch (e) { /* bom_outputs optional pre-migration */ }
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
router.patch('/orders/:id/issue-materials', requirePermission('production', 'edit'), async (req, res) => {
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
        await client.query(
          `UPDATE inventory_items SET current_stock = GREATEST(0, current_stock - $1), updated_at = NOW() WHERE id = $2`,
          [remaining, rsv.item_id]
        ).catch(() => {});
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
router.put('/orders/:id', requirePermission('production', 'edit'), async (req, res) => {
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
      const { rows: [setting] } = await client.query(
        `SELECT settings FROM module_settings WHERE module='production' AND company_id=$1 LIMIT 1`, [cid]
      ).catch(() => ({ rows: [null] }));
      const allowPartial = setting?.settings?.allow_partial_issue === true;

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
    // Clear existing reservations first
    await client.query(
      `DELETE FROM material_reservations WHERE production_order_id=$1 AND status='pending'`, [req.params.id]
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

    // Deduct from inventory
    if (res_row.item_id) {
      await client.query(
        `UPDATE inventory_items SET current_stock=GREATEST(0, current_stock-$1), updated_at=NOW() WHERE id=$2`,
        [qty_issued, res_row.item_id]
      ).catch(() => {});
    }

    // Get unit cost
    const { rows: [item] } = await client.query(
      `SELECT COALESCE(standard_cost, 0) AS unit_cost FROM inventory_items WHERE id=$1`, [res_row.item_id]
    ).catch(() => ({ rows: [{ unit_cost: 0 }] }));
    const unitCost = parseFloat(item?.unit_cost || 0);
    const totalCost = unitCost * qty_issued;

    // Log material issue
    await client.query(`
      INSERT INTO material_issue_logs
        (company_id, production_order_id, reservation_id, item_id, item_name, qty_issued, unit, unit_cost, total_cost, issued_by, issued_by_name, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [cid, req.params.id, reservation_id, res_row.item_id, res_row.item_name,
        qty_issued, res_row.unit, unitCost, totalCost, a.id, a.name, remarks || null]);

    // WIP transaction
    await client.query(`
      INSERT INTO wip_transactions
        (company_id, production_order_id, transaction_type, item_id, item_name, quantity, unit, unit_cost, total_cost, reservation_id, actor_id, actor_name, from_location, to_location)
      VALUES ($1,$2,'issue',$3,$4,$5,$6,$7,$8,$9,$10,$11,'Raw Materials Store','Shop Floor')
    `, [cid, req.params.id, res_row.item_id, res_row.item_name,
        qty_issued, res_row.unit, unitCost, totalCost, reservation_id, a.id, a.name]);

    // Update actual material cost
    await client.query(`
      INSERT INTO production_order_costs (production_order_id, company_id, actual_material_cost, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (production_order_id) DO UPDATE
        SET actual_material_cost = production_order_costs.actual_material_cost + $3, updated_at=NOW()
    `, [req.params.id, cid, totalCost]);

    await client.query('COMMIT');
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

    // Compute actual machine cost for this operation
    const durationHrs = op.started_at
      ? (Date.now() - new Date(op.started_at).getTime()) / 3600000
      : parseFloat(op.std_time_hrs || 0);
    const { rows: [wc] } = await client.query(
      `SELECT cost_per_hour FROM work_centres WHERE id=$1`, [op.work_centre_id]
    ).catch(() => ({ rows: [null] }));
    const machineCost = durationHrs * parseFloat(wc?.cost_per_hour || 0);
    if (machineCost > 0) {
      await client.query(`
        INSERT INTO production_order_costs (production_order_id, company_id, actual_machine_cost, updated_at)
        VALUES ($1,$2,$3,NOW())
        ON CONFLICT (production_order_id) DO UPDATE
          SET actual_machine_cost = production_order_costs.actual_machine_cost + $3, updated_at=NOW()
      `, [op.production_order_id, cid, machineCost]);
    }

    // Check if all operations complete → close order
    const pending = await client.query(
      `SELECT COUNT(*)::INT AS n FROM production_operations
       WHERE production_order_id=$1 AND status NOT IN ('completed','skipped')`,
      [op.production_order_id]
    );
    if ((pending.rows[0]?.n || 0) === 0) {
      // Backflush materials
      await backflushMaterials(client, op.production_order_id, cid, op.id, a.id, a.name);

      const { rows: [completedOrder] } = await client.query(
        `UPDATE production_orders
         SET status='completed', actual_end_at=NOW(), updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [op.production_order_id]
      );
      // Receive finished goods
      if (completedOrder) await receiveFG(client, completedOrder, a.id, a.name);
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
    for (const item of shortages) {
      try {
        const { rows: [pr] } = await pool.query(
          `INSERT INTO purchase_requests (company_id, item_name, qty_requested, unit, estimated_cost, status, raised_by, notes)
           VALUES ($1,$2,$3,$4,$5,'draft',$6,$7) RETURNING id`,
          [cid, item.item_name, item.suggested_po_qty, item.unit,
           item.suggested_po_qty * item.unit_cost, a.id,
           `MRP requirement: ${item.required_qty} ${item.unit} needed${from_date ? ` from ${from_date}` : ''}${to_date ? ` to ${to_date}` : ''}`]
        );
        prs.push({ pr_id: pr.id, item: item.item_name, qty: item.suggested_po_qty });
      } catch { /* non-fatal: skip item */ }
    }
    res.json({ created: prs.length, prs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
