// backend/src/modules/warehouse/pickListWorkflow.service.js
//
// The pick list's whole life, in one place: pick, pack, dispatch, cancel. Every
// route that changes a pick list's status or its stock goes through here — the
// normal workflow routes AND PATCH /pick-lists/:id/status, which used to write
// any of 'packed' / 'dispatched' / 'cancelled' straight onto the row: a list
// could be "dispatched" with no shipment and no quality gate, "packed" with no
// package, or "cancelled" with its picked stock never returned.
//
// WHO OWNS THE STOCK
//   The pick list does. Stock leaves the warehouse when it is picked
//   (stock_ledger 'dispatch', reference_type 'pick_list', reference_id = list),
//   and only the pick list may return it: a correction downward or a
//   cancellation. Packing and dispatch move no stock. A sales invoice never
//   moves warehouse-picked stock (see invoice.service STOCK_LINE rule).
//
// THE STATE MACHINE (from the existing workflow and the Warehouse screen)
//   pending ─pick─▶ in-progress ─pick─▶ completed
//      │              │   ▲               │  ▲ (pick corrections allowed until packed)
//      │              ▼   │               ▼  │
//      └──cancel──▶ cancelled ◀──cancel───┘
//   completed / in-progress ─pack─▶ packed ─pack─▶ packed (another carton)
//   completed / in-progress / packed ─dispatch─▶ dispatched   (≥ 1 unit picked;
//                                                              quality gate)
//   packed, dispatched: no picks, no cancel (there is no unpack workflow; a
//   dispatched list's goods have left — a return is a separate document).
//   cancelled, dispatched: terminal.
//
// HOW STOCK IS POSTED — RECONCILED, NEVER APPENDED
//   reconcileStock() compares what the list should have taken out (per item and
//   warehouse: the picked quantities, or zero once cancelled) with what the
//   ledger says this list has taken out, and posts only the difference. A retry
//   posts nothing; a correction posts the correction; a cancellation posts
//   exactly the net still out — whatever partial picks and corrections came
//   before — and a second cancellation finds nothing left to return. The pick
//   list row is locked FOR UPDATE by every caller, so concurrent requests on one
//   list are serialised and each reconciles against the other's committed rows.
//   A return posts the same 'dispatch' type with quantity_in, which
//   ledgerSemantics reads as an issue reversal (demand falls by the same amount).

import { postStock } from '../production/subcontracting.routes.js';

/** A refusal with an HTTP status, raised inside the workflow transaction. */
export class WorkflowError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TERMINAL_OR_SHIPPED = new Set(['dispatched', 'cancelled']);
const statusOf = (pl) => String(pl?.status || 'pending').toLowerCase();
const actorName = (req) => req?.user?.name || req?.user?.username || null;

