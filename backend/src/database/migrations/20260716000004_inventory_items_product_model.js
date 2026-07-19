/**
 * 20260716000004_inventory_items_product_model.js
 *
 * The Product/Inventory Master grid (ItemMaster.jsx) needs a Product Model
 * column, but inventory_items only ever had `manufacturer` (brand) — no model.
 * Adds a nullable product_model; the grid renders an explicit "NA" for empty
 * values rather than a blank cell, so NULL is the expected resting state.
 */
export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[inventory_items_product_model] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('inventory_items add product_model',
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS product_model VARCHAR(120)`);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  await safe(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS product_model`);
}
