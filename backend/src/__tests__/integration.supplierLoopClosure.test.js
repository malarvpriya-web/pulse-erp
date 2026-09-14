/**
 * integration.supplierLoopClosure.test.js
 *
 * The arrow that was broken: Incoming QC -> Supplier Performance Data.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Two NCR/CAPA table families lived in this database. Incoming QC wrote
 * `ncr_reports` + `capa_actions`; the supplier scorecard read `vendor_ncr` +
 * `vendor_capa`, which only four endpoints wrote and which no screen called. A
 * failed incoming inspection therefore could not reach a supplier's rating even
 * in principle — and the auto-NCR paths did not set `vendor_id` at all, so the
 * row could not be attributed to a supplier by anything else either.
 *
 * None of that was visible to a test. 1208 backend tests were green over it,
 * because every one of them exercised a single endpoint and this defect lived
 * where one module's write meets another module's read. That is the shape these
 * assertions are built to catch: raise a non-conformance the way Quality does,
 * then read it back the way Procurement does.
 *
 * ⚠ These tests write to the live database and clean up after themselves. Every
 * row they create is tagged LOOPPROOF so a failed run leaves a searchable trail
 * rather than anonymous debris.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import jwt from 'jsonwebtoken';

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

const { default: pool }          = await import('../config/db.js');
const { default: qualityRoutes } = await import('../modules/quality/quality.routes.js');
const { default: healthSvc }     = await import('../modules/procurement/services/vendorHealth.service.js');
const { default: poRepo }        = await import('../modules/procurement/repositories/purchaseOrder.repository.js');
const engine                     = (await import('../modules/procurement/engines/vendorHealthEngine.js')).default;

const TAG = 'LOOPPROOF';

/**
 * ⚠ A DEDICATED TENANT, NOT COMPANY 1.
 *
 * This suite creates a purchase order and priced lines. Pointed at company 1 —
 * the only tenant that holds real purchase orders — those rows land inside the
 * live spend figures for as long as this file runs, and
 * `metricRegistry.contract.test.js` ("the registry agrees with the spend cube →
 * committed spend") read them mid-run and disagreed with itself. It passes 69/69
 * alone; it failed only while this fixture existed beside it.
 *
 * 9999xx is the established convention for test tenants here (ZZPROC, ZZHD,
 * ZZAN, ZZVS, ZZRV). Keeping the fixture in its own company means nothing this
 * file creates can be counted by anything that scopes to a real one.
 *
 * ⚠ PICK THE ID BY GREPPING, NOT BY READING THE `companies` TABLE. Suites create
 * their tenant at run time with ON CONFLICT DO NOTHING and some tear it down
 * afterwards, so an id absent from `companies` right now may still be owned:
 * 999906 looked free and belongs to integration.procurementReverification
 * ("ZZRV foreign tenant"), whose cleanup deletes every vendor and inventory item
 * in it — it would have wiped this fixture mid-run, and did.
 * In use at the time of writing: 999900-999908, 999911, 999912, 999999.
 */
const CO = 999913;

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use('/api/quality', qualityRoutes);
  return a;
})();

let token, receipt;
const api = (verb) => (p) => request(app)[verb](p).set('Authorization', `Bearer ${token}`);
const createdNcrIds = [];

/**
 * Remove anything a previous run of this file left behind.
 *
 * ⚠ afterAll IS NOT ENOUGH. A run that is interrupted — Ctrl-C, or the vitest
 * worker fork exiting, which this suite has seen — never reaches afterAll, and
 * its fixture vendor, order and receipt stay in the database forever. Observed
 * live on the neighbouring ZZVS suite: two orphaned suppliers sat in `vendors`
 * until its next run swept them. That suite is the reason the rule exists
 * (project_backend_suite_flake_causes): sweep in BOTH hooks, so an abandoned run
 * costs the next one nothing instead of poisoning it permanently.
 *
 * Ordered children-first: health scores and receipts reference the rows below.
 */
