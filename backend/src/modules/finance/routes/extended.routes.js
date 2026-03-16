import express from 'express';
import pool from '../db.js';
import bankAccountRepo from '../repositories/bankAccount.repository.js';
import paymentBatchRepo from '../repositories/paymentBatch.repository.js';
import paymentBatchService from '../services/paymentBatch.service.js';
import ticketRepo from '../repositories/ticket.repository.js';
import financialRatiosService from '../services/financialRatios.service.js';

const router = express.Router();

// =====================================================
// BANK ACCOUNTS
// =====================================================
router.post('/bank-accounts', async (req, res) => {
  try {
    const account = await bankAccountRepo.create(req.body);
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts', async (req, res) => {
  try {
    const accounts = await bankAccountRepo.findAll(req.query);
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts/:id', async (req, res) => {
  try {
    const account = await bankAccountRepo.findById(req.params.id);
    if (!account) {
      return res.status(404).json({ error: 'Bank account not found' });
    }
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts/:id/transactions', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const transactions = await bankAccountRepo.getTransactions(req.params.id, start_date, end_date);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts/:id/unreconciled', async (req, res) => {
  try {
    const transactions = await bankAccountRepo.getUnreconciledTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// PAYMENT BATCHES
// =====================================================
router.post('/payment-batches', async (req, res) => {
  try {
    const batch = await paymentBatchService.createBatch(req.body, req.user.id);
    res.status(201).json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/payment-batches', async (req, res) => {
  try {
    const batches = await paymentBatchService.getBatches(req.query);
    res.json(batches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/payment-batches/:id', async (req, res) => {
  try {
    const batch = await paymentBatchService.getBatchById(req.params.id);
    if (!batch) {
      return res.status(404).json({ error: 'Payment batch not found' });
    }
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment-batches/:id/submit', async (req, res) => {
  try {
    const batch = await paymentBatchService.submitForApproval(req.params.id);
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment-batches/:id/approve', async (req, res) => {
  try {
    const batch = await paymentBatchService.approveBatch(req.params.id, req.user.id);
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment-batches/:id/process', async (req, res) => {
  try {
    const batch = await paymentBatchService.processBatch(req.params.id, req.body);
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// PDC REGISTER
// =====================================================
router.post('/pdc', async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO pdc_register (cheque_type, cheque_number, cheque_date, amount, party_id, bank_account_id, reference_type, reference_id, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.body.cheque_type, req.body.cheque_number, req.body.cheque_date, req.body.amount, req.body.party_id, req.body.bank_account_id, req.body.reference_type, req.body.reference_id, req.body.notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/pdc', async (req, res) => {
  try {
    let query = `SELECT p.*, pt.name as party_name, ba.account_name 
                 FROM pdc_register p
                 LEFT JOIN parties pt ON p.party_id = pt.id
                 LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
                 WHERE 1=1`;
    const params = [];
    
    if (req.query.cheque_type) {
      params.push(req.query.cheque_type);
      query += ` AND p.cheque_type = $${params.length}`;
    }
    
    if (req.query.status) {
      params.push(req.query.status);
      query += ` AND p.status = $${params.length}`;
    }
    
    query += ' ORDER BY p.cheque_date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/pdc/:id/status', async (req, res) => {
  try {
    const { status, cleared_date, bounce_reason, bounce_charges } = req.body;
    const result = await pool.query(
      `UPDATE pdc_register 
       SET status = $1, cleared_date = $2, bounce_reason = $3, bounce_charges = $4, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $5 RETURNING *`,
      [status, cleared_date, bounce_reason, bounce_charges, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// EXPENSE CATEGORIES
// =====================================================
router.get('/expense-categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM expense_categories WHERE is_active = true ORDER BY name'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// COMPLIANCE ANALYTICS
// =====================================================
router.get('/analytics/without-bill', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const result = await pool.query(
      `SELECT 
        ec.name as category,
        COUNT(*) as count,
        SUM(eci.amount) as total_amount
       FROM expense_claim_items eci
       JOIN expense_categories ec ON eci.category_id = ec.id
       JOIN expense_claims ecl ON eci.expense_claim_id = ecl.id
       WHERE eci.bill_status = 'without_bill'
       AND ecl.claim_date BETWEEN $1 AND $2
       GROUP BY ec.name
       ORDER BY total_amount DESC`,
      [start_date, end_date]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/gst-claimable', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const result = await pool.query(
      `SELECT 
        SUM(CASE WHEN is_gst_claimable = true THEN gst_amount ELSE 0 END) as claimable_gst,
        SUM(CASE WHEN is_gst_claimable = false THEN gst_amount ELSE 0 END) as non_claimable_gst,
        SUM(gst_amount) as total_gst
       FROM expense_claim_items eci
       JOIN expense_claims ecl ON eci.expense_claim_id = ecl.id
       WHERE ecl.claim_date BETWEEN $1 AND $2`,
      [start_date, end_date]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// FINANCIAL RATIOS
// =====================================================
router.get('/ratios', async (req, res) => {
  try {
    const { as_of_date } = req.query;
    const ratios = await financialRatiosService.calculateRatios(as_of_date || new Date().toISOString().split('T')[0]);
    res.json(ratios);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/ratios/comparative', async (req, res) => {
  try {
    const { current_date, previous_date } = req.query;
    const comparison = await financialRatiosService.getComparativeRatios(current_date, previous_date);
    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// BUDGETS
// =====================================================
router.post('/budgets', async (req, res) => {
  try {
    const { budget_name, fiscal_year, account_id, period_type, monthly_amounts, notes } = req.body;
    const total = Object.values(monthly_amounts).reduce((sum, val) => sum + parseFloat(val), 0);
    
    const result = await pool.query(
      `INSERT INTO budgets (budget_name, fiscal_year, account_id, period_type, jan_amount, feb_amount, mar_amount, apr_amount, may_amount, jun_amount, jul_amount, aug_amount, sep_amount, oct_amount, nov_amount, dec_amount, total_amount, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
      [budget_name, fiscal_year, account_id, period_type, monthly_amounts.jan, monthly_amounts.feb, monthly_amounts.mar, monthly_amounts.apr, monthly_amounts.may, monthly_amounts.jun, monthly_amounts.jul, monthly_amounts.aug, monthly_amounts.sep, monthly_amounts.oct, monthly_amounts.nov, monthly_amounts.dec, total, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/budgets', async (req, res) => {
  try {
    const { fiscal_year } = req.query;
    let query = `SELECT b.*, c.code, c.name as account_name 
                 FROM budgets b
                 JOIN chart_of_accounts c ON b.account_id = c.id
                 WHERE 1=1`;
    const params = [];
    
    if (fiscal_year) {
      params.push(fiscal_year);
      query += ` AND b.fiscal_year = $${params.length}`;
    }
    
    query += ' ORDER BY b.fiscal_year DESC, c.code';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/budgets/vs-actual', async (req, res) => {
  try {
    const { fiscal_year, month } = req.query;
    // This would compare budget vs actual spending
    // Implementation depends on specific requirements
    res.json({ message: 'Budget vs Actual comparison' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// TICKETING SYSTEM
// =====================================================
router.post('/tickets', async (req, res) => {
  try {
    const ticketNumber = await ticketRepo.getNextTicketNumber();
    const ticket = await ticketRepo.create({
      ...req.body,
      ticket_number: ticketNumber
    });
    res.status(201).json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tickets', async (req, res) => {
  try {
    const tickets = await ticketRepo.findAll(req.query);
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tickets/:id', async (req, res) => {
  try {
    const ticket = await ticketRepo.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    ticket.conversations = await ticketRepo.getConversations(req.params.id);
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tickets/:id/status', async (req, res) => {
  try {
    const ticket = await ticketRepo.updateStatus(req.params.id, req.body.status, req.user.id);
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tickets/:id/assign', async (req, res) => {
  try {
    const ticket = await ticketRepo.assignTicket(req.params.id, req.body.assigned_to);
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tickets/:id/conversations', async (req, res) => {
  try {
    const conversation = await ticketRepo.addConversation({
      ticket_id: req.params.id,
      ...req.body,
      created_by: req.user.id
    });
    res.status(201).json(conversation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tickets/dashboard/stats', async (req, res) => {
  try {
    const stats = await ticketRepo.getDashboardStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/ticket-categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM ticket_categories WHERE is_active = true ORDER BY name'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sla-policies', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sla_policies WHERE is_active = true ORDER BY priority'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