/** Lock a pick list the caller's company owns. 404 for anything else. */
export async function lockPickList(client, id, companyId) {
  if (!/^\d+$/.test(String(id ?? ''))) throw new WorkflowError(400, 'Pick list id must be a number.');
  const { rows: [pl] } = await client.query(
    `SELECT * FROM pick_lists WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
    [id, companyId]);
  if (!pl) throw new WorkflowError(404, 'Pick list not found');
  return pl;
}

/**
 * The final-inspection dispatch gate — the ONE implementation, used by the
 * warehouse dispatch and by sales-order dispatch alike. No caller has an
 * override: sales-order dispatch's `force` relaxes only its production gate.
 *
 * Explicitly configured QC requirements (qc_requirements) always apply — the
 * gate switch below does not turn them off (Phase 3G).
 *
 * The record checks are on when quality_settings.fat_dispatch_gate is on (the
 * default when a company has no settings row). They look at the sales order's
 * non-cancelled production orders and block dispatch on any of:
 *
 * quality_tests (status <> 'cancelled'), classified from the code that writes
 * them — created result 'pending' / status 'open'; a recorded reading sets
 * 'pass' or 'fail' and status 'completed' (quality.routes.js):
 *   FAILED      result 'fail' — any test, mandatory or optional (the rule as it
 *               already stood; whether a failed OPTIONAL test should keep
 *               blocking is an open decision, not changed here)
 *   INCOMPLETE  a MANDATORY test (is_mandatory, default true) still 'pending'
 *               or with no result
 *   UNRESOLVED  a MANDATORY test whose result is anything else — e.g. the five
 *               seed rows whose result is 'SEED result ' and status 'active'.
 *               An unrecognised result is not evidence of a pass, so it is
 *               never treated as one.
 *   (an OPTIONAL test that is pending or unresolved does not block)
 *
 * FAT test runs (test_runs.test_stage = 'FAT', not deleted, status <>
 * 'cancelled') — the same records the project lifecycle gate fat_passed reads.
 * test_runs carries no optional flag, so a FAT run that exists must finish:
 *   FAILED      overall_result 'fail'
 *   INCOMPLETE  overall_result 'in_progress' or 'hold' (hold is not a pass)
 *   OPEN_PUNCH_POINTS  a passed run with punch points not 'closed'/'waived'
 *               (the lifecycle gate's own definition of open), when
 *               fat_punch_point_closure_req is on (default on)
 *   WITNESS_MISSING    a passed run with no customer_witness recorded, when
 *               fat_customer_witness_req is on (default off)
 * The two settings are read exactly as their names state — FAT is complete
 * only with its punch points closed / its customer witness recorded — and only
 * against the FAT runs that carry those fields.
 *
 * NOT checked, deliberately: an order with no tests or no FAT at all passes —
 * which tests a product requires is a QC-plan definition the system does not
 * have. fat_trackers (project FAT log; only seed rows exist) is not read; the
 * lifecycle gates do not read it either.
 *
 * Throws WorkflowError 409 code 'FAT_GATE' with every blocker listed.
 */
export async function assertFinalInspectionGate(client, companyId, salesOrderId) {
  const blockers = await finalInspectionBlockers(client, companyId, salesOrderId);
  if (blockers.length) {
    const err = new WorkflowError(409,
      `Dispatch blocked by quality: ${blockers.map(b => b.message).join(' ')} `
      + 'Resolve them, or disable the final-inspection dispatch gate in Quality Settings.',
      'FAT_GATE');
    err.blockers = blockers;
    throw err;
  }
}

/** The blockers assertFinalInspectionGate would raise, without throwing. */
export async function finalInspectionBlockers(client, companyId, salesOrderId) {
  if (!salesOrderId) return [];
  const { rows: [qs] } = await client.query(
    `SELECT fat_dispatch_gate, fat_punch_point_closure_req, fat_customer_witness_req
       FROM quality_settings WHERE company_id = $1`, [companyId]);
  const gateOn = qs ? qs.fat_dispatch_gate !== false : true;
  // The gate switch governs the record checks below (failed / incomplete /
  // unresolved tests, FAT state, punch points, witness). It does NOT govern
  // explicitly configured requirements further down: an inspection engineering
  // declared mandatory for this order or product is held whatever the switch.
  const punchReq   = qs ? qs.fat_punch_point_closure_req !== false : true;   // column default TRUE
  const witnessReq = qs ? qs.fat_customer_witness_req === true : false;     // column default FALSE

  const blockers = [];
  const { rows: tests } = !gateOn ? { rows: [] } : await client.query(`
    SELECT qt.id, qt.test_name, qt.result, qt.status, qt.is_mandatory, po.id AS production_order_id
      FROM quality_tests qt
      JOIN production_orders po ON po.id = qt.production_order_id
     WHERE po.sales_order_id = $1 AND COALESCE(po.status, '') <> 'cancelled'
       AND ($2::int IS NULL OR po.company_id = $2)
       AND LOWER(COALESCE(qt.status, '')) <> 'cancelled'
     ORDER BY qt.id`, [salesOrderId, companyId]);
  for (const t of tests) {
    const result = String(t.result ?? '').trim().toLowerCase();
    const mandatory = t.is_mandatory !== false;
    let kind = null;
    if (result === 'fail') kind = 'FAILED';
    else if (mandatory && (result === '' || result === 'pending')) kind = 'INCOMPLETE';
    else if (mandatory && result !== 'pass') kind = 'UNRESOLVED';
    if (kind) {
      blockers.push({ source: 'quality_test', id: t.id, production_order_id: t.production_order_id, kind,
        message: `Quality test #${t.id} (${t.test_name || 'unnamed'}) is ${kind.toLowerCase()}${kind === 'UNRESOLVED' ? ` (result '${t.result}')` : ''}.` });
    }
  }

  const { rows: runs } = !gateOn ? { rows: [] } : await client.query(`
    SELECT tr.id, tr.run_number, tr.overall_result, tr.customer_witness, po.id AS production_order_id,
           (SELECT COUNT(*) FROM punch_points p
             WHERE p.test_run_id = tr.id AND LOWER(COALESCE(p.status, '')) NOT IN ('closed', 'waived'))::int AS open_punch
      FROM test_runs tr
      JOIN production_orders po ON po.id = tr.production_order_id
     WHERE po.sales_order_id = $1 AND COALESCE(po.status, '') <> 'cancelled'
       AND ($2::int IS NULL OR po.company_id = $2)
       AND tr.test_stage = 'FAT' AND tr.deleted_at IS NULL
       AND LOWER(COALESCE(tr.status, '')) <> 'cancelled'
     ORDER BY tr.id`, [salesOrderId, companyId]);
  for (const r of runs) {
    const label = `FAT run ${r.run_number || `#${r.id}`}`;
    const add = (kind, message) => blockers.push(
      { source: 'test_run', id: r.id, production_order_id: r.production_order_id, kind, message });
    if (r.overall_result === 'fail') add('FAILED', `${label} failed.`);
    else if (r.overall_result !== 'pass') add('INCOMPLETE', `${label} is ${r.overall_result || 'not finished'}.`);
    else {
      if (punchReq && r.open_punch > 0) add('OPEN_PUNCH_POINTS', `${label} has ${r.open_punch} open punch point(s).`);
      if (witnessReq && !String(r.customer_witness ?? '').trim()) add('WITNESS_MISSING', `${label} has no customer witness recorded.`);
    }
  }

  // Configured requirements (qc_requirements, migration 20261028000002): an
  // inspection engineering said the order or one of its products needs, with
  // no PASSED record to show for it, blocks as REQUIRED_MISSING — absence is
  // never a pass — whether or not the gate switch is on (Phase 3G). With none
  // configured nothing is added here (qc_plan 'not_configured', reported by
  // finalInspectionReadiness).
  for (const r of await qcRequirementStatus(client, companyId, salesOrderId)) {
    if (!r.satisfied) {
      blockers.push({ source: 'qc_requirement', id: r.id, production_order_id: null, kind: 'REQUIRED_MISSING',
        message: `Required ${r.inspection === 'FAT' ? 'FAT' : `quality test${r.test_name ? ` '${r.test_name}'` : ''}`}`
          + `${r.item_id ? ` for item ${r.item_id}` : ''} has no passed record.` });
    }
  }
  return blockers;
}

/**
 * The QC requirements that apply to a sales order — its own, and those of the
 * products on its lines — each with whether a PASSED record meets it: a FAT
 * run (stage FAT, overall_result pass) or a quality test (result pass, the
 * named test when one is named) on a non-cancelled production order of the
 * order; for a product requirement, a production order naming that product.
 */
export async function qcRequirementStatus(client, companyId, salesOrderId) {
  if (!salesOrderId) return [];
  const { rows } = await client.query(`
    SELECT r.id, r.item_id, r.sales_order_id, r.inspection, r.test_name,
           CASE r.inspection
             WHEN 'FAT' THEN EXISTS (
               SELECT 1 FROM test_runs tr JOIN production_orders po ON po.id = tr.production_order_id
                WHERE po.sales_order_id = $2 AND COALESCE(po.status, '') <> 'cancelled' AND po.company_id = r.company_id
                  AND (r.item_id IS NULL OR po.product_id = r.item_id)
                  AND tr.test_stage = 'FAT' AND tr.overall_result = 'pass' AND tr.deleted_at IS NULL
                  AND LOWER(COALESCE(tr.status, '')) <> 'cancelled')
             ELSE EXISTS (
               SELECT 1 FROM quality_tests qt JOIN production_orders po ON po.id = qt.production_order_id
                WHERE po.sales_order_id = $2 AND COALESCE(po.status, '') <> 'cancelled' AND po.company_id = r.company_id
                  AND (r.item_id IS NULL OR po.product_id = r.item_id)
                  AND LOWER(TRIM(COALESCE(qt.result, ''))) = 'pass' AND LOWER(COALESCE(qt.status, '')) <> 'cancelled'
                  AND (r.test_name IS NULL OR LOWER(TRIM(qt.test_name)) = LOWER(TRIM(r.test_name))))
           END AS satisfied
      FROM qc_requirements r
     WHERE r.active AND ($1::int IS NULL OR r.company_id = $1)
       AND (r.sales_order_id = $2
            OR (r.item_id IS NOT NULL AND r.item_id IN (SELECT item_id FROM sales_order_items WHERE order_id = $2)))
     ORDER BY r.id`, [companyId, salesOrderId]);
  return rows;
}

