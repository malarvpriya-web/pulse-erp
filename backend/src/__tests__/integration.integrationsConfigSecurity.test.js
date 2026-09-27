/**
 * integration.integrationsConfigSecurity.test.js — PULSE-01 regression suite.
 *
 * Drives the REAL `integrations-config.routes.js` behind the REAL middleware
 * chain server.js mounts (verifyToken → auditMutations → router), against the
 * REAL database, with REAL role rows out of the permission matrix. Nothing about
 * authorization is stubbed: a stubbed `requirePermission` would make this suite
 * pass while the vulnerability was wide open, which is the exact false green
 * PULSE-01 slipped through the first time.
 *
 * WHAT IT PINS
 * ============
 * `PUT /api/integrations/config/:key` used to be mounted with `verifyToken`
 * alone and to write every key of the request body into `process.env`:
 *
 *     for (const [envKey, val] of Object.entries(creds))
 *       if (val && String(val).trim()) process.env[envKey] = String(val).trim();
 *
 * so any authenticated employee could set any variable in the process. The one
 * that matters is PERMISSION_FAIL_OPEN — auth.middleware.js reads it per REQUEST,
 * and 'true' makes requirePermission() pass for any module with no permission
 * row. Test 5 reproduces that escalation end to end (403 → still 403) rather
 * than merely asserting a 4xx on the write, because a 4xx that still mutated the
 * environment is the failure mode that matters and the status code cannot see it.
 *
 * ⚠⚠ EVERY NEGATIVE IS PAIRED WITH A POSITIVE. Test 3 and Test 10 assert that an
 * authorized admin still succeeds and that a saved credential is still readable
 * by the code that consumes it. Without them this whole file passes just as
 * happily when the endpoint is broken for everyone — and "secure because it is
 * dead" has shipped in this repo before.
 *
 * ⚠ The write assertions check the DATABASE and the process ENVIRONMENT, not just
 * the response body.
 *
 * SELF-CLEANING: sweep() runs on the way IN as well as OUT. A suite that only
 * tidies up afterwards leaks its companies the moment an assertion throws, and
 * because `companies.code` is UNIQUE that leak then fails every LATER run at
 * INSERT time — which reads as a broken suite rather than a stale row. Rows are
 * deleted by EXACT code, never by `LIKE 'prefix%'`: a prefix sweep eats a sibling
 * tag (ZZP01 would swallow ZZP01X) and this repo has had that bug too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
process.env.JWT_SECRET ||= 'test_jwt_secret_for_pulse_enterprise_audit_2026';

const { default: pool }       = await import('../config/db.js');
const { verifyToken, requirePermission } = await import('../middlewares/auth.middleware.js');
const { auditMutations }      = await import('../middlewares/auditMutations.js');
const { denialLogger }        = await import('../middlewares/denialLogger.js');
const { default: cfgRouter }  = await import('../modules/integrations/integrations-config.routes.js');
const {
  readStored, resolveConfig, INTEGRATION_FIELDS, FORBIDDEN_FIELD_NAMES, assertAllowlistIsSafe,
} = await import('../modules/integrations/integrationConfig.js');
const { default: tallyRouter }      = await import('../modules/integrations/tally.routes.js');
const { default: emailRouter }      = await import('../modules/integrations/email.routes.js');
const { default: whatsappRouter }   = await import('../modules/integrations/whatsapp.routes.js');
const { default: zohoBooksRouter }  = await import('../modules/integrations/zoho-books.routes.js');
const { default: settingsRouter } = await import('../modules/admin/settings-status.routes.js');

// Exact codes, so the sweep can use `IN (...)` instead of a prefix match.
const CODE_A = 'ZZPULSE01A';
const CODE_B = 'ZZPULSE01B';
const CODES  = [CODE_A, CODE_B];

/**
 * The app EXACTLY as server.js:903 mounts it.
 *
 * The authorization gate lives inside the router, so building the chain here
 * rather than trusting the mount is what proves the gate travels with the router.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  // denialLogger is mounted app-wide at server.js:540, ahead of every router, so
  // it belongs in this chain too — it is what records the 403s below.
  app.use(denialLogger);
  app.use('/api/integrations/config', verifyToken, auditMutations('admin'), cfgRouter);
  // Stands in for the ~76 privileged routes that sit behind the matrix. The
  // module is deliberately unseeded so requirePermission must FAIL CLOSED —
  // which is precisely what PERMISSION_FAIL_OPEN=true used to undo.
  app.get('/probe', verifyToken, requirePermission('zzunseeded', 'edit'), (_q, s) => s.json({ ok: true }));
  // The two ALIAS paths that write the same tally_config row, mounted as
  // server.js:858 and :771 mount them. Both are covered below: gating one and
  // leaving the other open would be no fix at all.
  app.use('/api/integrations/tally', verifyToken, auditMutations('finance'), tallyRouter);
  app.use('/api/settings', verifyToken, auditMutations('settings'), settingsRouter);
  return app;
}

const ids = { companyA: null, companyB: null, empA: null, adminA: null, adminB: null };
let app;
const token = (userId, companyId) =>
  jwt.sign({ userId, company_id: companyId }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = ANY($1)`, [CODES]);
  for (const { id } of rows) {
    await pool.query(`DELETE FROM company_integrations WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM tally_config WHERE company_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]);
    await pool.query(`DELETE FROM access_denials WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]).catch(() => {});
    await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]);
    await pool.query(`DELETE FROM user_scope WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]).catch(() => {});
    // ⚠⚠ interview_questions holds an FK to companies and `talent.routes.js` seeds
    // TEN ROWS INTO EVERY COMPANY at import time — so another suite importing that
    // router in the same worker plants them in these test companies without this
    // suite touching recruitment at all. The company DELETE below then fails the FK.
    //
    // That is why this only broke in a FULL RUN and passed in isolation, and why it
    // reads as "the suite is broken" rather than "the sweep needs one more table".
    // Same convention as integration.crmCustomerIntegrity.test.js.
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [id]);
  }
}

async function makeCompany(code) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`PULSE-01 ${code}`, code]);
  return rows[0].id;
}

/** A user holding exactly one real role out of the permission matrix. */
async function makeUser(companyId, localPart, roleCode) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active)
     VALUES ($1, $2, 'not-a-real-hash', $3, true) RETURNING id`,
    [`PULSE-01 ${localPart}`, `zzpulse01.${localPart}@test.invalid`, companyId]);
  const userId = rows[0].id;
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  if (!role.length) throw new Error(`role '${roleCode}' is missing from the matrix — this suite needs it`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, role[0].id]);
  return userId;
}

/** Whole-environment snapshot, for proving nothing mutated it. */
const envSnapshot = () => JSON.stringify(Object.entries(process.env).sort());

beforeAll(async () => {
  await sweep();
  ids.companyA = await makeCompany(CODE_A);
  ids.companyB = await makeCompany(CODE_B);
  ids.empA     = await makeUser(ids.companyA, 'employee', 'employee');
  ids.adminA   = await makeUser(ids.companyA, 'admin-a',  'admin');
  ids.adminB   = await makeUser(ids.companyB, 'admin-b',  'admin');
  app = buildApp();
}, 60_000);

// Never pool.end() — the pool is shared across this worker's suites, and ending
// it silently skips every test in the files that run after this one.
afterAll(async () => { await sweep(); }, 60_000);

describe('PULSE-01 — integration configuration authorization', () => {
  // ── TEST 1 ──────────────────────────────────────────────────────────────────
  it('TEST 1: an ordinary authenticated employee cannot update integration configuration', async () => {
    const res = await request(app)
      .put('/api/integrations/config/smtp')
      .set('Authorization', `Bearer ${token(ids.empA, ids.companyA)}`)
      .send({ SMTP_HOST: 'attacker.example.com', SMTP_USER: 'evil@attacker.test' });

    expect(res.status).toBe(403);

    // The response is not the evidence — the row is.
    const stored = await readStored(ids.companyA, 'smtp');
    expect(stored).toEqual({});
  });

  // ── TEST 2 ──────────────────────────────────────────────────────────────────
  it('TEST 2: a user without integration-management permission cannot update credentials, and cannot read them either', async () => {
    const auth = `Bearer ${token(ids.empA, ids.companyA)}`;

    const write = await request(app).put('/api/integrations/config/razorpay').set('Authorization', auth)
      .send({ RAZORPAY_KEY_ID: 'rzp_live_attacker', RAZORPAY_KEY_SECRET: 'attacker-secret' });
    expect(write.status).toBe(403);

    // Reads are gated too: a credential store that lists which providers a
    // tenant uses is reconnaissance even when the values are masked.
    for (const path of ['/api/integrations/config/all', '/api/integrations/config/razorpay']) {
      const read = await request(app).get(path).set('Authorization', auth);
      expect(read.status).toBe(403);
    }

    expect(await readStored(ids.companyA, 'razorpay')).toEqual({});
  });

  // ── TEST 3 — THE PAIRED POSITIVE ────────────────────────────────────────────
  it('TEST 3: an authorized integration administrator can update permitted tenant configuration', async () => {
    const res = await request(app)
      .put('/api/integrations/config/smtp')
      .set('Authorization', `Bearer ${token(ids.adminA, ids.companyA)}`)
      .send({ SMTP_HOST: 'smtp.company-a.test', SMTP_PORT: '587', SMTP_USER: 'ops@company-a.test', SMTP_PASS: 'a-real-password', SMTP_SECURE: 'true' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'connected', key: 'smtp' });

    const stored = await readStored(ids.companyA, 'smtp');
    expect(stored.SMTP_HOST).toBe('smtp.company-a.test');
    expect(stored.SMTP_PASS).toBe('a-real-password');   // stored, encrypted at rest
    expect(stored.SMTP_PORT).toBe('587');
  });

  // ── TEST 4 ──────────────────────────────────────────────────────────────────
  it("TEST 4: company B's administrator cannot reach or modify company A's configuration", async () => {
    const authB = `Bearer ${token(ids.adminB, ids.companyB)}`;

    // B is a full admin — permission is not scope. B must be confined to B.
    const read = await request(app).get('/api/integrations/config/smtp').set('Authorization', authB);
    expect(read.status).toBe(200);
    expect(read.body.credentials).toEqual({});            // B has configured nothing
    expect(read.body.status).toBe('not_configured');

    // Naming another company is refused outright, not silently ignored.
    for (const body of [
      { company_id: ids.companyA, SMTP_HOST: 'hijack.test' },
      { companyId: ids.companyA, SMTP_HOST: 'hijack.test' },
    ]) {
      const res = await request(app).put('/api/integrations/config/smtp').set('Authorization', authB).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COMPANY_SCOPE_NOT_ACCEPTED');
    }
    const viaQuery = await request(app)
      .put(`/api/integrations/config/smtp?company_id=${ids.companyA}`)
      .set('Authorization', authB).send({ SMTP_HOST: 'hijack.test' });
    expect(viaQuery.status).toBe(400);

    // A legitimate write by B lands on B and leaves A untouched.
    const ownWrite = await request(app).put('/api/integrations/config/smtp').set('Authorization', authB)
      .send({ SMTP_HOST: 'smtp.company-b.test', SMTP_USER: 'ops@company-b.test' });
    expect(ownWrite.status).toBe(200);

    expect((await readStored(ids.companyB, 'smtp')).SMTP_HOST).toBe('smtp.company-b.test');
    expect((await readStored(ids.companyA, 'smtp')).SMTP_HOST).toBe('smtp.company-a.test');

    // And each tenant resolves its OWN host. Under the old process.env design
    // both of these returned whichever company saved last.
    expect((await resolveConfig(ids.companyA, 'smtp')).SMTP_HOST).toBe('smtp.company-a.test');
    expect((await resolveConfig(ids.companyB, 'smtp')).SMTP_HOST).toBe('smtp.company-b.test');
  });

  // ── TEST 5 — THE ORIGINAL VULNERABILITY ─────────────────────────────────────
  it('TEST 5: arbitrary environment variables cannot be set, and the RBAC escalation no longer lands', async () => {
    const authEmp   = `Bearer ${token(ids.empA, ids.companyA)}`;
    const authAdmin = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const before    = envSnapshot();

    // The escalation is only meaningful if the gate is shut to begin with.
    const probeBefore = await request(app).get('/probe').set('Authorization', authEmp);
    expect(probeBefore.status).toBe(403);
    expect(probeBefore.body.code).toBe('PERMISSION_NOT_CONFIGURED');

    // As the employee (denied on authorization) …
    const asEmployee = await request(app).put('/api/integrations/config/smtp').set('Authorization', authEmp)
      .send({ PERMISSION_FAIL_OPEN: 'true' });
    expect(asEmployee.status).toBe(403);

    // … and as a fully authorized admin (denied on schema). Both matter: the
    // second is the one that proves an allowlist, not just a permission gate.
    const asAdmin = await request(app).put('/api/integrations/config/smtp').set('Authorization', authAdmin)
      .send({ PERMISSION_FAIL_OPEN: 'true', NODE_ENV: 'development', JWT_SECRET: 'attacker', ENCRYPTION_KEY: 'attacker' });
    expect(asAdmin.status).toBe(400);
    expect(asAdmin.body.code).toBe('UNKNOWN_FIELD');
    expect(asAdmin.body.unknown_fields.sort()).toEqual(
      ['ENCRYPTION_KEY', 'JWT_SECRET', 'NODE_ENV', 'PERMISSION_FAIL_OPEN']);

    // NOT A SINGLE VARIABLE CHANGED — the whole environment, not just the four.
    expect(envSnapshot()).toBe(before);
    expect(process.env.PERMISSION_FAIL_OPEN).toBeUndefined();

    // And the gate is still shut. This is the assertion that would have caught
    // PULSE-01; a status-code check alone would not.
    const probeAfter = await request(app).get('/probe').set('Authorization', authEmp);
    expect(probeAfter.status).toBe(403);
  });

  // ── TEST 6 ──────────────────────────────────────────────────────────────────
  it('TEST 6: security-sensitive global configuration is not reachable through this tenant API at all', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const before = envSnapshot();

    // Not a sample — every name the tripwire list guards, through every
    // integration key, as the most privileged tenant role there is.
    for (const key of Object.keys(INTEGRATION_FIELDS)) {
      const res = await request(app).put(`/api/integrations/config/${key}`).set('Authorization', auth)
        .send(Object.fromEntries(FORBIDDEN_FIELD_NAMES.map((n) => [n, 'attacker-value'])));
      expect(res.status, `${key} accepted process-wide configuration`).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_FIELD');
    }

    expect(envSnapshot()).toBe(before);

    // Structural, not just behavioural: the allowlist can never grow a field
    // that shares a name with process-wide configuration.
    expect(() => assertAllowlistIsSafe()).not.toThrow();
    const guarded = new Set(FORBIDDEN_FIELD_NAMES);
    for (const [key, fields] of Object.entries(INTEGRATION_FIELDS)) {
      for (const field of Object.keys(fields)) {
        expect(guarded.has(field), `${key}.${field} collides with infrastructure config`).toBe(false);
      }
    }
  });

  // ── TEST 7 ──────────────────────────────────────────────────────────────────
  it('TEST 7: unexpected configuration fields are rejected, and a field from another integration is not accepted', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;

    const madeUp = await request(app).put('/api/integrations/config/smtp').set('Authorization', auth)
      .send({ SMTP_HOST: 'smtp.company-a.test', TOTALLY_MADE_UP_FIELD: 'x' });
    expect(madeUp.status).toBe(400);
    expect(madeUp.body.unknown_fields).toContain('TOTALLY_MADE_UP_FIELD');

    // Cross-integration: a real field name, wrong integration. The allowlist is
    // per integration, not one flat set.
    const wrongKey = await request(app).put('/api/integrations/config/smtp').set('Authorization', auth)
      .send({ RAZORPAY_KEY_SECRET: 'nope' });
    expect(wrongKey.status).toBe(400);
    expect(wrongKey.body.unknown_fields).toContain('RAZORPAY_KEY_SECRET');

    // An unknown integration key is a 404, not a new row.
    const unknownKey = await request(app).put('/api/integrations/config/not-an-integration')
      .set('Authorization', auth).send({ SMTP_HOST: 'x.test' });
    expect(unknownKey.status).toBe(404);

    // A rejected request is atomic: the valid field in the first body was NOT
    // written alongside the rejection.
    expect((await readStored(ids.companyA, 'smtp')).SMTP_HOST).toBe('smtp.company-a.test'); // TEST 3's value, unchanged
  });

  // ── TEST 8 ──────────────────────────────────────────────────────────────────
  it('TEST 8: invalid configuration values fail validation', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const cases = [
      ['smtp',     { SMTP_PORT: 'not-a-port' },                       'SMTP_PORT'],
      ['smtp',     { SMTP_PORT: '99999' },                            'SMTP_PORT'],
      ['smtp',     { SMTP_SECURE: 'banana' },                         'SMTP_SECURE'],
      ['smtp',     { SMTP_FROM: 'not-an-email' },                     'SMTP_FROM'],
      // A scheme or credentials in a host field redirects the connection
      // somewhere the field name does not suggest.
      ['smtp',     { SMTP_HOST: 'http://evil.test/path' },            'SMTP_HOST'],
      ['smtp',     { SMTP_HOST: 'user:pass@evil.test' },              'SMTP_HOST'],
      ['tally',    { TALLY_GATEWAY_URL: 'file:///etc/passwd' },       'TALLY_GATEWAY_URL'],
      ['tally',    { TALLY_GATEWAY_URL: 'http://u:p@gw.test' },       'TALLY_GATEWAY_URL'],
      ['zoho-sign',{ ZOHO_SIGN_DC: 'XX' },                            'ZOHO_SIGN_DC'],
      ['sendgrid', { SENDGRID_FROM_EMAIL: 'bad@@example' },           'SENDGRID_FROM_EMAIL'],
      // Objects and arrays must not be coerced — String({}) is '[object Object]'.
      ['smtp',     { SMTP_HOST: { toString: 'x' } },                  'SMTP_HOST'],
      ['smtp',     { SMTP_HOST: ['a.test', 'b.test'] },               'SMTP_HOST'],
    ];

    for (const [key, body, field] of cases) {
      const res = await request(app).put(`/api/integrations/config/${key}`).set('Authorization', auth).send(body);
      expect(res.status, `${key} ${field}=${JSON.stringify(Object.values(body)[0])} was accepted`).toBe(400);
      expect(res.body.code).toBe('INVALID_VALUE');
      expect(res.body.invalid_fields.map((i) => i.field)).toContain(field);
    }

    // Nothing above changed the stored row.
    expect((await readStored(ids.companyA, 'smtp')).SMTP_HOST).toBe('smtp.company-a.test');
  });

  // ── TEST 9 ──────────────────────────────────────────────────────────────────
  it('TEST 9: credential values never appear in API responses or in the audit log', async () => {
    const auth   = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const SECRET = 'sk-pulse01-canary-must-never-appear';

    const save = await request(app).put('/api/integrations/config/sendgrid').set('Authorization', auth)
      .send({ SENDGRID_API_KEY: SECRET, SENDGRID_FROM_EMAIL: 'no-reply@company-a.test' });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain(SECRET);

    // It really was stored — otherwise "not in the response" is trivially true.
    expect((await readStored(ids.companyA, 'sendgrid')).SENDGRID_API_KEY).toBe(SECRET);

    // GET masks the secret and leaves the non-secret field readable, so the form
    // can still show the operator which sender address is configured.
    const read = await request(app).get('/api/integrations/config/sendgrid').set('Authorization', auth);
    expect(read.status).toBe(200);
    expect(read.body.credentials.SENDGRID_API_KEY).toBe('***');
    expect(read.body.credentials.SENDGRID_FROM_EMAIL).toBe('no-reply@company-a.test');
    expect(JSON.stringify(read.body)).not.toContain(SECRET);

    const all = await request(app).get('/api/integrations/config/all').set('Authorization', auth);
    expect(JSON.stringify(all.body)).not.toContain(SECRET);

    // The audit trail records WHICH fields changed, never their values. An audit
    // log holding credentials is a liability rather than a control.
    const { rows } = await pool.query(
      `SELECT new_data_json::text AS payload FROM audit_logs WHERE user_id = $1`, [ids.adminA]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload ?? '').not.toContain(SECRET);

    // Find THIS integration's entry — the admin has earlier smtp entries too,
    // and matching only on 'changed_fields' picks whichever came first.
    const changeEntry = rows.find((r) => (r.payload ?? '').includes('"integration": "sendgrid"'));
    expect(changeEntry, 'no audit entry recorded the sendgrid config change').toBeDefined();
    expect(changeEntry.payload).toContain('SENDGRID_API_KEY');   // the NAME is recorded
    expect(changeEntry.payload).not.toContain(SECRET);           // never the value
  });

  // ── TEST 10 — THE PAIRED POSITIVE ───────────────────────────────────────────
  it('TEST 10: legitimate integration operations still work — a saved credential reaches the code that consumes it', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;

    // The masked sentinel round-trips: submitting '***' back from the form must
    // preserve the stored secret, not blank it.
    const roundTrip = await request(app).put('/api/integrations/config/sendgrid').set('Authorization', auth)
      .send({ SENDGRID_API_KEY: '***', SENDGRID_FROM_NAME: 'Company A Billing' });
    expect(roundTrip.status).toBe(200);

    const stored = await readStored(ids.companyA, 'sendgrid');
    expect(stored.SENDGRID_API_KEY).toBe('sk-pulse01-canary-must-never-appear');
    expect(stored.SENDGRID_FROM_NAME).toBe('Company A Billing');

    // resolveConfig() is what every consumer (whatsapp / email / payment /
    // zoho-* / tally) now calls, so this is the end-to-end proof that a saved
    // credential is actually usable without any process.env write.
    const effective = await resolveConfig(ids.companyA, 'sendgrid');
    expect(effective.SENDGRID_API_KEY).toBe('sk-pulse01-canary-must-never-appear');
    expect(effective.SENDGRID_FROM_EMAIL).toBe('no-reply@company-a.test');

    // Status reporting is per tenant: A is connected, B configured nothing.
    const statusA = await request(app).get('/api/integrations/config/all').set('Authorization', auth);
    expect(statusA.body.sendgrid.status).toBe('Connected');
    const statusB = await request(app).get('/api/integrations/config/all')
      .set('Authorization', `Bearer ${token(ids.adminB, ids.companyB)}`);
    expect(statusB.body.sendgrid.status).toBe('Not Configured');
  });

  // ── Alias paths ─────────────────────────────────────────────────────────────
  it('closes BOTH alias paths to the Tally gateway configuration', async () => {
    const authEmp   = `Bearer ${token(ids.empA, ids.companyA)}`;
    const authAdmin = `Bearer ${token(ids.adminA, ids.companyA)}`;

    const writes = [
      ['put',  '/api/integrations/tally/config'],
      ['post', '/api/settings/tally'],
    ];

    // Negative: an ordinary employee cannot repoint the outbound gateway by
    // either route.
    for (const [method, path] of writes) {
      const res = await request(app)[method](path).set('Authorization', authEmp)
        .send({ tally_url: 'http://attacker.example.com:9000' });
      expect(res.status, `${method.toUpperCase()} ${path} was not gated`).toBe(403);
    }
    const { rows: untouched } = await pool.query(
      `SELECT tally_url FROM tally_config WHERE company_id = $1`, [ids.companyA]);
    expect(untouched.length).toBe(0);

    // Both reject the same invalid URLs, so the two entry points cannot disagree
    // about what a legal gateway is.
    for (const [method, path] of writes) {
      for (const bad of ['file:///etc/passwd', 'http://user:pass@gw.test', 'not a url']) {
        const res = await request(app)[method](path).set('Authorization', authAdmin).send({ tally_url: bad });
        expect(res.status, `${method.toUpperCase()} ${path} accepted ${bad}`).toBe(400);
        expect(res.body.code).toBe('INVALID_VALUE');
      }
    }

    // Positive: the authorized admin can still save through both, and the value
    // lands on the row.
    for (const [i, [method, path]] of writes.entries()) {
      const url = `http://tally-${i}.company-a.test:9000`;
      const res = await request(app)[method](path).set('Authorization', authAdmin)
        .send({ tally_url: url, company_name: 'Company A' });
      expect(res.status, `${method.toUpperCase()} ${path} failed for an authorized admin`).toBe(200);
      const { rows } = await pool.query(
        `SELECT tally_url FROM tally_config WHERE company_id = $1`, [ids.companyA]);
      expect(rows[0]?.tally_url).toBe(url);
    }

    // And the finance role that can reach the page can still READ it — the gate
    // must not 403 the role the page exists for.
    const financeUser = await makeUser(ids.companyA, 'finance', 'finance_manager');
    for (const path of ['/api/integrations/tally/config', '/api/settings/tally']) {
      const res = await request(app).get(path)
        .set('Authorization', `Bearer ${token(financeUser, ids.companyA)}`);
      expect(res.status, `GET ${path} 403'd finance_manager`).toBe(200);
      expect(res.body.tally_url).toContain('company-a.test');
    }
  });

  // ── The fallback must not route around the gate ─────────────────────────────
  it('closes the per-provider status endpoints the UI falls back to on a 403', async () => {
    // ⚠⚠ THIS WAS A HOLE IN THE PULSE-01 GATE ITSELF, found in review.
    // `IntegrationsHub.jsx` catches a 403 from `/integrations/config/all` and then
    // calls seven per-provider status endpoints instead. All seven were ungated,
    // so an ordinary employee could still enumerate which providers a tenant uses
    // — and read the SMTP host and port and the SendGrid account email. Gating the
    // credential endpoints while leaving these open made the gate cosmetic for
    // exactly the reconnaissance §2 listed as a defect.
    const app2 = express();
    app2.use(express.json());
    app2.use(denialLogger);
    app2.use('/api/integrations', verifyToken, emailRouter);
    app2.use('/api/integrations/whatsapp', verifyToken, whatsappRouter);
    app2.use('/api/integrations/zoho-books', verifyToken, zohoBooksRouter);
    app2.use('/api/integrations/tally', verifyToken, tallyRouter);

    const employee = `Bearer ${token(ids.empA, ids.companyA)}`;
    const admin    = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const paths = [
      '/api/integrations/sendgrid/status',
      '/api/integrations/aws-ses/status',
      '/api/integrations/smtp/status',
      '/api/integrations/whatsapp/status',
      '/api/integrations/zoho-books/status',
      '/api/integrations/tally/sync-status',
    ];

    for (const path of paths) {
      const res = await request(app2).get(path).set('Authorization', employee);
      expect(res.status, `${path} is still reachable by an employee`).toBe(403);
      // And nothing leaked on the way to the refusal.
      expect(JSON.stringify(res.body)).not.toMatch(/smtp\.|sendgrid|@/i);
    }

    // PAIRED POSITIVE — the roles that legitimately reach these pages still can.
    // `settings:view` is held by admin and by finance_manager, and gating at
    // `admin:view` instead would 403 the finance role the Tally page exists for.
    //
    // ⚠ ASSERTS "NOT REFUSED", NOT "200". Three of these handlers make an OUTBOUND
    // call when configured — `/sendgrid/status` reaches api.sendgrid.com and
    // `/tally/sync-status` dials the gateway with a 3s timeout. Pinning 200 would
    // couple an authorization test to whether a third party is reachable from the
    // test machine, which is how a security test starts failing for reasons that
    // have nothing to do with security. The property under test is that the GATE
    // admits these roles.
    for (const path of paths) {
      const res = await request(app2).get(path).set('Authorization', admin);
      expect(res.status, `${path} now refuses an authorized admin`).not.toBe(403);
      expect(res.status, `${path} rejected the admin's token`).not.toBe(401);
    }
    const finance = await makeUser(ids.companyA, 'fin-status', 'finance_manager');
    const asFinance = await request(app2).get('/api/integrations/tally/sync-status')
      .set('Authorization', `Bearer ${token(finance, ids.companyA)}`);
    expect(asFinance.status, 'finance_manager was locked out of the Tally page it owns').not.toBe(403);
    // …and the timeout is explicit because that outbound dial is seconds, not
    // milliseconds, under four-worker contention. vitest's 5s default made this
    // test flaky on its first full run.
  }, 45_000);

  // ── Denials are recorded ────────────────────────────────────────────────────
  it('records the denied privileged-configuration attempts in access_denials', async () => {
    // Tests 1, 2 and 5 already generated denials for this user. denialLogger is
    // fire-and-forget via queueMicrotask, so give the writes a turn to land
    // before reading — polling rather than a fixed sleep, because a bare sleep
    // either flakes under worker contention or slows every run down.
    let rows = [];
    for (let attempt = 0; attempt < 40 && rows.length === 0; attempt++) {
      ({ rows } = await pool.query(
        `SELECT method, path, code, status FROM access_denials
          WHERE user_id = $1 AND path LIKE '%/integrations/config%'`, [ids.empA]));
      if (!rows.length) await new Promise((r) => setTimeout(r, 50));
    }

    expect(rows.length, 'no denial was recorded for the refused config writes').toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 403)).toBe(true);
    expect(rows.some((r) => r.method === 'PUT')).toBe(true);
    // The code distinguishes "the matrix said no" from "the matrix has no
    // opinion", and those want opposite fixes.
    expect(rows.some((r) => r.code === 'PERMISSION_DENIED')).toBe(true);
  });

  // ── Unauthenticated ─────────────────────────────────────────────────────────
  it('rejects unauthenticated and malformed-token requests before reaching the handler', async () => {
    const before = envSnapshot();
    for (const headers of [{}, { Authorization: 'Bearer not-a-jwt' }, { Authorization: 'Basic YWRtaW46eA==' }]) {
      const res = await request(app).put('/api/integrations/config/smtp').set(headers)
        .send({ SMTP_HOST: 'anon.test', PERMISSION_FAIL_OPEN: 'true' });
      expect(res.status).toBe(401);
    }
    expect(envSnapshot()).toBe(before);
  });
});

