/**
 * integration.timesheetSecurity.test.js — every one of the 22 endpoints in
 * modules/timesheets/routes/timesheets.routes.js, against the REAL database and
 * the real router mounted the way server.js mounts it (both /api/timesheets and
 * the /api/projects alias). LEGACY_MIS_TO_PULSE_AUDIT.md Table 6 row 2, P0 Task 3.
 *
 * Pre-fix the router had no requirePermission at all; approve/reject wrote the
 * client-supplied `approved_by`; several reads took the employee from the query
 * string; the reports and summaries ignored the company.
 *
 * Policy under test (see the header of timesheets.routes.js):
 *  - OWN records (the employee linked to the login) are self-service: any
 *    authenticated user may read and log their own time, as My Timesheet already
 *    allows roles with no timesheets grant (menuCatalog FINANCE_SELF_SERVICE_PAGES).
 *  - OTHER people's records need the matrix: reading = timesheets:approve
 *    (the reviewer grant), writing = timesheets:edit/add + approve, deleting =
 *    timesheets:delete. Reports = approve or export.
 *  - Approve/reject need timesheets:approve, only move 'submitted' entries, never
 *    the approver's own, and only for their team unless they are admin/HR.
 *    The approver is always the logged-in user's employee.
 *  - Everything is limited to the caller's company. Rates (billing_rate,
 *    billable_amount) are not shown to non-reviewers.
 *
 * Self-cleaning: sweep() removes both synthetic companies and everything under them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }           = await import('../config/db.js');
const { verifyToken }             = await import('../middlewares/auth.middleware.js');
const { auditMutations }          = await import('../middlewares/auditMutations.js');
const { buildApp }                = await import('./helpers/testApp.js');
const { FIXTURE_CODE_SQL }        = await import('../shared/employeeCode.js');
const { default: timesheetRoutes } = await import('../modules/timesheets/routes/timesheets.routes.js');

// Both mounts from server.js.
const app = buildApp(
  ['/api/timesheets', verifyToken, auditMutations('timesheets'), timesheetRoutes],
  ['/api/projects',   verifyToken, auditMutations('projects'),   timesheetRoutes],
);

const TAG = `ZZTSS${Date.now().toString(36).toUpperCase()}`;
const CODES = [`${TAG}A`, `${TAG}B`];
const WEEK_START = '2031-03-03'; // a Monday nobody has real entries for
const WEEK_END   = '2031-03-09';
const DAY = (n) => `2031-03-0${3 + n}`;

const co = {}, emp = {}, u = {}, prj = {}, te = {};

const tokenFor = (key) => jwt.sign(
  { userId: u[key].id, company_id: u[key].company, employee_id: u[key].employee ?? null },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const as = (key) => `Bearer ${tokenFor(key)}`;

async function sweep() {
  // The one login with no company (not reachable through the company loop).
  const noCo = `(SELECT id FROM users WHERE company_id IS NULL AND email = '${TAG.toLowerCase()}.nocompany@test.invalid')`;
  await pool.query(`DELETE FROM user_roles WHERE user_id IN ${noCo}`, []);
  await pool.query(`DELETE FROM users WHERE id IN ${noCo}`, []);
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = ANY($1)`, [CODES]);
  for (const { id } of rows) {
    const users = `(SELECT id FROM users WHERE company_id = ${Number(id)})`;
    const emps  = `(SELECT id FROM employees WHERE company_id = ${Number(id)})`;
    const prjs  = `(SELECT id FROM projects WHERE company_id = ${Number(id)})`;
    await pool.query(`DELETE FROM timesheet_entries WHERE company_id = $1 OR employee_id IN ${emps} OR project_id IN ${prjs}`, [id]);
    await pool.query(`DELETE FROM timesheets WHERE company_id = $1 OR employee_id IN ${emps}`, [id]);
    await pool.query(`DELETE FROM tasks WHERE project_id IN ${prjs}`, []);
    await pool.query(`DELETE FROM project_members WHERE project_id IN ${prjs} OR employee_id IN ${emps}`, []);
    await pool.query(`DELETE FROM project_cost_summary WHERE project_id IN ${prjs}`, []).catch(() => {});
    await pool.query(`DELETE FROM projects WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM notifications WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM audit_logs WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM access_denials WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM user_roles WHERE user_id IN ${users}`, []);
    await pool.query(`DELETE FROM user_scope WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM users WHERE company_id = $1`, [id]);
    await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM employees WHERE company_id = $1`, [id]);
    // talent.routes.js seeds interview_questions into every company when it is
    // imported in the same worker; see integration.integrationsConfigSecurity.
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM companies WHERE id = $1`, [id]);
  }
}

async function makeCompany(code) {
  return (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${code} Co`, code])).rows[0].id;
}

async function makeEmployee(key, company, { department = 'Engineering', manager = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status, department, reporting_manager_id)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Tester', $2, 'Active', $3, $4) RETURNING id`,
    [`${TAG}${key}`, company, department, manager ? emp[manager] : null]);
  emp[key] = rows[0].id;
}

/** A login with exactly one real role, optionally linked to an employee. */
async function makeUser(key, company, roleCode, employeeKey = null) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, employee_id)
     VALUES ($1, $2, 'not-a-real-hash', $3, true, $4) RETURNING id`,
    [`${TAG} ${key}`, `${TAG.toLowerCase()}.${key}@test.invalid`, company, employeeKey ? emp[employeeKey] : null]);
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  if (!role.length) throw new Error(`role '${roleCode}' is missing from the matrix — this suite needs it`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [rows[0].id, role[0].id]);
  u[key] = { id: rows[0].id, company, employee: employeeKey ? emp[employeeKey] : null };
}

async function makeProject(key, company, { status = 'active', name } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO projects (project_code, project_name, company_id, status) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${TAG}-${key}`, name || `${TAG} ${key}`, company, status]);
  prj[key] = rows[0].id;
}

