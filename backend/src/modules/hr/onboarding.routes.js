// backend/src/modules/hr/onboarding.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';

const router = express.Router();
const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'HR', 'Admin', 'SuperAdmin'];

function cid(req) { return req.scope?.company_id ?? null; }

/* ─── GET /onboarding/templates ─────────────────────────────── */
router.get('/templates', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(`
      SELECT * FROM hr_onboarding_checklist_templates
      WHERE is_active = true
        AND (company_id IS NULL OR company_id = $1)
      ORDER BY category, sort_order, item_label
    `, [companyId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /onboarding/progress/:employee_id ─────────────────── */
router.get('/progress/:employee_id', async (req, res) => {
  const empId = parseInt(req.params.employee_id, 10);
  if (!empId) return res.status(400).json({ message: 'Invalid employee_id' });
  const companyId = cid(req);
  try {
    // Get template items
    const { rows: templates } = await pool.query(`
      SELECT * FROM hr_onboarding_checklist_templates
      WHERE is_active = true AND (company_id IS NULL OR company_id = $1)
      ORDER BY category, sort_order
    `, [companyId]);

    // Get existing progress
    const { rows: progress } = await pool.query(
      `SELECT * FROM hr_onboarding_checklist_progress WHERE employee_id = $1`,
      [empId]
    );
    const progressMap = {};
    progress.forEach(p => { progressMap[`${p.category}::${p.item_label}`] = p; });

    // Merge template + progress
    const items = templates.map(t => ({
      ...t,
      ...( progressMap[`${t.category}::${t.item_label}`] || {} ),
      done: progressMap[`${t.category}::${t.item_label}`]?.done || false,
    }));

    const total = items.length;
    const done  = items.filter(i => i.done).length;
    res.json({ employee_id: empId, total, done, pct: total ? Math.round((done / total) * 100) : 0, items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /onboarding/progress/:employee_id/init ───────────── */
router.post('/progress/:employee_id/init', async (req, res) => {
  if (!HR_ROLES.includes(req.user?.role)) return res.status(403).json({ message: 'Forbidden' });
  const empId = parseInt(req.params.employee_id, 10);
  const companyId = cid(req);
  try {
    const { rows: templates } = await pool.query(`
      SELECT * FROM hr_onboarding_checklist_templates
      WHERE is_active = true AND (company_id IS NULL OR company_id = $1)
    `, [companyId]);

    // Get employee joining_date to compute due_dates
    const { rows: [emp] } = await pool.query(`SELECT joining_date FROM employees WHERE id=$1`, [empId]);
    const joining = emp?.joining_date ? new Date(emp.joining_date) : new Date();

    for (const t of templates) {
      const dueDate = new Date(joining);
      dueDate.setDate(dueDate.getDate() + (t.default_offset_days || 0));
      await pool.query(`
        INSERT INTO hr_onboarding_checklist_progress
          (company_id, employee_id, category, item_label, assignee, due_date)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (employee_id, category, item_label) DO NOTHING
      `, [companyId, empId, t.category, t.item_label, t.default_assignee, dueDate.toISOString().split('T')[0]]);
    }
    logAudit({ userId: req.user?.id, module: 'onboarding', recordId: empId, recordType: 'onboarding_checklist', action: 'INIT_ONBOARDING', newData: { employee_id: empId }, req });
    res.json({ message: 'Onboarding checklist initialized', employee_id: empId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PATCH /onboarding/progress/:employee_id/item ──────────── */
router.patch('/progress/:employee_id/item', async (req, res) => {
  if (!HR_ROLES.includes(req.user?.role)) return res.status(403).json({ message: 'Forbidden' });
  const empId = parseInt(req.params.employee_id, 10);
  const { category, item_label, done, notes, assignee } = req.body;
  if (!category || !item_label) return res.status(400).json({ message: 'category and item_label required' });
  const companyId = cid(req);
  const completedBy = req.user?.employee_id ?? null;
  try {
    const { rows } = await pool.query(`
      INSERT INTO hr_onboarding_checklist_progress
        (company_id, employee_id, category, item_label, done, notes, assignee, completed_at, completed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,
        CASE WHEN $5 THEN NOW() ELSE NULL END, CASE WHEN $5 THEN $8 ELSE NULL END)
      ON CONFLICT (employee_id, category, item_label) DO UPDATE SET
        done         = EXCLUDED.done,
        notes        = COALESCE(EXCLUDED.notes, hr_onboarding_checklist_progress.notes),
        assignee     = COALESCE(EXCLUDED.assignee, hr_onboarding_checklist_progress.assignee),
        completed_at = CASE WHEN EXCLUDED.done THEN NOW() ELSE NULL END,
        completed_by = CASE WHEN EXCLUDED.done THEN $8 ELSE NULL END,
        updated_at   = NOW()
      RETURNING *
    `, [companyId, empId, category, item_label, done ?? false, notes || null, assignee || 'HR', completedBy]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /onboarding/pending — list employees with incomplete onboarding ── */
router.get('/pending', async (req, res) => {
  if (!HR_ROLES.includes(req.user?.role)) return res.status(403).json({ message: 'Forbidden' });
  const companyId = cid(req);
  try {
    const cidClause = companyId != null ? 'AND e.company_id = $1' : '';
    const params    = companyId != null ? [companyId] : [];
    const { rows } = await pool.query(`
      SELECT e.id, e.office_id,
             e.first_name || ' ' || COALESCE(e.last_name,'') AS name,
             e.department, e.designation, e.joining_date,
             COUNT(p.id)              AS total,
             COUNT(p.id) FILTER (WHERE p.done) AS done_count
      FROM employees e
      LEFT JOIN hr_onboarding_checklist_progress p ON p.employee_id = e.id
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active','probation')
        AND e.joining_date >= NOW() - INTERVAL '90 days'
        ${cidClause}
      GROUP BY e.id, e.office_id, e.first_name, e.last_name, e.department, e.designation, e.joining_date
      HAVING COUNT(p.id) = 0 OR COUNT(p.id) > COUNT(p.id) FILTER (WHERE p.done)
      ORDER BY e.joining_date DESC
      LIMIT 50
    `, params);
    res.json(rows.map(r => ({
      ...r,
      pct: r.total > 0 ? Math.round((r.done_count / r.total) * 100) : 0,
    })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
