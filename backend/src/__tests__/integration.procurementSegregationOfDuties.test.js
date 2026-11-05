/**
 * integration.procurementSegregationOfDuties.test.js
 *
 * Two controls the procurement audit found missing, driven through the REAL
 * routes against the REAL database.
 *
 * 1. SEGREGATION OF DUTIES ON APPROVAL
 *    The value-band ladder asked only whether an ACCOUNT carried enough
 *    authority for an AMOUNT. It never asked whether that account was the same
 *    person who raised the document, so a manager holding L1 authority could
 *    raise a 20,000 requisition and approve it himself — every check passed,
 *    and the audit trail recorded a properly approved document. These cases pin
 *    the rule AND its two deliberate exemptions (the auto band, and the
 *    per-company escape hatch), because a control that cannot be scoped is one
 *    an operator eventually disables wholesale.
 *
 * 2. CSV FORMULA NEUTRALISATION
 *    The exports escaped quotes and nothing else. A requisition note or a
 *    portal-supplied vendor name beginning with = + - @ is evaluated as a
 *    formula by every spreadsheet that opens the file. The assertion below is
 *    on the BYTES of the response, because that is what lands on the analyst's
 *    disk — a test that inspected the row objects would pass against the bug.
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

const TAG     = 'ZZSOD';
const CO_A    = 1;
// A tenant of this suite's ALONE. It used to be 999904, which
// integration.procurementAnalytics also claims as its own private company —
// and this file writes a procurement_settings row there with
// allow_self_approval = TRUE, then DELETES that row in afterAll. Two suites
// running in parallel (4 workers) against one company, one of them toggling
// the setting that governs approval, is a run-order-dependent result waiting
// for the first analytics test that calls an approval route.
const CO_FLAG = 999915;   // a company that has opted OUT of the rule
const RAISER  = 2;        // employees.id — raises the documents
const OTHER   = 3;        // employees.id — an independent approver

/** Build an app whose caller is exactly the identity given. */
function appAs({ roles = ['procurement_manager'], companyId = CO_A, userId = 1, employeeId = null }) {
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

const raiser = (companyId = CO_A) => appAs({ employeeId: RAISER, userId: RAISER, companyId });
const other  = (companyId = CO_A) => appAs({ employeeId: OTHER,  userId: OTHER,  companyId });

async function sweep() {
  const p = [`%${TAG}%`];
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, p);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, p);
  await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE notes LIKE $1)`, p);
  await pool.query(`DELETE FROM purchase_orders WHERE notes LIKE $1 OR po_number LIKE $1`, p);
}

/** Raise a requisition through the route, so requested_by_employee_id is stamped the way the app stamps it. */
async function raisePr({ amount, companyId = CO_A, notes = `${TAG} sod` }) {
  const res = await request(raiser(companyId)).post('/api/procurement/purchase-requests').send({
    notes,
    request_date: new Date().toISOString().slice(0, 10),
    items: [{ item_name: `${TAG} widget`, quantity: 1, expected_price: amount }],
  });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  await sweep();
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1,'ZZSOD opted-out tenant','ZZSOD') ON CONFLICT (id) DO NOTHING`,
    [CO_FLAG]
  );
  // The escape hatch, set for CO_FLAG only — company 1's real settings are left alone.
  await pool.query(
    `INSERT INTO procurement_settings (company_id, allow_self_approval, auto_approve_below, l1_approval_limit, l2_approval_limit, cfo_approval_above)
     VALUES ($1, TRUE, 5000, 25000, 100000, 500000)
     ON CONFLICT (company_id) DO UPDATE SET allow_self_approval = TRUE`,
    [CO_FLAG]
  );
});

afterAll(async () => {
  await sweep();
  await pool.query(`DELETE FROM procurement_settings WHERE company_id=$1`, [CO_FLAG]);
});

