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
    try {
      envText = readFileSync(resolve(here, '../.env'), 'utf8');
    } catch {
      throw new Error('Neither DATABASE_URL nor .env is available');
    }
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

const { default: genealogyRoutes } = await import('../modules/production/genealogy.routes.js');
const { default: procurementRoutes } = await import('../modules/procurement/routes/procurement.routes.js');
const { default: planningRoutes } = await import('../modules/inventory/routes/planning.routes.js');
const { default: planningService } = await import('../modules/inventory/services/inventoryPlanning.service.js');

const genealogyApp = buildApp(['/api/genealogy', verifyToken, genealogyRoutes]);
const procApp = buildApp(['/api/procurement', verifyToken, procurementRoutes]);
const planningApp = buildApp(['/api/inventory/planning', verifyToken, planningRoutes]);

const TAG = `ZZGEN_${Date.now()}`;
let COMPANY_A_ID;
let COMPANY_B_ID;
let USER_A_ID;
let USER_B_ID;
let EMPLOYEE_A_ID;
let WAREHOUSE_A_ID;

const created = {
  companies: [],
  users: [],
  user_scope: [],
  user_roles: [],
  employees: [],
  warehouses: [],
  bins: [],
  items: [],
  suppliers: [],
  pos: [],
  grns: [],
  batches: [],
  production_orders: [],
  issue_logs: [],
  test_runs: [],
  sales_orders: [],
  serials: []
};

