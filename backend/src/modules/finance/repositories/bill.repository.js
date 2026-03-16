import pool from '../db.js';

class BillRepository {
  async create(client, data) {
    const { bill_number, supplier_id, bill_date, due_date, subtotal, tax_amount, total_amount, notes, created_by } = data;
    const result = await client.query(
      `INSERT INTO bills (bill_number, supplier_id, bill_date, due_date, subtotal, tax_amount, total_amount, balance, notes, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9) RETURNING *`,
      [bill_number, supplier_id, bill_date, due_date, subtotal, tax_amount, total_amount, notes, created_by]
    );
    return result.rows[0];
  }

  async createItem(client, data) {
    const { bill_id, description, quantity, unit_price, tax_rate, amount } = data;
    const result = await client.query(
      `INSERT INTO bill_items (bill_id, description, quantity, unit_price, tax_rate, amount) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [bill_id, description, quantity, unit_price, tax_rate, amount]
    );
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT b.*,
              COALESCE(p.name, b.party_name) as supplier_name,
              p.email as supplier_email, p.phone as supplier_phone
       FROM bills b
       LEFT JOIN parties p ON b.supplier_id = p.id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT b.*,
                        COALESCE(p.name, b.party_name) as supplier_name
                 FROM bills b
                 LEFT JOIN parties p ON b.supplier_id = p.id
                 WHERE b.deleted_at IS NULL`;
    const params = [];
    
    if (filters.status) {
      params.push(filters.status);
      query += ` AND b.status = $${params.length}`;
    }
    
    if (filters.approval_status) {
      params.push(filters.approval_status);
      query += ` AND b.approval_status = $${params.length}`;
    }
    
    if (filters.supplier_id) {
      params.push(filters.supplier_id);
      query += ` AND b.supplier_id = $${params.length}`;
    }
    
    query += ' ORDER BY b.bill_date DESC, b.bill_number DESC';
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  async getItems(billId) {
    const result = await pool.query(
      'SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY created_at',
      [billId]
    );
    return result.rows;
  }

  async approve(client, id, approvedBy) {
    const result = await client.query(
      `UPDATE bills 
       SET approval_status = 'Approved', status = 'Approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 RETURNING *`,
      [approvedBy, id]
    );
    return result.rows[0];
  }

  async updatePayment(client, id, paidAmount) {
    const result = await client.query(
      `UPDATE bills 
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
      'UPDATE bills SET journal_entry_id = $1 WHERE id = $2 RETURNING *',
      [journalEntryId, id]
    );
    return result.rows[0];
  }

  async getDueSoon(days = 7) {
    const result = await pool.query(
      `SELECT b.*,
              COALESCE(p.name, b.party_name) as supplier_name,
              p.email as supplier_email
       FROM bills b
       LEFT JOIN parties p ON b.supplier_id = p.id
       WHERE b.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1
       AND b.status NOT IN ('paid', 'Paid', 'Cancelled', 'cancelled')
       AND b.deleted_at IS NULL
       ORDER BY b.due_date`,
      [days]
    );
    return result.rows;
  }

  async getNextNumber() {
    const result = await pool.query(
      `SELECT bill_number FROM bills 
       WHERE bill_number LIKE 'BILL%' 
       ORDER BY bill_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'BILL0001';
    }
    
    const lastNum = parseInt(result.rows[0].bill_number.replace('BILL', '')) + 1;
    return `BILL${lastNum.toString().padStart(4, '0')}`;
  }
}

export default new BillRepository();
