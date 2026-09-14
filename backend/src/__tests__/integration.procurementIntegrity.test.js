/**
 * integration.procurementIntegrity.test.js — regression cover for the defects
 * found in the 2026-09-02 procurement audit, against the REAL database.
 *
 * NOT MOCKED, deliberately, for the same reason as integration.tcoAward: every
 * one of these defects was invisible to a mocked pool. They were bugs about what
 * the DATABASE ends up holding — a column that was never written, a scoping
 * predicate that matched nothing, a status the rest of the app does not read, a
 * quantity nothing bounded. A stubbed query would have returned whatever the
 * stub was told to and passed against all of them; four of the six were found
 * only by issuing a real request and then looking at the row.
 *
 * Self-cleaning in both directions: beforeAll sweeps ZZPROC debris an
 * interrupted run may have left, afterAll removes this run's rows. Debris is not
 * harmless here — an abandoned requisition shows up in the buyer's live queue
 * and an abandoned PO line distorts MRP's open-supply figure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const { default: pool }   = await import('../config/db.js');
const { default: prRepo, PR_INITIAL_STATUS } = await import('../modules/procurement/repositories/purchaseRequest.repository.js');
const { default: poRepo } = await import('../modules/procurement/repositories/purchaseOrder.repository.js');
const { default: grnService } = await import('../modules/procurement/services/grn.service.js');
const { createThreeWayMatchRecord } = await import('../modules/procurement/routes/procurement.routes.js');

const TAG = 'ZZPROC';
const CO_A = 1;          // the tenant these fixtures belong to
const CO_B = 999901;     // a foreign tenant, created once to prove isolation (see sweepDebris)

// Deletion order follows the FK graph inwards: three_way_matches and grn_items
// both point at purchase_orders, so the orders cannot go first. Matches are
// swept by their PO as well as by invoice number — the tenant-isolation test
// deliberately produces a rejected match with no row of its own, and a match
// auto-created by a GRN carries the receipt's invoice number, not the tag.
async function sweepDebris() {
  const poScope = `(SELECT id FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1)`;
  await pool.query(`DELETE FROM three_way_matches WHERE vendor_invoice_no LIKE $1 OR po_id IN ${poScope}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_receipt_notes WHERE grn_number LIKE $1 OR notes LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM goods_receipt_notes WHERE grn_number LIKE $1 OR notes LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN ${poScope}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, [`${TAG}%`]);
  // The CO_B company row itself is left in place. 165 tables FK companies(id)
  // and creating one draws per-company defaults from elsewhere in the app
  // (recruitment seeds interview_questions against it), so deleting it means
  // chasing an open-ended set of dependents and racing whatever wrote them.
  // The row is inert — it owns no procurement data once the sweep above has run
  // — and re-creating it is idempotent, so leaving it is both cheaper and more
  // predictable than a cascade this suite would have to keep up to date.
}

/** An inventory item and warehouse that certainly exist, for the FK columns. */
let anyItemId, anyWarehouseId;

