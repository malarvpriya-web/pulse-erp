import pool from '../db.js';

class PaymentRepository {
  async create(client, data) {
    const { payment_number, payment_date, payment_type, party_id, amount, payment_method, reference_number, notes, created_by } = data;
    const result = await client.query(
      `INSERT INTO payments (payment_number, payment_date, payment_type, party_id, amount, payment_method, reference_number, notes, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [payment_number, payment_date, payment_type, party_id, amount, payment_method, reference_number, notes, created_by]
    );
    return result.rows[0];
  }

  async createAllocation(client, data) {
    const { payment_id, bill_id, allocated_amount } = data;
    const result = await client.query(
      `INSERT INTO payment_allocations (payment_id, bill_id, allocated_amount) 
       VALUES ($1, $2, $3) RETURNING *`,
      [payment_id, bill_id, allocated_amount]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT p.*, pt.name as party_name 
                 FROM payments p
                 LEFT JOIN parties pt ON p.party_id = pt.id
                 WHERE p.deleted_at IS NULL`;
    const params = [];
    
    if (filters.payment_type) {
      params.push(filters.payment_type);
      query += ` AND p.payment_type = $${params.length}`;
    }
    
    if (filters.from_date) {
      params.push(filters.from_date);
      query += ` AND p.payment_date >= $${params.length}`;
    }
    
    if (filters.to_date) {
      params.push(filters.to_date);
      query += ` AND p.payment_date <= $${params.length}`;
    }
    
    query += ' ORDER BY p.payment_date DESC';
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  async linkJournalEntry(client, id, journalEntryId) {
    const result = await client.query(
      'UPDATE payments SET journal_entry_id = $1 WHERE id = $2 RETURNING *',
      [journalEntryId, id]
    );
    return result.rows[0];
  }

  async getNextNumber() {
    const result = await pool.query(
      `SELECT payment_number FROM payments 
       WHERE payment_number LIKE 'PAY%' 
       ORDER BY payment_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'PAY0001';
    }
    
    const lastNum = parseInt(result.rows[0].payment_number.replace('PAY', '')) + 1;
    return `PAY${lastNum.toString().padStart(4, '0')}`;
  }
}

class ReceiptRepository {
  async create(client, data) {
    const { receipt_number, receipt_date, customer_id, amount, payment_method, reference_number, notes, created_by } = data;
    const result = await client.query(
      `INSERT INTO receipts (receipt_number, receipt_date, customer_id, amount, payment_method, reference_number, notes, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [receipt_number, receipt_date, customer_id, amount, payment_method, reference_number, notes, created_by]
    );
    return result.rows[0];
  }

  async createAllocation(client, data) {
    const { receipt_id, invoice_id, allocated_amount } = data;
    const result = await client.query(
      `INSERT INTO receipt_allocations (receipt_id, invoice_id, allocated_amount) 
       VALUES ($1, $2, $3) RETURNING *`,
      [receipt_id, invoice_id, allocated_amount]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT r.*, p.name as customer_name 
                 FROM receipts r
                 JOIN parties p ON r.customer_id = p.id
                 WHERE r.deleted_at IS NULL`;
    const params = [];
    
    if (filters.customer_id) {
      params.push(filters.customer_id);
      query += ` AND r.customer_id = $${params.length}`;
    }
    
    if (filters.from_date) {
      params.push(filters.from_date);
      query += ` AND r.receipt_date >= $${params.length}`;
    }
    
    if (filters.to_date) {
      params.push(filters.to_date);
      query += ` AND r.receipt_date <= $${params.length}`;
    }
    
    query += ' ORDER BY r.receipt_date DESC';
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  async linkJournalEntry(client, id, journalEntryId) {
    const result = await client.query(
      'UPDATE receipts SET journal_entry_id = $1 WHERE id = $2 RETURNING *',
      [journalEntryId, id]
    );
    return result.rows[0];
  }

  async getNextNumber() {
    const result = await pool.query(
      `SELECT receipt_number FROM receipts 
       WHERE receipt_number LIKE 'REC%' 
       ORDER BY receipt_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'REC0001';
    }
    
    const lastNum = parseInt(result.rows[0].receipt_number.replace('REC', '')) + 1;
    return `REC${lastNum.toString().padStart(4, '0')}`;
  }
};

export const paymentRepository = new PaymentRepository();
export const receiptRepository = new ReceiptRepository();
