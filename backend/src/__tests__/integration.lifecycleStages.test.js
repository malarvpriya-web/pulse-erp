/**
 * integration.lifecycleStages.test.js — the lifecycle stage model, transitions
 * and gates (P1_PROJECT_LIFECYCLE_PLAN.md Phase 4; migration
 * 20261014000003_lifecycle_stage_model.js), against the REAL database and the
 * real lifecycle router.
 *
 * Walks one lifecycle from Order to Closure on real evidence for every gate,
 * and checks: jumps and reserved stages refused; evidence of another company
 * or another project never counted; several production orders all needed;
 * backward moves approver-only with a reason; resume only from on_hold;
 * reopen / cancel / complete authorised and recorded; projects.status left
 * alone; historical orphans still readable and movable; gates fail closed.
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
const { default: lifecycleRoutes } = await import('../modules/operations/lifecycle.routes.js');
const { checkGates }               = await import('../modules/operations/services/lifecycleGates.service.js');
const stages                       = await import('../shared/projectStages.js');
const { STAGE_LISTS }              = await import('../database/migrations/20261014000003_lifecycle_stage_model.js');

const app = buildApp(['/api/lifecycle', verifyToken, lifecycleRoutes]);

const PREFIX = 'ZZLCS';
const TAG = `${PREFIX}${Date.now().toString(36).toUpperCase()}`;
const co = {}, u = {};
let seq = 0;
const nextCode = () => `${TAG}${++seq}`;
const COMPONENT = 910000000 + (Date.now() % 80000000);

const tokenFor = (k) => jwt.sign({ userId: u[k].id, company_id: u[k].company, employee_id: null, name: `${TAG} ${k}` },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const call = (method, path, who) => request(app)[method](path).set('Authorization', `Bearer ${tokenFor(who)}`);
const advance = (lc, who = 'engA', body = {}) => call('post', `/api/lifecycle/instances/${lc}/advance`, who).send(body);
const act = (lc, action, who, body = {}) => call('post', `/api/lifecycle/instances/${lc}/${action}`, who).send(body);
const lifecycle = async (id) => (await pool.query(`SELECT * FROM lifecycle_instances WHERE id=$1`, [id])).rows[0];
const history = async (id) => (await pool.query(
  `SELECT * FROM lifecycle_stage_history WHERE lifecycle_instance_id=$1 ORDER BY id`, [id])).rows;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE '${PREFIX}%'`);
  const ids = rows.map(r => Number(r.id));
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]);
  const prjs = `(SELECT id FROM projects WHERE company_id = ANY($1))`;
  const users = `(SELECT id FROM users WHERE company_id = ANY($1))`;
  await q(`DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id IN (SELECT id FROM lifecycle_instances WHERE company_id = ANY($1))`);
  await q(`DELETE FROM lifecycle_instances WHERE company_id = ANY($1)`);
  await q(`DELETE FROM punch_points WHERE company_id = ANY($1)`);
  await q(`DELETE FROM test_runs WHERE company_id = ANY($1)`);
  await q(`DELETE FROM ncr_reports WHERE company_id = ANY($1)`);
  await q(`DELETE FROM sat_trackers WHERE company_id = ANY($1)`);
  await q(`DELETE FROM commissioning_workflows WHERE company_id = ANY($1)`);
  await q(`DELETE FROM installation_requests WHERE company_id = ANY($1)`);
  await q(`DELETE FROM shipments WHERE company_id = ANY($1)`);
  await q(`DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_receipt_notes WHERE company_id = ANY($1))`);
  await q(`DELETE FROM goods_receipt_notes WHERE company_id = ANY($1)`);
  await q(`DELETE FROM purchase_orders WHERE company_id = ANY($1)`);
  await q(`DELETE FROM production_orders WHERE company_id = ANY($1)`);
  await q(`DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM bom_headers WHERE company_id = ANY($1))`);
  await q(`DELETE FROM bom_headers WHERE company_id = ANY($1)`);
  await q(`DELETE FROM engineering_changes WHERE company_id = ANY($1)`);
  await q(`DELETE FROM tasks WHERE project_id IN ${prjs}`);
  await q(`DELETE FROM sales_orders WHERE company_id = ANY($1)`);
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

/** A project with its own confirmed order and a lifecycle at `stage`. */
async function makeSetup(company, { stage = 'order', status = 'active', projectStatus = 'active' } = {}) {
  const project = await one(
    `INSERT INTO projects (project_code, project_name, company_id, status, start_date) VALUES ($1,$2,$3,$4,CURRENT_DATE) RETURNING id`,
    [nextCode(), `${TAG} project`, company, projectStatus]);
  const so = await one(
    `INSERT INTO sales_orders (order_number, company_id, order_status, project_id) VALUES ($1,$2,'confirmed',$3) RETURNING id`,
    [nextCode(), company, project]);
  const lc = await one(
    `INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, sales_order_id, current_stage, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [nextCode(), company, project, so, stage, status]);
  return { project, so, lc };
}

const evidence = {
  bom: (company, project, status = 'active') => one(
    `INSERT INTO bom_headers (bom_number, product_name, status, company_id, project_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [nextCode(), `${TAG} BOM`, status, company, project]),
  productionOrder: (company, project, { status = 'completed', bom = null } = {}) => one(
    `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, status, company_id, project_id, bom_id)
     VALUES ($1,$2,1,$3,$4,$5,$6) RETURNING id`, [nextCode(), `${TAG} product`, status, company, project, bom]),
  grn: async (company, project, qty) => {
    const po = await one(`INSERT INTO purchase_orders (po_number, company_id, project_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
      [nextCode(), company, project]);
    const g = await one(`INSERT INTO goods_receipt_notes (grn_number, company_id, po_id, status) VALUES ($1,$2,$3,'received') RETURNING id`,
      [nextCode(), company, po]);
    await pool.query(`INSERT INTO grn_items (grn_id, item_id, quantity_received) VALUES ($1,$2,$3)`, [g, COMPONENT, qty]);
  },
  fat: (company, productionOrder, result = 'pass') => one(
    `INSERT INTO test_runs (run_number, production_order_id, test_stage, test_type, overall_result, company_id)
     VALUES ($1,$2,'FAT','routine',$3,$4) RETURNING id`, [nextCode(), productionOrder, result, company]),
  shipment: (company, so) => pool.query(
    `INSERT INTO shipments (reference_type, reference_id, status, company_id) VALUES ('sales_order',$1,'delivered',$2)`, [so, company]),
  installation: (company, project, { status = 'completed', accepted = true } = {}) => one(
    `INSERT INTO installation_requests (installation_number, company_id, project_id, status, customer_accepted)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [nextCode(), company, project, status, accepted]),
  commissioning: (company, project, { status = 'completed', certificate = true } = {}) => one(
    `INSERT INTO commissioning_workflows (workflow_number, company_id, project_id, status, certificate_issued)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [nextCode(), company, project, status, certificate]),
  sat: (company, project, { status = 'passed', signed = true } = {}) => one(
    `INSERT INTO sat_trackers (sat_number, company_id, project_id, status, client_signed_off) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [nextCode(), company, project, status, signed]),
};

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(`${TAG}A`);
  co.B = await makeCompany(`${TAG}B`);
  await makeUser('engA', co.A, 'service_engineer');   // servicedesk view/add/edit
  await makeUser('mgrA', co.A, 'service_manager');    // + approve
  await makeUser('hrA',  co.A, 'hr');                 // view only
  await makeUser('empA', co.A, 'employee');           // no servicedesk
  await makeUser('mgrB', co.B, 'service_manager');
});
afterAll(async () => { await sweep(); });

