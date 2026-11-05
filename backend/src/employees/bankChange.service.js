// bankChange.service.js — bank-detail maker-checker, Phase 1 (§204).
//
// New or changed bank details never land on the employees row directly. The
// HR user who enters them (the MAKER) creates a pending request; a DIFFERENT
// HR user (the CHECKER) approves or rejects it. Only an approval writes the
// employees row, stamps bank_verified_at / bank_verified_by, and notifies
// Accounts. Existing details are untouched and stay unverified (NULL stamp).
//
//   propose   employee_bank:add (propose only — sees no stored numbers, and
//             lists only its OWN requests) or employee_bank:edit
//   verify    same as propose: ask for the details already on record to be
//             checked as they are (source 'verify', §206)
//   review    employee_bank:edit, same company, never one's own proposal
//   withdraw  the maker, or employee_bank:edit
//   full numbers in the queue: employee_bank:view; masked otherwise
import pool from '../config/db.js';
import { validateStatutoryProfile } from '../modules/payroll/payrollEligibility.js';

export const BANK_KEYS = ['account_number', 'ifsc_code', 'bank_name', 'branch_name'];

export class BankChangeError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const mask = (v) => (v ? `XXXX${String(v).slice(-4)}` : null);

/** Account number / IFSC errors for a full proposed set (the payroll rule). */
export function proposalErrors(p) {
  return validateStatutoryProfile({ account_number: p.account_number, ifsc_code: p.ifsc_code }, {})
    .filter(i => i.severity === 'error' && ['account_number', 'ifsc_code'].includes(i.field))
    .map(i => i.message);
}

/** The pending request for an employee, or null. */
export async function pendingFor(employeeId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, requested_by, requested_at FROM employee_bank_change_requests WHERE employee_id = $1 AND status = 'pending'`,
    [employeeId]);
  return rows[0] || null;
}

/**
 * Record a proposal. `current` is the employee's stored bank block ({} for a
 * new employee); `changes` the submitted keys that differ. The full proposed
 * set (current overlaid with changes) is stored, so an approval is coherent.
 */
export async function propose({ employeeId, companyId, current = {}, changes, requestedBy, source = 'edit' }) {
  const proposed = Object.fromEntries(BANK_KEYS.map(k => [k, k in changes ? (changes[k] || null) : (current[k] || null)]));
  const errs = proposalErrors(proposed);
  if (errs.length) throw new BankChangeError(400, errs.join('; '), 'BANK_DETAILS_INVALID');
  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO employee_bank_change_requests
         (employee_id, company_id, proposed_account_number, proposed_ifsc_code, proposed_bank_name, proposed_branch_name,
          fields_changed, source, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status, requested_at`,
      [employeeId, companyId, proposed.account_number, proposed.ifsc_code, proposed.bank_name, proposed.branch_name,
       Object.keys(changes), source, requestedBy]);
    return r;
  } catch (e) {
    if (e.code === '23505') throw new BankChangeError(409, 'A bank-detail change for this employee is already awaiting approval. Approve, reject or withdraw it first.', 'BANK_CHANGE_PENDING');
    throw e;
  }
}

/**
 * "Verify as-is" (§206): ask a second HR person to check the details already
 * on record, without re-typing them. Refused when there is nothing valid to
 * verify, when they are already verified, or when a request is pending.
 */
export async function requestVerification({ employeeId, companyId, requestedBy }) {
  const { rows: [emp] } = await pool.query(
    `SELECT id, account_number, ifsc_code, bank_name, branch_name, bank_verified_at
       FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [employeeId, companyId]);
  if (!emp) throw new BankChangeError(404, 'Employee not found');
  if (!String(emp.account_number || '').trim() || !String(emp.ifsc_code || '').trim()) {
    throw new BankChangeError(400, 'There are no bank details on record to verify — enter them on Edit Employee instead.', 'NOTHING_TO_VERIFY');
  }
  const errs = proposalErrors(emp);
  if (errs.length) {
    throw new BankChangeError(400, `The details on record cannot be verified as they are: ${errs.join('; ')}. Correct them on Edit Employee instead.`, 'BANK_DETAILS_INVALID');
  }
  if (emp.bank_verified_at) throw new BankChangeError(409, 'These bank details are already verified.', 'ALREADY_VERIFIED');
  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO employee_bank_change_requests
         (employee_id, company_id, proposed_account_number, proposed_ifsc_code, proposed_bank_name, proposed_branch_name,
          fields_changed, source, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,'{}','verify',$7) RETURNING id, status, source, requested_at`,
      [emp.id, companyId, emp.account_number, emp.ifsc_code, emp.bank_name, emp.branch_name, requestedBy]);
    return r;
  } catch (e) {
    if (e.code === '23505') throw new BankChangeError(409, 'A bank-detail request for this employee is already awaiting approval.', 'BANK_CHANGE_PENDING');
    throw e;
  }
}