async function makeEntry(key, { employee, company, project = null, status = 'draft', day = 0, hours = 4 }) {
  const { rows } = await pool.query(
    `INSERT INTO timesheet_entries (employee_id, project_id, work_date, entry_date, hours_worked, description, is_billable,
                                    status, company_id, billable_amount, submitted_at)
     VALUES ($1, $2, $3::date, $3::date, $4, $5, true, $6::varchar, $7, 9999, CASE WHEN $6::varchar = 'submitted' THEN NOW() END) RETURNING *`,
    [emp[employee], project ? prj[project] : null, DAY(day), hours, `${TAG} ${key}`, status, company]);
  te[key] = rows[0];
}

const entry = async (key) => (await pool.query(`SELECT * FROM timesheet_entries WHERE id = $1`, [te[key].id])).rows[0];
const ids = (res) => (Array.isArray(res.body) ? res.body : []).map(r => r.id);

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(CODES[0]);
  co.B = await makeCompany(CODES[1]);

  await makeEmployee('mgrA', co.A);
  await makeEmployee('emp1A', co.A, { manager: 'mgrA' });
  await makeEmployee('emp2A', co.A);
  await makeEmployee('salesA', co.A);
  await makeEmployee('mgrB', co.B, { department: 'Marketing' });
  await makeEmployee('empB', co.B, { department: 'Marketing', manager: 'mgrB' });

  await makeUser('adminA', co.A, 'admin');                // reviewer, no employee link
  await makeUser('mgrA',   co.A, 'manager', 'mgrA');      // timesheets view/add/edit/approve
  await makeUser('emp1A',  co.A, 'employee', 'emp1A');    // view/add/edit, no approve
  await makeUser('emp2A',  co.A, 'employee', 'emp2A');
  await makeUser('salesA', co.A, 'sales_exec', 'salesA'); // NO timesheets grant at all
  await makeUser('adminB', co.B, 'admin');
  await makeUser('mgrB',   co.B, 'manager', 'mgrB');
  await makeUser('nocompany', null, 'employee');

  await makeProject('projA', co.A);
  await makeProject('closedA', co.A, { status: 'completed' });
  await makeProject('projB', co.B, { name: `${TAG} Marketing B` });
  await pool.query(
    `INSERT INTO project_members (project_id, employee_id, company_id, role_in_project, billing_rate)
     VALUES ($1,$2,$3,'Engineer',4321), ($4,$2,$5,'Engineer',4321)`,
    [prj.projA, emp.emp1A, co.A, prj.projB, co.B]);
  await pool.query(
    `INSERT INTO tasks (project_id, task_title, status, priority, assigned_to)
     VALUES ($1, $2, 'todo', 'medium', $3)`, [prj.projB, `${TAG} B marketing task`, emp.empB]);
  await pool.query(
    `INSERT INTO timesheets (employee_id, week_start, week_end, status, total_hours, company_id)
     VALUES ($1, $2, $3, 'submitted', 8, $4)`, [emp.empB, WEEK_START, WEEK_END, co.B]);

  await makeEntry('own1Draft',     { employee: 'emp1A', company: co.A, project: 'projA', day: 0 });
  await makeEntry('own1Draft2',    { employee: 'emp1A', company: co.A, project: 'projA', day: 1 });
  await makeEntry('own1Submitted', { employee: 'emp1A', company: co.A, project: 'projA', status: 'submitted', day: 2 });
  await makeEntry('own1Submitted2', { employee: 'emp1A', company: co.A, project: 'projA', status: 'submitted', day: 3 });
  await makeEntry('own1Approved',  { employee: 'emp1A', company: co.A, project: 'projA', status: 'approved', day: 4 });
  await makeEntry('emp2Draft',     { employee: 'emp2A', company: co.A, day: 0 });
  await makeEntry('emp2Submitted', { employee: 'emp2A', company: co.A, status: 'submitted', day: 1 });
  await makeEntry('mgrSubmitted',  { employee: 'mgrA',  company: co.A, status: 'submitted', day: 1 });
  await makeEntry('bSubmitted',    { employee: 'empB',  company: co.B, project: 'projB', status: 'submitted', day: 1 });
  await makeEntry('bDraft',        { employee: 'empB',  company: co.B, day: 2 });
}, 60_000);

