/**
 * Expense claims — ONE authoritative claim record and workflow (§202).
 *
 * Every claim (Travel → Expense Claims, or Self-Service → Reimbursements) is one
 * expense_claims row moved by travel-reimbursement.routes.js:
 *   Draft → Submitted → Manager Approved → Accounts Verified → Mgmt Approved → Paid
 * Proven here: filed only for oneself; duplicates refused; numbers unique across
 * companies; who may read; each level's explicit grant; nobody acts on their own
 * claim; every step is one atomic transition (a second attempt is 409); payment
 * needs valid bank details for a bank mode, settles once and posts one project
 * cost row even under a race; nothing crosses companies; Finance's old claim
 * mutations are retired and post no journal.
 *
 * Real routers and database, grants from the role matrix (migration
 * 20261029000001). Two throwaway companies; every claim, approval, cost row,
 * employee and login is created here and removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const notify = vi.hoisted(() => ({ calls: [] }));
// The real service defers a DB insert past the response (setImmediate); capture instead.
vi.mock('../services/WorkflowNotificationService.js', () => ({
  notifyWorkflowEvent: (event, ctx) => { notify.calls.push({ event, ctx }); },
  EVENT_MAP: {},
}));

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }          = await import('../config/db.js');
const { verifyToken }            = await import('../middlewares/auth.middleware.js');
const { buildApp }               = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: claimRoutes }   = await import('../modules/travel/travel-reimbursement.routes.js');
const { default: financeRoutes } = await import('../modules/finance/routes/finance.routes.js');

const app = buildApp(
  ['/api/reimbursement', verifyToken, claimRoutes],
  ['/api/finance', verifyToken, financeRoutes],
);

const PREFIX = 'ZZEXCL';
const TODAY = new Date().toISOString().slice(0, 10);
let co, other, claimant, peer, mgr, accounts, mgmt, otherFin, unlinked;
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const claimRow = async (id) => (await pool.query(`SELECT * FROM expense_claims WHERE id = $1`, [id])).rows[0];
const costRows = async (id) => (await pool.query(
  `SELECT COUNT(*)::int n FROM travel_cost_transactions WHERE source_type='expense_claim' AND source_id = $1`, [id])).rows[0].n;

async function sweep(companyId) {
  const claims = `(SELECT id FROM expense_claims WHERE company_id = $1)`;
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM travel_cost_transactions WHERE source_type='expense_claim' AND source_id IN ${claims}`, [companyId]);
  await pool.query(`DELETE FROM expense_claim_approvals WHERE claim_id IN ${claims}`, [companyId]);
  await pool.query(`DELETE FROM expense_claims WHERE company_id = $1`, [companyId]);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}
async function addEmployee(company, code, extra = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, reporting_manager_id, account_number, ifsc_code)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2025-04-01', 'QA', $3, $4, $5) RETURNING id`,
    [company.companyId, code, extra.manager ?? null, extra.account ?? null, extra.ifsc ?? null]);
  return r.id;
}
const link = (u, employeeId) => pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [employeeId, u.userId]);

let billSeq = 0;
async function fileClaim(who, overrides = {}) {
  billSeq += 1;
  const r = await call(who, 'post', '/api/reimbursement/claims').send({
    expense_date: TODAY, expense_type: 'Medical', expense_category: 'Reimbursement',
    amount: 1000 + billSeq, gst_amount: 0, bill_number: `ZZ-${process.pid}-${billSeq}`, ...overrides,
  });
  return r;
}
async function toMgmtApproved(id, claimantUser = claimant) {
  expect((await call(claimantUser, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(200);
  // the reporting manager where there is one; otherwise the HR/admin fallback (§203)
  const approver = claimantUser === claimant || claimantUser === peer ? mgr : mgmt;
  expect((await call(approver, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' })).status).toBe(200);
  expect((await call(accounts, 'put', `/api/reimbursement/claims/${id}/accounts-verify`).send({ status: 'Approved', gst_verified: true })).status).toBe(200);
  expect((await call(mgmt, 'put', `/api/reimbursement/claims/${id}/mgmt-approve`).send({ status: 'Approved' })).status).toBe(200);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  E.M = await addEmployee(co, 'EMP010');
  E.A = await addEmployee(co, 'EMP011', { manager: E.M });            // no bank details yet
  E.P = await addEmployee(co, 'EMP012', { manager: E.M, account: '123456789012', ifsc: 'HDFC0001234' });
  E.F = await addEmployee(co, 'EMP013');
  E.G = await addEmployee(co, 'EMP014');
  E.O = await addEmployee(other, 'EMP010');
  claimant = await addUser(pool, co, { label: 'claimant', roleCode: 'employee' }); await link(claimant, E.A);
  peer = await addUser(pool, co, { label: 'peer', roleCode: 'employee' }); await link(peer, E.P);
  mgr = await addUser(pool, co, { label: 'mgr', roleCode: 'manager' }); await link(mgr, E.M);
  accounts = await addUser(pool, co, { label: 'acct', roleCode: 'finance_manager' }); await link(accounts, E.F);
  mgmt = await addUser(pool, co, { label: 'mgmt', roleCode: 'admin' }); await link(mgmt, E.G);
  otherFin = await addUser(pool, other, { label: 'fin', roleCode: 'finance_manager' }); await link(otherFin, E.O);
  unlinked = await addUser(pool, co, { label: 'nolink', roleCode: 'employee' });
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('filing', () => {
  it('a claim is filed for the caller only, from their employee record, as a Draft', async () => {
    const bad = await fileClaim(claimant, { employee_id: E.P });
    expect(bad.status).toBe(403);
    const r = await fileClaim(claimant, { employee_name: 'Somebody Else', department: 'Board', status: 'Paid' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ employee_id: E.A, employee_name: 'EMP011 Fixture', department: 'QA', status: 'Draft', company_id: co.companyId });
    expect(r.body.claim_number).toMatch(/^EC-\d{4}-\d{4,}$/);
    expect((await fileClaim(unlinked)).status).toBe(403);
    expect((await fileClaim(claimant, { amount: 0 })).status).toBe(400);
    expect((await fileClaim(claimant, { expense_date: 'yesterday' })).status).toBe(400);
  });

  it('claim numbers never collide across companies', async () => {
    const a = await fileClaim(claimant);
    const b = await fileClaim(otherFin);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.claim_number).not.toBe(b.body.claim_number);
  });

  it('the same claim cannot be filed twice — same bill number, or same date, type and amount', async () => {
    const first = await fileClaim(peer, { bill_number: 'ZZ-DUP-1', amount: 777 });
    expect(first.status).toBe(201);
    const sameBill = await fileClaim(peer, { bill_number: 'zz-dup-1 ', amount: 778 });
    expect(sameBill.status).toBe(409);
    expect(sameBill.body.code).toBe('DUPLICATE_CLAIM');
    const sameExpense = await fileClaim(peer, { bill_number: '', amount: 777 });
    expect(sameExpense.status).toBe(409);
    // a different employee may claim the same amount
    expect((await fileClaim(claimant, { bill_number: '', amount: 777 })).status).toBe(201);
  });
});

describe('who reads a claim', () => {
  let id;
  beforeAll(async () => { id = (await fileClaim(claimant)).body.id; });

  it('the claimant, their reporting manager and expense_claims:view holders — nobody else', async () => {
    expect((await call(claimant, 'get', `/api/reimbursement/claims/${id}`)).status).toBe(200);
    expect((await call(mgr, 'get', `/api/reimbursement/claims/${id}`)).status).toBe(200);
    expect((await call(accounts, 'get', `/api/reimbursement/claims/${id}`)).status).toBe(200);
    expect((await call(peer, 'get', `/api/reimbursement/claims/${id}`)).status).toBe(404);
    expect((await call(otherFin, 'get', `/api/reimbursement/claims/${id}`)).status).toBe(404);
  });

  it('a list shows the caller\'s own claims (and their reports\') unless they hold the view grant', async () => {
    const mine = await call(peer, 'get', '/api/reimbursement/claims');
    expect(mine.status).toBe(200);
    expect(mine.body.every(c => c.employee_id === E.P)).toBe(true);
    const asked = await call(peer, 'get', `/api/reimbursement/claims?employee_id=${E.A}`);
    expect(asked.body).toEqual([]);
    const team = await call(mgr, 'get', '/api/reimbursement/claims');
    expect(team.body.map(c => c.id)).toContain(id);
    const all = await call(accounts, 'get', '/api/reimbursement/claims');
    expect(all.body.map(c => c.id)).toContain(id);
    expect((await call(otherFin, 'get', '/api/reimbursement/claims')).body.some(c => c.id === id)).toBe(false);
  });

  it('a claim is represented once: one row, listed once for its owner', async () => {
    const mine = await call(claimant, 'get', '/api/reimbursement/claims');
    expect(mine.body.filter(c => c.id === id)).toHaveLength(1);
  });
});

describe('the approval chain', () => {
  let id;
  beforeAll(async () => { id = (await fileClaim(claimant, { project_id: 999001 })).body.id; });

  it('only the claimant submits, once', async () => {
    expect((await call(peer, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(404);
    expect((await call(claimant, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(200);
    expect((await call(claimant, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(409);
    expect(notify.calls.some(c => c.event === 'submitted' && c.ctx.recordId === id && c.ctx.recipientIds?.[0] === E.A)).toBe(true);
    // a submitted claim is no longer editable
    expect((await call(claimant, 'put', `/api/reimbursement/claims/${id}`).send({ amount: 1 })).status).toBe(409);
  });

  it('level 1: the reporting manager — not a peer, not the claimant; a rejection needs a reason', async () => {
    expect((await call(peer, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' })).status).toBe(403);
    expect((await call(claimant, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' })).status).toBe(403);
    expect((await call(mgr, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Rejected' })).status).toBe(400);
    expect((await call(mgr, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Maybe' })).status).toBe(400);
    expect((await call(mgr, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' })).status).toBe(200);
    expect((await call(mgr, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' })).status).toBe(409);
    expect((await claimRow(id)).status).toBe('Manager Approved');
  });

  it('level 2: expense_claims:edit (accounts) — the manager cannot verify', async () => {
    expect((await call(mgr, 'put', `/api/reimbursement/claims/${id}/accounts-verify`).send({ status: 'Approved' })).status).toBe(403);
    expect((await call(otherFin, 'put', `/api/reimbursement/claims/${id}/accounts-verify`).send({ status: 'Approved' })).status).toBe(404);
    expect((await call(accounts, 'put', `/api/reimbursement/claims/${id}/accounts-verify`).send({ status: 'Approved', bill_match_verified: true })).status).toBe(200);
  });

  it('level 3: expense_claims:approve (management) — accounts cannot approve it', async () => {
    expect((await call(accounts, 'put', `/api/reimbursement/claims/${id}/mgmt-approve`).send({ status: 'Approved' })).status).toBe(403);
    expect((await call(mgmt, 'put', `/api/reimbursement/claims/${id}/mgmt-approve`).send({ status: 'Approved' })).status).toBe(200);
    const levels = (await pool.query(`SELECT level, status FROM expense_claim_approvals WHERE claim_id = $1 ORDER BY level`, [id])).rows;
    expect(levels).toEqual([
      { level: 1, status: 'Approved' }, { level: 2, status: 'Approved' }, { level: 3, status: 'Approved' }, { level: 4, status: 'Pending' },
    ]);
  });

  it('payment: expense_payments:approve, valid bank details for a bank mode, once — one cost row', async () => {
    expect((await call(mgr, 'put', `/api/reimbursement/claims/${id}/pay`).send({ payment_ref: 'R1', payment_date: TODAY, payment_mode: 'NEFT' })).status).toBe(403);
    expect((await call(accounts, 'put', `/api/reimbursement/claims/${id}/pay`).send({ payment_date: TODAY, payment_mode: 'NEFT' })).status).toBe(400);
    // the claimant has no bank details on record
    const blocked = await call(accounts, 'put', `/api/reimbursement/claims/${id}/pay`).send({ payment_ref: 'R1', payment_date: TODAY, payment_mode: 'NEFT' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('BANK_DETAILS_MISSING');
    expect((await claimRow(id)).status).toBe('Mgmt Approved');
    await pool.query(`UPDATE employees SET account_number='998877665544', ifsc_code='ICIC0001111' WHERE id = $1`, [E.A]);
    const paid = await call(accounts, 'put', `/api/reimbursement/claims/${id}/pay`).send({ payment_ref: 'R1', payment_date: TODAY, payment_mode: 'NEFT' });
    expect(paid.status).toBe(200);
    expect(await claimRow(id)).toMatchObject({ status: 'Paid', payment_ref: 'R1', paid_by: accounts.userId });
    const again = await call(accounts, 'put', `/api/reimbursement/claims/${id}/pay`).send({ payment_ref: 'R2', payment_date: TODAY, payment_mode: 'NEFT' });
    expect(again.status).toBe(409);
    expect((await claimRow(id)).payment_ref).toBe('R1');
    expect(await costRows(id)).toBe(1);
    expect(notify.calls.some(c => c.event === 'paid' && c.ctx.recordId === id)).toBe(true);
  });
});

describe('nobody acts on their own claim', () => {
  it('accounts cannot verify, management cannot approve, nobody pays their own', async () => {
    const own = (await fileClaim(accounts)).body.id;
    expect((await call(accounts, 'post', `/api/reimbursement/claims/${own}/submit`)).status).toBe(200);
    expect((await call(mgmt, 'put', `/api/reimbursement/claims/${own}/manager-approve`).send({ status: 'Approved' })).status).toBe(200);
    expect((await call(accounts, 'put', `/api/reimbursement/claims/${own}/accounts-verify`).send({ status: 'Approved' })).status).toBe(403);

    const mine = (await fileClaim(mgmt)).body.id;
    expect((await call(mgmt, 'post', `/api/reimbursement/claims/${mine}/submit`)).status).toBe(200);
    // admin override at level 1 still never covers one's own claim
    expect((await call(mgmt, 'put', `/api/reimbursement/claims/${mine}/manager-approve`).send({ status: 'Approved' })).status).toBe(403);
    expect((await call(mgmt, 'post', `/api/reimbursement/claims/${mine}/delegate`).send({ delegate_employee_id: E.M })).status).toBe(403);
    expect((await claimRow(mine)).status).toBe('Submitted');
  });
});

describe('races and duplicates downstream', () => {
  it('two simultaneous payments: exactly one succeeds, one cost row, one payment', async () => {
    const id = (await fileClaim(peer, { project_id: 999002 })).body.id;
    await toMgmtApproved(id, peer);
    const body = { payment_ref: 'RACE', payment_date: TODAY, payment_mode: 'NEFT' };
    const [a, b] = await Promise.all([
      call(accounts, 'put', `/api/reimbursement/claims/${id}/pay`).send(body),
      call(mgmt, 'put', `/api/reimbursement/claims/${id}/pay`).send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await costRows(id)).toBe(1);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM expense_claim_approvals WHERE claim_id = $1 AND level = 4`, [id])).rows[0].n).toBe(1);
  });

  it('two simultaneous manager approvals (manager and delegate) move the claim once', async () => {
    const id = (await fileClaim(peer)).body.id;
    expect((await call(peer, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(200);
    expect((await call(mgr, 'post', `/api/reimbursement/claims/${id}/delegate`).send({ delegate_employee_id: E.G })).status).toBe(200);
    const [a, b] = await Promise.all([
      call(mgr, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' }),
      call(mgmt, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM expense_claim_approvals WHERE claim_id = $1 AND level = 2`, [id])).rows[0].n).toBe(1);
  });
});

describe('Finance\'s old claim mutations are retired', () => {
  it('approve / reject / create answer 410 and post no journal entry', async () => {
    const id = (await fileClaim(claimant)).body.id;
    const journals = async () => (await pool.query(
      `SELECT COUNT(*)::int n FROM journal_entries WHERE reference_type='expense_claim' AND reference_id = $1`, [id])).rows[0].n;
    for (const [m, p] of [['post', `/api/finance/expenses/${id}/approve`], ['post', `/api/finance/expenses/${id}/reject`], ['post', '/api/finance/expenses']]) {
      const r = await call(mgmt, m, p).send({ reason: 'x' });
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('CLAIMS_MOVED');
    }
    expect(await journals()).toBe(0);
    expect((await claimRow(id)).status).toBe('Draft');
  });

  it('Finance reads a claim of its own company only', async () => {
    const id = (await fileClaim(claimant)).body.id;
    expect((await call(mgmt, 'get', `/api/finance/expenses/${id}`)).status).toBe(200);
    const outsider = await addUser(pool, other, { label: 'adm2', roleCode: 'admin' });
    expect((await call(outsider, 'get', `/api/finance/expenses/${id}`)).status).toBe(404);
  });
});

describe('queues follow the grants', () => {
  it('pending-for-approval lists what waits on the caller — never their own', async () => {
    const id = (await fileClaim(peer)).body.id;
    expect((await call(peer, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(200);
    expect((await call(mgr, 'get', '/api/reimbursement/pending-for-approval')).body.map(c => c.id)).toContain(id);
    expect((await call(peer, 'get', '/api/reimbursement/pending-for-approval')).body.map(c => c.id)).not.toContain(id);
    expect((await call(otherFin, 'get', '/api/reimbursement/pending-for-approval')).body.map(c => c.id)).not.toContain(id);
  });

  it('the dashboard counts the caller\'s own claims by employee id; queue totals need the view grant', async () => {
    const d = await call(claimant, 'get', '/api/reimbursement/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.total_submitted).toBeGreaterThan(0);
    expect(d.body.manager_pending).toBeNull();
    expect(typeof (await call(accounts, 'get', '/api/reimbursement/dashboard')).body.manager_pending).toBe('number');
  });
});

describe('level 1 belongs to the reporting manager or a delegate (§203)', () => {
  it('HR/admin cannot take level 1 for an employee who has an active manager', async () => {
    const id = (await fileClaim(claimant)).body.id;
    expect((await call(claimant, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(200);
    const r = await call(mgmt, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no active reporting manager/);
    expect((await claimRow(id)).status).toBe('Submitted');
    // nor can HR/admin hand it to someone else
    expect((await call(mgmt, 'post', `/api/reimbursement/claims/${id}/delegate`).send({ delegate_employee_id: E.F })).status).toBe(403);
  });

  it('when the manager has left, the HR/admin fallback applies', async () => {
    const id = (await fileClaim(claimant)).body.id;
    expect((await call(claimant, 'post', `/api/reimbursement/claims/${id}/submit`)).status).toBe(200);
    await pool.query(`UPDATE employees SET status = 'Left' WHERE id = $1`, [E.M]);
    try {
      expect((await call(mgr, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' })).status).toBe(403);
      expect((await call(mgmt, 'put', `/api/reimbursement/claims/${id}/manager-approve`).send({ status: 'Approved' })).status).toBe(200);
    } finally {
      await pool.query(`UPDATE employees SET status = 'Active' WHERE id = $1`, [E.M]);
    }
  });
});
