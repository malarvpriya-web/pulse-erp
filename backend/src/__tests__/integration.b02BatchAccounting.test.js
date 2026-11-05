/**
 * PC-02b-0 B-02 — payment-batch processing is one transaction with its journals (manual §235).
 *
 * Processing writes payments, bill allocations / balances, a balanced
 * Dr Accounts Payable / Cr Bank journal per payment (posting guards applied),
 * bank transactions referencing those payments and the processed status — all or
 * nothing. The accounts come only from Finance's approved payment mapping for the
 * batch's own (same-company, active) bank account; ledger ids in the request are
 * refused. Retries and concurrent calls never pay twice.
 *
 * Real routers and database; two throwaway companies, synthetic bank accounts,
 * bills and batches — all removed afterwards. Nothing leaves the test database.
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
const { default: financeRoutes }    = await import('../modules/finance/routes/extended.routes.js');
const { default: accountingRoutes } = await import('../modules/finance/accounting.routes.js');
const { default: settingsRoutes }   = await import('../modules/admin/settings-status.routes.js');
const { verifiedVendorFixture, dropBeneficiaryFixtures } = await import('./helpers/paymentGlFixture.js');

const app = buildApp(
  ['/api/finance', verifyToken, financeRoutes],
  ['/api/accounting', verifyToken, accountingRoutes],
  ['/api/settings', verifyToken, settingsRoutes],
);

const PREFIX = 'ZZB02';
const stamp = Date.now().toString().slice(-8);
let co, other, today;
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
  await q(`DELETE FROM bills WHERE company_id = $1`);
  await q(`DELETE FROM bank_accounts WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
}

let seq = 0;
async function bankAccount(company, { active = true } = {}) {
  seq += 1;
  const { rows: [r] } = await pool.query(
    `INSERT INTO bank_accounts (account_name, account_number, bank_name, ifsc_code, company_id, current_balance, is_active)
     VALUES ($1, $2, 'ZZ Bank', 'HDFC0001234', $3, 100000, $4) RETURNING id`,
    [`${PREFIX} bank ${seq}`, `ZZB02${stamp}${seq}`, company.companyId, active]);
  return r.id;
}
async function bill(total) {
  seq += 1;
  const { rows: [r] } = await pool.query(
    `INSERT INTO bills (bill_number, party_name, bill_date, amount, subtotal, total_amount, paid_amount, balance, status, company_id)
     VALUES ($1, 'ZZ Supplier', CURRENT_DATE, $2, $2, $2, 0, $2, 'pending', $3) RETURNING id`,
    [`ZZB02-${stamp}-${seq}`, total, co.companyId]);
  return r.id;
}
/**
 * Create → submit (maker) → approve (checker) → release the bank file (B-04, not
 * asserted here: a batch whose bank account is refused fails release the same
 * way processing does) through the API; returns the batch id.
 */
async function approvedBatch(bankAccountId, items, company = co, maker = U.maker, checker = U.checker) {
  const c = await call(maker, 'post', '/api/finance/payment-batches').send({
    batch_date: today, bank_account_id: bankAccountId, items: items.map(i => ({ ...i, supplier_id: A.vendor })),
  });
  if (c.status !== 201) throw new Error(`create ${c.status} ${JSON.stringify(c.body)}`);
  const s = await call(maker, 'post', `/api/finance/payment-batches/${c.body.id}/submit`);
  if (s.status !== 200) throw new Error(`submit ${s.status} ${JSON.stringify(s.body)}`);
  const a = await call(checker, 'post', `/api/finance/payment-batches/${c.body.id}/approve`);
  if (a.status !== 200) throw new Error(`approve ${a.status} ${JSON.stringify(a.body)}`);
  await call(checker, 'post', `/api/finance/payment-batches/${c.body.id}/release`).send({ format: 'generic' });
  void company;
  return c.body.id;
}
const process_ = (who, batchId, body) => call(who, 'post', `/api/finance/payment-batches/${batchId}/process`).send(body || {});

