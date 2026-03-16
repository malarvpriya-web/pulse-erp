import pool from '../db.js';

class TicketRepository {
  async create(data) {
    const { ticket_number, subject, description, category_id, priority, requester_type, requester_id, requester_name, requester_email, sla_policy_id } = data;
    
    const sla = await pool.query('SELECT * FROM sla_policies WHERE id = $1', [sla_policy_id]);
    const now = new Date();
    const response_due = new Date(now.getTime() + sla.rows[0].response_time_hours * 60 * 60 * 1000);
    const resolution_due = new Date(now.getTime() + sla.rows[0].resolution_time_hours * 60 * 60 * 1000);
    
    const result = await pool.query(
      `INSERT INTO tickets (ticket_number, subject, description, category_id, priority, requester_type, requester_id, requester_name, requester_email, sla_policy_id, response_due_at, resolution_due_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [ticket_number, subject, description, category_id, priority, requester_type, requester_id, requester_name, requester_email, sla_policy_id, response_due, resolution_due]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT t.*, tc.name as category_name, sp.name as sla_name 
                 FROM tickets t
                 LEFT JOIN ticket_categories tc ON t.category_id = tc.id
                 LEFT JOIN sla_policies sp ON t.sla_policy_id = sp.id
                 WHERE 1=1`;
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
       FROM tickets t
       LEFT JOIN ticket_categories tc ON t.category_id = tc.id
       LEFT JOIN sla_policies sp ON t.sla_policy_id = sp.id
       WHERE t.id = $1`,
      [id]
    );
    return result.rows[0];
  }

  async updateStatus(id, status, userId) {
    let query = 'UPDATE tickets SET status = $1, updated_at = CURRENT_TIMESTAMP';
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
      'UPDATE tickets SET assigned_to = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
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
        'UPDATE tickets SET first_response_at = CURRENT_TIMESTAMP WHERE id = $1',
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
    const now = new Date();
    await pool.query(
      `UPDATE tickets 
       SET is_sla_breached = true 
       WHERE (resolution_due_at < $1 AND status NOT IN ('Resolved', 'Closed'))
       OR (response_due_at < $1 AND first_response_at IS NULL)`,
      [now]
    );
  }

  async getNextTicketNumber() {
    const result = await pool.query(
      `SELECT ticket_number FROM tickets 
       WHERE ticket_number LIKE 'TKT%' 
       ORDER BY ticket_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'TKT0001';
    }
    
    const lastNum = parseInt(result.rows[0].ticket_number.replace('TKT', '')) + 1;
    return `TKT${lastNum.toString().padStart(4, '0')}`;
  }

  async getDashboardStats() {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'Open') as open_tickets,
        COUNT(*) FILTER (WHERE status = 'In_Progress') as in_progress_tickets,
        COUNT(*) FILTER (WHERE resolution_due_at < CURRENT_TIMESTAMP AND status NOT IN ('Resolved', 'Closed')) as overdue_tickets,
        COUNT(*) FILTER (WHERE is_sla_breached = true) as sla_breached,
        AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_hours
      FROM tickets
    `);
    return stats.rows[0];
  }
}

export default new TicketRepository();
