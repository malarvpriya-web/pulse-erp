/**
 * integration.procurementHardening.test.js
 *
 * The failure paths, driven through the REAL HTTP routes against the REAL
 * database: authorization, tenant isolation, idempotency, concurrency, and the
 * state transitions that must be refused.
 *
 * These go through the router rather than the service on purpose. Every defect
 * below lived in the ROUTE — a missing company predicate, a missing status
 * check, a users.id written into an employees column, a second click running the
 * whole handler again. A service-level test would have passed against all of
 * them because the service was never the thing that was wrong.
 *
 * The app is assembled with a stub that sets req.user/req.scope the way
 * verifyToken would; everything downstream of that — requireProcurement's real
 * role_permissions lookup, companyOf(), assertCanDecideAmount() — runs for real.
 * That is what makes the RBAC assertions meaningful: they are not asserting that
 * a mock said no.
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

const { default: pool }        = await import('../config/db.js');
const { default: procRouter }  = await import('../modules/procurement/routes/procurement.routes.js');
const { default: poRepo }      = await import('../modules/procurement/repositories/purchaseOrder.repository.js');

const TAG    = 'ZZHD';
const CO_A   = 1;
const CO_B   = 999902;

/** Build an app whose caller is exactly the identity given. */
function appAs({ roles, companyId = CO_A, userId = 1, employeeId = null }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, roles, company_id: companyId, employee_id: employeeId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/api/procurement', procRouter);
  return app;
}

const buyer    = () => appAs({ roles: ['procurement_manager'] });
const exec     = () => appAs({ roles: ['procurement_exec'] });     // add/edit, NOT approve
const store    = () => appAs({ roles: ['store_keeper'] });         // view only on the matrix
const salesRep = () => appAs({ roles: ['sales_exec'] });           // no procurement grant at all
const tenantB  = () => appAs({ roles: ['procurement_manager'], companyId: CO_B });

let itemId, warehouseId, vendorId, vendorB;

async function sweep() {
  const poScope  = `(SELECT id FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1)`;
  const grnScope = `(SELECT id FROM goods_receipt_notes WHERE grn_number LIKE $1 OR notes LIKE $1 OR po_id IN ${poScope})`;
  const p = [`${TAG}%`];
  await pool.query(`DELETE FROM bills WHERE bill_number LIKE $1 OR notes LIKE $1`, p);
  await pool.query(`DELETE FROM three_way_matches WHERE vendor_invoice_no LIKE $1 OR po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM stock_ledger WHERE reference_type='grn' AND reference_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM inventory_batches WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM grn_items WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM goods_receipt_notes WHERE grn_number LIKE $1 OR notes LIKE $1 OR po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1`, p);
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, p);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, p);
  await pool.query(`DELETE FROM local_purchase_requests WHERE description LIKE $1`, p);
  await pool.query(`UPDATE vendors SET party_id = NULL WHERE vendor_name LIKE $1`, p);
  await pool.query(`DELETE FROM parties WHERE name LIKE $1`, p);
  await pool.query(`DELETE FROM vendors WHERE vendor_name LIKE $1`, p);
}

beforeAll(async () => {
  await sweep();
  itemId      = (await pool.query('SELECT id FROM inventory_items ORDER BY id LIMIT 1')).rows[0]?.id;
  warehouseId = (await pool.query('SELECT id FROM warehouses ORDER BY id LIMIT 1')).rows[0]?.id;
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZHD foreign tenant', 'ZZHD') ON CONFLICT (id) DO NOTHING`,
    [CO_B]
  );
  vendorId = (await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status, category) VALUES ($1,$2,'active','Raw Materials') RETURNING id`,
    [`${TAG} Supplier A`, CO_A])).rows[0].id;
  vendorB = (await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status, category) VALUES ($1,$2,'active','Raw Materials') RETURNING id`,
    [`${TAG} Supplier B`, CO_B])).rows[0].id;
  // A rating history, so PO approval's min_vendor_rating gate does not stand in
  // for the thing under test. The gate itself has its own test below.
  for (const v of [vendorId, vendorB]) {
    await pool.query(
      `INSERT INTO vendor_ratings (company_id, vendor_id, quality_score, delivery_score, price_score, overall_score)
       VALUES ($1,$2,5,5,5,5)`, [v === vendorId ? CO_A : CO_B, v]
    );
    await pool.query(`UPDATE vendors SET quality_rating=5, delivery_rating=5, price_rating=5 WHERE id=$1`, [v]);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM vendor_ratings WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, [`${TAG}%`]);
  await sweep();
});

