/**
 * Pilot readiness — can each pilot role actually do its job?
 *
 * The pilot roster (HR, Finance, Production, Stores, Sales, 2 Service Engineers,
 * Management) maps almost entirely onto roles that have never had an active
 * user. The permission matrix for them was seeded by analogy in migration
 * 20260719000001 and has never been exercised by a real request. With
 * fail-closed authorization now the default, a wrong cell is a hard 403 on day
 * one rather than a silent pass.
 *
 * This evaluates the SAME role-level query `requirePermission` runs, for every
 * (role, module, action) a pilot user needs, and reports what they would get.
 * It does not need provisioned accounts, so it can be run before onboarding
 * anyone.
 *
 * A ❌ here is a person unable to work on their first morning.
 */
import pool from '../../src/config/db.js';

/** What each pilot participant must be able to do to get through a day. */
const EXPECTATIONS = {
  hr: {
    label: 'HR',
    need: [['hr','can_view'],['hr','can_edit'],['leaves','can_view'],['leaves','can_approve'],
           ['employees','can_view'],['employees','can_edit'],['attendance','can_view'],
           ['payroll','can_view'],['recruitment','can_view']],
  },
  finance: {
    label: 'Finance',
    need: [['finance','can_view'],['finance','can_add'],['finance','can_edit'],
           ['finance','can_approve'],['reports','can_view'],['reports','can_export'],
           ['approvals','can_view'],['approvals','can_approve']],
  },
  production_manager: {
    label: 'Production',
    need: [['production','can_view'],['production','can_add'],['production','can_edit'],
           ['production','can_approve'],['bom','can_view'],['inventory','can_view'],
           ['quality','can_view'],['maintenance','can_view'],['maintenance','can_edit']],
  },
  store_keeper: {
    label: 'Stores',
    need: [['inventory','can_view'],['inventory','can_add'],['inventory','can_edit'],
           ['procurement','can_view'],['assets','can_view'],['maintenance','can_view']],
  },
  sales_manager: {
    label: 'Sales',
    need: [['sales','can_view'],['sales','can_add'],['sales','can_edit'],['sales','can_approve'],
           ['crm','can_view'],['crm','can_add'],['crm','can_edit'],['reports','can_view']],
  },
  service_engineer: {
    label: 'Service Engineer',
    need: [['servicedesk','can_view'],['servicedesk','can_add'],['servicedesk','can_edit'],
           ['iot','can_view'],['maintenance','can_view'],['maintenance','can_edit'],
           ['inventory','can_view']],
  },
  manager: {
    label: 'Management',
    need: [['approvals','can_view'],['approvals','can_approve'],['dashboard','can_view'],
           ['reports','can_view'],['reports','can_export'],['projects','can_view'],
           ['attendance','can_view'],['leaves','can_approve']],
  },
};

// Mirrors requirePermission's role-level lookup, including the leave/leaves alias.
const ALIASES = { leave: ['leave','leaves'], leaves: ['leaves','leave'] };

async function can(role, module, action) {
  const mods = ALIASES[module] || [module];
  const { rows } = await pool.query(
    `SELECT BOOL_OR(rp.${action}) AS allowed
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
      WHERE LOWER(r.code) = $1 AND rp.module = ANY($2)`,
    [role, mods]
  );
  if (!rows.length || rows[0].allowed === null) return 'NO_ROW';  // fail-closed → 403
  return rows[0].allowed ? 'ALLOW' : 'DENY';
}

let blockers = 0, denies = 0, ok = 0;
console.log('\n═══ PILOT READINESS — permission matrix ═══');
console.log('ALLOW = works   DENY = explicitly refused   NO_ROW = 403 (never configured)\n');

for (const [role, spec] of Object.entries(EXPECTATIONS)) {
  const results = [];
  for (const [mod, act] of spec.need) {
    const r = await can(role, mod, act);
    results.push({ mod, act, r });
    if (r === 'ALLOW') ok++;
    else if (r === 'NO_ROW') blockers++;
    else denies++;
  }
  const bad = results.filter(x => x.r !== 'ALLOW');
  const status = bad.length === 0 ? '✅' : (bad.some(x => x.r === 'NO_ROW') ? '❌' : '⚠ ');
  console.log(`${status} ${spec.label.padEnd(18)} (${role})`);
  for (const b of bad) {
    console.log(`     ${b.r === 'NO_ROW' ? '❌ NO_ROW' : '⚠  DENY  '}  ${b.mod}.${b.act}`);
  }
}

console.log(`\n  ${ok} allowed · ${denies} explicitly denied · ${blockers} unconfigured (hard 403)`);
if (blockers) {
  console.log('\n  ❌ NOT PILOT READY — unconfigured permissions fail closed.');
  console.log('     Seed the (module, role) pairs above before onboarding anyone.');
}
await pool.end();
process.exit(blockers ? 1 : 0);
