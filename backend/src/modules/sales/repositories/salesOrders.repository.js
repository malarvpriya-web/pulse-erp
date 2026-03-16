import pool from '../../shared/db.js';

const salesOrdersRepository = {
  async create(data) {
    const { order_number, quotation_id, customer_id, order_date, delivery_date, order_status, notes, created_by } = data;
    const result = await pool.query(
      `INSERT INTO sales_orders (order_number, quotation_id, customer_id, order_date, delivery_date, order_status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [order_number, quotation_id, customer_id, order_date, delivery_date, order_status, notes, created_by]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT so.*, p.name as customer_name
      FROM sales_orders so
      LEFT JOIN parties p ON so.customer_id = p.id
      WHERE so.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.order_status) {
      query += ` AND so.order_status = $${paramCount}`;
      params.push(filters.order_status);
      paramCount++;
    }

    if (filters.customer_id) {
      query += ` AND so.customer_id = $${paramCount}`;
      params.push(filters.customer_id);
      paramCount++;
    }

    query += ` ORDER BY so.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT so.*, p.name as customer_name
       FROM sales_orders so
       LEFT JOIN parties p ON so.customer_id = p.id
       WHERE so.id = $1 AND so.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE sales_orders SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE sales_orders SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getNextOrderNumber() {
    const result = await pool.query(
      `SELECT order_number FROM sales_orders WHERE order_number LIKE 'SO-%' ORDER BY created_at DESC LIMIT 1`
    );
    if (result.rows.length === 0) return 'SO-0001';
    const lastNum = result.rows[0].order_number;
    const num = parseInt(lastNum.split('-')[1]) + 1;
    return `SO-${num.toString().padStart(4, '0')}`;
  },

  async addItem(data) {
    const { order_id, item_description, quantity, rate, tax_percentage } = data;
    const tax_amount = (quantity * rate * tax_percentage) / 100;
    const total = (quantity * rate) + tax_amount;
    
    const result = await pool.query(
      `INSERT INTO sales_order_items (order_id, item_description, quantity, rate, tax_percentage, tax_amount, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [order_id, item_description, quantity, rate, tax_percentage, tax_amount, total]
    );
    
    await this.updateTotals(order_id);
    return result.rows[0];
  },

  async getItems(order_id) {
    const result = await pool.query(
      `SELECT * FROM sales_order_items WHERE order_id = $1 ORDER BY created_at`,
      [order_id]
    );
    return result.rows;
  },

  async updateTotals(order_id) {
    const result = await pool.query(`
      SELECT 
        SUM(total - tax_amount) as subtotal,
        SUM(tax_amount) as tax_amount,
        SUM(total) as total_amount
      FROM sales_order_items
      WHERE order_id = $1
    `, [order_id]);

    const { subtotal, tax_amount, total_amount } = result.rows[0];
    
    await pool.query(
      `UPDATE sales_orders SET subtotal = $1, tax_amount = $2, total_amount = $3 WHERE id = $4`,
      [subtotal || 0, tax_amount || 0, total_amount || 0, order_id]
    );
  },

  async getMonthlyRevenue() {
    const result = await pool.query(`
      SELECT 
        DATE_TRUNC('month', order_date) as month,
        SUM(total_amount) as revenue,
        COUNT(*) as order_count
      FROM sales_orders
      WHERE deleted_at IS NULL AND order_status = 'completed'
      GROUP BY DATE_TRUNC('month', order_date)
      ORDER BY month DESC
      LIMIT 12
    `);
    return result.rows;
  },

  async getTopCustomers(limit = 10) {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.name,
        SUM(so.total_amount) as total_revenue,
        COUNT(so.id) as order_count
      FROM sales_orders so
      JOIN parties p ON so.customer_id = p.id
      WHERE so.deleted_at IS NULL AND so.order_status = 'completed'
      GROUP BY p.id, p.name
      ORDER BY total_revenue DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }
};

export default salesOrdersRepository;
