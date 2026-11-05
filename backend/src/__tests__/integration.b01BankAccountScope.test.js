/**
 * PC-02b-0 B-01 — Finance bank accounts are company-scoped (manual §234).
 *
 * Every /finance/bank-accounts route and the repository writes behind them act
 * only on the caller's company: another company's account id is a 404 and
 * nothing of it is read or changed; a line or transaction of another account
 * cannot be matched through this account's URL; a login with no company is
 * refused; a global super admin keeps the cross-company view.
 *
 * Real router and database; two throwaway companies with synthetic bank
 * accounts, transactions and statement lines — all removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }            = await import('../config/db.js');
const { verifyToken }              = await import('../middlewares/auth.middleware.js');
const { buildApp }                 = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: financeRoutes }   = await import('../modules/finance/routes/extended.routes.js');
const { default: bankAccountRepo } = await import('../modules/finance/repositories/bankAccount.repository.js');

const app = buildApp(['/api/finance', verifyToken, financeRoutes]);

const PREFIX = 'ZZB01';
const NOCO_EMAIL = `${PREFIX.toLowerCase()}.noco@test.invalid`;
const SUPER_EMAIL = `${PREFIX.toLowerCase()}.global@test.invalid`;
const stamp = Date.now().toString().slice(-8);
let co, other, noCo, globalSuper;
const U = {}, A = {}, B = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const base = '/api/finance/bank-accounts';

async function sweep(companyId) {
  const accts = `(SELECT id FROM bank_accounts WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`DELETE FROM bank_statement_lines WHERE bank_account_id IN ${accts}`);
  await q(`DELETE FROM bank_transactions WHERE bank_account_id IN ${accts}`);
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM bank_accounts WHERE company_id = $1`);
}

async function dropLogin(email) {
  const u = `(SELECT id FROM users WHERE email = $1)`;
  for (const t of ['audit_logs', 'access_denials', 'notifications']) await pool.query(`DELETE FROM ${t} WHERE user_id IN ${u}`, [email]).catch(() => {});
  await pool.query(`DELETE FROM user_roles WHERE user_id IN ${u}`, [email]);
  await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
}

async function looseLogin(email, roleCode) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role) VALUES ($1, $2, 'not-a-real-hash', NULL, true, $3) RETURNING id`,
    [`${PREFIX} ${roleCode}`, email, roleCode]);
  const { rows: [r] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, r.id]);
  return { userId: u.id, token: () => jwt.sign({ userId: u.id, role: roleCode, company_id: null, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

let seq = 0;
async function account(company, name) {
  seq += 1;
  const { rows: [r] } = await pool.query(
    `INSERT INTO bank_accounts (account_name, account_number, bank_name, ifsc_code, company_id, current_balance, is_active)
     VALUES ($1, $2, 'ZZ Bank', 'HDFC0001234', $3, 100000, true) RETURNING id`,
    [`${PREFIX} ${name}`, `ZZB01${stamp}${seq}`, company.companyId]);
  return r.id;
}
async function txn(accountId, amount, ref) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO bank_transactions (bank_account_id, transaction_date, transaction_type, amount, reference_number, description)
     VALUES ($1, CURRENT_DATE, 'Debit', $2, $3, 'ZZB01 txn') RETURNING id`, [accountId, amount, ref]);
  return r.id;
}
async function line(accountId, credit, ref) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO bank_statement_lines (bank_account_id, stmt_date, description, debit, credit, ref_number)
     VALUES ($1, CURRENT_DATE, 'ZZB01 line', 0, $2, $3) RETURNING id`, [accountId, credit, ref]);
  return r.id;
}

/** Everything of company A's main account that a cross-company call could touch. */
async function fingerprintA() {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT row_to_json(a) FROM (SELECT account_name, bank_name, is_active, deleted_at, current_balance, last_reconciled_at, updated_at
                                             FROM bank_accounts WHERE id = $1) a) AS acct,
            (SELECT json_agg(t ORDER BY t.id) FROM (SELECT id, reconciled, matched_stmt_id FROM bank_transactions WHERE bank_account_id = $1) t) AS txns,
            (SELECT json_agg(l ORDER BY l.id) FROM (SELECT id, reconciled, matched_txn_id FROM bank_statement_lines WHERE bank_account_id = $1) l) AS lines`,
    [A.acct]);
  return JSON.stringify(r);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  await dropLogin(NOCO_EMAIL); await dropLogin(SUPER_EMAIL);
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  U.fmA = await addUser(pool, co, { label: 'fm', roleCode: 'finance_manager' });
  U.fmB = await addUser(pool, other, { label: 'fm', roleCode: 'finance_manager' });
  U.hrA = await addUser(pool, co, { label: 'hr', roleCode: 'hr' });
  noCo = await looseLogin(NOCO_EMAIL, 'finance_manager');
  globalSuper = await looseLogin(SUPER_EMAIL, 'super_admin');

  A.acct = await account(co, 'A main');
  A.spare = await account(co, 'A spare');
  A.del = await account(co, 'A to delete');
  A.txn = await txn(A.acct, 1000, 'A-REF-1');
  A.line = await line(A.acct, 1000, 'A-REF-1');
  A.txn2 = await txn(A.acct, 2500, 'A-REF-2');
  A.line2 = await line(A.acct, 2500, 'A-REF-2');
  A.spareTxn = await txn(A.spare, 700, 'A-SPARE');
  A.spareLine = await line(A.spare, 700, 'A-SPARE');
  B.acct = await account(other, 'B main');
  B.txn = await txn(B.acct, 1000, 'B-REF-1');
  B.line = await line(B.acct, 1000, 'B-REF-1');
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
  await dropLogin(NOCO_EMAIL); await dropLogin(SUPER_EMAIL);
});

describe('B-01 another company cannot reach company A\'s bank account', () => {
  const attempts = () => [
    ['get', `${base}/${A.acct}`, null],
    ['put', `${base}/${A.acct}`, { account_name: 'HIJACKED', is_active: false }],
    ['get', `${base}/${A.acct}/transactions`, null],
    ['get', `${base}/${A.acct}/unreconciled`, null],
    ['get', `${base}/${A.acct}/statement-lines`, null],
    ['post', `${base}/${A.acct}/statement-lines`, { lines: [{ date: '2030-01-01', description: 'forged', debit: 0, credit: 9 }] }],
    ['post', `${base}/${A.acct}/auto-match`, {}],
    ['post', `${base}/${A.acct}/manual-match`, { statement_line_id: A.line2, transaction_id: A.txn2 }],
    ['post', `${base}/${A.acct}/reconcile`, {}],
    ['delete', `${base}/${A.acct}`, null],
  ];

  it('every route answers 404 and nothing of A is read or changed', async () => {
    const before = await fingerprintA();
    for (const [method, path, body] of attempts()) {
      let r = call(U.fmB, method, path);
      if (body) r = r.send(body);
      const res = await r;
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(res.body), `${method} ${path}`).not.toContain(`${PREFIX} A main`);
    }
    expect(await fingerprintA()).toBe(before);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM bank_statement_lines WHERE bank_account_id = $1 AND description = 'forged'`, [A.acct]);
    expect(rows[0].n).toBe(0);
  });

  it("A's accounts are absent from B's list and B's summary", async () => {
    const list = await call(U.fmB, 'get', base);
    expect(list.status).toBe(200);
    expect(list.body.map(a => a.id)).toEqual([B.acct]);
    const sum = await call(U.fmB, 'get', `${base}/summary`);
    expect(sum.status).toBe(200);
    expect(sum.body.account_count).toBe(1);
  });

  it('B cannot match its own line and transaction through A\'s URL, nor A\'s through its own', async () => {
    const before = await fingerprintA();
    expect((await call(U.fmB, 'post', `${base}/${A.acct}/manual-match`).send({ statement_line_id: B.line, transaction_id: B.txn })).status).toBe(404);
    expect((await call(U.fmB, 'post', `${base}/${B.acct}/manual-match`).send({ statement_line_id: A.line2, transaction_id: A.txn2 })).status).toBe(404);
    expect(await fingerprintA()).toBe(before);
    const { rows: [b] } = await pool.query(`SELECT reconciled FROM bank_statement_lines WHERE id = $1`, [B.line]);
    expect(b.reconciled).toBe(false);
  });

  it('non-numeric and unknown ids are 404, not errors', async () => {
    for (const id of ['abc', '1;DROP', '0', '999999999']) {
      expect((await call(U.fmA, 'get', `${base}/${id}`)).status, id).toBe(404);
    }
  });
});

