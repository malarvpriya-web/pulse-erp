/**
 * Authorization for the Approval Center.
 *
 * Background: every route in approvals.routes.js was gated by verifyToken alone.
 * An account holding only the `employee` role could approve any pending item in
 * the system — including its own overtime and salary increment — because the
 * Approval Center is the generic backend for purchase requests, leave, expenses,
 * regularizations and increments. Confirmed by live probe 2026-07-19; see
 * SECURITY_AUDIT_2026-07-18.md H-2.
 *
 * The model here is not invented: getPendingApprovals already filters the read
 * path to `approver_id IS NULL OR approver_id = :me`. The UI therefore only ever
 * shows you your own queue. This module enforces on the WRITE path the same rule
 * the READ path already assumes — so it should be close to a no-op for anyone
 * using the product as designed, and a hard stop for anyone calling the API
 * directly.
 *
 * Delegation needs no special case: delegateApprovals reassigns approver_id, so
 * a delegate passes the ownership check by virtue of now owning the row.
 */
import pool from '../../config/db.js';
import { rolesOf } from '../../middlewares/auth.middleware.js';

/**
 * Roles that may act on an approval they do not personally own.
 *
 * ── PROPOSED MATRIX — REVIEW BEFORE EXTENDING TO OTHER MODULES ──────────────
 * Deliberately conservative: every role here already carries approval authority
 * somewhere in the product. If a role is missing, its holders can still act on
 * anything explicitly assigned to them — they just cannot reach into the
 * unassigned pool. That is the safe direction to be wrong in: a missing role
 * produces a 403 someone reports, whereas an extra role produces a silent
 * privilege escalation nobody notices.
 *
 * Explicitly NOT included: `employee`, `hr_exec`, `accounts_exec`,
 * `procurement_exec`, `sales_exec`, `store_keeper`, and the engineer grades.
 * Executor roles submit for approval; they do not grant it.
 */
export const APPROVER_ROLES = [
  'super_admin', 'admin',
  'manager', 'department_head',
  'hr', 'hr_manager', 'payroll_admin',
  // `finance` was added to the roles table after the older `finance_manager`
  // and is the one actually provisioned to finance staff. Omitting it meant a
  // real finance user could approve nothing while `finance_manager` — assigned
  // to nobody — could approve everything.
  'finance', 'finance_manager',
  'procurement_manager',
  'production_manager',
  'qc_manager',
  'project_manager',
  'sales_manager',
  'service_manager',
];

/** Roles that may override another user's assigned approval. Audited. */
export const OVERRIDE_ROLES = ['super_admin', 'admin'];

const has = (req, list) => rolesOf(req).some(r => list.includes(r));

export const isApproverRole = (req) => has(req, APPROVER_ROLES);
export const canOverride    = (req) => has(req, OVERRIDE_ROLES);

const deny = (res, message) => res.status(403).json({
  error: 'Forbidden',
  code:  'APPROVAL_NOT_YOURS',
  message,
});

/**
 * Guard for routes carrying a single `:id`.
 *
 * `:id` has two shapes, and they need different checks:
 *
 *   "123"            → a row in the central `approvals` table. Ownership is
 *                      knowable, so enforce it: you must be the designated
 *                      approver, or hold an override role.
 *
 *   "leave:456"      → a "source" pseudo-id addressing the underlying record
 *                      directly, with no approvals row to own. Ownership cannot
 *                      be checked, so fall back to requiring an approver role.
 *                      This path writes straight to leave_applications /
 *                      attendance_regularization_requests / etc., so it is the
 *                      more dangerous of the two and gets the blunter gate.
 */
export const canActOnApproval = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = req.user.userId ?? req.user.id ?? null;
  const id     = String(req.params.id ?? '');

  // Source pseudo-id — no ownership record exists to check against.
  if (id.includes(':')) {
    if (!isApproverRole(req)) {
      return deny(res, 'Your role cannot approve or reject requests.');
    }
    return next();
  }

  if (canOverride(req)) return next();

  try {
    const { rows } = await pool.query(
      'SELECT approver_id, requested_by FROM approvals WHERE id = $1 LIMIT 1',
      [id]
    );

    // Unknown id. Falling straight through would let a non-approver past this
    // guard for any id that happens not to exist, leaving the controller as the
    // only thing standing between them and a write — safety by coincidence.
    // Requiring an approver role instead is stricter AND leaks less: a
    // non-approver now gets an identical 403 whether the id exists or not, while
    // an approver still falls through to the controller's own 404/409.
    if (!rows.length) {
      if (!isApproverRole(req)) {
        return deny(res, 'Your role cannot approve or reject requests.');
      }
      return next();
    }

    // ── Self-approval ────────────────────────────────────────────────────────
    // ⚠ CURRENTLY INERT — NOT PROTECTION. `approvals.requested_by` is written by
    // nothing in this codebase (all 20 rows are NULL; only the free-text
    // `requester_name` is set), so this branch can never fire today. It is here
    // so the rule takes effect the moment the column is populated, NOT because
    // self-approval is currently prevented.
    //
    // Until then a user who is both requester and designated approver can
    // approve their own request — including salary increments routed to
    // payroll_admin. Treat self-approval as UNMITIGATED and do not claim
    // segregation of duties in any compliance document. Fixing this means
    // populating requested_by at every INSERT INTO approvals, which also repairs
    // the audit trail: right now you cannot tell WHO raised a request, only a
    // display name that no foreign key backs.
    if (rows[0].requested_by != null && String(rows[0].requested_by) === String(userId)) {
      return deny(res, 'You cannot approve your own request.');
    }

    const assigned = rows[0].approver_id;

    // Unassigned rows sit in a shared pool that the read path shows to everyone.
    // Anyone with an approver role may claim one; an employee may not.
    if (assigned == null) {
      if (!isApproverRole(req)) {
        return deny(res, 'Your role cannot approve or reject requests.');
      }
      return next();
    }

    if (String(assigned) !== String(userId)) {
      return deny(res, 'This request is assigned to a different approver.');
    }
    return next();
  } catch (err) {
    // Fail CLOSED. This guard protects financial and payroll approvals; a DB
    // blip must not turn into an open door. Contrast verifyToken, which fails
    // open by design to keep the app reachable — that trade is not appropriate
    // here, where the blast radius is an approved purchase order.
    console.error('[approvals.authz]', err.message);
    return res.status(503).json({ error: 'Authorization check unavailable. Please retry.' });
  }
};

/**
 * Guard for the bulk and delegation routes, which take `ids` in the body.
 *
 * Per-row ownership is enforced inside the controller loop (each id is checked
 * as it is processed); this is the coarse gate that keeps non-approver roles out
 * of the endpoint entirely. bulk-approve had no `:id` in its path, so the
 * privileged-route scan missed it — it is the highest-leverage route in the
 * file, approving an arbitrary list in one call.
 */
export const requireApproverRole = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isApproverRole(req)) {
    return deny(res, 'Your role cannot approve, reject, or delegate requests.');
  }
  next();
};
