import { Router } from 'express';
import pool from '../../config/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { companyOf } from '../../shared/scope.js';

const router = Router();

const BRANCH_TYPES  = ['HQ', 'Factory', 'Warehouse', 'Service Center', 'Sales Office', 'Regional Office'];
const ADMIN_ROLES   = ['super_admin', 'admin'];
// `hr` and `payroll_admin` were missing. Branches are the Location master the
// Add Employee form reads, and the people who fill that form in are exactly the
// HR roles `POST /employees` accepts -- a picker that 403s for the role the page
// exists for is a picker that is not there.
const READ_ROLES    = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec',
                       'payroll_admin', 'finance_manager', 'store_keeper', 'manager'];

/**
 * Restrict a branch query to the caller's company.
 *
 * ⚠ GET /branches took `company_id` FROM THE QUERY STRING and applied no filter
 * when it was absent, so every authenticated reader got every tenant's branches
 * -- names, street addresses, phone numbers, contact emails and headcount --
 * and could pick any single tenant's set by passing an id. A client-supplied
 * scope is not a scope. companyOf(req) is the only correct source; see
 * shared/scope.js. A genuinely global scope (super admin) still sees them all.
 */
const scopeBranches = (req, startAt, alias = 'b.') => {
  if (req.scope?.isGlobal === true) return { where: '', params: [] };
  const cid = companyOf(req);
  // No company in scope and not global: show nothing rather than everything.
  // `null` here would read as "match the shared rows", and branches have none.
  if (cid == null) return { where: ' AND FALSE', params: [] };
  // ⚠ The alias is a PARAMETER because the reads join (`FROM branches b`) and
  // the writes do not (`UPDATE branches SET ...`). A hard-coded `b.` produced
  // "missing FROM-clause entry for table b" — a 500 on every branch write,
  // which reads as a broken endpoint rather than as a scoping bug.
  return { where: ` AND ${alias}company_id = $${startAt}`, params: [cid] };
};

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
    const { is_active } = req.query;
    const params = [];
    const where = ['b.deleted_at IS NULL'];

    // `company_id` from req.query is deliberately IGNORED. See scopeBranches.
    const scoped = scopeBranches(req, params.length + 1);
    if (scoped.where) { where.push(scoped.where.replace(/^ AND /, '')); params.push(...scoped.params); }
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
    // branches may not have deleted_at — fall back WITHOUT it, but never
    // without the tenant filter. The previous fallback dropped the whole WHERE
    // clause, so any error at all (a bad `is_active`, a lock timeout) turned
    // this endpoint into an unscoped dump of every company's branches.
    try {
      const scoped = scopeBranches(req, 1);
      const { rows } = await pool.query(
        `SELECT b.*,
                c.name AS company_name,
                COUNT(e.id)::INT AS employee_count
         FROM branches b
         LEFT JOIN companies c ON c.id = b.company_id
         LEFT JOIN employees e ON e.branch_id = b.id AND e.deleted_at IS NULL AND e.status IN ('active', 'probation', 'notice')
         WHERE TRUE${scoped.where}
         GROUP BY b.id, c.name
         ORDER BY c.name, b.name`,
        scoped.params,
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
    // Scoped: another tenant's branch is a 404, not a readable record.
    const scoped = scopeBranches(req, 2);
    const { rows } = await pool.query(
      `SELECT b.*, c.name AS company_name
       FROM branches b
       LEFT JOIN companies c ON c.id = b.company_id
       WHERE b.id = $1${scoped.where}`,
      [req.params.id, ...scoped.params]
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

  // Whose branch this is comes from the TOKEN, not the body. The old code took
  // `company_id` straight off req.body, so an admin could file a branch under
  // another tenant; and when it was absent it fell back to
  // `SELECT id FROM companies ORDER BY id LIMIT 1` — company 1 — which silently
  // planted every scope-less create in the first tenant in the table.
  // A global-scope super admin may still name a company explicitly.
  const callerCid = companyOf(req);
  let cid;
  if (req.scope?.isGlobal === true) {
    cid = company_id ? parseInt(company_id, 10) : callerCid;
  } else {
    cid = callerCid;
    if (company_id != null && parseInt(company_id, 10) !== cid) {
      return res.status(403).json({ error: 'Cannot create a branch for another company.' });
    }
  }
  if (!cid) return res.status(400).json({ error: 'No company in scope. Create a company profile first.' });

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

/**
 * POST /branches/:id/reactivate — bring a deactivated branch back.
 *
 * DELETE below deactivates (it refuses outright when employees are attached),
 * and there was no way back: a branch switched off by mistake was off for good,
 * because nothing set `is_active` to true again. The Branch card showed a power
 * button on active branches only.
 *
 * ⚠ Scoped like every other write here — another tenant's branch is a 404, not
 * a branch this caller may switch on.
 */
router.post('/:id/reactivate', allowRoles(...ADMIN_ROLES), captureBefore('branches'), async (req, res) => {
  const scoped = scopeBranches(req, 2, '');
  try {
    const { rows } = await pool.query(
      `SELECT id FROM branches WHERE id = $1 AND deleted_at IS NULL${scoped.where}`,
      [req.params.id, ...scoped.params]);
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });
    await pool.query(`UPDATE branches SET is_active = true WHERE id = $1`, [rows[0].id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /branches/:id — admin only
router.put('/:id', allowRoles(...ADMIN_ROLES), captureBefore('branches'), async (req, res) => {
  const { name, code, city, state, address, phone, email, branch_type, is_active } = req.body;

  try {
    // ⚠ SCOPED. This UPDATE had no company predicate either, so an admin could
    // rename, re-address or re-activate another tenant's branch by id. Same
    // hole as DELETE below; both are closed against companyOf(req), never
    // against anything the client sent.
    const scoped = scopeBranches(req, 11, '');
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
       WHERE id = $10 AND deleted_at IS NULL${scoped.where}
       RETURNING *`,
      [name || null, code || null, city || null, state || null, address || null,
       phone || null, email || null, branch_type || null,
       is_active !== undefined ? is_active : null,
       req.params.id, ...scoped.params]
    );
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /branches/:id — admin only
router.delete('/:id', allowRoles(...ADMIN_ROLES), captureBefore('branches'), async (req, res) => {
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

    // ⚠ SCOPED. This UPDATE carried no company predicate, so an admin in one
    // tenant could deactivate another tenant's branch by guessing its id —
    // and GET /branches used to hand those ids out. A branch outside the
    // caller's scope is a 404, exactly as if it did not exist.
    const scoped = scopeBranches(req, 2, '');
    const { rows } = await pool.query(
      `UPDATE branches SET is_active = false
        WHERE id = $1 AND deleted_at IS NULL${scoped.where} RETURNING id, name`,
      [req.params.id, ...scoped.params]
    );
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });
    res.json({ success: true, message: `Branch "${rows[0].name}" deactivated`, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { BRANCH_TYPES };
export default router;
