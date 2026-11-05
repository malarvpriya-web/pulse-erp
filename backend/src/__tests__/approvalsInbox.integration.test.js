/**
 * Approval Center as an inbox over the modules — against the live database and
 * the real travel + approvals routers with real login tokens.
 *
 *   submit (travel module) → My Requests shows it Pending with the current
 *   approver → it is in the reporting manager's My Pending Approvals with the
 *   module's own endpoint as the action → executing that action decides it →
 *   the requester sees Approved/Rejected (+ reason) and a notification → the
 *   approver's Approval History and KPIs count it.
 *
 * Also: a manager who is not the reporting manager, and a manager in another
 * tenant, never see the request; the generic /approvals/<type>:<id>/approve
 * refuses module records (409 USE_MODULE_ENDPOINT) so no second write path
 * exists.
 *
 * Fixtures live in registry tenants 999979/999980 (testTenantIds.contract) and
 * are deleted in afterAll. ⚠ Do not run this while a Playwright crawl is going.
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
const { default: approvalsRoutes } = await import('../modules/approvals/approvals.routes.js');
const { default: travelRoutes } = await import('../modules/travel/travel.routes.js');

const A = 999979;
const B = 999980;
const PW = 'Zz-Inbox-Test-9!';
const EMAIL = (k) => `zz.inbox.${k}@example.com`;
const fx = { tok: {}, user: {}, emp: {}, travel: {} };

const app = express();
app.use(express.json());
app.use('/api/approvals', verifyToken, approvalsRoutes);
app.use('/api/travel', verifyToken, travelRoutes);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const api = (who, method, url, body) => request(app)[method](`/api${url}`).set(as(who)).send(body ?? {});

const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.inbox.%@example.com'`;
  const travel = `SELECT id FROM travel_requests WHERE company_id = ANY($1::int[])`;
  await pool.query(`DELETE FROM workflow_instance_steps WHERE instance_id IN
                      (SELECT id FROM workflow_instances WHERE module = 'travel' AND entity_id IN (${travel}))`, [c]);
  await pool.query(`DELETE FROM workflow_instances WHERE module = 'travel' AND entity_id IN (${travel})`, [c]);
  await pool.query(`DELETE FROM travel_bookings WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM travel_requests WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.inbox.%@example.com'`);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
async function emp(key, cid, managerKey = null) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date, reporting_manager_id)
     VALUES ($1, $2, 'Zz', $3, $4, 'Active', '2025-01-01', $5) RETURNING id`,
    [cid, `EMP979${String(seq).padStart(3, '0')}`, key, EMAIL(`emp.${key}`), managerKey ? fx.emp[managerKey] : null],
  )).rows[0].id;
  return fx.emp[key];
}

async function login(key, role, cid, employeeId) {
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING id`,
    [`Zz ${key}`, EMAIL(key), hash, role, cid, employeeId])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(EMAIL(key), PW)).token;
}

const raiseTravel = async (key, destination) => {
  const res = await api(key, 'post', '/travel/requests', {
    destination, purpose: 'Customer visit', from_date: '2026-11-20', to_date: '2026-11-21', budget: 12500.5, mode: 'Train',
  });
  expect(res.status).toBe(201);
  return res.body.id;
};

// Executes an action descriptor exactly as the Approval Center UI does.
const run = (who, action, comment) => {
  const body = { ...(action.body || {}) };
  if (action.commentKey && comment) body[action.commentKey] = comment;
  return request(app)[action.method](`/api${action.url}`).set(as(who)).send(body);
};

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZ Inbox A', 'ZZINBA'), ($2, 'ZZ Inbox B', 'ZZINBB')`, [A, B]);
  await login('mgr', 'manager', A, await emp('mgr', A));
  await login('req', 'employee', A, await emp('req', A, 'mgr'));
  await login('other', 'manager', A, await emp('other', A));
  await login('mgrB', 'manager', B, await emp('mgrB', B));
  await emp('reqB', B, 'mgrB');

  fx.travel.approve = await raiseTravel('req', 'Pune');
  fx.travel.reject  = await raiseTravel('req', 'Chennai');
}, 60000);

// The shared pool is NOT closed here (sharedPoolLifecycle.contract.test.js).
afterAll(cleanup);

describe('Approval Center inbox — real travel workflow', () => {
  it('the submitted requests appear in the requester\'s My Requests as Pending, with the current approver', async () => {
    const res = await api('req', 'get', '/approvals/my-requests');
    expect(res.status).toBe(200);
    const mine = res.body.submitted.filter((r) => r.type === 'travel');
    const row = mine.find((r) => r.id === `travel:${fx.travel.approve}`);
    expect(row).toBeTruthy();
    expect(row.status).toBe('Pending');
    expect(row.current_approver).toBe('Zz mgr');
    expect(row.link_page).toBe('TravelRequests');
    expect(mine.map((r) => r.id)).toContain(`travel:${fx.travel.reject}`);
  });

  it('they reach the reporting manager\'s My Pending Approvals with the travel module\'s own endpoint', async () => {
    const res = await api('mgr', 'get', '/approvals/pending');
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.id === `travel:${fx.travel.approve}`);
    expect(row).toMatchObject({ type: 'travel', can_act: true, stage: 'Reporting manager', sla_hours: 72, sla_source: 'configured' });
    expect(row.actions.approve).toMatchObject({ method: 'put', url: `/travel/requests/${fx.travel.approve}/status`, body: { status: 'Approved' } });
    expect(row.actions.reject.commentRequired).toBe(true);
  });

  it('nobody else sees them: not another manager, not a manager in another tenant, not the requester', async () => {
    for (const who of ['other', 'mgrB', 'req']) {
      const res = await api(who, 'get', '/approvals/pending');
      expect(res.status).toBe(200);
      expect(res.body.map((r) => r.id)).not.toContain(`travel:${fx.travel.approve}`);
    }
  });

  it('KPIs are computed from the same rows: 2 pending, none decided, SLA compliance has no data', async () => {
    const res = await api('mgr', 'get', '/approvals/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pending: 2, approvedToday: 0, rejectedToday: 0, slaCompliance: null, isApprover: true });
  });

  it('the generic Approval Center endpoint refuses a module record — the module decides it', async () => {
    const res = await api('mgr', 'post', `/approvals/travel:${fx.travel.approve}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USE_MODULE_ENDPOINT');
    const { rows } = await pool.query('SELECT status FROM travel_requests WHERE id = $1', [fx.travel.approve]);
    expect(rows[0].status).toBe('Pending');
  });

  it('a manager who is not the approver is refused by the module itself', async () => {
    const res = await api('other', 'put', `/travel/requests/${fx.travel.approve}/status`, { status: 'Approved' });
    expect(res.status).toBe(403);
  });

  it('approve and reject through the row actions decide the module records', async () => {
    const pending = (await api('mgr', 'get', '/approvals/pending')).body;
    const toApprove = pending.find((r) => r.id === `travel:${fx.travel.approve}`);
    const toReject  = pending.find((r) => r.id === `travel:${fx.travel.reject}`);
    expect((await run('mgr', toApprove.actions.approve, 'Approved — go ahead')).status).toBe(200);
    expect((await run('mgr', toReject.actions.reject, 'Merge with the Pune trip')).status).toBe(200);

    const { rows } = await pool.query('SELECT id, status FROM travel_requests WHERE id = ANY($1::int[]) ORDER BY id',
      [[fx.travel.approve, fx.travel.reject]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [fx.travel.approve]: 'Approved', [fx.travel.reject]: 'Rejected',
    });
    // Out of the queue once decided.
    const after = (await api('mgr', 'get', '/approvals/pending')).body.map((r) => r.id);
    expect(after).not.toContain(`travel:${fx.travel.approve}`);
    expect(after).not.toContain(`travel:${fx.travel.reject}`);
  });

  it('the requester sees the outcome in My Requests and is notified', async () => {
    const mine = (await api('req', 'get', '/approvals/my-requests')).body.submitted;
    expect(mine.find((r) => r.id === `travel:${fx.travel.approve}`)).toMatchObject({ status: 'Approved', current_approver: null });
    expect(mine.find((r) => r.id === `travel:${fx.travel.reject}`)).toMatchObject({ status: 'Rejected' });

    const notes = await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT title FROM notifications WHERE user_id = $1 ORDER BY id`, [fx.user.req]);
      return rows.length >= 2 ? rows : null;
    });
    expect(notes?.map((n) => n.title).join(' | ')).toMatch(/Approved/);
    expect(notes?.map((n) => n.title).join(' | ')).toMatch(/Rejected/);
    // The approver is not told "your request was approved".
    const { rows: mgrNotes } = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND title ILIKE '%Approved%'`, [fx.user.mgr]);
    expect(mgrNotes).toHaveLength(0);
  });

  it('the approver\'s Approval History and KPIs count both decisions', async () => {
    const history = await waitFor(async () => {
      const body = (await api('mgr', 'get', '/approvals/history')).body;
      return body.filter((h) => h.type === 'travel').length >= 2 ? body : null;
    });
    expect(history).toBeTruthy();
    const decisions = Object.fromEntries(history.filter((h) => h.type === 'travel')
      .map((h) => [h.id, h.decision]));
    expect(decisions[`travel:${fx.travel.approve}`]).toBe('Approved');
    expect(decisions[`travel:${fx.travel.reject}`]).toBe('Rejected');

    const stats = (await api('mgr', 'get', '/approvals/stats')).body;
    expect(stats).toMatchObject({ pending: 0, approvedToday: 1, rejectedToday: 1, slaDecisions: 2, slaCompliance: 100 });

    // The other manager decided nothing.
    const otherStats = (await api('other', 'get', '/approvals/stats')).body;
    expect(otherStats).toMatchObject({ approvedToday: 0, rejectedToday: 0, slaCompliance: null });
  });
});
