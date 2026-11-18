/**
 * Performance self-service, through the REAL router on the REAL database
 * (2026-11-11).
 *
 * What was wrong, measured as an employee-only login:
 *   - GET  /goals filtered by the LOGIN id (users.id) against
 *     performance_goals.employee_id (an employees.id): an employee never saw a goal.
 *   - POST /goals stored no employee (Goals.jsx sends none): the goal belonged to nobody.
 *   - PUT /goals/:id, POST /goals/:id/checkin, DELETE /goals/:id checked nothing:
 *     anyone could rewrite or delete anybody's goal.
 *   - POST /goals/:id/checkin wrote the login id into goal_checkins.checked_in_by
 *     (FK → employees) and 500'd after the goal row was already updated.
 *   - GET /competencies with no filter returned every employee's self and manager
 *     scores; POST /competencies wrote self-scores for any employee.
 *
 * Self-cleaning: an isolated company; every row is removed on the way out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (pw) process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: performanceRouter } = await import('../modules/performance/routes/performance.routes.js');
const { createIsolatedCompany, dropIsolatedCompany } = await import('./helpers/isolatedCompany.js');

const fx = {};

/** An app whose caller is `user` (roles + linked employee) in the test company. */
function appAs({ userId, roles, employeeId }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, role: roles[0], roles, employee_id: employeeId, company_id: fx.co.companyId };
    req.scope = { company_id: fx.co.companyId };
    next();
  });
  app.use('/api/performance', performanceRouter);
  return app;
}

