/**
 * integration.demandSemantics.test.js — the item update contract and ONE
 * definition of demand, against the REAL database through the REAL routers.
 *
 * WHAT WAS WRONG (inventory, Phase 3A)
 *
 *   1. PUT /inventory/items/:id rewrote every column from the body. Inventory
 *      Intelligence's "Save Rule" sends three fields, so the database was asked
 *      to set item_name to NULL — a 500 on every save, ever — and had it got
 *      past that it would have zeroed cost, stock levels and GST. The preferred
 *      vendor it sends was never written at all.
 *   2. Demand had four definitions. The planning engine excluded transfers and
 *      seed filler (but counted vendor returns, adjustments, cycle-count losses
 *      and any unknown type); Store Cost Analysis excluded only 'transfer'; the
 *      slow-mover and obsolete lists, the dashboard turnover and procurement's
 *      what-if EOQ counted every outward row. Returns of issues reduced nothing.
 *
 * The demand fixtures are built so that two items have IDENTICAL genuine issues
 * and one of them also carries every kind of non-demand movement. Every
 * consumer must give the two the same answer. The permission gate is stubbed to
 * check the exact (module, action) a route asks for, so authorisation is
 * asserted rather than bypassed; tenant scope stays the route's own.
 *
 * Self-cleaning: two companies tagged ZZDEMSEM, swept on the way in and out.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

// A gate that grants exactly the permissions the test caller holds.
const allows = (req, key) => req.user?.perms === '*' || (req.user?.perms || []).includes(key);
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requirePermission: (module, action) => (req, res, next) =>
    (allows(req, `${module}:${action}`) ? next() : res.status(403).json({ error: 'Forbidden' })) };
});
vi.mock('../modules/procurement/procurement.authz.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requireProcurement: (action) => (req, res, next) =>
    (allows(req, `procurement:${action}`) ? next() : res.status(403).json({ error: 'Forbidden' })) };
});

const { default: pool }              = await import('../config/db.js');
const planning                       = await import('../modules/inventory/services/inventoryPlanning.service.js');
const semantics                      = await import('../modules/inventory/services/ledgerSemantics.js');
const { default: itemRepo }          = await import('../modules/inventory/repositories/inventoryItem.repository.js');
const { default: inventoryRouter }   = await import('../modules/inventory/routes/inventory.routes.js');
const { default: procurementRouter } = await import('../modules/procurement/routes/procurement.routes.js');

const TAG = 'ZZDEMSEM';

function appAs(companyId, perms = '*') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/inventory', inventoryRouter);
  app.use('/procurement', procurementRouter);
  return app;
}

let A, B, whA, whB, vendorA, vendorB;
const item = {};

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;
  const ours = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM inventory_planning_run_items WHERE item_id IN ${ours} OR company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM inventory_planning_runs     WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM inventory_planning_settings WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM audit_logs                  WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM stock_ledger                WHERE item_id IN ${ours}`, [co]);
  await pool.query(`DELETE FROM inventory_items             WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM vendors                     WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM warehouses                  WHERE company_id = ANY($1)`, [co]);
  const { rows: fks } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu  ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies'`);
  for (let pass = 0; pass < 2; pass++) {
    for (const { table_name, column_name } of fks) {
      try {
        await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, [co]);
      } catch { /* FK ordering — the second pass picks it up */ }
    }
  }
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

const makeCompany = async (s) => (await pool.query(
  `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`])).rows[0].id;
const makeWarehouse = async (cid, s) => (await pool.query(
  `INSERT INTO warehouses (name, warehouse_name, company_id, department) VALUES ($1, $1, $2, 'production') RETURNING id`,
  [`${TAG} WH ${s}`, cid])).rows[0].id;
const makeVendor = async (cid, s) => (await pool.query(
  `INSERT INTO vendors (vendor_name, company_id, status) VALUES ($1, $2, 'active') RETURNING id`,
  [`${TAG} Vendor ${s}`, cid])).rows[0].id;
