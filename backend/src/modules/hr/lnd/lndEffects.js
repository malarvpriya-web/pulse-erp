/**
 * What happens when a training is completed — one function, used by HR marking
 * completion, by a passed assessment and by assessment review, so the three can
 * never disagree (2026-11-18).
 *
 *   1. prerequisite check: a path the employee is on may require another
 *      programme first;
 *   2. the enrolment is marked completed (score, date, who);
 *   3. the programme's linked competency is raised for the employee
 *      (automatic sources only ever raise a rating);
 *   4. every learning path whose mandatory items are now all done is closed.
 */
import { upsertRating, getSettings, httpError } from './lndShared.js';

/** Level a completion earns: no score → 2, at/above pass mark → 3, 90+ → 4. */
export function levelForScore(score, passScore = 70) {
  if (score == null || score === '') return 2;
  const s = Number(score);
  if (s >= 90) return 4;
  if (s >= passScore) return 3;
  return 2;
}

/** Throws 409 when a path the employee is on requires an unfinished programme first. */
export async function assertPrerequisites(db, employeeId, programId) {
  const { rows } = await db.query(
    `SELECT DISTINCT pre.id, pre.title
       FROM employee_learning_paths elp
       JOIN learning_path_items lpi ON lpi.path_id = elp.path_id AND lpi.program_id = $2
       JOIN training_programs pre ON pre.id = lpi.prerequisite_program_id
      WHERE elp.employee_id = $1 AND elp.status <> 'withdrawn'
        AND NOT EXISTS (
          SELECT 1 FROM training_enrollments te
            JOIN training_programs tp ON tp.id = te.program_id
           WHERE te.employee_id = $1 AND te.status = 'completed'
             AND COALESCE(tp.series_id, tp.id) = COALESCE(pre.series_id, pre.id))`,
    [employeeId, programId]);
  if (rows.length) throw httpError(409, `Complete "${rows[0].title}" first — it is a prerequisite on this employee's learning path.`);
}

/** Succession: development actions linked to this training (any round) are completed, and their plans' progress refreshed. */
export async function completeLinkedActions(db, employeeId, programId) {
  const { rows } = await db.query(
    `UPDATE development_actions da SET status = 'completed', completion_date = CURRENT_DATE, updated_at = NOW()
       FROM development_plans dp, training_programs lt, training_programs done
      WHERE dp.id = da.plan_id AND dp.employee_id = $1 AND lt.id = da.linked_training_id AND done.id = $2
        AND COALESCE(lt.series_id, lt.id) = COALESCE(done.series_id, done.id) AND da.status IN ('pending','in_progress')
      RETURNING da.plan_id`, [employeeId, programId]);
  for (const planId of [...new Set(rows.map(r => r.plan_id))]) {
    await db.query(
      `UPDATE development_plans SET overall_progress = COALESCE((SELECT ROUND(COUNT(*) FILTER (WHERE status='completed') * 100.0 / NULLIF(COUNT(*),0))
         FROM development_actions WHERE plan_id = $1), 0), updated_at = NOW() WHERE id = $1`, [planId]);
  }
  return rows.length;
}

/** Close paths whose mandatory items are all completed. Returns closed path ids. */
export async function syncPathsFor(db, employeeId) {
  const { rows } = await db.query(
    `UPDATE employee_learning_paths elp SET status = 'completed', completed_at = NOW()
      WHERE elp.employee_id = $1 AND elp.status = 'in_progress'
        AND EXISTS (SELECT 1 FROM learning_path_items i WHERE i.path_id = elp.path_id)
        AND NOT EXISTS (
          SELECT 1 FROM learning_path_items i
           WHERE i.path_id = elp.path_id AND i.is_mandatory
             AND NOT EXISTS (
               SELECT 1 FROM training_enrollments te JOIN training_programs tp ON tp.id = te.program_id
                 JOIN training_programs ip ON ip.id = i.program_id
                WHERE te.employee_id = elp.employee_id AND te.status = 'completed'
                  AND COALESCE(tp.series_id, tp.id) = COALESCE(ip.series_id, ip.id)))
      RETURNING elp.path_id`, [employeeId]);
  return rows.map(r => r.path_id);
}

/**
 * Mark one enrolment completed and apply every consequence. `db` must be a
 * client inside the caller's transaction.
 */
export async function completeEnrollment(db, enrollmentId, { score = null, userId = null, companyId = null, certificateUrl = null } = {}) {
  const { rows: [en] } = await db.query(
    `SELECT te.*, tp.competency_id, tp.title, tp.status AS program_status
       FROM training_enrollments te JOIN training_programs tp ON tp.id = te.program_id
      WHERE te.id = $1 AND ($2::int IS NULL OR te.company_id = $2) FOR UPDATE OF te`,
    [enrollmentId, companyId]);
  if (!en) throw httpError(404, 'Enrolment not found');
  if (en.status === 'withdrawn') throw httpError(409, 'This enrolment was withdrawn — re-enrol the employee first.');
  if (en.program_status === 'cancelled') throw httpError(409, 'The training was cancelled.');
  await assertPrerequisites(db, en.employee_id, en.program_id);

  const { rows: [done] } = await db.query(
    `UPDATE training_enrollments
        SET status = 'completed',
            completion_date = COALESCE(completion_date, CURRENT_DATE),
            score = COALESCE($2, score),
            certificate_url = COALESCE($3, certificate_url),
            completed_by = $4, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [enrollmentId, score, certificateUrl, userId]);

  if (en.competency_id) {
    const s = await getSettings(companyId ?? en.company_id, db);
    await upsertRating(db, {
      employeeId: en.employee_id, competencyId: en.competency_id,
      level: levelForScore(done.score, s.default_pass_score), source: 'training',
      companyId: en.company_id, assessedByUser: userId, notes: `Completed: ${en.title}`,
    });
  }
  const closedPaths = await syncPathsFor(db, en.employee_id);
  await completeLinkedActions(db, en.employee_id, en.program_id);
  return { enrollment: done, closedPaths };
}
