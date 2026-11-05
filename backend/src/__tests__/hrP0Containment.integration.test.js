/**
 * HR P0 containment C1–C6 (HR_P0_REMEDIATION_DESIGN_2026-11-03.md, Appendix A).
 *
 *   C1  F&F auto-compute writes nothing; a manual compute is labelled provisional.
 *   C3  F&F approve and pay are refused (423) and change no row.
 *   C5  a policy acknowledgement is the caller's OWN employee record, in the
 *       caller's company — never an id from the body, never a users.id.
 *   C6  PATCH status → Left is refused; Offboarding Complete finalises only an
 *       exit whose F&F was paid.
 *   C2/C4  the read-only containment report finds leavers and live logins.
 *
 * Each switch is also tested OFF, proving the old behaviour comes back (the
 * reversal path). Real routers and database; two throwaway companies with
 * synthetic employees — all removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }           = await import('../config/db.js');
const { verifyToken }             = await import('../middlewares/auth.middleware.js');
const { buildApp }                = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: exitRoutes }     = await import('../modules/hr/exit.routes.js');
const { default: hrRoutes }       = await import('../modules/hr/hr.routes.js');
const { default: employeeRoutes } = await import('../employees/employee.routes.js');
const { runFnfAutoTriggerNow }    = await import('../jobs/fnfAutoTrigger.cron.js');
const { exitedActiveLogins, leaversInMonth } = await import('../../scripts/hr/containmentReport.js');

const app = buildApp(
  ['/api/exit', verifyToken, exitRoutes],
  ['/api/hr', verifyToken, hrRoutes],
  ['/api/employees', employeeRoutes],
);

const PREFIX = 'ZZHRP0';
let co, other, hr, emp, empOther, unlinked, crossLinked;
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

const SWITCHES = ['HR_CONTAINMENT_FNF', 'HR_CONTAINMENT_EXIT_STATUS'];
const saved = Object.fromEntries(SWITCHES.map(k => [k, process.env[k]]));
const restoreSwitches = () => {
  for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
};

async function addEmployee(company, code, status = 'Active') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date)
     VALUES ($1, $2, $2, 'Fixture', $3, '2024-04-01') RETURNING id`, [company.companyId, code, status]);
  return r.id;
}
const link = (u, employeeId) => pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [employeeId, u.userId]);

/** An employee on notice with an exit request; `fnf` is the request's F&F status. */
async function leaver(code, { fnf = 'draft', lwd = `CURRENT_DATE - 1`, netPayable = null } = {}) {
  const id = await addEmployee(co, code, 'Notice');
  const { rows: [er] } = await pool.query(
    `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, fnf_status, net_payable, reason, notice_period)
     VALUES ($1, 'resignation', ${lwd}, 'active', $2, $3, 'zz containment', 30) RETURNING id`, [id, fnf, netPayable]);
  return { emp: id, er: er.id };
}
const exitRow = async (id) => (await pool.query(`SELECT * FROM exit_requests WHERE id = $1`, [id])).rows[0];
const empRow  = async (id) => (await pool.query(`SELECT id, status, exit_date FROM employees WHERE id = $1`, [id])).rows[0];

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  await pool.query(`UPDATE users SET employee_id = NULL WHERE employee_id IN ${emps}`, [companyId]);
  for (const t of ['hr_policy_acknowledgements', 'exit_clearance', 'payroll_runs', 'hr_offboarding_checklist_progress']) {
    await pool.query(`DELETE FROM ${t} WHERE employee_id IN ${emps}`, [companyId]);
  }
  await pool.query(`DELETE FROM exit_interviews WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM exit_requests WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM hr_policies WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  hr = await addUser(pool, co, { label: 'hr', roleCode: 'hr_manager' });
  emp = await addUser(pool, co, { label: 'emp', roleCode: 'employee' });
  unlinked = await addUser(pool, co, { label: 'unlinked', roleCode: 'employee' });
  crossLinked = await addUser(pool, co, { label: 'cross', roleCode: 'employee' });
  // The employee's employees.id must differ from its users.id — the C5 bug only
  // shows when they differ (the register joins employees, the old code wrote users.id).
  E.self = await addEmployee(co, 'EMP001');
  while (E.self === emp.userId) E.self = await addEmployee(co, `EMP${String(E.self + 1).padStart(3, '0')}`);
  await link(emp, E.self);
  E.colleague = await addEmployee(co, 'EMP900');
  empOther = await addEmployee(other, 'EMP001');
  await link(crossLinked, empOther);
}, 60000);

afterEach(restoreSwitches);

afterAll(async () => {
  restoreSwitches();
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

// ── C1 ──────────────────────────────────────────────────────────────────────
describe('C1 — F&F figures are provisional and the cron writes nothing', () => {
  it('the auto-trigger cron skips while contained: the due exit keeps net_payable NULL', async () => {
    const s = await leaver('EMP101', { fnf: 'draft', netPayable: null });
    const result = await runFnfAutoTriggerNow();
    expect(result).toMatchObject({ skipped: true, reason: 'FNF_SETTLEMENT_SUSPENDED' });
    expect((await exitRow(s.er)).net_payable).toBeNull();
  });

  it('a manual compute is labelled provisional with settlement actions suspended', async () => {
    const s = await leaver('EMP102');
    const r = await call(hr, 'post', `/api/exit/fnf/compute/${s.emp}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provisional: true, settlement_actions_suspended: true });
    expect(r.body.containment_notice).toMatch(/provisional/i);
  });

  it('switched off, compute carries no containment labels (reversal)', async () => {
    process.env.HR_CONTAINMENT_FNF = 'off';
    const s = await leaver('EMP103');
    const r = await call(hr, 'post', `/api/exit/fnf/compute/${s.emp}`);
    expect(r.status).toBe(200);
    expect(r.body.provisional).toBeUndefined();
    expect(r.body.settlement_actions_suspended).toBeUndefined();
  });
});

