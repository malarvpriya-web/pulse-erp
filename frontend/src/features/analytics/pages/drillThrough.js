/**
 * Drill-through affordance shared by CEO Intelligence and its panels.
 *
 * Lives in its own module rather than in CEOIntelligenceDashboard.jsx because the
 * panels are imported BY that file — importing a helper back out of it would be a
 * cycle.
 *
 * Spread onto any row or card that navigates to a record:
 *
 *   <tr {...drillProps(() => onNavigate('Customer360', { party_id: id }), name)}>
 *
 * A bare `onClick` on a <div> or <tr> is invisible to the keyboard and to screen
 * readers, so this also sets role/tabIndex and handles Enter and Space. These rows
 * cannot be <button>s — a button may not wrap <td> elements — so the affordance has
 * to be applied by hand instead of inherited from the element.
 *
 * Returns an EMPTY object when `onGo` is falsy, so a panel rendered without a
 * navigation handler (or a row with no id) stays inert rather than showing a
 * pointer cursor that leads nowhere.
 */
export const drillProps = (onGo, label) => (!onGo ? {} : {
  onClick: onGo,
  onKeyDown: (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGo(); }
  },
  role: 'button',
  tabIndex: 0,
  title: label ? `Open ${label}` : 'Open record',
});

/**
 * Destination param keys, verified against each page on 2026-09-16. They are NOT
 * consistent and NOT guessable, so they are recorded here rather than inlined:
 *
 *   Customer360   `party_id` (uuid)   — Customer360.jsx   urlParams.get('party_id')
 *   Vendor360     `vendor`   (Number) — Vendor360.jsx     Number(params.get('vendor'))
 *   ProjectDetail `id`                — ProjectDetail.jsx urlParams?.id
 *
 * App.jsx's setPage(page, params) turns the object into the query string.
 */
export const toCustomer = (id) => ['Customer360', { party_id: String(id) }];
export const toVendor   = (id) => ['Vendor360',   { vendor:   String(id) }];
export const toProject  = (id) => ['ProjectDetail', { id:     String(id) }];
// AMCManagement reads `contract` and narrows its table to that row.
export const toAmc      = (id) => ['AMCManagement', { contract: String(id) }];

/**
 * Generic entity → destination, for rows that carry their own `entity_kind`
 * (strategic alerts, where one list mixes customers, vendors and projects).
 *
 * Returns null when the kind is unknown or the id is missing — an alert about an
 * AMC contract known only by product name resolves to no record, and must stay
 * inert rather than navigating somewhere arbitrary.
 */
export const toEntity = (kind, id) => {
  if (id == null || id === '') return null;
  switch (kind) {
    case 'customer': return toCustomer(id);
    case 'vendor':   return toVendor(id);
    case 'project':  return toProject(id);
    case 'amc':      return toAmc(id);
    default:         return null;
  }
};
