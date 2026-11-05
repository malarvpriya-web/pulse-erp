/**
 * integration.commissioningNumbering.test.js — company-safe numbering for
 * commissioning workflows (CW-), certificates (CERT-), warranties (WR-) and
 * warranty claims (WC-), against the REAL database. P1 numbering task.
 *
 * Pre-fix every generator was COUNT(*) of the caller's company + 1 while
 * workflow_number / warranty_number / claim_number are UNIQUE across all
 * companies: a second company's first record reused the first company's
 * number and the insert failed (duplicate key); concurrent creates in one
 * company raced on the same COUNT; certificate numbers (no unique constraint)
 * were silently duplicated across companies.
 *
 * Fix: global sequences (migration 20261014000001_commissioning_numbering_sequences.js)
 * via shared/docNumber.js. Formats are unchanged.
 *
 * Every writer of these numbers is exercised through its real route:
 *   CW   POST /api/commissioning
 *   CERT POST /api/commissioning/:id/issue-certificate
 *   WR   POST /api/commissioning/:id/activate-warranty, POST /api/lifecycle/warranty,
 *        POST /api/projects/projects/:id/warranties
 *   WC   POST /api/lifecycle/warranty-claims
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

const { default: pool }                = await import('../config/db.js');
const { verifyToken }                  = await import('../middlewares/auth.middleware.js');
const { auditMutations }               = await import('../middlewares/auditMutations.js');
const { buildApp }                     = await import('./helpers/testApp.js');
const { default: commissioningRoutes } = await import('../modules/servicedesk/routes/commissioning.routes.js');
const { default: lifecycleRoutes }     = await import('../modules/operations/lifecycle.routes.js');
const { default: projectRoutes }       = await import('../modules/projects/routes/projects.routes.js');

const app = buildApp(
  ['/api/commissioning', verifyToken, auditMutations('commissioning'), commissioningRoutes],
  ['/api/lifecycle',     verifyToken, auditMutations('lifecycle'),     lifecycleRoutes],
  ['/api/projects',      verifyToken, auditMutations('projects'),      projectRoutes],
);

const TAG = `ZZNUM${Date.now().toString(36).toUpperCase()}`;
const CODES = [`${TAG}A`, `${TAG}B`];
const co = {}, u = {}, prj = {}, eq = {};

const as = (k) => `Bearer ${jwt.sign({ userId: u[k].id, company_id: u[k].company, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const post = (path, who, body = {}) => request(app).post(path).set('Authorization', as(who)).send(body);

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = ANY($1)`, [CODES]);
  for (const { id } of rows) {
    const n = Number(id);
    const users = `(SELECT id FROM users WHERE company_id = ${n})`;
    const wfs   = `(SELECT id FROM commissioning_workflows WHERE company_id = ${n})`;
    const eqs   = `(SELECT id FROM customer_equipment WHERE company_id = ${n})`;
    const wrs   = `(SELECT id FROM warranty_registrations WHERE company_id = ${n} OR commissioning_workflow_id IN ${wfs} OR equipment_id IN ${eqs})`;
    await pool.query(`DELETE FROM warranty_claims WHERE company_id = $1 OR warranty_registration_id IN ${wrs}`, [n]);
    await pool.query(`DELETE FROM warranty_registrations WHERE id IN ${wrs}`, []);
    await pool.query(`DELETE FROM notifications WHERE notification_type = 'amc_eligible' AND reference_id IN ${wfs}`, []).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM voc_responses WHERE company_id = $1 OR commissioning_id IN ${wfs}`, [n]).catch(() => {});
    await pool.query(`DELETE FROM commissioning_photos WHERE workflow_id IN ${wfs} OR company_id = $1`, [n]);
    await pool.query(`DELETE FROM commissioning_readings WHERE workflow_id IN ${wfs} OR company_id = $1`, [n]);
    await pool.query(`DELETE FROM commissioning_checklist_items WHERE workflow_id IN ${wfs} OR company_id = $1`, [n]);
    await pool.query(`DELETE FROM commissioning_workflows WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM customer_equipment WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM projects WHERE company_id = $1`, [n]);
    await pool.query(`DELETE FROM audit_logs WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM access_denials WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM user_roles WHERE user_id IN ${users}`, []);
    await pool.query(`DELETE FROM user_scope WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM users WHERE company_id = $1`, [n]);
    // talent.routes.js seeds interview_questions into every company when it is
    // imported in the same worker; see integration.integrationsConfigSecurity.
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM companies WHERE id = $1`, [n]);
  }
}

async function makeUser(key, company, roleCode) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active)
     VALUES ($1,$2,'not-a-real-hash',$3,true) RETURNING id`,
    [`${TAG} ${key}`, `${TAG.toLowerCase()}.${key}@test.invalid`, company]);
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [rows[0].id, role[0].id]);
  u[key] = { id: rows[0].id, company };
}

/** A signed-off workflow ready for a certificate (all mandatory items done). */
async function signedOffWorkflow(company, key) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO commissioning_workflows (company_id, workflow_number, customer_name, scheduled_date, status, customer_sign_name)
     VALUES ($1,$2,$3,'2031-01-15','signed_off','Customer') RETURNING id`,
    [company, `${TAG}-${key}`, `${TAG} ${key}`]);
  return w.id;
}

const ids = (rows) => rows.map(r => r.body?.workflow_number ?? r.body?.warranty_number ?? r.body?.claim_number);
const unique = (arr) => new Set(arr).size === arr.length;

// The four sequences the fix relies on, read at the start so new numbers can be
// compared against everything that existed before this suite ran.
let existing;

beforeAll(async () => {
  await sweep();
  for (const [k, code] of [['A', CODES[0]], ['B', CODES[1]]]) {
    co[k] = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${code} Co`, code])).rows[0].id;
    await makeUser(`mgr${k}`, co[k], 'service_manager');
    await makeUser(`admin${k}`, co[k], 'admin');
    prj[k] = (await pool.query(
      `INSERT INTO projects (project_code, project_name, company_id, status) VALUES ($1,$2,$3,'active') RETURNING id`,
      [`${TAG}-P${k}`, `${TAG} P${k}`, co[k]])).rows[0].id;
    eq[k] = (await pool.query(
      `INSERT INTO customer_equipment (company_id, equipment_name, serial_number) VALUES ($1,$2,$3) RETURNING id`,
      [co[k], `${TAG} E${k}`, `${TAG}-SN${k}`])).rows[0].id;
  }
  existing = {
    cw: new Set((await pool.query(`SELECT workflow_number v FROM commissioning_workflows WHERE workflow_number IS NOT NULL`)).rows.map(r => r.v)),
    cert: new Set((await pool.query(`SELECT certificate_number v FROM commissioning_workflows WHERE certificate_number IS NOT NULL`)).rows.map(r => r.v)),
    wr: new Set((await pool.query(`SELECT warranty_number v FROM warranty_registrations WHERE warranty_number IS NOT NULL`)).rows.map(r => r.v)),
    wc: new Set((await pool.query(`SELECT claim_number v FROM warranty_claims WHERE claim_number IS NOT NULL`)).rows.map(r => r.v)),
  };
}, 60_000);

