/**
 * 360° feedback, through the REAL router on the REAL test database (2026-11-11).
 *
 * performance_feedback.employee_id / feedback_provider_id are employees.id, but
 * the router compared them with the LOGIN id: nobody saw feedback to give or
 * about themselves, and no one could submit or decline. Also: an anonymous
 * giver's name reached the person reviewed, and the aggregate selected a
 * column that does not exist.
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
const { default: router } = await import('../modules/performance/routes/feedback360.routes.js');
const { createIsolatedCompany, dropIsolatedCompany } = await import('./helpers/isolatedCompany.js');

const fx = {};
// Login ids deliberately far from the employee ids, so a userId/employee_id mix-up cannot pass by accident.
function appAs({ userId, roles, employeeId }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, role: roles[0], roles, employee_id: employeeId, company_id: fx.co.companyId };
    req.scope = { company_id: fx.co.companyId };
    next();
  });
  app.use('/api/performance/feedback', router);
  return app;
}
async function employee(label) {
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, department, joining_date)
     VALUES ($1, $2, 'Zz', $3, $4, 'Active', 'QA', '2020-01-01') RETURNING id`,
    [fx.co.companyId, `EMP975${String(Date.now() % 1000).padStart(3, '0')}${label.length}`, label, `${fx.co.code.toLowerCase()}.${label}@test.invalid`]);
  return e.id;
}
const fb = async (about, from, extra = {}) => (await pool.query(
  `INSERT INTO performance_feedback (employee_id, feedback_provider_id, company_id, relationship, is_anonymous, status, overall_score, feedback_text)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
  [about, from, fx.co.companyId, extra.relationship || 'peer', !!extra.anonymous, extra.status || 'pending', extra.score ?? null, extra.text ?? null])).rows[0].id;

beforeAll(async () => {
  fx.co = await createIsolatedCompany(pool, 'ZZF36');
  fx.ann = await employee('ann'); fx.bob = await employee('bobby'); fx.cat = await employee('catherine');
  fx.asAnn = appAs({ userId: 990000201, roles: ['employee'], employeeId: fx.ann });
  fx.asBob = appAs({ userId: 990000202, roles: ['employee'], employeeId: fx.bob });
  fx.pendingAnnGives = await fb(fx.bob, fx.ann, { relationship: 'peer' });
  fx.anonAboutAnn = await fb(fx.ann, fx.cat, { relationship: 'subordinate', anonymous: true, status: 'submitted', score: 4, text: 'kind' });
  fx.namedAboutAnn = await fb(fx.ann, fx.bob, { relationship: 'peer', status: 'submitted', score: 3, text: 'ok' });
});

afterAll(async () => {
  if (!fx.co) return;
  await pool.query('DELETE FROM performance_feedback WHERE company_id = $1', [fx.co.companyId]);
  await pool.query('DELETE FROM employees WHERE company_id = $1', [fx.co.companyId]);
  await dropIsolatedCompany(pool, fx.co.companyId);
});

describe('360 feedback is keyed on the employee, not the login', () => {
  it('"Feedback to Give" lists what the caller is asked to give', async () => {
    const res = await request(fx.asAnn).get('/api/performance/feedback?as=reviewer');
    expect(res.status).toBe(200);
    expect(res.body.map(r => r.id)).toEqual([fx.pendingAnnGives]);
  });

  it('"Feedback About Me" lists feedback about the caller, with an anonymous giver hidden', async () => {
    const res = await request(fx.asAnn).get('/api/performance/feedback?as=reviewee');
    expect(res.body.map(r => r.id).sort()).toEqual([fx.anonAboutAnn, fx.namedAboutAnn].sort());
    const anon = res.body.find(r => r.id === fx.anonAboutAnn);
    expect(anon.provider_name).toBeNull();
    expect(anon.feedback_provider_id).toBeNull();
    expect(res.body.find(r => r.id === fx.namedAboutAnn).provider_name).toBeTruthy();
  });

  it('an employee asking for everything still gets only their own', async () => {
    const res = await request(fx.asBob).get('/api/performance/feedback');
    expect(res.body.every(r => r.employee_id === fx.bob)).toBe(true);
  });

  it('only the giver submits; a score must be 1–5; the giver can then edit it', async () => {
    const notMine = await request(fx.asBob).patch(`/api/performance/feedback/${fx.pendingAnnGives}/submit`).send({ overall_score: 5 });
    expect(notMine.status).toBe(403);
    const bad = await request(fx.asAnn).patch(`/api/performance/feedback/${fx.pendingAnnGives}/submit`).send({ overall_score: 9 });
    expect(bad.status).toBe(400);
    const ok = await request(fx.asAnn).patch(`/api/performance/feedback/${fx.pendingAnnGives}/submit`)
      .send({ overall_score: 4, feedback_text: 'Helpful', strengths: 'Clear', improvements: 'Faster replies' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('submitted');
    const again = await request(fx.asAnn).patch(`/api/performance/feedback/${fx.pendingAnnGives}/submit`).send({ overall_score: 3, feedback_text: 'Edited' });
    expect(again.status).toBe(200);
    expect(Number(again.body.overall_score)).toBe(3);
    expect(again.body.feedback_text).toBe('Edited');
    expect(new Date(again.body.submitted_at).getTime()).toBe(new Date(ok.body.submitted_at).getTime());
  });

  it('feedback in a closed appraisal cycle cannot be edited; a declined request cannot be submitted', async () => {
    const { rows: [cy] } = await pool.query(
      `INSERT INTO review_cycles (name, status, company_id, cycle_type) VALUES ('ZZF36 closed', 'completed', $1, 'annual') RETURNING id`, [fx.co.companyId]);
    const id = await fb(fx.cat, fx.ann, { status: 'submitted', score: 4 });
    await pool.query('UPDATE performance_feedback SET cycle_id = $1 WHERE id = $2', [cy.id, id]);
    expect((await request(fx.asAnn).patch(`/api/performance/feedback/${id}/submit`).send({ overall_score: 2 })).status).toBe(409);
    const declined = await fb(fx.cat, fx.ann, { status: 'declined' });
    expect((await request(fx.asAnn).patch(`/api/performance/feedback/${declined}/submit`).send({ overall_score: 2 })).status).toBe(409);
    await pool.query('DELETE FROM performance_feedback WHERE cycle_id = $1', [cy.id]);
    await pool.query('DELETE FROM review_cycles WHERE id = $1', [cy.id]);
  });

  it('the giver can decline a pending request; nobody else can', async () => {
    const id = await fb(fx.cat, fx.bob);
    expect((await request(fx.asAnn).patch(`/api/performance/feedback/${id}/decline`)).status).toBe(404);
    const ok = await request(fx.asBob).patch(`/api/performance/feedback/${id}/decline`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('declined');
  });

  it('the manager aggregate works and keeps anonymous givers anonymous', async () => {
    const hr = appAs({ userId: 990000203, roles: ['hr'], employeeId: null });
    const res = await request(hr).get(`/api/performance/feedback/aggregate/${fx.ann}?min_submissions=2`);
    expect(res.status).toBe(200);
    expect(res.body.anonymity_threshold_met).toBe(true);
    const reviewers = res.body.feedback_comments.map(c => c.reviewer);
    expect(reviewers).toContain(null);
    expect(reviewers.filter(Boolean)).toHaveLength(1);
  });
});

describe('requesting 360 feedback (2026-11-11)', () => {
  it("the employee's reporting manager asks (plain employee role); a duplicate is refused", async () => {
    const dan = await employee('dan-the-report');
    await pool.query('UPDATE employees SET reporting_manager_id = $1 WHERE id = $2', [fx.bob, dan]);
    const ok = await request(fx.asBob).post('/api/performance/feedback')
      .send({ employee_id: dan, feedback_provider_id: fx.ann, relationship: 'peer' });
    expect(ok.status).toBe(201);
    const dup = await request(fx.asBob).post('/api/performance/feedback')
      .send({ employee_id: dan, feedback_provider_id: fx.ann, relationship: 'peer' });
    expect(dup.status).toBe(409);
    // It now waits in Ann's "Feedback to Give".
    const give = await request(fx.asAnn).get('/api/performance/feedback?as=reviewer');
    expect(give.body.some(r => r.id === ok.body.id)).toBe(true);
  });

  it("someone who is not the employee's manager cannot ask", async () => {
    const res = await request(fx.asAnn).post('/api/performance/feedback')
      .send({ employee_id: fx.cat, feedback_provider_id: fx.bob, relationship: 'peer' });
    expect(res.status).toBe(403);
  });

  it("'self' only when the giver is the employee", async () => {
    const hr = appAs({ userId: 990000204, roles: ['hr'], employeeId: null });
    expect((await request(hr).post('/api/performance/feedback').send({ employee_id: fx.cat, feedback_provider_id: fx.ann, relationship: 'self' })).status).toBe(400);
    expect((await request(hr).post('/api/performance/feedback').send({ employee_id: fx.cat, feedback_provider_id: fx.cat, relationship: 'self' })).status).toBe(201);
  });

  it('the list of people to ask is for managers and HR only', async () => {
    expect((await request(fx.asAnn).get('/api/performance/feedback/people')).status).toBe(403);
    const lead = await request(fx.asBob).get('/api/performance/feedback/people');
    expect(lead.status).toBe(200);
    expect(Object.keys(lead.body[0]).sort()).toEqual(['department', 'designation', 'id', 'name', 'reporting_manager_id']);
  });
});
