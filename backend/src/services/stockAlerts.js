import pool from '../config/db.js';
import { suggestedOrderQuantity } from '../modules/inventory/services/inventoryPlanning.service.js';

// Checks an item's current stock against its reorder level and creates
// a low_stock alert if needed. Idempotent — skips if an active alert already
// exists for this item/warehouse pair. Never throws.
export async function checkAndCreateAlerts(itemId, warehouseId) {
  try {
    if (!itemId || !warehouseId) return;

    const itemRes = await pool.query(
      `SELECT reorder_level, min_order_qty, max_order_qty, lot_size_qty, eoq
         FROM inventory_items WHERE id = $1`,
      [itemId]
    );
    if (!itemRes.rows.length) return;
    const item = itemRes.rows[0];
    const reorderLevel = parseFloat(item.reorder_level) || 0;

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
    if (!existing.rows.length) {
      await pool.query(
        `INSERT INTO stock_alerts
           (item_id, warehouse_id, alert_type, status, alert_date)
         VALUES ($1, $2, 'low_stock', 'active', CURRENT_DATE)`,
        [itemId, warehouseId]
      );
    }

    // purchase_suggestions was a fully-built, fully-dead parallel path — the
    // Suggestions tab (StockAlertsAndSuggestions.jsx) reads/converts/rejects
    // it, but nothing ever populated a row. Piggyback on the same reorder
    // breach this function already detects (idempotent per pending suggestion,
    // same as the alert above).
    const existingSuggestion = await pool.query(
      `SELECT id FROM purchase_suggestions
       WHERE item_id = $1 AND warehouse_id = $2 AND status = 'pending'
       LIMIT 1`,
      [itemId, warehouseId]
    );
    if (!existingSuggestion.rows.length) {
      // Was `max(reorderLevel*2 - stock, minOrderQty, reorderLevel)` — a third
      // independent reinvention of the order quantity, owing nothing to demand,
      // ordering cost or holding cost while inventory_items.eoq sat unread.
      // One service decides it now, and returns the basis with it.
      const { quantity: suggestedQty } = suggestedOrderQuantity(item, currentStock, 0);
      const priority = currentStock <= 0 ? 'high' : (currentStock <= reorderLevel / 2 ? 'medium' : 'low');
      await pool.query(
        `INSERT INTO purchase_suggestions
           (item_id, warehouse_id, suggested_quantity, priority, status, generated_date)
         VALUES ($1, $2, $3, $4, 'pending', CURRENT_DATE)`,
        [itemId, warehouseId, suggestedQty, priority]
      );
    }
  } catch {
    // Non-fatal — alert failure must never block the parent transaction
  }
}