/**
 * What the dispatch gate would say about an order, without dispatching:
 * whether the gate is on, whether any QC requirement is configured for it
 * (qc_plan 'configured' | 'not_configured' — the latter meaning missing
 * inspections are NOT checked, because none are defined), each requirement's
 * state, and every blocker.
 */
export async function finalInspectionReadiness(client, companyId, salesOrderId) {
  const { rows: [qs] } = await client.query(
    `SELECT fat_dispatch_gate FROM quality_settings WHERE company_id = $1`, [companyId]);
  const gateOn = qs ? qs.fat_dispatch_gate !== false : true;
  const requirements = await qcRequirementStatus(client, companyId, salesOrderId);
  const blockers = await finalInspectionBlockers(client, companyId, salesOrderId);
  return { gate_on: gateOn, qc_plan: requirements.length ? 'configured' : 'not_configured',
           requirements, blockers, ready: blockers.length === 0 };
}

/**
 * The next DSP-nnnnnn shipment reference for a company. References are unique
 * per company (migration 20261027000002). The transaction-scoped advisory lock
 * serialises numbering within one company until the caller commits — two
 * simultaneous dispatches used to compute the same MAX + 1 and the second
 * failed on the unique index.
 */
export async function nextDispatchRef(client, companyId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('shipments.dispatch_ref'), COALESCE($1::int, 0))`, [companyId]);
  const { rows: [seq] } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(dispatch_ref, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
       FROM shipments WHERE ($1::int IS NULL OR company_id = $1)`, [companyId]);
  return `DSP-${String(seq.n).padStart(6, '0')}`;
}

/** Units picked on the list, all lines. */
async function pickedUnits(client, plId) {
  const { rows: [r] } = await client.query(
    `SELECT COALESCE(SUM(picked_qty), 0)::float AS q FROM pick_list_lines WHERE pick_list_id = $1`, [plId]);
  return Number(r.q);
}

/**
 * Bring the ledger in line with the pick list. `target` is 'picked' (normal) or
 * 'zero' (cancelled). Returns the postings made: [{ item_id, warehouse_id, delta }],
 * delta > 0 = stock out, < 0 = stock returned.
 */
export async function reconcileStock(client, pl, { target = 'picked', req = null } = {}) {
  const { rows: diffs } = await client.query(`
    WITH picked AS (
      SELECT l.item_id, b.warehouse_id, MAX(l.item_name) AS item_name,
             SUM(COALESCE(l.picked_qty, 0)) AS qty
        FROM pick_list_lines l
        JOIN warehouse_bins b  ON b.id = l.bin_location_id
        JOIN warehouse_zones z ON z.id = b.zone_id
       WHERE l.pick_list_id = $1 AND l.item_id IS NOT NULL
       GROUP BY l.item_id, b.warehouse_id
    ), posted AS (
      SELECT item_id, warehouse_id, SUM(quantity_out - quantity_in) AS qty
        FROM stock_ledger
       WHERE reference_type = 'pick_list' AND reference_id = $1
       GROUP BY item_id, warehouse_id
    )
    SELECT COALESCE(p.item_id, s.item_id) AS item_id,
           COALESCE(p.warehouse_id, s.warehouse_id) AS warehouse_id,
           p.item_name,
           (CASE WHEN $2 THEN 0 ELSE COALESCE(p.qty, 0) END) - COALESCE(s.qty, 0) AS delta
      FROM picked p
      FULL JOIN posted s ON s.item_id = p.item_id AND s.warehouse_id = p.warehouse_id
     WHERE (CASE WHEN $2 THEN 0 ELSE COALESCE(p.qty, 0) END) - COALESCE(s.qty, 0) <> 0
     -- Item order matters: each posting's trigger locks the item row, and order
     -- promising and backorder release lock items in ascending id order. Posting
     -- in that same order means a pick and a promise on the same items can wait
     -- for each other but never deadlock.
     ORDER BY 1, 2`,
    [pl.id, target === 'zero']);

  const postings = [];
  for (const d of diffs) {
    const delta = Number(d.delta);
    const label = d.item_name ?? d.item_id;
    // Stock coming BACK (a correction or a cancellation) re-enters FIFO as a
    // new layer at the cost it left at — the average of what this pick list
    // consumed for the item. It used to carry rate 0, so returned goods sat in
    // stock valued at nothing and the pick's net cost stayed overstated.
    let rate = 0;
    if (delta < 0) {
      const { rows: [c] } = await client.query(
        `SELECT SUM(value) / NULLIF(SUM(qty), 0) AS unit_cost FROM inventory_fifo_consumption
          WHERE reference_type = 'pick_list' AND reference_id = $1 AND item_id = $2`, [pl.id, d.item_id]);
      rate = Number(c?.unit_cost) || 0;
    }
    await postStock(client, {
      itemId: d.item_id,
      warehouseId: d.warehouse_id,
      outQty: delta > 0 ? delta : 0,
      inQty: delta < 0 ? -delta : 0,
      rate,
      txnType: 'dispatch',
      refType: 'pick_list',
      refId: pl.id,
      remarks: target === 'zero'
        ? `Pick List ${pl.id} cancelled: ${label} — ${-delta} returned to stock`
        : delta > 0
          ? `Pick List ${pl.id}: ${label}`
          : `Pick List ${pl.id}: ${label} — pick reduced, ${-delta} returned to stock`,
      createdBy: req?.user?.employee_id ?? null,
      companyId: pl.company_id,
      reasonCode: target === 'zero' ? 'pick_list_cancelled' : null,
    });
    postings.push({ item_id: d.item_id, warehouse_id: d.warehouse_id, delta });
  }
  return postings;
}

/** Move a bin's display contents by the change in a line's picked quantity. */
async function adjustBinContents(client, binId, itemName, binDelta) {
  if (!binId || !binDelta) return;
  const { rows: [bin] } = await client.query('SELECT current_items FROM warehouse_bins WHERE id=$1', [binId]);
  if (!bin) return;
  // current_items is a display list, not the stock of record (the ledger is).
  // It is adjusted the way it always was — existing entries only.
  const binItems = Array.isArray(bin.current_items) ? [...bin.current_items] : [];
  const idx = binItems.findIndex(i => i.item === itemName);
  if (idx < 0) return;
  binItems[idx].qty = Math.max(0, binItems[idx].qty - binDelta);
  if (binItems[idx].qty === 0) binItems.splice(idx, 1);
  await client.query('UPDATE warehouse_bins SET current_items=$1 WHERE id=$2', [JSON.stringify(binItems), binId]);
}

