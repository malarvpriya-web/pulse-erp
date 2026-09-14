/**
 * integration.procurementReverification.test.js
 *
 * The seven blocking defects the 2026-09-04 independent re-verification found,
 * plus the two general shapes that let them through.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * When these defects were found the module had 942 passing backend tests, 30
 * passing browser tests and an 85-check live-HTTP lifecycle probe. All green.
 * None of them detected any of the seven. The suites tested what the previous
 * hardening pass already knew about, and the defects sat in the shapes it had
 * not looked at:
 *
 *   - the vendor surface was tested for the ROLE dimension and the core objects
 *     for the TENANT dimension, so an unscoped by-id read on a satellite router
 *     had no test that could catch it (D1, D2, D3);
 *   - every idempotency test drove ONE screen, so a defect that only appears
 *     when one screen's write meets another screen's read was invisible (D4);
 *   - seven instances of the users.id-into-an-employees-FK trap were fixed
 *     one at a time, and the eighth was found by a user, not by a test (D6);
 *   - the reorder CRON was tested and the BUTTON beside it, calling the same
 *     repository incorrectly, was not (D7).
 *
 * So this file has two halves. The first pins each specific defect. The second
 * — `describe('the shapes')` — is the part that matters more: two data-driven
 * sweeps that fail on the NEXT instance of each class rather than on this one.
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

const { default: pool }         = await import('../config/db.js');
const { default: procRouter }   = await import('../modules/procurement/routes/procurement.routes.js');
const { default: rfxRouter }    = await import('../modules/procurement/routes/rfx.routes.js');
const { default: healthRouter } = await import('../modules/procurement/routes/vendorHealth.routes.js');
const { default: invRouter }    = await import('../modules/inventory/routes/inventory.routes.js');

const TAG  = 'ZZRV';
const CO_A = 1;
const CO_B = 999906;

/** Build an app whose caller is exactly the identity given. */
function appAs({ roles, companyId = CO_A, userId = 1, employeeId = null }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, roles, company_id: companyId, employee_id: employeeId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/api/procurement',  procRouter);
  app.use('/api/rfx',          rfxRouter);
  app.use('/api/vendor-health', healthRouter);
  app.use('/api/inventory',    invRouter);
  return app;
}

const buyer   = () => request(appAs({ roles: ['procurement_manager'], employeeId: seed.employeeId }));
const admin   = () => request(appAs({ roles: ['admin'], employeeId: seed.employeeId }));
/** Same full procurement rights — a DIFFERENT tenant. */
const tenantB = () => request(appAs({ roles: ['procurement_manager'], companyId: CO_B, employeeId: seed.employeeId }));
/**
 * A real account that has NO employee record at all: users.employee_id is NULL
 * and no employees row matches its company_email, so employeeOf() resolves to
 * null. Every actor-stamped write has to survive that, because an admin or
 * service account is exactly who runs a repair by hand.
 */
const noEmployee = () => request(appAs({ roles: ['admin'], userId: seed.userIdWithoutEmployee, employeeId: null }));

const seed = {};

