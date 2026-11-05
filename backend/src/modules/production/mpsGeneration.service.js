// backend/src/modules/production/mpsGeneration.service.js
/**
 * Generate the master production schedule from demand.
 *
 * WHAT WAS MISSING
 * ----------------
 * Pulse had an MPS table, MPS CRUD, and an MRP engine that read the MPS
 * correctly. What it did not have was anything that put demand INTO the MPS.
 * Every row was typed by a human, and the 2026-09-11 audit found all of them
 * netting to zero - which is why MRP produced nothing for five weeks while
 * looking, from the code, entirely correct.
 *
 * A hand-typed MPS is not a defect on its own; plenty of plants firm the
 * schedule by hand. The defect is that there was no path from a customer order
 * or an approved forecast to a production commitment at all, so the schedule
 * could only ever be someone's recollection of demand.
 *
 * WHAT THIS DOES
 * --------------
 * Demand for independent-demand items over the horizon, from two sources:
 *
 *   ORDERS    open sales-order lines, at their delivery date, net of what has
 *             already been fulfilled. This is committed demand.
 *   FORECAST  approved forecast periods, net of `consumed_qty` - the quantity
 *             that has already turned into real orders. Netting here is what
 *             stops an order being counted twice, once as itself and once as
 *             the forecast it was planned against.
 *
 * Against that it nets supply that already exists: MPS lines a planner has
 * firmed, and open production orders. What is left is a proposal.
 *
 * PROPOSALS, NOT COMMITMENTS
 * --------------------------
 * Generated rows land as `planned`, never `firm`. A planner firms them, which
 * stamps `firmed_at` - and a firmed row is never touched by a later run. That
 * boundary is deliberate and is the same one the forecast approval step draws:
 * the system may propose a number, but a person owns the commitment. Automating
 * it is exactly how a schedule full of numbers nobody agreed to goes unnoticed.
 *
 * REGENERATIVE
 * ------------
 * Each run supersedes the previous run's un-firmed proposals rather than adding
 * to them. The forecast engine had the opposite bug - it superseded only drafts,
 * so approved rows accumulated and inflated demand by a horizon per run - and
 * this avoids repeating it.
 */
import pool from '../../config/db.js';

const r3  = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

/** Items that appear as a component of some BOM are dependent demand: MRP plans
 *  them from their parent, and putting them in the MPS double-counts them. */
async function dependentItemIds(client, companyId) {
  const { rows } = await client.query(`
    SELECT DISTINCT l.component_id AS id
      FROM bom_lines l
      JOIN bom_headers h ON h.id = l.bom_id
     WHERE l.component_id IS NOT NULL
       AND ($1::int IS NULL OR h.company_id = $1 OR h.company_id IS NULL)`, [companyId]);
  return new Set(rows.map(r => Number(r.id)));
}

