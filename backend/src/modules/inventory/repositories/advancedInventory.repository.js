import pool from '../../shared/db.js';

const advancedInventoryRepository = {
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
  async createBatch(data, client = null) {
    const db = client ?? pool;
    const { item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id, grn_id, quantity_received, rate } = data;
    const result = await db.query(
      `INSERT INTO inventory_batches (item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id, grn_id, quantity_received, quantity_available, rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) RETURNING *`,
      [item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id, grn_id, quantity_received, rate]
    );
    return result.rows[0];
  },

  async getBatches(filters = {}) {
    let query = `SELECT * FROM v_batch_stock WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.item_id) {
      query += ` AND item_id = $${paramCount}`;
      params.push(filters.item_id);
      paramCount++;
    }
    if (filters.warehouse_id) {
      query += ` AND warehouse_id = $${paramCount}`;
      params.push(filters.warehouse_id);
      paramCount++;
    }
    if (filters.status) {
      query += ` AND status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ` ORDER BY received_date DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async updateBatchQuantity(batch_id, quantity_change, operation) {
    const qty = Math.abs(parseFloat(quantity_change));
    if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error('quantity_change must be a positive number'), { status: 422 });

    if (operation === 'consume') {
      const check = await pool.query(`SELECT quantity_available FROM inventory_batches WHERE id = $1`, [batch_id]);
      if (!check.rows[0]) throw Object.assign(new Error('Batch not found'), { status: 404 });
      if (parseFloat(check.rows[0].quantity_available) < qty) {
        throw Object.assign(
          new Error(`Insufficient batch quantity. Available: ${check.rows[0].quantity_available}, Requested: ${qty}`),
          { status: 422 }
        );
      }
    }

    const field = operation === 'consume' ? 'quantity_consumed' : 'quantity_available';
    const result = await pool.query(
      `UPDATE inventory_batches
       SET ${field} = ${field} + $1,
           quantity_available = quantity_available ${operation === 'consume' ? '-' : '+'} $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [qty, batch_id]
    );
    return result.rows[0];
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

      // Serialises concurrent reservations of the same item. Without it two
      // callers both read the same availability and both succeed.
      const { rows: [item] } = await client.query(
        `SELECT id FROM inventory_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [item_id]);
      if (!item) {
        throw Object.assign(new Error(`Item ${item_id} not found`), { status: 404 });
      }

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
    const params = [filters.company_id ?? null];

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

  async consumeReservation(reservation_id, quantity_consumed) {
    const qty = parseFloat(quantity_consumed);
    if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error('quantity_consumed must be a positive number'), { status: 422 });

    const check = await pool.query(`SELECT quantity_remaining FROM inventory_reservations WHERE id = $1`, [reservation_id]);
    if (!check.rows[0]) throw Object.assign(new Error('Reservation not found'), { status: 404 });
    if (parseFloat(check.rows[0].quantity_remaining) < qty) {
      throw Object.assign(
        new Error(`Cannot consume more than remaining. Remaining: ${check.rows[0].quantity_remaining}, Requested: ${qty}`),
        { status: 422 }
      );
    }

    const result = await pool.query(
      `UPDATE inventory_reservations
       SET quantity_consumed = quantity_consumed + $1,
           quantity_remaining = quantity_remaining - $1,
           status = CASE
             WHEN quantity_remaining - $1 <= 0 THEN 'fully_consumed'
             ELSE 'partially_consumed'
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [qty, reservation_id]
    );
    return result.rows[0];
  },

  async cancelReservation(reservation_id) {
    const result = await pool.query(
      `UPDATE inventory_reservations
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [reservation_id]
    );
    return result.rows[0];
  },

  // ==================== ALLOCATIONS ====================
  async createAllocation(data) {
    const { item_id, batch_id, warehouse_id, allocation_type, reference_type, reference_id, quantity, rate, allocation_date, allocated_by, purpose } = data;
    const result = await pool.query(
      `INSERT INTO inventory_allocations 
       (item_id, batch_id, warehouse_id, allocation_type, reference_type, reference_id, quantity, rate, allocation_date, allocated_by, purpose)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [item_id, batch_id, warehouse_id, allocation_type, reference_type, reference_id, quantity, rate, allocation_date, allocated_by, purpose]
    );
    return result.rows[0];
  },

  async getAllocations(filters = {}) {
    let query = `
      SELECT ia.*, ii.item_code, ii.item_name, w.warehouse_name, ib.batch_number
      FROM inventory_allocations ia
      JOIN inventory_items ii ON ia.item_id = ii.id
      JOIN warehouses w ON ia.warehouse_id = w.id
      LEFT JOIN inventory_batches ib ON ia.batch_id = ib.id
      WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.allocation_type) {
      query += ` AND ia.allocation_type = $${paramCount}`;
      params.push(filters.allocation_type);
      paramCount++;
    }
    if (filters.reference_id) {
      query += ` AND ia.reference_id = $${paramCount}`;
      params.push(filters.reference_id);
      paramCount++;
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
      WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND sa.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }
    if (filters.alert_type) {
      query += ` AND sa.alert_type = $${paramCount}`;
      params.push(filters.alert_type);
      paramCount++;
    }

    query += ` ORDER BY sa.alert_date DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async acknowledgeAlert(alert_id, user_id) {
    const result = await pool.query(
      `UPDATE stock_alerts
       SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [user_id, alert_id]
    );
    return result.rows[0];
  },

  async resolveAlert(alert_id) {
    const result = await pool.query(
      `UPDATE stock_alerts
       SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [alert_id]
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
      WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.id) {
      query += ` AND ps.id = $${paramCount}`;
      params.push(filters.id);
      paramCount++;
    }
    if (filters.status) {
      query += ` AND ps.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }
    if (filters.priority) {
      query += ` AND ps.priority = $${paramCount}`;
      params.push(filters.priority);
      paramCount++;
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

  async convertSuggestionToPR(suggestion_id, pr_id, client = pool) {
    const result = await client.query(
      `UPDATE purchase_suggestions
       SET status = 'converted_to_pr', converted_to_pr_id = $1, converted_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [pr_id, suggestion_id]
    );
    return result.rows[0];
  },

  async rejectSuggestion(suggestion_id, user_id, reason) {
    const result = await pool.query(
      `UPDATE purchase_suggestions
       SET status = 'rejected', rejected_by = $1, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $2
       WHERE id = $3 RETURNING *`,
      [user_id, reason, suggestion_id]
    );
    return result.rows[0];
  },

  // ==================== STOCK SUMMARY & ANALYTICS ====================
  async getStockSummary(filters = {}) {
    let query = `SELECT * FROM v_stock_summary WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.warehouse_id) {
      query += ` AND warehouse_id = $${paramCount}`;
      params.push(filters.warehouse_id);
      paramCount++;
    }
    if (filters.stock_status) {
      query += ` AND stock_status = $${paramCount}`;
      params.push(filters.stock_status);
      paramCount++;
    }

    query += ` ORDER BY item_name`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async getAvailableStock(item_id, warehouse_id) {
    const result = await pool.query(
      `SELECT calculate_available_stock($1, $2) as available_stock`,
      [item_id, warehouse_id]
    );
    return result.rows[0].available_stock;
  },

  async getStockAgingReport(warehouse_id = null) {
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
      WHERE status = 'active'`;
    
    const params = [];
    if (warehouse_id) {
      query += ` AND warehouse_id = $1`;
      params.push(warehouse_id);
    }
    
    query += ` GROUP BY age_category ORDER BY MIN(age_days)`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async getMaterialConsumptionByProject(project_id = null) {
    let query = `SELECT * FROM v_material_consumption_by_project`;
    const params = [];
    
    if (project_id) {
      query += ` WHERE project_id = $1`;
      params.push(project_id);
    }
    
    query += ` ORDER BY total_value DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async getDashboardMetrics() {
    const holdingRate = (() => {
      const parsed = Number.parseFloat(process.env.INVENTORY_HOLDING_COST_RATE ?? '0.18');
      if (!Number.isFinite(parsed) || parsed < 0) return 0.18;
      return parsed;
    })();
    const lowStockCount = await pool.query(`SELECT COUNT(*) as count FROM stock_alerts WHERE status = 'active' AND alert_type = 'low_stock'`);
    const activeReservations = await pool.query(`SELECT COUNT(*) as count FROM inventory_reservations WHERE status = 'active'`);
    const pendingSuggestions = await pool.query(`SELECT COUNT(*) as count FROM purchase_suggestions WHERE status = 'pending'`);
    const expiringBatches = await pool.query(`SELECT COUNT(*) as count FROM inventory_batches WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' AND status = 'active'`);
    
    const totalReservedValue = await pool.query(`
      SELECT COALESCE(SUM(ib.quantity_reserved * ib.rate), 0) as value
      FROM inventory_batches ib WHERE status = 'active'
    `);
    
    const totalAvailableValue = await pool.query(`
      SELECT COALESCE(SUM((ib.quantity_available - ib.quantity_reserved) * ib.rate), 0) as value
      FROM inventory_batches ib WHERE status = 'active'
    `);

    const totalAvailableValueNum = parseFloat(totalAvailableValue.rows[0].value);
    return {
      low_stock_alerts: parseInt(lowStockCount.rows[0].count),
      active_reservations: parseInt(activeReservations.rows[0].count),
      pending_suggestions: parseInt(pendingSuggestions.rows[0].count),
      expiring_batches: parseInt(expiringBatches.rows[0].count),
      total_reserved_value: parseFloat(totalReservedValue.rows[0].value),
      total_available_value: totalAvailableValueNum,
      holding_cost_rate_annual: holdingRate,
      total_holding_cost_annual: totalAvailableValueNum * holdingRate,
      total_holding_cost_monthly: (totalAvailableValueNum * holdingRate) / 12
    };
  },

  // Was: SUM(inventory_batches.quantity_reserved) with a
  // `HAVING SUM(quantity_reserved) > 0`. Nothing in the codebase has ever
  // written that column, so the predicate could never pass and this returned an
  // empty array however many reservations existed.
  //
  // Both sides are now derived from the rows that actually record the facts:
  // on-hand from stock_ledger, reserved from the open reservations.
  async getReservedVsAvailableStock(warehouse_id = null, company_id = null) {
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
      [warehouse_id || null, company_id ?? null]);
    return rows;
  }
};

export default advancedInventoryRepository;
