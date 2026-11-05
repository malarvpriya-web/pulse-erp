/**
 * integration.orderToProjectChain.test.js — Sales Order -> Lifecycle -> Project
 * -> Production Order bootstrap (sales.routes.js autoBootstrapLifecycleOnOrderAccept),
 * against the REAL database. LEGACY_MIS_TO_PULSE_AUDIT.md §4, P0 Task 1.
 *
 * Each describe reproduces one confirmed failure of the pre-fix code:
 *   1. An order WITH a customer (sales_orders.customer_id, a parties UUID) wrote
 *      that UUID into lifecycle_instances.customer_id (INTEGER) — the whole
 *      bootstrap rolled back and no lifecycle/project/production order existed.
 *      integration.planToProduce only ever confirms customer-less orders, which is
 *      why it never saw this.
 *   2. A won opportunity already owns a project (opportunityConversion.service.js);
 *      confirming that opportunity's order created a SECOND project with the same
 *      opportunity_id, and a second lifecycle.
 *   3. Retries / concurrent confirms must not multiply anything.
 *   4. A failure part-way through used to be swallowed by per-step SAVEPOINTs, so
 *      the lifecycle and project committed without their production order. It must
 *      now be all-or-nothing, with a warning that names the failing step.
 *   5. The project code was COUNT(*)+1 per company against a GLOBAL unique index,
 *      with ON CONFLICT DO NOTHING — a taken code silently produced a lifecycle and
 *      production order with no project at all.
 *
 * Self-cleaning: every row created is removed in afterAll, keyed off the ids
 * collected below (and TAG for anything the bootstrap creates on its own).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

// Real DB credentials — same bootstrap as integration.planToProduce.test.js; it
// must run before anything imports config/db.js.
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

const { default: pool }        = await import('../config/db.js');
const { buildApp }             = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');
const { default: salesRoutes } = await import('../modules/sales/routes/sales.routes.js');
const { convertOpportunityToProject } = await import('../modules/crm/services/opportunityConversion.service.js');

const salesApp = buildApp(['/api/sales', salesRoutes]); // sales.routes.js calls router.use(verifyToken) itself

// Runs in its OWN throwaway company (helpers/isolatedCompany.js), never in
// company 1: supplyChain plans MRP over all of company 1's demand, and this
// suite's orders appearing there mid-run made supplyChain fail in parallel runs.
const PREFIX = 'ZZO2P';
let CO, ADMIN_ID, auth;

const TAG = `${PREFIX}_${Date.now()}`;

/** Every business row this suite can create, scoped to one test company. */
async function purgeCompany(companyId) {
  const q = (label, sql) => pool.query(sql, [companyId]).catch(e => console.warn(`[cleanup] ${label} failed:`, e.message));
  const lcs = `(SELECT id FROM lifecycle_instances WHERE company_id = $1)`;
  await q('lifecycle_stage_history', `DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id IN ${lcs}`);
  await q('lifecycle_instances',     `DELETE FROM lifecycle_instances WHERE company_id = $1`);
  await q('production_operations',   `DELETE FROM production_operations WHERE production_order_id IN (SELECT id FROM production_orders WHERE company_id = $1)`);
  await q('production_orders',       `DELETE FROM production_orders WHERE company_id = $1`);
  await q('workflow_instances',      `DELETE FROM workflow_instances WHERE entity_type = 'project' AND entity_id IN (SELECT id FROM projects WHERE company_id = $1)`);
  await q('sales_orders.project_id', `UPDATE sales_orders SET project_id = NULL WHERE company_id = $1`);
  await q('projects',                `DELETE FROM projects WHERE company_id = $1`);
  await q('sales_order_items',       `DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = $1)`);
  await q('sales_orders',            `DELETE FROM sales_orders WHERE company_id = $1`);
  await q('quotations',              `DELETE FROM quotations WHERE company_id = $1`);
  await q('opportunity_stage_history', `DELETE FROM opportunity_stage_history WHERE opportunity_id IN (SELECT id FROM opportunities WHERE company_id = $1)`);
  await q('opportunities',           `DELETE FROM opportunities WHERE company_id = $1`);
  await q('accounts',                `DELETE FROM accounts WHERE company_id = $1`);
  await q('parties',                 `DELETE FROM parties WHERE company_id = $1`);
}

