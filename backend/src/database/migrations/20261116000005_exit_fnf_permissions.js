/**
 * 20261116000005_exit_fnf_permissions.js — HR audit 2026-11-16, B4 (11-03 F-16).
 *
 * Exit Management decided access from two role lists in exit.routes.js read
 * from the single `req.user.role`: Roles Setup had no effect, and a user with a
 * second role was judged on the first one only. Two matrix modules replace them,
 * seeded to reproduce today's access exactly:
 *
 *   exit  view       super_admin, admin, hr, hr_manager, hr_exec, payroll_admin
 *         add/edit   super_admin, admin, hr, hr_manager, payroll_admin
 *   fnf   view       the exit viewers + finance_manager, finance, accounts_exec
 *                    (Finance reads settlement rules and settlements; approve
 *                    and pay keep payroll:approve / payroll_payment:approve)
 *
 * Every role gets a row (false where nothing is granted) so requirePermission
 * never meets an unconfigured module. ON CONFLICT DO NOTHING keeps an
 * administrator's later edits on a re-run.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const FLAG = { v: 'can_view', a: 'can_add', e: 'can_edit', d: 'can_delete', p: 'can_approve', x: 'can_export' };
const COLS = Object.values(FLAG);
export const GRANTS = {
  exit: {
    super_admin: 'vae', admin: 'vae', hr: 'vae', hr_manager: 'vae', payroll_admin: 'vae', hr_exec: 'v',
  },
  fnf: {
    super_admin: 'v', admin: 'v', hr: 'v', hr_manager: 'v', payroll_admin: 'v', hr_exec: 'v',
    finance_manager: 'v', finance: 'v', accounts_exec: 'v',
  },
};

export async function up(knex) {
  const { rows: roles } = await knex.raw(`SELECT id, LOWER(code) AS code FROM roles`);
  for (const [module, grants] of Object.entries(GRANTS)) {
    for (const role of roles) {
      const flags = grants[role.code] || '';
      const values = COLS.map(col => flags.includes(Object.keys(FLAG).find(k => FLAG[k] === col)));
      await knex.raw(
        `INSERT INTO role_permissions (role_id, module, ${COLS.join(', ')})
         VALUES ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')})
         ON CONFLICT (role_id, module) DO NOTHING`,
        [role.id, module, ...values]);
    }
  }
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module IN ('exit', 'fnf')`);
}