// Never pool.end(): the pool is shared across this worker's suites.
afterAll(async () => { await sweep(); }, 60_000);

// ── Workflows (CW-) ─────────────────────────────────────────────────────────
describe('commissioning workflow numbers (CW-YY-NNNN)', () => {
  const body = (k) => ({ customer_name: `${TAG} cust ${k}`, scheduled_date: '2031-02-01' });

  it('two companies can each create their first workflow', async () => {
    const a = await post('/api/commissioning', 'mgrA', body('A1'));
    const b = await post('/api/commissioning', 'mgrB', body('B1'));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.workflow_number).not.toBe(b.body.workflow_number);
    expect(a.body.workflow_number).toMatch(/^CW-\d{2}-\d{4,}$/);
    expect(b.body.company_id).toBe(co.B);
  });

  it('concurrent creates in both companies all succeed with distinct numbers', async () => {
    const res = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => post('/api/commissioning', 'mgrA', body(`A-c${i}`))),
      ...Array.from({ length: 6 }, (_, i) => post('/api/commissioning', 'mgrB', body(`B-c${i}`))),
    ]);
    expect(res.map(r => r.status)).toEqual(Array(12).fill(201));
    expect(unique(ids(res))).toBe(true);
  });

  it('never reuses a number that existed before', async () => {
    const { rows } = await pool.query(
      `SELECT workflow_number v FROM commissioning_workflows WHERE company_id = ANY($1::int[]) AND workflow_number NOT LIKE $2`,
      [[co.A, co.B], `${TAG}%`]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter(r => existing.cw.has(r.v))).toEqual([]);
  });
});

