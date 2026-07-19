import pool from '../db.js';
import { nextBillNumber } from '../../../shared/docNumber.js';

class BillRepository {
  async create(client, data) {
    const {
      bill_number, supplier_id, bill_date, due_date,
      subtotal, tax_amount, total_amount,
      notes, created_by, company_id,
      tds_section, tds_rate, tds_amount,
    } = data;
    const net_payable = (parseFloat(total_amount) || 0) - (parseFloat(tds_amount) || 0);
    const result = await client.query(
      `INSERT INTO bills (
         bill_number, supplier_id, bill_date, due_date,
         subtotal, tax_amount, total_amount, balance,
         notes, created_by, company_id,
         tds_section, tds_rate, tds_amount, net_payable
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        bill_number, supplier_id, bill_date, due_date,
        subtotal, tax_amount, total_amount,
        notes, created_by, company_id ?? null,
        tds_section || null,
        parseFloat(tds_rate) || 0,
        parseFloat(tds_amount) || 0,
        net_payable,
      ]
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
              COALESCE(p.name, b.party_name) AS supplier_name,
              p.email AS supplier_email, p.phone AS supplier_phone
       FROM bills b
       LEFT JOIN parties p ON p.id = b.supplier_id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `
      SELECT b.*,
             COALESCE(p.name, b.party_name) AS supplier_name
      FROM bills b
      LEFT JOIN parties p ON p.id = b.supplier_id
      WHERE b.deleted_at IS NULL`;
    const params = [];

    if (filters.company_id != null) {
      params.push(filters.company_id);
      query += ` AND b.company_id = $${params.length}`;
    }

    if (filters.status) {
      params.push(filters.status);
      query += ` AND LOWER(b.status) = LOWER($${params.length})`;
    }

    if (filters.approval_status) {
      params.push(filters.approval_status);
      query += ` AND b.approval_status = $${params.length}`;
    }

    if (filters.supplier_id) {
      params.push(filters.supplier_id);
      query += ` AND b.supplier_id = $${params.length}`;
    }

    if (filters.date_from) {
      params.push(filters.date_from);
      query += ` AND b.bill_date >= $${params.length}`;
    }

    if (filters.date_to) {
      params.push(filters.date_to);
      query += ` AND b.bill_date <= $${params.length}`;
    }

    if (filters.search) {
      params.push(`%${filters.search}%`);
      const n = params.length;
      query += ` AND (b.bill_number ILIKE $${n} OR COALESCE(p.name, b.party_name) ILIKE $${n})`;
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
       SET approval_status = 'approved', status = 'approved',
           approved_by = $1, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
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
           status = CASE WHEN total_amount - (paid_amount + $1) <= 0 THEN 'paid' ELSE status END,
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

  async getDueSoon(days = 7, companyId = null) {
    const params = [days];
    let extra = '';
    if (companyId != null) { params.push(companyId); extra = ` AND b.company_id = $${params.length}`; }
    const result = await pool.query(
      `SELECT b.*,
              COALESCE(p.name, b.party_name) AS supplier_name,
              p.email AS supplier_email
       FROM bills b
       LEFT JOIN parties p ON p.id = b.supplier_id
       WHERE b.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::integer
         AND LOWER(b.status) NOT IN ('paid', 'cancelled')
         AND b.deleted_at IS NULL${extra}
       ORDER BY b.due_date`,
      params
    );
    return result.rows;
  }

  async getNextNumber(client) {
    return nextBillNumber(client);
  }
}

export default new BillRepository();
