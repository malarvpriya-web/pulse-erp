// A company bank account with Finance's approved payment mapping (PC-02b-0
// B-02), for suites that process supplier payment batches. Processing now
// refuses a batch without a same-company bank account and an approved
// Dr AP 2001 / Cr bank-ledger mapping for it; this gives a fixture company both.
// dropPaymentGlFixtures() removes what processing then writes (journals, bank
// transactions, allocations) and the fixture itself — call it BEFORE the suite
// deletes the companies' payments, batches and bank accounts.
//
// B-04: processing also needs a released bank file, whose lines must be vendors
// with a Finance-verified bank detail. verifiedVendorFixture() gives a company
// one; dropBeneficiaryFixtures() removes released files and the vendors.
//
// Released files are immutable, so test cleanup goes through
// withBankFileTriggerSkipped(): verified isolated test database only, superuser
// only (session_replication_role), one transaction. It lives here and nowhere
// under src/modules.

import { assertTestDatabase } from '../../../scripts/test-db/guard.mjs';

let seq = 0;

/**
 * @param {import('pg').Pool} pool
 * @param {number} companyId
 * @param {number} approverUserId  recorded as the mapping's approver
 * @returns {Promise<number>} the bank account id to put on the batch
 */
export async function paymentGlFixture(pool, companyId, approverUserId) {
  seq += 1;
  const { rows: [ba] } = await pool.query(
    `INSERT INTO bank_accounts (account_name, account_number, bank_name, ifsc_code, company_id, current_balance, is_active)
     VALUES ('ZZ fixture paying account', $1, 'ZZ Bank', 'HDFC0001234', $2, 1000000, true) RETURNING id`,
    [`ZZPGL${Date.now().toString().slice(-9)}${seq}`, companyId]);
  await pool.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at) VALUES ($1, 'payment_gl_mapping', $2::jsonb, NOW())
     ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [companyId, JSON.stringify({
      accounts_payable_account_code: '2001', bank_ledgers: { [ba.id]: '1002' },
      approved_by: approverUserId, approved_at: new Date().toISOString(), note: 'test fixture',
    })]);
  return ba.id;
}

/**
 * A vendor of the company with one primary bank detail, Finance-verified by default.
 * @returns {Promise<{vendorId: number, detailId: number, account: string}>}
 */
export async function verifiedVendorFixture(pool, companyId, opts = {}) {
  seq += 1;
  const account = opts.account ?? `9${Date.now().toString().slice(-9)}${String(seq).padStart(3, '0')}`;
  const { rows: [v] } = await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status) VALUES ($1, $2, $3) RETURNING id`,
    [opts.name ?? `ZZ fixture beneficiary ${seq}`, companyId, opts.status ?? 'active']);
  // Bound to a party now: processing would otherwise mint one with vendorIdentity's
  // unlocked MAX+1 code, which collides between suites running in parallel. The
  // code has no digits, so it does not move that MAX.
  const letters = `${Date.now().toString().slice(-8)}${String(seq).padStart(3, '0')}${String(process.pid).slice(-4)}`.replace(/\d/g, n => 'ABCDEFGHIJ'[n]);
  const { rows: [party] } = await pool.query(
    `INSERT INTO parties (party_code, party_type, name, company_id, is_active) VALUES ($1, 'Supplier', $2, $3, true) RETURNING id`,
    [`ZZFX-${letters}`, opts.name ?? `ZZ fixture beneficiary ${seq}`, companyId]);
  await pool.query(`UPDATE vendors SET party_id = $1 WHERE id = $2`, [party.id, v.id]);
  const { rows: [d] } = await pool.query(
    `INSERT INTO vendor_bank_details (vendor_id, bank_name, account_number, ifsc, is_primary, finance_verified, finance_verified_at, company_id)
     VALUES ($1, 'ZZ Bene Bank', $2, $3, $4, $5, CASE WHEN $5 THEN NOW() END, $6) RETURNING id`,
    [v.id, account, opts.ifsc ?? 'HDFC0001234', opts.isPrimary ?? true, opts.verified ?? true, opts.detailCompanyId ?? companyId]);
  return { vendorId: v.id, detailId: d.id, account };
}

/** Run fn(client) with the immutability trigger skipped, on the isolated test database only. */
export async function withBankFileTriggerSkipped(pool, fn) {
  await assertTestDatabase(pool, 'bank-file-test-cleanup');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = 'replica'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Remove the companies' released files, and every vendor the fixtures made. */
export async function dropBeneficiaryFixtures(pool, companyIds) {
  await withBankFileTriggerSkipped(pool, (client) =>
    client.query(`DELETE FROM payment_batch_files WHERE company_id = ANY($1::int[])`, [companyIds]));
  const { rows } = await pool.query(
    `SELECT id, party_id FROM vendors WHERE company_id = ANY($1::int[])`, [companyIds]);
  const parties = rows.map(r => r.party_id).filter(Boolean);
  await pool.query(`DELETE FROM vendor_bank_details WHERE company_id = ANY($1::int[]) OR vendor_id = ANY($2::int[])`, [companyIds, rows.map(r => r.id)]);
  await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1::int[])`, [companyIds]);
  if (parties.length) {
    await pool.query(`UPDATE payments SET party_id = NULL WHERE company_id = ANY($1::int[]) AND party_id = ANY($2::uuid[])`, [companyIds, parties]);
    await pool.query(`DELETE FROM parties WHERE id = ANY($1::uuid[]) AND company_id = ANY($2::int[])`, [parties, companyIds]);
  }
}

/** Remove processing's writes and the fixtures for these companies. */
export async function dropPaymentGlFixtures(pool, companyIds) {
  const c = companyIds;
  await dropBeneficiaryFixtures(pool, c);
  await pool.query(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE company_id = ANY($1::int[]))`, [c]);
  await pool.query(`UPDATE payments SET journal_entry_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  // bank transactions first: they reference their journals (FK RESTRICT, B-03)
  await pool.query(`DELETE FROM bank_transactions WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE company_id = ANY($1::int[]))`, [c]);
  await pool.query(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1::int[]) AND reference_type = 'payment')`, [c]);
  await pool.query(`DELETE FROM journal_entries WHERE company_id = ANY($1::int[]) AND reference_type = 'payment'`, [c]);
  await pool.query(`UPDATE payment_batches SET bank_account_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM bank_accounts WHERE company_id = ANY($1::int[]) AND account_name = 'ZZ fixture paying account'`, [c]);
  await pool.query(`DELETE FROM company_settings WHERE company_id = ANY($1::int[]) AND module = 'payment_gl_mapping'`, [c]);
}
