// backend/src/modules/hr/my-learning.routes.js
//
// My Learning — every employee's own trainings, paths, tests, certificates and
// skills (Learning Center consolidation 2026-11-18, owner: "My Learning for
// employees — yes").
//
// No module permission: everything here is anchored to the caller's own
// employee record (employeeOf), never to an id from the request. Taking a test
// lives here, not in the HR assessment builder, so questions reach employees
// WITHOUT their answers.
import express from 'express';
import pool from '../../config/db.js';
import { employeeOf, requireCompanyScope } from '../../shared/scope.js';
import {
  cid, getSettings, sendError, httpError, intOrNull, strOrNull, upsertRating, ACTIVE_EMP,
} from './lnd/lndShared.js';
import { completeEnrollment } from './lnd/lndEffects.js';
import { computeCompliance } from './lnd/lndCompliance.js';
import { enrollEmployees, notifyEnrolled } from './training.routes.js';
import { openPhase, validateReview } from './lnd/lndSelfReview.js';

const router = express.Router();
router.use(requireCompanyScope);

async function me(req) {
  const id = await employeeOf(req, pool);
  if (!id) throw httpError(403, 'Your login is not linked to an employee record.');
  const { rows } = await pool.query(
    `SELECT e.id, e.department, e.designation, e.company_id FROM employees e
      WHERE e.id = $1 AND ${ACTIVE_EMP} AND ($2::int IS NULL OR e.company_id = $2)`, [id, cid(req)]);
  if (!rows.length) throw httpError(403, 'Your employee record is not active.');
  return rows[0];
}

