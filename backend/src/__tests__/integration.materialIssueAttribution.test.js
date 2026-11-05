/**
 * POST /production/orders/:id/issue-material
 *
 * This endpoint had no test coverage of any kind, which is how the traceability
 * audit's finding 02 survived: it is the ONLY write path that records which lot
 * — and now which unit — material left the store for. Everything the genealogy
 * module can say downstream is built from the rows this handler writes.
 *
 * Covers the handler's existing contract (lot selection, the QC gate, the
 * honest NULL batch when no lot can cover the issue) as well as the serial
 * attribution added for finding 02, because a test that only covers the new
 * columns would let the rest of the write path rot the same way.
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
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    envText = readFileSync(resolve(here, '../.env'), 'utf8');
  }
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
const { default: genealogyRoutes } = await import('../modules/production/genealogy.routes.js');

const app = buildApp(
  ['/api/production', verifyToken, executionRoutes],
  ['/api/genealogy', verifyToken, genealogyRoutes],
);

const TAG = `ZZMIA_${Date.now()}`;
const S = TAG.slice(-5);
let COMPANY_ID, USER_ID, EMPLOYEE_ID, WAREHOUSE_ID, ITEM_ID, OTHER_ITEM_ID;
let ORDER_ID, OTHER_ORDER_ID, SERIAL_A, SERIAL_B, FOREIGN_SERIAL, COMPONENT_SERIAL;

const created = {
  issue_logs: [], wip: [], serials: [], reservations: [], batches: [],
  orders: [], items: [], warehouses: [], users: [], employees: [], companies: [],
};

const auth = () => `Bearer ${makeToken({
  userId: USER_ID, employee_id: EMPLOYEE_ID, company_id: COMPANY_ID, roles: ['admin'],
})}`;

// current_stock is DERIVED from stock_ledger by a trigger, so it is seeded at 0
// and left to the ledger. Seeding a literal opening balance here would drift
// from the ledger and break the SCA on-hand invariant, which checks every item
// in the database rather than only its own.
const mkItem = async (label, name = 'Relay Module 24VDC', cost = 10.0) => {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost)
     VALUES ($1,$2,$3,0,$4) RETURNING id`,
    [COMPANY_ID, `${label}_${S}_${created.items.length}`, name, cost]);
  created.items.push(i.id);
  return i.id;
};

/**
 * A reservation is the handler's entry token — it refuses to issue without one.
 * Each reservation gets its OWN item by default. Lot selection draws from every
 * available lot of an item, so tests sharing an item would inherit each other's
 * leftover stock and the lot-selection assertions would depend on run order.
 */
const mkReservation = async (orderId, itemId = null, required = 100) => {
  const item = itemId ?? await mkItem('RSV');
  const { rows: [nm] } = await pool.query('SELECT item_name FROM inventory_items WHERE id=$1', [item]);
  const { rows: [r] } = await pool.query(
    `INSERT INTO material_reservations
       (company_id, production_order_id, item_id, item_name, unit, qty_required, qty_reserved, status)
     VALUES ($1,$2,$3,$4,'Nos',$5,$5,'reserved') RETURNING id`,
    [COMPANY_ID, orderId, item, nm.item_name, required]);
  created.reservations.push(r.id);
  return { id: r.id, itemId: item };
};

const mkBatch = async ({ item, qty = 50, expiry = null, status = 'active', label = 'LOT' }) => {
  const { rows: [b] } = await pool.query(
    `INSERT INTO inventory_batches
       (company_id, item_id, warehouse_id, batch_number, quantity_received, quantity_available, expiry_date, status, rate)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,10) RETURNING id`,
    [COMPANY_ID, item, WAREHOUSE_ID, `${label}_${S}_${created.batches.length}`, qty, expiry, status]);
  created.batches.push(b.id);
  return b.id;
};

const mkSerial = async (label, orderId, itemId = ITEM_ID) => {
  const { rows: [s] } = await pool.query(
    `INSERT INTO serial_numbers (company_id, serial_number, item_id, production_order_id, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id, serial_number`,
    [COMPANY_ID, `SN_${label}_${S}`, itemId, orderId]);
  created.serials.push(s.id);
  return s;
};

