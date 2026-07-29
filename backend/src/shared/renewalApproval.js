// renewalApproval.js — Renewal Engine (Priority 5) shared approval gate.
//
// AMC contracts and Subscriptions both had a "renew" action that was really
// just a status flip / date-and-value overwrite with no approval step at
// all — anyone reaching the endpoint could set any renewal value. Mirrors
// the simple single-threshold approach used elsewhere in this pass (Exit/
// Travel), not procurement's full multi-tier value-band system — a renewal
// isn't a multi-approver purchase chain, just needs a finance/admin sign-off
// above a threshold.
import { hasRole } from '../middlewares/auth.middleware.js';

export const RENEWAL_APPROVAL_ROLES = ['admin', 'super_admin', 'finance', 'finance_manager'];
export const RENEWAL_APPROVAL_THRESHOLD = parseInt(process.env.RENEWAL_APPROVAL_THRESHOLD || '200000', 10);

export function requiresRenewalApproval(value) {
  return parseFloat(value || 0) > RENEWAL_APPROVAL_THRESHOLD;
}

export function isAuthorizedRenewalApprover(req) {
  return hasRole(req, ...RENEWAL_APPROVAL_ROLES);
}
