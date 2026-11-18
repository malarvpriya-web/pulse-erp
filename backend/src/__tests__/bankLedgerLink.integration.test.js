/**
 * Bank → ledger links (§275), against the database:
 *   - the options list a company's active bank accounts only, the bank-type
 *     ledgers, the payable accounts and the mapping status;
 *   - "Create ledger" makes an Asset / sub-type bank account with a free code
 *     from 1121–1199, for this company, and does NOT link it by itself;
 *   - approving the mapping (the existing Finance step) links it, which is
 *     what F&F payment reads (bank_accounts.chart_account_id);
 *   - another company's or an inactive bank account is refused.
 * Companies are auto-numbered and tagged; everything is removed in afterAll.
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
const { bankLedgerOptions, createBankLedger } = await import('../modules/finance/services/bankLedgerLink.service.js');
const { setPaymentGlMapping } = await import('../modules/finance/services/paymentGlMapping.service.js');

const TAG = 'ZZBLINK';
const fx = {};

async function cleanup() {
  const cos = `SELECT id FROM companies WHERE code LIKE '${TAG}%'`;
  await pool.query(`DELETE FROM company_settings WHERE company_id IN (${cos})`);
  await pool.query(`UPDATE bank_accounts SET chart_account_id = NULL WHERE company_id IN (${cos})`);
  await pool.query(`DELETE FROM chart_of_accounts WHERE company_id IN (${cos})`);
  await pool.query(`DELETE FROM bank_accounts WHERE company_id IN (${cos})`);
  await pool.query(`DELETE FROM users WHERE email = 'zz.blink.approver@example.com'`);
  await pool.query(`DELETE FROM companies WHERE code LIKE '${TAG}%'`);
}
let n = 0;
const bank = async (company, name, active = true) => (await pool.query(
  `INSERT INTO bank_accounts (account_name, bank_name, account_number, account_number_last4, ifsc_code, is_active, company_id)
   VALUES ($1, 'ZZ Bank', $4, '7890', 'HDFC0001234', $2, $3) RETURNING id`,
  [name, active, company, `ZZBLINK${Date.now() % 1e6}${(n += 1)}7890`])).rows[0].id;

beforeAll(async () => {
  await cleanup();
  const { rows } = await pool.query(`INSERT INTO companies (name, code) VALUES ('ZZ Bank Link A', '${TAG}A'), ('ZZ Bank Link B', '${TAG}B') RETURNING id, code`);
  fx.A = rows.find(r => r.code.endsWith('A')).id;
  fx.B = rows.find(r => r.code.endsWith('B')).id;
  fx.main = await bank(fx.A, 'ZZ Main Current');
  fx.closed = await bank(fx.A, 'ZZ Closed', false);
  fx.foreign = await bank(fx.B, 'ZZ Other Co');
  fx.approver = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id) VALUES ('Zz Approver', 'zz.blink.approver@example.com', 'x', 'finance_manager', true, $1) RETURNING id`, [fx.A])).rows[0].id;
});
afterAll(cleanup);

describe('bank ledger links', () => {
  it('lists only this company\'s active bank accounts, not linked yet', async () => {
    const o = await bankLedgerOptions(fx.A);
    expect(o.bank_accounts.map(b => b.account_name)).toEqual(['ZZ Main Current']);
    expect(o.bank_accounts[0]).toMatchObject({ last4: '7890', linked_code: null });
    expect(o.payable_accounts.map(a => a.code)).toContain('2001');
    expect(o.mapping.status).toBe('not_configured');
  });

  it('creates a bank ledger for one bank account without linking it', async () => {
    const { account } = await createBankLedger(fx.A, fx.main);
    expect(account).toMatchObject({ account_type: 'Asset', sub_type: 'bank', company_id: fx.A, name: 'ZZ Bank ••7890' });
    expect(Number(account.code)).toBeGreaterThanOrEqual(1121);
    expect(Number(account.code)).toBeLessThanOrEqual(1199);
    fx.code = account.code;
    const o = await bankLedgerOptions(fx.A);
    expect(o.bank_ledgers.map(a => a.code)).toContain(fx.code);
    expect(o.bank_accounts[0].linked_code).toBeNull();
    // Another company does not see it.
    expect((await bankLedgerOptions(fx.B)).bank_ledgers.map(a => a.code)).not.toContain(fx.code);
  });

  it('approving the mapping links it — what F&F payment reads', async () => {
    await setPaymentGlMapping(fx.A, { accounts_payable_account_code: '2001', bank_ledgers: { [fx.main]: fx.code } }, fx.approver);
    const { rows: [b] } = await pool.query(
      `SELECT coa.code FROM bank_accounts ba JOIN chart_of_accounts coa ON coa.id = ba.chart_account_id WHERE ba.id = $1`, [fx.main]);
    expect(b.code).toBe(fx.code);
    expect((await bankLedgerOptions(fx.A)).mapping.status).toBe('approved');
  });

  it('refuses another company\'s or an inactive bank account', async () => {
    await expect(createBankLedger(fx.A, fx.foreign)).rejects.toMatchObject({ status: 404, code: 'BANK_ACCOUNT_NOT_FOUND' });
    await expect(createBankLedger(fx.A, fx.closed)).rejects.toMatchObject({ status: 404 });
  });
});
