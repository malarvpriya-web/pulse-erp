/**
 * Task 3D — a probation review can be submitted only by its CURRENT eligible
 * reviewer, and HR can move an unsubmitted review to the current head.
 *
 * Against the live database and the real router + permission middleware:
 *   - the current head submits once;
 *   - a former head (department head changed), an exited reviewer, an unlinked
 *     login (even with a still-valid token) and another company are refused;
 *   - HR (existing hr:edit) reassigns an open review in place, with an audit
 *     row (previous/new reviewer, actor, time, reason) and one notification to
 *     the new reviewer; repeating it changes nothing and notifies nobody;
 *   - unauthorized roles and other companies cannot reassign; submitted
 *     reviews cannot be reassigned; with no eligible replacement the review is
 *     left exactly as it was;
 *   - concurrency: a submission blocked behind a department-head change, or
 *     behind a review reassignment, is refused once that change commits.
 *
 * Department-head changes here are made on fixture rows of the test tenants
 * only. Fixtures live in two registry tenants (testTenantIds.contract.test.js)
 * and are deleted in afterAll. ⚠ Do not run this while a Playwright crawl runs.
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

const A = 999973;
const B = 999974;
const PW = 'Zz-PElig-Test-9!';
const fx = { tok: {}, user: {}, emp: {}, dept: {} };
const GOOD = { rating: 4, comments: 'Solid first six months.', recommendation: 'confirm' };

const app = express();
app.use(express.json());
app.use('/api/probation-reviews', router);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const requestReview = (who, empKey) => request(app).post('/api/probation-reviews').set(as(who)).send({ employee_id: fx.emp[empKey] });
const submit = (who, id, body = GOOD) => request(app).post(`/api/probation-reviews/mine/${id}/submit`).set(as(who)).send(body);
const reassign = (who, id, body) => request(app).post(`/api/probation-reviews/${id}/reassign`).set(as(who)).send(body);
const review = async (id) => (await pool.query(`SELECT * FROM probation_reviews WHERE id = $1`, [id])).rows[0];
const notes = async (userKey, reviewId) => (await pool.query(
  `SELECT id FROM notifications WHERE user_id = $1 AND reference_id = $2 AND notification_type = 'probation_review_request'`,
  [fx.user[userKey], reviewId])).rows;
const audits = async (reviewId, action) => (await pool.query(
  `SELECT user_id, action_type, old_data_json, new_data_json, company_id, created_at FROM audit_logs
    WHERE reference_type = 'probation_review' AND reference_id = $1 AND action_type = $2 ORDER BY id`,
  [String(reviewId), action])).rows;

/** Change a department's head the way the Department Heads endpoint does (end + insert). */
async function setHead(deptKey, empKey) {
  await pool.query(
    `UPDATE department_heads SET ended_at = NOW(), ended_by_user_id = $3, end_reason = 'test change'
      WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL`, [A, fx.dept[deptKey].id, fx.user.hr]);
  if (empKey) {
    await pool.query(`INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1,$2,$3)`,
      [A, fx.dept[deptKey].id, fx.emp[empKey]]);
  }
}
/** Wait until some backend is really blocked on a lock whose query matches `like` (max 10 s). */
async function waitForLockWait(like) {
  for (let i = 0; i < 100; i++) {
    const { rows: [w] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [like]);
    if (w.n > 0) return true;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return false;
}

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.pelig.%@example.com'`;
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM probation_reviews WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM department_heads WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.pelig.%@example.com'`);
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
    [cid, `EMP973${String(seq).padStart(3, '0')}`, key, `zz.pelig.emp.${key}@example.com`,
      fx.dept[deptKey].name, desig, status, end])).rows[0].id;
  return fx.emp[key];
}
async function login(key, role, cid, employeeId = null) {
  const email = `zz.pelig.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

beforeAll(async () => {
  await cleanup();
  const { rows: d } = await pool.query(`SELECT id, name FROM master_departments WHERE is_active ORDER BY id LIMIT 2`);
  [fx.dept.one, fx.dept.two] = d;
  desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ PElig A','ZZPEA'), ($2,'ZZ PElig B','ZZPEB')`, [A, B]);

  await login('head1', 'department_head', A, await emp('head1', A, 'one'));
  await login('head2', 'department_head', A, await emp('head2', A, 'one'));
  await login('headTwo', 'department_head', A, await emp('headTwo', A, 'two'));
  await pool.query(`INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES
    ($1,$2,$3), ($1,$4,$5)`, [A, fx.dept.one.id, fx.emp.head1, fx.dept.two.id, fx.emp.headTwo]);
  for (const k of ['pOnce', 'pFormer', 'pSubmitted', 'pExit', 'pUnlink', 'pRaceHead', 'pRaceReview', 'pCross']) {
    await emp(k, A, 'one', 'Probation', '2026-11-30');
  }
  await emp('pNoReplacement', A, 'two', 'Probation', '2026-11-30');
  await login('hr', 'hr', A);
  await login('hrExec', 'hr_exec', A);
  await login('employee', 'employee', A, await emp('plain', A, 'one'));
  await login('manager', 'manager', A);
  await login('hrB', 'hr', B);
  await login('bHead', 'department_head', B, await emp('bHead', B, 'one'));
}, 90000);