// Never pool.end(): the pool is shared across this worker's suites.
afterAll(async () => { await sweep(); }, 60_000);

// ── Authentication (all 22, both mounts) ────────────────────────────────────
const ENDPOINTS = [
  ['get',    '/timesheets/timesheets'],
  ['get',    '/timesheets/timesheets/my-timesheet'],
  ['get',    '/timesheets/timesheets/all'],
  ['get',    '/timesheets/timesheets/approvals'],
  ['get',    '/timesheets/timesheets/weekly-summary'],
  ['get',    '/timesheets/timesheets/weekly-report?week_start=2031-03-03'],
  ['get',    '/timesheets/timesheets/1'],
  ['post',   '/timesheets/timesheets'],
  ['put',    '/timesheets/timesheets/1'],
  ['delete', '/timesheets/timesheets/1'],
  ['post',   '/timesheets/timesheets/submit-week'],
  ['post',   '/timesheets/timesheets/clock-in'],
  ['post',   '/timesheets/timesheets/clock-out'],
  ['post',   '/timesheets/timesheets/approve'],
  ['post',   '/timesheets/timesheets/reject'],
  ['get',    '/timesheets/timesheets/summary/weekly'],
  ['get',    '/timesheets/timesheets/utilization/1'],
  ['get',    '/timesheets/timesheets/pending-approvals/1'],
  ['get',    '/timesheets/utilization'],
  ['get',    '/timesheets/weekly-report?week_start=2031-03-03'],
  ['get',    '/timesheets/assign-tasks'],
  ['get',    '/timesheets/marketing-entry'],
];

describe('authentication', () => {
  it('lists exactly 22 endpoints', () => expect(ENDPOINTS).toHaveLength(22));
  for (const [method, path] of ENDPOINTS) {
    it(`401 without a token: ${method.toUpperCase()} /api${path}`, async () => {
      const res = await request(app)[method](`/api${path}`).send({});
      expect(res.status).toBe(401);
    });
    it(`401 without a token on the /api/projects alias: ${method.toUpperCase()} ${path.replace(/^\/timesheets/, '')}`, async () => {
      const res = await request(app)[method](`/api/projects${path.replace(/^\/timesheets/, '')}`).send({});
      expect(res.status).toBe(401);
    });
  }
});

// ── 1. GET /timesheets ──────────────────────────────────────────────────────
describe('1. GET /timesheets/timesheets', () => {
  const url = '/api/timesheets/timesheets';
  it("a non-reviewer cannot read a colleague's entries by passing employee_id", async () => {
    const res = await request(app).get(url).query({ employee_id: emp.emp2A }).set('Authorization', as('emp1A'));
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(te.emp2Draft.id);
    expect(res.body.every(r => r.employee_id === emp.emp1A)).toBe(true);
  });
  it('a non-reviewer sees their own entries without rate fields', async () => {
    const res = await request(app).get(url).set('Authorization', as('emp1A'));
    expect(ids(res)).toContain(te.own1Draft.id);
    expect(res.body.every(r => !('billable_amount' in r))).toBe(true);
  });
  it('a user with no timesheets grant still gets their own (self-service), and nobody else', async () => {
    const res = await request(app).get(url).set('Authorization', as('salesA'));
    expect(res.status).toBe(200);
    expect(res.body.every(r => r.employee_id === emp.salesA)).toBe(true);
  });
  it('a reviewer sees the company, never another company', async () => {
    const res = await request(app).get(url).set('Authorization', as('mgrA'));
    expect(ids(res)).toEqual(expect.arrayContaining([te.emp2Draft.id, te.own1Draft.id]));
    expect(ids(res)).not.toContain(te.bSubmitted.id);
  });
  it("a token without the employee claim still resolves the login's own employee, nobody else", async () => {
    const res = await request(app).get(url).set('Authorization', `Bearer ${jwt.sign({ userId: u.salesA.id, company_id: co.A }, process.env.JWT_SECRET)}`);
    expect(res.status).toBe(200);
    expect(res.body.every(r => r.employee_id === emp.salesA)).toBe(true);
  });
});

