import pool from '../../shared/db.js';

/**
 * TENANCY IN THIS MODULE
 * ======================
 * Four of the five tables this repository owns carry NO company_id of their own:
 *
 *     purchase_suggestions · inventory_reservations
 *     inventory_allocations · stock_alerts
 *
 * (`inventory_batches` has one. It is NOT NULL as of migration 20260926000013,
 * and a BEFORE INSERT/UPDATE trigger — `trg_inventory_batches_tenant_guard` —
 * fills it from the item when omitted and RAISES when a caller supplies a company
 * that disagrees with the item's. So for batches the two columns can no longer
 * differ, which is what makes scoping them either way equivalent.)
 *
 * So the tenant boundary for every row here is TRANSITIVE, through
 * `inventory_items.company_id`. That is not a shortcut — it is the only column in
 * the graph that actually says who owns the stock — but it means the boundary
 * exists only where a query asks for it, and before this pass almost none of
 * them did. Every function below now takes a company id and applies it; the ones
 * that mutate a row by `:id` resolve the item first and report a cross-tenant id
 * as 404, not 403, so the endpoint does not confirm that the row exists.
 *
 * `null` means a genuinely global scope (a super admin with no company), matching
 * the `($n::int IS NULL OR company_id = $n)` convention used across this
 * codebase. Callers must pass `companyOf(req)` and never `req.user.company_id` —
 * the latter yields null for tokens minted before the claim existed, which in
 * this predicate means "every tenant".
 *
 * ⚠⚠ A COMPANY ID IS MANDATORY, NOT OPTIONAL-BY-OMISSION. No function below
 * defaults it. An earlier revision of this file declared them `companyId = null`,
 * and because `null` means "no filter" in the predicate above, a caller who simply
 * FORGOT the argument silently got back the cross-tenant behaviour this whole pass
 * removed — no error, no test failure unless a test happened to cover that exact
 * call site. Every one now runs through `requireScope()`, which throws on
 * `undefined` and permits an explicit `null`. See its note for why the
 * `undefined`/`null` distinction is the right seam.
 */

/**
 * Turn "I forgot to pass the company" into a loud failure instead of a silent
 * cross-tenant read.
 *
 * ⚠⚠ THIS EXISTS BECAUSE THE FAIL-OPEN DIRECTION IS THE DANGEROUS ONE. Every
 * scoping predicate in this repository is the codebase-standard
 * `($n::int IS NULL OR company_id = $n)`, in which **null means "no filter" —
 * i.e. every tenant**. So a parameter declared `companyId = null` hands a caller
 * who simply forgets the argument exactly the unscoped behaviour this whole pass
 * removed, with no error and no test failure unless a test happens to cover that
 * call site. That is the same shape as the `req.user.company_id` trap that
 * `companyOf()` was written to close.
 *
 * The distinction JavaScript gives us for free is `undefined` vs `null`:
 *
 *   - `undefined` — the argument was never supplied. Almost certainly a mistake,
 *     because a global scope is something a caller decides, not something it
 *     omits. THROWS.
 *   - `null` — an explicit, deliberate global scope: a super admin with no company
 *     assignment, which `companyOf(req)` legitimately returns. ALLOWED.
 *
 * `companyOf(req)` never returns `undefined` (it returns an int or null), so every
 * correct route call passes this untouched and no caller has to change.
 *
 * @param {number|null} companyId
 * @param {string} fnName  for the error message — a stack trace through pg is not
 *                         enough to find which query lost its scope.
 */
function requireScope(companyId, fnName) {
  if (companyId === undefined) {
    throw Object.assign(
      new Error(
        `${fnName}() was called without a company scope. Pass companyOf(req) — ` +
        `or an explicit null for a deliberate global scope. Omitting it would ` +
        `read across every tenant, because null means "no filter" in this ` +
        `repository's scoping predicate.`),
      { status: 500 });
  }
  if (companyId === null) return null;
  const v = parseInt(String(companyId), 10);
  return Number.isNaN(v) ? null : v;
}

/**
 * Resolve an Advanced Inventory child row to its owning company and confirm the
 * caller may act on it.
 *
 * @param {object} db      pool or an open transaction client
 * @param {string} table   the child table (fixed identifier, never user input)
 * @param {number} id      the row's primary key
 * @param {number|null} companyId
 * @returns {Promise<object>} the row's `{ id, item_id, company_id }`
 * @throws  404 when the row does not exist OR belongs to another tenant
 */
