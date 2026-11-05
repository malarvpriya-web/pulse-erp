/**
 * integration.inventoryClassification.test.js — ABC / XYZ / FSN write-back,
 * against the REAL database.
 *
 * WHAT WAS WRONG (inventory classification audit, Phase 1)
 *
 *   1. recomputePlanningParameters() skipped every item with fewer than
 *      min_periods_for_stats months of demand BEFORE writing anything. A
 *      never-issued part computed as N in the run record and stayed NULL on the
 *      item master, so Non-moving never reached the dashboard — and a part that
 *      lost its history kept its old ABC/XYZ class indefinitely.
 *   2. FSN read MAX(transaction_date) over every ledger row, receipts included,
 *      so a part received yesterday and never used was Fast-moving. A scanned
 *      bin move (bin_transfer, in = out) counted as an issue too.
 *   3. The run record said C for an unclassifiable item while the item master
 *      said something else; the two disagreed by construction.
 *   4. GET /planning/abc filtered on abc_class IS NOT NULL, so an unclassified
 *      item was absent — indistinguishable from one that does not exist.
 *
 * DELIBERATELY NOT MOCKED: the defects are in SQL and in what lands on which
 * row, which a stubbed pool proves nothing about. Only the permission gate is
 * stubbed, for the HTTP checks — the route's own tenant scoping is real.
 *
 * Self-cleaning: two synthetic companies tagged ZZFSNCL, swept on the way IN as
 * well as out (a suite that only tidies afterwards leaks the moment an
 * assertion throws). Nothing outside those two companies is written.
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

// The permission matrix is not what is under test; tenant scope is, and that
// lives in the route (companyOf), which stays real.
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requirePermission: () => (_req, _res, next) => next() };
});

const { default: pool }     = await import('../config/db.js');
const planning              = await import('../modules/inventory/services/inventoryPlanning.service.js');
const { computeInventoryKpis } = await import('../modules/inventory/services/inventoryKpi.service.js');
const { default: planningRouter } = await import('../modules/inventory/routes/planning.routes.js');

const TAG = 'ZZFSNCL';

function appAs(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/planning', planningRouter);
  return app;
}

let A, B, whA, whB;
const item = {};          // code suffix -> id

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;
  const ours = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM inventory_planning_run_items WHERE item_id IN ${ours} OR company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM inventory_planning_runs     WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM inventory_planning_settings WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM stock_ledger                WHERE item_id IN ${ours}`, [co]);
  await pool.query(`DELETE FROM inventory_items             WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM warehouses                  WHERE company_id = ANY($1)`, [co]);

  // Route files seed into every company at import time, so which tables pin a
  // new company depends on the run, not on this file — discover them.
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

async function makeCompany(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${suffix}`, `${TAG}${suffix}`]);
  return rows[0].id;
}
async function makeWarehouse(companyId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`,
    [`${TAG} WH ${suffix}`, companyId]);
  return rows[0].id;
}
async function makeItem(companyId, suffix, cost = 100, preset = {}) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost,
                                  abc_class, abc_class_calculated, abc_rank, abc_value_pct, abc_cumulative_pct,
                                  xyz_class, demand_cv, fsn_class, abc_class_source)
     VALUES ($1, $2, $3, 'NOS', $4, $5, $6, $7, $8, $9, $10, $11, $12,
             COALESCE($13, 'calculated')) RETURNING id`,
    [`${TAG}-${companyId}-${suffix}`, `${TAG} ${suffix}`, companyId, cost,
     preset.abc_class ?? null, preset.abc_class_calculated ?? null, preset.abc_rank ?? null,
     preset.abc_value_pct ?? null, preset.abc_cumulative_pct ?? null,
     preset.xyz_class ?? null, preset.demand_cv ?? null, preset.fsn_class ?? null,
     preset.abc_class_source ?? null]);
  item[suffix] = rows[0].id;
  return rows[0].id;
}
/** A ledger row dated `daysAgo` days before the database's CURRENT_DATE. */
async function ledger(companyId, wh, itemId, type, qtyIn, qtyOut, daysAgo) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
                               rate, transaction_date, company_id, remarks)
     VALUES ($1, $2, $3, $4, $5, 0, CURRENT_DATE - $6::int, $7, $8)`,
    [itemId, wh, type, qtyIn, qtyOut, daysAgo, companyId, `${TAG} fixture`]);
}
/** A consumption row on the 1st of the month `monthsAgo` months back. */
async function monthlyIssue(companyId, wh, itemId, qty, monthsAgo) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
                               rate, transaction_date, company_id, remarks)
     VALUES ($1, $2, 'consumption', 0, $3, 0,
             (date_trunc('month', CURRENT_DATE) - make_interval(months => $4::int))::date, $5, $6)`,
    [itemId, wh, qty, monthsAgo, companyId, `${TAG} fixture`]);
}
const row = async (id) => (await pool.query(
  `SELECT abc_class, abc_class_calculated, abc_rank, abc_value_pct, abc_cumulative_pct,
          xyz_class, demand_cv, fsn_class, last_movement_date, classification_reason, classified_at
     FROM inventory_items WHERE id = $1`, [id])).rows[0];