describe('segregation of duties — purchase requisitions', () => {
  it('refuses the approval when the approver is the requester', async () => {
    const pr  = await raisePr({ amount: 20000 });
    const res = await request(raiser()).put(`/api/procurement/purchase-requests/${pr.id}/approve`).send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL_BLOCKED');

    // And it is refused in the DATABASE, not merely in the response.
    const { rows } = await pool.query(`SELECT status, approved_by FROM purchase_requests WHERE id=$1`, [pr.id]);
    expect(rows[0].status).not.toBe('approved');
    expect(rows[0].approved_by).toBeNull();
  });

  it('allows an independent approver holding the same authority', async () => {
    const pr  = await raisePr({ amount: 20000 });
    const res = await request(other()).put(`/api/procurement/purchase-requests/${pr.id}/approve`).send({});

    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT status FROM purchase_requests WHERE id=$1`, [pr.id]);
    expect(rows[0].status).toBe('approved');
  });

  it('does not engage below the auto-approval threshold, where no authority is required', async () => {
    const pr  = await raisePr({ amount: 1000 });
    const res = await request(raiser()).put(`/api/procurement/purchase-requests/${pr.id}/approve`).send({});

    expect(res.status).toBe(200);
  });

  it('honours a company that has enabled self-approval', async () => {
    const pr  = await raisePr({ amount: 20000, companyId: CO_FLAG });
    const res = await request(raiser(CO_FLAG)).put(`/api/procurement/purchase-requests/${pr.id}/approve`).send({});

    expect(res.status).toBe(200);
  });
});

describe('segregation of duties — purchase orders', () => {
  it('refuses the approval when the approver raised the order', async () => {
    const { rows: [po] } = await pool.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, order_date, subtotal, tax_amount, total_amount, status, notes, company_id, created_by)
       SELECT $1, v.id, CURRENT_DATE, 20000, 0, 20000, 'draft', $2, $3, $4
         FROM vendors v WHERE v.company_id=$3 AND v.deleted_at IS NULL ORDER BY v.id LIMIT 1
       RETURNING id`,
      [`${TAG}-PO-${Date.now()}`, `${TAG} sod`, CO_A, RAISER]
    );
    // purchase_order_items carries no item_name — it is item_id or nothing.
    // The approve route only counts lines, so one line of any shape will do.
    await pool.query(
      `INSERT INTO purchase_order_items (po_id, item_id, quantity, rate, tax_rate, tax_amount, total_amount)
       SELECT $1, (SELECT id FROM inventory_items ORDER BY id LIMIT 1), 1, 20000, 0, 0, 20000`,
      [po.id]
    );

    const res = await request(raiser()).patch(`/api/procurement/purchase-orders/${po.id}/approve`).send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL_BLOCKED');
    const { rows } = await pool.query(`SELECT status FROM purchase_orders WHERE id=$1`, [po.id]);
    expect(rows[0].status).toBe('draft');
  });
});

describe('CSV exports neutralise spreadsheet formulas', () => {
  it('prefixes a formula that arrived in a requisition note', async () => {
    // The classic DDE payload. If this reaches the file unprefixed, Excel runs
    // it on the machine of whoever opens the export.
    // The payload has to START the cell — that is the only position a
    // spreadsheet treats as a formula — so the sweep tag trails it.
    const payload = "=cmd|'/c calc'!A1";
    await raisePr({ amount: 100, notes: `${payload} ${TAG}` });

    const res = await request(raiser()).get('/api/procurement/purchase-requests/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    // The payload is present as TEXT (apostrophe-prefixed) and never as a cell
    // that opens with '='.
    expect(res.text).toContain(`"'${payload} ${TAG}`);
    expect(res.text).not.toContain(`"${payload} ${TAG}`);
  });

  it('leaves negative amounts as numbers, not as text', async () => {
    // The neutralisation must not catch a leading minus on a real number, or
    // every credit in a spend extract stops summing.
    const { csvCell } = await import('../shared/csv.js');
    expect(csvCell(-4500)).toBe('"-4500"');
    expect(csvCell('-4500.25')).toBe('"-4500.25"');
    expect(csvCell('-not a number')).toBe(`"'-not a number"`);
  });
});
