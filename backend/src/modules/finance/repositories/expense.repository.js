import pool from '../db.js';
import { nextExpenseNumber } from '../../../shared/docNumber.js';

class ExpenseRepository {
  async create(client, data) {
    const { claim_number, employee_id, claim_date, total_amount, notes } = data;
    const result = await client.query(
      `INSERT INTO expense_claims (claim_number, employee_id, claim_date, total_amount, notes) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [claim_number, employee_id, claim_date, total_amount, notes]
    );
    return result.rows[0];
  }

  async createItem(client, data) {
    const { expense_claim_id, expense_date, category, description, amount, receipt_path } = data;
    const result = await client.query(
      `INSERT INTO expense_claim_items (expense_claim_id, expense_date, category, description, amount, receipt_path) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [expense_claim_id, expense_date, category, description, amount, receipt_path]
    );
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT ec.*, e.first_name, e.last_name 
       FROM expense_claims ec
       JOIN employees e ON ec.employee_id = e.id
       WHERE ec.id = $1 AND ec.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    const cid = filters.company_id != null ? filters.company_id : null;
    let query = `SELECT ec.*, e.first_name, e.last_name
                 FROM expense_claims ec
                 JOIN employees e ON ec.employee_id = e.id
                 WHERE ec.deleted_at IS NULL`;
    const params = [];

    if (cid != null) {
      params.push(cid);
      query += ` AND e.company_id = $${params.length}`;
    }

    if (filters.status) {
      params.push(filters.status);
      query += ` AND ec.status = $${params.length}`;
    }

    if (filters.employee_id) {
      params.push(filters.employee_id);
      query += ` AND ec.employee_id = $${params.length}`;
    }

    query += ' ORDER BY ec.claim_date DESC';

    const result = await pool.query(query, params);
    return result.rows;
  }

  async getItems(claimId) {
    const result = await pool.query(
      'SELECT * FROM expense_claim_items WHERE expense_claim_id = $1 ORDER BY expense_date',
      [claimId]
    );
    return result.rows;
  }

  async approve(client, id, approvedBy) {
    const result = await client.query(
      `UPDATE expense_claims 
       SET status = 'Approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 RETURNING *`,
      [approvedBy, id]
    );
    return result.rows[0];
  }

  async reject(client, id, rejectionReason) {
    const result = await client.query(
      `UPDATE expense_claims 
       SET status = 'Rejected', rejection_reason = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 RETURNING *`,
      [rejectionReason, id]
    );
    return result.rows[0];
  }

  async markPaid(client, id, paymentId) {
    const result = await client.query(
      `UPDATE expense_claims 
       SET status = 'Paid', payment_id = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 RETURNING *`,
      [paymentId, id]
    );
    return result.rows[0];
  }

  async linkJournalEntry(client, id, journalEntryId) {
    const result = await client.query(
      'UPDATE expense_claims SET journal_entry_id = $1 WHERE id = $2 RETURNING *',
      [journalEntryId, id]
    );
    return result.rows[0];
  }

  async getNextNumber(client) {
    return nextExpenseNumber(client);
  }
}

export default new ExpenseRepository();