async function sweep() {
  const like = `${TAG}%`;
  await pool.query(
    `DELETE FROM capa_actions WHERE ncr_id IN (SELECT id FROM ncr_reports WHERE title LIKE $1 OR defect_type LIKE $1)`, [like]);
  await pool.query(`DELETE FROM ncr_reports WHERE title LIKE $1 OR defect_type LIKE $1`, [like]);
  await pool.query(
    `DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_receipt_notes WHERE grn_number LIKE $1)`, [like]);
  await pool.query(
    `DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE po_number LIKE $1)`, [like]);
  await pool.query(
    `DELETE FROM vendor_health_scores WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, [like]);
  await pool.query(
    `DELETE FROM vendor_early_warnings WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, [like]).catch(() => {});
  await pool.query(
    `DELETE FROM vendor_health_timeline WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, [like]).catch(() => {});
  await pool.query(`DELETE FROM goods_receipt_notes WHERE grn_number LIKE $1`, [like]);
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1`, [like]);
  await pool.query(`DELETE FROM vendors WHERE vendor_name LIKE $1`, [like]);
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [like]).catch(() => {});

  // ⚠ AND THE TENANT ITSELF. A test company left behind is not inert: the talent
  // bootstrap (talent.routes.js, "seed default questions for companies that have
  // none") inserts 10 `interview_questions` into EVERY active company, and that
  // FK is NO ACTION — 52 of the FKs onto companies.id are — so a tenant that
  // survives long enough to be seeded can never be deleted again. Observed live:
  // it broke integration.procurementReverification's own teardown, whose file
  // then errored on every run while still reporting its tests as passed.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [CO]).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE id = $1`, [CO]).catch(() => {});
}