/* ── GET /overview — everything My Learning shows ───────────────── */
router.get('/overview', async (req, res) => {
  try {
    const emp = await me(req);
    const settings = await getSettings(emp.company_id);
    const [mine, available, paths, certs, skills, assessments, attempts, compliance] = await Promise.all([
      pool.query(`SELECT te.id, te.status, te.score::float AS score, te.feedback_rating, te.feedback_comments, te.certificate_url,
                         te.completion_date::text AS completion_date, te.enrolled_via,
                         p.id AS program_id, p.title, p.category, p.mode, p.venue, p.online_link, p.is_mandatory,
                         p.scheduled_date::text AS scheduled_date, p.end_date::text AS end_date, p.duration_hours::float AS duration_hours,
                         p.status AS program_status, COALESCE(t.name, p.trainer) AS trainer_name, p.description,
                         p.self_review_enabled, p.self_review_items,
                         (SELECT COALESCE(json_agg(json_build_object('phase', r.phase, 'knowledge', r.knowledge, 'confidence', r.confidence,
                                  'item_ratings', r.item_ratings, 'comments', r.comments, 'submitted_at', r.submitted_at)), '[]'::json)
                            FROM training_self_reviews r WHERE r.enrollment_id = te.id) AS self_reviews
                    FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id
                    LEFT JOIN trainers t ON t.id = p.trainer_id
                   WHERE te.employee_id = $1 AND p.deleted_at IS NULL AND te.status <> 'withdrawn'
                   ORDER BY p.scheduled_date DESC NULLS LAST`, [emp.id]),
      pool.query(`SELECT p.id, p.title, p.category, p.mode, p.venue, p.is_mandatory, p.description,
                         p.scheduled_date::text AS scheduled_date, p.end_date::text AS end_date, p.duration_hours::float AS duration_hours,
                         COALESCE(t.name, p.trainer) AS trainer_name, p.max_participants,
                         (SELECT COUNT(*) FROM training_enrollments x WHERE x.program_id = p.id AND x.status <> 'withdrawn')::int AS enrolled_count
                    FROM training_programs p LEFT JOIN trainers t ON t.id = p.trainer_id
                   WHERE p.deleted_at IS NULL AND p.company_id = $2 AND p.status = 'planned' AND p.scheduled_date >= CURRENT_DATE
                     AND (p.target_department IS NULL OR p.target_department = '' OR p.target_department = $3)
                     AND (p.target_role IS NULL OR p.target_role = '' OR LOWER(p.target_role) = LOWER($4))
                     AND NOT EXISTS (SELECT 1 FROM training_enrollments x WHERE x.program_id = p.id AND x.employee_id = $1 AND x.status <> 'withdrawn')
                   ORDER BY p.scheduled_date`, [emp.id, emp.company_id, emp.department, emp.designation || '']),
      pool.query(`SELECT elp.id, elp.path_id, lp.name, lp.description, lp.path_type, elp.status, elp.due_date::text AS due_date,
                         COUNT(DISTINCT lpi.id)::int AS total_items,
                         COUNT(DISTINCT lpi.id) FILTER (WHERE te.status = 'completed')::int AS completed_items,
                         json_agg(json_build_object('program_id', tp.id, 'title', tp.title, 'scheduled_date', tp.scheduled_date,
                                  'is_mandatory', lpi.is_mandatory, 'status', te.status) ORDER BY lpi.sequence_order)
                           FILTER (WHERE lpi.id IS NOT NULL) AS items
                    FROM employee_learning_paths elp JOIN learning_paths lp ON lp.id = elp.path_id
                    LEFT JOIN learning_path_items lpi ON lpi.path_id = lp.id
                    LEFT JOIN training_programs tp ON tp.id = lpi.program_id
                    LEFT JOIN training_enrollments te ON te.program_id = lpi.program_id AND te.employee_id = elp.employee_id
                   WHERE elp.employee_id = $1 AND elp.status <> 'withdrawn'
                   GROUP BY elp.id, lp.id ORDER BY elp.status, lp.name`, [emp.id]),
      pool.query(`SELECT ec.id, c.name, c.issuing_body, ec.certificate_number, ec.status, ec.issue_date::text AS issue_date,
                         ec.expiry_date::text AS expiry_date, ec.certificate_url, (ec.expiry_date - CURRENT_DATE)::int AS days_left
                    FROM employee_certifications ec JOIN certifications c ON c.id = ec.certification_id
                   WHERE ec.employee_id = $1 AND ec.status <> 'renewed' ORDER BY ec.expiry_date NULLS LAST`, [emp.id]),
      pool.query(`SELECT cf.id AS competency_id, cf.name, cf.category, eca.assessed_level, eca.source, eca.assessed_date::text AS assessed_date,
                         COALESCE(rc.required_level, cf.expected_level) AS required_level
                    FROM competency_framework cf
                    LEFT JOIN employee_competency_assessments eca ON eca.competency_id = cf.id AND eca.employee_id = $1
                    LEFT JOIN role_competencies rc ON rc.competency_id = cf.id AND LOWER(rc.role_title) = LOWER($3)
                         AND rc.company_id IS NOT DISTINCT FROM cf.company_id
                   WHERE cf.is_active AND cf.company_id = $2 AND (eca.id IS NOT NULL OR rc.id IS NOT NULL)
                   ORDER BY cf.name`, [emp.id, emp.company_id, emp.designation || '']),
      pool.query(`SELECT a.id, a.title, a.description, a.pass_score, a.max_attempts, a.time_limit_mins, a.program_id, tp.title AS program_title,
                         (SELECT COUNT(*) FROM assessment_questions q WHERE q.assessment_id = a.id)::int AS question_count,
                         (SELECT COUNT(*) FROM assessment_attempts x WHERE x.assessment_id = a.id AND x.employee_id = $1 AND x.submitted_at IS NOT NULL)::int AS attempts_used,
                         (SELECT BOOL_OR(x.passed) FROM assessment_attempts x WHERE x.assessment_id = a.id AND x.employee_id = $1) AS passed
                    FROM assessments a LEFT JOIN training_programs tp ON tp.id = a.program_id
                   WHERE a.is_active AND a.company_id = $2
                     AND (a.program_id IS NULL OR EXISTS (
                           SELECT 1 FROM training_enrollments te WHERE te.program_id = a.program_id AND te.employee_id = $1 AND te.status <> 'withdrawn'))
                     AND EXISTS (SELECT 1 FROM assessment_questions q WHERE q.assessment_id = a.id)
                   ORDER BY a.title`, [emp.id, emp.company_id]),
      pool.query(`SELECT x.id, x.assessment_id, a.title AS assessment_title, x.attempt_number, x.score_pct::float AS score_pct,
                         x.passed, x.review_status, x.time_exceeded, x.submitted_at, a.pass_score
                    FROM assessment_attempts x JOIN assessments a ON a.id = x.assessment_id
                   WHERE x.employee_id = $1 AND x.submitted_at IS NOT NULL ORDER BY x.submitted_at DESC`, [emp.id]),
      computeCompliance(pool, emp.company_id, { employeeId: emp.id }),
    ]);
    const enrollments = mine.rows.map(e => ({ ...e, self_review_open: openPhase(e, { self_review_enabled: e.self_review_enabled, status: e.program_status }, e.self_reviews || []) }));
    res.json({
      enrollments, available: available.rows, paths: paths.rows, certifications: certs.rows,
      skills: skills.rows, assessments: assessments.rows, attempts: attempts.rows, mandatory: compliance.rows,
      settings: {
        allow_self_enrollment: settings.allow_self_enrollment, max_concurrent_enrollments: settings.max_concurrent_enrollments,
        feedback_required: settings.feedback_required, min_feedback_chars: settings.min_feedback_chars,
      },
    });
  } catch (err) { sendError(res, err, 'Could not load your learning'); }
});

