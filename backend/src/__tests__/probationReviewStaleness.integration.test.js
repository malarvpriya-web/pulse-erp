/**
 * Task 3E — stale reviewers in the HR worklist, and who is told about a
 * reassignment. Against the live database and the real router + middleware.
 *
 *   - GET /probation-reviews flags each OPEN review: current, reviewer_replaced
 *     (with the current head, reassignable) or no_eligible_head (with the
 *     reason) — using the same resolution the server enforces. Submitted
 *     reviews are never flagged. Company-scoped, hr:view only.
 *   - POST /:id/reassign notifies the new reviewer once AND the former
 *     reviewer once, generically (no review reference, no employee details),
 *     in the same transaction as the change and its audit row, which records
 *     both counts. A no-op notifies nobody; concurrent reassignments make one
 *     change and one notice each; a former reviewer without an active login
 *     gets nothing and the reassignment still succeeds.
 *
 * Every scenario uses its own department so a head change in one cannot leak
 * into another. Fixtures live in two registry tenants
 * (testTenantIds.contract.test.js) and are deleted in afterAll.
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

const A = 999975;
const B = 999976;
const PW = 'Zz-PStale-Test-9!';
const fx = { tok: {}, user: {}, emp: {}, dept: {}, review: {} };

const app = express();
app.use(express.json());
app.use('/api/probation-reviews', router);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const worklist = (who) => request(app).get('/api/probation-reviews').set(as(who));
const requestReview = (empKey) => request(app).post('/api/probation-reviews').set(as('hr')).send({ employee_id: fx.emp[empKey] });
const reassign = (who, id, reason = 'Head changed') => request(app).post(`/api/probation-reviews/${id}/reassign`).set(as(who)).send({ reason });
const row = async (id) => (await pool.query(`SELECT * FROM probation_reviews WHERE id = $1`, [id])).rows[0];
const notesOf = async (userKey, type) => (await pool.query(
  `SELECT id, reference_id, title, message, module_name FROM notifications
    WHERE user_id = $1 AND notification_type = $2 ORDER BY id`, [fx.user[userKey], type])).rows;
const audits = async (id) => (await pool.query(
  `SELECT user_id, old_data_json, new_data_json FROM audit_logs
    WHERE reference_type = 'probation_review' AND reference_id = $1 AND action_type = 'reassign_reviewer' ORDER BY id`,
  [String(id)])).rows;
const flagOf = async (key) => (await worklist('hr')).body.reviews.find((r) => r.id === fx.review[key]);

async function setHead(deptKey, empKey) {
  await pool.query(
    `UPDATE department_heads SET ended_at = NOW(), ended_by_user_id = $3, end_reason = 'test change'
      WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL`, [A, fx.dept[deptKey].id, fx.user.hr]);
  if (empKey) {
    await pool.query(`INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1,$2,$3)`,
      [A, fx.dept[deptKey].id, fx.emp[empKey]]);
  }
}

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.pstale.%@example.com'`;
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM probation_reviews WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM department_heads WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.pstale.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0; let desig;
async function emp(key, cid, deptKey, status = 'Active', end = null) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, probation_end_date)
     VALUES ($1,$2,'Zz',$3,$4,$5,$6,$7,'2026-05-01',$8) RETURNING id`,
    [cid, `EMP975${String(seq).padStart(3, '0')}`, key, `zz.pstale.emp.${key}@example.com`,
      fx.dept[deptKey].name, desig, status, end])).rows[0].id;
  return fx.emp[key];
}
async function login(key, role, cid, employeeId = null) {
  const email = `zz.pstale.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}
/** A head (with login) for a department, mapped. */
async function head(key, deptKey, cid = A) {
  await login(key, 'department_head', cid, await emp(key, cid, deptKey));
  await pool.query(`INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1,$2,$3)`,
    [cid, fx.dept[deptKey].id, fx.emp[key]]);
}

