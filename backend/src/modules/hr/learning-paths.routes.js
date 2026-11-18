// backend/src/modules/hr/learning-paths.routes.js
//
// Learning paths — an ordered set of trainings for a role, a department or a
// new joiner (2026-11-18). Gated on `training` (the router had NO gate: any
// login could assign paths and so enrol anyone). Prerequisites name a
// programme and are enforced when a training is completed (lndEffects).
// Onboarding paths marked "assign on joining" reach every new employee whose
// department / designation matches (autoAssignJoinerPaths, called on hire).
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { cid, sendError, httpError, intOrNull, strOrNull, dateOrNull, dim, params, EMP_NAME, ACTIVE_EMP, loginsFor, notify } from './lnd/lndShared.js';
import { syncPathsFor } from './lnd/lndEffects.js';

const router = express.Router();
router.use(requireCompanyScope);
const view = requirePermission('training', 'view');
const add = requirePermission('training', 'add');
const edit = requirePermission('training', 'edit');
const del = requirePermission('training', 'delete');
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;
const TYPES = ['role', 'onboarding', 'upskilling', 'compliance', 'leadership'];

async function pathInCompany(db, id, companyId) {
  const { rows } = await db.query(`SELECT * FROM learning_paths WHERE id = $1 AND is_active AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Learning path not found');
  return rows[0];
}

router.get('/', view, async (req, res) => {
  try {
    const P = params([cid(req)]);
    const w = ['lp.is_active', '($1::int IS NULL OR lp.company_id = $1)'];
    const t = dim(req.query, 'path_type'); if (t) w.push(`lp.path_type = ${P.add(t)}`);
    const r = dim(req.query, 'target_role'); if (r) w.push(`lp.target_role = ${P.add(r)}`);
    const d = dim(req.query, 'target_department'); if (d) w.push(`lp.target_department = ${P.add(d)}`);
    const q = dim(req.query, 'q'); if (q) w.push(`lp.name ILIKE ${P.add(`%${q}%`)}`);
    const { rows } = await pool.query(`
      SELECT lp.*, it.total_items::int, it.mandatory_items::int, it.total_hours::float,
             asg.assigned::int, asg.completed::int, asg.overdue::int
        FROM learning_paths lp
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS total_items, COUNT(*) FILTER (WHERE i.is_mandatory) AS mandatory_items,
                 COALESCE(SUM(tp.duration_hours),0) AS total_hours
            FROM learning_path_items i JOIN training_programs tp ON tp.id = i.program_id AND tp.deleted_at IS NULL
           WHERE i.path_id = lp.id) it ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE status <> 'withdrawn') AS assigned,
                 COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                 COUNT(*) FILTER (WHERE status = 'in_progress' AND due_date < CURRENT_DATE) AS overdue
            FROM employee_learning_paths WHERE path_id = lp.id) asg ON true
       WHERE ${w.join(' AND ')} ORDER BY lp.name`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load learning paths'); }
});

function pathBody(b, cur = {}) {
  const name = strOrNull(b.name ?? cur.name);
  if (!name) throw httpError(400, 'Name is required');
  const path_type = String(b.path_type ?? cur.path_type ?? 'role');
  if (!TYPES.includes(path_type)) throw httpError(400, 'Unknown path type');
  const pick = (k) => (Object.prototype.hasOwnProperty.call(b, k) ? strOrNull(b[k]) : cur[k] ?? null);
  const due_days = b.due_days === '' || b.due_days === null ? null : intOrNull(b.due_days ?? cur.due_days);
  if (due_days != null && (due_days < 1 || due_days > 730)) throw httpError(400, 'Days to complete must be 1–730');
  return {
    name, path_type, description: pick('description'), target_role: pick('target_role'), target_department: pick('target_department'),
    due_days, auto_assign_on_join: b.auto_assign_on_join === undefined ? !!cur.auto_assign_on_join : !!b.auto_assign_on_join,
  };
}

router.post('/', add, async (req, res) => {
  try {
    const b = pathBody(req.body || {});
    const { rows } = await pool.query(
      `INSERT INTO learning_paths (name, description, path_type, target_role, target_department, due_days, auto_assign_on_join, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.name, b.description, b.path_type, b.target_role, b.target_department, b.due_days, b.auto_assign_on_join, cid(req), uid(req)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A learning path with this name already exists.' });
    sendError(res, err, 'Could not create the path');
  }
});

