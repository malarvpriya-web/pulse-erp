/**
 * One employee's learning record, compact — what a probation reviewer or a
 * succession planner needs to see (2026-11-18). `since` limits trainings and
 * tests to a window (the probation period); mandatory status, certificates and
 * skills are always as of today.
 */
import { computeCompliance } from './lndCompliance.js';

export async function learningSnapshot(db, companyId, employeeId, { since = null } = {}) {
  const [tr, tests, certs, skills, gain, comp] = await Promise.all([
    db.query(
      `SELECT te.status, te.score::float AS score, te.completion_date::text AS completion_date, te.feedback_rating,
              p.title, p.scheduled_date::text AS scheduled_date, p.duration_hours::float AS hours, p.is_mandatory
         FROM training_enrollments te JOIN training_programs p ON p.id = te.program_id
        WHERE te.employee_id = $1 AND p.deleted_at IS NULL AND te.status <> 'withdrawn'
          AND ($2::date IS NULL OR p.scheduled_date >= $2::date)
        ORDER BY p.scheduled_date DESC`, [employeeId, since]),
    db.query(
      `SELECT a.title, x.score_pct::float AS score_pct, x.passed, x.review_status, x.submitted_at
         FROM assessment_attempts x JOIN assessments a ON a.id = x.assessment_id
        WHERE x.employee_id = $1 AND x.submitted_at IS NOT NULL AND ($2::date IS NULL OR x.submitted_at >= $2::date)
        ORDER BY x.submitted_at DESC`, [employeeId, since]),
    db.query(
      `SELECT c.name, ec.status, ec.expiry_date::text AS expiry_date, c.is_mandatory
         FROM employee_certifications ec JOIN certifications c ON c.id = ec.certification_id
        WHERE ec.employee_id = $1 AND ec.status IN ('active','expired') ORDER BY c.name`, [employeeId]),
    db.query(
      `SELECT cf.name, eca.assessed_level AS level, COALESCE(rc.required_level, cf.expected_level) AS required
         FROM competency_framework cf
         JOIN employees e ON e.id = $1
         LEFT JOIN employee_competency_assessments eca ON eca.competency_id = cf.id AND eca.employee_id = e.id
         LEFT JOIN role_competencies rc ON rc.competency_id = cf.id AND LOWER(rc.role_title) = LOWER(e.designation)
              AND rc.company_id IS NOT DISTINCT FROM cf.company_id
        WHERE cf.is_active AND ($2::int IS NULL OR cf.company_id = $2::int) AND (eca.id IS NOT NULL OR rc.id IS NOT NULL)
        ORDER BY cf.name`, [employeeId, companyId]),
    db.query(
      `SELECT ROUND(AVG(po.knowledge - pr.knowledge),1)::float AS knowledge, ROUND(AVG(po.confidence - pr.confidence),1)::float AS confidence, COUNT(*)::int AS n
         FROM training_self_reviews pr JOIN training_self_reviews po ON po.enrollment_id = pr.enrollment_id AND po.phase = 'post'
        WHERE pr.phase = 'pre' AND pr.employee_id = $1 AND ($2::date IS NULL OR pr.submitted_at >= $2::date)`, [employeeId, since]),
    computeCompliance(db, companyId, { employeeId }),
  ]);
  const done = tr.rows.filter(t => t.status === 'completed');
  const graded = tests.rows.filter(t => t.review_status !== 'pending_review');
  return {
    since,
    totals: {
      completed: done.length,
      hours: Math.round(10 * done.reduce((s, t) => s + (t.hours || 0), 0)) / 10,
      open: tr.rows.filter(t => ['enrolled', 'in_progress'].includes(t.status)).length,
      no_shows: tr.rows.filter(t => t.status === 'no_show').length,
      avg_score: done.filter(t => t.score != null).length ? Math.round(done.filter(t => t.score != null).reduce((s, t) => s + t.score, 0) / done.filter(t => t.score != null).length) : null,
      tests_taken: graded.length, tests_passed: graded.filter(t => t.passed).length,
      mandatory_required: comp.rows.length,
      mandatory_compliant: comp.rows.filter(r => r.status === 'compliant' || r.status === 'due_soon').length,
      knowledge_gain: gain.rows[0].n ? gain.rows[0].knowledge : null,
      confidence_gain: gain.rows[0].n ? gain.rows[0].confidence : null,
      skill_gaps: skills.rows.filter(s => !s.level || s.level < s.required).length,
    },
    trainings: tr.rows.slice(0, 15), tests: tests.rows.slice(0, 10), mandatory: comp.rows, certificates: certs.rows, skills: skills.rows,
  };
}