// ── 2. GET /timesheets/my-timesheet ─────────────────────────────────────────
describe('2. GET /timesheets/timesheets/my-timesheet', () => {
  it("lists only the caller's own company's projects, without billing rates", async () => {
    const res = await request(app).get('/api/timesheets/timesheets/my-timesheet')
      .query({ week_start: WEEK_START, week_end: WEEK_END }).set('Authorization', as('emp1A'));
    expect(res.status).toBe(200);
    const pids = res.body.projects.map(p => p.id);
    expect(pids).toContain(prj.projA);
    expect(pids).not.toContain(prj.projB);
    expect(res.body.projects.every(p => !('billing_rate' in p))).toBe(true);
    expect(res.body.entries.every(e => e.employee_id === emp.emp1A)).toBe(true);
  });
});

// ── 3. GET /timesheets/all ──────────────────────────────────────────────────
describe('3. GET /timesheets/timesheets/all', () => {
  it("a non-reviewer cannot read a colleague's entries via ?employee_id", async () => {
    const res = await request(app).get('/api/timesheets/timesheets/all').query({ employee_id: emp.emp2A }).set('Authorization', as('emp1A'));
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(te.emp2Draft.id);
  });
  it('a reviewer (role from the database, not the token) sees the company only', async () => {
    const res = await request(app).get('/api/timesheets/timesheets/all').set('Authorization', as('mgrA'));
    expect(ids(res)).toEqual(expect.arrayContaining([te.emp2Draft.id, te.own1Draft.id]));
    expect(ids(res)).not.toContain(te.bDraft.id);
  });
});

// ── 4. GET /timesheets/approvals ────────────────────────────────────────────
describe('4. GET /timesheets/timesheets/approvals', () => {
  it('is refused without timesheets:approve', async () => {
    const res = await request(app).get('/api/timesheets/timesheets/approvals').set('Authorization', as('emp1A'));
    expect(res.status).toBe(403);
  });
  it("shows a manager their team's submitted entries only", async () => {
    const res = await request(app).get('/api/timesheets/timesheets/approvals').set('Authorization', as('mgrA'));
    expect(res.status).toBe(200);
    expect(ids(res)).toContain(te.own1Submitted.id);
    expect(ids(res)).not.toContain(te.emp2Submitted.id);
    expect(ids(res)).not.toContain(te.bSubmitted.id);
  });
  it("shows an admin every submitted entry of the company, never another company's", async () => {
    const res = await request(app).get('/api/timesheets/timesheets/approvals').set('Authorization', as('adminA'));
    expect(ids(res)).toEqual(expect.arrayContaining([te.own1Submitted.id, te.emp2Submitted.id]));
    expect(ids(res)).not.toContain(te.bSubmitted.id);
  });
});

