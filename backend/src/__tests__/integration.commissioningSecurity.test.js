/**
 * integration.commissioningSecurity.test.js — commissioning certificates and
 * warranties, against the REAL database and the real routers mounted as
 * server.js mounts them. LEGACY_MIS_TO_PULSE_AUDIT.md Table 6 row 3, P0 Task 4.
 *
 * Endpoints covered:
 *  - /api/commissioning (servicedesk/routes/commissioning.routes.js): all 18.
 *    Pre-fix every one was "logged in = allowed"; child records (checklist,
 *    readings, photos) were written by workflow id with no company check;
 *    PUT could set status to signed_off/completed and skip sign-off; activating
 *    a warranty updated whatever customer_equipment id the workflow named and
 *    notified admins of every company.
 *  - /api/lifecycle commissioning-report, warranty and warranty-claim
 *    endpoints (operations/lifecycle.routes.js; the stage machine is not
 *    touched). Pre-fix a report or warranty could be linked to another
 *    company's lifecycle / sales order / warranty, and a claim's approver was
 *    whatever the client sent.
 *  - /api/projects warranty endpoints: verified, unchanged.
 *
 * Permission matrix (servicedesk): view = admin, department_head, hr, manager,
 * service_engineer, service_manager; add/edit = admin, department_head,
 * service_engineer, service_manager; approve = admin, department_head,
 * service_manager; delete = admin, service_manager.
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

const { default: pool }             = await import('../config/db.js');
const { verifyToken }               = await import('../middlewares/auth.middleware.js');
const { auditMutations }            = await import('../middlewares/auditMutations.js');
const { buildApp }                  = await import('./helpers/testApp.js');
const { FIXTURE_CODE_SQL }          = await import('../shared/employeeCode.js');
const { default: commissioningRoutes } = await import('../modules/servicedesk/routes/commissioning.routes.js');
const { default: lifecycleRoutes }  = await import('../modules/operations/lifecycle.routes.js');
const { default: projectRoutes }    = await import('../modules/projects/routes/projects.routes.js');

const app = buildApp(
  ['/api/commissioning', verifyToken, auditMutations('commissioning'), commissioningRoutes],
  ['/api/lifecycle',     verifyToken, auditMutations('lifecycle'),     lifecycleRoutes],
  ['/api/projects',      verifyToken, auditMutations('projects'),      projectRoutes],
);

const TAG = `ZZCOM${Date.now().toString(36).toUpperCase()}`;
const CODES = [`${TAG}A`, `${TAG}B`];
const co = {}, u = {}, emp = {}, prj = {}, eq = {}, wf = {}, rec = {};

const tokenFor = (k) => jwt.sign({ userId: u[k].id, company_id: u[k].company, employee_id: null },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const as = (k) => `Bearer ${tokenFor(k)}`;
const call = (method, path, who) => {
  const r = request(app)[method](path);
  return who ? r.set('Authorization', as(who)) : r;
};

async function sweep() {
  const noCo = `(SELECT id FROM users WHERE company_id IS NULL AND email = '${TAG.toLowerCase()}.nocompany@test.invalid')`;
  await pool.query(`DELETE FROM user_roles WHERE user_id IN ${noCo}`, []);
  await pool.query(`DELETE FROM users WHERE id IN ${noCo}`, []);
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = ANY($1)`, [CODES]);
  for (const { id } of rows) {
    const n = Number(id);
    const users = `(SELECT id FROM users WHERE company_id = ${n})`;
    const wfs   = `(SELECT id FROM commissioning_workflows WHERE company_id = ${n})`;
    const eqs   = `(SELECT id FROM customer_equipment WHERE company_id = ${n})`;
    const lcs   = `(SELECT id FROM lifecycle_instances WHERE company_id = ${n})`;
    const wrs   = `(SELECT id FROM warranty_registrations WHERE company_id = ${n} OR commissioning_workflow_id IN ${wfs} OR equipment_id IN ${eqs})`;
    await pool.query(`DELETE FROM warranty_claims WHERE company_id = $1 OR warranty_registration_id IN ${wrs}`, [n]);
    await pool.query(`DELETE FROM warranty_registrations WHERE id IN ${wrs}`, []);
    await pool.query(`DELETE FROM notifications WHERE notification_type = 'amc_eligible' AND reference_id IN ${wfs}`, []).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM voc_responses WHERE company_id = $1 OR commissioning_id IN ${wfs}`, [n]).catch(() => {});
    await pool.query(`DELETE FROM commissioning_photos WHERE workflow_id IN ${wfs} OR company_id = $1`, [n]);
    await pool.query(`DELETE FROM commissioning_readings WHERE workflow_id IN ${wfs} OR company_id = $1`, [n]);
    await pool.query(`DELETE FROM commissioning_checklist_items WHERE workflow_id IN ${wfs} OR company_id = $1`, [n]);
    await pool.query(`DELETE FROM installation_requests WHERE company_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM commissioning_workflows WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM commissioning_checklist_templates WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM commissioning_reports WHERE company_id = $1 OR lifecycle_instance_id IN ${lcs}`, [n]);
    await pool.query(`DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id IN ${lcs}`, []);
    await pool.query(`DELETE FROM lifecycle_instances WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM sales_orders WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM customer_equipment WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM projects WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM audit_logs WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM access_denials WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM user_roles WHERE user_id IN ${users}`, []);
    await pool.query(`DELETE FROM user_scope WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM users WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM employees WHERE company_id = $1`, [n]);
    // talent.routes.js seeds interview_questions into every company when it is
    // imported in the same worker; see integration.integrationsConfigSecurity.
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM companies WHERE id = $1`, [n]);
  }
}

const makeCompany = async (code) =>
  (await pool.query(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${code} Co`, code])).rows[0].id;

async function makeUser(key, company, roleCode, legacyRole = null) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ($1,$2,'not-a-real-hash',$3,true,$4) RETURNING id`,
    [`${TAG} ${key}`, `${TAG.toLowerCase()}.${key}@test.invalid`, company, legacyRole]);
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  if (!role.length) throw new Error(`role '${roleCode}' is missing from the matrix`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [rows[0].id, role[0].id]);
  u[key] = { id: rows[0].id, company };
}

const makeEmployee = async (key, company) => {
  emp[key] = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Tester', $2, 'Active') RETURNING id`, [`${TAG}${key}`, company])).rows[0].id;
};
const makeProject = async (key, company) => {
  prj[key] = (await pool.query(
    `INSERT INTO projects (project_code, project_name, company_id, status) VALUES ($1,$2,$3,'active') RETURNING id`,
    [`${TAG}-${key}`, `${TAG} ${key}`, company])).rows[0].id;
};
const makeEquipment = async (key, company) => {
  eq[key] = (await pool.query(
    `INSERT INTO customer_equipment (company_id, equipment_name, serial_number, warranty_status)
     VALUES ($1,$2,$3,'pending') RETURNING id`, [company, `${TAG} ${key}`, `${TAG}-SN-${key}`])).rows[0].id;
};

/**
 * A workflow with two mandatory + one optional checklist item and two readings.
 * Seeded directly rather than through createCommissioningWorkflow(): its
 * number generator counts per company against a globally unique column, so a
 * second company's first workflow collides with the first company's (a
 * pre-existing defect, reported, not part of this security task).
 */
