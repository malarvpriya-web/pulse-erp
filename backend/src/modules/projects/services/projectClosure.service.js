// backend/src/modules/projects/services/projectClosure.service.js
//
// What must be finished before a project can close. One definition, used by
// PUT /projects/:id (status -> completed) and by completing its lifecycle at
// the Closure stage (lifecycle.routes.js). Moved here unchanged from
// projects.routes.js so the two cannot drift apart.

/**
 * @param {{ query: Function }} db  pool or client
 * @param {number} projectId
 * @returns {Promise<Array<{ type: 'open_tasks'|'unbilled_milestones'|'pending_timesheets', count: number }>>}
 */
export async function getProjectClosureBlockers(db, projectId) {
  const [openTasks, unbilledMilestones, pendingTimesheets] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE project_id=$1 AND deleted_at IS NULL AND status != 'done'`,
      [projectId]
    ),
    db.query(
      `SELECT COUNT(*)::int AS n FROM project_milestones
       WHERE project_id=$1 AND billing_milestone=TRUE AND COALESCE(invoice_created,false)=FALSE`,
      [projectId]
    ),
    db.query(
      `SELECT COUNT(*)::int AS n FROM timesheet_entries
       WHERE project_id=$1 AND deleted_at IS NULL AND status IN ('draft','submitted')`,
      [projectId]
    ),
  ]);
  const blockers = [];
  if (openTasks.rows[0].n > 0) blockers.push({ type: 'open_tasks', count: openTasks.rows[0].n });
  if (unbilledMilestones.rows[0].n > 0) blockers.push({ type: 'unbilled_milestones', count: unbilledMilestones.rows[0].n });
  if (pendingTimesheets.rows[0].n > 0) blockers.push({ type: 'pending_timesheets', count: pendingTimesheets.rows[0].n });
  return blockers;
}
