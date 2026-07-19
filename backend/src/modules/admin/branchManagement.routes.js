import { Router } from 'express';
import pool from '../../config/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';

const router = Router();

const BRANCH_TYPES  = ['HQ', 'Factory', 'Warehouse', 'Service Center', 'Sales Office', 'Regional Office'];
const ADMIN_ROLES   = ['super_admin', 'admin'];
const READ_ROLES    = ['super_admin', 'admin', 'hr_manager', 'finance_manager', 'hr_exec', 'store_keeper', 'manager'];

// Ensure branches table has branch_type column
(async () => {
  try {
    await pool.query(`
      ALTER TABLE branches
        ADD COLUMN IF NOT EXISTS branch_type VARCHAR(50),
        ADD COLUMN IF NOT EXISTS address     TEXT,
        ADD COLUMN IF NOT EXISTS state       VARCHAR(100),
        ADD COLUMN IF NOT EXISTS phone       VARCHAR(20),
        ADD COLUMN IF NOT EXISTS email       VARCHAR(255)
    `);
  } catch (e) { console.error('[branchManagement] migration error:', e.message); }
})();

// GET /branches — requires at minimum a manager-level role
router.get('/', allowRoles(...READ_ROLES), async (req, res) => {
  try {
    const { company_id, is_active } = req.query;
    const params = [];
    const where = ['b.deleted_at IS NULL'];

    if (company_id) { params.push(parseInt(company_id)); where.push(`b.company_id = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active !== 'false'); where.push(`b.is_active = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT b.*,
              c.name AS company_name,
              COUNT(e.id)::INT AS employee_count
       FROM branches b
       LEFT JOIN companies c ON c.id = b.company_id
       LEFT JOIN employees e ON e.branch_id = b.id AND e.deleted_at IS NULL AND e.status IN ('active', 'probation', 'notice')
       WHERE ${where.join(' AND ')}
       GROUP BY b.id, c.name
       ORDER BY c.name, b.name`,
      params
    );
    res.json(rows);
  } catch (e) {
    // branches may not have deleted_at — fall back
    try {
      const { rows } = await pool.query(
        `SELECT b.*,
                c.name AS company_name,
                COUNT(e.id)::INT AS employee_count
         FROM branches b
         LEFT JOIN companies c ON c.id = b.company_id
         LEFT JOIN employees e ON e.branch_id = b.id AND e.deleted_at IS NULL AND e.status IN ('active', 'probation', 'notice')
         GROUP BY b.id, c.name
         ORDER BY c.name, b.name`
      );
      res.json(rows);
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// GET /branches/:id
router.get('/:id', allowRoles(...READ_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, c.name AS company_name
       FROM branches b
       LEFT JOIN companies c ON c.id = b.company_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /branches — admin only
router.post('/', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { company_id, name, code, city, state, address, phone, email, branch_type, is_active = true } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Branch name is required' });

  // Get company_id from first company if not provided
  let cid = company_id;
  if (!cid) {
    const { rows } = await pool.query('SELECT id FROM companies ORDER BY id LIMIT 1');
    cid = rows[0]?.id;
  }
  if (!cid) return res.status(400).json({ error: 'No company found. Create a company profile first.' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO branches (company_id, name, code, city, state, address, phone, email, branch_type, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [cid, name.trim(), code || null, city || null, state || null, address || null, phone || null, email || null, branch_type || null, is_active]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Branch code already exists for this company' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PUT /branches/:id — admin only
router.put('/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { name, code, city, state, address, phone, email, branch_type, is_active } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE branches
       SET name        = COALESCE($1, name),
           code        = COALESCE($2, code),
           city        = COALESCE($3, city),
           state       = COALESCE($4, state),
           address     = COALESCE($5, address),
           phone       = COALESCE($6, phone),
           email       = COALESCE($7, email),
           branch_type = COALESCE($8, branch_type),
           is_active   = COALESCE($9, is_active)
       WHERE id = $10
       RETURNING *`,
      [name || null, code || null, city || null, state || null, address || null,
       phone || null, email || null, branch_type || null,
       is_active !== undefined ? is_active : null,
       req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /branches/:id — admin only
router.delete('/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    // Check if branch has employees
    const empCheck = await pool.query(
      `SELECT COUNT(*)::INT AS n FROM employees WHERE branch_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    ).catch(() => ({ rows: [{ n: 0 }] }));

    if (empCheck.rows[0]?.n > 0) {
      return res.status(409).json({
        error: `Cannot delete branch with ${empCheck.rows[0].n} active employees. Reassign employees first.`
      });
    }

    const { rows } = await pool.query(
      `UPDATE branches SET is_active = false WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });
    res.json({ success: true, message: `Branch "${rows[0].name}" deactivated`, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { BRANCH_TYPES };
export default router;
