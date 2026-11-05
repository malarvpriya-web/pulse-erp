/**
 * loanGlMapping.service.js — the GL accounts used for employee loans and
 * salary advances, per company, set ONLY by Finance.
 *
 * Payroll recovers loan installments; approval splits each one into principal
 * (reduces what the employee owes — a receivable) and interest (income). Which
 * accounts those are is a Finance decision, so nothing is assumed: until a
 * user with finance:approve has saved a mapping here, payroll approval refuses
 * any batch that recovers a loan (payroll.service.js approvePayroll,
 * LOAN_GL_MAPPING_REQUIRED) and the payroll journal never posts a loan line.
 * PAYROLL_DATA_FLOW_AUDIT.md Part 14.
 *
 * Stored in company_settings under its own module key. The generic
 * POST /settings/:module writer refuses this key (settings-status.routes.js),
 * so the approval stamp below can only come from setLoanGlMapping().
 */
import pool from '../db.js';

export const LOAN_GL_SETTINGS_MODULE = 'loan_gl_mapping';

// role → required account_type. `disbursement` is where a loan is paid FROM;
// it is stored for the disbursement posting (not built yet) and optional.
const ROLES = {
  receivable:      { field: 'receivable_account_code',      type: 'Asset',   required: true,  label: 'Loan / advance receivable' },
  interest_income: { field: 'interest_income_account_code', type: 'Revenue', required: true,  label: 'Interest income on employee loans' },
  disbursement:    { field: 'disbursement_account_code',    type: 'Asset',   required: false, label: 'Disbursement (bank / cash)' },
};

export class LoanGlMappingError extends Error {
  constructor(message, problems = [], status = 422) { super(message); this.problems = problems; this.status = status; this.code = 'LOAN_GL_MAPPING_INVALID'; }
}

async function accountByCode(db, code, companyId) {
  const { rows } = await db.query(
    `SELECT id, code, name, account_type, is_active FROM chart_of_accounts
      WHERE code = $1 AND deleted_at IS NULL AND (company_id = $2 OR company_id IS NULL)
      ORDER BY company_id DESC NULLS LAST LIMIT 1`, [String(code), companyId ?? null]);
  return rows[0] || null;
}

/** Validate codes against the chart of accounts. Returns { accounts, problems }. */
async function resolve(db, codes, companyId) {
  const accounts = {}, problems = [];
  for (const [role, spec] of Object.entries(ROLES)) {
    const code = codes[spec.field] == null ? '' : String(codes[spec.field]).trim();
    if (!code) { if (spec.required) problems.push(`${spec.label}: no account mapped`); continue; }
    const a = await accountByCode(db, code, companyId);
    if (!a) { problems.push(`${spec.label}: account ${code} does not exist`); continue; }
    if (!a.is_active) { problems.push(`${spec.label}: account ${code} (${a.name}) is inactive`); continue; }
    if (a.account_type !== spec.type) { problems.push(`${spec.label}: account ${code} (${a.name}) is ${a.account_type}, must be ${spec.type}`); continue; }
    accounts[role] = { id: a.id, code: a.code, name: a.name };
  }
  return { accounts, problems };
}

/**
 * The company's mapping, re-validated against the chart of accounts NOW (an
 * account may have been deactivated since Finance approved it).
 * @returns {{ status: 'approved'|'not_configured'|'invalid', accounts, problems, approved_by, approved_at, note }}
 */
export async function getLoanGlMapping(companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2 LIMIT 1`,
    [companyId ?? 0, LOAN_GL_SETTINGS_MODULE]);
  const s = rows[0]?.settings;
  if (!s || !s.approved_by || !s.approved_at) {
    return { status: 'not_configured', accounts: {}, problems: ['Finance has not approved loan account mappings for this company'], approved_by: null, approved_at: null, note: null };
  }
  const { accounts, problems } = await resolve(db, s, companyId);
  return { status: problems.length ? 'invalid' : 'approved', accounts, problems, approved_by: s.approved_by, approved_at: s.approved_at, note: s.note ?? null };
}

/** Finance approves (or replaces) the mapping. Refuses anything that does not validate. */
export async function setLoanGlMapping(companyId, body, userId) {
  if (companyId == null) throw new LoanGlMappingError('A company is required', [], 400);
  if (userId == null) throw new LoanGlMappingError('An identified approver is required', [], 403);
  const { accounts, problems } = await resolve(pool, body || {}, companyId);
  if (problems.length) throw new LoanGlMappingError('Loan account mapping refused', problems);
  const settings = {
    receivable_account_code: accounts.receivable.code,
    interest_income_account_code: accounts.interest_income.code,
    disbursement_account_code: accounts.disbursement?.code ?? null,
    note: body?.note ? String(body.note).slice(0, 500) : null,
    approved_by: userId, approved_at: new Date().toISOString(),
  };
  const { rows: before } = await pool.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2`, [companyId, LOAN_GL_SETTINGS_MODULE]);
  await pool.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [companyId, LOAN_GL_SETTINGS_MODULE, JSON.stringify(settings)]);
  return { before: before[0]?.settings ?? null, mapping: await getLoanGlMapping(companyId) };
}

/** Withdraw approval: loan batches are blocked again. */
export async function clearLoanGlMapping(companyId) {
  const { rows } = await pool.query(
    `DELETE FROM company_settings WHERE company_id = $1 AND module = $2 RETURNING settings`, [companyId, LOAN_GL_SETTINGS_MODULE]);
  return rows[0]?.settings ?? null;
}
