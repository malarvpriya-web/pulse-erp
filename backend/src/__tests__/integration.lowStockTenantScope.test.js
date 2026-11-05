/**
 * integration.lowStockTenantScope.test.js — audit defect D4
 * (INVENTORY_REPLENISHMENT_AUDIT.md), against the REAL database and router.
 *
 * `stockLedgerRepo.getLowStockItems()` CROSS JOINed every item against every
 * warehouse and filtered on the item's company only. Company A's items were
 * therefore paired with company B's warehouses; no ledger row can join such a
 * pair, so its balance is 0 and it always counts as "low". Measured on the dev
 * database: 236 rows for company 1, 168 of them other tenants' warehouses, all
 * feeding the dashboard Low Stock KPI.
 *
 * Fixtures are two throwaway companies (TAG prefix), each with its own item and
 * warehouse, swept before and after. Run with `npm run test:db`, which points at
 * the isolated pulse_e2e database.
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
const { default: repo }      = await import('../modules/inventory/repositories/stockLedger.repository.js');

const TAG = 'ZZLOWSTK';

function appAs(companyId, roles = ['admin']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000001, id: 2000000001, company_id: companyId, roles, role: roles[0] };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/inventory', invRouter);
  return app;
}

const ids = { companyA: null, companyB: null };

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;
  const ourItems = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM stock_ledger    WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_items WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM warehouses      WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM companies       WHERE id = ANY($1)`, [co]);
}

async function makeCompany(s) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
  // Two warehouses each, so a company's own pairs are not a single row and a
  // leak is not hidden by a coincidental count of 1.
  for (const w of ['W1', 'W2']) {
    await pool.query(
      `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2)`,
      [`${TAG} ${s} ${w}`, c.id]);
  }
  return c.id;
}

async function makeItem(companyId, code, reorder) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', $3, 10, true) RETURNING id`, [code, companyId, reorder]);
  return i.id;
}

async function receive(companyId, itemId, warehouseName, qty) {
  const { rows: [w] } = await pool.query(`SELECT id FROM warehouses WHERE warehouse_name = $1`, [warehouseName]);
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, company_id, transaction_type, quantity_in, quantity_out,
                               balance_qty, rate, value, transaction_date, remarks)
     VALUES ($1, $2, $3, 'IN', $4::numeric, 0, $4::numeric, 10, $4::numeric * 10, CURRENT_DATE, $5)`,
    [itemId, w.id, companyId, qty, TAG]);
}

beforeAll(async () => {
  await sweep();
  ids.companyA = await makeCompany('A');
  ids.companyB = await makeCompany('B');
  // A: one item low everywhere, one item healthy in W1 only (still low in W2).
  ids.lowA     = await makeItem(ids.companyA, `${TAG}-A-LOW`, 10);
  ids.okA      = await makeItem(ids.companyA, `${TAG}-A-OK`, 10);
  await receive(ids.companyA, ids.okA, `${TAG} A W1`, 50);
  // B: one low item. Its warehouse names are what used to leak to A.
  ids.lowB     = await makeItem(ids.companyB, `${TAG}-B-LOW`, 10);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

const ownWarehouses = s => [`${TAG} ${s} W1`, `${TAG} ${s} W2`];

describe('D4 · getLowStockItems pairs items only with their own company\'s warehouses', () => {
  it('company A sees exactly its own item × warehouse rows', async () => {
    const rows = await repo.getLowStockItems(ids.companyA);
    expect(rows.map(r => `${r.item_code}@${r.warehouse_name}`).sort()).toEqual([
      `${TAG}-A-LOW@${TAG} A W1`,
      `${TAG}-A-LOW@${TAG} A W2`,
      `${TAG}-A-OK@${TAG} A W2`,          // stocked in W1, so W1 is not low
    ]);
    for (const r of rows) expect(ownWarehouses('A')).toContain(r.warehouse_name);
  });

  it('company B\'s items and warehouses never appear for company A, and vice versa', async () => {
    const a = await repo.getLowStockItems(ids.companyA);
    const b = await repo.getLowStockItems(ids.companyB);
    expect(a.some(r => ownWarehouses('B').includes(r.warehouse_name))).toBe(false);
    expect(a.some(r => r.id === ids.lowB)).toBe(false);
    expect(b.some(r => ownWarehouses('A').includes(r.warehouse_name))).toBe(false);
    expect(b.map(r => r.warehouse_name).sort()).toEqual(ownWarehouses('B'));
  });

  it('no row anywhere pairs an item with another company\'s warehouse — even with a global scope', async () => {
    const rows = await repo.getLowStockItems(null);
    const ours = rows.filter(r => String(r.item_code).startsWith(TAG));
    // Unscoped, A and B items each see only their own two warehouses: 3 + 2.
    expect(ours).toHaveLength(5);
    for (const r of ours) {
      const side = r.item_code.startsWith(`${TAG}-A`) ? 'A' : 'B';
      expect(ownWarehouses(side)).toContain(r.warehouse_name);
    }
  });
});

describe('D4 · the dashboard KPI and the low-stock endpoint carry the scoped rows', () => {
  it('GET /inventory/dashboard low_stock_count is company A\'s own count', async () => {
    const res = await request(appAs(ids.companyA)).get('/inventory/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.low_stock_count).toBe(3);
    expect(res.body.low_stock_items).toBe(3);
  });

  it('GET /inventory/dashboard for company B counts only B', async () => {
    const res = await request(appAs(ids.companyB)).get('/inventory/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.low_stock_count).toBe(2);
  });

  it('GET /inventory/stock/low-stock returns no other tenant\'s warehouse names', async () => {
    const res = await request(appAs(ids.companyA)).get('/inventory/stock/low-stock');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    for (const r of res.body) {
      expect(ownWarehouses('A')).toContain(r.warehouse_name);
      expect(String(r.item_code).startsWith(`${TAG}-A`)).toBe(true);
    }
  });

  it('existing company filtering on the other dashboard tiles is unchanged', async () => {
    const res = await request(appAs(ids.companyA)).get('/inventory/dashboard');
    expect(res.body.total_items).toBe(2);
    expect(res.body.total_inventory_value).toBe(500);   // A's 50 units × 10 only
  });

  it('the inventory:view permission still gates both endpoints', async () => {
    const app = appAs(ids.companyA, ['zz_no_such_role']);
    expect((await request(app).get('/inventory/dashboard')).status).toBe(403);
    expect((await request(app).get('/inventory/stock/low-stock')).status).toBe(403);
  });
});
