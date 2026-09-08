import pool from '../../shared/db.js';
import grnRepo from '../repositories/grn.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import advancedInventoryRepo from '../../inventory/repositories/advancedInventory.repository.js';
import { logAudit } from '../../../services/AuditService.js';
import { postStock } from '../../production/subcontracting.routes.js';
import { nextRtvNumber } from '../../../shared/docNumber.js';

/**
 * The PO statuses a receipt may be booked against.
 *
 * Receiving had NO status check at all: goods could be booked against a draft
 * order nobody had approved, or against one that had been cancelled — the
 * cancellation being exactly the instruction not to accept the delivery. Both
 * then incremented received_quantity, created inventory and (via the 3-way
 * match) became payable. A draft PO is not a commitment and a cancelled one is a
 * withdrawn commitment; neither can be received.
 *
 * 'sent' and 'approved' are live orders; 'partial' is a live order already part
 * received. 'received' is absent deliberately — a fully received order is
 * completed, and a further receipt against it is an over-receipt that
 * assertWithinTolerance would reject anyway; failing here says why.
 */
export const RECEIVABLE_PO_STATUSES = new Set(['approved', 'sent', 'partial']);

/** GRN lifecycle, matching GoodsReceipt.jsx's tabs — see migration 20260903000011. */
export const GRN_INITIAL_STATUS = 'pending';

const bad = (message, status) => Object.assign(new Error(message), { status });

class GRNService {
  /**
   * Reject a receipt that books more than the order allows.
   *
   * `procurement_settings.grn_qty_tolerance_pct` (default 5) existed, was
   * editable in the Settings screen and persisted correctly — and no code path
   * had ever read it. Nothing capped receipt quantity server-side at all: a
   * probe booked 500 units against a PO line for 2 and got a 201, leaving that
   * line reading 502 received of 2 ordered, with inventory batches created for
   * the lot. Receiving goods that were never ordered is the classic procurement
   * fraud path and the reason the tolerance setting exists, so this enforces it
   * where it cannot be bypassed by calling the API directly.
   *
   * The check is cumulative — it counts what previous GRNs already booked, not
   * just this request — because otherwise the same over-receipt is reachable by
   * splitting it across several receipts.
   *
   * SELECT ... FOR UPDATE, not a plain read. Without the lock this was a
   * textbook time-of-check/time-of-use race: two concurrent receipts for the
   * same PO line each read received_quantity = 0, each computed that the full
   * ordered quantity still fit inside the tolerance, and both committed — the
   * line ending at twice what was ordered with the check having passed for both.
   * A double-clicked Save is enough to reach it. The lock serialises them, so
   * the second transaction reads what the first actually booked and is refused.
   */
  async assertWithinTolerance(client, poId, items, tolerancePct) {
    const tol = Number.isFinite(parseFloat(tolerancePct)) ? parseFloat(tolerancePct) : 5;
    const { rows } = await client.query(
      `SELECT id, item_id, COALESCE(quantity, 0) AS quantity,
              COALESCE(received_quantity, 0) AS received_quantity
         FROM purchase_order_items WHERE po_id = $1
         ORDER BY id
         FOR UPDATE`,
      [poId]
    );
    const byId = new Map(rows.map(r => [String(r.id), r]));

    // Two lines of one request pointing at the same PO line would each be
    // measured against the same `already`, so together they could exceed the
    // tolerance while both passed. Accumulate within the request as well.
    const incomingByLine = new Map();

    for (const item of items) {
      const line = byId.get(String(item.po_item_id));
      // A line that is not on this PO is never receivable against it.
      if (!line) {
        throw bad(`Line item ${item.po_item_id} does not belong to purchase order ${poId}.`, 400);
      }
      // The item being received must be the item that was ordered. Without this
      // a caller could book any component in the master against a legitimate
      // PO line's quantity and price — inventory for goods nobody ordered,
      // costed at the ordered rate.
      if (item.item_id != null && line.item_id != null &&
          String(item.item_id) !== String(line.item_id)) {
        throw bad(
          `Line ${item.po_item_id} on this purchase order is for component ${line.item_id}, ` +
          `but the receipt books component ${item.item_id}.`, 400
        );
      }
      const ordered  = parseFloat(line.quantity) || 0;
      const already  = parseFloat(line.received_quantity) || 0;
      const incoming = parseFloat(item.quantity_received) || 0;
      if (!Number.isFinite(incoming)) {
        throw bad(`Received quantity on line ${item.po_item_id} is not a number.`, 400);
      }
      if (incoming < 0) {
        throw bad('Received quantity cannot be negative.', 400);
      }
      const runningIn = (incomingByLine.get(String(item.po_item_id)) || 0) + incoming;
      incomingByLine.set(String(item.po_item_id), runningIn);

      const allowed = ordered * (1 + tol / 100);
      if (ordered > 0 && already + runningIn > allowed + 1e-9) {
        throw bad(
          `Over-receipt on line ${item.po_item_id}: ${already + runningIn} would exceed the ` +
          `${ordered} ordered plus the ${tol}% tolerance (max ${Number(allowed.toFixed(2))}). ` +
          `Raise the tolerance in Procurement Settings or amend the purchase order.`, 422
        );
      }
      const rejected = parseFloat(item.quantity_rejected) || 0;
      if (rejected < 0 || rejected > incoming) {
        throw bad(`Rejected quantity on line ${item.po_item_id} cannot exceed the quantity received.`, 400);
      }
      if (item.rate != null && parseFloat(item.rate) < 0) {
        throw bad(`Rate on line ${item.po_item_id} cannot be negative.`, 400);
      }
    }

    if (!items.some(i => (parseFloat(i.quantity_received) || 0) > 0)) {
      throw bad('A goods receipt must book a quantity on at least one line.', 400);
    }
  }

