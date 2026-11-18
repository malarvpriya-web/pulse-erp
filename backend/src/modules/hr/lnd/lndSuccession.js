/**
 * Succession ↔ Learning Center (2026-11-18). A development action of type
 * "training" (or "certification") can name a real training. Linking it:
 *   · checks the training belongs to the company and is still open;
 *   · enrols the plan's employee in it (skipped if already enrolled);
 *   · marks the action in progress — or completed at once when the employee
 *     already completed that training (any round of its series).
 * Completing the training later completes the action (lndEffects.completeLinkedActions).
 */
import { httpError, intOrNull } from './lndShared.js';
import { enrollEmployees, notifyEnrolled } from '../training.routes.js';

export async function linkTrainingAction(db, action, trainingId, companyId, userId) {
  const tid = intOrNull(trainingId);
  if (!tid) throw httpError(400, 'Choose a training');
  if (!['training', 'certification'].includes(action.action_type)) throw httpError(400, 'Only a training or certification action can be linked to a training');
  const { rows: [p] } = await db.query(
    `SELECT * FROM training_programs WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`, [tid, companyId]);
  if (!p) throw httpError(400, 'Training not found');
  const { rows: [plan] } = await db.query(`SELECT employee_id FROM development_plans WHERE id = $1`, [action.plan_id]);
  const { rows: [done] } = await db.query(
    `SELECT 1 FROM training_enrollments te JOIN training_programs r ON r.id = te.program_id
      WHERE te.employee_id = $1 AND te.status = 'completed' AND COALESCE(r.series_id, r.id) = COALESCE($2::int, $3::int)`,
    [plan.employee_id, p.series_id, p.id]);
  if (!done) {
    if (['cancelled', 'completed'].includes(p.status)) throw httpError(409, `That training is ${p.status} — pick an upcoming round.`);
    const out = await enrollEmployees(db, p, [plan.employee_id], { userId, via: 'hr' });
    const full = out.skipped.find(s => s.reason === 'Training is full');
    if (full) throw httpError(409, 'That training is full.');
    if (out.enrolled.length) notifyEnrolled(p, out.enrolled).catch(() => {});
  }
  const { rows: [a] } = await db.query(
    `UPDATE development_actions SET linked_training_id = $2,
            status = CASE WHEN $3::boolean THEN 'completed' WHEN status = 'pending' THEN 'in_progress' ELSE status END,
            completion_date = CASE WHEN $3::boolean THEN COALESCE(completion_date, CURRENT_DATE) ELSE completion_date END,
            updated_at = NOW()
      WHERE id = $1 RETURNING *`, [action.id, p.id, !!done]);
  return a;
}
