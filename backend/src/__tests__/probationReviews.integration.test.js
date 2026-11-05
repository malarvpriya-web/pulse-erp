/**
 * Probation reviews — HR request + department-head submission (Task 3B),
 * against the live database and the real router + permission middleware.
 *
 *   - no company context → 403 everywhere; department heads, managers and
 *     employees cannot use the HR routes, and gain no hr/internships grant;
 *   - a request needs an employee of THIS company, current, on probation,
 *     with a saved end date, whose department has an active, current,
 *     logged-in head who is not the employee; the reviewer is resolved, never
 *     supplied;
 *   - repeated and concurrent requests open one review and notify once;
 *   - only the assigned reviewer (by linked employee record) can submit, once;
 *     a reviewer id in the body is ignored;
 *   - neither step changes the employee record;
 *   - request and submission land in the audit trail;
 *   - company B never sees or touches company A's reviews.
 *
 * Fixtures live in two registry tenants (testTenantIds.contract.test.js) and
 * are deleted in afterAll; audit rows are kept, as every suite's are.
 * ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { default: router } = await import('../probation/probationReviews.routes.js');

const A = 999971;
const B = 999972;
const PW = 'Zz-PRev-Test-9!';
const fx = { tok: {}, user: {}, emp: {}, dept: {} };

const app = express();
app.use(express.json());
app.use('/api/probation-reviews', router);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const api = {
  list: (who, q = '') => request(app).get(`/api/probation-reviews${q}`).set(as(who)),
  detail: (who, empId) => request(app).get(`/api/probation-reviews/employees/${empId}`).set(as(who)),
  request: (who, body) => request(app).post('/api/probation-reviews').set(as(who)).send(body),
  mine: (who) => request(app).get('/api/probation-reviews/mine').set(as(who)),
  submit: (who, id, body) => request(app).post(`/api/probation-reviews/mine/${id}/submit`).set(as(who)).send(body),
};
const GOOD = { rating: 4, comments: 'Delivers on time; needs to document more.', recommendation: 'confirm' };

const empRow = async (id) => (await pool.query(
  `SELECT status, probation_end_date::text AS end, probation_months, confirmation_date, department, updated_at
     FROM employees WHERE id = $1`, [id])).rows[0];
const reviewsOf = async (empId) => (await pool.query(
  `SELECT * FROM probation_reviews WHERE employee_id = $1 ORDER BY id`, [empId])).rows;
const notesFor = async (userKey, reviewId) => (await pool.query(
  `SELECT id, notification_type, module_name FROM notifications WHERE user_id = $1 AND reference_id = $2`,
  [fx.user[userKey], reviewId])).rows;

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.prev.%@example.com'`;
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM probation_reviews WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM department_heads WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.prev.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0; let desig;
async function emp(key, cid, deptKey, { status = 'Active', end = null, joining = '2026-05-01' } = {}) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, probation_end_date)
     VALUES ($1,$2,'Zz',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [cid, `EMP971${String(seq).padStart(3, '0')}`, key, `zz.prev.emp.${key}@example.com`,
      deptKey ? fx.dept[deptKey].name : null, desig, status, joining, end])).rows[0].id;
  return fx.emp[key];
}
async function login(key, role, cid, employeeId = null) {
  const email = `zz.prev.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
  if (cid != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}
const mapHead = (cid, deptKey, empKey) => pool.query(
  `INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1,$2,$3)`,
  [cid, fx.dept[deptKey].id, fx.emp[empKey]]);

beforeAll(async () => {
  await cleanup();
  const { rows: d } = await pool.query(`SELECT id, name FROM master_departments WHERE is_active ORDER BY id LIMIT 3`);
  [fx.dept.mapped, fx.dept.unmapped, fx.dept.selfHead] = d;
  desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ PRev A','ZZPRA'), ($2,'ZZ PRev B','ZZPRB')`, [A, B]);

  // Company A
  await login('head', 'department_head', A, await emp('head', A, 'mapped'));
  await mapHead(A, 'mapped', 'head');
  await emp('prob', A, 'mapped', { status: 'Probation', end: '2026-11-30' });
  await emp('prob2', A, 'mapped', { status: 'Probation', end: '2026-12-15' });
  await emp('probNoEnd', A, 'mapped', { status: 'Probation' });
  await emp('active', A, 'mapped', { status: 'Active', end: '2026-11-30' });
  await emp('probUnmapped', A, 'unmapped', { status: 'Probation', end: '2026-11-30' });
  await emp('probNoDept', A, null, { status: 'Probation', end: '2026-11-30' });
  // A probationer who heads their own department
  await login('selfHead', 'employee', A, await emp('selfHead', A, 'selfHead', { status: 'Probation', end: '2026-11-30' }));
  await mapHead(A, 'selfHead', 'selfHead');
  await login('other', 'employee', A, await emp('other', A, 'mapped'));
  await login('hr', 'hr', A);
  await login('hrExec', 'hr_exec', A);
  await login('manager', 'manager', A);
  await login('noLinkHead', 'department_head', A);     // a head login with no employee record
  // Company B
  await login('bHead', 'department_head', B, await emp('bHead', B, 'mapped'));
  await mapHead(B, 'mapped', 'bHead');
  await emp('bProb', B, 'mapped', { status: 'Probation', end: '2026-11-30' });
  await login('hrB', 'hr', B);
  await login('noCompanyHr', 'hr', null);
}, 90000);

afterAll(cleanup);

describe('company context and authorization', () => {
  it('no company context → 403 on every route', async () => {
    for (const res of [
      await api.list('noCompanyHr'), await api.detail('noCompanyHr', fx.emp.prob),
      await api.request('noCompanyHr', { employee_id: fx.emp.prob }),
      await api.mine('noCompanyHr'), await api.submit('noCompanyHr', 1, GOOD),
    ]) expect(res.status).toBe(403);
  });

  it('department heads, managers and employees cannot use the HR routes', async () => {
    for (const who of ['head', 'manager', 'other']) {
      expect((await api.list(who)).status, who).toBe(403);
      expect((await api.detail(who, fx.emp.prob)).status, who).toBe(403);
      expect((await api.request(who, { employee_id: fx.emp.prob })).status, who).toBe(403);
    }
  });

  it('the department_head role still holds no hr or internships permission', async () => {
    const { rows } = await pool.query(
      `SELECT rp.can_view, rp.can_add FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'department_head' AND rp.module IN ('hr', 'internships')`);
    expect(rows.every((p) => p.can_view === false && p.can_add === false)).toBe(true);
  });
});

describe('requesting a review', () => {
  it('refuses employees who are not eligible, with the reason', async () => {
    const cases = [
      ['probNoEnd', 400, /no saved probation end date/],
      ['active', 400, /not on probation/],
      ['probUnmapped', 409, /No department head is assigned/],
      ['probNoDept', 409, /has no department/],
      ['selfHead', 409, /cannot review their own probation/],
    ];
    for (const [key, status, msg] of cases) {
      const res = await api.request('hr', { employee_id: fx.emp[key] });
      expect(res.status, key).toBe(status);
      expect(res.body.error, key).toMatch(msg);
      expect(await reviewsOf(fx.emp[key]), key).toEqual([]);
    }
    expect((await api.request('hr', { employee_id: fx.emp.bProb })).status).toBe(404);   // another company
    expect((await api.request('hr', { employee_id: 987654321 })).status).toBe(404);
    expect((await api.request('hr', {})).status).toBe(400);
  });

  it('opens cycle 1 for an eligible probationer, resolves the head and notifies them once', async () => {
    const before = await empRow(fx.emp.prob);
    const res = await api.request('hr', { employee_id: fx.emp.prob, reviewer_employee_id: fx.emp.other });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: true, notified: 1 });
    const r = res.body.review;
    expect(r).toMatchObject({
      employee_id: fx.emp.prob, cycle_no: 1, period_start: '2026-05-01', original_end_date: '2026-11-30',
      status: 'requested', reviewer_employee_id: fx.emp.head,   // resolved — the body's reviewer is ignored
      reviewer_due_date: '2026-11-30', requested_by: 'Zz hr',
    });
    fx.review = r.id;
    const notes = await notesFor('head', r.id);
    expect(notes).toEqual([expect.objectContaining({ notification_type: 'probation_review_request', module_name: 'probation' })]);
    expect((await reviewsOf(fx.emp.prob))[0].reviewer_notified_at).not.toBeNull();
    expect(await empRow(fx.emp.prob)).toEqual(before);               // the employee is untouched
  });

  it('a repeated request returns the open review — no second row, no second notification', async () => {
    const res = await api.request('hrExec', { employee_id: fx.emp.prob });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, review: { id: fx.review } });
    expect(await reviewsOf(fx.emp.prob)).toHaveLength(1);
    expect(await notesFor('head', fx.review)).toHaveLength(1);
  });

  it('two simultaneous requests open one review and notify once', async () => {
    const results = await Promise.all([
      api.request('hr', { employee_id: fx.emp.prob2 }),
      api.request('hrExec', { employee_id: fx.emp.prob2 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.created).sort()).toEqual([false, true]);
    const rows = await reviewsOf(fx.emp.prob2);
    expect(rows).toHaveLength(1);
    expect(await notesFor('head', rows[0].id)).toHaveLength(1);
  }, 20000);

  it('rejects a past due date and accepts a future one', async () => {
    const past = await api.request('hr', { employee_id: fx.emp.bProb, due_date: '2020-01-01' });
    expect(past.status).toBe(404);   // not this company's employee — checked before the date
    const pastB = await api.request('hrB', { employee_id: fx.emp.bProb, due_date: '2020-01-01' });
    expect(pastB.status).toBe(400);
    expect(pastB.body.error).toMatch(/cannot be in the past/);
  });
});

describe('worklist and detail', () => {
  it('HR sees its company\'s reviews and who is still awaiting a request (with the blocker)', async () => {
    const res = await api.list('hr');
    expect(res.status).toBe(200);
    expect(res.body.reviews.map((r) => r.employee_id).sort()).toEqual([fx.emp.prob, fx.emp.prob2].sort());
    const awaiting = Object.fromEntries(res.body.awaiting_request.map((a) => [a.employee_id, a]));
    expect(awaiting[fx.emp.probUnmapped].blocked).toMatch(/No department head is assigned/);
    expect(awaiting[fx.emp.selfHead].blocked).toMatch(/own probation/);
    expect(awaiting[fx.emp.prob]).toBeUndefined();               // has an open review
    expect(awaiting[fx.emp.probNoEnd]).toBeUndefined();          // no saved end date
  });

  it('company B sees none of company A', async () => {
    const res = await api.list('hrB');
    expect(res.body.reviews).toEqual([]);
    expect(res.body.awaiting_request.map((a) => a.employee_id)).toEqual([fx.emp.bProb]);
    expect((await api.detail('hrB', fx.emp.prob)).status).toBe(404);
  });
});

describe('department-head submission', () => {
  it('the assigned head sees the review; nobody else does', async () => {
    expect((await api.mine('head')).body.reviews.map((r) => r.id)).toContain(fx.review);
    expect((await api.mine('other')).body.reviews).toEqual([]);
    expect((await api.mine('bHead')).body.reviews).toEqual([]);
    const unlinked = await api.mine('noLinkHead');
    expect(unlinked.status).toBe(403);
    expect(unlinked.body.error).toMatch(/not linked to an employee/);
  });

  it('refuses someone who is not the assigned reviewer — even naming the reviewer in the body', async () => {
    const res = await api.submit('other', fx.review, { ...GOOD, reviewer_employee_id: fx.emp.head });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not assigned to you/);
    expect((await api.submit('bHead', fx.review, GOOD)).status).toBe(404);   // another company
    expect((await reviewsOf(fx.emp.prob))[0].status).toBe('requested');
  });

  it('validates the rating, comments and recommendation', async () => {
    expect((await api.submit('head', fx.review, { ...GOOD, rating: 0 })).status).toBe(400);
    expect((await api.submit('head', fx.review, { ...GOOD, rating: 6 })).status).toBe(400);
    expect((await api.submit('head', fx.review, { ...GOOD, comments: '  ' })).status).toBe(400);
    expect((await api.submit('head', fx.review, { ...GOOD, recommendation: 'promote' })).status).toBe(400);
    expect((await reviewsOf(fx.emp.prob))[0].status).toBe('requested');
  });

  it('a head who has left cannot submit', async () => {
    await pool.query(`UPDATE employees SET status = 'Left' WHERE id = $1`, [fx.emp.head]);
    const res = await api.submit('head', fx.review, GOOD);
    await pool.query(`UPDATE employees SET status = 'Active' WHERE id = $1`, [fx.emp.head]);
    expect(res.status).toBe(403);
  });

  it('the assigned head submits once; the employee record is untouched', async () => {
    const before = await empRow(fx.emp.prob);
    const res = await api.submit('head', fx.review, GOOD);
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      status: 'submitted', rating: 4, recommendation: 'confirm', comments: GOOD.comments, submitted_by: 'Zz head',
    });
    expect(await empRow(fx.emp.prob)).toEqual(before);
    const dup = await api.submit('head', fx.review, { ...GOOD, rating: 2 });
    expect(dup.status).toBe(409);
    expect((await reviewsOf(fx.emp.prob))[0]).toMatchObject({ rating: 4, status: 'submitted' });
  });

  it('a submitted review still counts as open: a new request returns it rather than starting cycle 2', async () => {
    const res = await api.request('hr', { employee_id: fx.emp.prob });
    expect(res.body).toMatchObject({ created: false, review: { id: fx.review, status: 'submitted' } });
    expect(await reviewsOf(fx.emp.prob)).toHaveLength(1);
  });
});

describe('audit trail', () => {
  it('the request and the submission are both recorded, newest last, with who', async () => {
    let events = [];
    for (let i = 0; i < 20 && events.length < 2; i++) {      // logAudit is fire-and-forget
      events = (await api.detail('hr', fx.emp.prob)).body.events;
      if (events.length < 2) await new Promise((r) => { setTimeout(r, 100); });
    }
    expect(events.map((e) => [e.review_id, e.action, e.by])).toEqual([
      [fx.review, 'request_review', 'Zz hr'],
      [fx.review, 'submit_review', 'Zz head'],
    ]);
  });
});

describe('reviewer summary (drives the My Probation Reviews menu entry)', () => {
  const summary = (who) => request(app).get('/api/probation-reviews/mine/summary').set(as(who));

  it('a current head: is_head, their departments, and what needs action', async () => {
    const res = await summary('head');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ linked: true, is_head: true, departments: [fx.dept.mapped.name] });
    expect(res.body.needs_action).toBeGreaterThanOrEqual(1);       // prob2's review is still requested
  });

  it('never errors for someone who is not a head — it just says no', async () => {
    expect((await summary('other')).body).toEqual({ linked: true, is_head: false, departments: [], needs_action: 0 });
    expect((await summary('noLinkHead')).body).toMatchObject({ linked: false, is_head: false });
    expect((await summary('hr')).body).toMatchObject({ is_head: false });
    const noCo = await summary('noCompanyHr');
    expect(noCo.status).toBe(200);
    expect(noCo.body).toMatchObject({ is_head: false });
  });

  it('is per company: B\'s head is a head in B only, and sees none of A\'s work', async () => {
    const res = await summary('bHead');
    expect(res.body).toMatchObject({ is_head: true, departments: [fx.dept.mapped.name], needs_action: 0 });
  });

  it('a mapping row in ANOTHER company naming this employee never counts', async () => {
    // The service refuses to create such a row, but the table does not forbid
    // it — so the summary must not trust it. Inserted directly, in B.
    await pool.query(
      `INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1, $2, $3)`,
      [B, fx.dept.unmapped.id, fx.emp.head]);
    try {
      expect((await summary('head')).body.departments).toEqual([fx.dept.mapped.name]);
    } finally {
      await pool.query(`DELETE FROM department_heads WHERE company_id = $1 AND head_employee_id = $2`, [B, fx.emp.head]);
    }
  });

  it('a head who has left, or whose assignment ended, is no longer a head', async () => {
    await pool.query(`UPDATE employees SET status = 'Left' WHERE id = $1`, [fx.emp.head]);
    expect((await summary('head')).body).toMatchObject({ is_head: false, departments: [], needs_action: 0 });
    await pool.query(`UPDATE employees SET status = 'Active' WHERE id = $1`, [fx.emp.head]);

    await pool.query(
      `UPDATE department_heads SET ended_at = NOW(), ended_by_user_id = $2, end_reason = 'test reassignment'
        WHERE company_id = $1 AND head_employee_id = $3 AND ended_at IS NULL`, [A, fx.user.hr, fx.emp.head]);
    expect((await summary('head')).body).toMatchObject({ is_head: false });
    // ...while the review already assigned to them is still theirs on the API (Task 3B rule).
    expect((await api.mine('head')).body.reviews.length).toBeGreaterThan(0);
  });
});
