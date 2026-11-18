// backend/src/modules/hr/lnd-reporting.routes.js
//
// L&D reports (rewritten 2026-11-18). The audit found: no permission gate (any
// login read everyone's training records), two reports crashing on columns
// that do not exist, five always empty (status 'active' vs 'Active', enrolment
// statuses nobody wrote), dates concatenated into SQL, and a compliance report
// counting every company's employees.
//
// Every report takes the same filters, all bound parameters:
//   period / from / to   programme date (last 3 / 6 / 12 months, quarter, FY…)
//   department           employee's department
//   category, program_id, trainer_id, mandatory
// Numbers come back as numbers.
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope } from '../../shared/scope.js';
import { cid, lndRange, dim, intOrNull, sendError, EMP_NAME, ACTIVE_EMP } from './lnd/lndShared.js';
import { computeCompliance } from './lnd/lndCompliance.js';
import { coverage, expireCertificates } from './certifications.routes.js';

const router = express.Router();
router.use(requireCompanyScope);
router.use(requirePermission('training', 'view'));

/** Standard filter → bound params + SQL fragments for programme (p) and employee (e). */
function filters(req) {
  const r = lndRange(req.query, 'fytd');
  const v = [cid(req), r.from, r.to, dim(req.query, 'department'), dim(req.query, 'category'),
    intOrNull(req.query.program_id), intOrNull(req.query.trainer_id),
    req.query.mandatory === 'true' ? true : req.query.mandatory === 'false' ? false : null];
  const prog = `p.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1)
    AND ($2::date IS NULL OR COALESCE(p.end_date, p.scheduled_date) >= $2::date) AND ($3::date IS NULL OR p.scheduled_date <= $3::date)
    AND ($5::text IS NULL OR p.category = $5) AND ($6::int IS NULL OR COALESCE(p.series_id, p.id) = $6 OR p.id = $6)
    AND ($7::int IS NULL OR p.trainer_id = $7) AND ($8::boolean IS NULL OR p.is_mandatory = $8)
    AND ($4::text IS NULL OR TRUE)`; // $4 is the employee filter; referenced here so reports without it still bind
  const emp = `($4::text IS NULL OR e.department = $4)`;
  return { v, prog, emp, range: r };
}

