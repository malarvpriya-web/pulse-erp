/**
 * integration.procurementVendorSurface.test.js
 *
 * The vendor half of procurement — approval workflow, registration portal,
 * Vendor 360, vendor health, RFx scoring, sourcing strategy and the vendor
 * comparison reads — driven through the REAL routers against the REAL database.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Seven routers, ~65 routes, were mounted behind `verifyToken` and NOTHING
 * else. Any authenticated account — `employee`, `hr`, `sales_exec` — could add
 * bank details to any vendor in any company, approve a vendor registration,
 * award a sourcing event, clear a flagged invoice for payment, and read any
 * tenant's negotiated unit prices. The six routes that DID carry `allowRoles`
 * named four role codes that do not exist (`procurement`, `scm`, `quality`,
 * `director`), so those gates matched nobody they were meant for and let
 * everybody they were meant to exclude through the generic `manager` code.
 *
 * Authorization is the one property where a passing happy path proves nothing:
 * the test that matters is the one where the request is REFUSED, and then the
 * row is checked to confirm nothing was written anyway.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

const { default: pool }             = await import('../config/db.js');
const { default: vendorRoutes }     = await import('../modules/procurement/routes/vendor.routes.js');
const { default: approvalRoutes }   = await import('../modules/procurement/routes/vendor-approval.routes.js');
const { default: portalRoutes }     = await import('../modules/procurement/routes/vendor-portal.routes.js');
const { default: vendor360Routes }  = await import('../modules/procurement/routes/vendor360.routes.js');
const { default: healthRoutes }     = await import('../modules/procurement/routes/vendorHealth.routes.js');
const { default: rfxRoutes }        = await import('../modules/procurement/routes/rfx.routes.js');
const { default: sourcingRoutes }   = await import('../modules/procurement/routes/sourcing.routes.js');
const { default: regRoutes }        = await import('../modules/procurement/routes/vendor-registration.routes.js');
const { verifyToken }               = await import('../middlewares/auth.middleware.js');

const TAG  = 'ZZVS';
const CO_A = 1;
const CO_B = 999905;

/**
 * The routers under test mount `verifyToken` themselves, so this suite drives
 * the REAL authentication path rather than stubbing `req.user`: it signs a JWT
 * for an actual active account and lets verifyToken load that account's roles
 * from `user_roles`. Roles therefore come from the database, not from the test —
 * which is what makes a 403 here evidence about the deployment rather than about
 * the fixture. Only `company_id` is asserted by the token, which is the
 * documented fast path verifyToken honours ahead of the DB scope row.
 */
const app = (() => {
  const a = express();
  a.use(express.json());
  // Mirrors server.js exactly: vendor-approval and vendor-registration mount
  // verifyToken inside themselves; the rest have it applied at the mount, and
  // vendorRoutes gets it on the three prefixes it owns (the router itself is
  // mounted bare so it does not become a global auth gate).
  a.use('/api/vendor-approval',                    approvalRoutes);
  a.use('/api/vendor-portal',       verifyToken,   portalRoutes);
  a.use('/api/vendor-360',          verifyToken,   vendor360Routes);
  a.use('/api/vendor-health',       verifyToken,   healthRoutes);
  a.use('/api/rfx',                 verifyToken,   rfxRoutes);
  a.use('/api/sourcing-strategy',   verifyToken,   sourcingRoutes);
  a.use('/api/vendor-registration',                regRoutes);
  a.use(['/api/vendors', '/api/rfqs', '/api/three-way-match'], verifyToken);
  a.use('/api',                                    vendorRoutes);
  return a;
})();

/** role code -> a real, active users.id holding it. Filled in beforeAll. */
const actors = {};

function tokenFor(role, companyId = CO_A) {
  const u = actors[role];
  if (!u) throw new Error(`No active user holds the '${role}' role in this database — cannot test its gate.`);
  return jwt.sign(
    { userId: u.id, email: u.email, employee_id: u.employee_id, company_id: companyId, role },
    process.env.JWT_SECRET, { expiresIn: '10m' }
  );
}

