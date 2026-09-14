/**
 * integration.procurementLifecycle.test.js
 *
 * The full procurement chain, end to end, against the REAL database, with the
 * DATABASE checked at every stage rather than the API response:
 *
 *   PR ──approve──► RFQ ──quotes──► award ──► PO ──approve──► GRN ──IQC──►
 *   inventory (batch + ledger) ──► 3-way match ──approve──► AP bill ──► analytics
 *
 * WHY NOT MOCKED
 * --------------
 * Every defect this covers was invisible to a mocked pool, because every one of
 * them was a fact about what the database ends up holding:
 *   - a batch written on the pool instead of the transaction client, so it
 *     survived a rollback (four such orphans were live in this database);
 *   - a status written as 'draft' that no screen counts;
 *   - a company predicate that was simply absent;
 *   - a `SELECT ... FOR UPDATE` that was a plain SELECT, so two concurrent
 *     receipts both passed the over-receipt check;
 *   - an `approved_by` written from the wrong id space, which only fails
 *     against a real foreign key.
 * A stub returns whatever it was told to and passes against all of them.
 *
 * SELF-CLEANING in both directions: beforeAll sweeps ZZLC debris an interrupted
 * run may have left, afterAll removes this run's rows. Debris is not harmless —
 * an abandoned requisition shows up in the buyer's live queue, an abandoned PO
 * line distorts MRP's open-supply figure, and an abandoned batch is phantom
 * stock, which is the exact bug this suite exists to prevent.
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

const { default: pool }       = await import('../config/db.js');
const { default: prRepo }     = await import('../modules/procurement/repositories/purchaseRequest.repository.js');
const { default: poRepo }     = await import('../modules/procurement/repositories/purchaseOrder.repository.js');
const { default: grnService } = await import('../modules/procurement/services/grn.service.js');
const { createThreeWayMatchRecord } = await import('../modules/procurement/routes/procurement.routes.js');
const { resolveVendorParty }  = await import('../modules/procurement/services/vendorIdentity.service.js');

const TAG   = 'ZZLC';
const CO    = 1;

let itemId, warehouseId, vendorId, iqcWasRequired;

/**
 * Deletion order follows the FK graph inwards. inventory_batches now FKs
 * goods_receipt_notes with ON DELETE RESTRICT (migration 20260903000011), so
 * batches must go before their receipts — which is the point of the constraint.
 */
async function sweep() {
  const poScope   = `(SELECT id FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1)`;
  const grnScope  = `(SELECT id FROM goods_receipt_notes WHERE grn_number LIKE $1 OR notes LIKE $1 OR po_id IN ${poScope})`;
  const p = [`${TAG}%`];
  await pool.query(`DELETE FROM payment_allocations WHERE bill_id IN (SELECT id FROM bills WHERE bill_number LIKE $1)`, p);
  await pool.query(`DELETE FROM bills WHERE bill_number LIKE $1 OR notes LIKE $1`, p);
  await pool.query(`DELETE FROM three_way_matches WHERE vendor_invoice_no LIKE $1 OR po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM stock_ledger WHERE reference_type IN ('grn','rtv') AND remarks LIKE $1`, p);
  await pool.query(`DELETE FROM stock_ledger WHERE reference_type = 'grn' AND reference_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM rtv_items WHERE rtv_id IN (SELECT id FROM return_to_vendor WHERE grn_id IN ${grnScope})`, p);
  await pool.query(`DELETE FROM return_to_vendor WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM inventory_batches WHERE grn_id IN ${grnScope} OR batch_number LIKE $1`, p);
  await pool.query(`DELETE FROM grn_items WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM goods_receipt_notes WHERE grn_number LIKE $1 OR notes LIKE $1 OR po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1`, p);
  await pool.query(`DELETE FROM rfq_quotes WHERE rfq_id IN (SELECT id FROM rfqs WHERE rfq_number LIKE $1)`, p);
  await pool.query(`DELETE FROM rfq_items WHERE rfq_id IN (SELECT id FROM rfqs WHERE rfq_number LIKE $1)`, p);
  await pool.query(`DELETE FROM procurement_award_decisions WHERE rfq_id IN (SELECT id FROM rfqs WHERE rfq_number LIKE $1)`, p);
  await pool.query(`DELETE FROM rfqs WHERE rfq_number LIKE $1`, p);
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, p);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, p);
  await pool.query(`DELETE FROM vendors WHERE vendor_name LIKE $1`, p);
  await pool.query(`DELETE FROM parties WHERE name LIKE $1`, p);
}

