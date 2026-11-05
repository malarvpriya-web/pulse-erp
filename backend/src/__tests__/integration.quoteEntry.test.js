/**
 * integration.quoteEntry.test.js — §219: the RFQ quote-entry endpoints behind
 * the dialog (GET/PUT /procurement/rfqs/:rfqId/quotes/:quoteId), and how what
 * is entered flows into the TCO comparison.
 *
 * Covers: create (first fill of an invited placeholder), edit, validation,
 * invited-vendor restriction, permissions, company isolation, closed/draft
 * RFQ refusal, freight in a different currency (approved / unusable — and no
 * fall-through to modelled freight), freight per unit, quoted weight UOM, and
 * the award snapshot. Throwaway companies only (TAG ZZRQENTRY). PO numbers come
 * from the test-only generator (§218). No live data is read or written.
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
const migration                      = await import('../database/migrations/20261031000002_rfq_quote_entry_fields.js');

const TAG = 'ZZRQENTRY';
const ALL = ['procurement:view', 'procurement:edit', 'procurement:approve'];
function appAs(companyId, userId, g = ALL) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId, id: userId, role: 'admin', roles: ['admin'], company_id: companyId, grants: g };
    req.scope = { company_id: companyId };
    next();
  });
  a.use('/procurement', procurementRouter);
  return a;
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
    await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
    await pool.query(`DELETE FROM inventory_items WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM warehouses WHERE company_id = ANY($1)`, [co]);
  }
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE email LIKE '${TAG.toLowerCase()}.%@example.com'`);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

let A, B, u, uB, vA, vA2, vB, item, wh, rfq, multiRfq, qA, qA2, qMulti, qB, rfqB;
const mkRfq = async (co, n, status, lines) => {
  const id = (await one(`INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id) VALUES ($1,'p',100,$2,$3) RETURNING id`,
    [`${TAG}-${co}-${n}`, status, co])).id;
  for (const l of lines) await pool.query(`INSERT INTO rfq_items (rfq_id, item_id, item_name, quantity, unit) VALUES ($1,$2,$3,$4,'NOS')`, [id, l.item_id, l.name, l.qty]);
  return id;
};
// What send-to-vendors creates: an invited, empty quote row.
const invite = async (rfqId, vendorId) => (await one(`INSERT INTO rfq_quotes (rfq_id, vendor_id) VALUES ($1,$2) RETURNING id`, [rfqId, vendorId])).id;
const put = (co, user, rfqId, quoteId, body, g) => request(appAs(co, user, g)).put(`/procurement/rfqs/${rfqId}/quotes/${quoteId}`).send(body);

beforeAll(async () => {
  await sweep();
  A = (await one(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} A`, `${TAG}A`])).id;
  B = (await one(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} B`, `${TAG}B`])).id;
  u  = (await one(`INSERT INTO users (name,email,password_hash,role,is_active,company_id) VALUES ($1,$2,'x','admin',true,$3) RETURNING id`, [`${TAG} u`, `${TAG.toLowerCase()}.u@example.com`, A])).id;
  uB = (await one(`INSERT INTO users (name,email,password_hash,role,is_active,company_id) VALUES ($1,$2,'x','admin',true,$3) RETURNING id`, [`${TAG} b`, `${TAG.toLowerCase()}.b@example.com`, B])).id;
  vA  = (await one(`INSERT INTO vendors (vendor_name, company_id) VALUES ('${TAG} V1',$1) RETURNING id`, [A])).id;
  vA2 = (await one(`INSERT INTO vendors (vendor_name, company_id) VALUES ('${TAG} V2',$1) RETURNING id`, [A])).id;
  vB  = (await one(`INSERT INTO vendors (vendor_name, company_id) VALUES ('${TAG} VB',$1) RETURNING id`, [B])).id;
  item = (await one(`INSERT INTO inventory_items (item_code,item_name,company_id,unit_of_measure,standard_cost,shipping_weight_kg,shipping_weight_basis,shipping_weight_uom,freight_category)
                     VALUES ($1,$2,$3,'NOS',100,2.5,'observed','NOS','General') RETURNING id`, [`${TAG}-1`, `${TAG} part`, A])).id;
  wh = (await one(`INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1,$1,$2) RETURNING id`, [`${TAG} DC`, A])).id;
  await pool.query(`INSERT INTO procurement_settings (company_id, main_receiving_warehouse_id, tco_assumed_freight_enabled) VALUES ($1,$2,false)`, [A, wh]);
  // A complete freight MODEL exists for vA, so "no fall-through" is provable.
  await pool.query(`INSERT INTO freight_lanes (company_id,vendor_id,warehouse_id,distance_km,distance_source,default_transport_mode,confirmed_by_user_id) VALUES ($1,$2,$3,400,'observed','road',$4)`, [A, vA, wh, u]);
  await pool.query(`INSERT INTO freight_rate_cards (company_id,transport_mode,rate_per_tonne_km,currency,effective_from,status,entered_by_user_id,approved_by_user_id,approved_at)
                    VALUES ($1,'road',3,'INR',CURRENT_DATE-1,'approved',$2,$3,NOW())`, [A, u, uB]);
  rfq = await mkRfq(A, 1, 'sent', [{ item_id: item, name: 'p', qty: 100 }]);
  multiRfq = await mkRfq(A, 2, 'sent', [{ item_id: item, name: 'p', qty: 100 }, { item_id: item, name: 'p2', qty: 10 }]);
  rfqB = await mkRfq(B, 1, 'sent', []);
  qA = await invite(rfq, vA); qA2 = await invite(rfq, vA2); qMulti = await invite(multiRfq, vA); qB = await invite(rfqB, vB);
}, 60000);
afterAll(async () => { await sweep(); });

const full = (over = {}) => ({
  unit_price: 100, total_amount: 10000, currency: 'INR', delivery_days: 14, payment_terms: 'Net 30',
  valid_until: '2026-12-31', vendor_quote_ref: 'VQ-2026-0042', quote_date: '2026-10-28', notes: 'as per drawing rev B',
  freight_amount: 1500, freight_per_unit: '', freight_currency: '', insurance_amount: 100, duty_amount: '',
  packaging_amount: 50, other_charges: '', shipping_weight_kg_per_unit: 2.6, shipping_weight_uom: 'NOS',
  transport_mode: 'road', service_level: 'FTL', ...over,
});

describe('create and edit an invited vendor\'s quote', () => {
  it('records the first quote on the invited placeholder, exactly as entered', async () => {
    const r = await put(A, u, rfq, qA, full());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ vendor_quote_ref: 'VQ-2026-0042', quote_date: '2026-10-28', valid_until: '2026-12-31',
      transport_mode: 'road', service_level: 'FTL', shipping_weight_uom: 'NOS', currency: 'INR', freight_per_unit: null });
    expect(Number(r.body.data.freight_amount)).toBe(1500);
    expect((await one(`SELECT status FROM rfqs WHERE id=$1`, [rfq])).status).toBe('responses_received');
  });

  it('GET returns the COMPLETE stored quote for the dialog to start from', async () => {
    const r = await request(appAs(A, u)).get(`/procurement/rfqs/${rfq}/quotes/${qA}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ vendor_quote_ref: 'VQ-2026-0042', notes: 'as per drawing rev B', line_count: 1, line_unit: 'NOS' });
    expect(Number(r.body.data.insurance_amount)).toBe(100);
  });

  it('an edit replaces the quote with what the form sends (and blank stays NULL, never 0)', async () => {
    const r = await put(A, u, rfq, qA, full({ unit_price: 95, packaging_amount: '' }));
    expect(Number(r.body.data.unit_price)).toBe(95);
    expect(r.body.data.packaging_amount).toBeNull();
    expect(r.body.data.vendor_quote_ref).toBe('VQ-2026-0042');
  });
});

describe('validation', () => {
  it.each([
    ['freight amount AND per unit', { freight_amount: 10, freight_per_unit: 1 }, 422, 'freight_per_unit'],
    ['freight currency with no freight', { freight_amount: '', freight_currency: 'EUR' }, 422, 'freight_currency'],
    ['weight without its unit', { shipping_weight_uom: '' }, 422, 'shipping_weight_uom'],
    ['no price at all', { unit_price: '', total_amount: '' }, 422, 'unit_price'],
    ['negative price', { unit_price: -1 }, 400, 'unit_price'],
    ['expiry before issue', { quote_date: '2026-11-30', valid_until: '2026-11-01' }, 422, 'valid_until'],
    ['not an ISO currency', { currency: 'Rupees' }, 400, 'currency'],
    ['unknown transport mode', { transport_mode: 'teleport' }, 400, 'transport_mode'],
    ['bad service level', { service_level: 'XXL' }, 400, 'service_level'],
  ])('refuses %s', async (_label, over, status, field) => {
    const r = await put(A, u, rfq, qA2, full(over));
    expect(r.status).toBe(status);
    expect(r.body.field).toBe(field);
  });

  it('a quoted weight per unit is refused on a multi-line RFQ (it would be silently ignored)', async () => {
    const r = await put(A, u, multiRfq, qMulti, full());
    expect(r.status).toBe(422);
    expect(r.body.field).toBe('shipping_weight_kg_per_unit');
  });
});

describe('who and where', () => {
  it('needs procurement:edit (view is not enough)', async () => {
    expect((await put(A, u, rfq, qA2, full(), ['procurement:view'])).status).toBe(403);
  });

  it('invited vendors only: a quote id that is not on this RFQ is 404', async () => {
    expect((await put(A, u, rfq, qMulti, full())).status).toBe(404);
  });

  it("company B cannot read or write company A's quote, nor A B's", async () => {
    expect((await request(appAs(B, uB)).get(`/procurement/rfqs/${rfq}/quotes/${qA}`)).status).toBe(404);
    expect((await put(B, uB, rfq, qA, full())).status).toBe(404);
    expect((await put(A, u, rfqB, qB, full())).status).toBe(404);
  });

  it('a closed or draft RFQ refuses quotes', async () => {
    const closed = await mkRfq(A, 3, 'closed', [{ item_id: item, name: 'p', qty: 100 }]);
    const q = await invite(closed, vA);
    expect((await put(A, u, closed, q, full())).body.code).toBe('RFQ_NOT_OPEN');
    const draft = await mkRfq(A, 4, 'draft', [{ item_id: item, name: 'p', qty: 100 }]);
    const qd = await invite(draft, vA);
    expect((await put(A, u, draft, qd, full())).status).toBe(409);
  });
});

describe('TCO integration', () => {
  const view = async () => (await request(appAs(A, u)).get(`/procurement/rfqs/${rfq}`)).body;
  const quoteOf = (body, vendor) => body.quotes.find(q => Number(q.vendor_id) === vendor);

  it('quoted freight per unit is used as quoted freight (engine precedence unchanged)', async () => {
    await put(A, u, rfq, qA, full({ freight_amount: '', freight_per_unit: 12 }));
    const t = quoteOf(await view(), vA).tco;
    expect(t.freight).toMatchObject({ source: 'quoted', amount: 1200 });        // 12 x 100 units
  });

  it('freight in another currency WITH an approved rate is restated: 100 EUR x 96 = Rs 9,600', async () => {
    await pool.query(`INSERT INTO forex_rate_history (company_id,currency_code,rate_vs_inr,rate_date,source,status,approved_by_user_id,approved_at)
                      VALUES ($1,'EUR',96,CURRENT_DATE,'rbi','approved',$2,NOW())`, [A, uB]);
    await put(A, u, rfq, qA, full({ freight_amount: 100, freight_currency: 'EUR' }));
    const t = quoteOf(await view(), vA).tco;
    expect(t.freight).toMatchObject({ source: 'quoted', amount: 9600 });
    expect(t.freight.fx).toMatchObject({ from: 'EUR', to: 'INR', rate_to_base: 96, as_quoted: { freight_amount: 100, currency: 'EUR' } });
    // Stored exactly as the vendor wrote it.
    const row = await one(`SELECT freight_amount, freight_currency FROM rfq_quotes WHERE id=$1`, [qA]);
    expect(row).toEqual({ freight_amount: '100.00', freight_currency: 'EUR' });
  });

  it('freight in a currency with NO usable rate: not costed, NOT replaced by the model, comparison incomplete', async () => {
    await put(A, u, rfq, qA, full({ freight_amount: 100, freight_currency: 'GBP' }));
    await put(A, u, rfq, qA2, full({ freight_amount: 500 }));
    const body = await view();
    const t = quoteOf(body, vA).tco;
    // A complete model exists for this vendor (lane + weight + approved card) —
    // it must NOT be used in place of the quoted GBP freight.
    expect(t).toMatchObject({ computable: false, reason: 'no_fx_rate', currency: 'GBP' });
    expect(t.fx_detail.message).toMatch(/Freight quoted in GBP/);
    expect(body.tco_comparison).toMatchObject({ comparison_status: 'incomplete', best_tco_vendor_id: null });
    expect(body.tco_comparison.recommendation.incomplete[0]).toMatchObject({ vendor_id: vA, reason: 'fx' });
  });

  it('a quoted weight per a different unit is reported, not converted', async () => {
    await put(A, u, rfq, qA, full({ freight_amount: '', shipping_weight_uom: 'BOX' }));
    const t = quoteOf(await view(), vA).tco;
    expect(t.freight.missing).toContainEqual(expect.objectContaining({ input: 'weight_uom' }));
  });

  it('the award snapshot freezes the as-quoted freight and its restatement', async () => {
    await put(A, u, rfq, qA, full({ freight_amount: 100, freight_currency: 'EUR' }));
    const r = await request(appAs(A, u)).patch(`/procurement/rfqs/${rfq}/award/${vA}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = await one(`SELECT tco_breakdown FROM procurement_award_decisions WHERE rfq_id=$1`, [rfq]);
    expect(d.tco_breakdown.freight.fx).toMatchObject({ from: 'EUR', as_quoted: { freight_amount: 100 } });
    // …and the closed RFQ now refuses further edits.
    expect((await put(A, u, rfq, qA, full())).status).toBe(409);
  });
});

describe('migration rollback safety', () => {
  it('down() refuses while quote-entry fields hold data (inside a rolled-back transaction)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(migration.down({ raw: (s, b) => client.query(s, b || []) })).rejects.toThrow(/quote-entry data/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
