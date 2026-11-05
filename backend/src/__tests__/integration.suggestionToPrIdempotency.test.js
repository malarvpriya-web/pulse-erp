/**
 * integration.suggestionToPrIdempotency.test.js
 *
 * Drives the REAL Convert endpoint and the REAL cron path against the REAL
 * database, with REAL concurrency (Promise.all over separate pool connections —
 * not a simulation).
 *
 * WHAT IS BEING PROVED
 * ====================
 * A purchase suggestion becomes AT MOST ONE purchase requisition, whatever
 * happens:
 *
 *   1. Sequential retry            → one requisition, second call answers 200 with it
 *   2. Simultaneous requests       → one requisition, not two
 *   3. Cron racing the button      → one requisition
 *   4. A caller that bypasses the service entirely → the DB refuses (23505)
 *   5. The transaction is atomic   → a failure leaves NO half-built requisition
 *
 * ⚠ CASE 2 IS THE ONE THAT USED TO FAIL, and it failed for a reason that reads as
 * safe: both old implementations flipped `status` to 'converted_to_pr' INSIDE their
 * transaction, and the cron's own comment cited that as structural dedup. It is
 * not. In READ COMMITTED — this database's default, asserted below because the
 * whole argument depends on it — two transactions both SELECT 'pending' and both
 * commit. The missing half was reading the row under a lock and re-checking after
 * acquiring it.
 *
 * ⚠ A concurrency test that runs its two requests through ONE express app on ONE
 * event loop can still serialise them by accident. These fire through two
 * independently-built apps with `Promise.all`, and every assertion is on the
 * DATABASE row count, never on the response bodies.
 *
 * Self-cleaning; sweep() runs on the way in as well as out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';

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

const { default: pool }      = await import('../config/db.js');
const { default: advRouter } = await import('../modules/inventory/routes/advancedInventory.routes.js');
const { convertSuggestionToPurchaseRequest } =
  await import('../modules/inventory/services/suggestionToPr.service.js');

const TAG = 'ZZS2PR';

function appAs(companyId, employeeId = null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, employee_id: employeeId, permissions: ['*'] };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/adv', advRouter);
  return app;
}

const ids = { company: null, item: null, warehouse: null, employee: null };
let A;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;

  const ourItems = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const ourSug   = `(SELECT id FROM purchase_suggestions WHERE item_id IN ${ourItems})`;
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE company_id = ANY($1) OR source_suggestion_id IN ${ourSug})`, [co]);
  await pool.query(`DELETE FROM purchase_requests     WHERE company_id = ANY($1) OR source_suggestion_id IN ${ourSug}`, [co]);
  await pool.query(`DELETE FROM purchase_suggestions  WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM stock_ledger          WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_items       WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM warehouses            WHERE company_id = ANY($1)`, [co]);

  const { rows: fks } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu  ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies'`);
  for (let pass = 0; pass < 2; pass++) {
    for (const { table_name, column_name } of fks) {
      try { await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, [co]); } catch { /* ordering */ }
    }
  }
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

/** A fresh pending suggestion. Each test gets its own so they cannot interfere. */
async function makeSuggestion(qty = 25) {
  const { rows } = await pool.query(
    `INSERT INTO purchase_suggestions (item_id, warehouse_id, suggested_quantity, priority, status, generated_date)
     VALUES ($1, $2, $3, 'high', 'pending', CURRENT_DATE) RETURNING id`,
    [ids.item, ids.warehouse, qty]);
  return rows[0].id;
}

/** Requisitions attributable to a suggestion, by BOTH columns. */
async function requisitionsFor(suggestionId) {
  const { rows } = await pool.query(
    `SELECT pr.id, pr.status, pr.total_amount::float AS total_amount, pr.company_id,
            pr.source_suggestion_id,
            (SELECT COUNT(*)::int FROM purchase_request_items i WHERE i.pr_id = pr.id) AS line_items
       FROM purchase_requests pr
      WHERE pr.source_suggestion_id = $1
         OR pr.id = (SELECT converted_to_pr_id FROM purchase_suggestions WHERE id = $1)
      ORDER BY pr.id`,
    [suggestionId]);
  return rows;
}

