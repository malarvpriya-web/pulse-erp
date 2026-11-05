/**
 * integration.stockMovementTenantScope.test.js — Stage 5A: POST
 * /inventory/stock/movement.
 *
 * The route posted a manual receipt (IN) or issue (OUT) for whatever item and
 * warehouse the body named, with no company check at all, and wrote the ledger
 * row with a NULL company. Any caller holding inventory:add could create stock
 * in another company's warehouse at any rate, or take it out.
 *
 * Ownership rule (stockLedgerRepo.resolveStockOwnership — the Stage 2 rule,
 * assertParentsInCompany): the warehouse is in the caller's scope; a super
 * admin takes the warehouse's company; the item belongs to that same company;
 * NULL-company items are not shared; a NULL-company warehouse cannot be
 * attributed. A body company_id is never read.
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

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool }      = await import('../config/db.js');
const { default: invRouter } = await import('../modules/inventory/routes/inventory.routes.js');

const TAG = 'ZZSTKMV';

function appWith({ scope, companyId = null, roles = ['admin'] }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000008, id: 2000000008, company_id: companyId, roles, role: roles[0] };
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
  await pool.query(
    `DELETE FROM stock_ledger
      WHERE item_id IN (SELECT id FROM inventory_items WHERE item_code LIKE $1)
         OR warehouse_id IN (SELECT id FROM warehouses WHERE warehouse_name LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM warehouses WHERE warehouse_name LIKE $1`, [`${TAG}%`]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function makeWarehouse(key, companyId) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [`${TAG} ${key}`, companyId]);
  ids[key] = w.id;
}
async function makeItem(key, companyId) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', 1, 10, true) RETURNING id`, [`${TAG}-${key}`, companyId]);
  ids[key] = i.id;
}
async function seed(itemKey, whKey, companyId, qty) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, company_id, transaction_type, quantity_in, quantity_out,
                               balance_qty, rate, value, transaction_date, remarks)
     VALUES ($1, $2, $3, 'opening', $4::numeric, 0, $4::numeric, 10, $4::numeric * 10, CURRENT_DATE, $5)`,
    [ids[itemKey], ids[whKey], companyId, qty, `${TAG} seed`]);
}

// Every ledger row touching our items or warehouses, and every balance. A
// refusal must leave both exactly as they were.
async function footprint() {
  const scope = `(item_id IN (SELECT id FROM inventory_items WHERE item_code LIKE $1)
                 OR warehouse_id IN (SELECT id FROM warehouses WHERE warehouse_name LIKE $1))`;
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stock_ledger WHERE ${scope}`, [`${TAG}%`]);
  const { rows } = await pool.query(
    `SELECT item_id || '@' || warehouse_id AS k, SUM(quantity_in - quantity_out)::float AS q
       FROM stock_ledger WHERE ${scope} GROUP BY item_id, warehouse_id`, [`${TAG}%`]);
  return { rows: n, balances: Object.fromEntries(rows.map(r => [r.k, r.q])) };
}

const move = (whKey, itemKey, movement_type, quantity, extra = {}) => ({
  item_id: ids[itemKey], warehouse_id: ids[whKey], movement_type, quantity, rate: 12,
  notes: `${TAG} ${movement_type}`, ...extra,
});
const post = (app, body) => request(app).post('/inventory/stock/movement').send(body);
const ledgerRow = async (id) => (await pool.query(
  `SELECT company_id, item_id, warehouse_id, transaction_type, reference_type,
          quantity_in::float AS qin, quantity_out::float AS qout, rate::float AS rate
     FROM stock_ledger WHERE id = $1`, [id])).rows[0];

async function refused(app, body, status, message) {
  const before = await footprint();
  const res = await post(app, body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  if (message) expect(res.body.error).toMatch(message);
  expect(await footprint()).toEqual(before);
  return res;
}

beforeAll(async () => {
  await sweep();
  for (const s of ['A', 'B']) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    await makeWarehouse(`wh${s}`, c.id);
    await makeItem(`item${s}`, c.id);
    await seed(`item${s}`, `wh${s}`, c.id, 50);
  }
  await makeWarehouse('whNull', null);
  await makeItem('itemNull', null);
  await seed('itemNull', 'whA', null, 50);       // stock exists, so only ownership can refuse an OUT
  await seed('itemB', 'whA', ids.coA, 50);       // B's item physically in A's warehouse (drift)
  await seed('itemNull', 'whNull', null, 50);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('valid movements are posted and attributed', () => {
  it('IN: 201, a receipt filed under company A, same response shape as before', async () => {
    const before = await footprint();
    // reference sent too: the route echoes it, and an undefined echo field is
    // dropped from the JSON, so without it the key set would look one short.
    const res = await post(asCompany(ids.coA), move('whA', 'itemA', 'IN', 7, { reference: `${TAG} REF` }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await ledgerRow(res.body.id)).toEqual({
      company_id: ids.coA, item_id: ids.itemA, warehouse_id: ids.whA, transaction_type: 'receipt',
      reference_type: 'manual', qin: 7, qout: 0, rate: 12,
    });
    const after = await footprint();
    expect(after.rows).toBe(before.rows + 1);
    expect(after.balances[`${ids.itemA}@${ids.whA}`]).toBe(before.balances[`${ids.itemA}@${ids.whA}`] + 7);

    // The response is the ledger row plus the four echo fields — unchanged.
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_ledger' AND table_schema = 'public'`);
    expect(Object.keys(res.body).sort()).toEqual(
      [...cols.map(c => c.column_name), 'movement_type', 'quantity', 'reference', 'notes']
        .filter((v, i, a) => a.indexOf(v) === i).sort());
    expect(res.body).toMatchObject({ movement_type: 'IN', quantity: 7, reference: `${TAG} REF`, notes: `${TAG} IN` });
  });

  it('OUT: 201, an issue filed under company A, stock reduced', async () => {
    const before = await footprint();
    const res = await post(asCompany(ids.coA), move('whA', 'itemA', 'OUT', 3));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await ledgerRow(res.body.id)).toMatchObject({ company_id: ids.coA, transaction_type: 'issue', qin: 0, qout: 3 });
    expect((await footprint()).balances[`${ids.itemA}@${ids.whA}`]).toBe(before.balances[`${ids.itemA}@${ids.whA}`] - 3);
  });

  it('company B posts its own movement under B', async () => {
    const res = await post(asCompany(ids.coB), move('whB', 'itemB', 'IN', 1));
    expect(res.status).toBe(201);
    expect((await ledgerRow(res.body.id)).company_id).toBe(ids.coB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('another company\'s item or warehouse is refused, nothing written', () => {
  for (const dir of ['IN', 'OUT']) {
    it(`${dir}: A's warehouse with B's item: 404 — even though B's item is physically there`, async () => {
      await refused(asCompany(ids.coA), move('whA', 'itemB', dir, 1), 404, new RegExp(`Item ${ids.itemB} not found`));
    });
    it(`${dir}: B's warehouse with B's item, as company A: 404 on the warehouse`, async () => {
      await refused(asCompany(ids.coA), move('whB', 'itemB', dir, 1), 404, new RegExp(`Warehouse ${ids.whB} not found`));
    });
    it(`${dir}: B's warehouse with A's own item, as company A: 404`, async () => {
      await refused(asCompany(ids.coA), move('whB', 'itemA', dir, 1), 404, /Warehouse .* not found/);
    });
    it(`${dir}: company B reaching into A's warehouse: 404`, async () => {
      await refused(asCompany(ids.coB), move('whA', 'itemA', dir, 1), 404, /Warehouse .* not found/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('company-less items and warehouses', () => {
  it('a NULL-company item in A\'s warehouse is not shared: 404 (IN and OUT)', async () => {
    await refused(asCompany(ids.coA), move('whA', 'itemNull', 'IN', 1), 404, /Item .* not found/);
    await refused(asCompany(ids.coA), move('whA', 'itemNull', 'OUT', 1), 404, /Item .* not found/);
  });

  it('a NULL-company warehouse is outside company A\'s scope: 404', async () => {
    await refused(asCompany(ids.coA), move('whNull', 'itemA', 'IN', 1), 404, /Warehouse .* not found/);
  });

  it('a super admin posting to a NULL-company warehouse cannot be attributed: 422', async () => {
    await refused(asSuperAdmin(), move('whNull', 'itemNull', 'IN', 1), 422, /no company/);
    await refused(asSuperAdmin(), move('whNull', 'itemNull', 'OUT', 1), 422, /no company/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('super admin takes the warehouse\'s company', () => {
  it('B\'s warehouse and B\'s item: 201 under B', async () => {
    const res = await post(asSuperAdmin(), move('whB', 'itemB', 'IN', 2));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await ledgerRow(res.body.id)).company_id).toBe(ids.coB);
  });

  it('mixed ownership — A\'s warehouse with B\'s item — is still refused: 404', async () => {
    await refused(asSuperAdmin(), move('whA', 'itemB', 'IN', 1), 404, /Item .* not found/);
    await refused(asSuperAdmin(), move('whA', 'itemB', 'OUT', 1), 404, /Item .* not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a company_id in the body never chooses the company', () => {
  it('company A naming company B in the body: filed under A', async () => {
    const res = await post(asCompany(ids.coA), move('whA', 'itemA', 'IN', 1, { company_id: ids.coB }));
    expect(res.status).toBe(201);
    expect((await ledgerRow(res.body.id)).company_id).toBe(ids.coA);
  });

  it('a super admin naming company A for B\'s warehouse: filed under B', async () => {
    const res = await post(asSuperAdmin(), move('whB', 'itemB', 'IN', 1, { company_id: ids.coA }));
    expect(res.status).toBe(201);
    expect((await ledgerRow(res.body.id)).company_id).toBe(ids.coB);
  });

  it('naming the other company in the body does not unlock its warehouse', async () => {
    await refused(asCompany(ids.coA), move('whB', 'itemB', 'IN', 1, { company_id: ids.coB }), 404, /not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('missing company scope and permissions', () => {
  it('an ordinary user with no company is refused: 403 NO_COMPANY_SCOPE, nothing written', async () => {
    for (const scope of [null, { company_id: null, branch_id: null }]) {
      for (const dir of ['IN', 'OUT']) {
        const res = await refused(appWith({ scope }), move('whA', 'itemA', dir, 1), 403);
        expect(res.body.code).toBe('NO_COMPANY_SCOPE');
      }
    }
  });

  it('a role without inventory:add is refused by the permission gate first', async () => {
    const app = appWith({ scope: { company_id: ids.coA }, companyId: ids.coA, roles: ['zz_no_such_role'] });
    const res = await refused(app, move('whA', 'itemA', 'IN', 1), 403);
    expect(res.body.code).not.toBe('NO_COMPANY_SCOPE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('existing movement rules are unchanged', () => {
  it('missing required fields: 422', async () => {
    await refused(asCompany(ids.coA), { item_id: ids.itemA, movement_type: 'IN', quantity: 1 }, 422, /required/);
  });

  it('a non-positive quantity: 422', async () => {
    await refused(asCompany(ids.coA), move('whA', 'itemA', 'IN', -5), 422, /positive/);
  });

  it('an OUT beyond free stock: 422 from the availability check, nothing written', async () => {
    await refused(asCompany(ids.coA), move('whA', 'itemA', 'OUT', 999999), 422, /Insufficient/);
  });

  it('any movement_type other than IN is still an issue', async () => {
    const res = await post(asCompany(ids.coA), move('whA', 'itemA', 'stock_out', 1));
    expect(res.status).toBe(201);
    expect(await ledgerRow(res.body.id)).toMatchObject({ transaction_type: 'issue', qout: 1, company_id: ids.coA });
  });
});
