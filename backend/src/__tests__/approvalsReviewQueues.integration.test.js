/**
 * Intern evaluations and probation reviews in My Pending Approvals — against
 * the live database, the real approvals + home routers and real login tokens.
 *
 *   an intern whose mentor has not evaluated yet  → in THAT mentor's list only
 *   a probation review requested of a head         → in THAT head's list only
 *   each carries `open` (its own form), never approve/reject, and the generic
 *   /approvals/<id>/approve refuses it
 *   Home's My Pending Approvals card is the first rows of the same list, and
 *   its total matches
 *
 * Assignment, not role: an HR manager in the same company sees neither row.
 * Another tenant sees nothing. Fixtures live in registry tenants 999994/999995
 * (testTenantIds.contract) and are deleted in afterAll.
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
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { default: approvalsRoutes } = await import('../modules/approvals/approvals.routes.js');
const { default: homeRoutes } = await import('../home/home.routes.js');

const A = 999994;
const B = 999995;
const PW = 'Zz-Review-Q-9!';
const EMAIL = (k) => `zz.revq.${k}@example.com`;
const fx = { tok: {}, user: {}, emp: {} };

const app = express();
app.use(express.json());
app.use('/api/approvals', verifyToken, approvalsRoutes);
app.use('/api/home', homeRoutes);
const api = (who, method, url) => request(app)[method](`/api${url}`).set({ Authorization: `Bearer ${fx.tok[who]}` }).send({});

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.revq.%@example.com'`;
  await pool.query(`DELETE FROM probation_reviews WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_evaluation_events WHERE company_id = ANY($1::int[])`, [c]).catch(() => {});
  await pool.query(`DELETE FROM intern_evaluations WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interns WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.revq.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
async function emp(key, cid) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date)
     VALUES ($1, $2, 'Zz', $3, $4, 'Active', '2025-01-01') RETURNING id`,
    [cid, `EMP994${String(seq).padStart(3, '0')}`, key, EMAIL(`emp.${key}`)],
  )).rows[0].id;
  return fx.emp[key];
}

async function login(key, role, cid, employeeId) {
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING id`,
    [`Zz ${key}`, EMAIL(key), hash, role, cid, employeeId])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(EMAIL(key), PW)).token;
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZ RevQ A', 'ZZRVQA'), ($2, 'ZZ RevQ B', 'ZZRVQB')`, [A, B]);
  await login('mentor', 'employee', A, await emp('mentor', A));
  await login('head', 'department_head', A, await emp('head', A));
  await login('hr', 'hr_manager', A, await emp('hr', A));
  await login('mentorB', 'employee', B, await emp('mentorB', B));
  const probationer = await emp('probationer', A);

  fx.intern = (await pool.query(
    `INSERT INTO interns (company_id, intern_code, first_name, last_name, college, course, department, designation,
                          start_date, end_date, status, mentor_employee_id)
     VALUES ($1, 'INT994001', 'Priya', 'Zz', 'Test College', 'B.E', 'Engineering', 'Intern',
             CURRENT_DATE - 30, CURRENT_DATE + 30, 'Active', $2) RETURNING id`,
    [A, fx.emp.mentor])).rows[0].id;

  fx.review = (await pool.query(
    `INSERT INTO probation_reviews (company_id, employee_id, cycle_no, period_start, original_end_date,
                                    reviewer_employee_id, reviewer_due_date, status, requested_by_user_id)
     VALUES ($1, $2, 1, CURRENT_DATE - 180, CURRENT_DATE + 7, $3, CURRENT_DATE + 3, 'requested', $4) RETURNING id`,
    [A, probationer, fx.emp.head, fx.user.hr])).rows[0].id;
}, 60000);

// The shared pool is NOT closed here (sharedPoolLifecycle.contract.test.js).
afterAll(cleanup);

const INTERN_ID = () => `ieval:${fx.intern}:${fx.emp.mentor}`;
const REVIEW_ID = () => `prob:${fx.review}`;

describe('review queues in My Pending Approvals', () => {
  it('the mentor gets the intern evaluation, with Open to the evaluation form — not approve/reject', async () => {
    const res = await api('mentor', 'get', '/approvals/pending');
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.id === INTERN_ID());
    expect(row).toMatchObject({ type: 'ieval', request_type: 'Intern Evaluation', can_act: true, stage: 'Mentor — not started' });
    expect(row.request_title).toBe('Evaluate intern Priya Zz (INT994001)');
    expect(row.actions).toEqual({ open: { page: 'MyInternEvaluations', params: {} } });
    expect(res.body.map((r) => r.id)).not.toContain(REVIEW_ID());
  });

  it('the department head gets the probation review, opening that review', async () => {
    const res = await api('head', 'get', '/approvals/pending');
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.id === REVIEW_ID());
    expect(row).toMatchObject({ type: 'prob', request_type: 'Probation Review', can_act: true, requested_by: 'Zz hr' });
    expect(row.actions).toEqual({ open: { page: 'MyProbationReviews', params: { ref: String(fx.review) } } });
    expect(res.body.map((r) => r.id)).not.toContain(INTERN_ID());
  });

  it('follows the assignment, not the role: HR in the same company sees neither; another tenant sees nothing', async () => {
    for (const who of ['hr', 'mentorB']) {
      const ids = (await api(who, 'get', '/approvals/pending')).body.map((r) => r.id);
      expect(ids).not.toContain(INTERN_ID());
      expect(ids).not.toContain(REVIEW_ID());
    }
  });

  it('the generic approve endpoint refuses them — they are completed on their own form', async () => {
    const res = await api('head', 'post', `/approvals/${encodeURIComponent(REVIEW_ID())}/approve`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await pool.query('SELECT status FROM probation_reviews WHERE id = $1', [fx.review]);
    expect(rows[0].status).toBe('requested');
  });

  it('counts toward the KPIs and makes the person an approver for the page', async () => {
    const stats = (await api('mentor', 'get', '/approvals/stats')).body;
    expect(stats.pending).toBeGreaterThanOrEqual(1);
    expect(stats.isApprover).toBe(true);
  });

  it('Home\'s card is the first rows of the same list, with the same total', async () => {
    for (const [who, id] of [['mentor', INTERN_ID()], ['head', REVIEW_ID()]]) {
      const pending = (await api(who, 'get', '/approvals/pending')).body;
      const home = (await api(who, 'get', '/home/summary')).body;
      expect(home.degraded || []).not.toContain('myApprovals');
      expect(home.myApprovals.awaitingMyActionTotal).toBe(pending.length);
      expect(home.myApprovals.awaitingMyAction.map((r) => r.id)).toEqual(pending.slice(0, 5).map((r) => r.id));
      const row = home.myApprovals.awaitingMyAction.find((r) => r.id === id);
      expect(row.open).toEqual(pending.find((r) => r.id === id).actions.open);
    }
  });

  it('a saved draft stays in the queue; a completed internship leaves it', async () => {
    await pool.query(
      `INSERT INTO intern_evaluations (company_id, intern_id, mentor_employee_id, status)
       VALUES ($1, $2, $3, 'Draft')`, [A, fx.intern, fx.emp.mentor]);
    const draft = (await api('mentor', 'get', '/approvals/pending')).body.find((r) => r.id === INTERN_ID());
    expect(draft).toMatchObject({ stage: 'Mentor — draft', description: 'Draft saved — not submitted yet' });

    // Complete the internship the way the database allows it
    // (interns_completion_guard, migrations 20261013000005/6): the LATEST
    // evaluation must be Approved, recommend employment or not, and be named as
    // completion_evaluation_id. A bare status update is refused — which is why
    // this step used to throw before reaching its assertion.
    // The draft above is the one that gets submitted and approved (an intern has
    // at most one open evaluation — ux_intern_evaluations_open). An approved
    // evaluation is a complete one (intern_evaluations_submitted_complete) and is
    // never reviewed by its submitter (…_no_self_review) — the same shape
    // internshipCompletion.integration.test.js builds.
    const { rows: [approved] } = await pool.query(
      `UPDATE intern_evaluations
          SET status = 'Approved', recommendation = 'Recommended for Employment', comments = 'Fixture evaluation',
              submitted_by_user_id = 1, submitted_at = NOW(), reviewed_by_user_id = 2, reviewed_at = NOW(),
              received_at = NOW(), received_via = 'Online', technical_skills = 4, communication = 4, teamwork = 4,
              discipline_attendance = 4, learning_ability = 4, overall_performance = 4
        WHERE intern_id = $1 AND status = 'Draft' RETURNING id`, [fx.intern]);
    await pool.query(
      `UPDATE interns SET status = 'Completed', completed_on = CURRENT_DATE, completion_evaluation_id = $2
        WHERE id = $1`, [fx.intern, approved.id]);
    // A fresh draft after completion would, on an open internship, put the
    // intern straight back in the queue (the first assertion above). Here only
    // the Completed status can keep it out — so this checks the completion
    // filter itself, not the approval that completion required.
    await pool.query(
      `INSERT INTO intern_evaluations (company_id, intern_id, mentor_employee_id, status)
       VALUES ($1, $2, $3, 'Draft')`, [A, fx.intern, fx.emp.mentor]);
    const ids = (await api('mentor', 'get', '/approvals/pending')).body.map((r) => r.id);
    expect(ids).not.toContain(INTERN_ID());
  });
});
