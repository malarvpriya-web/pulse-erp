/**
 * HR audit fixes, 2026-11-16 (HR_MODULE_PAGE_AUDIT_2026-11-16.md), real routers
 * against the test database with real tokens:
 *   B1  Ex-Employees and the Offboarding list leave out deleted employees.
 *   B2  The offboarding checklist is per company: a company's save replaces only
 *       its own items, other companies keep theirs (or the shared default), and
 *       the per-employee checklist routes refuse another company's employee.
 *   B3  Exit interviews count only when tied to that employee's own live exit;
 *       recording one needs an exit (409 NO_EXIT); employee_id has a real FK.
 * Two isolated companies; everything is removed in afterAll.
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
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { requireCompanyScope } = await import('../shared/scope.js');
const { default: hrRouter } = await import('../modules/hr/hr.routes.js');
const { default: exitRouter } = await import('../modules/hr/exit.routes.js');
const { default: employeeRouter } = await import('../employees/employee.routes.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');

const PREFIX = 'ZZHRAUD';
const app = express();
app.use(express.json());
app.use('/api/hr', verifyToken, requireCompanyScope, hrRouter);   // as in server.js
app.use('/api/exit', verifyToken, exitRouter);
app.use('/api/employees', employeeRouter);
const fx = { A: null, B: null };
const call = (co, method, path, body) =>
  request(app)[method](path).set('Authorization', `Bearer ${co.token()}`).send(body ?? undefined);

async function cleanupCompany(id) {
  const emps = `SELECT id FROM employees WHERE company_id = $1`;
  const q = (sql) => pool.query(sql, [id]);
  await q(`DELETE FROM audit_logs WHERE company_id = $1`);
  await q(`DELETE FROM hr_offboarding_checklist_progress WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM hr_offboarding_checklist_templates WHERE company_id = $1`);
  await q(`DELETE FROM exit_interviews WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM exit_clearance WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM exit_requests WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
  await dropIsolatedCompany(pool, id);
}

let seq = 0;
async function employee(company, { status = 'Active', deleted = false } = {}) {
  seq += 1;
  return (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date, exit_date, deleted_at)
     VALUES ($1,$2,'Zz',$3,$4,$5,'2024-01-01',$6,$7) RETURNING id`,
    [company.companyId, `EMP1116${String(seq).padStart(3, '0')}`, `Haud${seq}`, `zz.haud.${company.code.toLowerCase()}.${seq}@example.com`,
      status, status === 'terminated' ? '2026-10-31' : null, deleted ? new Date() : null])).rows[0].id;
}
const exitFor = async (emp, status = 'active') => (await pool.query(
  `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, reason, notice_period)
   VALUES ($1,'resignation',CURRENT_DATE + 10,$2,'zz',30) RETURNING id`, [emp, status])).rows[0].id;
const interview = (emp, er, reason) => pool.query(
  `INSERT INTO exit_interviews (exit_request_id, employee_id, reason_category, overall_rating)
   VALUES ($1,$2,$3,5)`, [er, emp, reason]);

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) await cleanupCompany(id);
  fx.A = await createIsolatedCompany(pool, `${PREFIX}A`);
  fx.B = await createIsolatedCompany(pool, `${PREFIX}B`);
});
afterAll(async () => {
  await new Promise(r => setTimeout(r, 400)); // fire-and-forget audit writes
  for (const co of [fx.A, fx.B]) if (co) await cleanupCompany(co.companyId);
});

describe('B1: deleted employees are not ex-employees or offboarding cases', () => {
  it('lists the live leaver and leaves out the deleted one', async () => {
    const live = await employee(fx.A, { status: 'terminated' });
    const gone = await employee(fx.A, { status: 'terminated', deleted: true });

    const ex = await call(fx.A, 'get', '/api/employees/ex');
    expect(ex.status).toBe(200);
    const exIds = (ex.body.data ?? ex.body).map(r => r.id);
    expect(exIds).toContain(live);
    expect(exIds).not.toContain(gone);

    const off = await call(fx.A, 'get', '/api/hr/offboarding');
    expect(off.status).toBe(200);
    expect(off.body.map(r => r.id)).toEqual([live]);
  });
});

describe('B2: offboarding checklist per company', () => {
  const sharedDefault = async () => (await pool.query(
    `SELECT category, item_label FROM hr_offboarding_checklist_templates
      WHERE is_active AND company_id IS NULL ORDER BY category, sort_order, id`)).rows;

  it("a company's save changes only its own checklist", async () => {
    const before = await sharedDefault();
    const strip = (rows) => rows.map(({ category, item_label }) => ({ category, item_label }));
    // Until a company saves its own, it sees the shared default.
    expect(strip((await call(fx.B, 'get', '/api/hr/offboarding/templates')).body)).toEqual(before);

    const save = await call(fx.A, 'put', '/api/hr/offboarding/templates', {
      items: [{ category: 'IT', item_label: 'Laptop returned', default_assignee: 'IT', default_offset_days: 1 },
              { category: 'HR', item_label: 'Exit interview conducted', default_assignee: 'HR' }],
    });
    expect(save.status).toBe(200);

    const a = (await call(fx.A, 'get', '/api/hr/offboarding/templates')).body;
    expect(strip(a)).toEqual([{ category: 'HR', item_label: 'Exit interview conducted' },
                              { category: 'IT', item_label: 'Laptop returned' }]);
    // B and the shared default are untouched.
    expect(strip((await call(fx.B, 'get', '/api/hr/offboarding/templates')).body)).toEqual(before);
    expect(await sharedDefault()).toEqual(before);

    // Saving again replaces A's own list (old items deactivated, not duplicated).
    await call(fx.A, 'put', '/api/hr/offboarding/templates', { items: [{ category: 'IT', item_label: 'Laptop returned' }] });
    expect(strip((await call(fx.A, 'get', '/api/hr/offboarding/templates')).body))
      .toEqual([{ category: 'IT', item_label: 'Laptop returned' }]);
    // Two companies may use the same item.
    expect((await call(fx.B, 'put', '/api/hr/offboarding/templates', { items: [{ category: 'IT', item_label: 'Laptop returned' }] })).status).toBe(200);
  });

  it("the employee checklist uses that company's items and refuses another company's employee", async () => {
    const mine = await employee(fx.A, { status: 'Notice' });
    const theirs = await employee(fx.B, { status: 'Notice' });

    const own = await call(fx.A, 'get', `/api/hr/offboarding/${mine}/checklist`);
    expect(own.status).toBe(200);
    expect(own.body.map(r => r.item_label)).toEqual(['Laptop returned']);

    expect((await call(fx.A, 'get', `/api/hr/offboarding/${theirs}/checklist`)).status).toBe(404);
    const write = await call(fx.A, 'patch', `/api/hr/offboarding/${theirs}/checklist`,
      { items: [{ category: 'IT', item_label: 'Laptop returned', done: true }] });
    expect(write.status).toBe(404);
    const { rows } = await pool.query(`SELECT 1 FROM hr_offboarding_checklist_progress WHERE employee_id = $1`, [theirs]);
    expect(rows).toEqual([]);
  });
});

describe('B3: exit interviews belong to a real exit', () => {
  it('list and analytics count only interviews on the employee\'s own live exit', async () => {
    const leaver = await employee(fx.A, { status: 'Notice' });
    const er = await exitFor(leaver);
    await interview(leaver, er, 'zz_real');

    const stayer = await employee(fx.A);                       // never left
    await interview(stayer, er, 'zz_other_persons_exit');      // points at someone else's exit
    const withdrawn = await employee(fx.A);
    await interview(withdrawn, await exitFor(withdrawn, 'cancelled'), 'zz_withdrawn');
    await interview(stayer, null, 'zz_no_exit');

    const list = await call(fx.A, 'get', '/api/exit/interviews');
    expect(list.status).toBe(200);
    expect(list.body.map(r => r.reason_category)).toEqual(['zz_real']);

    const stats = await call(fx.A, 'get', '/api/exit/interviews/analytics');
    expect(stats.body.reasons).toEqual([{ reason_category: 'zz_real', count: '1' }]);
    expect(Number(stats.body.ratings.avg_overall)).toBe(5);
    // Company B sees none of A's.
    expect((await call(fx.B, 'get', '/api/exit/interviews')).body).toEqual([]);
  });

  it('recording an interview needs an exit in progress', async () => {
    const stayer = await employee(fx.A);
    const refused = await call(fx.A, 'post', '/api/exit/interview', { employee_id: stayer, reason_category: 'zz' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NO_EXIT');
    const { rows } = await pool.query(`SELECT 1 FROM exit_interviews WHERE employee_id = $1`, [stayer]);
    expect(rows).toEqual([]);

    const leaver = await employee(fx.A, { status: 'Notice' });
    const er = await exitFor(leaver);
    const ok = await call(fx.A, 'post', '/api/exit/interview', { employee_id: leaver, reason_category: 'Personal', overall_rating: 4 });
    expect(ok.status).toBe(201);
    expect(ok.body.exit_request_id).toBe(er);
  });

  it('employee_id must be a real employee', async () => {
    await expect(pool.query(`INSERT INTO exit_interviews (employee_id, reason_category) VALUES (0, 'zz_orphan')`))
      .rejects.toMatchObject({ code: '23503' });
  });
});