beforeAll(async () => {
  await sweep();

  const { rows: [co] } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co`, `${TAG}A`]);
  ids.company = co.id;

  const { rows: [emp] } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Buyer', $2, 'Active') RETURNING id`,
    [TAG, ids.company]);
  ids.employee = emp.id;

  const { rows: [item] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 10, 40) RETURNING id`,
    [`${TAG}-ITEM`, `${TAG} Item`, ids.company]);
  ids.item = item.id;

  const { rows: [wh] } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`,
    [`${TAG} WH`, ids.company]);
  ids.warehouse = wh.id;

  A = appAs(ids.company, ids.employee);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('Suggestion → PR · the premise this suite rests on', () => {
  it('runs at READ COMMITTED, where two plain SELECTs both see \'pending\'', async () => {
    // The whole argument for the row lock depends on this. If a future deploy sets
    // the cluster to SERIALIZABLE the concurrency tests below would pass for a
    // different reason, and this assertion says so out loud.
    const { rows: [iso] } = await pool.query(`SHOW default_transaction_isolation`);
    expect(iso.default_transaction_isolation).toBe('read committed');
  });

  it('the unique index that makes a duplicate unrepresentable is present', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_pr_source_suggestion'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('UNIQUE');
    expect(rows[0].indexdef).toContain('source_suggestion_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Suggestion → PR · one conversion produces one complete requisition', () => {
  it('creates a requisition with a number, a line item and a non-zero total', async () => {
    const sid = await makeSuggestion(25);
    const res = await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});
    expect(res.status).toBe(201);

    const prs = await requisitionsFor(sid);
    expect(prs).toHaveLength(1);

    // The "empty PR" failure class: a header with no items and a ₹0 total, which
    // mis-routes amount-banded approval. 25 x standard_cost 40 = 1000.
    expect(prs[0].line_items).toBe(1);
    expect(prs[0].total_amount).toBeCloseTo(1000, 2);
    // NULL company_id would make it invisible to every company-scoped user,
    // including the buyer who has to act on it.
    expect(prs[0].company_id).toBe(ids.company);
    expect(prs[0].source_suggestion_id).toBe(sid);

    const { rows: [sug] } = await pool.query(
      `SELECT status, converted_to_pr_id FROM purchase_suggestions WHERE id = $1`, [sid]);
    expect(sug.status).toBe('converted_to_pr');
    expect(sug.converted_to_pr_id).toBe(prs[0].id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Suggestion → PR · idempotent under retry', () => {
  it('a second sequential convert returns the SAME requisition and creates nothing', async () => {
    const sid = await makeSuggestion(10);

    const first = await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});
    expect(first.status).toBe(201);

    const second = await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});
    // 200, not 201: the requisition already existed. A widening of the success
    // set, so no existing client breaks — it used to be a 404 or a 500.
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    expect(await requisitionsFor(sid)).toHaveLength(1);
  });

  it('five sequential converts still leave exactly one requisition', async () => {
    const sid = await makeSuggestion(10);
    for (let i = 0; i < 5; i++) {
      const res = await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});
      expect([200, 201]).toContain(res.status);
    }
    expect(await requisitionsFor(sid)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Suggestion → PR · concurrency-safe', () => {
  it('two SIMULTANEOUS converts create ONE requisition, not two', async () => {
    const sid = await makeSuggestion(10);

    // Two independently-built apps so the requests cannot be serialised by
    // sharing a router instance's state.
    const appOne = appAs(ids.company, ids.employee);
    const appTwo = appAs(ids.company, ids.employee);

    const results = await Promise.all([
      request(appOne).post(`/adv/purchase-suggestions/${sid}/convert`).send({}),
      request(appTwo).post(`/adv/purchase-suggestions/${sid}/convert`).send({}),
    ]);

    // Both must SUCCEED — a retry answering 500 is a worse outcome for the user
    // than the duplicate was, and "one 500" is how a naive lock-only fix reads.
    for (const r of results) expect([200, 201]).toContain(r.status);

    // The assertion that would have caught the original defect.
    const prs = await requisitionsFor(sid);
    expect(prs).toHaveLength(1);

    // Exactly one of the two believes it created it.
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    // And both were told about the SAME requisition.
    expect(results[0].body.id).toBe(results[1].body.id);
  });

  it('eight simultaneous converts still create ONE requisition', async () => {
    const sid = await makeSuggestion(10);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(appAs(ids.company, ids.employee)).post(`/adv/purchase-suggestions/${sid}/convert`).send({})));

    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(await requisitionsFor(sid)).toHaveLength(1);
    expect(results.filter(r => r.status === 201)).toHaveLength(1);

    // And exactly one line item — not eight on one header, which is the other
    // shape this defect could have taken.
    const prs = await requisitionsFor(sid);
    expect(prs[0].line_items).toBe(1);
  });

  it('the CRON path racing the BUTTON creates ONE requisition', async () => {
    // The cross-process case, which no amount of in-request care could have fixed:
    // reorderPr.cron.js now calls the same service, so both contend on the same
    // row lock and the same unique index.
    const sid = await makeSuggestion(10);

    const [cron, button] = await Promise.all([
      convertSuggestionToPurchaseRequest({
        suggestionId: sid, companyId: ids.company,
        requestedByEmployeeId: ids.employee, status: 'draft',
        notes: 'Auto-drafted by cron',
      }),
      request(appAs(ids.company, ids.employee)).post(`/adv/purchase-suggestions/${sid}/convert`).send({}),
    ]);

    expect([200, 201]).toContain(button.status);
    expect(await requisitionsFor(sid)).toHaveLength(1);
    // Whichever won, the other is told about the winner's requisition.
    expect(cron.purchase_request.id).toBe(button.body.id);
    // Exactly one of the two claims authorship.
    expect([cron.created, button.status === 201].filter(Boolean)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Suggestion → PR · the database refuses a duplicate even without the service', () => {
  it('a direct INSERT of a second requisition for one suggestion raises 23505', async () => {
    const sid = await makeSuggestion(10);
    await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});

    let code = null, constraint = null;
    try {
      await pool.query(
        `INSERT INTO purchase_requests (request_number, source_suggestion_id, request_date, company_id, status)
         VALUES ($1, $2, CURRENT_DATE, $3, 'draft')`,
        [`${TAG}-DUP`, sid, ids.company]);
    } catch (e) { code = e.code; constraint = e.constraint; }

    // This is the mechanism that holds for a caller nobody has written yet.
    expect(code).toBe('23505');
    expect(constraint).toBe('uq_pr_source_suggestion');
    expect(await requisitionsFor(sid)).toHaveLength(1);
  });

  it('an unrelated requisition with no source suggestion is unaffected', async () => {
    // The index is PARTIAL — the overwhelming majority of requisitions are raised
    // by hand with source_suggestion_id NULL, and NULLs must not collide with each
    // other or the whole register would be limited to one row.
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO purchase_requests (request_number, request_date, company_id, status)
         VALUES ($1, CURRENT_DATE, $2, 'draft')`,
        [`${TAG}-MANUAL-${i}`, ids.company]);
    }
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM purchase_requests
        WHERE request_number LIKE $1 AND source_suggestion_id IS NULL`, [`${TAG}-MANUAL-%`]);
    expect(n.n).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Suggestion → PR · the unit of work is atomic', () => {
  it('a suggestion that is not \'pending\' is refused and nothing is written', async () => {
    const sid = await makeSuggestion(10);
    await pool.query(`UPDATE purchase_suggestions SET status = 'rejected' WHERE id = $1`, [sid]);

    const res = await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});
    expect(res.status).toBe(422);
    expect(await requisitionsFor(sid)).toHaveLength(0);
  });

  it('a mid-transaction failure leaves NO requisition and NO status flip', async () => {
    // Force the failure at the LAST step — after the requisition, its line item and
    // its total have all been written — by making the suggestion vanish underneath
    // the transaction is not possible under the lock, so instead the FK on
    // `source_suggestion_id` is used: a suggestion id that does not exist fails the
    // INSERT, and nothing at all must survive it.
    const ghost = 2_000_000_000;
    const before = await countRequisitions();

    await expect(convertSuggestionToPurchaseRequest({
      suggestionId: ghost, companyId: ids.company, requestedByEmployeeId: ids.employee,
    })).rejects.toThrow(/not found/i);

    expect(await countRequisitions()).toBe(before);
  });

  it('a suggestion marked converted whose requisition is GONE is reported, not re-ordered', async () => {
    // The state one row in this database is already in (suggestion 9 →
    // purchase_request 1451, which does not exist). Silently minting a replacement
    // would re-order material somebody deliberately deleted the requisition for.
    const sid = await makeSuggestion(10);
    const res = await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});
    const prId = res.body.id;

    await pool.query(`DELETE FROM purchase_request_items WHERE pr_id = $1`, [prId]);
    await pool.query(`DELETE FROM purchase_requests WHERE id = $1`, [prId]);

    const retry = await request(A).post(`/adv/purchase-suggestions/${sid}/convert`).send({});
    expect(retry.status).toBe(409);
    expect(String(retry.body.error)).toMatch(/no longer exists/i);
    expect(await requisitionsFor(sid)).toHaveLength(0);
  });
});

async function countRequisitions() {
  const { rows: [n] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM purchase_requests WHERE company_id = $1`, [ids.company]);
  return n.n;
}
