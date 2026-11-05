/**
 * Exit withdrawal — POST /exit/requests/:id/withdraw.
 *
 * Against the live database and the real exit router (auth stubbed — the
 * router reads only req.user.role and req.scope.company_id):
 *   - a withdrawn exit cancels the request, resets clearance, returns the
 *     employee from Notice to Active (or Probation, inside an unconfirmed
 *     window), and re-enables a login ONLY when this exit revoked it;
 *   - F&F paid / employee already Left / request already cancelled → 409;
 *   - another company's HR gets 404 and changes nothing; non-HR gets 403;
 *   - a cancelled request drops out of GET /exit/active.
 *
 * Fixtures live in two registry tenants (testTenantIds.contract.test.js) and
 * are deleted in afterAll.
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
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: router } = await import('../modules/hr/exit.routes.js');

const A = 999985;
const B = 999986;

const app = express();
app.use(express.json());
// Stand-in for verifyToken + scope: headers pick the caller.
// The actor is a REAL test-owned login (fx.actorUserId, created in beforeAll).
// With id/userId null, every successful withdraw wrote an audit row with no
// user and no company — unattributable, so it outlived the run as an orphan
// (nine such rows on 2026-10-20). Now each audit row this suite causes names
// its own actor, and cleanup removes exactly those rows, by that user id.
const fx = { actorUserId: null };
app.use((req, _res, next) => {
  req.user = { id: fx.actorUserId, userId: fx.actorUserId, role: req.get('x-role') };
  // x-company: none → a user whose company could not be resolved (verifyToken
  // sets req.scope = null for them); x-company: global → a super admin's scope.
  const co = req.get('x-company');
  req.scope = co === 'none' ? null
    : co === 'global' ? { company_id: null, isGlobal: true }
    : { company_id: Number(co) };
  next();
});
app.use('/api/exit', router);
const withdraw = (id, { role = 'hr_manager', company = A } = {}) =>
  request(app).post(`/api/exit/requests/${id}/withdraw`).set({ 'x-role': role, 'x-company': String(company) }).send({});

async function cleanup() {
  const c = [A, B];
  const emps = `SELECT id FROM employees WHERE company_id = ANY($1::int[])`;
  await pool.query(`DELETE FROM exit_clearance WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM exit_requests WHERE employee_id IN (${emps})`, [c]);
  // Audit rows THIS suite's actor wrote — never anyone else's.
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = 'zz.exitwd.actor@example.com')`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.exitwd.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
/** An employee with an open exit request, a clearance row and a login. */
async function scenario({ cid = A, status = 'Notice', revoked = true, loginActive = !revoked,
  fnf = 'draft', erStatus = 'active', probationEnd = null, confirmed = true } = {}) {
  seq += 1;
  const emp = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date,
                            employment_type, probation_end_date, confirmation_date)
     VALUES ($1,$2,'Zz',$3,$4,$5,'2025-01-01','Permanent',$6,$7) RETURNING id`,
    [cid, `EMP985${String(seq).padStart(3, '0')}`, `Exitwd${seq}`, `zz.exitwd.emp${seq}@example.com`, status,
      probationEnd, confirmed ? '2025-04-01' : null])).rows[0].id;
  const er = (await pool.query(
    `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, fnf_status, reason)
     VALUES ($1,'resignation',CURRENT_DATE + 20,$2,$3,'Better opportunity') RETURNING id`,
    [emp, erStatus, fnf])).rows[0].id;
  await pool.query(
    `INSERT INTO exit_clearance (employee_id, it_assets_returned, access_revoked, documents_collected,
       exit_interview_done, noc_it, noc_admin, noc_finance, noc_hr, noc_manager)
     VALUES ($1,true,$2,true,true,true,true,true,true,true)`, [emp, revoked]);
  const user = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,'x','employee',$3,$4,$5) RETURNING id`,
    [`Zz Exitwd${seq}`, `zz.exitwd.u${seq}@example.com`, loginActive, cid, emp])).rows[0].id;
  return { emp, er, user };
}

const state = async ({ emp, er, user }) => (await pool.query(
  `SELECT e.status, er.status AS er_status, u.is_active, ec.access_revoked, ec.noc_hr
     FROM employees e JOIN exit_requests er ON er.id = $2 JOIN users u ON u.id = $3
     LEFT JOIN exit_clearance ec ON ec.employee_id = e.id WHERE e.id = $1`, [emp, er, user])).rows[0];