// ── Certificates (CERT-) ────────────────────────────────────────────────────
describe('commissioning certificate numbers (CERT-YYYY-NNNN)', () => {
  it("two companies' first certificates get different numbers", async () => {
    const wa = await signedOffWorkflow(co.A, 'certA');
    const wb = await signedOffWorkflow(co.B, 'certB');
    const a = await post(`/api/commissioning/${wa}/issue-certificate`, 'mgrA');
    const b = await post(`/api/commissioning/${wb}/issue-certificate`, 'mgrB');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.certificate_number).toMatch(/^CERT-\d{4}-\d{4,}$/);
    expect(a.body.certificate_number).not.toBe(b.body.certificate_number);
    expect(existing.cert.has(a.body.certificate_number)).toBe(false);
  });

  it('concurrent issuance gives every certificate its own number', async () => {
    const wfs = await Promise.all(Array.from({ length: 6 }, (_, i) => signedOffWorkflow(i % 2 ? co.B : co.A, `cc${i}`)));
    const res = await Promise.all(wfs.map((id, i) => post(`/api/commissioning/${id}/issue-certificate`, i % 2 ? 'mgrB' : 'mgrA')));
    expect(res.map(r => r.status)).toEqual(Array(6).fill(200));
    expect(unique(res.map(r => r.body.certificate_number))).toBe(true);
  });

  it('the database refuses a duplicate certificate number', async () => {
    const { rows: [one] } = await pool.query(
      `SELECT certificate_number FROM commissioning_workflows WHERE company_id = $1 AND certificate_number IS NOT NULL LIMIT 1`, [co.A]);
    const w = await signedOffWorkflow(co.B, 'dupcert');
    await expect(pool.query(`UPDATE commissioning_workflows SET certificate_number = $1 WHERE id = $2`, [one.certificate_number, w]))
      .rejects.toThrow(/duplicate key|unique/i);
  });
});

// ── Warranties (WR-) — all three writers ────────────────────────────────────
describe('warranty numbers (WR-NNNNN)', () => {
  const wrBody = (k) => ({ serial_number: `${TAG}-${k}`, warranty_start: '2031-01-01', warranty_end: '2032-01-01' });

  it('lifecycle: two companies can each register their first warranty', async () => {
    const a = await post('/api/lifecycle/warranty', 'mgrA', wrBody('LA'));
    const b = await post('/api/lifecycle/warranty', 'mgrB', wrBody('LB'));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.warranty_number).toMatch(/^WR-\d{5,}$/);
    expect(a.body.warranty_number).not.toBe(b.body.warranty_number);
  });

  it('projects: both companies can add a project warranty', async () => {
    const a = await post(`/api/projects/projects/${prj.A}/warranties`, 'adminA', { serial_number: `${TAG}-PA` });
    const b = await post(`/api/projects/projects/${prj.B}/warranties`, 'adminB', { serial_number: `${TAG}-PB` });
    expect([a.status, b.status]).toEqual([201, 201]);
    // This endpoint's response does not include the number (unchanged API); read it.
    const { rows } = await pool.query(
      `SELECT warranty_number FROM warranty_registrations WHERE id = ANY($1::int[])`, [[a.body.id, b.body.id]]);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => /^WR-\d{5,}$/.test(r.warranty_number))).toBe(true);
    expect(unique(rows.map(r => r.warranty_number))).toBe(true);
  });

  it('commissioning: both companies can activate a warranty', async () => {
    const certified = async (company, key, equipment) => (await pool.query(
      `INSERT INTO commissioning_workflows (company_id, workflow_number, customer_name, scheduled_date, status,
                                            certificate_issued, certificate_number, equipment_id)
       VALUES ($1,$2,$3,'2031-01-15','completed',true,$2,$4) RETURNING id`,
      [company, `${TAG}-${key}`, `${TAG} ${key}`, equipment])).rows[0].id;
    const wa = await certified(co.A, 'wA', eq.A);
    const wb = await certified(co.B, 'wB', eq.B);
    const a = await post(`/api/commissioning/${wa}/activate-warranty`, 'mgrA', { warranty_months: 12 });
    const b = await post(`/api/commissioning/${wb}/activate-warranty`, 'mgrB', { warranty_months: 12 });
    expect([a.status, b.status]).toEqual([200, 200]);
    const { rows } = await pool.query(
      `SELECT warranty_number FROM warranty_registrations WHERE commissioning_workflow_id = ANY($1::int[])`, [[wa, wb]]);
    expect(rows).toHaveLength(2);
    expect(unique(rows.map(r => r.warranty_number))).toBe(true);
  });

  it('concurrent registrations across both companies get distinct numbers', async () => {
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      post('/api/lifecycle/warranty', i % 2 ? 'mgrB' : 'mgrA', wrBody(`cc${i}`))));
    expect(res.map(r => r.status)).toEqual(Array(10).fill(201));
    expect(unique(ids(res))).toBe(true);
  });

  it('never reuses a number that existed before', async () => {
    const { rows } = await pool.query(
      `SELECT warranty_number v FROM warranty_registrations WHERE company_id = ANY($1::int[])`, [[co.A, co.B]]);
    expect(rows.filter(r => existing.wr.has(r.v))).toEqual([]);
  });
});

