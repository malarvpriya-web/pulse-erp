/**
 * paymentGlMapping.service.js — the GL accounts a supplier payment batch posts
 * to, per company, set ONLY by Finance (PC-02b-0 B-02, 04 Nov 26).
 *
 * Processing a payment batch writes payments, bill allocations and bank
 * transactions and must post Dr Accounts Payable / Cr Bank for each. The
 * accounts used to come from the REQUEST (accounts_payable_id,
 * bank_account_chart_id) — the Payments screen sent neither, so no journal was
 * ever posted — and a caller could name any account. They now come only from
 * this mapping: the payable account, and the ledger account of each company bank
 * account. This mapping is the ONLY source of the accounts payment posting
 * uses (B-03 D3). bank_accounts.chart_account_id — a uuid since migration
 * 20261104000004 — is the DISPLAY link (ledger-derived bank balance): it is
 * written only here, in the same transaction that approves, replaces or
 * withdraws the mapping, so the two never disagree.
 *
 * Stored in company_settings under its own module key, which the generic
 * POST /settings/:module writer refuses (settings-status.routes.js), so the
 * approval stamp can only come from setPaymentGlMapping(). Re-validated at every
 * use: an account deactivated, or a bank account deleted, since approval makes
 * the mapping invalid and processing is refused.
 */
import pool from '../db.js';

export const PAYMENT_GL_SETTINGS_MODULE = 'payment_gl_mapping';

export class PaymentGlMappingError extends Error {
  constructor(message, problems = [], status = 422) { super(message); this.problems = problems; this.status = status; this.code = 'PAYMENT_GL_MAPPING_INVALID'; }
}

async function accountByCode(db, code, companyId) {
  const { rows } = await db.query(
    `SELECT id, code, name, account_type, sub_type, is_active FROM chart_of_accounts
      WHERE code = $1 AND deleted_at IS NULL AND (company_id = $2 OR company_id IS NULL)
      ORDER BY company_id DESC NULLS LAST LIMIT 1`, [String(code), companyId]);
  return rows[0] || null;
}

/**
 * Validate a mapping against the chart of accounts and the company's bank
 * accounts. Returns { payable, bankLedgers: { [bankAccountId]: account }, problems }.
 */
async function resolve(db, s, companyId) {
  const problems = [];
  let payable = null;
  const apCode = s?.accounts_payable_account_code == null ? '' : String(s.accounts_payable_account_code).trim();
  if (!apCode) problems.push('Accounts payable: no account mapped');
  else {
    const a = await accountByCode(db, apCode, companyId);
    if (!a) problems.push(`Accounts payable: account ${apCode} does not exist`);
    else if (!a.is_active) problems.push(`Accounts payable: account ${apCode} (${a.name}) is inactive`);
    else if (String(a.account_type).toLowerCase() !== 'liability') problems.push(`Accounts payable: account ${apCode} (${a.name}) is ${a.account_type}, must be Liability`);
    else payable = { id: a.id, code: a.code, name: a.name };
  }
  const bankLedgers = {};
  const entries = Object.entries(s?.bank_ledgers || {});
  if (!entries.length) problems.push('Bank accounts: no bank account mapped to a ledger account');
  for (const [bankId, code] of entries) {
    const { rows: [ba] } = await db.query(
      `SELECT id, account_name FROM bank_accounts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL AND is_active = true`,
      [Number(bankId), companyId]);
    if (!ba) { problems.push(`Bank account ${bankId}: not an active bank account of this company`); continue; }
    const a = code == null || String(code).trim() === '' ? null : await accountByCode(db, String(code).trim(), companyId);
    if (!a) { problems.push(`Bank account ${ba.account_name}: ledger account ${code ?? '(none)'} does not exist`); continue; }
    if (!a.is_active) { problems.push(`Bank account ${ba.account_name}: ledger account ${a.code} (${a.name}) is inactive`); continue; }
    if (String(a.account_type).toLowerCase() !== 'asset' || String(a.sub_type || '').toLowerCase() !== 'bank') {
      problems.push(`Bank account ${ba.account_name}: ledger account ${a.code} (${a.name}) must be an Asset account of sub-type bank`);
      continue;
    }
    bankLedgers[String(ba.id)] = { id: a.id, code: a.code, name: a.name };
  }
  return { payable, bankLedgers, problems };
}