describe('Phase 2: Enterprise Inventory, Material Genealogy & Complete Traceability', () => {
  beforeAll(async () => {
    const compARes = await pool.query(
      'INSERT INTO companies (name, code, is_active) VALUES ($1, $2, true) RETURNING id',
      [`Company A ${TAG}`, `CA_${TAG.slice(-6)}`]
    );
    COMPANY_A_ID = compARes.rows[0].id;
    created.companies.push(COMPANY_A_ID);

    const compBRes = await pool.query(
      'INSERT INTO companies (name, code, is_active) VALUES ($1, $2, true) RETURNING id',
      [`Company B ${TAG}`, `CB_${TAG.slice(-6)}`]
    );
    COMPANY_B_ID = compBRes.rows[0].id;
    created.companies.push(COMPANY_B_ID);

    const empARes = await pool.query(
      // Backtick, not a single-quoted string: ${FIXTURE_CODE_SQL} has to actually
      // interpolate. Left in a plain '...' string it reached Postgres verbatim and
      // failed with `syntax error at or near "$"`.
      `INSERT INTO employees (office_id, company_id, first_name, last_name, company_email)
       VALUES (${FIXTURE_CODE_SQL}, $1, 'John', 'Doe', $2) RETURNING id`,
      [COMPANY_A_ID, `admin_a_${TAG}@pulse.test`]
    );
    EMPLOYEE_A_ID = empARes.rows[0].id;
    created.employees.push(EMPLOYEE_A_ID);

    const userARes = await pool.query(
      'INSERT INTO users (email, password_hash, role, company_id, name, employee_id, is_active) VALUES ($1, \'dummy_hash\', \'admin\', $2, \'Admin A\', $3, true) RETURNING id',
      [`admin_a_${TAG}@pulse.test`, COMPANY_A_ID, EMPLOYEE_A_ID]
    );
    USER_A_ID = userARes.rows[0].id;
    created.users.push(USER_A_ID);

    const userBRes = await pool.query(
      'INSERT INTO users (email, password_hash, role, company_id, name, is_active) VALUES ($1, \'dummy_hash\', \'admin\', $2, \'Admin B\', true) RETURNING id',
      [`admin_b_${TAG}@pulse.test`, COMPANY_B_ID]
    );
    USER_B_ID = userBRes.rows[0].id;
    created.users.push(USER_B_ID);

    await pool.query('INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true), ($3, $4, true)', [USER_A_ID, COMPANY_A_ID, USER_B_ID, COMPANY_B_ID]);

    const { rows: adminRoleRows } = await pool.query("SELECT id FROM roles WHERE LOWER(code) = 'admin' LIMIT 1");
    if (adminRoleRows[0]) {
      const rId = adminRoleRows[0].id;
      await pool.query('INSERT INTO user_roles (user_id, role_id, is_primary) VALUES ($1, $3, true), ($2, $3, true)', [USER_A_ID, USER_B_ID, rId]);
    }

    const whRes = await pool.query(
      'INSERT INTO warehouses (name, warehouse_code, company_id) VALUES ($1, $2, $3) RETURNING id',
      [`Main Plant WH ${TAG}`, `WH_${TAG.slice(-4)}`, COMPANY_A_ID]
    );
    WAREHOUSE_A_ID = whRes.rows[0].id;
    created.warehouses.push(WAREHOUSE_A_ID);

    const binRes = await pool.query(
      'INSERT INTO warehouse_bins (warehouse_id, bin_code, row_code, shelf_code, company_id, current_qty) VALUES ($1, \'BIN-A1\', \'RACK-1\', \'SHELF-1\', $2, 0) RETURNING id',
      [WAREHOUSE_A_ID, COMPANY_A_ID]
    );
    created.bins.push(binRes.rows[0].id)
  });

  afterAll(async () => {
    /**
     * Each statement is isolated.
     *
     * This was ONE try/catch around all twenty deletes, so the first FK
     * violation skipped every delete after it — including `users` and
     * `companies` at the very bottom. The suite still passed (the error only
     * reached console.error), and the database accumulated ACTIVE ADMIN LOGINS,
     * one pair per run: 18 of the 19 active `admin` holders on this database
     * were this suite's debris.
     *
     * That is not only untidy. integration.procurementVendorSurface binds its
     * actors by picking a role holder out of `users`, so leaked admins are live
     * fixtures that other suites can select — and the pair belonging to the
     * currently-running genealogy suite is deleted from under them mid-run.
     *
     * Deleting in the same dependency order, but per statement, means a row that
     * cannot go yet costs only its own line.
     */
    const drop = async (label, sql, params) => {
      try { await pool.query(sql, params); }
      catch (err) { console.error(`Teardown (${label}):`, err.message); }
    };
    try {
      if (created.issue_logs.length) await pool.query('DELETE FROM material_issue_logs WHERE id = ANY($1)', [created.issue_logs]);
      if (created.serials.length) await pool.query('DELETE FROM serial_numbers WHERE id = ANY($1)', [created.serials]);
      if (created.test_runs.length) {
        await pool.query('DELETE FROM test_run_measurements WHERE test_run_id = ANY($1)', [created.test_runs]);
        await pool.query('DELETE FROM test_runs WHERE id = ANY($1)', [created.test_runs]);
      }
      if (created.production_orders.length) await pool.query('DELETE FROM production_orders WHERE id = ANY($1)', [created.production_orders]);
      if (created.sales_orders.length) await pool.query('DELETE FROM sales_orders WHERE id = ANY($1)', [created.sales_orders]);
      if (created.batches.length) await pool.query('DELETE FROM inventory_batches WHERE id = ANY($1)', [created.batches]);
      if (created.grns.length) {
        await pool.query('DELETE FROM grn_items WHERE grn_id = ANY($1)', [created.grns]);
        await pool.query('DELETE FROM goods_receipt_notes WHERE id = ANY($1)', [created.grns]);
      }
      if (created.pos.length) {
        await pool.query('DELETE FROM purchase_order_items WHERE po_id = ANY($1)', [created.pos]);
        await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [created.pos]);
      }
      if (created.suppliers.length) await pool.query('DELETE FROM vendors WHERE id = ANY($1)', [created.suppliers]);
      if (created.items.length) {
        await pool.query('DELETE FROM stock_ledger WHERE item_id = ANY($1)', [created.items]);
        await pool.query('DELETE FROM inventory_items WHERE id = ANY($1)', [created.items]);
      }
      if (created.bins.length) await pool.query('DELETE FROM warehouse_bins WHERE id = ANY($1)', [created.bins]);
      if (created.warehouses.length) await pool.query('DELETE FROM warehouses WHERE id = ANY($1)', [created.warehouses]);
    } catch (err) {
      console.error('Teardown error:', err);
    }

    // The identity rows come OUT of the try above: they are the ones that leak,
    // and they must be attempted whatever happened to the rows before them.
    if (created.users.length) {
      await drop('user_roles', 'DELETE FROM user_roles WHERE user_id = ANY($1)', [created.users]);
      await drop('user_scope', 'DELETE FROM user_scope WHERE user_id = ANY($1)', [created.users]);
      await drop('users',      'DELETE FROM users WHERE id = ANY($1)', [created.users]);
    }
    if (created.employees.length) await drop('employees', 'DELETE FROM employees WHERE id = ANY($1)', [created.employees]);
    if (created.companies.length) await drop('companies', 'DELETE FROM companies WHERE id = ANY($1)', [created.companies]);
  });

  const authA = () => `Bearer ${makeToken({ userId: USER_A_ID, employee_id: EMPLOYEE_A_ID, company_id: COMPANY_A_ID, roles: ['admin'] })}`;
  const authB = () => `Bearer ${makeToken({ userId: USER_B_ID, company_id: COMPANY_B_ID, roles: ['admin'] })}`;

  describe('1. GRN Transaction Rollback Boundary', () => {
    it('should roll back completely on failure with zero orphan batches or corrupted stock', async () => {
      const itemRes = await pool.query(
        'INSERT INTO inventory_items (company_id, item_code, item_name, current_stock) VALUES ($1, $2, \'Relay 24V DC\', 0) RETURNING id',
        [COMPANY_A_ID, `RELAY_${TAG.slice(-4)}`]
      );
      const itemId = itemRes.rows[0].id;
      created.items.push(itemId);

      const suppRes = await pool.query(
        'INSERT INTO vendors (company_id, vendor_name, vendor_code) VALUES ($1, \'Schneider Electric\', $2) RETURNING id',
        [COMPANY_A_ID, `SCH_${TAG.slice(-4)}`]
      );
      const suppId = suppRes.rows[0].id;
      created.suppliers.push(suppId);

      const poRes = await pool.query(
        'INSERT INTO purchase_orders (company_id, po_number, supplier_id, status, total_amount) VALUES ($1, $2, $3, \'issued\', 5000) RETURNING id',
        [COMPANY_A_ID, `PO_FAIL_${TAG.slice(-4)}`, suppId]
      );
      const poId = poRes.rows[0].id;
      created.pos.push(poId);

      const batchesBefore = await pool.query('SELECT COUNT(*) FROM inventory_batches WHERE company_id = $1', [COMPANY_A_ID]);
      const countBefore = parseInt(batchesBefore.rows[0].count, 10);

      const res = await request(procApp)
        .post('/api/procurement/grn')
        .set('Authorization', authA())
        .send({
          po_id: poId,
          supplier_id: suppId,
          items: [{ item_id: '00000000-0000-0000-0000-000000000000', received_qty: 50, accepted_qty: 50 }]
        });

      expect(res.status).toBeGreaterThanOrEqual(400);

      const batchesAfter = await pool.query('SELECT COUNT(*) FROM inventory_batches WHERE company_id = $1', [COMPANY_A_ID]);
      const countAfter = parseInt(batchesAfter.rows[0].count, 10);
      expect(countAfter).toBe(countBefore);

      const stockRes = await pool.query('SELECT current_stock FROM inventory_items WHERE id = $1', [itemId]);
      expect(parseFloat(stockRes.rows[0].current_stock)).toBe(0);
    });
  });

  describe('2. Multi-Tenant Penetration & Company Isolation', () => {
    let orderAId;

    beforeAll(async () => {
      const poARes = await pool.query(
        'INSERT INTO production_orders (company_id, production_order_no, product_name, quantity_planned, status, batch_number, serial_number) VALUES ($1, $2, \'Traceability Test Assembly\', 1, \'completed\', $3, $4) RETURNING id',
        [COMPANY_A_ID, `WO_TENANT_${TAG.slice(-4)}`, `BATCH_A_${TAG.slice(-4)}`, `SN_A_${TAG.slice(-4)}`]
      );
      orderAId = poARes.rows[0].id;
      created.production_orders.push(orderAId);
    });

    it('Company B cannot discover or search Company A orders/batches', async () => {
      const res = await request(genealogyApp)
        .get('/api/genealogy/search')
        .set('Authorization', authB())
        .query({ q: `WO_TENANT_${TAG.slice(-4)}` });

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('Company B cannot trace Company A production order graph', async () => {
      const res = await request(genealogyApp)
        .get('/api/genealogy/trace')
        .set('Authorization', authB())
        .query({ type: 'production_order', id: orderAId });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('Company B cannot access Company A As-Built BOM', async () => {
      const res = await request(genealogyApp)
        .get(`/api/genealogy/as-built/${orderAId}`)
        .set('Authorization', authB());

      expect(res.status).toBe(404);
    });

    it('Company B cannot access Company A QC History', async () => {
      const res = await request(genealogyApp)
        .get(`/api/genealogy/qc-history/${orderAId}`)
        .set('Authorization', authB());

      expect(res.status).toBe(404);
    });
  });

  describe('3. Inventory Planning & Statistical Formulas', () => {
    it('calculates EOQ = sqrt(2DS/H) and Safety Stock = z * sigma * sqrt(L)', () => {
      const eoq = planningService.calculateEOQ(1000, 50, 40);
      expect(eoq).toBeCloseTo(50, 0);

      const ss = planningService.calculateSafetyStock(3.5, 14, 0.95);
      expect(ss).toBeGreaterThan(20);
      expect(ss).toBeLessThan(23);

      const rop = planningService.calculateDynamicROP(10, 14, 21.5);
      expect(rop).toBeCloseTo(161.5, 1);
    });

    it('performs ABC Pareto classification with 80/15/5 cumulative value boundaries', () => {
      const sampleItems = [
        { id: '1', annual_usage_value: 80000 },
        { id: '2', annual_usage_value: 15000 },
        { id: '3', annual_usage_value: 5000 }
      ];
      const classified = planningService.classifyABCPareto(sampleItems);
      expect(classified[0].abc_class).toBe('A');
      expect(classified[1].abc_class).toBe('B');
      expect(classified[2].abc_class).toBe('C');
    });
  });

  describe('4. Complete E2E Manufacturing Scenario & Bidirectional Genealogy', () => {
    let rawItemId;
    let supplierId;
    let poId;
    let grnId;
    let batchId1;
    let batchId2;
    let batchId3;
    let prodOrderId1;
    let salesOrderId;

    it('executes full procurement -> IQC -> batching -> WO issue -> rework -> QC -> dispatch lifecycle', async () => {
      const itemRes = await pool.query(
        'INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost) VALUES ($1, $2, \'ABB MCB 16A 3-Pole\', 0, 45.00) RETURNING id',
        [COMPANY_A_ID, `MCB16A_${TAG.slice(-4)}`]
      );
      rawItemId = itemRes.rows[0].id;
      created.items.push(rawItemId);

      const suppRes = await pool.query(
        'INSERT INTO vendors (company_id, vendor_name, vendor_code) VALUES ($1, \'ABB India Ltd\', $2) RETURNING id',
        [COMPANY_A_ID, `ABB_${TAG.slice(-4)}`]
      );
      supplierId = suppRes.rows[0].id;
      created.suppliers.push(supplierId);

      const poRes = await pool.query(
        'INSERT INTO purchase_orders (company_id, po_number, supplier_id, status, total_amount) VALUES ($1, $2, $3, \'approved\', 4500) RETURNING id',
        [COMPANY_A_ID, `PO_ABB_${TAG.slice(-4)}`, supplierId]
      );
      poId = poRes.rows[0].id;
      created.pos.push(poId);

      const grnRes = await pool.query(
        'INSERT INTO goods_receipt_notes (company_id, grn_number, po_id, status, received_date) VALUES ($1, $2, $3, \'received\', NOW()) RETURNING id',
        [COMPANY_A_ID, `GRN_${TAG.slice(-4)}`, poId]
      );
      grnId = grnRes.rows[0].id;
      created.grns.push(grnId);

      await pool.query(
        'INSERT INTO grn_items (grn_id, item_id, quantity_received, quantity_rejected, rate) VALUES ($1, $2, 100, 5, 45.00)',
        [grnId, rawItemId]
      );

      const b1Res = await pool.query(
        'INSERT INTO inventory_batches (company_id, item_id, batch_number, grn_id, warehouse_id, supplier_id, quantity_received, quantity_available, quantity_consumed, status) VALUES ($1, $2, $3, $4, $5, $6, 40, 40, 0, \'active\') RETURNING id',
        [COMPANY_A_ID, rawItemId, `BATCH_LOT_01_${TAG.slice(-4)}`, grnId, WAREHOUSE_A_ID, supplierId]
      );
      batchId1 = b1Res.rows[0].id;
      created.batches.push(batchId1);

      const b2Res = await pool.query(
        'INSERT INTO inventory_batches (company_id, item_id, batch_number, grn_id, warehouse_id, supplier_id, quantity_received, quantity_available, quantity_consumed, status) VALUES ($1, $2, $3, $4, $5, $6, 35, 35, 0, \'active\') RETURNING id',
        [COMPANY_A_ID, rawItemId, `BATCH_LOT_02_${TAG.slice(-4)}`, grnId, WAREHOUSE_A_ID, supplierId]
      );
      batchId2 = b2Res.rows[0].id;
      created.batches.push(batchId2);

      const b3Res = await pool.query(
        'INSERT INTO inventory_batches (company_id, item_id, batch_number, grn_id, warehouse_id, supplier_id, quantity_received, quantity_available, quantity_consumed, status) VALUES ($1, $2, $3, $4, $5, $6, 20, 20, 0, \'active\') RETURNING id',
        [COMPANY_A_ID, rawItemId, `BATCH_LOT_03_${TAG.slice(-4)}`, grnId, WAREHOUSE_A_ID, supplierId]
      );
      batchId3 = b3Res.rows[0].id;
      created.batches.push(batchId3);

      const soRes = await pool.query(
        'INSERT INTO sales_orders (company_id, order_number, customer_name, order_status, total_amount) VALUES ($1, $2, \'Larsen & Toubro Ltd\', \'CONFIRMED\', 125000) RETURNING id',
        [COMPANY_A_ID, `SO_LT_${TAG.slice(-4)}`]
      );
      salesOrderId = soRes.rows[0].id;
      created.sales_orders.push(salesOrderId);

      const po1Res = await pool.query(
        'INSERT INTO production_orders (company_id, production_order_no, product_name, quantity_planned, sales_order_id, status, batch_number, serial_number) VALUES ($1, $2, \'Control Panel 400A\', 1, $3, \'in_progress\', $4, $5) RETURNING id',
        [COMPANY_A_ID, `WO_PANEL_01_${TAG.slice(-4)}`, salesOrderId, `BATCH_FG1_${TAG.slice(-4)}`, `SN_PANEL_001_${TAG.slice(-4)}`]
      );
      prodOrderId1 = po1Res.rows[0].id;
      created.production_orders.push(prodOrderId1);

      const log1Res = await pool.query(
        'INSERT INTO material_issue_logs (company_id, production_order_id, item_id, item_name, batch_id, qty_issued, issued_by_name) VALUES ($1, $2, $3, (SELECT item_name FROM inventory_items WHERE id = $3), $4, 30, \'Vikram Tech\') RETURNING id',
        [COMPANY_A_ID, prodOrderId1, rawItemId, batchId1]
      );
      created.issue_logs.push(log1Res.rows[0].id);

      await pool.query('UPDATE inventory_batches SET quantity_available = 10, quantity_consumed = 30 WHERE id = $1', [batchId1]);

      const logReworkRes = await pool.query(
        'INSERT INTO material_issue_logs (company_id, production_order_id, item_id, item_name, batch_id, qty_issued, notes, issued_by_name) VALUES ($1, $2, $3, (SELECT item_name FROM inventory_items WHERE id = $3), $4, 1, \'REWORK: Defective Trip Coil on Bench Test\', \'QC Inspector Rajesh\') RETURNING id',
        [COMPANY_A_ID, prodOrderId1, rawItemId, batchId2]
      );
      created.issue_logs.push(logReworkRes.rows[0].id);

      await pool.query('UPDATE inventory_batches SET quantity_available = 34, quantity_consumed = 1 WHERE id = $1', [batchId2]);

      const trRes = await pool.query(
        'INSERT INTO test_runs (company_id, production_order_id, run_number, test_type, overall_result, executed_by_name) VALUES ($1, $2, $3, \'HV Insulation & Dielectric\', \'pass\', \'Senior QA Engineer Anita\') RETURNING id',
        [COMPANY_A_ID, prodOrderId1, `TR_${TAG.slice(-4)}`]
      );
      const testRunId = trRes.rows[0].id;
      created.test_runs.push(testRunId);

      await pool.query(
        'INSERT INTO test_run_measurements (test_run_id, parameter_name, target_value, min_limit, max_limit, measured_value, unit, result) VALUES ($1, \'Insulation Resistance Phase-Earth\', 100, 50, 500, 220, \'MOhm\', \'pass\'), ($1, \'Hipot Dielectric Withstand\', 2500, 2000, 3000, 2500, \'VAC\', \'pass\')',
        [testRunId]
      );

      await pool.query('UPDATE production_orders SET status = \'completed\' WHERE id = $1', [prodOrderId1]);
    });

    it('performs Bidirectional Traceability: Upstream to ABB Supplier and Downstream to L&T Sales Order', async () => {
      const res = await request(genealogyApp)
        .get('/api/genealogy/trace')
        .set('Authorization', authA())
        .query({ type: 'production_order', id: prodOrderId1 });

      expect(res.status).toBe(200);
      expect(res.body.anchor.label).toContain(`WO_PANEL_01_${TAG.slice(-4)}`);
      expect(res.body.upstream.length).toBeGreaterThan(0);
      const upstreamText = JSON.stringify(res.body.upstream);
      expect(upstreamText).toContain('ABB MCB 16A 3-Pole');

      expect(res.body.downstream.length).toBeGreaterThan(0);
      const downstreamText = JSON.stringify(res.body.downstream);
      expect(downstreamText).toContain(`SN_PANEL_001_${TAG.slice(-4)}`);
      expect(downstreamText).toContain('Larsen & Toubro Ltd');
    });

    it('retrieves As-Built Physical BOM identifying standard issue vs rework replacement', async () => {
      const res = await request(genealogyApp)
        .get(`/api/genealogy/as-built/${prodOrderId1}`)
        .set('Authorization', authA());

      expect(res.status).toBe(200);
      expect(res.body.asBuiltComponents).toBeDefined();
      expect(res.body.asBuiltComponents.length).toBe(2);

      const standardItem = res.body.asBuiltComponents.find(c => !c.is_rework_replacement);
      expect(standardItem).toBeDefined();
      expect(parseFloat(standardItem.qty_issued)).toBe(30);
      expect(standardItem.supplier_name).toBe('ABB India Ltd');

      const reworkItem = res.body.asBuiltComponents.find(c => c.is_rework_replacement);
      expect(reworkItem).toBeDefined();
      expect(parseFloat(reworkItem.qty_issued)).toBe(1);
    });

    it('reports as-built component serials without fanning the line out per serial', async () => {
      const res = await request(genealogyApp)
        .get(`/api/genealogy/as-built/${prodOrderId1}`)
        .set('Authorization', authA());

      expect(res.status).toBe(200);
      // One row per issue log, never one row per serial on the consumed lot.
      expect(res.body.asBuiltComponents.length).toBe(2);
      for (const c of res.body.asBuiltComponents) {
        expect(c).toHaveProperty('component_serial_count');
        expect(Number.isInteger(c.component_serial_count)).toBe(true);
        // serial_number collapses to a value only when the lot holds exactly one.
        if (c.component_serial_count === 1) expect(c.serial_number).toBeTruthy();
        else expect(c.serial_number).toBeNull();
      }
    });

    it('scopes location history to the anchor instead of returning the whole ledger', async () => {
      const res = await request(genealogyApp)
        .get('/api/genealogy/location-history')
        .set('Authorization', authA())
        .query({ batch_id: batchId1 });

      expect(res.status).toBe(200);
      expect(res.body.scope.batch_number).toContain('BATCH_LOT_01');
      expect(Array.isArray(res.body.movements)).toBe(true);
      // The lot was received once and issued twice, so the trail is bounded by
      // its own history. The defect this covers bound NULL into the item filter
      // and returned every ledger row in the company as this lot's movements.
      expect(res.body.movements.length).toBeLessThanOrEqual(10);
      const issues = res.body.movements.filter(m => m.movement_type === 'Issue to production');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some(m => String(m.reference || '').includes('WO_PANEL_01'))).toBe(true);
    });

    it('accepts a production order as a location-history anchor', async () => {
      const res = await request(genealogyApp)
        .get('/api/genealogy/location-history')
        .set('Authorization', authA())
        .query({ production_order_id: prodOrderId1 });

      expect(res.status).toBe(200);
      expect(res.body.scope.production_order_no).toContain('WO_PANEL_01');
      expect(Array.isArray(res.body.movements)).toBe(true);
    });

    // ── Traceability audit finding 02 ────────────────────────────────────────
    // An order that builds several units used to report every component of the
    // order as being in every one of them. These cover the split between what
    // is attributed to a unit and what is merely shared across the order.
    describe('per-unit as-built attribution', () => {
      let multiOrderId;
      let serialA;
      let serialB;
      let sharedLotId;
      let attributedLotId;

      beforeAll(async () => {
        const { rows: [order] } = await pool.query(
          `INSERT INTO production_orders (company_id, production_order_no, product_name, quantity_planned, status)
           VALUES ($1, $2, 'Control Panel 2-up', 2, 'completed') RETURNING id`,
          [COMPANY_A_ID, `WO_MULTI_${TAG.slice(-4)}`]);
        multiOrderId = order.id;
        created.production_orders.push(multiOrderId);

        const { rows: [item] } = await pool.query(
          `INSERT INTO inventory_items (company_id, item_code, item_name, current_stock, standard_cost)
           VALUES ($1, $2, 'Relay Module 24VDC', 0, 12.00) RETURNING id`,
          [COMPANY_A_ID, `RLY_${TAG.slice(-6)}`]);
        created.items.push(item.id);

        const mkBatch = async (suffix) => {
          const { rows: [b] } = await pool.query(
            `INSERT INTO inventory_batches (company_id, item_id, batch_number, warehouse_id, quantity_received, quantity_available)
             VALUES ($1,$2,$3,$4,10,10) RETURNING id`,
            [COMPANY_A_ID, item.id, `LOT_${suffix}_${TAG.slice(-4)}`, WAREHOUSE_A_ID]);
          created.batches.push(b.id);
          return b.id;
        };
        attributedLotId = await mkBatch('ATTR');
        sharedLotId = await mkBatch('SHARED');

        const mkSerial = async (suffix) => {
          const { rows: [s] } = await pool.query(
            `INSERT INTO serial_numbers (company_id, serial_number, item_id, production_order_id, status)
             VALUES ($1,$2,$3,$4,'active') RETURNING id`,
            [COMPANY_A_ID, `SN_MULTI_${suffix}_${TAG.slice(-4)}`, item.id, multiOrderId]);
          created.serials.push(s.id);
          return s.id;
        };
        serialA = await mkSerial('A');
        serialB = await mkSerial('B');

        // One line names unit A; one names no unit at all.
        const { rows: [l1] } = await pool.query(
          `INSERT INTO material_issue_logs (company_id, production_order_id, item_id, item_name, batch_id, qty_issued, serial_id, issued_by_name)
           VALUES ($1,$2,$3,'Relay Module 24VDC',$4,4,$5,'Attributing Operator') RETURNING id`,
          [COMPANY_A_ID, multiOrderId, item.id, attributedLotId, serialA]);
        created.issue_logs.push(l1.id);

        const { rows: [l2] } = await pool.query(
          `INSERT INTO material_issue_logs (company_id, production_order_id, item_id, item_name, batch_id, qty_issued, issued_by_name)
           VALUES ($1,$2,$3,'Relay Module 24VDC',$4,6,'Bulk Operator') RETURNING id`,
          [COMPANY_A_ID, multiOrderId, item.id, sharedLotId]);
        created.issue_logs.push(l2.id);
      });

      it('gives a unit only what was issued against it, and labels the rest shared', async () => {
        const { rows: [sn] } = await pool.query('SELECT serial_number FROM serial_numbers WHERE id = $1', [serialA]);
        const res = await request(genealogyApp)
          .get(`/api/genealogy/as-built/serial/${encodeURIComponent(sn.serial_number)}`)
          .set('Authorization', authA());

        expect(res.status).toBe(200);
        expect(res.body.attributedComponents.length).toBe(1);
        expect(res.body.attributedComponents[0].batch_number).toContain('LOT_ATTR');
        expect(res.body.sharedComponents.length).toBe(1);
        expect(res.body.sharedComponents[0].batch_number).toContain('LOT_SHARED');
        expect(res.body.attribution.units_on_order).toBe(2);
        // Not complete while a line on the order names no unit.
        expect(res.body.attribution.complete).toBe(false);
      });

      it('does not give unit B the lot that was attributed to unit A', async () => {
        const { rows: [sn] } = await pool.query('SELECT serial_number FROM serial_numbers WHERE id = $1', [serialB]);
        const res = await request(genealogyApp)
          .get(`/api/genealogy/as-built/serial/${encodeURIComponent(sn.serial_number)}`)
          .set('Authorization', authA());

        expect(res.status).toBe(200);
        expect(res.body.attributedComponents.length).toBe(0);
        const allBatches = JSON.stringify(res.body);
        expect(allBatches).not.toContain('LOT_ATTR');
        expect(allBatches).toContain('LOT_SHARED');
      });

      it('marks a multi-unit order-level as-built as an upper bound', async () => {
        const res = await request(genealogyApp)
          .get(`/api/genealogy/as-built/${multiOrderId}`)
          .set('Authorization', authA());

        expect(res.status).toBe(200);
        expect(res.body.attribution.units_on_order).toBe(2);
        expect(res.body.attribution.attributed_lines).toBe(1);
        expect(res.body.attribution.shared_lines).toBe(1);
        expect(res.body.attribution.complete).toBe(false);
        expect(res.body.attribution.note).toContain('upper bound');
      });

      it('narrows recall scope to the attributed unit, and reports the rest as an upper bound', async () => {
        const exact = await request(genealogyApp)
          .get(`/api/genealogy/where-used/${attributedLotId}`)
          .set('Authorization', authA());
        expect(exact.status).toBe(200);
        expect(exact.body.recallScope.definite_units).toBe(1);
        expect(exact.body.recallScope.possible_units).toBe(0);
        expect(exact.body.recallScope.exact).toBe(true);

        const bounded = await request(genealogyApp)
          .get(`/api/genealogy/where-used/${sharedLotId}`)
          .set('Authorization', authA());
        expect(bounded.status).toBe(200);
        expect(bounded.body.recallScope.definite_units).toBe(0);
        expect(bounded.body.recallScope.possible_units).toBe(2);
        expect(bounded.body.recallScope.exact).toBe(false);
        expect(bounded.body.recallScope.upper_bound_units).toBe(2);
      });

      it('404s an unknown serial rather than falling back to the order', async () => {
        const res = await request(genealogyApp)
          .get(`/api/genealogy/as-built/serial/NOPE_${TAG}`)
          .set('Authorization', authA());
        expect(res.status).toBe(404);
        expect(res.body.attributedComponents).toBeUndefined();
      });
    });

    it('refuses an unresolvable or absent location-history anchor rather than falling back to everything', async () => {
      const noAnchor = await request(genealogyApp)
        .get('/api/genealogy/location-history')
        .set('Authorization', authA());
      expect(noAnchor.status).toBe(400);

      const badBatch = await request(genealogyApp)
        .get('/api/genealogy/location-history')
        .set('Authorization', authA())
        .query({ batch_id: 999999999 });
      expect(badBatch.status).toBe(404);
      expect(badBatch.body.movements).toBeUndefined();

      const badSerial = await request(genealogyApp)
        .get('/api/genealogy/location-history')
        .set('Authorization', authA())
        .query({ serial_number: `NOPE_${TAG}` });
      expect(badSerial.status).toBe(404);
    });

    it('calculates Where-Used Recall Impact & 100% Quantity Reconciliation for Batch 1', async () => {
      const res = await request(genealogyApp)
        .get(`/api/genealogy/where-used/${batchId1}`)
        .set('Authorization', authA());

      expect(res.status).toBe(200);
      const { batch, reconciliation, consumedOrders } = res.body;

      expect(batch.batch_number).toContain('BATCH_LOT_01');
      expect(consumedOrders.length).toBe(1);
      expect(consumedOrders[0].order_number).toContain(`WO_PANEL_01_${TAG.slice(-4)}`);

      expect(parseFloat(reconciliation.total_received)).toBe(40);
      expect(parseFloat(reconciliation.store_stock_remaining)).toBe(10);
      expect(parseFloat(reconciliation.consumed_in_wip)).toBe(30);
      expect(reconciliation.is_reconciled).toBe(true);
    });

    it('retrieves Quality Control & Test Run Measurements for the assembled panel', async () => {
      const res = await request(genealogyApp)
        .get(`/api/genealogy/qc-history/${prodOrderId1}`)
        .set('Authorization', authA());

      expect(res.status).toBe(200);
      expect(res.body.testRuns.length).toBe(1);
      const tr = res.body.testRuns[0];
      expect(tr.test_type).toBe('HV Insulation & Dielectric');
      expect(tr.overall_result).toBe('pass');
      expect(tr.measurements.length).toBe(2);
      expect(tr.measurements[0].parameter_name).toContain('Insulation Resistance');
    });
  });
});