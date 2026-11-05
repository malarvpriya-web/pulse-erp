/**
 * integration.projectStageAuthority.test.js — the lifecycle is the authority
 * for a project's stage (P1_PROJECT_LIFECYCLE_PLAN.md Phase 5, Part B), against
 * the REAL database and the real routers.
 *
 *  - projects.production_stage cannot be set through the project APIs (POST,
 *    PUT, PATCH /stage); a stale form value never overwrites anything.
 *  - every project read (GET one, GET list, Delivery Tracker grid + board)
 *    shows the stage DERIVED from the project's lifecycle with the shared
 *    mapping, plus stage_source; with no lifecycle in the project's own
 *    company the stage is unavailable (NULL), never guessed.
 *  - projects.status stays the separate administrative state.
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

const { default: pool }                  = await import('../config/db.js');
const { verifyToken }                    = await import('../middlewares/auth.middleware.js');
const { buildApp }                       = await import('./helpers/testApp.js');
const { default: projectRoutes }         = await import('../modules/projects/routes/projects.routes.js');
const { default: lifecycleRoutes }       = await import('../modules/operations/lifecycle.routes.js');
const { default: deliveryTrackerRoutes } = await import('../modules/projects/routes/deliveryTracker.routes.js');
const { derivedProductionStage, LIFECYCLE_STAGES } = await import('../shared/projectStages.js');

const app = buildApp(
  ['/api/projects',         verifyToken, projectRoutes],
  ['/api/lifecycle',        verifyToken, lifecycleRoutes],
  ['/api/delivery-tracker', verifyToken, deliveryTrackerRoutes],
);

const PREFIX = 'ZZPSA';
const TAG = `${PREFIX}${Date.now().toString(36).toUpperCase()}`;
const co = {}, u = {};
let seq = 0;
const nextCode = () => `${TAG}${++seq}`;

const tokenFor = (k) => jwt.sign({ userId: u[k].id, company_id: u[k].company, employee_id: null, name: `${TAG} ${k}` },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const call = (method, path, who) => request(app)[method](path).set('Authorization', `Bearer ${tokenFor(who)}`);
const stored = async (id) => (await pool.query(`SELECT production_stage, status FROM projects WHERE id=$1`, [id])).rows[0];

async function sweep() {
  const companies = `(SELECT id FROM companies WHERE code LIKE '${PREFIX}%')`;
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE '${PREFIX}%'`);
  const ids = rows.map(r => Number(r.id));
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]);
  const users = `(SELECT id FROM users WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM workflow_instance_steps WHERE instance_id IN (SELECT id FROM workflow_instances WHERE entity_type = 'project' AND entity_id IN (SELECT id FROM projects WHERE company_id IN ${companies}))`).catch(() => {});
  await pool.query(`DELETE FROM workflow_instances WHERE entity_type = 'project' AND entity_id IN (SELECT id FROM projects WHERE company_id IN ${companies})`).catch(() => {});
  await pool.query(`DELETE FROM workflow_instances WHERE initiated_by IN (SELECT id FROM users WHERE company_id IN ${companies})`).catch(() => {});
  await q(`DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id IN (SELECT id FROM lifecycle_instances WHERE company_id = ANY($1) OR project_id IN (SELECT id FROM projects WHERE company_id = ANY($1)))`);
  await q(`DELETE FROM lifecycle_instances WHERE company_id = ANY($1) OR project_id IN (SELECT id FROM projects WHERE company_id = ANY($1))`);
  await q(`DELETE FROM projects WHERE company_id = ANY($1)`);
  await q(`DELETE FROM notifications WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM audit_logs WHERE user_id IN ${users}`).catch(() => {});
  await q(`DELETE FROM access_denials WHERE user_id IN ${users}`).catch(() => {});
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
const one = async (sql, params) => (await pool.query(sql, params)).rows[0].id;
/** A project with a stored (legacy) stage, optionally a lifecycle. */
async function makeProject(company, { storedStage = null, lifecycle = null, status = 'active' } = {}) {
  const project = await one(
    `INSERT INTO projects (project_code, project_name, company_id, status, start_date, production_stage)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5) RETURNING id`, [nextCode(), `${TAG} project`, company, status, storedStage]);
  let lc = null;
  if (lifecycle) {
    lc = await one(
      `INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, current_stage, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [nextCode(), lifecycle.company ?? company, project, lifecycle.stage, lifecycle.status ?? 'active']);
  }
  return { project, lc };
}

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(`${TAG}A`);
  co.B = await makeCompany(`${TAG}B`);
  await makeUser('pmA',  co.A, 'project_manager');   // projects view/add/edit
  await makeUser('engA', co.A, 'service_engineer');  // lifecycle moves
  await makeUser('pmB',  co.B, 'project_manager');
  await makeUser('empA', co.A, 'employee');
});
afterAll(async () => { await sweep(); });

// ── one mapping ─────────────────────────────────────────────────────────────
describe('the shared mapping', () => {
  it('maps every stage, and nothing else, to a Project Master stage', () => {
    for (const s of LIFECYCLE_STAGES) expect(derivedProductionStage(s.key)).toBe(s.productionStage);
    expect(derivedProductionStage('service')).toBeNull();
    expect(derivedProductionStage(undefined)).toBeNull();
  });
});

// ── not independently editable ──────────────────────────────────────────────
describe('production_stage cannot be set through the project APIs', () => {
  it('PUT ignores production_stage (a stale form value) and saves the rest; the response shows the derived stage', async () => {
    const { project } = await makeProject(co.A, { storedStage: 'procurement', lifecycle: { stage: 'design' } });
    const res = await call('put', `/api/projects/projects/${project}`, 'pmA')
      .send({ production_stage: 'dispatched', description: 'edited' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ description: 'edited', production_stage: 'dr_approval', stage_source: 'lifecycle',
      stored_production_stage: 'procurement', lifecycle_stage: 'design' });
    expect((await stored(project)).production_stage).toBe('procurement');
  });

  it('PATCH /stage no longer moves anything (409) and points at the lifecycle', async () => {
    const { project, lc } = await makeProject(co.A, { storedStage: 'production', lifecycle: { stage: 'order' } });
    const res = await call('patch', `/api/projects/projects/${project}/stage`, 'pmA').send({ production_stage: 'dispatched' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'STAGE_FOLLOWS_LIFECYCLE', lifecycle_id: lc, lifecycle_stage: 'order', production_stage: 'handover' });
    expect(await stored(project)).toEqual({ production_stage: 'production', status: 'active' });
    const { rows: [p] } = await pool.query(`SELECT actual_delivery_date FROM projects WHERE id=$1`, [project]);
    expect(p.actual_delivery_date).toBeNull();
  });

  it('PATCH /stage keeps its permission and company checks (403 / 404)', async () => {
    const { project } = await makeProject(co.A, { lifecycle: { stage: 'order' } });
    expect((await call('patch', `/api/projects/projects/${project}/stage`, 'empA').send({ production_stage: 'production' })).status).toBe(403);
    expect((await call('patch', `/api/projects/projects/${project}/stage`, 'pmB').send({ production_stage: 'production' })).status).toBe(404);
  });

  it('POST stores no stage whatever the form sends; the new project shows its new lifecycle\'s stage', async () => {
    const res = await call('post', '/api/projects/projects', 'pmA')
      .send({ project_name: `${TAG} new`, status: 'planning', budget: 0, production_stage: 'dispatched' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ production_stage: 'handover', stage_source: 'lifecycle', lifecycle_stage: 'order', stored_production_stage: null });
    expect((await stored(res.body.id)).production_stage).toBeNull();
  });
});

// ── derived display ─────────────────────────────────────────────────────────
describe('the displayed stage derives from the lifecycle', () => {
  it('follows the lifecycle as it moves, without touching the stored column or projects.status', async () => {
    const { project, lc } = await makeProject(co.A, { storedStage: 'dispatched', lifecycle: { stage: 'order' }, status: 'planning' });
    expect((await call('get', `/api/projects/projects/${project}`, 'pmA')).body.production_stage).toBe('handover');
    expect((await call('post', `/api/lifecycle/instances/${lc}/advance`, 'engA').send({})).status).toBe(200);
    const after = (await call('get', `/api/projects/projects/${project}`, 'pmA')).body;
    expect(after).toMatchObject({ production_stage: 'dr_approval', lifecycle_stage: 'design', stored_production_stage: 'dispatched', status: 'planning' });
    expect((await call('post', `/api/lifecycle/instances/${lc}/hold`, 'engA').send({})).status).toBe(200);
    expect(await stored(project)).toEqual({ production_stage: 'dispatched', status: 'planning' });
    const held = (await call('get', `/api/projects/projects/${project}`, 'pmA')).body;
    expect(held).toMatchObject({ production_stage: 'dr_approval', lifecycle_status: 'on_hold', stage_source: 'lifecycle' });
  });

  it('a project with no lifecycle has an unavailable stage (NULL), not a guessed one; its stored value stays visible', async () => {
    const { project } = await makeProject(co.A, { storedStage: 'dispatched' });
    const res = await call('get', `/api/projects/projects/${project}`, 'pmA');
    expect(res.body).toMatchObject({ production_stage: null, stage_source: 'unavailable', lifecycle_id: null, stored_production_stage: 'dispatched' });
  });

  it('a lifecycle of ANOTHER company pointing at the project is ignored (unavailable)', async () => {
    const { project } = await makeProject(co.A, { lifecycle: { stage: 'production', company: co.B } });
    const res = await call('get', `/api/projects/projects/${project}`, 'pmA');
    expect(res.body).toMatchObject({ production_stage: null, stage_source: 'unavailable', lifecycle_id: null });
  });

  it('with only closed lifecycles, the latest one is shown and marked closed', async () => {
    const { project } = await makeProject(co.A, { lifecycle: { stage: 'design', status: 'cancelled' } });
    await one(`INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, current_stage, status)
               VALUES ($1,$2,$3,'closure','completed') RETURNING id`, [nextCode(), co.A, project]);
    const res = await call('get', `/api/projects/projects/${project}`, 'pmA');
    expect(res.body).toMatchObject({ production_stage: 'dispatched', lifecycle_stage: 'closure', stage_source: 'lifecycle_closed' });
  });

  it('the project list derives the same way', async () => {
    const { project } = await makeProject(co.A, { storedStage: 'clearing', lifecycle: { stage: 'testing' } });
    const res = await call('get', '/api/projects/projects', 'pmA');
    expect(res.status).toBe(200);
    expect(res.body.find(p => p.id === project)).toMatchObject({ production_stage: 'production', stored_production_stage: 'clearing' });
  });
});

// ── Delivery Tracker ────────────────────────────────────────────────────────
describe('Delivery Tracker grid and board', () => {
  let withLc, without;
  beforeAll(async () => {
    withLc = await makeProject(co.A, { storedStage: 'production', lifecycle: { stage: 'dispatch' } });
    without = await makeProject(co.A, { storedStage: 'dispatched' });
  });

  it('grid shows, filters and derives "Delivered" from the lifecycle stage', async () => {
    const res = await call('get', '/api/delivery-tracker?page_size=200', 'pmA');
    const row = res.body.data.find(r => r.project_id === withLc.project);
    expect(row).toMatchObject({ production_stage: 'dispatched', status: 'Delivered', stored_production_stage: 'production' });
    const none = res.body.data.find(r => r.project_id === without.project);
    expect(none).toMatchObject({ production_stage: null, stage_source: 'unavailable', status: 'In Progress' });
    // Filtering by the stored value finds nothing; by the derived value finds the project.
    const byStored = await call('get', '/api/delivery-tracker?page_size=200&status=production', 'pmA');
    expect(byStored.body.data.map(r => r.project_id)).not.toContain(withLc.project);
    const byDerived = await call('get', '/api/delivery-tracker?page_size=200&status=dispatched', 'pmA');
    expect(byDerived.body.data.map(r => r.project_id)).toContain(withLc.project);
    expect(byDerived.body.data.map(r => r.project_id)).not.toContain(without.project);
  });

  it('the "unavailable" filter finds the projects with no lifecycle, alone or with stages', async () => {
    const only = await call('get', '/api/delivery-tracker?page_size=200&status=unavailable', 'pmA');
    expect(only.status).toBe(200);
    const ids = only.body.data.map(r => r.project_id);
    expect(ids).toContain(without.project);
    expect(ids).not.toContain(withLc.project);
    expect(only.body.data.every(r => r.stage_source === 'unavailable')).toBe(true);
    const both = await call('get', '/api/delivery-tracker?page_size=200&status=dispatched,unavailable', 'pmA');
    expect(both.body.data.map(r => r.project_id)).toEqual(expect.arrayContaining([withLc.project, without.project]));
  });

  it('board buckets by the derived stage; a project with no lifecycle is listed as unavailable, not in a stage column', async () => {
    const res = await call('get', '/api/delivery-tracker/board', 'pmA');
    expect(res.status).toBe(200);
    expect(res.body.columns.dispatched.map(r => r.project_id)).toContain(withLc.project);
    const inColumns = Object.values(res.body.columns).flat().map(r => r.project_id);
    expect(inColumns).not.toContain(without.project);
    expect(res.body.unavailable.map(r => r.project_id)).toContain(without.project);
    expect(res.body.unavailable_count).toBe(res.body.unavailable.length);
  });

  it('another company sees none of these projects', async () => {
    const res = await call('get', '/api/delivery-tracker?page_size=200', 'pmB');
    const ids = res.body.data.map(r => r.project_id);
    expect(ids).not.toContain(withLc.project);
    expect(ids).not.toContain(without.project);
    expect((await call('get', `/api/projects/projects/${withLc.project}`, 'pmB')).status).toBe(404);
  });
});

// ── administrative status ───────────────────────────────────────────────────
describe('projects.status stays the separate administrative state', () => {
  it('changing the project status does not move the lifecycle', async () => {
    const { project, lc } = await makeProject(co.A, { lifecycle: { stage: 'procurement' } });
    const res = await call('put', `/api/projects/projects/${project}`, 'pmA').send({ status: 'on_hold' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'on_hold', production_stage: 'procurement', lifecycle_status: 'active' });
    const { rows: [l] } = await pool.query(`SELECT current_stage, status FROM lifecycle_instances WHERE id=$1`, [lc]);
    expect(l).toEqual({ current_stage: 'procurement', status: 'active' });
  });
});