// ── 5 + 16. weekly summaries ────────────────────────────────────────────────
for (const [n, path] of [[5, 'weekly-summary'], [16, 'summary/weekly']]) {
  describe(`${n}. GET /timesheets/timesheets/${path}`, () => {
    const url = `/api/timesheets/timesheets/${path}`;
    it("refuses another company's employee", async () => {
      const res = await request(app).get(url).query({ employee_id: emp.empB, week_start: WEEK_START, week_end: WEEK_END }).set('Authorization', as('adminA'));
      expect(res.status === 404 || (res.status === 200 && res.body.length === 0)).toBe(true);
    });
    it("refuses a colleague's summary to a non-reviewer", async () => {
      const res = await request(app).get(url).query({ employee_id: emp.emp2A, week_start: WEEK_START, week_end: WEEK_END }).set('Authorization', as('emp1A'));
      expect(res.status).toBe(403);
    });
    it('returns the caller their own summary', async () => {
      const res = await request(app).get(url).query({ employee_id: emp.emp1A, week_start: WEEK_START, week_end: WEEK_END }).set('Authorization', as('emp1A'));
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });
}

// ── 6 + 20. weekly reports ──────────────────────────────────────────────────
for (const [n, path] of [[6, '/api/timesheets/timesheets/weekly-report'], [20, '/api/timesheets/weekly-report']]) {
  describe(`${n}. GET ${path}`, () => {
    it('is refused without a reviewer or export grant', async () => {
      const res = await request(app).get(path).query({ week_start: WEEK_START }).set('Authorization', as('emp1A'));
      expect(res.status).toBe(403);
    });
    it("never includes another company's employees", async () => {
      const res = await request(app).get(path).query({ week_start: WEEK_START }).set('Authorization', as('adminA'));
      expect(res.status).toBe(200);
      const names = [...res.body.employees.map(e => e.name), ...res.body.missing.map(e => e.name)].join('|');
      expect(names).toContain(`${TAG}emp1A`);
      expect(names).not.toContain(`${TAG}empB`);
      expect(names).not.toContain(`${TAG}mgrB`);
    });
  });
}

// ── 7. GET /timesheets/:id ──────────────────────────────────────────────────
describe('7. GET /timesheets/timesheets/:id', () => {
  it("404 for a colleague's entry to a non-reviewer", async () => {
    const res = await request(app).get(`/api/timesheets/timesheets/${te.emp2Draft.id}`).set('Authorization', as('emp1A'));
    expect(res.status).toBe(404);
  });
  it("404 for another company's entry", async () => {
    const res = await request(app).get(`/api/timesheets/timesheets/${te.bDraft.id}`).set('Authorization', as('adminA'));
    expect(res.status).toBe(404);
  });
  it('the owner gets their entry, without billable_amount', async () => {
    const res = await request(app).get(`/api/timesheets/timesheets/${te.own1Draft.id}`).set('Authorization', as('emp1A'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(te.own1Draft.id);
    expect('billable_amount' in res.body).toBe(false);
  });
  it('a reviewer gets a colleague entry with its amount', async () => {
    const res = await request(app).get(`/api/timesheets/timesheets/${te.emp2Draft.id}`).set('Authorization', as('mgrA'));
    expect(res.status).toBe(200);
    expect(Number(res.body.billable_amount)).toBe(9999);
  });
});

// ── 8. POST /timesheets ─────────────────────────────────────────────────────
describe('8. POST /timesheets/timesheets', () => {
  const post = (who, body) => request(app).post('/api/timesheets/timesheets').set('Authorization', as(who))
    .send({ work_date: DAY(5), hours_worked: 2, description: `${TAG} posted`, is_billable: true, ...body });

  it('a non-reviewer cannot log time for someone else', async () => {
    const res = await post('emp1A', { employee_id: emp.emp2A });
    expect(res.status).toBe(403);
  });
  it('cannot log time for another company employee', async () => {
    const res = await post('adminA', { employee_id: emp.empB });
    expect(res.status).toBe(400);
  });
  it("cannot log time against another company's project", async () => {
    const res = await post('emp1A', { employee_id: emp.emp1A, project_id: prj.projB });
    expect(res.status).toBe(400);
  });
  it('cannot create an entry already approved', async () => {
    const res = await post('emp1A', { employee_id: emp.emp1A, project_id: prj.projA, status: 'approved', approved_by: emp.mgrA });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.approved_by).toBeNull();
  });
  it('still blocks a closed project', async () => {
    const res = await post('emp1A', { employee_id: emp.emp1A, project_id: prj.closedA });
    expect(res.status).toBe(400);
  });
  it('logs own time as a draft in the caller company', async () => {
    const res = await post('emp1A', { employee_id: emp.emp1A, project_id: prj.projA });
    expect(res.status).toBe(201);
    expect(res.body.company_id).toBe(co.A);
    expect(res.body.employee_id).toBe(emp.emp1A);
  });
  it('a user with no timesheets grant can log their own time (self-service)', async () => {
    const res = await post('salesA', {});
    expect(res.status).toBe(201);
    expect(res.body.employee_id).toBe(emp.salesA);
  });
  it('a manager may log time for a team member', async () => {
    const res = await post('mgrA', { employee_id: emp.emp1A, project_id: prj.projA });
    expect(res.status).toBe(201);
    expect(res.body.employee_id).toBe(emp.emp1A);
  });
});

// ── 9. PUT /timesheets/:id ──────────────────────────────────────────────────
describe('9. PUT /timesheets/timesheets/:id', () => {
  const put = (who, key, body) => request(app).put(`/api/timesheets/timesheets/${te[key].id}`).set('Authorization', as(who)).send(body);

  it("404 for a colleague's entry", async () => {
    const res = await put('emp1A', 'emp2Draft', { hours_worked: 9 });
    expect(res.status).toBe(404);
    expect(Number((await entry('emp2Draft')).hours_worked)).toBe(4);
  });
  it("404 for another company's entry", async () => {
    const res = await put('adminA', 'bDraft', { hours_worked: 9 });
    expect(res.status).toBe(404);
  });
  it('the owner cannot approve their own entry through PUT', async () => {
    const res = await put('emp1A', 'own1Draft2', { status: 'approved', approved_by: emp.emp1A });
    expect(res.status).toBe(400);
    expect((await entry('own1Draft2')).status).toBe('draft');
  });
  it('an approved entry cannot be changed', async () => {
    const res = await put('emp1A', 'own1Approved', { hours_worked: 12 });
    expect(res.status).toBe(409);
    expect(Number((await entry('own1Approved')).hours_worked)).toBe(4);
  });
  it('cannot move an entry to another company or employee', async () => {
    const res = await put('emp1A', 'own1Draft2', { company_id: co.B, employee_id: emp.emp2A, hours_worked: 5 });
    expect(res.status).toBe(200);
    const after = await entry('own1Draft2');
    expect(after.company_id).toBe(co.A);
    expect(after.employee_id).toBe(emp.emp1A);
    expect(Number(after.hours_worked)).toBe(5);
  });
});

// ── 10. DELETE /timesheets/:id ──────────────────────────────────────────────
describe('10. DELETE /timesheets/timesheets/:id', () => {
  it("404 for a colleague's entry", async () => {
    const res = await request(app).delete(`/api/timesheets/timesheets/${te.emp2Draft.id}`).set('Authorization', as('emp1A'));
    expect(res.status).toBe(404);
    expect((await entry('emp2Draft')).deleted_at).toBeNull();
  });
  it("404 for another company's entry", async () => {
    const res = await request(app).delete(`/api/timesheets/timesheets/${te.bDraft.id}`).set('Authorization', as('adminA'));
    expect(res.status).toBe(404);
    expect((await entry('bDraft')).deleted_at).toBeNull();
  });
  it('the owner cannot delete an approved entry', async () => {
    const res = await request(app).delete(`/api/timesheets/timesheets/${te.own1Approved.id}`).set('Authorization', as('emp1A'));
    expect(res.status).toBe(403);
    expect((await entry('own1Approved')).deleted_at).toBeNull();
  });
  it('the owner can delete their own draft', async () => {
    const res = await request(app).delete(`/api/timesheets/timesheets/${te.own1Draft.id}`).set('Authorization', as('emp1A'));
    expect(res.status).toBe(200);
    expect((await entry('own1Draft')).deleted_at).not.toBeNull();
  });
});

// ── 11. POST /timesheets/submit-week ────────────────────────────────────────
describe('11. POST /timesheets/timesheets/submit-week', () => {
  it("a non-reviewer cannot submit a colleague's week", async () => {
    const res = await request(app).post('/api/timesheets/timesheets/submit-week').set('Authorization', as('emp1A'))
      .send({ employee_id: emp.emp2A, week_start: WEEK_START, week_end: WEEK_END });
    expect(res.status).toBe(403);
    expect((await entry('emp2Draft')).status).toBe('draft');
  });
  it("cannot submit another company's employee", async () => {
    const res = await request(app).post('/api/timesheets/timesheets/submit-week').set('Authorization', as('adminA'))
      .send({ employee_id: emp.empB, week_start: WEEK_START, week_end: WEEK_END });
    expect([400, 403, 404]).toContain(res.status);
    expect((await entry('bDraft')).status).toBe('draft');
  });
});

// ── 12 + 13. clock-in / clock-out ───────────────────────────────────────────
describe('12. POST /timesheets/timesheets/clock-in', () => {
  it('cannot clock in someone else', async () => {
    const res = await request(app).post('/api/timesheets/timesheets/clock-in').set('Authorization', as('emp1A')).send({ employee_id: emp.emp2A });
    expect(res.status).toBe(403);
  });
  it('clocks in the caller', async () => {
    const res = await request(app).post('/api/timesheets/timesheets/clock-in').set('Authorization', as('emp1A')).send({ employee_id: emp.emp1A });
    expect(res.status).toBe(200);
    expect(res.body.employee_id).toBe(emp.emp1A);
  });
});

describe('13. POST /timesheets/timesheets/clock-out', () => {
  const clockOut = (who, body) => request(app).post('/api/timesheets/timesheets/clock-out').set('Authorization', as(who)).send({
    clock_in_timestamp: new Date(Date.now() - 2 * 3600e3).toISOString(), timestamp: new Date().toISOString(), ...body });
  it('cannot clock out someone else (no entry created for them)', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM timesheet_entries WHERE employee_id=$1`, [emp.emp2A])).rows[0].n;
    const res = await clockOut('emp1A', { employee_id: emp.emp2A });
    expect(res.status).toBe(403);
    const after = (await pool.query(`SELECT COUNT(*)::int n FROM timesheet_entries WHERE employee_id=$1`, [emp.emp2A])).rows[0].n;
    expect(after).toBe(before);
  });
  it("cannot book the time to another company's project", async () => {
    const res = await clockOut('emp1A', { employee_id: emp.emp1A, project_id: prj.projB });
    expect(res.status).toBe(400);
  });
  it("creates the caller's own draft", async () => {
    const res = await clockOut('emp1A', { employee_id: emp.emp1A, project_id: prj.projA });
    expect(res.status).toBe(200);
    expect(res.body.entry.employee_id).toBe(emp.emp1A);
    expect(res.body.entry.status).toBe('draft');
  });
});

// ── 14. POST /timesheets/approve ────────────────────────────────────────────
describe('14. POST /timesheets/timesheets/approve', () => {
  const approve = (who, keys, extra = {}) => request(app).post('/api/timesheets/timesheets/approve')
    .set('Authorization', as(who)).send({ ids: keys.map(k => te[k].id), ...extra });

  it('is refused without timesheets:approve', async () => {
    const res = await approve('emp1A', ['own1Submitted']);
    expect(res.status).toBe(403);
    expect((await entry('own1Submitted')).status).toBe('submitted');
  });
  it('refuses self-approval', async () => {
    const res = await approve('mgrA', ['mgrSubmitted']);
    expect(res.status).toBe(403);
    expect((await entry('mgrSubmitted')).status).toBe('submitted');
  });
  it("refuses a manager approving outside their team", async () => {
    const res = await approve('mgrA', ['emp2Submitted']);
    expect(res.status).toBe(403);
    expect((await entry('emp2Submitted')).status).toBe('submitted');
  });
  it("404 for another company's entry, left untouched", async () => {
    const res = await approve('adminA', ['bSubmitted']);
    expect(res.status).toBe(404);
    expect((await entry('bSubmitted')).status).toBe('submitted');
  });
  it('only submitted entries can be approved', async () => {
    const res = await approve('mgrA', ['own1Draft2']);
    expect(res.status).toBe(409);
    expect((await entry('own1Draft2')).status).toBe('draft');
  });
  it('records the logged-in approver, ignoring a client-supplied approved_by', async () => {
    const res = await approve('mgrA', ['own1Submitted'], { approved_by: emp.emp2A });
    expect(res.status).toBe(200);
    const after = await entry('own1Submitted');
    expect(after.status).toBe('approved');
    expect(after.approved_by).toBe(emp.mgrA);
    expect(after.approved_at).not.toBeNull();
  });
  it('an admin may approve anyone in the company', async () => {
    const res = await approve('adminA', ['emp2Submitted']);
    expect(res.status).toBe(200);
    expect((await entry('emp2Submitted')).status).toBe('approved');
  });
});

// ── 15. POST /timesheets/reject ─────────────────────────────────────────────
describe('15. POST /timesheets/timesheets/reject', () => {
  const reject = (who, keys, extra = {}) => request(app).post('/api/timesheets/timesheets/reject')
    .set('Authorization', as(who)).send({ ids: keys.map(k => te[k].id), reason: 'wrong code', ...extra });

  it('is refused without timesheets:approve', async () => {
    const res = await reject('emp1A', ['own1Submitted2']);
    expect(res.status).toBe(403);
  });
  it("404 for another company's entry", async () => {
    const res = await reject('adminA', ['bSubmitted']);
    expect(res.status).toBe(404);
    expect((await entry('bSubmitted')).status).toBe('submitted');
  });
  it('records the logged-in reviewer, ignoring a client-supplied one', async () => {
    const res = await reject('mgrA', ['own1Submitted2'], { approved_by: emp.emp2A });
    expect(res.status).toBe(200);
    const after = await entry('own1Submitted2');
    expect(after.status).toBe('rejected');
    expect(after.approved_by).toBe(emp.mgrA);
    expect(after.rejection_reason).toBe('wrong code');
  });
});

// ── 17. GET /timesheets/utilization/:employee_id ────────────────────────────
describe('17. GET /timesheets/timesheets/utilization/:employee_id', () => {
  const url = (key) => `/api/timesheets/timesheets/utilization/${emp[key]}?start_date=2031-03-01&end_date=2031-03-31`;
  it("refuses a colleague's utilization to a non-reviewer", async () => {
    const res = await request(app).get(url('emp2A')).set('Authorization', as('emp1A'));
    expect(res.status).toBe(403);
  });
  it("refuses another company's employee", async () => {
    const res = await request(app).get(url('empB')).set('Authorization', as('adminA'));
    expect(res.status).toBe(404);
  });
  it('returns the caller their own', async () => {
    const res = await request(app).get(url('emp1A')).set('Authorization', as('emp1A'));
    expect(res.status).toBe(200);
  });
});

// ── 18. GET /timesheets/pending-approvals/:manager_id ───────────────────────
describe('18. GET /timesheets/timesheets/pending-approvals/:manager_id', () => {
  it('is refused without timesheets:approve', async () => {
    const res = await request(app).get(`/api/timesheets/timesheets/pending-approvals/${emp.mgrA}`).set('Authorization', as('emp1A'));
    expect(res.status).toBe(403);
  });
  it("refuses another manager's queue", async () => {
    const res = await request(app).get(`/api/timesheets/timesheets/pending-approvals/${emp.mgrB}`).set('Authorization', as('mgrA'));
    expect(res.status).toBe(403);
  });
  it("returns a manager's own queue, within their company", async () => {
    const res = await request(app).get(`/api/timesheets/timesheets/pending-approvals/${emp.mgrA}`).set('Authorization', as('mgrA'));
    expect(res.status).toBe(200);
    expect(res.body.every(r => r.company_id === co.A)).toBe(true);
  });
});

// ── 19. GET /utilization ────────────────────────────────────────────────────
describe('19. GET /timesheets/utilization', () => {
  it('is refused without a reviewer or export grant', async () => {
    const res = await request(app).get('/api/timesheets/utilization').set('Authorization', as('emp1A'));
    expect(res.status).toBe(403);
  });
  it("lists only the caller company's employees", async () => {
    const res = await request(app).get('/api/timesheets/utilization').set('Authorization', as('adminA'));
    expect(res.status).toBe(200);
    const names = res.body.map(r => r.name).join('|');
    expect(names).toContain(`${TAG}emp1A`);
    expect(names).not.toContain(`${TAG}empB`);
  });
});

// ── 21. GET /assign-tasks ───────────────────────────────────────────────────
describe('21. GET /timesheets/assign-tasks', () => {
  it('is refused without timesheets:view', async () => {
    const res = await request(app).get('/api/timesheets/assign-tasks').set('Authorization', as('salesA'));
    expect(res.status).toBe(403);
  });
  it("never shows another company's tasks", async () => {
    const res = await request(app).get('/api/timesheets/assign-tasks').set('Authorization', as('adminA'));
    expect(res.status).toBe(200);
    expect(res.body.map(t => t.title)).not.toContain(`${TAG} B marketing task`);
    const own = await request(app).get('/api/timesheets/assign-tasks').set('Authorization', as('adminB'));
    expect(own.body.map(t => t.title)).toContain(`${TAG} B marketing task`);
  });
});

// ── 22. GET /marketing-entry ────────────────────────────────────────────────
describe('22. GET /timesheets/marketing-entry', () => {
  it("is refused to a non-reviewer (other people's timesheets)", async () => {
    const res = await request(app).get('/api/timesheets/marketing-entry').set('Authorization', as('emp1A'));
    expect(res.status).toBe(403);
  });
  it("never shows another company's timesheets", async () => {
    const res = await request(app).get('/api/timesheets/marketing-entry').set('Authorization', as('adminA'));
    expect(res.status).toBe(200);
    expect(res.body.map(r => r.employee_name)).not.toContain(`${TAG}empB Tester`);
    const own = await request(app).get('/api/timesheets/marketing-entry').set('Authorization', as('adminB'));
    expect(own.body.map(r => r.employee_name)).toContain(`${TAG}empB Tester`);
  });
});

// ── a login with no company ─────────────────────────────────────────────────
describe('a login with no company and no global scope', () => {
  it('is refused', async () => {
    const res = await request(app).get('/api/timesheets/timesheets').set('Authorization', as('nocompany'));
    expect(res.status).toBe(403);
  });
  it('does not make the router answer for /api/projects paths it does not own', async () => {
    const res = await request(app).get('/api/projects/no-such-path').set('Authorization', as('nocompany'));
    expect(res.status).toBe(404);
  });
});

// ── the /api/projects alias is the same router ──────────────────────────────
describe('/api/projects alias', () => {
  it('enforces the same approval rules', async () => {
    const res = await request(app).post('/api/projects/timesheets/approve').set('Authorization', as('emp1A')).send({ ids: [te.emp2Draft.id] });
    expect(res.status).toBe(403);
  });
});