async function assertRowInCompany(db, table, id, companyId) {
  const rowId = parseInt(id, 10);
  if (!Number.isFinite(rowId)) {
    throw Object.assign(new Error('A numeric id is required'), { status: 400 });
  }
  const { rows } = await db.query(
    `SELECT t.id, t.item_id, ii.company_id
       FROM ${table} t
       JOIN inventory_items ii ON ii.id = t.item_id
      WHERE t.id = $1 AND ($2::int IS NULL OR ii.company_id = $2)`,
    [rowId, requireScope(companyId, `assertRowInCompany(${table})`)]
  );
  if (!rows[0]) {
    // Deliberately the same message and status a genuinely missing row gets.
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  return rows[0];
}

/**
 * Both parents of a new reservation / allocation / batch must be in the caller's
 * company. Checking only the item would let a caller reserve their own stock
 * into somebody else's warehouse; checking only the warehouse is the mirror
 * hole. `FOR UPDATE` on the item is requested by callers that also need to
 * serialise against concurrent quantity reads.
 */
async function assertParentsInCompany(db, { itemId, warehouseId, companyId, lockItem = false }) {
  const item = parseInt(itemId, 10);
  const wh   = parseInt(warehouseId, 10);
  if (!Number.isFinite(item)) throw Object.assign(new Error('item_id is required'), { status: 422 });
  if (!Number.isFinite(wh))   throw Object.assign(new Error('warehouse_id is required'), { status: 422 });

  const { rows: [itemRow] } = await db.query(
    `SELECT id, company_id FROM inventory_items
      WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
      ${lockItem ? 'FOR UPDATE' : ''}`,
    [item, requireScope(companyId, 'assertParentsInCompany')]);
  if (!itemRow) throw Object.assign(new Error(`Item ${item} not found`), { status: 404 });

  const { rows: [whRow] } = await db.query(
    `SELECT id FROM warehouses
      WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
    [wh, requireScope(companyId, 'assertParentsInCompany')]);
  if (!whRow) throw Object.assign(new Error(`Warehouse ${wh} not found`), { status: 404 });

  return { itemId: item, warehouseId: wh, itemCompanyId: itemRow.company_id };
}

const advancedInventoryRepository = {
  assertRowInCompany,
  assertParentsInCompany,

  // ==================== BATCH MANAGEMENT ====================
  /**
   * @param {object} data
   * @param {object|null} client  an open transaction client. REQUIRED whenever
   *   the batch belongs to a wider unit of work.
   *
   * This took no client and always issued its INSERT on the shared pool. The GRN
   * service calls it from inside a transaction, so every batch it wrote committed
   * independently of the receipt that caused it: a GRN that rolled back — an
   * over-receipt rejection, a failing line, a dropped connection — left its
   * inventory behind as available stock with no receipt to explain it. Four such
   * rows were live in this database (batches 3-6, pointing at goods_receipt_notes
   * 2-5, none of which exist), claiming 29 units; migration 20260903000011
   * soft-deletes them and adds the FK that makes an orphan unrepresentable.
   *
   * Defaulting to `pool` keeps the standalone caller
   * (advancedInventory.routes POST /batches) working unchanged — that one is a
   * single statement and genuinely has no transaction to join.
   */
  /**
   * ⚠ company_id was NOT in this INSERT. Every lot created through the live GRN
   * path was therefore born with company_id NULL, and a NULL company_id row is
   * invisible to every company-scoped reader — the lot would have been received,
   * counted in stock, and missing from the batch list of the company that
   * received it. All 15 existing rows carry a company_id only because they were
   * written by seeds and migrations that set it directly, never through here,
   * which is why the gap was not visible in the data.
   *
   * It also silently weakened the new uq_batches_company_item_number index:
   * NULLs do not collide, so duplicate batch numbers would still have been
   * accepted for exactly the rows this path creates.
   *
   * It falls back to the item's own company rather than defaulting to null, so a
   * caller that does not pass one still lands in the right tenant.
   *
   * supplier_batch_no / manufacturer / manufacturer_part_no / manufacturing_date
   * are the supplier's own lot identity (audit finding 7.1). Without them a
   * recall could not start from "supplier batch ABC123 is defective" — the only
   * form in which that news ever actually arrives.
   */
  async createBatch(data, client = null) {
    const db = client ?? pool;
    const {
      item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id,
      grn_id, quantity_received, rate, company_id = null, bin_id = null,
      supplier_batch_no = null, manufacturer = null, manufacturer_part_no = null,
      manufacturing_date = null,
    } = data;
    const result = await db.query(
      `INSERT INTO inventory_batches
         (item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id, grn_id,
          quantity_received, quantity_available, rate, company_id, bin_id,
          supplier_batch_no, manufacturer, manufacturer_part_no, manufacturing_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9,
               COALESCE($10::int, (SELECT company_id FROM inventory_items WHERE id = $1)),
               $11, $12, $13, $14, $15)
       RETURNING *`,
      [item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id, grn_id,
       quantity_received, rate, company_id, bin_id,
       supplier_batch_no, manufacturer, manufacturer_part_no, manufacturing_date]
    );
    return result.rows[0];
  },

  // `company_id` reaches this view from `inventory_items` — added to
  // v_batch_stock by migration 20260926000010 precisely so this filter could
  // exist. Before it, the Batch Tracking screen listed every tenant's lots,
  // their batch numbers, suppliers, rates and stock value, to anyone holding
  // inventory:view.
  async getBatches(filters = {}) {
    let query = `SELECT * FROM v_batch_stock WHERE ($1::int IS NULL OR company_id = $1)`;
    const params = [requireScope(filters.company_id, 'getBatches')];

    if (filters.item_id) {
      params.push(filters.item_id);
      query += ` AND item_id = $${params.length}`;
    }
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      query += ` AND warehouse_id = $${params.length}`;
    }
    if (filters.status) {
      params.push(filters.status);
      query += ` AND status = $${params.length}`;
    }

    query += ` ORDER BY received_date DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  /**
   * Consume from / return to a lot.
   *
   * Two faults, and the tenant one was the serious half:
   *
   *  1. NO TENANT CHECK. The batch was located by bare `:id`, so any caller with
   *     inventory:edit could consume another company's stock down to zero by
   *     guessing an integer — a destructive cross-tenant write, not merely a
   *     read leak.
   *  2. The availability check and the UPDATE ran as two statements on the shared
   *     pool with nothing between them. Two concurrent consumes of the last unit
   *     both read `quantity_available = 1`, both passed the check, and both
   *     decremented — driving the column negative. Both now happen on one
   *     transaction client with the row locked.
   */
  async updateBatchQuantity(batch_id, quantity_change, operation, companyId) {
    const qty = Math.abs(parseFloat(quantity_change));
    if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error('quantity_change must be a positive number'), { status: 422 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Tenant boundary first: a caller outside the company must not learn
      // whether the batch exists, let alone how much is in it.
      const { rows: [batch] } = await client.query(
        `SELECT ib.id, ib.quantity_available
           FROM inventory_batches ib
           JOIN inventory_items ii ON ii.id = ib.item_id
          WHERE ib.id = $1 AND ib.deleted_at IS NULL
            AND ($2::int IS NULL OR ii.company_id = $2)
          FOR UPDATE OF ib`,
        [parseInt(batch_id, 10), requireScope(companyId, 'updateBatchQuantity')]);
      if (!batch) throw Object.assign(new Error('Batch not found'), { status: 404 });

      if (operation === 'consume' && parseFloat(batch.quantity_available) < qty) {
        throw Object.assign(
          new Error(`Insufficient batch quantity. Available: ${batch.quantity_available}, Requested: ${qty}`),
          { status: 422 }
        );
      }

      const field = operation === 'consume' ? 'quantity_consumed' : 'quantity_available';
      const result = await client.query(
        `UPDATE inventory_batches
         SET ${field} = ${field} + $1,
             quantity_available = quantity_available ${operation === 'consume' ? '-' : '+'} $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 RETURNING *`,
        [qty, batch.id]
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  // ==================== RESERVATIONS ====================
  // A reservation is a claim on stock that exists. This used to insert
  // unconditionally: you could reserve a million units of an item with three on
  // hand, and two concurrent requests for the last unit both succeeded because
  // nothing serialised them. Both are checked here, inside one transaction.
  //
  // `available` is on-hand MINUS what is already spoken for, derived live from
  // the reservation rows rather than from a stored counter. That is deliberate:
  // inventory_batches.quantity_reserved exists for this and is written by
  // nothing, and a second hand-maintained quantity column is how
  // inventory_items.current_stock drifted away from stock_ledger in the first
  // place.
  async createReservation(data) {
    const { item_id, warehouse_id, batch_id, reservation_type, reference_type, reference_id,
            reference_number, quantity_reserved, reserved_date, expiry_date, reserved_by, notes } = data;

    const qty = parseFloat(quantity_reserved);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error('quantity_reserved must be a positive number'), { status: 422 });
    }
    if (!item_id || !warehouse_id) {
      throw Object.assign(new Error('item_id and warehouse_id are required'), { status: 422 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Tenant boundary AND the serialisation lock, in one step.
      //
      // The lock was already here and was correct — two callers reserving the
      // same item are serialised on the item row. What was missing is the company
      // predicate: the item was located by bare id, so a caller could reserve
      // another tenant's stock, and the reservation then counted against that
      // tenant's availability. The reservation row itself has no company_id, so
      // it was also invisible to the company whose stock it held — a denial of
      // their own inventory that their own screens could not explain.
      //
      // The warehouse is checked too: reserving your own item into another
      // company's warehouse is the mirror of the same hole.
      await assertParentsInCompany(client, {
        itemId: item_id, warehouseId: warehouse_id, companyId: requireScope(data.company_id, 'createReservation'), lockItem: true,
      });

      const { rows: [bal] } = await client.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS on_hand
           FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
        [item_id, warehouse_id]);

      // Only open reservations hold stock. cancelled / fully_consumed / expired
      // rows have released their claim and must not count against availability.
      const { rows: [res] } = await client.query(
        `SELECT COALESCE(SUM(quantity_remaining), 0) AS reserved
           FROM inventory_reservations
          WHERE item_id = $1 AND warehouse_id = $2
            AND status IN ('active', 'partially_consumed')`,
        [item_id, warehouse_id]);

      const onHand    = parseFloat(bal.on_hand);
      const reserved  = parseFloat(res.reserved);
      const available = onHand - reserved;

      // A named lot has to be in the caller's company too, and has to be a lot of
      // THIS item in THIS warehouse. Passing another tenant's batch_id attached a
      // reservation to their lot; passing an unrelated batch of your own attached
      // it to stock that is not the stock being reserved, which the batch_number
      // then reported wrongly on the Reservations screen.
      if (batch_id != null && batch_id !== '') {
        const { rows: [lot] } = await client.query(
          `SELECT ib.id FROM inventory_batches ib
             JOIN inventory_items ii ON ii.id = ib.item_id
            WHERE ib.id = $1 AND ib.deleted_at IS NULL
              AND ib.item_id = $2 AND ib.warehouse_id = $3
              AND ($4::int IS NULL OR ii.company_id = $4)`,
          [parseInt(batch_id, 10), item_id, warehouse_id, requireScope(data.company_id, 'createReservation')]);
        if (!lot) throw Object.assign(new Error(`Batch ${batch_id} not found for this item and warehouse`), { status: 404 });
      }

      if (qty > available) {
        throw Object.assign(new Error(
          `Cannot reserve ${qty}: only ${available} available ` +
          `(${onHand} on hand, ${reserved} already reserved).`), { status: 422 });
      }

      const result = await client.query(
        `INSERT INTO inventory_reservations
         (item_id, warehouse_id, batch_id, reservation_type, reference_type, reference_id,
          reference_number, quantity_reserved, quantity_remaining, reserved_date, expiry_date, reserved_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12) RETURNING *`,
        [item_id, warehouse_id, batch_id, reservation_type, reference_type, reference_id,
         reference_number, qty, reserved_date, expiry_date, reserved_by, notes]);

      await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  // Scoped through inventory_items.company_id — inventory_reservations carries
  // no company_id of its own, and this listed every tenant's reservations to any
  // authenticated caller.
  async getReservations(filters = {}) {
    let query = `
      SELECT ir.*, ii.item_code, ii.item_name, w.warehouse_name, ib.batch_number
      FROM inventory_reservations ir
      JOIN inventory_items ii ON ir.item_id = ii.id
      JOIN warehouses w ON ir.warehouse_id = w.id
      LEFT JOIN inventory_batches ib ON ir.batch_id = ib.id
      WHERE ($1::INTEGER IS NULL OR ii.company_id = $1)`;
    const params = [requireScope(filters.company_id, 'getReservations')];

    if (filters.item_id) {
      params.push(filters.item_id);
      query += ` AND ir.item_id = $${params.length}`;
    }
    if (filters.reference_type) {
      params.push(filters.reference_type);
      query += ` AND ir.reference_type = $${params.length}`;
    }
    if (filters.reference_id) {
      params.push(filters.reference_id);
      query += ` AND ir.reference_id = $${params.length}`;
    }
    if (filters.status) {
      params.push(filters.status);
      query += ` AND ir.status = $${params.length}`;
    }

    query += ` ORDER BY ir.reserved_date DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  /**
   * Consume against an existing reservation.
   *
   * Had the same two faults as updateBatchQuantity: located by bare `:id` with no
   * tenant predicate, and check-then-update across two pool statements so two
   * concurrent consumes of the same remaining quantity both passed. Now one
   * transaction with the reservation row locked, and the company checked first.
   */
  async consumeReservation(reservation_id, quantity_consumed, companyId) {
    const qty = parseFloat(quantity_consumed);
    if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error('quantity_consumed must be a positive number'), { status: 422 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [reservation] } = await client.query(
        `SELECT ir.id, ir.quantity_remaining
           FROM inventory_reservations ir
           JOIN inventory_items ii ON ii.id = ir.item_id
          WHERE ir.id = $1 AND ($2::int IS NULL OR ii.company_id = $2)
          FOR UPDATE OF ir`,
        [parseInt(reservation_id, 10), requireScope(companyId, 'consumeReservation')]);
      if (!reservation) throw Object.assign(new Error('Reservation not found'), { status: 404 });

      if (parseFloat(reservation.quantity_remaining) < qty) {
        throw Object.assign(
          new Error(`Cannot consume more than remaining. Remaining: ${reservation.quantity_remaining}, Requested: ${qty}`),
          { status: 422 }
        );
      }

      const result = await client.query(
        `UPDATE inventory_reservations
         SET quantity_consumed = quantity_consumed + $1,
             quantity_remaining = quantity_remaining - $1,
             status = CASE
               WHEN quantity_remaining - $1 <= 0 THEN 'fully_consumed'
               ELSE 'partially_consumed'
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 RETURNING *`,
        [qty, reservation.id]
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * Release a reservation's claim on stock.
   *
   * The company predicate is in the UPDATE itself rather than a separate SELECT:
   * a single statement is already atomic, and a cancelled reservation frees
   * inventory, so a cross-tenant call here silently handed somebody else's
   * reserved stock back to the available pool.
   *
   * Returning undefined for a row that does not exist OR is another tenant's is
   * what lets the route answer 404 identically for both.
   */
  async cancelReservation(reservation_id, companyId) {
    const result = await pool.query(
      `UPDATE inventory_reservations ir
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE ir.id = $1
         AND EXISTS (SELECT 1 FROM inventory_items ii
                      WHERE ii.id = ir.item_id
                        AND ($2::int IS NULL OR ii.company_id = $2))
       RETURNING ir.*`,
      [parseInt(reservation_id, 10), requireScope(companyId, 'cancelReservation')]
    );
    return result.rows[0];
  },

  // ==================== ALLOCATIONS ====================
  // An allocation is a record that material was spent on something. Writing one
  // against another tenant's item attributed their consumption to your project or
  // department — and `inventory_allocations` has no company_id, so the row was
  // then invisible to the company whose stock it described. Both parents are
  // checked, on one transaction client so the check and the INSERT cannot be
  // separated by a concurrent delete of the item.
  // allocation_source is fixed here ('advanced_manual': counted as a commitment
  // by MRP and order promising, as before), never taken from `data`.
  async createAllocation(data) {
    const { item_id, batch_id, warehouse_id, allocation_type, reference_type, reference_id,
            quantity, rate, allocation_date, allocated_by, purpose, company_id = null } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertParentsInCompany(client, { itemId: item_id, warehouseId: warehouse_id, companyId: company_id });

      if (batch_id != null && batch_id !== '') {
        const { rows: [lot] } = await client.query(
          `SELECT ib.id FROM inventory_batches ib
             JOIN inventory_items ii ON ii.id = ib.item_id
            WHERE ib.id = $1 AND ib.deleted_at IS NULL AND ib.item_id = $2
              AND ($3::int IS NULL OR ii.company_id = $3)`,
          [parseInt(batch_id, 10), parseInt(item_id, 10), requireScope(company_id, 'createAllocation')]);
        if (!lot) throw Object.assign(new Error(`Batch ${batch_id} not found for this item`), { status: 404 });
      }

      const result = await client.query(
        `INSERT INTO inventory_allocations
         (item_id, batch_id, warehouse_id, allocation_type, reference_type, reference_id, quantity, rate, allocation_date, allocated_by, purpose, allocation_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'advanced_manual') RETURNING *`,
        [parseInt(item_id, 10), batch_id === '' ? null : batch_id, parseInt(warehouse_id, 10),
         allocation_type, reference_type, reference_id, quantity, rate, allocation_date, allocated_by, purpose]
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  async getAllocations(filters = {}) {
    let query = `
      SELECT ia.*, ii.item_code, ii.item_name, w.warehouse_name, ib.batch_number
      FROM inventory_allocations ia
      JOIN inventory_items ii ON ia.item_id = ii.id
      JOIN warehouses w ON ia.warehouse_id = w.id
      LEFT JOIN inventory_batches ib ON ia.batch_id = ib.id
      WHERE ($1::int IS NULL OR ii.company_id = $1)`;
    const params = [requireScope(filters.company_id, 'getAllocations')];

    if (filters.allocation_type) {
      params.push(filters.allocation_type);
      query += ` AND ia.allocation_type = $${params.length}`;
    }
    if (filters.reference_id) {
      params.push(filters.reference_id);
      query += ` AND ia.reference_id = $${params.length}`;
    }

    query += ` ORDER BY ia.allocation_date DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  // ==================== STOCK ALERTS ====================
  async getStockAlerts(filters = {}) {
    let query = `
      SELECT sa.*, ii.item_code, ii.item_name, w.warehouse_name
      FROM stock_alerts sa
      JOIN inventory_items ii ON sa.item_id = ii.id
      JOIN warehouses w ON sa.warehouse_id = w.id
      WHERE ($1::int IS NULL OR ii.company_id = $1)`;
    const params = [requireScope(filters.company_id, 'getStockAlerts')];

    if (filters.status) {
      params.push(filters.status);
      query += ` AND sa.status = $${params.length}`;
    }
    if (filters.alert_type) {
      params.push(filters.alert_type);
      query += ` AND sa.alert_type = $${params.length}`;
    }

    query += ` ORDER BY sa.alert_date DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  // Acknowledging another tenant's alert cleared it from THEIR queue — a
  // low-stock warning they never saw and can no longer be shown. The predicate is
  // in the UPDATE so there is no window between the check and the write.
  async acknowledgeAlert(alert_id, user_id, companyId) {
    const result = await pool.query(
      `UPDATE stock_alerts sa
       SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = CURRENT_TIMESTAMP
       WHERE sa.id = $2
         AND EXISTS (SELECT 1 FROM inventory_items ii
                      WHERE ii.id = sa.item_id
                        AND ($3::int IS NULL OR ii.company_id = $3))
       RETURNING sa.*`,
      [user_id, parseInt(alert_id, 10), requireScope(companyId, 'stock alert update')]
    );
    return result.rows[0];
  },

  /**
   * Resolve an alert.
   *
   * This function EXISTED and was dead: `advancedInventory.routes.js` had its own
   * inline UPDATE for POST /alerts/:id/resolve, which is how that endpoint came to
   * have no tenant predicate while this one at least had a single-statement shape
   * that could be given one. The route now calls this; `resolved_by` is recorded
   * here rather than in the route, which is where it was.
   */
  async resolveAlert(alert_id, user_id, companyId) {
    const result = await pool.query(
      `UPDATE stock_alerts sa
       SET status = 'resolved', resolved_by = $1, resolved_at = CURRENT_TIMESTAMP
       WHERE sa.id = $2
         AND EXISTS (SELECT 1 FROM inventory_items ii
                      WHERE ii.id = sa.item_id
                        AND ($3::int IS NULL OR ii.company_id = $3))
       RETURNING sa.*`,
      [user_id, parseInt(alert_id, 10), requireScope(companyId, 'stock alert update')]
    );
    return result.rows[0];
  },

  // ==================== PURCHASE SUGGESTIONS ====================
  async getPurchaseSuggestions(filters = {}) {
    let query = `
      SELECT ps.*, ii.item_code, ii.item_name, ii.unit_of_measure, ii.standard_cost, w.warehouse_name
      FROM purchase_suggestions ps
      JOIN inventory_items ii ON ps.item_id = ii.id
      JOIN warehouses w ON ps.warehouse_id = w.id
      WHERE ($1::int IS NULL OR ii.company_id = $1)`;
    const params = [requireScope(filters.company_id, 'getPurchaseSuggestions')];

    if (filters.id) {
      params.push(filters.id);
      query += ` AND ps.id = $${params.length}`;
    }
    if (filters.status) {
      params.push(filters.status);
      query += ` AND ps.status = $${params.length}`;
    }
    if (filters.priority) {
      params.push(filters.priority);
      query += ` AND ps.priority = $${params.length}`;
    }

    query += ` ORDER BY 
      CASE ps.priority 
        WHEN 'high' THEN 1 
        WHEN 'medium' THEN 2 
        ELSE 3 
      END, ps.generated_date DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  /**
   * Flip a suggestion to converted.
   *
   * ⚠ DO NOT CALL THIS DIRECTLY to perform a conversion. It is one statement of a
   * larger unit of work that must also mint the requisition, its line item and its
   * total, and must hold a lock on the suggestion across all of that. The
   * canonical owner of that transaction is
   * `inventory/services/suggestionToPr.service.js` — see its header for why there
   * is exactly one. This stays exported because that service and the migration
   * backfill are its only legitimate callers.
   *
   * The `status <> 'converted_to_pr'` guard is a second line of defence behind the
   * service's row lock: if some future caller ever does reach here without one,
   * the UPDATE affects zero rows instead of silently repointing
   * `converted_to_pr_id` at a second requisition and orphaning the first.
   */
  async convertSuggestionToPR(suggestion_id, pr_id, client = pool) {
    const result = await client.query(
      `UPDATE purchase_suggestions
       SET status = 'converted_to_pr', converted_to_pr_id = $1, converted_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status <> 'converted_to_pr' RETURNING *`,
      [pr_id, suggestion_id]
    );
    return result.rows[0];
  },

  // `status = 'pending'` is part of the predicate, not just the tenant check:
  // rejecting a suggestion that has ALREADY been converted would leave a
  // requisition in the register whose originating suggestion reads "rejected",
  // and the reject button is on the same row as Convert in
  // StockAlertsAndSuggestions.jsx, so that sequence is one mis-click away.
  async rejectSuggestion(suggestion_id, user_id, reason, companyId) {
    const result = await pool.query(
      `UPDATE purchase_suggestions ps
       SET status = 'rejected', rejected_by = $1, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $2
       WHERE ps.id = $3 AND ps.status = 'pending'
         AND EXISTS (SELECT 1 FROM inventory_items ii
                      WHERE ii.id = ps.item_id
                        AND ($4::int IS NULL OR ii.company_id = $4))
       RETURNING ps.*`,
      [user_id, reason, parseInt(suggestion_id, 10), requireScope(companyId, 'rejectSuggestion')]
    );
    return result.rows[0];
  },

  // ==================== STOCK SUMMARY & ANALYTICS ====================
  async getStockSummary(filters = {}) {
    let query = `SELECT * FROM v_stock_summary WHERE ($1::int IS NULL OR company_id = $1)`;
    const params = [requireScope(filters.company_id, 'getStockSummary')];

    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      query += ` AND warehouse_id = $${params.length}`;
    }
    if (filters.stock_status) {
      params.push(filters.stock_status);
      query += ` AND stock_status = $${params.length}`;
    }

    query += ` ORDER BY item_name`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  // Unused by any route today (kept — it is a legitimate helper and deleting on
  // "no callers" is how live code gets removed by mistake), but it takes the
  // company for the same reason as the rest: a future caller should not have to
  // discover that this one is the exception.
  async getAvailableStock(item_id, warehouse_id, companyId) {
    const { rows: [item] } = await pool.query(
      `SELECT id FROM inventory_items
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [item_id, requireScope(companyId, 'getAvailableStock')]);
    if (!item) throw Object.assign(new Error('Item not found'), { status: 404 });

    const result = await pool.query(
      `SELECT calculate_available_stock($1, $2) as available_stock`,
      [item_id, warehouse_id]
    );
    return result.rows[0].available_stock;
  },

  async getStockAgingReport(warehouse_id, companyId) {
    const params = [requireScope(companyId, 'getStockAgingReport')];
    let query = `
      SELECT
        CASE
          WHEN age_days <= 30 THEN '0-30 days'
          WHEN age_days <= 60 THEN '31-60 days'
          WHEN age_days <= 90 THEN '61-90 days'
          WHEN age_days <= 180 THEN '91-180 days'
          ELSE '180+ days'
        END as age_category,
        COUNT(*) as batch_count,
        SUM(quantity_available) as total_quantity,
        SUM(stock_value) as total_value
      FROM v_batch_stock
      WHERE status = 'active' AND ($1::int IS NULL OR company_id = $1)`;

    if (warehouse_id) {
      params.push(warehouse_id);
      query += ` AND warehouse_id = $${params.length}`;
    }

    query += ` GROUP BY age_category ORDER BY MIN(age_days)`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async getMaterialConsumptionByProject(project_id, companyId) {
    const params = [requireScope(companyId, 'getMaterialConsumptionByProject')];
    let query = `SELECT * FROM v_material_consumption_by_project
                  WHERE ($1::int IS NULL OR company_id = $1)`;

    if (project_id) {
      params.push(project_id);
      query += ` AND project_id = $${params.length}`;
    }

    query += ` ORDER BY total_value DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  /**
   * THE Advanced Inventory dashboard figures. One implementation.
   *
   * ⚠⚠ THERE WERE TWO, AND THEY DISAGREED ON WHAT "RESERVED" MEANS. This function
   * and the inline SQL in `GET /advanced/dashboard` each computed six tiles, and
   * the route's version is the one that was right:
   *
   *   - THIS function derived `total_reserved_value` from
   *     `inventory_batches.quantity_reserved`. **Nothing in this codebase has ever
   *     written that column** — verified again 2026-09-26: 0 of 15 rows are
   *     non-zero and there are no writers. So this number was STRUCTURALLY ALWAYS
   *     ZERO, not merely wrong, and `total_available_value` (which subtracted the
   *     same column) silently reduced to `quantity_available * rate`.
   *   - The route derived both from the rows that actually record the facts:
   *     reserved from the open `inventory_reservations`, available from the ledger
   *     via `v_stock_summary`.
   *
   * That is the same defect `getReservedVsAvailableStock()` was already fixed for
   * in an earlier pass — its old `HAVING SUM(quantity_reserved) > 0` could never
   * pass, for exactly this reason. Fixing it there and leaving it here is how a
   * module ends up with two numbers under one label.
   *
   * So: the route's derivation wins, it lives here, and the route calls this. The
   * holding-cost fields are this function's own contribution and are kept — they
   * are derived from `total_available_value`, which is now the correct one.
   *
   * ⚠ `quantity_reserved` is deliberately NOT read anywhere below. If a future pass
   * starts writing it, this function must not quietly start double-counting:
   * reserved stock is a property of the reservation rows, and a second
   * hand-maintained counter is how `inventory_items.current_stock` drifted away
   * from `stock_ledger` in the first place.
   */
  async getDashboardMetrics(companyId) {
    const cid = requireScope(companyId, 'getDashboardMetrics');
    const holdingRate = (() => {
      const parsed = Number.parseFloat(process.env.INVENTORY_HOLDING_COST_RATE ?? '0.18');
      if (!Number.isFinite(parsed) || parsed < 0) return 0.18;
      return parsed;
    })();

    // One round trip rather than six. The tenant predicate appears once per
    // sub-select because four of these tables have no company_id of their own.
    const { rows: [m] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stock_alerts sa
          WHERE sa.status = 'active' AND sa.alert_type = 'low_stock'
            AND EXISTS (SELECT 1 FROM inventory_items ii
                         WHERE ii.id = sa.item_id AND ($1::int IS NULL OR ii.company_id = $1))
        )::int AS low_stock_alerts,
        (SELECT COUNT(*) FROM stock_alerts sa
          WHERE sa.status = 'active'
            AND EXISTS (SELECT 1 FROM inventory_items ii
                         WHERE ii.id = sa.item_id AND ($1::int IS NULL OR ii.company_id = $1))
        )::int AS active_alerts,
        (SELECT COUNT(*) FROM inventory_reservations r
          WHERE r.status = 'active'
            AND EXISTS (SELECT 1 FROM inventory_items ii
                         WHERE ii.id = r.item_id AND ($1::int IS NULL OR ii.company_id = $1))
        )::int AS active_reservations,
        (SELECT COUNT(*) FROM purchase_suggestions ps
          WHERE ps.status = 'pending'
            AND EXISTS (SELECT 1 FROM inventory_items ii
                         WHERE ii.id = ps.item_id AND ($1::int IS NULL OR ii.company_id = $1))
        )::int AS pending_suggestions,
        (SELECT COUNT(*) FROM inventory_batches ib
          WHERE ib.expiry_date IS NOT NULL
            AND ib.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
            AND ib.expiry_date  > CURRENT_DATE
            AND ib.deleted_at IS NULL
            AND ($1::int IS NULL OR ib.company_id = $1)
        )::int AS expiring_batches,
        -- Reserved value: from the OPEN reservations, valued at the item's standard
        -- cost. 'partially_consumed' holds stock just as 'active' does, which is
        -- why both are counted here, and why quantity_remaining is the quantity --
        -- quantity_reserved on that table is the ORIGINAL claim, not what is
        -- still outstanding.
        -- (No backticks in this SQL: it sits inside a JS template literal, where a
        --  backtick ends the string. That has broken this codebase's boot before.)
        COALESCE((
          SELECT SUM(r.quantity_remaining * COALESCE(ii.standard_cost, 0))
            FROM inventory_reservations r
            JOIN inventory_items ii ON ii.id = r.item_id
           WHERE r.status IN ('active', 'partially_consumed') AND ii.deleted_at IS NULL
             AND ($1::int IS NULL OR ii.company_id = $1)
        ), 0)::float AS total_reserved_value,
        -- Available value: from the LEDGER, via v_stock_summary. That view's
        -- company_id was added by migration 20260926000010 for this filter.
        COALESCE((
          SELECT SUM(vs.current_stock * vs.avg_rate)
            FROM v_stock_summary vs
           WHERE vs.current_stock > 0
             AND ($1::int IS NULL OR vs.company_id = $1)
        ), 0)::float AS total_available_value
    `, [cid]);

    return {
      low_stock_alerts:    m.low_stock_alerts,
      // `active_alerts` counts every open alert type, `low_stock_alerts` only the
      // low-stock ones. The route's tile was labelled `low_stock_alerts` but
      // counted ALL active alerts — so a single expiring-batch alert inflated the
      // "low stock" number. Both are returned rather than picking one, because the
      // dashboard genuinely wants the total and the strip genuinely says "low
      // stock"; the caller chooses.
      active_alerts:       m.active_alerts,
      active_reservations: m.active_reservations,
      pending_suggestions: m.pending_suggestions,
      expiring_batches:    m.expiring_batches,
      total_reserved_value:  m.total_reserved_value,
      total_available_value: m.total_available_value,
      holding_cost_rate_annual:    holdingRate,
      total_holding_cost_annual:   m.total_available_value * holdingRate,
      total_holding_cost_monthly: (m.total_available_value * holdingRate) / 12,
    };
  },

  // Was: SUM(inventory_batches.quantity_reserved) with a
  // `HAVING SUM(quantity_reserved) > 0`. Nothing in the codebase has ever
  // written that column, so the predicate could never pass and this returned an
  // empty array however many reservations existed.
  //
  // Both sides are now derived from the rows that actually record the facts:
  // on-hand from stock_ledger, reserved from the open reservations.
  async getReservedVsAvailableStock(warehouse_id, company_id) {
    const { rows } = await pool.query(`
      WITH on_hand AS (
        SELECT item_id, warehouse_id, SUM(quantity_in - quantity_out) AS qty
          FROM stock_ledger GROUP BY item_id, warehouse_id
      ),
      reserved AS (
        SELECT item_id, warehouse_id, SUM(quantity_remaining) AS qty
          FROM inventory_reservations
         WHERE status IN ('active', 'partially_consumed')
         GROUP BY item_id, warehouse_id
      )
      SELECT ii.item_code,
             ii.item_name,
             w.warehouse_name,
             COALESCE(o.qty, 0)                        AS total_stock,
             COALESCE(r.qty, 0)                        AS reserved_stock,
             COALESCE(o.qty, 0) - COALESCE(r.qty, 0)   AS available_stock
        FROM reserved r
        JOIN inventory_items ii ON ii.id = r.item_id AND ii.deleted_at IS NULL
        JOIN warehouses w       ON w.id = r.warehouse_id AND w.deleted_at IS NULL
        LEFT JOIN on_hand o     ON o.item_id = r.item_id AND o.warehouse_id = r.warehouse_id
       WHERE COALESCE(r.qty, 0) > 0
         AND ($1::INTEGER IS NULL OR w.id = $1)
         AND ($2::INTEGER IS NULL OR ii.company_id = $2)
       ORDER BY reserved_stock DESC`,
      [warehouse_id || null, requireScope(company_id, 'getReservedVsAvailableStock')]);
    return rows;
  }
};

export default advancedInventoryRepository;