// ── C3 ──────────────────────────────────────────────────────────────────────
describe('C3 — F&F approve and pay are suspended', () => {
  it('approve → 423 and the exit request is unchanged', async () => {
    const s = await leaver('EMP111', { fnf: 'draft', netPayable: 1000 });
    const before = await exitRow(s.er);
    const r = await call(hr, 'put', `/api/exit/fnf/${s.er}/approve`);
    expect(r.status).toBe(423);
    expect(r.body.code).toBe('FNF_SETTLEMENT_SUSPENDED');
    expect(await exitRow(s.er)).toEqual(before);
  });

  it('pay → 423; the exit stays open and the employee stays on notice', async () => {
    const s = await leaver('EMP112', { fnf: 'approved', netPayable: 1000 });
    const beforeExit = await exitRow(s.er);
    const beforeEmp = await empRow(s.emp);
    const r = await call(hr, 'post', `/api/exit/fnf/${s.er}/pay`);
    expect(r.status).toBe(423);
    expect(await exitRow(s.er)).toEqual(beforeExit);
    expect(await empRow(s.emp)).toEqual(beforeEmp);
  });

  it('a non-HR caller is still refused by the role gate first (403, not 423)', async () => {
    const s = await leaver('EMP113');
    expect((await call(emp, 'put', `/api/exit/fnf/${s.er}/approve`)).status).toBe(403);
    expect((await call(emp, 'post', `/api/exit/fnf/${s.er}/pay`)).status).toBe(403);
  });

  it('switched off, approve works again (reversal)', async () => {
    process.env.HR_CONTAINMENT_FNF = 'off';
    const s = await leaver('EMP114', { fnf: 'draft', netPayable: 1000 });
    const r = await call(hr, 'put', `/api/exit/fnf/${s.er}/approve`);
    expect(r.status).toBe(200);
    expect((await exitRow(s.er)).fnf_status).toBe('approved');
  });
});

