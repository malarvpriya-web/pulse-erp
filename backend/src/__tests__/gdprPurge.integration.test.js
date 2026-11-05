/**
 * POST /api/security/gdpr/purge/:userId — the real router, the live database,
 * isolated fixture accounts only. No real user is ever a target.
 *
 * Before (2026-10-12) the purge ran three independent statements and the login
 * step ended in `.catch(()=>{})`. When the login step failed, the employee row
 * was already anonymised and committed, the login kept its real name and email,
 * and the response said "PII ... has been anonymised". It is now one
 * transaction that reports success only after COMMIT, logs the failing step,
 * and records a `gdpr_purge_failed` security event.
 *
 * The DATABASE FAILURE used here is a real one, not a mock: an employee with
 * two linked logins. Both receive the same anonymised address, so the second
 * row violates the login-email unique index.
 *
 * Fixtures: registry tenants 999928/999929, 'zz.gdpr.*' addresses; removed in
 * afterAll together with the security events and audit rows the tests create.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: securityRouter } = await import('../modules/admin/security.routes.js');

const CO_A = 999928;
const CO_B = 999929;
// Plays "another suite, running at the same time" in the concurrency regression
// below. Owned by this file (testTenantIds registry), cleaned up with the rest.
const CO_C = 999987;
const fx = {};

/** The real router, behind a stub that plays the part verifyToken plays in server.js. */
function appAs({ userId, roles, companyId }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, roles, role: roles[0], company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/api/security', securityRouter);
  return app;
}
const purge = (app, id, body = { confirm: 'PURGE' }) =>
  request(app).post(`/api/security/gdpr/purge/${id}`).send(body);

const emp = async (id) => (await pool.query(`SELECT * FROM employees WHERE id = $1`, [id])).rows[0];
const login = async (id) => (await pool.query(`SELECT id, name, email, two_fa_enabled, totp_secret FROM users WHERE id = $1`, [id])).rows[0];
const events = async (empId, type) => (await pool.query(
  `SELECT details FROM security_events WHERE event_type = $1 AND details->>'purged_user_id' = $2`,
  [type, String(empId)])).rows;
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 50)); }
};

async function cleanup() {
  const empIds = `SELECT id::text FROM employees WHERE company_id IN (${CO_A}, ${CO_B})`;
  await pool.query(`DELETE FROM security_events WHERE event_type LIKE 'gdpr_purge%' AND details->>'purged_user_id' IN (${empIds})`);
  await pool.query(`DELETE FROM audit_logs WHERE module_name = 'security' AND reference_type = 'employee' AND reference_id IN (${empIds})`).catch(() => {});
  const userIds = `SELECT id FROM users WHERE email LIKE 'zz.gdpr.%' OR employee_id IN (SELECT id FROM employees WHERE company_id IN (${CO_A}, ${CO_B}))`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${userIds})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${userIds})`);
  await pool.query(`DELETE FROM users WHERE id IN (${userIds})`);
  await pool.query(`DELETE FROM employees WHERE company_id IN (${CO_A}, ${CO_B})`);
  await pool.query(`DELETE FROM employees WHERE company_id = ${CO_C}`);
  await pool.query(`DELETE FROM interview_questions WHERE company_id IN (${CO_A}, ${CO_B}, ${CO_C})`);
  await pool.query(`DELETE FROM companies WHERE id IN (${CO_A}, ${CO_B}, ${CO_C})`);
}

async function employee(cid, code, email) {
  return (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, personal_email, phone,
                            pan_number, aadhaar_number, account_number, current_address, status, joining_date)
     VALUES ($1,$2,'Zz','Gdpr',$3,'zz.gdpr.personal@example.com','9876543210','ABCDE1234F','123412341234',
             '000111222333','1 Real Street','Active','2026-01-01') RETURNING id`,
    [cid, code, email])).rows[0].id;
}
async function user(email, cid, employeeId, role = 'employee') {
  return (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id, two_fa_enabled, totp_secret)
     VALUES ('Zz Gdpr Real Name', $1, 'x', $2, true, $3, $4, true, 'SECRET') RETURNING id`,
    [email, role, cid, employeeId])).rows[0].id;
}

beforeAll(async () => {
  await cleanup();
  for (const [id, name, code] of [[CO_A, 'ZZ Gdpr A', 'ZZGA'], [CO_B, 'ZZ Gdpr B', 'ZZGB']]) {
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,$2,$3)`, [id, name, code]);
  }
  fx.adminA = await user('zz.gdpr.admin.a@example.com', CO_A, null, 'admin');
  fx.adminB = await user('zz.gdpr.admin.b@example.com', CO_B, null, 'admin');

  fx.ok = await employee(CO_A, 'EMP928001', 'zz.gdpr.ok@example.com');
  fx.okLogin = await user('zz.gdpr.ok@example.com', CO_A, fx.ok);
  // An UNLINKED account whose email equals the employee's company email — it
  // must survive the purge untouched.
  fx.bystander = await user('zz.gdpr.ok.bystander@example.com', CO_A, null);
  await pool.query(`UPDATE employees SET company_email = 'zz.gdpr.ok.bystander@example.com' WHERE id = $1`, [fx.ok]);

  fx.noLogin = await employee(CO_A, 'EMP928002', 'zz.gdpr.nologin@example.com');

  fx.broken = await employee(CO_A, 'EMP928003', 'zz.gdpr.broken@example.com');
  fx.brokenLogin1 = await user('zz.gdpr.broken.1@example.com', CO_A, fx.broken);
  fx.brokenLogin2 = await user('zz.gdpr.broken.2@example.com', CO_A, fx.broken);

  fx.appA = appAs({ userId: fx.adminA, roles: ['admin'], companyId: CO_A });
  fx.appB = appAs({ userId: fx.adminB, roles: ['admin'], companyId: CO_B });
});

