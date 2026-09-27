/**
 * integration.pulse01Followups.test.js — the nine risks PULSE-01 left open.
 *
 * The PULSE-01 remediation closed the reported vulnerability and listed what it
 * did NOT close. This suite covers those, each against the real router, the real
 * middleware chain and the real database.
 *
 *   §12.1  `POST /settings/:module` was a GENERIC ungated arbitrary-JSON writer
 *          over `company_settings` for any module name, reachable by every
 *          authenticated user — and `/settings/integrations` was a PLAINTEXT
 *          credential sink whose GET returned secrets unmasked.
 *   §12.2  `publicSign.routes.js` read `process.env.RAZORPAY_*` on a public
 *          payment route although `document_signings.company_id` names the tenant.
 *   §12.3  `mailer` / `emailTrigger` / `journeyEngine` were deployment-only.
 *   §12.4  Webhook signature verification FAILED OPEN — two different ways.
 *   §12.5  `ENCRYPTION_KEY` had no strength floor and a published dev fallback.
 *   §12.6  A key rotation made every credential silently read as "not configured".
 *
 * ⚠⚠ EVERY NEGATIVE IS PAIRED WITH A POSITIVE, for the reason the PULSE-01 suite
 * gives: an isolation test passes just as happily when the endpoint is broken for
 * everyone, and that false green has shipped here before.
 *
 * Self-cleaning, sweeping on the way IN as well as OUT, deleting by EXACT code
 * rather than a `LIKE 'prefix%'` that would eat a sibling tag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
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

const { default: pool }          = await import('../config/db.js');
const { verifyToken }            = await import('../middlewares/auth.middleware.js');
const { auditMutations }         = await import('../middlewares/auditMutations.js');
const { denialLogger }           = await import('../middlewares/denialLogger.js');
const { default: settingsRouter }= await import('../modules/admin/settings-status.routes.js');
const { default: webhooksRouter }= await import('../routes/webhooks.routes.js');
const { readStored, encrypt, decryptStrict, resolveConfig, INTEGRATION_FIELDS } =
  await import('../modules/integrations/integrationConfig.js');

const CODE_A = 'ZZFOLLOWUPA';
const CODE_B = 'ZZFOLLOWUPB';
const CODES  = [CODE_A, CODE_B];

const ids = { companyA: null, companyB: null, empA: null, adminA: null, financeA: null };
let app;
const token = (userId, companyId) =>
  jwt.sign({ userId, company_id: companyId }, process.env.JWT_SECRET, { expiresIn: '1h' });

function buildApp() {
  const a = express();
  a.use(denialLogger);
  a.use('/api/settings', express.json(), verifyToken, auditMutations('settings'), settingsRouter);
  // Webhooks are mounted BEFORE any auth, with a raw body, exactly as server.js:521
  // does it — the raw body is what the HMAC is computed over.
  a.use('/api/webhooks', express.raw({ type: 'application/json' }), (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body.toString('utf8');
      try { req.body = JSON.parse(req.rawBody); } catch { req.body = {}; }
    }
    next();
  }, webhooksRouter);
  return a;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = ANY($1)`, [CODES]);
  for (const { id } of rows) {
    await pool.query(`DELETE FROM company_integrations WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM company_settings WHERE company_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM document_signings WHERE company_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM access_denials WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]).catch(() => {});
    await pool.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]);
    await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]);
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
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`PULSE-01 follow-up ${code}`, code]);
  return rows[0].id;
}

async function makeUser(companyId, localPart, roleCode) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active)
     VALUES ($1, $2, 'not-a-real-hash', $3, true) RETURNING id`,
    [`follow-up ${localPart}`, `zzfollowup.${localPart}@test.invalid`, companyId]);
  const userId = rows[0].id;
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  if (!role.length) throw new Error(`role '${roleCode}' is missing from the matrix`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, role[0].id]);
  return userId;
}

const envSnapshot = () => JSON.stringify(Object.entries(process.env).sort());

beforeAll(async () => {
  await sweep();
  ids.companyA = await makeCompany(CODE_A);
  ids.companyB = await makeCompany(CODE_B);
  ids.empA     = await makeUser(ids.companyA, 'employee', 'employee');
  ids.adminA   = await makeUser(ids.companyA, 'admin',    'admin');
  ids.financeA = await makeUser(ids.companyA, 'finance',  'finance_manager');
  app = buildApp();
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ═══════════════════════════════════════════════════════════════════════════════
describe('§12.1 — POST /settings/:module is no longer a generic ungated writer', () => {
  it('an ordinary employee cannot write ANY module configuration', async () => {
    const auth = `Bearer ${token(ids.empA, ids.companyA)}`;
    // Not a sample — every module the frontend actually posts to.
    for (const module of ['finance', 'compliance', 'payroll', 'performance', 'projects', 'servicedesk', 'company']) {
      const res = await request(app).post(`/api/settings/${module}`).set('Authorization', auth)
        .send({ tampered_by_employee: true });
      expect(res.status, `POST /settings/${module} was not gated`).toBe(403);
    }
    const { rows } = await pool.query(
      `SELECT module FROM company_settings WHERE company_id = $1`, [ids.companyA]);
    expect(rows).toEqual([]);
  });

  it('an employee cannot READ another module\'s configuration either', async () => {
    const auth = `Bearer ${token(ids.empA, ids.companyA)}`;
    for (const module of ['finance', 'payroll', 'compliance']) {
      const res = await request(app).get(`/api/settings/${module}`).set('Authorization', auth);
      expect(res.status, `GET /settings/${module} was not gated`).toBe(403);
    }
  });

  it('an unknown module name fails CLOSED without needing its own check', async () => {
    // It maps to a permission module with no role_permissions rows, and
    // requirePermission fails closed on that.
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const res = await request(app).post('/api/settings/not-a-real-module').set('Authorization', auth)
      .send({ anything: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_NOT_CONFIGURED');
  });

  it('PAIRED POSITIVE: the role that owns a module can still read and write its settings', async () => {
    // finance_manager holds finance:edit — the gate must not lock out the role the
    // page exists for, which is the failure mode documented at server.js:884.
    const auth = `Bearer ${token(ids.financeA, ids.companyA)}`;
    const write = await request(app).post('/api/settings/finance').set('Authorization', auth)
      .send({ default_currency: 'INR', fy_start_month: 4 });
    expect(write.status).toBe(200);

    const read = await request(app).get('/api/settings/finance').set('Authorization', auth);
    expect(read.status).toBe(200);
    expect(read.body.default_currency).toBe('INR');

    const { rows } = await pool.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'finance'`, [ids.companyA]);
    expect(rows[0].settings.fy_start_month).toBe(4);
  });

  it('an admin can still write the modules the setup wizard drives', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    for (const module of ['company', 'payroll', 'setup-progress']) {
      const res = await request(app).post(`/api/settings/${module}`).set('Authorization', auth)
        .send({ configured_by: 'wizard' });
      expect(res.status, `admin could not write /settings/${module}`).toBe(200);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§12.1b — /settings/integrations is no longer a plaintext credential sink', () => {
  const SECRET = 'rzp-followup-canary-must-never-be-plaintext';

  it('writes credentials to the ENCRYPTED per-tenant store, never to company_settings', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const res = await request(app).post('/api/settings/integrations').set('Authorization', auth)
      .send({
        razorpay: { key_id: 'rzp_test_followup', key_secret: SECRET, configured: true },
        sendgrid: { api_key: 'SG.followup', from_email: 'ops@a.test', configured: true },
        tally:    { host: 'tally.a.test', port: '9000', company: 'A Ltd', configured: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.saved.map((s) => s.integration).sort()).toEqual(['razorpay', 'sendgrid', 'tally']);

    // In the encrypted store…
    expect((await readStored(ids.companyA, 'razorpay')).RAZORPAY_KEY_SECRET).toBe(SECRET);
    // …and the host+port composed into one validated URL.
    expect((await readStored(ids.companyA, 'tally')).TALLY_GATEWAY_URL).toBe('http://tally.a.test:9000');

    // NOT in company_settings, in any form.
    const { rows } = await pool.query(
      `SELECT settings::text AS s FROM company_settings WHERE company_id = $1 AND module = 'integrations'`,
      [ids.companyA]);
    expect(rows.length, 'a plaintext integrations row was written').toBe(0);
  });

  it('never returns the secret it just stored', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const res = await request(app).get('/api/settings/integrations').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // Masked but truthy, so the wizard's `configured: !!(data.razorpay?.key_id)`
    // flags stay correct.
    expect(res.body.razorpay.key_secret).toBe('***');
    expect(res.body.razorpay.key_id).toBe('***');
    expect(res.body.tally.host).toBe('tally.a.test');
  });

  it('REFUSES deployment infrastructure, and says so rather than dropping it silently', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const res = await request(app).post('/api/settings/integrations').set('Authorization', auth)
      .send({ aws_s3: { access_key: 'AKIA-tenant', secret_key: 'nope', bucket: 'b', region: 'r', configured: true } });
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual([]);
    const refusal = res.body.rejected.find((r) => r.provider === 'aws_s3');
    expect(refusal, 'aws_s3 was accepted or silently ignored').toBeDefined();
    expect(refusal.reason).toMatch(/deployment-level/i);
    // Nothing stored anywhere under that name.
    const { rows } = await pool.query(
      `SELECT 1 FROM company_integrations WHERE company_id = $1 AND integration_key LIKE '%s3%'`, [ids.companyA]);
    expect(rows).toEqual([]);
  });

  it('round-trips a Tally gateway URL without downgrading https to http', async () => {
    // ⚠ THIS WAS A DEFECT IN THIS ENDPOINT, found by round-tripping the pair in
    // review rather than by a test. The read handed back a bare hostname plus a
    // SYNTHESISED port (443 for https), so the wizard posted `{host: 'gw.test',
    // port: '443'}` and the writer composed `http://gw.test:443` — a TLS
    // downgrade on an ordinary re-save, silent and persistent.
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;

    for (const stored of [
      'https://tally.secure.test',
      'https://tally.secure.test:8443',
      'http://tally.plain.test:9000',
    ]) {
      // Seed through the real integrations API so the value is stored exactly as a
      // normal save would store it.
      const put = await request(app).post('/api/settings/integrations').set('Authorization', auth)
        .send({ tally: { host: stored, configured: true } });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect((await readStored(ids.companyA, 'tally')).TALLY_GATEWAY_URL).toBe(stored);

      // Read it back the way the wizard does, post exactly that back, and the
      // stored value must be byte-identical.
      const read = await request(app).get('/api/settings/integrations').set('Authorization', auth);
      expect(read.status).toBe(200);
      const back = await request(app).post('/api/settings/integrations').set('Authorization', auth)
        .send({ tally: { ...read.body.tally, configured: true } });
      expect(back.status, JSON.stringify(back.body)).toBe(200);

      expect(
        (await readStored(ids.companyA, 'tally')).TALLY_GATEWAY_URL,
        `${stored} did not survive a wizard round trip`
      ).toBe(stored);
    }
  });

  it('accepts an IPv6 literal as an SMTP host', async () => {
    // The first version of the host validator refused these outright — a
    // functional regression wearing a security control's clothes.
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    for (const host of ['::1', '[2001:db8::1]', '2001:db8::1']) {
      const problem = INTEGRATION_FIELDS.smtp.SMTP_HOST.validate(host);
      expect(problem, `${host} was refused: ${problem}`).toBeNull();
    }
    // And the paired negative — a colon does not make anything valid.
    for (const bad of ['evil.test:25', 'a:b', 'not:valid']) {
      expect(INTEGRATION_FIELDS.smtp.SMTP_HOST.validate(bad), `${bad} was accepted`).not.toBeNull();
    }
  });

  it('applies the same validators as the integrations API, and reports each rejection', async () => {
    const auth = `Bearer ${token(ids.adminA, ids.companyA)}`;
    const res = await request(app).post('/api/settings/integrations').set('Authorization', auth)
      .send({
        sendgrid: { from_email: 'not-an-email', configured: true },
        razorpay: { made_up_field: 'x', configured: true },
        nonsense: { a: 'b' },
      });
    expect(res.status).toBe(200);
    const reasons = res.body.rejected;
    expect(reasons.some((r) => r.provider === 'sendgrid' && r.field === 'SENDGRID_FROM_EMAIL')).toBe(true);
    expect(reasons.some((r) => r.provider === 'razorpay' && r.field === 'made_up_field')).toBe(true);
    expect(reasons.some((r) => r.provider === 'nonsense')).toBe(true);
  });

  it('an employee cannot reach it at all', async () => {
    const auth = `Bearer ${token(ids.empA, ids.companyA)}`;
    expect((await request(app).get('/api/settings/integrations').set('Authorization', auth)).status).toBe(403);
    expect((await request(app).post('/api/settings/integrations').set('Authorization', auth)
      .send({ razorpay: { key_secret: 'x' } })).status).toBe(403);
  });

  it('is tenant-isolated — company B sees nothing of company A', async () => {
    const adminB = await makeUser(ids.companyB, 'adminb', 'admin');
    const res = await request(app).get('/api/settings/integrations')
      .set('Authorization', `Bearer ${token(adminB, ids.companyB)}`);
    expect(res.status).toBe(200);
    expect(res.body.razorpay).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§12.4 — webhook signature verification fails CLOSED', () => {
  const body = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_zzfollowup', amount: 100 } } } };
  const raw  = JSON.stringify(body);
  const sign = (secret) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const post = (headers = {}) =>
    request(app).post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json').set(headers).send(raw);

  it('rejects a MISSING signature when a secret is configured', async () => {
    const prev = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = 'deployment-webhook-secret';
    try {
      const res = await post();
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/signature/i);
    } finally {
      if (prev === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
      else process.env.RAZORPAY_WEBHOOK_SECRET = prev;
    }
  });

  it('rejects a WRONG signature', async () => {
    const prev = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = 'deployment-webhook-secret';
    try {
      const res = await post({ 'x-razorpay-signature': sign('the-wrong-secret') });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
      else process.env.RAZORPAY_WEBHOOK_SECRET = prev;
    }
  });

  it('refuses an unsigned call in PRODUCTION when no secret is configured, instead of trusting it', async () => {
    // This is the one that mattered: a deployment with no secret used to accept
    // any forged payment.captured and mark invoices paid.
    const prevSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const prevEnv    = process.env.NODE_ENV;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';
    try {
      const res = await post();
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('webhook_not_configured');
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevSecret !== undefined) process.env.RAZORPAY_WEBHOOK_SECRET = prevSecret;
    }
  });

  it('PAIRED POSITIVE: a correctly signed call is accepted', async () => {
    const prev = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = 'deployment-webhook-secret';
    try {
      const res = await post({ 'x-razorpay-signature': sign('deployment-webhook-secret') });
      expect(res.status, 'a valid signature was rejected — the check is now too strict').toBe(200);
    } finally {
      if (prev === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
      else process.env.RAZORPAY_WEBHOOK_SECRET = prev;
    }
  });

  it('the zoho-sign handler rejects a missing signature too — it used to skip the check entirely', async () => {
    const zBody = { requests: { request_id: 'zzfollowup-req', request_status: 'completed' }, notifications: { event_type: 'REQUEST_COMPLETED' } };
    const zRaw  = JSON.stringify(zBody);
    const prev  = process.env.ZOHO_SIGN_WEBHOOK_SECRET;
    process.env.ZOHO_SIGN_WEBHOOK_SECRET = 'zoho-deployment-secret';
    try {
      // No signature header at all — the old code fell through the inner
      // `if (incomingSig)` and processed the forged completion.
      const res = await request(app).post('/api/webhooks/zoho-sign')
        .set('Content-Type', 'application/json').send(zRaw);
      expect(res.status).toBe(401);

      // And the paired positive.
      const ok = await request(app).post('/api/webhooks/zoho-sign')
        .set('Content-Type', 'application/json')
        .set('x-zoho-sign-hmac', crypto.createHmac('sha256', 'zoho-deployment-secret').update(zRaw).digest('hex'))
        .send(zRaw);
      expect(ok.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.ZOHO_SIGN_WEBHOOK_SECRET;
      else process.env.ZOHO_SIGN_WEBHOOK_SECRET = prev;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§12.5 / §12.6 — ENCRYPTION_KEY strength and rotation are no longer silent', () => {
  it('a wrong key raises CredentialDecryptError instead of reading as "not configured"', async () => {
    const ciphertext = encrypt({ SMTP_HOST: 'real.test', SMTP_USER: 'ops@real.test' });
    expect(decryptStrict(ciphertext).SMTP_HOST).toBe('real.test');

    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'a-different-key-long-enough-to-pass-the-floor';
    try {
      expect(() => decryptStrict(ciphertext)).toThrow(/could not be decrypted/i);
      let code = null;
      try { decryptStrict(ciphertext); } catch (e) { code = e.code; }
      expect(code).toBe('CREDENTIAL_DECRYPT_FAILED');
    } finally {
      if (prev === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prev;
    }
  });

  it('an ABSENT ciphertext is still "nothing stored", not an error', async () => {
    // The distinction is the whole point: empty is legitimate, undecryptable is not.
    expect(decryptStrict('')).toEqual({});
    expect(decryptStrict(null)).toEqual({});
  });

  it('refuses to run in production with no key, or with a key under 32 characters', async () => {
    const prevKey = process.env.ENCRYPTION_KEY;
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      delete process.env.ENCRYPTION_KEY;
      expect(() => encrypt({ a: 'b' })).toThrow(/ENCRYPTION_KEY is not set/);
      process.env.ENCRYPTION_KEY = 'too-short';
      expect(() => encrypt({ a: 'b' })).toThrow(/at least 32/i);
      // PAIRED POSITIVE — a proper key works in production.
      process.env.ENCRYPTION_KEY = 'x'.repeat(48);
      expect(decryptStrict(encrypt({ a: 'b' }))).toEqual({ a: 'b' });
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prevKey;
    }
  });

  it('a MONEY integration does NOT degrade to the deployment env on a decrypt failure', async () => {
    // ⚠⚠ The correction to my own earlier decision. Degrading is right for mail —
    // a rotated key should not take every notification down. For Razorpay it would
    // take a tenant's customer payment into the PLATFORM's account, and `/verify`
    // would then check the HMAC with that same platform secret, so the signature
    // VERIFIES and the invoice is marked paid. Money in the wrong account, nothing
    // looking wrong. So money fails closed.
    await pool.query(
      `INSERT INTO company_integrations (company_id, integration_key, credentials_enc, status, updated_at)
       VALUES ($1, 'razorpay', $2, 'connected', NOW())
       ON CONFLICT (company_id, integration_key) DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc`,
      [ids.companyB, encrypt({ RAZORPAY_KEY_ID: 'rzp_live_tenantB', RAZORPAY_KEY_SECRET: 'tenant-b-secret' })]);

    // ⚠ Seed the mail row HERE, under the CURRENT key. Encrypting it after the
    // rotation below would encrypt it with the new key, so it would decrypt
    // perfectly and the degradation half of this test would assert nothing.
    await pool.query(
      `INSERT INTO company_integrations (company_id, integration_key, credentials_enc, status, updated_at)
       VALUES ($1, 'smtp', $2, 'connected', NOW())
       ON CONFLICT (company_id, integration_key) DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc`,
      [ids.companyB, encrypt({ SMTP_HOST: 'tenant.b.test', SMTP_USER: 'ops@b.test' })]);

    const prevKey = process.env.ENCRYPTION_KEY;
    const prevId  = process.env.RAZORPAY_KEY_ID;
    const prevSec = process.env.RAZORPAY_KEY_SECRET;
    process.env.ENCRYPTION_KEY      = 'rotated-key-long-enough-to-pass-the-floor';
    process.env.RAZORPAY_KEY_ID     = 'rzp_live_PLATFORM';
    process.env.RAZORPAY_KEY_SECRET = 'platform-secret';
    try {
      const cfg = await resolveConfig(ids.companyB, 'razorpay');
      expect(cfg.RAZORPAY_KEY_ID, 'degraded to the PLATFORM key — payments would be misdirected').toBeUndefined();
      expect(cfg.RAZORPAY_KEY_SECRET).toBeUndefined();
      expect(cfg).toEqual({});

      // Mail, by contrast, SHOULD degrade — the trade is deliberate and opposite.
      const prevHost = process.env.SMTP_HOST;
      process.env.SMTP_HOST = 'deployment.fallback.test';
      try {
        const mail = await resolveConfig(ids.companyB, 'smtp');
        expect(mail.SMTP_HOST, 'mail should still degrade so notifications keep flowing').toBe('deployment.fallback.test');
      } finally {
        if (prevHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = prevHost;
      }
    } finally {
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = prevKey;
      if (prevId  === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = prevId;
      if (prevSec === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = prevSec;
    }
  });

  it('every payment handler refuses in production when no usable keys resolve', async () => {
    // The guard that turns "fail closed" into a refusal rather than a crash. One
    // of these four did NOT have it and returned a FAKE payment link with
    // success: true, which is how a fail-closed decision becomes a worse outcome
    // than degrading.
    const { readFileSync: read } = await import('node:fs');
    const src = read(resolve(dirname(fileURLToPath(import.meta.url)), '../modules/integrations/payment.routes.js'), 'utf8');
    const guards = src.match(/if \(!keyId \|\| !keySecret\)|if \(!keySecret\)/g) ?? [];
    expect(guards.length, 'expected a missing-key guard in config-status, create-order, create-link and verify').toBe(4);
    // Every guard that can start a payment must check production. /config-status
    // only reports, so it is allowed to answer without one.
    const paying = src.slice(src.indexOf("router.post('/create-order'"));
    const branches = paying.split(/if \(!keyId \|\| !keySecret\)|if \(!keySecret\)/).slice(1);
    expect(branches.length).toBe(3);
    for (const [i, b] of branches.entries()) {
      expect(
        b.slice(0, 900),
        `payment branch ${i} does not refuse in production — it would act on absent credentials`
      ).toMatch(/NODE_ENV === 'production'/);
    }
  });

  it('resolveConfig degrades to the deployment env on a decrypt failure rather than crashing a send', async () => {
    // Store something under the real key…
    const { rows } = await pool.query(
      `INSERT INTO company_integrations (company_id, integration_key, credentials_enc, status, updated_at)
       VALUES ($1, 'smtp', $2, 'connected', NOW())
       ON CONFLICT (company_id, integration_key) DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc
       RETURNING id`,
      [ids.companyB, encrypt({ SMTP_HOST: 'tenant.b.test', SMTP_USER: 'ops@b.test' })]);
    expect(rows.length).toBe(1);

    const prevKey  = process.env.ENCRYPTION_KEY;
    const prevHost = process.env.SMTP_HOST;
    process.env.ENCRYPTION_KEY = 'rotated-key-that-is-long-enough-to-pass';
    process.env.SMTP_HOST = 'deployment.fallback.test';
    try {
      const cfg = await resolveConfig(ids.companyB, 'smtp');
      // Degraded, not crashed, and NOT silently claiming the tenant value.
      expect(cfg.SMTP_HOST).toBe('deployment.fallback.test');
    } finally {
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = prevKey;
      if (prevHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = prevHost;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§12.2 / §12.3 — credential consumers resolve per tenant', () => {
  it('no consumer reads a credential from the environment except the documented exceptions', async () => {
    const { readFileSync: read } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const files = {
      // The two closed in this pass.
      '../modules/documents/routes/publicSign.routes.js': [],
      '../utils/mailer.js':                               [],
      '../services/emailTrigger.js':                      [],
      '../modules/crm/services/journeyEngine.js':         [],
      // Deployment-level by design, listed explicitly rather than allowed by omission.
      '../routes/webhooks.routes.js':                     ['RAZORPAY_WEBHOOK_SECRET', 'ZOHO_SIGN_WEBHOOK_SECRET'],
      '../modules/integrations/whatsapp.routes.js':        ['WHATSAPP_VERIFY_TOKEN'],
    };
    const PATTERN = /process\.env\.(WHATSAPP|SENDGRID|AWS_SES|SMTP|RAZORPAY|TALLY|ZOHO_BOOKS|ZOHO_SIGN)_[A-Z_]+/g;

    const unexpected = [];
    for (const [rel, allowed] of Object.entries(files)) {
      const code = read(resolve(here, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const match of code.match(PATTERN) ?? []) {
        const name = match.replace('process.env.', '');
        if (!allowed.includes(name)) unexpected.push(`${rel}: ${name}`);
      }
    }
    expect(
      unexpected,
      `these still read a credential from the environment instead of the tenant's row:\n  ${unexpected.join('\n  ')}`
    ).toEqual([]);
  });

  it('the journey engine caches one transport PER TENANT, not one per process', async () => {
    // A module-level singleton meant the first tenant to send pinned its own mail
    // server for everyone else — a cache keyed by nothing is its own cross-tenant
    // channel.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../modules/crm/services/journeyEngine.js'), 'utf8');
    expect(src).toMatch(/const _transports = new Map\(\)/);
    expect(src).not.toMatch(/^let _transport = null;$/m);
    const { default: engine } = await import('../modules/crm/services/journeyEngine.js');
    expect(typeof engine.resetTransportCache).toBe('function');
  });

  it('the audit floor redacts every key-shaped field name, not just the enumerated ones', async () => {
    // A controlled reproduction of PULSE-01 wrote `{"ENCRYPTION_KEY":
    // "attacker_known_key"}` into audit_logs in PLAINTEXT: the redaction list
    // spelled out `apikey|api_key|private_key` and missed every other key-shaped
    // name. Enumerating separators (`_key`, `key_`) then fixed snake_case and
    // still missed camelCase — the enumeration itself was the bug.
    const { readFileSync: read } = await import('node:fs');
    const src = read(resolve(dirname(fileURLToPath(import.meta.url)), '../middlewares/auditMutations.js'), 'utf8');
    const literal = src.match(/^const SECRET = (\/.*\/i);$/m)?.[1];
    expect(literal, 'the SECRET redaction pattern could not be located').toBeTruthy();
    // eslint-disable-next-line no-eval -- reading this file's own literal, not input
    const SECRET = eval(literal);

    for (const name of [
      'JWT_SECRET', 'ENCRYPTION_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
      'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY', 'SENDGRID_API_KEY',
      'SMTP_PASS', 'WHATSAPP_TOKEN', 'ZOHO_SIGN_CLIENT_SECRET',
      'apiKey', 'privateKey', 'accessKey', 'keyId', 'webhook_secret',
    ]) {
      expect(SECRET.test(name), `${name} would be written to audit_logs in PLAINTEXT`).toBe(true);
    }
    // And the paired negative — over-redacting everything would be its own bug,
    // because an audit trail of [REDACTED] answers no questions.
    for (const name of ['NODE_ENV', 'SMTP_HOST', 'SMTP_PORT', 'customer_name', 'invoice_number', 'amount', 'status']) {
      expect(SECRET.test(name), `${name} is not a secret and must stay readable`).toBe(false);
    }
  });

  it('mailer keeps password resets on the DEPLOYMENT server, never a tenant\'s', async () => {
    // Routing account recovery through mail infrastructure a tenant administrator
    // controls would hand them the recovery channel.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../utils/mailer.js'), 'utf8');
    const fn = src.slice(src.indexOf('export async function sendPasswordResetOTP'));
    // Comments stripped — the note above the call explains WHY there is no
    // companyId, and matching prose would fail on the explanation itself.
    const body = fn.slice(0, fn.indexOf('\n}')).replace(/^\s*\/\/.*$/gm, '');
    expect(body).toMatch(/createTransport\(null\)/);
    expect(body).not.toMatch(/companyId/);
  });
});
