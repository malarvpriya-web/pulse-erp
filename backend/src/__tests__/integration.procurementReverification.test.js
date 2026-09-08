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
    await pool.query(`DELETE FROM three_way_matches WHERE po_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_receipt_notes WHERE po_id = ANY($1::int[]))`, [ids]);
    await pool.query(`DELETE FROM goods_receipt_notes WHERE po_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM purchase_order_items WHERE po_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM purchase_orders WHERE id = ANY($1::int[])`, [ids]);
  }
  await pool.query(`DELETE FROM rfqs WHERE item_description LIKE $1`, like);
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, like);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, like);
  await pool.query(`DELETE FROM vendor_health_scores WHERE company_id = $1`, [CO_B]);
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
  it('answers no by-id read with another tenant\'s row', async () => {
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
