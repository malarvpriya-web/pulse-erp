/**
 * Reassign pending approvals away from inactive approvers. DRY RUN BY DEFAULT.
 *
 *   node scripts/security/reassign-stale-approvals.mjs           # show
 *   node scripts/security/reassign-stale-approvals.mjs --apply   # write
 *
 * Why this is a script and NOT a migration: which approvals are stale, and who
 * should inherit them, differs per environment. A migration would run against
 * production and silently reassign live approvals to whoever happened to match
 * — a data change disguised as a schema change.
 *
 * Background: approval authorization became ownership-based
 * (approvals.approver_id must match the caller, or an admin overrides). Any
 * approval assigned to a deactivated user is therefore actionable only by an
 * admin override — it looks like a bug to whoever tests approvals first, and is
 * actually stale data.
 *
 * Routing is by module so the workload lands with the right function rather
 * than dumping everything on an administrator, which would leave the approval
 * paths the pilot is meant to exercise untested.
 */
import pool from '../../src/config/db.js';

const APPLY = process.argv.includes('--apply');

/** module_name → role that should own it, most specific first. */
const ROUTING = {
  leave:    ['hr', 'hr_manager', 'admin', 'super_admin'],
  expense:  ['finance', 'finance_manager', 'admin', 'super_admin'],
  purchase: ['procurement_manager', 'finance', 'admin', 'super_admin'],
  _default: ['admin', 'super_admin'],
};

async function activeUserForRoles(roles) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, ARRAY_AGG(LOWER(r.code)) AS roles
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = true
      GROUP BY u.id, u.email`
  );
  // Preserve ROUTING order: first listed role that has a live holder wins.
  for (const want of roles) {
    const hit = rows.find(u => u.roles.includes(want));
    if (hit) return { ...hit, matched: want };
  }
  return null;
}

async function main() {
  console.log(`\n═══ REASSIGN STALE APPROVALS ${APPLY ? '(APPLYING)' : '(DRY RUN — pass --apply)'} ═══\n`);

  const { rows: stale } = await pool.query(
    `SELECT a.id, a.module_name, a.title, a.approver_id, u.email AS current_email, u.is_active
       FROM approvals a
       LEFT JOIN users u ON u.id = a.approver_id
      WHERE a.status = 'Pending'
        AND (u.id IS NULL OR u.is_active = false)
      ORDER BY a.id`
  );

  if (!stale.length) { console.log('  ✅ No pending approvals are assigned to an inactive user.\n'); await pool.end(); return; }

  let done = 0;
  for (const a of stale) {
    const target = await activeUserForRoles(ROUTING[a.module_name] || ROUTING._default);
    if (!target) {
      console.log(`  ❌ #${a.id} ${String(a.module_name).padEnd(9)} no active user holds a suitable role`);
      continue;
    }
    const from = a.current_email ? `${a.current_email} (inactive)` : `user ${a.approver_id} (missing)`;
    if (!APPLY) {
      console.log(`  → #${String(a.id).padEnd(3)} ${String(a.module_name).padEnd(9)} ${from}  ⇒  ${target.email} [${target.matched}]`);
      continue;
    }
    await pool.query('UPDATE approvals SET approver_id = $1 WHERE id = $2 AND status = $3', [target.id, a.id, 'Pending']);
    console.log(`  ✅ #${String(a.id).padEnd(3)} ${String(a.module_name).padEnd(9)} ⇒ ${target.email} [${target.matched}]`);
    done++;
  }

  console.log(APPLY ? `\n  Reassigned ${done} of ${stale.length}.\n`
                    : `\n  ${stale.length} would be reassigned. Nothing written — re-run with --apply.\n`);
  await pool.end();
}

main();
