/**
 * integration.projectDbProtection.test.js — database protection for projects
 * and lifecycles (P1_PROJECT_LIFECYCLE_PLAN.md Phase 3, migration
 * 20261014000002_project_lifecycle_uniqueness.js), against the REAL database.
 *
 * Every write here goes STRAIGHT to SQL, bypassing ensureProject() and its row
 * locks, because the point is what the database itself refuses:
 *   ux_projects_opportunity_live       one live project per opportunity
 *   ux_lifecycle_open_per_project      one open lifecycle per project
 *   ux_lifecycle_open_per_sales_order  one open lifecycle per sales order
 *   fk_sales_orders_project            sales_orders.project_id -> projects, ON DELETE SET NULL
 * plus the service writing sales_orders.project_id, and the approved
 * multi-order shape (one project, several orders, one lifecycle).
 *
 * No DDL runs here; the migration is applied by the runner, not the test.
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

const { default: pool }        = await import('../config/db.js');
const { buildApp }             = await import('./helpers/testApp.js');
const { default: salesRoutes } = await import('../modules/sales/routes/sales.routes.js');

const app = buildApp(['/api/sales', salesRoutes]);

const PREFIX = 'ZZPDB';
const TAG = `${PREFIX}${Date.now().toString(36).toUpperCase()}`;
const co = {}, u = {};
let seq = 0;
const nextCode = () => `${TAG}${++seq}`;
const MISSING_PROJECT = 2147480001;   // no such project: a historical orphan's shape

const tokenFor = (k) => jwt.sign({ userId: u[k].id, company_id: u[k].company, employee_id: null, name: `${TAG} ${k}` },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const confirm = (soId) => request(app).patch(`/api/sales/orders/${soId}/confirm`).set('Authorization', `Bearer ${tokenFor('adminA')}`);

async function sweep() {
  const companies = `(SELECT id FROM companies WHERE code LIKE '${PREFIX}%')`;
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE '${PREFIX}%'`);
  const ids = rows.map(r => Number(r.id));
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]);
  const sos  = `(SELECT id FROM sales_orders WHERE company_id = ANY($1))`;
  const prjs = `(SELECT id FROM projects WHERE company_id = ANY($1))`;
  const lcs  = `(SELECT id FROM lifecycle_instances WHERE company_id = ANY($1) OR sales_order_id IN ${sos} OR project_id IN ${prjs})`;
  const pos  = `(SELECT id FROM production_orders WHERE company_id = ANY($1) OR sales_order_id IN ${sos} OR project_id IN ${prjs})`;
  const users = `(SELECT id FROM users WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM workflow_instances WHERE entity_type = 'project' AND entity_id IN (SELECT id FROM projects WHERE company_id IN ${companies})`).catch(() => {});
  await q(`DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id IN ${lcs}`);
  await q(`DELETE FROM lifecycle_instances WHERE id IN ${lcs}`);
  await q(`DELETE FROM production_operations WHERE production_order_id IN ${pos}`).catch(() => {});
  await q(`DELETE FROM production_orders WHERE id IN ${pos}`);
  await q(`DELETE FROM sales_order_items WHERE order_id IN ${sos}`);
  await q(`DELETE FROM sales_orders WHERE id IN ${sos}`);
  await q(`DELETE FROM projects WHERE company_id = ANY($1)`);
  await q(`DELETE FROM quotations WHERE company_id = ANY($1)`);
  await q(`DELETE FROM opportunity_stage_history WHERE opportunity_id IN (SELECT id FROM opportunities WHERE company_id = ANY($1))`).catch(() => {});
  await q(`DELETE FROM opportunities WHERE company_id = ANY($1)`);
  await q(`DELETE FROM notifications WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM audit_logs WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM user_roles WHERE user_id IN ${users}`);
  await q(`DELETE FROM users WHERE company_id = ANY($1)`);
  await q(`DELETE FROM interview_questions WHERE company_id = ANY($1)`).catch(() => {});
  await q(`DELETE FROM companies WHERE id = ANY($1)`);
}

const makeCompany = async (code) =>
  (await pool.query(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${code} Co`, code])).rows[0].id;
async function makeUser(key, company, roleCode) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ($1,$2,'not-a-real-hash',$3,true,$4) RETURNING id`,
    [`${TAG} ${key}`, `${TAG.toLowerCase()}.${key}@test.invalid`, company, roleCode]);
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [rows[0].id, role[0].id]);
  u[key] = { id: rows[0].id, company };
}
const makeOpportunity = async (company) => (await pool.query(
  `INSERT INTO opportunities (opportunity_name, company_id, stage) VALUES ($1,$2,'won') RETURNING id`,
  [nextCode(), company])).rows[0].id;
const insertProjectSql = `INSERT INTO projects (project_code, project_name, company_id, status, start_date, opportunity_id)
                          VALUES ($1,$2,$3,'active',CURRENT_DATE,$4) RETURNING id`;
const makeProject = async (company, opportunityId = null, db = pool) => (await db.query(
  insertProjectSql, [nextCode(), `${TAG} project`, company, opportunityId])).rows[0].id;
const makeLifecycle = async (company, { projectId = null, soId = null, status = 'active' } = {}) => (await pool.query(
  `INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, sales_order_id, current_stage, status)
   VALUES ($1,$2,$3,$4,'order',$5) RETURNING id`, [nextCode(), company, projectId, soId, status])).rows[0].id;
async function makeOrder(company, { status = 'draft', quotationId = null } = {}) {
  const { rows: [so] } = await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, quotation_id, order_date, order_status)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5) RETURNING *`, [nextCode(), company, `${TAG} Walk-in`, quotationId, status]);
  await pool.query(`INSERT INTO sales_order_items (order_id, description, quantity, unit_price) VALUES ($1,$2,1,100)`,
    [so.id, `${TAG} Panel`]);
  return so;
}
const makeQuotation = async (company, opportunityId) => (await pool.query(
  `INSERT INTO quotations (quotation_number, company_id, opportunity_id, status, total_amount)
   VALUES ($1,$2,$3,'accepted',0) RETURNING id`, [nextCode(), company, opportunityId])).rows[0].id;

/** The pg error a statement raised, or null if it succeeded. */
const errorOf = (promise) => promise.then(() => null, (e) => e);

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(`${TAG}A`);
  co.B = await makeCompany(`${TAG}B`);
  await makeUser('adminA', co.A, 'admin');
});
afterAll(async () => { await sweep(); });

