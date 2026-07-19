import express from 'express';
import orgChartRepository from '../repositories/orgchart.repository.js';
import { verifyToken, allowRoles } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';

const router = express.Router();

const HR_ROLES = [
  'admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec',
  'Admin', 'SuperAdmin', 'HR',
];

// All org chart routes require authentication
router.use(verifyToken);

// Org chart membership. One row per org_relationships record, enriched from the
// employees master at read time — identity fields are never copied into the org
// table. LEFT JOIN is deliberate: a member whose employee record has been
// soft-deleted still returns its row with NULL identity, which the UI renders as
// an unresolved member (Employee ID only) rather than silently dropping it.
router.get('/members', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await (await import('../../../config/db.js')).default.query(`
      SELECT
        o.employee_id              AS id,
        e.office_id                AS employee_id,
        e.first_name,
        e.last_name,
        e.designation,
        e.department,
        e.sub_department,
        e.photo_url                AS profile_photo,
        e.reporting_manager_id     AS reports_to,
        COALESCE(e.company_email, e.personal_email) AS email,
        e.status,
        o.role,
        o.display_order,
        o.is_active,
        (e.id IS NULL)             AS unresolved
      FROM org_relationships o
      LEFT JOIN employees e
        ON e.id = o.employee_id
       AND e.deleted_at IS NULL
      WHERE ($1::int IS NULL OR o.company_id = $1 OR o.company_id IS NULL)
      ORDER BY COALESCE(e.department, ''), o.display_order, e.first_name
    `, [cid]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load org chart members' });
  }
});

// Employees in the master who are NOT yet org members — feeds the Add Member
// picker. Selecting one of these is what auto-populates the detail fields.
router.get('/member-candidates', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await (await import('../../../config/db.js')).default.query(`
      SELECT
        e.id,
        e.office_id      AS employee_id,
        e.first_name,
        e.last_name,
        e.department,
        e.sub_department,
        e.designation,
        e.photo_url      AS profile_photo,
        e.status
      FROM employees e
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active', 'probation', 'notice')
        AND ($1::int IS NULL OR e.company_id = $1)
        AND NOT EXISTS (SELECT 1 FROM org_relationships o WHERE o.employee_id = e.id)
      ORDER BY e.first_name, e.last_name
    `, [cid]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load candidate employees' });
  }
});

