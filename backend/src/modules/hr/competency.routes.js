// backend/src/modules/hr/competency.routes.js
//
// Skills & Competencies — ONE library and ONE 1–5 rating per employee
// (2026-11-18). This replaces the Skill Matrix's employee_skills table, the
// training module's skill_matrix table and Performance's competency_definitions:
// trainings, tests and certificates raise these ratings automatically,
// Performance reviews read the same library, and HR / the reporting manager
// rate people here.
//
//   library      competency_framework (category = Master Setup → Skill Categories)
//   required     role_competencies (per designation), else the library default
//   rating       employee_competency_assessments
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission, can } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope, employeeOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { cid, sendError, httpError, intOrNull, numOrNull, strOrNull, dim, params, upsertRating, EMP_NAME, ACTIVE_EMP } from './lnd/lndShared.js';

const router = express.Router();
router.use(requireCompanyScope);
const view = requirePermission('training', 'view');
const add = requirePermission('training', 'add');
const edit = requirePermission('training', 'edit');
const del = requirePermission('training', 'delete');
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

const REQUIRED_SQL = `COALESCE(rc.required_level, cf.expected_level)`;
const RC_JOIN = (empAlias = 'e') => `LEFT JOIN role_competencies rc ON rc.competency_id = cf.id
  AND LOWER(rc.role_title) = LOWER(${empAlias}.designation) AND rc.company_id IS NOT DISTINCT FROM cf.company_id`;

async function competencyInCompany(db, id, companyId) {
  const { rows } = await db.query(`SELECT * FROM competency_framework WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Skill / competency not found');
  return rows[0];
}

/* ── categories (Master Setup → Skill Categories) ───────────────── */
router.get('/categories', view, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM master_skill_categories WHERE is_active AND (company_id IS NULL OR company_id = $1) ORDER BY sort_order, name`, [cid(req)]);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load categories'); }
});