const runCount = async (cid) => (await pool.query(
  `SELECT COUNT(*)::int AS n FROM inventory_planning_runs WHERE company_id = $1`, [cid])).rows[0].n;

beforeAll(async () => {
  await sweep();
  A = await makeCompany('A');
  B = await makeCompany('B');
  whA = await makeWarehouse(A, 'A');
  whB = await makeWarehouse(B, 'B');

  // Policy pinned explicitly — the defaults, written down — so the assertions
  // do not silently depend on whatever the default row happens to be.
  for (const cid of [A, B]) {
    await pool.query(`
      INSERT INTO inventory_planning_settings
        (company_id, lookback_days, min_periods_for_stats, auto_apply,
         abc_a_threshold_pct, abc_b_threshold_pct, xyz_x_max_cv, xyz_y_max_cv,
         fsn_slow_days, fsn_nonmoving_days)
      VALUES ($1, 365, 3, true, 70, 90, 0.5, 1.0, 90, 180)`, [cid]);
  }

  // ── FSN population (all insufficient history for ABC/XYZ) ──
  await makeItem(A, 'NEVER');                                   // no ledger rows at all
  await makeItem(A, 'RECEIPT');                                 // received today, never issued
  await ledger(A, whA, item.RECEIPT, 'receipt', 50, 0, 0);
  await makeItem(A, 'TRANSFER');                                // only moved around
  await ledger(A, whA, item.TRANSFER, 'receipt', 50, 0, 200);
  await ledger(A, whA, item.TRANSFER, 'transfer', 0, 10, 0);
  await ledger(A, whA, item.TRANSFER, 'bin_transfer', 5, 5, 0);
  for (const d of [90, 91, 180, 181]) {                         // the two boundaries, both sides
    await makeItem(A, `D${d}`);
    await ledger(A, whA, item[`D${d}`], 'receipt', 100, 0, 200);
    await ledger(A, whA, item[`D${d}`], 'consumption', 0, 1, d);
  }
  await makeItem(A, 'FUTURE');                                  // a post-dated issue is not a movement yet
  await ledger(A, whA, item.FUTURE, 'receipt', 10, 0, 30);
  await ledger(A, whA, item.FUTURE, 'consumption', 0, 1, -5);

  // ── Stale classifications left by an earlier run, now unsupported ──
  await makeItem(A, 'STALE', 100, {
    abc_class: 'A', abc_class_calculated: 'A', abc_rank: 1, abc_value_pct: 50, abc_cumulative_pct: 50,
    xyz_class: 'X', demand_cv: 0.2, fsn_class: 'F' });
  await ledger(A, whA, item.STALE, 'consumption', 0, 1, 200);   // one month of demand, 200 days ago

  // A hand-set class on an item the run cannot classify.
  await makeItem(A, 'MANUALSKIP', 100, { abc_class: 'B', abc_class_source: 'manual' });

  // ── Adequate history: 12 monthly buckets ──
  //   G2  erratic  30 in 4 of 12 months  x 1000  ACV 120 000  CV 1.414  -> A Z
  //   G1  steady   10 every month        x  100  ACV  12 000  CV 0      -> B X
  //   MC  steady   10 every month        x   50  ACV   6 000  CV 0      -> C X
  //   G3  steady   10 every month        x   10  ACV   1 200  CV 0      -> C X
  // Cumulative share BEFORE each item: 0%, 86.2%, 94.8%, 99.1% against 70/90.
  await makeItem(A, 'G2', 1000);
  for (const m of [0, 3, 6, 9]) await monthlyIssue(A, whA, item.G2, 30, m);
  await makeItem(A, 'G1', 100);
  await makeItem(A, 'G3', 10);
  // MC: someone set A by hand while the engine said B. The engine now says C;
  // the hand-set A must survive.
  await makeItem(A, 'MC', 50, { abc_class: 'A', abc_class_calculated: 'B', abc_class_source: 'manual' });
  for (const k of ['G1', 'G3', 'MC']) {
    for (let m = 0; m < 12; m++) await monthlyIssue(A, whA, item[k], 10, m);
  }

  // ── Company B: one item whose classes A's run must not touch ──
  await makeItem(B, 'BITEM', 100, {
    abc_class: 'B', abc_class_calculated: 'B', xyz_class: 'Y', fsn_class: 'S' });
  await ledger(B, whB, item.BITEM, 'receipt', 20, 0, 400);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await sweep();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('classifyFSN · boundaries (pure)', () => {
  it('is inclusive on the faster side of each threshold', () => {
    const p = { slowDays: 90, nonMovingDays: 180 };
    expect(planning.classifyFSN(0, p)).toBe('F');
    expect(planning.classifyFSN(90, p)).toBe('F');
    expect(planning.classifyFSN(91, p)).toBe('S');
    expect(planning.classifyFSN(180, p)).toBe('S');
    expect(planning.classifyFSN(181, p)).toBe('N');
  });

  it('treats "never issued" as N, never as F', () => {
    expect(planning.classifyFSN(null)).toBe('N');
    expect(planning.classifyFSN(undefined)).toBe('N');
  });

  it('excludes both transfer types from the shared demand definition', () => {
    // ledgerSemantics (Phase 3A) replaced the exclusion list with a classified map.
    expect(planning.classifyLedgerRow('transfer', 0, 5)).toBe('transfer');
    expect(planning.classifyLedgerRow('bin_transfer', 5, 5)).toBe('transfer');
    expect(planning.demandQtyOf('bin_transfer', 5, 5)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runs FIRST, against untouched fixtures, so "nothing changed" is checkable.
describe('recompute · a failed run leaves nothing behind', () => {
  it('rolls back the run record and every item write when one write fails', async () => {
    const before = { never: await row(item.NEVER), stale: await row(item.STALE), runs: await runCount(A) };

    // Fail the third item-master UPDATE — after the run row and several item
    // writes are already in the transaction. Only the callback-less connect()
    // the service checks out for its transaction is wrapped: pg's Pool.query()
    // calls this.connect(cb) internally, and swallowing that callback would
    // hang getPlanningSettings() instead of testing anything.
    const realConnect = pool.connect.bind(pool);
    let wrapped = false;
    const spy = vi.spyOn(pool, 'connect').mockImplementation((cb) => {
      if (cb || wrapped) return realConnect(cb);
      wrapped = true;
      return realConnect().then(wrapClient);
    });
    function wrapClient(client) {
      let updates = 0;
      return {
        query: (sql, params) => {
          if (/^\s*UPDATE inventory_items/i.test(String(sql)) && ++updates === 3) {
            return Promise.reject(new Error('injected failure'));
          }
          return client.query(sql, params);
        },
        release: (...a) => client.release(...a),
      };
    }

    await expect(planning.recomputePlanningParameters({ companyId: A, apply: true }))
      .rejects.toThrow('injected failure');
    spy.mockRestore();

    expect(await runCount(A)).toBe(before.runs);
    expect(await row(item.NEVER)).toEqual(before.never);
    expect(await row(item.STALE)).toEqual(before.stale);
    expect((await row(item.NEVER)).fsn_class).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recompute · company A', () => {
  let result;
  beforeAll(async () => {
    result = await planning.recomputePlanningParameters({ companyId: A, apply: true, actor: { name: TAG } });
  }, 30_000);

  // 1
  it('persists a never-issued item as N on the item master', async () => {
    const r = await row(item.NEVER);
    expect(r.fsn_class).toBe('N');
    expect(r.last_movement_date).toBeNull();
    expect(r.classification_reason).toBe('insufficient_history');
    expect(r.classified_at).not.toBeNull();
  });

  // 2
  it('does not call an item with receipts only Fast', async () => {
    const r = await row(item.RECEIPT);
    expect(r.fsn_class).toBe('N');
    expect(r.last_movement_date).toBeNull();     // the receipt is not a movement
  });

  // 3
  it('does not call an item with transfers only Fast (transfer and bin_transfer)', async () => {
    const r = await row(item.TRANSFER);
    expect(r.fsn_class).toBe('N');
    expect(r.last_movement_date).toBeNull();
  });

  // 4 + 5
  it('classifies genuine issues by calendar days, inclusive at 90 and 180', async () => {
    expect((await row(item.D90)).fsn_class).toBe('F');
    expect((await row(item.D91)).fsn_class).toBe('S');
    expect((await row(item.D180)).fsn_class).toBe('S');
    expect((await row(item.D181)).fsn_class).toBe('N');
    expect((await row(item.G1)).fsn_class).toBe('F');   // issued on the 1st of this month
  });

  it('records the last ISSUE date, not the last ledger row', async () => {
    const { rows: [d] } = await pool.query(`SELECT (CURRENT_DATE - 90)::date::text AS d`);
    expect((await row(item.D90)).last_movement_date).toBe(d.d);   // the receipt 200 days ago is ignored
  });

  it('ignores a post-dated issue', async () => {
    expect((await row(item.FUTURE)).fsn_class).toBe('N');
  });

  // 6 + 7
  it('clears a stale calculated ABC and XYZ class when history no longer supports one', async () => {
    const r = await row(item.STALE);
    expect(r.abc_class_calculated).toBeNull();
    expect(r.abc_class).toBeNull();              // it was engine-owned (equal to the calculated class)
    expect(r.abc_rank).toBeNull();
    expect(r.abc_value_pct).toBeNull();
    expect(r.abc_cumulative_pct).toBeNull();
    expect(r.xyz_class).toBeNull();
    expect(r.demand_cv).toBeNull();
    expect(r.fsn_class).toBe('N');               // 200 days > 180
    expect(r.classification_reason).toBe('insufficient_history');
  });

  it('leaves a hand-set ABC class alone on an item it cannot classify', async () => {
    const r = await row(item.MANUALSKIP);
    expect(r.abc_class).toBe('B');
    expect(r.abc_class_calculated).toBeNull();
  });

  // 8
  it('still classifies adequate-history items exactly as before', async () => {
    const g2 = await row(item.G2), g1 = await row(item.G1), g3 = await row(item.G3);
    expect([g2.abc_class_calculated, g2.xyz_class]).toEqual(['A', 'Z']);
    expect([g1.abc_class_calculated, g1.xyz_class]).toEqual(['B', 'X']);
    expect([g3.abc_class_calculated, g3.xyz_class]).toEqual(['C', 'X']);
    expect(g2.abc_class).toBe('A');
    expect([g2.abc_rank, g1.abc_rank]).toEqual([1, 2]);
    expect(Number(g2.abc_value_pct)).toBeCloseTo(100 * 120000 / 139200, 3);
    expect(Number(g2.demand_cv)).toBeCloseTo(Math.SQRT2, 3);
    for (const r of [g1, g2, g3]) expect(r.classification_reason).toBeNull();
  });

  it('moves the calculated class but keeps a hand-set operative class', async () => {
    const mc = await row(item.MC);
    expect(mc.abc_class_calculated).toBe('C');
    expect(mc.abc_class).toBe('A');
  });

  it('writes a run record that agrees with the item master', async () => {
    const { rows } = await pool.query(
      `SELECT item_id, abc_class, xyz_class, fsn_class, applied, skip_reason
         FROM inventory_planning_run_items WHERE run_id = $1`, [result.run.id]);
    expect(rows).toHaveLength(Object.keys(item).length - 1);     // every A item, not BITEM
    for (const ri of rows) {
      const im = await row(ri.item_id);
      expect(ri.fsn_class).toBe(im.fsn_class);
      expect(ri.xyz_class).toBe(im.xyz_class);
      expect(ri.abc_class).toBe(im.abc_class_calculated);
      expect(ri.applied).toBe(true);
    }
    const never = rows.find(r => r.item_id === item.NEVER);
    expect(never.abc_class).toBeNull();                          // used to be 'C'
    expect(never.skip_reason).toMatch(/^insufficient_history: 0 of 3/);
    // Run counters count classified items only.
    expect(result.run.abc_a_count + result.run.abc_b_count + result.run.abc_c_count).toBe(4);
  });

  it('counts a stocked, never-issued item as non-moving stock in the KPIs', async () => {
    const k = await computeInventoryKpis({ companyId: A });
    const ids = k.obsolete_slow_moving.items.map(i => i.item_id);
    expect(ids).toContain(item.RECEIPT);
    expect(ids).toContain(item.TRANSFER);
    expect(ids).not.toContain(item.NEVER);                       // nothing on hand
    expect(k.obsolete_slow_moving.non_moving_count).toBeGreaterThanOrEqual(2);
  });

  it('GET /planning/abc lists unclassified items and says why', async () => {
    const res = await request(appAs(A)).get('/planning/abc');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map(i => [i.id, i]));
    expect(byId.size).toBe(Object.keys(item).length - 1);

    const never = byId.get(item.NEVER);
    expect(never).toBeDefined();                                 // used to be absent
    expect(never.fsn_class).toBe('N');
    expect(never.abc_class).toBeNull();
    expect(never.classification_status).toBe('insufficient_history');
    expect(never.annual_consumption_value).toBeNull();

    expect(byId.get(item.G2).classification_status).toBe('classified');
    expect(byId.get(item.MANUALSKIP).classification_status).toBe('manual');
    expect(byId.has(item.BITEM)).toBe(false);                    // other tenant

    const n = await request(appAs(A)).get('/planning/abc').query({ fsn_class: 'N' });
    expect(n.body.items.map(i => i.id)).toEqual(expect.arrayContaining([item.NEVER, item.RECEIPT, item.TRANSFER]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recompute · tenant isolation', () => {
  // 10
  it("company A's run does not touch company B, and B's own run does", async () => {
    const bRow = await row(item.BITEM);
    expect(bRow.fsn_class).toBe('S');                            // untouched by A's run above
    expect(bRow.abc_class).toBe('B');
    expect(bRow.xyz_class).toBe('Y');
    expect(bRow.classified_at).toBeNull();
    expect(await runCount(B)).toBe(0);

    // A second A run, for good measure, then B's own run — the positive pair,
    // so a recompute that silently did nothing for anyone cannot pass.
    await planning.recomputePlanningParameters({ companyId: A, apply: true });
    expect(await row(item.BITEM)).toEqual(bRow);

    await planning.recomputePlanningParameters({ companyId: B, apply: true });
    const after = await row(item.BITEM);
    expect(after.fsn_class).toBe('N');
    expect(after.abc_class).toBeNull();
    expect(after.xyz_class).toBeNull();
    expect(await runCount(B)).toBe(1);
  }, 30_000);
});
