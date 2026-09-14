// backend/src/modules/hr/master-data.routes.js
// Grade, Band, and Skill Category master CRUD for HR Settings
import express from 'express';
import pool from '../../config/db.js';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'HR', 'Admin', 'SuperAdmin'];

router.use(verifyToken);

/**
 * @param tableName  the master table this sub-router serves
 * @param opts.description  whether that table actually HAS a `description`
 *   column. Only master_skill_categories does; master_grades and master_bands
 *   do not.
 *
 * The factory used to splice `description` into the INSERT whenever the caller
 * sent one, for all three tables, so `POST /hr-master/grades` with a
 * description reached Postgres as a reference to a column that does not exist
 * and came back 42703 → 500. The PUT had the opposite failure: it destructured
 * `description` and then never used it, so an update carrying one was accepted
 * and the value dropped without a word — including for skill categories, where
 * the column is real and the write would have worked.
 *
 * Declared per table rather than looked up at runtime: the capability is a
 * property of the schema, and stating it at the mount makes the difference
 * between the three visible where they are wired up.
 */
function masterRouter(tableName, { description: supportsDescription = false } = {}) {
  const r = express.Router();

  // Accepting a field this table cannot store and ignoring it is worse than
  // refusing it: the call site reads as if the value was saved.
  const rejectUnsupportedDescription = (req, res) => {
    if (req.body?.description !== undefined && !supportsDescription) {
      res.status(400).json({ message: `${tableName} does not carry a description` });
      return true;
    }
    return false;
  };

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
    if (rejectUnsupportedDescription(req, res)) return;
    const withDescription = supportsDescription && description !== undefined;
    const cid = req.scope?.company_id ?? null;
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${tableName} (name, company_id${withDescription ? ', description' : ''})
         VALUES ($1, $2${withDescription ? ', $3' : ''}) RETURNING *`,
        withDescription ? [name, cid, description] : [name, cid]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: 'Name already exists' });
      res.status(500).json({ message: err.message });
    }
  });

  r.put('/:id', allowRoles(...HR_ROLES), async (req, res) => {
    const { name, is_active, description } = req.body;
    if (rejectUnsupportedDescription(req, res)) return;
    const withDescription = supportsDescription && description !== undefined;
    const cid = req.scope?.company_id ?? null;
    try {
      const { rows } = await pool.query(
        `UPDATE ${tableName}
         SET name      = COALESCE($1, name),
             is_active = COALESCE($2, is_active)
             ${withDescription ? ', description = $5' : ''}
         WHERE id = $3
           AND (company_id IS NULL OR company_id = $4)
         RETURNING *`,
        withDescription
          ? [name ?? null, is_active ?? null, req.params.id, cid, description]
          : [name ?? null, is_active ?? null, req.params.id, cid]
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

// Only skill categories carry a description column — see masterRouter().
router.use('/grades',            masterRouter('master_grades'));
router.use('/bands',             masterRouter('master_bands'));
router.use('/skill-categories',  masterRouter('master_skill_categories', { description: true }));

export default router;
