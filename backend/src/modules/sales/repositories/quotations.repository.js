import pool from '../../shared/db.js';

const quotationsRepository = {
  async create(data) {
    const { quotation_number, customer_id, opportunity_id, quotation_date, validity_date, status, notes, created_by } = data;
    const result = await pool.query(
      `INSERT INTO quotations (quotation_number, customer_id, opportunity_id, quotation_date, validity_date, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [quotation_number, customer_id, opportunity_id, quotation_date, validity_date, status, notes, created_by]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT q.*, p.name as customer_name
      FROM quotations q
      LEFT JOIN parties p ON q.customer_id = p.id
      WHERE q.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND q.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    if (filters.customer_id) {
      query += ` AND q.customer_id = $${paramCount}`;
      params.push(filters.customer_id);
      paramCount++;
    }

    query += ` ORDER BY q.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT q.*, p.name as customer_name
       FROM quotations q
       LEFT JOIN parties p ON q.customer_id = p.id
       WHERE q.id = $1 AND q.deleted_at IS NULL`,
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
      `UPDATE quotations SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE quotations SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getNextQuotationNumber() {
    const result = await pool.query(
      `SELECT quotation_number FROM quotations WHERE quotation_number LIKE 'QT-%' ORDER BY created_at DESC LIMIT 1`
    );
    if (result.rows.length === 0) return 'QT-0001';
    const lastNum = result.rows[0].quotation_number;
    const num = parseInt(lastNum.split('-')[1]) + 1;
    return `QT-${num.toString().padStart(4, '0')}`;
  },

  async addItem(data) {
    const { quotation_id, item_description, quantity, rate, tax_percentage } = data;
    const tax_amount = (quantity * rate * tax_percentage) / 100;
    const total = (quantity * rate) + tax_amount;
    
    const result = await pool.query(
      `INSERT INTO quotation_items (quotation_id, item_description, quantity, rate, tax_percentage, tax_amount, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [quotation_id, item_description, quantity, rate, tax_percentage, tax_amount, total]
    );
    
    await this.updateTotals(quotation_id);
    return result.rows[0];
  },

  async getItems(quotation_id) {
    const result = await pool.query(
      `SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY created_at`,
      [quotation_id]
    );
    return result.rows;
  },

  async updateTotals(quotation_id) {
    const result = await pool.query(`
      SELECT 
        SUM(total - tax_amount) as subtotal,
        SUM(tax_amount) as tax_amount,
        SUM(total) as total_amount
      FROM quotation_items
      WHERE quotation_id = $1
    `, [quotation_id]);

    const { subtotal, tax_amount, total_amount } = result.rows[0];
    
    await pool.query(
      `UPDATE quotations SET subtotal = $1, tax_amount = $2, total_amount = $3 WHERE id = $4`,
      [subtotal || 0, tax_amount || 0, total_amount || 0, quotation_id]
    );
  }
};

export default quotationsRepository;