describe('B-01 same-company workflows are unchanged', () => {
  it('lists, summarises and reads its own accounts', async () => {
    const list = await call(U.fmA, 'get', base);
    expect(list.status).toBe(200);
    expect(list.body.map(a => a.id).sort((x, y) => x - y)).toEqual([A.acct, A.spare, A.del].sort((x, y) => x - y));
    expect((await call(U.fmA, 'get', `${base}/summary`)).body.account_count).toBe(3);
    const one = await call(U.fmA, 'get', `${base}/${A.acct}`);
    expect(one.status).toBe(200);
    expect(one.body.account_name).toBe(`${PREFIX} A main`);
  });

  it('reads transactions, unreconciled items and statement lines', async () => {
    expect((await call(U.fmA, 'get', `${base}/${A.acct}/transactions`)).body.map(t => t.id).sort((x, y) => x - y)).toEqual([A.txn, A.txn2].sort((x, y) => x - y));
    expect((await call(U.fmA, 'get', `${base}/${A.acct}/unreconciled`)).body).toHaveLength(2);
    expect((await call(U.fmA, 'get', `${base}/${A.acct}/statement-lines`)).body).toHaveLength(2);
  });

  it('updates its own account', async () => {
    const res = await call(U.fmA, 'put', `${base}/${A.spare}`).send({ branch: 'ZZ Branch' });
    expect(res.status).toBe(200);
    expect(res.body.branch).toBe('ZZ Branch');
  });

  it('imports statement lines into its own account', async () => {
    const res = await call(U.fmA, 'post', `${base}/${A.spare}/statement-lines`).send({ lines: [{ date: '2030-01-02', description: 'ZZB01 imported', debit: 0, credit: 50, ref_number: 'IMP-1' }] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].bank_account_id).toBe(A.spare);
  });

  it('manual-matches a line and a transaction of the same account — atomically', async () => {
    const res = await call(U.fmA, 'post', `${base}/${A.acct}/manual-match`).send({ statement_line_id: A.line2, transaction_id: A.txn2 });
    expect(res.status).toBe(200);
    const { rows: [l] } = await pool.query(`SELECT reconciled, matched_txn_id FROM bank_statement_lines WHERE id = $1`, [A.line2]);
    const { rows: [t] } = await pool.query(`SELECT reconciled, matched_stmt_id FROM bank_transactions WHERE id = $1`, [A.txn2]);
    expect([l.reconciled, l.matched_txn_id, t.reconciled, t.matched_stmt_id]).toEqual([true, A.txn2, true, A.line2]);
  });

  it('refuses to match across two of its own accounts (line of one, transaction of another)', async () => {
    const res = await call(U.fmA, 'post', `${base}/${A.acct}/manual-match`).send({ statement_line_id: A.spareLine, transaction_id: A.txn });
    expect(res.status).toBe(404);
    const { rows: [l] } = await pool.query(`SELECT reconciled FROM bank_statement_lines WHERE id = $1`, [A.spareLine]);
    expect(l.reconciled).toBe(false);
  });

  it('auto-matches and completes reconciliation on its own account', async () => {
    const res = await call(U.fmA, 'post', `${base}/${A.acct}/auto-match`).send({});
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(1);                    // A-REF-1
    const rec = await call(U.fmA, 'post', `${base}/${A.acct}/reconcile`).send({});
    expect(rec.status).toBe(200);
    expect(rec.body.last_reconciled_at).toBeTruthy();
  });

  it('creates an account owned by its company, and deletes its own', async () => {
    const res = await call(U.fmA, 'post', base).send({ account_name: `${PREFIX} created`, account_number: `ZZB01${stamp}99`, bank_name: 'ZZ Bank', ifsc_code: 'HDFC0001234' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { rows: [r] } = await pool.query(`SELECT company_id FROM bank_accounts WHERE id = $1`, [res.body.id]);
    expect(r.company_id).toBe(co.companyId);
    const del = await call(U.fmA, 'delete', `${base}/${A.del}`);
    expect(del.status).toBe(200);
    expect((await call(U.fmA, 'get', `${base}/${A.del}`)).status).toBe(404);
    expect((await call(U.fmA, 'delete', `${base}/${A.del}`)).status).toBe(404);   // already deleted
  });

  it('permissions are unchanged: hr (no finance grant) is refused', async () => {
    expect((await call(U.hrA, 'get', base)).status).toBe(403);
    expect((await call(U.hrA, 'get', `${base}/${A.acct}`)).status).toBe(403);
  });
});

describe('B-01 logins without a company', () => {
  it('a finance login with no company is refused — it used to see every company\'s accounts', async () => {
    for (const [method, path] of [['get', base], ['get', `${base}/summary`], ['get', `${base}/${A.acct}`], ['post', `${base}/${A.acct}/reconcile`]]) {
      expect((await call(noCo, method, path)).status, `${method} ${path}`).toBe(403);
    }
    expect((await call(noCo, 'post', base).send({ account_name: 'ZZB01 orphan', account_number: `ZZB01${stamp}98` })).status).toBe(403);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM bank_accounts WHERE account_number = $1`, [`ZZB01${stamp}98`]);
    expect(rows[0].n).toBe(0);
  });

  it('a global super admin keeps the cross-company view', async () => {
    const list = await call(globalSuper, 'get', base);
    expect(list.status).toBe(200);
    const ids = list.body.map(a => a.id);
    expect(ids).toContain(A.acct);
    expect(ids).toContain(B.acct);
    expect((await call(globalSuper, 'get', `${base}/${B.acct}`)).status).toBe(200);
  });
});

describe('B-01 repository writes carry the company predicate', () => {
  it('update / softDelete / completeReconciliation / importStatementLines / manualMatch with another company return nothing and change nothing', async () => {
    const before = await fingerprintA();
    expect(await bankAccountRepo.update(A.acct, { account_name: 'X' }, other.companyId)).toBeUndefined();
    expect(await bankAccountRepo.softDelete(A.acct, other.companyId)).toBeUndefined();
    expect(await bankAccountRepo.completeReconciliation(A.acct, other.companyId)).toBeUndefined();
    expect(await bankAccountRepo.importStatementLines(A.acct, [{ date: '2030-01-03', description: 'forged', debit: 0, credit: 1 }], other.companyId)).toBeNull();
    expect(await bankAccountRepo.manualMatch(A.acct, A.spareLine, A.spareTxn, other.companyId)).toBeNull();
    expect(await bankAccountRepo.findById(A.acct, other.companyId)).toBeUndefined();
    expect(await fingerprintA()).toBe(before);
  });
});
