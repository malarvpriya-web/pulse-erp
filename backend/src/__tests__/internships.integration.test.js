/**
 * Internships — behaviour against the real database, through the real router.
 *
 * Covers: INTxxx generation (sequential, per company, concurrent, never EMP),
 * Add / Edit / View, the register's filters and search, the summary cards and
 * reports (each number re-derived through the filter it publishes), document
 * upload / view / removal through GET|HEAD /api/files, tenant isolation, the
 * permission gate, master validation and master usage counts.
 *
 * Fixtures are committed in two registry tenants (testTenantIds.contract) and
 * removed in afterAll, uploaded files included.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
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
const { countUsage, USAGE, usageForVocab } = await import('../modules/master/usage.js');
const { INTERN_STATUSES, STIPEND_FREQUENCIES, INTERN_DOC_TYPES } = await import('../shared/internship.js');

const OWN = 999950;
const FOREIGN = 999951;
const PW = 'Zz-Intern-Test-9!';
const fx = { tokens: {}, files: new Set() };

const app = express();
app.use(express.json());
app.use('/api/interns', verifyToken, internRouter);
app.use('/api/files', filesRouter);

async function cleanup() {
  const { rows } = await pool.query(
    `SELECT photo_url AS u FROM interns WHERE company_id IN ($1,$2) AND photo_url IS NOT NULL
     UNION ALL SELECT file_url FROM intern_documents WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  for (const { u } of rows) fx.files.add(u);
  for (const u of fx.files) {
    const name = String(u).split('/').pop();
    if (name) rmSync(join(LOCAL_UPLOAD_DIR, name), { force: true });
  }
  await pool.query(`UPDATE employees SET source_intern_id = NULL WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM intern_audit_events WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM intern_certificates WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`UPDATE interns SET completion_evaluation_id = NULL WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM intern_evaluation_events WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM intern_evaluations WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM intern_documents WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM interns WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  const users = `SELECT id FROM users WHERE email LIKE 'zz.intern.%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.intern.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM master_values WHERE company_id IN ($1,$2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [OWN, FOREIGN]);
}

const auth = (who) => ({ Authorization: `Bearer ${fx.tokens[who]}` });

/** A complete, valid form. Every test starts from this and changes one thing. */
const form = (over = {}) => ({
  first_name: 'Asha', last_name: 'Rao', college: 'ZZ Institute of Technology', course: 'BE/BTech',
  specialization: 'Computer Science', current_year: '3rd Year - Semester 5', graduation_year: '2027',
  department: fx.dept, designation: fx.desig, mentor_employee_id: String(fx.mentor),
  internship_type: 'Summer Internship', start_date: '2026-11-01', end_date: '2026-11-15',
  status: 'Selected', stipend: '10000', stipend_frequency: 'Monthly',
  personal_email: 'asha.zz@example.com', phone: '9876543210', ...over,
});

/** POST/PUT as multipart, the way the form sends it. */
function send(method, url, who, fields, files = []) {
  let r = request(app)[method](url).set(auth(who));
  for (const [k, v] of Object.entries(fields)) if (v != null) r = r.field(k, String(v));
  for (const f of files) r = r.attach(f.field, f.buffer, { filename: f.name, contentType: f.type });
  return r;
}
const create = (over, who = 'hr', files) => send('post', '/api/interns', who, form(over), files);

/**
 * Complete an intern the only way the API allows: an HR-approved evaluation
 * recommending completion, then POST /:id/complete. The evaluation is inserted
 * directly (its own workflow is covered by internEvaluations.integration.test.js).
 */
async function completeViaWorkflow(internId, completedOn) {
  const { rows: [i] } = await pool.query(`SELECT company_id, mentor_employee_id FROM interns WHERE id = $1`, [internId]);
  await pool.query(
    `INSERT INTO intern_evaluations (intern_id, mentor_employee_id, comments, recommendation, status,
                                     created_by_user_id, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
                                     received_at, received_via, technical_skills, communication, teamwork,
                                     discipline_attendance, learning_ability, overall_performance)
     VALUES ($1, $2, 'Fixture evaluation', 'Not Recommended', 'Approved', 1, 1, NOW(), 2, NOW(), NOW(), 'Online', 3, 3, 3, 3, 3, 3)`,
    [internId, i.mentor_employee_id ?? fx.mentor]);
  return request(app).post(`/api/interns/${internId}/complete`).set(auth('hr')).send({ completed_on: completedOn });
}

