/**
 * integration.valuationTenantScope.test.js — the last stockLedger.repository
 * cross-company warehouse join from audit defect D4
 * (INVENTORY_REPLENISHMENT_AUDIT.md): the Weighted Average / Standard Cost
 * branch of `getInventoryValuation()`.
 *
 * The tenant predicate was on the item only, and items were CROSS JOINed
 * against every warehouse. HAVING balance > 0 hides empty pairs, so the leak
 * needs a ledger row placing company A's item in company B's warehouse. The
 * fixture plants one; the old query valued it for A under B's warehouse name.
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

const TAG = 'ZZVALSCP';
const WA = 'Weighted Average';

function appAs(companyId, roles = ['admin']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000003, id: 2000000003, company_id: companyId, roles, role: roles[0] };
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
  if (co.length) {
    await pool.query(`DELETE FROM company_settings WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
  }
}

async function makeWarehouse(name, companyId) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [name, companyId]);
  wh[name] = w.id;
}

async function makeItem(code, companyId, standardCost) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', 5, $3, true) RETURNING id`, [code, companyId, standardCost]);
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

const SHAPE = ['id', 'item_code', 'item_name', 'item_type', 'hsn_code', 'gst_rate', 'warehouse_name',
               'balance', 'avg_rate', 'value', 'valuation_method',
               'holding_cost_rate_annual', 'holding_cost_annual', 'holding_cost_monthly'];
const ours = rows => rows.filter(r => String(r.item_code).startsWith(TAG));
const keyOf = r => `${r.item_code}@${r.warehouse_name}`;
const byWh = rows => Object.fromEntries(ours(rows).map(r => [r.warehouse_name, r]));
const total = rows => ours(rows).reduce((s, r) => s + Number(r.value), 0);
const FOREIGN_TO_A = new RegExp(`^${TAG} (B|NULL) `);
const FOREIGN_TO_B = new RegExp(`^${TAG} (A|NULL) `);

beforeAll(async () => {
  await sweep();
  for (const s of ['A', 'B']) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    await makeWarehouse(`${TAG} ${s} W1`, c.id);
    await makeWarehouse(`${TAG} ${s} W2`, c.id);
  }
  ids.itemA = await makeItem(`${TAG}-A`, ids.coA, 11);
  ids.itemB = await makeItem(`${TAG}-B`, ids.coB, 22);

  // A W1: 10 @10 + 30 @20, 8 out -> balance 32, weighted avg 700/40 = 17.5, value 560.
  await post(ids.itemA, `${TAG} A W1`, ids.coA, 10, 0, 10);
  await post(ids.itemA, `${TAG} A W1`, ids.coA, 30, 0, 20);
  await post(ids.itemA, `${TAG} A W1`, ids.coA, 0, 8, 15);
  // A W2: 5 @40 -> value 200.
  await post(ids.itemA, `${TAG} A W2`, ids.coA, 5, 0, 40);
  // B W1: 12 @25 -> value 300.
  await post(ids.itemB, `${TAG} B W1`, ids.coB, 12, 0, 25);
  // Drift: A's item booked into B's warehouse. The old query valued it for A.
  await post(ids.itemA, `${TAG} B W2`, ids.coA, 7, 0, 10);
  // Company-null: a NULL item in a NULL warehouse, and in A's warehouse.
  await makeWarehouse(`${TAG} NULL W`, null);
  ids.itemNull = await makeItem(`${TAG}-NULL`, null, 1);
  await post(ids.itemNull, `${TAG} NULL W`, null, 4, 0, 10);
  await post(ids.itemNull, `${TAG} A W1`, null, 3, 0, 10);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

describe('D4 · getInventoryValuation (Weighted Average) values only same-company stock', () => {
  it('company A cannot see or value company B\'s warehouse stock', async () => {
    const rows = await repo.getInventoryValuation(null, WA, ids.coA);
    expect(ours(rows).map(keyOf).sort()).toEqual([`${TAG}-A@${TAG} A W1`, `${TAG}-A@${TAG} A W2`]);
    expect(rows.some(r => FOREIGN_TO_A.test(r.warehouse_name))).toBe(false);
    expect(total(rows)).toBe(760);            // 560 + 200, not + the 70 drifted into B W2
  });

  it('company B cannot see or value company A\'s warehouse stock', async () => {
    const rows = await repo.getInventoryValuation(null, WA, ids.coB);
    expect(ours(rows).map(keyOf)).toEqual([`${TAG}-B@${TAG} B W1`]);
    expect(rows.some(r => FOREIGN_TO_B.test(r.warehouse_name))).toBe(false);
    expect(total(rows)).toBe(300);
  });

  it('global scope: same-company pairs only, company-null item only with company-null warehouse', async () => {
    const rows = await repo.getInventoryValuation(null, WA, null);
    expect(ours(rows).map(keyOf).sort()).toEqual([
      `${TAG}-A@${TAG} A W1`,
      `${TAG}-A@${TAG} A W2`,
      `${TAG}-B@${TAG} B W1`,
      `${TAG}-NULL@${TAG} NULL W`,
    ]);
    expect(Number(byWh(rows)[`${TAG} NULL W`].value)).toBe(40);
  });

  it('weighted-average figures are unchanged for valid same-company stock', async () => {
    const r = byWh(await repo.getInventoryValuation(null, WA, ids.coA));
    expect(Number(r[`${TAG} A W1`].balance)).toBe(32);
    expect(Number(r[`${TAG} A W1`].avg_rate)).toBe(17.5);
    expect(Number(r[`${TAG} A W1`].value)).toBe(560);
    expect(Number(r[`${TAG} A W2`].avg_rate)).toBe(40);
    expect(Number(r[`${TAG} A W2`].value)).toBe(200);
    const rate = repo.getHoldingRate();
    expect(r[`${TAG} A W1`].holding_cost_annual).toBeCloseTo(560 * rate, 6);
    expect(r[`${TAG} A W1`].holding_cost_monthly).toBeCloseTo(560 * rate / 12, 6);
  });

  it('Standard Cost (same query branch) is scoped the same way and unchanged', async () => {
    const rows = await repo.getInventoryValuation(null, 'Standard Cost', ids.coA);
    const r = byWh(rows);
    expect(Object.keys(r).sort()).toEqual([`${TAG} A W1`, `${TAG} A W2`]);
    expect(Number(r[`${TAG} A W1`].value)).toBe(32 * 11);
    expect(Number(r[`${TAG} A W2`].value)).toBe(5 * 11);
  });

  it('the warehouse filter still works, and another company\'s warehouse yields nothing', async () => {
    const w2 = await repo.getInventoryValuation(wh[`${TAG} A W2`], WA, ids.coA);
    expect(w2.map(keyOf)).toEqual([`${TAG}-A@${TAG} A W2`]);
    expect(await repo.getInventoryValuation(wh[`${TAG} B W2`], WA, ids.coA)).toEqual([]);
  });

  it('the response shape is unchanged', async () => {
    const [row] = ours(await repo.getInventoryValuation(null, WA, ids.coA));
    expect(Object.keys(row)).toEqual(SHAPE);
    expect(row.valuation_method).toBe(WA);
  });
});

describe('D4 · GET /inventory/stock/valuation', () => {
  it('company A gets only its own valued rows', async () => {
    const res = await request(appAs(ids.coA)).get('/inventory/stock/valuation');
    expect(res.status).toBe(200);
    expect(res.body.valuation_method).toBe(WA);
    expect(ours(res.body.items).map(keyOf).sort()).toEqual([`${TAG}-A@${TAG} A W1`, `${TAG}-A@${TAG} A W2`]);
    expect(res.body.items.some(r => FOREIGN_TO_A.test(r.warehouse_name))).toBe(false);
    expect(Object.keys(res.body.items[0])).toEqual(SHAPE);
  });

  it('company B gets only its own valued rows', async () => {
    const res = await request(appAs(ids.coB)).get('/inventory/stock/valuation');
    expect(res.status).toBe(200);
    expect(ours(res.body.items).map(keyOf)).toEqual([`${TAG}-B@${TAG} B W1`]);
  });

  it('?warehouse_id still filters', async () => {
    const res = await request(appAs(ids.coA)).get(`/inventory/stock/valuation?warehouse_id=${wh[`${TAG} A W1`]}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map(keyOf)).toEqual([`${TAG}-A@${TAG} A W1`]);
  });

  it('the inventory:view permission still gates it', async () => {
    const res = await request(appAs(ids.coA, ['zz_no_such_role'])).get('/inventory/stock/valuation');
    expect(res.status).toBe(403);
  });
});