// Add an employee to the org structure. Only role / display_order / is_active are
// caller-supplied; department is denormalised from the master for grouping.
router.post('/members', allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { employee_id, role = 'member', display_order = 0, is_active = true } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    if (!['head', 'member'].includes(role)) {
      return res.status(400).json({ error: "role must be 'head' or 'member'" });
    }
    const cid = req.scope?.company_id ?? null;
    const pool = (await import('../../../config/db.js')).default;

    const { rows: emp } = await pool.query(
      `SELECT id, department, company_id FROM employees
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::int IS NULL OR company_id = $2)`,
      [employee_id, cid]
    );
    if (!emp.length) return res.status(404).json({ error: 'Employee not found in master' });

    const { rows } = await pool.query(
      `INSERT INTO org_relationships
         (employee_id, department, company_id, role, display_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (employee_id) DO UPDATE SET
         role = EXCLUDED.role,
         display_order = EXCLUDED.display_order,
         is_active = EXCLUDED.is_active,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [employee_id, emp[0].department, emp[0].company_id, role, display_order, is_active]
    );

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'orgchart', action: 'create',
      recordId: employee_id, recordType: 'org_member',
      newData: rows[0], req,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit the manual fields of an existing member.
router.put('/members/:employee_id', allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { role, display_order, is_active } = req.body;
    if (role !== undefined && !['head', 'member'].includes(role)) {
      return res.status(400).json({ error: "role must be 'head' or 'member'" });
    }
    const cid = req.scope?.company_id ?? null;
    const pool = (await import('../../../config/db.js')).default;
    const { rows } = await pool.query(
      `UPDATE org_relationships
          SET role          = COALESCE($1, role),
              display_order = COALESCE($2, display_order),
              is_active     = COALESCE($3, is_active),
              updated_at    = CURRENT_TIMESTAMP
        WHERE employee_id = $4
          AND ($5::int IS NULL OR company_id = $5 OR company_id IS NULL)
        RETURNING *`,
      [role ?? null, display_order ?? null, is_active ?? null, req.params.employee_id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'orgchart', action: 'update',
      recordId: req.params.employee_id, recordType: 'org_member',
      newData: rows[0], req,
    });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove from the org structure only — the employee master record is untouched.
router.delete('/members/:employee_id', allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const pool = (await import('../../../config/db.js')).default;
    const { rowCount } = await pool.query(
      `DELETE FROM org_relationships
        WHERE employee_id = $1
          AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
      [req.params.employee_id, cid]
    );
    if (!rowCount) return res.status(404).json({ error: 'Member not found' });

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'orgchart', action: 'delete',
      recordId: req.params.employee_id, recordType: 'org_member', req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update reporting manager for a single employee
router.put('/reporting-manager', allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { employee_id, manager_id } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    const cid = req.scope?.company_id ?? null;
    const pool = (await import('../../../config/db.js')).default;
    await pool.query(
      'UPDATE employees SET reporting_manager_id = $1 WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)',
      [manager_id ?? null, employee_id, cid]
    );
    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'orgchart',
      action: 'update',
      recordId: employee_id,
      recordType: 'reporting_manager',
      req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/hierarchy', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const hierarchy = await orgChartRepository.getHierarchy(cid);
    res.json(hierarchy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tree', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const tree = await orgChartRepository.buildTree(cid);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/auto-tree', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const tree = await orgChartRepository.buildAutoTree(cid);
    res.json({ success: true, data: tree });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/departments', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const depts = await orgChartRepository.getDepartments(cid);
    res.json({ success: true, data: depts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/department/:department', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const employees = await orgChartRepository.getByDepartment(req.params.department, cid);
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/direct-reports/:manager_id', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const reports = await orgChartRepository.getDirectReports(req.params.manager_id, cid);
    res.json(reports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk hierarchy update — sets reporting_manager_id for multiple employees at once
router.put('/hierarchy', allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates array is required' });
    }
    const cid = req.scope?.company_id ?? null;
    const pool = (await import('../../../config/db.js')).default;
    const cycleErrors = [];
    let updated = 0;

    for (const { employee_id, manager_id } of updates) {
      if (!employee_id) continue;
      if (manager_id && await orgChartRepository.wouldCreateCycle(employee_id, manager_id)) {
        cycleErrors.push(`Circular chain for employee ${employee_id}`);
        continue;
      }
      await pool.query(
        `UPDATE employees
            SET reporting_manager_id = $1,
                reporting_manager = COALESCE(
                  (SELECT TRIM(first_name || ' ' || COALESCE(last_name,'')) FROM employees WHERE id = $1),
                  reporting_manager
                )
          WHERE id = $2
            AND ($3::int IS NULL OR company_id = $3)`,
        [manager_id ?? null, employee_id, cid]
      );
      updated++;
    }

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'orgchart',
      action: 'bulk_update',
      recordType: 'hierarchy',
      req,
    });

    if (cycleErrors.length > 0) {
      return res.status(207).json({ success: true, updated, errors: cycleErrors });
    }
    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Relationship writes are HR-only and fully audited
router.post('/relationship', allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const relationship = await orgChartRepository.upsert(req.body);
    logAudit({
      userId: req.user?.id,
      module: 'orgchart',
      recordId: relationship.employee_id,
      recordType: 'org_relationship',
      action: 'upsert',
      newData: relationship,
      req,
    });
    res.json(relationship);
  } catch (error) {
    const isCycle = error.message.includes('Circular');
    res.status(isCycle ? 409 : 500).json({ error: error.message });
  }
});

export default router;
