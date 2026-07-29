// backend/src/modules/projects/projectStatus.js
//
// Was copy-pasted independently as `['completed','cancelled']` (or a
// locally-named const of the same literal) in 4 files that each needed to
// block writes against a closed project — projects.routes.js, timesheets
// .routes.js, project-members.routes.js, gantt.routes.js. Every copy stayed
// in sync so far, but nothing enforced that; a future status rename would
// need to be caught in all 4 places by hand.

export const CLOSED_PROJECT_STATUSES = ['completed', 'cancelled'];

export function isProjectClosed(status) {
  return CLOSED_PROJECT_STATUSES.includes(status);
}
