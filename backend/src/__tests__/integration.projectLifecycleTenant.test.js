/**
 * integration.projectLifecycleTenant.test.js — tenant isolation of project
 * creation and the operations lifecycle, against the REAL database and the
 * real routers mounted as server.js mounts them.
 * P1_PROJECT_LIFECYCLE_PLAN.md §5, Phase 1 (T1–T10).
 *
 *  T1  POST /lifecycle/instances/from-sales-order/:id, /auto-bootstrap/:id read
 *      the sales order by id alone and trusted body bom_id / project_id.
 *  T2  POST /lifecycle/instances trusted every id in the body; a login with no
 *      company read every company's lifecycles.
 *  T3  convertOpportunityToProject gave the project the CALLER's company (NULL
 *      for a global super admin) instead of the opportunity's.
 *  T4  The sales-order bootstrap (and the routes that trigger it) read
 *      quotations, orders, the opportunity's project and the BOM across companies.
 *  T5  Lifecycle gates counted ECNs, BOMs, GRNs and shipments of every company.
 *  T6  POST / PUT /projects/projects accepted another company's opportunity or
 *      sales order reference.
 *  T7  GET /projects/:id/full-history had no permission gate and followed linked
 *      ids (sales_order_ref, lifecycle.sales_order_id) into other companies.
 *  T8  /delivery-tracker had no permission gate.
 *  T9  GET /projects/projects/next-code had no permission gate and consumed a
 *      project number on every call.
 *  T10 GET /crm/customer360/:partyId/projects matched other companies' projects
 *      by customer name.
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
// Never touch a real Google Drive from a test.
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH;

const { default: pool }                  = await import('../config/db.js');
const { verifyToken }                    = await import('../middlewares/auth.middleware.js');
const { buildApp }                       = await import('./helpers/testApp.js');
const { default: salesRoutes }           = await import('../modules/sales/routes/sales.routes.js');
const { default: crmRoutes }             = await import('../modules/crm/routes/crm.routes.js');
const { default: customer360Routes }     = await import('../modules/crm/routes/customer360.routes.js');
const { default: lifecycleRoutes }       = await import('../modules/operations/lifecycle.routes.js');
const { default: projectRoutes }         = await import('../modules/projects/routes/projects.routes.js');
const { default: orderHistoryRoutes }    = await import('../modules/projects/routes/orderHistory.routes.js');
const { default: deliveryTrackerRoutes } = await import('../modules/projects/routes/deliveryTracker.routes.js');
const { convertOpportunityToProject }    = await import('../modules/crm/services/opportunityConversion.service.js');

const app = buildApp(
  ['/api/sales',            salesRoutes],               // calls router.use(verifyToken) itself
  ['/api/crm',              verifyToken, crmRoutes, customer360Routes],
  ['/api/lifecycle',        verifyToken, lifecycleRoutes],
  ['/api/projects',         verifyToken, projectRoutes, orderHistoryRoutes],
  ['/api/delivery-tracker', verifyToken, deliveryTrackerRoutes],
);

const TAG = `ZZPLT${Date.now().toString(36).toUpperCase()}`;
const CODES = [`${TAG}A`, `${TAG}B`];
const EMAIL = (k) => `${TAG.toLowerCase()}.${k}@test.invalid`;
const co = {}, u = {};
let seq = 0;
const nextCode = () => `${TAG}${++seq}`;
// Component ids for the GRN gate; grn_items.item_id / bom_lines.component_id have no FK.
const COMPONENT = 900000000 + (Date.now() % 90000000);

const tokenFor = (k) => jwt.sign(
  { userId: u[k].id, ...(u[k].company != null ? { company_id: u[k].company } : {}), employee_id: null },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const call = (method, path, who) => request(app)[method](path).set('Authorization', `Bearer ${tokenFor(who)}`);

// Matches this suite's own rows from any run (a crashed earlier run included):
// the ZZPLT prefix is used by no other suite.
const PREFIX = 'ZZPLT';
async function sweep() {
  const loose = `(SELECT id FROM users WHERE company_id IS NULL AND email LIKE '${PREFIX.toLowerCase()}%@test.invalid')`;
  const companies = `(SELECT id FROM companies WHERE code LIKE '${PREFIX}%')`;
  const allUsers = `(SELECT id FROM users WHERE id IN ${loose} OR company_id IN ${companies})`;
  // Manual project creation starts a 'projects' workflow (WorkflowService).
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
  await q(`DELETE FROM shipments WHERE company_id = ANY($1)`);
  await q(`DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_receipt_notes WHERE company_id = ANY($1))`);
  await q(`DELETE FROM goods_receipt_notes WHERE company_id = ANY($1)`);
  await q(`DELETE FROM purchase_orders WHERE company_id = ANY($1)`);
  await q(`DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM bom_headers WHERE company_id = ANY($1))`);
  await q(`DELETE FROM bom_headers WHERE company_id = ANY($1)`);
  await q(`DELETE FROM engineering_changes WHERE company_id = ANY($1)`);
  await q(`DELETE FROM commission_entries WHERE sales_order_id IN ${sos}`).catch(() => {});
  await q(`DELETE FROM projects WHERE company_id = ANY($1) OR opportunity_id IN (SELECT id FROM opportunities WHERE company_id = ANY($1))`);
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
  // talent.routes.js seeds interview_questions into every company when it is
  // imported in the same worker.
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
  if (!role.length) throw new Error(`role '${roleCode}' is missing from the matrix`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [rows[0].id, role[0].id]);
  u[key] = { id: rows[0].id, company };
}

async function makeCustomer(company, name = null) {
  const code = nextCode();
  const partyName = name || `${code} Customer`;
  const { rows: [party] } = await pool.query(
    `INSERT INTO parties (party_code, party_type, name, company_id) VALUES ($1,'customer',$2,$3) RETURNING id`,
    [code.slice(-20), partyName, company]);
  const { rows: [account] } = await pool.query(
    `INSERT INTO accounts (name, party_id, company_id) VALUES ($1,$2,$3) RETURNING id`,
    [partyName, party.id, company]);
  return { partyId: party.id, accountId: account.id, name: partyName };
}

// Won: since Phase 2 only a Won opportunity becomes a project, and these
// tests are about company ownership, not the stage rule.
const makeOpportunity = async (company, accountId = null) => (await pool.query(
  `INSERT INTO opportunities (opportunity_name, account_id, company_id, stage, expected_value)
   VALUES ($1,$2,$3,'won',100000) RETURNING id`,
  [`${nextCode()} Opportunity`, accountId, company])).rows[0].id;

const makeQuotation = async (company, { opportunityId = null, partyId = null } = {}) => (await pool.query(
  `INSERT INTO quotations (quotation_number, company_id, customer_id, opportunity_id, status, total_amount)
   VALUES ($1,$2,$3,$4,'accepted',0) RETURNING id`,
  [nextCode(), company, partyId, opportunityId])).rows[0].id;

async function makeOrder(company, { status = 'draft', quotationId = null, partyId = null, item = `${TAG} Panel` } = {}) {
  const { rows: [so] } = await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_id, customer_name, quotation_id, order_date, order_status)
     VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6) RETURNING *`,
    [nextCode(), company, partyId, `${TAG} Walk-in`, quotationId, status]);
  await pool.query(
    `INSERT INTO sales_order_items (order_id, description, quantity, unit_price) VALUES ($1,$2,2,1000)`,
    [so.id, item]);
  return so;
}

const makeProject = async (company, extra = {}) => (await pool.query(
  `INSERT INTO projects (project_code, project_name, company_id, status, start_date, customer_name, opportunity_id, sales_order_ref)
   VALUES ($1,$2,$3,'active',CURRENT_DATE,$4,$5,$6) RETURNING id`,
  [nextCode(), `${TAG} project`, company, extra.customer_name ?? null, extra.opportunity_id ?? null,
   extra.sales_order_ref ?? null])).rows[0].id;

const makeBom = async (company, productName) => (await pool.query(
  `INSERT INTO bom_headers (bom_number, product_name, status, company_id) VALUES ($1,$2,'active',$3) RETURNING id`,
  [nextCode(), productName, company])).rows[0].id;

const makeProductionOrder = async (company, { bomId = null, soId = null } = {}) => (await pool.query(
  `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, bom_id, sales_order_id, company_id)
   VALUES ($1,$2,1,$3,$4,$5) RETURNING id`,
  [nextCode(), `${TAG} product`, bomId, soId, company])).rows[0].id;

const makeLifecycle = async (company, { projectId = null, soId = null, poId = null, stage = 'order' } = {}) => (await pool.query(
  `INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, sales_order_id, production_order_id, current_stage, status)
   VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id`,
  [nextCode(), company, projectId, soId, poId, stage])).rows[0].id;

const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(CODES[0]);
  co.B = await makeCompany(CODES[1]);
  await makeUser('adminA', co.A, 'admin');
  await makeUser('adminB', co.B, 'admin');
  await makeUser('pmA',    co.A, 'project_manager');   // projects: view/add/edit only
  await makeUser('svcB',   co.B, 'service_manager');   // servicedesk: view/add/edit
  await makeUser('empA',   co.A, 'employee');          // no projects / servicedesk
  await makeUser('nocompany', null, 'service_manager'); // not global: no company, not super admin
  await makeUser('global',    null, 'super_admin');     // genuinely global scope
});

afterAll(async () => { await sweep(); });

// ── T1 ──────────────────────────────────────────────────────────────────────
describe('T1 lifecycle bootstrap from a sales order', () => {
  it('refuses another company\'s order on /from-sales-order (404, nothing created)', async () => {
    const soA = await makeOrder(co.A, { status: 'confirmed' });
    const res = await call('post', `/api/lifecycle/instances/from-sales-order/${soA.id}`, 'svcB');
    expect(res.status).toBe(404);
    expect(await count(`SELECT COUNT(*)::int n FROM lifecycle_instances WHERE sales_order_id=$1`, [soA.id])).toBe(0);
    expect(await count(`SELECT COUNT(*)::int n FROM production_orders WHERE sales_order_id=$1`, [soA.id])).toBe(0);
  });

  it('refuses another company\'s order on /auto-bootstrap (404, nothing created)', async () => {
    const soA = await makeOrder(co.A, { status: 'confirmed' });
    const res = await call('post', `/api/lifecycle/instances/auto-bootstrap/${soA.id}`, 'svcB');
    expect(res.status).toBe(404);
    expect(await count(`SELECT COUNT(*)::int n FROM lifecycle_instances WHERE sales_order_id=$1`, [soA.id])).toBe(0);
    expect(await count(`SELECT COUNT(*)::int n FROM production_orders WHERE sales_order_id=$1`, [soA.id])).toBe(0);
  });

  it('refuses a body bom_id or project_id from another company (400, nothing created)', async () => {
    const bomB = await makeBom(co.B, `${TAG} foreign BOM`);
    const prjB = await makeProject(co.B);
    for (const body of [{ bom_id: bomB }, { project_id: prjB }]) {
      const soA = await makeOrder(co.A, { status: 'confirmed' });
      for (const path of ['from-sales-order', 'auto-bootstrap']) {
        const res = await call('post', `/api/lifecycle/instances/${path}/${soA.id}`, 'adminA').send(body);
        expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      }
      expect(await count(`SELECT COUNT(*)::int n FROM lifecycle_instances WHERE sales_order_id=$1`, [soA.id])).toBe(0);
      expect(await count(`SELECT COUNT(*)::int n FROM production_orders WHERE sales_order_id=$1`, [soA.id])).toBe(0);
    }
  });

  it('still bootstraps the caller\'s own order with its own project and BOM (201)', async () => {
    const soA = await makeOrder(co.A, { status: 'confirmed' });
    const prjA = await makeProject(co.A);
    const bomA = await makeBom(co.A, `${TAG} own BOM`);
    const res = await call('post', `/api/lifecycle/instances/from-sales-order/${soA.id}`, 'adminA')
      .send({ project_id: prjA, bom_id: bomA });
    expect(res.status).toBe(201);
    expect(res.body.existed).toBe(false);
    expect(res.body.lifecycle.company_id).toBe(co.A);
    expect(res.body.lifecycle.project_id).toBe(prjA);
    expect(res.body.production_order.bom_id).toBe(bomA);
    expect(res.body.production_order.company_id).toBe(co.A);

    const soA2 = await makeOrder(co.A, { status: 'confirmed' });
    const res2 = await call('post', `/api/lifecycle/instances/auto-bootstrap/${soA2.id}`, 'adminA');
    expect(res2.status).toBe(201);
    expect(res2.body.lifecycle.company_id).toBe(co.A);
  });
});

// ── T2 ──────────────────────────────────────────────────────────────────────
describe('T2 POST /lifecycle/instances and lifecycle reads', () => {
  let own, foreign;
  beforeAll(async () => {
    const custA = await makeCustomer(co.A);
    const custB = await makeCustomer(co.B);
    const soA = await makeOrder(co.A, { status: 'confirmed' }); const soB = await makeOrder(co.B);
    own = {
      sales_order_id: soA.id, production_order_id: await makeProductionOrder(co.A, { soId: soA.id }),
      project_id: await makeProject(co.A), customer_id: custA.accountId,
    };
    foreign = {
      sales_order_id: soB.id, production_order_id: await makeProductionOrder(co.B, { soId: soB.id }),
      project_id: await makeProject(co.B), customer_id: custB.accountId,
    };
  });

  for (const field of ['sales_order_id', 'production_order_id', 'project_id', 'customer_id']) {
    it(`refuses a ${field} from another company (400, nothing created)`, async () => {
      const before = await count(`SELECT COUNT(*)::int n FROM lifecycle_instances WHERE company_id=$1`, [co.A]);
      const res = await call('post', '/api/lifecycle/instances', 'adminA').send({ ...own, [field]: foreign[field] });
      expect(res.status).toBe(400);
      expect(await count(`SELECT COUNT(*)::int n FROM lifecycle_instances WHERE company_id=$1`, [co.A])).toBe(before);
    });
  }

  it('creates a lifecycle from the caller\'s own records (201)', async () => {
    const res = await call('post', '/api/lifecycle/instances', 'adminA').send(own);
    expect(res.status).toBe(201);
    expect(res.body.company_id).toBe(co.A);
    expect(res.body.project_id).toBe(own.project_id);
  });

  it('refuses a login with no company on every lifecycle-instance route (403)', async () => {
    // Its own project: own.project_id already has an open lifecycle, and a
    // second one is refused by ux_lifecycle_open_per_project (Phase 3).
    const lc = await makeLifecycle(co.A, { projectId: await makeProject(co.A) });
    const checks = [
      ['get', '/api/lifecycle/instances'],
      ['get', `/api/lifecycle/instances/${lc}`],
      ['post', '/api/lifecycle/instances'],
      ['post', `/api/lifecycle/instances/from-sales-order/${own.sales_order_id}`],
      ['post', `/api/lifecycle/instances/auto-bootstrap/${own.sales_order_id}`],
      ['post', `/api/lifecycle/instances/${lc}/advance`],
      ['post', `/api/lifecycle/instances/${lc}/hold`],
      ['post', `/api/lifecycle/instances/${lc}/resume`],
    ];
    for (const [m, path] of checks) {
      const res = await call(m, path, 'nocompany').send({});
      expect(res.status, `${m} ${path}`).toBe(403);
    }
    const { rows: [row] } = await pool.query(`SELECT status FROM lifecycle_instances WHERE id=$1`, [lc]);
    expect(row.status).toBe('active');
  });

  it('a global super admin still reads across companies', async () => {
    const res = await call('get', '/api/lifecycle/instances', 'global');
    expect(res.status).toBe(200);
    const companies = new Set(res.body.map(r => r.company_id));
    expect(companies.has(co.A)).toBe(true);
  });
});

// ── T3 ──────────────────────────────────────────────────────────────────────
describe('T3 opportunity conversion takes the opportunity\'s company', () => {
  it('a global super admin converting company A\'s opportunity creates the project in company A', async () => {
    const oppA = await makeOpportunity(co.A);
    const res = await call('post', `/api/crm/opportunities/${oppA}/convert-to-project`, 'global');
    expect(res.status).toBe(201);
    const { rows: [p] } = await pool.query(`SELECT company_id FROM projects WHERE opportunity_id=$1`, [oppA]);
    expect(p.company_id).toBe(co.A);
    const { rows: [lc] } = await pool.query(
      `SELECT li.company_id FROM lifecycle_instances li JOIN projects p ON p.id = li.project_id WHERE p.opportunity_id=$1`, [oppA]);
    expect(lc.company_id).toBe(co.A);
  });

  it('the service called with no company (the auto-on-Won path for a global user) does the same', async () => {
    const oppA = await makeOpportunity(co.A);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await convertOpportunityToProject(client, oppA, null, {});
      await client.query('COMMIT');
      expect(result.project.company_id).toBe(co.A);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  });

  it('company B cannot convert company A\'s opportunity (404)', async () => {
    const oppA = await makeOpportunity(co.A);
    const res = await call('post', `/api/crm/opportunities/${oppA}/convert-to-project`, 'adminB');
    expect(res.status).toBe(404);
    expect(await count(`SELECT COUNT(*)::int n FROM projects WHERE opportunity_id=$1`, [oppA])).toBe(0);
  });
});

// ── T4 ──────────────────────────────────────────────────────────────────────
describe('T4 the sales-order routes that start project / lifecycle set-up', () => {
  it('company B cannot convert company A\'s quotation into an order (convert-to-order, from-quotation: 404)', async () => {
    const qA = await makeQuotation(co.A);
    const r1 = await call('patch', `/api/sales/quotations/${qA}/convert-to-order`, 'adminB');
    const r2 = await call('post', `/api/sales/orders/from-quotation/${qA}`, 'adminB');
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(await count(`SELECT COUNT(*)::int n FROM sales_orders WHERE quotation_id=$1`, [qA])).toBe(0);
    const { rows: [q] } = await pool.query(`SELECT status FROM quotations WHERE id=$1`, [qA]);
    expect(q.status).toBe('accepted');
  });

  it('company B cannot confirm or re-status company A\'s order (404, no set-up)', async () => {
    const soA = await makeOrder(co.A);
    const r1 = await call('patch', `/api/sales/orders/${soA.id}/confirm`, 'adminB');
    const r2 = await call('put', `/api/sales/orders/${soA.id}/status`, 'adminB').send({ status: 'confirmed' });
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    const { rows: [so] } = await pool.query(`SELECT order_status FROM sales_orders WHERE id=$1`, [soA.id]);
    expect(so.order_status).toBe('draft');
    expect(await count(`SELECT COUNT(*)::int n FROM lifecycle_instances WHERE sales_order_id=$1`, [soA.id])).toBe(0);
  });

  it('the caller\'s own quotation still converts, and its own order still confirms and sets up', async () => {
    const qA = await makeQuotation(co.A);
    const r1 = await call('patch', `/api/sales/quotations/${qA}/convert-to-order`, 'adminA');
    expect(r1.status).toBe(201);
    expect(r1.body.warning).toBeUndefined();
    const soA = await makeOrder(co.A);
    const r2 = await call('patch', `/api/sales/orders/${soA.id}/confirm`, 'adminA');
    expect(r2.status).toBe(200);
    expect(r2.body.warning).toBeUndefined();
    const { rows: [lc] } = await pool.query(`SELECT company_id, project_id FROM lifecycle_instances WHERE sales_order_id=$1`, [soA.id]);
    expect(lc.company_id).toBe(co.A);
    const soA2 = await makeOrder(co.A);
    const r3 = await call('put', `/api/sales/orders/${soA2.id}/status`, 'adminA').send({ status: 'confirmed' });
    expect(r3.status).toBe(200);
    expect(await count(`SELECT COUNT(*)::int n FROM lifecycle_instances WHERE sales_order_id=$1`, [soA2.id])).toBe(1);
  });

  it('confirming B\'s order never attaches it to company A\'s project through a cross-company quotation link', async () => {
    const custA = await makeCustomer(co.A);
    const oppA = await makeOpportunity(co.A, custA.accountId);
    const prjA = await makeProject(co.A, { opportunity_id: oppA });
    const lcA = await makeLifecycle(co.A, { projectId: prjA });
    const qA = await makeQuotation(co.A, { opportunityId: oppA, partyId: custA.partyId });
    // Legacy / mis-linked row: B's order points at A's quotation.
    const soB = await makeOrder(co.B, { quotationId: qA });
    const res = await call('patch', `/api/sales/orders/${soB.id}/confirm`, 'adminB');
    expect(res.status).toBe(200);
    const { rows: [lc] } = await pool.query(
      `SELECT li.company_id, li.project_id, p.company_id AS project_company, p.opportunity_id
         FROM lifecycle_instances li JOIN projects p ON p.id = li.project_id WHERE li.sales_order_id=$1`, [soB.id]);
    expect(lc.company_id).toBe(co.B);
    expect(lc.project_id).not.toBe(prjA);
    expect(lc.project_company).toBe(co.B);
    expect(lc.opportunity_id).toBeNull();
    // A's own lifecycle was not taken over.
    const { rows: [own] } = await pool.query(`SELECT sales_order_id FROM lifecycle_instances WHERE id=$1`, [lcA]);
    expect(own.sales_order_id).toBeNull();
  });

  it('never attaches another company\'s BOM to the production order; still matches its own', async () => {
    const productName = `${TAG} BOMMATCH`;
    const bomA = await makeBom(co.A, productName);
    const soB = await makeOrder(co.B, { item: productName });
    const rB = await call('patch', `/api/sales/orders/${soB.id}/confirm`, 'adminB');
    expect(rB.status).toBe(200);
    const { rows: [poB] } = await pool.query(`SELECT bom_id, company_id FROM production_orders WHERE sales_order_id=$1`, [soB.id]);
    expect(poB.company_id).toBe(co.B);
    expect(poB.bom_id).toBeNull();

    const soA = await makeOrder(co.A, { item: productName });
    const rA = await call('patch', `/api/sales/orders/${soA.id}/confirm`, 'adminA');
    expect(rA.status).toBe(200);
    const { rows: [poA] } = await pool.query(`SELECT bom_id FROM production_orders WHERE sales_order_id=$1`, [soA.id]);
    expect(poA.bom_id).toBe(bomA);
  });
});

// ── T5 ──────────────────────────────────────────────────────────────────────
describe('T5 lifecycle gates only count the lifecycle\'s own company', () => {
  const gatesOf = async (lc, who = 'adminA') => {
    const res = await call('get', `/api/lifecycle/instances/${lc}`, who);
    expect(res.status).toBe(200);
    return res.body.gates;
  };

  it('engineering gate: another company\'s approved ECN or name-matching BOM does not open it; its own does', async () => {
    const name = `${TAG} GATEBOM`;
    await pool.query(
      `INSERT INTO engineering_changes (company_id, ecn_number, title, status) VALUES ($1,$2,'foreign ECN','approved')`,
      [co.B, nextCode()]);
    await makeBom(co.B, name);
    const soA = await makeOrder(co.A, { item: name });
    const lc = await makeLifecycle(co.A, { soId: soA.id, stage: 'design' });
    expect((await gatesOf(lc)).engineering_ready).toBe(false);

    // Since Phase 4 a same-company BOM that only matches by NAME does not count
    // either: the BOM must belong to this lifecycle's order / project.
    const ownByName = await makeBom(co.A, name);
    expect((await gatesOf(lc)).engineering_ready).toBe(false);
    await pool.query(`UPDATE bom_headers SET sales_order_id=$2 WHERE id=$1`, [ownByName, soA.id]);
    expect((await gatesOf(lc)).engineering_ready).toBe(true);

    // ...and an approved ECN of the same company on its own does not release a design.
    const soA2 = await makeOrder(co.A, { item: `${TAG} no bom` });
    const lc2 = await makeLifecycle(co.A, { soId: soA2.id, stage: 'design' });
    expect((await gatesOf(lc2)).engineering_ready).toBe(false);
    await pool.query(
      `INSERT INTO engineering_changes (company_id, ecn_number, title, status) VALUES ($1,$2,'own ECN','approved')`,
      [co.A, nextCode()]);
    expect((await gatesOf(lc2)).engineering_ready).toBe(false);
  });

  it('materials gate: another company\'s GRN does not count; its own does', async () => {
    const bomA = await makeBom(co.A, `${TAG} materials`);
    await pool.query(`INSERT INTO bom_lines (bom_id, component_id, component_name, qty, company_id) VALUES ($1,$2,'part',5,$3)`,
      [bomA, COMPONENT, co.A]);
    const prjA = await makeProject(co.A);
    const poA = await makeProductionOrder(co.A, { bomId: bomA });
    await pool.query(`UPDATE production_orders SET project_id=$2 WHERE id=$1`, [poA, prjA]);
    const lc = await makeLifecycle(co.A, { projectId: prjA, poId: poA, stage: 'procurement' });
    // Since Phase 4 a receipt counts only on a purchase order of THIS project.
    const grn = async (company, projectId) => {
      const { rows: [po] } = await pool.query(
        `INSERT INTO purchase_orders (po_number, company_id, project_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
        [nextCode(), company, projectId]);
      const { rows: [g] } = await pool.query(
        `INSERT INTO goods_receipt_notes (grn_number, company_id, po_id, status) VALUES ($1,$2,$3,'received') RETURNING id`,
        [nextCode(), company, po.id]);
      await pool.query(`INSERT INTO grn_items (grn_id, item_id, quantity_received) VALUES ($1,$2,10)`, [g.id, COMPONENT]);
    };
    await grn(co.B, null);
    expect((await gatesOf(lc)).bom_materials_received).toBe(false);
    await grn(co.A, null);                       // same company, not this project
    expect((await gatesOf(lc)).bom_materials_received).toBe(false);
    await grn(co.A, prjA);
    expect((await gatesOf(lc)).bom_materials_received).toBe(true);
  });

  it('dispatch gate: another company\'s delivered shipment does not count; its own does', async () => {
    const soA = await makeOrder(co.A);
    const lc = await makeLifecycle(co.A, { soId: soA.id, stage: 'dispatch' });
    const ship = (company) => pool.query(
      `INSERT INTO shipments (reference_type, reference_id, status, company_id) VALUES ('sales_order',$1,'delivered',$2)`,
      [soA.id, company]);
    await ship(co.B);
    expect((await gatesOf(lc)).dispatch_recorded).toBe(false);
    await ship(co.A);
    expect((await gatesOf(lc)).dispatch_recorded).toBe(true);
  });

  it('company B cannot read company A\'s lifecycle or its gates (404)', async () => {
    const lc = await makeLifecycle(co.A, {});
    const res = await call('get', `/api/lifecycle/instances/${lc}`, 'svcB');
    expect(res.status).toBe(404);
  });
});

// ── T6 ──────────────────────────────────────────────────────────────────────
describe('T6 project create / edit links', () => {
  const base = () => ({ project_name: `${TAG} manual`, start_date: '2031-01-01', status: 'planning', budget: 0 });

  it('POST refuses another company\'s opportunity (400, nothing created)', async () => {
    const oppB = await makeOpportunity(co.B);
    const res = await call('post', '/api/projects/projects', 'pmA').send({ ...base(), opportunity_id: oppB });
    expect(res.status).toBe(400);
    expect(await count(`SELECT COUNT(*)::int n FROM projects WHERE opportunity_id=$1`, [oppB])).toBe(0);
  });

  it('POST accepts the caller\'s own opportunity (201)', async () => {
    const oppA = await makeOpportunity(co.A);
    const res = await call('post', '/api/projects/projects', 'pmA').send({ ...base(), opportunity_id: oppA });
    expect(res.status).toBe(201);
    expect(res.body.opportunity_id).toBe(oppA);
    expect(res.body.company_id).toBe(co.A);
  });

  it('PUT refuses another company\'s opportunity or sales order reference (400, unchanged)', async () => {
    const prjA = await makeProject(co.A);
    const oppB = await makeOpportunity(co.B);
    const soB = await makeOrder(co.B);
    const r1 = await call('put', `/api/projects/projects/${prjA}`, 'pmA').send({ opportunity_id: oppB });
    const r2 = await call('put', `/api/projects/projects/${prjA}`, 'pmA').send({ sales_order_ref: soB.order_number });
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
    const { rows: [p] } = await pool.query(`SELECT opportunity_id, sales_order_ref FROM projects WHERE id=$1`, [prjA]);
    expect(p.opportunity_id).toBeNull();
    expect(p.sales_order_ref).toBeNull();
  });

  it('PUT accepts its own opportunity, its own order number, and free text that names no order (200)', async () => {
    const prjA = await makeProject(co.A);
    const oppA = await makeOpportunity(co.A);
    const soA = await makeOrder(co.A);
    expect((await call('put', `/api/projects/projects/${prjA}`, 'pmA').send({ opportunity_id: oppA })).status).toBe(200);
    expect((await call('put', `/api/projects/projects/${prjA}`, 'pmA').send({ sales_order_ref: soA.order_number })).status).toBe(200);
    expect((await call('put', `/api/projects/projects/${prjA}`, 'pmA').send({ sales_order_ref: `${TAG} MIS-PO-17` })).status).toBe(200);
    const { rows: [p] } = await pool.query(`SELECT opportunity_id, sales_order_ref FROM projects WHERE id=$1`, [prjA]);
    expect(p.opportunity_id).toBe(oppA);
    expect(p.sales_order_ref).toBe(`${TAG} MIS-PO-17`);
  });
});

// ── T7 ──────────────────────────────────────────────────────────────────────
describe('T7 project full history', () => {
  it('requires projects:view (403 for a plain employee, 200 for a project manager)', async () => {
    const prjA = await makeProject(co.A);
    expect((await call('get', `/api/projects/${prjA}/full-history`, 'empA')).status).toBe(403);
    expect((await call('get', `/api/projects/${prjA}/full-history`, 'pmA')).status).toBe(200);
  });

  it('does not follow a sales_order_ref into another company\'s order and lifecycle', async () => {
    const soB = await makeOrder(co.B);
    await makeLifecycle(co.B, { soId: soB.id });
    const prjA = await makeProject(co.A, { sales_order_ref: soB.order_number });
    const res = await call('get', `/api/projects/${prjA}/full-history`, 'adminA');
    expect(res.status).toBe(200);
    expect(res.body.detail.lifecycle_instance ?? null).toBeNull();
    expect(res.body.detail.sales_order ?? null).toBeNull();
  });

  it('does not follow its lifecycle\'s link into another company\'s order, quotation or production order', async () => {
    const qB = await makeQuotation(co.B);
    const soB = await makeOrder(co.B, { quotationId: qB });
    await makeProductionOrder(co.B, { soId: soB.id });
    const prjA = await makeProject(co.A);
    await makeLifecycle(co.A, { projectId: prjA, soId: soB.id });   // mis-linked legacy row
    const res = await call('get', `/api/projects/${prjA}/full-history`, 'adminA');
    expect(res.status).toBe(200);
    expect(res.body.detail.lifecycle_instance).not.toBeNull();
    // Absent (undefined) is how the route already reports a link to a missing order.
    expect(res.body.detail.sales_order ?? null).toBeNull();
    expect(res.body.detail.quotation ?? null).toBeNull();
    expect(res.body.detail.production_orders).toEqual([]);
  });

  it('still shows the project\'s own order', async () => {
    const soA = await makeOrder(co.A);
    const prjA = await makeProject(co.A, { sales_order_ref: soA.order_number });
    await makeLifecycle(co.A, { soId: soA.id });
    const res = await call('get', `/api/projects/${prjA}/full-history`, 'adminA');
    expect(res.status).toBe(200);
    expect(res.body.detail.sales_order?.id).toBe(soA.id);
  });

  it('company B cannot read company A\'s project history (404)', async () => {
    const prjA = await makeProject(co.A);
    expect((await call('get', `/api/projects/${prjA}/full-history`, 'adminB')).status).toBe(404);
  });
});

// ── T8 ──────────────────────────────────────────────────────────────────────
describe('T8 delivery tracker', () => {
  it('requires projects:view (403 for a plain employee)', async () => {
    expect((await call('get', '/api/delivery-tracker', 'empA')).status).toBe(403);
    expect((await call('get', '/api/delivery-tracker/board', 'empA')).status).toBe(403);
  });

  it('a project manager sees only their company\'s projects', async () => {
    const prjA = await makeProject(co.A);
    const prjB = await makeProject(co.B);
    const res = await call('get', '/api/delivery-tracker?page_size=200', 'pmA');
    expect(res.status).toBe(200);
    const ids = (res.body.rows || res.body.data || []).map(r => r.project_id);
    expect(ids).toContain(prjA);
    expect(ids).not.toContain(prjB);
    const board = await call('get', '/api/delivery-tracker/board', 'pmA');
    expect(board.status).toBe(200);
  });
});

// ── T9 ──────────────────────────────────────────────────────────────────────
describe('T9 project-code preview and server-side numbering', () => {
  const seqState = async () => (await pool.query(`SELECT last_value, is_called FROM seq_prj`)).rows[0];

  it('requires projects:add (403 for a plain employee)', async () => {
    expect((await call('get', '/api/projects/projects/next-code', 'empA')).status).toBe(403);
  });

  it('previews the next code without consuming a number', async () => {
    // Other suites may create projects concurrently; one quiet attempt is proof.
    let quiet = false;
    for (let attempt = 0; attempt < 3 && !quiet; attempt++) {
      const before = await seqState();
      const res = await call('get', '/api/projects/projects/next-code', 'pmA');
      expect(res.status).toBe(200);
      expect(res.body.code).toMatch(/^PRJ-\d{4,}$/);
      const after = await seqState();
      quiet = String(before.last_value) === String(after.last_value) && before.is_called === after.is_called;
    }
    expect(quiet).toBe(true);
  });

  it('assigns the code on save: a previewed or already-taken PRJ code is replaced by the next free one', async () => {
    const preview = (await call('get', '/api/projects/projects/next-code', 'pmA')).body.code;
    const r1 = await call('post', '/api/projects/projects', 'pmA')
      .send({ project_name: `${TAG} numbered`, start_date: '2031-01-01', status: 'planning', budget: 0, project_code: preview });
    expect(r1.status).toBe(201);
    expect(r1.body.project_code).toMatch(/^PRJ-\d{4,}$/);
    const { rows: [taken] } = await pool.query(`SELECT project_code FROM projects WHERE project_code ~ '^PRJ-[0-9]{4,}$' ORDER BY id LIMIT 1`);
    const r2 = await call('post', '/api/projects/projects', 'pmA')
      .send({ project_name: `${TAG} numbered 2`, start_date: '2031-01-01', status: 'planning', budget: 0, project_code: taken.project_code });
    expect(r2.status).toBe(201);
    expect(r2.body.project_code).not.toBe(taken.project_code);
    expect(r2.body.project_code).not.toBe(r1.body.project_code);
  });

  it('keeps a custom (non-PRJ) code, and answers 409 for a duplicate one', async () => {
    const code = `${TAG}-MANUAL`;
    const body = { project_name: `${TAG} custom`, start_date: '2031-01-01', status: 'planning', budget: 0, project_code: code };
    const r1 = await call('post', '/api/projects/projects', 'pmA').send(body);
    expect(r1.status).toBe(201);
    expect(r1.body.project_code).toBe(code);
    const r2 = await call('post', '/api/projects/projects', 'pmA').send(body);
    expect(r2.status).toBe(409);
  });
});

// ── T10 ─────────────────────────────────────────────────────────────────────
describe('T10 Customer 360 projects', () => {
  it('lists only the party\'s own company\'s projects, even when another company uses the same customer name', async () => {
    const name = `${TAG} Shared Name Ltd`;
    const custA = await makeCustomer(co.A, name);
    const prjA = await makeProject(co.A, { customer_name: name });
    const prjB = await makeProject(co.B, { customer_name: name });
    const res = await call('get', `/api/crm/customer360/${custA.partyId}/projects`, 'adminA');
    expect(res.status).toBe(200);
    const ids = res.body.projects.map(p => p.id);
    expect(ids).toContain(prjA);
    expect(ids).not.toContain(prjB);
  });

  it('company B cannot open company A\'s customer (404)', async () => {
    const custA = await makeCustomer(co.A);
    expect((await call('get', `/api/crm/customer360/${custA.partyId}/projects`, 'adminB')).status).toBe(404);
  });
});