/** The company's requests (default pending), newest first. */
export async function list({ companyId, status = 'pending', showFull = false, onlyRequestedBy = null }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.employee_id, r.status, r.source, r.fields_changed, r.requested_at, r.decided_at, r.decision_reason,
            r.requested_by, r.decided_by,
            r.proposed_account_number, r.proposed_ifsc_code, r.proposed_bank_name, r.proposed_branch_name,
            e.account_number AS current_account_number, e.ifsc_code AS current_ifsc_code,
            e.bank_name AS current_bank_name, e.branch_name AS current_branch_name, e.bank_verified_at,
            e.office_id AS employee_code,
            COALESCE(NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), ''), e.name) AS employee_name,
            COALESCE(ru.name, ru.email) AS requested_by_name, COALESCE(du.name, du.email) AS decided_by_name
       FROM employee_bank_change_requests r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN users ru ON ru.id = r.requested_by
       LEFT JOIN users du ON du.id = r.decided_by
      WHERE r.company_id = $1 AND ($2::text = 'all' OR r.status = $2)
        AND ($3::int IS NULL OR r.requested_by = $3)
      ORDER BY r.requested_at DESC, r.id DESC LIMIT 500`,
    [companyId, status, onlyRequestedBy]);
  return showFull ? rows : rows.map(r => ({
    ...r,
    proposed_account_number: mask(r.proposed_account_number),
    current_account_number: mask(r.current_account_number),
  }));
}

async function lockPending(client, id, companyId) {
  const { rows: [r] } = await client.query(
    `SELECT * FROM employee_bank_change_requests WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId]);
  if (!r) throw new BankChangeError(404, 'Request not found');
  if (r.status !== 'pending') throw new BankChangeError(409, `This request is already ${r.status}`, 'BANK_CHANGE_DECIDED');
  return r;
}

/** Approve: a different reviewer; writes the employees row in the same transaction. */
export async function approve({ id, companyId, reviewerUserId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await lockPending(client, id, companyId);
    if (r.requested_by != null && Number(r.requested_by) === Number(reviewerUserId)) {
      throw new BankChangeError(403, 'A bank-detail change must be approved by a different HR person than the one who entered it.', 'SAME_PERSON');
    }
    const errs = proposalErrors({ account_number: r.proposed_account_number, ifsc_code: r.proposed_ifsc_code });
    if (errs.length) throw new BankChangeError(409, `The proposed details are no longer valid: ${errs.join('; ')}`, 'BANK_DETAILS_INVALID');
    if (r.source === 'verify') {
      // Stamp ONLY if the record still holds exactly the details the request
      // was made for — nothing is rewritten. A change in between means the
      // reviewer would be approving something they were not shown.
      const { rows: [emp] } = await client.query(
        `UPDATE employees SET bank_verified_at = NOW(), bank_verified_by = $1
          WHERE id = $2 AND company_id = $3 AND deleted_at IS NULL
            AND account_number IS NOT DISTINCT FROM $4 AND ifsc_code IS NOT DISTINCT FROM $5
            AND bank_name IS NOT DISTINCT FROM $6 AND branch_name IS NOT DISTINCT FROM $7
          RETURNING id, company_id, first_name, last_name, office_id`,
        [reviewerUserId, r.employee_id, companyId, r.proposed_account_number, r.proposed_ifsc_code, r.proposed_bank_name, r.proposed_branch_name]);
      if (!emp) throw new BankChangeError(409, 'The bank details on record changed after verification was requested. Withdraw this request and ask again.', 'DETAILS_CHANGED');
      await client.query(
        `UPDATE employee_bank_change_requests SET status = 'approved', decided_by = $1, decided_at = NOW() WHERE id = $2`,
        [reviewerUserId, r.id]);
      await client.query('COMMIT');
      return { request: { ...r, status: 'approved' }, employee: emp };
    }
    const { rows: [emp] } = await client.query(
      `UPDATE employees SET account_number = $1, ifsc_code = $2, bank_name = $3, branch_name = $4,
              bank_verified_at = NOW(), bank_verified_by = $5
        WHERE id = $6 AND company_id = $7 AND deleted_at IS NULL
        RETURNING id, company_id, first_name, last_name, office_id`,
      [r.proposed_account_number, r.proposed_ifsc_code, r.proposed_bank_name, r.proposed_branch_name,
       reviewerUserId, r.employee_id, companyId]);
    if (!emp) throw new BankChangeError(404, 'Employee not found');
    await client.query(
      `UPDATE employee_bank_change_requests SET status = 'approved', decided_by = $1, decided_at = NOW() WHERE id = $2`,
      [reviewerUserId, r.id]);
    await client.query('COMMIT');
    return { request: { ...r, status: 'approved' }, employee: emp };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** Reject (reviewer, reason required) or withdraw (maker or reviewer). Nothing on the employee changes. */
export async function close({ id, companyId, userId, status, reason, isReviewer }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await lockPending(client, id, companyId);
    const isMaker = r.requested_by != null && Number(r.requested_by) === Number(userId);
    if (status === 'rejected') {
      if (!isReviewer) throw new BankChangeError(403, 'Rejecting needs the HR bank-details permission');
      if (isMaker) throw new BankChangeError(403, 'A different HR person reviews this change — withdraw it instead.', 'SAME_PERSON');
      if (!String(reason || '').trim()) throw new BankChangeError(400, 'A reason is required to reject a bank-detail change');
    } else if (!isMaker && !isReviewer) {
      throw new BankChangeError(403, 'Only the person who entered the change, or an HR reviewer, can withdraw it');
    }
    await client.query(
      `UPDATE employee_bank_change_requests SET status = $1, decided_by = $2, decided_at = NOW(), decision_reason = $3 WHERE id = $4`,
      [status, userId, reason ? String(reason).trim() : null, r.id]);
    await client.query('COMMIT');
    return { ...r, status };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
