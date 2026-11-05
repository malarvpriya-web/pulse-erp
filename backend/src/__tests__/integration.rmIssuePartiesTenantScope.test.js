/**
 * integration.rmIssuePartiesTenantScope.test.js — Stage 3 of the raw-material
 * issue tenant-isolation fix: `department_id` and `issued_by` on
 * POST /inventory/rm-issues.
 *
 * Both came straight from the request body and were stored unchecked, so a
 * company-A issue could name company B's employee as its issuer. A bad id
 * reached the INSERT and failed there as a 500 (or, for department_id, which
 * has no foreign key, was stored as-is).
 *
 * Rules reused, not invented:
 *   - issued_by: an employee of the ISSUE's company, not deleted
 *     (exit.routes.js). A NULL-company employee is not shared.
 *   - department_id: a master_departments id. That master is shared (no
 *     company column, migrations 20260929000002 / 20261014000006), so it must
 *     exist and be active — departmentHeads.service / validateMasterValue.
 *   - both stay optional: absent, null and '' store NULL as before.
 *
 * Throwaway rows under TAG, swept before and after. Run with
 * `npm run test:db` (isolated pulse_e2e database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool }      = await import('../config/db.js');
const { default: invRouter } = await import('../modules/inventory/routes/inventory.routes.js');

const TAG = 'ZZRMPTY';

function appWith({ scope, companyId = null, roles = ['admin'] }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000007, id: 2000000007, company_id: companyId, roles, role: roles[0] };
    req.scope = scope;
    next();
  });
  app.use('/inventory', invRouter);
  return app;
}
const asCompany = (cid) => appWith({ scope: { company_id: cid }, companyId: cid });
const asSuperAdmin = () => appWith({ scope: { company_id: null, branch_id: null, isGlobal: true }, roles: ['admin', 'super_admin'] });

const ids = {};

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  const items = `(SELECT id FROM inventory_items WHERE item_code LIKE $1)`;
  const whs = `(SELECT id FROM warehouses WHERE warehouse_name LIKE $1)`;
  await pool.query(`DELETE FROM stock_ledger WHERE item_id IN ${items} OR warehouse_id IN ${whs}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM rm_issues WHERE purpose LIKE $1 OR warehouse_id IN ${whs}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM warehouses WHERE warehouse_name LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM employees WHERE first_name LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM master_departments WHERE name LIKE $1`, [`${TAG}%`]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function makeEmployee(key, companyId, { deleted = false } = {}) {
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status, joining_date, deleted_at)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Rm', $2, 'Active', '2020-01-01', $3) RETURNING id`,
    [`${TAG} ${key}`, companyId, deleted ? new Date() : null]);
  ids[key] = e.id;
}

async function footprint() {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM rm_issues WHERE purpose LIKE $1) AS issues,
            (SELECT COUNT(*)::int FROM rm_issue_items rii JOIN rm_issues ri ON ri.id = rii.issue_id
              WHERE ri.purpose LIKE $1) AS lines,
            (SELECT COUNT(*)::int FROM stock_ledger WHERE reference_type = 'rm_issue'
                AND item_id IN (SELECT id FROM inventory_items WHERE item_code LIKE $1)) AS ledger,
            (SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float FROM stock_ledger
              WHERE item_id IN (SELECT id FROM inventory_items WHERE item_code LIKE $1)) AS stock`,
    [`${TAG}%`]);
  return r;
}

// The request body. `parties` is spread last, so a test can omit a field
// entirely ({}), send null, or send any raw value.
const body = (s, parties = {}, purpose = 'issue') => ({
  warehouse_id: ids[`wh${s}`],
  issue_date: new Date().toISOString().slice(0, 10),
  purpose: `${TAG} ${purpose}`,
  items: [{ item_id: ids[`item${s}`], quantity: 1, rate: 10 }],
  ...parties,
});
const post = (app, payload) => request(app).post('/inventory/rm-issues').send(payload);
const stored = async (id) =>
  (await pool.query(`SELECT department_id, issued_by, company_id FROM rm_issues WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  await sweep();
  for (const s of ['A', 'B']) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    const { rows: [w] } = await pool.query(
      `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [`${TAG} ${s} W`, c.id]);
    ids[`wh${s}`] = w.id;
    const { rows: [i] } = await pool.query(
      `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
       VALUES ($1, $1, $2, 'NOS', 1, 10, true) RETURNING id`, [`${TAG}-${s}`, c.id]);
    ids[`item${s}`] = i.id;
    await pool.query(
      `INSERT INTO stock_ledger (item_id, warehouse_id, company_id, transaction_type, quantity_in, quantity_out,
                                 balance_qty, rate, value, transaction_date, remarks)
       VALUES ($1, $2, $3, 'IN', 100, 0, 100, 10, 1000, CURRENT_DATE, $4)`, [i.id, w.id, c.id, TAG]);
    await makeEmployee(`emp${s}`, c.id);
  }
  await makeEmployee('empAdeleted', ids.coA, { deleted: true });
  await makeEmployee('empNull', null);
  const { rows: [d1] } = await pool.query(
    `INSERT INTO master_departments (name, is_active) VALUES ($1, true) RETURNING id`, [`${TAG} Stores`]);
  const { rows: [d2] } = await pool.query(
    `INSERT INTO master_departments (name, is_active) VALUES ($1, false) RETURNING id`, [`${TAG} Retired`]);
  ids.dept = d1.id;
  ids.deptInactive = d2.id;
  const { rows: [{ m }] } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM employees`);
  ids.noSuchEmployee = Number(m) + 100000;
  const { rows: [{ d }] } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS d FROM master_departments`);
  ids.noSuchDept = Number(d) + 100000;
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// Every refusal must leave no issue, no line, no ledger row and the same stock.
async function refused(app, payload, status, message) {
  const before = await footprint();
  const res = await post(app, payload);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  if (message) expect(res.body.error).toMatch(message);
  expect(await footprint()).toEqual(before);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('valid department and issuer are stored', () => {
  it('company A with its own employee and an active department: 201, both stored', async () => {
    const res = await post(asCompany(ids.coA), body('A', { department_id: ids.dept, issued_by: ids.empA }, 'valid'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stored(res.body.id)).toEqual({ department_id: ids.dept, issued_by: ids.empA, company_id: ids.coA });
  });

  it('ids sent as numeric strings are accepted and stored as numbers', async () => {
    const res = await post(asCompany(ids.coA), body('A', { department_id: String(ids.dept), issued_by: String(ids.empA) }, 'strings'));
    expect(res.status).toBe(201);
    expect(await stored(res.body.id)).toMatchObject({ department_id: ids.dept, issued_by: ids.empA });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NULL and missing values stay allowed, as before', () => {
  for (const [label, parties] of [
    ['both omitted', {}],
    ['both null', { department_id: null, issued_by: null }],
    ['both empty strings', { department_id: '', issued_by: '' }],
  ]) {
    it(`${label}: 201 with NULL stored`, async () => {
      const res = await post(asCompany(ids.coA), body('A', parties, `nulls ${label}`));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await stored(res.body.id)).toMatchObject({ department_id: null, issued_by: null });
    });
  }

  it('one given, one omitted: only the given one is checked and stored', async () => {
    const res = await post(asCompany(ids.coA), body('A', { issued_by: ids.empA }, 'issuer only'));
    expect(res.status).toBe(201);
    expect(await stored(res.body.id)).toMatchObject({ department_id: null, issued_by: ids.empA });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issued_by from another company, or no usable employee, is refused before any write', () => {
  it('company A naming company B\'s employee: 404', async () => {
    await refused(asCompany(ids.coA), body('A', { issued_by: ids.empB }), 404, new RegExp(`Employee ${ids.empB} not found`));
  });

  it('company B naming company A\'s employee: 404', async () => {
    await refused(asCompany(ids.coB), body('B', { issued_by: ids.empA }), 404, /Employee .* not found/);
  });

  it('a deleted employee of the same company: 404', async () => {
    await refused(asCompany(ids.coA), body('A', { issued_by: ids.empAdeleted }), 404, /not found/);
  });

  it('a NULL-company employee is not shared: 404', async () => {
    await refused(asCompany(ids.coA), body('A', { issued_by: ids.empNull }), 404, /not found/);
  });

  it('an employee id that does not exist: 404, not a foreign-key 500', async () => {
    await refused(asCompany(ids.coA), body('A', { issued_by: ids.noSuchEmployee }), 404, /not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('department_id must be a real, active master department', () => {
  it('a department id that does not exist: 404 (there is no foreign key to stop it)', async () => {
    await refused(asCompany(ids.coA), body('A', { department_id: ids.noSuchDept }), 404, /Department .* not found/);
  });

  it('an inactive department: 422', async () => {
    await refused(asCompany(ids.coA), body('A', { department_id: ids.deptInactive }), 422, /inactive/);
  });

  it('the shared department is usable by either company', async () => {
    const res = await post(asCompany(ids.coB), body('B', { department_id: ids.dept }, 'B shared dept'));
    expect(res.status).toBe(201);
    expect(await stored(res.body.id)).toMatchObject({ department_id: ids.dept, company_id: ids.coB });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('malformed ids are refused before any write', () => {
  for (const bad of ['abc', -1, 0, 1.5, '12abc', '1e3', true, 99999999999]) {
    it(`issued_by = ${JSON.stringify(bad)}: 422`, async () => {
      await refused(asCompany(ids.coA), body('A', { issued_by: bad }), 422, /issued_by must be a positive whole number/);
    });
    it(`department_id = ${JSON.stringify(bad)}: 422`, async () => {
      await refused(asCompany(ids.coA), body('A', { department_id: bad }), 422, /department_id must be a positive whole number/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('super admin: the issuer must belong to the warehouse\'s company', () => {
  it('B\'s warehouse with B\'s employee: 201, filed under B', async () => {
    const res = await post(asSuperAdmin(), body('B', { department_id: ids.dept, issued_by: ids.empB }, 'super B'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stored(res.body.id)).toEqual({ department_id: ids.dept, issued_by: ids.empB, company_id: ids.coB });
  });

  it('B\'s warehouse with A\'s employee: 404 — global scope does not mix companies', async () => {
    await refused(asSuperAdmin(), body('B', { issued_by: ids.empA }), 404, /Employee .* not found/);
  });

  it('a super admin also gets 404 for a NULL-company employee', async () => {
    await refused(asSuperAdmin(), body('B', { issued_by: ids.empNull }), 404, /not found/);
  });
});