describe('the migration objects exist', () => {
  it('has the three unique indexes, the order->project FK and its index', async () => {
    const { rows: idx } = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN
        ('ux_projects_opportunity_live','ux_lifecycle_open_per_project','ux_lifecycle_open_per_sales_order','idx_sales_orders_project_id')`);
    expect(idx.map(r => r.indexname).sort()).toEqual(
      ['idx_sales_orders_project_id', 'ux_lifecycle_open_per_project', 'ux_lifecycle_open_per_sales_order', 'ux_projects_opportunity_live']);
    const { rows: fk } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fk_sales_orders_project'`);
    expect(fk[0]?.def).toMatch(/REFERENCES projects\(id\) ON DELETE SET NULL/);
  });
});

// ── one live project per opportunity ────────────────────────────────────────
describe('ux_projects_opportunity_live', () => {
  it('refuses a second live project for the same opportunity', async () => {
    const opp = await makeOpportunity(co.A);
    await makeProject(co.A, opp);
    const err = await errorOf(makeProject(co.A, opp));
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('ux_projects_opportunity_live');
  });

  it('allows a new project once the old one is soft-deleted, and still refuses a third live one', async () => {
    const opp = await makeOpportunity(co.A);
    const first = await makeProject(co.A, opp);
    await pool.query(`UPDATE projects SET deleted_at = NOW() WHERE id = $1`, [first]);
    await makeProject(co.A, opp);
    expect((await errorOf(makeProject(co.A, opp)))?.code).toBe('23505');
    // Restoring the deleted one would make two live projects: refused too.
    expect((await errorOf(pool.query(`UPDATE projects SET deleted_at = NULL WHERE id = $1`, [first])))?.code).toBe('23505');
  });

  it('does not constrain projects without an opportunity; a cancelled project still counts as live', async () => {
    await makeProject(co.A, null);
    await makeProject(co.A, null);
    const opp = await makeOpportunity(co.A);
    const p = await makeProject(co.A, opp);
    await pool.query(`UPDATE projects SET status = 'cancelled' WHERE id = $1`, [p]);
    // A cancelled project is still a live row (deleted_at IS NULL) — the code's own rule.
    expect((await errorOf(makeProject(co.A, opp)))?.code).toBe('23505');
  });

  it('two transactions creating a project for one opportunity at once: exactly one commits', async () => {
    const opp = await makeOpportunity(co.A);
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await makeProject(co.A, opp, c1);
      const second = errorOf(makeProject(co.A, opp, c2));   // blocks on c1's uncommitted row
      await c1.query('COMMIT');
      const err = await second;
      await c2.query('ROLLBACK');
      expect(err?.code).toBe('23505');
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      c1.release();
      c2.release();
    }
    const { rows } = await pool.query(`SELECT id FROM projects WHERE opportunity_id = $1`, [opp]);
    expect(rows).toHaveLength(1);
  });
});

