/**
 * bankLedgerLink.service.js — what the Bank Accounts "Ledger links" panel needs (§275).
 *
 * A company bank account reaches the ledger only through Finance's approved
 * payment account mapping (paymentGlMapping.service.js, B-03 D3): F&F payment,
 * supplier payment batches and the ledger-derived bank balance all read it.
 * There was no screen for that mapping, and no ledger account in the chart was
 * of sub-type "bank", so no bank account could be linked at all — F&F payment
 * refused every time with BANK_ACCOUNT_NOT_MAPPED.
 *
 * This adds the two missing pieces, and nothing that bypasses approval:
 *   bankLedgerOptions()  — the bank accounts, the eligible ledgers and the
 *                          current mapping, for one screen;
 *   createBankLedger()   — a ledger account of its own for one bank account
 *                          (Asset, sub-type bank, next free code 1121–1199).
 * Linking is still PUT /payment-gl-mapping (finance:approve), unchanged.
 */
import pool from '../db.js';
import { getPaymentGlMapping } from './paymentGlMapping.service.js';

export class BankLedgerError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const BANK_CODE_FIRST = 1121, BANK_CODE_LAST = 1199;

export async function bankLedgerOptions(companyId, db = pool) {
  const { rows: bankAccounts } = await db.query(
    `SELECT ba.id, ba.account_name, ba.bank_name, ba.ifsc_code, ba.is_primary,
            COALESCE(ba.account_number_last4, RIGHT(regexp_replace(COALESCE(ba.account_number, ''), '\\D', '', 'g'), 4)) AS last4,
            coa.code AS linked_code, coa.name AS linked_name
       FROM bank_accounts ba LEFT JOIN chart_of_accounts coa ON coa.id = ba.chart_account_id
      WHERE ba.company_id = $1 AND ba.deleted_at IS NULL AND ba.is_active = true
      ORDER BY ba.is_primary DESC, ba.account_name`, [companyId]);
  const { rows: bankLedgers } = await db.query(
    `SELECT code, name, company_id FROM chart_of_accounts
      WHERE deleted_at IS NULL AND is_active = true AND (company_id = $1 OR company_id IS NULL)
        AND LOWER(account_type) = 'asset' AND LOWER(COALESCE(sub_type, '')) = 'bank'
      ORDER BY code`, [companyId]);
  const { rows: payableAccounts } = await db.query(
    `SELECT code, name FROM chart_of_accounts
      WHERE deleted_at IS NULL AND is_active = true AND (company_id = $1 OR company_id IS NULL)
        AND LOWER(account_type) = 'liability' AND name ILIKE '%payable%'
        AND LOWER(COALESCE(sub_type, '')) NOT IN ('gst_payable', 'tds_payable', 'statutory', 'accrual')
      ORDER BY code`, [companyId]);
  return { bank_accounts: bankAccounts, bank_ledgers: bankLedgers, payable_accounts: payableAccounts, mapping: await getPaymentGlMapping(companyId, db) };
}

/**
 * A ledger account for one bank account of this company. Refuses an inactive
 * or foreign bank account. Returns the new account; it is NOT linked until
 * Finance approves the mapping.
 */
export async function createBankLedger(companyId, bankAccountId) {
  if (companyId == null) throw new BankLedgerError(400, 'COMPANY_REQUIRED', 'A company is required.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [ba] } = await client.query(
      `SELECT id, account_name, bank_name, account_number, account_number_last4 FROM bank_accounts
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL AND is_active = true FOR UPDATE`, [bankAccountId, companyId]);
    if (!ba) throw new BankLedgerError(404, 'BANK_ACCOUNT_NOT_FOUND', 'Choose an active bank account of this company.');
    // Codes are unique across the whole chart: serialise the pick.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('coa_bank_ledger_code'))`);
    const { rows: taken } = await client.query(
      `SELECT code FROM chart_of_accounts WHERE code ~ '^[0-9]+$' AND code::int BETWEEN $1 AND $2`, [BANK_CODE_FIRST, BANK_CODE_LAST]);
    const used = new Set(taken.map((r) => Number(r.code)));
    let code = null;
    for (let c = BANK_CODE_FIRST; c <= BANK_CODE_LAST; c += 1) if (!used.has(c)) { code = c; break; }
    if (code == null) throw new BankLedgerError(409, 'NO_FREE_CODE', 'No free ledger code between 1121 and 1199. Ask Finance to create the bank ledger in Chart of Accounts.');
    const last4 = ba.account_number_last4 || String(ba.account_number || '').replace(/\D/g, '').slice(-4);
    const name = `${ba.bank_name || ba.account_name}${last4 ? ` ••${last4}` : ''}`.slice(0, 120);
    // Filed under the same parent as the generic 1120 Bank Account, when it has one.
    const { rows: [parent] } = await client.query(`SELECT parent_id FROM chart_of_accounts WHERE code = '1120' AND deleted_at IS NULL`);
    const { rows: [account] } = await client.query(
      `INSERT INTO chart_of_accounts (code, name, account_type, sub_type, parent_id, description, is_active, company_id)
       VALUES ($1, $2, 'Asset', 'bank', $3, $4, true, $5) RETURNING id, code, name, account_type, sub_type, company_id`,
      [String(code), name, parent?.parent_id ?? null, `Ledger for bank account "${ba.account_name}"`, companyId]);
    await client.query('COMMIT');
    return { account, bank_account_id: ba.id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
