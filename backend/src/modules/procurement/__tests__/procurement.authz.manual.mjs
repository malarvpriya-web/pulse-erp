// Value-threshold authorization. Pure logic — no DB writes, no server needed.
process.chdir('c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend');
const dotenv = (await import('dotenv')).default;
dotenv.config({ quiet: true });
const P = await import('file:///c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend/src/modules/procurement/procurement.authz.js');

// Live values from procurement_settings (company 1).
const S = { auto_approve_below: 5000, l1_approval_limit: 25000, l2_approval_limit: 100000, cfo_approval_above: 500000 };

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
  if (!ok) fails++;
};
const rq = (...roles) => ({ user: { userId: 1, roles } });
const can = (roles, amt) => P.assertCanDecideAmount(rq(...roles), amt, S) === null;

console.log('\n── band boundaries ──');
check('4999  -> auto', P.requiredBand(4999, S),   'auto');
check('5000  -> auto (inclusive)', P.requiredBand(5000, S), 'auto');
check('5001  -> l1',   P.requiredBand(5001, S),   'l1');
check('25000 -> l1 (inclusive)', P.requiredBand(25000, S), 'l1');
check('25001 -> l2',   P.requiredBand(25001, S),  'l2');
check('100000-> l2 (inclusive)', P.requiredBand(100000, S), 'l2');
check('100001-> l3',   P.requiredBand(100001, S), 'l3');
check('500000-> l3 (inclusive)', P.requiredBand(500000, S), 'l3');
check('500001-> cfo',  P.requiredBand(500001, S), 'cfo');

console.log('\n── employee can never decide anything above auto ──');
check('employee, 1000 (auto)',  can(['employee'], 1000),  true);   // auto needs no authority
check('employee, 10000',        can(['employee'], 10000), false);
check('employee, 999999',       can(['employee'], 999999), false);

console.log('\n── level ladder ──');
check('manager L1, 10000',            can(['manager'], 10000), true);
check('manager L1, 50000 (needs L2)', can(['manager'], 50000), false);
check('procurement_manager, 50000',   can(['procurement_manager'], 50000), true);
check('procurement_manager, 200000 (needs L3)', can(['procurement_manager'], 200000), false);
check('finance, 200000',              can(['finance'], 200000), true);
check('finance, 900000 (needs L4)',   can(['finance'], 900000), false);
check('super_admin, 900000',          can(['super_admin'], 900000), true);

console.log('\n── multi-role takes the MAX, never the primary ──');
check('employee+procurement_manager, 50000', can(['employee','procurement_manager'], 50000), true);
check('employee+finance, 200000',            can(['employee','finance'], 200000), true);
check('order does not matter',               can(['finance','employee'], 200000), true);

console.log('\n── roles that previously scored 0 by omission ──');
check('finance_manager, 200000', can(['finance_manager'], 200000), true);
check('finance, 200000',         can(['finance'], 200000), true);

console.log('\n── roles the old map named but which do not exist ──');
check('cfo (nonexistent) has no authority',           can(['cfo'], 200000), false);
check('senior_manager (nonexistent) has no authority', can(['senior_manager'], 50000), false);

console.log('\n── unauthenticated ──');
check('no user -> 401', P.assertCanDecideAmount({}, 50000, S)?.status, 401);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
