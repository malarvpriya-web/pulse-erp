/**
 * integration.advancedInventoryTenantIsolation.test.js
 *
 * Drives the REAL `advancedInventory.routes.js` router against the REAL database.
 *
 * WHY THESE EXIST
 * ===============
 * 14 of this router's 20 endpoints applied NO tenant filter at all.
 * `requirePermission('inventory', ...)` was the only gate, and a permission is not
 * a scope: every user in every company holds `inventory:view` over their own
 * inventory, and that same grant was reading — and in seven cases WRITING —
 * everyone else's. See the router header for the full list.
 *
 * ⚠⚠ EVERY NEGATIVE CASE HERE IS PAIRED WITH A POSITIVE ONE. An isolation suite
 * that only asserts "the other tenant is refused" passes just as happily when the
 * endpoint is broken for EVERYONE, and that exact false green has shipped in this
 * repo before. The `own tenant` assertions are load-bearing, not padding.
 *
 * ⚠ The write cases assert the DATABASE, not just the status code. A 404 with the
 * row mutated anyway is the failure mode that matters, and the response body
 * cannot see it.
 *
 * Self-cleaning: two synthetic companies and everything beneath them are removed
 * by sweep(), which runs on the way IN as well as out — a suite that only tidies
 * on the way out leaks its companies the moment an assertion throws, and because
 * `companies.code` is UNIQUE that leak then fails every LATER run at INSERT time,
 * which reads as a broken suite rather than a stale row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }      = await import('../config/db.js');
const { default: advRouter } = await import('../modules/inventory/routes/advancedInventory.routes.js');

const TAG = 'ZZADVINV';

/**
 * An app whose caller belongs to exactly this company.
 *
 * `requirePermission` is bypassed with a permissive stub rather than removed: the
 * point of this suite is that PERMISSION IS NOT SCOPE, so the caller must hold
 * every inventory permission and still be refused another tenant's rows. Granting
 * less would let a test pass for the wrong reason.
 */
function appAs(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, permissions: ['*'] };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/adv', advRouter);
  return app;
}

const ids = {
  companyA: null, companyB: null,
  itemA: null, itemB: null,
  whA: null, whB: null,
  batchA: null, batchB: null,
  resA: null, resB: null,
  allocA: null, allocB: null,
  alertA: null, alertB: null,
  sugA: null, sugB: null,
};
let A, B;

async function makeCompany(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co ${suffix}`, `${TAG}${suffix}`]);
  return rows[0].id;
}

async function makeItem(companyId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 10, 100) RETURNING id`,
    [`${TAG}-${suffix}`, `${TAG} Item ${suffix}`, companyId]);
  return rows[0].id;
}

async function makeWarehouse(companyId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`,
    [`${TAG} WH ${suffix}`, companyId]);
  return rows[0].id;
}

async function makeBatch(companyId, itemId, whId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_batches
       (item_id, warehouse_id, batch_number, received_date, quantity_received, quantity_available, rate, status, company_id)
     VALUES ($1, $2, $3, CURRENT_DATE, 50, 50, 10, 'active', $4) RETURNING id`,
    [itemId, whId, `${TAG}-BATCH-${suffix}`, companyId]);
  return rows[0].id;
}

/** On-hand stock, so availability checks have something to pass against. */
async function postLedger(companyId, itemId, whId, qty) {
  await pool.query(
    `INSERT INTO stock_ledger
       (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate, transaction_date, company_id, remarks)
     VALUES ($1, $2, 'receipt', $3, 0, 10, CURRENT_DATE, $4, $5)`,
    [itemId, whId, qty, companyId, `${TAG} opening`]);
}

