/**
 * integration.procurementAnalytics.test.js
 *
 * Every procurement KPI, checked against DATABASE TRUTH.
 *
 * THE METHOD, AND WHY IT IS THIS ONE
 * ----------------------------------
 * Each test asks the endpoint for a number and then computes the same number
 * from the base tables with an INDEPENDENT query — written from the KPI's stated
 * definition, not copied from the handler. Asserting a handler against its own
 * SQL proves only that the SQL is deterministic; it passes just as happily when
 * the SQL is wrong. The definitions are written out in each test so the
 * intention is reviewable, which is the point of Requirement 10: the number the
 * screen shows has to mean what its label says.
 *
 * The comparison is made twice — once against the live book, and once after
 * this suite adds a known delta — so a KPI that is accidentally constant (a
 * hardcoded value, a query that silently returns nothing and falls back to zero)
 * cannot pass. That second half is what catches the fabricated-KPI pattern; a
 * single snapshot comparison does not.
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

const { default: pool }       = await import('../config/db.js');
const { default: procRouter } = await import('../modules/procurement/routes/procurement.routes.js');
const { default: poRepo }     = await import('../modules/procurement/repositories/purchaseOrder.repository.js');

const TAG = 'ZZAN';
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A tenant of this suite's own.
 *
 * These KPIs are company-wide totals, and asserting one means reading it twice —
 * once as a baseline, once after a known delta. Against company 1 that is a race
 * with every other suite: integration.procurementHardening raises a ₹5,900,000
 * order to exercise the CFO approval band, and if it lands between this file's
 * two reads the delta assertion fails on a number that is, in fact, correct.
 *
 * Running in an empty company of its own makes every figure here deterministic
 * AND makes the baseline meaningful: the first assertion starts from zero, so a
 * KPI that silently returns a constant cannot hide inside a large live total.
 */
const CO  = 999904;

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user  = { userId: 1, roles: ['procurement_manager'], company_id: CO };
    req.scope = { company_id: CO };
    next();
  });
  a.use('/api/procurement', procRouter);
  return a;
})();

let itemId, warehouseId, vendorId;

async function sweep() {
  const poScope  = `(SELECT id FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1)`;
  const grnScope = `(SELECT id FROM goods_receipt_notes WHERE notes LIKE $1 OR po_id IN ${poScope})`;
  const p = [`${TAG}%`];
  await pool.query(`DELETE FROM three_way_matches WHERE po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM stock_ledger WHERE reference_type='grn' AND reference_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM inventory_batches WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM grn_items WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM goods_receipt_notes WHERE notes LIKE $1 OR po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1`, p);
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, p);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, p);
  await pool.query(`UPDATE vendors SET party_id = NULL WHERE vendor_name LIKE $1`, p);
  await pool.query(`DELETE FROM parties WHERE name LIKE $1`, p);
  await pool.query(`DELETE FROM vendors WHERE vendor_name LIKE $1`, p);
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZAN analytics tenant', 'ZZANA')
     ON CONFLICT (id) DO NOTHING`, [CO]
  );
  await sweep();
  // The item and warehouse are only FK targets here — the KPI queries scope on
  // the document's own company_id, not the item's.
  itemId      = (await pool.query('SELECT id FROM inventory_items ORDER BY id LIMIT 1')).rows[0]?.id;
  warehouseId = (await pool.query('SELECT id FROM warehouses ORDER BY id LIMIT 1')).rows[0]?.id;
  vendorId    = (await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status, category) VALUES ($1,$2,'active','Raw Materials') RETURNING id`,
    [`${TAG} Analytics Supplier`, CO])).rows[0].id;
});
afterAll(sweep);