// ── The model ───────────────────────────────────────────────────────────────
describe('the stage model', () => {
  it('serves one ordered model: reserved Clearing and Pre-commissioning, no Service/AMC stage', async () => {
    const res = await call('get', '/api/lifecycle/stages', 'hrA');
    expect(res.status).toBe(200);
    expect(res.body.stages.map(s => s.key)).toEqual(['order', 'design', 'procurement', 'production', 'testing', 'clearing',
      'dispatch', 'installation', 'pre_commissioning', 'commissioning', 'sat', 'closure']);
    expect(res.body.stages.filter(s => s.reserved).map(s => s.key)).toEqual(['clearing', 'pre_commissioning']);
    expect(res.body.active_path).not.toContain('clearing');
    expect(res.body.active_path).not.toContain('service');
    expect(res.body.legacy_stages).toEqual(['service', 'amc']);
    expect((await call('get', '/api/lifecycle/stages', 'empA')).status).toBe(403);
  });

  it('every stage, status and history action the application uses is allowed by the database', async () => {
    expect(STAGE_LISTS.STAGES_V2).toEqual(expect.arrayContaining(stages.ALL_STAGE_KEYS));
    expect(STAGE_LISTS.ACTIONS_V2).toEqual(expect.arrayContaining(stages.HISTORY_ACTIONS));
    const { rows } = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('chk_lifecycle_instances_stage','chk_lifecycle_stage_history_action','chk_lifecycle_instances_status')`);
    const def = Object.fromEntries(rows.map(r => [r.conname, r.def]));
    for (const k of stages.ALL_STAGE_KEYS) expect(def.chk_lifecycle_instances_stage, k).toContain(`'${k}'`);
    for (const a of stages.HISTORY_ACTIONS) expect(def.chk_lifecycle_stage_history_action, a).toContain(`'${a}'`);
    for (const s of stages.LIFECYCLE_STATUSES) expect(def.chk_lifecycle_instances_status, s).toContain(`'${s}'`);
  });

  it('the Phase 3 open-lifecycle indexes match the open statuses', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname IN ('ux_lifecycle_open_per_project','ux_lifecycle_open_per_sales_order')`);
    expect(rows).toHaveLength(2);
    for (const r of rows) for (const s of stages.OPEN_STATUSES) expect(r.indexdef).toContain(`'${s}'`);
  });
});