const issue = (orderId, body) =>
  request(app).post(`/api/production/orders/${orderId}/issue-material`).set('Authorization', auth()).send(body);

const logsFor = async (reservationId) => (await pool.query(
  `SELECT mil.*, b.batch_number FROM material_issue_logs mil
     LEFT JOIN inventory_batches b ON b.id = mil.batch_id
    WHERE mil.reservation_id = $1 ORDER BY mil.id`, [reservationId])).rows;

const trackLogs = async (reservationId) => {
  const rows = await logsFor(reservationId);
  rows.forEach(r => created.issue_logs.push(r.id));
  return rows;
};

describe('Material issue — lot selection and per-unit attribution', () => {
  beforeAll(async () => {
    const { rows: [c] } = await pool.query(
      'INSERT INTO companies (name, code, is_active) VALUES ($1,$2,true) RETURNING id',
      [`MIA Co ${TAG}`, `MIA_${S}`]);
    COMPANY_ID = c.id; created.companies.push(COMPANY_ID);

    const { rows: [e] } = await pool.query(
      `INSERT INTO employees (office_id, company_id, first_name, last_name, company_email)
       VALUES (${FIXTURE_CODE_SQL}, $1,'Stores','Operator',$2) RETURNING id`,
      [COMPANY_ID, `stores_${TAG}@pulse.test`]);
    EMPLOYEE_ID = e.id; created.employees.push(EMPLOYEE_ID);

    const { rows: [u] } = await pool.query(
      `INSERT INTO users (email, password_hash, role, company_id, name, employee_id, is_active)
       VALUES ($1,'x','admin',$2,'Stores Operator',$3,true) RETURNING id`,
      [`stores_${TAG}@pulse.test`, COMPANY_ID, EMPLOYEE_ID]);
    USER_ID = u.id; created.users.push(USER_ID);
    await pool.query('INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)', [USER_ID, COMPANY_ID]);
    const { rows: [role] } = await pool.query("SELECT id FROM roles WHERE LOWER(code)='admin' LIMIT 1");
    if (role) await pool.query('INSERT INTO user_roles (user_id, role_id, is_primary) VALUES ($1,$2,true)', [USER_ID, role.id]);

    const { rows: [w] } = await pool.query(
      'INSERT INTO warehouses (name, warehouse_code, company_id) VALUES ($1,$2,$3) RETURNING id',
      [`MIA WH ${TAG}`, `MW_${S}`, COMPANY_ID]);
    WAREHOUSE_ID = w.id; created.warehouses.push(WAREHOUSE_ID);

    const { rows: [i] } = await pool.query(
      `INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost)
       VALUES ($1,$2,'Relay Module 24VDC',0,10.00) RETURNING id`, [COMPANY_ID, `RLY_${S}`]);
    ITEM_ID = i.id; created.items.push(ITEM_ID);

    const { rows: [i2] } = await pool.query(
      `INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost)
       VALUES ($1,$2,'Busbar 400A',0,55.00) RETURNING id`, [COMPANY_ID, `BUS_${S}`]);
    OTHER_ITEM_ID = i2.id; created.items.push(OTHER_ITEM_ID);

    const mkOrder = async (no, qty) => {
      const { rows: [o] } = await pool.query(
        `INSERT INTO production_orders (company_id, production_order_no, product_name, quantity_planned, status)
         VALUES ($1,$2,'Control Panel 400A',$3,'in_progress') RETURNING id`, [COMPANY_ID, no, qty]);
      created.orders.push(o.id);
      return o.id;
    };
    ORDER_ID = await mkOrder(`WO_MIA_${S}`, 2);
    OTHER_ORDER_ID = await mkOrder(`WO_OTH_${S}`, 1);

    // ORDER_ID builds exactly two units. The component serial is a purchased
    // serialised part, NOT something this order builds, so it carries no
    // production order — giving it one would make the order look like a
    // three-unit build and silently change every recall-scope assertion.
    SERIAL_A = await mkSerial('A', ORDER_ID);
    SERIAL_B = await mkSerial('B', ORDER_ID);
    FOREIGN_SERIAL = await mkSerial('FOREIGN', OTHER_ORDER_ID);
    COMPONENT_SERIAL = await mkSerial('COMP', null, OTHER_ITEM_ID);
  });

  afterAll(async () => {
    try {
      const ids = created.reservations;
      if (ids.length) {
        await pool.query('DELETE FROM material_issue_logs WHERE reservation_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM wip_transactions WHERE reservation_id = ANY($1)', [ids]);
      }
      if (created.orders.length) {
        await pool.query('DELETE FROM material_issue_logs WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM wip_transactions WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM production_order_costs WHERE production_order_id = ANY($1)', [created.orders]);
      }
      if (ids.length) await pool.query('DELETE FROM material_reservations WHERE id = ANY($1)', [ids]);
      if (created.serials.length) await pool.query('DELETE FROM serial_numbers WHERE id = ANY($1)', [created.serials]);
      if (created.orders.length) await pool.query('DELETE FROM production_orders WHERE id = ANY($1)', [created.orders]);
      if (created.batches.length) await pool.query('DELETE FROM inventory_batches WHERE id = ANY($1)', [created.batches]);
      if (created.items.length) {
        await pool.query('DELETE FROM stock_ledger WHERE item_id = ANY($1)', [created.items]);
        await pool.query('DELETE FROM inventory_items WHERE id = ANY($1)', [created.items]);
      }
      if (created.warehouses.length) await pool.query('DELETE FROM warehouses WHERE id = ANY($1)', [created.warehouses]);
      if (created.users.length) {
        await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [created.users]);
        await pool.query('DELETE FROM user_scope WHERE user_id = ANY($1)', [created.users]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
      }
      if (created.employees.length) await pool.query('DELETE FROM employees WHERE id = ANY($1)', [created.employees]);
      if (created.companies.length) await pool.query('DELETE FROM companies WHERE id = ANY($1)', [created.companies]);
    } catch (err) {
      console.error('Teardown error:', err);
    }
  });

  /* ── the handler's existing contract ─────────────────────────────────────── */

  it('refuses an issue with no reservation, and one against an unknown reservation', async () => {
    expect((await issue(ORDER_ID, { qty_issued: 5 })).status).toBe(400);
    expect((await issue(ORDER_ID, { reservation_id: 999999999, qty_issued: 5 })).status).toBe(404);
  });

  it('records the lot the material left, and decrements that lot', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 40, label: 'SINGLE' });

    const res = await issue(ORDER_ID, { reservation_id: rid, qty_issued: 10, batch_id: batch });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('partially_issued');

    const logs = await trackLogs(rid);
    expect(logs.length).toBe(1);
    expect(logs[0].batch_id).toBe(batch);
    expect(parseFloat(logs[0].qty_issued)).toBe(10);

    const { rows: [b] } = await pool.query('SELECT quantity_available FROM inventory_batches WHERE id=$1', [batch]);
    expect(parseFloat(b.quantity_available)).toBe(30);
  });

  it('draws the earliest-expiring lot first when no lot is named', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const later = await mkBatch({ item: itemId, qty: 20, expiry: '2030-01-01', label: 'FEFO_LATE' });
    const sooner = await mkBatch({ item: itemId, qty: 20, expiry: '2027-01-01', label: 'FEFO_SOON' });

    expect((await issue(ORDER_ID, { reservation_id: rid, qty_issued: 5 })).status).toBe(200);
    const logs = await trackLogs(rid);
    expect(logs.length).toBe(1);
    expect(logs[0].batch_id).toBe(sooner);
    expect(logs[0].batch_id).not.toBe(later);
  });

  it('splits one issue across lots rather than averaging them into a single row', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const first = await mkBatch({ item: itemId, qty: 6, expiry: '2027-02-01', label: 'SPLIT_A' });
    const second = await mkBatch({ item: itemId, qty: 10, expiry: '2027-03-01', label: 'SPLIT_B' });

    expect((await issue(ORDER_ID, { reservation_id: rid, qty_issued: 9 })).status).toBe(200);
    const logs = await trackLogs(rid);
    expect(logs.length).toBe(2);
    const byBatch = Object.fromEntries(logs.map(l => [l.batch_id, parseFloat(l.qty_issued)]));
    expect(byBatch[first]).toBe(6);
    expect(byBatch[second]).toBe(3);
  });

  it('refuses to issue a quarantined lot to the shop floor', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const bad = await mkBatch({ item: itemId, qty: 20, status: 'quarantine', label: 'QUAR' });

    const res = await issue(ORDER_ID, { reservation_id: rid, qty_issued: 5, batch_id: bad });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QC_BLOCKED');

    // The refusal must leave no trace: the reservation update and the stock
    // deduction both happen before this gate and must roll back with it.
    expect((await logsFor(rid)).length).toBe(0);
    const { rows: [r] } = await pool.query('SELECT qty_issued, status FROM material_reservations WHERE id=$1', [rid]);
    expect(parseFloat(r.qty_issued)).toBe(0);
    const { rows: [b] } = await pool.query('SELECT quantity_available FROM inventory_batches WHERE id=$1', [bad]);
    expect(parseFloat(b.quantity_available)).toBe(20);
  });

  it('logs an uncovered quantity with a NULL lot and says so, rather than inventing one', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const small = await mkBatch({ item: itemId, qty: 3, expiry: '2027-04-01', label: 'SHORT' });

    expect((await issue(ORDER_ID, { reservation_id: rid, qty_issued: 8 })).status).toBe(200);
    const logs = await trackLogs(rid);
    const unknown = logs.find(l => l.batch_id === null);
    expect(unknown).toBeDefined();
    expect(parseFloat(unknown.qty_issued)).toBe(5);
    expect(unknown.notes).toContain('lot not identified');
    expect(logs.find(l => l.batch_id === small)).toBeDefined();
  });

  /* ── per-unit attribution (traceability finding 02) ───────────────────────── */

  it('attributes an issue to the named unit', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 20, label: 'ATTR' });

    const res = await issue(ORDER_ID, {
      reservation_id: rid, qty_issued: 4, batch_id: batch, serial_number: SERIAL_A.serial_number,
    });
    expect(res.status).toBe(200);

    const logs = await trackLogs(rid);
    expect(logs.length).toBe(1);
    expect(logs[0].serial_id).toBe(SERIAL_A.id);
  });

  it('leaves the unit NULL when none is named, so it reads as shared not as every panel', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 20, label: 'SHARED' });

    expect((await issue(ORDER_ID, { reservation_id: rid, qty_issued: 4, batch_id: batch })).status).toBe(200);
    const logs = await trackLogs(rid);
    expect(logs[0].serial_id).toBeNull();
  });

  it('rejects a unit built by a different order', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 20, label: 'FOREIGN' });

    const res = await issue(ORDER_ID, {
      reservation_id: rid, qty_issued: 4, batch_id: batch, serial_number: FOREIGN_SERIAL.serial_number,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERIAL_ORDER_MISMATCH');
    expect((await logsFor(rid)).length).toBe(0);
  });

  it('rejects an unknown unit', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const res = await issue(ORDER_ID, { reservation_id: rid, qty_issued: 4, serial_number: `NOPE_${TAG}` });
    expect(res.status).toBe(404);
    expect((await logsFor(rid)).length).toBe(0);
  });

  it('rejects a component serial that is not a unit of the item being issued', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 20, label: 'CSER' });

    // COMPONENT_SERIAL is a unit of OTHER_ITEM_ID; the reservation is for ITEM_ID.
    const res = await issue(ORDER_ID, {
      reservation_id: rid, qty_issued: 2, batch_id: batch,
      component_serial_number: COMPONENT_SERIAL.serial_number,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMPONENT_SERIAL_ITEM_MISMATCH');
    expect((await logsFor(rid)).length).toBe(0);
  });

  it('a rejected attribution leaves stock and the reservation untouched', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 25, label: 'ROLLBACK' });
    const before = await pool.query('SELECT current_stock FROM inventory_items WHERE id=$1', [ITEM_ID]);

    const res = await issue(ORDER_ID, {
      reservation_id: rid, qty_issued: 7, batch_id: batch, serial_number: FOREIGN_SERIAL.serial_number,
    });
    expect(res.status).toBe(409);

    const { rows: [b] } = await pool.query('SELECT quantity_available FROM inventory_batches WHERE id=$1', [batch]);
    expect(parseFloat(b.quantity_available)).toBe(25);
    const { rows: [r] } = await pool.query('SELECT qty_issued FROM material_reservations WHERE id=$1', [rid]);
    expect(parseFloat(r.qty_issued)).toBe(0);
    const after = await pool.query('SELECT current_stock FROM inventory_items WHERE id=$1', [ITEM_ID]);
    expect(parseFloat(after.rows[0].current_stock)).toBe(parseFloat(before.rows[0].current_stock));
  });

  it('attaches a consumed component serial only to the row for its own lot', async () => {
    // A serialised component is one physical unit from one lot. When an issue
    // spans lots, stamping it on every row would claim the same unit was
    // consumed several times.
    const { id: rid, itemId } = await mkReservation(ORDER_ID, OTHER_ITEM_ID);
    await pool.query('UPDATE material_reservations SET item_name=$2 WHERE id=$1', [rid, 'Busbar 400A']);
    const lotA = await mkBatch({ item: itemId, qty: 2, expiry: '2027-05-01', label: 'CS_A' });
    const lotB = await mkBatch({ item: itemId, qty: 5, expiry: '2027-06-01', label: 'CS_B' });
    // The component serial belongs to lotB.
    await pool.query('UPDATE serial_numbers SET batch_id=$2 WHERE id=$1', [COMPONENT_SERIAL.id, lotB]);

    const res = await issue(ORDER_ID, {
      reservation_id: rid, qty_issued: 4,
      component_serial_number: COMPONENT_SERIAL.serial_number,
    });
    expect(res.status).toBe(200);

    const logs = await trackLogs(rid);
    expect(logs.length).toBe(2);
    const onA = logs.find(l => l.batch_id === lotA);
    const onB = logs.find(l => l.batch_id === lotB);
    expect(onB.component_serial_id).toBe(COMPONENT_SERIAL.id);
    expect(onA.component_serial_id).toBeNull();
  });

  /* ── the write path feeding genealogy ────────────────────────────────────── */

  it('an attributed issue reaches the per-panel as-built, and its siblings do not claim it', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 30, label: 'E2E' });

    expect((await issue(ORDER_ID, {
      reservation_id: rid, qty_issued: 6, batch_id: batch, serial_number: SERIAL_A.serial_number,
    })).status).toBe(200);
    await trackLogs(rid);

    const a = await request(app)
      .get(`/api/genealogy/as-built/serial/${encodeURIComponent(SERIAL_A.serial_number)}`)
      .set('Authorization', auth());
    expect(a.status).toBe(200);
    expect(a.body.attributedComponents.some(c => c.batch_id === batch)).toBe(true);

    const b = await request(app)
      .get(`/api/genealogy/as-built/serial/${encodeURIComponent(SERIAL_B.serial_number)}`)
      .set('Authorization', auth());
    expect(b.status).toBe(200);
    expect(b.body.attributedComponents.some(c => c.batch_id === batch)).toBe(false);
    expect(b.body.sharedComponents.some(c => c.batch_id === batch)).toBe(false);
  });

  it('narrows recall scope to the attributed unit', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 30, label: 'RECALL' });

    expect((await issue(ORDER_ID, {
      reservation_id: rid, qty_issued: 3, batch_id: batch, serial_number: SERIAL_B.serial_number,
    })).status).toBe(200);
    await trackLogs(rid);

    const res = await request(app).get(`/api/genealogy/where-used/${batch}`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.recallScope.definite_units).toBe(1);
    expect(res.body.recallScope.possible_units).toBe(0);
    expect(res.body.recallScope.exact).toBe(true);
    expect(res.body.affectedSerials[0].serial_number).toBe(SERIAL_B.serial_number);
  });

  it('reports an unattributed lot as an upper bound across both units', async () => {
    const { id: rid, itemId } = await mkReservation(ORDER_ID);
    const batch = await mkBatch({ item: itemId, qty: 30, label: 'BOUND' });

    expect((await issue(ORDER_ID, { reservation_id: rid, qty_issued: 3, batch_id: batch })).status).toBe(200);
    await trackLogs(rid);

    const res = await request(app).get(`/api/genealogy/where-used/${batch}`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.recallScope.definite_units).toBe(0);
    expect(res.body.recallScope.possible_units).toBe(2);
    expect(res.body.recallScope.exact).toBe(false);
    expect(res.body.recallScope.note).toContain('upper bound');
  });
});