const REPORTS = {
  'training-hours': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT COALESCE(e.department,'—') AS department, COUNT(DISTINCT te.employee_id)::int AS employees_trained,
             COUNT(*)::int AS completions, COALESCE(SUM(p.duration_hours),0)::float AS total_hours,
             ROUND(COALESCE(SUM(p.duration_hours),0) / NULLIF(COUNT(DISTINCT te.employee_id),0), 1)::float AS hours_per_person
        FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
       WHERE ${f.prog} AND ${f.emp} AND te.status = 'completed'
       GROUP BY 1 ORDER BY total_hours DESC`, f.v)).rows;
  },
  'completion-rates': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT p.title AS training, p.category, p.scheduled_date::text AS date, p.status,
             COUNT(te.id) FILTER (WHERE te.status <> 'withdrawn')::int AS enrolled,
             COUNT(te.id) FILTER (WHERE te.status = 'completed')::int AS completed,
             COUNT(te.id) FILTER (WHERE te.status IN ('enrolled','in_progress'))::int AS pending,
             COUNT(te.id) FILTER (WHERE te.status = 'no_show')::int AS no_show,
             ROUND(100.0 * COUNT(te.id) FILTER (WHERE te.status = 'completed') / NULLIF(COUNT(te.id) FILTER (WHERE te.status <> 'withdrawn'),0))::int AS completion_pct
        FROM training_programs p
        LEFT JOIN training_enrollments te ON te.program_id = p.id AND (te.employee_id IN (SELECT e.id FROM employees e WHERE ${f.emp}))
       WHERE ${f.prog} AND p.status <> 'cancelled'
       GROUP BY p.id ORDER BY p.scheduled_date DESC`, f.v)).rows;
  },
  'attendance': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT p.title AS training, s.session_date::text AS session_date, s.status,
             COUNT(DISTINCT te.employee_id)::int AS enrolled,
             COUNT(DISTINCT ta.employee_id) FILTER (WHERE ta.present)::int AS present,
             COUNT(DISTINCT ta.employee_id) FILTER (WHERE ta.present = false)::int AS absent,
             ROUND(100.0 * COUNT(DISTINCT ta.employee_id) FILTER (WHERE ta.present) / NULLIF(COUNT(DISTINCT te.employee_id),0))::int AS attendance_pct
        FROM training_sessions s JOIN training_programs p ON p.id = s.program_id
        LEFT JOIN training_enrollments te ON te.program_id = p.id AND te.status <> 'withdrawn'
             AND te.employee_id IN (SELECT e.id FROM employees e WHERE ${f.emp})
        LEFT JOIN training_attendance ta ON ta.session_id = s.id AND ta.employee_id = te.employee_id
       WHERE ${f.prog} GROUP BY p.id, s.id ORDER BY s.session_date DESC`, f.v)).rows;
  },
  'certification-status': async (req) => {
    await expireCertificates(pool, cid(req));
    const f = filters(req);
    return (await pool.query(`
      SELECT c.name AS certification, c.category, c.is_mandatory AS mandatory,
             COUNT(ec.id) FILTER (WHERE ec.status = 'active')::int AS active,
             COUNT(ec.id) FILTER (WHERE ec.status = 'active' AND ec.expiry_date <= CURRENT_DATE + 30)::int AS expiring_30d,
             COUNT(ec.id) FILTER (WHERE ec.status = 'active' AND ec.expiry_date BETWEEN CURRENT_DATE + 31 AND CURRENT_DATE + 90)::int AS expiring_90d,
             COUNT(ec.id) FILTER (WHERE ec.status = 'expired')::int AS expired
        FROM certifications c
        LEFT JOIN employee_certifications ec ON ec.certification_id = c.id AND ec.status IN ('active','expired')
             AND ec.employee_id IN (SELECT e.id FROM employees e WHERE ${ACTIVE_EMP} AND ${f.emp})
       WHERE c.is_active AND ($1::int IS NULL OR c.company_id = $1) AND ($5::text IS NULL OR c.category = $5)
         AND ($8::boolean IS NULL OR c.is_mandatory = $8) AND ($2::date IS NULL OR TRUE) AND ($3::date IS NULL OR TRUE)
         AND ($6::int IS NULL OR TRUE) AND ($7::int IS NULL OR TRUE)
       GROUP BY c.id ORDER BY c.is_mandatory DESC, c.name`, f.v)).rows;
  },
  'certification-coverage': async (req) => {
    await expireCertificates(pool, cid(req));
    const out = await coverage(pool, cid(req), { department: dim(req.query, 'department') });
    return out.rows.filter(r => r.status !== 'valid').map(r => ({
      employee: r.employee_name, emp_code: r.office_id, department: r.department, certification: r.cert_name, status: r.status, expiry_date: r.expiry_date,
    }));
  },
  'competency-gaps': async (req) => {
    const group = req.query.group === 'designation' ? 'e.designation' : 'e.department';
    const { rows } = await pool.query(`
      SELECT COALESCE(${group},'—') AS ${req.query.group === 'designation' ? 'designation' : 'department'}, cf.name AS skill, cf.category,
             COUNT(*)::int AS rated, ROUND(AVG(eca.assessed_level),1)::float AS avg_level,
             ROUND(AVG(COALESCE(rc.required_level, cf.expected_level)),1)::float AS avg_required,
             COUNT(*) FILTER (WHERE eca.assessed_level < COALESCE(rc.required_level, cf.expected_level))::int AS below_required,
             COUNT(*) FILTER (WHERE COALESCE(rc.required_level, cf.expected_level) - eca.assessed_level >= 2)::int AS critical
        FROM employee_competency_assessments eca JOIN employees e ON e.id = eca.employee_id
        JOIN competency_framework cf ON cf.id = eca.competency_id
        LEFT JOIN role_competencies rc ON rc.competency_id = cf.id AND LOWER(rc.role_title) = LOWER(e.designation) AND rc.company_id IS NOT DISTINCT FROM cf.company_id
       WHERE ${ACTIVE_EMP} AND ($1::int IS NULL OR e.company_id = $1) AND ($2::text IS NULL OR e.department = $2)
         AND ($3::text IS NULL OR cf.category = $3) AND cf.is_active
       GROUP BY 1, cf.id HAVING COUNT(*) FILTER (WHERE eca.assessed_level < COALESCE(rc.required_level, cf.expected_level)) > 0
       ORDER BY below_required DESC, 1`, [cid(req), dim(req.query, 'department'), dim(req.query, 'category')]);
    return rows;
  },
  'assessment-results': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT a.title AS test, p.title AS training, a.pass_score,
             COUNT(x.id)::int AS attempts, COUNT(DISTINCT x.employee_id)::int AS takers,
             COUNT(DISTINCT x.employee_id) FILTER (WHERE x.passed)::int AS passed,
             ROUND(100.0 * COUNT(DISTINCT x.employee_id) FILTER (WHERE x.passed) / NULLIF(COUNT(DISTINCT x.employee_id),0))::int AS pass_rate_pct,
             ROUND(AVG(x.score_pct),1)::float AS avg_score,
             COUNT(x.id) FILTER (WHERE x.review_status = 'pending_review')::int AS awaiting_review
        FROM assessments a LEFT JOIN training_programs p ON p.id = a.program_id
        LEFT JOIN assessment_attempts x ON x.assessment_id = a.id AND x.submitted_at IS NOT NULL
             AND ($2::date IS NULL OR x.submitted_at >= $2::date) AND ($3::date IS NULL OR x.submitted_at < $3::date + 1)
             AND x.employee_id IN (SELECT e.id FROM employees e WHERE ${f.emp})
       WHERE a.is_active AND ($1::int IS NULL OR a.company_id = $1) AND ($5::text IS NULL OR p.category = $5)
         AND ($6::int IS NULL OR a.program_id = $6) AND ($7::int IS NULL OR p.trainer_id = $7) AND ($8::boolean IS NULL OR p.is_mandatory = $8)
       GROUP BY a.id, p.title ORDER BY pass_rate_pct ASC NULLS LAST`, f.v)).rows;
  },
  'overdue-training': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT ${EMP_NAME} AS employee, e.office_id AS emp_code, e.department, p.title AS training, p.scheduled_date::text AS date,
             p.is_mandatory AS mandatory, te.status, (CURRENT_DATE - COALESCE(p.end_date, p.scheduled_date))::int AS days_overdue
        FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
       WHERE ${f.prog} AND ${f.emp} AND ${ACTIVE_EMP} AND te.status IN ('enrolled','in_progress') AND p.status <> 'cancelled'
         AND COALESCE(p.end_date, p.scheduled_date) < CURRENT_DATE
       ORDER BY p.is_mandatory DESC, days_overdue DESC`, f.v)).rows;
  },
  'budget-vs-actual': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT category, COUNT(*)::int AS trainings, COALESCE(SUM(budget),0)::float AS budget, COALESCE(SUM(actual),0)::float AS actual
        FROM (SELECT COALESCE(p.category,'Uncategorised') AS category, p.budget,
                     (SELECT SUM(c.amount) FROM training_costs c WHERE c.program_id = p.id) AS actual
                FROM training_programs p WHERE ${f.prog} AND p.status <> 'cancelled') x
       GROUP BY 1 ORDER BY actual DESC NULLS LAST`, f.v)).rows.map(r => ({ ...r, variance: Math.round((r.budget - r.actual) * 100) / 100 }));
  },
  'training-cost': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT p.title AS training, p.category, p.scheduled_date::text AS date, p.budget::float AS budget,
             COALESCE(c.total,0)::float AS actual_cost, en.completed::int AS completed,
             ROUND(COALESCE(c.total,0) / NULLIF(en.completed,0))::float AS cost_per_completion,
             en.avg_rating::float AS avg_feedback
        FROM training_programs p
        LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM training_costs WHERE program_id = p.id) c ON true
        LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE status='completed') AS completed, ROUND(AVG(feedback_rating),1) AS avg_rating
                             FROM training_enrollments WHERE program_id = p.id) en ON true
       WHERE ${f.prog} AND p.status <> 'cancelled' ORDER BY actual_cost DESC`, f.v)).rows;
  },
  'trainer-effectiveness': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT t.name AS trainer, t.trainer_type AS type, t.specialization,
             COUNT(DISTINCT p.id)::int AS trainings, COUNT(DISTINCT te.employee_id) FILTER (WHERE te.status='completed')::int AS people_trained,
             ROUND(AVG(te.feedback_rating),2)::float AS avg_rating,
             ROUND(100.0 * COUNT(te.id) FILTER (WHERE te.status='completed') / NULLIF(COUNT(te.id) FILTER (WHERE te.status <> 'withdrawn'),0))::int AS completion_pct
        FROM trainers t JOIN training_programs p ON p.trainer_id = t.id
        LEFT JOIN training_enrollments te ON te.program_id = p.id
       WHERE ${f.prog} GROUP BY t.id ORDER BY avg_rating DESC NULLS LAST`, f.v)).rows;
  },
  'mandatory-compliance': async (req) => {
    const out = await computeCompliance(pool, cid(req), { department: dim(req.query, 'department'), category: dim(req.query, 'category'), seriesId: intOrNull(req.query.program_id) });
    return out.series.map(s => ({ training: s.title, category: s.category, refresher_months: s.refresher_months, required: s.required,
      compliant: s.compliant, due_soon: s.due_soon, overdue: s.overdue, not_done: s.not_done, scheduled: s.scheduled, compliance_pct: s.compliance_pct }));
  },
  'refresher-due': async (req) => {
    const out = await computeCompliance(pool, cid(req), { department: dim(req.query, 'department'), category: dim(req.query, 'category'),
      seriesId: intOrNull(req.query.program_id), dueSoonDays: intOrNull(req.query.due_soon_days) ?? 60 });
    const order = { overdue: 0, not_done: 1, due_soon: 2 };
    return out.rows.filter(r => r.status in order).sort((a, b) => order[a.status] - order[b.status]).map(r => ({
      employee: r.employee_name, emp_code: r.office_id, department: r.department, training: r.title, refresher_months: r.refresher_months,
      last_completed: r.last_completed, valid_until: r.valid_until, status: r.status, next_scheduled: r.next_scheduled,
    }));
  },
  'self-review-comparison': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT p.title AS training, p.category, p.scheduled_date::text AS date,
             COUNT(DISTINCT te.id) FILTER (WHERE te.status <> 'withdrawn')::int AS participants,
             COUNT(DISTINCT pr.id)::int AS before_done, COUNT(DISTINCT po.id)::int AS after_done,
             ROUND(AVG(pr.knowledge) FILTER (WHERE po.id IS NOT NULL),1)::float AS knowledge_before,
             ROUND(AVG(po.knowledge) FILTER (WHERE pr.id IS NOT NULL),1)::float AS knowledge_after,
             ROUND(AVG(po.knowledge - pr.knowledge),1)::float AS knowledge_change,
             ROUND(AVG(pr.confidence) FILTER (WHERE po.id IS NOT NULL),1)::float AS confidence_before,
             ROUND(AVG(po.confidence) FILTER (WHERE pr.id IS NOT NULL),1)::float AS confidence_after,
             ROUND(AVG(po.confidence - pr.confidence),1)::float AS confidence_change,
             ROUND(AVG(te.feedback_rating),1)::float AS avg_feedback,
             COALESCE((SELECT SUM(c.amount) FROM training_costs c WHERE c.program_id = p.id),0)::float AS cost
        FROM training_programs p
        JOIN training_enrollments te ON te.program_id = p.id JOIN employees e ON e.id = te.employee_id
        LEFT JOIN training_self_reviews pr ON pr.enrollment_id = te.id AND pr.phase = 'pre'
        LEFT JOIN training_self_reviews po ON po.enrollment_id = te.id AND po.phase = 'post'
       WHERE ${f.prog} AND ${f.emp} AND p.self_review_enabled AND p.status <> 'cancelled'
       GROUP BY p.id ORDER BY p.scheduled_date DESC`, f.v)).rows;
  },
  'self-review-people': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT ${EMP_NAME} AS employee, e.office_id AS emp_code, e.department, p.title AS training, p.scheduled_date::text AS date,
             pr.knowledge AS knowledge_before, po.knowledge AS knowledge_after, (po.knowledge - pr.knowledge) AS knowledge_change,
             pr.confidence AS confidence_before, po.confidence AS confidence_after, (po.confidence - pr.confidence) AS confidence_change,
             te.score::float AS score, te.feedback_rating AS feedback, po.comments AS after_comments
        FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
        LEFT JOIN training_self_reviews pr ON pr.enrollment_id = te.id AND pr.phase = 'pre'
        LEFT JOIN training_self_reviews po ON po.enrollment_id = te.id AND po.phase = 'post'
       WHERE ${f.prog} AND ${f.emp} AND (pr.id IS NOT NULL OR po.id IS NOT NULL)
       ORDER BY p.scheduled_date DESC, 1`, f.v)).rows;
  },
  'feedback-analysis': async (req) => {
    const f = filters(req);
    return (await pool.query(`
      SELECT p.title AS training, p.category, COUNT(te.id)::int AS responses, ROUND(AVG(te.feedback_rating),2)::float AS avg_rating,
             COUNT(*) FILTER (WHERE te.feedback_rating >= 4)::int AS positive, COUNT(*) FILTER (WHERE te.feedback_rating <= 2)::int AS negative,
             COUNT(*) FILTER (WHERE te.feedback_comments IS NOT NULL)::int AS with_comments
        FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
       WHERE ${f.prog} AND ${f.emp} AND te.feedback_rating IS NOT NULL
       GROUP BY p.id ORDER BY avg_rating DESC`, f.v)).rows;
  },
  'learning-path-completion': async (req) => {
    const { rows } = await pool.query(`
      SELECT lp.name AS path, lp.path_type AS type, lp.target_role, lp.target_department,
             COUNT(elp.id) FILTER (WHERE elp.status <> 'withdrawn')::int AS assigned,
             COUNT(elp.id) FILTER (WHERE elp.status = 'completed')::int AS completed,
             COUNT(elp.id) FILTER (WHERE elp.status = 'in_progress' AND elp.due_date < CURRENT_DATE)::int AS overdue,
             ROUND(100.0 * COUNT(elp.id) FILTER (WHERE elp.status = 'completed') / NULLIF(COUNT(elp.id) FILTER (WHERE elp.status <> 'withdrawn'),0))::int AS completion_pct
        FROM learning_paths lp
        LEFT JOIN employee_learning_paths elp ON elp.path_id = lp.id
             AND elp.employee_id IN (SELECT e.id FROM employees e WHERE ($2::text IS NULL OR e.department = $2))
       WHERE lp.is_active AND ($1::int IS NULL OR lp.company_id = $1)
       GROUP BY lp.id ORDER BY lp.name`, [cid(req), dim(req.query, 'department')]);
    return rows;
  },
  'employee-history': async (req) => {
    const empId = intOrNull(req.query.employee_id);
    if (!empId) return [];
    const f = filters(req);
    return (await pool.query(`
      SELECT p.title AS training, p.category, p.scheduled_date::text AS date, p.duration_hours::float AS hours, p.is_mandatory AS mandatory,
             COALESCE(t.name, p.trainer) AS trainer, te.status, te.score::float AS score, te.completion_date::text AS completed_on,
             te.feedback_rating AS feedback, ax.score_pct::float AS test_score, ax.passed AS test_passed
        FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id JOIN employees e ON e.id = te.employee_id
        LEFT JOIN trainers t ON t.id = p.trainer_id
        LEFT JOIN LATERAL (SELECT x.score_pct, x.passed FROM assessment_attempts x JOIN assessments a ON a.id = x.assessment_id
                            WHERE a.program_id = p.id AND x.employee_id = te.employee_id AND x.submitted_at IS NOT NULL
                            ORDER BY x.submitted_at DESC LIMIT 1) ax ON true
       WHERE ${f.prog} AND ${f.emp} AND te.employee_id = $9
       ORDER BY p.scheduled_date DESC`, [...f.v, empId])).rows;
  },
};

router.get('/', (req, res) => res.json(Object.keys(REPORTS)));

router.get('/*report', async (req, res) => {
  const key = [].concat(req.params.report).join('/');
  const fn = Object.prototype.hasOwnProperty.call(REPORTS, key) ? REPORTS[key] : null;
  if (!fn) return res.status(404).json({ error: 'Unknown report' });
  try {
    let rows = await fn(req);
    // Cost range applies to every report that carries a cost column.
    const col = rows[0] && ['actual_cost', 'cost', 'actual'].find(c => c in rows[0]);
    if (col && (req.query.cost_min || req.query.cost_max)) {
      const lo = Number(req.query.cost_min); const hi = Number(req.query.cost_max);
      rows = rows.filter(x => (!req.query.cost_min || x[col] >= lo) && (!req.query.cost_max || x[col] <= hi));
    }
    res.json(rows);
  }
  catch (err) { sendError(res, err, 'Could not run the report'); }
});

export default router;
