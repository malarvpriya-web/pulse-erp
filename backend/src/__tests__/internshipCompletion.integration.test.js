/**
 * Internship completion gate, status transitions, certificate issuance /
 * revocation and their audit events — through the real router, real logins and
 * the real database (including its guard triggers).
 *
 * Registry tenants 999956 / 999957 (testTenantIds.contract). Fixtures and
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
const { default: filesRouter } = await import('../modules/files/secureFiles.routes.js');
const { LOCAL_UPLOAD_DIR } = await import('../services/StorageService.js');
const { STATUS_TRANSITIONS, INITIAL_STATUSES } = await import('../shared/internship.js');

const OWN = 999956;
const FOREIGN = 999957;
const PW = 'Zz-Complete-Test-9!';
const fx = { tok: {}, user: {}, files: new Set() };

const app = express();
app.use(express.json());
app.use('/api/interns', verifyToken, internRouter);
app.use('/api/files', filesRouter);

const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const complete = (who, id, body) => request(app).post(`/api/interns/${id}/complete`).set(as(who)).send(body);
const revoke = (who, id, body) => request(app).post(`/api/interns/${id}/certificate/revoke`).set(as(who)).send(body);
function issue(who, id, number, file) {
  let r = request(app).post(`/api/interns/${id}/certificate`).set(as(who));
  if (number != null) r = r.field('certificate_number', number);
  if (file) r = r.attach('certificate_file', Buffer.from('%PDF-1.4 cert'), { filename: file, contentType: 'application/pdf' });
  return r;
}
const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
const row = async (id) => (await pool.query(
  `SELECT status, completed_on::text AS completed_on, completion_evaluation_id, certificate_issued, certificate_number
     FROM interns WHERE id = $1`, [id])).rows[0];

async function cleanup() {
  const c = [OWN, FOREIGN];
  const { rows } = await pool.query(`SELECT file_url FROM intern_documents WHERE company_id = ANY($1::int[])`, [c]);
  for (const { file_url: u } of rows) fx.files.add(u);
  for (const u of fx.files) { const name = String(u).split('/').pop(); if (name) rmSync(join(LOCAL_UPLOAD_DIR, name), { force: true }); }
  // The completion guard refuses dropping an unrevoked certificate, so revoke,
  // then clear the intern's copy, then delete — in that order.
  await pool.query(`UPDATE intern_certificates SET revoked_at = NOW(), revoked_by_user_id = 1, revoke_reason = 'test cleanup'
                     WHERE company_id = ANY($1::int[]) AND revoked_at IS NULL`, [c]);
  await pool.query(`UPDATE interns SET certificate_issued = false, certificate_number = NULL, completion_evaluation_id = NULL
                     WHERE company_id = ANY($1::int[])`, [c]);
  // Conversion links point both ways (each ON DELETE RESTRICT): unhook the
  // employee side, and the interns then delete normally.
  await pool.query(`UPDATE employees SET source_intern_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_audit_events WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_certificates WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_evaluation_events WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_evaluations WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_documents WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interns WHERE company_id = ANY($1::int[])`, [c]);
  const users = `SELECT id FROM users WHERE email LIKE 'zz.icomp.%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.icomp.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let codeSeq = 0;
async function intern(companyId, { status = 'Active', start = iso(-60), end = iso(-1) } = {}) {
  codeSeq += 1;
  return (await pool.query(
    `INSERT INTO interns (company_id, intern_code, first_name, college, course, department, designation,
                          mentor_employee_id, start_date, end_date, status)
     VALUES ($1,$2,'Zz','ZZ College','BE/BTech',$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, `INT${String(codeSeq).padStart(3, '0')}`, fx.dept, fx.desig,
      companyId === OWN ? fx.mentor : fx.foreignMentor, start, end, status])).rows[0].id;
}

/** An evaluation in any state, inserted directly (its workflow has its own suite). */
async function evaluation(internId, { status = 'Approved', recommendation = 'Recommended for Employment' } = {}) {
  const { rows: [i] } = await pool.query(`SELECT mentor_employee_id FROM interns WHERE id = $1`, [internId]);
  const submitted = ['Submitted', 'Approved', 'Returned'].includes(status);
  const reviewed = ['Approved', 'Returned'].includes(status);
  return (await pool.query(
    `INSERT INTO intern_evaluations (intern_id, mentor_employee_id, comments, recommendation, status, created_by_user_id,
                                     submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, return_reason,
                                     received_at, received_via, technical_skills, communication, teamwork,
                                     discipline_attendance, learning_ability, overall_performance)
     VALUES ($1,$2,'Fixture evaluation',$3,$4,1,$5,$6,$7,$8,$9,$6,$10,4,4,4,4,4,4) RETURNING id`,
    [internId, i.mentor_employee_id, recommendation, status,
      submitted ? 1 : null, submitted ? new Date() : null,
      reviewed ? 2 : null, reviewed ? new Date() : null, status === 'Returned' ? 'fixture' : null,
      submitted ? 'Online' : null])).rows[0].id;
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ Complete Own','ZZCPO'), ($2,'ZZ Complete Foreign','ZZCPF')`, [OWN, FOREIGN]);
  fx.dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  fx.desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  const emp = async (cid, code) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date)
     VALUES ($1,$2,'Zz','Mentor',$3,$4,$5,'Active','2025-01-01') RETURNING id`,
    [cid, code, `zz.icomp.emp.${code.toLowerCase()}@example.com`, fx.dept, fx.desig])).rows[0].id;
  fx.mentor = await emp(OWN, 'EMP956001');
  fx.foreignMentor = await emp(FOREIGN, 'EMP957001');
  const hash = await bcrypt.hash(PW, 4);
  const login = async (key, role, cid) => {
    const email = `zz.icomp.${key}@example.com`;
    fx.user[key] = (await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id) VALUES ($1,$2,$3,$4,true,$5) RETURNING id`,
      [`Zz ${key}`, email, hash, role, cid])).rows[0].id;
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
    fx.tok[key] = (await loginUser(email, PW)).token;
  };
  await login('hr', 'hr', OWN);
  await login('hrExec', 'hr_exec', OWN);
  await login('emp', 'employee', OWN);
  await login('foreignHr', 'hr', FOREIGN);
});