afterAll(cleanup);

describe('submission is limited to the CURRENT eligible reviewer', () => {
  it('the current head submits once', async () => {
    const { body } = await requestReview('hr', 'pOnce');
    expect(body.review.reviewer_employee_id).toBe(fx.emp.head1);
    expect((await submit('head1', body.review.id)).status).toBe(200);
    const again = await submit('head1', body.review.id, { ...GOOD, rating: 1 });
    expect(again.status).toBe(409);
    expect((await review(body.review.id)).rating).toBe(4);
  });

  it('a former head is refused once the department head has changed — before any review reassignment', async () => {
    const { body } = await requestReview('hr', 'pFormer');
    fx.formerReview = body.review.id;
    await setHead('one', 'head2');
    const res = await submit('head1', fx.formerReview);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no longer the head/);
    expect((await review(fx.formerReview)).status).toBe('requested');
  });

  it('an exited reviewer is refused', async () => {
    const { body } = await requestReview('hr', 'pExit');          // goes to head2 now
    await pool.query(`UPDATE employees SET status = 'Left' WHERE id = $1`, [fx.emp.head2]);
    const res = await submit('head2', body.review.id);
    await pool.query(`UPDATE employees SET status = 'Active' WHERE id = $1`, [fx.emp.head2]);
    expect(res.status).toBe(403);
    expect((await review(body.review.id)).status).toBe('requested');
    fx.exitReview = body.review.id;
  });

  it('an unlinked login is refused even while its old token still names the employee', async () => {
    const { body } = await requestReview('hr', 'pUnlink');
    await pool.query(`UPDATE users SET employee_id = NULL WHERE id = $1`, [fx.user.head2]);
    const res = await submit('head2', body.review.id);              // same token as before
    await pool.query(`UPDATE users SET employee_id = $2 WHERE id = $1`, [fx.user.head2, fx.emp.head2]);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not linked to an employee/);
    expect((await review(body.review.id)).status).toBe('requested');
  });

  it('another company cannot submit it, and a reviewer id in the body changes nothing', async () => {
    const { body } = await requestReview('hr', 'pCross');
    expect((await submit('bHead', body.review.id, { ...GOOD, reviewer_employee_id: fx.emp.head2 })).status).toBe(404);
    expect((await submit('employee', body.review.id, { ...GOOD, reviewer_employee_id: fx.emp.head2, company_id: A })).status).toBe(403);
    expect((await review(body.review.id)).status).toBe('requested');
  });
});

