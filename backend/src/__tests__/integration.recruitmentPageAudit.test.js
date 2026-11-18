/**
 * Recruitment page audit 2026-11-17 (RECRUITMENT_MODULE_PAGE_AUDIT_2026-11-17.md).
 *
 * One test per defect that was fixed, against a real database:
 *   B1  interview modes the browser sends ('offline'/'online') are accepted
 *   B2  the interviewer and panel are employees of this company, and stored as ids
 *   B4  feedback is linked to the interview it was given for
 *   B5  every opening field saves on create AND edit, and a field can be cleared
 *   B6  an opening needs an approved requisition; head count comes with it
 *       requisitions: content edits only in draft; cancel; delete rules
 *       offers: designation + OFR number; terms editable only in draft; PDF letter
 *       screening questions: a company edit overrides the shared wording
 *       agency fee recorded when an agency candidate becomes an employee
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
const { default: ciRouter }      = await import('../modules/recruitment/routes/candidateIntelligence.routes.js');
const { default: talentRouter }  = await import('../modules/talent/talent.routes.js');
const { default: repo }          = await import('../modules/recruitment/repositories/recruitment.repository.js');

const TAG = 'ZZRPA';
const ids = {};

function appAs(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, id: userId, roles: [`${TAG}_rec`, 'hr'], role: `${TAG}_rec`, company_id: ids.company, employee_id: ids.employee };
    req.scope = { company_id: ids.company };
    next();
  });
  app.use('/api/recruitment', ciRouter);
  app.use('/api/recruitment', recruitRouter);
  app.use('/api/talent', talentRouter);
  return app;
}
let api;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const c = rows[0]?.id;
  if (c) {
    for (const sql of [
      `DELETE FROM recruitment_agency_fees WHERE company_id = $1`,
      `DELETE FROM interview_notes WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = $1)`,
      `DELETE FROM interview_schedules WHERE company_id = $1`,
      `DELETE FROM offer_letters WHERE company_id = $1`,
      `DELETE FROM recruitment_employee_creation_log WHERE company_id = $1`,
      `DELETE FROM candidate_activity WHERE company_id = $1`,
      `DELETE FROM candidate_applications WHERE company_id = $1`,
      `DELETE FROM candidate_stage_history WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = $1)`,
      `DELETE FROM hr_onboarding_checklist_progress WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`,
      `DELETE FROM employees WHERE company_id = $1 AND source_candidate_id IS NOT NULL`,
      `DELETE FROM candidates WHERE company_id = $1`,
      `DELETE FROM recruitment_agencies WHERE company_id = $1`,
      `DELETE FROM job_openings WHERE company_id = $1`,
      `DELETE FROM job_requisitions WHERE company_id = $1`,
      `DELETE FROM screening_questions WHERE company_id = $1`,
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
  ids.employee = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, 'Lead', $2) RETURNING id`,
    [TAG, ids.company])).rows[0].id;
  ids.panelist = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, 'Panel', $2) RETURNING id`,
    [TAG, ids.company])).rows[0].id;
  const role = (await pool.query(`INSERT INTO roles (role_name, code, is_active) VALUES ($1, $2, true) RETURNING id`, [`${TAG} rec`, `${TAG}_REC`])).rows[0].id;
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_export)
     VALUES ($1, 'recruitment', true, true, true, true, true)`, [role]);
  const user = (await pool.query(`INSERT INTO users (email, role, is_active) VALUES ($1, 'employee', true) RETURNING id`, [`${TAG}.rec@test.invalid`])).rows[0].id;
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [user, role]);
  api = appAs(user);

  ids.reqApproved = (await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions, skills_required)
     VALUES ($1, 'Engineering', $2, 'approved', 3, 'Power electronics') RETURNING id`, [`${TAG} Engineer`, ids.company])).rows[0].id;
  ids.reqDraft = (await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions)
     VALUES ($1, 'Service', $2, 'draft', 1) RETURNING id`, [`${TAG} Service`, ids.company])).rows[0].id;
}, 60000);

afterAll(async () => { await sweep(); });

describe('Jobs — openings need an approved requisition and keep every field (B5, B6)', () => {
  it('refuses an opening with no requisition', async () => {
    const res = await request(api).post('/api/recruitment/openings').send({ job_title: `${TAG} Free`, department: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requisition/i);
  });

  it('refuses an unapproved requisition', async () => {
    const res = await request(api).post('/api/recruitment/openings')
      .send({ job_title: `${TAG} Svc`, department: 'Service', requisition_id: ids.reqDraft });
    expect(res.status).toBe(400);
  });

  it('creates from an approved requisition, carrying head count and storing each field in its own column', async () => {
    const res = await request(api).post('/api/recruitment/openings').send({
      requisition_id: ids.reqApproved, job_title: `${TAG} Engineer`, department: 'Engineering',
      experience_min: 2, experience_max: 5, salary_min: 600000, salary_max: 900000,
      skills_required: 'MATLAB, PLC', description: 'Design converters', location: 'Madurai',
    });
    expect(res.status).toBe(201);
    ids.opening = res.body.id;
    const { rows: [o] } = await pool.query(`SELECT * FROM job_openings WHERE id = $1`, [ids.opening]);
    expect(o.number_of_positions).toBe(3);                    // from the requisition
    expect(o.skills_required).toBe('MATLAB, PLC');
    expect(o.requirements).toBeNull();                        // nothing squashed into it any more
    expect(Number(o.salary_max)).toBe(900000);
    const { rows: [rq] } = await pool.query(`SELECT status FROM job_requisitions WHERE id = $1`, [ids.reqApproved]);
    expect(rq.status).toBe('open');
  });

  it('edit saves description, skills, salary, experience and positions, and can clear a field', async () => {
    const res = await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({
      job_description: 'Lead converter design', skills_required: 'MATLAB', number_of_positions: 2,
      salary_min: 650000, experience_max: '', location: '',
    });
    expect(res.status).toBe(200);
    const { rows: [o] } = await pool.query(`SELECT * FROM job_openings WHERE id = $1`, [ids.opening]);
    expect(o.description).toBe('Lead converter design');
    expect(o.skills_required).toBe('MATLAB');
    expect(o.number_of_positions).toBe(2);
    expect(Number(o.salary_min)).toBe(650000);
    expect(o.experience_max).toBeNull();
    expect(o.location).toBeNull();
  });

  it('lists the opening with its own head count', async () => {
    const res = await request(api).get('/api/recruitment/openings');
    const o = res.body.find(x => x.id === ids.opening);
    expect(o.number_of_positions).toBe(2);
    expect(o.requisition_status).toBe('open');
  });

  it('"Pause" is on_hold, a status the API accepts', async () => {
    const res = await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ status: 'on_hold' });
    expect(res.status).toBe(200);
    await request(api).put(`/api/recruitment/openings/${ids.opening}`).send({ status: 'open' });
  });
});

describe('Requisitions — edit while draft, cancel, delete', () => {
  it('edits a draft, including priority', async () => {
    const res = await request(api).put(`/api/recruitment/requisitions/${ids.reqDraft}`)
      .send({ number_of_positions: 2, priority: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.number_of_positions).toBe(2);
    expect(res.body.priority).toBe('high');
  });

  it('refuses content edits once it has left draft', async () => {
    const res = await request(api).put(`/api/recruitment/requisitions/${ids.reqApproved}`).send({ number_of_positions: 9 });
    expect(res.status).toBe(409);
  });

  it('refuses deleting a requisition that is not draft/cancelled', async () => {
    expect((await request(api).delete(`/api/recruitment/requisitions/${ids.reqApproved}`)).status).toBe(409);
  });

  it('cancels then deletes a draft', async () => {
    expect((await request(api).put(`/api/recruitment/requisitions/${ids.reqDraft}`).send({ status: 'cancelled' })).status).toBe(200);
    expect((await request(api).delete(`/api/recruitment/requisitions/${ids.reqDraft}`)).status).toBe(200);
  });
});

describe('Interviews (B1, B2, B4, reschedule)', () => {
  beforeAll(async () => {
    const res = await request(api).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Priya`, email: `${TAG.toLowerCase()}.priya@test.invalid`, applied_job_id: ids.opening, source: 'manual',
    });
    expect(res.status).toBe(201);
    ids.candidate = res.body.id;
  });

  it('accepts "offline" from the browser as in_person, with lead + panel + round', async () => {
    const res = await request(api).post('/api/recruitment/interviews').send({
      candidate_id: ids.candidate, interview_date: '2030-01-10', interview_time: '10:30',
      interview_mode: 'offline', interviewer_id: ids.employee, panel_employee_ids: [ids.panelist, ids.employee],
      interview_round: '1st_level',
    });
    expect(res.status).toBe(201);
    ids.interview = res.body.id;
    expect(res.body.interview_mode).toBe('in_person');
    expect(res.body.interviewer_id).toBe(ids.employee);
    expect(res.body.panel_employee_ids).toEqual([ids.panelist]); // lead is not repeated on the panel
    // Booking the 1st level round moved the applicant forward.
    const { rows: [c] } = await pool.query(`SELECT current_stage FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(c.current_stage).toBe('1st_level');
  });

  it('accepts "online" as video', async () => {
    const res = await request(api).post('/api/recruitment/interviews').send({
      candidate_id: ids.candidate, interview_date: '2030-01-11', interview_mode: 'online',
    });
    expect(res.status).toBe(201);
    expect(res.body.interview_mode).toBe('video');
    await request(api).put(`/api/recruitment/interviews/${res.body.id}`).send({ status: 'cancelled' });
  });

  it('refuses an interviewer from another company', async () => {
    const other = (await pool.query(`SELECT id FROM employees WHERE company_id <> $1 AND deleted_at IS NULL LIMIT 1`, [ids.company])).rows[0];
    if (!other) return;
    const res = await request(api).post('/api/recruitment/interviews').send({
      candidate_id: ids.candidate, interview_date: '2030-01-12', interview_mode: 'phone', interviewer_id: other.id,
    });
    expect(res.status).toBe(400);
  });

  it('lists my interviews (lead or panel) with names', async () => {
    const res = await request(api).get('/api/recruitment/interviews').query({ mine: 1, status: 'scheduled' });
    expect(res.status).toBe(200);
    const iv = res.body.find(x => x.id === ids.interview);
    expect(iv.interviewer_name).toMatch(/Lead/);
    expect(iv.panel.map(p => p.id)).toEqual([ids.panelist]);
  });

  it('saves the chosen questions and reschedules with a timeline entry', async () => {
    const q = await request(api).put(`/api/recruitment/interviews/${ids.interview}`).send({ question_ids: [5, '7', 5] });
    expect(q.status).toBe(200);
    expect(q.body.question_ids).toEqual([5, 7]);
    const r = await request(api).put(`/api/recruitment/interviews/${ids.interview}`).send({ interview_date: '2030-01-15', interview_time: '11:00' });
    expect(r.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT 1 FROM candidate_activity WHERE candidate_id = $1 AND event_type = 'interview_rescheduled'`, [ids.candidate]);
    expect(rows.length).toBe(1);
  });

  it('records a panel member note against the interview', async () => {
    const res = await request(api).post('/api/recruitment/interview-notes').send({
      candidate_id: ids.candidate, interview_id: ids.interview, rating: 4, recommendation: 'hire', comments: 'Strong basics',
    });
    expect(res.status).toBe(201);
    expect(res.body.interview_id).toBe(ids.interview);
    expect(res.body.interview_round).toBe('1st Level Interview');
  });

  it('completes with feedback linked to the interview and moves 1st → 2nd level', async () => {
    const res = await request(api).post(`/api/recruitment/interviews/${ids.interview}/submit-feedback`)
      .send({ outcome: 'selected', rating: 4, comments: 'Go' });
    expect(res.status).toBe(200);
    expect(res.body.next_stage).toBe('2nd_level');
    const { rows } = await pool.query(`SELECT interview_id FROM interview_notes WHERE candidate_id = $1`, [ids.candidate]);
    expect(rows.every(r => r.interview_id === ids.interview)).toBe(true);
    // A completed interview can no longer be moved.
    expect((await request(api).put(`/api/recruitment/interviews/${ids.interview}`).send({ interview_date: '2030-02-01' })).status).toBe(409);
  });
});

describe('Offers — designation, number, draft-only terms, PDF', () => {
  it('drafts with designation from the opening and an OFR number', async () => {
    const res = await request(api).post('/api/recruitment/offers').send({
      candidate_id: ids.candidate, job_opening_id: ids.opening, offered_salary: 800000, joining_date: '2030-03-01',
    });
    expect(res.status).toBe(201);
    ids.offer = res.body.id;
    expect(res.body.designation).toBe(`${TAG} Engineer`);
    expect(res.body.offer_no).toMatch(/^OFR-\d{4,}$/);
  });

  it('edits the draft terms', async () => {
    const res = await request(api).put(`/api/recruitment/offers/${ids.offer}`).send({ offered_salary: 850000, designation: 'Senior Engineer' });
    expect(res.status).toBe(200);
    expect(Number(res.body.offered_salary)).toBe(850000);
  });

  it('refuses term edits once submitted', async () => {
    await request(api).put(`/api/recruitment/offers/${ids.offer}`).send({ offer_status: 'pending_approval' });
    const res = await request(api).put(`/api/recruitment/offers/${ids.offer}`).send({ offered_salary: 1 });
    expect(res.status).toBe(409);
  });

  it('serves the offer letter as a PDF', async () => {
    const res = await request(api).get(`/api/recruitment/offers/${ids.offer}/letter.pdf`).buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('Candidate edit — blanks clear, stage is not editable here', () => {
  it('clears a field and ignores a stage change', async () => {
    await request(api).put(`/api/recruitment/candidates/${ids.candidate}`).send({ current_company: 'Delta' });
    const res = await request(api).put(`/api/recruitment/candidates/${ids.candidate}`)
      .send({ current_company: '', current_stage: 'hired', phone: '+91 90000 00000' });
    expect(res.status).toBe(200);
    expect(res.body.current_company).toBeNull();
    expect(res.body.current_stage).not.toBe('hired');
    expect(res.body.phone).toBe('+91 90000 00000');
  });
});

describe('Screening questions — company edits override the shared wording', () => {
  it('rewords and switches off a question for this company only', async () => {
    const list = (await request(api).get('/api/recruitment/screening-questions')).body;
    const q = list[0];
    const res = await request(api).put(`/api/recruitment/screening-questions/${q.code}`).send({ prompt: `${TAG} reworded`, is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.company_id).toBe(ids.company);
    const after = (await request(api).get('/api/recruitment/screening-questions')).body;
    expect(after.find(x => x.code === q.code)).toBeUndefined();
    const all = (await request(api).get('/api/recruitment/screening-questions').query({ include_inactive: 1 })).body;
    expect(all.find(x => x.code === q.code).prompt).toBe(`${TAG} reworded`);
    const { rows: [shared] } = await pool.query(`SELECT prompt FROM screening_questions WHERE code = $1 AND company_id IS NULL`, [q.code]);
    expect(shared.prompt).not.toBe(`${TAG} reworded`);
  });
});

describe('Agency fee on hire', () => {
  it('records the fee when an agency candidate becomes an employee', async () => {
    ids.agency = (await pool.query(
      `INSERT INTO recruitment_agencies (company_id, agency_name, fee_percentage) VALUES ($1, $2, 8.33) RETURNING id`,
      [ids.company, `${TAG} Agency`])).rows[0].id;
    const c = await request(api).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Arun`, email: `${TAG.toLowerCase()}.arun@test.invalid`, applied_job_id: ids.opening,
      source: 'agency', source_agency_id: ids.agency,
    });
    expect(c.status).toBe(201);
    await pool.query(
      `INSERT INTO offer_letters (candidate_id, job_opening_id, offered_salary, company_id, offer_status)
       VALUES ($1, $2, 600000, $3, 'accepted')`, [c.body.id, ids.opening, ids.company]);
    await pool.query(`UPDATE candidates SET current_stage = 'hired', overall_status = 'hired', hired_at = NOW() WHERE id = $1`, [c.body.id]);
    const out = await repo.autoCreateEmployeeFromCandidate(c.body.id, ids.company, null);
    expect(out.status).toBe(201);
    const fees = (await request(api).get('/api/talent/agencies/fees')).body.data;
    const fee = fees.find(f => f.candidate_id === c.body.id);
    expect(Number(fee.fee_amount)).toBe(49980);
    expect(fee.status).toBe('pending');
    const upd = await request(api).put(`/api/talent/agencies/fees/${fee.id}`).send({ status: 'paid', invoice_no: 'INV-1' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.paid_on).toBeTruthy();
  });
});

describe('Email templates — shared defaults are listed, copied on edit, never deleted', () => {
  it('lists the shared defaults, including Application Received', async () => {
    const res = await request(api).get('/api/recruitment/email-templates');
    expect(res.status).toBe(200);
    const triggers = res.body.filter(t => t.is_default).map(t => t.stage_trigger);
    expect(triggers).toEqual(expect.arrayContaining(['application_received', 'offer_sent', 'hired_welcome']));
  });

  it('editing a default saves a company copy and leaves the default alone', async () => {
    const list = (await request(api).get('/api/recruitment/email-templates')).body;
    const def = list.find(t => t.is_default && t.stage_trigger === 'offer_sent');
    const res = await request(api).put(`/api/recruitment/email-templates/${def.id}`).send({ subject: `${TAG} our offer` });
    expect(res.status).toBe(201);
    expect(res.body.company_id).toBe(ids.company);
    const { rows: [shared] } = await pool.query(`SELECT subject FROM email_templates WHERE id = $1`, [def.id]);
    expect(shared.subject).not.toBe(`${TAG} our offer`);
    const after = (await request(api).get('/api/recruitment/email-templates')).body;
    expect(after.find(t => t.id === def.id).overridden).toBe(true);
    await pool.query(`DELETE FROM email_templates WHERE id = $1`, [res.body.id]);
  });

  it('refuses to delete a shared default', async () => {
    const list = (await request(api).get('/api/recruitment/email-templates')).body;
    const def = list.find(t => t.is_default);
    expect((await request(api).delete(`/api/recruitment/email-templates/${def.id}`)).status).toBe(409);
  });
});

describe('My Interviews — a panel member with NO Recruitment access', () => {
  let panelApp; let outsiderApp; let ivId;
  beforeAll(async () => {
    const { default: router } = await import('../modules/recruitment/routes/myInterviews.routes.js');
    const mk = (userId, employeeId) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = { userId, id: userId, roles: ['employee'], role: 'employee', company_id: ids.company, employee_id: employeeId };
        req.scope = { company_id: ids.company };
        next();
      });
      app.use('/api/my-interviews', router);
      app.use('/api/recruitment', recruitRouter);
      return app;
    };
    const u1 = (await pool.query(`INSERT INTO users (email, role, is_active, employee_id) VALUES ($1, 'employee', true, $2) RETURNING id`,
      [`${TAG}.panel@test.invalid`, ids.panelist])).rows[0].id;
    const outsiderEmp = (await pool.query(
      `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, 'Outsider', $2) RETURNING id`,
      [TAG, ids.company])).rows[0].id;
    const u2 = (await pool.query(`INSERT INTO users (email, role, is_active, employee_id) VALUES ($1, 'employee', true, $2) RETURNING id`,
      [`${TAG}.outsider@test.invalid`, outsiderEmp])).rows[0].id;
    panelApp = mk(u1, ids.panelist);
    outsiderApp = mk(u2, outsiderEmp);
    const iv = await request(api).post('/api/recruitment/interviews').send({
      candidate_id: ids.candidate, interview_date: new Date().toISOString().slice(0, 10), interview_mode: 'video',
      interviewer_id: ids.employee, panel_employee_ids: [ids.panelist], interview_round: '2nd_level',
    });
    expect(iv.status).toBe(201);
    ivId = iv.body.id;
  });

  it('cannot open the recruitment API', async () => {
    expect((await request(panelApp).get('/api/recruitment/candidates')).status).toBe(403);
  });

  it('sees the interview they are on, with candidate basics', async () => {
    const res = await request(panelApp).get('/api/my-interviews');
    expect(res.status).toBe(200);
    const iv = res.body.find(x => x.id === ivId);
    expect(iv.candidate_name).toMatch(/Priya/);
    expect(iv.is_lead).toBe(false);
    expect(iv.my_feedback).toBeNull();
    expect((await request(panelApp).get('/api/my-interviews/summary')).body.feedback_due).toBeGreaterThanOrEqual(1);
  });

  it('someone not on the panel sees nothing and cannot give feedback', async () => {
    expect((await request(outsiderApp).get('/api/my-interviews')).body.find(x => x.id === ivId)).toBeUndefined();
    expect((await request(outsiderApp).post(`/api/my-interviews/${ivId}/feedback`).send({ recommendation: 'hire' })).status).toBe(404);
  });

  it('gives feedback once, and a second save updates it', async () => {
    const a = await request(panelApp).post(`/api/my-interviews/${ivId}/feedback`).send({ recommendation: 'hire', rating: 4, comments: 'Good' });
    expect(a.status).toBe(201);
    const b = await request(panelApp).post(`/api/my-interviews/${ivId}/feedback`).send({ recommendation: 'strong_hire', rating: 5 });
    expect(b.status).toBe(200);
    const { rows } = await pool.query(`SELECT recommendation FROM interview_notes WHERE interview_id = $1 AND interviewer_id = $2`, [ivId, ids.panelist]);
    expect(rows).toEqual([{ recommendation: 'strong_hire' }]);
  });

  it('refuses feedback on an interview that has not happened yet', async () => {
    const { rows: [f] } = await pool.query(
      `INSERT INTO interview_schedules (candidate_id, company_id, interview_date, status, interviewer_id, panel_employee_ids)
       VALUES ($1, $2, CURRENT_DATE + 3, 'scheduled', $3, $4::jsonb) RETURNING id`,
      [ids.candidate, ids.company, ids.employee, JSON.stringify([ids.panelist])]);
    const res = await request(panelApp).post(`/api/my-interviews/${f.id}/feedback`).send({ recommendation: 'hire' });
    expect(res.status).toBe(409);
    await pool.query(`DELETE FROM interview_schedules WHERE id = $1`, [f.id]);
  });

  it('the Approval Center lists the feedback task only for the lead who has not given it', async () => {
    const { SOURCE_BY_TYPE } = await import('../modules/approvals/approvals.sources.js');
    const rows = await SOURCE_BY_TYPE.ivfb.pending(ids.company);
    const mine = rows.filter(r => r.source_id === ivId);
    expect(mine.map(r => Number(r.assignee_emp_id))).toEqual([ids.employee]);
  });
});

describe('My Recruitment Work — every tile opens the set it counted', () => {
  it('each candidate tile count equals the candidate list for ?queue=<key>', async () => {
    const { body } = await request(api).get('/api/recruitment/work-queue');
    for (const key of ['needs_screening', 'waiting_over_3_days', 'joining_pending', 'recommended_for_other_roles', 'unassigned']) {
      const list = await request(api).get('/api/recruitment/candidates').query({ queue: key, limit: 1 });
      expect(list.status).toBe(200);
      expect({ key, n: list.body.total }).toEqual({ key, n: body.counts[key] });
    }
  });

  it('an unknown queue key does not narrow (or break) the list', async () => {
    const all = await request(api).get('/api/recruitment/candidates').query({ limit: 1 });
    const bad = await request(api).get('/api/recruitment/candidates').query({ queue: "x'); DROP TABLE t;--", limit: 1 });
    expect(bad.status).toBe(200);
    expect(bad.body.total).toBe(all.body.total);
  });

  it('feedback is owed per interview: a note on one round does not hide another', async () => {
    const { rows: [past] } = await pool.query(
      `INSERT INTO interview_schedules (candidate_id, company_id, interview_date, status, interviewer_id)
       VALUES ($1, $2, CURRENT_DATE - 2, 'scheduled', $3) RETURNING id`, [ids.candidate, ids.company, ids.employee]);
    const { rows: [other] } = await pool.query(
      `INSERT INTO interview_schedules (candidate_id, company_id, interview_date, status, interviewer_id)
       VALUES ($1, $2, CURRENT_DATE - 5, 'scheduled', $3) RETURNING id`, [ids.candidate, ids.company, ids.employee]);
    await pool.query(
      `INSERT INTO interview_notes (candidate_id, interviewer_id, interview_id, recommendation, company_id)
       VALUES ($1, $2, $3, 'hire', $4)`, [ids.candidate, ids.employee, other.id, ids.company]);
    try {
      const { body } = await request(api).get('/api/recruitment/work-queue');
      const listed = body.feedback_due.map(r => r.id);
      expect(listed).toContain(past.id);
      expect(listed).not.toContain(other.id);
      expect(body.counts.feedback_pending).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.query(`DELETE FROM interview_notes WHERE interview_id = ANY($1::uuid[])`, [[past.id, other.id]]);
      await pool.query(`DELETE FROM interview_schedules WHERE id = ANY($1::uuid[])`, [[past.id, other.id]]);
    }
  });
});

describe('Candidate ID', () => {
  it('every new candidate gets a CAND- code', async () => {
    const { rows: [c] } = await pool.query(`SELECT id, candidate_code FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(c.candidate_code).toBe(`CAND-${String(c.id).padStart(5, '0')}`);
  });
});