  async createGRN(data, userId) {
    // ── Idempotency ──────────────────────────────────────────────────────────
    // Checked before any work, and again inside the transaction via the unique
    // index, so a retried POST returns the receipt it already created instead of
    // booking the goods a second time. The key is the caller's; absent one, the
    // cumulative tolerance check above is what stops a duplicate receipt (the
    // second submission would push the line past the ordered quantity).
    const idemKey = String(data.idempotency_key || '').trim() || null;
    if (idemKey) {
      const { rows } = await pool.query(
        `SELECT id FROM goods_receipt_notes
          WHERE idempotency_key = $1 AND company_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
        [idemKey, data.company_id ?? null]
      );
      if (rows[0]) {
        const existing = await this.getGRNById(rows[0].id, data.company_id ?? null);
        return { ...existing, idempotent_replay: true };
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the ORDER, not just its lines: this serialises every receipt
      // against one PO, so the status recomputation at the end cannot race
      // another receipt that is also deciding whether the order is complete.
      const { rows: [poLock] } = await client.query(
        `SELECT id, status, order_date, supplier_id, company_id
           FROM purchase_orders
          WHERE id = $1 AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2)
          FOR UPDATE`,
        [data.po_id, data.company_id ?? null]
      );
      if (!poLock) throw bad('Purchase order not found.', 404);

      const po = await poRepo.findById(data.po_id, data.company_id ?? null, client);

      if (!RECEIVABLE_PO_STATUSES.has(String(poLock.status))) {
        throw bad(
          `Purchase order ${po?.po_number ?? data.po_id} is '${poLock.status}' and cannot be received against. ` +
          `Goods may only be booked against an approved, sent or partially received order.`,
          422
        );
      }

      if (!Array.isArray(data.items) || !data.items.length) {
        throw bad('At least one line item is required.', 400);
      }

      // ── Receipt date ────────────────────────────────────────────────────────
      // A receipt dated in the future books stock the business does not have
      // yet, and one dated before the order was raised cannot be a receipt
      // against it. Both were accepted; both distort ageing, the on-time
      // delivery metric and every period report the row falls into.
      const received = data.received_date ? new Date(data.received_date) : new Date();
      if (Number.isNaN(received.getTime())) throw bad('Received date is not a valid date.', 400);
      const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
      if (received > endOfToday) throw bad('A goods receipt cannot be dated in the future.', 400);
      if (poLock.order_date && received < new Date(poLock.order_date)) {
        throw bad(
          `A receipt cannot be dated ${received.toISOString().slice(0, 10)}, before its purchase order was raised on ${new Date(poLock.order_date).toISOString().slice(0, 10)}.`,
          400
        );
      }

      const { rows: [procSettings] } = await client.query(
        'SELECT grn_qty_tolerance_pct FROM procurement_settings WHERE company_id = $1',
        [data.company_id ?? null]
      );
      await this.assertWithinTolerance(
        client, data.po_id, data.items, procSettings?.grn_qty_tolerance_pct ?? 5
      );

      // quality_settings.require_iqc_before_stock (default true — matches the
      // column's own DB default and quality.routes.js's GET /settings fallback)
      // decides whether accepted stock is usable immediately or held until
      // Quality clears it via the quality_tests flow.
      const { rows: [settings] } = await client.query(
        'SELECT require_iqc_before_stock FROM quality_settings WHERE company_id=$1',
        [data.company_id ?? null]
      );
      const holdForIqc = settings ? settings.require_iqc_before_stock !== false : true;

      // A receipt that will post stock needs somewhere to post it to. The column
      // is nullable, so a GRN saved without a warehouse used to create batches
      // against warehouse NULL — invisible to every warehouse-scoped stock view.
      if (!holdForIqc && !data.warehouse_id) {
        throw bad('A receiving warehouse is required — accepted goods have to be booked into a location.', 400);
      }

      const grnNumber = await grnRepo.getNextNumber(client, data.company_id ?? null);
      const grn = await grnRepo.create(client, {
        ...data,
        received_date: received.toISOString().slice(0, 10),
        company_id: data.company_id,
        grn_number: grnNumber,
        // Explicit, never the column default. 'draft' — what the default was —
        // is a status GoodsReceipt.jsx does not count, filter or offer an action
        // on, so every receipt the app raised was invisible to its own KPI strip
        // and could not be confirmed. See migration 20260903000011.
        status: GRN_INITIAL_STATUS,
        quality_status: holdForIqc ? 'pending' : 'not_required',
        idempotency_key: idemKey,
      });

      for (const item of data.items) {
        const acceptedQty = Math.max(0,
          (item.quantity_received || 0) - (item.quantity_rejected || 0)
        );

        await grnRepo.createItem(client, {
          grn_id: grn.id,
          ...item
        });

        // Update PO item received quantity (only accepted goods count toward fulfillment)
        await poRepo.updateItemReceived(client, item.po_item_id, acceptedQty);

        // ── Inventory ─────────────────────────────────────────────────────────
        // The batch and the stock-ledger entry are created TOGETHER, on the
        // transaction's own client, or not at all.
        //
        // Previously the batch was created unconditionally (and on the shared
        // pool — see advancedInventory.repository.createBatch) while the ledger
        // entry was skipped whenever IQC was pending. That gave the two records
        // different lifetimes and different truths: a rolled-back receipt left
        // its batch behind as available stock, and a receipt held for inspection
        // still had a batch with quantity_available equal to the full accepted
        // quantity — which is what allocation, valuation and the batch stock
        // view all read. The IQC "hold" held nothing. Live proof of both: four
        // batches pointing at goods_receipt_notes that do not exist, and zero
        // rows in stock_ledger with reference_type 'grn' against six batches
        // that did.
        //
        // A batch IS usable stock. It comes into existence when the stock does —
        // here when no inspection is required, or in releaseGrnStock() once IQC
        // passes.
        if (acceptedQty > 0 && !holdForIqc) {
          await this.postAcceptedStock(client, {
            grn, grnNumber, item, acceptedQty,
            warehouseId: data.warehouse_id,
            supplierId: po?.supplier_id ?? null,
            receivedDate: received.toISOString().slice(0, 10),
            companyId: data.company_id,
            createdBy: userId,
          });
        }
      }

      // Is the order complete? Read on the TRANSACTION's client — a pool read
      // here runs on another connection and cannot see the received_quantity
      // updates this transaction just made, so it always answered with the
      // pre-receipt figures and the order was left 'partial' even when the
      // receipt completed it.
      const poItems = await poRepo.getItems(data.po_id, data.company_id ?? null, client);
      const allReceived = poItems.length > 0 && poItems.every(item =>
        parseFloat(item.received_quantity) >= parseFloat(item.quantity)
      );

      await poRepo.updateStatus(client, data.po_id, allReceived ? 'received' : 'partial', data.company_id ?? null);

      await client.query('COMMIT');

      // Audit log after commit. This call used a parameter shape
      // (entity_type/entity_id/description/user_id) that never matched
      // AuditService.logAudit's real signature (module/recordId/recordType/
      // userId) — module was always undefined, which violates audit_logs'
      // NOT NULL on module_name, so this threw on every single GRN (caught
      // by the try/catch below, so GRN creation itself never failed, but no
      // audit row was ever written). userId here is this function's own
      // `userId` param, which the route populates with an employees.id
      // (stock_ledger.created_by needs one) — not the users.id logAudit's
      // userId field expects. The route now threads the real actor's users.id
      // in as `actorUserId` so the audit row names a person.
      try {
        logAudit({
          company_id: data.company_id,
          userId: data.actor_user_id ?? null,
          module: 'procurement',
          recordId: grn.id,
          recordType: 'grn',
          action: 'create',
          newData: grn,
        });
      } catch (_) { /* audit failure must not break the transaction */ }

      return await grnRepo.findById(grn.id, data.company_id ?? null);
    } catch (error) {
      await client.query('ROLLBACK');
      // A retry that lost the race against its own duplicate lands on the
      // idempotency index. Return the winner rather than a 500.
      if (error.code === '23505' && String(error.constraint || '').includes('idempotency')) {
        const { rows } = await pool.query(
          `SELECT id FROM goods_receipt_notes
            WHERE idempotency_key = $1 AND company_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
          [idemKey, data.company_id ?? null]
        );
        if (rows[0]) {
          const existing = await this.getGRNById(rows[0].id, data.company_id ?? null);
          return { ...existing, idempotent_replay: true };
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Book one accepted line into stock: the batch and the ledger entry, together.
   * Extracted so the immediate path and the post-IQC release path cannot drift.
   */
  async postAcceptedStock(client, {
    grn, grnNumber, item, acceptedQty, warehouseId, supplierId,
    receivedDate, companyId, createdBy, releasedAfterIqc = false,
  }) {
    const itemIdStr = String(item.item_id);
    await advancedInventoryRepo.createBatch({
      item_id: item.item_id,
      warehouse_id: warehouseId,
      batch_number: item.batch_number || `GRN-${grnNumber}-${itemIdStr.substring(0, 4)}`,
      received_date: receivedDate,
      expiry_date: item.expiry_date || null,
      supplier_id: supplierId,
      grn_id: grn.id,
      quantity_received: acceptedQty,
      rate: item.rate,
    }, client);   // <-- the transaction client, not the pool

    // Uses the shared postStock() helper (also updates
    // inventory_items.current_stock and fires reorder-breach detection)
    // instead of a separate stock-ledger-write implementation.
    await postStock(client, {
      itemId: item.item_id,
      warehouseId,
      inQty: acceptedQty,
      outQty: 0,
      txnType: 'purchase',
      refType: 'grn',
      refId: grn.id,
      remarks: `GRN ${grnNumber}`
        + (item.quantity_rejected > 0 ? ` (${item.quantity_rejected} rejected)` : '')
        + (releasedAfterIqc ? ' (released after IQC pass)' : ''),
      rate: item.rate,
      createdBy,
      companyId,
      transactionDate: receivedDate,
    });
  }

  async createRTV(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── Scope and provenance ────────────────────────────────────────────────
      // The GRN and the vendor were taken straight from the request body with no
      // check that either belonged to the caller's company or to each other, so
      // a return could be raised against another tenant's receipt, credited to a
      // vendor who never supplied it, and the stock deducted from the caller's
      // own warehouse.
      const { rows: [grn] } = await client.query(
        `SELECT g.id, g.grn_number, g.company_id, g.warehouse_id, g.status, po.supplier_id
           FROM goods_receipt_notes g
           LEFT JOIN purchase_orders po ON po.id = g.po_id
          WHERE g.id = $1 AND g.deleted_at IS NULL
            AND ($2::int IS NULL OR g.company_id = $2)
          FOR UPDATE OF g`,
        [data.grn_id, data.company_id ?? null]
      );
      if (!grn) throw bad('Goods receipt not found.', 404);

      const vendorId = data.vendor_id ?? grn.supplier_id;
      if (!vendorId) throw bad('A vendor is required to raise a return.', 400);
      if (grn.supplier_id && String(vendorId) !== String(grn.supplier_id)) {
        throw bad(
          `Receipt ${grn.grn_number} was supplied by vendor ${grn.supplier_id}; a return against it cannot be credited to vendor ${vendorId}.`,
          400
        );
      }
      if (!Array.isArray(data.items) || !data.items.length) {
        throw bad('A return must have at least one line.', 400);
      }

      // ── Quantity ────────────────────────────────────────────────────────────
      // Nothing bounded the returned quantity, so a return could send back more
      // than was ever received — driving stock negative and raising a debit note
      // for goods the vendor never shipped. Cumulative across earlier returns
      // for the same reason the receipt tolerance is.
      const { rows: receiptLines } = await client.query(
        `SELECT gi.item_id,
                SUM(GREATEST(COALESCE(gi.quantity_received,0) - COALESCE(gi.quantity_rejected,0), 0)) AS accepted
           FROM grn_items gi WHERE gi.grn_id = $1 GROUP BY gi.item_id`,
        [grn.id]
      );
      const acceptedByItem = new Map(receiptLines.map(r => [String(r.item_id), parseFloat(r.accepted) || 0]));
      const { rows: priorLines } = await client.query(
        `SELECT ri.item_id, SUM(COALESCE(ri.quantity_returned,0)) AS returned
           FROM rtv_items ri JOIN return_to_vendor r ON r.id = ri.rtv_id
          WHERE r.grn_id = $1 GROUP BY ri.item_id`,
        [grn.id]
      );
      const returnedByItem = new Map(priorLines.map(r => [String(r.item_id), parseFloat(r.returned) || 0]));

      const runningByItem = new Map();
      for (const item of data.items) {
        const key = String(item.item_id);
        const qty = parseFloat(item.quantity_returned) || 0;
        if (!(qty > 0)) throw bad(`Return quantity for component ${key} must be greater than zero.`, 400);
        if (!acceptedByItem.has(key)) {
          throw bad(`Component ${key} was not accepted on receipt ${grn.grn_number}, so it cannot be returned against it.`, 400);
        }
        const running = (runningByItem.get(key) || 0) + qty;
        runningByItem.set(key, running);
        const cap = acceptedByItem.get(key) - (returnedByItem.get(key) || 0);
        if (running > cap + 1e-9) {
          throw bad(
            `Cannot return ${running} of component ${key} against receipt ${grn.grn_number}: only ${Number(cap.toFixed(4))} remain returnable ` +
            `(${acceptedByItem.get(key)} accepted, ${returnedByItem.get(key) || 0} already returned).`,
            422
          );
        }
      }

      // A company-scoped document number from the shared sequence, not
      // `RTV-${Date.now()}` — a wall-clock string is not a document number: it
      // is unreadable, unsearchable, ignores the configured prefix, and two
      // returns raised in the same millisecond collide on the UNIQUE constraint.
      const rtvNumber = await nextRtvNumber(client, data.company_id ?? null);
      const warehouseId = data.warehouse_id ?? grn.warehouse_id;
      if (!warehouseId) throw bad('A warehouse is required — returned goods have to be taken out of a location.', 400);

      const { rows: [rtv] } = await client.query(
        `INSERT INTO return_to_vendor (rtv_number, grn_id, vendor_id, company_id, return_date, reason, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [rtvNumber, grn.id, vendorId, data.company_id, data.return_date, data.reason, data.notes || null, userId]
      );

      for (const item of data.items) {
        await client.query(
          `INSERT INTO rtv_items (rtv_id, item_id, quantity_returned, rate, remarks)
           VALUES ($1,$2,$3,$4,$5)`,
          [rtv.id, item.item_id, item.quantity_returned, item.rate, item.remarks || null]
        );

        // Deduct returned qty from stock — via the shared postStock() helper
        // (also fires reorder-breach detection, which this RTV path never
        // triggered before since it bypassed the shared helper entirely).
        await postStock(client, {
          itemId: item.item_id,
          warehouseId,
          inQty: 0,
          outQty: item.quantity_returned,
          txnType: 'return',
          refType: 'rtv',
          refId: rtv.id,
          remarks: `RTV ${rtvNumber} against GRN ${grn.grn_number}`,
          rate: item.rate,
          createdBy: userId,
          companyId: data.company_id,
          transactionDate: data.return_date,
        });

        // Give the quantity back to the order. Returned goods were never
        // delivered in the commercial sense, so leaving received_quantity at the
        // pre-return figure told MRP the requirement was met, kept the PO at
        // 'received', and left the 3-way match valuing goods that had gone back.
        await client.query(
          `UPDATE purchase_order_items poi
              SET received_quantity = GREATEST(COALESCE(poi.received_quantity,0) - $1, 0),
                  received_qty      = GREATEST(COALESCE(poi.received_quantity,0) - $1, 0)
            FROM goods_receipt_notes g
           WHERE g.id = $2 AND poi.po_id = g.po_id AND poi.item_id = $3`,
          [item.quantity_returned, grn.id, item.item_id]
        );
      }

      // The order is no longer fully received once goods have gone back.
      await client.query(
        `UPDATE purchase_orders po
            SET status = 'partial', updated_at = CURRENT_TIMESTAMP
          FROM goods_receipt_notes g
         WHERE g.id = $1 AND po.id = g.po_id AND po.status = 'received'`,
        [grn.id]
      );

      await client.query('COMMIT');

      try {
        logAudit({
          company_id: data.company_id, userId: data.actor_user_id ?? null,
          module: 'procurement', recordId: rtv.id, recordType: 'rtv',
          action: 'create', newData: rtv,
        });
      } catch (_) { /* audit failure must not break the transaction */ }

      return rtv;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Posts a held GRN's accepted quantities to usable stock. Called once IQC
   * clears the GRN (quality_tests' rollup flips goods_receipt_notes.quality_status
   * to 'passed' — see quality.routes.js's rollupQualityStatus()). Idempotent via
   * the stock_ledger's own grn reference rather than a separate "posted" flag,
   * so re-triggering the rollup after the GRN already passed is a safe no-op.
   *
   * This creates the inventory BATCH as well as the ledger entry. Receipt no
   * longer creates a batch while the goods are held for inspection: a batch is
   * usable stock, and stock that quality has not cleared is not usable. Holding
   * the ledger back while publishing the batch — what this did before — left the
   * two records disagreeing, with the full accepted quantity showing as
   * available in every batch-derived figure.
   */
  async releaseGrnStock(grnId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // FOR UPDATE on the receipt serialises two rollups firing at once, which
      // is reachable whenever the last two quality tests complete together.
      const { rows: [grn] } = await client.query(
        `SELECT g.id, g.grn_number, g.warehouse_id, g.company_id, g.received_date, po.supplier_id
           FROM goods_receipt_notes g
           LEFT JOIN purchase_orders po ON po.id = g.po_id
          WHERE g.id = $1 AND g.deleted_at IS NULL
          FOR UPDATE OF g`,
        [grnId]
      );
      if (!grn) { await client.query('ROLLBACK'); return { released: false, reason: 'not_found' }; }

      const { rows: [already] } = await client.query(
        `SELECT 1 FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1 LIMIT 1`,
        [grnId]
      );
      if (already) { await client.query('ROLLBACK'); return { released: false, reason: 'already_posted' }; }

      const { rows: items } = await client.query(
        `SELECT item_id, quantity_received, quantity_rejected, rate FROM grn_items WHERE grn_id=$1`,
        [grnId]
      );

      let lines = 0;
      for (const item of items) {
        const acceptedQty = Math.max(0, (item.quantity_received || 0) - (item.quantity_rejected || 0));
        if (acceptedQty <= 0) continue;
        if (!grn.warehouse_id) {
          throw bad(`Receipt ${grn.grn_number} has no warehouse, so its accepted stock cannot be released to a location.`, 422);
        }
        await this.postAcceptedStock(client, {
          grn, grnNumber: grn.grn_number, item, acceptedQty,
          warehouseId: grn.warehouse_id,
          supplierId: grn.supplier_id ?? null,
          receivedDate: grn.received_date,
          companyId: grn.company_id,
          createdBy: null,   // system-triggered release, not one actor's action
          releasedAfterIqc: true,
        });
        lines++;
      }

      await client.query('COMMIT');
      console.info(`[grn] released ${lines} line(s) of GRN ${grn.grn_number} to stock after IQC pass`);
      return { released: true, lines };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[grn] releasing GRN ${grnId} after IQC failed:`, error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  async getGRNs(filters) {
    return await grnRepo.findAll(filters);
  }

  async getGRNById(id, companyId = null) {
    const grn = await grnRepo.findById(id, companyId);
    if (grn) {
      grn.items = await grnRepo.getItems(id, companyId);
    }
    return grn;
  }
}

export default new GRNService();
