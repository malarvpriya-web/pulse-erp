import express from 'express';
import { Vendor360Controller as ctrl } from '../controllers/vendor360.controller.js';
import { requireProcurement } from '../procurement.authz.js';
/**
 * AUTHORIZATION. This router was mounted behind `verifyToken` and NOTHING else,
 * so every route below was reachable by any authenticated account regardless of
 * role — including the writes. `requireProcurement(action, ...alsoAllowRoles)`
 * ORs the role_permissions matrix with named roles, which is how the rest of the
 * module is gated; the named roles are the documented exceptions, not a bypass.
 */

const router = express.Router();

// ── Static routes FIRST (before /:vendorId) ───────────────────────────────────
// GET /vendor-360
router.get('/',                        requireProcurement('view'), ctrl.listVendors);

// GET /vendor-360/command-center  ← MUST be before /:vendorId
router.get('/command-center',          requireProcurement('view'), ctrl.commandCenter);

// ── Per-vendor routes ─────────────────────────────────────────────────────────
// GET /vendor-360/:vendorId  (full 360 — all tabs in one call)
router.get('/:vendorId',               requireProcurement('view'), ctrl.getFull360);

// Lightweight sub-views (lazy-loaded on tab click)
router.get('/:vendorId/timeline',      requireProcurement('view'), ctrl.getTimeline);
router.get('/:vendorId/scorecard',     requireProcurement('view', 'qc_manager', 'qc_engineer'), ctrl.getScorecard);
router.post('/:vendorId/scorecard',    requireProcurement('edit', 'qc_manager'), ctrl.saveScorecard);
router.get('/:vendorId/risk',          requireProcurement('view', 'qc_manager'), ctrl.getRisk);
router.get('/:vendorId/documents',     requireProcurement('view', 'finance', 'finance_manager', 'qc_manager'), ctrl.getDocuments);
// Line-level "what we buy from this vendor, when, at what price"
router.get('/:vendorId/purchase-lines', requireProcurement('view'), ctrl.getPurchaseLines);

export default router;
