/**
 * Learning Center — consolidation 2026-11-18.
 *
 *  - Gates: HR screens are the `training` module; a plain employee reaches only
 *    /my-learning, and never sees a test's answers.
 *  - Company isolation: another company's trainings, employees and tests reach
 *    nothing.
 *  - One flow: a passed test completes its training, the training raises the
 *    linked competency (ONE rating table), a short answer waits for HR review.
 *  - Refreshers: a mandatory training repeated every N months is compliant per
 *    series, overdue once N months pass, and a new round keeps the series.
 *  - Certificates past expiry are 'expired'; a library entry in use cannot be
 *    deleted; settings save (was a 500) and are read by enrolment rules.
 *  - Every report runs and none counts another company's people.
 *
 * Real routers and database; two throwaway companies, all rows removed after.
 * Requires migration 20261118000003.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { buildApp } = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, addUser } = await import('./helpers/isolatedCompany.js');
const { FIXTURE_CODE_SQL } = await import('../shared/employeeCode.js');
const routes = {
  training: (await import('../modules/hr/training.routes.js')).default,
  my: (await import('../modules/hr/my-learning.routes.js')).default,
  assessments: (await import('../modules/hr/assessments.routes.js')).default,
  certifications: (await import('../modules/hr/certifications.routes.js')).default,
  paths: (await import('../modules/hr/learning-paths.routes.js')).default,
  competencies: (await import('../modules/hr/competency.routes.js')).default,
  trainers: (await import('../modules/hr/trainers.routes.js')).default,
  reports: (await import('../modules/hr/lnd-reporting.routes.js')).default,
  settings: (await import('../modules/hr/lnd-settings.routes.js')).default,
  probationReviews: (await import('../probation/probationReviews.routes.js')).default,
  succession: (await import('../modules/hr/succession.routes.js')).default,
};
const { lndRange } = await import('../modules/hr/lnd/lndShared.js');
const { grade } = await import('../modules/hr/my-learning.routes.js');
const { validateQuestions } = await import('../modules/hr/assessments.routes.js');

const app = buildApp(
  ['/api/training', verifyToken, routes.training],
  ['/api/my-learning', verifyToken, routes.my],
  ['/api/assessments', verifyToken, routes.assessments],
  ['/api/certifications', verifyToken, routes.certifications],
  ['/api/learning-paths', verifyToken, routes.paths],
  ['/api/competencies', verifyToken, routes.competencies],
  ['/api/trainers', verifyToken, routes.trainers],
  ['/api/lnd-reports', verifyToken, routes.reports],
  ['/api/lnd-settings', verifyToken, routes.settings],
  ['/api/probation-reviews', routes.probationReviews],
  ['/api/succession', verifyToken, routes.succession],
);

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
let A, B, hrA, hrB, mgrA;
const E = {}; const EMP = {};

async function addEmployee(company, first, designation = 'ZZ Technician', department = 'ZZ Plant') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, designation, department)
     VALUES ($1, ${FIXTURE_CODE_SQL}, $2::text, 'Fixture', 'Active', '2025-04-01', $3, $4) RETURNING id`,
    [company.companyId, first, designation, department]);
  return r.id;
}
async function employeeLogin(company, employeeId, label) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
     VALUES ($1, $2, 'x', $3, true, 'employee', $4) RETURNING id`,
    [`${company.code} ${label}`, `${company.code.toLowerCase()}.${label}@test.invalid`, company.companyId, employeeId]);
  const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
  return { token: () => jwt.sign({ userId: u.id, role: 'employee', company_id: company.companyId, employee_id: employeeId }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}
const as = (who) => ({
  get: (p) => request(app).get(`/api${p}`).set('Authorization', `Bearer ${who.token()}`),
  post: (p, b) => request(app).post(`/api${p}`).set('Authorization', `Bearer ${who.token()}`).send(b),
  put: (p, b) => request(app).put(`/api${p}`).set('Authorization', `Bearer ${who.token()}`).send(b),
  del: (p) => request(app).delete(`/api${p}`).set('Authorization', `Bearer ${who.token()}`),
});

async function sweep(cid) {
  const c = [cid];
  const q = (s) => pool.query(s, c).catch(() => {});
  await q(`DELETE FROM probation_reviews WHERE company_id = $1`);
  await q(`DELETE FROM development_actions WHERE plan_id IN (SELECT id FROM development_plans WHERE company_id = $1)`);
  await q(`DELETE FROM development_plans WHERE company_id = $1`);
  await q(`DELETE FROM assessment_attempts WHERE company_id = $1 OR assessment_id IN (SELECT id FROM assessments WHERE company_id = $1)`);
  await q(`DELETE FROM assessments WHERE company_id = $1`);
  await q(`DELETE FROM employee_learning_paths WHERE company_id = $1`);
  await q(`DELETE FROM learning_paths WHERE company_id = $1`);
  await q(`DELETE FROM training_self_reviews WHERE company_id = $1`);
  await q(`DELETE FROM training_attendance WHERE company_id = $1`);
  await q(`UPDATE training_programs SET series_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM training_programs WHERE company_id = $1`);
  await q(`DELETE FROM trainers WHERE company_id = $1`);
  await q(`UPDATE employee_certifications SET renewed_from_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM employee_certifications WHERE company_id = $1`);
  await q(`DELETE FROM certifications WHERE company_id = $1`);
  await q(`DELETE FROM employee_competency_assessments WHERE company_id = $1`);
  await q(`DELETE FROM role_competencies WHERE company_id = $1`);
  await q(`DELETE FROM competency_framework WHERE company_id = $1`);
  await q(`DELETE FROM lnd_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

beforeAll(async () => {
  A = await createIsolatedCompany(pool, 'ZZLND');
  B = await createIsolatedCompany(pool, 'ZZLND');
  hrA = await addUser(pool, A, { label: 'hr', roleCode: 'hr' });
  hrB = await addUser(pool, B, { label: 'hr', roleCode: 'hr' });
  mgrA = await addUser(pool, A, { label: 'hrmgr', roleCode: 'hr_manager' });
  E.a1 = await addEmployee(A, 'Asha'); E.a2 = await addEmployee(A, 'Bala'); E.a3 = await addEmployee(A, 'Chitra', 'ZZ Clerk', 'ZZ Office');
  E.b1 = await addEmployee(B, 'Deepa');
  EMP.a1 = await employeeLogin(A, E.a1, 'asha');
  EMP.a2 = await employeeLogin(A, E.a2, 'bala');
}, 60000);

afterAll(async () => {
  for (const c of [A, B]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('helpers', () => {
  it('period presets cover 3 / 6 / 12 months, quarters, FY and the future', () => {
    const now = new Date(2026, 10, 18);
    expect(lndRange({ period: 'last3m' }, 'all', now)).toMatchObject({ from: '2026-08-18', to: '2026-11-18' });
    expect(lndRange({ period: 'last6m' }, 'all', now)).toMatchObject({ from: '2026-05-18' });
    expect(lndRange({ period: 'qtd' }, 'all', now)).toMatchObject({ from: '2026-10-01', to: '2026-12-31' });
    expect(lndRange({ period: 'last_quarter' }, 'all', now)).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(lndRange({ period: 'fytd' }, 'all', now)).toMatchObject({ from: '2026-04-01', to: '2027-03-31' });
    expect(lndRange({ period: 'next6m' }, 'all', now)).toMatchObject({ from: '2026-11-18', to: '2027-05-18' });
    expect(lndRange({ from: '2026-12-01', to: '2026-01-01' }, 'all', now)).toMatchObject({ from: '2026-01-01', to: '2026-12-01' });
    expect(lndRange({ period: "x'; DROP" }, 'all', now).period).toBe('all');
  });
  it('grades MCQ / true-false and leaves written answers for review', () => {
    const qs = [{ id: 1, question_type: 'mcq', correct_answer: 'CO2', marks: 2 }, { id: 2, question_type: 'true_false', correct_answer: 'True', marks: 1 },
      { id: 3, question_type: 'short_answer', marks: 2 }];
    expect(grade(qs, { 1: 'co2', 2: 'False', 3: 'text' })).toMatchObject({ earned: 2, total: 5, pending: true });
    expect(grade(qs, { 1: 'CO2', 2: 'True' })).toMatchObject({ earned: 3, pending: false });
  });
  it('rejects an MCQ whose answer is not an option', () => {
    expect(() => validateQuestions([{ question_text: 'Q', question_type: 'mcq', options: ['a', 'b'], correct_answer: 'c' }])).toThrow(/one of the options/);
    expect(validateQuestions([{ question_text: 'Q', question_type: 'true_false', correct_answer: 'true' }])[0].correct_answer).toBe('True');
  });
});

describe('access', () => {
  it('a plain employee is kept out of every HR screen', async () => {
    for (const p of ['/training/programs', '/assessments', '/certifications/employee', '/learning-paths', '/competencies/matrix', '/trainers', '/lnd-reports/overdue-training', '/lnd-settings']) {
      expect((await as(EMP.a1).get(p)).status, p).toBe(403);
    }
    expect((await as(EMP.a1).get('/my-learning/overview')).status).toBe(200);
  });

  it('settings save (was a 500) and validate', async () => {
    const ok = await as(hrA).put('/lnd-settings', { training_categories: ['Safety', 'Technical'], default_refresher_months: 6, allow_self_enrollment: true });
    expect(ok.status).toBe(200);
    expect(ok.body.training_categories).toEqual(['Safety', 'Technical']);
    expect((await as(hrA).put('/lnd-settings', { default_pass_score: 0 })).status).toBe(400);
    expect((await as(hrA).put('/lnd-settings', { training_categories: [] })).status).toBe(400);
  });
});

describe('training → test → skill', () => {
  let comp, prog, test;
  it('builds the training with a picked trainer and a linked skill', async () => {
    const ext = await as(hrA).post('/trainers', { name: 'ZZ Ext', trainer_type: 'external' });
    expect(ext.status).toBe(201);
    expect((await as(hrA).put(`/trainers/${ext.body.id}`, { specialization: 'Fire', employee_id: '' })).status).toBe(200);
    comp = (await as(hrA).post('/competencies', { name: 'ZZ Fire Safety', expected_level: 3 })).body;
    expect((await as(hrA).put('/competencies/role-requirements', { role_title: 'ZZ Technician', requirements: [{ competency_id: comp.id, required_level: 4 }] })).status).toBe(200);
    const r = await as(hrA).post('/training/programs', { title: 'ZZ Fire Drill', category: 'Safety', scheduled_date: day(3), is_mandatory: true,
      trainer_id: ext.body.id, competency_id: comp.id, max_participants: 2 });
    expect(r.status).toBe(201);
    prog = r.body;
    expect(prog.refresher_months).toBe(6); // default from settings
    expect(prog.trainer).toBe('ZZ Ext');
    expect((await as(hrB).get(`/training/programs/${prog.id}`)).status).toBe(404);
  });

  it('enrols with company + capacity checks', async () => {
    const r = await as(hrA).post(`/training/programs/${prog.id}/enroll`, { employee_ids: [E.a1, E.a2, E.a3, E.b1] });
    expect(r.status).toBe(200);
    expect(r.body.enrolled.sort()).toEqual([E.a1, E.a2].sort());
    expect(r.body.skipped.map(s => s.reason)).toEqual(expect.arrayContaining(['Training is full', 'Not an active employee of this company']));
    expect((await as(hrB).post(`/training/programs/${prog.id}/enroll`, { employee_ids: [E.b1] })).status).toBe(404);
  });

  it('serves the employee the test without answers; a pass completes the training and raises the skill', async () => {
    test = (await as(hrA).post('/assessments', { title: 'ZZ Quiz', program_id: prog.id, pass_score: 50 })).body;
    await as(hrA).put(`/assessments/${test.id}/questions`, { questions: [
      { question_text: 'Electrical fire?', question_type: 'mcq', options: ['Water', 'CO2'], correct_answer: 'CO2', marks: 2 }] });
    expect((await as(EMP.a1).get(`/assessments/${test.id}/questions`)).status).toBe(403);
    const st = await as(EMP.a1).post(`/my-learning/assessments/${test.id}/start`);
    expect(st.status).toBe(200);
    expect(st.body.questions[0]).not.toHaveProperty('correct_answer');
    const sub = await as(EMP.a1).post(`/my-learning/attempts/${st.body.attempt.id}/submit`, { answers: { [st.body.questions[0].id]: 'CO2' } });
    expect(sub.body).toMatchObject({ passed: true, score_pct: 100 });
    // someone else's attempt cannot be submitted
    const st2 = await as(EMP.a2).post(`/my-learning/assessments/${test.id}/start`);
    expect((await as(EMP.a1).post(`/my-learning/attempts/${st2.body.attempt.id}/submit`, { answers: {} })).status).toBe(404);
    const { rows: [en] } = await pool.query(`SELECT status, score FROM training_enrollments WHERE program_id = $1 AND employee_id = $2`, [prog.id, E.a1]);
    expect(en).toMatchObject({ status: 'completed' });
    expect(Number(en.score)).toBe(100);
    const { rows: [rt] } = await pool.query(`SELECT assessed_level, source FROM employee_competency_assessments WHERE employee_id = $1 AND competency_id = $2`, [E.a1, comp.id]);
    expect(rt.assessed_level).toBe(4);
    const sk = await as(hrA).get(`/competencies/employee/${E.a1}`);
    expect(sk.body.competencies.find(c => c.id === comp.id).required_level).toBe(4);
  });

  it('a written answer waits for HR review, then counts', async () => {
    const t2 = (await as(hrA).post('/assessments', { title: 'ZZ Written', pass_score: 60 })).body;
    await as(hrA).put(`/assessments/${t2.id}/questions`, { questions: [{ question_text: 'Explain', question_type: 'short_answer', marks: 10 }] });
    const st = await as(EMP.a2).post(`/my-learning/assessments/${t2.id}/start`);
    const sub = await as(EMP.a2).post(`/my-learning/attempts/${st.body.attempt.id}/submit`, { answers: { [st.body.questions[0].id]: 'An answer' } });
    expect(sub.body).toMatchObject({ pending_review: true, passed: null });
    expect((await as(hrA).post(`/assessments/attempts/${st.body.attempt.id}/review`, { marks: { [st.body.questions[0].id]: 11 } })).status).toBe(400);
    const rv = await as(hrA).post(`/assessments/attempts/${st.body.attempt.id}/review`, { marks: { [st.body.questions[0].id]: 7 } });
    expect(rv.body).toMatchObject({ passed: true, review_status: 'reviewed' });
    expect((await as(hrB).post(`/assessments/attempts/${st.body.attempt.id}/review`, { marks: {} })).status).toBe(404);
  });

  it('a manager-only rating route refuses the employee rating themself', async () => {
    expect((await as(EMP.a1).post(`/competencies/employee/${E.a1}/assess`, { assessments: [{ competency_id: comp.id, assessed_level: 5 }] })).status).toBe(403);
  });

  it('refreshers: overdue after N months, a new round keeps the series', async () => {
    await pool.query(`UPDATE training_enrollments SET completion_date = CURRENT_DATE - INTERVAL '7 months' WHERE program_id = $1 AND employee_id = $2`, [prog.id, E.a1]);
    let cp = (await as(hrA).get('/training/compliance')).body;
    const mine = cp.rows.find(r => r.employee_id === E.a1 && r.series_id === prog.id);
    expect(mine.status).toBe('overdue');
    // No target department / role: everyone in the company must do it.
    expect(cp.rows.find(r => r.employee_id === E.a3 && r.series_id === prog.id).status).toBe('not_done');
    const nr = await as(hrA).post(`/training/programs/${prog.id}/next-round`, { scheduled_date: day(30), enroll_previous: true });
    expect(nr.status).toBe(201);
    expect(nr.body.series_id).toBe(prog.id);
    cp = (await as(hrA).get('/training/compliance')).body;
    expect(cp.rows.find(r => r.employee_id === E.a1).next_scheduled).toBe(day(30));
    expect((await as(hrA).del(`/training/programs/${prog.id}`)).status).toBe(403); // hr may not delete
    expect((await as(mgrA).del(`/training/programs/${prog.id}`)).status).toBe(409); // has completions
  });
});

describe('certificates', () => {
  it('past expiry is expired; renewal and in-use protection', async () => {
    const c = (await as(hrA).post('/certifications/master', { name: 'ZZ Forklift', validity_months: 12, is_mandatory: true })).body;
    const r = await request(app).post('/api/certifications/employee').set('Authorization', `Bearer ${hrA.token()}`)
      .field('employee_id', String(E.a1)).field('certification_id', String(c.id)).field('issue_date', day(-400));
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('expired');
    const bad = await request(app).post('/api/certifications/employee').set('Authorization', `Bearer ${hrB.token()}`)
      .field('employee_id', String(E.a1)).field('certification_id', String(c.id)).field('issue_date', day(0));
    expect(bad.status).toBe(400);
    const rn = await request(app).post(`/api/certifications/employee/${r.body.id}/renew`).set('Authorization', `Bearer ${hrA.token()}`).field('issue_date', day(0));
    expect(rn.status).toBe(201);
    expect(rn.body.status).toBe('active');
    expect((await as(mgrA).del(`/certifications/master/${c.id}`)).status).toBe(409);
    const cov = (await as(hrA).get('/certifications/coverage')).body;
    expect(cov.summary).toMatchObject({ valid: 1, missing: 2 });
  });
});

describe('paths, self-service and reports', () => {
  it('prerequisites are enforced; unassign withdraws', async () => {
    const p1 = (await as(hrA).post('/training/programs', { title: 'ZZ Basics', scheduled_date: day(5) })).body;
    const p2 = (await as(hrA).post('/training/programs', { title: 'ZZ Advanced', scheduled_date: day(15) })).body;
    const lp = (await as(hrA).post('/learning-paths', { name: 'ZZ Path', due_days: 30 })).body;
    expect((await as(hrA).post('/learning-paths', { name: 'zz path' })).status).toBe(409);
    expect((await as(hrA).put(`/learning-paths/${lp.id}/items`, { items: [{ program_id: p2.id, prerequisite_program_id: p1.id }, { program_id: p1.id }] })).status).toBe(400);
    expect((await as(hrA).put(`/learning-paths/${lp.id}/items`, { items: [{ program_id: p1.id }, { program_id: p2.id, prerequisite_program_id: p1.id }] })).status).toBe(200);
    expect((await as(hrA).post(`/learning-paths/${lp.id}/assign`, { employee_ids: [E.a3, E.b1] })).body.assigned).toBe(1);
    const { rows: [en] } = await pool.query(`SELECT id FROM training_enrollments WHERE program_id = $1 AND employee_id = $2`, [p2.id, E.a3]);
    expect((await as(hrA).put(`/training/enrollments/${en.id}`, { status: 'completed' })).status).toBe(409);
    expect((await as(hrA).del(`/learning-paths/${lp.id}/assign/${E.a3}`)).status).toBe(200);
    const { rows: [w] } = await pool.query(`SELECT status FROM training_enrollments WHERE id = $1`, [en.id]);
    expect(w.status).toBe('withdrawn');
  });

  it('self-enrolment follows the settings and department targeting', async () => {
    const open = (await as(hrA).post('/training/programs', { title: 'ZZ Open', scheduled_date: day(9) })).body;
    const other = (await as(hrA).post('/training/programs', { title: 'ZZ Office only', scheduled_date: day(9), target_department: 'ZZ Office' })).body;
    expect((await as(EMP.a2).post(`/my-learning/enroll/${other.id}`)).status).toBe(403);
    expect((await as(EMP.a2).post(`/my-learning/enroll/${open.id}`)).status).toBe(200);
    await as(hrA).put('/lnd-settings', { allow_self_enrollment: false });
    expect((await as(EMP.a1).post(`/my-learning/enroll/${open.id}`)).status).toBe(403);
    await as(hrA).put('/lnd-settings', { allow_self_enrollment: true });
  });

  it('every report runs, with filters, and counts only this company', async () => {
    const list = (await as(hrA).get('/lnd-reports')).body;
    expect(list.length).toBeGreaterThanOrEqual(15);
    for (const k of list) {
      for (const qs of ['period=all', 'period=last6m&department=ZZ%20Plant', 'period=custom&from=2026-01-01&to=2027-12-31&category=Safety&mandatory=true']) {
        const r = await as(hrA).get(`/lnd-reports/${k}?${qs}&employee_id=${E.a1}`);
        expect(r.status, `${k}?${qs}`).toBe(200);
      }
    }
    const b = (await as(hrB).get('/lnd-reports/mandatory-compliance?period=all')).body;
    expect(b).toEqual([]);
    const dash = await as(hrA).get('/training/dashboard?period=all');
    expect(dash.status).toBe(200);
    expect(dash.body.kpis.headcount).toBe(3);
    expect((await as(hrA).get('/lnd-reports/nope')).status).toBe(404);
  });
});

describe('before / after self-review and the cost filter', () => {
  it('pre opens while enrolled, post only after completion; the comparison and report agree', async () => {
    const p = (await as(hrA).post('/training/programs', { title: 'ZZ Self Review', scheduled_date: day(4), self_review_items: ['I can do X'] })).body;
    expect(p.self_review_enabled).toBe(true);
    await as(hrA).post(`/training/programs/${p.id}/enroll`, { employee_ids: [E.a1] });
    const { rows: [en] } = await pool.query(`SELECT id FROM training_enrollments WHERE program_id = $1 AND employee_id = $2`, [p.id, E.a1]);
    const url = `/my-learning/enrollments/${en.id}/self-review`;
    expect((await as(EMP.a1).post(url, { phase: 'post', knowledge: 4, confidence: 4, item_ratings: { 'I can do X': 4 } })).status).toBe(409);
    expect((await as(EMP.a1).post(url, { phase: 'pre', knowledge: 2, confidence: 3 })).status).toBe(400); // statement not rated
    expect((await as(EMP.a1).post(url, { phase: 'pre', knowledge: 2, confidence: 3, item_ratings: { 'I can do X': 1 } })).status).toBe(200);
    expect((await as(EMP.a2).post(url, { phase: 'pre', knowledge: 2, confidence: 3, item_ratings: { 'I can do X': 1 } })).status).toBe(404); // not theirs
    await as(hrA).put(`/training/enrollments/${en.id}`, { status: 'completed' });
    expect((await as(EMP.a1).post(url, { phase: 'pre', knowledge: 5, confidence: 5, item_ratings: { 'I can do X': 5 } })).status).toBe(409);
    expect((await as(EMP.a1).post(url, { phase: 'post', knowledge: 4, confidence: 5, item_ratings: { 'I can do X': 4 }, comments: 'Better' })).status).toBe(200);
    const s = (await as(hrA).get(`/training/programs/${p.id}`)).body.self_review.summary;
    expect(s).toMatchObject({ both_done: 1, knowledge: { before: 2, after: 4, change: 2 }, confidence: { before: 3, after: 5, change: 2 } });
    expect(s.items[0]).toMatchObject({ item: 'I can do X', before: 1, after: 4, change: 3 });
    const rep = (await as(hrA).get('/lnd-reports/self-review-comparison?period=all')).body.find(r => r.training === 'ZZ Self Review');
    expect(rep).toMatchObject({ knowledge_change: 2, confidence_change: 2, before_done: 1, after_done: 1 });
    expect((await as(hrB).get('/lnd-reports/self-review-people?period=all')).body).toEqual([]);
  });

  it('filters trainings by what they cost', async () => {
    const cheap = (await as(hrA).post('/training/programs', { title: 'ZZ Cheap', scheduled_date: day(6) })).body;
    const dear = (await as(hrA).post('/training/programs', { title: 'ZZ Dear', scheduled_date: day(6) })).body;
    await as(hrA).post(`/training/programs/${cheap.id}/costs`, { cost_type: 'venue', amount: 500 });
    await as(hrA).post(`/training/programs/${dear.id}/costs`, { cost_type: 'trainer_fee', amount: 40000 });
    const titles = async (q) => (await as(hrA).get(`/training/programs?${q}`)).body.map(r => r.title);
    expect(await titles('cost_min=10000')).toContain('ZZ Dear');
    expect(await titles('cost_min=10000')).not.toContain('ZZ Cheap');
    expect(await titles('cost_max=1000&q=ZZ%20C')).toEqual(['ZZ Cheap']);
    const rep = (await as(hrA).get('/lnd-reports/training-cost?period=all&cost_min=10000')).body.map(r => r.training);
    expect(rep).toEqual(['ZZ Dear']);
  });
});

describe('Probation and Succession use the learning record', () => {
  it('a probation review shows the learning record to HR and the assigned reviewer only', async () => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO probation_reviews (company_id, employee_id, cycle_no, period_start, original_end_date, reviewer_employee_id, reviewer_due_date)
       VALUES ($1, $2, 1, CURRENT_DATE - 60, CURRENT_DATE + 30, $3, CURRENT_DATE + 7) RETURNING id`, [A.companyId, E.a2, E.a1]);
    const hr = await as(hrA).get(`/probation-reviews/${r.id}/learning`);
    expect(hr.status).toBe(200);
    expect(hr.body.totals).toHaveProperty('completed');
    expect(hr.body.totals).toHaveProperty('mandatory_required');
    expect((await as(EMP.a1).get(`/probation-reviews/${r.id}/learning`)).status).toBe(200); // the reviewer
    expect((await as(EMP.a2).get(`/probation-reviews/${r.id}/learning`)).status).toBe(403); // the employee themself
    expect((await as(hrB).get(`/probation-reviews/${r.id}/learning`)).status).toBe(404);  // another company
  });

  it('a succession training action enrols the employee and completes with the training', async () => {
    const prog = (await as(hrA).post('/training/programs', { title: 'ZZ Leadership Course', scheduled_date: day(12) })).body;
    const { rows: [plan] } = await pool.query(
      `INSERT INTO development_plans (employee_id, plan_title, company_id, status) VALUES ($1, 'ZZ plan', $2, 'active') RETURNING id`, [E.a3, A.companyId]);
    const res = await as(hrA).post(`/succession/development-plans/${plan.id}/actions`, { action_type: 'training', title: 'Leadership course', linked_training_id: prog.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ linked_training_id: prog.id, status: 'in_progress' });
    const { rows: [en] } = await pool.query(`SELECT id, status FROM training_enrollments WHERE program_id = $1 AND employee_id = $2`, [prog.id, E.a3]);
    expect(en.status).toBe('enrolled');
    expect((await as(hrA).post(`/succession/development-plans/${plan.id}/actions`, { action_type: 'task', title: 'x', linked_training_id: prog.id })).status).toBe(400);
    await as(hrA).put(`/training/enrollments/${en.id}`, { status: 'completed', score: 80 });
    const { rows: [a] } = await pool.query(`SELECT status FROM development_actions WHERE id = $1`, [res.body.id]);
    expect(a.status).toBe('completed');
    const { rows: [p] } = await pool.query(`SELECT overall_progress FROM development_plans WHERE id = $1`, [plan.id]);
    expect(Number(p.overall_progress)).toBe(100);
  });
});
