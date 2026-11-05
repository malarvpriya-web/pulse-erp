/**
 * integration.lifecycleStabilisation.test.js — the lifecycle workstream's
 * stabilisation fixes, against the REAL database and the real routers.
 *
 *  - GET /lifecycle/instances/:id returns the linked order's number, only for
 *    an order of the lifecycle's own company (the list join is scoped too).
 *  - GET /operations/project-tracker and GET /projects/projects/:id/status-report
 *    show the stage DERIVED from the lifecycle with the shared mapping; no
 *    lifecycle in the project's company = unavailable, never a guess.
 *  - integration.orderToProjectChain / planToProduce no longer write company 1
 *    (they raced supplyChain's company-1 MRP in parallel runs).
 *
 * Self-cleaning: sweep() removes both synthetic companies and everything under them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
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

const { default: pool }             = await import('../config/db.js');
const { verifyToken }               = await import('../middlewares/auth.middleware.js');
const { buildApp }                  = await import('./helpers/testApp.js');
const { default: lifecycleRoutes }  = await import('../modules/operations/lifecycle.routes.js');
const { default: operationsRoutes } = await import('../modules/operations/operations.routes.js');
const { default: projectRoutes }    = await import('../modules/projects/routes/projects.routes.js');

const app = buildApp(
  ['/api/lifecycle',  verifyToken, lifecycleRoutes],
  ['/api/operations', verifyToken, operationsRoutes],
  ['/api/projects',   verifyToken, projectRoutes],
);

const PREFIX = 'ZZLST';
const TAG = `${PREFIX}${Date.now().toString(36).toUpperCase()}`;
const co = {}, u = {};
let seq = 0;
const nextCode = () => `${TAG}${++seq}`;
const tokenFor = (k) => jwt.sign({ userId: u[k].id, ...(u[k].company != null ? { company_id: u[k].company } : {}), employee_id: null, name: `${TAG} ${k}` },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const call = (method, path, who) => request(app)[method](path).set('Authorization', `Bearer ${tokenFor(who)}`);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0].id;

async function sweep() {
  // The company-less login (no company_id, so the company sweep cannot see it).
  const loose = `(SELECT id FROM users WHERE company_id IS NULL AND email LIKE '${PREFIX.toLowerCase()}%@test.invalid')`;
  await pool.query(`DELETE FROM access_denials WHERE user_id IN ${loose}`).catch(() => {});
  await pool.query(`DELETE FROM user_roles WHERE user_id IN ${loose}`);
  await pool.query(`DELETE FROM users WHERE id IN ${loose}`);
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE '${PREFIX}%'`);
  const ids = rows.map(r => Number(r.id));
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]);
  const users = `(SELECT id FROM users WHERE company_id = ANY($1))`;
  await q(`DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id IN (SELECT id FROM lifecycle_instances WHERE company_id = ANY($1))`);
  await q(`DELETE FROM lifecycle_instances WHERE company_id = ANY($1)`);
  await q(`DELETE FROM sales_orders WHERE company_id = ANY($1)`);
  await q(`DELETE FROM projects WHERE company_id = ANY($1)`);
  await q(`DELETE FROM audit_logs WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM access_denials WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM user_roles WHERE user_id IN ${users}`);
  await q(`DELETE FROM users WHERE company_id = ANY($1)`);
  await q(`DELETE FROM interview_questions WHERE company_id = ANY($1)`).catch(() => {});
  await q(`DELETE FROM companies WHERE id = ANY($1)`);
}
async function makeUser(key, company, roleCode) {
  const id = await one(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ($1,$2,'not-a-real-hash',$3,true,$4) RETURNING id`,
    [`${TAG} ${key}`, `${TAG.toLowerCase()}.${key}@test.invalid`, company, roleCode]);
  const role = await one(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
  u[key] = { id, company };
}
const makeProject = (company, storedStage = null) => one(
  `INSERT INTO projects (project_code, project_name, company_id, status, start_date, production_stage)
   VALUES ($1,$2,$3,'active',CURRENT_DATE,$4) RETURNING id`, [nextCode(), `${TAG} project`, company, storedStage]);
const makeOrder = (company, deleted = false) => one(
  `INSERT INTO sales_orders (order_number, company_id, order_status, deleted_at) VALUES ($1,$2,'confirmed',$3) RETURNING id`,
  [nextCode(), company, deleted ? new Date() : null]);
const makeLifecycle = (company, { project = null, so = null, stage = 'order', status = 'active' } = {}) => one(
  `INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, sales_order_id, current_stage, status)
   VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [nextCode(), company, project, so, stage, status]);
const orderNumber = async (id) => (await pool.query(`SELECT order_number FROM sales_orders WHERE id=$1`, [id])).rows[0].order_number;

beforeAll(async () => {
  await sweep();
  co.A = await one(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG}A Co`, `${TAG}A`]);
  co.B = await one(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG}B Co`, `${TAG}B`]);
  await makeUser('svcA', co.A, 'service_manager');
  await makeUser('pmA', co.A, 'project_manager');
  await makeUser('adminA', co.A, 'admin');
  await makeUser('empA', co.A, 'employee');                 // no projects:view
  await makeUser('pmB', co.B, 'project_manager');
  await makeUser('nocompany', null, 'project_manager');     // projects:view but no company, not global
});
afterAll(async () => { await sweep(); });

// ── lifecycle detail: order number ──────────────────────────────────────────
describe('lifecycle detail and list carry the linked order number, company-scoped', () => {
  it('detail shows its own company\'s order number', async () => {
    const so = await makeOrder(co.A);
    const lc = await makeLifecycle(co.A, { so });
    const res = await call('get', `/api/lifecycle/instances/${lc}`, 'svcA');
    expect(res.status).toBe(200);
    expect(res.body.order_number).toBe(await orderNumber(so));
    expect(res.body).toHaveProperty('gates');          // existing fields kept
    expect(res.body).toHaveProperty('history');
  });

  it('a mis-linked order of another company, or a deleted order, gives null — never the foreign number', async () => {
    const foreign = await makeOrder(co.B);
    const lc = await makeLifecycle(co.A, { so: foreign });
    const detail = await call('get', `/api/lifecycle/instances/${lc}`, 'svcA');
    expect(detail.body.order_number).toBeNull();
    expect(detail.body.sales_order_id).toBe(foreign);   // the stored link itself is untouched
    const list = await call('get', '/api/lifecycle/instances', 'svcA');
    expect(list.body.find(r => r.id === lc).order_number).toBeNull();

    const gone = await makeOrder(co.A, true);
    const lc2 = await makeLifecycle(co.A, { so: gone });
    expect((await call('get', `/api/lifecycle/instances/${lc2}`, 'svcA')).body.order_number).toBeNull();
  });
});

// ── Project Workflow Tracker ────────────────────────────────────────────────
describe('GET /operations/project-tracker derives the stage', () => {
  it('shows the lifecycle-derived stage; no lifecycle (or another company\'s) is unavailable, not the status', async () => {
    const staged = await makeProject(co.A, 'dispatched');
    await makeLifecycle(co.A, { project: staged, stage: 'testing', status: 'on_hold' });
    const none = await makeProject(co.A, 'production');
    const foreignOnly = await makeProject(co.A);
    await makeLifecycle(co.B, { project: foreignOnly, stage: 'design' });

    const res = await call('get', '/api/operations/project-tracker', 'adminA');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.map(r => [r.id, r]));
    expect(by[staged]).toMatchObject({ production_stage: 'production', lifecycle_stage: 'testing', lifecycle_status: 'on_hold',
      stage_source: 'lifecycle', stored_production_stage: 'dispatched', status: 'active' });
    expect(by[none]).toMatchObject({ production_stage: null, stage_source: 'unavailable', stored_production_stage: 'production' });
    expect(by[foreignOnly]).toMatchObject({ production_stage: null, stage_source: 'unavailable', lifecycle_id: null });
  });
});

describe('GET /operations/project-tracker access', () => {
  it('needs projects:view (403 for an employee) and a company (403 for a company-less login)', async () => {
    const res = await call('get', '/api/operations/project-tracker', 'empA');
    expect(res.status).toBe(403);
    const none = await call('get', '/api/operations/project-tracker', 'nocompany');
    expect(none.status).toBe(403);
    expect(none.body.error).toMatch(/No company/);
  });

  it("lists only the caller company's live projects: another company's and soft-deleted ones are left out", async () => {
    const live = await makeProject(co.A);
    const deleted = await makeProject(co.A);
    await pool.query(`UPDATE projects SET deleted_at = NOW() WHERE id = $1`, [deleted]);
    const other = await makeProject(co.B);

    const a = await call('get', '/api/operations/project-tracker', 'pmA');
    expect(a.status).toBe(200);
    const idsA = a.body.map(r => r.id);
    expect(idsA).toContain(live);
    expect(idsA).not.toContain(deleted);
    expect(idsA).not.toContain(other);
    expect(a.body.every(r => r.company_id === co.A)).toBe(true);

    const b = await call('get', '/api/operations/project-tracker', 'pmB');
    expect(b.status).toBe(200);
    expect(b.body.map(r => r.id)).toEqual([other]);
  });
});

// ── Project Reports status report ───────────────────────────────────────────
describe('GET /projects/projects/:id/status-report derives the stage', () => {
  it('counts an on-hold lifecycle (the old lookup only took "active") and maps it with the shared mapping', async () => {
    const p = await makeProject(co.A, 'clearing');
    const lc = await makeLifecycle(co.A, { project: p, stage: 'installation', status: 'on_hold' });
    const res = await call('get', `/api/projects/projects/${p}/status-report`, 'pmA');
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ current_stage: 'installation', lifecycle_id: lc, lifecycle_status: 'on_hold',
      production_stage: 'dispatched', stage_source: 'lifecycle' });
  });

  it('no lifecycle, or only another company\'s: unavailable with a null stage — not "N/A", not the stored value', async () => {
    const none = await makeProject(co.A, 'production');
    let res = await call('get', `/api/projects/projects/${none}/status-report`, 'pmA');
    expect(res.body.report).toMatchObject({ current_stage: null, production_stage: null, stage_source: 'unavailable' });
    const foreignOnly = await makeProject(co.A);
    await makeLifecycle(co.B, { project: foreignOnly, stage: 'sat' });
    res = await call('get', `/api/projects/projects/${foreignOnly}/status-report`, 'pmA');
    expect(res.body.report).toMatchObject({ current_stage: null, stage_source: 'unavailable' });
  });
});

// ── test isolation ──────────────────────────────────────────────────────────
describe('lifecycle integration suites stay out of company 1', () => {
  // supplyChain plans MRP over all of company 1; these suites used to create
  // orders, BOMs and production orders there and made it fail in parallel runs.
  const COMPANY_ONE = [
    /us\.company_id\s*=\s*1\b/, /company_id\s*=\s*1\b/,
    /VALUES\s*\(\s*1\s*,/, /VALUES\s*\([^)]*,\s*1\s*,\s*'(won|accepted|draft|planning|customer)'/,
    /convertOpportunityToProject\([^)]*,\s*1\s*,/,
  ];
  for (const file of ['integration.orderToProjectChain.test.js', 'integration.planToProduce.test.js']) {
    it(`${file} uses its own test company`, () => {
      const src = readFileSync(resolve(here, file), 'utf8');
      expect(src).toMatch(/createIsolatedCompany\(pool, PREFIX\)/);
      for (const re of COMPANY_ONE) expect(src, String(re)).not.toMatch(re);
    });
  }
});