/** supertest request pre-authenticated as a holder of `role`. */
function as(role, companyId = CO_A) {
  const t = tokenFor(role, companyId);
  const wrap = (verb) => (path) => request(app)[verb](path).set('Authorization', `Bearer ${t}`);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
}

const buyer      = () => as('procurement_manager');
const exec       = () => as('procurement_exec');   // add/edit, NOT approve
const salesRep   = () => as('sales_exec');         // no procurement grant at all
const genericMgr = () => as('manager');            // can_view = FALSE on procurement
const tenantB    = () => as('procurement_manager', CO_B);
const adminUser  = () => as('admin');

/**
 * Clear this IP's rate-limit window.
 *
 * `submitLimit` is a real control and stays in place; it is reset between the
 * portal assertions so they measure the portal's own behaviour rather than the
 * limiter's. A 429 from the limiter would mask whether the OTP was leaked.
 */
const clearRateLimit = () => pool.query(`DELETE FROM auth_rate_limit`).catch(() => {});

/** The public portal: no session at all. */
const publicApp = (() => {
  const app = express();
  app.use(express.json());
  app.use('/api/vendor-registration', regRoutes);
  return app;
})();

let vendorA, vendorB;

async function sweep() {
  const p = [`${TAG}%`];
  await pool.query(`DELETE FROM vendor_bank_details WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, p);
  await pool.query(`DELETE FROM vendor_contacts     WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, p);
  await pool.query(`DELETE FROM vendor_documents    WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, p);
  await pool.query(`DELETE FROM vendor_registrations WHERE vendor_name LIKE $1`, p);
  await pool.query(`UPDATE vendors SET party_id = NULL WHERE vendor_name LIKE $1`, p);
  await pool.query(`DELETE FROM parties WHERE name LIKE $1`, p);
  await pool.query(`DELETE FROM vendors WHERE vendor_name LIKE $1`, p);
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZVS foreign tenant', 'ZZVSF') ON CONFLICT (id) DO NOTHING`,
    [CO_B]
  );
  await sweep();

  // One real, active account per role the gates are asserted against. If a role
  // has no holder the suite fails loudly rather than passing vacuously — a 403
  // proves nothing if nobody could have been allowed through in the first place.
  for (const role of ['procurement_manager', 'procurement_exec', 'sales_exec', 'manager', 'admin']) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.employee_id
         FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE r.code = $1 AND u.is_active = true
        ORDER BY u.id DESC LIMIT 1`, [role]);
    // logout_at is deliberately NOT filtered: verifyToken revokes a token whose
    // `iat` predates it, and these are minted now, so a logged-out account still
    // authenticates with a fresh token — which is the real behaviour.
    if (rows[0]) actors[role] = rows[0];
  }
  const missing = ['procurement_manager', 'procurement_exec', 'sales_exec', 'manager', 'admin'].filter(r => !actors[r]);
  if (missing.length) throw new Error(`No active account holds: ${missing.join(', ')} — the authorization assertions would be vacuous.`);

  vendorA = (await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status, category) VALUES ($1,$2,'active','Raw Materials') RETURNING id`,
    [`${TAG} Supplier A`, CO_A])).rows[0].id;
  vendorB = (await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status, category) VALUES ($1,$2,'active','Raw Materials') RETURNING id`,
    [`${TAG} Supplier B`, CO_B])).rows[0].id;
});
afterAll(sweep);

// ═══════════════════════════════════════════════════════════════════════════
describe('the routers that had no authorization at all', () => {
  /**
   * Adding a bank account to a supplier is the destination of an invoice-fraud
   * attempt: change where the money goes, then wait for the next payment run.
   * It was reachable by any authenticated account.
   */
  it('refuses bank details from a caller with no procurement grant', async () => {
    const res = await salesRep()
      .post(`/api/vendor-approval/vendors/${vendorA}/banks`)
      .send({ bank_name: `${TAG} Fraud Bank`, account_number: '999999', ifsc: 'FRAU0000001' });
    expect(res.status).toBe(403);
    const { rows } = await pool.query(`SELECT id FROM vendor_bank_details WHERE vendor_id=$1`, [vendorA]);
    expect(rows).toHaveLength(0);
  });

  it('refuses bank details even from a buyer who cannot approve', async () => {
    // procurement_exec holds add/edit but not approve. Bank details are gated on
    // approve deliberately: an edit-level grant is for maintaining a vendor's
    // address, not for changing where its money goes.
    const res = await exec()
      .post(`/api/vendor-approval/vendors/${vendorA}/banks`)
      .send({ bank_name: `${TAG} Bank`, account_number: '111', ifsc: 'HDFC0000001' });
    expect(res.status).toBe(403);
  });

  it('refuses a vendor contact, an NCR, a CAPA and a risk score from an ungranted caller', async () => {
    const app = salesRep();
    const calls = [
      app.post(`/api/vendor-approval/vendors/${vendorA}/contacts`).send({ name: `${TAG} x` }),
      app.post('/api/vendor-approval/ncr').send({ vendor_id: vendorA, description: `${TAG}` }),
      app.post('/api/vendor-approval/capa').send({ vendor_id: vendorA, description: `${TAG}` }),
      app.post(`/api/vendor-approval/vendors/${vendorA}/risk`).send({ financial_risk: 1 }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
    const { rows } = await pool.query(`SELECT id FROM vendor_contacts WHERE vendor_id=$1`, [vendorA]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a Vendor 360 read and a scorecard write from an ungranted caller', async () => {
    const app = salesRep();
    const read  = await app.get(`/api/vendor-360/${vendorA}`);
    const write = await app.post(`/api/vendor-360/${vendorA}/scorecard`).send({ overall_score: 5 });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
  });

  it('refuses vendor-health recalculation and warning acknowledgement from an ungranted caller', async () => {
    const app = salesRep();
    expect((await app.post('/api/vendor-health/recalculate-all')).status).toBe(403);
    expect((await app.get('/api/vendor-health/dashboard')).status).toBe(403);
    expect((await app.patch('/api/vendor-health/warnings/1/acknowledge')).status).toBe(403);
  });

  it('refuses RFx scoring and preferred-vendor selection from an ungranted caller', async () => {
    const app = salesRep();
    expect((await app.post('/api/rfx/1/vendors/1/scores').send({ scores: [] })).status).toBe(403);
    expect((await app.post('/api/rfx/1/preferred-vendor').send({})).status).toBe(403);
  });

  it('refuses a sourcing strategy write from an ungranted caller', async () => {
    const res = await salesRep()
      .post('/api/sourcing-strategy/categories/electronics/strategy').send({ chosen_play: 'x' });
    expect(res.status).toBe(403);
  });

  it('refuses the vendor comparison reads from an ungranted caller', async () => {
    // These return a supplier's spend history and negotiated unit prices.
    const app = salesRep();
    expect((await app.get('/api/vendors')).status).toBe(403);
    expect((await app.get(`/api/vendors/compare?ids=${vendorA}`)).status).toBe(403);
    expect((await app.get(`/api/vendors/price-history?ids=${vendorA}`)).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the four phantom role codes', () => {
  /**
   * `allowRoles('admin','super_admin','procurement','scm','manager')` matched on
   * a code, and three of those five are not codes in `roles`. The gate therefore
   * excluded the procurement team whose review it is, and admitted the generic
   * `manager` — 8 accounts, `can_view = FALSE` on procurement — to every one of
   * the four approval stages.
   */
  it('no longer lets a generic manager approve a vendor registration', async () => {
    const { rows: [reg] } = await pool.query(
      `INSERT INTO vendor_registrations (vendor_name, email, phone, company_id, status)
       VALUES ($1,'zzvs@example.test','9990000000',$2,'Submitted') RETURNING id`,
      [`${TAG} Registration`, CO_A]
    );
    const res = await genericMgr()
      .put(`/api/vendor-approval/${reg.id}/scm-review`)
      .send({ decision: 'Approve', remarks: 'ok' });
    expect(res.status).toBe(403);
    const { rows } = await pool.query(`SELECT scm_reviewed_at FROM vendor_registrations WHERE id=$1`, [reg.id]);
    expect(rows[0].scm_reviewed_at).toBeNull();
  });

  it('does let the procurement team do the SCM review the phantom code locked them out of', async () => {
    const { rows: [reg] } = await pool.query(
      `INSERT INTO vendor_registrations (vendor_name, email, phone, company_id, status)
       VALUES ($1,'zzvs2@example.test','9990000001',$2,'Submitted') RETURNING id`,
      [`${TAG} Registration SCM`, CO_A]
    );
    const res = await buyer()
      .put(`/api/vendor-approval/${reg.id}/scm-review`)
      .send({ decision: 'Approve', remarks: 'verified' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT scm_reviewed_at FROM vendor_registrations WHERE id=$1`, [reg.id]);
    expect(rows[0].scm_reviewed_at).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('approval stage ordering', () => {
  it('refuses management approval on a registration nobody has reviewed', async () => {
    const { rows: [reg] } = await pool.query(
      `INSERT INTO vendor_registrations (vendor_name, email, phone, company_id, status)
       VALUES ($1,'zzvs3@example.test','9990000002',$2,'Submitted') RETURNING id`,
      [`${TAG} Registration Jump`, CO_A]
    );
    // Skipping straight to the end promoted a supplier into the vendor master
    // having passed none of the SCM, quality or finance checks.
    const res = await adminUser()
      .put(`/api/vendor-approval/${reg.id}/management-review`)
      .send({ decision: 'Approved', remarks: 'straight to the top' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVIEW_STAGE_OUT_OF_ORDER');
    expect(res.body.awaiting).toBe('scm');
    const { rows } = await pool.query(`SELECT vendor_id, mgmt_approved_at FROM vendor_registrations WHERE id=$1`, [reg.id]);
    expect(rows[0].mgmt_approved_at).toBeNull();
    expect(rows[0].vendor_id).toBeNull();
  });

  it('promotes an approved registration into a vendor WITH a finance party', async () => {
    const { rows: [reg] } = await pool.query(
      `INSERT INTO vendor_registrations
         (vendor_name, email, phone, company_id, status, scm_reviewed_at, quality_reviewed_at, finance_reviewed_at)
       VALUES ($1,'zzvs4@example.test','9990000003',$2,'Pending Management Review', NOW(), NOW(), NOW()) RETURNING id`,
      [`${TAG} Registration Full`, CO_A]
    );
    const res = await adminUser()
      .put(`/api/vendor-approval/${reg.id}/management-review`)
      .send({ decision: 'Approved', remarks: 'approved' });
    expect(res.status).toBe(200);

    const { rows: [after] } = await pool.query(`SELECT vendor_id FROM vendor_registrations WHERE id=$1`, [reg.id]);
    expect(after.vendor_id).toBeTruthy();
    // A vendor without a party cannot be paid: every AP document FKs parties(id).
    // This promotion path created the vendor row and stopped, so a supplier that
    // came through the FULL four-stage approval was less complete than one typed
    // straight into the internal form.
    const { rows: [v] } = await pool.query(`SELECT party_id FROM vendors WHERE id=$1`, [after.vendor_id]);
    expect(v.party_id).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('tenant isolation on the vendor surface', () => {
  it('will not read or review another tenant\'s registration', async () => {
    const { rows: [reg] } = await pool.query(
      `INSERT INTO vendor_registrations (vendor_name, email, phone, company_id, status)
       VALUES ($1,'zzvs5@example.test','9990000004',$2,'Submitted') RETURNING id`,
      [`${TAG} Registration Foreign`, CO_A]
    );
    const read   = await tenantB().get(`/api/vendor-approval/${reg.id}`);
    const review = await tenantB().put(`/api/vendor-approval/${reg.id}/scm-review`).send({ decision: 'Approve' });
    expect(read.status).toBe(404);
    expect(review.status).toBe(404);
    const { rows } = await pool.query(`SELECT scm_reviewed_at FROM vendor_registrations WHERE id=$1`, [reg.id]);
    expect(rows[0].scm_reviewed_at).toBeNull();
  });

  it('will not attach a bank account to another tenant\'s vendor', async () => {
    const res = await tenantB()
      .post(`/api/vendor-approval/vendors/${vendorA}/banks`)
      .send({ bank_name: `${TAG} X`, account_number: '1', ifsc: 'AAAA0000001' });
    expect(res.status).toBe(404);
    const { rows } = await pool.query(`SELECT id FROM vendor_bank_details WHERE vendor_id=$1`, [vendorA]);
    expect(rows).toHaveLength(0);
  });

  it('drops a foreign vendor id out of the comparison reads instead of answering with it', async () => {
    // `?ids=` went straight into `WHERE id IN (...)`, so a caller could read any
    // tenant's supplier profile, spend and unit prices by walking ids.
    const res = await buyer().get(`/api/vendors/compare?ids=${vendorA},${vendorB}`);
    expect(res.status).toBe(200);
    const names = (res.body.vendors || res.body || []).map(v => v.vendor_name);
    expect(names).toContain(`${TAG} Supplier A`);
    expect(names).not.toContain(`${TAG} Supplier B`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the removed shadow endpoints', () => {
  /**
   * Each of these was an ungated, unscoped duplicate of a hardened endpoint
   * under /api/procurement. 410 rather than a silent 404, so an unknown caller
   * is told where to go.
   */
  it.each([
    ['put',   `/api/vendors/1`,                    'PUT /api/procurement/vendors/:id'],
    ['post',  `/api/vendors`,                      'POST /api/procurement/vendors'],
    ['patch', `/api/three-way-match/1/resolve`,     'PATCH /api/procurement/three-way-match/:id/resolve'],
    ['put',   `/api/rfqs/1/quotes/1/winner`,        'PATCH /api/procurement/rfqs/:rfqId/award/:vendorId'],
  ])('%s %s is gone and names its replacement', async (verb, path, canonical) => {
    const res = await adminUser()[verb](path).send({});
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('ENDPOINT_REMOVED');
    expect(res.body.use).toBe(canonical);
  });

  it('the removed vendor update cannot change a supplier\'s bank details', async () => {
    const before = await pool.query(`SELECT account_number FROM vendors WHERE id=$1`, [vendorA]);
    await adminUser()
      .put(`/api/vendors/${vendorA}`)
      .send({ vendor_name: `${TAG} Supplier A`, bank_name: 'Fraud', account_number: '000000', ifsc: 'FRAU0000001' });
    const after = await pool.query(`SELECT account_number FROM vendors WHERE id=$1`, [vendorA]);
    expect(after.rows[0].account_number).toBe(before.rows[0].account_number);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the public registration portal', () => {
  it('never returns the verification code to the caller', async () => {
    await clearRateLimit();
    const res = await request(publicApp).post('/api/vendor-registration/submit').send({
      vendor_name: `${TAG} Public Reg`, email: 'zzvs-public@example.test', phone: '9990000005',
    });
    expect([201, 409]).toContain(res.status);
    if (res.status !== 201) return;

    // The OTP was returned whenever NODE_ENV was not 'production' — which it is
    // not, here. That does not weaken verification, it removes it: the submitter
    // reads their own code out of their own response.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/_dev_email_otp|_dev_mobile_otp|_dev_otp/);
    const { rows: [reg] } = await pool.query(
      `SELECT email_otp, mobile_otp FROM vendor_registrations WHERE id=$1`, [res.body.registration_id]);
    expect(body).not.toContain(reg.email_otp);
    expect(body).not.toContain(reg.mobile_otp);
  });

  it('ignores a company_id supplied by an anonymous caller', async () => {
    await clearRateLimit();
    const res = await request(publicApp).post('/api/vendor-registration/submit').send({
      vendor_name: `${TAG} Tenant Planting`, email: 'zzvs-plant@example.test', phone: '9990000006',
      company_id: CO_B,     // an attempt to land in someone else's approval queue
    });
    expect([201, 409]).toContain(res.status);
    if (res.status !== 201) return;
    const { rows: [reg] } = await pool.query(
      `SELECT company_id FROM vendor_registrations WHERE id=$1`, [res.body.registration_id]);
    expect(reg.company_id).not.toBe(CO_B);
  });

  it('locks the record after five wrong codes instead of allowing unlimited guesses', async () => {
    await clearRateLimit();
    const submit = await request(publicApp).post('/api/vendor-registration/submit').send({
      vendor_name: `${TAG} Bruteforce`, email: 'zzvs-brute@example.test', phone: '9990000007',
    });
    if (submit.status !== 201) return;
    const id = submit.body.registration_id;

    const codes = ['000000', '111111', '222222', '333333', '444444'];
    const seen = [];
    for (const otp of codes) {
      seen.push((await request(publicApp).post(`/api/vendor-registration/${id}/verify-email`).send({ otp })).status);
    }
    expect(seen.slice(0, 4).every(s => s === 400)).toBe(true);
    expect(seen[4]).toBe(429);

    // And the lock holds for the next attempt, correct code or not.
    const after = await request(publicApp).post(`/api/vendor-registration/${id}/verify-email`).send({ otp: '555555' });
    expect(after.status).toBe(429);
    const { rows: [reg] } = await pool.query(`SELECT email_verified FROM vendor_registrations WHERE id=$1`, [id]);
    expect(reg.email_verified).toBe(false);
  });

  it('will not hand out a registration\'s status to anyone who guesses its id', async () => {
    await clearRateLimit();
    const submit = await request(publicApp).post('/api/vendor-registration/submit').send({
      vendor_name: `${TAG} Status Probe`, email: 'zzvs-status@example.test', phone: '9990000008',
    });
    if (submit.status !== 201) return;
    const id = submit.body.registration_id;

    // A sequential integer with no session returned every registration in the
    // database, along with the internal SCM/quality/finance/management remarks.
    const withoutToken = await request(publicApp).get(`/api/vendor-registration/status/${id}`);
    expect(withoutToken.status).toBe(404);

    const withToken = await request(publicApp)
      .get(`/api/vendor-registration/status/${id}?token=${submit.body.access_token}`);
    expect(withToken.status).toBe(200);
    expect(withToken.body.id).toBe(id);
  });

  it('requires both channels verified before a registration is submitted', async () => {
    await clearRateLimit();
    const submit = await request(publicApp).post('/api/vendor-registration/submit').send({
      vendor_name: `${TAG} Finalize`, email: 'zzvs-final@example.test', phone: '9990000009',
    });
    if (submit.status !== 201) return;
    const id = submit.body.registration_id;
    // Email verified, mobile not: the mobile OTP was generated, stored and
    // verifiable, and then never required.
    await pool.query(`UPDATE vendor_registrations SET email_verified=true WHERE id=$1`, [id]);
    const res = await request(publicApp).post(`/api/vendor-registration/${id}/finalize`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Mobile not verified/i);
  });

  it('gates the internal registration list on the procurement grant', async () => {
    expect((await salesRep().get('/api/vendor-registration')).status).toBe(403);
    expect((await buyer().get('/api/vendor-registration')).status).toBe(200);
  });
});
