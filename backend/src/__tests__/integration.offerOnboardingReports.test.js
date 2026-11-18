/**
 * Offer & Onboarding + Reports & Setup review (2026-11-17), against a real database.
 *
 *  Offers   — one live offer per candidate; decline / withdraw need a reason
 *             (stored, and on the candidate's activity); a sent offer can be
 *             extended but not re-priced; an accepted offer cannot be withdrawn;
 *             an expired offer needs accept_late; submitting needs CTC + joining
 *             date; accepting moves the primary application to hired too.
 *  Reports  — "to" date includes its own day; department filter applies to
 *             every report; vacancy aging is point-in-time; dept pipeline lists
 *             every stage; offers report; forecast counts requisitions.
 *  Templates— one active template per event; Duplicate makes an inactive copy.
 *  Creation — the waiting list shows a candidate once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }          = await import('../config/db.js');
const { default: recruitRouter } = await import('../modules/recruitment/routes/recruitment.routes.js');

const TAG = 'ZZOOR';
const ids = {};
const localDay = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let api;
let headApi;
const { default: settingsRouter } = await import('../modules/admin/settings-status.routes.js');
const { canApproveOffer } = await import('../modules/recruitment/requisitionAccess.js');
function appAs(userId, { roles = [`${TAG}_rec`, 'hr'], employee = () => ids.employee } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, id: userId, roles, role: roles[0], company_id: ids.company, employee_id: employee() };
    req.scope = { company_id: ids.company };
    next();
  });
  app.use('/api/recruitment', recruitRouter);
  app.use('/api/settings', settingsRouter);
  return app;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const c = rows[0]?.id;
  if (c) {
    for (const sql of [
      `DELETE FROM offer_letters WHERE company_id = $1`,
      `DELETE FROM recruitment_employee_creation_log WHERE company_id = $1`,
      `DELETE FROM candidate_activity WHERE company_id = $1`,
      `DELETE FROM candidate_applications WHERE company_id = $1`,
      `DELETE FROM candidate_stage_history WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = $1)`,
      `DELETE FROM hr_onboarding_checklist_progress WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`,
      `DELETE FROM employee_salary_assignments WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`,
      `DELETE FROM employees WHERE company_id = $1 AND source_candidate_id IS NOT NULL`,
      `DELETE FROM candidates WHERE company_id = $1`,
      `DELETE FROM job_openings WHERE company_id = $1`,
      `DELETE FROM job_requisitions WHERE company_id = $1`,
      `DELETE FROM email_templates WHERE company_id = $1`,
      `DELETE FROM company_settings WHERE company_id = $1`,
      `DELETE FROM employees WHERE company_id = $1`,
    ]) await pool.query(sql, [c]).catch(() => {});
  }
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE LOWER($1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM roles WHERE code LIKE $1`, [`${TAG}%`]);
  if (c) await pool.query(`DELETE FROM companies WHERE id = $1`, [c]).catch(() => {});
}

async function candidate(name, { job = ids.eng, stage = 'offer', status = 'active', createdDaysAgo = 0 } = {}) {
  const res = await request(api).post('/api/recruitment/candidates').send({
    full_name: `${TAG} ${name}`, email: `${TAG.toLowerCase()}.${name.toLowerCase()}@test.invalid`, applied_job_id: job, source: 'referral',
  });
  expect(res.status).toBe(201);
  await pool.query(
    `UPDATE candidates SET current_stage = $2, overall_status = $3, created_at = NOW() - ($4 || ' days')::interval WHERE id = $1`,
    [res.body.id, stage, status, String(createdDaysAgo)]);
  await pool.query(`UPDATE candidate_applications SET stage = $2 WHERE candidate_id = $1 AND is_primary`, [res.body.id, stage]);
  return res.body.id;
}

beforeAll(async () => {
  await sweep();
  ids.company = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, TAG])).rows[0].id;
  ids.employee = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, 'Recruiter', $2) RETURNING id`,
    [TAG, ids.company])).rows[0].id;
  const role = (await pool.query(`INSERT INTO roles (role_name, code, is_active) VALUES ($1, $2, true) RETURNING id`, [`${TAG} rec`, `${TAG}_REC`])).rows[0].id;
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_export)
     VALUES ($1, 'recruitment', true, true, true, true, true)`, [role]);
  const user = (await pool.query(`INSERT INTO users (email, role, is_active) VALUES ($1, 'employee', true) RETURNING id`, [`${TAG}.rec@test.invalid`])).rows[0].id;
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [user, role]);
  api = appAs(user);
  // A Finance department head (department_head role → own employee department).
  ids.headEmp = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, department) VALUES (${FIXTURE_CODE_SQL}, $1, 'Head', $2, 'Finance') RETURNING id`,
    [TAG, ids.company])).rows[0].id;
  const headRole = (await pool.query(`SELECT id FROM roles WHERE code = 'department_head' LIMIT 1`)).rows[0]?.id;
  const headUser = (await pool.query(`INSERT INTO users (email, role, is_active, employee_id) VALUES ($1, 'employee', true, $2) RETURNING id`, [`${TAG}.head@test.invalid`, ids.headEmp])).rows[0].id;
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [headUser, role]);
  if (headRole) await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [headUser, headRole]);
  headApi = appAs(headUser, { roles: ['department_head', `${TAG}_rec`], employee: () => ids.headEmp });

  ids.req = (await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions, salary_min, salary_max)
     VALUES ($1, 'Engineering', $2, 'open', 3, 500000, 800000) RETURNING id`, [`${TAG} Engineer`, ids.company])).rows[0].id;
  // An approved requisition with no job posted, and one awaiting approval.
  await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions)
     VALUES ($1, 'Service', $2, 'approved', 2), ($3, 'Service', $2, 'pending_approval', 4)`,
    [`${TAG} Svc A`, ids.company, `${TAG} Svc B`]);
  ids.eng = (await pool.query(
    `INSERT INTO job_openings (job_title, department, company_id, status, requisition_id, number_of_positions, posted_date)
     VALUES ($1, 'Engineering', $2, 'open', $3, 3, CURRENT_DATE - 90) RETURNING id`, [`${TAG} Engineer`, ids.company, ids.req])).rows[0].id;
  ids.fin = (await pool.query(
    `INSERT INTO job_openings (job_title, department, company_id, status, number_of_positions, posted_date)
     VALUES ($1, 'Finance', $2, 'open', 1, CURRENT_DATE - 5) RETURNING id`, [`${TAG} Accountant`, ids.company])).rows[0].id;

  ids.a = await candidate('Asha');
  ids.b = await candidate('Bala');
  ids.c = await candidate('Chitra', { job: ids.fin, stage: 'shortlisted' });
  ids.d = await candidate('Dev', { stage: 'assessment' });
}, 60000);

afterAll(async () => { await sweep(); });

const draft = (candidate_id, extra = {}) => request(api).post('/api/recruitment/offers').send({
  candidate_id, job_opening_id: ids.eng, offered_salary: 700000, joining_date: localDay(40), ...extra,
});
const sendNow = async (id, expiry = null) => pool.query(
  `UPDATE offer_letters SET offer_status = 'sent', offer_sent_date = CURRENT_DATE - 3, offer_expiry_date = $2 WHERE id = $1`,
  [id, expiry]);

describe('Offers', () => {
  it('allows one live offer per candidate', async () => {
    const first = await draft(ids.a);
    expect(first.status).toBe(201);
    ids.offerA = first.body.id;
    const second = await draft(ids.a);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already has an open offer/);
  });

  it('needs a CTC, and a job or a designation', async () => {
    expect((await draft(ids.b, { offered_salary: 0 })).status).toBe(400);
    const noJob = await request(api).post('/api/recruitment/offers').send({ candidate_id: ids.b, offered_salary: 600000 });
    expect(noJob.status).toBe(400);
    expect(noJob.body.error).toMatch(/designation/);
  });

  it('will not submit an offer without a joining date', async () => {
    const o = await draft(ids.b, { joining_date: null });
    expect(o.status).toBe(201);
    ids.offerB = o.body.id;
    const sub = await request(api).put(`/api/recruitment/offers/${ids.offerB}`).send({ offer_status: 'pending_approval' });
    expect(sub.status).toBe(400);
    expect(sub.body.error).toMatch(/joining date/);
  });

  it('decline needs a reason; it is stored and logged on the candidate', async () => {
    await sendNow(ids.offerA, localDay(5));
    const bare = await request(api).put(`/api/recruitment/offers/${ids.offerA}`).send({ offer_status: 'declined' });
    expect(bare.status).toBe(400);
    const ok = await request(api).put(`/api/recruitment/offers/${ids.offerA}`).send({ offer_status: 'declined', close_reason: 'Accepted another offer' });
    expect(ok.status).toBe(200);
    expect(ok.body.close_reason).toBe('Accepted another offer');
    expect(ok.body.response_date).toBeTruthy();
    const act = await pool.query(`SELECT summary FROM candidate_activity WHERE candidate_id = $1 AND event_type = 'offer_declined'`, [ids.a]);
    expect(act.rows[0]?.summary).toMatch(/Accepted another offer/);
    // A declined offer frees the candidate for a new one.
    expect((await draft(ids.a)).status).toBe(201);
  });

  it('a sent offer can be extended, not re-priced; dates must move forward', async () => {
    const o = await pool.query(
      `INSERT INTO offer_letters (candidate_id, job_opening_id, offered_salary, joining_date, company_id, offer_status, offer_sent_date, offer_expiry_date)
       VALUES ($1, $2, 650000, $3, $4, 'sent', CURRENT_DATE - 10, CURRENT_DATE - 1) RETURNING id`,
      [ids.d, ids.eng, localDay(30), ids.company]);
    ids.offerD = o.rows[0].id;
    const reprice = await request(api).put(`/api/recruitment/offers/${ids.offerD}`).send({ offered_salary: 900000 });
    expect(reprice.status).toBe(409);
    const past = await request(api).put(`/api/recruitment/offers/${ids.offerD}`).send({ offer_expiry_date: localDay(-2) });
    expect(past.status).toBe(400);
    const list = await request(api).get('/api/recruitment/offers');
    expect(list.body.find(x => x.id === ids.offerD).is_expired).toBe(true);
  });

  it('an expired offer needs accept_late; accepting hires and moves the application', async () => {
    const plain = await request(api).post(`/api/recruitment/offers/${ids.offerD}/accept`).send({});
    expect(plain.status).toBe(409);
    expect(plain.body.code).toBe('OFFER_EXPIRED');
    const late = await request(api).post(`/api/recruitment/offers/${ids.offerD}/accept`).send({ accept_late: true });
    expect(late.status).toBe(200);
    const app = await pool.query(`SELECT stage, status FROM candidate_applications WHERE candidate_id = $1 AND is_primary`, [ids.d]);
    expect(app.rows[0]).toEqual({ stage: 'hired', status: 'hired' });
  });

  it('an accepted offer cannot be withdrawn', async () => {
    const res = await request(api).put(`/api/recruitment/offers/${ids.offerD}`).send({ offer_status: 'withdrawn', close_reason: 'x' });
    expect(res.status).toBe(409);
  });

  it('lists the budget so the page can flag an offer above it', async () => {
    const list = await request(api).get('/api/recruitment/offers');
    const b = list.body.find(x => x.id === ids.offerB);
    expect(Number(b.budget_max)).toBe(800000);
  });
});

describe('Employee creation waiting list', () => {
  it('shows a hired candidate once even after several attempts', async () => {
    // Hired directly (no offer, no employee) 10 days ago, so it stays out of
    // the "today" report counts below; two failed attempts in the log.
    ids.e = await candidate('Esha', { stage: 'hired', status: 'hired', createdDaysAgo: 10 });
    await pool.query(
      `INSERT INTO recruitment_employee_creation_log (company_id, candidate_id, candidate_name, status, triggered_at, error_log)
       VALUES ($1, $2, 'x', 'failed', NOW() - INTERVAL '2 hours', 'first'), ($1, $2, 'x', 'failed', NOW(), 'second')`,
      [ids.company, ids.e]);
    const res = await request(api).get('/api/recruitment/auto-creation/pending');
    const rows = res.body.filter(r => r.id === ids.e);
    expect(rows.length).toBe(1);
    expect(rows[0].error_log).toBe('second');
  });
});

describe('Reports', () => {
  it('"to" includes its own day — candidates added today are counted', async () => {
    const res = await request(api).get('/api/recruitment/reports/summary').query({ from_date: localDay(-1), to_date: localDay() });
    expect(res.status).toBe(200);
    expect(res.body.total_candidates).toBe(4);
  });

  it('applies the department to every report', async () => {
    const q = { from_date: localDay(-30), to_date: localDay(), department: 'Finance' };
    const src = await request(api).get('/api/recruitment/reports/source-effectiveness').query(q);
    expect(src.body.reduce((a, r) => a + r.total_applications, 0)).toBe(1);
    const pipe = await request(api).get('/api/recruitment/reports/department-pipeline').query(q);
    expect(pipe.body.map(r => r.department)).toEqual(['Finance']);
    const aging = await request(api).get('/api/recruitment/reports/vacancy-aging').query({ department: 'Finance' });
    expect(aging.body.map(r => r.job_title)).toEqual([`${TAG} Accountant`]);
  });

  it('vacancy aging shows a job opened 90 days ago (it was cut by the date range)', async () => {
    const res = await request(api).get('/api/recruitment/reports/vacancy-aging');
    const eng = res.body.find(r => r.id === ids.eng);
    expect(eng.days_open).toBe(90);
  });

  it('dept pipeline has every stage and its columns add up', async () => {
    const res = await request(api).get('/api/recruitment/reports/department-pipeline').query({ from_date: localDay(-1), to_date: localDay() });
    for (const r of res.body) {
      const parts = ['applied', 'screening', 'shortlisted', 'assessment', '1st_level', '2nd_level', 'offer', 'selected', 'hired']
        .reduce((a, k) => a + r[k], 0) + r.rejected + r.parked;
      expect(parts).toBe(r.total);
    }
    const fin = res.body.find(r => r.department === 'Finance');
    expect(fin.shortlisted).toBe(1);
  });

  it('offers report gives outcomes, reasons and acceptance rate', async () => {
    const res = await request(api).get('/api/recruitment/reports/offers').query({ from_date: localDay(-30), to_date: localDay() });
    expect(res.status).toBe(200);
    expect(res.body.totals.accepted).toBe(1);
    expect(res.body.totals.declined).toBe(1);
    expect(res.body.totals.acceptance_rate).toBe(50);
    expect(res.body.rows.find(r => r.offer_status === 'declined').close_reason).toBe('Accepted another offer');
  });

  it('forecast counts approved-not-posted and awaiting-approval requisitions', async () => {
    const res = await request(api).get('/api/recruitment/reports/forecast');
    expect(res.status).toBe(200);
    const svc = res.body.rows.find(r => r.department === 'Service');
    expect(svc).toMatchObject({ approved_not_posted: 2, awaiting_approval: 4, open_seats: 0 });
    const eng = res.body.rows.find(r => r.department === 'Engineering');
    expect(eng.open_roles).toBe(1);
  });
});

describe('Email templates', () => {
  it('keeps one active template per event; Duplicate makes an inactive copy', async () => {
    const t1 = await request(api).post('/api/recruitment/email-templates').send({ template_name: `${TAG} A`, template_type: 'offer_sent', subject: 's', body_html: 'b' });
    expect(t1.status).toBe(201);
    expect(t1.body.is_active).toBe(true);
    const copy = await request(api).post('/api/recruitment/email-templates').send({ template_name: `${TAG} A (Copy)`, template_type: 'offer_sent', subject: 's', body_html: 'b', is_active: false });
    expect(copy.body.is_active).toBe(false);
    const on = await request(api).put(`/api/recruitment/email-templates/${copy.body.id}`).send({ is_active: true });
    expect(on.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT id FROM email_templates WHERE company_id = $1 AND stage_trigger = 'offer_sent' AND is_active AND deleted_at IS NULL`, [ids.company]);
    expect(rows.map(r => r.id)).toEqual([copy.body.id]);
  });
});

describe('Department head: own department, no set-up (owner 2026-11-18)', () => {
  it('sees only their department in offers, reports and the forecast', async () => {
    const fin = await request(api).post('/api/recruitment/offers').send({ candidate_id: ids.c, job_opening_id: ids.fin, offered_salary: 450000, joining_date: localDay(30) });
    expect(fin.status).toBe(201);
    const list = await request(headApi).get('/api/recruitment/offers');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body.every(o => o.department === 'Finance')).toBe(true);
    // Asking for another department gives nothing, not that department.
    const eng = await request(headApi).get('/api/recruitment/offers').query({ department: 'Engineering' });
    expect(eng.body).toEqual([]);
    const pipe = await request(headApi).get('/api/recruitment/reports/department-pipeline').query({ from_date: localDay(-1), to_date: localDay() });
    expect(pipe.body.map(r => r.department)).toEqual(['Finance']);
    const fc = await request(headApi).get('/api/recruitment/reports/forecast');
    expect(fc.body.rows.every(r => r.department === 'Finance')).toBe(true);
  });

  it('cannot open or act on another department’s offer', async () => {
    const res = await request(headApi).get(`/api/recruitment/offers/${ids.offerB}`);
    expect(res.status).toBe(404);
    const w = await request(headApi).put(`/api/recruitment/offers/${ids.offerB}`).send({ offer_status: 'withdrawn', close_reason: 'x' });
    expect(w.status).toBe(404);
    const mk = await request(headApi).post('/api/recruitment/offers').send({ candidate_id: ids.b, job_opening_id: ids.eng, offered_salary: 500000 });
    expect(mk.status).toBe(403);
  });

  it('cannot change email templates or recruitment settings; HR can', async () => {
    const t = await request(headApi).post('/api/recruitment/email-templates').send({ template_name: `${TAG} H`, template_type: 'offer_sent', subject: 's', body_html: 'b' });
    expect(t.status).toBe(403);
    const st = await request(headApi).post('/api/settings/recruitment').send({ offer_validity_days: 3 });
    expect(st.status).toBe(403);
    const status = await request(headApi).get('/api/recruitment/setup-status');
    expect(status.body).toMatchObject({ can_manage_setup: false, dept_scope: ['Finance'] });
    const hrStatus = await request(api).get('/api/recruitment/setup-status');
    expect(hrStatus.body).toMatchObject({ can_manage_setup: true, dept_scope: null });
  });
});

describe('Offer approval is Super Admin only (owner 2026-11-18)', () => {
  it('HR, HR manager and department heads cannot approve; Super Admin can', () => {
    const r = (roles) => ({ user: { roles } });
    expect(canApproveOffer(r(['hr']))).toBe(false);
    expect(canApproveOffer(r(['hr_manager']))).toBe(false);
    expect(canApproveOffer(r(['department_head']))).toBe(false);
    expect(canApproveOffer(r(['super_admin']))).toBe(true);
  });
});

describe('Offer letter wording is editable (2026-11-18)', () => {
  it('uses the default text until HR saves their own, then theirs', async () => {
    const { buildOfferLetterPdf } = await import('../modules/recruitment/offerLetter.js');
    const before = await buildOfferLetterPdf(pool, { companyId: ids.company, offerId: ids.offerB, signatoryUserId: null });
    expect(before.body).toMatch(/satisfactory verification of your documents/);
    expect(before.signatoryTitle).toBe('Human Resources');
    const save = await request(api).post('/api/settings/recruitment').send({
      offer_letter_conditions: 'You will be on probation for six months.\n\nYour notice period is 60 days.',
      offer_letter_closing: 'Welcome aboard.',
      offer_letter_signatory_title: 'Head of People',
    });
    expect(save.status).toBeLessThan(300);
    const after = await buildOfferLetterPdf(pool, { companyId: ids.company, offerId: ids.offerB, signatoryUserId: null });
    expect(after.body).toMatch(/probation for six months\.\n\nYour notice period is 60 days\.\n\nWelcome aboard\./);
    expect(after.body).not.toMatch(/satisfactory verification/);
    expect(after.signatoryTitle).toBe('Head of People');
    expect(after.pdf.length).toBeGreaterThan(500);
  });
});