async function makeItem(cid, suffix, cols = {}) {
  const all = { item_code: `${TAG}-${cid}-${suffix}`, item_name: `${TAG} ${suffix}`, company_id: cid,
                unit_of_measure: 'NOS', standard_cost: 10, item_type: `${TAG}-${suffix}`, ...cols };
  const keys = Object.keys(all);
  const { rows } = await pool.query(
    `INSERT INTO inventory_items (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map(k => all[k]));
  item[suffix] = rows[0].id;
  return rows[0].id;
}
/** One ledger row. `when` is 'today', a number of days ago, or {month: n} = the 1st of n months back. */
async function post(cid, wh, itemId, type, qtyIn, qtyOut, when, rate = 10) {
  const dateSql = when === 'today' ? 'CURRENT_DATE'
    : typeof when === 'number' ? `CURRENT_DATE - ${Number(when)}`
    : `(date_trunc('month', CURRENT_DATE) - make_interval(months => ${Number(when.month)}))::date`;
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
                               rate, transaction_date, company_id, remarks)
     VALUES ($1, $2, $3, $4, $5, $6, ${dateSql}, $7, $8)`,
    [itemId, wh, type, qtyIn, qtyOut, rate, cid, `${TAG} fixture`]);
}
const row = async (id) => (await pool.query(`SELECT * FROM inventory_items WHERE id = $1`, [id])).rows[0];
async function auditRows(type, recordId) {
  for (let i = 0; i < 80; i++) {
    const { rows } = await pool.query(
      `SELECT * FROM audit_logs WHERE reference_type = $1 AND reference_id = $2`, [type, String(recordId)]);
    if (rows.length) return rows;
    await new Promise(r => { setTimeout(r, 100); });
  }
  return [];
}

// Every ISSUE type the codebase writes, one per month — so all of them are
// proven to count, not just 'consumption'.
const ISSUE_ROTATION = ['consumption', 'issue', 'production_issue', 'production_consumption', 'rework_issue',
  'sc_issue', 'service_issue', 'maintenance_issue', 'dispatch', 'sales_dispatch', 'consumption', 'issue'];

beforeAll(async () => {
  await sweep();
  A = await makeCompany('A');
  B = await makeCompany('B');
  whA = await makeWarehouse(A, 'A');
  whB = await makeWarehouse(B, 'B');
  vendorA = await makeVendor(A, 'A');
  vendorB = await makeVendor(B, 'B');
  for (const cid of [A, B]) {
    await pool.query(`
      INSERT INTO inventory_planning_settings
        (company_id, lookback_days, min_periods_for_stats, auto_apply,
         abc_a_threshold_pct, abc_b_threshold_pct, xyz_x_max_cv, xyz_y_max_cv, fsn_slow_days, fsn_nonmoving_days)
      VALUES ($1, 365, 3, true, 70, 90, 0.5, 1.0, 90, 180)`, [cid]);
  }

  // ── Item API fixture: every field populated, so "unrelated fields kept" means something.
  await makeItem(A, 'RULE', {
    standard_cost: 55, safety_stock: 3, reorder_level: 5, lead_time_days: 7, gst_rate: 18, hsn_code: '8536',
    manufacturer: 'ACME', description: 'keep me', product_model: 'MX-1', abc_class: 'B', abc_class_source: 'manual' });
  await makeItem(B, 'BRULE', { reorder_level: 4, lead_time_days: 9 });

  // ── Demand fixtures (company A). Every issue row: 10 units at rate 10.
  // ISS    genuine issues only, every ISSUE type, 1st of each of 12 months
  // NOISE  the same issues + every non-demand movement, monthly and today
  // REV    the same issues less returns: sales/production/rework returns and a
  //        service-visit reduction; month 5's return exceeds its issue
  // UNK    an unclassified type only      VRET  vendor returns only
  // ADJ    count / adjustment losses only
  for (const k of ['ISS', 'NOISE', 'REV']) {
    await makeItem(A, k);
    await post(A, whA, item[k], 'opening', 1000, 0, 340);
    for (let m = 0; m < 12; m++) await post(A, whA, item[k], ISSUE_ROTATION[m], 0, 10, { month: m });
  }
  const noise = async (when) => {
    await post(A, whA, item.NOISE, 'receipt', 50, 0, when);
    await post(A, whA, item.NOISE, 'purchase', 5, 0, when);
    await post(A, whA, item.NOISE, 'transfer', 0, 30, when);
    await post(A, whA, item.NOISE, 'bin_transfer', 20, 20, when);
    await post(A, whA, item.NOISE, 'put_away', 0, 0, when);
    await post(A, whA, item.NOISE, 'return', 0, 15, when);               // to the vendor
    await post(A, whA, item.NOISE, 'adjustment', 0, 7, when);
    await post(A, whA, item.NOISE, 'cycle_count', 0, 4, when);
    await post(A, whA, item.NOISE, 'maintenance_adjustment', 0, 3, when);
    await post(A, whA, item.NOISE, 'standard', 0, 9, when);             // seed filler
  };
  for (let m = 0; m < 12; m++) await noise({ month: m });
  await noise('today');

  await post(A, whA, item.REV, 'sales_return', 4, 0, { month: 1 });
  await post(A, whA, item.REV, 'production_return', 2, 0, { month: 2 });
  await post(A, whA, item.REV, 'rework_return', 1, 0, { month: 3 });
  await post(A, whA, item.REV, 'service_issue', 3, 0, { month: 4 });   // a part removed from a visit
  await post(A, whA, item.REV, 'sales_return', 25, 0, { month: 5 });   // more back than went out that month

  await makeItem(A, 'UNK');
  await post(A, whA, item.UNK, 'opening', 200, 0, 340);
  for (let m = 0; m < 12; m++) await post(A, whA, item.UNK, 'mystery_out', 0, 10, { month: m });

  await makeItem(A, 'VRET');
  await post(A, whA, item.VRET, 'opening', 100, 0, 300);
  await post(A, whA, item.VRET, 'return', 0, 5, 'today');

  await makeItem(A, 'ADJ');
  await post(A, whA, item.ADJ, 'opening', 100, 0, 300);
  await post(A, whA, item.ADJ, 'cycle_count', 0, 4, 'today');
  await post(A, whA, item.ADJ, 'adjustment', 0, 6, 'today');
}, 180_000);