afterAll(cleanup);

// ═════════════════════════════════════════════════════════════════════════════
describe('the documented transitions', () => {
  it('never offer Completed through the general form, and Completed/Cancelled/Terminated are terminal', () => {
    for (const to of Object.values(STATUS_TRANSITIONS)) expect(to).not.toContain('Completed');
    expect(INITIAL_STATUSES).not.toContain('Completed');
    expect(STATUS_TRANSITIONS.Completed).toEqual([]);
    expect(STATUS_TRANSITIONS.Cancelled).toEqual([]);
    expect(STATUS_TRANSITIONS.Terminated).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('completion gate', () => {
  it('refuses without any evaluation, and says why on the record', async () => {
    const id = await intern(OWN);
    const view = await request(app).get(`/api/interns/${id}`).set(as('hr'));
    expect(view.body.completion).toMatchObject({ eligible: false });
    const r = await complete('hr', id, { completed_on: iso(-1) });
    expect([r.status, r.body.code]).toEqual([409, 'NOT_ELIGIBLE_FOR_COMPLETION']);
    expect((await row(id)).status).toBe('Active');
  });

  it.each([
    ['a submitted (unreviewed) evaluation', { status: 'Submitted' }],
    ['a returned evaluation', { status: 'Returned' }],
    ['an approved evaluation recommending an extension', { status: 'Approved', recommendation: 'Extend Internship' }],
    ['an approved evaluation needing further review', { status: 'Approved', recommendation: 'Need Further Review' }],
  ])('refuses with %s', async (_label, ev) => {
    const id = await intern(OWN);
    await evaluation(id, ev);
    const r = await complete('hr', id, { completed_on: iso(-1) });
    expect(r.status).toBe(409);
  });

  it('refuses when a newer evaluation has replaced the approved one', async () => {
    const id = await intern(OWN);
    await evaluation(id, { status: 'Approved' });
    await evaluation(id, { status: 'Draft' });
    expect((await complete('hr', id, { completed_on: iso(-1) })).status).toBe(409);
  });

  it('refuses an internship that is not Active', async () => {
    const id = await intern(OWN, { status: 'Onboarding' });
    await evaluation(id);
    const r = await complete('hr', id, { completed_on: iso(-1) });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Only an Active internship/);
  });

  it('validates the completion date', async () => {
    const id = await intern(OWN, { start: iso(-30) });
    await evaluation(id);
    let r = await complete('hr', id, {});
    expect([r.status, r.body.field]).toEqual([400, 'completed_on']);
    r = await complete('hr', id, { completed_on: iso(5) });
    expect([r.status, r.body.field]).toEqual([400, 'completed_on']);
    r = await complete('hr', id, { completed_on: iso(-40) });
    expect([r.status, r.body.field]).toEqual([400, 'completed_on']);
  });

  it('completes on an approved evaluation recommending completion, and records which', async () => {
    const id = await intern(OWN);
    const evalId = await evaluation(id);
    const before = await request(app).get(`/api/interns/${id}`).set(as('hr'));
    expect(before.body.completion).toEqual({ eligible: true, reason: null, evaluation_id: evalId });
    const r = await complete('hr', id, { completed_on: iso(-1) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'Completed', completed_on: iso(-1), completion_evaluation_id: evalId, certificate_issued: false });
    expect((await complete('hr', id, { completed_on: iso(-1) })).status).toBe(409);
    fx.completed = id;
    fx.completedEval = evalId;
  });

  it('hr_exec (edit permission) may complete; an employee may not', async () => {
    const id = await intern(OWN);
    await evaluation(id);
    expect((await complete('emp', id, { completed_on: iso(-1) })).status).toBe(403);
    expect((await complete('hrExec', id, { completed_on: iso(-1) })).status).toBe(200);
    fx.completed2 = id;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the old bypasses are closed', () => {
  const formFor = async (id, over = {}) => {
    const { body } = await request(app).get(`/api/interns/${id}`).set(as('hr'));
    const f = {};
    for (const [k, v] of Object.entries(body)) if (v != null && typeof v !== 'object') f[k] = String(v);
    return { ...f, ...over };
  };
  const put = (id, fields, files = []) => {
    let r = request(app).put(`/api/interns/${id}`).set(as('hr'));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    for (const f of files) r = r.attach(f.field, Buffer.from('%PDF'), { filename: f.name, contentType: 'application/pdf' });
    return r;
  };

  it('PUT cannot complete an internship, even one with an approved evaluation', async () => {
    const id = await intern(OWN);
    await evaluation(id);
    const r = await put(id, await formFor(id, { status: 'Completed', completed_on: iso(-1) }));
    expect([r.status, r.body.code]).toEqual([400, 'COMPLETION_ACTION_REQUIRED']);
    expect((await row(id)).status).toBe('Active');
  });

  it('POST cannot create an internship as Completed', async () => {
    let r = request(app).post('/api/interns').set(as('hr'));
    const fields = { first_name: 'Born', college: 'C', course: 'BE/BTech', department: fx.dept, designation: fx.desig,
      start_date: iso(-30), end_date: iso(-1), status: 'Completed', completed_on: iso(-1) };
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    r = await r;
    expect([r.status, r.body.code]).toEqual([400, 'COMPLETION_ACTION_REQUIRED']);
  });

  it('a Completed internship cannot be moved back, but its other details can still be corrected', async () => {
    let r = await put(fx.completed, await formFor(fx.completed, { status: 'Active' }));
    expect([r.status, r.body.field]).toEqual([400, 'status']);
    r = await put(fx.completed, await formFor(fx.completed, { notes: 'Phone number corrected' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'Completed', notes: 'Phone number corrected' });
  });

  it('PUT cannot set certificate fields', async () => {
    const r = await put(fx.completed, await formFor(fx.completed, { certificate_issued: 'true', certificate_number: 'ZZ-BYPASS' }));
    expect([r.status, r.body.code]).toEqual([400, 'COMPLETION_ACTION_REQUIRED']);
    expect((await row(fx.completed)).certificate_issued).toBe(false);
  });

  it('a certificate file cannot be uploaded through the general update', async () => {
    const r = await put(fx.completed, await formFor(fx.completed), [{ field: 'doc_certificate', name: 'cert.pdf' }]);
    expect([r.status, r.body.code]).toEqual([400, 'CERTIFICATE_ACTION_REQUIRED']);
  });

  it('the database refuses the same bypasses from a script', async () => {
    const id = await intern(OWN);
    await expect(pool.query(`UPDATE interns SET status = 'Completed', completed_on = CURRENT_DATE WHERE id = $1`, [id]))
      .rejects.toThrow(/completion needs the latest evaluation/);
    await expect(pool.query(
      `INSERT INTO interns (company_id, intern_code, first_name, college, course, department, designation, start_date, end_date, status, completed_on)
       VALUES ($1,'INT990','Zz','C','BE/BTech',$2,$3,CURRENT_DATE - 9, CURRENT_DATE - 1,'Completed',CURRENT_DATE - 1)`,
      [OWN, fx.dept, fx.desig])).rejects.toThrow(/cannot be created as Completed/);
    await expect(pool.query(`UPDATE interns SET status = 'Active' WHERE id = $1`, [fx.completed]))
      .rejects.toThrow(/cannot change status/);
    await expect(pool.query(`UPDATE interns SET certificate_issued = true, certificate_number = 'ZZ-SQL' WHERE id = $1`, [fx.completed]))
      .rejects.toThrow(/has no issued certificate/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('certificate issuance and revocation', () => {
  it('only for an internship completed through the gate', async () => {
    const active = await intern(OWN);
    const r = await issue('hr', active, 'ZZ-CERT-000');
    expect([r.status, r.body.code]).toEqual([409, 'NOT_ELIGIBLE_FOR_CERTIFICATE']);
  });

  it('refuses a number that is too long (a blank one is auto-numbered — see the generation suite)', async () => {
    const r = await issue('hr', fx.completed, 'X'.repeat(101));
    expect([r.status, r.body.field]).toEqual([400, 'certificate_number']);
  });

  it('issues with a number and a file stored like any other intern document', async () => {
    const r = await issue('hr', fx.completed, 'ZZ-CERT-001', 'certificate.pdf');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await row(fx.completed)).toMatchObject({ certificate_issued: true, certificate_number: 'ZZ-CERT-001' });
    const cert = r.body.certificates[0];
    expect(cert).toMatchObject({ certificate_number: 'ZZ-CERT-001', revoked_at: null, issued_by_user_id: fx.user.hr });
    const doc = r.body.documents.find(d => d.doc_type === 'Certificate');
    expect(doc.id).toBe(cert.document_id);
    fx.certFile = doc.file_url;
    fx.files.add(doc.file_url);
    const served = await request(app).get(`/api/files/${doc.file_url.split('/').pop()}`).set(as('hr'));
    expect(served.status).toBe(200);
  });

  it('will not issue a second certificate while one is active', async () => {
    const r = await issue('hr', fx.completed, 'ZZ-CERT-002');
    expect([r.status, r.body.code]).toEqual([409, 'CERTIFICATE_ALREADY_ISSUED']);
  });

  it('numbers are unique within a company, in any case or spacing', async () => {
    const r = await issue('hr', fx.completed2, ' zz-cert-001 ');
    expect([r.status, r.body.field]).toEqual([409, 'certificate_number']);
  });

  it('the same number may be used by another company', async () => {
    const id = await intern(FOREIGN);
    await evaluation(id);
    expect((await complete('foreignHr', id, { completed_on: iso(-1) })).status).toBe(200);
    expect((await issue('foreignHr', id, 'ZZ-CERT-001')).status).toBe(201);
  });

  it('a certificate document cannot be removed through the general update', async () => {
    const { body } = await request(app).get(`/api/interns/${fx.completed}`).set(as('hr'));
    const doc = body.documents.find(d => d.doc_type === 'Certificate');
    let r = request(app).put(`/api/interns/${fx.completed}`).set(as('hr'));
    const f = {};
    for (const [k, v] of Object.entries(body)) if (v != null && typeof v !== 'object') f[k] = String(v);
    for (const [k, v] of Object.entries({ ...f, remove_documents: String(doc.id) })) r = r.field(k, v);
    r = await r;
    expect([r.status, r.body.code]).toEqual([400, 'CERTIFICATE_ACTION_REQUIRED']);
  });

  it('revocation needs the approve permission and a reason', async () => {
    expect((await revoke('hrExec', fx.completed, { reason: 'x' })).status).toBe(403);
    expect((await revoke('emp', fx.completed, { reason: 'x' })).status).toBe(403);
    const r = await revoke('hr', fx.completed, { reason: ' ' });
    expect([r.status, r.body.field]).toEqual([400, 'reason']);
  });

  it('revokes: the record keeps who/when/why, the file stops being served, the intern copy clears', async () => {
    const r = await revoke('hr', fx.completed, { reason: 'Issued with the wrong name' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await row(fx.completed)).toMatchObject({ status: 'Completed', certificate_issued: false, certificate_number: null });
    expect(r.body.certificates[0]).toMatchObject({ certificate_number: 'ZZ-CERT-001', revoked_by_user_id: fx.user.hr,
      revoke_reason: 'Issued with the wrong name' });
    expect((await request(app).get(`/api/files/${fx.certFile.split('/').pop()}`).set(as('hr'))).status).toBe(403);
    expect((await revoke('hr', fx.completed, { reason: 'again' })).status).toBe(409);
  });

  it('a replacement gets a new number; a revoked number is never reissued', async () => {
    let r = await issue('hr', fx.completed, 'ZZ-CERT-001');
    expect([r.status, r.body.field]).toEqual([409, 'certificate_number']);
    r = await issue('hr', fx.completed, 'ZZ-CERT-001A');
    expect(r.status).toBe(201);
    expect(r.body.certificates.map(c => [c.certificate_number, c.revoked_at == null])).toEqual([
      ['ZZ-CERT-001A', true], ['ZZ-CERT-001', false],
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('company isolation', () => {
  it('another company cannot see, complete, certify or revoke', async () => {
    expect((await request(app).get(`/api/interns/${fx.completed}`).set(as('foreignHr'))).status).toBe(404);
    expect((await complete('foreignHr', fx.completed2, { completed_on: iso(-1) })).status).toBe(404);
    expect((await issue('foreignHr', fx.completed2, 'ZZ-FOREIGN-9')).status).toBe(404);
    expect((await revoke('foreignHr', fx.completed, { reason: 'hostile' })).status).toBe(404);
    expect((await row(fx.completed)).certificate_number).toBe('ZZ-CERT-001A');
  });

  it('a certificate row cannot be filed under another company', async () => {
    await expect(pool.query(
      `INSERT INTO intern_certificates (company_id, intern_id, certificate_number) VALUES ($1,$2,'ZZ-X')`,
      [FOREIGN, fx.completed2])).rejects.toThrow(/does not match/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('audit events', () => {
  it('records completion, issue, revoke and reissue as explicit, company-scoped events', async () => {
    const { body } = await request(app).get(`/api/interns/${fx.completed}`).set(as('hr'));
    const ev = body.lifecycle_events;
    expect(ev.map(e => e.action)).toEqual(['completed', 'certificate_issued', 'certificate_revoked', 'certificate_issued']);
    expect(ev[0]).toMatchObject({ actor_user_id: fx.user.hr, evaluation_id: fx.completedEval,
      details: { from_status: 'Active', completed_on: iso(-1) } });
    expect(ev[1].details.certificate_number).toBe('ZZ-CERT-001');
    expect(ev[2]).toMatchObject({ reason: 'Issued with the wrong name', details: { certificate_number: 'ZZ-CERT-001' } });
    const { rows } = await pool.query(`SELECT DISTINCT company_id FROM intern_audit_events WHERE intern_id = $1`, [fx.completed]);
    expect(rows).toEqual([{ company_id: OWN }]);
  });

  it('cannot be rewritten', async () => {
    const { rows: [e] } = await pool.query(`SELECT id FROM intern_audit_events WHERE intern_id = $1 LIMIT 1`, [fx.completed]);
    await expect(pool.query(`UPDATE intern_audit_events SET reason = 'edited' WHERE id = $1`, [e.id])).rejects.toThrow(/append-only/);
  });

  it('also writes audit_logs entries', async () => {
    let rows = [];
    for (let i = 0; i < 20 && rows.length < 4; i++) {
      ({ rows } = await pool.query(
        `SELECT action_type FROM audit_logs WHERE module_name = 'internships' AND reference_id = $1::text
            AND action_type IN ('complete', 'issue_certificate', 'revoke_certificate')`, [String(fx.completed)]));
      if (rows.length < 4) await new Promise(r => { setTimeout(r, 100); });
    }
    expect(rows.map(r => r.action_type).sort()).toEqual(['complete', 'issue_certificate', 'issue_certificate', 'revoke_certificate']);
  });
});