describe('PULSE-01 — no code path writes process.env from a request', () => {
  /**
   * A source-level assertion, because the behavioural tests above can only cover
   * the paths they know about. `applyToEnv` was one function in one file; the next
   * one would be somewhere else. This fails on the pattern, wherever it appears.
   */
  it('the backend contains no dynamic process.env assignment outside tests', async () => {
    const { readdirSync, statSync, readFileSync: read } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = resolve(here, '..');

    const offenders = [];
    const DYNAMIC = /process\.env\s*\[[^\]]+\]\s*=(?!=)/;
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!entry.endsWith('.js')) continue;
        const text = read(full, 'utf8');
        // Strip block and line comments so the historical account in
        // integrationConfig.js's header does not read as live code.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (DYNAMIC.test(code)) offenders.push(full.slice(srcRoot.length + 1));
      }
    };
    walk(srcRoot);

    expect(offenders, `dynamic process.env assignment found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every integration consumer resolves credentials per tenant rather than from the environment', async () => {
    const { readFileSync: read } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(here, '../modules/integrations');

    // Tenant-facing credential reads must go through resolveConfig(). The
    // exceptions are listed explicitly rather than allowed by omission:
    //   whatsapp.routes.js  — WHATSAPP_VERIFY_TOKEN, used by Meta's
    //     unauthenticated webhook handshake, where there is no tenant to resolve.
    const EXPECTED_ENV_READS = { 'whatsapp.routes.js': ['WHATSAPP_VERIFY_TOKEN'] };
    const CREDENTIAL_PREFIXES = /process\.env\.(WHATSAPP|SENDGRID|AWS_SES|SMTP|RAZORPAY|TALLY|ZOHO_BOOKS|ZOHO_SIGN)_[A-Z_]+/g;

    const unexpected = [];
    for (const file of ['whatsapp.routes.js', 'email.routes.js', 'payment.routes.js',
                        'tally.routes.js', 'zoho-books.routes.js', 'zoho-sign.routes.js']) {
      const code = read(resolve(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const allowed = EXPECTED_ENV_READS[file] ?? [];
      for (const match of code.match(CREDENTIAL_PREFIXES) ?? []) {
        const name = match.replace('process.env.', '');
        if (!allowed.includes(name)) unexpected.push(`${file}: ${name}`);
      }
    }

    expect(unexpected, `these read a credential from the environment instead of the tenant's row: ${unexpected.join(', ')}`).toEqual([]);
  });
});