/* ── library ────────────────────────────────────────────────────── */
router.get('/', view, async (req, res) => {
  try {
    const P = params([cid(req)]);
    const w = ['($1::int IS NULL OR cf.company_id = $1)'];
    const st = dim(req.query, 'status') || 'active';
    if (st === 'active') w.push('cf.is_active'); else if (st === 'inactive') w.push('NOT cf.is_active');
    const c = dim(req.query, 'category'); if (c) w.push(`cf.category = ${P.add(c)}`);
    const q = dim(req.query, 'q'); if (q) { const ph = P.add(`%${q}%`); w.push(`(cf.name ILIKE ${ph} OR cf.description ILIKE ${ph})`); }
    const { rows } = await pool.query(`
      SELECT cf.*,
             (SELECT COUNT(*) FROM employee_competency_assessments a WHERE a.competency_id = cf.id)::int AS rated_count,
             (SELECT ROUND(AVG(a.assessed_level),1) FROM employee_competency_assessments a WHERE a.competency_id = cf.id)::float AS avg_level,
             (SELECT COUNT(*) FROM role_competencies r WHERE r.competency_id = cf.id)::int AS role_count,
             (SELECT COUNT(*) FROM training_programs p WHERE p.competency_id = cf.id AND p.deleted_at IS NULL)::int AS program_count
        FROM competency_framework cf WHERE ${w.join(' AND ')} ORDER BY cf.category NULLS LAST, cf.name`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load the library'); }
});

function compBody(b, cur = {}) {
  const name = strOrNull(b.name ?? cur.name);
  if (!name) throw httpError(400, 'Name is required');
  const expected = intOrNull(b.expected_level ?? cur.expected_level) ?? 3;
  if (expected < 1 || expected > 5) throw httpError(400, 'Expected level must be 1–5');
  const pick = (k) => (Object.prototype.hasOwnProperty.call(b, k) ? strOrNull(b[k]) : cur[k] ?? null);
  return {
    name, expected_level: expected, category: pick('category'), description: pick('description'),
    level_1_descriptor: pick('level_1_descriptor'), level_2_descriptor: pick('level_2_descriptor'), level_3_descriptor: pick('level_3_descriptor'),
    level_4_descriptor: pick('level_4_descriptor'), level_5_descriptor: pick('level_5_descriptor'),
    is_active: b.is_active === undefined ? (cur.is_active ?? true) : !!b.is_active,
  };
}

router.post('/', add, async (req, res) => {
  try {
    const b = compBody(req.body || {});
    const { rows } = await pool.query(`
      INSERT INTO competency_framework (name, category, description, expected_level, level_1_descriptor, level_2_descriptor,
        level_3_descriptor, level_4_descriptor, level_5_descriptor, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.name, b.category, b.description, b.expected_level, b.level_1_descriptor, b.level_2_descriptor, b.level_3_descriptor,
       b.level_4_descriptor, b.level_5_descriptor, cid(req)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A skill / competency with this name already exists.' });
    sendError(res, err, 'Could not create');
  }
});

/* ── role requirements ──────────────────────────────────────────── */
router.get('/role-requirements', view, async (req, res) => {
  try {
    const role = dim(req.query, 'role_title');
    const { rows } = await pool.query(`
      SELECT rc.id, rc.role_title, rc.competency_id, rc.required_level, cf.name AS competency_name, cf.category
        FROM role_competencies rc JOIN competency_framework cf ON cf.id = rc.competency_id
       WHERE ($1::int IS NULL OR rc.company_id = $1) AND ($2::text IS NULL OR LOWER(rc.role_title) = LOWER($2))
       ORDER BY rc.role_title, cf.name`, [cid(req), role]);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load role requirements'); }
});

/** Replace the requirements of one role (designation). */
router.put('/role-requirements', edit, async (req, res) => {
  const role = strOrNull(req.body?.role_title);
  const reqs = Array.isArray(req.body?.requirements) ? req.body.requirements : [];
  if (!role) return res.status(400).json({ error: 'Choose the role (designation)' });
  const companyId = cid(req);
  const client = await pool.connect();
  try {
    const ids = reqs.map(r => intOrNull(r.competency_id));
    if (ids.some(x => !x) || new Set(ids).size !== ids.length) throw httpError(400, 'Each skill can be listed once');
    for (const r of reqs) { const l = intOrNull(r.required_level); if (!l || l < 1 || l > 5) throw httpError(400, 'Required level must be 1–5'); }
    if (ids.length) {
      const { rows } = await client.query(`SELECT id FROM competency_framework WHERE id = ANY($1::int[]) AND ($2::int IS NULL OR company_id = $2)`, [ids, companyId]);
      if (rows.length !== ids.length) throw httpError(400, 'Unknown skill / competency');
    }
    const { rows: prior } = await client.query(`SELECT * FROM role_competencies WHERE LOWER(role_title) = LOWER($1) AND company_id IS NOT DISTINCT FROM $2::int`, [role, companyId]);
    req._auditBefore = { role_title: role, requirements: prior };
    await client.query('BEGIN');
    await client.query(`DELETE FROM role_competencies WHERE LOWER(role_title) = LOWER($1) AND company_id IS NOT DISTINCT FROM $2::int`, [role, companyId]);
    for (const r of reqs) {
      await client.query(`INSERT INTO role_competencies (role_title, competency_id, required_level, company_id) VALUES ($1,$2,$3,$4)`,
        [role, intOrNull(r.competency_id), intOrNull(r.required_level), companyId]);
    }
    await client.query('COMMIT');
    res.json({ message: `Requirements saved for ${role}`, count: reqs.length });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Requirements were not saved'); }
  finally { client.release(); }
});

router.put('/:id', edit, captureBefore('competency_framework'), async (req, res) => {
  try {
    const cur = await competencyInCompany(pool, req.params.id, cid(req));
    const b = compBody(req.body || {}, cur);
    const { rows } = await pool.query(`
      UPDATE competency_framework SET name=$2, category=$3, description=$4, expected_level=$5, level_1_descriptor=$6,
        level_2_descriptor=$7, level_3_descriptor=$8, level_4_descriptor=$9, level_5_descriptor=$10, is_active=$11, updated_at=NOW()
       WHERE id = $1 RETURNING *`,
      [cur.id, b.name, b.category, b.description, b.expected_level, b.level_1_descriptor, b.level_2_descriptor,
       b.level_3_descriptor, b.level_4_descriptor, b.level_5_descriptor, b.is_active]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A skill / competency with this name already exists.' });
    sendError(res, err, 'Could not save');
  }
});

/** In use (rated, required by a role, linked to a training/certificate) → deactivated, not deleted. */
router.delete('/:id', del, captureBefore('competency_framework'), async (req, res) => {
  try {
    const cur = await competencyInCompany(pool, req.params.id, cid(req));
    const { rows: [u] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM employee_competency_assessments WHERE competency_id = $1)
           + (SELECT COUNT(*) FROM role_competencies WHERE competency_id = $1)
           + (SELECT COUNT(*) FROM training_programs WHERE competency_id = $1 AND deleted_at IS NULL)
           + (SELECT COUNT(*) FROM certifications WHERE competency_id = $1) AS n`, [cur.id]);
    if (Number(u.n)) {
      await pool.query(`UPDATE competency_framework SET is_active = false, updated_at = NOW() WHERE id = $1`, [cur.id]);
      return res.json({ deactivated: true, message: 'In use — deactivated instead of deleted, so existing ratings stay.' });
    }
    await pool.query(`DELETE FROM competency_framework WHERE id = $1`, [cur.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { sendError(res, err, 'Could not delete'); }
});

/* ── matrix: active employees × skills ──────────────────────────── */
router.get('/matrix', view, async (req, res) => {
  const companyId = cid(req);
  try {
    const P = params([companyId]);
    const ew = [`${ACTIVE_EMP}`, '($1::int IS NULL OR e.company_id = $1)'];
    const d = dim(req.query, 'department'); if (d) ew.push(`e.department = ${P.add(d)}`);
    const r = dim(req.query, 'designation'); if (r) ew.push(`e.designation = ${P.add(r)}`);
    const q = dim(req.query, 'q'); if (q) { const ph = P.add(`%${q}%`); ew.push(`(${EMP_NAME} ILIKE ${ph} OR e.office_id ILIKE ${ph})`); }
    const cw = ['cf.is_active', '($1::int IS NULL OR cf.company_id = $1)'];
    const c = dim(req.query, 'category'); if (c) cw.push(`cf.category = ${P.add(c)}`);
    const compIds = String(req.query.competency_ids || '').split(',').map(intOrNull).filter(Boolean);
    if (compIds.length) cw.push(`cf.id = ANY(${P.add(compIds)}::int[])`);
    const [emps, comps] = await Promise.all([
      pool.query(`SELECT e.id, ${EMP_NAME} AS name, e.office_id, e.department, e.designation FROM employees e WHERE ${ew.join(' AND ')} ORDER BY 2`, P.list),
      pool.query(`SELECT cf.id, cf.name, cf.category, cf.expected_level FROM competency_framework cf WHERE ${cw.join(' AND ')} ORDER BY cf.category NULLS LAST, cf.name`, P.list),
    ]);
    const empIds = emps.rows.map(e => e.id); const cIds = comps.rows.map(x => x.id);
    const [ratings, reqs] = await Promise.all([
      empIds.length && cIds.length ? pool.query(
        `SELECT id, employee_id, competency_id, assessed_level, source, assessed_date::text AS assessed_date, notes, years_experience::float AS years_experience
           FROM employee_competency_assessments WHERE employee_id = ANY($1::int[]) AND competency_id = ANY($2::int[])`, [empIds, cIds]) : { rows: [] },
      pool.query(`SELECT LOWER(role_title) AS role, competency_id, required_level FROM role_competencies WHERE ($1::int IS NULL OR company_id = $1)`, [companyId]),
    ]);
    const reqMap = new Map(reqs.rows.map(x => [`${x.role}|${x.competency_id}`, x.required_level]));
    const rateMap = new Map(ratings.rows.map(x => [`${x.employee_id}|${x.competency_id}`, x]));
    const onlyGaps = req.query.gaps_only === 'true';
    const employees = emps.rows.map(e => {
      const cells = {};
      let gaps = 0;
      for (const cmp of comps.rows) {
        const required = reqMap.get(`${String(e.designation || '').toLowerCase()}|${cmp.id}`) ?? null;
        const r = rateMap.get(`${e.id}|${cmp.id}`) || null;
        const target = required ?? cmp.expected_level;
        const gap = r ? r.assessed_level < target : required != null;
        if (gap) gaps++;
        cells[cmp.id] = { rating_id: r?.id ?? null, level: r?.assessed_level ?? null, source: r?.source ?? null, assessed_date: r?.assessed_date ?? null,
          notes: r?.notes ?? null, years_experience: r?.years_experience ?? null, required, gap };
      }
      return { ...e, cells, gaps };
    }).filter(e => !onlyGaps || e.gaps > 0);
    const summary = comps.rows.map(cmp => {
      const lv = employees.map(e => e.cells[cmp.id]?.level).filter(Boolean);
      return { competency_id: cmp.id, name: cmp.name, rated: lv.length, avg_level: lv.length ? Math.round(10 * lv.reduce((a, b) => a + b, 0) / lv.length) / 10 : null,
        gaps: employees.filter(e => e.cells[cmp.id]?.gap).length };
    });
    res.json({ employees, competencies: comps.rows, summary });
  } catch (err) { sendError(res, err, 'Could not load the matrix'); }
});

/* ── one employee ───────────────────────────────────────────────── */
async function canRate(req, employee) {
  if (await can(req, 'training', 'edit')) return true;
  const meId = await employeeOf(req, pool);
  return meId != null && employee.reporting_manager_id === meId && employee.id !== meId;
}

async function employeeForRating(req, id) {
  const { rows } = await pool.query(
    `SELECT e.id, e.designation, e.reporting_manager_id, ${EMP_NAME} AS name FROM employees e
      WHERE e.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2)`, [id, cid(req)]);
  if (!rows.length) throw httpError(404, 'Employee not found');
  return rows[0];
}

router.get('/employee/:employee_id', async (req, res) => {
  try {
    const emp = await employeeForRating(req, req.params.employee_id);
    const meId = await employeeOf(req, pool);
    if (!(await can(req, 'training', 'view')) && emp.id !== meId && emp.reporting_manager_id !== meId) {
      return res.status(403).json({ error: 'You can see only your own or your team members\' skills.' });
    }
    const { rows } = await pool.query(`
      SELECT cf.id, cf.name, cf.category, cf.description, cf.expected_level,
             cf.level_1_descriptor, cf.level_2_descriptor, cf.level_3_descriptor, cf.level_4_descriptor, cf.level_5_descriptor,
             eca.id AS rating_id, eca.assessed_level, eca.source, eca.assessed_date::text AS assessed_date, eca.notes,
             eca.years_experience::float AS years_experience, rc.required_level AS role_required, ${REQUIRED_SQL} AS required_level
        FROM competency_framework cf
        CROSS JOIN (SELECT $3::text AS designation) emp
        LEFT JOIN employee_competency_assessments eca ON eca.competency_id = cf.id AND eca.employee_id = $1
        ${RC_JOIN('emp')}
       WHERE cf.is_active AND ($2::int IS NULL OR cf.company_id = $2)
       ORDER BY (eca.id IS NULL AND rc.id IS NULL), cf.category NULLS LAST, cf.name`, [emp.id, cid(req), emp.designation || '']);
    res.json({ employee: emp, competencies: rows, can_rate: await canRate(req, emp) });
  } catch (err) { sendError(res, err, 'Could not load skills'); }
});

/** Rate an employee — HR (training:edit) or the employee's reporting manager; never yourself. */
router.post('/employee/:employee_id/assess', async (req, res) => {
  const client = await pool.connect();
  try {
    const emp = await employeeForRating(req, req.params.employee_id);
    if (!(await canRate(req, emp))) return res.status(403).json({ error: 'Only HR or the reporting manager can rate this employee.' });
    const meId = await employeeOf(req, pool);
    if (meId === emp.id && !(await can(req, 'training', 'edit'))) return res.status(403).json({ error: 'You cannot rate yourself.' });
    const list = Array.isArray(req.body?.assessments) ? req.body.assessments : [];
    if (!list.length) throw httpError(400, 'Nothing to save');
    const ids = list.map(a => intOrNull(a.competency_id));
    const { rows: ok } = await client.query(`SELECT id FROM competency_framework WHERE id = ANY($1::int[]) AND ($2::int IS NULL OR company_id = $2)`, [ids, cid(req)]);
    if (ok.length !== new Set(ids).size) throw httpError(400, 'Unknown skill / competency');
    await client.query('BEGIN');
    for (const a of list) {
      const level = intOrNull(a.assessed_level ?? a.level);
      if (!level || level < 1 || level > 5) throw httpError(400, 'Levels must be 1–5');
      const yrs = numOrNull(a.years_experience);
      if (yrs != null && (yrs < 0 || yrs > 60)) throw httpError(400, 'Years of experience must be 0–60');
      await upsertRating(client, { employeeId: emp.id, competencyId: intOrNull(a.competency_id), level, source: 'manual',
        companyId: cid(req), assessedBy: meId, assessedByUser: uid(req), notes: strOrNull(a.notes), yearsExperience: yrs });
    }
    await client.query('COMMIT');
    res.json({ message: `${list.length} rating(s) saved` });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Ratings were not saved'); }
  finally { client.release(); }
});

router.delete('/ratings/:id', del, captureBefore('employee_competency_assessments'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM employee_competency_assessments WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [req.params.id, cid(req)]);
    if (!rowCount) return res.status(404).json({ error: 'Rating not found' });
    res.json({ message: 'Rating removed' });
  } catch (err) { sendError(res, err, 'Could not remove'); }
});

/* ── gaps (by department or designation) ────────────────────────── */
router.get('/gaps', view, async (req, res) => {
  try {
    const group = req.query.group === 'designation' ? 'e.designation' : 'e.department';
    const P = params([cid(req)]);
    const w = [`${ACTIVE_EMP}`, '($1::int IS NULL OR e.company_id = $1)', 'cf.is_active'];
    const d = dim(req.query, 'department'); if (d) w.push(`e.department = ${P.add(d)}`);
    const c = dim(req.query, 'category'); if (c) w.push(`cf.category = ${P.add(c)}`);
    const { rows } = await pool.query(`
      SELECT COALESCE(${group}, '—') AS grp, cf.id AS competency_id, cf.name AS competency, cf.category,
             COUNT(*)::int AS rated, ROUND(AVG(eca.assessed_level),1)::float AS avg_level,
             ROUND(AVG(${REQUIRED_SQL}),1)::float AS avg_required,
             ROUND(AVG(${REQUIRED_SQL} - eca.assessed_level),1)::float AS avg_gap,
             COUNT(*) FILTER (WHERE eca.assessed_level < ${REQUIRED_SQL})::int AS below_required,
             COUNT(*) FILTER (WHERE ${REQUIRED_SQL} - eca.assessed_level >= 2)::int AS critical
        FROM employee_competency_assessments eca
        JOIN employees e ON e.id = eca.employee_id
        JOIN competency_framework cf ON cf.id = eca.competency_id
        ${RC_JOIN()}
       WHERE ${w.join(' AND ')}
       GROUP BY 1, cf.id HAVING COUNT(*) FILTER (WHERE eca.assessed_level < ${REQUIRED_SQL}) > 0
       ORDER BY avg_gap DESC, below_required DESC`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load gaps'); }
});

export default router;
