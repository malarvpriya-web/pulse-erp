/**
 * Traceability spine — inventory audit P0 findings 6, 7.1, 15.1 and 33.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The two existing genealogy suites (37 tests) passed unchanged after the ledger
 * write path was restructured, because NEITHER asserts anything about
 * stock_ledger content — both mention the table only to delete from it in
 * teardown. A green suite that cannot observe the thing it is protecting is not
 * evidence, and that blind spot is why stock_ledger.batch_id could read 100%
 * NULL in production while every test passed.
 *
 * So these tests assert on the ledger row itself, and on the two constraints
 * that now enforce at the database what the application merely hoped for.
 *
 * Each guard here was mutation-tested while being written: the constraint was
 * dropped, or the guard removed, and the specific test that should fail did.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try { envText = readFileSync(resolve(here, '../../.env'), 'utf8'); }
  catch { envText = readFileSync(resolve(here, '../.env'), 'utf8'); }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (dbPassword) process.env.DB_PASSWORD = dbPassword;
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test_jwt_secret_for_pulse_enterprise_audit_2026';
}

const { default: pool } = await import('../config/db.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { buildApp } = await import('./helpers/testApp.js');
const { makeToken } = await import('./helpers/tokens.js');
const { default: executionRoutes } = await import('../modules/production/execution.routes.js');
const { default: advancedInventoryRepo } = await import('../modules/inventory/repositories/advancedInventory.repository.js');

const { default: genealogyRoutes } = await import('../modules/production/genealogy.routes.js');

const app = buildApp(
  ['/api/production', verifyToken, executionRoutes],
  ['/api/genealogy', verifyToken, genealogyRoutes],
);

const TAG = `ZZTSP_${Date.now()}`;
const S = TAG.slice(-5);
let COMPANY_ID, USER_ID, EMPLOYEE_ID, WAREHOUSE_ID, ORDER_ID, OTHER_ORDER_ID;
let PANEL_SERIAL, COMPONENT_ITEM_ID, COMPONENT_SERIAL;

const created = {
  reservations: [], batches: [], serials: [], orders: [],
  items: [], warehouses: [], users: [], employees: [], companies: [],
};

const auth = () => `Bearer ${makeToken({
  userId: USER_ID, employee_id: EMPLOYEE_ID, company_id: COMPANY_ID, roles: ['admin'],
})}`;

// current_stock is DERIVED from stock_ledger by trigger. Seeding a literal
// opening balance drifts from the ledger and trips integration.supplyChain's
// on-hand invariant, which scans EVERY item in the database, not only its own.
const mkItem = async (label, cost = 10.0) => {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost)
     VALUES ($1,$2,$3,0,$4) RETURNING id`,
    [COMPANY_ID, `${label}_${S}_${created.items.length}`, `Part ${label}`, cost]);
  created.items.push(i.id);
  return i.id;
};

// Lot selection draws from every available lot of an item, so a suite that
// shares one item across tests inherits its own leftovers and the assertions
// become run-order dependent. Every test here owns a fresh item.
const mkReservation = async (orderId, itemId, required = 100) => {
  const { rows: [nm] } = await pool.query('SELECT item_name FROM inventory_items WHERE id=$1', [itemId]);
  const { rows: [r] } = await pool.query(
    `INSERT INTO material_reservations
       (company_id, production_order_id, item_id, item_name, unit, qty_required, qty_reserved, status)
     VALUES ($1,$2,$3,$4,'Nos',$5,$5,'reserved') RETURNING id`,
    [COMPANY_ID, orderId, itemId, nm.item_name, required]);
  created.reservations.push(r.id);
  return r.id;
};

const mkBatch = async (item, qty = 50, label = 'LOT') => {
  const { rows: [b] } = await pool.query(
    `INSERT INTO inventory_batches
       (company_id, item_id, warehouse_id, batch_number, quantity_received, quantity_available, status, rate)
     VALUES ($1,$2,$3,$4,$5,$5,'active',10) RETURNING id`,
    [COMPANY_ID, item, WAREHOUSE_ID, `${label}_${S}_${created.batches.length}`, qty]);
  created.batches.push(b.id);
  return b.id;
};

const mkSerial = async (label, orderId, itemId) => {
  const { rows: [s] } = await pool.query(
    `INSERT INTO serial_numbers (company_id, serial_number, item_id, production_order_id, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id, serial_number`,
    [COMPANY_ID, `SN_${label}_${S}`, itemId, orderId]);
  created.serials.push(s.id);
  return s;
};

const issue = (orderId, body) =>
  request(app).post(`/api/production/orders/${orderId}/issue-material`).set('Authorization', auth()).send(body);

const ledgerFor = async (itemId) => (await pool.query(
  `SELECT * FROM stock_ledger WHERE item_id = $1 ORDER BY id`, [itemId])).rows;

describe('Traceability spine — ledger lot identity and installation integrity', () => {
  beforeAll(async () => {
    const { rows: [c] } = await pool.query(
      'INSERT INTO companies (name, code, is_active) VALUES ($1,$2,true) RETURNING id',
      [`TSP Co ${TAG}`, `TSP_${S}`]);
    COMPANY_ID = c.id; created.companies.push(COMPANY_ID);

    const { rows: [e] } = await pool.query(
      `INSERT INTO employees (office_id, company_id, first_name, last_name, company_email)
       VALUES (${FIXTURE_CODE_SQL}, $1,'Spine','Operator',$2) RETURNING id`,
      [COMPANY_ID, `spine_${TAG}@pulse.test`]);
    EMPLOYEE_ID = e.id; created.employees.push(EMPLOYEE_ID);

    const { rows: [u] } = await pool.query(
      `INSERT INTO users (email, password_hash, role, company_id, name, employee_id, is_active)
       VALUES ($1,'x','admin',$2,'Spine Operator',$3,true) RETURNING id`,
      [`spine_${TAG}@pulse.test`, COMPANY_ID, EMPLOYEE_ID]);
    USER_ID = u.id; created.users.push(USER_ID);
    await pool.query('INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)', [USER_ID, COMPANY_ID]);
    const { rows: [role] } = await pool.query("SELECT id FROM roles WHERE LOWER(code)='admin' LIMIT 1");
    if (role) await pool.query('INSERT INTO user_roles (user_id, role_id, is_primary) VALUES ($1,$2,true)', [USER_ID, role.id]);

    const { rows: [w] } = await pool.query(
      'INSERT INTO warehouses (name, warehouse_code, company_id) VALUES ($1,$2,$3) RETURNING id',
      [`TSP WH ${TAG}`, `TW_${S}`, COMPANY_ID]);
    WAREHOUSE_ID = w.id; created.warehouses.push(WAREHOUSE_ID);

    const mkOrder = async (no, qty) => {
      const { rows: [o] } = await pool.query(
        `INSERT INTO production_orders (company_id, production_order_no, product_name, quantity_planned, status)
         VALUES ($1,$2,'Control Panel',$3,'in_progress') RETURNING id`, [COMPANY_ID, no, qty]);
      created.orders.push(o.id);
      return o.id;
    };
    ORDER_ID = await mkOrder(`WO_TSP_${S}`, 1);
    OTHER_ORDER_ID = await mkOrder(`WO_TSP2_${S}`, 1);

    PANEL_SERIAL = await mkSerial('PANEL', ORDER_ID, await mkItem('PANEL'));
    // A purchased serialised component carries no production order of its own —
    // giving it one would make the order look like a two-unit build.
    COMPONENT_ITEM_ID = await mkItem('COMP', 25.0);
    COMPONENT_SERIAL = await mkSerial('COMP', null, COMPONENT_ITEM_ID);
  });

  afterAll(async () => {
    try {
      if (created.orders.length) {
        await pool.query('DELETE FROM production_order_bom_lines WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM rework_records WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM material_issue_logs WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM wip_transactions WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM production_order_costs WHERE production_order_id = ANY($1)', [created.orders]);
      }
      if (created.reservations.length) {
        await pool.query('DELETE FROM material_issue_logs WHERE reservation_id = ANY($1)', [created.reservations]);
        await pool.query('DELETE FROM material_reservations WHERE id = ANY($1)', [created.reservations]);
      }
      if (created.items.length) {
        await pool.query('DELETE FROM inventory_fifo_consumption WHERE item_id = ANY($1)', [created.items]);
        await pool.query('DELETE FROM inventory_fifo_layers WHERE item_id = ANY($1)', [created.items]);
        await pool.query('DELETE FROM stock_ledger WHERE item_id = ANY($1)', [created.items]);
      }
      if (created.serials.length) await pool.query('DELETE FROM serial_numbers WHERE id = ANY($1)', [created.serials]);
      if (created.orders.length) await pool.query('DELETE FROM production_orders WHERE id = ANY($1)', [created.orders]);
      if (created.batches.length) await pool.query('DELETE FROM inventory_batches WHERE id = ANY($1)', [created.batches]);
      if (created.items.length) await pool.query('DELETE FROM inventory_items WHERE id = ANY($1)', [created.items]);
      await pool.query(`DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM bom_headers WHERE product_code = $1)`, [`BOMP_${S}`]);
      await pool.query('DELETE FROM bom_headers WHERE product_code = $1', [`BOMP_${S}`]);
      if (created.warehouses.length) await pool.query('DELETE FROM warehouses WHERE id = ANY($1)', [created.warehouses]);
      if (created.users.length) {
        await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [created.users]);
        await pool.query('DELETE FROM user_scope WHERE user_id = ANY($1)', [created.users]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
      }
      if (created.employees.length) await pool.query('DELETE FROM employees WHERE id = ANY($1)', [created.employees]);
      if (created.companies.length) await pool.query('DELETE FROM companies WHERE id = ANY($1)', [created.companies]);
    } catch (err) { console.error('Teardown error:', err); }
  });

  /* ── finding 6: the ledger carries lot, unit and demand ──────────────────── */

  describe('stock_ledger records WHICH lot moved', () => {
    it('stamps the issued lot, the order and the source store on the ledger row', async () => {
      const item = await mkItem('LEDGER');
      const batch = await mkBatch(item, 40, 'LEDLOT');
      const rsv = await mkReservation(ORDER_ID, item);

      const res = await issue(ORDER_ID, { reservation_id: rsv, qty_issued: 10, batch_id: batch });
      expect(res.status).toBe(200);

      const rows = await ledgerFor(item);
      expect(rows).toHaveLength(1);
      // The whole point of the finding: before this, batch_id was structurally
      // unreachable here because the ledger was written before lot selection ran.
      expect(String(rows[0].batch_id)).toBe(String(batch));
      expect(String(rows[0].production_order_id)).toBe(String(ORDER_ID));
      expect(Number(rows[0].quantity_out)).toBe(10);
      expect(rows[0].reason_code).toBe('production_issue');
      // An issue leaves a store; it does not arrive at one.
      expect(rows[0].from_warehouse_id).not.toBeNull();
      expect(rows[0].to_warehouse_id).toBeNull();
    });

    it('writes one ledger row per lot, reconciling line-for-line with the issue log', async () => {
      const item = await mkItem('SPLIT');
      await mkBatch(item, 6, 'SPLITA');
      await mkBatch(item, 9, 'SPLITB');
      const rsv = await mkReservation(ORDER_ID, item);

      const res = await issue(ORDER_ID, { reservation_id: rsv, qty_issued: 12 });
      expect(res.status).toBe(200);

      const ledger = await ledgerFor(item);
      const { rows: logs } = await pool.query(
        'SELECT batch_id, qty_issued FROM material_issue_logs WHERE reservation_id=$1 ORDER BY id', [rsv]);

      // Two lots drawn => two issue logs => two ledger rows. A single averaged
      // ledger row would match neither lot and destroy the reconciliation.
      expect(logs.length).toBe(2);
      expect(ledger.length).toBe(2);
      expect(ledger.map(r => String(r.batch_id)).sort())
        .toEqual(logs.map(l => String(l.batch_id)).sort());
      expect(ledger.reduce((t, r) => t + Number(r.quantity_out), 0)).toBe(12);
    });

    it('stamps the unit built when the issue names one', async () => {
      const item = await mkItem('UNIT');
      await mkBatch(item, 20, 'UNITLOT');
      const rsv = await mkReservation(ORDER_ID, item);

      const res = await issue(ORDER_ID, {
        reservation_id: rsv, qty_issued: 5, serial_number: PANEL_SERIAL.serial_number,
      });
      expect(res.status).toBe(200);

      const rows = await ledgerFor(item);
      expect(String(rows[0].serial_id)).toBe(String(PANEL_SERIAL.id));
    });

    it('leaves batch_id NULL — not guessed — when no lot can cover the issue', async () => {
      const item = await mkItem('NOLOT');
      const rsv = await mkReservation(ORDER_ID, item);

      const res = await issue(ORDER_ID, { reservation_id: rsv, qty_issued: 7 });
      expect(res.status).toBe(200);

      const rows = await ledgerFor(item);
      expect(rows).toHaveLength(1);
      // NULL honestly reads "lot unknown". Attributing it to an arbitrary lot
      // would be indistinguishable from a real trace afterwards.
      expect(rows[0].batch_id).toBeNull();
      expect(Number(rows[0].quantity_out)).toBe(7);
    });
  });

  /* ── finding 15.1: one serialised unit, one panel ────────────────────────── */

  describe('a serialised component cannot be installed into two panels', () => {
    it('refuses the second installation with a message naming where the part already is', async () => {
      // The lot has to cover every reservation this block makes against it.
      // Sized at 10 it was over-committed three times over, and the issue-time
      // reservation guard correctly refused the re-fit — a fixture fault that
      // read as a code failure.
      const rsvA = await mkReservation(ORDER_ID, COMPONENT_ITEM_ID, 10);
      await mkBatch(COMPONENT_ITEM_ID, 60, 'COMPLOT');

      const first = await issue(ORDER_ID, {
        reservation_id: rsvA, qty_issued: 1,
        component_serial_number: COMPONENT_SERIAL.serial_number,
      });
      expect(first.status).toBe(200);

      const rsvB = await mkReservation(OTHER_ORDER_ID, COMPONENT_ITEM_ID, 10);
      const second = await issue(OTHER_ORDER_ID, {
        reservation_id: rsvB, qty_issued: 1,
        component_serial_number: COMPONENT_SERIAL.serial_number,
      });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('COMPONENT_SERIAL_ALREADY_INSTALLED');
      expect(second.body.error).toMatch(/already installed/i);
      expect(String(second.body.installed_in_production_order_id)).toBe(String(ORDER_ID));
    });

    it('allows the unit to be re-fitted once a rework removal is recorded', async () => {
      // The reversal STAMPS the original row; it never deletes or overwrites it,
      // so the original installation stays in the genealogy for good.
      const { rows: [live] } = await pool.query(
        `SELECT id FROM material_issue_logs
          WHERE component_serial_id=$1 AND reversed_at IS NULL LIMIT 1`, [COMPONENT_SERIAL.id]);
      expect(live).toBeTruthy();

      await pool.query(
        `UPDATE material_issue_logs SET reversed_at=NOW(), reversal_reason='failed FAT — replaced'
          WHERE id=$1`, [live.id]);

      const rsv = await mkReservation(OTHER_ORDER_ID, COMPONENT_ITEM_ID, 10);
      const refit = await issue(OTHER_ORDER_ID, {
        reservation_id: rsv, qty_issued: 1,
        component_serial_number: COMPONENT_SERIAL.serial_number,
      });
      expect(refit.status).toBe(200);

      // History accumulates rather than being replaced.
      const { rows: all } = await pool.query(
        'SELECT reversed_at FROM material_issue_logs WHERE component_serial_id=$1', [COMPONENT_SERIAL.id]);
      expect(all.length).toBe(2);
      expect(all.filter(r => r.reversed_at === null)).toHaveLength(1);
    });

    it('is enforced by the database, not only by the route', async () => {
      // The application guard can be bypassed — by a script, a fixture, another
      // service. The constraint is the guarantee that actually holds.
      await expect(pool.query(
        `INSERT INTO material_issue_logs
           (company_id, production_order_id, item_id, item_name, qty_issued, component_serial_id)
         VALUES ($1,$2,$3,'direct-insert',1,$4)`,
        [COMPANY_ID, ORDER_ID, COMPONENT_ITEM_ID, COMPONENT_SERIAL.id]
      )).rejects.toMatchObject({ code: '23505' });
    });
  });

  /* ── finding 33: integrity rules enforced at the database ────────────────── */

  describe('lot integrity constraints', () => {
    it('refuses a duplicate batch number within the same company and item', async () => {
      const item = await mkItem('DUP');
      const num = `DUPLOT_${S}`;
      const ins = () => pool.query(
        `INSERT INTO inventory_batches
           (company_id, item_id, warehouse_id, batch_number, quantity_received, quantity_available, status, rate)
         VALUES ($1,$2,$3,$4,5,5,'active',1) RETURNING id`,
        [COMPANY_ID, item, WAREHOUSE_ID, num]);

      const { rows: [ok] } = await ins();
      created.batches.push(ok.id);
      await expect(ins()).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses a negative available quantity on a lot', async () => {
      const item = await mkItem('NEG');
      await expect(pool.query(
        `INSERT INTO inventory_batches
           (company_id, item_id, warehouse_id, batch_number, quantity_received, quantity_available, status, rate)
         VALUES ($1,$2,$3,$4,5,-1,'active',1)`,
        [COMPANY_ID, item, WAREHOUSE_ID, `NEGLOT_${S}`]
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  /* ── finding 17: rework is recorded, and never overwrites history ────────── */

  describe('rework records a removal without destroying the original assembly', () => {
    let reworkItem, reworkBatch, replacementBatch, originalLogId, reworkId;

    it('records the removal, stamps the original installation and leaves it intact', async () => {
      reworkItem = await mkItem('RWK', 30);
      reworkBatch = await mkBatch(reworkItem, 20, 'RWKLOT');
      const rsv = await mkReservation(ORDER_ID, reworkItem, 20);

      const fit = await issue(ORDER_ID, {
        reservation_id: rsv, qty_issued: 2, batch_id: reworkBatch,
        serial_number: PANEL_SERIAL.serial_number,
      });
      expect(fit.status).toBe(200);

      const { rows: [log] } = await pool.query(
        'SELECT id, qty_issued, batch_id FROM material_issue_logs WHERE reservation_id=$1', [rsv]);
      originalLogId = log.id;

      const res = await request(app)
        .post(`/api/production/orders/${ORDER_ID}/rework`)
        .set('Authorization', auth())
        .send({
          issue_log_id: originalLogId,
          reason: 'Coil failed insulation resistance test at FAT',
          defect_code: 'IR-FAIL',
          disposition: 'scrap',
        });

      expect(res.status).toBe(201);
      expect(res.body.rework.status).toBe('removed');
      expect(res.body.rework.reason).toMatch(/insulation/i);
      reworkId = res.body.rework.id;

      // The original row is STAMPED, not edited or deleted: the quantity and the
      // lot it recorded are still exactly what was originally installed.
      const { rows: [after] } = await pool.query(
        'SELECT qty_issued, batch_id, reversed_at, reversal_reason FROM material_issue_logs WHERE id=$1',
        [originalLogId]);
      expect(Number(after.qty_issued)).toBe(Number(log.qty_issued));
      expect(String(after.batch_id)).toBe(String(log.batch_id));
      expect(after.reversed_at).not.toBeNull();
      expect(after.reversal_reason).toMatch(/insulation/i);
    });

    it('refuses to rework the same installation twice', async () => {
      const res = await request(app)
        .post(`/api/production/orders/${ORDER_ID}/rework`)
        .set('Authorization', auth())
        .send({ issue_log_id: originalLogId, reason: 'duplicate attempt' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALREADY_REVERSED');
    });

    it('refuses a rework with no stated reason', async () => {
      const rsv = await mkReservation(ORDER_ID, reworkItem, 5);
      const fit = await issue(ORDER_ID, { reservation_id: rsv, qty_issued: 1, batch_id: reworkBatch });
      expect(fit.status).toBe(200);
      const { rows: [log] } = await pool.query(
        'SELECT id FROM material_issue_logs WHERE reservation_id=$1', [rsv]);

      const res = await request(app)
        .post(`/api/production/orders/${ORDER_ID}/rework`)
        .set('Authorization', auth())
        .send({ issue_log_id: log.id, reason: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reason is required/i);
    });

    it('does NOT return scrapped material to available stock', async () => {
      // A scrap, RTV or re-quarantine disposition must not restore stock — that
      // is how rejected material finds its way back to the shop floor.
      const { rows: [b] } = await pool.query(
        'SELECT quantity_available FROM inventory_batches WHERE id=$1', [reworkBatch]);
      // 20 received, 2 fitted + 1 fitted in the previous test = 17 remaining,
      // and the scrapped 2 were NOT added back.
      expect(Number(b.quantity_available)).toBe(17);
    });

    it('fits a replacement and records both sides of the swap', async () => {
      replacementBatch = await mkBatch(reworkItem, 10, 'RWKNEW');
      const rsv = await mkReservation(ORDER_ID, reworkItem, 10);
      const fit = await issue(ORDER_ID, {
        reservation_id: rsv, qty_issued: 2, batch_id: replacementBatch,
        serial_number: PANEL_SERIAL.serial_number,
      });
      expect(fit.status).toBe(200);
      const { rows: [log] } = await pool.query(
        'SELECT id FROM material_issue_logs WHERE reservation_id=$1', [rsv]);

      const res = await request(app)
        .post(`/api/production/orders/${ORDER_ID}/rework`)
        .set('Authorization', auth())
        .send({
          issue_log_id: log.id,
          reason: 'Wrong variant fitted — 110V instead of 24V',
          disposition: 'reuse',
          replacement_batch_id: reworkBatch,
        });

      expect(res.status).toBe(201);
      expect(res.body.rework.status).toBe('replaced');
      expect(res.body.replacement_issue_log_id).toBeTruthy();
      expect(res.body.rework.retest_result).toBe('pending');
    });

    it('surfaces the rework in genealogy, naming the part that came OUT', async () => {
      const res = await request(app)
        .get(`/api/genealogy/rework?serial_number=${encodeURIComponent(PANEL_SERIAL.serial_number)}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThanOrEqual(2);
      // A recall must reach a panel that CONTAINED a defective lot, not only one
      // that still does — so the removed lot is still named.
      expect(res.body.reworkHistory.some(r => r.removed_batch_number)).toBe(true);
      expect(res.body.openReworks).toBeGreaterThan(0);
    });

    it('closes the rework only on a passing retest', async () => {
      const fail = await request(app)
        .post(`/api/production/rework/${reworkId}/retest`)
        .set('Authorization', auth()).send({ result: 'fail', reference: 'FAT-2' });
      expect(fail.status).toBe(200);
      // A failed retest must NOT close the record — the panel is still broken.
      expect(fail.body.rework.status).toBe('retested');

      const pass = await request(app)
        .post(`/api/production/rework/${reworkId}/retest`)
        .set('Authorization', auth()).send({ result: 'pass', reference: 'FAT-3' });
      expect(pass.status).toBe(200);
      expect(pass.body.rework.status).toBe('closed');
      expect(pass.body.rework.retested_by).not.toBeNull();
    });
  });

  /* ── findings 12, 13, 26: frozen BOM, substitutes, planned vs actual ─────── */

  describe('as-planned BOM is frozen and compared against as-built', () => {
    let bomId, bomOrderId, compA, compB, subItem;

    const mkBom = async (version, lines) => {
      const { rows: [h] } = await pool.query(
        `INSERT INTO bom_headers (company_id, product_code, product_name, version, is_active)
         VALUES ($1,$2,'Control Panel',$3,true) RETURNING id`,
        [COMPANY_ID, `BOMP_${S}`, version]);
      for (const l of lines) {
        await pool.query(
          `INSERT INTO bom_lines (company_id, bom_id, component_id, component_name, qty, unit, unit_cost)
           VALUES ($1,$2,$3,$4,$5,'Nos',$6)`,
          [COMPANY_ID, h.id, l.id, l.name, l.qty, l.cost ?? 10]);
      }
      return h.id;
    };

    it('freezes the BOM lines onto the order', async () => {
      compA = await mkItem('BOMA', 10);
      compB = await mkItem('BOMB', 20);
      bomId = await mkBom('v1.0', [
        { id: compA, name: 'Component A', qty: 2 },
        { id: compB, name: 'Component B', qty: 3 },
      ]);

      const { rows: [o] } = await pool.query(
        `INSERT INTO production_orders (company_id, production_order_no, product_name, quantity_planned, status, bom_id)
         VALUES ($1,$2,'Control Panel',2,'in_progress',$3) RETURNING id`,
        [COMPANY_ID, `WO_BOM_${S}`, bomId]);
      bomOrderId = o.id; created.orders.push(bomOrderId);

      const res = await request(app)
        .post(`/api/production/orders/${bomOrderId}/freeze-bom`)
        .set('Authorization', auth()).send({});
      expect(res.status).toBe(201);
      expect(res.body.lines_frozen).toBe(2);
      expect(res.body.bom_version).toBe('v1.0');

      // qty_required is per-unit x order quantity, not per-unit.
      const { rows } = await pool.query(
        `SELECT component_id, qty_per_unit, qty_required FROM production_order_bom_lines
          WHERE production_order_id=$1 ORDER BY line_no`, [bomOrderId]);
      expect(rows.map(r => Number(r.qty_required))).toEqual([4, 6]);
    });

    it('does not let a later BOM edit rewrite what this order was built against', async () => {
      // The core of finding 12: revise the BOM in place, as the live data shows
      // actually happens, and the frozen snapshot must not move.
      await pool.query('UPDATE bom_lines SET qty = 99 WHERE bom_id=$1', [bomId]);
      await pool.query("UPDATE bom_headers SET version='v2.0' WHERE id=$1", [bomId]);

      const { rows } = await pool.query(
        `SELECT qty_required, bom_version FROM production_order_bom_lines
          WHERE production_order_id=$1 ORDER BY line_no`, [bomOrderId]);
      expect(rows.map(r => Number(r.qty_required))).toEqual([4, 6]);
      expect(rows[0].bom_version).toBe('v1.0');
    });

    it('re-freezing replaces the snapshot instead of doubling it', async () => {
      const res = await request(app)
        .post(`/api/production/orders/${bomOrderId}/freeze-bom`)
        .set('Authorization', auth()).send({});
      expect(res.status).toBe(201);
      expect(res.body.refroze).toBe(true);
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int n FROM production_order_bom_lines WHERE production_order_id=$1', [bomOrderId]);
      expect(rows[0].n).toBe(2);
      // Re-freeze picks up the CURRENT BOM — that is the point of doing it
      // deliberately rather than silently.
      await pool.query('UPDATE bom_lines SET qty = CASE WHEN component_id=$2 THEN 2 ELSE 3 END WHERE bom_id=$1',
        [bomId, compA]);
      await request(app).post(`/api/production/orders/${bomOrderId}/freeze-bom`)
        .set('Authorization', auth()).send({});
    });

    it('refuses an unapproved substitution, and records an approved one', async () => {
      subItem = await mkItem('SUBST', 12);
      await mkBatch(subItem, 20, 'SUBLOT');
      const rsv = await mkReservation(bomOrderId, subItem, 10);

      const noReason = await issue(bomOrderId, {
        reservation_id: rsv, qty_issued: 1, substitute_for_item_id: compA,
      });
      expect(noReason.status).toBe(400);
      expect(noReason.body.code).toBe('SUBSTITUTION_REASON_REQUIRED');

      const ok = await issue(bomOrderId, {
        reservation_id: rsv, qty_issued: 4,
        substitute_for_item_id: compA,
        substitution_reason: 'Approved alternate — original on 12-week lead time',
        deviation_reference: 'ECO-2026-118',
      });
      expect(ok.status).toBe(200);

      const { rows: [log] } = await pool.query(
        `SELECT substitute_for_item_id, substitution_reason, substitution_approved_by,
                substitution_approved_at, deviation_reference
           FROM material_issue_logs WHERE reservation_id=$1 LIMIT 1`, [rsv]);
      expect(String(log.substitute_for_item_id)).toBe(String(compA));
      expect(log.substitution_approved_by).not.toBeNull();
      expect(log.substitution_approved_at).not.toBeNull();
      expect(log.deviation_reference).toBe('ECO-2026-118');
    });

    it('reports BOM required vs actual, flagging the gaps', async () => {
      // Component B: issue 5 against a required 6 — a real under-consumption.
      await mkBatch(compB, 20, 'BOMBLOT');
      const rsvB = await mkReservation(bomOrderId, compB, 10);
      const r = await issue(bomOrderId, { reservation_id: rsvB, qty_issued: 5 });
      expect(r.status).toBe(200);

      const res = await request(app)
        .get(`/api/genealogy/bom-vs-actual/${bomOrderId}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.planned_bom_available).toBe(true);

      const byCode = Object.fromEntries(res.body.lines.map(l => [String(l.component_id), l]));
      // Component A was never issued — the substitute was fitted in its place.
      expect(byCode[String(compA)].status).toBe('not_issued');
      expect(byCode[String(compB)].consumed_qty).toBe(5);
      expect(byCode[String(compB)].bom_required_qty).toBe(6);
      expect(byCode[String(compB)].status).toBe('under_consumed');
      expect(byCode[String(compB)].variance_qty).toBe(-1);

      // The substitute is off-BOM but approved, so it is reported separately
      // from an unexplained component turning up in a panel.
      const sub = res.body.unplannedConsumption.find(u => String(u.item_id) === String(subItem));
      expect(sub).toBeTruthy();
      expect(sub.is_approved_substitute).toBe(true);
      expect(sub.deviation_reference).toBe('ECO-2026-118');
      expect(res.body.summary.unapproved_unplanned_components).toBe(0);
      expect(res.body.discrepancies.length).toBeGreaterThan(0);
    });

    it('refuses to compute a variance against an order with no frozen BOM', async () => {
      const res = await request(app)
        .get(`/api/genealogy/bom-vs-actual/${OTHER_ORDER_ID}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      // Not an error, and deliberately NOT a fallback to the live BOM: a
      // variance against the wrong baseline looks authoritative and is worse
      // than no variance.
      expect(res.body.planned_bom_available).toBe(false);
      expect(res.body.lines).toEqual([]);
      expect(res.body.message).toMatch(/baseline/i);
    });
  });

  /* ── finding 7.1: supplier lot identity survives the door ────────────────── */

  describe('createBatch keeps supplier lot identity and a company', () => {
    it('stores supplier batch, manufacturer and MPN so a recall has a starting point', async () => {
      const item = await mkItem('SUPLOT');
      const batch = await advancedInventoryRepo.createBatch({
        item_id: item, warehouse_id: WAREHOUSE_ID, batch_number: `SUP_${S}`,
        received_date: '2026-09-01', expiry_date: null, supplier_id: null, grn_id: null,
        quantity_received: 25, rate: 12.5, company_id: COMPANY_ID,
        supplier_batch_no: 'ABC123', manufacturer: 'Acme Electric',
        manufacturer_part_no: 'ACM-RLY-24', manufacturing_date: '2026-08-15',
      });
      created.batches.push(batch.id);

      expect(batch.supplier_batch_no).toBe('ABC123');
      expect(batch.manufacturer_part_no).toBe('ACM-RLY-24');
      expect(String(batch.manufacturing_date).slice(0, 10)).toBe('2026-08-15');
    });

    it('never creates a NULL-company lot, even when the caller omits one', async () => {
      // A NULL company_id row is invisible to every company-scoped reader: the
      // lot would be received, counted in stock, and missing from the batch list
      // of the company that received it. createBatch set no company_id at all.
      const item = await mkItem('NOCO');
      const batch = await advancedInventoryRepo.createBatch({
        item_id: item, warehouse_id: WAREHOUSE_ID, batch_number: `NOCO_${S}`,
        received_date: '2026-09-01', expiry_date: null, supplier_id: null, grn_id: null,
        quantity_received: 5, rate: 1,
      });
      created.batches.push(batch.id);
      expect(batch.company_id).not.toBeNull();
      expect(String(batch.company_id)).toBe(String(COMPANY_ID));
    });
  });
});