async function makePo({ status = 'approved', qty = 4, rate = 250, taxRate = 18, orderDate = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subtotal = qty * rate, tax = subtotal * taxRate / 100;
    const po = await poRepo.create(client, {
      po_number: `${TAG}-PO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      supplier_id: vendorId, order_date: orderDate || new Date().toISOString().slice(0, 10),
      subtotal, tax_amount: tax, total_amount: subtotal + tax,
      notes: `${TAG} analytics`, company_id: CO, created_by: null,
    });
    await client.query(`UPDATE purchase_orders SET status=$1 WHERE id=$2`, [status, po.id]);
    const line = await poRepo.createItem(client, {
      po_id: po.id, item_id: itemId, quantity: qty, rate,
      tax_rate: taxRate, tax_amount: tax, total_amount: subtotal + tax,
    });
    await client.query('COMMIT');
    return { po: { ...po, status }, line, gross: subtotal + tax };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ═══════════════════════════════════════════════════════════════════════════
describe('purchase requisition KPIs', () => {
  /**
   * DEFINITION — GET /purchase-requests/stats
   *   total            live requisitions in this company
   *   pending_approval status = 'pending_approval'
   *   approved         status = 'approved'
   *   ordered          status = 'converted_to_po'
   *   rejected         status = 'rejected'
   * Scoped on purchase_requests.company_id, NOT the requester's company: a
   * requisition with no requester used to vanish from every one of these.
   */
  it('counts the register the buyer can actually see', async () => {
    const truth = (await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status='pending_approval')::int AS pending_approval,
             COUNT(*) FILTER (WHERE status='approved')::int         AS approved,
             COUNT(*) FILTER (WHERE status='converted_to_po')::int  AS ordered,
             COUNT(*) FILTER (WHERE status='rejected')::int         AS rejected
        FROM purchase_requests WHERE deleted_at IS NULL AND company_id = $1`, [CO])).rows[0];

    const res = await request(app).get('/api/procurement/purchase-requests/stats');
    expect(res.status).toBe(200);
    for (const k of Object.keys(truth)) expect(Number(res.body[k])).toBe(truth[k]);
    // Starting from an empty tenant, so the baseline is a real zero rather than
    // a large live total a constant could hide inside.
    expect(truth.total).toBe(0);

    // The KPI must MOVE. A constant passes the snapshot above.
    const { rows: [pr] } = await pool.query(
      `INSERT INTO purchase_requests (request_number, company_id, status, request_date, notes)
       VALUES ($1,$2,'pending_approval',CURRENT_DATE,$3) RETURNING id`,
      [`${TAG}-PR-${Date.now()}`, CO, `${TAG} analytics pr`]
    );
    const after = await request(app).get('/api/procurement/purchase-requests/stats');
    expect(Number(after.body.pending_approval)).toBe(truth.pending_approval + 1);
    expect(Number(after.body.total)).toBe(truth.total + 1);
    await pool.query('DELETE FROM purchase_requests WHERE id=$1', [pr.id]);
  });

  it('does not count another tenant\'s requisitions', async () => {
    const before = await request(app).get('/api/procurement/purchase-requests/stats');
    await pool.query(
      `INSERT INTO companies (id, name, code) VALUES (999903,'ZZAN foreign','ZZANF') ON CONFLICT (id) DO NOTHING`);
    const { rows: [foreign] } = await pool.query(
      `INSERT INTO purchase_requests (request_number, company_id, status, request_date, notes)
       VALUES ($1,999903,'pending_approval',CURRENT_DATE,$2) RETURNING id`,
      [`${TAG}-PRX-${Date.now()}`, `${TAG} foreign pr`]
    );
    const after = await request(app).get('/api/procurement/purchase-requests/stats');
    expect(Number(after.body.total)).toBe(Number(before.body.total));
    await pool.query('DELETE FROM purchase_requests WHERE id=$1', [foreign.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('purchase order KPIs', () => {
  /**
   * DEFINITION — GET /purchase-orders/stats
   *   pending      status = 'sent'      (with the vendor, not yet delivered)
   *   approved     status = 'approved'
   *   received     status = 'received'
   *   follow_up    status = 'sent' and raised more than 7 days ago
   *   total_value  SUM(total_amount) over everything except cancelled
   */
  it('matches the order book', async () => {
    const truth = (await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status='sent')::int     AS pending,
             COUNT(*) FILTER (WHERE status='approved')::int AS approved,
             COUNT(*) FILTER (WHERE status='received')::int AS received,
             COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled'),0)::numeric AS total_value,
             COUNT(*)::int AS total
        FROM purchase_orders WHERE deleted_at IS NULL AND company_id = $1`, [CO])).rows[0];

    const res = await request(app).get('/api/procurement/purchase-orders/stats');
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(truth.pending);
    expect(res.body.approved).toBe(truth.approved);
    expect(res.body.received).toBe(truth.received);
    expect(res.body.total).toBe(truth.total);
    expect(res.body.total_value).toBeCloseTo(Number(truth.total_value), 2);

    const { po, gross } = await makePo({ status: 'approved' });
    const after = await request(app).get('/api/procurement/purchase-orders/stats');
    expect(after.body.approved).toBe(truth.approved + 1);
    expect(after.body.total_value).toBeCloseTo(Number(truth.total_value) + gross, 2);
    await pool.query('DELETE FROM purchase_order_items WHERE po_id=$1', [po.id]);
    await pool.query('DELETE FROM purchase_orders WHERE id=$1', [po.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('procurement dashboard KPIs', () => {
  /**
   * DEFINITION — GET /dashboard
   *   pending_prs      purchase_requests.status = 'pending_approval'
   *   pending_pos      purchase_orders.status IN ('draft','sent')
   *   pending_grns     goods_receipt_notes.status IS NULL OR 'pending'
   *   monthly_purchase SUM of committed PO value in INR, this calendar month
   *   ytd_spend        the same, this calendar year
   *
   * pending_grns is the one worth stating explicitly: it reads 'pending', and
   * every receipt the application created was born 'draft' (the column default),
   * so this KPI returned 0 for a receiving bay with work in it. It is only
   * correct now because the receipt path writes the vocabulary the KPI reads —
   * which is exactly why the number and its writer have to be tested together.
   */
  it('counts pending goods receipts that actually exist', async () => {
    const truthQ = `SELECT COUNT(*)::int n FROM goods_receipt_notes
                     WHERE (status IS NULL OR status='pending') AND deleted_at IS NULL AND company_id=$1`;
    const before = (await pool.query(truthQ, [CO])).rows[0].n;
    const res = await request(app).get('/api/procurement/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.pending_grns).toBe(before);

    const { po, line } = await makePo({ status: 'approved' });
    const grn = await request(app).post('/api/procurement/grn').send({
      po_id: po.id, warehouse_id: warehouseId, notes: `${TAG} analytics receipt`,
      items: [{ po_item_id: line.id, item_id: itemId, quantity_received: 4, rate: 250 }],
    });
    expect(grn.status).toBe(201);

    const after = await request(app).get('/api/procurement/dashboard');
    // A receipt the app just created MUST appear in the receiving KPI. This is
    // the assertion the old 'draft' default failed.
    expect(after.body.pending_grns).toBe(before + 1);
    expect((await pool.query(truthQ, [CO])).rows[0].n).toBe(before + 1);
  });

  it('reports month-to-date spend in INR, excluding drafts and cancellations', async () => {
    // Definition restated independently: committed statuses only (a draft is not
    // a commitment), valued on total_amount_inr with the row's own rate as the
    // fallback — never the raw total_amount, which is in the PO's own currency.
    const truthQ = `
      SELECT COALESCE(SUM(COALESCE(total_amount_inr, total_amount * COALESCE(NULLIF(exchange_rate,0),1), 0)),0)::numeric AS v
        FROM purchase_orders
       WHERE deleted_at IS NULL AND company_id = $1
         AND order_date >= DATE_TRUNC('month', CURRENT_DATE)
         AND status NOT IN ('draft','cancelled','rejected')`;
    const before = Number((await pool.query(truthQ, [CO])).rows[0].v);

    const res = await request(app).get('/api/procurement/dashboard');
    expect(res.body.monthly_purchase).toBeCloseTo(before, 2);

    const { po, gross } = await makePo({ status: 'approved' });
    const after = await request(app).get('/api/procurement/dashboard');
    expect(after.body.monthly_purchase).toBeCloseTo(before + gross, 2);

    // And a DRAFT order must not move it — a draft is not spend.
    const draft = await makePo({ status: 'draft' });
    const withDraft = await request(app).get('/api/procurement/dashboard');
    expect(withDraft.body.monthly_purchase).toBeCloseTo(before + gross, 2);

    for (const id of [po.id, draft.po.id]) {
      await pool.query('DELETE FROM purchase_order_items WHERE po_id=$1', [id]);
      await pool.query('DELETE FROM purchase_orders WHERE id=$1', [id]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('spend cube', () => {
  /**
   * DEFINITION — GET /analytics/spend
   *   Vendor spend is a HEADER figure: SUM of committed PO value in INR, by
   *   supplier. Shares are computed against the true grand total BEFORE any
   *   truncation, and `coverage` states the header total, the line-classified
   *   total and the gap between them (freight and header charges live outside
   *   the lines, so the two do not reconcile and the response says so).
   */
  it('sums vendor spend to the same grand total as the order book', async () => {
    const { po, gross } = await makePo({ status: 'approved' });

    const res = await request(app).get('/api/procurement/analytics/spend');
    expect(res.status).toBe(200);

    const truth = Number((await pool.query(`
      SELECT COALESCE(SUM(COALESCE(total_amount_inr, total_amount * COALESCE(NULLIF(exchange_rate,0),1), 0)),0)::numeric AS v
        FROM purchase_orders
       WHERE deleted_at IS NULL AND company_id = $1
         AND status NOT IN ('draft','cancelled','rejected')`, [CO])).rows[0].v);

    expect(Number(res.body.coverage.header_spend)).toBeCloseTo(truth, 2);
    expect(Number(res.body.totals.total_spend)).toBeCloseTo(truth, 2);

    // This suite's own supplier must be in the vendor facet at exactly the value
    // the order book holds for it — computed here from the base table, not from
    // this test's own arithmetic, so a PO left behind by an earlier test in the
    // file cannot make the assertion wrong instead of making it fail.
    const vendorTruth = Number((await pool.query(`
      SELECT COALESCE(SUM(COALESCE(total_amount_inr, total_amount * COALESCE(NULLIF(exchange_rate,0),1), 0)),0)::numeric AS v
        FROM purchase_orders
       WHERE deleted_at IS NULL AND company_id = $1 AND supplier_id = $2
         AND status NOT IN ('draft','cancelled','rejected')`, [CO, vendorId])).rows[0].v);
    expect(vendorTruth).toBeGreaterThanOrEqual(gross);

    const mine = res.body.by_vendor.find(r => r.vendor_name === `${TAG} Analytics Supplier`);
    expect(mine).toBeTruthy();
    expect(Number(mine.total_spend)).toBeCloseTo(vendorTruth, 2);

    // Shares are computed against the TRUE grand total, before truncation — so
    // this vendor's share is its spend over the header total, not over the sum
    // of whatever rows happened to survive the limit.
    expect(Number(mine.share_pct)).toBeCloseTo(round2((vendorTruth / truth) * 100), 1);

    await pool.query('DELETE FROM purchase_order_items WHERE po_id=$1', [po.id]);
    await pool.query('DELETE FROM purchase_orders WHERE id=$1', [po.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('procurement spend that reaches other modules', () => {
  /**
   * DEFINITION — a project's procurement cost is the INR value of the purchase
   * orders raised against it that represent a real commitment. A draft is not a
   * commitment; a cancelled or rejected order is a withdrawn one; and the figure
   * has to be in one currency.
   *
   * `project-profitability.routes.js` filtered on
   * `status NOT IN ('Cancelled','Rejected')` — Capitalised, while
   * purchase_orders.status is lower case throughout, so the predicate excluded
   * NOTHING. Cancelled orders, rejected orders and drafts were all charged to
   * the project, and `SUM(total_amount)` added foreign-currency orders at face
   * value. The number was inflated in three independent ways at once, and every
   * one of them made a project look less profitable than it was.
   */
  it('charges a project only for orders that are real commitments', async () => {
    const { rows: [project] } = await pool.query(
      `INSERT INTO projects (project_name, project_code, company_id, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [`${TAG} spend project`, `${TAG}-PRJ`, CO]
    ).catch(() => ({ rows: [] }));
    if (!project) return;               // schema without a projects table

    try {
      const committed = await makePo({ status: 'approved' });
      const draft     = await makePo({ status: 'draft' });
      const cancelled = await makePo({ status: 'cancelled' });
      for (const p of [committed, draft, cancelled]) {
        await pool.query('UPDATE purchase_orders SET project_id=$1 WHERE id=$2', [project.id, p.po.id]);
      }

      const { rows: [truth] } = await pool.query(`
        SELECT COALESCE(SUM(COALESCE(total_amount_inr, total_amount * COALESCE(NULLIF(exchange_rate,0),1), 0)),0)::numeric AS v
          FROM purchase_orders
         WHERE project_id = $1 AND deleted_at IS NULL
           AND status NOT IN ('draft','cancelled','rejected')`, [project.id]);

      // Exactly one of the three counts, so the total is that order alone —
      // not the 3x figure the Capitalised filter produced.
      expect(Number(truth.v)).toBeCloseTo(committed.gross, 2);

      const { rows: [broken] } = await pool.query(`
        SELECT COALESCE(SUM(total_amount),0)::numeric AS v
          FROM purchase_orders WHERE project_id=$1 AND status NOT IN ('Cancelled','Rejected')`,
        [project.id]);
      // The old predicate is demonstrably wrong on this data: it charges all three.
      expect(Number(broken.v)).toBeCloseTo(committed.gross * 3, 2);

      const { poSpendInr } = await import('../modules/procurement/services/spendAnalytics.service.js');
      const { sqlPoCommitted } = await import('../shared/statusSets.js');
      const { rows: [fixed] } = await pool.query(`
        SELECT COALESCE(SUM(${poSpendInr('po')}),0)::numeric AS v
          FROM purchase_orders po
         WHERE po.project_id=$1 AND po.deleted_at IS NULL AND ${sqlPoCommitted('po.status')}`,
        [project.id]);
      expect(Number(fixed.v)).toBeCloseTo(Number(truth.v), 2);

      for (const p of [committed, draft, cancelled]) {
        await pool.query('DELETE FROM purchase_order_items WHERE po_id=$1', [p.po.id]);
        await pool.query('DELETE FROM purchase_orders WHERE id=$1', [p.po.id]);
      }
    } finally {
      await pool.query('DELETE FROM projects WHERE id=$1', [project.id]).catch(() => {});
    }
  });
});