async function sweep() {
  const like = [`%${TAG}%`];
  await pool.query(`DELETE FROM price_history WHERE notes LIKE $1`, like);
  await pool.query(`DELETE FROM approved_vendor_list WHERE notes LIKE $1`, like);
  await pool.query(`DELETE FROM item_vendor_prices WHERE notes LIKE $1`, like).catch(() => {});
  await pool.query(`DELETE FROM rfx_criteria_scores WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, like);
  await pool.query(`DELETE FROM rfx_vendor_selections WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, like);
  await pool.query(`DELETE FROM rfq_quotes WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, like);
  await pool.query(`DELETE FROM rfq_items  WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, like);
  // Every order this suite can produce: raised directly, converted from one of
  // its requisitions, or awarded from one of its events. The award case has to
  // match against ALL of this suite's RFQ numbers — an earlier version took
  // `(SELECT rfq_number ... LIMIT 1)`, which cleaned one award order per run
  // and left the rest behind as orphans once their RFQ was deleted.
  const { rows: poIds } = await pool.query(
    `SELECT po.id FROM purchase_orders po
      WHERE po.notes LIKE $1
         OR po.pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)
         OR EXISTS (
              SELECT 1 FROM rfqs r
               WHERE r.item_description LIKE $1
                 AND r.rfq_number IS NOT NULL
                 AND po.notes LIKE '%' || r.rfq_number || '%')`,
    like
  );
  const ids = poIds.map(r => r.id);
  if (ids.length) {
    const { rows: grnRows } = await pool.query(
      `SELECT id FROM goods_receipt_notes WHERE po_id = ANY($1::int[])`, [ids]);
    const grnIds = grnRows.map(r => r.id);

    if (grnIds.length) {
      // A released receipt leaves stock behind it, and current_stock has to come
      // back down with the ledger rows or the next run starts from an inflated
      // figure. `inventory_batches.grn_id` is RESTRICT, so the batches also have
      // to go BEFORE their receipt — an earlier version deleted the receipt
      // first and the whole teardown failed on the foreign key.
      // Deleting the ledger rows is now the WHOLE teardown. current_stock is
      // derived by a trigger (migration 20260911000016), so it corrects itself
      // when the movements go; decrementing it here as well — which this used to
      // do — would subtract the same quantity twice and was one of the paths
      // that left the column drifting from the ledger.
      await pool.query(`DELETE FROM stock_ledger WHERE reference_type='grn' AND reference_id::text = ANY($1::text[])`, [grnIds.map(String)]);
      await pool.query(`DELETE FROM inventory_batches WHERE grn_id = ANY($1::int[])`, [grnIds]);
      await pool.query(`DELETE FROM quality_tests WHERE grn_id = ANY($1::int[])`, [grnIds]);
      await pool.query(`DELETE FROM quality_inspection_items WHERE inspection_id IN (SELECT id FROM quality_inspections WHERE grn_id = ANY($1::int[]))`, [grnIds]);
      await pool.query(`DELETE FROM quality_inspections WHERE grn_id = ANY($1::int[])`, [grnIds]);
    }

    await pool.query(`DELETE FROM three_way_matches WHERE po_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM grn_items WHERE grn_id = ANY($1::int[])`, [grnIds.length ? grnIds : [0]]);
    await pool.query(`DELETE FROM goods_receipt_notes WHERE po_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM purchase_order_items WHERE po_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM purchase_orders WHERE id = ANY($1::int[])`, [ids]);
  }
  await pool.query(`DELETE FROM rfqs WHERE item_description LIKE $1`, like);
  // Hand-booked batches, which carry the tag in their batch number.
  await pool.query(`DELETE FROM stock_ledger WHERE reference_type='inventory_batch'
                     AND reference_id::text IN (SELECT id::text FROM inventory_batches WHERE batch_number LIKE $1)`, like);
  await pool.query(`DELETE FROM inventory_batches WHERE batch_number LIKE $1`, like);
  await pool.query(`DELETE FROM quality_tests WHERE remarks LIKE $1`, like);
  await pool.query(`DELETE FROM quality_inspection_items WHERE inspection_id IN (SELECT id FROM quality_inspections WHERE notes LIKE $1)`, like);
  await pool.query(`DELETE FROM quality_inspections WHERE notes LIKE $1`, like);
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, like);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, like);
  await pool.query(`DELETE FROM vendor_health_scores WHERE company_id = $1`, [CO_B]);
  // Round three: the sourcing strategies this suite records, and tenant B's own
  // data — B is populated now, so its rows have to come down with everything
  // else or the next run starts against a tenant that is no longer empty in a
  // way the tests did not choose.
  await pool.query(`DELETE FROM sourcing_category_strategies WHERE rationale LIKE $1`, like);
  await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`, [CO_B]);
  await pool.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [CO_B]);
  await pool.query(`DELETE FROM inventory_items WHERE company_id = $1`, [CO_B]);
  await pool.query(`UPDATE vendors SET party_id = NULL WHERE company_id = $1`, [CO_B]);
  await pool.query(`DELETE FROM vendors WHERE company_id = $1`, [CO_B]);
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZRV foreign tenant', 'ZZRVF') ON CONFLICT (id) DO NOTHING`,
    [CO_B]
  );
  await sweep();

  const { rows: [item] } = await pool.query(
    `SELECT id, item_name, gst_rate, default_gst_rate, COALESCE(reorder_level,0) AS reorder_level
       FROM inventory_items
      WHERE company_id = $1 AND deleted_at IS NULL AND is_active = true
        AND COALESCE(default_gst_rate, 0) > 0
      ORDER BY id LIMIT 1`, [CO_A]
  );
  if (!item) throw new Error('No active company-1 component with a master GST rate — cannot test tax carry-over.');
  seed.item = item;

  // A vendor with rating history, so PO approval's minimum-rating gate is not
  // what stops the conversion tests.
  const { rows: [vendor] } = await pool.query(
    `SELECT v.id, v.vendor_name FROM vendors v
      WHERE v.company_id = $1 AND v.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM vendor_ratings r WHERE r.vendor_id = v.id)
      ORDER BY v.id LIMIT 1`, [CO_A]
  );
  if (!vendor) throw new Error('No rated company-1 vendor — the PO approval gate would mask these results.');
  seed.vendor = vendor;

  const { rows: vendors } = await pool.query(
    `SELECT id FROM vendors WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 2`, [CO_A]
  );
  seed.vendorIds = vendors.map(v => v.id);

  const { rows: [emp] } = await pool.query(
    `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [CO_A]
  );
  seed.employeeId = emp?.id ?? null;

  // The account whose users.id is NOT an employees.id and which has no employee
  // record to fall back to. If every account has one, the generalisation below
  // cannot be tested and the suite says so rather than passing vacuously.
  const { rows: [orphan] } = await pool.query(
    `SELECT u.id FROM users u
      WHERE u.is_active AND u.employee_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.company_email = u.email AND e.deleted_at IS NULL)
      ORDER BY u.id LIMIT 1`
  );
  if (!orphan) throw new Error('Every active account resolves to an employee — cannot test the actor-stamping class.');
  seed.userIdWithoutEmployee = orphan.id;

  // An account whose JWT claim is absent but whose users row DOES link to an
  // employee — the case employeeOf() exists to recover and the raw claim cannot.
  const { rows: [linked] } = await pool.query(
    `SELECT u.id, u.employee_id FROM users u
       JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active AND e.company_id = $1 AND e.deleted_at IS NULL
      ORDER BY u.id LIMIT 1`, [CO_A]
  );
  if (!linked) throw new Error('No active account links to a company-1 employee — cannot test the claim fallback.');
  seed.userWithEmployee = linked;

  const { rows: [wh] } = await pool.query(
    `SELECT id FROM warehouses WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1) ORDER BY id LIMIT 1`, [CO_A]
  );
  seed.warehouseId = wh?.id ?? null;
}, 30000);

afterAll(async () => {
  await sweep();
  await pool.query(`DELETE FROM companies WHERE id = $1`, [CO_B]);
});

// ── helpers ──────────────────────────────────────────────────────────────────
async function raisePr({ quantity = 2, price = 500 } = {}) {
  const res = await buyer().post('/api/procurement/purchase-requests').send({
    request_date: new Date().toISOString().slice(0, 10),
    notes: `${TAG} requisition`,
    priority: 'medium',
    items: [{ item_id: seed.item.id, item_name: `${TAG} ${seed.item.item_name}`, quantity, expected_price: price }],
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function raiseRfqWithQuotes() {
  const res = await buyer().post('/api/procurement/rfqs').send({
    item_description: `${TAG} sourcing event`,
    quantity: 10, unit: 'Nos',
    required_by: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
    vendor_ids: seed.vendorIds,
    items: [{ item_id: seed.item.id, item_name: `${TAG} ${seed.item.item_name}`, quantity: 10 }],
  });
  expect(res.status).toBe(201);
  const rfqId = res.body.id;
  await buyer().post(`/api/procurement/rfqs/${rfqId}/responses/${seed.vendorIds[0]}`)
    .send({ unit_price: 120, total_amount: 1200, delivery_days: 10 });
  await buyer().post(`/api/procurement/rfqs/${rfqId}/responses/${seed.vendorIds[1]}`)
    .send({ unit_price: 110, total_amount: 1100, delivery_days: 12 });
  return rfqId;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('D1 — a sourcing event belongs to its tenant', () => {
  it('does not hand another tenant an RFQ, its quotes or its unit prices', async () => {
    const rfqId = await raiseRfqWithQuotes();

    const mine = await buyer().get(`/api/procurement/rfqs/${rfqId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.quotes.length).toBeGreaterThan(0);

    // rfqs.id is a sequential integer, so an unscoped read here is not a
    // needle-in-a-haystack exposure — it is the whole quote history, walkable.
    const theirs = await tenantB().get(`/api/procurement/rfqs/${rfqId}`);
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body)).not.toContain('unit_price');
  });
});

