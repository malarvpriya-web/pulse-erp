/**
 * integration.stockSummaryTenantScope.test.js — the second half of audit defect
 * D4 (INVENTORY_REPLENISHMENT_AUDIT.md): `stockLedgerRepo.getStockSummary()`.
 *
 * Same CROSS JOIN as getLowStockItems, company filter on the item only. Its
 * HAVING balance > 0 drops the empty cross-tenant pairs, so the leak needs a
 * ledger row that places company A's item in company B's warehouse — drifted
 * data, but exactly what the query must not turn into "A's stock at B's
 * warehouse". The fixture plants one such row on purpose.
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
const { default: repo }      = await import('../modules/inventory/repositories/stockLedger.repository.js');

const TAG = 'ZZSTKSUM';

function appAs(companyId, roles = ['admin']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000002, id: 2000000002, company_id: companyId, roles, role: roles[0] };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/inventory', invRouter);
  return app;
}

const ids = {};
const wh = {};   // warehouse_name -> id

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  const ourItems = `(SELECT id FROM inventory_items WHERE item_code LIKE $1)`;
  const ourWh    = `(SELECT id FROM warehouses WHERE warehouse_name LIKE $1)`;
  await pool.query(`DELETE FROM stock_ledger WHERE item_id IN ${ourItems} OR warehouse_id IN ${ourWh}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM warehouses WHERE warehouse_name LIKE $1`, [`${TAG}%`]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function makeWarehouse(name, companyId) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [name, companyId]);
  wh[name] = w.id;
}

async function makeItem(code, companyId) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', 5, 10, true) RETURNING id`, [code, companyId]);
  return i.id;
}

async function post(itemId, warehouseName, companyId, qtyIn, qtyOut, rate) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, company_id, transaction_type, quantity_in, quantity_out,
                               balance_qty, rate, value, transaction_date, remarks)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $5::numeric - $6::numeric, $7::numeric,
             ($5::numeric - $6::numeric) * $7::numeric, CURRENT_DATE, $8)`,
    [itemId, wh[warehouseName], companyId, qtyIn > 0 ? 'IN' : 'OUT', qtyIn, qtyOut, rate, TAG]);
}

const SHAPE = ['id', 'item_code', 'item_name', 'unit_of_measure', 'reorder_level',
               'warehouse_id', 'warehouse_name', 'balance', 'avg_rate'];
const ours = rows => rows.filter(r => String(r.item_code).startsWith(TAG));
const keyOf = r => `${r.item_code}@${r.warehouse_name}`;

beforeAll(async () => {
  await sweep();
  for (const s of ['A', 'B']) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    await makeWarehouse(`${TAG} ${s} W1`, c.id);
    await makeWarehouse(`${TAG} ${s} W2`, c.id);
  }
  ids.itemA = await makeItem(`${TAG}-A`, ids.coA);
  ids.itemB = await makeItem(`${TAG}-B`, ids.coB);

  // A's real stock: W1 50 in @10, 5 out @10 -> 45; W2 20 in @20 -> 20.
  await post(ids.itemA, `${TAG} A W1`, ids.coA, 50, 0, 10);
  await post(ids.itemA, `${TAG} A W1`, ids.coA, 0, 5, 10);
  await post(ids.itemA, `${TAG} A W2`, ids.coA, 20, 0, 20);
  // B's real stock: W1 30 @15.
  await post(ids.itemB, `${TAG} B W1`, ids.coB, 30, 0, 15);
  // The drifted row: A's item booked into B's warehouse. The old query showed
  // it to A as "A-item @ B W2, balance 7".
  await post(ids.itemA, `${TAG} B W2`, ids.coA, 7, 0, 10);

  // The company-null rule: a NULL-company item and warehouse, plus a NULL item
  // booked into A's warehouse.
  await makeWarehouse(`${TAG} NULL W`, null);
  ids.itemNull = await makeItem(`${TAG}-NULL`, null);
  await post(ids.itemNull, `${TAG} NULL W`, null, 4, 0, 10);
  await post(ids.itemNull, `${TAG} A W1`, null, 3, 0, 10);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

describe('D4 · getStockSummary pairs items only with their own company\'s warehouses', () => {
  it('company A sees only its own warehouse stock rows', async () => {
    const rows = ours(await repo.getStockSummary({ company_id: ids.coA }));
    expect(rows.map(keyOf).sort()).toEqual([`${TAG}-A@${TAG} A W1`, `${TAG}-A@${TAG} A W2`]);
  });

  it('company B sees only its own warehouse stock rows', async () => {
    const rows = ours(await repo.getStockSummary({ company_id: ids.coB }));
    expect(rows.map(keyOf)).toEqual([`${TAG}-B@${TAG} B W1`]);
  });

  it('neither company ever sees the other\'s warehouse names', async () => {
    const a = await repo.getStockSummary({ company_id: ids.coA });
    const b = await repo.getStockSummary({ company_id: ids.coB });
    expect(a.some(r => /^ZZSTKSUM (B|NULL) /.test(r.warehouse_name))).toBe(false);
    expect(b.some(r => /^ZZSTKSUM (A|NULL) /.test(r.warehouse_name))).toBe(false);
  });

  it('global scope follows the company-null rule: same-company pairs only, NULL with NULL', async () => {
    const rows = ours(await repo.getStockSummary({}));
    expect(rows.map(keyOf).sort()).toEqual([
      `${TAG}-A@${TAG} A W1`,
      `${TAG}-A@${TAG} A W2`,
      `${TAG}-B@${TAG} B W1`,
      `${TAG}-NULL@${TAG} NULL W`,
    ]);
    // ...and therefore no A-item@B-warehouse and no NULL-item@A-warehouse.
  });

  it('stock totals and avg_rate are unchanged for legitimate rows', async () => {
    const rows = ours(await repo.getStockSummary({ company_id: ids.coA }));
    const by = Object.fromEntries(rows.map(r => [r.warehouse_name, r]));
    expect(Number(by[`${TAG} A W1`].balance)).toBe(45);
    expect(Number(by[`${TAG} A W1`].avg_rate)).toBe(10);
    expect(Number(by[`${TAG} A W2`].balance)).toBe(20);
    expect(Number(by[`${TAG} A W2`].avg_rate)).toBe(20);
    expect(Number(ours(await repo.getStockSummary({ company_id: ids.coB }))[0].balance)).toBe(30);
  });

  it('the response shape is unchanged', async () => {
    const [row] = ours(await repo.getStockSummary({ company_id: ids.coA }));
    expect(Object.keys(row)).toEqual(SHAPE);
    expect(row.warehouse_id).toBe(wh[`${TAG} A W1`]);
  });

  it('item_id and warehouse_id filters still narrow within the company', async () => {
    const w2 = await repo.getStockSummary({ company_id: ids.coA, warehouse_id: wh[`${TAG} A W2`] });
    expect(w2.map(keyOf)).toEqual([`${TAG}-A@${TAG} A W2`]);
    // Another company's warehouse as a filter yields nothing, not B's stock.
    expect(await repo.getStockSummary({ company_id: ids.coA, warehouse_id: wh[`${TAG} B W2`] })).toEqual([]);
    const byItem = await repo.getStockSummary({ company_id: ids.coB, item_id: ids.itemA });
    expect(byItem).toEqual([]);
  });
});

describe('D4 · GET /inventory/stock/summary', () => {
  it('returns only company A\'s rows for company A', async () => {
    const res = await request(appAs(ids.coA)).get('/inventory/stock/summary');
    expect(res.status).toBe(200);
    expect(ours(res.body).map(keyOf).sort()).toEqual([`${TAG}-A@${TAG} A W1`, `${TAG}-A@${TAG} A W2`]);
    expect(res.body.some(r => /^ZZSTKSUM (B|NULL) /.test(r.warehouse_name))).toBe(false);
    expect(Object.keys(res.body[0])).toEqual(SHAPE);
  });

  it('returns only company B\'s rows for company B', async () => {
    const res = await request(appAs(ids.coB)).get('/inventory/stock/summary');
    expect(res.status).toBe(200);
    expect(ours(res.body).map(keyOf)).toEqual([`${TAG}-B@${TAG} B W1`]);
  });

  it('the inventory:view permission still gates it', async () => {
    const res = await request(appAs(ids.coA, ['zz_no_such_role'])).get('/inventory/stock/summary');
    expect(res.status).toBe(403);
  });
});