beforeAll(async () => {
  await cleanup();
  const { rows: d } = await pool.query(`SELECT id, name FROM master_departments WHERE is_active ORDER BY id LIMIT 8`);
  ['cur', 'rep', 'gone', 'left', 'nologin', 'race', 'formerOff', 'moveTo'].forEach((k, i) => { fx.dept[k] = d[i]; });
  desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ PStale A','ZZPSA'), ($2,'ZZ PStale B','ZZPSB')`, [A, B]);

  for (const k of ['cur', 'rep', 'gone', 'left', 'nologin', 'race', 'formerOff', 'moveTo']) await head(`h_${k}`, k);
  for (const k of ['rep', 'race', 'formerOff']) await login(`n_${k}`, 'department_head', A, await emp(`n_${k}`, A, k));
  for (const k of ['cur', 'rep', 'gone', 'left', 'nologin', 'race', 'formerOff']) await emp(`p_${k}`, A, k, 'Probation', '2026-11-30');
  await emp('p_sub', A, 'cur', 'Probation', '2026-11-30');
  await emp('p_move', A, 'cur', 'Probation', '2026-11-30');

  await login('hr', 'hr', A);
  await login('hrExec', 'hr_exec', A);
  await login('employee', 'employee', A, await emp('plain', A, 'cur'));
  await login('hrB', 'hr', B);
  await head('h_b', 'cur', B);
  await emp('p_b', B, 'cur', 'Probation', '2026-11-30');

  // One review per scenario, all requested while every original head is in place.
  for (const k of ['cur', 'rep', 'gone', 'left', 'nologin', 'race', 'formerOff', 'sub', 'move']) {
    fx.review[k] = (await requestReview(`p_${k}`)).body.review.id;
  }
  fx.review.b = (await request(app).post('/api/probation-reviews').set(as('hrB')).send({ employee_id: fx.emp.p_b })).body.review.id;
  await request(app).post(`/api/probation-reviews/mine/${fx.review.sub}/submit`).set(as('h_cur'))
    .send({ rating: 4, comments: 'Fine.', recommendation: 'confirm' });

  // Now make each scenario stale in its own way (fixture rows of company A only).
  await setHead('rep', 'n_rep');                                        // head replaced
  await setHead('race', 'n_race');
  await setHead('formerOff', 'n_formerOff');
  await setHead('gone', null);                                          // no head at all
  await pool.query(`UPDATE employees SET status = 'Left' WHERE id = $1`, [fx.emp.h_left]);            // reviewer left
  await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [fx.user.h_nologin]);           // login disabled
  await pool.query(`UPDATE employees SET department = $2 WHERE id = $1`, [fx.emp.p_move, fx.dept.moveTo.name]); // moved dept
}, 120000);

afterAll(cleanup);

describe('stale-reviewer flags in the HR worklist', () => {
  it('a reviewer who is still the head is current, not reassignable', async () => {
    expect(await flagOf('cur')).toMatchObject({ reviewer_state: 'current', reassignable: false, current_head: null });
  });

  it('a replaced head is flagged with the current head and is reassignable', async () => {
    const f = await flagOf('rep');
    expect(f).toMatchObject({
      reviewer_state: 'reviewer_replaced', reassignable: true,
      current_head: { employee_id: fx.emp.n_rep, name: 'Zz n_rep' },
    });
    expect(f.reviewer_state_reason).toMatch(/is no longer the head of .*; the current head is Zz n_rep/);
  });

  it('an employee who moved department is flagged with the new department\'s head', async () => {
    expect(await flagOf('move')).toMatchObject({
      reviewer_state: 'reviewer_replaced', reassignable: true, current_head: { employee_id: fx.emp.h_moveTo },
    });
  });

  it('no eligible head — none assigned, head left, head without a login — is flagged with the reason, not reassignable', async () => {
    expect(await flagOf('gone')).toMatchObject({ reviewer_state: 'no_eligible_head', reassignable: false, current_head: null });
    expect((await flagOf('gone')).reviewer_state_reason).toMatch(/No department head is assigned/);
    expect((await flagOf('left')).reviewer_state_reason).toMatch(/no longer a current employee/);
    expect((await flagOf('nologin')).reviewer_state_reason).toMatch(/no active Pulse login/);
    for (const k of ['left', 'nologin']) expect((await flagOf(k)).reviewer_state, k).toBe('no_eligible_head');
  });

  it('a submitted review is never flagged', async () => {
    expect(await flagOf('sub')).toMatchObject({ status: 'submitted', reviewer_state: null, reassignable: false });
  });

  it('is company-scoped and needs hr:view', async () => {
    const b = (await worklist('hrB')).body.reviews;
    expect(b.map((r) => r.id)).toEqual([fx.review.b]);
    expect(b[0]).toMatchObject({ reviewer_state: 'current' });
    expect((await worklist('employee')).status).toBe(403);
    expect((await worklist('h_cur')).status).toBe(403);
  });
});