beforeAll(async () => {
  for (const old of await leftoverCompanies(pool, PREFIX)) {   // an earlier aborted run of THIS suite
    await purgeCompany(old);
    await dropIsolatedCompany(pool, old);
  }
  const iso = await createIsolatedCompany(pool, PREFIX);
  CO = iso.companyId;
  ADMIN_ID = iso.adminId;
  auth = () => `Bearer ${iso.token()}`;
});

afterAll(async () => {
  await purgeCompany(CO);
  await dropIsolatedCompany(pool, CO);
});

// ── fixtures ────────────────────────────────────────────────────────────────
// Short codes: parties.party_code is VARCHAR(20).
const CODE = `ZO${Date.now().toString(36)}`;
let seq = 0;
const next = () => `${CODE}${++seq}`;

async function makeCustomer() {
  const code = next();
  const { rows: [party] } = await pool.query(
    `INSERT INTO parties (party_code, party_type, name, company_id) VALUES ($1,'customer',$2,$3) RETURNING id`,
    [code, `${code} Customer`, CO]
  );
  const { rows: [account] } = await pool.query(
    `INSERT INTO accounts (name, party_id, company_id) VALUES ($1,$2,$3) RETURNING id`,
    [`${code} Customer`, party.id, CO]
  );
  return { partyId: party.id, accountId: account.id, name: `${code} Customer` };
}

async function makeOpportunity(accountId) {
  const { rows: [opp] } = await pool.query(
    `INSERT INTO opportunities (opportunity_name, account_id, company_id, stage, expected_value)
     VALUES ($1,$2,$3,'won',100000) RETURNING id`, // only a Won opportunity converts (Phase 2)
    [`${next()} Opportunity`, accountId, CO]
  );
  return opp.id;
}

async function makeQuotation({ opportunityId = null, partyId = null } = {}) {
  const { rows: [q] } = await pool.query(
    `INSERT INTO quotations (quotation_number, company_id, customer_id, opportunity_id, status)
     VALUES ($1,$4,$2,$3,'accepted') RETURNING id`,
    [next(), partyId, opportunityId, CO]
  );
  return q.id;
}

