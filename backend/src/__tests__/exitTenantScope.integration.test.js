/**
 * Exit module — the four routes that still acted by id alone (2026-10-20):
 *
 *   POST /exit/interview                 body.employee_id
 *   POST /exit/fnf/compute/:employee_id  read salary + wrote net_payable
 *   PUT  /exit/fnf/:id/approve           exit-request id
 *   PUT  /exit/clearance/:employee_id    upsert + LOGIN DEACTIVATION
 *
 * Real exit router, real verifyToken, real logins, live database. For each
 * route: same-company works; another company's target, an unresolved caller
 * company, a client-supplied company_id, malformed and unknown ids are refused —
 * and a refusal leaves the exit request, F&F fields, clearance row, interview
 * rows, the employee's status, their login state and the audit log unchanged.
 * A global super admin keeps company-wide reach. A PAID settlement is neither
 * re-approved nor recomputed.
 *
 * Registry tenants 999946 / 999947 (testTenantIds.contract.test.js); every row
 * is removed in afterAll by those company ids and the zz.exitts. prefix.
 * ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { default: exitRouter } = await import('../modules/hr/exit.routes.js');

const A = 999946;
const B = 999947;
const PW = 'Zz-ExitTs-Test-9!';
const MAIL = 'zz.exitts.';
const fx = { tok: {}, user: {} };

const app = express();
app.use(express.json());
app.use('/api/exit', verifyToken, exitRouter);   // mounted behind verifyToken in server.js
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const call = (who, method, path, body) => request(app)[method](`/api/exit${path}`).set(as(who)).send(body ?? {});

async function cleanup() {
  const c = [A, B];
  const emps = `SELECT id FROM employees WHERE company_id = ANY($1::int[])`;
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM exit_interviews WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM exit_clearance WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM exit_requests WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${MAIL}%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

async function login(key, role, cid) {
  const email = `${MAIL}${key}@example.com`;
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
     VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [`Zz ${key}`, email, await bcrypt.hash(PW, 4), role, cid])).rows[0].id;
  if (cid != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

let seq = 0;
/** An employee on Notice with an open exit request, a clearance row and an ACTIVE login. */
async function leaver(cid, { fnf = null } = {}) {
  seq += 1;
  const n = String(seq).padStart(3, '0');
  const emp = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date, basic_salary)
     VALUES ($1,$2,'Zz',$3,$4,'Notice','2019-01-01',50000) RETURNING id`,
    [cid, `EMP946${n}`, `Leaver${seq}`, `${MAIL}emp${seq}@example.com`])).rows[0].id;
  const er = (await pool.query(
    `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, fnf_status, reason, notice_period)
     VALUES ($1,'resignation',CURRENT_DATE + 10,'active',$2,'zz reason',30) RETURNING id`, [emp, fnf])).rows[0].id;
  await pool.query(`INSERT INTO exit_clearance (employee_id) VALUES ($1)`, [emp]);
  const user = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,'x','employee',true,$3,$4) RETURNING id`,
    [`Zz Leaver${seq}`, `${MAIL}login${seq}@example.com`, cid, emp])).rows[0].id;
  return { emp, er, user };
}

/** Everything a refused call must leave untouched, for one leaver. */
const snapshot = async ({ emp, er, user }) => (await pool.query(
  `SELECT e.status AS emp_status, u.is_active AS login_active,
          to_jsonb(r) - 'updated_at' AS exit_request, r.updated_at AS er_updated,
          to_jsonb(c) AS clearance,
          (SELECT COUNT(*)::int FROM exit_interviews i WHERE i.employee_id = e.id) AS interviews,
          -- The audit trail of THESE records, by type and id (§223): reference_id
          -- alone is shared by every module, so a parallel suite auditing, say,
          -- GRN 62 moved this count while exit request 62 was under test. These
          -- are every type exit.routes.js writes, plus the employee row itself.
          (SELECT COUNT(*)::int FROM audit_logs a
            WHERE (a.reference_type IN ('exit_request', 'fnf_settlement') AND a.reference_id::text = $5::text)
               OR (a.reference_type IN ('exit_clearance', 'employee')    AND a.reference_id::text = $4::text)) AS audit_rows
     FROM employees e
     JOIN exit_requests r ON r.id = $2::int
     JOIN users u ON u.id = $3::int
     LEFT JOIN exit_clearance c ON c.employee_id = e.id
    WHERE e.id = $1::int`, [emp, er, user, String(emp), String(er)])).rows[0];