async function makeWorkflow(key, company, { status = 'pending', mandatoryDone = false, certificate = false, equipment = null, project = null } = {}) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO commissioning_workflows
       (company_id, workflow_number, project_id, equipment_id, customer_name, scheduled_date, status,
        certificate_issued, certificate_number, certificate_issued_at)
     VALUES ($1,$2,$3,$4,$5,'2031-01-15',$6,$7::boolean,
             CASE WHEN $7::boolean THEN $8 END, CASE WHEN $7::boolean THEN NOW() END)
     RETURNING id`,
    [company, `${TAG}-${key}`, project ? prj[project] : null, equipment ? eq[equipment] : null,
     `${TAG} Customer ${key}`, status, certificate, `${TAG}-CERT-${key}`]);
  const items = [['Item 1', true, 1], ['Item 2', true, 2], ['Optional', false, 3]];
  for (const [text, mandatory, order] of items) {
    await pool.query(
      `INSERT INTO commissioning_checklist_items (company_id, workflow_id, category, item_text, is_mandatory, sort_order, is_completed)
       VALUES ($1,$2,'Testing',$3,$4,$5,$6)`, [company, w.id, text, mandatory, order, mandatoryDone && mandatory]);
  }
  for (const param of ['Voltage', 'Current']) {
    await pool.query(`INSERT INTO commissioning_readings (workflow_id, company_id, parameter, unit) VALUES ($1,$2,$3,'V')`, [w.id, company, param]);
  }
  wf[key] = w.id;
}

const workflow = async (key) => (await pool.query(`SELECT * FROM commissioning_workflows WHERE id = $1`, [wf[key]])).rows[0];
const firstItem = async (key, mandatory = true) => (await pool.query(
  `SELECT * FROM commissioning_checklist_items WHERE workflow_id = $1 AND is_mandatory = $2 ORDER BY sort_order LIMIT 1`, [wf[key], mandatory])).rows[0];
const firstReading = async (key) => (await pool.query(
  `SELECT * FROM commissioning_readings WHERE workflow_id = $1 ORDER BY id LIMIT 1`, [wf[key]])).rows[0];

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(CODES[0]);
  co.B = await makeCompany(CODES[1]);

  await makeUser('adminA',  co.A, 'admin', 'admin');
  await makeUser('mgrA',    co.A, 'service_manager');   // approve
  await makeUser('engA',    co.A, 'service_engineer');  // view/add/edit, no approve
  await makeUser('hrA',     co.A, 'hr');                // view only
  await makeUser('empA',    co.A, 'employee');          // no servicedesk
  await makeUser('adminB',  co.B, 'admin', 'admin');
  await makeUser('mgrB',    co.B, 'service_manager');
  await makeUser('nocompany', null, 'service_manager');

  await makeEmployee('engA', co.A);
  await makeEmployee('engB', co.B);
  await makeProject('pA', co.A);
  await makeProject('pB', co.B);
  await makeEquipment('eA', co.A);
  await makeEquipment('eA2', co.A);
  await makeEquipment('eB', co.B);

  await makeWorkflow('pendingA',   co.A);
  await makeWorkflow('pendingDoneA', co.A, { mandatoryDone: true });
  await makeWorkflow('progressA',  co.A, { status: 'in_progress' });
  await makeWorkflow('signedA',    co.A, { status: 'signed_off', mandatoryDone: true });
  await makeWorkflow('flowA',      co.A, { project: 'pA', equipment: 'eA' });
  await makeWorkflow('certA',      co.A, { status: 'completed', mandatoryDone: true, certificate: true, equipment: 'eA2' });
  // A legacy bad link: company A's certified workflow naming company B's equipment.
  await makeWorkflow('badLinkA',   co.A, { status: 'completed', mandatoryDone: true, certificate: true, equipment: 'eB' });
  await makeWorkflow('progressB',  co.B, { status: 'in_progress' });
  await makeWorkflow('signedB',    co.B, { status: 'signed_off', mandatoryDone: true });
  await makeWorkflow('certB',      co.B, { status: 'completed', mandatoryDone: true, certificate: true });

  rec.photoB = (await pool.query(
    `INSERT INTO commissioning_photos (workflow_id, company_id, caption, file_path, phase, uploaded_by)
     VALUES ($1,$2,'B photo','/x/b.jpg','general','B') RETURNING id`, [wf.progressB, co.B])).rows[0].id;
  rec.photoSignedA = (await pool.query(
    `INSERT INTO commissioning_photos (workflow_id, company_id, caption, file_path, phase, uploaded_by)
     VALUES ($1,$2,'A photo','/x/a.jpg','general','A') RETURNING id`, [wf.signedA, co.A])).rows[0].id;

  rec.lcB = (await pool.query(
    `INSERT INTO lifecycle_instances (lifecycle_number, current_stage, status, company_id)
     VALUES ($1,'installation','active',$2) RETURNING id`, [`${TAG}-LCB`, co.B])).rows[0].id;
  rec.soB = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status)
     VALUES ($1,$2,'B customer','confirmed') RETURNING id`, [`${TAG}-SOB`, co.B])).rows[0].id;
  rec.reportB = (await pool.query(
    `INSERT INTO commissioning_reports (lifecycle_instance_id, site_name, status, company_id)
     VALUES ($1,'B site','open',$2) RETURNING id`, [rec.lcB, co.B])).rows[0].id;
  const wr = async (company, sn) => (await pool.query(
    `INSERT INTO warranty_registrations (warranty_number, serial_number, product_name, customer_name, warranty_start, warranty_end, company_id, project_id, status)
     VALUES ($1,$1,'P','C','2031-01-01','2032-01-01',$2,$3,'Active') RETURNING id`,
    [`${TAG}-${sn}`, company, company === co.A ? prj.pA : prj.pB])).rows[0].id;
  rec.wrA = await wr(co.A, 'WRA');
  rec.wrB = await wr(co.B, 'WRB');
  rec.claimA = (await pool.query(
    `INSERT INTO warranty_claims (claim_number, warranty_registration_id, issue_description, company_id, status)
     VALUES ($1,$2,'A fault',$3,'open') RETURNING id`, [`${TAG}-WCA`, rec.wrA, co.A])).rows[0].id;
  rec.claimA2 = (await pool.query(
    `INSERT INTO warranty_claims (claim_number, warranty_registration_id, issue_description, company_id, status)
     VALUES ($1,$2,'A fault 2',$3,'open') RETURNING id`, [`${TAG}-WCA2`, rec.wrA, co.A])).rows[0].id;
}, 90_000);

