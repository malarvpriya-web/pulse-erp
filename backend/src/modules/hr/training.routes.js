// backend/src/modules/hr/training.routes.js
//
// Trainings — programmes, enrolment, sessions + attendance, costs, repeat
// rounds, dashboard and compliance (Learning Center consolidation 2026-11-18).
//
// Every route is gated on the `training` module (HR, HR manager, HR exec,
// admin hold it; employee does not). An employee's own learning is served by
// /my-learning, which is scoped to the caller. Tenant = companyOf(req), and
// every :id is checked against it.
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { singleFileUpload } from './internshipUploads.js';
import { uploadFile } from '../../services/StorageService.js';
import {
  cid, lndRange, dim, intOrNull, numOrNull, dateOrNull, strOrNull, params, getSettings, sendError, httpError,
  PROGRAM_STATUSES, ENROLLMENT_STATUSES, MODES, COST_TYPES, EMP_NAME, ACTIVE_EMP, loginsFor, notify, venueLine,
} from './lnd/lndShared.js';
import { completeEnrollment } from './lnd/lndEffects.js';
import { computeCompliance } from './lnd/lndCompliance.js';
import { cleanItems, programSelfReviews } from './lnd/lndSelfReview.js';

const router = express.Router();
router.use(requireCompanyScope);
const view = requirePermission('training', 'view');
const add = requirePermission('training', 'add');
const edit = requirePermission('training', 'edit');
const del = requirePermission('training', 'delete');
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

/* ── shared lookups ─────────────────────────────────────────────── */
async function programInCompany(db, id, companyId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM training_programs WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)${lock ? ' FOR UPDATE' : ''}`,
    [id, companyId]);
  if (!rows.length) throw httpError(404, 'Training not found');
  return rows[0];
}

/** Programme list WHERE clause from the standard filter set. */
function programFilters(q, companyId, alias = 'p') {
  const P = params();
  const w = [`${alias}.deleted_at IS NULL`];
  if (companyId != null) w.push(`${alias}.company_id = ${P.add(companyId)}`);
  const r = lndRange(q, 'all');
  if (r.from) w.push(`COALESCE(${alias}.end_date, ${alias}.scheduled_date) >= ${P.add(r.from)}::date`);
  if (r.to) w.push(`${alias}.scheduled_date <= ${P.add(r.to)}::date`);
  const status = dim(q, 'status');
  if (status) w.push(`${alias}.status = ANY(${P.add(status.split(','))}::text[])`);
  const category = dim(q, 'category');
  if (category) w.push(`${alias}.category = ${P.add(category)}`);
  const department = dim(q, 'department');
  if (department) w.push(`(${alias}.target_department = ${P.add(department)} OR ${alias}.target_department IS NULL OR ${alias}.target_department = '')`);
  const mode = dim(q, 'mode');
  if (mode) w.push(`${alias}.mode = ${P.add(mode)}`);
  const trainer = intOrNull(q.trainer_id);
  if (trainer) w.push(`${alias}.trainer_id = ${P.add(trainer)}`);
  if (q.mandatory === 'true' || q.mandatory === 'false') w.push(`${alias}.is_mandatory = ${P.add(q.mandatory === 'true')}`);
  const series = intOrNull(q.series_id);
  if (series) w.push(`COALESCE(${alias}.series_id, ${alias}.id) = ${P.add(series)}`);
  // Cost range — on what was actually spent (sum of the training's cost lines).
  const cmin = numOrNull(q.cost_min); const cmax = numOrNull(q.cost_max);
  const costExpr = `(SELECT COALESCE(SUM(amount),0) FROM training_costs WHERE program_id = ${alias}.id)`;
  if (cmin != null) w.push(`${costExpr} >= ${P.add(cmin)}`);
  if (cmax != null) w.push(`${costExpr} <= ${P.add(cmax)}`);
  const text = dim(q, 'q');
  if (text) { const ph = P.add(`%${text}%`); w.push(`(${alias}.title ILIKE ${ph} OR ${alias}.description ILIKE ${ph} OR ${alias}.trainer ILIKE ${ph})`); }
  return { where: w.join(' AND '), P, range: r };
}

/** Validate + normalise a programme body. `partial` = PUT (missing keys left alone). */
async function programBody(db, b, companyId, partial = false) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has('title')) {
    out.title = strOrNull(b.title);
    if (!out.title) throw httpError(400, 'Title is required');
    if (out.title.length > 255) throw httpError(400, 'Title is too long');
  }
  for (const k of ['description', 'category', 'target_department', 'target_role', 'online_link', 'venue']) if (!partial || has(k)) out[k] = strOrNull(b[k]);
  if (!partial || has('mode')) {
    out.mode = strOrNull(b.mode) || 'offline';
    if (!MODES.includes(out.mode)) throw httpError(400, 'Mode must be offline, online or hybrid');
  }
  if (!partial || has('scheduled_date')) {
    out.scheduled_date = dateOrNull(b.scheduled_date);
    if (!out.scheduled_date) throw httpError(400, 'Start date is required');
  }
  if (!partial || has('end_date')) out.end_date = dateOrNull(b.end_date);
  if (out.end_date && (out.scheduled_date || b.scheduled_date) && out.end_date < (out.scheduled_date || b.scheduled_date)) {
    throw httpError(400, 'End date cannot be before the start date');
  }
  const nums = { duration_hours: [0.5, 1000], cost_per_participant: [0, 1e9], max_participants: [1, 10000], budget: [0, 1e10], refresher_months: [1, 60] };
  for (const [k, [lo, hi]] of Object.entries(nums)) {
    if (partial && !has(k)) continue;
    const v = numOrNull(b[k]);
    if (v != null && (v < lo || v > hi)) throw httpError(400, `${k.replace(/_/g, ' ')} must be between ${lo} and ${hi}`);
    out[k] = v;
  }
  if (!partial) {
    if (out.duration_hours == null) out.duration_hours = 8;
    if (out.max_participants == null) out.max_participants = 30;
    if (out.cost_per_participant == null) out.cost_per_participant = 0;
  }
  if (!partial || has('is_mandatory')) out.is_mandatory = b.is_mandatory === true || b.is_mandatory === 'true';
  if (out.is_mandatory && !partial && out.refresher_months == null && b.refresher_months === undefined) {
    out.refresher_months = (await getSettings(companyId, db)).default_refresher_months;
  }
  if (!partial || has('self_review_enabled')) out.self_review_enabled = b.self_review_enabled === undefined ? true : (b.self_review_enabled === true || b.self_review_enabled === 'true');
  if (!partial || has('self_review_items')) out.self_review_items = JSON.stringify(cleanItems(b.self_review_items));
  if (!partial || has('trainer_id')) {
    out.trainer_id = intOrNull(b.trainer_id);
    out.trainer = null;
    if (out.trainer_id) {
      const { rows } = await db.query(`SELECT name FROM trainers WHERE id = $1 AND is_active AND ($2::int IS NULL OR company_id = $2)`, [out.trainer_id, companyId]);
      if (!rows.length) throw httpError(400, 'Choose an active trainer from Trainer list');
      out.trainer = rows[0].name;
    }
  }
  if (!partial || has('competency_id')) {
    out.competency_id = intOrNull(b.competency_id);
    if (out.competency_id) {
      const { rows } = await db.query(`SELECT 1 FROM competency_framework WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [out.competency_id, companyId]);
      if (!rows.length) throw httpError(400, 'Unknown skill / competency');
    }
  }
  return out;
}

