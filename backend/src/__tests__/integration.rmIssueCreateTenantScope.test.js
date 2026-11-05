/**
 * integration.rmIssueCreateTenantScope.test.js — Stage 2 of the raw-material
 * issue tenant-isolation fix: POST /inventory/rm-issues.
 *
 * createIssue() checked neither parent: a company-A caller could issue from
 * company B's warehouse and B's items, decrementing B's stock. It also never
 * wrote rm_issues.company_id or stock_ledger.company_id, and it let a line's own
 * issue_id override the new issue's, attaching that line to any issue.
 *
 * Ownership rule (assertParentsInCompany, advancedInventory.repository.js): the
 * warehouse and every item belong to the issue's company. Items are never shared
 * — only item_categories allow a NULL company — so a NULL-company item is refused.
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

const TAG = 'ZZRMCRT';

function appWith({ scope, companyId = null, roles = ['admin'] }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000006, id: 2000000006, company_id: companyId, roles, role: roles[0] };
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
  await pool.query(`DELETE FROM rm_issues WHERE purpose LIKE $1 OR warehouse_id IN ${whs}`, [`${TAG}%`]);   // lines cascade
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM warehouses WHERE warehouse_name LIKE $1`, [`${TAG}%`]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function makeWarehouse(key, companyId) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`,
    [`${TAG} ${key}`, companyId]);
  ids[key] = w.id;
}
async function makeItem(key, companyId) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', 1, 10, true) RETURNING id`, [`${TAG}-${key}`, companyId]);
  ids[key] = i.id;
}
async function receive(itemKey, whKey, companyId, qty) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, company_id, transaction_type, quantity_in, quantity_out,
                               balance_qty, rate, value, transaction_date, remarks)
     VALUES ($1, $2, $3, 'IN', $4::numeric, 0, $4::numeric, 10, $4::numeric * 10, CURRENT_DATE, $5)`,
    [ids[itemKey], ids[whKey], companyId, qty, TAG]);
}

// Everything our fixtures could have written, so "nothing was written" is a
// before/after comparison rather than an absence of one particular row.
async function footprint() {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM rm_issues WHERE purpose LIKE $1)                                AS issues,
            (SELECT COUNT(*)::int FROM rm_issue_items rii JOIN rm_issues ri ON ri.id = rii.issue_id
              WHERE ri.purpose LIKE $1)                                                               AS lines,
            (SELECT COUNT(*)::int FROM stock_ledger WHERE reference_type = 'rm_issue'
                AND item_id IN (SELECT id FROM inventory_items WHERE item_code LIKE $1))              AS ledger`,
    [`${TAG}%`]);
  return r;
}

const body = (whKey, lines, extra = {}) => ({
  warehouse_id: ids[whKey],
  // No department_id: since Stage 3 it must be a real master_departments id,
  // and this suite is about warehouse/item ownership (Stage 3 has its own).
  issue_date: new Date().toISOString().slice(0, 10),
  purpose: `${TAG} ${extra.purpose ?? 'issue'}`,
  items: lines.map(([itemKey, quantity, more = {}]) => ({ item_id: ids[itemKey], quantity, rate: 10, ...more })),
  ...extra,
});

beforeAll(async () => {
  await sweep();
  for (const s of ['A', 'B']) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    await makeWarehouse(`wh${s}`, c.id);
    await makeItem(`item${s}`, c.id);
    await makeItem(`item${s}2`, c.id);
  }
  await makeWarehouse('whNull', null);
  await makeItem('itemNull', null);
  await receive('itemA', 'whA', ids.coA, 50);
  await receive('itemA2', 'whA', ids.coA, 3);
  await receive('itemB', 'whB', ids.coB, 50);
  await receive('itemB', 'whA', ids.coA, 50);      // B's item physically sitting in A's warehouse (drift)
  await receive('itemNull', 'whA', null, 50);
  await receive('itemNull', 'whNull', null, 50);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('valid creation is attributed to the company', () => {
  it('company A issues its own item from its own warehouse: 201, issue and ledger carry company A', async () => {
    const res = await request(asCompany(ids.coA)).post('/inventory/rm-issues').send(body('whA', [['itemA', 4]], { purpose: 'valid A' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.company_id).toBe(ids.coA);
    expect(res.body.warehouse_name).toBe(`${TAG} whA`);
    ids.issueA = res.body.id;

    const { rows: [ri] } = await pool.query(`SELECT company_id, issue_number FROM rm_issues WHERE id = $1`, [ids.issueA]);
    expect(ri.company_id).toBe(ids.coA);
    expect(ri.issue_number).toMatch(/^RMI\d+$/);

    const { rows: ledger } = await pool.query(
      `SELECT company_id, item_id, warehouse_id, quantity_out::float AS out, transaction_type
         FROM stock_ledger WHERE reference_type = 'rm_issue' AND reference_id = $1`, [ids.issueA]);
    expect(ledger).toEqual([{ company_id: ids.coA, item_id: ids.itemA, warehouse_id: ids.whA, out: 4, transaction_type: 'consumption' }]);
  });

  it('the created issue reads back for A and is a 404 for B', async () => {
    expect((await request(asCompany(ids.coA)).get(`/inventory/rm-issues/${ids.issueA}`)).status).toBe(200);
    expect((await request(asCompany(ids.coB)).get(`/inventory/rm-issues/${ids.issueA}`)).status).toBe(404);
  });

  it('a company_id in the body cannot redirect the issue to another company', async () => {
    const res = await request(asCompany(ids.coA)).post('/inventory/rm-issues')
      .send(body('whA', [['itemA', 1]], { purpose: 'body company', company_id: ids.coB }));
    expect(res.status).toBe(201);
    const { rows: [ri] } = await pool.query(`SELECT company_id FROM rm_issues WHERE id = $1`, [res.body.id]);
    expect(ri.company_id).toBe(ids.coA);
  });

  it('a line\'s own issue_id cannot attach it to another issue', async () => {
    const { rows: [bIssue] } = await pool.query(
      `INSERT INTO rm_issues (issue_number, issue_date, warehouse_id, purpose, company_id)
       VALUES ($1, CURRENT_DATE, $2, $3, $4) RETURNING id`, [`${TAG}-B-EXISTING`, ids.whB, `${TAG} existing B`, ids.coB]);
    const res = await request(asCompany(ids.coA)).post('/inventory/rm-issues')
      .send(body('whA', [['itemA', 1, { issue_id: bIssue.id }]], { purpose: 'line hijack' }));
    expect(res.status).toBe(201);
    const { rows: onB } = await pool.query(`SELECT id FROM rm_issue_items WHERE issue_id = $1`, [bIssue.id]);
    expect(onB).toHaveLength(0);
    const { rows: onNew } = await pool.query(`SELECT item_id FROM rm_issue_items WHERE issue_id = $1`, [res.body.id]);
    expect(onNew.map(r => r.item_id)).toEqual([ids.itemA]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cross-company parents are refused and nothing is written', () => {
  const refused = async (app, payload, status, message) => {
    const before = await footprint();
    const { rows: [{ v: balBefore }] } = await pool.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float AS v FROM stock_ledger WHERE item_id = ANY($1)`,
      [payload.items.map(i => i.item_id)]);
    const res = await request(app).post('/inventory/rm-issues').send(payload);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (message) expect(res.body.error).toMatch(message);
    expect(await footprint()).toEqual(before);
    const { rows: [{ v: balAfter }] } = await pool.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float AS v FROM stock_ledger WHERE item_id = ANY($1)`,
      [payload.items.map(i => i.item_id)]);
    expect(balAfter).toBe(balBefore);
  };

  it('A issuing from B\'s warehouse: 404, as if the warehouse did not exist', async () => {
    await refused(asCompany(ids.coA), body('whB', [['itemB', 1]]), 404, new RegExp(`Warehouse ${ids.whB} not found`));
  });

  it('A issuing B\'s item from A\'s own warehouse: 404, even though the stock is physically there', async () => {
    await refused(asCompany(ids.coA), body('whA', [['itemB', 1]]), 404, new RegExp(`Item ${ids.itemB} not found`));
  });

  it('one foreign line refuses the whole issue', async () => {
    await refused(asCompany(ids.coA), body('whA', [['itemA', 1], ['itemB', 1]]), 404, /not found/);
  });

  it('a NULL-company item is not shared: refused for a company caller', async () => {
    await refused(asCompany(ids.coA), body('whA', [['itemNull', 1]]), 404, /not found/);
  });

  it('B issuing from A\'s warehouse: 404', async () => {
    await refused(asCompany(ids.coB), body('whA', [['itemA', 1]]), 404, /Warehouse .* not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('super admin creation takes the warehouse\'s company', () => {
  it('a super admin issuing from B\'s warehouse files the issue and ledger under B', async () => {
    const res = await request(asSuperAdmin()).post('/inventory/rm-issues').send(body('whB', [['itemB', 2]], { purpose: 'super B' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.company_id).toBe(ids.coB);
    const { rows: ledger } = await pool.query(
      `SELECT company_id FROM stock_ledger WHERE reference_type = 'rm_issue' AND reference_id = $1`, [res.body.id]);
    expect(ledger.map(r => r.company_id)).toEqual([ids.coB]);
  });

  it('a super admin still cannot mix companies: B\'s item from A\'s warehouse is refused', async () => {
    const before = await footprint();
    const res = await request(asSuperAdmin()).post('/inventory/rm-issues').send(body('whA', [['itemB', 1]]));
    expect(res.status).toBe(404);
    expect(await footprint()).toEqual(before);
  });

  it('a warehouse with no company cannot be attributed: 422', async () => {
    const before = await footprint();
    const res = await request(asSuperAdmin()).post('/inventory/rm-issues').send(body('whNull', [['itemNull', 1]]));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no company/);
    expect(await footprint()).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rollback: a failure part-way leaves no issue, no lines and no ledger', () => {
  it('insufficient stock on the second line rolls back the first line\'s consumption too', async () => {
    const before = await footprint();
    const { rows: [{ v: balBefore }] } = await pool.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float AS v FROM stock_ledger WHERE item_id = $1`, [ids.itemA]);
    // itemA has plenty; itemA2 has 3 on hand, so asking for 999 fails AFTER
    // the issue row, line 1 and line 1's ledger entry were written.
    const res = await request(asCompany(ids.coA)).post('/inventory/rm-issues')
      .send(body('whA', [['itemA', 2], ['itemA2', 999]], { purpose: 'rollback' }));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Insufficient/);
    expect(await footprint()).toEqual(before);
    const { rows: [{ v: balAfter }] } = await pool.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float AS v FROM stock_ledger WHERE item_id = $1`, [ids.itemA]);
    expect(balAfter).toBe(balBefore);
  });

  it('an issue with no lines is refused before anything is written', async () => {
    const before = await footprint();
    const res = await request(asCompany(ids.coA)).post('/inventory/rm-issues').send(body('whA', []));
    expect(res.status).toBe(422);
    expect(await footprint()).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('scope and permission gates', () => {
  it('an ordinary user with no company is refused, nothing written', async () => {
    const before = await footprint();
    for (const scope of [null, { company_id: null, branch_id: null }]) {
      const res = await request(appWith({ scope })).post('/inventory/rm-issues').send(body('whA', [['itemA', 1]]));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_COMPANY_SCOPE');
    }
    expect(await footprint()).toEqual(before);
  });

  it('a role without inventory:add is refused', async () => {
    const before = await footprint();
    const app = appWith({ scope: { company_id: ids.coA }, companyId: ids.coA, roles: ['zz_no_such_role'] });
    const res = await request(app).post('/inventory/rm-issues').send(body('whA', [['itemA', 1]]));
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('NO_COMPANY_SCOPE');
    expect(await footprint()).toEqual(before);
  });
});
