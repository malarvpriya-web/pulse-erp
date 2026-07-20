/**
 * Re-point expense/purchase approvals off `admin` once a pilot Finance user exists.
 *
 *   node scripts/security/repoint-pilot-approvals.mjs           # show
 *   node scripts/security/repoint-pilot-approvals.mjs --apply   # write
 *
 * Companion to reassign-stale-approvals.mjs, which only reassigns approvals
 * whose current approver is INACTIVE. These expense/purchase approvals were
 * already reassigned once, to an ACTIVE admin — the correct fallback at the
 * time, because no active finance/procurement_manager user existed
 * (PHASE5_PILOT_PREP.md). That script's WHERE clause will never pick them up
 * again. This is the flagged one-off follow-up, run once after provisioning.
 *
 * Same routing priority as reassign-stale-approvals.mjs, restricted to the
 * two modules that fell through to admin for that specific reason. Leave
 * approvals are untouched — hr@manifest.in already owns them correctly.
 */
import pool from '../../src/config/db.js';

const APPLY = process.argv.includes('--apply');

const ROUTING = {
  expense:  ['finance', 'finance_manager', 'admin', 'super_admin'],
  purchase: ['procurement_manager', 'finance', 'admin', 'super_admin'],
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
  for (const want of roles) {
    const hit = rows.find(u => u.roles.includes(want));
    if (hit) return { ...hit, matched: want };
  }
  return null;
}

async function main() {
  console.log(`\n═══ RE-POINT PILOT EXPENSE/PURCHASE APPROVALS ${APPLY ? '(APPLYING)' : '(DRY RUN — pass --apply)'} ═══\n`);

  const { rows: targets } = await pool.query(
    `SELECT a.id, a.module_name, a.title, a.approver_id, u.email AS current_email
       FROM approvals a
       LEFT JOIN users u ON u.id = a.approver_id
      WHERE a.status = 'Pending' AND a.module_name IN ('expense', 'purchase')
      ORDER BY a.id`
  );

  if (!targets.length) { console.log('  Nothing pending in expense/purchase.\n'); await pool.end(); return; }

  let done = 0;
  for (const a of targets) {
    const target = await activeUserForRoles(ROUTING[a.module_name]);
    if (!target) {
      console.log(`  ❌ #${a.id} ${a.module_name.padEnd(8)} no active user holds a suitable role — left on ${a.current_email}`);
      continue;
    }
    if (target.email === a.current_email) {
      console.log(`  =  #${a.id} ${a.module_name.padEnd(8)} already on the best available approver (${target.email})`);
      continue;
    }
    if (!APPLY) {
      console.log(`  → #${a.id} ${a.module_name.padEnd(8)} ${a.current_email}  ⇒  ${target.email} [${target.matched}]`);
      continue;
    }
    await pool.query('UPDATE approvals SET approver_id = $1 WHERE id = $2 AND status = $3', [target.id, a.id, 'Pending']);
    console.log(`  ✅ #${a.id} ${a.module_name.padEnd(8)} ⇒ ${target.email} [${target.matched}]`);
    done++;
  }

  console.log(APPLY ? `\n  Reassigned ${done} of ${targets.length}.\n`
                    : `\n  Nothing written — re-run with --apply.\n`);
  await pool.end();
}

main();
