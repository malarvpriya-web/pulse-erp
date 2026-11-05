/**
 * PC-02b-0 B-03 — bank-to-ledger / bank-to-journal uuid links (manual §236).
 *
 *   - Finance's approved payment mapping and bank_accounts.chart_account_id (the
 *     display link) change together, atomically: approve, replace, withdraw; a
 *     refused mapping changes neither;
 *   - the bank-account create / update APIs cannot write the link;
 *   - every ledger-derived balance read — the bank-account list and record, the
 *     summary, the finance dashboard cash total — counts only the caller's
 *     company's postings, although two companies post to the same shared 1002;
 *   - B-02 processing stores the payment journal's uuid on the bank transaction,
 *     and posts to the MAPPING's ledger even if the display link were different.
 *
 * Real routers and database; two throwaway companies — all removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }             = await import('../config/db.js');
const { verifyToken }               = await import('../middlewares/auth.middleware.js');
const { buildApp }                  = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { verifiedVendorFixture, dropBeneficiaryFixtures } = await import('./helpers/paymentGlFixture.js');
const { default: financeRoutes }    = await import('../modules/finance/routes/extended.routes.js');
const { default: accountingRoutes } = await import('../modules/finance/accounting.routes.js');
const { default: reportsService }   = await import('../modules/finance/services/reports.service.js');

const app = buildApp(
  ['/api/finance', verifyToken, financeRoutes],
  ['/api/accounting', verifyToken, accountingRoutes],
);

const PREFIX = 'ZZB03';
const stamp = Date.now().toString().slice(-8);
let co, other, today, ACCT;
const U = {}, A = {}, B = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

async function sweep(companyId) {
  const q = (sql) => pool.query(sql, [companyId]);
  await dropBeneficiaryFixtures(pool, [companyId]);
  await q(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE company_id = $1)`);
  await q(`UPDATE payment_batch_items SET payment_id = NULL WHERE batch_id IN (SELECT id FROM payment_batches WHERE company_id = $1)`);
  await q(`DELETE FROM bank_transactions WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE company_id = $1)`);
  await q(`DELETE FROM payments WHERE company_id = $1`);
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payment_batch_items WHERE batch_id IN (SELECT id FROM payment_batches WHERE company_id = $1)`);
  await q(`DELETE FROM payment_batches WHERE company_id = $1`);
  await q(`DELETE FROM bank_accounts WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
}

let seq = 0;
async function bankAccount(company, balance = 100000) {
  seq += 1;
  const { rows: [r] } = await pool.query(
    `INSERT INTO bank_accounts (account_name, account_number, bank_name, ifsc_code, company_id, current_balance, opening_balance, is_active)
     VALUES ($1, $2, 'ZZ Bank', 'HDFC0001234', $3, $4, $4, true) RETURNING id`,
    [`${PREFIX} bank ${seq}`, `ZZB03${stamp}${seq}`, company.companyId, balance]);
  return r.id;
}
/** A posted journal of `company`: Dr <code> amount / Cr 2001 amount. */
async function postedJournal(company, code, amount) {
  seq += 1;
  const { rows: [je] } = await pool.query(
    `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, status, is_posted, total_debit, total_credit, company_id)
     VALUES ($1, CURRENT_DATE - 1, 'Journal', 'ZZB03 fixture', 'posted', true, $2, $2, $3) RETURNING id`,
    [`ZZB03-${stamp}-${seq}`, amount, company.companyId]);
  await pool.query(
    `INSERT INTO journal_lines (entry_id, account_id, account_code, debit, credit, company_id) VALUES
       ($1, $2, $3, $4, 0, $6), ($1, $5, '2001', 0, $4, $6)`, [je.id, ACCT[code], code, amount, ACCT['2001'], company.companyId]);
  return je.id;
}
const link = async (id) => (await pool.query(`SELECT chart_account_id FROM bank_accounts WHERE id = $1`, [id])).rows[0].chart_account_id;
const setMapping = (who, bankLedgers) => call(who, 'put', '/api/accounting/payment-gl-mapping')
  .send({ accounts_payable_account_code: '2001', bank_ledgers: bankLedgers });

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  ({ rows: [{ d: today }] } = await pool.query(`SELECT CURRENT_DATE::text AS d`));
  ACCT = Object.fromEntries((await pool.query(
    `SELECT code, id FROM chart_of_accounts WHERE code IN ('1002','1003','2001') AND company_id IS NULL`)).rows.map(r => [r.code, r.id]));
  U.maker = await addUser(pool, co, { label: 'maker', roleCode: 'accounts_exec' });
  U.fmA = await addUser(pool, co, { label: 'fm', roleCode: 'finance_manager' });
  U.fmA2 = await addUser(pool, co, { label: 'fm2', roleCode: 'finance_manager' });
  U.fmB = await addUser(pool, other, { label: 'fm', roleCode: 'finance_manager' });
  A.bank = await bankAccount(co);
  A.bank2 = await bankAccount(co);
  B.bank = await bankAccount(other);
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
});

