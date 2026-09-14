/**
 * 20260903000020_marketing_permission_module.js
 *
 * Adds the `marketing` module to role_permissions.
 *
 * WHY
 * ---
 * The CRM/Salesforce-parity audit (2026-09-03) probed /api/marketing with a
 * plain `employee` token and got 200 on all 34 routes, including
 * POST /campaigns and PUT /settings. The router was mounted as
 *
 *     v1Router.use("/marketing", verifyToken, marketingRoutes);
 *
 * and not one of its handlers carried requirePermission — campaign budgets,
 * spend, pursuit lists and every marketing timesheet were readable and
 * writable by anyone with a login.
 *
 * The gate cannot simply be added in code: requirePermission fails CLOSED when
 * no (role, module) row exists (see 20260719000001), and `marketing` has never
 * been a module in the matrix. Gating first would have locked out the very
 * roles that own the feature. So the rows land here, in the same migration
 * batch as the route change.
 *
 * GRANTS — mirrored from `crm`, which is the closest existing analogue (same
 * population, same records: campaigns feed leads). Marketing is run by the
 * sales organisation in this deployment; there is no separate marketing role in
 * `roles`, so sales_manager owns it and sales_exec operates it. `manager` gets
 * read + export because the marketing dashboards feed management review.
 * Everyone else gets an explicit all-false DENY row, which is the house pattern
 * — absence means "never configured", not "denied".
 *
 * ON CONFLICT DO NOTHING: only fills gaps, never overwrites a decision made in
 * the Page Access Control UI. Safe to re-run.
 */

// V=view A=add E=edit D=delete P=approve X=export
const G = (s = '') => ({
  can_view:    s.includes('V'),
  can_add:     s.includes('A'),
  can_edit:    s.includes('E'),
  can_delete:  s.includes('D'),
  can_approve: s.includes('P'),
  can_export:  s.includes('X'),
});

const FULL = 'VAEDPX';

const MARKETING_GRANTS = {
  super_admin:   FULL,
  admin:         FULL,
  sales_manager: FULL,
  sales_exec:    'VAEX',   // runs campaigns and logs timesheets; cannot delete or approve
  manager:       'VX',     // management review of campaign ROI
};

// NOTE: the migration runner passes a THIN PG SHIM, not knex — only .raw()
// with $1-style bindings.
export async function up(knex) {
  const { rows: roles } = await knex.raw('SELECT id, code FROM roles');

  const values = [];
  const params = [];
  let grants = 0, denies = 0;

  for (const role of roles) {
    const code = String(role.code).toLowerCase();
    const p = G(MARKETING_GRANTS[code] ?? '');
    p.can_view ? grants++ : denies++;

    const i = params.length;
    values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8})`);
    params.push(role.id, 'marketing', p.can_view, p.can_add, p.can_edit, p.can_delete, p.can_approve, p.can_export);
  }

  if (values.length) {
    await knex.raw(
      `INSERT INTO role_permissions
         (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
       VALUES ${values.join(',')}
       ON CONFLICT (role_id, module) DO NOTHING`,
      params
    );
  }
  console.log(`[marketing_permission_module] seeded ${values.length} pairs (${grants} with view, ${denies} explicit deny)`);
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = 'marketing'`);
}
