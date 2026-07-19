// backend/src/modules/projects/project-members.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const MANAGER_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'project_manager',
                       'Admin', 'SuperAdmin', 'ProjectManager'];

router.use(verifyToken);

/* GET /project-members?project_id=X | employee_id=Y */
router.get('/', async (req, res) => {
  const { project_id, employee_id } = req.query;
  const cid = req.scope?.company_id ?? null;
  const params = [];
  let i = 1;
  let q = `
    SELECT pm.*,
      TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
      e.designation, e.department, e.photo_url,
      p.name AS project_name, p.status AS project_status
    FROM project_members pm
    JOIN employees e ON e.id = pm.employee_id
    JOIN projects p  ON p.id = pm.project_id
    WHERE 1=1
  `;
  if (cid != null)        { params.push(cid);              q += ` AND pm.company_id = $${i++}`; }
  if (project_id)         { params.push(parseInt(project_id,10)); q += ` AND pm.project_id = $${i++}`; }
  if (employee_id)        { params.push(parseInt(employee_id,10)); q += ` AND pm.employee_id = $${i++}`; }
  q += ` ORDER BY p.name, e.first_name`;
  try {
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* POST /project-members — assign employee to project */
router.post('/', allowRoles(...MANAGER_ROLES), async (req, res) => {
  const {
    project_id, employee_id, role_in_project, allocation_pct,
    billing_rate, start_date, end_date, is_billable, notes,
  } = req.body;
  if (!project_id || !employee_id) return res.status(400).json({ message: 'project_id and employee_id required' });
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO project_members
         (company_id, project_id, employee_id, role_in_project, allocation_pct,
          billing_rate, start_date, end_date, is_billable, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (project_id, employee_id)
       DO UPDATE SET
         role_in_project = EXCLUDED.role_in_project,
         allocation_pct  = EXCLUDED.allocation_pct,
         billing_rate    = EXCLUDED.billing_rate,
         start_date      = EXCLUDED.start_date,
         end_date        = EXCLUDED.end_date,
         is_billable     = EXCLUDED.is_billable,
         notes           = EXCLUDED.notes,
         updated_at      = NOW()
       RETURNING *`,
      [cid, project_id, employee_id, role_in_project || 'Member',
       allocation_pct ?? 100, billing_rate || null, start_date || null,
       end_date || null, is_billable ?? true, notes || null]
    );
    logAudit({ userId: req.user?.id, module: 'project_members', recordId: rows[0].id, recordType: 'project_member', action: 'assign', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* PUT /project-members/:id */
router.put('/:id', allowRoles(...MANAGER_ROLES), async (req, res) => {
  const { role_in_project, allocation_pct, billing_rate, start_date, end_date, is_billable, notes } = req.body;
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `UPDATE project_members SET
         role_in_project = COALESCE($1, role_in_project),
         allocation_pct  = COALESCE($2, allocation_pct),
         billing_rate    = COALESCE($3, billing_rate),
         start_date      = COALESCE($4, start_date),
         end_date        = COALESCE($5, end_date),
         is_billable     = COALESCE($6, is_billable),
         notes           = COALESCE($7, notes),
         updated_at      = NOW()
       WHERE id=$8 AND ($9::int IS NULL OR company_id=$9)
       RETURNING *`,
      [role_in_project, allocation_pct, billing_rate, start_date, end_date, is_billable, notes, req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* DELETE /project-members/:id — remove employee from project */
router.delete('/:id', allowRoles(...MANAGER_ROLES), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `DELETE FROM project_members WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    logAudit({ userId: req.user?.id, module: 'project_members', recordId: Number(req.params.id), recordType: 'project_member', action: 'remove', req });
    res.json({ message: 'Removed from project' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
