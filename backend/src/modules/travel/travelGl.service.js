/**
 * travelGl.service.js — posts travel money to the books (26 Nov 26).
 *
 * Paying a claim and disbursing an advance used to write NO journal entry: the
 * only writer of expense_claims.journal_entry_id was the retired Finance claims
 * path, so every paid claim sat in Travel Audit as "paid but never posted" and
 * the ledger showed none of the travel spend.
 *
 * Which accounts are used is a Finance decision, so — like the loan and payment
 * mappings — nothing is assumed: Finance approves a mapping once (Travel Desk →
 * Insights & Policy → Travel Audit), and until then paying a claim or disbursing
 * an advance is refused with TRAVEL_GL_MAPPING_REQUIRED.
 *
 *   advance disbursed   Dr Employee advances        Cr Bank / cash
 *   claim paid          Dr Travel expense (base, +GST unless verified)
 *                       Dr Input GST (verified GST only, when mapped)
 *                                                   Cr Employee advances (advance adjusted)
 *                                                   Cr Bank / cash (net paid)
 *   excess refunded     Dr Bank / cash              Cr Employee advances
 */
import pool from '../shared/db.js';
import journalRepo from '../finance/repositories/journal.repository.js';

export const TRAVEL_GL_SETTINGS_MODULE = 'travel_gl_mapping';

const ROLES = {
  travel_expense:     { field: 'travel_expense_account_code',     type: 'Expense', required: true,  label: 'Travel expense' },
  advance_receivable: { field: 'advance_receivable_account_code', type: 'Asset',   required: true,  label: 'Employee advances (receivable)' },
  payment:            { field: 'payment_account_code',            type: 'Asset',   required: true,  label: 'Paid from (bank / cash)' },
  gst_input:          { field: 'gst_input_account_code',          type: 'Asset',   required: false, label: 'Input GST (verified bills)' },
};

export class TravelGlError extends Error {
  constructor(message, problems = [], status = 422, code = 'TRAVEL_GL_MAPPING_INVALID') {
    super(message); this.problems = problems; this.status = status; this.code = code;
  }
}

async function accountByCode(db, code, companyId) {
  const { rows } = await db.query(
    `SELECT id, code, name, account_type, is_active FROM chart_of_accounts
      WHERE code = $1 AND deleted_at IS NULL AND (company_id = $2 OR company_id IS NULL)
      ORDER BY company_id DESC NULLS LAST LIMIT 1`, [String(code), companyId ?? null]);
  return rows[0] || null;
}

async function resolve(db, codes, companyId) {
  const accounts = {}, problems = [];
  for (const [role, spec] of Object.entries(ROLES)) {
    const code = codes?.[spec.field] == null ? '' : String(codes[spec.field]).trim();
    if (!code) { if (spec.required) problems.push(`${spec.label}: no account chosen`); continue; }
    const a = await accountByCode(db, code, companyId);
    if (!a) { problems.push(`${spec.label}: account ${code} does not exist`); continue; }
    if (!a.is_active) { problems.push(`${spec.label}: account ${code} (${a.name}) is inactive`); continue; }
    if (a.account_type !== spec.type) { problems.push(`${spec.label}: account ${code} (${a.name}) is ${a.account_type}, must be ${spec.type}`); continue; }
    accounts[role] = { id: a.id, code: a.code, name: a.name };
  }
  return { accounts, problems };
}