beforeAll(async () => {
  await sweepDebris();
  anyItemId      = (await pool.query('SELECT id FROM inventory_items ORDER BY id LIMIT 1')).rows[0]?.id;
  anyWarehouseId = (await pool.query('SELECT id FROM warehouses ORDER BY id LIMIT 1')).rows[0]?.id;
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZPROC foreign tenant', 'ZZPRC')
     ON CONFLICT (id) DO NOTHING`, [CO_B]
  );
});

afterAll(async () => {
  await sweepDebris();
  await pool.end();
});

describe('purchase requests', () => {
  it('persists the priority the requester chose', async () => {
    // The drawer collected priority and the repository INSERT omitted the
    // column, so every "Urgent" requisition was stored as the DB default
    // 'medium'. Verified against the live table before the fix: all 11 rows read
    // 'medium', including ones raised as urgent.
    const client = await pool.connect();
    try {
      const pr = await prRepo.create(client, {
        request_number: null, company_id: CO_A, request_date: '2026-09-02',
        required_date: '2026-09-30', notes: `${TAG} priority`, priority: 'urgent',
      });
      expect(pr.priority).toBe('urgent');

      const { rows } = await pool.query('SELECT priority FROM purchase_requests WHERE id = $1', [pr.id]);
      expect(rows[0].priority).toBe('urgent');
    } finally { client.release(); }
  });

  it('rejects a priority outside the four the UI offers', async () => {
    // The column is a bare varchar with no check constraint.
    const client = await pool.connect();
    try {
      const pr = await prRepo.create(client, {
        request_number: null, company_id: CO_A, request_date: '2026-09-02',
        required_date: '2026-09-30', notes: `${TAG} bad priority`, priority: 'CATASTROPHIC',
      });
      expect(pr.priority).toBe('medium');
    } finally { client.release(); }
  });

  it('is born in the status the rest of the app actually reads', async () => {
    // status DEFAULTed to 'pending' while every consumer — the KPI strip, the
    // dashboard count, the status filter, STATUS_META — keys on
    // 'pending_approval'. A new requisition was therefore invisible to the
    // approval queue that was supposed to action it.
    const client = await pool.connect();
    try {
      const pr = await prRepo.create(client, {
        request_number: null, company_id: CO_A, request_date: '2026-09-02',
        required_date: '2026-09-30', notes: `${TAG} status`,
      });
      expect(pr.status).toBe(PR_INITIAL_STATUS);
      expect(pr.status).toBe('pending_approval');
    } finally { client.release(); }
  });

  it('lists requisitions that have no requester', async () => {
    // findAll scoped on `e.company_id` off a LEFT JOIN to employees, so any PR
    // with a NULL requested_by_employee_id evaluated NULL = $1 (false) and
    // vanished. Every PR the app created had a NULL requester, so the register
    // showed 4 of 12 rows and a just-raised request was never visible again.
    const client = await pool.connect();
    let prId;
    try {
      const pr = await prRepo.create(client, {
        request_number: null, company_id: CO_A, request_date: '2026-09-02',
        required_date: '2026-09-30', notes: `${TAG} orphan requester`,
        requested_by_employee_id: null,
      });
      prId = pr.id;
    } finally { client.release(); }

    const listed = await prRepo.findAll({ company_id: CO_A });
    expect(listed.map(r => r.id)).toContain(prId);
  });

  it('records who rejected a requisition and why', async () => {
    // updateStatus only stamped the decider for 'approved', so a rejection
    // recorded neither actor nor reason — and `rejection_reason`, a real
    // column, had never been written by anything.
    const employeeId = (await pool.query('SELECT id FROM employees WHERE deleted_at IS NULL ORDER BY id LIMIT 1')).rows[0]?.id;
    const client = await pool.connect();
    try {
      const pr = await prRepo.create(client, {
        request_number: null, company_id: CO_A, request_date: '2026-09-02',
        required_date: '2026-09-30', notes: `${TAG} reject`,
      });
      const rejected = await prRepo.updateStatus(client, pr.id, 'rejected', employeeId, {
        reason: 'Budget deferred', companyId: CO_A,
      });
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejection_reason).toBe('Budget deferred');
      expect(rejected.approved_by).toBe(employeeId);
      expect(rejected.approved_at).not.toBeNull();
    } finally { client.release(); }
  });

  it('will not read or update another tenant\'s requisition', async () => {
    const client = await pool.connect();
    let prId;
    try {
      const pr = await prRepo.create(client, {
        request_number: null, company_id: CO_B, request_date: '2026-09-02',
        required_date: '2026-09-30', notes: `${TAG} foreign tenant`,
      });
      prId = pr.id;
    } finally { client.release(); }

    expect(await prRepo.findById(prId, CO_A)).toBeUndefined();
    expect(await prRepo.findById(prId, CO_B)).toBeDefined();

    const client2 = await pool.connect();
    try {
      const blocked = await prRepo.updateStatus(client2, prId, 'rejected', null, { companyId: CO_A });
      expect(blocked).toBeUndefined();
    } finally { client2.release(); }

    const { rows } = await pool.query('SELECT status FROM purchase_requests WHERE id = $1', [prId]);
    expect(rows[0].status).toBe('pending_approval');
  });

  it('gives a system-raised requisition a real document number', async () => {
    // Four writers put rows in this table. Three of them minted no
    // request_number (two wrote the legacy `pr_number` instead), so
    // MRP-generated requisitions showed a blank PR No in the register — nothing
    // to quote in an approval or search by.
    const client = await pool.connect();
    try {
      const pr = await prRepo.createSystemRequest(client, {
        company_id: CO_A, item_name: `${TAG} auto item`, quantity: 5,
        notes: `${TAG} system raised`,
      });
      expect(pr.request_number).toBeTruthy();
      expect(pr.request_number).toMatch(/\d{4}$/);
      expect(pr.request_date).not.toBeNull();
      // Machine-raised: no employee behind it, and NULL is the honest value for
      // a column that FKs employees(id).
      expect(pr.requested_by_employee_id).toBeNull();
    } finally { client.release(); }
  });
});

describe('purchase orders', () => {
  it('will not read or update another tenant\'s order', async () => {
    const client = await pool.connect();
    let poId;
    try {
      const po = await poRepo.create(client, {
        po_number: `${TAG}-XT`, supplier_id: null, order_date: '2026-09-02',
        total_amount: 1000, company_id: CO_B, created_by: null, notes: `${TAG} foreign`,
      });
      poId = po.id;
    } finally { client.release(); }

    expect(await poRepo.findById(poId, CO_A)).toBeUndefined();
    expect(await poRepo.findById(poId, CO_B)).toBeDefined();

    const client2 = await pool.connect();
    try {
      const blocked = await poRepo.updateStatus(client2, poId, 'cancelled', CO_A);
      expect(blocked).toBeUndefined();
    } finally { client2.release(); }

    const { rows } = await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [poId]);
    expect(rows[0].status).not.toBe('cancelled');
  });

  it('keeps both receipt columns in step so MRP sees real open supply', async () => {
    // purchase_order_items carries received_quantity (written by GRN) and
    // received_qty (never written by anything, so 0.00 on every row).
    // mrpEngine computes open supply as quantity - COALESCE(received_qty, 0),
    // so the planner counted every fully-received PO line as still inbound
    // forever and under-ordered against stock that would never arrive.
    const client = await pool.connect();
    try {
      const po = await poRepo.create(client, {
        po_number: `${TAG}-RQ`, supplier_id: null, order_date: '2026-09-02',
        total_amount: 100, company_id: CO_A, created_by: null, notes: `${TAG} recvqty`,
      });
      const line = await poRepo.createItem(client, {
        po_id: po.id, item_id: anyItemId, quantity: 10, rate: 10,
        tax_rate: 0, tax_amount: 0, total_amount: 100,
      });
      await poRepo.updateItemReceived(client, line.id, 4);

      const { rows } = await pool.query(
        'SELECT received_quantity, received_qty FROM purchase_order_items WHERE id = $1', [line.id]
      );
      expect(parseFloat(rows[0].received_quantity)).toBe(4);
      expect(parseFloat(rows[0].received_qty)).toBe(4);
    } finally { client.release(); }
  });
});

describe('goods receipt', () => {
  /** A PO with one line of `qty`, in company CO_A. */
  async function makePo(qty) {
    const client = await pool.connect();
    try {
      const po = await poRepo.create(client, {
        po_number: `${TAG}-${Date.now() % 100000}`, supplier_id: null, order_date: '2026-09-02',
        total_amount: qty * 10, company_id: CO_A, created_by: null, notes: `${TAG} grn fixture`,
      });
      const line = await poRepo.createItem(client, {
        po_id: po.id, item_id: anyItemId, quantity: qty, rate: 10,
        tax_rate: 0, tax_amount: 0, total_amount: qty * 10,
      });
      return { po, line };
    } finally { client.release(); }
  }

  it('refuses a receipt beyond the configured tolerance', async () => {
    // Nothing capped receipt quantity server-side. A probe booked 500 against a
    // PO line for 2 and got a 201, leaving the line reading 502 received of 2
    // ordered with inventory batches created for the lot.
    // grn_qty_tolerance_pct existed, saved correctly, and had no reader at all.
    const { po, line } = await makePo(10);
    const client = await pool.connect();
    try {
      await expect(
        grnService.assertWithinTolerance(client, po.id, [
          { po_item_id: line.id, quantity_received: 500 },
        ], 5)
      ).rejects.toThrow(/Over-receipt/);
    } finally { client.release(); }
  });

  it('allows a receipt inside the tolerance', async () => {
    const { po, line } = await makePo(100);
    const client = await pool.connect();
    try {
      // 5% of 100 ordered — 104 is inside, 106 is not.
      await expect(
        grnService.assertWithinTolerance(client, po.id, [
          { po_item_id: line.id, quantity_received: 104 },
        ], 5)
      ).resolves.toBeUndefined();
      await expect(
        grnService.assertWithinTolerance(client, po.id, [
          { po_item_id: line.id, quantity_received: 106 },
        ], 5)
      ).rejects.toThrow(/Over-receipt/);
    } finally { client.release(); }
  });

  it('counts what earlier receipts already booked', async () => {
    // Without the cumulative read the same over-receipt is reachable by
    // splitting it across several GRNs.
    const { po, line } = await makePo(10);
    const client = await pool.connect();
    try {
      await poRepo.updateItemReceived(client, line.id, 9);
      await expect(
        grnService.assertWithinTolerance(client, po.id, [
          { po_item_id: line.id, quantity_received: 5 },
        ], 5)
      ).rejects.toThrow(/Over-receipt/);
    } finally { client.release(); }
  });

  it('refuses a line that does not belong to the purchase order', async () => {
    const { po } = await makePo(10);
    const other  = await makePo(10);
    const client = await pool.connect();
    try {
      await expect(
        grnService.assertWithinTolerance(client, po.id, [
          { po_item_id: other.line.id, quantity_received: 1 },
        ], 5)
      ).rejects.toThrow(/does not belong/);
    } finally { client.release(); }
  });

  it('refuses a rejected quantity above the quantity received', async () => {
    const { po, line } = await makePo(10);
    const client = await pool.connect();
    try {
      await expect(
        grnService.assertWithinTolerance(client, po.id, [
          { po_item_id: line.id, quantity_received: 5, quantity_rejected: 8 },
        ], 5)
      ).rejects.toThrow(/cannot exceed/);
    } finally { client.release(); }
  });

  it('will not read another tenant\'s receipt', async () => {
    const { rows: [grn] } = await pool.query(
      `INSERT INTO goods_receipt_notes (grn_number, received_date, warehouse_id, status, company_id, notes)
       VALUES ($1, CURRENT_DATE, $2, 'pending', $3, $4) RETURNING id`,
      [`${TAG}-XT`, anyWarehouseId, CO_B, `${TAG} foreign grn`]
    );
    expect(await grnService.getGRNById(grn.id, CO_A)).toBeFalsy();
    expect(await grnService.getGRNById(grn.id, CO_B)).toBeTruthy();
  });

  it('returns a receipt whose warehouse row is missing', async () => {
    // findById inner-joined warehouses, so a GRN with a NULL or deleted
    // warehouse disappeared entirely and the route reported 404 for a receipt
    // that plainly exists.
    const { rows: [grn] } = await pool.query(
      `INSERT INTO goods_receipt_notes (grn_number, received_date, warehouse_id, status, company_id, notes)
       VALUES ($1, CURRENT_DATE, NULL, 'pending', $2, $3) RETURNING id`,
      [`${TAG}-NOWH`, CO_A, `${TAG} no warehouse`]
    );
    const found = await grnService.getGRNById(grn.id, CO_A);
    expect(found).toBeTruthy();
    expect(found.id).toBe(grn.id);
  });
});

describe('three-way match', () => {
  /**
   * A PO with real tax on it, plus a GRN that received exactly what was ordered
   * at exactly the agreed rate. This is the "everything is correct" case, and it
   * is the one the old code got wrong.
   */
  async function perfectPoAndGrn() {
    const client = await pool.connect();
    try {
      const qty = 2, rate = 100, taxRate = 18;
      const subtotal = qty * rate;                 // 200 ex-tax
      const tax      = subtotal * taxRate / 100;   // 36
      const po = await poRepo.create(client, {
        po_number: `${TAG}-3W${Date.now() % 10000}`, supplier_id: null, order_date: '2026-09-02',
        subtotal, tax_amount: tax, total_amount: subtotal + tax,
        company_id: CO_A, created_by: null, notes: `${TAG} 3way`,
      });
      const line = await poRepo.createItem(client, {
        po_id: po.id, item_id: anyItemId, quantity: qty, rate,
        tax_rate: taxRate, tax_amount: tax, total_amount: subtotal + tax,
      });
      const { rows: [grn] } = await client.query(
        `INSERT INTO goods_receipt_notes (grn_number, po_id, received_date, warehouse_id, status, company_id, notes)
         VALUES ($1, $2, CURRENT_DATE, $3, 'pending', $4, $5) RETURNING id`,
        [`${TAG}-3W${Date.now() % 10000}`, po.id, anyWarehouseId, CO_A, `${TAG} 3way grn`]
      );
      // Received in full, nothing rejected, at the PO rate — GRN goods value 200.
      await client.query(
        `INSERT INTO grn_items (grn_id, po_item_id, item_id, quantity_received, quantity_rejected, rate)
         VALUES ($1,$2,$3,$4,0,$5)`,
        [grn.id, line.id, anyItemId, qty, rate]
      );
      return { po, grn, subtotal, total: subtotal + tax };
    } finally { client.release(); }
  }

  it('matches a correct receipt and invoice on a PO that carries tax', async () => {
    // Both legs were compared against po.total_amount (tax-INCLUSIVE) while the
    // GRN leg is valued at the line rate (tax-EXCLUSIVE). On 18% GST that is a
    // built-in 15.25% variance between two numbers that agree exactly, so every
    // GST-bearing receipt classified as a discrepancy however correct it was —
    // and with block_payment_on_mismatch enabled that would have held payment on
    // every invoice the company received.
    const { po, grn, total } = await perfectPoAndGrn();
    const m = await createThreeWayMatchRecord(CO_A, {
      po_id: po.id, grn_id: grn.id,
      vendor_invoice_no: `${TAG}-OK`, vendor_invoice_amount: total,
    });
    expect(m.match_status).toBe('matched');
    expect(m.discrepancy_reason).toBeNull();
  });

  it('flags a genuinely wrong invoice and says why', async () => {
    const { po, grn, total } = await perfectPoAndGrn();
    const m = await createThreeWayMatchRecord(CO_A, {
      po_id: po.id, grn_id: grn.id,
      vendor_invoice_no: `${TAG}-OVER`, vendor_invoice_amount: total * 1.4,
    });
    expect(m.match_status).toBe('discrepancy');
    // discrepancy_reason is a real column nothing had ever written, so the
    // exception queue could say a match failed but never why.
    expect(m.discrepancy_reason).toMatch(/invoice leg/);
  });

  it('holds at pending while the goods have not arrived', async () => {
    // No receipt leg means grn_amount is 0, which the old comparison read as a
    // 100% variance and stamped 'discrepancy'. An invoice arriving before the
    // goods is a normal, temporary state.
    const { po, total } = await perfectPoAndGrn();
    const m = await createThreeWayMatchRecord(CO_A, {
      po_id: po.id,
      vendor_invoice_no: `${TAG}-NOGRN`, vendor_invoice_amount: total,
    });
    expect(m.match_status).toBe('pending');
  });

  it("will not match against another tenant's purchase order", async () => {
    const client = await pool.connect();
    let poId;
    try {
      const po = await poRepo.create(client, {
        po_number: `${TAG}-3WXT`, supplier_id: null, order_date: '2026-09-02',
        subtotal: 100, tax_amount: 18, total_amount: 118,
        company_id: CO_B, created_by: null, notes: `${TAG} foreign 3way`,
      });
      poId = po.id;
    } finally { client.release(); }

    await expect(
      createThreeWayMatchRecord(CO_A, {
        po_id: poId, vendor_invoice_no: `${TAG}-XT`, vendor_invoice_amount: 118,
      })
    ).rejects.toThrow(/not found/i);
  });
});
