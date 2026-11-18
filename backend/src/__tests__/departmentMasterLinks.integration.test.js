/**
 * Department master ↔ department heads (§271).
 *
 * Employees belong to a department by NAME (employees.department text) and the
 * head mapping points at master_departments by id. So:
 *   - renaming a department in Master Data carries the new name onto the
 *     records holding the old one, in one transaction — the head keeps their
 *     employees (manager access, Department Heads count);
 *   - a RETIRED department gives its head no role: no manager access, not the
 *     gate-pass approver (falls to the reporting manager / HR). It is still
 *     listed on Department Heads, flagged, while a head is mapped to it;
 *   - a permanent delete of a department with head history is refused with a
 *     clear message (the FK would otherwise surface as a database error).
 *
 * master_departments is a GLOBAL table; this suite adds uniquely named rows and
 * deletes them in afterAll. Its company is isolated (createIsolatedCompany).
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
const { default: request } = await import('supertest');
const { buildApp } = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { default: masterRouter } = await import('../modules/master/master.routes.js');
const { managesEmployee } = await import('../shared/employeeAccess.js');
const { GP_APPROVER_JOIN } = await import('../shared/gatePassApprover.js');
const { listDepartmentHeads } = await import('../probation/departmentHeads.service.js');

const PREFIX = 'ZZDML';
const stamp = Date.now().toString(36).toUpperCase();
const NAMES = { main: `ZZ Dml ${stamp}`, renamed: `ZZ Dml Renamed ${stamp}`, history: `ZZ Dml Hist ${stamp}`, empty: `ZZ Dml Empty ${stamp}` };
let co; let app; const emp = {}; const dept = {};

async function cleanup(cid) {
  await pool.query(`DELETE FROM department_heads WHERE company_id = $1`, [cid]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [cid]);
  await dropIsolatedCompany(pool, cid);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) await cleanup(id);
  await pool.query(`DELETE FROM master_departments WHERE name LIKE 'ZZ Dml %'`);
  co = await createIsolatedCompany(pool, PREFIX);
  for (const k of ['main', 'history', 'empty']) {
    dept[k] = (await pool.query(`INSERT INTO master_departments (name) VALUES ($1) RETURNING id`, [NAMES[k]])).rows[0].id;
  }
  const mk = async (code, depName, mgr = null) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date, reporting_manager_id)
     VALUES ($1,$2,'ZZ',$2,$3,$4,'Engineer','Active','2026-01-01',$5) RETURNING id`,
    [co.companyId, code, `${code.toLowerCase()}@${co.code.toLowerCase()}.invalid`, depName, mgr])).rows[0].id;
  emp.head = await mk('EMP907101', NAMES.main);
  emp.boss = await mk('EMP907102', 'HR');
  emp.member = await mk('EMP907103', NAMES.main, emp.boss);
  await pool.query(`INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1,$2,$3)`,
    [co.companyId, dept.main, emp.head]);
  // a department whose only trace is an ENDED head assignment
  await pool.query(
    `INSERT INTO department_heads (company_id, department_id, head_employee_id, ended_at, ended_by_user_id, end_reason)
     VALUES ($1,$2,$3,NOW(),$4,'test')`, [co.companyId, dept.history, emp.head, co.adminId]);
  app = buildApp(['/api/master', verifyToken, masterRouter]);
}, 60000);

afterAll(async () => {
  if (co) await cleanup(co.companyId);
  await pool.query(`DELETE FROM master_departments WHERE name LIKE 'ZZ Dml %'`);
});

const auth = () => ({ Authorization: `Bearer ${co.token()}` });
const deptOfMember = async () => (await pool.query(`SELECT department FROM employees WHERE id = $1`, [emp.member])).rows[0].department;
const approverFor = async (employeeId) => (await pool.query(
  `SELECT appr.approver_kind, appr.approver_employee_id
     FROM (SELECT $1::int AS employee_id, $2::int AS company_id, NULL::int AS visitor_id) gp ${GP_APPROVER_JOIN}`,   // visitor_id: the §273 host branch
  [employeeId, co.companyId])).rows[0];
const listed = async (id) => (await listDepartmentHeads(co.companyId)).departments.find((d) => d.department_id === id);

describe('rename in Master Data', () => {
  it('before: the head manages the member and is the gate-pass approver', async () => {
    expect(await managesEmployee({ managerEmployeeId: emp.head, employeeId: emp.member, companyId: co.companyId })).toBe(true);
    expect(await approverFor(emp.member)).toMatchObject({ approver_kind: 'department_head', approver_employee_id: emp.head });
  });

  it('carries the new name onto the employees and keeps the head connected', async () => {
    const res = await request(app).put(`/api/master/departments/${dept.main}`).set(auth()).send({ name: NAMES.renamed });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, renamed_from: NAMES.main });
    expect(res.body.records_updated).toBeGreaterThanOrEqual(2);
    expect(res.body.records).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'employees', count: 2 })]));
    expect(await deptOfMember()).toBe(NAMES.renamed);

    expect(await managesEmployee({ managerEmployeeId: emp.head, employeeId: emp.member, companyId: co.companyId })).toBe(true);
    expect(await approverFor(emp.member)).toMatchObject({ approver_kind: 'department_head' });
    expect(await listed(dept.main)).toMatchObject({ department: NAMES.renamed, department_active: true, employee_count: 2 });
  });
});

describe('retire in Master Data', () => {
  it('a retired department gives its head no role, and stays listed (flagged) while mapped', async () => {
    const res = await request(app).delete(`/api/master/departments/${dept.main}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('deactivated');

    expect(await managesEmployee({ managerEmployeeId: emp.head, employeeId: emp.member, companyId: co.companyId })).toBe(false);
    expect(await approverFor(emp.member)).toMatchObject({ approver_kind: 'reporting_manager', approver_employee_id: emp.boss });
    expect(await listed(dept.main)).toMatchObject({ department_active: false, head: expect.objectContaining({ employee_id: emp.head }) });

    // and comes back with reactivation
    await pool.query(`UPDATE master_departments SET is_active = true WHERE id = $1`, [dept.main]);
    expect(await managesEmployee({ managerEmployeeId: emp.head, employeeId: emp.member, companyId: co.companyId })).toBe(true);
  });
});

describe('permanent delete', () => {
  it('is refused with a clear message when the department has head history', async () => {
    const res = await request(app).delete(`/api/master/departments/${dept.history}?hard=1`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/department-head history/);
    expect((await pool.query(`SELECT 1 FROM master_departments WHERE id = $1`, [dept.history])).rows).toHaveLength(1);
  });

  it('still deletes a department nothing uses', async () => {
    const res = await request(app).delete(`/api/master/departments/${dept.empty}?hard=1`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('permanently');
  });
});
