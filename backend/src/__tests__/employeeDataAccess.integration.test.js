/**
 * Who may read what about ANOTHER employee — HR notes, the employee list and
 * the onboarding checklist — verified against the live database through the
 * real routers and real logins (2026-10-20).
 *
 * Before this pass:
 *   · GET /notes/:employeeId had no role check — any authenticated user read
 *     HR's notes on any colleague in their company.
 *   · GET /employees gave an ordinary employee every colleague's personal
 *     phone, masked PAN/Aadhaar, gender, previous employers, exit reason, …
 *   · GET /onboarding/progress/:id had no role check either.
 *   · GET /employees/:id for SELF returned HR's free-text `notes` field.
 *   · A caller whose company could not be resolved was read as "all companies".
 * Each `it` below names the rule it pins.
 *
 * Fixtures live in two registry tenants (testTenantIds.contract.test.js) and
 * are removed in afterAll by company id. The two real hr_notes rows (company 1)
 * are fingerprinted before and after and must be byte-identical.
 * ⚠ Do not run this while a Playwright crawl is going.
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
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { default: employeeRouter } = await import('../employees/employee.routes.js');
const { default: noteRouter } = await import('../notes/note.routes.js');
const { default: onboardingRouter } = await import('../modules/hr/onboarding.routes.js');

const A = 999944;
const B = 999945;
const PW = 'Zz-EmpAccess-Test-9!';
const MAIL = 'zz.empacc.';
const fx = { tok: {}, user: {}, emp: {} };

const app = express();
app.use(express.json());
app.use('/api/employees', employeeRouter);
app.use('/api/notes', noteRouter);
app.use('/api/onboarding', verifyToken, onboardingRouter);   // mounted behind verifyToken in server.js
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const get = (who, path) => request(app).get(`/api${path}`).set(as(who));

const PICKER_FIELDS = new Set([
  'id', 'office_id', 'name', 'first_name', 'last_name', 'designation', 'department', 'sub_department',
  'company_email', 'status', 'photo_url', 'location', 'joining_date', 'reporting_manager',
  'reporting_manager_id', 'company_id', 'branch_id', 'zone_id', 'work_centre_id', 'default_shift_id',
  'is_field_employee',
]);
const SENSITIVE = ['phone', 'pan_number', 'aadhaar_number', 'gender', 'previous_company_1', 'exit_reason',
  'biometric_user_id', 'grade', 'band', 'dob', 'personal_email', 'basic_salary', 'notes',
  'current_address', 'highest_qualification', 'employment_type'];

const realNotes = () => pool.query(
  `SELECT id, employee_id, company_id, created_by, created_at, md5(note_text) AS h
     FROM hr_notes WHERE company_id IS NULL OR company_id < 999900 ORDER BY id`).then(r => r.rows);
let realNotesBefore;

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  await pool.query(`DELETE FROM hr_notes WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM hr_onboarding_checklist_progress WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM hr_onboarding_checklist_templates WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM department_heads WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${MAIL}%@example.com'`);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0; let D1; let D2;
async function emp(key, cid, { dept = null, manager = null, notes = null } = {}) {
  seq += 1;
  const n = String(seq).padStart(3, '0');
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, phone, pan_number, aadhaar_number, gender, previous_company_1,
                            exit_reason, biometric_user_id, grade, notes, reporting_manager_id)
     VALUES ($1,$2,'Zz',$3,$4,$5,'Engineer','Active','2026-09-01',$6,$7,$8,'Female','Zz Prior Co',
             'zz reason',$9,'G7',$10,$11)
     RETURNING id`,
    [cid, `EMP944${n}`, key, `${MAIL}emp.${key}@example.com`, dept ?? D1.name,
      `98944${n}11`, `ZZEAP${n}4Z`, `9441000${n}44`, `BIO944${n}`, notes, manager])).rows[0].id;
  return fx.emp[key];
}
async function login(key, role, cid, employeeId = null) {
  const email = `${MAIL}${key}@example.com`;
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`,
    [`Zz ${key}`, email, await bcrypt.hash(PW, 4), role, cid, employeeId])).rows[0].id;
  if (cid != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

beforeAll(async () => {
  realNotesBefore = await realNotes();
  await cleanup();
  [D1, D2] = (await pool.query(`SELECT id, name FROM master_departments WHERE is_active ORDER BY id LIMIT 2`)).rows;
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ EmpAccess A','ZZEAA'), ($2,'ZZ EmpAccess B','ZZEAB')`, [A, B]);

  // Company A — a reporting line M → report → grandreport, a department head H
  // of D1, an employee of D1 with no reporting line to anyone, an outsider in
  // D2, and an ordinary employee "self" with a colleague.
  await login('manager', 'manager', A, await emp('mgr', A, { dept: D2.name }));
  await emp('report', A, { dept: D2.name, manager: fx.emp.mgr });
  await emp('grandreport', A, { dept: D2.name, manager: fx.emp.report });
  await login('depthead', 'department_head', A, await emp('head', A, { dept: D1.name }));
  await emp('deptMember', A, { dept: D1.name });
  // Reports to the head by id, outside the head's department → managed.
  await emp('headReport', A, { dept: D2.name, manager: fx.emp.head });
  // Names the head in the free-text reporting_manager only → NOT managed.
  await emp('nameOnly', A, { dept: D2.name });
  await pool.query(`UPDATE employees SET reporting_manager = 'Zz head' WHERE id = $1`, [fx.emp.nameOnly]);
  await emp('outsider', A, { dept: D2.name });
  await login('employee', 'employee', A, await emp('self', A, { notes: 'zz hr remark about self' }));
  await login('colleagueUser', 'employee', A, await emp('colleague', A));
  for (const r of ['hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'admin', 'sales_exec']) await login(r, r, A);
  await emp('foreign', B);
  await login('hrB', 'hr', B);
  // Users whose company cannot be resolved: no users.company_id, no user_scope.
  await login('unscopedEmployee', 'employee', null);
  await login('unscopedHr', 'hr', null);

  await pool.query(
    `INSERT INTO department_heads (company_id, department_id, head_employee_id, assigned_by_user_id)
     VALUES ($1,$2,$3,$4)`, [A, D1.id, fx.emp.head, fx.user.hr]);

  // HR notes (hr_notes) — one per interesting employee; one written by the department head.
  const note = (e, text, by = null) => pool.query(
    `INSERT INTO hr_notes (employee_id, note_text, company_id, created_by) VALUES ($1,$2,$3,$4)`,
    [fx.emp[e], text, e === 'foreign' ? B : A, by]);
  await note('report', 'zz note on report');
  await note('self', 'zz note on self');
  await note('colleague', 'zz note on colleague');
  await note('deptMember', 'zz note by the head', fx.user.depthead);
  await note('foreign', 'zz note in B');

  // Onboarding: one company-A template and a completed item, with an HR remark.
  await pool.query(
    `INSERT INTO hr_onboarding_checklist_templates (company_id, category, item_label, sort_order, is_active)
     VALUES ($1,'ZZEA','ZZ laptop issued',1,true)`, [A]);
  for (const e of ['report', 'grandreport', 'deptMember', 'outsider', 'self', 'colleague']) {
    await pool.query(
      `INSERT INTO hr_onboarding_checklist_progress (company_id, employee_id, category, item_label, done, notes, assignee)
       VALUES ($1,$2,'ZZEA','ZZ laptop issued',true,'zz hr-only remark','HR')`, [A, fx.emp[e]]);
  }
}, 120_000);

afterAll(async () => {
  await cleanup();
  // The two real notes are the yardstick: same ids, same text hash, same metadata.
  expect(await realNotes()).toEqual(realNotesBefore);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /notes/:employeeId — HR only', () => {
  it.each(['hr', 'hr_manager', 'hr_exec', 'admin'])('%s reads notes on an employee in their company', async (who) => {
    const r = await get(who, `/notes/${fx.emp.report}`);
    expect(r.status).toBe(200);
    expect(r.body.map(n => n.note_text)).toEqual(['zz note on report']);
  });

  it.each([
    ['employee', 'self'], ['employee', 'colleague'],
    ['manager', 'report'], ['manager', 'grandreport'],
    ['depthead', 'deptMember'],           // even the note this department head wrote
    ['payroll_admin', 'report'], ['sales_exec', 'report'],
  ])('%s reading %s\'s notes gets 403', async (who, target) => {
    const r = await get(who, `/notes/${fx.emp[target]}`);
    expect(r.status).toBe(403);
    expect(r.body).not.toBeInstanceOf(Array);
  });

  it('a refused role learns nothing from a non-existent id (403, not 404)', async () => {
    expect((await get('employee', '/notes/2147483000')).status).toBe(403);
  });

  it('HR of company A gets 404 for company B\'s employee; HR of B cannot read A', async () => {
    expect((await get('hr', `/notes/${fx.emp.foreign}`)).status).toBe(404);
    expect((await get('hrB', `/notes/${fx.emp.report}`)).status).toBe(404);
    const own = await get('hrB', `/notes/${fx.emp.foreign}`);
    expect(own.body.map(n => n.note_text)).toEqual(['zz note in B']);
  });

  it('an HR user whose company cannot be resolved is refused, not given every company', async () => {
    expect((await get('unscopedHr', `/notes/${fx.emp.report}`)).status).toBe(403);
  });

  it.each(['12abc', '1.5', '0'])('HR passing %j gets 400', async (bad) => {
    expect((await get('hr', `/notes/${encodeURIComponent(bad)}`)).status).toBe(400);
  });

  it('no token → 401', async () => {
    expect((await request(app).get(`/api/notes/${fx.emp.report}`)).status).toBe(401);
  });

  describe('writes are unchanged', () => {
    it('HR adds a note and reads it back', async () => {
      const w = await request(app).post('/api/notes').set(as('hr'))
        .send({ employeeId: fx.emp.outsider, noteText: 'zz written by hr' });
      expect(w.status).toBe(201);
      const r = await get('hr', `/notes/${fx.emp.outsider}`);
      expect(r.body.map(n => n.note_text)).toContain('zz written by hr');
    });

    it('an employee still cannot write a note', async () => {
      const w = await request(app).post('/api/notes').set(as('employee'))
        .send({ employeeId: fx.emp.colleague, noteText: 'zz not allowed' });
      expect(w.status).toBe(403);
    });

    const post = (who, employeeId, noteText = 'zz dept head note') =>
      request(app).post('/api/notes').set(as(who)).send({ employeeId, noteText });
    const notesBy = async (who, e) => (await pool.query(
      `SELECT COUNT(*)::int n FROM hr_notes WHERE employee_id = $1 AND created_by = $2`,
      [fx.emp[e], fx.user[who]])).rows[0].n;

    it.each(['deptMember', 'headReport'])('a department head writes a note for %s (managed), and HR sees it', async (target) => {
      const w = await post('depthead', fx.emp[target], `zz head on ${target}`);
      expect(w.status).toBe(201);
      expect(w.body.created_by).toBe(fx.user.depthead);
      const r = await get('hr', `/notes/${fx.emp[target]}`);
      expect(r.body.map(n => n.note_text)).toContain(`zz head on ${target}`);
    });

    it.each(['outsider', 'nameOnly', 'report', 'foreign'])('a department head writing for %s (not managed) gets 403 and writes nothing', async (target) => {
      const w = await post('depthead', fx.emp[target]);
      expect(w.status).toBe(403);
      expect(await notesBy('depthead', target)).toBe(0);
    });

    it('a department head naming a non-existent id gets the same 403 (existence not revealed)', async () => {
      expect((await post('depthead', 2147483000)).status).toBe(403);
    });

    it('a department head sending a malformed id gets 400', async () => {
      expect((await post('depthead', '12abc')).status).toBe(400);
    });

    it('a client-supplied company_id does not widen a department head\'s reach', async () => {
      const w = await request(app).post('/api/notes').set(as('depthead'))
        .send({ employeeId: fx.emp.foreign, noteText: 'zz cross', company_id: B, companyId: B });
      expect(w.status).toBe(403);
      expect(await notesBy('depthead', 'foreign')).toBe(0);
    });

    it.each(['manager', 'payroll_admin'])('%s still cannot write a note', async (who) => {
      expect((await post(who, fx.emp.report)).status).toBe(403);
    });

    it('HR still writes for any employee in its company, managed by anyone or no one', async () => {
      expect((await post('hr_exec', fx.emp.nameOnly, 'zz hr_exec note')).status).toBe(201);
    });

    it('HR cannot write onto another company\'s employee', async () => {
      const w = await request(app).post('/api/notes').set(as('hr'))
        .send({ employeeId: fx.emp.foreign, noteText: 'zz cross tenant' });
      expect(w.status).toBe(404);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /employees — role-shaped list', () => {
  const rowOf = (body, id) => (Array.isArray(body) ? body : body.employees || []).find(e => e.id === id);

  it.each(['employee', 'sales_exec'])('%s gets picker rows only — no personal or identity fields', async (who) => {
    for (const path of ['/employees', '/employees?status=all']) {
      const r = await get(who, path);
      expect(r.status).toBe(200);
      const row = rowOf(r.body, fx.emp.colleague);
      expect(row, `colleague listed on ${path}`).toBeTruthy();
      expect(Object.keys(row).filter(k => !PICKER_FIELDS.has(k))).toEqual([]);
      for (const f of SENSITIVE) expect(row, `${path} ${f}`).not.toHaveProperty(f);
      expect(row).toMatchObject({ name: expect.any(String), department: expect.any(String), status: 'Active' });
    }
  });

  it('the picker rule applies to the caller\'s own row too (full self record is GET /employees/:id)', async () => {
    const row = rowOf((await get('employee', '/employees')).body, fx.emp.self);
    expect(row).not.toHaveProperty('phone');
  });

  it('no company B rows reach company A', async () => {
    for (const who of ['employee', 'manager', 'hr']) {
      expect(rowOf((await get(who, '/employees')).body, fx.emp.foreign), who).toBeUndefined();
    }
  });

  it.each(['manager', 'depthead'])('%s keeps the masked record rows, as before', async (who) => {
    const row = rowOf((await get(who, '/employees')).body, fx.emp.colleague);
    expect(row.phone).toMatch(/^98944/);
    expect(row.pan_number).toMatch(/^XXXXXX/);
    expect(row).not.toHaveProperty('notes');
  });

  it.each(['hr', 'hr_manager', 'payroll_admin'])('%s keeps the full rows, as before', async (who) => {
    const row = rowOf((await get(who, '/employees')).body, fx.emp.self);
    expect(row.pan_number).toMatch(/^ZZEAP/);
    expect(row.notes).toBe('zz hr remark about self');
  });

  it('an employee whose company cannot be resolved is refused, not given every company', async () => {
    expect((await get('unscopedEmployee', '/employees')).status).toBe(403);
    expect((await get('unscopedEmployee', '/employees/directory')).status).toBe(403);
    expect((await get('unscopedEmployee', `/employees/${fx.emp.colleague}`)).status).toBe(403);
  });
});

describe('GET /employees/:id — HR\'s note on the employee is HR-only', () => {
  it('the employee reading their own record does not get `notes`', async () => {
    const r = await get('employee', `/employees/${fx.emp.self}`);
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('notes');
    expect(r.body.pan_number).toMatch(/^ZZEAP/);   // the rest of the self record is unchanged
  });

  it('HR reading the same record does', async () => {
    expect((await get('hr', `/employees/${fx.emp.self}`)).body.notes).toBe('zz hr remark about self');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /onboarding/progress/:id', () => {
  const prog = (who, e) => get(who, `/onboarding/progress/${fx.emp[e]}`);
  const item = (body) => body.items.find(i => i.category === 'ZZEA');

  it.each(['hr', 'hr_manager', 'hr_exec', 'admin'])('%s reads any checklist in their company, with HR remarks', async (who) => {
    const r = await prog(who, 'colleague');
    expect(r.status).toBe(200);
    expect(item(r.body)).toMatchObject({ done: true, notes: 'zz hr-only remark' });
  });

  it('the employee reads their own checklist, without HR remarks', async () => {
    const r = await prog('employee', 'self');
    expect(r.status).toBe(200);
    expect(item(r.body).done).toBe(true);
    expect(item(r.body)).not.toHaveProperty('notes');
  });

  it.each([['manager', 'report'], ['manager', 'grandreport'], ['depthead', 'deptMember']])(
    '%s reads %s (in their line / department), without HR remarks', async (who, target) => {
      const r = await prog(who, target);
      expect(r.status).toBe(200);
      expect(item(r.body)).not.toHaveProperty('notes');
    });

  it.each([
    ['employee', 'colleague'], ['colleagueUser', 'self'],
    ['manager', 'outsider'], ['manager', 'deptMember'],
    ['depthead', 'outsider'], ['depthead', 'report'],
    ['payroll_admin', 'colleague'], ['sales_exec', 'colleague'],
  ])('%s reading %s gets 403', async (who, target) => {
    expect((await prog(who, target)).status).toBe(403);
  });

  it('a manager naming another company\'s employee gets 403; HR gets 404', async () => {
    expect((await prog('manager', 'foreign')).status).toBe(403);
    expect((await prog('hr', 'foreign')).status).toBe(404);
  });

  it('a user whose company cannot be resolved is refused', async () => {
    expect((await prog('unscopedHr', 'colleague')).status).toBe(403);
  });

  it.each(['12abc', '0'])('id %j → 400', async (bad) => {
    expect((await get('hr', `/onboarding/progress/${bad}`)).status).toBe(400);
  });

  it('HR can still tick an item; an employee still cannot', async () => {
    const body = { category: 'ZZEA', item_label: 'ZZ laptop issued', done: false };
    expect((await request(app).patch(`/api/onboarding/progress/${fx.emp.colleague}/item`).set(as('hr')).send(body)).status).toBe(200);
    expect((await request(app).patch(`/api/onboarding/progress/${fx.emp.self}/item`).set(as('employee')).send(body)).status).toBe(403);
  });
});
