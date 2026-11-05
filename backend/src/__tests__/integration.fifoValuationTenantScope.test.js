/**
 * integration.fifoValuationTenantScope.test.js — the FIFO/FEFO branch of
 * `stockLedgerRepo.getInventoryValuation()`.
 *
 * That branch read `inventory_fifo_layers` with no company predicate at all:
 * the companyId the route passes in was ignored, so a company whose
 * company_settings.inventory.valuation_method is FIFO or FEFO was shown every
 * tenant's layers and value on GET /inventory/stock/valuation.
 *
 * Fixture: two throwaway companies, A on FIFO and B on FEFO, each with its own
 * layers; plus cross-company layers (A's item in B's warehouse, B's item in A's
 * warehouse), a warehouse-less layer, a depleted layer, and a company-null item
 * and warehouse. Swept before and after. Run with `npm run test:db`.
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

const TAG = 'ZZFIFOSC';

function appAs(companyId, roles = ['admin']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000004, id: 2000000004, company_id: companyId, roles, role: roles[0] };
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
  await pool.query(
    `DELETE FROM inventory_fifo_layers
      WHERE item_id IN (SELECT id FROM inventory_items WHERE item_code LIKE $1)
         OR warehouse_id IN (SELECT id FROM warehouses WHERE warehouse_name LIKE $1)`, [`${TAG}%`]);
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

async function makeItem(code, companyId) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', 5, 1, true) RETURNING id`, [code, companyId]);
  return i.id;
}

// A layer exactly as postStock() writes one: company from the posting, item,
// warehouse (nullable), received/remaining quantity and unit cost.
async function layer(companyId, itemId, warehouseName, received, remaining, cost, expiry = null) {
  await pool.query(
    `INSERT INTO inventory_fifo_layers
       (company_id, item_id, warehouse_id, received_date, expiry_date, qty_received, qty_remaining, unit_cost, source_type)
     VALUES ($1, $2, $3, CURRENT_DATE, $4::date, $5, $6, $7, 'TEST')`,
    [companyId, itemId, warehouseName ? wh[warehouseName] : null, expiry, received, remaining, cost]);
}

const SHAPE = ['id', 'item_code', 'item_name', 'item_type', 'hsn_code', 'gst_rate', 'warehouse_name',
               'balance', 'avg_rate', 'value', 'layer_count', 'valuation_method', 'annual_holding_cost'];
const ours = rows => rows.filter(r => String(r.item_code).startsWith(TAG));
const keyOf = r => `${r.item_code}@${r.warehouse_name ?? '(none)'}`;
const byKey = rows => Object.fromEntries(ours(rows).map(r => [keyOf(r), r]));
const total = rows => ours(rows).reduce((s, r) => s + r.value, 0);
const A_ROWS = [`${TAG}-A@(none)`, `${TAG}-A@${TAG} A W1`, `${TAG}-A@${TAG} A W2`];
const B_ROWS = [`${TAG}-B@${TAG} B W1`];

beforeAll(async () => {
  await sweep();
  for (const [s, method] of [['A', 'FIFO'], ['B', 'FEFO']]) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    await pool.query(
      `INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'inventory', $2::jsonb)`,
      [c.id, JSON.stringify({ valuation_method: method })]);
    await makeWarehouse(`${TAG} ${s} W1`, c.id);
    await makeWarehouse(`${TAG} ${s} W2`, c.id);
  }
  ids.itemA = await makeItem(`${TAG}-A`, ids.coA);
  ids.itemB = await makeItem(`${TAG}-B`, ids.coB);

  // A W1: 10 left @10 + 30 left @20 -> balance 40, value 700, avg 17.5, 2 layers.
  await layer(ids.coA, ids.itemA, `${TAG} A W1`, 10, 10, 10);
  await layer(ids.coA, ids.itemA, `${TAG} A W1`, 50, 30, 20);
  await layer(ids.coA, ids.itemA, `${TAG} A W1`, 25, 0, 99);   // depleted: never valued
  // A W2: 5 @40 -> 200. Warehouse-less layer: 2 @50 -> 100.
  await layer(ids.coA, ids.itemA, `${TAG} A W2`, 5, 5, 40);
  await layer(ids.coA, ids.itemA, null, 2, 2, 50);
  // B W1 (FEFO, with expiries): 8 @25 + 4 @25 -> balance 12, value 300.
  await layer(ids.coB, ids.itemB, `${TAG} B W1`, 8, 8, 25, '2027-01-31');
  await layer(ids.coB, ids.itemB, `${TAG} B W1`, 4, 4, 25, '2027-06-30');
  // Cross-company layers: A's item in B's warehouse, B's item in A's warehouse.
  await layer(ids.coA, ids.itemA, `${TAG} B W2`, 7, 7, 10);
  await layer(ids.coB, ids.itemB, `${TAG} A W2`, 6, 6, 10);
  // Company-null: a NULL item in a NULL warehouse (valid pair), and in A's warehouse.
  await makeWarehouse(`${TAG} NULL W`, null);
  ids.itemNull = await makeItem(`${TAG}-NULL`, null);
  await layer(null, ids.itemNull, `${TAG} NULL W`, 4, 4, 10);
  await layer(null, ids.itemNull, `${TAG} A W1`, 3, 3, 10);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

describe('FIFO/FEFO valuation · company isolation', () => {
  for (const method of ['FIFO', 'FEFO']) {
    it(`${method}: company A sees and values only its own layers`, async () => {
      const rows = await repo.getInventoryValuation(null, method, ids.coA);
      expect(ours(rows).map(keyOf).sort()).toEqual(A_ROWS);
      expect(rows.some(r => /^ZZFIFOSC (B|NULL) /.test(r.warehouse_name ?? ''))).toBe(false);
      expect(total(rows)).toBe(1000);                 // 700 + 200 + 100
    });

    it(`${method}: company B sees and values only its own layers`, async () => {
      const rows = await repo.getInventoryValuation(null, method, ids.coB);
      expect(ours(rows).map(keyOf)).toEqual(B_ROWS);
      expect(rows.some(r => /^ZZFIFOSC (A|NULL) /.test(r.warehouse_name ?? ''))).toBe(false);
      expect(total(rows)).toBe(300);
    });
  }

  it('the company scope is not just a filter on our fixtures: no foreign item reaches company A', async () => {
    const rows = await repo.getInventoryValuation(null, 'FIFO', ids.coA);
    const { rows: own } = await pool.query(`SELECT id FROM inventory_items WHERE company_id = $1`, [ids.coA]);
    const ownIds = new Set(own.map(r => r.id));
    expect(rows.every(r => ownIds.has(r.id))).toBe(true);
  });

  it('global scope: same-company pairs, warehouse-less layers, and NULL item only with NULL warehouse', async () => {
    const rows = await repo.getInventoryValuation(null, 'FIFO', null);
    expect(ours(rows).map(keyOf).sort()).toEqual([...A_ROWS, ...B_ROWS, `${TAG}-NULL@${TAG} NULL W`].sort());
    expect(byKey(rows)[`${TAG}-NULL@${TAG} NULL W`].value).toBe(40);
  });
});

describe('FIFO/FEFO valuation · calculations, filters and shape unchanged', () => {
  it('prices remaining layers only, quantity-weighted', async () => {
    const r = byKey(await repo.getInventoryValuation(null, 'FIFO', ids.coA));
    const w1 = r[`${TAG}-A@${TAG} A W1`];
    expect(w1.balance).toBe(40);
    expect(w1.value).toBe(700);
    expect(w1.avg_rate).toBe(17.5);
    expect(w1.layer_count).toBe(2);                  // the depleted layer is not counted
    expect(r[`${TAG}-A@${TAG} A W2`].value).toBe(200);
    expect(r[`${TAG}-A@(none)`].value).toBe(100);
    const rate = repo.getHoldingRate();
    expect(w1.annual_holding_cost).toBe(Math.round(700 * rate * 100) / 100);
  });

  it('FEFO values the same remaining layers and labels the method', async () => {
    const [b] = ours(await repo.getInventoryValuation(null, 'FEFO', ids.coB));
    expect(b).toMatchObject({ balance: 12, value: 300, avg_rate: 25, layer_count: 2, valuation_method: 'FEFO' });
  });

  it('the warehouse filter still works, and another company\'s warehouse yields nothing', async () => {
    const w2 = await repo.getInventoryValuation(wh[`${TAG} A W2`], 'FIFO', ids.coA);
    expect(w2.map(keyOf)).toEqual([`${TAG}-A@${TAG} A W2`]);
    expect(await repo.getInventoryValuation(wh[`${TAG} B W2`], 'FIFO', ids.coA)).toEqual([]);
    expect(await repo.getInventoryValuation(wh[`${TAG} A W2`], 'FEFO', ids.coB)).toEqual([]);
  });

  it('the response shape is unchanged', async () => {
    const [row] = ours(await repo.getInventoryValuation(null, 'FIFO', ids.coA));
    expect(Object.keys(row)).toEqual(SHAPE);
  });
});

describe('FIFO/FEFO valuation · GET /inventory/stock/valuation', () => {
  it('company A (FIFO setting) gets only its own rows', async () => {
    const res = await request(appAs(ids.coA)).get('/inventory/stock/valuation');
    expect(res.status).toBe(200);
    expect(res.body.valuation_method).toBe('FIFO');
    expect(ours(res.body.items).map(keyOf).sort()).toEqual(A_ROWS);
    expect(res.body.items.some(r => /^ZZFIFOSC (B|NULL) /.test(r.warehouse_name ?? ''))).toBe(false);
    expect(Object.keys(res.body.items[0])).toEqual(SHAPE);
  });

  it('company B (FEFO setting) gets only its own rows', async () => {
    const res = await request(appAs(ids.coB)).get('/inventory/stock/valuation');
    expect(res.status).toBe(200);
    expect(res.body.valuation_method).toBe('FEFO');
    expect(ours(res.body.items).map(keyOf)).toEqual(B_ROWS);
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
