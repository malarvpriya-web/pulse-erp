// backend/src/modules/hr/assessments.routes.js
//
// Assessment builder (HR) — tests, questions WITH answers, results and the
// short-answer review queue (2026-11-18). Gated on `training`; employees take
// tests through /my-learning, which never returns correct answers. Before
// this, GET /:id/questions handed correct_answer to any logged-in user.
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { cid, getSettings, sendError, httpError, intOrNull, strOrNull, dim, params, lndRange, EMP_NAME } from './lnd/lndShared.js';
import { applyPass } from './my-learning.routes.js';

const router = express.Router();
router.use(requireCompanyScope);
const view = requirePermission('training', 'view');
const add = requirePermission('training', 'add');
const edit = requirePermission('training', 'edit');
const del = requirePermission('training', 'delete');
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

async function assessmentInCompany(db, id, companyId) {
  const { rows } = await db.query(`SELECT * FROM assessments WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Test not found');
  return rows[0];
}

async function body(db, b, companyId, cur = null) {
  const title = strOrNull(b.title ?? cur?.title);
  if (!title) throw httpError(400, 'Title is required');
  const s = await getSettings(companyId, db);
  const pass = intOrNull(b.pass_score ?? cur?.pass_score) ?? s.default_pass_score;
  const max = intOrNull(b.max_attempts ?? cur?.max_attempts) ?? s.default_max_attempts;
  const limit = b.time_limit_mins === '' || b.time_limit_mins === null ? null : intOrNull(b.time_limit_mins ?? cur?.time_limit_mins);
  if (pass < 1 || pass > 100) throw httpError(400, 'Pass mark must be 1–100%');
  if (max < 1 || max > 20) throw httpError(400, 'Attempts must be 1–20');
  if (limit != null && (limit < 1 || limit > 600)) throw httpError(400, 'Time limit must be 1–600 minutes');
  const programId = b.program_id === '' || b.program_id === null ? null : intOrNull(b.program_id ?? cur?.program_id);
  if (programId) {
    const { rows } = await db.query(`SELECT 1 FROM training_programs WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`, [programId, companyId]);
    if (!rows.length) throw httpError(400, 'Unknown training');
  }
  return { title, description: strOrNull(b.description ?? cur?.description), pass_score: pass, max_attempts: max, time_limit_mins: limit, program_id: programId };
}

/* ── GET / ──────────────────────────────────────────────────────── */
router.get('/', view, async (req, res) => {
  try {
    const P = params([cid(req)]);
    const w = ['($1::int IS NULL OR a.company_id = $1)'];
    const status = dim(req.query, 'status') || 'active';
    if (status === 'active') w.push('a.is_active'); else if (status === 'archived') w.push('NOT a.is_active');
    const prog = intOrNull(req.query.program_id); if (prog) w.push(`a.program_id = ${P.add(prog)}`);
    const cat = dim(req.query, 'category'); if (cat) w.push(`tp.category = ${P.add(cat)}`);
    const q = dim(req.query, 'q'); if (q) w.push(`a.title ILIKE ${P.add(`%${q}%`)}`);
    const { rows } = await pool.query(`
      SELECT a.*, tp.title AS program_title, tp.category,
             (SELECT COUNT(*) FROM assessment_questions x WHERE x.assessment_id = a.id)::int AS question_count,
             (SELECT COALESCE(SUM(marks),0) FROM assessment_questions x WHERE x.assessment_id = a.id)::int AS total_marks,
             st.attempts::int AS attempt_count, st.takers::int AS takers, st.passed::int AS passed_count, st.avg_score::float AS avg_score,
             st.pending::int AS pending_review
        FROM assessments a LEFT JOIN training_programs tp ON tp.id = a.program_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS attempts, COUNT(DISTINCT employee_id) AS takers,
                 COUNT(DISTINCT employee_id) FILTER (WHERE passed) AS passed, ROUND(AVG(score_pct),1) AS avg_score,
                 COUNT(*) FILTER (WHERE review_status = 'pending_review') AS pending
            FROM assessment_attempts WHERE assessment_id = a.id AND submitted_at IS NOT NULL) st ON true
       WHERE ${w.join(' AND ')} ORDER BY a.created_at DESC`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load tests'); }
});

router.post('/', add, async (req, res) => {
  try {
    const b = await body(pool, req.body || {}, cid(req));
    const { rows } = await pool.query(
      `INSERT INTO assessments (program_id, title, description, pass_score, max_attempts, time_limit_mins, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.program_id, b.title, b.description, b.pass_score, b.max_attempts, b.time_limit_mins, cid(req), uid(req)]);
    res.status(201).json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not create the test'); }
});