// ── C5 ──────────────────────────────────────────────────────────────────────
describe('C5 — policy acknowledgement is the caller\'s own employee record', () => {
  let policy, retired, foreign;
  beforeAll(async () => {
    const add = async (company, title, active = true) => (await pool.query(
      `INSERT INTO hr_policies (company_id, title, category, is_active, requires_acknowledgement)
       VALUES ($1, $2, 'General', $3, true) RETURNING id`, [company.companyId, `${PREFIX} ${title}`, active])).rows[0].id;
    policy = await add(co, 'conduct');
    retired = await add(co, 'retired', false);
    foreign = await add(other, 'foreign');
  });
  const acks = async (policyId) =>
    (await pool.query(`SELECT employee_id FROM hr_policy_acknowledgements WHERE policy_id = $1 ORDER BY id`, [policyId])).rows;

  it('stores the caller\'s employees.id — not its users.id, not an id from the body', async () => {
    expect(E.self).not.toBe(emp.userId);
    const r = await call(emp, 'post', `/api/hr/policies/${policy}/acknowledge`).send({ employee_id: E.colleague });
    expect(r.status).toBe(200);
    expect(r.body.employee_id).toBe(E.self);
    expect(await acks(policy)).toEqual([{ employee_id: E.self }]);
  });

  it('my-acknowledgements reads the same employee record', async () => {
    const r = await call(emp, 'get', '/api/hr/policies/my-acknowledgements');
    expect(r.status).toBe(200);
    expect(r.body).toContain(policy);
  });

  it('a repeat acknowledgement keeps the first record', async () => {
    const r = await call(emp, 'post', `/api/hr/policies/${policy}/acknowledge`);
    expect(r.status).toBe(200);
    expect(r.body.already_acknowledged).toBe(true);
    expect(await acks(policy)).toHaveLength(1);
  });

  it('a login with no linked employee, or one linked to another company\'s employee, is refused', async () => {
    for (const who of [unlinked, crossLinked]) {
      const r = await call(who, 'post', `/api/hr/policies/${policy}/acknowledge`).send({ employee_id: E.colleague });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'No employee record is linked to this account' });
    }
    expect(await acks(policy)).toEqual([{ employee_id: E.self }]);
    expect((await call(unlinked, 'get', '/api/hr/policies/my-acknowledgements')).body).toEqual([]);
  });

  it('another company\'s policy is 404 and a retired policy is 409; neither writes', async () => {
    expect((await call(emp, 'post', `/api/hr/policies/${foreign}/acknowledge`)).status).toBe(404);
    expect((await call(emp, 'post', `/api/hr/policies/${retired}/acknowledge`)).status).toBe(409);
    expect(await acks(foreign)).toEqual([]);
    expect(await acks(retired)).toEqual([]);
  });
});