describe('HR reassignment of an open review', () => {
  it('needs hr:edit, a company, and this company', async () => {
    for (const who of ['employee', 'manager', 'head2']) {
      expect((await reassign(who, fx.formerReview, { reason: 'x' })).status, who).toBe(403);
    }
    expect((await reassign('hrB', fx.formerReview, { reason: 'x' })).status).toBe(404);
    expect((await review(fx.formerReview)).reviewer_employee_id).toBe(fx.emp.head1);
  });

  it('requires a reason', async () => {
    const res = await reassign('hr', fx.formerReview, {});
    expect(res.status).toBe(400);
    expect((await review(fx.formerReview)).reviewer_employee_id).toBe(fx.emp.head1);
  });

  it('moves the review to the current head in place, audits it and notifies the new reviewer once', async () => {
    const before = await review(fx.formerReview);
    const res = await reassign('hrExec', fx.formerReview, { reason: 'Finance head changed', reviewer_employee_id: fx.emp.plain });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, previous_reviewer_employee_id: fx.emp.head1, notified: 1 });
    const after = await review(fx.formerReview);
    expect(after).toMatchObject({
      id: before.id, status: 'requested', cycle_no: before.cycle_no,
      reviewer_employee_id: fx.emp.head2,                 // resolved — the body's reviewer is ignored
      original_end_date: before.original_end_date, reviewer_due_date: before.reviewer_due_date,
    });
    const [a] = await audits(fx.formerReview, 'reassign_reviewer');
    expect(a).toMatchObject({ user_id: fx.user.hrExec, company_id: A });
    expect(a.old_data_json).toMatchObject({ reviewer_employee_id: fx.emp.head1 });
    expect(a.new_data_json).toMatchObject({ reviewer_employee_id: fx.emp.head2, reason: 'Finance head changed' });
    expect(a.created_at).toBeTruthy();
    expect(await notes('head2', fx.formerReview)).toHaveLength(1);
    expect(await notes('head1', fx.formerReview)).toHaveLength(1);   // only the original request
  });

  it('repeating it changes nothing and sends no second notification', async () => {
    const res = await reassign('hr', fx.formerReview, { reason: 'again' });
    expect(res.body.changed).toBe(false);
    expect(await audits(fx.formerReview, 'reassign_reviewer')).toHaveLength(1);
    expect(await notes('head2', fx.formerReview)).toHaveLength(1);
  });

  it('after reassignment the former head is refused and the new head can submit', async () => {
    const old = await submit('head1', fx.formerReview);
    expect(old.status).toBe(403);
    expect(old.body.error).toMatch(/not assigned to you/);
    expect((await submit('head2', fx.formerReview)).status).toBe(200);
  });

  it('a submitted review cannot be reassigned', async () => {
    const res = await reassign('hr', fx.formerReview, { reason: 'try' });
    expect(res.status).toBe(409);
    expect((await review(fx.formerReview)).status).toBe('submitted');
  });

  it('with no eligible replacement head the review is left exactly as it was', async () => {
    const { body } = await requestReview('hr', 'pNoReplacement');
    const before = await review(body.review.id);
    await setHead('two', null);                                        // department two now has no head
    const res = await reassign('hr', body.review.id, { reason: 'head left' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No department head is assigned/);
    expect(await review(body.review.id)).toEqual(before);
    expect(await audits(body.review.id, 'reassign_reviewer')).toEqual([]);
    expect(await notes('headTwo', body.review.id)).toHaveLength(1);    // the original request only
    // ...and the former head cannot submit it either.
    expect((await submit('headTwo', body.review.id)).status).toBe(403);
  });
});

describe('concurrency', () => {
  it('a submission blocked behind a department-head change is refused when the change commits', async () => {
    const { body } = await requestReview('hr', 'pRaceHead');          // reviewer head2
    const competitor = await pool.connect();
    try {
      await competitor.query('BEGIN');
      // What the Department Heads endpoint does: lock the active row, end it, add the next.
      await competitor.query(
        `SELECT id FROM department_heads WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL FOR UPDATE`,
        [A, fx.dept.one.id]);
      const pending = submit('head2', body.review.id).then((r) => r);   // sent now
      expect(await waitForLockWait('%FROM department_heads%FOR SHARE%')).toBe(true);
      await competitor.query(
        `UPDATE department_heads SET ended_at = NOW(), ended_by_user_id = $3, end_reason = 'race'
          WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL`, [A, fx.dept.one.id, fx.user.hr]);
      await competitor.query(
        `INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1,$2,$3)`,
        [A, fx.dept.one.id, fx.emp.head1]);
      await competitor.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(403);
      // After the commit the blocked statement re-checks the old mapping row,
      // finds it ended, and (in its snapshot) no successor yet — so it reports
      // "no eligible head" rather than naming the new one. Either is a refusal.
      expect(res.body.error).toMatch(/no longer the (head|eligible reviewer)/);
    } finally {
      // A failed assertion must not hand back a connection mid-transaction.
      await competitor.query('ROLLBACK').catch(() => {});
      competitor.release();
    }
    expect((await review(body.review.id)).status).toBe('requested');
  }, 20000);

  it('a submission blocked behind a review reassignment is refused when the reassignment commits', async () => {
    const { body } = await requestReview('hr', 'pRaceReview');        // reviewer head1 (head again)
    expect(body.review.reviewer_employee_id).toBe(fx.emp.head1);
    const competitor = await pool.connect();
    try {
      await competitor.query('BEGIN');
      await competitor.query(`SELECT id FROM probation_reviews WHERE id = $1 FOR UPDATE`, [body.review.id]);
      const pending = submit('head1', body.review.id).then((r) => r);
      expect(await waitForLockWait('%FROM probation_reviews%FOR UPDATE%')).toBe(true);
      await competitor.query(
        `UPDATE probation_reviews SET reviewer_employee_id = $2, updated_at = NOW() WHERE id = $1`,
        [body.review.id, fx.emp.head2]);
      await competitor.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not assigned to you/);
    } finally {
      // A failed assertion must not hand back a connection mid-transaction.
      await competitor.query('ROLLBACK').catch(() => {});
      competitor.release();
    }
    expect((await review(body.review.id)).status).toBe('requested');
  }, 20000);
});
