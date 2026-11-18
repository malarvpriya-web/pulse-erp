/**
 * Recruitment Dashboard review 2026-11-17 — the four feeds the page reads,
 * against a real database:
 *   - Pending offers = awaiting answer (draft, pending approval, sent), the
 *     same number My Work shows (it counted 'sent' only).
 *   - Source counts are numbers (a string count drew an empty pie).
 *   - The period and department filters narrow hires, sources and stages;
 *     backlog numbers ignore the period.
 *   - Future opportunity / Talent Bank move the primary application with the
 *     candidate, so the stage chart and the job's board agree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }          = await import('../config/db.js');
const { default: recruitRouter } = await import('../modules/recruitment/routes/recruitment.routes.js');
const { default: ciRouter }      = await import('../modules/recruitment/routes/candidateIntelligence.routes.js');

const TAG = 'ZZRDB';
const ids = {};
let api;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const c = rows[0]?.id;
  if (c) {
    for (const sql of [
      `DELETE FROM candidate_recontact WHERE company_id = $1`,
      `DELETE FROM talent_pool_members WHERE company_id = $1`,
      `DELETE FROM talent_pools WHERE company_id = $1`,
      `DELETE FROM interview_schedules WHERE company_id = $1`,
      `DELETE FROM offer_letters WHERE company_id = $1`,
      `DELETE FROM candidate_activity WHERE company_id = $1`,
      `DELETE FROM candidate_applications WHERE company_id = $1`,
      `DELETE FROM candidate_stage_history WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = $1)`,
      `DELETE FROM candidates WHERE company_id = $1`,
      `DELETE FROM job_openings WHERE company_id = $1`,
      `DELETE FROM job_requisitions WHERE company_id = $1`,
    ]) await pool.query(sql, [c]).catch(() => {});
  }
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE LOWER($1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM roles WHERE code LIKE $1`, [`${TAG}%`]);
  if (c) await pool.query(`DELETE FROM companies WHERE id = $1`, [c]).catch(() => {});
}

async function candidate(name, { job, stage = 'applied', source = 'careers', status = 'active', hiredDaysAgo = null, createdDaysAgo = 0 }) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO candidates (company_id, full_name, email, phone, applied_job_id, current_stage, overall_status, source,
                             hired_at, created_at)
     VALUES ($1, $2, $3, '9000000000', $4, $5, $6, $7,
             CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $8::int) END,
             NOW() - make_interval(days => $9::int))
     RETURNING id`,
    [ids.company, `${TAG} ${name}`, `${TAG.toLowerCase()}.${name.toLowerCase()}@test.invalid`, job, stage, status, source,
     hiredDaysAgo, createdDaysAgo]);
  await pool.query(
    `INSERT INTO candidate_applications (candidate_id, job_opening_id, stage, status, company_id, is_primary, origin)
     VALUES ($1, $2, $3, 'active', $4, TRUE, 'applied')`, [c.id, job, stage, ids.company]);
  return c.id;
}

beforeAll(async () => {
  await sweep();
  ids.company = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, TAG])).rows[0].id;
  const role = (await pool.query(`INSERT INTO roles (role_name, code, is_active) VALUES ($1, $2, true) RETURNING id`, [`${TAG} rec`, `${TAG}_REC`])).rows[0].id;
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_export)
     VALUES ($1, 'recruitment', true, true, true, true, true)`, [role]);
  const user = (await pool.query(`INSERT INTO users (email, role, is_active) VALUES ($1, 'employee', true) RETURNING id`, [`${TAG}.rec@test.invalid`])).rows[0].id;
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [user, role]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: user, id: user, roles: [`${TAG}_rec`], role: `${TAG}_rec`, company_id: ids.company };
    req.scope = { company_id: ids.company };
    next();
  });
  app.use('/api/recruitment', ciRouter);
  app.use('/api/recruitment', recruitRouter);
  api = app;

  const req = async (dept, n) => (await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions)
     VALUES ($1, $2, $3, 'open', $4) RETURNING id`, [`${TAG} ${dept}`, dept, ids.company, n])).rows[0].id;
  const opening = async (dept, reqId, status = 'open') => (await pool.query(
    `INSERT INTO job_openings (requisition_id, job_title, department, company_id, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [reqId, `${TAG} ${dept}`, dept, ids.company, status])).rows[0].id;
  ids.eng = await opening('Engineering', await req('Engineering', 3));
  ids.svc = await opening('Service', await req('Service', 1));
  await opening('Service', null, 'closed');

  ids.a = await candidate('Alpha', { job: ids.eng, stage: 'applied', source: 'careers' });
  ids.b = await candidate('Bravo', { job: ids.eng, stage: 'screening', source: 'careers' });
  ids.c = await candidate('Charlie', { job: ids.svc, stage: 'screening', source: 'referral' });
  // Hired 10 days in, 5 days ago (this month) and one hired 400 days ago.
  ids.h1 = await candidate('Hotel', { job: ids.eng, stage: 'hired', status: 'hired', hiredDaysAgo: 5, createdDaysAgo: 15, source: 'linkedin' });
  ids.h2 = await candidate('India', { job: ids.svc, stage: 'hired', status: 'hired', hiredDaysAgo: 400, createdDaysAgo: 430, source: 'linkedin' });

  // One live (draft / pending / sent) offer per candidate — migration
  // 20261117000008 enforces it — so the live ones go to different people.
  const offerCandidate = { draft: ids.c, pending_approval: ids.b, sent: ids.h1, accepted: ids.b, declined: ids.b };
  for (const st of ['draft', 'pending_approval', 'sent', 'accepted', 'declined']) {
    await pool.query(
      `INSERT INTO offer_letters (candidate_id, job_opening_id, offered_salary, company_id, offer_status)
       VALUES ($1, $2, 500000, $3, $4)`,
      [offerCandidate[st], st === 'draft' ? ids.svc : ids.eng, ids.company, st]);
  }
  // An offer with no job of its own: its department is the candidate's applied
  // job (India applied to Service).
  await pool.query(
    `INSERT INTO offer_letters (candidate_id, job_opening_id, offered_salary, company_id, offer_status)
     VALUES ($1, NULL, 500000, $2, 'sent')`, [ids.h2, ids.company]);
  // Interviews today: Bravo on the Engineering job; Charlie with no job (→ Service).
  await pool.query(
    `INSERT INTO interview_schedules (candidate_id, company_id, job_opening_id, interview_date, status)
     VALUES ($1, $3, $4, CURRENT_DATE, 'scheduled'), ($2, $3, NULL, CURRENT_DATE, 'scheduled')`,
    [ids.b, ids.c, ids.company, ids.eng]);
}, 60000);

afterAll(async () => { await sweep(); });

describe('Recruitment Dashboard — headline numbers', () => {
  it('counts offers awaiting an answer (draft, approval, sent) — the same set as My Work', async () => {
    const dash = await request(api).get('/api/recruitment/dashboard-summary');
    expect(dash.status).toBe(200);
    expect(dash.body.pending_offers).toBe(4);
    const wq = await request(api).get('/api/recruitment/work-queue');
    expect(wq.status).toBe(200);
    expect(wq.body.counts.offers_pending).toBe(dash.body.pending_offers);
  });

  it('open roles and seats to fill come from open openings only, seats from the requisition', async () => {
    const { body } = await request(api).get('/api/recruitment/dashboard-summary');
    expect(body.open_positions).toBe(2);   // the closed Service opening is out
    expect(body.open_headcount).toBe(4);   // 3 + 1
  });

  it('hires follow the period and say which period', async () => {
    const mtd = await request(api).get('/api/recruitment/dashboard-summary?period=mtd');
    expect(mtd.body.period_label).toBe('This month');
    // hired 5 days ago is in "this month" unless today is within the first 5 days
    const inMonth = new Date(Date.now() - 5 * 86400000).getMonth() === new Date().getMonth();
    expect(mtd.body.hired_in_period).toBe(inMonth ? 1 : 0);
    const all = await request(api).get('/api/recruitment/dashboard-summary?period=all');
    expect(all.body.hired_in_period).toBe(2);
  });

  it('department narrows backlog numbers; offers through their job opening', async () => {
    const { body } = await request(api).get('/api/recruitment/dashboard-summary?department=Service&period=all');
    expect(body.open_positions).toBe(1);
    expect(body.active_candidates).toBe(1);   // Charlie
    expect(body.pending_offers).toBe(2);      // the draft on the Service job + the job-less one for India
    expect(body.hired_in_period).toBe(1);     // India
    expect(body.interviews_today).toBe(1);    // Charlie's, through his applied job
    const all = await request(api).get('/api/recruitment/dashboard-summary');
    expect(all.body.interviews_today).toBe(2);
  });

  it('the Interviews and Offers lists filter by department with the same rule as the tiles', async () => {
    const dash = (await request(api).get('/api/recruitment/dashboard-summary?department=Service')).body;

    const iv = await request(api).get(`/api/recruitment/interviews?status=scheduled&interview_date=${
      (await pool.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d}&department=Service`);
    expect(iv.status).toBe(200);
    expect(iv.body.length).toBe(dash.interviews_today);
    expect(iv.body.every(r => r.department === 'Service')).toBe(true);

    const offers = await request(api).get('/api/recruitment/offers?department=Service');
    expect(offers.status).toBe(200);
    const unanswered = offers.body.filter(o => ['draft', 'pending_approval', 'sent'].includes(o.offer_status));
    expect(unanswered.length).toBe(dash.pending_offers);
    expect(offers.body.every(o => o.department === 'Service')).toBe(true);

    // Without the filter every offer carries its department for the page's dropdown.
    const everything = await request(api).get('/api/recruitment/offers');
    expect(everything.body.length).toBe(6);
    expect(new Set(everything.body.map(o => o.department))).toEqual(new Set(['Engineering', 'Service']));
  });
});

describe('Recruitment Dashboard — stages and sources', () => {
  it('source counts are numbers, not strings', async () => {
    const res = await request(api).get('/api/recruitment/analytics/source');
    expect(res.status).toBe(200);
    for (const r of res.body) expect(typeof r.count).toBe('number');
    const by = Object.fromEntries(res.body.map(r => [r.source, r.count]));
    expect(by).toEqual({ careers: 2, linkedin: 2, referral: 1 });
  });

  it('sources follow the period (when they came in) and the department', async () => {
    const fy = await request(api).get('/api/recruitment/analytics/source?period=last90');
    const by = Object.fromEntries(fy.body.map(r => [r.source, r.count]));
    expect(by.linkedin).toBe(1);              // India came in 430 days ago
    const svc = await request(api).get('/api/recruitment/analytics/source?department=Service');
    expect(Object.fromEntries(svc.body.map(r => [r.source, r.count]))).toEqual({ referral: 1, linkedin: 1 });
  });

  it('stage counts filter by department', async () => {
    const res = await request(api).get('/api/recruitment/pipeline-summary?department=Engineering');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.map(r => [r.stage, r.count]));
    expect(by).toEqual({ applied: 1, screening: 1, hired: 1 });
  });

  it('a future opportunity moves the primary application with the candidate', async () => {
    const res = await request(api).post(`/api/recruitment/candidates/${ids.a}/recontact`)
      .send({ recontact_on: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), reason: 'future_opening' });
    expect(res.status).toBeLessThan(300);
    const { rows: [r] } = await pool.query(
      `SELECT c.current_stage, a.stage AS app_stage
         FROM candidates c JOIN candidate_applications a ON a.candidate_id = c.id AND a.is_primary
        WHERE c.id = $1`, [ids.a]);
    expect(r.current_stage).toBe('future_use');
    expect(r.app_stage).toBe('future_use');
  });
});