export async function generateMPSFromDemand({
  companyId = null, horizonDays = 90, actor = {},
} = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dependent = await dependentItemIds(client, companyId);

    // ── committed demand ────────────────────────────────────────────────────
    const { rows: orderDemand } = await client.query(`
      SELECT soi.item_id,
             i.item_name,
             i.unit_of_measure,
             so.id                                   AS order_id,
             COALESCE(so.delivery_date, so.promised_date, so.order_date) AS due_date,
             GREATEST(COALESCE(soi.quantity,0) - COALESCE(soi.fulfilled_qty,0), 0) AS qty
        FROM sales_order_items soi
        JOIN sales_orders so ON so.id = soi.order_id
        JOIN inventory_items i ON i.id = soi.item_id
       WHERE soi.item_id IS NOT NULL
         AND so.deleted_at IS NULL
         AND LOWER(COALESCE(so.order_status,'')) NOT IN ('cancelled','delivered','completed','closed')
         AND ($1::int IS NULL OR so.company_id = $1)
         AND COALESCE(so.delivery_date, so.promised_date, so.order_date)
               <= (CURRENT_DATE + ($2 || ' days')::interval)
         AND COALESCE(soi.quantity,0) > COALESCE(soi.fulfilled_qty,0)`,
      [companyId, String(horizonDays)]);

    // ── forecast demand, net of what has already become orders ──────────────
    const { rows: forecastDemand } = await client.query(`
      SELECT df.item_id,
             i.item_name,
             i.unit_of_measure,
             df.id                AS forecast_id,
             df.period_start      AS due_date,
             GREATEST(COALESCE(df.forecast_qty, df.quantity, 0) - COALESCE(df.consumed_qty,0), 0) AS qty
        FROM demand_forecasts df
        JOIN inventory_items i ON i.id = df.item_id
       WHERE df.item_id IS NOT NULL
         AND LOWER(COALESCE(df.status,'')) = 'approved'
         AND ($1::int IS NULL OR df.company_id = $1)
         AND df.period_start BETWEEN CURRENT_DATE AND (CURRENT_DATE + ($2 || ' days')::interval)
         AND COALESCE(df.forecast_qty, df.quantity, 0) > COALESCE(df.consumed_qty,0)`,
      [companyId, String(horizonDays)]);

    // ── supply that already exists ──────────────────────────────────────────
    const { rows: firmMps } = await client.query(`
      SELECT product_id, due_date, SUM(COALESCE(quantity,0)) AS qty
        FROM master_production_schedule
       WHERE ($1::int IS NULL OR company_id = $1)
         AND product_id IS NOT NULL
         AND (firmed_at IS NOT NULL OR LOWER(COALESCE(status,'')) = 'firm')
       GROUP BY product_id, due_date`, [companyId]);

    const { rows: openPOs } = await client.query(`
      SELECT product_id,
             SUM(GREATEST(COALESCE(quantity_planned,0) - COALESCE(quantity_completed,0), 0)) AS qty
        FROM production_orders
       WHERE ($1::int IS NULL OR company_id = $1)
         AND product_id IS NOT NULL
         AND LOWER(COALESCE(status,'')) NOT IN ('completed','cancelled','closed')
       GROUP BY product_id`, [companyId]);

    const supplyByItem = new Map();
    for (const s of firmMps) supplyByItem.set(Number(s.product_id), num(supplyByItem.get(Number(s.product_id))) + num(s.qty));
    for (const s of openPOs) supplyByItem.set(Number(s.product_id), num(supplyByItem.get(Number(s.product_id))) + num(s.qty));

    // ── supersede the previous run's proposals ──────────────────────────────
    const { rowCount: superseded } = await client.query(`
      DELETE FROM master_production_schedule
       WHERE ($1::int IS NULL OR company_id = $1)
         AND generated_by_run_id IS NOT NULL
         AND firmed_at IS NULL
         AND LOWER(COALESCE(status,'')) <> 'firm'`, [companyId]);

    const runNo = `MPS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const { rows: [run] } = await client.query(`
      INSERT INTO mps_generation_runs
        (company_id, run_no, horizon_days, rows_superseded, run_by, run_by_name, status)
      VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING *`,
      [companyId, runNo, horizonDays, superseded, actor.id ?? null, actor.name ?? 'System']);

    // ── net and write ───────────────────────────────────────────────────────
    const lines = [];
    let fromOrders = 0, fromForecast = 0, usedSupply = 0;
    const remainingSupply = new Map(supplyByItem);
    const considered = new Set();

    const emit = async (d, sourceKind) => {
      const itemId = Number(d.item_id);
      if (dependent.has(itemId)) return;            // planned by MRP from its parent
      considered.add(itemId);

      const gross = r3(d.qty);
      if (gross <= 0) return;
      // Existing supply is consumed earliest-due-first, which is why demand is
      // processed in date order below.
      const avail = num(remainingSupply.get(itemId));
      const covered = Math.min(avail, gross);
      const net = r3(gross - covered);
      remainingSupply.set(itemId, r3(avail - covered));
      usedSupply += covered;
      if (sourceKind === 'order') fromOrders += gross; else fromForecast += gross;
      if (net <= 0) return;

      const { rows: [row] } = await client.query(`
        INSERT INTO master_production_schedule
          (company_id, product_id, product_name, due_date, quantity, quantity_produced,
           status, demand_source, source_order_id, source_forecast_id, generated_by_run_id,
           created_by, created_by_name, notes)
        VALUES ($1,$2,$3,$4,$5,0,'planned',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [companyId, itemId, d.item_name, d.due_date, net,
         sourceKind === 'order' ? 'sales_order' : 'forecast',
         sourceKind === 'order' ? d.order_id : null,
         sourceKind === 'order' ? null : d.forecast_id,
         run.id, actor.id ?? null, actor.name ?? 'System',
         sourceKind === 'order'
           ? `Net of ${r3(covered)} existing supply; from sales order ${d.order_id}`
           : `Net of ${r3(covered)} existing supply; from approved forecast ${d.forecast_id}`]);
      lines.push(row);
    };

    const byDate = (a, b) => new Date(a.due_date) - new Date(b.due_date);
    for (const d of [...orderDemand].sort(byDate))    await emit(d, 'order');
    for (const d of [...forecastDemand].sort(byDate)) await emit(d, 'forecast');

    const { rows: [done] } = await client.query(`
      UPDATE mps_generation_runs
         SET demand_from_orders = $2, demand_from_forecast = $3, existing_supply = $4,
             rows_created = $5, items_considered = $6, status = 'completed'
       WHERE id = $1 RETURNING *`,
      [run.id, r3(fromOrders), r3(fromForecast), r3(usedSupply), lines.length, considered.size]);

    await client.query('COMMIT');
    return { run: done, lines };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Firm a generated MPS line. Firming is the planner taking ownership: the row
 * stops being a proposal and stops being superseded by the next run.
 */
export async function firmMPSLine({ id, companyId, actor = {} }) {
  const { rows: [row] } = await pool.query(`
    UPDATE master_production_schedule
       SET status = 'firm', firmed_at = NOW(), updated_at = NOW(),
           notes = COALESCE(notes,'') || ' | firmed by ' || $3
     WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
     RETURNING *`, [id, companyId, actor.name ?? 'System']);
  return row || null;
}

/**
 * Production completion reports back to the schedule.
 *
 * `quantity_produced` was a hand-typed column: the MPS could say 100 planned,
 * 0 produced, while the production order that came from it was closed and in
 * stock. "MPS vs actual production" was therefore a comparison between a plan
 * and a number nobody maintained.
 */
export async function reportProductionToMPS({ productionOrderId, companyId = null, client = pool }) {
  const { rows: [po] } = await client.query(
    `SELECT id, mps_id, quantity_completed FROM production_orders
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [productionOrderId, companyId]);
  if (!po?.mps_id) return null;

  // Recomputed from the orders, not incremented: an increment double-counts if
  // completion is reported twice, and this is the column whose drift the audit
  // found in the first place.
  const { rows: [row] } = await client.query(`
    UPDATE master_production_schedule m
       SET quantity_produced = COALESCE((
             SELECT SUM(COALESCE(p.quantity_completed,0))
               FROM production_orders p WHERE p.mps_id = m.id), 0),
           updated_at = NOW()
     WHERE m.id = $1 RETURNING *`, [po.mps_id]);
  return row || null;
}
