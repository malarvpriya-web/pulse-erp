// backend/src/modules/hr/onboarding.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { initOnboardingChecklist } from './onboarding.service.js';
import { employeeOf } from '../../shared/scope.js';
import {
  readScope, isHrRecordUser, isLineManager, managesEmployee, parseEmployeeId,
} from '../../shared/employeeAccess.js';

const router = express.Router();
const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'HR', 'Admin', 'SuperAdmin'];

function cid(req) { return req.scope?.company_id ?? null; }

// Is this employee inside the caller's tenant?
//
// Every route below is addressed by :employee_id, and until now none of them
// checked that the id belonged to the caller's company — only that the caller
// held an HR role. An HR user of company B could therefore read, initialise and
// tick off the onboarding checklist of company A's employee. The employees
// module itself already 404s a cross-tenant :id (GET /employees/1 as another
// tenant returns "Employee not found"); this makes the checklist agree with it.
//
// A null companyId is a genuinely global scope (super admin with no company
// assignment), which is the one caller allowed to cross the boundary.
async function employeeInScope(companyId, empId) {
  if (companyId == null) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [empId, companyId]
  );
  return rows.length > 0;
}

const isHR = (req) => HR_ROLES.some(r => r.toLowerCase() === String(req.user?.role || '').toLowerCase());

function requireHR(req, res) {
  if (!isHR(req)) { res.status(403).json({ message: 'Only HR can manage the onboarding checklist' }); return false; }
  return true;
}

/* ─── GET /onboarding/templates ─────────────────────────────── */
/* ?include_inactive=true (HR only) also returns deactivated items, which the
 * Manage Checklist screen needs in order to show and revive them. The default
 * is unchanged: active items only. */
