import pool from '../../shared/db.js';

const advancedInventoryRepository = {
  // ==================== BATCH MANAGEMENT ====================
  async createBatch(data) {
    const { item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id, grn_id, quantity_received, rate } = data;
    const result = await pool.query(
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
  async createReservation(data) {
    const { item_id, warehouse_id, batch_id, reservation_type, reference_type, reference_id, reference_number, quantity_reserved, reserved_date, expiry_date, reserved_by, notes } = data;
    const result = await pool.query(
      `INSERT INTO inventory_reservations 
       (item_id, warehouse_id, batch_id, reservation_type, reference_type, reference_id, reference_number, quantity_reserved, quantity_remaining, reserved_date, expiry_date, reserved_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12) RETURNING *`,
      [item_id, warehouse_id, batch_id, reservation_type, reference_type, reference_id, reference_number, quantity_reserved, reserved_date, expiry_date, reserved_by, notes]
    );
    return result.rows[0];
  },

  async getReservations(filters = {}) {
    let query = `
      SELECT ir.*, ii.item_code, ii.item_name, w.warehouse_name, ib.batch_number
      FROM inventory_reservations ir
      JOIN inventory_items ii ON ir.item_id = ii.id
      JOIN warehouses w ON ir.warehouse_id = w.id
      LEFT JOIN inventory_batches ib ON ir.batch_id = ib.id
      WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.item_id) {
      query += ` AND ir.item_id = $${paramCount}`;
      params.push(filters.item_id);
      paramCount++;
    }
    if (filters.reference_type) {
      query += ` AND ir.reference_type = $${paramCount}`;
      params.push(filters.reference_type);
      paramCount++;
    }
    if (filters.reference_id) {
      query += ` AND ir.reference_id = $${paramCount}`;
      params.push(filters.reference_id);
      paramCount++;
    }
    if (filters.status) {
      query += ` AND ir.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
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
      SELECT ps.*, ii.item_code, ii.item_name, ii.unit_of_measure, w.warehouse_name
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

  async convertSuggestionToPR(suggestion_id, pr_id) {
    const result = await pool.query(
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

  async getReservedVsAvailableStock(warehouse_id = null) {
    let query = `
      SELECT 
        ii.item_code,
        ii.item_name,
        w.warehouse_name,
        SUM(ib.quantity_available) as total_stock,
        SUM(ib.quantity_reserved) as reserved_stock,
        SUM(ib.quantity_available - ib.quantity_reserved) as available_stock
      FROM inventory_batches ib
      JOIN inventory_items ii ON ib.item_id = ii.id
      JOIN warehouses w ON ib.warehouse_id = w.id
      WHERE ib.status = 'active'`;
    
    const params = [];
    if (warehouse_id) {
      query += ` AND ib.warehouse_id = $1`;
      params.push(warehouse_id);
    }
    
    query += ` GROUP BY ii.item_code, ii.item_name, w.warehouse_name
               HAVING SUM(ib.quantity_reserved) > 0
               ORDER BY reserved_stock DESC`;
    
    const result = await pool.query(query, params);
    return result.rows;
  }
};

export default advancedInventoryRepository;
