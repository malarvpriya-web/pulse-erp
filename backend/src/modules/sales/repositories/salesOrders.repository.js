import pool from '../../shared/db.js';
import { nextSalesOrderNumber } from '../../../shared/docNumber.js';

const ORDER_COLUMNS = new Set([
  'order_number', 'quotation_id', 'customer_id', 'order_date', 'delivery_date',
  'order_status', 'notes', 'carrier', 'tracking_number',
  'subtotal', 'tax_amount', 'total_amount',
]);

const salesOrdersRepository = {
  async create(data) {
    const {
      order_number, quotation_id, company_id, customer_id, customer_name,
      order_date, delivery_date, order_status, notes, created_by,
      subtotal, tax_amount, total_amount, supply_type,
    } = data;
    const result = await pool.query(
      `INSERT INTO sales_orders
         (order_number, quotation_id, company_id, customer_id, customer_name,
          order_date, delivery_date, order_status, notes, created_by,
          subtotal, tax_amount, total_amount, supply_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        order_number, quotation_id ?? null, company_id, customer_id ?? null, customer_name ?? null,
        order_date, delivery_date ?? null, order_status ?? 'draft', notes ?? null, created_by,
        subtotal ?? 0, tax_amount ?? 0, total_amount ?? 0,
        supply_type === 'inter' ? 'inter' : 'intra',
      ]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    const params = [];
    let paramCount = 1;

    let query = `
      SELECT
        so.*,
        COALESCE(so.customer_name, p.name) AS customer_name,
        so.order_status AS status,
        COUNT(soi.id)::int AS item_count
      FROM sales_orders so
      LEFT JOIN parties p ON p.id = so.customer_id
      LEFT JOIN sales_order_items soi ON soi.order_id = so.id
      WHERE so.deleted_at IS NULL
    `;

    if (filters.company_id) {
      query += ` AND so.company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

    if (filters.order_status && filters.order_status !== 'all') {
      query += ` AND so.order_status = $${paramCount}`;
      params.push(filters.order_status);
      paramCount++;
    }

    if (filters.customer_id) {
      query += ` AND so.customer_id = $${paramCount}`;
      params.push(filters.customer_id);
      paramCount++;
    }

    if (filters.search) {
      query += ` AND (so.order_number ILIKE $${paramCount} OR COALESCE(so.customer_name, p.name) ILIKE $${paramCount})`;
      params.push(`%${filters.search}%`);
      paramCount++;
    }

    query += ` GROUP BY so.id, p.name ORDER BY so.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT so.*, p.name as customer_name, so.order_status as status
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
      if (ORDER_COLUMNS.has(key) && data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    if (fields.length === 0) {
      const result = await pool.query('SELECT * FROM sales_orders WHERE id = $1 AND deleted_at IS NULL', [id]);
      return result.rows[0];
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE sales_orders SET ${fields.join(', ')} WHERE id = $${paramCount} AND deleted_at IS NULL RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE sales_orders SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getNextOrderNumber(client) {
    return nextSalesOrderNumber(client);
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

  async getMonthlyRevenue(companyId) {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC('month', order_date) as month,
        SUM(total_amount) as revenue,
        COUNT(*) as order_count
      FROM sales_orders
      WHERE deleted_at IS NULL AND order_status IN ('delivered', 'invoiced')
        AND ($1::int IS NULL OR company_id = $1)
      GROUP BY DATE_TRUNC('month', order_date)
      ORDER BY month DESC
      LIMIT 12
    `, [companyId || null]);
    return result.rows;
  },

  async getTopCustomers(limit = 10, companyId) {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        SUM(so.total_amount) as total_revenue,
        COUNT(so.id) as order_count
      FROM sales_orders so
      JOIN parties p ON so.customer_id = p.id
      WHERE so.deleted_at IS NULL AND so.order_status IN ('delivered', 'invoiced')
        AND ($2::int IS NULL OR so.company_id = $2)
      GROUP BY p.id, p.name
      ORDER BY total_revenue DESC
      LIMIT $1
    `, [limit, companyId || null]);
    return result.rows;
  }
};

export default salesOrdersRepository;