async function makeReservation(itemId, whId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_reservations
       (item_id, warehouse_id, reservation_type, reference_type, reference_number,
        quantity_reserved, quantity_remaining, reserved_date, status)
     VALUES ($1, $2, 'project', 'project', $3, 5, 5, CURRENT_DATE, 'active') RETURNING id`,
    [itemId, whId, `${TAG}-RES-${suffix}`]);
  return rows[0].id;
}

async function makeAllocation(itemId, whId) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_allocations
       (item_id, warehouse_id, allocation_type, reference_type, quantity, rate, allocation_date, purpose, allocation_source)
     VALUES ($1, $2, 'project', 'project', 3, 10, CURRENT_DATE, $3, 'advanced_manual') RETURNING id`,
    [itemId, whId, `${TAG} alloc`]);
  return rows[0].id;
}

async function makeAlert(itemId, whId) {
  const { rows } = await pool.query(
    `INSERT INTO stock_alerts (item_id, warehouse_id, alert_type, status, alert_date)
     VALUES ($1, $2, 'low_stock', 'active', CURRENT_DATE) RETURNING id`,
    [itemId, whId]);
  return rows[0].id;
}

async function makeSuggestion(itemId, whId) {
  const { rows } = await pool.query(
    `INSERT INTO purchase_suggestions (item_id, warehouse_id, suggested_quantity, priority, status, generated_date)
     VALUES ($1, $2, 25, 'high', 'pending', CURRENT_DATE) RETURNING id`,
    [itemId, whId]);
  return rows[0].id;
}

/**
 * Remove every trace of this suite's synthetic companies.
 *
 * The FK-discovery pass is copied from integration.projectsTenantIsolation.test.js
 * for the reason stated there: route files in this repo run seeders at IMPORT time
 * (talent.routes.js plants interview_questions into EVERY company the moment it is
 * imported), so which tables pin a brand-new company depends on what else the test
 * RUN happened to import, not on anything this file does. A hand-written table list
 * goes stale the next time that happens.
 */
async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;

  const ourItems = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  // Children first, by hand, because these four tables have NO company_id of their
  // own — which is the whole reason this suite exists.
  await pool.query(`DELETE FROM purchase_requests     WHERE source_suggestion_id IN (SELECT id FROM purchase_suggestions WHERE item_id IN ${ourItems})`, [co]);
  await pool.query(`DELETE FROM purchase_suggestions  WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM stock_alerts          WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_allocations WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_reservations WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM stock_ledger          WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_batches     WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_items       WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM warehouses            WHERE company_id = ANY($1)`, [co]);

  const { rows: fks } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu  ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies'`);
  for (let pass = 0; pass < 2; pass++) {
    for (const { table_name, column_name } of fks) {
      try {
        await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, [co]);
      } catch { /* FK ordering — the second pass picks it up */ }
    }
  }
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

