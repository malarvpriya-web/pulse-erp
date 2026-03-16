import express from 'express';
import pool from '../../shared/db.js';
import leadsRepository from '../repositories/leads.repository.js';
import opportunitiesRepository from '../repositories/opportunities.repository.js';

const router = express.Router();

// ── Accounts ──────────────────────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    let q = `SELECT * FROM accounts WHERE deleted_at IS NULL`;
    const params = [];
    if (req.query.status) { params.push(req.query.status); q += ` AND status = $${params.length}`; }
    if (req.query.account_type) { params.push(req.query.account_type); q += ` AND account_type = $${params.length}`; }
    q += ' ORDER BY account_name ASC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/accounts/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id AND c.deleted_at IS NULL) AS contact_count
       FROM accounts a WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/accounts', async (req, res) => {
  try {
    const { account_name, industry, website, phone, email, address, account_type, annual_revenue, employees_count } = req.body;
    const result = await pool.query(
      `INSERT INTO accounts (account_name, industry, website, phone, email, address, account_type, annual_revenue, employees_count, assigned_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [account_name, industry, website, phone, email, address, account_type||'Customer', annual_revenue||0, employees_count, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/accounts/:id', async (req, res) => {
  try {
    const { account_name, industry, website, phone, email, address, account_type, annual_revenue, employees_count, status } = req.body;
    const result = await pool.query(
      `UPDATE accounts SET account_name=$1, industry=$2, website=$3, phone=$4, email=$5, address=$6,
       account_type=$7, annual_revenue=$8, employees_count=$9, status=$10, updated_at=NOW()
       WHERE id=$11 AND deleted_at IS NULL RETURNING *`,
      [account_name, industry, website, phone, email, address, account_type, annual_revenue, employees_count, status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    await pool.query('UPDATE accounts SET deleted_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'Account deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Contacts ──────────────────────────────────────────────────────────────────
router.get('/contacts', async (req, res) => {
  try {
    let q = `SELECT c.*, a.account_name FROM contacts c
             LEFT JOIN accounts a ON c.account_id = a.id
             WHERE c.deleted_at IS NULL`;
    const params = [];
    if (req.query.account_id) { params.push(req.query.account_id); q += ` AND c.account_id = $${params.length}`; }
    if (req.query.status) { params.push(req.query.status); q += ` AND c.status = $${params.length}`; }
    q += ' ORDER BY c.full_name ASC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/contacts/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, a.account_name FROM contacts c
       LEFT JOIN accounts a ON c.account_id = a.id
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/contacts', async (req, res) => {
  try {
    const { full_name, account_id, title, email, phone, department, lead_source, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO contacts (full_name, account_id, title, email, phone, department, lead_source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [full_name, account_id||null, title, email, phone, department, lead_source, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/contacts/:id', async (req, res) => {
  try {
    const { full_name, account_id, title, email, phone, department, lead_source, status, notes } = req.body;
    const result = await pool.query(
      `UPDATE contacts SET full_name=$1, account_id=$2, title=$3, email=$4, phone=$5,
       department=$6, lead_source=$7, status=$8, notes=$9, updated_at=NOW()
       WHERE id=$10 AND deleted_at IS NULL RETURNING *`,
      [full_name, account_id||null, title, email, phone, department, lead_source, status, notes, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    await pool.query('UPDATE contacts SET deleted_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'Contact deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Leads
router.get('/leads', async (req, res) => {
  try {
    const leads = await leadsRepository.findAll(req.query);
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const lead = await leadsRepository.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads', async (req, res) => {
  try {
    const lead = await leadsRepository.create({ ...req.body, created_by: req.user?.id });
    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/leads/:id', async (req, res) => {
  try {
    const lead = await leadsRepository.update(req.params.id, req.body);
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/leads/:id', async (req, res) => {
  try {
    await leadsRepository.delete(req.params.id);
    res.json({ message: 'Lead deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leads/:id/activities', async (req, res) => {
  try {
    const activities = await leadsRepository.getActivities(req.params.id);
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/:id/activities', async (req, res) => {
  try {
    const activity = await leadsRepository.addActivity({ 
      ...req.body, 
      lead_id: req.params.id,
      created_by: req.user?.id 
    });
    res.status(201).json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Opportunities
router.get('/opportunities', async (req, res) => {
  try {
    const opportunities = await opportunitiesRepository.findAll(req.query);
    res.json(opportunities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/opportunities/kanban', async (req, res) => {
  try {
    const board = await opportunitiesRepository.getKanbanBoard();
    res.json(board);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/opportunities/:id', async (req, res) => {
  try {
    const opportunity = await opportunitiesRepository.findById(req.params.id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });
    res.json(opportunity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/opportunities', async (req, res) => {
  try {
    const opportunity = await opportunitiesRepository.create({ ...req.body, created_by: req.user?.id });
    
    // Update lead status to converted
    if (req.body.lead_id) {
      await leadsRepository.update(req.body.lead_id, { status: 'converted' });
    }
    
    res.status(201).json(opportunity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/opportunities/:id', async (req, res) => {
  try {
    const opportunity = await opportunitiesRepository.update(req.params.id, req.body);
    res.json(opportunity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/opportunities/:id', async (req, res) => {
  try {
    await opportunitiesRepository.delete(req.params.id);
    res.json({ message: 'Opportunity deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analytics
router.get('/analytics/leads-by-source', async (req, res) => {
  try {
    const data = await leadsRepository.getLeadsBySource();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/conversion-rate', async (req, res) => {
  try {
    const data = await leadsRepository.getConversionRate();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/pipeline-value', async (req, res) => {
  try {
    const data = await opportunitiesRepository.getPipelineValue();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/avg-deal-size', async (req, res) => {
  try {
    const data = await opportunitiesRepository.getAverageDealSize();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