// ── C6 ──────────────────────────────────────────────────────────────────────
describe('C6 — an employee leaves only through the exit workflow', () => {
  it('PATCH status → Left is refused and the employee is unchanged', async () => {
    const id = await addEmployee(co, 'EMP121');
    const r = await call(hr, 'patch', `/api/employees/${id}/status`).send({ status: 'left' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('USE_EXIT_WORKFLOW');
    expect((await empRow(id)).status).toBe('Active');
  });

  it('PATCH status to a non-exit status still works', async () => {
    const id = await addEmployee(co, 'EMP122');
    const r = await call(hr, 'patch', `/api/employees/${id}/status`).send({ status: 'Notice' });
    expect(r.status).toBe(200);
    expect((await empRow(id)).status).toBe('Notice');
  });

  it('Offboarding Complete with no exit request → 409, nothing changes', async () => {
    const id = await addEmployee(co, 'EMP123');
    const r = await call(hr, 'post', `/api/hr/offboarding/${id}/complete`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EXIT_NOT_SETTLED');
    expect(await empRow(id)).toMatchObject({ status: 'Active', exit_date: null });
  });

  it('Offboarding Complete with F&F not paid → 409, exit and employee unchanged', async () => {
    const s = await leaver('EMP124', { fnf: 'approved', netPayable: 500 });
    const beforeExit = await exitRow(s.er);
    const r = await call(hr, 'post', `/api/hr/offboarding/${s.emp}/complete`);
    expect(r.status).toBe(409);
    expect(await exitRow(s.er)).toEqual(beforeExit);
    expect(await empRow(s.emp)).toMatchObject({ status: 'Notice', exit_date: null });
  });

  it('Offboarding Complete after F&F was paid still finalises', async () => {
    const s = await leaver('EMP125', { fnf: 'paid', netPayable: 500 });
    const r = await call(hr, 'post', `/api/hr/offboarding/${s.emp}/complete`);
    expect(r.status).toBe(200);
    expect((await empRow(s.emp)).status).toBe('Left');
  });

  it('another company\'s employee is still 404 (scope check runs first)', async () => {
    expect((await call(hr, 'post', `/api/hr/offboarding/${empOther}/complete`)).status).toBe(404);
  });

  it('switched off, both paths behave as before (reversal)', async () => {
    process.env.HR_CONTAINMENT_EXIT_STATUS = 'off';
    const id = await addEmployee(co, 'EMP126');
    expect((await call(hr, 'patch', `/api/employees/${id}/status`).send({ status: 'Left' })).status).toBe(200);
    const s = await leaver('EMP127', { fnf: 'draft' });
    expect((await call(hr, 'post', `/api/hr/offboarding/${s.emp}/complete`)).status).toBe(200);
    expect((await empRow(s.emp)).status).toBe('Left');
  });
});

// ── C6 / MD-14: Terminate, Edit Employee, create and delete ─────────────────
describe('C6 / MD-14 — PUT, POST and DELETE cannot end a current employment', () => {
  const full = async (id) => (await pool.query(`SELECT id, status, exit_date, exit_reason, deleted_at FROM employees WHERE id = $1`, [id])).rows[0];

  it('PUT status Left (the old Terminate call) → 409; the employee is unchanged', async () => {
    const id = await addEmployee(co, 'EMP141');
    const before = await full(id);
    const r = await call(hr, 'put', `/api/employees/${id}`).send({ status: 'Left', exit_date: '2026-11-03', exit_reason: 'Termination' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('USE_EXIT_WORKFLOW');
    expect(await full(id)).toEqual(before);
  });

  it('PUT status Left on someone serving notice → 409 (Notice is not an exit)', async () => {
    const s = await leaver('EMP142');
    expect((await call(hr, 'put', `/api/employees/${s.emp}`).send({ status: 'Left' })).status).toBe(409);
    expect((await full(s.emp)).status).toBe('Notice');
  });

  it('PUT on a record that has already Left still saves (editing an ex-employee)', async () => {
    const id = await addEmployee(co, 'EMP143', 'Left');
    const r = await call(hr, 'put', `/api/employees/${id}`).send({ status: 'Left', exit_reason: 'Better offer' });
    expect(r.status).toBe(200);
    expect(await full(id)).toMatchObject({ status: 'Left', exit_reason: 'Better offer' });
  });

  it('PUT without an exit status is not affected', async () => {
    const id = await addEmployee(co, 'EMP144');
    const r = await call(hr, 'put', `/api/employees/${id}`).send({ status: 'Notice' });
    expect(r.status).toBe(200);
    expect((await full(id)).status).toBe('Notice');
  });

  it('POST creating an employee as Left → 409 before anything is written', async () => {
    const count = async () => (await pool.query(`SELECT COUNT(*)::int n FROM employees WHERE company_id = $1`, [co.companyId])).rows[0].n;
    const before = await count();
    const r = await call(hr, 'post', '/api/employees').send({ first_name: 'Zz', last_name: 'Created', status: 'Left' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('USE_EXIT_WORKFLOW');
    expect(await count()).toBe(before);
  });

  it('POST with a current status reaches the normal create validation (not 409)', async () => {
    const r = await call(hr, 'post', '/api/employees').send({ first_name: 'Zz', status: 'Active' });
    expect(r.status).not.toBe(409);
  });

  it('DELETE (soft delete as terminated) of a current employee → 409; the row is untouched', async () => {
    const id = await addEmployee(co, 'EMP145');
    const r = await call(hr, 'delete', `/api/employees/${id}`);
    expect(r.status).toBe(409);
    expect(await full(id)).toMatchObject({ status: 'Active', deleted_at: null });
  });

  it('DELETE of an employee who has already Left is still allowed', async () => {
    const id = await addEmployee(co, 'EMP146', 'Left');
    expect((await call(hr, 'delete', `/api/employees/${id}`)).status).toBeLessThan(300);
    expect((await full(id)).deleted_at).not.toBeNull();
  });

  it('another company\'s employee gets the controller\'s own answer, not a leak via 409', async () => {
    const r = await call(hr, 'put', `/api/employees/${empOther}`).send({ status: 'Left' });
    expect(r.status).not.toBe(409);
    expect((await full(empOther)).status).toBe('Active');
  });

  it('a non-HR caller is refused by the role gate first (403)', async () => {
    const id = await addEmployee(co, 'EMP147');
    expect((await call(emp, 'put', `/api/employees/${id}`).send({ status: 'Left' })).status).toBe(403);
  });

  it('switched off, PUT status Left works again (reversal)', async () => {
    process.env.HR_CONTAINMENT_EXIT_STATUS = 'off';
    const id = await addEmployee(co, 'EMP148');
    expect((await call(hr, 'put', `/api/employees/${id}`).send({ status: 'Left', exit_date: '2026-11-03' })).status).toBe(200);
    expect((await full(id)).status).toBe('Left');
  });
});

// ── C2 / C4 report ──────────────────────────────────────────────────────────
describe('C2 / C4 — read-only containment report', () => {
  it('lists an exited employee whose login is still active, and flags use after the LWD', async () => {
    const id = await addEmployee(co, 'EMP131', 'Left');
    await pool.query(`INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, reason)
                      VALUES ($1, 'resignation', CURRENT_DATE - 30, 'active', 'zz')`, [id]);
    const login = await addUser(pool, co, { label: 'leftlogin', roleCode: 'employee' });
    await link(login, id);
    await pool.query(`UPDATE users SET last_login = NOW() - INTERVAL '2 days' WHERE id = $1`, [login.userId]);
    const rows = await exitedActiveLogins(pool, { companyId: co.companyId });
    expect(rows).toEqual([expect.objectContaining({ employee_id: id, user_id: login.userId, logged_in_after_lwd: true })]);
    expect(await exitedActiveLogins(pool, { companyId: other.companyId })).toEqual([]);
  });

  it('flags a leaver whose draft the next regeneration would delete', async () => {
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth() + 1;
    const id = await addEmployee(co, 'EMP132', 'Left');
    await pool.query(`UPDATE employees SET exit_date = make_date($2, $3, 1) WHERE id = $1`, [id, year, month]);
    await pool.query(`INSERT INTO payroll_runs (employee_id, month, year, status) VALUES ($1, $2, $3, 'draft')`, [id, month, year]);
    const rows = await leaversInMonth(pool, { year, month, companyId: co.companyId });
    expect(rows.find(r => r.employee_id === id)).toMatchObject({ run_status: 'draft', excluded_by_e2: true, draft_at_risk: true });
  });

  it('a leaver still on notice is not flagged', async () => {
    const now = new Date();
    const s = await leaver('EMP133', { lwd: `make_date(${now.getFullYear()}, ${now.getMonth() + 1}, 1)` });
    const rows = await leaversInMonth(pool, { year: now.getFullYear(), month: now.getMonth() + 1, companyId: co.companyId });
    expect(rows.find(r => r.employee_id === s.emp)).toMatchObject({ excluded_by_e2: false, draft_at_risk: false });
  });

  it('refuses a malformed month', async () => {
    await expect(leaversInMonth(pool, { year: 2026, month: 13 })).rejects.toThrow(/month/);
  });
});
