/**
 * Approvals security hardening — against the live database, the real leave,
 * travel, ECN, payment-batch and approvals routers, and real login tokens.
 *
 * For each module's decision routes:
 *   - same-company authorised decision succeeds, with its business effects
 *     (leave balance + history + notification, travel booking stub, ECN
 *     parallel approvers, payment batch processing);
 *   - another company's user gets 404 — never the record, never a write —
 *     even when the request carries a forged company / approver / delegate id;
 *   - an authenticated but ineligible user is refused;
 *   - a final record cannot be decided again;
 *   - two simultaneous decisions apply once.
 *
 * Fixtures live in registry tenants 999981/999982 (testTenantIds.contract) and
 * are deleted, company-scoped, in afterAll. The shared pool is NOT closed here
 * (sharedPoolLifecycle.contract). ⚠ Do not run during a Playwright crawl.
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
const { default: leavesRoutes } = await import('../modules/leaves/routes/leaves.routes.js');
const { default: travelRoutes } = await import('../modules/travel/travel.routes.js');
const { default: ecnRoutes } = await import('../modules/engineering/ecn.routes.js');
const { default: financeExtRoutes } = await import('../modules/finance/routes/extended.routes.js');
const { default: approvalsRoutes } = await import('../modules/approvals/approvals.routes.js');
// Processing needs a same-company bank account and Finance's payment mapping (PC-02b-0 B-02).
const { paymentGlFixture, dropPaymentGlFixtures } = await import('./helpers/paymentGlFixture.js');

const A = 999981;
const B = 999982;
const PW = 'Zz-ApSec-Test-9!';
const EMAIL = (k) => `zz.apsec.${k}@example.com`;
const fx = { tok: {}, user: {}, emp: {} };

const app = express();
app.use(express.json());
app.use('/api/leaves', verifyToken, leavesRoutes);
app.use('/api/travel', verifyToken, travelRoutes);
app.use('/api/engineering/ecn', verifyToken, ecnRoutes);
app.use('/api/finance', verifyToken, financeExtRoutes);
app.use('/api/approvals', verifyToken, approvalsRoutes);
const api = (who, method, url, body) =>
  request(app)[method](`/api${url}`).set({ Authorization: `Bearer ${fx.tok[who]}` }).send(body ?? {});
const both = (p1, p2) => Promise.all([p1, p2]).then((rs) => rs.map((r) => r.status).sort());

const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.apsec.%@example.com'`;
  const emps = `SELECT id FROM employees WHERE company_id = ANY($1::int[])`;
  const travel = `SELECT id FROM travel_requests WHERE company_id = ANY($1::int[])`;
  const ecns = `SELECT id FROM engineering_changes WHERE company_id = ANY($1::int[])`;
  const leaves = `SELECT id FROM leave_applications WHERE employee_id IN (${emps})`;
  await pool.query(`DELETE FROM workflow_instance_steps WHERE instance_id IN (SELECT id FROM workflow_instances
                      WHERE (module = 'travel' AND entity_id IN (${travel})) OR (module = 'leaves' AND entity_id IN (${leaves})))`, [c]);
  await pool.query(`DELETE FROM workflow_instances WHERE (module = 'travel' AND entity_id IN (${travel}))
                      OR (module = 'leaves' AND entity_id IN (${leaves}))`, [c]);
  await pool.query(`DELETE FROM travel_bookings WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM travel_requests WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM engineering_change_events WHERE engineering_change_id IN (${ecns})`, [c]);
  await pool.query(`DELETE FROM engineering_change_approvals WHERE engineering_change_id IN (${ecns})`, [c]);
  await pool.query(`DELETE FROM engineering_change_items WHERE engineering_change_id IN (${ecns})`, [c]);
  await pool.query(`DELETE FROM engineering_changes WHERE company_id = ANY($1::int[])`, [c]);
  await dropPaymentGlFixtures(pool, c);
  await pool.query(`DELETE FROM payment_batch_items WHERE batch_id IN (SELECT id FROM payment_batches WHERE company_id = ANY($1::int[]))`, [c]);
  await pool.query(`DELETE FROM payments WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM payment_batches WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM attendance_records WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM leave_applications WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM leave_balances WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM leave_types WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM approvals WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.apsec.%@example.com'`);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
async function person(key, role, cid, managerKey = null) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date, reporting_manager_id)
     VALUES ($1, $2, 'Zz', $3, $4, 'Active', '2024-01-01', $5) RETURNING id`,
    [cid, `EMP981${String(seq).padStart(3, '0')}`, key, EMAIL(`emp.${key}`), managerKey ? fx.emp[managerKey] : null],
  )).rows[0].id;
  if (!role) return;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING id`,
    [`Zz ${key}`, EMAIL(key), hash, role, cid, fx.emp[key]])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(EMAIL(key), PW)).token;
}

let leaveType;
let leaveSeq = 0;
const LEAVE_DATES = ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22', '2026-12-23'];
async function applyLeave() {
  const date = LEAVE_DATES[leaveSeq++];
  const res = await api('req', 'post', '/leaves/apply', {
    leave_type_id: leaveType, start_date: date, end_date: date, number_of_days: 1, reason: 'Zz security test',
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.id ?? res.body.application?.id ?? res.body.data?.id;
}
const usedDays = async () => Number((await one(
  `SELECT used_days FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = 2026`,
  [fx.emp.req, leaveType])).used_days);
const leave = (id) => one('SELECT * FROM leave_applications WHERE id = $1', [id]);

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZ ApSec A', 'ZZAPSA'), ($2, 'ZZ ApSec B', 'ZZAPSB')`, [A, B]);
  await person('mgr', 'manager', A);
  await person('req', 'employee', A, 'mgr');
  await person('other', 'manager', A);
  await person('hr', 'hr', A);
  await person('dh', 'department_head', A);
  await person('eng1', 'production_manager', A);
  await person('eng2', 'production_manager', A);
  await person('eng3', 'production_manager', A);
  await person('fin', 'finance', A);
  await person('fin2', 'finance', A);   // checker — the maker may not approve (policy 2026-10-20)
  await person('hrB', 'hr', B);
  await person('mgrB', 'manager', B);
  await person('engB', 'production_manager', B);
  await person('finB', 'finance', B);
  await person('empB', null, B, 'mgrB');
  fx.payingAccount = await paymentGlFixture(pool, A, fx.user.fin2);

  leaveType = (await one(
    `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active, l2_required)
     VALUES ('Zz Casual', 'ZZCL', 12, $1, true, true) RETURNING id`, [A])).id;
  await pool.query(
    `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days, opening_balance, carried_forward_days, encashed_days)
     VALUES ($1, $2, 2026, 12, 0, 0, 0, 0)`, [fx.emp.req, leaveType]);
}, 90000);

afterAll(cleanup);

// ── Leave ────────────────────────────────────────────────────────────────────
describe('Leave — L1 → L2 → HR, company and authority', () => {
  let id;
  it('L1: another company\'s HR gets 404 — even naming this company — and nothing changes', async () => {
    id = await applyLeave();
    const r = await api('hrB', 'post', `/leaves/approve/manager/${id}?company_id=${A}`, { company_id: A, comments: 'x' });
    expect(r.status).toBe(404);
    expect((await leave(id)).manager_status).toBe('pending');
  });

  it('L1: a manager who is not the reporting manager is refused, whatever approver id the body claims', async () => {
    const r = await api('other', 'post', `/leaves/approve/manager/${id}`, { approver_id: fx.emp.mgr, manager_id: fx.emp.mgr });
    expect(r.status).toBe(403);
  });

  it('L1: the reporting manager approves; the leave moves to L2', async () => {
    expect((await api('mgr', 'post', `/leaves/approve/manager/${id}`, { comments: 'ok' })).status).toBe(200);
    expect((await leave(id)).manager_status).toBe('approved');
  });

  it('L2: a manager (leaves:approve, not a department head) can no longer take the L2 decision', async () => {
    expect((await api('mgr', 'post', `/leaves/approve/l2/${id}`, {})).status).toBe(403);
    expect((await api('hrB', 'post', `/leaves/approve/l2/${id}`, {})).status).toBe(404);
    expect((await leave(id)).l2_status).not.toBe('approved');
  });

  it('L2: the department head approves', async () => {
    expect((await api('dh', 'post', `/leaves/approve/l2/${id}`, { comments: 'ok' })).status).toBe(200);
    expect((await leave(id)).l2_status).toBe('approved');
  });

  it('HR final: a manager is refused; another company\'s HR gets 404; two simultaneous HR approvals apply once', async () => {
    expect((await api('mgr', 'post', `/leaves/approve/hr/${id}`, {})).status).toBe(403);
    expect((await api('hrB', 'post', `/leaves/approve/hr/${id}`, {})).status).toBe(404);
    const before = await usedDays();
    const codes = await both(api('hr', 'post', `/leaves/approve/hr/${id}`, {}), api('hr', 'post', `/leaves/approve/hr/${id}`, {}));
    expect(codes).toEqual([200, 409]);
    expect((await leave(id)).status).toBe('approved');
    expect(await usedDays()).toBe(before + 1);
    const { rows } = await pool.query(
      `SELECT approval_level, action FROM leave_approval_history WHERE leave_application_id = $1 ORDER BY approval_level`, [id]);
    expect(rows.map((r) => `${r.approval_level}:${r.action}`)).toEqual(['1:approved', '2:approved', '3:approved']);
    const note = await waitFor(async () => one(
      `SELECT 1 AS ok FROM notifications WHERE user_id = $1 AND title ILIKE '%approved%'`, [fx.user.req]));
    expect(note?.ok).toBe(1);
  });

  it('a final leave cannot be decided again, reopened, or re-approved through the generic status route', async () => {
    const before = await usedDays();
    expect((await api('hr', 'post', `/leaves/approve/hr/${id}`, {})).status).toBe(409);
    expect((await api('hr', 'post', `/leaves/reject/hr/${id}`, { comments: 'late' })).status).toBe(409);
    expect((await api('hr', 'put', `/leaves/applications/${id}/status`, { status: 'pending' })).status).toBe(409);
    expect((await api('hr', 'put', `/leaves/applications/${id}/status`, { status: 'approved' })).status).toBe(409);
    expect(await usedDays()).toBe(before);
  });

  it('two simultaneous L1 approvals by the same manager apply once', async () => {
    const id2 = await applyLeave();
    const codes = await both(api('mgr', 'post', `/leaves/approve/manager/${id2}`, {}), api('mgr', 'post', `/leaves/approve/manager/${id2}`, {}));
    expect(codes).toEqual([200, 409]);
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM leave_approval_history WHERE leave_application_id = $1`, [id2]);
    expect(rows[0].n).toBe(1);
  });

  it('history and the single record are invisible to another company', async () => {
    expect((await api('hrB', 'get', `/leaves/applications/${id}`)).status).toBe(404);
    expect((await api('hrB', 'get', `/leaves/applications/${id}/history`)).status).toBe(404);
    expect((await api('hr', 'get', `/leaves/applications/${id}/history`)).body.length).toBe(3);
  });
});

describe('Leave — delegation and cancellation', () => {
  let id;
  it('only the entitled approver may delegate, only to an active same-company employee who is not the requester', async () => {
    id = await applyLeave();
    expect((await api('other', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.other })).status).toBe(403);
    expect((await api('hrB', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.mgrB })).status).toBe(404);
    expect((await api('mgr', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.empB })).status).toBe(400);
    expect((await api('mgr', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.req })).status).toBe(400);
    expect((await leave(id)).delegate_approver_id).toBeNull();
  });

  it('a valid delegation lets the delegate decide L1', async () => {
    expect((await api('mgr', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.other })).status).toBe(200);
    expect((await api('other', 'post', `/leaves/approve/manager/${id}`, { comments: 'as delegate' })).status).toBe(200);
    // L1 is closed — it can no longer be delegated.
    expect((await api('mgr', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.dh })).status).toBe(409);
  });

  it('the generic status route cannot cancel somebody else\'s leave; the requester can withdraw their own', async () => {
    const id3 = await applyLeave();
    expect((await api('other', 'put', `/leaves/applications/${id3}/status`, { status: 'cancelled' })).status).toBe(403);
    expect((await leave(id3)).status).toBe('pending');
    expect((await api('hrB', 'post', `/leaves/${id3}/withdraw`, { reason: 'x' })).status).toBe(404);
    expect((await api('req', 'post', `/leaves/${id3}/withdraw`, { reason: 'Plans changed' })).status).toBe(200);
    expect((await leave(id3)).status).toBe('cancelled');
  });
});

// ── Travel ───────────────────────────────────────────────────────────────────
const raiseTravel = async (dest) => {
  const r = await api('req', 'post', '/travel/requests', {
    destination: dest, purpose: 'Zz', from_date: '2026-12-01', to_date: '2026-12-02', budget: 4500.5, mode: 'Train',
  });
  expect(r.status).toBe(201);
  return r.body.id;
};
const travelStatus = async (id) => (await one('SELECT status FROM travel_requests WHERE id = $1', [id])).status;

describe('Travel — status route', () => {
  let id;
  it('another company is 404 even with a forged company id; a non-approver is 403; nothing changes', async () => {
    id = await raiseTravel('Pune');
    expect((await api('mgrB', 'put', `/travel/requests/${id}/status?company_id=${A}`, { status: 'Approved', company_id: A })).status).toBe(404);
    expect((await api('hrB', 'put', `/travel/requests/${id}/status`, { status: 'Rejected' })).status).toBe(404);
    expect((await api('other', 'put', `/travel/requests/${id}/status`, { status: 'Approved' })).status).toBe(403);
    expect(await travelStatus(id)).toBe('Pending');
  });

  it('the reporting manager approves (lower-case status as ManagerDashboard sends); a booking stub is created once', async () => {
    expect((await api('mgr', 'put', `/travel/requests/${id}/status`, { status: 'approved' })).status).toBe(200);
    expect(await travelStatus(id)).toBe('Approved');
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM travel_bookings WHERE travel_request_id = $1', [id]);
    expect(rows[0].n).toBe(1);
  });

  it('an approved request cannot be re-decided or reopened', async () => {
    expect((await api('mgr', 'put', `/travel/requests/${id}/status`, { status: 'Rejected' })).status).toBe(409);
    expect((await api('mgr', 'put', `/travel/requests/${id}/status`, { status: 'Approved' })).status).toBe(409);
    expect((await api('hr', 'put', `/travel/requests/${id}/status`, { status: 'Pending' })).status).toBe(409);
    expect(await travelStatus(id)).toBe('Approved');
  });

  it('two simultaneous decisions: one wins, one 409, one audit row, one booking stub', async () => {
    const id2 = await raiseTravel('Chennai');
    const codes = await both(
      api('mgr', 'put', `/travel/requests/${id2}/status`, { status: 'Approved' }),
      api('mgr', 'put', `/travel/requests/${id2}/status`, { status: 'Rejected', comments: 'no' }));
    expect(codes).toEqual([200, 409]);
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM travel_bookings WHERE travel_request_id = $1', [id2]);
    expect(rows[0].n).toBeLessThanOrEqual(1);
    const audits = await waitFor(async () => {
      const r = await one(`SELECT COUNT(*)::int n FROM audit_logs WHERE module_name = 'travel' AND reference_type = 'travel_request'
                            AND reference_id::text = $1::text AND action_type IN ('approve', 'reject')`, [id2]);
      return r.n >= 1 ? r.n : null;
    });
    expect(audits).toBe(1);
  });

  it('delegation: another company 404; delegate must be same-company and not the requester', async () => {
    const id3 = await raiseTravel('Mumbai');
    expect((await api('hrB', 'post', `/travel/requests/${id3}/delegate`, { delegate_employee_id: fx.emp.mgrB })).status).toBe(404);
    expect((await api('mgr', 'post', `/travel/requests/${id3}/delegate`, { delegate_employee_id: fx.emp.empB })).status).toBe(400);
    expect((await api('mgr', 'post', `/travel/requests/${id3}/delegate`, { delegate_employee_id: fx.emp.req })).status).toBe(400);
    expect((await api('mgr', 'post', `/travel/requests/${id3}/delegate`, { delegate_employee_id: fx.emp.other })).status).toBe(200);
    expect((await api('other', 'put', `/travel/requests/${id3}/status`, { status: 'Approved' })).status).toBe(200);
  });

  it('level-approve, finance-post and the approval trail are company-scoped; the configured 72h SLA is unchanged', async () => {
    const id4 = await raiseTravel('Delhi');
    expect((await api('mgrB', 'put', `/travel/requests/${id4}/level-approve`, { status: 'Approved' })).status).toBe(404);
    expect((await api('finB', 'put', `/travel/requests/${id}/finance-post`, { payment_ref: 'X' })).status).toBe(404);
    expect((await api('mgrB', 'get', `/travel/requests/${id4}/approvals`)).body).toEqual([]);
    const sla = await one(`SELECT ws.sla_hours FROM workflow_steps ws JOIN workflows w ON w.id = ws.workflow_id
                            WHERE w.module = 'travel' AND ws.sla_hours IS NOT NULL LIMIT 1`);
    expect(Number(sla.sla_hours)).toBe(72);
    const row = (await api('mgr', 'get', '/approvals/pending')).body.find((r) => r.id === `travel:${id4}`);
    expect(row).toMatchObject({ sla_hours: 72, sla_source: 'configured', can_act: true });
  });
});

// ── ECN ──────────────────────────────────────────────────────────────────────
async function raiseEcn(approverKeys) {
  const c = await api('eng3', 'post', '/engineering/ecn/changes', {
    title: 'Zz bracket change', approvers: approverKeys.map((k) => ({ approver_id: fx.user[k], approver_name: k })),
  });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const it1 = await api('eng3', 'post', `/engineering/ecn/changes/${c.body.id}/items`, { item_type: 'drawing', item_code: 'ZZ-1' });
  expect(it1.status, JSON.stringify(it1.body)).toBe(201);
  expect((await api('eng3', 'post', `/engineering/ecn/changes/${c.body.id}/submit`)).status).toBe(200);
  return c.body.id;
}
const ecnStatus = async (id) => (await one('SELECT status FROM engineering_changes WHERE id = $1', [id])).status;

describe('ECN — parallel approvers and company scope', () => {
  let id;
  it('another company cannot read, approve, reject or submit it', async () => {
    id = await raiseEcn(['eng1', 'eng2']);
    expect((await api('engB', 'get', `/engineering/ecn/changes/${id}`)).status).toBe(404);
    expect((await api('engB', 'post', `/engineering/ecn/changes/${id}/approve`, { company_id: A })).status).toBe(404);
    expect((await api('engB', 'post', `/engineering/ecn/changes/${id}/reject`, {})).status).toBe(404);
    expect((await api('engB', 'post', `/engineering/ecn/changes/${id}/implement`, {})).status).toBe(404);
    expect(await ecnStatus(id)).toBe('submitted');
  });

  it('a non-approver can neither approve (was a silent success) nor reject (used to reject the whole change)', async () => {
    expect((await api('eng3', 'post', `/engineering/ecn/changes/${id}/approve`, {})).status).toBe(403);
    expect((await api('eng3', 'post', `/engineering/ecn/changes/${id}/reject`, { remarks: 'no' })).status).toBe(403);
    expect(await ecnStatus(id)).toBe('submitted');
  });

  it('one approver\'s decision does not approve the change; a second click is refused; the last approver completes it', async () => {
    const r1 = await api('eng1', 'post', `/engineering/ecn/changes/${id}/approve`, {});
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: 'submitted', approvals_pending: 1 });
    expect((await api('eng1', 'post', `/engineering/ecn/changes/${id}/approve`, {})).status).toBe(403);
    expect(await ecnStatus(id)).toBe('submitted');
    expect((await api('eng2', 'post', `/engineering/ecn/changes/${id}/approve`, {})).body.status).toBe('approved');
    expect((await api('eng2', 'post', `/engineering/ecn/changes/${id}/reject`, {})).status).toBe(409);
    expect(await ecnStatus(id)).toBe('approved');
  });

  it('two simultaneous approvals by the same approver record one decision', async () => {
    const id2 = await raiseEcn(['eng1', 'eng2']);
    const codes = await both(api('eng1', 'post', `/engineering/ecn/changes/${id2}/approve`, {}),
      api('eng1', 'post', `/engineering/ecn/changes/${id2}/approve`, {}));
    expect(codes).toEqual([200, 403]);
    expect(await ecnStatus(id2)).toBe('submitted');
  });
});

// ── Payment batches ──────────────────────────────────────────────────────────
describe('Payment batches — company scope and transitions', () => {
  let id;
  it('another company cannot read, download, approve or reject it', async () => {
    const c = await api('fin', 'post', '/finance/payment-batches', { status: 'pending_approval', notes: 'Zz', company_id: B, bank_account_id: fx.payingAccount });
    expect(c.status).toBe(201);
    id = c.body.id;
    expect(c.body.company_id).toBe(A);            // forged body company ignored
    expect((await api('finB', 'get', `/finance/payment-batches/${id}`)).status).toBe(404);
    expect((await api('finB', 'get', `/finance/payment-batches/${id}/bank-file`)).status).toBe(404);
    expect((await api('finB', 'post', `/finance/payment-batches/${id}/approve`, { company_id: A })).status).toBe(404);
    expect((await api('finB', 'post', `/finance/payment-batches/${id}/reject`, { reason: 'x' })).status).toBe(404);
    expect((await one('SELECT status FROM payment_batches WHERE id = $1', [id])).status).toBe('pending_approval');
  });

  it('same-company approval; then no re-approval, rejection or resubmission of an approved batch', async () => {
    expect((await api('fin2', 'post', `/finance/payment-batches/${id}/approve`)).status).toBe(200);
    expect((await api('fin2', 'post', `/finance/payment-batches/${id}/approve`)).status).toBe(409);
    expect((await api('fin', 'post', `/finance/payment-batches/${id}/reject`, { reason: 'x' })).status).toBe(409);
    expect((await api('fin', 'post', `/finance/payment-batches/${id}/submit`)).status).toBe(409);
    expect((await one('SELECT status FROM payment_batches WHERE id = $1', [id])).status).toBe('approved');
  });

  it('two simultaneous process calls pay once', async () => {
    // B-04: a released bank file comes first (this batch has no lines).
    expect((await api('fin', 'post', `/finance/payment-batches/${id}/release`, {})).status).toBe(201);
    const codes = await both(api('fin', 'post', `/finance/payment-batches/${id}/process`, {}),
      api('fin', 'post', `/finance/payment-batches/${id}/process`, {}));
    expect(codes).toEqual([200, 409]);
    expect((await one('SELECT status FROM payment_batches WHERE id = $1', [id])).status).toBe('processed');
    expect((await api('finB', 'post', `/finance/payment-batches/${id}/process`, {})).status).toBe(404);
  });
});

// ── Consolidated Approval Center stays consistent ────────────────────────────
describe('Approval Center over the hardened routes', () => {
  it('queues are tenant-scoped, module records stay on their own endpoints, the requester view works', async () => {
    const id = await applyLeave();
    const mine = (await api('mgr', 'get', '/approvals/pending')).body.find((r) => r.id === `leave:${id}`);
    expect(mine.actions.approve.url).toBe(`/leaves/approve/manager/${id}`);
    expect((await api('mgrB', 'get', '/approvals/pending')).body.some((r) => r.id === `leave:${id}`)).toBe(false);
    expect((await api('hrB', 'get', '/approvals/pending')).body.some((r) => String(r.id).startsWith('travel:'))).toBe(false);
    expect((await api('mgr', 'post', `/approvals/leave:${id}/approve`)).body.code).toBe('USE_MODULE_ENDPOINT');
    const reqView = (await api('req', 'get', '/approvals/my-requests')).body.submitted;
    expect(reqView.find((r) => r.id === `leave:${id}`)).toMatchObject({ status: 'Pending' });
    expect((await api('mgrB', 'get', '/approvals/history')).body.some((h) => h.type === 'leave')).toBe(false);
  });
});