// Never pool.end(): the pool is shared across this worker's suites.
afterAll(async () => { await sweep(); }, 90_000);

// ── Authentication: every endpoint ──────────────────────────────────────────
const SD = [
  ['get', '/api/commissioning'], ['post', '/api/commissioning'], ['get', '/api/commissioning/1'],
  ['put', '/api/commissioning/1'], ['post', '/api/commissioning/1/checkin'], ['post', '/api/commissioning/1/checkout'],
  ['put', '/api/commissioning/1/checklist/1'], ['post', '/api/commissioning/1/checklist'],
  ['put', '/api/commissioning/1/readings/1'], ['post', '/api/commissioning/1/readings'],
  ['post', '/api/commissioning/1/photos'], ['delete', '/api/commissioning/1/photos/1'],
  ['post', '/api/commissioning/1/signoff'], ['post', '/api/commissioning/1/issue-certificate'],
  ['post', '/api/commissioning/1/activate-warranty'], ['get', '/api/commissioning/analytics/summary'],
  ['get', '/api/commissioning/templates/list'], ['post', '/api/commissioning/templates'],
];
const LC = [
  ['get', '/api/lifecycle/commissioning'], ['get', '/api/lifecycle/commissioning/1'], ['post', '/api/lifecycle/commissioning'],
  ['put', '/api/lifecycle/commissioning/1'], ['put', '/api/lifecycle/commissioning/1/signoff'],
  ['get', '/api/lifecycle/warranty'], ['get', '/api/lifecycle/warranty/1'], ['post', '/api/lifecycle/warranty'],
  ['put', '/api/lifecycle/warranty/1'], ['delete', '/api/lifecycle/warranty/1'],
  ['get', '/api/lifecycle/warranty-claims'], ['post', '/api/lifecycle/warranty-claims'], ['put', '/api/lifecycle/warranty-claims/1'],
];

