import pool from '../../shared/db.js';

class StockLedgerRepository {
  async createEntry(client, data) {
    const { item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate, reference_type, reference_id, transaction_date, remarks, created_by } = data;
    
    // Get current balance
    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) as balance 
       FROM stock_ledger 
       WHERE item_id = $1 AND warehouse_id = $2`,
      [item_id, warehouse_id]
    );
    
    const currentBalance = parseFloat(balanceResult.rows[0].balance);
    const newBalance = currentBalance + parseFloat(quantity_in || 0) - parseFloat(quantity_out || 0);
    const value = (parseFloat(quantity_in || 0) - parseFloat(quantity_out || 0)) * parseFloat(rate || 0);
    
    const result = await client.query(
      `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value, reference_type, reference_id, transaction_date, remarks, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [item_id, warehouse_id, transaction_type, quantity_in, quantity_out, newBalance, rate, value, reference_type, reference_id, transaction_date, remarks, created_by]
    );
    
    return result.rows[0];
  }

  async getStockBalance(itemId, warehouseId) {
    const result = await pool.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) as balance 
       FROM stock_ledger 
       WHERE item_id = $1 AND warehouse_id = $2`,
      [itemId, warehouseId]
    );
    return parseFloat(result.rows[0].balance);
  }

  async getStockSummary(filters = {}) {
    let query = `SELECT 
                  ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.reorder_level,
                  w.id as warehouse_id, w.warehouse_name,
                  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as balance,
                  COALESCE(AVG(sl.rate), 0) as avg_rate
                 FROM inventory_items ii
                 CROSS JOIN warehouses w
                 LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
                 WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL`;
    const params = [];
    
    if (filters.item_id) {
      params.push(filters.item_id);
      query += ` AND ii.id = $${params.length}`;
    }
    
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      query += ` AND w.id = $${params.length}`;
    }
    
    if (filters.item_type) {
      params.push(filters.item_type);
      query += ` AND ii.item_type = $${params.length}`;
    }
    
    query += ' GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.reorder_level, w.id, w.warehouse_name';
    query += ' HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0';
    query += ' ORDER BY ii.item_code, w.warehouse_name';
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  async getLowStockItems() {
    const result = await pool.query(
      `SELECT 
        ii.id, ii.item_code, ii.item_name, ii.reorder_level,
        w.warehouse_name,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as balance
       FROM inventory_items ii
       CROSS JOIN warehouses w
       LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
       WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL
       GROUP BY ii.id, ii.item_code, ii.item_name, ii.reorder_level, w.warehouse_name
       HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= ii.reorder_level
       ORDER BY ii.item_code`
    );
    return result.rows;
  }

  async getStockMovement(itemId, warehouseId, startDate, endDate) {
    const result = await pool.query(
      `SELECT sl.*, ii.item_code, ii.item_name 
       FROM stock_ledger sl
       JOIN inventory_items ii ON sl.item_id = ii.id
       WHERE sl.item_id = $1 AND sl.warehouse_id = $2 
       AND sl.transaction_date BETWEEN $3 AND $4
       ORDER BY sl.transaction_date DESC, sl.created_at DESC`,
      [itemId, warehouseId, startDate, endDate]
    );
    return result.rows;
  }

  async getInventoryValuation(warehouseId = null) {
    let query = `SELECT 
                  ii.item_code, ii.item_name, ii.item_type,
                  w.warehouse_name,
                  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as balance,
                  COALESCE(AVG(sl.rate), 0) as avg_rate,
                  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * COALESCE(AVG(sl.rate), 0) as value
                 FROM inventory_items ii
                 CROSS JOIN warehouses w
                 LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
                 WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL`;
    const params = [];
    
    if (warehouseId) {
      params.push(warehouseId);
      query += ` AND w.id = $${params.length}`;
    }
    
    query += ' GROUP BY ii.item_code, ii.item_name, ii.item_type, w.warehouse_name';
    query += ' HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0';
    query += ' ORDER BY value DESC';
    
    const result = await pool.query(query, params);
    return result.rows;
  }
}

export default new StockLedgerRepository();