/** PICK: record picked quantities and reconcile the ledger. */
export async function applyPicks(client, pl, lines, req) {
  const st = statusOf(pl);
  if (TERMINAL_OR_SHIPPED.has(st) || st === 'packed') {
    throw new WorkflowError(409, `This pick list is ${pl.status}; its picks can no longer change.`);
  }
  for (const line of lines) {
    const q = Number(line.picked_qty ?? 0);
    if (!Number.isFinite(q) || q < 0) {
      throw new WorkflowError(400, `picked_qty must be a non-negative number (line ${line.line_id}).`);
    }
  }
  for (const line of lines) {
    const pickedQty = Number(line.picked_qty ?? 0);
    const { rows: [current] } = await client.query(
      `SELECT * FROM pick_list_lines WHERE id = $1 AND pick_list_id = $2 FOR UPDATE`, [line.line_id, pl.id]);
    if (!current) throw new WorkflowError(404, `Line ${line.line_id} is not on pick list ${pl.id}.`);

    // A bin named on the request must be one of this company's.
    let binId = current.bin_location_id ?? null;
    if (line.bin_location_id != null && String(line.bin_location_id) !== String(current.bin_location_id ?? '')) {
      const { rows: [bin] } = await client.query(
        `SELECT id FROM warehouse_bins WHERE id = $1 AND company_id = $2`, [line.bin_location_id, pl.company_id]);
      if (!bin) throw new WorkflowError(404, `Bin ${line.bin_location_id} not found.`);
      binId = bin.id;
    }
    await client.query(
      `UPDATE pick_list_lines
          SET picked_qty = $1,
              bin_location_id = $3,
              status = CASE WHEN $1 >= required_qty THEN 'completed' ELSE 'partial' END
        WHERE id = $2`,
      [pickedQty, current.id, binId]);
    await adjustBinContents(client, binId, current.item_name ?? line.item_name,
      pickedQty - (Number(current.picked_qty) || 0));
  }

  const postings = await reconcileStock(client, pl, { target: 'picked', req });

  const { rows: [summary] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status='completed') AS done, COUNT(*) AS total
       FROM pick_list_lines WHERE pick_list_id = $1`, [pl.id]);
  const newStatus = parseInt(summary.done) === parseInt(summary.total) ? 'completed' : 'in-progress';
  await client.query(
    `UPDATE pick_lists SET status = $1${newStatus === 'completed' ? ', completed_at = NOW()' : ''} WHERE id = $2`,
    [newStatus, pl.id]);
  return { summary, postings, status: newStatus };
}

/**
 * CANCEL: return every unit this list still has out, then mark it cancelled —
 * one transaction. Cancelling an already-cancelled list is a no-op (a retry or
 * a concurrent second request returns nothing a second time).
 */
export async function cancelPickList(client, pl, req) {
  const st = statusOf(pl);
  if (st === 'cancelled') return { already_cancelled: true, postings: [], status: 'cancelled' };
  if (st === 'dispatched') {
    throw new WorkflowError(409, 'A dispatched pick list cannot be cancelled; its goods have left. Record a return instead.');
  }
  if (st === 'packed') {
    throw new WorkflowError(409, 'A packed pick list cannot be cancelled: unpack it first, so its packages and serials are put back.',
      'PACKED_NOT_CANCELLABLE');
  }
  const postings = await reconcileStock(client, pl, { target: 'zero', req });
  // The bins get back what the lines had taken (display contents, see above).
  const { rows: lines } = await client.query(
    `SELECT bin_location_id, item_name, picked_qty FROM pick_list_lines WHERE pick_list_id = $1`, [pl.id]);
  for (const l of lines) await adjustBinContents(client, l.bin_location_id, l.item_name, -(Number(l.picked_qty) || 0));
  await client.query(`UPDATE pick_lists SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [pl.id]);
  return { already_cancelled: false, postings, status: 'cancelled' };
}

/**
 * PACK: put picked goods that are not yet in a live package into a new one.
 * Moves no stock.
 *
 * Idempotent: what each pick line still has to pack is its picked quantity
 * less what live (not unpacked) package lines already hold for it. A request
 * with nothing left to pack — a retry, a double click, a second concurrent
 * request (serialised by the pick-list row lock the caller holds) — writes
 * nothing and returns the latest package with already_packed: true. It used to
 * re-pack every picked line on every request, doubling non-serial quantities.
 *
 * Explicit `lines` name the pick line they pack (pick_list_line_id, or the one
 * pick line of that item on the list) and may not exceed what it has left:
 *   PACK_LINE_UNRESOLVED  no single pick line of this list matches
 *   PACK_EXCEEDS_PICKED   more than the pick line has left to pack
 * Package numbers are serialised per company (advisory lock), as shipment
 * references are — two lists packed at once used to draw the same PKG number.
 */