async function employee(label, managerId = null) {
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, department, joining_date, reporting_manager_id)
     VALUES ($1, $2, 'Zz', $3, $4, 'Active', 'QA', '2020-01-01', $5) RETURNING id`,
    [fx.co.companyId, `EMP977${String(Date.now() % 1000).padStart(3, '0')}${label.length}`, label, `${fx.co.code.toLowerCase()}.${label}@test.invalid`, managerId]);
  return e.id;
}

beforeAll(async () => {
  fx.co = await createIsolatedCompany(pool, 'ZZPSS');
  fx.lead = await employee('lead');
  fx.me = await employee('me', fx.lead);
  fx.other = await employee('other');
  fx.asMe = appAs({ userId: 990000001, roles: ['employee'], employeeId: fx.me });
  // A team lead on the plain employee role: the reporting manager of `me`.
  fx.asLead = appAs({ userId: 990000003, roles: ['employee'], employeeId: fx.lead });
  // The manager ROLE, but nobody's reporting manager.
  fx.asManager = appAs({ userId: 990000002, roles: ['manager'], employeeId: fx.other });
  fx.asHR = appAs({ userId: 990000004, roles: ['hr'], employeeId: null });
  // Someone else's goal and review with competency scores.
  fx.otherGoal = (await pool.query(
    `INSERT INTO performance_goals (employee_id, goal_title, target_value, company_id) VALUES ($1, 'ZZPSS other goal', 10, $2) RETURNING id`,
    [fx.other, fx.co.companyId])).rows[0].id;
  fx.myReview = (await pool.query(
    `INSERT INTO performance_reviews (employee_id, status, company_id) VALUES ($1, 'active', $2) RETURNING id`,
    [fx.me, fx.co.companyId])).rows[0].id;
  fx.otherReview = (await pool.query(
    `INSERT INTO performance_reviews (employee_id, status, company_id) VALUES ($1, 'active', $2) RETURNING id`,
    [fx.other, fx.co.companyId])).rows[0].id;
  await pool.query(
    `INSERT INTO performance_competencies (review_id, employee_id, competency_name, self_score, manager_score, company_id)
     VALUES ($1, $2, 'ZZPSS Mine', 4, 4, $5), ($3, $4, 'ZZPSS Theirs', 2, 1, $5)`,
    [fx.myReview, fx.me, fx.otherReview, fx.other, fx.co.companyId]);
});

afterAll(async () => {
  if (fx.co) {
    const c = fx.co.companyId;
    await pool.query(`DELETE FROM goal_checkins WHERE goal_id IN (SELECT id FROM performance_goals WHERE company_id = $1)`, [c]);
    await pool.query(`DELETE FROM performance_goals WHERE company_id = $1`, [c]);
    await pool.query(`DELETE FROM performance_competencies WHERE company_id = $1`, [c]);
    await pool.query(`DELETE FROM performance_reviews WHERE company_id = $1`, [c]);
    await pool.query(`DELETE FROM employees WHERE company_id = $1`, [c]);
    await dropIsolatedCompany(pool, c);
  }
});

describe('goals are set by the manager (2026-11-11)', () => {
  it('an employee cannot add a goal for themselves', async () => {
    const res = await request(fx.asMe).post('/api/performance/goals').send({ goal_title: 'ZZPSS self-set', target_value: 10, employee_id: fx.me });
    expect(res.status).toBe(403);
  });

  it('their reporting manager adds it (plain employee role), and the employee sees it', async () => {
    const res = await request(fx.asLead).post('/api/performance/goals').send({ goal_title: 'ZZPSS my goal', target_value: 10, employee_id: fx.me });
    expect(res.status).toBe(201);
    expect(res.body.employee_id).toBe(fx.me);
    fx.myGoal = res.body.id;
    const list = await request(fx.asMe).get('/api/performance/goals');
    expect(list.body.map(g => g.goal_title)).toEqual(['ZZPSS my goal']);
    const team = await request(fx.asLead).get(`/api/performance/goals?employee_id=${fx.me}`);
    expect(team.body.map(g => g.goal_title)).toEqual(['ZZPSS my goal']);
  });

  it('a goal with no team member chosen is refused', async () => {
    const res = await request(fx.asLead).post('/api/performance/goals').send({ goal_title: 'ZZPSS nobody', target_value: 10 });
    expect(res.status).toBe(400);
  });

  it('the employee records progress on it, by their employee id', async () => {
    const res = await request(fx.asMe).post(`/api/performance/goals/${fx.myGoal}/checkin`).send({ achieved_value: 5, note: 'half' });
    expect(res.status).toBe(200);
    expect(Number(res.body.progress_pct)).toBe(50);
    const { rows } = await pool.query(`SELECT checked_in_by FROM goal_checkins WHERE goal_id = $1`, [fx.myGoal]);
    expect(rows.map(r => r.checked_in_by)).toEqual([fx.me]);
  });

  it('but cannot edit or delete it; the manager can', async () => {
    expect((await request(fx.asMe).put(`/api/performance/goals/${fx.myGoal}`).send({ goal_title: 'easier' })).status).toBe(403);
    expect((await request(fx.asMe).delete(`/api/performance/goals/${fx.myGoal}`)).status).toBe(403);
    expect((await request(fx.asLead).put(`/api/performance/goals/${fx.myGoal}`).send({ priority: 'High' })).status).toBe(200);
  });

  it.each([
    ['PUT', (id) => request(fx.asMe).put(`/api/performance/goals/${id}`).send({ goal_title: 'hijacked' })],
    ['check-in', (id) => request(fx.asMe).post(`/api/performance/goals/${id}/checkin`).send({ achieved_value: 10 })],
    ['DELETE', (id) => request(fx.asMe).delete(`/api/performance/goals/${id}`)],
    ['manager role, not their manager: PUT', (id) => request(fx.asManager).put(`/api/performance/goals/${id}`).send({ goal_title: 'hijacked' })],
  ])("%s on someone else's goal is refused and changes nothing", async (_label, call) => {
    const res = await call(fx.otherGoal);
    expect(res.status).toBe(403);
    const { rows: [g] } = await pool.query(
      `SELECT goal_title, achieved_value, deleted_at FROM performance_goals WHERE id = $1`, [fx.otherGoal]);
    expect(g.goal_title).toBe('ZZPSS other goal');
    expect(Number(g.achieved_value || 0)).toBe(0);
    expect(g.deleted_at).toBeNull();
  });

  it("an employee cannot list someone else's goals; HR can", async () => {
    expect((await request(fx.asMe).get(`/api/performance/goals?employee_id=${fx.other}`)).status).toBe(403);
    const hr = await request(fx.asHR).get(`/api/performance/goals?employee_id=${fx.other}`);
    expect(hr.body.map(g => g.goal_title)).toEqual(['ZZPSS other goal']);
  });

  it('my-team lists direct reports for a lead, everyone for HR', async () => {
    expect((await request(fx.asLead).get('/api/performance/my-team')).body.map(e => e.id)).toEqual([fx.me]);
    expect((await request(fx.asMe).get('/api/performance/my-team')).body).toEqual([]);
    const hr = (await request(fx.asHR).get('/api/performance/my-team')).body.map(e => e.id).sort();
    expect(hr).toEqual([fx.lead, fx.me, fx.other].sort());
  });
});

describe("manager review: by the reporting manager, never one's own (2026-11-11)", () => {
  it('waits for the self-assessment', async () => {
    const res = await request(fx.asLead).post(`/api/performance/reviews/${fx.myReview}/manager-review`).send({ manager_rating: 4, final_rating: 4 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_NOT_SUBMITTED');
  });

  it('the self-assessment saves highlights as achievements', async () => {
    const res = await request(fx.asMe).post(`/api/performance/reviews/${fx.myReview}/self-review`)
      .send({ self_rating: 4, achievements: 'Shipped the release', challenges: 'Late spec' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('self_submitted');
    expect(res.body.achievements).toBe('Shipped the release');
  });

  it('the lead sees it in team-reviews; the employee has no team', async () => {
    const res = await request(fx.asLead).get('/api/performance/team-reviews');
    expect(res.body.map(r => [r.id, r.status, r.achievements])).toEqual([[fx.myReview, 'self_submitted', 'Shipped the release']]);
    expect((await request(fx.asMe).get('/api/performance/team-reviews')).body).toEqual([]);
  });

  it('the employee cannot manager-review their own; a manager-role outsider cannot either', async () => {
    const own = await request(fx.asMe).post(`/api/performance/reviews/${fx.myReview}/manager-review`).send({ manager_rating: 5, final_rating: 5 });
    expect(own.status).toBe(403);
    const outsider = await request(fx.asManager).post(`/api/performance/reviews/${fx.myReview}/manager-review`).send({ manager_rating: 5, final_rating: 5 });
    expect(outsider.status).toBe(403);
  });

  it('the lead (employee role) submits it; then the self-assessment is locked', async () => {
    const ok = await request(fx.asLead).post(`/api/performance/reviews/${fx.myReview}/manager-review`)
      .send({ manager_rating: 4, final_rating: 4, manager_comments: 'Good half' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('manager_submitted');
    expect(ok.body.manager_id).toBe(fx.lead);
    const locked = await request(fx.asMe).post(`/api/performance/reviews/${fx.myReview}/self-review`).send({ self_rating: 5 });
    expect(locked.status).toBe(409);
    await pool.query('DELETE FROM talent_assessment_history WHERE employee_id = $1', [fx.me]);
    await pool.query('DELETE FROM talent_assessments WHERE employee_id = $1', [fx.me]);
  });
});

describe('competencies: an employee sees and scores only their own', () => {
  it('the unfiltered read returns only their own scores', async () => {
    const res = await request(fx.asMe).get('/api/performance/competencies');
    expect(res.status).toBe(200);
    expect(res.body.map(c => c.subject)).toEqual(['ZZPSS Mine']);
  });

  it('asking for another employee by id still returns only their own', async () => {
    const res = await request(fx.asMe).get(`/api/performance/competencies?employee_id=${fx.other}`);
    expect(res.body.map(c => c.subject)).toEqual(['ZZPSS Mine']);
  });

  it('self-scoring someone else\'s review is refused', async () => {
    const res = await request(fx.asMe).post('/api/performance/competencies')
      .send({ review_id: fx.otherReview, employee_id: fx.other, scores: [{ competency_name: 'ZZPSS Theirs', self_score: 5 }] });
    expect(res.status).toBe(403);
    const { rows: [c] } = await pool.query(
      `SELECT self_score FROM performance_competencies WHERE review_id = $1`, [fx.otherReview]);
    expect(Number(c.self_score)).toBe(2);
  });

  it('self-scoring their own review is saved against them', async () => {
    const res = await request(fx.asMe).post('/api/performance/competencies')
      .send({ review_id: fx.myReview, employee_id: fx.other, scores: [{ competency_name: 'ZZPSS Mine', self_score: 5 }] });
    expect(res.status).toBe(200);
    const { rows: [c] } = await pool.query(
      `SELECT employee_id, self_score FROM performance_competencies WHERE review_id = $1`, [fx.myReview]);
    expect(c.employee_id).toBe(fx.me);
    expect(Number(c.self_score)).toBe(5);
  });
});
