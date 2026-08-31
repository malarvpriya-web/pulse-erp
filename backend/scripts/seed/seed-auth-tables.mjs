/**
 * Seeds the seven auth / page-access tables that seed-empty-tables.mjs refuses
 * to touch, using values that are **inert by construction**.
 *
 *   node scripts/seed/seed-auth-tables.mjs [--rows=5]
 *
 * The generic seeder skips these because a plausible-looking row here changes
 * real authentication or page-access behaviour and can lock live users out.
 * Every row below is instead chosen so that it cannot take effect, no matter
 * how the consuming code is written:
 *
 *   active_sessions       expires_at in the past  -> session already expired
 *   face_locked_accounts  locked_until in the past-> lock already lapsed
 *   ip_whitelist          active = false          -> never enforced
 *   password_reset_otps   used = true + expired   -> doubly spent
 *   revoked_tokens        revoked_at a year ago   -> predates every live token
 *   menu_permissions      access_level view/edit  -> a GRANT, never a denial
 *   user_menu_permissions access_level view/edit  -> a GRANT, never a denial
 *
 * The menu tables are the only ones where the reasoning is non-obvious, so:
 * AuthContext.menuAccess() returns 'hidden' | 'view' | 'edit' when a row exists
 * and **null (use defaults) when it does not**, and PermissionService merges
 * multiple roles most-permissive-first "so a second role never removes access".
 * Writing only view/edit therefore cannot hide a section that is visible today.
 * `super_admin` is never restricted at all. 'hidden' is never written here.
 *
 * Rolled back by unseed.mjs like everything else (run rebuild-manifest.mjs
 * --write afterwards to pick these rows up).
 */
import 'dotenv/config';
import crypto from 'crypto';
import { makePool } from './lib-schema.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const ROWS = Number(arg('rows', 5));

const pool = makePool();
const q = (s, p) => pool.query(s, p);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

// Real NAV group names — module_id is the sidebar group name (menuCatalog.js).
// 'Home' is ALWAYS_VISIBLE and 'Settings'/'User Management' are the
// self-service lock, so none of them are configurable sections; left out.
const MODULES = ['Reports', 'CRM', 'Sales', 'Projects', 'Procurement', 'Inventory',
  'Production', 'Quality', 'Finance', 'HR', 'Attendance', 'Leaves'];
const ROLE_CODES = ['manager', 'hr_manager', 'finance_manager', 'sales_manager', 'project_manager'];
const GRANTS = ['view', 'edit'];          // never 'hidden'

const results = [];
const note = (t, n, why) => { results.push({ table: t, rows: n, why }); console.log(`  [ok] ${t.padEnd(22)} ${n} row(s)  — ${why}`); };

const ids = async (sql) => (await q(sql)).rows.map(r => r.id);

try {
  const userIds = await ids(`select id from users where company_id = 1 order by id limit 10`);
  const empIds = await ids(`select id from employees where company_id = 1 and deleted_at is null order by id limit 10`);
  if (!userIds.length || !empIds.length) throw new Error('no company-1 users/employees to reference');

  // ── active_sessions — expired 30 days ago, token hash cannot match a real one
  let n = 0;
  for (let i = 0; i < ROWS; i++) {
    await q(`insert into active_sessions (user_id, token_hash, ip_address, user_agent, created_at, expires_at)
             values ($1,$2,$3,$4,$5,$6)`,
      [userIds[i % userIds.length], `SEED-${crypto.randomBytes(16).toString('hex')}`,
       `192.0.2.${10 + i}`, 'Mozilla/5.0 (SEED fixture)', daysAgo(31 + i), daysAgo(30 + i)]);
    n++;
  }
  note('active_sessions', n, 'expires_at in the past — already expired');

  // ── face_locked_accounts — lock lapsed a week ago, so nobody is locked out
  n = 0;
  for (let i = 0; i < Math.min(ROWS, empIds.length); i++) {
    await q(`insert into face_locked_accounts (company_id, employee_id, fail_count, locked_until, last_attempt)
             values (1,$1,$2,$3,$4)`,
      [empIds[i], 1 + (i % 3), daysAgo(7 + i), daysAgo(7 + i)]);
    n++;
  }
  note('face_locked_accounts', n, 'locked_until in the past — lock already lapsed');

  // ── ip_whitelist — inactive rows, and RFC 5737 TEST-NET addresses that never route
  n = 0;
  for (let i = 0; i < ROWS; i++) {
    await q(`insert into ip_whitelist (ip_address, label, active, added_by, created_at)
             values ($1,$2,false,$3,$4)`,
      [`192.0.2.${100 + i}`, `SEED documentation range (inactive) ${i + 1}`,
       userIds[i % userIds.length], daysAgo(10 + i)]);
    n++;
  }
  note('ip_whitelist', n, 'active = false — never enforced');

  // ── password_reset_otps — spent AND expired
  n = 0;
  for (let i = 0; i < ROWS; i++) {
    await q(`insert into password_reset_otps (user_id, otp, expires_at, used, created_at)
             values ($1,$2,$3,true,$4)`,
      [userIds[i % userIds.length], '000000',
       daysAgo(30 + i).slice(0, 19).replace('T', ' '), daysAgo(31 + i).slice(0, 19).replace('T', ' ')]);
    n++;
  }
  note('password_reset_otps', n, 'used = true and expired — doubly spent');

  // ── revoked_tokens — revoked a year ago, predating every token in circulation
  n = 0;
  for (let i = 0; i < ROWS; i++) {
    await q(`insert into revoked_tokens (user_id, revoked_at, revoked_by, reason)
             values ($1,$2,$3,$4)`,
      [userIds[i % userIds.length], daysAgo(365 + i), userIds[0], 'SEED fixture — historical revocation']);
    n++;
  }
  note('revoked_tokens', n, 'revoked_at a year ago — predates every live token');

  // ── menu_permissions — grants only
  n = 0;
  for (let i = 0; i < ROWS; i++) {
    const r = await q(`insert into menu_permissions (company_id, role_code, module_id, access_level, updated_by)
                       values (1,$1,$2,$3,$4)
                       on conflict (company_id, role_code, module_id) do nothing`,
      [ROLE_CODES[i % ROLE_CODES.length], MODULES[i % MODULES.length], GRANTS[i % GRANTS.length], userIds[0]]);
    n += r.rowCount;
  }
  note('menu_permissions', n, "access_level view/edit only — a grant, never a denial");

  // ── user_menu_permissions — grants only
  n = 0;
  for (let i = 0; i < ROWS; i++) {
    const r = await q(`insert into user_menu_permissions (company_id, user_id, module_id, access_level, updated_by)
                       values (1,$1,$2,$3,$4)
                       on conflict (company_id, user_id, module_id) do nothing`,
      [userIds[i % userIds.length], MODULES[(i + 3) % MODULES.length], GRANTS[i % GRANTS.length], userIds[0]]);
    n += r.rowCount;
  }
  note('user_menu_permissions', n, "access_level view/edit only — a grant, never a denial");

  console.log(`\nSeeded ${results.reduce((a, r) => a + r.rows, 0)} rows across ${results.length} tables.`);
  console.log('Run `node scripts/seed/rebuild-manifest.mjs --write` so unseed.mjs can roll these back.');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
