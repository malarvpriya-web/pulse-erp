import pool from '../config/db.js';

// Checks an item's current stock against its reorder level and creates
// a low_stock alert if needed. Idempotent — skips if an active alert already
// exists for this item/warehouse pair. Never throws.
export async function checkAndCreateAlerts(itemId, warehouseId) {
  try {
    if (!itemId || !warehouseId) return;

    const itemRes = await pool.query(
      `SELECT reorder_level FROM inventory_items WHERE id = $1`,
      [itemId]
    );
    if (!itemRes.rows.length) return;
    const reorderLevel = parseFloat(itemRes.rows[0].reorder_level) || 0;

    const stockRes = await pool.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS current_stock
       FROM stock_ledger
       WHERE item_id = $1 AND warehouse_id = $2`,
      [itemId, warehouseId]
    );
    const currentStock = parseFloat(stockRes.rows[0].current_stock);

    if (currentStock > reorderLevel) return;

    // Idempotent: only insert if no active alert already exists
    const existing = await pool.query(
      `SELECT id FROM stock_alerts
       WHERE item_id = $1 AND warehouse_id = $2
         AND alert_type = 'low_stock' AND status = 'active'
       LIMIT 1`,
      [itemId, warehouseId]
    );
    if (existing.rows.length) return;

    await pool.query(
      `INSERT INTO stock_alerts
         (item_id, warehouse_id, alert_type, status, alert_date)
       VALUES ($1, $2, 'low_stock', 'active', CURRENT_DATE)`,
      [itemId, warehouseId]
    );
  } catch {
    // Non-fatal — alert failure must never block the parent transaction
  }
}