describe('D2 — the negotiated price book belongs to its tenant', () => {
  it('keeps a hand-keyed price inside the company that keyed it', async () => {
    const created = await admin().post('/api/procurement/price-history').send({
      item_id: seed.item.id, vendor_id: seed.vendor.id,
      unit_price: 987.65, quantity: 5, price_type: 'purchase',
      notes: `${TAG} negotiated rate`,
    });
    expect(created.status).toBe(201);
    expect(Number(created.body.company_id)).toBe(CO_A);

    const mine = await buyer().get(`/api/procurement/price-history?item_id=${seed.item.id}`);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).toContain('987.65');

    // price_history had no company_id column at all, so there was nothing to
    // scope the manual leg of these unions on. Scoping the purchase-order leg
    // alone still handed over every hand-keyed price.
    for (const url of [
      `/api/procurement/price-history?item_id=${seed.item.id}`,
      `/api/procurement/price-history/compare?item_id=${seed.item.id}`,
      `/api/procurement/vendor-comparison?item_name=${encodeURIComponent(seed.item.item_name)}`,
    ]) {
      const theirs = await tenantB().get(url);
      expect(JSON.stringify(theirs.body), `${url} leaked the price`).not.toContain('987.65');
      expect(JSON.stringify(theirs.body), `${url} leaked the note`).not.toContain(TAG);
    }
  });

  it('does not offer another tenant its component list or its demand and cost', async () => {
    const picker = await tenantB().get('/api/procurement/price-history/items?q=');
    expect(picker.status).toBe(200);
    expect(picker.body.map(r => r.id)).not.toContain(seed.item.id);

    // The two figures a competitor would most like to have.
    const eoq = await tenantB().get(`/api/procurement/analytics/eoq?item_id=${seed.item.id}`);
    expect(eoq.status).toBe(404);

    const mine = await buyer().get(`/api/procurement/analytics/eoq?item_id=${seed.item.id}`);
    expect(mine.status).toBe(200);
  });
});

