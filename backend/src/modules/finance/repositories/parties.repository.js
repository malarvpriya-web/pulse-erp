import pool from '../db.js';

class PartiesRepository {
  async create(data) {
    const { party_code, party_type, name, contact_person, email, phone, address, tax_id, credit_limit, payment_terms } = data;
    const result = await pool.query(
      `INSERT INTO parties (party_code, party_type, name, contact_person, email, phone, address, tax_id, credit_limit, payment_terms) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [party_code, party_type, name, contact_person, email, phone, address, tax_id, credit_limit, payment_terms]
    );
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM parties WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = 'SELECT * FROM parties WHERE deleted_at IS NULL';
    const params = [];
    
    if (filters.party_type) {
      params.push(filters.party_type);
      query += ` AND (party_type = $${params.length} OR party_type = 'Both')`;
    }
    
    if (filters.is_active !== undefined) {
      params.push(filters.is_active);
      query += ` AND is_active = $${params.length}`;
    }
    
    query += ' ORDER BY name';
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  async update(id, data) {
    const { name, contact_person, email, phone, address, tax_id, credit_limit, payment_terms, is_active } = data;
    const result = await pool.query(
      `UPDATE parties 
       SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5, 
           tax_id = $6, credit_limit = $7, payment_terms = $8, is_active = $9, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $10 AND deleted_at IS NULL RETURNING *`,
      [name, contact_person, email, phone, address, tax_id, credit_limit, payment_terms, is_active, id]
    );
    return result.rows[0];
  }

  async softDelete(id) {
    const result = await pool.query(
      'UPDATE parties SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  }

  async getOutstandingBalance(partyId, partyType) {
    if (partyType === 'Customer') {
      const result = await pool.query(
        `SELECT COALESCE(SUM(balance), 0) as outstanding 
         FROM invoices 
         WHERE customer_id = $1 AND status != 'Cancelled' AND deleted_at IS NULL`,
        [partyId]
      );
      return parseFloat(result.rows[0].outstanding);
    } else {
      const result = await pool.query(
        `SELECT COALESCE(SUM(balance), 0) as outstanding 
         FROM bills 
         WHERE supplier_id = $1 AND status != 'Cancelled' AND deleted_at IS NULL`,
        [partyId]
      );
      return parseFloat(result.rows[0].outstanding);
    }
  }

  async getNextCode(partyType) {
    const prefix = partyType === 'Customer' ? 'CUST' : 'SUPP';
    const result = await pool.query(
      `SELECT party_code FROM parties 
       WHERE party_code LIKE $1 
       ORDER BY party_code DESC LIMIT 1`,
      [`${prefix}%`]
    );
    
    if (result.rows.length === 0) {
      return `${prefix}001`;
    }
    
    const lastCode = result.rows[0].party_code;
    const num = parseInt(lastCode.replace(prefix, '')) + 1;
    return `${prefix}${num.toString().padStart(3, '0')}`;
  }
}

export default new PartiesRepository();