afterAll(async () => { await cleanup(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('guards are unchanged', () => {
  it('requires the explicit confirmation', async () => {
    const res = await purge(fx.appA, fx.ok, {});
    expect(res.status).toBe(400);
    expect((await emp(fx.ok)).first_name).toBe('Zz');
  });

  it('refuses a non-admin role', async () => {
    const res = await purge(appAs({ userId: fx.okLogin, roles: ['hr'], companyId: CO_A }), fx.ok);
    expect(res.status).toBe(403);
    expect((await emp(fx.ok)).first_name).toBe('Zz');
  });

  it('another company\'s admin cannot purge this employee (404, nothing changed)', async () => {
    const res = await purge(fx.appB, fx.ok);
    expect(res.status).toBe(404);
    expect((await emp(fx.ok)).pan_number).toBe('ABCDE1234F');
    expect((await login(fx.okLogin)).name).toBe('Zz Gdpr Real Name');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('successful anonymisation', () => {
  it('anonymises the employee AND its linked login, and records it', async () => {
    const res = await purge(fx.appA, fx.ok);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, logins_anonymised: 1 });

    const e = await emp(fx.ok);
    expect(e).toMatchObject({ first_name: 'Deleted User', last_name: '', personal_email: null, phone: null,
      pan_number: null, aadhaar_number: null, account_number: null, current_address: null });
    expect(e.company_email).toMatch(/^deleted_\d+_.+@purged\.local$/);

    const u = await login(fx.okLogin);
    expect(u).toMatchObject({ name: 'Deleted User', email: e.company_email, two_fa_enabled: false, totp_secret: null });

    // The unlinked account that shared the company email is NOT touched.
    expect(await login(fx.bystander)).toMatchObject({ name: 'Zz Gdpr Real Name', email: 'zz.gdpr.ok.bystander@example.com' });

    const ev = await events(fx.ok, 'gdpr_purge');
    expect(ev).toHaveLength(1);
    expect(ev[0].details.logins_anonymised).toBe(1);
    const audited = await waitFor(async () => (await pool.query(
      `SELECT 1 FROM audit_logs WHERE module_name = 'security' AND reference_id = $1 AND new_data_json::text LIKE '%gdpr_purge%'`,
      [String(fx.ok)])).rows.length);
    expect(audited).toBeTruthy();
  });

  it('an employee with no login is purged and says so (0 logins), not an error', async () => {
    const res = await purge(fx.appA, fx.noLogin);
    expect(res.status).toBe(200);
    expect(res.body.logins_anonymised).toBe(0);
    expect((await emp(fx.noLogin)).first_name).toBe('Deleted User');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('database failure', () => {
  let res;
  let logged;
  beforeAll(async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    res = await purge(fx.appA, fx.broken);
    logged = spy.mock.calls.map(c => String(c[0])).find(l => l.includes('gdpr_purge_failed'));
    spy.mockRestore();
  });

  it('reports failure — never success — and names the failing step', () => {
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.step).toBe('anonymise_login');
    expect(res.body.message).toMatch(/No changes were made/);
  });

  it('ROLLS BACK the employee anonymisation that had already run', async () => {
    // Before the fix: first_name 'Deleted User', PAN gone — committed.
    const e = await emp(fx.broken);
    expect(e).toMatchObject({ first_name: 'Zz', company_email: 'zz.gdpr.broken@example.com',
      pan_number: 'ABCDE1234F', aadhaar_number: '123412341234' });
  });

  it('leaves both logins exactly as they were', async () => {
    for (const id of [fx.brokenLogin1, fx.brokenLogin2]) {
      expect(await login(id)).toMatchObject({ name: 'Zz Gdpr Real Name', two_fa_enabled: true, totp_secret: 'SECRET' });
    }
  });

  it('records no success event, but a gdpr_purge_failed event, and logs the step without PII', async () => {
    expect(await events(fx.broken, 'gdpr_purge')).toHaveLength(0);
    const failed = await waitFor(async () => (await events(fx.broken, 'gdpr_purge_failed'))[0]);
    expect(failed.details).toMatchObject({ step: 'anonymise_login', code: '23505' });
    const line = JSON.parse(logged);
    expect(line).toMatchObject({ event: 'gdpr_purge_failed', step: 'anonymise_login', employee_id: String(fx.broken) });
    expect(logged).not.toMatch(/ABCDE1234F|123412341234|Real Street/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('retry', () => {
  it('once the cause is fixed, a retry purges everything in one go', async () => {
    // The business resolves the duplicate link; the purge is simply re-run.
    await pool.query(`UPDATE users SET employee_id = NULL WHERE id = $1`, [fx.brokenLogin2]);
    const res = await purge(fx.appA, fx.broken);
    expect(res.status).toBe(200);
    expect(res.body.logins_anonymised).toBe(1);
    const e = await emp(fx.broken);
    expect(e.first_name).toBe('Deleted User');
    expect((await login(fx.brokenLogin1))).toMatchObject({ name: 'Deleted User', email: e.company_email });
    expect(await events(fx.broken, 'gdpr_purge')).toHaveLength(1);
  });

  it('purging an already-purged employee again is harmless', async () => {
    const res = await purge(fx.appA, fx.broken);
    expect(res.status).toBe(200);
    expect((await emp(fx.broken)).pan_number).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('failure of the SUCCESS security-event insert', () => {
  // Test-scoped fault, no schema change: for this one request, the handler's
  // transaction client is wrapped so that ITS success-event INSERT
  // (event_type 'gdpr_purge') carries invalid JSON. The REAL Postgres server
  // rejects it (22P02) and aborts the REAL transaction; BEGIN, the two
  // UPDATEs, ROLLBACK and the separate gdpr_purge_failed insert (pool.query,
  // not this client) all run untouched against the database. The spy is
  // restored immediately after the request.
  let res;
  let logged;
  let bystandersBefore;
  let oldStyleBefore;
  const retryWrites = [];

  // ── What "nothing else changed" means (2026-10-20) ────────────────────────
  // This used to hash EVERY employee and login outside this file's two tenants
  // and require the hash to be identical afterwards. Every other suite in a
  // parallel run creates and deletes employees in its own tenants, so the hash
  // moved whenever one of them did — a false failure with nothing to do with
  // the purge (seen in a full run; the suite passes alone). It is replaced by
  // two checks that are about the purge itself and immune to other suites:
  //   · every write the handler issues targets THIS employee / ITS logins and
  //     changes exactly that many rows (recorded from the handler's client);
  //   · look-alike bystanders — same PII values, same company and another
  //     company, linked logins — are byte-identical afterwards.
  // `oldStyleFingerprint` is kept ONLY to prove, in the regression case, that
  // the previous assertion would have failed on an unrelated concurrent insert.
  const oldStyleFingerprint = async () => (await pool.query(`
    SELECT
      (SELECT md5(COALESCE(string_agg(concat_ws('|', id, first_name, last_name, company_email, personal_email,
                                                 pan_number, aadhaar_number, account_number), ',' ORDER BY id), ''))
         FROM employees WHERE company_id IS DISTINCT FROM ${CO_A} AND company_id IS DISTINCT FROM ${CO_B}) AS employees,
      (SELECT md5(COALESCE(string_agg(concat_ws('|', id, name, email, password_hash, two_fa_enabled, totp_secret), ',' ORDER BY id), ''))
         FROM users WHERE email NOT LIKE 'zz.gdpr.%'
           AND (employee_id IS NULL OR employee_id NOT IN (SELECT id FROM employees WHERE company_id IN (${CO_A}, ${CO_B})))) AS users
  `)).rows[0];

  /** Full rows of the bystanders: what a purge leaking past its target would change. */
  const bystanders = async () => ({
    employees: (await pool.query(`SELECT * FROM employees WHERE id = ANY($1::int[]) ORDER BY id`,
      [[fx.bystA, fx.bystB]])).rows,
    users: (await pool.query(`SELECT * FROM users WHERE id = ANY($1::int[]) ORDER BY id`,
      [[fx.bystALogin, fx.bystBLogin, fx.bystander]])).rows,
  });

  beforeAll(async () => {
    fx.evFail = await employee(CO_A, 'EMP928004', 'zz.gdpr.evfail@example.com');
    fx.evFailLogin = await user('zz.gdpr.evfail@example.com', CO_A, fx.evFail);
    // Same PII values as the target, in the same company and in another one.
    fx.bystA = await employee(CO_A, 'EMP928005', 'zz.gdpr.bystander.a@example.com');
    fx.bystALogin = await user('zz.gdpr.bystander.a@example.com', CO_A, fx.bystA);
    fx.bystB = await employee(CO_B, 'EMP929005', 'zz.gdpr.bystander.b@example.com');
    fx.bystBLogin = await user('zz.gdpr.bystander.b@example.com', CO_B, fx.bystB);
    bystandersBefore = await bystanders();
    oldStyleBefore = await oldStyleFingerprint();

    const realConnect = pool.connect.bind(pool);
    const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(async (...args) => {
      const client = await realConnect(...args);
      const realQuery = client.query.bind(client);
      // Only the handler's client is wrapped, and only for this request.
      client.query = (text, params, ...rest) => {
        if (typeof text === 'string' && /INSERT INTO security_events/.test(text) && params?.[0] === 'gdpr_purge') {
          params = [...params];
          params[3] = '{not valid json';
        }
        return realQuery(text, params, ...rest);
      };
      const realRelease = client.release.bind(client);
      client.release = (...a) => { client.query = realQuery; return realRelease(...a); };
      return client;
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      res = await purge(fx.appA, fx.evFail);
    } finally {
      connectSpy.mockRestore();
      logged = errSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('gdpr_purge_failed'));
      errSpy.mockRestore();
    }
  });

  it('does not report success, and names the failing step', () => {
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.step).toBe('record_security_event');
    expect(res.body.message).toMatch(/No changes were made/);
  });

  it('rolls back the employee anonymisation and the linked-login anonymisation', async () => {
    expect(await emp(fx.evFail)).toMatchObject({
      first_name: 'Zz', last_name: 'Gdpr', company_email: 'zz.gdpr.evfail@example.com',
      personal_email: 'zz.gdpr.personal@example.com', pan_number: 'ABCDE1234F',
      aadhaar_number: '123412341234', account_number: '000111222333', current_address: '1 Real Street',
    });
    expect(await login(fx.evFailLogin)).toMatchObject({
      name: 'Zz Gdpr Real Name', email: 'zz.gdpr.evfail@example.com', two_fa_enabled: true, totp_secret: 'SECRET',
    });
  });

  it('leaves no success event', async () => {
    expect(await events(fx.evFail, 'gdpr_purge')).toHaveLength(0);
  });

  it('records gdpr_purge_failed and logs the step safely (ids only, no PII)', async () => {
    const failed = await waitFor(async () => (await events(fx.evFail, 'gdpr_purge_failed'))[0]);
    expect(failed?.details).toMatchObject({ step: 'record_security_event', code: '22P02' });
    const line = JSON.parse(logged);
    expect(line).toMatchObject({
      level: 'ERROR', event: 'gdpr_purge_failed', step: 'record_security_event',
      employee_id: String(fx.evFail), actor_id: fx.adminA, code: '22P02',
    });
    expect(logged).not.toMatch(/ABCDE1234F|123412341234|000111222333|Real Street|Real Name|zz\.gdpr\.personal/);
  });

  it('a retry with the fault gone purges normally', async () => {
    // Record every statement the handler's transaction client runs, with its rowCount.
    const realConnect = pool.connect.bind(pool);
    const spy = vi.spyOn(pool, 'connect').mockImplementation(async (...args) => {
      const client = await realConnect(...args);
      const realQuery = client.query.bind(client);
      client.query = async (text, params, ...rest) => {
        const r = await realQuery(text, params, ...rest);
        if (typeof text === 'string') retryWrites.push({ sql: text.replace(/\s+/g, ' ').trim(), params, rowCount: r?.rowCount });
        return r;
      };
      const realRelease = client.release.bind(client);
      client.release = (...a) => { client.query = realQuery; return realRelease(...a); };
      return client;
    });
    let retry;
    try { retry = await purge(fx.appA, fx.evFail); } finally { spy.mockRestore(); }
    expect(retry.status).toBe(200);
    expect(retry.body.logins_anonymised).toBe(1);
    expect(await events(fx.evFail, 'gdpr_purge')).toHaveLength(1);
  });

  it('every write the purge issued targeted this employee and changed exactly its rows', () => {
    const writes = retryWrites.filter(w => /^(UPDATE|DELETE|INSERT)\b/i.test(w.sql));
    const empWrites = writes.filter(w => /^UPDATE employees\b/i.test(w.sql));
    const userWrites = writes.filter(w => /^UPDATE users\b/i.test(w.sql));
    expect(empWrites).toHaveLength(1);
    expect(empWrites[0].params).toContain(fx.evFail);
    expect(empWrites[0].rowCount).toBe(1);
    expect(userWrites).toHaveLength(1);
    expect(userWrites[0].params).toContain(fx.evFail);
    expect(userWrites[0].rowCount).toBe(1);                 // its one linked login
    // Nothing else is written but the success event.
    const rest = writes.filter(w => !empWrites.includes(w) && !userWrites.includes(w));
    expect(rest).toHaveLength(1);
    expect(rest[0].sql).toMatch(/^INSERT INTO security_events\s*\(/i);
  });

  it('look-alike bystanders (same PII, same and other company) are unchanged', async () => {
    expect(await bystanders()).toEqual(bystandersBefore);
  });

  it('REGRESSION: an unrelated employee created meanwhile (a concurrent suite) is not a failure', async () => {
    // Exactly what a parallel suite does: create a company and an employee in its own tenant.
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ Gdpr C','ZZGC') ON CONFLICT (id) DO NOTHING`, [CO_C]);
    await employee(CO_C, 'EMP987001', 'zz.gdpr.concurrent@example.com');
    // The previous assertion would have reported "a real employee was changed" …
    expect(await oldStyleFingerprint()).not.toEqual(oldStyleBefore);
    // … the purge-scoped checks still hold, and still catch a real leak:
    expect(await bystanders()).toEqual(bystandersBefore);
    await pool.query(`UPDATE employees SET pan_number = NULL WHERE id = $1`, [fx.bystB]);
    expect(await bystanders()).not.toEqual(bystandersBefore);
  });
});
