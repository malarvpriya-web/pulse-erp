// backend/src/modules/hr/employee-skills.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'HR', 'Admin', 'SuperAdmin'];

router.use(verifyToken);

/* GET /employee-skills[?employee_id=X]  — list skills (single employee or all) */
router.get('/', async (req, res) => {
  const { employee_id } = req.query;
  const cid = req.scope?.company_id ?? null;
  try {
    if (employee_id) {
      const { rows } = await pool.query(
        `SELECT * FROM employee_skills
         WHERE employee_id = $1
           AND ($2::int IS NULL OR company_id = $2)
         ORDER BY category, skill_name`,
        [employee_id, cid]
      );
      return res.json(rows);
    }
    // All-company skills matrix — joined with employee name for display
    const { rows } = await pool.query(
      `SELECT es.*,
              TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
              e.department, e.designation, e.office_id, e.photo_url
       FROM employee_skills es
       JOIN employees e ON e.id = es.employee_id
       WHERE ($1::int IS NULL OR es.company_id = $1)
         AND LOWER(e.status) IN ('active','probation')
       ORDER BY e.department, e.first_name, es.category, es.skill_name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* GET /employee-skills/categories — distinct skill categories */
router.get('/categories', async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, sort_order FROM master_skill_categories
       WHERE is_active = true
         AND (company_id IS NULL OR company_id = $1)
       ORDER BY sort_order, name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* GET /employee-skills/expiring?days=30 — skills expiring within N days */
router.get('/expiring', allowRoles(...HR_ROLES), async (req, res) => {
  const days = parseInt(req.query.days ?? '30', 10);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT es.*,
              TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
              e.department
       FROM employee_skills es
       JOIN employees e ON e.id = es.employee_id
       WHERE es.expiry_date IS NOT NULL
         AND es.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::INTERVAL
         AND ($2::int IS NULL OR es.company_id = $2)
       ORDER BY es.expiry_date ASC`,
      [days, cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* POST /employee-skills — add a skill to an employee */
router.post('/', allowRoles(...HR_ROLES), async (req, res) => {
  const {
    employee_id, skill_name, category, proficiency_level,
    years_experience, is_certified, certified_by, certification_date, expiry_date, notes,
  } = req.body;
  if (!employee_id || !skill_name) return res.status(400).json({ message: 'employee_id and skill_name required' });
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_skills
         (company_id, employee_id, skill_name, category, proficiency_level,
          years_experience, is_certified, certified_by, certification_date, expiry_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [cid, employee_id, skill_name, category || null,
       proficiency_level || 'beginner', years_experience || null,
       is_certified ?? false, certified_by || null,
       certification_date || null, expiry_date || null, notes || null]
    );
    logAudit({ userId: req.user?.id, module: 'employee_skills', recordId: rows[0].id, recordType: 'skill', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* PUT /employee-skills/:id — update a skill */
router.put('/:id', allowRoles(...HR_ROLES), async (req, res) => {
  const {
    skill_name, category, proficiency_level, years_experience,
    is_certified, certified_by, certification_date, expiry_date, notes,
  } = req.body;
  const cid = req.scope?.company_id ?? null;
  try {
    const old = await pool.query(
      `SELECT * FROM employee_skills WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    if (!old.rows.length) return res.status(404).json({ message: 'Not found' });
    const { rows } = await pool.query(
      `UPDATE employee_skills SET
         skill_name        = COALESCE($1, skill_name),
         category          = COALESCE($2, category),
         proficiency_level = COALESCE($3, proficiency_level),
         years_experience  = COALESCE($4, years_experience),
         is_certified      = COALESCE($5, is_certified),
         certified_by      = COALESCE($6, certified_by),
         certification_date= COALESCE($7, certification_date),
         expiry_date       = COALESCE($8, expiry_date),
         notes             = COALESCE($9, notes),
         updated_at        = NOW()
       WHERE id=$10 RETURNING *`,
      [skill_name, category, proficiency_level, years_experience,
       is_certified, certified_by, certification_date, expiry_date, notes,
       req.params.id]
    );
    logAudit({ userId: req.user?.id, module: 'employee_skills', recordId: rows[0].id, recordType: 'skill', action: 'update', oldData: old.rows[0], newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* DELETE /employee-skills/:id */
router.delete('/:id', allowRoles(...HR_ROLES), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const old = await pool.query(
      `SELECT * FROM employee_skills WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    if (!old.rows.length) return res.status(404).json({ message: 'Not found' });
    await pool.query(`DELETE FROM employee_skills WHERE id=$1`, [req.params.id]);
    logAudit({ userId: req.user?.id, module: 'employee_skills', recordId: Number(req.params.id), recordType: 'skill', action: 'delete', oldData: old.rows[0], req });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