// ── Claims (WC-) ────────────────────────────────────────────────────────────
describe('warranty claim numbers (WC-NNNNN)', () => {
  it('two companies can each raise their first claim', async () => {
    const a = await post('/api/lifecycle/warranty-claims', 'mgrA', { issue_description: `${TAG} A` });
    const b = await post('/api/lifecycle/warranty-claims', 'mgrB', { issue_description: `${TAG} B` });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.claim_number).toMatch(/^WC-\d{5,}$/);
    expect(a.body.claim_number).not.toBe(b.body.claim_number);
  });

  it('concurrent claims get distinct numbers', async () => {
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      post('/api/lifecycle/warranty-claims', i % 2 ? 'mgrB' : 'mgrA', { issue_description: `${TAG} c${i}` })));
    expect(res.map(r => r.status)).toEqual(Array(10).fill(201));
    expect(unique(ids(res))).toBe(true);
    expect(ids(res).filter(v => existing.wc.has(v))).toEqual([]);
  });
});

// ── A number already taken (old code mid-deploy, or typed by hand) is skipped ──
describe('a number that is already in use', () => {
  it('is skipped instead of failing the insert', async () => {
    const { rows: [st] } = await pool.query(`SELECT last_value, is_called FROM seq_wc`);
    const next = Number(st.last_value) + (st.is_called ? 1 : 0);
    const taken = `WC-${String(next).padStart(5, '0')}`;
    await pool.query(`INSERT INTO warranty_claims (claim_number, issue_description, company_id) VALUES ($1,$2,$3)`,
      [taken, `${TAG} pre-existing`, co.B]);
    const res = await post('/api/lifecycle/warranty-claims', 'mgrA', { issue_description: `${TAG} after taken` });
    expect(res.status).toBe(201);
    expect(res.body.claim_number).not.toBe(taken);
    expect(res.body.claim_number).toMatch(/^WC-\d{5,}$/);
  });
});

// ── Company isolation is unchanged ──────────────────────────────────────────
describe('company isolation', () => {
  it("each company still sees only its own numbered records", async () => {
    const a = await request(app).get('/api/commissioning').set('Authorization', as('mgrA'));
    expect(a.status).toBe(200);
    expect(a.body.every(w => w.company_id === co.A)).toBe(true);
    const claims = await request(app).get('/api/lifecycle/warranty-claims').set('Authorization', as('mgrB'));
    expect(claims.body.every(c => c.company_id === co.B)).toBe(true);
  });
});
