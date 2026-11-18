/**
 * Employee Asset lifecycle — behaviour added 11 Nov 26, driven over HTTP
 * against the real database in a throwaway company.
 *
 *   · return as 'lost' → status lost (still blocks exit); 'damaged' → damaged
 *   · delete only returned/disposed records, never one a re-issue came from
 *   · edit changes details only — status/holder are refused
 *   · duplicate live asset tag / serial is refused (trimmed, case-insensitive)
 *   · re-issue: returned only, once, linked by reissued_from; history walks the chain
 *   · an employee still holding an asset cannot be deleted
 *   · GET /employees?status=active,probation matches both statuses
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: request } = await import('supertest');
const { buildApp } = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');
const { default: assetRouter } = await import('../modules/hr/employee-assets.routes.js');
const { deleteEmployee, getEmployees } = await import('../employees/employee.service.js');

const PREFIX = 'ZZEAL';
let co; let app; const emp = {};

const cleanup = async (cid) => {
  await pool.query(`UPDATE employee_asset_allocations SET reissued_from = NULL WHERE company_id = $1`, [cid]);
  await pool.query(`DELETE FROM audit_logs WHERE reference_type = 'asset_allocation'
                      AND reference_id IN (SELECT id::text FROM employee_asset_allocations WHERE company_id = $1)`, [cid]);
  await pool.query(`DELETE FROM employee_asset_allocations WHERE company_id = $1`, [cid]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [cid]);
  await dropIsolatedCompany(pool, cid);
};

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) await cleanup(id);
  co = await createIsolatedCompany(pool, PREFIX);
  const mk = async (code, status) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date)
     VALUES ($1,$2,'ZZ',$2,$3,'HR','Manager',$4,'2026-01-01') RETURNING id`,
    [co.companyId, code, `${code.toLowerCase()}@${co.code.toLowerCase()}.invalid`, status])).rows[0].id;
  emp.a = await mk('EMP906101', 'Active');
  emp.b = await mk('EMP906102', 'Probation');
  emp.c = await mk('EMP906103', 'Notice');
  app = buildApp(['/api/employee-assets', assetRouter]);
});

afterAll(async () => { if (co) await cleanup(co.companyId); });

const auth = () => ({ Authorization: `Bearer ${co.token()}` });
const post  = (p, b) => request(app).post(`/api/employee-assets${p}`).set(auth()).send(b);
const patch = (p, b) => request(app).patch(`/api/employee-assets${p}`).set(auth()).send(b);
const put   = (p, b) => request(app).put(`/api/employee-assets${p}`).set(auth()).send(b);
const del   = (p)    => request(app).delete(`/api/employee-assets${p}`).set(auth());
const get   = (p)    => request(app).get(`/api/employee-assets${p}`).set(auth());
const allocate = async (body) => {
  const r = await post('', { employee_id: emp.a, asset_type: 'Laptop', asset_name: 'ZZ Laptop', ...body });
  expect(r.status).toBe(201);
  return r.body;
};

describe('employee picker status list', () => {
  it('?status=active,probation returns both statuses and nothing else', async () => {
    const rows = await getEmployees({ status: 'active,probation', company_id: co.companyId, callerRole: ['admin'] });
    expect(rows.map(r => r.id).sort()).toEqual([emp.a, emp.b].sort());
  });
});

describe('return condition sets the status', () => {
  it('lost → lost, damaged → damaged, good → returned', async () => {
    for (const [cond, status] of [['lost', 'lost'], ['damaged', 'damaged'], ['good', 'returned']]) {
      const a = await allocate({});
      const r = await patch(`/${a.id}/return`, { condition_out: cond });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(status);
    }
  });
});

describe('delete guard', () => {
  it('refuses allocated and lost records, allows disposed', async () => {
    const a = await allocate({});
    expect((await del(`/${a.id}`)).status).toBe(400);
    await patch(`/${a.id}/return`, { condition_out: 'lost' });
    expect((await del(`/${a.id}`)).status).toBe(400);
    await patch(`/${a.id}/dispose`, { reason: 'Lost' });
    expect((await del(`/${a.id}`)).status).toBe(200);
  });
});

describe('edit', () => {
  it('refuses status and holder changes', async () => {
    const a = await allocate({});
    expect((await put(`/${a.id}`, { status: 'returned' })).status).toBe(400);
    expect((await put(`/${a.id}`, { employee_id: emp.b })).status).toBe(400);
  });
  it('sets present fields, clears blank optional ones, keeps absent ones', async () => {
    const a = await allocate({ brand: 'Dell', model: 'XPS' });
    const r = await put(`/${a.id}`, { model: '', serial_number: 'ZZ-EDIT-1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ brand: 'Dell', model: null, serial_number: 'ZZ-EDIT-1' });
  });
  it('refuses a blank asset name and an unknown asset type', async () => {
    const a = await allocate({});
    expect((await put(`/${a.id}`, { asset_name: '  ' })).status).toBe(400);
    expect((await put(`/${a.id}`, { asset_type: 'ZZ Spaceship' })).status).toBe(400);
  });
});

describe('duplicate tag / serial', () => {
  it('refuses a second live record with the same tag (trimmed, any case)', async () => {
    await allocate({ asset_tag: 'ZZ-DUP-1' });
    const r = await post('', { employee_id: emp.b, asset_type: 'Laptop', asset_name: 'x', asset_tag: ' zz-dup-1 ' });
    expect(r.status).toBe(409);
  });
  it('allows the number again once the first record is returned', async () => {
    const a = await allocate({ serial_number: 'ZZ-DUP-SN' });
    await patch(`/${a.id}/return`, { condition_out: 'good' });
    const r = await post('', { employee_id: emp.b, asset_type: 'Laptop', asset_name: 'x', serial_number: 'ZZ-DUP-SN' });
    expect(r.status).toBe(201);
  });
  it('refuses an edit that copies another live record\'s serial', async () => {
    await allocate({ serial_number: 'ZZ-DUP-E1' });
    const b = await allocate({ serial_number: 'ZZ-DUP-E2' });
    expect((await put(`/${b.id}`, { serial_number: 'zz-dup-e1' })).status).toBe(409);
  });
});

describe('re-issue and history', () => {
  it('re-issues a returned asset once, links it, and locks the old record', async () => {
    const a = await allocate({ asset_tag: 'ZZ-RE-1' });
    expect((await post(`/${a.id}/reissue`, { employee_id: emp.b })).status).toBe(400);   // still allocated
    await post(`/${a.id}/transfer`, { to_employee_id: emp.c });
    await patch(`/${a.id}/return`, { condition_out: 'fair' });

    const r = await post(`/${a.id}/reissue`, { employee_id: emp.b });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'allocated', employee_id: emp.b, reissued_from: a.id, condition_in: 'fair', asset_tag: 'ZZ-RE-1' });

    expect((await post(`/${a.id}/reissue`, { employee_id: emp.a })).status).toBe(409);   // only once
    expect((await del(`/${a.id}`)).status).toBe(400);                                     // history
    expect((await patch(`/${a.id}/dispose`, { reason: 'Obsolete' })).status).toBe(400);
    expect((await put(`/${a.id}`, { brand: 'HP' })).status).toBe(400);

    const list = await get('');
    expect(list.body.find(x => x.id === a.id).reissued_as).toBe(r.body.id);

    // logAudit is fire-and-forget: wait for the four entries to land.
    let h;
    for (let k = 0; k < 20; k++) {
      h = await get(`/${r.body.id}/history`);
      if (h.body?.events?.length >= 4) break;
      await new Promise(res => setTimeout(res, 100));
    }
    expect(h.status).toBe(200);
    expect(h.body.records.map(x => x.id)).toEqual([a.id, r.body.id]);
    expect(h.body.events.map(e => e.action)).toEqual(['create', 'transfer', 'return', 'reissue']);
  });
});

describe('employee delete guard', () => {
  it('refuses to delete an employee who still holds an asset', async () => {
    const a = await allocate({ employee_id: emp.c });
    await expect(deleteEmployee(emp.c, co.companyId)).rejects.toMatchObject({ status: 409 });
    await patch(`/${a.id}/return`, { condition_out: 'damaged' });   // damaged = handed back
    await expect(deleteEmployee(emp.c, co.companyId)).resolves.toBeUndefined();
  });
});