/* ── GET /programs ──────────────────────────────────────────────── */
router.get('/programs', view, async (req, res) => {
  try {
    const { where, P } = programFilters(req.query, cid(req));
    const { rows } = await pool.query(`
      SELECT p.*, p.scheduled_date::text AS scheduled_date, p.end_date::text AS end_date,
             COALESCE(t.name, p.trainer) AS trainer_name, cf.name AS competency_name,
             COALESCE(p.series_id, p.id) AS series_root,
             (SELECT COUNT(*) FROM training_programs r WHERE COALESCE(r.series_id, r.id) = COALESCE(p.series_id, p.id) AND r.deleted_at IS NULL)::int AS rounds_in_series,
             COALESCE(en.enrolled, 0)::int AS enrolled_count, COALESCE(en.completed, 0)::int AS completed_count,
             COALESCE(en.no_show, 0)::int AS no_show_count, en.avg_rating::float AS avg_rating,
             CASE WHEN COALESCE(en.enrolled,0) > 0 THEN ROUND(100.0 * en.completed / en.enrolled)::int END AS completion_pct,
             COALESCE(c.total, 0)::float AS total_cost
        FROM training_programs p
        LEFT JOIN trainers t ON t.id = p.trainer_id
        LEFT JOIN competency_framework cf ON cf.id = p.competency_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE status <> 'withdrawn') AS enrolled,
                 COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                 COUNT(*) FILTER (WHERE status = 'no_show') AS no_show,
                 ROUND(AVG(feedback_rating), 1) AS avg_rating
            FROM training_enrollments WHERE program_id = p.id) en ON true
        LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM training_costs WHERE program_id = p.id) c ON true
       WHERE ${where}
       ORDER BY p.scheduled_date DESC NULLS LAST, p.id DESC
       LIMIT 1000`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load trainings'); }
});

/* ── GET /filter-options ────────────────────────────────────────── */
router.get('/filter-options', view, async (req, res) => {
  const companyId = cid(req);
  try {
    const [settings, depts, trainers, desig, comps] = await Promise.all([
      getSettings(companyId),
      pool.query(`SELECT name FROM master_departments WHERE COALESCE(is_active, true)
                  UNION SELECT DISTINCT department FROM employees e WHERE ${ACTIVE_EMP} AND department IS NOT NULL AND ($1::int IS NULL OR e.company_id = $1)
                  ORDER BY 1`, [companyId]),
      pool.query(`SELECT id, name, trainer_type FROM trainers WHERE is_active AND ($1::int IS NULL OR company_id = $1) ORDER BY name`, [companyId]),
      pool.query(`SELECT name FROM master_designations WHERE COALESCE(is_active, true)
                  UNION SELECT DISTINCT designation FROM employees e WHERE ${ACTIVE_EMP} AND designation IS NOT NULL AND ($1::int IS NULL OR e.company_id = $1)
                  ORDER BY 1`, [companyId]),
      pool.query(`SELECT id, name, category FROM competency_framework WHERE is_active AND ($1::int IS NULL OR company_id = $1) ORDER BY name`, [companyId]),
    ]);
    res.json({
      categories: settings.training_categories,
      departments: depts.rows.map(r => r.name).filter(Boolean),
      designations: desig.rows.map(r => r.name).filter(Boolean),
      trainers: trainers.rows,
      competencies: comps.rows,
      statuses: PROGRAM_STATUSES, modes: MODES, cost_types: COST_TYPES,
      settings: { allow_self_enrollment: settings.allow_self_enrollment, default_refresher_months: settings.default_refresher_months, default_pass_score: settings.default_pass_score, default_max_attempts: settings.default_max_attempts },
    });
  } catch (err) { sendError(res, err, 'Could not load filters'); }
});

/* ── GET /employees — active employees for pickers (training:view) ── */
router.get('/employees', view, async (req, res) => {
  try {
    const P = params([cid(req)]);
    const w = [`${ACTIVE_EMP}`, `($1::int IS NULL OR e.company_id = $1)`];
    const d = dim(req.query, 'department'); if (d) w.push(`e.department = ${P.add(d)}`);
    const { rows } = await pool.query(
      `SELECT e.id, ${EMP_NAME} AS name, e.office_id, e.department, e.designation
         FROM employees e WHERE ${w.join(' AND ')} ORDER BY 2`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load employees'); }
});

/* ── POST /programs ─────────────────────────────────────────────── */
router.post('/programs', add, async (req, res) => {
  const companyId = cid(req);
  try {
    const b = await programBody(pool, req.body || {}, companyId);
    const { rows } = await pool.query(`
      INSERT INTO training_programs (title, description, category, trainer, trainer_id, mode, duration_hours,
        cost_per_participant, max_participants, scheduled_date, end_date, is_mandatory, refresher_months,
        target_department, target_role, online_link, venue, budget, competency_id, status, company_id, created_by,
        self_review_enabled, self_review_items)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'planned',$20,$21,$22,$23::jsonb) RETURNING *`,
      [b.title, b.description, b.category, b.trainer, b.trainer_id, b.mode, b.duration_hours, b.cost_per_participant,
       b.max_participants, b.scheduled_date, b.end_date, b.is_mandatory, b.refresher_months, b.target_department,
       b.target_role, b.online_link, b.venue, b.budget, b.competency_id, companyId, uid(req), b.self_review_enabled, b.self_review_items]);
    res.status(201).json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not create the training'); }
});

/* ── GET /programs/:id ──────────────────────────────────────────── */
router.get('/programs/:id', view, async (req, res) => {
  const companyId = cid(req);
  try {
    const p = await programInCompany(pool, req.params.id, companyId);
    const [prog, enrollments, costs, sessions, rounds, assessments] = await Promise.all([
      pool.query(`SELECT p.*, p.scheduled_date::text AS scheduled_date, p.end_date::text AS end_date,
                         COALESCE(t.name, p.trainer) AS trainer_name, cf.name AS competency_name
                    FROM training_programs p LEFT JOIN trainers t ON t.id = p.trainer_id
                    LEFT JOIN competency_framework cf ON cf.id = p.competency_id WHERE p.id = $1`, [p.id]),
      pool.query(`SELECT te.*, te.completion_date::text AS completion_date, ${EMP_NAME} AS employee_name,
                         e.office_id, e.department, e.designation,
                         att.present::int AS sessions_present, att.marked::int AS sessions_marked
                    FROM training_enrollments te JOIN employees e ON e.id = te.employee_id
                    LEFT JOIN LATERAL (
                      SELECT COUNT(*) FILTER (WHERE ta.present) AS present, COUNT(*) AS marked
                        FROM training_attendance ta JOIN training_sessions s ON s.id = ta.session_id
                       WHERE s.program_id = te.program_id AND ta.employee_id = te.employee_id) att ON true
                   WHERE te.program_id = $1 ORDER BY 2`, [p.id]),
      pool.query(`SELECT id, program_id, cost_type, description, created_by, created_at, cost_date::text AS cost_date, amount::float AS amount FROM training_costs WHERE program_id = $1 ORDER BY 7, 1`, [p.id]),
      pool.query(`SELECT s.*, s.session_date::text AS session_date, tr.name AS trainer_name,
                         (SELECT COUNT(*) FROM training_attendance a WHERE a.session_id = s.id AND a.present)::int AS present_count
                    FROM training_sessions s LEFT JOIN trainers tr ON tr.id = s.trainer_id
                   WHERE s.program_id = $1 ORDER BY s.session_date, s.start_time NULLS FIRST`, [p.id]),
      pool.query(`SELECT id, title, status, scheduled_date::text AS scheduled_date FROM training_programs
                   WHERE COALESCE(series_id, id) = COALESCE($2::int, $1::int) AND deleted_at IS NULL ORDER BY scheduled_date`, [p.id, p.series_id]),
      pool.query(`SELECT id, title, pass_score, is_active FROM assessments WHERE program_id = $1 AND is_active ORDER BY id`, [p.id]),
    ]);
    const selfReview = await programSelfReviews(pool, prog.rows[0]);
    res.json({ ...prog.rows[0], enrollments: enrollments.rows, costs: costs.rows, sessions: sessions.rows, rounds: rounds.rows, assessments: assessments.rows, self_review: selfReview });
  } catch (err) { sendError(res, err, 'Could not load the training'); }
});

/* ── PUT /programs/:id ──────────────────────────────────────────── */
router.put('/programs/:id', edit, captureBefore('training_programs'), async (req, res) => {
  const companyId = cid(req);
  try {
    const cur = await programInCompany(pool, req.params.id, companyId);
    const b = await programBody(pool, { scheduled_date: cur.scheduled_date, ...req.body }, companyId, true);
    delete b.status;
    const keys = Object.keys(b);
    if (!keys.length) return res.json(cur);
    if (b.max_participants != null) {
      const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM training_enrollments WHERE program_id = $1 AND status <> 'withdrawn'`, [cur.id]);
      if (c.n > b.max_participants) throw httpError(409, `${c.n} people are already enrolled — the limit cannot be lower than that.`);
    }
    const P = params();
    const sets = keys.map(k => (k === 'self_review_items' ? `${k} = ${P.add(b[k])}::jsonb` : `${k} = ${P.add(b[k])}`));
    const { rows } = await pool.query(
      `UPDATE training_programs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ${P.add(cur.id)} RETURNING *`, P.list);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not save the training'); }
});

/* ── POST /programs/:id/status ──────────────────────────────────── */
router.post('/programs/:id/status', edit, captureBefore('training_programs'), async (req, res) => {
  const companyId = cid(req);
  const status = String(req.body?.status || '');
  const reason = strOrNull(req.body?.cancel_reason);
  if (!PROGRAM_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (status === 'cancelled' && !reason) return res.status(400).json({ error: 'Give a reason for cancelling' });
  try {
    const cur = await programInCompany(pool, req.params.id, companyId);
    if (cur.status === 'cancelled' && status !== 'planned') return res.status(409).json({ error: 'A cancelled training can only be re-opened as Planned.' });
    const { rows } = await pool.query(
      `UPDATE training_programs SET status = $2::text, cancel_reason = CASE WHEN $2::text = 'cancelled' THEN $3::text ELSE NULL END, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [cur.id, status, reason]);
    if (status === 'cancelled') {
      const { rows: en } = await pool.query(`SELECT employee_id FROM training_enrollments WHERE program_id = $1 AND status IN ('enrolled','in_progress')`, [cur.id]);
      const logins = await loginsFor(en.map(r => r.employee_id));
      await notify({ userIds: logins.map(l => l.user_id), type: 'lnd_cancelled', referenceId: cur.id,
        title: `Training cancelled: ${cur.title}`, message: `${cur.title} on ${cur.scheduled_date ? String(cur.scheduled_date).slice(0, 10) : ''} was cancelled. Reason: ${reason}` });
    }
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not change the status'); }
});

/* ── POST /programs/:id/next-round — repeat a training (3/6/12-monthly) ── */
router.post('/programs/:id/next-round', add, async (req, res) => {
  const companyId = cid(req);
  const start = dateOrNull(req.body?.scheduled_date);
  const end = dateOrNull(req.body?.end_date);
  if (!start) return res.status(400).json({ error: 'Start date of the next round is required' });
  if (end && end < start) return res.status(400).json({ error: 'End date cannot be before the start date' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await programInCompany(client, req.params.id, companyId);
    const root = cur.series_id || cur.id;
    const { rows: [n] } = await client.query(`
      INSERT INTO training_programs (title, description, category, trainer, trainer_id, mode, duration_hours,
        cost_per_participant, max_participants, scheduled_date, end_date, is_mandatory, refresher_months,
        target_department, target_role, online_link, venue, budget, competency_id, series_id, status, company_id, created_by,
        self_review_enabled, self_review_items)
      SELECT title, description, category, trainer, trainer_id, mode, duration_hours, cost_per_participant,
             max_participants, $2, $3, is_mandatory, refresher_months, target_department, target_role,
             online_link, venue, budget, competency_id, $4, 'planned', company_id, $5, self_review_enabled, self_review_items
        FROM training_programs WHERE id = $1 RETURNING *`, [cur.id, start, end, root, uid(req)]);
    let enrolled = 0;
    if (req.body?.enroll_previous) {
      const { rowCount } = await client.query(`
        INSERT INTO training_enrollments (program_id, employee_id, company_id, enrolled_by, enrolled_via)
        SELECT $1, te.employee_id, $2, $3, 'hr' FROM training_enrollments te
          JOIN employees e ON e.id = te.employee_id
         WHERE te.program_id = $4 AND te.status <> 'withdrawn' AND ${ACTIVE_EMP}
         LIMIT $5
        ON CONFLICT (program_id, employee_id) DO NOTHING`, [n.id, n.company_id, uid(req), cur.id, n.max_participants || 10000]);
      enrolled = rowCount;
    }
    await client.query('COMMIT');
    res.status(201).json({ ...n, enrolled_previous: enrolled });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not schedule the next round'); }
  finally { client.release(); }
});

/* ── DELETE /programs/:id — archive ─────────────────────────────── */
router.delete('/programs/:id', del, captureBefore('training_programs'), async (req, res) => {
  try {
    const cur = await programInCompany(pool, req.params.id, cid(req));
    const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM training_enrollments WHERE program_id = $1 AND status = 'completed'`, [cur.id]);
    if (c.n) return res.status(409).json({ error: `${c.n} completion record(s) belong to this training — cancel it instead of deleting, so the records stay.` });
    await pool.query(`UPDATE training_programs SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [cur.id]);
    res.json({ message: 'Training deleted' });
  } catch (err) { sendError(res, err, 'Could not delete the training'); }
});

/* ── Enrolment ──────────────────────────────────────────────────── */
/**
 * Enrol employees (HR). Each id is checked against the company and the active
 * staff; capacity counts everyone not withdrawn. A withdrawn enrolment is
 * re-activated rather than duplicated. Returns who was enrolled and why the
 * rest were skipped.
 */
export async function enrollEmployees(client, program, employeeIds, { userId, via = 'hr' }) {
  if (['cancelled', 'completed'].includes(program.status)) throw httpError(409, `This training is ${program.status} — enrolment is closed.`);
  const ids = [...new Set((employeeIds || []).map(intOrNull).filter(Boolean))];
  if (!ids.length) throw httpError(400, 'Choose at least one employee');
  const { rows: valid } = await client.query(
    `SELECT e.id FROM employees e WHERE e.id = ANY($1::int[]) AND ${ACTIVE_EMP} AND ($2::int IS NULL OR e.company_id = $2)`,
    [ids, program.company_id]);
  const validSet = new Set(valid.map(r => r.id));
  const { rows: [cnt] } = await client.query(`SELECT COUNT(*)::int AS n FROM training_enrollments WHERE program_id = $1 AND status <> 'withdrawn'`, [program.id]);
  let room = (program.max_participants || 10000) - cnt.n;
  const enrolled = []; const skipped = [];
  for (const id of ids) {
    if (!validSet.has(id)) { skipped.push({ employee_id: id, reason: 'Not an active employee of this company' }); continue; }
    const { rows: [ex] } = await client.query(`SELECT id, status FROM training_enrollments WHERE program_id = $1 AND employee_id = $2`, [program.id, id]);
    if (ex && ex.status !== 'withdrawn') { skipped.push({ employee_id: id, reason: 'Already enrolled' }); continue; }
    if (room <= 0) { skipped.push({ employee_id: id, reason: 'Training is full' }); continue; }
    if (ex) {
      await client.query(`UPDATE training_enrollments SET status = 'enrolled', enrolled_by = $2, enrolled_via = $3, updated_at = NOW() WHERE id = $1`, [ex.id, userId, via]);
    } else {
      await client.query(`INSERT INTO training_enrollments (program_id, employee_id, company_id, status, enrolled_by, enrolled_via)
                          VALUES ($1,$2,$3,'enrolled',$4,$5)`, [program.id, id, program.company_id, userId, via]);
    }
    enrolled.push(id); room--;
  }
  return { enrolled, skipped };
}

/** After completion: ask each person for their after-training self-review. */
export async function notifyPostReview(enrollmentIds) {
  if (!enrollmentIds.length) return;
  const { rows } = await pool.query(
    `SELECT te.id, te.employee_id, p.id AS program_id, p.title, p.company_id FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id
      WHERE te.id = ANY($1::int[]) AND te.status = 'completed' AND p.self_review_enabled
        AND NOT EXISTS (SELECT 1 FROM training_self_reviews r WHERE r.enrollment_id = te.id AND r.phase = 'post')`, [enrollmentIds]);
  for (const r of rows) {
    const logins = await loginsFor([r.employee_id]);
    await notify({ userIds: logins.map(l => l.user_id), type: 'lnd_post_review', referenceId: r.id, companyId: r.company_id,
      title: `Rate yourself after: ${r.title}`, message: `Training completed. Take one minute to rate your knowledge and confidence now (Self Service → My Learning) — it is compared with your rating from before the training.` });
  }
}

export async function notifyEnrolled(program, employeeIds) {
  if (!employeeIds.length) return;
  const logins = await loginsFor(employeeIds);
  const date = program.scheduled_date ? String(program.scheduled_date).slice(0, 10) : '';
  await notify({
    userIds: logins.map(l => l.user_id), type: 'lnd_enrolled', referenceId: program.id, companyId: program.company_id,
    title: `Enrolled: ${program.title}`, message: `You are enrolled in ${program.title} on ${date}${venueLine(program)}.${program.self_review_enabled === false ? '' : ' Rate yourself before it starts in Self Service → My Learning.'}`,
    email: { trigger: 'lnd_enrolled', to: logins, data: { program_title: program.title, scheduled_date: date, venue_line: venueLine(program) } },
  });
}

router.post('/programs/:id/enroll', add, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await programInCompany(client, req.params.id, cid(req), { lock: true });
    const out = await enrollEmployees(client, p, req.body?.employee_ids, { userId: uid(req) });
    await client.query('COMMIT');
    notifyEnrolled(p, out.enrolled).catch(() => {});
    res.json({ ...out, message: `${out.enrolled.length} enrolled${out.skipped.length ? `, ${out.skipped.length} skipped` : ''}` });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not enrol'); }
  finally { client.release(); }
});

async function enrollmentInCompany(db, id, companyId) {
  const { rows } = await db.query(
    `SELECT te.* FROM training_enrollments te JOIN training_programs tp ON tp.id = te.program_id
      WHERE te.id = $1 AND tp.deleted_at IS NULL AND ($2::int IS NULL OR te.company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Enrolment not found');
  return rows[0];
}

/** Apply one status / result update. Completion goes through completeEnrollment(). */
async function updateEnrollment(client, id, body, req) {
  const companyId = cid(req);
  const en = await enrollmentInCompany(client, id, companyId);
  const status = body.status ? String(body.status) : null;
  if (status && !ENROLLMENT_STATUSES.includes(status)) throw httpError(400, 'Unknown enrolment status');
  const score = body.score === '' || body.score == null ? null : Number(body.score);
  if (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) throw httpError(400, 'Score must be 0–100');
  const rating = intOrNull(body.feedback_rating);
  if (rating != null && (rating < 1 || rating > 5)) throw httpError(400, 'Rating must be 1–5');
  if (status === 'completed') {
    await completeEnrollment(client, en.id, { score, userId: uid(req), companyId, certificateUrl: strOrNull(body.certificate_url) });
  } else if (status) {
    await client.query(
      `UPDATE training_enrollments SET status = $2::text, completion_date = CASE WHEN $2::text = 'completed' THEN completion_date ELSE NULL END,
              score = COALESCE($3, score), updated_at = NOW() WHERE id = $1`, [en.id, status, score]);
  } else if (score != null) {
    await client.query(`UPDATE training_enrollments SET score = $2, updated_at = NOW() WHERE id = $1`, [en.id, score]);
  }
  if (rating != null || body.feedback_comments !== undefined) {
    await client.query(`UPDATE training_enrollments SET feedback_rating = COALESCE($2, feedback_rating),
                          feedback_comments = COALESCE($3, feedback_comments), updated_at = NOW() WHERE id = $1`,
      [en.id, rating, strOrNull(body.feedback_comments)]);
  }
  const { rows } = await client.query(`SELECT * FROM training_enrollments WHERE id = $1`, [en.id]);
  return rows[0];
}

router.put('/enrollments/:id', edit, captureBefore('training_enrollments'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await updateEnrollment(client, req.params.id, req.body || {}, req);
    await client.query('COMMIT');
    if (row.status === 'completed') notifyPostReview([row.id]).catch(() => {});
    res.json(row);
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not update the enrolment'); }
  finally { client.release(); }
});

/** Kept for older callers: PUT /enrollments/:id/complete. */
router.put('/enrollments/:id/complete', edit, captureBefore('training_enrollments'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await updateEnrollment(client, req.params.id, { ...req.body, status: 'completed' }, req);
    await client.query('COMMIT');
    res.json(row);
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not complete'); }
  finally { client.release(); }
});

/** Bulk: mark several enrolments at once (attended / no-show / completed). All or nothing. */
router.post('/enrollments/bulk', edit, async (req, res) => {
  const ids = (req.body?.ids || []).map(intOrNull).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one enrolment' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) await updateEnrollment(client, id, { status: req.body.status, score: req.body.score }, req);
    await client.query('COMMIT');
    if (req.body.status === 'completed') notifyPostReview(ids).catch(() => {});
    res.json({ updated: ids.length });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Nothing was changed'); }
  finally { client.release(); }
});

router.post('/enrollments/:id/certificate', edit, singleFileUpload('file'), async (req, res) => {
  try {
    const en = await enrollmentInCompany(pool, req.params.id, cid(req));
    if (!req.file) return res.status(400).json({ error: 'Attach the certificate file' });
    const url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    const { rows } = await pool.query(`UPDATE training_enrollments SET certificate_url = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [en.id, url]);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Upload failed'); }
});

router.delete('/enrollments/:id', edit, captureBefore('training_enrollments'), async (req, res) => {
  try {
    const en = await enrollmentInCompany(pool, req.params.id, cid(req));
    if (en.status === 'completed') return res.status(409).json({ error: 'A completed enrolment is a training record and cannot be withdrawn.' });
    await pool.query(`UPDATE training_enrollments SET status = 'withdrawn', updated_at = NOW() WHERE id = $1`, [en.id]);
    res.json({ message: 'Withdrawn' });
  } catch (err) { sendError(res, err, 'Could not withdraw'); }
});

/* ── Sessions + attendance ──────────────────────────────────────── */
async function sessionBody(db, b, companyId) {
  const session_date = dateOrNull(b.session_date);
  if (!session_date) throw httpError(400, 'Session date is required');
  const tm = (v) => (/^\d{2}:\d{2}/.test(String(v || '')) ? String(v).slice(0, 5) : null);
  const start_time = tm(b.start_time); const end_time = tm(b.end_time);
  if (start_time && end_time && end_time <= start_time) throw httpError(400, 'End time must be after start time');
  const trainer_id = intOrNull(b.trainer_id);
  if (trainer_id) {
    const { rows } = await db.query(`SELECT 1 FROM trainers WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [trainer_id, companyId]);
    if (!rows.length) throw httpError(400, 'Unknown trainer');
  }
  const status = b.status ? String(b.status) : 'scheduled';
  if (!['scheduled', 'completed', 'cancelled'].includes(status)) throw httpError(400, 'Unknown session status');
  return { session_date, start_time, end_time, trainer_id, status, venue: strOrNull(b.venue), online_link: strOrNull(b.online_link), notes: strOrNull(b.notes) };
}

router.post('/programs/:id/sessions', edit, async (req, res) => {
  try {
    const p = await programInCompany(pool, req.params.id, cid(req));
    const s = await sessionBody(pool, req.body || {}, p.company_id);
    const { rows } = await pool.query(
      `INSERT INTO training_sessions (program_id, session_date, start_time, end_time, venue, online_link, trainer_id, status, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [p.id, s.session_date, s.start_time, s.end_time, s.venue, s.online_link, s.trainer_id, s.status, s.notes, p.company_id]);
    res.status(201).json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not add the session'); }
});

async function sessionInCompany(db, id, companyId) {
  const { rows } = await db.query(
    `SELECT s.* FROM training_sessions s JOIN training_programs p ON p.id = s.program_id
      WHERE s.id = $1 AND p.deleted_at IS NULL AND ($2::int IS NULL OR p.company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Session not found');
  return rows[0];
}

router.put('/sessions/:id', edit, captureBefore('training_sessions'), async (req, res) => {
  try {
    const cur = await sessionInCompany(pool, req.params.id, cid(req));
    const s = await sessionBody(pool, { ...cur, session_date: String(cur.session_date).slice(0, 10), ...req.body }, cid(req));
    const { rows } = await pool.query(
      `UPDATE training_sessions SET session_date=$2, start_time=$3, end_time=$4, venue=$5, online_link=$6, trainer_id=$7, status=$8, notes=$9
        WHERE id = $1 RETURNING *`,
      [cur.id, s.session_date, s.start_time, s.end_time, s.venue, s.online_link, s.trainer_id, s.status, s.notes]);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not save the session'); }
});

router.delete('/sessions/:id', edit, captureBefore('training_sessions'), async (req, res) => {
  try {
    const cur = await sessionInCompany(pool, req.params.id, cid(req));
    await pool.query(`DELETE FROM training_sessions WHERE id = $1`, [cur.id]);
    res.json({ message: 'Session removed' });
  } catch (err) { sendError(res, err, 'Could not remove the session'); }
});

router.get('/sessions/:id/attendance', view, async (req, res) => {
  try {
    const s = await sessionInCompany(pool, req.params.id, cid(req));
    const { rows } = await pool.query(
      `SELECT te.employee_id, ${EMP_NAME} AS employee_name, e.office_id, e.department,
              ta.present, ta.check_in_time::text AS check_in_time, ta.notes
         FROM training_enrollments te JOIN employees e ON e.id = te.employee_id
         LEFT JOIN training_attendance ta ON ta.session_id = $1 AND ta.employee_id = te.employee_id
        WHERE te.program_id = $2 AND te.status <> 'withdrawn' ORDER BY 2`, [s.id, s.program_id]);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load attendance'); }
});

router.put('/sessions/:id/attendance', edit, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await sessionInCompany(client, req.params.id, cid(req));
    const { rows: en } = await client.query(`SELECT employee_id FROM training_enrollments WHERE program_id = $1 AND status <> 'withdrawn'`, [s.program_id]);
    const allowed = new Set(en.map(r => r.employee_id));
    for (const r of records) {
      const eid = intOrNull(r.employee_id);
      if (!allowed.has(eid)) throw httpError(400, 'Attendance can be marked only for enrolled employees');
      await client.query(
        `INSERT INTO training_attendance (session_id, employee_id, present, notes, company_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (session_id, employee_id) DO UPDATE SET present = EXCLUDED.present, notes = EXCLUDED.notes`,
        [s.id, eid, r.present === true, strOrNull(r.notes), s.company_id]);
    }
    // Someone who attended any session has started the training.
    await client.query(
      `UPDATE training_enrollments te SET status = 'in_progress', updated_at = NOW()
        WHERE te.program_id = $1 AND te.status = 'enrolled'
          AND EXISTS (SELECT 1 FROM training_attendance a WHERE a.session_id = $2 AND a.employee_id = te.employee_id AND a.present)`,
      [s.program_id, s.id]);
    await client.query(`UPDATE training_sessions SET status = 'completed' WHERE id = $1 AND status = 'scheduled'`, [s.id]);
    await client.query('COMMIT');
    res.json({ saved: records.length });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Attendance was not saved'); }
  finally { client.release(); }
});

/* ── Costs ──────────────────────────────────────────────────────── */
function costBody(b) {
  const cost_type = String(b.cost_type || '');
  if (!COST_TYPES.includes(cost_type)) throw httpError(400, 'Choose a cost type');
  const amount = numOrNull(b.amount);
  if (amount == null || amount < 0) throw httpError(400, 'Amount must be zero or more');
  return { cost_type, amount, description: strOrNull(b.description), cost_date: dateOrNull(b.cost_date) };
}

router.post('/programs/:id/costs', edit, async (req, res) => {
  try {
    const p = await programInCompany(pool, req.params.id, cid(req));
    const c = costBody(req.body || {});
    const { rows } = await pool.query(
      `INSERT INTO training_costs (program_id, cost_type, amount, description, cost_date, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6) RETURNING *`,
      [p.id, c.cost_type, c.amount, c.description, c.cost_date, uid(req)]);
    res.status(201).json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not add the cost'); }
});

async function costInCompany(db, id, companyId) {
  const { rows } = await db.query(
    `SELECT c.* FROM training_costs c JOIN training_programs p ON p.id = c.program_id
      WHERE c.id = $1 AND ($2::int IS NULL OR p.company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Cost not found');
  return rows[0];
}

router.put('/costs/:id', edit, captureBefore('training_costs'), async (req, res) => {
  try {
    const cur = await costInCompany(pool, req.params.id, cid(req));
    const c = costBody({ ...cur, ...req.body });
    const { rows } = await pool.query(
      `UPDATE training_costs SET cost_type=$2, amount=$3, description=$4, cost_date=COALESCE($5::date, cost_date) WHERE id = $1 RETURNING *`,
      [cur.id, c.cost_type, c.amount, c.description, c.cost_date]);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not save the cost'); }
});

router.delete('/costs/:id', edit, captureBefore('training_costs'), async (req, res) => {
  try {
    const cur = await costInCompany(pool, req.params.id, cid(req));
    await pool.query(`DELETE FROM training_costs WHERE id = $1`, [cur.id]);
    res.json({ message: 'Cost removed' });
  } catch (err) { sendError(res, err, 'Could not remove the cost'); }
});

/* ── GET /dashboard — everything the L&D dashboard shows, one call ── */
router.get('/dashboard', view, async (req, res) => {
  const companyId = cid(req);
  const range = lndRange(req.query, 'fytd');
  const department = dim(req.query, 'department');
  const category = dim(req.query, 'category');
  try {
    // Programmes in the window; enrolments / costs inherit it through their programme.
    const P = params([companyId, range.from, range.to, department, category]);
    const progWhere = `p.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1)
      AND ($2::date IS NULL OR COALESCE(p.end_date, p.scheduled_date) >= $2::date)
      AND ($3::date IS NULL OR p.scheduled_date <= $3::date)
      AND ($5::text IS NULL OR p.category = $5)`;
    const empDept = `($4::text IS NULL OR e.department = $4)`;
    const progDept = `($4::text IS NULL OR p.target_department = $4 OR p.target_department IS NULL OR p.target_department = '')`;

    const [kpi, monthly, byType, byCategory, topPrograms, deptHours, trainers, overdue, upcoming, certs, gaps, compliance] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM training_programs p WHERE ${progWhere} AND ${progDept} AND p.status <> 'cancelled')::int AS programs,
          (SELECT COUNT(*) FROM training_programs p WHERE ${progWhere} AND ${progDept} AND p.status IN ('planned','ongoing'))::int AS active_programs,
          (SELECT COUNT(*) FROM training_programs p WHERE ${progWhere} AND ${progDept} AND p.status = 'cancelled')::int AS cancelled,
          (SELECT COUNT(*) FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
            WHERE ${progWhere} AND ${empDept} AND te.status <> 'withdrawn')::int AS enrollments,
          (SELECT COUNT(*) FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
            WHERE ${progWhere} AND ${empDept} AND te.status = 'completed')::int AS completions,
          (SELECT COUNT(*) FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
            WHERE ${progWhere} AND ${empDept} AND te.status = 'no_show')::int AS no_shows,
          (SELECT COUNT(DISTINCT te.employee_id) FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
            WHERE ${progWhere} AND ${empDept} AND te.status = 'completed')::int AS employees_trained,
          (SELECT COALESCE(SUM(p.duration_hours),0) FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
            WHERE ${progWhere} AND ${empDept} AND te.status = 'completed')::float AS training_hours,
          (SELECT ROUND(AVG(te.feedback_rating),1) FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
            WHERE ${progWhere} AND ${empDept} AND te.feedback_rating IS NOT NULL)::float AS avg_feedback,
          (SELECT COALESCE(SUM(c.amount),0) FROM training_costs c JOIN training_programs p ON p.id = c.program_id WHERE ${progWhere} AND ${progDept})::float AS total_cost,
          (SELECT COALESCE(SUM(p.budget),0) FROM training_programs p WHERE ${progWhere} AND ${progDept} AND p.status <> 'cancelled')::float AS budget,
          (SELECT COUNT(*) FROM training_programs p WHERE p.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1)
             AND p.status = 'planned' AND p.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS upcoming_30d,
          (SELECT COUNT(*) FROM employees e WHERE ${ACTIVE_EMP} AND ($1::int IS NULL OR e.company_id = $1) AND ${empDept})::int AS headcount,
          (SELECT ROUND(AVG(po.knowledge - pr.knowledge),1) FROM training_self_reviews pr
             JOIN training_self_reviews po ON po.enrollment_id = pr.enrollment_id AND po.phase = 'post'
             JOIN training_programs p ON p.id = pr.program_id JOIN employees e ON e.id = pr.employee_id
            WHERE pr.phase = 'pre' AND ${progWhere} AND ${empDept})::float AS knowledge_gain,
          (SELECT ROUND(AVG(po.confidence - pr.confidence),1) FROM training_self_reviews pr
             JOIN training_self_reviews po ON po.enrollment_id = pr.enrollment_id AND po.phase = 'post'
             JOIN training_programs p ON p.id = pr.program_id JOIN employees e ON e.id = pr.employee_id
            WHERE pr.phase = 'pre' AND ${progWhere} AND ${empDept})::float AS confidence_gain,
          (SELECT COUNT(*) FROM training_self_reviews pr JOIN training_self_reviews po ON po.enrollment_id = pr.enrollment_id AND po.phase = 'post'
             JOIN training_programs p ON p.id = pr.program_id JOIN employees e ON e.id = pr.employee_id
            WHERE pr.phase = 'pre' AND ${progWhere} AND ${empDept})::int AS self_review_pairs
      `, P.list),
      pool.query(`
        SELECT TO_CHAR(x.m, 'Mon YY') AS month, x.m, COUNT(*)::int AS programs,
               COALESCE(SUM(x.completions),0)::int AS completions, COALESCE(SUM(x.cost),0)::float AS cost
          FROM (SELECT DATE_TRUNC('month', p.scheduled_date) AS m,
                       (SELECT COUNT(*) FROM training_enrollments te WHERE te.program_id = p.id AND te.status = 'completed') AS completions,
                       (SELECT SUM(c.amount) FROM training_costs c WHERE c.program_id = p.id) AS cost
                  FROM training_programs p
                 WHERE ${progWhere} AND ${progDept} AND p.scheduled_date IS NOT NULL AND p.status <> 'cancelled') x
         GROUP BY x.m ORDER BY x.m`, P.list),
      pool.query(`SELECT c.cost_type AS name, SUM(c.amount)::float AS value FROM training_costs c JOIN training_programs p ON p.id = c.program_id
                   WHERE ${progWhere} AND ${progDept} GROUP BY 1 ORDER BY 2 DESC`, P.list),
      pool.query(`SELECT COALESCE(p.category,'Uncategorised') AS name, COUNT(*)::int AS programs,
                         COALESCE(SUM(en.completed),0)::int AS completions
                    FROM training_programs p
                    LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE status='completed') AS completed FROM training_enrollments WHERE program_id = p.id) en ON true
                   WHERE ${progWhere} AND ${progDept} AND p.status <> 'cancelled' GROUP BY 1 ORDER BY 2 DESC`, P.list),
      pool.query(`SELECT p.id, p.title, COUNT(te.id) FILTER (WHERE te.status <> 'withdrawn')::int AS enrolled,
                         COUNT(te.id) FILTER (WHERE te.status = 'completed')::int AS completed,
                         ROUND(100.0 * COUNT(te.id) FILTER (WHERE te.status = 'completed') / NULLIF(COUNT(te.id) FILTER (WHERE te.status <> 'withdrawn'),0))::int AS completion_pct
                    FROM training_programs p LEFT JOIN training_enrollments te ON te.program_id = p.id
                   WHERE ${progWhere} AND ${progDept} AND p.status <> 'cancelled'
                   GROUP BY p.id HAVING COUNT(te.id) FILTER (WHERE te.status <> 'withdrawn') > 0
                   ORDER BY completion_pct ASC NULLS LAST, enrolled DESC LIMIT 10`, P.list),
      pool.query(`SELECT COALESCE(e.department,'—') AS department, COALESCE(SUM(p.duration_hours),0)::float AS hours,
                         COUNT(DISTINCT te.employee_id)::int AS people
                    FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
                   WHERE ${progWhere} AND ${empDept} AND te.status = 'completed' GROUP BY 1 ORDER BY 2 DESC`, P.list),
      pool.query(`SELECT t.id, t.name AS trainer, COUNT(DISTINCT p.id)::int AS programs,
                         ROUND(AVG(te.feedback_rating),1)::float AS avg_rating,
                         COUNT(te.id) FILTER (WHERE te.status='completed')::int AS completions
                    FROM trainers t JOIN training_programs p ON p.trainer_id = t.id
                    LEFT JOIN training_enrollments te ON te.program_id = p.id
                   WHERE ${progWhere} AND ${progDept} GROUP BY t.id ORDER BY avg_rating DESC NULLS LAST LIMIT 8`, P.list),
      pool.query(`SELECT te.id, ${EMP_NAME} AS employee_name, e.department, p.id AS program_id, p.title AS program,
                         p.scheduled_date::text AS scheduled_date, p.is_mandatory, te.status,
                         (CURRENT_DATE - COALESCE(p.end_date, p.scheduled_date))::int AS days_overdue
                    FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
                   WHERE p.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1) AND ${empDept} AND ($5::text IS NULL OR p.category = $5)
                     AND te.status IN ('enrolled','in_progress') AND p.status <> 'cancelled'
                     AND COALESCE(p.end_date, p.scheduled_date) < CURRENT_DATE AND ($2::date IS NULL OR TRUE) AND ($3::date IS NULL OR TRUE)
                   ORDER BY p.is_mandatory DESC, days_overdue DESC LIMIT 50`, P.list),
      pool.query(`SELECT p.id, p.title, p.scheduled_date::text AS scheduled_date, p.mode, p.is_mandatory,
                         (SELECT COUNT(*) FROM training_enrollments te WHERE te.program_id = p.id AND te.status <> 'withdrawn')::int AS enrolled,
                         p.max_participants
                    FROM training_programs p
                   WHERE p.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1) AND ${progDept} AND ($5::text IS NULL OR p.category = $5)
                     AND p.status IN ('planned','ongoing') AND p.scheduled_date >= CURRENT_DATE AND ($2::date IS NULL OR TRUE) AND ($3::date IS NULL OR TRUE)
                   ORDER BY p.scheduled_date LIMIT 8`, P.list),
      pool.query(`SELECT COUNT(*) FILTER (WHERE ec.status='active' AND ec.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30)::int AS expiring_30d,
                         COUNT(*) FILTER (WHERE ec.status='active' AND ec.expiry_date BETWEEN CURRENT_DATE+31 AND CURRENT_DATE+90)::int AS expiring_90d,
                         COUNT(*) FILTER (WHERE ec.status='expired' OR (ec.status='active' AND ec.expiry_date < CURRENT_DATE))::int AS expired,
                         COUNT(*) FILTER (WHERE ec.status='active' AND (ec.expiry_date IS NULL OR ec.expiry_date >= CURRENT_DATE))::int AS active
                    FROM employee_certifications ec JOIN employees e ON e.id = ec.employee_id
                   WHERE ($1::int IS NULL OR ec.company_id = $1) AND ${empDept} AND ($2::date IS NULL OR TRUE) AND ($3::date IS NULL OR TRUE) AND ($5::text IS NULL OR TRUE)`, P.list),
      pool.query(`SELECT COUNT(*)::int AS gaps FROM (
                    SELECT eca.id FROM employee_competency_assessments eca
                      JOIN employees e ON e.id = eca.employee_id JOIN competency_framework cf ON cf.id = eca.competency_id
                      LEFT JOIN role_competencies rc ON rc.competency_id = cf.id AND LOWER(rc.role_title) = LOWER(e.designation)
                           AND rc.company_id IS NOT DISTINCT FROM cf.company_id
                     WHERE ($1::int IS NULL OR eca.company_id = $1) AND ${empDept} AND ${ACTIVE_EMP} AND cf.is_active
                       AND eca.assessed_level < COALESCE(rc.required_level, cf.expected_level) AND ($2::date IS NULL OR TRUE) AND ($3::date IS NULL OR TRUE) AND ($5::text IS NULL OR TRUE)) g`, P.list),
      computeCompliance(pool, companyId, { department, category }),
    ]);
    const refresherDue = compliance.rows.filter(r => r.status === 'overdue' || r.status === 'due_soon' || r.status === 'not_done')
      .sort((a, b) => ({ overdue: 0, not_done: 1, due_soon: 2 }[a.status] - { overdue: 0, not_done: 1, due_soon: 2 }[b.status]))
      .slice(0, 50);
    const k = kpi.rows[0];
    res.json({
      period: range.period, period_label: range.label, from: range.from, to: range.to, department, category,
      kpis: {
        ...k,
        completion_rate_pct: k.enrollments ? Math.round(100 * k.completions / k.enrollments) : 0,
        hours_per_employee: k.headcount ? Math.round(10 * k.training_hours / k.headcount) / 10 : 0,
        cost_per_employee_trained: k.employees_trained ? Math.round(k.total_cost / k.employees_trained) : 0,
        mandatory_compliance_pct: compliance.summary.compliance_pct,
        refresher_overdue: compliance.summary.overdue, refresher_due_soon: compliance.summary.due_soon,
        mandatory_not_done: compliance.summary.not_done,
        certs_expiring_30d: certs.rows[0].expiring_30d, certs_expiring_90d: certs.rows[0].expiring_90d,
        certs_expired: certs.rows[0].expired, certs_active: certs.rows[0].active,
        skill_gaps: gaps.rows[0].gaps,
      },
      monthly: monthly.rows.map(({ m, ...r }) => r),
      cost_by_type: byType.rows, by_category: byCategory.rows, lowest_completion: topPrograms.rows,
      hours_by_department: deptHours.rows, trainers: trainers.rows, overdue: overdue.rows, upcoming: upcoming.rows,
      compliance_series: compliance.series, refresher_due: refresherDue,
    });
  } catch (err) { sendError(res, err, 'Could not load the dashboard'); }
});

/* ── GET /compliance — mandatory training / refresher status ───── */
router.get('/compliance', view, async (req, res) => {
  try {
    const out = await computeCompliance(pool, cid(req), {
      department: dim(req.query, 'department'), seriesId: intOrNull(req.query.series_id),
      category: dim(req.query, 'category'), dueSoonDays: intOrNull(req.query.due_soon_days) ?? 30,
    });
    const status = dim(req.query, 'status');
    if (status) out.rows = out.rows.filter(r => status.split(',').includes(r.status));
    res.json(out);
  } catch (err) { sendError(res, err, 'Could not load compliance'); }
});

/* ── GET /employee/:id/summary — the employee record's Learning tab ── */
router.get('/employee/:id/summary', view, async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows: [emp] } = await pool.query(`SELECT e.id FROM employees e WHERE e.id = $1 AND ($2::int IS NULL OR e.company_id = $2)`, [req.params.id, companyId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const [trainings, certs, paths, ratings, compliance] = await Promise.all([
      pool.query(`SELECT te.id, te.status, te.score::float AS score, te.feedback_rating, te.completion_date::text AS completion_date,
                         p.id AS program_id, p.title, p.category, p.scheduled_date::text AS scheduled_date, p.duration_hours::float AS duration_hours, p.is_mandatory
                    FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id
                   WHERE te.employee_id = $1 AND p.deleted_at IS NULL ORDER BY p.scheduled_date DESC`, [emp.id]),
      pool.query(`SELECT ec.id, c.name, ec.status, ec.issue_date::text AS issue_date, ec.expiry_date::text AS expiry_date, ec.certificate_url
                    FROM employee_certifications ec JOIN certifications c ON c.id = ec.certification_id
                   WHERE ec.employee_id = $1 AND ec.status <> 'renewed' ORDER BY ec.expiry_date NULLS LAST`, [emp.id]),
      pool.query(`SELECT elp.id, lp.name, elp.status, elp.due_date::text AS due_date FROM employee_learning_paths elp
                    JOIN learning_paths lp ON lp.id = elp.path_id WHERE elp.employee_id = $1 AND elp.status <> 'withdrawn'`, [emp.id]),
      pool.query(`SELECT cf.name, cf.category, eca.assessed_level, eca.source, eca.assessed_date::text AS assessed_date
                    FROM employee_competency_assessments eca JOIN competency_framework cf ON cf.id = eca.competency_id
                   WHERE eca.employee_id = $1 ORDER BY cf.name`, [emp.id]),
      computeCompliance(pool, companyId, { employeeId: emp.id }),
    ]);
    const done = trainings.rows.filter(t => t.status === 'completed');
    res.json({
      trainings: trainings.rows, certifications: certs.rows, paths: paths.rows, skills: ratings.rows,
      mandatory: compliance.rows,
      totals: { completed: done.length, hours: done.reduce((s, t) => s + (t.duration_hours || 0), 0) },
    });
  } catch (err) { sendError(res, err, 'Could not load learning summary'); }
});

export default router;