router.get('/templates', async (req, res) => {
  try {
    const companyId = cid(req);
    const wantAll = String(req.query.include_inactive || '') === 'true' && isHR(req);
    const { rows } = await pool.query(`
      SELECT t.*,
             (SELECT COUNT(*)::int FROM hr_onboarding_checklist_progress p
               WHERE p.category = t.category AND p.item_label = t.item_label
                 AND ($1::int IS NULL OR p.company_id = $1::int)) AS usage_count
        FROM hr_onboarding_checklist_templates t
       WHERE ($2::boolean OR t.is_active = true)
         AND (t.company_id IS NULL OR t.company_id = $1)
       ORDER BY t.category, t.sort_order, t.item_label
    `, [companyId, wantAll]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── Checklist template management (HR/Admin) ───────────────────────────────
 *
 * These edit the SAME `hr_onboarding_checklist_templates` table the checklist
 * has always been built from — there is no second onboarding system here. The
 * only thing that needs care is that `hr_onboarding_checklist_progress` keys an
 * employee's completion on the TEXT PAIR (category, item_label), not on a
 * template id. So:
 *
 *   - renaming a template must carry its progress rows across in the same
 *     transaction, or every employee who had ticked that item silently loses it;
 *   - deleting a template that has progress rows would strand that history, so
 *     a used item is DEACTIVATED instead and only an unused one is removed.
 */

// A template the caller may edit: their own company's. The seeded rows with a
// NULL company_id are shared platform defaults and are readable by everyone, so
// letting one tenant rename or delete one would change it for all of them.
async function ownTemplate(companyId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_onboarding_checklist_templates WHERE id = $1`, [id]);
  const t = rows[0];
  if (!t) return { error: 404, message: 'Checklist item not found' };
  if (companyId != null && t.company_id !== companyId) {
    return { error: 404, message: 'Checklist item not found' };
  }
  if (t.company_id == null && companyId != null) {
    return { error: 403, message: 'This is a shared default item and cannot be edited here.' };
  }
  return { template: t };
}

/* ─── POST /onboarding/templates ─────────────────────────────── */
router.post('/templates', async (req, res) => {
  if (!requireHR(req, res)) return;
  const companyId = cid(req);
  const category = String(req.body.category || '').trim();
  const item_label = String(req.body.item_label || '').trim();
  const default_assignee = String(req.body.default_assignee || 'HR').trim() || 'HR';
  const default_offset_days = Number.isFinite(Number(req.body.default_offset_days)) ? Number(req.body.default_offset_days) : 0;
  const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0;
  if (!category || !item_label) return res.status(400).json({ message: 'Category and item are both required' });

  try {
    // A deactivated item with the same name is REVIVED rather than duplicated:
    // the unique key is (company_id, category, item_label), so an insert would
    // fail anyway, and the employee history already filed under that pair
    // belongs to this item.
    const { rows } = await pool.query(`
      INSERT INTO hr_onboarding_checklist_templates
        (company_id, category, item_label, default_assignee, default_offset_days, sort_order, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,true)
      ON CONFLICT (company_id, category, item_label) DO UPDATE SET
        is_active           = true,
        default_assignee    = EXCLUDED.default_assignee,
        default_offset_days = EXCLUDED.default_offset_days,
        sort_order          = EXCLUDED.sort_order,
        updated_at          = NOW()
      RETURNING *
    `, [companyId, category, item_label, default_assignee, default_offset_days, sort_order]);
    logAudit({ userId: req.user?.id, module: 'onboarding', recordId: rows[0].id, recordType: 'onboarding_template', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /onboarding/templates/:id ──────────────────────────── */
router.put('/templates/:id', async (req, res) => {
  if (!requireHR(req, res)) return;
  const companyId = cid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid checklist item id' });

  const own = await ownTemplate(companyId, id).catch(() => ({ error: 500, message: 'Lookup failed' }));
  if (own.error) return res.status(own.error).json({ message: own.message });
  const prev = own.template;

  const category = req.body.category != null ? String(req.body.category).trim() : prev.category;
  const item_label = req.body.item_label != null ? String(req.body.item_label).trim() : prev.item_label;
  if (!category || !item_label) return res.status(400).json({ message: 'Category and item are both required' });
  const default_assignee = req.body.default_assignee != null ? (String(req.body.default_assignee).trim() || 'HR') : prev.default_assignee;
  const default_offset_days = req.body.default_offset_days != null && Number.isFinite(Number(req.body.default_offset_days))
    ? Number(req.body.default_offset_days) : prev.default_offset_days;
  const sort_order = req.body.sort_order != null && Number.isFinite(Number(req.body.sort_order))
    ? Number(req.body.sort_order) : prev.sort_order;
  const is_active = typeof req.body.is_active === 'boolean' ? req.body.is_active : prev.is_active;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Carry the completion history across the rename FIRST. Doing it after the
    // template update would work too, but doing it first means a failure here
    // leaves both tables on the old pair rather than the template on the new one
    // and the history on the old.
    if (category !== prev.category || item_label !== prev.item_label) {
      await client.query(
        `UPDATE hr_onboarding_checklist_progress
            SET category = $1, item_label = $2, updated_at = NOW()
          WHERE category = $3 AND item_label = $4
            AND ($5::int IS NULL OR company_id = $5::int)`,
        [category, item_label, prev.category, prev.item_label, companyId]
      );
    }

    const { rows } = await client.query(`
      UPDATE hr_onboarding_checklist_templates
         SET category = $1, item_label = $2, default_assignee = $3,
             default_offset_days = $4, sort_order = $5, is_active = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *
    `, [category, item_label, default_assignee, default_offset_days, sort_order, is_active, id]);

    await client.query('COMMIT');
    logAudit({ userId: req.user?.id, module: 'onboarding', recordId: id, recordType: 'onboarding_template', action: 'update', oldData: prev, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Another checklist item in that category already has this name.' });
    }
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

/* ─── DELETE /onboarding/templates/:id ───────────────────────── */
/* Deactivates when employees have history against the item; removes it only
 * when nothing has ever been recorded for it. The response says which happened
 * so the UI can tell HR rather than guess. */
router.delete('/templates/:id', async (req, res) => {
  if (!requireHR(req, res)) return;
  const companyId = cid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid checklist item id' });

  const own = await ownTemplate(companyId, id).catch(() => ({ error: 500, message: 'Lookup failed' }));
  if (own.error) return res.status(own.error).json({ message: own.message });
  const t = own.template;

  try {
    const { rows: [used] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM hr_onboarding_checklist_progress
        WHERE category = $1 AND item_label = $2
          AND ($3::int IS NULL OR company_id = $3::int)`,
      [t.category, t.item_label, companyId]
    );
    if (used.n > 0) {
      const { rows } = await pool.query(
        `UPDATE hr_onboarding_checklist_templates
            SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
      logAudit({ userId: req.user?.id, module: 'onboarding', recordId: id, recordType: 'onboarding_template', action: 'deactivate', oldData: t, newData: rows[0], req });
      return res.json({
        action: 'deactivated',
        usage_count: used.n,
        message: `Used by ${used.n} employee record${used.n === 1 ? '' : 's'} — deactivated instead of deleted, so that history is kept.`,
        template: rows[0],
      });
    }
    await pool.query(`DELETE FROM hr_onboarding_checklist_templates WHERE id = $1`, [id]);
    logAudit({ userId: req.user?.id, module: 'onboarding', recordId: id, recordType: 'onboarding_template', action: 'delete', oldData: t, req });
    res.json({ action: 'deleted', usage_count: 0, message: 'Checklist item removed.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /onboarding/progress/:employee_id ─────────────────── */
//
// Who may read a checklist (2026-10-20). This read had NO role check: any
// authenticated user in the company could read any colleague's onboarding
// checklist, per-item HR notes included. Now:
//   · HR seats (HR_RECORD_ROLES) — any employee in their company;
//   · the employee — their own checklist;
//   · a manager / department head — only an employee they manage
//     (shared/employeeAccess.js managesEmployee: reporting line by id, or the
//     current head of the employee's department). Employee Profile shows the
//     Onboarding tab to managers, so this keeps that workflow for their team.
// Everyone else gets 403, decided before the id is looked up. Viewers who are
// not HR do not get the per-item `notes`, which are HR's working remarks.
router.get('/progress/:employee_id', async (req, res) => {
  const empId = parseEmployeeId(req.params.employee_id);
  if (!empId) return res.status(400).json({ message: 'Invalid employee_id' });
  const scope = readScope(req);
  if (scope.refused) return res.status(403).json({ message: 'Your account has no company assignment' });
  const companyId = scope.companyId;
  const hr = isHrRecordUser(req);
  try {
    if (!hr) {
      const me = await employeeOf(req, pool);
      const self = me != null && String(me) === String(empId);
      const managed = !self && isLineManager(req) &&
        await managesEmployee({ managerEmployeeId: me, employeeId: empId, companyId });
      if (!self && !managed) {
        return res.status(403).json({ message: 'You can view onboarding only for yourself or your team' });
      }
    }
    if (!await employeeInScope(companyId, empId)) return res.status(404).json({ message: 'Employee not found' });

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
      archived: false,
    }));

    // Completed items whose template has since been deactivated or renamed away.
    // The progress row still exists — deactivating a checklist item does not
    // delete anybody's history — but it no longer matches an active template, so
    // the merge above drops it and the employee's record loses a task they
    // genuinely completed. Returned separately, flagged, and deliberately NOT
    // counted in `total`: they are history, not outstanding work, and folding
    // them into the denominator would move the percentage every time HR retires
    // an item.
    const live = new Set(templates.map(t => `${t.category}::${t.item_label}`));
    const archived = progress
      .filter(p => p.done && !live.has(`${p.category}::${p.item_label}`))
      .map(p => ({ ...p, archived: true }));

    const total = items.length;
    const done  = items.filter(i => i.done).length;
    const shown = (list) => hr ? list : list.map(({ notes: _notes, ...rest }) => rest);
    res.json({
      employee_id: empId,
      total, done,
      pct: total ? Math.round((done / total) * 100) : 0,
      items: shown(items),
      archived: shown(archived),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /onboarding/progress/:employee_id/init ───────────── */
router.post('/progress/:employee_id/init', async (req, res) => {
  if (!HR_ROLES.includes(req.user?.role)) return res.status(403).json({ message: 'Forbidden' });
  const empId = parseInt(req.params.employee_id, 10);
  const companyId = cid(req);
  try {
    if (!await employeeInScope(companyId, empId)) return res.status(404).json({ message: 'Employee not found' });
    await initOnboardingChecklist(pool, companyId, empId);
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

  // Tenant guard before any read or write: :employee_id is caller-supplied.
  try {
    if (!await employeeInScope(companyId, empId)) return res.status(404).json({ message: 'Employee not found' });
  } catch { return res.status(500).json({ message: 'Could not verify employee' }); }

  // The row is keyed by (employee_id, category, item_label) — the same key the
  // ON CONFLICT below uses. captureBefore() keys on ONE column, so aiming it at
  // :employee_id would snapshot an arbitrary one of this employee's checklist
  // items rather than the one being changed.
  try {
    const { rows: prior } = await pool.query(
      `SELECT * FROM hr_onboarding_checklist_progress
        WHERE employee_id = $1 AND category = $2 AND item_label = $3`,
      [empId, category, item_label]
    );
    // No prior row means this item is being recorded for the first time; null
    // is the honest before-image, not an empty object.
    req._auditBefore = prior[0] ?? null;
  } catch { /* no before-image is a worse audit entry; a 500 is a worse product */ }

  try {
    // $8::int, not a bare $8. This statement mentions $8 ONLY inside
    //   CASE WHEN $5 THEN $8 ELSE NULL END
    // and Postgres cannot deduce a parameter's type from a CASE whose other arm
    // is an untyped NULL, so it fell back to `text` — while the target column
    // `completed_by` is integer. Every tick of every checklist item therefore
    // 500'd with
    //   column "completed_by" is of type integer but expression is of type text
    // which the profile page reported as "Failed to update checklist item".
    // The cast gives the deduction something to bind to. $5 is cast for the same
    // reason: it lands in a boolean column but is also read as the CASE
    // predicate, and leaving that to inference is the same trap one step away.
    const { rows } = await pool.query(`
      INSERT INTO hr_onboarding_checklist_progress
        (company_id, employee_id, category, item_label, done, notes, assignee, completed_at, completed_by)
      VALUES ($1,$2,$3,$4,$5::boolean,$6,$7,
        CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
        CASE WHEN $5::boolean THEN $8::int ELSE NULL END)
      ON CONFLICT (employee_id, category, item_label) DO UPDATE SET
        done         = EXCLUDED.done,
        notes        = COALESCE(EXCLUDED.notes, hr_onboarding_checklist_progress.notes),
        assignee     = COALESCE(EXCLUDED.assignee, hr_onboarding_checklist_progress.assignee),
        completed_at = CASE WHEN EXCLUDED.done THEN NOW() ELSE NULL END,
        completed_by = CASE WHEN EXCLUDED.done THEN $8::int ELSE NULL END,
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
