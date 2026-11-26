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
  const [openTasks, unbilledMilestones, pendingTimesheets, travel] = await Promise.all([
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
    // Travel on the project still in flight (26 Nov 26): trips waiting for a
    // decision and expense claims not yet paid or closed. The travel module
    // had this check (GET /travel/closure-check) but nothing ever called it.
    db.query(
      `SELECT (SELECT COUNT(*) FROM travel_requests WHERE project_id=$1 AND status='Pending')::int AS trips,
              (SELECT COUNT(*) FROM expense_claims WHERE project_id=$1 AND deleted_at IS NULL
                  AND status NOT IN ('Paid','Closed','Manager Rejected','Accounts Rejected','Mgmt Rejected'))::int AS claims`,
      [projectId]
    ),
  ]);
  const blockers = [];
  if (travel.rows[0].trips > 0) blockers.push({ type: 'pending_travel', count: travel.rows[0].trips });
  if (travel.rows[0].claims > 0) blockers.push({ type: 'open_expense_claims', count: travel.rows[0].claims });
  if (openTasks.rows[0].n > 0) blockers.push({ type: 'open_tasks', count: openTasks.rows[0].n });
  if (unbilledMilestones.rows[0].n > 0) blockers.push({ type: 'unbilled_milestones', count: unbilledMilestones.rows[0].n });
  if (pendingTimesheets.rows[0].n > 0) blockers.push({ type: 'pending_timesheets', count: pendingTimesheets.rows[0].n });
  return blockers;
}