beforeAll(async () => {
  await cleanup();
  for (const [id, name, code] of [[OWN, 'ZZ Intern Own', 'ZZINTO'], [FOREIGN, 'ZZ Intern Foreign', 'ZZINTF']]) {
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,$2,$3)`, [id, name, code]);
  }
  fx.dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  fx.desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  const emp = async (cid, code, status = 'Active') => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date)
     VALUES ($1,$2,'Zz','Mentor',$3,$4,$5,$6,'2025-01-01') RETURNING id`,
    [cid, code, `zz.intern.emp.${code.toLowerCase()}@example.com`, fx.dept, fx.desig, status])).rows[0].id;
  fx.mentor = await emp(OWN, 'EMP950001');
  fx.mentor2 = await emp(OWN, 'EMP950002');
  fx.leftMentor = await emp(OWN, 'EMP950003', 'Left');
  fx.foreignMentor = await emp(FOREIGN, 'EMP951001');

  const hash = await bcrypt.hash(PW, 4);
  const login = async (key, role, cid) => {
    const email = `zz.intern.${key}@example.com`;
    const id = (await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
       VALUES ('Zz Intern', $1, $2, $3, true, $4) RETURNING id`, [email, hash, role, cid])).rows[0].id;
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [id, cid]);
    fx.tokens[key] = (await loginUser(email, PW)).token;
  };
  await login('hr', 'hr', OWN);
  await login('hrexec', 'hr_exec', OWN);
  await login('emp', 'employee', OWN);
  await login('mgr', 'manager', OWN);
  await login('foreign', 'hr', FOREIGN);
  fx.employeesBefore = Number((await pool.query(
    `SELECT COUNT(*) FROM employees WHERE company_id = $1`, [OWN])).rows[0].count);
});

afterAll(async () => { await cleanup(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('Intern ID generation', () => {
  it('previews INT001 for a company with no interns', async () => {
    const res = await request(app).get('/api/interns/next-code').set(auth('hr'));
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('INT001');
  });

  it('mints INT001 then INT002, ignoring any code the client sends', async () => {
    const a = await create({ intern_code: 'INT777', first_name: 'First' });
    const b = await create({ intern_code: 'EMP001', first_name: 'Second' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.intern_code).toBe('INT001');
    expect(b.body.intern_code).toBe('INT002');
    fx.first = a.body; fx.second = b.body;
  });

  it('serialises concurrent creates into distinct consecutive codes', async () => {
    const res = await Promise.all([1, 2, 3, 4].map(n => create({ first_name: `Burst${n}` })));
    res.forEach(r => expect(r.status, JSON.stringify(r.body)).toBe(201));
    expect(res.map(r => r.body.intern_code).sort()).toEqual(['INT003', 'INT004', 'INT005', 'INT006']);
  });

  it('numbers each company independently', async () => {
    const r = await send('post', '/api/interns', 'foreign',
      form({ mentor_employee_id: String(fx.foreignMentor) }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.intern_code).toBe('INT001');
    fx.foreignIntern = r.body;
  });

  it('never creates an employee record, and the INT format is enforced by the database', async () => {
    const after = Number((await pool.query(
      `SELECT COUNT(*) FROM employees WHERE company_id = $1`, [OWN])).rows[0].count);
    expect(after).toBe(fx.employeesBefore);
    await expect(pool.query(`UPDATE interns SET intern_code = 'EMP001' WHERE id = $1`, [fx.first.id]))
      .rejects.toThrow(/interns_code_format/);
    await expect(pool.query(`UPDATE interns SET intern_code = 'int002' WHERE id = $1`, [fx.first.id]))
      .rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Add Intern', () => {
  it('stores the record under the CALLER\'s company, not one in the body', async () => {
    const r = await create({ company_id: String(FOREIGN), first_name: 'Scoped' });
    expect(r.status).toBe(201);
    const { rows } = await pool.query(`SELECT company_id FROM interns WHERE id = $1`, [r.body.id]);
    expect(rows[0].company_id).toBe(OWN);
  });

  it.each([
    ['first_name', { first_name: '' }],
    ['college', { college: ' ' }],
    ['course', { course: '' }],
    ['department', { department: '' }],
    ['designation', { designation: '' }],
    ['start_date', { start_date: '' }],
    ['end_date', { end_date: '' }],
  ])('requires %s and names it', async (field, over) => {
    const r = await create(over);
    expect(r.status).toBe(400);
    expect(r.body.field).toBe(field);
  });

  it('refuses an end date before the start date, and impossible dates', async () => {
    let r = await create({ start_date: '2026-11-15', end_date: '2026-11-01' });
    expect([r.status, r.body.field]).toEqual([400, 'end_date']);
    r = await create({ end_date: '2026-02-30' });
    expect([r.status, r.body.field]).toEqual([400, 'end_date']);
  });

  it('computes duration from the dates: 15 days, and 6 months', async () => {
    expect(fx.first.duration_days).toBe(15);
    expect(fx.first.duration_bucket).toBe('Up to 1 month');
    const r = await create({ start_date: '2026-01-01', end_date: '2026-06-30', first_name: 'SixMonth' });
    expect(r.body.duration_days).toBe(181);
    expect(r.body.duration_bucket).toBe('3–6 months');
  });

  it('validates department and role against the masters', async () => {
    const r = await create({ department: 'ZZ No Such Department' });
    expect([r.status, r.body.field]).toEqual([400, 'department']);
    const d = await create({ designation: 'ZZ No Such Role' });
    expect([d.status, d.body.field]).toEqual([400, 'designation']);
  });

  it('accepts only a current employee of the same company as mentor', async () => {
    let r = await create({ mentor_employee_id: String(fx.foreignMentor) });
    expect([r.status, r.body.field]).toEqual([400, 'mentor_employee_id']);
    r = await create({ mentor_employee_id: String(fx.leftMentor) });
    expect([r.status, r.body.field]).toEqual([400, 'mentor_employee_id']);
    r = await create({ mentor_employee_id: '' , first_name: 'NoMentor' });
    expect(r.status).toBe(201);
    expect(r.body.mentor_employee_id).toBeNull();
  });

  it('keeps stipend separate and consistent with its frequency', async () => {
    let r = await create({ stipend: '5000', stipend_frequency: '' });
    expect([r.status, r.body.field]).toEqual([400, 'stipend_frequency']);
    r = await create({ stipend: '5000', stipend_frequency: 'Unpaid' });
    expect([r.status, r.body.field]).toEqual([400, 'stipend']);
    r = await create({ stipend: '', stipend_frequency: 'Unpaid', first_name: 'Unpaid' });
    expect(r.status).toBe(201);
    const sal = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employee_salary_assignments a JOIN employees e ON e.id = a.employee_id
        WHERE e.company_id = $1`, [OWN]);
    expect(sal.rows[0].n).toBe(0);
  });

  it('cannot be created as Completed, Cancelled or Terminated, or with a certificate', async () => {
    let r = await create({ status: 'Completed', completed_on: '2026-11-15' });
    expect([r.status, r.body.field, r.body.code]).toEqual([400, 'status', 'COMPLETION_ACTION_REQUIRED']);
    for (const status of ['Cancelled', 'Terminated']) {
      r = await create({ status });
      expect([r.status, r.body.field], status).toEqual([400, 'status']);
    }
    r = await create({ status: 'Active', certificate_issued: 'true', certificate_number: 'X-1' });
    expect([r.status, r.body.code]).toEqual([400, 'COMPLETION_ACTION_REQUIRED']);
  });

  it('does not treat the string "null" from a blank FormData field as a value', async () => {
    const r = await create({ last_name: 'null', mentor_employee_id: 'null', graduation_year: 'null', first_name: 'NullStr' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.last_name).toBeNull();
    expect(r.body.mentor_employee_id).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Edit Intern', () => {
  it('rewrites every field from the same complete form, including clearing', async () => {
    const r = await send('put', `/api/interns/${fx.second.id}`, 'hr', form({
      first_name: 'Bina', last_name: '', college: 'ZZ College of Commerce', course: 'MBA',
      specialization: '', mentor_employee_id: String(fx.mentor2), internship_type: '',
      start_date: '2026-09-01', end_date: '2027-02-28', status: 'Active', stipend: '1500',
      stipend_frequency: 'Weekly', phone: '', notes: 'Strong analytics', address: 'Pune',
      emergency_name: 'Ravi', emergency_phone: '9123456780', emergency_relationship: 'Father',
      dob: '2004-05-06', gender: 'Female', other_benefits: 'Laptop',
    }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      intern_code: 'INT002', first_name: 'Bina', last_name: null, college: 'ZZ College of Commerce',
      course: 'MBA', specialization: null, mentor_employee_id: fx.mentor2, internship_type: null,
      start_date: '2026-09-01', end_date: '2027-02-28', duration_days: 181, status: 'Active',
      stipend_frequency: 'Weekly', phone: null, notes: 'Strong analytics', address: 'Pune',
      emergency_name: 'Ravi', emergency_phone: '9123456780', emergency_relationship: 'Father',
      dob: '2004-05-06', gender: 'Female', other_benefits: 'Laptop',
    });
    expect(Number(r.body.stipend)).toBe(1500);
  });

  it('View returns every value Edit saved', async () => {
    const r = await request(app).get(`/api/interns/${fx.second.id}`).set(auth('hr'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ first_name: 'Bina', college: 'ZZ College of Commerce', mentor_name: 'Zz Mentor' });
    expect(Array.isArray(r.body.documents)).toBe(true);
  });

  it('the general update cannot complete, certify or move along a forbidden transition', async () => {
    // fx.second is Active (set by the edit above).
    let r = await send('put', `/api/interns/${fx.second.id}`, 'hr', form({
      ...await currentForm(fx.second.id), status: 'Completed', completed_on: '2026-10-01',
    }));
    expect([r.status, r.body.code]).toEqual([400, 'COMPLETION_ACTION_REQUIRED']);
    r = await send('put', `/api/interns/${fx.second.id}`, 'hr', form({
      ...await currentForm(fx.second.id), certificate_issued: 'true', certificate_number: 'CERT-001',
    }));
    expect([r.status, r.body.code]).toEqual([400, 'COMPLETION_ACTION_REQUIRED']);
    r = await send('put', `/api/interns/${fx.second.id}`, 'hr', form({ ...await currentForm(fx.second.id), status: 'Applied' }));
    expect([r.status, r.body.field]).toEqual([400, 'status']);
    const { rows } = await pool.query(`SELECT status, completed_on, certificate_issued FROM interns WHERE id = $1`, [fx.second.id]);
    expect(rows[0]).toEqual({ status: 'Active', completed_on: null, certificate_issued: false });
  });

  it('allowed moves still work: Applied → Selected → Onboarding → Active → Terminated', async () => {
    const id = (await create({ first_name: 'Walker', status: 'Applied' })).body.id;
    for (const status of ['Selected', 'Onboarding', 'Active', 'Terminated']) {
      const r = await send('put', `/api/interns/${id}`, 'hr', form({ ...await currentForm(id), status, status_reason: status === 'Terminated' ? 'Policy breach' : '' }));
      expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.status).toBe(status);
    }
    const r = await send('put', `/api/interns/${id}`, 'hr', form({ ...await currentForm(id), status: 'Active' }));
    expect([r.status, r.body.field]).toEqual([400, 'status']);
  });

  it('keeps a mentor who has since left when the field is unchanged', async () => {
    await pool.query(`UPDATE interns SET mentor_employee_id = $1 WHERE id = $2`, [fx.leftMentor, fx.first.id]);
    const r = await send('put', `/api/interns/${fx.first.id}`, 'hr', form({
      ...await currentForm(fx.first.id), notes: 'edited',
    }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.mentor_employee_id).toBe(fx.leftMentor);
  });
});

/** The stored record as the form would re-send it. */
async function currentForm(id) {
  const r = await request(app).get(`/api/interns/${id}`).set(auth('hr'));
  const out = {};
  for (const [k, v] of Object.entries(r.body)) {
    if (v == null || typeof v === 'object') continue;
    out[k] = String(v);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
describe('Register: search and filters', () => {
  beforeAll(async () => {
    const r = await create({
      first_name: 'Chetan', last_name: 'Iyer', college: 'ZZ Arts College', personal_email: 'chetan.zz@example.com',
      mentor_employee_id: String(fx.mentor2), internship_type: 'Project Internship',
      start_date: '2027-03-01', end_date: '2027-08-31', status: 'Applied',
    });
    fx.chetan = r.body;
  });

  const list = async (qs, who = 'hr') => {
    const r = await request(app).get(`/api/interns?${new URLSearchParams(qs)}`).set(auth(who));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const codes = (rows) => rows.map(r => r.intern_code);

  it('searches by name, Intern ID, college and email', async () => {
    expect(codes(await list({ q: 'chetan iy' }))).toEqual([fx.chetan.intern_code]);
    expect(codes(await list({ q: fx.chetan.intern_code }))).toEqual([fx.chetan.intern_code]);
    expect(codes(await list({ q: 'ZZ Arts' }))).toEqual([fx.chetan.intern_code]);
    expect(codes(await list({ q: 'chetan.zz@' }))).toEqual([fx.chetan.intern_code]);
  });

  it('treats % and _ in the search as literal characters', async () => {
    expect(await list({ q: '%' })).toEqual([]);
  });

  it('filters by department, college, status, mentor, type, dates and duration', async () => {
    expect(codes(await list({ college: 'zz arts college' }))).toEqual([fx.chetan.intern_code]);
    expect(codes(await list({ status: 'Applied' }))).toContain(fx.chetan.intern_code);
    expect((await list({ status: 'Applied' })).every(r => r.status === 'Applied')).toBe(true);
    expect((await list({ mentor_id: fx.mentor2 })).every(r => r.mentor_employee_id === fx.mentor2)).toBe(true);
    expect(codes(await list({ internship_type: 'Project Internship' }))).toEqual([fx.chetan.intern_code]);
    expect(codes(await list({ start_from: '2027-03-01', start_to: '2027-03-01' }))).toEqual([fx.chetan.intern_code]);
    expect(codes(await list({ end_from: '2027-08-31' }))).toEqual([fx.chetan.intern_code]);
    expect((await list({ duration: 'Over 6 months' })).map(r => r.duration_days).every(d => d > 184)).toBe(true);
    expect((await list({ department: fx.dept })).length).toBeGreaterThan(0);
  });

  it('rejects an unknown status or view rather than ignoring it', async () => {
    const r = await request(app).get('/api/interns?status=Hired').set(auth('hr'));
    expect(r.status).toBe(400);
    const v = await request(app).get('/api/interns?view=everything').set(auth('hr'));
    expect(v.status).toBe(400);
  });

  it('lists only the caller\'s company', async () => {
    const own = await list({});
    expect(own.some(r => r.id === fx.foreignIntern.id)).toBe(false);
    const foreign = await list({}, 'foreign');
    expect(codes(foreign)).toEqual(['INT001']);
  });

  it('offers filter values from the caller\'s own interns only', async () => {
    const r = await request(app).get('/api/interns/filter-options').set(auth('foreign'));
    expect(r.body.colleges).toEqual(['ZZ Institute of Technology']);
    expect(r.body.mentors.map(m => m.id)).toEqual([fx.foreignMentor]);
  });

  it('offers only current employees of the caller\'s company as mentors', async () => {
    const r = await request(app).get('/api/interns/mentor-options').set(auth('hr'));
    const ids = r.body.map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining([fx.mentor, fx.mentor2]));
    expect(ids).not.toContain(fx.leftMentor);
    expect(ids).not.toContain(fx.foreignMentor);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Summary cards and reports', () => {
  beforeAll(async () => {
    // One internship in each date window the cards care about.
    const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
    await create({ first_name: 'EndsSoon', status: 'Active', start_date: iso(-30), end_date: iso(3) });
    await create({ first_name: 'StartsSoon', status: 'Selected', start_date: iso(2), end_date: iso(40) });
    await create({ first_name: 'Overdue', status: 'Active', start_date: iso(-60), end_date: iso(-1) });
    const done = await create({ first_name: 'Done', status: 'Active', start_date: iso(-90), end_date: iso(-10) });
    const c = await completeViaWorkflow(done.body.id, iso(-10));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  });

  it('every card count equals the size of the list its filter opens', async () => {
    const { body } = await request(app).get('/api/interns/summary').set(auth('hr'));
    for (const [card, filter] of Object.entries(body.card_filters)) {
      const rows = (await request(app).get(`/api/interns?${new URLSearchParams(filter)}`).set(auth('hr'))).body;
      expect(rows.length, `card ${card}`).toBe(body.cards[card]);
    }
    expect(body.cards.ending_soon).toBeGreaterThanOrEqual(1);
    expect(body.cards.starting_soon).toBeGreaterThanOrEqual(1);
    expect(body.cards.awaiting_completion).toBeGreaterThanOrEqual(1);
    expect(body.cards.completed).toBeGreaterThanOrEqual(1);
  });

  it('every report row opens exactly the interns it counted', async () => {
    const { body } = await request(app).get('/api/interns/summary').set(auth('hr'));
    const rowsOf = [
      ...body.reports.active_by_department, ...body.reports.by_college,
      ...body.reports.by_duration, ...body.reports.by_status, ...body.reports.stipend.by_department,
    ];
    for (const row of rowsOf) {
      const rows = (await request(app).get(`/api/interns?${new URLSearchParams(row.filter)}`).set(auth('hr'))).body;
      expect(rows.length, JSON.stringify(row)).toBe(row.count);
    }
    expect(body.reports.by_status.map(r => r.label)).toEqual(INTERN_STATUSES);
  });

  it('reports a stipend run-rate from the current population only, per frequency', async () => {
    const { body } = await request(app).get('/api/interns/summary').set(auth('foreign'));
    // The foreign company's only intern is Selected, so nothing is being paid.
    expect(body.reports.stipend.monthly_run_rate).toBe(0);
    const own = (await request(app).get('/api/interns/summary').set(auth('hr'))).body.reports.stipend;
    const { rows } = await pool.query(
      `SELECT stipend, stipend_frequency FROM interns
        WHERE company_id = $1 AND deleted_at IS NULL AND status IN ('Onboarding','Active')`, [OWN]);
    const expected = rows.reduce((s, r) => s + (r.stipend_frequency === 'Monthly' ? Number(r.stipend)
      : r.stipend_frequency === 'Weekly' ? Number(r.stipend) * 52 / 12 : 0), 0);
    expect(own.monthly_run_rate).toBeCloseTo(expected, 0);
  });

  it('counts only the caller\'s company', async () => {
    const { body } = await request(app).get('/api/interns/summary').set(auth('foreign'));
    expect(body.cards.total).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Documents and photo, through the authenticated file route', () => {
  const pdf = (name) => ({ field: 'doc_college_id', buffer: Buffer.from('%PDF-1.4 zz'), name, type: 'application/pdf' });

  it('uploads a photo and documents on create, and lists them on View', async () => {
    const r = await create({ first_name: 'Docs' }, 'hr', [
      { field: 'photo_file', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), name: 'face.png', type: 'image/png' },
      pdf('college-id.pdf'),
      { field: 'doc_other', buffer: Buffer.from('%PDF zz'), name: 'misc.pdf', type: 'application/pdf' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.photo_url).toMatch(/^\/uploads\//);
    expect(r.body.documents.map(d => d.doc_type).sort()).toEqual(['College ID', 'Other']);
    fx.docsIntern = r.body;
    for (const u of [r.body.photo_url, ...r.body.documents.map(d => d.file_url)]) {
      fx.files.add(u);
      expect(existsSync(join(LOCAL_UPLOAD_DIR, u.split('/').pop()))).toBe(true);
    }
  });

  const fileName = (u) => u.split('/').pop();

  it('serves them to HR of the same company, inline and as a download', async () => {
    const doc = fx.docsIntern.documents[0];
    const inline = await request(app).get(`/api/files/${fileName(doc.file_url)}?disposition=inline`).set(auth('hr'));
    expect(inline.status).toBe(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline/);
    const dl = await request(app).get(`/api/files/${fileName(doc.file_url)}`).set(auth('hrexec'));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    const head = await request(app).head(`/api/files/${fileName(fx.docsIntern.photo_url)}`).set(auth('hr'));
    expect(head.status).toBe(200);
  });

  it('refuses them to another company and to roles without internships:view', async () => {
    const name = fileName(fx.docsIntern.documents[0].file_url);
    for (const who of ['foreign', 'emp', 'mgr']) {
      expect((await request(app).get(`/api/files/${name}`).set(auth(who))).status, who).toBe(403);
      expect((await request(app).head(`/api/files/${name}`).set(auth(who))).status, who).toBe(403);
    }
  });

  it('removes a document on edit, after which it is no longer served', async () => {
    const victim = fx.docsIntern.documents.find(d => d.doc_type === 'Other');
    const r = await send('put', `/api/interns/${fx.docsIntern.id}`, 'hr', form({
      ...await currentForm(fx.docsIntern.id), remove_documents: String(victim.id),
    }), [{ field: 'doc_resume', buffer: Buffer.from('%PDF cv'), name: 'cv.pdf', type: 'application/pdf' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.documents.map(d => d.doc_type).sort()).toEqual(['College ID', 'Resume']);
    r.body.documents.forEach(d => fx.files.add(d.file_url));
    expect((await request(app).get(`/api/files/${fileName(victim.file_url)}`).set(auth('hr'))).status).toBe(403);
  });

  it('cannot remove another intern\'s document by id', async () => {
    const other = fx.docsIntern.documents.find(d => d.doc_type === 'College ID');
    await send('put', `/api/interns/${fx.first.id}`, 'hr', form({
      ...await currentForm(fx.first.id), remove_documents: String(other.id),
    }));
    const { rows } = await pool.query(`SELECT deleted_at FROM intern_documents WHERE id = $1`, [other.id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it('removes the photo when asked', async () => {
    const r = await send('put', `/api/interns/${fx.docsIntern.id}`, 'hr', form({
      ...await currentForm(fx.docsIntern.id), remove_photo: 'true',
    }));
    expect(r.body.photo_url).toBeNull();
  });

  it('rejects a non-image photo and a disallowed document type', async () => {
    let r = await create({}, 'hr', [{ field: 'photo_file', buffer: Buffer.from('%PDF'), name: 'x.pdf', type: 'application/pdf' }]);
    expect(r.status).toBe(415);
    r = await create({}, 'hr', [{ field: 'doc_resume', buffer: Buffer.from('<html>'), name: 'x.html', type: 'text/html' }]);
    expect(r.status).toBe(415);
  });

  it('refuses a document row filed under a different company than its intern', async () => {
    await expect(pool.query(
      `INSERT INTO intern_documents (company_id, intern_id, doc_type, file_url) VALUES ($1,$2,'Other','/uploads/zz')`,
      [FOREIGN, fx.docsIntern.id])).rejects.toThrow(/does not match/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Education dropdowns: Course, Specialization, Year / Semester', () => {
  const mv = async (type, value, companyId, active = true) => (await pool.query(
    `INSERT INTO master_values (type, value, sort_order, company_id, is_active)
     VALUES ($1,$2,99,$3,$4) RETURNING id`, [type, value, companyId, active])).rows[0].id;

  it('registers three vocabularies, seeded and counted against interns', async () => {
    const { BY_KEY } = await import('../modules/master/vocabularies.js');
    expect(BY_KEY.courses).toMatchObject({ type: 'COURSE', columns: ['interns.course'] });
    expect(BY_KEY.specializations).toMatchObject({ type: 'SPECIALIZATION', columns: ['interns.specialization'] });
    expect(BY_KEY['academic-years']).toMatchObject({ type: 'ACADEMIC_YEAR', columns: ['interns.current_year'] });
    const { rows } = await pool.query(
      `SELECT type, COUNT(*)::int AS n FROM master_values
        WHERE company_id IS NULL AND is_active AND type IN ('COURSE','SPECIALIZATION','ACADEMIC_YEAR') GROUP BY 1`);
    const n = Object.fromEntries(rows.map(r => [r.type, r.n]));
    expect(n.COURSE).toBeGreaterThanOrEqual(15);
    expect(n.SPECIALIZATION).toBeGreaterThanOrEqual(16);
    expect(n.ACADEMIC_YEAR).toBeGreaterThanOrEqual(12);
    const usage = await countUsage(usageForVocab('courses'), 'BE/BTech', OWN);
    expect(usage.breakdown.find(b => b.table === 'interns')?.count).toBeGreaterThan(0);
  });

  it('stores the master spelling of a value typed in another case', async () => {
    const r = await create({ first_name: 'Case', course: 'be/btech', specialization: 'computer science',
      current_year: '1ST YEAR - SEMESTER 1' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ course: 'BE/BTech', specialization: 'Computer Science', current_year: '1st Year - Semester 1' });
  });

  it('refuses a value that is not in the list, naming the field', async () => {
    for (const [field, value] of [['course', 'B.Tech'], ['specialization', 'Underwater Welding'], ['current_year', '3rd Year']]) {
      const r = await create({ [field]: value });
      expect([r.status, r.body.field], `${field}=${value}`).toEqual([400, field]);
    }
  });

  it('requires a course, and lets Specialization and Year / Semester be cleared', async () => {
    const r = await create({ course: '' });
    expect([r.status, r.body.field]).toEqual([400, 'course']);
    const ok = await create({ first_name: 'Blanks', specialization: '', current_year: '' });
    expect(ok.status).toBe(201);
    const put = await send('put', `/api/interns/${fx.first.id}`, 'hr', form({
      ...await currentForm(fx.first.id), specialization: '', current_year: '',
    }));
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ specialization: null, current_year: null, course: 'BE/BTech' });
  });

  it("accepts the caller's own company values and refuses another company's", async () => {
    await mv('COURSE', 'ZZ Foreign Degree', FOREIGN);
    await mv('SPECIALIZATION', 'ZZ Own Track', OWN);
    let r = await create({ course: 'ZZ Foreign Degree' });
    expect([r.status, r.body.field]).toEqual([400, 'course']);
    r = await send('post', '/api/interns', 'foreign', form({
      first_name: 'ForeignDegree', course: 'ZZ Foreign Degree', mentor_employee_id: String(fx.foreignMentor) }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.course).toBe('ZZ Foreign Degree');
    r = await create({ first_name: 'OwnTrack', specialization: 'ZZ Own Track' });
    expect(r.status).toBe(201);
    r = await send('post', '/api/interns', 'foreign', form({
      specialization: 'ZZ Own Track', mentor_employee_id: String(fx.foreignMentor) }));
    expect([r.status, r.body.field]).toEqual([400, 'specialization']);
  });

  it('keeps a stored legacy or deactivated value through an unrelated edit, but will not switch to one', async () => {
    // A free-text value from before the dropdowns, and a value since deactivated.
    const id = (await create({ first_name: 'Legacy' })).body.id;
    const retired = await mv('ACADEMIC_YEAR', 'ZZ Trimester 2', OWN);
    await pool.query(
      `UPDATE interns SET course = 'B.Tech (Hons)', specialization = 'Robotics & AI', current_year = 'ZZ Trimester 2'
        WHERE id = $1`, [id]);
    await pool.query(`UPDATE master_values SET is_active = false WHERE id = $1`, [retired]);

    let r = await send('put', `/api/interns/${id}`, 'hr', form({ ...await currentForm(id), notes: 'unrelated edit' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ course: 'B.Tech (Hons)', specialization: 'Robotics & AI',
      current_year: 'ZZ Trimester 2', notes: 'unrelated edit' });

    // Switching ANOTHER intern to the legacy or deactivated value is refused.
    r = await send('put', `/api/interns/${fx.first.id}`, 'hr', form({ ...await currentForm(fx.first.id), course: 'B.Tech (Hons)' }));
    expect([r.status, r.body.field]).toEqual([400, 'course']);
    r = await create({ current_year: 'ZZ Trimester 2' });
    expect([r.status, r.body.field]).toEqual([400, 'current_year']);

    // And the legacy row can be moved onto a master value.
    r = await send('put', `/api/interns/${id}`, 'hr', form({ ...await currentForm(id), course: 'BE/BTech' }));
    expect(r.body.course).toBe('BE/BTech');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Tenant isolation and permissions', () => {
  it('another company cannot read or edit an intern by id', async () => {
    expect((await request(app).get(`/api/interns/${fx.first.id}`).set(auth('foreign'))).status).toBe(404);
    const r = await send('put', `/api/interns/${fx.first.id}`, 'foreign', form({ mentor_employee_id: '' }));
    expect(r.status).toBe(404);
    const { rows } = await pool.query(`SELECT first_name FROM interns WHERE id = $1`, [fx.first.id]);
    expect(rows[0].first_name).toBe('First');
  });

  it('an employee or manager role is refused every intern endpoint', async () => {
    for (const who of ['emp', 'mgr']) {
      expect((await request(app).get('/api/interns').set(auth(who))).status, who).toBe(403);
      expect((await request(app).get('/api/interns/summary').set(auth(who))).status, who).toBe(403);
      expect((await request(app).get(`/api/interns/${fx.first.id}`).set(auth(who))).status, who).toBe(403);
      expect((await create({}, who)).status, who).toBe(403);
    }
  });

  it('seeds the permission for the HR/admin tier only, with no delete for anyone', async () => {
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS code, rp.can_view, rp.can_add, rp.can_edit, rp.can_delete
         FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.module = 'internships'`);
    const viewers = rows.filter(r => r.can_view).map(r => r.code).sort();
    expect(viewers).toEqual(['admin', 'hr', 'hr_exec', 'hr_manager', 'super_admin']);
    expect(rows.some(r => r.can_delete)).toBe(false);
  });

  it('the mentor trigger refuses another company\'s employee even without the API', async () => {
    await expect(pool.query(`UPDATE interns SET mentor_employee_id = $1 WHERE id = $2`, [fx.foreignMentor, fx.first.id]))
      .rejects.toThrow(/is not an employee of company/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Masters and vocabularies', () => {
  it('Master Data usage counts include interns, scoped to the company', async () => {
    const dept = await countUsage(USAGE.departments, fx.dept, FOREIGN);
    const { rows: [own] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM interns WHERE company_id = $1 AND department = $2 AND deleted_at IS NULL`, [FOREIGN, fx.dept]);
    expect(own.n).toBeGreaterThan(0);
    expect(dept.breakdown.find(b => b.table === 'interns')?.count).toBe(own.n);
    const type = await countUsage(usageForVocab('internship-types'), 'Project Internship', OWN);
    expect(type.breakdown.find(b => b.table === 'interns')?.count).toBe(1);
  });

  it('the API vocabularies equal the database CHECK constraints', async () => {
    const def = async (name) => (await pool.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, [name])).rows[0].d;
    const values = (d) => [...d.matchAll(/'([^']+)'::/g)].map(m => m[1]);
    expect(values(await def('interns_status_check'))).toEqual(INTERN_STATUSES);
    expect(values(await def('interns_stipend_frequency_check'))).toEqual(STIPEND_FREQUENCIES);
    expect(values(await def('intern_documents_type_check'))).toEqual(Object.values(INTERN_DOC_TYPES));
  });

  it('seeds the Internship Type master', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM master_values WHERE type = 'INTERNSHIP_TYPE' AND company_id IS NULL AND is_active`);
    expect(rows[0].n).toBeGreaterThanOrEqual(6);
  });
});
