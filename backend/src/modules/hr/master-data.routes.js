// backend/src/modules/hr/master-data.routes.js
// Grade, Band, and Skill Category master CRUD for HR Settings
import express from 'express';
import pool from '../../config/db.js';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'HR', 'Admin', 'SuperAdmin'];

router.use(verifyToken);

function masterRouter(tableName) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const cid = req.scope?.company_id ?? null;
    try {
      const { rows } = await pool.query(
        `SELECT * FROM ${tableName}
         WHERE is_active = true
           AND (company_id IS NULL OR company_id = $1)
         ORDER BY name`,
        [cid]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  r.post('/', allowRoles(...HR_ROLES), async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ message: 'name required' });
    const cid = req.scope?.company_id ?? null;
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${tableName} (name, company_id${description !== undefined ? ', description' : ''})
         VALUES ($1, $2${description !== undefined ? ', $3' : ''}) RETURNING *`,
        description !== undefined ? [name, cid, description] : [name, cid]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: 'Name already exists' });
      res.status(500).json({ message: err.message });
    }
  });

  r.put('/:id', allowRoles(...HR_ROLES), async (req, res) => {
    const { name, is_active, description } = req.body;
    const cid = req.scope?.company_id ?? null;
    try {
      const { rows } = await pool.query(
        `UPDATE ${tableName}
         SET name      = COALESCE($1, name),
             is_active = COALESCE($2, is_active)
         WHERE id = $3
           AND (company_id IS NULL OR company_id = $4)
         RETURNING *`,
        [name ?? null, is_active ?? null, req.params.id, cid]
      );
      if (!rows.length) return res.status(404).json({ message: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  r.delete('/:id', allowRoles(...HR_ROLES), async (req, res) => {
    const cid = req.scope?.company_id ?? null;
    try {
      // Soft-delete: set is_active = false
      const { rows } = await pool.query(
        `UPDATE ${tableName} SET is_active = false
         WHERE id = $1 AND (company_id IS NULL OR company_id = $2)
         RETURNING id`,
        [req.params.id, cid]
      );
      if (!rows.length) return res.status(404).json({ message: 'Not found' });
      res.json({ message: 'Deactivated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  return r;
}

router.use('/grades',            masterRouter('master_grades'));
router.use('/bands',             masterRouter('master_bands'));
router.use('/skill-categories',  masterRouter('master_skill_categories'));

export default router;
