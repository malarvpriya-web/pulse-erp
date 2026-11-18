/**
 * Jobs page review 2026-11-17 (Requisitions + Job Openings), against a real DB.
 *
 *   - requested_by is the signed-in employee (was never written, so the
 *     self-approval block never fired) — and a self-approval is refused
 *   - numeric experience / budget ranges + hiring reason + justification
 *   - submit for approval needs a justification; replacement needs the employee
 *   - list carries the opening it became and the last decision comment
 *   - an opening stays inside its requisition: head count, budget, department
 *   - closing date cannot be in the past
 *   - opening status moves are checked; draft → publish; closing an opening
 *     closes its requisition, reopening reopens it; closing the requisition
 *     closes the opening
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

const { default: pool }            = await import('../config/db.js');
const { default: recruitRouter }   = await import('../modules/recruitment/routes/recruitment.routes.js');
const { default: approvalsRouter } = await import('../modules/approvals/approvals.routes.js');

const TAG = 'ZZJPR';
const ids = {};

function appAs(userId, employeeId, roles) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, id: userId, roles, role: roles[0], company_id: ids.company, employee_id: employeeId };
    req.scope = { company_id: ids.company };
    next();
  });
  app.use('/api/recruitment', recruitRouter);
  app.use('/api/approvals', approvalsRouter);
  return app;
}
let api;       // requester (HR recruiter, approver role too)
let approver;  // a different approver
let head;     // a department head (Service)
let nobody;   // neither HR nor a head

const pastDate = () => {
  const d = new Date(); d.setDate(d.getDate() - 3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const c = rows[0]?.id;
  if (c) {
    for (const sql of [
      `DELETE FROM approvals WHERE company_id = $1`,
      `DELETE FROM job_distributions WHERE company_id = $1`,
      `DELETE FROM candidate_applications WHERE company_id = $1`,
      `DELETE FROM candidates WHERE company_id = $1`,
      `DELETE FROM job_requisition_events WHERE company_id = $1`,
      `DELETE FROM job_openings WHERE company_id = $1`,
      `DELETE FROM job_requisitions WHERE company_id = $1`,
      `DELETE FROM employees WHERE company_id = $1`,
    ]) await pool.query(sql, [c]).catch(() => {});
  }
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE LOWER($1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM roles WHERE code LIKE $1`, [`${TAG}%`]);
  if (c) await pool.query(`DELETE FROM companies WHERE id = $1`, [c]).catch(() => {});
}

beforeAll(async () => {
  await sweep();
  ids.company = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, TAG])).rows[0].id;
  const emp = async (last) => (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, $2, $3) RETURNING id`,
    [TAG, last, ids.company])).rows[0].id;
  ids.requester = await emp('Requester');
  ids.approverEmp = await emp('Approver');
  ids.leaver = await emp('Leaver');
  const role = (await pool.query(`INSERT INTO roles (role_name, code, is_active) VALUES ($1, $2, true) RETURNING id`, [`${TAG} rec`, `${TAG}_REC`])).rows[0].id;
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_export)
     VALUES ($1, 'recruitment', true, true, true, true, true)`, [role]);
  const mkUser = async (suffix, empId) => {
    const u = (await pool.query(`INSERT INTO users (email, role, is_active, employee_id) VALUES ($1, 'hr_manager', true, $2) RETURNING id`,
      [`${TAG}.${suffix}@test.invalid`, empId])).rows[0].id;
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u, role]);
    return u;
  };
  ids.reqUser = await mkUser('req', ids.requester);
  ids.apprUser = await mkUser('appr', ids.approverEmp);
  api = appAs(ids.reqUser, ids.requester, [`${TAG}_rec`, 'hr_manager']);
  approver = appAs(ids.apprUser, ids.approverEmp, [`${TAG}_rec`, 'super_admin']);
}, 60000);

afterAll(async () => { await sweep(); });

describe('Requisitions', () => {
  it('records the signed-in employee as the requester and stores numeric ranges', async () => {
    const res = await request(api).post('/api/recruitment/requisitions').send({
      job_title: `${TAG} Engineer`, department: 'Engineering', number_of_positions: 2,
      experience_min: 2, experience_max: 5, salary_min: 500000, salary_max: 800000,
      requested_by: ids.approverEmp, // ignored: the requester is whoever is signed in
    });
    expect(res.status).toBe(201);
    ids.req = res.body.id;
    expect(res.body.requested_by).toBe(ids.requester);
    expect(res.body.experience_min).toBe(2);
    expect(Number(res.body.salary_max)).toBe(800000);
    expect(res.body.hiring_reason).toBe('new_position');
  });

  it('refuses min > max', async () => {
    const res = await request(api).post('/api/recruitment/requisitions').send({
      job_title: `${TAG} Bad`, department: 'Engineering', salary_min: 900000, salary_max: 100000 });
    expect(res.status).toBe(400);
  });

  it('a replacement must name the employee being replaced', async () => {
    const res = await request(api).post('/api/recruitment/requisitions').send({
      job_title: `${TAG} Backfill`, department: 'Engineering', hiring_reason: 'replacement' });
    expect(res.status).toBe(400);
    const ok = await request(api).post('/api/recruitment/requisitions').send({
      job_title: `${TAG} Backfill`, department: 'Engineering', hiring_reason: 'replacement', replacing_employee_id: ids.leaver });
    expect(ok.status).toBe(201);
    expect(ok.body.replacing_employee_name).toMatch(/Leaver/);
  });

  it('cannot be submitted without a justification', async () => {
    const res = await request(api).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'pending_approval' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/justification/i);
    await request(api).put(`/api/recruitment/requisitions/${ids.req}`).send({ justification: 'New service contract' }).expect(200);
    await request(api).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'pending_approval' }).expect(200);
  });

  it('the requester cannot approve their own requisition; another approver can', async () => {
    const self = await request(api).post(`/api/approvals/requisition:${ids.req}/approve`).send({});
    expect(self.status).toBe(403);
    const sendBack = await request(approver).post(`/api/approvals/requisition:${ids.req}/reject`).send({ comment: 'Lower the budget' });
    expect(sendBack.status).toBe(200);
    const list = await request(api).get('/api/recruitment/requisitions');
    const row = list.body.find(r => r.id === ids.req);
    expect(row.status).toBe('draft');
    expect(row.last_decision).toBe('Rejected');
    expect(row.last_decision_comment).toBe('Lower the budget');
    await request(api).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'pending_approval' }).expect(200);
    const ok = await request(approver).post(`/api/approvals/requisition:${ids.req}/approve`).send({});
    expect(ok.status).toBe(200);
  });
});

describe('Job opening stays inside its requisition', () => {
  const base = () => ({ requisition_id: ids.req, job_title: `${TAG} Engineer`, department: 'Engineering' });

  it('refuses more positions than approved', async () => {
    const res = await request(api).post('/api/recruitment/openings').send({ ...base(), number_of_positions: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approved 2 position/);
  });

  it('refuses a salary above the approved budget', async () => {
    const res = await request(api).post('/api/recruitment/openings').send({ ...base(), salary_max: 900000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/budget/);
  });

  it('refuses a closing date in the past', async () => {
    const res = await request(api).post('/api/recruitment/openings').send({ ...base(), closing_date: pastDate() });
    expect(res.status).toBe(400);
  });

  it('takes the department from the requisition and can be saved as a draft', async () => {
    const res = await request(api).post('/api/recruitment/openings').send({ ...base(), department: 'Sales', status: 'draft', salary_max: 800000 });
    expect(res.status).toBe(201);
    ids.opening = res.body.id;
    expect(res.body.department).toBe('Engineering');
    expect(res.body.status).toBe('draft');
  });

  it('refuses changing the department or requisition on edit', async () => {
    expect((await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ department: 'Sales' })).status).toBe(400);
    expect((await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ requisition_id: 999999 })).status).toBe(400);
    expect((await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ number_of_positions: 5 })).status).toBe(400);
  });

  it('a draft is published, and the requisition shows the opening', async () => {
    expect((await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ status: 'on_hold' })).status).toBe(409);
    const res = await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ status: 'open' });
    expect(res.status).toBe(200);
    expect(res.body.posted_date).toBeTruthy();
    const r = (await request(api).get(`/api/recruitment/requisitions/${ids.req}`)).body;
    expect(r.status).toBe('open');
    expect(r.opening_id).toBe(ids.opening);
    expect(r.opening_status).toBe('open');
  });

  it('closing the opening closes the requisition; reopening reopens it', async () => {
    await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ status: 'closed' }).expect(200);
    expect((await pool.query(`SELECT status FROM job_requisitions WHERE id = $1`, [ids.req])).rows[0].status).toBe('closed');
    await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ status: 'open' }).expect(200);
    expect((await pool.query(`SELECT status FROM job_requisitions WHERE id = $1`, [ids.req])).rows[0].status).toBe('open');
  });

  it('closing the requisition closes its opening', async () => {
    await request(api).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'closed' }).expect(200);
    expect((await pool.query(`SELECT status FROM job_openings WHERE id = $1`, [ids.opening])).rows[0].status).toBe('closed');
  });

  it('a 404 for an opening that does not exist', async () => {
    expect((await request(api).put(`/api/recruitment/openings/99999999`).send({ job_title: 'x' })).status).toBe(404);
  });
});

describe('Job timeline', () => {
  it('records every step, oldest first, with the approver comment', async () => {
    const res = await request(api).get(`/api/recruitment/requisitions/${ids.req}/timeline`);
    expect(res.status).toBe(200);
    const events = res.body.map(r => r.event);
    expect(events).toEqual([
      'raised', 'edited', 'submitted', 'sent_back', 'submitted', 'approved',
      'job_drafted', 'job_published', 'job_closed', 'job_reopened', 'closed',
    ]);
    const sentBack = res.body.find(r => r.event === 'sent_back');
    expect(sentBack.comment).toBe('Lower the budget');
    expect(sentBack.actor).toBeTruthy();
    expect(res.body.find(r => r.event === 'edited').comment).toMatch(/justification/);
  });

  it('shows applications to the job', async () => {
    const cand = (await pool.query(
      `INSERT INTO candidates (full_name, email, company_id, applied_job_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [`${TAG} Applicant`, `${TAG.toLowerCase()}.app@test.invalid`, ids.company, ids.opening])).rows[0].id;
    await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, is_primary) VALUES ($1, $2, $3, true)`,
      [ids.company, cand, ids.opening]);
    const res = await request(api).get(`/api/recruitment/requisitions/${ids.req}/timeline`);
    const app = res.body.find(r => r.event === 'application');
    expect(app.candidate).toBe(`${TAG} Applicant`);
  });

  it('404 for another company\'s or a missing requisition', async () => {
    expect((await request(api).get('/api/recruitment/requisitions/99999999/timeline')).status).toBe(404);
  });
});

describe('Who raises and who approves (owner decision 2026-11-17)', () => {

  beforeAll(async () => {
    ids.headEmp = (await pool.query(
      `INSERT INTO employees (office_id, first_name, last_name, company_id, department) VALUES (${FIXTURE_CODE_SQL}, $1, 'Head', $2, 'Service') RETURNING id`,
      [TAG, ids.company])).rows[0].id;
    const u = (await pool.query(`INSERT INTO users (email, role, is_active, employee_id) VALUES ($1, 'department_head', true, $2) RETURNING id`,
      [`${TAG}.head@test.invalid`, ids.headEmp])).rows[0].id;
    head = appAs(u, ids.headEmp, [`${TAG}_rec`, 'department_head']);
    nobody = appAs(u, null, [`${TAG}_rec`, 'employee']);
  });

  it('a department head raises for their own department only', async () => {
    const own = await request(head).post('/api/recruitment/requisitions').send({ job_title: `${TAG} Tech`, department: 'Service', justification: 'AMC load' });
    expect(own.status).toBe(201);
    ids.headReq = own.body.id;
    const other = await request(head).post('/api/recruitment/requisitions').send({ job_title: `${TAG} Eng`, department: 'Engineering' });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/only for Service/);
  });

  it('someone who is neither HR nor a head cannot raise', async () => {
    const res = await request(nobody).post('/api/recruitment/requisitions').send({ job_title: `${TAG} X`, department: 'Service' });
    expect(res.status).toBe(403);
  });

  it('access tells the page what each person may do', async () => {
    expect((await request(head).get('/api/recruitment/requisitions/access')).body)
      .toMatchObject({ can_raise: true, any_department: false, departments: ['Service'], can_approve: false });
    expect((await request(api).get('/api/recruitment/requisitions/access')).body)
      .toMatchObject({ can_raise: true, any_department: true, can_approve: false });
    expect((await request(approver).get('/api/recruitment/requisitions/access')).body)
      .toMatchObject({ can_raise: true, any_department: true, can_approve: true });
  });

  it('only Super Admin approves or sends back — HR cannot', async () => {
    await request(head).put(`/api/recruitment/requisitions/${ids.headReq}`).send({ status: 'pending_approval' }).expect(200);
    const hr = await request(api).post(`/api/approvals/requisition:${ids.headReq}/approve`).send({});
    expect(hr.status).toBe(403);
    const hrBack = await request(api).post(`/api/approvals/requisition:${ids.headReq}/reject`).send({ comment: 'no' });
    expect(hrBack.status).toBe(403);
    expect((await request(approver).post(`/api/approvals/requisition:${ids.headReq}/approve`).send({})).status).toBe(200);
  });

  it('a head cannot manage another department\'s requisition', async () => {
    const res = await request(head).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'open' });
    expect(res.status).toBe(403);
  });
});

describe('Reopen and restore', () => {
  it('reopens a closed requisition together with its job', async () => {
    const res = await request(api).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'open' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    expect((await pool.query(`SELECT status FROM job_openings WHERE id = $1`, [ids.opening])).rows[0].status).toBe('open');
    const tl = (await request(api).get(`/api/recruitment/requisitions/${ids.req}/timeline`)).body;
    expect(tl.at(-1).event === 'reopened' || tl.some(r => r.event === 'reopened')).toBe(true);
  });

  it('restores a cancelled requisition to draft', async () => {
    await request(head).put(`/api/recruitment/requisitions/${ids.headReq}`).send({ status: 'cancelled' }).expect(200);
    const res = await request(head).put(`/api/recruitment/requisitions/${ids.headReq}`).send({ status: 'draft' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
  });
});

describe('Super Admin raises, approves, and moves the status (owner, 2026-11-17)', () => {
  it('closes and reopens a requisition', async () => {
    expect((await request(approver).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'closed' })).status).toBe(200);
    expect((await request(approver).put(`/api/recruitment/requisitions/${ids.req}`).send({ status: 'open' })).status).toBe(200);
  });

  it('raises for any department and approves their own requisition', async () => {
    const raised = await request(approver).post('/api/recruitment/requisitions')
      .send({ job_title: `${TAG} Director pick`, department: 'Engineering', justification: 'New product line' });
    expect(raised.status).toBe(201);
    expect(raised.body.requested_by).toBe(ids.approverEmp);
    await request(approver).put(`/api/recruitment/requisitions/${raised.body.id}`).send({ status: 'pending_approval' }).expect(200);
    const ok = await request(approver).post(`/api/approvals/requisition:${raised.body.id}/approve`).send({});
    expect(ok.status).toBe(200);
    const tl = (await request(approver).get(`/api/recruitment/requisitions/${raised.body.id}/timeline`)).body.map(r => r.event);
    expect(tl).toEqual(['raised', 'submitted', 'approved']);
  });

  it('HR still cannot approve, even a requisition someone else raised', async () => {
    const r = await request(head).post('/api/recruitment/requisitions').send({ job_title: `${TAG} Tech 2`, department: 'Service', justification: 'x' });
    await request(head).put(`/api/recruitment/requisitions/${r.body.id}`).send({ status: 'pending_approval' }).expect(200);
    expect((await request(api).post(`/api/approvals/requisition:${r.body.id}/approve`).send({})).status).toBe(403);
  });
});