export async function packPickList(client, pl, body, req) {
  const st = statusOf(pl);
  if (!['in-progress', 'completed', 'packed'].includes(st)) {
    throw new WorkflowError(409, `A ${pl.status} pick list cannot be packed.`);
  }
  if (await pickedUnits(client, pl.id) <= 0) throw new WorkflowError(409, 'Nothing has been picked on this list yet.');
  const cid = pl.company_id;
  const { package_type, gross_weight_kg, length_cm, width_cm, height_cm, lines = [], notes } = body || {};

  const { rows: pickLines } = await client.query(`
    SELECT l.id, l.item_id, l.item_name, l.batch_id, l.serial_id, COALESCE(l.picked_qty, 0)::float AS picked,
           COALESCE((SELECT SUM(pkl.quantity) FROM package_lines pkl
                      WHERE pkl.pick_list_line_id = l.id AND NOT pkl.unpacked), 0)::float AS packed
      FROM pick_list_lines l WHERE l.pick_list_id = $1 ORDER BY l.id`, [pl.id]);
  const open = new Map(pickLines.map(l => [l.id, Math.max(0, l.picked - l.packed)]));
  const byId = new Map(pickLines.map(l => [l.id, l]));

  // (pick_list_lines carries the serial, so package_lines.serial_id is real —
  // audit finding 34; see the history in warehouse.routes.js.)
  let contents;
  if (!lines.length) {
    contents = pickLines.filter(l => open.get(l.id) > 1e-9)
      .map(l => ({ pick_list_line_id: l.id, item_id: l.item_id, item_name: l.item_name, batch_id: l.batch_id,
                   serial_id: l.serial_id, quantity: open.get(l.id) }));
  } else {
    const want = new Map();
    contents = lines.map((l) => {
      let pickLine = l.pick_list_line_id != null ? byId.get(Number(l.pick_list_line_id)) : null;
      if (!pickLine && l.pick_list_line_id == null && l.item_id != null) {
        const same = pickLines.filter(p => String(p.item_id) === String(l.item_id));
        if (same.length === 1) pickLine = same[0];
      }
      if (!pickLine) {
        throw new WorkflowError(422, `Pack line (${l.pick_list_line_id != null ? `pick line ${l.pick_list_line_id}` : `item ${l.item_id}`}) does not match one line of this pick list.`,
          'PACK_LINE_UNRESOLVED');
      }
      const qty = l.quantity != null ? Number(l.quantity) : open.get(pickLine.id);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new WorkflowError(422, `Pack quantity for pick line ${pickLine.id} must be positive.`, 'PACK_QUANTITY_INVALID');
      }
      want.set(pickLine.id, (want.get(pickLine.id) || 0) + qty);
      return { ...l, pick_list_line_id: pickLine.id, item_id: l.item_id ?? pickLine.item_id,
               item_name: l.item_name ?? pickLine.item_name, batch_id: l.batch_id ?? pickLine.batch_id,
               serial_id: l.serial_id ?? (l.serial_number ? null : pickLine.serial_id), quantity: qty };
    });
    for (const [id, q] of want) {
      if (q > open.get(id) + 1e-9) {
        throw new WorkflowError(409, `Pick line ${id} has ${open.get(id)} left to pack; ${q} requested.`, 'PACK_EXCEEDS_PICKED');
      }
    }
  }
  if (!contents.length) {
    const { rows: [latest] } = await client.query(
      `SELECT * FROM packages WHERE pick_list_id = $1 AND LOWER(COALESCE(status, '')) <> 'unpacked'
        ORDER BY id DESC LIMIT 1`, [pl.id]);
    if (latest) return { ...latest, already_packed: true };
    throw new WorkflowError(409, 'Everything picked on this list is already packed.', 'NOTHING_TO_PACK');
  }

  await client.query(`SELECT pg_advisory_xact_lock(hashtext('packages.package_no'), COALESCE($1::int, 0))`, [cid]);
  const { rows: [seq] } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(package_no, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
       FROM packages WHERE ($1::int IS NULL OR company_id = $1)`, [cid]);
  const packageNo = `PKG-${String(seq.n).padStart(6, '0')}`;

  const { rows: [pkg] } = await client.query(`
    INSERT INTO packages
      (company_id, package_no, pick_list_id, sales_order_id, package_type, gross_weight_kg,
       length_cm, width_cm, height_cm, status, packed_by, packed_by_name, packed_at, notes)
    VALUES ($1,$2,$3,$4,COALESCE($5,'carton'),$6,$7,$8,$9,'packed',$10,$11,NOW(),$12) RETURNING *`,
    [cid, packageNo, pl.id, pl.sales_order_id, package_type, gross_weight_kg ?? null,
     length_cm ?? null, width_cm ?? null, height_cm ?? null,
     req?.user?.id ?? null, actorName(req), notes ?? null]);

  for (const l of contents) {
    // A caller may name the unit by serial number instead of id. Resolved here
    // rather than trusted, so an unknown serial is a 404 and not a silently
    // unlinked package line.
    let serialId = l.serial_id ?? null;
    if (!serialId && l.serial_number) {
      const { rows: [sn] } = await client.query(
        `SELECT id, item_id FROM serial_numbers
          WHERE serial_number = $1 AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL) LIMIT 1`,
        [l.serial_number, cid]);
      if (!sn) throw new WorkflowError(404, `Serial ${l.serial_number} not found`);
      if (l.item_id && String(sn.item_id) !== String(l.item_id)) {
        throw new WorkflowError(409, `Serial ${l.serial_number} is not a unit of the item on this line`, 'SERIAL_ITEM_MISMATCH');
      }
      serialId = sn.id;
    }
    // What the serial was before this pack overwrites it — locked and read in
    // the same transaction, so unpackPickList can put back exactly this
    // (migration 20261027000004).
    let prior = null;
    if (serialId) {
      ({ rows: [prior] } = await client.query(
        `SELECT status, package_id, customer_id FROM serial_numbers WHERE id = $1 FOR UPDATE`, [serialId]));
      if (!prior) throw new WorkflowError(404, `Serial ${serialId} not found`);
    }
    await client.query(`
      INSERT INTO package_lines
        (package_id, company_id, item_id, item_name, batch_id, serial_id, pick_list_line_id, quantity, uom,
         serial_prior_status, serial_prior_package_id, serial_prior_customer_id, serial_prior_recorded)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [pkg.id, cid, l.item_id ?? null, l.item_name ?? null, l.batch_id ?? null, serialId,
       l.pick_list_line_id ?? null, l.quantity ?? 0, l.uom ?? null,
       prior?.status ?? null, prior?.package_id ?? null, prior?.customer_id ?? null, !!prior]);

    // Close the loop from the unit's own side, so 'shipped' becomes provable
    // rather than a flag somebody set. The customer comes from the sales order
    // the pick list belongs to — the last link of the forward chain.
    if (serialId) {
      await client.query(`
        UPDATE serial_numbers
           SET package_id = $2,
               status = 'packed',
               customer_id = COALESCE(
                 (SELECT so.customer_id FROM sales_orders so WHERE so.id = $3 AND so.company_id = $4), customer_id),
               updated_at = NOW()
         WHERE id = $1`, [serialId, pkg.id, pl.sales_order_id ?? null, cid]);
    }
  }
  await client.query(`UPDATE pick_lists SET status = 'packed' WHERE id = $1`, [pl.id]);
  return pkg;
}

/**
 * UNPACK: undo every pack of a packed list, restoring each packed serial to the
 * exact state packing recorded. Moves no stock — packing moved none.
 *
 * Packages are undone newest first, lines last first: a serial packed twice
 * recorded the first package as its prior state on the second line, so undoing
 * in reverse walks it back through each state to the original.
 *
 * Refused, with nothing written, when the exact prior state cannot be restored:
 *   PACKAGE_SHIPPED       a package is on a shipment (the list would not be
 *                         'packed'; checked anyway)
 *   PACKAGE_ON_UNIT_LOAD  a package is on a unit load — there is no step that
 *                         takes it off again
 *   PACK_STATE_UNRECORDED a serial line packed before its prior state was
 *                         recorded (lines older than migration 20261027000004)
 *   SERIAL_STATE_CHANGED  a serial is no longer the 'packed' unit of that
 *                         package — something else has moved it since
 *
 * Packages and their lines are kept as history: status 'unpacked', with who
 * and when. The list goes back to 'completed' or 'in-progress' by its lines,
 * the same rule applyPicks uses, and can then be re-picked, re-packed or
 * cancelled.
 */
