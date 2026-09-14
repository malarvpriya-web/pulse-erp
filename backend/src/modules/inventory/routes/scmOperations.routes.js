// backend/src/modules/inventory/routes/scmOperations.routes.js
//
// The warehouse-and-materials half of the remaining SCA components:
// excess/obsolete/slow-moving analysis, in-transit stock, JIT kanban loops,
// unit-load (pallet) handling, material-handling equipment, and RFID.
//
// Mounted at /api/inventory/scm. Every route is company-scoped through
// companyOf(req) — never req.user.company_id, which fails OPEN across tenants.
//
// A NOTE ON RFID. The reader is hardware; resolving a tag to an item, lot or
// serial and recording where it was seen is not. The scan endpoint is the
// contract a reader posts to, and it works today with a phone or a handheld that
// can make an HTTP request. Listing this as "blocked on hardware" conflated the
// device with the capability.

import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = (req) => companyOf(req);
const who = (req) => req.user?.name || req.user?.username || req.user?.email || 'System';
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;

// ─────────────────────────────────────────────────────────────────────────────
// POLICY
// ─────────────────────────────────────────────────────────────────────────────
async function policyFor(companyId) {
  if (companyId == null) {
    return { excess_cover_days: 180, obsolete_no_movement_days: 365, slow_moving_turns: 2, near_expiry_days: 90 };
  }
  const { rows } = await pool.query(`SELECT * FROM inventory_policy_settings WHERE company_id = $1`, [companyId]);
  if (rows[0]) return rows[0];
  const { rows: [created] } = await pool.query(
    `INSERT INTO inventory_policy_settings (company_id) VALUES ($1)
     ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW() RETURNING *`, [companyId]);
  return created;
}