describe('B-03 the mapping and the display link move together', () => {
  it('approving a mapping links the mapped bank accounts, in the same transaction', async () => {
    const res = await setMapping(U.fmA, { [A.bank]: '1002' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await link(A.bank)).toBe(ACCT['1002']);
    expect(await link(A.bank2)).toBeNull();
  });

  it('replacing it moves and clears links; another company is untouched', async () => {
    expect((await setMapping(U.fmB, { [B.bank]: '1002' })).status).toBe(200);
    const res = await setMapping(U.fmA, { [A.bank2]: '1003' });
    expect(res.status).toBe(200);
    expect(await link(A.bank)).toBeNull();               // no longer mapped → unlinked
    expect(await link(A.bank2)).toBe(ACCT['1003']);
    expect(await link(B.bank)).toBe(ACCT['1002']);       // company B's own mapping
  });

  it('a refused mapping changes neither the mapping nor any link', async () => {
    const before = (await call(U.fmA, 'get', '/api/accounting/payment-gl-mapping')).body;
    const res = await setMapping(U.fmA, { [A.bank]: '2001', [B.bank]: '1002' });   // a liability; another company's bank
    expect(res.status).toBe(422);
    expect(await link(A.bank)).toBeNull();
    expect(await link(A.bank2)).toBe(ACCT['1003']);
    expect(await link(B.bank)).toBe(ACCT['1002']);
    expect((await call(U.fmA, 'get', '/api/accounting/payment-gl-mapping')).body.bankLedgers).toEqual(before.bankLedgers);
  });

  it('withdrawing the mapping clears the company\'s links only', async () => {
    expect((await call(U.fmA, 'delete', '/api/accounting/payment-gl-mapping')).status).toBe(200);
    expect(await link(A.bank2)).toBeNull();
    expect(await link(B.bank)).toBe(ACCT['1002']);
    expect((await setMapping(U.fmA, { [A.bank]: '1002', [A.bank2]: '1003' })).status).toBe(200);   // restore for what follows
  });

  it('the bank-account API cannot write the link', async () => {
    const upd = await call(U.fmA, 'put', `/api/finance/bank-accounts/${A.bank}`).send({ chart_account_id: ACCT['1003'] });
    expect(upd.status).toBe(400);
    expect(upd.body.code).toBe('LEDGER_LINK_FROM_MAPPING');
    const crt = await call(U.fmA, 'post', '/api/finance/bank-accounts').send({ account_name: 'x', account_number: `ZZB03${stamp}99`, chart_account_id: ACCT['1002'] });
    expect(crt.status).toBe(400);
    expect(crt.body.code).toBe('LEDGER_LINK_FROM_MAPPING');
    expect(await link(A.bank)).toBe(ACCT['1002']);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM bank_accounts WHERE account_number = $1`, [`ZZB03${stamp}99`]);
    expect(rows[0].n).toBe(0);
  });
});

describe('B-03 ledger-derived balances are company-scoped (shared 1002 used by both companies)', () => {
  beforeAll(async () => {
    await postedJournal(co, '1002', 1000);      // company A: Dr 1002 1,000
    await postedJournal(other, '1002', 5000);   // company B: Dr 1002 5,000 — must never appear in A's figures
  });

  it('the bank-account list and record count only the company\'s postings', async () => {
    const opening = Number((await pool.query(`SELECT opening_balance FROM chart_of_accounts WHERE id = $1`, [ACCT['1002']])).rows[0].opening_balance || 0);
    const list = (await call(U.fmA, 'get', '/api/finance/bank-accounts')).body;
    const a = list.find(r => r.id === A.bank);
    expect(a.balance_source).toBe('ledger');
    expect(Number(a.current_balance)).toBe(opening + 1000);
    const one = (await call(U.fmA, 'get', `/api/finance/bank-accounts/${A.bank}`)).body;
    expect(Number(one.current_balance)).toBe(opening + 1000);
    const b = (await call(U.fmB, 'get', `/api/finance/bank-accounts/${B.bank}`)).body;
    expect(Number(b.current_balance)).toBe(opening + 5000);
  });

  it('the summary total is the company\'s', async () => {
    const opening = Number((await pool.query(`SELECT opening_balance FROM chart_of_accounts WHERE id = $1`, [ACCT['1002']])).rows[0].opening_balance || 0);
    const openingB = Number((await pool.query(`SELECT opening_balance FROM chart_of_accounts WHERE id = $1`, [ACCT['1003']])).rows[0].opening_balance || 0);
    const sumA = (await call(U.fmA, 'get', '/api/finance/bank-accounts/summary')).body;
    expect(Number(sumA.total_cash_bank)).toBe(opening + 1000 + openingB);   // A.bank (1002) + A.bank2 (1003, no movement)
    const sumB = (await call(U.fmB, 'get', '/api/finance/bank-accounts/summary')).body;
    expect(Number(sumB.total_cash_bank)).toBe(opening + 5000);
  });

  it('the finance dashboard cash total is the company\'s', async () => {
    const { rows: [o] } = await pool.query(`SELECT SUM(opening_balance)::numeric AS s FROM chart_of_accounts WHERE id = ANY($1::uuid[])`, [[ACCT['1002'], ACCT['1003']]]);
    const dashA = await reportsService.getFinanceDashboard({ companyId: co.companyId });
    const cashA = dashA.cashBalance ?? dashA.cash_balance ?? dashA.kpis?.cashBalance ?? dashA.summary?.cashBalance;
    expect(Number(cashA)).toBe(Number(o.s || 0) + 1000);
    const dashB = await reportsService.getFinanceDashboard({ companyId: other.companyId });
    const cashB = dashB.cashBalance ?? dashB.cash_balance ?? dashB.kpis?.cashBalance ?? dashB.summary?.cashBalance;
    expect(Number(cashB)).toBe(Number((await pool.query(`SELECT opening_balance FROM chart_of_accounts WHERE id = $1`, [ACCT['1002']])).rows[0].opening_balance || 0) + 5000);
  });
});

describe('B-03 with B-02 processing', () => {
  async function approvedBatch(bankId, items) {
    A.vendor ??= (await verifiedVendorFixture(pool, co.companyId)).vendorId;
    const c = await call(U.maker, 'post', '/api/finance/payment-batches').send({
      batch_date: today, bank_account_id: bankId, items: items.map(i => ({ ...i, supplier_id: A.vendor })),
    });
    await call(U.maker, 'post', `/api/finance/payment-batches/${c.body.id}/submit`);
    expect((await call(U.fmA, 'post', `/api/finance/payment-batches/${c.body.id}/approve`)).status).toBe(200);
    expect((await call(U.fmA, 'post', `/api/finance/payment-batches/${c.body.id}/release`).send({})).status).toBe(201);
    return c.body.id;
  }

  it('the bank transaction now references its journal (uuid FK)', async () => {
    const id = await approvedBatch(A.bank, [{ supplier_name: 'ZZ Supplier', amount: 700 }]);
    const res = await call(U.fmA2, 'post', `/api/finance/payment-batches/${id}/process`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows } = await pool.query(
      `SELECT bt.journal_entry_id, p.journal_entry_id AS payment_je FROM bank_transactions bt
         JOIN payment_batch_items i ON i.batch_id = $1 JOIN payments p ON p.id = i.payment_id AND p.payment_number = bt.reference_number`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].journal_entry_id).toBeTruthy();
    expect(rows[0].journal_entry_id).toBe(rows[0].payment_je);
  });

  it('posting follows the approved mapping, never the display link', async () => {
    // Drift the display link by hand (the API refuses this); processing must still post to the mapping's 1003.
    await pool.query(`UPDATE bank_accounts SET chart_account_id = $1 WHERE id = $2`, [ACCT['1002'], A.bank2]);
    const id = await approvedBatch(A.bank2, [{ supplier_name: 'ZZ Supplier', amount: 300 }]);
    expect((await call(U.fmA2, 'post', `/api/finance/payment-batches/${id}/process`).send({})).status).toBe(200);
    const { rows } = await pool.query(
      `SELECT jl.account_code FROM journal_lines jl JOIN payments p ON p.journal_entry_id = jl.entry_id
         JOIN payment_batch_items i ON i.payment_id = p.id WHERE i.batch_id = $1 AND jl.credit > 0`, [id]);
    expect(rows.map(r => r.account_code)).toEqual(['1003']);
    await pool.query(`UPDATE bank_accounts SET chart_account_id = $1 WHERE id = $2`, [ACCT['1003'], A.bank2]);
  });

  it('a refused processing still writes nothing (locked period)', async () => {
    const id = await approvedBatch(A.bank, [{ supplier_name: 'ZZ Supplier', amount: 50 }]);
    const count = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE bank_account_id = $1`, [A.bank])).rows[0].n;
    const before = await count();
    await pool.query(`INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'finance', '{"lock_date":"2099-12-31"}'::jsonb)
                      ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings`, [co.companyId]);
    try {
      const res = await call(U.fmA2, 'post', `/api/finance/payment-batches/${id}/process`).send({});
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PAYMENT_JOURNAL_REFUSED');
    } finally {
      await pool.query(`DELETE FROM company_settings WHERE company_id = $1 AND module = 'finance'`, [co.companyId]);
    }
    expect(await count()).toBe(before);
  });
});