router.get('/:id', view, async (req, res) => {
  try {
    const p = await pathInCompany(pool, req.params.id, cid(req));
    const { rows: items } = await pool.query(`
      SELECT i.*, tp.title, tp.category, tp.mode, tp.duration_hours::float AS duration_hours, tp.status AS program_status,
             tp.scheduled_date::text AS scheduled_date, pre.title AS prerequisite_title
        FROM learning_path_items i JOIN training_programs tp ON tp.id = i.program_id
        LEFT JOIN training_programs pre ON pre.id = i.prerequisite_program_id
       WHERE i.path_id = $1 AND tp.deleted_at IS NULL ORDER BY i.sequence_order`, [p.id]);
    res.json({ ...p, items });
  } catch (err) { sendError(res, err, 'Could not load the path'); }
});

router.put('/:id', edit, captureBefore('learning_paths'), async (req, res) => {
  try {
    const cur = await pathInCompany(pool, req.params.id, cid(req));
    const b = pathBody(req.body || {}, cur);
    const { rows } = await pool.query(
      `UPDATE learning_paths SET name=$2, description=$3, path_type=$4, target_role=$5, target_department=$6, due_days=$7,
              auto_assign_on_join=$8, updated_at=NOW() WHERE id = $1 RETURNING *`,
      [cur.id, b.name, b.description, b.path_type, b.target_role, b.target_department, b.due_days, b.auto_assign_on_join]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A learning path with this name already exists.' });
    sendError(res, err, 'Could not save the path');
  }
});

router.delete('/:id', del, captureBefore('learning_paths'), async (req, res) => {
  try {
    const cur = await pathInCompany(pool, req.params.id, cid(req));
    await pool.query(`UPDATE learning_paths SET is_active = false, updated_at = NOW() WHERE id = $1`, [cur.id]);
    res.json({ message: 'Learning path archived' });
  } catch (err) { sendError(res, err, 'Could not archive'); }
});

/** Enrol the path's assignees in every item they are not yet enrolled in. */
async function enrollAssigneesInItems(db, pathId, employeeIds, companyId, userId) {
  const { rowCount } = await db.query(`
    INSERT INTO training_enrollments (program_id, employee_id, company_id, status, enrolled_by, enrolled_via)
    SELECT i.program_id, x.eid, $3, 'enrolled', $4, 'path'
      FROM learning_path_items i
      JOIN training_programs tp ON tp.id = i.program_id AND tp.deleted_at IS NULL AND tp.status IN ('planned','ongoing')
      CROSS JOIN UNNEST($2::int[]) AS x(eid)
     WHERE i.path_id = $1
    ON CONFLICT (program_id, employee_id) DO UPDATE SET status = 'enrolled', enrolled_via = 'path', updated_at = NOW()
      WHERE training_enrollments.status = 'withdrawn'`, [pathId, employeeIds, companyId, userId]);
  return rowCount;
}

router.put('/:id/items', edit, async (req, res) => {
  const companyId = cid(req);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const client = await pool.connect();
  try {
    const p = await pathInCompany(client, req.params.id, companyId);
    const ids = items.map(i => intOrNull(i.program_id));
    if (ids.some(x => !x)) throw httpError(400, 'Every item needs a training');
    if (new Set(ids).size !== ids.length) throw httpError(400, 'A training appears twice in this path');
    if (ids.length) {
      const { rows } = await client.query(`SELECT id FROM training_programs WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`, [ids, companyId]);
      if (rows.length !== ids.length) throw httpError(400, 'One of the trainings no longer exists');
    }
    items.forEach((it, i) => {
      const pre = intOrNull(it.prerequisite_program_id);
      if (pre && !ids.slice(0, i).includes(pre)) throw httpError(400, 'A prerequisite must be an earlier training in this path');
    });
    const { rows: prior } = await client.query(`SELECT * FROM learning_path_items WHERE path_id = $1 ORDER BY sequence_order`, [p.id]);
    req._auditBefore = { path_id: p.id, items: prior };
    await client.query('BEGIN');
    await client.query(`DELETE FROM learning_path_items WHERE path_id = $1`, [p.id]);
    for (const [i, it] of items.entries()) {
      await client.query(
        `INSERT INTO learning_path_items (path_id, program_id, sequence_order, is_mandatory, prerequisite_program_id) VALUES ($1,$2,$3,$4,$5)`,
        [p.id, ids[i], i + 1, it.is_mandatory !== false, intOrNull(it.prerequisite_program_id)]);
    }
    await client.query(`UPDATE learning_paths SET estimated_hours = (
        SELECT COALESCE(SUM(tp.duration_hours),0) FROM learning_path_items i JOIN training_programs tp ON tp.id = i.program_id WHERE i.path_id = $1),
        updated_at = NOW() WHERE id = $1`, [p.id]);
    // People already on the path get the new trainings too.
    const { rows: asg } = await client.query(`SELECT employee_id FROM employee_learning_paths WHERE path_id = $1 AND status = 'in_progress'`, [p.id]);
    const added = asg.length ? await enrollAssigneesInItems(client, p.id, asg.map(r => r.employee_id), p.company_id, uid(req)) : 0;
    await client.query('COMMIT');
    res.json({ message: 'Path items saved', count: items.length, new_enrolments: added });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Items were not saved'); }
  finally { client.release(); }
});

/** Assign a path to employees (also used by onboarding). Returns assigned ids. */
export async function assignPath(db, path, employeeIds, { dueDate = null, userId = null }) {
  const ids = [...new Set((employeeIds || []).map(intOrNull).filter(Boolean))];
  if (!ids.length) return [];
  const { rows: valid } = await db.query(
    `SELECT e.id FROM employees e WHERE e.id = ANY($1::int[]) AND ${ACTIVE_EMP} AND ($2::int IS NULL OR e.company_id = $2)`, [ids, path.company_id]);
  const good = valid.map(r => r.id);
  if (!good.length) return [];
  const due = dueDate || (path.due_days ? new Date(Date.now() + path.due_days * 86400000).toISOString().slice(0, 10) : null);
  await db.query(`
    INSERT INTO employee_learning_paths (employee_id, path_id, assigned_by, due_date, company_id, status)
    SELECT x, $2, $3, $4, $5, 'in_progress' FROM UNNEST($1::int[]) x
    ON CONFLICT (employee_id, path_id) DO UPDATE SET assigned_by = EXCLUDED.assigned_by, due_date = EXCLUDED.due_date,
      status = CASE WHEN employee_learning_paths.status = 'completed' THEN 'completed' ELSE 'in_progress' END`,
    [good, path.id, userId, due, path.company_id]);
  await enrollAssigneesInItems(db, path.id, good, path.company_id, userId);
  for (const e of good) await syncPathsFor(db, e);
  return good;
}

router.post('/:id/assign', add, async (req, res) => {
  const client = await pool.connect();
  try {
    const p = await pathInCompany(client, req.params.id, cid(req));
    if (!(req.body?.employee_ids || []).length) throw httpError(400, 'Choose at least one employee');
    await client.query('BEGIN');
    const assigned = await assignPath(client, p, req.body.employee_ids, { dueDate: dateOrNull(req.body.due_date), userId: uid(req) });
    await client.query('COMMIT');
    const logins = await loginsFor(assigned);
    notify({ userIds: logins.map(l => l.user_id), type: 'lnd_path_assigned', referenceId: p.id, companyId: p.company_id,
      title: `Learning path assigned: ${p.name}`, message: `You have been assigned the learning path ${p.name}. See Self Service → My Learning.` }).catch(() => {});
    res.json({ assigned: assigned.length, message: `Path assigned to ${assigned.length} employee(s)` });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not assign'); }
  finally { client.release(); }
});

/** Unassign: the path is withdrawn, and its not-yet-started path enrolments with it. */
router.delete('/:id/assign/:employeeId', edit, async (req, res) => {
  const client = await pool.connect();
  try {
    const p = await pathInCompany(client, req.params.id, cid(req));
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE employee_learning_paths SET status = 'withdrawn' WHERE path_id = $1 AND employee_id = $2 AND status = 'in_progress'`,
      [p.id, req.params.employeeId]);
    if (!rowCount) throw httpError(404, 'This employee has no open assignment on the path');
    await client.query(
      `UPDATE training_enrollments te SET status = 'withdrawn', updated_at = NOW()
        WHERE te.employee_id = $2 AND te.enrolled_via = 'path' AND te.status = 'enrolled'
          AND te.program_id IN (SELECT program_id FROM learning_path_items WHERE path_id = $1)
          AND NOT EXISTS (SELECT 1 FROM employee_learning_paths o JOIN learning_path_items oi ON oi.path_id = o.path_id
                           WHERE o.employee_id = te.employee_id AND o.path_id <> $1 AND o.status = 'in_progress' AND oi.program_id = te.program_id)`,
      [p.id, req.params.employeeId]);
    await client.query('COMMIT');
    res.json({ message: 'Unassigned' });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not unassign'); }
  finally { client.release(); }
});

router.get('/:id/progress', view, async (req, res) => {
  try {
    const p = await pathInCompany(pool, req.params.id, cid(req));
    const P = params([p.id]);
    const w = [`elp.path_id = $1`];
    const st = dim(req.query, 'status');
    if (st === 'overdue') w.push(`elp.status = 'in_progress' AND elp.due_date < CURRENT_DATE`);
    else if (st) w.push(`elp.status = ${P.add(st)}`); else w.push(`elp.status <> 'withdrawn'`);
    const d = dim(req.query, 'department'); if (d) w.push(`e.department = ${P.add(d)}`);
    const { rows } = await pool.query(`
      SELECT elp.id, elp.employee_id, ${EMP_NAME} AS employee_name, e.department, e.office_id, elp.status,
             elp.assigned_date::text AS assigned_date, elp.due_date::text AS due_date, elp.completed_at,
             (elp.status = 'in_progress' AND elp.due_date < CURRENT_DATE) AS overdue,
             COUNT(DISTINCT i.id)::int AS total_items,
             COUNT(DISTINCT i.id) FILTER (WHERE te.status = 'completed')::int AS completed_items,
             COALESCE(ROUND(100.0 * COUNT(DISTINCT i.id) FILTER (WHERE te.status = 'completed') / NULLIF(COUNT(DISTINCT i.id),0)),0)::int AS progress_pct
        FROM employee_learning_paths elp
        JOIN employees e ON e.id = elp.employee_id
        LEFT JOIN learning_path_items i ON i.path_id = elp.path_id
        LEFT JOIN training_enrollments te ON te.program_id = i.program_id AND te.employee_id = elp.employee_id
       WHERE ${w.join(' AND ')}
       GROUP BY elp.id, e.id ORDER BY overdue DESC, 3`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load progress'); }
});

/**
 * Onboarding: assign every "assign on joining" path whose target department /
 * role matches the new employee. Best-effort — called after the hire commits.
 */
export async function autoAssignJoinerPaths(employeeId) {
  try {
    const { rows: [e] } = await pool.query(`SELECT id, company_id, department, designation FROM employees WHERE id = $1`, [employeeId]);
    if (!e) return 0;
    const { rows: paths } = await pool.query(
      `SELECT * FROM learning_paths WHERE is_active AND auto_assign_on_join AND company_id IS NOT DISTINCT FROM $1::int
          AND (target_department IS NULL OR target_department = '' OR target_department = $2)
          AND (target_role IS NULL OR target_role = '' OR LOWER(target_role) = LOWER($3))`,
      [e.company_id, e.department, e.designation || '']);
    let n = 0;
    for (const p of paths) n += (await assignPath(pool, p, [e.id], {})).length;
    if (n) {
      const logins = await loginsFor([e.id]);
      await notify({ userIds: logins.map(l => l.user_id), type: 'lnd_path_assigned', referenceId: e.id, companyId: e.company_id,
        title: 'Your joining learning path', message: 'Onboarding trainings have been assigned to you. See Self Service → My Learning.' });
    }
    return n;
  } catch (err) {
    console.warn(JSON.stringify({ event: 'lnd_auto_assign_failed', employeeId, message: err.message }));
    return 0;
  }
}

export default router;
