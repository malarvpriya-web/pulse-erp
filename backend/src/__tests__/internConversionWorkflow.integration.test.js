/**
 * Internship completion & conversion workflow — templates, the mentor
 * evaluation request (send / remind / receive a returned document), the derived
 * completion stage, template-generated certificates, and Convert to Employee
 * through the real POST /employees. Real routers, real logins, real database
 * (including the guard triggers).
 *
 * Registry tenants 999958 / 999959 (testTenantIds.contract). Fixtures and
 * uploaded files are removed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

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
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { loginUser } = await import('../auth/auth.service.js');
const { default: internRouter } = await import('../modules/hr/internships.routes.js');
const { default: evalRouter } = await import('../modules/hr/internEvaluations.routes.js');
const { default: employeeRoutes } = await import('../employees/employee.routes.js');
const { default: filesRouter } = await import('../modules/files/secureFiles.routes.js');
const { default: documentsRepository } = await import('../modules/documents/repositories/documents.repository.js');
const { LOCAL_UPLOAD_DIR, uploadFile } = await import('../services/StorageService.js');
const { RATING_FIELDS } = await import('../shared/internship.js');

const OWN = 999958;
const FOREIGN = 999959;
const PW = 'Zz-Convert-Test-9!';
const fx = { tok: {}, user: {}, emp: {}, files: new Set() };

const app = express();
app.use(express.json());
app.use('/api/interns', verifyToken, internRouter);
app.use('/api/intern-evaluations', verifyToken, evalRouter);
app.use('/api/employees', employeeRoutes);
app.use('/api/files', verifyToken, filesRouter);

const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const RATINGS = Object.fromEntries(RATING_FIELDS.map(f => [f.key, 4]));
const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
const get = (who, url) => request(app).get(url).set(as(who));
const post = (who, url, body = {}) => request(app).post(url).set(as(who)).send(body);
const stage = async (id) => (await get('hr', `/api/interns/${id}`)).body.completion_stage;
const pdfBody = (r) => Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.text || '', 'binary');
const binary = (req) => req.buffer(true).parse((res, cb) => {
  const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
});

async function cleanup() {
  const c = [OWN, FOREIGN];
  const { rows } = await pool.query(`SELECT file_url FROM intern_documents WHERE company_id = ANY($1::int[])`, [c]);
  for (const { file_url: u } of rows) fx.files.add(u);
  const { rows: photos } = await pool.query(`SELECT photo_url FROM interns WHERE company_id = ANY($1::int[]) AND photo_url IS NOT NULL`, [c]);
  for (const { photo_url: u } of photos) fx.files.add(u);
  for (const u of fx.files) { const name = String(u).split('/').pop(); if (name) rmSync(join(LOCAL_UPLOAD_DIR, name), { force: true }); }
  await pool.query(`UPDATE intern_certificates SET revoked_at = NOW(), revoked_by_user_id = 1, revoke_reason = 'test cleanup'
                     WHERE company_id = ANY($1::int[]) AND revoked_at IS NULL`, [c]);
  await pool.query(`UPDATE interns SET certificate_issued = false, certificate_number = NULL, completion_evaluation_id = NULL
                     WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`UPDATE employees SET source_intern_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_audit_events WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_certificates WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_evaluation_events WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`UPDATE intern_evaluations SET evaluation_document_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_evaluations WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_documents WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interns WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM document_templates WHERE company_id = ANY($1::int[])`, [c]);
  const users = `SELECT id FROM users WHERE email LIKE 'zz.iconv.%@example.com' OR employee_id IN (SELECT id FROM employees WHERE company_id = ANY($1::int[]))`;
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`, [c]);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`, [c]);
  await pool.query(`DELETE FROM users WHERE id IN (${users})`, [c]);
  const emps = `SELECT id FROM employees WHERE company_id = ANY($1::int[])`;
  for (const t of ['employee_salary_assignments', 'employee_onboarding_progress', 'onboarding_progress']) {
    await pool.query(`DELETE FROM ${t} WHERE employee_id IN (${emps})`, [c]).catch(() => {});
  }
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds 10 default interview questions for EVERY active
  // company each time it is imported (each dev-server restart). If that happens
  // while this suite's two companies exist, those rows hold an FK on them and
  // the DELETE below fails — which is exactly what stranded 999958/999959 on
  // 2026-10-19 (seeded 3.4 s after this suite created them) and made every later
  // run fail in beforeAll with all 18 tests skipped. Scoped to this suite's own
  // registry tenants only, like every other suite that creates companies.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let codeSeq = 0;
async function intern(companyId, { status = 'Active', start = iso(-60), end = iso(20), mentor, extra = {} } = {}) {
  codeSeq += 1;
  const cols = { company_id: companyId, intern_code: `INT${String(codeSeq).padStart(3, '0')}`, first_name: 'Zz',
    last_name: `Intern${codeSeq}`, college: 'ZZ College', course: 'BE/BTech', department: fx.dept, designation: fx.desig,
    mentor_employee_id: mentor ?? (companyId === OWN ? fx.emp.mentor : fx.emp.foreignMentor),
    start_date: start, end_date: end, status, ...extra };
  const keys = Object.keys(cols);
  return (await pool.query(`INSERT INTO interns (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(cols))).rows[0].id;
}

/** request → mentor submits → a DIFFERENT HR user approves. Returns the evaluation id. */
async function approvedEvaluation(internId, recommendation) {
  const r = await post('hr', '/api/intern-evaluations/request', { intern_id: internId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const s = await post('mentor', `/api/intern-evaluations/mine/${internId}/submit`, { ...RATINGS, comments: 'Solid work.', recommendation });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const a = await post('hrManager', `/api/intern-evaluations/${r.body.id}/review`, { decision: 'Approve' });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return r.body.id;
}

const completeNow = (id) => post('hr', `/api/interns/${id}/complete`, { completed_on: iso(0) });

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ Convert Own','ZZCVO'), ($2,'ZZ Convert Foreign','ZZCVF')`, [OWN, FOREIGN]);
  fx.dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  fx.desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  let n = 0;
  const emp = async (key, cid) => {
    n += 1;
    fx.emp[key] = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date)
       VALUES ($1,$2,'Zz',$3,$4,$5,$6,'Active','2025-01-01') RETURNING id`,
      [cid, `EMP${cid === OWN ? '958' : '959'}${String(n).padStart(3, '0')}`, key, `zz.iconv.emp.${key}@example.com`, fx.dept, fx.desig])).rows[0].id;
  };
  await emp('mentor', OWN); await emp('lead', OWN); await emp('bystander', OWN); await emp('foreignMentor', FOREIGN);
  const hash = await bcrypt.hash(PW, 4);
  const login = async (key, role, cid, employeeId = null) => {
    const email = `zz.iconv.${key}@example.com`;
    fx.user[key] = (await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
       VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
    fx.tok[key] = (await loginUser(email, PW)).token;
  };
  await login('mentor', 'employee', OWN, fx.emp.mentor);
  await login('lead', 'employee', OWN, fx.emp.lead);
  await login('bystander', 'employee', OWN, fx.emp.bystander);
  await login('hr', 'hr', OWN);
  await login('hrManager', 'hr_manager', OWN);
  await login('payroll', 'payroll_admin', OWN);
  await login('foreignHr', 'hr', FOREIGN);
});

afterAll(cleanup);

// ═════════════════════════════════════════════════════════════════════════════
describe('document templates', () => {
  it('serves the built-in defaults until a company edits one', async () => {
    const r = await get('hr', '/api/interns/templates');
    expect(r.status).toBe(200);
    expect(r.body.map(t => t.key)).toEqual(['completion_certificate', 'evaluation_letter']);
    expect(r.body.every(t => t.is_default)).toBe(true);
    expect(Object.keys(r.body[0].placeholders)).toEqual(expect.arrayContaining(['intern_name', 'certificate_number', 'project_work_area']));
  });

  it('saves a company template, refuses unknown fields, and keeps it to that company', async () => {
    const bad = await request(app).put('/api/interns/templates/completion_certificate').set(as('hr'))
      .send({ heading: 'CERT', content: 'Dear {{intern_nme}}' });
    expect([bad.status, bad.body.field]).toEqual([400, 'content']);
    expect(bad.body.error).toContain('{{intern_nme}}');

    const ok = await request(app).put('/api/interns/templates/completion_certificate').set(as('hr'))
      .send({ heading: 'ZZ COMPLETION', content: 'Certified: {{intern_name}} ({{intern_code}}) of {{college}}.',
        signatory_name: 'Zz Director', signatory_title: 'Director, HR' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ is_default: false, heading: 'ZZ COMPLETION', signatory_name: 'Zz Director' });

    const foreign = await get('foreignHr', '/api/interns/templates');
    expect(foreign.body[0]).toMatchObject({ is_default: true });
    expect(foreign.body[0].heading).not.toBe('ZZ COMPLETION');
  });

  it('is maintained by HR only, and hidden from the untenanted generic template routes', async () => {
    const r = await request(app).put('/api/interns/templates/evaluation_letter').set(as('mentor'))
      .send({ heading: 'X', content: 'Y' });
    expect(r.status).toBe(403);
    const generic = await documentsRepository.findTemplates({});
    expect(generic.some(t => t.owner_module)).toBe(false);
    const { rows: [own] } = await pool.query(`SELECT id FROM document_templates WHERE company_id = $1 AND template_key = 'completion_certificate' AND deleted_at IS NULL`, [OWN]);
    expect(await documentsRepository.findTemplateById(own.id)).toBeUndefined();
    await documentsRepository.updateTemplate(own.id, { content: 'hijacked' });
    await documentsRepository.deleteTemplate(own.id);
    const after = await get('hr', '/api/interns/templates');
    expect(after.body[0]).toMatchObject({ is_default: false, heading: 'ZZ COMPLETION' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Request Mentor Evaluation', () => {
  beforeAll(async () => { fx.req = await intern(OWN, { extra: { project_work_area: 'Billing API' } }); });

  it('starts Active, and a draft request does not reach the mentor', async () => {
    expect(await stage(fx.req)).toBe('Active');
    const r = await post('hr', '/api/intern-evaluations/request', { intern_id: fx.req, mentor_employee_id: fx.emp.lead, send: false });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ request_status: 'Draft', mentor_employee_id: fx.emp.lead, request_sent_at: null });
    fx.reqEval = r.body.id;
    const mine = await get('lead', '/api/intern-evaluations/mine');
    expect(mine.body.interns.map(i => i.id)).not.toContain(fx.req);
  });

  it('send: the chosen mentor is notified and gains this one evaluation; others do not', async () => {
    const r = await post('hr', `/api/intern-evaluations/${fx.reqEval}/send`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ request_status: 'Sent', notified_logins: 1 });
    expect(r.body.request_sent_at).toBeTruthy();
    const { rows: notes } = await pool.query(
      `SELECT notification_type, reference_id FROM notifications WHERE user_id = $1`, [fx.user.lead]);
    expect(notes).toEqual([{ notification_type: 'intern_evaluation_request', reference_id: fx.reqEval }]);
    expect(await stage(fx.req)).toBe('Evaluation Requested');

    const mine = await get('lead', '/api/intern-evaluations/mine');
    expect(mine.body.interns.find(i => i.id === fx.req)).toMatchObject({ is_current_mentor: false, project_work_area: 'Billing API' });
    expect((await get('lead', '/api/intern-evaluations/mine/summary')).body).toMatchObject({ is_mentor: true, needs_action: 1 });
    const stranger = await request(app).put(`/api/intern-evaluations/mine/${fx.req}`).set(as('bystander')).send({ comments: 'x' });
    expect(stranger.status).toBe(404);
  });

  it('a second request while one is open is refused; a reminder is counted', async () => {
    const again = await post('hr', '/api/intern-evaluations/request', { intern_id: fx.req, mentor_employee_id: fx.emp.mentor });
    expect([again.status, again.body.code]).toEqual([409, 'EVALUATION_ALREADY_OPEN']);
    const same = await post('hr', '/api/intern-evaluations/request', { intern_id: fx.req, mentor_employee_id: fx.emp.lead });
    expect([same.status, same.body.code]).toEqual([409, 'ALREADY_REQUESTED']);
    const r = await post('hr', `/api/intern-evaluations/${fx.reqEval}/remind`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ request_status: 'Reminder', reminder_count: 1 });
    expect(r.body.last_reminder_at).toBeTruthy();
    expect(await post('mentor', `/api/intern-evaluations/${fx.reqEval}/remind`).then(x => x.status)).toBe(403);
  });

  it('the letter is a PDF for HR and the addressed mentor only, never another tenant', async () => {
    const hr = await binary(get('hr', `/api/intern-evaluations/${fx.reqEval}/letter.pdf`));
    expect(hr.status).toBe(200);
    expect(hr.headers['content-type']).toBe('application/pdf');
    expect(pdfBody(hr).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await binary(get('lead', `/api/intern-evaluations/${fx.reqEval}/letter.pdf`))).status).toBe(200);
    expect((await get('bystander', `/api/intern-evaluations/${fx.reqEval}/letter.pdf`)).status).toBe(404);
    expect((await get('foreignHr', `/api/intern-evaluations/${fx.reqEval}/letter.pdf`)).status).toBe(404);
  });

  it('the mentor must rate all six areas; online submission marks it Received', async () => {
    const partial = await post('lead', `/api/intern-evaluations/mine/${fx.req}/submit`,
      { ...RATINGS, teamwork: null, comments: 'Good', recommendation: 'Recommended for Employment' });
    expect([partial.status, partial.body.field]).toEqual([400, 'teamwork']);
    const outOfRange = await post('lead', `/api/intern-evaluations/mine/${fx.req}/submit`,
      { ...RATINGS, teamwork: 6, comments: 'Good', recommendation: 'Recommended for Employment' });
    expect([outOfRange.status, outOfRange.body.field]).toEqual([400, 'teamwork']);
    const r = await post('lead', `/api/intern-evaluations/mine/${fx.req}/submit`,
      { ...RATINGS, comments: 'Good', recommendation: 'Recommended for Employment' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'Submitted', request_status: 'Received', received_via: 'Online', teamwork: 4 });
    expect(await stage(fx.req)).toBe('Evaluation Received');
    expect((await post('hr', `/api/intern-evaluations/${fx.reqEval}/remind`)).status).toBe(409);
  });

  it('a signed copy can be attached to an online evaluation; approval completes the request', async () => {
    const r = await request(app).post(`/api/intern-evaluations/${fx.reqEval}/document`).set(as('hr'))
      .attach('evaluation_file', Buffer.from('%PDF-1.4 signed'), { filename: 'signed.pdf', contentType: 'application/pdf' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.evaluation_document_url).toBeTruthy();
    const a = await post('hrManager', `/api/intern-evaluations/${fx.reqEval}/review`, { decision: 'Approve' });
    expect(a.body).toMatchObject({ status: 'Approved', request_status: 'Completed' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a returned paper evaluation', () => {
  beforeAll(async () => {
    fx.paper = await intern(OWN);
    const r = await post('hr', '/api/intern-evaluations/request', { intern_id: fx.paper });
    fx.paperEval = r.body.id;
  });

  it('needs the returned document AND complete ratings', async () => {
    const noFile = await request(app).post(`/api/intern-evaluations/${fx.paperEval}/receive`).set(as('hr'))
      .field('comments', 'x').field('recommendation', 'Not Recommended');
    expect([noFile.status, noFile.body.field]).toEqual([400, 'evaluation_file']);
    const noRatings = await request(app).post(`/api/intern-evaluations/${fx.paperEval}/receive`).set(as('hr'))
      .field('comments', 'x').field('recommendation', 'Not Recommended')
      .attach('evaluation_file', Buffer.from('%PDF-1.4 form'), { filename: 'form.pdf', contentType: 'application/pdf' });
    expect(noRatings.status).toBe(400);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM intern_documents WHERE intern_id = $1`, [fx.paper]);
    expect(rows[0].n).toBe(0);
  });

  it('is recorded with its file in secure storage; the recorder cannot approve it', async () => {
    let r = request(app).post(`/api/intern-evaluations/${fx.paperEval}/receive`).set(as('hr'))
      .field('comments', 'Returned on paper.').field('recommendation', 'Not Recommended');
    for (const [k, v] of Object.entries(RATINGS)) r = r.field(k, String(v));
    r = await r.attach('evaluation_file', Buffer.from('%PDF-1.4 form'), { filename: 'form.pdf', contentType: 'application/pdf' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'Submitted', received_via: 'Document', request_status: 'Received' });
    const { rows: [doc] } = await pool.query(`SELECT doc_type, file_url FROM intern_documents WHERE id = $1`, [r.body.evaluation_document_id]);
    expect(doc.doc_type).toBe('Mentor Evaluation');
    const name = doc.file_url.split('/').pop();
    expect((await get('hr', `/api/files/${name}`)).status).toBe(200);
    expect((await get('bystander', `/api/files/${name}`)).status).toBe(403);
    expect((await get('foreignHr', `/api/files/${name}`)).status).toBe(403);

    const self = await post('hr', `/api/intern-evaluations/${fx.paperEval}/review`, { decision: 'Approve' });
    expect(self.status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('completion stage', () => {
  it('is Evaluation Pending past the end date with nothing received — and nothing completes by itself', async () => {
    const id = await intern(OWN, { start: iso(-90), end: iso(-3) });
    expect(await stage(id)).toBe('Evaluation Pending');
    await post('hr', '/api/intern-evaluations/request', { intern_id: id });
    expect(await stage(id)).toBe('Evaluation Pending');
    const { rows: [i] } = await pool.query(`SELECT status FROM interns WHERE id = $1`, [id]);
    expect(i.status).toBe('Active');
    const list = await get('hr', '/api/interns?stage=Evaluation%20Pending');
    expect(list.body.map(x => x.id)).toContain(id);
    const card = await get('hr', '/api/interns/summary');
    expect(card.body.cards.evaluation_pending).toBeGreaterThanOrEqual(1);
  });

  it('Need Further Review and Extend keep the internship open; Not Recommended completes it but cannot convert', async () => {
    const review = await intern(OWN);
    await approvedEvaluation(review, 'Need Further Review');
    expect((await completeNow(review)).status).toBe(409);

    const notRec = await intern(OWN);
    await approvedEvaluation(notRec, 'Not Recommended');
    const c = await completeNow(notRec);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'Completed', completion_stage: 'Completed' });
    expect(c.body.conversion).toMatchObject({ eligible: false });
    fx.notRec = notRec;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('certificate from the template', () => {
  it('is generated, auto-numbered, stored and served — only after completion', async () => {
    const early = await intern(OWN);
    expect((await get('hr', `/api/interns/${early}/certificate/preview.pdf`)).status).toBe(409);

    const preview = await binary(get('hr', `/api/interns/${fx.notRec}/certificate/preview.pdf`));
    expect(preview.status).toBe(200);
    expect(pdfBody(preview).subarray(0, 5).toString()).toBe('%PDF-');

    const r = await request(app).post(`/api/interns/${fx.notRec}/certificate`).set(as('hr')).field('generate', 'true');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { rows: [i] } = await pool.query(`SELECT intern_code, certificate_number FROM interns WHERE id = $1`, [fx.notRec]);
    expect(i.certificate_number).toBe(`${i.intern_code}/CERT/${iso(0).slice(0, 4)}/1`);
    expect(r.body.completion_stage).toBe('Certificate Issued');
    const cert = r.body.certificates[0];
    expect(cert).toMatchObject({ certificate_number: i.certificate_number, issued_by_user_id: fx.user.hr });
    expect(cert.file_url).toBeTruthy();
    const file = await binary(get('hr', `/api/files/${cert.file_url.split('/').pop()}`));
    expect(file.status).toBe(200);
    expect(pdfBody(file).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Convert to Employee', () => {
  const hire = (who, internId, extra = {}) => post(who, '/api/employees', {
    first_name: 'Zz', last_name: 'Converted', company_email: `zz.iconv.hire.${internId}.${Date.now()}@example.com`,
    department: fx.dept, designation: fx.desig, status: 'Active', joining_date: iso(0), employment_type: 'Full Time',
    // mandatory on Add Employee since §202 — the conversion goes through that form
    account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street',
    from_intern_id: internId, ...extra,
  });

  beforeAll(async () => {
    fx.photo = await uploadFile(Buffer.from('\x89PNG fake'), 'photo.png', 'image/png');
    fx.resume = await uploadFile(Buffer.from('%PDF-1.4 cv'), 'cv.pdf', 'application/pdf');
    fx.files.add(fx.photo); fx.files.add(fx.resume);
    fx.conv = await intern(OWN, { extra: { photo_url: fx.photo, personal_email: 'zz.iconv.personal@example.com', phone: '9876543210' } });
    await pool.query(
      `INSERT INTO intern_documents (company_id, intern_id, doc_type, file_url, original_name, mime_type, size_bytes)
       VALUES ($1,$2,'Resume',$3,'cv.pdf','application/pdf',10)`, [OWN, fx.conv, fx.resume]);
  });

  it('is offered only after an approved "Recommended for Employment" evaluation AND completion', async () => {
    let r = await get('hr', `/api/interns/${fx.conv}/conversion`);
    expect(r.body.eligibility.eligible).toBe(false);
    expect((await hire('hr', fx.conv)).status).toBe(409);
    await approvedEvaluation(fx.conv, 'Recommended for Employment');
    r = await get('hr', `/api/interns/${fx.conv}/conversion`);
    expect(r.body.eligibility).toMatchObject({ eligible: false, reason: 'Mark the internship Completed first.' });
    expect((await completeNow(fx.conv)).status).toBe(200);
    r = await get('hr', `/api/interns/${fx.conv}/conversion`);
    expect(r.body.eligibility.eligible).toBe(true);
    expect(r.body.prefill).toMatchObject({ first_name: 'Zz', personal_email: 'zz.iconv.personal@example.com', phone: '9876543210' });
    expect(r.body.prefill).not.toHaveProperty('department');
    expect(r.body.intern).toMatchObject({ photo_url: fx.photo, resume_file: fx.resume });
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1 AND source_intern_id IS NOT NULL`, [OWN]);
    expect(rows[0].n).toBe(0);
  });

  it('refuses another tenant, and a role without the internships edit grant', async () => {
    expect((await hire('foreignHr', fx.conv)).status).toBe(404);
    const payroll = await hire('payroll', fx.conv);
    expect(payroll.status).toBe(403);
    const { rows } = await pool.query(`SELECT converted_employee_id FROM interns WHERE id = $1`, [fx.conv]);
    expect(rows[0].converted_employee_id).toBeNull();
  });

  it('creates ONE employee through the normal path, with an EMP id, the intern files reused, linked both ways', async () => {
    const r = await hire('hr', fx.conv);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.office_id).toMatch(/^EMP[0-9]{3,}$/);
    expect(r.body).toMatchObject({ source_intern_id: fx.conv, photo_url: fx.photo, resume_file: fx.resume });
    const { rows: [i] } = await pool.query(
      `SELECT converted_employee_id, converted_by_user_id, converted_at, deleted_at FROM interns WHERE id = $1`, [fx.conv]);
    expect(i).toMatchObject({ converted_employee_id: r.body.id, converted_by_user_id: fx.user.hr, deleted_at: null });
    const view = await get('hr', `/api/interns/${fx.conv}`);
    expect(view.body).toMatchObject({ converted_employee_id: r.body.id, converted_employee_code: r.body.office_id });
    expect(view.body.lifecycle_events.map(e => e.action)).toContain('converted_to_employee');
    const emp = await get('hr', `/api/employees/${r.body.id}`);
    expect(emp.body).toMatchObject({ source_intern_id: fx.conv });
    expect(emp.body.source_intern_code).toMatch(/^INT[0-9]{3,}$/);
    // The employee's photo is now served by the employee rule (the hire may open it).
    expect((await get('hr', `/api/files/${fx.photo.split('/').pop()}`)).status).toBe(200);
    fx.convertedEmployee = r.body.id;
  });

  it('happens once: a second conversion is refused and the database will not re-link', async () => {
    expect((await hire('hr', fx.conv)).status).toBe(409);
    await expect(pool.query(`UPDATE interns SET converted_employee_id = $2 WHERE id = $1`, [fx.conv, fx.emp.bystander]))
      .rejects.toThrow(/already converted/);
    const other = await intern(OWN);
    await expect(pool.query(`UPDATE interns SET converted_employee_id = $2 WHERE id = $1`, [other, fx.emp.bystander]))
      .rejects.toThrow(/only a completed internship/);
  });
});

// linkConversion carries the intern's company on both writes (2026-10-20). The
// only caller cannot hand it a mismatched pair today; this pins the boundary
// itself so a future caller cannot either.
describe('linkConversion refuses an employee from another company', () => {
  it('throws CONVERSION_COMPANY_MISMATCH and changes neither record', async () => {
    const { linkConversion } = await import('../modules/hr/internConversion.js');
    const internId = await intern(OWN);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(linkConversion(client, {
        intern: { id: internId, company_id: OWN }, eligibility: {},
        employee: { id: fx.emp.foreignMentor, office_id: 'EMP959001' }, userId: fx.user.hr,
      })).rejects.toMatchObject({ statusCode: 409, code: 'CONVERSION_COMPANY_MISMATCH' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const { rows: [e] } = await pool.query(`SELECT source_intern_id FROM employees WHERE id = $1`, [fx.emp.foreignMentor]);
    const { rows: [i] } = await pool.query(`SELECT converted_employee_id FROM interns WHERE id = $1`, [internId]);
    expect(e.source_intern_id).toBeNull();
    expect(i.converted_employee_id).toBeNull();
  });
});