/** A draft order (never auto-bootstrapped yet) with one line item. */
async function makeOrder({ partyId = null, customerName, quotationId = null, itemDescription }) {
  const { rows: [so] } = await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_id, customer_name, quotation_id, order_date, order_status)
     VALUES ($1,$5,$2,$3,$4,CURRENT_DATE,'draft') RETURNING *`,
    [next(), partyId, customerName || `${TAG} Walk-in`, quotationId, CO]
  );
  await pool.query(
    `INSERT INTO sales_order_items (order_id, description, quantity, unit_price) VALUES ($1,$2,2,1000)`,
    [so.id, itemDescription || `${TAG} Panel`]
  );
  return so;
}

const confirm = (soId) =>
  request(salesApp).patch(`/api/sales/orders/${soId}/confirm`).set('Authorization', auth());

async function chainFor(soId) {
  const lifecycles = (await pool.query(
    `SELECT * FROM lifecycle_instances WHERE sales_order_id=$1 ORDER BY id`, [soId])).rows;
  const productionOrders = (await pool.query(
    `SELECT * FROM production_orders WHERE sales_order_id=$1 ORDER BY id`, [soId])).rows;
  const { rows: [so] } = await pool.query(`SELECT order_number FROM sales_orders WHERE id=$1`, [soId]);
  const projects = (await pool.query(
    `SELECT * FROM projects
      WHERE deleted_at IS NULL
        AND (sales_order_ref=$1 OR id = ANY($2::int[]))
      ORDER BY id`,
    [so.order_number, lifecycles.map(l => l.project_id).filter(Boolean)])).rows;
  return { lifecycles, productionOrders, projects };
}

// ── 1. Order with a customer ────────────────────────────────────────────────
describe('confirming an order that has a customer', () => {
  let customer, so, res;

  beforeAll(async () => {
    customer = await makeCustomer();
    so = await makeOrder({ partyId: customer.partyId, customerName: customer.name });
    res = await confirm(so.id);
  });

  it('confirms without a set-up warning', () => {
    expect(res.status).toBe(200);
    expect(res.body.data.order_status).toBe('confirmed');
    expect(res.body.warning).toBeUndefined();
  });

  it('creates exactly one lifecycle, one project and one production order, all linked', async () => {
    const { lifecycles, productionOrders, projects } = await chainFor(so.id);
    expect(lifecycles).toHaveLength(1);
    expect(projects).toHaveLength(1);
    expect(productionOrders).toHaveLength(1);
    expect(lifecycles[0].project_id).toBe(projects[0].id);
    expect(lifecycles[0].production_order_id).toBe(productionOrders[0].id);
    expect(productionOrders[0].project_id).toBe(projects[0].id);
  });

  it("records the CRM account behind the order's finance party as the lifecycle customer", async () => {
    const { lifecycles } = await chainFor(so.id);
    // lifecycle_instances.customer_id holds an accounts.id (that is what the
    // opportunity path writes); the order carries a parties UUID.
    expect(lifecycles[0].customer_id).toBe(customer.accountId);
  });
});

// ── 2. Won opportunity already has a project ────────────────────────────────
describe('order for an opportunity that was already converted to a project', () => {
  let oppProjectId, oppLifecycleId, so, res, opportunityId;

  beforeAll(async () => {
    const customer = await makeCustomer();
    opportunityId = await makeOpportunity(customer.accountId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await convertOpportunityToProject(client, opportunityId, CO, { userId: ADMIN_ID, userName: TAG });
      await client.query('COMMIT');
      oppProjectId = out.project.id;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    oppLifecycleId = (await pool.query(
      `SELECT id FROM lifecycle_instances WHERE project_id=$1`, [oppProjectId])).rows[0]?.id;

    // Customer-less order on purpose: with a customer, the pre-fix code failed
    // outright (case 1) and never reached the duplicate.
    const quotationId = await makeQuotation({ opportunityId });
    so = await makeOrder({ quotationId });
    res = await confirm(so.id);
  });

  it('confirms without a set-up warning', () => {
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  it('reuses the opportunity project instead of creating a second one', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM projects WHERE opportunity_id=$1 AND deleted_at IS NULL`, [opportunityId]);
    expect(rows.map(r => r.id)).toEqual([oppProjectId]);
  });

  it("attaches the order to the opportunity's existing lifecycle rather than starting another", async () => {
    const { rows } = await pool.query(
      `SELECT id, sales_order_id, production_order_id FROM lifecycle_instances
        WHERE project_id=$1 AND status IN ('active','on_hold')`, [oppProjectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(oppLifecycleId);
    expect(rows[0].sales_order_id).toBe(so.id);
    expect(rows[0].production_order_id).not.toBeNull();
  });

  it('links the production order to that project', async () => {
    const { productionOrders } = await chainFor(so.id);
    expect(productionOrders).toHaveLength(1);
    expect(productionOrders[0].project_id).toBe(oppProjectId);
  });
});

// ── 3. Retries and concurrent confirms ──────────────────────────────────────
describe('retrying the confirmation', () => {
  let so;

  beforeAll(async () => {
    const customer = await makeCustomer();
    so = await makeOrder({ partyId: customer.partyId, customerName: customer.name });
    const first = await confirm(so.id);
    expect(first.status).toBe(200);
  });

  it('a second confirm creates nothing new', async () => {
    const res = await confirm(so.id);
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    const { lifecycles, productionOrders, projects } = await chainFor(so.id);
    expect([lifecycles.length, projects.length, productionOrders.length]).toEqual([1, 1, 1]);
  });

  it('concurrent confirm + status changes still leave exactly one of each', async () => {
    const results = await Promise.all([
      confirm(so.id),
      request(salesApp).put(`/api/sales/orders/${so.id}/status`).set('Authorization', auth()).send({ status: 'confirmed' }),
      request(salesApp).put(`/api/sales/orders/${so.id}/status`).set('Authorization', auth()).send({ status: 'accepted' }),
    ]);
    results.forEach(r => expect(r.status).toBe(200));
    const { lifecycles, productionOrders, projects } = await chainFor(so.id);
    expect([lifecycles.length, projects.length, productionOrders.length]).toEqual([1, 1, 1]);
  });
});