afterAll(async () => { await sweep(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('PUT /inventory/items/:id — partial update', () => {
  // 1 + 2
  it('saves the exact "Save Rule" payload without item_name, and keeps every other field', async () => {
    const before = await row(item.RULE);
    const res = await request(appAs(A)).put(`/inventory/items/${item.RULE}`)
      .send({ reorder_level: '12', lead_time_days: '21', preferred_vendor_id: String(vendorA) });   // inputs arrive as strings
    expect(res.status).toBe(200);
    const after = await row(item.RULE);
    expect([Number(after.reorder_level), after.lead_time_days, after.preferred_vendor_id]).toEqual([12, 21, vendorA]);
    for (const k of ['item_name', 'item_code', 'standard_cost', 'safety_stock', 'gst_rate', 'hsn_code', 'manufacturer',
                     'description', 'product_model', 'unit_of_measure', 'is_active', 'abc_class', 'abc_class_source',
                     'category_id', 'item_type', 'company_id']) {
      expect([k, after[k]]).toEqual([k, before[k]]);
    }
    expect(res.body.id).toBe(item.RULE);                                // response shape: the full row
    expect(res.body.item_name).toBe(before.item_name);
    const audit = await auditRows('inventory_item', item.RULE);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(Number(audit[0].new_data_json.reorder_level)).toBe(12);
  }, 20_000);

  it('clears the preferred vendor the way Save Rule sends it (null)', async () => {
    await request(appAs(A)).put(`/inventory/items/${item.RULE}`).send({ preferred_vendor_id: null }).expect(200);
    expect((await row(item.RULE)).preferred_vendor_id).toBeNull();
  });

  it('still accepts Item Master\'s whole form, item_code echo and blank fields included', async () => {
    const r = await row(item.RULE);
    const res = await request(appAs(A)).put(`/inventory/items/${item.RULE}`).send({
      item_code: r.item_code, item_name: r.item_name, item_type: r.item_type, product_model: r.product_model,
      category_id: '', abc_class: 'B', unit_of_measure: 'NOS', reorder_level: '12', safety_stock: '3',
      standard_cost: '55', lead_time_days: 21, hsn_code: '8536', gst_rate: '', manufacturer: 'ACME',
      description: 'keep me', is_active: true });
    expect(res.status).toBe(200);
    expect(Number((await row(item.RULE)).gst_rate)).toBe(0);           // a blank keeps its old meaning
  });

  // 3
  it('rejects invalid values with a 422 that names the field, and writes none of the request', async () => {
    const before = await row(item.RULE);
    const cases = [
      [{ reorder_level: -1 }, 'reorder_level'],
      [{ reorder_level: 'lots' }, 'reorder_level'],
      [{ lead_time_days: 2.5 }, 'lead_time_days'],
      [{ gst_rate: 140 }, 'gst_rate'],
      [{ item_name: '' }, 'item_name'],
      [{ hsn_code: '123456789' }, 'hsn_code'],
      [{ is_active: 'maybe' }, 'is_active'],
      [{ current_stock: 999 }, 'current_stock'],                     // not an editable field
      [{ item_code: 'SOMETHING-ELSE' }, 'item_code'],                // identity
      [{ preferred_vendor_id: vendorB }, 'preferred_vendor_id'],     // another company's vendor
      [{ preferred_vendor_id: 'abc' }, 'preferred_vendor_id'],
      [{ abc_class: 'Q' }, 'abc_class'],
      [{ reorder_level: 40, lead_time_days: -3 }, 'lead_time_days'], // one bad field sinks the whole request
    ];
    for (const [body, field] of cases) {
      const res = await request(appAs(A)).put(`/inventory/items/${item.RULE}`).send(body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.errors.map(e => e.field)).toContain(field);
    }
    const after = await row(item.RULE);
    expect({ ...after, updated_at: null }).toEqual({ ...before, updated_at: null });
  });

  it('creating an item still requires a name (422, nothing written)', async () => {
    await expect(itemRepo.create({ item_code: `${TAG}-NONAME`, company_id: A }))
      .rejects.toMatchObject({ status: 422, errors: [{ field: 'item_name' }] });
    expect((await pool.query(`SELECT 1 FROM inventory_items WHERE item_code = $1`, [`${TAG}-NONAME`])).rows).toHaveLength(0);
  });

  it('answers 404 for a missing item and 400 for a malformed id', async () => {
    await request(appAs(A)).put('/inventory/items/999999999').send({ reorder_level: 1 }).expect(404);
    await request(appAs(A)).put('/inventory/items/not-a-number').send({ reorder_level: 1 }).expect(400);
  });

  // 4
  it('needs inventory:edit, and cannot reach another company\'s item', async () => {
    await request(appAs(A, ['inventory:view'])).put(`/inventory/items/${item.RULE}`).send({ reorder_level: 1 }).expect(403);
    const before = await row(item.BRULE);
    await request(appAs(A)).put(`/inventory/items/${item.BRULE}`).send({ reorder_level: 99 }).expect(404);
    expect(await row(item.BRULE)).toEqual(before);
    // Positive pair: B's own edit works.
    await request(appAs(B, ['inventory:edit'])).put(`/inventory/items/${item.BRULE}`).send({ reorder_level: 6 }).expect(200);
    expect(Number((await row(item.BRULE)).reorder_level)).toBe(6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('ledger semantics (pure)', () => {
  const S = semantics;
  it('classifies every type the codebase writes, from its writer', () => {
    for (const t of ISSUE_ROTATION) expect([t, S.classifyLedgerRow(t, 0, 10)]).toEqual([t, 'issue']);
    for (const t of ['receipt', 'purchase', 'batch_receipt', 'inward', 'production_receipt', 'sc_receipt',
                     'maintenance_receipt', 'opening']) expect([t, S.classifyLedgerRow(t, 10, 0)]).toEqual([t, 'receipt']);
    for (const t of ['transfer', 'bin_transfer', 'put_away']) expect(S.classifyLedgerRow(t, 5, 5)).toBe('transfer');
    expect(S.classifyLedgerRow('return', 0, 5)).toBe('vendor_return');
    for (const t of ['adjustment', 'cycle_count', 'maintenance_adjustment']) expect(S.classifyLedgerRow(t, 0, 5)).toBe('adjustment');
    for (const t of ['sales_return', 'production_return', 'rework_return']) expect(S.classifyLedgerRow(t, 5, 0)).toBe('issue_reversal');
    expect(S.classifyLedgerRow('service_issue', 3, 0)).toBe('issue_reversal');    // same-type reduction
    expect(S.classifyLedgerRow('Mystery_Out', 0, 5)).toBe('unknown');
  });

  // 5-10, 12
  it('counts issues, nets returns, and counts nothing else', () => {
    expect(S.demandQtyOf('production_issue', 0, 10)).toBe(10);
    expect(S.demandQtyOf('sales_return', 4, 0)).toBe(-4);
    expect(S.demandQtyOf('service_issue', 3, 0)).toBe(-3);
    for (const [t, i, o] of [['receipt', 50, 0], ['transfer', 0, 30], ['bin_transfer', 20, 20], ['return', 0, 15],
                             ['adjustment', 0, 7], ['cycle_count', 0, 4], ['standard', 0, 9], ['mystery_out', 0, 10]]) {
      expect([t, S.demandQtyOf(t, i, o)]).toEqual([t, 0]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('every demand consumer applies the same rules', () => {
  let app, run;
  beforeAll(async () => {
    app = appAs(A);
    ({ run } = await planning.recomputePlanningParameters({ companyId: A, apply: true }));
  }, 60_000);

  // 11 — ABC / XYZ / FSN
  it('the planning engine gives NOISE exactly the same answer as ISS', async () => {
    const iss = await row(item.ISS), noisy = await row(item.NOISE);
    for (const k of ['annual_demand', 'demand_cv', 'demand_stddev', 'annual_consumption_value', 'abc_class_calculated',
                     'xyz_class', 'fsn_class', 'last_movement_date', 'eoq', 'safety_stock_calculated']) {
      expect([k, noisy[k]]).toEqual([k, iss[k]]);
    }
    expect(Number(iss.annual_demand)).toBe(120);
    expect(iss.fsn_class).toBe('F');
  });

  // 10 — reversals net in the month booked; annual net over the window, floored
  it('nets returns of issues against demand', async () => {
    const rev = await row(item.REV);
    expect(Number(rev.annual_demand)).toBe(85);                           // 120 - 4 - 2 - 1 - 3 - 25
    expect(Number(rev.annual_consumption_value)).toBe(850);
    expect(rev.last_movement_date).toBe((await row(item.ISS)).last_movement_date);   // FSN dates issues only
  });

  // 7, 8, 12, 5 — no demand at all
  it('vendor returns, count losses and unclassified types are not demand and not movement', async () => {
    for (const k of ['UNK', 'VRET', 'ADJ']) {
      const r = await row(item[k]);
      expect([k, r.fsn_class, r.last_movement_date, r.classification_reason])
        .toEqual([k, 'N', null, 'insufficient_history']);
    }
  });

  // 12 — reported, not silently dropped
  it('records and reports the unclassified type it excluded', async () => {
    const unk = (run.params.unclassified_transaction_types || []).find(u => u.transaction_type === 'mystery_out');
    expect(unk).toMatchObject({ rows: 12 });
    const res = await request(app).get('/inventory/planning/ledger-semantics');
    expect(res.status).toBe(200);
    expect(res.body.unclassified_transaction_types.map(u => u.transaction_type)).toContain('mystery_out');
    expect(res.body.classes.bin_transfer).toBe('transfer');
    expect(Object.keys(res.body.ambiguous)).toContain('dispatch');
    const forB = await request(appAs(B)).get('/inventory/planning/ledger-semantics');
    expect(forB.body.unclassified_transaction_types).toEqual([]);         // tenant-scoped
  });

  // 11 — Store Cost Analysis
  it('Store Cost Analysis demand matches the planning engine', async () => {
    const dept = (await request(app).get('/inventory/dept-cost-analysis')).body;
    const d = (k) => dept.consolidated.items.find(i => i.item_id === item[k]);
    expect(d('ISS').annual_demand).toBe(120);
    expect(d('NOISE').annual_demand).toBe(120);                            // was inflated by every non-demand outflow
    expect(d('REV').annual_demand).toBe(85);
    expect(d('NOISE').eoq).toBe(d('ISS').eoq);
    for (const k of ['UNK', 'VRET', 'ADJ']) expect([k, d(k).annual_demand]).toEqual([k, 0]);
  });

  it('procurement\'s what-if EOQ uses the same demand', async () => {
    for (const [k, want] of [['ISS', 120], ['NOISE', 120], ['REV', 85]]) {
      const res = await request(app).get('/procurement/analytics/eoq').query({ item_id: item[k], ordering_cost: 500 });
      expect([k, res.body.source, res.body.annual_demand]).toEqual([k, 'what_if', want]);
    }
  });

  it('slow-mover and obsolete lists date the last ISSUE, not any outward row', async () => {
    const slow = (await request(app).get('/inventory/slow-movers')).body.map(r => r.id);
    expect(slow).toEqual(expect.arrayContaining([item.VRET, item.ADJ]));   // their only outflow was today
    expect(slow).not.toContain(item.ISS);
    const eo = (await request(app).get('/inventory/scm/excess-obsolete')).body;
    const obsolete = eo.obsolete.items.map(r => r.id);
    expect(obsolete).toEqual(expect.arrayContaining([item.VRET, item.ADJ, item.UNK]));
    expect(obsolete).not.toContain(item.NOISE);
  });

  it('turnover counts demand value only, and no longer multiplies stock by ledger rows', async () => {
    const dash = (await request(app).get('/inventory/advanced-dashboard')).body;
    const byCat = new Map((dash.turnover?.by_category || dash.data?.turnover?.by_category || [])
      .map(c => [c.category, c.rate]));
    for (const k of ['ISS', 'NOISE']) {
      const r = await row(item[k]);
      const stock = Number((await pool.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS q FROM stock_ledger WHERE item_id = $1`, [item[k]])).rows[0].q);
      const expected = Number(((120 * 10) / (stock * Number(r.standard_cost))).toFixed(2));
      expect([k, byCat.get(`${TAG}-${k}`)]).toEqual([k, expected]);
    }
  });
});