let startedAt;
beforeAll(async () => {
  startedAt = new Date();
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ ExitWd A','ZZEWA'), ($2,'ZZ ExitWd B','ZZEWB')`, [A, B]);
  fx.actorUserId = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
     VALUES ('Zz ExitWd Actor','zz.exitwd.actor@example.com','x','hr_manager',true,$1) RETURNING id`, [A])).rows[0].id;
});
afterAll(async () => {
  // logAudit is fire-and-forget: let the last request's audit row land BEFORE
  // cleanup removes this actor's rows, or it would arrive afterwards and stay.
  await new Promise(r => setTimeout(r, 300));
  await cleanup();
  // No unattributed withdraw row may have been created by this run.
  const { rows: [left] } = await pool.query(
    `SELECT COUNT(*)::int n FROM audit_logs
      WHERE user_id IS NULL AND action_type = 'withdraw' AND created_at >= $1`, [startedAt]);
  expect(left.n, 'unattributed withdraw audit rows created during this run').toBe(0);
});

describe('POST /exit/requests/:id/withdraw', () => {
  it('cancels the exit, resets clearance, restores Active and re-enables the revoked login', async () => {
    const s = await scenario();
    const res = await withdraw(s.er);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ employee_status: 'Active', login_reactivated: true });
    expect(await state(s)).toEqual({ status: 'Active', er_status: 'cancelled', is_active: true, access_revoked: false, noc_hr: false });

    const active = await request(app).get('/api/exit/active').set({ 'x-role': 'hr_manager', 'x-company': String(A) });
    expect(active.body.map(r => r.id)).not.toContain(s.er);
  });

  it('returns someone inside an unconfirmed probation window to Probation', async () => {
    const s = await scenario({ probationEnd: new Date(Date.now() + 30 * 864e5), confirmed: false });
    const res = await withdraw(s.er);
    expect(res.status).toBe(200);
    expect((await state(s)).status).toBe('Probation');
  });

  it('leaves a login disabled for some other reason alone', async () => {
    const s = await scenario({ revoked: false, loginActive: false });
    const res = await withdraw(s.er);
    expect(res.status).toBe(200);
    expect(res.body.login_reactivated).toBe(false);
    expect((await state(s)).is_active).toBe(false);
  });

  it.each([
    ['F&F already paid', { fnf: 'paid' }],
    ['employee already Left', { status: 'Left' }],
    ['request already cancelled', { erStatus: 'cancelled' }],
  ])('refuses when %s (409, nothing changes)', async (_label, opts) => {
    const s = await scenario(opts);
    const before = await state(s);
    expect((await withdraw(s.er)).status).toBe(409);
    expect(await state(s)).toEqual(before);
  });

  it("gives another company's HR a 404 and changes nothing", async () => {
    const s = await scenario();
    const before = await state(s);
    expect((await withdraw(s.er, { company: B })).status).toBe(404);
    expect(await state(s)).toEqual(before);
  });

  // ── 2026-10-20: the company gate and the scoped mutations ──────────────────
  it('an HR user whose company cannot be resolved gets 403 and changes nothing', async () => {
    const s = await scenario();
    const before = await state(s);
    expect((await withdraw(s.er, { company: 'none' })).status).toBe(403);
    expect(await state(s)).toEqual(before);
  });

  it('a super admin with a global scope can still withdraw (explicit global path)', async () => {
    const s = await scenario();
    expect((await withdraw(s.er, { role: 'super_admin', company: 'global' })).status).toBe(200);
    expect((await state(s)).er_status).toBe('cancelled');
  });

  describe('PUT /exit/requests/:id', () => {
    const put = (id, body, { role = 'hr_manager', company = A } = {}) =>
      request(app).put(`/api/exit/requests/${id}`).set({ 'x-role': role, 'x-company': String(company) }).send(body);

    it('updates a same-company request', async () => {
      const s = await scenario();
      const r = await put(s.er, { status: 'rejected', remarks: 'zz same company' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: s.er, status: 'rejected', remarks: 'zz same company' });
    });

    it.each([['another company', B], ['no resolvable company', 'none']])(
      'is refused for %s and changes nothing', async (_l, company) => {
        const s = await scenario();
        const before = await state(s);
        const r = await put(s.er, { status: 'rejected', remarks: 'zz cross' }, { company });
        expect([403, 404]).toContain(r.status);
        expect(await state(s)).toEqual(before);
        const { rows: [er] } = await pool.query(`SELECT remarks FROM exit_requests WHERE id = $1`, [s.er]);
        expect(er.remarks).toBeNull();
      });

    it("another company cannot even probe the 'closed' gate", async () => {
      const s = await scenario({ fnf: 'paid' });
      expect((await put(s.er, { status: 'closed' }, { company: B })).status).toBe(404);
      expect((await state(s)).er_status).toBe('active');
    });
  });

  describe('POST /exit/requests', () => {
    const create = (body, { role = 'hr_manager', company = A } = {}) =>
      request(app).post('/api/exit/requests').set({ 'x-role': role, 'x-company': String(company) }).send(body);
    const count = async (emp) => (await pool.query(
      `SELECT COUNT(*)::int n FROM exit_requests WHERE employee_id = $1`, [emp])).rows[0].n;

    it('creates a request for a same-company employee', async () => {
      const s = await scenario({ status: 'Active', erStatus: 'cancelled' });
      const r = await create({ employee_id: s.emp, reason: 'zz own', last_working_date: '2026-12-31' });
      expect(r.status).toBe(201);
      expect(r.body.employee_id).toBe(s.emp);
    });

    it.each([['another company', B], ['no resolvable company', 'none']])(
      'refuses an employee outside the caller\'s company (%s) and writes nothing', async (_l, company) => {
        const s = await scenario({ status: 'Active', erStatus: 'cancelled' });
        const before = await count(s.emp);
        const r = await create({ employee_id: s.emp, reason: 'zz cross', last_working_date: '2026-12-31' }, { company });
        expect([403, 404]).toContain(r.status);
        expect(await count(s.emp)).toBe(before);
      });

    it('a malformed employee_id is a 400', async () => {
      expect((await create({ employee_id: '12abc' })).status).toBe(400);
    });
  });

  it('is HR-write only', async () => {
    const s = await scenario();
    expect((await withdraw(s.er, { role: 'employee' })).status).toBe(403);
    expect((await withdraw(s.er, { role: 'hr_exec' })).status).toBe(403);
    expect((await state(s)).er_status).toBe('active');
  });
});
