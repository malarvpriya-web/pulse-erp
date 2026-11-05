/**
 * Traceability closure — audit findings 15, 16, 20, 34, 37 and the lot
 * disposition half of 10.
 *
 * The spine suite (integration.traceabilitySpine) covers the ledger, the
 * supplier lot, double-install and the frozen BOM. This one covers what the
 * second remediation pass added:
 *
 *   15  the assembly event — who fitted what, where, when
 *   20  promised stock cannot be issued to another requirement
 *   34  pick -> pack -> ship carries the unit, so the reverse chain can start
 *   16  a test run names a real panel, and a reading names its instrument
 *   10  a lot's disposition balances
 *   37  the receive-95-accept-5-reject scenario the brief specifies
 *
 * As in the spine suite, each guard here was mutation-tested: the constraint
 * dropped or the check removed, and the specific test that should fail did.
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
const { default: genealogyRoutes } = await import('../modules/production/genealogy.routes.js');
const { default: warehouseRoutes } = await import('../modules/warehouse/warehouse.routes.js');
const { default: scanRoutes } = await import('../modules/warehouse/scan.routes.js');

const app = buildApp(
  ['/api/production', verifyToken, executionRoutes],
  ['/api/genealogy', verifyToken, genealogyRoutes],
  ['/api/warehouse', verifyToken, warehouseRoutes],
  ['/api/scan', verifyToken, scanRoutes],
);

const TAG = `ZZTCL_${Date.now()}`;
const S = TAG.slice(-5);
let COMPANY_ID, USER_ID, EMPLOYEE_ID, WAREHOUSE_ID, WORK_CENTRE_ID;
let ORDER_A, ORDER_B, PANEL_A, PANEL_B;

const created = {
  reservations: [], batches: [], serials: [], orders: [], items: [],
  warehouses: [], workcentres: [], users: [], employees: [], companies: [],
  grns: [], bins: [],
};

const auth = () => `Bearer ${makeToken({
  userId: USER_ID, employee_id: EMPLOYEE_ID, company_id: COMPANY_ID, roles: ['admin'],
})}`;

const mkItem = async (label, cost = 10) => {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost)
     VALUES ($1,$2,$3,0,$4) RETURNING id`,
    [COMPANY_ID, `${label}_${S}_${created.items.length}`, `Part ${label}`, cost]);
  created.items.push(i.id);
  return i.id;
};

const mkBatch = async (item, qty = 100, label = 'LOT', status = 'active') => {
  const { rows: [b] } = await pool.query(
    `INSERT INTO inventory_batches
       (company_id, item_id, warehouse_id, batch_number, quantity_received, quantity_available, status, rate)
     VALUES ($1,$2,$3,$4,$5,$5,$6,10) RETURNING id`,
    [COMPANY_ID, item, WAREHOUSE_ID, `${label}_${S}_${created.batches.length}`, qty, status]);
  created.batches.push(b.id);
  return b.id;
};

const mkReservation = async (orderId, itemId, required = 10) => {
  const { rows: [nm] } = await pool.query('SELECT item_name FROM inventory_items WHERE id=$1', [itemId]);
  const { rows: [r] } = await pool.query(
    `INSERT INTO material_reservations
       (company_id, production_order_id, item_id, item_name, unit, qty_required, qty_reserved, status)
     VALUES ($1,$2,$3,$4,'Nos',$5,$5,'reserved') RETURNING id`,
    [COMPANY_ID, orderId, itemId, nm.item_name, required]);
  created.reservations.push(r.id);
  return r.id;
};

const mkSerial = async (label, orderId, itemId) => {
  const { rows: [s] } = await pool.query(
    `INSERT INTO serial_numbers (company_id, serial_number, item_id, production_order_id, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id, serial_number`,
    [COMPANY_ID, `SN_${label}_${S}`, itemId, orderId]);
  created.serials.push(s.id);
  return s;
};

const install = (orderId, body) =>
  request(app).post(`/api/production/orders/${orderId}/install-component`)
    .set('Authorization', auth()).send(body);
const issue = (orderId, body) =>
  request(app).post(`/api/production/orders/${orderId}/issue-material`)
    .set('Authorization', auth()).send(body);

describe('Traceability closure — assembly, dispatch, promised stock and QC', () => {
  beforeAll(async () => {
    const { rows: [c] } = await pool.query(
      'INSERT INTO companies (name, code, is_active) VALUES ($1,$2,true) RETURNING id',
      [`TCL Co ${TAG}`, `TCL_${S}`]);
    COMPANY_ID = c.id; created.companies.push(COMPANY_ID);

    const { rows: [e] } = await pool.query(
      `INSERT INTO employees (office_id, company_id, first_name, last_name, company_email)
       VALUES (${FIXTURE_CODE_SQL}, $1,'Meera','Assembler',$2) RETURNING id`,
      [COMPANY_ID, `assy_${TAG}@pulse.test`]);
    EMPLOYEE_ID = e.id; created.employees.push(EMPLOYEE_ID);

    const { rows: [u] } = await pool.query(
      `INSERT INTO users (email, password_hash, role, company_id, name, employee_id, is_active)
       VALUES ($1,'x','admin',$2,'Meera Assembler',$3,true) RETURNING id`,
      [`assy_${TAG}@pulse.test`, COMPANY_ID, EMPLOYEE_ID]);
    USER_ID = u.id; created.users.push(USER_ID);
    await pool.query('INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)', [USER_ID, COMPANY_ID]);
    const { rows: [role] } = await pool.query("SELECT id FROM roles WHERE LOWER(code)='admin' LIMIT 1");
    if (role) await pool.query('INSERT INTO user_roles (user_id, role_id, is_primary) VALUES ($1,$2,true)', [USER_ID, role.id]);

    const { rows: [w] } = await pool.query(
      'INSERT INTO warehouses (name, warehouse_code, company_id) VALUES ($1,$2,$3) RETURNING id',
      [`TCL WH ${TAG}`, `TCW_${S}`, COMPANY_ID]);
    WAREHOUSE_ID = w.id; created.warehouses.push(WAREHOUSE_ID);

    const { rows: [wc] } = await pool.query(
      `INSERT INTO work_centres (company_id, code, name) VALUES ($1,$2,'Assembly Line 2') RETURNING id`,
      [COMPANY_ID, `ASSY2_${S}`]).catch(() => ({ rows: [{ id: null }] }));
    WORK_CENTRE_ID = wc?.id ?? null;
    if (WORK_CENTRE_ID) created.workcentres.push(WORK_CENTRE_ID);

    const mkOrder = async (no) => {
      const { rows: [o] } = await pool.query(
        `INSERT INTO production_orders (company_id, production_order_no, product_name, quantity_planned, status)
         VALUES ($1,$2,'Control Panel',1,'in_progress') RETURNING id`, [COMPANY_ID, no]);
      created.orders.push(o.id);
      return o.id;
    };
    ORDER_A = await mkOrder(`WO_TCLA_${S}`);
    ORDER_B = await mkOrder(`WO_TCLB_${S}`);

    const panelItem = await mkItem('PANEL');
    PANEL_A = await mkSerial('PA', ORDER_A, panelItem);
    PANEL_B = await mkSerial('PB', ORDER_B, panelItem);
  });

  afterAll(async () => {
    try {
      if (created.orders.length) {
        await pool.query('DELETE FROM component_installations WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM rework_records WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM material_issue_logs WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM wip_transactions WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM production_order_costs WHERE production_order_id = ANY($1)', [created.orders]);
        await pool.query('DELETE FROM test_run_measurements WHERE test_run_id IN (SELECT id FROM test_runs WHERE production_order_id = ANY($1))', [created.orders]);
        await pool.query('DELETE FROM test_runs WHERE production_order_id = ANY($1)', [created.orders]);
      }
      if (created.reservations.length) await pool.query('DELETE FROM material_reservations WHERE id = ANY($1)', [created.reservations]);
      await pool.query(`DELETE FROM package_lines WHERE package_id IN
                          (SELECT id FROM packages WHERE company_id = $1)`, [COMPANY_ID]);
      await pool.query('DELETE FROM packages WHERE company_id = $1', [COMPANY_ID]);
      await pool.query(`DELETE FROM pick_list_lines WHERE pick_list_id IN
                          (SELECT id FROM pick_lists WHERE company_id = $1)`, [COMPANY_ID]);
      await pool.query('DELETE FROM pick_lists WHERE company_id = $1', [COMPANY_ID]);
      if (created.serials.length) {
        await pool.query('DELETE FROM package_lines WHERE serial_id = ANY($1)', [created.serials]);
        await pool.query('DELETE FROM serial_numbers WHERE id = ANY($1)', [created.serials]);
      }
      if (created.orders.length) await pool.query('DELETE FROM production_orders WHERE id = ANY($1)', [created.orders]);
      if (created.batches.length) await pool.query('DELETE FROM inventory_batches WHERE id = ANY($1)', [created.batches]);
      if (created.items.length) {
        await pool.query('DELETE FROM inventory_fifo_consumption WHERE item_id = ANY($1)', [created.items]);
        await pool.query('DELETE FROM inventory_fifo_layers WHERE item_id = ANY($1)', [created.items]);
        await pool.query('DELETE FROM stock_ledger WHERE item_id = ANY($1)', [created.items]);
        await pool.query('DELETE FROM inventory_items WHERE id = ANY($1)', [created.items]);
      }
      if (created.grns.length) {
        await pool.query('DELETE FROM quality_inspections WHERE grn_id = ANY($1)', [created.grns]);
        await pool.query('DELETE FROM goods_receipt_notes WHERE id = ANY($1)', [created.grns]);
      }
      if (created.bins.length) {
        await pool.query('UPDATE inventory_batches SET bin_id = NULL WHERE bin_id = ANY($1)', [created.bins]);
        await pool.query('UPDATE stock_ledger SET from_bin_id=NULL, to_bin_id=NULL WHERE from_bin_id = ANY($1) OR to_bin_id = ANY($1)', [created.bins]);
        await pool.query('DELETE FROM warehouse_bins WHERE id = ANY($1)', [created.bins]);
      }
      if (created.workcentres.length) await pool.query('DELETE FROM work_centres WHERE id = ANY($1)', [created.workcentres]);
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

  /* ── finding 15: the assembly event ──────────────────────────────────────── */

  describe('a component is recorded as FITTED, not merely issued', () => {
    let relayItem, relayLot, relaySerial;

    it('records who fitted it, at which station, and when', async () => {
      relayItem = await mkItem('RLY', 25);
      relayLot  = await mkBatch(relayItem, 50, 'RLYLOT');
      relaySerial = await mkSerial('RLY1', null, relayItem);

      const res = await install(ORDER_A, {
        serial_number: PANEL_A.serial_number,
        component_serial_number: relaySerial.serial_number,
        batch_id: relayLot,
        quantity: 1,
        work_centre_id: WORK_CENTRE_ID,
        station_code: 'ASSY-2',
        work_instruction_ref: 'WI-4471-C',
        started_at: '2026-09-15T14:30:00Z',
        completed_at: '2026-09-15T14:40:00Z',
      });
      expect(res.status).toBe(201);
      // The answer finding 15 existed to give. Asserted on the ID, because the
      // requirement is explicit that operators are deterministic ids and not a
      // typed name — the denormalised name is a convenience and falls back to
      // the account's email when the token carries no display name.
      expect(String(res.body.installation.installed_by)).toBe(String(USER_ID));
      expect(res.body.installation.installed_by_name).toBeTruthy();
      expect(res.body.installation.station_code).toBe('ASSY-2');
      expect(res.body.installation.work_instruction_ref).toBe('WI-4471-C');
      expect(res.body.installation.completed_at).not.toBeNull();
    });

    it('genealogy reports the panel as built from installations, naming the operator', async () => {
      const res = await request(app)
        .get(`/api/genealogy/assembly/${encodeURIComponent(PANEL_A.serial_number)}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      // Graded, not guessed: this panel has real assembly records.
      expect(res.body.as_built_source).toBe('installation');
      expect(res.body.counts.fitted).toBe(1);
      expect(res.body.operators.length).toBe(1);
      expect(String(res.body.operators[0].id)).toBe(String(USER_ID));
      expect(res.body.installedComponents[0].component_serial).toBe(relaySerial.serial_number);
    });

    it('says so honestly when a panel has no assembly record', async () => {
      const res = await request(app)
        .get(`/api/genealogy/assembly/${encodeURIComponent(PANEL_B.serial_number)}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      // Not an error and not a fabricated history — the absence is stated.
      expect(res.body.as_built_source).toBe('issue');
      expect(res.body.counts.fitted).toBe(0);
      expect(res.body.source_note).toMatch(/cannot say who fitted/i);
    });

    it('refuses to fit the same unit into a second panel', async () => {
      const res = await install(ORDER_B, {
        serial_number: PANEL_B.serial_number,
        component_serial_number: relaySerial.serial_number,
        quantity: 1,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('COMPONENT_SERIAL_ALREADY_INSTALLED');
      expect(res.body.installed_in_serial).toBe(PANEL_A.serial_number);
    });

    it('refuses a panel that belongs to a different order', async () => {
      const res = await install(ORDER_B, {
        serial_number: PANEL_A.serial_number, item_id: relayItem, quantity: 1,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SERIAL_ORDER_MISMATCH');
    });

    it('refuses to fit a quality-blocked lot', async () => {
      const blockedLot = await mkBatch(relayItem, 5, 'QLOT', 'quarantine');
      const res = await install(ORDER_A, {
        serial_number: PANEL_A.serial_number, item_id: relayItem,
        batch_id: blockedLot, quantity: 1,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('QC_BLOCKED');
    });

    it('is enforced by the database, not only by the route', async () => {
      await expect(pool.query(
        `INSERT INTO component_installations
           (company_id, production_order_id, item_id, component_serial_id, quantity)
         VALUES ($1,$2,$3,$4,1)`,
        [COMPANY_ID, ORDER_B, relayItem, relaySerial.id]
      )).rejects.toMatchObject({ code: '23505' });
    });

    it('a rework removal frees the unit and preserves the original fitting', async () => {
      const { rows: [before] } = await pool.query(
        `SELECT id, installed_by_name, station_code FROM component_installations
          WHERE component_serial_id = $1 AND removed_at IS NULL`, [relaySerial.id]);
      expect(before).toBeTruthy();

      await pool.query(
        `UPDATE component_installations
            SET removed_at = NOW(), removal_reason = 'failed IR test', status = 'removed'
          WHERE id = $1`, [before.id]);

      const refit = await install(ORDER_B, {
        serial_number: PANEL_B.serial_number,
        component_serial_number: relaySerial.serial_number,
        quantity: 1,
      });
      expect(refit.status).toBe(201);

      // The original fitting still says who fitted it and where — a recall has
      // to reach a panel that CONTAINED the part, not only one that still does.
      const { rows: [orig] } = await pool.query(
        'SELECT installed_by_name, station_code, removal_reason FROM component_installations WHERE id=$1',
        [before.id]);
      expect(orig.installed_by_name).toBe(before.installed_by_name);
      expect(orig.station_code).toBe(before.station_code);
      expect(orig.removal_reason).toMatch(/IR test/);
    });
  });

  /* ── finding 20: promised stock is not available to another order ────────── */

  describe('stock promised to one order cannot be issued to another', () => {
    let sharedItem;

    it('refuses the issue and names the order holding the claim', async () => {
      sharedItem = await mkItem('SHARED', 40);
      await mkBatch(sharedItem, 10, 'SHAREDLOT');
      // Order A is promised all ten.
      await mkReservation(ORDER_A, sharedItem, 10);
      // Order B tries to take eight of them.
      const rsvB = await mkReservation(ORDER_B, sharedItem, 8);

      const res = await issue(ORDER_B, { reservation_id: rsvB, qty_issued: 8 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RESERVED_FOR_ANOTHER_REQUIREMENT');
      expect(res.body.promised_elsewhere).toBe(10);
      // Actionable: the caller is told whose promise to go and release.
      expect(res.body.held_by.join(' ')).toMatch(new RegExp(`WO_TCLA_${S}`));
    });

    it('allows an order to draw against its OWN reservation', async () => {
      const ownItem = await mkItem('OWN', 15);
      await mkBatch(ownItem, 10, 'OWNLOT');
      const rsv = await mkReservation(ORDER_A, ownItem, 10);
      const res = await issue(ORDER_A, { reservation_id: rsv, qty_issued: 10 });
      expect(res.status).toBe(200);
    });

    it('allows an issue that still leaves the other order whole', async () => {
      const plentyItem = await mkItem('PLENTY', 12);
      await mkBatch(plentyItem, 100, 'PLENTYLOT');
      await mkReservation(ORDER_A, plentyItem, 10);
      const rsvB = await mkReservation(ORDER_B, plentyItem, 10);
      // 100 on hand, 10 promised to A, B takes 10 -> 90 left, A is still whole.
      const res = await issue(ORDER_B, { reservation_id: rsvB, qty_issued: 10 });
      expect(res.status).toBe(200);
    });

    it('surfaces over-commitment as a planning signal rather than refusing the promise', async () => {
      // Reserving material that has not arrived is normal — MRP does it before
      // the PR is even raised. It must be visible, not forbidden.
      const futureItem = await mkItem('FUTURE', 20);
      const rsv = await mkReservation(ORDER_A, futureItem, 500);
      expect(rsv).toBeTruthy();

      const { rows } = await pool.query(
        'SELECT uncovered_qty FROM v_reservation_over_commitment WHERE item_id = $1', [futureItem]);
      expect(rows.length).toBe(1);
      expect(Number(rows[0].uncovered_qty)).toBe(500);
    });
  });

  /* ── finding 16: a test run names a real panel and a real instrument ─────── */

  describe('quality evidence attaches to the unit and the instrument', () => {
    it('links a test run to the panel by id, not by a free-text serial', async () => {
      const { rows: [tr] } = await pool.query(`
        INSERT INTO test_runs
          (company_id, run_number, production_order_id, serial_id, serial_number,
           test_stage, test_type, test_spec_revision, station_name,
           overall_result, executed_by_name, started_at, completed_at)
        VALUES ($1,$2,$3,$4,$5,'FAT','functional','SPEC-R3','TEST-1',
                'pass','Arun Tester',NOW(),NOW()) RETURNING id`,
        [COMPANY_ID, `TR_${S}`, ORDER_A, PANEL_A.id, PANEL_A.serial_number]);

      const { rows: [inst] } = await pool.query(
        `INSERT INTO calibration_equipment
           (company_id, equipment_id, name, certificate_number, next_calibration_date, status)
         VALUES ($1,$2,'Megger MIT510','CERT-9921','2027-03-01','active') RETURNING id`,
        [COMPANY_ID, `EQ_${S}`]);

      await pool.query(`
        INSERT INTO test_run_measurements
          (test_run_id, parameter_code, parameter_name, unit, measured_value,
           min_limit, max_limit, result, instrument_id, calibration_certificate_no,
           calibration_due_date, calibration_valid_at_test)
        VALUES ($1,'IR','Insulation resistance','MOhm',520,100,NULL,'pass',$2,'CERT-9921','2027-03-01',true)`,
        [tr.id, inst.id]);

      const res = await request(app)
        .get(`/api/genealogy/assembly/${encodeURIComponent(PANEL_A.serial_number)}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.tests.length).toBe(1);
      expect(res.body.tests[0].test_spec_revision).toBe('SPEC-R3');
      expect(res.body.tests[0].executed_by_name).toBe('Arun Tester');
      // A reading without the instrument that took it is a number, not evidence.
      expect(Number(res.body.tests[0].instrumented_count)).toBe(1);

      await pool.query('DELETE FROM test_run_measurements WHERE test_run_id=$1', [tr.id]);
      await pool.query('DELETE FROM test_runs WHERE id=$1', [tr.id]);
      await pool.query('DELETE FROM calibration_equipment WHERE id=$1', [inst.id]);
    });

    it('detects a quality stamp that disagrees with its inspections', async () => {
      // The backlog this view was built for is now resolved, so asserting that
      // conflicts EXIST would be asserting the bug is still there. What has to
      // hold is that the detector still works — proven by creating each kind of
      // contradiction and rolling it back.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const seen = async (id) => (await c.query(
          'SELECT conflict FROM v_iqc_status_conflicts WHERE grn_id=$1', [id])).rows[0]?.conflict;

        // inspected, but never released
        const { rows: [g1] } = await c.query(
          `INSERT INTO goods_receipt_notes (grn_number, company_id, status, quality_status, received_date)
           VALUES ($1,$2,'received','pending',CURRENT_DATE) RETURNING id`, [`CFA_${S}`, COMPANY_ID]);
        await c.query(
          `INSERT INTO quality_inspections (company_id, grn_id, overall_result, status, inspection_date)
           VALUES ($1,$2,'pass','active',CURRENT_DATE)`, [COMPANY_ID, g1.id]);
        expect(await seen(g1.id)).toBe('inspected_but_not_released');

        // exempt from inspection, yet inspected — the class that was found only
        // by noticing it in a diff
        const { rows: [g2] } = await c.query(
          `INSERT INTO goods_receipt_notes (grn_number, company_id, status, quality_status, received_date)
           VALUES ($1,$2,'received','not_required',CURRENT_DATE) RETURNING id`, [`CFB_${S}`, COMPANY_ID]);
        await c.query(
          `INSERT INTO quality_inspections (company_id, grn_id, overall_result, status, inspection_date)
           VALUES ($1,$2,'fail','active',CURRENT_DATE)`, [COMPANY_ID, g2.id]);
        expect(await seen(g2.id)).toBe('exempt_but_inspected');

        await c.query('ROLLBACK');
      } finally { c.release(); }
    });
  });

  /* ── finding 34: pick -> pack -> ship carries the unit ───────────────────── */

  describe('the reverse chain can start from a shipped unit', () => {
    it('carries the picked serial onto the package line and back onto the unit', async () => {
      const item = await mkItem('SHIP', 50);
      const lot  = await mkBatch(item, 5, 'SHIPLOT');
      const unit = await mkSerial('SHIP1', null, item);

      const { rows: [pl] } = await pool.query(
        `INSERT INTO pick_lists (company_id, sales_order_ref, status)
         VALUES ($1,$2,'completed') RETURNING id`, [COMPANY_ID, `PL_${S}`]);
      // Status 'completed' is what the pick route writes for a fully picked list;
      // packing now refuses a list in a state the workflow never produces (it
      // used to say 'picked', which nothing writes).
      // This line carries a bin, on a bin this suite creates itself, so the
      // "consumers reach a bin through the canonical table" assertion further
      // down stands on THIS suite's fixture. It used to pass on ambient rows left
      // by the 2026-08-20 empty-table seeder and went red the moment those five
      // dangling rows were cleaned up (20260926000002) — an assertion that rests
      // on data no test created is not really testing anything.
      const { rows: [pickBin] } = await pool.query(
        `INSERT INTO warehouse_bins (company_id, warehouse_id, row_code, shelf_code, bin_code, status)
         VALUES ($1,$2,'P','01',$3,'active') RETURNING id`,
        [COMPANY_ID, WAREHOUSE_ID, `PBIN_${S}`]);
      created.bins.push(pickBin.id);
      await pool.query(
        `INSERT INTO pick_list_lines
           (pick_list_id, item_id, item_name, batch_id, serial_id, required_qty, picked_qty, status, bin_id)
         VALUES ($1,$2,'Part SHIP',$3,$4,1,1,'picked',$5)`,
        [pl.id, item, lot, unit.id, pickBin.id]);

      const res = await request(app).post('/api/warehouse/pack')
        .set('Authorization', auth())
        .send({ pick_list_id: pl.id, package_type: 'carton' });
      expect(res.status).toBe(201);

      // The link that was 100% NULL across every row in the database.
      const line = res.body.lines.find(l => String(l.serial_id) === String(unit.id));
      expect(line).toBeTruthy();
      expect(String(line.batch_id)).toBe(String(lot));

      // And closed from the unit's own side, so "shipped" is provable rather
      // than a flag somebody set — the five unlinked serials the audit found.
      const { rows: [sn] } = await pool.query(
        'SELECT package_id, status FROM serial_numbers WHERE id=$1', [unit.id]);
      expect(sn.package_id).not.toBeNull();
      expect(sn.status).toBe('packed');
    });

    it('refuses to pack a serial that is not a unit of the line item', async () => {
      const itemA = await mkItem('SHIPA');
      const itemB = await mkItem('SHIPB');
      await mkBatch(itemA, 5, 'SHIPALOT');
      const wrongUnit = await mkSerial('WRONG', null, itemB);

      const { rows: [pl] } = await pool.query(
        `INSERT INTO pick_lists (company_id, sales_order_ref, status)
         VALUES ($1,$2,'completed') RETURNING id`, [COMPANY_ID, `PLX_${S}`]);
      // Packing refuses a list with nothing picked (it would put stock that
      // never left the shelf into a carton), so the list carries its pick.
      await pool.query(
        `INSERT INTO pick_list_lines (pick_list_id, item_id, item_name, required_qty, picked_qty, status)
         VALUES ($1,$2,'Part SHIPA',1,1,'completed')`, [pl.id, itemA]);

      const res = await request(app).post('/api/warehouse/pack')
        .set('Authorization', auth())
        .send({
          pick_list_id: pl.id,
          lines: [{ item_id: itemA, quantity: 1, serial_number: wrongUnit.serial_number }],
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SERIAL_ITEM_MISMATCH');
    });
  });

  /* ── finding 37: the scenario the brief specifies ────────────────────────── */

  describe('receive 100, accept 95, reject 5 — and the lot still balances', () => {
    it('keeps the rejected quantity out of available stock and records it', async () => {
      const item = await mkItem('IQC', 30);
      // 100 received; 95 accepted into stock, 5 rejected at inspection.
      const { rows: [b] } = await pool.query(`
        INSERT INTO inventory_batches
          (company_id, item_id, warehouse_id, batch_number, quantity_received,
           quantity_available, quantity_rejected, status, rate, supplier_batch_no)
        VALUES ($1,$2,$3,$4,100,95,5,'active',30,'SUP-IQC-1') RETURNING id`,
        [COMPANY_ID, item, WAREHOUSE_ID, `IQCLOT_${S}`]);
      created.batches.push(b.id);

      const { rows: [row] } = await pool.query(
        `SELECT quantity_received, quantity_available, quantity_rejected,
                quantity_consumed, quantity_in_wip, quantity_returned
           FROM inventory_batches WHERE id = $1`, [b.id]);

      const received = Number(row.quantity_received);
      const accounted = Number(row.quantity_available) + Number(row.quantity_rejected)
                      + Number(row.quantity_consumed) + Number(row.quantity_in_wip)
                      + Number(row.quantity_returned);
      // The forward question balances: nothing has gone missing.
      expect(accounted).toBe(received);
      expect(Number(row.quantity_rejected)).toBe(5);
      // Rejected stock is NOT available to issue.
      expect(Number(row.quantity_available)).toBe(95);
    });

    it('a negative disposition bucket is refused by the database', async () => {
      const item = await mkItem('NEGB', 10);
      await expect(pool.query(
        `INSERT INTO inventory_batches
           (company_id, item_id, warehouse_id, batch_number, quantity_received,
            quantity_available, quantity_rejected, status, rate)
         VALUES ($1,$2,$3,$4,10,10,-1,'active',1)`,
        [COMPANY_ID, item, WAREHOUSE_ID, `NEGBLOT_${S}`]
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  /* ── finding 5 / 18: a lot has a bin, and the two bin tables reconcile ───── */

  describe('location resolves to a bin', () => {
    it('left exactly one bin table, and no legacy bin is mapped twice', async () => {
      // bin_locations — the rival table with no company_id — was mapped into
      // warehouse_bins by 20260915000017 and dropped by 20260916000001.
      // §226: "the legacy rows were carried" counted one database's legacy bins
      // (a fresh database has none to carry). That the pair carries every
      // placeable legacy bin exactly once, links twins, refuses an incomplete
      // mapping and rolls back is proven in migrationFixture.binCutover.
      // What holds everywhere: the rival table is gone, no legacy id appears
      // twice, and the unique index that guarantees it is in place.
      const { rows: [r] } = await pool.query(`
        SELECT to_regclass('public.bin_locations') IS NULL           AS legacy_gone,
               to_regclass('public.uq_warehouse_bins_legacy') IS NOT NULL AS unique_guard,
               COUNT(*) FILTER (WHERE legacy_bin_location_id IS NOT NULL)::int AS carried,
               COUNT(DISTINCT legacy_bin_location_id)::int           AS distinct_carried
          FROM warehouse_bins`);
      expect(r.legacy_gone).toBe(true);
      expect(r.unique_guard).toBe(true);
      expect(r.distinct_carried).toBe(r.carried);

      // And the consumers now reach a bin through the canonical table.
      const { rows: [p] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pick_list_lines pll
           JOIN warehouse_bins wb ON wb.id = pll.bin_id`);
      expect(p.n).toBeGreaterThan(0);
    });

    it('carries a bin on a lot, and refuses two lots in one bin slot by code', async () => {
      const { rows: [bin] } = await pool.query(
        `INSERT INTO warehouse_bins (company_id, warehouse_id, row_code, shelf_code, bin_code, status)
         VALUES ($1,$2,'A','01',$3,'active') RETURNING id`,
        [COMPANY_ID, WAREHOUSE_ID, `BIN_${S}`]);
      const item = await mkItem('BINNED');
      const lot = await mkBatch(item, 10, 'BINLOT');
      await pool.query('UPDATE inventory_batches SET bin_id=$2 WHERE id=$1', [lot, bin.id]);

      const { rows: [r] } = await pool.query(`
        SELECT b.bin_id, wb.bin_code, w.name AS warehouse_name
          FROM inventory_batches b
          JOIN warehouse_bins wb ON wb.id = b.bin_id
          JOIN warehouses w ON w.id = wb.warehouse_id
         WHERE b.id = $1`, [lot]);
      expect(r.bin_code).toBe(`BIN_${S}`);

      // A bin code means one physical place within a store.
      await expect(pool.query(
        `INSERT INTO warehouse_bins (company_id, warehouse_id, row_code, shelf_code, bin_code, status)
         VALUES ($1,$2,'A','01',$3,'active')`, [COMPANY_ID, WAREHOUSE_ID, `BIN_${S}`]
      )).rejects.toMatchObject({ code: '23505' });

      await pool.query('UPDATE inventory_batches SET bin_id=NULL WHERE id=$1', [lot]);
      await pool.query('DELETE FROM warehouse_bins WHERE id=$1', [bin.id]);
    });
  });

  /* ── findings 16 & 34: an unsupported claim cannot be made again ─────────── */

  describe('a record cannot assert what no evidence supports', () => {
    it('refuses to release a GRN that has no incoming inspection', async () => {
      const { rows: [g] } = await pool.query(
        `INSERT INTO goods_receipt_notes (grn_number, company_id, status, quality_status, received_date)
         VALUES ($1,$2,'received','pending',CURRENT_DATE) RETURNING id`, [`GRNEV_${S}`, COMPANY_ID]);
      created.grns.push(g.id);

      // This is the exact shape of the five rows the audit found: a pass with
      // nothing behind it.
      await expect(pool.query(
        `UPDATE goods_receipt_notes SET quality_status='passed' WHERE id=$1`, [g.id]
      )).rejects.toMatchObject({ code: '23514' });
    });

    it('allows the release once the inspection actually exists', async () => {
      const { rows: [g] } = await pool.query(
        `INSERT INTO goods_receipt_notes (grn_number, company_id, status, quality_status, received_date)
         VALUES ($1,$2,'received','pending',CURRENT_DATE) RETURNING id`, [`GRNOK_${S}`, COMPANY_ID]);
      created.grns.push(g.id);
      await pool.query(
        `INSERT INTO quality_inspections (company_id, grn_id, overall_result, status, inspection_date)
         VALUES ($1,$2,'pass','active',CURRENT_DATE)`, [COMPANY_ID, g.id]);

      await pool.query(`UPDATE goods_receipt_notes SET quality_status='passed' WHERE id=$1`, [g.id]);
      const { rows: [after] } = await pool.query(
        'SELECT quality_status FROM goods_receipt_notes WHERE id=$1', [g.id]);
      expect(after.quality_status).toBe('passed');
    });

    it('refuses to TRANSITION a unit to shipped with no package accounting for it', async () => {
      const item = await mkItem('SHIPGUARD');
      const unit = await mkSerial('SG1', null, item);
      await expect(pool.query(
        `UPDATE serial_numbers SET status='shipped' WHERE id=$1`, [unit.id]
      )).rejects.toMatchObject({ code: '23514' });
    });

    it('loads a historical unit in a shipped state only together with the package that shipped it', async () => {
      // Phase 3I (migration 20261028000008) reverses 20260916000005's decision
      // to let a unit be INSERTED already shipped with nothing behind it and
      // merely detect it: no path needs that any more (POST /inventory/serials
      // refuses shipped statuses; the IoT fixture loads its unit with a
      // package), and the detected rows broke this suite's empty-worklist
      // assertion whenever another suite's fixture was in flight. A historical
      // import loads the unit and the package line that accounts for it in one
      // transaction — the check runs at commit.
      const item = await mkItem('SHIPHIST');
      await expect(pool.query(
        `INSERT INTO serial_numbers (company_id, serial_number, item_id, status)
         VALUES ($1,$2,$3,'shipped') RETURNING id`, [COMPANY_ID, `SN_HIST_BARE_${S}`, item]))
        .rejects.toMatchObject({ code: '23514' });

      const t = await pool.connect();
      let s2;
      try {
        await t.query('BEGIN');
        ({ rows: [s2] } = await t.query(
          `INSERT INTO serial_numbers (company_id, serial_number, item_id, status)
           VALUES ($1,$2,$3,'shipped') RETURNING id`, [COMPANY_ID, `SN_HIST_${S}`, item]));
        const { rows: [p] } = await t.query(
          `INSERT INTO packages (company_id, package_no, status) VALUES ($1, $2, 'shipped') RETURNING id`, [COMPANY_ID, `PKG_HIST_${S}`]);
        await t.query(`INSERT INTO package_lines (package_id, company_id, item_id, serial_id, quantity) VALUES ($1,$2,$3,$4,1)`,
          [p.id, COMPANY_ID, item, s2.id]);
        await t.query('COMMIT');
      } catch (e) { await t.query('ROLLBACK'); throw e; } finally { t.release(); }
      created.serials.push(s2.id);

      const { rows } = await pool.query(
        'SELECT 1 FROM v_shipped_serials_unlinked WHERE serial_id=$1', [s2.id]);
      expect(rows.length).toBe(0);   // accounted for, so not on the worklist

      await pool.query('DELETE FROM serial_numbers WHERE id=$1', [s2.id]);
    });

    it('leaves both worklists empty — the backlog is resolved, not relabelled', async () => {
      const { rows: [r] } = await pool.query(`
        SELECT (SELECT COUNT(*)::int FROM v_iqc_status_conflicts)        AS iqc,
               (SELECT COUNT(*)::int FROM v_shipped_serials_unlinked)    AS shipped`);
      expect(r.iqc).toBe(0);
      expect(r.shipped).toBe(0);
    });

    it('preserved the original value of every record it corrected', async () => {
      // Withdrawing an unsupported claim must be auditable, or it is just a
      // different kind of unrecorded change.
      // §226: "rows.length > 0" counted one database's corrected GRNs. Which
      // GRNs 20260916000003/000004 correct, to what, and with which note is
      // proven in migrationFixture.grnQualityEvidence. What holds everywhere:
      // no prior value without its reason, and the release guard is installed.
      const { rows } = await pool.query(`
        SELECT quality_status_prior, quality_status_prior_note
          FROM goods_receipt_notes WHERE quality_status_prior IS NOT NULL`);
      expect(rows.filter(r => !r.quality_status_prior_note)).toEqual([]);
      const { rows: trg } = await pool.query(
        `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_grn_release_requires_inspection' AND NOT tgisinternal`);
      expect(trg).toHaveLength(1);
    });
  });

  /* ── finding 32: scanning ───────────────────────────────────────────────── */

  describe('a scanner can identify and move stock', () => {
    let scanItem, scanLot, binA, binB;

    it('resolves one opaque code to the right kind of thing', async () => {
      scanItem = await mkItem('SCAN', 20);
      scanLot = await mkBatch(scanItem, 40, 'SCANLOT');
      const { rows: [b] } = await pool.query(
        'SELECT batch_number FROM inventory_batches WHERE id=$1', [scanLot]);

      const res = await request(app).get(`/api/scan/resolve?code=${encodeURIComponent(b.batch_number)}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('batch');
      expect(String(res.body.id)).toBe(String(scanLot));
    });

    it('resolves a supplier lot number, which is what a defect notice quotes', async () => {
      await pool.query(
        `UPDATE inventory_batches SET supplier_batch_no=$2 WHERE id=$1`, [scanLot, `SUP_${S}`]);
      const res = await request(app).get(`/api/scan/resolve?code=SUP_${S}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('batch');
      expect(String(res.body.id)).toBe(String(scanLot));
    });

    it('refuses an unknown code rather than returning a near match', async () => {
      const res = await request(app).get(`/api/scan/resolve?code=NOSUCHCODE_${S}`)
        .set('Authorization', auth());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SCAN_UNKNOWN');
    });

    it('refuses an ambiguous code instead of guessing a precedence order', async () => {
      // One string that is both an item code and a bin code. A silent precedence
      // rule here is how the wrong thing gets moved.
      const dup = `DUP_${S}`;
      const { rows: [i] } = await pool.query(
        `INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost)
         VALUES ($1,$2,'Ambiguous part',0,1) RETURNING id`, [COMPANY_ID, dup]);
      created.items.push(i.id);
      const { rows: [bn] } = await pool.query(
        `INSERT INTO warehouse_bins (company_id, warehouse_id, row_code, shelf_code, bin_code, status)
         VALUES ($1,$2,'Z','9',$3,'active') RETURNING id`, [COMPANY_ID, WAREHOUSE_ID, dup]);
      created.bins.push(bn.id);

      const res = await request(app).get(`/api/scan/resolve?code=${dup}`).set('Authorization', auth());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SCAN_AMBIGUOUS');
      expect(res.body.candidates.map(c => c.type).sort()).toEqual(['bin', 'item']);
    });

    it('moves a lot between bins on two scans, and records the route on the ledger', async () => {
      const mk = async (code) => {
        const { rows: [b] } = await pool.query(
          `INSERT INTO warehouse_bins (company_id, warehouse_id, row_code, shelf_code, bin_code, status)
           VALUES ($1,$2,'A','01',$3,'active') RETURNING id`, [COMPANY_ID, WAREHOUSE_ID, code]);
        created.bins.push(b.id);
        return b.id;
      };
      binA = await mk(`BINA_${S}`);
      binB = await mk(`BINB_${S}`);
      await pool.query('UPDATE inventory_batches SET bin_id=$2 WHERE id=$1', [scanLot, binA]);

      const { rows: [lotRow] } = await pool.query(
        'SELECT batch_number FROM inventory_batches WHERE id=$1', [scanLot]);
      const before = await pool.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out),0) bal FROM stock_ledger WHERE item_id=$1`, [scanItem]);

      const res = await request(app).post('/api/scan/move').set('Authorization', auth())
        .send({ lot_code: lotRow.batch_number, to_bin_code: `BINB_${S}` });
      expect(res.status).toBe(201);

      const { rows: [lot] } = await pool.query('SELECT bin_id FROM inventory_batches WHERE id=$1', [scanLot]);
      expect(String(lot.bin_id)).toBe(String(binB));

      const { rows: [led] } = await pool.query(
        `SELECT from_bin_id, to_bin_id, batch_id, reason_code FROM stock_ledger
          WHERE item_id=$1 ORDER BY id DESC LIMIT 1`, [scanItem]);
      expect(String(led.from_bin_id)).toBe(String(binA));
      expect(String(led.to_bin_id)).toBe(String(binB));
      expect(String(led.batch_id)).toBe(String(scanLot));
      expect(led.reason_code).toBe('scan_bin_transfer');

      // A relocation is not a quantity change. Writing only one side would
      // silently alter stock on hand.
      const after = await pool.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out),0) bal FROM stock_ledger WHERE item_id=$1`, [scanItem]);
      expect(Number(after.rows[0].bal)).toBe(Number(before.rows[0].bal));
    });

    it('refuses to relocate a quarantined lot without a stated reason', async () => {
      const qItem = await mkItem('SCANQ');
      const qLot = await mkBatch(qItem, 5, 'SCANQLOT', 'quarantine');
      const { rows: [l] } = await pool.query('SELECT batch_number FROM inventory_batches WHERE id=$1', [qLot]);
      const res = await request(app).post('/api/scan/move').set('Authorization', auth())
        .send({ lot_code: l.batch_number, to_bin_code: `BINB_${S}` });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('QC_BLOCKED_NEEDS_REASON');
    });

    it('shows what is physically in a scanned bin', async () => {
      const res = await request(app).get(`/api/scan/bin/BINB_${S}`).set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.lot_count).toBeGreaterThan(0);
      expect(res.body.lots.some(l => String(l.id) === String(scanLot))).toBe(true);
    });
  });

  /* ── finding 23: the component's own dossier ─────────────────────────────── */

  describe('one call returns everything known about a component', () => {
    it('returns all eleven sections, with a reason for each empty one', async () => {
      const item = await mkItem('DOSSIER', 33);
      const lot = await mkBatch(item, 12, 'DOSSIERLOT');

      const res = await request(app).get(`/api/genealogy/component/batch/${lot}`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);

      for (const k of ['procurement', 'locationHistory', 'inventoryTransactions', 'materialIssues',
                       'assembly', 'panelsUsedIn', 'quality', 'rework', 'documents', 'auditTrail']) {
        expect(Array.isArray(res.body[k])).toBe(true);
      }
      expect(res.body.summary.quantity_received).toBe(12);
      // An absent section and an empty one look identical to a screen; the
      // difference is what someone chasing a defect needs.
      expect(res.body.notes.assembly).toMatch(/assembly/i);
      expect(res.body.notes.quality).toMatch(/inspection/i);
    });

    it('refuses an anchor type it cannot open, rather than returning an empty dossier', async () => {
      const res = await request(app).get('/api/genealogy/component/purchase_order/1')
        .set('Authorization', auth());
      expect(res.status).toBe(400);
    });

    it('404s an unknown component instead of an empty one', async () => {
      const res = await request(app).get('/api/genealogy/component/batch/99999999')
        .set('Authorization', auth());
      expect(res.status).toBe(404);
    });
  });

});