/** Everything processing can write, for one company. */
async function writes(companyId = co.companyId) {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM payments WHERE company_id = $1)::int AS payments,
            (SELECT COUNT(*) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE p.company_id = $1)::int AS allocations,
            (SELECT COUNT(*) FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id WHERE ba.company_id = $1)::int AS bank_txns,
            (SELECT COUNT(*) FROM journal_entries WHERE company_id = $1 AND reference_type = 'payment')::int AS journals,
            (SELECT json_agg(json_build_object('id', id, 'paid', paid_amount, 'balance', balance, 'status', status) ORDER BY id) FROM bills WHERE company_id = $1) AS bills,
            (SELECT json_agg(json_build_object('id', id, 'bal', current_balance) ORDER BY id) FROM bank_accounts WHERE company_id = $1) AS balances`,
    [companyId]);
  return r;
}
const batchStatus = async (id) => (await pool.query(`SELECT status FROM payment_batches WHERE id = $1`, [id])).rows[0].status;
const setMapping = (bankLedgers, who = U.checker) => call(who, 'put', '/api/accounting/payment-gl-mapping')
  .send({ accounts_payable_account_code: '2001', bank_ledgers: bankLedgers });
const lock = (date) => pool.query(
  `INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'finance', $2::jsonb)
   ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings`, [co.companyId, JSON.stringify({ lock_date: date })]);
const unlock = () => pool.query(`DELETE FROM company_settings WHERE company_id = $1 AND module = 'finance'`, [co.companyId]);

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  ({ rows: [{ d: today }] } = await pool.query(`SELECT CURRENT_DATE::text AS d`));
  U.maker = await addUser(pool, co, { label: 'maker', roleCode: 'accounts_exec' });
  U.checker = await addUser(pool, co, { label: 'checker', roleCode: 'finance_manager' });
  U.processor = await addUser(pool, co, { label: 'processor', roleCode: 'finance_manager' });
  U.fmB = await addUser(pool, other, { label: 'fm', roleCode: 'finance_manager' });
  A.vendor = (await verifiedVendorFixture(pool, co.companyId)).vendorId;
  A.bank = await bankAccount(co);
  A.bank2 = await bankAccount(co);
  A.inactive = await bankAccount(co, { active: false });
  B.bank = await bankAccount(other);
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
});

describe('B-02 the payment mapping is Finance\'s, validated and company-scoped', () => {
  it('starts not configured', async () => {
    const res = await call(U.checker, 'get', '/api/accounting/payment-gl-mapping');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_configured');
  });

  it('refuses invalid accounts and another company\'s or an inactive bank account', async () => {
    const bad = await call(U.checker, 'put', '/api/accounting/payment-gl-mapping')
      .send({ accounts_payable_account_code: '1002', bank_ledgers: { [A.bank]: '2001', [B.bank]: '1002', [A.inactive]: '1002' } });
    expect(bad.status).toBe(422);
    expect(bad.body.problems.join(' | ')).toMatch(/Accounts payable: account 1002 .* must be Liability/);
    expect(bad.body.problems.join(' | ')).toMatch(/must be an Asset account of sub-type bank/);
    expect(bad.body.problems.join(' | ')).toMatch(new RegExp(`Bank account ${B.bank}: not an active bank account of this company`));
    expect(bad.body.problems.join(' | ')).toMatch(new RegExp(`Bank account ${A.inactive}: not an active bank account`));
    expect((await call(U.checker, 'get', '/api/accounting/payment-gl-mapping')).body.status).toBe('not_configured');
  });

  it('cannot be written through the generic settings endpoint, nor by a role without finance:approve', async () => {
    const forged = await call(U.checker, 'post', '/api/settings/payment_gl_mapping')
      .send({ accounts_payable_account_code: '2001', bank_ledgers: { [A.bank]: '1002' }, approved_by: 1, approved_at: '2026-01-01' });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('SETTINGS_KEY_RESERVED');
    expect((await setMapping({ [A.bank]: '1002' }, U.maker)).status).toBe(403);   // accounts_exec: no finance:approve
  });
});

describe('B-02 a refused processing writes nothing', () => {
  it('without an approved mapping: 422, batch stays approved, nothing written', async () => {
    const billId = await bill(5000);
    A.batch1 = await approvedBatch(A.bank, [{ supplier_name: 'ZZ Supplier', amount: 5000, bill_id: billId }, { supplier_name: 'ZZ Other', amount: 1200 }]);
    A.bill1 = billId;
    const before = await writes();
    const res = await process_(U.processor, A.batch1);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('PAYMENT_GL_MAPPING_REQUIRED');
    expect(await writes()).toEqual(before);
    expect(await batchStatus(A.batch1)).toBe('approved');
  });

  it('ledger account ids in the request are refused', async () => {
    const res = await process_(U.processor, A.batch1, { accounts_payable_id: 'x', bank_account_chart_id: 'y' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ACCOUNTS_NOT_ACCEPTED');
  });

  it('a mapping for a different bank account than the batch\'s is not enough', async () => {
    expect((await setMapping({ [A.bank2]: '1002' })).status).toBe(200);
    const before = await writes();
    const res = await process_(U.processor, A.batch1);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYMENT_GL_MAPPING_REQUIRED');
    expect(await writes()).toEqual(before);
  });

  it('a batch paid from another company\'s or an inactive bank account is refused', async () => {
    expect((await setMapping({ [A.bank]: '1002', [A.bank2]: '1003' })).status).toBe(200);
    const foreign = await approvedBatch(B.bank, [{ supplier_name: 'ZZ Supplier', amount: 100 }]);
    const inactive = await approvedBatch(A.inactive, [{ supplier_name: 'ZZ Supplier', amount: 100 }]);
    const before = await writes();
    for (const id of [foreign, inactive]) {
      const res = await process_(U.processor, id);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('BANK_ACCOUNT_INVALID');
      expect(await batchStatus(id)).toBe('approved');
    }
    expect(await writes()).toEqual(before);
    expect(await writes(other.companyId)).toMatchObject({ payments: 0, bank_txns: 0, journals: 0 });
  });

  it('a locked accounting period refuses the journal and rolls back every write', async () => {
    const before = await writes();
    await lock('2099-12-31');
    try {
      const res = await process_(U.processor, A.batch1);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('PAYMENT_JOURNAL_REFUSED');
    } finally { await unlock(); }
    expect(await writes()).toEqual(before);
    expect(await batchStatus(A.batch1)).toBe('approved');
  });

  it('another company cannot process the batch', async () => {
    expect((await process_(U.fmB, A.batch1)).status).toBe(404);
    expect(await batchStatus(A.batch1)).toBe('approved');
  });
});

describe('B-02 a successful processing writes everything together', () => {
  it('payments, allocation, bill balance, balanced journals, linked bank transactions, processed status', async () => {
    const res = await process_(U.processor, A.batch1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('processed');
    const w = await writes();
    expect(w).toMatchObject({ payments: 2, allocations: 1, bank_txns: 2, journals: 2 });
    const b1 = w.bills.find(b => b.id === A.bill1);
    expect([Number(b1.paid), Number(b1.balance), b1.status]).toEqual([5000, 0, 'paid']);
    const { rows: pays } = await pool.query(
      `SELECT p.id, p.amount, p.journal_entry_id, je.status, je.total_debit, je.total_credit,
              (SELECT json_agg(json_build_object('code', jl.account_code, 'd', jl.debit, 'c', jl.credit) ORDER BY jl.debit DESC) FROM journal_lines jl WHERE jl.entry_id = je.id) AS lines,
              bt.amount AS bank_amount, bt.balance_after
         FROM payments p JOIN journal_entries je ON je.id = p.journal_entry_id
         JOIN bank_transactions bt ON bt.reference_number = p.payment_number
        WHERE p.company_id = $1 ORDER BY bt.id`, [co.companyId]);
    expect(pays).toHaveLength(2);
    for (const p of pays) {
      expect(p.status).toBe('posted');
      expect(Number(p.total_debit)).toBe(Number(p.amount));
      expect(Number(p.total_credit)).toBe(Number(p.amount));
      expect(p.lines.map(l => [l.code, Number(l.d), Number(l.c)])).toEqual([['2001', Number(p.amount), 0], ['1002', 0, Number(p.amount)]]);
    }
    // running balance computed inside the transaction: 1,00,000 − 5,000 − 1,200
    expect(pays.map(p => Number(p.balance_after))).toEqual([95000, 93800]);
    const { rows: items } = await pool.query(`SELECT status, payment_id FROM payment_batch_items WHERE batch_id = $1`, [A.batch1]);
    expect(items.every(i => i.status === 'processed' && i.payment_id)).toBe(true);
  });

  it('a retry is refused and pays nothing again', async () => {
    const before = await writes();
    const res = await process_(U.processor, A.batch1);
    expect(res.status).toBe(409);
    expect(await writes()).toEqual(before);
  });

  it('two concurrent process calls pay once', async () => {
    const id = await approvedBatch(A.bank2, [{ supplier_name: 'ZZ Supplier', amount: 300 }, { supplier_name: 'ZZ Supplier', amount: 200 }]);
    const before = await writes();
    const [a, b] = await Promise.all([process_(U.processor, id), process_(U.checker, id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const after = await writes();
    expect(after.payments - before.payments).toBe(2);
    expect(after.journals - before.journals).toBe(2);
    expect(after.bank_txns - before.bank_txns).toBe(2);
    const { rows } = await pool.query(
      `SELECT DISTINCT jl.account_code FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        JOIN payments p ON p.journal_entry_id = je.id JOIN payment_batch_items i ON i.payment_id = p.id WHERE i.batch_id = $1 AND jl.credit > 0`, [id]);
    expect(rows.map(r => r.account_code)).toEqual(['1003']);   // the batch's own bank ledger
  });
});