async function makePo({ company = CO_A, vendor = vendorId, status = 'draft', qty = 5, rate = 100, taxRate = 18 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subtotal = qty * rate, tax = subtotal * taxRate / 100;
    const po = await poRepo.create(client, {
      po_number: `${TAG}-PO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      supplier_id: vendor, order_date: new Date().toISOString().slice(0, 10),
      subtotal, tax_amount: tax, total_amount: subtotal + tax,
      notes: `${TAG} hardening`, company_id: company, created_by: null,
    });
    await client.query(`UPDATE purchase_orders SET status=$1 WHERE id=$2`, [status, po.id]);
    const line = await poRepo.createItem(client, {
      po_id: po.id, item_id: itemId, quantity: qty, rate,
      tax_rate: taxRate, tax_amount: tax, total_amount: subtotal + tax,
    });
    await client.query('COMMIT');
    return { po: { ...po, status }, line };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ═══════════════════════════════════════════════════════════════════════════
describe('authorization', () => {
  it('refuses a caller with no procurement grant at all', async () => {
    const res = await request(salesRep()).post('/api/procurement/vendors').send({ vendor_name: `${TAG} sneaky` });
    expect(res.status).toBe(403);
    const { rows } = await pool.query(`SELECT id FROM vendors WHERE vendor_name = $1`, [`${TAG} sneaky`]);
    expect(rows).toHaveLength(0);
  });

  it('lets a store keeper receive goods but not raise a vendor', async () => {
    // store_keeper is can_view-only on the matrix ON PURPOSE — receiving is its
    // job, raising suppliers and orders is not. requireProcurement ORs the named
    // role in for the receipt routes only.
    const denied = await request(store()).post('/api/procurement/vendors').send({ vendor_name: `${TAG} by store` });
    expect(denied.status).toBe(403);
    const allowed = await request(store()).get('/api/procurement/grn');
    expect(allowed.status).toBe(200);
  });

  it('refuses an approval from a role that may edit but not approve', async () => {
    const { po } = await makePo({ status: 'draft' });
    const res = await request(exec()).patch(`/api/procurement/purchase-orders/${po.id}/approve`);
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT status FROM purchase_orders WHERE id=$1', [po.id]);
    expect(rows[0].status).toBe('draft');
  });

  it('refuses an approval above the caller\'s value band', async () => {
    // department_head is level 1; anything above l1_approval_limit needs more.
    const { po } = await makePo({ status: 'draft', qty: 100, rate: 50000 });   // 5,900,000 inc tax
    const res = await request(appAs({ roles: ['department_head'] }))
      .patch(`/api/procurement/purchase-orders/${po.id}/approve`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('APPROVAL_LEVEL_INSUFFICIENT');
    const { rows } = await pool.query('SELECT status FROM purchase_orders WHERE id=$1', [po.id]);
    expect(rows[0].status).toBe('draft');
  });

  it('refuses a CANCEL from a caller who could not approve — the same authority', async () => {
    const { po } = await makePo({ status: 'approved', qty: 100, rate: 50000 });
    const res = await request(appAs({ roles: ['department_head'] }))
      .patch(`/api/procurement/purchase-orders/${po.id}/cancel`);
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT status FROM purchase_orders WHERE id=$1', [po.id]);
    expect(rows[0].status).toBe('approved');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('tenant isolation', () => {
  it('will not approve another tenant\'s purchase order', async () => {
    const { po } = await makePo({ company: CO_A, status: 'draft' });
    const res = await request(tenantB()).patch(`/api/procurement/purchase-orders/${po.id}/approve`);
    expect(res.status).toBe(404);
    const { rows } = await pool.query('SELECT status FROM purchase_orders WHERE id=$1', [po.id]);
    expect(rows[0].status).toBe('draft');
  });

  it('will not receive goods against another tenant\'s order', async () => {
    const { po, line } = await makePo({ company: CO_A, status: 'approved' });
    const res = await request(tenantB()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 1, rate: 100 }],
    });
    expect(res.status).toBe(404);
    const { rows } = await pool.query('SELECT id FROM goods_receipt_notes WHERE po_id=$1', [po.id]);
    expect(rows).toHaveLength(0);
  });

  it('will not approve another tenant\'s three-way match into a bill', async () => {
    const { po } = await makePo({ company: CO_A, status: 'approved' });
    const { rows: [match] } = await pool.query(
      `INSERT INTO three_way_matches (company_id, po_id, vendor_invoice_no, vendor_invoice_amount, po_amount, match_status)
       VALUES ($1,$2,$3,1000,1000,'matched') RETURNING *`,
      [CO_A, po.id, `${TAG}-XT-${Date.now()}`]
    );
    const res = await request(tenantB()).patch(`/api/procurement/three-way-match/${match.id}/approve`);
    expect(res.status).toBe(404);
    const { rows } = await pool.query('SELECT match_status FROM three_way_matches WHERE id=$1', [match.id]);
    expect(rows[0].match_status).toBe('matched');
    const { rows: bills } = await pool.query('SELECT id FROM bills WHERE po_id=$1', [po.id]);
    expect(bills).toHaveLength(0);
  });

  it('shows a tenant only its own off-PO spend', async () => {
    const created = await request(buyer()).post('/api/procurement/local-purchase')
      .send({ description: `${TAG} local spend`, amount: 4200, vendor_name_text: 'Corner shop' });
    expect(created.status).toBe(201);
    expect(created.body.company_id).toBe(CO_A);
    // Was `LPR${Date.now()}` — an epoch stamp, and the row carried no company.
    expect(created.body.request_number).toMatch(/^[A-Z]+\d{4,}$/);

    const mine    = await request(buyer()).get('/api/procurement/local-purchase');
    const theirs  = await request(tenantB()).get('/api/procurement/local-purchase');
    expect(mine.body.some(r => r.id === created.body.id)).toBe(true);
    expect(theirs.body.some(r => r.id === created.body.id)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('state transitions', () => {
  it('refuses to receive against a CANCELLED order', async () => {
    const { po, line } = await makePo({ status: 'cancelled' });
    const res = await request(buyer()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 1, rate: 100 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/cancelled/i);
  });

  it('refuses to receive against a DRAFT order nobody approved', async () => {
    const { po, line } = await makePo({ status: 'draft' });
    const res = await request(buyer()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 1, rate: 100 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/draft/i);
  });

  it('refuses to resurrect a cancelled order', async () => {
    const { po } = await makePo({ status: 'cancelled' });
    const res = await request(buyer()).put(`/api/procurement/purchase-orders/${po.id}/status`).send({ status: 'approved' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('refuses to mark a draft order received without a receipt', async () => {
    const { po } = await makePo({ status: 'draft' });
    const res = await request(buyer()).put(`/api/procurement/purchase-orders/${po.id}/status`).send({ status: 'received' });
    expect(res.status).toBe(409);
    const { rows } = await pool.query('SELECT status FROM purchase_orders WHERE id=$1', [po.id]);
    expect(rows[0].status).toBe('draft');
  });

  it('refuses to cancel an order that already has goods against it', async () => {
    const { po, line } = await makePo({ status: 'approved' });
    await request(buyer()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} pre-cancel`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 5, rate: 100 }],
    });
    const res = await request(buyer()).patch(`/api/procurement/purchase-orders/${po.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PO_HAS_RECEIPTS');
  });

  it('refuses to approve an order with no lines', async () => {
    const client = await pool.connect();
    let empty;
    try {
      await client.query('BEGIN');
      empty = await poRepo.create(client, {
        po_number: `${TAG}-PO-EMPTY-${Date.now()}`, supplier_id: vendorId,
        order_date: new Date().toISOString().slice(0, 10),
        subtotal: 0, tax_amount: 0, total_amount: 0,
        notes: `${TAG} empty`, company_id: CO_A, created_by: null,
      });
      await client.query('COMMIT');
    } finally { client.release(); }
    const res = await request(buyer()).patch(`/api/procurement/purchase-orders/${empty.id}/approve`);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no line items/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('idempotency', () => {
  it('a repeated approve does not re-run the handler', async () => {
    const { po } = await makePo({ status: 'draft' });
    const first  = await request(buyer()).patch(`/api/procurement/purchase-orders/${po.id}/approve`);
    const second = await request(buyer()).patch(`/api/procurement/purchase-orders/${po.id}/approve`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.already_approved).toBe(true);
    // The tail of this route emails the purchase order to the supplier, so a
    // handler that runs twice sends the vendor a second copy of the same order.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM audit_logs WHERE record_id=$1 AND record_type='purchase_order' AND action='approve'`,
      [String(po.id)]
    ).catch(() => ({ rows: [{ n: null }] }));
    if (rows[0].n !== null) expect(rows[0].n).toBeLessThanOrEqual(1);
  });

  it('two SIMULTANEOUS approvals produce one approval', async () => {
    const { po } = await makePo({ status: 'draft' });
    const [a, b] = await Promise.all([
      request(buyer()).patch(`/api/procurement/purchase-orders/${po.id}/approve`),
      request(buyer()).patch(`/api/procurement/purchase-orders/${po.id}/approve`),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Exactly one of the two did the work; the other saw the committed result.
    expect([a.body.already_approved, b.body.already_approved].filter(Boolean)).toHaveLength(1);
  });

  it('a replayed receipt with the same Idempotency-Key books the goods once', async () => {
    const { po, line } = await makePo({ status: 'approved', qty: 6, rate: 10 });
    const key = `${TAG}-idem-${Date.now()}`;
    const body = {
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} idem receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 6, rate: 10 }],
    };
    const first  = await request(buyer()).post('/api/procurement/grn').set('Idempotency-Key', key).send(body);
    const second = await request(buyer()).post('/api/procurement/grn').set('Idempotency-Key', key).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.idempotent_replay).toBe(true);

    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM goods_receipt_notes WHERE po_id=$1', [po.id]);
    expect(rows[0].n).toBe(1);
    const { rows: [poi] } = await pool.query('SELECT received_quantity FROM purchase_order_items WHERE id=$1', [line.id]);
    expect(Number(poi.received_quantity)).toBe(6);
  });

  it('a double-submitted receipt WITHOUT a key does not book the goods twice', async () => {
    // The business guard, not the plumbing one: this is the protection that does
    // not depend on the client remembering to send a header. Two refusals are
    // legitimate here and which one fires depends on whether the first receipt
    // completed the order — the order is now 'received' (not receivable), or the
    // line would breach the cumulative tolerance. The assertion is on the
    // OUTCOME, which is the same either way: one receipt, one booked quantity.
    const { po, line } = await makePo({ status: 'approved', qty: 4, rate: 25 });
    const body = {
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} dup receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 4, rate: 25 }],
    };
    const first  = await request(buyer()).post('/api/procurement/grn').send(body);
    const second = await request(buyer()).post('/api/procurement/grn').send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/Over-receipt|cannot be received against/);

    const { rows: [poi] } = await pool.query('SELECT received_quantity FROM purchase_order_items WHERE id=$1', [line.id]);
    expect(Number(poi.received_quantity)).toBe(4);
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM goods_receipt_notes WHERE po_id=$1', [po.id]);
    expect(rows[0].n).toBe(1);
  });

  it('a re-submitted PARTIAL receipt is stopped by the cumulative tolerance', async () => {
    // Exercises the tolerance leg specifically: the first receipt leaves the
    // order open ('partial'), so it is still receivable and only the cumulative
    // check stands between a double-click and 8 units booked against 5 ordered.
    const { po, line } = await makePo({ status: 'approved', qty: 5, rate: 25 });
    const body = {
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} partial dup`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 4, rate: 25 }],
    };
    const first  = await request(buyer()).post('/api/procurement/grn').send(body);
    const second = await request(buyer()).post('/api/procurement/grn').send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/Over-receipt/);

    const { rows: [poi] } = await pool.query('SELECT received_quantity FROM purchase_order_items WHERE id=$1', [line.id]);
    expect(Number(poi.received_quantity)).toBe(4);
    const { rows: [after] } = await pool.query('SELECT status FROM purchase_orders WHERE id=$1', [po.id]);
    expect(after.status).toBe('partial');
  });

  it('two SIMULTANEOUS receipts cannot both pass the tolerance check', async () => {
    // The time-of-check/time-of-use race the missing FOR UPDATE left open: both
    // requests read received_quantity = 0, both computed that the full ordered
    // quantity fitted, and both committed.
    const { po, line } = await makePo({ status: 'approved', qty: 10, rate: 10 });
    const body = {
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} race receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 10, rate: 10 }],
    };
    const [a, b] = await Promise.all([
      request(buyer()).post('/api/procurement/grn').send(body),
      request(buyer()).post('/api/procurement/grn').send(body),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);

    const { rows: [poi] } = await pool.query('SELECT received_quantity FROM purchase_order_items WHERE id=$1', [line.id]);
    expect(Number(poi.received_quantity)).toBe(10);           // not 20
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM goods_receipt_notes WHERE po_id=$1', [po.id]);
    expect(rows[0].n).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('AP bill creation', () => {
  async function receivedPoWithMatch({ invoiceAmount, invoiceNo } = {}) {
    const { po, line } = await makePo({ status: 'approved', qty: 10, rate: 100, taxRate: 18 });
    const grnRes = await request(buyer()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} bill receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 10, rate: 100 }],
    });
    expect(grnRes.status).toBe(201);
    const matchRes = await request(buyer()).post('/api/procurement/three-way-match').send({
      po_id: po.id, grn_id: grnRes.body.id,
      vendor_invoice_no: invoiceNo ?? `${TAG}-B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      vendor_invoice_date: new Date().toISOString().slice(0, 10),
      vendor_invoice_amount: invoiceAmount ?? 1180,
    });
    expect(matchRes.status).toBe(201);
    return { po, line, grn: grnRes.body, match: matchRes.body };
  }

  it('creates a payable bill with the right split, party, balance and due date', async () => {
    const { po, match } = await receivedPoWithMatch({ invoiceAmount: 1180 });
    expect(match.match_status).toBe('matched');

    const res = await request(buyer()).patch(`/api/procurement/three-way-match/${match.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.bill_id).toBeTruthy();

    const { rows: [bill] } = await pool.query('SELECT * FROM bills WHERE id=$1', [res.body.bill_id]);
    // subtotal/tax split on the order's own basis, not gross booked as taxable.
    expect(Number(bill.subtotal)).toBeCloseTo(1000, 2);
    expect(Number(bill.tax_amount)).toBeCloseTo(180, 2);
    expect(Number(bill.total_amount)).toBeCloseTo(1180, 2);
    // balance drives AP ageing, the payment run and the supplier statement. It
    // was left at its column default of 0, so an auto-created bill was invisible
    // as a payable the moment it was created.
    expect(Number(bill.balance)).toBeCloseTo(1180, 2);
    expect(bill.due_date).toBeTruthy();
    expect(bill.po_id).toBe(po.id);

    // Deterministic supplier: the party bound to the vendor, not a name match.
    const { rows: [v] } = await pool.query('SELECT party_id FROM vendors WHERE id=$1', [vendorId]);
    expect(bill.supplier_id).toBe(v.party_id);
  });

  it('does NOT raise a second bill when the same match is approved twice', async () => {
    const { match } = await receivedPoWithMatch({ invoiceAmount: 1180 });
    const first  = await request(buyer()).patch(`/api/procurement/three-way-match/${match.id}/approve`);
    const second = await request(buyer()).patch(`/api/procurement/three-way-match/${match.id}/approve`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.already_approved).toBe(true);
    expect(second.body.bill_id).toBe(first.body.bill_id);

    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM bills WHERE bill_number=$1', [match.vendor_invoice_no]);
    expect(rows[0].n).toBe(1);
  });

  it('does NOT raise a second bill for the same supplier invoice on a different order', async () => {
    const invoiceNo = `${TAG}-DUP-${Date.now()}`;
    const a = await receivedPoWithMatch({ invoiceAmount: 1180, invoiceNo });
    const b = await receivedPoWithMatch({ invoiceAmount: 1180, invoiceNo });

    const first  = await request(buyer()).patch(`/api/procurement/three-way-match/${a.match.id}/approve`);
    const second = await request(buyer()).patch(`/api/procurement/three-way-match/${b.match.id}/approve`);
    expect(first.body.bill_id).toBeTruthy();
    expect(second.body.duplicate_invoice).toBe(true);
    expect(second.body.bill_id).toBe(first.body.bill_id);

    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM bills WHERE bill_number=$1', [invoiceNo]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses to raise a bill with no supplier invoice number', async () => {
    const { po, line } = await makePo({ status: 'approved' });
    await request(buyer()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} noinv`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 5, rate: 100 }],
    });
    const { rows: [match] } = await pool.query(
      `INSERT INTO three_way_matches (company_id, po_id, vendor_invoice_amount, po_amount, match_status)
       VALUES ($1,$2,590,590,'matched') RETURNING *`, [CO_A, po.id]
    );
    const res = await request(buyer()).patch(`/api/procurement/three-way-match/${match.id}/approve`);
    // Without a bill number the unique index cannot fire (NULLs are distinct),
    // so every retry used to create another payable for the full amount.
    expect(res.status).toBe(422);
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM bills WHERE po_id=$1', [po.id]);
    expect(rows[0].n).toBe(0);
  });

  it('flags a genuinely wrong invoice and blocks it from becoming a bill', async () => {
    await pool.query(`UPDATE procurement_settings SET block_payment_on_mismatch = true WHERE company_id = $1`, [CO_A]);
    try {
      const { match } = await receivedPoWithMatch({ invoiceAmount: 5000 });   // vs 1180 ordered
      expect(match.match_status).toBe('discrepancy');
      expect(match.discrepancy_reason).toMatch(/invoice leg/);

      const res = await request(buyer()).patch(`/api/procurement/three-way-match/${match.id}/approve`);
      expect(res.status).toBe(400);
      const { rows } = await pool.query('SELECT COUNT(*)::int n FROM bills WHERE bill_number=$1', [match.vendor_invoice_no]);
      expect(rows[0].n).toBe(0);
    } finally {
      await pool.query(`UPDATE procurement_settings SET block_payment_on_mismatch = false WHERE company_id = $1`, [CO_A]);
    }
  });

  it('will not value a match from a receipt belonging to another order', async () => {
    const mine    = await makePo({ status: 'approved' });
    const other   = await makePo({ status: 'approved' });
    const otherGrn = await request(buyer()).post('/api/procurement/grn').send({
      po_id: other.po.id, warehouse_id: warehouseId, notes: `${TAG} other receipt`,
      items: [{ po_item_id: other.line.id, item_id: itemId, quantity_received: 5, rate: 100 }],
    });
    const res = await request(buyer()).post('/api/procurement/three-way-match').send({
      po_id: mine.po.id, grn_id: otherGrn.body.id,
      vendor_invoice_no: `${TAG}-XG-${Date.now()}`, vendor_invoice_amount: 590,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/was booked against purchase order/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('business validation', () => {
  it('refuses a malformed GSTIN the finance master would reject', async () => {
    const res = await request(buyer()).post('/api/procurement/vendors')
      .send({ vendor_name: `${TAG} bad gstin`, gstin: '27AAAABB12C' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GSTIN/);
  });

  it('gives a newly created vendor a finance identity in the same commit', async () => {
    const res = await request(buyer()).post('/api/procurement/vendors')
      .send({ vendor_name: `${TAG} New Supplier`, category: 'Raw Materials', payment_terms_days: 60 });
    expect(res.status).toBe(201);
    expect(res.body.party_id).toBeTruthy();
    expect(res.body.finance_party.matched_on).toBe('created');

    const { rows: [party] } = await pool.query('SELECT * FROM parties WHERE id=$1', [res.body.party_id]);
    expect(party.company_id).toBe(CO_A);
    expect(Number(party.payment_terms)).toBe(60);
  });

  it('refuses a receipt dated in the future', async () => {
    const { po, line } = await makePo({ status: 'approved' });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await request(buyer()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId, received_date: tomorrow,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 1, rate: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  it('refuses a receipt that books a different component than the order line', async () => {
    const { rows: [otherItem] } = await pool.query(
      'SELECT id FROM inventory_items WHERE id <> $1 ORDER BY id LIMIT 1', [itemId]
    );
    const { po, line } = await makePo({ status: 'approved' });
    const res = await request(buyer()).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId,
      items: [{ po_item_id: line.id, item_id: otherItem.id, quantity_received: 1, rate: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/but the receipt books component/);
  });

  it('refuses a local purchase with no amount', async () => {
    const res = await request(buyer()).post('/api/procurement/local-purchase')
      .send({ description: `${TAG} no amount` });
    expect(res.status).toBe(400);
  });
});