// This suite proves the tenant scoping of the F&F routes themselves, so it runs
// with containment C1/C3 lifted (HR_CONTAINMENT_FNF=off): that logic is what
// comes back when the switch is turned off. The contained behaviour (423, no
// writes) is covered by hrP0Containment.integration.test.js.
const containmentBefore = process.env.HR_CONTAINMENT_FNF;

beforeAll(async () => {
  process.env.HR_CONTAINMENT_FNF = 'off';
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ ExitTs A','ZZETA'), ($2,'ZZ ExitTs B','ZZETB')`, [A, B]);
  await login('hrA', 'hr_manager', A);
  await login('hrB', 'hr_manager', B);
  await login('unscopedHr', 'hr_manager', null);   // no users.company_id, no user_scope
  await login('super', 'super_admin', null);       // a deliberate global scope
}, 60_000);

afterAll(async () => {
  if (containmentBefore === undefined) delete process.env.HR_CONTAINMENT_FNF;
  else process.env.HR_CONTAINMENT_FNF = containmentBefore;
  await cleanup();
});

/** The refusal battery every route must pass. `send(who, s, extra)` performs the call for leaver `s`. */
function refusals(label, send, { okStatus }) {
  describe(`${label} — refusals change nothing`, () => {
    it('another company\'s target → 404', async () => {
      const s = await leaver(B);
      const before = await snapshot(s);
      expect((await send('hrA', s)).status).toBe(404);
      expect(await snapshot(s)).toEqual(before);
    });

    it('a client-supplied company_id does not move the caller into that company', async () => {
      const s = await leaver(B);
      const before = await snapshot(s);
      expect((await send('hrA', s, { company_id: B, companyId: B })).status).toBe(404);
      expect(await snapshot(s)).toEqual(before);
    });

    it('a caller whose company cannot be resolved → 403', async () => {
      const s = await leaver(A);
      const before = await snapshot(s);
      expect((await send('unscopedHr', s)).status).toBe(403);
      expect(await snapshot(s)).toEqual(before);
    });

    it('repeated and concurrent cross-company attempts are all refused', async () => {
      const s = await leaver(B);
      const before = await snapshot(s);
      const results = await Promise.all([1, 2, 3, 4].map(() => send('hrA', s)));
      expect(results.map(r => r.status)).toEqual([404, 404, 404, 404]);
      expect(await snapshot(s)).toEqual(before);
    });

    it('a global super admin keeps company-wide reach', async () => {
      const s = await leaver(B);
      expect((await send('super', s)).status).toBe(okStatus);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /exit/interview', () => {
  const send = (who, s, extra = {}) => call(who, 'post', '/interview',
    { employee_id: s.emp, reason_category: 'better_opportunity', overall_rating: 4, ...extra });

  it('same company: files the interview, marks the request and the clearance', async () => {
    const s = await leaver(A);
    const r = await send('hrA', s);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ employee_id: s.emp, exit_request_id: s.er });
    const after = await snapshot(s);
    expect(after.exit_request.interview_done).toBe(true);
    expect(after.clearance.exit_interview_done).toBe(true);
    expect(after.interviews).toBe(1);
  });

  it('an interviewer from another company is refused and nothing is written', async () => {
    const s = await leaver(A);
    const other = await leaver(B);
    const before = await snapshot(s);
    expect((await send('hrA', s, { interviewer_id: other.emp })).status).toBe(400);
    expect(await snapshot(s)).toEqual(before);
  });

  it.each([['abc', 400], ['12abc', 400], [0, 400], [2147483000, 404]])('employee_id %j → %i', async (bad, code) => {
    expect((await call('hrA', 'post', '/interview', { employee_id: bad })).status).toBe(code);
  });

  refusals('POST /exit/interview', send, { okStatus: 201 });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /exit/fnf/compute/:employee_id', () => {
  const send = (who, s, extra) => call(who, 'post', `/fnf/compute/${s.emp}`, extra);

  it('same company: computes and stores the draft', async () => {
    const s = await leaver(A);
    const r = await send('hrA', s);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.er, status: 'draft' });
    const after = await snapshot(s);
    expect(after.exit_request.fnf_status).toBe('draft');
    expect(Number(after.exit_request.net_payable)).toBe(r.body.net_payable);
  });

  it('another company\'s target returns no computation (no salary figures)', async () => {
    const s = await leaver(B);
    const r = await send('hrA', s);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/basic_salary|net_payable|50000/);
  });

  it('a PAID settlement is not recomputed (409) and keeps its figures', async () => {
    const s = await leaver(A, { fnf: 'paid' });
    await pool.query(`UPDATE exit_requests SET net_payable = 1234.5 WHERE id = $1`, [s.er]);
    const before = await snapshot(s);
    expect((await send('hrA', s)).status).toBe(409);
    expect(await snapshot(s)).toEqual(before);
  });

  it.each([['abc', 400], ['12abc', 400], ['0', 400], ['2147483000', 404]])('id %j → %i', async (bad, code) => {
    expect((await call('hrA', 'post', `/fnf/compute/${bad}`)).status).toBe(code);
  });

  refusals('POST /exit/fnf/compute', send, { okStatus: 200 });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /exit/fnf/:id/approve', () => {
  const send = (who, s, extra) => call(who, 'put', `/fnf/${s.er}/approve`, extra);

  it('same company: approves; approving again is idempotent; concurrent approves agree', async () => {
    const s = await leaver(A, { fnf: 'draft' });
    const r = await send('hrA', s);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.er, fnf_status: 'approved' });
    const again = await Promise.all([send('hrA', s), send('hrA', s)]);
    expect(again.map(x => x.status)).toEqual([200, 200]);
    expect((await snapshot(s)).exit_request.fnf_status).toBe('approved');
  });

  it('a PAID settlement is not moved back to approved (409)', async () => {
    const s = await leaver(A, { fnf: 'paid' });
    const before = await snapshot(s);
    expect((await send('hrA', s)).status).toBe(409);
    expect(await snapshot(s)).toEqual(before);
  });

  it.each([['abc', 400], ['12abc', 400], ['0', 400], ['2147483000', 404]])('id %j → %i', async (bad, code) => {
    expect((await call('hrA', 'put', `/fnf/${bad}/approve`)).status).toBe(code);
  });

  refusals('PUT /exit/fnf/:id/approve', send, { okStatus: 200 });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /exit/clearance/:employee_id', () => {
  const tick = { it_assets_returned: true, access_revoked: true, documents_collected: true,
    exit_interview_done: true, noc_it: true, noc_admin: true, noc_finance: true, noc_hr: true, noc_manager: true };
  const send = (who, s, extra = {}) => call(who, 'put', `/clearance/${s.emp}`, { ...tick, ...extra });

  it('same company: saves the clearance and revokes that employee\'s login', async () => {
    const s = await leaver(A);
    const r = await send('hrA', s);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ employee_id: s.emp, access_revoked: true, noc_hr: true });
    expect((await snapshot(s)).login_active).toBe(false);
  });

  it('creates the clearance row when there is none yet (same company)', async () => {
    const s = await leaver(A);
    await pool.query(`DELETE FROM exit_clearance WHERE employee_id = $1`, [s.emp]);
    const r = await send('hrA', s, { access_revoked: false });
    expect(r.status).toBe(200);
    expect(r.body.employee_id).toBe(s.emp);
  });

  it('another company\'s employee keeps an ACTIVE login', async () => {
    const s = await leaver(B);
    expect((await send('hrA', s)).status).toBe(404);
    expect((await snapshot(s)).login_active).toBe(true);
  });

  it.each([['abc', 400], ['12abc', 400], ['0', 400], ['2147483000', 404]])('id %j → %i', async (bad, code) => {
    expect((await call('hrA', 'put', `/clearance/${bad}`, tick)).status).toBe(code);
  });

  refusals('PUT /exit/clearance', send, { okStatus: 200 });
});
