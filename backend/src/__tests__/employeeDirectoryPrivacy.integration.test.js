/**
 * The company phonebook and the single-employee read, verified against the
 * live database through the real employee router and real logins.
 *
 * 2026-10-20: HR → Employee Directory moved out of the HR menu and its cards
 * stopped opening Employee Profile. Two server-side facts made that safe or
 * needed fixing, and this suite pins both:
 *
 *  1. GET /employees/directory is the phonebook projection and nothing more:
 *     current staff of the caller's own company, a fixed field list, and the
 *     personal phone only for DIRECTORY_PHONE_ROLES.
 *
 *  2. GET /employees/:id for a DIRECTORY-TIER caller (an ordinary employee, or
 *     any role outside the Employees menu and the HR / salary seats) asking
 *     about SOMEONE ELSE used to return the maskPII'd employee record — which
 *     still carried the personal phone the directory withholds, the last four
 *     digits of PAN and Aadhaar, exit reason, previous employers, grade/band
 *     and the biometric id. It now returns exactly the phonebook row. Self,
 *     HR and managers are unchanged, and that is asserted too.
 *
 * Fixtures live in two registry tenants (testTenantIds.contract.test.js) and
 * are deleted in afterAll. ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { default: router } = await import('../employees/employee.routes.js');

const A = 999941;
const B = 999942;
const PW = 'Zz-EmpDir-Test-9!';
const fx = { tok: {}, user: {}, emp: {} };

const app = express();
app.use(express.json());
app.use('/api/employees', router);
const get = (who, path) => request(app).get(`/api/employees${path}`).set({ Authorization: `Bearer ${fx.tok[who]}` });

// Exactly what the phonebook returns — the contract the frontend panel draws.
const DIRECTORY_KEYS = [
  'id', 'office_id', 'name', 'first_name', 'last_name', 'designation', 'department',
  'company_email', 'phone', 'status', 'photo_url', 'joining_date', 'location',
  'reporting_manager', 'birth_md', 'anniversary_md', 'on_leave_today',
].sort();

// Never in front of a directory-tier caller looking at a colleague.
const RESTRICTED = [
  'basic_salary', 'account_number', 'ifsc_code', 'bank_name', 'uan_number', 'pf_number', 'esic_number',
  'pan_number', 'aadhaar_number', 'passport_number', 'driving_license_number',
  'pan_file', 'aadhaar_file', 'cancelled_cheque_file', 'bank_statement_file', 'resume_file', 'offer_letter_file',
  'dob', 'personal_email', 'current_address', 'permanent_address',
  'emergency_name', 'emergency_phone', 'father_name', 'mother_name', 'spouse_name', 'marital_status', 'blood_group',
  'exit_reason', 'exit_date', 'biometric_user_id', 'grade', 'band', 'notes',
  'previous_company_1', 'previous_role_1', 'gender',
];

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.empdir.%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.empdir.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
async function emp(key, cid, { status = 'Active' } = {}) {
  seq += 1;
  const n = String(seq).padStart(3, '0');
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, phone, personal_email, dob, pan_number, aadhaar_number,
                            basic_salary, current_address, exit_reason, biometric_user_id, grade, gender,
                            previous_company_1)
     VALUES ($1,$2,'Zz',$3,$4,'Engineering','Engineer',$5,'2025-01-01',$6,$7,'1990-05-17',$8,$9,
             55000,'12 Private Road','zz reason',$10,'G7','Female','Zz Prior Co')
     RETURNING id`,
    [cid, `EMP941${n}`, key, `zz.empdir.emp.${key}@example.com`, status,
      `98400${n}11`, `zz.private.${key}@example.com`, `ZZEDP${n}1Z`.slice(0, 10), `9411000${n}22`.slice(0, 12),
      `BIO941${n}`])).rows[0].id;
  return fx.emp[key];
}
async function login(key, role, cid, employeeId = null) {
  const email = `zz.empdir.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ EmpDir A','ZZEDA'), ($2,'ZZ EmpDir B','ZZEDB')`, [A, B]);
  await emp('colleague', A);
  await emp('exited', A, { status: 'Left' });
  await emp('foreign', B);
  await login('employee', 'employee', A, await emp('self', A));
  for (const r of ['hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'manager', 'department_head', 'sales_exec']) {
    await login(r, r, A);
  }
}, 60_000);

afterAll(async () => { await cleanup(); });

describe('GET /employees/directory — the phonebook', () => {
  it('returns current staff of the caller\'s own company only', async () => {
    const r = await get('employee', '/directory');
    expect(r.status).toBe(200);
    const ids = r.body.map(e => e.id);
    expect(ids).toContain(fx.emp.colleague);
    expect(ids).toContain(fx.emp.self);
    expect(ids, 'an exited employee is not in the phonebook').not.toContain(fx.emp.exited);
    expect(ids, 'another tenant\'s employee is never listed').not.toContain(fx.emp.foreign);
  });

  it('returns exactly the phonebook fields and no restricted ones', async () => {
    const row = (await get('employee', '/directory')).body.find(e => e.id === fx.emp.colleague);
    expect(Object.keys(row).sort()).toEqual(DIRECTORY_KEYS);
    for (const f of RESTRICTED) expect(row, f).not.toHaveProperty(f);
  });

  it('withholds the personal phone from an ordinary employee', async () => {
    const row = (await get('employee', '/directory')).body.find(e => e.id === fx.emp.colleague);
    expect(row.phone).toBeNull();
  });

  it.each(['hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'manager'])('shows the phone to %s', async (who) => {
    const row = (await get(who, '/directory')).body.find(e => e.id === fx.emp.colleague);
    expect(row.phone).toMatch(/^98400/);
  });

  it('refuses a caller with no token', async () => {
    expect((await request(app).get('/api/employees/directory')).status).toBe(401);
  });
});

describe('GET /employees/:id — directory-tier callers get the phonebook row', () => {
  it.each(['employee', 'sales_exec'])('%s reading a colleague gets exactly the directory projection', async (who) => {
    const r = await get(who, `/${fx.emp.colleague}`);
    expect(r.status).toBe(200);
    expect(r.body.directory_view).toBe(true);
    expect(Object.keys(r.body).filter(k => k !== 'directory_view').sort()).toEqual(DIRECTORY_KEYS);
    for (const f of RESTRICTED) expect(r.body, f).not.toHaveProperty(f);
    expect(r.body.phone, 'personal phone withheld, as on the directory').toBeNull();
  });

  it('an employee reading an exited colleague gets 404', async () => {
    expect((await get('employee', `/${fx.emp.exited}`)).status).toBe(404);
  });

  it('an employee reading another tenant\'s employee gets 404', async () => {
    expect((await get('employee', `/${fx.emp.foreign}`)).status).toBe(404);
  });

  it.each(['abc', '1 OR 1=1', '1.5', '-0'])('an employee passing id %j gets 404, not a 500', async (bad) => {
    expect((await get('employee', `/${encodeURIComponent(bad)}`)).status).toBe(404);
  });

  it('an employee reading THEIR OWN record still gets it in full', async () => {
    const r = await get('employee', `/${fx.emp.self}`);
    expect(r.status).toBe(200);
    expect(r.body.directory_view).toBeUndefined();
    expect(r.body.pan_number).toMatch(/^ZZEDP/);
    expect(r.body.basic_salary).toBeDefined();
  });
});

describe('GET /employees/:id — record-tier callers are unchanged', () => {
  it.each(['hr', 'hr_manager', 'hr_exec', 'payroll_admin'])('%s gets the full record', async (who) => {
    const r = await get(who, `/${fx.emp.colleague}`);
    expect(r.status).toBe(200);
    expect(r.body.directory_view).toBeUndefined();
    expect(r.body.pan_number).toMatch(/^ZZEDP/);
    // The master Basic follows payroll:view (PC-01 closure, salaryVisibility.js):
    // hr_exec keeps the full record but not the colleague's salary.
    if (who === 'hr_exec') expect(r.body).not.toHaveProperty('basic_salary');
    else expect(r.body.basic_salary).toBeDefined();
  });

  it.each(['manager', 'department_head'])('%s gets the maskPII record, as before', async (who) => {
    const r = await get(who, `/${fx.emp.colleague}`);
    expect(r.status).toBe(200);
    expect(r.body.directory_view).toBeUndefined();
    expect(r.body.pan_number).toMatch(/^XXXXXX/);
    expect(r.body).not.toHaveProperty('basic_salary');
    expect(r.body).not.toHaveProperty('dob');
    expect(r.body.current_address).toBe('[RESTRICTED]');
  });

  it('hr reading another tenant\'s employee still gets 404', async () => {
    expect((await get('hr', `/${fx.emp.foreign}`)).status).toBe(404);
  });
});
