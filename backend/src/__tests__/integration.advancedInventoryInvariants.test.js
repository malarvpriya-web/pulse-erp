/**
 * integration.advancedInventoryInvariants.test.js
 *
 * The follow-up suite for the five residual risks left open by the first BATCH 01
 * pass. Everything here is driven against the REAL database and the REAL router.
 *
 * Each describe block corresponds to one risk that was previously documented as
 * "accepted" rather than fixed. The point of the suite is that the risks are now
 * closed by a MECHANISM — a NOT NULL, a trigger, a foreign key, a thrown error —
 * rather than by a convention someone has to remember.
 *
 *   1. `purchase_suggestions.converted_to_pr_id` had no FK and one dangling pointer
 *   2. `inventory_batches.company_id` was nullable and could disagree with its item
 *   3. Two dashboard implementations disagreed on what "reserved" means
 *   4. A forgotten `companyId` argument silently meant "every tenant"
 *   5. `/leave-accrual/expire` was unscoped, and its idempotency was only asserted
 *
 * ⚠ Risk 1's fix is a NOT VALID foreign key, which grandfathers exactly one
 * pre-existing row. The test below asserts BOTH halves: new dangling pointers are
 * refused, AND the grandfathered row is still readable. A test that only checked
 * the first half would pass just as happily if the migration had deleted history.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const { default: pool }          = await import('../config/db.js');
const { default: advRouter }     = await import('../modules/inventory/routes/advancedInventory.routes.js');
const { default: repo }          = await import('../modules/inventory/repositories/advancedInventory.repository.js');
const { default: accrualRouter } = await import('../modules/leaves/routes/accrual.routes.js');

const TAG = 'ZZINV2';

function appAs(companyId, employeeId = null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      userId: 1, id: 1, employee_id: employeeId, company_id: companyId,
      roles: ['admin', 'hr_manager'], role: 'hr_manager', permissions: ['*'],
    };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/adv', advRouter);
  app.use('/leave-accrual', accrualRouter);
  return app;
}

const ids = {
  companyA: null, companyB: null,
  itemA: null, itemB: null, whA: null, whB: null,
  employeeA: null, cfType: null,
};
let A;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;

  const ourItems = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const ourSug   = `(SELECT id FROM purchase_suggestions WHERE item_id IN ${ourItems})`;
  const ourEmps  = `(SELECT id FROM employees WHERE company_id = ANY($1))`;
  const ourTypes = `(SELECT id FROM leave_types WHERE company_id = ANY($1))`;

  await pool.query(`DELETE FROM purchase_request_items  WHERE pr_id IN (SELECT id FROM purchase_requests WHERE company_id = ANY($1) OR source_suggestion_id IN ${ourSug})`, [co]);
  await pool.query(`DELETE FROM purchase_requests       WHERE company_id = ANY($1) OR source_suggestion_id IN ${ourSug}`, [co]);
  await pool.query(`DELETE FROM purchase_suggestions    WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM stock_alerts            WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_allocations   WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_reservations  WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM stock_ledger            WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_batches       WHERE item_id IN ${ourItems}`, [co]);
  await pool.query(`DELETE FROM inventory_items         WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM warehouses              WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM leave_accrual_log        WHERE employee_id IN ${ourEmps} OR leave_type_id IN ${ourTypes}`, [co]);
  await pool.query(`DELETE FROM leave_balances           WHERE employee_id IN ${ourEmps} OR leave_type_id IN ${ourTypes}`, [co]);
  await pool.query(`DELETE FROM leave_types              WHERE company_id = ANY($1)`, [co]);

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

async function makeCompany(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co ${suffix}`, `${TAG}${suffix}`]);
  return rows[0].id;
}

beforeAll(async () => {
  await sweep();
  ids.companyA = await makeCompany('A');
  ids.companyB = await makeCompany('B');

  for (const [k, co] of [['itemA', ids.companyA], ['itemB', ids.companyB]]) {
    const { rows } = await pool.query(
      `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost)
       VALUES ($1, $2, $3, 'NOS', 10, 50) RETURNING id`,
      [`${TAG}-${k}`, `${TAG} ${k}`, co]);
    ids[k] = rows[0].id;
  }
  for (const [k, co] of [['whA', ids.companyA], ['whB', ids.companyB]]) {
    const { rows } = await pool.query(
      `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`,
      [`${TAG} ${k}`, co]);
    ids[k] = rows[0].id;
  }

  const { rows: [emp] } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status, joining_date)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Inv', $2, 'Active', '2020-01-01') RETURNING id`, [TAG, ids.companyA]);
  ids.employeeA = emp.id;

  const { rows: [cf] } = await pool.query(
    `INSERT INTO leave_types
       (leave_name, leave_code, company_id, accrual_type, carry_forward_allowed,
        max_carry_forward_days, carry_forward_expiry_months, is_active)
     VALUES ($1, $2, $3, 'manual', true, 10, 1, true) RETURNING id`,
    [`${TAG} CF`, `${TAG}CF`, ids.companyA]);
  ids.cfType = cf.id;

  A = appAs(ids.companyA, ids.employeeA);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// RISK 1 — the suggestion → requisition pointer now has a foreign key
// ═════════════════════════════════════════════════════════════════════════════
describe('Risk 1 · purchase_suggestions.converted_to_pr_id has a foreign key', () => {
  // §226: the two "history" assertions here were facts about the developer
  // database (NOT VALID; suggestion 9 -> PR 1451). Migration 20260926000013
  // promises a BRANCH — NOT VALID while a pre-existing pointer dangles, VALIDATED
  // when none did — and a fresh database correctly takes the second. Both
  // branches, and the byte-for-byte preservation of a grandfathered row, are
  // proven deterministically in migrationFixture.suggestionFk.integration.test.js.
  // What holds on EVERY database is asserted here.
  const dangling = async () => (await pool.query(`
    SELECT ps.id, ps.converted_to_pr_id, ps.status
      FROM purchase_suggestions ps
      LEFT JOIN purchase_requests pr ON pr.id = ps.converted_to_pr_id
     WHERE ps.converted_to_pr_id IS NOT NULL AND pr.id IS NULL`)).rows;

  it('the constraint exists, nulls on delete, and is NOT VALID only while a grandfathered pointer dangles', async () => {
    const { rows } = await pool.query(
      `SELECT convalidated, confdeltype, confrelid::regclass::text AS ref
         FROM pg_constraint WHERE conname = 'fk_suggestions_converted_pr'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ confdeltype: 'n', ref: 'purchase_requests' });
    const n = (await dangling()).length;
    if (rows[0].convalidated) {
      expect(n, 'a VALIDATED constraint cannot have dangling pointers').toBe(0);
    } else {
      // NOT VALID exists to grandfather history. With nothing left to
      // grandfather it should have been VALIDATED — say so rather than pass.
      expect(n, 'NOT VALID with no dangling pointer left: run VALIDATE CONSTRAINT fk_suggestions_converted_pr').toBeGreaterThan(0);
    }
  });

  it('refuses a NEW dangling pointer', async () => {
    const { rows: [sug] } = await pool.query(
      `INSERT INTO purchase_suggestions (item_id, warehouse_id, suggested_quantity, priority, status, generated_date)
       VALUES ($1, $2, 5, 'high', 'pending', CURRENT_DATE) RETURNING id`,
      [ids.itemA, ids.whA]);

    let code = null, constraint = null;
    try {
      await pool.query(
        `UPDATE purchase_suggestions SET converted_to_pr_id = 2000000001, status = 'converted_to_pr' WHERE id = $1`,
        [sug.id]);
    } catch (e) { code = e.code; constraint = e.constraint; }

    expect(code).toBe('23503');                              // foreign_key_violation
    expect(constraint).toBe('fk_suggestions_converted_pr');

    // And the row is untouched, not half-updated.
    const { rows: [after] } = await pool.query(
      `SELECT status, converted_to_pr_id FROM purchase_suggestions WHERE id = $1`, [sug.id]);
    expect(after.status).toBe('pending');
    expect(after.converted_to_pr_id).toBeNull();
  });

  it('does NOT cascade-delete a suggestion when its requisition is deleted', async () => {
    // ON DELETE SET NULL, deliberately: deleting a requisition must not destroy the
    // reorder signal that produced it.
    const { rows: [sug] } = await pool.query(
      `INSERT INTO purchase_suggestions (item_id, warehouse_id, suggested_quantity, priority, status, generated_date)
       VALUES ($1, $2, 7, 'high', 'pending', CURRENT_DATE) RETURNING id`,
      [ids.itemA, ids.whA]);
    const res = await request(A).post(`/adv/purchase-suggestions/${sug.id}/convert`).send({});
    expect(res.status).toBe(201);
    const prId = res.body.id;

    await pool.query(`DELETE FROM purchase_request_items WHERE pr_id = $1`, [prId]);
    await pool.query(`DELETE FROM purchase_requests WHERE id = $1`, [prId]);

    const { rows: [after] } = await pool.query(
      `SELECT id, converted_to_pr_id FROM purchase_suggestions WHERE id = $1`, [sug.id]);
    expect(after).toBeTruthy();                   // the suggestion survives
    expect(after.converted_to_pr_id).toBeNull();  // the pointer was nulled, not dangled
  });

  it('every dangling pointer is a grandfathered conversion, never a new write', async () => {
    // A grandfathered row records that a suggestion WAS converted; the FK refuses
    // any new dangling write (see "refuses a NEW dangling pointer" above), and an
    // UPDATE of a grandfathered row is checked too — so whatever dangles must
    // still be in the state it was grandfathered in.
    const rows = await dangling();
    expect(rows.filter((r) => r.status !== 'converted_to_pr')).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RISK 2 — a batch's tenant cannot be absent, and cannot disagree with its item
// ═════════════════════════════════════════════════════════════════════════════
describe('Risk 2 · inventory_batches.company_id is NOT NULL and matches its item', () => {
  it('the column is NOT NULL and the guard trigger is installed', async () => {
    const { rows: [col] } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'inventory_batches' AND column_name = 'company_id'`);
    expect(col.is_nullable).toBe('NO');

    const { rows: trg } = await pool.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'inventory_batches'::regclass AND NOT tgisinternal`);
    expect(trg.map(t => t.tgname)).toContain('trg_inventory_batches_tenant_guard');
  });

  it('FILLS company_id from the item when a writer omits it', async () => {
    // No caller breaks by omission, and a lot can never be born tenant-less however
    // it is written — including from psql or a fixture.
    const { rows: [b] } = await pool.query(
      `INSERT INTO inventory_batches
         (item_id, warehouse_id, batch_number, received_date, quantity_received, quantity_available, rate, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 10, 10, 5, 'active') RETURNING id, company_id`,
      [ids.itemA, ids.whA, `${TAG}-FILL`]);
    expect(b.company_id).toBe(ids.companyA);
  });

  it('RAISES when a writer supplies a company that disagrees with the item', async () => {
    // Loud, not silently corrected: a mismatched company IS a tenant bug, and
    // overwriting it would hide exactly the class of defect this batch closed.
    let code = null;
    try {
      await pool.query(
        `INSERT INTO inventory_batches
           (item_id, warehouse_id, batch_number, received_date, quantity_received, quantity_available, rate, status, company_id)
         VALUES ($1, $2, $3, CURRENT_DATE, 10, 10, 5, 'active', $4)`,
        [ids.itemA, ids.whA, `${TAG}-BAD`, ids.companyB]);
    } catch (e) { code = e.code; }
    expect(code).toBe('23514');        // check_violation, raised by the trigger
  });

  it('RAISES on an UPDATE that would move a lot to another tenant', async () => {
    const { rows: [b] } = await pool.query(
      `INSERT INTO inventory_batches
         (item_id, warehouse_id, batch_number, received_date, quantity_received, quantity_available, rate, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 10, 10, 5, 'active') RETURNING id`,
      [ids.itemA, ids.whA, `${TAG}-MOVE`]);

    let code = null;
    try {
      await pool.query(`UPDATE inventory_batches SET company_id = $1 WHERE id = $2`, [ids.companyB, b.id]);
    } catch (e) { code = e.code; }
    expect(code).toBe('23514');

    const { rows: [after] } = await pool.query(
      `SELECT company_id FROM inventory_batches WHERE id = $1`, [b.id]);
    expect(after.company_id).toBe(ids.companyA);   // unmoved
  });

  it('the live POST /batches path still works with the trigger in place', async () => {
    // Paired positive. A guard that breaks the only write path is not an
    // improvement, and this route does NOT pass company_id — it relies on the fill.
    const res = await request(A).post('/adv/batches').send({
      item_id: ids.itemA, warehouse_id: ids.whA,
      batch_number: `${TAG}-ROUTE`, quantity_received: 12, rate: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.company_id).toBe(ids.companyA);
  });

  it('no live row disagrees with its item', async () => {
    const { rows } = await pool.query(`
      SELECT ib.id FROM inventory_batches ib
        JOIN inventory_items ii ON ii.id = ib.item_id
       WHERE ib.company_id IS DISTINCT FROM ii.company_id`);
    expect(rows).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RISK 3 — one dashboard implementation, and it reads the column that is written
// ═════════════════════════════════════════════════════════════════════════════
describe('Risk 3 · the dashboard has one implementation', () => {
  it('GET /dashboard and repo.getDashboardMetrics() return the same numbers', async () => {
    // They used to be two implementations that disagreed. If this ever diverges
    // again, one of them has stopped delegating.
    const viaHttp = await request(A).get('/adv/dashboard');
    const viaRepo = await repo.getDashboardMetrics(ids.companyA);
    expect(viaHttp.status).toBe(200);
    expect(viaHttp.body).toEqual(viaRepo);
  });

  it('derives reserved value from the reservation rows, not from quantity_reserved', async () => {
    // ⚠ `inventory_batches.quantity_reserved` has NO writers in this codebase, so
    // the old implementation's reserved value was structurally always zero. This
    // asserts the number moves with the RESERVATIONS.
    const before = (await repo.getDashboardMetrics(ids.companyA)).total_reserved_value;

    await pool.query(
      `INSERT INTO stock_ledger
         (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate, transaction_date, company_id)
       VALUES ($1, $2, 'receipt', 100, 0, 5, CURRENT_DATE, $3)`,
      [ids.itemA, ids.whA, ids.companyA]);

    const res = await request(A).post('/adv/reservations').send({
      item_id: ids.itemA, warehouse_id: ids.whA, quantity_reserved: 4,
      reservation_type: 'project', reference_type: 'project', reserved_date: '2026-09-26',
    });
    expect(res.status).toBe(201);

    const after = (await repo.getDashboardMetrics(ids.companyA)).total_reserved_value;
    // 4 units x standard_cost 50 = 200.
    expect(after - before).toBeCloseTo(200, 2);

    // And it is NOT reading the dead column: setting it must change nothing.
    // (The trigger only guards company_id/item_id, so this UPDATE is allowed.)
    await pool.query(
      `UPDATE inventory_batches SET quantity_reserved = 99 WHERE item_id = $1`, [ids.itemA]);
    const afterPoison = (await repo.getDashboardMetrics(ids.companyA)).total_reserved_value;
    expect(afterPoison).toBeCloseTo(after, 2);
    await pool.query(
      `UPDATE inventory_batches SET quantity_reserved = 0 WHERE item_id = $1`, [ids.itemA]);
  });

  it('low_stock_alerts counts ONLY low-stock alerts, with the total kept separately', async () => {
    // The inline version labelled the tile `low_stock_alerts` and counted every
    // active alert, so one expiring-batch alert inflated the "low stock" number.
    await pool.query(
      `INSERT INTO stock_alerts (item_id, warehouse_id, alert_type, status, alert_date)
       VALUES ($1, $2, 'low_stock', 'active', CURRENT_DATE),
              ($1, $2, 'expiring_soon', 'active', CURRENT_DATE)`,
      [ids.itemA, ids.whA]);

    const m = await repo.getDashboardMetrics(ids.companyA);
    expect(m.low_stock_alerts).toBe(1);
    expect(m.active_alerts).toBe(2);
  });

  it('is scoped — company B\'s figures are not in company A\'s tiles', async () => {
    await pool.query(
      `INSERT INTO stock_alerts (item_id, warehouse_id, alert_type, status, alert_date)
       VALUES ($1, $2, 'low_stock', 'active', CURRENT_DATE)`,
      [ids.itemB, ids.whB]);

    const a = await repo.getDashboardMetrics(ids.companyA);
    const b = await repo.getDashboardMetrics(ids.companyB);
    expect(a.low_stock_alerts).toBe(1);
    expect(b.low_stock_alerts).toBe(1);

    const { rows: [global] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_alerts WHERE status = 'active' AND alert_type = 'low_stock'`);
    expect(a.low_stock_alerts).toBeLessThan(global.n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RISK 4 — a forgotten company scope throws instead of reading every tenant
// ═════════════════════════════════════════════════════════════════════════════
describe('Risk 4 · omitting the company scope is an error, not a silent widening', () => {
  // Every one of these is a repository function whose `companyId` used to default
  // to null — which in `($n IS NULL OR company_id = $n)` means "no filter".
  const omitted = [
    ['getBatches',                     () => repo.getBatches({})],
    ['getAllocations',                 () => repo.getAllocations({})],
    ['getStockAlerts',                 () => repo.getStockAlerts({})],
    ['getPurchaseSuggestions',         () => repo.getPurchaseSuggestions({})],
    ['getReservations',                () => repo.getReservations({})],
    ['getStockSummary',                () => repo.getStockSummary({})],
    ['getStockAgingReport',            () => repo.getStockAgingReport(null)],
    ['getMaterialConsumptionByProject',() => repo.getMaterialConsumptionByProject(null)],
    ['getDashboardMetrics',            () => repo.getDashboardMetrics()],
    ['getReservedVsAvailableStock',    () => repo.getReservedVsAvailableStock(null)],
    ['cancelReservation',              () => repo.cancelReservation(1)],
    ['acknowledgeAlert',               () => repo.acknowledgeAlert(1, 1)],
    ['resolveAlert',                   () => repo.resolveAlert(1, 1)],
    ['rejectSuggestion',               () => repo.rejectSuggestion(1, 1, 'x')],
    ['updateBatchQuantity',            () => repo.updateBatchQuantity(1, 1, 'consume')],
    ['consumeReservation',             () => repo.consumeReservation(1, 1)],
    ['getAvailableStock',              () => repo.getAvailableStock(1, 1)],
  ];

  for (const [name, call] of omitted) {
    it(`${name}() throws when the company scope is omitted`, async () => {
      await expect(call()).rejects.toThrow(/without a company scope/i);
    });
  }

  it('an EXPLICIT null is still allowed — a global scope is a real thing', async () => {
    // A super admin with no company assignment: companyOf(req) legitimately returns
    // null, and that must keep working. This is the paired positive without which
    // the tests above would pass for a version that simply broke global admins.
    const all = await repo.getBatches({ company_id: null });
    expect(Array.isArray(all)).toBe(true);

    const mine = await repo.getBatches({ company_id: ids.companyA });
    // Global genuinely sees more than one tenant's worth.
    expect(all.length).toBeGreaterThan(mine.length);
  });

  it('a normal route call is unaffected', async () => {
    // companyOf(req) returns an int or null, never undefined, so no correct caller
    // trips the guard.
    const res = await request(A).get('/adv/batches');
    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RISK 5 — /leave-accrual/expire is scoped, and idempotent by construction
// ═════════════════════════════════════════════════════════════════════════════
describe('Risk 5 · POST /leave-accrual/expire is tenant-scoped and idempotent', () => {
  it('expires only the caller\'s company and leaves company B alone', async () => {
    // ⚠ This UPDATE had NO company predicate: one HR user's click debited EVERY
    // company's carried-forward days.
    const { rows: [empB] } = await pool.query(
      `INSERT INTO employees (office_id, first_name, last_name, company_id, status, joining_date)
       VALUES (${FIXTURE_CODE_SQL}, $1, 'B', $2, 'Active', '2020-01-01') RETURNING id`, [TAG, ids.companyB]);

    // Same leave type for both, so only the employee's company separates them.
    for (const emp of [ids.employeeA, empB.id]) {
      await pool.query(
        `INSERT INTO leave_balances
           (employee_id, leave_type_id, year, allocated_days, carried_forward_days, opening_balance, used_days)
         VALUES ($1, $2, $3, 10, 10, 10, 0)`,
        [emp, ids.cfType, new Date().getFullYear()]);
    }

    const res = await request(A).post('/leave-accrual/expire').send({});
    expect(res.status).toBe(200);

    const cf = async (emp) => {
      const { rows } = await pool.query(
        `SELECT carried_forward_days::float AS c, allocated_days::float AS a
           FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
        [emp, ids.cfType, new Date().getFullYear()]);
      return rows[0];
    };

    // Company A's expired...
    expect((await cf(ids.employeeA)).c).toBeCloseTo(0, 4);
    expect((await cf(ids.employeeA)).a).toBeCloseTo(0, 4);
    // ...and company B's did NOT.
    expect((await cf(empB.id)).c).toBeCloseTo(10, 4);
    expect((await cf(empB.id)).a).toBeCloseTo(10, 4);
  });

  it('a second expire run is a no-op', async () => {
    // Naturally idempotent rather than log-gated: `carried_forward_days = 0` means
    // the `carried_forward_days > 0` predicate cannot match twice. Asserted rather
    // than assumed, because "naturally idempotent" is a claim about the predicate
    // and predicates get edited.
    const year = new Date().getFullYear();
    await pool.query(
      `INSERT INTO leave_balances
         (employee_id, leave_type_id, year, allocated_days, carried_forward_days, opening_balance, used_days)
       VALUES ($1, $2, $3, 6, 6, 6, 0)
       ON CONFLICT (employee_id, leave_type_id, year)
       DO UPDATE SET allocated_days = 6, carried_forward_days = 6`,
      [ids.employeeA, ids.cfType, year]);

    const first = await request(A).post('/leave-accrual/expire').send({});
    expect(first.body.records_expired).toBeGreaterThanOrEqual(1);

    const second = await request(A).post('/leave-accrual/expire').send({});
    expect(second.body.records_expired).toBe(0);

    const { rows: [after] } = await pool.query(
      `SELECT allocated_days::float AS a FROM leave_balances
        WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
      [ids.employeeA, ids.cfType, year]);
    // 6 - 6 = 0, and not -6 from a second debit.
    expect(after.a).toBeCloseTo(0, 4);
  });
});
