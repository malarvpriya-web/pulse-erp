// Exercises attendance.authz.js against the REAL database. Read-only: the guard
// helpers are called directly, so no route handler and no write is reached.
process.chdir('c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend');
// auth.middleware.js throws at import time if JWT_SECRET is unset, so load .env
// before touching anything that transitively imports it.
const dotenv = (await import('dotenv')).default;
dotenv.config({ quiet: true });
const A = await import('file:///c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend/src/modules/attendance/attendance.authz.js');
const { default: pool } = await import('file:///c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend/src/config/db.js');

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
  if (!ok) fails++;
};

const mkRes = () => { const r = {}; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; return r; };
const mw = async (m, user) => { const res = mkRes(); let p = false; await m({ user, params: {} }, res, () => { p = true; }); return p; };

const EMPLOYEE = { userId: 878, employee_id: 11, roles: ['employee'] };
const MANAGER  = { userId: 900, employee_id: 99, roles: ['manager'] };   // manages nobody
const HR       = { userId: 883, employee_id: null, roles: ['hr'] };      // unlinked, by design
const ADMIN    = { userId: 848, employee_id: null, roles: ['super_admin'] };
const MULTI    = { userId: 901, employee_id: 11, roles: ['employee', 'manager'] };

console.log('\n── role tiers ──');
check('employee blocked from ADMIN tier',    await mw(A.requireAttendanceAdmin,    EMPLOYEE), false);
check('employee blocked from APPROVER',      await mw(A.requireAttendanceApprover, EMPLOYEE), false);
check('employee blocked from OPERATOR',      await mw(A.requireAttendanceOperator, EMPLOYEE), false);
check('hr allowed ADMIN tier',               await mw(A.requireAttendanceAdmin,    HR),       true);
check('manager blocked from ADMIN tier',     await mw(A.requireAttendanceAdmin,    MANAGER),  false);
check('manager allowed APPROVER tier',       await mw(A.requireAttendanceApprover, MANAGER),  true);
check('multi-role employee+manager allowed', await mw(A.requireAttendanceApprover, MULTI),    true);

console.log('\n── assertCanDecideFor: approver role is NOT enough, must be the manager ──');
// These helpers take a REQUEST, not a user — wrap, or every call short-circuits
// on the `if (!req.user) return 401` branch and misleadingly reads as ALLOWED.
const rq = (user) => ({ user, params: {} });
// employee 1 exists and has manager_id NULL in org_relationships
const deny = async (u) => (await A.assertCanDecideFor(pool, rq(u), 1, 1, 'overtime'))?.body?.code ?? 'ALLOWED';
check('manager who manages nobody -> denied', await deny(MANAGER),  'NOT_YOUR_REPORT');
check('hr bypasses manager check',            await deny(HR),       'ALLOWED');
check('admin bypasses manager check',         await deny(ADMIN),    'ALLOWED');

console.log('\n── unlinked login fails CLOSED (was the bypass) ──');
// A manager IS in ATTENDANCE_OPERATOR, so for assertSelfOrPrivileged they are
// privileged and the employee-link requirement correctly does not apply to them.
// The link check governs NON-privileged callers, so test it with a plain employee.
const UNLINKED_MGR   = { userId: 555, employee_id: null, roles: ['manager'] };
const UNLINKED_PLAIN = { userId: 556, employee_id: null, roles: ['employee'] };
check('unlinked manager denied by decide-check', await deny(UNLINKED_MGR), 'EMPLOYEE_LINK_REQUIRED');
check('unlinked employee denied ownership',
  A.assertSelfOrPrivileged(rq(UNLINKED_PLAIN), 11)?.body?.code, 'EMPLOYEE_LINK_REQUIRED');

console.log('\n── assertSelfOrPrivileged ownership ──');
check('self allowed',        A.assertSelfOrPrivileged(rq(EMPLOYEE), 11), null);
check('other denied',        A.assertSelfOrPrivileged(rq(EMPLOYEE), 12)?.body?.code, 'NOT_YOUR_RECORD');
check('operator role allowed on other', A.assertSelfOrPrivileged(rq(HR), 12), null);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
await pool.end();
process.exit(fails ? 1 : 0);