beforeAll(async () => {
  await sweep();
  ids.companyA = await makeCompany('A');
  ids.companyB = await makeCompany('B');

  ids.itemA = await makeItem(ids.companyA, 'A');
  ids.itemB = await makeItem(ids.companyB, 'B');
  ids.whA   = await makeWarehouse(ids.companyA, 'A');
  ids.whB   = await makeWarehouse(ids.companyB, 'B');

  await postLedger(ids.companyA, ids.itemA, ids.whA, 100);
  await postLedger(ids.companyB, ids.itemB, ids.whB, 100);

  ids.batchA = await makeBatch(ids.companyA, ids.itemA, ids.whA, 'A');
  ids.batchB = await makeBatch(ids.companyB, ids.itemB, ids.whB, 'B');
  ids.resA   = await makeReservation(ids.itemA, ids.whA, 'A');
  ids.resB   = await makeReservation(ids.itemB, ids.whB, 'B');
  ids.allocA = await makeAllocation(ids.itemA, ids.whA);
  ids.allocB = await makeAllocation(ids.itemB, ids.whB);
  ids.alertA = await makeAlert(ids.itemA, ids.whA);
  ids.alertB = await makeAlert(ids.itemB, ids.whB);
  ids.sugA   = await makeSuggestion(ids.itemA, ids.whA);
  ids.sugB   = await makeSuggestion(ids.itemB, ids.whB);

  A = appAs(ids.companyA);
  B = appAs(ids.companyB);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('Advanced Inventory · list reads are scoped to the caller\'s company', () => {
  const cases = [
    ['GET /batches',              '/adv/batches',              () => ids.batchA, () => ids.batchB],
    ['GET /allocations',          '/adv/allocations',          () => ids.allocA, () => ids.allocB],
    ['GET /alerts',               '/adv/alerts',               () => ids.alertA, () => ids.alertB],
    ['GET /purchase-suggestions', '/adv/purchase-suggestions', () => ids.sugA,   () => ids.sugB],
    ['GET /reservations',         '/adv/reservations',         () => ids.resA,   () => ids.resB],
  ];

  for (const [label, path, ownId, otherId] of cases) {
    it(`${label} returns own rows and NONE of company B's`, async () => {
      const res = await request(A).get(path);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const returned = res.body.map(r => r.id);
      // Positive: the endpoint works at all. Without this the test passes when
      // the query is simply broken.
      expect(returned).toContain(ownId());
      // Negative: the boundary holds.
      expect(returned).not.toContain(otherId());
    });
  }

  it('a client-supplied ?company_id cannot widen the scope', async () => {
    // `{ ...req.query, company_id: companyOf(req) }` — the spread comes FIRST so
    // the server's value wins. If that order is ever reversed, company_id becomes
    // a request parameter and every list endpoint above is open again.
    const res = await request(A).get(`/adv/batches?company_id=${ids.companyB}`);
    expect(res.status).toBe(200);
    expect(res.body.map(r => r.id)).not.toContain(ids.batchB);
    expect(res.body.map(r => r.id)).toContain(ids.batchA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Advanced Inventory · aggregate reads do not total another company\'s stock', () => {
  it('GET /stock-summary lists only this company\'s item/warehouse pairs', async () => {
    const res = await request(A).get('/adv/stock-summary');
    expect(res.status).toBe(200);
    const ourRow = res.body.find(r => r.id === ids.itemA);
    expect(ourRow).toBeTruthy();                                   // positive
    expect(res.body.some(r => r.id === ids.itemB)).toBe(false);    // negative
    // The CROSS JOIN is same-tenant now (migration 20260926000010): company A's
    // item must not be paired with company B's warehouse.
    expect(res.body.some(r => r.warehouse_id === ids.whB)).toBe(false);
  });

  it('GET /dashboard counts only this company', async () => {
    const [a, b] = await Promise.all([
      request(A).get('/adv/dashboard'),
      request(B).get('/adv/dashboard'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Each company sees at least its own fixture; the assertion that bites is
    // that the totals are NOT identical, which is what an unscoped query returns.
    expect(a.body.pending_suggestions).toBeGreaterThanOrEqual(1);
    expect(b.body.pending_suggestions).toBeGreaterThanOrEqual(1);

    const { rows: [global] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM purchase_suggestions WHERE status = 'pending'`);
    // The install-wide count includes BOTH fixtures plus whatever else is in this
    // database, so a scoped answer must be strictly smaller than it.
    expect(a.body.pending_suggestions).toBeLessThan(global.n);
  });

  it('GET /stock-aging totals only this company\'s lots', async () => {
    const res = await request(A).get('/adv/stock-aging');
    expect(res.status).toBe(200);
    const totalQty = res.body.reduce((s, r) => s + Number(r.total_quantity || 0), 0);
    const { rows: [scoped] } = await pool.query(
      `SELECT COALESCE(SUM(quantity_available), 0)::float AS q FROM v_batch_stock
        WHERE status = 'active' AND company_id = $1`, [ids.companyA]);
    expect(totalQty).toBeCloseTo(scoped.q, 2);

    const { rows: [everything] } = await pool.query(
      `SELECT COALESCE(SUM(quantity_available), 0)::float AS q FROM v_batch_stock WHERE status = 'active'`);
    expect(totalQty).toBeLessThan(everything.q);   // it is genuinely a subset
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Advanced Inventory · cross-tenant WRITES are refused and change nothing', () => {
  it('PUT /batches/:id/consume cannot draw down company B\'s lot', async () => {
    const before = await qty('inventory_batches', 'quantity_available', ids.batchB);

    const res = await request(A).put(`/adv/batches/${ids.batchB}/consume`).send({ quantity: 5 });
    expect(res.status).toBe(404);

    // The assertion that matters: a 404 with the row mutated anyway is the real
    // failure mode, and the response body cannot see it.
    expect(await qty('inventory_batches', 'quantity_available', ids.batchB)).toBeCloseTo(before, 4);

    // Paired positive — the endpoint genuinely works for its owner.
    const own = await request(A).put(`/adv/batches/${ids.batchA}/consume`).send({ quantity: 5 });
    expect(own.status).toBe(200);
    expect(await qty('inventory_batches', 'quantity_available', ids.batchA)).toBeCloseTo(45, 4);
  });

  it('POST /reservations/:id/cancel cannot release company B\'s reserved stock', async () => {
    const res = await request(A).post(`/adv/reservations/${ids.resB}/cancel`).send({});
    expect(res.status).toBe(404);

    const { rows: [after] } = await pool.query(
      `SELECT status FROM inventory_reservations WHERE id = $1`, [ids.resB]);
    expect(after.status).toBe('active');    // untouched

    const own = await request(A).post(`/adv/reservations/${ids.resA}/cancel`).send({});
    expect(own.status).toBe(200);
    const { rows: [mine] } = await pool.query(
      `SELECT status FROM inventory_reservations WHERE id = $1`, [ids.resA]);
    expect(mine.status).toBe('cancelled');
  });

  it('POST /reservations/:id/consume cannot consume against company B\'s reservation', async () => {
    const res = await request(A).post(`/adv/reservations/${ids.resB}/consume`).send({ quantity_consumed: 2 });
    expect(res.status).toBe(404);
    expect(await qty('inventory_reservations', 'quantity_remaining', ids.resB)).toBeCloseTo(5, 4);

    // Positive, on a fresh reservation of A's own (resA was cancelled above).
    const freshA = await makeReservation(ids.itemA, ids.whA, 'A2');
    const own = await request(A).post(`/adv/reservations/${freshA}/consume`).send({ quantity_consumed: 2 });
    expect(own.status).toBe(200);
    expect(await qty('inventory_reservations', 'quantity_remaining', freshA)).toBeCloseTo(3, 4);
  });

  it('POST /reservations cannot reserve company B\'s item', async () => {
    const res = await request(A).post('/adv/reservations').send({
      item_id: ids.itemB, warehouse_id: ids.whB, quantity_reserved: 1,
      reservation_type: 'project', reference_type: 'project', reserved_date: '2026-09-26',
    });
    expect(res.status).toBe(404);

    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_reservations WHERE item_id = $1`, [ids.itemB]);
    expect(n.n).toBe(1);    // only the fixture

    const own = await request(A).post('/adv/reservations').send({
      item_id: ids.itemA, warehouse_id: ids.whA, quantity_reserved: 1,
      reservation_type: 'project', reference_type: 'project', reserved_date: '2026-09-26',
    });
    expect(own.status).toBe(201);
  });

  it('POST /reservations cannot mix its own item into another company\'s warehouse', async () => {
    // The mirror of the case above, and the one a check on the item alone misses.
    const res = await request(A).post('/adv/reservations').send({
      item_id: ids.itemA, warehouse_id: ids.whB, quantity_reserved: 1,
      reservation_type: 'project', reference_type: 'project', reserved_date: '2026-09-26',
    });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/Warehouse/i);
  });

  it('POST /allocations cannot attribute company B\'s material to company A', async () => {
    const res = await request(A).post('/adv/allocations').send({
      item_id: ids.itemB, warehouse_id: ids.whB, allocation_type: 'project',
      reference_type: 'project', quantity: 1, rate: 10, allocation_date: '2026-09-26',
    });
    expect(res.status).toBe(404);
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_allocations WHERE item_id = $1`, [ids.itemB]);
    expect(n.n).toBe(1);

    const own = await request(A).post('/adv/allocations').send({
      item_id: ids.itemA, warehouse_id: ids.whA, allocation_type: 'project',
      reference_type: 'project', quantity: 1, rate: 10, allocation_date: '2026-09-26',
    });
    expect(own.status).toBe(201);
  });

  it('POST /alerts/:id/acknowledge cannot clear company B\'s alert queue', async () => {
    const res = await request(A).post(`/adv/alerts/${ids.alertB}/acknowledge`).send({});
    expect(res.status).toBe(404);
    const { rows: [after] } = await pool.query(`SELECT status FROM stock_alerts WHERE id = $1`, [ids.alertB]);
    expect(after.status).toBe('active');

    const own = await request(A).post(`/adv/alerts/${ids.alertA}/acknowledge`).send({});
    expect(own.status).toBe(200);
    const { rows: [mine] } = await pool.query(`SELECT status FROM stock_alerts WHERE id = $1`, [ids.alertA]);
    expect(mine.status).toBe('acknowledged');
  });

  it('POST /alerts/:id/resolve cannot resolve company B\'s alert', async () => {
    const res = await request(A).post(`/adv/alerts/${ids.alertB}/resolve`).send({});
    expect(res.status).toBe(404);
    const { rows: [after] } = await pool.query(`SELECT status FROM stock_alerts WHERE id = $1`, [ids.alertB]);
    expect(after.status).toBe('active');

    const own = await request(A).post(`/adv/alerts/${ids.alertA}/resolve`).send({});
    expect(own.status).toBe(200);
    const { rows: [mine] } = await pool.query(
      `SELECT status, resolved_by FROM stock_alerts WHERE id = $1`, [ids.alertA]);
    expect(mine.status).toBe('resolved');
    expect(mine.resolved_by).toBe(1);
  });

  it('POST /purchase-suggestions/:id/reject cannot reject company B\'s suggestion', async () => {
    const res = await request(A).post(`/adv/purchase-suggestions/${ids.sugB}/reject`).send({ reason: 'nope' });
    expect(res.status).toBe(404);
    const { rows: [after] } = await pool.query(
      `SELECT status FROM purchase_suggestions WHERE id = $1`, [ids.sugB]);
    expect(after.status).toBe('pending');
  });

  it('POST /purchase-suggestions/:id/convert cannot convert company B\'s suggestion', async () => {
    // The most serious of the set: this created a purchase COMMITMENT in company A
    // against company B's reorder signal, and flipped B's suggestion so their own
    // buyer would never see it again.
    const res = await request(A).post(`/adv/purchase-suggestions/${ids.sugB}/convert`).send({});
    expect(res.status).toBe(404);

    const { rows: [after] } = await pool.query(
      `SELECT status, converted_to_pr_id FROM purchase_suggestions WHERE id = $1`, [ids.sugB]);
    expect(after.status).toBe('pending');
    expect(after.converted_to_pr_id).toBeNull();

    const { rows: [prs] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM purchase_requests WHERE source_suggestion_id = $1`, [ids.sugB]);
    expect(prs.n).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Advanced Inventory · a cross-tenant id is indistinguishable from a missing one', () => {
  it('reports 404, not 403, so the endpoint is not an existence oracle', async () => {
    const real    = await request(A).put(`/adv/batches/${ids.batchB}/consume`).send({ quantity: 1 });
    const fantasy = await request(A).put(`/adv/batches/999999999/consume`).send({ quantity: 1 });
    expect(real.status).toBe(404);
    expect(fantasy.status).toBe(404);
    // Same status AND same message: a different wording is a side channel.
    expect(real.body.error).toBe(fantasy.body.error);
  });
});

/** One numeric column of one row, as a float. */
async function qty(table, column, id) {
  const { rows } = await pool.query(`SELECT ${column}::float AS v FROM ${table} WHERE id = $1`, [id]);
  return rows[0]?.v ?? null;
}
