import pool from '../../shared/db.js';

class InventoryItemRepository {
  async create(data) {
    const { item_code, item_name, item_type, unit_of_measure, reorder_level, standard_cost, inventory_account_id, expense_account_id, description } = data;
    const result = await pool.query(
      `INSERT INTO inventory_items (item_code, item_name, item_type, unit_of_measure, reorder_level, standard_cost, inventory_account_id, expense_account_id, description) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [item_code, item_name, item_type, unit_of_measure, reorder_level, standard_cost, inventory_account_id, expense_account_id, description]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = 'SELECT * FROM inventory_items WHERE deleted_at IS NULL';
    const params = [];
    
    if (filters.item_type) {
      params.push(filters.item_type);
      query += ` AND item_type = $${params.length}`;
    }
    
    if (filters.is_active !== undefined) {
      params.push(filters.is_active);
      query += ` AND is_active = $${params.length}`;
    }
    
    query += ' ORDER BY item_code';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM inventory_items WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    return result.rows[0];
  }

  async update(id, data) {
    const { item_name, reorder_level, standard_cost, description, is_active } = data;
    const result = await pool.query(
      `UPDATE inventory_items 
       SET item_name = $1, reorder_level = $2, standard_cost = $3, description = $4, is_active = $5, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $6 RETURNING *`,
      [item_name, reorder_level, standard_cost, description, is_active, id]
    );
    return result.rows[0];
  }

  async getNextCode() {
    const result = await pool.query(
      `SELECT item_code FROM inventory_items 
       WHERE item_code LIKE 'ITEM%' 
       ORDER BY item_code DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'ITEM0001';
    }
    
    const lastNum = parseInt(result.rows[0].item_code.replace('ITEM', '')) + 1;
    return `ITEM${lastNum.toString().padStart(4, '0')}`;
  }
}

export default new InventoryItemRepository();
