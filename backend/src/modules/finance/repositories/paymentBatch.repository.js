import pool from '../db.js';

class PaymentBatchRepository {
  async create(data) {
    const { batch_number, batch_date, bank_account_id, notes, created_by } = data;
    const result = await pool.query(
      `INSERT INTO payment_batches (batch_number, batch_date, bank_account_id, notes, created_by) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [batch_number, batch_date, bank_account_id, notes, created_by]
    );
    return result.rows[0];
  }

  async addItem(client, data) {
    const { batch_id, party_id, bill_id, amount, payment_method, reference_number, notes } = data;
    const result = await client.query(
      `INSERT INTO payment_batch_items (batch_id, party_id, bill_id, amount, payment_method, reference_number, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [batch_id, party_id, bill_id, amount, payment_method, reference_number, notes]
    );
    
    await client.query(
      `UPDATE payment_batches 
       SET total_amount = total_amount + $1, payment_count = payment_count + 1 
       WHERE id = $2`,
      [amount, batch_id]
    );
    
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM payment_batches WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = 'SELECT * FROM payment_batches WHERE 1=1';
    const params = [];
    
    if (filters.status) {
      params.push(filters.status);
      query += ` AND status = $${params.length}`;
    }
    
    query += ' ORDER BY batch_date DESC, created_at DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async getItems(batchId) {
    const result = await pool.query(
      `SELECT pbi.*, p.name as party_name, b.bill_number 
       FROM payment_batch_items pbi
       JOIN parties p ON pbi.party_id = p.id
       LEFT JOIN bills b ON pbi.bill_id = b.id
       WHERE pbi.batch_id = $1 
       ORDER BY pbi.created_at`,
      [batchId]
    );
    return result.rows;
  }

  async updateStatus(client, id, status, userId = null) {
    let query = 'UPDATE payment_batches SET status = $1, updated_at = CURRENT_TIMESTAMP';
    const params = [status, id];
    
    if (status === 'Approved' && userId) {
      query += ', approved_by = $3, approved_at = CURRENT_TIMESTAMP';
      params.push(userId);
    } else if (status === 'Processing') {
      query += ', processed_at = CURRENT_TIMESTAMP';
    } else if (status === 'Completed') {
      query += ', completed_at = CURRENT_TIMESTAMP';
    }
    
    query += ' WHERE id = $2 RETURNING *';
    const result = await client.query(query, params);
    return result.rows[0];
  }

  async linkPayment(client, itemId, paymentId) {
    const result = await client.query(
      'UPDATE payment_batch_items SET payment_id = $1, status = $2 WHERE id = $3 RETURNING *',
      [paymentId, 'Processed', itemId]
    );
    return result.rows[0];
  }

  async getNextBatchNumber() {
    const result = await pool.query(
      `SELECT batch_number FROM payment_batches 
       WHERE batch_number LIKE 'PB%' 
       ORDER BY batch_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'PB0001';
    }
    
    const lastNum = parseInt(result.rows[0].batch_number.replace('PB', '')) + 1;
    return `PB${lastNum.toString().padStart(4, '0')}`;
  }
}

export default new PaymentBatchRepository();