describe('reassignment notifications', () => {
  it('notifies the new reviewer once and the former reviewer once, generically, and audits both counts', async () => {
    const before = await row(fx.review.rep);
    const res = await reassign('hrExec', fx.review.rep);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, notified: 1, notified_previous: 1 });

    const fresh = await notesOf('n_rep', 'probation_review_request');
    expect(fresh).toHaveLength(1);
    expect(Number(fresh[0].reference_id)).toBe(fx.review.rep);

    const former = await notesOf('h_rep', 'probation_review_reassigned');
    expect(former).toHaveLength(1);
    expect(former[0]).toMatchObject({ reference_id: null, module_name: 'probation', title: 'Probation review reassigned' });
    // privacy: nothing about the employee or the review
    for (const leak of ['p_rep', fx.emp.p_rep, 'EMP975', '2026-11-30']) {
      expect(`${former[0].title} ${former[0].message}`).not.toContain(String(leak));
    }

    const [a] = await audits(fx.review.rep);
    expect(a.user_id).toBe(fx.user.hrExec);
    expect(a.old_data_json).toMatchObject({ reviewer_employee_id: fx.emp.h_rep });
    expect(a.new_data_json).toMatchObject({
      reviewer_employee_id: fx.emp.n_rep, reason: 'Head changed', notified_new: 1, notified_previous: 1,
    });

    // Only the reviewer columns moved.
    const after = await row(fx.review.rep);
    for (const k of ['id', 'company_id', 'employee_id', 'cycle_no', 'period_start', 'original_end_date', 'requested_by_user_id',
      'requested_at', 'reviewer_due_date', 'rating', 'comments', 'recommendation', 'status', 'decision', 'new_end_date']) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect(await flagOf('rep')).toMatchObject({ reviewer_state: 'current', reassignable: false });
  });

  it('a no-op reassignment notifies nobody and writes no audit row', async () => {
    const res = await reassign('hr', fx.review.rep, 'again');
    expect(res.body.changed).toBe(false);
    expect(await notesOf('n_rep', 'probation_review_request')).toHaveLength(1);
    expect(await notesOf('h_rep', 'probation_review_reassigned')).toHaveLength(1);
    expect(await audits(fx.review.rep)).toHaveLength(1);
  });

  it('two concurrent reassignments make one change and one notice each', async () => {
    const results = await Promise.all([reassign('hr', fx.review.race, 'one'), reassign('hrExec', fx.review.race, 'two')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.changed).sort()).toEqual([false, true]);
    expect(await notesOf('n_race', 'probation_review_request')).toHaveLength(1);
    expect(await notesOf('h_race', 'probation_review_reassigned')).toHaveLength(1);
    expect(await audits(fx.review.race)).toHaveLength(1);
  }, 20000);

  it('a former reviewer with no active login gets nothing; the reassignment still succeeds', async () => {
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [fx.user.h_formerOff]);
    const res = await reassign('hr', fx.review.formerOff);
    await pool.query(`UPDATE users SET is_active = true WHERE id = $1`, [fx.user.h_formerOff]);
    expect(res.body).toMatchObject({ changed: true, notified: 1, notified_previous: 0 });
    expect(await notesOf('h_formerOff', 'probation_review_reassigned')).toEqual([]);
    expect((await audits(fx.review.formerOff))[0].new_data_json).toMatchObject({ notified_previous: 0, notified_new: 1 });
  });

  it('no eligible replacement: refused, nothing changes, nobody is notified', async () => {
    const before = await row(fx.review.gone);
    const res = await reassign('hr', fx.review.gone);
    expect(res.status).toBe(409);
    expect(await row(fx.review.gone)).toEqual(before);
    expect(await notesOf('h_gone', 'probation_review_reassigned')).toEqual([]);
    expect(await audits(fx.review.gone)).toEqual([]);
  });

  it('another company cannot reassign, and hr:edit is required', async () => {
    expect((await reassign('hrB', fx.review.move)).status).toBe(404);
    expect((await reassign('employee', fx.review.move)).status).toBe(403);
    expect((await reassign('h_cur', fx.review.move)).status).toBe(403);
    expect((await row(fx.review.move)).reviewer_employee_id).toBe(fx.emp.h_cur);
  });
});