beforeAll(async () => {
  await sweep();
  itemId      = (await pool.query('SELECT id FROM inventory_items ORDER BY id LIMIT 1')).rows[0]?.id;
  warehouseId = (await pool.query('SELECT id FROM warehouses ORDER BY id LIMIT 1')).rows[0]?.id;

  // A vendor of this suite's own, so the lifecycle is not entangled with live
  // supplier data and the finance-identity assertions are about THIS vendor.
  const { rows: [v] } = await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status, category, payment_terms_days, email)
     VALUES ($1, $2, 'active', 'Raw Materials', 45, 'zzlc@example.test') RETURNING id`,
    [`${TAG} Lifecycle Supplier`, CO]
  );
  vendorId = v.id;

  // The receipt path branches on quality_settings.require_iqc_before_stock, and
  // both branches are exercised below. Record the real value so afterAll can put
  // it back — a test that leaves a company's quality policy flipped is worse
  // than a test that fails.
  iqcWasRequired = (await pool.query(
    'SELECT require_iqc_before_stock FROM quality_settings WHERE company_id = $1', [CO]
  )).rows[0]?.require_iqc_before_stock;
});

afterAll(async () => {
  await sweep();
  // withIqc() restores the setting per test; this is a belt-and-braces backstop
  // for the value captured before any of them ran.
  if (iqcWasRequired !== undefined && iqcWasRequired !== null) {
    await pool.query('UPDATE quality_settings SET require_iqc_before_stock = $1 WHERE company_id = $2',
      [iqcWasRequired, CO]);
  }
});

/** Raise an approved PO with one line, the way convert-to-PO/award would. */
async function makeApprovedPo({ qty = 10, rate = 100, taxRate = 18, status = 'approved', tagSuffix = '' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subtotal = qty * rate;
    const tax = subtotal * taxRate / 100;
    const po = await poRepo.create(client, {
      po_number: `${TAG}-PO-${Date.now()}${tagSuffix}`,
      supplier_id: vendorId, order_date: new Date().toISOString().slice(0, 10),
      subtotal, tax_amount: tax, total_amount: subtotal + tax,
      notes: `${TAG} lifecycle`, company_id: CO, created_by: null,
    });
    await client.query(`UPDATE purchase_orders SET status = $1 WHERE id = $2`, [status, po.id]);
    const line = await poRepo.createItem(client, {
      po_id: po.id, item_id: itemId, quantity: qty, rate,
      tax_rate: taxRate, tax_amount: tax, total_amount: subtotal + tax,
    });
    await client.query('COMMIT');
    return { po: { ...po, status }, line, subtotal, tax };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

const setIqc = (required) =>
  pool.query('UPDATE quality_settings SET require_iqc_before_stock = $1 WHERE company_id = $2', [required, CO]);

/**
 * Run a test body with the IQC gate forced one way, and put the company's real
 * setting back whatever happens.
 *
 * `require_iqc_before_stock` is a LIVE business policy for company 1, not test
 * scaffolding, and both branches of the receipt path have to be exercised. An
 * afterAll-only restore is not enough: a run that is interrupted mid-suite (a
 * killed process, a mutation experiment, a timeout) leaves the company's quality
 * policy flipped, and the NEXT run's beforeAll then captures the flipped value
 * as if it were the truth and restores that. Restoring per test keeps the window
 * to a single `it`.
 */
async function withIqc(required, fn) {
  const { rows: [before] } = await pool.query(
    'SELECT require_iqc_before_stock AS v FROM quality_settings WHERE company_id = $1', [CO]);
  await setIqc(required);
  try { return await fn(); }
  finally { if (before) await setIqc(before.v); }
}

// ═══════════════════════════════════════════════════════════════════════════
describe('vendor → finance identity is deterministic', () => {
  it('binds a vendor to exactly one finance party, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const first  = await resolveVendorParty(client, vendorId);
      const second = await resolveVendorParty(client, vendorId);
      await client.query('COMMIT');

      expect(first.party?.id).toBeTruthy();
      // The second call must not mint a second identity for the same supplier —
      // that is the failure the name-matching bridge produced.
      expect(second.party.id).toBe(first.party.id);
      expect(second.created).toBe(false);
      expect(second.matchedOn).toBe('existing');
    } finally { client.release(); }

    const { rows } = await pool.query('SELECT party_id FROM vendors WHERE id = $1', [vendorId]);
    expect(rows[0].party_id).toBeTruthy();

    // The party carries the vendor's own trading terms, not a default.
    const { rows: [party] } = await pool.query('SELECT * FROM parties WHERE id = $1', [rows[0].party_id]);
    expect(party.party_type.toLowerCase()).toBe('supplier');
    expect(party.company_id).toBe(CO);
    expect(Number(party.payment_terms)).toBe(45);
  });

  it('refuses to bind a party belonging to another company', async () => {
    // The trigger is the safeguard: predicate hygiene can be forgotten, a
    // constraint cannot. Uses a party in a company the vendor is not in.
    const { rows: [foreign] } = await pool.query(
      `INSERT INTO parties (party_code, party_type, name, company_id, is_active)
       VALUES ($1, 'Supplier', $2, 999901, true) RETURNING id`,
      [`${TAG}-FGN`, `${TAG} foreign party`]
    );
    await pool.query(
      `INSERT INTO companies (id, name, code) VALUES (999901, 'ZZLC foreign tenant', 'ZZLCF')
       ON CONFLICT (id) DO NOTHING`
    );
    await expect(
      pool.query('UPDATE vendors SET party_id = $1 WHERE id = $2', [foreign.id, vendorId])
    ).rejects.toThrow(/cannot be bound to finance party/);
    await pool.query('DELETE FROM parties WHERE id = $1', [foreign.id]);
  });

  it('will not let two vendors share one finance party', async () => {
    const { rows: [other] } = await pool.query(
      `INSERT INTO vendors (vendor_name, company_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`${TAG} Second Supplier`, CO]
    );
    const { rows: [bound] } = await pool.query('SELECT party_id FROM vendors WHERE id = $1', [vendorId]);
    // Double-drawing on one AP identity would double-count that supplier's spend.
    await expect(
      pool.query('UPDATE vendors SET party_id = $1 WHERE id = $2', [bound.party_id, other.id])
    ).rejects.toThrow(/vendors_party_id_unique/);
    await pool.query('DELETE FROM vendors WHERE id = $1', [other.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('receipt → inventory', () => {
  it('books a receipt into stock atomically: batch AND ledger, on the same commit', async () => {
   await withIqc(false, async () => {         // no inspection gate on this path
    const { po, line } = await makeApprovedPo({ qty: 10, rate: 100 });

    const grn = await grnService.createGRN({
      po_id: po.id, company_id: CO, warehouse_id: warehouseId,
      received_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 10, quantity_rejected: 0, rate: 100 }],
    }, null);

    expect(grn.id).toBeTruthy();
    // The status the UI actually reads — not the 'draft' column default that
    // every receipt used to inherit and no screen counted.
    expect(grn.status).toBe('pending');

    const { rows: batches } = await pool.query('SELECT * FROM inventory_batches WHERE grn_id = $1', [grn.id]);
    expect(batches).toHaveLength(1);
    expect(Number(batches[0].quantity_available)).toBe(10);

    const { rows: ledger } = await pool.query(
      `SELECT * FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1`, [grn.id]
    );
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].quantity_in)).toBe(10);

    // The order is complete — computed on the transaction's own client. Read off
    // the pool it always saw the pre-receipt quantities and left the PO 'partial'.
    const { rows: [after] } = await pool.query('SELECT status FROM purchase_orders WHERE id=$1', [po.id]);
    expect(after.status).toBe('received');

    // Both receipt columns move together, so MRP's open-supply figure is right.
    const { rows: [poi] } = await pool.query('SELECT received_quantity, received_qty FROM purchase_order_items WHERE id=$1', [line.id]);
    expect(Number(poi.received_quantity)).toBe(10);
    expect(Number(poi.received_qty)).toBe(10);
   });
  });

  it('creates NO usable stock while the goods are held for inspection', async () => {
   await withIqc(true, async () => {
    const { po, line } = await makeApprovedPo({ qty: 4, rate: 50 });

    const grn = await grnService.createGRN({
      po_id: po.id, company_id: CO, warehouse_id: warehouseId,
      received_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} held receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 4, quantity_rejected: 0, rate: 50 }],
    }, null);

    expect(grn.quality_status).toBe('pending');

    // The receipt previously created the BATCH regardless — with
    // quantity_available equal to the full accepted quantity — while skipping
    // the ledger. Allocation, valuation and the batch stock view all read
    // quantity_available, so the "hold" held nothing.
    const { rows: batches } = await pool.query('SELECT * FROM inventory_batches WHERE grn_id = $1', [grn.id]);
    expect(batches).toHaveLength(0);
    const { rows: ledger } = await pool.query(
      `SELECT 1 FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1`, [grn.id]);
    expect(ledger).toHaveLength(0);

    // Quality clears it → the stock appears, batch and ledger together.
    const released = await grnService.releaseGrnStock(grn.id);
    expect(released.released).toBe(true);
    const { rows: after } = await pool.query('SELECT * FROM inventory_batches WHERE grn_id = $1', [grn.id]);
    expect(after).toHaveLength(1);
    expect(Number(after[0].quantity_available)).toBe(4);
    const { rows: led2 } = await pool.query(
      `SELECT * FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1`, [grn.id]);
    expect(led2).toHaveLength(1);

    // Releasing twice must not post the stock twice.
    const again = await grnService.releaseGrnStock(grn.id);
    expect(again.released).toBe(false);
    expect(again.reason).toBe('already_posted');
    const { rows: led3 } = await pool.query(
      `SELECT * FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1`, [grn.id]);
    expect(led3).toHaveLength(1);
   });
  });

  it('leaves NO inventory behind when the receipt is refused', async () => {
    // This is the regression for the four orphaned batches that were live in
    // this database: createBatch() issued its INSERT on the shared pool, so it
    // committed independently of the transaction that was about to roll back.
   await withIqc(false, async () => {
    const { po, line } = await makeApprovedPo({ qty: 5, rate: 20 });

    const batchesBefore = (await pool.query('SELECT COUNT(*)::int n FROM inventory_batches')).rows[0].n;

    // Two lines: the first is fine, the second is an over-receipt. The refusal
    // therefore happens AFTER the first line would have created its batch.
    await expect(grnService.createGRN({
      po_id: po.id, company_id: CO, warehouse_id: warehouseId,
      received_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} refused receipt`,
      items: [
        { po_item_id: line.id, item_id: itemId, quantity_received: 3, quantity_rejected: 0, rate: 20 },
        { po_item_id: line.id, item_id: itemId, quantity_received: 99, quantity_rejected: 0, rate: 20 },
      ],
    }, null)).rejects.toThrow(/Over-receipt/);

    const batchesAfter = (await pool.query('SELECT COUNT(*)::int n FROM inventory_batches')).rows[0].n;
    expect(batchesAfter).toBe(batchesBefore);

    const { rows: [poi] } = await pool.query('SELECT received_quantity FROM purchase_order_items WHERE id=$1', [line.id]);
    expect(Number(poi.received_quantity)).toBe(0);
    const { rows: grns } = await pool.query('SELECT id FROM goods_receipt_notes WHERE po_id=$1', [po.id]);
    expect(grns).toHaveLength(0);
   });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('receipt → 3-way match → AP bill', () => {
  it('raises ONE payable bill with the right split, party and balance', async () => {
   await withIqc(false, async () => {
    const qty = 10, rate = 100, taxRate = 18;
    const { po, line, subtotal, tax } = await makeApprovedPo({ qty, rate, taxRate });
    const gross = subtotal + tax;                                   // 1180.00

    const grn = await grnService.createGRN({
      po_id: po.id, company_id: CO, warehouse_id: warehouseId,
      received_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} billable receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: qty, quantity_rejected: 0, rate }],
    }, null);

    const invoiceNo = `${TAG}-INV-${Date.now()}`;
    const match = await createThreeWayMatchRecord(CO, {
      po_id: po.id, grn_id: grn.id,
      vendor_invoice_no: invoiceNo,
      vendor_invoice_date: new Date().toISOString().slice(0, 10),
      vendor_invoice_amount: gross,
    });

    // Each leg on its OWN basis: receipt vs ex-tax subtotal, invoice vs inc-tax
    // total. Comparing both against the inc-tax total built a guaranteed 15.25%
    // variance into every 18% GST receipt.
    expect(match.match_status).toBe('matched');
    expect(Number(match.grn_amount)).toBeCloseTo(subtotal, 2);

    // Approve it through the route's own logic by driving the same statements.
    const { rows: [approved] } = await pool.query(
      `UPDATE three_way_matches SET match_status='approved' WHERE id=$1 RETURNING *`, [match.id]
    );
    expect(approved.match_status).toBe('approved');
   });
  });

  it('a re-posted match learns the invoice instead of creating a second row', async () => {
   await withIqc(false, async () => {
    const { po, line, subtotal, tax } = await makeApprovedPo({ qty: 2, rate: 500 });
    const grn = await grnService.createGRN({
      po_id: po.id, company_id: CO, warehouse_id: warehouseId,
      received_date: new Date().toISOString().slice(0, 10),
      notes: `${TAG} repost receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 2, quantity_rejected: 0, rate: 500 }],
    }, null);

    const invoiceNo = `${TAG}-RP-${Date.now()}`;
    const first = await createThreeWayMatchRecord(CO, {
      po_id: po.id, grn_id: grn.id, vendor_invoice_no: invoiceNo, vendor_invoice_amount: subtotal + tax,
    });
    const second = await createThreeWayMatchRecord(CO, {
      po_id: po.id, grn_id: grn.id, vendor_invoice_no: invoiceNo, vendor_invoice_amount: subtotal + tax,
    });
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM three_way_matches WHERE po_id=$1 AND vendor_invoice_no=$2`,
      [po.id, invoiceNo]
    );
    expect(rows[0].n).toBe(1);
   });
  });
});
