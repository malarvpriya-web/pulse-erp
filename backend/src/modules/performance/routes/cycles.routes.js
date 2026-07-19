import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const role    = req => req.user?.role ?? 'employee';
const getCid  = req => req.scope?.company_id ?? companyOf(req);
const isHR    = req => ['hr', 'super_admin', 'admin'].includes(role(req));
const isMgr   = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));

/* GET /performance/cycles — list cycles for company */
router.get('/', async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT rc.*,
         (SELECT COUNT(*) FROM performance_reviews pr WHERE pr.review_cycle_id = rc.id)::int AS review_count,
         (SELECT COUNT(*) FROM performance_reviews pr WHERE pr.review_cycle_id = rc.id AND pr.status = 'completed')::int AS completed_count
       FROM review_cycles rc
       WHERE rc.company_id = $1
       ORDER BY rc.created_at DESC`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /performance/cycles/:id */
router.get('/:id', async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT rc.*,
         (SELECT COUNT(*) FROM performance_reviews pr WHERE pr.review_cycle_id = rc.id)::int AS review_count,
         (SELECT COUNT(*) FROM performance_reviews pr WHERE pr.review_cycle_id = rc.id AND pr.status = 'completed')::int AS completed_count,
         (SELECT COUNT(*) FROM performance_reviews pr WHERE pr.review_cycle_id = rc.id AND pr.self_rating IS NOT NULL)::int AS self_submitted_count
       FROM review_cycles rc
       WHERE rc.id = $1 AND rc.company_id = $2`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cycle not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /performance/cycles — HR only */
router.post('/', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const {
    name, cycle_type = 'annual', review_period, financial_year,
    start_date, end_date,
    self_review_deadline, manager_review_deadline, calibration_deadline,
    l2_review_enabled = false, hr_review_enabled = true, description,
  } = req.body;
  if (!name || !review_period) return res.status(400).json({ error: 'name and review_period required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO review_cycles
         (company_id, name, cycle_type, review_period, financial_year,
          start_date, end_date,
          self_review_deadline, manager_review_deadline, calibration_deadline,
          l2_review_enabled, hr_review_enabled, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft')
       RETURNING *`,
      [cid, name, cycle_type, review_period, financial_year || null,
       start_date || null, end_date || null,
       self_review_deadline || null, manager_review_deadline || null, calibration_deadline || null,
       l2_review_enabled, hr_review_enabled, description || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* PATCH /performance/cycles/:id */
router.patch('/:id', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const {
    name, cycle_type, financial_year, start_date, end_date,
    self_review_deadline, manager_review_deadline, calibration_deadline,
    l2_review_enabled, hr_review_enabled, description,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE review_cycles SET
         name                     = COALESCE($2, name),
         cycle_type               = COALESCE($3, cycle_type),
         financial_year           = COALESCE($4, financial_year),
         start_date               = COALESCE($5, start_date),
         end_date                 = COALESCE($6, end_date),
         self_review_deadline     = COALESCE($7, self_review_deadline),
         manager_review_deadline  = COALESCE($8, manager_review_deadline),
         calibration_deadline     = COALESCE($9, calibration_deadline),
         l2_review_enabled        = COALESCE($10, l2_review_enabled),
         hr_review_enabled        = COALESCE($11, hr_review_enabled),
         description              = COALESCE($12, description),
         updated_at               = NOW()
       WHERE id = $1 AND company_id = $13 AND status != 'closed'
       RETURNING *`,
      [req.params.id, name || null, cycle_type || null, financial_year ?? null,
       start_date ?? null, end_date ?? null,
       self_review_deadline ?? null, manager_review_deadline ?? null, calibration_deadline ?? null,
       l2_review_enabled ?? null, hr_review_enabled ?? null, description ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cycle not found or already closed' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /performance/cycles/:id/activate */
router.post('/:id/activate', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  try {
    await pool.query(
      `UPDATE review_cycles SET status = 'active', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
      [req.params.id, cid]
    );
    const { rows } = await pool.query('SELECT * FROM review_cycles WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /performance/cycles/:id/close */
router.post('/:id/close', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  try {
    await pool.query(
      `UPDATE review_cycles SET status = 'closed', updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    const { rows } = await pool.query('SELECT * FROM review_cycles WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /performance/cycles/active — current active cycle */
router.get('/active/current', async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM review_cycles
       WHERE company_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [cid]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