// ── A full walk on real evidence ────────────────────────────────────────────
describe('Order to Closure on real evidence', () => {
  let s, po1, po2;
  beforeAll(async () => { s = await makeSetup(co.A); });

  it('order -> design needs no evidence; a jump or a reserved stage is refused (422)', async () => {
    expect((await advance(s.lc, 'engA', { to_stage: 'production' })).status).toBe(422);
    expect((await advance(s.lc, 'engA', { to_stage: 'clearing' })).status).toBe(422);
    const res = await advance(s.lc);
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('design');
  });

  it('design -> procurement needs an active BOM of THIS project with no open ECN', async () => {
    // Another company's approved ECN and active BOM count for nothing.
    await pool.query(`INSERT INTO engineering_changes (company_id, ecn_number, title, status) VALUES ($1,$2,'x','approved')`, [co.B, nextCode()]);
    await evidence.bom(co.B, null);
    // Neither does an approved ECN of the same company on its own.
    await pool.query(`INSERT INTO engineering_changes (company_id, ecn_number, title, status) VALUES ($1,$2,'x','approved')`, [co.A, nextCode()]);
    const blocked = await advance(s.lc);
    expect(blocked.status).toBe(422);
    expect(blocked.body.failing).toEqual(['engineering_ready']);
    // A BOM of the project with an ECN still submitted against it is not released.
    const ecn = await one(`INSERT INTO engineering_changes (company_id, ecn_number, title, status) VALUES ($1,$2,'x','submitted') RETURNING id`, [co.A, nextCode()]);
    const bom = await evidence.bom(co.A, s.project);
    await pool.query(`UPDATE bom_headers SET ecn_id=$2 WHERE id=$1`, [bom, ecn]);
    expect((await advance(s.lc)).status).toBe(422);
    await pool.query(`UPDATE engineering_changes SET status='implemented' WHERE id=$1`, [ecn]);
    await pool.query(`INSERT INTO bom_lines (bom_id, component_id, component_name, qty, company_id) VALUES ($1,$2,'part',4,$3)`, [bom, COMPONENT, co.A]);
    const res = await advance(s.lc);
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('procurement');
  });

  it('procurement -> production counts only GRNs on this project\'s purchase orders, net quantity', async () => {
    await evidence.grn(co.B, null, 10);       // another company
    const other = await makeSetup(co.A);       // another project of the same company
    await evidence.grn(co.A, other.project, 10);
    await evidence.grn(co.A, s.project, 3);    // 3 of 4
    const blocked = await advance(s.lc);
    expect(blocked.status).toBe(422);
    expect(blocked.body.gate_details.bom_materials_received.short).toEqual([{ component_id: COMPONENT, required: 4, received: 3 }]);
    await evidence.grn(co.A, s.project, 1);
    expect((await advance(s.lc)).status).toBe(200);
  });

  it('production -> testing needs EVERY production order of the project completed', async () => {
    po1 = await evidence.productionOrder(co.A, s.project, { status: 'completed' });
    po2 = await evidence.productionOrder(co.A, s.project, { status: 'in_progress' });
    await evidence.productionOrder(co.A, s.project, { status: 'cancelled' });   // ignored
    const blocked = await advance(s.lc);
    expect(blocked.status).toBe(422);
    expect(blocked.body.gate_details.production_ready.not_completed).toEqual([po2]);
    await pool.query(`UPDATE production_orders SET status='completed' WHERE id=$1`, [po2]);
    const res = await advance(s.lc);
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('testing');
  });

  it('testing -> dispatch (Clearing skipped) needs a passed FAT for every production order and no open NCR / punch point', async () => {
    await evidence.fat(co.A, po1);
    await evidence.fat(co.B, po2);            // another company's FAT for our order: not counted
    let res = await advance(s.lc);
    expect(res.status).toBe(422);
    expect(res.body.gate_details.fat_passed.without_passed_fat).toEqual([po2]);
    const fat2 = await evidence.fat(co.A, po2);
    const ncr = await one(`INSERT INTO ncr_reports (title, status, company_id, project_id) VALUES ($1,'open',$2,$3) RETURNING id`, ['x', co.A, s.project]);
    const punch = await one(`INSERT INTO punch_points (test_run_id, description, status, company_id) VALUES ($1,'x','open',$2) RETURNING id`, [fat2, co.A]);
    res = await advance(s.lc);
    expect(res.status).toBe(422);
    expect(res.body.failing).toEqual(['no_open_ncrs', 'no_open_punch_points']);
    await pool.query(`UPDATE ncr_reports SET status='closed' WHERE id=$1`, [ncr]);
    await pool.query(`UPDATE punch_points SET status='waived' WHERE id=$1`, [punch]);
    res = await advance(s.lc);
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('dispatch');
  });

  it('dispatch -> installation needs a delivered shipment for the project\'s order in this company', async () => {
    await evidence.shipment(co.B, s.so);
    expect((await advance(s.lc)).status).toBe(422);
    await evidence.shipment(co.A, s.so);
    expect((await advance(s.lc)).body.current_stage).toBe('installation');
  });

  it('installation -> commissioning (Pre-commissioning skipped) needs every installation completed and customer-accepted', async () => {
    const inst = await evidence.installation(co.A, s.project, { status: 'completed', accepted: false });
    expect((await advance(s.lc)).status).toBe(422);
    await pool.query(`UPDATE installation_requests SET customer_accepted=true WHERE id=$1`, [inst]);
    const res = await advance(s.lc);
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('commissioning');   // the old check constraint refused this value
  });

  it('commissioning -> SAT needs the commissioning workflow signed off and certified', async () => {
    const wf = await evidence.commissioning(co.A, s.project, { status: 'signed_off', certificate: false });
    expect((await advance(s.lc)).status).toBe(422);
    await pool.query(`UPDATE commissioning_workflows SET status='completed', certificate_issued=true WHERE id=$1`, [wf]);
    expect((await advance(s.lc)).body.current_stage).toBe('sat');
  });

  it('SAT -> closure needs a passed SAT signed off by the client (commissioning alone no longer passes it)', async () => {
    await evidence.sat(co.A, s.project, { status: 'passed', signed: false });
    expect((await advance(s.lc)).status).toBe(422);
    await evidence.sat(co.A, s.project, { status: 'passed', signed: true });
    expect((await advance(s.lc)).body.current_stage).toBe('closure');
    expect((await advance(s.lc)).status).toBe(409);   // nothing after Closure; completion is its own action
  });

  it('completion: approver only; blocked by open project work unless an approver gives an override reason', async () => {
    await pool.query(`INSERT INTO tasks (project_id, task_title, status) VALUES ($1,'finish snag list','todo')`, [s.project]);
    expect((await act(s.lc, 'complete', 'engA')).status).toBe(403);
    const blocked = await act(s.lc, 'complete', 'mgrA');
    expect(blocked.status).toBe(422);
    expect(blocked.body.blockers).toEqual([{ type: 'open_tasks', count: 1 }]);
    const done = await act(s.lc, 'complete', 'mgrA', { override_reason: 'Snag list handed to O&M team' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    const last = (await history(s.lc)).at(-1);
    expect(last).toMatchObject({ action: 'complete', remarks: 'Snag list handed to O&M team' });
    expect(last.gate_snapshot).toMatchObject({ overridden: true, blockers: [{ type: 'open_tasks', count: 1 }] });
  });

  it('recorded every move with actor and the gates it passed, and left projects.status alone', async () => {
    const h = await history(s.lc);
    const moves = h.filter(r => r.action === 'advance').map(r => `${r.from_stage}>${r.to_stage}`);
    expect(moves).toEqual(['order>design', 'design>procurement', 'procurement>production', 'production>testing',
      'testing>dispatch', 'dispatch>installation', 'installation>commissioning', 'commissioning>sat', 'sat>closure']);
    expect(h.every(r => r.actor_id === u.engA.id || r.actor_id === u.mgrA.id)).toBe(true);
    expect(h.find(r => r.to_stage === 'sat').gate_snapshot.gates).toEqual({ commissioning_done: true });
    const { rows: [p] } = await pool.query(`SELECT status, production_stage FROM projects WHERE id=$1`, [s.project]);
    expect(p).toEqual({ status: 'active', production_stage: null });
  });
});

// ── Backward, hold, resume, reopen, cancel ──────────────────────────────────
describe('backward moves and status changes', () => {
  it('rollback: approver only, reason required, only to an earlier stage; recorded', async () => {
    const s = await makeSetup(co.A, { stage: 'testing' });
    expect((await act(s.lc, 'rollback', 'engA', { reason: 'Redo the FAT' })).status).toBe(403);
    expect((await act(s.lc, 'rollback', 'mgrA', {})).status).toBe(400);
    expect((await act(s.lc, 'rollback', 'mgrA', { reason: 'Redo', to_stage: 'dispatch' })).status).toBe(400);   // reason too short
    expect((await act(s.lc, 'rollback', 'mgrA', { reason: 'Wrong move', to_stage: 'dispatch' })).status).toBe(422);
    const res = await act(s.lc, 'rollback', 'mgrA', { reason: 'Design change from customer', to_stage: 'design' });
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('design');
    expect((await history(s.lc)).at(-1)).toMatchObject({
      action: 'rollback', from_stage: 'testing', to_stage: 'design', remarks: 'Design change from customer', actor_id: u.mgrA.id });
  });

  it('hold only from active; resume only from on_hold', async () => {
    const s = await makeSetup(co.A);
    expect((await act(s.lc, 'resume', 'engA')).status).toBe(409);
    expect((await act(s.lc, 'hold', 'engA', { remarks: 'Customer site not ready' })).status).toBe(200);
    expect((await act(s.lc, 'hold', 'engA')).status).toBe(409);
    expect((await advance(s.lc)).status).toBe(409);   // on hold: resume first
    expect((await act(s.lc, 'resume', 'engA')).body.status).toBe('active');
  });

  it('a completed or cancelled lifecycle cannot be resumed; an approver reopens it with a reason', async () => {
    for (const status of ['completed', 'cancelled']) {
      const s = await makeSetup(co.A, { stage: 'design', status });
      const resume = await act(s.lc, 'resume', 'mgrA');
      expect(resume.status, status).toBe(409);
      expect(resume.body.code).toBe('NOT_ON_HOLD');
      expect((await lifecycle(s.lc)).status).toBe(status);
      expect((await act(s.lc, 'reopen', 'engA', { reason: 'Customer asked for rework' })).status).toBe(403);
      expect((await act(s.lc, 'reopen', 'mgrA', {})).status).toBe(400);
      const res = await act(s.lc, 'reopen', 'mgrA', { reason: 'Customer asked for rework' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'active', current_stage: 'design' });
      expect((await history(s.lc)).at(-1)).toMatchObject({ action: 'reopen', remarks: 'Customer asked for rework' });
    }
  });

  it('reopen is refused while another lifecycle of the same project is open (409)', async () => {
    const s = await makeSetup(co.A, { status: 'cancelled' });
    await one(`INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, current_stage, status)
               VALUES ($1,$2,$3,'order','active') RETURNING id`, [nextCode(), co.A, s.project]);
    const res = await act(s.lc, 'reopen', 'mgrA', { reason: 'Reopen the old one' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LIFECYCLE_EXISTS');
  });

  it('cancel: approver only, reason required; history is kept', async () => {
    const s = await makeSetup(co.A, { stage: 'production' });
    await advance(s.lc);   // a failed attempt writes nothing
    const before = (await history(s.lc)).length;
    expect((await act(s.lc, 'cancel', 'engA', { reason: 'Order withdrawn' })).status).toBe(403);
    expect((await act(s.lc, 'cancel', 'mgrA')).status).toBe(400);
    const res = await act(s.lc, 'cancel', 'mgrA', { reason: 'Order withdrawn by customer' });
    expect(res.body).toMatchObject({ status: 'cancelled', current_stage: 'production' });
    expect((await history(s.lc)).length).toBe(before + 1);
    expect((await act(s.lc, 'cancel', 'mgrA', { reason: 'Again please' })).status).toBe(409);
  });
});

// ── Administrative status vs stage ──────────────────────────────────────────
describe('project status and lifecycle stage are separate', () => {
  it('a cancelled or completed project\'s lifecycle cannot be moved (409); an on-hold project\'s still can', async () => {
    for (const projectStatus of ['cancelled', 'completed']) {
      const s = await makeSetup(co.A, { projectStatus });
      const res = await advance(s.lc);
      expect(res.status, projectStatus).toBe(409);
      expect(res.body.code).toBe('PROJECT_CLOSED');
    }
    const s = await makeSetup(co.A, { projectStatus: 'on_hold' });
    expect((await advance(s.lc)).status).toBe(200);
    const { rows: [p] } = await pool.query(`SELECT status FROM projects WHERE id=$1`, [s.project]);
    expect(p.status).toBe('on_hold');
  });

  it('GET shows the derived Project Master stage without writing it', async () => {
    const s = await makeSetup(co.A, { stage: 'testing' });
    const res = await call('get', `/api/lifecycle/instances/${s.lc}`, 'hrA');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ derived_production_stage: 'production', next_stage: 'dispatch',
      next_stage_gates: ['fat_passed', 'no_open_ncrs', 'no_open_punch_points'] });
    const { rows: [p] } = await pool.query(`SELECT production_stage FROM projects WHERE id=$1`, [s.project]);
    expect(p.production_stage).toBeNull();
  });
});

// ── Company isolation and permissions ───────────────────────────────────────
describe('company isolation and permissions', () => {
  it('another company cannot read or move the lifecycle (404); employee and view-only roles cannot move it (403)', async () => {
    const s = await makeSetup(co.A);
    expect((await call('get', `/api/lifecycle/instances/${s.lc}`, 'mgrB')).status).toBe(404);
    for (const action of ['advance', 'hold', 'rollback', 'cancel', 'reopen', 'complete']) {
      expect((await act(s.lc, action, 'mgrB', { reason: 'cross-company attempt' })).status, action).toBe(404);
    }
    expect((await advance(s.lc, 'empA')).status).toBe(403);
    expect((await advance(s.lc, 'hrA')).status).toBe(403);
    expect((await lifecycle(s.lc)).current_stage).toBe('order');
  });

  it('a manual project with no sales order cannot pass dispatch: the evidence rule is undecided, so the gate stays closed', async () => {
    const project = await one(`INSERT INTO projects (project_code, project_name, company_id, status, start_date)
                               VALUES ($1,'manual',$2,'active',CURRENT_DATE) RETURNING id`, [nextCode(), co.A]);
    const lc = await one(`INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, current_stage, status)
                          VALUES ($1,$2,$3,'dispatch','active') RETURNING id`, [nextCode(), co.A, project]);
    const res = await advance(lc);
    expect(res.status).toBe(422);
    expect(res.body.gate_details.dispatch_recorded.reason).toMatch(/no sales order/);
  });
});

// ── Orphans and failing closed ──────────────────────────────────────────────
describe('historical orphans and fail-closed gates', () => {
  it('a lifecycle whose project no longer exists is still readable and can be put on hold; it gains no evidence', async () => {
    const lc = await one(`INSERT INTO lifecycle_instances (lifecycle_number, company_id, project_id, current_stage, status)
                          VALUES ($1,$2,2147480002,'sat','active') RETURNING id`, [nextCode(), co.A]);
    const res = await call('get', `/api/lifecycle/instances/${lc}`, 'hrA');
    expect(res.status).toBe(200);
    expect(res.body.gates.sat_completed).toBe(false);
    expect((await act(lc, 'hold', 'engA')).status).toBe(200);
    expect((await lifecycle(lc)).project_id).toBe(2147480002);
  });

  it('a gate whose query fails is false and reported, never passed', async () => {
    const db = {
      query: (sql) => {
        if (/FROM ncr_reports/.test(sql)) return Promise.reject(new Error('relation unavailable'));
        if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ id: 1, status: 'active', company_id: 1 }] });
        return Promise.resolve({ rows: [] });
      },
    };
    const { gates, errors } = await checkGates(db, { id: 1, company_id: 1, project_id: 1 });
    expect(gates.no_open_ncrs).toBe(false);
    expect(errors).toEqual([{ gate: 'no_open_ncrs', error: 'relation unavailable' }]);
    expect(gates.no_open_punch_points).toBe(true);
  });
});
