/**
 * integration.freightWeight.test.js — §216 tonne-km freight against the REAL
 * database and the real routers: maker-checker rate cards, lanes, item weights,
 * the three consumers (RFQ comparison, Component 360, PO advisory), cross-company
 * isolation, missing inputs, FX on rate cards, and award immutability.
 *
 * Throwaway companies only (TAG ZZFRTWT). No live item, RFQ, PO, vendor, lane,
 * rate or award row is read or written. ⚠ Each award consumes one value of the
 * global seq_po_purch sequence. Permission middleware is a stub that grants the
 * exact `module:action` pairs a test user carries.
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

const grants = (req, key) => (req.user?.grants || []).includes(key);
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requirePermission: (m, a) => (req, res, next) =>
    grants(req, `${m}:${a}`) ? next() : res.status(403).json({ error: `needs ${m}:${a}` }) };
});
vi.mock('../modules/procurement/procurement.authz.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requireProcurement: (a) => (req, res, next) =>
    grants(req, `procurement:${a}`) ? next() : res.status(403).json({ error: `needs procurement:${a}` }) };
});

const { default: pool }              = await import('../config/db.js');
const { default: procurementRouter } = await import('../modules/procurement/routes/procurement.routes.js');
const { default: inventoryRouter }   = await import('../modules/inventory/routes/inventory.routes.js');
const migration                      = await import('../database/migrations/20261031000001_freight_weight_lanes_rates.js');

const TAG = 'ZZFRTWT';
const ALL = ['procurement:view', 'procurement:add', 'procurement:edit', 'procurement:approve',
             'inventory:view', 'inventory:edit', 'finance:view'];

function appAs(companyId, userId, grantList = ALL) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, id: userId, role: 'admin', roles: ['admin'], company_id: companyId, grants: grantList };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/procurement', procurementRouter);
  app.use('/inventory', inventoryRouter);
  return app;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  const users = `SELECT id FROM users WHERE email LIKE '${TAG.toLowerCase()}.%@example.com'`;
  if (co.length) {
    const rfqs = `(SELECT id FROM rfqs WHERE company_id = ANY($1))`;
    const pos  = `(SELECT id FROM purchase_orders WHERE company_id = ANY($1))`;
    await pool.query(`DELETE FROM procurement_award_decisions WHERE company_id = ANY($1) OR rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN ${pos}`, [co]);
    await pool.query(`DELETE FROM purchase_orders WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM rfq_quotes WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfq_items WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfqs WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM freight_lanes WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM freight_rate_cards WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM forex_rate_history WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM procurement_settings WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM item_vendor_prices WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
    await pool.query(`DELETE FROM inventory_items WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM warehouses WHERE company_id = ANY($1)`, [co]);
  }
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE email LIKE '${TAG.toLowerCase()}.%@example.com'`);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const mkCompany = async (s) => (await q1(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`])).id;
const mkUser = async (s, co) => (await q1(
  `INSERT INTO users (name, email, password_hash, role, is_active, company_id) VALUES ($1,$2,'x','admin',true,$3) RETURNING id`,
  [`${TAG} ${s}`, `${TAG.toLowerCase()}.${s}@example.com`, co])).id;
const mkVendor = async (co, name) => (await q1(`INSERT INTO vendors (vendor_name, company_id, city) VALUES ($1,$2,'Chennai') RETURNING id`, [name, co])).id;
const mkWh = async (co, name) => (await q1(`INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1,$1,$2) RETURNING id`, [name, co])).id;
const mkItem = async (co, code, cols = {}) => {
  const all = { item_code: `${TAG}-${co}-${code}`, item_name: `${TAG} ${code}`, company_id: co, unit_of_measure: 'NOS', standard_cost: 100, ...cols };
  const k = Object.keys(all);
  return (await q1(`INSERT INTO inventory_items (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, k.map(x => all[x]))).id;
};
const mkRfq = async (co, n, lines) => {
  const id = (await q1(`INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id) VALUES ($1,$2,100,'sent',$3) RETURNING id`,
    [`${TAG}-${co}-${n}`, `${TAG} rfq ${n}`, co])).id;
  for (const l of lines) await pool.query(`INSERT INTO rfq_items (rfq_id, item_id, item_name, quantity, unit) VALUES ($1,$2,$3,$4,'NOS')`, [id, l.item_id, l.name, l.qty]);
  return id;
};
const quote = (co, user, rfq, vendor, body) => request(appAs(co, user)).post(`/procurement/rfqs/${rfq}/responses/${vendor}`).send(body);

let A, B, maker, checker, otherUser, whA, whA2, whB, vLane, vNoLane, vB, itemW, itemNoW, itemB, cardRoad;

beforeAll(async () => {
  await sweep();
  A = await mkCompany('A'); B = await mkCompany('B');
  maker = await mkUser('maker', A); checker = await mkUser('checker', A); otherUser = await mkUser('other', B);
  whA = await mkWh(A, `${TAG} Main A`); whA2 = await mkWh(A, `${TAG} Second A`); whB = await mkWh(B, `${TAG} Main B`);
  vLane = await mkVendor(A, `${TAG} Lane Vendor`); vNoLane = await mkVendor(A, `${TAG} No-Lane Vendor`); vB = await mkVendor(B, `${TAG} B Vendor`);
  itemW = await mkItem(A, 'W', { shipping_weight_kg: 2.5, shipping_weight_basis: 'observed', shipping_weight_uom: 'NOS', freight_category: 'General' });
  itemNoW = await mkItem(A, 'NOW');
  itemB = await mkItem(B, 'B', { shipping_weight_kg: 1, shipping_weight_basis: 'observed', shipping_weight_uom: 'NOS', freight_category: 'General' });
  // Company A: main receiving point, assumed freight OFF so "incomplete" is visible.
  const s = await request(appAs(A, maker)).put('/procurement/settings')
    .send({ main_receiving_warehouse_id: whA, tco_assumed_freight_enabled: false });
  if (s.status !== 200) throw new Error(`settings ${s.status} ${JSON.stringify(s.body)}`);
}, 60000);

afterAll(async () => { await sweep(); });

describe('rate cards: maker-checker', () => {
  it('a draft needs procurement:edit', async () => {
    const r = await request(appAs(A, maker, ['procurement:view'])).post('/procurement/freight/rate-cards')
      .send({ transport_mode: 'road', rate_per_tonne_km: 3, currency: 'INR', effective_from: '2026-01-01' });
    expect(r.status).toBe(403);
  });

  it('creates a DRAFT; the maker cannot approve it', async () => {
    const r = await request(appAs(A, maker)).post('/procurement/freight/rate-cards')
      .send({ transport_mode: 'road', freight_category: 'general', rate_per_tonne_km: 3, currency: 'inr', effective_from: '2026-01-01', source: 'Transporter contract TC-1' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'draft', freight_category: 'General', currency: 'INR' });
    cardRoad = r.body.data.id;
    const self = await request(appAs(A, maker)).post(`/procurement/freight/rate-cards/${cardRoad}/approve`);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('SELF_APPROVAL');
  });

  it('approval needs procurement:approve, not edit', async () => {
    const r = await request(appAs(A, checker, ['procurement:view', 'procurement:edit'])).post(`/procurement/freight/rate-cards/${cardRoad}/approve`);
    expect(r.status).toBe(403);
  });

  it('a different approver approves it', async () => {
    const r = await request(appAs(A, checker)).post(`/procurement/freight/rate-cards/${cardRoad}/approve`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'approved', approved_by_user_id: checker, entered_by_user_id: maker });
  });

  it('an approved rate cannot be edited in place — the database refuses', async () => {
    await expect(pool.query(`UPDATE freight_rate_cards SET rate_per_tonne_km = 1 WHERE id = $1`, [cardRoad]))
      .rejects.toThrow(/cannot change — create a new version/);
  });

  it('rejects an unknown freight category', async () => {
    const r = await request(appAs(A, maker)).post('/procurement/freight/rate-cards')
      .send({ transport_mode: 'road', freight_category: 'Explosive Gold', rate_per_tonne_km: 3, currency: 'INR', effective_from: '2026-01-01' });
    expect(r.status).toBe(422);
  });

  it('rejecting needs a note; a rejected card is final', async () => {
    const d = (await request(appAs(A, maker)).post('/procurement/freight/rate-cards')
      .send({ transport_mode: 'rail', rate_per_tonne_km: 1.2, currency: 'INR', effective_from: '2026-01-01' })).body.data.id;
    expect((await request(appAs(A, checker)).post(`/procurement/freight/rate-cards/${d}/reject`)).status).toBe(422);
    expect((await request(appAs(A, checker)).post(`/procurement/freight/rate-cards/${d}/reject`).send({ note: 'Rate not contracted' })).status).toBe(200);
    expect((await request(appAs(A, checker)).post(`/procurement/freight/rate-cards/${d}/approve`)).status).toBe(409);
  });

  it("company B cannot see or approve company A's cards", async () => {
    expect((await request(appAs(B, otherUser)).post(`/procurement/freight/rate-cards/${cardRoad}/approve`)).status).toBe(404);
    const list = await request(appAs(B, otherUser)).get('/procurement/freight/rate-cards');
    expect(list.body.data.some(c => c.id === cardRoad)).toBe(false);
  });
});

describe('lanes', () => {
  it('a person must state the distance source — there is no default', async () => {
    const r = await request(appAs(A, maker)).put('/procurement/freight/lanes')
      .send({ vendor_id: vLane, warehouse_id: whA, distance_km: 400 });
    expect(r.status).toBe(422);
  });

  it('saves a confirmed lane with who confirmed it', async () => {
    const r = await request(appAs(A, maker)).put('/procurement/freight/lanes')
      .send({ vendor_id: vLane, warehouse_id: whA, distance_km: 400, distance_source: 'observed', default_transport_mode: 'road' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ distance_source: 'observed', confirmed_by_user_id: maker, default_transport_mode: 'road' });
  });

  it('refuses another company\'s vendor or warehouse', async () => {
    expect((await request(appAs(A, maker)).put('/procurement/freight/lanes')
      .send({ vendor_id: vB, warehouse_id: whA, distance_km: 10, distance_source: 'manual' })).status).toBe(404);
    expect((await request(appAs(A, maker)).put('/procurement/freight/lanes')
      .send({ vendor_id: vLane, warehouse_id: whB, distance_km: 10, distance_source: 'manual' })).status).toBe(404);
  });

  it('the straight-line suggestion is labelled an estimate and writes nothing', async () => {
    await pool.query(`UPDATE warehouses SET latitude = 12.9716, longitude = 77.5946 WHERE id = $1`, [whA2]);
    const before = (await q1(`SELECT COUNT(*)::int AS n FROM freight_lanes WHERE company_id = $1`, [A])).n;
    const r = await request(appAs(A, maker)).get(`/procurement/freight/lanes/suggest-distance?vendor_id=${vLane}&warehouse_id=${whA2}`);
    expect(r.status).toBe(200);
    if (r.body.suggestion) {
      expect(r.body.suggestion).toMatchObject({ method: 'great_circle', source_if_accepted: 'estimated' });
      expect(r.body.suggestion.distance_km).toBeGreaterThan(0);
    } else {
      expect(r.body.reason).toMatch(/coordinates/);
    }
    expect((await q1(`SELECT COUNT(*)::int AS n FROM freight_lanes WHERE company_id = $1`, [A])).n).toBe(before);
  });
});

describe('settings and item master', () => {
  it("the main receiving point must be the company's own warehouse", async () => {
    const r = await request(appAs(A, maker)).put('/procurement/settings').send({ main_receiving_warehouse_id: whB });
    expect(r.status).toBe(422);
  });

  it('a weight without a basis is refused; with one, the unit is stored explicitly', async () => {
    const bad = await request(appAs(A, maker)).put(`/inventory/items/${itemNoW}`).send({ shipping_weight_kg: 4 });
    expect(bad.status).toBe(422);
    const ok = await request(appAs(A, maker)).put(`/inventory/items/${itemNoW}`).send({ shipping_weight_kg: 4, shipping_weight_basis: 'estimated' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ shipping_weight_basis: 'estimated', shipping_weight_uom: 'NOS' });
    // Put it back to "unknown": blank clears weight, basis and unit together.
    const clr = await request(appAs(A, maker)).put(`/inventory/items/${itemNoW}`).send({ shipping_weight_kg: '' });
    expect(clr.body).toMatchObject({ shipping_weight_kg: null, shipping_weight_basis: null, shipping_weight_uom: null });
  });

  it('a freight category must come from the master', async () => {
    expect((await request(appAs(A, maker)).put(`/inventory/items/${itemNoW}`).send({ freight_category: 'Glitter' })).status).toBe(422);
  });
});

describe('consumer 1 — RFQ comparison', () => {
  let rfq;
  beforeAll(async () => {
    rfq = await mkRfq(A, 1, [{ item_id: itemW, name: 'W', qty: 100 }]);
    await quote(A, maker, rfq, vLane, { unit_price: 100, total_amount: 10000, currency: 'INR' });
    await quote(A, maker, rfq, vNoLane, { unit_price: 90, total_amount: 9000, currency: 'INR' });
  });

  it('models freight for the vendor with a lane: 100 x 2.5 kg / 1000 x 400 km x Rs 3 = Rs 300', async () => {
    const r = await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`);
    const q = r.body.quotes.find(x => Number(x.vendor_id) === vLane);
    expect(q.tco.freight).toMatchObject({ source: 'modelled', amount: 300 });
    expect(q.tco.freight.model).toMatchObject({ distance_km: 400, distance_source: 'observed', transport_mode: 'road', receiving_warehouse_id: whA });
    expect(q.tco.freight.model.lines[0]).toMatchObject({ weight_basis: 'observed', rate_card_id: cardRoad, rate_per_tonne_km: 3 });
  });

  it('the vendor without a lane is INCOMPLETE, never wins, and no recommendation is made', async () => {
    const r = await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`);
    const q = r.body.quotes.find(x => Number(x.vendor_id) === vNoLane);
    expect(q.tco.completeness).toBe('incomplete');
    expect(q.tco.freight.missing[0].input).toBe('distance');
    expect(r.body.tco_comparison).toMatchObject({ comparison_status: 'incomplete', best_tco_vendor_id: null });
    expect(r.body.tco_comparison.recommendation.status).toBe('withheld_incomplete');
    expect(r.body.quotes.every(x => x.is_lowest_tco !== true)).toBe(true);
  });

  it('a multi-line RFQ with an unweighed line names that item and quantity', async () => {
    const multi = await mkRfq(A, 2, [{ item_id: itemW, name: 'W', qty: 100 }, { item_id: itemNoW, name: 'NOW', qty: 30 }]);
    await quote(A, maker, multi, vLane, { unit_price: 100, total_amount: 13000, currency: 'INR' });
    await quote(A, maker, multi, vNoLane, { unit_price: 95, total_amount: 12350, currency: 'INR' });
    const r = await request(appAs(A, maker)).get(`/procurement/rfqs/${multi}`);
    const q = r.body.quotes.find(x => Number(x.vendor_id) === vLane);
    expect(q.tco.completeness).toBe('incomplete');
    expect(q.tco.freight.missing).toContainEqual(expect.objectContaining({ input: 'weight', item_id: itemNoW, quantity: 30 }));
    expect(q.tco.freight.model.amount).toBeNull();
  });

  it('a quoted weight per unit (single-line RFQ) beats the item master, labelled quoted', async () => {
    await quote(A, maker, rfq, vLane, { unit_price: 100, total_amount: 10000, currency: 'INR', shipping_weight_kg_per_unit: 5, shipping_weight_uom: 'NOS' });
    const r = await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`);
    const q = r.body.quotes.find(x => Number(x.vendor_id) === vLane);
    expect(q.tco.freight.amount).toBe(600);                 // 0.5 t x 400 x 3
    expect(q.tco.freight.model.lines[0].weight_basis).toBe('quoted');
    await quote(A, maker, rfq, vLane, { unit_price: 100, total_amount: 10000, currency: 'INR' });
  });

  it('assumed freight ON → the lane-less vendor is PROVISIONAL, labelled, and ranks', async () => {
    await request(appAs(A, maker)).put('/procurement/settings').send({ tco_assumed_freight_enabled: true });
    const r = await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`);
    const q = r.body.quotes.find(x => Number(x.vendor_id) === vNoLane);
    expect(q.tco).toMatchObject({ completeness: 'provisional' });
    expect(q.tco.freight.source).toBe('assumed');
    expect(r.body.tco_comparison.comparison_status).toBe('provisional');
    expect(r.body.tco_comparison.recommendation.status).toBe('provisional');
    await request(appAs(A, maker)).put('/procurement/settings').send({ tco_assumed_freight_enabled: false });
  });
});

describe('consumer 2 — Component 360', () => {
  it('costs freight per vendor through the same loader', async () => {
    await pool.query(`INSERT INTO item_vendor_prices (item_id, vendor_id, unit_price, currency, company_id) VALUES ($1,$2,100,'INR',$3),($1,$4,90,'INR',$3)`,
      [itemW, vLane, A, vNoLane]);
    const r = await request(appAs(A, maker)).get(`/inventory/catalog/items/${itemW}/sourcing?qty=100`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const withLane = r.body.vendors.find(v => v.vendor_id === vLane);
    const noLane = r.body.vendors.find(v => v.vendor_id === vNoLane);
    expect(withLane.tco.freight).toMatchObject({ source: 'modelled', amount: 300 });
    expect(noLane.tco_completeness).toBe('incomplete');
    expect(r.body.summary.tco_comparison_status).toBe('incomplete');
  });
});

describe('consumer 3 — PO advisory', () => {
  it('costs the chosen vendor with the same freight model', async () => {
    const r = await request(appAs(A, maker)).post('/procurement/tco/advisory')
      .send({ vendor_id: vLane, lines: [{ item_id: itemW, quantity: 100, rate: 100 }] });
    expect(r.status).toBe(200);
    expect(r.body.lines[0].chosen_freight).toMatchObject({ source: 'modelled', amount: 300 });
    expect(r.body.comparison_status).toBe('incomplete');      // the lane-less alternative
  });
});

describe('cross-company isolation', () => {
  it("company A's loader never uses company B's lane, card, item or vendor", async () => {
    await pool.query(`INSERT INTO procurement_settings (company_id, main_receiving_warehouse_id) VALUES ($1,$2)`, [B, whB]);
    await pool.query(`INSERT INTO freight_lanes (company_id, vendor_id, warehouse_id, distance_km, distance_source, default_transport_mode, confirmed_by_user_id)
                      VALUES ($1,$2,$3,50,'manual','road',$4)`, [B, vB, whB, otherUser]);
    // B asking for A's item through the advisory gets no freight from A's data.
    const r = await request(appAs(B, otherUser)).post('/procurement/tco/advisory')
      .send({ vendor_id: vB, lines: [{ item_id: itemW, quantity: 100, rate: 100 }] });
    expect(JSON.stringify(r.body)).not.toContain(`${TAG} Lane Vendor`);
    const lanesA = await request(appAs(A, maker)).get('/procurement/freight/lanes');
    expect(lanesA.body.data.every(l => l.company_id === A)).toBe(true);
  });

  it("a lane row OWNED by company B is ignored for A, even if it names A's vendor and warehouse", async () => {
    // Inconsistent on purpose (the route would refuse it): only the company
    // filter in the loader keeps it out of A's comparisons.
    await pool.query(`INSERT INTO freight_lanes (company_id, vendor_id, warehouse_id, distance_km, distance_source, default_transport_mode, confirmed_by_user_id)
                      VALUES ($1,$2,$3,1,'manual','road',$4)`, [B, vNoLane, whA, otherUser]);
    const rfq = await mkRfq(A, 6, [{ item_id: itemW, name: 'W', qty: 100 }]);
    await quote(A, maker, rfq, vNoLane, { unit_price: 90, total_amount: 9000 });
    const q = (await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`)).body.quotes[0];
    expect(q.tco.completeness).toBe('incomplete');
    expect(q.tco.freight.model.lane_id).toBeNull();
    await pool.query(`DELETE FROM freight_lanes WHERE company_id = $1 AND vendor_id = $2`, [B, vNoLane]);
  });
});

describe('FX on a foreign-currency rate card', () => {
  it('no approved USD rate → freight input missing "fx"; approved → converted and recorded', async () => {
    const usdCard = (await request(appAs(A, maker)).post('/procurement/freight/rate-cards')
      .send({ transport_mode: 'ship', rate_per_tonne_km: 0.05, currency: 'USD', effective_from: '2026-01-01' })).body.data.id;
    await request(appAs(A, checker)).post(`/procurement/freight/rate-cards/${usdCard}/approve`);
    const rfq = await mkRfq(A, 3, [{ item_id: itemW, name: 'W', qty: 100 }]);
    await quote(A, maker, rfq, vLane, { unit_price: 100, total_amount: 10000, transport_mode: 'ship' });
    await quote(A, maker, rfq, vNoLane, { unit_price: 99, total_amount: 9900 });
    let q = (await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`)).body.quotes.find(x => Number(x.vendor_id) === vLane);
    expect(q.tco.freight.missing[0]).toMatchObject({ input: 'fx' });
    await pool.query(`INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source, status, approved_by_user_id, approved_at)
                      VALUES ($1,'USD',84,CURRENT_DATE,'rbi','approved',$2,NOW())`, [A, checker]);
    q = (await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`)).body.quotes.find(x => Number(x.vendor_id) === vLane);
    // 0.25 t x 400 km x (0.05 USD x 84) = 420
    expect(q.tco.freight).toMatchObject({ source: 'modelled', amount: 420 });
    expect(q.tco.freight.model.lines[0].rate_fx).toMatchObject({ rate: 84, from: 'USD', to: 'INR' });
  });
});

describe('awards — incomplete allowed, and immutable', () => {
  it('an award on an INCOMPLETE comparison is recorded as such, not as followed', async () => {
    const rfq = await mkRfq(A, 4, [{ item_id: itemW, name: 'W', qty: 100 }]);
    await quote(A, maker, rfq, vLane, { unit_price: 100, total_amount: 10000 });
    await quote(A, maker, rfq, vNoLane, { unit_price: 90, total_amount: 9000 });
    const r = await request(appAs(A, checker)).patch(`/procurement/rfqs/${rfq}/award/${vLane}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = await q1(`SELECT * FROM procurement_award_decisions WHERE rfq_id = $1`, [rfq]);
    expect(d).toMatchObject({ comparison_status: 'incomplete', recommendation_status: 'withheld_incomplete', followed_recommendation: null });
    const missing = d.tco_basis.freight_applied.find(f => Number(f.vendor_id) === vNoLane).freight.missing;
    expect(missing[0].input).toBe('distance');
  });

  it('later changes to weight, lane, rate card and FX do not alter a frozen award', async () => {
    const rfq = await mkRfq(A, 5, [{ item_id: itemW, name: 'W', qty: 100 }]);
    await quote(A, maker, rfq, vLane, { unit_price: 100, total_amount: 10000 });
    const r = await request(appAs(A, checker)).patch(`/procurement/rfqs/${rfq}/award/${vLane}`);
    expect(r.status).toBe(200);
    const before = await q1(`SELECT tco_breakdown, tco_basis, comparison_status, recommendation_status FROM procurement_award_decisions WHERE rfq_id = $1`, [rfq]);
    expect(before.comparison_status).toBe('complete');
    expect(before.tco_breakdown.freight).toMatchObject({ source: 'modelled', amount: 300 });

    await request(appAs(A, maker)).put(`/inventory/items/${itemW}`).send({ shipping_weight_kg: 9, shipping_weight_basis: 'estimated' });
    await request(appAs(A, maker)).put('/procurement/freight/lanes')
      .send({ vendor_id: vLane, warehouse_id: whA, distance_km: 999, distance_source: 'manual', default_transport_mode: 'road' });
    await request(appAs(A, checker)).post(`/procurement/freight/rate-cards/${cardRoad}/retire`);
    await pool.query(`UPDATE forex_rate_history SET rate_vs_inr = 99 WHERE company_id = $1`, [A]);

    const after = await q1(`SELECT tco_breakdown, tco_basis, comparison_status, recommendation_status FROM procurement_award_decisions WHERE rfq_id = $1`, [rfq]);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // …while a live re-read of the same RFQ now sees the new inputs.
    const live = (await request(appAs(A, maker)).get(`/procurement/rfqs/${rfq}`)).body.quotes[0];
    expect(live.tco.freight.model.distance_km).toBe(999);
  });
});

describe('migration rollback safety', () => {
  it('down() refuses while freight data exists (run inside a rolled-back transaction)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const shim = { raw: (sql, b) => client.query(sql, b || []) };
      await expect(migration.down(shim)).rejects.toThrow(/Freight data exists/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await q1(`SELECT to_regclass('freight_lanes') AS t`)).t).toBe('freight_lanes');
  });
});
