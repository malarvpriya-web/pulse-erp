import pool from '../db.js';

class InvoiceRepository {
  async create(client, data) {
    const { invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, total_amount, notes, created_by } = data;
    const result = await client.query(
      `INSERT INTO invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, total_amount, balance, notes, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9) RETURNING *`,
      [invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, total_amount, notes, created_by]
    );
    return result.rows[0];
  }

  async createItem(client, data) {
    const { invoice_id, description, quantity, unit_price, tax_rate, amount } = data;
    const result = await client.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, tax_rate, amount) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [invoice_id, description, quantity, unit_price, tax_rate, amount]
    );
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT i.*,
              COALESCE(p.name, i.party_name) as customer_name,
              p.email as customer_email, p.phone as customer_phone
       FROM invoices i
       LEFT JOIN parties p ON i.customer_id = p.id
       WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT i.*,
                        COALESCE(p.name, i.party_name) as customer_name
                 FROM invoices i
                 LEFT JOIN parties p ON i.customer_id = p.id
                 WHERE i.deleted_at IS NULL`;
    const params = [];
    
    if (filters.status) {
      params.push(filters.status);
      query += ` AND i.status = $${params.length}`;
    }
    
    if (filters.customer_id) {
      params.push(filters.customer_id);
      query += ` AND i.customer_id = $${params.length}`;
    }
    
    if (filters.from_date) {
      params.push(filters.from_date);
      query += ` AND i.invoice_date >= $${params.length}`;
    }
    
    if (filters.to_date) {
      params.push(filters.to_date);
      query += ` AND i.invoice_date <= $${params.length}`;
    }
    
    query += ' ORDER BY i.invoice_date DESC, i.invoice_number DESC';
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  async getItems(invoiceId) {
    const result = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at',
      [invoiceId]
    );
    return result.rows;
  }

  async updateStatus(client, id, status) {
    const result = await client.query(
      'UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [status, id]
    );
    return result.rows[0];
  }

  async updatePayment(client, id, paidAmount) {
    const result = await client.query(
      `UPDATE invoices 
       SET paid_amount = paid_amount + $1, 
           balance = total_amount - (paid_amount + $1),
           status = CASE WHEN total_amount - (paid_amount + $1) <= 0 THEN 'Paid' ELSE status END,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 RETURNING *`,
      [paidAmount, id]
    );
    return result.rows[0];
  }

  async linkJournalEntry(client, id, journalEntryId) {
    const result = await client.query(
      'UPDATE invoices SET journal_entry_id = $1 WHERE id = $2 RETURNING *',
      [journalEntryId, id]
    );
    return result.rows[0];
  }

  async getOverdue() {
    const result = await pool.query(
      `SELECT i.*,
              COALESCE(p.name, i.party_name) as customer_name,
              p.email as customer_email
       FROM invoices i
       LEFT JOIN parties p ON i.customer_id = p.id
       WHERE i.due_date < CURRENT_DATE
       AND i.status NOT IN ('paid', 'Paid', 'Cancelled', 'cancelled')
       AND i.deleted_at IS NULL
       ORDER BY i.due_date`
    );
    return result.rows;
  }

  async getDueSoon(days = 7) {
    const result = await pool.query(
      `SELECT i.*,
              COALESCE(p.name, i.party_name) as customer_name,
              p.email as customer_email
       FROM invoices i
       LEFT JOIN parties p ON i.customer_id = p.id
       WHERE i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1
       AND i.status NOT IN ('paid', 'Paid', 'Cancelled', 'cancelled')
       AND i.deleted_at IS NULL
       ORDER BY i.due_date`,
      [days]
    );
    return result.rows;
  }

  async getNextNumber() {
    const result = await pool.query(
      `SELECT invoice_number FROM invoices 
       WHERE invoice_number LIKE 'INV%' 
       ORDER BY invoice_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'INV0001';
    }
    
    const lastNum = parseInt(result.rows[0].invoice_number.replace('INV', '')) + 1;
    return `INV${lastNum.toString().padStart(4, '0')}`;
  }
}

export default new InvoiceRepository();