export async function unpackPickList(client, pl, req) {
  if (statusOf(pl) !== 'packed') {
    throw new WorkflowError(409, `Only a packed pick list can be unpacked; this one is ${pl.status}.`, 'NOT_PACKED');
  }
  const { rows: pkgs } = await client.query(
    `SELECT id, package_no, status, shipment_id, unit_load_id FROM packages
      WHERE pick_list_id = $1 AND LOWER(COALESCE(status, '')) <> 'unpacked'
      ORDER BY id DESC FOR UPDATE`, [pl.id]);
  const shipped = pkgs.filter(p => p.shipment_id != null || String(p.status).toLowerCase() === 'shipped');
  if (shipped.length) {
    throw new WorkflowError(409, `Package(s) ${shipped.map(p => p.package_no).join(', ')} have shipped and cannot be unpacked.`,
      'PACKAGE_SHIPPED');
  }
  const onLoad = pkgs.filter(p => p.unit_load_id != null);
  if (onLoad.length) {
    throw new WorkflowError(409, `Package(s) ${onLoad.map(p => p.package_no).join(', ')} are on a unit load; there is no step to take them off, so they cannot be unpacked.`,
      'PACKAGE_ON_UNIT_LOAD');
  }

  const pkgIds = pkgs.map(p => p.id);
  const { rows: lines } = pkgIds.length ? await client.query(
    `SELECT id, package_id, serial_id, serial_prior_status, serial_prior_package_id,
            serial_prior_customer_id, serial_prior_recorded
       FROM package_lines WHERE package_id = ANY($1::int[]) AND serial_id IS NOT NULL
      ORDER BY package_id DESC, id DESC`, [pkgIds]) : { rows: [] };
  const unrecorded = lines.filter(l => !l.serial_prior_recorded);
  if (unrecorded.length) {
    throw new WorkflowError(409, `${unrecorded.length} serial line(s) were packed before their prior state was recorded; they cannot be restored exactly, so this list cannot be unpacked automatically.`,
      'PACK_STATE_UNRECORDED');
  }

  // Lock the serials (in id order) and walk them back in memory first; write
  // only once every step has been checked against what packing left behind.
  const serialIds = [...new Set(lines.map(l => l.serial_id))].sort((a, b) => a - b);
  const state = new Map();
  for (const sid of serialIds) {
    const { rows: [s] } = await client.query(
      `SELECT id, serial_number, status, package_id, customer_id FROM serial_numbers WHERE id = $1 FOR UPDATE`, [sid]);
    if (!s) throw new WorkflowError(409, `Serial ${sid} no longer exists.`, 'SERIAL_STATE_CHANGED');
    state.set(sid, s);
  }
  for (const l of lines) {
    const s = state.get(l.serial_id);
    if (String(s.status ?? '').toLowerCase() !== 'packed' || Number(s.package_id) !== Number(l.package_id)) {
      throw new WorkflowError(409, `Serial ${s.serial_number ?? l.serial_id} is no longer the packed unit of its package (now '${s.status}'); it has moved since packing.`,
        'SERIAL_STATE_CHANGED');
    }
    state.set(l.serial_id, { ...s, status: l.serial_prior_status, package_id: l.serial_prior_package_id,
                             customer_id: l.serial_prior_customer_id });
  }
  for (const [sid, s] of state) {
    await client.query(
      `UPDATE serial_numbers SET status = $2, package_id = $3, customer_id = $4, updated_at = NOW() WHERE id = $1`,
      [sid, s.status, s.package_id, s.customer_id]);
  }

  if (pkgIds.length) {
    await client.query(
      `UPDATE packages SET status = 'unpacked', unpacked_at = NOW(), unpacked_by = $2, unpacked_by_name = $3
        WHERE id = ANY($1::int[])`, [pkgIds, req?.user?.id ?? null, actorName(req)]);
    // The lines stay as history but no longer hold their serials, so a serial
    // can be packed again (uq_package_lines_serial_live, migration 20261027000006).
    await client.query(`UPDATE package_lines SET unpacked = true WHERE package_id = ANY($1::int[])`, [pkgIds]);
  }
  const { rows: [summary] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status='completed') AS done, COUNT(*) AS total
       FROM pick_list_lines WHERE pick_list_id = $1`, [pl.id]);
  const newStatus = parseInt(summary.done) === parseInt(summary.total) ? 'completed' : 'in-progress';
  await client.query(`UPDATE pick_lists SET status = $1, updated_at = NOW() WHERE id = $2`, [newStatus, pl.id]);
  return { status: newStatus, packages_unpacked: pkgIds.length, serials_restored: state.size };
}

/**
 * DISPATCH: create the shipment, carry the packages onto it and move the order
 * forward, behind the final-inspection gate. Moves no stock.
 */
export async function dispatchPickList(client, pl, body, req) {
  const st = statusOf(pl);
  if (st === 'dispatched') throw new WorkflowError(409, 'This pick list has already been dispatched.');
  if (!['in-progress', 'completed', 'packed'].includes(st)) {
    throw new WorkflowError(409, `A ${pl.status} pick list cannot be dispatched.`);
  }
  if (await pickedUnits(client, pl.id) <= 0) throw new WorkflowError(409, 'Nothing has been picked on this list yet.');
  const cid = pl.company_id;
  const { courier, carrier_id, tracking_number, weight_kg, expected_delivery, freight_cost,
          from_address, to_address, notes } = body || {};

  await assertFinalInspectionGate(client, cid, pl.sales_order_id);
  // Said plainly in the response: with no QC requirement configured, missing
  // inspections were not checked (none are defined), not found to be done.
  const qcPlan = (await qcRequirementStatus(client, cid, pl.sales_order_id)).length ? 'configured' : 'not_configured';
  const dispatchRef = await nextDispatchRef(client, cid);

  const { rows: pkgs } = await client.query(
    `SELECT id, gross_weight_kg FROM packages
      WHERE pick_list_id = $1 AND LOWER(COALESCE(status, '')) <> 'unpacked'`, [pl.id]);
  const packedWeight = pkgs.reduce((s, p) => s + parseFloat(p.gross_weight_kg || 0), 0);
  const totalWeight = weight_kg ?? (packedWeight > 0 ? packedWeight : null);

  const { rows: [so] } = await client.query(
    `SELECT customer_name, promised_date, delivery_date FROM sales_orders WHERE id = $1 AND company_id = $2`,
    [pl.sales_order_id, cid]);

  const { rows: [shipment] } = await client.query(`
    INSERT INTO shipments
      (company_id, reference_type, reference_id, sales_order_id, pick_list_id, carrier_id,
       courier_partner, tracking_number, dispatch_ref, package_count, status, direction,
       dispatch_date, expected_delivery, promised_date, weight_kg, freight_cost,
       from_address, to_address, notes, dispatched_by, dispatched_by_name)
    VALUES ($1,'sales_order',$2,$2,$3,$4,$5,$6,$7,$8,'in_transit','outbound',
            CURRENT_DATE,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [cid, pl.sales_order_id, pl.id, carrier_id ?? null, courier ?? null, tracking_number ?? null,
     dispatchRef, pkgs.length, expected_delivery || null,
     so?.promised_date || so?.delivery_date || null, totalWeight, freight_cost ?? null,
     from_address ?? null, to_address ?? null, notes ?? null,
     req?.user?.id ?? null, actorName(req)]);

  await client.query(`UPDATE packages SET shipment_id = $2, status = 'shipped'
                       WHERE pick_list_id = $1 AND LOWER(COALESCE(status, '')) <> 'unpacked'`,
    [pl.id, shipment.id]);
  await client.query(`UPDATE pick_lists SET status = 'dispatched', completed_at = NOW() WHERE id = $1`, [pl.id]);
  if (pl.sales_order_id) {
    await client.query(
      `UPDATE sales_orders SET order_status = 'dispatched', dispatched_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND company_id = $2
          AND LOWER(COALESCE(order_status,'')) NOT IN ('delivered','completed','cancelled')`,
      [pl.sales_order_id, cid]);
  }
  return { dispatch_ref: dispatchRef, shipment, packages: pkgs.length, qc_plan: qcPlan };
}

