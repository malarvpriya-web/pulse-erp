/**
 * 20261029000004 — Succession: an explicit `succession` permission and
 * attributable assessment history. See MODULE_FEATURE_CONNECTION_MANUAL.md §209.
 *
 * 1. `succession` matrix module. Access used to be decided by two role lists in
 *    succession.routes.js read from the single `req.user.role`: a non-primary
 *    role was invisible, the live `hr` role was in NEITHER list (HR could not
 *    open the module), and `manager` / `department_head` could read every
 *    colleague's performance, potential and flight-risk ratings company-wide.
 *    Talent ratings are confidential, so only HR and administrators hold it by
 *    default; anyone else needs an explicit grant in Roles Setup.
 *
 *      view    grids, dashboard, alerts, reports      add     create
 *      edit    update, re-assess, reorder candidates  delete  remove
 *      export  CSV downloads
 *
 *    Every role gets a row (false where nothing is granted) so requirePermission
 *    never meets an unconfigured module. ON CONFLICT DO NOTHING: an
 *    administrator's later edits survive a re-run.
 *
 * 2. talent_assessment_history gains WHO changed an assessment, HOW, and WHICH
 *    assessment row. Edits and deletions wrote no history at all before; only a
 *    re-assessment through POST did. Nullable columns, no default backfill:
 *    the existing history rows are left exactly as they are (their action and
 *    actor were never recorded and are not guessed now).
 *
 * No employee, assessment or history row is modified.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() deletes the `succession` rows and drops the three columns.
 */
export const MODULE = 'succession';

// role code → 'vaedpx' flags. Absent = no access.
export const GRANTS = {
  super_admin: 'vaedx',
  admin:       'vaedx',
  hr:          'vaedx',
  hr_manager:  'vaedx',
};

const FLAG = { v: 'can_view', a: 'can_add', e: 'can_edit', d: 'can_delete', p: 'can_approve', x: 'can_export' };
const COLS = Object.values(FLAG);

export function rowFor(roleCode) {
  const flags = GRANTS[roleCode] || '';
  return Object.fromEntries(Object.entries(FLAG).map(([k, col]) => [col, flags.includes(k)]));
}

export async function up(knex) {
  const { rows: roles } = await knex.raw(`SELECT id, LOWER(code) AS code FROM roles`);
  for (const role of roles) {
    const r = rowFor(role.code);
    await knex.raw(
      `INSERT INTO role_permissions (role_id, module, ${COLS.join(', ')})
       VALUES ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (role_id, module) DO NOTHING`,
      [role.id, MODULE, ...COLS.map(c => r[c])],
    );
  }

  await knex.raw(`
    ALTER TABLE talent_assessment_history
      ADD COLUMN IF NOT EXISTS change_action      VARCHAR(30),
      ADD COLUMN IF NOT EXISTS changed_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS assessment_id      INTEGER`);
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = $1`, [MODULE]);
  await knex.raw(`
    ALTER TABLE talent_assessment_history
      DROP COLUMN IF EXISTS change_action,
      DROP COLUMN IF EXISTS changed_by_user_id,
      DROP COLUMN IF EXISTS assessment_id`);
}
