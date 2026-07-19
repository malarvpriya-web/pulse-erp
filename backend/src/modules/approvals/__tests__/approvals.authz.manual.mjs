// Exercise canActOnApproval against the REAL database, without mutating
// anything: the guard is invoked directly, so nothing reaches the controller.
// Approval id 1 is a real Pending row assigned to user 4 (role: manager).
process.chdir('c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend');
const { canActOnApproval, requireApproverRole } =
  await import('file:///c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend/src/modules/approvals/approvals.authz.js');
const { default: pool } =
  await import('file:///c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend/src/config/db.js');

const mkRes = () => {
  const r = { statusCode: null, body: null };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
};

async function probe(mw, user, params = {}) {
  const res = mkRes();
  let passed = false;
  await mw({ user, params }, res, () => { passed = true; });
  return { passed, status: res.statusCode, code: res.body?.code };
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
  if (!ok) fails++;
};

const EMPLOYEE = { userId: 878, roles: ['employee'] };
const OWNER    = { userId: 4,   roles: ['manager'] };       // owns approvals 1-6
const OTHER_MGR= { userId: 999, roles: ['sales_manager'] }; // approver role, owns nothing
const ADMIN    = { userId: 1,   roles: ['super_admin'] };

console.log('\n── single-item guard, approval id=1 (Pending, assigned to user 4) ──');
check('employee BLOCKED',              (await probe(canActOnApproval, EMPLOYEE,  { id: '1' })).passed, false);
check('  ...with 403',                 (await probe(canActOnApproval, EMPLOYEE,  { id: '1' })).status, 403);
check('designated approver ALLOWED',   (await probe(canActOnApproval, OWNER,     { id: '1' })).passed, true);
check('other approver BLOCKED',        (await probe(canActOnApproval, OTHER_MGR, { id: '1' })).passed, false);
check('super_admin override ALLOWED',  (await probe(canActOnApproval, ADMIN,     { id: '1' })).passed, true);

console.log('\n── source pseudo-id ("leave:123") — role-gated, no ownership ──');
check('employee BLOCKED',              (await probe(canActOnApproval, EMPLOYEE,  { id: 'leave:123' })).passed, false);
check('manager ALLOWED',               (await probe(canActOnApproval, OWNER,     { id: 'leave:123' })).passed, true);

console.log('\n── unknown id falls through to controller (no existence leak) ──');
check('employee still BLOCKED',        (await probe(canActOnApproval, EMPLOYEE,  { id: '99999999' })).passed, false);
check('manager falls through',         (await probe(canActOnApproval, OWNER,     { id: '99999999' })).passed, true);

console.log('\n── bulk guard (ids in body, no :id) ──');
check('employee BLOCKED',              (await probe(requireApproverRole, EMPLOYEE)).passed, false);
check('manager ALLOWED',               (await probe(requireApproverRole, OWNER)).passed, true);
check('sales_manager ALLOWED',         (await probe(requireApproverRole, OTHER_MGR)).passed, true);

console.log('\n── multi-role union (employee + manager must pass) ──');
check('employee+manager ALLOWED',      (await probe(canActOnApproval, { userId: 4, roles: ['employee','manager'] }, { id: '1' })).passed, true);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
await pool.end();
process.exit(fails ? 1 : 0);