describe('authentication', () => {
  it('covers all 18 Service Desk commissioning endpoints and 13 lifecycle commissioning/warranty endpoints', () => {
    expect(SD).toHaveLength(18);
    expect(LC).toHaveLength(13);
  });
  for (const [m, p] of [...SD, ...LC]) {
    it(`401 without a token: ${m.toUpperCase()} ${p}`, async () => {
      expect((await call(m, p).send({})).status).toBe(401);
    });
  }
});

// ── Permissions ─────────────────────────────────────────────────────────────
describe('permissions on /api/commissioning', () => {
  it('no servicedesk:view → list, detail, analytics and templates are refused', async () => {
    for (const p of ['/api/commissioning', `/api/commissioning/${wf.pendingA}`, '/api/commissioning/analytics/summary', '/api/commissioning/templates/list']) {
      expect((await call('get', p, 'empA')).status).toBe(403);
    }
  });
  it('view-only (hr) cannot create, edit, check in, record or sign off', async () => {
    expect((await call('post', '/api/commissioning', 'hrA').send({ customer_name: 'x', scheduled_date: '2031-01-01' })).status).toBe(403);
    expect((await call('put', `/api/commissioning/${wf.pendingA}`, 'hrA').send({ notes: 'x' })).status).toBe(403);
    expect((await call('post', `/api/commissioning/${wf.pendingA}/checkin`, 'hrA').send({ lat: 1, lng: 2 })).status).toBe(403);
    expect((await call('put', `/api/commissioning/${wf.progressA}/checklist/${(await firstItem('progressA')).id}`, 'hrA').send({ is_completed: true })).status).toBe(403);
    expect((await call('post', `/api/commissioning/${wf.progressA}/signoff`, 'hrA').send({ customer_sign_name: 'x' })).status).toBe(403);
    expect((await call('post', '/api/commissioning/templates', 'hrA').send({ name: 'x' })).status).toBe(403);
  });
  it('a service engineer (no approve) cannot issue a certificate', async () => {
    const res = await call('post', `/api/commissioning/${wf.signedA}/issue-certificate`, 'engA');
    expect(res.status).toBe(403);
    expect((await workflow('signedA')).certificate_issued).toBe(false);
  });
  it('a service engineer (no approve) cannot start a warranty', async () => {
    const res = await call('post', `/api/commissioning/${wf.certA}/activate-warranty`, 'engA').send({ warranty_months: 12 });
    expect(res.status).toBe(403);
    expect((await workflow('certA')).warranty_activated).toBeFalsy();
  });
  it('a viewer can read', async () => {
    expect((await call('get', '/api/commissioning', 'hrA')).status).toBe(200);
    expect((await call('get', `/api/commissioning/${wf.pendingA}`, 'hrA')).status).toBe(200);
  });
  it('a login with no company is refused', async () => {
    expect((await call('get', '/api/commissioning', 'nocompany')).status).toBe(403);
    expect((await call('post', '/api/commissioning', 'nocompany').send({ customer_name: 'x', scheduled_date: '2031-01-01' })).status).toBe(403);
  });
});

