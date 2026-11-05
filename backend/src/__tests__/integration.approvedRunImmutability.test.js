/**
 * An APPROVED payroll run is final: it has been posted to the GL and backs the
 * payslip and the payment. Modules outside payroll (attendance sync, leave LOP,
 * leave encashment) used to write into any run that was not yet PAID — so an
 * approval could be changed after the fact without re-approval.
 * PAYROLL_DATA_FLOW_AUDIT.md Part 10.
 *
 * One throwaway company; a synthetic employee; payroll rows inserted directly
 * (never generated or approved through the real workflow). Attendance
 * payroll-sync is NOT exercised: its scope helper reads only req.scope, so in a
 * test app it would run across every company — guarded statically instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }        = await import('../config/db.js');
const { verifyToken }          = await import('../middlewares/auth.middleware.js');
const { buildApp }             = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');
const { default: encashRoutes } = await import('../modules/leaves/routes/encashment.routes.js');

const app = buildApp(['/api/encashment', verifyToken, encashRoutes]);
const PREFIX = 'ZZRUNLCK';
let co, empId, leaveTypeId;

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  await pool.query(`DELETE FROM leave_encashments WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date) VALUES ($1, 'EMP001', 'Lock', 'Test', 'Active', '2026-01-01') RETURNING id`,
    [co.companyId]);
  empId = e.id;
  leaveTypeId = (await pool.query('SELECT id FROM leave_types ORDER BY id LIMIT 1')).rows[0].id;   // FK reference only
  // January 2027 approved; February 2027 a draft
  await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, is_test)
     VALUES ($1, 1, 2027, 'approved', 50000, 45000, false), ($1, 2, 2027, 'pending', 50000, 45000, false)`, [empId]);
}, 60000);

afterAll(async () => {
  if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); }
}, 60000);

const encash = async (month) => {
  const { rows: [x] } = await pool.query(
    `INSERT INTO leave_encashments (employee_id, leave_type_id, year, days_encashed, net_amount, encashment_month, encashment_year, status, company_id)
     VALUES ($1, $2, 2027, 2, 3000, $3, 2027, 'pending', $4) RETURNING id`, [empId, leaveTypeId, month, co.companyId]);
  const r = await request(app).post(`/api/encashment/approve/${x.id}`).set('Authorization', `Bearer ${co.token()}`);
  const { rows: [after] } = await pool.query('SELECT payroll_run_id FROM leave_encashments WHERE id = $1', [x.id]);
  return { status: r.status, payroll_run_id: after.payroll_run_id };
};
const run = async (month) => (await pool.query(
  'SELECT status, leave_encashment_amount, gross, net_pay FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = 2027', [empId, month])).rows[0];

describe('leave encashment never writes into an approved run', () => {
  it('approving an encashment for an APPROVED month leaves the run untouched and unlinked', async () => {
    const before = await run(1);
    const r = await encash(1);
    expect(r.status).toBe(200);
    expect(r.payroll_run_id).toBeNull();
    expect(await run(1)).toEqual(before);
  });

  it('a DRAFT month still receives the encashment', async () => {
    const r = await encash(2);
    expect(r.status).toBe(200);
    expect(r.payroll_run_id).not.toBeNull();
    expect(Number((await run(2)).leave_encashment_amount)).toBe(3000);
  });
});

describe('static guard — writers outside payroll touch DRAFT runs only', () => {
  const root = resolve(here, '../modules');
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(root);
  const outside = files.filter(f => !relative(root, f).startsWith('payroll'));

  it('no module outside payroll selects or updates a run merely "not paid"', () => {
    const offenders = [];
    for (const f of outside) {
      const s = readFileSync(f, 'utf8');
      if (!s.includes('payroll_runs')) continue;
      if (/payroll_runs[\s\S]{0,400}?status\s*(!=|<>)\s*'paid'/.test(s) || /payroll_runs[\s\S]{0,400}?status\s+NOT\s+IN\s*\(\s*'paid'/i.test(s)) offenders.push(relative(root, f));
    }
    expect(offenders).toEqual([]);
  });

  it('every UPDATE of payroll_runs outside payroll is restricted to draft statuses (or to an id selected that way)', () => {
    const offenders = [];
    for (const f of outside) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/UPDATE\s+payroll_runs[\s\S]*?(`|'\))/g)) {
        const stmt = m[0];
        if (/status IN \('draft', 'pending'\)/.test(stmt)) continue;
        if (/WHERE id = \$\d/.test(stmt) && /FROM payroll_runs[\s\S]{0,200}?status IN \('draft', 'pending'\)/.test(s)) continue;
        offenders.push(`${relative(root, f)}: ${stmt.slice(0, 80).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