/**
 * READ-ONLY diagnostic: does the ledger agree with each pick list?
 *
 * Before the reconciling pick (2026-10-22) the pick route posted the full
 * picked quantity on every call, and cancelling a list returned nothing, so a
 * list may carry more stock-out than it ever picked. This compares, per pick
 * list, item and warehouse:
 *
 *   picked_qty    the lines' final picked quantity (lines for the same item and
 *                 warehouse are summed once, never double-counted)
 *   expected_out  picked_qty, or 0 for a cancelled list
 *   posted_out    the net the ledger attributes to the list:
 *                 SUM(quantity_out - quantity_in), reference_type 'pick_list'
 *   difference    posted_out - expected_out (> 0: more left the shelf than
 *                 the list accounts for)
 *
 * and classifies each row:
 *   ok                      difference 0
 *   over_posted             more out than picked, on an open or shipped list
 *   under_posted            less out than picked
 *   cancelled_not_restored  a cancelled list still has stock out
 *   ambiguous               the comparison cannot be trusted — a picked line
 *                           with no resolvable warehouse, a ledger row with no
 *                           warehouse or of an unexpected type, or ledger rows
 *                           for an item the list does not carry
 *
 * It writes nothing: it runs in a READ ONLY transaction, so even a mistake here
 * could not change stock. Remediation is a separate, approved step.
 */
