/**
 * Approval policies (2026-10-20) — against the live database, the real leave,
 * ECN, payment-batch and approvals routers, and real login tokens.
 *
 *   1. Nobody decides their own leave — L1, L2, HR-final, delegation, the
 *      generic status / bulk / workflow routes. The leave stays pending for
 *      another eligible approver; if there is none, it stays pending and the
 *      error says an administrator has to provide one.
 *   2. An ECN is decided only by its named approvers: none → cannot be
 *      submitted, and one already submitted without any fails closed.
 *   3. A payment batch's creator cannot approve it (maker ≠ checker).
 *
 * Fixtures live in registry tenants 999983/999984 (testTenantIds.contract) and
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
const { default: ecnRoutes } = await import('../modules/engineering/ecn.routes.js');
const { default: financeExtRoutes } = await import('../modules/finance/routes/extended.routes.js');
const { default: approvalsRoutes } = await import('../modules/approvals/approvals.routes.js');
// Processing needs a same-company bank account and Finance's payment mapping (PC-02b-0 B-02).
const { paymentGlFixture, dropPaymentGlFixtures, verifiedVendorFixture } = await import('./helpers/paymentGlFixture.js');

const A = 999983;
const B = 999984;
const PW = 'Zz-ApPol-Test-9!';
const EMAIL = (k) => `zz.appol.${k}@example.com`;
const fx = { tok: {}, user: {}, emp: {}, type: {} };

const app = express();
app.use(express.json());
app.use('/api/leaves', verifyToken, leavesRoutes);
app.use('/api/engineering/ecn', verifyToken, ecnRoutes);
app.use('/api/finance', verifyToken, financeExtRoutes);
app.use('/api/approvals', verifyToken, approvalsRoutes);
const api = (who, method, url, body) =>
  request(app)[method](`/api${url}`).set({ Authorization: `Bearer ${fx.tok[who]}` }).send(body ?? {});
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.appol.%@example.com'`;
  const emps = `SELECT id FROM employees WHERE company_id = ANY($1::int[])`;
  const ecns = `SELECT id FROM engineering_changes WHERE company_id = ANY($1::int[])`;
  const leaves = `SELECT id FROM leave_applications WHERE employee_id IN (${emps})`;
  await pool.query(`DELETE FROM workflow_instance_steps WHERE instance_id IN
                      (SELECT id FROM workflow_instances WHERE module = 'leaves' AND entity_id IN (${leaves}))`, [c]);
  await pool.query(`DELETE FROM workflow_instances WHERE module = 'leaves' AND entity_id IN (${leaves})`, [c]);
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
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.appol.%@example.com'`);
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
    [cid, `EMP983${String(seq).padStart(3, '0')}`, key, EMAIL(`emp.${key}`), managerKey ? fx.emp[managerKey] : null],
  )).rows[0].id;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING id`,
    [`Zz ${key}`, EMAIL(key), hash, role, cid, fx.emp[key]])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(EMAIL(key), PW)).token;
}

async function leaveTypeFor(cid) {
  fx.type[cid] = (await one(
    `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active, l2_required)
     VALUES ('Zz Policy Leave', 'ZZPL', 12, $1, true, true) RETURNING id`, [cid])).id;
}
async function balanceFor(key, cid) {
  await pool.query(
    `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days, opening_balance, carried_forward_days, encashed_days)
     VALUES ($1, $2, 2026, 12, 0, 0, 0, 0)`, [fx.emp[key], fx.type[cid]]);
}
const DATES = ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-14', '2026-12-15', '2026-12-16'];
let dateSeq = 0;
async function applyLeave(key, cid) {
  const d = DATES[dateSeq++];
  const r = await api(key, 'post', '/leaves/apply', {
    leave_type_id: fx.type[cid], start_date: d, end_date: d, number_of_days: 1, reason: 'Zz policy test',
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body.id ?? r.body.application?.id ?? r.body.data?.id;
}
const leave = (id) => one('SELECT * FROM leave_applications WHERE id = $1', [id]);
const used = async (key, cid) => Number((await one(
  'SELECT used_days FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = 2026',
  [fx.emp[key], fx.type[cid]])).used_days);

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZ ApPol A', 'ZZAPPA'), ($2, 'ZZ ApPol B', 'ZZAPPB')`, [A, B]);
  // Company A — every level has more than one eligible approver.
  await person('mgr', 'manager', A);
  await person('req', 'employee', A, 'mgr');
  await person('dh1', 'department_head', A, 'mgr');
  await person('dh2', 'department_head', A);
  await person('hr1', 'hr', A, 'mgr');
  await person('hr2', 'hr', A);
  await person('engR', 'production_manager', A);
  await person('eng1', 'production_manager', A);
  await person('eng2', 'production_manager', A);
  await person('engX', 'production_manager', A);
  await person('fin1', 'finance', A);
  await person('fin2', 'finance', A);
  // Company B — the department head is the ONLY L2-eligible user; one finance user.
  await person('mgrB', 'manager', B);
  await person('dhB', 'department_head', B, 'mgrB');
  await person('finB', 'finance', B);
  fx.payingAccount = await paymentGlFixture(pool, A, fx.user.fin2);
  await leaveTypeFor(A);
  await leaveTypeFor(B);
  for (const k of ['req', 'dh1', 'hr1']) await balanceFor(k, A);
  await balanceFor('dhB', B);
}, 120000);

afterAll(cleanup);

// ── 1. Leave self-approval ───────────────────────────────────────────────────
describe('Leave: nobody decides their own leave', () => {
  it('a normal L1 → L2 → HR approval by three other people still succeeds and deducts balance', async () => {
    const id = await applyLeave('req', A);
    const before = await used('req', A);
    expect((await api('mgr', 'post', `/leaves/approve/manager/${id}`)).status).toBe(200);
    expect((await api('dh2', 'post', `/leaves/approve/l2/${id}`)).status).toBe(200);
    expect((await api('hr1', 'post', `/leaves/approve/hr/${id}`)).status).toBe(200);
    expect((await leave(id)).status).toBe('approved');
    expect(await used('req', A)).toBe(before + 1);
    // The requester's consolidated view and trail agree with the module.
    const mine = (await api('req', 'get', '/approvals/my-requests')).body.submitted.find((r) => r.id === `leave:${id}`);
    expect(mine).toMatchObject({ status: 'Approved', current_approver: null });
    const trail = (await api('req', 'get', `/approvals/leave:${id}/chain`)).body.map((c) => `${c.step} ${c.status}`);
    expect(trail).toEqual(['L1 Approved', 'L2 Approved', 'L3 Approved']);
  });

  it('a department head cannot take the L2 decision on their own leave by direct API call; another department head can', async () => {
    const id = await applyLeave('dh1', A);
    expect((await api('mgr', 'post', `/leaves/approve/manager/${id}`)).status).toBe(200);
    const self = await api('dh1', 'post', `/leaves/approve/l2/${id}`, { comments: 'mine', approver_id: fx.emp.dh2 });
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ code: 'SELF_APPROVAL_BLOCKED', level: 'l2', eligible_alternates: 1 });
    expect((await api('dh1', 'post', `/leaves/reject/l2/${id}`, { comments: 'mine' })).status).toBe(403);
    expect((await leave(id)).l2_status).not.toBe('approved');
    // It is in the other department head's inbox, not the requester's.
    expect((await api('dh1', 'get', '/approvals/pending')).body.some((r) => r.id === `leave:${id}`)).toBe(false);
    expect((await api('dh2', 'get', '/approvals/pending')).body.some((r) => r.id === `leave:${id}`)).toBe(true);
    expect((await api('dh2', 'post', `/leaves/approve/l2/${id}`)).status).toBe(200);
  });

  it('HR cannot decide their own leave at L1 (HR override), HR-final, the generic status route, bulk approve or workflow advance', async () => {
    const id = await applyLeave('hr1', A);
    const l1 = await api('hr1', 'post', `/leaves/approve/manager/${id}`);
    expect(l1.status).toBe(403);
    expect(l1.body.code).toBe('SELF_APPROVAL_BLOCKED');
    expect((await api('mgr', 'post', `/leaves/approve/manager/${id}`)).status).toBe(200);
    expect((await api('dh2', 'post', `/leaves/approve/l2/${id}`)).status).toBe(200);
    const before = await used('hr1', A);
    expect((await api('hr1', 'post', `/leaves/approve/hr/${id}`)).status).toBe(403);
    expect((await api('hr1', 'put', `/leaves/applications/${id}/status`, { status: 'approved' })).status).toBe(403);
    expect((await api('hr1', 'patch', `/leaves/${id}/approve`)).status).toBe(403);
    const bulk = await api('hr1', 'post', '/leaves/bulk-approve', { ids: [id] });
    expect(bulk.body.results[0]).toMatchObject({ status: 'error', code: 'SELF_APPROVAL_BLOCKED' });
    expect((await api('hr1', 'post', `/leaves/${id}/workflow/advance`, { action: 'approve' })).status).toBe(403);
    expect((await leave(id)).status).toBe('pending');
    expect(await used('hr1', A)).toBe(before);
    // Another HR user completes it.
    expect((await api('hr2', 'post', `/leaves/approve/hr/${id}`)).status).toBe(200);
    expect(await used('hr1', A)).toBe(before + 1);
  });

  it('delegation cannot be used to route your own leave to someone you choose', async () => {
    const id = await applyLeave('hr1', A);
    const r = await api('hr1', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.hr2 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SELF_APPROVAL_BLOCKED');
    expect((await leave(id)).delegate_approver_id).toBeNull();
    // ...and the requester can never be made the delegate of their own leave.
    expect((await api('mgr', 'post', `/leaves/delegate/${id}`, { delegate_employee_id: fx.emp.hr1 })).status).toBe(400);
  });

  it('with no other eligible approver the leave stays pending and the error says an administrator must provide one', async () => {
    const id = await applyLeave('dhB', B);
    expect((await api('mgrB', 'post', `/leaves/approve/manager/${id}`)).status).toBe(200);
    const r = await api('dhB', 'post', `/leaves/approve/l2/${id}`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'SELF_APPROVAL_BLOCKED', eligible_alternates: 0 });
    expect(r.body.error).toMatch(/administrator/i);
    const row = await leave(id);
    expect(row.status).toBe('pending');
    expect(row.l2_status === null || row.l2_status === 'pending').toBe(true);
  });

  it('the requester can still withdraw their own pending leave', async () => {
    const id = await applyLeave('req', A);
    expect((await api('req', 'post', `/leaves/${id}/withdraw`, { reason: 'Plans changed' })).status).toBe(200);
    expect((await leave(id)).status).toBe('cancelled');
  });
});

// ── 2. ECN named approvers ───────────────────────────────────────────────────
async function createEcn(approverKeys) {
  const c = await api('engR', 'post', '/engineering/ecn/changes', {
    title: 'Zz policy change', approvers: approverKeys.map((k) => ({ approver_id: fx.user[k] })),
  });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  expect((await api('engR', 'post', `/engineering/ecn/changes/${c.body.id}/items`, { item_type: 'drawing', item_code: 'ZZ-P' })).status).toBe(201);
  return c.body.id;
}
const ecn = (id) => one('SELECT status FROM engineering_changes WHERE id = $1', [id]);

describe('ECN: decided only by named approvers', () => {
  it('with named approvers the parallel rule is unchanged', async () => {
    const id = await createEcn(['eng1', 'eng2']);
    expect((await api('engR', 'post', `/engineering/ecn/changes/${id}/submit`)).status).toBe(200);
    expect((await api('eng1', 'post', `/engineering/ecn/changes/${id}/approve`)).body).toMatchObject({ status: 'submitted', approvals_pending: 1 });
    expect((await api('engX', 'post', `/engineering/ecn/changes/${id}/approve`)).status).toBe(403);
    expect((await api('eng2', 'post', `/engineering/ecn/changes/${id}/approve`)).body.status).toBe('approved');
  });

  it('a change with no approvers cannot be submitted — clear error, state unchanged', async () => {
    const id = await createEcn([]);
    const r = await api('engR', 'post', `/engineering/ecn/changes/${id}/submit`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('APPROVERS_REQUIRED');
    expect(r.body.error).toMatch(/approvers/);
    expect((await ecn(id)).status).toBe('draft');
  });

  it('one already submitted without approvers (pre-policy data) fails closed for anyone with engineering:add', async () => {
    const id = await createEcn([]);
    await pool.query(`UPDATE engineering_changes SET status = 'submitted' WHERE id = $1 AND company_id = $2`, [id, A]);
    for (const [who, action] of [['engX', 'approve'], ['engR', 'approve'], ['engX', 'reject']]) {
      const r = await api(who, 'post', `/engineering/ecn/changes/${id}/${action}`, { remarks: 'x' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('APPROVER_CONFIGURATION_REQUIRED');
      expect(r.body.error).toMatch(/PUT \/engineering\/ecn\/changes/);
    }
    expect((await ecn(id)).status).toBe('submitted');
    expect((await api('engX', 'get', '/approvals/pending')).body.some((r) => r.id === `ecn:${id}`)).toBe(false);

    // Resolution path: name an approver on the existing change, who then decides it.
    expect((await api('engR', 'put', `/engineering/ecn/changes/${id}`, { approvers: [{ approver_id: fx.user.engR }] })).status).toBe(400);
    expect((await api('engR', 'put', `/engineering/ecn/changes/${id}`, { approvers: [{ approver_id: fx.user.finB }] })).status).toBe(400);
    expect((await api('engR', 'put', `/engineering/ecn/changes/${id}`, { approvers: [{ approver_id: fx.user.eng1 }] })).status).toBe(200);
    expect((await api('engR', 'put', `/engineering/ecn/changes/${id}`, { approvers: [{ approver_id: fx.user.eng2 }] })).status).toBe(409);
    expect((await api('eng1', 'post', `/engineering/ecn/changes/${id}/approve`)).body.status).toBe('approved');
  });

  it('full path: created without approvers -> approvers named -> submit -> parallel approval -> implement', async () => {
    const id = await createEcn([]);
    expect((await api('engR', 'post', `/engineering/ecn/changes/${id}/submit`)).status).toBe(400);
    // A same-company user WITHOUT engineering access cannot be named (what the picker saves through).
    const noAccess = await api('engR', 'put', `/engineering/ecn/changes/${id}`, { approvers: [{ approver_id: fx.user.hr1 }] });
    expect(noAccess.status).toBe(400);
    expect(noAccess.body.code).toBe('INVALID_APPROVERS');
    const named = await api('engR', 'put', `/engineering/ecn/changes/${id}`, {
      approvers: [{ approver_id: fx.user.eng1 }, { approver_id: fx.user.eng2 }, { approver_id: fx.user.eng1 }] });
    expect(named.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT approver_id, approver_name, status FROM engineering_change_approvals
        WHERE engineering_change_id = $1 ORDER BY approver_id`, [id]);
    expect(rows.map((r) => r.approver_id)).toEqual([fx.user.eng1, fx.user.eng2].sort((x, y) => x - y)); // de-duplicated
    expect(rows.every((r) => r.status === 'pending' && r.approver_name)).toBe(true);
    expect((await api('engR', 'post', `/engineering/ecn/changes/${id}/submit`)).status).toBe(200);
    expect((await api('eng2', 'post', `/engineering/ecn/changes/${id}/approve`)).body.status).toBe('submitted');
    expect((await api('engR', 'post', `/engineering/ecn/changes/${id}/implement`)).status).toBe(400); // not approved yet
    expect((await api('eng1', 'post', `/engineering/ecn/changes/${id}/approve`)).body.status).toBe('approved');
    expect((await api('engR', 'post', `/engineering/ecn/changes/${id}/implement`)).status).toBe(200);
    expect((await ecn(id)).status).toBe('implemented');
  });

  it('approvers named at creation are vetted: not the requester, not another company\'s user', async () => {
    const self = await api('engR', 'post', '/engineering/ecn/changes', { title: 'Zz', approvers: [{ approver_id: fx.user.engR }] });
    expect(self.status).toBe(400);
    const foreign = await api('engR', 'post', '/engineering/ecn/changes', { title: 'Zz', approvers: [{ approver_id: fx.user.finB }] });
    expect(foreign.status).toBe(400);
  });
});

// ── 3. Payment batch maker ≠ checker ─────────────────────────────────────────
const batch = (id) => one('SELECT status, approved_by, approved_at FROM payment_batches WHERE id = $1', [id]);
const createBatch = async (who) => {
  const r = await api(who, 'post', '/finance/payment-batches', { status: 'pending_approval', notes: 'Zz policy', bank_account_id: fx.payingAccount });
  expect(r.status).toBe(201);
  return r.body.id;
};

describe('Payment batch: the creator cannot approve it', () => {
  let id;
  it('the creator\'s approval is refused with nothing written, paid, or announced', async () => {
    id = await createBatch('fin1');
    const r = await api('fin1', 'post', `/finance/payment-batches/${id}/approve`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'SELF_APPROVAL_BLOCKED', eligible_alternates: 1 });
    expect(await batch(id)).toMatchObject({ status: 'pending_approval', approved_by: null, approved_at: null });
    expect((await one('SELECT COUNT(*)::int n FROM payments WHERE company_id = $1', [A])).n).toBe(0);
    expect((await one(`SELECT COUNT(*)::int n FROM notifications WHERE user_id = ANY($1::int[]) AND title ILIKE '%approved%'`,
      [[fx.user.fin1, fx.user.fin2]])).n).toBe(0);
    expect((await one(`SELECT COUNT(*)::int n FROM audit_logs WHERE user_id = $1 AND action_type ILIKE '%approv%'`,
      [fx.user.fin1])).n).toBe(0);
    expect((await api('fin1', 'get', '/approvals/pending')).body.some((r2) => r2.id === `pay:${id}`)).toBe(false);
    expect((await api('fin2', 'get', '/approvals/pending')).body.some((r2) => r2.id === `pay:${id}`)).toBe(true);
  });

  it('another company cannot approve it; a different eligible approver can — once, even when double-clicked', async () => {
    expect((await api('finB', 'post', `/finance/payment-batches/${id}/approve`)).status).toBe(404);
    const codes = (await Promise.all([
      api('fin2', 'post', `/finance/payment-batches/${id}/approve`),
      api('fin2', 'post', `/finance/payment-batches/${id}/approve`),
    ])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(await batch(id)).toMatchObject({ status: 'approved', approved_by: fx.user.fin2 });
  });

  it('processing is unchanged — the creator may process an approved batch, and only once', async () => {
    // B-04: a released bank file comes first (this batch has no lines).
    expect((await api('fin1', 'post', `/finance/payment-batches/${id}/release`, {})).status).toBe(201);
    const codes = (await Promise.all([
      api('fin1', 'post', `/finance/payment-batches/${id}/process`, {}),
      api('fin1', 'post', `/finance/payment-batches/${id}/process`, {}),
    ])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect((await batch(id)).status).toBe('processed');
  });

  it('a batch with lines: independent approval, then processing creates one payment per line, once', async () => {
    const c = await api('fin1', 'post', '/finance/payment-batches', {
      status: 'pending_approval', notes: 'Zz lines', bank_account_id: fx.payingAccount,
      items: [
        { supplier_name: 'Zz Supplier One', supplier_id: (await verifiedVendorFixture(pool, A)).vendorId, amount: 1250.75 },
        { supplier_name: 'Zz Supplier Two', supplier_id: (await verifiedVendorFixture(pool, A)).vendorId, amount: 300.5 },
      ],
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const bid = c.body.id;
    expect((await api('fin1', 'post', `/finance/payment-batches/${bid}/approve`)).status).toBe(403);
    expect((await api('fin2', 'post', `/finance/payment-batches/${bid}/approve`)).status).toBe(200);
    expect((await api('fin2', 'post', `/finance/payment-batches/${bid}/release`, {})).status).toBe(201);
    const codes = (await Promise.all([
      api('fin2', 'post', `/finance/payment-batches/${bid}/process`, {}),
      api('fin2', 'post', `/finance/payment-batches/${bid}/process`, {}),
    ])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    const { rows: items } = await pool.query(
      'SELECT payment_id FROM payment_batch_items WHERE batch_id = $1 ORDER BY id', [bid]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.payment_id != null)).toBe(true);
    const { rows: [{ n, total }] } = await pool.query(
      'SELECT COUNT(*)::int n, SUM(amount)::numeric total FROM payments WHERE id = ANY($1::int[])', [items.map((i) => i.payment_id)]);
    expect(n).toBe(2);
    expect(Number(total)).toBeCloseTo(1551.25, 2);
    expect((await one('SELECT COUNT(*)::int n FROM payments WHERE company_id = $1', [A])).n).toBe(2);
  });

  it('with no independent approver in the company the batch stays pending and the error says so', async () => {
    const idB = await createBatch('finB');
    const r = await api('finB', 'post', `/finance/payment-batches/${idB}/approve`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'SELF_APPROVAL_BLOCKED', eligible_alternates: 0 });
    expect(r.body.error).toMatch(/administrator/i);
    expect((await batch(idB)).status).toBe('pending_approval');
  });
});