/** The company's mapping, re-validated now. */
export async function getTravelGlMapping(companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2 LIMIT 1`,
    [companyId ?? 0, TRAVEL_GL_SETTINGS_MODULE]);
  const s = rows[0]?.settings;
  if (!s || !s.approved_by) {
    return { status: 'not_configured', accounts: {}, codes: {}, problems: ['Finance has not chosen the travel ledger accounts yet'] };
  }
  const { accounts, problems } = await resolve(db, s, companyId);
  const codes = Object.fromEntries(Object.values(ROLES).map(r => [r.field, s[r.field] ?? null]));
  return { status: problems.length ? 'invalid' : 'approved', accounts, codes, problems, approved_by: s.approved_by, approved_at: s.approved_at };
}

export async function setTravelGlMapping(companyId, body, userId) {
  if (companyId == null) throw new TravelGlError('A company is required', [], 400);
  const { accounts, problems } = await resolve(pool, body || {}, companyId);
  if (problems.length) throw new TravelGlError('Travel account mapping refused', problems);
  const settings = {
    ...Object.fromEntries(Object.entries(ROLES).map(([role, r]) => [r.field, accounts[role]?.code ?? null])),
    approved_by: userId, approved_at: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [companyId, TRAVEL_GL_SETTINGS_MODULE, JSON.stringify(settings)]);
  return getTravelGlMapping(companyId);
}

async function requireMapping(client, companyId) {
  const m = await getTravelGlMapping(companyId, client);
  if (m.status !== 'approved') {
    throw new TravelGlError(
      'Finance must choose the travel ledger accounts first (Travel Desk → Insights & Policy → Travel Audit).',
      m.problems, 422, 'TRAVEL_GL_MAPPING_REQUIRED');
  }
  return m.accounts;
}

async function postEntry(client, { companyId, date, type, refType, refId, description, userId, lines }) {
  const live = lines.filter(l => Number(l.debit || 0) > 0 || Number(l.credit || 0) > 0);
  const entry = await journalRepo.createEntry(client, {
    entry_number: await journalRepo.getNextEntryNumber(client),
    entry_date: date, entry_type: type, reference_type: refType, reference_id: String(refId),
    description, created_by: userId, company_id: companyId,
  });
  for (const l of live) {
    await journalRepo.createLine(client, {
      journal_entry_id: entry.id, account_id: l.account.id, description: l.narration || description,
      debit: Math.round(Number(l.debit || 0) * 100) / 100, credit: Math.round(Number(l.credit || 0) * 100) / 100,
      project_id: l.project_id ?? null, company_id: companyId,
    });
  }
  await journalRepo.postEntry(client, entry.id);
  return entry;
}

/** Dr Employee advances / Cr Bank. Returns the journal entry. */
export async function postAdvanceDisbursement(client, adv, { date, userId, label }) {
  const a = await requireMapping(client, adv.company_id);
  const amt = Number(adv.amount);
  return postEntry(client, {
    companyId: adv.company_id, date, type: 'Travel Advance', refType: 'travel_advance', refId: adv.id,
    description: `Travel advance ${label || '#' + adv.id} paid`, userId,
    lines: [
      { account: a.advance_receivable, debit: amt },
      { account: a.payment, credit: amt },
    ],
  });
}

/** Dr Bank / Cr Employee advances — the employee returned unspent advance. */
export async function postAdvanceRefund(client, adv, { amount, date, userId, label }) {
  const a = await requireMapping(client, adv.company_id);
  return postEntry(client, {
    companyId: adv.company_id, date, type: 'Travel Advance', refType: 'travel_advance', refId: adv.id,
    description: `Unspent travel advance ${label || '#' + adv.id} returned`, userId,
    lines: [
      { account: a.payment, debit: amount },
      { account: a.advance_receivable, credit: amount },
    ],
  });
}

/** The claim payment entry. `advanceAdjusted` + `netPayable` must equal the claim total. */
export async function postClaimPayment(client, claim, { date, userId, advanceAdjusted, netPayable }) {
  const a = await requireMapping(client, claim.company_id);
  const base = Number(claim.amount || 0);
  const gst = Number(claim.gst_amount || 0);
  // GST is input credit only when Accounts verified the bill AND Finance mapped
  // an input-GST account; otherwise it is part of the travel cost.
  const gstToInput = gst > 0 && claim.gst_verified && a.gst_input ? gst : 0;
  const expense = base + gst - gstToInput;
  return postEntry(client, {
    companyId: claim.company_id, date, type: 'Expense Claim', refType: 'expense_claim', refId: claim.id,
    description: `Expense claim ${claim.claim_number} — ${claim.employee_name || ''}`.trim(), userId,
    lines: [
      { account: a.travel_expense, debit: expense, project_id: claim.project_id },
      { account: a.gst_input, debit: gstToInput },
      { account: a.advance_receivable, credit: advanceAdjusted },
      { account: a.payment, credit: netPayable },
    ],
  });
}