/**
 * The company's mapping, re-validated NOW.
 * @returns {{ status: 'approved'|'not_configured'|'invalid', payable, bankLedgers, problems, approved_by, approved_at }}
 */
export async function getPaymentGlMapping(companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2 LIMIT 1`,
    [companyId ?? 0, PAYMENT_GL_SETTINGS_MODULE]);
  const s = rows[0]?.settings;
  if (!s || !s.approved_by || !s.approved_at) {
    return { status: 'not_configured', payable: null, bankLedgers: {}, problems: ['Finance has not approved payment account mappings for this company'], approved_by: null, approved_at: null };
  }
  const { payable, bankLedgers, problems } = await resolve(db, s, companyId);
  return { status: problems.length ? 'invalid' : 'approved', payable, bankLedgers, problems, approved_by: s.approved_by, approved_at: s.approved_at, note: s.note ?? null };
}

/**
 * The company's bank accounts' display links, in the caller's transaction:
 * each mapped account gets its approved ledger account; every other account of
 * the company is unlinked (it has no approved ledger, so no ledger balance).
 */
async function syncDisplayLinks(client, companyId, bankLedgers) {
  const ids = Object.keys(bankLedgers).map(Number);
  for (const [bankId, a] of Object.entries(bankLedgers)) {
    await client.query(
      `UPDATE bank_accounts SET chart_account_id = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3 AND chart_account_id IS DISTINCT FROM $1`, [a.id, Number(bankId), companyId]);
  }
  await client.query(
    `UPDATE bank_accounts SET chart_account_id = NULL, updated_at = NOW()
      WHERE company_id = $1 AND chart_account_id IS NOT NULL AND NOT (id = ANY($2::int[]))`, [companyId, ids]);
}

/**
 * Finance approves (or replaces) the mapping. Refuses anything that does not
 * validate. The mapping and the bank accounts' display links are written in ONE
 * transaction, the bank accounts locked while it is validated.
 */
export async function setPaymentGlMapping(companyId, body, userId) {
  if (companyId == null) throw new PaymentGlMappingError('A company is required', [], 400);
  if (userId == null) throw new PaymentGlMappingError('An identified approver is required', [], 403);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM bank_accounts WHERE company_id = $1 ORDER BY id FOR UPDATE`, [companyId]);
    const { payable, bankLedgers, problems } = await resolve(client, body || {}, companyId);
    if (problems.length) throw new PaymentGlMappingError('Payment account mapping refused', problems);
    const settings = {
      accounts_payable_account_code: payable.code,
      bank_ledgers: Object.fromEntries(Object.entries(bankLedgers).map(([id, a]) => [id, a.code])),
      note: body?.note ? String(body.note).slice(0, 500) : null,
      approved_by: userId, approved_at: new Date().toISOString(),
    };
    const { rows: before } = await client.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2 FOR UPDATE`, [companyId, PAYMENT_GL_SETTINGS_MODULE]);
    await client.query(
      `INSERT INTO company_settings (company_id, module, settings, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [companyId, PAYMENT_GL_SETTINGS_MODULE, JSON.stringify(settings)]);
    await syncDisplayLinks(client, companyId, bankLedgers);
    await client.query('COMMIT');
    return { before: before[0]?.settings ?? null, mapping: await getPaymentGlMapping(companyId) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Withdraw approval: payment batches can no longer be processed; display links are cleared with it. */
export async function clearPaymentGlMapping(companyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM company_settings WHERE company_id = $1 AND module = $2 RETURNING settings`, [companyId, PAYMENT_GL_SETTINGS_MODULE]);
    await syncDisplayLinks(client, companyId, {});
    await client.query('COMMIT');
    return rows[0]?.settings ?? null;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