// ── Cross-company ───────────────────────────────────────────────────────────
describe('cross-company on /api/commissioning', () => {
  it("cannot read, edit, check in/out or sign off another company's workflow", async () => {
    expect((await call('get', `/api/commissioning/${wf.progressB}`, 'mgrA')).status).toBe(404);
    expect((await call('put', `/api/commissioning/${wf.progressB}`, 'mgrA').send({ notes: 'x' })).status).toBe(404);
    expect((await call('post', `/api/commissioning/${wf.progressB}/checkin`, 'mgrA').send({ lat: 1, lng: 2 })).status).toBe(404);
    expect((await call('post', `/api/commissioning/${wf.progressB}/checkout`, 'mgrA')).status).toBe(404);
    expect((await call('post', `/api/commissioning/${wf.progressB}/signoff`, 'mgrA').send({ customer_sign_name: 'x' })).status).toBe(404);
  });
  it("cannot tick another company's checklist item", async () => {
    const item = await firstItem('progressB');
    const res = await call('put', `/api/commissioning/${wf.progressB}/checklist/${item.id}`, 'mgrA').send({ is_completed: true });
    expect(res.status).toBe(404);
    expect((await pool.query(`SELECT is_completed FROM commissioning_checklist_items WHERE id=$1`, [item.id])).rows[0].is_completed).toBe(false);
  });
  it("cannot add checklist items to another company's workflow", async () => {
    const res = await call('post', `/api/commissioning/${wf.progressB}/checklist`, 'mgrA').send({ item_text: 'planted', is_mandatory: true });
    expect(res.status).toBe(404);
    const { rows } = await pool.query(`SELECT 1 FROM commissioning_checklist_items WHERE workflow_id=$1 AND item_text='planted'`, [wf.progressB]);
    expect(rows).toHaveLength(0);
  });
  it("cannot change or add another company's readings", async () => {
    const r = await firstReading('progressB');
    expect((await call('put', `/api/commissioning/${wf.progressB}/readings/${r.id}`, 'mgrA').send({ measured_value: '999' })).status).toBe(404);
    expect((await pool.query(`SELECT measured_value FROM commissioning_readings WHERE id=$1`, [r.id])).rows[0].measured_value).toBeNull();
    expect((await call('post', `/api/commissioning/${wf.progressB}/readings`, 'mgrA').send({ parameter: 'planted' })).status).toBe(404);
  });
  it("cannot add or delete another company's photos", async () => {
    expect((await call('post', `/api/commissioning/${wf.progressB}/photos`, 'mgrA').send({ file_path: '/p.jpg' })).status).toBe(404);
    expect((await call('delete', `/api/commissioning/${wf.progressB}/photos/${rec.photoB}`, 'mgrA')).status).toBe(404);
    expect((await pool.query(`SELECT 1 FROM commissioning_photos WHERE id=$1`, [rec.photoB])).rows).toHaveLength(1);
  });
  it("cannot issue a certificate or start a warranty for another company's workflow", async () => {
    expect((await call('post', `/api/commissioning/${wf.signedB}/issue-certificate`, 'mgrA')).status).toBe(404);
    expect((await call('post', `/api/commissioning/${wf.certB}/activate-warranty`, 'mgrA').send({ warranty_months: 12 })).status).toBe(404);
    expect((await workflow('signedB')).certificate_issued).toBe(false);
    expect((await workflow('certB')).warranty_activated).toBeFalsy();
  });
  it("cannot create a workflow on another company's project, equipment or engineer", async () => {
    const base = { customer_name: `${TAG} x`, scheduled_date: '2031-02-01' };
    expect((await call('post', '/api/commissioning', 'engA').send({ ...base, project_id: prj.pB })).status).toBe(400);
    expect((await call('post', '/api/commissioning', 'engA').send({ ...base, equipment_id: eq.eB })).status).toBe(400);
    expect((await call('post', '/api/commissioning', 'engA').send({ ...base, engineer_id: emp.engB })).status).toBe(400);
  });
  it("cannot reassign a workflow to another company's engineer", async () => {
    expect((await call('put', `/api/commissioning/${wf.pendingA}`, 'engA').send({ engineer_id: emp.engB })).status).toBe(400);
  });
  it("activating a warranty never touches another company's equipment or notifies another company", async () => {
    const before = (await pool.query(`SELECT warranty_status, warranty_expiry FROM customer_equipment WHERE id=$1`, [eq.eB])).rows[0];
    const res = await call('post', `/api/commissioning/${wf.badLinkA}/activate-warranty`, 'mgrA').send({ warranty_months: 12 });
    expect(res.status).toBe(200);
    const after = (await pool.query(`SELECT warranty_status, warranty_expiry FROM customer_equipment WHERE id=$1`, [eq.eB])).rows[0];
    expect(after).toEqual(before);
    const { rows: leaked } = await pool.query(
      `SELECT 1 FROM notifications WHERE notification_type='amc_eligible' AND reference_id=$1
          AND user_id NOT IN (SELECT id FROM users WHERE company_id = $2)`, [wf.badLinkA, co.A]);
    expect(leaked).toHaveLength(0);
    const { rows: own } = await pool.query(
      `SELECT 1 FROM notifications WHERE notification_type='amc_eligible' AND reference_id=$1 AND user_id=$2`, [wf.badLinkA, u.adminA.id]);
    expect(own).toHaveLength(1);
  });
});