/* ── POST /enroll/:programId — self-enrolment ───────────────────── */
router.post('/enroll/:programId', async (req, res) => {
  const client = await pool.connect();
  try {
    const emp = await me(req);
    const s = await getSettings(emp.company_id);
    if (!s.allow_self_enrollment) throw httpError(403, 'Self-enrolment is turned off. Ask HR to enrol you.');
    await client.query('BEGIN');
    const { rows: [p] } = await client.query(
      `SELECT * FROM training_programs WHERE id = $1 AND deleted_at IS NULL AND company_id = $2 FOR UPDATE`, [req.params.programId, emp.company_id]);
    if (!p) throw httpError(404, 'Training not found');
    if (p.status !== 'planned' || (p.scheduled_date && String(p.scheduled_date).slice(0, 10) < new Date().toISOString().slice(0, 10))) {
      throw httpError(409, 'Enrolment for this training is closed.');
    }
    const okDept = !p.target_department || p.target_department === emp.department;
    const okRole = !p.target_role || String(p.target_role).toLowerCase() === String(emp.designation || '').toLowerCase();
    if (!okDept || !okRole) throw httpError(403, 'This training is for another department or role.');
    const { rows: [open] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM training_enrollments te JOIN training_programs tp ON tp.id = te.program_id
        WHERE te.employee_id = $1 AND te.status IN ('enrolled','in_progress') AND tp.deleted_at IS NULL AND tp.status IN ('planned','ongoing')`, [emp.id]);
    if (open.n >= s.max_concurrent_enrollments) throw httpError(409, `You already have ${open.n} open trainings — the limit is ${s.max_concurrent_enrollments}.`);
    const out = await enrollEmployees(client, p, [emp.id], { userId: req.user?.userId ?? req.user?.id, via: 'self' });
    if (!out.enrolled.length) throw httpError(409, out.skipped[0]?.reason || 'Could not enrol');
    await client.query('COMMIT');
    notifyEnrolled(p, out.enrolled).catch(() => {});
    res.json({ message: `You are enrolled in ${p.title}` });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not enrol'); }
  finally { client.release(); }
});

async function myEnrollment(db, req, id) {
  const emp = await me(req);
  const { rows } = await db.query(
    `SELECT te.*, p.scheduled_date, p.status AS program_status, p.title FROM training_enrollments te
       JOIN training_programs p ON p.id = te.program_id WHERE te.id = $1 AND te.employee_id = $2`, [id, emp.id]);
  if (!rows.length) throw httpError(404, 'Enrolment not found');
  return { emp, en: rows[0] };
}

/* ── POST /enrollments/:id/withdraw — before the training starts ── */
router.post('/enrollments/:id/withdraw', async (req, res) => {
  try {
    const { en } = await myEnrollment(pool, req, req.params.id);
    if (en.status !== 'enrolled') throw httpError(409, 'Only an enrolment that has not started can be withdrawn.');
    if (en.scheduled_date && String(en.scheduled_date).slice(0, 10) <= new Date().toISOString().slice(0, 10)) {
      throw httpError(409, 'The training has started — ask HR to withdraw you.');
    }
    if (en.enrolled_via !== 'self') throw httpError(409, 'HR enrolled you in this training — ask HR to withdraw you.');
    await pool.query(`UPDATE training_enrollments SET status = 'withdrawn', updated_at = NOW() WHERE id = $1`, [en.id]);
    res.json({ message: 'Withdrawn' });
  } catch (err) { sendError(res, err, 'Could not withdraw'); }
});

/* ── POST /enrollments/:id/feedback ─────────────────────────────── */
router.post('/enrollments/:id/feedback', async (req, res) => {
  try {
    const { emp, en } = await myEnrollment(pool, req, req.params.id);
    if (!['completed', 'in_progress'].includes(en.status) && en.program_status !== 'completed') {
      throw httpError(409, 'Feedback opens once the training has taken place.');
    }
    const rating = intOrNull(req.body?.rating);
    if (!rating || rating < 1 || rating > 5) throw httpError(400, 'Give a rating from 1 to 5');
    const comments = strOrNull(req.body?.comments);
    const s = await getSettings(emp.company_id);
    if (s.feedback_required && (comments || '').length < (s.min_feedback_chars || 0)) {
      throw httpError(400, `Please write at least ${s.min_feedback_chars} characters of feedback.`);
    }
    await pool.query(`UPDATE training_enrollments SET feedback_rating = $2, feedback_comments = $3, updated_at = NOW() WHERE id = $1`, [en.id, rating, comments]);
    res.json({ message: 'Thank you for your feedback' });
  } catch (err) { sendError(res, err, 'Could not save feedback'); }
});

/* ── POST /enrollments/:id/self-review — before / after rating ──── */
router.post('/enrollments/:id/self-review', async (req, res) => {
  try {
    const emp = await me(req);
    const { rows: [en] } = await pool.query(
      `SELECT te.*, p.status AS program_status, p.self_review_enabled, p.self_review_items, p.id AS pid
         FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id
        WHERE te.id = $1 AND te.employee_id = $2 AND p.deleted_at IS NULL`, [req.params.id, emp.id]);
    if (!en) throw httpError(404, 'Enrolment not found');
    const { rows: reviews } = await pool.query(`SELECT phase FROM training_self_reviews WHERE enrollment_id = $1`, [en.id]);
    const phase = String(req.body?.phase || '');
    if (!['pre', 'post'].includes(phase)) throw httpError(400, 'phase must be pre or post');
    const open = openPhase(en, { self_review_enabled: en.self_review_enabled, status: en.program_status }, reviews);
    if (open !== phase) {
      throw httpError(409, phase === 'pre'
        ? 'The before-training review is closed — the training is finished.'
        : 'The after-training review opens once the training is completed.');
    }
    const v = validateReview(req.body || {}, Array.isArray(en.self_review_items) ? en.self_review_items : []);
    const { rows: [saved] } = await pool.query(
      `INSERT INTO training_self_reviews (company_id, enrollment_id, program_id, employee_id, phase, knowledge, confidence, item_ratings, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (enrollment_id, phase) DO UPDATE SET knowledge = EXCLUDED.knowledge, confidence = EXCLUDED.confidence,
         item_ratings = EXCLUDED.item_ratings, comments = EXCLUDED.comments, submitted_at = NOW()
       RETURNING *`,
      [en.company_id, en.id, en.pid, emp.id, phase, v.knowledge, v.confidence, JSON.stringify(v.item_ratings), v.comments]);
    res.json({ ...saved, message: phase === 'pre' ? 'Thank you. You will rate yourself again after the training.' : 'Thank you. Your before and after ratings are saved.' });
  } catch (err) { sendError(res, err, 'Could not save your self-review'); }
});

/* ── Tests ──────────────────────────────────────────────────────── */
const GRACE_SECONDS = 60;

async function assessmentForMe(db, emp, id) {
  const { rows: [a] } = await db.query(
    `SELECT * FROM assessments WHERE id = $1 AND is_active AND company_id = $2`, [id, emp.company_id]);
  if (!a) throw httpError(404, 'Test not found');
  let enrollmentId = null;
  if (a.program_id) {
    const { rows } = await db.query(
      `SELECT id FROM training_enrollments WHERE program_id = $1 AND employee_id = $2 AND status <> 'withdrawn'`, [a.program_id, emp.id]);
    if (!rows.length) throw httpError(403, 'This test belongs to a training you are not enrolled in.');
    enrollmentId = rows[0].id;
  }
  return { a, enrollmentId };
}

router.post('/assessments/:id/start', async (req, res) => {
  try {
    const emp = await me(req);
    const { a, enrollmentId } = await assessmentForMe(pool, emp, req.params.id);
    const { rows: done } = await pool.query(
      `SELECT COUNT(*)::int AS n, BOOL_OR(passed) AS passed FROM assessment_attempts
        WHERE assessment_id = $1 AND employee_id = $2 AND submitted_at IS NOT NULL`, [a.id, emp.id]);
    if (done[0].passed) throw httpError(409, 'You have already passed this test.');
    if (done[0].n >= a.max_attempts) throw httpError(409, `All ${a.max_attempts} attempts are used.`);
    // Resume an open attempt still inside its time limit, rather than burning a new one.
    const { rows: open } = await pool.query(
      `SELECT * FROM assessment_attempts WHERE assessment_id = $1 AND employee_id = $2 AND submitted_at IS NULL
        ORDER BY started_at DESC LIMIT 1`, [a.id, emp.id]);
    let attempt = open[0];
    const expired = attempt && a.time_limit_mins && (Date.now() - new Date(attempt.started_at).getTime()) / 1000 > a.time_limit_mins * 60 + GRACE_SECONDS;
    if (!attempt || expired) {
      if (attempt) await pool.query(`DELETE FROM assessment_attempts WHERE id = $1`, [attempt.id]);
      const { rows: [n] } = await pool.query(
        `INSERT INTO assessment_attempts (assessment_id, employee_id, enrollment_id, attempt_number, company_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`, [a.id, emp.id, enrollmentId, done[0].n + 1, emp.company_id]);
      attempt = n;
    }
    const { rows: questions } = await pool.query(
      `SELECT id, question_text, question_type, options, marks, sequence_order FROM assessment_questions
        WHERE assessment_id = $1 ORDER BY sequence_order, id`, [a.id]);
    const secondsLeft = a.time_limit_mins
      ? Math.max(0, Math.round(a.time_limit_mins * 60 - (Date.now() - new Date(attempt.started_at).getTime()) / 1000)) : null;
    res.json({ attempt: { id: attempt.id, attempt_number: attempt.attempt_number, started_at: attempt.started_at },
      assessment: { id: a.id, title: a.title, pass_score: a.pass_score, time_limit_mins: a.time_limit_mins }, questions, seconds_left: secondsLeft });
  } catch (err) { sendError(res, err, 'Could not start the test'); }
});

/** Grade answers. Short answers are left for HR review (marks null). */
export function grade(questions, answers) {
  let earned = 0; let total = 0; let pending = false; const marks = {};
  for (const q of questions) {
    total += Number(q.marks) || 0;
    const given = answers?.[q.id] ?? answers?.[String(q.id)];
    if (q.question_type === 'short_answer') {
      if (given && String(given).trim()) { pending = true; marks[q.id] = null; } else marks[q.id] = 0;
      continue;
    }
    const ok = given != null && String(given).trim().toLowerCase() === String(q.correct_answer ?? '').trim().toLowerCase();
    marks[q.id] = ok ? Number(q.marks) || 0 : 0;
    earned += marks[q.id];
  }
  return { earned, total, pending, marks };
}

router.post('/attempts/:id/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    const emp = await me(req);
    await client.query('BEGIN');
    const { rows: [att] } = await client.query(
      `SELECT x.*, a.pass_score, a.time_limit_mins, a.program_id, a.title FROM assessment_attempts x JOIN assessments a ON a.id = x.assessment_id
        WHERE x.id = $1 AND x.employee_id = $2 FOR UPDATE OF x`, [req.params.id, emp.id]);
    if (!att) throw httpError(404, 'Attempt not found');
    if (att.submitted_at) throw httpError(409, 'This attempt was already submitted.');
    const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const { rows: questions } = await client.query(`SELECT * FROM assessment_questions WHERE assessment_id = $1`, [att.assessment_id]);
    const g = grade(questions, answers);
    const elapsed = (Date.now() - new Date(att.started_at).getTime()) / 1000;
    const late = !!att.time_limit_mins && elapsed > att.time_limit_mins * 60 + GRACE_SECONDS;
    const pct = g.total ? Math.round(100 * g.earned / g.total) : 0;
    const passed = late ? false : (g.pending ? null : pct >= att.pass_score);
    const { rows: [saved] } = await client.query(
      `UPDATE assessment_attempts SET submitted_at = NOW(), answers = $2, question_marks = $3, score = $4, max_score = $5,
              score_pct = $6, passed = $7, time_exceeded = $8, review_status = $9 WHERE id = $1 RETURNING *`,
      [att.id, JSON.stringify(answers), JSON.stringify(g.marks), g.earned, g.total, pct, passed, late,
       g.pending && !late ? 'pending_review' : 'auto']);
    if (passed) await applyPass(client, saved, { companyId: emp.company_id, userId: req.user?.userId ?? req.user?.id });
    await client.query('COMMIT');
    res.json({
      score_pct: pct, passed, pending_review: g.pending && !late, time_exceeded: late, pass_score: att.pass_score,
      message: late ? 'Submitted after the time limit — this attempt does not count as a pass.'
        : g.pending ? 'Submitted. Your written answers will be marked by HR.'
        : passed ? `Passed with ${pct}%.` : `Scored ${pct}%. The pass mark is ${att.pass_score}%.`,
    });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); sendError(res, err, 'Could not submit the test'); }
  finally { client.release(); }
});

/** A passed test completes its training (with the score) — shared with HR review. */
export async function applyPass(db, attempt, { companyId, userId }) {
  if (attempt.enrollment_id) {
    const { rows: [en] } = await db.query(`SELECT status FROM training_enrollments WHERE id = $1`, [attempt.enrollment_id]);
    if (en && en.status !== 'completed' && en.status !== 'withdrawn') {
      await completeEnrollment(db, attempt.enrollment_id, { score: attempt.score_pct, userId, companyId });
      return;
    }
  }
  // A stand-alone test, or a training already completed: still credit the competency.
  const { rows: [a] } = await db.query(
    `SELECT tp.competency_id, a.title FROM assessments a LEFT JOIN training_programs tp ON tp.id = a.program_id WHERE a.id = $1`, [attempt.assessment_id]);
  if (a?.competency_id) {
    await upsertRating(db, { employeeId: attempt.employee_id, competencyId: a.competency_id, level: attempt.score_pct >= 90 ? 4 : 3,
      source: 'assessment', companyId, assessedByUser: userId, notes: `Passed test: ${a.title}` });
  }
}

export default router;