router.put('/:id', edit, captureBefore('assessments'), async (req, res) => {
  try {
    const cur = await assessmentInCompany(pool, req.params.id, cid(req));
    const b = await body(pool, req.body || {}, cid(req), cur);
    const active = req.body?.is_active === undefined ? cur.is_active : !!req.body.is_active;
    const { rows } = await pool.query(
      `UPDATE assessments SET program_id=$2, title=$3, description=$4, pass_score=$5, max_attempts=$6, time_limit_mins=$7, is_active=$8, updated_at=NOW()
        WHERE id = $1 RETURNING *`,
      [cur.id, b.program_id, b.title, b.description, b.pass_score, b.max_attempts, b.time_limit_mins, active]);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not save the test'); }
});

router.delete('/:id', del, captureBefore('assessments'), async (req, res) => {
  try {
    const cur = await assessmentInCompany(pool, req.params.id, cid(req));
    await pool.query(`UPDATE assessments SET is_active = false, updated_at = NOW() WHERE id = $1`, [cur.id]);
    res.json({ message: 'Test archived' });
  } catch (err) { sendError(res, err, 'Could not archive'); }
});

/* ── Questions (HR only — these carry the answers) ──────────────── */
router.get('/:id/questions', view, async (req, res) => {
  try {
    const a = await assessmentInCompany(pool, req.params.id, cid(req));
    const { rows } = await pool.query(`SELECT * FROM assessment_questions WHERE assessment_id = $1 ORDER BY sequence_order, id`, [a.id]);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load questions'); }
});

export function validateQuestions(list) {
  if (!Array.isArray(list)) throw httpError(400, 'questions must be a list');
  return list.map((q, i) => {
    const n = i + 1;
    const text = strOrNull(q.question_text);
    if (!text) throw httpError(400, `Question ${n}: text is required`);
    const type = ['mcq', 'true_false', 'short_answer'].includes(q.question_type) ? q.question_type : 'mcq';
    const marks = intOrNull(q.marks) ?? 1;
    if (marks < 1 || marks > 100) throw httpError(400, `Question ${n}: marks must be 1–100`);
    let options = [];
    let correct = strOrNull(q.correct_answer);
    if (type === 'mcq') {
      options = (Array.isArray(q.options) ? q.options : []).map(o => String(o).trim()).filter(Boolean);
      if (options.length < 2) throw httpError(400, `Question ${n}: give at least two options`);
      if (new Set(options.map(o => o.toLowerCase())).size !== options.length) throw httpError(400, `Question ${n}: options must be different`);
      if (!correct || !options.some(o => o.toLowerCase() === correct.toLowerCase())) throw httpError(400, `Question ${n}: the correct answer must be one of the options`);
    } else if (type === 'true_false') {
      options = ['True', 'False'];
      if (!['true', 'false'].includes(String(correct || '').toLowerCase())) throw httpError(400, `Question ${n}: choose True or False as the answer`);
      correct = String(correct).toLowerCase() === 'true' ? 'True' : 'False';
    } else {
      correct = correct || null; // model answer for the marker, optional
    }
    return { question_text: text, question_type: type, options, correct_answer: correct, marks, sequence_order: n };
  });
}

router.put('/:id/questions', edit, async (req, res) => {
  const client = await pool.connect();
  try {
    const a = await assessmentInCompany(client, req.params.id, cid(req));
    const qs = validateQuestions(req.body?.questions);
    const { rows: prior } = await client.query(`SELECT * FROM assessment_questions WHERE assessment_id = $1 ORDER BY sequence_order`, [a.id]);
    req._auditBefore = { assessment_id: a.id, questions: prior };
    const { rows: [att] } = await client.query(`SELECT COUNT(*)::int AS n FROM assessment_attempts WHERE assessment_id = $1 AND submitted_at IS NOT NULL`, [a.id]);
    if (att.n && !req.body?.confirm_change) {
      throw httpError(409, `${att.n} attempt(s) were already submitted. Changing questions affects how earlier results read — save again with confirmation to proceed.`);
    }
    await client.query('BEGIN');
    await client.query(`DELETE FROM assessment_questions WHERE assessment_id = $1`, [a.id]);
    for (const q of qs) {
      await client.query(
        `INSERT INTO assessment_questions (assessment_id, question_text, question_type, options, correct_answer, marks, sequence_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, q.question_text, q.question_type, JSON.stringify(q.options), q.correct_answer, q.marks, q.sequence_order]);
    }
    await client.query(`UPDATE assessments SET updated_at = NOW() WHERE id = $1`, [a.id]);
    await client.query('COMMIT');
    res.json({ message: 'Questions saved', count: qs.length });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Questions were not saved'); }
  finally { client.release(); }
});

/* ── Results + review ───────────────────────────────────────────── */
router.get('/:id/results', view, async (req, res) => {
  try {
    const a = await assessmentInCompany(pool, req.params.id, cid(req));
    const P = params([a.id]);
    const w = ['x.assessment_id = $1', 'x.submitted_at IS NOT NULL'];
    const r = lndRange(req.query, 'all');
    if (r.from) w.push(`x.submitted_at >= ${P.add(r.from)}::date`);
    if (r.to) w.push(`x.submitted_at < (${P.add(r.to)}::date + 1)`);
    const d = dim(req.query, 'department'); if (d) w.push(`e.department = ${P.add(d)}`);
    const res_ = dim(req.query, 'result');
    if (res_ === 'passed') w.push('x.passed'); else if (res_ === 'failed') w.push('x.passed = false'); else if (res_ === 'pending') w.push(`x.review_status = 'pending_review'`);
    const { rows } = await pool.query(`
      SELECT x.id, x.employee_id, ${EMP_NAME} AS employee_name, e.department, e.office_id, x.attempt_number,
             x.score::float AS score, x.max_score::float AS max_score, x.score_pct::float AS score_pct, x.passed,
             x.review_status, x.time_exceeded, x.submitted_at
        FROM assessment_attempts x JOIN employees e ON e.id = x.employee_id
       WHERE ${w.join(' AND ')} ORDER BY x.submitted_at DESC`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load results'); }
});

router.get('/attempts/:attemptId', view, async (req, res) => {
  try {
    const { rows: [x] } = await pool.query(
      `SELECT x.*, ${EMP_NAME} AS employee_name, a.title AS assessment_title, a.pass_score
         FROM assessment_attempts x JOIN assessments a ON a.id = x.assessment_id JOIN employees e ON e.id = x.employee_id
        WHERE x.id = $1 AND ($2::int IS NULL OR a.company_id = $2)`, [req.params.attemptId, cid(req)]);
    if (!x) return res.status(404).json({ error: 'Attempt not found' });
    const { rows: questions } = await pool.query(`SELECT * FROM assessment_questions WHERE assessment_id = $1 ORDER BY sequence_order, id`, [x.assessment_id]);
    res.json({ ...x, questions });
  } catch (err) { sendError(res, err, 'Could not load the attempt'); }
});

/** Mark the short answers of a pending attempt; finalises score and pass. */
router.post('/attempts/:attemptId/review', edit, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [x] } = await client.query(
      `SELECT x.*, a.pass_score, a.company_id AS a_company FROM assessment_attempts x JOIN assessments a ON a.id = x.assessment_id
        WHERE x.id = $1 AND ($2::int IS NULL OR a.company_id = $2) FOR UPDATE OF x`, [req.params.attemptId, cid(req)]);
    if (!x) throw httpError(404, 'Attempt not found');
    if (x.review_status !== 'pending_review') throw httpError(409, 'This attempt is not waiting for review.');
    const { rows: questions } = await client.query(`SELECT * FROM assessment_questions WHERE assessment_id = $1`, [x.assessment_id]);
    const given = req.body?.marks || {};
    const marks = { ...(x.question_marks || {}) };
    let earned = 0; let total = 0;
    for (const q of questions) {
      total += Number(q.marks) || 0;
      if (q.question_type === 'short_answer' && marks[q.id] === null) {
        const m = Number(given[q.id]);
        if (!Number.isFinite(m) || m < 0 || m > q.marks) throw httpError(400, `Give 0–${q.marks} marks for "${q.question_text.slice(0, 40)}"`);
        marks[q.id] = m;
      }
      earned += Number(marks[q.id]) || 0;
    }
    const pct = total ? Math.round(100 * earned / total) : 0;
    const passed = pct >= x.pass_score;
    const { rows: [saved] } = await client.query(
      `UPDATE assessment_attempts SET question_marks = $2, score = $3, max_score = $4, score_pct = $5, passed = $6,
              review_status = 'reviewed', reviewed_by = $7, reviewed_at = NOW() WHERE id = $1 RETURNING *`,
      [x.id, JSON.stringify(marks), earned, total, pct, passed, uid(req)]);
    if (passed) await applyPass(client, saved, { companyId: x.a_company, userId: uid(req) });
    await client.query('COMMIT');
    res.json(saved);
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Review was not saved'); }
  finally { client.release(); }
});

export default router;
