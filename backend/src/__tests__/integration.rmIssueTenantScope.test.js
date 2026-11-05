/**
 * integration.rmIssueTenantScope.test.js — Stage 1 of the raw-material issue
 * tenant-isolation fix: the three GET paths.
 *
 *   GET /inventory/rm-issues
 *   GET /inventory/rm-issues/:id
 *   GET /inventory/analytics/consumption-trends
 *
 * None of them filtered by company: any caller with inventory:view listed every
 * tenant's issues, opened any issue by id (items included) and summed every
 * tenant's consumption. An issue belongs to the company of its WAREHOUSE —
 * rm_issues.company_id is never written by create(), so the fixtures leave it
 * NULL exactly as the app does.
 *
 * Throwaway companies under TAG, swept before and after. Run with
 * `npm run test:db` (isolated pulse_e2e database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
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

const { default: pool }      = await import('../config/db.js');
const { default: invRouter } = await import('../modules/inventory/routes/inventory.routes.js');
const { default: repo }      = await import('../modules/inventory/repositories/rmIssue.repository.js');

const TAG = 'ZZRMISS';
const FROM = '2000-01-01';
const TO = '2100-01-01';

// scope is set exactly as verifyToken would: { company_id } for a scoped user,
// { company_id: null, isGlobal: true } for a super admin, null for an ordinary
// user with no company assignment.
function appWith({ scope, companyId = null, roles = ['admin'] }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000005, id: 2000000005, company_id: companyId, roles, role: roles[0] };
    req.scope = scope;
    next();
  });
  app.use('/inventory', invRouter);
  return app;
}
const asCompany = (cid) => appWith({ scope: { company_id: cid }, companyId: cid });
const asSuperAdmin = () => appWith({ scope: { company_id: null, branch_id: null, isGlobal: true }, roles: ['admin', 'super_admin'] });

const ids = {};
const wh = {};

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  await pool.query(`DELETE FROM rm_issues WHERE issue_number LIKE $1`, [`${TAG}%`]);   // items cascade
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM warehouses WHERE warehouse_name LIKE $1`, [`${TAG}%`]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function makeIssue(number, warehouseName, departmentId, lines) {
  // company_id deliberately omitted: rmIssueRepo.create() never writes it.
  const { rows: [ri] } = await pool.query(
    `INSERT INTO rm_issues (issue_number, department_id, issue_date, warehouse_id, purpose)
     VALUES ($1, $2, CURRENT_DATE, $3, $4) RETURNING id`,
    [number, departmentId, warehouseName ? wh[warehouseName] : null, `${TAG} purpose ${number}`]);
  for (const [itemId, qty] of lines) {
    await pool.query(
      `INSERT INTO rm_issue_items (issue_id, item_id, quantity, rate, remarks) VALUES ($1, $2, $3, 10, $4)`,
      [ri.id, itemId, qty, TAG]);
  }
  return ri.id;
}

beforeAll(async () => {
  await sweep();
  for (const s of ['A', 'B']) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    const { rows: [w] } = await pool.query(
      `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`,
      [`${TAG} ${s} W`, c.id]);
    wh[`${TAG} ${s} W`] = w.id;
    const { rows: [i] } = await pool.query(
      `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
       VALUES ($1, $1, $2, 'NOS', 1, 10, true) RETURNING id`, [`${TAG}-${s}`, c.id]);
    ids[`item${s}`] = i.id;
  }
  // A: two issues of its item, 10 + 5 = 15, in departments 901 and 902.
  ids.a1 = await makeIssue(`${TAG}-A1`, `${TAG} A W`, 901, [[ids.itemA, 10]]);
  ids.a2 = await makeIssue(`${TAG}-A2`, `${TAG} A W`, 902, [[ids.itemA, 5]]);
  // B: one issue of its item, 7.
  ids.b1 = await makeIssue(`${TAG}-B1`, `${TAG} B W`, 901, [[ids.itemB, 7]]);
  // An issue whose warehouse has gone (warehouse_id ON DELETE SET NULL): no
  // company can claim it; only the global trends total ever counted it.
  ids.orphan = await makeIssue(`${TAG}-ORPHAN`, null, 901, [[ids.itemA, 100]]);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

const ourIssueIds = rows => rows.filter(r => String(r.issue_number).startsWith(TAG)).map(r => r.id).sort((a, b) => a - b);
const sorted = (...xs) => xs.sort((a, b) => a - b);
const trendFor = (rows, code) => rows.find(r => r.item_code === code);

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /inventory/rm-issues · list is company-scoped', () => {
  it('company A lists only its own issues', async () => {
    const res = await request(asCompany(ids.coA)).get('/inventory/rm-issues');
    expect(res.status).toBe(200);
    expect(ourIssueIds(res.body)).toEqual(sorted(ids.a1, ids.a2));
    expect(res.body.some(r => r.warehouse_name === `${TAG} B W`)).toBe(false);
  });

  it('company B lists only its own issues', async () => {
    const res = await request(asCompany(ids.coB)).get('/inventory/rm-issues');
    expect(res.status).toBe(200);
    expect(ourIssueIds(res.body)).toEqual([ids.b1]);
  });

  it('the department filter still works, within the company', async () => {
    const res = await request(asCompany(ids.coA)).get('/inventory/rm-issues?department_id=901');
    expect(ourIssueIds(res.body)).toEqual([ids.a1]);      // not B's dept-901 issue
  });

  it('a super admin (explicit global scope) lists every company\'s issues', async () => {
    const res = await request(asSuperAdmin()).get('/inventory/rm-issues');
    expect(res.status).toBe(200);
    expect(ourIssueIds(res.body)).toEqual(sorted(ids.a1, ids.a2, ids.b1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /inventory/rm-issues/:id · lookup is company-scoped', () => {
  it('company A opens its own issue, items included', async () => {
    const res = await request(asCompany(ids.coA)).get(`/inventory/rm-issues/${ids.a1}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ids.a1);
    expect(res.body.items.map(i => i.item_code)).toEqual([`${TAG}-A`]);
  });

  it('company A asking for B\'s issue gets 404 and nothing of the issue or its items', async () => {
    const res = await request(asCompany(ids.coA)).get(`/inventory/rm-issues/${ids.b1}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'RM Issue not found' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(`${TAG}-B`);
    expect(text).not.toContain('items');
  });

  it('company B asking for A\'s issue gets 404', async () => {
    const res = await request(asCompany(ids.coB)).get(`/inventory/rm-issues/${ids.a1}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'RM Issue not found' });
  });

  it('a super admin can open any company\'s issue', async () => {
    const res = await request(asSuperAdmin()).get(`/inventory/rm-issues/${ids.b1}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map(i => i.item_code)).toEqual([`${TAG}-B`]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /inventory/analytics/consumption-trends · totals are company-scoped', () => {
  const url = `/inventory/analytics/consumption-trends?start_date=${FROM}&end_date=${TO}`;

  it('company A sums only its own issues', async () => {
    const res = await request(asCompany(ids.coA)).get(url);
    expect(res.status).toBe(200);
    const a = trendFor(res.body, `${TAG}-A`);
    expect(Number(a.total_consumed)).toBe(15);           // 10 + 5; not the warehouse-less 100
    expect(Number(a.issue_count)).toBe(2);
    expect(trendFor(res.body, `${TAG}-B`)).toBeUndefined();
  });

  it('company B sums only its own issues', async () => {
    const res = await request(asCompany(ids.coB)).get(url);
    const b = trendFor(res.body, `${TAG}-B`);
    expect(Number(b.total_consumed)).toBe(7);
    expect(trendFor(res.body, `${TAG}-A`)).toBeUndefined();
  });

  it('a super admin\'s totals are unchanged: every company, warehouse-less issues included', async () => {
    const res = await request(asSuperAdmin()).get(url);
    expect(res.status).toBe(200);
    expect(Number(trendFor(res.body, `${TAG}-A`).total_consumed)).toBe(115);
    expect(Number(trendFor(res.body, `${TAG}-A`).issue_count)).toBe(3);
    expect(Number(trendFor(res.body, `${TAG}-B`).total_consumed)).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('missing company scope fails closed', () => {
  const paths = () => [
    '/inventory/rm-issues',
    `/inventory/rm-issues/${ids.a1}`,
    `/inventory/analytics/consumption-trends?start_date=${FROM}&end_date=${TO}`,
  ];

  it('an ordinary user with no company (verifyToken scope = null) is refused on all three', async () => {
    const app = appWith({ scope: null });
    for (const p of paths()) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(403);
      expect(res.body.code, p).toBe('NO_COMPANY_SCOPE');
    }
  });

  it('a null company without the global flag is refused too — only isGlobal grants all companies', async () => {
    const app = appWith({ scope: { company_id: null, branch_id: null } });
    for (const p of paths()) expect((await request(app).get(p)).status, p).toBe(403);
  });

  it('the repository throws when the scope argument is left out, instead of reading every tenant', async () => {
    await expect(repo.findAll({})).rejects.toThrow(/without a company scope/);
    await expect(repo.findByIdInCompany(ids.a1)).rejects.toThrow(/without a company scope/);
    await expect(repo.getConsumptionTrends(FROM, TO)).rejects.toThrow(/without a company scope/);
    await expect(repo.findAll({}, 'not-a-company')).rejects.toThrow(/invalid company scope/);
  });

  it('repository: explicit company and explicit null behave as the routes rely on', async () => {
    expect(ourIssueIds(await repo.findAll({}, ids.coA))).toEqual(sorted(ids.a1, ids.a2));
    expect(await repo.findByIdInCompany(ids.b1, ids.coA)).toBeUndefined();
    expect((await repo.findByIdInCompany(ids.b1, null)).id).toBe(ids.b1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('permissions are unchanged', () => {
  it('a role without inventory:view is refused on all three, scope or not', async () => {
    const app = appWith({ scope: { company_id: ids.coA }, companyId: ids.coA, roles: ['zz_no_such_role'] });
    for (const p of ['/inventory/rm-issues', `/inventory/rm-issues/${ids.a1}`,
                     `/inventory/analytics/consumption-trends?start_date=${FROM}&end_date=${TO}`]) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(403);
      expect(res.body.code, p).not.toBe('NO_COMPANY_SCOPE');   // refused by the permission gate, first
    }
  });
});
