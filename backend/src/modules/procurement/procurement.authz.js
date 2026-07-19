/**
 * Value-threshold authorization for procurement.
 *
 * Unlike approvals (ownership-based) and attendance (role-tier), procurement
 * authority is a function of AMOUNT: who may approve depends on what the PR/PO
 * is worth, against the limits in `procurement_settings`.
 *
 * That model already existed in procurement.routes.js as `requiredApprovalLevel`
 * + `canApprove` and was correctly wired into PR and PO approve. This module
 * fixes three defects in it and extends it to the routes it never covered.
 *
 * ── Defect 1: primary-role-only ──────────────────────────────────────────────
 * `canApprove` took `req.user?.role` — the primary role. Roles are many-to-many,
 * so a user provisioned as `employee` + `procurement_manager` was evaluated as
 * `employee` (level 0) and could approve nothing. Now the caller's level is the
 * MAXIMUM across every role held, which is the only sensible reading: holding an
 * additional role must never reduce authority.
 *
 * ── Defect 2: half the role table did not exist ──────────────────────────────
 * The old `roleLevel` map keyed on `senior_manager`, `cfo` and `finance_head` —
 * none of which are rows in `roles`. Every level-3 entry except admin/super_admin
 * was therefore unreachable, so only administrators could clear a high-value PO,
 * while the roles actually provisioned to finance staff (`finance`,
 * `finance_manager`) were absent entirely and scored 0.
 *
 * ── Defect 3: `cfo_approval_above` was ignored ───────────────────────────────
 * `requiredApprovalLevel` returned 'cfo' for anything above `l2_approval_limit`
 * (₹100k), so the configured `cfo_approval_above` (₹500k) never applied. A
 * ₹150k PO demanded CFO-level authority despite the setting saying otherwise.
 * The band between l2 and cfo_approval_above is now its own 'l3' tier.
 */
import { rolesOf } from '../../middlewares/auth.middleware.js';

/** Numeric authority per role. Higher clears everything below it. */
export const ROLE_LEVEL = {
  // L1 — routine spend
  manager:             1,
  department_head:     1,
  procurement_exec:    1,
  store_keeper:        1,
  // L2 — departmental buying authority
  procurement_manager: 2,
  project_manager:     2,
  production_manager:  2,
  // L3 — finance sign-off
  finance:             3,
  finance_manager:     3,
  // L4 — unlimited
  admin:               4,
  super_admin:         4,
};

/** Amount band → minimum level required. */
const BAND_LEVEL = { auto: 0, l1: 1, l2: 2, l3: 3, cfo: 4 };

/** The caller's authority: the highest level among ALL roles held. */
export const approvalLevelOf = (req) =>
  rolesOf(req).reduce((max, r) => Math.max(max, ROLE_LEVEL[r] ?? 0), 0);

/**
 * Which band does this amount fall into?
 * Reads the same settings columns as before, plus `cfo_approval_above`.
 */
export function requiredBand(amount, s) {
  const n = parseFloat(amount || 0);
  if (n <= parseFloat(s.auto_approve_below  ?? 0))      return 'auto';
  if (n <= parseFloat(s.l1_approval_limit   ?? 25000))  return 'l1';
  if (n <= parseFloat(s.l2_approval_limit   ?? 100000)) return 'l2';
  if (n <= parseFloat(s.cfo_approval_above  ?? 500000)) return 'l3';
  return 'cfo';
}

/**
 * @returns {null|{status:number,body:object}} null when permitted.
 *
 * `action` only shapes the message — reject and cancel require the SAME
 * authority as approving would. Rejecting a ₹5 lakh PR or cancelling a live PO
 * is a commercial decision of the same weight as approving it, and leaving
 * those open was how the previous version could be sidestepped: an employee who
 * could not approve a PO could still cancel it.
 */
export function assertCanDecideAmount(req, amount, settings, action = 'approve') {
  if (!req.user) return { status: 401, body: { error: 'Unauthorized' } };

  const band = requiredBand(amount, settings);
  if (band === 'auto') return null;

  const held = approvalLevelOf(req);
  if (held >= BAND_LEVEL[band]) return null;

  const amt = Number(amount || 0).toLocaleString('en-IN');
  return { status: 403, body: {
    error: 'Forbidden',
    code:  'APPROVAL_LEVEL_INSUFFICIENT',
    required_level: band,
    message: `This ₹${amt} item requires ${band.toUpperCase()} authority to ${action}. Your roles do not carry it.`,
  } };
}