export async function diagnosePickListPostings(pool, companyId, { includeOk = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await client.query(`
      WITH lists AS (
        SELECT id, status, company_id FROM pick_lists
         WHERE ($1::int IS NULL OR company_id = $1)
      ), line_wh AS (
        SELECT l.pick_list_id, l.item_id, b.warehouse_id,
               COALESCE(l.picked_qty, 0) AS picked_qty,
               (b.id IS NULL OR z.id IS NULL) AS unresolved
          FROM pick_list_lines l
          JOIN lists ON lists.id = l.pick_list_id
          LEFT JOIN warehouse_bins b  ON b.id = l.bin_location_id
          LEFT JOIN warehouse_zones z ON z.id = b.zone_id
         WHERE l.item_id IS NOT NULL
      ), picked AS (
        SELECT pick_list_id, item_id, warehouse_id,
               SUM(CASE WHEN unresolved THEN 0 ELSE picked_qty END) AS picked_qty,
               BOOL_OR(unresolved AND picked_qty > 0)              AS unresolved_pick
          FROM line_wh GROUP BY 1, 2, 3
      ), posted AS (
        SELECT sl.reference_id AS pick_list_id, sl.item_id, sl.warehouse_id,
               SUM(sl.quantity_out - sl.quantity_in) AS posted_out,
               COUNT(*)                              AS ledger_rows,
               COUNT(*) FILTER (WHERE sl.quantity_in > 0) AS return_rows,
               BOOL_OR(LOWER(COALESCE(sl.transaction_type,'')) <> 'dispatch') AS odd_type,
               BOOL_OR(sl.warehouse_id IS NULL)       AS no_warehouse,
               BOOL_OR(sl.company_id IS DISTINCT FROM lists.company_id) AS company_mismatch
          FROM stock_ledger sl
          JOIN lists ON lists.id = sl.reference_id
         WHERE sl.reference_type = 'pick_list'
         GROUP BY 1, 2, 3
      )
      SELECT lists.id AS pick_list_id, lists.status,
             COALESCE(p.item_id, s.item_id)           AS item_id,
             COALESCE(p.warehouse_id, s.warehouse_id) AS warehouse_id,
             COALESCE(p.picked_qty, 0)::float          AS picked_qty,
             (CASE WHEN LOWER(lists.status) = 'cancelled' THEN 0 ELSE COALESCE(p.picked_qty, 0) END)::float AS expected_out,
             COALESCE(s.posted_out, 0)::float          AS posted_out,
             COALESCE(s.ledger_rows, 0)::int           AS ledger_rows,
             COALESCE(s.return_rows, 0)::int           AS return_rows,
             COALESCE(p.unresolved_pick, false)        AS unresolved_pick,
             COALESCE(s.odd_type, false)               AS odd_type,
             COALESCE(s.no_warehouse, false)           AS no_warehouse,
             COALESCE(s.company_mismatch, false)       AS company_mismatch,
             (p.item_id IS NULL)                       AS item_not_on_list
        FROM picked p
        FULL JOIN posted s
          ON s.pick_list_id = p.pick_list_id AND s.item_id = p.item_id
         AND s.warehouse_id IS NOT DISTINCT FROM p.warehouse_id
        JOIN lists ON lists.id = COALESCE(p.pick_list_id, s.pick_list_id)
       ORDER BY 1, 3, 4`, [companyId]);
    await client.query('COMMIT');

    const out = [];
    const summary = { ok: 0, over_posted: 0, under_posted: 0, cancelled_not_restored: 0, ambiguous: 0 };
    for (const r of rows) {
      const difference = Math.round((r.posted_out - r.expected_out) * 10000) / 10000;
      const reasons = [];
      if (r.unresolved_pick)  reasons.push('a picked line has no resolvable bin/warehouse');
      if (r.odd_type)         reasons.push("ledger rows of a type other than 'dispatch'");
      if (r.no_warehouse)     reasons.push('ledger rows with no warehouse');
      if (r.company_mismatch) reasons.push("ledger rows of another company reference this list");
      if (r.item_not_on_list && r.ledger_rows > 0) reasons.push('ledger rows with no picked line for that item and warehouse');
      let classification;
      if (reasons.length) classification = 'ambiguous';
      else if (difference === 0) classification = 'ok';
      else if (String(r.status).toLowerCase() === 'cancelled' && r.posted_out > 0) classification = 'cancelled_not_restored';
      else classification = difference > 0 ? 'over_posted' : 'under_posted';
      summary[classification]++;
      if (classification !== 'ok' || includeOk) {
        out.push({ ...r, difference, classification, reasons,
                   has_prior_corrections: r.return_rows > 0 });
      }
    }
    return { summary, rows: out, read_only: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * What the goods this pick list sent out ACTUALLY cost, per item — the cost a
 * COGS journal for invoicing them must use (no estimate, no standard cost).
 *
 *   out      FIFO consumption recorded against the pick list
 *            (inventory_fifo_consumption reference 'pick_list')
 *   returned FIFO layers re-created by its corrections / cancellation
 *            (inventory_fifo_layers source 'pick_list'), valued at their cost
 *   net      out - returned, which must equal the ledger's net quantity for the
 *            list; the unit cost is net value / net quantity.
 *
 * `verified` is false when the FIFO trail does not account for the whole net
 * quantity — stock that predates cost layering leaves an issue "uncovered" —
 * and then no unit cost is offered: the caller must refuse rather than guess.
 */
export async function fulfilmentCost(client, pickListId, itemId) {
  const { rows: [r] } = await client.query(`
    SELECT
      (SELECT COALESCE(SUM(quantity_out - quantity_in), 0) FROM stock_ledger
        WHERE reference_type = 'pick_list' AND reference_id = $1 AND item_id = $2)::float AS ledger_net_qty,
      (SELECT COALESCE(SUM(qty), 0) FROM inventory_fifo_consumption
        WHERE reference_type = 'pick_list' AND reference_id = $1 AND item_id = $2)::float AS out_qty,
      (SELECT COALESCE(SUM(value), 0) FROM inventory_fifo_consumption
        WHERE reference_type = 'pick_list' AND reference_id = $1 AND item_id = $2)::float AS out_value,
      (SELECT COALESCE(SUM(qty_received), 0) FROM inventory_fifo_layers
        WHERE source_type = 'pick_list' AND source_id = $1 AND item_id = $2)::float AS back_qty,
      (SELECT COALESCE(SUM(qty_received * unit_cost), 0) FROM inventory_fifo_layers
        WHERE source_type = 'pick_list' AND source_id = $1 AND item_id = $2)::float AS back_value`,
    [pickListId, itemId]);
  const netQty = r.out_qty - r.back_qty;
  const netValue = r.out_value - r.back_value;
  const verified = r.ledger_net_qty > 0 && Math.abs(netQty - r.ledger_net_qty) < 1e-6;
  return {
    ledger_net_qty: r.ledger_net_qty, costed_qty: netQty, net_value: netValue, verified,
    unit_cost: verified ? Math.round((netValue / netQty) * 10000) / 10000 : null,
  };
}

/**
 * What a customer may return INTO STOCK for one item of a sales order, and at
 * what cost — read from the stock movements themselves, never from the RMA.
 *
 *   shipped_qty   net units that left stock for the order through its
 *                 DISPATCHED pick lists (the only dispatch path that moves
 *                 stock — a sales-order-level dispatch moves none, so goods it
 *                 shipped never left the ledger and cannot come back into it)
 *   restocked_qty units already put back by earlier customer returns of the
 *                 order (stock_ledger, reference_type 'sales_return')
 *   returnable    shipped_qty − restocked_qty
 *   unit_cost     the FIFO cost those units left at (fulfilmentCost per list,
 *                 weighted) — null, with verified false, if any list's cost
 *                 does not reconcile with its ledger
 *   warehouse_ids where they left from
 *
 * The caller must hold the sales order row lock, so two receipts against one
 * order cannot both see the same returnable quantity.
 */
export async function returnableFromFulfilment(client, companyId, salesOrderId, itemId) {
  const { rows: lists } = await client.query(
    `SELECT id FROM pick_lists
      WHERE sales_order_id = $1 AND ($2::int IS NULL OR company_id = $2) AND LOWER(status) = 'dispatched'
      ORDER BY id`, [salesOrderId, companyId]);
  let qty = 0, value = 0, verified = true;
  for (const { id } of lists) {
    const fc = await fulfilmentCost(client, id, itemId);
    if (fc.ledger_net_qty === 0 && fc.costed_qty === 0) continue;   // item not on this list
    if (!fc.verified) { verified = false; continue; }
    qty += fc.costed_qty; value += fc.net_value;
  }
  const ids = lists.map(l => l.id);
  const { rows: wh } = ids.length ? await client.query(
    `SELECT DISTINCT warehouse_id FROM stock_ledger
      WHERE reference_type = 'pick_list' AND reference_id = ANY($1::int[]) AND item_id = $2
        AND quantity_out > 0 AND warehouse_id IS NOT NULL ORDER BY warehouse_id`, [ids, itemId]) : { rows: [] };
  const { rows: [back] } = await client.query(
    `SELECT COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::float AS q
       FROM stock_ledger sl
       JOIN sales_returns r ON r.id = sl.reference_id
      WHERE sl.reference_type = 'sales_return' AND sl.item_id = $3
        AND r.sales_order_id = $1 AND ($2::int IS NULL OR r.company_id = $2)`,
    [salesOrderId, companyId, itemId]);
  const restocked = Number(back.q);
  return {
    shipped_qty: qty, restocked_qty: restocked, returnable: Math.max(0, qty - restocked), verified,
    unit_cost: verified && qty > 0 ? Math.round((value / qty) * 10000) / 10000 : null,
    warehouse_ids: wh.map(w => w.warehouse_id),
  };
}