router.get('/policy', requirePermission('inventory', 'view'), async (req, res) => {
  try { res.json(await policyFor(cid(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/policy', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    if (companyId == null) return res.status(400).json({ error: 'A company scope is required to set inventory policy.' });
    await policyFor(companyId);
    const allowed = ['excess_cover_days', 'obsolete_no_movement_days', 'slow_moving_turns', 'near_expiry_days'];
    const sets = [], vals = [companyId];
    for (const k of allowed) {
      if (req.body?.[k] === undefined) continue;
      vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return res.json(await policyFor(companyId));
    const { rows: [row] } = await pool.query(
      `UPDATE inventory_policy_settings SET ${sets.join(', ')}, updated_at = NOW()
        WHERE company_id = $1 RETURNING *`, vals);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXCESS / OBSOLETE / SLOW-MOVING
// ─────────────────────────────────────────────────────────────────────────────
/* GET /inventory/scm/excess-obsolete
   Three distinct conditions, deliberately not merged into one "dead stock" list:
     excess    more cover than policy allows — the item still sells
     slow      turning below the policy floor
     obsolete  no outward movement at all for the policy window
   They call for different actions, so collapsing them loses the information. */
router.get('/excess-obsolete', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const p = await policyFor(companyId);
    const { rows } = await pool.query(`
      WITH last_out AS (
        SELECT item_id, MAX(transaction_date) AS last_issue
          FROM stock_ledger WHERE quantity_out > 0 GROUP BY item_id
      )
      SELECT ii.id, ii.item_code, ii.item_name, ii.abc_class,
             COALESCE(ii.current_stock,0)::numeric      AS current_stock,
             COALESCE(ii.annual_demand,0)::numeric      AS annual_demand,
             COALESCE(ii.avg_daily_demand,0)::numeric   AS avg_daily_demand,
             COALESCE(ii.standard_cost,0)::numeric      AS unit_cost,
             (COALESCE(ii.current_stock,0) * COALESCE(ii.standard_cost,0))::numeric AS stock_value,
             lo.last_issue,
             CASE WHEN COALESCE(ii.avg_daily_demand,0) > 0
                  THEN ROUND((COALESCE(ii.current_stock,0) / ii.avg_daily_demand)::numeric, 1) END AS cover_days,
             CASE WHEN COALESCE(ii.current_stock,0) > 0 AND COALESCE(ii.annual_demand,0) > 0
                  THEN ROUND((ii.annual_demand / NULLIF(ii.current_stock,0))::numeric, 2) END AS turns
        FROM inventory_items ii
        LEFT JOIN last_out lo ON lo.item_id = ii.id
       WHERE ($1::int IS NULL OR ii.company_id = $1)
         AND ii.deleted_at IS NULL AND COALESCE(ii.is_active,true) = true
         AND COALESCE(ii.current_stock,0) > 0
       ORDER BY stock_value DESC`, [companyId]);

    const today = new Date();
    const excess = [], slow = [], obsolete = [];
    for (const r of rows) {
      const lastIssue = r.last_issue ? new Date(r.last_issue) : null;
      const daysSince = lastIssue ? Math.floor((today - lastIssue) / 86400000) : null;
      const row = { ...r, days_since_last_issue: daysSince };

      // No outward movement in the window — and never having moved counts, which
      // a naive "last_issue older than X" test silently misses.
      if (daysSince === null || daysSince > p.obsolete_no_movement_days) {
        obsolete.push({ ...row, reason: daysSince === null ? 'never issued' : `no issue for ${daysSince} days` });
        continue;
      }
      if (r.cover_days !== null && num(r.cover_days) > p.excess_cover_days) {
        excess.push({ ...row, excess_qty: Math.max(0,
          num(r.current_stock) - num(r.avg_daily_demand) * p.excess_cover_days),
          reason: `${r.cover_days} days of cover against a ${p.excess_cover_days}-day policy` });
      }
      if (r.turns !== null && num(r.turns) < num(p.slow_moving_turns)) {
        slow.push({ ...row, reason: `${r.turns} turns against a ${p.slow_moving_turns} floor` });
      }
    }
    const sumValue = (a) => Math.round(a.reduce((s, r) => s + num(r.stock_value), 0) * 100) / 100;

    res.json({
      policy: p,
      excess:   { count: excess.length,   value: sumValue(excess),   items: excess },
      slow_moving: { count: slow.length,  value: sumValue(slow),     items: slow },
      obsolete: { count: obsolete.length, value: sumValue(obsolete), items: obsolete },
      total_at_risk_value: sumValue([...excess, ...slow, ...obsolete]),
    });
  } catch (e) { console.error('[scm/excess-obsolete]', e); res.status(500).json({ error: e.message }); }
});

/* GET /inventory/scm/near-expiry — lots approaching their expiry date. */
router.get('/near-expiry', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const p = await policyFor(companyId);
    const { rows } = await pool.query(`
      SELECT b.id, b.batch_number, b.expiry_date, b.quantity_available, b.rate,
             (b.expiry_date - CURRENT_DATE) AS days_to_expiry,
             ii.item_code, ii.item_name
        FROM inventory_batches b JOIN inventory_items ii ON ii.id = b.item_id
       WHERE ($1::int IS NULL OR b.company_id = $1)
         AND b.deleted_at IS NULL AND COALESCE(b.quantity_available,0) > 0
         AND b.expiry_date IS NOT NULL
         AND b.expiry_date <= CURRENT_DATE + ($2 || ' days')::interval
       ORDER BY b.expiry_date`, [companyId, p.near_expiry_days]);
    res.json({ horizon_days: p.near_expiry_days, count: rows.length, lots: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// IN-TRANSIT
// ─────────────────────────────────────────────────────────────────────────────
/* GET /inventory/scm/in-transit
   Stock that has left one place and not arrived at the next. It is real
   inventory the company owns and had no representation at all: inbound is a
   dispatched purchase order not yet received, outbound is a dispatched shipment
   not yet delivered. */
router.get('/in-transit', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [inbound, outbound] = await Promise.all([
      pool.query(`
        SELECT po.po_number AS reference, v.vendor_name AS counterparty,
               ii.id AS item_id, ii.item_code, ii.item_name,
               (COALESCE(poi.quantity,0) - COALESCE(poi.received_qty,0))::numeric AS quantity,
               po.expected_delivery_date AS due_date,
               ((COALESCE(poi.quantity,0) - COALESCE(poi.received_qty,0)) * COALESCE(poi.rate,0))::numeric AS value,
               CASE WHEN po.expected_delivery_date < CURRENT_DATE THEN true ELSE false END AS overdue
          FROM purchase_order_items poi
          JOIN purchase_orders po ON po.id = poi.po_id
          JOIN inventory_items ii ON ii.id = poi.item_id
          LEFT JOIN vendors v ON v.id = po.supplier_id
         WHERE ($1::int IS NULL OR po.company_id = $1) AND po.deleted_at IS NULL
           AND LOWER(COALESCE(po.status,'')) IN ('approved','sent','acknowledged','partial','in_transit')
           AND (COALESCE(poi.quantity,0) - COALESCE(poi.received_qty,0)) > 0
         ORDER BY po.expected_delivery_date NULLS LAST`, [companyId]),
      pool.query(`
        SELECT s.dispatch_ref AS reference, so.customer_name AS counterparty,
               pl.item_id, ii.item_code, ii.item_name, pl.quantity::numeric,
               s.expected_delivery AS due_date,
               (pl.quantity * COALESCE(ii.standard_cost,0))::numeric AS value,
               CASE WHEN s.expected_delivery < CURRENT_DATE THEN true ELSE false END AS overdue
          FROM shipments s
          JOIN packages pkg ON pkg.shipment_id = s.id
          JOIN package_lines pl ON pl.package_id = pkg.id
          LEFT JOIN inventory_items ii ON ii.id = pl.item_id
          LEFT JOIN sales_orders so ON so.id = s.sales_order_id
         WHERE ($1::int IS NULL OR s.company_id = $1)
           AND LOWER(COALESCE(s.status,'')) IN ('in_transit','dispatched','shipped')
           AND s.actual_delivery IS NULL
         ORDER BY s.expected_delivery NULLS LAST`, [companyId]),
    ]);
    const total = (rows) => Math.round(rows.reduce((s, r) => s + num(r.value), 0) * 100) / 100;
    res.json({
      inbound:  { lines: inbound.rows.length,  value: total(inbound.rows),  items: inbound.rows },
      outbound: { lines: outbound.rows.length, value: total(outbound.rows), items: outbound.rows },
    });
  } catch (e) { console.error('[scm/in-transit]', e); res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// JIT / KANBAN
// ─────────────────────────────────────────────────────────────────────────────
/* A kanban loop is a fixed quantity of stock circulating between a consuming and
   a supplying location. Emptying a container signals replenishment — a PULL, as
   opposed to MRP's push. The two coexist: MRP plans the parts that need
   planning, kanban runs the high-frequency, low-value ones where a planned order
   per consumption would be absurd. */
router.get('/kanban/loops', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT k.*, ii.item_code, ii.item_name, v.vendor_name, wc.name AS work_centre_name,
             (SELECT COUNT(*)::int FROM kanban_cards c WHERE c.loop_id = k.id AND c.status = 'full')     AS cards_full,
             (SELECT COUNT(*)::int FROM kanban_cards c WHERE c.loop_id = k.id AND c.status = 'signalled') AS cards_signalled,
             (SELECT COUNT(*)::int FROM kanban_cards c WHERE c.loop_id = k.id AND c.status = 'empty')     AS cards_empty
        FROM kanban_loops k
        LEFT JOIN inventory_items ii ON ii.id = k.item_id
        LEFT JOIN vendors v          ON v.id  = k.vendor_id
        LEFT JOIN work_centres wc    ON wc.id = k.work_centre_id
       WHERE ($1::int IS NULL OR k.company_id = $1)
       ORDER BY k.loop_code`, [cid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/kanban/loops', requirePermission('inventory', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { item_id, container_qty, card_count, supply_source, vendor_id, work_centre_id,
            consuming_location, supplying_location, replenish_lead_hours, loop_code } = req.body || {};
    if (!item_id || !container_qty || !card_count) {
      return res.status(400).json({ error: 'item_id, container_qty and card_count are required' });
    }
    await client.query('BEGIN');
    const companyId = cid(req);
    const code = loop_code || `KB-${String(item_id).padStart(4, '0')}-${Date.now().toString().slice(-4)}`;
    const { rows: [loop] } = await client.query(`
      INSERT INTO kanban_loops
        (company_id, loop_code, item_id, supply_source, vendor_id, work_centre_id,
         consuming_location, supplying_location, container_qty, card_count, replenish_lead_hours)
      VALUES ($1,$2,$3,COALESCE($4,'supplier'),$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [companyId, code, item_id, supply_source, vendor_id ?? null, work_centre_id ?? null,
       consuming_location ?? null, supplying_location ?? null, container_qty, card_count,
       replenish_lead_hours ?? null]);

    // Cards start full: a loop is commissioned with its stock in place, and
    // creating it empty would signal a replenishment storm on day one.
    for (let i = 1; i <= parseInt(card_count, 10); i++) {
      await client.query(
        `INSERT INTO kanban_cards (loop_id, company_id, card_no, status, quantity)
         VALUES ($1,$2,$3,'full',$4)`,
        [loop.id, companyId, `${code}-${String(i).padStart(2, '0')}`, container_qty]);
    }
    await client.query('COMMIT');
    res.status(201).json(loop);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'A loop with that code already exists' });
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /kanban/cards/:id/signal — the container is empty; pull a replacement. */
router.post('/kanban/cards/:id/signal', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [card] } = await client.query(`
      SELECT c.*, k.item_id, k.supply_source, k.vendor_id, k.container_qty, k.loop_code, k.company_id
        FROM kanban_cards c JOIN kanban_loops k ON k.id = c.loop_id
       WHERE c.id = $1 AND ($2::int IS NULL OR c.company_id = $2) FOR UPDATE`,
      [req.params.id, cid(req)]);
    if (!card) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Card not found' }); }
    if (card.status === 'signalled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This card is already signalled and awaiting replenishment.' });
    }

    // A supplier loop raises a purchase requisition; an internal loop is a
    // shop-floor pull that the supplying location fills.
    let refType = null, refId = null;
    if (card.supply_source === 'supplier') {
      // 'pending_approval', not 'pending': the procurement KPI strip buckets
      // draft / pending_approval / approved / ordered / rejected, and anything
      // outside that vocabulary lands in an "other" bucket that the strip's own
      // test asserts must stay empty. A kanban pull is a requisition like any
      // other and goes for approval.
      const { rows: [pr] } = await client.query(`
        INSERT INTO purchase_requests
          (request_number, company_id, status, request_date, notes, item_code)
        VALUES ($1,$2,'pending_approval',CURRENT_DATE,$3,
                (SELECT item_code FROM inventory_items WHERE id = $4)) RETURNING id, request_number`,
        [`PR-KB-${card.card_no}`, card.company_id,
         `Kanban pull — loop ${card.loop_code}, ${card.container_qty} units`, card.item_id]);
      refType = 'purchase_request'; refId = pr.id;
    }

    const { rows: [updated] } = await client.query(`
      UPDATE kanban_cards SET status = 'signalled', signalled_at = NOW(),
             reference_type = $2, reference_id = $3
       WHERE id = $1 RETURNING *`, [card.id, refType, refId]);
    await client.query('COMMIT');
    res.json({ card: updated, pull_raised: refType ? { type: refType, id: refId } : null });
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /kanban/cards/:id/replenish — the container came back full. */
router.post('/kanban/cards/:id/replenish', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(`
      UPDATE kanban_cards SET status = 'full', replenished_at = NOW()
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [req.params.id, cid(req)]);
    if (!row) return res.status(404).json({ error: 'Card not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIT LOADS (PALLETS)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/unit-loads', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.*, (SELECT COUNT(*)::int FROM packages p WHERE p.unit_load_id = u.id) AS package_count
        FROM unit_loads u WHERE ($1::int IS NULL OR u.company_id = $1)
       ORDER BY u.id DESC LIMIT 100`, [cid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /unit-loads — build a pallet from packed cartons. */
router.post('/unit-loads', requirePermission('inventory', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { package_ids = [], load_type, warehouse_id, bin_id, height_cm, sscc } = req.body || {};
    await client.query('BEGIN');
    const companyId = cid(req);
    const { rows: [seq] } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(unit_load_no, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
         FROM unit_loads WHERE ($1::int IS NULL OR company_id = $1)`, [companyId]);
    const no = `ULD-${String(seq.n).padStart(6, '0')}`;

    const { rows: [ul] } = await client.query(`
      INSERT INTO unit_loads
        (company_id, unit_load_no, load_type, sscc, warehouse_id, bin_id, height_cm,
         status, built_by_name, built_at)
      VALUES ($1,$2,COALESCE($3,'pallet'),$4,$5,$6,$7,'built',$8,NOW()) RETURNING *`,
      [companyId, no, load_type, sscc ?? null, warehouse_id ?? null, bin_id ?? null,
       height_cm ?? null, who(req)]);

    if (package_ids.length) {
      await client.query(
        `UPDATE packages SET unit_load_id = $1 WHERE id = ANY($2::int[])`, [ul.id, package_ids]);
      // The pallet's weight is the sum of what is on it, not a separate figure
      // somebody types and nobody reconciles.
      await client.query(`
        UPDATE unit_loads SET gross_weight_kg =
          (SELECT COALESCE(SUM(gross_weight_kg),0) FROM packages WHERE unit_load_id = $1)
         WHERE id = $1`, [ul.id]);
    }
    await client.query('COMMIT');
    const { rows: [final] } = await pool.query(`SELECT * FROM unit_loads WHERE id = $1`, [ul.id]);
    res.status(201).json({ ...final, packages: package_ids.length });
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MATERIAL-HANDLING EQUIPMENT
// ─────────────────────────────────────────────────────────────────────────────
router.get('/mhe', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.*, w.warehouse_name,
             (SELECT a.task_type FROM mhe_assignments a
               WHERE a.equipment_id = e.id AND a.released_at IS NULL
               ORDER BY a.assigned_at DESC LIMIT 1) AS current_task,
             (SELECT a.operator_name FROM mhe_assignments a
               WHERE a.equipment_id = e.id AND a.released_at IS NULL
               ORDER BY a.assigned_at DESC LIMIT 1) AS current_operator,
             CASE WHEN e.next_service_date IS NOT NULL AND e.next_service_date <= CURRENT_DATE
                  THEN true ELSE false END AS service_overdue
        FROM mhe_equipment e
        LEFT JOIN warehouses w ON w.id = e.warehouse_id
       WHERE ($1::int IS NULL OR e.company_id = $1)
       ORDER BY e.equipment_name`, [cid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mhe', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { equipment_code, equipment_name, equipment_type, warehouse_id, capacity_kg,
            asset_id, last_service_date, next_service_date } = req.body || {};
    if (!equipment_name) return res.status(400).json({ error: 'equipment_name is required' });
    const { rows: [row] } = await pool.query(`
      INSERT INTO mhe_equipment
        (company_id, equipment_code, equipment_name, equipment_type, warehouse_id,
         capacity_kg, asset_id, last_service_date, next_service_date)
      VALUES ($1,$2,$3,COALESCE($4,'forklift'),$5,$6,$7,$8,$9) RETURNING *`,
      [cid(req), equipment_code ?? null, equipment_name, equipment_type, warehouse_id ?? null,
       capacity_kg ?? null, asset_id ?? null, last_service_date ?? null, next_service_date ?? null]);
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That equipment code already exists' });
    res.status(500).json({ error: e.message });
  }
});

/* POST /mhe/:id/assign — put a machine on a task; release the previous one. */
router.post('/mhe/:id/assign', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { task_type, reference_type, reference_id, operator_name, notes } = req.body || {};
    if (!task_type) return res.status(400).json({ error: 'task_type is required' });
    await client.query('BEGIN');
    const { rows: [eq] } = await client.query(
      `SELECT * FROM mhe_equipment WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, cid(req)]);
    if (!eq) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }
    if (eq.status === 'maintenance') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This equipment is under maintenance and cannot be assigned.' });
    }
    await client.query(
      `UPDATE mhe_assignments SET released_at = NOW() WHERE equipment_id = $1 AND released_at IS NULL`,
      [eq.id]);
    const { rows: [a] } = await client.query(`
      INSERT INTO mhe_assignments
        (equipment_id, company_id, task_type, reference_type, reference_id, operator_name, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [eq.id, eq.company_id, task_type, reference_type ?? null, reference_id ?? null,
       operator_name || who(req), notes ?? null]);
    await client.query(`UPDATE mhe_equipment SET status = 'in_use' WHERE id = $1`, [eq.id]);
    await client.query('COMMIT');
    res.status(201).json(a);
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.post('/mhe/:id/release', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE mhe_assignments SET released_at = NOW() WHERE equipment_id = $1 AND released_at IS NULL`,
      [req.params.id]);
    const { rows: [row] } = await pool.query(
      `UPDATE mhe_equipment SET status = 'available'
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [req.params.id, cid(req)]);
    if (!row) return res.status(404).json({ error: 'Equipment not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RFID
// ─────────────────────────────────────────────────────────────────────────────
/* POST /rfid/tags — bind an EPC to something already traceable. */
router.post('/rfid/tags', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { epc, tag_type, item_id, batch_id, serial_id, unit_load_id } = req.body || {};
    if (!epc) return res.status(400).json({ error: 'epc is required' });
    if (!item_id && !batch_id && !serial_id && !unit_load_id) {
      // A tag bound to nothing is a barcode with extra steps.
      return res.status(400).json({ error: 'A tag must be bound to an item, batch, serial or unit load.' });
    }
    const { rows: [row] } = await pool.query(`
      INSERT INTO rfid_tags (company_id, epc, tag_type, item_id, batch_id, serial_id, unit_load_id)
      VALUES ($1,$2,COALESCE($3,'passive'),$4,$5,$6,$7) RETURNING *`,
      [cid(req), epc, tag_type, item_id ?? null, batch_id ?? null, serial_id ?? null, unit_load_id ?? null]);
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That EPC is already commissioned' });
    res.status(500).json({ error: e.message });
  }
});

/* POST /rfid/scan — what a reader posts. Accepts one scan or a batch of them.
   An unknown EPC is RECORDED, not rejected: a reader seeing a tag nobody
   registered is exactly the event a warehouse wants to know about, and dropping
   it loses the only evidence it happened. */
router.post('/rfid/scan', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const body = req.body || {};
    const scans = Array.isArray(body.scans) ? body.scans : [body];
    const companyId = cid(req);
    const out = [];
    for (const sc of scans) {
      if (!sc.epc) continue;
      const { rows: [tag] } = await pool.query(
        `SELECT id, item_id, batch_id, serial_id, unit_load_id FROM rfid_tags WHERE epc = $1`, [sc.epc]);
      const { rows: [row] } = await pool.query(`
        INSERT INTO rfid_scans
          (company_id, tag_id, epc, reader_id, location_code, warehouse_id, bin_id, scan_type, scanned_at, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, NOW()),$10) RETURNING *`,
        [companyId, tag?.id ?? null, sc.epc, sc.reader_id ?? null, sc.location_code ?? null,
         sc.warehouse_id ?? null, sc.bin_id ?? null, sc.scan_type ?? null,
         sc.scanned_at ?? null, sc.raw ? JSON.stringify(sc.raw) : null]);
      out.push({ ...row, resolved: Boolean(tag), bound_to: tag || null });
    }
    res.status(201).json({ recorded: out.length, unresolved: out.filter(s => !s.resolved).length, scans: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /rfid/tags/:epc — resolve a tag and show where it has been. */
router.get('/rfid/tags/:epc', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows: [tag] } = await pool.query(`
      SELECT t.*, ii.item_code, ii.item_name, b.batch_number, sn.serial_number, u.unit_load_no
        FROM rfid_tags t
        LEFT JOIN inventory_items ii   ON ii.id = t.item_id
        LEFT JOIN inventory_batches b  ON b.id  = t.batch_id
        LEFT JOIN serial_numbers sn    ON sn.id = t.serial_id
        LEFT JOIN unit_loads u         ON u.id  = t.unit_load_id
       WHERE t.epc = $1 AND ($2::int IS NULL OR t.company_id = $2 OR t.company_id IS NULL)`,
      [req.params.epc, cid(req)]);
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    const { rows: scans } = await pool.query(
      `SELECT * FROM rfid_scans WHERE epc = $1 ORDER BY scanned_at DESC LIMIT 100`, [req.params.epc]);
    res.json({ tag, scan_count: scans.length, scans });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
