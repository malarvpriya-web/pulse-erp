/**
 * Phase 51 — Customer Self-Service Portal
 * Mixed auth: public /auth/login + portal-token-protected customer routes
 * + verifyToken-protected internal staff management routes
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../../../config/db.js';
import { verifyToken } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const JWT_SECRET = process.env.JWT_SECRET;

// ── Customer portal JWT middleware ────────────────────────────────────────────
const verifyPortalToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Portal session required' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    if (decoded.type !== 'customer_portal') return res.status(403).json({ error: 'Invalid portal token' });
    req.portal = decoded; // { type, portalUserId, company_id, email, customer_name }
    next();
  } catch {
    res.status(401).json({ error: 'Portal session expired' });
  }
};

// ── Ticket number generator ───────────────────────────────────────────────────
async function nextTicketNo(company_id) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM customer_portal_tickets WHERE company_id = $1`,
    [company_id]
  );
  const n = parseInt(rows[0].cnt, 10) + 1;
  return `CPT-${String(n).padStart(5, '0')}`;
}

// =============================================================================
// PUBLIC — CUSTOMER PORTAL AUTH
// =============================================================================

// POST /customer-portal/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password, company_id } = req.body;
    if (!email || !password || !company_id) {
      return res.status(400).json({ error: 'Email, password and company_id are required' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM customer_portal_users WHERE email = $1 AND company_id = $2 AND is_active = true LIMIT 1`,
      [email.toLowerCase().trim(), company_id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    await pool.query(`UPDATE customer_portal_users SET last_login = NOW() WHERE id = $1`, [user.id]);

    const token = jwt.sign(
      { type: 'customer_portal', portalUserId: user.id, company_id: user.company_id, email: user.email, customer_name: user.customer_name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, customer_name: user.customer_name, contact_person: user.contact_person, email: user.email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// CUSTOMER PORTAL ROUTES (portal token required)
// =============================================================================

// GET /customer-portal/portal/me — profile
router.get('/portal/me', verifyPortalToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, customer_name, contact_person, email, phone, project_ids, last_login, created_at
         FROM customer_portal_users WHERE id = $1`,
      [req.portal.portalUserId]
    );
    res.json(rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /customer-portal/portal/equipment — list customer's equipment
router.get('/portal/equipment', verifyPortalToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, cw.status AS last_commissioning_status, cw.completed_date AS last_commissioned
         FROM customer_equipment e
         LEFT JOIN LATERAL (
           SELECT status, completed_date FROM commissioning_workflows
           WHERE equipment_id = e.id ORDER BY created_at DESC LIMIT 1
         ) cw ON true
        WHERE e.customer_portal_user_id = $1 AND e.company_id = $2
        ORDER BY e.equipment_tag`,
      [req.portal.portalUserId, req.portal.company_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /customer-portal/portal/equipment/:id — single equipment detail
router.get('/portal/equipment/:id', verifyPortalToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM customer_equipment WHERE id = $1 AND customer_portal_user_id = $2`,
      [req.params.id, req.portal.portalUserId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipment not found' });
    const eq = rows[0];

    // service history
    const { rows: svc } = await pool.query(
      `SELECT id, ticket_number, subject, status, created_at, resolved_at, resolution_notes
         FROM customer_portal_tickets
        WHERE equipment_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [eq.id]
    );
    eq.service_history = svc;

    // commissioning history
    const { rows: comm } = await pool.query(
      `SELECT id, workflow_number, status, scheduled_date, completed_date, engineer_name, certificate_issued
         FROM commissioning_workflows WHERE equipment_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [eq.id]
    );
    eq.commissioning_history = comm;

    // documents
    const { rows: docs } = await pool.query(
      `SELECT id, document_type, document_name, external_url, created_at
         FROM customer_portal_documents
        WHERE equipment_id = $1 AND is_visible = true ORDER BY document_type, document_name`,
      [eq.id]
    );
    eq.documents = docs;

    res.json(eq);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /customer-portal/portal/tickets — list my tickets
router.get('/portal/tickets', verifyPortalToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, e.equipment_tag, e.equipment_name
         FROM customer_portal_tickets t
         LEFT JOIN customer_equipment e ON e.id = t.equipment_id
        WHERE t.customer_portal_user_id = $1 AND t.company_id = $2
        ORDER BY t.created_at DESC`,
      [req.portal.portalUserId, req.portal.company_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /customer-portal/portal/tickets — raise new ticket
router.post('/portal/tickets', verifyPortalToken, async (req, res) => {
  try {
    const { equipment_id, subject, description, priority = 'medium', category } = req.body;
    if (!subject) return res.status(400).json({ error: 'Subject is required' });

    const ticket_number = await nextTicketNo(req.portal.company_id);
    const { rows } = await pool.query(
      `INSERT INTO customer_portal_tickets
         (company_id, ticket_number, customer_portal_user_id, equipment_id, subject, description, priority, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.portal.company_id, ticket_number, req.portal.portalUserId, equipment_id || null, subject, description, priority, category]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /customer-portal/portal/tickets/:id — ticket detail
router.get('/portal/tickets/:id', verifyPortalToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, e.equipment_name, e.equipment_tag
         FROM customer_portal_tickets t
         LEFT JOIN customer_equipment e ON e.id = t.equipment_id
        WHERE t.id = $1 AND t.customer_portal_user_id = $2`,
      [req.params.id, req.portal.portalUserId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });

    const { rows: uploads } = await pool.query(
      `SELECT id, filename, file_type, created_at FROM customer_portal_uploads WHERE ticket_id = $1`,
      [req.params.id]
    );
    rows[0].uploads = uploads;
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /customer-portal/portal/tickets/:id/rate — rate closed ticket
router.post('/portal/tickets/:id/rate', verifyPortalToken, async (req, res) => {
  try {
    const { rating, feedback } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
    const { rows } = await pool.query(
      `UPDATE customer_portal_tickets
          SET customer_rating = $1, customer_feedback = $2, updated_at = NOW()
        WHERE id = $3 AND customer_portal_user_id = $4
        RETURNING id, ticket_number, status`,
      [rating, feedback, req.params.id, req.portal.portalUserId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /customer-portal/portal/documents — all accessible documents
router.get('/portal/documents', verifyPortalToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, e.equipment_name, e.equipment_tag
         FROM customer_portal_documents d
         LEFT JOIN customer_equipment e ON e.id = d.equipment_id
        WHERE d.customer_portal_user_id = $1 AND d.is_visible = true
        ORDER BY d.document_type, d.document_name`,
      [req.portal.portalUserId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /customer-portal/portal/amc-visits — AMC visit history
router.get('/portal/amc-visits', verifyPortalToken, async (req, res) => {
  try {
    const { rows: equip } = await pool.query(
      `SELECT id FROM customer_equipment WHERE customer_portal_user_id = $1`,
      [req.portal.portalUserId]
    );
    if (!equip.length) return res.json([]);
    const equipIds = equip.map(e => e.id);
    const { rows } = await pool.query(
      `SELECT cw.id, cw.workflow_number, cw.status, cw.scheduled_date, cw.completed_date,
              cw.engineer_name, cw.customer_rating, cw.certificate_issued,
              ce.equipment_name, ce.equipment_tag
         FROM commissioning_workflows cw
         JOIN customer_equipment ce ON ce.id = cw.equipment_id
        WHERE cw.equipment_id = ANY($1) AND cw.company_id = $2
        ORDER BY cw.scheduled_date DESC`,
      [equipIds, req.portal.company_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// INTERNAL STAFF ROUTES (ERP verifyToken required)
// =============================================================================

// GET /customer-portal/accounts — list portal accounts
router.get('/accounts', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.customer_name, u.contact_person, u.email, u.phone, u.is_active,
              u.last_login, u.created_at,
              COUNT(DISTINCT e.id) AS equipment_count,
              COUNT(DISTINCT t.id) AS ticket_count
         FROM customer_portal_users u
         LEFT JOIN customer_equipment e ON e.customer_portal_user_id = u.id
         LEFT JOIN customer_portal_tickets t ON t.customer_portal_user_id = u.id
        WHERE u.company_id = $1
        GROUP BY u.id
        ORDER BY u.customer_name`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /customer-portal/accounts — create portal account
router.post('/accounts', verifyToken, async (req, res) => {
  try {
    const { customer_name, contact_person, email, phone, password, crm_account_id, project_ids } = req.body;
    if (!customer_name || !email || !password) {
      return res.status(400).json({ error: 'customer_name, email and password are required' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO customer_portal_users
         (company_id, customer_name, contact_person, email, phone, password_hash, crm_account_id, project_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, customer_name, email, contact_person, phone, is_active, created_at`,
      [cid(req), customer_name, contact_person, email.toLowerCase().trim(), phone, hash, crm_account_id, project_ids || []]
    );
    await logAudit(pool, { userId: uid(req), company_id: cid(req), action: 'CREATE', module: 'CustomerPortal', record_id: rows[0].id, description: `Portal account created for ${customer_name}` });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered for this company' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /customer-portal/accounts/:id — update account
router.put('/accounts/:id', verifyToken, async (req, res) => {
  try {
    const { customer_name, contact_person, phone, is_active, project_ids } = req.body;
    const { rows } = await pool.query(
      `UPDATE customer_portal_users
          SET customer_name = COALESCE($1, customer_name),
              contact_person = COALESCE($2, contact_person),
              phone = COALESCE($3, phone),
              is_active = COALESCE($4, is_active),
              project_ids = COALESCE($5, project_ids),
              updated_at = NOW()
        WHERE id = $6 AND company_id = $7 RETURNING *`,
      [customer_name, contact_person, phone, is_active, project_ids, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /customer-portal/accounts/:id/reset-password
router.post('/accounts/:id/reset-password', verifyToken, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(`UPDATE customer_portal_users SET password_hash = $1 WHERE id = $2 AND company_id = $3`, [hash, req.params.id, cid(req)]);
    res.json({ message: 'Password updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /customer-portal/accounts/:id
router.delete('/accounts/:id', verifyToken, async (req, res) => {
  try {
    await pool.query(`UPDATE customer_portal_users SET is_active = false WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ message: 'Account deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Equipment management (internal) ──────────────────────────────────────────

// GET /customer-portal/equipment
router.get('/equipment', verifyToken, async (req, res) => {
  try {
    const { customer_portal_user_id } = req.query;
    const { rows } = await pool.query(
      `SELECT e.*, u.customer_name, u.contact_person
         FROM customer_equipment e
         LEFT JOIN customer_portal_users u ON u.id = e.customer_portal_user_id
        WHERE e.company_id = $1 ${customer_portal_user_id ? 'AND e.customer_portal_user_id = $2' : ''}
        ORDER BY u.customer_name, e.equipment_tag`,
      customer_portal_user_id ? [cid(req), customer_portal_user_id] : [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /customer-portal/equipment
router.post('/equipment', verifyToken, async (req, res) => {
  try {
    const {
      customer_portal_user_id, crm_account_id, project_id, equipment_tag,
      equipment_name, model_number, serial_number, rating, installation_date,
      site_location, gps_lat, gps_lng, warranty_status, warranty_expiry,
      amc_status, amc_contract_id, last_service_date, next_service_date, status, notes
    } = req.body;
    if (!equipment_name) return res.status(400).json({ error: 'equipment_name is required' });
    const { rows } = await pool.query(
      `INSERT INTO customer_equipment
         (company_id, customer_portal_user_id, crm_account_id, project_id, equipment_tag,
          equipment_name, model_number, serial_number, rating, installation_date,
          site_location, gps_lat, gps_lng, warranty_status, warranty_expiry,
          amc_status, amc_contract_id, last_service_date, next_service_date, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [cid(req), customer_portal_user_id, crm_account_id, project_id, equipment_tag,
       equipment_name, model_number, serial_number, rating, installation_date,
       site_location, gps_lat, gps_lng, warranty_status || 'active', warranty_expiry,
       amc_status || 'none', amc_contract_id, last_service_date, next_service_date, status || 'operational', notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /customer-portal/equipment/:id
router.put('/equipment/:id', verifyToken, async (req, res) => {
  try {
    const fields = ['equipment_tag','equipment_name','model_number','serial_number','rating',
      'installation_date','site_location','gps_lat','gps_lng','warranty_status','warranty_expiry',
      'amc_status','amc_contract_id','last_service_date','next_service_date','status','notes'];
    const sets = fields.map((f, i) => `${f} = COALESCE($${i+1}, ${f})`).join(', ');
    const vals = fields.map(f => req.body[f] !== undefined ? req.body[f] : null);
    const { rows } = await pool.query(
      `UPDATE customer_equipment SET ${sets}, updated_at = NOW() WHERE id = $${fields.length+1} AND company_id = $${fields.length+2} RETURNING *`,
      [...vals, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /customer-portal/equipment/:id
router.delete('/equipment/:id', verifyToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM customer_equipment WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Portal tickets (internal management) ─────────────────────────────────────

// GET /customer-portal/tickets
router.get('/tickets', verifyToken, async (req, res) => {
  try {
    const { status, equipment_id } = req.query;
    let q = `SELECT t.*, u.customer_name, e.equipment_name, e.equipment_tag
               FROM customer_portal_tickets t
               LEFT JOIN customer_portal_users u ON u.id = t.customer_portal_user_id
               LEFT JOIN customer_equipment e ON e.id = t.equipment_id
              WHERE t.company_id = $1`;
    const params = [cid(req)];
    if (status) { params.push(status); q += ` AND t.status = $${params.length}`; }
    if (equipment_id) { params.push(equipment_id); q += ` AND t.equipment_id = $${params.length}`; }
    q += ' ORDER BY t.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /customer-portal/tickets/:id — update status/assignment
router.put('/tickets/:id', verifyToken, async (req, res) => {
  try {
    const { status, assigned_engineer_id, assigned_engineer_name, resolution_notes } = req.body;
    const resolved_at = status === 'closed' ? new Date().toISOString() : null;
    const { rows } = await pool.query(
      `UPDATE customer_portal_tickets
          SET status = COALESCE($1, status),
              assigned_engineer_id = COALESCE($2, assigned_engineer_id),
              assigned_engineer_name = COALESCE($3, assigned_engineer_name),
              resolution_notes = COALESCE($4, resolution_notes),
              resolved_at = COALESCE($5, resolved_at),
              updated_at = NOW()
        WHERE id = $6 AND company_id = $7 RETURNING *`,
      [status, assigned_engineer_id, assigned_engineer_name, resolution_notes, resolved_at, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Documents (internal) ──────────────────────────────────────────────────────

// POST /customer-portal/documents
router.post('/documents', verifyToken, async (req, res) => {
  try {
    const { customer_portal_user_id, equipment_id, document_type, document_name, file_path, external_url } = req.body;
    if (!document_name) return res.status(400).json({ error: 'document_name is required' });
    const { rows } = await pool.query(
      `INSERT INTO customer_portal_documents
         (company_id, customer_portal_user_id, equipment_id, document_type, document_name, file_path, external_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid(req), customer_portal_user_id, equipment_id, document_type, document_name, file_path, external_url]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /customer-portal/documents/:id
router.delete('/documents/:id', verifyToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM customer_portal_documents WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dashboard summary (internal) ──────────────────────────────────────────────
router.get('/dashboard', verifyToken, async (req, res) => {
  try {
    const [accounts, tickets, equipment] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_active THEN 1 ELSE 0 END) AS active FROM customer_portal_users WHERE company_id = $1`, [cid(req)]),
      pool.query(`SELECT status, COUNT(*) AS cnt FROM customer_portal_tickets WHERE company_id = $1 GROUP BY status`, [cid(req)]),
      pool.query(`SELECT warranty_status, COUNT(*) AS cnt FROM customer_equipment WHERE company_id = $1 GROUP BY warranty_status`, [cid(req)]),
    ]);
    const ticketMap = {};
    tickets.rows.forEach(r => { ticketMap[r.status] = parseInt(r.cnt); });
    const warrantyMap = {};
    equipment.rows.forEach(r => { warrantyMap[r.warranty_status] = parseInt(r.cnt); });
    res.json({
      accounts: { total: parseInt(accounts.rows[0].total), active: parseInt(accounts.rows[0].active) },
      tickets: ticketMap,
      equipment: warrantyMap,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
