/**
 * integration.fxFoundation.test.js — §215: approved exchange rates, quote
 * overrides, the award's currency, Default Currency and the settings merge,
 * against the REAL database and the real forex + procurement routers.
 *
 * Throwaway companies only (TAG ZZFXRATE, auto-increment ids, swept in and out).
 * No live RFQ, award, PO, rate or price row is read or written.
 * ⚠ Each award consumes one value of the global seq_po_purch sequence.
 *
 * Permission middleware is replaced by a stub that grants exactly the
 * `module:action` pairs a test user carries, so each test proves WHICH grant
 * a route demands (project_authz_probe_method) rather than "admin can".
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
  return {
    ...orig,
    requirePermission: (m, a) => (req, res, next) =>
      grants(req, `${m}:${a}`) ? next() : res.status(403).json({ error: `needs ${m}:${a}` }),
  };
});
vi.mock('../modules/procurement/procurement.authz.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    requireProcurement: (a) => (req, res, next) =>
      grants(req, `procurement:${a}`) ? next() : res.status(403).json({ error: `needs procurement:${a}` }),
  };
});

const { default: pool }              = await import('../config/db.js');
const { default: forexRouter }       = await import('../modules/finance/forex.routes.js');
const { default: procurementRouter } = await import('../modules/procurement/routes/procurement.routes.js');
const { resolveFxRates }             = await import('../modules/finance/services/fxRate.service.js');
const { loadTcoParams, TcoParamsUnavailableError } = await import('../modules/procurement/services/tco.service.js');

const TAG = 'ZZFXRATE';
const ALL = ['finance:view', 'finance:edit', 'finance:approve', 'procurement:view', 'procurement:add',
             'procurement:edit', 'procurement:approve'];

function appAs(companyId, userId, grantList = ALL, roles = ['admin']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, id: userId, role: roles[0], roles, company_id: companyId, grants: grantList };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/forex', forexRouter);
  app.use('/procurement', procurementRouter);
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
    await pool.query(`DELETE FROM forex_rate_history WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM forex_rates WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM procurement_settings WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
    await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1)`, [co]);
  }
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE email LIKE '${TAG.toLowerCase()}.%@example.com'`);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

const mkCompany = async (s) => (await pool.query(
  `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`])).rows[0].id;
const mkUser = async (s, companyId) => (await pool.query(
  `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
   VALUES ($1, $2, 'x', 'admin', true, $3) RETURNING id`,
  [`${TAG} ${s}`, `${TAG.toLowerCase()}.${s}@example.com`, companyId])).rows[0].id;
const mkVendor = async (companyId, name) => (await pool.query(
  `INSERT INTO vendors (vendor_name, company_id) VALUES ($1, $2) RETURNING id`, [name, companyId])).rows[0].id;
// A rate straight into history in a chosen state — for states the API would
// need two users and a day of waiting to produce.
const mkRate = async (companyId, code, rate, daysAgo, status, approver = null) => (await pool.query(
  `INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source, status,
                                   approved_by_user_id, approved_at)
   VALUES ($1, $2, $3, CURRENT_DATE - $4::int, 'manual', $5::text, $6, CASE WHEN $5::text = 'approved' THEN NOW() END)
   RETURNING id`, [companyId, code, rate, daysAgo, status, approver])).rows[0].id;

let A, B, enterer, approver, otherCo;
let vUsd, vInr, rfqId, quoteUsd, quoteInr;

async function mkRfq(companyId, n) {
  const id = (await pool.query(
    `INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id)
     VALUES ($1, $2, 100, 'sent', $3) RETURNING id`, [`${TAG}-${n}`, `${TAG} part ${n}`, companyId])).rows[0].id;
  await pool.query(`INSERT INTO rfq_items (rfq_id, item_name, quantity) VALUES ($1, $2, 100)`, [id, `${TAG} part ${n}`]);
  return id;
}
async function quote(companyId, rfq, vendorId, body) {
  const r = await request(appAs(companyId, enterer)).post(`/procurement/rfqs/${rfq}/responses/${vendorId}`).send(body);
  if (r.status !== 200) throw new Error(`quote ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

beforeAll(async () => {
  await sweep();
  A = await mkCompany('A'); B = await mkCompany('B');
  enterer  = await mkUser('enterer', A);
  approver = await mkUser('approver', A);
  otherCo  = await mkUser('other', B);
  vUsd = await mkVendor(A, `${TAG} US supplier`);
  vInr = await mkVendor(A, `${TAG} IN supplier`);
  rfqId = await mkRfq(A, 1);
  quoteUsd = await quote(A, rfqId, vUsd, { unit_price: 10, total_amount: 1000, currency: 'usd', payment_terms: 'Net 30' });
  quoteInr = await quote(A, rfqId, vInr, { unit_price: 900, total_amount: 90000, currency: 'INR', payment_terms: 'Net 30' });
}, 60000);

afterAll(async () => { await sweep(); });

const rfqView = (companyId = A, user = enterer) => request(appAs(companyId, user)).get(`/procurement/rfqs/${rfqId}`);

describe('§215 resolver — only approved, fresh, in-company rates', () => {
  it('a draft rate is never used', async () => {
    await mkRate(A, 'EUR', 95, 1, 'draft');
    const m = await resolveFxRates(A, ['EUR'], { maxAgeDays: 30 });
    expect(m.get('EUR')).toMatchObject({ ok: false, reason: 'no_approved_rate' });
  });

  it('a stale approved rate is refused, not reused', async () => {
    await mkRate(A, 'GBP', 110, 45, 'approved', approver);
    const m = await resolveFxRates(A, ['GBP'], { maxAgeDays: 30 });
    expect(m.get('GBP')).toMatchObject({ ok: false, reason: 'stale' });
  });

  it("another company's approved rate is invisible", async () => {
    await mkRate(B, 'JPY', 0.6, 1, 'approved', otherCo);
    expect((await resolveFxRates(A, ['JPY'])).get('JPY').ok).toBe(false);
    expect((await resolveFxRates(B, ['JPY'])).get('JPY')).toMatchObject({ ok: true, rate: 0.6 });
  });

  it('a non-INR base is a labelled cross rate through INR', async () => {
    await mkRate(B, 'USD', 84, 2, 'approved', otherCo);
    await mkRate(B, 'EUR', 96, 2, 'approved', otherCo);
    const r = (await resolveFxRates(B, ['USD'], { baseCurrency: 'EUR' })).get('USD');
    expect(r.ok).toBe(true);
    expect(r.method).toBe('cross_rate');
    expect(r.rate).toBeCloseTo(84 / 96, 8);
  });
});

describe('§215 Forex approval workflow', () => {
  let histId;
  it('an entered rate is a draft and needs finance:edit', async () => {
    const denied = await request(appAs(A, enterer, ['finance:view'])).post('/forex/rates').send({ from_currency: 'USD', rate: 84.5 });
    expect(denied.status).toBe(403);
    const r = await request(appAs(A, enterer)).post('/forex/rates').send({ from_currency: 'usd', rate: 84.5, source: 'rbi' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('draft');
    histId = r.body.history_id;
  });

  it('rejects an unknown source', async () => {
    const r = await request(appAs(A, enterer)).post('/forex/rates').send({ from_currency: 'CHF', rate: 100, source: 'telepathy' });
    expect(r.status).toBe(400);
  });

  it('the enterer cannot approve their own rate', async () => {
    const r = await request(appAs(A, enterer)).post(`/forex/rate-history/${histId}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SELF_APPROVAL');
  });

  it('approval needs finance:approve, not finance:edit', async () => {
    const r = await request(appAs(A, approver, ['finance:view', 'finance:edit'])).post(`/forex/rate-history/${histId}/approve`);
    expect(r.status).toBe(403);
  });

  it('a different approver approves it, and that is recorded', async () => {
    const r = await request(appAs(A, approver)).post(`/forex/rate-history/${histId}/approve`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'approved', approved_by_user_id: approver, entered_by_user_id: enterer, source: 'rbi' });
  });

  it('company B cannot see or approve company A rates', async () => {
    expect((await request(appAs(B, otherCo)).post(`/forex/rate-history/${histId}/approve`)).status).toBe(404);
    const list = await request(appAs(B, otherCo)).get('/forex/rate-history?currency=USD');
    expect(list.body.data.every(r => r.id !== histId)).toBe(true);
  });

  it('re-entering an approved date sends it back to draft', async () => {
    const r = await request(appAs(A, enterer)).post('/forex/rates').send({ from_currency: 'USD', rate: 99, source: 'bank' });
    expect(r.body.history_id).toBe(histId);
    expect(r.body.status).toBe('draft');
    // Restore the approved 84.5 for the tests below.
    await request(appAs(A, enterer)).post('/forex/rates').send({ from_currency: 'USD', rate: 84.5, source: 'rbi' });
    expect((await request(appAs(A, approver)).post(`/forex/rate-history/${histId}/approve`)).status).toBe(200);
  });
});

describe('§215 RFQ comparison uses the approved rate and shows its provenance', () => {
  it('converts the USD quote at the approved 84.5 and ranks it', async () => {
    const r = await rfqView();
    expect(r.status).toBe(200);
    const usd = r.body.quotes.find(q => q.id === quoteUsd);
    expect(usd.currency).toBe('USD');                 // stored normalised
    expect(usd.tco.computable).toBe(true);
    expect(usd.tco.base_total).toBe(84500);           // 100 x 10 x 84.5
    expect(usd.tco.fx).toMatchObject({ rate: 84.5, from: 'USD', to: 'INR', method: 'approved_rate', source: 'rbi' });
    expect(r.body.tco_basis.fx_applied.find(f => f.quote_id === quoteUsd).applied.rate).toBe(84.5);
  });
});

describe('§215 quote override', () => {
  it('needs finance:approve — procurement:approve is not enough', async () => {
    const r = await request(appAs(A, enterer, ALL.filter(g => g !== 'finance:approve')))
      .put(`/procurement/rfqs/${rfqId}/quotes/${quoteUsd}/fx-override`).send({ rate: 83, reason: 'Forward contract FC-17 booked' });
    expect(r.status).toBe(403);
  });

  it('needs a real reason', async () => {
    const r = await request(appAs(A, approver)).put(`/procurement/rfqs/${rfqId}/quotes/${quoteUsd}/fx-override`).send({ rate: 83, reason: 'fx' });
    expect(r.status).toBe(422);
  });

  it('is refused on a base-currency quote', async () => {
    const r = await request(appAs(A, approver)).put(`/procurement/rfqs/${rfqId}/quotes/${quoteInr}/fx-override`).send({ rate: 1, reason: 'Not applicable at all here' });
    expect(r.status).toBe(422);
  });

  it('applies, beats the table rate, and says so', async () => {
    const r = await request(appAs(A, approver)).put(`/procurement/rfqs/${rfqId}/quotes/${quoteUsd}/fx-override`).send({ rate: 83, reason: 'Forward contract FC-17 booked' });
    expect(r.status).toBe(200);
    const v = (await rfqView()).body.quotes.find(q => q.id === quoteUsd);
    expect(v.tco.fx).toMatchObject({ rate: 83, method: 'quote_override', reason: 'Forward contract FC-17 booked', set_by_user_id: approver });
  });

  it('is cleared when the quote is re-submitted in another currency', async () => {
    await quote(A, rfqId, vUsd, { unit_price: 10, total_amount: 1000, currency: 'EUR', payment_terms: 'Net 30' });
    const { rows: [q] } = await pool.query(`SELECT currency, fx_rate_override FROM rfq_quotes WHERE id = $1`, [quoteUsd]);
    expect(q).toMatchObject({ currency: 'EUR', fx_rate_override: null });
    // EUR has only a draft rate → not ranked, with the reason.
    const v = (await rfqView()).body.quotes.find(q2 => q2.id === quoteUsd);
    expect(v.tco).toMatchObject({ computable: false, reason: 'no_fx_rate' });
    expect(v.tco.fx_detail.reason).toBe('no_approved_rate');
    await quote(A, rfqId, vUsd, { unit_price: 10, total_amount: 1000, currency: 'USD', payment_terms: 'Net 30' });
  });

  it('rejects a currency that is not an ISO code', async () => {
    const r = await request(appAs(A, enterer)).post(`/procurement/rfqs/${rfqId}/responses/${vUsd}`).send({ unit_price: 10, currency: 'US$' });
    expect(r.status).toBe(400);
  });
});

describe('§215 award', () => {
  it('refuses a foreign quote with no usable rate', async () => {
    const rfq2 = await mkRfq(A, 2);
    const v = await mkVendor(A, `${TAG} CH supplier`);
    await quote(A, rfq2, v, { unit_price: 5, total_amount: 500, currency: 'CHF' });
    const r = await request(appAs(A, approver)).patch(`/procurement/rfqs/${rfq2}/award/${v}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('FX_RATE_REQUIRED');
    // Rolled back: not closed, no winner, no order.
    const { rows: [ev] } = await pool.query(
      `SELECT r.status, (SELECT COUNT(*)::int FROM rfq_quotes q WHERE q.rfq_id = r.id AND q.is_winner) AS winners,
              (SELECT COUNT(*)::int FROM purchase_orders p WHERE p.company_id = $2 AND p.notes LIKE '%' || r.rfq_number || '%') AS pos
         FROM rfqs r WHERE r.id = $1`, [rfq2, A]);
    expect(ev).toEqual({ status: 'responses_received', winners: 0, pos: 0 });
  });

  it('raises the PO in the quote currency at the applied rate and freezes it', async () => {
    // The override from above was cleared by the currency round-trip; set it again.
    await request(appAs(A, approver)).put(`/procurement/rfqs/${rfqId}/quotes/${quoteUsd}/fx-override`).send({ rate: 83, reason: 'Forward contract FC-17 booked' });
    const r = await request(appAs(A, approver)).patch(`/procurement/rfqs/${rfqId}/award/${vUsd}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.po.currency).toBe('USD');
    expect(Number(r.body.po.exchange_rate)).toBe(83);
    expect(Number(r.body.po.total_amount_inr)).toBeCloseTo(Number(r.body.po.total_amount) * 83, 2);

    const { rows: [d] } = await pool.query(`SELECT tco_breakdown, tco_basis FROM procurement_award_decisions WHERE rfq_id = $1`, [rfqId]);
    expect(d.tco_breakdown.fx).toMatchObject({ rate: 83, method: 'quote_override' });
    expect(d.tco_basis.fx_applied.find(f => f.quote_id === quoteUsd).applied.rate).toBe(83);
  });

  it('a closed RFQ freezes the override', async () => {
    const r = await request(appAs(A, approver)).put(`/procurement/rfqs/${rfqId}/quotes/${quoteUsd}/fx-override`).send({ rate: 80, reason: 'Trying to move it afterwards' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RFQ_FROZEN');
  });

  it('a later rate change does not alter the frozen decision', async () => {
    await mkRate(A, 'USD', 90, 0, 'approved', approver).catch(() => {}); // today's row may exist already
    await pool.query(`UPDATE forex_rate_history SET rate_vs_inr = 90 WHERE company_id = $1 AND currency_code = 'USD'`, [A]);
    const { rows: [d] } = await pool.query(`SELECT tco_breakdown FROM procurement_award_decisions WHERE rfq_id = $1`, [rfqId]);
    expect(d.tco_breakdown.fx.rate).toBe(83);
  });
});

describe('§215 settings', () => {
  it('Default Currency is now actually saved, and validated', async () => {
    expect((await request(appAs(A, approver)).put('/procurement/settings').send({ default_currency: 'US Dollar' })).status).toBe(422);
    const r = await request(appAs(A, approver)).put('/procurement/settings').send({ default_currency: 'eur' });
    expect(r.status).toBe(200);
    expect(r.body.data.default_currency).toBe('EUR');
    expect((await request(appAs(A, approver)).get('/procurement/settings')).body.data.default_currency).toBe('EUR');
    expect((await loadTcoParams(A)).base_currency).toBe('EUR');
  });

  it('a partial save leaves every other saved value alone', async () => {
    await request(appAs(A, approver)).put('/procurement/settings').send({ l1_approval_limit: 12345, cost_of_capital_pct: 9.5, tco_fx_max_age_days: 7 });
    const r = await request(appAs(A, approver)).put('/procurement/settings').send({ default_currency: 'INR' });
    expect(Number(r.body.data.l1_approval_limit)).toBe(12345);   // was reset to 25000 before
    expect(Number(r.body.data.cost_of_capital_pct)).toBe(9.5);   // was reset to 12
    expect(r.body.data.tco_fx_max_age_days).toBe(7);
    expect(r.body.data.default_currency).toBe('INR');
  });

  it('an unreadable settings row throws instead of returning the defaults', async () => {
    // A company id that is not an integer makes the query fail, standing in for
    // a missing column or a dropped connection.
    await expect(loadTcoParams('not-a-company')).rejects.toBeInstanceOf(TcoParamsUnavailableError);
  });
});
