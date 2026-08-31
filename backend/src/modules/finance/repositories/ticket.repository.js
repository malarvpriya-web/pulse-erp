/**
 * Finance ticket repository.
 *
 * REPOINTED (2026-08-19) from `tickets` to `support_tickets`.
 *
 * `tickets` was a parallel ticket system: 0 rows, and every write against it
 * threw 42703 because the repository used a column set that table never had
 * (subject, requester_*, response_due_at, resolution_due_at, is_sla_breached).
 * Meanwhile `support_tickets` -- the canonical Service Desk table -- holds the
 * 15 live tickets AND already carries requester_name / requester_email.
 *
 * Giving `tickets` the missing columns would have kept two ticket tables alive
 * and made the split permanent. Repointing removes the second source of truth,
 * the same rule the customer-master consolidation follows.
 *
 * Column mapping applied:
 *   subject            -> title
 *   category_id        -> category           (support_tickets stores the label)
 *   response_due_at    -> sla_due_date
 *   resolution_due_at  -> due_date
 *   is_sla_breached    -> derived from due_date vs now, never stored
 *   requester_type/id  -> dropped; support_tickets identifies a requester by
 *                         name/email, and customer_id when they are a customer
 */
import pool from '../db.js';
import { nextFinanceTicketNumber } from '../../../shared/docNumber.js';

class TicketRepository {
  async create(data) {
    const { ticket_number, subject, description, category_id, priority, requester_type, requester_id, requester_name, requester_email, sla_policy_id } = data;
    
    const sla = await pool.query('SELECT * FROM sla_policies WHERE id = $1', [sla_policy_id]);
    const now = new Date();
    const response_due = new Date(now.getTime() + sla.rows[0].response_time_hours * 60 * 60 * 1000);
    const resolution_due = new Date(now.getTime() + sla.rows[0].resolution_time_hours * 60 * 60 * 1000);
    
    const result = await pool.query(
      `INSERT INTO support_tickets
         (ticket_number, title, description, category, priority,
          requester_name, requester_email, sla_due_date, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Open') RETURNING *`,
      [ticket_number, subject, description, category_id, priority,
       requester_name, requester_email, response_due, resolution_due]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT t.*, t.title AS subject, t.category AS category_name,
                        t.sla_due_date AS response_due_at, t.due_date AS resolution_due_at,
                        (t.due_date IS NOT NULL AND t.due_date < NOW()
                         AND LOWER(t.status) NOT IN ('resolved','closed')) AS is_sla_breached
                 FROM support_tickets t
                 WHERE t.deleted_at IS NULL`;
    const params = [];
    
    if (filters.status) {
      params.push(filters.status);
      query += ` AND t.status = $${params.length}`;
    }
    
    if (filters.priority) {
      params.push(filters.priority);
      query += ` AND t.priority = $${params.length}`;
    }
    
    if (filters.assigned_to) {
      params.push(filters.assigned_to);
      query += ` AND t.assigned_to = $${params.length}`;
    }
    
    if (filters.requester_type) {
      params.push(filters.requester_type);
      query += ` AND t.requester_type = $${params.length}`;
    }
    
    query += ' ORDER BY t.created_at DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT t.*, tc.name as category_name, sp.name as sla_name 
       FROM support_tickets t
       LEFT JOIN ticket_categories tc ON t.category_id = tc.id
       LEFT JOIN sla_policies sp ON t.sla_policy_id = sp.id
       WHERE t.id = $1`,
      [id]
    );
    return result.rows[0];
  }

  async updateStatus(id, status, userId) {
    let query = 'UPDATE support_tickets SET status = $1, updated_at = CURRENT_TIMESTAMP';
    const params = [status, id];
    
    if (status === 'Resolved') {
      query += ', resolved_at = CURRENT_TIMESTAMP';
    } else if (status === 'Closed') {
      query += ', closed_at = CURRENT_TIMESTAMP';
    }
    
    query += ' WHERE id = $2 RETURNING *';
    const result = await pool.query(query, params);
    return result.rows[0];
  }

  async assignTicket(id, assignedTo) {
    const result = await pool.query(
      'UPDATE support_tickets SET assigned_to = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [assignedTo, 'In_Progress', id]
    );
    return result.rows[0];
  }

  async addConversation(data) {
    const { ticket_id, message, is_internal, created_by, created_by_name, attachments } = data;
    const result = await pool.query(
      `INSERT INTO ticket_conversations (ticket_id, message, is_internal, created_by, created_by_name, attachments) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [ticket_id, message, is_internal, created_by, created_by_name, attachments]
    );
    
    const ticket = await this.findById(ticket_id);
    if (!ticket.first_response_at) {
      await pool.query(
        'UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [ticket_id]
      );
    }
    
    return result.rows[0];
  }

  async getConversations(ticketId) {
    const result = await pool.query(
      'SELECT * FROM ticket_conversations WHERE ticket_id = $1 ORDER BY created_at',
      [ticketId]
    );
    return result.rows;
  }

  async checkSLABreach() {
    // Derived, not stored: support_tickets has no is_sla_breached column, and a
    // denormalised flag kept in sync with a due date is exactly the drift that
    // produced this repository's original problem. Returns the breached rows.
    const { rows } = await pool.query(
      `SELECT id, ticket_number, title, due_date
         FROM support_tickets
        WHERE deleted_at IS NULL
          AND due_date IS NOT NULL
          AND due_date < NOW()
          AND LOWER(status) NOT IN ('resolved','closed')`
    );
    return rows;
  }

  async getNextTicketNumber(client) {
    return nextFinanceTicketNumber(client);
  }

  async getDashboardStats() {
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(status) = 'open') as open_tickets,
        COUNT(*) FILTER (WHERE LOWER(status) IN ('in_progress','in progress')) as in_progress_tickets,
        COUNT(*) FILTER (WHERE due_date < CURRENT_TIMESTAMP AND LOWER(status) NOT IN ('resolved','closed')) as overdue_tickets,
        COUNT(*) FILTER (WHERE due_date < CURRENT_TIMESTAMP AND LOWER(status) NOT IN ('resolved','closed')) as sla_breached,
        AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_hours
      FROM support_tickets
      WHERE deleted_at IS NULL
    `);
    return stats.rows[0];
  }
}

export default new TicketRepository();