describe('D3 — vendor health belongs to its tenant', () => {
  it('does not disclose another tenant\'s strategic flags', async () => {
    const theirs = await tenantB().get(`/api/vendor-health/${seed.vendor.id}`);
    expect(theirs.status).toBe(404);
    // Three of the four reads behind this endpoint were scoped and came back
    // empty; the fourth was not, so the response still carried the flags that
    // say where this company's supply chain breaks.
    expect(JSON.stringify(theirs.body)).not.toContain('is_single_source');
    expect(JSON.stringify(theirs.body)).not.toContain('is_critical_supplier');

    const mine = await buyer().get(`/api/vendor-health/${seed.vendor.id}`);
    expect(mine.status).toBe(200);
  });

  it('does not let one tenant score another tenant\'s vendor into its own books', async () => {
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM vendor_health_scores WHERE company_id = $1`, [CO_B]);
    const res = await tenantB().post(`/api/vendor-health/${seed.vendor.id}/recalculate`).send({});
    expect(res.status).toBe(404);
    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM vendor_health_scores WHERE company_id = $1`, [CO_B]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('answers a non-numeric vendor id with a bad request, not a database error', async () => {
    const res = await buyer().get('/api/vendor-health/undefined');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('invalid input syntax');
  });
});

describe('D4 — choosing a preferred vendor and awarding are two decisions', () => {
  it('records the evaluation without closing the event, so the award can still raise an order', async () => {
    const rfqId = await raiseRfqWithQuotes();
    const winnerId = seed.vendorIds[1];

    const pv = await buyer()
      .post(`/api/rfx/${rfqId}/preferred-vendor`)
      .send({ vendor_id: winnerId, rationale: `${TAG} preferred`, acknowledge_override: true });
    expect(pv.status).toBe(201);

    // 'closed' is what the award writes and what both screens read as
    // "awarded". Writing it here left an event that looked awarded, had no
    // winning quote and no order, and could never get one.
    const { rows: [mid] } = await pool.query('SELECT rfq_number, status, evaluated_at FROM rfqs WHERE id = $1', [rfqId]);
    expect(mid.status).not.toBe('closed');
    expect(mid.evaluated_at).not.toBeNull();

    // The selection still has to do its own job.
    const { rows: avl } = await pool.query('SELECT id FROM approved_vendor_list WHERE source_rfq_id = $1', [rfqId]);
    expect(avl.length).toBeGreaterThan(0);

    const award = await buyer().patch(`/api/procurement/rfqs/${rfqId}/award/${winnerId}`).send({});
    expect(award.status).toBe(200);
    expect(award.body.already_awarded).toBeUndefined();

    const { rows: pos } = await pool.query(
      `SELECT id, total_amount FROM purchase_orders WHERE notes LIKE $1 AND deleted_at IS NULL`,
      [`%${mid.rfq_number}%`]
    );
    expect(pos.length).toBe(1);

    const { rows: [won] } = await pool.query(
      'SELECT vendor_id FROM rfq_quotes WHERE rfq_id = $1 AND is_winner = true', [rfqId]
    );
    expect(String(won.vendor_id)).toBe(String(winnerId));

    // and awarding twice is still one order
    const again = await buyer().patch(`/api/procurement/rfqs/${rfqId}/award/${winnerId}`).send({});
    expect(again.status).toBe(200);
    const { rows: after } = await pool.query(
      `SELECT id FROM purchase_orders WHERE notes LIKE $1 AND deleted_at IS NULL`, [`%${mid.rfq_number}%`]
    );
    expect(after.length).toBe(1);
  }, 30000);

  it('refuses to report success for a closed event that has no award behind it', async () => {
    const rfqId = await raiseRfqWithQuotes();
    // The state the old preferred-vendor path used to leave behind.
    await pool.query(`UPDATE rfqs SET status = 'closed' WHERE id = $1`, [rfqId]);
    const res = await buyer().patch(`/api/procurement/rfqs/${rfqId}/award/${seed.vendorIds[0]}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RFQ_CLOSED_WITHOUT_AWARD');
  });
});

describe('D5 — a converted purchase order is taxed like a keyed one', () => {
  it('carries the component\'s GST, so the vendor\'s invoice still matches', async () => {
    const pr = await raisePr({ quantity: 2, price: 500 });
    await buyer().put(`/api/procurement/purchase-requests/${pr.id}/approve`).send({});
    const conv = await buyer()
      .patch(`/api/procurement/purchase-requests/${pr.id}/convert-to-po`)
      .send({ supplier_id: seed.vendor.id });
    expect([200, 201]).toContain(conv.status);

    const { rows: [po] } = await pool.query(
      'SELECT subtotal, tax_amount, total_amount FROM purchase_orders WHERE id = $1', [conv.body.po_id]
    );
    // The requisition line carries no rate of its own, so the rate comes from
    // the component master. Writing 0 here made every requisition-driven order
    // fail its own three-way match by exactly the tax.
    expect(Number(po.subtotal)).toBe(1000);
    expect(Number(po.tax_amount)).toBeGreaterThan(0);
    expect(Number(po.total_amount)).toBe(Number(po.subtotal) + Number(po.tax_amount));

    const { rows: lines } = await pool.query(
      'SELECT tax_rate, tax_amount FROM purchase_order_items WHERE po_id = $1', [conv.body.po_id]
    );
    expect(lines.length).toBe(1);
    expect(Number(lines[0].tax_rate)).toBeGreaterThan(0);

    // And the figure the invoice leg compares against is now the gross the
    // vendor will actually bill.
    await buyer().patch(`/api/procurement/purchase-orders/${conv.body.po_id}/approve`).send({});
    const { rows: [wh] } = await pool.query('SELECT id FROM warehouses WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
    const { rows: poLines } = await pool.query('SELECT * FROM purchase_order_items WHERE po_id = $1', [conv.body.po_id]);
    const grn = await buyer().post('/api/procurement/grn').send({
      po_id: conv.body.po_id, warehouse_id: wh.id,
      received_date: new Date().toISOString().slice(0, 10),
      items: poLines.map(l => ({ po_item_id: l.id, item_id: l.item_id, quantity_received: Number(l.quantity), quantity_rejected: 0, rate: Number(l.rate) })),
    });
    expect(grn.status).toBe(201);

    const match = await buyer().post('/api/procurement/three-way-match').send({
      po_id: conv.body.po_id, grn_id: grn.body.id,
      vendor_invoice_no: `${TAG}-${Date.now()}`,
      vendor_invoice_date: new Date().toISOString().slice(0, 10),
      vendor_invoice_amount: Number(po.total_amount),
    });
    expect(match.status).toBe(201);
    expect(match.body.match_status).toBe('matched');
  }, 30000);
});

describe('D6 / D7 — the two buttons that reported success and did nothing', () => {
  it('writes a manual price for an account that has no employee record', async () => {
    // price_history.created_by FKs employees(id) and this route wrote a
    // users.id, so it answered 500 for every one of the 37 active accounts in
    // this database. Eighth instance of the trap.
    const res = await noEmployee().post('/api/procurement/price-history').send({
      item_id: seed.item.id, vendor_id: seed.vendor.id,
      unit_price: 42.5, quantity: 1, notes: `${TAG} keyed by an admin`,
    });
    expect(res.status).toBe(201);
    expect(res.body.created_by).toBeNull();
    expect(Number(res.body.company_id)).toBe(CO_A);
  });

  it('raises a real requisition from a reorder alert, not an empty success', async () => {
    const res = await admin().post('/api/inventory/reorder-alerts/generate-pos')
      .send({ item_ids: [seed.item.id] });

    // The old failure answered 200 with count 0 and the throw hidden in
    // `failed[]`, which the screen reported as a success.
    expect(res.status).toBe(200);
    expect(res.body.failed_count, JSON.stringify(res.body.failed)).toBe(0);
    expect(res.body.count).toBe(1);

    const pr = res.body.purchase_requests[0];
    const { rows: [row] } = await pool.query('SELECT * FROM purchase_requests WHERE id = $1', [pr.id]);
    expect(row.request_number).toBeTruthy();       // not the legacy pr_number column
    expect(Number(row.company_id)).toBe(CO_A);     // not NULL, which no scoped user can see
    const { rows: lines } = await pool.query('SELECT * FROM purchase_request_items WHERE pr_id = $1', [row.id]);
    expect(lines.length).toBe(1);                  // `items` used to be dropped on the floor
    expect(Number(row.total_amount)).toBeGreaterThanOrEqual(0);

    await pool.query('DELETE FROM purchase_request_items WHERE pr_id = $1', [row.id]);
    await pool.query('DELETE FROM purchase_requests WHERE id = $1', [row.id]);
  });

  it('still answers the caller that reads the old response key', async () => {
    const res = await admin().post('/api/inventory/reorder-alerts/generate-pos')
      .send({ item_ids: [seed.item.id] });
    expect(Array.isArray(res.body.purchase_orders)).toBe(true);
    expect(res.body.purchase_orders.length).toBe(res.body.count);
    for (const pr of res.body.purchase_requests) {
      await pool.query('DELETE FROM purchase_request_items WHERE pr_id = $1', [pr.id]);
      await pool.query('DELETE FROM purchase_requests WHERE id = $1', [pr.id]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The second round: D8, D9, D10, D14.
// ─────────────────────────────────────────────────────────────────────────────

/** An approved order with one line, ready to receive against. */
async function approvedPo({ quantity = 4, price = 25 } = {}) {
  const pr = await raisePr({ quantity, price });
  await buyer().put(`/api/procurement/purchase-requests/${pr.id}/approve`).send({});
  const conv = await buyer().patch(`/api/procurement/purchase-requests/${pr.id}/convert-to-po`)
    .send({ supplier_id: seed.vendor.id });
  await buyer().patch(`/api/procurement/purchase-orders/${conv.body.po_id}/approve`).send({});
  const { rows: lines } = await pool.query('SELECT * FROM purchase_order_items WHERE po_id = $1', [conv.body.po_id]);
  return { poId: conv.body.po_id, lines };
}

/** A receipt that is being held for incoming inspection. */
async function heldReceipt() {
  const { poId, lines } = await approvedPo();
  const res = await buyer().post('/api/procurement/grn').send({
    po_id: poId, warehouse_id: seed.warehouseId,
    received_date: new Date().toISOString().slice(0, 10),
    items: lines.map(l => ({
      po_item_id: l.id, item_id: l.item_id,
      quantity_received: Number(l.quantity), quantity_rejected: 0, rate: Number(l.rate),
    })),
  });
  expect(res.status).toBe(201);
  const { rows: [grn] } = await pool.query('SELECT * FROM goods_receipt_notes WHERE id = $1', [res.body.id]);
  return grn;
}

const ledgerFor = async (grnId) => (await pool.query(
  `SELECT * FROM stock_ledger WHERE reference_type='grn' AND reference_id::text = $1::text`, [String(grnId)])).rows;

describe('D8 — a pass recorded in Procurement releases the goods it clears', () => {
  it('releases the held stock, and posts batch and ledger together', async () => {
    const grn = await heldReceipt();
    expect(grn.quality_status, 'fixture drift: the receipt was not held for IQC').toBe('pending');
    expect(await ledgerFor(grn.id)).toHaveLength(0);

    const res = await buyer().post('/api/procurement/quality-inspections').send({
      grn_id: grn.id, overall_result: 'pass', notes: `${TAG} incoming`,
      items: [{ item_id: seed.item.id, parameter: 'visual', result: 'pass' }],
    });
    expect(res.status).toBe(201);

    // The screen used to stop at the inspection row and the goods stayed held.
    const { rows: [after] } = await pool.query('SELECT quality_status FROM goods_receipt_notes WHERE id = $1', [grn.id]);
    expect(after.quality_status).toBe('passed');

    const ledger = await ledgerFor(grn.id);
    const { rows: batches } = await pool.query('SELECT * FROM inventory_batches WHERE grn_id = $1 AND deleted_at IS NULL', [grn.id]);
    expect(ledger.length, 'a pass must post the held stock').toBe(1);
    expect(batches.length, 'batch and ledger move together or not at all').toBe(1);
    expect(Number(ledger[0].quantity_in)).toBe(Number(batches[0].quantity_available));
    expect(res.body.stock_released).toBe(true);
  }, 40_000);

  it('does not release anything on a fail', async () => {
    const grn = await heldReceipt();
    const res = await buyer().post('/api/procurement/quality-inspections').send({
      grn_id: grn.id, overall_result: 'fail', notes: `${TAG} rejected`,
      items: [{ item_id: seed.item.id, parameter: 'visual', result: 'fail' }],
    });
    expect(res.status).toBe(201);
    const { rows: [after] } = await pool.query('SELECT quality_status FROM goods_receipt_notes WHERE id = $1', [grn.id]);
    expect(after.quality_status).toBe('failed');
    expect(await ledgerFor(grn.id)).toHaveLength(0);
    expect(res.body.stock_released).toBe(false);
  }, 40_000);

  it('releases on a header-only pass, with no per-parameter lines', async () => {
    // A verdict with no lines used to leave the receipt with zero tests, which
    // the rollup reads as 'not_required' rather than 'passed'.
    const grn = await heldReceipt();
    const res = await buyer().post('/api/procurement/quality-inspections').send({
      grn_id: grn.id, overall_result: 'pass', notes: `${TAG} header only`,
    });
    expect(res.status).toBe(201);
    const { rows: [after] } = await pool.query('SELECT quality_status FROM goods_receipt_notes WHERE id = $1', [grn.id]);
    expect(after.quality_status).toBe('passed');
    expect(await ledgerFor(grn.id)).toHaveLength(1);
  }, 40_000);

  it('will not file an inspection against another tenant\'s receipt', async () => {
    const grn = await heldReceipt();
    const res = await tenantB().post('/api/procurement/quality-inspections').send({
      grn_id: grn.id, overall_result: 'pass', notes: `${TAG} foreign`,
    });
    expect(res.status).toBe(404);
    const { rows: [after] } = await pool.query('SELECT quality_status FROM goods_receipt_notes WHERE id = $1', [grn.id]);
    expect(after.quality_status).toBe('pending');
    expect(await ledgerFor(grn.id)).toHaveLength(0);
  }, 40_000);
});

describe('D9 — a purchase order records who raised it', () => {
  it('resolves the requester from the users row when the token has no claim', async () => {
    // The raw claim is absent on any token minted before employee_id existed.
    // created_by is the recipient the approval notification is addressed to, so
    // a NULL here silently disables the toggle rather than failing loudly.
    const app = request(appAs({
      roles: ['procurement_manager'],
      userId: seed.userWithEmployee.id,
      employeeId: null,               // the claim the old code read
    }));
    const res = await app.post('/api/procurement/purchase-orders').send({
      supplier_id: seed.vendor.id,
      order_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} claimless`,
      items: [{ item_id: seed.item.id, quantity: 1, rate: 10, gst_rate: 18 }],
    });
    expect(res.status).toBe(201);
    const { rows: [po] } = await pool.query('SELECT created_by FROM purchase_orders WHERE id = $1', [res.body.id]);
    expect(po.created_by).toBe(seed.userWithEmployee.employee_id);
  });
});

describe('D10 — a KPI strip accounts for its own total', () => {
  it('purchase-order buckets sum to the total', async () => {
    const res = await buyer().get('/api/procurement/purchase-orders/stats');
    expect(res.status).toBe(200);
    const s = res.body;
    // follow_up is a SUBSET of pending and is deliberately not a bucket.
    const buckets = s.draft + s.pending + s.approved + s.partial + s.received + s.cancelled + s.other;
    expect(buckets, `buckets ${JSON.stringify(s)} do not account for total ${s.total}`).toBe(s.total);
    expect(s.other, 'an unnamed status appeared — give it a card').toBe(0);
  });

  it('purchase-request buckets sum to the total', async () => {
    const res = await buyer().get('/api/procurement/purchase-requests/stats');
    expect(res.status).toBe(200);
    const s = res.body;
    const buckets = s.draft + s.pending_approval + s.approved + s.ordered + s.rejected + s.other;
    expect(buckets, `buckets ${JSON.stringify(s)} do not account for total ${s.total}`).toBe(s.total);
    expect(s.other, 'an unnamed status appeared — name it').toBe(0);
  });
});

describe('D14 — a hand-booked batch is stock the ledger knows about', () => {
  const batchBody = () => ({
    item_id: seed.item.id, warehouse_id: seed.warehouseId,
    batch_number: `${TAG}-${Date.now()}`,
    received_date: new Date().toISOString().slice(0, 10),
    quantity_received: 7, rate: 12.5,
  });

  it('writes the batch and the ledger entry together', async () => {
    const body = batchBody();
    const res = await admin().post('/api/inventory/advanced/batches').send(body);
    expect(res.status).toBe(201);
    const { rows: [batch] } = await pool.query('SELECT * FROM inventory_batches WHERE id = $1', [res.body.id]);
    const { rows: ledger } = await pool.query(
      `SELECT * FROM stock_ledger WHERE reference_type='inventory_batch' AND reference_id::text = $1::text`, [String(res.body.id)]);
    expect(batch, 'the batch should exist').toBeTruthy();
    expect(ledger.length, 'a batch with no ledger row is stock nobody can reconcile').toBe(1);
    expect(Number(ledger[0].quantity_in)).toBe(7);

    // Removing the ledger row restores current_stock on its own — see the
    // teardown note above.
    await pool.query(`DELETE FROM stock_ledger WHERE reference_type='inventory_batch' AND reference_id::text = $1::text`, [String(res.body.id)]);
    await pool.query('DELETE FROM inventory_batches WHERE id = $1', [res.body.id]);
  });

  it('refuses another tenant\'s item, and writes nothing', async () => {
    const before = await pool.query('SELECT COUNT(*)::int n FROM inventory_batches');
    const res = await tenantB().post('/api/inventory/advanced/batches').send(batchBody());
    expect(res.status).toBe(404);
    // The MESSAGE matters, not just the status. There are two tenant guards
    // here — the item and the warehouse — and the warehouse one alone is
    // enough to produce a 404, so a status-only assertion stays green when the
    // ITEM check is removed. Caught exactly that way: the mutation that
    // stripped the item predicate left this test passing for the wrong reason.
    // The item is checked first, so its message is what pins that guard.
    expect(res.body.error).toMatch(/Item not found/);
    const after = await pool.query('SELECT COUNT(*)::int n FROM inventory_batches');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('refuses a warehouse the caller does not own', async () => {
    const { rows: [maxWh] } = await pool.query('SELECT COALESCE(MAX(id),0)+1000 AS id FROM warehouses');
    const res = await admin().post('/api/inventory/advanced/batches')
      .send({ ...batchBody(), warehouse_id: maxWh.id });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Warehouse not found/);
  });

  it('refuses a body with no quantity instead of booking a phantom batch', async () => {
    const res = await admin().post('/api/inventory/advanced/batches').send({ ...batchBody(), quantity_received: 0 });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The third round: D12, D15, and the sourcing link (item 19).
// ─────────────────────────────────────────────────────────────────────────────

describe('D12 — a purchase order can be charged to a project and a cost centre', () => {
  it('offers both, and stores what it was given', async () => {
    const targets = await buyer().get('/api/procurement/charge-targets');
    expect(targets.status).toBe(200);
    expect(Array.isArray(targets.body.projects)).toBe(true);
    expect(Array.isArray(targets.body.cost_centres)).toBe(true);
    // The picker exists to be filled; an empty one is the "API-only" state
    // this defect was about.
    expect(targets.body.cost_centres.length, 'no cost centre to charge an order to').toBeGreaterThan(0);

    const project = targets.body.projects[0];
    const centre  = targets.body.cost_centres[0];
    const res = await buyer().post('/api/procurement/purchase-orders').send({
      supplier_id: seed.vendor.id,
      order_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} charged`,
      project_id: project?.id ?? null,
      cost_center_id: centre.id,
      items: [{ item_id: seed.item.id, quantity: 1, rate: 100, gst_rate: 18 }],
    });
    expect(res.status).toBe(201);
    const { rows: [po] } = await pool.query(
      'SELECT project_id, cost_center_id FROM purchase_orders WHERE id = $1', [res.body.id]);
    expect(Number(po.cost_center_id)).toBe(Number(centre.id));
    if (project) expect(Number(po.project_id)).toBe(Number(project.id));
  });

  it('refuses a project or a cost centre belonging to another company', async () => {
    const { rows: [centre] } = await pool.query(
      `SELECT id FROM cost_centers WHERE company_id = $1 ORDER BY id LIMIT 1`, [CO_A]);
    // The FK proves the row exists; it does not prove it is the caller's.
    const res = await tenantB().post('/api/procurement/purchase-orders').send({
      supplier_id: seed.vendor.id,
      order_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} foreign charge`,
      cost_center_id: centre.id,
      items: [{ item_id: seed.item.id, quantity: 1, rate: 100 }],
    });
    expect(res.status).toBe(404);
  });

  it('does not offer another tenant its projects or cost centres', async () => {
    const res = await tenantB().get('/api/procurement/charge-targets');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(0);
    expect(res.body.cost_centres).toHaveLength(0);
  });
});

describe('item 19 — the sourcing strategy reaches the buying decision', () => {
  /**
   * A recorded strategy for the bucket the seed item actually falls in.
   *
   * ⚠ Not one component in this database carries a `category_id`, so the seed
   * item is in the UNCATEGORISED bucket — which the sourcing board treats as a
   * first-class category and which a strategy can be recorded against with
   * `category_id IS NULL`. An earlier version of this test bailed out with
   * `if (!strategy) return` when the item had no category, which made every
   * assertion below unreachable: three mutations to the resolver left the suite
   * green. A test that silently declines to run is worse than no test, because
   * it reports a pass. It now records against whichever bucket applies, and
   * asserts rather than skips.
   */
  async function recordStrategy() {
    const { rows: [item] } = await pool.query(
      'SELECT category_id FROM inventory_items WHERE id = $1', [seed.item.id]);
    const { rows: [s] } = await pool.query(
      `INSERT INTO sourcing_category_strategies
         (company_id, category_id, quadrant_key, lever_key, method_key, method_label, status, rationale)
       VALUES ($1,$2,'leverage','commercial','tendering','Competitive tendering','active',$3)
       RETURNING *`, [CO_A, item.category_id ?? null, `${TAG} strategy`]);
    return s;
  }

  it('reports the strategy in force, and whether the order followed it', async () => {
    const strategy = await recordStrategy();
    expect(strategy, 'no strategy could be recorded, so nothing below is being tested').toBeTruthy();

    // The vendor is NOT on the approved list for this item, so this order
    // diverges from the strategy — recorded, never blocked.
    await pool.query(`DELETE FROM approved_vendor_list WHERE item_id = $1 AND vendor_id = $2`,
      [seed.item.id, seed.vendor.id]);
    const diverged = await buyer().post('/api/procurement/purchase-orders').send({
      supplier_id: seed.vendor.id, order_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} diverged`,
      items: [{ item_id: seed.item.id, quantity: 1, rate: 100 }],
    });
    expect(diverged.status, 'an award against the strategy must not be blocked').toBe(201);
    expect(diverged.body.sourcing_advisory.strategy.id).toBe(strategy.id);
    expect(diverged.body.sourcing_advisory.followed).toBe(false);
    const { rows: [poA] } = await pool.query(
      'SELECT sourcing_strategy_id, followed_sourcing_strategy FROM purchase_orders WHERE id = $1',
      [diverged.body.id]);
    expect(poA.sourcing_strategy_id).toBe(strategy.id);
    expect(poA.followed_sourcing_strategy).toBe(false);

    // Now approve the vendor under the strategy — the same row selectPreferredVendor writes.
    await pool.query(
      `INSERT INTO approved_vendor_list (company_id, item_id, vendor_id, status, is_preferred, notes)
       VALUES ($1,$2,$3,'approved',TRUE,$4)`,
      [CO_A, seed.item.id, seed.vendor.id, `${TAG} approved`]);
    const followed = await buyer().post('/api/procurement/purchase-orders').send({
      supplier_id: seed.vendor.id, order_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} followed`,
      items: [{ item_id: seed.item.id, quantity: 1, rate: 100 }],
    });
    expect(followed.body.sourcing_advisory.followed).toBe(true);
    const { rows: [poB] } = await pool.query(
      'SELECT followed_sourcing_strategy FROM purchase_orders WHERE id = $1', [followed.body.id]);
    expect(poB.followed_sourcing_strategy).toBe(true);
  }, 30_000);

  it('says "not applicable" rather than "not followed" when no strategy exists', async () => {
    // The distinction that keeps this column honest: a buyer who had no
    // strategy to follow must not be recorded as having ignored one.
    await pool.query(`DELETE FROM sourcing_category_strategies WHERE rationale LIKE $1`, [`%${TAG}%`]);
    const res = await buyer().post('/api/procurement/purchase-orders').send({
      supplier_id: seed.vendor.id, order_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} nostrategy`,
      items: [{ item_id: seed.item.id, quantity: 1, rate: 100 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.sourcing_advisory.followed).toBeNull();
    const { rows: [po] } = await pool.query(
      'SELECT sourcing_strategy_id, followed_sourcing_strategy FROM purchase_orders WHERE id = $1', [res.body.id]);
    expect(po.sourcing_strategy_id).toBeNull();
    expect(po.followed_sourcing_strategy).toBeNull();
  });
});

describe('D15 — an approved purchase order actually notifies someone', () => {
  it('delivers a notification when the tenant has the toggle on', async () => {
    const { rows: [settings] } = await pool.query(
      'SELECT notify_po_approval FROM procurement_settings WHERE company_id = $1', [CO_A]);
    expect(settings.notify_po_approval, 'this tenant has PO-approval notifications switched off').toBe(true);

    // Raised by an account that HAS an employee record, so created_by resolves
    // and there is somebody to address the notification to — which is the whole
    // of what D9 fixed.
    const app = request(appAs({
      roles: ['procurement_manager'],
      userId: seed.userWithEmployee.id,
      employeeId: seed.userWithEmployee.employee_id,
    }));
    const po = await app.post('/api/procurement/purchase-orders').send({
      supplier_id: seed.vendor.id, order_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} notify`,
      items: [{ item_id: seed.item.id, quantity: 1, rate: 50, gst_rate: 18 }],
    });
    expect(po.status).toBe(201);
    const { rows: [row] } = await pool.query('SELECT created_by FROM purchase_orders WHERE id = $1', [po.body.id]);
    expect(row.created_by, 'no recipient, so nothing could be delivered').toBe(seed.userWithEmployee.employee_id);

    const before = await pool.query('SELECT COUNT(*)::int n FROM notifications');
    const approved = await app.patch(`/api/procurement/purchase-orders/${po.body.id}/approve`).send({});
    expect(approved.status).toBe(200);
    // notifyWorkflowEvent is fire-and-forget by design — the approval must not
    // wait on delivery — so give it a moment before reading the row.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await pool.query('SELECT COUNT(*)::int n FROM notifications');
    expect(after.rows[0].n, 'the toggle is on and the recipient resolves, so one must be delivered')
      .toBeGreaterThan(before.rows[0].n);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// The part that matters more: the SHAPES, not the instances.
// ═════════════════════════════════════════════════════════════════════════════
describe('the shapes', () => {
  /**
   * Every by-id read in the module, swept in one table.
   *
   * The previous pass tested tenant scoping on the core objects (PO, GRN, PR,
   * vendor) and role gating on the satellite routers, so a by-id read that was
   * scoped on neither had no test that could fail. Adding a route to this table
   * is one line; forgetting to is what this sweep exists to catch.
   */
  /**
   * Give tenant B real data of its own.
   *
   * Until this existed, every isolation result in this suite was measured
   * against an EMPTY second tenant. That proves a foreign caller sees nothing —
   * but it cannot tell "correctly scoped" apart from "returns nothing to
   * anybody", and it cannot catch the opposite leak, where tenant B's own rows
   * bleed into tenant A. The four leaks this suite exists for were all found by
   * walking ids from a tenant with almost nothing in it, and that method has a
   * ceiling.
   *
   * So B gets its own vendor, item and order, and the sweep now asserts BOTH
   * directions. Torn down with the rest of the fixtures.
   */
  async function populateTenantB() {
    const { rows: [vendor] } = await pool.query(
      `INSERT INTO vendors (vendor_name, company_id, email, status)
       VALUES ($1, $2, 'zzrv-b@example.test', 'active') RETURNING id`,
      [`${TAG} tenant-B supplier`, CO_B]);
    const { rows: [item] } = await pool.query(
      `INSERT INTO inventory_items (item_name, item_code, company_id, is_active, unit_of_measure)
       VALUES ($1, $2, $3, true, 'Nos') RETURNING id`,
      [`${TAG} tenant-B component`, `${TAG}-B-${Date.now()}`, CO_B]);
    const { rows: [po] } = await pool.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, company_id, order_date, status,
                                    subtotal, tax_amount, total_amount, notes)
       VALUES ($1, $2, $3, CURRENT_DATE, 'draft', 500, 0, 500, $4) RETURNING id`,
      [`${TAG}-B-${Date.now()}`, vendor.id, CO_B, `${TAG} tenant-B order`]);
    await pool.query(
      `INSERT INTO purchase_order_items (po_id, item_id, quantity, rate, tax_rate, tax_amount, total_amount)
       VALUES ($1, $2, 5, 100, 0, 0, 500)`, [po.id, item.id]);
    return { vendorId: vendor.id, itemId: item.id, poId: po.id };
  }

  it('answers no by-id read with another tenant\'s row, in either direction', async () => {
    const b = await populateTenantB();

    // ── B must not see A's ──────────────────────────────────────────────────
    // (the sweep below), and A must not see B's.
    const aSeesB = [];
    for (const [label, url] of [
      ['purchase order',  `/api/procurement/purchase-orders/${b.poId}`],
      ['vendor scorecard',`/api/procurement/vendors/${b.vendorId}/scorecard`],
      ['vendor health',   `/api/vendor-health/${b.vendorId}`],
      ['price history',   `/api/procurement/price-history?item_id=${b.itemId}`],
      ['eoq',             `/api/procurement/analytics/eoq?item_id=${b.itemId}`],
    ]) {
      const res = await buyer().get(url);
      if (res.status >= 400) continue;
      const s = JSON.stringify(res.body ?? {});
      if (s.includes(TAG) || /"po_number"|"vendor_name"/.test(s)) aSeesB.push(`${label} -> ${res.status} ${s.slice(0, 110)}`);
    }
    expect(aSeesB, `company 1 read tenant B's rows:\n  ${aSeesB.join('\n  ')}`).toEqual([]);

    // A's list endpoints must not contain B's rows either.
    const list = await buyer().get('/api/procurement/purchase-orders');
    expect(JSON.stringify(list.body)).not.toContain(`${TAG} tenant-B order`);

    const ids = {};
    for (const [k, sql] of Object.entries({
      po:  `SELECT id FROM purchase_orders   WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      pr:  `SELECT id FROM purchase_requests WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      grn: `SELECT id FROM goods_receipt_notes WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      rfq: `SELECT id FROM rfqs              WHERE company_id = $1 ORDER BY id LIMIT 1`,
    })) {
      const { rows } = await pool.query(sql, [CO_A]);
      ids[k] = rows[0]?.id ?? null;
    }
    const vendorId = seed.vendor.id;

    const reads = [
      ids.po  && `/api/procurement/purchase-orders/${ids.po}`,
      ids.pr  && `/api/procurement/purchase-requests/${ids.pr}`,
      ids.grn && `/api/procurement/grn/${ids.grn}`,
      ids.rfq && `/api/procurement/rfqs/${ids.rfq}`,
      `/api/procurement/vendors/${vendorId}/scorecard`,
      `/api/vendor-health/${vendorId}`,
      `/api/vendor-health/${vendorId}/trend`,
      `/api/procurement/price-history?item_id=${seed.item.id}`,
      `/api/procurement/price-history/compare?item_id=${seed.item.id}`,
      `/api/procurement/analytics/eoq?item_id=${seed.item.id}`,
      `/api/procurement/vendor-comparison?item_name=${encodeURIComponent(seed.item.item_name)}`,
    ].filter(Boolean);

    const leaked = [];
    for (const url of reads) {
      const res = await tenantB().get(url);
      if (res.status >= 400) continue;                       // refused outright
      const body = res.body;
      const rows = Array.isArray(body) ? body
                 : Array.isArray(body?.history) ? body.history
                 : Array.isArray(body?.data) ? body.data
                 : null;
      if (Array.isArray(rows)) {
        if (rows.length > 0) leaked.push(`${url} -> ${res.status} with ${rows.length} row(s)`);
        continue;
      }
      // A single object: it is a leak unless every field that identifies the
      // other tenant's record is absent.
      const s = JSON.stringify(body ?? {});
      if (/"(id|vendor_id|po_number|grn_number|rfq_number|unit_price|item_name)"\s*:/.test(s)) {
        leaked.push(`${url} -> ${res.status} ${s.slice(0, 120)}`);
      }
    }
    expect(leaked, `by-id reads that answered a foreign tenant:\n  ${leaked.join('\n  ')}`).toEqual([]);
  }, 30000);

  /**
   * Every write that stamps who did it, driven by an account with no employee
   * record.
   *
   * `*_by` columns in this codebase point at employees(id) while `req.user.userId`
   * is a users.id, and the two spaces have been confused eight separate times.
   * A route that writes the wrong one raises a foreign key violation and 500s —
   * for 37 of the 37 active accounts here, in the case this sweep was written
   * for. What they have in common is not the column, it is the actor: an admin
   * or service account with nothing in `employees`.
   */
  it('lets an account with no employee record complete every actor-stamped write', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const writes = [
      ['POST /price-history', () => noEmployee().post('/api/procurement/price-history').send({
        item_id: seed.item.id, vendor_id: seed.vendor.id, unit_price: 11.5, notes: `${TAG} sweep`,
      })],
      ['POST /purchase-requests', () => noEmployee().post('/api/procurement/purchase-requests').send({
        request_date: today, notes: `${TAG} sweep`, priority: 'low',
        items: [{ item_id: seed.item.id, item_name: `${TAG}`, quantity: 1, expected_price: 10 }],
      })],
      ['POST /purchase-orders', () => noEmployee().post('/api/procurement/purchase-orders').send({
        supplier_id: seed.vendor.id, order_date: today, notes: `${TAG} sweep`,
        items: [{ item_id: seed.item.id, quantity: 1, rate: 10, gst_rate: 18 }],
      })],
      ['POST /vendor-ratings', () => noEmployee().post('/api/procurement/vendor-ratings').send({
        vendor_id: seed.vendor.id, quality_score: 4, delivery_score: 4, price_score: 4, overall_score: 4,
      })],
    ];

    const broken = [];
    for (const [label, run] of writes) {
      const res = await run();
      if (res.status >= 500) broken.push(`${label} -> ${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
    }
    expect(broken, `actor-stamped writes that failed for an account with no employee record:\n  ${broken.join('\n  ')}`).toEqual([]);

    await pool.query(`DELETE FROM vendor_ratings WHERE vendor_id = $1 AND overall_score = 4 AND rated_at > NOW() - INTERVAL '2 minutes'`, [seed.vendor.id]);
  }, 30000);
});
