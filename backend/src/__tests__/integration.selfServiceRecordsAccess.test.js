/**
 * Employee Self-Service — who may read / write whose records (§201, §202).
 *
 *  - The employee is resolved on the server (token, else users.employee_id),
 *    never from ?employee_id= or a body field. Own records need self_service.
 *  - A colleague's IT declarations need it_declarations (view / add / approve)
 *    — no longer any payroll- or finance-flavoured role. Never one's own review.
 *  - Documents: own with self_service; a colleague's with employee_documents
 *    (view / add / edit = verify / delete). payroll_admin holds none of it.
 *  - Document files (/files/:name) open for the owner and employee_documents:view.
 *  - Profile update: own record only; address, emergency contact, blood group.
 *    Bank details are HR-only (Edit Employee) — the route refuses them.
 *  - Self-service reimbursements are retired (410): claims live in expense_claims.
 *  - A Super Admin with no linked employee is not treated as an employee.
 *
 * 2026-11-11 (migration 20261111000001, owner decision): employees no longer
 * change their own records. self_service add/edit are off for every role —
 * Finance (it_declarations:add) enters declarations for employees, HR uploads
 * their documents and edits their profile; an employee only reads.
 *
 * Grants come from the role matrix (migration 20261029000001). Real routers
 * and database; two throwaway companies, synthetic employees, declarations,
 * documents and files only — all removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }          = await import('../config/db.js');
const { verifyToken }            = await import('../middlewares/auth.middleware.js');
const { buildApp }               = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: selfServiceRoutes } = await import('../modules/hr/selfservice.routes.js');
const { default: filesRoutes }   = await import('../modules/files/secureFiles.routes.js');
const { LOCAL_UPLOAD_DIR }       = await import('../services/StorageService.js');

const app = buildApp(
  ['/api/self-service', verifyToken, selfServiceRoutes],
  ['/api/files', filesRoutes],
);

const PREFIX = 'ZZSSREC';
const FY = (() => { const d = new Date(); const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${y + 1}`; })();
const FILE_A = `zz_ssrec_${process.pid}_a.pdf`;
const FILE_C = `zz_ssrec_${process.pid}_c.pdf`;
const FILE_PAN = `zz_ssrec_${process.pid}_pan.pdf`;
let co, other, empA, empB, hr, fin, otherHr, unlinked, superNoLink, payrollAdmin, hrExec, manager, salesExec;
const E = {}, D = {}, DOC = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
// Finance enters a declaration for an employee (the only way since 2026-11-11).
const fileFor = (employeeId, body) => call(fin, 'post', '/api/self-service/it-declarations').send({ employee_id: employeeId, ...body });
const SELF_WRITES_OFF = 'Changes to your record are made by HR (documents, profile) or Finance (IT declarations). Please contact them.';

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM notifications WHERE module_name = 'it_declarations' AND user_id IN (SELECT id FROM users WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM it_declarations WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM employee_documents WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM reimbursement_claims WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}
async function addEmployee(company, code) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2025-04-01') RETURNING id`, [company.companyId, code]);
  return r.id;
}
const link = (u, employeeId) => pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [employeeId, u.userId]);
async function addDecl(employeeId, amount = 10000) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO it_declarations (employee_id, financial_year, declaration_type, amount, status)
     VALUES ($1, $2, '80C', $3, 'submitted') RETURNING id`, [employeeId, FY, amount]);
  return r.id;
}
async function addDoc(company, employeeId, file) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employee_documents (employee_id, document_type, document_name, file_url, company_id, status)
     VALUES ($1, 'PAN Card', 'pan.pdf', $2, $3, 'pending') RETURNING id`, [employeeId, file ? `/uploads/${file}` : null, company.companyId]);
  return r.id;
}
const decl = async (id) => (await pool.query(`SELECT * FROM it_declarations WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  E.A = await addEmployee(co, 'EMP001');
  E.B = await addEmployee(co, 'EMP002');
  E.H = await addEmployee(co, 'EMP003');      // the HR user's own employee record
  E.M = await addEmployee(co, 'EMP004');      // a manager
  E.S = await addEmployee(co, 'EMP005');      // a sales exec (no HR menu, no self_service)
  E.C = await addEmployee(other, 'EMP001');
  // Tokens carry employee_id: null — the link lives on the users row only, so a
  // passing test proves the server resolved it rather than trusting the client.
  empA = await addUser(pool, co, { label: 'empa', roleCode: 'employee' }); await link(empA, E.A);
  empB = await addUser(pool, co, { label: 'empb', roleCode: 'employee' }); await link(empB, E.B);
  hr = await addUser(pool, co, { label: 'hr', roleCode: 'hr_manager' }); await link(hr, E.H);
  manager = await addUser(pool, co, { label: 'mgr', roleCode: 'manager' }); await link(manager, E.M);
  salesExec = await addUser(pool, co, { label: 'sales', roleCode: 'sales_exec' }); await link(salesExec, E.S);
  fin = await addUser(pool, co, { label: 'fin', roleCode: 'finance_manager' });
  otherHr = await addUser(pool, other, { label: 'hr', roleCode: 'hr_manager' });
  unlinked = await addUser(pool, co, { label: 'nolink', roleCode: 'employee' });
  superNoLink = await addUser(pool, co, { label: 'sa', roleCode: 'super_admin' });
  payrollAdmin = await addUser(pool, co, { label: 'pay', roleCode: 'payroll_admin' });
  hrExec = await addUser(pool, co, { label: 'hrx', roleCode: 'hr_exec' });
  D.A = await addDecl(E.A); D.B = await addDecl(E.B); D.H = await addDecl(E.H); D.C = await addDecl(E.C);
  writeFileSync(join(LOCAL_UPLOAD_DIR, FILE_A), 'zz');
  writeFileSync(join(LOCAL_UPLOAD_DIR, FILE_C), 'zz');
  writeFileSync(join(LOCAL_UPLOAD_DIR, FILE_PAN), 'zz');
  // an identity upload on the employee ROW (Add Employee's PAN file field)
  await pool.query(`UPDATE employees SET pan_file = $1 WHERE id = $2`, [`/uploads/${FILE_PAN}`, E.B]);
  DOC.A = await addDoc(co, E.A, FILE_A); DOC.B = await addDoc(co, E.B, null); DOC.C = await addDoc(other, E.C, FILE_C);
}, 60000);

afterAll(async () => {
  for (const f of [FILE_A, FILE_C, FILE_PAN]) rmSync(join(LOCAL_UPLOAD_DIR, f), { force: true });
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('IT declarations', () => {
  it('an employee reads their own declarations and summary (no id, or their own id)', async () => {
    const r = await call(empA, 'get', `/api/self-service/it-declarations?financial_year=${FY}`);
    expect(r.status).toBe(200);
    expect(r.body.map(d => d.id)).toEqual([D.A]);
    expect((await call(empA, 'get', `/api/self-service/it-declarations?employee_id=${E.A}&financial_year=${FY}`)).body.map(d => d.id)).toEqual([D.A]);
    const s = await call(empA, 'get', '/api/self-service/it-declarations/summary');
    expect(s.status).toBe(200);
  });

  it('an employee cannot read another employee (same company or another company)', async () => {
    for (const id of [E.B, E.C]) {
      const r = await call(empA, 'get', `/api/self-service/it-declarations?employee_id=${id}&financial_year=${FY}`);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ message: 'You may only view your own records' });
      expect((await call(empA, 'get', `/api/self-service/it-declarations/summary?employee_id=${id}`)).status).toBe(403);
    }
  });

  it('a role reads nothing it holds no it_declarations grant for; finance_manager enters them, so reads them', async () => {
    // manager used to read any colleague through PAYROLL_READ_ROLES
    for (const who of [manager, hrExec]) {
      const r = await call(who, 'get', `/api/self-service/it-declarations?employee_id=${E.B}&financial_year=${FY}`);
      expect(r.status).toBe(403);
    }
    expect((await call(fin, 'get', `/api/self-service/it-declarations?employee_id=${E.B}&financial_year=${FY}`)).status).toBe(200);
  });

  it('a role without self_service cannot use the portal for its own record either', async () => {
    const r = await call(salesExec, 'get', `/api/self-service/it-declarations?financial_year=${FY}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ message: 'Self-service is not available for your role' });
    expect((await call(salesExec, 'post', '/api/self-service/it-declarations').send({ declaration_type: '80C', amount: 1 })).status).toBe(403);
    expect((await call(salesExec, 'get', '/api/self-service/dashboard')).status).toBe(403);
  });

  it('an employee files no declaration, own or anyone else; Finance files it, always "submitted"', async () => {
    const own = await call(empA, 'post', '/api/self-service/it-declarations').send({ declaration_type: '80D', amount: 5000, description: 'own', financial_year: FY });
    expect(own.status).toBe(403);
    expect(own.body).toEqual({ message: SELF_WRITES_OFF });
    const bad = await call(empA, 'post', '/api/self-service/it-declarations').send({ employee_id: E.B, declaration_type: '80D', amount: 5000 });
    expect(bad.status).toBe(403);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM it_declarations WHERE employee_id = ANY($1)`, [[E.A, E.B]])).rows[0].n).toBe(2);
    const ok = await fileFor(E.A, { declaration_type: '80D', amount: 5000, status: 'approved', financial_year: FY });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ employee_id: E.A, status: 'submitted' });
    // hr_manager reviews but no longer enters
    expect((await call(hr, 'post', '/api/self-service/it-declarations').send({ employee_id: E.B, declaration_type: '80C', amount: 1, description: 'x', financial_year: FY })).status).toBe(403);
  });

  it('accepts the types payroll reads, own NPS and home-loan interest included, and refuses any other (§262)', async () => {
    const post = (declaration_type, amount) => fileFor(E.A, { declaration_type, amount, description: `${declaration_type} fixture`, financial_year: FY });
    expect((await post('80CCD(1B)', 5000)).status).toBe(400);
    expect((await post('Section 24', 5000)).status).toBe(400);
    expect((await post('80CCD', 50000)).status).toBe(201);
    expect((await post('HOME_LOAN', 180000)).status).toBe(201);
  });

  it('an employee cannot modify another employee\'s declaration, in or out of the company', async () => {
    for (const id of [D.B, D.C]) {
      const r = await call(empA, 'put', `/api/self-service/it-declarations/${id}`).send({ amount: 1 });
      expect(r.status).toBe(404);
    }
    expect(Number((await decl(D.B)).amount)).toBe(10000);
    expect(Number((await decl(D.C)).amount)).toBe(10000);
  });

  it('the employee neither edits nor reviews their own declaration; Finance corrects it while it waits', async () => {
    expect((await call(empA, 'put', `/api/self-service/it-declarations/${D.A}`).send({ amount: 11000 })).status).toBe(404);
    const r = await call(fin, 'put', `/api/self-service/it-declarations/${D.A}`).send({ amount: 12000 });
    expect(r.status).toBe(200);
    expect(Number(r.body.amount)).toBe(12000);
    const self = await call(empA, 'put', `/api/self-service/it-declarations/${D.A}`).send({ status: 'approved', reviewed_by: 1 });
    expect(self.status).toBe(404);
    expect((await decl(D.A))).toMatchObject({ status: 'submitted', reviewed_by: null });
  });

  it('it_declarations:approve reviews a colleague\'s declaration; reviewed_by is the reviewer, not the body', async () => {
    const r = await call(hr, 'put', `/api/self-service/it-declarations/${D.A}`).send({ status: 'approved', reviewed_by: 424242 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'approved', reviewed_by: hr.userId });
    // once reviewed, Finance can no longer change it
    expect((await call(fin, 'put', `/api/self-service/it-declarations/${D.A}`).send({ amount: 1 })).status).toBe(409);
    expect((await call(hr, 'put', `/api/self-service/it-declarations/${D.B}`).send({ status: 'bogus' })).status).toBe(400);
    // finance_manager enters declarations but holds no review grant
    expect((await call(fin, 'put', `/api/self-service/it-declarations/${D.B}`).send({ status: 'rejected', remarks: 'x' })).status).toBe(403);
  });

  it('no reviewer reviews their own declaration', async () => {
    const r = await call(hr, 'put', `/api/self-service/it-declarations/${D.H}`).send({ status: 'approved' });
    expect(r.status).toBe(403);
    expect((await decl(D.H)).status).toBe('submitted');
  });

  it('grant holders read colleagues in their own company only', async () => {
    for (const who of [hr, payrollAdmin]) {
      const f = await call(who, 'get', `/api/self-service/it-declarations?employee_id=${E.B}&financial_year=${FY}`);
      expect(f.status).toBe(200);
      expect(f.body.map(d => d.id)).toEqual([D.B]);
    }
    const x = await call(hr, 'get', `/api/self-service/it-declarations?employee_id=${E.C}&financial_year=${FY}`);
    expect(x.status).toBe(404);
    expect(x.body).toEqual({ message: 'Employee not found' });
    expect((await call(hr, 'put', `/api/self-service/it-declarations/${D.C}`).send({ status: 'approved' })).status).toBe(404);
    expect((await call(otherHr, 'put', `/api/self-service/it-declarations/${D.B}`).send({ status: 'rejected' })).status).toBe(404);
    expect((await decl(D.C)).status).toBe('submitted');
    expect((await decl(D.B)).status).toBe('submitted');
  });

  it('missing employee mapping and malformed ids fail safely', async () => {
    expect((await call(unlinked, 'get', '/api/self-service/it-declarations')).status).toBe(403);
    expect((await call(unlinked, 'post', '/api/self-service/it-declarations').send({ declaration_type: '80C', amount: 1 })).status).toBe(403);
    expect((await call(empA, 'get', '/api/self-service/it-declarations?employee_id=1;DROP')).status).toBe(400);
    const bad = await call(empA, 'put', '/api/self-service/it-declarations/1%20OR%201=1').send({ amount: 1 });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/syntax|integer|pg|SELECT/i);
  });
});

describe('Documents', () => {
  it('an employee sees only their own documents, whatever employee_id they send', async () => {
    for (const q of ['', `?employee_id=${E.B}`, '?employee_id=all', `?employee_id=${E.C}`]) {
      const r = await call(empA, 'get', `/api/self-service/documents${q}`);
      expect(r.status).toBe(200);
      expect(r.body.map(d => d.id)).toEqual([DOC.A]);
    }
  });

  it('an employee uploads nothing; HR files the document against the employee', async () => {
    for (const body of [{ document_type: 'Aadhaar', document_name: 'a.pdf' }, { employee_id: E.B, document_type: 'Aadhaar', document_name: 'a.pdf' }]) {
      expect((await call(empA, 'post', '/api/self-service/documents').send(body)).status).toBe(403);
    }
    const r = await call(hr, 'post', '/api/self-service/documents').send({ employee_id: E.A, document_type: 'Aadhaar', document_name: 'a.pdf' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ employee_id: E.A, company_id: co.companyId });
  });

  it('an employee cannot verify or delete another employee\'s document', async () => {
    expect((await call(empA, 'patch', `/api/self-service/documents/${DOC.B}`).send({ status: 'verified' })).status).toBe(403);
    // since 2026-11-11 an employee deletes no document at all, their own included
    for (const id of [DOC.A, DOC.B, DOC.C]) {
      expect((await call(empA, 'delete', `/api/self-service/documents/${id}`)).status).toBe(403);
    }
    const { rows } = await pool.query(`SELECT id FROM employee_documents WHERE id = ANY($1)`, [[DOC.A, DOC.B, DOC.C]]);
    expect(rows).toHaveLength(3);
  });

  it('HR works within the company only; the reviewer is recorded as an employee', async () => {
    const b = await call(hr, 'get', `/api/self-service/documents?employee_id=${E.B}`);
    expect(b.status).toBe(200);
    expect(b.body.map(d => d.id)).toEqual([DOC.B]);
    const all = await call(hr, 'get', '/api/self-service/documents?employee_id=all');
    expect(all.body.some(d => d.id === DOC.C)).toBe(false);
    const x = await call(hr, 'get', `/api/self-service/documents?employee_id=${E.C}`);
    expect(x.status).toBe(404);
    expect(x.body).toEqual({ message: 'Employee not found' });
    expect((await call(hr, 'post', '/api/self-service/documents').send({ employee_id: E.C, document_type: 'PAN Card', document_name: 'x' })).status).toBe(404);
    expect((await call(hr, 'patch', `/api/self-service/documents/${DOC.C}`).send({ status: 'verified' })).status).toBe(404);
    const v = await call(hr, 'patch', `/api/self-service/documents/${DOC.B}`).send({ status: 'verified' });
    expect(v.status).toBe(200);
    // verified_by joins employees: it is the reviewer's employee id, not users.id
    expect(v.body.verified_by).toBe(E.H);
  });

  it('nobody verifies their own document', async () => {
    const { rows: [own] } = await pool.query(
      `INSERT INTO employee_documents (employee_id, document_type, document_name, company_id, status)
       VALUES ($1, 'PAN Card', 'mine.pdf', $2, 'pending') RETURNING id`, [E.H, co.companyId]);
    expect((await call(hr, 'patch', `/api/self-service/documents/${own.id}`).send({ status: 'verified' })).status).toBe(403);
    expect((await pool.query(`SELECT status FROM employee_documents WHERE id = $1`, [own.id])).rows[0].status).toBe('pending');
  });

  it('identity documents follow employee_documents only: payroll_admin and finance see none; hr_exec verifies but cannot delete', async () => {
    for (const who of [payrollAdmin, fin]) {
      expect((await call(who, 'get', `/api/self-service/documents?employee_id=${E.A}`)).body).toEqual([]);
      expect((await call(who, 'patch', `/api/self-service/documents/${DOC.A}`).send({ status: 'rejected' })).status).toBe(403);
    }
    expect((await call(hrExec, 'get', `/api/self-service/documents?employee_id=${E.A}`)).body.map(d => d.id)).toContain(DOC.A);
    expect((await call(hrExec, 'patch', `/api/self-service/documents/${DOC.A}`).send({ status: 'pending' })).status).toBe(200);
    // hr_exec has no delete grant, and no employee link, so the delete is refused
    expect((await call(hrExec, 'delete', `/api/self-service/documents/${DOC.A}`)).status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM employee_documents WHERE id = $1`, [DOC.A])).rows).toHaveLength(1);
  });

  it('missing employee mapping and malformed ids fail safely', async () => {
    expect((await call(unlinked, 'get', '/api/self-service/documents')).body).toEqual([]);
    expect((await call(unlinked, 'post', '/api/self-service/documents').send({ document_type: 'PAN Card', document_name: 'x' })).status).toBe(403);
    for (const [m, p] of [['get', '/api/self-service/documents?employee_id=abc'], ['patch', '/api/self-service/documents/abc'], ['delete', '/api/self-service/documents/abc']]) {
      const r = await call(hr, m, p).send({ status: 'verified' });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toMatch(/syntax|integer|pg/i);
    }
    expect((await call(hr, 'post', '/api/self-service/documents').send({ employee_id: 'x1', document_type: 'PAN Card', document_name: 'x' })).status).toBe(400);
  });

  it('a vault file opens for its owner and employee_documents:view in the company — nobody else (GET and HEAD agree)', async () => {
    expect((await call(empA, 'get', `/api/files/${FILE_A}`)).status).toBe(200);
    expect((await call(hr, 'get', `/api/files/${FILE_A}`)).status).toBe(200);
    expect((await call(hrExec, 'get', `/api/files/${FILE_A}`)).status).toBe(200);
    expect((await call(superNoLink, 'get', `/api/files/${FILE_A}`)).status).toBe(200);
    for (const who of [empB, otherHr, unlinked, payrollAdmin, fin]) {
      expect((await call(who, 'get', `/api/files/${FILE_A}`)).status).toBe(403);
      expect((await call(who, 'head', `/api/files/${FILE_A}`)).status).toBe(403);
    }
    expect((await call(hr, 'get', `/api/files/${FILE_C}`)).status).toBe(403);
    expect((await call(empA, 'head', `/api/files/${FILE_A}`)).status).toBe(200);
    // the View button's inline open asks the same question
    expect((await call(hr, 'get', `/api/files/${FILE_A}?disposition=inline`)).status).toBe(200);
    expect((await call(otherHr, 'get', `/api/files/${FILE_A}?disposition=inline`)).status).toBe(403);
    // an encoded path cannot climb out of the uploads folder
    for (const p of ['..%2F..%2F.env', '..%5C..%5C.env', '%2E%2E']) {
      expect([400, 404]).toContain((await call(hr, 'get', `/api/files/${p}`)).status);
    }
  });

  it('an identity upload on the employee row (PAN file) follows the same grant', async () => {
    expect((await call(empB, 'get', `/api/files/${FILE_PAN}`)).status).toBe(200);
    expect((await call(hr, 'get', `/api/files/${FILE_PAN}`)).status).toBe(200);
    for (const who of [payrollAdmin, fin, empA]) {
      expect((await call(who, 'get', `/api/files/${FILE_PAN}`)).status).toBe(403);
      expect((await call(who, 'head', `/api/files/${FILE_PAN}`)).status).toBe(403);
    }
  });
});

describe('Self-service reimbursements are retired', () => {
  it('all three endpoints answer 410 and point to the one claim workflow; nothing is written', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM reimbursement_claims`)).rows[0].n;
    for (const [m, p] of [['get', '/api/self-service/reimbursements'], ['post', '/api/self-service/reimbursements'], ['put', '/api/self-service/reimbursements/1/approve']]) {
      const r = await call(empA, m, p).send({ claim_type: 'Medical', amount: 10 });
      expect(r.status).toBe(410);
      expect(r.body).toMatchObject({ code: 'CLAIMS_MOVED', endpoint: '/reimbursement/claims' });
    }
    expect((await pool.query(`SELECT COUNT(*)::int n FROM reimbursement_claims`)).rows[0].n).toBe(before);
  });
});

describe('Profile update', () => {
  const FIX = { current_address: '1 Fixture Street', emergency_name: 'Fixture Kin', blood_group: 'O+',
    account_number: '123456789012', ifsc_code: 'HDFC0001234', bank_name: 'Fixture Bank',
    designation: 'Engineer', department: 'QA', basic_salary: '30000.00', status: 'Active' };
  const emp = async (id) => (await pool.query(
    `SELECT current_address, emergency_name, blood_group, account_number, ifsc_code, bank_name,
            designation, department, basic_salary::text AS basic_salary, status FROM employees WHERE id = $1`, [id])).rows[0];
  beforeAll(async () => {
    for (const id of [E.A, E.B]) {
      await pool.query(
        `UPDATE employees SET current_address=$2, emergency_name=$3, blood_group=$4, account_number=$5, ifsc_code=$6,
                bank_name=$7, designation=$8, department=$9, basic_salary=$10, status=$11 WHERE id=$1`,
        [id, FIX.current_address, FIX.emergency_name, FIX.blood_group, FIX.account_number, FIX.ifsc_code,
         FIX.bank_name, FIX.designation, FIX.department, FIX.basic_salary, FIX.status]);
    }
  });

  it('an employee no longer edits their own profile here (HR does, in Edit Employee); nothing is saved', async () => {
    for (const body of [{ blood_group: 'B+' }, { address: '2 New Road' }, { bank_account: '999988887777' },
      { designation: 'CEO', basic_salary: 999999, emergency_contact: 'New Kin' }]) {
      const r = await call(empA, 'put', `/api/self-service/employees/${E.A}/profile`).send(body);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain(FIX.account_number);
    }
    expect(await emp(E.A)).toEqual(FIX);
  });

  it('nobody updates another employee\'s profile here — HR included', async () => {
    for (const who of [empB, hr, payrollAdmin, superNoLink, unlinked]) {
      const r = await call(who, 'put', `/api/self-service/employees/${E.A}/profile`).send({ blood_group: 'AB-' });
      expect(r.status).toBe(403);
    }
    expect((await emp(E.A)).blood_group).toBe(FIX.blood_group);
    expect((await call(empA, 'put', `/api/self-service/employees/${E.C}/profile`).send({ blood_group: 'A+' })).status).toBe(403);
    expect((await call(salesExec, 'put', `/api/self-service/employees/${E.S}/profile`).send({ blood_group: 'A+' })).status).toBe(403);
  });

  it('a malformed id is refused cleanly', async () => {
    expect((await call(empA, 'put', '/api/self-service/employees/abc/profile').send({})).status).toBe(400);
  });
});

describe('Super Admin with no linked employee', () => {
  it('is never resolved to an employee: own dashboard and declarations refuse', async () => {
    for (const p of ['/api/self-service/dashboard', '/api/self-service/it-declarations']) {
      const r = await call(superNoLink, 'get', p);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ message: 'No employee record is linked to this account' });
    }
    expect((await call(superNoLink, 'post', '/api/self-service/it-declarations').send({ declaration_type: '80C', amount: 1 })).status).toBe(403);
  });

  it('keeps its administrative reach through explicit grants, inside its company', async () => {
    const docs = await call(superNoLink, 'get', `/api/self-service/documents?employee_id=${E.B}`);
    expect(docs.status).toBe(200);
    expect(docs.body.map(d => d.id)).toEqual([DOC.B]);
    expect((await call(superNoLink, 'get', `/api/self-service/it-declarations?employee_id=${E.B}&financial_year=${FY}`)).status).toBe(200);
    expect((await call(superNoLink, 'get', `/api/self-service/documents?employee_id=${E.C}`)).status).toBe(404);
  });

  it('the self-service dashboard is one\'s own only — no grant opens a colleague\'s', async () => {
    expect((await call(superNoLink, 'get', `/api/self-service/dashboard?employee_id=${E.B}`)).status).toBe(403);
    expect((await call(hr, 'get', `/api/self-service/dashboard?employee_id=${E.B}`)).status).toBe(403);
    const own = await call(empA, 'get', '/api/self-service/dashboard');
    expect(own.status).toBe(200);
    expect(own.body).toHaveProperty('pending_reimbursements');
  });
});

describe('IT declaration review queue (§203)', () => {
  const settle = () => new Promise(r => { setTimeout(r, 300); });   // logAudit writes after the response
  const count = async () => (await pool.query(`SELECT COUNT(*)::int n FROM it_declarations WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`, [co.companyId])).rows[0].n;

  it('opens only with it_declarations:view, and lists the caller\'s company only', async () => {
    for (const who of [empA, manager, hrExec, salesExec]) {
      expect((await call(who, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}`)).status).toBe(403);
    }
    // finance_manager enters declarations (2026-11-11), so it opens the list too
    expect((await call(fin, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}`)).status).toBe(200);
    const r = await call(payrollAdmin, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}&status=all`);
    expect(r.status).toBe(200);
    const ids = r.body.map(d => d.id);
    expect(ids).toEqual(expect.arrayContaining([D.A, D.B, D.H]));
    expect(ids).not.toContain(D.C);
    expect(r.body.find(d => d.id === D.B)).toMatchObject({ employee_code: 'EMP002', can_review: true });
    expect((await call(otherHr, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}&status=all`)).body.map(d => d.id)).not.toContain(D.B);
    expect((await call(payrollAdmin, 'get', '/api/self-service/it-declarations/review?financial_year=2026')).status).toBe(400);
  });

  it('a reviewer\'s own declaration is listed but not reviewable', async () => {
    const r = await call(hr, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}&status=all`);
    expect(r.body.find(d => d.id === D.H).can_review).toBe(false);
    expect(r.body.find(d => d.id === D.B).can_review).toBe(true);
  });

  it('a rejection needs a reason; the decision is recorded in the history; no row is added', async () => {
    const before = await count();
    expect((await call(payrollAdmin, 'put', `/api/self-service/it-declarations/${D.B}`).send({ status: 'rejected' })).status).toBe(400);
    const r = await call(payrollAdmin, 'put', `/api/self-service/it-declarations/${D.B}`).send({ status: 'rejected', remarks: 'Proof missing' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', reviewed_by: payrollAdmin.userId });
    expect((await call(payrollAdmin, 'put', `/api/self-service/it-declarations/${D.B}`).send({ status: 'rejected', remarks: 'again' })).status).toBe(409);
    expect((await call(payrollAdmin, 'put', `/api/self-service/it-declarations/${D.B}`).send({ status: 'submitted' })).status).toBe(200);
    expect(await count()).toBe(before);
    await settle();
    const h = await call(empB, 'get', `/api/self-service/it-declarations/${D.B}/history`);
    expect(h.status).toBe(200);
    expect(h.body.events.map(e => [e.action, e.from_status, e.to_status])).toEqual([
      ['reject', 'submitted', 'rejected'], ['reopen', 'rejected', 'submitted'],
    ]);
    expect(h.body.events[0].remarks).toBe('Proof missing');
    const q = await call(payrollAdmin, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}&status=submitted`);
    expect(q.body.map(d => d.id)).toContain(D.B);
  });

  it('history is for the owner and company reviewers only', async () => {
    expect((await call(empA, 'get', `/api/self-service/it-declarations/${D.B}/history`)).status).toBe(404);
    expect((await call(otherHr, 'get', `/api/self-service/it-declarations/${D.B}/history`)).status).toBe(404);
    // finance_manager enters declarations (it_declarations:view), so it reads the history too
    expect((await call(fin, 'get', `/api/self-service/it-declarations/${D.B}/history`)).status).toBe(200);
    expect((await call(hr, 'get', `/api/self-service/it-declarations/${D.B}/history`)).status).toBe(200);
  });

  it('the same declaration cannot be filed twice', async () => {
    const body = { declaration_type: 'HRA', amount: 24000, description: 'Rent Apr-Mar', landlord_name: 'R Owner', financial_year: FY };
    expect((await fileFor(E.B, body)).status).toBe(201);
    const dup = await fileFor(E.B, { ...body, description: ' rent apr-mar ' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_DECLARATION');
    expect((await fileFor(E.B, { ...body, amount: 12000 })).status).toBe(201);
  });
});

describe('IT declaration review integrity (§263)', () => {
  const settle = () => new Promise(r => { setTimeout(r, 300); });   // logAudit writes after the response
  const nextFY = `${Number(FY.slice(0, 4)) + 1}-${Number(FY.slice(0, 4)) + 2}`;
  const lastFY = `${Number(FY.slice(0, 4)) - 1}-${FY.slice(0, 4)}`;
  const file = (employeeId, body) => fileFor(employeeId, body);   // Finance files for the employee
  const put = (who, id, body) => call(who, 'put', `/api/self-service/it-declarations/${id}`).send(body);
  const notes = async (u) => (await pool.query(
    `SELECT title, message FROM notifications WHERE user_id = $1 AND module_name = 'it_declarations' ORDER BY id`, [u.userId])).rows;

  it('files for the current or the next financial year only, and checks every field', async () => {
    const base = { declaration_type: '80D', amount: 5000, description: 'Mediclaim §263' };
    for (const financial_year of [lastFY, 'SEED finan', '2026-2028', 'abc']) {
      expect((await file(E.A, { ...base, financial_year })).status).toBe(400);
    }
    expect((await file(E.A, { ...base, financial_year: nextFY })).status).toBe(201);
    for (const bad of [
      { amount: 1e12 }, { amount: 'x' }, { description: 'x'.repeat(501) },
      { proof_url: 'javascript:alert(1)' }, { metro_city: true },        // metro is for HRA only
    ]) expect((await file(E.A, { ...base, financial_year: FY, ...bad })).status).toBe(400);
    const ok = await file(E.A, { declaration_type: 'HRA', amount: 120000, description: 'Rent §263', metro_city: true, landlord_name: 'R Owner', landlord_pan: 'ABCDE1234F', proof_url: 'https://example.com/r.pdf', financial_year: FY });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ metro_city: true, status: 'submitted' });
    expect(Number(ok.body.claimed_amount)).toBe(120000);
  });

  it('a reviewer approves less than declared only with a reason, never more; the employee is told', async () => {
    const { body: d } = await file(E.B, { declaration_type: '80C', amount: 50000, description: 'ELSS §263', financial_year: FY });
    expect((await put(payrollAdmin, d.id, { status: 'approved', amount: 60000 })).status).toBe(400);
    expect((await put(payrollAdmin, d.id, { status: 'approved', amount: 30000 })).status).toBe(400);
    expect((await put(payrollAdmin, d.id, { status: 'rejected', amount: 30000, remarks: 'x' })).status).toBe(400);
    const r = await put(payrollAdmin, d.id, { status: 'approved', amount: 30000, remarks: 'Only ₹30,000 proved' });
    expect(r.status).toBe(200);
    expect(Number(r.body.amount)).toBe(30000);
    expect(Number(r.body.claimed_amount)).toBe(50000);
    const n = await notes(empB);
    expect(n.at(-1).title).toBe('IT declaration approved');
    expect(n.at(-1).message).toContain('Only ₹30,000 proved');
    // the queue shows what was declared next to what was approved
    const q = await call(payrollAdmin, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}&status=approved`);
    expect(q.body.find(x => x.id === d.id)).toMatchObject({ regime: 'new', regime_source: 'company', counts_for_tax: false, section_limit: 150000 });
    // reopening restores the claim and is recorded with the amount change
    const re = await put(payrollAdmin, d.id, { status: 'submitted' });
    expect(Number(re.body.amount)).toBe(50000);
    await settle();
    const h = await call(empB, 'get', `/api/self-service/it-declarations/${d.id}/history`);
    expect(h.body.events.map(e => [e.action, Number(e.from_amount), Number(e.to_amount)])).toEqual([
      ['approve', 50000, 30000], ['reopen', 30000, 50000],
    ]);
  });

  it('a reviewer never edits a declaration without a decision — an approved one least of all', async () => {
    const { body: d } = await file(E.B, { declaration_type: '80D', amount: 20000, description: 'Parents §263', financial_year: FY });
    expect((await put(payrollAdmin, d.id, { amount: 1000 })).status).toBe(403);
    expect((await put(payrollAdmin, d.id, { status: 'approved', description: 'changed' })).status).toBe(400);
    expect((await put(payrollAdmin, d.id, { status: 'approved' })).status).toBe(200);
    expect((await put(payrollAdmin, d.id, { amount: 1000 })).status).toBe(403);
    expect((await put(fin, d.id, { amount: 1000 })).status).toBe(409);        // Finance: no longer submitted
    expect(Number((await decl(d.id)).amount)).toBe(20000);
  });

  it('Finance\'s edit changes the claim; clearing a proof link is possible; bad input is refused', async () => {
    const { body: d } = await file(E.A, { declaration_type: 'LTA', amount: 15000, description: 'Trip §263', proof_url: 'https://example.com/t.pdf', financial_year: FY });
    const r = await put(fin, d.id, { amount: 12000, proof_url: '' });
    expect(r.status).toBe(200);
    expect(Number(r.body.amount)).toBe(12000);
    expect(Number(r.body.claimed_amount)).toBe(12000);
    expect(r.body.proof_url).toBeNull();
    expect(r.body.description).toBe('Trip §263');
    expect((await put(fin, d.id, { proof_url: 'ftp://x' })).status).toBe(400);
    expect((await put(fin, d.id, { metro_city: true })).status).toBe(400);
  });

  it('the database refuses a status, section or year nothing reads', async () => {
    for (const [col, val] of [['status', 'active'], ['declaration_type', 'Standard'], ['financial_year', 'SEED finan']]) {
      await expect(pool.query(`UPDATE it_declarations SET ${col} = $1 WHERE id = $2`, [val, D.A])).rejects.toThrow(/check constraint/);
    }
  });
});

describe('IT declarations: HRA landlord, 80D self / parents, proof files, policy, Approval Center (§264)', () => {
  const file = (employeeId, body) => fileFor(employeeId, { financial_year: FY, ...body });
  const uploaded = [];
  afterAll(() => { for (const p of uploaded) rmSync(join(LOCAL_UPLOAD_DIR, p.split('/').pop()), { force: true }); });

  it('HRA needs the landlord; their PAN above ₹1,00,000 a year; landlord details are HRA-only', async () => {
    expect((await file(E.A, { declaration_type: 'HRA', amount: 60000, description: 'Rent no landlord §264' })).status).toBe(400);
    expect((await file(E.A, { declaration_type: 'HRA', amount: 150000, description: 'Rent no PAN §264', landlord_name: 'Owner' })).status).toBe(400);
    expect((await file(E.A, { declaration_type: 'HRA', amount: 150000, description: 'Rent bad PAN §264', landlord_name: 'Owner', landlord_pan: '12345' })).status).toBe(400);
    expect((await file(E.A, { declaration_type: '80C', amount: 1000, description: 'PPF §264', landlord_name: 'Owner' })).status).toBe(400);
    const ok = await file(E.A, { declaration_type: 'HRA', amount: 150000, description: 'Rent ok §264', landlord_name: 'Owner', landlord_pan: 'abcde1234f' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ landlord_name: 'Owner', landlord_pan: 'ABCDE1234F' });
    // nor can it later drop the PAN below the rule
    expect((await call(fin, 'put', `/api/self-service/it-declarations/${ok.body.id}`).send({ landlord_pan: '' })).status).toBe(400);
  });

  it('80D is for self (default) or parents; "60 or over" applies to parents only', async () => {
    const self = await file(E.A, { declaration_type: '80D', amount: 20000, description: 'Own policy §264' });
    expect(self.status).toBe(201);
    expect(self.body.insured_for).toBe('self');
    const parents = await file(E.A, { declaration_type: '80D', amount: 45000, description: 'Parents policy §264', insured_for: 'parents', parents_senior: true });
    expect(parents.body).toMatchObject({ insured_for: 'parents', parents_senior: true });
    expect((await file(E.A, { declaration_type: '80D', amount: 1000, description: 'x §264', parents_senior: true })).status).toBe(400);
    expect((await file(E.A, { declaration_type: '80C', amount: 1000, description: 'y §264', insured_for: 'self' })).status).toBe(400);
    const q = await call(payrollAdmin, 'get', `/api/self-service/it-declarations/review?financial_year=${FY}&status=all`);
    expect(q.body.find(r => r.id === parents.body.id)).toMatchObject({ section_limit: 50000 });
    expect(q.body.find(r => r.id === self.body.id)).toMatchObject({ section_limit: 25000 });
  });

  it('Finance attaches the proof while the declaration waits; it opens for the employee and reviewers', async () => {
    const { body: d } = await file(E.B, { declaration_type: '80C', amount: 7000, description: 'Proof file §264' });
    const pdf = Buffer.from('%PDF-1.4 zz');
    // the owner may no longer attach (self_service:edit is off); Finance does
    expect((await call(empB, 'post', `/api/self-service/it-declarations/${d.id}/proof`).attach('file', pdf, { filename: 'p.pdf', contentType: 'application/pdf' })).status).toBe(404);
    expect((await call(fin, 'post', `/api/self-service/it-declarations/${d.id}/proof`).attach('file', Buffer.from('x'), { filename: 'a.exe', contentType: 'application/octet-stream' })).status).toBe(400);
    expect((await call(empA, 'post', `/api/self-service/it-declarations/${d.id}/proof`).attach('file', pdf, { filename: 'p.pdf', contentType: 'application/pdf' })).status).toBe(404);
    const up = await call(fin, 'post', `/api/self-service/it-declarations/${d.id}/proof`).attach('file', pdf, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(200);
    expect(up.body.proof_file).toMatch(/^\/uploads\/.*itdecl_\d+\.pdf$/);
    uploaded.push(up.body.proof_file);
    const name = up.body.proof_file.split('/').pop();
    expect((await call(empB, 'get', `/api/files/${name}`)).status).toBe(200);
    expect((await call(payrollAdmin, 'get', `/api/files/${name}`)).status).toBe(200);
    expect((await call(fin, 'get', `/api/files/${name}`)).status).toBe(200);    // Finance attached it
    for (const who of [empA, otherHr]) expect((await call(who, 'get', `/api/files/${name}`)).status).toBe(403);
    expect((await call(empA, 'head', `/api/files/${name}`)).status).toBe(403);
    await call(payrollAdmin, 'put', `/api/self-service/it-declarations/${d.id}`).send({ status: 'approved' });
    expect((await call(fin, 'post', `/api/self-service/it-declarations/${d.id}/proof`).attach('file', pdf, { filename: 'p.pdf', contentType: 'application/pdf' })).status).toBe(409);
  });

  it('the policy says which declarations count this month', async () => {
    const r = await call(empA, 'get', '/api/self-service/it-declarations/policy');
    expect(r.status).toBe(200);
    expect(r.body.cutoff_month).toBe(1);                      // no saved setting: January
    expect(r.body.counts_now).toEqual(expect.arrayContaining(['approved']));
  });

  it('waiting declarations appear in the Approval Center for reviewers, never their own, as "open"', async () => {
    const { SOURCE_BY_TYPE } = await import('../modules/approvals/approvals.sources.js');
    const src = SOURCE_BY_TYPE.itdecl;
    const { body: a } = await file(E.A, { declaration_type: 'LTA', amount: 9000, description: 'Approval Center §264' });
    const { body: h } = await file(E.H, { declaration_type: 'LTA', amount: 9000, description: 'Approval Center own §264' });
    const rows = await src.pending(co.companyId);
    const mineRow = rows.find(r => r.source_id === String(h.id));
    const other = rows.find(r => r.source_id === String(a.id));
    expect(mineRow).toBeTruthy();
    expect(other).toBeTruthy();
    const reviewer = { perms: { it_declarations: { can_approve: true } }, linkedEmployeeId: E.H };
    expect(src.canAct(reviewer, other)).toBe(true);
    expect(src.canAct(reviewer, mineRow)).toBe(false);
    expect(src.canAct({ perms: {}, linkedEmployeeId: null }, other)).toBe(false);
    expect(src.actions(other)).toEqual({ open: { page: 'PayrollCenter', params: { tab: 'statutory', view: 'declarations' } } });
    expect(rows.every(r => r.company_id === co.companyId)).toBe(true);       // the caller's company only
  });
});
