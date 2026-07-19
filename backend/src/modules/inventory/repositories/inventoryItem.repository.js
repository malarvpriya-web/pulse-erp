import pool from '../../shared/db.js';
import { nextItemCode } from '../../../shared/docNumber.js';

// ABC class is a manual A/B/C override; anything else (blank, junk) stores NULL
// so the dashboards fall back to the auto-computed class.
function normalizeAbc(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return ['A', 'B', 'C'].includes(s) ? s : null;
}

class InventoryItemRepository {
  async create(data) {
    const {
      item_code, item_name, item_type, unit_of_measure,
      reorder_level, safety_stock, standard_cost,
      inventory_account_id, expense_account_id,
      hsn_code, gst_rate, manufacturer, lead_time_days,
      description, company_id,
      category_id, abc_class, product_model,
    } = data;

    const result = await pool.query(
      `INSERT INTO inventory_items
         (item_code, item_name, item_type, unit_of_measure,
          reorder_level, safety_stock, standard_cost,
          inventory_account_id, expense_account_id,
          hsn_code, gst_rate, manufacturer, lead_time_days,
          description, company_id, category_id, abc_class, product_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        item_code, item_name, item_type ?? null, unit_of_measure ?? 'pcs',
        reorder_level ?? 0, safety_stock ?? 0, standard_cost ?? 0,
        inventory_account_id ?? null, expense_account_id ?? null,
        hsn_code ?? null, gst_rate ?? 0, manufacturer ?? null, lead_time_days ?? 7,
        description ?? null, company_id ?? null,
        category_id || null, normalizeAbc(abc_class), product_model || null,
      ]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    const params = [];

    // Per-store balance when warehouse_id is supplied, global on-hand otherwise.
    // Correlated subquery + COALESCE keeps zero-balance items in the catalog
    // (global-catalog + per-store-balance model — see project_itemmaster_audit_gaps).
    let stockWhCond = '';
    if (filters.warehouse_id != null && filters.warehouse_id !== '') {
      params.push(filters.warehouse_id);
      stockWhCond = ` AND sl.warehouse_id = $${params.length}`;
    }

    let query = `
      SELECT ii.*,
             c.name          AS category_name,
             c.category_code AS category_code,
             COALESCE((
               SELECT SUM(sl.quantity_in - sl.quantity_out)
                 FROM stock_ledger sl
                WHERE sl.item_id = ii.id${stockWhCond}
             ), 0) AS current_stock,
             (SELECT COUNT(*)::int FROM item_vendor_prices ivp
               WHERE ivp.item_id = ii.id AND ivp.deleted_at IS NULL) AS vendor_price_count
        FROM inventory_items ii
        LEFT JOIN item_categories c ON c.id = ii.category_id AND c.deleted_at IS NULL
       WHERE ii.deleted_at IS NULL`;

    if (filters.company_id != null) {
      params.push(filters.company_id);
      query += ` AND ii.company_id = $${params.length}`;
    }

    if (filters.item_type) {
      params.push(filters.item_type);
      query += ` AND ii.item_type = $${params.length}`;
    }

    if (filters.category_id) {
      params.push(filters.category_id);
      query += ` AND ii.category_id = $${params.length}`;
    }

    if (filters.abc_class) {
      params.push(String(filters.abc_class).toUpperCase());
      query += ` AND ii.abc_class = $${params.length}`;
    }

    if (filters.search) {
      params.push(`%${filters.search}%`);
      const p = params.length;
      query += ` AND (ii.item_name ILIKE $${p} OR ii.item_code ILIKE $${p})`;
    }

    if (filters.is_active !== undefined) {
      params.push(filters.is_active);
      query += ` AND ii.is_active = $${params.length}`;
    }

    query += ' ORDER BY ii.item_code';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id, company_id = null) {
    const params = [id];
    let query = `
      SELECT ii.*,
             c.name          AS category_name,
             c.category_code AS category_code
        FROM inventory_items ii
        LEFT JOIN item_categories c ON c.id = ii.category_id AND c.deleted_at IS NULL
       WHERE ii.id = $1 AND ii.deleted_at IS NULL`;
    if (company_id != null) {
      params.push(company_id);
      query += ` AND ii.company_id = $${params.length}`;
    }
    const result = await pool.query(query, params);
    return result.rows[0];
  }

  async update(id, data, company_id = null) {
    const {
      item_name, item_type, unit_of_measure,
      reorder_level, safety_stock, standard_cost,
      hsn_code, gst_rate, manufacturer, lead_time_days,
      description, is_active,
      category_id, abc_class, product_model,
    } = data;
    const params = [
      item_name, item_type ?? null, unit_of_measure ?? 'pcs',
      reorder_level ?? 0, safety_stock ?? 0, standard_cost ?? 0,
      hsn_code ?? null, gst_rate ?? 0, manufacturer ?? null, lead_time_days ?? 7,
      description ?? null, is_active ?? true,
      category_id || null, normalizeAbc(abc_class), product_model || null,
      id,
    ];
    let whereClause = 'WHERE id = $16 AND deleted_at IS NULL';
    if (company_id != null) {
      params.push(company_id);
      whereClause += ` AND company_id = $${params.length}`;
    }
    const result = await pool.query(
      `UPDATE inventory_items
       SET item_name       = $1,
           item_type       = $2,
           unit_of_measure = $3,
           reorder_level   = $4,
           safety_stock    = $5,
           standard_cost   = $6,
           hsn_code        = $7,
           gst_rate        = $8,
           manufacturer    = $9,
           lead_time_days  = $10,
           description     = $11,
           is_active       = $12,
           category_id     = $13,
           abc_class       = $14,
           product_model   = $15,
           updated_at      = CURRENT_TIMESTAMP
       ${whereClause}
       RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  async softDelete(id, company_id = null) {
    const params = [id];
    let whereClause = 'WHERE id = $1 AND deleted_at IS NULL';
    if (company_id != null) {
      params.push(company_id);
      whereClause += ` AND company_id = $${params.length}`;
    }
    const result = await pool.query(
      `UPDATE inventory_items SET deleted_at = NOW() ${whereClause} RETURNING id`,
      params
    );
    return result.rows[0] || null;
  }

  async getNextCode(client) {
    return nextItemCode(client);
  }
}

export default new InventoryItemRepository();