// ── Workflow state ──────────────────────────────────────────────────────────
describe('workflow prerequisites', () => {
  it('PUT cannot jump a workflow to signed_off or completed', async () => {
    for (const status of ['signed_off', 'completed']) {
      expect((await call('put', `/api/commissioning/${wf.progressA}`, 'mgrA').send({ status })).status).toBe(400);
    }
    expect((await workflow('progressA')).status).toBe('in_progress');
  });
  it('a certified workflow cannot be edited', async () => {
    expect((await call('put', `/api/commissioning/${wf.certA}`, 'mgrA').send({ customer_name: 'changed', status: 'pending' })).status).toBe(409);
    expect((await workflow('certA')).status).toBe('completed');
  });
  it('sign-off needs a checked-in (in progress) workflow', async () => {
    const res = await call('post', `/api/commissioning/${wf.pendingDoneA}/signoff`, 'engA').send({ customer_sign_name: 'Cust' });
    expect(res.status).toBe(409);
    expect((await workflow('pendingDoneA')).status).toBe('pending');
  });
  it('a certified workflow cannot be signed off again', async () => {
    expect((await call('post', `/api/commissioning/${wf.certA}/signoff`, 'engA').send({ customer_sign_name: 'Again' })).status).toBe(409);
    expect((await workflow('certA')).status).toBe('completed');
  });
  it('check-in is refused once signed off', async () => {
    expect((await call('post', `/api/commissioning/${wf.signedA}/checkin`, 'engA').send({ lat: 1, lng: 2 })).status).toBe(409);
  });
  it('checklist, readings and photos are frozen after sign-off', async () => {
    const item = await firstItem('signedA');
    expect((await call('put', `/api/commissioning/${wf.signedA}/checklist/${item.id}`, 'engA').send({ is_completed: false })).status).toBe(409);
    expect((await pool.query(`SELECT is_completed FROM commissioning_checklist_items WHERE id=$1`, [item.id])).rows[0].is_completed).toBe(true);
    expect((await call('post', `/api/commissioning/${wf.signedA}/checklist`, 'engA').send({ item_text: 'late' })).status).toBe(409);
    const r = await firstReading('signedA');
    expect((await call('put', `/api/commissioning/${wf.signedA}/readings/${r.id}`, 'engA').send({ measured_value: '1' })).status).toBe(409);
    expect((await call('post', `/api/commissioning/${wf.signedA}/readings`, 'engA').send({ parameter: 'late' })).status).toBe(409);
    expect((await call('post', `/api/commissioning/${wf.signedA}/photos`, 'engA').send({ file_path: '/late.jpg' })).status).toBe(409);
    expect((await call('delete', `/api/commissioning/${wf.signedA}/photos/${rec.photoSignedA}`, 'engA')).status).toBe(409);
  });
  it('a certificate needs customer sign-off (unchanged)', async () => {
    expect((await call('post', `/api/commissioning/${wf.progressA}/issue-certificate`, 'mgrA')).status).toBe(400);
  });
  it('a warranty needs a certificate, and a sane term', async () => {
    expect((await call('post', `/api/commissioning/${wf.signedA}/activate-warranty`, 'mgrA').send({ warranty_months: 12 })).status).toBe(400);
    for (const m of [-5, 0, 'abc', 1000]) {
      expect((await call('post', `/api/commissioning/${wf.certA}/activate-warranty`, 'mgrA').send({ warranty_months: m })).status).toBe(400);
    }
    expect((await workflow('certA')).warranty_activated).toBeFalsy();
  });
});

