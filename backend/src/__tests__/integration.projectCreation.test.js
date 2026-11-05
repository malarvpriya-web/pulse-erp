/**
 * integration.projectCreation.test.js — one authoritative project creator
 * (P1_PROJECT_LIFECYCLE_PLAN.md Phase 2), against the REAL database and the
 * real routers mounted as server.js mounts them.
 *
 * Callers covered (plan §1.1):
 *   C1 PATCH /crm/opportunities/:id/stage -> won   (auto-convert, after the response)
 *   C2 POST  /crm/opportunities/:id/convert-to-project
 *   C3 sales order confirm / status / quotation conversions (autoBootstrap)
 *   C4 POST  /lifecycle/instances/from-sales-order/:id, /auto-bootstrap/:id
 *   C5 POST  /lifecycle/instances
 *   C6 POST  /projects/projects
 *
 * Rules under test: a delivery project comes from a WON opportunity or a
 * CONFIRMED sales order; one project per opportunity; one open lifecycle per
 * project; company taken from the business records; references (opportunity,
 * order, project manager, product line) in that company; all-or-nothing.
 *
 * Self-cleaning: sweep() removes both synthetic companies and everything under them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

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
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH;

const { default: pool }            = await import('../config/db.js');
const { verifyToken }              = await import('../middlewares/auth.middleware.js');
const { buildApp }                 = await import('./helpers/testApp.js');
const { FIXTURE_CODE_SQL }         = await import('../shared/employeeCode.js');
const { default: salesRoutes }     = await import('../modules/sales/routes/sales.routes.js');
const { default: crmRoutes }       = await import('../modules/crm/routes/crm.routes.js');
const { default: lifecycleRoutes } = await import('../modules/operations/lifecycle.routes.js');
const { default: projectRoutes }   = await import('../modules/projects/routes/projects.routes.js');

const app = buildApp(
  ['/api/sales',     salesRoutes],
  ['/api/crm',       verifyToken, crmRoutes],
  ['/api/lifecycle', verifyToken, lifecycleRoutes],
  ['/api/projects',  verifyToken, projectRoutes],
);

const PREFIX = 'ZZPCS';
const TAG = `${PREFIX}${Date.now().toString(36).toUpperCase()}`;
const EMAIL = (k) => `${TAG.toLowerCase()}.${k}@test.invalid`;
const co = {}, u = {}, emp = {}, line = {};
let seq = 0;
const nextCode = () => `${TAG}${++seq}`;
const LONG_NAME = 'x'.repeat(200);              // lifecycle_instances.created_by_name is VARCHAR(150)
const LONG_ITEM = `${TAG} ${'y'.repeat(300)}`;  // production_orders.product_name is VARCHAR(250)

const tokenFor = (k, extra = {}) => jwt.sign(
  { userId: u[k].id, ...(u[k].company != null ? { company_id: u[k].company } : {}), employee_id: null, name: `${TAG} ${k}`, ...extra },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const call = (method, path, who, extra) =>
  request(app)[method](path).set('Authorization', `Bearer ${tokenFor(who, extra)}`);

async function sweep() {
  const loose = `(SELECT id FROM users WHERE company_id IS NULL AND email LIKE '${PREFIX.toLowerCase()}%@test.invalid')`;
  const companies = `(SELECT id FROM companies WHERE code LIKE '${PREFIX}%')`;
  const allUsers = `(SELECT id FROM users WHERE id IN ${loose} OR company_id IN ${companies})`;
  await pool.query(`DELETE FROM workflow_instance_steps WHERE assigned_to IN ${allUsers} OR actioned_by IN ${allUsers}`).catch(() => {});
  await pool.query(`DELETE FROM workflow_instances WHERE initiated_by IN ${allUsers}
                       OR (entity_type = 'project' AND entity_id IN (SELECT id FROM projects WHERE company_id IN ${companies}))`).catch(() => {});
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN ${loose}`).catch(() => {});
  await pool.query(`DELETE FROM access_denials WHERE user_id IN ${loose}`).catch(() => {});
  await pool.query(`DELETE FROM user_roles WHERE user_id IN ${loose}`);
  await pool.query(`DELETE FROM users WHERE id IN ${loose}`);
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE '${PREFIX}%'`);
  const ids = rows.map(r => Number(r.id));
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]);
  const sos  = `(SELECT id FROM sales_orders WHERE company_id = ANY($1))`;
  const prjs = `(SELECT id FROM projects WHERE company_id = ANY($1))`;
  const lcs  = `(SELECT id FROM lifecycle_instances WHERE company_id = ANY($1) OR sales_order_id IN ${sos} OR project_id IN ${prjs})`;
  const pos  = `(SELECT id FROM production_orders WHERE company_id = ANY($1) OR sales_order_id IN ${sos} OR project_id IN ${prjs})`;
  const users = `(SELECT id FROM users WHERE company_id = ANY($1))`;
  await q(`DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id IN ${lcs}`);
  await q(`DELETE FROM lifecycle_instances WHERE id IN ${lcs}`);
  await q(`DELETE FROM production_operations WHERE production_order_id IN ${pos}`).catch(() => {});
  await q(`DELETE FROM inventory_allocations WHERE company_id = ANY($1)`).catch(() => {});
  await q(`DELETE FROM backorders WHERE company_id = ANY($1)`).catch(() => {});
  await q(`DELETE FROM production_orders WHERE id IN ${pos}`);
  await q(`DELETE FROM commission_entries WHERE sales_order_id IN ${sos}`).catch(() => {});
  await q(`DELETE FROM projects WHERE company_id = ANY($1) OR opportunity_id IN (SELECT id FROM opportunities WHERE company_id = ANY($1))`);
  await q(`DELETE FROM product_lines WHERE company_id = ANY($1)`);
  await q(`DELETE FROM sales_order_items WHERE order_id IN ${sos}`);
  await q(`DELETE FROM sales_orders WHERE id IN ${sos} OR quotation_id IN (SELECT id FROM quotations WHERE company_id = ANY($1))`);
  await q(`DELETE FROM discount_approvals WHERE quotation_id IN (SELECT id FROM quotations WHERE company_id = ANY($1))`).catch(() => {});
  await q(`DELETE FROM quotations WHERE company_id = ANY($1)`);
  await q(`DELETE FROM opportunity_stage_history WHERE opportunity_id IN (SELECT id FROM opportunities WHERE company_id = ANY($1))`).catch(() => {});
  await q(`DELETE FROM opportunities WHERE company_id = ANY($1)`);
  await q(`DELETE FROM accounts WHERE company_id = ANY($1)`);
  await q(`DELETE FROM parties WHERE company_id = ANY($1)`);
  await q(`DELETE FROM notifications WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM audit_logs WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM access_denials WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM user_roles WHERE user_id IN ${users}`);
  await q(`DELETE FROM user_scope WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM users WHERE company_id = ANY($1)`);
  await q(`DELETE FROM employees WHERE company_id = ANY($1)`);
  await q(`DELETE FROM interview_questions WHERE company_id = ANY($1)`).catch(() => {});
  await q(`DELETE FROM companies WHERE id = ANY($1)`);
}

const makeCompany = async (code) =>
  (await pool.query(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${code} Co`, code])).rows[0].id;

async function makeUser(key, company, roleCode) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ($1,$2,'not-a-real-hash',$3,true,$4) RETURNING id`,
    [`${TAG} ${key}`, EMAIL(key), company, roleCode]);
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [rows[0].id, role[0].id]);
  u[key] = { id: rows[0].id, company };
}

const makeEmployee = async (key, company) => {
  emp[key] = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Tester', $2, 'Active') RETURNING id`, [`${TAG}${key}`, company])).rows[0].id;
};

const makeProductLine = async (key, company) => {
  line[key] = (await pool.query(
    `INSERT INTO product_lines (line_name, voltage, voltage_class, company_id) VALUES ($1,'415V','LV',$2) RETURNING id`,
    [`${TAG} ${key}`, company])).rows[0].id;
};

async function makeCustomer(company) {
  const code = nextCode();
  const { rows: [party] } = await pool.query(
    `INSERT INTO parties (party_code, party_type, name, company_id) VALUES ($1,'customer',$2,$3) RETURNING id`,
    [code.slice(-20), `${code} Customer`, company]);
  const { rows: [account] } = await pool.query(
    `INSERT INTO accounts (name, party_id, company_id) VALUES ($1,$2,$3) RETURNING id`,
    [`${code} Customer`, party.id, company]);
  return { partyId: party.id, accountId: account.id };
}

const makeOpportunity = async (company, { stage = 'won', accountId = null } = {}) => (await pool.query(
  `INSERT INTO opportunities (opportunity_name, account_id, company_id, stage, expected_value)
   VALUES ($1,$2,$3,$4,250000) RETURNING id`,
  [`${nextCode()} Opportunity`, accountId, company, stage])).rows[0].id;

const makeQuotation = async (company, opportunityId = null) => (await pool.query(
  `INSERT INTO quotations (quotation_number, company_id, opportunity_id, status, total_amount)
   VALUES ($1,$2,$3,'accepted',0) RETURNING id`,
  [nextCode(), company, opportunityId])).rows[0].id;

async function makeOrder(company, { status = 'draft', quotationId = null, item = `${TAG} Panel` } = {}) {
  const { rows: [so] } = await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, quotation_id, order_date, order_status)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5) RETURNING *`,
    [nextCode(), company, `${TAG} Walk-in`, quotationId, status]);
  await pool.query(
    `INSERT INTO sales_order_items (order_id, description, quantity, unit_price) VALUES ($1,$2,2,1000)`,
    [so.id, item]);
  return so;
}

const makeProject = async (company) => (await pool.query(
  `INSERT INTO projects (project_code, project_name, company_id, status, start_date)
   VALUES ($1,$2,$3,'active',CURRENT_DATE) RETURNING id`, [nextCode(), `${TAG} project`, company])).rows[0].id;

const projectsForOpp = async (oppId) => (await pool.query(
  `SELECT * FROM projects WHERE opportunity_id=$1 AND deleted_at IS NULL ORDER BY id`, [oppId])).rows;
const openLifecycles = async (projectId) => (await pool.query(
  `SELECT * FROM lifecycle_instances WHERE project_id=$1 AND status IN ('active','on_hold') ORDER BY id`, [projectId])).rows;
const lifecyclesForOrder = async (soId) => (await pool.query(
  `SELECT * FROM lifecycle_instances WHERE sales_order_id=$1 ORDER BY id`, [soId])).rows;
const productionOrdersFor = async (soId) => (await pool.query(
  `SELECT * FROM production_orders WHERE sales_order_id=$1 ORDER BY id`, [soId])).rows;

const convert = (oppId, who = 'adminA', extra) => call('post', `/api/crm/opportunities/${oppId}/convert-to-project`, who, extra);
const confirm = (soId, who = 'adminA') => call('patch', `/api/sales/orders/${soId}/confirm`, who);
const manual = (body, who = 'pmA', extra) => call('post', '/api/projects/projects', who, extra)
  .send({ project_name: `${TAG} manual`, status: 'planning', budget: 0, ...body });

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(`${TAG}A`);
  co.B = await makeCompany(`${TAG}B`);
  await makeUser('adminA', co.A, 'admin');
  await makeUser('adminB', co.B, 'admin');
  await makeUser('pmA',    co.A, 'project_manager');
  await makeUser('global', null, 'super_admin');
  await makeEmployee('pmA', co.A);
  await makeEmployee('pmB', co.B);
  await makeProductLine('lineA', co.A);
  await makeProductLine('lineB', co.B);
});

afterAll(async () => { await sweep(); });

// ── Won opportunity conversion ──────────────────────────────────────────────
describe('converting a won opportunity (C2)', () => {
  it('creates one project in the opportunity\'s company with one open lifecycle and its history', async () => {
    const opp = await makeOpportunity(co.A);
    const res = await convert(opp);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['project']);
    expect(res.body.project).toMatchObject({ opportunity_id: opp, company_id: co.A, status: 'planning' });
    expect(res.body.project.project_code).toMatch(/^PRJ-\d{4,}$/);
    const lcs = await openLifecycles(res.body.project.id);
    expect(lcs).toHaveLength(1);
    expect(lcs[0]).toMatchObject({ company_id: co.A, current_stage: 'order' });
    const { rows: hist } = await pool.query(`SELECT * FROM lifecycle_stage_history WHERE lifecycle_instance_id=$1`, [lcs[0].id]);
    expect(hist).toHaveLength(1);
  });

  it('a repeated conversion returns the same project (200, already_existed) and creates nothing', async () => {
    const opp = await makeOpportunity(co.A);
    const first = await convert(opp);
    const again = await convert(opp);
    expect(again.status).toBe(200);
    expect(again.body.already_existed).toBe(true);
    expect(again.body.project.id).toBe(first.body.project.id);
    expect(await projectsForOpp(opp)).toHaveLength(1);
    expect(await openLifecycles(first.body.project.id)).toHaveLength(1);
  });

  it('refuses an opportunity that is not Won (422) and creates nothing; the opportunity can still progress', async () => {
    const opp = await makeOpportunity(co.A, { stage: 'negotiation' });
    const res = await convert(opp);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OPPORTUNITY_NOT_WON');
    expect(await projectsForOpp(opp)).toHaveLength(0);
    const move = await call('patch', `/api/crm/opportunities/${opp}/stage`, 'adminA').send({ stage: 'proposal' });
    expect(move.status).toBe(200);
  });

  it('a global super admin converts into the opportunity\'s company', async () => {
    const opp = await makeOpportunity(co.A);
    const res = await convert(opp, 'global');
    expect(res.status).toBe(201);
    expect(res.body.project.company_id).toBe(co.A);
    expect((await openLifecycles(res.body.project.id))[0].company_id).toBe(co.A);
  });

  it('another company cannot convert it (404)', async () => {
    const opp = await makeOpportunity(co.A);
    expect((await convert(opp, 'adminB')).status).toBe(404);
    expect(await projectsForOpp(opp)).toHaveLength(0);
  });

  it('a lifecycle failure rolls the project back too (500, nothing left), and a retry succeeds', async () => {
    const opp = await makeOpportunity(co.A);
    const res = await convert(opp, 'adminA', { name: LONG_NAME });
    expect(res.status).toBe(500);
    expect(await projectsForOpp(opp)).toHaveLength(0);
    const retry = await convert(opp);
    expect(retry.status).toBe(201);
    expect(await openLifecycles(retry.body.project.id)).toHaveLength(1);
  });
});

// ── Auto-convert on Won ─────────────────────────────────────────────────────
describe('moving an opportunity to Won (C1)', () => {
  it('creates the project through the same service, once', async () => {
    const opp = await makeOpportunity(co.A, { stage: 'negotiation' });
    const res = await call('patch', `/api/crm/opportunities/${opp}/stage`, 'adminA').send({ stage: 'Won' });
    expect(res.status).toBe(200);
    const projects = await waitFor(async () => { const p = await projectsForOpp(opp); return p.length ? p : null; });
    expect(projects).toHaveLength(1);
    expect(projects[0].company_id).toBe(co.A);
    expect(await waitFor(async () => (await openLifecycles(projects[0].id)).length === 1)).toBe(true);
  });
});

// ── Confirmed sales order ───────────────────────────────────────────────────
describe('confirming a sales order (C3)', () => {
  it('creates a project, one lifecycle and one production order, all linked', async () => {
    const so = await makeOrder(co.A);
    const res = await confirm(so.id);
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    const [lc] = await lifecyclesForOrder(so.id);
    const [po] = await productionOrdersFor(so.id);
    const { rows: [p] } = await pool.query(`SELECT * FROM projects WHERE id=$1`, [lc.project_id]);
    expect(p).toMatchObject({ company_id: co.A, sales_order_ref: so.order_number });
    expect(lc.production_order_id).toBe(po.id);
    expect(po.project_id).toBe(p.id);
  });

  it('reuses the won opportunity\'s project and its lifecycle (opportunity converted first)', async () => {
    const opp = await makeOpportunity(co.A);
    const conv = await convert(opp);
    const so = await makeOrder(co.A, { quotationId: await makeQuotation(co.A, opp) });
    expect((await confirm(so.id)).status).toBe(200);
    expect((await projectsForOpp(opp)).map(p => p.id)).toEqual([conv.body.project.id]);
    const lcs = await openLifecycles(conv.body.project.id);
    expect(lcs).toHaveLength(1);
    expect(lcs[0].sales_order_id).toBe(so.id);
    expect((await productionOrdersFor(so.id))[0].project_id).toBe(conv.body.project.id);
  });

  it('a later conversion reuses the order\'s project (order confirmed first)', async () => {
    const opp = await makeOpportunity(co.A);
    const so = await makeOrder(co.A, { quotationId: await makeQuotation(co.A, opp) });
    expect((await confirm(so.id)).status).toBe(200);
    const [lc] = await lifecyclesForOrder(so.id);
    const res = await convert(opp);
    expect(res.status).toBe(200);
    expect(res.body.already_existed).toBe(true);
    expect(res.body.project.id).toBe(lc.project_id);
    expect(await openLifecycles(lc.project_id)).toHaveLength(1);
  });

  it('a second order for the same opportunity joins the same project without a second open lifecycle', async () => {
    const opp = await makeOpportunity(co.A);
    const q = await makeQuotation(co.A, opp);
    const so1 = await makeOrder(co.A, { quotationId: q });
    const so2 = await makeOrder(co.A, { quotationId: q });
    expect((await confirm(so1.id)).status).toBe(200);
    expect((await confirm(so2.id)).status).toBe(200);
    const projects = await projectsForOpp(opp);
    expect(projects).toHaveLength(1);
    expect(await openLifecycles(projects[0].id)).toHaveLength(1);
    expect((await productionOrdersFor(so2.id))[0].project_id).toBe(projects[0].id);
  });

  it('repeated confirmations create nothing new', async () => {
    const so = await makeOrder(co.A);
    await confirm(so.id);
    await confirm(so.id);
    await call('put', `/api/sales/orders/${so.id}/status`, 'adminA').send({ status: 'confirmed' });
    expect(await lifecyclesForOrder(so.id)).toHaveLength(1);
    expect(await productionOrdersFor(so.id)).toHaveLength(1);
    const { rows } = await pool.query(`SELECT id FROM projects WHERE sales_order_ref=$1`, [so.order_number]);
    expect(rows).toHaveLength(1);
  });

  it('a production-order failure leaves no project or lifecycle; the warning names the step', async () => {
    const opp = await makeOpportunity(co.A);
    const so = await makeOrder(co.A, { quotationId: await makeQuotation(co.A, opp), item: LONG_ITEM });
    const res = await confirm(so.id);
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/production order/i);
    expect(await lifecyclesForOrder(so.id)).toHaveLength(0);
    expect(await projectsForOpp(opp)).toHaveLength(0);
    const { rows } = await pool.query(`SELECT id FROM projects WHERE sales_order_ref=$1`, [so.order_number]);
    expect(rows).toHaveLength(0);
  });
});

// ── Opportunity and order at the same time ──────────────────────────────────
describe('an opportunity conversion and its order confirmation arriving together', () => {
  it('ends with exactly one project, one open lifecycle and one production order', async () => {
    for (let round = 0; round < 3; round++) {
      const opp = await makeOpportunity(co.A);
      const so = await makeOrder(co.A, { quotationId: await makeQuotation(co.A, opp) });
      const results = await Promise.all([convert(opp), confirm(so.id), convert(opp), confirm(so.id)]);
      for (const r of results) expect([200, 201]).toContain(r.status);
      const projects = await projectsForOpp(opp);
      expect(projects, `round ${round}`).toHaveLength(1);
      expect(await openLifecycles(projects[0].id)).toHaveLength(1);
      expect(await productionOrdersFor(so.id)).toHaveLength(1);
      expect((await lifecyclesForOrder(so.id))[0].project_id).toBe(projects[0].id);
    }
  });
});

// ── Lifecycle routes ────────────────────────────────────────────────────────
describe('lifecycle bootstrap from an order (C4) and manual lifecycle (C5)', () => {
  it('C4 requires a confirmed order (422 for a draft) and creates nothing', async () => {
    const so = await makeOrder(co.A, { status: 'draft' });
    for (const path of ['from-sales-order', 'auto-bootstrap']) {
      const res = await call('post', `/api/lifecycle/instances/${path}/${so.id}`, 'adminA');
      expect(res.status, path).toBe(422);
    }
    expect(await lifecyclesForOrder(so.id)).toHaveLength(0);
    expect(await productionOrdersFor(so.id)).toHaveLength(0);
  });

  it('C4 now creates the project too, and a repeat returns the existing lifecycle (200)', async () => {
    const so = await makeOrder(co.A, { status: 'confirmed' });
    const res = await call('post', `/api/lifecycle/instances/from-sales-order/${so.id}`, 'adminA');
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('lifecycle');
    expect(res.body).toHaveProperty('production_order');
    expect(res.body.existed).toBe(false);
    expect(res.body.lifecycle.project_id).not.toBeNull();
    expect(res.body.production_order.project_id).toBe(res.body.lifecycle.project_id);
    const again = await call('post', `/api/lifecycle/instances/auto-bootstrap/${so.id}`, 'adminA');
    expect(again.status).toBe(200);
    expect(again.body.existed).toBe(true);
    expect(again.body.lifecycle.id).toBe(res.body.lifecycle.id);
    expect(await lifecyclesForOrder(so.id)).toHaveLength(1);
    expect(await productionOrdersFor(so.id)).toHaveLength(1);
  });

  it('C4 attaches to a named project of the same company, without a second open lifecycle', async () => {
    const prj = await makeProject(co.A);
    const so = await makeOrder(co.A, { status: 'confirmed' });
    const res = await call('post', `/api/lifecycle/instances/from-sales-order/${so.id}`, 'adminA')
      .send({ project_id: prj, auto_create_production_order: false });
    expect(res.status).toBe(201);
    expect(res.body.lifecycle.project_id).toBe(prj);
    expect(res.body.production_order).toBeNull();
    expect(await openLifecycles(prj)).toHaveLength(1);
  });

  it('C4: a production-order failure leaves no project or lifecycle (500)', async () => {
    const so = await makeOrder(co.A, { status: 'confirmed', item: LONG_ITEM });
    const res = await call('post', `/api/lifecycle/instances/from-sales-order/${so.id}`, 'adminA');
    expect(res.status).toBe(500);
    expect(await lifecyclesForOrder(so.id)).toHaveLength(0);
    const { rows } = await pool.query(`SELECT id FROM projects WHERE sales_order_ref=$1`, [so.order_number]);
    expect(rows).toHaveLength(0);
  });

  it('C5 with a confirmed order creates the project and lifecycle; a second request is refused (409)', async () => {
    const so = await makeOrder(co.A, { status: 'confirmed' });
    const res = await call('post', '/api/lifecycle/instances', 'adminA').send({ sales_order_id: so.id, stage_notes: 'manual' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sales_order_id: so.id, company_id: co.A, current_stage: 'order' });
    expect(res.body.project_id).not.toBeNull();
    const again = await call('post', '/api/lifecycle/instances', 'adminA').send({ sales_order_id: so.id });
    expect(again.status).toBe(409);
    expect(await lifecyclesForOrder(so.id)).toHaveLength(1);
  });

  it('C5 refuses a draft order (422), a project that already has an open lifecycle (409), and no link at all (400)', async () => {
    const draft = await makeOrder(co.A, { status: 'draft' });
    expect((await call('post', '/api/lifecycle/instances', 'adminA').send({ sales_order_id: draft.id })).status).toBe(422);
    const opp = await makeOpportunity(co.A);
    const conv = await convert(opp);
    expect((await call('post', '/api/lifecycle/instances', 'adminA').send({ project_id: conv.body.project.id })).status).toBe(409);
    expect(await openLifecycles(conv.body.project.id)).toHaveLength(1);
    expect((await call('post', '/api/lifecycle/instances', 'adminA').send({})).status).toBe(400);
  });

  it('C5 starts a lifecycle for a project that has none (201)', async () => {
    const prj = await makeProject(co.A);
    const res = await call('post', '/api/lifecycle/instances', 'adminA').send({ project_id: prj });
    expect(res.status).toBe(201);
    expect(res.body.project_id).toBe(prj);
  });
});

// ── Manual project creation ─────────────────────────────────────────────────
describe('creating a project by hand (C6)', () => {
  it('creates the project with a server code and one open lifecycle; the response keeps the project row shape', async () => {
    const res = await manual({ project_manager_id: emp.pmA, product_line_id: line.lineA });
    expect(res.status).toBe(201);
    for (const k of ['id', 'project_code', 'project_name', 'status', 'company_id', 'project_manager_id', 'product_line_id', 'start_date']) {
      expect(res.body).toHaveProperty(k);
    }
    expect(res.body.company_id).toBe(co.A);
    expect(res.body.start_date).not.toBeNull();
    expect(await openLifecycles(res.body.id)).toHaveLength(1);
  });

  it('with a won opportunity: links it; a second project for the same opportunity is refused (409)', async () => {
    const opp = await makeOpportunity(co.A);
    const first = await manual({ opportunity_id: opp });
    expect(first.status).toBe(201);
    expect(first.body.opportunity_id).toBe(opp);
    const second = await manual({ opportunity_id: opp });
    expect(second.status).toBe(409);
    expect(second.body.project_id).toBe(first.body.id);
    expect(await projectsForOpp(opp)).toHaveLength(1);
  });

  it('refuses an opportunity that is not Won (422)', async () => {
    const opp = await makeOpportunity(co.A, { stage: 'proposal' });
    const res = await manual({ opportunity_id: opp });
    expect(res.status).toBe(422);
    expect(await projectsForOpp(opp)).toHaveLength(0);
  });

  it('refuses another company\'s or a missing opportunity, project manager or product line (400, nothing created)', async () => {
    const oppB = await makeOpportunity(co.B);
    const cases = [
      { opportunity_id: oppB }, { opportunity_id: 2147480000 },
      { project_manager_id: emp.pmB }, { product_line_id: line.lineB },
    ];
    for (const body of cases) {
      const name = `${TAG} bad ${JSON.stringify(body)}`;
      const res = await manual({ ...body, project_name: name });
      expect(res.status, JSON.stringify(body)).toBe(400);
      const { rows } = await pool.query(`SELECT id FROM projects WHERE project_name=$1`, [name]);
      expect(rows).toHaveLength(0);
    }
  });

  it('a global super admin must name a valid company (400 without, 400 for a missing one, 201 with one)', async () => {
    expect((await manual({}, 'global')).status).toBe(400);
    expect((await manual({ company_id: 2147480000 }, 'global')).status).toBe(400);
    const ok = await manual({ company_id: co.B }, 'global');
    expect(ok.status).toBe(201);
    expect(ok.body.company_id).toBe(co.B);
    expect((await openLifecycles(ok.body.id))[0].company_id).toBe(co.B);
  });

  it('a global super admin with an opportunity takes the opportunity\'s company; a conflicting company is refused (400)', async () => {
    const opp = await makeOpportunity(co.A);
    expect((await manual({ opportunity_id: opp, company_id: co.B }, 'global')).status).toBe(400);
    const ok = await manual({ opportunity_id: opp }, 'global');
    expect(ok.status).toBe(201);
    expect(ok.body.company_id).toBe(co.A);
  });

  it('a company user cannot place a project in another company through company_id', async () => {
    const res = await manual({ company_id: co.B });
    expect(res.status).toBe(201);
    expect(res.body.company_id).toBe(co.A);
  });

  it('a lifecycle failure rolls the project back (500, nothing left)', async () => {
    const name = `${TAG} lifecycle fails`;
    const res = await manual({ project_name: name }, 'pmA', { name: LONG_NAME });
    expect(res.status).toBe(500);
    const { rows } = await pool.query(`SELECT id FROM projects WHERE project_name=$1`, [name]);
    expect(rows).toHaveLength(0);
  });
});

// ── Editing references ──────────────────────────────────────────────────────
describe('editing a project\'s project manager and product line (PUT)', () => {
  it('refuses another company\'s project manager or product line (400, unchanged); accepts its own', async () => {
    const prj = await makeProject(co.A);
    expect((await call('put', `/api/projects/projects/${prj}`, 'pmA').send({ project_manager_id: emp.pmB })).status).toBe(400);
    expect((await call('put', `/api/projects/projects/${prj}`, 'pmA').send({ product_line_id: line.lineB })).status).toBe(400);
    const { rows: [p] } = await pool.query(`SELECT project_manager_id, product_line_id FROM projects WHERE id=$1`, [prj]);
    expect(p).toEqual({ project_manager_id: null, product_line_id: null });
    expect((await call('put', `/api/projects/projects/${prj}`, 'pmA').send({ project_manager_id: emp.pmA, product_line_id: line.lineA })).status).toBe(200);
  });

  it('refuses to point a project at an opportunity that already has another project (409)', async () => {
    const opp = await makeOpportunity(co.A);
    const conv = await convert(opp);
    const other = await makeProject(co.A);
    const res = await call('put', `/api/projects/projects/${other}`, 'pmA').send({ opportunity_id: opp });
    expect(res.status).toBe(409);
    expect(res.body.project_id).toBe(conv.body.project.id);
    expect(await projectsForOpp(opp)).toHaveLength(1);
  });
});