// ── one open lifecycle per project ──────────────────────────────────────────
describe('ux_lifecycle_open_per_project', () => {
  it('refuses a second open lifecycle (active or on_hold) for a project', async () => {
    const p = await makeProject(co.A);
    await makeLifecycle(co.A, { projectId: p, status: 'on_hold' });
    for (const status of ['active', 'on_hold']) {
      const err = await errorOf(makeLifecycle(co.A, { projectId: p, status }));
      expect(err?.constraint, status).toBe('ux_lifecycle_open_per_project');
    }
  });

  it('keeps closed history: completed and cancelled lifecycles do not count', async () => {
    const p = await makeProject(co.A);
    await makeLifecycle(co.A, { projectId: p, status: 'completed' });
    await makeLifecycle(co.A, { projectId: p, status: 'cancelled' });
    const open = await makeLifecycle(co.A, { projectId: p, status: 'active' });
    // Re-opening a closed one while another is open is refused.
    const { rows: [closed] } = await pool.query(
      `SELECT id FROM lifecycle_instances WHERE project_id = $1 AND status = 'completed'`, [p]);
    expect((await errorOf(pool.query(`UPDATE lifecycle_instances SET status = 'active' WHERE id = $1`, [closed.id])))?.code).toBe('23505');
    // Closing the open one makes room for a new one.
    await pool.query(`UPDATE lifecycle_instances SET status = 'completed' WHERE id = $1`, [open]);
    await makeLifecycle(co.A, { projectId: p, status: 'active' });
  });

  it('leaves historical orphans alone: a lifecycle for a missing project can still be written and changed', async () => {
    const orphan = await makeLifecycle(co.A, { projectId: MISSING_PROJECT, status: 'active' });
    await pool.query(`UPDATE lifecycle_instances SET status = 'on_hold' WHERE id = $1`, [orphan]);
    const { rows: [row] } = await pool.query(`SELECT status, project_id FROM lifecycle_instances WHERE id = $1`, [orphan]);
    expect(row).toEqual({ status: 'on_hold', project_id: MISSING_PROJECT });
    // A lifecycle with no project at all is not forbidden either.
    await makeLifecycle(co.A, { projectId: null, status: 'active' });
    await makeLifecycle(co.A, { projectId: null, status: 'active' });
  });
});

// ── one open lifecycle per sales order ──────────────────────────────────────
describe('ux_lifecycle_open_per_sales_order', () => {
  it('refuses a second open lifecycle for an order, even on another project', async () => {
    const so = await makeOrder(co.A);
    await makeLifecycle(co.A, { projectId: await makeProject(co.A), soId: so.id });
    const err = await errorOf(makeLifecycle(co.A, { projectId: await makeProject(co.A), soId: so.id }));
    expect(err?.constraint).toBe('ux_lifecycle_open_per_sales_order');
  });

  it('allows a new one once the earlier lifecycle is closed', async () => {
    const so = await makeOrder(co.A);
    const first = await makeLifecycle(co.A, { projectId: await makeProject(co.A), soId: so.id });
    await pool.query(`UPDATE lifecycle_instances SET status = 'cancelled' WHERE id = $1`, [first]);
    await makeLifecycle(co.A, { projectId: await makeProject(co.A), soId: so.id });
  });
});

// ── sales_orders.project_id ─────────────────────────────────────────────────
describe('sales_orders.project_id', () => {
  it('must name an existing project (FK), and is cleared — not cascaded — when the project row is removed', async () => {
    const so = await makeOrder(co.A);
    expect((await errorOf(pool.query(`UPDATE sales_orders SET project_id = $2 WHERE id = $1`, [so.id, MISSING_PROJECT])))?.code).toBe('23503');
    const p = await makeProject(co.A);
    await pool.query(`UPDATE sales_orders SET project_id = $2 WHERE id = $1`, [so.id, p]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [p]);
    const { rows: [row] } = await pool.query(`SELECT id, project_id FROM sales_orders WHERE id = $1`, [so.id]);
    expect(row).toEqual({ id: so.id, project_id: null });
  });

  it('is written by order set-up; several orders of one opportunity share one project and one open lifecycle', async () => {
    const opp = await makeOpportunity(co.A);
    const q = await makeQuotation(co.A, opp);
    const so1 = await makeOrder(co.A, { quotationId: q });
    const so2 = await makeOrder(co.A, { quotationId: q });
    expect((await confirm(so1.id)).status).toBe(200);
    expect((await confirm(so2.id)).status).toBe(200);
    const { rows: projects } = await pool.query(`SELECT id FROM projects WHERE opportunity_id = $1`, [opp]);
    expect(projects).toHaveLength(1);
    const { rows: orders } = await pool.query(`SELECT id, project_id FROM sales_orders WHERE id = ANY($1) ORDER BY id`, [[so1.id, so2.id]]);
    expect(orders.map(o => o.project_id)).toEqual([projects[0].id, projects[0].id]);
    const { rows: open } = await pool.query(
      `SELECT sales_order_id FROM lifecycle_instances WHERE project_id = $1 AND status IN ('active','on_hold')`, [projects[0].id]);
    expect(open).toEqual([{ sales_order_id: so1.id }]);
  });

  it('an order already linked to a project is set up on that project', async () => {
    const linked = await makeProject(co.A);
    const so = await makeOrder(co.A);
    await pool.query(`UPDATE sales_orders SET project_id = $2 WHERE id = $1`, [so.id, linked]);
    expect((await confirm(so.id)).status).toBe(200);
    const { rows: [lc] } = await pool.query(`SELECT project_id FROM lifecycle_instances WHERE sales_order_id = $1`, [so.id]);
    expect(lc.project_id).toBe(linked);
  });
});
