/**
 * integration.tcoAdvisoryTenant.test.js — §214: the direct-PO TCO advisory and
 * the TCO settings, against the REAL database and the real procurement router.
 *
 * The advisory read `item_vendor_prices`, `inventory_items` and `vendors` by id
 * with no company filter, so company B posting company A's item id was handed
 * A's negotiated prices and vendor names as "a cheaper source". Only the
 * permission gates are stubbed; tenant scope (companyOf) is the real one.
 *
 * Companies are auto-increment with a `ZZFXADV`-coded name, swept on the way in
 * and out (see testTenantIds.contract.test.js for why the TAG must be unique).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requirePermission: () => (_req, _res, next) => next() };
});
vi.mock('../modules/procurement/procurement.authz.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requireProcurement: () => (_req, _res, next) => next() };
});

const { default: pool }              = await import('../config/db.js');
const { default: procurementRouter } = await import('../modules/procurement/routes/procurement.routes.js');
const { loadTcoParams }              = await import('../modules/procurement/services/tco.service.js');

const TAG = 'ZZFXADV';

function appAs(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, role: 'admin', roles: ['admin'], company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/procurement', procurementRouter);
  return app;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;
  await pool.query(`DELETE FROM item_vendor_prices WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM procurement_settings WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
  await pool.query(`DELETE FROM inventory_items WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

const co = async (s) => (await pool.query(
  `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`])).rows[0].id;
const vendor = async (companyId, name) => (await pool.query(
  `INSERT INTO vendors (vendor_name, company_id) VALUES ($1, $2) RETURNING id`, [name, companyId])).rows[0].id;
const price = (companyId, itemId, vendorId, unitPrice, currency = 'INR') => pool.query(
  `INSERT INTO item_vendor_prices (item_id, vendor_id, unit_price, currency, company_id) VALUES ($1,$2,$3,$4,$5)`,
  [itemId, vendorId, unitPrice, currency, companyId]);

let A, B, itemA, vA1, vA2, vB;

beforeAll(async () => {
  await sweep();
  A = await co('A'); B = await co('B');
  itemA = (await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 100) RETURNING id`, [`${TAG}-A-1`, `${TAG} bearing`, A])).rows[0].id;
  vA1 = await vendor(A, `${TAG} A incumbent`);
  vA2 = await vendor(A, `${TAG} A secret cheap source`);
  vB  = await vendor(B, `${TAG} B vendor`);
  await price(A, itemA, vA1, 120);
  await price(A, itemA, vA2, 80);
});

afterAll(async () => {
  await sweep();
});

const advise = (companyId, vendorId) => request(appAs(companyId))
  .post('/procurement/tco/advisory')
  .send({ vendor_id: vendorId, lines: [{ item_id: itemA, quantity: 10, rate: 120 }] });

describe('§214 TCO advisory — tenant isolation', () => {
  it('company A sees its own alternative source', async () => {
    const r = await advise(A, vA1);
    expect(r.status).toBe(200);
    expect(r.body.lines[0].alternative_count).toBe(1);
    expect(r.body.lines[0].best_vendor_id).toBe(vA2);
  });

  it("company B posting A's item id learns nothing about A's price book", async () => {
    const r = await advise(B, vB);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('secret cheap source');
    expect(body).not.toContain(`${TAG} bearing`);
    expect(r.body.lines[0].alternative_count).toBe(0);
    expect(r.body.lines[0].best_vendor_id).toBeNull();
    expect(r.body.advisory).toBeNull();
  });
});

describe('§214 TCO settings — day-count basis', () => {
  it('rejects a basis that is neither 360 nor 365', async () => {
    const r = await request(appAs(A)).put('/procurement/settings').send({ tco_day_count_basis: 364 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/360 or 365/);
  });

  it('stores 360 and the engine parameters read it back', async () => {
    const r = await request(appAs(A)).put('/procurement/settings').send({ tco_day_count_basis: 360 });
    expect(r.status).toBe(200);
    expect(r.body.tco.tco_day_count_basis).toBe(360);
    const p = await loadTcoParams(A);
    expect(p.tco_day_count_basis).toBe(360);
    expect(p.base_currency).toBe('INR');
    // Another company is untouched.
    expect((await loadTcoParams(B)).tco_day_count_basis).toBe(365);
  });
});
