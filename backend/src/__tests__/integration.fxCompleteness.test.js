/**
 * integration.fxCompleteness.test.js — §217: a priced quote that cannot be
 * converted (no approved FX, stale, unusable) makes the comparison INCOMPLETE
 * and withholds the recommendation — in every shared-engine consumer: RFQ
 * comparison + award snapshot, Component 360, PO advisory, RFx cost scoring.
 *
 * Throwaway companies only (TAG ZZFXCMP). No live data is read or written.
 * PO numbers for the award come from the test-only generator in setup.js
 * (§218), so no live sequence value is consumed.
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
const { default: inventoryRouter }   = await import('../modules/inventory/routes/inventory.routes.js');
const { default: rfxRouter }         = await import('../modules/procurement/routes/rfx.routes.js');

const TAG = 'ZZFXCMP';
let A, user, vUsd, vInr, item, rfqId;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: user, id: user, role: 'admin', roles: ['admin'], company_id: A };
    req.scope = { company_id: A };
    next();
  });
  a.use('/procurement', procurementRouter);
  a.use('/inventory', inventoryRouter);
  a.use('/rfx', rfxRouter);
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
    await pool.query(`DELETE FROM rfx_criteria_scores WHERE rfq_id IN ${rfqs}`, [co]).catch(() => {});
    await pool.query(`DELETE FROM rfq_quotes WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfq_items WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfqs WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM forex_rate_history WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM item_vendor_prices WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM procurement_settings WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
    await pool.query(`DELETE FROM inventory_items WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1)`, [co]);
  }
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE email LIKE '${TAG.toLowerCase()}.%@example.com'`);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const setUsdRate = async (daysAgo, status = 'approved') => {
  await pool.query(`DELETE FROM forex_rate_history WHERE company_id = $1`, [A]);
  if (daysAgo == null) return;
  await pool.query(
    `INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source, status, approved_by_user_id, approved_at)
     VALUES ($1,'USD',84,CURRENT_DATE - $2::int,'rbi',$3::text, CASE WHEN $3::text='approved' THEN $4::int END, CASE WHEN $3::text='approved' THEN NOW() END)`,
    [A, daysAgo, status, user]);
};

beforeAll(async () => {
  await sweep();
  A = (await one(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} Co`, `${TAG}A`])).id;
  user = (await one(`INSERT INTO users (name, email, password_hash, role, is_active, company_id) VALUES ($1,$2,'x','admin',true,$3) RETURNING id`,
    [`${TAG} u`, `${TAG.toLowerCase()}.u@example.com`, A])).id;
  vUsd = (await one(`INSERT INTO vendors (vendor_name, company_id) VALUES ('${TAG} US',$1) RETURNING id`, [A])).id;
  vInr = (await one(`INSERT INTO vendors (vendor_name, company_id) VALUES ('${TAG} IN',$1) RETURNING id`, [A])).id;
  item = (await one(`INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost) VALUES ($1,$2,$3,'NOS',100) RETURNING id`,
    [`${TAG}-1`, `${TAG} part`, A])).id;
  rfqId = (await one(`INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id) VALUES ($1,'p',100,'responses_received',$2) RETURNING id`,
    [`${TAG}-RFQ-1`, A])).id;
  await pool.query(`INSERT INTO rfq_items (rfq_id, item_id, item_name, quantity, unit) VALUES ($1,$2,'p',100,'NOS')`, [rfqId, item]);
  // USD 5 x 84 = Rs 420 / unit — would be the CHEAPEST once converted.
  await pool.query(`INSERT INTO rfq_quotes (rfq_id, vendor_id, unit_price, total_amount, currency) VALUES ($1,$2,5,500,'USD'),($1,$3,500,50000,'INR')`,
    [rfqId, vUsd, vInr]);
  await pool.query(`INSERT INTO item_vendor_prices (item_id, vendor_id, unit_price, currency, company_id) VALUES ($1,$2,5,'USD',$4),($1,$3,500,'INR',$4)`,
    [item, vUsd, vInr, A]);
}, 60000);
afterAll(async () => { await sweep(); });

const rfq = () => request(app()).get(`/procurement/rfqs/${rfqId}`);

describe('RFQ comparison', () => {
  it('no approved USD rate → incomplete, no winner, vendor and exact reason shown', async () => {
    await setUsdRate(null);
    const r = await rfq();
    expect(r.body.tco_comparison).toMatchObject({ comparison_status: 'incomplete', best_tco_vendor_id: null });
    const rec = r.body.tco_comparison.recommendation;
    expect(rec.status).toBe('withheld_incomplete');
    expect(rec.incomplete).toEqual([expect.objectContaining({
      vendor_id: vUsd, reason: 'fx',
      missing: [expect.objectContaining({ input: 'fx', reason: 'no_approved_rate', currency: 'USD' })],
    })]);
    expect(r.body.quotes.every(q => q.is_lowest_tco !== true)).toBe(true);
  });

  it('an UNAPPROVED (draft) rate is not used', async () => {
    await setUsdRate(0, 'draft');
    const rec = (await rfq()).body.tco_comparison.recommendation;
    expect(rec.incomplete[0].missing[0].reason).toBe('no_approved_rate');
  });

  it('a STALE approved rate is not used, and the reason says stale with its date', async () => {
    await setUsdRate(45);
    const rec = (await rfq()).body.tco_comparison.recommendation;
    expect(rec.status).toBe('withheld_incomplete');
    expect(rec.incomplete[0].missing[0]).toMatchObject({ reason: 'stale' });
    expect(rec.incomplete[0].missing[0].latest_rate_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a fresh approved rate → every quote costed → the normal recommendation', async () => {
    await setUsdRate(0);
    const r = await rfq();
    expect(r.body.tco_comparison.comparison_status).not.toBe('incomplete');
    expect(r.body.tco_comparison.best_tco_vendor_id).toBe(vUsd);
  });
});

describe('award snapshot while FX is unusable', () => {
  it('awarding the INR quote records the comparison as incomplete, not as followed', async () => {
    await setUsdRate(null);
    const r = await request(app()).patch(`/procurement/rfqs/${rfqId}/award/${vInr}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.po.po_number).toMatch(/^ZZT-PO-/);        // §218: test generator, no live sequence
    const d = await one(`SELECT * FROM procurement_award_decisions WHERE rfq_id = $1`, [rfqId]);
    expect(d).toMatchObject({ comparison_status: 'incomplete', recommendation_status: 'withheld_incomplete', followed_recommendation: null });
    expect(d.tco_basis.fx_applied.find(f => Number(f.vendor_id) === vUsd).unavailable.reason).toBe('no_approved_rate');
  });
});

describe('Component 360', () => {
  it('a USD price without a usable rate makes the item comparison incomplete', async () => {
    await setUsdRate(null);
    const r = await request(app()).get(`/inventory/catalog/items/${item}/sourcing?qty=100`);
    expect(r.status).toBe(200);
    expect(r.body.summary.tco_comparison_status).toBe('incomplete');
    expect(r.body.summary.tco_recommendation.incomplete[0]).toMatchObject({ vendor_id: vUsd, reason: 'fx' });
  });
});

describe('PO advisory', () => {
  it('an alternative vendor priced in USD without a rate makes the advice incomplete', async () => {
    await setUsdRate(null);
    const r = await request(app()).post('/procurement/tco/advisory').send({ vendor_id: vInr, lines: [{ item_id: item, quantity: 100, rate: 500 }] });
    expect(r.status).toBe(200);
    expect(r.body.comparison_status).toBe('incomplete');
    expect(r.body.lines[0].recommendation_status).toBe('withheld_incomplete');
    expect(r.body.advisory).toBeNull();
  });
});

describe('RFx cost scoring', () => {
  it('no bid gets a cost score while one priced bid cannot be converted', async () => {
    await setUsdRate(null);
    const rfq2 = (await one(`INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id) VALUES ($1,'p',100,'responses_received',$2) RETURNING id`,
      [`${TAG}-RFQ-2`, A])).id;
    await pool.query(`INSERT INTO rfq_items (rfq_id, item_id, item_name, quantity, unit) VALUES ($1,$2,'p',100,'NOS')`, [rfq2, item]);
    await pool.query(`INSERT INTO rfq_quotes (rfq_id, vendor_id, unit_price, total_amount, currency) VALUES ($1,$2,5,500,'USD'),($1,$3,500,50000,'INR')`, [rfq2, vUsd, vInr]);
    const r = await request(app()).get(`/rfx/${rfq2}/scorecard`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const s = JSON.stringify(r.body);
    expect(s).toContain('"cost_status":"incomplete"');
    expect(s).toContain('"cost_basis_key":"incomplete"');
    // Converted once the rate is approved.
    await setUsdRate(0);
    const ok = JSON.stringify((await request(app()).get(`/rfx/${rfq2}/scorecard`)).body);
    expect(ok).toContain('"cost_status":"complete"');
  });
});