// ── The legitimate end-to-end workflow ──────────────────────────────────────
describe('authorized commissioning, end to end', () => {
  it('engineer checks in, completes the checklist, records a reading, takes the sign-off', async () => {
    const id = wf.flowA;
    expect((await call('post', `/api/commissioning/${id}/checkin`, 'engA').send({ lat: 12.9, lng: 77.6, address: 'Site' })).status).toBe(200);
    const items = (await pool.query(`SELECT id FROM commissioning_checklist_items WHERE workflow_id=$1 AND is_mandatory`, [id])).rows;
    for (const it2 of items) {
      const r = await call('put', `/api/commissioning/${id}/checklist/${it2.id}`, 'engA').send({ is_completed: true, completed_by: 'Someone Else' });
      expect(r.status).toBe(200);
      expect(r.body.completed_by).toBe(`${TAG} engA`); // from the session, never the body
    }
    const reading = await firstReading('flowA');
    expect((await call('put', `/api/commissioning/${id}/readings/${reading.id}`, 'engA').send({ measured_value: '415' })).status).toBe(200);
    const photo = await call('post', `/api/commissioning/${id}/photos`, 'engA').send({ file_path: '/ok.jpg', uploaded_by: 'Someone Else' });
    expect(photo.status).toBe(201);
    expect(photo.body.uploaded_by).toBe(`${TAG} engA`);
    const so = await call('post', `/api/commissioning/${id}/signoff`, 'engA').send({ customer_sign_name: 'Customer Rep', customer_rating: 5 });
    expect(so.status).toBe(200);
    expect(so.body.status).toBe('signed_off');
  });
  it('a service manager issues the certificate and starts the warranty', async () => {
    const id = wf.flowA;
    const cert = await call('post', `/api/commissioning/${id}/issue-certificate`, 'mgrA');
    expect(cert.status).toBe(200);
    expect(cert.body.certificate_issued).toBe(true);
    expect(cert.body.status).toBe('completed');
    const w = await call('post', `/api/commissioning/${id}/activate-warranty`, 'mgrA').send({ warranty_months: 24 });
    expect(w.status).toBe(200);
    expect(w.body.warranty_activated).toBe(true);
    const { rows } = await pool.query(`SELECT company_id, warranty_months FROM warranty_registrations WHERE commissioning_workflow_id=$1`, [id]);
    expect(rows).toEqual([{ company_id: co.A, warranty_months: 24 }]);
    expect((await pool.query(`SELECT warranty_status FROM customer_equipment WHERE id=$1`, [eq.eA])).rows[0].warranty_status).toBe('active');
  });
  it('the existing certificate stays intact after the warranty starts', async () => {
    const after = await workflow('flowA');
    expect(after.certificate_number).toBeTruthy();
    expect(after.status).toBe('completed');
  });
  it('a service engineer can create a workflow in their own company', async () => {
    const res = await call('post', '/api/commissioning', 'engA').send({
      customer_name: `${TAG} new`, scheduled_date: '2031-03-01', project_id: prj.pA, equipment_id: eq.eA, engineer_id: emp.engA });
    expect(res.status).toBe(201);
    expect(res.body.company_id).toBe(co.A);
  });
});