beforeAll(async () => {
  // Sweep FIRST: sweep() now removes the tenant itself, so creating the company
  // before sweeping deletes it again and every fixture insert then fails the
  // company_id FK.
  await sweep();
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [CO, `${TAG} supplier-loop tenant`, TAG]);

  const { rows: [actor] } = await pool.query(
    `SELECT u.id, u.email, u.employee_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code IN ('admin','super_admin') AND u.is_active = true
      LIMIT 1`);
  if (!actor) throw new Error('No active admin account — cannot drive the quality router.');
  token = jwt.sign(
    { userId: actor.id, email: actor.email, employee_id: actor.employee_id, company_id: CO, role: 'admin', name: TAG },
    process.env.JWT_SECRET, { expiresIn: '10m' });

  // ⚠ A DEDICATED SUPPLIER, ORDER AND RECEIPT — NOT A LIVE ONE.
  //
  // These tests raise non-conformances and then recalculate the supplier's health
  // score, which UPDATEs `vendor_health_scores` and `vendors`. Pointed at a real
  // supplier, that mutates rows other suites in this same parallel run read, and
  // it produced exactly one non-reproducible failure before this fixture existed.
  // A suite that moves shared state is a flake generator, and a flaky suite gets
  // ignored — which is how the loop this file guards went unnoticed in the first
  // place. The whole chain is built and torn down here.
  const { rows: [vendor] } = await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, lead_time_days)
     VALUES ($1, $2, 7) RETURNING id`, [`${TAG} Test Supplier`, CO]);
  const { rows: [po] } = await pool.query(
    `INSERT INTO purchase_orders (po_number, supplier_id, order_date, total_amount, subtotal, status, company_id)
     VALUES ($1, $2, CURRENT_DATE - 30, 1000, 1000, 'received', $3) RETURNING id`,
    [`${TAG}-PO-${Date.now()}`, vendor.id, CO]);
  const { rows: [grn] } = await pool.query(
    `INSERT INTO goods_receipt_notes (grn_number, po_id, received_date, company_id, quality_status)
     VALUES ($1, $2, CURRENT_DATE - 25, $3, 'pending') RETURNING id`,
    [`${TAG}-GRN-${Date.now()}`, po.id, CO]);

  receipt = { grn_id: grn.id, po_id: po.id, supplier_id: vendor.id };
});

afterAll(async () => {
  if (createdNcrIds.length) {
    await pool.query(`DELETE FROM capa_actions WHERE ncr_id = ANY($1::int[])`, [createdNcrIds]);
    await pool.query(`DELETE FROM ncr_reports WHERE id = ANY($1::int[])`, [createdNcrIds]);
  }
  // The same sweep as beforeAll — everything this file creates carries the tag,
  // so one routine cleans up after a normal run and after an abandoned one.
  await sweep();
});

describe('Incoming QC reaches the supplier scorecard', () => {
  it('attributes an NCR raised against a receipt to the supplier that shipped it', async () => {
    const res = await api('post')('/api/quality/ncr').send({
      title: `${TAG} incoming inspection fail`,
      description: 'Dimensional non-conformance found at goods-in',
      grn_id: receipt.grn_id,
      defect_type: `${TAG}-dimensional`,
      severity: 'critical',
      source: 'quality',
    });
    expect(res.status).toBe(201);
    createdNcrIds.push(res.body.data.id);

    // The caller named the RECEIPT and no supplier at all — which is exactly what
    // the three auto-NCR paths do. Before this was fixed, vendor_id stayed NULL
    // on all 8 rows in the live database and the row reached nothing.
    expect(res.body.data.vendor_id).toBe(receipt.supplier_id);
    expect(res.body.data.po_id).toBe(receipt.po_id);
  });

  it('moves that supplier\'s quality score when the NCR lands', async () => {
    const before = await healthSvc.computeAndSave(receipt.supplier_id, CO);

    const res = await api('post')('/api/quality/ncr').send({
      title: `${TAG} second fail`,
      description: 'Repeat of the same defect',
      grn_id: receipt.grn_id,
      defect_type: `${TAG}-dimensional`,
      severity: 'critical',
      source: 'quality',
    });
    expect(res.status).toBe(201);
    createdNcrIds.push(res.body.data.id);

    const after = await healthSvc.computeAndSave(receipt.supplier_id, CO);

    // The scorecard counted it. This is the assertion that goes red if anyone
    // repoints vendorHealth back at vendor_ncr, or drops vendor_id from the
    // auto-NCR inserts.
    expect(after.detail.quality.openNCR).toBeGreaterThan(before.detail.quality.openNCR);
    expect(after.detail.quality.criticalNCR).toBeGreaterThan(before.detail.quality.criticalNCR);
  });

  it('counts a recurrence of the same defect as a repeat, and a one-off as not', () => {
    // `repeat_ncr` was `ncr_date IS NOT NULL AND ncr_date = ncr_date` — a
    // tautology that counted every NCR in the window as a repeat, at -8 each on
    // top of what those same rows already drew as open and critical.
    const oneOff = engine.scoreQuality({ totalInspections: 10, passedInspections: 10, openNCR: 1, repeatNCR: 0 });
    const repeat = engine.scoreQuality({ totalInspections: 10, passedInspections: 10, openNCR: 1, repeatNCR: 1 });
    expect(repeat.score).toBeLessThan(oneOff.score);
    expect(oneOff.score - repeat.score).toBe(8);
  });

  it('treats a CAPA the vocabulary calls completed as closed', () => {
    // Closure used to be counted as status = 'Closed'. capa_actions never holds
    // that value — the NCR close-out gate tests NOT IN ('completed','verified') —
    // so closure read 0% for every supplier and the flat -10 penalty was
    // universal, on a vocabulary mismatch rather than on anyone's performance.
    const allClosed = engine.scoreQuality({ totalInspections: 10, passedInspections: 10, totalCAPAs: 4, closedCAPAs: 4 });
    const noneClosed = engine.scoreQuality({ totalInspections: 10, passedInspections: 10, totalCAPAs: 4, closedCAPAs: 0 });
    expect(allClosed.capaClosurePct).toBe(100);
    expect(noneClosed.capaClosurePct).toBe(0);
    expect(allClosed.score).toBeGreaterThan(noneClosed.score);
  });
});

describe('On-time delivery says what it was measured against', () => {
  it('reports an implied basis when no order carried a promised date', () => {
    const r = engine.scoreDelivery({ totalGRNs: 4, onTimeGRNs: 4, promisedDateGRNs: 0 });
    expect(r.otdPct).toBe(100);
    expect(r.otdMeasured).toBe(true);
    // 100% on-time against a date we derived from our own lead-time master data
    // is not a supplier keeping its word, and must not be published as one.
    expect(r.otdBasis).toBe('implied');
    expect(r.promisedCoveragePct).toBe(0);
  });

  it('reports promised, mixed and none as the coverage warrants', () => {
    expect(engine.scoreDelivery({ totalGRNs: 4, onTimeGRNs: 4, promisedDateGRNs: 4 }).otdBasis).toBe('promised');
    expect(engine.scoreDelivery({ totalGRNs: 4, onTimeGRNs: 4, promisedDateGRNs: 1 }).otdBasis).toBe('mixed');
    expect(engine.scoreDelivery({ totalGRNs: 0, onTimeGRNs: 0, promisedDateGRNs: 0 }).otdBasis).toBe('none');
    expect(engine.scoreDelivery({ totalGRNs: 4, onTimeGRNs: 4, promisedDateGRNs: 1 }).promisedCoveragePct).toBe(25);
  });

  it('does not change the delivery score itself', () => {
    // The basis is provenance, not a penalty. Two suppliers with the same record
    // score the same; what differs is what the number can be claimed to mean.
    const implied  = engine.scoreDelivery({ totalGRNs: 4, onTimeGRNs: 3, promisedDateGRNs: 0 });
    const promised = engine.scoreDelivery({ totalGRNs: 4, onTimeGRNs: 3, promisedDateGRNs: 4 });
    expect(implied.score).toBe(promised.score);
  });

  it('records where a purchase order\'s promised date came from', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const base = { supplier_id: receipt.supplier_id, order_date: '2026-09-10', total_amount: 100, subtotal: 100,
                     company_id: CO, created_by: null, currency: 'INR', exchange_rate: 1 };

      // A buyer typed the date on the form: that is an agreement.
      const agreed = await poRepo.create(client, { ...base, po_number: `${TAG}-A`, expected_delivery_date: '2026-09-25' });
      expect(agreed.expected_delivery_basis).toBe('agreed');

      // The award path passes the supplier's own quoted delivery days.
      const quoted = await poRepo.create(client, { ...base, po_number: `${TAG}-Q`, expected_delivery_date: '2026-09-20', expected_delivery_basis: 'quoted' });
      expect(quoted.expected_delivery_basis).toBe('quoted');

      // No date means no basis — not a basis for a date that does not exist.
      const none = await poRepo.create(client, { ...base, po_number: `${TAG}-N` });
      expect(none.expected_delivery_date).toBeNull();
      expect(none.expected_delivery_basis).toBeNull();

      // The column was inserted out of positional order ($21 in a 20-parameter
      // list). If that ever shifts, every field on every purchase order shifts
      // with it, so the neighbours are asserted too.
      expect(Number(agreed.total_amount)).toBe(100);
      expect(agreed.supplier_id).toBe(receipt.supplier_id);
      expect(agreed.currency).toBe('INR');

      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('stores the same on-time answer on the scorecard and the vendor master', async () => {
    await healthSvc.computeAndSave(receipt.supplier_id, CO);
    const { rows: [row] } = await pool.query(
      `SELECT otd_pct, otd_basis, promised_coverage_pct FROM vendor_health_scores WHERE vendor_id = $1`,
      [receipt.supplier_id]);
    const { rows: [v] } = await pool.query(`SELECT on_time_pct FROM vendors WHERE id = $1`, [receipt.supplier_id]);

    // These two columns are read by different screens — the heatmap and the CEO
    // roll-up take otd_pct, the vendor list and VendorComparison take
    // on_time_pct. Gating one on the basis and not the other left the master
    // saying "unmeasured" while the scorecard beside it said 100%.
    expect(String(row.otd_pct)).toBe(String(v.on_time_pct));

    // The fixture's order carries no promised date, so nothing may be published.
    expect(row.otd_pct).toBeNull();
    expect(row.otd_basis).not.toBeNull();
    expect(Number(row.promised_coverage_pct)).toBe(0);
  });
});

describe('The four KPIs that were named but never measured', () => {
  it('computes fill rate from the LINES, not the order header', () => {
    // Two lines, one short-shipped: 5 of 5 and 1 of 5 = 60%.
    const r = engine.scoreDelivery({ totalGRNs: 2, onTimeGRNs: 2, orderedQty: 10, receivedQty: 6, orderedLines: 2 });
    expect(r.fillRateMeasured).toBe(true);
    expect(r.fillRatePct).toBe(60);
    // A short-shipping supplier must score below a complete one on the same OTD.
    const full = engine.scoreDelivery({ totalGRNs: 2, onTimeGRNs: 2, orderedQty: 10, receivedQty: 10, orderedLines: 2 });
    expect(r.score).toBeLessThan(full.score);
  });

  it('caps fill rate at 100 so an over-shipment cannot flatter a supplier', () => {
    const r = engine.scoreDelivery({ totalGRNs: 1, onTimeGRNs: 1, orderedQty: 10, receivedQty: 25, orderedLines: 2 });
    expect(r.fillRatePct).toBe(100);
  });

  it('separates lead-time adherence from on-time delivery', () => {
    // Every receipt "on time" (nothing late), but none within +/-3 days of the
    // promise — a supplier that always arrives two weeks early is unpredictable,
    // and OTD alone calls that perfect.
    const erratic = engine.scoreDelivery({
      totalGRNs: 4, onTimeGRNs: 4, promisedDateGRNs: 4,
      promisedLeadTimeReceipts: 4, onScheduleLeadTimeReceipts: 0, avgLeadTimeVarianceDays: 13 });
    const steady = engine.scoreDelivery({
      totalGRNs: 4, onTimeGRNs: 4, promisedDateGRNs: 4,
      promisedLeadTimeReceipts: 4, onScheduleLeadTimeReceipts: 4, avgLeadTimeVarianceDays: 1 });
    expect(erratic.otdPct).toBe(steady.otdPct);          // identical on OTD
    expect(erratic.score).toBeLessThan(steady.score);    // not identical overall
    expect(erratic.leadTimeAdherencePct).toBe(0);
    expect(steady.leadTimeAdherencePct).toBe(100);
  });

  it('scores PPV against standard cost, not against a supplier past prices', () => {
    // priceVariancePct is 0 for both: neither supplier has moved its price. Only
    // PPV can tell the one that has always been 30% over standard from the one
    // that is on it.
    const onStandard = engine.scoreCost({ priceVariancePct: 0, ppvPct: 0, ppvPricedLines: 4 });
    const expensive  = engine.scoreCost({ priceVariancePct: 0, ppvPct: 30, ppvPricedLines: 4 });
    expect(onStandard.score).toBeGreaterThan(expensive.score);
    expect(expensive.ppvMeasured).toBe(true);
    expect(expensive.ppvPct).toBe(30);
  });

  it('measures responsiveness from the clocks instead of the slider', () => {
    // A hand-typed 90 must not outrank a measured record of three-week replies.
    const slow = engine.scoreSupport({
      storedSupportScore: 90,
      quoteTurnaroundDays: 21, quotesConsidered: 5,
      ncrResponseDays: 30, ncrsConsidered: 3 });
    expect(slow.source).toBe('measured');
    expect(slow.score).toBeLessThan(90);

    const fast = engine.scoreSupport({ quoteTurnaroundDays: 1, quotesConsidered: 5 });
    expect(fast.source).toBe('measured');
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it('falls back to the stored scorecard only when nothing was measured', () => {
    const stored = engine.scoreSupport({ storedSupportScore: 80 });
    expect(stored.source).toBe('stored');
    expect(stored.score).toBe(80);

    const nothing = engine.scoreSupport({});
    expect(nothing.source).toBe('unmeasured');
    expect(nothing.measured).toBe(false);
  });

  it('refuses to rate any of them off a single observation', () => {
    // ⚠ The live database had exactly one NCR-and-CAPA pair per supplier, 0.55
    // days apart because the seed script wrote both in the same run. Ungated,
    // that rated five suppliers excellent on responsiveness and lifted one from
    // 51.8 to 60.3 with coverage at 100%.
    expect(engine.scoreSupport({ ncrResponseDays: 0.55, ncrsConsidered: 1 }).source).toBe('unmeasured');
    expect(engine.scoreSupport({ quoteTurnaroundDays: 0.5, quotesConsidered: 1 }).source).toBe('unmeasured');
    expect(engine.scoreDelivery({ orderedQty: 5, receivedQty: 5, orderedLines: 1 }).fillRateMeasured).toBe(false);
    expect(engine.scoreCost({ ppvPct: 0, ppvPricedLines: 1 }).ppvMeasured).toBe(false);
    expect(engine.scoreDelivery({ totalGRNs: 1, promisedLeadTimeReceipts: 1, onScheduleLeadTimeReceipts: 1 }).leadTimeMeasured).toBe(false);
  });

  it('lets an unmeasured KPI change nothing at all', () => {
    // The safety property behind shipping these: a supplier with no evidence for
    // the new KPIs scores exactly what it scored before they existed.
    const withoutNew = engine.scoreDelivery({ totalGRNs: 4, onTimeGRNs: 3, avgDelayDays: 2 });
    const withUnmeasured = engine.scoreDelivery({
      totalGRNs: 4, onTimeGRNs: 3, avgDelayDays: 2,
      orderedQty: 0, receivedQty: 0, orderedLines: 0, promisedLeadTimeReceipts: 0 });
    expect(withUnmeasured.score).toBe(withoutNew.score);
    expect(withUnmeasured.fillRatePct).toBeNull();
    expect(withUnmeasured.leadTimeAdherencePct).toBeNull();
  });
});

describe('The KPI queries compute the right numbers from real rows', () => {
  // The engine tests above prove the arithmetic. These prove the SQL that feeds
  // it — which is where this codebase has historically been bitten: join fan-out
  // over two child tables, and COUNT() returning bigint-as-string so a ratio
  // silently becomes NaN.
  let lineA, lineB, itemId, stdCost;

  beforeAll(async () => {
    // Its own item in its own tenant, with a standard cost this test sets, rather
    // than borrowing a real one from company 1: PPV is measured against
    // standard_cost, so the assertion should not depend on a number someone else
    // can change.
    stdCost = 100;
    const { rows: [item] } = await pool.query(
      `INSERT INTO inventory_items (item_code, item_name, standard_cost, company_id, unit_of_measure)
       VALUES ($1, $2, $3, $4, 'NOS') RETURNING id`,
      [`${TAG}-ITEM-${Date.now()}`, `${TAG} Test Item`, stdCost, CO]);
    itemId = item.id;

    // Two lines of 10 at 20% over standard. One arrives complete, one half-short.
    const mk = async (qty) => (await pool.query(
      `INSERT INTO purchase_order_items (po_id, item_id, quantity, rate, total_amount)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [receipt.po_id, itemId, qty, stdCost * 1.2, qty * stdCost * 1.2])).rows[0].id;
    lineA = await mk(10);
    lineB = await mk(10);

    await pool.query(
      `INSERT INTO grn_items (grn_id, po_item_id, item_id, quantity_received, quantity_rejected, rate)
       VALUES ($1,$2,$3,10,0,$4), ($1,$5,$3,5,0,$4)`,
      [receipt.grn_id, lineA, itemId, stdCost * 1.2, lineB]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM grn_items WHERE po_item_id = ANY($1::int[])`, [[lineA, lineB]]);
    await pool.query(`DELETE FROM purchase_order_items WHERE id = ANY($1::int[])`, [[lineA, lineB]]);
    await pool.query(`DELETE FROM inventory_items WHERE id = $1`, [itemId]).catch(() => {});
  });

  it('derives fill rate and PPV from the lines and receipts', async () => {
    const r = await healthSvc.computeAndSave(receipt.supplier_id, CO);

    // 10 of 10 plus 5 of 10 = 15 of 20.
    expect(r.detail.delivery.fillRateMeasured).toBe(true);
    expect(r.detail.delivery.fillRatePct).toBe(75);

    // Both lines priced 20% above standard cost.
    expect(r.detail.cost.ppvMeasured).toBe(true);
    expect(r.detail.cost.ppvPct).toBeCloseTo(20, 1);

    // ⚠ Neither may come back as a string or a NaN. pg returns NUMERIC as text
    // and COUNT() as a bigint string; a ratio built on those reads NaN, and a
    // renderer turns NaN into a red 0.0% — the worst reading of good data.
    expect(Number.isFinite(r.detail.delivery.fillRatePct)).toBe(true);
    expect(Number.isFinite(r.detail.cost.ppvPct)).toBe(true);
    expect(Number.isFinite(r.health_score)).toBe(true);
  });

  it('does not double-count quantities when a receipt has several lines', async () => {
    // grn_items and purchase_order_items are two child tables hanging off the
    // same order. Summing across both in one query fans out and reports 2x the
    // quantity — the exact defect logged in project_sql_fanout_multi_child_join.
    const { rows: [raw] } = await pool.query(
      `SELECT SUM(poi.quantity) AS ordered FROM purchase_order_items poi
        WHERE poi.po_id = $1`, [receipt.po_id]);
    expect(parseFloat(raw.ordered)).toBe(20);

    const r = await healthSvc.computeAndSave(receipt.supplier_id, CO);
    expect(r.detail.delivery.orderedQty).toBe(20);
    expect(r.detail.delivery.receivedQty).toBe(15);
  });

  it('persists the measured KPIs rather than leaving them null', async () => {
    await healthSvc.computeAndSave(receipt.supplier_id, CO);
    const { rows: [row] } = await pool.query(
      `SELECT fill_rate_pct, ppv_pct FROM vendor_health_scores WHERE vendor_id = $1`,
      [receipt.supplier_id]);
    expect(parseFloat(row.fill_rate_pct)).toBe(75);
    expect(parseFloat(row.ppv_pct)).toBeCloseTo(20, 1);
  });
});

describe('One vendor state, one spelling', () => {
  it('has no writer inserting a capitalised vendors.status', async () => {
    // ⚠ `scripts/check-status-vocabulary.mjs` DOES catch this — but only while a
    // drifted row exists, and the row that exposed it was created and deleted by
    // another suite inside the same run. That made a real defect look like a
    // flake: vendor-approval.routes.js wrote 'Active' while the column default,
    // every other writer and VendorManagement.jsx's filter all use 'active', so
    // a fully approved supplier rendered "Inactive" and vanished from the
    // active-vendor picker. This assertion does not need the row to exist.
    const { readdirSync, readFileSync: read, statSync } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const offenders = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = resolve(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.js')) continue;
        for (const line of read(p, 'utf8').split(/\r?\n/)) {
          // A quoted vendor state with a capital letter, in a line that is
          // writing a status rather than reading or commenting on one.
          // Skip comment lines — JS (`//`, `*`) and SQL (`--`) alike. The
          // explanations of this very drift quote the bad spelling.
          if (/^\s*(\/\/|\*|--)/.test(line)) continue;
          if (/status\s*=\s*'(Active|Inactive|Pending)'/.test(line)
              || /'(Active|Inactive)'\s*,\s*'Approved'/.test(line)) {
            offenders.push(`${name}: ${line.trim().slice(0, 90)}`);
          }
        }
      }
    };
    walk(resolve(here, '../modules/procurement'));
    expect(offenders).toEqual([]);
  });

  it('stores every vendor state in one casing', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT status FROM vendors WHERE status IS NOT NULL`);
    const drifted = rows
      .map(r => r.status)
      .filter(s => s !== s.toLowerCase());
    expect(drifted).toEqual([]);
  });
});

describe('The dead tables are dead', () => {
  it('has no live reader or writer of vendor_ncr / vendor_capa left in the module tree', async () => {
    const { readdirSync, readFileSync: read, statSync } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '../modules');
    const offenders = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = resolve(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.js')) continue;
        const src = read(p, 'utf8');
        // SQL references only — the migration and the explanatory comments name
        // these tables on purpose and must stay.
        if (/(?:FROM|JOIN|INTO|UPDATE)\s+vendor_(?:ncr|capa)\b/.test(src)) offenders.push(name);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