// ── 4. Failure part-way through ─────────────────────────────────────────────
describe('a failure part-way through the bootstrap', () => {
  let so, res;

  beforeAll(async () => {
    // production_orders.product_name is VARCHAR(250) and is filled from the first
    // item's description: a longer description makes the production-order step
    // fail AFTER the lifecycle and project inserts have already run.
    so = await makeOrder({ itemDescription: `${TAG} ${'x'.repeat(300)}` });
    res = await confirm(so.id);
  });

  it('still confirms the order (the order itself is not rolled back)', () => {
    expect(res.status).toBe(200);
    expect(res.body.data.order_status).toBe('confirmed');
  });

  it('leaves no partial lifecycle, project or production order behind', async () => {
    const { lifecycles, productionOrders, projects } = await chainFor(so.id);
    expect(lifecycles).toHaveLength(0);
    expect(projects).toHaveLength(0);
    expect(productionOrders).toHaveLength(0);
  });

  it('returns a warning that names the failing step and the reason, and says how to retry', () => {
    expect(res.body.warning).toMatch(/production order/i);
    expect(res.body.warning).toMatch(/too long/i);
    expect(res.body.warning).toMatch(/nothing was created/i);
  });

  it('can be retried once the cause is fixed', async () => {
    await pool.query(`UPDATE sales_order_items SET description=$2 WHERE order_id=$1`, [so.id, `${TAG} Fixed`]);
    const retry = await confirm(so.id);
    expect(retry.status).toBe(200);
    expect(retry.body.warning).toBeUndefined();
    const { lifecycles, productionOrders, projects } = await chainFor(so.id);
    expect([lifecycles.length, projects.length, productionOrders.length]).toEqual([1, 1, 1]);
  });
});

// ── 5. Project code already taken ───────────────────────────────────────────
describe('when the project code the order path would compute is already taken', () => {
  let so;

  beforeAll(async () => {
    // The pre-fix code numbered PRJ-<year>-<COUNT(company projects)+1> against a
    // globally unique project_code and inserted ON CONFLICT DO NOTHING. Occupy
    // the code it will compute (count includes this decoy, hence +2).
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM projects WHERE company_id=$1`, [CO]);
    const takenCode = `PRJ-${new Date().getFullYear()}-${String(n + 2).padStart(4, '0')}`;
    await pool.query(
      `INSERT INTO projects (project_code, project_name, company_id, status)
       VALUES ($1,$2,$3,'planning') ON CONFLICT (project_code) DO NOTHING RETURNING id`,
      [takenCode, `${TAG} decoy`, CO]
    );
    so = await makeOrder({});
  });

  it('still creates a project for the order', async () => {
    const res = await confirm(so.id);
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    const { lifecycles, projects } = await chainFor(so.id);
    expect(lifecycles).toHaveLength(1);
    expect(lifecycles[0].project_id).not.toBeNull();
    expect(projects).toHaveLength(1);
  });
});

// ── 6. Opportunity conversion when its lifecycle insert fails ───────────────
// Until Phase 2 the lifecycle was best-effort and the project committed without
// one. Now project + lifecycle are one unit (ensureProject): the failure throws
// and the caller's rollback leaves no project.
describe('converting a won opportunity when the lifecycle insert fails', () => {
  it('throws, and the rollback leaves no project behind', async () => {
    const customer = await makeCustomer();
    const opportunityId = await makeOpportunity(customer.accountId);
    const client = await pool.connect();
    let error = null;
    try {
      await client.query('BEGIN');
      // lifecycle_instances.created_by_name is VARCHAR(150): a longer actor
      // name makes only the lifecycle insert fail.
      await convertOpportunityToProject(client, opportunityId, CO, { userId: ADMIN_ID, userName: 'x'.repeat(200) });
      await client.query('COMMIT');
    } catch (e) {
      error = e;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(error?.step).toBe('lifecycle');
    const { rows } = await pool.query(`SELECT id FROM projects WHERE opportunity_id=$1`, [opportunityId]);
    expect(rows).toHaveLength(0);
  });
});
