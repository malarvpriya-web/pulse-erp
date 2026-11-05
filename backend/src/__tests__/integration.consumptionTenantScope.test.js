/**
 * integration.consumptionTenantScope.test.js — Stage 5B: POST
 * /inventory/consumption and its three reads.
 *
 * The write took item, warehouse, project, reference_type and reference_id
 * straight from the body: no company check on any of them, the ledger row
 * written with a NULL company, and any reference_type accepted — including
 * sales_order, which /orders/fulfilment-reconciliation counts as fulfilment
 * evidence. The three reads used `req.scope?.company_id ?? null`, so a login
 * with no company read every tenant's consumption.
 *
 * Now: companyScope on all four; item + warehouse via resolveStockOwnership
 * (Stage 2/5A rule); project in the warehouse's company and not deleted; the
 * reference policy (manual | project) checked before any database work.
 *
 * NOT covered here, deliberately: the MRP / order-promising double count. The
 * allocation row this route writes is the only record the three consumption
 * reads have, so it was not removed — see the Stage 5B report.
 *
 * Throwaway rows under TAG, swept before and after. Run with
 * `npm run test:db` (isolated pulse_e2e database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool }      = await import('../config/db.js');
const { default: invRouter } = await import('../modules/inventory/routes/inventory.routes.js');

const TAG = 'ZZCONSM';

function appWith({ scope, companyId = null, roles = ['admin'] }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000009, id: 2000000009, company_id: companyId, roles, role: roles[0] };
    req.scope = scope;
    next();
  });
  app.use('/inventory', invRouter);
  return app;
}
const asCompany = (cid) => appWith({ scope: { company_id: cid }, companyId: cid });
const asSuperAdmin = () => appWith({ scope: { company_id: null, branch_id: null, isGlobal: true }, roles: ['admin', 'super_admin'] });
const noCompany = () => appWith({ scope: null });

const ids = {};
const OURS = `(SELECT id FROM inventory_items WHERE item_code LIKE $1)`;
const OUR_WH = `(SELECT id FROM warehouses WHERE warehouse_name LIKE $1)`;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  await pool.query(`DELETE FROM inventory_allocations WHERE item_id IN ${OURS} OR warehouse_id IN ${OUR_WH}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM stock_ledger WHERE item_id IN ${OURS} OR warehouse_id IN ${OUR_WH}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM warehouses WHERE warehouse_name LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM projects WHERE project_code LIKE $1`, [`${TAG}%`]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function makeWarehouse(key, companyId) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [`${TAG} ${key}`, companyId]);
  ids[key] = w.id;
}
async function makeItem(key, companyId) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, reorder_level, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', 1, 10, true) RETURNING id`, [`${TAG}-${key}`, companyId]);
  ids[key] = i.id;
}
async function makeProject(key, companyId, { deleted = false } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO projects (project_code, project_name, company_id, deleted_at) VALUES ($1, $1, $2, $3) RETURNING id`,
    [`${TAG}-${key}`, companyId, deleted ? new Date() : null]);
  ids[key] = p.id;
}
async function seed(itemKey, whKey, companyId, qty) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, company_id, transaction_type, quantity_in, quantity_out,
                               balance_qty, rate, value, transaction_date, remarks)
     VALUES ($1, $2, $3, 'opening', $4::numeric, 0, $4::numeric, 10, $4::numeric * 10, CURRENT_DATE, $5)`,
    [ids[itemKey], ids[whKey], companyId, qty, `${TAG} seed`]);
}

// Ledger rows, allocation rows and every item/warehouse balance we own.
async function footprint() {
  const p = [`${TAG}%`];
  const scope = `(item_id IN ${OURS} OR warehouse_id IN ${OUR_WH})`;
  const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM stock_ledger WHERE ${scope}`, p);
  const { rows: [{ a }] } = await pool.query(`SELECT COUNT(*)::int AS a FROM inventory_allocations WHERE ${scope}`, p);
  const { rows } = await pool.query(
    `SELECT item_id || '@' || warehouse_id AS k, SUM(quantity_in - quantity_out)::float AS q
       FROM stock_ledger WHERE ${scope} GROUP BY item_id, warehouse_id`, p);
  return { ledger: n, allocations: a, balances: Object.fromEntries(rows.map(r => [r.k, r.q])) };
}

const consume = (whKey, itemKey, quantity, extra = {}) => ({
  item_id: ids[itemKey], warehouse_id: ids[whKey], quantity, notes: `${TAG} consume`, ...extra,
});
const post = (app, body) => request(app).post('/inventory/consumption').send(body);
const allocation = async (id) => (await pool.query(
  `SELECT allocation_type, reference_type, reference_id, project_id, item_id, warehouse_id, quantity::float AS qty
     FROM inventory_allocations WHERE id = $1`, [id])).rows[0];
// The ledger row a consumption wrote: the newest 'issue' for that item/warehouse.
const ledgerFor = async (itemKey, whKey) => (await pool.query(
  `SELECT company_id, transaction_type, reference_type, reference_id, quantity_out::float AS qout
     FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2 AND transaction_type = 'issue'
    ORDER BY id DESC LIMIT 1`, [ids[itemKey], ids[whKey]])).rows[0];

async function refused(app, body, status, message) {
  const before = await footprint();
  const res = await post(app, body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  if (message) expect(res.body.error).toMatch(message);
  expect(await footprint()).toEqual(before);
  return res;
}

beforeAll(async () => {
  await sweep();
  for (const s of ['A', 'B']) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`]);
    ids[`co${s}`] = c.id;
    await makeWarehouse(`wh${s}`, c.id);
    await makeItem(`item${s}`, c.id);
    await seed(`item${s}`, `wh${s}`, c.id, 1000);
    await makeProject(`proj${s}`, c.id);
  }
  await makeWarehouse('whNull', null);
  await makeItem('itemNull', null);
  await seed('itemNull', 'whA', null, 100);
  await seed('itemB', 'whA', ids.coA, 100);          // B's item physically in A's warehouse (drift)
  await seed('itemNull', 'whNull', null, 100);
  await makeProject('projAdeleted', ids.coA, { deleted: true });
  await makeProject('projNull', null);
  const { rows: [{ m }] } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM projects`);
  ids.noSuchProject = Number(m) + 100000;

  // Consumption already on record for each company, for the read tests —
  // written the way the route writes it, so the reads are tested on their own.
  for (const s of ['A', 'B']) {
    await pool.query(
      `INSERT INTO inventory_allocations
         (item_id, warehouse_id, allocation_type, reference_type, reference_id, quantity, rate, allocation_date, purpose, project_id, allocation_source)
       VALUES ($1, $2, 'project', 'project', $3, 4, 10, CURRENT_DATE, $4, $3, 'consumption')`,
      [ids[`item${s}`], ids[`wh${s}`], ids[`proj${s}`], `${TAG} history ${s}`]);
  }
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('valid consumption: posted once and attributed', () => {
  it('manual, no project: 201, one issue under company A, one allocation, stock down by exactly the quantity', async () => {
    const before = await footprint();
    const res = await post(asCompany(ids.coA), consume('whA', 'itemA', 3));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await allocation(res.body.id)).toEqual({
      allocation_type: 'manual', reference_type: 'manual', reference_id: null, project_id: null,
      item_id: ids.itemA, warehouse_id: ids.whA, qty: 3,
    });
    expect(await ledgerFor('itemA', 'whA')).toEqual({
      company_id: ids.coA, transaction_type: 'issue', reference_type: 'manual', reference_id: null, qout: 3,
    });
    const after = await footprint();
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.allocations).toBe(before.allocations + 1);
    expect(after.balances[`${ids.itemA}@${ids.whA}`]).toBe(before.balances[`${ids.itemA}@${ids.whA}`] - 3);

    // Response shape unchanged: the allocation row.
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_allocations' AND table_schema = 'public'`);
    expect(Object.keys(res.body).sort()).toEqual(cols.map(c => c.column_name).sort());
  });

  it('manual tagged to its own project: 201, project_id stored, no reference_id', async () => {
    const res = await post(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: 'manual', project_id: ids.projA }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await allocation(res.body.id)).toMatchObject({ reference_type: 'manual', reference_id: null, project_id: ids.projA });
  });

  it('project, reference_id omitted: 201, the project stored as the reference', async () => {
    const res = await post(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: 'project', project_id: ids.projA }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await allocation(res.body.id)).toMatchObject({ allocation_type: 'project', reference_type: 'project', reference_id: ids.projA, project_id: ids.projA });
    expect(await ledgerFor('itemA', 'whA')).toMatchObject({ company_id: ids.coA, reference_type: 'project', reference_id: ids.projA });
  });

  it('project, reference_id equal to project_id (as strings): 201', async () => {
    const res = await post(asCompany(ids.coA), consume('whA', 'itemA', 1,
      { reference_type: 'project', project_id: String(ids.projA), reference_id: String(ids.projA) }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await allocation(res.body.id)).toMatchObject({ reference_id: ids.projA, project_id: ids.projA });
  });

  for (const [label, type, expected] of [
    ['omitted', undefined, 'manual'], ['empty string', '', 'manual'], ['null', null, 'manual'],
    ['"  Project  "', '  Project  ', 'project'], ['"MANUAL"', 'MANUAL', 'manual'],
  ]) {
    it(`reference_type ${label} is normalised to ${expected}`, async () => {
      const extra = { project_id: ids.projA };
      if (type !== undefined) extra.reference_type = type;
      const res = await post(asCompany(ids.coA), consume('whA', 'itemA', 1, extra));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect((await allocation(res.body.id)).reference_type).toBe(expected);
    });
  }

  it('company B consumes under B', async () => {
    const res = await post(asCompany(ids.coB), consume('whB', 'itemB', 1, { reference_type: 'project', project_id: ids.projB }));
    expect(res.status).toBe(201);
    expect((await ledgerFor('itemB', 'whB')).company_id).toBe(ids.coB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('foreign or unusable item, warehouse and project: refused, nothing written', () => {
  it('A\'s warehouse with B\'s item (physically there): 404', async () => {
    await refused(asCompany(ids.coA), consume('whA', 'itemB', 1), 404, new RegExp(`Item ${ids.itemB} not found`));
  });
  it('B\'s warehouse, as company A: 404', async () => {
    await refused(asCompany(ids.coA), consume('whB', 'itemB', 1), 404, /Warehouse .* not found/);
  });
  it('company B reaching into A\'s warehouse: 404', async () => {
    await refused(asCompany(ids.coB), consume('whA', 'itemA', 1), 404, /Warehouse .* not found/);
  });
  it('a NULL-company item: 404', async () => {
    await refused(asCompany(ids.coA), consume('whA', 'itemNull', 1), 404, /Item .* not found/);
  });
  for (const [label, key, type] of [
    ['B\'s project (project type)', 'projB', 'project'], ['B\'s project (manual tag)', 'projB', 'manual'],
    ['a deleted project of A', 'projAdeleted', 'project'], ['a NULL-company project', 'projNull', 'project'],
    ['a project that does not exist', 'noSuchProject', 'project'],
  ]) {
    it(`${label}: 404`, async () => {
      await refused(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: type, project_id: ids[key] }), 404, /Project .* not found/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('only manual and project are allowed', () => {
  for (const type of ['sales_order', 'production_order', 'maintenance', 'SALES_ORDER', ' sales_order ',
                      'transfer', 'issue', 'grn', 'anything', 123, true, ['manual'], { t: 'manual' }]) {
    it(`reference_type ${JSON.stringify(type)}: 422, nothing written`, async () => {
      await refused(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: type, reference_id: ids.projA }), 422, /reference_type/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('malformed ids and bad combinations: 422 before any write', () => {
  for (const bad of ['abc', -1, 0, 1.5, '12abc', '1e3', true, 99999999999, ' ']) {
    it(`project_id = ${JSON.stringify(bad)}: 422`, async () => {
      await refused(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: 'project', project_id: bad }), 422,
        bad === ' ' ? /project_id/ : /project_id must be a positive whole number/);
    });
    it(`reference_id = ${JSON.stringify(bad)}: 422`, async () => {
      await refused(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: 'project', project_id: ids.projA, reference_id: bad }), 422,
        /reference_id/);
    });
  }

  it('manual with any reference_id: 422', async () => {
    await refused(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: 'manual', reference_id: ids.projA }), 422, /not used for manual/);
  });
  it('project with no project_id: 422', async () => {
    await refused(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: 'project' }), 422, /project_id is required/);
  });
  it('project with a reference_id different from project_id: 422', async () => {
    await refused(asCompany(ids.coA), consume('whA', 'itemA', 1, { reference_type: 'project', project_id: ids.projA, reference_id: ids.projA + 1 }), 422, /must match project_id/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('company is never taken from the body; super admin takes the warehouse\'s', () => {
  it('company A naming company B: filed under A', async () => {
    const res = await post(asCompany(ids.coA), consume('whA', 'itemA', 1, { company_id: ids.coB }));
    expect(res.status).toBe(201);
    expect((await ledgerFor('itemA', 'whA')).company_id).toBe(ids.coA);
  });

  it('super admin, B\'s warehouse, item and project: 201 under B', async () => {
    const res = await post(asSuperAdmin(), consume('whB', 'itemB', 1, { reference_type: 'project', project_id: ids.projB, company_id: ids.coA }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await ledgerFor('itemB', 'whB')).company_id).toBe(ids.coB);
  });

  it('super admin, B\'s warehouse with A\'s project: 404 — the project must match the warehouse\'s company', async () => {
    await refused(asSuperAdmin(), consume('whB', 'itemB', 1, { reference_type: 'project', project_id: ids.projA }), 404, /Project .* not found/);
  });

  it('super admin, A\'s warehouse with B\'s item: 404', async () => {
    await refused(asSuperAdmin(), consume('whA', 'itemB', 1), 404, /Item .* not found/);
  });

  it('super admin, NULL-company warehouse: 422, cannot be attributed', async () => {
    await refused(asSuperAdmin(), consume('whNull', 'itemNull', 1), 422, /no company/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('gates, rollback and the unchanged rules', () => {
  it('no company: 403 NO_COMPANY_SCOPE, nothing written', async () => {
    for (const scope of [null, { company_id: null, branch_id: null }]) {
      const res = await refused(appWith({ scope }), consume('whA', 'itemA', 1), 403);
      expect(res.body.code).toBe('NO_COMPANY_SCOPE');
    }
  });

  it('a role without inventory:add: 403 from the permission gate', async () => {
    const app = appWith({ scope: { company_id: ids.coA }, companyId: ids.coA, roles: ['zz_no_such_role'] });
    const res = await refused(app, consume('whA', 'itemA', 1), 403);
    expect(res.body.code).not.toBe('NO_COMPANY_SCOPE');
  });

  it('more than the free stock: 422, no ledger row, no allocation row', async () => {
    await refused(asCompany(ids.coA), consume('whA', 'itemA', 999999), 422, /Insufficient/);
  });

  it('missing required fields: 422', async () => {
    await refused(asCompany(ids.coA), { item_id: ids.itemA, quantity: 1 }, 422, /required/);
  });

  it('a non-positive quantity: 422', async () => {
    await refused(asCompany(ids.coA), consume('whA', 'itemA', -2), 422, /positive/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the three reads are company-scoped', () => {
  const codesIn = (rows) => new Set(rows.map(r => r.item_code).filter(c => String(c).startsWith(TAG)));
  const reads = [
    ['GET /consumption', '/inventory/consumption'],
    ['GET /consumption/by-type', '/inventory/consumption/by-type'],
    ['GET /consumption/by-project', '/inventory/consumption/by-project'],
  ];
  const rowsOf = (body) => (Array.isArray(body) ? body : body?.data ?? []);

  for (const [label, url] of reads) {
    it(`${label}: company A sees its own consumption and none of B's`, async () => {
      const res = await request(asCompany(ids.coA)).get(url);
      expect(res.status).toBe(200);
      const codes = codesIn(rowsOf(res.body));
      expect(codes.has(`${TAG}-itemA`)).toBe(true);
      expect(codes.has(`${TAG}-itemB`)).toBe(false);
    });

    it(`${label}: company B sees only B's`, async () => {
      const codes = codesIn(rowsOf((await request(asCompany(ids.coB)).get(url)).body));
      expect(codes.has(`${TAG}-itemB`)).toBe(true);
      expect(codes.has(`${TAG}-itemA`)).toBe(false);
    });

    it(`${label}: a super admin sees both, explicitly`, async () => {
      const res = await request(asSuperAdmin()).get(url);
      expect(res.status).toBe(200);
      const codes = codesIn(rowsOf(res.body));
      expect(codes.has(`${TAG}-itemA`)).toBe(true);
      expect(codes.has(`${TAG}-itemB`)).toBe(true);
    });

    it(`${label}: no company is 403, not every tenant`, async () => {
      for (const scope of [null, { company_id: null, branch_id: null }]) {
        const res = await request(appWith({ scope })).get(url);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('NO_COMPANY_SCOPE');
      }
    });
  }

  it('by-project lists A\'s project for A and not B\'s', async () => {
    const rows = rowsOf((await request(asCompany(ids.coA)).get('/inventory/consumption/by-project')).body);
    const projects = new Set(rows.map(r => r.project_id));
    expect(projects.has(ids.projA)).toBe(true);
    expect(projects.has(ids.projB)).toBe(false);
  });
});
