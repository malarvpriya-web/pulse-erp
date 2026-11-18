// backend/src/modules/hr/trainers.routes.js
//
// Trainers — the list a training's trainer is chosen from (2026-11-18). The
// programme form used to take free text, so no trainer ever showed a
// programme or a rating. Internal trainers link to an employee (picked, not
// typed); programme counts and ratings are computed, never stored.
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { cid, sendError, httpError, intOrNull, strOrNull, dim, params, lndRange, EMP_NAME, ACTIVE_EMP } from './lnd/lndShared.js';

const router = express.Router();
router.use(requireCompanyScope);
const view = requirePermission('training', 'view');
const add = requirePermission('training', 'add');
const edit = requirePermission('training', 'edit');
const del = requirePermission('training', 'delete');

router.get('/', view, async (req, res) => {
  try {
    const P = params([cid(req)]);
    const w = ['($1::int IS NULL OR t.company_id = $1)'];
    const st = dim(req.query, 'status') || 'active';
    if (st === 'active') w.push('t.is_active'); else if (st === 'inactive') w.push('NOT t.is_active');
    const ty = dim(req.query, 'trainer_type'); if (ty) w.push(`t.trainer_type = ${P.add(ty)}`);
    const q = dim(req.query, 'q'); if (q) { const ph = P.add(`%${q}%`); w.push(`(t.name ILIKE ${ph} OR t.specialization ILIKE ${ph} OR t.email ILIKE ${ph})`); }
    const { rows } = await pool.query(`
      SELECT t.*, ${EMP_NAME} AS employee_full_name, e.office_id, e.department,
             st.programs::int AS programs_count, st.trained::int AS employees_trained, st.avg_rating::float AS avg_rating,
             st.last_date::text AS last_program_date
        FROM trainers t LEFT JOIN employees e ON e.id = t.employee_id
        LEFT JOIN LATERAL (
          SELECT COUNT(DISTINCT p.id) AS programs, COUNT(DISTINCT te.employee_id) FILTER (WHERE te.status = 'completed') AS trained,
                 ROUND(AVG(te.feedback_rating),1) AS avg_rating, MAX(p.scheduled_date) AS last_date
            FROM training_programs p LEFT JOIN training_enrollments te ON te.program_id = p.id
           WHERE p.trainer_id = t.id AND p.deleted_at IS NULL AND p.status <> 'cancelled') st ON true
       WHERE ${w.join(' AND ')} ORDER BY t.name`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load trainers'); }
});

async function body(db, b, companyId, cur = {}) {
  const trainer_type = String(b.trainer_type ?? cur.trainer_type ?? 'internal');
  if (!['internal', 'external'].includes(trainer_type)) throw httpError(400, 'Type must be internal or external');
  let employee_id = null; let name = strOrNull(b.name ?? cur.name);
  if (trainer_type === 'internal') {
    employee_id = intOrNull(b.employee_id ?? cur.employee_id);
    if (!employee_id) throw httpError(400, 'Choose the employee for an internal trainer');
    const { rows } = await db.query(`SELECT ${EMP_NAME} AS name FROM employees e WHERE e.id = $1 AND ${ACTIVE_EMP} AND ($2::int IS NULL OR e.company_id = $2)`, [employee_id, companyId]);
    if (!rows.length) throw httpError(400, 'Choose an active employee of this company');
    name = name || rows[0].name;
  }
  if (!name) throw httpError(400, 'Name is required');
  const email = strOrNull(b.email ?? cur.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Email address is not valid');
  const phone = strOrNull(b.phone ?? cur.phone);
  if (phone && !/^[+\d][\d\s-]{6,19}$/.test(phone)) throw httpError(400, 'Phone number is not valid');
  return { name, trainer_type, employee_id, email, phone, specialization: strOrNull(b.specialization ?? cur.specialization),
    is_active: b.is_active === undefined ? (cur.is_active ?? true) : !!b.is_active };
}

router.post('/', add, async (req, res) => {
  try {
    const b = await body(pool, req.body || {}, cid(req));
    const { rows } = await pool.query(
      `INSERT INTO trainers (name, trainer_type, employee_id, email, phone, specialization, company_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, b.trainer_type, b.employee_id, b.email, b.phone, b.specialization, cid(req)]);
    res.status(201).json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not add the trainer'); }
});

async function trainerInCompany(db, id, companyId) {
  const { rows } = await db.query(`SELECT * FROM trainers WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Trainer not found');
  return rows[0];
}

router.put('/:id', edit, captureBefore('trainers'), async (req, res) => {
  try {
    const cur = await trainerInCompany(pool, req.params.id, cid(req));
    const b = await body(pool, req.body || {}, cid(req), cur);
    const { rows } = await pool.query(
      `UPDATE trainers SET name=$2, trainer_type=$3, employee_id=$4, email=$5, phone=$6, specialization=$7, is_active=$8, updated_at=NOW()
        WHERE id = $1 RETURNING *`,
      [cur.id, b.name, b.trainer_type, b.employee_id, b.email, b.phone, b.specialization, b.is_active]);
    // Programmes keep a copy of the trainer's name for printing — keep it current.
    await pool.query(`UPDATE training_programs SET trainer = $2 WHERE trainer_id = $1`, [cur.id, b.name]);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not save the trainer'); }
});

router.delete('/:id', del, captureBefore('trainers'), async (req, res) => {
  try {
    const cur = await trainerInCompany(pool, req.params.id, cid(req));
    await pool.query(`UPDATE trainers SET is_active = false, updated_at = NOW() WHERE id = $1`, [cur.id]);
    res.json({ message: 'Trainer deactivated' });
  } catch (err) { sendError(res, err, 'Could not deactivate'); }
});

router.get('/:id/programs', view, async (req, res) => {
  try {
    const t = await trainerInCompany(pool, req.params.id, cid(req));
    const r = lndRange(req.query, 'all');
    const { rows } = await pool.query(`
      SELECT p.id, p.title, p.category, p.status, p.scheduled_date::text AS scheduled_date,
             COUNT(te.id) FILTER (WHERE te.status <> 'withdrawn')::int AS enrolled_count,
             COUNT(te.id) FILTER (WHERE te.status = 'completed')::int AS completed_count,
             ROUND(AVG(te.feedback_rating),1)::float AS avg_rating
        FROM training_programs p LEFT JOIN training_enrollments te ON te.program_id = p.id
       WHERE p.trainer_id = $1 AND p.deleted_at IS NULL
         AND ($2::date IS NULL OR p.scheduled_date >= $2) AND ($3::date IS NULL OR p.scheduled_date <= $3)
       GROUP BY p.id ORDER BY p.scheduled_date DESC`, [t.id, r.from, r.to]);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load programmes'); }
});

export default router;