// ── /api/lifecycle commissioning reports, warranties, claims ────────────────
describe('/api/lifecycle commissioning and warranty endpoints', () => {
  it('a login with no company is refused (it used to read and write across companies)', async () => {
    expect((await call('get', '/api/lifecycle/warranty', 'nocompany')).status).toBe(403);
    expect((await call('post', '/api/lifecycle/commissioning', 'nocompany').send({ site_name: 'x' })).status).toBe(403);
  });
  it("a commissioning report cannot be linked to another company's lifecycle or sales order", async () => {
    expect((await call('post', '/api/lifecycle/commissioning', 'mgrA').send({ site_name: 'x', lifecycle_instance_id: rec.lcB, status: 'completed' })).status).toBe(400);
    expect((await call('post', '/api/lifecycle/commissioning', 'mgrA').send({ site_name: 'x', sales_order_id: rec.soB })).status).toBe(400);
    const { rows } = await pool.query(`SELECT 1 FROM commissioning_reports WHERE lifecycle_instance_id=$1 AND company_id<>$2`, [rec.lcB, co.B]);
    expect(rows).toHaveLength(0);
  });
  it("another company's report cannot be read, edited or signed off", async () => {
    expect((await call('get', `/api/lifecycle/commissioning/${rec.reportB}`, 'mgrA')).status).toBe(404);
    expect((await call('put', `/api/lifecycle/commissioning/${rec.reportB}`, 'mgrA').send({ status: 'completed' })).status).toBe(404);
    expect((await call('put', `/api/lifecycle/commissioning/${rec.reportB}/signoff`, 'mgrA').send({ witness_name: 'x' })).status).toBe(404);
  });
  it("a warranty cannot be linked to another company's lifecycle or sales order", async () => {
    const base = { serial_number: `${TAG}-SNX`, warranty_start: '2031-01-01', warranty_end: '2032-01-01' };
    expect((await call('post', '/api/lifecycle/warranty', 'mgrA').send({ ...base, lifecycle_instance_id: rec.lcB })).status).toBe(400);
    expect((await call('post', '/api/lifecycle/warranty', 'mgrA').send({ ...base, sales_order_id: rec.soB })).status).toBe(400);
  });
  it("another company's warranty cannot be read, changed or deleted", async () => {
    expect((await call('get', `/api/lifecycle/warranty/${rec.wrB}`, 'mgrA')).status).toBe(404);
    expect((await call('put', `/api/lifecycle/warranty/${rec.wrB}`, 'mgrA').send({ warranty_end: '2040-01-01' })).status).toBe(404);
    expect((await call('delete', `/api/lifecycle/warranty/${rec.wrB}`, 'adminA')).status).toBe(404);
  });
  it("a claim cannot be raised against another company's warranty", async () => {
    expect((await call('post', '/api/lifecycle/warranty-claims', 'engA').send({ issue_description: 'x', warranty_registration_id: rec.wrB })).status).toBe(400);
  });
  it('approving or rejecting a claim needs servicedesk:approve', async () => {
    expect((await call('put', `/api/lifecycle/warranty-claims/${rec.claimA}`, 'engA').send({ status: 'approved' })).status).toBe(403);
    expect((await call('put', `/api/lifecycle/warranty-claims/${rec.claimA}`, 'engA').send({ status: 'rejected' })).status).toBe(403);
    const { rows } = await pool.query(`SELECT status, approved_by FROM warranty_claims WHERE id=$1`, [rec.claimA]);
    expect(rows[0]).toEqual({ status: 'open', approved_by: null });
  });
  it('a claim records the logged-in approver, never the one in the request', async () => {
    const res = await call('put', `/api/lifecycle/warranty-claims/${rec.claimA}`, 'mgrA').send({ status: 'approved', approved_by: 'Somebody Important' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.approved_by).not.toBe('Somebody Important');
    expect(res.body.approved_by).toBe(`${TAG} mgrA`);
  });
  it('an engineer can still add notes to a claim without deciding it', async () => {
    const res = await call('put', `/api/lifecycle/warranty-claims/${rec.claimA2}`, 'engA').send({ resolution_notes: 'checked on site', approved_by: 'Someone' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    expect(res.body.approved_by).toBeNull();
  });
  it('own-company reads still work', async () => {
    expect((await call('get', `/api/lifecycle/warranty/${rec.wrA}`, 'hrA')).status).toBe(200);
    const list = await call('get', '/api/lifecycle/warranty-claims', 'hrA');
    expect(list.status).toBe(200);
    expect(list.body.every(c => c.company_id === co.A)).toBe(true);
  });
});

// ── /api/projects warranty endpoints (verified, not changed) ────────────────
describe('/api/projects warranty endpoints', () => {
  it("are scoped to the caller's company", async () => {
    const list = await call('get', `/api/projects/projects/${prj.pB}/warranties`, 'adminA');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    expect((await call('post', `/api/projects/projects/${prj.pB}/warranties`, 'adminA').send({ serial_number: 'x' })).status).toBe(403);
    expect((await call('put', `/api/projects/warranties/${rec.wrB}`, 'adminA').send({ status: 'Expired' })).status).toBe(404);
  });
});
